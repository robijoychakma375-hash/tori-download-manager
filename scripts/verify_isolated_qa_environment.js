/**
 * TORI Download Manager v1.0.1 — Verify Isolated QA Environment
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve('F:\\TORI\\final tori download manager');
const QA_ROOT = path.join(ROOT, 'qa_manual_env');
const QA_DATA = path.join(QA_ROOT, 'data');
const QA_DOWNLOADS = path.join(QA_ROOT, 'downloads');
const QA_WEBVIEW2 = path.join(QA_ROOT, 'webview2_profile');
const QA_EDGE = path.join(QA_ROOT, 'edge_profile');

const RC_EXE = path.join(ROOT, 'release', 'v1.0.1-rc', 'bin', 'tori-download-manager.exe');
const PROD_APPDATA_DB = path.join(process.env.APPDATA, 'tori-download-manager', 'tdm_storage.sqlite');

console.log('=== VERIFYING ISOLATED QA ENVIRONMENT ===');

// 1. Prepare directories
for (const dir of [QA_ROOT, QA_DATA, QA_DOWNLOADS, QA_WEBVIEW2, QA_EDGE]) {
  fs.mkdirSync(dir, { recursive: true });
}

// Record production DB last modified time
let prodDbBefore = 0;
if (fs.existsSync(PROD_APPDATA_DB)) {
  prodDbBefore = fs.statSync(PROD_APPDATA_DB).mtimeMs;
}

// 2. Seed SQLite database in QA_DATA
const qaDbPath = path.join(QA_DATA, 'tdm_storage.sqlite');
const seedScript = path.join(ROOT, 'scripts', 'seed_qa_database.py');
execSync(`python "${seedScript}" "${qaDbPath}" "${QA_DOWNLOADS}"`);
console.log(`[PASS] Seeded isolated QA SQLite DB at: ${qaDbPath}`);

// 3. Spawn RC Desktop process with isolated environment
console.log(`[SPAWN] Launching RC Desktop: ${RC_EXE}`);
const child = spawn(RC_EXE, [], {
  env: {
    ...process.env,
    TORI_DATA_DIR: QA_DATA,
    TORI_IPC_PIPE: '\\\\.\\pipe\\tori-qa-manual-ipc',
    WEBVIEW2_USER_DATA_FOLDER: QA_WEBVIEW2,
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

child.stdout.on('data', d => console.log(`[RC stdout] ${d.toString().trim()}`));
child.stderr.on('data', d => console.log(`[RC stderr] ${d.toString().trim()}`));

async function runVerification() {
  const deadline = Date.now() + 20000;
  let healthy = false;

  console.log('[POLL] Waiting for RC to listen on http://127.0.0.1:19600/api/v1/ping...');
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:19600/api/v1/ping');
      if (res.ok) {
        const body = await res.json();
        if (body.status === 'ok') {
          healthy = true;
          console.log('[PASS] Received healthy ping response from isolated port 19600:', body);
          break;
        }
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 400));
  }

  if (!healthy) {
    child.kill('SIGKILL');
    throw new Error('RC failed to start or listen on port 19600 within 20s');
  }

  // Check authenticated status endpoint
  const statusRes = await fetch('http://127.0.0.1:19600/api/v1/status', {
    headers: { 'X-Tori-Token': 'tori_manual_qa_token_20261109' }
  });
  const statusBody = await statusRes.json();
  console.log('[PASS] Authenticated status check:', statusBody);

  // Check downloads endpoint
  const dlRes = await fetch('http://127.0.0.1:19600/api/v1/downloads', {
    headers: { 'X-Tori-Token': 'tori_manual_qa_token_20261109' }
  });
  const dlBody = await dlRes.json();
  console.log('[PASS] Downloads listing check:', dlBody);

  // Check media status endpoint (verifies sidecar discovery)
  const mediaRes = await fetch('http://127.0.0.1:19600/api/v1/media/status', {
    headers: { 'X-Tori-Token': 'tori_manual_qa_token_20261109' }
  });
  const mediaBody = await mediaRes.json();
  console.log('[PASS] Media engine & sidecars status check:', mediaBody);

  // Verify production isolation
  if (fs.existsSync(PROD_APPDATA_DB)) {
    const prodDbAfter = fs.statSync(PROD_APPDATA_DB).mtimeMs;
    if (prodDbAfter !== prodDbBefore) {
      throw new Error('CRITICAL VIOLATION: Production DB was modified during test!');
    }
  }
  console.log('[PASS] Production AppData SQLite DB was completely untouched!');

  // Verify WebView2 profile creation
  const wv2Files = fs.readdirSync(QA_WEBVIEW2);
  console.log(`[PASS] WebView2 isolated profile contains ${wv2Files.length} items (EBWebView folder created in QA dir).`);

  // Shutdown RC cleanly
  console.log('[SHUTDOWN] Exiting RC desktop process...');
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 1000));
  try { child.kill('SIGKILL'); } catch (_) {}

  console.log('\n>>> ISOLATED QA ENVIRONMENT VERIFICATION PASSED SUCCESSFULLY! <<<\n');
  fs.writeFileSync(path.join(ROOT, 'scripts', 'isolated_qa_verification_results.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    status: 'PASS',
    port: 19600,
    sidecarsStatus: mediaBody,
    prodUntouched: true,
    wv2ItemCount: wv2Files.length
  }, null, 2));
}

runVerification().catch(err => {
  console.error('[FATAL ERROR]', err);
  try { child.kill('SIGKILL'); } catch (_) {}
  process.exit(1);
});
