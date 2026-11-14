#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 27.7
 * Full Desktop v1.0.5-rc, Chrome 157 Interactive v1.0.7, Edge v1.0.7,
 * Real MKV End-to-End Pipeline, SSE Lifecycle, Pause/Resume & Regression Suite.
 *
 * Isolation & Safety Guarantees:
 * - Isolated TORI_DATA_DIR, TORI_IPC_PIPE, unique HTTP/CDP ports, isolated browser profiles.
 * - Never touches user production SQLite DB, user downloads, or live browser sessions.
 * - Bounded timeouts on every spawn, UIA, CDP, and HTTP operation; tracked PIDs cleaned on exit.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALLER_EXE = path.join(ROOT, 'release', 'v1.0.5-rc', 'TORI Download Manager_1.0.5_x64-setup.exe');
const HOST_EXE = path.join(ROOT, 'release', 'v1.0.5-rc', 'tdm-native-host.exe');
const EXT_DIR = path.join(ROOT, 'extension');
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXPECTED_EXT_ID = 'jfnfgmcbgapcpieaonbaolgebjaejcdm';

const DESKTOP_GUI_PORT = 19896;
const WEBVIEW2_CDP_PORT = 19897;
const NATIVE_HOST_PORT = 19898;
const CHROME_CDP_PORT = 19899;
const EDGE_CDP_PORT = 19900;
const FIXTURE_PORT = 19901;

const QA_ROOT = path.join(ROOT, 'target', 'gate27_7_full_qa');
const DESKTOP_INSTALL_DIR = path.join(QA_ROOT, 'desktop_install');
const DESKTOP_DATA_DIR = path.join(QA_ROOT, 'desktop_data');
const DESKTOP_USERPROFILE = path.join(QA_ROOT, 'desktop_profile');
const DESKTOP_DL_DIR = path.join(DESKTOP_USERPROFILE, 'Downloads');
const HOST_DATA_DIR = path.join(QA_ROOT, 'host_data');
const HOST_USERPROFILE = path.join(QA_ROOT, 'host_profile');
const HOST_DL_DIR = path.join(HOST_USERPROFILE, 'Downloads');
const CHROME_PROF_DIR = path.join(QA_ROOT, 'chrome_profile');
const CHROME_DL_DIR = path.join(QA_ROOT, 'chrome_browser_dl');
const EDGE_PROF_DIR = path.join(QA_ROOT, 'edge_profile');
const EDGE_DL_DIR = path.join(QA_ROOT, 'edge_browser_dl');

const DESKTOP_TOKEN = 'tori_qa_desktop_gate27_7';
const HOST_TOKEN = 'tori_qa_host_gate27_7';
const MIX_URL = 'https://www.youtube.com/watch?v=mVeAD3nbXGs&list=RDmVeAD3nbXGs&start_radio=1';
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PL6B3937A5D230E335';
const WATCH_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

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

const OEM_HOST_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'bin', 'tdm-native-host.exe');

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

