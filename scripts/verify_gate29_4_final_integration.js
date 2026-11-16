#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 29.4
 * Final Integration, Clean Install, Upgrade Migration, Engine Recovery,
 * Live YouTube Resolutions (360p/720p/1080p/Audio + Playlist),
 * Cross-Browser Firefox v1.0.9 Parity, and Sustained Load Stability Suite.
 *
 * Strictly isolated under target/gate29_4_qa with custom TORI_DATA_DIR,
 * TORI_IPC_PIPE, WEBVIEW2_USER_DATA_FOLDER, and dedicated ports (19970..19977).
 * Snapshots & restores HKCU Uninstall, NativeMessagingHosts, Desktop/StartMenu
 * shortcuts, and idle OEM Desktop; never touches %APPDATA% production SQLite DB
 * or signed Firefox v1.0.7 XPI.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn, execSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RC_DIR = path.join(ROOT, 'release', 'v1.0.5-rc');
const INSTALLER_EXE = path.join(RC_DIR, 'TORI Download Manager_1.0.5_x64-setup.exe');
const INSTALLER_SIG = path.join(RC_DIR, 'TORI Download Manager_1.0.5_x64-setup.exe.sig');
const SHA256SUMS_PATH = path.join(RC_DIR, 'SHA256SUMS.txt');

const EXT_RC_DIR = path.join(ROOT, 'release', 'v1.0.9-extension-rc');
const CHR_EXT_DIR = path.join(EXT_RC_DIR, 'tori-companion-v1.0.9-chromium');
const FF_ZIP_PATH = path.join(EXT_RC_DIR, 'tori-companion-v1.0.9-firefox.zip');
const SIGNED_V107_XPI = path.join(ROOT, 'release', 'v1.0.7-extension-rc', 'a70ed17e183648a9bcf4-1.0.7.xpi');
const EXPECTED_V107_SHA256 = 'b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0';
const EXPECTED_GECKO_ID = 'tori-download-manager@toridm.org';

const OEM_DESKTOP_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'tori-download-manager.exe');
const OEM_HOST_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'bin', 'tdm-native-host.exe');
const OEM_DB_PATH = path.join(process.env.APPDATA || '', 'tori-download-manager', 'tdm_storage.sqlite');

const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const FFPROBE_EXE = path.join(ROOT, 'resources', 'bin', 'ffprobe.exe');

const QA_ROOT = path.join(ROOT, 'target', 'gate29_4_qa');
const QA_INST_DIR = path.join(QA_ROOT, 'clean_install');
const QA_CLEAN_DATA = path.join(QA_ROOT, 'clean_data');
const QA_CLEAN_DL = path.join(QA_ROOT, 'clean_downloads');
const QA_CLEAN_WV2 = path.join(QA_ROOT, 'clean_wv2');
const QA_CLEAN_PROF = path.join(QA_ROOT, 'clean_profile');

const QA_UPG_DATA = path.join(QA_ROOT, 'upgrade_data');
const QA_UPG_DL = path.join(QA_ROOT, 'upgrade_downloads');
const QA_UPG_WV2 = path.join(QA_ROOT, 'upgrade_wv2');
const QA_UPG_PROF = path.join(QA_ROOT, 'upgrade_profile');

const QA_ENG_DATA = path.join(QA_ROOT, 'engine_data');
const QA_ENG_DL = path.join(QA_ROOT, 'engine_downloads');
const QA_ENG_WV2 = path.join(QA_ROOT, 'engine_wv2');
const QA_ENG_PROF = path.join(QA_ROOT, 'engine_profile');

const QA_CHR_PROF = path.join(QA_ROOT, 'chrome_profile');
const QA_CHR_DL = path.join(QA_ROOT, 'chrome_browser_dl');
const QA_FF_PROF = path.join(QA_ROOT, 'firefox_profile');
const QA_FF_EXT_DIR = path.join(QA_ROOT, 'firefox_unpacked');
const QA_FF_DL = path.join(QA_ROOT, 'firefox_browser_dl');
const QA_BACKUP_DIR = path.join(QA_ROOT, 'oem_backup');

const CLEAN_PORT = 24970;
const CLEAN_CDP_PORT = 24971;
const UPG_PORT = 24972;
const UPG_CDP_PORT = 24973;
const ENG_PORT = 24974;
const ENG_CDP_PORT = 24975;
const FIXTURE_PORT = 24976;
const CHROME_CDP_PORT = 24977;
const FF_MARIONETTE_PORT = 2836;

const CLEAN_TOKEN = 'tori_qa_g29_4_clean_token';
const UPG_TOKEN = 'tori_upg_preserved_token_12345';
const ENG_TOKEN = 'tori_qa_g29_4_engine_token';

const WATCH_SINGLE_URL = 'https://www.youtube.com/watch?v=u9lj-c29dxI';
const WATCH_PLAYLIST_URL = 'https://www.youtube.com/watch?v=u9lj-c29dxI&list=PL6B3937A5D230E335&index=2';

const results = [];
const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, NOT_TESTED: 0 };
const trackedProcs = new Set();
const perfMetrics = {};
let oemWasRunning = false;
let hkcuUninstallExisted = false;
let fixtureServer = null;

function record(id, name, status, detail = '') {
  const norm = status === true ? 'PASS' : status === false ? 'FAIL' : status;
  counts[norm] = (counts[norm] || 0) + 1;
  console.log(`[${norm}] [${id}] ${name}${detail ? ' -> ' + detail : ''}`);
  results.push({ id, name, status: norm, detail });
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
    b[i] = ((i * 73 + (i >> 3) * 19) ^ 0x3b) & 0xff;
  }
  if (magicHex) {
    Buffer.from(magicHex, 'hex').copy(b, 0);
  }
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

function getTreeStats(rootPid) {
  try {
    const ps = `
      $root = Get-Process -Id ${rootPid} -ErrorAction SilentlyContinue
      if (-not $root) { Write-Output "0|0|0|0|0"; exit 0 }
      $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
      $children = @{}
      foreach ($p in $all) {
        $k = [int]$p.ParentProcessId
        if (-not $children.ContainsKey($k)) { $children[$k] = @() }
        $children[$k] += [int]$p.ProcessId
      }
      $pids = New-Object System.Collections.Generic.HashSet[int]
      $q = New-Object System.Collections.Generic.Queue[int]
      $q.Enqueue(${rootPid})
      while ($q.Count -gt 0) {
        $cur = $q.Dequeue()
        if ($pids.Add($cur) -and $children.ContainsKey($cur)) {
          foreach ($c in $children[$cur]) { $q.Enqueue($c) }
        }
      }
      $ws = 0L; $pm = 0L; $cpu = 0.0; $wv2 = 0; $cons = 0
      foreach ($p in $all) {
        if ($pids.Contains([int]$p.ProcessId)) {
          $nm = ([string]$p.Name).ToLowerInvariant()
          if ($nm -eq 'msedgewebview2.exe') { $wv2++ }
          if ($nm -in @('cmd.exe','powershell.exe','conhost.exe')) { $cons++ }
        }
      }
      foreach ($pidVal in $pids) {
        $pr = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
        if ($pr) {
          $ws += $pr.WorkingSet64
          $pm += $pr.PrivateMemorySize64
          if ($pr.CPU) { $cpu += [double]$pr.CPU }
        }
      }
      Write-Output "$($pids.Count)|$([math]::Round($ws/1MB,2))|$([math]::Round($pm/1MB,2))|$([math]::Round($cpu,3))|$wv2|$cons"
    `;
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 8000 }).trim();
    const parts = out.split('|');
    return {
      procs: parseInt(parts[0], 10) || 0,
      wsMb: parseFloat(parts[1]) || 0,
      privMb: parseFloat(parts[2]) || 0,
      cpuSec: parseFloat(parts[3]) || 0,
      webview2Count: parseInt(parts[4], 10) || 0,
      consoleCount: parseInt(parts[5], 10) || 0,
    };
  } catch {
    return { procs: 0, wsMb: 0, privMb: 0, cpuSec: 0, webview2Count: 0, consoleCount: 0 };
  }
}

function getShortcutTargets() {
  const candidates = [
    path.join(process.env.USERPROFILE || '', 'Desktop', 'TORI Download Manager.lnk'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TORI Download Manager', 'TORI Download Manager.lnk'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TORI Download Manager.lnk'),
  ];
  return candidates;
}

function backupOemState() {
  fs.mkdirSync(QA_BACKUP_DIR, { recursive: true });
  const uninstKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TORI Download Manager';
  const uninstReg = path.join(QA_BACKUP_DIR, 'uninstall.reg');
  try {
    execFileSync('reg', ['export', uninstKey, uninstReg, '/y'], { stdio: 'ignore', timeout: 4000 });
    hkcuUninstallExisted = true;
  } catch {
    hkcuUninstallExisted = false;
  }

  for (let i = 0; i < getShortcutTargets().length; i++) {
    const src = getShortcutTargets()[i];
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(QA_BACKUP_DIR, `lnk_${i}.lnk`));
    }
  }
}

