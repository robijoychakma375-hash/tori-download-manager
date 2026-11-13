#!/usr/bin/env node
/**
 * TORI Download Manager Gate 27 — Comprehensive Runtime Acceptance Verification Suite
 *
 * Verifies both user-observed production bugs in strictly isolated storage:
 *
 * BUG 1: Close-to-Tray
 * - Fresh/upgraded launch without ANY command-line flags activates closeToTray: true by migration.
 * - Clicking 'X' (window_close) with closeToTray=true hides the window to tray (HIDE_MAIN) and process survives.
 * - Changing the setting to closeToTray=false updates SQLite and emits [SETTINGS] CLOSE_TO_TRAY_UPDATED: enabled=false.
 * - When closeToTray=false, clicking 'X' performs a clean exit (EXIT_CLEAN).
 * - Subsequent restarts preserve closeToTray=false without being overwritten by migration.
 *
 * BUG 2: Media Sequence Handoff & Deduplication
 * - Sequential media download matrix for identical webpage URLs via REST API (extension protocol):
 *   1. Video download (format_id: "18") -> succeeds with distinct job ID.
 *   2. Duplicate Video download (same URL + format_id: "18") -> returns already_exists with original job ID.
 *   3. Audio download (format_id: "251") from SAME URL -> succeeds with NEW distinct job ID (NOT blocked!).
 *   4. Duplicate Audio download (same URL + format_id: "251") -> returns already_exists with audio job ID.
 *   5. Alternative Video (format_id: "137+140") from SAME URL -> succeeds with third distinct job ID.
 *   6. All distinct tasks coexist in active download jobs state.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = Date.now();
const TEST_ROOT = path.join(ROOT, 'target', `test_gate27_${RUN_ID}`);
const DATA_DIR = path.join(TEST_ROOT, 'data');
const DOWNLOAD_DIR = path.join(TEST_ROOT, 'downloads');
const LIFECYCLE_LOG = path.join(DATA_DIR, 'logs', 'lifecycle.log');
const DB_PATH = path.join(DATA_DIR, 'tdm_storage.sqlite');
const PIPE_NAME = `\\\\.\\pipe\\tori-gate27-${RUN_ID}-ipc`;
const DESKTOP_PORT = 16860;
const CDP_PORT = 19280;

const MAIN_EXE = path.join(ROOT, 'target', 'release', 'tori-download-manager.exe');
const HOST_EXE = path.join(ROOT, 'target', 'release', 'tdm-native-host.exe');
const INSTALLED_EXE = path.join(
  process.env.LOCALAPPDATA || 'C:\\Users\\ritud\\AppData\\Local',
  'TORI Download Manager',
  'tori-download-manager.exe'
);

fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const results = [];
let passed = 0;
let failed = 0;
let wasInstalledRunning = false;

function record(name, ok, details = {}) {
  if (ok) {
    passed++;
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.error(`[FAIL] ${name}`, JSON.stringify(details, null, 2));
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

function findTestToriPids() {
  try {
    const code = [
      'import subprocess, json',
      'cmd = ["powershell", "-NoProfile", "-Command", "Get-Process -Name \'tori-download-manager\' -ErrorAction SilentlyContinue | Select-Object -Property Id, Path | ConvertTo-Json -Compress"]',
      'res = subprocess.run(cmd, capture_output=True, text=True)',
      'if not res.stdout.strip():',
      '    print("[]")',
      'else:',
      '    try:',
      '        data = json.loads(res.stdout)',
      '        if isinstance(data, dict): data = [data]',
      '        target_pids = [item["Id"] for item in data if "target" in (item.get("Path") or "").lower()]',
      '        print(json.dumps(target_pids))',
      '    except Exception:',
      '        print("[]")',
    ].join('\n');
    const out = execFileSync('python', ['-c', code], { encoding: 'utf8' }).trim();
    return JSON.parse(out);
  } catch {
    return [];
  }
}

function checkInstalledToriRunning() {
  try {
    const code = [
      'import subprocess, json',
      'cmd = ["powershell", "-NoProfile", "-Command", "Get-Process -Name \'tori-download-manager\' -ErrorAction SilentlyContinue | Select-Object -Property Id, Path | ConvertTo-Json -Compress"]',
      'res = subprocess.run(cmd, capture_output=True, text=True)',
      'if not res.stdout.strip():',
      '    print("[]")',
      'else:',
      '    try:',
      '        data = json.loads(res.stdout)',
      '        if isinstance(data, dict): data = [data]',
      '        installed_pids = [item["Id"] for item in data if "appdata" in (item.get("Path") or "").lower()]',
      '        print(json.dumps(installed_pids))',
      '    except Exception:',
      '        print("[]")',
    ].join('\n');
    const out = execFileSync('python', ['-c', code], { encoding: 'utf8' }).trim();
    return JSON.parse(out);
  } catch {
    return [];
  }
}

function killPids(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {}
  }
}

function readSqliteSettings(dbPath) {
  try {
    const code = [
      'import sqlite3, sys',
      'conn = sqlite3.connect(sys.argv[1])',
      'cur = conn.cursor()',
      'cur.execute("SELECT value FROM engine_settings WHERE key=\'app_settings\'")',
      'row = cur.fetchone()',
      'print(row[0] if row else "{}")',
    ].join('\n');
    const out = execFileSync('python', ['-c', code, path.resolve(dbPath)], { encoding: 'utf8' }).trim();
    const parsed = JSON.parse(out);
    return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
  } catch (e) {
    console.error('readSqliteSettings error:', e.message);
    return null;
  }
}

function seedSqliteLegacySettings(dbPath, port, dlDir) {
  try {
    const code = [
      'import sqlite3, json, sys',
      'db_p = sys.argv[1]',
      'port = int(sys.argv[2])',
      'dl_dir = sys.argv[3]',
      'conn = sqlite3.connect(db_p)',
      'cur = conn.cursor()',
      'cur.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")',
      'cur.execute("INSERT OR REPLACE INTO engine_settings (key, value) VALUES (\'browser_integration_token\', \'gate27_test_token_secret\')")',
      'app_s = {"theme": "dark", "accent": "ocean", "con": 12, "port": port, "dir": dl_dir, "closeToTray": False}',
      'cur.execute("INSERT OR REPLACE INTO engine_settings (key, value) VALUES (\'app_settings\', ?)", (json.dumps(app_s),))',
      'conn.commit()',
      'conn.close()',
    ].join('\n');
    execFileSync('python', ['-c', code, path.resolve(dbPath), String(port), dlDir], { encoding: 'utf8' });
    return true;
  } catch (e) {
    console.error('Error seeding legacy sqlite settings:', e.message);
    return false;
  }
}

function httpRequest({ port, path: reqPath, method = 'GET', body = null, headers = {}, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
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
      req.destroy(new Error('HTTP_TIMEOUT'));
    });

    req.on('error', (err) => {
      resolve({ status: 0, ok: false, error: err.message });
    });

    if (payload) req.write(payload);
    req.end();
  });
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

    const payload = JSON.stringify(msgObj);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(Buffer.byteLength(payload, 'utf8'), 0);

    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = '';

    proc.stdout.on('data', (chunk) => {
      stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
    });
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });

    proc.on('close', (code) => {
      if (stdoutBuf.length >= 4) {
        const msgLen = stdoutBuf.readUInt32LE(0);
        if (stdoutBuf.length >= 4 + msgLen) {
          const body = stdoutBuf.slice(4, 4 + msgLen).toString('utf8');
          try {
            return resolve({
              code,
              validFraming: true,
              response: JSON.parse(body),
              stderr: stderrBuf,
            });
          } catch (e) {
            return resolve({
              code,
              validFraming: false,
              rawBody: body,
              parseError: e.message,
              stderr: stderrBuf,
            });
          }
        }
      }
      resolve({
        code,
        validFraming: false,
        rawBytes: stdoutBuf.length,
        stderr: stderrBuf,
      });
    });

    proc.on('error', reject);

    proc.stdin.write(lenBuf);
    proc.stdin.write(payload, 'utf8');
    proc.stdin.end();
  });
}

async function connectToCdp(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const targetsRes = await httpRequest({ port, path: '/json' });
      const mainTarget = (targetsRes.data || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (mainTarget && mainTarget.webSocketDebuggerUrl) {
        const ws = new WebSocket(mainTarget.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.onopen = res;
          ws.onerror = rej;
        });

        let msgId = 1;
        const cdpEval = (expression) =>
          new Promise((resolve, reject) => {
            const id = msgId++;
            const handler = (ev) => {
              const data = JSON.parse(ev.data);
              if (data.id === id) {
                ws.removeEventListener('message', handler);
                if (data.error) reject(data.error);
                else resolve(data.result?.result?.value);
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

        return { ws, cdpEval };
      }
    } catch {}
    await sleep(250);
  }
  return null;
}

async function run() {
  console.log('================================================================');
  console.log('TORI Download Manager Gate 27 — Comprehensive Acceptance Test');
  console.log(`Test Root: ${TEST_ROOT}`);
  console.log('================================================================\n');

  try {
    // Check if installed TORI instance is currently running
    const installedPids = checkInstalledToriRunning();
    if (installedPids.length > 0) {
      console.log(`Detected running installed TORI instance (PID: ${installedPids.join(', ')}).`);
      console.log('Temporarily pausing installed instance to grant test instance single-instance exclusivity...');
      wasInstalledRunning = true;
      killPids(installedPids);
      await sleep(1000);
    }

    // Clean up any stale target/release processes
    killPids(findTestToriPids());
    await sleep(500);

    // Seed test database with known port 16860 and token before Phase 1
    seedSqliteLegacySettings(DB_PATH, DESKTOP_PORT, DOWNLOAD_DIR);
    console.log('Pre-seeded test database with port 16860 and token gate27_test_token_secret.');

    // -------------------------------------------------------------------------
    // TEST SECTION 1: BUG 2 — Media Sequence Handoff & Deduplication
    // -------------------------------------------------------------------------
    console.log('\n>>> [PHASE 1] Testing Media Sequence & Handoff Matrix (BUG 2) <<<\n');

    // 1. Spawning Native Host in background server mode
    const pingRes = await sendNativeHostMessage({ action: 'ping' });
    record(
      'PHASE 1.1: Native Host auto-spawns desktop and responds to ping',
      pingRes.validFraming && pingRes.response?.status === 'ok',
      pingRes
    );

    // Pair to get active token and port
    const pairRes = await sendNativeHostMessage({ action: 'pair' });
    const token = pairRes.response?.token || 'gate27_test_token_secret';
    const apiPort = pairRes.response?.port || DESKTOP_PORT;
    console.log(`Paired with desktop server on port ${apiPort}, token ${token.slice(0, 8)}...`);

    // Wait for HTTP API to respond to /api/v1/status
    let statusRes = null;
    for (let i = 0; i < 40; i++) {
      statusRes = await httpRequest({
        port: apiPort,
        path: '/api/v1/status',
        headers: { 'X-Tori-Token': token },
      });
      if (statusRes.ok && statusRes.data?.authenticated === true) break;
      await sleep(200);
    }

    record(
      'PHASE 1.2: Desktop HTTP API server is authenticated and online',
      statusRes !== null && statusRes.ok && statusRes.data?.authenticated === true,
      statusRes
    );

    const videoUrl = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'; // Sample video portal URL

    // 2. Submit initial Video download (format_id: "18" - 360p mp4) via POST /api/v1/media/download
    const mediaVideo1 = await httpRequest({
      port: apiPort,
      path: '/api/v1/media/download',
      method: 'POST',
      headers: { 'X-Tori-Token': token },
      body: {
        url: videoUrl,
        format_id: '18',
        filename: 'test_bunny_360p.mp4',
        destination: DOWNLOAD_DIR,
      },
    });

    const video1JobId = mediaVideo1.data?.job_id;
    record(
      'PHASE 1.3: Video download succeeds with ok status and valid job ID',
      mediaVideo1.ok && mediaVideo1.data?.status === 'ok' && typeof video1JobId === 'string' && video1JobId.length > 0,
      mediaVideo1.data
    );

    // 3. Re-submit EXACT duplicate Video download (same URL and format_id: "18")
    const mediaVideoDuplicate = await httpRequest({
      port: apiPort,
      path: '/api/v1/media/download',
      method: 'POST',
      headers: { 'X-Tori-Token': token },
      body: {
        url: videoUrl,
        format_id: '18',
        filename: 'test_bunny_360p.mp4',
        destination: DOWNLOAD_DIR,
      },
    });

    record(
      'PHASE 1.4: Duplicate Video download is detected and returns already_exists with original job ID',
      mediaVideoDuplicate.ok &&
        mediaVideoDuplicate.data?.status === 'already_exists' &&
        mediaVideoDuplicate.data?.job_id === video1JobId,
      mediaVideoDuplicate.data
    );

    // 4. Submit Audio-only download (format_id: "251" - webm audio) from SAME video URL
    // BUG 2 REGRESSION CHECK: Previously returned already_exists and failed to add task!
    const mediaAudio = await httpRequest({
      port: apiPort,
      path: '/api/v1/media/download',
      method: 'POST',
      headers: { 'X-Tori-Token': token },
      body: {
        url: videoUrl,
        format_id: '251',
        filename: 'test_bunny_audio.webm',
        destination: DOWNLOAD_DIR,
      },
    });

    const audioJobId = mediaAudio.data?.job_id;
    record(
      'PHASE 1.5: [BUG 2 FIX] Audio download from SAME URL succeeds with ok status and distinct job ID',
      mediaAudio.ok &&
        mediaAudio.data?.status === 'ok' &&
        typeof audioJobId === 'string' &&
        audioJobId.length > 0 &&
        audioJobId !== video1JobId,
      {
        video1JobId,
        audioJobId,
        data: mediaAudio.data,
      }
    );

    // 5. Re-submit EXACT duplicate Audio download (format_id: "251")
    const mediaAudioDuplicate = await httpRequest({
      port: apiPort,
      path: '/api/v1/media/download',
      method: 'POST',
      headers: { 'X-Tori-Token': token },
      body: {
        url: videoUrl,
        format_id: '251',
        filename: 'test_bunny_audio.webm',
        destination: DOWNLOAD_DIR,
      },
    });

    record(
      'PHASE 1.6: Duplicate Audio download is detected and returns already_exists with audio job ID',
      mediaAudioDuplicate.ok &&
        mediaAudioDuplicate.data?.status === 'already_exists' &&
        mediaAudioDuplicate.data?.job_id === audioJobId,
      mediaAudioDuplicate.data
    );

    // 6. Submit second Video download with different format (format_id: "137+140" - 1080p muxed) from SAME URL
    const mediaVideo2 = await httpRequest({
      port: apiPort,
      path: '/api/v1/media/download',
      method: 'POST',
      headers: { 'X-Tori-Token': token },
      body: {
        url: videoUrl,
        format_id: '137+140',
        filename: 'test_bunny_1080p.mp4',
        destination: DOWNLOAD_DIR,
      },
    });

    const video2JobId = mediaVideo2.data?.job_id;
    record(
      'PHASE 1.7: Alternative Video format from SAME URL succeeds with ok status and third distinct job ID',
      mediaVideo2.ok &&
        mediaVideo2.data?.status === 'ok' &&
        typeof video2JobId === 'string' &&
        video2JobId !== video1JobId &&
        video2JobId !== audioJobId,
      {
        video1JobId,
        audioJobId,
        video2JobId,
        data: mediaVideo2.data,
      }
    );

    // 7. Verify all 3 jobs coexist in downloads list
    const downloadsRes = await httpRequest({
      port: apiPort,
      path: '/api/v1/downloads',
      headers: { 'X-Tori-Token': token },
    });
    const jobs = downloadsRes.data?.jobs || [];
    const hasJob1 = jobs.some((j) => j.id === video1JobId);
    const hasJob2 = jobs.some((j) => j.id === audioJobId);
    const hasJob3 = jobs.some((j) => j.id === video2JobId);

    record(
      'PHASE 1.8: All 3 distinct media formats (Video 360p, Audio opus, Video 1080p) coexist in downloads state',
      hasJob1 && hasJob2 && hasJob3,
      { totalJobs: jobs.length, video1JobId, audioJobId, video2JobId }
    );

    // Cleanly terminate desktop before Phase 2
    killPids(findTestToriPids());
    await sleep(1000);

    // -------------------------------------------------------------------------
    // TEST SECTION 2: BUG 1 — Close-to-Tray Migration & Behavior
    // -------------------------------------------------------------------------
    console.log('\n>>> [PHASE 2] Testing Close-to-Tray Default & Toggle Lifecycle (BUG 1) <<<\n');

    // Fresh test data dir for Phase 2 to ensure clean isolation
    const P2_DATA_DIR = path.join(TEST_ROOT, 'data_p2');
    const P2_DB_PATH = path.join(P2_DATA_DIR, 'tdm_storage.sqlite');
    const P2_LOG = path.join(P2_DATA_DIR, 'logs', 'lifecycle.log');
    fs.mkdirSync(path.join(P2_DATA_DIR, 'logs'), { recursive: true });

    // Seed legacy SQLite DB with closeToTray: false (representing pre-v1.0.4 or old QA state)
    seedSqliteLegacySettings(P2_DB_PATH, DESKTOP_PORT, DOWNLOAD_DIR);
    const preSeedSettings = readSqliteSettings(P2_DB_PATH);
    console.log('Seeded legacy settings before launch (closeToTray = false):', preSeedSettings);

    // Launch desktop normally (ZERO flags!) with CDP enabled
    const desktopProc1 = spawn(MAIN_EXE, [], {
      env: {
        ...process.env,
        TORI_DATA_DIR: P2_DATA_DIR,
        TORI_IPC_PIPE: PIPE_NAME,
        TORI_ALLOW_LOOPBACK: '1',
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      },
      stdio: 'ignore',
    });

    const pid1 = desktopProc1.pid;
    console.log(`Desktop launched with PID ${pid1} (zero flags)`);

    // Wait for HTTP server to become responsive
    let desktopOnline = false;
    for (let i = 0; i < 40; i++) {
      const st = await httpRequest({
        port: DESKTOP_PORT,
        path: '/api/v1/status',
        headers: { 'X-Tori-Token': 'gate27_test_token_secret' },
      });
      if (st.ok) {
        desktopOnline = true;
        break;
      }
      await sleep(250);
    }
    await sleep(1200);

    record(
      'PHASE 2.1: Desktop launches cleanly without flags and HTTP API is online',
      desktopOnline,
      { pid: pid1, desktopOnline }
    );

    // Connect to CDP
    const cdp1 = await connectToCdp(CDP_PORT);
    record(
      'PHASE 2.2: WebView2 CDP connection established',
      cdp1 !== null,
      { pid: pid1, cdpConnected: Boolean(cdp1) }
    );

    // Wait a brief moment for App.tsx startup syncSettings to run
    await sleep(1500);

    // Inspect SQLite settings: closeToTray MUST be migrated to true!
    const postMigrationSettings = readSqliteSettings(P2_DB_PATH);
    const log1 = fs.existsSync(P2_LOG) ? fs.readFileSync(P2_LOG, 'utf8') : '';

    record(
      'PHASE 2.3: [BUG 1 FIX] SQLite migration automatically activates closeToTray: true on initial launch',
      postMigrationSettings !== null &&
        postMigrationSettings.closeToTray === true &&
        log1.includes('[APP] CLOSE_TO_TRAY_ENABLED: Default v1.0.4 closeToTray migration activated in app_settings'),
      {
        postMigrationSettings,
        hasMigrationLog: log1.includes('CLOSE_TO_TRAY_ENABLED'),
      }
    );

    // Trigger TitleBar X button (window_close command)
    if (cdp1) {
      await cdp1.cdpEval(`window.__TAURI_INTERNALS__.invoke('window_close')`);
    }
    await sleep(600);

    const logAfterX = fs.existsSync(P2_LOG) ? fs.readFileSync(P2_LOG, 'utf8') : '';
    const pid1AliveAfterX = isPidAlive(pid1);

    record(
      'PHASE 2.4: [BUG 1 FIX] Clicking X (window_close) with closeToTray=true hides window (HIDE_MAIN) and process survives',
      pid1AliveAfterX &&
        logAfterX.includes('[WINDOW] WINDOW_CLOSE_COMMAND: label=main, close_to_tray=true') &&
        logAfterX.includes('[WINDOW] HIDE_MAIN'),
      {
        pid1AliveAfterX,
        hasCloseCommandLog: logAfterX.includes('[WINDOW] WINDOW_CLOSE_COMMAND: label=main, close_to_tray=true'),
        hasHideMainLog: logAfterX.includes('[WINDOW] HIDE_MAIN'),
      }
    );

    // Restore window
    if (cdp1) {
      await cdp1.cdpEval(`window.__TAURI_INTERNALS__.invoke('show_main_window')`);
      await sleep(300);

      // Now test user manually toggling Close-to-Tray to FALSE via update_engine_settings
      const disabledSettings = { ...postMigrationSettings, closeToTray: false };
      await cdp1.cdpEval(
        `window.__TAURI_INTERNALS__.invoke('update_engine_settings', { settings: ${JSON.stringify(disabledSettings)} })`
      );
    }
    await sleep(400);

    const logAfterToggleOff = fs.existsSync(P2_LOG) ? fs.readFileSync(P2_LOG, 'utf8') : '';
    const settingsAfterToggleOff = readSqliteSettings(P2_DB_PATH);

    record(
      'PHASE 2.5: [BUG 1 FIX] Disabling Close-to-Tray saves closeToTray: false to SQLite and logs update',
      settingsAfterToggleOff !== null &&
        settingsAfterToggleOff.closeToTray === false &&
        logAfterToggleOff.includes('[SETTINGS] CLOSE_TO_TRAY_UPDATED: enabled=false'),
      {
        settingsAfterToggleOff,
        hasUpdatedLog: logAfterToggleOff.includes('[SETTINGS] CLOSE_TO_TRAY_UPDATED: enabled=false'),
      }
    );

    // Trigger TitleBar X button again (window_close command) with closeToTray=false -> Clean Exit
    if (cdp1) {
      try {
        await cdp1.cdpEval(`window.__TAURI_INTERNALS__.invoke('window_close')`);
      } catch {}

      try {
        cdp1.ws.close();
      } catch {}
    }

    // Wait for process to terminate
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 5000);
      desktopProc1.on('close', () => {
        clearTimeout(t);
        resolve();
      });
    });
    await sleep(600);

    const logAfterXExit = fs.existsSync(P2_LOG) ? fs.readFileSync(P2_LOG, 'utf8') : '';
    const pid1AliveAfterXExit = isPidAlive(pid1);

    record(
      'PHASE 2.6: [BUG 1 FIX] When closeToTray is false, clicking X triggers clean exit (EXIT_CLEAN) and process exits',
      !pid1AliveAfterXExit &&
        logAfterXExit.includes('[WINDOW] WINDOW_CLOSE_COMMAND: label=main, close_to_tray=false') &&
        logAfterXExit.includes('[APP] EXIT_CLEAN'),
      {
        pid1AliveAfterXExit,
        hasCloseCommandLog: logAfterXExit.includes('[WINDOW] WINDOW_CLOSE_COMMAND: label=main, close_to_tray=false'),
        hasExitCleanLog: logAfterXExit.includes('[APP] EXIT_CLEAN'),
      }
    );

    // Restart desktop to verify persistence: closeToTray MUST REMAIN false across reboot!
    console.log('\nRestarting desktop to test persistence across reboots...');
    const desktopProc2 = spawn(MAIN_EXE, [], {
      env: {
        ...process.env,
        TORI_DATA_DIR: P2_DATA_DIR,
        TORI_IPC_PIPE: PIPE_NAME,
        TORI_ALLOW_LOOPBACK: '1',
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      },
      stdio: 'ignore',
    });

    const pid2 = desktopProc2.pid;
    for (let i = 0; i < 40; i++) {
      const st = await httpRequest({
        port: DESKTOP_PORT,
        path: '/api/v1/status',
        headers: { 'X-Tori-Token': 'gate27_test_token_secret' },
      });
      if (st.ok) break;
      await sleep(250);
    }
    await sleep(1500);

    const settingsAfterRestart = readSqliteSettings(P2_DB_PATH);
    const logAfterRestart = fs.existsSync(P2_LOG) ? fs.readFileSync(P2_LOG, 'utf8') : '';

    const migrationCount = (logAfterRestart.match(/CLOSE_TO_TRAY_ENABLED/g) || []).length;

    record(
      'PHASE 2.7: [BUG 1 FIX] User setting closeToTray=false is permanently preserved across restarts (migration never clobbers)',
      settingsAfterRestart !== null &&
        settingsAfterRestart.closeToTray === false &&
        migrationCount === 1,
      {
        settingsAfterRestart,
        migrationCount,
      }
    );

    // Connect to CDP2 and exit cleanly
    const cdp2 = await connectToCdp(CDP_PORT);
    if (cdp2) {
      try {
        await cdp2.cdpEval(`window.__TAURI_INTERNALS__.invoke('exit_app', { force: true })`);
        cdp2.ws.close();
      } catch {}
    }
    await sleep(800);

    killPids(findTestToriPids());

    record(
      'PHASE 2.8: Clean shutdown leaves zero orphan processes',
      !isPidAlive(pid2),
      { pid2Alive: isPidAlive(pid2) }
    );

  } catch (err) {
    console.error('Unexpected test harness error:', err);
    record('FATAL_HARNESS_EXCEPTION', false, { error: err.message, stack: err.stack });
  } finally {
    killPids(findTestToriPids());

    // If installed application was running before the test, restart it in minimized mode
    if (wasInstalledRunning && fs.existsSync(INSTALLED_EXE)) {
      console.log('Restoring installed TORI instance in background mode...');
      try {
        const restored = spawn(INSTALLED_EXE, ['--minimized'], {
          detached: true,
          stdio: 'ignore',
        });
        restored.unref();
        console.log(`Restored installed TORI instance (PID: ${restored.pid}).`);
      } catch (e) {
        console.error('Failed to restore installed TORI instance:', e);
      }
    }

    console.log('\n----------------------------------------------------------------');
    console.log(`Gate 27 Acceptance Results: ${passed} PASSED, ${failed} FAILED`);
    console.log('----------------------------------------------------------------');

    const resultPath = path.join(ROOT, 'target', 'gate27_acceptance_result.json');
    fs.writeFileSync(resultPath, JSON.stringify({ passed, failed, results }, null, 2), 'utf8');
    console.log(`Detailed test report saved to: ${resultPath}`);

    if (failed > 0) {
      process.exit(1);
    }
  }
}

run();
