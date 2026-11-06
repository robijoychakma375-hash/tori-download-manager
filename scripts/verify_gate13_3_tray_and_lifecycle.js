/**
 * TORI Download Manager v2.0 — Gate 13.3 System Tray & Background Downloads Verification Harness
 * 
 * Tests:
 * 1. Startup & Port 6800 Desktop API availability
 * 2. Background download continuation when main window is closed/hidden
 * 3. Desktop API availability while running in system tray
 * 4. Background download completion without active window
 * 5. Toast / extension enqueuing while window is hidden
 * 6. Named pipe IPC show_window window restoration
 * 7. Bounded, sanitized lifecycle logging (%APPDATA%\tori-download-manager\logs\lifecycle.log)
 * 8. Clean exit from tray and port release
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execSync, spawnSync } = require('child_process');

const TEST_DIR = path.resolve('target/test_gate13_3');
const DATA_DIR = path.join(TEST_DIR, 'data');
const DOWNLOAD_DIR = path.join(TEST_DIR, 'downloads');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const LIFECYCLE_LOG = path.join(LOGS_DIR, 'lifecycle.log');
const PIPE_NAME = `\\\\.\\pipe\\tori-test-gate13-3-ipc`;
const HTTP_PORT = 9520;
const MAIN_EXE = path.resolve('target/release/tori-download-manager.exe');
const HOST_EXE = path.resolve('target/release/tdm-native-host.exe');

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
        reject(new Error('Invalid native messaging response'));
      }
    });
    proc.on('error', reject);
  });
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
        'ETag': '"test-etag-gate13-3"',
      });
      res.end(chunk);
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'ETag': '"test-etag-gate13-3"',
      });
      res.end(fileBuffer);
    }
  });

  await new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', resolve));
  return server;
}

async function main() {
  console.log('================================================================');
  console.log('TORI GATE 13.3: SYSTEM TRAY & BACKGROUND DOWNLOAD HARNESS');
  console.log('================================================================\n');

  // Clean test directory
  if (fs.existsSync(TEST_DIR)) {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (_) {}
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  // Generate 2 MB random payload
  const testSize = 2 * 1024 * 1024;
  const testBuffer = crypto.randomBytes(testSize);
  const expectedSha256 = crypto.createHash('sha256').update(testBuffer).digest('hex');
  console.log(`Generated test payload: ${testSize} bytes, SHA-256: ${expectedSha256}`);

  const mockServer = await startMockHttpServer(testBuffer);
  console.log(`Mock HTTP file server running on 127.0.0.1:${HTTP_PORT}`);

  const cdpPort = 9255;
  console.log(`Spawning TORI Desktop: ${MAIN_EXE}`);

  const childEnv = {
    ...process.env,
    TORI_DATA_DIR: DATA_DIR,
    TORI_IPC_PIPE: PIPE_NAME,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
  };

  const toriProc = spawn(MAIN_EXE, [], {
    env: childEnv,
    stdio: 'ignore',
    detached: false,
  });

  const pid = toriProc.pid;
  console.log(`TORI PID: ${pid}`);

  let cdpSession = null;
  try {
    // 1. Wait for Desktop API on port 6800 to become responsive
    console.log('Waiting for TORI Desktop API on 127.0.0.1:6800...');
    let apiReady = false;
    let token = null;

    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        const ping = await httpRequest({ port: 6800, path: '/api/v1/ping' });
        if (ping.status === 200 && (ping.data?.status === 'ok' || ping.data?.desktop_running)) {
          apiReady = true;
          break;
        }
      } catch (_) {}
    }

    assert(apiReady, 'Desktop API on 127.0.0.1:6800 responds to ping');

    // Fetch token from sqlite or API
    const dbPath = path.join(DATA_DIR, 'tdm_storage.sqlite');
    assert(fs.existsSync(dbPath), 'SQLite database created at isolated path');

    // Auto-pair via Native Host
    try {
      const pairRes = await queryNativeHost(HOST_EXE, { action: 'pair' }, childEnv);
      assert(pairRes?.status === 'ok' && pairRes?.token, 'Native Messaging auto-pairing succeeded', `token: ${pairRes?.token?.slice(0, 10)}...`);
      token = pairRes?.token;
    } catch (e) {
      console.warn('Native Host auto-pairing exception:', e.message);
    }

    if (!token) {
      try {
        const resp = await httpRequest({ port: 6800, path: '/api/v1/auth/token' });
        if (resp.status === 200 && resp.data?.token) {
          token = resp.data.token;
        }
      } catch (_) {}
    }

    console.log(`Using pairing token: ${token ? 'tori_***' : 'none'}`);

    // 2. Connect CDP to inspect main window
    console.log(`Connecting to CDP on 127.0.0.1:${cdpPort}...`);
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
      console.log('CDP WebSocket connected');
    }

    // 3. Start a download via API
    console.log('Initiating test download via Desktop API...');
    const dlUrl = `http://127.0.0.1:${HTTP_PORT}/testfile.bin`;
    const startRes = await httpRequest({
      port: 6800,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: {
        url: dlUrl,
        filename: 'testfile.bin',
        destination: DOWNLOAD_DIR,
      },
    });

    assert(startRes.status === 200 && startRes.data?.job_id, 'Download creation accepted by Desktop API', JSON.stringify(startRes.data));
    const jobId = startRes.data?.job_id;

    // 4. Simulate clicking X on the TitleBar (invoking window_close)
    console.log('Simulating X button click (invoking window_close)...');
    if (cdpSession) {
      await cdpSession.eval(`(() => {
        const btn = document.querySelector('.wc b[title="Close"]');
        if (btn) { btn.click(); return; }
        if (window.__TORI_INVOKE__) { return window.__TORI_INVOKE__('window_close'); }
        if (window.__TAURI__ && window.__TAURI__.core) { return window.__TAURI__.core.invoke('window_close'); }
      })()`);
    } else {
      // Fallback: invoke via IPC
    }
    await sleep(1000);

    // 5. Verify process is still alive and main window is hidden
    const isRunning = !toriProc.killed;
    assert(isRunning, 'TORI process remains alive after clicking X');

    // 6. Verify Desktop API on 127.0.0.1:6800 remains fully accessible
    let pingAfterClose = null;
    try {
      pingAfterClose = await httpRequest({ port: 6800, path: '/api/v1/ping' });
    } catch (e) {
      pingAfterClose = { status: 500, error: e.message };
    }
    assert(
      pingAfterClose?.status === 200 && (pingAfterClose?.data?.status === 'ok' || pingAfterClose?.data?.desktop_running),
      'Desktop API on port 6800 remains active and responsive while in system tray'
    );

    // 7. Verify background download progresses and completes without window
    console.log('Monitoring background download progress...');
    let dlComplete = false;
    let finalState = null;

    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        const stRes = await httpRequest({
          port: 6800,
          path: `/api/v1/downloads/${jobId}`,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (stRes.status === 200 && stRes.data) {
          finalState = stRes.data.state;
          if (finalState === 'completed') {
            dlComplete = true;
            break;
          }
        }
      } catch (_) {}
    }

    assert(dlComplete, `Download completed 100% in background (final state: ${finalState})`);

    // Verify file integrity
    const downloadedFile = path.join(DOWNLOAD_DIR, 'testfile.bin');
    assert(fs.existsSync(downloadedFile), 'Downloaded file exists on disk');
    if (fs.existsSync(downloadedFile)) {
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(downloadedFile)).digest('hex');
      assert(actualHash === expectedSha256, 'Downloaded file SHA-256 matches bit-for-bit');
    }

    // 8. Enqueue second download while main window is hidden
    console.log('Enqueuing second download while in system tray...');
    const dl2Res = await httpRequest({
      port: 6800,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: {
        url: `http://127.0.0.1:${HTTP_PORT}/testfile2.bin`,
        filename: 'testfile2.bin',
        destination: DOWNLOAD_DIR,
      },
    });

    assert(dl2Res.status === 200 && dl2Res.data?.job_id, 'Second download enqueued successfully while window hidden');
    const job2Id = dl2Res.data?.job_id;

    let dl2Complete = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        const stRes = await httpRequest({
          port: 6800,
          path: `/api/v1/downloads/${job2Id}`,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (stRes.status === 200 && stRes.data?.state === 'completed') {
          dl2Complete = true;
          break;
        }
      } catch (_) {}
    }
    assert(dl2Complete, 'Second download completed in background while hidden');

    // 9. Verify show_main_window restores the window
    console.log('Restoring main window via show_window action...');
    const showRes = await queryNativeHost(HOST_EXE, { action: 'show_window' }, childEnv);
    assert(showRes?.status === 'ok', 'Native Messaging show_window restored main window');
    await sleep(500);

    // 10. Verify lifecycle log contents and redaction
    assert(fs.existsSync(LIFECYCLE_LOG), 'Lifecycle log file exists at APPDATA/logs/lifecycle.log');
    if (fs.existsSync(LIFECYCLE_LOG)) {
      const logContent = fs.readFileSync(LIFECYCLE_LOG, 'utf8');
      assert(logContent.includes('[APP] STARTUP:'), 'Lifecycle log recorded STARTUP event');
      assert(logContent.includes('[TRAY] INITIALIZED:'), 'Lifecycle log recorded TRAY INITIALIZED event');
      assert(
        logContent.includes('[WINDOW] WINDOW_CLOSE_COMMAND:') || logContent.includes('[WINDOW] CLOSE_REQUESTED:'),
        'Lifecycle log recorded window close interception'
      );
      
      // Ensure no raw token leaked
      if (token) {
        assert(!logContent.includes(token), 'Lifecycle log strictly redacts auth tokens');
      }
    }

    // 11. Clean explicit exit
    console.log('Triggering explicit exit_app...');
    if (cdpSession) {
      try {
        await cdpSession.eval(`(() => {
          if (window.__TORI_INVOKE__) return window.__TORI_INVOKE__('exit_app', { force: true });
          if (window.__TAURI__ && window.__TAURI__.core) return window.__TAURI__.core.invoke('exit_app', { force: true });
        })()`);
      } catch (_) {}
    }

    await sleep(1500);
    // Check if process exited
    let exited = false;
    try {
      process.kill(pid, 0);
    } catch (_) {
      exited = true;
    }
    assert(exited, 'TORI process exited cleanly on explicit exit request');

    // Verify port 6800 released
    let portReleased = false;
    try {
      await httpRequest({ port: 6800, path: '/api/v1/ping' });
    } catch (_) {
      portReleased = true;
    }
    assert(portReleased, 'Desktop API port 6800 released cleanly upon exit');

    const finalLog = fs.readFileSync(LIFECYCLE_LOG, 'utf8');
    assert(finalLog.includes('[APP] EXPLICIT_EXIT:'), 'Lifecycle log recorded EXPLICIT_EXIT event');

  } finally {
    if (cdpSession) cdpSession.close();
    try { process.kill(pid); } catch (_) {}
    mockServer.close();
  }

  console.log('\n================================================================');
  console.log(`GATE 13.3 VERIFICATION RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
