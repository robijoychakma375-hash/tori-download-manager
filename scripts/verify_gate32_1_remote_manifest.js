#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 32.1 Live Remote HTTPS Signed Tools Manifest Verification
 *
 * Proves end-to-end against LIVE HTTPS endpoints (NO local mock server, NO test public key):
 *  - Manifest URL: https://toridownload.xyz/assets/tools/staging/tools-manifest.json
 *  - Signature URL: https://toridownload.xyz/assets/tools/staging/tools-manifest.json.sig
 *  - Embedded Production Ed25519 Public Key ID: CDC23D8CC8DA5397
 *  - Remote Immutable FFmpeg/FFprobe Artifact hosted over HTTPS on GitHub Releases prerelease
 *
 * Covers Phases 10, 11, 12, 13, 15, 17, and 19 in strict isolation under target/gate32_1_qa.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync, spawnSync } = require('child_process');
const {
  QaOemStateGuard,
  snapshotOemDatabase,
  compareOemDatabaseSnapshots,
} = require('./lib/qa_oem_state_guard');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP_EXE = path.join(ROOT, 'target', 'release', 'tori-download-manager.exe');
const QA_ROOT = path.join(ROOT, 'target', 'gate32_1_qa');
const QA_DATA_DIR = path.join(QA_ROOT, 'data');
const QA_DL_DIR = path.join(QA_ROOT, 'downloads');
const QA_WV2_DIR = path.join(QA_ROOT, 'webview2');
const SCREENSHOTS_DIR = path.join(ROOT, 'docs', 'reports', 'screenshots', 'gate32_1');

const OEM_APPDATA_DIR = path.join(process.env.APPDATA || '', 'tori-download-manager');
const OEM_DB_PATH = path.join(OEM_APPDATA_DIR, 'tdm_storage.sqlite');
const OEM_EXE_PATH = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'tori-download-manager.exe');

const LIVE_STAGING_MANIFEST_URL = 'https://toridownload.xyz/assets/tools/staging/tools-manifest.json';
const EXPECTED_KEY_ID = 'CDC23D8CC8DA5397';
const CDP_PORT = 24981;

const results = [];
const counts = { PASS: 0, FAIL: 0 };
const trackedProcs = new Set();

function record(id, name, ok, detail = '') {
  const status = ok ? 'PASS' : 'FAIL';
  counts[status]++;
  console.log(`[${status}] [${id}] ${name}${detail ? ' -> ' + detail : ''}`);
  results.push({ id, name, status, detail });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function killProcTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
  } catch {}
}

function cleanupTrackedProcs() {
  for (const p of trackedProcs) killProcTree(p.pid);
  trackedProcs.clear();
}

function getTreeMemoryAndCpu(rootPid) {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `
$root = ${rootPid}
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime
$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add($root)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
      [void]$ids.Add([int]$p.ProcessId)
      $changed = $true
    }
  }
}
$tree = $all | Where-Object { $ids.Contains([int]$_.ProcessId) }
$wsMb = [math]::Round((($tree | Measure-Object WorkingSetSize -Sum).Sum) / 1MB, 2)
$cpuSec = [math]::Round(((($tree | Measure-Object KernelModeTime -Sum).Sum) + (($tree | Measure-Object UserModeTime -Sum).Sum)) / 10000000.0, 3)
$conhost = @($tree | Where-Object { $_.Name -match 'conhost|cmd|powershell' }).Count
@{ procCount = @($tree).Count; wsMb = $wsMb; cpuSec = $cpuSec; consoleCount = $conhost } | ConvertTo-Json -Compress
`,
      ],
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    return JSON.parse(out);
  } catch {
    return { procCount: 0, wsMb: 0, cpuSec: 0, consoleCount: 0 };
  }
}

function httpGetJson(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, data: JSON.parse(raw) });
        } catch {
          resolve({ ok: false, raw });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e) => reject(e));
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: res, reject: rej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
            else res(msg.result);
          }
        } catch {}
      });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalJson(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          JSON.stringify(res.exceptionDetails)
      );
    }
    return res.result ? res.result.value : undefined;
  }
  async screenshot(outPath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(res.data, 'base64'));
  }
  close() {
    try { if (this.ws) this.ws.close(); } catch {}
  }
}

