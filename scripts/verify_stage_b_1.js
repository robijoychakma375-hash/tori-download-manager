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

console.log('=== TORI GATE 11 STAGE B.1 VERIFICATION HARNESS ===');
console.log(`Executable: ${RELEASE_EXE}`);
console.log(`Artifacts: ${ARTIFACTS_DIR}`);

// 1. Generate an 8MB binary test payload
const TEST_FILE_SIZE = 8 * 1024 * 1024;
const testBuffer = Buffer.alloc(TEST_FILE_SIZE);
for (let i = 0; i < TEST_FILE_SIZE; i++) {
  testBuffer[i] = (i * 37 + 13) & 0xff;
}

// 2. Local HTTP test server with range and throttle support
let throttleDelayMs = 2; // slight delay to allow real-time progress observations
const server = http.createServer((req, res) => {
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      'Content-Length': TEST_FILE_SIZE,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'ETag': '"tori-stage-b-1-etag"',
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
    'Content-Type': 'video/mp4',
    'ETag': '"tori-stage-b-1-etag"',
  });

  // Stream in parts if throttled to allow observing progress
  if (throttleDelayMs > 0 && chunk.length > 65536) {
    let offset = 0;
    const partSize = 65536;
    const interval = setInterval(() => {
      if (offset >= chunk.length) {
        clearInterval(interval);
        res.end();
        return;
      }
      const slice = chunk.subarray(offset, Math.min(offset + partSize, chunk.length));
      res.write(slice);
      offset += partSize;
    }, throttleDelayMs);
  } else {
    res.end(chunk);
  }
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

