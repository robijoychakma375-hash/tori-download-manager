#!/usr/bin/env node
/**
 * TORI Gate 35.3 — Real Browser-Executed Adversarial & Compatibility Verification Suite
 *
 * Executes Browser Companion v1.0.11 RC LIVE in real installed browsers:
 *   - Google Chrome (CDP + isolated profile)
 *   - Microsoft Edge (CDP + isolated profile)
 *   - Mozilla Firefox (Marionette + isolated profile)
 *
 * Paired against the REAL frozen public Desktop v1.0.8 binary
 * (`release/v1.0.8-final-rc/tori-download-manager.exe` + `tdm-native-host.exe`)
 * inside a strictly isolated `target/gate35_3_qa/` sandbox (separate data dir, port, pipe).
 *
 * Snapshots and restores exact HKCU NativeMessagingHosts registry values in `finally`
 * (never touches OEM SQLite, OEM binary, OEM Downloads, or published v1.0.10/v1.0.8 artifacts).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const V108_DESKTOP_EXE = path.join(ROOT, 'release', 'v1.0.8-final-rc', 'tori-download-manager.exe');
const V108_HOST_EXE = path.join(ROOT, 'release', 'v1.0.8-final-rc', 'tdm-native-host.exe');
const FFMPEG_EXE = path.join(ROOT, 'resources', 'bin', 'ffmpeg.exe');

const RC11_DIR = path.join(ROOT, 'release', 'v1.0.11-extension-rc');
const CHR_EXT_DIR = path.join(RC11_DIR, 'tori-companion-v1.0.11-chromium');
const FF_ZIP_PATH = path.join(RC11_DIR, 'tori-companion-v1.0.11-firefox.zip');
const EXPECTED_GECKO_ID = 'tori-download-manager@toridm.org';
const EXPECTED_CHROME_ID = 'jfnfgmcbgapcpieaonbaolgebjaejcdm';

const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

const QA_ROOT = path.join(ROOT, 'target', 'gate35_3_qa');
const QA_DATA_DIR = path.join(QA_ROOT, 'data');
const QA_DL_DIR = path.join(QA_ROOT, 'downloads');
const QA_WV2_DIR = path.join(QA_ROOT, 'webview2');
const QA_SAMPLE_MP4 = path.join(QA_ROOT, 'sample_video.mp4');
const QA_NM_LOG = path.join(QA_ROOT, 'nm_invocations.log');
const QA_NM_CMD = path.join(QA_ROOT, 'qa_native_host.cmd');

const DESKTOP_PORT = 25991;
const PIPE_NAME = '\\\\.\\pipe\\tori-gate35-3-qa-ipc';
const FIXTURE_PORT_A = 25995;
const FIXTURE_PORT_B = 25996; // Distinct origin for real cross-origin iframe testing
const CHROME_CDP_PORT = 25997;
const EDGE_CDP_PORT = 25998;
const FF_MARIONETTE_PORT = 2853;
const API_TOKEN = 'tori_qa_g35_3_secret_token_98765';

const ZIP_PAYLOAD = Buffer.alloc(256 * 1024);
for (let i = 0; i < ZIP_PAYLOAD.length; i++) ZIP_PAYLOAD[i] = (i * 31 + 17) & 0xff;
const ZIP_SHA256 = crypto.createHash('sha256').update(ZIP_PAYLOAD).digest('hex');

const NM_REG_KEYS = [
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager',
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager',
  'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager',
];

const results = [];
const counts = { PASS: 0, FAIL: 0, BLOCKED: 0 };
const trackedProcs = new Set();
let regSnapshot = null;
let serverA = null;
let serverB = null;
let desktopProc = null;

function record(browser, id, desc, status, detail = '') {
  const norm = status === true ? 'PASS' : status === false ? 'FAIL' : status;
  counts[norm] = (counts[norm] || 0) + 1;
  console.log(`[${norm}] [${browser}] [${id}] ${desc}${detail ? ' -> ' + detail : ''}`);
  results.push({ browser, id, desc, status: norm, detail });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function killProcTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
  } catch {}
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

function snapshotNmRegistry() {
  const snap = {};
  for (const key of NM_REG_KEYS) {
    try {
      const out = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', timeout: 4000 });
      const m = out.match(/REG_SZ\s+(.+)/);
      snap[key] = m ? m[1].trim() : null;
    } catch {
      snap[key] = null;
    }
  }
  fs.writeFileSync(path.join(QA_ROOT, 'reg_snapshot.json'), JSON.stringify(snap, null, 2));
  return snap;
}

function restoreNmRegistry(snap) {
  if (!snap) return;
  for (const key of NM_REG_KEYS) {
    const prev = snap[key];
    try {
      if (prev === null) {
        execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore', timeout: 4000 });
      } else {
        execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', prev, '/f'], { stdio: 'ignore', timeout: 4000 });
      }
    } catch {}
  }
}

function verifyNmRegistryRestored(snap) {
  for (const key of NM_REG_KEYS) {
    let cur = null;
    try {
      const out = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', timeout: 4000 });
      const m = out.match(/REG_SZ\s+(.+)/);
      cur = m ? m[1].trim() : null;
    } catch {}
    if (cur !== snap[key]) {
      return { ok: false, key, expected: snap[key], actual: cur };
    }
  }
  return { ok: true };
}

function registerIsolatedNativeHost(targetBrowsers = ['chrome', 'edge', 'firefox']) {
  // Wrapper invokes REAL frozen v1.0.8 tdm-native-host.exe strictly inside QA sandbox
  // with TORI_DISABLE_AUTO_SPAWN=1 so it can never touch OEM Desktop or OEM SQLite.
  const cmdBody = [
    '@echo off',
    `echo %DATE% %TIME% INVOKED >> "${QA_NM_LOG}"`,
    `set "TORI_DATA_DIR=${QA_DATA_DIR}"`,
    `set "TORI_IPC_PIPE=${PIPE_NAME}"`,
    `set "TORI_LOCAL_PORT=${DESKTOP_PORT}"`,
    'set "TORI_DISABLE_AUTO_SPAWN=1"',
    'set "TORI_ALLOW_LOOPBACK=1"',
    `"${V108_HOST_EXE}" %*`,
    '',
  ].join('\r\n');
  fs.writeFileSync(QA_NM_CMD, cmdBody, 'ascii');

  const chrManifest = path.join(QA_ROOT, 'nm_chromium.json');
  const ffManifest = path.join(QA_ROOT, 'nm_firefox.json');
  fs.writeFileSync(
    chrManifest,
    JSON.stringify(
      {
        name: 'com.tori.download_manager',
        description: 'TORI Gate 35.3 Isolated QA Native Host (v1.0.8)',
        path: QA_NM_CMD,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${EXPECTED_CHROME_ID}/`],
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    ffManifest,
    JSON.stringify(
      {
        name: 'com.tori.download_manager',
        description: 'TORI Gate 35.3 Isolated QA Native Host FF (v1.0.8)',
        path: QA_NM_CMD,
        type: 'stdio',
        allowed_extensions: [EXPECTED_GECKO_ID],
      },
      null,
      2
    )
  );
  if (targetBrowsers.includes('chrome')) {
    execFileSync('reg', ['add', NM_REG_KEYS[0], '/ve', '/t', 'REG_SZ', '/d', chrManifest, '/f'], { stdio: 'ignore', timeout: 4000 });
  }
  if (targetBrowsers.includes('edge')) {
    execFileSync('reg', ['add', NM_REG_KEYS[1], '/ve', '/t', 'REG_SZ', '/d', chrManifest, '/f'], { stdio: 'ignore', timeout: 4000 });
  }
  if (targetBrowsers.includes('firefox')) {
    execFileSync('reg', ['add', NM_REG_KEYS[2], '/ve', '/t', 'REG_SZ', '/d', ffManifest, '/f'], { stdio: 'ignore', timeout: 4000 });
  }
}

function getNmInvocationCount() {
  if (!fs.existsSync(QA_NM_LOG)) return 0;
  return fs.readFileSync(QA_NM_LOG, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length;
}

function clearNmLog() {
  try {
    fs.writeFileSync(QA_NM_LOG, '', 'utf8');
  } catch {}
}

function ensureSampleMp4() {
  if (fs.existsSync(QA_SAMPLE_MP4) && fs.statSync(QA_SAMPLE_MP4).size > 4096) return;
  execFileSync(
    FFMPEG_EXE,
    ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=480x360:rate=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', QA_SAMPLE_MP4],
    { stdio: 'ignore', timeout: 15000 }
  );
}

function seedQaDesktopSqlite() {
  fs.mkdirSync(QA_DATA_DIR, { recursive: true });
  fs.mkdirSync(QA_DL_DIR, { recursive: true });
  const dbPath = path.join(QA_DATA_DIR, 'tdm_storage.sqlite');
  const py = `
import sqlite3, json, sys
db_path, dl_dir, token, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
app_settings = {
  "dir": dl_dir, "sort": False, "con": 4, "maxa": 3, "limMode": "off", "limV": 512, "limU": "KiB/s",
  "retries": 1, "dyn": True, "mps": 256, "mpsU": "KiB", "ua": "", "ssl": False, "lm": False,
  "track": True, "dns": "System DNS", "proxy": "none", "port": port, "key": token,
  "cap": True, "theme": "light", "accent": "indigo", "motion": False, "details": False,
  "showDownloadPopup": "never", "alwaysOnTop": False, "closeToTray": True
}
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES ('app_settings', ?)", (json.dumps(app_settings),))
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES ('browser_integration_token', ?)", (token,))
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES ('active_server_port', ?)", (str(port),))
conn.commit()
conn.close()
`;
  execFileSync('python', ['-c', py, dbPath, QA_DL_DIR, API_TOKEN, String(DESKTOP_PORT)], { stdio: 'inherit' });
}

function httpJson({ port, reqPath, method = 'GET', headers = {}, timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers, timeout: timeoutMs }, (res) => {
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
    req.end();
  });
}

async function listDesktopDownloads() {
  const r = await httpJson({
    port: DESKTOP_PORT,
    reqPath: '/api/v1/downloads',
    headers: { 'X-Tori-Token': API_TOKEN },
  });
  return Array.isArray(r.data?.jobs) ? r.data.jobs : [];
}

async function startDesktopV108() {
  const env = {
    ...process.env,
    TORI_DATA_DIR: QA_DATA_DIR,
    TORI_IPC_PIPE: PIPE_NAME,
    TORI_LOCAL_PORT: String(DESKTOP_PORT),
    TORI_ALLOW_LOOPBACK: '1',
    WEBVIEW2_USER_DATA_FOLDER: QA_WV2_DIR,
  };
  desktopProc = spawn(V108_DESKTOP_EXE, ['--minimized'], { env, stdio: 'ignore' });
  trackedProcs.add(desktopProc);

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const r = await httpJson({
      port: DESKTOP_PORT,
      reqPath: '/api/v1/status',
      headers: { 'X-Tori-Token': API_TOKEN },
      timeoutMs: 1500,
    });
    if (r.ok && r.data?.authenticated) {
      return r.data;
    }
    await sleep(300);
  }
  throw new Error('Timed out waiting for frozen Desktop v1.0.8 HTTP server');
}

function startFixtureServers() {
  const mp4Buf = fs.readFileSync(QA_SAMPLE_MP4);
  const videoHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>TORI Gate 35.3 Adversarial & Compat Fixture</title>
<style>
  body { background: #111; color: #eee; font-family: sans-serif; padding: 20px; }
  video { width: 480px; height: 360px; display: block; background: #000; }
  #dl-link { display: inline-block; margin-top: 16px; padding: 10px 18px; background: #4f46e5; color: #fff; text-decoration: none; border-radius: 6px; }
  iframe { width: 480px; height: 120px; border: 1px solid #444; margin-top: 16px; display: block; }
</style>
</head>
<body>
  <video id="v1" src="/sample.mp4" controls muted autoplay loop playsinline></video>
  <a id="dl-link" href="/sample_archive.zip" download="sample_archive.zip">Download Test Archive</a>
  <iframe id="xframe" src="http://127.0.0.1:${FIXTURE_PORT_B}/evil_iframe.html"></iframe>
  <script>
    window.__iframeAttackResult = null;
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'IFRAME_ATTACK_DONE') {
        window.__iframeAttackResult = e.data.report;
      }
    });
    window.runHostilePageAttack = async function(extId) {
      const report = {
        toriExtensionUrl: document.documentElement.dataset.toriExtensionUrl ?? null,
        dispatchResponseReceived: false,
        dispatchDetail: null,
        portalExists: !!document.getElementById('tori-overlay-portal-host'),
        portalShadowAccessible: false,
        syntheticClickAttempted: false,
        externalMsgSucceeded: false,
      };
      const host = document.getElementById('tori-overlay-portal-host');
      if (host && host.shadowRoot) report.portalShadowAccessible = true;

      // 1. Attempt __TORI_DISPATCH__ pairing token theft
      await new Promise((resolve) => {
        const reqId = 'atk_' + Math.random().toString(36).slice(2);
        const onResp = (ev) => {
          report.dispatchResponseReceived = true;
          report.dispatchDetail = ev.detail || true;
        };
        window.addEventListener('__TORI_RESPONSE__' + reqId, onResp, { once: true });
        window.dispatchEvent(new CustomEvent('__TORI_DISPATCH__', {
          detail: { action: 'INITIATE_PAIRING', payload: {}, id: reqId }
        }));
        setTimeout(() => {
          window.removeEventListener('__TORI_RESPONSE__' + reqId, onResp);
          resolve();
        }, 450);
      });

      // 2. Attempt synthetic untrusted clicks on overlay pill / download button
      const pill = document.querySelector('.tori-pill');
      if (pill) {
        report.syntheticClickAttempted = true;
        pill.click();
        pill.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      const dlBtn = document.querySelector('[data-act="download"]');
      if (dlBtn) {
        dlBtn.click();
        dlBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }

      // 3. Attempt chrome.runtime external messaging directly from page JS
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
          await new Promise((resolve) => {
            try {
              chrome.runtime.sendMessage(extId, { action: 'INITIATE_PAIRING' }, (res) => {
                if (res && (res.ok || res.token)) report.externalMsgSucceeded = true;
                resolve();
              });
            } catch (_) { resolve(); }
            setTimeout(resolve, 250);
          });
        }
      } catch (_) {}

      return report;
    };
  </script>
</body>
</html>`;

  const evilIframeHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Cross-Origin Evil Iframe</title></head>
<body>
<script>
  (async () => {
    const report = {
      origin: window.location.origin,
      toriExtensionUrl: document.documentElement.dataset.toriExtensionUrl ?? null,
      dispatchResponseReceived: false,
      hasRuntimeSendMessage: !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage),
    };
    await new Promise((resolve) => {
      const id = 'iframe_atk_1';
      window.addEventListener('__TORI_RESPONSE__' + id, () => { report.dispatchResponseReceived = true; }, { once: true });
      window.dispatchEvent(new CustomEvent('__TORI_DISPATCH__', { detail: { action: 'INITIATE_PAIRING', payload: {}, id } }));
      setTimeout(resolve, 400);
    });
    window.parent.postMessage({ type: 'IFRAME_ATTACK_DONE', report }, '*');
  })();
</script>
</body></html>`;

  serverA = http.createServer((req, res) => {
    const u = new URL(req.url || '/', `http://127.0.0.1:${FIXTURE_PORT_A}`);
    const p = u.pathname;
    const tag = (u.searchParams.get('b') || 'default').replace(/[^a-z0-9_-]/gi, '');
    if (p === '/video.html' || p === '/video-nav2') {
      const perBrowserHtml = videoHtml
        .replace('src="/sample.mp4"', `src="/sample.mp4?b=${tag}"`)
        .replace('href="/sample_archive.zip" download="sample_archive.zip"', `href="/sample_archive.zip?b=${tag}" download="sample_archive_${tag}.zip"`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(perBrowserHtml);
    } else if (p === '/sample.mp4') {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4Buf.length, 'Accept-Ranges': 'bytes' });
        return res.end();
      }
      const range = req.headers.range;
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        const start = m ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? Math.min(parseInt(m[2], 10), mp4Buf.length - 1) : mp4Buf.length - 1;
        const slice = mp4Buf.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${mp4Buf.length}`,
          'Content-Length': slice.length,
          'Accept-Ranges': 'bytes',
        });
        return res.end(slice);
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4Buf.length, 'Accept-Ranges': 'bytes' });
      res.end(mp4Buf);
    } else if (p === '/sample_archive.zip') {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': ZIP_PAYLOAD.length,
          'Content-Disposition': 'attachment; filename="sample_archive.zip"',
          'Accept-Ranges': 'bytes',
        });
        return res.end();
      }
      const range = req.headers.range;
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        const start = m ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? Math.min(parseInt(m[2], 10), ZIP_PAYLOAD.length - 1) : ZIP_PAYLOAD.length - 1;
        const slice = ZIP_PAYLOAD.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Type': 'application/zip',
          'Content-Range': `bytes ${start}-${end}/${ZIP_PAYLOAD.length}`,
          'Content-Length': slice.length,
          'Content-Disposition': 'attachment; filename="sample_archive.zip"',
          'Accept-Ranges': 'bytes',
        });
        return res.end(slice);
      }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': ZIP_PAYLOAD.length,
        'Content-Disposition': 'attachment; filename="sample_archive.zip"',
        'Accept-Ranges': 'bytes',
      });
      res.end(ZIP_PAYLOAD);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  serverB = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(evilIframeHtml);
  });

  return Promise.all([
    new Promise((r) => serverA.listen(FIXTURE_PORT_A, '127.0.0.1', r)),
    new Promise((r) => serverB.listen(FIXTURE_PORT_B, '127.0.0.1', r)),
  ]);
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }
  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const ws = new globalThis.WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP connect timeout')); }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = (err) => { clearTimeout(timer); reject(new Error(err?.message || 'CDP error')); };
      ws.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(String(evt.data)); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.res(msg.result);
        }
      };
    });
  }
  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }
      }, timeoutMs);
      this.pending.set(id, {
        res: (v) => { clearTimeout(timer); resolve(v); },
        rej: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalAsync(expression, timeoutMs = 12000, { userGesture = false } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, timeoutMs);
    if (r?.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'Eval exception');
    }
    return r?.result?.value;
  }
  close() { try { this.ws?.close(); } catch {} }
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
        if (String(e.message || e.code).includes('ECONNREFUSED')) { await sleep(300); continue; }
        throw e;
      }
    }
    throw new Error('Marionette connect timeout');
  }
  _connectOnce(timeoutMs) {
    return new Promise((resolve, reject) => {
      this.buf = Buffer.alloc(0);
      const sock = net.createConnection({ host: '127.0.0.1', port: this.port });
      this.socket = sock;
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; sock.destroy(); reject(new Error('Marionette handshake timeout')); } }, timeoutMs);
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Marionette ${cmd} timeout`)); }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(timer); resolve(v); }, rej: (e) => { clearTimeout(timer); reject(e); } });
      const body = JSON.stringify([0, id, cmd, params]);
      this.socket.write(`${Buffer.byteLength(body, 'utf8')}:${body}`);
    });
  }
  async evalAsync(fnBody, timeoutMs = 12000) {
    const r = await this.send('WebDriver:ExecuteAsyncScript', {
      script: `const done = arguments[arguments.length - 1]; Promise.resolve((async () => { ${fnBody} })()).then(v => done({ ok: true, v }), e => done({ ok: false, e: String(e) }));`,
      args: [],
    }, timeoutMs);
    const val = r?.value;
    if (!val?.ok) throw new Error(val?.e || 'Marionette eval failed');
    return val.v;
  }
  close() { try { this.socket?.destroy(); } catch {} }
}

async function waitForCdpTargets(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await httpJson({ port, reqPath: '/json/version', timeoutMs: 2000 });
    const l = await httpJson({ port, reqPath: '/json/list', timeoutMs: 2000 });
    if (v.ok && v.data?.webSocketDebuggerUrl && l.ok && Array.isArray(l.data)) {
      return { version: v.data, targets: l.data };
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for CDP on ${port}`);
}

async function waitForCond(fn, timeoutMs = 12000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(stepMs);
  }
  return null;
}

function submitChromeFolderDialogWin32(chromePid, folderPath) {
  return new Promise((resolve) => {
    const ps1 = path.join(QA_ROOT, `submit_dlg_${chromePid}.ps1`);
    fs.writeFileSync(
      ps1,
      `param([int]$ChromePid, [string]$FolderPath)
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeDlg353 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lp, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc lp, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
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
  if ([NativeDlg353]::Submit([uint32]$ChromePid, $FolderPath)) { Write-Output "OK"; exit 0 }
  Start-Sleep -Milliseconds 150
}
exit 1`,
      'utf8'
    );
    const p = spawn('powershell', ['-NoProfile', '-File', ps1, String(chromePid), folderPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', (c) => { try { fs.unlinkSync(ps1); } catch {} resolve(c === 0 && out.trim() === 'OK'); });
    p.on('error', () => { try { fs.unlinkSync(ps1); } catch {} resolve(false); });
  });
}

async function openTargetCdp(bCdp, cdpPort, url) {
  const created = await bCdp.send('Target.createTarget', { url });
  let tgt = null;
  for (let i = 0; i < 30; i++) {
    const tList = (await waitForCdpTargets(cdpPort, 5000)).targets;
    tgt = tList.find((t) => t.id === created.targetId && t.webSocketDebuggerUrl);
    if (tgt) break;
    await sleep(150);
  }
  if (!tgt) throw new Error(`Target not ready for ${url}`);
  const cdp = new CDPClient(tgt.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  return { cdp, targetId: created.targetId };
}

async function runChromiumFamilyBrowser(label, exe, cdpPort, { checkOfflineStartupFirst = false } = {}) {
  const profDir = path.join(QA_ROOT, `${label.toLowerCase()}_profile`);
  const dlDir = path.join(QA_ROOT, `${label.toLowerCase()}_dl`);
  fs.rmSync(profDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(profDir, 'Default'), { recursive: true });
  fs.mkdirSync(dlDir, { recursive: true });
  fs.writeFileSync(path.join(profDir, 'First Run'), '');
  fs.writeFileSync(
    path.join(profDir, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: dlDir, prompt_for_download: false }, profile: { default_content_setting_values: { automatic_downloads: 1 } } })
  );

  const isEdge = label === 'Edge';
  const extMgrUrl = isEdge ? 'edge://extensions/' : 'chrome://extensions/';

  const launchOnce = async () => {
    const proc = spawn(
      exe,
      [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${profDir}`,
        ...(isEdge ? [`--load-extension=${CHR_EXT_DIR}`, '--enable-unsafe-extension-debugging'] : []),
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=1280,900',
        'about:blank',
      ],
      { stdio: 'ignore' }
    );
    trackedProcs.add(proc);
    const { version } = await waitForCdpTargets(cdpPort, 20000);
    const bCdp = new CDPClient(version.webSocketDebuggerUrl);
    await bCdp.connect();
    return { proc, bCdp };
  };

  let { proc, bCdp } = await launchOnce();
  let extId = EXPECTED_CHROME_ID;

  try {
    // Load unpacked v1.0.11 RC
    const { cdp: mgrCdp, targetId: mgrId } = await openTargetCdp(bCdp, cdpPort, extMgrUrl);
    await waitForCond(() => mgrCdp.evalAsync(`typeof chrome !== 'undefined' && !!chrome.developerPrivate && document.readyState === 'complete'`), 12000);
    await mgrCdp.evalAsync(`chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })`, 6000);
    const findExt = async () => {
      const xs = await mgrCdp.evalAsync(`chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true })`, 6000);
      return (xs || []).find((x) => String(x.name || '').includes('TORI') && x.version === '1.0.11');
    };
    let ext = await findExt();
    if (!ext) {
      const loadP = mgrCdp.evalAsync(`chrome.developerPrivate.loadUnpacked().then(() => 'OK').catch(e => String(e))`, 20000, { userGesture: true });
      const dlgOk = await submitChromeFolderDialogWin32(proc.pid, CHR_EXT_DIR);
      await loadP;
      if (!dlgOk) throw new Error(`${label} Win32 Load Unpacked dialog failed`);
      await sleep(600);
      ext = await findExt();
    }
    if (!ext?.id) throw new Error(`${label} failed to load TORI v1.0.11`);
    extId = ext.id;
    record(label, 'LOAD', 'Loaded unpacked v1.0.11 RC with preserved extension ID', extId === EXPECTED_CHROME_ID, `id=${extId}, ver=${ext.version}`);
    mgrCdp.close();
    await bCdp.send('Target.closeTarget', { targetId: mgrId }).catch(() => {});

    // T1: Offline startup non-spawn check (before Desktop v1.0.8 is started)
    if (checkOfflineStartupFirst) {
      const pidsBefore = getRunningToriPids().length;
      await sleep(2200);
      const nmCount = getNmInvocationCount();
      const pidsAfter = getRunningToriPids().length;
      record(
        label,
        'STARTUP_OFFLINE',
        'No unsolicited Native Host invocation or Desktop spawn on unpaired startup when Desktop offline',
        nmCount === 0 && pidsAfter === pidsBefore,
        `nmInvocations=${nmCount}, toriPidsBefore=${pidsBefore}, toriPidsAfter=${pidsAfter}`
      );

      // Start REAL frozen Desktop v1.0.8 now!
      const statusInfo = await startDesktopV108();
      record('Desktop v1.0.8', 'BOOT', 'Frozen public Desktop v1.0.8 started in isolated sandbox', !!statusInfo.authenticated, `version=${statusInfo.version || '1.0.8'}, port=${DESKTOP_PORT}`);
    }

    // T2 & T3: Open real options/options.html -> seed v1.0.10 settings migration + real Native Messaging pairing with Desktop v1.0.8
    const { cdp: optCdp, targetId: optId } = await openTargetCdp(bCdp, cdpPort, `chrome-extension://${extId}/options/options.html`);
    await waitForCond(() => optCdp.evalAsync(`document.readyState === 'complete' && !!document.getElementById('ab-ver')`), 10000);
    const optVer = await optCdp.evalAsync(`document.getElementById('ab-ver')?.textContent?.trim()`);
    // Seed v1.0.10 settings (key empty, custom port/theme/accent/sites/types)
    await optCdp.evalAsync(`new Promise(r => chrome.storage.local.set({
      tori_settings: { port: ${DESKTOP_PORT}, key: '', auto: true, cap: true, incog: false, pill: true, picker: true, audio: true, badge: true, theme: 'dark', accent: 'emerald', min: 0, types: ['zip', 'mp4', 'exe'], sites: ['excluded.example.com'] },
      tori_theme: 'dark',
      tori_accent: 'emerald'
    }, () => r(true)))`);
    await optCdp.send('Page.reload', {});
    await sleep(700);
    const migrated = await optCdp.evalAsync(`new Promise(r => chrome.storage.local.get(['tori_settings','tori_theme','tori_accent'], v => r(v)))`);
    const migOk =
      optVer === '1.0.11' &&
      migrated?.tori_settings?.theme === 'dark' &&
      migrated?.tori_settings?.accent === 'emerald' &&
      migrated?.tori_settings?.port === DESKTOP_PORT &&
      Array.isArray(migrated?.tori_settings?.sites) &&
      migrated.tori_settings.sites.includes('excluded.example.com');
    record(label, 'MIGRATE', 'v1.0.10 -> v1.0.11 settings migration preserved theme, accent, sites, types, port', migOk, `ver=${optVer}, theme=${migrated?.tori_settings?.theme}`);

    // Real Native Messaging pairing from trusted options.html against Desktop v1.0.8!
    const nmBeforePair = getNmInvocationCount();
    const pairRes = await optCdp.evalAsync(`new Promise(r => chrome.runtime.sendMessage({ action: 'INITIATE_PAIRING' }, res => r(res)))`, 12000);
    const nmAfterPair = getNmInvocationCount();
    record(
      label,
      'NM_PAIR',
      'Trusted options.html Native Messaging INITIATE_PAIRING succeeds against frozen Desktop v1.0.8',
      pairRes?.ok === true && pairRes?.token === API_TOKEN && nmAfterPair > nmBeforePair,
      `ok=${pairRes?.ok}, tokenMatched=${pairRes?.token === API_TOKEN}, port=${pairRes?.port}, nmCalls=${nmAfterPair - nmBeforePair}`
    );

    // Verify GET_CONNECTION_STATUS from options.html reports connected to Desktop v1.0.8
    const connStatus = await optCdp.evalAsync(`new Promise(r => chrome.runtime.sendMessage({ action: 'GET_CONNECTION_STATUS' }, res => r(res)))`, 8000);
    record(
      label,
      'OPTIONS_STATUS',
      'Trusted options.html GET_CONNECTION_STATUS authenticates with Desktop v1.0.8',
      connStatus?.status === 'ok' && connStatus?.paired === true,
      `state=${connStatus?.connectionState}, ver=${connStatus?.version}`
    );
    optCdp.close();
    await bCdp.send('Target.closeTarget', { targetId: optId }).catch(() => {});

    // T4: Trusted popup/popup.html PING_DESKTOP + token minimization
    const { cdp: popCdp, targetId: popId } = await openTargetCdp(bCdp, cdpPort, `chrome-extension://${extId}/popup/popup.html`);
    await waitForCond(() => popCdp.evalAsync(`document.readyState === 'complete' && typeof chrome !== 'undefined'`), 10000);
    const popPing = await popCdp.evalAsync(`new Promise(r => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', passive: true }, res => r(res)))`, 8000);
    const popDls = await popCdp.evalAsync(`new Promise(r => chrome.runtime.sendMessage({ action: 'GET_DOWNLOADS' }, res => r(res)))`, 8000);
    record(
      label,
      'POPUP_AUTH',
      'Trusted popup.html PING_DESKTOP & GET_DOWNLOADS succeed with zero raw token leak',
      popPing?.status === 'ok' && popPing?.authenticated === true && popPing?.token === undefined && popDls?.status === 'ok',
      `auth=${popPing?.authenticated}, tokenLeaked=${popPing?.token !== undefined}, jobs=${popDls?.jobs?.length}`
    );
    popCdp.close();
    await bCdp.send('Target.closeTarget', { targetId: popId }).catch(() => {});

    // T5: REAL Browser-Executed Adversarial Attacks on Webpage + Cross-Origin Iframe + SPA Navigation
    const jobsBeforeAttack = (await listDesktopDownloads()).length;
    const nmBeforeAttack = getNmInvocationCount();
    const { cdp: pageCdp, targetId: pageId } = await openTargetCdp(bCdp, cdpPort, `http://127.0.0.1:${FIXTURE_PORT_A}/video.html?b=${label.toLowerCase()}`);
    await pageCdp.send('Page.enable');
    await waitForCond(() => pageCdp.evalAsync(`!!document.querySelector('.tori-pill') && !!window.__iframeAttackResult`), 12000);

    const pageAtk = await pageCdp.evalAsync(`window.runHostilePageAttack(${JSON.stringify(extId)})`, 10000);
    const iframeAtk = await pageCdp.evalAsync(`window.__iframeAttackResult`, 5000);

    // SPA navigation & iframe reload re-check
    await pageCdp.evalAsync(`(async () => {
      history.pushState({}, '', '/video-nav2');
      window.dispatchEvent(new PopStateEvent('popstate'));
      document.getElementById('xframe').src = 'http://127.0.0.1:${FIXTURE_PORT_B}/evil_iframe.html?nav=2';
      await new Promise(r => setTimeout(r, 700));
    })()`, 8000);
    const postNavAtk = await pageCdp.evalAsync(`window.runHostilePageAttack(${JSON.stringify(extId)})`, 10000);
    const jobsAfterAttack = (await listDesktopDownloads()).length;
    const nmAfterAttack = getNmInvocationCount();

    const advOk =
      pageAtk.toriExtensionUrl === null &&
      pageAtk.dispatchResponseReceived === false &&
      pageAtk.portalExists === true &&
      pageAtk.portalShadowAccessible === false &&
      pageAtk.externalMsgSucceeded === false &&
      iframeAtk?.toriExtensionUrl === null &&
      iframeAtk?.dispatchResponseReceived === false &&
      postNavAtk.toriExtensionUrl === null &&
      postNavAtk.dispatchResponseReceived === false &&
      jobsAfterAttack === jobsBeforeAttack &&
      nmAfterAttack === nmBeforeAttack;
    record(
      label,
      'ADVERSARIAL_LIVE',
      'Live browser adversarial attacks (page JS, __TORI_DISPATCH__, closed shadow, synthetic click, external msg, cross-origin iframe, SPA nav) ALL blocked',
      advOk,
      `urlLeak=${pageAtk.toriExtensionUrl}, dispatchResp=${pageAtk.dispatchResponseReceived}, shadowOpen=${pageAtk.portalShadowAccessible}, iframeResp=${iframeAtk?.dispatchResponseReceived}, jobsDelta=${jobsAfterAttack - jobsBeforeAttack}, nmDelta=${nmAfterAttack - nmBeforeAttack}`
    );

    // T6: Real trusted user click on overlay pill -> open format panel -> click Download -> queued in Desktop v1.0.8!
    const pillRect = await pageCdp.evalAsync(`(() => {
      const el = document.querySelector('.tori-pill');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    const clickAt = async (x, y) => {
      await pageCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await sleep(40);
      await pageCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
      await sleep(40);
      await pageCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
    };
    if (pillRect) await clickAt(pillRect.x, pillRect.y);
    const panelOpen = await waitForCond(() => pageCdp.evalAsync(`!!document.querySelector('.tori-pn.on [data-act="download"]:not([disabled])')`), 8000);
    let overlayDlOk = false;
    if (panelOpen) {
      const dlRect = await pageCdp.evalAsync(`(() => {
        const el = document.querySelector('.tori-pn.on [data-act="download"]');
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      const beforeDl = (await listDesktopDownloads()).length;
      await clickAt(dlRect.x, dlRect.y);
      const afterDl = await waitForCond(async () => {
        const j = await listDesktopDownloads();
        return j.length > beforeDl ? j.length : null;
      }, 8000);
      overlayDlOk = afterDl !== null && afterDl > beforeDl;
    }
    record(label, 'OVERLAY_USER_DL', 'Real trusted click opens overlay panel and queues media download in Desktop v1.0.8', !!panelOpen && overlayDlOk, `panelOpen=${!!panelOpen}, queued=${overlayDlOk}`);

    // T7: Real Browser Download Interception (<a download="sample_archive.zip">) & Duplicate Prevention
    const beforeZipCount = (await listDesktopDownloads()).filter((j) => String(j.url || '').includes('sample_archive.zip')).length;
    const linkRect = await pageCdp.evalAsync(`(() => {
      const el = document.getElementById('dl-link');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await clickAt(linkRect.x, linkRect.y);
    const zipJob = await waitForCond(async () => {
      const jobs = await listDesktopDownloads();
      const matched = jobs.filter((j) => String(j.url || '').includes('sample_archive.zip'));
      if (matched.length > beforeZipCount) {
        const newest = matched[matched.length - 1];
        if (newest.state === 'Completed' || newest.state === 'completed') return newest;
      }
      return null;
    }, 15000);
    let zipHashOk = false;
    const resolvedZipPath = zipJob?.target_path || (zipJob?.filename ? path.join(QA_DL_DIR, zipJob.filename) : null);
    if (resolvedZipPath && fs.existsSync(resolvedZipPath)) {
      zipHashOk = sha256File(resolvedZipPath) === ZIP_SHA256;
    }
    record(label, 'INTERCEPT_DL', 'Real browser download intercepted & completed by Desktop v1.0.8 with exact SHA-256', !!zipJob && zipHashOk, `state=${zipJob?.state}, shaMatch=${zipHashOk}`);

    // Duplicate prevention: click again immediately within dedup window
    const countAfterFirst = (await listDesktopDownloads()).filter((j) => String(j.url || '').includes('sample_archive.zip')).length;
    await clickAt(linkRect.x, linkRect.y);
    await sleep(1500);
    const countAfterSecond = (await listDesktopDownloads()).filter((j) => String(j.url || '').includes('sample_archive.zip')).length;
    record(label, 'DEDUP', 'Duplicate download prevented within cooldown window', countAfterSecond === countAfterFirst, `before=${countAfterFirst}, after=${countAfterSecond}`);

    pageCdp.close();
    await bCdp.send('Target.closeTarget', { targetId: pageId }).catch(() => {});

    // T9: Restart browser on SAME profile (now containing completed download history!) -> verify ZERO stale replay!
    bCdp.close();
    killProcTree(proc.pid);
    trackedProcs.delete(proc);
    await sleep(1000);

    const jobsBeforeRestart = (await listDesktopDownloads()).length;
    const nmBeforeRestart = getNmInvocationCount();
    const relaunched = await launchOnce();
    proc = relaunched.proc;
    bCdp = relaunched.bCdp;
    await sleep(2500);
    const jobsAfterRestart = (await listDesktopDownloads()).length;
    const nmAfterRestart = getNmInvocationCount();
    record(
      label,
      'RESTART_NO_REPLAY',
      'Browser restart with existing completed download history triggers ZERO stale download replays & ZERO unsolicited native-host spawns',
      jobsAfterRestart === jobsBeforeRestart && nmAfterRestart === nmBeforeRestart,
      `jobsDelta=${jobsAfterRestart - jobsBeforeRestart}, nmDelta=${nmAfterRestart - nmBeforeRestart}`
    );
  } finally {
    try { bCdp.close(); } catch {}
    if (proc?.pid) killProcTree(proc.pid);
    trackedProcs.delete(proc);
  }
}

async function runFirefoxBrowser() {
  const label = 'Firefox';
  const profDir = path.join(QA_ROOT, 'firefox_profile');
  const dlDir = path.join(QA_ROOT, 'firefox_dl');
  fs.rmSync(profDir, { recursive: true, force: true });
  fs.mkdirSync(profDir, { recursive: true });
  fs.mkdirSync(dlDir, { recursive: true });

  fs.writeFileSync(
    path.join(profDir, 'user.js'),
    [
      'user_pref("marionette.enabled", true);',
      `user_pref("marionette.port", ${FF_MARIONETTE_PORT});`,
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("browser.startup.homepage_override.mstone", "ignore");',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.enabled", false);',
      'user_pref("xpinstall.signatures.required", true);',
      'user_pref("media.autoplay.default", 0);',
      'user_pref("browser.download.folderList", 2);',
      `user_pref("browser.download.dir", ${JSON.stringify(dlDir)});`,
      'user_pref("browser.download.useDownloadDir", true);',
    ].join('\n'),
    'utf8'
  );

  const proc = spawn(
    FIREFOX_EXE,
    ['-no-remote', '-marionette', '-profile', profDir, `http://127.0.0.1:${FIXTURE_PORT_A}/video.html`],
    { env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }, stdio: 'ignore' }
  );
  trackedProcs.add(proc);
  const mar = new MarionetteClient(FF_MARIONETTE_PORT);

  try {
    await mar.connect(25000);
    await mar.send('WebDriver:NewSession', { capabilities: {} });
    await mar.send('WebDriver:SetWindowRect', { width: 1280, height: 900 });

    // T8: Prove unsigned v1.0.11 Firefox ZIP is REJECTED for permanent install under strict signature enforcement!
    let permRejected = false;
    let permErr = '';
    try {
      await mar.send('Addon:Install', { path: FF_ZIP_PATH, temporary: false }, 15000);
    } catch (e) {
      permRejected = true;
      permErr = String(e.message || e).slice(0, 140);
    }
    record(
      label,
      'UNSIGNED_PERM_REJECT',
      'Standard Firefox (xpinstall.signatures.required=true) rejects permanent install of unsigned v1.0.11 ZIP (confirming AMO signing required)',
      permRejected,
      permErr
    );

    // Install temporarily for functional & adversarial QA
    const inst = await mar.send('Addon:Install', { path: FF_ZIP_PATH, temporary: true }, 20000);
    record(label, 'LOAD_TEMP', 'Temporary install of v1.0.11 RC succeeds with preserved Gecko ID', inst?.value === EXPECTED_GECKO_ID, `geckoId=${inst?.value}`);

    // Get moz-extension UUID via Marionette chrome context
    await mar.send('Marionette:SetContext', { value: 'chrome' });
    const extMeta = (await mar.send('WebDriver:ExecuteAsyncScript', {
      script: `
        const done = arguments[arguments.length - 1];
        (async () => {
          let policy = null;
          for (let i = 0; i < 30; i++) {
            policy = WebExtensionPolicy.getByID(${JSON.stringify(EXPECTED_GECKO_ID)});
            if (policy && policy.active) break;
            await new Promise(r => setTimeout(r, 200));
          }
          done({ active: !!policy?.active, mozExtensionHost: policy?.mozExtensionHostname || null });
        })();
      `,
      args: [],
    })).value;
    await mar.send('Marionette:SetContext', { value: 'content' });
    if (!extMeta?.mozExtensionHost) throw new Error('Firefox extension UUID not resolved');
    const ffBase = `moz-extension://${extMeta.mozExtensionHost}`;

    // T2 & T3: Options page migration + Native Messaging pairing against frozen Desktop v1.0.8
    await mar.send('WebDriver:Navigate', { url: `${ffBase}/options/options.html` });
    await sleep(700);
    const optVer = await mar.evalAsync(`return document.getElementById('ab-ver')?.textContent?.trim();`);
    await mar.evalAsync(`
      await new Promise(r => chrome.storage.local.set({
        tori_settings: { port: ${DESKTOP_PORT}, key: '', auto: true, cap: true, incog: false, pill: true, picker: true, audio: true, badge: true, theme: 'dark', accent: 'emerald', min: 0, types: ['zip', 'mp4', 'exe'], sites: ['excluded.example.com'] },
        tori_theme: 'dark',
        tori_accent: 'emerald'
      }, () => r(true)));
      return true;
    `);
    await mar.send('WebDriver:Refresh', {});
    await sleep(600);
    const mig = await mar.evalAsync(`return await new Promise(r => chrome.storage.local.get('tori_settings', v => r(v.tori_settings)));`);
    record(label, 'MIGRATE', 'v1.0.10 -> v1.0.11 settings migration preserved in Firefox', optVer === '1.0.11' && mig?.theme === 'dark' && mig?.accent === 'emerald' && mig?.port === DESKTOP_PORT, `ver=${optVer}, theme=${mig?.theme}`);

    const nmBefore = getNmInvocationCount();
    const pairRes = await mar.evalAsync(`return await new Promise(r => chrome.runtime.sendMessage({ action: 'INITIATE_PAIRING' }, res => r(res)));`, 12000);
    const nmAfter = getNmInvocationCount();
    record(
      label,
      'NM_PAIR',
      'Trusted options.html Native Messaging INITIATE_PAIRING succeeds in Firefox against frozen Desktop v1.0.8',
      pairRes?.ok === true && pairRes?.token === API_TOKEN && nmAfter > nmBefore,
      `ok=${pairRes?.ok}, tokenMatched=${pairRes?.token === API_TOKEN}, port=${pairRes?.port}`
    );

    // T4: Trusted popup.html check & token minimization
    await mar.send('WebDriver:Navigate', { url: `${ffBase}/popup/popup.html` });
    await sleep(600);
    const popPing = await mar.evalAsync(`return await new Promise(r => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', passive: true }, res => r(res)));`, 8000);
    record(
      label,
      'POPUP_AUTH',
      'Trusted popup.html PING_DESKTOP authenticates with Desktop v1.0.8 & strips raw token',
      popPing?.status === 'ok' && popPing?.authenticated === true && popPing?.token === undefined,
      `auth=${popPing?.authenticated}, tokenLeaked=${popPing?.token !== undefined}`
    );

    // T5: Real Firefox Adversarial Webpage + Cross-Origin Iframe + SPA Nav
    const jobsBeforeAtk = (await listDesktopDownloads()).length;
    const nmBeforeAtk = getNmInvocationCount();
    await mar.send('WebDriver:Navigate', { url: `http://127.0.0.1:${FIXTURE_PORT_A}/video.html?b=firefox` });
    await waitForCond(() => mar.evalAsync(`return !!document.querySelector('.tori-pill') && !!window.__iframeAttackResult;`), 12000);

    const pageAtk = await mar.evalAsync(`return await window.runHostilePageAttack(${JSON.stringify(EXPECTED_GECKO_ID)});`, 10000);
    const iframeAtk = await mar.evalAsync(`return window.__iframeAttackResult;`, 5000);
    await mar.evalAsync(`
      history.pushState({}, '', '/video-nav2');
      window.dispatchEvent(new PopStateEvent('popstate'));
      document.getElementById('xframe').src = 'http://127.0.0.1:${FIXTURE_PORT_B}/evil_iframe.html?nav=2';
      await new Promise(r => setTimeout(r, 700));
      return true;
    `, 8000);
    const postNavAtk = await mar.evalAsync(`return await window.runHostilePageAttack(${JSON.stringify(EXPECTED_GECKO_ID)});`, 10000);
    const jobsAfterAtk = (await listDesktopDownloads()).length;
    const nmAfterAtk = getNmInvocationCount();

    const ffAdvOk =
      pageAtk.toriExtensionUrl === null &&
      pageAtk.dispatchResponseReceived === false &&
      pageAtk.portalExists === true &&
      pageAtk.portalShadowAccessible === false &&
      iframeAtk?.toriExtensionUrl === null &&
      iframeAtk?.dispatchResponseReceived === false &&
      postNavAtk.toriExtensionUrl === null &&
      postNavAtk.dispatchResponseReceived === false &&
      jobsAfterAtk === jobsBeforeAtk &&
      nmAfterAtk === nmBeforeAtk;
    record(
      label,
      'ADVERSARIAL_LIVE',
      'Live Firefox adversarial attacks (page JS, __TORI_DISPATCH__, closed shadow, synthetic click, cross-origin iframe, SPA nav) ALL blocked',
      ffAdvOk,
      `urlLeak=${pageAtk.toriExtensionUrl}, dispatchResp=${pageAtk.dispatchResponseReceived}, shadowOpen=${pageAtk.portalShadowAccessible}, iframeResp=${iframeAtk?.dispatchResponseReceived}, jobsDelta=${jobsAfterAtk - jobsBeforeAtk}`
    );

    // T6: Real trusted WebDriver pointer click on Firefox overlay pill & download button
    const clickPoint = async (x, y) => {
      await mar.send('WebDriver:PerformActions', {
        actions: [{
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', duration: 30, x: Math.round(x), y: Math.round(y), origin: 'viewport' },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 40 },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      });
      await mar.send('WebDriver:ReleaseActions', {});
    };
    const pillRect = await mar.evalAsync(`const r = document.querySelector('.tori-pill')?.getBoundingClientRect(); return r ? { x: r.left + r.width/2, y: r.top + r.height/2 } : null;`);
    if (pillRect) await clickPoint(pillRect.x, pillRect.y);
    const panelOpen = await waitForCond(() => mar.evalAsync(`return !!document.querySelector('.tori-pn.on [data-act="download"]:not([disabled])');`), 8000);
    let ffOverlayDlOk = false;
    if (panelOpen) {
      const dlRect = await mar.evalAsync(`const r = document.querySelector('.tori-pn.on [data-act="download"]').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 };`);
      const before = (await listDesktopDownloads()).length;
      await clickPoint(dlRect.x, dlRect.y);
      const after = await waitForCond(async () => {
        const j = await listDesktopDownloads();
        return j.length > before ? j.length : null;
      }, 8000);
      ffOverlayDlOk = after !== null && after > before;
    }
    record(label, 'OVERLAY_USER_DL', 'Real trusted click opens Firefox overlay panel & queues download in Desktop v1.0.8', !!panelOpen && ffOverlayDlOk, `panelOpen=${!!panelOpen}, queued=${ffOverlayDlOk}`);

    // T7: Real Firefox download interception + dedup
    const beforeZipCount = (await listDesktopDownloads()).filter((j) => String(j.url || '').includes('sample_archive.zip')).length;
    const linkRect = await mar.evalAsync(`const r = document.getElementById('dl-link').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 };`);
    await clickPoint(linkRect.x, linkRect.y);
    const zipJob = await waitForCond(async () => {
      const jobs = await listDesktopDownloads();
      const matched = jobs.filter((j) => String(j.url || '').includes('sample_archive.zip'));
      if (matched.length > beforeZipCount) {
        const newest = matched[matched.length - 1];
        if (newest.state === 'Completed' || newest.state === 'completed') return newest;
      }
      return null;
    }, 15000);
    let zipHashOk = false;
    const resolvedZipPath = zipJob?.target_path || (zipJob?.filename ? path.join(QA_DL_DIR, zipJob.filename) : null);
    if (resolvedZipPath && fs.existsSync(resolvedZipPath)) {
      zipHashOk = sha256File(resolvedZipPath) === ZIP_SHA256;
    }
    record(label, 'INTERCEPT_DL', 'Real Firefox download intercepted & completed by Desktop v1.0.8 with exact SHA-256', !!zipJob && zipHashOk, `state=${zipJob?.state}, shaMatch=${zipHashOk}`);

    const afterFirst = (await listDesktopDownloads()).filter((j) => String(j.url || '').includes('sample_archive.zip')).length;
    await clickPoint(linkRect.x, linkRect.y);
    await sleep(1500);
    const afterSecond = (await listDesktopDownloads()).filter((j) => String(j.url || '').includes('sample_archive.zip')).length;
    record(label, 'DEDUP', 'Firefox duplicate download prevented within cooldown window', afterSecond === afterFirst, `before=${afterFirst}, after=${afterSecond}`);
  } finally {
    mar.close();
    if (proc?.pid) killProcTree(proc.pid);
    trackedProcs.delete(proc);
  }
}

async function main() {
  const watchdog = setTimeout(() => {
    console.error('[WATCHDOG] Hard 150s timeout reached; cleaning up processes & restoring registry...');
    for (const p of trackedProcs) {
      if (p?.pid) killProcTree(p.pid);
    }
    restoreNmRegistry(regSnapshot);
    process.exit(124);
  }, 150000);
  watchdog.unref();

  console.log('=== TORI Gate 35.3 — Real Browser-Executed Adversarial & Compatibility QA ===');
  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(QA_ROOT, { recursive: true });
  clearNmLog();

  ensureSampleMp4();
  seedQaDesktopSqlite();
  await startFixtureServers();

  regSnapshot = snapshotNmRegistry();

  try {
    // Register Chrome first (isolated from any unrelated user Edge session) and verify
    // unpaired startup with Desktop v1.0.8 OFFLINE triggers ZERO unsolicited NM spawns,
    // then boot real frozen Desktop v1.0.8 and test Chrome, Edge, and Firefox!
    registerIsolatedNativeHost(['chrome']);
    await runChromiumFamilyBrowser('Chrome', CHROME_EXE, CHROME_CDP_PORT, { checkOfflineStartupFirst: true });

    registerIsolatedNativeHost(['edge']);
    await runChromiumFamilyBrowser('Edge', EDGE_EXE, EDGE_CDP_PORT, { checkOfflineStartupFirst: false });

    registerIsolatedNativeHost(['firefox']);
    await runFirefoxBrowser();
  } finally {
    for (const p of trackedProcs) {
      if (p?.pid) killProcTree(p.pid);
    }
    trackedProcs.clear();
    try { serverA?.close(); } catch {}
    try { serverB?.close(); } catch {}
    restoreNmRegistry(regSnapshot);
    const restored = verifyNmRegistryRestored(regSnapshot);
    record('Sandbox', 'REG_RESTORE', 'Host HKCU NativeMessagingHosts registry restored bit-for-bit', restored.ok, JSON.stringify(restored));
  }

  fs.writeFileSync(path.join(QA_ROOT, 'results.json'), JSON.stringify({ counts, results }, null, 2));
  console.log(`\n=== SUMMARY: PASS=${counts.PASS} FAIL=${counts.FAIL} BLOCKED=${counts.BLOCKED} ===`);
  if (counts.FAIL > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  for (const p of trackedProcs) {
    if (p?.pid) killProcTree(p.pid);
  }
  restoreNmRegistry(regSnapshot);
  process.exit(1);
});
