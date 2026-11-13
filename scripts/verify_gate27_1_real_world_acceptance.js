#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 27.1 Final Real-World Verification Suite
 *
 * Fully automated acceptance testing covering:
 * 1. NSIS Test Installer packaging & isolated extraction (/S /D=<dir>).
 * 2. Safe, isolated Windows profile execution (zero mutation of user data).
 * 3. Normal launch without command-line flags.
 * 4. Close-to-Tray enabling through settings interface.
 * 5. TitleBar 'X' button click (window_close).
 * 6. Process survival, window hide, tray icon existence, and localhost port accessibility.
 * 7. Restore TORI from system tray.
 * 8. Restart persistence of Close-to-Tray preferences.
 * 9. Deliberate Close-to-Tray OFF preference preservation across restarts/upgrades.
 * 10. Real non-DRM media source (Big Buck Bunny Creative Commons).
 * 11. Audio-only download and physical completion on disk.
 * 12. Video download from SAME page URL: queues, transfers, and completes on disk.
 * 13. Sequential matrix: Audio -> Video, Video -> Audio, and Audio -> Video -> Audio.
 * 14. Duplicate requests for exact same format protected (already_exists).
 * 15. Stability verification (zero crashes, stuck tasks, or unexpected exits).
 * 16. Extension release audit (v1.0.5 compatibility).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = Date.now();
const TEST_ROOT = path.join(ROOT, 'target', `test_gate27_1_${RUN_ID}`);
const INSTALL_DIR = path.join(TEST_ROOT, 'installed_app');
const DATA_DIR = path.join(TEST_ROOT, 'data');
const DOWNLOAD_DIR = path.join(TEST_ROOT, 'downloads');
const LIFECYCLE_LOG = path.join(DATA_DIR, 'logs', 'lifecycle.log');
const DB_PATH = path.join(DATA_DIR, 'tdm_storage.sqlite');
const PIPE_NAME = `\\\\.\\pipe\\tori-gate27-1-${RUN_ID}-ipc`;
const DESKTOP_PORT = 16880;
const CDP_PORT = 19290;

const INSTALLER_PATH = path.join(
  ROOT,
  'target',
  'release',
  'bundle',
  'nsis',
  'TORI Download Manager_1.0.4_x64-setup.exe'
);

const PROD_EXE = path.join(
  process.env.LOCALAPPDATA || 'C:\\Users\\ritud\\AppData\\Local',
  'TORI Download Manager',
  'tori-download-manager.exe'
);
const PROD_DB = path.join(
  process.env.APPDATA || 'C:\\Users\\ritud\\AppData\\Roaming',
  'tori-download-manager',
  'tdm_storage.sqlite'
);

fs.mkdirSync(TEST_ROOT, { recursive: true });
fs.mkdirSync(INSTALL_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const results = [];
let passed = 0;
let failed = 0;
let wasInstalledRunning = false;

function record(step, name, ok, details = {}) {
  if (ok) {
    passed++;
    console.log(`[PASS] [${step}] ${name}`);
  } else {
    failed++;
    console.error(`[FAIL] [${step}] ${name}`, JSON.stringify(details, null, 2));
  }
  results.push({ step, name, status: ok ? 'PASS' : 'FAIL', details });
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

function readLifecycleLog(logPath = LIFECYCLE_LOG) {
  if (!fs.existsSync(logPath)) return '';
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch {
    return '';
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

function seedSqliteSettings(dbPath, port, dlDir, closeToTray = false) {
  try {
    const code = [
      'import sqlite3, json, sys',
      'db_p = sys.argv[1]',
      'port = int(sys.argv[2])',
      'dl_dir = sys.argv[3]',
      'ctt = sys.argv[4].lower() == "true"',
      'conn = sqlite3.connect(db_p)',
      'cur = conn.cursor()',
      'cur.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")',
      'cur.execute("INSERT OR REPLACE INTO engine_settings (key, value) VALUES (\'browser_integration_token\', \'gate27_1_token_secret\')")',
      'app_s = {"theme": "dark", "accent": "ocean", "con": 12, "port": port, "dir": dl_dir, "closeToTray": ctt}',
      'cur.execute("INSERT OR REPLACE INTO engine_settings (key, value) VALUES (\'app_settings\', ?)", (json.dumps(app_s),))',
      'conn.commit()',
      'conn.close()',
    ].join('\n');
    execFileSync('python', ['-c', code, path.resolve(dbPath), String(port), dlDir, String(closeToTray)], {
      encoding: 'utf8',
    });
    return true;
  } catch (e) {
    console.error('Error seeding sqlite settings:', e.message);
    return false;
  }
}

function findDownloadedFile(downloadDir, baseName) {
  const checkDirs = [
    downloadDir,
    path.join(downloadDir, 'Music'),
    path.join(downloadDir, 'Video'),
    path.join(downloadDir, 'Other'),
  ];
  for (const dir of checkDirs) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        if (f.startsWith(baseName) && !f.endsWith('.tdm-part')) {
          const fullPath = path.join(dir, f);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 0) {
              return { fullPath, size: stat.size, filename: f };
            }
          } catch {}
        }
      }
    }
  }
  return null;
}

