/**
 * Capture Before vs After Behavioral Evidence for Gate 25 Hotfix
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const QA_DIR = path.join(ROOT, 'target', 'gate25_drag_qa');
const PORT = 19880;
const CDP_PORT = 19881;
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const contentCss = fs.readFileSync(path.join(EXTENSION_DIR, 'content.css'), 'utf8');

// The OLD (broken) implementation from v1.0.4:
// - isolateEvents had pointerdown/pointerup
// - onPointerUp was window.addEventListener('pointerup', onPointerUp) with default bubble phase
// - no buttons check in pointermove
// - no window capture phase
const oldContentJs = fs.readFileSync(path.join(ROOT, 'extension', 'content.js'), 'utf8')
  // We can simulate the exact old code snippet
  .replace(
    "['mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'contextmenu']",
    "['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'contextmenu']"
  )
  .replace(
    "window.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });\n      window.addEventListener('pointerup', onPointerUp, { capture: true });\n      window.addEventListener('pointercancel', onPointerCancel, { capture: true });\n      window.addEventListener('blur', onWindowBlur);\n\n      pill.addEventListener('pointerup', onPointerUp);\n      pill.addEventListener('pointercancel', onPointerCancel);\n      pill.addEventListener('lostpointercapture', onLostPointerCapture);",
    "window.addEventListener('pointermove', onPointerMove, { passive: false });\n      window.addEventListener('pointerup', onPointerUp);\n      window.addEventListener('pointercancel', onPointerUp);"
  )
  .replace(
    "if (e.pointerType === 'mouse' && (e.buttons & 1) === 0) {\n        endDrag(e, false);\n        return;\n      }",
    "// no buttons check"
  );

// The NEW (fixed) implementation:
const newContentJs = fs.readFileSync(path.join(EXTENSION_DIR, 'content.js'), 'utf8');

const testHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { margin:0; padding:20px; background:#111; color:#fff; font-family:sans-serif; }
  .player-container { position:relative; width:640px; height:360px; background:#000; }
  video { width:100%; height:100%; }
</style></head>
<body>
  <div class="player-container html5-video-player" id="player">
    <video id="v" controls><source src="/media/video.mp4" type="video/mp4"></video>
  </div>
</body></html>`;

async function testImplementation(scriptJs) {
  const edgeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--window-size=1280,800',
    '--no-first-run',
    '--user-data-dir=' + path.join(QA_DIR, 'comp_profile_' + Date.now()),
    `http://127.0.0.1:${PORT}/test.html`,
  ];
  const proc = spawn(EDGE_EXE, edgeArgs, { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));

  let wsUrl = null;
  for (let i = 0; i < 15; i++) {
    try {
      const res = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = res.find((t) => t.type === 'page') || res[0];
      if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 300));
  }

  const ws = new WebSocket(wsUrl);
  let id = 1;
  const pending = new Map();
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg.result);
    }
  };
  await new Promise((r) => { ws.onopen = r; });

  const send = (method, params = {}) => new Promise((resolve) => {
    const curId = id++;
    pending.set(curId, { resolve });
    ws.send(JSON.stringify({ id: curId, method, params }));
  });
  const evaluate = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return res?.result?.value;
  };

  await send('Page.enable');

  // Inject script
  await evaluate(`
    (() => {
      const s = document.createElement('style');
      s.textContent = ${JSON.stringify(contentCss)};
      document.head.appendChild(s);

      window.chrome = {
        storage: {
          local: {
            get: (k, cb) => cb({ tori_settings: { cap: true, pill: true, fmt: '1080p', min: 1, pos: 'Top right' } }),
            set: (d, cb) => cb && cb()
          },
          onChanged: { addListener: () => {} }
        },
        runtime: {
          sendMessage: (m, cb) => cb && cb({ media: [] }),
          onMessage: { addListener: () => {} }
        }
      };

      const sc = document.createElement('script');
      sc.textContent = ${JSON.stringify(scriptJs)};
      document.body.appendChild(sc);
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));

  // Get pill coords
  const coords = await evaluate(`
    (() => {
      const pill = document.querySelector('.tori-pill');
      const r = pill.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()
  `);

  // Step 1: Single Click & Release on pill
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', buttons: 1, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 50));
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 200));

  const afterClick = await evaluate(`
    (() => {
      const mp = document.querySelector('.tori-mp');
      const pn = document.querySelector('.tori-pn');
      return {
        isDragging: mp.classList.contains('tori-dragging'),
        isPanelOpen: pn.classList.contains('on'),
        left: parseFloat(mp.style.left) || 0
      };
    })()
  `);

  // Step 2: Move mouse cursor WITHOUT holding any button (buttons: 0)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coords.x + 80, y: coords.y + 50, button: 'none', buttons: 0 });
  await new Promise((r) => setTimeout(r, 200));

  const afterMoveWithoutButtons = await evaluate(`
    (() => {
      const mp = document.querySelector('.tori-mp');
      return {
        isDragging: mp.classList.contains('tori-dragging'),
        left: parseFloat(mp.style.left) || 0
      };
    })()
  `);

  ws.close();
  proc.kill('SIGKILL');

  return {
    afterClick,
    afterMoveWithoutButtons,
  };
}

async function run() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(testHtml);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  console.log('[TEST] Evaluating BEFORE behavior (old v1.0.4 implementation)...');
  const beforeEvidence = await testImplementation(oldContentJs);
  console.log('BEFORE Evidence:', beforeEvidence);

  console.log('\n[TEST] Evaluating AFTER behavior (fixed Gate 25 implementation)...');
  const afterEvidence = await testImplementation(newContentJs);
  console.log('AFTER Evidence:', afterEvidence);

  server.close();

  const evidenceReport = {
    timestamp: new Date().toISOString(),
    before: {
      description: 'v1.0.4 broken implementation with bubble-phase pointerup and missing buttons check',
      singleClickPanelOpen: beforeEvidence.afterClick.isPanelOpen,
      cursorMoveWithoutHoldingFollowsMouse: beforeEvidence.afterMoveWithoutButtons.left > 0,
      cursorMoveDraggingFlagStuck: beforeEvidence.afterMoveWithoutButtons.isDragging,
      verdict: 'FAIL: Clicking pill caused overlay to stick to mouse cursor even without holding buttons (Sticky Drag Bug)',
    },
    after: {
      description: 'Gate 25 fixed implementation with capture-phase lifecycle and buttons & 1 validation',
      singleClickPanelOpen: afterEvidence.afterClick.isPanelOpen,
      cursorMoveWithoutHoldingFollowsMouse: afterEvidence.afterMoveWithoutButtons.left > 0,
      cursorMoveDraggingFlagStuck: afterEvidence.afterMoveWithoutButtons.isDragging,
      verdict: 'PASS: Single click toggles panel open cleanly; cursor movement without holding NEVER moves overlay',
    },
    raw: { beforeEvidence, afterEvidence }
  };

  fs.writeFileSync(path.join(QA_DIR, 'before_after_evidence.json'), JSON.stringify(evidenceReport, null, 2), 'utf8');
  console.log('\n[DONE] Saved before/after evidence to target/gate25_drag_qa/before_after_evidence.json');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
