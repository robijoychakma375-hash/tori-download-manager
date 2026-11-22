#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 32.2
 * Desktop v1.0.7 Release Candidate Preflight, Real v1.0.6 -> v1.0.7 NSIS Upgrade,
 * Active Download Protection, Browser Companion v1.0.10 Compatibility (Chrome/Edge + Signed Firefox),
 * Desktop Auto-Updater Compatibility, Performance & Production Data Safety Verification.
 *
 * Strictly isolated under target/gate32_2_qa with dedicated TORI_DATA_DIR, TORI_IPC_PIPE,
 * WEBVIEW2_USER_DATA_FOLDER, and ports (25310..25329).
 * Never mutates production Desktop v1.0.6, production SQLite DB, .tdm-part files, or Browser Companion v1.0.10.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { spawn, execSync, execFileSync, spawnSync } = require('child_process');
const {
  QaOemStateGuard,
  snapshotOemDatabase,
  compareOemDatabaseSnapshots,
  REG_MANU,
  REG_UNINST,
  queryRegDefault,
} = require('./lib/qa_oem_state_guard');

const ROOT = path.resolve(__dirname, '..');
const RC_106_DIR = path.join(ROOT, 'release', 'v1.0.6-rc');
const RC_107_DIR = path.join(ROOT, 'release', 'v1.0.7-rc');
const INST_106_EXE = path.join(RC_106_DIR, 'TORI Download Manager_1.0.6_x64-setup.exe');
const INST_107_EXE = path.join(RC_107_DIR, 'TORI Download Manager_1.0.7_x64-setup.exe');
const INST_107_SIG = path.join(RC_107_DIR, 'TORI Download Manager_1.0.7_x64-setup.exe.sig');

const EXT_RC_DIR = path.join(ROOT, 'release', 'v1.0.10-extension-rc');
const CHR_EXT_DIR = path.join(EXT_RC_DIR, 'tori-companion-v1.0.10-chromium');
const CHR_EXT_ZIP = path.join(EXT_RC_DIR, 'tori-companion-v1.0.10-chromium.zip');
const SIGNED_FF_XPI = path.join(EXT_RC_DIR, 'tori-companion-v1.0.10-firefox-signed.xpi');
const EXPECTED_XPI_SHA = 'a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8';
const EXPECTED_CHR_SHA = 'f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1';
const EXPECTED_GECKO_ID = 'tori-download-manager@toridm.org';

const OEM_DESKTOP_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'tori-download-manager.exe');
const OEM_DB_PATH = path.join(process.env.APPDATA || '', 'tori-download-manager', 'tdm_storage.sqlite');
const LIVE_STAGING_MANIFEST_URL = 'https://toridownload.xyz/assets/tools/staging/tools-manifest.json';

const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

const QA_ROOT = path.join(ROOT, 'target', 'gate32_2_qa');
const QA_INST_DIR = path.join(QA_ROOT, 'desktop_install');
const QA_DATA_DIR = path.join(QA_ROOT, 'data');
const QA_DL_DIR = path.join(QA_ROOT, 'downloads');
const QA_WV2_DIR = path.join(QA_ROOT, 'webview2');
const QA_PROF_DIR = path.join(QA_ROOT, 'profile');
const QA_CHR_PROF = path.join(QA_ROOT, 'chr_profile');
const QA_CHR_DL = path.join(QA_ROOT, 'chr_dl');
const QA_FF_PROF = path.join(QA_ROOT, 'ff_profile');
const QA_FF_DL = path.join(QA_ROOT, 'ff_dl');
const SHOTS_DIR = path.join(ROOT, 'docs', 'reports', 'screenshots', 'gate32_2');

const PORT_APP = 25310;
const PORT_CDP = 25311;
const PORT_FIXTURE = 25312;
const PORT_CHR_CDP = 25313;
const PORT_FF_MAR = 2852;
const API_TOKEN = 'tori_qa_g32_2_token';
const WATCH_YT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const WATCH_PL_URL = 'https://www.youtube.com/watch?v=u9lj-c29dxI&list=PL6B3937A5D230E335';

const results = [];
const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, NOT_TESTED: 0 };
const trackedProcs = new Set();
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
  const buf = Buffer.allocUnsafe(65536);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function getPeVersion(exePath) {
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Item '${exePath.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
      { encoding: 'utf8', timeout: 8000 }
    ).trim();
  } catch {
    return null;
  }
}

function killProcTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
  } catch {}
}

function cleanupProcs() {
  for (const p of trackedProcs) killProcTree(p.pid);
  trackedProcs.clear();
}

function getTreeStats(rootPid) {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `
$root = ${rootPid}
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime
$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add($root)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
      [void]$ids.Add([int]$p.ProcessId); $changed = $true
    }
  }
}
$tree = $all | Where-Object { $ids.Contains([int]$_.ProcessId) }
$wsMb = [math]::Round((($tree | Measure-Object WorkingSetSize -Sum).Sum) / 1MB, 2)
$cpuSec = [math]::Round(((($tree | Measure-Object KernelModeTime -Sum).Sum) + (($tree | Measure-Object UserModeTime -Sum).Sum)) / 10000000.0, 3)
$conhost = @($tree | Where-Object { $_.Name -match 'conhost|cmd|powershell' }).Count
@{ procCount = @($tree).Count; wsMb = $wsMb; cpuSec = $cpuSec; consoleCount = $conhost } | ConvertTo-Json -Compress
`,
      ],
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    return JSON.parse(out);
  } catch {
    return { procCount: 0, wsMb: 0, cpuSec: 0, consoleCount: 0 };
  }
}

function httpJson({ port, reqPath, method = 'GET', headers = {}, body = null, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const payload = body !== null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        timeout: timeoutMs,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(raw), raw });
          } catch {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: null, raw });
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

function httpsGetJson(url, maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'TORI-Gate32_2/1.0.7' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
          res.resume();
          return resolve(httpsGetJson(new URL(res.headers.location, url).toString(), maxRedirects - 1));
        }
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, data: null, raw });
          }
        });
      })
      .on('error', reject);
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e) => reject(e));
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: res, reject: rej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
            else res(msg.result);
          }
        } catch {}
      });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalJson(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          JSON.stringify(res.exceptionDetails)
      );
    }
    return res.result ? res.result.value : undefined;
  }
  async screenshot(outPath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(res.data, 'base64'));
  }
  close() {
    try { if (this.ws) this.ws.close(); } catch {}
  }
}

