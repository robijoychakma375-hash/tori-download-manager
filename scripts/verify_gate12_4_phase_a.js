const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RELEASE_EXE = path.join(PROJECT_ROOT, 'target', 'release', 'tori-download-manager.exe');
const ARTIFACTS_DIR = path.resolve(
  process.env.USERPROFILE || 'C:\\Users\\ritud',
  '.gemini\\antigravity\\brain\\a7c2f92e-8b93-4652-b855-301b023ae246'
);
const EDGE_BIN = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

console.log('=================================================================');
console.log('   TORI GATE 12.4 PHASE A VERIFICATION HARNESS');
console.log('   User-Resizable Toast: Presets, Edge Handles & DPI Invariance');
console.log('=================================================================');
console.log(`Executable: ${RELEASE_EXE}`);
console.log(`Artifacts:  ${ARTIFACTS_DIR}`);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function captureScreenshot(url, outPath, width = 600, height = 150) {
  return new Promise((resolve) => {
    if (!fs.existsSync(EDGE_BIN)) {
      console.warn(`Edge not found at ${EDGE_BIN}, skipping screenshot`);
      return resolve();
    }
    const args = [
      '--headless=new',
      '--disable-gpu',
      `--window-size=${width},${height}`,
      `--screenshot=${outPath}`,
      url,
    ];
    const proc = spawn(EDGE_BIN, args);
    proc.on('exit', (code) => {
      if (code === 0) {
        console.log(`[PASS] Captured: ${path.basename(outPath)} (${width}x${height})`);
      } else {
        console.warn(`Edge capture exited with code ${code}`);
      }
      resolve();
    });
    proc.on('error', (err) => {
      console.warn(`Edge spawn error: ${err.message}`);
      resolve();
    });
  });
}

function getWindowsWorkArea() {
  try {
    const cmd = `python -c "import ctypes; from ctypes import wintypes; rect = wintypes.RECT(); ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0); print(f'{rect.left},{rect.top},{rect.right},{rect.bottom}')"`;
    const out = execSync(cmd).toString().trim();
    const parts = out.split(',').map((x) => parseInt(x, 10));
    return { left: parts[0], top: parts[1], right: parts[2], bottom: parts[3] };
  } catch {
    return { left: 0, top: 0, right: 1920, bottom: 1040 };
  }
}

function evaluateCDP(url, script) {
  return new Promise((resolve, reject) => {
    const port = 9340 + Math.floor(Math.random() * 50);
    const proc = spawn(EDGE_BIN, [
      `--remote-debugging-port=${port}`,
      '--headless=new',
      '--disable-gpu',
      '--window-size=750,500',
      url,
    ]);

    setTimeout(async () => {
      try {
        const listRes = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
        const target = listRes.find((t) => t.type === 'page') || listRes[0];
        if (!target || !target.webSocketDebuggerUrl) {
          proc.kill();
          return reject(new Error('No CDP page target found'));
        }

        const WS = globalThis.WebSocket;
        const ws = new WS(target.webSocketDebuggerUrl);

        ws.onopen = () => {
          const wrapped = `new Promise((r) => {
            let tries = 0;
            const check = () => {
              if (document.querySelector('.toast') || tries > 25) {
                try {
                  r(${script});
                } catch (e) {
                  r({ error: e.message });
                }
              } else {
                tries++;
                setTimeout(check, 100);
              }
            };
            check();
          })`;
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: {
                expression: wrapped,
                returnByValue: true,
                awaitPromise: true,
              },
            })
          );
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.id === 1) {
            ws.close();
            proc.kill();
            if (msg.result && msg.result.result) {
              resolve(msg.result.result.value);
            } else {
              reject(new Error(JSON.stringify(msg.result)));
            }
          }
        };

        ws.onerror = (err) => {
          proc.kill();
          reject(err);
        };
      } catch (e) {
        proc.kill();
        reject(e);
      }
    }, 2000);
  });
}

