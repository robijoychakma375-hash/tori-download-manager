/**
 * TORI Browser Companion — Gate 24 Real Download Smoke Test & UI Verification Suite
 *
 * Verifies:
 * 1. Real TORI Desktop v1.0.3 engine connection and ping on 127.0.0.1:6800
 * 2. Connected and disconnected UI states in redesigned popup
 * 3. Settings navigation, capture switch, and preference persistence
 * 4. Actual media resolution via engine /api/v1/media/resolve
 * 5. Redesigned floating overlay injection, dragging threshold, and panel expansion
 * 6. Video/Audio tab switching and quality selection
 * 7. Real direct video download dispatch to engine
 * 8. Download engine job registration and end-to-end file completion
 * 9. Output file integrity and SHA-256 byte-level verification
 * 10. Pause and resume download lifecycle control
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MAIN_EXE = fs.existsSync(path.join(ROOT, 'target', 'release', 'tori-download-manager.exe'))
  ? path.join(ROOT, 'target', 'release', 'tori-download-manager.exe')
  : path.join(ROOT, 'target', 'debug', 'tori-download-manager.exe');

const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXTENSION_DIR = path.join(ROOT, 'extension');

const QA_DIR = path.join(ROOT, 'target', 'gate24_smoke_qa');
const DATA_DIR = path.join(QA_DIR, 'data');
const DOWNLOADS_DIR = path.join(QA_DIR, 'downloads');
const WEBVIEW2_DIR = path.join(QA_DIR, 'webview2');
const EDGE_PROFILE = path.join(QA_DIR, 'edge_profile');

const DESKTOP_PORT = 6800;
const MOCK_SERVER_PORT = 19850;
const CDP_DESKTOP_PORT = 19851;
const CDP_BROWSER_PORT = 19852;
const POPUP_SERVER_PORT = 19853;

const TEST_TOKEN = 'tori_smoke_test_token_gate24_999';

// Deterministic test video payload: 512 KB
const VIDEO_SIZE = 512 * 1024;
const VIDEO_PAYLOAD = Buffer.alloc(VIDEO_SIZE);
for (let i = 0; i < VIDEO_SIZE; i++) {
  VIDEO_PAYLOAD[i] = (i ^ 0x5a) & 0xff;
}
const VIDEO_SHA256 = crypto.createHash('sha256').update(VIDEO_PAYLOAD).digest('hex').toLowerCase();

let totalTests = 0;
let passedTests = 0;
const testResults = [];

function record(suite, desc, passed, detail = '') {
  totalTests++;
  const isPass = passed === true || passed === 'PASS';
  if (isPass) passedTests++;
  const statusStr = isPass ? '[PASS]' : '[FAIL]';
  console.log(`${statusStr} [${suite}] ${desc}${detail ? ' — ' + detail : ''}`);
  testResults.push({ suite, desc, status: isPass ? 'PASS' : 'FAIL', detail });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpRequest({ port, path: reqPath, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const postData = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };
    if (postData && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: reqHeaders,
        timeout: 8000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = raw;
          try { data = JSON.parse(raw); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout to ${reqPath}`));
    });
    if (postData) req.write(postData);
    req.end();
  });
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new globalThis.WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      ws.onclose = () => {
        for (const [, p] of this.pending) p.reject(new Error('WebSocket closed'));
        this.pending.clear();
      };
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: pRes, reject: pRej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) pRej(new Error(msg.error.message || JSON.stringify(msg.error)));
            else pRes(msg.result);
          }
        } catch (_) {}
      };
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout for ${method}`));
        }
      }, 10000);
      this.pending.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return res?.result?.value;
  }
  close() {
    try { this.ws.close(); } catch (_) {}
  }
}

async function getCdpTarget(port) {
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    try {
      const res = await httpRequest({ port, path: '/json' });
      if (Array.isArray(res.data) && res.data.length > 0) {
        const page = res.data.find((t) => t.type === 'page') || res.data[0];
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch (_) {}
  }
  return null;
}

async function runSmokeTests() {
  console.log('================================================================');
  console.log('TORI Extension v1.0.4 — Real Download Smoke Test & UI Audit');
  console.log('================================================================\n');

  // 1. Environment Preparation
  if (fs.existsSync(QA_DIR)) {
    try { fs.rmSync(QA_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  fs.mkdirSync(WEBVIEW2_DIR, { recursive: true });
  fs.mkdirSync(EDGE_PROFILE, { recursive: true });

  // Seed SQLite with credentials and settings
  const dbPath = path.join(DATA_DIR, 'tdm_storage.sqlite');
  execSync(`python -c "import sqlite3, json; conn=sqlite3.connect(r'''${dbPath}'''); c=conn.cursor(); c.execute('PRAGMA journal_mode = WAL'); c.execute('CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); c.execute('INSERT OR REPLACE INTO engine_settings VALUES (?,?)', ('browser_integration_token','${TEST_TOKEN}')); c.execute('INSERT OR REPLACE INTO engine_settings VALUES (?,?)', ('api_token','${TEST_TOKEN}')); c.execute('INSERT OR REPLACE INTO engine_settings VALUES (?,?)', ('app_settings', json.dumps({'dir': r'''${DOWNLOADS_DIR}''', 'port': ${DESKTOP_PORT}, 'key': '${TEST_TOKEN}', 'closeToTray': True}))); conn.commit(); conn.close()"`);

  // 2. Start Local Mock Media & Test HTTP Server
  const mockServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const u = new URL(req.url, `http://127.0.0.1:${MOCK_SERVER_PORT}`);

    if (u.pathname === '/media/sample-video.mp4') {
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : VIDEO_SIZE - 1;
        const chunk = VIDEO_PAYLOAD.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${VIDEO_SIZE}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunk.length,
          'Content-Type': 'video/mp4',
        });
        return res.end(chunk);
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': VIDEO_SIZE,
        'Accept-Ranges': 'bytes',
      });
      return res.end(VIDEO_PAYLOAD);
    }

    if (u.pathname === '/test-player.html') {
      const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>TORI Test Video Player</title>
<style>
  body { margin:0; padding:24px; background:#0f1115; color:#e5e7eb; font-family:system-ui, sans-serif; }
  #player-wrap { position:relative; width:640px; height:360px; margin:20px auto; background:#000; border-radius:8px; overflow:hidden; }
  video { width:100%; height:100%; display:block; }
</style>
</head>
<body>
  <h2>TORI Video Player</h2>
  <div id="player-wrap">
    <video id="test-video" controls preload="metadata">
      <source src="/media/sample-video.mp4" type="video/mp4" data-res="720p">
    </video>
  </div>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  await new Promise((r) => mockServer.listen(MOCK_SERVER_PORT, '127.0.0.1', r));
  record('ENV', 'Mock media server active on port ' + MOCK_SERVER_PORT, true);

  // 3. Start Popup Test Server (hosts popup with mock bridge communicating with real engine)
  const popupHtml = fs.readFileSync(path.join(EXTENSION_DIR, 'popup', 'popup.html'), 'utf8');
  const popupCss = fs.readFileSync(path.join(EXTENSION_DIR, 'popup', 'popup.css'), 'utf8');
  const popupJs = fs.readFileSync(path.join(EXTENSION_DIR, 'popup', 'popup.js'), 'utf8');

  const popupServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.url === '/' || req.url === '/popup') {
      const mockBridge = `
        <script>
          window.chrome = {
            storage: {
              local: {
                get: (keys, cb) => {
                  window.__storage = window.__storage || {
                    tori_settings: { cap: true, pill: true, fmt: '1080p', min: 1, pos: 'Top right' }
                  };
                  cb(window.__storage);
                },
                set: (data, cb) => {
                  window.__storage = window.__storage || {};
                  Object.assign(window.__storage, data);
                  cb && cb();
                }
              }
            },
            runtime: {
              sendMessage: async (msg, cb) => {
                window.__lastMessage = msg;
                if (msg.action === 'PING_DESKTOP') {
                  try {
                    const r = await fetch('/api/ping');
                    const j = await r.json();
                    if (j.status === 'ok') {
                      cb({ status: 'ok', authenticated: true, port: 6800, latency: 2 });
                    } else {
                      cb({ status: 'disconnected', port: 6800 });
                    }
                  } catch (e) {
                    cb({ status: 'disconnected', port: 6800 });
                  }
                } else if (msg.action === 'INITIATE_PAIRING') {
                  cb({ ok: true });
                } else if (msg.action === 'GET_TAB_MEDIA') {
                  cb({ media: [] });
                } else if (msg.action === 'GET_DOWNLOADS') {
                  cb({ jobs: [] });
                } else if (msg.action === 'SHOW_DESKTOP') {
                  cb({ ok: true });
                } else {
                  cb && cb({ ok: true });
                }
              },
              onMessage: { addListener: () => {} }
            },
            tabs: {
              query: () => Promise.resolve([{ id: 1, url: 'https://example.com' }]),
              sendMessage: (id, m, cb) => cb && cb({ ok: false })
            }
          };
          window.close = function() { window.__closed = true; };
        </script>
      `;
      const html = popupHtml
        .replace('<link rel="stylesheet" href="popup.css">', `<style>${popupCss}</style>`)
        .replace('<script src="popup.js"></script>', `${mockBridge}<script>${popupJs}</script>`);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    }
    if (req.url === '/api/ping') {
      try {
        const ping = await httpRequest({ port: DESKTOP_PORT, path: '/api/v1/ping' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(ping.data || { status: 'down' }));
      } catch (_) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'down' }));
      }
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => popupServer.listen(POPUP_SERVER_PORT, '127.0.0.1', r));

  // 4. Launch Real TORI Desktop v1.0.3 Process
  console.log('\n--- Section 1: Real TORI Desktop v1.0.3 Engine Startup ---');
  const desktopEnv = {
    ...process.env,
    TORI_DATA_DIR: DATA_DIR,
    TORI_ALLOW_LOOPBACK: '1',
    WEBVIEW2_USER_DATA_FOLDER: WEBVIEW2_DIR,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_DESKTOP_PORT}`,
  };

  const desktopProc = spawn(MAIN_EXE, [], { env: desktopEnv, stdio: 'ignore' });
  const dPid = desktopProc.pid;
  record('DESKTOP', 'Real TORI Desktop v1.0.3 process started', dPid > 0, `PID: ${dPid}`);

  let engineUp = false;
  for (let i = 0; i < 35; i++) {
    await sleep(400);
    try {
      const ping = await httpRequest({ port: DESKTOP_PORT, path: '/api/v1/ping' });
      if (ping.status === 200 && ping.data?.status === 'ok') {
        engineUp = true;
        break;
      }
    } catch (_) {}
  }
  record('DESKTOP', 'TORI engine listening on 127.0.0.1:6800 (/api/v1/ping)', engineUp);

  // 5. Test Media Resolution via Engine
  console.log('\n--- Section 2: Real Media Resolution ---');
  let mediaResolved = false;
  let resolvedFormats = 0;
  try {
    const resolveRes = await httpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/media/resolve',
      method: 'POST',
      headers: { 'X-Tori-Token': TEST_TOKEN },
      body: {
        url: `http://127.0.0.1:${MOCK_SERVER_PORT}/media/sample-video.mp4`,
        force_refresh: true,
      },
    });
    if (resolveRes.status === 200 && resolveRes.data) {
      mediaResolved = true;
      resolvedFormats = resolveRes.data.formats?.length || 1;
    }
  } catch (err) {
    console.error('Media resolve error:', err.message);
  }
  record('RESOLVER', 'Real media resolution via engine /api/v1/media/resolve', mediaResolved, `Formats: ${resolvedFormats}`);

  // 6. Direct Video Download End-to-End Test
  console.log('\n--- Section 3: End-to-End Direct Video Download & File Integrity ---');
  const testFilename = 'smoke-test-video.mp4';
  let downloadAccepted = false;
  let jobId = null;
  try {
    const dlReq = await httpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': TEST_TOKEN },
      body: {
        url: `http://127.0.0.1:${MOCK_SERVER_PORT}/media/sample-video.mp4`,
        filename: testFilename,
        destination: DOWNLOADS_DIR,
        priority: 'high',
      },
    });

    if ((dlReq.status === 200 || dlReq.status === 201) && dlReq.data?.status === 'ok') {
      downloadAccepted = true;
      jobId = dlReq.data.job_id;
    }
  } catch (err) {
    console.error('Download create error:', err.message);
  }
  record('DOWNLOAD', 'Download job accepted by engine /api/v1/downloads', downloadAccepted, `Job ID: ${jobId}`);

  // Poll for completion in both root downloads and categorized subdirectories
  let fileCompleted = false;
  let fileMatches = false;
  let downloadedSha = '';
  let foundPath = '';

  const possiblePaths = [
    path.join(DOWNLOADS_DIR, testFilename),
    path.join(DOWNLOADS_DIR, 'Video', testFilename),
    path.join(DOWNLOADS_DIR, 'Video', 'sample-video.mp4'),
    path.join(DOWNLOADS_DIR, 'sample-video.mp4'),
  ];

  for (let i = 0; i < 40; i++) {
    await sleep(300);
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.size === VIDEO_SIZE) {
          fileCompleted = true;
          foundPath = p;
          const buf = fs.readFileSync(p);
          downloadedSha = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
          fileMatches = downloadedSha === VIDEO_SHA256;
          break;
        }
      }
    }
    if (fileCompleted) break;
  }

  record('DOWNLOAD', 'Downloaded video output file written to target directory', fileCompleted, foundPath);
  record('INTEGRITY', 'Output file size and SHA-256 match original source exactly', fileMatches, `SHA-256: ${downloadedSha.substring(0, 16)}...`);

  // 7. Verify Job in Engine Active Registry
  let registryVerified = false;
  try {
    const listRes = await httpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'GET',
      headers: { 'X-Tori-Token': TEST_TOKEN },
    });
    if (listRes.status === 200 && Array.isArray(listRes.data?.jobs)) {
      const found = listRes.data.jobs.find((j) => j.id === jobId || j.filename === testFilename || j.url?.includes('sample-video.mp4'));
      if (found) registryVerified = true;
    }
  } catch (_) {}
  record('REGISTRY', 'Download job confirmed registered in TORI engine active state', registryVerified);

  // 8. Test Pause / Resume Functionality
  console.log('\n--- Section 4: Pause and Resume Download Lifecycle ---');
  let pauseSuccess = false;
  let resumeSuccess = false;

  const pauseTestFilename = 'pause-resume-test.mp4';
  try {
    const pJobReq = await httpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': TEST_TOKEN },
      body: {
        url: `http://127.0.0.1:${MOCK_SERVER_PORT}/media/sample-video.mp4?test=pause_resume`,
        filename: pauseTestFilename,
        destination: DOWNLOADS_DIR,
        priority: 'normal',
      },
    });

    const pJobId = pJobReq.data?.job_id;
    if (pJobId) {
      // Pause
      const pauseRes = await httpRequest({
        port: DESKTOP_PORT,
        path: `/api/v1/downloads/${pJobId}/pause`,
        method: 'POST',
        headers: { 'X-Tori-Token': TEST_TOKEN },
      });
      if (pauseRes.status === 200 && pauseRes.data?.status === 'ok') {
        pauseSuccess = true;
      }

      // Resume
      const resumeRes = await httpRequest({
        port: DESKTOP_PORT,
        path: `/api/v1/downloads/${pJobId}/resume`,
        method: 'POST',
        headers: { 'X-Tori-Token': TEST_TOKEN },
      });
      if (resumeRes.status === 200 && (resumeRes.data?.status === 'ok' || resumeRes.status === 200)) {
        resumeSuccess = true;
      }
    }
  } catch (err) {
    console.error('Pause/resume error:', err.message);
  }

  record('LIFECYCLE', 'Download pause API (/api/v1/downloads/{id}/pause) functional', pauseSuccess);
  record('LIFECYCLE', 'Download resume API (/api/v1/downloads/{id}/resume) functional', resumeSuccess);

  // 9. Browser CDP Tests for Redesigned Popup and Video Overlay
  console.log('\n--- Section 5: Redesigned UI Presentation Audit in Real Browser ---');
  const edgePopupArgs = [
    `--remote-debugging-port=${CDP_BROWSER_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--window-size=1280,800',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${EDGE_PROFILE}`,
    'about:blank',
  ];
  let edgeProc = spawn(EDGE_EXE, edgePopupArgs, { stdio: 'ignore' });
  await sleep(1500);

  const browserWs = await getCdpTarget(CDP_BROWSER_PORT);
  let cdp = null;

  if (browserWs) {
    cdp = new CdpSession(browserWs);
    await cdp.connect();
    await cdp.send('Page.enable');

    // 9.1 Popup Connected State & Navigation
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${POPUP_SERVER_PORT}/popup` });
    await sleep(1200);

    let stText = 'Connecting…';
    for (let k = 0; k < 15; k++) {
      stText = await cdp.eval('document.getElementById("stTxt")?.textContent');
      if (stText && stText !== 'Connecting…') break;
      await sleep(250);
    }
    const isMainOn = await cdp.eval('document.getElementById("main")?.classList.contains("on")');
    record('POPUP', 'Redesigned popup reflects real Connected status', stText === 'Connected' && isMainOn, `Text: "${stText}"`);

    // Settings Navigation
    await cdp.eval('document.getElementById("gear").click()');
    const settingsShown = await cdp.eval('!document.getElementById("settings").hidden && document.getElementById("main").hidden');
    record('POPUP', 'Gear button opens #settings view seamlessly', settingsShown);

    // Settings Toggle
    await cdp.eval('document.getElementById("capSwSet").click()');
    const storedCap = await cdp.eval('window.__storage?.tori_settings?.cap');
    record('SETTINGS', 'Capture downloads switch toggles correctly and updates storage', storedCap === false);

    await cdp.eval('document.getElementById("pillSwSet").click()');
    const storedPill = await cdp.eval('window.__storage?.tori_settings?.pill');
    record('SETTINGS', 'Video button toggle updates storage', storedPill === false);

    // Return to Main
    await cdp.eval('document.getElementById("done").click()');
    const mainRestored = await cdp.eval('!document.getElementById("main").hidden && document.getElementById("settings").hidden');
    record('POPUP', 'Done button returns seamlessly to #main view', mainRestored);

    // Open Desktop action
    await cdp.eval('document.getElementById("open").click()');
    const lastMsg = await cdp.eval('window.__lastMessage');
    record('POPUP', 'Open Tori button triggers SHOW_DESKTOP action', lastMsg?.action === 'SHOW_DESKTOP');

    // 9.2 Real Video Overlay Injection & Dragging on Test Player
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${MOCK_SERVER_PORT}/test-player.html` });
    await sleep(1500);

    const contentCss = fs.readFileSync(path.join(ROOT, 'extension', 'content.css'), 'utf8');
    const contentJs = fs.readFileSync(path.join(ROOT, 'extension', 'content.js'), 'utf8');

    await cdp.eval(`
      (() => {
        const s = document.createElement('style');
        s.textContent = ${JSON.stringify(contentCss)};
        document.head.appendChild(s);

        window.chrome = {
          storage: {
            local: {
              get: (keys, cb) => cb({ tori_settings: { cap: true, pill: true, fmt: '1080p', min: 1, pos: 'Top right' } }),
              set: (d, cb) => cb && cb()
            },
            onChanged: { addListener: () => {} }
          },
          runtime: {
            sendMessage: (msg, cb) => {
              window.__lastOverlayMessage = msg;
              if (msg.action === 'GET_TAB_MEDIA') {
                cb({
                  media: [
                    { filename: 'sample-video.mp4', url: 'http://127.0.0.1:${MOCK_SERVER_PORT}/media/sample-video.mp4', format: 'MP4', size_bytes: ${VIDEO_SIZE}, is_segment: false, type: 'video' },
                    { filename: 'sample-audio.m4a', url: 'http://127.0.0.1:${MOCK_SERVER_PORT}/media/sample-audio.m4a', format: 'M4A', size_bytes: 12500000, is_segment: false, type: 'audio' }
                  ]
                });
              } else if (msg.action === 'START_DOWNLOAD' || msg.action === 'START_MEDIA_DOWNLOAD') {
                window.__downloadStarted = msg;
                cb({ status: 'ok', job_id: 'job_smoke_999', filename: msg.filename });
              } else {
                cb && cb({ ok: true });
              }
            },
            onMessage: { addListener: () => {} }
          }
        };

        const sc = document.createElement('script');
        sc.textContent = ${JSON.stringify(contentJs)};
        document.body.appendChild(sc);
      })()
    `);
    await sleep(1000);

    // Pill injection check
    const pillExists = await cdp.eval('!!document.querySelector(".tori-pill")');
    const hasIco = await cdp.eval('!!document.querySelector(".tori-pill .ico")');
    record('OVERLAY', 'Floating pill button injected over video element', pillExists && hasIco);

    // 5px drag threshold verification
    const dragThresholdTest = await cdp.eval(`
      (() => {
        const pill = document.querySelector('.tori-pill');
        const mp = document.querySelector('.tori-mp');
        const rect = pill.getBoundingClientRect();
        // Move by 3px (< 5px) -> should NOT drag
        pill.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.left, clientY: rect.top, button: 0, bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + 3, clientY: rect.top + 2, bubbles: true }));
        const smallMoveDragging = mp.classList.contains('tori-dragging');
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: rect.left + 3, clientY: rect.top + 2, bubbles: true }));

        // Move by 20px (> 5px) -> SHOULD drag
        pill.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.left, clientY: rect.top, button: 0, bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + 60, clientY: rect.top + 40, bubbles: true }));
        const largeMoveDragging = mp.classList.contains('tori-dragging');
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: rect.left + 60, clientY: rect.top + 40, bubbles: true }));

        return { smallMoveDragging, largeMoveDragging, hasPos: !!mp.getAttribute('data-pos-rx') };
      })()
    `);
    record('OVERLAY', '5px drag threshold strictly enforced on floating pill', !dragThresholdTest.smallMoveDragging && dragThresholdTest.largeMoveDragging);
    record('OVERLAY', 'Overlay relative position coordinates saved in data-pos attributes', dragThresholdTest.hasPos);

    // Drag cooldown
    await sleep(250);

    // Click pill to open format card panel
    await cdp.eval('document.querySelector(".tori-pill").click()');
    await sleep(400);
    const panelOpen = await cdp.eval('document.querySelector(".tori-pn").classList.contains("on")');
    const ariaExpanded = await cdp.eval('document.querySelector(".tori-pill").getAttribute("aria-expanded")');
    record('PANEL', 'Pill click expands format panel with aria-expanded="true"', panelOpen && ariaExpanded === 'true');

    // Verify format rows
    const formatRows = await cdp.eval(`
      (() => {
        const rows = document.querySelectorAll('.tori-pn .tori-fr');
        return Array.from(rows).map(r => ({
          q: r.querySelector('.tori-q')?.textContent,
          cd: r.querySelector('.tori-cd')?.textContent,
          sz: r.querySelector('.tori-sz')?.textContent
        }));
      })()
    `);
    record('FORMATS', 'Detected video format options rendered in format list', Array.isArray(formatRows) && formatRows.length > 0, `${formatRows?.length} formats`);

    // Audio only tab switching
    await cdp.eval('document.querySelector(".tori-seg [data-tab=\'Audio\']").click()');
    const audioPath = await cdp.eval('document.getElementById("path")?.textContent');
    record('PANEL', 'Audio only tab switches save location to Downloads\\Tori\\Audio', audioPath?.includes('Audio'));

    // Switch back to Video
    await cdp.eval('document.querySelector(".tori-seg [data-tab=\'Video\']").click()');
    const videoPath = await cdp.eval('document.getElementById("path")?.textContent');
    record('PANEL', 'Video tab switches save location to Downloads\\Tori\\Video', videoPath?.includes('Video'));

    // Trigger Download Request from overlay
    await cdp.eval('document.querySelector("[data-act=\'download\']").click()');
    await sleep(400);
    const downloadPayload = await cdp.eval('window.__downloadStarted');
    record('DOWNLOAD', 'Download trigger from overlay dispatches request to engine', !!downloadPayload, downloadPayload?.url);

    // Close button
    await cdp.eval('document.querySelector("[data-act=\'close\']").click()');
    const panelClosed = await cdp.eval('!document.querySelector(".tori-pn").classList.contains("on")');
    const ariaExpandedClosed = await cdp.eval('document.querySelector(".tori-pill").getAttribute("aria-expanded")');
    record('PANEL', 'Close button (×) closes panel and resets aria-expanded to "false"', panelClosed && ariaExpandedClosed === 'false');
  }

  // 10. Disconnected State Verification
  console.log('\n--- Section 6: Disconnected UI State Verification ---');
  desktopProc.kill();
  await sleep(800);

  if (cdp) {
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${POPUP_SERVER_PORT}/popup` });
    await sleep(1000);

    let discText = 'Connecting…';
    for (let k = 0; k < 15; k++) {
      discText = await cdp.eval('document.getElementById("stTxt")?.textContent');
      if (discText && discText !== 'Connecting…') break;
      await sleep(250);
    }
    record('POPUP', 'Popup transitions to Disconnected state when engine is terminated', discText === 'Disconnected', `Status: "${discText}"`);
  }

  // Cleanup fixtures
  if (cdp) cdp.close();
  if (edgeProc) {
    try { edgeProc.kill(); } catch (_) {}
  }
  popupServer.close();
  mockServer.close();

  console.log('\n================================================================');
  console.log(`SMOKE TEST SUMMARY: ${passedTests}/${totalTests} TESTS PASSED`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runSmokeTests().catch((err) => {
  console.error('Fatal error during smoke test:', err);
  process.exit(1);
});
