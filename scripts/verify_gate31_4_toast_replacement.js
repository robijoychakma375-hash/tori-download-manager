#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 31.4
 * Replace Legacy Download Toast with IDM Progress Window — Real Acceptance Suite
 *
 * Strictly isolated under target/gate31_4_qa with custom TORI_DATA_DIR, TORI_IPC_PIPE,
 * WEBVIEW2_USER_DATA_FOLDER, and dedicated ports (24988..24995).
 * Snapshots & restores HKCU Uninstall, HKCU\Software\tori\TORI Download Manager,
 * NativeMessagingHosts, Desktop/StartMenu shortcuts, and idle OEM Desktop.
 * Never modifies %APPDATA%\tori-download-manager\tdm_storage.sqlite or public v1.0.5 artifacts.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TAURI_CONF = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const TARGET_VER = process.env.TORI_QA_VERSION || TAURI_CONF.version || '1.0.6';
const RC_DIR = process.env.TORI_QA_RC_DIR || path.join(ROOT, 'release', `v${TARGET_VER}-rc`);
const INSTALLER_EXE = path.join(RC_DIR, `TORI Download Manager_${TARGET_VER}_x64-setup.exe`);
const INSTALLER_SIG = path.join(RC_DIR, `TORI Download Manager_${TARGET_VER}_x64-setup.exe.sig`);
const FFPROBE_EXE = path.join(ROOT, 'resources', 'bin', 'ffprobe.exe');

const OEM_DESKTOP_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'tori-download-manager.exe');
const OEM_HOST_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'bin', 'tdm-native-host.exe');
const OEM_APPDATA_DIR = path.join(process.env.APPDATA || '', 'tori-download-manager');
const OEM_DB_PATH = path.join(OEM_APPDATA_DIR, 'tdm_storage.sqlite');
const OEM_NM_CHR = path.join(OEM_APPDATA_DIR, 'com.tori.download_manager.json');
const OEM_NM_FF = path.join(OEM_APPDATA_DIR, 'com.tori.download_manager.firefox.json');

const QA_ROOT = path.join(ROOT, 'target', 'gate31_4_qa');
const QA_BACKUP_DIR = path.join(QA_ROOT, 'oem_backup');
const QA_INST_DIR = path.join(QA_ROOT, 'desktop_install');
const QA_BEFORE_DATA = path.join(QA_ROOT, 'before_v104_data');
const QA_BEFORE_DL = path.join(QA_ROOT, 'before_v104_downloads');
const QA_BEFORE_WV2 = path.join(QA_ROOT, 'before_v104_wv2');
const QA_DATA_DIR = path.join(QA_ROOT, 'data');
const QA_DL_DIR = path.join(QA_ROOT, 'downloads');
const QA_WV2_DIR = path.join(QA_ROOT, 'webview2');
const SCREENSHOTS_DIR = path.join(ROOT, 'docs', 'reports', 'screenshots', 'gate31_4');

const BEFORE_PORT = 24988;
const BEFORE_CDP_PORT = 24989;
const GUI_PORT = 24990;
const CDP_PORT = 24991;
const FIXTURE_PORT = 24995;
const API_TOKEN = 'tori_qa_gate31_4_token';

const YT_TEST_URL = 'https://www.youtube.com/watch?v=u9lj-c29dxI';

const results = [];
const counts = { PASS: 0, FAIL: 0 };
const trackedProcs = new Set();
let oemWasRunning = false;
let hkcuUninstallExisted = false;
let hkcuManuExisted = false;
let savedNmChr = null;
let savedNmFf = null;
let savedRegNmChr = null;
let savedRegNmEdge = null;
let savedRegNmFf = null;

function record(id, name, ok, detail = '') {
  const status = ok ? 'PASS' : 'FAIL';
  counts[status]++;
  console.log(`[${status}] [${id}] ${name}${detail ? ' -> ' + detail : ''}`);
  results.push({ id, name, status, detail });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function makePatternBuffer(size, magicHex) {
  const b = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    b[i] = ((i * 67 + (i >> 4) * 29) ^ 0x5a) & 0xff;
  }
  if (magicHex) Buffer.from(magicHex, 'hex').copy(b, 0);
  return b;
}

function killProcTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
  } catch {}
}

function cleanupProcs() {
  for (const p of trackedProcs) {
    if (p && p.pid) killProcTree(p.pid);
  }
  trackedProcs.clear();
}

function getRunningToriPids() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "(Get-Process 'tori-download-manager' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','"],
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    return out.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n) && n > 0);
  } catch {
    return [];
  }
}

