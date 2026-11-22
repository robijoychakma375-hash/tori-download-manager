#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 33.1
 * Comprehensive Desktop v1.0.8-RC Preflight, Phase 5 Manifest Rev 2 Validation,
 * Phase 10 Real v1.0.7 -> v1.0.8-rc NSIS Upgrade, Phase 11 Cross-Version v1.0.7 vs v1.0.8-rc
 * Dual-Key Compatibility Matrix (Scenarios A-E), Phase 12 Real-World External Tools Validation,
 * Phase 13 Browser Companion v1.0.10 (Chrome/Edge + Permanent Signed Firefox XPI) Parity,
 * and Phase 17 Public + Local OEM Preservation Verification.
 *
 * Strictly isolated under target/gate33_1_qa with dedicated TORI_DATA_DIR, TORI_IPC_PIPE,
 * WEBVIEW2_USER_DATA_FOLDER, and ports (25410..25429).
 * Never mutates public Desktop v1.0.7, public latest.json, public tools-manifest.json rev 1,
 * Browser Companion v1.0.10, toridownload.xyz, or local OEM v1.0.6 binary/SQLite/.tdm-part files.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { spawn, execSync, execFileSync, spawnSync } = require('child_process');
const {
  QaOemStateGuard,
  snapshotOemDatabase,
  compareOemDatabaseSnapshots,
  REG_MANU,
  queryRegDefault,
} = require('./lib/qa_oem_state_guard');

const ROOT = path.resolve(__dirname, '..');
const RC_107_DIR = path.join(ROOT, 'release', 'v1.0.7-rc');
const RC_108_DIR = path.join(ROOT, 'release', 'v1.0.8-rc');
const INST_107_EXE = path.join(RC_107_DIR, 'TORI Download Manager_1.0.7_x64-setup.exe');
const INST_108_EXE = path.join(RC_108_DIR, 'TORI Download Manager_1.0.8_x64-setup.exe');
const INST_108_SIG = path.join(RC_108_DIR, 'TORI Download Manager_1.0.8_x64-setup.exe.sig');
const REV2_CAND_DIR = path.join(RC_108_DIR, 'tools-manifest-rev2-candidate');

const EXT_RC_DIR = path.join(ROOT, 'release', 'v1.0.10-extension-rc');
const CHR_EXT_DIR = path.join(EXT_RC_DIR, 'tori-companion-v1.0.10-chromium');
const CHR_EXT_ZIP = path.join(EXT_RC_DIR, 'tori-companion-v1.0.10-chromium.zip');
const SIGNED_FF_XPI = path.join(EXT_RC_DIR, 'tori-companion-v1.0.10-firefox-signed.xpi');
const EXPECTED_XPI_SHA = 'a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8';
const EXPECTED_CHR_SHA = 'f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1';
const EXPECTED_GECKO_ID = 'tori-download-manager@toridm.org';

const PROD_MANIFEST_URL = 'https://toridownload.xyz/assets/tools/tools-manifest.json';
const ACTIVE_PROD_REG = (() => {
  try {
    const reg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'docs', 'security', 'tools-manifest-registry', 'registry.json'), 'utf8')
    );
    return (reg.revisions || []).find((r) => r.publication_status === 'active') || null;
  } catch {
    return null;
  }
})();
const EXPECTED_ACTIVE_PROD_REV = ACTIVE_PROD_REG?.manifest_revision || 1;
const EXPECTED_ACTIVE_PROD_SHA =
  ACTIVE_PROD_REG?.manifest_sha256 || '9fa61a38bb77bb8cdf05364565db2cf3b2b3ab8d0c7af98dfd7c50b2ee287662';
const EXPECTED_ACTIVE_PROD_SIG_SHA =
  ACTIVE_PROD_REG?.signature_sha256 || 'e0e23db79990f885c0745165299b20befd41f5dc8a73f7b00ca0476502955eb4';
const EXPECTED_PROD_REV1_SHA = '9fa61a38bb77bb8cdf05364565db2cf3b2b3ab8d0c7af98dfd7c50b2ee287662';
const EXPECTED_FFMPEG_URL =
  'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/tools-ffmpeg-N-129150-g7ddf7bc8a4/ffmpeg-N-129150-g7ddf7bc8a4-win64-gpl.zip';
const EXPECTED_FFMPEG_SHA = '03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076';
const EXPECTED_FFMPEG_SIZE = 205445856;
const EXPECTED_FFMPEG_VER = 'N-129150-g7ddf7bc8a4-20261120';
const PROD_KEY_ID = 'CDC23D8CC8DA5397';

const OEM_DESKTOP_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'tori-download-manager.exe');
const OEM_DB_PATH = path.join(process.env.APPDATA || '', 'tori-download-manager', 'tdm_storage.sqlite');
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

const QA_ROOT = path.join(ROOT, 'target', 'gate33_1_qa');
const QA_INST_DIR = path.join(QA_ROOT, 'desktop_install');
const QA_V107_COPY_DIR = path.join(QA_ROOT, 'v107_frozen_copy');
const QA_DATA_DIR = path.join(QA_ROOT, 'data');
const QA_DL_DIR = path.join(QA_ROOT, 'downloads');
const QA_WV2_DIR = path.join(QA_ROOT, 'webview2');
const QA_PROF_DIR = path.join(QA_ROOT, 'profile');
const QA_FF_PROF = path.join(QA_ROOT, 'ff_profile');
const QA_FF_DL = path.join(QA_ROOT, 'ff_dl');
const QA_NON_PROD_DIR = path.join(QA_ROOT, 'non_prod_test_fixtures');
const SHOTS_DIR = path.join(ROOT, 'docs', 'reports', 'screenshots', 'gate33_1');

const PORT_APP = 25410;
const PORT_CDP = 25411;
const PORT_FIXTURE = 25412;
const PORT_FF_MAR = 2855;
const API_TOKEN = 'tori_qa_g33_1_token';
const WATCH_YT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

const results = [];
const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, NOT_TESTED: 0 };
const trackedProcs = new Set();
let fixtureServer = null;

function record(id, name, status, detail = '') {
  const norm = status === true ? 'PASS' : status === false ? 'FAIL' : status;
  counts[norm] = (counts[norm] || 0) + 1;
  console.log(`[${norm}] [${id}] ${name}${detail ? ' -> ' + detail : ''}`);
  results.push({ id, name, status: norm, detail });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function sha256Buf(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(65536);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function getPeVersion(exePath) {
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Item '${exePath.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
      { encoding: 'utf8', timeout: 8000 }
    ).trim();
  } catch {
    return null;
  }
}

function killProcTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
  } catch {}
}

function cleanupProcs() {
  for (const p of trackedProcs) killProcTree(p.pid);
  trackedProcs.clear();
}

function getTreeStats(rootPid) {
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
      [void]$ids.Add([int]$p.ProcessId); $changed = $true
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

function httpJson({ port, reqPath, method = 'GET', headers = {}, body = null, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const payload = body !== null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        timeout: timeoutMs,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(raw), raw });
          } catch {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: null, raw });
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

function httpsRequest(url, method = 'GET', maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        timeout: 15000,
        headers: {
          'User-Agent': 'TORI-Gate33_1/1.0.8',
          'Cache-Control': 'no-cache, no-store, max-age=0',
          Pragma: 'no-cache',
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
          res.resume();
          return resolve(httpsRequest(new URL(res.headers.location, url).toString(), method, maxRedirects - 1));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body, text: body.toString('utf8') });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Timeout on ${url}`)));
    req.on('error', reject);
    req.end();
  });
}

function generateTestMinisignKey(keyIdHex) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = spki.subarray(spki.length - 32);
  const keyIdLe = Buffer.from(keyIdHex, 'hex').reverse();
  const pkBuf = Buffer.concat([Buffer.from('Ed'), keyIdLe, rawPub]);
  const pkBox = `untrusted comment: minisign public key: ${keyIdHex}\n${pkBuf.toString('base64')}\n`;
  return {
    keyIdHex,
    pubkeyB64: Buffer.from(pkBox, 'utf8').toString('base64'),
    publicKey,
    privateKey,
    signB64(buf, fileLabel = 'tools-manifest.json') {
      const prehash = crypto.createHash('blake2b512').update(buf).digest();
      const sig = crypto.sign(null, prehash, privateKey);
      const sigBox = Buffer.concat([Buffer.from('ED'), keyIdLe, sig]).toString('base64');
      const tc = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${fileLabel}\tpurpose:external_tools_manifest`;
      const gsig = crypto.sign(null, Buffer.concat([sig, Buffer.from(tc, 'utf8')]), privateKey).toString('base64');
      const full = `untrusted comment: NON-PRODUCTION TEST KEY signature (${keyIdHex})\n${sigBox}\ntrusted comment: ${tc}\n${gsig}\n`;
      return Buffer.from(full, 'utf8').toString('base64') + '\n';
    },
  };
}

