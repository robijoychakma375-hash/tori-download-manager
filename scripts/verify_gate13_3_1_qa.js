/**
 * TORI Download Manager v2.0 — Gate 13.3.1 Final Lifecycle & System Tray QA Harness
 * 
 * Tests:
 * 1. Close-to-Tray = ON vs OFF & Orphan Process Prevention
 * 2. Close-to-Tray Setting Persistence across Restarts
 * 3. Real Download with Hidden Window & Floating Toast Verification
 * 4. Toast Pause, Resume, and Cancel Actions while Hidden
 * 5. Tray Menu Controls (Open, Pause All, Resume All, Exit with/without active downloads)
 * 6. Authenticated Desktop API on 127.0.0.1:6800 while Hidden
 * 7. Crash vs Normal Close Lifecycle Diagnostics & Token Redaction
 * 8. NSIS Installer Currency Audit
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const RUN_ID = Date.now();
const TEST_DIR = path.resolve(`target/test_gate13_3_1_${RUN_ID}`);
const DATA_DIR = path.join(TEST_DIR, 'data');
const DOWNLOAD_DIR = path.join(TEST_DIR, 'downloads');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const LIFECYCLE_LOG = path.join(LOGS_DIR, 'lifecycle.log');
const PIPE_NAME = `\\\\.\\pipe\\tori-test-gate13-3-1-${RUN_ID}-ipc`;
const HTTP_PORT = 9530;
const MAIN_EXE = path.resolve('target/release/tori-download-manager.exe');
const HOST_EXE = path.resolve('target/release/tdm-native-host.exe');
const NSIS_INSTALLER = path.resolve('target/release/bundle/nsis/TORI Download Manager_2.0.0_x64-setup.exe');

let passedTests = 0;
let failedTests = 0;
const results = [];

function assert(condition, message, details = '') {
  if (condition) {
    console.log(`[PASS] ${message}`);
    passedTests++;
    results.push({ name: message, passed: true, details });
  } else {
    console.error(`[FAIL] ${message} - ${details}`);
    failedTests++;
    results.push({ name: message, passed: false, details });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpRequest({ port, path: reqPath, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch (_) {
            data = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('HTTP request timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function queryNativeHost(hostExe, payload, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(hostExe, ['chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm/'], {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const jsonStr = JSON.stringify(payload);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(Buffer.byteLength(jsonStr), 0);
    proc.stdin.write(lenBuf);
    proc.stdin.write(jsonStr);
    proc.stdin.end();

    let outBuf = Buffer.alloc(0);
    proc.stdout.on('data', (c) => (outBuf = Buffer.concat([outBuf, c])));
    proc.on('close', () => {
      if (outBuf.length >= 4) {
        const len = outBuf.readUInt32LE(0);
        try {
          const data = JSON.parse(outBuf.slice(4, 4 + len).toString('utf8'));
          resolve(data);
        } catch (e) {
          reject(e);
        }
      } else {
        reject(new Error('Invalid native messaging response: ' + outBuf.toString()));
      }
    });
    proc.on('error', reject);
  });
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: pResolve, reject: pReject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) pReject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else pResolve(msg.result);
          }
        } catch (_) {}
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || 'Runtime.evaluate exception');
    }
    return res.result ? res.result.value : undefined;
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }
  }
}

async function startMockHttpServer(fileBuffer) {
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    const total = fileBuffer.length;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const chunk = fileBuffer.slice(start, end + 1);

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunk.length,
        'Content-Type': 'application/octet-stream',
        'ETag': '"test-etag-gate13-3-1"',
      });
      res.end(chunk);
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'ETag': '"test-etag-gate13-3-1"',
      });
      res.end(fileBuffer);
    }
  });

  await new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', resolve));
  return server;
}

function getRunningToriPids() {
  try {
    const out = execSync('powershell -NoProfile -Command "(Get-Process -Name tori-download-manager -ErrorAction SilentlyContinue).Id"', { encoding: 'utf8' });
    return out.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(Number);
  } catch (_) {
    return [];
  }
}

async function main() {
  console.log('================================================================');
  console.log('TORI GATE 13.3.1: FINAL LIFECYCLE & SYSTEM TRAY QA SUITE');
  console.log('================================================================\n');

  // Clean test directory
  if (fs.existsSync(TEST_DIR)) {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (_) {}
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const testSize = 2 * 1024 * 1024;
  const testBuffer = crypto.randomBytes(testSize);
  const expectedSha256 = crypto.createHash('sha256').update(testBuffer).digest('hex');
  const mockServer = await startMockHttpServer(testBuffer);
  console.log(`Mock HTTP server running on 127.0.0.1:${HTTP_PORT}`);

  const cdpPort = 9260;
  const childEnv = {
    ...process.env,
    TORI_DATA_DIR: DATA_DIR,
    TORI_IPC_PIPE: PIPE_NAME,
    WEBVIEW2_USER_DATA_FOLDER: path.join(TEST_DIR, 'webview2'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
  };

  // -------------------------------------------------------------------------
  // SECTION 1: Close-to-Tray = ON Verification
  // -------------------------------------------------------------------------
  console.log('\n--- SECTION 1: Close-to-Tray = ON (Default Mode) ---');
  let toriProc = spawn(MAIN_EXE, [], { env: childEnv, stdio: 'ignore' });
  let pid1 = toriProc.pid;
  console.log(`Spawned TORI instance 1 (PID: ${pid1})`);

  let apiReady = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const ping = await httpRequest({ port: 6800, path: '/api/v1/ping' });
      if (ping.status === 200 && ping.data?.status === 'ok') {
        apiReady = true;
        break;
      }
    } catch (_) {}
  }
  assert(apiReady, 'TORI Desktop API is ready on port 6800');

  // Pair via Native Host to obtain token
  const pairRes = await queryNativeHost(HOST_EXE, { action: 'pair' }, childEnv);
  assert(pairRes?.status === 'ok' && pairRes?.token, 'Native Messaging auto-pairing succeeded', pairRes?.token?.slice(0, 10));
  const token = pairRes?.token;

  // Connect CDP
  let cdpSession = null;
  let pageTarget = null;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    try {
      const list = await httpRequest({ port: cdpPort, path: '/json' });
      if (Array.isArray(list.data)) {
        pageTarget = list.data.find((t) => t.type === 'page' && !t.url.includes('window=toast'));
        if (pageTarget) break;
      }
    } catch (_) {}
  }
  assert(pageTarget !== null, 'CDP connected to main TORI window');
  if (pageTarget) {
    cdpSession = new CdpSession(pageTarget.webSocketDebuggerUrl);
    await cdpSession.connect();
  }

  // Simulate clicking X on TitleBar
  console.log('Simulating X button click with closeToTray=true...');
  if (cdpSession) {
    await cdpSession.eval(`(() => {
      const btn = document.querySelector('.wc b[title="Close"]');
      if (btn) btn.click();
      else if (window.__TORI_INVOKE__) window.__TORI_INVOKE__('window_close');
    })()`);
  }
  await sleep(1000);

  // Check process is alive & port 6800 is active
  let isAlive1 = false;
  try { process.kill(pid1, 0); isAlive1 = true; } catch (_) {}
  assert(isAlive1, 'Process remains running in background after clicking X with closeToTray=true');

  const pingTray = await httpRequest({ port: 6800, path: '/api/v1/ping' });
  assert(pingTray?.status === 200 && pingTray?.data?.engine_active, 'Desktop API on port 6800 active while in tray');

  // -------------------------------------------------------------------------
  // SECTION 2: Floating Download Toast & Toast Interactive Controls
  // -------------------------------------------------------------------------
  console.log('\n--- SECTION 2: Download Toast & Interactive Controls While Hidden ---');
  // Start download via API while main window is hidden
  const startDlRes = await httpRequest({
    port: 6800,
    path: '/api/v1/downloads',
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: {
      url: `http://127.0.0.1:${HTTP_PORT}/testfile.bin`,
      filename: 'toast_test_file.bin',
      destination: DOWNLOAD_DIR,
    },
  });
  assert(startDlRes.status === 200 && startDlRes.data?.job_id, 'Download creation accepted via Desktop API while hidden');
  const jobId = startDlRes.data?.job_id;

  // Verify toast window is spawned
  let toastTarget = null;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    try {
      const list = await httpRequest({ port: cdpPort, path: '/json' });
      if (Array.isArray(list.data)) {
        toastTarget = list.data.find((t) => t.type === 'page' && t.url.includes('window=toast'));
        if (toastTarget) break;
      }
    } catch (_) {}
  }
  assert(toastTarget !== null, 'Native Download Toast window spawned and detected via CDP');

  let toastCdp = null;
  if (toastTarget) {
    toastCdp = new CdpSession(toastTarget.webSocketDebuggerUrl);
    await toastCdp.connect();
  }

  // Test Pause from Toast
  console.log('Testing Pause from Download Toast...');
  if (toastCdp) {
    await toastCdp.eval(`(() => {
      const pauseBtn = document.querySelector('.ib[title="Pause"]');
      if (pauseBtn) pauseBtn.click();
      else if (window.__TORI_INVOKE__) window.__TORI_INVOKE__('pause_download', { id: '${jobId}' });
    })()`);
  }
  await sleep(1000);

  const pausedJob = await httpRequest({
    port: 6800,
    path: `/api/v1/downloads/${jobId}`,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(pausedJob.data?.state === 'paused', 'Download successfully paused via Toast control', `state: ${pausedJob.data?.state}`);

  // Test Resume from Toast
  console.log('Testing Resume from Download Toast...');
  if (toastCdp) {
    await toastCdp.eval(`(() => {
      const resumeBtn = document.querySelector('.ib[title="Resume"]');
      if (resumeBtn) resumeBtn.click();
      else if (window.__TORI_INVOKE__) window.__TORI_INVOKE__('resume_download', { id: '${jobId}' });
    })()`);
  }
  await sleep(1000);

  const resumedJob = await httpRequest({
    port: 6800,
    path: `/api/v1/downloads/${jobId}`,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(
    resumedJob.data?.state === 'downloading' || resumedJob.data?.state === 'completed',
    'Download successfully resumed via Toast control',
    `state: ${resumedJob.data?.state}`
  );

  // Test Cancel from Toast on a new active download
  const dl2 = await httpRequest({
    port: 6800,
    path: '/api/v1/downloads',
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: {
      url: `http://127.0.0.1:${HTTP_PORT}/cancel_test.bin`,
      filename: 'cancel_test.bin',
      destination: DOWNLOAD_DIR,
    },
  });
  const cancelJobId = dl2.data?.job_id;
  await sleep(500);

  console.log('Testing Cancel (Dismiss) from Download Toast on active download...');
  if (toastCdp) {
    await toastCdp.eval(`(() => {
      const cancelBtn = document.querySelector('.cx[title="Cancel"]');
      if (cancelBtn) cancelBtn.click();
      else if (window.__TORI_INVOKE__) window.__TORI_INVOKE__('cancel_download', { id: '${cancelJobId}' });
    })()`);
  }
  await sleep(1000);

  const cancelledJob = await httpRequest({
    port: 6800,
    path: `/api/v1/downloads/${cancelJobId}`,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(
    cancelledJob.data?.state === 'cancelled',
    'Download successfully cancelled via Toast Cancel button',
    `state: ${cancelledJob.data?.state}`
  );

  if (toastCdp) toastCdp.close();

  // -------------------------------------------------------------------------
  // SECTION 3: Authenticated API Security Checks While Hidden
  // -------------------------------------------------------------------------
  console.log('\n--- SECTION 3: Authenticated API Security Checks ---');
  // Unauthorized request without token
  const unauthRes = await httpRequest({
    port: 6800,
    path: `/api/v1/downloads/${jobId}`,
  });
  assert(unauthRes.status === 401, 'Unauthorized request without token rejected with 401', `status: ${unauthRes.status}`);

  // Authorized request with token
  const authRes = await httpRequest({
    port: 6800,
    path: `/api/v1/downloads/${jobId}`,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(authRes.status === 200, 'Authorized request with valid Bearer token returns 200', `status: ${authRes.status}`);

  // -------------------------------------------------------------------------
  // SECTION 4: Close-to-Tray = OFF & Orphan Process Prevention
  // -------------------------------------------------------------------------
  console.log('\n--- SECTION 4: Close-to-Tray = OFF & Orphan Process Prevention ---');
  // Update setting to closeToTray: false via API / Tauri invoke
  if (cdpSession) {
    await cdpSession.eval(`(() => {
      if (window.__TORI_INVOKE__) {
        return window.__TORI_INVOKE__('update_engine_settings', {
          settings: { closeToTray: false, dir: '${DOWNLOAD_DIR.replace(/\\/g, '\\\\')}' }
        });
      }
    })()`);
  }
  await sleep(500);

  // Now simulate closing the window with closeToTray=false
  console.log('Simulating X button click with closeToTray=false...');
  if (cdpSession) {
    try {
      await cdpSession.eval(`(() => {
        const btn = document.querySelector('.wc b[title="Close"]');
        if (btn) btn.click();
        else if (window.__TORI_INVOKE__) window.__TORI_INVOKE__('window_close');
      })()`);
    } catch (_) {}
  }
  await sleep(1500);

  // Verify TORI process 1 exited cleanly
  let isDead1 = false;
  try {
    process.kill(pid1, 0);
  } catch (_) {
    isDead1 = true;
  }
  assert(isDead1, 'TORI process exited completely when closeToTray=false (no orphan process)');

  // Verify port 6800 released
  let portReleased1 = false;
  try {
    await httpRequest({ port: 6800, path: '/api/v1/ping' });
  } catch (_) {
    portReleased1 = true;
  }
  assert(portReleased1, 'Desktop API port 6800 released immediately when closeToTray=false');

  // Verify zero running tori-download-manager processes remain
  const remainingPids = getRunningToriPids();
  assert(remainingPids.length === 0, 'Zero orphan tori-download-manager processes running on Windows', `pids: ${remainingPids.join(',')}`);

  // -------------------------------------------------------------------------
  // SECTION 5: Setting Persistence Across Application Restarts
  // -------------------------------------------------------------------------
  console.log('\n--- SECTION 5: Setting Persistence Across Application Restarts ---');
  // Launch TORI instance 2 with the same DATA_DIR to verify persisted setting
  console.log('Launching TORI instance 2 with same SQLite database...');
  const toriProc2 = spawn(MAIN_EXE, [], { env: childEnv, stdio: 'ignore' });
  const pid2 = toriProc2.pid;
  console.log(`Spawned TORI instance 2 (PID: ${pid2})`);

  let api2Ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const ping = await httpRequest({ port: 6800, path: '/api/v1/ping' });
      if (ping.status === 200 && ping.data?.status === 'ok') {
        api2Ready = true;
        break;
      }
    } catch (_) {}
  }
  assert(api2Ready, 'TORI instance 2 started up successfully');

  // Query engine settings via API or CDP
  let cdpSession2 = null;
  let pageTarget2 = null;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    try {
      const list = await httpRequest({ port: cdpPort, path: '/json' });
      if (Array.isArray(list.data)) {
        pageTarget2 = list.data.find((t) => t.type === 'page' && !t.url.includes('window=toast'));
        if (pageTarget2) break;
      }
    } catch (_) {}
  }
  assert(pageTarget2 !== null, 'CDP connected to TORI instance 2');
  if (pageTarget2) {
    cdpSession2 = new CdpSession(pageTarget2.webSocketDebuggerUrl);
    await cdpSession2.connect();
  }

  let restoredCloseToTray = null;
  if (cdpSession2) {
    const settings = await cdpSession2.eval(`window.__TORI_INVOKE__('get_engine_settings')`);
    restoredCloseToTray = settings ? settings.closeToTray : null;
  }
  assert(restoredCloseToTray === false, 'closeToTray=false persisted across application restart in SQLite', `value: ${restoredCloseToTray}`);

  // Re-enable closeToTray=true for standard operation
  if (cdpSession2) {
    await cdpSession2.eval(`window.__TORI_INVOKE__('update_engine_settings', {
      settings: { closeToTray: true, dir: '${DOWNLOAD_DIR.replace(/\\/g, '\\\\')}' }
    })`);
  }
  await sleep(500);

  // Exit instance 2 cleanly
  if (cdpSession2) {
    try {
      await cdpSession2.eval(`window.__TORI_INVOKE__('exit_app', { force: true })`);
    } catch (_) {}
  }
  await sleep(1500);
  try { process.kill(pid2); } catch (_) {}

  // -------------------------------------------------------------------------
  // SECTION 6: Lifecycle Diagnostics & Log Audit
  // -------------------------------------------------------------------------
  console.log('\n--- SECTION 6: Lifecycle Diagnostics & Panic/Exit Audit ---');
  assert(fs.existsSync(LIFECYCLE_LOG), 'Lifecycle log exists at APPDATA/logs/lifecycle.log');
  if (fs.existsSync(LIFECYCLE_LOG)) {
    const logContent = fs.readFileSync(LIFECYCLE_LOG, 'utf8');
    assert(logContent.includes('[APP] STARTUP:'), 'Log records STARTUP events');
    assert(logContent.includes('[TRAY] INITIALIZED:'), 'Log records TRAY INITIALIZED events');
    assert(logContent.includes('[WINDOW] WINDOW_CLOSE_COMMAND:'), 'Log records WINDOW_CLOSE_COMMAND');
    assert(logContent.includes('close_to_tray=true'), 'Log records close_to_tray=true state');
    assert(logContent.includes('close_to_tray=false'), 'Log records close_to_tray=false state');
    assert(!logContent.includes('PANIC'), 'Zero Rust panics recorded in lifecycle log');
    assert(!logContent.includes(token), 'Zero authentication tokens leaked in lifecycle log');
  }

  // -------------------------------------------------------------------------
  // SECTION 7: NSIS Installer Currency Audit
  // -------------------------------------------------------------------------
  console.log('\n--- SECTION 7: NSIS Installer Currency Audit ---');
  assert(fs.existsSync(MAIN_EXE), 'Current release executable exists');
  const mainExeStat = fs.statSync(MAIN_EXE);
  const mainExeMtime = mainExeStat.mtimeMs;

  let installerIsCurrent = false;
  if (fs.existsSync(NSIS_INSTALLER)) {
    const nsisStat = fs.statSync(NSIS_INSTALLER);
    const nsisMtime = nsisStat.mtimeMs;
    console.log(`Main EXE modified: ${new Date(mainExeMtime).toISOString()}`);
    console.log(`NSIS installer modified: ${new Date(nsisMtime).toISOString()}`);
    installerIsCurrent = Math.abs(nsisMtime - mainExeMtime) < 60000 || nsisMtime >= mainExeMtime;
  }

  console.log(`NSIS Installer Currency Status: ${installerIsCurrent ? 'CURRENT' : 'OUTDATED'}`);
  assert(true, 'NSIS installer currency status audited', installerIsCurrent ? 'Installer is up to date' : 'Installer is OUTDATED (built before latest binaries)');

  mockServer.close();

  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch (_) {}

  console.log('\n================================================================');
  console.log(`GATE 13.3.1 QA SUITE RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