function queryRegDefault(keyPath) {
  try {
    const out = execFileSync('reg', ['query', keyPath, '/ve'], { encoding: 'utf8', timeout: 4000 });
    const m = out.match(/REG_SZ\s+(.+)\r?$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function getShortcutTargets() {
  return [
    path.join(process.env.USERPROFILE || '', 'Desktop', 'TORI Download Manager.lnk'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TORI Download Manager', 'TORI Download Manager.lnk'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TORI Download Manager.lnk'),
  ];
}

function backupOemState() {
  fs.mkdirSync(QA_BACKUP_DIR, { recursive: true });
  const uninstKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TORI Download Manager';
  const manuKey = 'HKCU\\Software\\tori\\TORI Download Manager';
  try {
    execFileSync('reg', ['export', uninstKey, path.join(QA_BACKUP_DIR, 'uninstall.reg'), '/y'], { stdio: 'ignore', timeout: 4000 });
    hkcuUninstallExisted = true;
  } catch {
    hkcuUninstallExisted = false;
  }
  try {
    execFileSync('reg', ['export', manuKey, path.join(QA_BACKUP_DIR, 'manu.reg'), '/y'], { stdio: 'ignore', timeout: 4000 });
    hkcuManuExisted = true;
  } catch {
    hkcuManuExisted = false;
  }

  savedRegNmChr = queryRegDefault('HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager');
  savedRegNmEdge = queryRegDefault('HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager');
  savedRegNmFf = queryRegDefault('HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager');
  if (fs.existsSync(OEM_NM_CHR)) savedNmChr = fs.readFileSync(OEM_NM_CHR, 'utf8');
  if (fs.existsSync(OEM_NM_FF)) savedNmFf = fs.readFileSync(OEM_NM_FF, 'utf8');

  const sc = getShortcutTargets();
  for (let i = 0; i < sc.length; i++) {
    if (fs.existsSync(sc[i])) {
      fs.copyFileSync(sc[i], path.join(QA_BACKUP_DIR, `lnk_${i}.lnk`));
    }
  }
}

function temporarilySilenceNativeHostAutoSpawn() {
  const blockedChr = path.join(QA_ROOT, 'nm_chr_blocked.json');
  const blockedFf = path.join(QA_ROOT, 'nm_ff_blocked.json');
  fs.mkdirSync(QA_ROOT, { recursive: true });
  fs.writeFileSync(blockedChr, JSON.stringify({
    name: 'com.tori.download_manager',
    description: 'TORI QA Isolation Shield',
    path: 'C:\\Windows\\System32\\cmd.exe',
    type: 'stdio',
    allowed_origins: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'],
  }, null, 2));
  fs.writeFileSync(blockedFf, JSON.stringify({
    name: 'com.tori.download_manager',
    description: 'TORI QA Isolation Shield (Firefox)',
    path: 'C:\\Windows\\System32\\cmd.exe',
    type: 'stdio',
    allowed_extensions: ['qa-isolation-shield@toridm.org'],
  }, null, 2));
  execFileSync('reg', ['add', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', blockedChr, '/f'], { stdio: 'ignore', timeout: 4000 });
  execFileSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', blockedChr, '/f'], { stdio: 'ignore', timeout: 4000 });
  execFileSync('reg', ['add', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', blockedFf, '/f'], { stdio: 'ignore', timeout: 4000 });
}

function restoreOemState() {
  const uninstKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TORI Download Manager';
  const manuKey = 'HKCU\\Software\\tori\\TORI Download Manager';
  try {
    if (hkcuUninstallExisted && fs.existsSync(path.join(QA_BACKUP_DIR, 'uninstall.reg'))) {
      execFileSync('reg', ['import', path.join(QA_BACKUP_DIR, 'uninstall.reg')], { stdio: 'ignore', timeout: 4000 });
    } else {
      execFileSync('reg', ['delete', uninstKey, '/f'], { stdio: 'ignore', timeout: 4000 });
    }
  } catch {}
  try {
    if (hkcuManuExisted && fs.existsSync(path.join(QA_BACKUP_DIR, 'manu.reg'))) {
      execFileSync('reg', ['import', path.join(QA_BACKUP_DIR, 'manu.reg')], { stdio: 'ignore', timeout: 4000 });
    } else {
      execFileSync('reg', ['delete', manuKey, '/f'], { stdio: 'ignore', timeout: 4000 });
    }
  } catch {}

  if (savedNmChr !== null) {
    try { fs.writeFileSync(OEM_NM_CHR, savedNmChr, 'utf8'); } catch {}
  }
  if (savedNmFf !== null) {
    try { fs.writeFileSync(OEM_NM_FF, savedNmFf, 'utf8'); } catch {}
  }
  for (const [key, val] of [
    ['HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager', savedRegNmChr],
    ['HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager', savedRegNmEdge],
    ['HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager', savedRegNmFf],
  ]) {
    try {
      if (val) execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', val, '/f'], { stdio: 'ignore', timeout: 4000 });
    } catch {}
  }

  const sc = getShortcutTargets();
  for (let i = 0; i < sc.length; i++) {
    const bak = path.join(QA_BACKUP_DIR, `lnk_${i}.lnk`);
    try {
      if (fs.existsSync(bak)) {
        fs.mkdirSync(path.dirname(sc[i]), { recursive: true });
        fs.copyFileSync(bak, sc[i]);
      } else if (fs.existsSync(sc[i])) {
        const target = execFileSync(
          'powershell',
          ['-NoProfile', '-Command', `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${sc[i].replace(/'/g, "''")}'); $s.TargetPath`],
          { encoding: 'utf8', timeout: 4000 }
        ).trim();
        if (target.toLowerCase().includes('gate31_4_qa')) fs.unlinkSync(sc[i]);
      }
    } catch {}
  }

  if (oemWasRunning && fs.existsSync(OEM_DESKTOP_EXE)) {
    try {
      spawn(OEM_DESKTOP_EXE, ['--minimized'], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
    oemWasRunning = false;
  }
}

function seedQaDatabase(dbPath, { port, dlDir, token, maxa = 3, theme = 'light', accent = 'indigo', showDownloadPopup = 'always' }) {
  const py = `
import sqlite3, json, sys
db_path, dl_dir, token, port, maxa, theme, accent, popup = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), sys.argv[6], sys.argv[7], sys.argv[8]
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
app_settings = {
  "dir": dl_dir,
  "sort": False,
  "con": 4,
  "maxa": maxa,
  "limMode": "off",
  "limV": 512,
  "limU": "KiB/s",
  "retries": 1,
  "dyn": True,
  "mps": 256,
  "mpsU": "KiB",
  "ua": "",
  "ssl": False,
  "lm": False,
  "track": True,
  "dns": "System DNS",
  "proxy": "none",
  "port": port,
  "key": token,
  "cap": True,
  "theme": theme,
  "accent": accent,
  "motion": False,
  "details": False,
  "showDownloadPopup": popup,
  "alwaysOnTop": True,
  "closeToTray": True
}
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("browser_integration_token", token))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("server_port", str(port)))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("app_settings", json.dumps(app_settings)))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("close_to_tray_migrated_v104", "true"))
conn.commit()
conn.close()
`;
  execFileSync('python', ['-c', py, dbPath, dlDir, token, String(port), String(maxa), theme, accent, showDownloadPopup], { stdio: 'pipe' });
}

function httpJson({ port, reqPath, method = 'GET', body = null, headers = {}, timeoutMs = 15000 }) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: {
          ...headers,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data, raw });
        });
      }
    );
    req.on('error', (err) => resolve({ status: 0, ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (err) => reject(err));
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: res, reject: rej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) rej(new Error(JSON.stringify(msg.error)));
            else res(msg.result);
          }
        } catch {}
      });
    });
  }
  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, userGesture = true) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (res?.exceptionDetails) {
      throw new Error(`CDP eval error: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
    }
    return res?.result?.value;
  }
  async screenshot(outFile) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    if (!res?.data) throw new Error('No screenshot data');
    fs.writeFileSync(outFile, Buffer.from(res.data, 'base64'));
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function listCdpTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

function getProgressTargetJobId(t) {
  try {
    const u = new URL(t.url);
    if (u.searchParams.get('window') === 'toast' || u.searchParams.get('window') === 'progress') {
      return u.searchParams.get('id');
    }
  } catch {}
  return null;
}

async function waitForMainCdp(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listCdpTargets(port);
    const main = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url).includes('window=toast') && !String(t.url).includes('window=progress'));
    if (main) {
      const c = new CDPClient(main.webSocketDebuggerUrl);
      await c.connect();
      await c.send('Runtime.enable');
      await c.send('DOM.enable');
      await c.send('Page.enable');
      for (let i = 0; i < 30; i++) {
        const ready = await c.eval(`!!document.querySelector('#main')`).catch(() => false);
        if (ready) return c;
        await sleep(200);
      }
      return c;
    }
    await sleep(250);
  }
  throw new Error(`Main WebView2 CDP not ready on port ${port}`);
}

async function waitForProgressCdp(port, jobId, timeoutMs = 15000, expectIdm = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listCdpTargets(port);
    const match = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && (jobId ? getProgressTargetJobId(t) === jobId : getProgressTargetJobId(t) !== null));
    if (match) {
      const c = new CDPClient(match.webSocketDebuggerUrl);
      await c.connect();
      await c.send('Runtime.enable');
      await c.send('DOM.enable');
      await c.send('Page.enable');
      if (expectIdm) {
        for (let i = 0; i < 30; i++) {
          const ready = await c.eval(`!!document.querySelector('.dl-popup-root .dl-win') && document.querySelector('#wt')?.textContent?.trim() !== 'TORI Download'`).catch(() => false);
          if (ready) break;
          await sleep(150);
        }
      } else {
        await sleep(800);
      }
      await sleep(200);
      return c;
    }
    await sleep(200);
  }
  throw new Error(`Progress window CDP for job ${jobId} did not open within ${timeoutMs}ms`);
}

async function inspectIdmPopup(cdp) {
  return await cdp.eval(`(() => {
    const root = document.querySelector('.dl-popup-root');
    const win = document.getElementById('w');
    const rect = win ? win.getBoundingClientRect() : { width: 0, height: 0 };
    const tabs = Array.from(document.querySelectorAll('.dl-tabs .dl-tab')).map(e => e.textContent.trim());
    const grid = {};
    const ks = Array.from(document.querySelectorAll('.dl-grid .k'));
    const vs = Array.from(document.querySelectorAll('.dl-grid .v'));
    for (let i = 0; i < ks.length; i++) {
      grid[ks[i].textContent.trim()] = (vs[i]?.textContent || '').trim();
    }
    const btns = Array.from(document.querySelectorAll('.dl-foot .dl-btn')).map(b => b.textContent.trim());
    const legacyToast = !!document.querySelector('.toast-card, .toast-stack, svg circle[stroke-dasharray]');
    return {
      isIdm: !!root && !!win && tabs.length === 3,
      legacyToast,
      jobId: win?.dataset?.jobId || '',
      state: win?.dataset?.state || '',
      title: document.getElementById('wt')?.textContent?.trim() || '',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      theme: document.documentElement.dataset.theme,
      tabs,
      grid,
      conn: Number(document.getElementById('dl-conn-count')?.textContent?.trim() || '0'),
      segs: document.querySelectorAll('.dl-sg i').length,
      btns,
    };
  })()`);
}

function sendNativeHostMessage(hostExe, pipeName, dataDir, msgObj) {
  return new Promise((resolve, reject) => {
    const p = spawn(hostExe, [], {
      env: {
        ...process.env,
        TORI_IPC_PIPE: pipeName,
        TORI_DATA_DIR: dataDir,
        TORI_ALLOW_LOOPBACK: '1',
        TORI_DISABLE_AUTO_SPAWN: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const payload = Buffer.from(JSON.stringify(msgObj), 'utf8');
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(payload.length, 0);
    let outBuf = Buffer.alloc(0);
    const t = setTimeout(() => {
      try { p.kill(); } catch {}
      reject(new Error('Native host message timeout'));
    }, 12000);
    p.stdout.on('data', (chunk) => {
      outBuf = Buffer.concat([outBuf, chunk]);
      if (outBuf.length >= 4) {
        const len = outBuf.readUInt32LE(0);
        if (outBuf.length >= 4 + len) {
          clearTimeout(t);
          const jsonStr = outBuf.subarray(4, 4 + len).toString('utf8');
          try { p.kill(); } catch {}
          try { resolve(JSON.parse(jsonStr)); } catch (e) { reject(e); }
        }
      }
    });
    p.on('error', (err) => { clearTimeout(t); reject(err); });
    p.stdin.write(Buffer.concat([hdr, payload]));
    p.stdin.end();
  });
}

async function waitForJobState(port, token, jobId, targetStates, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await httpJson({
      port,
      reqPath: '/api/v1/downloads',
      headers: { 'X-Tori-Token': token },
    });
    const jobs = res.data?.jobs || res.data?.downloads || [];
    const job = jobs.find((j) => j.id === jobId);
    if (job && targetStates.includes(job.state)) return job;
    await sleep(300);
  }
  return null;
}

function probeMediaFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.existsSync(FFPROBE_EXE)) return { ok: false, reason: 'missing' };
  try {
    const out = execFileSync(FFPROBE_EXE, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath], {
      encoding: 'utf8',
      timeout: 15000,
    });
    const info = JSON.parse(out);
    const streams = info.streams || [];
    const hasVideo = streams.some((s) => s.codec_type === 'video');
    const hasAudio = streams.some((s) => s.codec_type === 'audio');
    const size = fs.statSync(filePath).size;
    return { ok: size > 0 && streams.length > 0, size, hasVideo, hasAudio, format: info.format?.format_name };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

async function run() {
  console.log('========================================================================');
  console.log(`  TORI GATE 31.4: LEGACY TOAST REPLACEMENT REAL ACCEPTANCE (v${TARGET_VER})`);
  console.log('========================================================================\n');

  if (!fs.existsSync(INSTALLER_EXE)) {
    throw new Error(`Packaged installer missing: ${INSTALLER_EXE}`);
  }

  const oemDbHashBefore = sha256File(OEM_DB_PATH);
  const existingPids = getRunningToriPids();
  if (existingPids.length > 0) {
    oemWasRunning = true;
    const ping = await httpJson({ port: 6800, reqPath: '/api/v1/ping' }).catch(() => ({ ok: false }));
    if (ping.ok && ping.data?.active_downloads > 0) {
      throw new Error(`OEM TORI has ${ping.data.active_downloads} active download(s); aborting QA.`);
    }
    for (const pid of existingPids) killProcTree(pid);
    await sleep(800);
  }

  backupOemState();
  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  for (const d of [QA_BEFORE_DATA, QA_BEFORE_DL, QA_BEFORE_WV2, QA_DATA_DIR, QA_DL_DIR, QA_WV2_DIR, SCREENSHOTS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  temporarilySilenceNativeHostAutoSpawn();

  // Payloads for local fixture HTTP server
  const smallPayload = makePatternBuffer(128 * 1024); // 128 KB
  const largePayload = makePatternBuffer(12 * 1024 * 1024); // 12 MiB
  const mkvPayload = makePatternBuffer(6 * 1024 * 1024, '1a45dfa3a34286810142f7810142f2810442f381084282886d6174726f736b61'); // 6 MiB EBML MKV
  const multiPayload = makePatternBuffer(3 * 1024 * 1024); // 3 MiB each
  const trayPayload = makePatternBuffer(2 * 1024 * 1024); // 2 MiB

  const fixtureMap = {
    '/small-manual.txt': { data: smallPayload, chunkKb: 64, intervalMs: 10, ctype: 'text/plain' },
    '/large-http-file.bin': { data: largePayload, chunkKb: 24, intervalMs: 25, ctype: 'application/octet-stream' },
    '/browser-captured-movie.mkv': { data: mkvPayload, chunkKb: 28, intervalMs: 20, ctype: 'video/x-matroska' },
    '/native-msg-capture.bin': { data: multiPayload, chunkKb: 32, intervalMs: 18, ctype: 'application/octet-stream' },
    '/multi-1.bin': { data: multiPayload, chunkKb: 24, intervalMs: 28, ctype: 'application/octet-stream' },
    '/multi-2.bin': { data: multiPayload, chunkKb: 24, intervalMs: 28, ctype: 'application/octet-stream' },
    '/multi-3.bin': { data: multiPayload, chunkKb: 24, intervalMs: 28, ctype: 'application/octet-stream' },
    '/multi-4-queued.bin': { data: multiPayload, chunkKb: 32, intervalMs: 20, ctype: 'application/octet-stream' },
    '/tray-bg.bin': { data: trayPayload, chunkKb: 24, intervalMs: 22, ctype: 'application/octet-stream' },
    '/paused-on-add.bin': { data: smallPayload, chunkKb: 32, intervalMs: 20, ctype: 'application/octet-stream' },
    '/never-popup.bin': { data: smallPayload, chunkKb: 64, intervalMs: 10, ctype: 'application/octet-stream' },
  };

  const fixtureServer = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://127.0.0.1:${FIXTURE_PORT}`);
    const entry = fixtureMap[reqUrl.pathname];
    if (!entry) {
      res.writeHead(404);
      return res.end();
    }
    const { data, chunkKb, intervalMs, ctype } = entry;
    const total = data.length;
    const rangeHdr = req.headers.range;
    let start = 0;
    let end = total - 1;
    let status = 200;
    if (rangeHdr && rangeHdr.startsWith('bytes=')) {
      const [s, e] = rangeHdr.slice(6).split('-');
      start = parseInt(s, 10) || 0;
      end = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
      status = 206;
    }
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': ctype,
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();

    let offset = start;
    const chunkSz = chunkKb * 1024;
    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) return clearInterval(timer);
      const nextEnd = Math.min(offset + chunkSz - 1, end);
      res.write(data.subarray(offset, nextEnd + 1));
      offset = nextEnd + 1;
      if (offset > end) {
        clearInterval(timer);
        res.end();
      }
    }, intervalMs);
    req.on('close', () => clearInterval(timer));
  });

  await new Promise((resolve) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', resolve));

  try {
    // =========================================================================
    // STEP 0: Capture "BEFORE" evidence from stale installed v1.0.4 binary
    // =========================================================================
    if (fs.existsSync(OEM_DESKTOP_EXE)) {
      const oemVer = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-Item '${OEM_DESKTOP_EXE.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      console.log(`\n>>> [BEFORE] Capturing live legacy toast evidence from installed exe (v${oemVer}) <<<`);
      seedQaDatabase(path.join(QA_BEFORE_DATA, 'tdm_storage.sqlite'), {
        port: BEFORE_PORT,
        dlDir: QA_BEFORE_DL,
        token: API_TOKEN,
        theme: 'dark',
        accent: 'rose',
        showDownloadPopup: 'always',
      });
      const beforePipe = `\\\\.\\pipe\\tori-qa-g31-4-before-${process.pid}`;
      const beforeProc = spawn(OEM_DESKTOP_EXE, [], {
        cwd: path.dirname(OEM_DESKTOP_EXE),
        env: {
          ...process.env,
          TORI_DATA_DIR: QA_BEFORE_DATA,
          TDM_STORAGE_DIR: QA_BEFORE_DATA,
          TDM_DOWNLOAD_DIR: QA_BEFORE_DL,
          TORI_IPC_PIPE: beforePipe,
          TORI_ALLOW_LOOPBACK: '1',
          TORI_DISABLE_AUTO_SPAWN: '1',
          WEBVIEW2_USER_DATA_FOLDER: QA_BEFORE_WV2,
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${BEFORE_CDP_PORT}`,
        },
        stdio: 'ignore',
      });
      trackedProcs.add(beforeProc);
      try {
        let pingOk = false;
        for (let i = 0; i < 40; i++) {
          await sleep(300);
          const p = await httpJson({ port: BEFORE_PORT, reqPath: '/api/v1/ping', headers: { 'X-Tori-Token': API_TOKEN } });
          if (p.ok) { pingOk = true; break; }
        }
        if (pingOk) {
          const r = await httpJson({
            port: BEFORE_PORT,
            reqPath: '/api/v1/downloads',
            method: 'POST',
            headers: { 'X-Tori-Token': API_TOKEN },
            body: { url: `http://127.0.0.1:${FIXTURE_PORT}/large-http-file.bin`, filename: 'large-http-file.bin' },
          });
          const bid = r.data?.job_id || r.data?.id;
          const bPop = await waitForProgressCdp(BEFORE_CDP_PORT, bid, 12000, false);
          await sleep(900);
          const beforeDiag = await inspectIdmPopup(bPop);
          await bPop.screenshot(path.join(SCREENSHOTS_DIR, '00_before_legacy_v104_dark_toast.png'));
          bPop.close();
          record(
            'BEFORE-V104',
            `Stale installed v${oemVer} reproduces legacy dark floating toast (pre-Gate 29.2)`,
            !beforeDiag.isIdm && oemVer === '1.0.4',
            JSON.stringify({ oemVer, isIdm: beforeDiag.isIdm, legacyToast: beforeDiag.legacyToast })
          );
        }
      } finally {
        killProcTree(beforeProc.pid);
        trackedProcs.delete(beforeProc);
        await sleep(500);
      }
    }

    // =========================================================================
    // STEP 1: Silent Install Packaged Desktop v1.0.6 RC & Boot
    // =========================================================================
    console.log(`\n>>> [INSTALL] Installing packaged Desktop v${TARGET_VER} RC silently into isolated QA dir <<<`);
    execSync(`"${INSTALLER_EXE}" /S /D=${QA_INST_DIR}`, { timeout: 90000 });
    temporarilySilenceNativeHostAutoSpawn();
    for (const stray of getRunningToriPids()) killProcTree(stray);

    const installedExe = path.join(QA_INST_DIR, 'tori-download-manager.exe');
    const installedHost = path.join(QA_INST_DIR, 'bin', 'tdm-native-host.exe');
    const instPeVer = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Item '${installedExe.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    record(
      'PKG-INSTALL',
      `Packaged v${TARGET_VER} RC NSIS installer deploys cleanly with exact ProductVersion`,
      fs.existsSync(installedExe) && fs.existsSync(installedHost) && fs.existsSync(INSTALLER_SIG) && instPeVer.startsWith(TARGET_VER),
      `peVer=${instPeVer}, exe=${installedExe}`
    );

    const dbPath = path.join(QA_DATA_DIR, 'tdm_storage.sqlite');
    seedQaDatabase(dbPath, {
      port: GUI_PORT,
      dlDir: QA_DL_DIR,
      token: API_TOKEN,
      maxa: 3,
      theme: 'light',
      accent: 'indigo',
      showDownloadPopup: 'always',
    });

    const pipeName = `\\\\.\\pipe\\tori-qa-g31-4-${process.pid}`;
    const proc = spawn(installedExe, [], {
      cwd: QA_INST_DIR,
      env: {
        ...process.env,
        TORI_DATA_DIR: QA_DATA_DIR,
        TDM_STORAGE_DIR: QA_DATA_DIR,
        TDM_DOWNLOAD_DIR: QA_DL_DIR,
        TORI_IPC_PIPE: pipeName,
        TORI_ALLOW_LOOPBACK: '1',
        TORI_DISABLE_AUTO_SPAWN: '1',
        WEBVIEW2_USER_DATA_FOLDER: QA_WV2_DIR,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
        RUST_MIN_STACK: '8388608',
      },
      stdio: 'ignore',
    });
    trackedProcs.add(proc);

    let pingOk = false;
    for (let i = 0; i < 45; i++) {
      await sleep(300);
      const res = await httpJson({ port: GUI_PORT, reqPath: '/api/v1/ping', headers: { 'X-Tori-Token': API_TOKEN } });
      if (res.ok && res.data?.name === 'TORI Download Manager') { pingOk = true; break; }
    }
    if (!pingOk) throw new Error('Packaged Desktop HTTP API failed to come online');

    const mainCdp = await waitForMainCdp(CDP_PORT, 20000);
    const appVer = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_app_version')`);
    record('PKG-BOOT', `Packaged Desktop v${TARGET_VER} boots cleanly`, appVer === TARGET_VER, `appVer=${appVer}`);

    // =========================================================================
    // TEST 1: Small HTTP file (Manual add via create_download)
    // =========================================================================
    console.log('\n>>> [TEST 1] Small HTTP file (Manual add) <<<');
    const smallJob = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('create_download', {
      url: 'http://127.0.0.1:${FIXTURE_PORT}/small-manual.txt',
      destination: null,
      priority: 'normal',
      referer: null,
      userAgent: null,
      scheduledAt: null,
      startImmediately: true
    })`);
    const popSmall = await waitForProgressCdp(CDP_PORT, smallJob.id, 15000);
    const smallDoneJob = await waitForJobState(GUI_PORT, API_TOKEN, smallJob.id, ['completed'], 15000);
    await sleep(400);
    const smallDiag = await inspectIdmPopup(popSmall);
    const smallTargets = (await listCdpTargets(CDP_PORT)).filter((t) => getProgressTargetJobId(t) === smallJob.id).length;
    const smallShaOk = sha256File(path.join(QA_DL_DIR, 'small-manual.txt')) === crypto.createHash('sha256').update(smallPayload).digest('hex');
    await popSmall.screenshot(path.join(SCREENSHOTS_DIR, '01_small_http_completed.png'));
    await popSmall.eval(`document.getElementById('cl').click()`);
    popSmall.close();
    await sleep(300);
    record(
      'T01-SMALL-HTTP',
      'Small HTTP file opens IDM progress window (no legacy toast, no duplicate, exact SHA-256)',
      Boolean(smallDoneJob && smallDiag.isIdm && !smallDiag.legacyToast && smallTargets === 1 && smallShaOk && smallDiag.title === 'Download complete'),
      JSON.stringify({ title: smallDiag.title, state: smallDiag.state, targets: smallTargets, smallShaOk })
    );

    // =========================================================================
    // TEST 2 + 7 + 8 + 9: Large HTTP file + Pause + Resume + Close-Window + Completed
    // =========================================================================
    console.log('\n>>> [TEST 2/7/8/9] Large HTTP file, Pause, Resume, Close-Leaves-Running, Complete <<<');
    const largeJob = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('create_download', {
      url: 'http://127.0.0.1:${FIXTURE_PORT}/large-http-file.bin',
      destination: null,
      priority: 'normal',
      referer: null,
      userAgent: null,
      scheduledAt: null,
      startImmediately: true
    })`);
    const popLarge = await waitForProgressCdp(CDP_PORT, largeJob.id, 15000);
    await sleep(1400);
    const largeActiveLight = await inspectIdmPopup(popLarge);
    await popLarge.screenshot(path.join(SCREENSHOTS_DIR, '02_after_idm_progress_light.png'));
    await mainCdp.screenshot(path.join(SCREENSHOTS_DIR, '03_desktop_main_window_light.png'));

    // Verify speed & progress updated
    await sleep(1200);
    const largeActiveLight2 = await inspectIdmPopup(popLarge);
    const progressAdvanced = largeActiveLight2.grid['Downloaded'] !== largeActiveLight.grid['Downloaded'];

    // TEST 7: Pause inside progress window
    await popLarge.eval(`document.querySelector('.dl-foot .dl-btn.pri').click()`);
    for (let i = 0; i < 25; i++) {
      const st = await popLarge.eval(`document.getElementById('w')?.dataset?.state`);
      if (st === 'paused') break;
      await sleep(150);
    }
    await sleep(300);
    // Switch to Dark theme via real Settings UI so BOTH Main Window & Progress Window switch live
    await mainCdp.eval(`document.querySelector('#tool button[data-a="settings"]')?.click()`);
    await sleep(300);
    await mainCdp.eval(`document.querySelector('#ptabsrow .pt[data-tab="appearance"]')?.click()`);
    await sleep(250);
    await mainCdp.eval(`(() => {
      document.querySelector('#prefbody .acs[title="Ocean"]')?.click();
      const sel = document.querySelector('#prefbody select.sl');
      if (sel) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, 'dark');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelector('#setw .foot .btn.def')?.click();
    })()`);
    await sleep(450);
    const largePaused = await inspectIdmPopup(popLarge);
    await popLarge.screenshot(path.join(SCREENSHOTS_DIR, '04_paused_download_dark.png'));
    record(
      'T07-PAUSED',
      'Paused download switches IDM progress window to Paused, Connections=0, Resume button, Dark theme live',
      Boolean(largePaused.isIdm && !largePaused.legacyToast && largePaused.state === 'paused' && largePaused.conn === 0 && largePaused.btns.includes('Resume') && largePaused.theme === 'dark'),
      JSON.stringify({ state: largePaused.state, conn: largePaused.conn, btns: largePaused.btns, theme: largePaused.theme })
    );

    // TEST 8: Resume inside progress window (and check no duplicate windows!)
    await popLarge.eval(`document.querySelector('.dl-foot .dl-btn.pri').click()`);
    await sleep(1300);
    const largeResumed = await inspectIdmPopup(popLarge);
    const largeTargetsAfterResume = (await listCdpTargets(CDP_PORT)).filter((t) => getProgressTargetJobId(t) === largeJob.id).length;
    await popLarge.screenshot(path.join(SCREENSHOTS_DIR, '05_after_idm_progress_dark_resumed.png'));
    await mainCdp.screenshot(path.join(SCREENSHOTS_DIR, '06_desktop_main_window_dark.png'));
    record(
      'T08-RESUMED',
      'Resumed download resumes active transfer in same IDM progress window with zero duplicates',
      Boolean(largeResumed.isIdm && largeResumed.state === 'downloading' && largeResumed.conn >= 1 && largeTargetsAfterResume === 1),
      JSON.stringify({ state: largeResumed.state, conn: largeResumed.conn, downloaded: largeResumed.grid['Downloaded'], targets: largeTargetsAfterResume })
    );

    // Close progress window mid-download -> verify download continues to 100% completion!
    await popLarge.eval(`document.getElementById('cl').click()`);
    popLarge.close();
    await sleep(400);
    const closedMidTransfer = !(await listCdpTargets(CDP_PORT)).some((t) => getProgressTargetJobId(t) === largeJob.id);
    const largeDoneJob = await waitForJobState(GUI_PORT, API_TOKEN, largeJob.id, ['completed'], 40000);
    const largeShaOk = sha256File(path.join(QA_DL_DIR, 'large-http-file.bin')) === crypto.createHash('sha256').update(largePayload).digest('hex');
    record(
      'T02-LARGE-HTTP',
      'Large HTTP file updates live speed/progress, closing window does not cancel, completes with exact SHA-256',
      Boolean(largeActiveLight.isIdm && !largeActiveLight.legacyToast && largeActiveLight.width === 460 && largeActiveLight.conn >= 1 && progressAdvanced && closedMidTransfer && largeDoneJob && largeShaOk),
      JSON.stringify({ d1: largeActiveLight.grid['Downloaded'], d2: largeActiveLight2.grid['Downloaded'], rate: largeActiveLight2.grid['Transfer rate'], conn: largeActiveLight.conn, closedMidTransfer, largeShaOk })
    );

    // TEST 9: Reopen completed download progress window via force=true
    await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('open_progress_window', { id: ${JSON.stringify(largeJob.id)}, force: true })`);
    const popCompleted = await waitForProgressCdp(CDP_PORT, largeJob.id, 10000);
    const completedDiag = await inspectIdmPopup(popCompleted);
    await popCompleted.eval(`document.getElementById('cl').click()`);
    popCompleted.close();
    await sleep(250);
    record(
      'T09-COMPLETED',
      'Completed download displays IDM completed state ("Download complete", Close/Open, 100%)',
      Boolean(completedDiag.isIdm && completedDiag.state === 'completed' && completedDiag.title === 'Download complete' && completedDiag.btns.join(',') === 'Close,Open'),
      JSON.stringify({ title: completedDiag.title, btns: completedDiag.btns, downloaded: completedDiag.grid['Downloaded'] })
    );

    // Switch back to light theme via real Settings UI for remaining captures
    await mainCdp.eval(`document.querySelector('#tool button[data-a="settings"]')?.click()`);
    await sleep(250);
    await mainCdp.eval(`document.querySelector('#ptabsrow .pt[data-tab="appearance"]')?.click()`);
    await sleep(200);
    await mainCdp.eval(`(() => {
      document.querySelector('#prefbody .acs[title="Indigo"]')?.click();
      const sel = document.querySelector('#prefbody select.sl');
      if (sel) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, 'light');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelector('#setw .foot .btn.def')?.click();
    })()`);
    await sleep(350);

    // =========================================================================
    // TEST 3: Browser-captured MKV (HTTP API + Native Messaging fallback!)
    // =========================================================================
    console.log('\n>>> [TEST 3] Browser-captured MKV (HTTP API + Native Messaging fallback) <<<');
    const mkvRes = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/browser-captured-movie.mkv`,
        filename: 'browser-captured-movie.mkv',
        handoff_id: `g31_4_mkv_${Date.now()}`,
      },
    });
    const mkvId = mkvRes.data?.job_id;
    const popMkv = await waitForProgressCdp(CDP_PORT, mkvId, 15000);
    await sleep(1100);
    const mkvDiag = await inspectIdmPopup(popMkv);
    const mkvTargets = (await listCdpTargets(CDP_PORT)).filter((t) => getProgressTargetJobId(t) === mkvId).length;
    await popMkv.screenshot(path.join(SCREENSHOTS_DIR, '07_browser_captured_mkv.png'));
    const mkvDone = await waitForJobState(GUI_PORT, API_TOKEN, mkvId, ['completed'], 30000);
    const mkvShaOk = sha256File(path.join(QA_DL_DIR, 'browser-captured-movie.mkv')) === crypto.createHash('sha256').update(mkvPayload).digest('hex');
    await popMkv.eval(`document.getElementById('cl').click()`);
    popMkv.close();
    await sleep(300);

    // Also test Native Messaging start_download path (previously bypassed OpenProgressWindow!)
    const nmResp = await sendNativeHostMessage(installedHost, pipeName, QA_DATA_DIR, {
      action: 'start_download',
      url: `http://127.0.0.1:${FIXTURE_PORT}/native-msg-capture.bin`,
      filename: 'native-msg-capture.bin',
    });
    const nmId = nmResp?.job_id;
    const popNm = await waitForProgressCdp(CDP_PORT, nmId, 15000);
    const nmDiag = await inspectIdmPopup(popNm);
    await waitForJobState(GUI_PORT, API_TOKEN, nmId, ['completed'], 25000);
    await popNm.eval(`document.getElementById('cl').click()`);
    popNm.close();
    await sleep(300);

    record(
      'T03-BROWSER-MKV',
      'Browser-captured MKV (HTTP) & Native Messaging handoff both open unified IDM progress window',
      Boolean(mkvDiag.isIdm && !mkvDiag.legacyToast && mkvDiag.title.includes('browser-captured-movie.mkv') && mkvTargets === 1 && mkvDone && mkvShaOk && nmDiag.isIdm && !nmDiag.legacyToast),
      JSON.stringify({ mkvTitle: mkvDiag.title, mkvTargets, mkvShaOk, nmIsIdm: nmDiag.isIdm, nmTitle: nmDiag.title })
    );

    // =========================================================================
    // TEST 4: YouTube Video (Real YouTube download via /api/v1/media/resolve + /api/v1/media/download)
    // =========================================================================
    console.log('\n>>> [TEST 4] Real YouTube Video download <<<');
    const ytResolveRes = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/media/resolve',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: YT_TEST_URL },
      timeoutMs: 45000,
    });
    const resolvedFormats = ytResolveRes.data?.metadata?.formats || ytResolveRes.data?.formats || [];
    const videoFmt =
      resolvedFormats.find((f) => f.has_video && (f.height === 360 || (f.resolution_label || '').includes('360'))) ||
      resolvedFormats.find((f) => f.has_video && f.height && f.height <= 480) ||
      resolvedFormats.find((f) => f.has_video);
    const chosenVideoFmtId = videoFmt ? (videoFmt.requires_merge && videoFmt.merge_audio_format_id ? `${videoFmt.format_id}+${videoFmt.merge_audio_format_id}` : videoFmt.format_id) : 'best';

    const ytVidRes = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/media/download',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: {
        url: YT_TEST_URL,
        format_id: chosenVideoFmtId,
        filename: 'TORI_Gate31_4_YouTube_Video.mp4',
      },
      timeoutMs: 25000,
    });
    const ytVidId = ytVidRes.data?.job_id;
    let ytVidOk = false;
    let ytVidDetail = {};
    if (ytVidId) {
      const popYtVid = await waitForProgressCdp(CDP_PORT, ytVidId, 15000);
      let ytVidDiag = await inspectIdmPopup(popYtVid);
      // Wait up to 15s for real YouTube bytes/percentage to appear before screenshot
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        ytVidDiag = await inspectIdmPopup(popYtVid);
        if ((ytVidDiag.grid['Downloaded'] && ytVidDiag.grid['Downloaded'] !== '0 B') || ytVidDiag.state === 'completed' || ytVidDiag.state === 'failed') {
          break;
        }
      }
      const ytVidTargets = (await listCdpTargets(CDP_PORT)).filter((t) => getProgressTargetJobId(t) === ytVidId).length;
      await popYtVid.screenshot(path.join(SCREENSHOTS_DIR, '08_youtube_video_progress.png'));
      const ytVidDone = await waitForJobState(GUI_PORT, API_TOKEN, ytVidId, ['completed', 'failed'], 90000);
      const fullYtVid = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(ytVidId)} })`);
      const probe = ytVidDone?.state === 'completed' && fullYtVid?.target_path ? probeMediaFile(fullYtVid.target_path) : { ok: false, state: ytVidDone?.state, err: fullYtVid?.error_message };
      await popYtVid.eval(`document.getElementById('cl').click()`).catch(() => {});
      popYtVid.close();
      await sleep(300);
      ytVidOk = Boolean(ytVidDiag.isIdm && !ytVidDiag.legacyToast && ytVidTargets === 1 && ytVidDone?.state === 'completed' && probe.ok && probe.hasVideo);
      ytVidDetail = { formatId: chosenVideoFmtId, title: ytVidDiag.title, downloaded: ytVidDiag.grid['Downloaded'], targets: ytVidTargets, state: ytVidDone?.state, targetPath: fullYtVid?.target_path, probe };
    }
    record('T04-YT-VIDEO', 'YouTube video opens IDM progress window, tracks transfer & produces valid video file', ytVidOk, JSON.stringify(ytVidDetail));

    // =========================================================================
    // TEST 5: YouTube Audio (Real YouTube audio download via /api/v1/media/download)
    // =========================================================================
    console.log('\n>>> [TEST 5] Real YouTube Audio download <<<');
    const ytAudRes = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/media/download',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: {
        url: YT_TEST_URL,
        format_id: 'bestaudio',
        filename: 'TORI_Gate31_4_YouTube_Audio.m4a',
      },
      timeoutMs: 25000,
    });
    const ytAudId = ytAudRes.data?.job_id;
    let ytAudOk = false;
    let ytAudDetail = {};
    if (ytAudId) {
      const popYtAud = await waitForProgressCdp(CDP_PORT, ytAudId, 15000);
      let ytAudDiag = await inspectIdmPopup(popYtAud);
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        ytAudDiag = await inspectIdmPopup(popYtAud);
        if ((ytAudDiag.grid['Downloaded'] && ytAudDiag.grid['Downloaded'] !== '0 B' && !ytAudDiag.grid['Downloaded'].startsWith('1 KB')) || ytAudDiag.state === 'completed' || ytAudDiag.state === 'failed') {
          break;
        }
      }
      const ytAudTargets = (await listCdpTargets(CDP_PORT)).filter((t) => getProgressTargetJobId(t) === ytAudId).length;
      await popYtAud.screenshot(path.join(SCREENSHOTS_DIR, '09_youtube_audio_progress.png'));
      const ytAudDone = await waitForJobState(GUI_PORT, API_TOKEN, ytAudId, ['completed', 'failed'], 90000);
      const fullYtAud = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(ytAudId)} })`);
      const probe = ytAudDone?.state === 'completed' && fullYtAud?.target_path ? probeMediaFile(fullYtAud.target_path) : { ok: false, state: ytAudDone?.state, err: fullYtAud?.error_message };
      await popYtAud.eval(`document.getElementById('cl').click()`).catch(() => {});
      popYtAud.close();
      await sleep(300);
      ytAudOk = Boolean(ytAudDiag.isIdm && !ytAudDiag.legacyToast && ytAudTargets === 1 && ytAudDone?.state === 'completed' && probe.ok && probe.hasAudio);
      ytAudDetail = { title: ytAudDiag.title, downloaded: ytAudDiag.grid['Downloaded'], targets: ytAudTargets, state: ytAudDone?.state, targetPath: fullYtAud?.target_path, probe };
    }
    record('T05-YT-AUDIO', 'YouTube audio opens IDM progress window, tracks transfer & produces valid audio file', ytAudOk, JSON.stringify(ytAudDetail));

    // =========================================================================
    // TEST 6: Multiple Simultaneous Downloads + Queued Auto-Promotion
    // =========================================================================
    console.log('\n>>> [TEST 6] Multiple simultaneous downloads + queued promotion (maxa=3) <<<');
    const [m1, m2, m3, m4] = await Promise.all([
      httpJson({ port: GUI_PORT, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': API_TOKEN }, body: { url: `http://127.0.0.1:${FIXTURE_PORT}/multi-1.bin`, filename: 'multi-1.bin' } }),
      httpJson({ port: GUI_PORT, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': API_TOKEN }, body: { url: `http://127.0.0.1:${FIXTURE_PORT}/multi-2.bin`, filename: 'multi-2.bin' } }),
      httpJson({ port: GUI_PORT, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': API_TOKEN }, body: { url: `http://127.0.0.1:${FIXTURE_PORT}/multi-3.bin`, filename: 'multi-3.bin' } }),
      httpJson({ port: GUI_PORT, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': API_TOKEN }, body: { url: `http://127.0.0.1:${FIXTURE_PORT}/multi-4-queued.bin`, filename: 'multi-4-queued.bin' } }),
    ]);
    const ids = [m1.data?.job_id, m2.data?.job_id, m3.data?.job_id, m4.data?.job_id];
    const [p1, p2, p3] = await Promise.all([
      waitForProgressCdp(CDP_PORT, ids[0], 15000),
      waitForProgressCdp(CDP_PORT, ids[1], 15000),
      waitForProgressCdp(CDP_PORT, ids[2], 15000),
    ]);
    const targetsDuringMulti = await listCdpTargets(CDP_PORT);
    const exact1Each = ids.slice(0, 3).every((id) => targetsDuringMulti.filter((t) => getProgressTargetJobId(t) === id).length === 1);
    // Wait for queued 4th download to auto-promote and open its own IDM progress window!
    const p4 = await waitForProgressCdp(CDP_PORT, ids[3], 35000);
    const p4Diag = await inspectIdmPopup(p4);
    const all4Done = (await Promise.all(ids.map((id) => waitForJobState(GUI_PORT, API_TOKEN, id, ['completed'], 40000)))).every(Boolean);
    for (const p of [p1, p2, p3, p4]) {
      await p.eval(`document.getElementById('cl').click()`).catch(() => {});
      p.close();
    }
    await sleep(350);
    record(
      'T06-MULTI-QUEUED',
      'Multiple simultaneous downloads open independent IDM windows (1 per job) & queued 4th opens automatically on promotion',
      Boolean(exact1Each && p4Diag.isIdm && !p4Diag.legacyToast && all4Done),
      JSON.stringify({ exact1Each, p4Title: p4Diag.title, all4Done })
    );

    // Also test paused-on-add (startImmediately=false does NOT pop window until started!)
    const pausedAddJob = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('create_download', {
      url: 'http://127.0.0.1:${FIXTURE_PORT}/paused-on-add.bin',
      destination: null,
      priority: 'normal',
      referer: null,
      userAgent: null,
      scheduledAt: null,
      startImmediately: false
    })`);
    await sleep(700);
    const poppedWhenPaused = (await listCdpTargets(CDP_PORT)).some((t) => getProgressTargetJobId(t) === pausedAddJob.id);
    await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('resume_download', { id: ${JSON.stringify(pausedAddJob.id)} })`);
    const popQueuedResumed = await waitForProgressCdp(CDP_PORT, pausedAddJob.id, 12000);
    const popQrDiag = await inspectIdmPopup(popQueuedResumed);
    await waitForJobState(GUI_PORT, API_TOKEN, pausedAddJob.id, ['completed'], 15000);
    await popQueuedResumed.eval(`document.getElementById('cl').click()`).catch(() => {});
    popQueuedResumed.close();
    await sleep(300);
    record(
      'T06B-ADD-PAUSED-START',
      'Add-paused (startImmediately=false) suppresses premature popup; resuming opens IDM progress window',
      Boolean(!poppedWhenPaused && popQrDiag.isIdm && !popQrDiag.legacyToast),
      JSON.stringify({ poppedWhenPaused, resumedIsIdm: popQrDiag.isIdm })
    );

    // =========================================================================
    // TEST 10: Main Window Hidden in System Tray (Close-to-Tray)
    // =========================================================================
    console.log('\n>>> [TEST 10] Main window hidden in system tray + independent progress window <<<');
    await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('window_close')`);
    await sleep(500);
    const mainHiddenInTray = await mainCdp.eval(`window.__TAURI__.window.getCurrentWindow().isVisible()`) === false;

    // Trigger browser download while Main Window is hidden in tray
    const trayRes = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: `http://127.0.0.1:${FIXTURE_PORT}/tray-bg.bin`, filename: 'tray-bg.bin' },
    });
    const trayId = trayRes.data?.job_id;
    const popTray = await waitForProgressCdp(CDP_PORT, trayId, 15000);
    await sleep(900);
    const trayDiag = await inspectIdmPopup(popTray);
    const popTrayVisible = await popTray.eval(`window.__TAURI__.window.getCurrentWindow().isVisible()`);
    const mainStillHidden = await mainCdp.eval(`window.__TAURI__.window.getCurrentWindow().isVisible()`) === false;
    await popTray.screenshot(path.join(SCREENSHOTS_DIR, '10_tray_hidden_progress_window.png'));
    const trayDone = await waitForJobState(GUI_PORT, API_TOKEN, trayId, ['completed'], 25000);
    const trayShaOk = sha256File(path.join(QA_DL_DIR, 'tray-bg.bin')) === crypto.createHash('sha256').update(trayPayload).digest('hex');
    await popTray.eval(`document.getElementById('cl').click()`).catch(() => {});
    popTray.close();
    await sleep(300);

    // Restore main window & test showDownloadPopup="never" preference respect
    await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('show_main_window')`);
    await sleep(300);
    await mainCdp.eval(`(async () => {
      const s = JSON.parse(localStorage.getItem('tori_settings_v2') || '{}');
      s.showDownloadPopup = 'never';
      localStorage.setItem('tori_settings_v2', JSON.stringify(s));
      await window.__TAURI_INTERNALS__.invoke('update_engine_settings', { settings: s });
    })()`);
    await sleep(250);
    const neverRes = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: `http://127.0.0.1:${FIXTURE_PORT}/never-popup.bin`, filename: 'never-popup.bin' },
    });
    const neverId = neverRes.data?.job_id;
    await waitForJobState(GUI_PORT, API_TOKEN, neverId, ['completed'], 15000);
    await sleep(400);
    const poppedUnderNever = (await listCdpTargets(CDP_PORT)).some((t) => getProgressTargetJobId(t) === neverId);

    // Verify lifecycle log recorded PROGRESS_WINDOW OPEN & SKIPPED
    const logPath = path.join(QA_DATA_DIR, 'logs', 'lifecycle.log');
    const logTxt = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    const hasProgressLogs = logTxt.includes('[PROGRESS_WINDOW] OPEN:') && logTxt.includes('reason=popup_mode_never');

    record(
      'T10-TRAY-AND-PREF',
      'Main window hides to tray cleanly; new downloads open standalone IDM progress window; showDownloadPopup=never respected',
      Boolean(mainHiddenInTray && mainStillHidden && popTrayVisible && trayDiag.isIdm && !trayDiag.legacyToast && trayDone && trayShaOk && !poppedUnderNever && hasProgressLogs),
      JSON.stringify({ mainHiddenInTray, mainStillHidden, popTrayVisible, trayShaOk, poppedUnderNever, hasProgressLogs })
    );

    mainCdp.close();
    killProcTree(proc.pid);
    trackedProcs.delete(proc);
  } finally {
    cleanupProcs();
    fixtureServer.close();
    restoreOemState();
  }

  const oemDbHashAfter = sha256File(OEM_DB_PATH);
  record(
    'SAFETY-OEM',
    'Production %APPDATA% SQLite database untouched',
    oemDbHashBefore === oemDbHashAfter,
    `before=${oemDbHashBefore}, after=${oemDbHashAfter}`
  );

  console.log('\n========================================================================');
  console.log(`GATE 31.4 SUMMARY: PASS=${counts.PASS} FAIL=${counts.FAIL}`);
  console.log('========================================================================');
  if (counts.FAIL > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  cleanupProcs();
  restoreOemState();
  process.exit(1);
});
