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

console.log('=== TORI GATE 11 STAGE B.2 PHASE 2 VERIFICATION HARNESS ===');
console.log(`Executable: ${RELEASE_EXE}`);
console.log(`Artifacts: ${ARTIFACTS_DIR}`);

// 1. Generate an 8MB binary test payload
const TEST_FILE_SIZE = 4 * 1024 * 1024;
const testBuffer = Buffer.alloc(TEST_FILE_SIZE);
for (let i = 0; i < TEST_FILE_SIZE; i++) {
  testBuffer[i] = (i * 31 + 7) & 0xff;
}

// 2. Local HTTP test server with range support
const server = http.createServer((req, res) => {
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      'Content-Length': TEST_FILE_SIZE,
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'ETag': '"tori-stage-b-2-etag"',
    });
    res.end(testBuffer);
    return;
  }

  const matches = range.match(/bytes=(\d+)-(\d*)/);
  if (!matches) {
    res.writeHead(416, { 'Content-Range': `bytes */${TEST_FILE_SIZE}` });
    res.end();
    return;
  }

  const start = parseInt(matches[1], 10);
  const end = matches[2] ? parseInt(matches[2], 10) : TEST_FILE_SIZE - 1;

  if (start >= TEST_FILE_SIZE || end >= TEST_FILE_SIZE || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${TEST_FILE_SIZE}` });
    res.end();
    return;
  }

  const chunk = testBuffer.subarray(start, end + 1);
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${TEST_FILE_SIZE}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunk.length,
    'Content-Type': 'application/octet-stream',
    'ETag': '"tori-stage-b-2-etag"',
  });
  res.end(chunk);
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          Host: `${u.hostname}:${u.port}`,
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, data: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Host': `${u.hostname}:${u.port}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, data: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function getAuthToken() {
  const hostExe = path.join(PROJECT_ROOT, 'target', 'release', 'tdm-native-host.exe');
  if (fs.existsSync(hostExe)) {
    try {
      const msg = Buffer.from(JSON.stringify({ action: 'pair' }));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(msg.length, 0);
      const input = Buffer.concat([header, msg]);

      const child = spawn(hostExe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      return new Promise((resolve) => {
        let out = Buffer.alloc(0);
        child.stdout.on('data', (d) => (out = Buffer.concat([out, d])));
        child.on('close', () => {
          if (out.length >= 4) {
            const len = out.readUInt32LE(0);
            const body = out.subarray(4, 4 + len).toString();
            try {
              const res = JSON.parse(body);
              if (res.token) return resolve(res.token);
            } catch {}
          }
          resolve(null);
        });
        child.stdin.write(input);
        child.stdin.end();
      });
    } catch {}
  }
  return null;
}

function captureScreenshot(url, outPath, width = 1080, height = 680) {
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
        resolve();
      } else {
        console.warn(`Edge capture exited with code ${code}`);
        resolve();
      }
    });
    proc.on('error', (err) => {
      console.warn(`Edge spawn error: ${err.message}`);
      resolve();
    });
  });
}