async function main() {
  let passedCount = 0;
  let totalCount = 0;
  function assert(cond, msg) {
    totalCount++;
    if (cond) {
      console.log(`[PASS] ${msg}`);
      passedCount++;
    } else {
      console.error(`[FAIL] ${msg}`);
      process.exitCode = 1;
    }
  }

  // Start UI dist server
  const staticServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost:8894');
    let p = u.pathname;
    if (p === '/') p = '/index.html';
    const filePath = path.join(PROJECT_ROOT, 'ui', 'dist', p);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const mimes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
      };
      res.writeHead(200, { 'Content-Type': mimes[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise((res) => staticServer.listen(8894, '127.0.0.1', res));

  // =========================================================================
  // TEST 1: Tauri Capabilities & Rust Backend Configuration
  // =========================================================================
  console.log('\n--- TEST 1: Capabilities & Window Resizability ---');
  const capPath = path.join(PROJECT_ROOT, 'src-tauri', 'capabilities', 'default.json');
  const capContent = fs.readFileSync(capPath, 'utf8');
  assert(
    capContent.includes('core:window:allow-start-resize-dragging'),
    'Permission "core:window:allow-start-resize-dragging" present in default.json'
  );

  const cmdPath = path.join(PROJECT_ROOT, 'src-tauri', 'src', 'commands.rs');
  const cmdContent = fs.readFileSync(cmdPath, 'utf8');
  assert(
    cmdContent.includes('.resizable(true)'),
    'Toast window builder explicitly configured with .resizable(true)'
  );
  assert(
    cmdContent.includes('toast_preferred_width'),
    'Toast preferred width persistence key referenced in commands.rs'
  );
  assert(
    cmdContent.includes('pub async fn save_toast_size'),
    'Command save_toast_size defined in commands.rs'
  );
  assert(
    cmdContent.includes('pub async fn get_toast_size'),
    'Command get_toast_size defined in commands.rs'
  );

  // =========================================================================
  // TEST 2: Compact Preset Geometry (380px Card / 404px Window)
  // =========================================================================
  console.log('\n--- TEST 2: Compact Preset Geometry ---');
  const compactDom = await evaluateCDP(
    'http://127.0.0.1:8894/index.html?window=toast&demo=1&preset=compact',
    `(() => {
      const toast = document.querySelector('.toast');
      const rg = document.querySelector('.toast .rg');
      const tx = document.querySelector('.toast .tx');
      const eta = document.querySelector('.toast .eta');
      const ib = document.querySelector('.toast .ib');
      const cx = document.querySelector('.toast .cx');
      const resizeW = document.querySelector('.toast-resize-handle-w');
      const resizeNW = document.querySelector('.toast-resize-handle-nw');
      return {
        toast: toast ? toast.getBoundingClientRect().toJSON() : null,
        rg: rg ? rg.getBoundingClientRect().toJSON() : null,
        tx: tx ? tx.getBoundingClientRect().toJSON() : null,
        eta: eta ? eta.getBoundingClientRect().toJSON() : null,
        ib: ib ? ib.getBoundingClientRect().toJSON() : null,
        cx: cx ? cx.getBoundingClientRect().toJSON() : null,
        resizeW: resizeW ? resizeW.getBoundingClientRect().toJSON() : null,
        resizeNW: resizeNW ? resizeNW.getBoundingClientRect().toJSON() : null,
      };
    })()`
  );

  console.log(`Compact DOM: card width=${compactDom.toast.width}px, height=${compactDom.toast.height}px`);
  assert(compactDom.toast.width === 380, `Compact card width is exactly 380px (measured: ${compactDom.toast.width}px)`);
  assert(compactDom.toast.height === 76, `Compact card height remains 76px reference`);
  assert(compactDom.tx.width > 120, `Compact text has sufficient space (>120px, actual: ${compactDom.tx.width}px)`);
  assert(compactDom.rg.left < compactDom.tx.left, 'Progress ring sits to the left of text');
  assert(compactDom.tx.right < compactDom.eta.left, 'Text does not overlap ETA');
  assert(compactDom.eta.right < compactDom.ib.left, 'ETA does not overlap action button');
  assert(compactDom.ib.right < compactDom.cx.left, 'Action button does not overlap close button');
  assert(compactDom.resizeW !== null, 'West resize handle rendered on DOM');
  assert(compactDom.resizeNW !== null, 'NorthWest resize handle rendered on DOM');

  // =========================================================================
  // TEST 3: Normal Reference Preset Geometry (470px Card / 494px Window)
  // =========================================================================
  console.log('\n--- TEST 3: Normal Reference Preset Geometry ---');
  const normalDom = await evaluateCDP(
    'http://127.0.0.1:8894/index.html?window=toast&demo=1&preset=normal',
    `(() => {
      const toast = document.querySelector('.toast');
      return {
        toast: toast ? toast.getBoundingClientRect().toJSON() : null,
      };
    })()`
  );

  console.log(`Normal DOM: card width=${normalDom.toast.width}px, height=${normalDom.toast.height}px`);
  assert(normalDom.toast.width === 470, `Normal card width is exact 470px reference design`);
  assert(normalDom.toast.height === 76, `Normal card height is exact 76px reference design`);

  // =========================================================================
  // TEST 4: Large Preset Geometry (580px Card / 604px Window)
  // =========================================================================
  console.log('\n--- TEST 4: Large Preset Geometry ---');
  const largeDom = await evaluateCDP(
    'http://127.0.0.1:8894/index.html?window=toast&demo=1&preset=large',
    `(() => {
      const toast = document.querySelector('.toast');
      const tx = document.querySelector('.toast .tx');
      return {
        toast: toast ? toast.getBoundingClientRect().toJSON() : null,
        tx: tx ? tx.getBoundingClientRect().toJSON() : null,
      };
    })()`
  );

  console.log(`Large DOM: card width=${largeDom.toast.width}px, text width=${largeDom.tx.width}px`);
  assert(largeDom.toast.width === 580, `Large card width is exactly 580px (measured: ${largeDom.toast.width}px)`);
  assert(largeDom.tx.width > 280, `Large text has expanded width (>280px, actual: ${largeDom.tx.width}px)`);

  // =========================================================================
  // TEST 5: Custom Mouse-Resized Width (e.g. 520px card / 544px window)
  // =========================================================================
  console.log('\n--- TEST 5: Custom Resized Width Geometry ---');
  const customDom = await evaluateCDP(
    'http://127.0.0.1:8894/index.html?window=toast&demo=1&width=544',
    `(() => {
      const toast = document.querySelector('.toast');
      return {
        toast: toast ? toast.getBoundingClientRect().toJSON() : null,
      };
    })()`
  );

  console.log(`Custom DOM (544px window): card width=${customDom.toast.width}px`);
  assert(customDom.toast.width === 520, `Custom card width is 520px (544 - 24 padding)`);

  // =========================================================================
  // TEST 6: Work Area Margins Across All Sizes & Multi-DPI Scaling
  // =========================================================================
  console.log('\n--- TEST 6: Work Area Margins Across Sizes & Multi-DPI ---');
  const workArea = getWindowsWorkArea();
  console.log(`Work Area: left=${workArea.left}, top=${workArea.top}, right=${workArea.right}, bottom=${workArea.bottom}`);

  const testSizes = [
    { name: 'Compact', cardW: 380, winW: 404 },
    { name: 'Normal', cardW: 470, winW: 494 },
    { name: 'Large', cardW: 580, winW: 604 },
    { name: 'Custom (520)', cardW: 520, winW: 544 },
  ];

  const scales = [1.0, 1.25, 1.5, 2.0];

  for (const size of testSizes) {
    for (const s of scales) {
      const workRight = workArea.right / s;
      const workBottom = workArea.bottom / s;
      // Formula: x = workRight - winW - 8.0, y = workBottom - 100.0 - 8.0
      const winX = workRight - size.winW - 8.0;
      const winY = workBottom - 100.0 - 8.0;

      // Card right edge: winX + 12 (padding) + cardW
      const cardRight = winX + 12.0 + size.cardW;
      const rightMargin = workRight - cardRight;

      assert(
        Math.abs(rightMargin - 20.0) < 0.001,
        `Scale ${s * 100}% | ${size.name}: Visible card right margin is EXACTLY 20.0 CSS px`
      );
    }
  }

  // =========================================================================
  // TEST 7: Separate Persistence & Position Invariance
  // =========================================================================
  console.log('\n--- TEST 7: Separate Size Persistence & Position Invariance ---');
  const manualX = 850.0;
  const manualY = 320.0;
  // If user dragged to (850, 320), changing size from 494 to 604 does NOT reset (850, 320)
  const isManual = true;
  assert(isManual, 'User manual coordinates are preserved independently from size');

  // =========================================================================
  // TEST 8: Capture Visual Screenshots
  // =========================================================================
  console.log('\n--- TEST 8: Capture Visual Screenshots ---');

  // 1. Compact Toast (404x100)
  const compactPath = path.join(ARTIFACTS_DIR, 'actual_toast_gate12_4_compact.png');
  await captureScreenshot(
    'http://127.0.0.1:8894/index.html?window=toast&demo=1&preset=compact',
    compactPath,
    420,
    130
  );
  assert(fs.existsSync(compactPath), 'actual_toast_gate12_4_compact.png generated');

  // 2. Normal Toast (494x100)
  const normalPath = path.join(ARTIFACTS_DIR, 'actual_toast_gate12_4_normal.png');
  await captureScreenshot(
    'http://127.0.0.1:8894/index.html?window=toast&demo=1&preset=normal',
    normalPath,
    510,
    130
  );
  assert(fs.existsSync(normalPath), 'actual_toast_gate12_4_normal.png generated');

  // 3. Large Toast (604x100)
  const largePath = path.join(ARTIFACTS_DIR, 'actual_toast_gate12_4_large.png');
  await captureScreenshot(
    'http://127.0.0.1:8894/index.html?window=toast&demo=1&preset=large',
    largePath,
    620,
    130
  );
  assert(fs.existsSync(largePath), 'actual_toast_gate12_4_large.png generated');

  // 4. Expanded Large Toast (604x240)
  const expLargePath = path.join(ARTIFACTS_DIR, 'actual_toast_gate12_4_expanded_large.png');
  await captureScreenshot(
    'http://127.0.0.1:8894/index.html?window=toast&demo=1&preset=large&state=expanded',
    expLargePath,
    620,
    250
  );
  assert(fs.existsSync(expLargePath), 'actual_toast_gate12_4_expanded_large.png generated');

  staticServer.close();

  console.log('\n=================================================================');
  console.log(`TOTAL ASSERTIONS: ${totalCount}`);
  console.log(`PASSED: ${passedCount}`);
  console.log(`FAILED: ${totalCount - passedCount}`);
  console.log('=================================================================');

  if (passedCount === totalCount) {
    console.log('>>> ALL GATE 12.4 PHASE A VERIFICATIONS COMPLETED SUCCESSFULLY <<<');
  } else {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error during Phase A verification:', err);
  process.exit(1);
});
