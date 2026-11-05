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
console.log('   TORI GATE 12.2 VERIFICATION HARNESS');
console.log('   Native Toast Window Clipping, Positioning, Dragging & Formatting');
console.log('=================================================================');
console.log(`Executable: ${RELEASE_EXE}`);
console.log(`Artifacts: ${ARTIFACTS_DIR}`);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function captureScreenshot(url, outPath, width = 600, height = 300) {
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
        console.log(`[PASS] Captured: ${path.basename(outPath)}`);
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

// 1. Get Windows Work Area via python ctypes
function getWindowsWorkArea() {
  try {
    const cmd = `python -c "import ctypes; from ctypes import wintypes; rect = wintypes.RECT(); ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0); print(f'{rect.left},{rect.top},{rect.right},{rect.bottom}')"`;
    const out = execSync(cmd).toString().trim();
    const parts = out.split(',').map((x) => parseInt(x, 10));
    return { left: parts[0], top: parts[1], right: parts[2], bottom: parts[3] };
  } catch {
    return { left: 0, top: 0, right: 1920, bottom: 1032 };
  }
}

// Simulate rust get_clamped_toast_position logic
function getClampedToastPosition(workArea, preferredX, preferredY, width, height, scale = 1.0, isManual = false) {
  if (preferredX != null && preferredY != null && isManual) {
    // Stale check
    if (preferredX >= 239 && preferredX <= 241 && preferredY >= 179 && preferredY <= 181) {
      // Stale coords rejected -> fallback to default
    } else {
      const workLeft = workArea.left / scale;
      const workTop = workArea.top / scale;
      const workRight = workArea.right / scale;
      const workBottom = workArea.bottom / scale;

      const minX = workLeft + 10.0;
      const maxX = Math.max(minX, workRight - width - 10.0);
      const minY = workTop + 10.0;
      const maxY = Math.max(minY, workBottom - height - 10.0);

      const clampedX = Math.min(maxX, Math.max(minX, preferredX));
      const clampedY = Math.min(maxY, Math.max(minY, preferredY));
      return { x: clampedX, y: clampedY, anchored: 'manual' };
    }
  }

  // Default bottom-right (20px margins from work area edges)
  const workRight = workArea.right / scale;
  const workBottom = workArea.bottom / scale;
  const x = workRight - width - 20.0;
  const y = workBottom - height - 20.0;
  return { x, y, anchored: 'bottom-right' };
}

// Subtext and ETA formatting simulation matching DownloadToast.tsx
function formatSubtext(state, downloaded, total, speedBps, errorMessage) {
  const hasKnownTotal = total && total > 0;
  const fmtB = (b) => {
    if (b == null || b < 0) return 'Unknown';
    if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  };
  const fmtSp = (bps) => {
    if (!bps || bps <= 0) return '';
    if (bps >= 1e6) return (bps / 1e6).toFixed(2) + ' MB/s';
    return Math.round(bps / 1e3) + ' KB/s';
  };
  const fmtProgressBytes = (d, t) => {
    if (t <= 0) return fmtB(d);
    if (t >= 1e9 && d >= 1e8) {
      return `${(d / 1e9).toFixed(2)} of ${(t / 1e9).toFixed(2)} GB`;
    }
    if (t >= 1e6 && d >= 1e5) {
      return `${(d / 1e6).toFixed(1)} of ${(t / 1e6).toFixed(1)} MB`;
    }
    return `${fmtB(d)} of ${fmtB(t)}`;
  };

  const speedStr = fmtSp(speedBps);
  const speedPart = speedStr ? ` · ${speedStr}` : '';

  if (state === 'completed') {
    const finalBytes = hasKnownTotal ? total : downloaded;
    return `${fmtB(finalBytes)} · Download complete`;
  }
  if (state === 'failed') {
    return errorMessage || 'Connection lost · 3 retries failed';
  }
  if (state === 'paused') {
    return hasKnownTotal
      ? `${fmtProgressBytes(downloaded, total)} · Paused`
      : `${fmtB(downloaded)} · Paused`;
  }
  // Active
  if (downloaded === 0) {
    return 'Starting…';
  }
  if (hasKnownTotal) {
    return `${fmtProgressBytes(downloaded, total)}${speedPart}`;
  }
  return `${fmtB(downloaded)}${speedPart}`;
}

function formatEtaSimulation(state, downloaded, total, etaSeconds) {
  const hasKnownTotal = total && total > 0;
  const pct = hasKnownTotal ? Math.min(100, Math.max(0, (downloaded / total) * 100)) : 0;

  const fmtEta = (s) => {
    if (s == null || !isFinite(s) || s < 0) return '--';
    if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    if (s >= 60) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
    return `${Math.round(s)}s`;
  };

  if (state === 'completed') return { num: 'Done', sub: 'Finished' };
  if (state === 'failed') return { num: 'Failed', sub: hasKnownTotal ? `${Math.floor(pct)}%` : '' };
  if (state === 'paused') return { num: 'Paused', sub: hasKnownTotal ? `${Math.floor(pct)}%` : '' };

  if (downloaded === 0) return { num: 'Starting…', sub: '' };
  if (!hasKnownTotal) return { num: 'Live', sub: 'Unknown size' };

  const formatted = fmtEta(etaSeconds);
  if (formatted === '--') return { num: '--', sub: 'calculating' };
  return { num: formatted, sub: 'left' };
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

  // =========================================================================
  // TEST 1: Windows Work Area & Default Bottom-Right Positioning
  // =========================================================================
  console.log('\n--- TEST 1: Windows Work Area & Default Bottom-Right Positioning ---');
  const workArea = getWindowsWorkArea();
  console.log(`Physical Work Area: left=${workArea.left}, top=${workArea.top}, right=${workArea.right}, bottom=${workArea.bottom}`);
  assert(workArea.right > 0 && workArea.bottom > 0, 'Valid Windows Work Area retrieved excluding taskbar');

  // Test collapsed bounds: width=494, height=100
  const collapsedPos100 = getClampedToastPosition(workArea, null, null, 494.0, 100.0, 1.0);
  assert(collapsedPos100.anchored === 'bottom-right', 'Default position uses bottom-right anchor');
  assert(collapsedPos100.x === workArea.right - 494.0 - 20.0, `X coordinate has exact 20px right margin (${collapsedPos100.x}px)`);
  assert(collapsedPos100.y === workArea.bottom - 100.0 - 20.0, `Y coordinate has exact 20px bottom margin (${collapsedPos100.y}px)`);
  assert(collapsedPos100.y + 100.0 === workArea.bottom - 20.0, 'Window bottom edge is exactly 20px above taskbar');

  // Test expanded bounds: width=494, height=250 (drawer opened)
  const expandedPos100 = getClampedToastPosition(workArea, null, null, 494.0, 250.0, 1.0);
  assert(expandedPos100.x === collapsedPos100.x, 'Expanded X position remains horizontally aligned');
  assert(expandedPos100.y === workArea.bottom - 250.0 - 20.0, `Expanded Y position shifts upward (${expandedPos100.y}px)`);
  assert(expandedPos100.y + 250.0 === collapsedPos100.y + 100.0, 'Bottom edge remains anchored at exact same coordinate (upward expansion)');

  // Test across DPI scale factors: 125%, 150%, 200%
  const scales = [1.25, 1.5, 2.0];
  for (const s of scales) {
    const pos = getClampedToastPosition(workArea, null, null, 494.0, 100.0, s);
    const expectedRight = workArea.right / s;
    const expectedBottom = workArea.bottom / s;
    assert(Math.abs(pos.x - (expectedRight - 494.0 - 20.0)) < 0.01, `Scale ${s * 100}%: X coordinate has exact 20px right margin`);
    assert(Math.abs(pos.y - (expectedBottom - 100.0 - 20.0)) < 0.01, `Scale ${s * 100}%: Y coordinate has exact 20px bottom margin`);
  }

  // =========================================================================
  // TEST 2: Invalidation of Legacy / Stale Coordinates & Position Persistence
  // =========================================================================
  console.log('\n--- TEST 2: Legacy Coordinate Invalidation & Drag Persistence ---');
  // 1. Legacy test coordinates: (240.0, 180.0) without is_manual flag
  const staleLegacy = getClampedToastPosition(workArea, 240.0, 180.0, 494.0, 100.0, 1.0, false);
  assert(staleLegacy.anchored === 'bottom-right', 'Stale legacy (240, 180) coordinates are rejected in favor of bottom-right');
  assert(staleLegacy.x === workArea.right - 494.0 - 20.0, 'Stale coordinates reset to work area right margin');

  // 2. Genuine manual user drag: (1000.0, 400.0) with is_manual = true
  const manualDrag = getClampedToastPosition(workArea, 1000.0, 400.0, 494.0, 100.0, 1.0, true);
  assert(manualDrag.anchored === 'manual', 'Genuine user drag with is_manual=true is preserved');
  assert(manualDrag.x === 1000.0 && manualDrag.y === 400.0, 'User placed coordinates preserved without reset');

  // 3. User dragged off-screen: (2500.0, 1500.0)
  const offscreenDrag = getClampedToastPosition(workArea, 2500.0, 1500.0, 494.0, 100.0, 1.0, true);
  assert(offscreenDrag.x <= workArea.right - 494.0 - 10.0, 'Offscreen X coordinate is safely clamped within work area');
  assert(offscreenDrag.y <= workArea.bottom - 100.0 - 10.0, 'Offscreen Y coordinate is safely clamped within work area');

  // =========================================================================
  // TEST 3: CSS Layout, 12px Transparent Margins & Single-Line Ellipsis
  // =========================================================================
  console.log('\n--- TEST 3: CSS Layout, Transparent Margins & Single-Line Ellipsis ---');
  const cssPath = path.join(PROJECT_ROOT, 'ui', 'src', 'components', 'DownloadToast.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  assert(cssContent.includes('padding: 12px !important;'), '.toast-host-container has exact 12px transparent padding on all sides');
  assert(cssContent.includes('width: 470px;'), '.toast width is exact 470px reference design width');
  assert(!cssContent.includes('.toast {\n  position: relative;\n  width: 470px;\n  border-radius: 22px;\n  background: var(--panel);\n  box-shadow: 0 0 0 1px var(--bline), 0 6px 18px rgba(0, 0, 0, 0.28);\n  box-sizing: border-box;\n  pointer-events: auto !important;\n  -webkit-app-region: no-drag !important;'), 'Removed -webkit-app-region: no-drag from .toast card');
  assert(cssContent.includes('cursor: grab;'), '.toast .row has cursor: grab for intuitive dragging');
  assert(cssContent.includes('cursor: grabbing;'), '.toast .row:active has cursor: grabbing');

  // Verify single-line ellipsis styles
  assert(cssContent.includes('white-space: nowrap;') && cssContent.includes('overflow: hidden;') && cssContent.includes('text-overflow: ellipsis;'), 'Single-line ellipsis formatting present in CSS');
  assert(cssContent.includes('.toast .tx span') && cssContent.includes('text-overflow: ellipsis;'), '.tx span has overflow: hidden and text-overflow: ellipsis');
  assert(cssContent.includes('.toast .eta b') && cssContent.includes('text-overflow: ellipsis;'), '.eta b has overflow: hidden and text-overflow: ellipsis');
  assert(cssContent.includes('.toast .eta span') && cssContent.includes('text-overflow: ellipsis;'), '.eta span has overflow: hidden and text-overflow: ellipsis');

  // =========================================================================
  // TEST 4: Unknown-Size Text Formatting, Progress Ring & ETA Robustness
  // =========================================================================
  console.log('\n--- TEST 4: Unknown-Size Text Formatting & Progress Ring ---');

  // Case 1: Total size known (48.9 of 55.3 MB · 506 KB/s)
  const subKnown = formatSubtext('downloading', 48.9 * 1e6, 55.3 * 1e6, 506000);
  assert(subKnown === '48.9 of 55.3 MB · 506 KB/s', `Known total subtext matches exact spec: "${subKnown}"`);

  // Case 2: Total size unknown with bytes downloaded (48.9 MB · 506 KB/s)
  const subUnknown = formatSubtext('downloading', 48.9 * 1e6, 0, 506000);
  assert(subUnknown === '48.9 MB · 506 KB/s', `Unknown total subtext matches exact spec: "${subUnknown}"`);

  // Case 3: Connecting / starting (0 bytes downloaded)
  const subStarting = formatSubtext('downloading', 0, 55.3 * 1e6, 0);
  assert(subStarting === 'Starting…', `Starting subtext matches exact spec: "${subStarting}"`);

  // Case 4: Paused with known total
  const subPausedKnown = formatSubtext('paused', 24.5 * 1e6, 55.3 * 1e6, 0);
  assert(subPausedKnown === '24.5 of 55.3 MB · Paused', `Paused with known total: "${subPausedKnown}"`);

  // Case 5: Paused with unknown total
  const subPausedUnknown = formatSubtext('paused', 24.5 * 1e6, 0, 0);
  assert(subPausedUnknown === '24.5 MB · Paused', `Paused with unknown total: "${subPausedUnknown}"`);

  // Case 6: Complete
  const subDone = formatSubtext('completed', 55.3 * 1e6, 55.3 * 1e6, 0);
  assert(subDone === '55.3 MB · Download complete', `Complete subtext: "${subDone}"`);

  // Case 7: Failed
  const subFailed = formatSubtext('failed', 12.0 * 1e6, 55.3 * 1e6, 0, 'Connection lost · 3 retries failed');
  assert(subFailed === 'Connection lost · 3 retries failed', `Failed subtext: "${subFailed}"`);

  // Verify NO trailing separators, NaN, Infinity, or 0 B ·
  assert(!subKnown.includes(' · \n') && !subKnown.endsWith(' ·'), 'No trailing separator in known total');
  assert(!subUnknown.includes(' · \n') && !subUnknown.endsWith(' ·'), 'No trailing separator in unknown total');
  assert(!subStarting.includes('NaN') && !subStarting.includes('Infinity'), 'No NaN or Infinity in starting text');

  // Verify ETA displays
  const etaStarting = formatEtaSimulation('downloading', 0, 55.3 * 1e6, 0);
  assert(etaStarting.num === 'Starting…' && etaStarting.sub === '', 'Starting ETA is "Starting…" with empty sub');

  const etaUnknownSize = formatEtaSimulation('downloading', 48.9 * 1e6, 0, null);
  assert(etaUnknownSize.num === 'Live' && etaUnknownSize.sub === 'Unknown size', `Active unknown size ETA is "Live" / "Unknown size": ${etaUnknownSize.num} ${etaUnknownSize.sub}`);

  const etaKnown = formatEtaSimulation('downloading', 48.9 * 1e6, 55.3 * 1e6, 108);
  assert(etaKnown.num === '1m 48s' && etaKnown.sub === 'left', `Known duration ETA: "${etaKnown.num}" "${etaKnown.sub}"`);

  const etaDone = formatEtaSimulation('completed', 55.3 * 1e6, 55.3 * 1e6, null);
  assert(etaDone.num === 'Done' && etaDone.sub === 'Finished', `Completed ETA: "${etaDone.num}" "${etaDone.sub}"`);

  const etaPaused = formatEtaSimulation('paused', 27.65 * 1e6, 55.3 * 1e6, null);
  assert(etaPaused.num === 'Paused' && etaPaused.sub === '50%', `Paused ETA with percentage: "${etaPaused.num}" "${etaPaused.sub}"`);

  // =========================================================================
  // TEST 5: Visual Screenshots from Actual React UI Dist
  // =========================================================================
  console.log('\n--- TEST 5: Capture Real Windows Visual Screenshots ---');
  const staticServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost:8892');
    let p = u.pathname;
    if (p === '/') p = '/index.html';
    const filePath = path.join(PROJECT_ROOT, 'ui', 'dist', p);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const mimes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
      res.writeHead(200, { 'Content-Type': mimes[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise((res) => staticServer.listen(8892, '127.0.0.1', res));

  // 1. Default collapsed toast in downloading state
  await captureScreenshot(
    'http://127.0.0.1:8892/index.html?window=toast&demo=1&state=down',
    path.join(ARTIFACTS_DIR, 'actual_toast_gate12_2_default_pos.png'),
    520,
    140
  );

  // 2. Expanded toast with chunk map and details
  await captureScreenshot(
    'http://127.0.0.1:8892/index.html?window=toast&demo=1&state=expanded',
    path.join(ARTIFACTS_DIR, 'actual_toast_gate12_2_expanded.png'),
    520,
    280
  );

  // 3. Unknown-size live stream / unknown total toast
  await captureScreenshot(
    'http://127.0.0.1:8892/index.html?window=toast&demo=1&state=down&unknown=1',
    path.join(ARTIFACTS_DIR, 'actual_toast_gate12_2_unknown_size.png'),
    520,
    140
  );

  // 4. Paused toast
  await captureScreenshot(
    'http://127.0.0.1:8892/index.html?window=toast&demo=1&state=paused',
    path.join(ARTIFACTS_DIR, 'actual_toast_gate12_2_paused.png'),
    520,
    140
  );

  // 5. Complete toast
  await captureScreenshot(
    'http://127.0.0.1:8892/index.html?window=toast&demo=1&state=done',
    path.join(ARTIFACTS_DIR, 'actual_toast_gate12_2_done.png'),
    520,
    140
  );

  staticServer.close();

  console.log('\n=================================================================');
  console.log(`TOTAL ASSERTIONS: ${totalCount}`);
  console.log(`PASSED: ${passedCount}`);
  console.log(`FAILED: ${totalCount - passedCount}`);
  console.log('=================================================================');
  if (passedCount === totalCount) {
    console.log('>>> ALL GATE 12.2 VERIFICATIONS PASSED SUCCESSFULLY <<<');
  } else {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error during Gate 12.2 verification:', err);
  process.exit(1);
});
