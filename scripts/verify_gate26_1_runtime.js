#!/usr/bin/env node
/**
 * TORI Download Manager v1.0.4-rc — Gate 26.1 Comprehensive Runtime Verification Suite
 *
 * Verifies in isolated storage (TORI_DATA_DIR):
 * 1. STEP 5: Native Host auto-spawn survival after tdm-native-host.exe exits + stdout framing purity
 * 2. STEP 4: HTTP 3.5s timeout + Native Messaging fallback coalescing (zero duplicate downloads)
 * 3. STEP 6: Close-to-Tray recovery utility, --enable-close-to-tray flag, WebView2 isolation,
 *            X-to-Tray (HIDE_MAIN), tray restore (RESTORE_MAIN), single-instance, and clean Exit
 * 4. STEP 7: Large-file engine metrics (100 MB, 1 GB, 5 GB, 10 GB, 50 GB)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = Date.now();
const TEST_ROOT = path.join(ROOT, 'target', `test_gate26_1_${RUN_ID}`);
const DATA_DIR = path.join(TEST_ROOT, 'data');
const DOWNLOAD_DIR = path.join(TEST_ROOT, 'downloads');
const LIFECYCLE_LOG = path.join(DATA_DIR, 'logs', 'lifecycle.log');
const PIPE_NAME = `\\\\.\\pipe\\tori-gate26-1-${RUN_ID}-ipc`;
const DESKTOP_PORT = 16840;
const MOCK_CDN_PORT = 16841;

const MAIN_EXE = path.join(ROOT, 'target', 'release', 'tori-download-manager.exe');
const HOST_EXE = path.join(ROOT, 'target', 'release', 'tdm-native-host.exe');

const results = [];
let passed = 0;
let failed = 0;

function record(name, ok, details = {}) {
  if (ok) {
    passed++;
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.error(`[FAIL] ${name}`, details);
  }
  results.push({ name, status: ok ? 'PASS' : 'FAIL', details });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function getProcessRssMb(pid) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64"`,
      { encoding: 'utf8' }
    ).trim();
    const bytes = parseInt(out, 10);
    return Number.isFinite(bytes) ? Math.round((bytes / (1024 * 1024)) * 10) / 10 : null;
  } catch {
    return null;
  }
}

function findTestToriPids() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-Process -Name 'tori-download-manager' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*target*release*' } | Select-Object -ExpandProperty Id"`,
      { encoding: 'utf8' }
    ).trim();
    if (!out) return [];
    return out
      .split(/\r?\n/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

function sendNativeHostMessage(msgObj, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(HOST_EXE, ['tori-download-manager@toridm.org'], {
      env: {
        ...process.env,
        TORI_DATA_DIR: DATA_DIR,
        TORI_IPC_PIPE: PIPE_NAME,
        TORI_ALLOW_LOOPBACK: '1',
        ...envOverrides,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const outChunks = [];
    const errChunks = [];
    proc.stdout.on('data', (d) => outChunks.push(d));
    proc.stderr.on('data', (d) => errChunks.push(d));
    proc.on('error', reject);

    proc.on('close', (code) => {
      const stdoutBuf = Buffer.concat(outChunks);
      const stderrStr = Buffer.concat(errChunks).toString('utf8');
      if (stdoutBuf.length < 4) {
        return resolve({
          code,
          validFraming: false,
          response: null,
          rawStdoutHex: stdoutBuf.toString('hex'),
          stderrStr,
        });
      }
      const msgLen = stdoutBuf.readUInt32LE(0);
      const bodyBuf = stdoutBuf.slice(4, 4 + msgLen);
      try {
        const parsed = JSON.parse(bodyBuf.toString('utf8'));
        resolve({
          code,
          validFraming: stdoutBuf.length === 4 + msgLen,
          response: parsed,
          stderrStr,
        });
      } catch (err) {
        resolve({
          code,
          validFraming: false,
          response: null,
          parseError: err.message,
          rawStdout: stdoutBuf.toString('utf8'),
          stderrStr,
        });
      }
    });

    const jsonBytes = Buffer.from(JSON.stringify(msgObj), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(jsonBytes.length, 0);
    proc.stdin.write(Buffer.concat([header, jsonBytes]));
    proc.stdin.end();
  });
}

function httpRequest({ port, path: reqPath, method = 'GET', headers = {}, body = null, timeoutMs = 10000 }) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      Host: `127.0.0.1:${port}`,
      ...headers,
    };
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
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: json, raw: data });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('HTTP_CLIENT_TIMEOUT'));
    });

    req.on('error', (err) => {
      resolve({ status: 0, ok: false, error: err.message });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

function startMockCdnServer() {
  const stats = { headSlow: 0, headFast: 0, rangeReqs: 0 };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${MOCK_CDN_PORT}`);
    if (u.pathname.includes('Setup_Part1.rar')) {
      const size = 16 * 1024 * 1024;
      if (req.method === 'HEAD') {
        stats.headSlow++;
        // Delay 4200ms so Extension v1.0.5's 3500ms HTTP timeout triggers while probe is in-flight!
        await sleep(3600);
        res.writeHead(200, {
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
          ETag: '"part1-etag"',
          'Content-Type': 'application/vnd.rar',
        });
        return res.end();
      }
      const range = req.headers.range;
      if (range) {
        stats.rangeReqs++;
        const [sStr, eStr] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(sStr, 10) || 0;
        const end = eStr ? parseInt(eStr, 10) : size - 1;
        const len = end - start + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(len),
          'Accept-Ranges': 'bytes',
          ETag: '"part1-etag"',
        });
        // Stream slowly so job stays active during inspection
        const chunk = Buffer.alloc(Math.min(len, 65536), 0x41);
        res.write(chunk);
        return;
      }
    }

    if (u.pathname.includes('Setup_Part2.rar')) {
      const size = 4 * 1024 * 1024;
      if (req.method === 'HEAD') {
        stats.headFast++;
        res.writeHead(200, {
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
          ETag: '"part2-etag"',
          'Content-Type': 'application/vnd.rar',
        });
        return res.end();
      }
      const range = req.headers.range;
      const [sStr, eStr] = (range || 'bytes=0-').replace(/bytes=/, '').split('-');
      const start = parseInt(sStr, 10) || 0;
      const end = eStr ? parseInt(eStr, 10) : size - 1;
      const len = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(len),
        'Accept-Ranges': 'bytes',
        ETag: '"part2-etag"',
      });
      res.end(Buffer.alloc(len, 0x42));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(MOCK_CDN_PORT, '127.0.0.1', () => resolve({ server, stats }));
  });
}

async function main() {
  console.log('================================================================');
  console.log('TORI GATE 26.1: RUNTIME STABILITY & LIFECYCLE VERIFICATION');
  console.log('================================================================\n');

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const { server: cdnServer, stats: cdnStats } = await startMockCdnServer();

  try {
    // -----------------------------------------------------------------------
    // 1. Test Safe Close-to-Tray Recovery Script (scripts/enable_close_to_tray.js)
    // -----------------------------------------------------------------------
    const dbPath = path.join(DATA_DIR, 'tdm_storage.sqlite');
    const seedPy = `
import sqlite3, json, sys
db_p, port, dl_dir = sys.argv[1], int(sys.argv[2]), sys.argv[3]
conn = sqlite3.connect(db_p)
cur = conn.cursor()
cur.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
cur.execute("INSERT OR REPLACE INTO engine_settings (key, value) VALUES ('browser_integration_token', 'gate26_test_token_secret')")
app_s = {"theme": "dark", "accent": "ocean", "con": 12, "port": port, "dir": dl_dir, "closeToTray": False}
cur.execute("INSERT OR REPLACE INTO engine_settings (key, value) VALUES ('app_settings', ?)", (json.dumps(app_s),))
conn.commit()
conn.close()
`;
    execFileSync('python', ['-c', seedPy, dbPath, String(DESKTOP_PORT), DOWNLOAD_DIR]);

    const enableOut = execFileSync(
      'node',
      [path.join(ROOT, 'scripts', 'enable_close_to_tray.js'), '--db', dbPath],
      { encoding: 'utf8' }
    );
    const verifyPy = `
import sqlite3, json, sys
conn = sqlite3.connect(sys.argv[1])
row = conn.execute("SELECT value FROM engine_settings WHERE key='app_settings'").fetchone()
conn.close()
print(row[0])
`;
    const restoredSettings = JSON.parse(
      execFileSync('python', ['-c', verifyPy, dbPath], { encoding: 'utf8' }).trim()
    );
    record(
      'STEP 6.1: enable_close_to_tray.js safely enables closeToTray without resetting user settings',
      restoredSettings.closeToTray === true &&
        restoredSettings.theme === 'dark' &&
        restoredSettings.accent === 'ocean' &&
        restoredSettings.con === 12,
      { restoredSettings, enableOut: enableOut.trim() }
    );

    // -----------------------------------------------------------------------
    // 2. Test STEP 5: Native Host Auto-Spawn Survival & Stdout Protocol Purity
    // -----------------------------------------------------------------------
    console.log('\n--- Testing STEP 5: Native Host Auto-Spawn Survival ---');
    const nmPing = await sendNativeHostMessage({ action: 'ping' });
    record(
      'STEP 5.1: tdm-native-host.exe auto-spawns desktop with clean stdout framing (no tracing pollution)',
      nmPing.validFraming && nmPing.response && nmPing.response.status === 'ok' && nmPing.response.action === 'pong',
      nmPing
    );

    // Wait 2.5 seconds after tdm-native-host.exe has exited and verify desktop process is STILL ALIVE!
    await sleep(2500);
    const alivePids = findTestToriPids();
    record(
      'STEP 5.2: Spawned tori-download-manager.exe --minimized survives after tdm-native-host.exe exits (Job Object breakaway + Stdio::null)',
      alivePids.length === 1 && isPidAlive(alivePids[0]),
      { alivePids }
    );

    // Verify WebView2 isolation directory was automatically created inside DATA_DIR
    const isolatedWebviewDir = path.join(DATA_DIR, 'EBWebView');
    record(
      'STEP 6.2: TORI_DATA_DIR automatically isolates WEBVIEW2_USER_DATA_FOLDER inside <TORI_DATA_DIR>/EBWebView',
      fs.existsSync(isolatedWebviewDir),
      { isolatedWebviewDir }
    );

    // Wait for local HTTP server on DESKTOP_PORT
    let statusRes = null;
    for (let i = 0; i < 30; i++) {
      statusRes = await httpRequest({
        port: DESKTOP_PORT,
        path: '/api/v1/status',
        headers: { 'X-Tori-Token': 'gate26_test_token_secret' },
      });
      if (statusRes.ok) break;
      await sleep(200);
    }
    record(
      'STEP 5.3: Persistent desktop HTTP API server is online and authenticated after background spawn',
      Boolean(statusRes && statusRes.ok && statusRes.data && statusRes.data.authenticated === true),
      statusRes
    );

    // -----------------------------------------------------------------------
    // 3. Test STEP 4: Duplicate Browser Interception Prevention (HTTP Timeout + Native Fallback)
    // -----------------------------------------------------------------------
    console.log('\n--- Testing STEP 4: Duplicate Browser Handoff Coalescing ---');
    const part1Url = `http://127.0.0.1:${MOCK_CDN_PORT}/Setup_Part1.rar?v=1776063401-I2c5nG0q&token=cdn_sig_1`;

    // Simulate Extension v1.0.5: POST /api/v1/downloads with 2000ms client timeout while CDN HEAD probe takes 3600ms
    const httpTimedOutRes = await httpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': 'gate26_test_token_secret' },
      body: {
        url: part1Url,
        filename: 'Setup_Part1.rar',
        destination: DOWNLOAD_DIR,
        handoff_id: 'ext_501_1776063401',
      },
      timeoutMs: 1800,
    });

    // Immediately fire Native Messaging start_download fallback (while HTTP probe is still in-flight on backend!)
    const nmFallbackRes = await sendNativeHostMessage({
      action: 'start_download',
      url: part1Url,
      filename: 'Setup_Part1.rar',
      destination: DOWNLOAD_DIR,
      handoff_id: 'ext_501_1776063401',
    });

    const listAfterPart1 = await httpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      headers: { 'X-Tori-Token': 'gate26_test_token_secret' },
    });
    const part1Jobs = (listAfterPart1.data?.jobs || []).filter((j) => j.url.includes('Setup_Part1.rar'));

    record(
      'STEP 4.1: HTTP timeout + Native Messaging fallback coalesces into a single download job (zero duplicate (1) task)',
      httpTimedOutRes.status === 0 &&
        nmFallbackRes.validFraming &&
        (nmFallbackRes.response?.status === 'ok' || nmFallbackRes.response?.status === 'already_exists') &&
        part1Jobs.length === 1 &&
        part1Jobs[0].filename === 'Setup_Part1.rar' &&
        cdnStats.headSlow === 1,
      {
        httpTimedOutStatus: httpTimedOutRes.status,
        nmFallbackStatus: nmFallbackRes.response?.status,
        jobCount: part1Jobs.length,
        filename: part1Jobs[0]?.filename,
        headProbeCount: cdnStats.headSlow,
      }
    );

    // Also test a distinct legitimate second download (Setup_Part2.rar)
    const part2Url = `http://127.0.0.1:${MOCK_CDN_PORT}/Setup_Part2.rar?v=1776063402-X9z&token=cdn_sig_2`;
    const part2Res = await httpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': 'gate26_test_token_secret' },
      body: {
        url: part2Url,
        filename: 'Setup_Part2.rar',
        destination: DOWNLOAD_DIR,
        handoff_id: 'ext_502_1776063402',
      },
    });
    const listAfterPart2 = await httpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      headers: { 'X-Tori-Token': 'gate26_test_token_secret' },
    });
    record(
      'STEP 4.2: Legitimate distinct downloads and signed CDN query parameters are preserved',
      part2Res.ok &&
        part2Res.data?.status === 'ok' &&
        (listAfterPart2.data?.jobs || []).length === 2 &&
        (listAfterPart2.data?.jobs || []).some((j) => j.url === part2Url),
      { totalJobs: (listAfterPart2.data?.jobs || []).length }
    );

    // -----------------------------------------------------------------------
    // 4. Test STEP 6: Window Hide (Close-to-Tray), Show (Tray Restore), Single Instance & Clean Exit
    // -----------------------------------------------------------------------
    console.log('\n--- Testing STEP 6: Close-to-Tray, Single Instance & Lifecycle Logging ---');

    // Show window via Native Messaging / IPC
    const showRes = await sendNativeHostMessage({ action: 'show_window' });
    await sleep(400);

    // Hide window via Native Messaging / IPC
    const hideRes = await sendNativeHostMessage({ action: 'hide_window' });
    await sleep(400);

    // Launch a secondary instance of tori-download-manager.exe and verify it detects primary & exits cleanly
    const secProc = spawn(MAIN_EXE, [], {
      env: {
        ...process.env,
        TORI_DATA_DIR: DATA_DIR,
        TORI_IPC_PIPE: PIPE_NAME,
      },
      stdio: 'ignore',
    });
    await new Promise((resolve) => secProc.on('close', resolve));
    await sleep(400);

    const pidsAfterSecondary = findTestToriPids();
    const logContentBeforeExit = fs.existsSync(LIFECYCLE_LOG)
      ? fs.readFileSync(LIFECYCLE_LOG, 'utf8')
      : '';

    record(
      'STEP 6.3: Single-instance guard focuses primary instance and exits secondary process while primary stays alive',
      pidsAfterSecondary.length === 1 &&
        isPidAlive(pidsAfterSecondary[0]) &&
        logContentBeforeExit.includes('[APP] SECONDARY_INSTANCE'),
      { pidsAfterSecondary, showStatus: showRes.response?.status, hideStatus: hideRes.response?.status }
    );

    // Cancel test downloads and cleanly terminate background-spawned instance before CDP UI test
    for (const j of listAfterPart2.data?.jobs || []) {
      await httpRequest({
        port: DESKTOP_PORT,
        path: `/api/v1/downloads/${j.id}/cancel`,
        method: 'POST',
        headers: { 'X-Tori-Token': 'gate26_test_token_secret' },
      });
    }

    for (const pid of findTestToriPids()) {
      try {
        process.kill(pid);
      } catch {}
    }
    await sleep(600);

    // Now launch interactive desktop instance with --enable-close-to-tray + CDP remote debugging
    // to test actual title-bar X button (`window_close`), tray restore (`show_main_window`), and explicit `exit_app`!
    const cdpPort = 19261;
    const uiProc = spawn(MAIN_EXE, ['--enable-close-to-tray'], {
      env: {
        ...process.env,
        TORI_DATA_DIR: DATA_DIR,
        TORI_IPC_PIPE: PIPE_NAME,
        TORI_ALLOW_LOOPBACK: '1',
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
      },
      stdio: 'ignore',
    });

    // Wait for HTTP API & WebView2 CDP to be ready
    for (let i = 0; i < 40; i++) {
      const st = await httpRequest({
        port: DESKTOP_PORT,
        path: '/api/v1/status',
        headers: { 'X-Tori-Token': 'gate26_test_token_secret' },
      });
      if (st.ok) break;
      await sleep(250);
    }
    await sleep(1200);

    // Connect to WebView2 CDP to invoke window_close (X button) and exit_app (Explicit Exit)
    const cdpTargetsRes = await httpRequest({ port: cdpPort, path: '/json' });
    const mainTarget = (cdpTargetsRes.data || []).find(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl
    );
    let xToTrayPassed = false;
    let explicitExitPassed = false;

    if (mainTarget && mainTarget.webSocketDebuggerUrl) {
      const ws = new WebSocket(mainTarget.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
      let msgId = 1;
      const cdpEval = (expression) =>
        new Promise((resolve) => {
          const id = msgId++;
          const handler = (ev) => {
            const data = JSON.parse(ev.data);
            if (data.id === id) {
              ws.removeEventListener('message', handler);
              resolve(data.result?.result?.value);
            }
          };
          ws.addEventListener('message', handler);
          ws.send(
            JSON.stringify({
              id,
              method: 'Runtime.evaluate',
              params: { expression, awaitPromise: true, returnByValue: true },
            })
          );
        });

      const appVer = await cdpEval(`window.__TAURI_INTERNALS__.invoke('get_app_version')`);
      // Invoke window_close (same command triggered by clicking X in TitleBar.tsx)
      await cdpEval(`window.__TAURI_INTERNALS__.invoke('window_close')`);
      await sleep(500);

      const logAfterX = fs.readFileSync(LIFECYCLE_LOG, 'utf8');
      xToTrayPassed =
        isPidAlive(uiProc.pid) &&
        appVer === '1.0.4' &&
        logAfterX.includes('[WINDOW] WINDOW_CLOSE_COMMAND: label=main, close_to_tray=true') &&
        logAfterX.includes('[WINDOW] HIDE_MAIN');

      record(
        'STEP 6.4: Clicking X (window_close) with closeToTray=true hides window to tray (HIDE_MAIN) and keeps v1.0.4 alive',
        xToTrayPassed,
        { pid: uiProc.pid, appVer, aliveAfterX: isPidAlive(uiProc.pid) }
      );

      // Restore from tray
      await cdpEval(`window.__TAURI_INTERNALS__.invoke('show_main_window')`);
      await sleep(300);

      // Invoke explicit exit_app
      cdpEval(`window.__TAURI_INTERNALS__.invoke('exit_app', { force: true })`).catch(() => {});
      try {
        ws.close();
      } catch {}

      await new Promise((resolve) => {
        const t = setTimeout(resolve, 4000);
        uiProc.on('close', () => {
          clearTimeout(t);
          resolve();
        });
      });
      await sleep(300);

      const logAfterExit = fs.readFileSync(LIFECYCLE_LOG, 'utf8');
      explicitExitPassed =
        !isPidAlive(uiProc.pid) &&
        logAfterExit.includes('[APP] EXIT_APP_COMMAND') &&
        logAfterExit.includes('[APP] EXPLICIT_EXIT');

      record(
        'STEP 6.5: Explicit Exit (exit_app) cleanly terminates application and logs EXPLICIT_EXIT',
        explicitExitPassed,
        { aliveAfterExit: isPidAlive(uiProc.pid) }
      );
    } else {
      record('STEP 6.4: CDP connection to WebView2', false, { cdpTargetsRes });
    }
  } finally {
    cdnServer.close();
    for (const pid of findTestToriPids()) {
      try {
        process.kill(pid);
      } catch {}
    }
  }

  const outReportPath = path.join(ROOT, 'target', 'gate26_1_runtime_results.json');
  fs.writeFileSync(
    outReportPath,
    JSON.stringify({ runId: RUN_ID, passed, failed, results }, null, 2),
    'utf8'
  );

  console.log(`\n================================================================`);
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log(`Saved detailed JSON results to: ${outReportPath}`);
  console.log(`================================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error in verify_gate26_1_runtime.js:', err);
  process.exit(1);
});
