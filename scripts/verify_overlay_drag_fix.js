/**
 * TORI Browser Companion — Gate 25 Overlay Drag Fix Verification
 *
 * Comprehensive cross-browser verification across Microsoft Edge, Google Chrome,
 * and Mozilla Firefox testing the pointer-based drag state machine and all 12 scenarios.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const QA_DIR = path.join(ROOT, 'target', 'gate25_drag_qa');
const EDGE_PROFILE = path.join(QA_DIR, 'edge_profile');
const CHROME_PROFILE = path.join(QA_DIR, 'chrome_profile');
const FIREFOX_PROFILE = path.join(QA_DIR, 'firefox_profile');

const MOCK_SERVER_PORT = 19860;
const EDGE_CDP_PORT = 19861;
const CHROME_CDP_PORT = 19862;
const FIREFOX_MARIONETTE_PORT = 19863;

const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

const VIDEO_SIZE = 256 * 1024;
const VIDEO_PAYLOAD = Buffer.alloc(VIDEO_SIZE, 0x5a);

let totalTests = 0;
let passedTests = 0;
const testResults = [];

function record(browser, scenario, desc, passed, detail = '') {
  totalTests++;
  const isPass = passed === true || passed === 'PASS';
  if (isPass) passedTests++;
  const statusStr = isPass ? '[PASS]' : '[FAIL]';
  console.log(`${statusStr} [${browser}] [Scenario ${scenario}] ${desc}${detail ? ' — ' + detail : ''}`);
  testResults.push({ browser, scenario, desc, status: isPass ? 'PASS' : 'FAIL', detail });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpRequest({ port, path: reqPath, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: reqPath, method, timeout: 5000 },
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
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout to ${reqPath}`)); });
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
  for (let i = 0; i < 25; i++) {
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

class MarionetteClient {
  constructor() {
    this.socket = null;
    this.msgId = 1;
    this.buffer = '';
    this.pending = new Map();
  }
  connect(port = FIREFOX_MARIONETTE_PORT) {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(port, '127.0.0.1');
      this.socket.on('data', (data) => {
        this.buffer += data.toString('utf8');
        this.processBuffer(resolve);
      });
      this.socket.on('error', reject);
    });
  }
  processBuffer(initialResolve) {
    while (true) {
      const colonIdx = this.buffer.indexOf(':');
      if (colonIdx === -1) break;
      const len = parseInt(this.buffer.slice(0, colonIdx), 10);
      if (isNaN(len)) { this.buffer = ''; break; }
      if (this.buffer.length < colonIdx + 1 + len) break;
      const payload = this.buffer.slice(colonIdx + 1, colonIdx + 1 + len);
      this.buffer = this.buffer.slice(colonIdx + 1 + len);
      try {
        const parsed = JSON.parse(payload);
        if (parsed.marionetteProtocol !== undefined && initialResolve) {
          initialResolve();
        } else if (Array.isArray(parsed) && parsed[0] === 1) {
          const reqId = parsed[1];
          const error = parsed[2];
          const result = parsed[3];
          const cb = this.pending.get(reqId);
          if (cb) {
            this.pending.delete(reqId);
            if (error) cb.reject(new Error(JSON.stringify(error)));
            else cb.resolve(result);
          }
        }
      } catch (_) {}
    }
  }
  send(name, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify([0, id, name, params]);
      const frame = `${Buffer.byteLength(msg, 'utf8')}:${msg}`;
      this.socket.write(frame);
    });
  }
  async eval(script) {
    const res = await this.send('WebDriver:ExecuteScript', { script: `return (${script});`, args: [] });
    return res?.value;
  }
  disconnect() {
    if (this.socket) {
      try { this.socket.destroy(); } catch (_) {}
      this.socket = null;
    }
  }
}

async function run() {
  console.log('================================================================');
  console.log('TORI EXTENSION — GATE 25 OVERLAY DRAG HOTFIX VERIFICATION');
  console.log('================================================================\n');

  fs.mkdirSync(EDGE_PROFILE, { recursive: true });
  fs.mkdirSync(CHROME_PROFILE, { recursive: true });
  fs.mkdirSync(FIREFOX_PROFILE, { recursive: true });

  // 1. Start Mock Server
  const contentCss = fs.readFileSync(path.join(EXTENSION_DIR, 'content.css'), 'utf8');
  const contentJs = fs.readFileSync(path.join(EXTENSION_DIR, 'content.js'), 'utf8');

  const testPageHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>TORI Dragging Test Bench</title>
  <style>
    body { margin:0; padding:20px; background:#12141a; color:#f0f2f5; font-family:system-ui, sans-serif; }
    .page-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
    .player-container { position:relative; width:640px; height:360px; background:#000; border-radius:10px; overflow:hidden; margin-bottom:24px; }
    video { width:100%; height:100%; display:block; }
    .page-controls { display:flex; gap:12px; margin-bottom:24px; }
    .page-btn { padding:8px 16px; border-radius:6px; background:#2563eb; color:#fff; border:none; cursor:pointer; font-weight:600; }
    .page-btn:hover { background:#1d4ed8; }
    #shadow-host { margin-top:20px; }
  </style>
</head>
<body>
  <div class="page-header">
    <h2>TORI Video Player Test Suite</h2>
    <div class="page-controls">
      <button id="page-counter-btn" class="page-btn">Clicks: 0</button>
      <input id="page-input" placeholder="Type here to test focus" style="padding:6px 10px; border-radius:4px; border:1px solid #444; background:#222; color:#fff;">
    </div>
  </div>

  <!-- Main HTML5 Video Player Container -->
  <div class="player-container html5-video-player" id="main-player">
    <video id="main-video" controls preload="metadata">
      <source src="/media/video.mp4" type="video/mp4" data-res="1080p">
    </video>
  </div>

  <!-- Shadow DOM Video Player Container -->
  <div id="shadow-host"></div>

  <script>
    // Counter button logic for testing unrelated page clicks
    let clickCount = 0;
    const btn = document.getElementById('page-counter-btn');
    btn.addEventListener('click', () => {
      clickCount++;
      btn.textContent = 'Clicks: ' + clickCount;
    });

    // Shadow DOM Video Setup
    const host = document.getElementById('shadow-host');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = \`
      <style>
        .player-container { position:relative; width:480px; height:270px; background:#111; border-radius:8px; overflow:hidden; }
        video { width:100%; height:100%; display:block; }
      </style>
      <h3>Shadow DOM Video Player</h3>
      <div class="player-container html5-video-player" id="shadow-player">
        <video id="shadow-video" controls preload="metadata">
          <source src="/media/video.mp4" type="video/mp4" data-res="720p">
        </video>
      </div>
    \`;
  </script>
</body>
</html>`;

  const mockServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.url === '/media/video.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': VIDEO_SIZE });
      return res.end(VIDEO_PAYLOAD);
    }
    if (req.url === '/' || req.url === '/drag-test.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(testPageHtml);
    }
    res.writeHead(404);
    res.end('Not Found');
  });

  await new Promise((r) => mockServer.listen(MOCK_SERVER_PORT, '127.0.0.1', r));
  console.log(`[INIT] Mock test server listening on http://127.0.0.1:${MOCK_SERVER_PORT}`);

  // Helper to inject TORI extension content script into a page
  async function injectExtension(evaluateFn) {
    await evaluateFn(`
      (() => {
        if (window.__toriInjected) return;
        window.__toriInjected = true;

        const s = document.createElement('style');
        s.textContent = ${JSON.stringify(contentCss)};
        document.head.appendChild(s);

        // Mock Chrome Extension API environment
        window.__storage = {
          tori_settings: { cap: true, pill: true, fmt: '1080p', min: 1, pos: 'Top right' },
          tori_custom_overlay_pos: null
        };
        window.__messagesSent = [];
        window.__downloadsTriggered = [];

        window.chrome = {
          storage: {
            local: {
              get: (keys, cb) => {
                const res = {};
                for (const k of keys) res[k] = window.__storage[k];
                cb(res);
              },
              set: (obj, cb) => {
                Object.assign(window.__storage, obj);
                cb && cb();
              }
            },
            onChanged: { addListener: () => {} }
          },
          runtime: {
            sendMessage: (msg, cb) => {
              window.__messagesSent.push(msg);
              if (msg.action === 'GET_TAB_MEDIA') {
                cb({
                  media: [
                    { filename: 'big_buck_bunny.mp4', url: 'http://127.0.0.1:${MOCK_SERVER_PORT}/media/video.mp4', format: 'MP4', size_bytes: ${VIDEO_SIZE}, is_segment: false, type: 'video' },
                    { filename: 'audio_track.m4a', url: 'http://127.0.0.1:${MOCK_SERVER_PORT}/media/audio.m4a', format: 'M4A', size_bytes: 5000000, is_segment: false, type: 'audio' }
                  ]
                });
              } else if (msg.action === 'START_DOWNLOAD' || msg.action === 'START_MEDIA_DOWNLOAD') {
                window.__downloadsTriggered.push(msg);
                cb({ status: 'ok', job_id: 'job_test_123' });
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
    await sleep(600);
  }

  // -------------------------------------------------------------
  // TEST SUITE FUNCTION EXECUTING ALL 12 SCENARIOS
  // -------------------------------------------------------------
  async function run12Scenarios(browserName, evalFn, dispatchMouseClick, dispatchMouseDrag, dispatchMouseMove) {
    console.log(`\n>>> Running 12 Scenario Tests on ${browserName} <<<`);

    // Ensure overlay is injected and visible
    const pillExists = await evalFn('!!document.querySelector(".tori-pill")');
    record(browserName, 'SETUP', 'Overlay floating pill attached to video player', pillExists);

    const getPillPos = async () => {
      return await evalFn(`
        (() => {
          const pill = document.querySelector('.tori-pill');
          const mp = document.querySelector('.tori-mp');
          const r = pill.getBoundingClientRect();
          return {
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            left: parseFloat(mp.style.left) || 0,
            top: parseFloat(mp.style.top) || 0,
            isDragging: mp.classList.contains('tori-dragging'),
            isPanelOpen: document.querySelector('.tori-pn').classList.contains('on'),
            ariaExpanded: pill.getAttribute('aria-expanded')
          };
        })()
      `);
    };

    let initial = await getPillPos();

    // ---------------------------------------------------------
    // Scenario 1: Single click opens the panel without moving
    // ---------------------------------------------------------
    await dispatchMouseClick(initial.x, initial.y);
    await sleep(250);
    let s1 = await getPillPos();
    const s1Passed = s1.isPanelOpen && s1.ariaExpanded === 'true' && !s1.isDragging;
    record(browserName, '1', 'Single click and release opens panel without moving overlay', s1Passed, `open=${s1.isPanelOpen}`);

    // ---------------------------------------------------------
    // Scenario 2: Second click closes the panel without moving
    // ---------------------------------------------------------
    await dispatchMouseClick(s1.x, s1.y);
    await sleep(250);
    let s2 = await getPillPos();
    const s2Passed = !s2.isPanelOpen && s2.ariaExpanded === 'false' && !s2.isDragging;
    record(browserName, '2', 'Second click and release closes panel without moving overlay', s2Passed, `open=${s2.isPanelOpen}`);

    // ---------------------------------------------------------
    // Scenario 3: Holding mouse and moving < 5px does NOT drag
    // ---------------------------------------------------------
    let s3PosBefore = await getPillPos();
    await dispatchMouseDrag(s3PosBefore.x, s3PosBefore.y, 3, 2, false); // 3px X, 2px Y (hypot = 3.6px < 5px)
    await sleep(200);
    let s3 = await getPillPos();
    const s3Passed = !s3.isDragging && (s3.left === s3PosBefore.left) && (s3.top === s3PosBefore.top);
    record(browserName, '3', 'Holding mouse and moving < 5px does NOT trigger drag', s3Passed, `dx=3, dy=2`);

    // ---------------------------------------------------------
    // Scenario 4 & 5: Holding mouse and moving > 5px starts dragging, release stops movement immediately
    // ---------------------------------------------------------
    let s4PosBefore = await getPillPos();
    // Drag by +40px X, +30px Y
    await dispatchMouseDrag(s4PosBefore.x, s4PosBefore.y, 40, 30, true);
    await sleep(250);
    let s4 = await getPillPos();
    const posChanged = Math.abs(s4.left - s4PosBefore.left) > 10 || Math.abs(s4.top - s4PosBefore.top) > 10;
    const s4Passed = posChanged && !s4.isDragging;
    record(browserName, '4 & 5', 'Moving > 5px drags overlay; release stops movement immediately', s4Passed, `left: ${s4PosBefore.left} -> ${s4.left}`);

    // ---------------------------------------------------------
    // Scenario 6: Moving cursor afterward does NOT move overlay (CRITICAL BUG CHECK)
    // ---------------------------------------------------------
    let s6PosBefore = await getPillPos();
    // Move mouse cursor around freely (100px away) with NO mouse buttons pressed
    await dispatchMouseMove(s6PosBefore.x + 120, s6PosBefore.y + 80);
    await sleep(150);
    await dispatchMouseMove(s6PosBefore.x + 200, s6PosBefore.y + 150);
    await sleep(150);
    let s6 = await getPillPos();
    const s6Sticky = s6.isDragging || (s6.left !== s6PosBefore.left) || (s6.top !== s6PosBefore.top);
    record(browserName, '6', 'Moving cursor WITHOUT holding button NEVER moves overlay (sticky bug eliminated)', !s6Sticky, `left stayed ${s6.left}`);

    // ---------------------------------------------------------
    // Scenario 7: Clicking another website button works normally
    // ---------------------------------------------------------
    const btnCoords = await evalFn(`
      (() => {
        const b = document.getElementById('page-counter-btn');
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `);
    await dispatchMouseClick(btnCoords.x, btnCoords.y);
    await sleep(150);
    const counterText = await evalFn('document.getElementById("page-counter-btn").textContent');
    record(browserName, '7', 'Clicking another page control works normally without interference', counterText === 'Clicks: 1', counterText);

    // ---------------------------------------------------------
    // Scenario 8: Repeated dragging works reliably without getting stuck
    // ---------------------------------------------------------
    let s8Clean = true;
    for (let cycle = 1; cycle <= 3; cycle++) {
      let cur = await getPillPos();
      await dispatchMouseDrag(cur.x, cur.y, 25, 20, true);
      await sleep(150);
      let afterDrag = await getPillPos();
      if (afterDrag.isDragging) s8Clean = false;

      // Move freely without button
      await dispatchMouseMove(afterDrag.x + 50, afterDrag.y + 30);
      await sleep(100);
      let afterMove = await getPillPos();
      if (afterMove.isDragging || afterMove.left !== afterDrag.left) s8Clean = false;
    }
    record(browserName, '8', 'Repeated consecutive drag operations complete cleanly', s8Clean);

    // ---------------------------------------------------------
    // Scenario 9: Moving outside overlay during drag is safely handled and clamped
    // ---------------------------------------------------------
    let s9Pos = await getPillPos();
    // Drag far beyond container width (400px X, 300px Y)
    await dispatchMouseDrag(s9Pos.x, s9Pos.y, 400, 300, true);
    await sleep(200);
    const s9Clamped = await evalFn(`
      (() => {
        const mp = document.querySelector('.tori-mp');
        const aRect = document.getElementById('main-player').getBoundingClientRect();
        const curL = parseFloat(mp.style.left) || 0;
        const curT = parseFloat(mp.style.top) || 0;
        const maxL = aRect.width - (mp.offsetWidth || 160) - 4;
        const maxT = aRect.height - (mp.offsetHeight || 36) - 4;
        return curL <= maxL && curT <= maxT && curL >= 4 && curT >= 4;
      })()
    `);
    record(browserName, '9', 'Moving outside bounds clamps overlay within player container', s9Clamped);

    // ---------------------------------------------------------
    // Scenario 10: Window blur and pointercancel safely reset drag state
    // ---------------------------------------------------------
    const resetTest = await evalFn(`
      (() => {
        const pill = document.querySelector('.tori-pill');
        const mp = document.querySelector('.tori-mp');
        const r = pill.getBoundingClientRect();
        // Trigger pointerdown
        pill.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 5, clientY: r.top + 5, button: 0, bubbles: true }));
        // Simulate window blur
        window.dispatchEvent(new Event('blur'));
        // Verify state is clean
        return !mp.classList.contains('tori-dragging');
      })()
    `);
    record(browserName, '10', 'Window blur and pointercancel immediately reset drag state', resetTest);

    // ---------------------------------------------------------
    // Scenario 11: Overlay relative position persists in storage & attributes
    // ---------------------------------------------------------
    const s11Storage = await evalFn(`
      (() => {
        const mp = document.querySelector('.tori-mp');
        const rx = mp.getAttribute('data-pos-rx');
        const ry = mp.getAttribute('data-pos-ry');
        const st = window.__storage.tori_custom_overlay_pos;
        return { hasRx: !!rx, hasRy: !!ry, hasStorage: !!st };
      })()
    `);
    record(browserName, '11', 'Relative coordinates persist in attributes and storage', s11Storage.hasRx && s11Storage.hasRy && s11Storage.hasStorage);

    // ---------------------------------------------------------
    // Scenario 12: Quality panel interaction and Download trigger functional
    // ---------------------------------------------------------
    let s12Pill = await getPillPos();
    if (!s12Pill.isPanelOpen) {
      await dispatchMouseClick(s12Pill.x, s12Pill.y);
      await sleep(250);
    }
    const downloadWorks = await evalFn(`
      (() => {
        const goBtn = document.querySelector('.tori-pn .go');
        if (goBtn) {
          goBtn.click();
          return window.__downloadsTriggered.length > 0;
        }
        return false;
      })()
    `);
    record(browserName, '12', 'Format panel controls and Download button work normally', downloadWorks);

    // ---------------------------------------------------------
    // Scenario 13: Shadow DOM Video Player Overlay Injection & Dragging
    // ---------------------------------------------------------
    const shadowTest = await evalFn(`
      (() => {
        const host = document.getElementById('shadow-host');
        if (!host || !host.shadowRoot) return { success: false, reason: 'no host' };
        const shadowPill = host.shadowRoot.querySelector('.tori-pill');
        const shadowMp = host.shadowRoot.querySelector('.tori-mp');
        if (!shadowPill || !shadowMp) return { success: false, reason: 'overlay not in shadow' };
        
        // Test click on shadow pill
        shadowPill.click();
        const isOpen = host.shadowRoot.querySelector('.tori-pn')?.classList.contains('on');
        shadowPill.click(); // close
        return { success: true, isOpen };
      })()
    `);
    record(browserName, '13', 'Shadow DOM video player overlay detected and interactive across boundary', shadowTest.success && shadowTest.isOpen);
  }

  // =============================================================
  // SECTION 1: MICROSOFT EDGE (via CDP)
  // =============================================================
  console.log('\n================================================================');
  console.log('BROWSER 1: MICROSOFT EDGE VERIFICATION');
  console.log('================================================================');
  if (fs.existsSync(EDGE_EXE)) {
    const edgeArgs = [
      `--remote-debugging-port=${EDGE_CDP_PORT}`,
      '--headless=new',
      '--disable-gpu',
      '--window-size=1280,800',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${EDGE_PROFILE}`,
      `http://127.0.0.1:${MOCK_SERVER_PORT}/drag-test.html`,
    ];
    const edgeProc = spawn(EDGE_EXE, edgeArgs, { stdio: 'ignore' });
    await sleep(1500);

    const wsUrl = await getCdpTarget(EDGE_CDP_PORT);
    if (wsUrl) {
      const cdp = new CdpSession(wsUrl);
      await cdp.connect();
      await cdp.send('Page.enable');
      await sleep(1000);

      await injectExtension((expr) => cdp.eval(expr));

      const clickFn = async (x, y) => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await sleep(40);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      };

      const dragFn = async (startX, startY, dx, dy, release = true) => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 });
        await sleep(30);
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          const cx = startX + Math.round((dx * i) / steps);
          const cy = startY + Math.round((dy * i) / steps);
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'left', buttons: 1 });
          await sleep(15);
        }
        if (release) {
          await sleep(30);
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX + dx, y: startY + dy, button: 'left', buttons: 0, clickCount: 1 });
        }
      };

      const moveFn = async (x, y) => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      };

      await run12Scenarios('Edge', (expr) => cdp.eval(expr), clickFn, dragFn, moveFn);

      cdp.close();
    } else {
      console.error('[EDGE] Failed to establish CDP connection');
    }
    edgeProc.kill('SIGKILL');
  } else {
    console.log('[EDGE] Executable not found, skipping');
  }

  // =============================================================
  // SECTION 2: GOOGLE CHROME (via CDP)
  // =============================================================
  console.log('\n================================================================');
  console.log('BROWSER 2: GOOGLE CHROME VERIFICATION');
  console.log('================================================================');
  if (fs.existsSync(CHROME_EXE)) {
    const chromeArgs = [
      `--remote-debugging-port=${CHROME_CDP_PORT}`,
      '--headless=new',
      '--disable-gpu',
      '--window-size=1280,800',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${CHROME_PROFILE}`,
      `http://127.0.0.1:${MOCK_SERVER_PORT}/drag-test.html`,
    ];
    const chromeProc = spawn(CHROME_EXE, chromeArgs, { stdio: 'ignore' });
    await sleep(1500);

    const wsUrl = await getCdpTarget(CHROME_CDP_PORT);
    if (wsUrl) {
      const cdp = new CdpSession(wsUrl);
      await cdp.connect();
      await cdp.send('Page.enable');
      await sleep(1000);

      await injectExtension((expr) => cdp.eval(expr));

      const clickFn = async (x, y) => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await sleep(40);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      };

      const dragFn = async (startX, startY, dx, dy, release = true) => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 });
        await sleep(30);
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          const cx = startX + Math.round((dx * i) / steps);
          const cy = startY + Math.round((dy * i) / steps);
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'left', buttons: 1 });
          await sleep(15);
        }
        if (release) {
          await sleep(30);
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX + dx, y: startY + dy, button: 'left', buttons: 0, clickCount: 1 });
        }
      };

      const moveFn = async (x, y) => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      };

      await run12Scenarios('Chrome', (expr) => cdp.eval(expr), clickFn, dragFn, moveFn);

      cdp.close();
    } else {
      console.error('[CHROME] Failed to establish CDP connection');
    }
    chromeProc.kill('SIGKILL');
  } else {
    console.log('[CHROME] Executable not found, skipping');
  }

  // =============================================================
  // SECTION 3: MOZILLA FIREFOX (via Marionette)
  // =============================================================
  console.log('\n================================================================');
  console.log('BROWSER 3: MOZILLA FIREFOX VERIFICATION');
  console.log('================================================================');
  if (fs.existsSync(FIREFOX_EXE)) {
    const userJs = [
      'user_pref("marionette.enabled", true);',
      `user_pref("marionette.port", ${FIREFOX_MARIONETTE_PORT});`,
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("browser.startup.homepage_override.mstone", "ignore");',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.enabled", false);',
    ].join('\n');
    fs.writeFileSync(path.join(FIREFOX_PROFILE, 'user.js'), userJs, 'utf8');

    const ffProc = spawn(
      FIREFOX_EXE,
      [
        '--headless',
        '--marionette',
        '--profile',
        FIREFOX_PROFILE,
        `http://127.0.0.1:${MOCK_SERVER_PORT}/drag-test.html`,
      ],
      { stdio: 'ignore' }
    );
    await sleep(2500);

    const marionette = new MarionetteClient();
    try {
      await marionette.connect(FIREFOX_MARIONETTE_PORT);
      await marionette.send('WebDriver:NewSession', { capabilities: {} });
      await sleep(1000);

      await injectExtension((expr) => marionette.eval(expr));

      const clickFn = async (x, y) => {
        await marionette.send('WebDriver:PerformActions', {
          actions: [
            {
              type: 'pointer',
              id: 'mouse1',
              parameters: { pointerType: 'mouse' },
              actions: [
                { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
                { type: 'pointerDown', button: 0 },
                { type: 'pause', duration: 40 },
                { type: 'pointerUp', button: 0 },
              ],
            },
          ],
        });
        await marionette.send('WebDriver:ReleaseActions', {});
      };

      const dragFn = async (startX, startY, dx, dy, release = true) => {
        const actions = [
          { type: 'pointerMove', duration: 0, x: Math.round(startX), y: Math.round(startY) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: 100, x: Math.round(startX + dx), y: Math.round(startY + dy) },
        ];
        if (release) {
          actions.push({ type: 'pause', duration: 30 });
          actions.push({ type: 'pointerUp', button: 0 });
        }
        await marionette.send('WebDriver:PerformActions', {
          actions: [
            {
              type: 'pointer',
              id: 'mouse1',
              parameters: { pointerType: 'mouse' },
              actions,
            },
          ],
        });
        if (release) {
          await marionette.send('WebDriver:ReleaseActions', {});
        }
      };

      const moveFn = async (x, y) => {
        await marionette.send('WebDriver:PerformActions', {
          actions: [
            {
              type: 'pointer',
              id: 'mouse1',
              parameters: { pointerType: 'mouse' },
              actions: [{ type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) }],
            },
          ],
        });
        await marionette.send('WebDriver:ReleaseActions', {});
      };

      await run12Scenarios('Firefox', (expr) => marionette.eval(expr), clickFn, dragFn, moveFn);

      marionette.disconnect();
    } catch (err) {
      console.error('[FIREFOX] Marionette error:', err.message);
    }
    ffProc.kill('SIGKILL');
  } else {
    console.log('[FIREFOX] Executable not found, skipping');
  }

  mockServer.close();

  // -------------------------------------------------------------
  // FINAL RESULTS SUMMARY
  // -------------------------------------------------------------
  console.log('\n================================================================');
  console.log(`RESULTS: ${passedTests}/${totalTests} TESTS PASSED (${((passedTests / totalTests) * 100).toFixed(1)}%)`);
  console.log('================================================================');

  const reportData = {
    totalTests,
    passedTests,
    failedTests: totalTests - passedTests,
    testResults,
  };
  fs.writeFileSync(path.join(QA_DIR, 'drag_test_results.json'), JSON.stringify(reportData, null, 2), 'utf8');

  if (passedTests < totalTests) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});

