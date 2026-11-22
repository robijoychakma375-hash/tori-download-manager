#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 32.3
 * Production Tools Manifest Live Acceptance (--phase5-prod-manifest)
 * & Complete Live Public Stable Release Verification (--post-release)
 *
 * Strictly isolated under target/gate32_3_qa with QaOemStateGuard.
 * Uses ZERO TORI_TEST_TOOLS_MANIFEST_URL overrides so the compiled production
 * default endpoint (https://toridownload.xyz/assets/tools/tools-manifest.json)
 * is exercised live end-to-end.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync, execSync, execFileSync } = require('child_process');
const {
  QaOemStateGuard,
  snapshotOemDatabase,
  compareOemDatabaseSnapshots,
} = require('./lib/qa_oem_state_guard');

const ROOT = path.resolve(__dirname, '..');
const REPO = 'robijoychakma375-hash/tori-download-manager';
const SITE_URL = 'https://toridownload.xyz';
const APPROVED_COMMIT = '84da0c08256d6abaca253b5612010034237c86f9';
const EXPECTED_KEY_ID = 'CDC23D8CC8DA5397';

const EXPECTED_V107_INSTALLER_SIZE = 118097450;
const EXPECTED_V107_INSTALLER_SHA = '142e4528410a70c43cf7166acda87d8b27e293348237113b2350a025467966cb';
const EXPECTED_V107_SIG_SIZE = 436;
const EXPECTED_V107_SIG_SHA = '945b5efdcc69edf85373c54cfdb603d50976f5ba6be75bef5e130ca5350224e8';
const EXPECTED_V107_HOST_SHA = '2a88db0c749dac21cf69fce1580e674cef7d4478d6b98728858277141db60c41';

const EXPECTED_PROD_MANIFEST_SHA = '9fa61a38bb77bb8cdf05364565db2cf3b2b3ab8d0c7af98dfd7c50b2ee287662';
const EXPECTED_PROD_SIG_SHA = 'e0e23db79990f885c0745165299b20befd41f5dc8a73f7b00ca0476502955eb4';
const EXPECTED_FFMPEG_VER = 'N-129150-g7ddf7bc8a4-20261120';
const EXPECTED_FFMPEG_BUNDLED = 'N-126374-g089a48eb36-20260831';

const EXPECTED_XPI_SIZE = 107499;
const EXPECTED_XPI_SHA = 'a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8';
const EXPECTED_CHR_SIZE = 90964;
const EXPECTED_CHR_SHA = 'f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1';
const EXPECTED_GECKO_ID = 'tori-download-manager@toridm.org';

const RC_V107_INSTALLER = path.join(ROOT, 'release', 'v1.0.7-rc', 'TORI Download Manager_1.0.7_x64-setup.exe');
const V106_INSTALLER = path.join(ROOT, 'release', 'v1.0.6-rc', 'TORI Download Manager_1.0.6_x64-setup.exe');
const BACKUP_ONLINE_DB = 'C:\\Users\\ritud\\.tori-release-backups\\gate32_3_pre_pub_20261122\\appdata\\tdm_storage.online_backup.sqlite';
const OEM_DB_PATH = path.join(process.env.APPDATA || '', 'tori-download-manager', 'tdm_storage.sqlite');
const OEM_EXE_PATH = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'tori-download-manager.exe');

const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

const results = [];
const counts = { PASS: 0, FAIL: 0 };
const trackedProcs = new Set();

function record(id, desc, ok, detail = '') {
  const status = ok ? 'PASS' : 'FAIL';
  counts[status]++;
  console.log(`[${status}] [${id}] ${desc}${detail ? ' -> ' + detail : ''}`);
  results.push({ id, desc, status, detail });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256File(p) {
  if (!p || !fs.existsSync(p)) return null;
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex').toLowerCase();
}

function killProcTree(pid) {
  if (!pid) return;
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch {}
}

function cleanupProcs() {
  for (const p of trackedProcs) if (p?.pid) killProcTree(p.pid);
  trackedProcs.clear();
}

function getGitHubToken() {
  const res = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    timeout: 10000,
  });
  const m = (res.stdout || '').match(/^password=(.+)$/m);
  if (!m) throw new Error('No GitHub token in Git Credential Manager');
  return m[1].trim();
}

function fetchRaw(url, token = null) {
  return new Promise((resolve, reject) => {
    const redirects = [];
    const go = (u, left = 8) => {
      const pu = new URL(u);
      const headers = { 'User-Agent': 'TORI-Gate32-3-Live-Verifier', 'Cache-Control': 'no-cache' };
      if (token && pu.hostname === 'api.github.com') {
        headers.Authorization = `Bearer ${token}`;
        headers.Accept = 'application/vnd.github+json';
      }
      https.get(u, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
          const next = new URL(res.headers.location, u).toString();
          redirects.push({ status: res.statusCode, location: next });
          res.resume();
          return go(next, left - 1);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, finalUrl: u, redirects, buf: Buffer.concat(chunks) }));
      }).on('error', reject);
    };
    go(url);
  });
}

function downloadFileViaCurl(url, destPath) {
  const res = spawnSync(
    'curl.exe',
    ['-sS', '-L', '--http1.1', '--retry', '4', '--retry-delay', '2', '-o', destPath, '-w', '%{http_code}', '-H', 'User-Agent: TORI-Gate32-3-Live-Verifier', url],
    { encoding: 'utf8', timeout: 600000 }
  );
  if (res.error) throw res.error;
  return parseInt((res.stdout || '').trim(), 10) || 0;
}

function httpJson({ port, reqPath, method = 'GET', headers = {}, body = null, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const payload = body !== null ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (payload !== null) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers: h, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function compareSemVer(a, b) {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  async connect(timeoutMs = 12000) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs);
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
      this.ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(e.message || 'ws error')); });
      this.ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          }
        } catch {}
      });
    });
  }
  send(method, params = {}, timeoutMs = 180000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, userGesture = false, timeoutMs = 180000) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, timeoutMs);
    if (res?.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res?.result?.value;
  }
  async evalJson(body, timeoutMs = 180000) {
    const raw = await this.eval(`(async () => { const __r = await (async () => { ${body} })(); return JSON.stringify(__r === undefined ? null : __r); })()`, false, timeoutMs);
    return raw ? JSON.parse(raw) : null;
  }
  close() { try { this.ws?.close(); } catch {} }
}