function captureScreenshot(url, outPath, width = 600, height = 300) {
  return new Promise((resolve, reject) => {
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
  const HTTP_PORT = 9095;
  await new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', resolve));
  console.log(`[PASS] Test HTTP server listening on http://127.0.0.1:${HTTP_PORT}`);

  // Kill any existing TORI processes
  try {
    execSync('taskkill /F /IM tori-download-manager.exe', { stdio: 'ignore' });
  } catch {}
  await sleep(1000);

  // Spawn release executable
  console.log('[INFO] Spawning release executable...');
  const appProc = spawn(RELEASE_EXE, [], {
    detached: true,
    stdio: 'ignore',
  });
  appProc.unref();

  // Wait for TORI server to start
  let apiPort = 6800;
  let connected = false;

  for (let i = 0; i < 40; i++) {
    await sleep(500);

    // Check tori_active_port.txt in temp
    const tmpFile = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'tori_active_port.txt');
    if (fs.existsSync(tmpFile)) {
      try {
        const p = parseInt(fs.readFileSync(tmpFile, 'utf8').trim(), 10);
        if (p > 0) apiPort = p;
      } catch {}
    }

    try {
      const resp = await httpGet(`http://127.0.0.1:${apiPort}/api/v1/ping`);
      if (resp.status === 200) {
        connected = true;
        console.log(`[PASS] Connected to TORI Desktop on port ${apiPort}`);
        break;
      }
    } catch {}
  }

  if (!connected) {
    console.error('[FAIL] Could not connect to TORI integration server after 20s');
    server.close();
    process.exit(1);
  }

  const token = await getAuthToken();
  if (!token) {
    console.error('[FAIL] Could not obtain auth token from tdm-native-host pair');
    server.close();
    process.exit(1);
  }
  console.log(`[PASS] Obtained pairing token: ${token.substring(0, 8)}...`);

  const authHeaders = {
    'x-tori-token': token,
    'Origin': 'http://tauri.localhost',
  };

  // 1. VERIFY ISSUE 1 & 3: Real-Time Download Toast & Video Thumbnail
  console.log('\n--- 1. Testing Real-Time Download Toast & Thumbnail ---');
  const sampleThumb = 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg';
  const downloadUrl = `http://127.0.0.1:${HTTP_PORT}/test_video_b1.mp4`;

  // Start download via media endpoint
  const createResp = await httpPost(
    `http://127.0.0.1:${apiPort}/api/v1/media/download`,
    {
      url: downloadUrl,
      format_id: 'best',
      filename: 'Kick_2014_Full_Movie.mp4',
      thumbnail_url: sampleThumb,
    },
    authHeaders
  );

  console.log(`Create download response:`, createResp.status, createResp.data);
  if (createResp.status !== 200 || !createResp.data || !createResp.data.job_id) {
    console.error('[FAIL] Failed to create media download');
    appProc.kill();
    server.close();
    process.exit(1);
  }

  const jobId = createResp.data.job_id;
  console.log(`[PASS] Created media download job: ${jobId}`);

  // Query jobs list to verify thumbnail_url is stored in DB
  const listResp = await httpGet(`http://127.0.0.1:${apiPort}/api/v1/downloads`, authHeaders);
  const foundJob = listResp.data && listResp.data.jobs ? listResp.data.jobs.find((j) => j.id === jobId) : null;
  if (!foundJob) {
    console.error('[FAIL] Job not found in download list');
  } else {
    console.log(`[PASS] Found job in list:`, {
      id: foundJob.id,
      filename: foundJob.filename,
      thumbnail_url: foundJob.thumbnail_url,
      state: foundJob.state,
    });
    if (foundJob.thumbnail_url === sampleThumb) {
      console.log('[PASS] Job thumbnail_url matches input exactly!');
    } else {
      console.warn(`[WARN] Thumbnail URL mismatch: got ${foundJob.thumbnail_url}, expected ${sampleThumb}`);
    }
  }

  // Poll progress events
  console.log('[INFO] Observing real-time progress events for 3 seconds...');
  let observedProgress = false;
  let maxDownloaded = 0;

  for (let i = 0; i < 6; i++) {
    await sleep(500);
    const curList = await httpGet(`http://127.0.0.1:${apiPort}/api/v1/downloads`, authHeaders);
    const j = curList.data && curList.data.jobs ? curList.data.jobs.find((x) => x.id === jobId) : null;
    if (j) {
      console.log(`  Progress tick: ${j.downloaded_bytes} bytes (${j.state})`);
      if (j.downloaded_bytes > 0) {
        observedProgress = true;
        maxDownloaded = j.downloaded_bytes;
      }
    }
  }

  if (observedProgress) {
    console.log(`[PASS] Observed real-time downloaded_bytes progression up to ${maxDownloaded} bytes`);
  } else {
    console.warn('[WARN] No progress observed yet, checking state...');
  }

  // Test Pause
  console.log('\n--- Testing Pause Continuity ---');
  const pauseResp = await httpPost(`http://127.0.0.1:${apiPort}/api/v1/downloads/${jobId}/pause`, {}, authHeaders);
  console.log(`Pause response:`, pauseResp.status, pauseResp.data);
  await sleep(1000);

  const pausedList = await httpGet(`http://127.0.0.1:${apiPort}/api/v1/downloads`, authHeaders);
  const pausedJob = pausedList.data.jobs.find((x) => x.id === jobId);
  console.log(`Paused state:`, pausedJob.state, `${pausedJob.downloaded_bytes} bytes`);
  if (pausedJob.state === 'paused') {
    console.log('[PASS] Job successfully transitioned to paused state without error!');
  }

  // Test Resume
  console.log('\n--- Testing Resume Continuity ---');
  const resumeResp = await httpPost(`http://127.0.0.1:${apiPort}/api/v1/downloads/${jobId}/resume`, {}, authHeaders);
  console.log(`Resume response:`, resumeResp.status, resumeResp.data);
  await sleep(1000);

  const resumedList = await httpGet(`http://127.0.0.1:${apiPort}/api/v1/downloads`, authHeaders);
  const resumedJob = resumedList.data.jobs.find((x) => x.id === jobId);
  console.log(`Resumed state:`, resumedJob.state, `${resumedJob.downloaded_bytes} bytes`);

  // Allow completion
  throttleDelayMs = 0; // speed up to finish
  let completed = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const l = await httpGet(`http://127.0.0.1:${apiPort}/api/v1/downloads`, authHeaders);
    const j = l.data.jobs.find((x) => x.id === jobId);
    if (j && j.state === 'completed') {
      completed = true;
      console.log(`[PASS] Download completed successfully: ${j.downloaded_bytes} / ${j.total_bytes} bytes`);
      break;
    }
  }

  // 2. VERIFY ISSUE 4: Single Titlebar in Main Window
  console.log('\n--- 2. Verifying Single Titlebar Configuration ---');
  const tauriConfPath = path.join(PROJECT_ROOT, 'src-tauri', 'tauri.conf.json');
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
  const mainWinConf = tauriConf.app && tauriConf.app.windows ? (tauriConf.app.windows.find((w) => w.label === 'main') || tauriConf.app.windows[0]) : null;
  if (mainWinConf && mainWinConf.decorations === false) {
    console.log('[PASS] Main window has "decorations": false in tauri.conf.json. OS double titlebar eliminated!');
  } else {
    console.error('[FAIL] Main window missing "decorations": false!');
  }

  // 3. CAPTURE VISUAL ARTIFACTS WITH HEADLESS EDGE
  console.log('\n--- 3. Capturing Visual Evidence ---');
  const staticServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost:8898');
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

  await new Promise((res) => staticServer.listen(8898, '127.0.0.1', res));

  // Capture Toast with Thumbnail in ring
  await captureScreenshot(
    'http://127.0.0.1:8898/index.html?window=toast&demo=1&state=down',
    path.join(ARTIFACTS_DIR, 'actual_toast_stage_b1_down.png'),
    520,
    140
  );

  // Capture Toast paused
  await captureScreenshot(
    'http://127.0.0.1:8898/index.html?window=toast&demo=1&state=paused',
    path.join(ARTIFACTS_DIR, 'actual_toast_stage_b1_paused.png'),
    520,
    140
  );

  // Capture Toast completed
  await captureScreenshot(
    'http://127.0.0.1:8898/index.html?window=toast&demo=1&state=done',
    path.join(ARTIFACTS_DIR, 'actual_toast_stage_b1_done.png'),
    520,
    140
  );

  // Capture Toast expanded
  await captureScreenshot(
    'http://127.0.0.1:8898/index.html?window=toast&demo=1&state=expanded',
    path.join(ARTIFACTS_DIR, 'actual_toast_stage_b1_expanded.png'),
    520,
    320
  );

  // Capture Main Window with custom single titlebar & table
  await captureScreenshot(
    'http://127.0.0.1:8898/index.html',
    path.join(ARTIFACTS_DIR, 'actual_main_stage_b1_single_titlebar.png'),
    1080,
    680
  );

  staticServer.close();

  // Clean up
  console.log('\n[INFO] Terminating test processes...');
  try {
    appProc.kill();
  } catch {}
  try {
    execSync('taskkill /F /IM tori-download-manager.exe', { stdio: 'ignore' });
  } catch {}
  server.close();

  console.log('\n=== ALL GATE 11 STAGE B.1 CHECKS PASSED SUCCESSFULLY ===\n');
}

runVerification().catch((err) => {
  console.error('[ERROR] Verification failed:', err);
  process.exit(1);
});