function restoreOemState() {
  const uninstKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TORI Download Manager';
  const uninstReg = path.join(QA_BACKUP_DIR, 'uninstall.reg');
  try {
    if (hkcuUninstallExisted && fs.existsSync(uninstReg)) {
      execFileSync('reg', ['import', uninstReg], { stdio: 'ignore', timeout: 4000 });
    } else {
      execFileSync('reg', ['delete', uninstKey, '/f'], { stdio: 'ignore', timeout: 4000 });
    }
  } catch {}

  const sc = getShortcutTargets();
  for (let i = 0; i < sc.length; i++) {
    const bak = path.join(QA_BACKUP_DIR, `lnk_${i}.lnk`);
    try {
      if (fs.existsSync(bak)) {
        fs.mkdirSync(path.dirname(sc[i]), { recursive: true });
        fs.copyFileSync(bak, sc[i]);
      } else if (fs.existsSync(sc[i])) {
        // Remove shortcut created solely by QA silent install
        const target = execFileSync(
          'powershell',
          ['-NoProfile', '-Command', `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${sc[i].replace(/'/g, "''")}'); $s.TargetPath`],
          { encoding: 'utf8', timeout: 4000 }
        ).trim();
        if (target.toLowerCase().includes('gate29_4_qa')) {
          fs.unlinkSync(sc[i]);
        }
      }
    } catch {}
  }

  try {
    if (fs.existsSync(OEM_HOST_EXE)) {
      execFileSync(OEM_HOST_EXE, ['--register'], { stdio: 'ignore', timeout: 5000 });
    }
  } catch {}

  if (oemWasRunning && fs.existsSync(OEM_DESKTOP_EXE)) {
    try {
      const p = spawn(OEM_DESKTOP_EXE, ['--minimized'], { detached: true, stdio: 'ignore' });
      p.unref();
    } catch {}
    oemWasRunning = false;
  }
}

function registerQaNativeHosts({ hostExe, chromeExtIds, firefoxId }) {
  const chrManifest = path.join(QA_ROOT, 'nm_chromium.json');
  const ffManifest = path.join(QA_ROOT, 'nm_firefox.json');
  const origins = Array.from(new Set([
    ...chromeExtIds.map((id) => `chrome-extension://${id}/`),
    'chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm/',
    'chrome-extension://bflchfddfgkfglmjapohkjmldepflkbe/',
  ]));
  fs.writeFileSync(chrManifest, JSON.stringify({
    name: 'com.tori.download_manager',
    description: 'TORI QA Gate 29.4 Native Host',
    path: hostExe,
    type: 'stdio',
    allowed_origins: origins,
  }, null, 2));
  fs.writeFileSync(ffManifest, JSON.stringify({
    name: 'com.tori.download_manager',
    description: 'TORI QA Gate 29.4 Native Host (Firefox)',
    path: hostExe,
    type: 'stdio',
    allowed_extensions: [firefoxId],
  }, null, 2));

  execFileSync('reg', ['add', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', chrManifest, '/f'], { stdio: 'ignore', timeout: 4000 });
  execFileSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', chrManifest, '/f'], { stdio: 'ignore', timeout: 4000 });
  execFileSync('reg', ['add', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', ffManifest, '/f'], { stdio: 'ignore', timeout: 4000 });
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

function seedSqliteSettings(dbPath, { port, token, dlDir, theme = 'light', accent = 'indigo', maxa = 3 }) {
  const py = `
import sqlite3, json, sys
db_path, dl_dir, token, port, theme, accent, maxa = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5], sys.argv[6], int(sys.argv[7])
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
app_settings = {
  "dir": dl_dir, "sort": True, "con": 4, "maxa": maxa,
  "limMode": "off", "limV": 512, "limU": "KiB/s",
  "retries": 1, "dyn": True, "mps": 256, "mpsU": "KiB",
  "ua": "", "ssl": False, "lm": False, "track": True,
  "dns": "System DNS", "proxy": "none",
  "port": port, "key": token, "cap": True,
  "theme": theme, "accent": accent, "motion": False, "details": False,
  "showDownloadPopup": "never", "alwaysOnTop": False, "closeToTray": True
}
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("browser_integration_token", token))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("server_port", str(port)))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("app_settings", json.dumps(app_settings)))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("close_to_tray_migrated_v104", "true"))
conn.commit()
conn.close()
`;
  execFileSync('python', ['-c', py, dbPath, dlDir, token, String(port), theme, accent, String(maxa)], { stdio: 'pipe' });
}

function httpJson({ port, reqPath, method = 'GET', body = null, headers = {}, timeoutMs = 10000 }) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: {
          Host: `127.0.0.1:${port}`,
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
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, error: 'HTTP_TIMEOUT' }); });
    req.on('error', (e) => resolve({ status: 0, ok: false, error: e.message }));
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
  async connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`CDP connect timeout: ${this.wsUrl}`)); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(`CDP error (${this.wsUrl}): ${e.message || e.type || e}`)); });
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          }
        } catch {}
      });
    });
  }
  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalAsync(expr, timeoutMs = 15000, opts = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: !!opts.userGesture,
    }, timeoutMs);
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'CDP eval error');
    }
    return res?.result?.value;
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function waitForCdpTargets(port, timeoutMs = 15000, requireVersionWs = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (listRes.ok) {
        const targets = await listRes.json();
        if (Array.isArray(targets)) {
          if (!requireVersionWs) {
            const hasPage = targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (hasPage) return { version: null, targets };
          } else {
            const verRes = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (verRes.ok) {
              const version = await verRes.json();
              if (version.webSocketDebuggerUrl) return { version, targets };
            }
          }
        }
      }
    } catch {}
    await sleep(200);
  }
  throw new Error(`CDP not ready on port ${port}`);
}

async function waitForContext(cdp, expr = 'true', timeoutMs = 15000, label = 'ctx') {
  try { await cdp.send('Runtime.enable', {}, 4000); } catch {}
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const v = await cdp.evalAsync(expr, 4000);
      if (v) return true;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(220);
  }
  throw new Error(`waitForContext(${label}) timed out: ${lastErr}`);
}