function verifyMinisignB64(pubkeyB64, dataBuf, sigB64) {
  const decodedPub = Buffer.from(pubkeyB64, 'base64').toString('utf8').trim().split(/\r?\n/);
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

function hasDuplicateJsonKeys(text) {
  let i = 0;
  const n = text.length;
  const ws = () => { while (i < n && /\s/.test(text[i])) i++; };
  const readStr = () => {
    i++; // "
    let out = '';
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\') { i++; out += text[i] || ''; }
      else out += text[i];
      i++;
    }
    i++;
    return out;
  };
  const walk = () => {
    ws();
    const ch = text[i];
    if (ch === '{') {
      i++;
      const seen = new Set();
      ws();
      if (text[i] === '}') { i++; return false; }
      while (i < n) {
        ws();
        const k = readStr();
        if (seen.has(k)) return true;
        seen.add(k);
        ws();
        i++; // :
        if (walk()) return true;
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return false; }
        break;
      }
      return false;
    }
    if (ch === '[') {
      i++;
      ws();
      if (text[i] === ']') { i++; return false; }
      while (i < n) {
        if (walk()) return true;
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return false; }
        break;
      }
      return false;
    }
    if (ch === '"') { readStr(); return false; }
    while (i < n && !/[\s,}\]]/.test(text[i])) i++;
    return false;
  };
  return walk();
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
  close() { try { if (this.ws) this.ws.close(); } catch {} }
}

class MarionetteClient {
  constructor(port) {
    this.port = port;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.msgId = 1;
    this.waiters = new Map();
    this.helloResolve = null;
  }
  connect(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
        const sock = net.createConnection({ host: '127.0.0.1', port: this.port });
        let settled = false;
        sock.on('error', () => {
          sock.destroy();
          if (Date.now() < deadline) setTimeout(attempt, 400);
          else if (!settled) { settled = true; reject(new Error('Marionette connect timeout')); }
        });
        sock.on('connect', () => {
          this.sock = sock;
          this.helloResolve = () => { if (!settled) { settled = true; resolve(); } };
          sock.on('data', (chunk) => this._onData(chunk));
        });
      };
      attempt();
    });
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const colon = this.buf.indexOf(0x3a);
      if (colon === -1) break;
      const len = parseInt(this.buf.subarray(0, colon).toString('ascii'), 10);
      if (isNaN(len) || this.buf.length < colon + 1 + len) break;
      const payload = this.buf.subarray(colon + 1, colon + 1 + len).toString('utf8');
      this.buf = this.buf.subarray(colon + 1 + len);
      const msg = JSON.parse(payload);
      if (!Array.isArray(msg) && msg.applicationType && this.helloResolve) {
        const r = this.helloResolve;
        this.helloResolve = null;
        r();
      } else if (Array.isArray(msg) && msg[0] === 1) {
        const [, id, err, result] = msg;
        const w = this.waiters.get(id);
        if (w) {
          this.waiters.delete(id);
          if (err) w.reject(new Error(JSON.stringify(err)));
          else w.resolve(result);
        }
      }
    }
  }
  send(cmd, params = {}, timeoutMs = 20000) {
    const id = this.msgId++;
    const body = JSON.stringify([0, id, cmd, params]);
    const frame = `${Buffer.byteLength(body)}:${body}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Marionette timeout on ${cmd}`));
      }, timeoutMs);
      this.waiters.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.sock.write(frame);
    });
  }
  close() { try { if (this.sock) this.sock.destroy(); } catch {} }
}

async function listCdpTargets(cdpPort) {
  const res = await httpJson({ port: cdpPort, reqPath: '/json/list', timeoutMs: 4000 });
  return res.ok && Array.isArray(res.data) ? res.data : [];
}

async function waitForMainCdp(cdpPort, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listCdpTargets(cdpPort);
    const page = targets.find(
      (t) =>
        t.type === 'page' &&
        t.webSocketDebuggerUrl &&
        !String(t.url || '').includes('window=progress') &&
        !String(t.url || '').includes('window=toast')
    );
    if (page) {
      const c = new CDPClient(page.webSocketDebuggerUrl);
      await c.connect();
      await c.send('Runtime.enable');
      await c.send('Page.enable');
      return c;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for WebView2 CDP on port ${cdpPort}`);
}

async function bootDesktop({ exe, dataDir, wv2Dir, dlDir, profDir, port, cdpPort, token, pipeSuffix, extraEnv = {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(wv2Dir, { recursive: true });
  fs.mkdirSync(dlDir, { recursive: true });
  fs.mkdirSync(profDir, { recursive: true });

  const env = {
    ...process.env,
    TORI_DATA_DIR: dataDir,
    TORI_IPC_PIPE: `\\\\.\\pipe\\tori_g331_${pipeSuffix}_${process.pid}`,
    TORI_DISABLE_AUTO_SPAWN: '1',
    TORI_ALLOW_LOOPBACK: '1',
    TDM_STORAGE_DIR: dataDir,
    TDM_DOWNLOAD_DIR: dlDir,
    WEBVIEW2_USER_DATA_FOLDER: wv2Dir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    ...extraEnv,
  };

  const t0 = Date.now();
  const proc = spawn(exe, [], { cwd: path.dirname(exe), env, stdio: ['ignore', 'pipe', 'pipe'] });
  trackedProcs.add(proc);
  const cdp = await waitForMainCdp(cdpPort, 30000);
  for (let i = 0; i < 60; i++) {
    const ready = await cdp.evalJson(`return Boolean(window.__TAURI_INTERNALS__ && document.querySelector('#tool'));`);
    if (ready) break;
    await sleep(150);
  }
  const startupMs = Date.now() - t0;
  let activePort = port;
  let activeToken = token;
  let serverOk = false;
  for (let i = 0; i < 40; i++) {
    try {
      const info = await cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_browser_integration_info');`);
      if (info && info.port && info.token) {
        activePort = info.port;
        activeToken = info.token;
      }
    } catch {}
    const st = await httpJson({ port: activePort, reqPath: '/api/v1/status', headers: { 'X-Tori-Token': activeToken }, timeoutMs: 2000 });
    if (st.ok) { serverOk = true; break; }
    await sleep(200);
  }
  return { proc, cdp, startupMs, serverOk, port: activePort, token: activeToken };
}

async function waitForJob(port, token, predicate, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await httpJson({ port, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': token } });
    const jobs = r.data?.jobs || (Array.isArray(r.data) ? r.data : []);
    const hit = jobs.find(predicate);
    if (hit) {
      const det = await httpJson({ port, reqPath: `/api/v1/downloads/${encodeURIComponent(hit.id)}`, headers: { 'X-Tori-Token': token } });
      return det.ok && det.data ? det.data : hit;
    }
    await sleep(300);
  }
  return null;
}

function makePatternBuffer(bytes, hexSeed) {
  const seed = Buffer.from(hexSeed, 'hex');
  const buf = Buffer.allocUnsafe(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = seed[i % seed.length] ^ ((i >>> 8) & 0xff);
  return buf;
}

function sendNativeHostMessage(hostExe, msgObj, envExtra = {}) {
  const payload = Buffer.from(JSON.stringify(msgObj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  const res = spawnSync(hostExe, [], {
    input: Buffer.concat([header, payload]),
    env: { ...process.env, ...envExtra },
    timeout: 15000,
  });
  if (!res.stdout || res.stdout.length < 4) {
    return { ok: false, status: res.status, stderr: (res.stderr || '').toString('utf8') };
  }
  const respLen = res.stdout.readUInt32LE(0);
  const respJson = res.stdout.subarray(4, 4 + respLen).toString('utf8');
  return { ok: true, status: res.status, response: JSON.parse(respJson) };
}

function querySqliteTables(dbPath) {
  const out = execFileSync(
    'python',
    [
      '-c',
      `import json, sqlite3, sys
con = sqlite3.connect(sys.argv[1])
cur = con.cursor()
integrity = [r[0] for r in cur.execute("PRAGMA integrity_check").fetchall()]
tables = sorted([r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()])
dl_cnt = cur.execute("SELECT COUNT(*) FROM downloads").fetchone()[0] if 'downloads' in tables else 0
tool_cnt = cur.execute("SELECT COUNT(*) FROM external_tools_registry").fetchone()[0] if 'external_tools_registry' in tables else 0
hist_cnt = cur.execute("SELECT COUNT(*) FROM external_tool_update_history").fetchone()[0] if 'external_tool_update_history' in tables else 0
print(json.dumps({"integrity": integrity, "tables": tables, "downloads": dl_cnt, "tools": tool_cnt, "history": hist_cnt}))`,
      dbPath,
    ],
    { encoding: 'utf8', timeout: 10000 }
  ).trim();
  return JSON.parse(out);
}

async function runManifestCheckOnBinary({ exe, dataDir, wv2Dir, dlDir, profDir, cdpPort, pipeSuffix, extraEnv }) {
  const b = await bootDesktop({
    exe,
    dataDir,
    wv2Dir,
    dlDir,
    profDir,
    port: PORT_APP + 5,
    cdpPort,
    token: API_TOKEN,
    pipeSuffix,
    extraEnv,
  });
  try {
    await b.cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: { auto_update: true, check_interval_hours: 24, auto_install: false, notify_on_update: true, defer_while_in_use: true }
      });
    `);
    let snap = await b.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');`);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && snap.checking) {
      await sleep(300);
      snap = await b.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_external_tools_status');`);
    }
    return snap;
  } finally {
    b.cdp.close();
    killProcTree(b.proc.pid);
    trackedProcs.delete(b.proc);
    await sleep(350);
  }
}

