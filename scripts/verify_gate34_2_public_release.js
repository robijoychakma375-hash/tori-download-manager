#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 34.2
 * Complete Live Public Stable Desktop v1.0.8 Release Verification Suite
 * (Phases 13, 14, 15, 16, 17, 19 & 21)
 *
 * Strictly isolated under target/gate34_2_live_qa with QaOemStateGuard.
 * Uses ZERO TORI_TEST_TOOLS_MANIFEST_URL overrides so the compiled production
 * default endpoint (https://toridownload.xyz/assets/tools/tools-manifest.json)
 * and live GitHub Auto-Updater endpoint (releases/latest/download/latest.json)
 * are exercised live end-to-end.
 *
 * Never mutates the operator's OEM Desktop installation, SQLite database,
 * partial downloads (.tdm-part), or production Windows Registry state.
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
const APPROVED_COMMIT = '1a24265d247a43371ab2b637e195425df2c78b82';
const LEGACY_KEY_ID = 'CDC23D8CC8DA5397';
const DEDICATED_KEY_ID = 'C3FD6626A3718E63';
const LEGACY_PUBKEY_B64 =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENEQzIzRDhDQzhEQTUzOTcKUldTWFU5cklqRDNDelRBOVAzOSs1L0RXN0FFLy9YWGFJc2NnUStaNktxSkNOQ1ZCeG01MjFTZzQK';

const EXPECTED_RELEASE_ID = 455125259;
const EXPECTED_V108_INSTALLER_SIZE = 118110372;
const EXPECTED_V108_INSTALLER_SHA = '728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb';
const EXPECTED_V108_SIG_SIZE = 436;
const EXPECTED_V108_SIG_SHA = '8f2bc20bd2c8994ac04d8d2fc84be37b5569f11caeb47b63f369a4c72b44294c';
const EXPECTED_V108_HOST_SHA = '703a901c4b0be3c6f956d726e8d0551ba9fe9ea319a4d8cbd76ca9eefddaacdd';

const EXPECTED_PROD_REV2_SHA = 'caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a';
const EXPECTED_PROD_REV2_SIG_SHA = '11efa53f290d3d46fb16915fd3d1e69451de8c654eae8d75844b840ab99bb1c2';
const EXPECTED_PROD_REV2_EXP = '2027-01-21T19:46:42.049Z';
const EXPECTED_FFMPEG_VER = 'N-129150-g7ddf7bc8a4-20261120';
const EXPECTED_FFMPEG_BUNDLED = 'N-126374-g089a48eb36-20260831';
const EXPECTED_FFMPEG_SIZE = 205445856;
const EXPECTED_FFMPEG_URL =
  'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/tools-ffmpeg-N-129150-g7ddf7bc8a4/ffmpeg-N-129150-g7ddf7bc8a4-win64-gpl.zip';

const EXPECTED_XPI_SIZE = 107499;
const EXPECTED_XPI_SHA = 'a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8';
const EXPECTED_CHR_SIZE = 90964;
const EXPECTED_CHR_SHA = 'f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1';
const EXPECTED_GECKO_ID = 'tori-download-manager@toridm.org';

const V107_INSTALLER = path.join(ROOT, 'release', 'v1.0.7-rc', 'TORI Download Manager_1.0.7_x64-setup.exe');
const BACKUP_ONLINE_DB = 'C:\\Users\\ritud\\.tori-release-backups\\gate32_3_pre_pub_20261122\\appdata\\tdm_storage.online_backup.sqlite';
const OEM_DB_PATH = path.join(process.env.APPDATA || '', 'tori-download-manager', 'tdm_storage.sqlite');
const OEM_EXE_PATH = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'tori-download-manager.exe');
const OEM_DOWNLOADS_DIR = path.join(process.env.USERPROFILE || '', 'Downloads');

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

function verifyMinisignB64(pubkeyB64, dataBuf, sigB64) {
  const decodedPub = Buffer.from(pubkeyB64.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  const pkRaw = Buffer.from(decodedPub[1].trim(), 'base64');
  const keyId = pkRaw.subarray(2, 10);
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pkRaw.subarray(10, 42)]);
  const pubKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const sigText = Buffer.from(sigB64.trim(), 'base64').toString('utf8').trim();
  const lines = sigText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const sigRaw = Buffer.from(lines[1], 'base64');
  const alg = sigRaw.subarray(0, 2).toString('ascii');
  if (!sigRaw.subarray(2, 10).equals(keyId)) return false;
  const sigBytes = sigRaw.subarray(10, 74);
  const tc = lines[2].slice('trusted comment: '.length);
  const gsig = Buffer.from(lines[3], 'base64');
  const payload = alg === 'ED' ? crypto.createHash('blake2b512').update(dataBuf).digest() : dataBuf;
  return (
    crypto.verify(null, payload, pubKey, sigBytes) &&
    crypto.verify(null, Buffer.concat([sigBytes, Buffer.from(tc, 'utf8')]), pubKey, gsig)
  );
}

function verifyMinisignFile(pubkeyB64, filePath, sigB64) {
  const decodedPub = Buffer.from(pubkeyB64.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  const pkRaw = Buffer.from(decodedPub[1].trim(), 'base64');
  const keyId = pkRaw.subarray(2, 10);
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pkRaw.subarray(10, 42)]);
  const pubKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const sigText = Buffer.from(sigB64.trim(), 'base64').toString('utf8').trim();
  const lines = sigText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const sigRaw = Buffer.from(lines[1], 'base64');
  const alg = sigRaw.subarray(0, 2).toString('ascii');
  if (!sigRaw.subarray(2, 10).equals(keyId)) return false;
  const sigBytes = sigRaw.subarray(10, 74);
  const tc = lines[2].slice('trusted comment: '.length);
  const gsig = Buffer.from(lines[3], 'base64');
  let payload;
  if (alg === 'ED') {
    const h = crypto.createHash('blake2b512');
    const fd = fs.openSync(filePath, 'r');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    try {
      let n;
      while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) h.update(chunk.subarray(0, n));
    } finally {
      fs.closeSync(fd);
    }
    payload = h.digest();
  } else {
    payload = fs.readFileSync(filePath);
  }
  return (
    crypto.verify(null, payload, pubKey, sigBytes) &&
    crypto.verify(null, Buffer.concat([sigBytes, Buffer.from(tc, 'utf8')]), pubKey, gsig)
  );
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