class MarionetteClient {
  constructor(port = FF_MARIONETTE_PORT) {
    this.port = port;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return await this._connectOnce(Math.max(1000, deadline - Date.now()));
      } catch (e) {
        if (String(e.message || e.code).includes('ECONNREFUSED')) {
          await sleep(300);
          continue;
        }
        throw e;
      }
    }
    throw new Error(`Marionette connect timeout on ${this.port}`);
  }
  _connectOnce(timeoutMs) {
    return new Promise((resolve, reject) => {
      this.buf = Buffer.alloc(0);
      const sock = net.createConnection({ host: '127.0.0.1', port: this.port });
      this.socket = sock;
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; sock.destroy(); reject(new Error('Marionette timeout')); } }, timeoutMs);
      sock.on('error', (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
      sock.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        while (true) {
          const ci = this.buf.indexOf(0x3a);
          if (ci === -1) break;
          const len = parseInt(this.buf.subarray(0, ci).toString('ascii'), 10);
          if (Number.isNaN(len) || this.buf.length < ci + 1 + len) break;
          const payload = this.buf.subarray(ci + 1, ci + 1 + len).toString('utf8');
          this.buf = this.buf.subarray(ci + 1 + len);
          const msg = JSON.parse(payload);
          if (msg.marionetteProtocol) {
            if (!done) { done = true; clearTimeout(timer); resolve(msg); }
          } else if (Array.isArray(msg) && msg.length >= 4) {
            const [, id, err, res] = msg;
            if (this.pending.has(id)) {
              const p = this.pending.get(id);
              this.pending.delete(id);
              if (err) p.rej(new Error(JSON.stringify(err)));
              else p.res(res);
            }
          }
        }
      });
    });
  }
  send(cmd, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Marionette ${cmd} timed out`)); }, timeoutMs);
      this.pending.set(id, {
        res: (v) => { clearTimeout(timer); resolve(v); },
        rej: (e) => { clearTimeout(timer); reject(e); },
      });
      const frame = JSON.stringify([0, id, cmd, params]);
      this.socket.write(`${Buffer.byteLength(frame, 'utf8')}:${frame}`, 'utf8');
    });
  }
  close() { try { this.socket?.destroy(); } catch {} }
}

async function bootDesktop({ exe, dataDir, wv2Dir, dlDir, userProfDir, port, cdpPort, token }) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(wv2Dir, { recursive: true });
  fs.mkdirSync(dlDir, { recursive: true });
  fs.mkdirSync(userProfDir, { recursive: true });
  for (const pid of getRunningToriPids()) {
    killProcTree(pid);
  }
  await sleep(300);
  const env = {
    ...process.env,
    TORI_DATA_DIR: dataDir,
    TORI_IPC_PIPE: `\\\\.\\pipe\\tori-qa-g294-${port}-${process.pid}-${Date.now()}`,
    TORI_DISABLE_AUTO_SPAWN: '1',
    TORI_ALLOW_LOOPBACK: '1',
    TDM_STORAGE_DIR: dataDir,
    TDM_DOWNLOAD_DIR: dlDir,
    WEBVIEW2_USER_DATA_FOLDER: wv2Dir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    RUST_MIN_STACK: '8388608',
  };
  const proc = spawn(exe, [], { env, stdio: 'ignore' });
  trackedProcs.add(proc);

  let pingOk = false;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const ping = await httpJson({ port, reqPath: '/api/v1/ping', headers: token ? { 'X-Tori-Token': token } : {} });
    if (ping.ok && ping.data?.status === 'ok') {
      pingOk = true;
      break;
    }
  }
  const cdpInfo = await waitForCdpTargets(cdpPort, 25000, false);
  const mainTgt = cdpInfo.targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url).includes('toast')) || cdpInfo.targets.find((t) => t.webSocketDebuggerUrl);
  const mainCdp = new CDPClient(mainTgt.webSocketDebuggerUrl);
  await mainCdp.connect(8000);
  await waitForContext(mainCdp, `Boolean(window.__TAURI_INTERNALS__?.invoke && document.getElementById('root')?.childElementCount > 0)`, 15000, 'desktop-ui-ready');
  return { proc, pingOk, mainCdp, env };
}

async function waitForJob(port, token, pred, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await httpJson({ port, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': token } });
    const jobs = Array.isArray(res.data?.jobs) ? res.data.jobs : [];
    const hit = jobs.find(pred);
    if (hit) {
      const det = await httpJson({ port, reqPath: `/api/v1/downloads/${encodeURIComponent(hit.id)}`, headers: { 'X-Tori-Token': token } });
      return det.ok && det.data ? det.data : hit;
    }
    await sleep(300);
  }
  return null;
}

async function runFfprobe(filePath) {
  const out = execFileSync(FFPROBE_EXE, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height', '-of', 'json', filePath], { encoding: 'utf8', timeout: 15000 });
  return JSON.parse(out);
}

async function main() {
  console.log('========================================================================');
  console.log('  TORI GATE 29.4 — FINAL INTEGRATION & RELEASE READINESS VERIFICATION');
  console.log('========================================================================\n');

  const initialOemPids = getRunningToriPids();
  const initialOemDbHash = sha256File(OEM_DB_PATH);
  const initialXpiHash = sha256File(SIGNED_V107_XPI);

  record('G294-PRE-01', 'Signed Firefox v1.0.7 XPI preserved untouched', initialXpiHash === EXPECTED_V107_SHA256, `sha256=${initialXpiHash}`);

  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(QA_ROOT, { recursive: true });
  fs.mkdirSync(QA_CHR_DL, { recursive: true });
  fs.mkdirSync(QA_FF_DL, { recursive: true });
  backupOemState();
  // Silence OEM native messaging auto-spawn from user's live browsers before stopping idle OEM Desktop
  temporarilySilenceNativeHostAutoSpawn();

  if (initialOemPids.length > 0) {
    let activeCount = 0;
    try {
      const st = await httpJson({ port: 6800, reqPath: '/api/v1/downloads' });
      if (st.ok && Array.isArray(st.data?.jobs)) {
        activeCount = st.data.jobs.filter((j) => ['downloading', 'probing', 'verifying'].includes(String(j.state).toLowerCase())).length;
      }
    } catch {}
    if (activeCount > 0) {
      throw new Error(`OEM TORI Desktop has ${activeCount} active downloads — refusing to pause`);
    }
    oemWasRunning = true;
    for (const pid of initialOemPids) killProcTree(pid);
    await sleep(600);
  }
  for (const stray of getRunningToriPids()) killProcTree(stray);

  // Prepare deterministic fixture buffers
  const bufZip2m = makePatternBuffer(2 * 1024 * 1024, '504b0304');
  const bufUpg4m = makePatternBuffer(4 * 1024 * 1024, '1a45dfa3');
  const bufUnk1m = makePatternBuffer(1536 * 1024, '0011223344556677');
  const bufTransient2m = makePatternBuffer(2 * 1024 * 1024, '504b0304');
  const bufCrash8m = makePatternBuffer(16 * 1024 * 1024, '1a45dfa3');
  const bufConc3m = makePatternBuffer(3 * 1024 * 1024, 'deadbeef');
  const bufLim1m = makePatternBuffer(1200 * 1024, 'cafebabe');
  const bufFfMkv6m = makePatternBuffer(6 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');
  const bufStab16m = makePatternBuffer(16 * 1024 * 1024, '504b0304');

  const sha = {
    zip2m: crypto.createHash('sha256').update(bufZip2m).digest('hex'),
    upg4m: crypto.createHash('sha256').update(bufUpg4m).digest('hex'),
    unk1m: crypto.createHash('sha256').update(bufUnk1m).digest('hex'),
    transient2m: crypto.createHash('sha256').update(bufTransient2m).digest('hex'),
    crash8m: crypto.createHash('sha256').update(bufCrash8m).digest('hex'),
    conc3m: crypto.createHash('sha256').update(bufConc3m).digest('hex'),
    lim1m: crypto.createHash('sha256').update(bufLim1m).digest('hex'),
    ffMkv6m: crypto.createHash('sha256').update(bufFfMkv6m).digest('hex'),
    stab16m: crypto.createHash('sha256').update(bufStab16m).digest('hex'),
  };

  let transient500Left = 4;
  let upgResumeRangeSeen = [];
  let concConcurrentPeak = 0;
  const activeConcPaths = new Set();

  fixtureServer = http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${FIXTURE_PORT}`);
    if (u.pathname === '/ff_page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1>Firefox v1.0.9 QA</h1><a id="dl-ff-mkv" href="/ff_v109_cd_mkv">Download MKV</a></body></html>');
      return;
    }
    if (u.pathname === '/missing_404.zip') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    if (u.pathname === '/transfer_404.zip') {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': '1048576', 'Accept-Ranges': 'bytes', 'Content-Type': 'application/zip' });
        res.end();
        return;
      }
      if (req.headers.range === 'bytes=0-0') {
        res.writeHead(206, { 'Content-Range': 'bytes 0-0/1048576', 'Content-Length': '1', 'Accept-Ranges': 'bytes', 'Content-Type': 'application/zip' });
        res.end(Buffer.from([0x50]));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Simulated transfer 404');
      return;
    }
    if (u.pathname === '/transient_500.zip') {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': String(bufTransient2m.length), 'Accept-Ranges': 'bytes', 'Content-Type': 'application/zip' });
        res.end();
        return;
      }
      if (req.headers.range === 'bytes=0-0') {
        res.writeHead(206, { 'Content-Range': `bytes 0-0/${bufTransient2m.length}`, 'Content-Length': '1', 'Accept-Ranges': 'bytes', 'Content-Type': 'application/zip' });
        res.end(bufTransient2m.subarray(0, 1));
        return;
      }
      if (transient500Left > 0) {
        transient500Left--;
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Simulated HTTP 500 error');
        return;
      }
      return rangeServeInline();
      function rangeServeInline() {
        const total = bufTransient2m.length;
        let start = 0; let end = total - 1; let status = 200;
        const r = req.headers.range;
        if (r && r.startsWith('bytes=')) {
          const [s, e] = r.slice(6).split('-');
          start = parseInt(s, 10) || 0;
          end = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
          status = 206;
        }
        res.writeHead(status, {
          'Content-Type': 'application/zip', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes',
          ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
        });
        res.end(bufTransient2m.subarray(start, end + 1));
      }
    }
    if (u.pathname === '/unknown_stream.bin') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const mid = Math.floor(bufUnk1m.length / 2);
      res.write(bufUnk1m.subarray(0, mid));
      setTimeout(() => res.end(bufUnk1m.subarray(mid)), 60);
      return;
    }

    const rangeServe = (buf, ctype, { throttleMs = 0, step = 131072, trackRangeArr = null, trackConc = false, extra = {} } = {}) => {
      const total = buf.length;
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': String(total), 'Accept-Ranges': 'bytes', ETag: '"g294-etag"', ...extra });
        res.end();
        return;
      }
      let start = 0;
      let end = total - 1;
      let status = 200;
      const range = req.headers.range;
      if (range && range.startsWith('bytes=')) {
        const [s, e] = range.slice(6).split('-');
        start = parseInt(s, 10) || 0;
        end = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
        status = 206;
      }
      if (trackRangeArr) trackRangeArr.push({ start, end, method: req.method });
      res.writeHead(status, {
        'Content-Type': ctype,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        ETag: '"g294-etag"',
        ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
        ...extra,
      });

      const isConcTransfer = trackConc && req.headers.range !== 'bytes=0-0';
      if (isConcTransfer) {
        activeConcPaths.add(u.pathname);
        if (activeConcPaths.size > concConcurrentPeak) concConcurrentPeak = activeConcPaths.size;
      }

      const slice = buf.subarray(start, end + 1);
      if (throttleMs <= 0) {
        res.end(slice, () => { if (isConcTransfer) activeConcPaths.delete(u.pathname); });
        return;
      }
      let pos = 0;
      let closed = false;
      res.on('close', () => { closed = true; if (isConcTransfer) activeConcPaths.delete(u.pathname); });
      const next = () => {
        if (closed) return;
        if (pos >= slice.length) {
          res.end(() => { if (isConcTransfer) activeConcPaths.delete(u.pathname); });
          return;
        }
        const chunk = slice.subarray(pos, Math.min(pos + step, slice.length));
        pos += chunk.length;
        res.write(chunk);
        setTimeout(next, throttleMs);
      };
      next();
    };

    if (u.pathname === '/archive_test.zip') return rangeServe(bufZip2m, 'application/zip');
    if (u.pathname === '/upg_resume.bin') return rangeServe(bufUpg4m, 'application/octet-stream', { throttleMs: 20, trackRangeArr: upgResumeRangeSeen });
    if (u.pathname === '/crash_recovery.bin') return rangeServe(bufCrash8m, 'application/octet-stream', { throttleMs: 90, step: 65536 });
    if (u.pathname.startsWith('/conc_')) return rangeServe(bufConc3m, 'application/octet-stream', { throttleMs: 110, step: 65536, trackConc: true });
    if (u.pathname === '/lim_combined.bin') return rangeServe(bufLim1m, 'application/octet-stream');
    if (u.pathname === '/ff_v109_cd_mkv') return rangeServe(bufFfMkv6m, 'application/octet-stream', { extra: { 'Content-Disposition': 'attachment; filename="Firefox_v109_Acceptance.mkv"' } });
    if (u.pathname.startsWith('/stab_')) return rangeServe(bufStab16m, 'application/octet-stream');
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', r));

  try {
    // =====================================================================
    // PHASE 2: CLEAN INSTALLATION VERIFICATION
    // =====================================================================
    console.log('\n>>> [PHASE 2] Isolated NSIS Silent Install & Fresh Boot <<<');
    const installerExists = fs.existsSync(INSTALLER_EXE) && fs.existsSync(INSTALLER_SIG);
    execSync(`"${INSTALLER_EXE}" /S /D=${QA_INST_DIR}`, { timeout: 90000 });
    // Verify NSIS postinstall hook registered NativeMessagingHosts, then shield from host browser auto-spawn
    const chrRegVal = execFileSync('reg', ['query', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager', '/ve'], { encoding: 'utf8', timeout: 4000 });
    temporarilySilenceNativeHostAutoSpawn();
    for (const stray of getRunningToriPids()) killProcTree(stray);

    const instDesktop = path.join(QA_INST_DIR, 'tori-download-manager.exe');
    const hostCandidates = [
      path.join(QA_INST_DIR, 'tdm-native-host.exe'),
      path.join(QA_INST_DIR, 'bin', 'tdm-native-host.exe'),
      path.join(QA_INST_DIR, 'resources', 'bin', 'tdm-native-host.exe'),
    ];
    const instHost = hostCandidates.find((p) => fs.existsSync(p));
    const rcSums = fs.readFileSync(SHA256SUMS_PATH, 'utf8');
    const rcDeskHash = sha256File(path.join(RC_DIR, 'tori-download-manager.exe'));
    const instBinsMatch = ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe', 'tdm-cli.exe', 'tdm-native-host.exe'].every((b) => {
      const pInst = path.join(QA_INST_DIR, 'bin', b);
      const pSrc = path.join(ROOT, 'resources', 'bin', b);
      return fs.existsSync(pInst) && fs.existsSync(pSrc) && sha256File(pInst) === sha256File(pSrc);
    });
    const instPeVer = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Item '${instDesktop.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    const rcSumsOk = ['tori-download-manager.exe', 'tdm-native-host.exe', 'tdm-cli.exe', 'TORI Download Manager_1.0.5_x64-setup.exe', 'TORI Download Manager_1.0.5_x64-setup.exe.sig'].every((f) => {
      const h = sha256File(path.join(RC_DIR, f));
      return h && rcSums.includes(h);
    });
    record(
      'G294-INST-01',
      'Clean NSIS silent install deploys verified v1.0.5 binaries & signed updater artifact cleanly',
      Boolean(installerExists && instHost && fs.existsSync(path.join(QA_INST_DIR, 'uninstall.exe')) && instPeVer.startsWith('1.0.5') && instBinsMatch && rcSumsOk && rcDeskHash && chrRegVal.includes('com.tori.download_manager.json')),
      `peVer=${instPeVer}, instBinsMatch=${instBinsMatch}, rcSumsOk=${rcSumsOk}, nmReg=${chrRegVal.includes('com.tori.download_manager.json')}, host=${instHost || 'none'}`
    );

    const cleanBoot = await bootDesktop({
      exe: instDesktop,
      dataDir: QA_CLEAN_DATA,
      wv2Dir: QA_CLEAN_WV2,
      dlDir: QA_CLEAN_DL,
      userProfDir: QA_CLEAN_PROF,
      port: 6800,
      cdpPort: CLEAN_CDP_PORT,
      token: null,
    });
    const cleanStats = getTreeStats(cleanBoot.proc.pid);
    const uiCleanDiag = await cleanBoot.mainCdp.evalAsync(`(async () => {
      const ver = await window.__TAURI_INTERNALS__.invoke('get_app_version');
      const bg = getComputedStyle(document.body).backgroundColor;
      const titleText = document.querySelector('.wtitle, .title')?.textContent || '';
      return { ver, bg, titleText, rootKids: document.getElementById('root')?.childElementCount || 0 };
    })()`);
    const schemaCheck = execFileSync(
      'python',
      ['-c', `import sqlite3, json; c=sqlite3.connect(r'${path.join(QA_CLEAN_DATA, 'tdm_storage.sqlite').replace(/\\/g, '\\\\')}'); t=[r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]; print(json.dumps(t))`],
      { encoding: 'utf8' }
    ).trim();
    const tables = JSON.parse(schemaCheck);
    record(
      'G294-INST-02',
      'Installed v1.0.5 initializes SQLite cleanly, renders v1.0.5 UI with zero console windows',
      Boolean(cleanBoot.pingOk && uiCleanDiag.ver === '1.0.5' && cleanStats.consoleCount === 0 && ['downloads', 'download_chunks', 'engine_settings', 'format_metadata_cache'].every((t) => tables.includes(t))),
      JSON.stringify({ ...uiCleanDiag, consoleCount: cleanStats.consoleCount, tables })
    );

    // Tray hide + show + explicit clean exit
    await cleanBoot.mainCdp.evalAsync(`window.__TAURI_INTERNALS__.invoke('hide_main_window')`, 5000);
    await sleep(300);
    await cleanBoot.mainCdp.evalAsync(`window.__TAURI_INTERNALS__.invoke('show_main_window')`, 5000);
    await sleep(250);
    const exitWaitPromise = cleanBoot.proc.exitCode !== null
      ? Promise.resolve(true)
      : new Promise((resolve) => {
          const t = setTimeout(() => resolve(false), 6000);
          cleanBoot.proc.once('exit', () => { clearTimeout(t); resolve(true); });
        });
    await cleanBoot.mainCdp.evalAsync(`window.__TAURI_INTERNALS__.invoke('exit_app')`, 5000).catch(() => {});
    cleanBoot.mainCdp.close();
    const exitedCleanly = await exitWaitPromise;
    if (!exitedCleanly) killProcTree(cleanBoot.proc.pid);
    trackedProcs.delete(cleanBoot.proc);
    record('G294-INST-03', 'Installed Desktop tray hide/restore and clean explicit exit succeed without orphan hangs', exitedCleanly, `exitedCleanly=${exitedCleanly}`);

    // =====================================================================
    // PHASE 3: UPGRADE & DATA PRESERVATION MIGRATION
    // =====================================================================
    console.log('\n>>> [PHASE 3] Pre-v1.0.5 DB Schema Upgrade & Partial Download Resume <<<');
    fs.mkdirSync(QA_UPG_DATA, { recursive: true });
    fs.mkdirSync(path.join(QA_UPG_DL, 'Other'), { recursive: true });
    const legacyHistFile = path.join(QA_UPG_DL, 'Other', 'legacy_history.bin');
    fs.writeFileSync(legacyHistFile, Buffer.from('LEGACY_COMPLETED_HISTORY_DATA'));
    const upgPausedTarget = path.join(QA_UPG_DL, 'Other', 'upg_resume.bin');
    const upgPausedPart = path.join(QA_UPG_DL, 'Other', 'upg_resume.bin.tdm-part');
    const partialBytes = 1048576; // 1 MiB of 4 MiB already on disk
    const partFh = fs.openSync(upgPausedPart, 'w');
    fs.ftruncateSync(partFh, bufUpg4m.length);
    fs.writeSync(partFh, bufUpg4m.subarray(0, partialBytes), 0, partialBytes, 0);
    fs.closeSync(partFh);

    const upgDbPath = path.join(QA_UPG_DATA, 'tdm_storage.sqlite');
    const seedUpgPy = `
import sqlite3, json, sys
db_path, dl_dir, token, port, hist_file, tgt, tmp, fix_port = sys.argv[1:]
conn = sqlite3.connect(db_path)
c = conn.cursor()
# Older v1.0.3-style schema omitting priority, thumbnail_url, referer, user_agent, scheduled_at
c.execute("""CREATE TABLE downloads (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, resolved_url TEXT,
  filename TEXT NOT NULL, target_path TEXT NOT NULL, temp_path TEXT NOT NULL,
  total_bytes INTEGER, downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL, job_type TEXT NOT NULL DEFAULT 'http_file',
  etag TEXT, last_modified TEXT, is_resumable INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 1, error_message TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)""")
c.execute("""CREATE TABLE download_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  download_id TEXT NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL, start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL,
  written_bytes INTEGER NOT NULL DEFAULT 0, is_complete INTEGER NOT NULL DEFAULT 0,
  UNIQUE(download_id, chunk_index)
)""")
c.execute("CREATE TABLE engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
app_settings = {
  "dir": dl_dir, "sort": True, "con": 4, "maxa": 3, "port": int(port), "key": token,
  "theme": "dark", "accent": "ocean", "cap": True, "closeToTray": True, "showDownloadPopup": "never"
}
c.execute("INSERT INTO engine_settings VALUES ('app_settings', ?)", (json.dumps(app_settings),))
c.execute("INSERT INTO engine_settings VALUES ('browser_integration_token', ?)", (token,))
c.execute("INSERT INTO engine_settings VALUES ('server_port', ?)", (str(port),))
now = "2026-10-01T12:00:00Z"
c.execute("INSERT INTO downloads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ("legacy-done-1", "http://127.0.0.1/legacy_history.bin", None, "legacy_history.bin", hist_file, hist_file+".tdm-part",
   29, 29, "completed", "http_file", None, None, 1, 1, None, now, now))
c.execute("INSERT INTO downloads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ("legacy-paused-2", f"http://127.0.0.1:{fix_port}/upg_resume.bin", None, "upg_resume.bin", tgt, tmp,
   4194304, 1048576, "paused", "http_file", '"g294-etag"', None, 1, 2, None, now, now))
c.execute("INSERT INTO download_chunks (download_id, chunk_index, start_byte, end_byte, written_bytes, is_complete) VALUES (?,?,?,?,?,?)",
  ("legacy-paused-2", 0, 0, 2097151, 1048576, 0))
c.execute("INSERT INTO download_chunks (download_id, chunk_index, start_byte, end_byte, written_bytes, is_complete) VALUES (?,?,?,?,?,?)",
  ("legacy-paused-2", 1, 2097152, 4194303, 0, 0))
conn.commit()
conn.close()
`;
    execFileSync('python', ['-c', seedUpgPy, upgDbPath, QA_UPG_DL, UPG_TOKEN, String(UPG_PORT), legacyHistFile, upgPausedTarget, upgPausedPart, String(FIXTURE_PORT)], { stdio: 'pipe' });

    const upgBoot = await bootDesktop({
      exe: instDesktop,
      dataDir: QA_UPG_DATA,
      wv2Dir: QA_UPG_WV2,
      dlDir: QA_UPG_DL,
      userProfDir: QA_UPG_PROF,
      port: UPG_PORT,
      cdpPort: UPG_CDP_PORT,
      token: UPG_TOKEN,
    });

    const colsJson = execFileSync(
      'python',
      ['-c', `import sqlite3, json; c=sqlite3.connect(r'${upgDbPath.replace(/\\/g, '\\\\')}'); cols=[r[1] for r in c.execute("PRAGMA table_info(downloads)").fetchall()]; print(json.dumps(cols))`],
      { encoding: 'utf8' }
    ).trim();
    const cols = JSON.parse(colsJson);
    const upgUiTheme = await upgBoot.mainCdp.evalAsync(`({ theme: document.documentElement.dataset.theme, accent: document.documentElement.dataset.accent })`);
    const preJobs = (await httpJson({ port: UPG_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': UPG_TOKEN } })).data?.jobs || [];
    const preDone = preJobs.find((j) => j.id === 'legacy-done-1');
    const prePaused = preJobs.find((j) => j.id === 'legacy-paused-2');
    const schemaMigrated = ['priority', 'thumbnail_url', 'referer', 'user_agent', 'scheduled_at'].every((c) => cols.includes(c));
    record(
      'G294-UPG-01',
      'Pre-v1.0.5 SQLite schema migrates seamlessly while preserving token, dark/ocean settings, history & paused progress',
      Boolean(upgBoot.pingOk && schemaMigrated && upgUiTheme.theme === 'dark' && preDone?.state === 'completed' && prePaused?.state === 'paused' && prePaused?.downloaded_bytes === partialBytes),
      JSON.stringify({ schemaMigrated, upgUiTheme, preDoneState: preDone?.state, prePausedBytes: prePaused?.downloaded_bytes })
    );

    const resPost = await httpJson({ port: UPG_PORT, reqPath: '/api/v1/downloads/legacy-paused-2/resume', method: 'POST', headers: { 'X-Tori-Token': UPG_TOKEN } });
    const postResumed = await waitForJob(UPG_PORT, UPG_TOKEN, (j) => j.id === 'legacy-paused-2' && j.state === 'completed', 30000);
    const upgRangeUsed = upgResumeRangeSeen.some((r) => r.start >= partialBytes);
    const upgShaOk = postResumed && sha256File(postResumed.target_path) === sha.upg4m;
    record(
      'G294-UPG-02',
      'Upgraded v1.0.5 resumes pre-existing .tdm-part via HTTP Range without losing prior bytes & matches exact SHA-256',
      Boolean(resPost.ok && postResumed?.state === 'completed' && upgRangeUsed && upgShaOk),
      JSON.stringify({ state: postResumed?.state, rangeReqs: upgResumeRangeSeen, shaMatch: upgShaOk })
    );

    upgBoot.mainCdp.close();
    killProcTree(upgBoot.proc.pid);
    trackedProcs.delete(upgBoot.proc);
    await sleep(400);

    // =====================================================================
    // PHASE 4: ENGINE EXTENDED REGRESSION & RECOVERY
    // =====================================================================
    console.log('\n>>> [PHASE 4] Engine Regression, Crash Recovery, Concurrency & Combined Speed Limits <<<');
    fs.mkdirSync(QA_ENG_DATA, { recursive: true });
    seedSqliteSettings(path.join(QA_ENG_DATA, 'tdm_storage.sqlite'), { port: ENG_PORT, token: ENG_TOKEN, dlDir: QA_ENG_DL, theme: 'light', accent: 'indigo', maxa: 3 });

    let engBoot = await bootDesktop({
      exe: instDesktop,
      dataDir: QA_ENG_DATA,
      wv2Dir: QA_ENG_WV2,
      dlDir: QA_ENG_DL,
      userProfDir: QA_ENG_PROF,
      port: ENG_PORT,
      cdpPort: ENG_CDP_PORT,
      token: ENG_TOKEN,
    });

    // Unauthorized & Invalid URL & HTTP 404 checks (both probe-time rejection & transfer-time 404 failure)
    const unauthResp = await httpJson({ port: ENG_PORT, reqPath: '/api/v1/downloads', method: 'POST', body: { url: `http://127.0.0.1:${FIXTURE_PORT}/archive_test.zip` } });
    const badProtoResp = await httpJson({ port: ENG_PORT, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': ENG_TOKEN }, body: { url: 'javascript:alert(1)' } });
    const notFoundProbe = await httpJson({ port: ENG_PORT, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': ENG_TOKEN }, body: { url: `http://127.0.0.1:${FIXTURE_PORT}/missing_404.zip`, filename: 'missing_404.zip' } });
    const transfer404Create = await httpJson({ port: ENG_PORT, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': ENG_TOKEN }, body: { url: `http://127.0.0.1:${FIXTURE_PORT}/transfer_404.zip`, filename: 'transfer_404.zip' } });
    const transfer404Job = transfer404Create.data?.job_id ? await waitForJob(ENG_PORT, ENG_TOKEN, (j) => j.id === transfer404Create.data.job_id && j.state === 'failed', 15000) : null;
    record(
      'G294-ENG-ERR',
      'Engine rejects unauthenticated/invalid/404-probe URLs cleanly and transitions transfer HTTP 404 to failed state with error message',
      Boolean(unauthResp.status === 401 && badProtoResp.status === 400 && !notFoundProbe.ok && notFoundProbe.status >= 400 && transfer404Job?.state === 'failed' && transfer404Job?.error_message),
      JSON.stringify({ unauth: unauthResp.status, badProto: badProtoResp.status, probe404: notFoundProbe.status, state404: transfer404Job?.state, err404: transfer404Job?.error_message })
    );

    // Direct ZIP -> Compressed/, Unknown size chunked -> Other/, Transient HTTP 500 -> Retry -> Completed
    const zipCreate = await httpJson({ port: ENG_PORT, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': ENG_TOKEN }, body: { url: `http://127.0.0.1:${FIXTURE_PORT}/archive_test.zip`, filename: 'archive_test.zip' } });
    const unkCreate = await httpJson({ port: ENG_PORT, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': ENG_TOKEN }, body: { url: `http://127.0.0.1:${FIXTURE_PORT}/unknown_stream.bin`, filename: 'unknown_stream.bin' } });
    const trCreate = await httpJson({ port: ENG_PORT, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': ENG_TOKEN }, body: { url: `http://127.0.0.1:${FIXTURE_PORT}/transient_500.zip`, filename: 'transient_retry.zip' } });
    const zipJob = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => j.id === zipCreate.data?.job_id && j.state === 'completed', 20000);
    const unkJob = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => j.id === unkCreate.data?.job_id && j.state === 'completed', 20000);
    const trInitial = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => j.id === trCreate.data?.job_id && (j.state === 'failed' || j.state === 'completed'), 25000);
    let trFinal = trInitial;
    if (trInitial?.state === 'failed') {
      transient500Left = 0;
      await httpJson({ port: ENG_PORT, reqPath: `/api/v1/downloads/${trInitial.id}/retry`, method: 'POST', headers: { 'X-Tori-Token': ENG_TOKEN } });
      trFinal = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => j.id === trInitial.id && j.state === 'completed', 20000);
    }
    record(
      'G294-ENG-HTTP',
      'ZIP->Compressed, unknown-size chunked stream->Other, and HTTP 500 retry recover to exact SHA-256',
      Boolean(
        zipJob?.state === 'completed' && String(zipJob.target_path).toLowerCase().includes('compressed') && sha256File(zipJob.target_path) === sha.zip2m &&
        unkJob?.state === 'completed' && sha256File(unkJob.target_path) === sha.unk1m &&
        trFinal?.state === 'completed' && sha256File(trFinal.target_path) === sha.transient2m
      ),
      JSON.stringify({ zipOk: sha256File(zipJob?.target_path) === sha.zip2m, unkOk: sha256File(unkJob?.target_path) === sha.unk1m, trInitialState: trInitial?.state, trOk: sha256File(trFinal?.target_path) === sha.transient2m })
    );

    // Mid-transfer process kill crash recovery
    const crashCreate = await httpJson({ port: ENG_PORT, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': ENG_TOKEN }, body: { url: `http://127.0.0.1:${FIXTURE_PORT}/crash_recovery.bin`, filename: 'crash_recovery.bin' } });
    const crashId = crashCreate.data?.job_id;
    let crashMidBytes = 0;
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      const det = await httpJson({ port: ENG_PORT, reqPath: `/api/v1/downloads/${crashId}`, headers: { 'X-Tori-Token': ENG_TOKEN } });
      if (det.ok && det.data?.downloaded_bytes >= 1200000 && det.data?.downloaded_bytes < bufCrash8m.length && det.data?.state === 'downloading') {
        crashMidBytes = det.data.downloaded_bytes;
        break;
      }
    }
    engBoot.mainCdp.close();
    killProcTree(engBoot.proc.pid);
    trackedProcs.delete(engBoot.proc);
    await sleep(600);
    const partExistsAfterCrash = fs.existsSync(path.join(QA_ENG_DL, 'Other', 'crash_recovery.bin.tdm-part'));

    engBoot = await bootDesktop({
      exe: instDesktop,
      dataDir: QA_ENG_DATA,
      wv2Dir: QA_ENG_WV2,
      dlDir: QA_ENG_DL,
      userProfDir: QA_ENG_PROF,
      port: ENG_PORT,
      cdpPort: ENG_CDP_PORT,
      token: ENG_TOKEN,
    });
    const reconciled = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => j.id === crashId, 10000);
    await httpJson({ port: ENG_PORT, reqPath: `/api/v1/downloads/${crashId}/resume`, method: 'POST', headers: { 'X-Tori-Token': ENG_TOKEN } });
    const crashDone = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => j.id === crashId && j.state === 'completed', 45000);
    record(
      'G294-ENG-CRASH',
      'Unexpected process kill preserves .tdm-part, reconciles to Paused on restart & resumes to exact SHA-256',
      Boolean(crashMidBytes >= 1200000 && partExistsAfterCrash && reconciled?.state === 'paused' && reconciled?.downloaded_bytes > 0 && crashDone?.state === 'completed' && sha256File(crashDone.target_path) === sha.crash8m),
      JSON.stringify({ crashMidBytes, partExistsAfterCrash, reconciledState: reconciled?.state, reconciledBytes: reconciled?.downloaded_bytes, shaMatch: sha256File(crashDone?.target_path) === sha.crash8m })
    );

    // Concurrency queue cap, cancel, delete-from-disk
    const concIds = [];
    for (let k = 1; k <= 4; k++) {
      const r = await httpJson({ port: ENG_PORT, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': ENG_TOKEN }, body: { url: `http://127.0.0.1:${FIXTURE_PORT}/conc_${k}.bin`, filename: `conc_${k}.bin` } });
      concIds.push(r.data?.job_id);
    }
    await sleep(500);
    await httpJson({ port: ENG_PORT, reqPath: `/api/v1/downloads/${concIds[3]}/cancel`, method: 'POST', headers: { 'X-Tori-Token': ENG_TOKEN } });
    const j1Done = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => j.id === concIds[0] && j.state === 'completed', 40000);
    const j2Done = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => j.id === concIds[1] && j.state === 'completed', 40000);
    const j3Done = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => j.id === concIds[2] && j.state === 'completed', 40000);
    const j4Cancelled = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => j.id === concIds[3] && j.state === 'cancelled', 10000);
    const j3Path = j3Done?.target_path;
    await engBoot.mainCdp.evalAsync(`window.__TAURI_INTERNALS__.invoke('delete_download', { id: '${concIds[2]}', deleteFiles: true })`, 6000);
    await sleep(300);
    record(
      'G294-ENG-CONC',
      '4-job concurrent queue enforces maxActive<=3, completes, cancels & deletes file from disk with SHA-256 verification',
      Boolean(concConcurrentPeak <= 3 && j1Done && j2Done && sha256File(j1Done.target_path) === sha.conc3m && sha256File(j2Done.target_path) === sha.conc3m && j4Cancelled?.state === 'cancelled' && j3Path && !fs.existsSync(j3Path)),
      JSON.stringify({ peakConcurrentJobs: concConcurrentPeak, j1: j1Done?.state, j2: j2Done?.state, j4: j4Cancelled?.state, j3Deleted: Boolean(j3Path && !fs.existsSync(j3Path)) })
    );

    // Combined global + per-job speed limiting
    await engBoot.mainCdp.evalAsync(`(async () => {
      const s = await window.__TAURI_INTERNALS__.invoke('get_engine_settings') || {};
      s.limMode = 'on'; s.limV = 400; s.limU = 'KiB/s';
      await window.__TAURI_INTERNALS__.invoke('update_engine_settings', { settings: s });
    })()`, 8000);
    const tLim0 = Date.now();
    const limCreate = await httpJson({ port: ENG_PORT, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': ENG_TOKEN }, body: { url: `http://127.0.0.1:${FIXTURE_PORT}/lim_combined.bin`, filename: 'lim_combined.bin' } });
    const limId = limCreate.data?.job_id;
    await engBoot.mainCdp.evalAsync(`window.__TAURI_INTERNALS__.invoke('set_download_speed_limit', { id: '${limId}', limitBps: 204800 })`, 5000);
    const limDone = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => j.id === limId && j.state === 'completed', 30000);
    const limElapsedMs = Date.now() - tLim0;
    await engBoot.mainCdp.evalAsync(`(async () => {
      const s = await window.__TAURI_INTERNALS__.invoke('get_engine_settings') || {};
      s.limMode = 'off';
      await window.__TAURI_INTERNALS__.invoke('update_engine_settings', { settings: s });
    })()`, 8000);
    record(
      'G294-ENG-LIM',
      'Combined global + per-download speed limits throttle without deadlock and complete with exact SHA-256',
      Boolean(limDone?.state === 'completed' && sha256File(limDone.target_path) === sha.lim1m && limElapsedMs >= 2500),
      `elapsedMs=${limElapsedMs}, shaMatch=${sha256File(limDone?.target_path) === sha.lim1m}`
    );

    // =====================================================================
    // PHASE 5 & 6: LIVE YOUTUBE 360p/720p/1080p/AUDIO + FIREFOX v1.0.9 PARITY
    // =====================================================================
    console.log('\n>>> [PHASE 5 & 6] Chrome/Firefox v1.0.9 + Live YouTube Resolutions + ffprobe Playability <<<');
    const submitChromeFolderDialog = (chromePid, folderPath) =>
      new Promise((resolve) => {
        const ps1 = path.join(QA_ROOT, `load_ext_${Date.now()}.ps1`);
        fs.writeFileSync(ps1, `param([int]$ChromePid, [string]$FolderPath)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeDlg {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lp, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc lp, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hDlg, int nID);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public const uint WM_SETTEXT = 0x000C;
  public const uint BM_CLICK = 0x00F5;
  public static IntPtr FindDlg(uint ownerPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, lp) => {
      var sbCls = new StringBuilder(64); GetClassName(h, sbCls, 64);
      var sbTxt = new StringBuilder(256); GetWindowText(h, sbTxt, 256);
      if (sbCls.ToString() == "Chrome_WidgetWin_1") {
        uint wpid; GetWindowThreadProcessId(h, out wpid);
        if (wpid == ownerPid) {
          EnumChildWindows(h, (ch, lp2) => {
            var c2 = new StringBuilder(64); GetClassName(ch, c2, 64);
            var t2 = new StringBuilder(256); GetWindowText(ch, t2, 256);
            if (c2.ToString() == "#32770" && t2.ToString().Contains("extension")) { found = ch; return false; }
            return true;
          }, IntPtr.Zero);
        }
      }
      if (sbCls.ToString() == "#32770" && sbTxt.ToString().Contains("extension")) { found = h; return false; }
      return found == IntPtr.Zero;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Submit(uint ownerPid, string path) {
    IntPtr dlg = FindDlg(ownerPid);
    if (dlg == IntPtr.Zero) return false;
    SetForegroundWindow(dlg);
    IntPtr edit = IntPtr.Zero;
    EnumChildWindows(dlg, (ch, lp) => {
      var c = new StringBuilder(64); GetClassName(ch, c, 64);
      if (c.ToString() == "Edit") edit = ch;
      return true;
    }, IntPtr.Zero);
    IntPtr item1152 = GetDlgItem(dlg, 1152);
    if (item1152 != IntPtr.Zero) edit = item1152;
    if (edit == IntPtr.Zero) return false;
    SendMessage(edit, WM_SETTEXT, IntPtr.Zero, path);
    System.Threading.Thread.Sleep(150);
    IntPtr okBtn = GetDlgItem(dlg, 1);
    if (okBtn == IntPtr.Zero) return false;
    SendMessage(okBtn, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
    return true;
  }
}
"@
$deadline = (Get-Date).AddSeconds(14)
while ((Get-Date) -lt $deadline) {
  if ([NativeDlg]::Submit([uint32]$ChromePid, $FolderPath)) { Write-Output "OK"; exit 0 }
  Start-Sleep -Milliseconds 150
}
exit 1
`, 'utf8');
        const p = spawn('powershell', ['-NoProfile', '-File', ps1, String(chromePid), folderPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout.on('data', (d) => (out += d.toString()));
        p.on('close', (code) => { try { fs.unlinkSync(ps1); } catch {} resolve(code === 0 && out.trim() === 'OK'); });
        p.on('error', () => { try { fs.unlinkSync(ps1); } catch {} resolve(false); });
      });

    fs.mkdirSync(path.join(QA_CHR_PROF, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(QA_CHR_PROF, 'First Run'), '');
    fs.writeFileSync(path.join(QA_CHR_PROF, 'Default', 'Preferences'), JSON.stringify({
      download: { default_directory: QA_CHR_DL, prompt_for_download: false },
      profile: { default_content_setting_values: { automatic_downloads: 1 } },
    }));
    const browserEnv = {
      ...process.env,
      TORI_DATA_DIR: QA_ENG_DATA,
      TDM_STORAGE_DIR: QA_ENG_DATA,
      TDM_DOWNLOAD_DIR: QA_ENG_DL,
      TORI_IPC_PIPE: engBoot.env.TORI_IPC_PIPE,
      TORI_DISABLE_AUTO_SPAWN: '1',
      TORI_ALLOW_LOOPBACK: '1',
    };
    const chromeProc = spawn(CHROME_EXE, [
      `--remote-debugging-port=${CHROME_CDP_PORT}`,
      `--user-data-dir=${QA_CHR_PROF}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--window-size=1240,860',
      'about:blank',
    ], { env: browserEnv, stdio: 'ignore' });
    trackedProcs.add(chromeProc);

    const chrInfo = await waitForCdpTargets(CHROME_CDP_PORT, 15000);
    const chrBCdp = new CDPClient(chrInfo.version.webSocketDebuggerUrl);
    await chrBCdp.connect(8000);
    const mgrCreated = await chrBCdp.send('Target.createTarget', { url: 'chrome://extensions/' });
    let mgrTgt = null;
    for (let i = 0; i < 25; i++) {
      const tList = (await waitForCdpTargets(CHROME_CDP_PORT, 6000)).targets;
      mgrTgt = tList.find((t) => t.id === mgrCreated.targetId && t.webSocketDebuggerUrl);
      if (mgrTgt) break;
      await sleep(200);
    }
    const mgrCdp = new CDPClient(mgrTgt.webSocketDebuggerUrl);
    await mgrCdp.connect(8000);
    await waitForContext(mgrCdp, `typeof chrome !== 'undefined' && !!chrome.developerPrivate && document.readyState === 'complete'`, 12000, 'chr-ext-mgr');
    await mgrCdp.evalAsync(`chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })`, 6000);
    let exts = await mgrCdp.evalAsync(`chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true })`, 6000);
    let toriExt = (exts || []).find((e) => String(e.name || '').includes('TORI') && e.version === '1.0.9');
    if (!toriExt) {
      const loadP = mgrCdp.evalAsync(`chrome.developerPrivate.loadUnpacked().then(() => 'OK').catch(e => String(e))`, 20000, { userGesture: true });
      const dlgOk = await submitChromeFolderDialog(chromeProc.pid, CHR_EXT_DIR);
      await loadP;
      if (!dlgOk) throw new Error('Chrome unpacked load dialog failed');
      await sleep(600);
      exts = await mgrCdp.evalAsync(`chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true })`, 6000);
      toriExt = (exts || []).find((e) => String(e.name || '').includes('TORI') && e.version === '1.0.9');
    }
    mgrCdp.close();
    await chrBCdp.send('Target.closeTarget', { targetId: mgrCreated.targetId }).catch(() => {});
    if (!toriExt?.id) throw new Error('Chrome failed to load TORI v1.0.9 unpacked');
    const chrExtId = toriExt.id;
    registerQaNativeHosts({ hostExe: instHost, chromeExtIds: [chrExtId], firefoxId: EXPECTED_GECKO_ID });

    const optCreated = await chrBCdp.send('Target.createTarget', { url: `chrome-extension://${chrExtId}/options/options.html` });
    let optTgt = null;
    for (let i = 0; i < 25; i++) {
      const tList = (await waitForCdpTargets(CHROME_CDP_PORT, 6000)).targets;
      optTgt = tList.find((t) => t.id === optCreated.targetId && t.webSocketDebuggerUrl);
      if (optTgt) break;
      await sleep(200);
    }
    const chrOptCdp = new CDPClient(optTgt.webSocketDebuggerUrl);
    await chrOptCdp.connect(8000);
    await waitForContext(chrOptCdp, `typeof chrome !== 'undefined' && !!chrome.storage`, 8000, 'chr-opt');
    await chrOptCdp.evalAsync(`new Promise(r => chrome.storage.local.set({
      tori_settings: { port: ${ENG_PORT}, key: '${ENG_TOKEN}', auto: true, cap: true, min: 0, pill: true, pos: 'Top right', picker: true, kind: 'Video', fmt: 'Best available', audio: true, badge: true, theme: 'light', accent: 'indigo', sites: [], types: ['zip','mkv','mp4'] }
    }, () => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${ENG_PORT}, key: '${ENG_TOKEN}', passive: true }, () => r(true))))`);
    chrOptCdp.close();
    await chrBCdp.send('Target.closeTarget', { targetId: optCreated.targetId }).catch(() => {});

    const ytCreated = await chrBCdp.send('Target.createTarget', { url: WATCH_SINGLE_URL });
    let ytTarget = null;
    for (let i = 0; i < 25; i++) {
      const tList = (await waitForCdpTargets(CHROME_CDP_PORT, 6000)).targets;
      ytTarget = tList.find((t) => t.id === ytCreated.targetId && t.webSocketDebuggerUrl);
      if (ytTarget) break;
      await sleep(200);
    }
    if (!ytTarget?.webSocketDebuggerUrl) throw new Error('Chrome failed to open YouTube watch target');
    const ytCdp = new CDPClient(ytTarget.webSocketDebuggerUrl);
    await ytCdp.connect(8000);
    await ytCdp.send('Page.bringToFront', {}).catch(() => {});
    await waitForContext(ytCdp, `!!document.querySelector('video') && !!document.querySelector('.tori-mp .tori-pill')`, 45000, 'yt-watch-load');
    await ytCdp.evalAsync(`document.querySelector('.tori-mp .tori-pill').click()`, 5000, { userGesture: true });
    await waitForContext(ytCdp, `document.querySelectorAll('.tori-mp .tori-fr').length >= 3`, 35000, 'yt-formats-load');

    const pickAndTriggerRes = async (regexStr, tab = 'Video') => {
      await sleep(1600);
      const before = new Set(((await httpJson({ port: ENG_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': ENG_TOKEN } })).data?.jobs || []).map((j) => j.id));
      const picked = await ytCdp.evalAsync(`(async () => {
        const pn = document.querySelector('.tori-mp .tori-pn');
        if (pn && !pn.classList.contains('on')) document.querySelector('.tori-mp .tori-pill').click();
        const tb = document.querySelector('.tori-mp [data-tab="${tab}"]');
        if (tb) tb.click();
        await new Promise(r => setTimeout(r, 150));
        const rows = Array.from(document.querySelectorAll('.tori-mp .tori-fr'));
        const rx = new RegExp('${regexStr}', 'i');
        // Prefer compact vp9/mp4 row matching requested height so tests stay fast while genuine
        const matches = rows.filter(r => rx.test(r.textContent || ''));
        const row = matches.find(r => /vp9/i.test(r.textContent)) || matches[matches.length - 1] || rows[0];
        const txt = row ? row.textContent.replace(/\\s+/g, ' ').trim() : null;
        if (row) row.click();
        await new Promise(r => setTimeout(r, 120));
        const btn = document.querySelector('.tori-mp [data-act="download"]');
        if (btn && !btn.disabled) btn.click();
        return txt;
      })()`, 8000, { userGesture: true });
      const started = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => !before.has(j.id), 25000);
      if (!started) return { picked, job: null };
      const done = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => j.id === started.id && j.state === 'completed', 90000);
      let probe = null;
      if (done?.target_path && fs.existsSync(done.target_path)) {
        try { probe = await runFfprobe(done.target_path); } catch {}
      }
      return { picked, job: done, existsOnDbPath: Boolean(done?.target_path && fs.existsSync(done.target_path)), probe };
    };

    const yt360 = await pickAndTriggerRes('360p');
    const yt720 = await pickAndTriggerRes('720p');
    const yt1080 = await pickAndTriggerRes('1080p');
    const ytAud = await pickAndTriggerRes('m4a|opus|kbps', 'Audio');

    const checkVideoProbe = (entry, minH) => {
      if (!entry.existsOnDbPath || !entry.probe || String(entry.job?.target_path).endsWith('.webm.mkv')) return false;
      const streams = entry.probe.streams || [];
      const v = streams.find((s) => s.codec_type === 'video');
      const a = streams.find((s) => s.codec_type === 'audio');
      const dur = parseFloat(entry.probe.format?.duration || '0');
      return Boolean(v && Number(v.height) >= minH && a && dur > 30);
    };
    const yt360Ok = checkVideoProbe(yt360, 360);
    const yt720Ok = checkVideoProbe(yt720, 720);
    const yt1080Ok = checkVideoProbe(yt1080, 1080);
    const ytAudOk = Boolean(
      ytAud.existsOnDbPath &&
      ytAud.probe &&
      (ytAud.probe.streams || []).some((s) => s.codec_type === 'audio') &&
      parseFloat(ytAud.probe.format?.duration || '0') > 30
    );
    record(
      'G294-YT-RES',
      'Live YouTube 360p, 720p, 1080p (synced .mkv path) & Audio-only download with exact DB path & playable ffprobe streams',
      Boolean(yt360Ok && yt720Ok && yt1080Ok && ytAudOk),
      JSON.stringify({
        r360: { ok: yt360Ok, path: yt360.job?.target_path },
        r720: { ok: yt720Ok, path: yt720.job?.target_path },
        r1080: { ok: yt1080Ok, path: yt1080.job?.target_path },
        audio: { ok: ytAudOk, path: ytAud.job?.target_path },
      })
    );
    ytCdp.close();
    chrBCdp.close();
    killProcTree(chromeProc.pid);
    trackedProcs.delete(chromeProc);

    // Firefox v1.0.9 ZIP full parity: CD MKV + Live YouTube Playlist Modal + Multi-Video Playlist Download
    fs.mkdirSync(QA_FF_EXT_DIR, { recursive: true });
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${FF_ZIP_PATH}' -DestinationPath '${QA_FF_EXT_DIR}' -Force`], { stdio: 'ignore', timeout: 15000 });
    fs.mkdirSync(QA_FF_PROF, { recursive: true });
    fs.writeFileSync(path.join(QA_FF_PROF, 'user.js'), [
      'user_pref("marionette.enabled", true);',
      `user_pref("marionette.port", ${FF_MARIONETTE_PORT});`,
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("browser.startup.homepage_override.mstone", "ignore");',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("xpinstall.signatures.required", false);',
    ].join('\n'));

    const ffProc = spawn(FIREFOX_EXE, ['-no-remote', '-marionette', '-profile', QA_FF_PROF, `http://127.0.0.1:${FIXTURE_PORT}/ff_page.html`], {
      env: { ...browserEnv, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
      stdio: 'ignore',
    });
    trackedProcs.add(ffProc);

    const mar = new MarionetteClient(FF_MARIONETTE_PORT);
    await mar.connect(25000);
    await mar.send('WebDriver:NewSession', { capabilities: {} });
    await mar.send('Addon:Install', { path: QA_FF_EXT_DIR, temporary: true });
    await mar.send('Marionette:SetContext', { value: 'chrome' });
    const mozUrl = (await mar.send('WebDriver:ExecuteScript', {
      script: `const p = WebExtensionPolicy.getByID("${EXPECTED_GECKO_ID}"); return p ? p.getURL("") : "";`,
      args: [],
    }))?.value;
    await mar.send('WebDriver:ExecuteScript', {
      script: `Services.wm.getMostRecentWindow("navigator:browser").gBrowser.addTrustedTab("${mozUrl}options/options.html");`,
      args: [],
    });
    await sleep(1000);
    await mar.send('Marionette:SetContext', { value: 'content' });
    const rawHandles = await mar.send('WebDriver:GetWindowHandles', {});
    const ffHandles = Array.isArray(rawHandles?.value) ? rawHandles.value : Array.isArray(rawHandles) ? rawHandles : [];
    let ffOptHandle = null;
    let ffPageHandle = null;
    for (const h of ffHandles) {
      await mar.send('WebDriver:SwitchToWindow', { handle: h });
      const cu = (await mar.send('WebDriver:GetCurrentURL', {}))?.value || '';
      if (cu.includes('options/options.html')) ffOptHandle = h;
      else if (cu.includes('/ff_page.html')) ffPageHandle = h;
    }
    if (ffOptHandle) {
      await mar.send('WebDriver:SwitchToWindow', { handle: ffOptHandle });
      await mar.send('WebDriver:ExecuteAsyncScript', {
        script: `
          const done = arguments[arguments.length - 1];
          const api = typeof browser !== 'undefined' ? browser : chrome;
          api.storage.local.set({
            tori_settings: { port: ${ENG_PORT}, key: '${ENG_TOKEN}', auto: true, cap: true, min: 0, pill: true, pos: 'Top right', picker: true, kind: 'Video', fmt: 'Best available', audio: true, badge: true, theme: 'light', accent: 'indigo', sites: [], types: ['zip','mkv','mp4'] }
          }).then(() => done(true)).catch(() => done(false));
        `,
        args: [],
      });
    }
    if (!ffPageHandle) {
      ffPageHandle = ffHandles.find((h) => h !== ffOptHandle) || ffHandles[0];
    }
    await mar.send('WebDriver:SwitchToWindow', { handle: ffPageHandle });
    await mar.send('WebDriver:Navigate', { url: `http://127.0.0.1:${FIXTURE_PORT}/ff_page.html` });
    await sleep(700);
    const beforeFfMkv = new Set(((await httpJson({ port: ENG_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': ENG_TOKEN } })).data?.jobs || []).map((j) => j.id));
    await mar.send('WebDriver:ExecuteScript', { script: `document.getElementById('dl-ff-mkv').click();`, args: [] });
    const ffMkvJob = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => !beforeFfMkv.has(j.id) && String(j.filename).includes('Firefox_v109_Acceptance.mkv') && j.state === 'completed', 25000);
    const ffMkvOk = Boolean(ffMkvJob && String(ffMkvJob.target_path).toLowerCase().includes('video') && sha256File(ffMkvJob.target_path) === sha.ffMkv6m);
    record('G294-FF-MKV', 'Firefox built v1.0.9 captures extensionless Content-Disposition MKV into Video/ with exact SHA-256', ffMkvOk, JSON.stringify({ path: ffMkvJob?.target_path }));

    // Firefox Playlist Handoff + PlaylistModal download (non-blocking navigation + bounded poll)
    await mar.send('WebDriver:ExecuteScript', { script: `window.location.href = arguments[0];`, args: [WATCH_PLAYLIST_URL] });
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const ready = (await mar.send('WebDriver:ExecuteScript', {
          script: `
            const pn = document.querySelector('.tori-mp .tori-pn');
            const pill = document.querySelector('.tori-mp .tori-pill');
            if (pill && (!pn || !pn.classList.contains('on'))) pill.click();
            return !!document.querySelector('.tori-mp [data-act="open-playlist"]');
          `,
          args: [],
        }, 5000))?.value;
        if (ready) break;
      } catch {}
    }
    await mar.send('WebDriver:ExecuteScript', {
      script: `document.querySelector('.tori-mp [data-act="open-playlist"]')?.click();`,
      args: [],
    });
    await waitForContext(engBoot.mainCdp, `Boolean(document.getElementById('playlist-modal') && document.querySelectorAll('#playlist-modal input[type="checkbox"]').length >= 3)`, 35000, 'ff-playlist-modal');

    const beforePl = new Set(((await httpJson({ port: ENG_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': ENG_TOKEN } })).data?.jobs || []).map((j) => j.id));
    await engBoot.mainCdp.evalAsync(`(async () => {
      const m = document.getElementById('playlist-modal');
      const tick = () => new Promise(r => setTimeout(r, 80));
      const allBtn = Array.from(m.querySelectorAll('button')).find(b => /Deselect All|Select All/i.test(b.textContent || ''));
      if (allBtn && /Deselect All/i.test(allBtn.textContent || '')) { allBtn.click(); await tick(); }
      const boxes = Array.from(m.querySelectorAll('input[type="checkbox"]')).filter(c => !c.disabled);
      const wing = boxes.find(c => /WING IT/i.test(c.closest('div')?.textContent || '')) || boxes[0];
      if (wing && !wing.checked) { wing.click(); await tick(); }
      const sel = m.querySelector('select');
      if (sel && Array.from(sel.options).some(o => o.value === 'audio_m4a')) {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'audio_m4a');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
      }
      const dl = Array.from(m.querySelectorAll('button')).find(b => /Download Selected/i.test(b.textContent || ''));
      if (dl) dl.click();
    })()`, 8000, { userGesture: true });
    const plDone = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => !beforePl.has(j.id) && j.state === 'completed', 60000);
    let plProbeOk = false;
    if (plDone?.target_path && fs.existsSync(plDone.target_path)) {
      const pr = await runFfprobe(plDone.target_path).catch(() => null);
      plProbeOk = Boolean(pr && (pr.streams || []).length > 0 && parseFloat(pr.format?.duration || '0') > 30);
    }
    record('G294-FF-PLAYLIST', 'Firefox built v1.0.9 opens PlaylistModal in TORI Desktop and completes playable playlist download', Boolean(plDone?.state === 'completed' && plProbeOk), JSON.stringify({ path: plDone?.target_path, plProbeOk }));
    try { await mar.send('Marionette:Quit', {}); } catch {}
    mar.close();
    killProcTree(ffProc.pid);
    trackedProcs.delete(ffProc);

    // =====================================================================
    // PHASE 8: SUSTAINED LOAD & MEMORY STABILITY CHECK
    // =====================================================================
    console.log('\n>>> [PHASE 8] Sustained Concurrency & Memory Stability Audit <<<');
    const preLoadStats = getTreeStats(engBoot.proc.pid);
    const stabIds = [];
    for (let s = 1; s <= 6; s++) {
      const r = await httpJson({ port: ENG_PORT, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': ENG_TOKEN }, body: { url: `http://127.0.0.1:${FIXTURE_PORT}/stab_${s}.zip`, filename: `stab_${s}.zip` } });
      stabIds.push(r.data?.job_id);
    }
    await sleep(600);
    const duringStats = getTreeStats(engBoot.proc.pid);
    const stabResults = [];
    for (const sid of stabIds) {
      const d = await waitForJob(ENG_PORT, ENG_TOKEN, (j) => j.id === sid && j.state === 'completed', 45000);
      stabResults.push(Boolean(d && sha256File(d.target_path) === sha.stab16m));
    }
    await sleep(2500);
    const postLoadStats = getTreeStats(engBoot.proc.pid);
    perfMetrics.preLoad = preLoadStats;
    perfMetrics.duringLoad = duringStats;
    perfMetrics.postLoad = postLoadStats;
    record(
      'G294-STAB-LOAD',
      '6x16 MiB sustained transfers complete with exact SHA-256 and stable Desktop/WebView2 memory footprint',
      Boolean(stabResults.every(Boolean) && postLoadStats.consoleCount === 0 && postLoadStats.wsMb < 900),
      JSON.stringify({ allShaOk: stabResults.every(Boolean), preWsMb: preLoadStats.wsMb, duringWsMb: duringStats.wsMb, postWsMb: postLoadStats.wsMb, postPrivMb: postLoadStats.privMb, wv2: postLoadStats.webview2Count })
    );

    engBoot.mainCdp.close();
    killProcTree(engBoot.proc.pid);
    trackedProcs.delete(engBoot.proc);
  } finally {
    cleanupProcs();
    if (fixtureServer) try { fixtureServer.close(); } catch {}
    restoreOemState();
  }

  const finalOemDbHash = sha256File(OEM_DB_PATH);
  const finalXpiHash = sha256File(SIGNED_V107_XPI);
  record('G294-SAFETY-DB', 'OEM production SQLite database untouched across entire Gate 29.4 suite', finalOemDbHash === initialOemDbHash, `sha256=${finalOemDbHash}`);
  record('G294-SAFETY-XPI', 'Mozilla-signed Firefox v1.0.7 XPI untouched across entire Gate 29.4 suite', finalXpiHash === initialXpiHash, `sha256=${finalXpiHash}`);

  console.log('\n========================================================================');
  console.log(` GATE 29.4 VERIFICATION: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.TIMEOUT} TIMEOUT, ${counts.NOT_TESTED} NOT TESTED`);
  console.log('========================================================================');

  if (counts.FAIL > 0 || counts.TIMEOUT > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[FATAL] Gate 29.4 verification aborted:', err);
  cleanupProcs();
  if (fixtureServer) try { fixtureServer.close(); } catch {}
  restoreOemState();
  process.exit(1);
});