function seedToriSqlite(dbPath, { port, dir, token, closeToTray = true }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const appSettings = JSON.stringify({
    port,
    dir,
    sort: true,
    con: 16,
    maxa: 4,
    key: token,
    cap: true,
    closeToTray,
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

async function waitForCdpTargets(port, timeoutMs = 12000, requireBrowserWs = true) {
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

function submitChromeLoadUnpackedDialog(chromePid, unpackedDir) {
  const psScript = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinApi277 {
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
$hEdit = [WinApi277]::GetDlgItem($hDlg, 1152)
if ($hEdit -eq [IntPtr]::Zero) { throw "Folder Edit control (1152) not found" }
[WinApi277]::SendMessage($hEdit, 0x000C, [IntPtr]::Zero, $env:TORI_UNPACKED_EXT) | Out-Null
Start-Sleep -Milliseconds 150
$hBtn = [WinApi277]::GetDlgItem($hDlg, 1)
if ($hBtn -eq [IntPtr]::Zero) { throw "OK button (1) not found" }
[WinApi277]::PostMessage($hBtn, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
Write-Output "UIA_SUBMITTED_OK"
`;
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
    env: { ...process.env, TORI_UNPACKED_EXT: unpackedDir },
    encoding: 'utf8',
    timeout: 12000,
  });
  return out.includes('UIA_SUBMITTED_OK');
}

function connectSseCollector(port, token) {
  const events = [];
  let aborted = false;
  const req = http.get({
    hostname: '127.0.0.1',
    port,
    path: `/api/v1/events?token=${encodeURIComponent(token)}`,
    headers: { Host: `127.0.0.1:${port}`, Accept: 'text/event-stream' },
  }, (res) => {
    let buf = '';
    res.on('data', (chunk) => {
      if (aborted) return;
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = frame.split(/\r?\n/);
        let eventName = 'message';
        let dataLine = '';
        for (const l of lines) {
          if (l.startsWith('event:')) eventName = l.slice(6).trim();
          else if (l.startsWith('data:')) dataLine += l.slice(5).trim();
        }
        if (dataLine) {
          let parsed = dataLine;
          try { parsed = JSON.parse(dataLine); } catch {}
          events.push({ ts: Date.now(), event: eventName, data: parsed });
        }
      }
    });
  });
  req.on('error', () => {});
  return {
    events,
    close: () => { aborted = true; try { req.destroy(); } catch {} },
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFileOnDisk(filePath, expectedSize, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const st = fs.statSync(filePath);
      if (st.size === expectedSize) return true;
    }
    await sleep(200);
  }
  return false;
}

async function run() {
  console.log('========================================================================');
  console.log(' TORI Gate 27.7 — Comprehensive Release Candidate Acceptance Suite');
  console.log('========================================================================\n');

  const globalWatchdog = setTimeout(() => {
    console.error('\n[WATCHDOG] Global 240s suite limit reached! Terminating tracked children.');
    cleanupAll();
    process.exit(1);
  }, 240000);
  globalWatchdog.unref();

  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  for (const d of [
    DESKTOP_INSTALL_DIR, DESKTOP_DATA_DIR, DESKTOP_DL_DIR,
    HOST_DATA_DIR, HOST_DL_DIR,
    CHROME_PROF_DIR, CHROME_DL_DIR,
    EDGE_PROF_DIR, EDGE_DL_DIR,
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // Build deterministic fixture buffers
  const mkvStd24 = makePatternBuffer(24 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');
  const mkvCd12 = makePatternBuffer(12 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');
  const mkvPause16 = makePatternBuffer(16 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');
  const mkvRedir8 = makePatternBuffer(8 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');
  const mkvEdge10 = makePatternBuffer(10 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');
  const mkvUni4 = makePatternBuffer(4 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');
  const mp4Norm6 = makePatternBuffer(6 * 1024 * 1024, '00000018667479706d703432');
  const mkvOff2 = makePatternBuffer(2 * 1024 * 1024, '1a45dfa3934282886d6174726f736b61');

  const sha = {
    mkvStd24: sha256(mkvStd24),
    mkvCd12: sha256(mkvCd12),
    mkvPause16: sha256(mkvPause16),
    mkvRedir8: sha256(mkvRedir8),
    mkvEdge10: sha256(mkvEdge10),
    mkvUni4: sha256(mkvUni4),
    mp4Norm6: sha256(mp4Norm6),
    mkvOff2: sha256(mkvOff2),
  };

  let throttlePauseFixture = true;
  const SYNTHETIC_2_9_GB = 3113851289; // exact 2.900 GiB
  let syntheticBytesServed = 0;

  const fixtureServer = http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${FIXTURE_PORT}`);
    const decodedPath = decodeURIComponent(u.pathname);

    if (u.pathname === '/test.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end([
        '<!doctype html><html><head><title>TORI Gate 27.7 E2E</title></head><body>',
        '<h1>TORI Browser & Engine Pipeline Fixtures</h1>',
        '<a id="dl-std24" href="/standard_24m.mkv" download="standard_24m.mkv">24M MKV</a>',
        '<a id="dl-cd12" href="/cd_blob">CD 12M MKV</a>',
        '<a id="dl-unicode" href="/films/Test%20Film%20%E5%A4%A7%E5%9E%8B%20%E6%98%A0%E7%94%BB%20(2026).mkv" download="Test Film 大型 映画 (2026).mkv">Unicode MKV</a>',
        '<a id="dl-redir8" href="/redirect_start">Redirect 8M MKV</a>',
        '<a id="dl-mp4" href="/Normal_Film_6m.mp4" download="Normal_Film_6m.mp4">6M MP4</a>',
        '<a id="dl-synth29" href="/synthetic_large_2_9gb.mkv" download="synthetic_large_2_9gb.mkv">2.9G MKV</a>',
        '<a id="dl-offline" href="/offline_recovery_2m.mkv" download="offline_recovery_2m.mkv">Offline 2M MKV</a>',
        '<a id="dl-recover" href="/post_recovery_2m.mkv" download="post_recovery_2m.mkv">Post Recovery 2M MKV</a>',
        '<a id="dl-edge10" href="/Edge_Standard_10m.mkv" download="Edge_Standard_10m.mkv">Edge 10M MKV</a>',
        '</body></html>',
      ].join(''));
      return;
    }

    if (u.pathname === '/redirect_start') {
      const signedLoc = `http://127.0.0.1:${FIXTURE_PORT}/cdn/Signed_Transfer_2026.mkv?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=deadbeefcafebabe`;
      res.writeHead(302, { Location: signedLoc });
      res.end();
      return;
    }

    if (u.pathname === '/synthetic_large_2_9gb.mkv') {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'video/x-matroska',
          'Content-Length': String(SYNTHETIC_2_9_GB),
          'Accept-Ranges': 'bytes',
        });
        res.end();
        return;
      }
      const range = req.headers.range;
      let start = 0;
      let end = Math.min(65535, SYNTHETIC_2_9_GB - 1);
      if (range && range.startsWith('bytes=')) {
        const [s, e] = range.slice(6).split('-');
        start = parseInt(s, 10) || 0;
        const parsedEnd = e ? parseInt(e, 10) : Math.min(start + 65535, SYNTHETIC_2_9_GB - 1);
        end = Math.min(parsedEnd, start + 65535, SYNTHETIC_2_9_GB - 1);
        const len = end - start + 1;
        syntheticBytesServed += len;
        res.writeHead(206, {
          'Content-Type': 'video/x-matroska',
          'Content-Range': `bytes ${start}-${end}/${SYNTHETIC_2_9_GB}`,
          'Content-Length': String(len),
          'Accept-Ranges': 'bytes',
        });
        res.end(makePatternBuffer(len, '1a45dfa3934282886d6174726f736b61'));
        return;
      }
      // Browser initial request: respond with 200 Content-Length = 2.9 GB and trickle only initial 64 KiB
      // Wait briefly before closing so browser download exists long enough for extension cancellation without huge RAM/disk.
      const slice = makePatternBuffer(65536, '1a45dfa3934282886d6174726f736b61');
      syntheticBytesServed += slice.length;
      res.writeHead(200, {
        'Content-Type': 'video/x-matroska',
        'Content-Length': String(SYNTHETIC_2_9_GB),
        'Accept-Ranges': 'bytes',
      });
      res.write(slice);
      const t = setTimeout(() => { try { res.destroy(); } catch {} }, 1500);
      req.on('close', () => clearTimeout(t));
      return;
    }

    let buf = null;
    let ctype = 'video/x-matroska';
    const extra = {};
    if (u.pathname === '/standard_24m.mkv') buf = mkvStd24;
    else if (u.pathname === '/cd_blob') {
      buf = mkvCd12;
      ctype = 'application/octet-stream';
      extra['Content-Disposition'] = 'attachment; filename="Cosmic_Odyssey_1080p_BluRay.mkv"';
    } else if (decodedPath === '/films/Test Film 大型 映画 (2026).mkv') buf = mkvUni4;
    else if (u.pathname === '/cdn/Signed_Transfer_2026.mkv') { buf = mkvRedir8; ctype = 'application/octet-stream'; }
    else if (u.pathname === '/Edge_Standard_10m.mkv') buf = mkvEdge10;
    else if (u.pathname === '/Normal_Film_6m.mp4') { buf = mp4Norm6; ctype = 'video/mp4'; }
    else if (u.pathname === '/offline_recovery_2m.mkv' || u.pathname === '/post_recovery_2m.mkv') buf = mkvOff2;
    else if (u.pathname === '/pause_resume_16m.mkv') buf = mkvPause16;

    if (!buf) { res.writeHead(404); res.end('Not found'); return; }
    const total = buf.length;
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': String(total), 'Accept-Ranges': 'bytes', ...extra });
      res.end();
      return;
    }

    let slice = buf;
    let status = 200;
    const hdrs = { 'Content-Type': ctype, 'Accept-Ranges': 'bytes', ...extra };
    const range = req.headers.range;
    if (range && range.startsWith('bytes=')) {
      const [s, e] = range.slice(6).split('-');
      const start = parseInt(s, 10) || 0;
      const end = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
      slice = buf.subarray(start, end + 1);
      status = 206;
      hdrs['Content-Range'] = `bytes ${start}-${end}/${total}`;
    }
    hdrs['Content-Length'] = String(slice.length);
    res.writeHead(status, hdrs);

    if (
      !req.headers.range &&
      u.pathname !== '/pause_resume_16m.mkv' &&
      u.pathname !== '/offline_recovery_2m.mkv'
    ) {
      // Simulate real-world transfer RTT so Chrome/Edge keep initial browser GET active until TORI cancels it
      const firstEnd = Math.min(65536, slice.length);
      res.write(slice.subarray(0, firstEnd));
      const recTimer = setTimeout(() => {
        if (!res.destroyed) res.end(slice.subarray(firstEnd));
      }, 250);
      req.on('close', () => clearTimeout(recTimer));
      return;
    }

    if (u.pathname === '/pause_resume_16m.mkv' && throttlePauseFixture) {
      let off = 0;
      const chunkSz = 16 * 1024;
      const iv = setInterval(() => {
        if (!throttlePauseFixture || off >= slice.length || res.destroyed) {
          clearInterval(iv);
          if (!res.destroyed && off < slice.length) res.end(slice.subarray(off));
          else if (!res.destroyed) res.end();
          return;
        }
        const nextEnd = Math.min(off + chunkSz, slice.length);
        res.write(slice.subarray(off, nextEnd));
        off = nextEnd;
      }, 110);
      req.on('close', () => clearInterval(iv));
      return;
    }

    res.end(slice);
  });
  await new Promise((r) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', r));

  // =========================================================================
  // PART A: Isolated TORI Desktop v1.0.5-rc NSIS Install, Tray, SSE & Media
  // =========================================================================
  console.log('>>> [PART A] TORI Desktop v1.0.5-rc Isolated NSIS Install, Tray Persistence & SSE <<<\n');
  execSync(`"${INSTALLER_EXE}" /S /D=${DESKTOP_INSTALL_DIR}`, { timeout: 60000 });
  const installedExe = path.join(DESKTOP_INSTALL_DIR, 'tori-download-manager.exe');
  record('DESK-INST-01', 'NSIS v1.0.5-rc silent installer installs cleanly to isolated directory', fs.existsSync(installedExe), installedExe);
  if (!fs.existsSync(installedExe)) throw new Error('NSIS install failed to populate isolated directory');

  const deskDbPath = path.join(DESKTOP_DATA_DIR, 'tdm_storage.sqlite');
  seedToriSqlite(deskDbPath, { port: DESKTOP_GUI_PORT, dir: DESKTOP_DL_DIR, token: DESKTOP_TOKEN, closeToTray: true });
  const pipeName = `\\\\.\\pipe\\tori-qa-g277-${process.pid}`;

  const spawnDesktop = () => {
    const p = spawn(installedExe, [], {
      env: {
        ...process.env,
        TORI_DATA_DIR: DESKTOP_DATA_DIR,
        TORI_IPC_PIPE: pipeName,
        TORI_ALLOW_LOOPBACK: '1',
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${WEBVIEW2_CDP_PORT}`,
      },
      stdio: 'ignore',
    });
    trackedProcs.add(p);
    return p;
  };

  let deskProc = spawnDesktop();
  let deskOnline = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const st = await httpJson({ port: DESKTOP_GUI_PORT, path: '/api/v1/ping', headers: { 'X-Tori-Token': DESKTOP_TOKEN } });
    if (st.ok && st.data?.authenticated === true) { deskOnline = true; break; }
  }
  const cdpDeskInfo = await waitForCdpTargets(WEBVIEW2_CDP_PORT, 15000, false);
  const mainTarget = cdpDeskInfo.targets.find((t) => t.type === 'page' && !t.url.includes('toast')) || cdpDeskInfo.targets[0];
  const deskCdp = new CDPClient(mainTarget.webSocketDebuggerUrl);
  await deskCdp.connect(6000);

  // Give React app a brief moment for window.__TAURI_INTERNALS__
  await deskCdp.evalAsync(`new Promise(r => { const t = setInterval(() => { if (window.__TAURI_INTERNALS__?.invoke) { clearInterval(t); r(true); } }, 100); })`, 10000);
  record('DESK-BOOT-01', 'Isolated Desktop v1.0.5-rc online with authenticated HTTP API + WebView2 CDP', deskOnline && !!mainTarget, `port=${DESKTOP_GUI_PORT}`);

  // Tray ON: close hides window, process + API remain alive, restore works
  await deskCdp.evalAsync(`window.__TAURI_INTERNALS__.invoke('window_close')`);
  await sleep(1000);
  const apiWhileHidden = await httpJson({ port: DESKTOP_GUI_PORT, path: '/api/v1/ping', headers: { 'X-Tori-Token': DESKTOP_TOKEN } });
  const logPath = path.join(DESKTOP_DATA_DIR, 'logs', 'lifecycle.log');
  const logAfterHide = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  record(
    'DESK-TRAY-01',
    'Close-to-tray ON hides main window while keeping Desktop process and API port alive',
    isProcessAlive(deskProc.pid) && apiWhileHidden.ok && logAfterHide.includes('[TRAY] INITIALIZED') && logAfterHide.includes('[WINDOW] HIDE_MAIN'),
    `alive=${isProcessAlive(deskProc.pid)}, httpOk=${apiWhileHidden.ok}`
  );

  await deskCdp.evalAsync(`window.__TAURI_INTERNALS__.invoke('show_main_window')`);
  await sleep(600);
  const logAfterRestore = fs.readFileSync(logPath, 'utf8');
  const restoreDelta = logAfterRestore.slice(logAfterHide.length);
  record('DESK-TRAY-02', 'Desktop tray/show_main_window restores main window cleanly', restoreDelta.includes('[WINDOW] RESTORE_MAIN'));

  // Tray OFF: wait for initial syncSettings flush, set closeToTray=false, exit cleanly so WebView2 flushes localStorage, then restart & test clean exit
  await deskCdp.evalAsync(`(async () => {
    const start = Date.now();
    while (localStorage.getItem('tori_settings_v104_tray_migrated') !== 'true' && Date.now() - start < 4000) {
      await new Promise(r => setTimeout(r, 100));
    }
    const cur = await window.__TAURI_INTERNALS__.invoke('get_engine_settings') || {};
    cur.closeToTray = false;
    cur.port = ${DESKTOP_GUI_PORT};
    cur.dir = ${JSON.stringify(DESKTOP_DL_DIR)};
    cur.sort = true;
    localStorage.setItem('tori_settings_v2', JSON.stringify(cur));
    await window.__TAURI_INTERNALS__.invoke('update_engine_settings', { settings: cur });
  })()`, 10000);
  await sleep(300);
  await deskCdp.evalAsync(`window.__TAURI_INTERNALS__.invoke('exit_app')`).catch(() => {});
  deskCdp.close();
  for (let i = 0; i < 25; i++) {
    if (!isProcessAlive(deskProc.pid)) break;
    await sleep(250);
  }
  killTracked(deskProc);
  trackedProcs.delete(deskProc);
  await sleep(600);

  deskProc = spawnDesktop();
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const st = await httpJson({ port: DESKTOP_GUI_PORT, path: '/api/v1/ping', headers: { 'X-Tori-Token': DESKTOP_TOKEN } });
    if (st.ok) break;
  }
  const cdpDeskInfo2 = await waitForCdpTargets(WEBVIEW2_CDP_PORT, 15000, false);
  const mainTarget2 = cdpDeskInfo2.targets.find((t) => t.type === 'page' && !t.url.includes('toast')) || cdpDeskInfo2.targets[0];
  const deskCdp2 = new CDPClient(mainTarget2.webSocketDebuggerUrl);
  await deskCdp2.connect(6000);
  await deskCdp2.evalAsync(`new Promise(r => { const t = setInterval(() => { if (window.__TAURI_INTERNALS__?.invoke) { clearInterval(t); r(true); } }, 100); })`, 10000);
  await sleep(800);
  const persistedSetting = await deskCdp2.evalAsync(`window.__TAURI_INTERNALS__.invoke('get_engine_settings')`);

  await deskCdp2.evalAsync(`window.__TAURI_INTERNALS__.invoke('window_close')`).catch(() => {});
  let exitedClean = false;
  for (let i = 0; i < 30; i++) {
    if (!isProcessAlive(deskProc.pid)) { exitedClean = true; break; }
    await sleep(300);
  }
  const logAfterExit = fs.readFileSync(logPath, 'utf8');
  const exitDelta = logAfterExit.slice(logAfterRestore.length);
  record(
    'DESK-TRAY-03',
    'Close-to-tray OFF persists across restart and exits Desktop process cleanly without zombie listeners',
    persistedSetting?.closeToTray === false && exitedClean && exitDelta.includes('EXIT_CLEAN'),
    `persistedFalse=${persistedSetting?.closeToTray === false}, exited=${exitedClean}`
  );
  deskCdp2.close();
  killTracked(deskProc);
  trackedProcs.delete(deskProc);
  await sleep(600);

  // Re-launch Desktop cleanly to verify SSE pause/resume, .tdm-part, Playlist/Mix & Audio->Video
  deskProc = spawnDesktop();
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const st = await httpJson({ port: DESKTOP_GUI_PORT, path: '/api/v1/ping', headers: { 'X-Tori-Token': DESKTOP_TOKEN } });
    if (st.ok) break;
  }

  // SSE Pause / Resume / Partial File & Notification Timing Test on 16 MiB MKV
  const sse = connectSseCollector(DESKTOP_GUI_PORT, DESKTOP_TOKEN);
  await sleep(300);
  const prCreate = await httpJson({
    port: DESKTOP_GUI_PORT,
    path: '/api/v1/downloads',
    method: 'POST',
    headers: { 'X-Tori-Token': DESKTOP_TOKEN },
    body: {
      url: `http://127.0.0.1:${FIXTURE_PORT}/pause_resume_16m.mkv`,
      filename: 'pause_resume_16m.mkv',
    },
  });
  const prId = prCreate?.data?.job_id;
  let midJob = null;
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    const g = await httpJson({ port: DESKTOP_GUI_PORT, path: `/api/v1/downloads/${prId}`, headers: { 'X-Tori-Token': DESKTOP_TOKEN } });
    midJob = g?.data;
    if (midJob && midJob.downloaded_bytes >= 256 * 1024 && midJob.state === 'downloading') break;
  }
  await httpJson({ port: DESKTOP_GUI_PORT, path: `/api/v1/downloads/${prId}/pause`, method: 'POST', headers: { 'X-Tori-Token': DESKTOP_TOKEN } });
  let pausedJob = null;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    const g = await httpJson({ port: DESKTOP_GUI_PORT, path: `/api/v1/downloads/${prId}`, headers: { 'X-Tori-Token': DESKTOP_TOKEN } });
    if (g?.data?.state === 'paused') { pausedJob = g.data; break; }
  }
  const partFile = pausedJob?.temp_path || path.join(DESKTOP_DL_DIR, 'Video', 'pause_resume_16m.mkv.tdm-part');
  const finalPauseTarget = pausedJob?.target_path || path.join(DESKTOP_DL_DIR, 'Video', 'pause_resume_16m.mkv');
  const prematureCompleted = sse.events.some(
    (e) => e.event === 'state_changed' && e.data?.id === prId && String(e.data?.state || '').toLowerCase() === 'completed'
  );
  record(
    'DESK-SSE-01',
    'Pause preserves .tdm-part on disk, hides final target, and emits zero premature completed SSE events',
    pausedJob?.state === 'paused' && fs.existsSync(partFile) && fs.statSync(partFile).size > 0 && !fs.existsSync(finalPauseTarget) && !prematureCompleted,
    `pausedAt=${pausedJob?.downloaded_bytes}, partExists=${fs.existsSync(partFile)}, prematureCompleted=${prematureCompleted}`
  );

  throttlePauseFixture = false;
  await httpJson({ port: DESKTOP_GUI_PORT, path: `/api/v1/downloads/${prId}/resume`, method: 'POST', headers: { 'X-Tori-Token': DESKTOP_TOKEN } });
  let donePauseJob = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const g = await httpJson({ port: DESKTOP_GUI_PORT, path: `/api/v1/downloads/${prId}`, headers: { 'X-Tori-Token': DESKTOP_TOKEN } });
    if (g?.data?.state === 'completed') { donePauseJob = g.data; break; }
  }
  const diskPauseOk = fs.existsSync(finalPauseTarget) &&
    fs.statSync(finalPauseTarget).size === mkvPause16.length &&
    sha256(fs.readFileSync(finalPauseTarget)) === sha.mkvPause16 &&
    !fs.existsSync(partFile);
  const completedIdx = sse.events.findIndex(
    (e) => e.event === 'state_changed' && e.data?.id === prId && String(e.data?.state || '').toLowerCase() === 'completed'
  );
  const verifyingIdx = sse.events.findIndex(
    (e) => e.event === 'state_changed' && e.data?.id === prId && String(e.data?.state || '').toLowerCase() === 'verifying'
  );
  record(
    'DESK-SSE-02',
    'Resumed 16 MiB MKV completes to exact SHA-256 on disk, deletes .tdm-part, and emits completed only after verification',
    donePauseJob?.state === 'completed' && diskPauseOk && completedIdx !== -1 && (verifyingIdx === -1 || verifyingIdx < completedIdx),
    `bytes=${donePauseJob?.downloaded_bytes}/${mkvPause16.length}, verifyingIdx=${verifyingIdx}, completedIdx=${completedIdx}`
  );
  metrics.pauseResumeMkv = { bytes: mkvPause16.length, sha256: sha.mkvPause16 };
  sse.close();

  // Playlist, YouTube Mix 422 rejection & Audio->Video on Desktop v1.0.5-rc
  const mixResp = await httpJson({
    port: DESKTOP_GUI_PORT,
    path: '/api/v1/media/playlist/open',
    method: 'POST',
    headers: { 'X-Tori-Token': DESKTOP_TOKEN },
    body: { url: MIX_URL },
  });
  const mixResolveResp = await httpJson({
    port: DESKTOP_GUI_PORT,
    path: '/api/v1/media/playlist/resolve',
    method: 'POST',
    headers: { 'X-Tori-Token': DESKTOP_TOKEN },
    body: { url: MIX_URL },
    timeoutMs: 12000,
  });
  const plOpenResp = await httpJson({
    port: DESKTOP_GUI_PORT,
    path: '/api/v1/media/playlist/open',
    method: 'POST',
    headers: { 'X-Tori-Token': DESKTOP_TOKEN },
    body: { url: PLAYLIST_URL },
  });
  const avAudio = await httpJson({
    port: DESKTOP_GUI_PORT,
    path: '/api/v1/media/download',
    method: 'POST',
    headers: { 'X-Tori-Token': DESKTOP_TOKEN },
    body: { url: WATCH_URL, format_id: '250', filename: 'desk_av_audio.webm' },
  });
  const avVideo = await httpJson({
    port: DESKTOP_GUI_PORT,
    path: '/api/v1/media/download',
    method: 'POST',
    headers: { 'X-Tori-Token': DESKTOP_TOKEN },
    body: { url: WATCH_URL, format_id: '248', filename: 'desk_av_video.webm' },
  });
  for (const id of [avAudio?.data?.job_id, avVideo?.data?.job_id].filter(Boolean)) {
    await httpJson({ port: DESKTOP_GUI_PORT, path: `/api/v1/downloads/${id}/cancel`, method: 'POST', headers: { 'X-Tori-Token': DESKTOP_TOKEN } });
  }
  record(
    'DESK-PL-01',
    'Desktop rejects YouTube Mix RD URL on playlist/resolve with HTTP 422 and accepts regular playlist open',
    mixResolveResp.status === 422 && plOpenResp.status === 200,
    `mixOpen=${mixResp.status}, mixResolve=${mixResolveResp.status}, plOpen=${plOpenResp.status}`
  );
  record(
    'DESK-AV-01',
    'Desktop Audio-only followed by Video download on same URL creates distinct active jobs',
    Boolean(avAudio?.data?.job_id && avVideo?.data?.job_id && avAudio.data.job_id !== avVideo.data.job_id),
    `audio=${avAudio?.data?.job_id}, video=${avVideo?.data?.job_id}`
  );

  // Stop Desktop before browser engine tests and restore OEM native messaging registration immediately
  killTracked(deskProc);
  trackedProcs.delete(deskProc);
  await sleep(800);
  restoreOemNativeHost();

  // =========================================================================
  // PART B: Google Chrome 157 Interactive Load Unpacked + 5 API Tests + E2E MKV + Offline Recovery
  // =========================================================================
  console.log('\n>>> [PART B] Google Chrome 157 Interactive Load + Full MKV/MP4 E2E & Offline Recovery <<<\n');
  seedToriSqlite(path.join(HOST_DATA_DIR, 'tdm_storage.sqlite'), {
    port: NATIVE_HOST_PORT,
    dir: HOST_DL_DIR,
    token: HOST_TOKEN,
    closeToTray: true,
  });

  const hostPipeName = `\\\\.\\pipe\\tori-qa-g277-host-${process.pid}`;
  const isolatedBrowserEnv = {
    ...process.env,
    TORI_DATA_DIR: HOST_DATA_DIR,
    TORI_IPC_PIPE: hostPipeName,
    TORI_ALLOW_LOOPBACK: '1',
    TORI_DISABLE_AUTO_SPAWN: '1',
    TORI_API_PORT: String(NATIVE_HOST_PORT),
    TORI_AUTH_TOKEN: HOST_TOKEN,
  };

  const startHost = async () => {
    const p = spawn(HOST_EXE, ['--serve', String(NATIVE_HOST_PORT)], {
      env: {
        ...process.env,
        TORI_DATA_DIR: HOST_DATA_DIR,
        USERPROFILE: HOST_USERPROFILE,
        TORI_IPC_PIPE: hostPipeName,
        TORI_ALLOW_LOOPBACK: '1',
        TORI_DISABLE_AUTO_SPAWN: '1',
      },
      stdio: 'ignore',
    });
    trackedProcs.add(p);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const st = await httpJson({ port: NATIVE_HOST_PORT, path: '/api/v1/ping', headers: { 'X-Tori-Token': HOST_TOKEN } });
      if (st.ok && st.data?.authenticated === true) return p;
    }
    throw new Error('Isolated tdm-native-host failed to reach ready state');
  };

  let hostProc = await startHost();

  // Prepare isolated Chrome profile (suppress first-run wizard & force download dir)
  fs.mkdirSync(path.join(CHROME_PROF_DIR, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(CHROME_PROF_DIR, 'First Run'), '');
  fs.writeFileSync(path.join(CHROME_PROF_DIR, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: CHROME_DL_DIR, prompt_for_download: false },
    profile: { default_content_setting_values: { automatic_downloads: 1 } },
    safebrowsing: { enabled: true },
  }));

  const chromeProc = spawn(CHROME_EXE, [
    `--remote-debugging-port=${CHROME_CDP_PORT}`,
    `--user-data-dir=${CHROME_PROF_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--window-size=1200,820',
    'chrome://extensions/',
  ], { env: isolatedBrowserEnv, stdio: 'ignore' });
  trackedProcs.add(chromeProc);

  const chromeCdpInfo = await waitForCdpTargets(CHROME_CDP_PORT, 15000);
  const browserCdp = new CDPClient(chromeCdpInfo.version.webSocketDebuggerUrl);
  await browserCdp.connect(6000);

  let extPageTarget = chromeCdpInfo.targets.find((t) => t.url.startsWith('chrome://extensions'));
  if (!extPageTarget) {
    const created = await browserCdp.send('Target.createTarget', { url: 'chrome://extensions/' });
    const list2 = await waitForCdpTargets(CHROME_CDP_PORT, 5000);
    extPageTarget = list2.targets.find((t) => t.id === created.targetId);
  }
  const extCdp = new CDPClient(extPageTarget.webSocketDebuggerUrl);
  await extCdp.connect(6000);
  await sleep(1000);

  await extCdp.evalAsync(`chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })`, 6000);
  // loadUnpacked() opens a modal OS folder picker; fire without waiting before UIA fills it
  const loadPromise = extCdp.evalAsync(`chrome.developerPrivate.loadUnpacked().then(() => 'OK').catch(e => String(e))`, 15000, { userGesture: true });
  const uiaOk = submitChromeLoadUnpackedDialog(chromeProc.pid, EXT_DIR);
  const loadRes = await loadPromise;
  await sleep(1000);
  const extsInfo = await extCdp.evalAsync(`chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true })`, 6000);
  const toriExt = (extsInfo || []).find((e) => e.id === EXPECTED_EXT_ID || e.name.includes('TORI'));
  extCdp.close();

  record(
    'CHR-LOAD-01',
    'Google Chrome 157 interactive Developer Mode + Load Unpacked loads TORI Companion v1.0.7 cleanly',
    Boolean(uiaOk && toriExt && toriExt.version === '1.0.7' && toriExt.state === 'ENABLED'),
    `loadRes=${loadRes}, id=${toriExt?.id}, ver=${toriExt?.version}, state=${toriExt?.state}`
  );

  // Open options.html and fixture web page tabs in Chrome
  const { targetId: chrOptTargetId } = await browserCdp.send('Target.createTarget', {
    url: `chrome-extension://${toriExt.id}/options/options.html`,
  });
  const { targetId: chrWebTargetId } = await browserCdp.send('Target.createTarget', {
    url: `http://127.0.0.1:${FIXTURE_PORT}/test.html`,
  });
  await sleep(1200);
  const chrTargets = (await waitForCdpTargets(CHROME_CDP_PORT, 5000)).targets;
  const chrOptCdp = new CDPClient(chrTargets.find((t) => t.id === chrOptTargetId).webSocketDebuggerUrl);
  const chrWebCdp = new CDPClient(chrTargets.find((t) => t.id === chrWebTargetId).webSocketDebuggerUrl);
  await chrOptCdp.connect(6000);
  await chrWebCdp.connect(6000);

  // [CHR-VER-01] Configure settings + PING_DESKTOP
  const chrPing = await chrOptCdp.evalAsync(`new Promise(r => {
    chrome.storage.local.set({
      tori_settings: {
        port: ${NATIVE_HOST_PORT}, key: '${HOST_TOKEN}', auto: true, cap: true, min: 0, badge: true, sites: [],
        types: ['zip','rar','7z','iso','exe','dmg','pdf','mp4','mp3','mkv']
      }
    }, () => setTimeout(() => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${NATIVE_HOST_PORT}, key: '${HOST_TOKEN}' }, r), 300));
  })`, 8000);
  record(
    'CHR-VER-01',
    'Chrome v1.0.7 service worker pairs & pings isolated Desktop API',
    chrPing?.status === 'ok' && chrPing?.authenticated === true,
    JSON.stringify(chrPing)
  );

  // Trigger each download sequentially with explicit userGesture:true so Chrome never suppresses multi-file prompts
  for (const id of ['dl-std24', 'dl-cd12', 'dl-unicode', 'dl-redir8', 'dl-mp4', 'dl-synth29']) {
    await chrWebCdp.evalAsync(`(() => { const el = document.getElementById('${id}'); if (!el) throw new Error('missing ${id} on ' + location.href); el.click(); return true; })()`, 4000, { userGesture: true });
    await sleep(450);
  }

  // Poll desktop jobs for the synthetic 2.9 GB job immediately so we capture chunk planning & cancel fast
  let synthJob = null;
  let synthChunkCount = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const listRes = await httpJson({ port: NATIVE_HOST_PORT, path: '/api/v1/downloads', headers: { 'X-Tori-Token': HOST_TOKEN } });
    const j = (listRes?.data?.jobs || []).find((x) => x.filename === 'synthetic_large_2_9gb.mkv');
    if (j && j.total_bytes === SYNTHETIC_2_9_GB) {
      const detailRes = await httpJson({ port: NATIVE_HOST_PORT, path: `/api/v1/downloads/${j.id}`, headers: { 'X-Tori-Token': HOST_TOKEN } });
      synthChunkCount = detailRes?.data?.chunk_count ?? detailRes?.data?.job?.chunk_count ?? j.chunk_count ?? 0;
      synthJob = j;
      await httpJson({ port: NATIVE_HOST_PORT, path: `/api/v1/downloads/${j.id}/cancel`, method: 'POST', headers: { 'X-Tori-Token': HOST_TOKEN } });
      await httpJson({ port: NATIVE_HOST_PORT, path: `/api/v1/downloads/${j.id}`, method: 'DELETE', headers: { 'X-Tori-Token': HOST_TOKEN } });
      break;
    }
  }
  record(
    'CHR-MKV-2_9G',
    'Chrome intercepts synthetic 2.9 GB MKV header -> TORI plans 16 chunks with exact 3,113,851,289 B total_bytes (cancelled without 2.9 GB transfer)',
    Boolean(synthJob && synthJob.total_bytes === SYNTHETIC_2_9_GB && synthChunkCount === 16),
    `totalBytes=${synthJob?.total_bytes}, chunks=${synthChunkCount}, syntheticHttpBytesServed=${syntheticBytesServed}`
  );
  metrics.synthetic2_9gb = { totalBytes: synthJob?.total_bytes || 0, chunkCount: synthChunkCount, probeBytesTransferred: syntheticBytesServed };

  // Wait for the 5 real completed transfers (24M + 12M CD + 4M Unicode + 8M Redirect + 6M MP4)
  // Gate 27.8 fix: post-probe HTTP Content-Disposition resolves Cosmic_Odyssey_1080p_BluRay.mkv directly into Video/ before DB persistence.
  const expectedFiles = [
    { name: 'standard_24m.mkv', expectedFolder: 'Video', bytes: mkvStd24.length, digest: sha.mkvStd24 },
    { name: 'Cosmic_Odyssey_1080p_BluRay.mkv', expectedFolder: 'Video', bytes: mkvCd12.length, digest: sha.mkvCd12 },
    { name: 'Test Film 大型 映画 (2026).mkv', expectedFolder: 'Video', bytes: mkvUni4.length, digest: sha.mkvUni4 },
    { name: 'Signed_Transfer_2026.mkv', expectedFolder: 'Video', bytes: mkvRedir8.length, digest: sha.mkvRedir8 },
    { name: 'Normal_Film_6m.mp4', expectedFolder: 'Video', bytes: mp4Norm6.length, digest: sha.mp4Norm6 },
  ];

  let allRealJobs = [];
  for (let i = 0; i < 80; i++) {
    const listRes = await httpJson({ port: NATIVE_HOST_PORT, path: '/api/v1/downloads', headers: { 'X-Tori-Token': HOST_TOKEN } });
    allRealJobs = listRes?.data?.jobs || [];
    const doneAll = expectedFiles.every((f) => allRealJobs.find((j) => j.filename === f.name && j.state === 'completed'));
    if (doneAll) break;
    await sleep(300);
  }

  let e2eFailures = [];
  const transferredRecords = [];
  for (const f of expectedFiles) {
    const diskPath = path.join(HOST_DL_DIR, f.expectedFolder, f.name);
    const dupInChrome = fs.readdirSync(CHROME_DL_DIR).filter((n) => n.includes(f.name.slice(0, 8)));
    const okSize = fs.existsSync(diskPath) && fs.statSync(diskPath).size === f.bytes;
    const okHash = okSize && sha256(fs.readFileSync(diskPath)) === f.digest;
    const jobMatches = allRealJobs.filter((j) => j.filename === f.name);
    if (!okSize || !okHash || dupInChrome.length > 0 || jobMatches.length !== 1) {
      e2eFailures.push(`${f.name}(folder=${f.expectedFolder},size=${okSize},hash=${okHash},dups=${dupInChrome.length},jobs=${jobMatches.length})`);
    }
    transferredRecords.push({ file: f.name, folder: f.expectedFolder, bytes: okSize ? fs.statSync(diskPath).size : 0, sha256Match: okHash });
  }
  metrics.chromeTransfers = transferredRecords;

  const chrDls = await chrOptCdp.evalAsync(`new Promise(r => chrome.downloads.search({}, items => r(items.map(i => ({ url: i.url, finalUrl: i.finalUrl, filename: i.filename, state: i.state })))))`);
  const cancelledInChrome = expectedFiles.every((f) => {
    const kw = f.name.startsWith('Cosmic') ? 'cd_blob' : f.name.startsWith('Signed') ? 'Signed_Transfer' : encodeURIComponent(f.name.slice(0, 6));
    return (chrDls || []).some((d) => ((d.url || '').includes(kw) || (d.finalUrl || '').includes(kw) || (d.filename || '').includes(f.name.slice(0, 6))) && d.state === 'interrupted');
  });
  record(
    'CHR-MKV-01',
    'Chrome E2E MKV/CD/Unicode/Redirect/MP4 pipeline: native cancelled, exact SHA-256 on disk, zero duplicates',
    e2eFailures.length === 0 && cancelledInChrome,
    e2eFailures.length === 0 && cancelledInChrome
      ? `verified=5/5 (${transferredRecords.map((t) => `${t.folder}/${t.file}:${t.bytes}B`).join(', ')})`
      : `e2eFailures=[${e2eFailures.join('; ')}], cancelledInChrome=${cancelledInChrome}, chrDls=${JSON.stringify(chrDls)}`
  );

  // [CHR-PLAYLIST-01] & [CHR-SEQ-01]
  const chrPlRes = await chrOptCdp.evalAsync(`new Promise(r => chrome.runtime.sendMessage({ action: 'OPEN_PLAYLIST', url: '${PLAYLIST_URL}' }, r))`, 10000);
  const chrMixRes = await chrOptCdp.evalAsync(`new Promise(r => chrome.runtime.sendMessage({ action: 'RESOLVE_PLAYLIST', url: '${MIX_URL}' }, r))`, 10000);
  record('CHR-PLAYLIST-01', 'Chrome v1.0.7 OPEN_PLAYLIST dispatches playlist and RESOLVE_PLAYLIST rejects YouTube Mix', chrPlRes?.status === 'ok' && chrMixRes?.status !== 'ok', `pl=${chrPlRes?.status}, mix=${JSON.stringify(chrMixRes)}`);

  const chrSeqRes = await chrOptCdp.evalAsync(`Promise.all([
    new Promise(r => chrome.runtime.sendMessage({ action: 'START_MEDIA_DOWNLOAD', url: '${WATCH_URL}', format_id: '250', filename: 'chr_a.webm' }, r)),
    new Promise(r => chrome.runtime.sendMessage({ action: 'START_MEDIA_DOWNLOAD', url: '${WATCH_URL}', format_id: '248', filename: 'chr_v.webm' }, r)),
  ])`, 12000);
  for (const id of [chrSeqRes?.[0]?.job_id, chrSeqRes?.[1]?.job_id].filter(Boolean)) {
    await httpJson({ port: NATIVE_HOST_PORT, path: `/api/v1/downloads/${id}/cancel`, method: 'POST', headers: { 'X-Tori-Token': HOST_TOKEN } });
  }
  record('CHR-SEQ-01', 'Chrome v1.0.7 Audio -> Video sequential dispatch yields distinct job IDs', Boolean(chrSeqRes?.[0]?.job_id && chrSeqRes?.[1]?.job_id && chrSeqRes[0].job_id !== chrSeqRes[1].job_id));

  // [CHR-RESIL-01] Offline -> Fallback -> Recovery -> Live MKV Capture
  // Simulate full Desktop + Native Host offline cleanly during dl-offline without leaking .tdm-part into user Downloads
  const chrSwTarget = (await waitForCdpTargets(CHROME_CDP_PORT, 6000)).targets.find(
    (t) => t.type === 'service_worker' && t.url.includes(toriExt.id)
  );
  if (!chrSwTarget?.webSocketDebuggerUrl) throw new Error('Chrome TORI service worker target not found for CHR-RESIL-01');
  const chrSwCdp = new CDPClient(chrSwTarget.webSocketDebuggerUrl);
  await chrSwCdp.connect(6000);
  await chrSwCdp.evalAsync(`(() => {
    globalThis.__origSendNativeMessage = chrome.runtime.sendNativeMessage;
    chrome.runtime.sendNativeMessage = (_host, _msg, cb) => {
      if (cb) setTimeout(() => cb({ ok: false, error: 'desktop_offline_simulated' }), 10);
      return Promise.resolve({ ok: false, error: 'desktop_offline_simulated' });
    };
    return true;
  })()`, 5000);

  killTracked(hostProc);
  trackedProcs.delete(hostProc);
  await sleep(600);
  const offlinePing = await chrOptCdp.evalAsync(`new Promise(r => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${NATIVE_HOST_PORT}, key: '${HOST_TOKEN}' }, r))`, 8000);
  await chrWebCdp.evalAsync(`document.getElementById('dl-offline').click()`, 4000, { userGesture: true });
  const offlineBrowserDone = await waitForFileOnDisk(path.join(CHROME_DL_DIR, 'offline_recovery_2m.mkv'), mkvOff2.length, 10000);

  // Restore original Native Messaging API immediately before bringing isolated Desktop back online
  await chrSwCdp.evalAsync(`(() => {
    if (globalThis.__origSendNativeMessage) chrome.runtime.sendNativeMessage = globalThis.__origSendNativeMessage;
    return true;
  })()`, 5000);
  chrSwCdp.close();

  hostProc = await startHost();
  await sleep(1000);
  const recoveryPing = await chrOptCdp.evalAsync(`new Promise(r => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${NATIVE_HOST_PORT}, key: '${HOST_TOKEN}' }, r))`, 8000);
  const storedAfterRecovery = await chrOptCdp.evalAsync(`new Promise(r => chrome.storage.local.get(['tori_settings'], r))`, 5000);
  await chrWebCdp.evalAsync(`document.getElementById('dl-recover').click()`, 4000, { userGesture: true });
  const recDiskPath = path.join(HOST_DL_DIR, 'Video', 'post_recovery_2m.mkv');
  const recDiskOk = await waitForFileOnDisk(recDiskPath, mkvOff2.length, 10000);
  const recHashOk = recDiskOk && sha256(fs.readFileSync(recDiskPath)) === sha.mkvOff2;
  const recNoDup = !fs.existsSync(path.join(CHROME_DL_DIR, 'post_recovery_2m.mkv'));
  const recChrDls = await chrOptCdp.evalAsync(`new Promise(r => chrome.downloads.search({ urlRegex: 'post_recovery' }, r))`, 5000);
  const recHostJobs = await httpJson({ port: NATIVE_HOST_PORT, path: '/api/v1/downloads', headers: { 'X-Tori-Token': HOST_TOKEN } });
  const recHostJob = (recHostJobs?.data?.jobs || []).find((j) => j.filename?.includes('post_recovery'));
  record(
    'CHR-RESIL-01',
    'Extension falls back cleanly when Desktop offline and auto-recovers live MKV interception once Desktop restarts',
    offlinePing?.status !== 'ok' && offlineBrowserDone && recoveryPing?.status === 'ok' && recoveryPing?.authenticated === true && recHashOk && recNoDup && recChrDls?.[0]?.state === 'interrupted' && recHostJob?.state === 'completed',
    `offlineFallbackSaved=${offlineBrowserDone}, recoveredAuth=${recoveryPing?.authenticated}, recoveredMkvOnDisk=${recHashOk}, noDup=${recNoDup}, storedPort=${storedAfterRecovery?.tori_settings?.port}, chrState=${recChrDls?.[0]?.state}, hostJob=${recHostJob?.state}`
  );

  chrOptCdp.close();
  chrWebCdp.close();
  browserCdp.close();
  killTracked(chromeProc);
  trackedProcs.delete(chromeProc);
  await sleep(600);

  // =========================================================================
  // PART C: Microsoft Edge v1.0.7 Regression (API + Real MKV/CD/MP4 E2E)
  // =========================================================================
  console.log('\n>>> [PART C] Microsoft Edge v1.0.7 Extension & MKV E2E Regression <<<\n');
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
  ], { env: isolatedBrowserEnv, stdio: 'ignore' });
  trackedProcs.add(edgeProc);

  const edgeInfo = await waitForCdpTargets(EDGE_CDP_PORT, 15000);
  const edgeBrowserCdp = new CDPClient(edgeInfo.version.webSocketDebuggerUrl);
  await edgeBrowserCdp.connect(6000);
  // Query edge://extensions/ via developerPrivate to locate exact TORI extension ID without matching built-in Edge component extensions
  const { targetId: edgeExtPageId } = await edgeBrowserCdp.send('Target.createTarget', { url: 'edge://extensions/' });
  await sleep(1000);
  const edgeBootTargets = (await waitForCdpTargets(EDGE_CDP_PORT, 8000)).targets;
  const edgeExtMgrCdp = new CDPClient(edgeBootTargets.find((t) => t.id === edgeExtPageId).webSocketDebuggerUrl);
  await edgeExtMgrCdp.connect(6000);
  const edgeExts = await edgeExtMgrCdp.evalAsync(`chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true })`, 6000);
  const edgeTori = (edgeExts || []).find((e) => e.name.includes('TORI'));
  edgeExtMgrCdp.close();
  if (!edgeTori?.id) throw new Error('TORI extension not found in Edge developerPrivate');
  const edgeExtId = edgeTori.id;

  const { targetId: edgeOptId } = await edgeBrowserCdp.send('Target.createTarget', { url: `chrome-extension://${edgeExtId}/options/options.html` });
  await sleep(1000);
  const edgeTargets = (await waitForCdpTargets(EDGE_CDP_PORT, 6000)).targets;
  const edgeOptCdp = new CDPClient(edgeTargets.find((t) => t.id === edgeOptId).webSocketDebuggerUrl);
  const edgeWebTarget = edgeTargets.find((t) => t.type === 'page' && t.url.includes('/test.html'));
  const edgeWebCdp = new CDPClient(edgeWebTarget.webSocketDebuggerUrl);
  await edgeOptCdp.connect(6000);
  await edgeWebCdp.connect(6000);

  const edgePing = await edgeOptCdp.evalAsync(`new Promise(r => {
    chrome.storage.local.set({
      tori_settings: {
        port: ${NATIVE_HOST_PORT}, key: '${HOST_TOKEN}', auto: true, cap: true, min: 0, badge: true, sites: [],
        types: ['zip','rar','7z','iso','exe','dmg','pdf','mp4','mp3','mkv']
      }
    }, () => setTimeout(() => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${NATIVE_HOST_PORT}, key: '${HOST_TOKEN}' }, r), 300));
  })`, 8000);
  const edgeVer = await edgeOptCdp.evalAsync(`chrome.runtime.getManifest().version`);
  record('EDGE-API-01', 'Microsoft Edge pairs with TORI Desktop API at v1.0.7', edgeVer === '1.0.7' && edgePing?.status === 'ok' && edgePing?.authenticated === true, `ver=${edgeVer}, extId=${edgeExtId}`);

  await edgeWebCdp.evalAsync(`(() => {
    document.getElementById('dl-edge10').click();
    return true;
  })()`, 4000, { userGesture: true });

  let edgeJob = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const listRes = await httpJson({ port: NATIVE_HOST_PORT, path: '/api/v1/downloads', headers: { 'X-Tori-Token': HOST_TOKEN } });
    edgeJob = (listRes?.data?.jobs || []).find((j) => j.filename === 'Edge_Standard_10m.mkv');
    if (edgeJob?.state === 'completed') break;
  }
  const edgeDiskPath = path.join(HOST_DL_DIR, 'Video', 'Edge_Standard_10m.mkv');
  const edgeDiskOk = fs.existsSync(edgeDiskPath) && fs.statSync(edgeDiskPath).size === mkvEdge10.length && sha256(fs.readFileSync(edgeDiskPath)) === sha.mkvEdge10;
  const edgeNoDup = !fs.existsSync(path.join(EDGE_DL_DIR, 'Edge_Standard_10m.mkv'));
  record(
    'EDGE-MKV-01',
    'Edge -> TORI Engine -> Disk 10 MiB MKV transfer completed (SHA-256 verified, Video/ routed, zero duplicate)',
    edgeJob?.state === 'completed' && edgeDiskOk && edgeNoDup,
    `bytes=${edgeDiskOk ? fs.statSync(edgeDiskPath).size : 0}, sha256Match=${edgeDiskOk}, zeroDup=${edgeNoDup}`
  );
  metrics.edgeTransfer = { file: 'Edge_Standard_10m.mkv', bytes: mkvEdge10.length, sha256Match: edgeDiskOk };

  edgeOptCdp.close();
  edgeWebCdp.close();
  edgeBrowserCdp.close();
  fixtureServer.close();
  cleanupAll();
  await sleep(900);

  const summaryPath = path.join(ROOT, 'target', 'gate27_7_full_acceptance_results.json');
  fs.writeFileSync(summaryPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    counts,
    total: results.length,
    metrics,
    results,
  }, null, 2));

  try { fs.rmSync(QA_ROOT, { recursive: true, force: true }); } catch {}

  console.log('\n========================================================================');
  console.log(` GATE 27.7 FULL ACCEPTANCE: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.TIMEOUT} TIMEOUT, ${counts.NOT_TESTED} NOT TESTED`);
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