function fetchRaw(url, { token = null, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const redirects = [];
    const go = (u, left = 8) => {
      const pu = new URL(u);
      const headers = {
        'User-Agent': 'TORI-Gate34-2-Live-Verifier/1.0.8',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache',
      };
      if (token && pu.hostname === 'api.github.com') {
        headers.Authorization = `Bearer ${token}`;
        headers.Accept = 'application/vnd.github+json';
      }
      const req = https.request(
        { hostname: pu.hostname, port: pu.port || 443, path: pu.pathname + pu.search, method, headers, timeout: 25000 },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
            const next = new URL(res.headers.location, u).toString();
            redirects.push({ status: res.statusCode, location: next });
            res.resume();
            return go(next, left - 1);
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode, headers: res.headers, finalUrl: u, redirects, buf: Buffer.concat(chunks) })
          );
        }
      );
      req.on('timeout', () => req.destroy(new Error(`HTTPS timeout on ${u}`)));
      req.on('error', reject);
      req.end();
    };
    go(url);
  });
}

function downloadFileViaCurl(url, destPath) {
  const res = spawnSync(
    'curl.exe',
    [
      '-sS', '-L', '--http1.1', '--retry', '4', '--retry-delay', '2',
      '-o', destPath, '-w', '%{http_code}',
      '-H', 'User-Agent: TORI-Gate34-2-Live-Verifier/1.0.8',
      '-H', 'Cache-Control: no-cache',
      url,
    ],
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

function countOemTdmParts() {
  if (!fs.existsSync(OEM_DOWNLOADS_DIR)) return { count: 0, hashes: {} };
  const files = fs.readdirSync(OEM_DOWNLOADS_DIR).filter((f) => f.endsWith('.tdm-part')).sort();
  const hashes = {};
  for (const f of files) {
    const p = path.join(OEM_DOWNLOADS_DIR, f);
    hashes[f] = { size: fs.statSync(p).size, sha256: sha256File(p) };
  }
  return { count: files.length, hashes };
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  async connect(timeoutMs = 15000) {
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
    const raw = await this.eval(
      `(async () => { const __r = await (async () => { ${body} })(); return JSON.stringify(__r === undefined ? null : __r); })()`,
      false,
      timeoutMs
    );
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

function inspectSqliteIntegrity(dbPath) {
  const out = execFileSync(
    'python',
    [
      '-c',
      `import sqlite3, json, sys
c=sqlite3.connect(sys.argv[1])
ic=c.execute('PRAGMA integrity_check').fetchone()[0]
dl=c.execute('SELECT COUNT(*) FROM downloads').fetchone()[0]
ch=c.execute('SELECT COUNT(*) FROM download_chunks').fetchone()[0]
c.close()
print(json.dumps({'integrity': ic, 'downloads': dl, 'chunks': ch}))`,
      dbPath,
    ],
    { encoding: 'utf8', timeout: 8000 }
  ).trim();
  return JSON.parse(out);
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
  run(ffmpegExe, ['-y', '-i', vPath, '-i', aPath, '-c', 'copy', '-metadata', 'title=TORI_PROD_34_2', '-movflags', '+faststart', mp4Path], 'merge mp4');
  run(ffmpegExe, ['-y', '-i', mp4Path, '-c', 'copy', mkvPath], 'remux mkv');
  const m3u8 = path.join(hlsDir, 'playlist.m3u8');
  run(ffmpegExe, ['-y', '-i', mp4Path, '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', m3u8], 'gen hls');
  run(ffmpegExe, ['-y', '-allowed_extensions', 'ALL', '-i', m3u8, '-c', 'copy', hlsOut], 'remux hls');

  const probe = (f) =>
    JSON.parse(
      run(
        ffprobeExe,
        ['-v', 'error', '-show_entries', 'format=duration,size:format_tags=title:stream=codec_type,codec_name,width,height', '-of', 'json', f],
        `ffprobe ${path.basename(f)}`
      )
    );
  for (const [label, f, wantTitle] of [
    ['mp4', mp4Path, true],
    ['mkv', mkvPath, true],
    ['hls', hlsOut, false],
  ]) {
    const p = probe(f);
    const streams = p.streams || [];
    const hasV = streams.some((s) => s.codec_type === 'video' && s.codec_name === 'h264');
    const hasA = streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac');
    const dur = parseFloat(p.format?.duration || '0');
    if (!hasV || !hasA || !(dur >= 1.8 && dur <= 2.3)) throw new Error(`Probe failed on ${label}`);
    if (wantTitle && p.format?.tags?.title !== 'TORI_PROD_34_2') throw new Error(`Metadata lost on ${label}`);
  }
  return { ffVer, fpVer, mp4Size: fs.statSync(mp4Path).size, mkvSize: fs.statSync(mkvPath).size, hlsSize: fs.statSync(hlsOut).size };
}

async function launchIsolatedApp({ exePath, dataDir, dlDir, wv2Dir, cdpPort, pipeName }) {
  const env = { ...process.env };
  // CRITICAL: Zero staging/test manifest overrides so compiled production defaults are exercised!
  delete env.TORI_TEST_TOOLS_MANIFEST_URL;
  delete env.TORI_TOOLS_MANIFEST_URL;
  delete env.TORI_TEST_TOOLS_PUBKEY;
  delete env.TORI_TEST_TOOLS_KEYRING_JSON;
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
  for (let i = 0; i < 65; i++) {
    const hit = (await listCdpTargets(cdpPort)).find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !getProgressJobId(t));
    if (hit) { mainWs = hit.webSocketDebuggerUrl; break; }
    await sleep(250);
  }
  if (!mainWs) throw new Error(`WebView2 CDP not ready on port ${cdpPort}`);
  const cdp = new CDPClient(mainWs);
  await cdp.connect();
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const ok = await cdp.eval(`Boolean(window.__TAURI_INTERNALS__?.invoke && document.getElementById('root')?.childElementCount > 0)`, false, 4000);
      if (ok) break;
    } catch {}
    await sleep(250);
  }
  return { proc, cdp, startupMs: Date.now() - t0 };
}

function queryRegDefault(regPath) {
  const res = spawnSync('reg', ['query', regPath, '/ve'], { encoding: 'utf8', timeout: 8000 });
  if (res.status !== 0) return null;
  const m = (res.stdout || '').match(/REG_SZ\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

async function runGate34_2PublicVerification() {
  console.log('=============================================================================');
  console.log('  TORI GATE 34.2 — LIVE PUBLIC STABLE v1.0.8 POST-RELEASE VERIFICATION');
  console.log('  GitHub Release + latest.json + Website + Real v1.0.7->v1.0.8 Auto-Updater');
  console.log('  + Production External Tools rev 2 + Browser Companion v1.0.10 + OEM Guard');
  console.log('=============================================================================\n');

  const token = getGitHubToken();
  const QA_ROOT = path.join(ROOT, 'target', 'gate34_2_live_qa');
  const DL_DIR = path.join(QA_ROOT, 'live_downloads');
  const UPG_INST_DIR = path.join(QA_ROOT, 'upg_inst');
  const UPG_DATA_DIR = path.join(QA_ROOT, 'upg_data');
  const UPG_DL_DIR = path.join(QA_ROOT, 'upg_dl');
  const UPG_WV2_DIR = path.join(QA_ROOT, 'upg_wv2');
  const SITE_EDGE_PROF = path.join(QA_ROOT, 'site_edge_prof');
  const FF_PROF = path.join(QA_ROOT, 'ff_prof');

  const UPG_PORT = 25360;
  const UPG_CDP_PORT = 25361;
  const FIXTURE_PORT = 25362;
  const SITE_CDP_PORT = 25363;
  const FF_MAR_PORT = 2849;

  const oemGuard = new QaOemStateGuard('gate34_2_live');
  oemGuard.backup({ stopRunningOem: true });
  oemGuard.temporarilySilenceNativeHostAutoSpawn();
  await sleep(600);

  const oemDbBefore = snapshotOemDatabase(OEM_DB_PATH);
  const oemExeShaBefore = sha256File(OEM_EXE_PATH);
  const oemPartsBefore = countOemTdmParts();
  let oemDbAfter = null;
  let fixtureServer = null;

  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  for (const d of [DL_DIR, UPG_INST_DIR, UPG_DATA_DIR, UPG_DL_DIR, UPG_WV2_DIR, SITE_EDGE_PROF, FF_PROF]) {
    fs.mkdirSync(d, { recursive: true });
  }

  try {
    // -------------------------------------------------------------------------
    // [1] Live GitHub v1.0.8 Latest Stable & Historical Release Preservation
    // -------------------------------------------------------------------------
    console.log('>>> [1] Live GitHub v1.0.8 Latest Stable & Historical Release Preservation <<<');
    const latestRes = await fetchRaw(`https://api.github.com/repos/${REPO}/releases/latest`, { token });
    const latestRel = JSON.parse(latestRes.buf.toString('utf8'));
    const remoteTagSha = execFileSync('git', ['ls-remote', 'origin', 'refs/tags/v1.0.8^{}'], { cwd: ROOT, encoding: 'utf8' })
      .trim()
      .split(/\s+/)[0];
    record(
      'G342-01',
      'GitHub /releases/latest is Desktop v1.0.8 (ID 455125259, stable, non-draft, commit 1a24265d, 16 Desktop-only assets)',
      Boolean(
        latestRes.status === 200 &&
        latestRel.id === EXPECTED_RELEASE_ID &&
        latestRel.tag_name === 'v1.0.8' &&
        !latestRel.draft &&
        !latestRel.prerelease &&
        remoteTagSha === APPROVED_COMMIT &&
        latestRel.assets.length === 16 &&
        latestRel.assets.every((a) => !/\.xpi$|companion/i.test(a.name))
      ),
      `id=${latestRel.id}, tag=${latestRel.tag_name}, assets=${latestRel.assets.length}, commit=${remoteTagSha}, published_at=${latestRel.published_at}`
    );

    const v107Res = await fetchRaw(`https://api.github.com/repos/${REPO}/releases/tags/v1.0.7`, { token });
    const v106Res = await fetchRaw(`https://api.github.com/repos/${REPO}/releases/tags/v1.0.6`, { token });
    const extRes = await fetchRaw(`https://api.github.com/repos/${REPO}/releases/tags/extension-v1.0.10`, { token });
    const ffRes = await fetchRaw(`https://api.github.com/repos/${REPO}/releases/tags/tools-ffmpeg-N-129150-g7ddf7bc8a4`, { token });
    const v107Rel = JSON.parse(v107Res.buf.toString('utf8'));
    const v106Rel = JSON.parse(v106Res.buf.toString('utf8'));
    const extRel = JSON.parse(extRes.buf.toString('utf8'));
    const ffRel = JSON.parse(ffRes.buf.toString('utf8'));
    record(
      'G342-02',
      'Historical Desktop v1.0.7, v1.0.6, Browser Companion extension-v1.0.10, and FFmpeg tools prerelease preserved untouched',
      Boolean(
        v107Res.status === 200 && v107Rel.id === 454278227 && !v107Rel.draft &&
        v106Res.status === 200 && v106Rel.id === 453599579 &&
        extRes.status === 200 && extRel.id === 451270856 &&
        ffRes.status === 200 && ffRel.id === 453686141 && ffRel.prerelease === true
      ),
      `v107=${v107Rel.id}, v106=${v106Rel.id}, ext=${extRel.id}, ffmpegPre=${ffRel.id}`
    );

    // Download PUBLIC v1.0.8 installer & .sig directly from GitHub
    const liveInstPath = path.join(DL_DIR, 'TORI.Download.Manager_1.0.8_x64-setup.exe');
    const liveSigPath = path.join(DL_DIR, 'TORI.Download.Manager_1.0.8_x64-setup.exe.sig');
    const instCode = downloadFileViaCurl(`https://github.com/${REPO}/releases/download/v1.0.8/TORI.Download.Manager_1.0.8_x64-setup.exe`, liveInstPath);
    const sigCode = downloadFileViaCurl(`https://github.com/${REPO}/releases/download/v1.0.8/TORI.Download.Manager_1.0.8_x64-setup.exe.sig`, liveSigPath);
    const liveInstSize = fs.statSync(liveInstPath).size;
    const liveInstSha = sha256File(liveInstPath);
    const liveSigSize = fs.statSync(liveSigPath).size;
    const liveSigSha = sha256File(liveSigPath);
    const liveSigTrimmed = fs.readFileSync(liveSigPath, 'utf8').trim();
    const liveEd25519Ok = verifyMinisignFile(LEGACY_PUBKEY_B64, liveInstPath, liveSigTrimmed);
    const authStatus = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-AuthenticodeSignature '${liveInstPath}').Status.ToString()`],
      { encoding: 'utf8', timeout: 15000 }
    ).trim();
    record(
      'G342-03',
      'Public HTTPS download of Desktop v1.0.8 installer & .sig match frozen hashes, verify Ed25519 (CDC23D8CC8DA5397) & honestly report Authenticode NotSigned',
      Boolean(
        instCode === 200 && sigCode === 200 &&
        liveInstSize === EXPECTED_V108_INSTALLER_SIZE && liveInstSha === EXPECTED_V108_INSTALLER_SHA &&
        liveSigSize === EXPECTED_V108_SIG_SIZE && liveSigSha === EXPECTED_V108_SIG_SHA &&
        liveEd25519Ok && authStatus === 'NotSigned'
      ),
      `inst=${liveInstSize}B (${liveInstSha}), sig=${liveSigSize}B (${liveSigSha}), ed25519=${liveEd25519Ok}, authenticode=${authStatus}`
    );

    // -------------------------------------------------------------------------
    // [2] Live Desktop Auto-Updater latest.json & SemVer Upgrade Matrix
    // -------------------------------------------------------------------------
    console.log('\n>>> [2] Live Auto-Updater Endpoint (latest.json) & Upgrade Matrix <<<');
    const ljRes = await fetchRaw(`https://github.com/${REPO}/releases/latest/download/latest.json`);
    const ljText = ljRes.buf.toString('utf8');
    const lj = JSON.parse(ljText);
    const expectedUrl = `https://github.com/${REPO}/releases/download/v1.0.8/TORI.Download.Manager_1.0.8_x64-setup.exe`;
    const ljOk = Boolean(
      ljRes.status === 200 &&
      lj.version === '1.0.8' &&
      !/DRAFT|UNPUBLISHED|localhost|127\.0\.0\.1/i.test(ljText) &&
      !Number.isNaN(Date.parse(lj.pub_date)) &&
      lj.platforms?.['windows-x86_64']?.url === expectedUrl &&
      lj.platforms?.['windows-x86_64-nsis']?.url === expectedUrl &&
      lj.platforms?.['windows-x86_64']?.signature === liveSigTrimmed &&
      lj.platforms?.['windows-x86_64-nsis']?.signature === liveSigTrimmed
    );
    const matrixOk =
      compareSemVer(lj.version, '1.0.5') > 0 &&
      compareSemVer(lj.version, '1.0.6') > 0 &&
      compareSemVer(lj.version, '1.0.7') > 0 &&
      compareSemVer(lj.version, '1.0.8') === 0 &&
      compareSemVer(lj.version, '1.0.9') < 0;
    record(
      'G342-04',
      'Live releases/latest/download/latest.json serves v1.0.8 with verified Ed25519 signature, zero DRAFT markers & SemVer upgrade matrix',
      ljOk && matrixOk,
      `status=${ljRes.status}, version=${lj.version}, pub_date=${lj.pub_date}, finalUrl=${ljRes.finalUrl}`
    );

    // -------------------------------------------------------------------------
    // [3] Live Production External Tools Manifest Rev 2 & Companion v1.0.10 Preservation
    // -------------------------------------------------------------------------
    console.log('\n>>> [3] Live Production Tools Manifest Rev 2 & Browser Companion v1.0.10 Preservation <<<');
    const prodManRes = await fetchRaw(`${SITE_URL}/assets/tools/tools-manifest.json`);
    const prodSigRes = await fetchRaw(`${SITE_URL}/assets/tools/tools-manifest.json.sig`);
    const prodManSha = crypto.createHash('sha256').update(prodManRes.buf).digest('hex');
    const prodSigSha = crypto.createHash('sha256').update(prodSigRes.buf).digest('hex');
    const prodManJson = JSON.parse(prodManRes.buf.toString('utf8'));
    const prodManEd25519Ok = verifyMinisignB64(LEGACY_PUBKEY_B64, prodManRes.buf, prodSigRes.buf.toString('utf8'));
    const ffHead = await fetchRaw(EXPECTED_FFMPEG_URL, { method: 'HEAD' });
    record(
      'G342-05',
      'Live production /assets/tools/tools-manifest.json (rev 2) & .sig unchanged, Ed25519-verified (CDC23D8CC8DA5397) & FFmpeg archive intact',
      Boolean(
        prodManRes.status === 200 &&
        prodSigRes.status === 200 &&
        String(prodManRes.headers['content-type'] || '').includes('application/json') &&
        prodManJson.manifest_revision === 2 &&
        prodManJson.signing_key_id === LEGACY_KEY_ID &&
        prodManJson.expires_at === EXPECTED_PROD_REV2_EXP &&
        !prodManJson.dedicated_signing_key_id &&
        prodManSha === EXPECTED_PROD_REV2_SHA &&
        prodSigSha === EXPECTED_PROD_REV2_SIG_SHA &&
        prodManEd25519Ok &&
        ffHead.status === 200 &&
        parseInt(String(ffHead.headers['content-length'] || '0'), 10) === EXPECTED_FFMPEG_SIZE
      ),
      `rev=${prodManJson.manifest_revision}, signer=${prodManJson.signing_key_id}, exp=${prodManJson.expires_at}, manSha=${prodManSha}, sigOk=${prodManEd25519Ok}, ffBytes=${ffHead.headers['content-length']}`
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
      'G342-06',
      'Live Browser Companion v1.0.10 Firefox XPI (GitHub & Website) & Chromium ZIP hashes & XPI MIME intact',
      Boolean(
        ghXpiCode === 200 && ghXpiSha === EXPECTED_XPI_SHA && fs.statSync(ghXpiPath).size === EXPECTED_XPI_SIZE &&
        siteXpiRes.status === 200 && siteXpiSha === EXPECTED_XPI_SHA && siteXpiMime.includes('application/x-xpinstall') &&
        ghChrCode === 200 && ghChrSha === EXPECTED_CHR_SHA && fs.statSync(ghChrPath).size === EXPECTED_CHR_SIZE
      ),
      `ghXpi=${ghXpiSha}, siteMime=${siteXpiMime}, ghChr=${ghChrSha}`
    );

    // -------------------------------------------------------------------------
    // [4] Phase 21 Multi-Pass Public Endpoint & Website Consistency + Desktop/Mobile Render
    // -------------------------------------------------------------------------
    console.log('\n>>> [4] Phase 21 Multi-Pass Public Endpoint Consistency & Live Website Audit <<<');
    const passResults = [];
    for (let pass = 1; pass <= 2; pass++) {
      const cb = `g342p${pass}_${Date.now()}`;
      const [ghPage, ghApi, ljP, instH, sigP, siteHome, sitemap, robots, manP, manSigP] = await Promise.all([
        fetchRaw(`https://github.com/${REPO}/releases/tag/v1.0.8`),
        fetchRaw(`https://api.github.com/repos/${REPO}/releases/latest`, { token }),
        fetchRaw(`https://github.com/${REPO}/releases/latest/download/latest.json?cb=${cb}`),
        fetchRaw(expectedUrl, { method: 'HEAD' }),
        fetchRaw(`https://github.com/${REPO}/releases/download/v1.0.8/TORI.Download.Manager_1.0.8_x64-setup.exe.sig`),
        fetchRaw(`${SITE_URL}/?cb=${cb}`),
        fetchRaw(`${SITE_URL}/sitemap.xml?cb=${cb}`),
        fetchRaw(`${SITE_URL}/robots.txt?cb=${cb}`),
        fetchRaw(`${SITE_URL}/assets/tools/tools-manifest.json?cb=${cb}`),
        fetchRaw(`${SITE_URL}/assets/tools/tools-manifest.json.sig?cb=${cb}`),
      ]);
      const hHtml = siteHome.buf.toString('utf8');
      const okPass = Boolean(
        ghPage.status === 200 &&
        ghApi.status === 200 && JSON.parse(ghApi.buf.toString('utf8')).tag_name === 'v1.0.8' &&
        ljP.status === 200 && JSON.parse(ljP.buf.toString('utf8')).version === '1.0.8' &&
        instH.status === 200 && parseInt(String(instH.headers['content-length'] || '0'), 10) === EXPECTED_V108_INSTALLER_SIZE &&
        sigP.status === 200 && crypto.createHash('sha256').update(sigP.buf).digest('hex') === EXPECTED_V108_SIG_SHA &&
        siteHome.status === 200 &&
        hHtml.includes('TORI.Download.Manager_1.0.8_x64-setup.exe') &&
        hHtml.includes(EXPECTED_V108_INSTALLER_SHA) &&
        hHtml.includes('Companion v1.0.10') &&
        hHtml.includes(EXPECTED_XPI_SHA) &&
        hHtml.includes(EXPECTED_CHR_SHA) &&
        hHtml.includes('v1.0.7') &&
        sitemap.status === 200 && sitemap.buf.toString('utf8').includes('2026-11-23') &&
        robots.status === 200 &&
        manP.status === 200 && crypto.createHash('sha256').update(manP.buf).digest('hex') === EXPECTED_PROD_REV2_SHA &&
        manSigP.status === 200 && crypto.createHash('sha256').update(manSigP.buf).digest('hex') === EXPECTED_PROD_REV2_SIG_SHA
      );
      passResults.push({ pass, ok: okPass, cfRay: siteHome.headers['cf-ray'] || '', cache: siteHome.headers['cf-cache-status'] || '' });
      if (pass === 1) await sleep(1000);
    }
    record(
      'G342-07',
      'Two fresh cache-bypass HTTP passes confirm 100% CDN/endpoint consistency across GitHub, latest.json, toridownload.xyz & tools rev 2',
      passResults.every((p) => p.ok),
      JSON.stringify(passResults)
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
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const t = (await listCdpTargets(SITE_CDP_PORT)).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) { edgePageWs = t.webSocketDebuggerUrl; break; }
    }
    const siteCdp = new CDPClient(edgePageWs);
    await siteCdp.connect();
    await siteCdp.send('Page.enable');
    await siteCdp.send('Runtime.enable');
    await sleep(1800);

    const auditViewport = async (w, h, hash) => {
      await siteCdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
      await siteCdp.eval(`(location.hash = ${JSON.stringify(hash)}, true)`);
      await sleep(500);
      return await siteCdp.eval(`(() => {
        const imgs = Array.from(document.querySelectorAll('img')).filter(i => i.offsetParent !== null);
        const brokenImgs = imgs.filter(i => i.complete && i.naturalWidth === 0).length;
        const histTags = Array.from(document.querySelectorAll('#history-container .history-tag')).map(e => e.textContent.trim());
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
          histTags,
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
      String(deskTop.heroHref).includes('/v1.0.8/TORI.Download.Manager_1.0.8_x64-setup.exe') &&
      String(deskDl.mainHref).includes('/v1.0.8/TORI.Download.Manager_1.0.8_x64-setup.exe') &&
      deskDl.statVer === '1.0.8' &&
      Array.isArray(deskDl.histTags) && deskDl.histTags.includes('v1.0.8') && deskDl.histTags.includes('v1.0.7') &&
      String(deskExt.ffHref) === '/assets/tori-download-manager-firefox-v1.0.10.xpi' &&
      String(deskExt.extHref).includes('/extension-v1.0.10/tori-companion-v1.0.10-chromium.zip') &&
      String(deskTop.footerVer).includes('v1.0.8') &&
      String(deskTop.footerVer).includes('Companion v1.0.10');
    record(
      'G342-08',
      'Live website Desktop (1440x900) & Mobile (390x844) render Desktop v1.0.8 + historical v1.0.7 + Companion v1.0.10 with zero overflow',
      layoutsOk && linksOk,
      JSON.stringify({ layoutsOk, linksOk, statVer: deskDl.statVer, heroPill: deskTop.heroPill, histTop3: deskDl.histTags?.slice(0, 3) })
    );

    // -------------------------------------------------------------------------
    // [5] Phase 14 — REAL ISOLATED v1.0.7 -> LIVE PUBLISHED v1.0.8 AUTO-UPDATER & UPGRADE
    // -------------------------------------------------------------------------
    console.log('\n>>> [5] Phase 14 REAL Isolated Desktop v1.0.7 -> Live Public v1.0.8 Auto-Updater & In-Place Upgrade <<<');
    const upgDb = path.join(UPG_DATA_DIR, 'tdm_storage.sqlite');
    if (fs.existsSync(BACKUP_ONLINE_DB)) {
      fs.copyFileSync(BACKUP_ONLINE_DB, upgDb);
    } else {
      execFileSync('python', [
        '-c',
        `import sqlite3, sys
src=sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True)
dst=sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close(); src.close()`,
        OEM_DB_PATH,
        upgDb,
      ]);
    }
    const partPath = path.join(UPG_DL_DIR, 'pre_upgrade_v107_partial.bin.tdm-part');
    fs.writeFileSync(partPath, crypto.randomBytes(65536));
    const partShaBefore = sha256File(partPath);
    const upgToken = 'tori_g34_2_live_upg_token';
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

    // Step 5A: Install baseline Desktop v1.0.7 into isolated UPG_INST_DIR
    execSync(`"${V107_INSTALLER}" /S /D=${UPG_INST_DIR}`, { timeout: 120000 });
    oemGuard.temporarilySilenceNativeHostAutoSpawn();
    const upgExe = path.join(UPG_INST_DIR, 'tori-download-manager.exe');
    const verBefore = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${upgExe}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim();

    // Step 5B: Launch REAL Desktop v1.0.7 & invoke REAL Tauri plugin:updater|check + plugin:updater|download!
    const upgPipe = `\\\\.\\pipe\\tori-qa-g342-live-${process.pid}`;
    const v107Sess = await launchIsolatedApp({
      exePath: upgExe,
      dataDir: UPG_DATA_DIR,
      dlDir: UPG_DL_DIR,
      wv2Dir: UPG_WV2_DIR,
      cdpPort: UPG_CDP_PORT,
      pipeName: `${upgPipe}_v107`,
    });
    const v107Cdp = v107Sess.cdp;
    await sleep(900);
    const runningV107Ver = await v107Cdp.eval(`window.__TAURI_INTERNALS__.invoke('get_app_version')`);

    console.log('[LIVE] Invoking REAL Tauri plugin:updater|check & plugin:updater|download (118 MiB + Rust Ed25519 verify) inside running v1.0.7...');
    const tUpd = Date.now();
    const realUpdaterRes = await v107Cdp.evalJson(`
      const meta = await window.__TAURI_INTERNALS__.invoke('plugin:updater|check', {});
      if (!meta) return { offered: false };
      const ch = new window.__TAURI__.core.Channel();
      let startedTotal = 0;
      let receivedBytes = 0;
      let finished = false;
      ch.onmessage = (ev) => {
        if (ev && ev.event === 'Started') startedTotal = ev.data?.contentLength || 0;
        else if (ev && ev.event === 'Progress') receivedBytes += ev.data?.chunkLength || 0;
        else if (ev && ev.event === 'Finished') finished = true;
      };
      const bytesRid = await window.__TAURI_INTERNALS__.invoke('plugin:updater|download', {
        onEvent: ch,
        rid: meta.rid
      });
      await window.__TAURI_INTERNALS__.invoke('plugin:resources|close', { rid: bytesRid }).catch(() => {});
      await window.__TAURI_INTERNALS__.invoke('plugin:resources|close', { rid: meta.rid }).catch(() => {});
      return {
        offered: true,
        currentVersion: meta.currentVersion,
        version: meta.version,
        date: meta.date,
        bodyHasDraft: /DRAFT|UNPUBLISHED/i.test(meta.body || ''),
        startedTotal,
        receivedBytes,
        finished,
        bytesRidOk: typeof bytesRid === 'number' && bytesRid > 0,
      };
    `, 600000);
    const realUpdaterMs = Date.now() - tUpd;

    v107Cdp.close();
    killProcTree(v107Sess.proc.pid);
    trackedProcs.delete(v107Sess.proc);
    await sleep(700);

    // Step 5C: Complete REAL in-place NSIS upgrade v1.0.7 -> LIVE-DOWNLOADED PUBLIC v1.0.8 inside isolated UPG_INST_DIR!
    execSync(`"${liveInstPath}" /S /D=${UPG_INST_DIR}`, { timeout: 120000 });
    oemGuard.temporarilySilenceNativeHostAutoSpawn();
    const verAfter = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${upgExe}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim();
    const hostAfterSha = sha256File(path.join(UPG_INST_DIR, 'bin', 'tdm-native-host.exe'));

    // Check embedded Stage 1 dual-key presence inside installed public v1.0.8 binary
    const exeBuf = fs.readFileSync(upgExe);
    const hasLegacyKeyInBin = exeBuf.includes(Buffer.from(LEGACY_KEY_ID, 'ascii'));
    const hasDedicatedKeyInBin = exeBuf.includes(Buffer.from(DEDICATED_KEY_ID, 'ascii'));

    // Start local HTTP fixture server (for IDM progress window Pause/Resume + Firefox MKV capture)
    const payload = Buffer.alloc(6 * 1024 * 1024, 0x5a);
    const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');
    const mkvPayload = Buffer.concat([Buffer.from('1a45dfa3934282886d6174726f736b61', 'hex'), crypto.randomBytes(1024 * 1024)]);
    const mkvSha = crypto.createHash('sha256').update(mkvPayload).digest('hex');
    fixtureServer = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${FIXTURE_PORT}`);
      if (u.pathname === '/ff_capture.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><a id="dl" href="/public_v108_capture.mkv">Download MKV</a></body></html>');
        return;
      }
      if (u.pathname === '/public_v108_capture.mkv') {
        const hdrs = {
          'Content-Length': String(mkvPayload.length),
          'Accept-Ranges': 'bytes',
          'Content-Type': 'video/x-matroska',
          'Content-Disposition': 'attachment; filename="public_v108_capture.mkv"',
        };
        res.writeHead(200, hdrs);
        if (req.method === 'HEAD') return res.end();
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

    // Step 5D: Boot upgraded PUBLIC v1.0.8 with ZERO staging overrides!
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
    const postUpdCheck = await mCdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('plugin:updater|check', {});`, 30000);
    const upgList = await mCdp.eval(`window.__TAURI_INTERNALS__.invoke('list_downloads')`);
    const upgCfg = await mCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_engine_settings')`);
    const partShaAfter = sha256File(partPath);
    const upgDbHealth = inspectSqliteIntegrity(upgDb);

    record(
      'G342-09',
      'REAL isolated v1.0.7 Tauri auto-updater discovers/downloads/Ed25519-verifies live v1.0.8 -> in-place upgrade preserves SQLite (42 rows/355 chunks), settings, .tdm-part & Stage 1 dual-key binary',
      Boolean(
        verBefore === '1.0.7' &&
        runningV107Ver === '1.0.7' &&
        realUpdaterRes?.offered === true &&
        realUpdaterRes?.currentVersion === '1.0.7' &&
        realUpdaterRes?.version === '1.0.8' &&
        realUpdaterRes?.bodyHasDraft === false &&
        realUpdaterRes?.receivedBytes === EXPECTED_V108_INSTALLER_SIZE &&
        realUpdaterRes?.finished === true &&
        realUpdaterRes?.bytesRidOk === true &&
        verAfter === '1.0.8' &&
        hostAfterSha === EXPECTED_V108_HOST_SHA &&
        upgAppVer === '1.0.8' &&
        postUpdCheck === null &&
        upgDbHealth.integrity === 'ok' &&
        upgDbHealth.downloads === 42 &&
        upgDbHealth.chunks === 355 &&
        Array.isArray(upgList) && upgList.length === 42 &&
        upgCfg?.theme === 'dark' && upgCfg?.accent === 'rose' &&
        partShaAfter === partShaBefore &&
        hasLegacyKeyInBin && hasDedicatedKeyInBin
      ),
      JSON.stringify({
        updaterMs: realUpdaterMs,
        offered: realUpdaterRes?.version,
        rxBytes: realUpdaterRes?.receivedBytes,
        postUpdCheck,
        upgAppVer,
        dbIntegrity: upgDbHealth,
        partUnchanged: partShaAfter === partShaBefore,
        dualKeyBin: { legacy: hasLegacyKeyInBin, dedicated: hasDedicatedKeyInBin },
      })
    );

    // -------------------------------------------------------------------------
    // [6] Close-to-Tray + Standalone IDM Progress Window + Pause/Resume
    // -------------------------------------------------------------------------
    console.log('\n>>> [6] Public v1.0.8 Close-to-Tray, IDM Progress Window & Pause/Resume <<<');
    await mCdp.eval(`window.__TAURI_INTERNALS__.invoke('window_close')`);
    await sleep(450);
    const hiddenOk = (await mCdp.eval(`window.__TAURI__.window.getCurrentWindow().isVisible()`)) === false;

    const dlRes = await httpJson({
      port: UPG_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': upgToken },
      body: { url: `http://127.0.0.1:${FIXTURE_PORT}/live_public_v108.bin`, filename: 'live_public_v108.bin' },
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
    const liveDlShaOk = sha256File(fullJob?.target_path || path.join(UPG_DL_DIR, 'live_public_v108.bin')) === payloadSha;
    pCdp.close();
    await mCdp.eval(`window.__TAURI_INTERNALS__.invoke('show_main_window')`);
    record(
      'G342-10',
      'Public v1.0.8 Close-to-Tray, standalone IDM Progress Window (no legacy toast), Pause/Resume & exact SHA-256 pass',
      Boolean(hiddenOk && popDiag.isIdm && !popDiag.legacyToast && popDiag.label.startsWith('progress_') && stPaused === 'paused' && done && liveDlShaOk),
      JSON.stringify({ hiddenOk, popDiag, stPaused, done, liveDlShaOk })
    );

    // -------------------------------------------------------------------------
    // [7] Phase 15 — External Tools Live Compatibility (rev 2, yt-dlp, FFmpeg/FFprobe, Rollback & Bundled Fallback)
    // -------------------------------------------------------------------------
    console.log('\n>>> [7] Phase 15 External Tools Live Compatibility (Production rev 2, yt-dlp, FFmpeg/FFprobe, Rollback & Fallback) <<<');
    await mCdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: { auto_update: true, check_interval_hours: 24, auto_install: false, notify_on_update: true, defer_while_in_use: true }
      });
    `);
    const toolsChk = await mCdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');`, 60000);
    const manState = readIsolatedManifestState(upgDb);
    const tFf = toolsChk.tools.find((t) => t.tool_id === 'ffmpeg');
    const tFp = toolsChk.tools.find((t) => t.tool_id === 'ffprobe');
    const tYt = toolsChk.tools.find((t) => t.tool_id === 'yt-dlp');
    const mStat = toolsChk.manifest_status || {};

    await mCdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: { auto_update: true, check_interval_hours: 24, auto_install: true, notify_on_update: true, defer_while_in_use: true }
      });
    `);

    // Live OpenPGP yt-dlp update + rollback
    console.log('[LIVE] Updating yt-dlp (OpenPGP RSA-4096) and testing rollback...');
    const ytUp = await mCdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'yt-dlp' });`, 240000);
    const ytUpRec = ytUp.tools.find((t) => t.tool_id === 'yt-dlp');
    const ytRb = await mCdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('rollback_external_tool', { toolId: 'yt-dlp' });`, 60000);
    const ytRbRec = ytRb.tools.find((t) => t.tool_id === 'yt-dlp');

    // Live 205 MiB FFmpeg/FFprobe update from production manifest rev 2 + full media pipeline + atomic rollback + bundled fallback!
    console.log('[LIVE] Updating FFmpeg & FFprobe (205 MiB production rev 2), verifying media pipeline, rollback & bundled fallback...');
    const tFfStart = Date.now();
    const ffUp = await mCdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'ffmpeg' });`, 900000);
    const ffUpMs = Date.now() - tFfStart;
    const ffAct = ffUp.tools.find((t) => t.tool_id === 'ffmpeg');
    const fpAct = ffUp.tools.find((t) => t.tool_id === 'ffprobe');
    const compatUpdated = runMediaCompatMatrix(ffAct.active_binary_path, fpAct.active_binary_path, path.join(QA_ROOT, 'compat_updated'));

    const ffRb = await mCdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('rollback_external_tool', { toolId: 'ffmpeg' });`, 60000);
    const ffRbRec = ffRb.tools.find((t) => t.tool_id === 'ffmpeg');
    const fpRbRec = ffRb.tools.find((t) => t.tool_id === 'ffprobe');
    const compatBundled = runMediaCompatMatrix(ffRbRec.active_binary_path, fpRbRec.active_binary_path, path.join(QA_ROOT, 'compat_bundled'));

    record(
      'G342-11',
      'Public v1.0.8 verifies live PRODUCTION manifest rev 2 (CDC23D8CC8DA5397), updates/rolls back yt-dlp (OpenPGP) & FFmpeg/FFprobe (205 MiB + H.264/AAC/MP4/MKV/HLS) with bundled fallback',
      Boolean(
        tFf?.update_status === 'update_available' &&
        tFf?.available_version === EXPECTED_FFMPEG_VER &&
        tFp?.update_status === 'update_available' &&
        tFp?.available_version === EXPECTED_FFMPEG_VER &&
        manState.highest_accepted_revision === 2 &&
        manState.last_accepted_manifest_sha256 === EXPECTED_PROD_REV2_SHA &&
        manState.last_signing_key_id === LEGACY_KEY_ID &&
        mStat.current_revision === 2 &&
        mStat.signing_key_id === LEGACY_KEY_ID &&
        ytUpRec?.source === 'managed' &&
        ytRbRec?.source === 'bundled' &&
        ffAct?.source === 'managed' &&
        fpAct?.source === 'managed' &&
        ffAct?.installed_version === EXPECTED_FFMPEG_VER &&
        fpAct?.installed_version === EXPECTED_FFMPEG_VER &&
        path.dirname(ffAct.active_binary_path) === path.dirname(fpAct.active_binary_path) &&
        compatUpdated.ffVer === EXPECTED_FFMPEG_VER &&
        ffRbRec?.source === 'bundled' &&
        fpRbRec?.source === 'bundled' &&
        ffRbRec?.installed_version === EXPECTED_FFMPEG_BUNDLED &&
        compatBundled.ffVer === EXPECTED_FFMPEG_BUNDLED
      ),
      JSON.stringify({
        rev: manState.highest_accepted_revision,
        signer: manState.last_signing_key_id,
        mStatVerif: mStat.verification_status,
        ytUp: ytUpRec?.installed_version,
        ytRb: ytRbRec?.installed_version,
        ffUpMs,
        ffUp: ffAct?.installed_version,
        ffRb: ffRbRec?.installed_version,
      })
    );

    // -------------------------------------------------------------------------
    // [8] Phase 16 — Browser Companion v1.0.10 Preservation (Chrome, Edge & Firefox)
    // -------------------------------------------------------------------------
    console.log('\n>>> [8] Phase 16 Browser Companion v1.0.10 Preservation (Chrome, Edge & Firefox) <<<');
    const hostExe = path.join(UPG_INST_DIR, 'bin', 'tdm-native-host.exe');

    // Verify Chrome, Edge & Firefox Native Messaging registration via v1.0.8 native host (OEM restored in finally)
    const regRun = spawnSync(hostExe, ['--register'], { encoding: 'utf8', timeout: 15000 });
    const chromeRegPath = queryRegDefault('HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager');
    const edgeRegPath = queryRegDefault('HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager');
    const ffRegPath = queryRegDefault('HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager');
    const chromeJson = chromeRegPath && fs.existsSync(chromeRegPath) ? JSON.parse(fs.readFileSync(chromeRegPath, 'utf8')) : null;
    const ffJson = ffRegPath && fs.existsSync(ffRegPath) ? JSON.parse(fs.readFileSync(ffRegPath, 'utf8')) : null;
    const nmRegOk = Boolean(
      regRun.status === 0 &&
      chromeRegPath && edgeRegPath && ffRegPath &&
      chromeRegPath === edgeRegPath &&
      chromeJson?.path === hostExe &&
      Array.isArray(chromeJson?.allowed_origins) && chromeJson.allowed_origins.length >= 2 &&
      ffJson?.path === hostExe &&
      Array.isArray(ffJson?.allowed_extensions) && ffJson.allowed_extensions.includes(EXPECTED_GECKO_ID)
    );

    // Native Messaging stdio ping -> pong
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

    // HTTP fallback status endpoint check
    const httpStatusRes = await httpJson({ port: UPG_PORT, reqPath: '/api/v1/status', headers: { 'X-Tori-Token': upgToken } });

    // Wire isolated Firefox Native Messaging host wrapper to public v1.0.8 pipe & run live signed Firefox Companion v1.0.10 capture!
    const qaNmBat = path.join(QA_ROOT, 'nm_host_public_v108.cmd');
    fs.writeFileSync(
      qaNmBat,
      `@echo off\r\nset TORI_DATA_DIR=${UPG_DATA_DIR}\r\nset TORI_IPC_PIPE=${upgPipe}\r\nset TORI_DISABLE_AUTO_SPAWN=1\r\n"${hostExe}" %*\r\n`
    );
    const qaFfNmJson = path.join(QA_ROOT, 'com.tori.download_manager.firefox.json');
    fs.writeFileSync(
      qaFfNmJson,
      JSON.stringify({
        name: 'com.tori.download_manager',
        description: 'TORI Public v1.0.8 QA Native Host (Firefox)',
        path: qaNmBat,
        type: 'stdio',
        allowed_extensions: [EXPECTED_GECKO_ID],
      }, null, 2)
    );
    execFileSync('reg', ['add', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', qaFfNmJson, '/f'], { stdio: 'ignore' });

    const ffDlDir = path.join(QA_ROOT, 'ff_dl');
    fs.mkdirSync(ffDlDir, { recursive: true });
    fs.writeFileSync(
      path.join(FF_PROF, 'user.js'),
      [
        'user_pref("marionette.enabled", true);',
        `user_pref("marionette.port", ${FF_MAR_PORT});`,
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
        'user_pref("xpinstall.signatures.required", true);',
        'user_pref("extensions.autoDisableScopes", 0);',
        'user_pref("browser.download.folderList", 2);',
        `user_pref("browser.download.dir", ${JSON.stringify(ffDlDir)});`,
      ].join('\n')
    );
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
    const ffSig = (
      await mar.send(
        'WebDriver:ExecuteAsyncScript',
        {
          script: `
            const done = arguments[arguments.length - 1];
            (async () => {
              const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
              const addon = await AddonManager.getAddonByID("${EXPECTED_GECKO_ID}");
              done({ id: addon?.id, version: addon?.version, active: !!addon?.isActive, signed: addon?.signedState === AddonManager.SIGNEDSTATE_SIGNED, temporary: addon?.temporarilyInstalled });
            })();
          `,
          args: [],
        },
        15000
      )
    )?.value;

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
    const chrCheck = JSON.parse(
      execFileSync(
        'python',
        [
          '-c',
          `import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'r') as z:
    m = json.loads(z.read('manifest.json').decode('utf-8'))
    cjs = len(z.read('content.js'))