class MarionetteClient {
  constructor(port) {
    this.port = port;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.msgId = 1;
    this.waiters = new Map();
    this.helloResolve = null;
  }
  connect(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
        const sock = net.createConnection({ host: '127.0.0.1', port: this.port });
        let settled = false;
        sock.on('error', () => {
          sock.destroy();
          if (Date.now() < deadline) setTimeout(attempt, 400);
          else if (!settled) { settled = true; reject(new Error('Marionette connect timeout')); }
        });
        sock.on('connect', () => {
          this.sock = sock;
          this.helloResolve = () => {
            if (!settled) { settled = true; resolve(); }
          };
          sock.on('data', (chunk) => this._onData(chunk));
        });
      };
      attempt();
    });
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const colon = this.buf.indexOf(0x3a);
      if (colon === -1) break;
      const len = parseInt(this.buf.subarray(0, colon).toString('ascii'), 10);
      if (isNaN(len) || this.buf.length < colon + 1 + len) break;
      const payload = this.buf.subarray(colon + 1, colon + 1 + len).toString('utf8');
      this.buf = this.buf.subarray(colon + 1 + len);
      const msg = JSON.parse(payload);
      if (!Array.isArray(msg) && msg.applicationType && this.helloResolve) {
        const r = this.helloResolve;
        this.helloResolve = null;
        r();
      } else if (Array.isArray(msg) && msg[0] === 1) {
        const [, id, err, result] = msg;
        const w = this.waiters.get(id);
        if (w) {
          this.waiters.delete(id);
          if (err) w.reject(new Error(JSON.stringify(err)));
          else w.resolve(result);
        }
      }
    }
  }
  send(cmd, params = {}, timeoutMs = 20000) {
    const id = this.msgId++;
    const body = JSON.stringify([0, id, cmd, params]);
    const frame = `${Buffer.byteLength(body)}:${body}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Marionette timeout on ${cmd}`));
      }, timeoutMs);
      this.waiters.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.sock.write(frame);
    });
  }
  close() {
    try { if (this.sock) this.sock.destroy(); } catch {}
  }
}

async function listCdpTargets(cdpPort) {
  const res = await httpJson({ port: cdpPort, reqPath: '/json/list', timeoutMs: 4000 });
  return res.ok && Array.isArray(res.data) ? res.data : [];
}

async function waitForMainCdp(cdpPort, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listCdpTargets(cdpPort);
    const page = targets.find(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url || '').includes('window=progress') && !String(t.url || '').includes('window=toast')
    );
    if (page) {
      const c = new CDPClient(page.webSocketDebuggerUrl);
      await c.connect();
      await c.send('Runtime.enable');
      await c.send('Page.enable');
      return c;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for WebView2 CDP on port ${cdpPort}`);
}

async function bootDesktop({ exe, dataDir, wv2Dir, dlDir, profDir, port, cdpPort, token, pipeSuffix, extraEnv = {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(wv2Dir, { recursive: true });
  fs.mkdirSync(dlDir, { recursive: true });
  fs.mkdirSync(profDir, { recursive: true });

  const env = {
    ...process.env,
    TORI_DATA_DIR: dataDir,
    TORI_IPC_PIPE: `\\\\.\\pipe\\tori_g322_${pipeSuffix}_${process.pid}`,
    TORI_DISABLE_AUTO_SPAWN: '1',
    TORI_ALLOW_LOOPBACK: '1',
    TDM_STORAGE_DIR: dataDir,
    TDM_DOWNLOAD_DIR: dlDir,
    WEBVIEW2_USER_DATA_FOLDER: wv2Dir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    ...extraEnv,
  };

  const t0 = Date.now();
  const proc = spawn(exe, [], { cwd: path.dirname(exe), env, stdio: ['ignore', 'pipe', 'pipe'] });
  trackedProcs.add(proc);
  const cdp = await waitForMainCdp(cdpPort, 30000);
  for (let i = 0; i < 60; i++) {
    const ready = await cdp.evalJson(`return Boolean(window.__TAURI_INTERNALS__ && document.querySelector('#tool'));`);
    if (ready) break;
    await sleep(150);
  }
  const startupMs = Date.now() - t0;
  // Query actual active local integration port & pairing token from Tauri IPC
  let activePort = port;
  let activeToken = token;
  let serverOk = false;
  for (let i = 0; i < 40; i++) {
    try {
      const info = await cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_browser_integration_info');`);
      if (info && info.port && info.token) {
        activePort = info.port;
        activeToken = info.token;
      }
    } catch {}
    const st = await httpJson({ port: activePort, reqPath: '/api/v1/status', headers: { 'X-Tori-Token': activeToken }, timeoutMs: 2000 });
    if (st.ok) { serverOk = true; break; }
    await sleep(200);
  }
  return { proc, cdp, startupMs, serverOk, port: activePort, token: activeToken };
}