class MarionetteClient {
  constructor(port) {
    this.port = port;
    this.buf = Buffer.alloc(0);
    this.msgId = 0;
    this.pending = new Map();
    this.helloResolve = null;
  }
  async connect(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await new Promise((resolve, reject) => {
          const s = net.createConnection({ host: '127.0.0.1', port: this.port });
          this.sock = s;
          this.helloResolve = resolve;
          s.on('error', reject);
          s.on('data', (chunk) => this._onData(chunk));
        });
        return;
      } catch {
        await sleep(300);
      }
    }
    throw new Error(`Marionette timeout on port ${this.port}`);
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const idx = this.buf.indexOf(0x3a);
      if (idx === -1) break;
      const len = parseInt(this.buf.subarray(0, idx).toString('utf8'), 10);
      if (Number.isNaN(len) || this.buf.length < idx + 1 + len) break;
      const body = this.buf.subarray(idx + 1, idx + 1 + len).toString('utf8');
      this.buf = this.buf.subarray(idx + 1 + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      if (!Array.isArray(msg) && msg.applicationType && this.helloResolve) {
        const r = this.helloResolve; this.helloResolve = null; r(msg);
      } else if (Array.isArray(msg) && msg[0] === 1) {
        const p = this.pending.get(msg[1]);
        if (p) {
          this.pending.delete(msg[1]); clearTimeout(p.timer);
          if (msg[2]) p.reject(new Error(JSON.stringify(msg[2])));
          else p.resolve(msg[3]);
        }
      }
    }
  }
  send(cmd, params = {}, timeoutMs = 20000) {
    const id = ++this.msgId;
    const wire = JSON.stringify([0, id, cmd, params]);
    const payload = `${Buffer.byteLength(wire, 'utf8')}:${wire}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Marionette timeout: ${cmd}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(payload);
    });
  }
  close() { try { this.sock?.destroy(); } catch {} }
}

async function listCdpTargets(port) {
  const res = await httpJson({ port, reqPath: '/json/list', timeoutMs: 3000 });
  return Array.isArray(res.data) ? res.data : [];
}

function getProgressJobId(t) {
  try {
    const u = new URL(t.url);
    if (u.searchParams.get('window') === 'progress' || u.searchParams.get('window') === 'toast') {
      return u.searchParams.get('id');
    }
  } catch {}
  return null;
}

function readIsolatedManifestState(dbPath) {
  const out = execFileSync(
    'python',
    [
      '-c',
      `import sqlite3, sys; c=sqlite3.connect(sys.argv[1]); r=c.execute("SELECT value FROM engine_settings WHERE key='external_tools_manifest_state'").fetchone(); print(r[0] if r else '{}'); c.close()`,
      dbPath,
    ],
    { encoding: 'utf8', timeout: 8000 }
  ).trim();
  return JSON.parse(out || '{}');
}

function runMediaCompatMatrix(ffmpegExe, ffprobeExe, workDir) {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const run = (exe, args, label) => {
    const res = spawnSync(exe, args, { encoding: 'utf8', timeout: 45000 });
    if (res.status !== 0) {
      throw new Error(`Media compat '${label}' failed (exit=${res.status}): ${(res.stderr || res.stdout || '').slice(0, 400)}`);
    }
    return res.stdout || '';
  };
  const ffVer = (run(ffmpegExe, ['-version'], 'ff -version').match(/^ffmpeg version\s+(\S+)/m) || [])[1];
  const fpVer = (run(ffprobeExe, ['-version'], 'fp -version').match(/^ffprobe version\s+(\S+)/m) || [])[1];
  if (!ffVer || ffVer !== fpVer) throw new Error(`Version mismatch: ffmpeg=${ffVer}, ffprobe=${fpVer}`);

  const vPath = path.join(workDir, 'v.mp4');
  const aPath = path.join(workDir, 'a.m4a');
  const mp4Path = path.join(workDir, 'merged.mp4');
  const mkvPath = path.join(workDir, 'remux.mkv');
  const hlsDir = path.join(workDir, 'hls');
  const hlsOut = path.join(workDir, 'hls_out.mp4');
  fs.mkdirSync(hlsDir, { recursive: true });

  run(ffmpegExe, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vPath], 'gen h264');
  run(ffmpegExe, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', '-b:a', '96k', aPath], 'gen aac');
  run(ffmpegExe, ['-y', '-i', vPath, '-i', aPath, '-c', 'copy', '-metadata', 'title=TORI_PROD_32_3', '-movflags', '+faststart', mp4Path], 'merge mp4');
  run(ffmpegExe, ['-y', '-i', mp4Path, '-c', 'copy', mkvPath], 'remux mkv');
  const m3u8 = path.join(hlsDir, 'playlist.m3u8');
  run(ffmpegExe, ['-y', '-i', mp4Path, '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', m3u8], 'gen hls');
  run(ffmpegExe, ['-y', '-allowed_extensions', 'ALL', '-i', m3u8, '-c', 'copy', hlsOut], 'remux hls');

  const probe = (f) => JSON.parse(run(ffprobeExe, ['-v', 'error', '-show_entries', 'format=duration,size:format_tags=title:stream=codec_type,codec_name,width,height', '-of', 'json', f], `ffprobe ${path.basename(f)}`));
  for (const [label, f, wantTitle] of [['mp4', mp4Path, true], ['mkv', mkvPath, true], ['hls', hlsOut, false]]) {
    const p = probe(f);
    const streams = p.streams || [];
    const hasV = streams.some((s) => s.codec_type === 'video' && s.codec_name === 'h264');
    const hasA = streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac');
    const dur = parseFloat(p.format?.duration || '0');
    if (!hasV || !hasA || !(dur >= 1.8 && dur <= 2.3)) throw new Error(`Probe failed on ${label}`);
    if (wantTitle && p.format?.tags?.title !== 'TORI_PROD_32_3') throw new Error(`Metadata lost on ${label}`);
  }
  return { ffVer, fpVer, mp4Size: fs.statSync(mp4Path).size, mkvSize: fs.statSync(mkvPath).size, hlsSize: fs.statSync(hlsOut).size };
}

async function launchIsolatedApp({ exePath, dataDir, dlDir, wv2Dir, cdpPort, pipeName }) {
  const env = { ...process.env };
  // CRITICAL: Remove any staging/test manifest overrides so compiled production default URL is used!
  delete env.TORI_TEST_TOOLS_MANIFEST_URL;
  delete env.TORI_TOOLS_MANIFEST_URL;
  delete env.TORI_TEST_TOOLS_MANIFEST_PUBKEY_B64;

  env.TORI_DATA_DIR = dataDir;
  env.TDM_STORAGE_DIR = dataDir;
  env.TDM_DOWNLOAD_DIR = dlDir;
  env.TORI_IPC_PIPE = pipeName;
  env.TORI_ALLOW_LOOPBACK = '1';
  env.TORI_DISABLE_AUTO_SPAWN = '1';
  env.WEBVIEW2_USER_DATA_FOLDER = wv2Dir;
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${cdpPort}`;

  const t0 = Date.now();
  const proc = spawn(exePath, [], { cwd: path.dirname(exePath), env, stdio: 'ignore' });
  trackedProcs.add(proc);

  let mainWs = null;
  for (let i = 0; i < 60; i++) {
    const hit = (await listCdpTargets(cdpPort)).find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !getProgressJobId(t));
    if (hit) { mainWs = hit.webSocketDebuggerUrl; break; }
    await sleep(250);
  }
  if (!mainWs) throw new Error(`WebView2 CDP not ready on port ${cdpPort}`);
  const cdp = new CDPClient(mainWs);
  await cdp.connect();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const ok = await cdp.eval(`Boolean(window.__TAURI_INTERNALS__?.invoke && document.getElementById('root')?.childElementCount > 0)`, false, 4000);
      if (ok) break;
    } catch {}
    await sleep(250);
  }
  return { proc, cdp, startupMs: Date.now() - t0 };
}