print(json.dumps({'ver': m.get('version'), 'mv': m.get('manifest_version'), 'contentJsBytes': cjs}))`,
          ghChrPath,
        ],
        { encoding: 'utf8' }
      ).trim()
    );
    record(
      'G342-12',
      'Public v1.0.8 Chrome/Edge/Firefox Native Messaging (--register + stdio ping), HTTP fallback, Chromium v1.0.10 ZIP & live Mozilla-signed Firefox v1.0.10 MKV capture pass',
      Boolean(
        nmRegOk &&
        nmRes.status === 0 && nmResp?.action === 'pong' &&
        httpStatusRes.ok &&
        chrCheck.ver === '1.0.10' && chrCheck.mv === 3 && chrCheck.contentJsBytes > 100000 &&
        ffInst?.value === EXPECTED_GECKO_ID && ffSig?.version === '1.0.10' && ffSig?.signed === true && ffSig?.temporary === false &&
        ffCapShaOk
      ),
      JSON.stringify({
        nmRegOk,
        nmAction: nmResp?.action,
        httpStatus: httpStatusRes.status,
        chrVer: chrCheck.ver,
        ffVer: ffSig?.version,
        ffSigned: ffSig?.signed,
        newJobs: capturedJob?.count,
        shaOk: ffCapShaOk,
      })
    );

    // -------------------------------------------------------------------------
    // [9] Warm Restart Stability of Upgraded Public v1.0.8
    // -------------------------------------------------------------------------
    console.log('\n>>> [9] Warm Restart Stability of Upgraded Public v1.0.8 <<<');
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
      'G342-13',
      'Upgraded public v1.0.8 warm restart preserves app version (1.0.8), all downloads (42+2=44), and SQLite tool update history',
      Boolean(warmVer === '1.0.8' && Array.isArray(warmList) && warmList.length === 44 && Array.isArray(warmHist) && warmHist.length >= 4),
      JSON.stringify({ warmVer, warmStartupMs: warmSess.startupMs, downloads: warmList?.length, toolHistory: warmHist?.length })
    );
  } finally {
    cleanupProcs();
    if (fixtureServer) try { fixtureServer.close(); } catch {}
    oemDbAfter = snapshotOemDatabase(OEM_DB_PATH);
    try { fs.rmSync(QA_ROOT, { recursive: true, force: true }); } catch {}
    const parity = oemGuard.restore({ qaPathMarker: 'gate34_2_live_qa', restartOem: true });
    const dbCmp = compareOemDatabaseSnapshots(oemDbBefore, oemDbAfter);
    const oemExeMatch = sha256File(OEM_EXE_PATH) === oemExeShaBefore;
    record(
      'G342-14',
      'Production Windows Registry, Native Messaging, SQLite DB (42 rows / 355 chunks), 11 .tdm-part files & OEM v1.0.6 binary 100% preserved',
      Boolean(parity?.ok && dbCmp?.ok && oemExeMatch && oemDbAfter.partFilesCount === oemDbBefore.partFilesCount),
      JSON.stringify({
        regOk: parity?.ok,
        dbOk: dbCmp?.ok,
        rawShaMatch: dbCmp?.rawFileSha256Match,
        oemExeMatch,
        downloads: oemDbAfter.downloadsCount,
        chunks: oemDbAfter.chunksCount,
        protectedSettings: oemDbAfter.protectedSettingsCount,
        partFilesCount: oemDbAfter.partFilesCount,
      })
    );
  }

  console.log(`\n=============================================================================`);
  console.log(` GATE 34.2 LIVE PUBLIC VERIFICATION: ${counts.PASS} PASS, ${counts.FAIL} FAIL`);
  console.log(`=============================================================================`);
  if (counts.FAIL > 0) process.exit(1);
}

runGate34_2PublicVerification().catch((err) => {
  console.error('[FATAL]', err);
  cleanupProcs();
  process.exit(1);
});
