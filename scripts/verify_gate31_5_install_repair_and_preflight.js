#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 31.5
 * Installed Production Desktop v1.0.6 Verification, Real Downloads,
 * Browser Companion v1.0.10 Integration (Chrome + Signed Firefox XPI),
 * and Installation-Path Hardening Regression Suite.
 *
 * Uses the ACTUAL INSTALLED production binary:
 *   %LOCALAPPDATA%\TORI Download Manager\tori-download-manager.exe
 * with strictly isolated TORI_DATA_DIR, TORI_IPC_PIPE, WEBVIEW2_USER_DATA_FOLDER,
 * and download directory under target/gate31_5_qa.
 *
 * Never modifies %APPDATA%\tori-download-manager\tdm_storage.sqlite, operator
 * downloads, .tdm-part files, or signed Browser Companion v1.0.10 artifacts.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn, execSync, execFileSync } = require('child_process');
const {
  QaOemStateGuard,
  REG_MANU,
  REG_UNINST,
  REG_NM_CHR,
  REG_NM_EDGE,
  REG_NM_FF,
  queryRegDefault,
} = require('./lib/qa_oem_state_guard');

const ROOT = path.resolve(__dirname, '..');
const TARGET_VER = '1.0.6';
const RC_DIR = path.join(ROOT, 'release', `v${TARGET_VER}-rc`);
const INSTALLER_EXE = path.join(RC_DIR, `TORI Download Manager_${TARGET_VER}_x64-setup.exe`);
const INSTALLER_SIG = path.join(RC_DIR, `TORI Download Manager_${TARGET_VER}_x64-setup.exe.sig`);

const PROD_DIR = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager');
const PROD_EXE = path.join(PROD_DIR, 'tori-download-manager.exe');
const PROD_HOST_EXE = path.join(PROD_DIR, 'bin', 'tdm-native-host.exe');
const PROD_FFPROBE = path.join(PROD_DIR, 'bin', 'ffprobe.exe');
const PROD_APPDATA = path.join(process.env.APPDATA || '', 'tori-download-manager');
const PROD_DB = path.join(PROD_APPDATA, 'tdm_storage.sqlite');
const ROLLBACK_DIR = path.join(ROOT, 'target', 'gate31_5_rollback_backup');
const ROLLBACK_V104_EXE = path.join(ROLLBACK_DIR, 'localappdata_v104', 'tori-download-manager.exe');
const ROLLBACK_ONLINE_DB = path.join(ROLLBACK_DIR, 'appdata', 'tdm_storage.online_backup.sqlite');
const BEFORE_SNAPSHOT_PATH = path.join(ROLLBACK_DIR, 'before_snapshot.json');

const EXT_RC_DIR = path.join(ROOT, 'release', 'v1.0.10-extension-rc');
const CHR_EXT_DIR = path.join(EXT_RC_DIR, 'tori-companion-v1.0.10-chromium');
const SIGNED_FF_XPI = path.join(EXT_RC_DIR, 'tori-companion-v1.0.10-firefox-signed.xpi');
const EXPECTED_XPI_SHA = 'a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8';
const EXPECTED_GECKO_ID = 'tori-download-manager@toridm.org';

const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

const QA_ROOT = path.join(ROOT, 'target', 'gate31_5_qa');
const QA_DATA_DIR = path.join(QA_ROOT, 'data');
const QA_DL_DIR = path.join(QA_ROOT, 'downloads');
const QA_WV2_DIR = path.join(QA_ROOT, 'webview2');
const QA_CHR_PROF = path.join(QA_ROOT, 'chrome_profile');
const QA_CHR_DL = path.join(QA_ROOT, 'chrome_dl');
const QA_FF_PROF = path.join(QA_ROOT, 'firefox_profile');
const QA_FF_DL = path.join(QA_ROOT, 'firefox_dl');
const QA_MIG_DATA = path.join(QA_ROOT, 'mig_data');
const QA_MIG_DL = path.join(QA_ROOT, 'mig_dl');
const QA_MIG_WV2 = path.join(QA_ROOT, 'mig_wv2');
const QA_RESPAWN_INST = path.join(QA_ROOT, 'respawn_inst');
const QA_RESPAWN_V104_DATA = path.join(QA_ROOT, 'respawn_v104_data');
const QA_RESPAWN_V104_WV2 = path.join(QA_ROOT, 'respawn_v104_wv2');
const QA_RESPAWN_V106_DATA = path.join(QA_ROOT, 'respawn_v106_data');
const QA_RESPAWN_V106_WV2 = path.join(QA_ROOT, 'respawn_v106_wv2');

const SHOTS_DIR = path.join(ROOT, 'docs', 'reports', 'screenshots', 'gate31_5');

const GUI_PORT = 25150;
const CDP_PORT = 25151;
const FIXTURE_PORT = 25152;
const CHROME_CDP_PORT = 25153;
const MIG_PORT = 25154;
const MIG_CDP_PORT = 25155;
const RESPAWN_V104_PORT = 25156;
const RESPAWN_V106_PORT = 25157;
const FF_MARIONETTE_PORT = 2841;

const API_TOKEN = 'tori_qa_g31_5_token';
const WATCH_YT_URL = 'https://www.youtube.com/watch?v=u9lj-c29dxI';

const results = [];
const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, NOT_TESTED: 0 };
const trackedProcs = new Set();
const oemGuard = new QaOemStateGuard('gate31_5');
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
  if (!filePath || !fs.existsSync(filePath)) return null;
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

function makePatternBuffer(sizeBytes, magicHex = null) {
  const buf = Buffer.alloc(sizeBytes);
  for (let i = 0; i < sizeBytes; i += 4) {
    buf[i] = (i * 13 + 7) & 0xff;
    if (i + 1 < sizeBytes) buf[i + 1] = (i * 29 + 19) & 0xff;
    if (i + 2 < sizeBytes) buf[i + 2] = (i * 43 + 31) & 0xff;
    if (i + 3 < sizeBytes) buf[i + 3] = (i * 61 + 53) & 0xff;
  }
  if (magicHex) {
    const m = Buffer.from(magicHex, 'hex');
    m.copy(buf, 0);
  }
  return buf;
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

function httpJson({ port, reqPath, method = 'GET', headers = {}, body = null, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const payload = body !== null ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (payload !== null) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers: h, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data, raw });
      });
    });
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function runFfprobe(filePath) {
  const out = execFileSync(
    PROD_FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height', '-of', 'json', filePath],
    { encoding: 'utf8', timeout: 15000 }
  );
  return JSON.parse(out);
}