// =============================================================================
// MODE 1: PHASE 5 — PRODUCTION MANIFEST LIVE ACCEPTANCE (PRE-GITHUB RELEASE)
// =============================================================================
async function runPhase5ProdManifestAcceptance() {
  console.log('=============================================================================');
  console.log('  TORI GATE 32.3 — PHASE 5 PRODUCTION TOOLS MANIFEST LIVE ACCEPTANCE');
  console.log('  Endpoint: https://toridownload.xyz/assets/tools/tools-manifest.json (DEFAULT)');
  console.log('=============================================================================\n');

  const QA_ROOT = path.join(ROOT, 'target', 'gate32_3_phase5_qa');
  const INST_DIR = path.join(QA_ROOT, 'inst');
  const DATA_DIR = path.join(QA_ROOT, 'data');
  const DL_DIR = path.join(QA_ROOT, 'dl');
  const WV2_DIR = path.join(QA_ROOT, 'wv2');
  const CDP_PORT = 25331;

  const oemGuard = new QaOemStateGuard('gate32_3_p5');
  oemGuard.backup({ stopRunningOem: true });
  oemGuard.temporarilySilenceNativeHostAutoSpawn();
  await sleep(600);

  const oemDbBefore = snapshotOemDatabase(OEM_DB_PATH);
  const oemExeShaBefore = sha256File(OEM_EXE_PATH);
  let oemDbAfter = null;
  let cdp = null;

  try {
    fs.rmSync(QA_ROOT, { recursive: true, force: true });
    for (const d of [INST_DIR, DATA_DIR, DL_DIR, WV2_DIR]) fs.mkdirSync(d, { recursive: true });

    // Install frozen v1.0.7-rc into isolated QA dir
    execSync(`"${RC_V107_INSTALLER}" /S /D=${INST_DIR}`, { timeout: 90000 });
    oemGuard.temporarilySilenceNativeHostAutoSpawn();
    const exePath = path.join(INST_DIR, 'tori-download-manager.exe');
    const peVer = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${exePath}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim();
    record('P5-01', 'Isolated frozen v1.0.7-rc installed cleanly', peVer === '1.0.7', `peVer=${peVer}`);

    const sess = await launchIsolatedApp({
      exePath,
      dataDir: DATA_DIR,
      dlDir: DL_DIR,
      wv2Dir: WV2_DIR,
      cdpPort: CDP_PORT,
      pipeName: `\\\\.\\pipe\\tori-qa-g323-p5-${process.pid}`,
    });
    cdp = sess.cdp;
    await sleep(1200);

    // Pause auto_install briefly to deterministically inspect Check -> Available -> Update
    await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: { auto_update: true, check_interval_hours: 24, auto_install: false, notify_on_update: true, defer_while_in_use: true }
      });
    `);

    const tChk = Date.now();
    const afterCheck = await cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');`);
    const checkMs = Date.now() - tChk;
    const ffChk = afterCheck.tools.find((t) => t.tool_id === 'ffmpeg');
    const fpChk = afterCheck.tools.find((t) => t.tool_id === 'ffprobe');
    const ytChk = afterCheck.tools.find((t) => t.tool_id === 'yt-dlp');
    const manState = readIsolatedManifestState(path.join(DATA_DIR, 'tdm_storage.sqlite'));

    record(
      'P5-02',
      'Live PRODUCTION manifest + .sig verified via default URL with embedded Ed25519 key (NO staging override)',
      Boolean(
        ffChk?.update_status === 'update_available' &&
        ffChk?.available_version === EXPECTED_FFMPEG_VER &&
        fpChk?.update_status === 'update_available' &&
        fpChk?.available_version === EXPECTED_FFMPEG_VER &&
        manState.highest_accepted_revision === 1 &&
        manState.last_accepted_manifest_sha256 === EXPECTED_PROD_MANIFEST_SHA &&
        manState.last_signing_key_id === EXPECTED_KEY_ID
      ),
      `checkMs=${checkMs}, ff=${ffChk?.available_version}, yt=${ytChk?.available_version}, rev=${manState.highest_accepted_revision}, manSha=${manState.last_accepted_manifest_sha256}`
    );

    // Restore default auto_install=true
    await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: { auto_update: true, check_interval_hours: 24, auto_install: true, notify_on_update: true, defer_while_in_use: true }
      });
    `);

    // Download & atomically activate the real 205 MiB FFmpeg/FFprobe bundle over live HTTPS
    console.log('[LIVE] Downloading, verifying, self-testing, and activating 205 MiB FFmpeg/FFprobe from PRODUCTION manifest...');
    const tFf = Date.now();
    const afterFf = await cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'ffmpeg' });`, 900000);
    const ffUpdateMs = Date.now() - tFf;
    const ffAct = afterFf.tools.find((t) => t.tool_id === 'ffmpeg');
    const fpAct = afterFf.tools.find((t) => t.tool_id === 'ffprobe');
    const activeJson = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tools', 'manifests', 'active-tools.json'), 'utf8'));
    const sameDir = ffAct?.active_binary_path && fpAct?.active_binary_path && path.dirname(ffAct.active_binary_path) === path.dirname(fpAct.active_binary_path);

    record(
      'P5-03',
      'Real 205 MiB FFmpeg/FFprobe bundle downloaded, SHA-256/PE/parity/health verified & atomically activated',
      Boolean(
        ffAct?.source === 'managed' &&
        fpAct?.source === 'managed' &&
        ffAct?.update_status === 'updated' &&
        fpAct?.update_status === 'updated' &&
        ffAct?.installed_version === EXPECTED_FFMPEG_VER &&
        fpAct?.installed_version === EXPECTED_FFMPEG_VER &&
        sameDir &&
        activeJson.ffmpeg_bundle_active?.ffmpeg_path === ffAct?.active_binary_path &&
        activeJson.ffmpeg_bundle_active?.ffprobe_path === fpAct?.active_binary_path
      ),
      `elapsedMs=${ffUpdateMs}, ver=${ffAct?.installed_version}, dir=${path.dirname(ffAct?.active_binary_path || '')}`
    );

    // Media compatibility matrix (H.264, AAC, MP4, MKV, HLS, FFprobe JSON)
    const compatUpdated = runMediaCompatMatrix(ffAct.active_binary_path, fpAct.active_binary_path, path.join(QA_ROOT, 'compat_updated'));
    record('P5-04', 'Updated production FFmpeg & FFprobe pass full H.264/AAC/MP4/MKV/HLS/FFprobe pipeline', compatUpdated.ffVer === EXPECTED_FFMPEG_VER, JSON.stringify(compatUpdated));

    // Atomic manual rollback -> verify BOTH revert to bundled N-126374 and pass real media tests
    const afterRb = await cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('rollback_external_tool', { toolId: 'ffmpeg' });`, 60000);
    const ffRb = afterRb.tools.find((t) => t.tool_id === 'ffmpeg');
    const fpRb = afterRb.tools.find((t) => t.tool_id === 'ffprobe');
    const compatRb = runMediaCompatMatrix(ffRb.active_binary_path, fpRb.active_binary_path, path.join(QA_ROOT, 'compat_rb'));
    record(
      'P5-05',
      'Atomic manual rollback reverts BOTH FFmpeg and FFprobe to bundled N-126374 and passes media tests',
      Boolean(ffRb?.source === 'bundled' && fpRb?.source === 'bundled' && ffRb?.installed_version === EXPECTED_FFMPEG_BUNDLED && compatRb.ffVer === EXPECTED_FFMPEG_BUNDLED),
      `restored=${ffRb?.installed_version}, mp4=${compatRb.mp4Size}B`
    );

    // Reapply trusted production update cleanly
    console.log('[LIVE] Reapplying verified production FFmpeg/FFprobe update after rollback...');
    await cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');`, 60000);
    const afterReapply = await cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'ffmpeg' });`, 900000);
    const ffRe = afterReapply.tools.find((t) => t.tool_id === 'ffmpeg');
    const fpRe = afterReapply.tools.find((t) => t.tool_id === 'ffprobe');
    const hist = await cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_external_tool_update_history', { limit: 50 });`);
    record(
      'P5-06',
      'Reapplying production FFmpeg/FFprobe update after rollback succeeds & persists SQLite update history',
      Boolean(ffRe?.source === 'managed' && fpRe?.source === 'managed' && ffRe?.installed_version === EXPECTED_FFMPEG_VER && Array.isArray(hist) && hist.length >= 2),
      `reapplied=${ffRe?.installed_version}, historyEntries=${hist?.length}`
    );

    cdp.close();
    cdp = null;
    killProcTree(sess.proc.pid);
    trackedProcs.delete(sess.proc);
    await sleep(500);
  } finally {
    if (cdp) try { cdp.close(); } catch {}
    cleanupProcs();
    oemDbAfter = snapshotOemDatabase(OEM_DB_PATH);
    try { fs.rmSync(QA_ROOT, { recursive: true, force: true }); } catch {}
    const parity = oemGuard.restore({ qaPathMarker: 'gate32_3_phase5_qa', restartOem: true });
    const dbCmp = compareOemDatabaseSnapshots(oemDbBefore, oemDbAfter);
    const oemExeMatch = sha256File(OEM_EXE_PATH) === oemExeShaBefore;
    record('P5-07', 'OEM Registry, Native Messaging, SQLite DB (42 rows), 11 .tdm-part files & v1.0.6 binary 100% preserved', Boolean(parity?.ok && dbCmp?.ok && oemExeMatch), JSON.stringify({ regOk: parity?.ok, dbOk: dbCmp?.ok, rawShaMatch: dbCmp?.rawFileSha256Match, oemExeMatch }));
  }

  console.log(`\n=== GATE 32.3 PHASE 5 SUMMARY: ${counts.PASS} PASS, ${counts.FAIL} FAIL ===`);
  if (counts.FAIL > 0) process.exit(1);
}