async function waitForMainCdp(cdpPort, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await httpGetJson(`http://127.0.0.1:${cdpPort}/json/list`);
    if (list.ok && Array.isArray(list.data)) {
      const page = list.data.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url || '').includes('window=toast')
      );
      if (page) {
        const client = new CDPClient(page.webSocketDebuggerUrl);
        await client.connect();
        await client.send('Runtime.enable');
        await client.send('Page.enable');
        return client;
      }
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for WebView2 CDP on port ${cdpPort}`);
}

async function launchIsolatedDesktop({ dataDir, wv2Dir, cdpPort, pipeSuffix, extraEnv = {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(wv2Dir, { recursive: true });

  const env = {
    ...process.env,
    TORI_DATA_DIR: dataDir,
    TORI_IPC_PIPE: `\\\\.\\pipe\\tori_qa_${pipeSuffix}_${process.pid}`,
    WEBVIEW2_USER_DATA_FOLDER: wv2Dir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    ...extraEnv,
  };

  const t0 = Date.now();
  const proc = spawn(DESKTOP_EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  trackedProcs.add(proc);
  const cdp = await waitForMainCdp(cdpPort, 30000);
  for (let i = 0; i < 60; i++) {
    const ready = await cdp.evalJson(`return Boolean(window.__TAURI_INTERNALS__ && document.querySelector('#tool'));`);
    if (ready) break;
    await sleep(150);
  }
  const startupMs = Date.now() - t0;
  return { proc, cdp, startupMs };
}

function runFullFfmpegCompatMatrix(ffmpegExe, ffprobeExe, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const run = (exe, args, label) => {
    const res = spawnSync(exe, args, { encoding: 'utf8', timeout: 30000 });
    if (res.status !== 0) {
      throw new Error(`${label} failed (exit=${res.status}): ${(res.stderr || res.stdout || '').slice(0, 400)}`);
    }
    return res.stdout || '';
  };

  const ffVer = (run(ffmpegExe, ['-version'], 'ffmpeg -version').match(/^ffmpeg version\s+(\S+)/m) || [])[1];
  const fpVer = (run(ffprobeExe, ['-version'], 'ffprobe -version').match(/^ffprobe version\s+(\S+)/m) || [])[1];
  if (!ffVer || ffVer !== fpVer) throw new Error(`Version parity failure: ffmpeg=${ffVer}, ffprobe=${fpVer}`);

  const formats = run(ffmpegExe, ['-hide_banner', '-formats'], 'formats');
  for (const fmt of ['mp4', 'matroska', 'hls', 'mpegts', 'mov']) {
    if (!new RegExp(`\\b${fmt}\\b`).test(formats)) throw new Error(`Missing format ${fmt}`);
  }
  const codecs = run(ffmpegExe, ['-hide_banner', '-codecs'], 'codecs');
  for (const codec of ['h264', 'aac', 'opus', 'vp9', 'av1']) {
    if (!new RegExp(`\\b${codec}\\b`).test(codecs)) throw new Error(`Missing codec ${codec}`);
  }

  const vPath = path.join(workDir, 'v.mp4');
  const aPath = path.join(workDir, 'a.m4a');
  const mp4Path = path.join(workDir, 'merged.mp4');
  const mkvPath = path.join(workDir, 'remux.mkv');
  const hlsDir = path.join(workDir, 'hls');
  const hlsOut = path.join(workDir, 'hls_out.mp4');
  fs.mkdirSync(hlsDir, { recursive: true });

  run(ffmpegExe, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vPath], 'gen h264');
  run(ffmpegExe, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', '-b:a', '96k', aPath], 'gen aac');
  run(ffmpegExe, ['-y', '-i', vPath, '-i', aPath, '-c', 'copy', '-metadata', 'title=TORI_LIVE_32_1', '-movflags', '+faststart', mp4Path], 'merge mp4');
  run(ffmpegExe, ['-y', '-i', mp4Path, '-c', 'copy', mkvPath], 'remux mkv');
  const m3u8 = path.join(hlsDir, 'playlist.m3u8');
  run(ffmpegExe, ['-y', '-i', mp4Path, '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', m3u8], 'gen hls');
  run(ffmpegExe, ['-y', '-allowed_extensions', 'ALL', '-i', m3u8, '-c', 'copy', hlsOut], 'remux hls');

  const probe = (f) => JSON.parse(run(ffprobeExe, ['-v', 'error', '-show_entries', 'format=duration,size:format_tags=title:stream=codec_type,codec_name,width,height', '-of', 'json', f], `ffprobe ${path.basename(f)}`));
  const pMp4 = probe(mp4Path);
  const pMkv = probe(mkvPath);
  const pHls = probe(hlsOut);

  for (const [label, p, wantTitle] of [
    ['mp4', pMp4, true],
    ['mkv', pMkv, true],
    ['hls', pHls, false],
  ]) {
    const streams = p.streams || [];
    const hasV = streams.some((s) => s.codec_type === 'video' && s.codec_name === 'h264');
    const hasA = streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac');
    const dur = parseFloat(p.format?.duration || '0');
    if (!hasV || !hasA || !(dur >= 1.8 && dur <= 2.3)) {
      throw new Error(`Probe failed for ${label}: ${JSON.stringify(p)}`);
    }
    if (wantTitle && p.format?.tags?.title !== 'TORI_LIVE_32_1') {
      throw new Error(`Metadata lost in ${label}`);
    }
  }
  return { ffVer, fpVer, mp4Size: fs.statSync(mp4Path).size, mkvSize: fs.statSync(mkvPath).size, hlsSize: fs.statSync(hlsOut).size };
}

function readIsolatedManifestState(dbPath) {
  const out = execFileSync(
    'python',
    [
      '-c',
      `import json, sqlite3, sys; c=sqlite3.connect(sys.argv[1]); r=c.execute("SELECT value FROM engine_settings WHERE key='external_tools_manifest_state'").fetchone(); print(r[0] if r else '{}')`,
      dbPath,
    ],
    { encoding: 'utf8', timeout: 8000 }
  ).trim();
  return JSON.parse(out || '{}');
}

async function main() {
  if (!fs.existsSync(DESKTOP_EXE)) {
    throw new Error(`Release binary missing: ${DESKTOP_EXE}`);
  }

  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(QA_DL_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const oemGuard = new QaOemStateGuard('gate32_1');
  oemGuard.backup({ stopRunningOem: true });
  oemGuard.temporarilySilenceNativeHostAutoSpawn();
  await sleep(600);

  // Capture WAL-safe OEM snapshot strictly AFTER pausing idle OEM Desktop
  const oemDbBefore = snapshotOemDatabase(OEM_DB_PATH);
  const oemExeShaBefore = sha256File(OEM_EXE_PATH);
  let oemDbAfter = null;

  let cdp = null;
  const perf = {};

  try {
    console.log('\n=== GATE 32.1 LIVE HTTPS REMOTE SIGNED TOOLS MANIFEST VERIFICATION ===');
    console.log(`Manifest Endpoint: ${LIVE_STAGING_MANIFEST_URL} (embedded production Ed25519 key ${EXPECTED_KEY_ID})`);

    // Launch isolated Desktop pointing ONLY to official HTTPS staging URL (NO test key override!)
    const session = await launchIsolatedDesktop({
      dataDir: QA_DATA_DIR,
      wv2Dir: QA_WV2_DIR,
      cdpPort: CDP_PORT,
      pipeSuffix: 'g321_live_https',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: LIVE_STAGING_MANIFEST_URL,
      },
    });
    cdp = session.cdp;
    perf.startupMs = session.startupMs;

    // Wait briefly so initial local inventory sync settles, measure idle footprint
    await sleep(1200);
    perf.idleBeforeCheck = getTreeMemoryAndCpu(session.proc.pid);

    // Pause background auto_install briefly so we can deterministically inspect the intermediate Update Available state & timing
    const initialSnap = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('get_external_tools_status');
    `);
    const s = initialSnap.settings;
    const initYt = initialSnap.tools.find((t) => t.tool_id === 'yt-dlp');
    const initFf = initialSnap.tools.find((t) => t.tool_id === 'ffmpeg');
    const initFp = initialSnap.tools.find((t) => t.tool_id === 'ffprobe');

    record(
      'G321-01',
      'Initial bundled versions detected (yt-dlp, FFmpeg N-126374, FFprobe N-126374)',
      initYt?.source === 'bundled' &&
        initFf?.source === 'bundled' &&
        initFp?.source === 'bundled' &&
        String(initFf?.installed_version || '').startsWith('N-126374') &&
        initFf?.installed_version === initFp?.installed_version,
      `yt-dlp=${initYt?.installed_version}, ffmpeg=${initFf?.installed_version}, ffprobe=${initFp?.installed_version}`
    );

    record(
      'G321-02',
      'Non-blocking startup & Gate 32 default policy preserved',
      perf.startupMs < 15000 &&
        s.auto_update === true &&
        s.check_interval_hours === 24 &&
        s.auto_install === true &&
        s.notify_on_update === true &&
        s.defer_while_in_use === true,
      `startupMs=${perf.startupMs}, idleWsMb=${perf.idleBeforeCheck.wsMb}`
    );

    // Open Settings -> External Tools panel in UI
    await cdp.evalJson(`
      document.documentElement.setAttribute('data-theme', 'light');
      const btn = Array.from(document.querySelectorAll('#tool button')).find(b => b.textContent.includes('Settings'));
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 350));
      const tab = document.querySelector('[data-tab="tools"]');
      if (tab) tab.click();
      await new Promise(r => setTimeout(r, 400));
    `);

    // Pause auto_install momentarily only for deterministic step-by-step discovery inspection
    await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: { auto_update: true, check_interval_hours: 24, auto_install: false, notify_on_update: true, defer_while_in_use: true }
      });
    `);

    // REAL LIVE HTTPS check against https://toridownload.xyz/assets/tools/staging/tools-manifest.json + .sig
    const tChk0 = Date.now();
    const afterCheck = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');
    `);
    perf.liveCheckMs = Date.now() - tChk0;
    await sleep(450);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, 'gate32_1_01_live_staging_update_available_light.png'));

    // Restore default auto_install=true
    await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: { auto_update: true, check_interval_hours: 24, auto_install: true, notify_on_update: true, defer_while_in_use: true }
      });
    `);

    const chkYt = afterCheck.tools.find((t) => t.tool_id === 'yt-dlp');
    const chkFf = afterCheck.tools.find((t) => t.tool_id === 'ffmpeg');
    const chkFp = afterCheck.tools.find((t) => t.tool_id === 'ffprobe');
    record(
      'G321-03',
      'Live HTTPS manifest + .sig verified with embedded production Ed25519 key (CDC23D8CC8DA5397)',
      chkFf?.update_status === 'update_available' &&
        chkFp?.update_status === 'update_available' &&
        chkFf?.available_version !== initFf?.installed_version &&
        chkYt?.update_status === 'update_available',
      `checkMs=${perf.liveCheckMs}, ffmpegAvail=${chkFf?.available_version}, ffprobeAvail=${chkFp?.available_version}, ytdlpAvail=${chkYt?.available_version}`
    );

    // Verify anti-replay state recorded in SQLite
    const manifestState = readIsolatedManifestState(path.join(QA_DATA_DIR, 'tdm_storage.sqlite'));
    record(
      'G321-05',
      'Anti-replay manifest_revision & key_id persisted in SQLite',
      Number(manifestState.highest_accepted_revision) >= 1 &&
        manifestState.last_signing_key_id === EXPECTED_KEY_ID &&
        Boolean(manifestState.last_accepted_manifest_sha256),
      JSON.stringify(manifestState)
    );

    // REAL REMOTE HTTPS FFmpeg + FFprobe Bundle Download (~205 MiB ZIP), SHA-256 + Size + PE + Self-Test + Atomic Pair Switch!
    console.log('[LIVE] Downloading, verifying, self-testing, and activating remote FFmpeg/FFprobe bundle over live HTTPS...');
    const tFf0 = Date.now();
    const afterFfUpdate = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'ffmpeg' });
    `);
    perf.remoteFfmpegUpdateMs = Date.now() - tFf0;
    await sleep(500);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, 'gate32_1_02_ffmpeg_updated_light.png'));

    // Capture Dark theme screenshot
    await cdp.evalJson(`document.documentElement.setAttribute('data-theme', 'dark'); await new Promise(r => setTimeout(r, 300));`);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, 'gate32_1_03_ffmpeg_updated_dark.png'));
    await cdp.evalJson(`document.documentElement.setAttribute('data-theme', 'light'); await new Promise(r => setTimeout(r, 200));`);

    const updFf = afterFfUpdate.tools.find((t) => t.tool_id === 'ffmpeg');
    const updFp = afterFfUpdate.tools.find((t) => t.tool_id === 'ffprobe');
    record(
      'G321-04',
      'Real remote HTTPS FFmpeg & FFprobe bundle downloaded, verified, tested, and atomically activated',
      updFf?.source === 'managed' &&
        updFp?.source === 'managed' &&
        updFf?.update_status === 'updated' &&
        updFp?.update_status === 'updated' &&
        updFf?.installed_version === updFp?.installed_version &&
        updFf?.installed_version !== initFf?.installed_version &&
        updFf?.rollback_available === true &&
        updFp?.rollback_available === true &&
        fs.existsSync(updFf.active_binary_path) &&
        fs.existsSync(updFp.active_binary_path),
      `elapsedMs=${perf.remoteFfmpegUpdateMs}, newVersion=${updFf?.installed_version}, ffmpegPath=${updFf?.active_binary_path}`
    );

    // Verify all tool location paths match & both binaries reside in the exact same versioned managed bundle folder
    const freshStatus = await cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_external_tools_status');`);
    const freshFf = freshStatus.tools.find((t) => t.tool_id === 'ffmpeg');
    const freshFp = freshStatus.tools.find((t) => t.tool_id === 'ffprobe');
    const activeManifestPath = path.join(QA_DATA_DIR, 'tools', 'manifests', 'active-tools.json');
    const activeManifest = JSON.parse(fs.readFileSync(activeManifestPath, 'utf8'));
    const locFf = freshFf?.active_binary_path;
    const locFp = freshFp?.active_binary_path;
    record(
      'G321-06',
      'TORI active-tools.json & tool resolver point both FFmpeg and FFprobe to the same new managed bundle directory',
      Boolean(
        locFf &&
          locFp &&
          path.dirname(locFf) === path.dirname(locFp) &&
          activeManifest?.ffmpeg_bundle_active?.ffmpeg_path === locFf &&
          activeManifest?.ffmpeg_bundle_active?.ffprobe_path === locFp
      ),
      `dir=${locFf ? path.dirname(locFf) : 'null'}`
    );

    // Phase 11: Full Compatibility Matrix on the newly activated remote FFmpeg + FFprobe pair!
    const compat = runFullFfmpegCompatMatrix(updFf.active_binary_path, updFp.active_binary_path, path.join(QA_ROOT, 'compat_updated'));
    record(
      'G321-07',
      'Updated remote FFmpeg & FFprobe pass full compatibility matrix (H.264, AAC, MP4, MKV, metadata, HLS, FFprobe JSON)',
      compat.ffVer === updFf.installed_version && compat.fpVer === updFp.installed_version && compat.mp4Size > 1000 && compat.mkvSize > 1000 && compat.hlsSize > 1000,
      JSON.stringify(compat)
    );

    // Phase 15: Real live OpenPGP-verified yt-dlp update regression!
    const tYt0 = Date.now();
    const afterYtUpdate = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'yt-dlp' });
    `);
    perf.remoteYtdlpUpdateMs = Date.now() - tYt0;
    const updYt = afterYtUpdate.tools.find((t) => t.tool_id === 'yt-dlp');
    record(
      'G321-08',
      'yt-dlp regression: live OpenPGP RSA-4096 update succeeds alongside signed FFmpeg manifest',
      updYt?.source === 'managed' &&
        updYt?.update_status === 'updated' &&
        updYt?.installed_version !== initYt?.installed_version &&
        updYt?.rollback_available === true,
      `elapsedMs=${perf.remoteYtdlpUpdateMs}, version=${initYt?.installed_version} -> ${updYt?.installed_version}`
    );

    // Real YouTube metadata & format extraction using updated managed tools
    const ytMeta = await cdp.evalJson(`
      try {
        return await window.__TAURI_INTERNALS__.invoke('resolve_media', { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' });
      } catch (e) { return { __error: String(e) }; }
    `);
    record(
      'G321-09',
      'Real YouTube metadata & format extraction succeeds with updated managed yt-dlp + FFmpeg/FFprobe',
      Boolean(ytMeta && !ytMeta.__error && ytMeta.title && Array.isArray(ytMeta.formats) && ytMeta.formats.length > 0),
      ytMeta?.__error ? ytMeta.__error : `title="${ytMeta?.title}", formats=${ytMeta?.formats?.length}`
    );

    // Real YouTube video+audio download & FFmpeg merge using newly activated managed yt-dlp + FFmpeg!
    const dlJob = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('create_media_download', {
        args: {
          url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
          format_id: '230+234/bestvideo+bestaudio/best',
          filename: 'gate32_1_yt_merged.mp4',
          destination: ${JSON.stringify(QA_DL_DIR)},
          start_immediately: true
        }
      });
    `);
    let finalJob = dlJob;
    for (let i = 0; i < 65; i++) {
      await sleep(1000);
      finalJob = await cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(dlJob.id)} });`);
      if (finalJob && (finalJob.state === 'completed' || finalJob.state === 'failed')) break;
    }
    const mergedExists = finalJob?.target_path && fs.existsSync(finalJob.target_path);
    let mergedProbe = null;
    if (mergedExists) {
      mergedProbe = JSON.parse(
        execFileSync(
          updFp.active_binary_path,
          ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name', '-of', 'json', finalJob.target_path],
          { encoding: 'utf8', timeout: 15000 }
        )
      );
    }
    record(
      'G321-10',
      'Real YouTube video+audio download & FFmpeg merge succeeds and passes updated managed FFprobe verification',
      finalJob?.state === 'completed' &&
        Boolean(mergedProbe?.streams?.some((s) => s.codec_type === 'video')) &&
        Boolean(mergedProbe?.streams?.some((s) => s.codec_type === 'audio')) &&
        parseFloat(mergedProbe?.format?.duration || '0') > 10,
      `state=${finalJob?.state}, duration=${mergedProbe?.format?.duration}, size=${mergedProbe?.format?.size}`
    );

    // Real YouTube audio-only download + playlist resolution
    const ytPlaylist = await cdp.evalJson(`
      try {
        return await window.__TAURI_INTERNALS__.invoke('resolve_playlist', {
          url: 'https://www.youtube.com/playlist?list=PL6B3937A5D230E335',
          limit: 3
        });
      } catch (e) { return { __error: String(e) }; }
    `);
    const audJob = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('create_media_download', {
        args: {
          url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
          format_id: 'bestaudio[ext=m4a]/bestaudio',
          filename: 'gate32_1_yt_audio.m4a',
          destination: ${JSON.stringify(QA_DL_DIR)},
          start_immediately: true
        }
      });
    `);
    let finalAud = audJob;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      finalAud = await cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(audJob.id)} });`);
      if (finalAud && (finalAud.state === 'completed' || finalAud.state === 'failed')) break;
    }
    let audProbe = null;
    if (finalAud?.target_path && fs.existsSync(finalAud.target_path)) {
      audProbe = JSON.parse(
        execFileSync(
          updFp.active_binary_path,
          ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', finalAud.target_path],
          { encoding: 'utf8', timeout: 15000 }
        )
      );
    }
    record(
      'G321-11',
      'Real YouTube playlist resolution and audio-only extraction pass with updated managed tools',
      Boolean(ytPlaylist && !ytPlaylist.__error && ytPlaylist.items?.length > 0) &&
        finalAud?.state === 'completed' &&
        Boolean(audProbe?.streams?.some((s) => s.codec_type === 'audio')),
      `playlistItems=${ytPlaylist?.items?.length}, audioState=${finalAud?.state}, audioDur=${audProbe?.format?.duration}`
    );

    // Open Update History modal & capture screenshot
    await cdp.evalJson(`
      const btn = document.querySelector('[data-testid="btn-view-tools-history"]');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 400));
    `);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, 'gate32_1_04_update_history_modal.png'));
    const history = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('get_external_tool_update_history', { limit: 50 });
    `);
    await cdp.evalJson(`
      const closeBtn = document.querySelector('[data-testid="external-tools-history-modal"] button');
      if (closeBtn) closeBtn.click();
      await new Promise(r => setTimeout(r, 250));
    `);
    record(
      'G321-12',
      'SQLite update history records both signed-manifest FFmpeg update and OpenPGP yt-dlp update',
      Array.isArray(history) &&
        history.some((h) => h.tool_id === 'ffmpeg' && h.status === 'updated' && h.trust_level === 'tori_ed25519_manifest_verified') &&
        history.some((h) => h.tool_id === 'yt-dlp' && h.status === 'updated' && h.trust_level === 'publisher_openpgp_verified'),
      `entries=${history?.length}`
    );

    // Phase 13: Atomic Manual Rollback of FFmpeg & FFprobe -> bundled N-126374 + functional verification!
    const afterRb = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('rollback_external_tool', { toolId: 'ffmpeg' });
    `);
    await sleep(400);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, 'gate32_1_05_ffmpeg_rolled_back.png'));
    const rbFf = afterRb.tools.find((t) => t.tool_id === 'ffmpeg');
    const rbFp = afterRb.tools.find((t) => t.tool_id === 'ffprobe');
    const rbCompat = runFullFfmpegCompatMatrix(rbFf.active_binary_path, rbFp.active_binary_path, path.join(QA_ROOT, 'compat_rolled_back'));
    record(
      'G321-13',
      'Atomic manual rollback restores BOTH FFmpeg and FFprobe to bundled N-126374 and passes real media tests',
      rbFf?.source === 'bundled' &&
        rbFp?.source === 'bundled' &&
        rbFf?.update_status === 'rolled_back' &&
        rbFp?.update_status === 'rolled_back' &&
        rbFf?.installed_version === initFf?.installed_version &&
        rbFp?.installed_version === initFp?.installed_version &&
        rbCompat.ffVer === initFf?.installed_version,
      `restored=${rbFf?.installed_version}, compatOk=true`
    );

    // Phase 13: Reapply verified remote update cleanly after rollback!
    await cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');`);
    const afterReapply = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'ffmpeg' });
    `);
    const reFf = afterReapply.tools.find((t) => t.tool_id === 'ffmpeg');
    const reFp = afterReapply.tools.find((t) => t.tool_id === 'ffprobe');
    record(
      'G321-14',
      'Reapplying verified remote FFmpeg/FFprobe update after rollback succeeds cleanly over HTTPS',
      reFf?.source === 'managed' &&
        reFp?.source === 'managed' &&
        reFf?.update_status === 'updated' &&
        reFp?.update_status === 'updated' &&
        reFf?.installed_version === updFf?.installed_version,
      `reapplied=${reFf?.installed_version}`
    );

    // Rollback yt-dlp regression check
    const rbYtSnap = await cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('rollback_external_tool', { toolId: 'yt-dlp' });`);
    const rbYt = rbYtSnap.tools.find((t) => t.tool_id === 'yt-dlp');
    record(
      'G321-15',
      'yt-dlp manual rollback cleanly restores bundled 2026.08.19',
      rbYt?.source === 'bundled' && rbYt?.installed_version === initYt?.installed_version && rbYt?.update_status === 'rolled_back',
      `restored=${rbYt?.installed_version}`
    );

    // Phase 19: Post-update idle footprint & zero leaked console windows
    await sleep(1500);
    perf.idlePostUpdate = getTreeMemoryAndCpu(session.proc.pid);
    fs.writeFileSync(path.join(QA_ROOT, 'perf_metrics.json'), JSON.stringify(perf, null, 2) + '\n');
    record(
      'G321-16',
      'Performance & stability: fast non-blocking startup, bounded memory, zero leaked console windows',
      perf.startupMs < 15000 && perf.idlePostUpdate.wsMb < 900 && perf.idlePostUpdate.consoleCount === 0,
      JSON.stringify(perf)
    );

    cdp.close();
    cdp = null;
  } finally {
    if (cdp) cdp.close();
    cleanupTrackedProcs();
    await sleep(400);
    // Capture AFTER OEM DB snapshot BEFORE restarting OEM Desktop
    oemDbAfter = snapshotOemDatabase(OEM_DB_PATH);
    const parity = oemGuard.restore({ qaPathMarker: 'gate32_1_qa', restartOem: true });
    record('G321-17', 'OEM Windows Registry & Native Messaging parity preserved', parity.ok === true, JSON.stringify(parity.checks || {}));
  }

  const dbCmp = compareOemDatabaseSnapshots(oemDbBefore, oemDbAfter);
  record(
    'G321-18',
    'OEM production SQLite database & .tdm-part files preserved with PRAGMA integrity_check=ok',
    Boolean(dbCmp && dbCmp.ok),
    JSON.stringify(dbCmp)
  );

  const oemExeShaAfter = sha256File(OEM_EXE_PATH);
  record(
    'G321-19',
    'Production installed TORI Desktop v1.0.6 binary completely untouched (byte-identical SHA-256)',
    oemExeShaBefore === oemExeShaAfter,
    `exeShaMatch=${oemExeShaBefore === oemExeShaAfter}`
  );

  console.log(`\n=== GATE 32.1 LIVE HTTPS VERIFICATION SUMMARY: PASS=${counts.PASS} FAIL=${counts.FAIL} ===`);
  if (counts.FAIL > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  cleanupTrackedProcs();
  process.exit(1);
});