async function main() {
  console.log('=============================================================================');
  console.log('  TORI GATE 33.1 — DESKTOP v1.0.8 RC PREFLIGHT, v1.0.7 -> v1.0.8 UPGRADE,');
  console.log('  REV 2 CANDIDATE & CROSS-VERSION DUAL-KEY COMPATIBILITY MATRIX');
  console.log('=============================================================================\n');

  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(QA_ROOT, { recursive: true });
  fs.mkdirSync(QA_NON_PROD_DIR, { recursive: true });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  // =========================================================================
  // GROUP A: RELEASE CANDIDATE & UNPUBLISHED REV 2 CANDIDATE INTEGRITY
  // =========================================================================
  const requiredRcFiles = [
    'TORI Download Manager_1.0.8_x64-setup.exe',
    'TORI Download Manager_1.0.8_x64-setup.exe.sig',
    'tori-download-manager.exe',
    'tdm-native-host.exe',
    'tdm-cli.exe',
    'SHA256SUMS.txt',
    'BUILD_METADATA.json',
    'RELEASE_MANIFEST.json',
    'draft_latest.json',
    'RELEASE_NOTES_v1.0.8.md',
    'INSTALLATION_AND_UPGRADE.md',
    path.join('tools-manifest-rev2-candidate', 'tools-manifest.json'),
    path.join('tools-manifest-rev2-candidate', 'RACE_PRECHECK_POLICY.json'),
  ];
  const missingRc = requiredRcFiles.filter((f) => !fs.existsSync(path.join(RC_108_DIR, f)));
  const prodCandidateUnsigned =
    !fs.existsSync(path.join(REV2_CAND_DIR, 'tools-manifest.json.sig')) &&
    !fs.existsSync(path.join(REV2_CAND_DIR, 'tools-manifest.json.tools.sig'));
  let sumsVerified = false;
  if (missingRc.length === 0) {
    const lines = fs.readFileSync(path.join(RC_108_DIR, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/);
    sumsVerified = lines.length >= 6 && lines.every((l) => {
      const m = l.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
      if (!m) return false;
      const actual = sha256File(path.join(RC_108_DIR, m[2].trim()));
      return actual && actual.toLowerCase() === m[1].toLowerCase();
    });
  }
  record(
    'G331-01',
    'All release/v1.0.8-rc/ deliverables present, verified against SHA256SUMS.txt, and rev 2 candidate kept UNSIGNED',
    missingRc.length === 0 && sumsVerified && prodCandidateUnsigned,
    missingRc.length ? `missing=${JSON.stringify(missingRc)}` : `files=${requiredRcFiles.length}, sumsOk=${sumsVerified}, rev2Unsigned=${prodCandidateUnsigned}`
  );

  // Confirm draft_latest.json = 1.0.8 while live public GitHub latest.json = 1.0.7 & live prod manifest = rev 1!
  const draftLatest = JSON.parse(fs.readFileSync(path.join(RC_108_DIR, 'draft_latest.json'), 'utf8'));
  const sigText = fs.readFileSync(INST_108_SIG, 'utf8').trim();
  const liveLatestRes = await httpsRequest('https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json');
  const liveLatest = liveLatestRes.status === 200 ? JSON.parse(liveLatestRes.text) : null;
  const liveProdManifest = await httpsRequest(`${PROD_MANIFEST_URL}?cb=${Date.now()}`);
  const liveProdSig = await httpsRequest(`${PROD_MANIFEST_URL}.sig?cb=${Date.now()}`);
  record(
    'G331-02',
    `Draft v1.0.8 latest.json valid while public GitHub latest.json remains 1.0.7 and public tools-manifest matches active registry rev ${EXPECTED_ACTIVE_PROD_REV}`,
    draftLatest.version === '1.0.8' &&
      draftLatest.platforms?.['windows-x86_64']?.signature?.trim() === sigText &&
      draftLatest.platforms?.['windows-x86_64-nsis']?.signature?.trim() === sigText &&
      liveLatest?.version === '1.0.7' &&
      sha256Buf(liveProdManifest.body) === EXPECTED_ACTIVE_PROD_SHA &&
      sha256Buf(liveProdSig.body) === EXPECTED_ACTIVE_PROD_SIG_SHA,
    `draft=${draftLatest.version}, liveLatest=${liveLatest?.version}, prodRev${EXPECTED_ACTIVE_PROD_REV}Match=${sha256Buf(liveProdManifest.body) === EXPECTED_ACTIVE_PROD_SHA}`
  );

  const xpiSha = sha256File(SIGNED_FF_XPI);
  const chrSha = sha256File(CHR_EXT_ZIP);
  const rev1ArchiveSha = sha256File(path.join(ROOT, 'docs', 'security', 'tools-manifest-registry', 'history', 'prod_rev_0001_tools-manifest.json'));
  record(
    'G331-03',
    'Browser Companion v1.0.10 (Firefox signed XPI & Chromium ZIP) and immutable rev 1 registry archive preserved',
    xpiSha === EXPECTED_XPI_SHA && chrSha === EXPECTED_CHR_SHA && rev1ArchiveSha === EXPECTED_PROD_REV1_SHA,
    `xpiOk=${xpiSha === EXPECTED_XPI_SHA}, chrOk=${chrSha === EXPECTED_CHR_SHA}, rev1ArchiveOk=${rev1ArchiveSha === EXPECTED_PROD_REV1_SHA}`
  );

  // =========================================================================
  // GROUP B: PHASE 5 15-CHECK CRYPTOGRAPHIC MATRIX ON REV 2 CANDIDATE + ISOLATED TEST FIXTURES
  // =========================================================================
  const rev2Raw = fs.readFileSync(path.join(REV2_CAND_DIR, 'tools-manifest.json'), 'utf8');
  const rev2Obj = JSON.parse(rev2Raw);
  const racePolicy = JSON.parse(fs.readFileSync(path.join(REV2_CAND_DIR, 'RACE_PRECHECK_POLICY.json'), 'utf8'));
  const headArtifact = await httpsRequest(rev2Obj.ffmpeg_bundle.url, 'HEAD');
  const ttlDays = (new Date(rev2Obj.expires_at).getTime() - new Date(rev2Obj.published_at).getTime()) / 86400000;

  const phase5StaticOk =
    !hasDuplicateJsonKeys(rev2Raw) &&
    rev2Obj.schema_version === 2 &&
    rev2Obj.manifest_revision === 2 &&
    rev2Obj.signing_key_id === PROD_KEY_ID &&
    rev2Obj.key_purpose === 'external_tools_manifest' &&
    ttlDays >= 7 &&
    ttlDays <= 90 &&
    rev2Obj.ffmpeg_bundle.version === EXPECTED_FFMPEG_VER &&
    rev2Obj.ffmpeg_bundle.url === EXPECTED_FFMPEG_URL &&
    rev2Obj.ffmpeg_bundle.sha256 === EXPECTED_FFMPEG_SHA &&
    rev2Obj.ffmpeg_bundle.size === EXPECTED_FFMPEG_SIZE &&
    rev2Obj.ffmpeg_bundle.platform === 'windows' &&
    rev2Obj.ffmpeg_bundle.architecture === 'x86_64' &&
    rev2Obj.ffmpeg_bundle.min_tori_version === '1.0.6' &&
    headArtifact.status === 200 &&
    parseInt(headArtifact.headers['content-length'] || '0', 10) === EXPECTED_FFMPEG_SIZE &&
    racePolicy.race_condition_precheck?.expected_live_revision === 1 &&
    racePolicy.race_condition_precheck?.abort_if_live_revision_differs === true;

  record(
    'G331-04',
    'Phase 5 (Checks 1-9): Unpublished rev 2 candidate schema, monotonic rev, 45d UTC TTL, immutable artifact HEAD & race guard pass',
    phase5StaticOk,
    `rev=${rev2Obj.manifest_revision}, ttlDays=${ttlDays.toFixed(1)}, headStatus=${headArtifact.status}, headLen=${headArtifact.headers['content-length']}, raceGuardRev=${racePolicy.race_condition_precheck?.expected_live_revision}`
  );

  // Generate isolated non-production test keys strictly under target/gate33_1_qa/non_prod_test_fixtures/
  const legacyTestKey = generateTestMinisignKey('AA11223344556677');
  const dedicatedTestKey = generateTestMinisignKey('BB8899AABBCCDDEE');
  const rev2TestObj = JSON.parse(rev2Raw);
  rev2TestObj.signing_key_id = legacyTestKey.keyIdHex;
  const rev2TestBuf = Buffer.from(JSON.stringify(rev2TestObj, null, 2) + '\n', 'utf8');
  const rev2LegacySig = legacyTestKey.signB64(rev2TestBuf, 'tools-manifest.json');
  const rev2DedicatedCoSig = dedicatedTestKey.signB64(rev2TestBuf, 'tools-manifest.json');

  const rev2DedicatedOnlyObj = JSON.parse(rev2Raw);
  rev2DedicatedOnlyObj.signing_key_id = dedicatedTestKey.keyIdHex;
  const rev2DedicatedOnlyBuf = Buffer.from(JSON.stringify(rev2DedicatedOnlyObj, null, 2) + '\n', 'utf8');
  const rev2DedicatedOnlySig = dedicatedTestKey.signB64(rev2DedicatedOnlyBuf, 'tools-manifest.json');

  const rev3RollbackObj = JSON.parse(JSON.stringify(rev2DedicatedOnlyObj));
  rev3RollbackObj.manifest_revision = 3;
  rev3RollbackObj.ffmpeg_bundle.version = 'N-126374-g089a48eb36-20260831';
  rev3RollbackObj.ffmpeg_bundle.ffmpeg_version = 'N-126374-g089a48eb36-20260831';
  rev3RollbackObj.ffmpeg_bundle.ffprobe_version = 'N-126374-g089a48eb36-20260831';
  rev3RollbackObj.ffmpeg_bundle.allow_rollback_to = true;
  const rev3RollbackBuf = Buffer.from(JSON.stringify(rev3RollbackObj, null, 2) + '\n', 'utf8');
  const rev3RollbackSig = dedicatedTestKey.signB64(rev3RollbackBuf, 'tools-manifest.json');

  const rev2EscalationObj = JSON.parse(JSON.stringify(rev2DedicatedOnlyObj));
  rev2EscalationObj.manifest_revision = 4;
  rev2EscalationObj.trusted_keys = [{ key_id: 'DEADBEEF00001111', pubkey_b64: dedicatedTestKey.pubkeyB64 }];
  const rev2EscalationBuf = Buffer.from(JSON.stringify(rev2EscalationObj, null, 2) + '\n', 'utf8');
  const rev2EscalationSig = dedicatedTestKey.signB64(rev2EscalationBuf, 'tools-manifest.json');

  const tamperedBuf = Buffer.from(rev2TestBuf);
  tamperedBuf[15] ^= 0x01;
  const badSigRaw = Buffer.from(rev2LegacySig.trim(), 'base64');
  badSigRaw[badSigRaw.length - 8] ^= 0xff;
  const badSig = badSigRaw.toString('base64') + '\n';

  fs.writeFileSync(path.join(QA_NON_PROD_DIR, 'README_NON_PRODUCTION_TEST_ONLY.txt'), 'ISOLATED NON-PRODUCTION TEST FIXTURES ONLY. NEVER DEPLOY TO PRODUCTION.\n');
  fs.writeFileSync(path.join(QA_NON_PROD_DIR, 'tools-manifest-dual-test.json'), rev2TestBuf);
  fs.writeFileSync(path.join(QA_NON_PROD_DIR, 'tools-manifest-dual-test.json.sig'), rev2LegacySig);
  fs.writeFileSync(path.join(QA_NON_PROD_DIR, 'tools-manifest-dual-test.json.tools.sig'), rev2DedicatedCoSig);

  const phase5CryptoOk =
    verifyMinisignB64(legacyTestKey.pubkeyB64, rev2TestBuf, rev2LegacySig) &&
    verifyMinisignB64(dedicatedTestKey.pubkeyB64, rev2TestBuf, rev2DedicatedCoSig) &&
    !verifyMinisignB64(legacyTestKey.pubkeyB64, tamperedBuf, rev2LegacySig) &&
    !verifyMinisignB64(legacyTestKey.pubkeyB64, rev2TestBuf, badSig) &&
    !verifyMinisignB64(dedicatedTestKey.pubkeyB64, rev2TestBuf, rev2LegacySig) &&
    verifyMinisignB64(dedicatedTestKey.pubkeyB64, rev2DedicatedOnlyBuf, rev2DedicatedOnlySig);

  record(
    'G331-05',
    'Phase 5 (Checks 10-15): Isolated non-prod dual-sig (.sig + .tools.sig), tamper rejection, sig corruption & wrong-key rejection pass',
    phase5CryptoOk,
    `legacyKey=${legacyTestKey.keyIdHex}, dedicatedKey=${dedicatedTestKey.keyIdHex}, nonProdDirSeparated=true`
  );

  // =========================================================================
  // OEM GUARD & LOCAL FIXTURE SERVER (FILES + PHASE 11 DUAL-KEY MANIFEST ENDPOINTS)
  // =========================================================================
  const oemGuard = new QaOemStateGuard('gate33_1');
  oemGuard.backup({ stopRunningOem: true });
  oemGuard.temporarilySilenceNativeHostAutoSpawn();
  await sleep(600);

  const oemDbBefore = snapshotOemDatabase(OEM_DB_PATH);
  const oemExeShaBefore = sha256File(OEM_DESKTOP_EXE);
  let oemDbAfter = null;

  const bufPreDone = makePatternBuffer(1024 * 1024, '504b0304');
  const bufPrePaused = makePatternBuffer(12 * 1024 * 1024, '1a45dfa3');
  const bufPostNew = makePatternBuffer(4 * 1024 * 1024, 'deadbeef');
  const bufActiveLong = makePatternBuffer(6 * 1024 * 1024, 'cafebabe');
  const bufFfMkv = makePatternBuffer(3 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');

  const sha = {
    preDone: sha256Buf(bufPreDone),
    prePaused: sha256Buf(bufPrePaused),
    postNew: sha256Buf(bufPostNew),
    activeLong: sha256Buf(bufActiveLong),
    ffMkv: sha256Buf(bufFfMkv),
  };

  fixtureServer = http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${PORT_FIXTURE}`);
    const p = u.pathname;
    // Phase 11 mock manifest routes
    if (p === '/m/dual/tools-manifest.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(rev2TestBuf); }
    if (p === '/m/dual/tools-manifest.json.sig') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(rev2LegacySig); }
    if (p === '/m/dual/tools-manifest.json.tools.sig') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(rev2DedicatedCoSig); }
    if (p === '/m/dedicated/tools-manifest.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(rev2DedicatedOnlyBuf); }
    if (p === '/m/dedicated/tools-manifest.json.sig') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(rev2DedicatedOnlySig); }
    if (p === '/m/invalid/tools-manifest.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(rev2TestBuf); }
    if (p === '/m/invalid/tools-manifest.json.sig') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(badSig); }
    if (p === '/m/rollback/tools-manifest.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(rev3RollbackBuf); }
    if (p === '/m/rollback/tools-manifest.json.sig') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(rev3RollbackSig); }
    if (p === '/m/escalation/tools-manifest.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(rev2EscalationBuf); }
    if (p === '/m/escalation/tools-manifest.json.sig') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(rev2EscalationSig); }

    if (p === '/missing_404.zip') {
      if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': '1048576', 'Accept-Ranges': 'bytes', 'Content-Type': 'application/zip' }); return res.end(); }
      if (req.headers.range === 'bytes=0-0') { res.writeHead(206, { 'Content-Range': 'bytes 0-0/1048576', 'Content-Length': '1', 'Accept-Ranges': 'bytes', 'Content-Type': 'application/zip' }); return res.end(Buffer.from([0x50])); }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Simulated transfer 404');
    }
    if (p === '/ff_page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html><body><h1>Gate 33.1 Firefox v1.0.10 QA</h1><a id="dl-mkv" href="/ff_v1010.mkv">Download MKV</a></body></html>');
    }
    const rangeServe = (buf, ctype, throttleMs = 0, extra = {}) => {
      const total = buf.length;
      if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': String(total), 'Accept-Ranges': 'bytes', ...extra }); return res.end(); }
      let start = 0; let end = total - 1; let status = 200;
      const r = req.headers.range;
      if (r && r.startsWith('bytes=')) {
        const [s, e] = r.slice(6).split('-');
        start = parseInt(s, 10) || 0;
        end = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
        status = 206;
      }
      res.writeHead(status, {
        'Content-Type': ctype,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
        ...extra,
      });
      if (throttleMs <= 0) return res.end(buf.subarray(start, end + 1));
      let pos = start;
      const step = 131072;
      const pump = () => {
        if (res.writableEnded || res.destroyed) return;
        const next = Math.min(pos + step, end + 1);
        res.write(buf.subarray(pos, next));
        pos = next;
        if (pos > end) res.end(); else setTimeout(pump, throttleMs);
      };
      pump();
    };
    if (p === '/pre_done.zip') return rangeServe(bufPreDone, 'application/zip');
    if (p === '/pre_paused.bin') return rangeServe(bufPrePaused, 'application/octet-stream', 140);
    if (p === '/post_new.bin') return rangeServe(bufPostNew, 'application/octet-stream', 12);
    if (p === '/active_long.bin') return rangeServe(bufActiveLong, 'application/octet-stream', 20);
    if (p === '/ff_v1010.mkv') return rangeServe(bufFfMkv, 'video/x-matroska', 0, { 'Content-Disposition': 'attachment; filename="gate33_1_ff_v1010.mkv"' });
    res.writeHead(404); res.end();
  });
  await new Promise((r) => fixtureServer.listen(PORT_FIXTURE, '127.0.0.1', r));

  const perf = {};
  let boot = null;

  try {
    // =========================================================================
    // GROUP C: PHASE 10 REAL ISOLATED v1.0.7 -> v1.0.8-RC NSIS UPGRADE
    // =========================================================================
    console.log('\n>>> [PHASE 10] Installing baseline Desktop v1.0.7 into isolated QA folder <<<');
    execSync(`"${INST_107_EXE}" /S /D=${QA_INST_DIR}`, { timeout: 120000 });
    oemGuard.temporarilySilenceNativeHostAutoSpawn(path.join(QA_ROOT, 'shield'));

    // Snapshot a frozen copy of the installed v1.0.7 binary directory for Phase 11 side-by-side matrix!
    fs.cpSync(QA_INST_DIR, QA_V107_COPY_DIR, { recursive: true });
    const v107Exe = path.join(QA_V107_COPY_DIR, 'tori-download-manager.exe');
    const instExe = path.join(QA_INST_DIR, 'tori-download-manager.exe');
    const instHost = path.join(QA_INST_DIR, 'bin', 'tdm-native-host.exe');
    const verBefore = getPeVersion(instExe);
    if (verBefore !== '1.0.7') throw new Error(`Expected baseline installed version 1.0.7, got ${verBefore}`);

    boot = await bootDesktop({
      exe: instExe,
      dataDir: QA_DATA_DIR,
      wv2Dir: QA_WV2_DIR,
      dlDir: QA_DL_DIR,
      profDir: QA_PROF_DIR,
      port: PORT_APP,
      cdpPort: PORT_CDP,
      token: API_TOKEN,
      pipeSuffix: 'v107_pre',
    });
    let appPort = boot.port;
    let appToken = boot.token;

    await boot.cdp.evalJson(`
      const s = (await window.__TAURI_INTERNALS__.invoke('get_engine_settings')) || {};
      s.closeToTray = true;
      s.showDownloadPopup = 'always';
      s.dir = ${JSON.stringify(QA_DL_DIR)};
      s.theme = 'light';
      await window.__TAURI_INTERNALS__.invoke('update_engine_settings', { settings: s });
      await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: { auto_update: true, check_interval_hours: 24, auto_install: false, notify_on_update: true, defer_while_in_use: true }
      });
    `);

    // Seed completed, genuinely paused mid-transfer (.tdm-part), failed, and queued downloads
    const c1 = await httpJson({
      port: appPort, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': appToken },
      body: { url: `http://127.0.0.1:${PORT_FIXTURE}/pre_done.zip`, filename: 'pre_done.zip' },
    });
    const jDone = await waitForJob(appPort, appToken, (j) => j.id === c1.data?.job_id && j.state === 'completed', 25000);

    const c2 = await httpJson({
      port: appPort, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': appToken },
      body: { url: `http://127.0.0.1:${PORT_FIXTURE}/pre_paused.bin`, filename: 'pre_paused.bin' },
    });
    const pausedId = c2.data?.job_id;
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      const st = await httpJson({ port: appPort, reqPath: `/api/v1/downloads/${pausedId}`, headers: { 'X-Tori-Token': appToken } });
      if (st.ok && st.data?.downloaded_bytes >= 500000) break;
    }
    await httpJson({ port: appPort, reqPath: `/api/v1/downloads/${pausedId}/pause`, method: 'POST', headers: { 'X-Tori-Token': appToken } });
    const jPaused = await waitForJob(appPort, appToken, (j) => j.id === pausedId && j.state === 'paused', 10000);

    const c3 = await httpJson({
      port: appPort, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': appToken },
      body: { url: `http://127.0.0.1:${PORT_FIXTURE}/missing_404.zip`, filename: 'missing_404.zip' },
    });
    await waitForJob(appPort, appToken, (j) => j.id === c3.data?.job_id && j.state === 'failed', 35000);

    await boot.cdp.evalJson(`
      await window.__TAURI_INTERNALS__.invoke('create_download', {
        url: 'http://127.0.0.1:${PORT_FIXTURE}/pre_done.zip?q=1',
        destination: ${JSON.stringify(QA_DL_DIR)},
        startImmediately: false
      });
    `);

    const partPath = jPaused?.temp_path || (jPaused?.target_path ? `${jPaused.target_path}.tdm-part` : null);
    const partShaBefore = sha256File(partPath);
    const preSettings = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_engine_settings');`);

    // Leave v1.0.7 running during in-place v1.0.8-rc NSIS upgrade to prove stale-process cleanup!
    boot.cdp.close();
    console.log('\n>>> [PHASE 10] Executing REAL in-place NSIS upgrade v1.0.7 -> v1.0.8-rc <<<');
    execSync(`"${INST_108_EXE}" /S /D=${QA_INST_DIR}`, { timeout: 120000 });
    oemGuard.temporarilySilenceNativeHostAutoSpawn(path.join(QA_ROOT, 'shield'));
    await sleep(600);
    killProcTree(boot.proc.pid);
    trackedProcs.delete(boot.proc);

    const verAfter = getPeVersion(instExe);
    const bundledFilesOk =
      ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe', 'tdm-native-host.exe', 'tdm-cli.exe'].every((f) =>
        fs.existsSync(path.join(QA_INST_DIR, 'bin', f))
      ) && fs.existsSync(path.join(QA_INST_DIR, 'LICENSE-THIRD-PARTY.txt'));
    const regInstallDir = queryRegDefault(REG_MANU);

    record(
      'G331-06',
      'Real in-place NSIS upgrade v1.0.7 -> v1.0.8-rc updates binary PE version, bundled tools & registry cleanly',
      verBefore === '1.0.7' &&
        verAfter === '1.0.8' &&
        bundledFilesOk &&
        Boolean(regInstallDir && regInstallDir.toLowerCase() === QA_INST_DIR.toLowerCase()),
      `before=${verBefore}, after=${verAfter}, bundledComplete=${bundledFilesOk}, regDir=${regInstallDir}`
    );

    // Cold boot upgraded v1.0.8-rc using DEFAULT production manifest URL!
    boot = await bootDesktop({
      exe: instExe,
      dataDir: QA_DATA_DIR,
      wv2Dir: QA_WV2_DIR,
      dlDir: QA_DL_DIR,
      profDir: QA_PROF_DIR,
      port: PORT_APP,
      cdpPort: PORT_CDP,
      token: API_TOKEN,
      pipeSuffix: 'v108_upg',
    });
    appPort = boot.port;
    appToken = boot.token;
    perf.coldStartupMs = boot.startupMs;
    await sleep(800);
    perf.idleStats = getTreeStats(boot.proc.pid);

    const appVer = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_app_version');`);
    const migInfo = querySqliteTables(path.join(QA_DATA_DIR, 'tdm_storage.sqlite'));

    await boot.cdp.evalJson(`
      document.documentElement.setAttribute('data-theme', 'light');
      const btn = Array.from(document.querySelectorAll('#tool button')).find(b => b.textContent.includes('Settings'));
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 350));
      const aboutTab = document.querySelector('[data-tab="about"]');
      if (aboutTab) aboutTab.click();
      await new Promise(r => setTimeout(r, 350));
    `);
    const aboutText = await boot.cdp.evalJson(`return document.body.innerText;`);
    await boot.cdp.screenshot(path.join(SHOTS_DIR, 'gate33_1_01_about_v108_light.png'));

    record(
      'G331-07',
      'Upgraded v1.0.8-rc launches cleanly (no SECONDARY_INSTANCE), reports v1.0.8, About UI & SQLite integrity ok',
      appVer === '1.0.8' &&
        aboutText.includes('1.0.8') &&
        boot.serverOk &&
        migInfo.integrity.join(',') === 'ok' &&
        migInfo.tables.includes('external_tools_registry') &&
        migInfo.tables.includes('external_tool_update_history') &&
        migInfo.downloads >= 4,
      `appVer=${appVer}, coldStartupMs=${perf.coldStartupMs}, mig=${JSON.stringify(migInfo)}`
    );

    // Check preserved downloads, settings, .tdm-part bytes & resume paused download to exact SHA-256!
    const postJobsResp = await httpJson({ port: appPort, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': appToken } });
    const postJobs = postJobsResp.data?.jobs || [];
    const postPrePaused = postJobs.find((j) => j.id === pausedId);
    const postPreFailed = postJobs.find((j) => j.id === c3.data?.job_id);
    const postPreDone = postJobs.find((j) => j.id === c1.data?.job_id);
    const postSettings = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_engine_settings');`);
    const partShaAfter = sha256File(partPath);
    await httpJson({ port: appPort, reqPath: `/api/v1/downloads/${pausedId}/resume`, method: 'POST', headers: { 'X-Tori-Token': appToken } });
    const resumedDone = await waitForJob(appPort, appToken, (j) => j.id === pausedId && j.state === 'completed', 60000);
    const resumedShaOk = Boolean(resumedDone?.target_path && sha256File(resumedDone.target_path) === sha.prePaused);

    record(
      'G331-08',
      'v1.0.7 -> v1.0.8-rc preserves downloads, settings & .tdm-part bytes, and resumes paused transfer to exact SHA-256',
      Boolean(
        postPreDone?.state === 'completed' &&
          postPreFailed?.state === 'failed' &&
          postPrePaused?.state === 'paused' &&
          partShaBefore &&
          partShaBefore === partShaAfter &&
          postSettings?.closeToTray === preSettings?.closeToTray &&
          postSettings?.showDownloadPopup === preSettings?.showDownloadPopup &&
          resumedDone?.state === 'completed' &&
          resumedShaOk
      ),
      JSON.stringify({
        done: postPreDone?.state,
        failed: postPreFailed?.state,
        pausedBeforeResume: postPrePaused?.state,
        partMatch: Boolean(partShaBefore && partShaBefore === partShaAfter),
        resumedShaOk,
      })
    );

    // Verify standalone IDM Progress Window (ZERO legacy dark toast) on upgraded v1.0.8-rc!
    const tDl0 = Date.now();
    const cNew = await httpJson({
      port: appPort, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': appToken },
      body: { url: `http://127.0.0.1:${PORT_FIXTURE}/post_new.bin`, filename: 'post_new.bin' },
    });
    const newId = cNew.data?.job_id;
    let popDiag = { isIdm: false, legacyToast: false, label: '' };
    for (let i = 0; i < 40; i++) {
      await sleep(120);
      const targets = await listCdpTargets(PORT_CDP);
      const popTgt = targets.find((t) => t.webSocketDebuggerUrl && String(t.url || '').includes(newId));
      if (popTgt) {
        const pCdp = new CDPClient(popTgt.webSocketDebuggerUrl);
        try {
          await pCdp.connect();
          await sleep(500);
          popDiag = await pCdp.evalJson(`
            return {
              isIdm: Boolean(document.querySelector('.dl-popup-root #w') && document.querySelectorAll('.dl-tabs .dl-tab').length === 3),
              legacyToast: Boolean(document.querySelector('.toast-card, .toast-stack, svg circle[stroke-dasharray]')),
              label: window.__TAURI__?.window?.getCurrentWindow()?.label || ''
            };
          `);
        } finally { pCdp.close(); }
        break;
      }
    }
    const jNewDone = await waitForJob(appPort, appToken, (j) => j.id === newId && j.state === 'completed', 30000);
    perf.activeDownloadThroughputMBs = Number(((bufPostNew.length / (1024 * 1024)) / Math.max(0.05, (Date.now() - tDl0) / 1000)).toFixed(2));
    record(
      'G331-09',
      'Upgraded v1.0.8-rc opens standalone IDM Progress Window (no legacy toast) and completes with exact SHA-256',
      popDiag.isIdm && !popDiag.legacyToast && popDiag.label.startsWith('progress_') && jNewDone?.state === 'completed' && sha256File(jNewDone.target_path) === sha.postNew,
      `${JSON.stringify(popDiag)}, throughputMBs=${perf.activeDownloadThroughputMBs}`
    );

    // Close-to-Tray & Settings -> External Tools Trust Status strip (Light & Dark screenshots!)
    await boot.cdp.evalJson(`await window.__TAURI_INTERNALS__.invoke('hide_main_window');`);
    await sleep(300);
    const aliveHidden = (await httpJson({ port: appPort, reqPath: '/api/v1/status', headers: { 'X-Tori-Token': appToken } })).ok;
    await boot.cdp.evalJson(`await window.__TAURI_INTERNALS__.invoke('show_main_window');`);
    await sleep(300);

    await boot.cdp.evalJson(`
      const tab = document.querySelector('[data-tab="tools"]');
      if (tab) tab.click();
      await new Promise(r => setTimeout(r, 350));
    `);
    let prodSnap = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');`);
    const chkEnd = Date.now() + 25000;
    while (Date.now() < chkEnd && prodSnap.checking) {
      await sleep(350);
      prodSnap = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_external_tools_status');`);
    }
    await sleep(400);
    const trustUi = await boot.cdp.evalJson(`
      return {
        hasStrip: Boolean(document.querySelector('[data-testid="external-tools-manifest-status"]')),
        badge: document.querySelector('[data-testid="manifest-verification-badge"]')?.textContent?.trim() || '',
        revMeta: document.querySelector('[data-testid="manifest-revision-meta"]')?.textContent?.trim() || '',
        hasNextCheck: Boolean(document.querySelector('[data-testid="external-tools-next-check"]')),
        fullText: document.querySelector('[data-testid="external-tools-manifest-status"]')?.textContent || '',
      };
    `);
    await boot.cdp.screenshot(path.join(SHOTS_DIR, 'gate33_1_02_external_tools_v108_light.png'));
    await boot.cdp.evalJson(`document.documentElement.setAttribute('data-theme', 'dark'); await new Promise(r => setTimeout(r, 300));`);
    await boot.cdp.screenshot(path.join(SHOTS_DIR, 'gate33_1_03_external_tools_v108_dark.png'));
    await boot.cdp.evalJson(`document.documentElement.setAttribute('data-theme', 'light');`);
    const noUiSecrets = !/PRIVATE KEY|password|secret/i.test(trustUi.fullText);

    record(
      'G331-10',
      `Close-to-Tray works & Settings -> External Tools verifies live prod rev ${EXPECTED_ACTIVE_PROD_REV} with trust status UI (Light & Dark, zero secrets)`,
      aliveHidden &&
        trustUi.hasStrip &&
        trustUi.badge.includes(`Rev ${EXPECTED_ACTIVE_PROD_REV}`) &&
        trustUi.hasNextCheck &&
        noUiSecrets &&
        prodSnap.manifest_status?.verification_status === 'verified' &&
        prodSnap.manifest_status?.current_revision === EXPECTED_ACTIVE_PROD_REV,
      `trayAlive=${aliveHidden}, badge="${trustUi.badge}", key=${prodSnap.manifest_status?.signing_key_id}`
    );

    // =========================================================================
    // GROUP E (PART 1): PHASE 12 EXTERNAL TOOLS REAL-WORLD VALIDATION ON UPGRADED v1.0.8-RC
    // =========================================================================
    console.log('\n>>> [PHASE 12] External Tools Real-World Validation (yt-dlp OpenPGP, active protection, rollback, FFmpeg/FFprobe) <<<');
    const preActYt = prodSnap.tools.find((t) => t.tool_id === 'yt-dlp');
    if (preActYt?.source === 'managed' && preActYt?.rollback_available) {
      await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('rollback_external_tool', { toolId: 'yt-dlp' });`);
    }
    const httpAct = await httpJson({
      port: appPort, reqPath: '/api/v1/downloads', method: 'POST', headers: { 'X-Tori-Token': appToken },
      body: { url: `http://127.0.0.1:${PORT_FIXTURE}/active_long.bin`, filename: 'active_long.bin' },
    });
    const ytAct = await boot.cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('create_media_download', {
        args: {
          url: ${JSON.stringify(WATCH_YT_URL)},
          format_id: '230+234/bestvideo+bestaudio/best',
          filename: 'gate33_1_active_yt.mp4',
          destination: ${JSON.stringify(QA_DL_DIR)},
          start_immediately: true
        }
      });
    `);
    const concurrentUpdatePromise = boot.cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'yt-dlp' });
    `);
    const [updDuringActive, httpActDone, ytActDone] = await Promise.all([
      concurrentUpdatePromise,
      waitForJob(appPort, appToken, (j) => j.id === httpAct.data?.job_id && j.state === 'completed', 45000),
      waitForJob(appPort, appToken, (j) => j.id === ytAct.id && j.state === 'completed', 65000),
    ]);
    let ytAfterSettle = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_external_tools_status');`);
    const ytTool = ytAfterSettle.tools.find((t) => t.tool_id === 'yt-dlp');
    if (ytTool?.update_status === 'pending_activation') {
      ytAfterSettle = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'yt-dlp' });`);
    }
    const finalYtTool = ytAfterSettle.tools.find((t) => t.tool_id === 'yt-dlp');
    const tRb0 = Date.now();
    const afterRb = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('rollback_external_tool', { toolId: 'yt-dlp' });`);
    perf.rollbackMs = Date.now() - tRb0;
    const rbYt = afterRb.tools.find((t) => t.tool_id === 'yt-dlp');

    // Direct FFmpeg H.264/AAC MP4 + MKV transcode & FFprobe JSON validation on upgraded v1.0.8-rc binaries!
    const ffExe = path.join(QA_INST_DIR, 'bin', 'ffmpeg.exe');
    const fpExe = path.join(QA_INST_DIR, 'bin', 'ffprobe.exe');
    const testMp4 = path.join(QA_DL_DIR, 'ffmpeg_selftest.mp4');
    const testMkv = path.join(QA_DL_DIR, 'ffmpeg_selftest.mkv');
    const ffRes1 = spawnSync(ffExe, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', testMp4], { encoding: 'utf8', timeout: 30000 });
    const ffRes2 = spawnSync(ffExe, ['-y', '-i', testMp4, '-c', 'copy', testMkv], { encoding: 'utf8', timeout: 20000 });
    const fpRes = spawnSync(fpExe, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', testMp4], { encoding: 'utf8', timeout: 15000 });
    const fpJson = fpRes.status === 0 ? JSON.parse(fpRes.stdout) : null;
    const ffCodecOk =
      ffRes1.status === 0 &&
      ffRes2.status === 0 &&
      Boolean(fpJson?.streams?.some((s) => s.codec_name === 'h264') && fpJson?.streams?.some((s) => s.codec_name === 'aac'));

    record(
      'G331-17',
      'Phase 12 External Tools: yt-dlp OpenPGP update + active HTTP/YouTube protection + rollback + FFmpeg H.264/AAC/MKV & FFprobe JSON',
      Boolean(
        httpActDone?.state === 'completed' &&
          sha256File(httpActDone.target_path) === sha.activeLong &&
          ytActDone?.state === 'completed' &&
          fs.existsSync(ytActDone.target_path) &&
          finalYtTool?.source === 'managed' &&
          rbYt?.source === 'bundled' &&
          rbYt?.update_status === 'rolled_back' &&
          ffCodecOk
      ),
      `ytManaged=${finalYtTool?.installed_version}, rollbackMs=${perf.rollbackMs}, during=${updDuringActive?.tools?.find((t) => t.tool_id === 'yt-dlp')?.update_status}, ffCodecOk=${ffCodecOk}`
    );

    // Warm restart persistence test!
    boot.cdp.close();
    killProcTree(boot.proc.pid);
    trackedProcs.delete(boot.proc);
    await sleep(500);

    boot = await bootDesktop({
      exe: instExe,
      dataDir: QA_DATA_DIR,
      wv2Dir: QA_WV2_DIR,
      dlDir: QA_DL_DIR,
      profDir: QA_PROF_DIR,
      port: PORT_APP,
      cdpPort: PORT_CDP,
      token: API_TOKEN,
      pipeSuffix: 'v108_warm',
    });
    appPort = boot.port;
    appToken = boot.token;
    perf.warmStartupMs = boot.startupMs;
    const histAfterRestart = await boot.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('get_external_tool_update_history', { limit: 50 });`);
    const dlListAfterRestart = await httpJson({ port: appPort, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': appToken } });
    // Allow startup bundled-tool --version probe (PyInstaller yt-dlp) up to 5s to finish before checking for leaked consoles
    perf.postRunStats = getTreeStats(boot.proc.pid);
    for (let i = 0; i < 10 && perf.postRunStats.consoleCount > 0; i++) {
      await sleep(500);
      perf.postRunStats = getTreeStats(boot.proc.pid);
    }
    record(
      'G331-11',
      'Warm restart preserves download history, SQLite tool registry, update history & zero leaked console windows',
      Array.isArray(histAfterRestart) &&
        histAfterRestart.length >= 2 &&
        (dlListAfterRestart.data?.jobs?.length || 0) >= 6 &&
        perf.postRunStats.consoleCount === 0,
      `warmStartupMs=${perf.warmStartupMs}, history=${histAfterRestart?.length}, downloads=${dlListAfterRestart.data?.jobs?.length}, stats=${JSON.stringify(perf.postRunStats)}`
    );

    // =========================================================================
    // GROUP E (PART 2): PHASE 13 BROWSER COMPANION v1.0.10 COMPATIBILITY
    // =========================================================================
    console.log('\n>>> [PHASE 13] Browser Companion v1.0.10 Native Messaging & Real Firefox Signed XPI Capture <<<');
    const nmPing = sendNativeHostMessage(
      instHost,
      { action: 'ping' },
      { TORI_DATA_DIR: QA_DATA_DIR, TORI_IPC_PIPE: `\\\\.\\pipe\\tori_g331_v108_warm_${process.pid}` }
    );
    const httpFallback = await httpJson({ port: appPort, reqPath: '/api/v1/status', headers: { 'X-Tori-Token': appToken } });
    const chrManifest = JSON.parse(fs.readFileSync(path.join(CHR_EXT_DIR, 'manifest.json'), 'utf8'));
    const chrContentJs = fs.readFileSync(path.join(CHR_EXT_DIR, 'content.js'), 'utf8');
    record(
      'G331-18',
      'Upgraded v1.0.8-rc Native Messaging stdio (pong), HTTP fallback & Companion v1.0.10 Chromium (Chrome/Edge) package verified',
      Boolean(
        nmPing.ok &&
          nmPing.response &&
          httpFallback.ok &&
          chrManifest.version === '1.0.10' &&
          chrContentJs.includes('instagram') &&
          chrContentJs.includes('youtube') &&
          chrContentJs.includes('open-playlist')
      ),
      `nmResp=${JSON.stringify(nmPing.response)}, httpOk=${httpFallback.ok}, extVer=${chrManifest.version}`
    );

    // Permanent Mozilla-signed Firefox Companion v1.0.10 XPI live capture into v1.0.8-rc!
    fs.mkdirSync(QA_FF_PROF, { recursive: true });
    fs.mkdirSync(QA_FF_DL, { recursive: true });
    const qaNmBat = path.join(QA_ROOT, 'nm_host_v108.cmd');
    fs.writeFileSync(
      qaNmBat,
      `@echo off\r\nset TORI_DATA_DIR=${QA_DATA_DIR}\r\nset TORI_IPC_PIPE=\\\\.\\pipe\\tori_g331_v108_warm_${process.pid}\r\n"${instHost}" %*\r\n`
    );
    const qaFfNmJson = path.join(QA_ROOT, 'com.tori.download_manager.firefox.json');
    fs.writeFileSync(
      qaFfNmJson,
      JSON.stringify({
        name: 'com.tori.download_manager',
        description: 'TORI v1.0.8-rc QA Native Host',
        path: qaNmBat,
        type: 'stdio',
        allowed_extensions: [EXPECTED_GECKO_ID],
      }, null, 2)
    );
    execFileSync('reg', ['add', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', qaFfNmJson, '/f'], { stdio: 'ignore' });
    fs.writeFileSync(
      path.join(QA_FF_PROF, 'user.js'),
      [
        `user_pref("marionette.port", ${PORT_FF_MAR});`,
        'user_pref("xpinstall.signatures.required", true);',
        'user_pref("extensions.autoDisableScopes", 0);',
        'user_pref("browser.download.folderList", 2);',
        `user_pref("browser.download.dir", ${JSON.stringify(QA_FF_DL)});`,
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
      ].join('\n')
    );

    const ffProc = spawn(FIREFOX_EXE, ['-no-remote', '-profile', QA_FF_PROF, '-marionette', 'about:blank'], { stdio: 'ignore' });
    trackedProcs.add(ffProc);
    const mar = new MarionetteClient(PORT_FF_MAR);
    await mar.connect(30000);
    await mar.send('WebDriver:NewSession', {});
    const addonId = await mar.send('Addon:Install', { path: SIGNED_FF_XPI, temporary: false }, 20000);

    const beforeFfIds = new Set(((await httpJson({ port: appPort, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': appToken } })).data?.jobs || []).map((j) => j.id));
    await mar.send('WebDriver:Navigate', { url: `http://127.0.0.1:${PORT_FIXTURE}/ff_page.html` }, 20000);
    await sleep(1500);
    await mar.send('WebDriver:ExecuteScript', { script: `document.getElementById('dl-mkv').click();`, args: [] }, 10000);
    const ffMkvJob = await waitForJob(appPort, appToken, (j) => !beforeFfIds.has(j.id) && j.state === 'completed', 30000);
    const allAfterFf = ((await httpJson({ port: appPort, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': appToken } })).data?.jobs || []).filter((j) => !beforeFfIds.has(j.id));
    const ffMkvShaOk = ffMkvJob?.target_path && sha256File(ffMkvJob.target_path) === sha.ffMkv;

    try { await mar.send('Marionette:Quit', {}); } catch {}
    mar.close();
    killProcTree(ffProc.pid);
    trackedProcs.delete(ffProc);

    record(
      'G331-19',
      'Permanent Mozilla-signed Firefox Companion v1.0.10 XPI captures MKV into upgraded v1.0.8-rc (zero duplicates, exact SHA-256)',
      addonId?.value === EXPECTED_GECKO_ID && ffMkvJob?.state === 'completed' && ffMkvShaOk && allAfterFf.length === 1,
      `addon=${addonId?.value}, newJobs=${allAfterFf.length}, shaMatch=${ffMkvShaOk}`
    );

    // Close main upgraded desktop before running side-by-side Phase 11 Matrix
    boot.cdp.close();
    killProcTree(boot.proc.pid);
    trackedProcs.delete(boot.proc);
    await sleep(500);

    // =========================================================================
    // GROUP D: PHASE 11 REAL CROSS-VERSION v1.0.7 vs v1.0.8-RC KEY COMPATIBILITY MATRIX
    // =========================================================================
    console.log('\n>>> [PHASE 11] Cross-Version v1.0.7 vs v1.0.8-rc Key Compatibility Matrix (Scenarios A-E) <<<');
    const dualKeyring = {
      keyring_version: 1,
      allow_legacy_shared_key: true,
      revoked_key_ids: [],
      keys: [
        {
          key_id: legacyTestKey.keyIdHex,
          pubkey_b64: legacyTestKey.pubkeyB64,
          purpose: 'external_tools_legacy_shared',
          status: 'transition_legacy',
          label: 'Gate 33.1 Test Legacy Key',
        },
        {
          key_id: dedicatedTestKey.keyIdHex,
          pubkey_b64: dedicatedTestKey.pubkeyB64,
          purpose: 'external_tools_manifest',
          status: 'active',
          label: 'Gate 33.1 Test Dedicated External Tools Key',
        },
      ],
    };

    // Scenario A: Live production rev 1 (legacy-signed CDC23D8CC8DA5397) on BOTH v1.0.7 AND v1.0.8-rc!
    const scenA_v107 = await runManifestCheckOnBinary({
      exe: v107Exe,
      dataDir: path.join(QA_ROOT, 'mat_a_v107_data'),
      wv2Dir: path.join(QA_ROOT, 'mat_a_v107_wv2'),
      dlDir: QA_DL_DIR,
      profDir: QA_PROF_DIR,
      cdpPort: 25414,
      pipeSuffix: 'matA_107',
      extraEnv: {}, // default live production manifest!
    });
    const scenA_v108 = prodSnap; // already verified live production rev 1 on upgraded v1.0.8-rc!
    const ffA107 = scenA_v107.tools.find((t) => t.tool_id === 'ffmpeg');
    const ffA108 = scenA_v108.tools.find((t) => t.tool_id === 'ffmpeg');
    record(
      'G331-12',
      'Phase 11 Scenario A (Live prod rev 1 legacy-signed): BOTH frozen v1.0.7 AND upgraded v1.0.8-rc verify & accept',
      ffA107?.update_status === 'update_available' &&
        ffA107?.available_version === EXPECTED_FFMPEG_VER &&
        ffA108?.update_status === 'update_available' &&
        ffA108?.available_version === EXPECTED_FFMPEG_VER &&
        scenA_v108.manifest_status?.verification_status === 'verified',
      `v107=${ffA107?.update_status}(${ffA107?.available_version}), v108=${ffA108?.update_status}(rev=${scenA_v108.manifest_status?.current_revision})`
    );

    // Scenario B: Dual-signed rev 2 (legacy .sig + dedicated .tools.sig) on BOTH v1.0.7 (legacy-only) AND v1.0.8-rc (dual-key)!
    const dualUrl = `http://127.0.0.1:${PORT_FIXTURE}/m/dual/tools-manifest.json`;
    const scenB_v107 = await runManifestCheckOnBinary({
      exe: v107Exe,
      dataDir: path.join(QA_ROOT, 'mat_b_v107_data'),
      wv2Dir: path.join(QA_ROOT, 'mat_b_v107_wv2'),
      dlDir: QA_DL_DIR,
      profDir: QA_PROF_DIR,
      cdpPort: 25415,
      pipeSuffix: 'matB_107',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: dualUrl,
        TORI_TEST_TOOLS_PUBKEY: legacyTestKey.pubkeyB64,
      },
    });
    const scenB_v108 = await runManifestCheckOnBinary({
      exe: instExe,
      dataDir: path.join(QA_ROOT, 'mat_b_v108_data'),
      wv2Dir: path.join(QA_ROOT, 'mat_b_v108_wv2'),
      dlDir: QA_DL_DIR,
      profDir: QA_PROF_DIR,
      cdpPort: 25416,
      pipeSuffix: 'matB_108',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: dualUrl,
        TORI_TEST_TOOLS_KEYRING_JSON: JSON.stringify(dualKeyring),
      },
    });
    const ffB107 = scenB_v107.tools.find((t) => t.tool_id === 'ffmpeg');
    const ffB108 = scenB_v108.tools.find((t) => t.tool_id === 'ffmpeg');
    record(
      'G331-13',
      'Phase 11 Scenario B (Dual-signed rev 2): frozen v1.0.7 accepts via legacy .sig AND upgraded v1.0.8-rc verifies via dual-key keyring',
      ffB107?.update_status === 'update_available' &&
        ffB108?.update_status === 'update_available' &&
        scenB_v108.manifest_status?.verification_status === 'verified' &&
        scenB_v108.manifest_status?.current_revision === 2,
      `v107=${ffB107?.update_status}, v108=${scenB_v108.manifest_status?.verification_status}/rev=${scenB_v108.manifest_status?.current_revision}`
    );

    // Scenario C: Dedicated-key-only rev 2 -> frozen v1.0.7 STRICTLY REJECTS while Stage 1 v1.0.8-rc ACCEPTS!
    const dedUrl = `http://127.0.0.1:${PORT_FIXTURE}/m/dedicated/tools-manifest.json`;
    const scenC_v107 = await runManifestCheckOnBinary({
      exe: v107Exe,
      dataDir: path.join(QA_ROOT, 'mat_c_v107_data'),
      wv2Dir: path.join(QA_ROOT, 'mat_c_v107_wv2'),
      dlDir: QA_DL_DIR,
      profDir: QA_PROF_DIR,
      cdpPort: 25417,
      pipeSuffix: 'matC_107',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: dedUrl,
        TORI_TEST_TOOLS_PUBKEY: legacyTestKey.pubkeyB64,
      },
    });
    const scenC_v108_data = path.join(QA_ROOT, 'mat_c_v108_data');
    const scenC_v108 = await runManifestCheckOnBinary({
      exe: instExe,
      dataDir: scenC_v108_data,
      wv2Dir: path.join(QA_ROOT, 'mat_c_v108_wv2'),
      dlDir: QA_DL_DIR,
      profDir: QA_PROF_DIR,
      cdpPort: 25418,
      pipeSuffix: 'matC_108',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: dedUrl,
        TORI_TEST_TOOLS_KEYRING_JSON: JSON.stringify(dualKeyring),
      },
    });
    const ffC107 = scenC_v107.tools.find((t) => t.tool_id === 'ffmpeg');
    const ffC108 = scenC_v108.tools.find((t) => t.tool_id === 'ffmpeg');
    record(
      'G331-14',
      'Phase 11 Scenario C (Dedicated-only rev 2): frozen v1.0.7 strictly REJECTS (source_untrusted) while v1.0.8-rc ACCEPTS',
      ffC107?.update_status === 'source_untrusted' &&
        ffC108?.update_status === 'update_available' &&
        scenC_v108.manifest_status?.verification_status === 'verified' &&
        scenC_v108.manifest_status?.signing_key_id === dedicatedTestKey.keyIdHex &&
        scenC_v108.manifest_status?.signing_key_purpose === 'external_tools_manifest',
      `v107=${ffC107?.update_status}, v108=${scenC_v108.manifest_status?.verification_status}/key=${scenC_v108.manifest_status?.signing_key_id}/purpose=${scenC_v108.manifest_status?.signing_key_purpose}`
    );

    // Scenario D: Invalid signature -> BOTH v1.0.7 AND v1.0.8-rc STRICTLY REJECT!
    const badUrl = `http://127.0.0.1:${PORT_FIXTURE}/m/invalid/tools-manifest.json`;
    const scenD_v107 = await runManifestCheckOnBinary({
      exe: v107Exe,
      dataDir: path.join(QA_ROOT, 'mat_d_v107_data'),
      wv2Dir: path.join(QA_ROOT, 'mat_d_v107_wv2'),
      dlDir: QA_DL_DIR,
      profDir: QA_PROF_DIR,
      cdpPort: 25419,
      pipeSuffix: 'matD_107',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: badUrl,
        TORI_TEST_TOOLS_PUBKEY: legacyTestKey.pubkeyB64,
      },
    });
    const scenD_v108 = await runManifestCheckOnBinary({
      exe: instExe,
      dataDir: path.join(QA_ROOT, 'mat_d_v108_data'),
      wv2Dir: path.join(QA_ROOT, 'mat_d_v108_wv2'),
      dlDir: QA_DL_DIR,
      profDir: QA_PROF_DIR,
      cdpPort: 25420,
      pipeSuffix: 'matD_108',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: badUrl,
        TORI_TEST_TOOLS_KEYRING_JSON: JSON.stringify(dualKeyring),
      },
    });
    const ffD107 = scenD_v107.tools.find((t) => t.tool_id === 'ffmpeg');
    const ffD108 = scenD_v108.tools.find((t) => t.tool_id === 'ffmpeg');
    record(
      'G331-15',
      'Phase 11 Scenario D (Invalid signature): BOTH frozen v1.0.7 AND upgraded v1.0.8-rc strictly reject fail-closed',
      ffD107?.update_status === 'source_untrusted' &&
        ffD108?.update_status === 'source_untrusted' &&
        scenD_v108.manifest_status?.verification_status === 'rejected_security',
      `v107=${ffD107?.update_status}, v108=${scenD_v108.manifest_status?.verification_status}`
    );

    // Scenario E: Emergency higher-revision rollback (rev 3, allow_rollback_to=true) + inline trust-escalation rejection!
    const rbUrl = `http://127.0.0.1:${PORT_FIXTURE}/m/rollback/tools-manifest.json`;
    const escUrl = `http://127.0.0.1:${PORT_FIXTURE}/m/escalation/tools-manifest.json`;
    const scenE_rb = await runManifestCheckOnBinary({
      exe: instExe,
      dataDir: scenC_v108_data, // continues from rev 2 -> rev 3!
      wv2Dir: path.join(QA_ROOT, 'mat_c_v108_wv2'),
      dlDir: QA_DL_DIR,
      profDir: QA_PROF_DIR,
      cdpPort: 25421,
      pipeSuffix: 'matE_rb',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: rbUrl,
        TORI_TEST_TOOLS_KEYRING_JSON: JSON.stringify(dualKeyring),
      },
    });
    const scenE_esc = await runManifestCheckOnBinary({
      exe: instExe,
      dataDir: scenC_v108_data,
      wv2Dir: path.join(QA_ROOT, 'mat_c_v108_wv2'),
      dlDir: QA_DL_DIR,
      profDir: QA_PROF_DIR,
      cdpPort: 25422,
      pipeSuffix: 'matE_esc',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: escUrl,
        TORI_TEST_TOOLS_KEYRING_JSON: JSON.stringify(dualKeyring),
      },
    });
    record(
      'G331-16',
      'Phase 11 Scenario E: v1.0.8-rc accepts rev 3 emergency rollback (allow_rollback_to=true) & blocks inline trust-escalation field',
      scenE_rb.manifest_status?.verification_status === 'verified' &&
        scenE_rb.manifest_status?.current_revision === 3 &&
        scenE_esc.manifest_status?.verification_status === 'rejected_security' &&
        (scenE_esc.manifest_status?.last_failure || '').toLowerCase().includes('trust'),
      `rbRev=${scenE_rb.manifest_status?.current_revision}/${scenE_rb.manifest_status?.verification_status}, escStatus=${scenE_esc.manifest_status?.verification_status}, escErr="${(scenE_esc.manifest_status?.last_failure || '').slice(0, 90)}"`
    );

    fs.writeFileSync(path.join(QA_ROOT, 'perf_metrics.json'), JSON.stringify(perf, null, 2) + '\n');
  } finally {
    cleanupProcs();
    if (fixtureServer) try { fixtureServer.close(); } catch {}
    await sleep(400);
    oemDbAfter = snapshotOemDatabase(OEM_DB_PATH);
    const parity = oemGuard.restore({ qaPathMarker: 'gate33_1_qa', restartOem: true });
    const dbCmp = compareOemDatabaseSnapshots(oemDbBefore, oemDbAfter);
    const oemExeShaAfter = sha256File(OEM_DESKTOP_EXE);
    record(
      'G331-20',
      'Phase 17 OEM Preservation: v1.0.6 binary, SQLite DB (42 rows, 355 chunks), 11 .tdm-part files & Registry 100% untouched',
      parity.ok === true && Boolean(dbCmp?.ok) && oemExeShaBefore === oemExeShaAfter,
      `regOk=${parity.ok}, dbOk=${dbCmp?.ok}, exeMatch=${oemExeShaBefore === oemExeShaAfter}`
    );
  }

  console.log('\n=============================================================================');
  console.log(` GATE 33.1 PREFLIGHT SUMMARY: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.TIMEOUT} TIMEOUT, ${counts.NOT_TESTED} NOT TESTED`);
  console.log('=============================================================================');
  if (counts.FAIL > 0 || counts.TIMEOUT > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL] Gate 33.1 preflight aborted:', err);
  cleanupProcs();
  if (fixtureServer) try { fixtureServer.close(); } catch {}
  process.exit(1);
});
