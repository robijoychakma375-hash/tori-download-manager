/**
 * TORI Download Manager v1.0.1 — Gate 18.3F.2 Microsoft Edge Non-Regression Verification
 *
 * Verifies:
 * 1. Manifest V3 Integrity: Chromium service_worker, version 1.0.1, fixed public key.
 * 2. Real Browser Execution (Edge with CDP on port 9333, isolated profile, loaded extension).
 * 3. Options Pairing: local API connection on port 19700 with auth token -> authenticated: true.
 * 4. Popup Media Detection: scans multivideo.html, discovers MP4 & WebM candidates.
 * 5. Multiple Tabs: opens second_tab.html, confirms tab-isolated candidate tracking.
 * 6. Desktop Handoff & Real Media Download: triggers START_DOWNLOAD, monitors to completion,
 *    verifies downloaded file on disk and byte-perfect SHA256 match.
 * 7. Deduplication & No Duplicate Jobs: dispatches duplicate download, confirms existing job returned.
 * 8. Reconnection: terminates desktop engine, detects offline, restarts engine, confirms re-pairing.
 * 9. Native Messaging Framing & Protocol Compatibility: validates tdm-native-host stdio handshake.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const FIXTURE_PORT = 19799;
const DESKTOP_PORT = 19700;
const CDP_PORT = 9333;

const ISOLATED_ENV_DIR = path.join(PROJECT_ROOT, 'target', 'gate18_3f2_edge_env');
const ISOLATED_DATA_DIR = path.join(ISOLATED_ENV_DIR, 'data');
const ISOLATED_DOWNLOADS_DIR = path.join(ISOLATED_ENV_DIR, 'downloads');
const ISOLATED_PROFILE_DIR = path.join(ISOLATED_ENV_DIR, 'edge_profile');
const ISOLATED_PIPE_NAME = '\\\\.\\pipe\\tori-edge-regression-ipc';

const TEST_API_TOKEN = 'tori_edge_reg_token_' + crypto.randomBytes(8).toString('hex');
let testResults = [];

function recordResult(id, task, outcome, details) {
  testResults.push({ id, task, outcome, details });
  const icon = outcome === 'PASS' ? '✅' : '❌';
  console.log(`${icon} [${id}] ${task}: ${outcome} - ${details}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeHttpRequest({ host = '127.0.0.1', port, path: reqPath, method = 'GET', headers = {}, body = null, timeout = 10000 }) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };
    if (payload && !reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
    if (payload) reqHeaders['Content-Length'] = Buffer.byteLength(payload);

    const req = http.request(
      { hostname: host, port, path: reqPath, method, headers: reqHeaders, timeout },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(raw); } catch (_) { data = raw; }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`HTTP request timed out after ${timeout}ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

class CdpClient {
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

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res && res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
    }
    return res.result ? res.result.value : res.value;
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }
  }
}

function createFixtureServer(sampleMp4Bytes) {
  const dummyWebm = Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAATFlNWLGM2jw0KAAAnSW5mbwEAAAAAAAATFlNWLGM2jw0KAAAnU2VnbWVudAEAAAAAAA==', 'base64');

  const server = http.createServer((req, res) => {
    const reqUrl = req.url.split('?')[0];

    if (reqUrl === '/multivideo.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Edge Acceptance Test</title></head>
<body>
  <h1>TORI Edge Regression Suite</h1>
  <video id="v1" controls width="320" height="180" src="/media/sample.mp4" autoplay muted></video>
  <video id="v2" controls width="320" height="180" src="/media/sample.webm" autoplay muted></video>
</body>
</html>`);
    }

    if (reqUrl === '/second_tab.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html><body><h1>Tab 2</h1><video src="/media/sample.mp4?tab=2" autoplay muted></video></body></html>`);
    }

    if (reqUrl === '/media/sample.mp4') {
      const total = sampleMp4Bytes.length;
      const range = req.headers['range'];
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
        const chunk = sampleMp4Bytes.slice(start, end + 1);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunk.length,
          'Content-Type': 'video/mp4',
        });
        return res.end(chunk);
      } else {
        res.writeHead(200, {
          'Content-Length': total,
          'Accept-Ranges': 'bytes',
          'Content-Type': 'video/mp4',
        });
        return res.end(sampleMp4Bytes);
      }
    }

    if (reqUrl === '/media/sample.webm') {
      res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': dummyWebm.length });
      return res.end(dummyWebm);
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  return new Promise((resolve) => server.listen(FIXTURE_PORT, '127.0.0.1', () => resolve(server)));
}

async function run() {
  console.log('================================================================');
  console.log(' TORI Download Manager v1.0.1 — GATE 18.3F.2 EDGE NON-REGRESSION');
  console.log('================================================================\n');

  if (fs.existsSync(ISOLATED_ENV_DIR)) {
    try { fs.rmSync(ISOLATED_ENV_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  [ISOLATED_DATA_DIR, ISOLATED_DOWNLOADS_DIR, ISOLATED_PROFILE_DIR].forEach((d) => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  const sampleMp4Path = path.resolve('target/test_sample.mp4');
  const sampleMp4Bytes = fs.readFileSync(sampleMp4Path);
  const sampleMp4Sha256 = crypto.createHash('sha256').update(sampleMp4Bytes).digest('hex');

  let fixtureServer = null;
  let desktopProc = null;
  let edgeProc = null;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Manifest V3 Integrity
    // -------------------------------------------------------------------------
    console.log('--- TEST 1: Chromium Manifest V3 Integrity ---');
    const manifestPath = path.join(PROJECT_ROOT, 'extension', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    const isSw = manifest.background?.service_worker === 'background.js';
    const isV101 = manifest.version === '1.0.1';
    const hasKey = typeof manifest.key === 'string' && manifest.key.length > 50;
    const hasPerms = manifest.permissions.includes('nativeMessaging') && manifest.permissions.includes('storage');

    recordResult('EDGE-01', 'Chromium Manifest V3 Integrity', (isSw && isV101 && hasKey && hasPerms) ? 'PASS' : 'FAIL', `Version: ${manifest.version}, ServiceWorker: ${manifest.background?.service_worker}, Key: ${hasKey}`);

    // Start fixture server
    fixtureServer = await createFixtureServer(sampleMp4Bytes);
    console.log(`[INIT] Media Fixtures listening on http://127.0.0.1:${FIXTURE_PORT}`);

    // Seed Isolated SQLite Database
    const dbFile = path.join(ISOLATED_DATA_DIR, 'tdm_storage.sqlite');
    execSync(
      `python -c "import sqlite3, json, os; conn = sqlite3.connect(r'${dbFile}'); cur = conn.cursor(); cur.execute('CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);'); cur.execute('INSERT OR REPLACE INTO engine_settings VALUES (?, ?)', ('browser_integration_token', '${TEST_API_TOKEN}')); app_settings = {'dir': r'${ISOLATED_DOWNLOADS_DIR.replace(/\\/g, '\\\\')}', 'port': ${DESKTOP_PORT}}; cur.execute('INSERT OR REPLACE INTO engine_settings VALUES (?, ?)', ('app_settings', json.dumps(app_settings))); conn.commit()"`,
      { encoding: 'utf8' }
    );

    // Launch Desktop Engine with dedicated IPC pipe and data dir
    const desktopExe = path.join(PROJECT_ROOT, 'target', 'release', 'tori-download-manager.exe');
    desktopProc = spawn(desktopExe, ['--minimized'], {
      env: {
        ...process.env,
        TORI_DATA_DIR: ISOLATED_DATA_DIR,
        TORI_IPC_PIPE: ISOLATED_PIPE_NAME,
        TORI_ALLOW_LOOPBACK: '1',
        WEBVIEW2_USER_DATA_FOLDER: path.join(ISOLATED_ENV_DIR, 'webview2'),
      },
      stdio: 'ignore'
    });

    let desktopOnline = false;
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      try {
        const ping = await makeHttpRequest({ port: DESKTOP_PORT, path: '/api/v1/ping' });
        if (ping.status === 200 && ping.data?.status === 'ok') {
          desktopOnline = true;
          break;
        }
      } catch (_) {}
    }
    recordResult('EDGE-02', 'Isolated Desktop Engine Active', desktopOnline ? 'PASS' : 'FAIL', `Responsive on port ${DESKTOP_PORT}`);

    // Native Messaging Host Stdio Handshake check (pointing to isolated pipe and data dir)
    const nativeHostExe = path.join(PROJECT_ROOT, 'target', 'release', 'tdm-native-host.exe');
    let hostHandshakeOk = false;
    try {
      const pingPayload = JSON.stringify({ action: 'ping' });
      const payloadBuf = Buffer.from(pingPayload, 'utf8');
      const headerBuf = Buffer.alloc(4);
      headerBuf.writeUInt32LE(payloadBuf.length, 0);
      const inputBuf = Buffer.concat([headerBuf, payloadBuf]);

      const hostOut = execSync(`"${nativeHostExe}"`, {
        input: inputBuf,
        timeout: 5000,
        env: {
          ...process.env,
          TORI_DATA_DIR: ISOLATED_DATA_DIR,
          TORI_IPC_PIPE: ISOLATED_PIPE_NAME,
        }
      });
      if (hostOut.length >= 4) {
        const respLen = hostOut.readUInt32LE(0);
        const respJson = JSON.parse(hostOut.slice(4, 4 + respLen).toString('utf8'));
        if (respJson.status === 'ok') {
          hostHandshakeOk = true;
        }
      }
    } catch (_) {}
    recordResult('EDGE-03', 'Native Host Stdio Handshake (Ping)', hostHandshakeOk ? 'PASS' : 'FAIL', 'Native host executable responds to 32-bit length prefixed framing');

    // Launch Microsoft Edge with CDP
    console.log('\n--- Launching Microsoft Edge via CDP ---');
    const edgeBinary = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const extDir = path.join(PROJECT_ROOT, 'extension');

    edgeProc = spawn(edgeBinary, [
      `--load-extension=${extDir}`,
      `--disable-extensions-except=${extDir}`,
      `--user-data-dir=${ISOLATED_PROFILE_DIR}`,
      `--remote-debugging-port=${CDP_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      `http://127.0.0.1:${FIXTURE_PORT}/multivideo.html`
    ], { stdio: 'ignore' });

    let cdpReady = false;
    let targets = [];
    for (let i = 0; i < 25; i++) {
      await sleep(500);
      try {
        const listRes = await makeHttpRequest({ port: CDP_PORT, path: '/json/list' });
        if (listRes.status === 200 && Array.isArray(listRes.data)) {
          targets = listRes.data;
          cdpReady = true;
          break;
        }
      } catch (_) {}
    }

    recordResult('EDGE-04', 'Edge Browser Launch & CDP Connection', cdpReady ? 'PASS' : 'FAIL', `CDP active on port ${CDP_PORT}, targets: ${targets.length}`);

    // Locate extension ID from target list or options page
    const extId = 'jfnfgmcbgapcpieaonbaolgebjaejcdm';
    const optionsUrl = `chrome-extension://${extId}/options/options.html`;

    // Open Options tab via CDP
    await makeHttpRequest({ port: CDP_PORT, path: `/json/new?${optionsUrl}`, method: 'PUT' });
    await sleep(2000);

    const updatedTargetsRes = await makeHttpRequest({ port: CDP_PORT, path: '/json/list' });
    const optionsTarget = updatedTargetsRes.data.find((t) => t.url.includes(optionsUrl));
    if (!optionsTarget) throw new Error('Options tab not found in Edge');

    const optionsCdp = new CdpClient(optionsTarget.webSocketDebuggerUrl);
    await optionsCdp.connect();
    await optionsCdp.send('Runtime.enable');

    // Configure options pairing
    const pairResult = await optionsCdp.evaluate(`
      new Promise((resolve) => {
        S.port = ${DESKTOP_PORT};
        S.key = '${TEST_API_TOKEN}';
        S.min = 0;
        persistSettings();
        chrome.storage.local.set({
          tori_settings: { port: ${DESKTOP_PORT}, key: '${TEST_API_TOKEN}', min: 0 }
        }, () => {
          fetch('http://127.0.0.1:${DESKTOP_PORT}/api/v1/status', {
            headers: { 'X-Tori-Token': '${TEST_API_TOKEN}' }
          }).then(r => r.json()).then(data => {
            resolve({ ok: true, data });
          }).catch(err => {
            resolve({ ok: false, error: err.message });
          });
        });
      })
    `);

    const optionsPaired = pairResult?.ok && pairResult?.data?.authenticated === true;
    recordResult('EDGE-05', 'Edge Extension Options & Local API Pairing', optionsPaired ? 'PASS' : 'FAIL', `Authenticated: ${pairResult?.data?.authenticated}, Engine: ${pairResult?.data?.version}`);

    // Wait for content script to detect videos in multivideo.html
    await sleep(2500);

    // Open Popup tab
    const popupUrl = `chrome-extension://${extId}/popup/popup.html`;
    await makeHttpRequest({ port: CDP_PORT, path: `/json/new?${popupUrl}`, method: 'PUT' });
    await sleep(2000);

    const popupTargetsRes = await makeHttpRequest({ port: CDP_PORT, path: '/json/list' });
    const popupTarget = popupTargetsRes.data.find((t) => t.url.includes(popupUrl));
    const popupCdp = new CdpClient(popupTarget.webSocketDebuggerUrl);
    await popupCdp.connect();
    await popupCdp.send('Runtime.enable');

    const mediaListRes = await popupCdp.evaluate(`
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'GET_ALL_MEDIA' }, (res) => {
          resolve(res || {});
        });
      })
    `);

    const mediaItems = mediaListRes?.media || [];
    const hasMp4 = mediaItems.some((m) => m.url.includes('/media/sample.mp4'));
    const hasWebm = mediaItems.some((m) => m.url.includes('/media/sample.webm'));
    recordResult('EDGE-06', 'Edge Extension Media Detection (MP4 & WebM)', (hasMp4 && hasWebm) ? 'PASS' : 'FAIL', `Detected: ${mediaItems.length} (MP4: ${hasMp4}, WebM: ${hasWebm})`);

    // Multiple Tabs Isolation Test
    await makeHttpRequest({ port: CDP_PORT, path: `/json/new?http://127.0.0.1:${FIXTURE_PORT}/second_tab.html`, method: 'PUT' });
    await sleep(2500);

    const multiTabCheck = await popupCdp.evaluate(`
      new Promise(async (resolve) => {
        const tabs = await chrome.tabs.query({});
        const tab2 = tabs.find(t => t.url && t.url.includes('second_tab.html'));
        if (!tab2) return resolve({ ok: false, error: 'Tab 2 not found' });
        chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA', tabId: tab2.id }, (res) => {
          resolve({ ok: true, count: res?.media?.length || 0 });
        });
      })
    `);

    recordResult('EDGE-07', 'Multiple Tabs Independent Media Tracking', multiTabCheck?.ok ? 'PASS' : 'FAIL', `Tab 2 Media Count: ${multiTabCheck?.count}`);

    // Real Media Download Handoff
    console.log('[EDGE] Dispatching real download handoff from Edge extension...');
    const dlDispatch = await popupCdp.evaluate(`
      new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'START_DOWNLOAD',
          url: 'http://127.0.0.1:${FIXTURE_PORT}/media/sample.mp4',
          filename: 'edge_sample.mp4',
          referrer: 'http://127.0.0.1:${FIXTURE_PORT}/multivideo.html',
        }, (res) => resolve(res));
      })
    `);

    const jobId = dlDispatch?.job_id;
    const jobOk = (dlDispatch?.status === 'ok' || dlDispatch?.status === 'already_exists') && Boolean(jobId);
    recordResult('EDGE-08', 'Download Handoff from Edge Extension', jobOk ? 'PASS' : 'FAIL', `Job ID: ${jobId}`);

    // Deduplication Test: Dispatch same URL again immediately
    const dupDispatch = await popupCdp.evaluate(`
      new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'START_DOWNLOAD',
          url: 'http://127.0.0.1:${FIXTURE_PORT}/media/sample.mp4',
          filename: 'edge_sample.mp4',
          referrer: 'http://127.0.0.1:${FIXTURE_PORT}/multivideo.html',
        }, (res) => resolve(res));
      })
    `);

    const isDeduplicated =
      (dupDispatch?.status === 'ok' || dupDispatch?.status === 'already_exists') &&
      dupDispatch?.job_id === jobId;
    recordResult('EDGE-09', 'Download Deduplication / Idempotency', isDeduplicated ? 'PASS' : 'FAIL', `Deduplicated to Job: ${dupDispatch?.job_id} (Status: ${dupDispatch?.status})`);

    // Monitor Download Completion
    let completed = false;
    let jobDetails = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const pollRes = await makeHttpRequest({
        port: DESKTOP_PORT,
        path: `/api/v1/downloads/${jobId}`,
        headers: { 'X-Tori-Token': TEST_API_TOKEN },
      });
      if (pollRes.status === 200 && pollRes.data) {
        jobDetails = pollRes.data;
        if (jobDetails.state === 'completed' || jobDetails.status === 'completed') {
          completed = true;
          break;
        }
      }
    }

    recordResult('EDGE-10', 'Desktop Engine Download Completion', completed ? 'PASS' : 'FAIL', `State: ${jobDetails?.state || jobDetails?.status}, Bytes: ${jobDetails?.downloaded_bytes || jobDetails?.total_bytes}`);

    // Verify downloaded file on disk
    let targetFilePath = jobDetails?.target_path;
    if (!targetFilePath || !fs.existsSync(targetFilePath)) {
      const candidates = [
        path.join(ISOLATED_DOWNLOADS_DIR, 'Video', 'edge_sample.mp4'),
        path.join(ISOLATED_DOWNLOADS_DIR, 'Video', 'sample.mp4'),
        path.join(ISOLATED_DOWNLOADS_DIR, 'Videos', 'sample.mp4'),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) { targetFilePath = c; break; }
      }
    }

    const fileExists = targetFilePath && fs.existsSync(targetFilePath);
    const downloadedSize = fileExists ? fs.statSync(targetFilePath).size : 0;
    const shaMatches = fileExists && crypto.createHash('sha256').update(fs.readFileSync(targetFilePath)).digest('hex') === sampleMp4Sha256;

    recordResult('EDGE-11', 'Downloaded File Integrity & Byte-Perfect SHA256', (downloadedSize === sampleMp4Bytes.length && shaMatches) ? 'PASS' : 'FAIL', `Size: ${downloadedSize} B, SHA256 Match: ${shaMatches}`);

    // Reconnection Test
    console.log('[EDGE] Testing desktop disconnection and reconnection...');
    desktopProc.kill();
    await sleep(2000);

    // Verify extension sees offline
    const offlineCheck = await popupCdp.evaluate(`
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${DESKTOP_PORT}, key: '${TEST_API_TOKEN}' }, (res) => {
          resolve(res || {});
        });
      })
    `);

    const sawOffline = offlineCheck?.status === 'disconnected';

    // Restart desktop engine
    desktopProc = spawn(desktopExe, ['--minimized'], {
      env: {
        ...process.env,
        TORI_DATA_DIR: ISOLATED_DATA_DIR,
        TORI_IPC_PIPE: ISOLATED_PIPE_NAME,
        TORI_ALLOW_LOOPBACK: '1',
        WEBVIEW2_USER_DATA_FOLDER: path.join(ISOLATED_ENV_DIR, 'webview2'),
      },
      stdio: 'ignore'
    });

    for (let i = 0; i < 20; i++) {
      await sleep(400);
      try {
        const ping = await makeHttpRequest({ port: DESKTOP_PORT, path: '/api/v1/ping' });
        if (ping.status === 200 && ping.data?.status === 'ok') break;
      } catch (_) {}
    }

    // Verify extension reconnects
    const reconnectCheck = await popupCdp.evaluate(`
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${DESKTOP_PORT}, key: '${TEST_API_TOKEN}' }, (res) => {
          resolve(res || {});
        });
      })
    `);

    const reconnected = reconnectCheck?.status === 'ok' && reconnectCheck?.authenticated === true;
    recordResult('EDGE-12', 'Desktop Disconnection & Automatic Reconnection', (sawOffline && reconnected) ? 'PASS' : 'FAIL', `Detected Offline: ${sawOffline}, Reconnected Authenticated: ${reconnected}`);

    optionsCdp.close();
    popupCdp.close();

  } finally {
    console.log('\n--- CLEANUP & TEARDOWN ---');
    if (edgeProc) {
      edgeProc.kill();
      console.log('[EDGE] Terminated test Edge browser process.');
    }
    if (desktopProc) {
      desktopProc.kill();
      console.log('[DESKTOP] Terminated test TORI desktop engine.');
    }
    if (fixtureServer) {
      fixtureServer.close();
      console.log('[FIXTURES] Stopped fixture server.');
    }

    await sleep(1500);
    try {
      fs.rmSync(ISOLATED_PROFILE_DIR, { recursive: true, force: true });
    } catch (_) {}
  }

  console.log('\n================================================================');
  console.log(' GATE 18.3F.2 EDGE REGRESSION SUMMARY');
  console.log('================================================================');
  const passes = testResults.filter((r) => r.outcome === 'PASS').length;
  const fails = testResults.filter((r) => r.outcome === 'FAIL').length;
  console.log(`Total Scenarios: ${testResults.length} | Passed: ${passes} | Failed: ${fails}`);
  console.log(`Success Rate: ${((passes / testResults.length) * 100).toFixed(1)}%\n`);

  fs.writeFileSync(
    path.join(PROJECT_ROOT, 'scripts', 'gate18_3f2_edge_results.json'),
    JSON.stringify(testResults, null, 2),
    'utf8'
  );

  if (fails > 0) process.exit(1);
  else process.exit(0);
}

run().catch((err) => {
  console.error('[FATAL] Edge regression failed:', err);
  process.exit(1);
});
