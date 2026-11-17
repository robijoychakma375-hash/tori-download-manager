#!/usr/bin/env node
/**
 * TORI Gate 29.5.1 — Mozilla-Signed Firefox v1.0.9 XPI Acceptance & E2E Suite
 *
 * Verifies:
 * 1. Exact SHA-256 & ZIP/manifest/META-INF/byte-parity against unsigned v1.0.9 Firefox ZIP
 * 2. Preserved signed v1.0.7 XPI untouched
 * 3. Permanent install (temporary: false) in a clean Firefox profile with xpinstall.signatures.required = true
 * 4. AddonManager SIGNEDSTATE_SIGNED verification + version 1.0.9 + gecko ID
 * 5. Popup & Options UI + Desktop v1.0.5 connection
 * 6. Native Messaging (INITIATE_PAIRING + RECONNECT_DESKTOP) against isolated QA Desktop
 * 7. HTTP API fallback when Firefox NativeMessagingHosts registry points to missing manifest
 * 8. Video detection & IDM Format Picker (local MP4 fixture + live YouTube formats)
 * 9. Extensionless Content-Disposition MKV interception into Video/ + SHA-256 verification
 * 10. YouTube Playlist handoff -> Desktop tray restore -> #playlist-modal -> real download + ffprobe + Mix rejection
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FROZEN_RC = path.join(ROOT, 'release', 'v1.0.5-v1.0.9-final-rc');
const SIGNED_V109_XPI = path.join(FROZEN_RC, 'Extensions', 'a70ed17e183648a9bcf4-1.0.9.xpi');
const UNSIGNED_V109_ZIP = path.join(FROZEN_RC, 'Extensions', 'tori-companion-v1.0.9-firefox.zip');
const EXPECTED_V109_SHA256 = 'd4e8d6e585ba6dfaf841eb6b37f2ee27beae1cec55badbbe0dd12960ad5943ec';

const SIGNED_V107_XPI = path.join(ROOT, 'release', 'v1.0.7-extension-rc', 'a70ed17e183648a9bcf4-1.0.7.xpi');
const EXPECTED_V107_SHA256 = 'b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0';
const EXPECTED_GECKO_ID = 'tori-download-manager@toridm.org';

const DESKTOP_FROZEN_DIR = path.join(FROZEN_RC, 'Desktop');
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const OEM_HOST_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'bin', 'tdm-native-host.exe');
const OEM_DESKTOP_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'tori-download-manager.exe');
const OEM_DB_PATH = path.join(process.env.APPDATA || '', 'tori-download-manager', 'tdm_storage.sqlite');

const DESKTOP_GUI_PORT = 24980;
const WEBVIEW2_CDP_PORT = 24981;
const FIXTURE_PORT = 24985;
const FF_MARIONETTE_PORT = 2839;
const API_TOKEN = 'tori_qa_g29_5_1_token';

const QA_ROOT = path.join(ROOT, 'target', 'gate29_5_1_qa');
const QA_APP_DIR = path.join(QA_ROOT, 'desktop_app');
const QA_DATA_DIR = path.join(QA_ROOT, 'data');
const QA_DL_DIR = path.join(QA_ROOT, 'downloads');
const QA_WV2_DIR = path.join(QA_ROOT, 'webview2');
const QA_FF_PROF = path.join(QA_ROOT, 'firefox_profile');
const SCREENSHOTS_DIR = path.join(ROOT, 'docs', 'reports', 'screenshots', 'gate29_5_1');

const WATCH_PLAYLIST_URL = 'https://www.youtube.com/watch?v=u9lj-c29dxI&list=PL6B3937A5D230E335';
const WATCH_MIX_URL = 'https://www.youtube.com/watch?v=u9lj-c29dxI&list=RDu9lj-c29dxI';

const results = [];
const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, NOT_TESTED: 0 };
const trackedProcs = new Set();
let oemWasRunning = false;
let fixtureServer = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1048576);
    let n = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function record(id, description, passed, detail = '', statusOverride = null) {
  const status = statusOverride || (passed ? 'PASS' : 'FAIL');
  counts[status] = (counts[status] || 0) + 1;
  results.push({ id, status, description, detail });
  console.log(`[${status}] [${id}] ${description}${detail ? ' -> ' + detail : ''}`);
}

function getRunningToriPids() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Process tori-download-manager -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ","`],
      { encoding: 'utf8', timeout: 4000 }
    ).trim();
    return out ? out.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0) : [];
  } catch {
    return [];
  }
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
  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP connect timeout')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
      ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(`CDP error: ${e.message || e}`)); });
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
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalAsync(expression, timeoutMs = 15000, opts = {}) {
    const res = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: !!opts.userGesture },
      timeoutMs
    );
    if (res?.exceptionDetails) {
      throw new Error(`CDP eval error: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    return res?.result?.value;
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

class MarionetteClient {
  constructor(port = FF_MARIONETTE_PORT) {
    this.port = port;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return await this._connectOnce(Math.max(1000, deadline - Date.now()));
      } catch (err) {
        if (err && (err.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(String(err.message || '')))) {
          await sleep(250);
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Marionette connect timeout on port ${this.port}`);
  }
  _connectOnce(timeoutMs) {
    return new Promise((resolve, reject) => {
      this.buf = Buffer.alloc(0);
      const sock = net.createConnection({ host: '127.0.0.1', port: this.port });
      this.socket = sock;
      let handshaken = false;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.destroy();
        reject(new Error(`Marionette handshake timeout`));
      }, timeoutMs);
      sock.on('error', (err) => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(err); }
      });
      sock.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        while (true) {
          const colon = this.buf.indexOf(':');
          if (colon === -1) break;
          const len = parseInt(this.buf.subarray(0, colon).toString('utf8'), 10);
          if (Number.isNaN(len)) break;
          const rest = this.buf.subarray(colon + 1);
          if (rest.length < len) break;
          const msgStr = rest.subarray(0, len).toString('utf8');
          this.buf = rest.subarray(len);
          const parsed = JSON.parse(msgStr);
          if (!handshaken) {
            handshaken = true;
            settled = true;
            clearTimeout(timer);
            resolve(parsed);
          } else if (Array.isArray(parsed) && parsed[0] === 1) {
            const p = this.pending.get(parsed[1]);
            if (p) {
              this.pending.delete(parsed[1]);
              if (parsed[2]) p.reject(new Error(JSON.stringify(parsed[2])));
              else p.resolve(parsed[3]);
            }
          }
        }
      });
    });
  }
  send(command, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Marionette ${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const payload = JSON.stringify([0, id, command, params]);
      this.socket.write(`${Buffer.byteLength(payload, 'utf8')}:${payload}`);
    });
  }
  close() {
    try { this.socket?.destroy(); } catch {}
  }
}

async function waitForCdpTargets(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fetch(`http://127.0.0.1:${port}/json/version`);
      const l = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (v.ok && l.ok) {
        const version = await v.json();
        const targets = await l.json();
        if (version.webSocketDebuggerUrl && Array.isArray(targets)) return { version, targets };
      }
    } catch {}
    await sleep(200);
  }
  throw new Error(`WebView2 CDP did not become ready on port ${port}`);
}

async function waitForContext(cdp, expr, timeoutMs = 20000, label = 'ctx') {
  try { await cdp.send('Runtime.enable', {}, 4000); } catch {}
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      if (await cdp.evalAsync(expr, 4000)) return true;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(250);
  }
  throw new Error(`waitForContext(${label}) timed out: ${lastErr}`);
}

function readOemDbSnapshot() {
  const py = `
import os, sqlite3, json
p = os.path.expandvars(r"%APPDATA%\\tori-download-manager\\tdm_storage.sqlite")
c = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
count = c.execute("SELECT count(*) FROM downloads").fetchone()[0]
token = c.execute("SELECT value FROM engine_settings WHERE key='browser_integration_token'").fetchone()
print(json.dumps({"count": count, "token": token[0] if token else None}))
`;
  return JSON.parse(execFileSync('python', ['-c', py], { encoding: 'utf8' }));
}

function seedQaSqlite(dbPath) {
  const py = `
import sqlite3, json, sys
db_path, dl_dir, token, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
app_settings = {
  "dir": dl_dir, "sort": True, "con": 8, "maxa": 4, "limMode": "off",
  "limV": 512, "limU": "KiB/s", "retries": 1, "dyn": True, "mps": 256, "mpsU": "KiB",
  "ua": "", "ssl": False, "lm": False, "track": True, "dns": "System DNS", "proxy": "none",
  "port": port, "key": token, "cap": True, "theme": "light", "accent": "indigo",
  "motion": False, "details": False, "showDownloadPopup": "never", "alwaysOnTop": False, "closeToTray": True
}
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("browser_integration_token", token))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("server_port", str(port)))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("active_server_port", str(port)))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("app_settings", json.dumps(app_settings)))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("close_to_tray_migrated_v104", "true"))
conn.commit()
conn.close()
`;
  execFileSync('python', ['-c', py, dbPath, QA_DL_DIR, API_TOKEN, String(DESKTOP_GUI_PORT)], { stdio: 'pipe' });
}

function stageQaDesktop() {
  const qaBinDir = path.join(QA_APP_DIR, 'bin');
  fs.mkdirSync(qaBinDir, { recursive: true });
  fs.copyFileSync(path.join(DESKTOP_FROZEN_DIR, 'tori-download-manager.exe'), path.join(QA_APP_DIR, 'tori-download-manager.exe'));
  fs.copyFileSync(path.join(DESKTOP_FROZEN_DIR, 'LICENSE-THIRD-PARTY.txt'), path.join(QA_APP_DIR, 'LICENSE-THIRD-PARTY.txt'));
  for (const binFile of ['tdm-native-host.exe', 'tdm-cli.exe', 'ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe']) {
    fs.copyFileSync(path.join(DESKTOP_FROZEN_DIR, binFile), path.join(qaBinDir, binFile));
  }
}

function registerQaFirefoxNativeHost() {
  const ffManifest = path.join(QA_ROOT, 'nm_firefox_qa.json');
  fs.writeFileSync(
    ffManifest,
    JSON.stringify(
      {
        name: 'com.tori.download_manager',
        description: 'TORI QA Native Messaging Host (Firefox Signed v1.0.9)',
        path: path.join(QA_APP_DIR, 'bin', 'tdm-native-host.exe'),
        type: 'stdio',
        allowed_extensions: [EXPECTED_GECKO_ID],
      },
      null,
      2
    )
  );
  execFileSync(
    'reg',
    ['add', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', ffManifest, '/f'],
    { stdio: 'ignore', timeout: 4000 }
  );
}

function registerBrokenFirefoxNativeHost() {
  const brokenManifest = path.join(QA_ROOT, 'nm_firefox_broken.json');
  fs.writeFileSync(
    brokenManifest,
    JSON.stringify(
      {
        name: 'com.tori.download_manager',
        description: 'Broken QA Native Host for HTTP Fallback Test',
        path: path.join(QA_ROOT, 'nonexistent_native_host.exe'),
        type: 'stdio',
        allowed_extensions: [EXPECTED_GECKO_ID],
      },
      null,
      2
    )
  );
  execFileSync(
    'reg',
    ['add', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', brokenManifest, '/f'],
    { stdio: 'ignore', timeout: 4000 }
  );
}

function restoreOemNativeHosts() {
  try {
    if (fs.existsSync(OEM_HOST_EXE)) {
      execFileSync(OEM_HOST_EXE, ['--register'], { stdio: 'ignore', timeout: 5000 });
    }
  } catch {}
}

function restoreOemDesktop() {
  if (!oemWasRunning || !fs.existsSync(OEM_DESKTOP_EXE)) return;
  try {
    const child = spawn(OEM_DESKTOP_EXE, ['--minimized'], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {}
}

function makeMkvBuffer(totalBytes) {
  const mkvHeader = Buffer.from('1a45dfa3934282886d6174726f736b614287810442858102', 'hex');
  const buf = Buffer.allocUnsafe(totalBytes);
  const pattern = Buffer.from('TORI_GATE_29_5_1_SIGNED_FIREFOX_V109_MKV_STREAM_VERIFY_64B_BLOCK_');
  for (let off = 0; off < totalBytes; off += pattern.length) {
    pattern.copy(buf, off, 0, Math.min(pattern.length, totalBytes - off));
  }
  mkvHeader.copy(buf, 0);
  return buf;
}

async function fetchJobs() {
  const r = await httpJson({ port: DESKTOP_GUI_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': API_TOKEN } });
  return r.ok && Array.isArray(r.data?.jobs) ? r.data.jobs : [];
}

async function waitForCompletedJob(pred, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jobs = await fetchJobs();
    const m = jobs.find(pred);
    if (m && (m.state === 'completed' || m.state === 'failed')) {
      const det = await httpJson({ port: DESKTOP_GUI_PORT, reqPath: `/api/v1/downloads/${encodeURIComponent(m.id)}`, headers: { 'X-Tori-Token': API_TOKEN } });
      return det.ok && det.data?.id ? det.data : m;
    }
    await sleep(300);
  }
  return null;
}

function verifyPackageIntegrity() {
  const py = `
import hashlib, json, sys, zipfile
xpi_p, exp_xpi_sha, zip_p, v107_p, exp_v107_sha = sys.argv[1:6]
def hfile(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1048576), b''): h.update(c)
    return h.hexdigest()
xpi_sha = hfile(xpi_p)
v107_sha = hfile(v107_p)
with zipfile.ZipFile(xpi_p) as zx, zipfile.ZipFile(zip_p) as zu:
    x_bad = zx.testzip()
    u_bad = zu.testzip()
    x_map = {i.filename: zx.read(i.filename) for i in zx.infolist() if not i.is_dir()}
    u_map = {i.filename: zu.read(i.filename) for i in zu.infolist() if not i.is_dir()}
meta = sorted([k for k in x_map if k.startswith('META-INF/')])
x_app = {k: v for k, v in x_map.items() if not k.startswith('META-INF/')}
missing_in_xpi = sorted(set(u_map) - set(x_app))
extra_in_xpi = sorted(set(x_app) - set(u_map))
diff = []
identical = 0
for k in sorted(set(x_app) & set(u_map)):
    if x_app[k] == u_map[k]:
        identical += 1
    else:
        diff.append(k)
mf_x = json.loads(x_app['manifest.json'].decode('utf-8'))
mf_u = json.loads(u_map['manifest.json'].decode('utf-8'))
print(json.dumps({
    'xpiShaMatch': xpi_sha == exp_xpi_sha,
    'xpiSha': xpi_sha,
    'v107ShaMatch': v107_sha == exp_v107_sha,
    'v107Sha': v107_sha,
    'testzip': x_bad is None and u_bad is None,
    'version': mf_x.get('version'),
    'geckoId': mf_x.get('browser_specific_settings', {}).get('gecko', {}).get('id'),
    'metaInf': meta,
    'identicalAppFiles': identical,
    'totalAppFiles': len(x_app),
    'missingInXpi': missing_in_xpi,
    'extraInXpi': extra_in_xpi,
    'diffFiles': diff,
    'manifestParsedEqual': mf_x == mf_u
}))
`;
  return JSON.parse(
    execFileSync(
      'python',
      ['-c', py, SIGNED_V109_XPI, EXPECTED_V109_SHA256, UNSIGNED_V109_ZIP, SIGNED_V107_XPI, EXPECTED_V107_SHA256],
      { encoding: 'utf8' }
    )
  );
}

async function run() {
  const globalWatchdog = setTimeout(() => {
    console.error('[WATCHDOG] Overall 240s timeout tripped.');
    cleanupProcs();
    restoreOemNativeHosts();
    restoreOemDesktop();
    process.exit(1);
  }, 240000);
  globalWatchdog.unref();

  console.log('========================================================================');
  console.log('  TORI GATE 29.5.1 — SIGNED FIREFOX v1.0.9 XPI FULL E2E VERIFICATION');
  console.log('========================================================================\n');

  const pkgCheck = verifyPackageIntegrity();
  const pkgOk = Boolean(
    pkgCheck.xpiShaMatch &&
      pkgCheck.v107ShaMatch &&
      pkgCheck.testzip &&
      pkgCheck.version === '1.0.9' &&
      pkgCheck.geckoId === EXPECTED_GECKO_ID &&
      pkgCheck.metaInf.includes('META-INF/mozilla.rsa') &&
      pkgCheck.metaInf.includes('META-INF/mozilla.sf') &&
      pkgCheck.metaInf.includes('META-INF/manifest.mf') &&
      pkgCheck.metaInf.includes('META-INF/cose.sig') &&
      pkgCheck.missingInXpi.length === 0 &&
      pkgCheck.extraInXpi.length === 0 &&
      pkgCheck.identicalAppFiles === 34 &&
      pkgCheck.diffFiles.length === 1 &&
      pkgCheck.diffFiles[0] === 'manifest.json' &&
      pkgCheck.manifestParsedEqual
  );
  record(
    'FF109-PKG-01',
    'Signed v1.0.9 XPI SHA-256, ZIP integrity, META-INF signatures, Gecko ID, 34/35 byte parity + identical manifest JSON',
    pkgOk,
    JSON.stringify(pkgCheck)
  );

  const oemSnapBefore = readOemDbSnapshot();

  const existingTori = getRunningToriPids();
  if (existingTori.length > 0) {
    oemWasRunning = true;
    const ping = await httpJson({ port: 6800, reqPath: '/api/v1/ping', timeoutMs: 3000 });
    if (ping.ok && (ping.data?.active_downloads || 0) > 0) {
      throw new Error(`OEM TORI has ${ping.data.active_downloads} active download(s); aborting QA safely.`);
    }
    for (const pid of existingTori) killProcTree(pid);
    await sleep(700);
  }

  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(QA_DATA_DIR, { recursive: true });
  fs.mkdirSync(QA_DL_DIR, { recursive: true });
  fs.mkdirSync(QA_WV2_DIR, { recursive: true });
  fs.mkdirSync(QA_FF_PROF, { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  stageQaDesktop();
  seedQaSqlite(path.join(QA_DATA_DIR, 'tdm_storage.sqlite'));
  registerQaFirefoxNativeHost();

  // Generate sample MP4 via frozen ffmpeg.exe & 8 MiB MKV fixture
  const sampleMp4Path = path.join(QA_ROOT, 'sample_ff109.mp4');
  execFileSync(
    path.join(QA_APP_DIR, 'bin', 'ffmpeg.exe'),
    [
      '-y', '-f', 'lavfi', '-i', 'color=c=#3367d6:s=640x360:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sampleMp4Path,
    ],
    { stdio: 'ignore', timeout: 20000 }
  );
  const sampleMp4Bytes = fs.readFileSync(sampleMp4Path);
  const sampleMp4Sha = sha256File(sampleMp4Path);

  const mkvBytes = makeMkvBuffer(8 * 1024 * 1024);
  const mkvSha = crypto.createHash('sha256').update(mkvBytes).digest('hex');

  fixtureServer = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://127.0.0.1:${FIXTURE_PORT}`);
    if (reqUrl.pathname === '/video.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html><head><title>TORI Signed Firefox v1.0.9 QA</title></head><body>
        <h1>TORI Signed Firefox v1.0.9 Test Page</h1>
        <video id="qa-vid" controls width="640" height="360" src="/media/sample_ff109.mp4"></video>
        <p><a id="dl-ff-mkv" href="/ff_v109_signed_mkv">Download Extensionless MKV</a></p>
      </body></html>`);
    }
    if (reqUrl.pathname === '/media/sample_ff109.mp4') {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
        'Content-Length': sampleMp4Bytes.length,
      });
      return res.end(req.method === 'HEAD' ? undefined : sampleMp4Bytes);
    }
    if (reqUrl.pathname === '/ff_v109_signed_mkv') {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
        'Content-Length': mkvBytes.length,
        'Content-Disposition': 'attachment; filename="Firefox_Signed_v109_Acceptance.mkv"',
      });
      return res.end(req.method === 'HEAD' ? undefined : mkvBytes);
    }
    res.writeHead(404);
    res.end('Not found');
  });
  await new Promise((resolve) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', resolve));

  const pipeName = `\\\\.\\pipe\\tori-qa-g29-5-1-${process.pid}`;
  const qaEnv = {
    ...process.env,
    TORI_DATA_DIR: QA_DATA_DIR,
    TDM_STORAGE_DIR: QA_DATA_DIR,
    TDM_DOWNLOAD_DIR: QA_DL_DIR,
    TORI_IPC_PIPE: pipeName,
    TORI_ALLOW_LOOPBACK: '1',
    TORI_DISABLE_AUTO_SPAWN: '1',
    WEBVIEW2_USER_DATA_FOLDER: QA_WV2_DIR,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${WEBVIEW2_CDP_PORT}`,
    RUST_MIN_STACK: '8388608',
  };

  let deskProc = null;
  let deskCdp = null;
  let ffProc = null;
  let mar = null;

  try {
    // Launch isolated frozen TORI Desktop v1.0.5-rc
    deskProc = spawn(path.join(QA_APP_DIR, 'tori-download-manager.exe'), [], { cwd: QA_APP_DIR, env: qaEnv, stdio: 'ignore' });
    trackedProcs.add(deskProc);
    let deskReady = false;
    for (let i = 0; i < 45; i++) {
      await sleep(300);
      const ping = await httpJson({ port: DESKTOP_GUI_PORT, reqPath: '/api/v1/ping', headers: { 'X-Tori-Token': API_TOKEN } });
      if (ping.ok && ping.data?.name === 'TORI Download Manager') {
        deskReady = true;
        break;
      }
    }
    if (!deskReady) throw new Error('Isolated frozen v1.0.5 Desktop failed to become ready');

    const { targets: deskTargets } = await waitForCdpTargets(WEBVIEW2_CDP_PORT, 20000);
    const deskTgt = deskTargets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    deskCdp = new CDPClient(deskTgt.webSocketDebuggerUrl);
    await deskCdp.connect();
    await deskCdp.send('Runtime.enable');

    // Boot CLEAN Firefox profile with xpinstall.signatures.required = true ENFORCED!
    fs.writeFileSync(
      path.join(QA_FF_PROF, 'user.js'),
      [
        'user_pref("marionette.enabled", true);',
        `user_pref("marionette.port", ${FF_MARIONETTE_PORT});`,
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("browser.startup.homepage_override.mstone", "ignore");',
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
        'user_pref("toolkit.telemetry.enabled", false);',
        'user_pref("xpinstall.signatures.required", true);',
      ].join('\n'),
      'utf8'
    );

    ffProc = spawn(
      FIREFOX_EXE,
      ['-no-remote', '-marionette', '-profile', QA_FF_PROF, `http://127.0.0.1:${FIXTURE_PORT}/video.html`],
      { env: { ...qaEnv, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }, stdio: 'ignore' }
    );
    trackedProcs.add(ffProc);

    mar = new MarionetteClient(FF_MARIONETTE_PORT);
    await mar.connect(25000);
    await mar.send('WebDriver:NewSession', { capabilities: {} });
    await mar.send('WebDriver:SetWindowRect', { width: 1240, height: 820 });

    // Permanent install (temporary: false) under signature enforcement!
    const ffInstall = await mar.send('Addon:Install', { path: SIGNED_V109_XPI, temporary: false }, 20000);
    await sleep(900);

    await mar.send('Marionette:SetContext', { value: 'chrome' });
    const sigCheck = (await mar.send('WebDriver:ExecuteAsyncScript', {
      script: `
        const done = arguments[arguments.length - 1];
        (async () => {
          const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
          const sigReq = Services.prefs.getBoolPref("xpinstall.signatures.required", false);
          let addon = null, policy = null;
          for (let i = 0; i < 30; i++) {
            addon = await AddonManager.getAddonByID("${EXPECTED_GECKO_ID}");
            policy = WebExtensionPolicy.getByID("${EXPECTED_GECKO_ID}");
            if (addon && addon.isActive && policy && policy.active) break;
            await new Promise(r => setTimeout(r, 200));
          }
          done({
            sigRequiredPref: sigReq,
            installedId: addon?.id || null,
            version: addon?.version || null,
            isActive: !!addon?.isActive,
            temporarilyInstalled: addon?.temporarilyInstalled,
            signedState: addon?.signedState,
            expectedSignedState: AddonManager.SIGNEDSTATE_SIGNED,
            signedMatch: addon?.signedState === AddonManager.SIGNEDSTATE_SIGNED,
            baseUrl: policy ? policy.getURL("") : null,
          });
        })();
      `,
      args: [],
    }, 15000))?.value;

    const sigOk = Boolean(
      ffInstall?.value === EXPECTED_GECKO_ID &&
        sigCheck?.sigRequiredPref === true &&
        sigCheck?.installedId === EXPECTED_GECKO_ID &&
        sigCheck?.version === '1.0.9' &&
        sigCheck?.isActive === true &&
        sigCheck?.temporarilyInstalled === false &&
        sigCheck?.signedMatch === true &&
        String(sigCheck?.baseUrl || '').startsWith('moz-extension://')
    );
    record(
      'FF109-SIG-01',
      'Clean Firefox profile with xpinstall.signatures.required=true accepts and activates signed v1.0.9 XPI permanently',
      sigOk,
      JSON.stringify(sigCheck)
    );

    // Open Options and Popup tabs in Firefox to test Native Messaging, Connection, Popup UI & HTTP Fallback
    await mar.send('WebDriver:ExecuteScript', {
      script: `
        const win = Services.wm.getMostRecentWindow("navigator:browser");
        win.gBrowser.addTrustedTab("${sigCheck.baseUrl}options/options.html");
        win.gBrowser.addTrustedTab("${sigCheck.baseUrl}popup/popup.html");
      `,
      args: [],
    });
    await sleep(1200);
    await mar.send('Marionette:SetContext', { value: 'content' });
    const rawHandles = await mar.send('WebDriver:GetWindowHandles', {});
    const handles = Array.isArray(rawHandles?.value) ? rawHandles.value : Array.isArray(rawHandles) ? rawHandles : [];
    let optHandle = null;
    let popHandle = null;
    let pageHandle = null;
    for (const h of handles) {
      await mar.send('WebDriver:SwitchToWindow', { handle: h });
      const u = (await mar.send('WebDriver:GetCurrentURL', {}))?.value || '';
      if (u.includes('options/options.html')) optHandle = h;
      else if (u.includes('popup/popup.html')) popHandle = h;
      else if (u.includes('/video.html')) pageHandle = h;
    }

    // Native Messaging test: clear key in storage -> call INITIATE_PAIRING & RECONNECT_DESKTOP
    await mar.send('WebDriver:SwitchToWindow', { handle: optHandle });
    const nativeRes = (await mar.send('WebDriver:ExecuteAsyncScript', {
      script: `
        const done = arguments[arguments.length - 1];
        (async () => {
          try {
            const api = typeof browser !== 'undefined' ? browser : chrome;
            await api.storage.local.set({
              tori_settings: {
                port: ${DESKTOP_GUI_PORT}, key: '', auto: true, cap: true, min: 0, pill: true,
                pos: 'Top right', picker: true, kind: 'Video', fmt: 'Best available',
                audio: true, badge: true, theme: 'light', accent: 'indigo',
                sites: [], types: ['zip','mkv','mp4']
              }
            });
            const pairRes = await api.runtime.sendMessage({ action: 'INITIATE_PAIRING' });
            const reconnRes = await api.runtime.sendMessage({ action: 'RECONNECT_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: '' });
            done({ pairRes, reconnRes });
          } catch (e) { done({ error: String(e) }); }
        })();
      `,
      args: [],
    }, 15000))?.value;

    const nativeOk = Boolean(
      nativeRes?.pairRes?.ok === true &&
        nativeRes?.pairRes?.token === API_TOKEN &&
        nativeRes?.reconnRes?.status === 'ok' &&
        nativeRes?.reconnRes?.nativeHost === true
    );
    record(
      'FF109-NATIVE-01',
      'Signed Firefox v1.0.9 Native Messaging INITIATE_PAIRING and RECONNECT_DESKTOP authenticate cleanly with QA Desktop',
      nativeOk,
      JSON.stringify(nativeRes)
    );

    // Check Popup & Options live Connected UI
    await mar.send('WebDriver:SwitchToWindow', { handle: popHandle });
    await sleep(700);
    const popCheck = (await mar.send('WebDriver:ExecuteScript', {
      script: `return { text: document.body.innerText, hasConnected: /Connected/i.test(document.body.innerText), dotClass: document.querySelector('#status-dot, .dot, .status')?.className || '' };`,
      args: [],
    }))?.value;
    await mar.send('WebDriver:SwitchToWindow', { handle: optHandle });
    await mar.send('WebDriver:Refresh', {});
    await sleep(600);
    const optCheck = (await mar.send('WebDriver:ExecuteScript', {
      script: `return { text: document.body.innerText, hasVer109: document.body.innerText.includes('1.0.9'), portVal: document.getElementById('port')?.value || document.querySelector('input[type="number"]')?.value || null };`,
      args: [],
    }))?.value;
    record(
      'FF109-CONN-01',
      'Firefox Popup & Options UI connect cleanly to v1.0.5 Desktop and display v1.0.9 metadata',
      Boolean(popCheck?.hasConnected && optCheck?.hasVer109),
      JSON.stringify({ popConnected: popCheck?.hasConnected, optVer109: optCheck?.hasVer109, optPort: optCheck?.portVal })
    );

    // HTTP Fallback test: break HKCU Mozilla NativeMessagingHosts temporarily -> confirm HTTP fallback still connects!
    registerBrokenFirefoxNativeHost();
    await sleep(250);
    const httpFallbackRes = (await mar.send('WebDriver:ExecuteAsyncScript', {
      script: `
        const done = arguments[arguments.length - 1];
        (async () => {
          const api = typeof browser !== 'undefined' ? browser : chrome;
          const ping = await api.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: '${API_TOKEN}', passive: true });
          const reconn = await api.runtime.sendMessage({ action: 'RECONNECT_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: '${API_TOKEN}' });
          done({ ping, reconn });
        })();
      `,
      args: [],
    }, 12000))?.value;
    registerQaFirefoxNativeHost();
    record(
      'FF109-HTTP-01',
      'HTTP API fallback succeeds cleanly when Firefox Native Messaging host manifest is unavailable',
      Boolean(httpFallbackRes?.ping?.status === 'ok' && httpFallbackRes?.ping?.mode === 'http' && httpFallbackRes?.reconn?.status === 'ok'),
      JSON.stringify(httpFallbackRes)
    );

    // Video Detection + Format Picker + Direct MP4 Download + Extensionless MKV Interception on /video.html
    await mar.send('WebDriver:SwitchToWindow', { handle: pageHandle });
    await mar.send('WebDriver:Refresh', {});
    let pillFound = false;
    for (let i = 0; i < 25; i++) {
      await sleep(300);
      pillFound = Boolean(
        (await mar.send('WebDriver:ExecuteScript', { script: `return !!document.querySelector('.tori-mp .tori-pill');`, args: [] }))?.value
      );
      if (pillFound) break;
    }

    const beforeVidIds = new Set((await fetchJobs()).map((j) => j.id));
    let pickerState = null;
    if (pillFound) {
      pickerState = (await mar.send('WebDriver:ExecuteAsyncScript', {
        script: `
          const done = arguments[arguments.length - 1];
          (async () => {
            const pn = document.querySelector('.tori-mp .tori-pn');
            const pill = document.querySelector('.tori-mp .tori-pill');
            if (pill && (!pn || !pn.classList.contains('on'))) pill.click();
            await new Promise(r => setTimeout(r, 900));
            const rows = Array.from(document.querySelectorAll('.tori-mp .tori-fr')).map(el => el.textContent.trim().replace(/\\s+/g, ' '));
            const dl = document.querySelector('.tori-mp [data-act="download"]');
            const panelOpen = !!document.querySelector('.tori-mp .tori-pn.on');
            const canClick = !!(dl && !dl.disabled);
            if (canClick) dl.click();
            await new Promise(r => setTimeout(r, 600));
            const toast = document.getElementById('tori-page-toast')?.textContent?.trim() || '';
            done({ panelOpen, rowCount: rows.length, rows: rows.slice(0, 3), canClick, toast });
          })();
        `,
        args: [],
      }, 15000))?.value;
    }
    const vidJob = await waitForCompletedJob((j) => !beforeVidIds.has(j.id) && String(j.url).includes('/media/sample_ff109.mp4'), 25000);
    const vidDiskOk = Boolean(vidJob?.state === 'completed' && vidJob?.target_path && fs.existsSync(vidJob.target_path) && sha256File(vidJob.target_path) === sampleMp4Sha);
    record(
      'FF109-PICKER-01',
      'Video overlay detection, Format Picker UI, and MP4 download completion verify cleanly on Firefox signed v1.0.9',
      Boolean(pillFound && pickerState?.panelOpen && pickerState?.rowCount >= 1 && pickerState?.canClick && vidDiskOk),
      JSON.stringify({ pillFound, pickerState, vidPath: vidJob?.target_path })
    );

    // MKV Interception test via extensionless /ff_v109_signed_mkv click
    const beforeMkvIds = new Set((await fetchJobs()).map((j) => j.id));
    await mar.send('WebDriver:ExecuteScript', { script: `document.getElementById('dl-ff-mkv').click();`, args: [] });
    const mkvJob = await waitForCompletedJob(
      (j) => !beforeMkvIds.has(j.id) && String(j.filename).includes('Firefox_Signed_v109_Acceptance.mkv'),
      30000
    );
    const expectedMkvPath = path.join(QA_DL_DIR, 'Video', 'Firefox_Signed_v109_Acceptance.mkv');
    const mkvOk = Boolean(
      mkvJob?.state === 'completed' &&
        fs.existsSync(expectedMkvPath) &&
        fs.statSync(expectedMkvPath).size === mkvBytes.length &&
        sha256File(expectedMkvPath) === mkvSha
    );
    record(
      'FF109-MKV-01',
      'Extensionless Content-Disposition MKV intercepts cleanly in signed Firefox v1.0.9 and routes to Video/ with exact SHA-256',
      mkvOk,
      JSON.stringify({ state: mkvJob?.state, path: mkvJob?.target_path, expectedMkvPath, bytes: fs.existsSync(expectedMkvPath) ? fs.statSync(expectedMkvPath).size : 0 })
    );

    // Live YouTube Video Format Picker + Download Playlist -> Tray Restore -> PlaylistModal -> Real Download + Mix Rejection
    const t0Resolve = Date.now();
    await mar.send('WebDriver:ExecuteScript', { script: `window.location.href = arguments[0];`, args: [WATCH_PLAYLIST_URL] });
    let ytReady = null;
    let ytRetried = false;
    let lastPanelDiag = null;
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      try {
        ytReady = (await mar.send('WebDriver:ExecuteScript', {
          script: `
            const shouldRetry = arguments[0];
            const pn = document.querySelector('.tori-mp .tori-pn');
            const pill = document.querySelector('.tori-mp .tori-pill');
            if (pill && (!pn || !pn.classList.contains('on'))) pill.click();
            const retryBtn = document.querySelector('.tori-mp [data-act="retry"]');
            if (retryBtn && shouldRetry) {
              retryBtn.click();
              return { retried: true };
            }
            const plBtn = document.querySelector('.tori-mp [data-act="open-playlist"]');
            const rows = Array.from(document.querySelectorAll('.tori-mp .tori-fr')).map(el => el.textContent.trim().replace(/\\s+/g, ' '));
            const hasHd = rows.some(r => /1080p|720p|480p/i.test(r));
            if (plBtn && hasHd) return { ready: true, rowCount: rows.length, sampleRows: rows.slice(0, 4) };
            return {
              ready: false,
              href: location.href,
              hasMp: !!document.querySelector('.tori-mp'),
              pillTag: pill ? pill.querySelector('.tori-pill-tag')?.textContent : null,
              hasPlBtn: !!plBtn,
              hasRetry: !!retryBtn,
              stateMsg: document.querySelector('.tori-mp .state')?.textContent?.trim()?.replace(/\\s+/g, ' ') || null,
              rowCount: rows.length,
            };
          `,
          args: [!ytRetried],
        }, 5000))?.value;
        if (ytReady?.retried) {
          ytRetried = true;
          ytReady = null;
          continue;
        }
        if (ytReady?.ready) break;
        if (ytReady) lastPanelDiag = ytReady;
      } catch {}
    }

    let apiResolveDiag = null;
    if (!ytReady?.ready) {
      const apiProbe = await httpJson({
        port: DESKTOP_GUI_PORT,
        reqPath: '/api/v1/media/resolve',
        method: 'POST',
        headers: { 'X-Tori-Token': API_TOKEN },
        body: { url: 'https://www.youtube.com/watch?v=u9lj-c29dxI' },
        timeoutMs: 35000,
      });
      apiResolveDiag = { status: apiProbe.status, ok: apiProbe.ok, fmtCount: apiProbe.data?.formats?.length || 0, err: apiProbe.error || apiProbe.data?.message || null };
    }

    const ffShot = await mar.send('WebDriver:TakeScreenshot', { full: false });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '01_firefox_signed_v109_youtube_picker_and_playlist.png'), Buffer.from(ffShot.value, 'base64'));

    record(
      'FF109-YT-FMT-01',
      'Live YouTube page resolves genuine multi-resolution quality formats and shows Download Playlist banner in signed v1.0.9',
      Boolean(ytReady?.ready && ytReady?.rowCount >= 3),
      JSON.stringify({ ...(ytReady?.ready ? ytReady : lastPanelDiag || {}), retriedAfterColdTimeout: ytRetried, elapsedMs: Date.now() - t0Resolve, apiResolveDiag })
    );

    // Minimize QA Desktop to tray before clicking Download Playlist in Firefox!
    await deskCdp.evalAsync(`(async () => {
      const w = window.__TORI_MAIN_WINDOW__ || window.__TAURI__?.window?.getCurrentWindow?.();
      if (w && w.hide) await w.hide();
      else await fetch('http://127.0.0.1:${DESKTOP_GUI_PORT}/api/v1/window/hide', { method: 'POST', headers: { 'X-Tori-Token': '${API_TOKEN}' } });
    })()`, 5000).catch(() => {});
    await sleep(300);

    await mar.send('WebDriver:ExecuteScript', {
      script: `const btn = document.querySelector('.tori-mp [data-act="open-playlist"]'); if (btn) btn.click(); return !!btn;`,
      args: [],
    });
    try {
      await waitForContext(
        deskCdp,
        `Boolean(document.getElementById('playlist-modal') && document.querySelectorAll('#playlist-modal input[type="checkbox"]').length >= 3)`,
        45000,
        'ff109-playlist-modal'
      );
    } catch (plWaitErr) {
      const modalDiag = await deskCdp.evalAsync(`(() => {
        const m = document.getElementById('playlist-modal');
        return { hasModal: !!m, text: m ? (m.innerText || '').slice(0, 400) : null, cbs: m ? m.querySelectorAll('input[type="checkbox"]').length : 0 };
      })()`, 5000).catch((e) => ({ err: e.message }));
      throw new Error(`${plWaitErr.message} | modalDiag=${JSON.stringify(modalDiag)}`);
    }

    const beforePlIds = new Set((await fetchJobs()).map((j) => j.id));
    await deskCdp.evalAsync(`(async () => {
      const m = document.getElementById('playlist-modal');
      const tick = () => new Promise(r => setTimeout(r, 90));
      const allBtn = Array.from(m.querySelectorAll('button')).find(b => /Deselect All|Select All/i.test(b.textContent || ''));
      if (allBtn && /Deselect All/i.test(allBtn.textContent || '')) { allBtn.click(); await tick(); }
      const boxes = Array.from(m.querySelectorAll('input[type="checkbox"]')).filter(c => !c.disabled);
      const wing = boxes.find(c => /WING IT/i.test(c.closest('div')?.textContent || '')) || boxes[0];
      if (wing && !wing.checked) { wing.click(); await tick(); }
      const sel = m.querySelector('select');
      if (sel && Array.from(sel.options).some(o => o.value === '480p')) {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, '480p');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
      }
      const dl = Array.from(m.querySelectorAll('button')).find(b => /Download Selected/i.test(b.textContent || ''));
      if (dl) dl.click();
    })()`, 10000, { userGesture: true });

    const plJob = await waitForCompletedJob((j) => !beforePlIds.has(j.id), 75000);
    let plProbeOk = false;
    if (plJob?.state === 'completed' && plJob?.target_path && fs.existsSync(plJob.target_path)) {
      const probeJson = execFileSync(
        path.join(QA_APP_DIR, 'bin', 'ffprobe.exe'),
        ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', plJob.target_path],
        { encoding: 'utf8', timeout: 15000 }
      );
      const pr = JSON.parse(probeJson);
      plProbeOk = Boolean((pr.streams || []).length > 0 && parseFloat(pr.format?.duration || '0') > 30);
    }

    // Also test YouTube Mix rejection in signed v1.0.9 Firefox UI & Desktop API
    const mixCheck = (await mar.send('WebDriver:ExecuteAsyncScript', {
      script: `
        const done = arguments[arguments.length - 1];
        (async () => {
          const start = Date.now();
          history.pushState({}, '', '${WATCH_MIX_URL}');
          window.dispatchEvent(new Event('yt-navigate-finish'));
          const deadline = Date.now() + 4500;
          let snap = null;
          while (Date.now() < deadline) {
            const pn = document.querySelector('.tori-mp .tori-pn');
            const pill = document.querySelector('.tori-mp .tori-pill');
            if (pill && pn && !pn.classList.contains('on')) pill.click();
            const hasOpenBtn = !!document.querySelector('.tori-mp [data-act="open-playlist"]');
            const hasMixBanner = !!document.querySelector('.tori-mp [data-act="mix-info"]');
            snap = { href: location.href, hasOpenBtn, hasMixBanner, elapsedMs: Date.now() - start };
            if (!hasOpenBtn && hasMixBanner) break;
            await new Promise(r => setTimeout(r, 150));
          }
          done(snap);
        })();
      `,
      args: [],
    }, 8000))?.value;
    const mixApi = await httpJson({
      port: DESKTOP_GUI_PORT,
      reqPath: '/api/v1/media/playlist/open',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: WATCH_MIX_URL },
    });

    record(
      'FF109-PLAYLIST-01',
      'Signed Firefox v1.0.9 opens #playlist-modal, completes playable YouTube video download, and rejects Mix queues cleanly',
      Boolean(plJob?.state === 'completed' && plProbeOk && !mixCheck?.hasOpenBtn && mixCheck?.hasMixBanner && mixApi.status === 422),
      JSON.stringify({
        path: plJob?.target_path,
        diskBytes: plJob?.target_path && fs.existsSync(plJob.target_path) ? fs.statSync(plJob.target_path).size : 0,
        plProbeOk,
        mixCheck,
        mixApiStatus: mixApi.status,
      })
    );
  } finally {
    try { if (mar) await mar.send('Marionette:Quit', {}); } catch {}
    try { mar?.close(); } catch {}
    try { deskCdp?.close(); } catch {}
    cleanupProcs();
    if (fixtureServer) try { fixtureServer.close(); } catch {}
    restoreOemNativeHosts();
    await sleep(600);
    restoreOemDesktop();
    try { fs.rmSync(QA_ROOT, { recursive: true, force: true }); } catch {}
  }

  const v107After = sha256File(SIGNED_V107_XPI);
  const oemSnapAfter = readOemDbSnapshot();
  record(
    'FF109-SAFE-01',
    'Preserved signed v1.0.7 XPI and OEM user SQLite records remain 100% intact',
    v107After === EXPECTED_V107_SHA256 && oemSnapAfter.count === oemSnapBefore.count && oemSnapAfter.token === oemSnapBefore.token,
    `v107Sha=${v107After}, oemDownloads=${oemSnapAfter.count}`
  );

  console.log('\n========================================================================');
  console.log(` GATE 29.5.1 FIREFOX v1.0.9 SIGNED XPI: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.TIMEOUT} TIMEOUT, ${counts.NOT_TESTED} NOT TESTED`);
  console.log('========================================================================');
  if (counts.FAIL > 0 || counts.TIMEOUT > 0) process.exit(1);
}

run().catch((err) => {
  console.error('[FATAL]', err);
  cleanupProcs();
  restoreOemNativeHosts();
  restoreOemDesktop();
  process.exit(1);
});
