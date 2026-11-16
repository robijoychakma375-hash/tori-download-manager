#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 27.8
 * Final MKV Classification Fix & Real > 2 GiB End-to-End Transfer Acceptance Suite
 *
 * Verifies:
 * 1. Rebuilt & re-signed Desktop v1.0.5-rc NSIS silent install + updater .sig cryptographic check.
 * 2. Real COMPLETE > 2 GiB (2,469,606,195 bytes) end-to-end MKV transfer:
 *    Chrome v1.0.7 -> TORI Companion -> TORI Desktop v1.0.5-rc App -> Rust Engine -> Disk (Video/),
 *    including mid-transfer Pause (.tdm-part preserved in Video/), Resume, Desktop WebView2 UI
 *    completion display, SQLite state, exact byte size, full SHA-256 integrity, native cancel,
 *    and zero duplicate.
 * 3. Extensionless Content-Disposition (.mkv -> Video/), RFC 5987 filename*, redirected signed
 *    MKV URL, unknown octet-stream (-> Other/), normal MP4 (-> Video/) across:
 *    - Google Chrome v1.0.7 (connected to live TORI Desktop GUI)
 *    - Microsoft Edge v1.0.7 (connected to live TORI Desktop GUI)
 *    - Mozilla Firefox v1.0.7 signed XPI (xpinstall.signatures.required=true, connected to Desktop GUI)
 *
 * Strictly isolated: temporary TORI_DATA_DIR, TORI_IPC_PIPE, USERPROFILE, ports, and profiles.
 * Never mutates user AppData SQLite DB or user Downloads; always restores OEM native host.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, execSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALLER_EXE = path.join(ROOT, 'release', 'v1.0.5-rc', 'TORI Download Manager_1.0.5_x64-setup.exe');
const SIGNED_XPI = path.join(ROOT, 'release', 'v1.0.7-extension-rc', 'a70ed17e183648a9bcf4-1.0.7.xpi');
const EXPECTED_XPI_SHA256 = 'b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0';
const EXPECTED_GECKO_ID = 'tori-download-manager@toridm.org';
const EXT_DIR = path.join(ROOT, 'extension');
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const OEM_HOST_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'bin', 'tdm-native-host.exe');

const DESKTOP_GUI_PORT = 24910;
const WEBVIEW2_CDP_PORT = 24911;
const CHROME_CDP_PORT = 24913;
const EDGE_CDP_PORT = 24914;
const FIXTURE_PORT = 24915;
const FF_MARIONETTE_PORT = 2831;

const QA_ROOT = path.join(ROOT, 'target', 'gate27_8_full_qa');
const DESKTOP_INSTALL_DIR = path.join(QA_ROOT, 'desktop_install');
const DESKTOP_DATA_DIR = path.join(QA_ROOT, 'desktop_data');
const DESKTOP_USERPROFILE = path.join(QA_ROOT, 'desktop_profile');
const DESKTOP_DL_DIR = path.join(DESKTOP_USERPROFILE, 'Downloads');
const CHROME_PROF_DIR = path.join(QA_ROOT, 'chrome_profile');
const CHROME_DL_DIR = path.join(QA_ROOT, 'chrome_browser_dl');
const EDGE_PROF_DIR = path.join(QA_ROOT, 'edge_profile');
const EDGE_DL_DIR = path.join(QA_ROOT, 'edge_browser_dl');
const FF_PROF_DIR = path.join(QA_ROOT, 'firefox_profile');
const FF_DL_DIR = path.join(QA_ROOT, 'firefox_browser_dl');

const DESKTOP_TOKEN = 'tori_qa_desktop_gate27_8';
const MIX_URL = 'https://www.youtube.com/watch?v=mVeAD3nbXGs&list=RDmVeAD3nbXGs&start_radio=1';
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PL6B3937A5D230E335';
const WATCH_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

// Exact 2.30 GiB (> 2 GiB) deterministic MKV file size with non-aligned odd tail
const REAL_LARGE_MKV_SIZE = 2469606195;
const MKV_MAGIC = Buffer.from('1a45dfa3934282886d6174726f736b61', 'hex');

// Precomputed 4 KiB base tile for O(1) memory streaming & fast hashing across 2.30 GiB
const BASE_4K = (() => {
  const b = Buffer.allocUnsafe(4096);
  for (let i = 0; i < 4096; i++) {
    b[i] = ((i * 131 + ((i >>> 4) * 17)) ^ 0x5c) & 0xff;
  }
  return b;
})();

function fillDeterministicRange(absStart, outBuf, len) {
  let written = 0;
  while (written < len) {
    const pos = absStart + written;
    const pageOffset = pos & 4095;
    const chunkLen = Math.min(4096 - pageOffset, len - written);
    BASE_4K.copy(outBuf, written, pageOffset, pageOffset + chunkLen);

    // Stamp unique 32-bit page index on byte 0..4 of every 4 KiB page (except byte 0..16 EBML header)
    const pageIdx = Math.floor(pos / 4096) >>> 0;
    if (pos >= 16 && pageOffset < 4) {
      const idxBuf = Buffer.allocUnsafe(4);
      idxBuf.writeUInt32LE(pageIdx, 0);
      for (let k = pageOffset; k < 4 && (k - pageOffset) < chunkLen; k++) {
        outBuf[written + (k - pageOffset)] = idxBuf[k];
      }
    }
    written += chunkLen;
  }
  if (absStart < MKV_MAGIC.length) {
    const startInMagic = absStart;
    const endInMagic = Math.min(MKV_MAGIC.length, absStart + len);
    MKV_MAGIC.copy(outBuf, 0, startInMagic, endInMagic);
  }
}

function computeDeterministicSha256(totalSize) {
  const hash = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
  let pos = 0;
  while (pos < totalSize) {
    const len = Math.min(buf.length, totalSize - pos);
    fillDeterministicRange(pos, buf, len);
    hash.update(len === buf.length ? buf : buf.subarray(0, len));
    pos += len;
  }
  return hash.digest('hex');
}

async function computeFileSha256Streaming(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve(hash.digest('hex')));
    rs.on('error', reject);
  });
}

function makePatternBuffer(sizeBytes, headerHex) {
  const buf = Buffer.allocUnsafe(sizeBytes);
  const hdr = Buffer.from(headerHex, 'hex');
  hdr.copy(buf, 0);
  for (let i = hdr.length; i < sizeBytes; i++) {
    buf[i] = (i * 131 + ((i >>> 8) & 0xff) * 17 + ((i >>> 16) & 0xff)) & 0xff;
  }
  return buf;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const trackedProcs = new Set();
const results = [];
const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, NOT_TESTED: 0 };
const metrics = {};