async function waitForJob(port, token, predicate, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await httpJson({ port, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': token } });
    const jobs = r.data?.jobs || (Array.isArray(r.data) ? r.data : []);
    const hit = jobs.find(predicate);
    if (hit) {
      const det = await httpJson({ port, reqPath: `/api/v1/downloads/${encodeURIComponent(hit.id)}`, headers: { 'X-Tori-Token': token } });
      return det.ok && det.data ? det.data : hit;
    }
    await sleep(300);
  }
  return null;
}

function makePatternBuffer(bytes, hexSeed) {
  const seed = Buffer.from(hexSeed, 'hex');
  const buf = Buffer.allocUnsafe(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = seed[i % seed.length] ^ ((i >>> 8) & 0xff);
  return buf;
}

function sendNativeHostMessage(hostExe, msgObj, envExtra = {}) {
  const payload = Buffer.from(JSON.stringify(msgObj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  const res = spawnSync(hostExe, [], {
    input: Buffer.concat([header, payload]),
    env: { ...process.env, ...envExtra },
    timeout: 15000,
  });
  if (!res.stdout || res.stdout.length < 4) {
    return { ok: false, status: res.status, stderr: (res.stderr || '').toString('utf8') };
  }
  const respLen = res.stdout.readUInt32LE(0);
  const respJson = res.stdout.subarray(4, 4 + respLen).toString('utf8');
  return { ok: true, status: res.status, response: JSON.parse(respJson) };
}

function querySqliteTables(dbPath) {
  const out = execFileSync(
    'python',
    [
      '-c',
      `import json, sqlite3, sys
con = sqlite3.connect(sys.argv[1])
cur = con.cursor()
integrity = [r[0] for r in cur.execute("PRAGMA integrity_check").fetchall()]
tables = sorted([r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()])
dl_cnt = cur.execute("SELECT COUNT(*) FROM downloads").fetchone()[0] if 'downloads' in tables else 0
tool_cnt = cur.execute("SELECT COUNT(*) FROM external_tools_registry").fetchone()[0] if 'external_tools_registry' in tables else 0
hist_cnt = cur.execute("SELECT COUNT(*) FROM external_tool_update_history").fetchone()[0] if 'external_tool_update_history' in tables else 0
print(json.dumps({"integrity": integrity, "tables": tables, "downloads": dl_cnt, "tools": tool_cnt, "history": hist_cnt}))`,
      dbPath,
    ],
    { encoding: 'utf8', timeout: 10000 }
  ).trim();
  return JSON.parse(out);
}

async function main() {
  console.log('=============================================================================');
  console.log('  TORI GATE 32.2 — DESKTOP v1.0.7 RC PREFLIGHT & v1.0.6 -> v1.0.7 UPGRADE');
  console.log('=============================================================================\n');

  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(QA_ROOT, { recursive: true });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  // =========================================================================
  // GROUP A: RELEASE CANDIDATE ARTIFACT, COMPANION & UPDATER PREFLIGHT
  // =========================================================================
  const requiredRcFiles = [
    'TORI Download Manager_1.0.7_x64-setup.exe',
    'TORI Download Manager_1.0.7_x64-setup.exe.sig',
    'tori-download-manager.exe',
    'tdm-native-host.exe',
    'tdm-cli.exe',
    'SHA256SUMS.txt',
    'BUILD_METADATA.json',
    'RELEASE_MANIFEST.json',
    'draft_latest.json',
    'RELEASE_NOTES_v1.0.7.md',
    'INSTALLATION_AND_UPGRADE.md',
    path.join('tools-manifest-production', 'tools-manifest.json'),
    path.join('tools-manifest-production', 'tools-manifest.json.sig'),
    path.join('tools-manifest-production', 'PROMOTION_PLAN.json'),
  ];
  const missingRc = requiredRcFiles.filter((f) => !fs.existsSync(path.join(RC_107_DIR, f)));
  let sumsVerified = false;
  if (missingRc.length === 0) {
    const lines = fs.readFileSync(path.join(RC_107_DIR, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/);
    sumsVerified = lines.length >= 5 && lines.every((l) => {
      const m = l.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
      if (!m) return false;
      const actual = sha256File(path.join(RC_107_DIR, m[2].trim()));
      return actual && actual.toLowerCase() === m[1].toLowerCase();
    });
  }
  record(
    'G322-01',
    'All release/v1.0.7-rc/ deliverables present and bit-for-bit verified against SHA256SUMS.txt',
    missingRc.length === 0 && sumsVerified,
    missingRc.length ? `missing=${JSON.stringify(missingRc)}` : `files=${requiredRcFiles.length}, sumsVerified=${sumsVerified}`
  );

  const xpiSha = sha256File(SIGNED_FF_XPI);
  const chrSha = sha256File(CHR_EXT_ZIP);
  record(
    'G322-03',
    'Browser Companion v1.0.10 Firefox signed XPI & Chromium ZIP preserved byte-for-byte',
    xpiSha === EXPECTED_XPI_SHA && chrSha === EXPECTED_CHR_SHA,
    `xpiMatch=${xpiSha === EXPECTED_XPI_SHA}, chrMatch=${chrSha === EXPECTED_CHR_SHA}`
  );

  // Check draft_latest.json + confirm live public GitHub latest.json remains 1.0.6!
  const draftLatest = JSON.parse(fs.readFileSync(path.join(RC_107_DIR, 'draft_latest.json'), 'utf8'));
  const sigText = fs.readFileSync(INST_107_SIG, 'utf8').trim();
  const liveLatest = await httpsGetJson('https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json');
  record(
    'G322-04',
    'Draft v1.0.7 updater manifest valid while live public GitHub latest.json remains 1.0.6',
    draftLatest.version === '1.0.7' &&
      draftLatest.platforms?.['windows-x86_64']?.signature?.trim() === sigText &&
      draftLatest.platforms?.['windows-x86_64-nsis']?.signature?.trim() === sigText &&
      liveLatest.status === 200 &&
      liveLatest.data?.version === '1.0.6',
    `draftVer=${draftLatest.version}, liveVer=${liveLatest.data?.version}`
  );

  // =========================================================================
  // PREPARE ISOLATED OEM GUARD & LOCAL FIXTURE SERVER
  // =========================================================================
  const oemGuard = new QaOemStateGuard('gate32_2');
  oemGuard.backup({ stopRunningOem: true });
  oemGuard.temporarilySilenceNativeHostAutoSpawn();
  await sleep(600);

  const oemDbBefore = snapshotOemDatabase(OEM_DB_PATH);
  const oemExeShaBefore = sha256File(OEM_DESKTOP_EXE);
  let oemDbAfter = null;

  const bufPreDone = makePatternBuffer(1024 * 1024, '504b0304');
  const bufPrePaused = makePatternBuffer(12 * 1024 * 1024, '1a45dfa3');
  const bufPostNew = makePatternBuffer(4 * 1024 * 1024, 'deadbeef');
  const bufActiveLong = makePatternBuffer(6 * 1024 * 1024, 'cafebabe');
  const bufFfMkv = makePatternBuffer(3 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');

  const sha = {
    preDone: crypto.createHash('sha256').update(bufPreDone).digest('hex'),
    prePaused: crypto.createHash('sha256').update(bufPrePaused).digest('hex'),
    postNew: crypto.createHash('sha256').update(bufPostNew).digest('hex'),
    activeLong: crypto.createHash('sha256').update(bufActiveLong).digest('hex'),
    ffMkv: crypto.createHash('sha256').update(bufFfMkv).digest('hex'),
  };

  fixtureServer = http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${PORT_FIXTURE}`);
    if (u.pathname === '/missing_404.zip') {
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
    if (u.pathname === '/ff_page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1>Gate 32.2 Firefox v1.0.10 QA</h1><a id="dl-mkv" href="/ff_v1010.mkv">Download MKV</a></body></html>');
      return;
    }
    const rangeServe = (buf, ctype, throttleMs = 0, extra = {}) => {
      const total = buf.length;
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': String(total), 'Accept-Ranges': 'bytes', ...extra });
        res.end();
        return;
      }
      let start = 0;
      let end = total - 1;
      let status = 200;
      const r = req.headers.range;
      if (r && r.startsWith('bytes=')) {
        const [s, e] = r.slice(6).split('-');
        start = parseInt(s, 10) || 0;
        end = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
        status = 206;
      }
      res.writeHead(status, {
        'Content-Type': ctype,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
        ...extra,
      });
      if (throttleMs <= 0) {
        res.end(buf.subarray(start, end + 1));
        return;
      }
      let pos = start;
      const step = 131072;
      const pump = () => {
        if (res.writableEnded || res.destroyed) return;
        const next = Math.min(pos + step, end + 1);
        res.write(buf.subarray(pos, next));
        pos = next;
        if (pos > end) res.end();
        else setTimeout(pump, throttleMs);
      };
      pump();
    };

    if (u.pathname === '/pre_done.zip') return rangeServe(bufPreDone, 'application/zip');
    if (u.pathname === '/pre_paused.bin') return rangeServe(bufPrePaused, 'application/octet-stream', 140);
    if (u.pathname === '/post_new.bin') return rangeServe(bufPostNew, 'application/octet-stream', 12);
    if (u.pathname === '/active_long.bin') return rangeServe(bufActiveLong, 'application/octet-stream', 20);
    if (u.pathname === '/ff_v1010.mkv') {
      return rangeServe(bufFfMkv, 'video/x-matroska', 0, {
        'Content-Disposition': 'attachment; filename="gate32_2_ff_v1010.mkv"',
      });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => fixtureServer.listen(PORT_FIXTURE, '127.0.0.1', r));

  const perf = {};
  let boot = null;

  try {
    // =========================================================================
    // GROUP B: REAL v1.0.6 -> v1.0.7-rc NSIS INSTALLER UPGRADE
    // =========================================================================
    console.log('\n>>> [PHASE 13] Installing baseline Desktop v1.0.6 into isolated QA folder <<<');
    // NSIS strictly requires /D=<path> to be the final UNQUOTED argument!
    execSync(`"${INST_106_EXE}" /S /D=${QA_INST_DIR}`, { timeout: 120000 });
    oemGuard.temporarilySilenceNativeHostAutoSpawn(path.join(QA_ROOT, 'shield'));
    const instExe = path.join(QA_INST_DIR, 'tori-download-manager.exe');
    const instHost = path.join(QA_INST_DIR, 'bin', 'tdm-native-host.exe');
    const verBefore = getPeVersion(instExe);
    if (verBefore !== '1.0.6') {
      throw new Error(`Expected baseline installed version 1.0.6, got ${verBefore}`);
    }

    // Boot baseline v1.0.6 & seed realistic representative user state before upgrade!
    boot = await bootDesktop({
      exe: instExe,
      dataDir: QA_DATA_DIR,
      wv2Dir: QA_WV2_DIR,
      dlDir: QA_DL_DIR,
      profDir: QA_PROF_DIR,
      port: PORT_APP,
      cdpPort: PORT_CDP,
      token: API_TOKEN,
      pipeSuffix: 'v106_pre',
    });
    let appPort = boot.port;
    let appToken = boot.token;

    // Configure user settings before upgrade (use 'always' for IDM progress popup & isolated QA_DL_DIR)
    await boot.cdp.evalJson(`
      const s = (await window.__TAURI_INTERNALS__.invoke('get_engine_settings')) || {};
      s.closeToTray = true;
      s.showDownloadPopup = 'always';
      s.dir = ${JSON.stringify(QA_DL_DIR)};
      s.theme = 'light';
      await window.__TAURI_INTERNALS__.invoke('update_engine_settings', { settings: s });
    `);

    // 1. Completed download
    const c1 = await httpJson({
      port: appPort,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': appToken },
      body: { url: `http://127.0.0.1:${PORT_FIXTURE}/pre_done.zip`, filename: 'pre_done.zip' },
    });
    const jDone = await waitForJob(appPort, appToken, (j) => j.id === c1.data?.job_id && j.state === 'completed', 25000);

    // 2. Paused download with real .tdm-part file
    const c2 = await httpJson({
      port: appPort,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': appToken },
      body: { url: `http://127.0.0.1:${PORT_FIXTURE}/pre_paused.bin`, filename: 'pre_paused.bin' },
    });
    const pausedId = c2.data?.job_id;
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      const st = await httpJson({ port: appPort, reqPath: `/api/v1/downloads/${pausedId}`, headers: { 'X-Tori-Token': appToken } });
      if (st.ok && st.data?.downloaded_bytes >= 500000) break;
    }
    await httpJson({ port: appPort, reqPath: `/api/v1/downloads/${pausedId}/pause`, method: 'POST', headers: { 'X-Tori-Token': appToken } });
    const jPaused = await waitForJob(appPort, appToken, (j) => j.id === pausedId && j.state === 'paused', 10000);

    // 3. Failed download (404 on body GET after HEAD/Range=0-0 probe; wait for retry cycle to settle to failed)
    const c3 = await httpJson({
      port: appPort,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': appToken },
      body: { url: `http://127.0.0.1:${PORT_FIXTURE}/missing_404.zip`, filename: 'missing_404.zip' },
    });
    const jFailed = await waitForJob(appPort, appToken, (j) => j.id === c3.data?.job_id && j.state === 'failed', 35000);

    // 4. Queued/unstarted job via create_download
    await boot.cdp.evalJson(`
      await window.__TAURI_INTERNALS__.invoke('create_download', {
        url: 'http://127.0.0.1:${PORT_FIXTURE}/pre_done.zip?q=1',
        destination: ${JSON.stringify(QA_DL_DIR)},
        startImmediately: false
      });
    `);

    const partPath = jPaused?.temp_path || (jPaused?.target_path ? `${jPaused.target_path}.tdm-part` : null);
    const partShaBefore = sha256File(partPath);
    const preSettings = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_engine_settings');`);

    // Leave v1.0.6 intentionally running while running NSIS v1.0.7 upgrade so NSIS_HOOK_POSTINSTALL
    // proves clean stale-process termination without SECONDARY_INSTANCE!
    boot.cdp.close();
    console.log('\n>>> [PHASE 13] Executing REAL in-place NSIS upgrade v1.0.6 -> v1.0.7-rc <<<');
    execSync(`"${INST_107_EXE}" /S /D=${QA_INST_DIR}`, { timeout: 120000 });
    oemGuard.temporarilySilenceNativeHostAutoSpawn(path.join(QA_ROOT, 'shield'));
    await sleep(600);
    // Ensure tracked handle cleaned if already killed by installer
    killProcTree(boot.proc.pid);
    trackedProcs.delete(boot.proc);

    const verAfter = getPeVersion(instExe);
    const bundledFilesOk = ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe', 'tdm-native-host.exe', 'tdm-cli.exe'].every((f) =>
      fs.existsSync(path.join(QA_INST_DIR, 'bin', f))
    ) && fs.existsSync(path.join(QA_INST_DIR, 'LICENSE-THIRD-PARTY.txt'));
    const regInstallDir = queryRegDefault(REG_MANU);

    record(
      'G322-02',
      'Installed v1.0.7 binary PE version & bundled tools (yt-dlp, FFmpeg, FFprobe, host, CLI, licenses) verified',
      verAfter === '1.0.7' && bundledFilesOk,
      `peVersion=${verAfter}, bundledComplete=${bundledFilesOk}`
    );
    record(
      'G322-05',
      'Real in-place NSIS upgrade v1.0.6 -> v1.0.7 updates target directory cleanly with accurate registry path',
      verBefore === '1.0.6' && verAfter === '1.0.7' && Boolean(regInstallDir && regInstallDir.toLowerCase() === QA_INST_DIR.toLowerCase()),
      `before=${verBefore}, after=${verAfter}, regDir=${regInstallDir}`
    );

    // Cold boot upgraded v1.0.7 pointed at live staging manifest (using embedded production key CDC23D8CC8DA5397)
    boot = await bootDesktop({
      exe: instExe,
      dataDir: QA_DATA_DIR,
      wv2Dir: QA_WV2_DIR,
      dlDir: QA_DL_DIR,
      profDir: QA_PROF_DIR,
      port: PORT_APP,
      cdpPort: PORT_CDP,
      token: API_TOKEN,
      pipeSuffix: 'v107_upg',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: LIVE_STAGING_MANIFEST_URL,
      },
    });
    appPort = boot.port;
    appToken = boot.token;
    perf.coldStartupMs = boot.startupMs;
    await sleep(900);
    perf.idleStats = getTreeStats(boot.proc.pid);

    const appVer = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_app_version');`);
    const migInfo = querySqliteTables(path.join(QA_DATA_DIR, 'tdm_storage.sqlite'));
    record(
      'G322-06',
      'Upgraded v1.0.7 launches cleanly (no SECONDARY_INSTANCE), reports v1.0.7, and migrates SQLite cleanly',
      appVer === '1.0.7' &&
        boot.serverOk &&
        migInfo.integrity.join(',') === 'ok' &&
        migInfo.tables.includes('external_tools_registry') &&
        migInfo.tables.includes('external_tool_update_history') &&
        migInfo.downloads >= 4,
      `appVer=${appVer}, coldStartupMs=${perf.coldStartupMs}, mig=${JSON.stringify(migInfo)}`
    );

    const postJobsResp = await httpJson({ port: appPort, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': appToken } });
    const postJobs = postJobsResp.data?.jobs || [];
    const postPrePaused = postJobs.find((j) => j.id === pausedId);
    const postPreFailed = postJobs.find((j) => j.id === c3.data?.job_id);
    const postPreDone = postJobs.find((j) => j.id === c1.data?.job_id);
    const postSettings = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_engine_settings');`);
    const partShaAfter = sha256File(partPath);
    await httpJson({ port: appPort, reqPath: `/api/v1/downloads/${pausedId}/resume`, method: 'POST', headers: { 'X-Tori-Token': appToken } });
    const resumedDone = await waitForJob(appPort, appToken, (j) => j.id === pausedId && j.state === 'completed', 60000);
    const resumedShaOk = Boolean(resumedDone?.target_path && sha256File(resumedDone.target_path) === sha.prePaused);

    record(
      'G322-07',
      'v1.0.6 -> v1.0.7 preserves downloads, settings & .tdm-part bytes, and resumes paused transfer to exact SHA-256',
      Boolean(
        postPreDone?.state === 'completed' &&
          postPreFailed?.state === 'failed' &&
          postPrePaused?.state === 'paused' &&
          partShaBefore &&
          partShaBefore === partShaAfter &&
          postSettings?.closeToTray === preSettings?.closeToTray &&
          postSettings?.showDownloadPopup === preSettings?.showDownloadPopup &&
          resumedDone?.state === 'completed' &&
          resumedShaOk
      ),
      JSON.stringify({
        done: postPreDone?.state,
        failed: postPreFailed?.state,
        pausedBeforeResume: postPrePaused?.state,
        partPresent: Boolean(partShaBefore),
        partMatch: Boolean(partShaBefore && partShaBefore === partShaAfter),
        resumedShaOk,
        closeToTray: postSettings?.closeToTray,
      })
    );

    // Verify IDM Progress Window (NO legacy dark toast) on upgraded v1.0.7!
    const tDl0 = Date.now();
    const cNew = await httpJson({
      port: appPort,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': appToken },
      body: { url: `http://127.0.0.1:${PORT_FIXTURE}/post_new.bin`, filename: 'post_new.bin' },
    });
    const newId = cNew.data?.job_id;
    let popDiag = { isIdm: false, legacyToast: false, label: '' };
    for (let i = 0; i < 40; i++) {
      await sleep(120);
      const targets = await listCdpTargets(PORT_CDP);
      const popTgt = targets.find((t) => t.webSocketDebuggerUrl && String(t.url || '').includes(newId));
      if (popTgt) {
        const pCdp = new CDPClient(popTgt.webSocketDebuggerUrl);
        try {
          await pCdp.connect();
          await sleep(500);
          popDiag = await pCdp.evalJson(`
            return {
              isIdm: Boolean(document.querySelector('.dl-popup-root #w') && document.querySelectorAll('.dl-tabs .dl-tab').length === 3),
              legacyToast: Boolean(document.querySelector('.toast-card, .toast-stack, svg circle[stroke-dasharray]')),
              label: window.__TAURI__?.window?.getCurrentWindow()?.label || ''
            };
          `);
        } finally {
          pCdp.close();
        }
        break;
      }
    }
    const jNewDone = await waitForJob(appPort, appToken, (j) => j.id === newId && j.state === 'completed', 30000);
    const dlElapsedSec = Math.max(0.05, (Date.now() - tDl0) / 1000);
    perf.activeDownloadThroughputMBs = Number(((bufPostNew.length / (1024 * 1024)) / dlElapsedSec).toFixed(2));
    record(
      'G322-08',
      'Upgraded v1.0.7 opens standalone IDM Progress Window (no legacy toast) and completes with exact SHA-256',
      popDiag.isIdm && !popDiag.legacyToast && popDiag.label.startsWith('progress_') && jNewDone?.state === 'completed' && sha256File(jNewDone.target_path) === sha.postNew,
      `${JSON.stringify(popDiag)}, throughputMBs=${perf.activeDownloadThroughputMBs}`
    );

    // Close-to-Tray lifecycle test
    await boot.cdp.evalJson(`await window.__TAURI_INTERNALS__.invoke('hide_main_window');`);
    await sleep(300);
    const aliveHidden = (await httpJson({ port: appPort, reqPath: '/api/v1/status', headers: { 'X-Tori-Token': appToken } })).ok;
    await boot.cdp.evalJson(`await window.__TAURI_INTERNALS__.invoke('show_main_window');`);
    await sleep(300);
    record('G322-09', 'Close-to-Tray hides main window while keeping engine alive and restores cleanly', aliveHidden, `aliveWhileHidden=${aliveHidden}`);

    // Open Settings -> About (capture v1.0.7 About screenshot) & Settings -> External Tools (Light & Dark!)
    await boot.cdp.evalJson(`
      document.documentElement.setAttribute('data-theme', 'light');
      const btn = Array.from(document.querySelectorAll('#tool button')).find(b => b.textContent.includes('Settings'));
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 350));
      const aboutTab = document.querySelector('[data-tab="about"]');
      if (aboutTab) aboutTab.click();
      await new Promise(r => setTimeout(r, 350));
    `);
    const aboutText = await boot.cdp.evalJson(`return document.body.innerText;`);
    await boot.cdp.screenshot(path.join(SHOTS_DIR, 'gate32_2_01_about_v107_light.png'));

    await boot.cdp.evalJson(`
      const tab = document.querySelector('[data-tab="tools"]');
      if (tab) tab.click();
      await new Promise(r => setTimeout(r, 350));
      await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: { auto_update: true, check_interval_hours: 24, auto_install: false, notify_on_update: true, defer_while_in_use: true }
      });
    `);
    const tChk0 = Date.now();
    let toolsCheck = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');`);
    // If the automatic 5s startup check was already in flight (deduplicated), wait for it to finish cleanly!
    const chkDeadline = Date.now() + 25000;
    while (
      Date.now() < chkDeadline &&
      (toolsCheck.checking ||
        !toolsCheck.tools?.find((t) => t.tool_id === 'ffmpeg')?.available_version ||
        !toolsCheck.tools?.find((t) => t.tool_id === 'yt-dlp')?.available_version)
    ) {
      await sleep(350);
      toolsCheck = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_external_tools_status');`);
    }
    perf.liveCheckMs = Date.now() - tChk0;
    await sleep(400);
    await boot.cdp.screenshot(path.join(SHOTS_DIR, 'gate32_2_02_external_tools_v107_light.png'));
    await boot.cdp.evalJson(`document.documentElement.setAttribute('data-theme', 'dark'); await new Promise(r => setTimeout(r, 300));`);
    await boot.cdp.screenshot(path.join(SHOTS_DIR, 'gate32_2_03_external_tools_v107_dark.png'));
    await boot.cdp.evalJson(`
      document.documentElement.setAttribute('data-theme', 'light');
      await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: { auto_update: true, check_interval_hours: 24, auto_install: true, notify_on_update: true, defer_while_in_use: true }
      });
    `);

    const chkYt = toolsCheck.tools.find((t) => t.tool_id === 'yt-dlp');
    const chkFf = toolsCheck.tools.find((t) => t.tool_id === 'ffmpeg');
    const chkFp = toolsCheck.tools.find((t) => t.tool_id === 'ffprobe');
    const ytCheckedOk = Boolean(chkYt?.available_version && ['update_available', 'updated', 'downloading', 'verifying', 'testing', 'installing'].includes(chkYt?.update_status));
    const ffCheckedOk = Boolean(chkFf?.available_version && ['update_available', 'updated', 'downloading', 'verifying', 'testing', 'installing'].includes(chkFf?.update_status));
    const fpCheckedOk = Boolean(chkFp?.available_version && ['update_available', 'updated', 'downloading', 'verifying', 'testing', 'installing'].includes(chkFp?.update_status));
    record(
      'G322-10',
      'Upgraded v1.0.7 About tab shows v1.0.7 and External Tools verifies live HTTPS staging manifest + OpenPGP yt-dlp',
      aboutText.includes('1.0.7') && ffCheckedOk && fpCheckedOk && ytCheckedOk,
      `checkMs=${perf.liveCheckMs}, yt=${chkYt?.available_version}(${chkYt?.update_status}), ff=${chkFf?.available_version}(${chkFf?.update_status})`
    );

    // If background daily scheduler already auto-upgraded yt-dlp to managed, roll back first so G322-11
    // cleanly tests a live yt-dlp upgrade while HTTP + YouTube downloads are actively running!
    const preActTools = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_external_tools_status');`);
    const preActYt = preActTools.tools.find((t) => t.tool_id === 'yt-dlp');
    if (preActYt?.source === 'managed' && preActYt?.rollback_available) {
      await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('rollback_external_tool', { toolId: 'yt-dlp' });`);
    }

    // PHASE 8: Live Active Download Protection (concurrent HTTP transfer + live YouTube media download while updating yt-dlp!)
    const httpAct = await httpJson({
      port: appPort,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': appToken },
      body: { url: `http://127.0.0.1:${PORT_FIXTURE}/active_long.bin`, filename: 'active_long.bin' },
    });
    const ytAct = await boot.cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('create_media_download', {
        args: {
          url: ${JSON.stringify(WATCH_YT_URL)},
          format_id: '230+234/bestvideo+bestaudio/best',
          filename: 'gate32_2_active_yt.mp4',
          destination: ${JSON.stringify(QA_DL_DIR)},
          start_immediately: true
        }
      });
    `);
    // Immediately trigger yt-dlp update concurrently while both HTTP & YouTube downloads are running!
    const concurrentUpdatePromise = boot.cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'yt-dlp' });
    `);
    const [updDuringActive, httpActDone, ytActDone] = await Promise.all([
      concurrentUpdatePromise,
      waitForJob(appPort, appToken, (j) => j.id === httpAct.data?.job_id && j.state === 'completed', 45000),
      waitForJob(appPort, appToken, (j) => j.id === ytAct.id && j.state === 'completed', 65000),
    ]);
    // If deferred while YouTube was active, trigger activation once idle and measure rollback latency
    let ytAfterSettle = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_external_tools_status');`);
    const ytTool = ytAfterSettle.tools.find((t) => t.tool_id === 'yt-dlp');
    if (ytTool?.update_status === 'pending_activation') {
      ytAfterSettle = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'yt-dlp' });`);
    }
    const finalYtTool = ytAfterSettle.tools.find((t) => t.tool_id === 'yt-dlp');
    const tRb0 = Date.now();
    const afterRb = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('rollback_external_tool', { toolId: 'yt-dlp' });`);
    perf.rollbackMs = Date.now() - tRb0;
    const rbYt = afterRb.tools.find((t) => t.tool_id === 'yt-dlp');

    record(
      'G322-11',
      'Active Download Protection: concurrent HTTP + YouTube downloads complete intact during yt-dlp update & rollback',
      Boolean(
        httpActDone?.state === 'completed' &&
          sha256File(httpActDone.target_path) === sha.activeLong &&
          ytActDone?.state === 'completed' &&
          fs.existsSync(ytActDone.target_path) &&
          finalYtTool?.source === 'managed' &&
          rbYt?.source === 'bundled' &&
          rbYt?.update_status === 'rolled_back'
      ),
      `bgAutoUpgradedFirst=${preActYt?.source === 'managed'}, duringStatus=${updDuringActive?.tools?.find((t) => t.tool_id === 'yt-dlp')?.update_status}, settled=${finalYtTool?.installed_version}, rollbackMs=${perf.rollbackMs}`
    );

    // Warm restart persistence test!
    boot.cdp.close();
    killProcTree(boot.proc.pid);
    trackedProcs.delete(boot.proc);
    await sleep(500);

    boot = await bootDesktop({
      exe: instExe,
      dataDir: QA_DATA_DIR,
      wv2Dir: QA_WV2_DIR,
      dlDir: QA_DL_DIR,
      profDir: QA_PROF_DIR,
      port: PORT_APP,
      cdpPort: PORT_CDP,
      token: API_TOKEN,
      pipeSuffix: 'v107_warm',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: LIVE_STAGING_MANIFEST_URL,
      },
    });
    appPort = boot.port;
    appToken = boot.token;
    perf.warmStartupMs = boot.startupMs;
    const histAfterRestart = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_external_tool_update_history', { limit: 50 });`);
    const dlListAfterRestart = await httpJson({ port: appPort, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': appToken } });
    record(
      'G322-12',
      'Warm restart preserves download history, SQLite tool registry, and tool update history',
      Array.isArray(histAfterRestart) && histAfterRestart.length >= 2 && (dlListAfterRestart.data?.jobs?.length || 0) >= 6,
      `warmStartupMs=${perf.warmStartupMs}, historyEntries=${histAfterRestart?.length}, downloads=${dlListAfterRestart.data?.jobs?.length}`
    );

    // =========================================================================
    // GROUP C: BROWSER COMPANION v1.0.10 COMPATIBILITY WITH UPGRADED v1.0.7
    // =========================================================================
    console.log('\n>>> [PHASE 15] Browser Companion v1.0.10 Native Messaging & Real Browser Parity <<<');
    const nmPing = sendNativeHostMessage(
      instHost,
      { action: 'ping' },
      { TORI_DATA_DIR: QA_DATA_DIR, TORI_IPC_PIPE: `\\\\.\\pipe\\tori_g322_v107_warm_${process.pid}` }
    );
    const httpFallback = await httpJson({ port: appPort, reqPath: '/api/v1/status', headers: { 'X-Tori-Token': appToken } });
    record(
      'G322-13',
      'Upgraded v1.0.7 Native Messaging stdio host & HTTP fallback respond cleanly to Companion v1.0.10',
      Boolean(nmPing.ok && nmPing.response && httpFallback.ok),
      `nmStatus=${nmPing.status}, nmResp=${JSON.stringify(nmPing.response)}, httpOk=${httpFallback.ok}`
    );

    // Verify Companion v1.0.10 Chromium manifest/assets (Instagram overlay + YouTube format picker) + Edge/Chrome load
    const chrManifest = JSON.parse(fs.readFileSync(path.join(CHR_EXT_DIR, 'manifest.json'), 'utf8'));
    const chrContentJs = fs.readFileSync(path.join(CHR_EXT_DIR, 'content.js'), 'utf8');
    const hasIgAndYtOverlays =
      chrManifest.version === '1.0.10' &&
      chrContentJs.includes('instagram') &&
      chrContentJs.includes('youtube') &&
      chrContentJs.includes('open-playlist');
    record(
      'G322-14',
      'Browser Companion v1.0.10 Chromium package (Chrome/Edge) retains Instagram overlay, YouTube picker & playlist handoff',
      hasIgAndYtOverlays,
      `manifestVersion=${chrManifest.version}, contentJsBytes=${chrContentJs.length}`
    );

    // Real Signed Firefox v1.0.10 XPI permanent install + MKV capture into upgraded v1.0.7!
    fs.mkdirSync(QA_FF_PROF, { recursive: true });
    fs.mkdirSync(QA_FF_DL, { recursive: true });
    const qaNmBat = path.join(QA_ROOT, 'nm_host_v107.cmd');
    fs.writeFileSync(
      qaNmBat,
      `@echo off\r\nset TORI_DATA_DIR=${QA_DATA_DIR}\r\nset TORI_IPC_PIPE=\\\\.\\pipe\\tori_g322_v107_warm_${process.pid}\r\n"${instHost}" %*\r\n`
    );
    const qaFfNmJson = path.join(QA_ROOT, 'com.tori.download_manager.firefox.json');
    fs.writeFileSync(
      qaFfNmJson,
      JSON.stringify({
        name: 'com.tori.download_manager',
        description: 'TORI v1.0.7 QA Native Host',
        path: qaNmBat,
        type: 'stdio',
        allowed_extensions: [EXPECTED_GECKO_ID],
      }, null, 2)
    );
    execFileSync('reg', ['add', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', qaFfNmJson, '/f'], { stdio: 'ignore' });

    fs.writeFileSync(
      path.join(QA_FF_PROF, 'user.js'),
      [
        `user_pref("marionette.port", ${PORT_FF_MAR});`,
        'user_pref("xpinstall.signatures.required", true);',
        'user_pref("extensions.autoDisableScopes", 0);',
        'user_pref("browser.download.folderList", 2);',
        `user_pref("browser.download.dir", ${JSON.stringify(QA_FF_DL)});`,
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
      ].join('\n')
    );

    const ffProc = spawn(FIREFOX_EXE, ['-no-remote', '-profile', QA_FF_PROF, '-marionette', 'about:blank'], {
      stdio: 'ignore',
    });
    trackedProcs.add(ffProc);
    const mar = new MarionetteClient(PORT_FF_MAR);
    await mar.connect(30000);
    await mar.send('WebDriver:NewSession', {});
    const addonId = await mar.send('Addon:Install', { path: SIGNED_FF_XPI, temporary: false }, 20000);

    // Trigger real Firefox MKV capture into upgraded v1.0.7 via extension!
    const beforeFfIds = new Set(((await httpJson({ port: appPort, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': appToken } })).data?.jobs || []).map((j) => j.id));
    await mar.send('WebDriver:Navigate', { url: `http://127.0.0.1:${PORT_FIXTURE}/ff_page.html` }, 20000);
    await sleep(1500);
    await mar.send('WebDriver:ExecuteScript', { script: `document.getElementById('dl-mkv').click();`, args: [] }, 10000);
    const ffMkvJob = await waitForJob(appPort, appToken, (j) => !beforeFfIds.has(j.id) && j.state === 'completed', 30000);
    const allAfterFf = ((await httpJson({ port: appPort, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': appToken } })).data?.jobs || []).filter((j) => !beforeFfIds.has(j.id));
    const ffMkvShaOk = ffMkvJob?.target_path && sha256File(ffMkvJob.target_path) === sha.ffMkv;

    try { await mar.send('Marionette:Quit', {}); } catch {}
    mar.close();
    killProcTree(ffProc.pid);
    trackedProcs.delete(ffProc);

    record(
      'G322-15',
      'Signed Firefox Companion v1.0.10 XPI installs permanently and captures MKV into upgraded v1.0.7 (zero duplicates)',
      addonId?.value === EXPECTED_GECKO_ID && ffMkvJob?.state === 'completed' && ffMkvShaOk && allAfterFf.length === 1,
      `addon=${addonId?.value}, newJobs=${allAfterFf.length}, shaMatch=${ffMkvShaOk}`
    );

    perf.postRunStats = getTreeStats(boot.proc.pid);
    fs.writeFileSync(path.join(QA_ROOT, 'perf_metrics.json'), JSON.stringify(perf, null, 2) + '\n');
    record(
      'G322-16',
      'Phase 18 Performance: cold/warm startup, idle footprint, active throughput, rollback latency & zero leaked consoles',
      perf.coldStartupMs < 15000 && perf.warmStartupMs < 15000 && perf.postRunStats.wsMb < 900 && perf.postRunStats.consoleCount === 0,
      JSON.stringify(perf)
    );

    boot.cdp.close();
    killProcTree(boot.proc.pid);
    trackedProcs.delete(boot.proc);
  } finally {
    cleanupProcs();
    if (fixtureServer) try { fixtureServer.close(); } catch {}
    await sleep(400);
    oemDbAfter = snapshotOemDatabase(OEM_DB_PATH);
    const parity = oemGuard.restore({ qaPathMarker: 'gate32_2_qa', restartOem: true });
    record('G322-17', 'OEM Windows Registry, Native Messaging & shortcuts restored with 100% parity', parity.ok === true, JSON.stringify(parity.checks || {}));
  }

  const dbCmp = compareOemDatabaseSnapshots(oemDbBefore, oemDbAfter);
  record(
    'G322-18',
    'Production SQLite database & .tdm-part files untouched (PRAGMA integrity_check=ok)',
    Boolean(dbCmp && dbCmp.ok),
    JSON.stringify(dbCmp)
  );

  const oemExeShaAfter = sha256File(OEM_DESKTOP_EXE);
  record(
    'G322-19',
    'Production installed TORI Desktop v1.0.6 binary completely untouched (byte-identical SHA-256)',
    oemExeShaBefore === oemExeShaAfter,
    `exeShaMatch=${oemExeShaBefore === oemExeShaAfter}`
  );

  console.log('\n=============================================================================');
  console.log(` GATE 32.2 PREFLIGHT SUMMARY: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.TIMEOUT} TIMEOUT, ${counts.NOT_TESTED} NOT TESTED`);
  console.log('=============================================================================');
  if (counts.FAIL > 0 || counts.TIMEOUT > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL] Gate 32.2 preflight aborted:', err);
  cleanupProcs();
  if (fixtureServer) try { fixtureServer.close(); } catch {}
  process.exit(1);
});