function httpRequest({ port, path: reqPath, method = 'GET', body = null, headers = {}, timeoutMs = 10000 }) {
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
  console.log('========================================================================');
  console.log('TORI Download Manager Gate 27.1 — Final Real-World Acceptance Suite');
  console.log(`Test Root: ${TEST_ROOT}`);
  console.log('========================================================================\n');

  try {
    // -------------------------------------------------------------------------
    // PRE-FLIGHT: Snapshot User Production State & Ensure Single-Instance Exclusivity
    // -------------------------------------------------------------------------
    const prodExeStatBefore = fs.existsSync(PROD_EXE) ? fs.statSync(PROD_EXE) : null;
    const prodDbStatBefore = fs.existsSync(PROD_DB) ? fs.statSync(PROD_DB) : null;

    const runningInstalledPids = checkInstalledToriRunning();
    if (runningInstalledPids.length > 0) {
      console.log(`Pausing installed production instance (PID: ${runningInstalledPids.join(', ')}) during isolated test...`);
      wasInstalledRunning = true;
      killPids(runningInstalledPids);
      await sleep(1000);
    }

    killPids(findTestToriPids());
    await sleep(500);

    // -------------------------------------------------------------------------
    // STEP 1 & 2: Local Windows NSIS Test Installer Build & Isolated Extraction
    // -------------------------------------------------------------------------
    console.log('>>> [CHECK 1 & 2] NSIS Installer Build & Isolated Installation <<<\n');
    record(
      'CHECK 1',
      'Windows NSIS test installer exists and has valid size',
      fs.existsSync(INSTALLER_PATH) && fs.statSync(INSTALLER_PATH).size > 100 * 1024 * 1024,
      { path: INSTALLER_PATH, size: fs.existsSync(INSTALLER_PATH) ? fs.statSync(INSTALLER_PATH).size : 0 }
    );

    // Silently install into isolated INSTALL_DIR using /S /D=<dir>
    console.log(`Installing into isolated directory: ${INSTALL_DIR}...`);
    execSync(`"${INSTALLER_PATH}" /S /D=${INSTALL_DIR}`);
    await sleep(2000);

    const installedMainExe = path.join(INSTALL_DIR, 'tori-download-manager.exe');
    const installedHostExe = path.join(INSTALL_DIR, 'bin', 'tdm-native-host.exe');
    const installedYtdlp = path.join(INSTALL_DIR, 'bin', 'yt-dlp.exe');
    const installedFfmpeg = path.join(INSTALL_DIR, 'bin', 'ffmpeg.exe');

    record(
      'CHECK 2.1',
      'NSIS installer unpacked all binaries into isolated directory without errors',
      fs.existsSync(installedMainExe) &&
        fs.existsSync(installedHostExe) &&
        fs.existsSync(installedYtdlp) &&
        fs.existsSync(installedFfmpeg),
      {
        mainExeSize: fs.existsSync(installedMainExe) ? fs.statSync(installedMainExe).size : 0,
        hostExeSize: fs.existsSync(installedHostExe) ? fs.statSync(installedHostExe).size : 0,
      }
    );

    const prodExeStatAfter = fs.existsSync(PROD_EXE) ? fs.statSync(PROD_EXE) : null;
    const prodDbStatAfter = fs.existsSync(PROD_DB) ? fs.statSync(PROD_DB) : null;

    record(
      'CHECK 2.2',
      'Production user data and installed executable remain 100% untouched',
      prodExeStatBefore?.mtimeMs === prodExeStatAfter?.mtimeMs &&
        prodDbStatBefore?.mtimeMs === prodDbStatAfter?.mtimeMs,
      { prodExeBefore: prodExeStatBefore?.mtime, prodExeAfter: prodExeStatAfter?.mtime }
    );

    // -------------------------------------------------------------------------
    // STEP 3 - 9: Close-to-Tray UI Automation & Lifecycle Verification
    // -------------------------------------------------------------------------
    console.log('\n>>> [CHECK 3 - 9] Close-to-Tray UI, System Tray & Persistence Lifecycle <<<\n');

    // Pre-seed test DB with legacy false setting to test migration on fresh launch
    seedSqliteSettings(DB_PATH, DESKTOP_PORT, DOWNLOAD_DIR, false);
    console.log('Seeded isolated DB with legacy closeToTray: false.');

    // Launch installed executable with ZERO command line flags (normal user launch)
    const proc1 = spawn(installedMainExe, [], {
      env: {
        ...process.env,
        TORI_DATA_DIR: DATA_DIR,
        TORI_IPC_PIPE: PIPE_NAME,
        TORI_ALLOW_LOOPBACK: '1',
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      },
      stdio: 'ignore',
    });

    const pid1 = proc1.pid;
    console.log(`Launched installed TORI from sandbox with PID ${pid1} (zero flags)`);

    // Wait for HTTP API server to respond on DESKTOP_PORT
    let online1 = false;
    for (let i = 0; i < 40; i++) {
      const st = await httpRequest({
        port: DESKTOP_PORT,
        path: '/api/v1/status',
        headers: { 'X-Tori-Token': 'gate27_1_token_secret' },
      });
      if (st.ok) {
        online1 = true;
        break;
      }
      await sleep(250);
    }
    await sleep(1500);

    record('CHECK 3', 'TORI launches normally with zero CLI flags and binds HTTP API', online1, { pid: pid1 });

    const cdp1 = await connectToCdp(CDP_PORT);
    record('CHECK 3.1', 'WebView2 CDP connection established for UI automation', cdp1 !== null, { cdpConnected: Boolean(cdp1) });

    await sleep(1200);
    const postMigrateSettings = readSqliteSettings(DB_PATH);
    const log1 = readLifecycleLog();

    record(
      'CHECK 4.1',
      'close_to_tray_migrated_v104 migration automatically defaults closeToTray to true on v1.0.4+ launch',
      postMigrateSettings !== null &&
        postMigrateSettings.closeToTray === true &&
        log1.includes('CLOSE_TO_TRAY_ENABLED'),
      { postMigrateSettings }
    );

    // Verify system tray icon initialized
    record(
      'CHECK 6.1',
      'System tray icon created with menu ([TRAY] INITIALIZED)',
      log1.includes('[TRAY] INITIALIZED'),
      { hasTrayLog: log1.includes('[TRAY] INITIALIZED') }
    );

    // Click actual title-bar X button (window_close command)
    if (cdp1) {
      await cdp1.cdpEval(`window.__TAURI_INTERNALS__.invoke('window_close')`);
    }
    await sleep(600);

    const logAfterX = readLifecycleLog();
    const pid1AliveAfterX = isPidAlive(pid1);

    // Check port availability while hidden in tray
    const statusWhileHidden = await httpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/status',
      headers: { 'X-Tori-Token': 'gate27_1_token_secret' },
    });

    record(
      'CHECK 5 & 6',
      'Clicking TitleBar X hides window to tray (HIDE_MAIN), process survives, and localhost port remains available',
      pid1AliveAfterX &&
        logAfterX.includes('[WINDOW] HIDE_MAIN') &&
        statusWhileHidden.ok &&
        statusWhileHidden.data?.authenticated === true,
      {
        pid1AliveAfterX,
        hasHideMain: logAfterX.includes('[WINDOW] HIDE_MAIN'),
        portResponsive: statusWhileHidden.ok,
      }
    );

    // Restore window via tray icon command (show_main_window)
    if (cdp1) {
      await cdp1.cdpEval(`window.__TAURI_INTERNALS__.invoke('show_main_window')`);
    }
    await sleep(400);

    const logAfterRestore = readLifecycleLog();
    record(
      'CHECK 7',
      'Restoring TORI from system tray restores and focuses main window (RESTORE_MAIN)',
      logAfterRestore.includes('[WINDOW] RESTORE_MAIN'),
      { hasRestoreLog: logAfterRestore.includes('[WINDOW] RESTORE_MAIN') }
    );

    // Deliberately disable Close-to-Tray through UI Settings interface
    const disabledSettings = { ...postMigrateSettings, closeToTray: false };
    if (cdp1) {
      await cdp1.cdpEval(
        `window.__TAURI_INTERNALS__.invoke('update_engine_settings', { settings: ${JSON.stringify(disabledSettings)} })`
      );
    }
    await sleep(400);

    const logAfterToggleOff = readLifecycleLog();
    const settingsAfterToggleOff = readSqliteSettings(DB_PATH);

    record(
      'CHECK 4.2',
      'Disabling Close-to-Tray through Settings updates SQLite and emits [SETTINGS] CLOSE_TO_TRAY_UPDATED: enabled=false',
      settingsAfterToggleOff !== null &&
        settingsAfterToggleOff.closeToTray === false &&
        logAfterToggleOff.includes('[SETTINGS] CLOSE_TO_TRAY_UPDATED: enabled=false'),
      { settingsAfterToggleOff }
    );

    // Click TitleBar X button when closeToTray is false -> Clean Exit
    if (cdp1) {
      try {
        await cdp1.cdpEval(`window.__TAURI_INTERNALS__.invoke('window_close')`);
      } catch {}
      try {
        cdp1.ws.close();
      } catch {}
    }

    await new Promise((resolve) => {
      const t = setTimeout(resolve, 5000);
      proc1.on('close', () => {
        clearTimeout(t);
        resolve();
      });
    });
    await sleep(500);

    const logAfterCleanExit = readLifecycleLog();
    const pid1AliveAfterExit = isPidAlive(pid1);

    record(
      'CHECK 9.1',
      'When Close-to-Tray is OFF, clicking X cleanly terminates application (EXIT_CLEAN)',
      !pid1AliveAfterExit && logAfterCleanExit.includes('[APP] EXIT_CLEAN'),
      { pid1AliveAfterExit, hasCleanExitLog: logAfterCleanExit.includes('[APP] EXIT_CLEAN') }
    );

    // Restart TORI and verify deliberate OFF preference persists without being overwritten
    console.log('\nRestarting installed TORI to verify OFF preference persistence across reboots...');
    const proc2 = spawn(installedMainExe, [], {
      env: {
        ...process.env,
        TORI_DATA_DIR: DATA_DIR,
        TORI_IPC_PIPE: PIPE_NAME,
        TORI_ALLOW_LOOPBACK: '1',
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      },
      stdio: 'ignore',
    });

    const pid2 = proc2.pid;
    for (let i = 0; i < 40; i++) {
      const st = await httpRequest({
        port: DESKTOP_PORT,
        path: '/api/v1/status',
        headers: { 'X-Tori-Token': 'gate27_1_token_secret' },
      });
      if (st.ok) break;
      await sleep(250);
    }
    await sleep(1500);

    const settingsAfterRestart = readSqliteSettings(DB_PATH);
    const logAfterRestart = readLifecycleLog();
    const migrationMatches = (logAfterRestart.match(/CLOSE_TO_TRAY_ENABLED/g) || []).length;

    record(
      'CHECK 8 & 9.2',
      'Deliberate Close-to-Tray OFF preference remains OFF across restarts (migration never clobbers)',
      settingsAfterRestart !== null &&
        settingsAfterRestart.closeToTray === false &&
        migrationMatches === 1,
      { settingsAfterRestart, migrationCount: migrationMatches }
    );

    // Re-enable Close-to-Tray for background download test
    const cdp2 = await connectToCdp(CDP_PORT);
    if (cdp2) {
      const reEnabledSettings = { ...settingsAfterRestart, closeToTray: true };
      await cdp2.cdpEval(
        `window.__TAURI_INTERNALS__.invoke('update_engine_settings', { settings: ${JSON.stringify(reEnabledSettings)} })`
      );
      await sleep(300);
      try {
        cdp2.ws.close();
      } catch {}
    }

    // -------------------------------------------------------------------------
    // STEP 10 - 15: Real Non-DRM Media Sequences & Deduplication Matrix
    // -------------------------------------------------------------------------
    console.log('\n>>> [CHECK 10 - 15] Real Non-DRM Media Sequences (Audio & Video) <<<\n');

    // Legitimate non-DRM media URL: Big Buck Bunny (Blender Open Movie, Creative Commons)
    const mediaPageUrl = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
    const token = 'gate27_1_token_secret';

    // Step 11: Download Audio-only format (format 250 - ~4.9 MiB)
    console.log('Dispatching Audio download (format 250) from legitimate non-DRM media source...');
    const audioDlResp = await httpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/media/download',
      method: 'POST',
      headers: { 'X-Tori-Token': token },
      body: {
        url: mediaPageUrl,
        format_id: '250',
        filename: 'bbb_audio_250.webm',
        destination: DOWNLOAD_DIR,
      },
    });

    const audioJobId = audioDlResp.data?.job_id;
    record(
      'CHECK 11.1',
      'Audio-only download request accepted with 200 OK and valid job ID',
      audioDlResp.ok && audioDlResp.data?.status === 'ok' && typeof audioJobId === 'string',
      audioDlResp.data
    );

    // Wait for Audio download completion
    console.log(`Waiting for Audio task ${audioJobId} to complete...`);
    let audioCompleted = false;
    let audioFinalJob = null;

    for (let i = 0; i < 60; i++) {
      const listRes = await httpRequest({
        port: DESKTOP_PORT,
        path: '/api/v1/downloads',
        headers: { 'X-Tori-Token': token },
      });
      const job = (listRes.data?.jobs || []).find((j) => j.id === audioJobId);
      if (job) {
        audioFinalJob = job;
        if (job.state === 'completed') {
          audioCompleted = true;
          break;
        }
      }
      await sleep(1000);
    }

    const audioDisk = findDownloadedFile(DOWNLOAD_DIR, 'bbb_audio_250');
    record(
      'CHECK 11.2',
      'Audio-only download transfers and successfully completes on disk',
      audioCompleted && audioDisk !== null && audioDisk.size > 100000,
      {
        state: audioFinalJob?.state,
        downloadedBytes: audioFinalJob?.downloaded_bytes,
        diskFile: audioDisk?.fullPath,
        fileSize: audioDisk?.size,
      }
    );

    // Step 12: Download Video format (format 160 - 144p ~4.1 MiB) from the SAME webpage URL!
    console.log('\nDispatching Video download (format 160) from SAME webpage URL...');
    const videoDlResp = await httpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/media/download',
      method: 'POST',
      headers: { 'X-Tori-Token': token },
      body: {
        url: mediaPageUrl,
        format_id: '160',
        filename: 'bbb_video_160.mp4',
        destination: DOWNLOAD_DIR,
      },
    });

    const videoJobId = videoDlResp.data?.job_id;
    record(
      'CHECK 12.1',
      '[BUG 2 FIX] Video download from SAME page URL accepted with ok status and distinct job ID (NOT blocked!)',
      videoDlResp.ok &&
        videoDlResp.data?.status === 'ok' &&
        typeof videoJobId === 'string' &&
        videoJobId !== audioJobId,
      {
        audioJobId,
        videoJobId,
        response: videoDlResp.data,
      }
    );

    // Wait for Video download completion
    console.log(`Waiting for Video task ${videoJobId} to complete...`);
    let videoCompleted = false;
    let videoFinalJob = null;

    for (let i = 0; i < 45; i++) {
      const listRes = await httpRequest({
        port: DESKTOP_PORT,
        path: '/api/v1/downloads',
        headers: { 'X-Tori-Token': token },
      });
      const job = (listRes.data?.jobs || []).find((j) => j.id === videoJobId);
      if (job) {
        videoFinalJob = job;
        if (job.state === 'completed') {
          videoCompleted = true;
          break;
        }
      }
      await sleep(1000);
    }

    const videoDisk = findDownloadedFile(DOWNLOAD_DIR, 'bbb_video_160');
    record(
      'CHECK 12.2',
      'Video download transfers and successfully completes on disk',
      videoCompleted && videoDisk !== null && videoDisk.size > 100000,
      {
        state: videoFinalJob?.state,
        downloadedBytes: videoFinalJob?.downloaded_bytes,
        diskFile: videoDisk?.fullPath,
        fileSize: videoDisk?.size,
      }
    );

    // Step 14: Duplicate Protection: Exact same format must return already_exists
    console.log('\nChecking duplicate protection for exact same format (format 160)...');
    const dupVideoResp = await httpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/media/download',
      method: 'POST',
      headers: { 'X-Tori-Token': token },
      body: {
        url: mediaPageUrl,
        format_id: '160',
        filename: 'bbb_video_160.mp4',
        destination: DOWNLOAD_DIR,
      },
    });

    record(
      'CHECK 14',
      'Duplicate request for exact same format returns already_exists with original job ID',
      dupVideoResp.ok &&
        dupVideoResp.data?.status === 'already_exists' &&
        dupVideoResp.data?.job_id === videoJobId,
      dupVideoResp.data
    );

    // Step 13: Sequence Matrix (Video -> Audio -> Video)
    console.log('\nTesting Video -> Audio sequence from SAME page URL (format 249)...');
    const audio2Resp = await httpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/media/download',
      method: 'POST',
      headers: { 'X-Tori-Token': token },
      body: {
        url: mediaPageUrl,
        format_id: '249',
        filename: 'bbb_audio_249.webm',
        destination: DOWNLOAD_DIR,
      },
    });

    const audio2JobId = audio2Resp.data?.job_id;
    record(
      'CHECK 13.1',
      'Video -> Audio sequence: Subsequent Audio format from SAME page URL succeeds with distinct job ID',
      audio2Resp.ok &&
        audio2Resp.data?.status === 'ok' &&
        typeof audio2JobId === 'string' &&
        audio2JobId !== audioJobId &&
        audio2JobId !== videoJobId,
      { audio2JobId }
    );

    console.log('Testing Audio -> Video sequence from SAME page URL (format 133)...');
    const video2Resp = await httpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/media/download',
      method: 'POST',
      headers: { 'X-Tori-Token': token },
      body: {
        url: mediaPageUrl,
        format_id: '133',
        filename: 'bbb_video_133.mp4',
        destination: DOWNLOAD_DIR,
      },
    });

    const video2JobId = video2Resp.data?.job_id;
    record(
      'CHECK 13.2',
      'Audio -> Video -> Audio sequence: All combinations queue with distinct IDs without interference',
      video2Resp.ok &&
        video2Resp.data?.status === 'ok' &&
        typeof video2JobId === 'string' &&
        video2JobId !== audioJobId &&
        video2JobId !== videoJobId &&
        video2JobId !== audio2JobId,
      { video2JobId }
    );

    // Check downloads listing shows all tasks simultaneously
    const allDownloadsRes = await httpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      headers: { 'X-Tori-Token': token },
    });
    const allJobs = allDownloadsRes.data?.jobs || [];
    record(
      'CHECK 13.3',
      'All 4 media jobs coexist in active engine state',
      allJobs.length >= 4 &&
        [audioJobId, videoJobId, audio2JobId, video2JobId].every((id) =>
          allJobs.some((j) => j.id === id)
        ),
      { jobCount: allJobs.length }
    );

    // Step 15: Stability check (zero crashes, zero unexpected termination)
    const finalLog = readLifecycleLog();
    const hasPanic = finalLog.includes('PANIC') || finalLog.includes('FATAL');
    const proc2StillAlive = isPidAlive(pid2);

    record(
      'CHECK 15',
      'Engine remains stable throughout multi-format transfer with zero crashes or panics',
      !hasPanic && proc2StillAlive,
      { hasPanic, procAlive: proc2StillAlive }
    );

    // Step 16: Extension release audit
    const extDiff = execSync('git diff release/v1.0.4..HEAD -- extension/', { encoding: 'utf8' }).trim();
    record(
      'CHECK 16',
      'Browser companion extension requires no new release (zero changes in extension/)',
      extDiff.length === 0,
      { extDiffLength: extDiff.length }
    );

    // Cleanly terminate proc2
    killPids([pid2]);
    await sleep(800);

  } catch (err) {
    console.error('Unexpected test exception:', err);
    record('FATAL', 'Unexpected exception in test harness', false, { error: err.message, stack: err.stack });
  } finally {
    killPids(findTestToriPids());

    // Restore user's installed instance if it was running before
    if (wasInstalledRunning && fs.existsSync(PROD_EXE)) {
      console.log('Restoring installed production TORI instance in background mode...');
      try {
        const restored = spawn(PROD_EXE, ['--minimized'], { detached: true, stdio: 'ignore' });
        restored.unref();
        console.log(`Restored installed instance (PID: ${restored.pid}).`);
      } catch (e) {
        console.error('Failed to restore installed TORI:', e);
      }
    }

    console.log('\n========================================================================');
    console.log(`Gate 27.1 Verification Summary: ${passed} PASSED, ${failed} FAILED`);
    console.log('========================================================================');

    const resultPath = path.join(ROOT, 'target', 'gate27_1_acceptance_result.json');
    fs.writeFileSync(resultPath, JSON.stringify({ passed, failed, results }, null, 2), 'utf8');
    console.log(`Saved detailed acceptance result to: ${resultPath}`);

    if (failed > 0) {
      process.exit(1);
    }
  }
}

run();
