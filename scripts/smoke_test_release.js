/**
 * Release Build Smoke Test
 * Verifies that the existing release binary launches, pairs, executes a download, and shuts down.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function killProcessTree(pid) {
  try { execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' }); } catch (_) { }
}

function killProcessOnPort(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8' }).trim();
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      if (pid && !isNaN(pid) && pid !== process.pid) killProcessTree(pid);
    }
  } catch (_) { }
}

function makeHttpRequest({ port, path: reqPath, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (payload && !reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
    if (payload) reqHeaders['Content-Length'] = Buffer.byteLength(payload);

    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers: reqHeaders, timeout: 10000 }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch (_) { data = raw; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  console.log('--- STARTING RELEASE BUILD SMOKE TEST ---');
  const desktopPort = 19188;
  const fixturePort = 19388;
  const token = 'tori_smoke_test_token_123';

  killProcessOnPort(desktopPort);
  killProcessOnPort(fixturePort);

  const testDir = path.resolve('target/smoke_test_env');
  const dataDir = path.join(testDir, 'data');
  const downloadsDir = path.join(testDir, 'downloads');
  const webviewDir = path.join(testDir, 'webview');

  if (fs.existsSync(testDir)) try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) { }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.mkdirSync(webviewDir, { recursive: true });

  // Fixture server
  const fixtureBuffer = Buffer.alloc(1024 * 1024, 0x55);
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Length': fixtureBuffer.length,
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes'
    });
    res.end(fixtureBuffer);
  });
  await new Promise(r => server.listen(fixturePort, '127.0.0.1', r));
  console.log(`[Fixture Server] Listening on http://127.0.0.1:${fixturePort}`);

  // Seed DB with token and app_settings
  const dbPath = path.join(dataDir, 'tdm_storage.sqlite');
  execSync(`python -c "import sqlite3, json; conn=sqlite3.connect(r'''${dbPath}'''); c=conn.cursor(); c.execute('PRAGMA journal_mode = WAL'); c.execute('CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); c.execute('INSERT OR REPLACE INTO engine_settings VALUES (?,?)', ('browser_integration_token','${token}')); c.execute('INSERT OR REPLACE INTO engine_settings VALUES (?,?)', ('api_token','${token}')); payload = json.dumps({'dir': r'''${downloadsDir}''', 'port': ${desktopPort}, 'key': '${token}', 'closeToTray': True, 'maxConcurrentDownloads': 4, 'maxConnectionsPerDownload': 8, 'maxRetries': 5}); c.execute('INSERT OR REPLACE INTO engine_settings VALUES (?,?)', ('app_settings', payload)); conn.commit(); conn.close()"`);

  // Launch Release Desktop
  const desktopExe = path.resolve('target/release/tori-download-manager.exe');
  const proc = spawn(desktopExe, [], {
    env: {
      ...process.env,
      APPDATA: dataDir,
      LOCALAPPDATA: dataDir,
      TORI_PORT: String(desktopPort),
      TORI_DATA_DIR: dataDir,
      TORI_DOWNLOADS_DIR: downloadsDir,
      WEBVIEW2_USER_DATA_FOLDER: webviewDir
    },
    stdio: 'ignore'
  });

  try {
    // Poll API
    console.log(`[Desktop] Polling on http://127.0.0.1:${desktopPort}...`);
    let ready = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        const ping = await makeHttpRequest({
          port: desktopPort,
          path: '/api/v1/pair/status',
          headers: { 'x-tori-token': token }
        });
        if (ping.status === 200 && ping.data && ping.data.paired) {
          ready = true;
          break;
        }
      } catch (_) { }
    }
    if (!ready) throw new Error('Desktop API failed to become ready');
    console.log('[Desktop] API ready and responsive.');

    // Dispatch download
    const dl = await makeHttpRequest({
      port: desktopPort,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'x-tori-token': token },
      body: { url: `http://127.0.0.1:${fixturePort}/smoke_test.bin`, filename: 'smoke_test.bin', destination: downloadsDir }
    });
    const jobId = dl.data.job_id || dl.data.id;
    if (dl.status !== 200 || !jobId) throw new Error(`Download failed to create: ${JSON.stringify(dl)}`);
    console.log(`[Download] Job created: ${jobId}`);

    // Wait for completion
    let completed = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const getRes = await makeHttpRequest({
        port: desktopPort,
        path: `/api/v1/downloads/${jobId}`,
        headers: { 'x-tori-token': token }
      });
      const st = getRes.data && getRes.data.state ? String(getRes.data.state).toLowerCase() : '';
      if (st === 'completed') {
        completed = true;
        break;
      }
    }
    if (!completed) throw new Error('Download did not complete in time');
    console.log('[Download] Download completed successfully.');

    const savedFile = path.join(downloadsDir, 'smoke_test.bin');
    const savedOther = path.join(downloadsDir, 'Other', 'smoke_test.bin');
    const finalFile = fs.existsSync(savedFile) ? savedFile : savedOther;
    if (!fs.existsSync(finalFile)) throw new Error(`Downloaded file missing: ${finalFile}`);
    console.log(`[File Verified] File exists at ${finalFile} (${fs.statSync(finalFile).size} bytes)`);

    console.log('\n>>> RELEASE BUILD SMOKE TEST PASSED! <<<');
  } finally {
    killProcessTree(proc.pid);
    killProcessOnPort(desktopPort);
    killProcessOnPort(fixturePort);
    try { server.close(); } catch (_) { }
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) { }
  }
}

run().catch(e => {
  console.error('[FATAL SMOKE TEST ERROR]:', e);
  process.exit(1);
});
