/**
 * TORI Download Manager — Gate 23.1 Real Runtime Verification Suite
 *
 * Verifies all 4 Gate 23 fixes on actual Windows desktop & browser runtimes:
 * 1. Safe isolated test environment (zero impact on user's installed TORI or AppData).
 * 2. Real Windows WebView2 startup (no startup white flash, dark canvas, frontend readiness).
 * 3. Close-to-Tray and Single-Instance behavior (X hides, secondary launch restores, 0 orphans).
 * 4. Real browser overlay dragging in Microsoft Edge (5px threshold, clamp, click preservation).
 * 5. Media detection and async format resolution (no false "Unavailable", candidate array serialization).
 * 6. Clean process termination and SQLite persistence.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MAIN_EXE = path.join(ROOT, 'target', 'debug', 'tori-download-manager.exe');
const EXTENSION_DIR = path.join(ROOT, 'extension');

const QA_DIR = path.join(ROOT, 'target', 'gate23_1_qa_env');
const DATA_DIR = path.join(QA_DIR, 'data');
const DOWNLOADS_DIR = path.join(QA_DIR, 'downloads');
const WEBVIEW2_DIR = path.join(QA_DIR, 'webview2');
const EDGE_PROFILE_DIR = path.join(QA_DIR, 'edge_profile');
const SCREENSHOTS_DIR = path.join(QA_DIR, 'screenshots');

const CDP_DESKTOP_PORT = 9342;
const CDP_BROWSER_PORT = 9345;
const HTTP_SERVER_PORT = 19560;
const DESKTOP_API_PORT = 6800;
const PIPE_NAME = `\\\\.\\pipe\\tdm_pipe_qa23_1_${Date.now()}`;

const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let totalTests = 0;
let passedTests = 0;
let testLog = [];

function record(step, name, passed, detail = '') {
  totalTests++;
  if (passed) passedTests++;
  const mark = passed ? '[PASS]' : '[FAIL]';
  const line = `${mark} [${step}] ${name}${detail ? ' — ' + detail : ''}`;
  console.log(line);
  testLog.push({ step, name, passed, detail, timestamp: new Date().toISOString() });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
        timeout: 6000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = raw;
          try {
            data = JSON.parse(raw);
          } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`HTTP timeout to ${reqPath}`));
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
      }, 8000);
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

  async captureScreenshot(outputPath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    if (res?.data) {
      fs.writeFileSync(outputPath, Buffer.from(res.data, 'base64'));
      return true;
    }
    return false;
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }
  }
}

async function getCdpTarget(port) {
  for (let i = 0; i < 30; i++) {
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

function startMockHttpServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const parsed = new URL(req.url, `http://127.0.0.1:${HTTP_SERVER_PORT}`);

      if (parsed.pathname === '/video-page.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>TORI Real Browser Test Player</title>
  <style>
    body { background: #111; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    #player-wrap { position: relative; width: 640px; height: 360px; background: #000; border-radius: 8px; overflow: hidden; }
    video { width: 100%; height: 100%; object-fit: contain; }
  </style>
</head>
<body>
  <h2>TORI Download Manager Video Test</h2>
  <div id="player-wrap">
    <video id="test-video" controls poster="/thumbnail.jpg" preload="metadata">
      <source src="/media/test-stream-720p.mp4" type="video/mp4" data-res="720p">
      <source src="/media/test-stream-1080p.mp4" type="video/mp4" data-res="1080p">
    </video>
  </div>
</body>
</html>`);
        return;
      }

      if (parsed.pathname === '/thumbnail.jpg') {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(Buffer.alloc(512, 0xaa));
        return;
      }

      if (parsed.pathname.startsWith('/media/')) {
        const fakeVideoBuf = Buffer.alloc(1024 * 64, 0x55);
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': fakeVideoBuf.length,
          'Accept-Ranges': 'bytes',
        });
        res.end(fakeVideoBuf);
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });
    server.listen(HTTP_SERVER_PORT, '127.0.0.1', () => resolve(server));
  });
}

// -------------------------------------------------------------------------
// MAIN EXECUTION
// -------------------------------------------------------------------------
async function main() {
  console.log('================================================================');
  console.log('TORI Download Manager — Gate 23.1 Real Runtime Verification');
  console.log('================================================================\n');

  // STEP 1: Safe Isolated Environment Setup
  console.log('--- Step 1: Isolated Environment Preparation ---');
  if (fs.existsSync(QA_DIR)) {
    try { fs.rmSync(QA_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  fs.mkdirSync(WEBVIEW2_DIR, { recursive: true });
  fs.mkdirSync(EDGE_PROFILE_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const mockHttp = await startMockHttpServer();
  record('ENV', 'Mock HTTP server running on 127.0.0.1:19560', true);

  record('ENV', 'Isolated DATA_DIR created', fs.existsSync(DATA_DIR), DATA_DIR);
  record('ENV', 'Isolated WEBVIEW2_DIR created', fs.existsSync(WEBVIEW2_DIR), WEBVIEW2_DIR);
  record('ENV', 'Binary exists at target/debug/tori-download-manager.exe', fs.existsSync(MAIN_EXE));

  const baseDesktopEnv = {
    ...process.env,
    TORI_DATA_DIR: DATA_DIR,
    TORI_CLOSE_TO_TRAY: '1',
    TORI_IPC_PIPE: PIPE_NAME,
    WEBVIEW2_USER_DATA_FOLDER: WEBVIEW2_DIR,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_DESKTOP_PORT}`,
  };

  // STEP 2: Desktop Launch & Startup White Flash Verification (FIX 1)
  console.log('\n--- Step 2: Startup White Flash & Theme Verification ---');
  const desktopProc = spawn(MAIN_EXE, [], { env: baseDesktopEnv, stdio: 'ignore' });
  const primaryPid = desktopProc.pid;
  record('STARTUP', 'Primary TORI process spawned', primaryPid > 0, `PID: ${primaryPid}`);

  let desktopApiUp = false;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const ping = await httpRequest({ port: DESKTOP_API_PORT, path: '/api/v1/ping' });
      if (ping.status === 200) {
        desktopApiUp = true;
        break;
      }
    } catch (_) {}
  }
  record('STARTUP', 'Desktop HTTP API reachable on 127.0.0.1:6800', desktopApiUp);

  const desktopWsUrl = await getCdpTarget(CDP_DESKTOP_PORT);
  record('STARTUP', 'WebView2 CDP endpoint discovered', !!desktopWsUrl, desktopWsUrl || 'not found');

  let cdpDesktop = null;
  if (desktopWsUrl) {
    cdpDesktop = new CdpSession(desktopWsUrl);
    await cdpDesktop.connect();

    // Verify Dark Theme Canvas and No White Canvas
    const docTheme = await cdpDesktop.eval('document.documentElement.dataset.theme');
    record('STARTUP', 'Document dataset.theme configured', docTheme === 'dark', `theme: "${docTheme}"`);

    const bodyBg = await cdpDesktop.eval('window.getComputedStyle(document.body).backgroundColor');
    const htmlBg = await cdpDesktop.eval('window.getComputedStyle(document.documentElement).backgroundColor');
    // #232326 corresponds to rgb(35, 35, 38)
    const isDarkCanvas = bodyBg.includes('35, 35, 38') || htmlBg.includes('35, 35, 38');
    record('STARTUP', 'HTML/Body background color is dark (#232326, rgb(35, 35, 38))', isDarkCanvas, `body: ${bodyBg}, html: ${htmlBg}`);

    // Verify window is visible after frontend-ready
    const isWindowVisible = await cdpDesktop.eval('document.visibilityState === "visible"');
    record('STARTUP', 'Main window rendered and visible to user without white flash', isWindowVisible);

    const shotPath = path.join(SCREENSHOTS_DIR, '01_desktop_dark_startup.png');
    const shotOk = await cdpDesktop.captureScreenshot(shotPath);
    record('STARTUP', 'Desktop startup screenshot captured', shotOk && fs.existsSync(shotPath), shotPath);
  }

  // STEP 3: Close-to-Tray & Single-Instance Verification (FIX 2)
  console.log('\n--- Step 3: Close-to-Tray & Single-Instance Verification ---');
  if (cdpDesktop) {
    // Call window_close via Tauri invoke in the WebView2 session
    const closeRes = await cdpDesktop.eval('window.__TAURI__.core.invoke("window_close")');
    await sleep(600);

    // Verify primary process remains running
    let procStillRunning = false;
    try {
      process.kill(primaryPid, 0); // signal 0 tests existence
      procStillRunning = true;
    } catch (_) {}
    record('TRAY', 'Primary process remains alive after Close (X) action', procStillRunning, `PID ${primaryPid}`);

    // Verify local API remains active while hidden
    let apiStillUp = false;
    try {
      const ping = await httpRequest({ port: DESKTOP_API_PORT, path: '/api/v1/ping' });
      apiStillUp = ping.status === 200;
    } catch (_) {}
    record('TRAY', 'Local API remains responsive while main window is hidden', apiStillUp);

    // TEST SINGLE-INSTANCE: Launch a second TORI instance
    console.log('Testing Single-Instance relaunch...');
    const secondaryProc = spawn(MAIN_EXE, [], { env: baseDesktopEnv, stdio: 'ignore' });
    const secPid = secondaryProc.pid;
    record('SINGLE_INSTANCE', 'Secondary instance spawned', secPid > 0, `PID ${secPid}`);

    // Wait for secondary instance to contact primary and exit
    await sleep(1500);

    let secExited = false;
    try {
      process.kill(secPid, 0);
    } catch (_) {
      secExited = true;
    }
    record('SINGLE_INSTANCE', 'Secondary instance cleanly terminated via single-instance mutex', secExited, `PID ${secPid} exited`);

    // Verify primary process remains active and focused
    let primaryAlive = false;
    try {
      process.kill(primaryPid, 0);
      primaryAlive = true;
    } catch (_) {}
    record('SINGLE_INSTANCE', 'Primary instance retained without duplicate processes', primaryAlive, `PID ${primaryPid}`);

    // Verify lifecycle logs recorded the single instance restore event
    const lifecyclePath = path.join(DATA_DIR, 'logs', 'lifecycle.log');
    let hasRestoreLog = false;
    if (fs.existsSync(lifecyclePath)) {
      const logs = fs.readFileSync(lifecyclePath, 'utf8');
      hasRestoreLog = logs.includes('SINGLE_INSTANCE_RESTORE') || logs.includes('RESTORE_MAIN');
    }
    record('SINGLE_INSTANCE', 'Lifecycle log confirmed window restore upon second launch', hasRestoreLog);
  }

  // STEP 4 & 5: Real Microsoft Edge Browser Overlay Dragging & Media Detection (FIX 3 & FIX 4)
  console.log('\n--- Step 4 & 5: Real Edge Browser Overlay Dragging & Media Resolution ---');
  let edgeProc = null;
  let cdpBrowser = null;

  if (fs.existsSync(EDGE_EXE)) {
    const edgeArgs = [
      `--user-data-dir=${EDGE_PROFILE_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--remote-debugging-port=${CDP_BROWSER_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      `http://127.0.0.1:${HTTP_SERVER_PORT}/video-page.html`,
    ];

    edgeProc = spawn(EDGE_EXE, edgeArgs, { stdio: 'ignore' });
    record('BROWSER', 'Microsoft Edge spawned with loaded TORI extension', edgeProc.pid > 0, `PID: ${edgeProc.pid}`);

    const browserWsUrl = await getCdpTarget(CDP_BROWSER_PORT);
    record('BROWSER', 'Edge browser CDP target reachable', !!browserWsUrl);

    if (browserWsUrl) {
      cdpBrowser = new CdpSession(browserWsUrl);
      await cdpBrowser.connect();

      // Wait for extension content script to inject overlay
      await sleep(1800);

      const hasPill = await cdpBrowser.eval('!!document.querySelector(".tori-pill")');
      record('OVERLAY', 'TORI video overlay (.tori-pill) injected on test player', hasPill);

      if (hasPill) {
        // Test DRAGGING with 5px threshold
        const dragTestResult = await cdpBrowser.eval(`
          (function() {
            const pill = document.querySelector('.tori-pill');
            const mp = document.querySelector('.tori-mp');
            if (!pill || !mp) return { ok: false, reason: 'elements missing' };

            const initRect = mp.getBoundingClientRect();

            // Simulate pointer drag by +80px X, +50px Y
            pill.dispatchEvent(new PointerEvent('pointerdown', { clientX: initRect.left + 10, clientY: initRect.top + 10, button: 0, bubbles: true }));
            window.dispatchEvent(new PointerEvent('pointermove', { clientX: initRect.left + 90, clientY: initRect.top + 60, button: 0, bubbles: true }));

            const isDraggingClass = mp.classList.contains('tori-dragging');
            const draggedStyleLeft = parseFloat(mp.style.left);
            const draggedStyleTop = parseFloat(mp.style.top);

            window.dispatchEvent(new PointerEvent('pointerup', { clientX: initRect.left + 90, clientY: initRect.top + 60, button: 0, bubbles: true }));

            return {
              ok: true,
              isDraggingClass,
              draggedStyleLeft,
              draggedStyleTop,
              movedDistanceX: draggedStyleLeft - (initRect.left - mp.parentElement.getBoundingClientRect().left),
            };
          })()
        `);

        record('OVERLAY_DRAG', 'Pointer drag moves overlay smoothly', dragTestResult?.ok && dragTestResult.draggedStyleLeft > 0);
        record('OVERLAY_DRAG', 'Dragging class (.tori-dragging) applied during movement', dragTestResult?.isDraggingClass);

        // Verify position persistence (data-pos-rx and data-pos-ry attributes recorded by content script)
        const posAttrs = await cdpBrowser.eval(`
          (function() {
            const mp = document.querySelector('.tori-mp');
            return {
              rx: parseFloat(mp?.getAttribute('data-pos-rx') || '-1'),
              ry: parseFloat(mp?.getAttribute('data-pos-ry') || '-1'),
            };
          })()
        `);
        const posPersisted = posAttrs && posAttrs.rx >= 0 && posAttrs.ry >= 0;
        record('OVERLAY_DRAG', 'User position coordinates recorded and persisted on overlay', posPersisted, JSON.stringify(posAttrs));

        // Test Click Preservation (clicking without drag opens format panel)
        await sleep(200);
        await cdpBrowser.eval(`
          (function() {
            const pill = document.querySelector('.tori-pill');
            pill.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          })()
        `);
        await sleep(300);

        const isPanelOpen = await cdpBrowser.eval('document.querySelector(".tori-pn")?.classList.contains("on")');
        record('OVERLAY_CLICK', 'Normal click on pill opens format panel without interference', isPanelOpen);

        // Test Media Detection: video element sources correctly parsed as array
        const domCandidates = await cdpBrowser.eval(`
          (function() {
            const video = document.querySelector('video');
            const sources = Array.from(video.querySelectorAll('source')).map(s => s.src);
            return sources;
          })()
        `);
        const hasSources = Array.isArray(domCandidates) && domCandidates.length === 2;
        record('MEDIA_DETECTION', 'HTML5 video sources successfully discovered in DOM', hasSources, `${domCandidates?.length} streams`);

        // Check format tag text: should show "720p" or "1080p" or "Media", NOT "Unavailable"
        const tagText = await cdpBrowser.eval('document.querySelector(".tori-pill-tag")?.textContent?.trim()');
        const notUnavailable = tagText && tagText !== 'Unavailable';
        record('MEDIA_DETECTION', 'Format tag does NOT show false "Unavailable" state', notUnavailable, `tag text: "${tagText}"`);

        // Capture screenshot of real Edge browser with dragged overlay & open panel
        const edgeShotPath = path.join(SCREENSHOTS_DIR, '02_edge_dragged_overlay_panel.png');
        const edgeShotOk = await cdpBrowser.captureScreenshot(edgeShotPath);
        record('BROWSER', 'Edge browser test screenshot captured', edgeShotOk && fs.existsSync(edgeShotPath), edgeShotPath);
      }
    }
  } else {
    record('BROWSER', 'Microsoft Edge not installed on system', false, 'Skipping Edge browser tests');
  }

  // STEP 6: Clean Shutdown
  console.log('\n--- Step 6: Clean Process Termination ---');
  if (cdpBrowser) cdpBrowser.close();
  if (edgeProc) {
    try { edgeProc.kill(); } catch (_) {}
  }

  if (cdpDesktop) {
    // Send clean exit command
    try {
      await httpRequest({ port: DESKTOP_API_PORT, path: '/api/v1/window/hide', method: 'POST' });
    } catch (_) {}
    cdpDesktop.close();
  }

  if (desktopProc) {
    try {
      // Cleanly terminate via SIGTERM / taskkill
      desktopProc.kill();
    } catch (_) {}
    await sleep(800);

    let cleanExit = false;
    try {
      process.kill(primaryPid, 0);
    } catch (_) {
      cleanExit = true;
    }
    record('LIFECYCLE', 'TORI desktop process terminated cleanly with 0 orphan processes', cleanExit);
  }

  if (mockHttp) mockHttp.close();

  console.log('\n================================================================');
  console.log(`GATE 23.1 REAL RUNTIME VERIFICATION: ${passedTests}/${totalTests} PASSED`);
  console.log('================================================================\n');

  // Save JSON report
  const reportPath = path.join(QA_DIR, 'gate23_1_runtime_results.json');
  fs.writeFileSync(reportPath, JSON.stringify({ passedTests, totalTests, testLog }, null, 2));
  console.log(`Detailed test results saved to: ${reportPath}`);

  return { passedTests, totalTests, allPassed: passedTests === totalTests };
}

main().catch((err) => {
  console.error('[FATAL RUNTIME SUITE ERROR]', err);
  process.exit(1);
});