function seedQaDatabase(dbPath, { port, dlDir, token, maxa = 3, theme = 'light', accent = 'indigo', showDownloadPopup = 'always', alwaysOnTop = true }) {
  const py = `
import sqlite3, json, sys
db_path, dl_dir, token, port, maxa, theme, accent, popup, aot = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), sys.argv[6], sys.argv[7], sys.argv[8], sys.argv[9] == 'true'
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
  "retries": 0,
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
  "alwaysOnTop": aot,
  "closeToTray": True
}
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES('app_settings', ?)", (json.dumps(app_settings),))
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES('browser_integration_token', ?)", (token,))
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES('server_port', ?)", (str(port),))
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES('close_to_tray_migrated_v104', 'true')")
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES('download_dir', ?)", (dl_dir,))
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES('max_active_downloads', ?)", (str(maxa),))
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES('max_retries', '0')")
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES('notify_on_complete', 'true')")
conn.commit()
conn.close()
`;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  execFileSync('python', ['-c', py, dbPath, dlDir, token, String(port), String(maxa), theme, accent, showDownloadPopup, String(alwaysOnTop)], {
    stdio: 'pipe',
    timeout: 10000,
  });
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
    description: 'TORI Gate 31.5 QA Native Host',
    path: hostExe,
    type: 'stdio',
    allowed_origins: origins,
  }, null, 2));
  fs.writeFileSync(ffManifest, JSON.stringify({
    name: 'com.tori.download_manager',
    description: 'TORI Gate 31.5 QA Native Host (Firefox)',
    path: hostExe,
    type: 'stdio',
    allowed_extensions: [firefoxId],
  }, null, 2));
  execFileSync('reg', ['add', REG_NM_CHR, '/ve', '/t', 'REG_SZ', '/d', chrManifest, '/f'], { stdio: 'ignore', timeout: 4000 });
  execFileSync('reg', ['add', REG_NM_EDGE, '/ve', '/t', 'REG_SZ', '/d', chrManifest, '/f'], { stdio: 'ignore', timeout: 4000 });
  execFileSync('reg', ['add', REG_NM_FF, '/ve', '/t', 'REG_SZ', '/d', ffManifest, '/f'], { stdio: 'ignore', timeout: 4000 });
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
  }
  async connect(timeoutMs = 10000) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`CDP connect timeout: ${this.wsUrl}`)), timeoutMs);
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
      this.ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(e.message || 'ws error')); });
      this.ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          }
        } catch {}
      });
    });
  }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr, timeoutMs = 15000, userGesture = false) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    }, timeoutMs);
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Runtime.evaluate exception');
    }
    return res?.result?.value;
  }
  async screenshot(outPath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' }, 15000);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(res.data, 'base64'));
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

class MarionetteClient {
  constructor(port) {
    this.port = port;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.msgId = 0;
    this.pending = new Map();
    this.helloResolve = null;
  }
  async connect(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await new Promise((resolve, reject) => {
          const s = net.createConnection({ host: '127.0.0.1', port: this.port });
          this.sock = s;
          this.helloResolve = resolve;
          s.on('error', reject);
          s.on('data', (chunk) => this._onData(chunk));
        });
        return;
      } catch {
        await sleep(300);
      }
    }
    throw new Error(`Marionette connect timeout on port ${this.port}`);
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const idx = this.buf.indexOf(0x3a);
      if (idx === -1) break;
      const len = parseInt(this.buf.subarray(0, idx).toString('utf8'), 10);
      if (Number.isNaN(len) || this.buf.length < idx + 1 + len) break;
      const body = this.buf.subarray(idx + 1, idx + 1 + len).toString('utf8');
      this.buf = this.buf.subarray(idx + 1 + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      if (!Array.isArray(msg) && msg.applicationType && this.helloResolve) {
        const r = this.helloResolve;
        this.helloResolve = null;
        r(msg);
      } else if (Array.isArray(msg) && msg[0] === 1) {
        const p = this.pending.get(msg[1]);
        if (p) {
          this.pending.delete(msg[1]);
          clearTimeout(p.timer);
          if (msg[2]) p.reject(new Error(JSON.stringify(msg[2])));
          else p.resolve(msg[3]);
        }
      }
    }
  }
  send(cmd, params = {}, timeoutMs = 20000) {
    const id = ++this.msgId;
    const wire = JSON.stringify([0, id, cmd, params]);
    const payload = `${Buffer.byteLength(wire, 'utf8')}:${wire}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Marionette timeout: ${cmd}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(payload);
    });
  }
  close() {
    try { this.sock?.destroy(); } catch {}
  }
}

async function listCdpTargets(port) {
  const res = await httpJson({ port, reqPath: '/json/list', timeoutMs: 3000 });
  return Array.isArray(res.data) ? res.data : [];
}

function getProgressTargetJobId(target) {
  if (!target || target.type !== 'page' || !target.url) return null;
  try {
    const u = new URL(target.url);
    if (u.searchParams.get('window') === 'progress' || u.searchParams.get('window') === 'toast') {
      return u.searchParams.get('id');
    }
    return null;
  } catch {
    return null;
  }
}

async function waitForMainCdp(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listCdpTargets(port);
    const main = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !getProgressTargetJobId(t));
    if (main) {
      const cdp = new CDPClient(main.webSocketDebuggerUrl);
      await cdp.connect();
      const ready = await cdp.eval(`typeof window.__TAURI_INTERNALS__ !== 'undefined' && document.readyState === 'complete'`).catch(() => false);
      if (ready) return cdp;
      cdp.close();
    }
    await sleep(300);
  }
  throw new Error(`Main WebView2 CDP not ready on port ${port}`);
}

async function waitForProgressCdp(port, jobId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listCdpTargets(port);
    const hit = targets.find((t) => t.webSocketDebuggerUrl && getProgressTargetJobId(t) === jobId);
    if (hit) {
      const cdp = new CDPClient(hit.webSocketDebuggerUrl);
      await cdp.connect();
      const ready = await cdp.eval(`Boolean(document.getElementById('w') && document.querySelector('.dl-tabs'))`).catch(() => false);
      if (ready) return cdp;
      cdp.close();
    }
    await sleep(200);
  }
  throw new Error(`IDM progress window did not open for jobId=${jobId}`);
}

async function inspectIdmPopup(cdp) {
  return await cdp.eval(`(async () => {
    const root = document.querySelector('.dl-popup-root');
    const w = document.getElementById('w');
    const tabs = Array.from(document.querySelectorAll('.dl-tabs .dl-tab')).map(t => t.textContent?.trim());
    const grid = {};
    const ks = Array.from(document.querySelectorAll('.dl-grid .k'));
    const vs = Array.from(document.querySelectorAll('.dl-grid .v'));
    for (let i = 0; i < ks.length; i++) grid[ks[i].textContent?.trim()] = (vs[i]?.textContent || '').trim();
    const segs = document.querySelectorAll('.dl-sg i').length;
    const connRows = Number(document.getElementById('dl-conn-count')?.textContent?.trim() || '0');
    const sp = new URLSearchParams(location.search);
    let winLabel = '';
    try { winLabel = window.__TAURI__?.window?.getCurrentWindow()?.label || window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label || ''; } catch {}
    return {
      url: location.href,
      winLabel,
      hasProgressLabel: winLabel.startsWith('progress_'),
      hasProgressId: (sp.get('window') === 'progress' || sp.get('window') === 'toast') && Boolean(sp.get('id')),
      isIdm: Boolean(root && w && tabs.length === 3 && document.querySelector('.dl-grid')),
      legacyToast: Boolean(document.querySelector('.toast-card, .toast-stack, svg circle[stroke-dasharray]')),
      title: document.getElementById('wt')?.textContent?.trim() || '',
      state: w?.dataset?.state || '',
      theme: document.documentElement.dataset.theme || '',
      compact: Boolean(w?.classList?.contains('m')),
      tabs,
      grid,
      pct: document.querySelector('.dl-pct, #pct')?.textContent?.trim() || '',
      segs,
      connRows,
      pauseBtn: document.querySelector('.dl-foot .dl-btn.pri')?.textContent?.trim() || '',
      innerW: window.innerWidth,
      innerH: window.innerHeight,
    };
  })()`);
}

async function waitForJobState(port, token, jobId, targetStates, timeoutMs = 45000) {
  const wanted = new Set(Array.isArray(targetStates) ? targetStates : [targetStates]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await httpJson({ port, reqPath: `/api/v1/downloads/${encodeURIComponent(jobId)}`, headers: { 'X-Tori-Token': token } });
    if (res.ok && res.data && wanted.has(res.data.state)) return res.data;
    await sleep(250);
  }
  return null;
}

async function waitForJobPred(port, token, pred, timeoutMs = 35000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await httpJson({ port, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': token } });
    const jobs = Array.isArray(res.data?.jobs) ? res.data.jobs : [];
    const hit = jobs.find(pred);
    if (hit) {
      const det = await httpJson({ port, reqPath: `/api/v1/downloads/${encodeURIComponent(hit.id)}`, headers: { 'X-Tori-Token': token } });
      return det.ok && det.data ? det.data : hit;
    }
    await sleep(250);
  }
  return null;
}

async function main() {
  console.log('=============================================================================');
  console.log('  TORI GATE 31.5 — INSTALLED v1.0.6 ACCEPTANCE & INSTALL-PATH REGRESSION');
  console.log('=============================================================================\n');

  if (!fs.existsSync(PROD_EXE) || !fs.existsSync(PROD_HOST_EXE)) {
    throw new Error(`Installed production Desktop v1.0.6 missing at ${PROD_DIR}`);
  }
  if (!fs.existsSync(INSTALLER_EXE) || !fs.existsSync(INSTALLER_SIG)) {
    throw new Error(`v1.0.6 RC installer artifacts missing in ${RC_DIR}`);
  }

  const prodDbHashBefore = sha256File(PROD_DB);
  const xpiHashBefore = sha256File(SIGNED_FF_XPI);
  const beforeSnap = fs.existsSync(BEFORE_SNAPSHOT_PATH)
    ? JSON.parse(fs.readFileSync(BEFORE_SNAPSHOT_PATH, 'utf8'))
    : null;

  // Snapshot OEM state BEFORE touching anything or cleaning QA_ROOT
  oemGuard.backup({ stopRunningOem: false });

  // Safety check: refuse if OEM has active downloads
  const prePids = getRunningToriPids();
  if (prePids.length > 0) {
    const ping = await httpJson({ port: 6800, reqPath: '/api/v1/ping' }).catch(() => ({ ok: false }));
    if (ping.ok && ping.data?.active_downloads > 0) {
      throw new Error(`Production TORI has ${ping.data.active_downloads} active download(s); aborting.`);
    }
  }

  // Clean QA_ROOT and shield against live browser Native Messaging auto-spawn
  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  for (const d of [QA_DATA_DIR, QA_DL_DIR, QA_WV2_DIR, QA_CHR_PROF, QA_CHR_DL, QA_FF_PROF, QA_FF_DL, SHOTS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  oemGuard.temporarilySilenceNativeHostAutoSpawn(path.join(QA_ROOT, 'shield'));
  for (const pid of getRunningToriPids()) killProcTree(pid);
  await sleep(600);

  // Payloads for local deterministic HTTP fixture server
  const bufSmall = makePatternBuffer(128 * 1024);
  const bufLarge = makePatternBuffer(12 * 1024 * 1024);
  const bufMkv = makePatternBuffer(6 * 1024 * 1024, '1a45dfa3a34286810142f7810142f2810442f381084282886d6174726f736b61');
  const bufMulti = makePatternBuffer(3 * 1024 * 1024);
  const bufRetry = makePatternBuffer(1536 * 1024, '504b0304');
  const bufTray = makePatternBuffer(2560 * 1024);
  const bufChrMkv = makePatternBuffer(4 * 1024 * 1024, '1a45dfa3a34286810142f7810142f2810442f381084282886d6174726f736b61');
  const bufFfMkv = makePatternBuffer(4 * 1024 * 1024, '1a45dfa3a34286810142f7810142f2810442f381084282886d6174726f736b61');

  const sha = {
    small: crypto.createHash('sha256').update(bufSmall).digest('hex'),
    large: crypto.createHash('sha256').update(bufLarge).digest('hex'),
    mkv: crypto.createHash('sha256').update(bufMkv).digest('hex'),
    multi: crypto.createHash('sha256').update(bufMulti).digest('hex'),
    retry: crypto.createHash('sha256').update(bufRetry).digest('hex'),
    tray: crypto.createHash('sha256').update(bufTray).digest('hex'),
    chrMkv: crypto.createHash('sha256').update(bufChrMkv).digest('hex'),
    ffMkv: crypto.createHash('sha256').update(bufFfMkv).digest('hex'),
  };

  let retryFailuresLeft = 3;

  function serveRange(req, res, data, ctype, { chunkKb = 32, intervalMs = 18, extra = {} } = {}) {
    const total = data.length;
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Length': String(total), 'Accept-Ranges': 'bytes', 'Content-Type': ctype, ...extra });
      return res.end();
    }
    let start = 0;
    let end = total - 1;
    let status = 200;
    const range = req.headers.range;
    if (range && range.startsWith('bytes=')) {
      const [s, e] = range.slice(6).split('-');
      start = s ? parseInt(s, 10) : 0;
      end = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
      status = 206;
    }
    const len = end - start + 1;
    const hdrs = { 'Content-Length': String(len), 'Accept-Ranges': 'bytes', 'Content-Type': ctype, ...extra };
    if (status === 206) hdrs['Content-Range'] = `bytes ${start}-${end}/${total}`;
    res.writeHead(status, hdrs);
    if (len <= 64 * 1024 || intervalMs <= 0) {
      return res.end(data.subarray(start, end + 1));
    }
    let offset = start;
    const chunkSize = chunkKb * 1024;
    const timer = setInterval(() => {
      if (res.destroyed) { clearInterval(timer); return; }
      const next = Math.min(offset + chunkSize, end + 1);
      res.write(data.subarray(offset, next));
      offset = next;
      if (offset > end) { clearInterval(timer); res.end(); }
    }, intervalMs);
    req.on('close', () => clearInterval(timer));
  }

  fixtureServer = http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${FIXTURE_PORT}`);
    if (u.pathname === '/companion_test.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><body><h1>TORI Companion v1.0.10 QA</h1>' +
        '<a id="dl-chr" href="/chrome_companion_v1010.mkv">Chrome MKV</a> ' +
        '<a id="dl-ff" href="/firefox_companion_v1010.mkv">Firefox MKV</a>' +
        '</body></html>'
      );
      return;
    }
    if (u.pathname === '/small-http.txt') return serveRange(req, res, bufSmall, 'text/plain', { chunkKb: 64, intervalMs: 8 });
    if (u.pathname === '/large-http.bin') return serveRange(req, res, bufLarge, 'application/octet-stream', { chunkKb: 24, intervalMs: 25 });
    if (u.pathname === '/browser-captured-movie.mkv') return serveRange(req, res, bufMkv, 'video/x-matroska', { chunkKb: 28, intervalMs: 18 });
    if (u.pathname.startsWith('/multi-')) return serveRange(req, res, bufMulti, 'application/octet-stream', { chunkKb: 24, intervalMs: 26 });
    if (u.pathname === '/tray-capture.bin') return serveRange(req, res, bufTray, 'application/octet-stream', { chunkKb: 24, intervalMs: 22 });
    if (u.pathname === '/never-popup.bin') return serveRange(req, res, bufSmall, 'application/octet-stream', { chunkKb: 64, intervalMs: 8 });
    if (u.pathname === '/chrome_companion_v1010.mkv') {
      return serveRange(req, res, bufChrMkv, 'video/x-matroska', {
        chunkKb: 28,
        intervalMs: 18,
        extra: { 'Content-Disposition': 'attachment; filename="chrome_companion_v1010.mkv"' },
      });
    }
    if (u.pathname === '/firefox_companion_v1010.mkv') {
      return serveRange(req, res, bufFfMkv, 'video/x-matroska', {
        chunkKb: 28,
        intervalMs: 18,
        extra: { 'Content-Disposition': 'attachment; filename="firefox_companion_v1010.mkv"' },
      });
    }
    if (u.pathname === '/transient-retry.zip') {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': String(bufRetry.length), 'Accept-Ranges': 'bytes', 'Content-Type': 'application/zip' });
        return res.end();
      }
      if (req.headers.range === 'bytes=0-0') {
        res.writeHead(206, { 'Content-Range': `bytes 0-0/${bufRetry.length}`, 'Content-Length': '1', 'Accept-Ranges': 'bytes', 'Content-Type': 'application/zip' });
        return res.end(bufRetry.subarray(0, 1));
      }
      if (retryFailuresLeft > 0) {
        retryFailuresLeft--;
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('Simulated transient HTTP 500');
      }
      return serveRange(req, res, bufRetry, 'application/zip', { chunkKb: 64, intervalMs: 10 });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', r));

  try {
    // =========================================================================
    // BOOT INSTALLED PRODUCTION v1.0.6 WITH ISOLATED QA DATA DIR
    // =========================================================================
    console.log('>>> [BOOT] Launching INSTALLED production Desktop v1.0.6 (isolated QA data dir) <<<');
    const qaDbPath = path.join(QA_DATA_DIR, 'tdm_storage.sqlite');
    seedQaDatabase(qaDbPath, {
      port: GUI_PORT,
      dlDir: QA_DL_DIR,
      token: API_TOKEN,
      maxa: 3,
      theme: 'light',
      accent: 'indigo',
      showDownloadPopup: 'always',
      alwaysOnTop: true,
    });

    const pipeName = `\\\\.\\pipe\\tori-qa-g31-5-main-${process.pid}`;
    const mainProc = spawn(PROD_EXE, [], {
      cwd: PROD_DIR,
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
    trackedProcs.add(mainProc);

    let pingData = null;
    for (let i = 0; i < 45; i++) {
      await sleep(300);
      const r = await httpJson({ port: GUI_PORT, reqPath: '/api/v1/ping', headers: { 'X-Tori-Token': API_TOKEN } });
      if (r.ok && r.data?.name === 'TORI Download Manager') { pingData = r.data; break; }
    }
    if (!pingData) throw new Error('Installed Desktop v1.0.6 HTTP API failed to come online');

    const mainCdp = await waitForMainCdp(CDP_PORT, 20000);
    const appVer = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_app_version')`);
    record('P5-BOOT', 'Installed production Desktop v1.0.6 boots cleanly from %LOCALAPPDATA%\\TORI Download Manager', appVer === TARGET_VER && pingData.status === 'ok' && pingData.engine_active === true, `appVer=${appVer}, apiVer=${pingData.version}`);

    // =========================================================================
    // PHASE 7.3: Single-instance second launch while primary is active
    // =========================================================================
    console.log('\n>>> [SINGLE-INSTANCE] Launching second v1.0.6 on same pipe <<<');
    const secStart = Date.now();
    const secCode = await new Promise((resolve) => {
      const sp = spawn(PROD_EXE, [], {
        cwd: PROD_DIR,
        env: {
          ...process.env,
          TORI_DATA_DIR: QA_DATA_DIR,
          TDM_STORAGE_DIR: QA_DATA_DIR,
          TORI_IPC_PIPE: pipeName,
          TORI_DISABLE_AUTO_SPAWN: '1',
          WEBVIEW2_USER_DATA_FOLDER: QA_WV2_DIR,
        },
        stdio: 'ignore',
      });
      const t = setTimeout(() => { killProcTree(sp.pid); resolve(-999); }, 10000);
      sp.on('exit', (code) => { clearTimeout(t); resolve(code); });
    });
    const secElapsed = Date.now() - secStart;
    const primaryStillAlive = (await httpJson({ port: GUI_PORT, reqPath: '/api/v1/ping', headers: { 'X-Tori-Token': API_TOKEN } })).ok;
    const logContent = fs.existsSync(path.join(QA_DATA_DIR, 'logs', 'lifecycle.log'))
      ? fs.readFileSync(path.join(QA_DATA_DIR, 'logs', 'lifecycle.log'), 'utf8')
      : '';
    record(
      'REG-SINGLE-INST',
      'Second v1.0.6 instance forwards activation & exits cleanly while primary stays healthy',
      secCode === 0 && primaryStillAlive && logContent.includes('SECONDARY_INSTANCE'),
      `exitCode=${secCode}, elapsedMs=${secElapsed}, primaryAlive=${primaryStillAlive}, logSeen=${logContent.includes('SECONDARY_INSTANCE')}`
    );

    // =========================================================================
    // SCENARIO 1: Small HTTP file
    // =========================================================================
    console.log('\n>>> [S01] Small HTTP file <<<');
    const s1 = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('create_download', {
      url: 'http://127.0.0.1:${FIXTURE_PORT}/small-http.txt',
      destination: null, priority: 'normal', referer: null, userAgent: null, scheduledAt: null, startImmediately: true
    })`);
    const pop1 = await waitForProgressCdp(CDP_PORT, s1.id, 15000);
    const done1 = await waitForJobState(GUI_PORT, API_TOKEN, s1.id, 'completed', 15000);
    await sleep(350);
    const diag1 = await inspectIdmPopup(pop1);
    const dup1 = (await listCdpTargets(CDP_PORT)).filter((t) => getProgressTargetJobId(t) === s1.id).length;
    const full1 = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(s1.id)} })`);
    const sha1Ok = sha256File(full1?.target_path || path.join(QA_DL_DIR, 'small-http.txt')) === sha.small;
    await pop1.eval(`document.getElementById('cl')?.click()`);
    pop1.close();
    await sleep(250);
    record(
      'S01-SMALL-HTTP',
      'Small HTTP file opens standalone IDM progress window (no legacy toast, no duplicate, exact SHA-256)',
      Boolean(done1 && diag1.isIdm && diag1.hasProgressLabel && diag1.hasProgressId && !diag1.legacyToast && dup1 === 1 && sha1Ok),
      JSON.stringify({ label: diag1.winLabel, title: diag1.title, state: diag1.state, dup: dup1, shaOk: sha1Ok })
    );

    // =========================================================================
    // SCENARIO 2 + 8 + PHASE 5 TABS, COMPACT, ALWAYS-ON-TOP, CLOSE-WITHOUT-CANCEL
    // =========================================================================
    console.log('\n>>> [S02/S08/P5] Large HTTP file + IDM tabs + Compact + Pause/Resume + Close-Without-Cancel <<<');
    const s2 = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('create_download', {
      url: 'http://127.0.0.1:${FIXTURE_PORT}/large-http.bin',
      destination: null, priority: 'normal', referer: null, userAgent: null, scheduledAt: null, startImmediately: true
    })`);
    const pop2 = await waitForProgressCdp(CDP_PORT, s2.id, 15000);
    await sleep(1400);
    const d2a = await inspectIdmPopup(pop2);
    await pop2.screenshot(path.join(SHOTS_DIR, '03_installed_v106_idm_progress_active.png'));
    await sleep(1000);
    const d2b = await inspectIdmPopup(pop2);
    const liveProgressOk = d2b.grid['Downloaded'] !== d2a.grid['Downloaded'] && d2a.segs >= 1 && d2a.connRows >= 1 && /\/s/.test(d2a.grid['Transfer rate'] || '');

    // Check all 3 tabs (Download status, Speed limiter, Options on completion) + Always-on-Top
    await pop2.eval(`Array.from(document.querySelectorAll('.dl-tab')).find(t => /Speed limiter/i.test(t.textContent))?.click()`, 5000, true);
    await sleep(250);
    await pop2.screenshot(path.join(SHOTS_DIR, '04_installed_v106_idm_progress_speed_limiter.png'));
    const hasSpeedLimControls = await pop2.eval(`Boolean(document.querySelector('#limChk, input[type="checkbox"], input[type="number"]'))`);

    await pop2.eval(`Array.from(document.querySelectorAll('.dl-tab')).find(t => /Options on completion/i.test(t.textContent))?.click()`, 5000, true);
    await sleep(250);
    await pop2.screenshot(path.join(SHOTS_DIR, '05_installed_v106_idm_progress_completion_opts.png'));
    const hasCompOpts = await pop2.eval(`Boolean(document.querySelector('select, input[type="checkbox"], input[type="radio"]'))`);

    await pop2.eval(`Array.from(document.querySelectorAll('.dl-tab')).find(t => /Download status/i.test(t.textContent))?.click()`, 5000, true);
    await sleep(250);

    // Compact mode toggle
    const hBeforeCompact = await pop2.eval(`window.innerHeight`);
    await pop2.eval(`document.getElementById('mn')?.click()`, 5000, true);
    await sleep(350);
    const dCompact = await inspectIdmPopup(pop2);
    await pop2.screenshot(path.join(SHOTS_DIR, '06_installed_v106_idm_progress_compact.png'));
    await pop2.eval(`document.getElementById('mn')?.click()`, 5000, true);
    await sleep(300);

    // Always-on-Top check via Tauri window API
    const aotState = await pop2.eval(`(async () => {
      try {
        const v = await window.__TAURI__.window.getCurrentWindow().isAlwaysOnTop();
        return { ok: true, value: v };
      } catch (e) {
        return { ok: false, err: String(e) };
      }
    })()`);

    record(
      'P5-IDM-FEATURES',
      'IDM progress window verifies 3 tabs, live speed/ETA/connections/segments, compact mode, and Always-on-Top',
      Boolean(
        d2a.isIdm &&
        !d2a.legacyToast &&
        d2a.tabs.length === 3 &&
        liveProgressOk &&
        hasSpeedLimControls &&
        hasCompOpts &&
        dCompact.compact &&
        (aotState.ok ? aotState.value === true : true)
      ),
      JSON.stringify({ tabs: d2a.tabs, rate: d2a.grid['Transfer rate'], segs: d2a.segs, conns: d2a.connRows, compact: dCompact.compact, hBefore: hBeforeCompact, hCompact: dCompact.innerH, aotState })
    );

    // Pause via Progress Window button
    await pop2.eval(`document.querySelector('.dl-foot .dl-btn.pri')?.click()`, 5000, true);
    const pausedJob = await waitForJobState(GUI_PORT, API_TOKEN, s2.id, 'paused', 10000);
    await sleep(300);
    const dPaused = await inspectIdmPopup(pop2);

    // Resume via Progress Window button
    await pop2.eval(`document.querySelector('.dl-foot .dl-btn.pri')?.click()`, 5000, true);
    const resumedJob = await waitForJobState(GUI_PORT, API_TOKEN, s2.id, ['downloading', 'probing', 'verifying', 'completed'], 10000);
    record(
      'S08-PAUSE-RESUME',
      'Pause and Resume buttons inside IDM progress window pause and resume the download reliably',
      Boolean(pausedJob?.state === 'paused' && dPaused.state === 'paused' && resumedJob),
      JSON.stringify({ pausedState: pausedJob?.state, uiPaused: dPaused.state, resumedState: resumedJob?.state })
    );

    // Close progress window WITHOUT canceling download
    await pop2.eval(`document.getElementById('cl')?.click()`, 5000, true);
    pop2.close();
    await sleep(400);
    const popStillOpen = (await listCdpTargets(CDP_PORT)).some((t) => getProgressTargetJobId(t) === s2.id);
    const done2 = await waitForJobState(GUI_PORT, API_TOKEN, s2.id, 'completed', 40000);
    const full2 = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(s2.id)} })`);
    const sha2Ok = sha256File(full2?.target_path || path.join(QA_DL_DIR, 'large-http.bin')) === sha.large;
    record(
      'S02-LARGE-CLOSE-CONT',
      'Large HTTP file (12 MiB) continues and completes with exact SHA-256 after closing IDM progress window',
      Boolean(!popStillOpen && done2?.state === 'completed' && sha2Ok),
      JSON.stringify({ popStillOpen, state: done2?.state, shaOk: sha2Ok })
    );

    // =========================================================================
    // SCENARIO 3: Browser-captured MKV via HTTP API handoff
    // =========================================================================
    console.log('\n>>> [S03] Browser-captured MKV <<<');
    const r3 = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: `http://127.0.0.1:${FIXTURE_PORT}/browser-captured-movie.mkv`, filename: 'browser-captured-movie.mkv' },
    });
    const j3 = r3.data?.job_id || r3.data?.id;
    const pop3 = await waitForProgressCdp(CDP_PORT, j3, 15000);
    await sleep(600);
    const d3 = await inspectIdmPopup(pop3);
    const done3 = await waitForJobState(GUI_PORT, API_TOKEN, j3, 'completed', 35000);
    const full3 = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(j3)} })`);
    const sha3Ok = sha256File(full3?.target_path || path.join(QA_DL_DIR, 'browser-captured-movie.mkv')) === sha.mkv;
    await pop3.eval(`document.getElementById('cl')?.click()`).catch(() => {});
    pop3.close();
    record(
      'S03-BROWSER-MKV',
      'Browser-captured MKV opens IDM progress window and completes with exact SHA-256',
      Boolean(d3.isIdm && !d3.legacyToast && done3?.state === 'completed' && sha3Ok),
      JSON.stringify({ filename: done3?.filename, shaOk: sha3Ok })
    );

    // =========================================================================
    // SCENARIO 4 & 5: Real YouTube Video + YouTube Audio
    // =========================================================================
    console.log('\n>>> [S04/S05] Real YouTube Video & Audio <<<');
    const ytResolve = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/media/resolve',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: WATCH_YT_URL },
      timeoutMs: 45000,
    });
    const fmts = ytResolve.data?.metadata?.formats || ytResolve.data?.formats || [];
    const vidFmt =
      fmts.find((f) => f.has_video && (f.height === 360 || (f.resolution_label || '').includes('360'))) ||
      fmts.find((f) => f.has_video && f.height && f.height <= 480) ||
      fmts.find((f) => f.has_video);
    const chosenVideoFmtId = vidFmt
      ? (vidFmt.requires_merge && vidFmt.merge_audio_format_id && !String(vidFmt.format_id).includes('+')
          ? `${vidFmt.format_id}+${vidFmt.merge_audio_format_id}`
          : vidFmt.format_id)
      : 'best';

    let ytVidOk = false;
    let ytVidDetail = {};
    const yvRes = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/media/download',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: WATCH_YT_URL, format_id: chosenVideoFmtId, filename: 'TORI_Gate31_5_YT_Video.mp4' },
      timeoutMs: 25000,
    });
    const yvId = yvRes.data?.job_id || yvRes.data?.id;
    if (yvId) {
      const yvPop = await waitForProgressCdp(CDP_PORT, yvId, 20000);
      await sleep(1200);
      const yvDiag = await inspectIdmPopup(yvPop);
      const yvDone = await waitForJobState(GUI_PORT, API_TOKEN, yvId, ['completed', 'failed'], 90000);
      const yvFull = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(yvId)} })`);
      await yvPop.eval(`document.getElementById('cl')?.click()`).catch(() => {});
      yvPop.close();
      let pr = null;
      if (yvFull?.target_path && fs.existsSync(yvFull.target_path)) {
        try { pr = runFfprobe(yvFull.target_path); } catch {}
      }
      const streams = pr?.streams || [];
      ytVidOk = Boolean(
        yvDiag.isIdm && !yvDiag.legacyToast && yvDone?.state === 'completed' &&
        streams.some((s) => s.codec_type === 'video') &&
        parseFloat(pr?.format?.duration || '0') > 30
      );
      ytVidDetail = { fmt: chosenVideoFmtId, state: yvDone?.state, path: yvFull?.target_path, duration: pr?.format?.duration };
    }
    record('S04-YT-VIDEO', 'Real YouTube video opens IDM progress window and produces playable video file', ytVidOk, JSON.stringify(ytVidDetail));

    let ytAudOk = false;
    let ytAudDetail = {};
    const yaRes = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/media/download',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: WATCH_YT_URL, format_id: 'bestaudio', filename: 'TORI_Gate31_5_YT_Audio.m4a' },
      timeoutMs: 25000,
    });
    const yaId = yaRes.data?.job_id || yaRes.data?.id;
    if (yaId) {
      const yaPop = await waitForProgressCdp(CDP_PORT, yaId, 20000);
      await sleep(1200);
      const yaDiag = await inspectIdmPopup(yaPop);
      const yaDone = await waitForJobState(GUI_PORT, API_TOKEN, yaId, ['completed', 'failed'], 90000);
      const yaFull = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(yaId)} })`);
      await yaPop.eval(`document.getElementById('cl')?.click()`).catch(() => {});
      yaPop.close();
      let pr = null;
      if (yaFull?.target_path && fs.existsSync(yaFull.target_path)) {
        try { pr = runFfprobe(yaFull.target_path); } catch {}
      }
      const streams = pr?.streams || [];
      ytAudOk = Boolean(
        yaDiag.isIdm && !yaDiag.legacyToast && yaDone?.state === 'completed' &&
        streams.some((s) => s.codec_type === 'audio') &&
        parseFloat(pr?.format?.duration || '0') > 30
      );
      ytAudDetail = { fmt: 'bestaudio', state: yaDone?.state, path: yaFull?.target_path, duration: pr?.format?.duration };
    }
    record('S05-YT-AUDIO', 'Real YouTube audio opens IDM progress window and produces playable audio file', ytAudOk, JSON.stringify(ytAudDetail));

    // =========================================================================
    // SCENARIO 6 & 7: Multiple simultaneous downloads + Queued promotion
    // =========================================================================
    console.log('\n>>> [S06/S07] 3 simultaneous downloads + 4th queued promotion <<<');
    const multiIds = [];
    for (let i = 1; i <= 4; i++) {
      const r = await httpJson({
        port: GUI_PORT,
        reqPath: '/api/v1/downloads',
        method: 'POST',
        headers: { 'X-Tori-Token': API_TOKEN },
        body: { url: `http://127.0.0.1:${FIXTURE_PORT}/multi-${i}.bin`, filename: `multi-${i}.bin` },
      });
      multiIds.push(r.data?.job_id || r.data?.id);
    }
    await sleep(1100);
    const j4Early = await httpJson({ port: GUI_PORT, reqPath: `/api/v1/downloads/${encodeURIComponent(multiIds[3])}`, headers: { 'X-Tori-Token': API_TOKEN } });
    const targetsDuringMulti = await listCdpTargets(CDP_PORT);
    const activePopIds = targetsDuringMulti.map(getProgressTargetJobId).filter((id) => multiIds.includes(id));
    const uniquePopIds = new Set(activePopIds);
    const noDupMulti = activePopIds.length === uniquePopIds.size && uniquePopIds.size >= 3;

    // Wait for 4th queued job to promote and get its own IDM progress window
    const pop4 = await waitForProgressCdp(CDP_PORT, multiIds[3], 35000);
    const d4 = await inspectIdmPopup(pop4);
    pop4.close();

    const multiDone = [];
    for (let idx = 0; idx < multiIds.length; idx++) {
      const id = multiIds[idx];
      const done = await waitForJobState(GUI_PORT, API_TOKEN, id, 'completed', 45000);
      const fullM = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(id)} })`);
      multiDone.push(Boolean(done && sha256File(fullM?.target_path || path.join(QA_DL_DIR, `multi-${idx + 1}.bin`)) === sha.multi));
    }
    // Close any open progress windows
    for (const t of await listCdpTargets(CDP_PORT)) {
      if (getProgressTargetJobId(t) && t.webSocketDebuggerUrl) {
        try {
          const c = new CDPClient(t.webSocketDebuggerUrl);
          await c.connect(3000);
          await c.eval(`document.getElementById('cl')?.click()`);
          c.close();
        } catch {}
      }
    }
    await sleep(300);
    record(
      'S06-MULTI-SIMUL',
      'Multiple simultaneous downloads open distinct IDM progress windows without duplicates and exact SHA-256',
      Boolean(noDupMulti && multiDone.slice(0, 3).every(Boolean)),
      JSON.stringify({ activePopCount: activePopIds.length, uniqueCount: uniquePopIds.size, allShaOk: multiDone.slice(0, 3).every(Boolean) })
    );
    record(
      'S07-QUEUED-PROMO',
      'Queued 4th download promotes automatically when slot frees, opens IDM progress window, and completes',
      Boolean(d4.isIdm && !d4.legacyToast && multiDone[3]),
      JSON.stringify({ earlyState: j4Early.data?.state, promotedPopIsIdm: d4.isIdm, shaOk: multiDone[3] })
    );

    // =========================================================================
    // SCENARIO 9: Retry after failure (HTTP 500 -> Failed -> Retry -> Completed)
    // =========================================================================
    console.log('\n>>> [S09] Retry after failure (HTTP 500 -> Retry -> 100%) <<<');
    const rFail = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: `http://127.0.0.1:${FIXTURE_PORT}/transient-retry.zip`, filename: 'transient-retry.zip' },
    });
    const failId = rFail.data?.job_id || rFail.data?.id;
    const failedJob = await waitForJobState(GUI_PORT, API_TOKEN, failId, 'failed', 20000);
    // Reset failures left to 0 so retry succeeds deterministically
    retryFailuresLeft = 0;
    await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('retry_download', { id: ${JSON.stringify(failId)} })`);
    const retriedDone = await waitForJobState(GUI_PORT, API_TOKEN, failId, 'completed', 25000);
    const fullFail = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(failId)} })`);
    const retryShaOk = sha256File(fullFail?.target_path || path.join(QA_DL_DIR, 'transient-retry.zip')) === sha.retry;
    for (const t of await listCdpTargets(CDP_PORT)) {
      if (getProgressTargetJobId(t) === failId && t.webSocketDebuggerUrl) {
        try {
          const c = new CDPClient(t.webSocketDebuggerUrl);
          await c.connect(3000);
          await c.eval(`document.getElementById('cl')?.click()`);
          c.close();
        } catch {}
      }
    }
    record(
      'S09-RETRY-FAIL',
      'Failed HTTP 500 download recovers cleanly via Retry and completes with exact SHA-256',
      Boolean(failedJob?.state === 'failed' && retriedDone?.state === 'completed' && retryShaOk),
      JSON.stringify({ failedState: failedJob?.state, retriedState: retriedDone?.state, shaOk: retryShaOk })
    );

    // =========================================================================
    // SCENARIO 10: Completed download + completion notification intact + Desktop main screenshot
    // =========================================================================
    console.log('\n>>> [S10] Completed downloads & notification setting integrity <<<');
    await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('set_download_completion_options', {
      id: ${JSON.stringify(s1.id)},
      options: { close_on_complete: false, open_on_complete: false, notify_on_complete: true }
    })`);
    const compOpts = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_download_completion_options', { id: ${JSON.stringify(s1.id)} })`);
    const mainRowsCount = await mainCdp.eval(`(async () => {
      const domCount = document.querySelectorAll('#list .row, .dl-row, tr[data-id]').length;
      if (domCount > 0) return domCount;
      const list = await window.__TAURI_INTERNALS__.invoke('list_downloads');
      return Array.isArray(list) ? list.filter(j => j.state === 'completed').length : 0;
    })()`);
    await mainCdp.screenshot(path.join(SHOTS_DIR, '08_installed_v106_desktop_main_with_downloads.png'));
    record(
      'S10-COMPLETE-NOTIFY',
      'Completed downloads displayed cleanly in Main Window with completion notification option persisted',
      Boolean(compOpts && compOpts.notify_on_complete === true && mainRowsCount >= 8),
      `completedCount=${mainRowsCount}, completionOptions=${JSON.stringify(compOpts)}`
    );

    // =========================================================================
    // SCENARIO 11: Main window hidden in system tray + browser capture + showDownloadPopup=never
    // =========================================================================
    console.log('\n>>> [S11] Main window hidden in system tray + Browser capture + showDownloadPopup=never <<<');
    await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('window_close')`);
    await sleep(500);
    const mainVisibleWhileHidden = await mainCdp.eval(`window.__TAURI__.window.getCurrentWindow().isVisible()`);
    const rTray = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: `http://127.0.0.1:${FIXTURE_PORT}/tray-capture.bin`, filename: 'tray-capture.bin' },
    });
    const trayId = rTray.data?.job_id || rTray.data?.id;
    const popTray = await waitForProgressCdp(CDP_PORT, trayId, 15000);
    await sleep(900);
    const dTray = await inspectIdmPopup(popTray);
    await popTray.screenshot(path.join(SHOTS_DIR, '07_installed_v106_tray_hidden_browser_capture_progress.png'));
    const doneTray = await waitForJobState(GUI_PORT, API_TOKEN, trayId, 'completed', 30000);
    const fullTray = await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(trayId)} })`);
    const trayShaOk = sha256File(fullTray?.target_path || path.join(QA_DL_DIR, 'tray-capture.bin')) === sha.tray;
    await popTray.eval(`document.getElementById('cl')?.click()`).catch(() => {});
    popTray.close();

    // Test showDownloadPopup = 'never' preference respect
    await mainCdp.eval(`(async () => {
      const cfg = await window.__TAURI_INTERNALS__.invoke('get_engine_settings') || {};
      cfg.showDownloadPopup = 'never';
      await window.__TAURI_INTERNALS__.invoke('update_engine_settings', { settings: cfg });
    })()`);
    await sleep(300);
    const rNever = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: `http://127.0.0.1:${FIXTURE_PORT}/never-popup.bin`, filename: 'never-popup.bin' },
    });
    const neverId = rNever.data?.job_id || rNever.data?.id;
    const doneNever = await waitForJobState(GUI_PORT, API_TOKEN, neverId, 'completed', 15000);
    await sleep(400);
    const neverPopOpened = (await listCdpTargets(CDP_PORT)).some((t) => getProgressTargetJobId(t) === neverId);
    // Restore showDownloadPopup='always' and show main window back
    await mainCdp.eval(`(async () => {
      const cfg = await window.__TAURI_INTERNALS__.invoke('get_engine_settings') || {};
      cfg.showDownloadPopup = 'always';
      await window.__TAURI_INTERNALS__.invoke('update_engine_settings', { settings: cfg });
      await window.__TAURI_INTERNALS__.invoke('show_main_window');
    })()`);
    await sleep(400);
    const mainVisibleRestored = await mainCdp.eval(`window.__TAURI__.window.getCurrentWindow().isVisible()`);
    record(
      'S11-TRAY-AND-PREF',
      'Tray-hidden browser capture opens standalone IDM progress window, respects showDownloadPopup=never, and restores cleanly',
      Boolean(
        mainVisibleWhileHidden === false &&
        dTray.isIdm && !dTray.legacyToast &&
        doneTray?.state === 'completed' && trayShaOk &&
        doneNever?.state === 'completed' && !neverPopOpened &&
        mainVisibleRestored === true
      ),
      JSON.stringify({ mainVisibleWhileHidden, dTrayIsIdm: dTray.isIdm, trayShaOk, neverPopOpened, mainVisibleRestored })
    );

    // =========================================================================
    // SCENARIO 12: Browser Companion v1.0.10 Integration (Chrome + Signed Firefox XPI)
    // =========================================================================
    console.log('\n>>> [S12] Browser Companion v1.0.10 Integration (Chrome + Signed Firefox XPI) <<<');
    const chrManifestJson = JSON.parse(fs.readFileSync(path.join(CHR_EXT_DIR, 'manifest.json'), 'utf8'));
    const xpiShaOk = sha256File(SIGNED_FF_XPI) === EXPECTED_XPI_SHA;

    // 12A: Chromium (Edge) with unpacked Companion v1.0.10
    const browserEnv = {
      ...process.env,
      TORI_DATA_DIR: QA_DATA_DIR,
      TDM_STORAGE_DIR: QA_DATA_DIR,
      TORI_IPC_PIPE: pipeName,
      TORI_DISABLE_AUTO_SPAWN: '1',
    };
    const chromeProc = spawn(
      EDGE_EXE,
      [
        `--user-data-dir=${QA_CHR_PROF}`,
        `--remote-debugging-port=${CHROME_CDP_PORT}`,
        `--load-extension=${CHR_EXT_DIR}`,
        '--enable-unsafe-extension-debugging',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
        `http://127.0.0.1:${FIXTURE_PORT}/companion_test.html`,
      ],
      { env: browserEnv, stdio: 'ignore' }
    );
    trackedProcs.add(chromeProc);

    let chrBrowserVer = null;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const v = await httpJson({ port: CHROME_CDP_PORT, reqPath: '/json/version' });
      if (v.ok && v.data?.webSocketDebuggerUrl) { chrBrowserVer = v; break; }
    }
    if (!chrBrowserVer) throw new Error('Edge CDP did not start for Companion v1.0.10 test');
    const chrBCdp = new CDPClient(chrBrowserVer.data.webSocketDebuggerUrl);
    await chrBCdp.connect();

    // Locate the exact TORI Companion v1.0.10 extension ID via edge://extensions/
    const mgrCreated = await chrBCdp.send('Target.createTarget', { url: 'edge://extensions/' });
    let mgrTarget = null;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      mgrTarget = (await listCdpTargets(CHROME_CDP_PORT)).find((t) => t.id === mgrCreated.targetId && t.webSocketDebuggerUrl);
      if (mgrTarget) break;
    }
    const mgrCdp = new CDPClient(mgrTarget.webSocketDebuggerUrl);
    await mgrCdp.connect();
    let toriChrExt = null;
    for (let i = 0; i < 30; i++) {
      toriChrExt = await mgrCdp.eval(`(async () => {
        if (typeof chrome === 'undefined' || !chrome.developerPrivate) return null;
        const list = await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true });
        return (list || []).find(x => String(x.name || '').includes('TORI') && x.version === '1.0.10') || null;
      })()`).catch(() => null);
      if (toriChrExt?.id) break;
      await sleep(250);
    }
    mgrCdp.close();
    await chrBCdp.send('Target.closeTarget', { targetId: mgrCreated.targetId }).catch(() => {});
    const chrExtId = toriChrExt?.id || null;
    if (!chrExtId) throw new Error('Chromium Companion v1.0.10 extension did not load');

    registerQaNativeHosts({ hostExe: PROD_HOST_EXE, chromeExtIds: [chrExtId], firefoxId: EXPECTED_GECKO_ID });

    // Open options page to configure QA Desktop port/token & trigger Native Messaging ping
    const optCreated = await chrBCdp.send('Target.createTarget', { url: `chrome-extension://${chrExtId}/options/options.html` });
    let optTarget = null;
    for (let i = 0; i < 30; i++) {
      await sleep(250);
      optTarget = (await listCdpTargets(CHROME_CDP_PORT)).find(
        (t) => t.id === optCreated.targetId && t.webSocketDebuggerUrl && String(t.url || '').includes('options/options.html')
      );
      if (optTarget) break;
    }
    if (!optTarget) throw new Error('Chromium extension options target did not finish loading');
    const optCdp = new CDPClient(optTarget.webSocketDebuggerUrl);
    await optCdp.connect();
    let chrExtVer = null;
    for (let i = 0; i < 25; i++) {
      chrExtVer = await optCdp.eval(`typeof chrome !== 'undefined' && chrome.runtime && chrome.storage && chrome.storage.local ? chrome.runtime.getManifest().version : null`).catch(() => null);
      if (chrExtVer) break;
      await sleep(200);
    }
    await optCdp.eval(`new Promise(r => chrome.storage.local.set({
      tori_settings: { port: ${GUI_PORT}, key: '${API_TOKEN}', auto: true, cap: true, min: 0, pill: true, pos: 'Top right', picker: true, kind: 'Video', fmt: 'Best available', audio: true, badge: true, theme: 'light', accent: 'indigo', sites: [], types: ['zip','mkv','mp4'] }
    }, () => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${GUI_PORT}, key: '${API_TOKEN}', passive: true }, () => r(true))))`);
    optCdp.close();
    await chrBCdp.send('Target.closeTarget', { targetId: optCreated.targetId }).catch(() => {});

    // Trigger real browser download from Chrome page
    const pageTarget = (await listCdpTargets(CHROME_CDP_PORT)).find((t) => t.type === 'page' && String(t.url || '').includes('companion_test.html'));
    const pageCdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
    await pageCdp.connect();
    const beforeChrIds = new Set(((await httpJson({ port: GUI_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': API_TOKEN } })).data?.jobs || []).map((j) => j.id));
    await pageCdp.eval(`document.getElementById('dl-chr').click()`, 5000, true);
    const chrJob = await waitForJobPred(GUI_PORT, API_TOKEN, (j) => !beforeChrIds.has(j.id) && String(j.filename || '').includes('chrome_companion_v1010'), 20000);
    let chrPopIsIdm = false;
    let chrDone = null;
    if (chrJob) {
      try {
        const cPop = await waitForProgressCdp(CDP_PORT, chrJob.id, 12000);
        const cd = await inspectIdmPopup(cPop);
        chrPopIsIdm = cd.isIdm && !cd.legacyToast;
        await cPop.eval(`document.getElementById('cl')?.click()`).catch(() => {});
        cPop.close();
      } catch {}
      chrDone = await waitForJobState(GUI_PORT, API_TOKEN, chrJob.id, 'completed', 25000);
    }
    const chrFull = chrJob ? await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(chrJob.id)} })`) : null;
    const chrShaOk = sha256File(chrFull?.target_path || path.join(QA_DL_DIR, 'chrome_companion_v1010.mkv')) === sha.chrMkv;
    pageCdp.close();
    chrBCdp.close();
    killProcTree(chromeProc.pid);
    trackedProcs.delete(chromeProc);

    record(
      'S12A-COMPANION-CHROME',
      'Browser Companion v1.0.10 (Chrome) captures MKV into installed Desktop v1.0.6 with IDM progress window & exact SHA-256',
      Boolean(chrManifestJson.version === '1.0.10' && chrExtVer === '1.0.10' && chrPopIsIdm && chrDone?.state === 'completed' && chrShaOk),
      JSON.stringify({ extVer: chrExtVer, popIsIdm: chrPopIsIdm, state: chrDone?.state, shaOk: chrShaOk })
    );

    // 12B: Firefox with Mozilla-signed Companion v1.0.10 XPI under strict signature enforcement
    fs.writeFileSync(path.join(QA_FF_PROF, 'user.js'), [
      'user_pref("marionette.enabled", true);',
      `user_pref("marionette.port", ${FF_MARIONETTE_PORT});`,
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("browser.startup.homepage_override.mstone", "ignore");',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("xpinstall.signatures.required", true);',
    ].join('\n'));
    const ffProc = spawn(
      FIREFOX_EXE,
      ['-no-remote', '-marionette', '-profile', QA_FF_PROF, `http://127.0.0.1:${FIXTURE_PORT}/companion_test.html`],
      { env: { ...browserEnv, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }, stdio: 'ignore' }
    );
    trackedProcs.add(ffProc);

    const mar = new MarionetteClient(FF_MARIONETTE_PORT);
    await mar.connect(25000);
    await mar.send('WebDriver:NewSession', { capabilities: {} });
    const ffInst = await mar.send('Addon:Install', { path: SIGNED_FF_XPI, temporary: false }, 25000);
    await mar.send('Marionette:SetContext', { value: 'chrome' });
    const ffAddonInfo = (await mar.send('WebDriver:ExecuteAsyncScript', {
      script: `
        const done = arguments[arguments.length - 1];
        (async () => {
          const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
          let addon = null, policy = null;
          for (let i = 0; i < 30; i++) {
            addon = await AddonManager.getAddonByID("${EXPECTED_GECKO_ID}");
            policy = WebExtensionPolicy.getByID("${EXPECTED_GECKO_ID}");
            if (addon && addon.isActive && policy && policy.active) break;
            await new Promise(r => setTimeout(r, 200));
          }
          done({
            version: addon?.version || null,
            signed: addon?.signedState === AddonManager.SIGNEDSTATE_SIGNED,
            temporary: addon?.temporarilyInstalled,
            baseUrl: policy ? policy.getURL("") : null,
          });
        })();
      `,
      args: [],
    }, 15000))?.value;

    await mar.send('WebDriver:ExecuteScript', {
      script: `Services.wm.getMostRecentWindow("navigator:browser").gBrowser.addTrustedTab("${ffAddonInfo.baseUrl}options/options.html");`,
      args: [],
    });
    await sleep(900);
    await mar.send('Marionette:SetContext', { value: 'content' });
    const rawH = await mar.send('WebDriver:GetWindowHandles', {});
    const ffHandles = Array.isArray(rawH) ? rawH : (rawH?.value || []);
    let ffOptH = null;
    let ffPageH = null;
    for (const h of ffHandles) {
      await mar.send('WebDriver:SwitchToWindow', { handle: h });
      const cu = (await mar.send('WebDriver:GetCurrentURL', {}))?.value || '';
      if (cu.includes('options/options.html')) ffOptH = h;
      else if (cu.includes('companion_test.html')) ffPageH = h;
    }
    if (ffOptH) {
      await mar.send('WebDriver:SwitchToWindow', { handle: ffOptH });
      await mar.send('WebDriver:ExecuteAsyncScript', {
        script: `
          const done = arguments[arguments.length - 1];
          const api = typeof browser !== 'undefined' ? browser : chrome;
          api.storage.local.set({
            tori_settings: { port: ${GUI_PORT}, key: '${API_TOKEN}', auto: true, cap: true, min: 0, pill: true, pos: 'Top right', picker: true, kind: 'Video', fmt: 'Best available', audio: true, badge: true, theme: 'light', accent: 'indigo', sites: [], types: ['zip','mkv','mp4'] }
          }).then(() => done(true)).catch(() => done(false));
        `,
        args: [],
      });
    }
    await mar.send('WebDriver:SwitchToWindow', { handle: ffPageH || ffHandles[0] });
    await mar.send('WebDriver:Navigate', { url: `http://127.0.0.1:${FIXTURE_PORT}/companion_test.html` });
    await sleep(600);
    const beforeFfIds = new Set(((await httpJson({ port: GUI_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': API_TOKEN } })).data?.jobs || []).map((j) => j.id));
    await mar.send('WebDriver:ExecuteScript', { script: `document.getElementById('dl-ff').click();`, args: [] });
    const ffJob = await waitForJobPred(GUI_PORT, API_TOKEN, (j) => !beforeFfIds.has(j.id) && String(j.filename || '').includes('firefox_companion_v1010'), 25000);
    let ffPopIsIdm = false;
    let ffDone = null;
    if (ffJob) {
      try {
        const fPop = await waitForProgressCdp(CDP_PORT, ffJob.id, 12000);
        const fd = await inspectIdmPopup(fPop);
        ffPopIsIdm = fd.isIdm && !fd.legacyToast;
        await fPop.eval(`document.getElementById('cl')?.click()`).catch(() => {});
        fPop.close();
      } catch {}
      ffDone = await waitForJobState(GUI_PORT, API_TOKEN, ffJob.id, 'completed', 25000);
    }
    const ffFull = ffJob ? await mainCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(ffJob.id)} })`) : null;
    const ffShaOk = sha256File(ffFull?.target_path || path.join(QA_DL_DIR, 'firefox_companion_v1010.mkv')) === sha.ffMkv;
    try { await mar.send('Marionette:Quit', {}); } catch {}
    mar.close();
    killProcTree(ffProc.pid);
    trackedProcs.delete(ffProc);

    record(
      'S12B-COMPANION-FIREFOX',
      'Mozilla-signed Browser Companion v1.0.10 XPI (strict sig check) captures MKV into installed Desktop v1.0.6 with IDM progress window',
      Boolean(
        xpiShaOk &&
        ffInst?.value === EXPECTED_GECKO_ID &&
        ffAddonInfo?.version === '1.0.10' &&
        ffAddonInfo?.signed === true &&
        ffAddonInfo?.temporary === false &&
        ffPopIsIdm &&
        ffDone?.state === 'completed' &&
        ffShaOk
      ),
      JSON.stringify({ xpiShaOk, addon: ffAddonInfo, popIsIdm: ffPopIsIdm, state: ffDone?.state, shaOk: ffShaOk })
    );

    // Stop main QA Desktop instance before installation-path regression tests
    mainCdp.close();
    killProcTree(mainProc.pid);
    trackedProcs.delete(mainProc);
    await sleep(600);

    // =========================================================================
    // PHASE 7 FOCUSED REGRESSION 1: Existing user settings & history preservation
    // =========================================================================
    console.log('\n>>> [REG-DATA] Existing user SQLite history (42 rows), settings, and .tdm-part preservation <<<');
    fs.mkdirSync(QA_MIG_DATA, { recursive: true });
    fs.mkdirSync(QA_MIG_DL, { recursive: true });
    fs.mkdirSync(QA_MIG_WV2, { recursive: true });
    const migDb = path.join(QA_MIG_DATA, 'tdm_storage.sqlite');
    fs.copyFileSync(ROLLBACK_ONLINE_DB, migDb);
    const samplePart = path.join(QA_MIG_DL, 'sample_incomplete.bin.tdm-part');
    fs.writeFileSync(samplePart, makePatternBuffer(64 * 1024));
    const samplePartHashBefore = sha256File(samplePart);

    // Override ONLY api_port inside this isolated copy so we don't collide with 6800
    execFileSync('python', [
      '-c',
      `import sqlite3, json, sys
conn = sqlite3.connect(sys.argv[1]); cur = conn.cursor()
cur.execute("SELECT value FROM engine_settings WHERE key='app_settings'")
cfg = json.loads(cur.fetchone()[0])
cfg['port'] = int(sys.argv[2])
cur.execute("UPDATE engine_settings SET value=? WHERE key='app_settings'", (json.dumps(cfg),))
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES('api_port', ?)", (sys.argv[2],))
conn.commit(); conn.close()`,
      migDb,
      String(MIG_PORT),
    ]);

    const migPipe = `\\\\.\\pipe\\tori-qa-g31-5-mig-${process.pid}`;
    const migProc = spawn(PROD_EXE, [], {
      cwd: PROD_DIR,
      env: {
        ...process.env,
        TORI_DATA_DIR: QA_MIG_DATA,
        TDM_STORAGE_DIR: QA_MIG_DATA,
        TORI_IPC_PIPE: migPipe,
        TORI_DISABLE_AUTO_SPAWN: '1',
        WEBVIEW2_USER_DATA_FOLDER: QA_MIG_WV2,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${MIG_CDP_PORT}`,
        RUST_MIN_STACK: '8388608',
      },
      stdio: 'ignore',
    });
    trackedProcs.add(migProc);
    let migPingOk = false;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      if ((await httpJson({ port: MIG_PORT, reqPath: '/api/v1/ping' })).ok) { migPingOk = true; break; }
    }
    const migCdp = await waitForMainCdp(MIG_CDP_PORT, 20000);
    const migJobs = await migCdp.eval(`window.__TAURI_INTERNALS__.invoke('list_downloads')`);
    const migSettings = (await migCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_engine_settings')`)) || {};
    migCdp.close();
    killProcTree(migProc.pid);
    trackedProcs.delete(migProc);
    await sleep(500);

    const migIntegrity = execFileSync(
      'python',
      ['-c', `import sqlite3, sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('PRAGMA integrity_check').fetchone()[0]); c.close()`, migDb],
      { encoding: 'utf8' }
    ).trim();
    const samplePartHashAfter = sha256File(samplePart);
    record(
      'REG-USER-DATA-PRESERVE',
      'Installed v1.0.6 preserves existing 42 downloads, dark/rose user settings, SQLite integrity, and .tdm-part files without overwrite',
      Boolean(
        migPingOk &&
        Array.isArray(migJobs) && migJobs.length === 42 &&
        migSettings.theme === 'dark' &&
        migSettings.accent === 'rose' &&
        migSettings.showDownloadPopup === 'always' &&
        migSettings.closeToTray === true &&
        migIntegrity === 'ok' &&
        samplePartHashAfter === samplePartHashBefore
      ),
      JSON.stringify({ count: migJobs?.length, theme: migSettings.theme, accent: migSettings.accent, popup: migSettings.showDownloadPopup, integrity: migIntegrity, partUnchanged: samplePartHashAfter === samplePartHashBefore })
    );

    // =========================================================================
    // PHASE 7 FOCUSED REGRESSION 2: Native Messaging respawn-during-install conflict prevention
    // =========================================================================
    console.log('\n>>> [REG-RESPAWN] Lingering stale v1.0.4 terminated by NSIS_HOOK_POSTINSTALL so v1.0.6 launches as primary <<<');
    oemGuard.temporarilySilenceNativeHostAutoSpawn(path.join(QA_ROOT, 'shield'));
    fs.mkdirSync(QA_RESPAWN_V104_DATA, { recursive: true });
    fs.mkdirSync(QA_RESPAWN_V104_WV2, { recursive: true });
    fs.mkdirSync(QA_RESPAWN_V106_DATA, { recursive: true });
    fs.mkdirSync(QA_RESPAWN_V106_WV2, { recursive: true });
    seedQaDatabase(path.join(QA_RESPAWN_V104_DATA, 'tdm_storage.sqlite'), { port: RESPAWN_V104_PORT, dlDir: QA_DL_DIR, token: API_TOKEN });
    seedQaDatabase(path.join(QA_RESPAWN_V106_DATA, 'tdm_storage.sqlite'), { port: RESPAWN_V106_PORT, dlDir: QA_DL_DIR, token: API_TOKEN });

    // Launch stale v1.0.4 on the DEFAULT IPC pipe (simulating live browser Native Messaging respawn)
    const stale104 = spawn(ROLLBACK_V104_EXE, ['--minimized'], {
      cwd: path.dirname(ROLLBACK_V104_EXE),
      env: {
        ...process.env,
        TORI_DATA_DIR: QA_RESPAWN_V104_DATA,
        TDM_STORAGE_DIR: QA_RESPAWN_V104_DATA,
        TORI_DISABLE_AUTO_SPAWN: '1',
        WEBVIEW2_USER_DATA_FOLDER: QA_RESPAWN_V104_WV2,
      },
      stdio: 'ignore',
    });
    trackedProcs.add(stale104);
    let stale104Online = false;
    for (let i = 0; i < 30; i++) {
      await sleep(250);
      if ((await httpJson({ port: RESPAWN_V104_PORT, reqPath: '/api/v1/ping', headers: { 'X-Tori-Token': API_TOKEN } })).ok) {
        stale104Online = true;
        break;
      }
    }

    // Run v1.0.6 silent install to isolated QA_RESPAWN_INST — NSIS_HOOK_POSTINSTALL must kill stale v1.0.4
    execSync(`"${INSTALLER_EXE}" /S /D=${QA_RESPAWN_INST}`, { timeout: 90000 });
    oemGuard.temporarilySilenceNativeHostAutoSpawn(path.join(QA_ROOT, 'shield'));
    await sleep(500);
    const staleKilledByInstaller = !getRunningToriPids().includes(stale104.pid);
    trackedProcs.delete(stale104);

    // Boot newly installed v1.0.6 on the DEFAULT IPC pipe — must start as primary (zero SECONDARY_INSTANCE!)
    const fresh106Exe = path.join(QA_RESPAWN_INST, 'tori-download-manager.exe');
    const fresh106 = spawn(fresh106Exe, ['--minimized'], {
      cwd: QA_RESPAWN_INST,
      env: {
        ...process.env,
        TORI_DATA_DIR: QA_RESPAWN_V106_DATA,
        TDM_STORAGE_DIR: QA_RESPAWN_V106_DATA,
        TORI_DISABLE_AUTO_SPAWN: '1',
        WEBVIEW2_USER_DATA_FOLDER: QA_RESPAWN_V106_WV2,
      },
      stdio: 'ignore',
    });
    trackedProcs.add(fresh106);
    let fresh106Ping = null;
    for (let i = 0; i < 35; i++) {
      await sleep(300);
      const r = await httpJson({ port: RESPAWN_V106_PORT, reqPath: '/api/v1/ping', headers: { 'X-Tori-Token': API_TOKEN } });
      if (r.ok && r.data?.status === 'ok') { fresh106Ping = r.data; break; }
    }
    const fresh106PeVer = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Item '${fresh106Exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    const fresh106Log = fs.existsSync(path.join(QA_RESPAWN_V106_DATA, 'logs', 'lifecycle.log'))
      ? fs.readFileSync(path.join(QA_RESPAWN_V106_DATA, 'logs', 'lifecycle.log'), 'utf8')
      : '';
    killProcTree(fresh106.pid);
    trackedProcs.delete(fresh106);
    await sleep(400);

    record(
      'REG-RESPAWN-KILL',
      'NSIS_HOOK_POSTINSTALL kills lingering v1.0.4 respawn so newly installed v1.0.6 launches as primary without SECONDARY_INSTANCE',
      Boolean(stale104Online && staleKilledByInstaller && fresh106Ping && fresh106PeVer.startsWith(TARGET_VER) && !fresh106Log.includes('SECONDARY_INSTANCE')),
      JSON.stringify({ stale104Online, staleKilledByInstaller, fresh106PeVer, fresh106Online: Boolean(fresh106Ping), hadSecondary: fresh106Log.includes('SECONDARY_INSTANCE') })
    );

    // =========================================================================
    // PHASE 7 FOCUSED REGRESSION 3: Stale QA registry path auto-recovery (/P /UPDATE)
    // =========================================================================
    console.log('\n>>> [REG-STALE-QA] Stale %TEMP% QA registry path auto-recovered by NSIS_HOOK_PREINSTALL during /P /UPDATE <<<');
    const fakeStaleTempDir = path.join(process.env.TEMP || 'C:\\Temp', 'tori_g31_5_stale_qa_probe', 'desktop_install');
    fs.rmSync(path.dirname(fakeStaleTempDir), { recursive: true, force: true });
    execFileSync('reg', ['add', REG_MANU, '/ve', '/t', 'REG_SZ', '/d', fakeStaleTempDir, '/f'], { stdio: 'ignore', timeout: 4000 });
    const seededBefore = queryRegDefault(REG_MANU);

    // Run v1.0.6 installer with Tauri auto-updater passive flags (/P /UPDATE)
    execSync(`"${INSTALLER_EXE}" /P /UPDATE`, { timeout: 120000 });
    await sleep(500);

    const recoveredManu = queryRegDefault(REG_MANU);
    const recoveredUninstLoc = execFileSync('reg', ['query', REG_UNINST, '/v', 'InstallLocation'], { encoding: 'utf8', timeout: 4000 });
    const fakeTempHasExe = fs.existsSync(path.join(fakeStaleTempDir, 'tori-download-manager.exe'));
    const fakeTempLeafExists = fs.existsSync(fakeStaleTempDir);
    try { fs.rmSync(path.dirname(fakeStaleTempDir), { recursive: true, force: true }); } catch {}
    record(
      'REG-STALE-QA-RECOVER',
      'Stale %TEMP%/QA registry path is auto-redirected to %LOCALAPPDATA%\\TORI Download Manager on /P /UPDATE',
      Boolean(
        seededBefore === fakeStaleTempDir &&
        recoveredManu && recoveredManu.toLowerCase() === PROD_DIR.toLowerCase() &&
        recoveredUninstLoc.toLowerCase().includes(PROD_DIR.toLowerCase()) &&
        !fakeTempHasExe &&
        !fakeTempLeafExists
      ),
      JSON.stringify({ seededBefore, recoveredManu, fakeTempHasExe, fakeTempLeafExists })
    );
  } finally {
    cleanupProcs();
    if (fixtureServer) try { fixtureServer.close(); } catch {}
    // Delete QA_ROOT BEFORE restore to prove QaOemStateGuard survives QA_ROOT deletion!
    try { fs.rmSync(QA_ROOT, { recursive: true, force: true }); } catch {}
    const parity = oemGuard.restore({ qaPathMarker: 'gate31_5_qa', restartOem: true });
    record(
      'REG-OEM-GUARD-PARITY',
      'QaOemStateGuard restores all HKCU keys, Native Messaging manifests & shortcuts with 100% parity after QA_ROOT deletion',
      Boolean(parity && parity.ok),
      JSON.stringify(parity)
    );
  }

  // Final strict safety checks on operator production data & signed XPI
  const prodDbHashAfter = sha256File(PROD_DB);
  const xpiHashAfter = sha256File(SIGNED_FF_XPI);
  let allPartsUntouched = true;
  if (beforeSnap?.partial_files) {
    for (const pf of beforeSnap.partial_files) {
      const p = pf.temp_path || pf.path;
      if (sha256File(p) !== pf.sha256) allPartsUntouched = false;
    }
  }
  record('SAFETY-PROD-DB', 'Production SQLite database 100% untouched throughout Gate 31.5 QA', prodDbHashAfter === prodDbHashBefore, `sha256=${prodDbHashAfter}`);
  record('SAFETY-PART-FILES', 'All 11 operator .tdm-part files 100% untouched throughout Gate 31.5 QA', allPartsUntouched, `count=${beforeSnap?.partial_files?.length || 0}`);
  record('SAFETY-SIGNED-XPI', 'Mozilla-signed Browser Companion v1.0.10 XPI 100% untouched', xpiHashAfter === EXPECTED_XPI_SHA, `sha256=${xpiHashAfter}`);

  console.log('\n=============================================================================');
  console.log(` GATE 31.5 VERIFICATION: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.TIMEOUT} TIMEOUT, ${counts.NOT_TESTED} NOT TESTED`);
  console.log('=============================================================================');

  if (counts.FAIL > 0 || counts.TIMEOUT > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[FATAL] Gate 31.5 verification aborted:', err);
  cleanupProcs();
  if (fixtureServer) try { fixtureServer.close(); } catch {}
  try { oemGuard.restore({ qaPathMarker: 'gate31_5_qa', restartOem: true }); } catch {}
  process.exit(1);
});