// =============================================================================
// MODE 2: POST-RELEASE COMPLETE PUBLIC VERIFICATION (PHASES 8, 11, 12, 13, 14, 17)
// =============================================================================
async function runFullPostReleaseVerification() {
  console.log('=============================================================================');
  console.log('  TORI GATE 32.3 — LIVE PUBLIC STABLE v1.0.7 POST-RELEASE VERIFICATION');
  console.log('=============================================================================\n');

  const token = getGitHubToken();
  const QA_ROOT = path.join(ROOT, 'target', 'gate32_3_live_qa');
  const DL_DIR = path.join(QA_ROOT, 'live_downloads');
  const UPG_INST_DIR = path.join(QA_ROOT, 'upg_inst');
  const UPG_DATA_DIR = path.join(QA_ROOT, 'upg_data');
  const UPG_DL_DIR = path.join(QA_ROOT, 'upg_dl');
  const UPG_WV2_DIR = path.join(QA_ROOT, 'upg_wv2');
  const SITE_EDGE_PROF = path.join(QA_ROOT, 'site_edge_prof');
  const FF_PROF = path.join(QA_ROOT, 'ff_prof');

  const UPG_PORT = 25340;
  const UPG_CDP_PORT = 25341;
  const FIXTURE_PORT = 25342;
  const SITE_CDP_PORT = 25343;
  const FF_MAR_PORT = 2847;

  const oemGuard = new QaOemStateGuard('gate32_3_live');
  oemGuard.backup({ stopRunningOem: true });
  oemGuard.temporarilySilenceNativeHostAutoSpawn();
  await sleep(600);

  const oemDbBefore = snapshotOemDatabase(OEM_DB_PATH);
  const oemExeShaBefore = sha256File(OEM_EXE_PATH);
  let oemDbAfter = null;
  let fixtureServer = null;

  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  for (const d of [DL_DIR, UPG_INST_DIR, UPG_DATA_DIR, UPG_DL_DIR, UPG_WV2_DIR, SITE_EDGE_PROF, FF_PROF]) {
    fs.mkdirSync(d, { recursive: true });
  }

  try {
    // 1. Live GitHub v1.0.7 Latest Stable & Preservation
    console.log('>>> [1] Live GitHub v1.0.7 Latest Stable & Historical Release Preservation <<<');
    const latestRes = await fetchRaw(`https://api.github.com/repos/${REPO}/releases/latest`, token);
    const latestRel = JSON.parse(latestRes.buf.toString('utf8'));
    const remoteTagSha = execFileSync('git', ['ls-remote', 'origin', 'refs/tags/v1.0.7^{}'], { cwd: ROOT, encoding: 'utf8' }).trim().split(/\s+/)[0];
    record(
      'G323-01',
      'GitHub /releases/latest is Desktop v1.0.7 (stable, non-draft, approved commit, zero companion assets)',
      Boolean(
        latestRel.tag_name === 'v1.0.7' &&
        !latestRel.draft &&
        !latestRel.prerelease &&
        remoteTagSha === APPROVED_COMMIT &&
        latestRel.assets.length === 16 &&
        latestRel.assets.every((a) => !/\.xpi$|companion/i.test(a.name))
      ),
      `id=${latestRel.id}, tag=${latestRel.tag_name}, assets=${latestRel.assets.length}, commit=${remoteTagSha}`
    );

    const v106Res = await fetchRaw(`https://api.github.com/repos/${REPO}/releases/tags/v1.0.6`, token);
    const extRes = await fetchRaw(`https://api.github.com/repos/${REPO}/releases/tags/extension-v1.0.10`, token);
    const ffRes = await fetchRaw(`https://api.github.com/repos/${REPO}/releases/tags/tools-ffmpeg-N-129150-g7ddf7bc8a4`, token);
    const v106Rel = JSON.parse(v106Res.buf.toString('utf8'));
    const extRel = JSON.parse(extRes.buf.toString('utf8'));
    const ffRel = JSON.parse(ffRes.buf.toString('utf8'));
    record(
      'G323-02',
      'Historical Desktop v1.0.6, Browser Companion extension-v1.0.10, and FFmpeg tools prerelease preserved untouched',
      Boolean(v106Res.status === 200 && v106Rel.id === 453599579 && extRes.status === 200 && extRel.id === 451270856 && ffRes.status === 200 && ffRel.id === 453686141 && ffRel.prerelease === true),
      `v106=${v106Rel.id}, ext=${extRel.id}, ffmpegPre=${ffRel.id}`
    );

    // Download PUBLIC v1.0.7 installer & .sig directly from GitHub
    const liveInstPath = path.join(DL_DIR, 'TORI.Download.Manager_1.0.7_x64-setup.exe');
    const liveSigPath = path.join(DL_DIR, 'TORI.Download.Manager_1.0.7_x64-setup.exe.sig');
    const instCode = downloadFileViaCurl(`https://github.com/${REPO}/releases/download/v1.0.7/TORI.Download.Manager_1.0.7_x64-setup.exe`, liveInstPath);
    const sigCode = downloadFileViaCurl(`https://github.com/${REPO}/releases/download/v1.0.7/TORI.Download.Manager_1.0.7_x64-setup.exe.sig`, liveSigPath);
    const liveInstSize = fs.statSync(liveInstPath).size;
    const liveInstSha = sha256File(liveInstPath);
    const liveSigSize = fs.statSync(liveSigPath).size;
    const liveSigSha = sha256File(liveSigPath);
    record(
      'G323-03',
      'Public HTTPS download of Desktop v1.0.7 installer & .sig match frozen approved sizes and SHA-256 bit-for-bit',
      instCode === 200 && sigCode === 200 && liveInstSize === EXPECTED_V107_INSTALLER_SIZE && liveInstSha === EXPECTED_V107_INSTALLER_SHA && liveSigSize === EXPECTED_V107_SIG_SIZE && liveSigSha === EXPECTED_V107_SIG_SHA,
      `inst=${liveInstSize}B (${liveInstSha}), sig=${liveSigSize}B (${liveSigSha})`
    );

    // 2. Live Desktop Auto-Updater latest.json & Upgrade Matrix
    console.log('\n>>> [2] Live Auto-Updater Endpoint (latest.json) & Upgrade Matrix <<<');
    const ljRes = await fetchRaw(`https://github.com/${REPO}/releases/latest/download/latest.json`);
    const lj = JSON.parse(ljRes.buf.toString('utf8'));
    const liveSigTrimmed = fs.readFileSync(liveSigPath, 'utf8').trim();
    const expectedUrl = `https://github.com/${REPO}/releases/download/v1.0.7/TORI.Download.Manager_1.0.7_x64-setup.exe`;
    const ljOk = Boolean(
      ljRes.status === 200 &&
      lj.version === '1.0.7' &&
      !Number.isNaN(Date.parse(lj.pub_date)) &&
      lj.platforms?.['windows-x86_64']?.url === expectedUrl &&
      lj.platforms?.['windows-x86_64-nsis']?.url === expectedUrl &&
      lj.platforms?.['windows-x86_64']?.signature === liveSigTrimmed &&
      lj.platforms?.['windows-x86_64-nsis']?.signature === liveSigTrimmed
    );
    const matrixOk =
      compareSemVer(lj.version, '1.0.5') > 0 &&
      compareSemVer(lj.version, '1.0.6') > 0 &&
      compareSemVer(lj.version, '1.0.7') === 0 &&
      compareSemVer(lj.version, '1.0.8') < 0;
    record(
      'G323-04',
      'Live releases/latest/download/latest.json serves v1.0.7 with verified Ed25519 signature & SemVer upgrade matrix',
      ljOk && matrixOk,
      `status=${ljRes.status}, version=${lj.version}, pub_date=${lj.pub_date}`
    );

    // 3. Live Production Tools Manifest & Browser Companion v1.0.10 Preservation
    console.log('\n>>> [3] Live Production Tools Manifest & Browser Companion v1.0.10 Preservation <<<');
    const prodManRes = await fetchRaw(`${SITE_URL}/assets/tools/tools-manifest.json`);
    const prodSigRes = await fetchRaw(`${SITE_URL}/assets/tools/tools-manifest.json.sig`);
    const prodManSha = crypto.createHash('sha256').update(prodManRes.buf).digest('hex');
    const prodSigSha = crypto.createHash('sha256').update(prodSigRes.buf).digest('hex');
    record(
      'G323-05',
      'Live production /assets/tools/tools-manifest.json & .sig serve HTTP 200 with exact SHA-256 and JSON content-type',
      Boolean(
        prodManRes.status === 200 &&
        prodSigRes.status === 200 &&
        String(prodManRes.headers['content-type'] || '').includes('application/json') &&
        prodManSha === EXPECTED_PROD_MANIFEST_SHA &&
        prodSigSha === EXPECTED_PROD_SIG_SHA
      ),
      `manSha=${prodManSha}, sigSha=${prodSigSha}, ct=${prodManRes.headers['content-type']}`
    );

    const ghXpiPath = path.join(DL_DIR, 'gh_v1010.xpi');
    const siteXpiPath = path.join(DL_DIR, 'site_v1010.xpi');
    const ghChrPath = path.join(DL_DIR, 'gh_v1010_chr.zip');
    const ghXpiCode = downloadFileViaCurl(`https://github.com/${REPO}/releases/download/extension-v1.0.10/tori-companion-v1.0.10-firefox-signed.xpi`, ghXpiPath);
    const ghChrCode = downloadFileViaCurl(`https://github.com/${REPO}/releases/download/extension-v1.0.10/tori-companion-v1.0.10-chromium.zip`, ghChrPath);
    const siteXpiRes = await fetchRaw(`${SITE_URL}/assets/tori-download-manager-firefox-v1.0.10.xpi`);
    fs.writeFileSync(siteXpiPath, siteXpiRes.buf);

    const ghXpiSha = sha256File(ghXpiPath);
    const siteXpiSha = sha256File(siteXpiPath);
    const ghChrSha = sha256File(ghChrPath);
    const siteXpiMime = String(siteXpiRes.headers['content-type'] || '').toLowerCase();
    record(
      'G323-06',
      'Live Browser Companion v1.0.10 Firefox XPI (GitHub & Website) & Chromium ZIP hashes & XPI MIME intact',
      Boolean(
        ghXpiCode === 200 && ghXpiSha === EXPECTED_XPI_SHA && fs.statSync(ghXpiPath).size === EXPECTED_XPI_SIZE &&
        siteXpiRes.status === 200 && siteXpiSha === EXPECTED_XPI_SHA && siteXpiMime.includes('application/x-xpinstall') &&
        ghChrCode === 200 && ghChrSha === EXPECTED_CHR_SHA && fs.statSync(ghChrPath).size === EXPECTED_CHR_SIZE
      ),
      `ghXpi=${ghXpiSha}, siteMime=${siteXpiMime}, ghChr=${ghChrSha}`
    );

    // 4. Live Website Verification (HTTPS + Desktop 1440x900 & Mobile 390x844)
    console.log('\n>>> [4] Live Website Verification (https://toridownload.xyz Desktop & Mobile) <<<');
    const siteHomeRes = await fetchRaw(`${SITE_URL}/`);
    const sitemapRes = await fetchRaw(`${SITE_URL}/sitemap.xml`);
    const robotsRes = await fetchRaw(`${SITE_URL}/robots.txt`);
    const homeHtml = siteHomeRes.buf.toString('utf8');
    record(
      'G323-07',
      'Live toridownload.xyz serves HTTPS 200 with Desktop v1.0.7 + Companion v1.0.10 + updated sitemap',
      Boolean(
        siteHomeRes.status === 200 &&
        homeHtml.includes('TORI.Download.Manager_1.0.7_x64-setup.exe') &&
        homeHtml.includes(EXPECTED_V107_INSTALLER_SHA) &&
        homeHtml.includes('Companion v1.0.10') &&
        homeHtml.includes(EXPECTED_XPI_SHA) &&
        homeHtml.includes(EXPECTED_CHR_SHA) &&
        sitemapRes.status === 200 && sitemapRes.buf.toString('utf8').includes('2026-11-22') &&
        robotsRes.status === 200
      ),
      `home=${siteHomeRes.status}, sitemap=${sitemapRes.status}, robots=${robotsRes.status}`
    );

    const edgeProc = spawn(
      EDGE_EXE,
      [
        '--headless=new',
        `--user-data-dir=${SITE_EDGE_PROF}`,
        `--remote-debugging-port=${SITE_CDP_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        `${SITE_URL}/`,
      ],
      { stdio: 'ignore' }
    );
    trackedProcs.add(edgeProc);
    let edgePageWs = null;
    for (let i = 0; i < 35; i++) {
      await sleep(250);
      const t = (await listCdpTargets(SITE_CDP_PORT)).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) { edgePageWs = t.webSocketDebuggerUrl; break; }
    }
    const siteCdp = new CDPClient(edgePageWs);
    await siteCdp.connect();
    await siteCdp.send('Page.enable');
    await siteCdp.send('Runtime.enable');
    await sleep(1600);

    const auditViewport = async (w, h, hash) => {
      await siteCdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
      await siteCdp.eval(`(location.hash = ${JSON.stringify(hash)}, true)`);
      await sleep(450);
      return await siteCdp.eval(`(() => {
        const imgs = Array.from(document.querySelectorAll('img')).filter(i => i.offsetParent !== null);
        const brokenImgs = imgs.filter(i => i.complete && i.naturalWidth === 0).length;
        return {
          view: document.body.getAttribute('data-view'),
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
          brokenImgs,
          heroPill: document.getElementById('hero-pill-text')?.textContent?.trim(),
          heroHref: document.getElementById('hero-dl-btn')?.getAttribute('href'),
          mainHref: document.getElementById('main-dl-btn')?.getAttribute('href'),
          statVer: document.getElementById('stat-ver')?.textContent?.trim(),
          ffHref: document.getElementById('ext-firefox-btn')?.getAttribute('href'),
          extHref: document.getElementById('ext-dl-btn')?.getAttribute('href'),
          footerVer: document.getElementById('footer-ver-badge')?.textContent?.trim(),
        };
      })()`);
    };

    const deskTop = await auditViewport(1440, 900, '#top');
    const deskDl = await auditViewport(1440, 900, '#download');
    const deskExt = await auditViewport(1440, 900, '#extension');
    const mobTop = await auditViewport(390, 844, '#top');
    const mobDl = await auditViewport(390, 844, '#download');
    const mobExt = await auditViewport(390, 844, '#extension');
    siteCdp.close();
    killProcTree(edgeProc.pid);
    trackedProcs.delete(edgeProc);

    const layoutsOk = [deskTop, deskDl, deskExt, mobTop, mobDl, mobExt].every((v) => !v.overflowX && v.brokenImgs === 0);
    const linksOk =
      String(deskTop.heroHref).includes('/v1.0.7/TORI.Download.Manager_1.0.7_x64-setup.exe') &&
      String(deskDl.mainHref).includes('/v1.0.7/TORI.Download.Manager_1.0.7_x64-setup.exe') &&
      deskDl.statVer === '1.0.7' &&
      String(deskExt.ffHref) === '/assets/tori-download-manager-firefox-v1.0.10.xpi' &&
      String(deskExt.extHref).includes('/extension-v1.0.10/tori-companion-v1.0.10-chromium.zip') &&
      String(deskTop.footerVer).includes('v1.0.7') &&
      String(deskTop.footerVer).includes('Companion v1.0.10');
    record(
      'G323-08',
      'Live website Desktop (1440x900) & Mobile (390x844) render Desktop v1.0.7 + Companion v1.0.10 with zero overflow or broken images',
      layoutsOk && linksOk,
      JSON.stringify({ layoutsOk, linksOk, statVer: deskDl.statVer, heroPill: deskTop.heroPill, footerVer: deskTop.footerVer })
    );

    // 5. Physical Isolated Upgrade (v1.0.6 -> LIVE-DOWNLOADED PUBLIC v1.0.7) + Runtime + Tools + Companion v1.0.10
    console.log('\n>>> [5] Physical Isolated Upgrade (v1.0.6 -> Live-Downloaded Public v1.0.7) & Live Integration <<<');
    const upgDb = path.join(UPG_DATA_DIR, 'tdm_storage.sqlite');
    fs.copyFileSync(BACKUP_ONLINE_DB, upgDb);
    const partPath = path.join(UPG_DL_DIR, 'pre_upgrade_partial.bin.tdm-part');
    fs.writeFileSync(partPath, crypto.randomBytes(65536));
    const partShaBefore = sha256File(partPath);
    const upgToken = 'tori_g32_3_live_upg_token';
    execFileSync('python', [
      '-c',
      `import sqlite3, json, sys
c=sqlite3.connect(sys.argv[1]); cur=c.cursor()
cfg=json.loads(cur.execute("SELECT value FROM engine_settings WHERE key='app_settings'").fetchone()[0])
cfg['port']=int(sys.argv[2]); cfg['key']=sys.argv[3]; cfg['dir']=sys.argv[4]; cfg['showDownloadPopup']='always'; cfg['closeToTray']=True
cur.execute("UPDATE engine_settings SET value=? WHERE key='app_settings'", (json.dumps(cfg),))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES('server_port',?)", (sys.argv[2],))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES('browser_integration_token',?)", (sys.argv[3],))
c.commit(); c.close()`,
      upgDb,
      String(UPG_PORT),
      upgToken,
      UPG_DL_DIR,
    ]);

    // Step 5A: Install baseline v1.0.6
    execSync(`"${V106_INSTALLER}" /S /D=${UPG_INST_DIR}`, { timeout: 90000 });
    oemGuard.temporarilySilenceNativeHostAutoSpawn();
    const upgExe = path.join(UPG_INST_DIR, 'tori-download-manager.exe');
    const verBefore = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${upgExe}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim();

    // Step 5B: Upgrade in-place using LIVE-DOWNLOADED PUBLIC v1.0.7 installer!
    execSync(`"${liveInstPath}" /S /D=${UPG_INST_DIR}`, { timeout: 90000 });
    oemGuard.temporarilySilenceNativeHostAutoSpawn();
    const verAfter = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${upgExe}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim();
    const hostAfterSha = sha256File(path.join(UPG_INST_DIR, 'bin', 'tdm-native-host.exe'));

    // Start local HTTP fixture server (for IDM progress window Pause/Resume + Firefox MKV capture)
    const payload = Buffer.alloc(6 * 1024 * 1024, 0x5a);
    const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');
    const mkvPayload = Buffer.concat([Buffer.from('1a45dfa3934282886d6174726f736b61', 'hex'), crypto.randomBytes(1024 * 1024)]);
    const mkvSha = crypto.createHash('sha256').update(mkvPayload).digest('hex');
    fixtureServer = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${FIXTURE_PORT}`);
      if (u.pathname === '/ff_capture.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><a id="dl" href="/public_v107_capture.mkv">Download MKV</a></body></html>');
        return;
      }
      if (u.pathname === '/public_v107_capture.mkv') {
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': String(mkvPayload.length), 'Accept-Ranges': 'bytes', 'Content-Type': 'video/x-matroska', 'Content-Disposition': 'attachment; filename="public_v107_capture.mkv"' });
          return res.end();
        }
        res.writeHead(200, { 'Content-Length': String(mkvPayload.length), 'Accept-Ranges': 'bytes', 'Content-Type': 'video/x-matroska', 'Content-Disposition': 'attachment; filename="public_v107_capture.mkv"' });
        return res.end(mkvPayload);
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': String(payload.length), 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' });
        return res.end();
      }
      let start = 0, end = payload.length - 1, status = 200;
      if (req.headers.range?.startsWith('bytes=')) {
        const [s, e] = req.headers.range.slice(6).split('-');
        start = s ? parseInt(s, 10) : 0;
        end = e ? Math.min(parseInt(e, 10), payload.length - 1) : payload.length - 1;
        status = 206;
      }
      const hdrs = { 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' };
      if (status === 206) hdrs['Content-Range'] = `bytes ${start}-${end}/${payload.length}`;
      res.writeHead(status, hdrs);
      let off = start;
      const t = setInterval(() => {
        if (res.destroyed) { clearInterval(t); return; }
        const nx = Math.min(off + 32768, end + 1);
        res.write(payload.subarray(off, nx));
        off = nx;
        if (off > end) { clearInterval(t); res.end(); }
      }, 15);
      req.on('close', () => clearInterval(t));
    });
    await new Promise((r) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', r));

    // Boot upgraded PUBLIC v1.0.7 with ZERO staging overrides!
    const upgPipe = `\\\\.\\pipe\\tori-qa-g323-live-${process.pid}`;
    const sess = await launchIsolatedApp({
      exePath: upgExe,
      dataDir: UPG_DATA_DIR,
      dlDir: UPG_DL_DIR,
      wv2Dir: UPG_WV2_DIR,
      cdpPort: UPG_CDP_PORT,
      pipeName: upgPipe,
    });
    const mCdp = sess.cdp;
    await sleep(900);

    const upgAppVer = await mCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_app_version')`);
    const upgList = await mCdp.eval(`window.__TAURI_INTERNALS__.invoke('list_downloads')`);
    const upgCfg = await mCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_engine_settings')`);
    const partShaAfter = sha256File(partPath);

    record(
      'G323-09',
      'Physical isolated upgrade (v1.0.6 -> public downloaded v1.0.7) upgrades PE/host cleanly & preserves 42 rows, settings & .tdm-part',
      Boolean(
        verBefore === '1.0.6' &&
        verAfter === '1.0.7' &&
        hostAfterSha === EXPECTED_V107_HOST_SHA &&
        upgAppVer === '1.0.7' &&
        Array.isArray(upgList) && upgList.length === 42 &&
        upgCfg?.theme === 'dark' && upgCfg?.accent === 'rose' &&
        partShaAfter === partShaBefore
      ),
      JSON.stringify({ verBefore, verAfter, upgAppVer, preservedRows: upgList?.length, partUnchanged: partShaAfter === partShaBefore })
    );

    // Close-to-tray + IDM Progress Window + Pause/Resume + Completion (zero legacy toast)
    await mCdp.eval(`window.__TAURI_INTERNALS__.invoke('window_close')`);
    await sleep(400);
    const hiddenOk = (await mCdp.eval(`window.__TAURI__.window.getCurrentWindow().isVisible()`)) === false;

    const dlRes = await httpJson({
      port: UPG_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': upgToken },
      body: { url: `http://127.0.0.1:${FIXTURE_PORT}/live_public_v107.bin`, filename: 'live_public_v107.bin' },
    });
    const jid = dlRes.data?.job_id;
    let popWs = null;
    for (let i = 0; i < 40; i++) {
      const hit = (await listCdpTargets(UPG_CDP_PORT)).find((t) => t.webSocketDebuggerUrl && getProgressJobId(t) === jid);
      if (hit) { popWs = hit.webSocketDebuggerUrl; break; }
      await sleep(200);
    }
    const pCdp = new CDPClient(popWs);
    await pCdp.connect();
    await sleep(750);
    const popDiag = await pCdp.eval(`({
      isIdm: Boolean(document.querySelector('.dl-popup-root #w') && document.querySelectorAll('.dl-tabs .dl-tab').length === 3),
      legacyToast: Boolean(document.querySelector('.toast-card, .toast-stack, svg circle[stroke-dasharray]')),
      label: window.__TAURI__?.window?.getCurrentWindow()?.label || ''
    })`);
    await pCdp.eval(`document.querySelector('.dl-foot .dl-btn.pri')?.click()`, true);
    await sleep(600);
    const stPaused = (await httpJson({ port: UPG_PORT, reqPath: `/api/v1/downloads/${jid}`, headers: { 'X-Tori-Token': upgToken } })).data?.state;
    await pCdp.eval(`document.querySelector('.dl-foot .dl-btn.pri')?.click()`, true);
    let done = false;
    for (let i = 0; i < 70; i++) {
      const s = (await httpJson({ port: UPG_PORT, reqPath: `/api/v1/downloads/${jid}`, headers: { 'X-Tori-Token': upgToken } })).data?.state;
      if (s === 'completed') { done = true; break; }
      await sleep(300);
    }
    const fullJob = await mCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(jid)} })`);
    const liveDlShaOk = sha256File(fullJob?.target_path || path.join(UPG_DL_DIR, 'live_public_v107.bin')) === payloadSha;
    pCdp.close();
    await mCdp.eval(`window.__TAURI_INTERNALS__.invoke('show_main_window')`);
    record(
      'G323-10',
      'Public v1.0.7 Close-to-Tray, standalone IDM Progress Window (no legacy toast), Pause/Resume & exact SHA-256 pass',
      Boolean(hiddenOk && popDiag.isIdm && !popDiag.legacyToast && popDiag.label.startsWith('progress_') && stPaused === 'paused' && done && liveDlShaOk),
      JSON.stringify({ hiddenOk, popDiag, stPaused, done, liveDlShaOk })
    );

    // Production default External Tools check (NO env override!) + live yt-dlp OpenPGP update & rollback
    await mCdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: { auto_update: true, check_interval_hours: 24, auto_install: false, notify_on_update: true, defer_while_in_use: true }
      });
    `);
    const toolsChk = await mCdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');`);
    const manState = readIsolatedManifestState(upgDb);
    const tFf = toolsChk.tools.find((t) => t.tool_id === 'ffmpeg');
    const tYt = toolsChk.tools.find((t) => t.tool_id === 'yt-dlp');
    await mCdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: { auto_update: true, check_interval_hours: 24, auto_install: true, notify_on_update: true, defer_while_in_use: true }
      });
    `);
    const ytUp = await mCdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'yt-dlp' });`, 180000);
    const ytUpRec = ytUp.tools.find((t) => t.tool_id === 'yt-dlp');
    const ytRb = await mCdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('rollback_external_tool', { toolId: 'yt-dlp' });`, 60000);
    const ytRbRec = ytRb.tools.find((t) => t.tool_id === 'yt-dlp');
    record(
      'G323-11',
      'Public v1.0.7 verifies PRODUCTION manifest (rev 1) by default & executes live OpenPGP yt-dlp update + rollback',
      Boolean(
        tFf?.update_status === 'update_available' &&
        tFf?.available_version === EXPECTED_FFMPEG_VER &&
        manState.last_accepted_manifest_sha256 === EXPECTED_PROD_MANIFEST_SHA &&
        tYt?.update_status === 'update_available' &&
        ytUpRec?.source === 'managed' &&
        ytRbRec?.source === 'bundled'
      ),
      `manSha=${manState.last_accepted_manifest_sha256}, ffAvail=${tFf?.available_version}, ytUp=${ytUpRec?.installed_version}, ytRb=${ytRbRec?.installed_version}`
    );

    // Native Messaging stdio host ping + Signed Firefox Companion v1.0.10 live capture into public v1.0.7
    const hostExe = path.join(UPG_INST_DIR, 'bin', 'tdm-native-host.exe');
    const nmMsg = Buffer.from(JSON.stringify({ action: 'ping' }), 'utf8');
    const nmFrame = Buffer.alloc(4 + nmMsg.length);
    nmFrame.writeUInt32LE(nmMsg.length, 0);
    nmMsg.copy(nmFrame, 4);
    const nmRes = spawnSync(hostExe, [], {
      input: nmFrame,
      env: { ...process.env, TORI_IPC_PIPE: upgPipe, TORI_DISABLE_AUTO_SPAWN: '1' },
      timeout: 15000,
    });
    let nmResp = null;
    if (nmRes.stdout && nmRes.stdout.length >= 4) {
      const rLen = nmRes.stdout.readUInt32LE(0);
      nmResp = JSON.parse(nmRes.stdout.subarray(4, 4 + rLen).toString('utf8'));
    }

    // Wire Firefox Native Messaging to the isolated public v1.0.7 native host & pipe (restored by QaOemStateGuard)
    const qaNmBat = path.join(QA_ROOT, 'nm_host_public_v107.cmd');
    fs.writeFileSync(
      qaNmBat,
      `@echo off\r\nset TORI_DATA_DIR=${UPG_DATA_DIR}\r\nset TORI_IPC_PIPE=${upgPipe}\r\nset TORI_DISABLE_AUTO_SPAWN=1\r\n"${hostExe}" %*\r\n`
    );
    const qaFfNmJson = path.join(QA_ROOT, 'com.tori.download_manager.firefox.json');
    fs.writeFileSync(
      qaFfNmJson,
      JSON.stringify({
        name: 'com.tori.download_manager',
        description: 'TORI Public v1.0.7 QA Native Host (Firefox)',
        path: qaNmBat,
        type: 'stdio',
        allowed_extensions: [EXPECTED_GECKO_ID],
      }, null, 2)
    );
    execFileSync('reg', ['add', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', qaFfNmJson, '/f'], { stdio: 'ignore' });

    // Install live-downloaded website Firefox Companion v1.0.10 XPI permanently under strict signature enforcement & capture MKV!
    const ffDlDir = path.join(QA_ROOT, 'ff_dl');
    fs.mkdirSync(ffDlDir, { recursive: true });
    fs.writeFileSync(path.join(FF_PROF, 'user.js'), [
      'user_pref("marionette.enabled", true);',
      `user_pref("marionette.port", ${FF_MAR_PORT});`,
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("xpinstall.signatures.required", true);',
      'user_pref("extensions.autoDisableScopes", 0);',
      'user_pref("browser.download.folderList", 2);',
      `user_pref("browser.download.dir", ${JSON.stringify(ffDlDir)});`,
    ].join('\n'));
    const ffProc = spawn(FIREFOX_EXE, ['-no-remote', '-marionette', '-profile', FF_PROF, 'about:blank'], {
      env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
      stdio: 'ignore',
    });
    trackedProcs.add(ffProc);
    const mar = new MarionetteClient(FF_MAR_PORT);
    await mar.connect(25000);
    await mar.send('WebDriver:NewSession', { capabilities: {} });
    const ffInst = await mar.send('Addon:Install', { path: siteXpiPath, temporary: false }, 25000);
    await mar.send('Marionette:SetContext', { value: 'chrome' });
    const ffSig = (await mar.send('WebDriver:ExecuteAsyncScript', {
      script: `
        const done = arguments[arguments.length - 1];
        (async () => {
          const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
          const addon = await AddonManager.getAddonByID("${EXPECTED_GECKO_ID}");
          const policy = WebExtensionPolicy.getByID("${EXPECTED_GECKO_ID}");
          done({ id: addon?.id, version: addon?.version, active: !!addon?.isActive, signed: addon?.signedState === AddonManager.SIGNEDSTATE_SIGNED, temporary: addon?.temporarilyInstalled, baseUrl: policy?.getURL("") });
        })();
      `,
      args: [],
    }, 15000))?.value;

    await mar.send('Marionette:SetContext', { value: 'content' });
    const beforeIds = new Set(((await httpJson({ port: UPG_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': upgToken } })).data?.jobs || []).map((j) => j.id));
    await mar.send('WebDriver:Navigate', { url: `http://127.0.0.1:${FIXTURE_PORT}/ff_capture.html` });
    await sleep(1500);
    await mar.send('WebDriver:ExecuteScript', { script: `document.getElementById('dl').click();`, args: [] });

    let capturedJob = null;
    for (let i = 0; i < 60; i++) {
      const jobs = (await httpJson({ port: UPG_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': upgToken } })).data?.jobs || [];
      const added = jobs.filter((j) => !beforeIds.has(j.id));
      const doneJob = added.find((j) => j.state === 'completed');
      if (doneJob) {
        const det = await httpJson({ port: UPG_PORT, reqPath: `/api/v1/downloads/${doneJob.id}`, headers: { 'X-Tori-Token': upgToken } });
        capturedJob = { count: added.length, job: det.data || doneJob };
        break;
      }
      await sleep(300);
    }
    try { await mar.send('Marionette:Quit', {}); } catch {}
    mar.close();
    killProcTree(ffProc.pid);
    trackedProcs.delete(ffProc);
    oemGuard.temporarilySilenceNativeHostAutoSpawn();

    const ffCapShaOk = Boolean(capturedJob && capturedJob.count === 1 && sha256File(capturedJob.job?.target_path) === mkvSha);
    // Verify Chromium v1.0.10 ZIP structure + Native Messaging host manifests & origins (Chrome, Edge, Firefox)
    const chrCheck = JSON.parse(execFileSync('python', [
      '-c',
      `import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'r') as z:
    m = json.loads(z.read('manifest.json').decode('utf-8'))
    cjs = len(z.read('content.js'))
print(json.dumps({'ver': m.get('version'), 'mv': m.get('manifest_version'), 'contentJsBytes': cjs}))`,
      ghChrPath,
    ], { encoding: 'utf8' }).trim());
    record(
      'G323-12',
      'Public v1.0.7 Native Messaging stdio host, Chromium v1.0.10 package & live Mozilla-signed Firefox Companion v1.0.10 MKV capture pass',
      Boolean(
        nmRes.status === 0 && nmResp?.action === 'pong' &&
        chrCheck.ver === '1.0.10' && chrCheck.mv === 3 && chrCheck.contentJsBytes > 100000 &&
        ffInst?.value === EXPECTED_GECKO_ID && ffSig?.version === '1.0.10' && ffSig?.signed === true && ffSig?.temporary === false && ffCapShaOk
      ),
      JSON.stringify({ nmAction: nmResp?.action, chrVer: chrCheck.ver, chrContentBytes: chrCheck.contentJsBytes, ffVer: ffSig?.version, ffSigned: ffSig?.signed, newJobs: capturedJob?.count, shaOk: ffCapShaOk })
    );

    // Warm restart of upgraded public v1.0.7 -> verify downloads, settings, and tool update history persist cleanly
    mCdp.close();
    killProcTree(sess.proc.pid);
    trackedProcs.delete(sess.proc);
    await sleep(600);

    const warmSess = await launchIsolatedApp({
      exePath: upgExe,
      dataDir: UPG_DATA_DIR,
      dlDir: UPG_DL_DIR,
      wv2Dir: UPG_WV2_DIR,
      cdpPort: UPG_CDP_PORT,
      pipeName: `${upgPipe}_warm`,
    });
    const wCdp = warmSess.cdp;
    await sleep(700);
    const warmVer = await wCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_app_version')`);
    const warmList = await wCdp.eval(`window.__TAURI_INTERNALS__.invoke('list_downloads')`);
    const warmHist = await wCdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_external_tool_update_history', { limit: 50 });`);
    wCdp.close();
    killProcTree(warmSess.proc.pid);
    trackedProcs.delete(warmSess.proc);
    await sleep(500);
    record(
      'G323-13',
      'Upgraded public v1.0.7 warm restart preserves app version, all downloads (42+2), and SQLite tool update history',
      Boolean(warmVer === '1.0.7' && Array.isArray(warmList) && warmList.length === 44 && Array.isArray(warmHist) && warmHist.length >= 2),
      JSON.stringify({ warmVer, warmStartupMs: warmSess.startupMs, downloads: warmList?.length, toolHistory: warmHist?.length })
    );
  } finally {
    cleanupProcs();
    if (fixtureServer) try { fixtureServer.close(); } catch {}
    oemDbAfter = snapshotOemDatabase(OEM_DB_PATH);
    try { fs.rmSync(QA_ROOT, { recursive: true, force: true }); } catch {}
    const parity = oemGuard.restore({ qaPathMarker: 'gate32_3_live_qa', restartOem: true });
    const dbCmp = compareOemDatabaseSnapshots(oemDbBefore, oemDbAfter);
    const oemExeMatch = sha256File(OEM_EXE_PATH) === oemExeShaBefore;
    record(
      'G323-14',
      'Production Windows Registry, Native Messaging, SQLite DB (42 rows), 11 .tdm-part files & OEM v1.0.6 binary 100% preserved',
      Boolean(parity?.ok && dbCmp?.ok && oemExeMatch),
      JSON.stringify({ regOk: parity?.ok, dbOk: dbCmp?.ok, rawShaMatch: dbCmp?.rawFileSha256Match, oemExeMatch })
    );
  }

  console.log(`\n=============================================================================`);
  console.log(` GATE 32.3 LIVE PUBLIC VERIFICATION: ${counts.PASS} PASS, ${counts.FAIL} FAIL`);
  console.log(`=============================================================================`);
  if (counts.FAIL > 0) process.exit(1);
}

(async () => {
  const mode = process.argv[2];
  if (mode === '--phase5-prod-manifest') {
    await runPhase5ProdManifestAcceptance();
  } else if (mode === '--post-release') {
    await runFullPostReleaseVerification();
  } else {
    console.error('Usage: node scripts/verify_gate32_3_public_release.js [--phase5-prod-manifest|--post-release]');
    process.exit(1);
  }
})().catch((err) => {
  console.error('[FATAL]', err);
  cleanupProcs();
  process.exit(1);
});