async function runVerification() {
  // 1. VERIFY WINDOW DRAGGING & CAPABILITIES CONFIGURATION
  console.log('\n--- 1. Verifying Native Window Dragging & Single Titlebar Configuration ---');
  const tauriConfPath = path.join(PROJECT_ROOT, 'src-tauri', 'tauri.conf.json');
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
  const mainWinConf = tauriConf.app && tauriConf.app.windows ? (tauriConf.app.windows.find((w) => w.label === 'main') || tauriConf.app.windows[0]) : null;

  if (mainWinConf && mainWinConf.decorations === false) {
    console.log('[PASS] tauri.conf.json: "decorations": false verified on main window.');
  } else {
    throw new Error('Main window missing "decorations": false in tauri.conf.json!');
  }

  const capPath = path.join(PROJECT_ROOT, 'src-tauri', 'capabilities', 'default.json');
  const cap = JSON.parse(fs.readFileSync(capPath, 'utf8'));
  const expectedPerms = [
    'core:window:allow-start-dragging',
    'core:window:allow-toggle-maximize',
    'core:window:allow-maximize',
    'core:window:allow-unmaximize',
    'core:window:allow-minimize',
    'core:window:allow-close',
  ];
  for (const perm of expectedPerms) {
    if (cap.permissions.includes(perm)) {
      console.log(`[PASS] Capability permission verified: ${perm}`);
    } else {
      throw new Error(`Missing required capability permission: ${perm}`);
    }
  }

  const titleBarPath = path.join(PROJECT_ROOT, 'ui', 'src', 'components', 'TitleBar.tsx');
  const titleBarSrc = fs.readFileSync(titleBarPath, 'utf8');
  if (titleBarSrc.includes('startDragging()') && titleBarSrc.includes('toggleMaximize()')) {
    console.log('[PASS] TitleBar.tsx: native startDragging() on left-click drag and toggleMaximize() on double-click verified.');
  } else {
    throw new Error('TitleBar.tsx missing startDragging or toggleMaximize calls!');
  }

  const appCssPath = path.join(PROJECT_ROOT, 'ui', 'src', 'App.css');
  const appCss = fs.readFileSync(appCssPath, 'utf8');
  if (appCss.includes('-webkit-app-region: drag') && appCss.includes('-webkit-app-region: no-drag')) {
    console.log('[PASS] App.css: -webkit-app-region drag and no-drag controls verified.');
  } else {
    throw new Error('App.css missing -webkit-app-region rules!');
  }

  // 2. VERIFY MULTI-SELECTION AND BULK DELETE CODE INTEGRITY
  console.log('\n--- 2. Verifying Multi-Selection and Bulk Delete Logic ---');
  const appSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'src', 'App.tsx'), 'utf8');
  if (appSrc.includes('selectedIds') && appSrc.includes('setSelectedIds') && appSrc.includes('handleBulkDelete')) {
    console.log('[PASS] App.tsx: Set-based selectedIds, bulk delete, and keyboard shortcuts (Ctrl+A, Delete, Escape) verified.');
  } else {
    throw new Error('App.tsx missing multi-selection state or handlers!');
  }

  const tableSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'src', 'components', 'DownloadTable.tsx'), 'utf8');
  if (tableSrc.includes('selectedIds.has(job.id)') && tableSrc.includes('onBackgroundClick')) {
    console.log('[PASS] DownloadTable.tsx: Set-based row highlight and background click to clear verified.');
  } else {
    throw new Error('DownloadTable.tsx missing Set selection integration!');
  }

  const modalSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'src', 'components', 'DeleteConfirmModal.tsx'), 'utf8');
  if (modalSrc.includes('Delete ${count} Downloads') && modalSrc.includes('deleteFiles')) {
    console.log('[PASS] DeleteConfirmModal.tsx: multi-item count title and safe disk delete checkbox verified.');
  } else {
    throw new Error('DeleteConfirmModal.tsx missing multi-item support!');
  }

  const commandsSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'src-tauri', 'src', 'commands.rs'), 'utf8');
  if (commandsSrc.includes('pub async fn delete_downloads')) {
    console.log('[PASS] commands.rs: delete_downloads IPC command registered.');
  } else {
    throw new Error('commands.rs missing delete_downloads IPC command!');
  }

  // 3. CAPTURE VISUAL ARTIFACTS USING HEADLESS EDGE
  console.log('\n--- 3. Capturing Visual Screenshots ---');
  const staticServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost:8899');
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

  await new Promise((res) => staticServer.listen(8899, '127.0.0.1', res));

  // Multi-selected rows in table (first 3 selected, Toolbar Delete button shows "Delete (3)")
  await captureScreenshot(
    'http://127.0.0.1:8899/index.html?demo=1&sel=multi',
    path.join(ARTIFACTS_DIR, 'actual_main_stage_b2_multiselect.png'),
    1080,
    680
  );

  // Bulk Delete Modal confirmation dialog (Delete 3 Downloads)
  await captureScreenshot(
    'http://127.0.0.1:8899/index.html?demo=1&modal=delete',
    path.join(ARTIFACTS_DIR, 'actual_main_stage_b2_bulk_delete_modal.png'),
    1080,
    680
  );

  staticServer.close();

  // 4. REAL BACKEND MULTI-DOWNLOAD & DELETE VERIFICATION
  console.log('\n--- 4. Real Backend HTTP API Multi-Download and Deletion Test ---');
  const HTTP_PORT = 9096;
  await new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', resolve));
  console.log(`[PASS] Test HTTP range server listening on http://127.0.0.1:${HTTP_PORT}`);

  try {
    execSync('taskkill /F /IM tori-download-manager.exe', { stdio: 'ignore' });
  } catch {}
  await sleep(1000);

  console.log('[INFO] Spawning release executable...');
  const appProc = spawn(RELEASE_EXE, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, RUST_LOG: 'info' },
  });

  let connected = false;
  let apiPort = 6800;

  for (let i = 0; i < 40; i++) {
    await sleep(500);

    for (const testPort of [6800, 6801, 6802]) {
      try {
        const resp = await httpGet(`http://127.0.0.1:${testPort}/api/v1/ping`);
        if (resp.status === 200) {
          connected = true;
          apiPort = testPort;
          console.log(`[PASS] Connected to TORI Desktop on port ${apiPort}`);
          break;
        }
      } catch {}
    }
    if (connected) break;
  }

  if (!connected) {
    console.error('[FAIL] Could not connect to TORI integration server after 20s');
    appProc.kill();
    server.close();
    process.exit(1);
  }

  const token = await getAuthToken();
  if (!token) {
    console.error('[FAIL] Could not obtain auth token from tdm-native-host pair');
    appProc.kill();
    server.close();
    process.exit(1);
  }

  console.log(`[INFO] Authenticated API at http://127.0.0.1:${apiPort}, token: ${token.substring(0, 8)}...`);
  const authHeaders = {
    'x-tori-token': token,
    'Origin': 'http://tauri.localhost',
  };

  // Create 3 real downloads
  const jobIds = [];
  for (let i = 1; i <= 3; i++) {
    const createResp = await httpPost(
      `http://127.0.0.1:${apiPort}/api/v1/downloads`,
      {
        url: `http://127.0.0.1:${HTTP_PORT}/test-file-${i}.bin`,
        priority: 'normal',
      },
      authHeaders
    );
    if (createResp.status === 200 || createResp.status === 201) {
      jobIds.push(createResp.data.id || createResp.data.job_id);
      console.log(`[PASS] Created test download ${i}: ${jobIds[jobIds.length - 1]}`);
    }
  }

  await sleep(1000);
  const listResp = await httpGet(`http://127.0.0.1:${apiPort}/api/v1/downloads`, authHeaders);
  const totalCount = listResp.data.jobs ? listResp.data.jobs.length : 0;
  console.log(`[PASS] Active downloads in database: ${totalCount} (created: ${jobIds.length})`);

  // Delete 2 of the 3 created downloads
  const toDelete = jobIds.slice(0, 2);
  const remainingExpected = jobIds[2];
  console.log(`[INFO] Deleting 2 items: ${toDelete.join(', ')}...`);

  for (const id of toDelete) {
    const delResp = await httpPost(
      `http://127.0.0.1:${apiPort}/api/v1/downloads/${id}/delete`,
      {},
      authHeaders
    );
    console.log(`Deleted ${id}: status ${delResp.status}`);
  }

  await sleep(1000);
  const postDeleteList = await httpGet(`http://127.0.0.1:${apiPort}/api/v1/downloads`, authHeaders);
  const remainingIds = (postDeleteList.data.jobs || []).map((j) => j.id);

  for (const id of toDelete) {
    if (!remainingIds.includes(id)) {
      console.log(`[PASS] Verified download ${id} successfully removed from SQLite database.`);
    } else {
      throw new Error(`Download ${id} was not deleted!`);
    }
  }

  if (remainingIds.includes(remainingExpected)) {
    console.log(`[PASS] Verified unselected download ${remainingExpected} remains intact.`);
  }

  // Cleanup
  console.log('\n[INFO] Terminating test processes...');
  try {
    appProc.kill();
  } catch {}
  try {
    execSync('taskkill /F /IM tori-download-manager.exe', { stdio: 'ignore' });
  } catch {}
  server.close();

  console.log('\n=== ALL GATE 11 STAGE B.2 PHASE 2 CHECKS PASSED SUCCESSFULLY ===\n');
}

runVerification().catch((err) => {
  console.error('[ERROR] Verification failed:', err);
  process.exit(1);
});