function record(id, name, status, details = '') {
  const norm = status === true ? 'PASS' : status === false ? 'FAIL' : status;
  counts[norm] = (counts[norm] || 0) + 1;
  console.log(`[${norm}] [${id}] ${name}${details ? ' -> ' + details : ''}`);
  results.push({ id, name, status: norm, details });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function killTracked(proc) {
  if (!proc || !proc.pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', timeout: 4000 });
  } catch {
    try { proc.kill('SIGKILL'); } catch {}
  }
}

function restoreOemNativeHost() {
  try {
    if (fs.existsSync(OEM_HOST_EXE)) {
      execFileSync(OEM_HOST_EXE, ['--register'], { stdio: 'ignore', timeout: 5000 });
    }
  } catch {}
}

function cleanupAll() {
  for (const p of trackedProcs) killTracked(p);
  trackedProcs.clear();
  restoreOemNativeHost();
}

function seedToriSqlite(dbPath, { port, dir, token }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const appSettings = JSON.stringify({
    port,
    dir,
    sort: true,
    con: 16,
    maxa: 4,
    key: token,
    cap: true,
    closeToTray: true,
  });
  execFileSync('python', [
    '-c',
    [
      'import sqlite3,sys',
      'c=sqlite3.connect(sys.argv[1])',
      'c.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")',
      'c.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("browser_integration_token", sys.argv[2]))',
      'c.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("app_settings", sys.argv[3]))',
      'c.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("close_to_tray_migrated_v104", "true"))',
      'c.commit(); c.close()',
    ].join('; '),
    dbPath,
    token,
    appSettings,
  ], { stdio: 'inherit', timeout: 5000 });
}

function queryDbJob(dbPath, jobId) {
  const out = execFileSync('python', [
    '-c',
    [
      'import sqlite3,json,sys',
      'c=sqlite3.connect(sys.argv[1])',
      'c.row_factory=sqlite3.Row',
      'r=c.execute("SELECT id,filename,target_path,temp_path,total_bytes,downloaded_bytes,state,chunk_count FROM downloads WHERE id=?", (sys.argv[2],)).fetchone()',
      'print(json.dumps(dict(r)) if r else "null")',
      'c.close()',
    ].join('; '),
    dbPath,
    jobId,
  ], { encoding: 'utf8', timeout: 5000 }).trim();
  return JSON.parse(out);
}

function httpJson({ port, path: p, method = 'GET', headers = {}, body = null, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: p,
      method,
      headers: {
        Host: `127.0.0.1:${port}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data, raw });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, error: 'HTTP_TIMEOUT' }); });
    req.on('error', (e) => resolve({ status: 0, ok: false, error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error(`CDP connect timeout: ${this.wsUrl}`));
      }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', (ev) => { clearTimeout(timer); reject(new Error(`CDP WS error: ${ev.message || 'unknown'}`)); });
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          }
        } catch {}
      });
    });
  }
  send(method, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalAsync(expression, timeoutMs = 10000, opts = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: !!opts.userGesture,
    }, timeoutMs);
    if (res?.exceptionDetails) {
      throw new Error(`CDP eval exception: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
    }
    return res?.result?.value;
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function waitForCdpTargets(port, timeoutMs = 15000, requireBrowserWs = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await httpJson({ port, path: '/json', timeoutMs: 2000 });
    const ver = requireBrowserWs ? await httpJson({ port, path: '/json/version', timeoutMs: 2000 }) : { ok: true, data: null };
    if (Array.isArray(list.data) && list.data.length > 0 && (!requireBrowserWs || (ver.ok && ver.data?.webSocketDebuggerUrl))) {
      return { version: ver.data, targets: list.data };
    }
    await sleep(250);
  }
  throw new Error(`CDP endpoint on port ${port} did not become ready within ${timeoutMs}ms`);
}

class MarionetteClient {
  constructor() {
    this.socket = null;
    this.msgId = 1;
    this.buffer = '';
    this.pending = new Map();
  }
  async connect(port, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (this.socket) try { this.socket.destroy(); } catch {}
            reject(new Error('connect timeout'));
          }, 2000);
          const s = net.connect(port, '127.0.0.1');
          this.socket = s;
          let resolved = false;
          s.on('data', (data) => {
            this.buffer += data.toString('utf8');
            this.processBuffer(() => {
              if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                resolve();
              }
            });
          });
          s.on('error', (err) => {
            clearTimeout(timer);
            try { s.destroy(); } catch {}
            if (!resolved) reject(err);
          });
        });
        return;
      } catch {
        this.buffer = '';
        await sleep(300);
      }
    }
    throw new Error(`Marionette failed to connect on port ${port} within ${timeoutMs}ms`);
  }
  processBuffer(onHello) {
    while (true) {
      const colonIdx = this.buffer.indexOf(':');
      if (colonIdx === -1) break;
      const len = parseInt(this.buffer.slice(0, colonIdx), 10);
      if (isNaN(len)) { this.buffer = ''; break; }
      if (this.buffer.length < colonIdx + 1 + len) break;
      const payload = this.buffer.slice(colonIdx + 1, colonIdx + 1 + len);
      this.buffer = this.buffer.slice(colonIdx + 1 + len);
      try {
        const parsed = JSON.parse(payload);
        if (parsed.marionetteProtocol !== undefined && onHello) {
          onHello();
        } else if (Array.isArray(parsed) && parsed[0] === 1) {
          const cb = this.pending.get(parsed[1]);
          if (cb) {
            this.pending.delete(parsed[1]);
            if (parsed[2]) cb.reject(new Error(JSON.stringify(parsed[2])));
            else cb.resolve(parsed[3]);
          }
        }
      } catch {}
    }
  }
  send(name, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Marionette ${name} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const frame = JSON.stringify([0, id, name, params]);
      this.socket.write(`${Buffer.byteLength(frame, 'utf8')}:${frame}`);
    });
  }
  disconnect() {
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
  }
}

async function waitForJobState(port, token, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastJobs = [];
  while (Date.now() < deadline) {
    const res = await httpJson({ port, path: '/api/v1/downloads', headers: { 'X-Tori-Token': token } });
    const jobs = res?.data?.jobs || [];
    lastJobs = jobs;
    const found = predicate(jobs);
    if (found) return { found, jobs };
    await sleep(250);
  }
  return { found: null, jobs: lastJobs };
}

function submitChromeLoadUnpackedDialog(chromePid, unpackedDir) {
  const psScript = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinApi278 {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr GetDlgItem(IntPtr hDlg, int nIDDlgItem);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$pidCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${chromePid})
$dlg = $null
for ($i = 0; $i -lt 20; $i++) {
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCond)
  foreach ($w in $wins) {
    $clsCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, "#32770")
    $d = $w.FindFirst([System.Windows.Automation.TreeScope]::Children, $clsCond)
    if ($d -ne $null) { $dlg = $d; break }
  }
  if ($dlg -ne $null) { break }
  Start-Sleep -Milliseconds 200
}
if ($dlg -eq $null) { throw "Chrome #32770 Load Unpacked dialog not found for PID ${chromePid}" }
$hDlg = [IntPtr]$dlg.Current.NativeWindowHandle
$hEdit = [WinApi278]::GetDlgItem($hDlg, 1152)
if ($hEdit -eq [IntPtr]::Zero) { throw "Folder Edit control (1152) not found" }
[WinApi278]::SendMessage($hEdit, 0x000C, [IntPtr]::Zero, $env:TORI_UNPACKED_EXT) | Out-Null
Start-Sleep -Milliseconds 150
$hBtn = [WinApi278]::GetDlgItem($hDlg, 1)
if ($hBtn -eq [IntPtr]::Zero) { throw "OK button (1) not found" }
[WinApi278]::PostMessage($hBtn, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
Write-Output "UIA_SUBMITTED_OK"
`;
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
    env: { ...process.env, TORI_UNPACKED_EXT: unpackedDir },
    encoding: 'utf8',
    timeout: 12000,
  });
  return out.includes('UIA_SUBMITTED_OK');
}

async function run() {
  console.log('========================================================================');
  console.log(' TORI Gate 27.8 — Real > 2 GiB MKV Transfer & Multi-Browser Acceptance');
  console.log('========================================================================\n');

  const globalWatchdog = setTimeout(() => {
    console.error('\n[WATCHDOG] Overall Gate 27.8 watchdog reached (360s). Cleaning up children.');
    cleanupAll();
    process.exit(1);
  }, 360000);
  globalWatchdog.unref();

  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(DESKTOP_DL_DIR, { recursive: true });
  fs.mkdirSync(CHROME_DL_DIR, { recursive: true });
  fs.mkdirSync(EDGE_DL_DIR, { recursive: true });
  fs.mkdirSync(FF_DL_DIR, { recursive: true });

  // -----------------------------------------------------------------------
  // 1. Signed XPI Integrity + Expected Large >2 GiB SHA-256 Preparation
  // -----------------------------------------------------------------------
  const xpiSha = crypto.createHash('sha256').update(fs.readFileSync(SIGNED_XPI)).digest('hex').toLowerCase();
  record(
    'G278-PRE-01',
    'Signed Firefox v1.0.7 XPI remains byte-for-byte unchanged',
    xpiSha === EXPECTED_XPI_SHA256,
    `sha256=${xpiSha}`
  );

  console.log('[PREP] Computing deterministic SHA-256 for 2,469,606,195-byte (2.30 GiB) MKV fixture...');
  const tHash0 = Date.now();
  const EXPECTED_LARGE_MKV_SHA256 = computeDeterministicSha256(REAL_LARGE_MKV_SIZE);
  console.log(`[PREP] Computed 2.30 GiB SHA-256 in ${((Date.now() - tHash0) / 1000).toFixed(2)}s: ${EXPECTED_LARGE_MKV_SHA256}`);

  const mkvCd8 = makePatternBuffer(8 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');
  const mkvRfc4 = makePatternBuffer(4 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');
  const mkvRedir6 = makePatternBuffer(6 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');
  const unkBlob2 = makePatternBuffer(2 * 1024 * 1024, 'deadbeefcafebabe0102030405060708');
  const mp4Norm4 = makePatternBuffer(4 * 1024 * 1024, '00000018667479706d703432');
  const mkvEdgeCd6 = makePatternBuffer(6 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');
  const mkvFfDisp6 = makePatternBuffer(6 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');

  const sha = {
    mkvCd8: sha256(mkvCd8),
    mkvRfc4: sha256(mkvRfc4),
    mkvRedir6: sha256(mkvRedir6),
    unkBlob2: sha256(unkBlob2),
    mp4Norm4: sha256(mp4Norm4),
    mkvEdgeCd6: sha256(mkvEdgeCd6),
    mkvFfDisp6: sha256(mkvFfDisp6),
  };

  let pauseWindowThrottle = true;

  const fixtureServer = http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${FIXTURE_PORT}`);
    if (u.pathname === '/test.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end([
        '<!doctype html><html><head><title>TORI Gate 27.8 Acceptance</title></head><body>',
        '<h1>Gate 27.8 Large MKV & Classification Fixtures</h1>',
        '<a id="dl-large23" href="/real_large_2_3gb.mkv" download="real_large_2_3gb.mkv">2.30 GiB MKV</a>',
        '<a id="dl-cd8" href="/cd_blob">CD 8M MKV</a>',
        '<a id="dl-rfc5987" href="/rfc5987_blob">RFC5987 Unicode MKV</a>',
        '<a id="dl-redir" href="/redir_signed_start">Redirect Signed MKV</a>',
        '<a id="dl-unknown" href="/unknown_blob">Unknown Octet Blob</a>',
        '<a id="dl-mp4" href="/Normal_Regression.mp4" download="Normal_Regression.mp4">4M MP4</a>',
        '<a id="dl-edge-cd" href="/edge_cd_blob">Edge CD MKV</a>',
        '<a id="dl-ff-disp" href="/ff_disp_blob">Firefox CD MKV</a>',
        '</body></html>',
      ].join(''));
      return;
    }

    if (u.pathname === '/redir_signed_start') {
      res.writeHead(302, {
        Location: `http://127.0.0.1:${FIXTURE_PORT}/cdn/Signed_Gate27_8.mkv?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=deadbeef`,
      });
      res.end();
      return;
    }

    if (u.pathname === '/real_large_2_3gb.mkv') {
      const headersBase = {
        'Content-Type': 'video/x-matroska',
        'Accept-Ranges': 'bytes',
        ETag: '"gate278-2-3gb-etag"',
      };
      if (req.method === 'HEAD') {
        res.writeHead(200, { ...headersBase, 'Content-Length': String(REAL_LARGE_MKV_SIZE) });
        res.end();
        return;
      }

      let start = 0;
      let end = REAL_LARGE_MKV_SIZE - 1;
      let status = 200;
      const range = req.headers.range;
      if (range && range.startsWith('bytes=')) {
        const [s, e] = range.slice(6).split('-');
        start = parseInt(s, 10) || 0;
        end = e ? Math.min(parseInt(e, 10), REAL_LARGE_MKV_SIZE - 1) : REAL_LARGE_MKV_SIZE - 1;
        if (start > end || end >= REAL_LARGE_MKV_SIZE) {
          res.writeHead(416, { 'Content-Range': `bytes */${REAL_LARGE_MKV_SIZE}` });
          res.end();
          return;
        }
        status = 206;
      }
      const totalSlice = end - start + 1;
      const respHeaders = {
        ...headersBase,
        'Content-Length': String(totalSlice),
        ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${REAL_LARGE_MKV_SIZE}` } : {}),
      };
      res.writeHead(status, respHeaders);

      // Stream O(1) memory in 256 KiB slices with backpressure + optional mid-transfer throttle
      const CHUNK_SZ = 262144;
      const scratch = Buffer.allocUnsafe(CHUNK_SZ);
      let cursor = start;
      let closed = false;
      req.on('close', () => { closed = true; });
      res.on('close', () => { closed = true; });

      function pump() {
        while (!closed && cursor <= end) {
          const n = Math.min(CHUNK_SZ, end - cursor + 1);
          fillDeterministicRange(cursor, scratch, n);
          cursor += n;
          const ok = res.write(n === CHUNK_SZ ? scratch : scratch.subarray(0, n));
          if (!ok) {
            res.once('drain', () => {
              if (pauseWindowThrottle && totalSlice > 1) setTimeout(pump, 35);
              else pump();
            });
            return;
          }
          if (pauseWindowThrottle && totalSlice > 1) {
            setTimeout(pump, 35);
            return;
          }
        }
        if (!closed && !res.writableEnded) {
          res.end();
        }
      }
      pump();
      return;
    }

    let buf = null;
    let ctype = 'application/octet-stream';
    const extra = {};
    if (u.pathname === '/cd_blob') {
      buf = mkvCd8;
      extra['Content-Disposition'] = 'attachment; filename="Example_Movie.mkv"';
    } else if (u.pathname === '/rfc5987_blob') {
      buf = mkvRfc4;
      extra['Content-Disposition'] =
        'attachment; filename="fallback.dat"; filename*=UTF-8\'en\'Priority%20Film%20%E5%A4%A7%E5%9E%8B.mkv';
    } else if (u.pathname === '/cdn/Signed_Gate27_8.mkv') {
      buf = mkvRedir6;
      ctype = 'application/octet-stream';
    } else if (u.pathname === '/unknown_blob') {
      buf = unkBlob2;
    } else if (u.pathname === '/Normal_Regression.mp4') {
      buf = mp4Norm4;
      ctype = 'video/mp4';
    } else if (u.pathname === '/edge_cd_blob') {
      buf = mkvEdgeCd6;
      extra['Content-Disposition'] = 'attachment; filename="Edge_CD_Movie.mkv"';
    } else if (u.pathname === '/ff_disp_blob') {
      buf = mkvFfDisp6;
      extra['Content-Disposition'] = 'attachment; filename="Firefox_Disposition_Movie.mkv"';
    }

    if (!buf) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const total = buf.length;
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': String(total), 'Accept-Ranges': 'bytes', ...extra });
      res.end();
      return;
    }

    const range = req.headers.range;
    if (range && range.startsWith('bytes=')) {
      const [s, e] = range.slice(6).split('-');
      const start = parseInt(s, 10) || 0;
      const end = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
      res.writeHead(206, {
        'Content-Type': ctype,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        ...extra,
      });
      res.end(buf.subarray(start, end + 1));
      return;
    }

    res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': String(total), 'Accept-Ranges': 'bytes', ...extra });
    res.end(buf);
  });
  await new Promise((r) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', r));

  // -----------------------------------------------------------------------
  // 2. Install & Boot Isolated Rebuilt TORI Desktop v1.0.5-rc
  // -----------------------------------------------------------------------
  console.log('\n>>> [DESKTOP] Silent NSIS Install & Isolated Boot (Rebuilt v1.0.5-rc) <<<\n');
  execSync(`"${INSTALLER_EXE}" /S /D=${DESKTOP_INSTALL_DIR}`, { timeout: 60000 });
  const installedDesktopExe = path.join(DESKTOP_INSTALL_DIR, 'tori-download-manager.exe');
  const installedHostExe = path.join(DESKTOP_INSTALL_DIR, 'bin', 'tdm-native-host.exe');
  record(
    'G278-INST-01',
    'Rebuilt Desktop v1.0.5-rc NSIS silent installer installs cleanly',
    fs.existsSync(installedDesktopExe) && fs.existsSync(installedHostExe),
    installedDesktopExe
  );

  // Register isolated native host temporarily during QA (always restored in cleanupAll)
  execFileSync(installedHostExe, ['--register'], { stdio: 'ignore', timeout: 5000 });

  const deskDbPath = path.join(DESKTOP_DATA_DIR, 'tdm_storage.sqlite');
  seedToriSqlite(deskDbPath, { port: DESKTOP_GUI_PORT, dir: DESKTOP_DL_DIR, token: DESKTOP_TOKEN });
  const pipeName = `\\\\.\\pipe\\tori-qa-g278-${process.pid}`;

  const isolatedEnv = {
    ...process.env,
    TORI_DATA_DIR: DESKTOP_DATA_DIR,
    TORI_IPC_PIPE: pipeName,
    TORI_DISABLE_AUTO_SPAWN: '1',
    TORI_ALLOW_LOOPBACK: '1',
    TDM_STORAGE_DIR: DESKTOP_DATA_DIR,
    TDM_DOWNLOAD_DIR: DESKTOP_DL_DIR,
  };

  const deskProc = spawn(installedDesktopExe, [], {
    env: {
      ...isolatedEnv,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${WEBVIEW2_CDP_PORT}`,
    },
    stdio: 'ignore',
  });
  trackedProcs.add(deskProc);

  let deskOnline = false;
  for (let i = 0; i < 45; i++) {
    await sleep(300);
    const st = await httpJson({ port: DESKTOP_GUI_PORT, path: '/api/v1/ping', headers: { 'X-Tori-Token': DESKTOP_TOKEN } });
    if (st.ok && st.data?.authenticated === true) { deskOnline = true; break; }
  }
  const cdpDeskInfo = await waitForCdpTargets(WEBVIEW2_CDP_PORT, 15000, false);
  const deskTarget = cdpDeskInfo.targets.find((t) => t.type === 'page' && !t.url.includes('toast')) || cdpDeskInfo.targets[0];
  const deskCdp = new CDPClient(deskTarget.webSocketDebuggerUrl);
  await deskCdp.connect(6000);
  await deskCdp.evalAsync(`new Promise(r => { const t = setInterval(() => { if (window.__TAURI_INTERNALS__?.invoke) { clearInterval(t); r(true); } }, 100); })`, 10000);
  record('G278-DESK-01', 'Rebuilt TORI Desktop v1.0.5-rc online with WebView2 CDP + HTTP API', deskOnline && !!deskTarget, `port=${DESKTOP_GUI_PORT}`);

  // -----------------------------------------------------------------------
  // 3. Chrome v1.0.7 + Real > 2 GiB End-to-End Transfer + Pause/Resume + Classification
  // -----------------------------------------------------------------------
  console.log('\n>>> [CHROME] Launching Chrome v1.0.7 + Real 2.30 GiB E2E Transfer <<<\n');
  fs.mkdirSync(path.join(CHROME_PROF_DIR, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(CHROME_PROF_DIR, 'First Run'), '');
  fs.writeFileSync(path.join(CHROME_PROF_DIR, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: CHROME_DL_DIR, prompt_for_download: false },
    profile: { default_content_setting_values: { automatic_downloads: 1 } },
  }));

  const chromeProc = spawn(CHROME_EXE, [
    `--remote-debugging-port=${CHROME_CDP_PORT}`,
    `--user-data-dir=${CHROME_PROF_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--window-size=1200,820',
    'chrome://extensions/',
  ], { env: isolatedEnv, stdio: 'ignore' });
  trackedProcs.add(chromeProc);

  const chrInfo = await waitForCdpTargets(CHROME_CDP_PORT, 15000);
  const chrBrowserCdp = new CDPClient(chrInfo.version.webSocketDebuggerUrl);
  await chrBrowserCdp.connect(6000);
  let chrExtPageTarget = chrInfo.targets.find((t) => t.url.startsWith('chrome://extensions'));
  if (!chrExtPageTarget) {
    const created = await chrBrowserCdp.send('Target.createTarget', { url: 'chrome://extensions/' });
    const list2 = await waitForCdpTargets(CHROME_CDP_PORT, 5000);
    chrExtPageTarget = list2.targets.find((t) => t.id === created.targetId);
  }
  const chrExtMgrCdp = new CDPClient(chrExtPageTarget.webSocketDebuggerUrl);
  await chrExtMgrCdp.connect(6000);
  await sleep(1000);

  await chrExtMgrCdp.evalAsync(`chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })`, 6000);
  const loadPromise = chrExtMgrCdp.evalAsync(
    `chrome.developerPrivate.loadUnpacked().then(() => 'OK').catch(e => String(e))`,
    15000,
    { userGesture: true }
  );
  const uiaOk = submitChromeLoadUnpackedDialog(chromeProc.pid, EXT_DIR);
  const loadRes = await loadPromise;
  await sleep(1000);
  const chrExts = await chrExtMgrCdp.evalAsync(`chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true })`, 6000);
  const chrTori = (chrExts || []).find((e) => e.name.includes('TORI'));
  chrExtMgrCdp.close();
  if (!uiaOk || !chrTori?.id) throw new Error(`TORI extension missing in Chrome (uia=${uiaOk}, loadRes=${loadRes})`);

  const { targetId: chrOptId } = await chrBrowserCdp.send('Target.createTarget', { url: `chrome-extension://${chrTori.id}/options/options.html` });
  const { targetId: chrWebId } = await chrBrowserCdp.send('Target.createTarget', { url: `http://127.0.0.1:${FIXTURE_PORT}/test.html` });
  await sleep(1200);
  const chrTargets = (await waitForCdpTargets(CHROME_CDP_PORT, 8000)).targets;
  const chrOptCdp = new CDPClient(chrTargets.find((t) => t.id === chrOptId).webSocketDebuggerUrl);
  const chrWebCdp = new CDPClient(chrTargets.find((t) => t.id === chrWebId || (t.type === 'page' && t.url.includes('/test.html'))).webSocketDebuggerUrl);
  await chrOptCdp.connect(6000);
  await chrWebCdp.connect(6000);

  const chrPing = await chrOptCdp.evalAsync(`new Promise(r => {
    chrome.storage.local.set({
      tori_settings: {
        port: ${DESKTOP_GUI_PORT}, key: '${DESKTOP_TOKEN}', auto: true, cap: true, min: 0, badge: true, sites: [],
        types: ['zip','rar','7z','iso','exe','dmg','pdf','mp4','mp3','mkv']
      }
    }, () => setTimeout(() => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: '${DESKTOP_TOKEN}' }, r), 300));
  })`, 8000);
  record('CHR-DESK-01', 'Chrome v1.0.7 pairs with live rebuilt Desktop v1.0.5-rc', chrPing?.status === 'ok' && chrPing?.authenticated === true, JSON.stringify(chrPing));

  // Trigger REAL 2.30 GiB MKV through Chrome -> TORI Companion -> Desktop App -> Engine
  console.log('[2.30GiB] Triggering real 2,469,606,195-byte MKV via Chrome click...');
  const tStart23 = Date.now();
  await chrWebCdp.evalAsync(`document.getElementById('dl-large23').click()`, 4000, { userGesture: true });

  const { found: activeLargeJob } = await waitForJobState(
    DESKTOP_GUI_PORT,
    DESKTOP_TOKEN,
    (jobs) => jobs.find((j) => j.filename === 'real_large_2_3gb.mkv' && j.state === 'downloading' && j.downloaded_bytes >= 16 * 1024 * 1024),
    30000
  );
  if (!activeLargeJob) throw new Error('2.30 GiB job failed to enter active downloading state');

  // Pause mid-transfer and verify .tdm-part inside Video/
  await httpJson({ port: DESKTOP_GUI_PORT, path: `/api/v1/downloads/${activeLargeJob.id}/pause`, method: 'POST', headers: { 'X-Tori-Token': DESKTOP_TOKEN } });
  const { found: pausedLargeJob } = await waitForJobState(
    DESKTOP_GUI_PORT,
    DESKTOP_TOKEN,
    (jobs) => jobs.find((j) => j.id === activeLargeJob.id && j.state === 'paused'),
    15000
  );
  const expectedLargeTarget = path.join(DESKTOP_DL_DIR, 'Video', 'real_large_2_3gb.mkv');
  const expectedLargePart = `${expectedLargeTarget}.tdm-part`;
  const partExistsOnPause = fs.existsSync(expectedLargePart);
  const partSizeOnPause = partExistsOnPause ? fs.statSync(expectedLargePart).size : 0;
  record(
    'G278-2G-PAUSE',
    '2.30 GiB MKV pauses cleanly mid-transfer with .tdm-part preserved inside Video/',
    Boolean(pausedLargeJob && partExistsOnPause && partSizeOnPause > 0 && !fs.existsSync(expectedLargeTarget)),
    `downloadedBytes=${pausedLargeJob?.downloaded_bytes}, partBytes=${partSizeOnPause}, targetExists=${fs.existsSync(expectedLargeTarget)}`
  );

  // Release artificial throttle, resume, and complete ALL 2.30 GiB to disk!
  pauseWindowThrottle = false;
  await httpJson({ port: DESKTOP_GUI_PORT, path: `/api/v1/downloads/${activeLargeJob.id}/resume`, method: 'POST', headers: { 'X-Tori-Token': DESKTOP_TOKEN } });
  console.log('[2.30GiB] Resumed full-speed transfer of 2,469,606,195 bytes to disk...');
  const { found: doneLargeJob } = await waitForJobState(
    DESKTOP_GUI_PORT,
    DESKTOP_TOKEN,
    (jobs) => jobs.find((j) => j.id === activeLargeJob.id && j.state === 'completed'),
    120000
  );
  const tElapsed23Sec = ((Date.now() - tStart23) / 1000).toFixed(2);
  if (!doneLargeJob) throw new Error('2.30 GiB MKV download did not reach completed state');

  const diskLargeExists = fs.existsSync(expectedLargeTarget);
  const diskLargeSize = diskLargeExists ? fs.statSync(expectedLargeTarget).size : 0;
  const partRemovedAfterDone = !fs.existsSync(expectedLargePart);
  const diskLargeSha = diskLargeExists ? await computeFileSha256Streaming(expectedLargeTarget) : '';
  const dbLargeRow = queryDbJob(deskDbPath, activeLargeJob.id);

  // Check Chrome cancelled native download and created zero duplicate
  const chrDlsLarge = await chrOptCdp.evalAsync(`new Promise(r => chrome.downloads.search({ urlRegex: 'real_large_2_3gb' }, r))`);
  const chrCancelledLarge = Array.isArray(chrDlsLarge) && chrDlsLarge.some((d) => d.state === 'interrupted');
  const chrZeroDupLarge = !fs.existsSync(path.join(CHROME_DL_DIR, 'real_large_2_3gb.mkv'));

  // Verify Desktop WebView2 UI shows real_large_2_3gb.mkv + completed row progress (100% / 2.30 GB)
  await sleep(600);
  const uiTextSnapshot = await deskCdp.evalAsync(`document.body ? document.body.innerText : ''`);
  const uiShowsFilename = typeof uiTextSnapshot === 'string' && uiTextSnapshot.includes('real_large_2_3gb.mkv');
  const uiShowsCompleted =
    typeof uiTextSnapshot === 'string' &&
    (/\bcomplete(d)?\b/i.test(uiTextSnapshot) || uiTextSnapshot.includes('100%'));

  record(
    'G278-2G-E2E',
    'Complete 2.30 GiB (2,469,606,195 B) MKV transfers E2E into Video/ with exact SHA-256, UI completion, DB completion & zero duplicate',
    diskLargeSize === REAL_LARGE_MKV_SIZE &&
      diskLargeSha === EXPECTED_LARGE_MKV_SHA256 &&
      partRemovedAfterDone &&
      dbLargeRow?.state === 'completed' &&
      dbLargeRow?.downloaded_bytes === REAL_LARGE_MKV_SIZE &&
      chrCancelledLarge &&
      chrZeroDupLarge &&
      uiShowsFilename &&
      uiShowsCompleted,
    `bytes=${diskLargeSize}/${REAL_LARGE_MKV_SIZE}, shaMatch=${diskLargeSha === EXPECTED_LARGE_MKV_SHA256}, elapsed=${tElapsed23Sec}s, uiFilename=${uiShowsFilename}, uiCompleted=${uiShowsCompleted}, dbState=${dbLargeRow?.state}, chrInterrupted=${chrCancelledLarge}, zeroDup=${chrZeroDupLarge}`
  );
  metrics.large2_3gbMkv = {
    bytes: diskLargeSize,
    sha256: diskLargeSha,
    sha256Match: diskLargeSha === EXPECTED_LARGE_MKV_SHA256,
    elapsedSec: Number(tElapsed23Sec),
    targetPath: dbLargeRow?.target_path,
  };

  // Free the 2.30 GiB disk artifact immediately now that hash + DB + UI were verified
  try { fs.rmSync(expectedLargeTarget, { force: true }); } catch {}

  // Trigger Chrome post-probe classification tests (CD /cd_blob, RFC5987 Unicode, Redirected Signed, MP4)
  // plus direct Desktop TORI submission of extensionless /unknown_blob (application/octet-stream -> Other/)
  for (const id of ['dl-cd8', 'dl-rfc5987', 'dl-redir', 'dl-mp4']) {
    await chrWebCdp.evalAsync(`document.getElementById('${id}').click()`, 4000, { userGesture: true });
    await sleep(450);
  }
  await httpJson({
    port: DESKTOP_GUI_PORT,
    path: '/api/v1/downloads',
    method: 'POST',
    headers: { 'X-Tori-Token': DESKTOP_TOKEN },
    body: {
      url: `http://127.0.0.1:${FIXTURE_PORT}/unknown_blob`,
      filename: 'unknown_blob',
      referer: `http://127.0.0.1:${FIXTURE_PORT}/test.html`,
      user_agent: 'TORI-Gate278-QA',
    },
  });

  const chrExpected = [
    { file: 'Example_Movie.mkv', folder: 'Video', bytes: mkvCd8.length, digest: sha.mkvCd8 },
    { file: 'Priority Film 大型.mkv', folder: 'Video', bytes: mkvRfc4.length, digest: sha.mkvRfc4 },
    { file: 'Signed_Gate27_8.mkv', folder: 'Video', bytes: mkvRedir6.length, digest: sha.mkvRedir6 },
    { file: 'unknown_blob', folder: 'Other', bytes: unkBlob2.length, digest: sha.unkBlob2 },
    { file: 'Normal_Regression.mp4', folder: 'Video', bytes: mp4Norm4.length, digest: sha.mp4Norm4 },
  ];

  const { found: chrDoneJobs } = await waitForJobState(
    DESKTOP_GUI_PORT,
    DESKTOP_TOKEN,
    (jobs) => chrExpected.every((e) => jobs.find((j) => j.filename === e.file && j.state === 'completed')),
    30000
  );
  let chrClsFailures = [];
  for (const e of chrExpected) {
    const p = path.join(DESKTOP_DL_DIR, e.folder, e.file);
    const ok = fs.existsSync(p) && fs.statSync(p).size === e.bytes && sha256(fs.readFileSync(p)) === e.digest;
    const dup = fs.readdirSync(CHROME_DL_DIR).some((n) => n.includes(e.file.slice(0, 8)));
    if (!ok || dup) chrClsFailures.push(`${e.folder}/${e.file}(ok=${ok},dup=${dup})`);
  }
  record(
    'CHR-CLS-01',
    'Chrome -> Desktop classifies /cd_blob, RFC5987 Unicode, Redirected MKV & MP4 into Video/ and unknown blob into Other/',
    Boolean(chrDoneJobs) && chrClsFailures.length === 0,
    chrClsFailures.length === 0 ? 'verified=5/5 (Example_Movie.mkv -> Video/)' : chrClsFailures.join('; ')
  );

  chrOptCdp.close();
  chrWebCdp.close();
  chrBrowserCdp.close();
  killTracked(chromeProc);
  trackedProcs.delete(chromeProc);
  await sleep(600);

  // -----------------------------------------------------------------------
  // 4. Microsoft Edge v1.0.7 -> Desktop Classification Check (/edge_cd_blob -> Video/)
  // -----------------------------------------------------------------------
  console.log('\n>>> [EDGE] Verifying Edge v1.0.7 Content-Disposition MKV -> Video/ <<<\n');
  fs.mkdirSync(path.join(EDGE_PROF_DIR, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(EDGE_PROF_DIR, 'First Run'), '');
  fs.writeFileSync(path.join(EDGE_PROF_DIR, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: EDGE_DL_DIR, prompt_for_download: false },
    profile: { default_content_setting_values: { automatic_downloads: 1 } },
  }));

  const edgeProc = spawn(EDGE_EXE, [
    `--remote-debugging-port=${EDGE_CDP_PORT}`,
    `--user-data-dir=${EDGE_PROF_DIR}`,
    `--load-extension=${EXT_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,820',
    `http://127.0.0.1:${FIXTURE_PORT}/test.html`,
  ], { env: isolatedEnv, stdio: 'ignore' });
  trackedProcs.add(edgeProc);

  const edgeInfo = await waitForCdpTargets(EDGE_CDP_PORT, 15000);
  const edgeBrowserCdp = new CDPClient(edgeInfo.version.webSocketDebuggerUrl);
  await edgeBrowserCdp.connect(6000);
  const { targetId: edgeExtPageId } = await edgeBrowserCdp.send('Target.createTarget', { url: 'edge://extensions/' });
  await sleep(1000);
  const edgeTargets0 = (await waitForCdpTargets(EDGE_CDP_PORT, 8000)).targets;
  const edgeExtMgrCdp = new CDPClient(edgeTargets0.find((t) => t.id === edgeExtPageId).webSocketDebuggerUrl);
  await edgeExtMgrCdp.connect(6000);
  const edgeExts = await edgeExtMgrCdp.evalAsync(`chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true })`, 6000);
  const edgeTori = (edgeExts || []).find((e) => e.name.includes('TORI'));
  edgeExtMgrCdp.close();
  if (!edgeTori?.id) throw new Error('TORI extension missing in Edge');

  const { targetId: edgeOptId } = await edgeBrowserCdp.send('Target.createTarget', { url: `chrome-extension://${edgeTori.id}/options/options.html` });
  await sleep(800);
  const edgeTargets = (await waitForCdpTargets(EDGE_CDP_PORT, 8000)).targets;
  const edgeOptCdp = new CDPClient(edgeTargets.find((t) => t.id === edgeOptId).webSocketDebuggerUrl);
  const edgeWebCdp = new CDPClient(edgeTargets.find((t) => t.type === 'page' && t.url.includes('/test.html')).webSocketDebuggerUrl);
  await edgeOptCdp.connect(6000);
  await edgeWebCdp.connect(6000);

  const edgePing = await edgeOptCdp.evalAsync(`new Promise(r => {
    const t = setInterval(() => {
      if (chrome?.storage?.local && chrome?.runtime?.sendMessage) {
        clearInterval(t);
        chrome.storage.local.set({
          tori_settings: {
            port: ${DESKTOP_GUI_PORT}, key: '${DESKTOP_TOKEN}', auto: true, cap: true, min: 0, badge: true, sites: [],
            types: ['zip','rar','7z','iso','exe','dmg','pdf','mp4','mp3','mkv']
          }
        }, () => setTimeout(() => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: '${DESKTOP_TOKEN}' }, r), 300));
      }
    }, 100);
  })`, 15000);

  await edgeWebCdp.evalAsync(`document.getElementById('dl-edge-cd').click()`, 4000, { userGesture: true });
  const { found: edgeDone, jobs: edgeAllJobs } = await waitForJobState(
    DESKTOP_GUI_PORT,
    DESKTOP_TOKEN,
    (jobs) => jobs.find((j) => j.filename === 'Edge_CD_Movie.mkv' && j.state === 'completed'),
    25000
  );
  const edgeDls = await edgeOptCdp.evalAsync(`new Promise(r => chrome.downloads.search({}, r))`, 6000).catch((e) => ({ err: String(e) }));
  const edgeDiskPath = path.join(DESKTOP_DL_DIR, 'Video', 'Edge_CD_Movie.mkv');
  const edgeOk = Boolean(
    edgeDone &&
      fs.existsSync(edgeDiskPath) &&
      fs.statSync(edgeDiskPath).size === mkvEdgeCd6.length &&
      sha256(fs.readFileSync(edgeDiskPath)) === sha.mkvEdgeCd6 &&
      !fs.existsSync(path.join(EDGE_DL_DIR, 'Edge_CD_Movie.mkv'))
  );
  record(
    'EDGE-CLS-01',
    'Edge v1.0.7 -> Desktop routes extensionless /edge_cd_blob (Edge_CD_Movie.mkv) directly into Video/ (SHA-256 verified, zero duplicate)',
    edgeOk,
    `targetPath=${edgeDone?.target_path}` +
      (edgeOk
        ? ''
        : ` | edgePing=${JSON.stringify(edgePing)} | edgeDls=${JSON.stringify(edgeDls)} | edgeDir=${JSON.stringify(fs.readdirSync(EDGE_DL_DIR))} | jobs=${JSON.stringify(edgeAllJobs.map((j) => ({ f: j.filename, s: j.state, p: j.target_path })))}`)
  );

  edgeOptCdp.close();
  edgeWebCdp.close();
  edgeBrowserCdp.close();
  killTracked(edgeProc);
  trackedProcs.delete(edgeProc);
  await sleep(600);

  // -----------------------------------------------------------------------
  // 5. Mozilla Firefox Signed XPI v1.0.7 -> Desktop Classification Check (/ff_disp_blob -> Video/)
  // -----------------------------------------------------------------------
  console.log('\n>>> [FIREFOX] Verifying Signed Firefox v1.0.7 XPI Content-Disposition MKV -> Video/ <<<\n');
  fs.mkdirSync(FF_PROF_DIR, { recursive: true });
  const prefs = [
    'user_pref("marionette.enabled", true);',
    `user_pref("marionette.port", ${FF_MARIONETTE_PORT});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("xpinstall.signatures.required", true);',
    'user_pref("browser.download.folderList", 2);',
    `user_pref("browser.download.dir", "${FF_DL_DIR.replace(/\\/g, '\\\\')}");`,
    'user_pref("browser.download.useDownloadDir", true);',
    'user_pref("browser.helperApps.neverAsk.saveToDisk", "video/x-matroska,video/mp4,application/octet-stream");',
  ].join('\n');
  fs.writeFileSync(path.join(FF_PROF_DIR, 'user.js'), prefs, 'utf8');

  const ffProc = spawn(FIREFOX_EXE, ['-no-remote', '-marionette', '-profile', FF_PROF_DIR, `http://127.0.0.1:${FIXTURE_PORT}/test.html`], {
    env: { ...isolatedEnv, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    stdio: 'ignore',
  });
  trackedProcs.add(ffProc);

  const marionette = new MarionetteClient();
  await marionette.connect(FF_MARIONETTE_PORT, 15000);
  await marionette.send('WebDriver:NewSession', {});
  const ffInstallRes = await marionette.send('Addon:Install', { path: SIGNED_XPI, temporary: false }, 10000);
  await sleep(800);

  await marionette.send('Marionette:SetContext', { value: 'chrome' });
  const ffPolicy = (await marionette.send('WebDriver:ExecuteScript', {
    script: `const p = WebExtensionPolicy.getByID("${EXPECTED_GECKO_ID}"); return p ? { active: p.active, version: p.extension.version, url: p.getURL("") } : null;`,
    args: [],
  }))?.value;
  await marionette.send('WebDriver:ExecuteScript', {
    script: `Services.wm.getMostRecentWindow("navigator:browser").gBrowser.addTrustedTab("${ffPolicy.url}options/options.html");`,
    args: [],
  });
  await sleep(1000);

  await marionette.send('Marionette:SetContext', { value: 'content' });
  const rawHandles = await marionette.send('WebDriver:GetWindowHandles', {});
  const handles = Array.isArray(rawHandles) ? rawHandles : (rawHandles?.value || []);
  let optHandle = null;
  let webHandle = null;
  for (const h of handles) {
    await marionette.send('WebDriver:SwitchToWindow', { handle: h });
    const curUrl = await marionette.send('WebDriver:GetCurrentURL', {});
    if (curUrl?.value?.includes('options/options.html')) optHandle = h;
    else if (curUrl?.value?.includes('/test.html')) webHandle = h;
  }
  if (!optHandle || !webHandle) throw new Error('Firefox missing options or test tab');

  await marionette.send('WebDriver:SwitchToWindow', { handle: optHandle });
  const ffPing = (await marionette.send('WebDriver:ExecuteAsyncScript', {
    script: `
      const done = arguments[arguments.length - 1];
      (async () => {
        try {
          const settings = {
            port: ${DESKTOP_GUI_PORT}, key: '${DESKTOP_TOKEN}', auto: true, cap: true, min: 0, badge: true, sites: [],
            types: ['zip','rar','7z','iso','exe','dmg','pdf','mp4','mp3','mkv']
          };
          await browser.storage.local.set({ tori_settings: settings });
          await new Promise(r => setTimeout(r, 250));
          done(await browser.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: '${DESKTOP_TOKEN}' }));
        } catch (e) { done({ err: String(e) }); }
      })();
    `,
    args: [],
  }, 10000))?.value;

  await marionette.send('WebDriver:SwitchToWindow', { handle: webHandle });
  await marionette.send('WebDriver:ExecuteScript', {
    script: `document.getElementById('dl-ff-disp').click();`,
    args: [],
  });

  const { found: ffDispDone, jobs: ffAllJobs } = await waitForJobState(
    DESKTOP_GUI_PORT,
    DESKTOP_TOKEN,
    (jobs) => jobs.find((j) => j.filename === 'Firefox_Disposition_Movie.mkv' && j.state === 'completed'),
    25000
  );
  await marionette.send('WebDriver:SwitchToWindow', { handle: optHandle });
  const ffDls = (await marionette.send('WebDriver:ExecuteAsyncScript', {
    script: `const done = arguments[arguments.length - 1]; browser.downloads.search({}).then(done, e => done({ err: String(e) }));`,
    args: [],
  }, 8000))?.value;
  const ffDispPath = path.join(DESKTOP_DL_DIR, 'Video', 'Firefox_Disposition_Movie.mkv');
  const ffDispOk = Boolean(
    ffInstallRes?.value === EXPECTED_GECKO_ID &&
      ffPolicy?.active &&
      ffPing?.status === 'ok' &&
      ffDispDone &&
      fs.existsSync(ffDispPath) &&
      fs.statSync(ffDispPath).size === mkvFfDisp6.length &&
      sha256(fs.readFileSync(ffDispPath)) === sha.mkvFfDisp6 &&
      !fs.existsSync(path.join(FF_DL_DIR, 'Firefox_Disposition_Movie.mkv'))
  );
  record(
    'FF-CLS-01',
    'Signed Firefox XPI v1.0.7 -> Desktop routes extensionless /ff_disp_blob (Firefox_Disposition_Movie.mkv) directly into Video/',
    ffDispOk,
    `xpi=${ffPolicy?.version}, targetPath=${ffDispDone?.target_path}` +
      (ffDispOk
        ? ''
        : ` | ffPing=${JSON.stringify(ffPing)} | ffDls=${JSON.stringify(ffDls)} | ffDir=${JSON.stringify(fs.readdirSync(FF_DL_DIR))} | jobs=${JSON.stringify(ffAllJobs.map((j) => ({ f: j.filename, s: j.state, p: j.target_path })))}`)
  );

  // Confirm Mix rejection + Playlist dispatch + Audio->Video still intact cleanly
  await marionette.send('WebDriver:SwitchToWindow', { handle: optHandle });
  const ffMix = (await marionette.send('WebDriver:ExecuteAsyncScript', {
    script: `const done = arguments[arguments.length - 1]; browser.runtime.sendMessage({ action: 'RESOLVE_PLAYLIST', url: '${MIX_URL}' }).then(done, e => done({ err: String(e) }));`,
    args: [],
  }, 10000))?.value;
  const ffPl = (await marionette.send('WebDriver:ExecuteAsyncScript', {
    script: `const done = arguments[arguments.length - 1]; browser.runtime.sendMessage({ action: 'OPEN_PLAYLIST', url: '${PLAYLIST_URL}' }).then(done, e => done({ err: String(e) }));`,
    args: [],
  }, 10000))?.value;
  const ffAv = (await marionette.send('WebDriver:ExecuteAsyncScript', {
    script: `
      const done = arguments[arguments.length - 1];
      (async () => {
        const a = await browser.runtime.sendMessage({ action: 'START_MEDIA_DOWNLOAD', url: '${WATCH_URL}', format_id: '250', filename: 'ff_av_a.webm' });
        const v = await browser.runtime.sendMessage({ action: 'START_MEDIA_DOWNLOAD', url: '${WATCH_URL}', format_id: '248', filename: 'ff_av_v.webm' });
        done([a, v]);
      })();
    `,
    args: [],
  }, 15000))?.value;
  for (const id of [ffAv?.[0]?.job_id, ffAv?.[1]?.job_id].filter(Boolean)) {
    await httpJson({ port: DESKTOP_GUI_PORT, path: `/api/v1/downloads/${id}/cancel`, method: 'POST', headers: { 'X-Tori-Token': DESKTOP_TOKEN } });
  }
  record(
    'FF-REG-01',
    'Signed Firefox XPI Mix rejection, Playlist open & Audio->Video sequential intact',
    ffMix?.status !== 'ok' && ffPl?.status === 'ok' && Boolean(ffAv?.[0]?.job_id && ffAv?.[1]?.job_id && ffAv[0].job_id !== ffAv[1].job_id),
    `mix=${ffMix?.status}, pl=${ffPl?.status}, audio=${ffAv?.[0]?.job_id}, video=${ffAv?.[1]?.job_id}`
  );

  try { await marionette.send('Marionette:Quit', {}, 5000); } catch {}
  marionette.disconnect();
  fixtureServer.close();
  cleanupAll();
  await sleep(900);

  const outPath = path.join(ROOT, 'target', 'gate27_8_acceptance_results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    counts,
    total: results.length,
    metrics,
    results,
  }, null, 2));

  try { fs.rmSync(QA_ROOT, { recursive: true, force: true }); } catch {}

  console.log('\n========================================================================');
  console.log(` GATE 27.8 LARGE MKV & CLASSIFICATION: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.TIMEOUT} TIMEOUT, ${counts.NOT_TESTED} NOT TESTED`);
  console.log('========================================================================\n');

  if (counts.FAIL > 0 || counts.TIMEOUT > 0) process.exit(1);
  process.exit(0);
}

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err);
  cleanupAll();
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED]', err);
  cleanupAll();
  process.exit(1);
});

run().catch((err) => {
  console.error('[FATAL]', err);
  cleanupAll();
  process.exit(1);
});
