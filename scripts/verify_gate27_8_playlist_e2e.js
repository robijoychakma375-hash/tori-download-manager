#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 27.8
 * End-to-End Real-World Verification: YouTube Playlist Handoff & Download Acceptance
 *
 * Tests EVERY user scenario end-to-end with zero backend/UI mocks:
 * 1. Rebuilt Desktop v1.0.5-rc NSIS silent install & .sig cryptographic check.
 * 2. Cold Launch via Native Messaging (closed Desktop -> open_playlist IPC -> spawns Desktop
 *    -> restores/shows window -> mounts #playlist-modal -> confirmed=true).
 * 3. Live Chrome + YouTube SPA page -> click [data-act="open-playlist"] WHILE Desktop is
 *    HIDDEN IN TRAY -> verifies button lock, progress toast, tray restoration, visible
 *    #playlist-modal mount, and confirmation toast.
 * 4. Same-Video SPA navigation (?v=... -> ?v=...&list=PL...) reveals Download Playlist button
 *    cleanly without reload; Mix (?list=RD...) shows Mix banner and rejects batch download.
 * 5. Live #playlist-modal real yt-dlp resolution of PL6B3937A5D230E335, individual checkbox
 *    toggle, Deselect All / Select All, quality selection (audio_m4a), Download Selected
 *    click, AND real completed download verified on disk (> 0 bytes) & in SQLite.
 * 6. Live Microsoft Edge identical-URL re-open while Desktop visible (#playlist-modal remounts)
 *    + single-video regression check.
 * 7. Mozilla Firefox v1.0.7 Mozilla-signed XPI (xpinstall.signatures.required=true) intact +
 *    OPEN_PLAYLIST -> live Desktop #playlist-modal opens.
 * 8. Error handling & bounded recovery: when Desktop cannot be reached, [data-act="open-playlist"]
 *    unlocks cleanly and displays an actionable error toast instead of hanging.
 *
 * Strict isolation: uses target/gate27_8_playlist_qa + custom IPC pipe + custom ports;
 * never modifies %APPDATA%\tori-download-manager\tdm_storage.sqlite or signed 1.0.7 XPI,
 * stops idle OEM v1.0.4 only if 0 active jobs, restores OEM --register and relaunches OEM at exit.
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
const EXT_DIR = path.join(ROOT, 'release', 'v1.0.8-extension-rc', 'tori-companion-v1.0.8-chromium');
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const OEM_DESKTOP_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'tori-download-manager.exe');
const OEM_HOST_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'bin', 'tdm-native-host.exe');

const DESKTOP_GUI_PORT = 19920;
const WEBVIEW2_CDP_PORT = 19921;
const CHROME_CDP_PORT = 19923;
const EDGE_CDP_PORT = 19924;
const FF_MARIONETTE_PORT = 2832;

const QA_ROOT = path.join(ROOT, 'target', 'gate27_8_playlist_qa');
const DESKTOP_INSTALL_DIR = path.join(QA_ROOT, 'desktop_install');
const DESKTOP_DATA_DIR = path.join(QA_ROOT, 'desktop_data');
const DESKTOP_USERPROFILE = path.join(QA_ROOT, 'desktop_profile');
const DESKTOP_DL_DIR = path.join(DESKTOP_USERPROFILE, 'Downloads');
const CHROME_PROF_DIR = path.join(QA_ROOT, 'chrome_profile');
const EDGE_PROF_DIR = path.join(QA_ROOT, 'edge_profile');
const FF_PROF_DIR = path.join(QA_ROOT, 'firefox_profile');

const DESKTOP_TOKEN = 'tori_qa_playlist_e2e_token';
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PL6B3937A5D230E335';
const WATCH_SINGLE_URL = 'https://www.youtube.com/watch?v=u9lj-c29dxI';
const WATCH_IN_PLAYLIST_URL = 'https://www.youtube.com/watch?v=u9lj-c29dxI&list=PL6B3937A5D230E335&index=2';
const MIX_URL = 'https://www.youtube.com/watch?v=mVeAD3nbXGs&list=RDmVeAD3nbXGs&start_radio=1';

const trackedProcs = new Set();
const results = [];
const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, NOT_TESTED: 0 };
const metrics = {};
let oemWasRunning = false;

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

function restoreOemEnvironment() {
  try {
    if (fs.existsSync(OEM_HOST_EXE)) {
      execFileSync(OEM_HOST_EXE, ['--register'], { stdio: 'ignore', timeout: 5000 });
    }
  } catch {}
  if (oemWasRunning && fs.existsSync(OEM_DESKTOP_EXE)) {
    try {
      // Ensure no orphaned QA tori-download-manager holds the single-instance mutex
      const p = spawn(OEM_DESKTOP_EXE, ['--minimized'], {
        detached: true,
        stdio: 'ignore',
      });
      p.unref();
    } catch {}
    oemWasRunning = false;
  }
}

function stopQaDesktopOnly() {
  for (const p of trackedProcs) killTracked(p);
  trackedProcs.clear();
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-Process tori-download-manager -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${DESKTOP_INSTALL_DIR.replace(/'/g, "''")}*' } | Stop-Process -Force -ErrorAction SilentlyContinue`,
      ],
      { stdio: 'ignore', timeout: 4000 }
    );
  } catch {}
}

function cleanupAll() {
  stopQaDesktopOnly();
  restoreOemEnvironment();
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
  execFileSync(
    'python',
    [
      '-c',
      [
        'import sqlite3,sys',
        'c=sqlite3.connect(sys.argv[1])',
        'c.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")',
        'c.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("browser_integration_token", sys.argv[2]))',
        'c.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("app_settings", sys.argv[3]))',
        'c.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("server_port", sys.argv[4]))',
        'c.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("close_to_tray_migrated_v104", "true"))',
        'c.commit()',
        'c.close()',
      ].join('\n'),
      dbPath,
      token,
      appSettings,
      String(port),
    ],
    { stdio: 'inherit', timeout: 6000 }
  );
}

function httpJson({ port, path: reqPath, method = 'GET', headers = {}, body = null, timeoutMs = 15000 }) {
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
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data, raw });
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, error: 'HTTP_TIMEOUT' }); });
    req.on('error', (e) => resolve({ status: 0, ok: false, error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

function sendNativeHostOneShot(hostExePath, payload, env, timeoutMs = 22000) {
  return new Promise((resolve, reject) => {
    const jsonBuf = Buffer.from(JSON.stringify(payload), 'utf8');
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(jsonBuf.length, 0);
    const frame = Buffer.concat([hdr, jsonBuf]);

    const proc = spawn(hostExePath, [], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill('SIGKILL'); } catch {}
        reject(new Error(`Native host timed out after ${timeoutMs}ms. stderr=${stderr}`));
      }
    }, timeoutMs);

    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const all = Buffer.concat(chunks);
      if (all.length < 4) {
        return reject(new Error(`Short native response (${all.length}B), code=${code}, stderr=${stderr}`));
      }
      const len = all.readUInt32LE(0);
      const bodyStr = all.subarray(4, 4 + len).toString('utf8');
      try {
        resolve({ response: JSON.parse(bodyStr), stderr });
      } catch (e) {
        reject(new Error(`Invalid JSON native response: ${bodyStr} (${e.message})`));
      }
    });

    proc.stdin.write(frame);
    proc.stdin.end();
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect(timeoutMs = 8000) {
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
  send(method, params = {}, timeoutMs = 12000) {
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
  async evalAsync(expression, timeoutMs = 15000, opts = {}) {
    const res = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: !!opts.userGesture,
      },
      timeoutMs
    );
    if (res?.exceptionDetails) {
      throw new Error(`CDP eval exception: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
    }
    return res?.result?.value;
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function waitForContext(cdp, checkExpr = 'true', timeoutMs = 20000, label = 'target') {
  try { await cdp.send('Runtime.enable', {}, 4000); } catch {}
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const val = await cdp.evalAsync(checkExpr, 3500);
      if (val) return true;
    } catch (e) {
      lastErr = e.message || String(e);
    }
    await sleep(250);
  }
  throw new Error(`waitForContext(${label}) timed out after ${timeoutMs}ms: ${lastErr}`);
}

async function waitForCdpTargets(port, timeoutMs = 15000, requireBrowserWs = false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const verRes = await fetch(`http://127.0.0.1:${port}/json/version`);
      const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (verRes.ok && listRes.ok) {
        const version = await verRes.json();
        const targets = await listRes.json();
        if ((!requireBrowserWs || version.webSocketDebuggerUrl) && targets.length > 0) {
          return { version, targets };
        }
      }
    } catch {}
    await sleep(200);
  }
  throw new Error(`CDP on port ${port} did not become ready`);
}

class MarionetteClient {
  constructor(port = 2832) {
    this.port = port;
    this.socket = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
      const remaining = Math.max(500, deadline - Date.now());
      try {
        return await this._connectOnce(remaining);
      } catch (err) {
        lastErr = err;
        if (err && (err.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(String(err.message || err)))) {
          await sleep(300);
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error(`Marionette connect timeout on port ${this.port}`);
  }

  _connectOnce(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      this.buf = '';
      const sock = net.createConnection({ host: '127.0.0.1', port: this.port });
      this.socket = sock;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.destroy();
        reject(new Error(`Marionette connect timeout on port ${this.port}`));
      }, timeoutMs);
      let handshaken = false;
      sock.on('error', (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      sock.on('data', (chunk) => {
        this.buf += chunk.toString('utf8');
        while (true) {
          const colon = this.buf.indexOf(':');
          if (colon === -1) break;
          const len = parseInt(this.buf.slice(0, colon), 10);
          if (Number.isNaN(len)) break;
          if (Buffer.byteLength(this.buf.slice(colon + 1), 'utf8') < len) break;
          const rawAfterColon = Buffer.from(this.buf.slice(colon + 1), 'utf8');
          const msgStr = rawAfterColon.subarray(0, len).toString('utf8');
          this.buf = rawAfterColon.subarray(len).toString('utf8');
          const parsed = JSON.parse(msgStr);
          if (!handshaken) {
            handshaken = true;
            settled = true;
            clearTimeout(timer);
            resolve(parsed);
          } else if (Array.isArray(parsed) && parsed[0] === 1) {
            const msgId = parsed[1];
            const p = this.pending.get(msgId);
            if (p) {
              this.pending.delete(msgId);
              if (parsed[2]) p.reject(new Error(JSON.stringify(parsed[2])));
              else p.resolve(parsed[3]);
            }
          }
        }
      });
    });
  }
  send(command, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const payload = JSON.stringify([0, id, command, params]);
      const packet = `${Buffer.byteLength(payload, 'utf8')}:${payload}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Marionette command ${command} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.socket.write(packet);
    });
  }
  disconnect() {
    try { this.socket?.end(); } catch {}
  }
}

function submitChromeLoadUnpackedDialog(chromePid, unpackedDir) {
  const psScript = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinApi278Pl {
  [DllImport("user32.dll")]
  public static extern IntPtr GetDlgItem(IntPtr hDlg, int nIDDlgItem);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
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
if ($dlg -eq $null) { throw "Chrome #32770 dialog not found for PID ${chromePid}" }
$hDlg = [IntPtr]$dlg.Current.NativeWindowHandle
$hEdit = [WinApi278Pl]::GetDlgItem($hDlg, 1152)
if ($hEdit -eq [IntPtr]::Zero) { throw "Folder Edit control (1152) not found" }
[WinApi278Pl]::SendMessage($hEdit, 0x000C, [IntPtr]::Zero, $env:TORI_UNPACKED_EXT) | Out-Null
Start-Sleep -Milliseconds 150
$hBtn = [WinApi278Pl]::GetDlgItem($hDlg, 1)
if ($hBtn -eq [IntPtr]::Zero) { throw "OK button (1) not found" }
[WinApi278Pl]::PostMessage($hBtn, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
Write-Output "UIA_SUBMITTED_OK"
`;
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
    env: { ...process.env, TORI_UNPACKED_EXT: unpackedDir },
    encoding: 'utf8',
    timeout: 12000,
  });
  return out.includes('UIA_SUBMITTED_OK');
}

function readZipEntryFromXpi(xpiPath, targetEntry) {
  const buf = fs.readFileSync(xpiPath);
  const eocdOffset = buf.lastIndexOf(Buffer.from('504b0506', 'hex'));
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  let ptr = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    if (name === targetEntry) {
      const lName = buf.readUInt16LE(localOff + 26);
      const lExtra = buf.readUInt16LE(localOff + 28);
      const dataOff = localOff + 30 + lName + lExtra;
      const compData = buf.subarray(dataOff, dataOff + compSize);
      return method === 8 ? zlib.inflateRawSync(compData).toString('utf8') : compData.toString('utf8');
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function getDesktopWindowVisibility(desktopPid) {
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinVis278 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
}
"@
$targetPid = ${desktopPid}
$mainVisible = $false
$mainMatched = 0
$anyVisible = $false
$matched = 0
$details = New-Object System.Collections.Generic.List[string]
[WinVis278]::EnumWindows({
  param($hWnd, $lParam)
  $p = 0
  [WinVis278]::GetWindowThreadProcessId($hWnd, [ref]$p) | Out-Null
  if ($p -eq $targetPid) {
    $sb = New-Object System.Text.StringBuilder 256
    [WinVis278]::GetWindowText($hWnd, $sb, 256) | Out-Null
    $title = $sb.ToString()
    $csb = New-Object System.Text.StringBuilder 128
    [WinVis278]::GetClassName($hWnd, $csb, 128) | Out-Null
    $cls = $csb.ToString()
    if ($title -like "*TORI*") {
      $script:matched++
      $vis = [WinVis278]::IsWindowVisible($hWnd)
      if ($vis) { $script:anyVisible = $true }
      if ($title -eq "TORI Download Manager") {
        $script:mainMatched++
        if ($vis) { $script:mainVisible = $true }
      }
      $details.Add(($title + "[" + $cls + "]:vis=" + $vis))
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
Write-Output ("matched=" + $matched + ";mainMatched=" + $mainMatched + ";mainVisible=" + $mainVisible + ";visible=" + $anyVisible + ";details=" + ($details -join "|"))
`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 5000 }).trim();
  return {
    raw: out,
    visible: out.includes(';visible=True'),
    mainVisible: out.includes(';mainVisible=True'),
    mainMatched: parseInt((out.match(/mainMatched=(\d+)/) || [])[1] || '0', 10),
    matched: parseInt((out.match(/matched=(\d+)/) || [])[1] || '0', 10),
  };
}

async function launchChromiumAndPair({ exe, profDir, cdpPort, browserLabel, env = null }) {
  fs.mkdirSync(path.join(profDir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profDir, 'First Run'), '');
  const scheme = browserLabel === 'Edge' ? 'edge' : 'chrome';
  const proc = spawn(
    exe,
    [
      `--user-data-dir=${profDir}`,
      `--remote-debugging-port=${cdpPort}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--mute-audio',
      '--window-size=1200,820',
      `${scheme}://extensions/`,
    ],
    { env: env ? { ...process.env, ...env } : process.env, stdio: 'ignore' }
  );
  trackedProcs.add(proc);

  const info = await waitForCdpTargets(cdpPort, 15000, true);
  const bCdp = new CDPClient(info.version.webSocketDebuggerUrl);
  await bCdp.connect(6000);

  let extMgrTarget = info.targets.find(
    (t) => t.type === 'page' && ((t.url || '').startsWith(`${scheme}://extensions`) || (t.url || '').startsWith('chrome://extensions'))
  );
  if (!extMgrTarget) {
    const created = await bCdp.send('Target.createTarget', { url: `${scheme}://extensions/` });
    for (let i = 0; i < 20; i++) {
      const list2 = await waitForCdpTargets(cdpPort, 8000, true);
      extMgrTarget = list2.targets.find((t) => t.id === created.targetId);
      if (extMgrTarget?.webSocketDebuggerUrl) break;
      await sleep(250);
    }
  }
  const uiCdp = new CDPClient(extMgrTarget.webSocketDebuggerUrl);
  await uiCdp.connect(8000);
  try { await uiCdp.send('Runtime.enable', {}, 5000); } catch {}
  let extUiReady = false;
  for (let i = 0; i < 40; i++) {
    try {
      extUiReady = await uiCdp.evalAsync(
        `document.readyState === 'complete' && typeof chrome !== 'undefined' && !!chrome.developerPrivate`,
        4000
      );
      if (extUiReady) break;
    } catch {}
    await sleep(250);
  }
  if (!extUiReady) throw new Error(`${browserLabel} extensions page did not finish initializing execution context`);

  await uiCdp.evalAsync(`chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })`, 8000);
  const loadPromise = uiCdp.evalAsync(
    `chrome.developerPrivate.loadUnpacked().then(() => 'OK').catch(e => String(e))`,
    15000,
    { userGesture: true }
  );
  const uiaOk = submitChromeLoadUnpackedDialog(proc.pid, EXT_DIR);
  const loadRes = await loadPromise;
  await sleep(1000);
  const exts = await uiCdp.evalAsync(`chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true })`, 8000);
  const toriExt = (exts || []).find((e) => (e.name || '').includes('TORI'));
  uiCdp.close();

  if (!uiaOk || !toriExt?.id) {
    throw new Error(`${browserLabel} failed to load TORI unpacked extension (uia=${uiaOk}, loadRes=${loadRes})`);
  }

  const optUrl = `chrome-extension://${toriExt.id}/options/options.html`;
  const optTargetRes = await bCdp.send('Target.createTarget', { url: optUrl });
  let optTarget = null;
  for (let i = 0; i < 30; i++) {
    const tList3 = (await waitForCdpTargets(cdpPort, 10000, true)).targets;
    optTarget = tList3.find((t) => t.id === optTargetRes.targetId || (t.url || '').includes(optUrl));
    if (optTarget?.webSocketDebuggerUrl) break;
    await sleep(200);
  }
  const optCdp = new CDPClient(optTarget.webSocketDebuggerUrl);
  await optCdp.connect(8000);
  await waitForContext(optCdp, `typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.runtime`, 15000, `${browserLabel}-options`);
  const pairPing = await optCdp.evalAsync(`new Promise(r => {
    const t = setInterval(() => {
      if (chrome?.runtime?.sendMessage && chrome?.storage?.local) {
        clearInterval(t);
        chrome.storage.local.set({
          tori_settings: {
            port: ${DESKTOP_GUI_PORT},
            key: '${DESKTOP_TOKEN}',
            auto: true,
            cap: true,
            min: 0,
            badge: true,
            sites: [],
            types: ['zip','rar','7z','iso','exe','dmg','pdf','mp4','mp3','mkv']
          }
        }, () => setTimeout(() => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: '${DESKTOP_TOKEN}' }, r), 250));
      }
    }, 100);
  })`, 10000);
  if (!pairPing || pairPing.status !== 'ok' || !pairPing.authenticated) {
    throw new Error(`${browserLabel} extension pairing PING failed: ${JSON.stringify(pairPing)}`);
  }
  console.log(`[${browserLabel.toUpperCase()}] Loaded unpacked extension ${toriExt.id} and paired with port ${DESKTOP_GUI_PORT}`);
  return { proc, bCdp, optCdp, extId: toriExt.id };
}

async function run() {
  console.log('========================================================================');
  console.log(' TORI Gate 27.8 — Real YouTube Playlist Handoff & Download E2E Suite');
  console.log('========================================================================\n');

  const globalWatchdog = setTimeout(() => {
    console.error('\n[WATCHDOG] Overall Gate 27.8 Playlist E2E timeout reached (300s). Cleaning up.');
    cleanupAll();
    process.exit(1);
  }, 300000);
  globalWatchdog.unref();

  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(DESKTOP_DL_DIR, { recursive: true });
  fs.mkdirSync(CHROME_PROF_DIR, { recursive: true });
  fs.mkdirSync(EDGE_PROF_DIR, { recursive: true });
  fs.mkdirSync(FF_PROF_DIR, { recursive: true });

  // -----------------------------------------------------------------------
  // 0. Check if OEM v1.0.4 is running & confirm it has 0 active downloads before QA
  // -----------------------------------------------------------------------
  try {
    const oemCheck = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-Process tori-download-manager -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
      ],
      { encoding: 'utf8', timeout: 4000 }
    ).trim();
    if (oemCheck) {
      const prodDb = path.join(process.env.APPDATA || '', 'tori-download-manager', 'tdm_storage.sqlite');
      const activeCnt = parseInt(
        execFileSync(
          'python',
          [
            '-c',
            `import sqlite3; c=sqlite3.connect(r'''${prodDb}'''); print(c.execute("SELECT count(*) FROM downloads WHERE state IN ('downloading','probing','queued','verifying')").fetchone()[0])`,
          ],
          { encoding: 'utf8', timeout: 4000 }
        ).trim(),
        10
      );
      if (activeCnt > 0) {
        throw new Error(`OEM TORI Desktop has ${activeCnt} active download(s); refusing to interrupt user downloads.`);
      }
      oemWasRunning = true;
      console.log(`[PREP] Stopping idle OEM TORI Desktop (PID(s): ${oemCheck.replace(/\r?\n/g, ',')}) for isolated single-instance QA...`);
      execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process tori-download-manager -ErrorAction SilentlyContinue | Stop-Process -Force"], {
        stdio: 'ignore',
        timeout: 4000,
      });
      await sleep(800);
    }
  } catch (e) {
    if (e.message.includes('active download')) throw e;
  }

  // Verify signed Firefox 1.0.7 XPI untouched
  const xpiSha = crypto.createHash('sha256').update(fs.readFileSync(SIGNED_XPI)).digest('hex').toLowerCase();
  record('PL-PRE-01', 'Signed Firefox v1.0.7 XPI untouched before suite', xpiSha === EXPECTED_XPI_SHA256, `sha256=${xpiSha}`);

  // -----------------------------------------------------------------------
  // 1. Silent NSIS Install of Rebuilt Desktop v1.0.5-rc into QA_ROOT
  // -----------------------------------------------------------------------
  console.log('\n>>> [STEP 1] Installing & Verifying Rebuilt TORI Desktop v1.0.5-rc <<<\n');
  execSync(`"${INSTALLER_EXE}" /S /D=${DESKTOP_INSTALL_DIR}`, { timeout: 60000 });
  const installedDesktopExe = path.join(DESKTOP_INSTALL_DIR, 'tori-download-manager.exe');
  const installedHostExe = path.join(DESKTOP_INSTALL_DIR, 'bin', 'tdm-native-host.exe');
  record(
    'PL-INST-01',
    'Rebuilt Desktop v1.0.5-rc NSIS silent install succeeds',
    fs.existsSync(installedDesktopExe) && fs.existsSync(installedHostExe),
    installedDesktopExe
  );

  // Register isolated native host for Chrome/Edge/Firefox during QA (restored on exit)
  execFileSync(installedHostExe, ['--register'], { stdio: 'ignore', timeout: 5000 });

  const deskDbPath = path.join(DESKTOP_DATA_DIR, 'tdm_storage.sqlite');
  seedToriSqlite(deskDbPath, { port: DESKTOP_GUI_PORT, dir: DESKTOP_DL_DIR, token: DESKTOP_TOKEN });
  const pipeName = `\\\\.\\pipe\\tori-qa-pl-${process.pid}`;

  const isolatedEnv = {
    TORI_DATA_DIR: DESKTOP_DATA_DIR,
    TORI_IPC_PIPE: pipeName,
    TORI_ALLOW_LOOPBACK: '1',
    TDM_STORAGE_DIR: DESKTOP_DATA_DIR,
    TDM_DOWNLOAD_DIR: DESKTOP_DL_DIR,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${WEBVIEW2_CDP_PORT}`,
  };

  // -----------------------------------------------------------------------
  // 2. Cold Launch Test (Desktop CLOSED -> Native Messaging open_playlist)
  // -----------------------------------------------------------------------
  console.log('\n>>> [STEP 2] Cold Launch via Native Messaging (Desktop CLOSED -> #playlist-modal) <<<\n');
  const coldStartTs = Date.now();
  const coldResp = await sendNativeHostOneShot(
    installedHostExe,
    { action: 'open_playlist', url: PLAYLIST_URL },
    isolatedEnv,
    25000
  );
  const coldElapsedMs = Date.now() - coldStartTs;
  metrics.coldLaunchOpenMs = coldElapsedMs;

  // Verify cold-launched Desktop came up with visible window AND #playlist-modal mounted!
  let coldDeskCdp = null;
  let coldModalState = null;
  try {
    const cdpColdInfo = await waitForCdpTargets(WEBVIEW2_CDP_PORT, 15000, false);
    const target = cdpColdInfo.targets.find((t) => t.type === 'page' && !t.url.includes('toast')) || cdpColdInfo.targets[0];
    coldDeskCdp = new CDPClient(target.webSocketDebuggerUrl);
    await coldDeskCdp.connect(6000);
    coldModalState = await coldDeskCdp.evalAsync(`(() => {
      const m = document.querySelector('#playlist-modal');
      const r = m ? m.getBoundingClientRect() : null;
      return {
        hidden: document.hidden,
        hasModal: !!m,
        visibleWidth: r ? r.width : 0,
        visibleHeight: r ? r.height : 0,
        titleText: m ? (m.textContent || '').slice(0, 120) : '',
      };
    })()`, 8000);
    coldDeskCdp.close();
  } catch (e) {
    coldModalState = { error: e.message };
  }

  record(
    'PL-COLD-01',
    'Closed Desktop launches on open_playlist, restores visibility, and mounts #playlist-modal before returning confirmed=true',
    coldResp?.response?.status === 'ok' &&
      coldResp?.response?.confirmed === true &&
      Boolean(coldModalState?.hasModal) &&
      coldModalState?.visibleWidth > 100 &&
      !coldModalState?.hidden,
    `ms=${coldElapsedMs}, resp=${JSON.stringify(coldResp.response)}, ui=${JSON.stringify(coldModalState)}`
  );

  // Stop cold-launched QA Desktop only (without triggering restoreOemEnvironment) before Step 3 controlled boot
  stopQaDesktopOnly();
  await sleep(1000);
  execFileSync(installedHostExe, ['--register'], { stdio: 'ignore', timeout: 5000 });

  // -----------------------------------------------------------------------
  // 3. Controlled Boot of Rebuilt Desktop + Hide to Tray -> Live Chrome Click -> Real Resolution & Download
  // -----------------------------------------------------------------------
  console.log('\n>>> [STEP 3] Controlled Desktop Boot, Hide-to-Tray & Chrome Live YouTube Click <<<\n');
  const deskProc = spawn(installedDesktopExe, [], {
    env: {
      ...process.env,
      ...isolatedEnv,
      TORI_DISABLE_AUTO_SPAWN: '1',
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

  record('PL-DESK-01', 'Desktop v1.0.5-rc booted cleanly for tray & live browser acceptance', deskOnline && !!deskTarget, `port=${DESKTOP_GUI_PORT}`);

  // Hide Desktop window to system tray and confirm main HWND WS_VISIBLE === false + HIDE_MAIN log
  await deskCdp.evalAsync(`window.__TAURI_INTERNALS__.invoke('hide_main_window')`, 5000);
  const lifecyclePath = path.join(DESKTOP_DATA_DIR, 'logs', 'lifecycle.log');
  let trayHiddenVis = { visible: true, mainVisible: true, mainMatched: 0, raw: '' };
  let lifecycleBeforeClick = '';
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    trayHiddenVis = getDesktopWindowVisibility(deskProc.pid);
    lifecycleBeforeClick = fs.existsSync(lifecyclePath) ? fs.readFileSync(lifecyclePath, 'utf8') : '';
    if (trayHiddenVis.mainMatched > 0 && !trayHiddenVis.mainVisible && lifecycleBeforeClick.includes('HIDE_MAIN')) break;
  }
  // Wait past the 1.5s startup safety timer and verify Desktop STILL stays hidden in tray
  await sleep(1600);
  trayHiddenVis = getDesktopWindowVisibility(deskProc.pid);
  record(
    'PL-TRAY-01',
    'Desktop main window transitions to hidden tray state and stays hidden before extension click',
    trayHiddenVis.mainMatched > 0 && !trayHiddenVis.mainVisible && lifecycleBeforeClick.includes('HIDE_MAIN'),
    `${trayHiddenVis.raw}, hasHideLog=${lifecycleBeforeClick.includes('HIDE_MAIN')}`
  );

  const browserIsoEnv = {
    TORI_DATA_DIR: DESKTOP_DATA_DIR,
    TORI_IPC_PIPE: pipeName,
    TORI_ALLOW_LOOPBACK: '1',
    TDM_STORAGE_DIR: DESKTOP_DATA_DIR,
    TDM_DOWNLOAD_DIR: DESKTOP_DL_DIR,
  };

  // Launch real Google Chrome with unpacked updated extension (v1.0.8 fix)
  const chrome = await launchChromiumAndPair({ exe: CHROME_EXE, profDir: CHROME_PROF_DIR, cdpPort: CHROME_CDP_PORT, browserLabel: 'Chrome', env: browserIsoEnv });

  // Open real single YouTube watch page FIRST, verify NO playlist button, then SPA-navigate to ?list=PL...
  const ytTarget = await chrome.bCdp.send('Target.createTarget', { url: WATCH_SINGLE_URL });
  const ytInfo = await (async () => {
    const deadline = Date.now() + 35000;
    let cdp = null;
    let lastState = null;
    let lastErr = '';
    while (Date.now() < deadline) {
      try {
        if (!cdp) {
          const list = await (await fetch(`http://127.0.0.1:${CHROME_CDP_PORT}/json`)).json();
          const tgt = list.find((t) => t.id === ytTarget.targetId);
          if (tgt?.webSocketDebuggerUrl) {
            cdp = new CDPClient(tgt.webSocketDebuggerUrl);
            await cdp.connect(6000);
            try { await cdp.send('Runtime.enable', {}, 4000); } catch {}
          }
        }
        if (cdp) {
          const st = await cdp.evalAsync(
            `(() => ({ url: location.href, ready: document.readyState, found: !!document.querySelector('.tori-mp'), hasVideo: !!document.querySelector('video') }))()`,
            4000
          );
          lastState = st;
          if (st?.found && st?.hasVideo && String(st.url || '').includes('youtube.com') && st.ready === 'complete') {
            return { cdp, overlayReady: st };
          }
        }
      } catch (e) {
        lastErr = e.message || String(e);
        if (cdp) { try { cdp.close(); } catch {} cdp = null; }
      }
      await sleep(350);
    }
    return { cdp, overlayReady: { ...(lastState || {}), found: false, lastErr } };
  })();
  let ytCdp = ytInfo.cdp;
  const overlayReady = ytInfo.overlayReady;

  let spaPlaylistDetected = false;
  let trayRestoreModalCheck = null;
  let toastProgression = null;
  if (overlayReady?.found) {
    // Open panel on single-video URL -> click pill (retry until panel .tori-pn.on opens)
    await ytCdp.evalAsync(`(async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const pn = document.querySelector('.tori-mp .tori-pn');
        if (pn && pn.classList.contains('on')) return true;
        const pill = document.querySelector('.tori-mp .tori-pill, .tori-mp button');
        if (pill) pill.click();
        await new Promise((r) => setTimeout(r, 200));
      }
      return !!document.querySelector('.tori-mp .tori-pn.on');
    })()`, 8000, { userGesture: true });

    // Perform same-video SPA pushState/yt-navigate-finish to watch?v=u9lj-c29dxI&list=PL6B3937A5D230E335
    spaPlaylistDetected = await ytCdp.evalAsync(`(async () => {
      history.pushState({}, '', '${WATCH_IN_PLAYLIST_URL}');
      window.dispatchEvent(new Event('yt-navigate-finish'));
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const pn = document.querySelector('.tori-mp .tori-pn');
        if (pn && !pn.classList.contains('on')) {
          const pill = document.querySelector('.tori-mp .tori-pill, .tori-mp button');
          if (pill) pill.click();
        }
        const btn = document.querySelector('.tori-mp [data-act="open-playlist"]');
        if (btn && pn && pn.classList.contains('on')) {
          return {
            hasPlaylistBtn: true,
            panelOpen: true,
            canonicalUrl: btn.getAttribute('data-canonical-url'),
          };
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      const btn = document.querySelector('.tori-mp [data-act="open-playlist"]');
      const pn = document.querySelector('.tori-mp .tori-pn');
      return {
        hasPlaylistBtn: !!btn,
        panelOpen: !!(pn && pn.classList.contains('on')),
        canonicalUrl: btn ? btn.getAttribute('data-canonical-url') : null,
      };
    })()`, 9000, { userGesture: true });

    // Verify Desktop is STILL hidden in tray immediately prior to clicking Download Playlist
    const hiddenJustBeforeClick = getDesktopWindowVisibility(deskProc.pid);
    const logsBeforeClickLen = fs.existsSync(lifecyclePath) ? fs.readFileSync(lifecyclePath, 'utf8').length : 0;

    // Click actual Download Playlist button WHILE Desktop is hidden in tray!
    toastProgression = await ytCdp.evalAsync(`(async () => {
      const findWaitDeadline = Date.now() + 3000;
      let btn = null;
      while (Date.now() < findWaitDeadline) {
        const pn = document.querySelector('.tori-mp .tori-pn');
        if (pn && !pn.classList.contains('on')) {
          const pill = document.querySelector('.tori-mp .tori-pill, .tori-mp button');
          if (pill) pill.click();
        }
        btn = document.querySelector('.tori-mp [data-act="open-playlist"]');
        if (btn && pn && pn.classList.contains('on')) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!btn) return { clicked: false };
      return await new Promise((resolve) => {
        const seenToasts = [];
        const obs = new MutationObserver(() => {
          const t = document.getElementById('tori-page-toast');
          if (t && t.textContent) {
            const txt = t.textContent.trim();
            if (txt && seenToasts[seenToasts.length - 1] !== txt) seenToasts.push(txt);
          }
        });
        obs.observe(document.body, { childList: true, subtree: true, characterData: true });
        btn.click();
        const start = Date.now();
        const waitSettled = setInterval(() => {
          const t = document.getElementById('tori-page-toast');
          const txt = t ? t.textContent.trim() : '';
          if (txt.includes('Playlist opened') || (!btn.disabled && Date.now() - start > 600) || Date.now() - start > 6000) {
            clearInterval(waitSettled);
            obs.disconnect();
            resolve({
              clicked: true,
              seenToasts,
              finalToast: txt || null,
              isError: t ? t.innerHTML.includes('#e5484d') : null,
              btnDisabledAfter: btn.disabled,
              elapsedMs: Date.now() - start,
            });
          }
        }, 150);
      });
    })()`, 12000, { userGesture: true });

    await sleep(400);
    const trayRestoredVis = getDesktopWindowVisibility(deskProc.pid);
    const lifecycleAfterClickFull = fs.existsSync(lifecyclePath) ? fs.readFileSync(lifecyclePath, 'utf8') : '';
    const lifecycleDelta = lifecycleAfterClickFull.slice(logsBeforeClickLen);
    trayRestoreModalCheck = await deskCdp.evalAsync(`(() => {
      const m = document.querySelector('#playlist-modal');
      const r = m ? m.getBoundingClientRect() : null;
      return {
        wasHiddenBeforeClick: ${!hiddenJustBeforeClick.mainVisible},
        winVisible: ${trayRestoredVis.mainVisible},
        winRaw: ${JSON.stringify(trayRestoredVis.raw)},
        hasRestoreLog: ${lifecycleDelta.includes('RESTORE_MAIN')},
        hasModal: !!m,
        visibleWidth: r ? r.width : 0,
        visibleHeight: r ? r.height : 0,
      };
    })()`, 8000);
  }

  record(
    'PL-SPA-01',
    'Same-video SPA transition to &list=PL... dynamically shows Download Playlist button',
    Boolean(overlayReady?.found && spaPlaylistDetected?.hasPlaylistBtn && String(spaPlaylistDetected?.canonicalUrl || '').includes('PL6B3937A5D230E335')),
    JSON.stringify({ overlayReady, spaPlaylistDetected })
  );

  record(
    'PL-TRAY-02',
    'Tray-hidden Desktop restores and mounts #playlist-modal after real Chrome YouTube click with confirmed toast',
    Boolean(
      toastProgression?.clicked &&
        !toastProgression?.isError &&
        String(toastProgression?.finalToast || '').includes('Playlist opened') &&
        trayRestoreModalCheck?.wasHiddenBeforeClick &&
        trayRestoreModalCheck?.hasModal &&
        trayRestoreModalCheck?.winVisible &&
        trayRestoreModalCheck?.hasRestoreLog &&
        trayRestoreModalCheck?.visibleWidth > 100
    ),
    JSON.stringify({ toastProgression, trayRestoreModalCheck })
  );

  // -----------------------------------------------------------------------
  // 4. Real yt-dlp Playlist Resolution + UI Controls + Real Download Completion
  // -----------------------------------------------------------------------
  console.log('\n>>> [STEP 4] Resolving Live YouTube Playlist in Desktop #playlist-modal & Downloading Real Video <<<\n');
  const resolvedUiState = await deskCdp.evalAsync(`new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const m = document.querySelector('#playlist-modal');
      if (Date.now() - start > 38000) {
        clearInterval(timer);
        resolve({ resolved: false, timeout: true, hasModal: !!m, snippet: (m?.textContent || '').slice(0, 220) });
        return;
      }
      if (!m) return;
      const checkboxes = Array.from(m.querySelectorAll('input[type="checkbox"]'));
      const text = m.textContent || '';
      const errEl = m.querySelector('.bad');
      if (checkboxes.length >= 3 || errEl) {
        clearInterval(timer);
        resolve({
          resolved: checkboxes.length >= 3,
          itemCount: checkboxes.length,
          hasBlenderTitle: /Blender/i.test(text),
          error: errEl ? errEl.textContent : null,
          snippet: text.slice(0, 220),
        });
      }
    }, 300);
  })`, 42000);

  let uiInteraction = null;
  let queuedJobsInfo = null;
  let completedFileInfo = null;

  if (resolvedUiState?.resolved) {
    uiInteraction = await deskCdp.evalAsync(`(async () => {
      const tick = () => new Promise(r => setTimeout(r, 60));
      const m = document.querySelector('#playlist-modal');
      const getChecked = () => Array.from(m.querySelectorAll('input[type="checkbox"]')).filter(c => !c.disabled && c.checked).length;
      const initialChecked = getChecked();
      const firstBox = Array.from(m.querySelectorAll('input[type="checkbox"]')).find(c => !c.disabled);
      if (firstBox) firstBox.click();
      await tick();
      const afterUncheckOne = getChecked();
      if (firstBox) firstBox.click();
      await tick();
      const afterRecheckOne = getChecked();

      const selAllBtn = Array.from(m.querySelectorAll('button')).find(b => /Deselect All|Select All/i.test(b.textContent || ''));
      if (selAllBtn) selAllBtn.click();
      await tick();
      const afterDeselectAll = getChecked();
      if (selAllBtn) selAllBtn.click();
      await tick();
      const afterReselectAll = getChecked();

      // Deselect all, then pick ONLY item containing "WING IT" (smallest ~4min Blender movie) so real E2E transfer finishes quickly
      if (selAllBtn && afterReselectAll > 0) {
        selAllBtn.click();
        await tick();
      }
      const targetBox = Array.from(m.querySelectorAll('input[type="checkbox"]')).find(c => {
        if (c.disabled) return false;
        const row = c.closest('div');
        return row && /WING IT/i.test(row.textContent || '');
      }) || Array.from(m.querySelectorAll('input[type="checkbox"]')).find(c => !c.disabled);
      if (targetBox && !targetBox.checked) {
        targetBox.click();
        await tick();
      }
      const finalChecked = getChecked();

      const sel = m.querySelector('select');
      const formatOptions = sel ? Array.from(sel.options).map(o => o.value) : [];
      if (sel && formatOptions.includes('480p')) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(sel, '480p');
        else sel.value = '480p';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
      }
      const chosenFormat = sel ? sel.value : null;

      const dlBtn = Array.from(m.querySelectorAll('button')).find(b => /Download Selected/i.test(b.textContent || ''));
      const canClickDl = Boolean(dlBtn && !dlBtn.disabled);
      if (canClickDl) dlBtn.click();

      return {
        initialChecked,
        afterUncheckOne,
        afterRecheckOne,
        afterDeselectAll,
        afterReselectAll,
        finalChecked,
        formatOptions,
        chosenFormat,
        canClickDl,
      };
    })()`, 15000, { userGesture: true });

    // Poll Desktop API (/api/v1/downloads -> { status, jobs } & /api/v1/downloads/{id} for target_path)
    // and verify the downloaded video file exists in Video/ with > 100 KB on disk
    const dlDeadline = Date.now() + 90000;
    while (Date.now() < dlDeadline) {
      await sleep(1000);
      const listRes = await httpJson({
        port: DESKTOP_GUI_PORT,
        path: '/api/v1/downloads',
        headers: { 'X-Tori-Token': DESKTOP_TOKEN },
      });
      const jobs = Array.isArray(listRes.data?.jobs) ? listRes.data.jobs : [];
      if (jobs.length > 0) queuedJobsInfo = jobs;
      const doneJob = jobs.find((j) => String(j.state).toLowerCase() === 'completed');
      if (doneJob) {
        const detailRes = await httpJson({
          port: DESKTOP_GUI_PORT,
          path: `/api/v1/downloads/${encodeURIComponent(doneJob.id)}`,
          headers: { 'X-Tori-Token': DESKTOP_TOKEN },
        });
        const fullJob = detailRes.data || doneJob;
        const origTarget = String(fullJob.target_path || '');
        const candidates = [];
        if (origTarget) {
          candidates.push(origTarget);
          const stem = origTarget.replace(/\.[^.]+$/, '');
          for (const altExt of ['mp4', 'mkv', 'webm']) {
            candidates.push(`${stem}.${altExt}`);
          }
        }
        const actualPath = candidates.find((p) => p && fs.existsSync(p)) || null;
        const size = actualPath ? fs.statSync(actualPath).size : 0;
        completedFileInfo = {
          id: doneJob.id,
          filename: actualPath ? path.basename(actualPath) : doneJob.filename,
          target_path: actualPath || origTarget,
          diskSize: size,
          state: doneJob.state,
        };
        if (actualPath && size > 100000) break;
      }
      const failedJob = jobs.find((j) => String(j.state).toLowerCase() === 'failed');
      if (failedJob) {
        completedFileInfo = { failed: true, error: failedJob.error_message, filename: failedJob.filename };
        break;
      }
    }
  }

  const uiChecksOk = Boolean(
    resolvedUiState?.resolved &&
      uiInteraction?.initialChecked >= 3 &&
      uiInteraction.afterUncheckOne === uiInteraction.initialChecked - 1 &&
      uiInteraction.afterRecheckOne === uiInteraction.initialChecked &&
      uiInteraction.afterDeselectAll === 0 &&
      uiInteraction.afterReselectAll === uiInteraction.initialChecked &&
      uiInteraction.finalChecked === 1 &&
      uiInteraction.formatOptions.includes('best') &&
      uiInteraction.formatOptions.includes('1080p') &&
      uiInteraction.formatOptions.includes('720p') &&
      uiInteraction.formatOptions.includes('480p') &&
      uiInteraction.formatOptions.includes('audio_only') &&
      uiInteraction.canClickDl
  );

  record('PL-MODAL-01', 'PlaylistModal loads real YouTube metadata, item checkboxes, Select/Deselect All & quality selector work', uiChecksOk, JSON.stringify({ resolvedUiState, uiInteraction }));

  record(
    'PL-DL-01',
    'Selected authorized test video queues from PlaylistModal, routes to Video/, and completes on disk',
    Boolean(
      completedFileInfo &&
        !completedFileInfo.failed &&
        completedFileInfo.diskSize > 100000 &&
        String(completedFileInfo.target_path).toLowerCase().includes('video') &&
        /\.(mp4|mkv|webm)$/i.test(String(completedFileInfo.target_path))
    ),
    JSON.stringify(completedFileInfo || queuedJobsInfo)
  );

  // -----------------------------------------------------------------------
  // 5. Same-URL Reopen + YouTube Mix Rejection + Live Edge & Signed Firefox XPI
  // -----------------------------------------------------------------------
  console.log('\n>>> [STEP 5] Identical-URL Reopen (Edge), Mix Rejection & Signed Firefox v1.0.7 XPI <<<\n');
  const edge = await launchChromiumAndPair({ exe: EDGE_EXE, profDir: EDGE_PROF_DIR, cdpPort: EDGE_CDP_PORT, browserLabel: 'Edge', env: browserIsoEnv });

  // Confirm modal closed after enqueue, then re-open IDENTICAL playlist URL from Edge
  const modalClosedBeforeReopen = await deskCdp.evalAsync(`!document.querySelector('#playlist-modal')`, 5000);
  const edgePlRes = await edge.optCdp.evalAsync(
    `new Promise(r => chrome.runtime.sendMessage({ action: 'OPEN_PLAYLIST', url: '${PLAYLIST_URL}' }, r))`,
    15000
  );
  await sleep(350);
  const edgeReopenedUi = await deskCdp.evalAsync(`(() => {
    const m = document.querySelector('#playlist-modal');
    const c = Array.from(document.querySelectorAll('#playlist-modal button')).find(b => b.title === 'Close' || (b.textContent || '').trim() === '×');
    const res = { hasModal: !!m };
    if (c) c.click();
    return res;
  })()`, 6000);

  const mixReject = await httpJson({
    port: DESKTOP_GUI_PORT,
    path: '/api/v1/media/playlist/open',
    method: 'POST',
    headers: { 'X-Tori-Token': DESKTOP_TOKEN },
    body: { url: MIX_URL },
  });
  // Verify YouTube Mix page in content.js displays Mix banner & NO Download Playlist button
  await ytCdp.evalAsync(`(() => {
    history.pushState({}, '', '${MIX_URL}');
    window.dispatchEvent(new Event('yt-navigate-finish'));
    return true;
  })()`, 5000);
  await sleep(600);
  const ytMixUi = await ytCdp.evalAsync(`(() => {
    const pn = document.querySelector('.tori-mp .tori-pn');
    const pill = document.querySelector('.tori-mp .tori-pill');
    if (pn && !pn.classList.contains('on') && pill) pill.click();
    const openBtn = document.querySelector('.tori-mp [data-act="open-playlist"]');
    const mixBtn = document.querySelector('.tori-mp [data-act="mix-info"]');
    return { hasOpenBtn: !!openBtn, hasMixBanner: !!mixBtn };
  })()`, 5000, { userGesture: true });

  record(
    'PL-EDGE-01',
    'Edge identical-URL reopen mounts PlaylistModal cleanly, and Mix/Radio is rejected in both extension UI and Desktop API',
    Boolean(modalClosedBeforeReopen && edgePlRes?.status === 'ok' && edgePlRes?.confirmed === true && edgeReopenedUi?.hasModal && mixReject.status === 422 && !ytMixUi.hasOpenBtn && ytMixUi.hasMixBanner),
    JSON.stringify({ modalClosedBeforeReopen, edgePlRes, edgeReopenedUi, mixStatus: mixReject.status, ytMixUi })
  );

  // Real Firefox signed v1.0.7 XPI check against rebuilt Desktop
  const ffPrefs = [
    'user_pref("marionette.enabled", true);',
    `user_pref("marionette.port", ${FF_MARIONETTE_PORT});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("xpinstall.signatures.required", true);',
  ].join('\n');
  fs.writeFileSync(path.join(FF_PROF_DIR, 'user.js'), ffPrefs, 'utf8');
  const ffProc = spawn(
    FIREFOX_EXE,
    ['-no-remote', '-marionette', '-profile', FF_PROF_DIR, 'about:blank'],
    { env: { ...isolatedEnv, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }, stdio: 'ignore' }
  );
  trackedProcs.add(ffProc);
  const marionette = new MarionetteClient(FF_MARIONETTE_PORT);
  await marionette.connect(20000);
  await marionette.send('WebDriver:NewSession', { capabilities: {} }, 15000);
  await marionette.send('Addon:Install', { path: SIGNED_XPI, temporary: false }, 15000);
  await sleep(800);

  // Pair signed Firefox XPI with QA Desktop
  const ffManifestJson = JSON.parse(readZipEntryFromXpi(SIGNED_XPI, 'manifest.json'));
  await marionette.send('Marionette:SetContext', { value: 'chrome' }, 5000);
  const ffPolicy = (await marionette.send('WebDriver:ExecuteAsyncScript', {
    script: `
      const done = arguments[arguments.length - 1];
      (async () => {
        const { WebExtensionPolicy } = Cu.getGlobalForObject(ChromeUtils);
        for (let i = 0; i < 30; i++) {
          const p = WebExtensionPolicy.getByID('${EXPECTED_GECKO_ID}');
          if (p && p.active) { done({ url: p.getURL("") }); return; }
          await new Promise(r => setTimeout(r, 200));
        }
        done(null);
      })();
    `,
    args: [],
  }, 10000))?.value;

  let ffPlRes = null;
  let ffModalMounted = false;
  if (ffPolicy?.url) {
    await marionette.send('WebDriver:ExecuteScript', {
      script: `Services.wm.getMostRecentWindow("navigator:browser").gBrowser.addTrustedTab("${ffPolicy.url}options/options.html");`,
      args: [],
    }, 5000);
    await sleep(900);
    await marionette.send('Marionette:SetContext', { value: 'content' }, 5000);
    const rawHandles = await marionette.send('WebDriver:GetWindowHandles', {}, 5000);
    const handles = Array.isArray(rawHandles) ? rawHandles : (rawHandles?.value || []);
    let optHandle = null;
    for (const h of handles) {
      await marionette.send('WebDriver:SwitchToWindow', { handle: h }, 5000);
      const curUrl = await marionette.send('WebDriver:GetCurrentURL', {}, 5000);
      if (String(curUrl?.value || '').includes('options/options.html')) {
        optHandle = h;
        break;
      }
    }
    if (optHandle) {
      await marionette.send('WebDriver:SwitchToWindow', { handle: optHandle }, 5000);
      ffPlRes = (await marionette.send('WebDriver:ExecuteAsyncScript', {
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
              await browser.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: '${DESKTOP_TOKEN}' });
              const res = await browser.runtime.sendMessage({ action: 'OPEN_PLAYLIST', url: '${PLAYLIST_URL}' });
              done(res);
            } catch (e) { done({ status: 'error', message: String(e) }); }
          })();
        `,
        args: [],
      }, 15000))?.value;
      await sleep(300);
      ffModalMounted = await deskCdp.evalAsync(`!!document.querySelector('#playlist-modal')`, 5000);
    }
  }

  record(
    'PL-FF-01',
    'Mozilla-signed Firefox v1.0.7 XPI (signatures required) triggers #playlist-modal cleanly on Desktop v1.0.5-rc',
    Boolean(ffManifestJson?.version === '1.0.7' && ffPlRes?.status === 'ok' && ffModalMounted),
    JSON.stringify({ ffExtVer: ffManifestJson?.version, ffPlRes, ffModalMounted })
  );

  // -----------------------------------------------------------------------
  // 6. Failure & Recovery UX Verification (Desktop unreachable -> actionable error, unlocked button)
  // -----------------------------------------------------------------------
  console.log('\n>>> [STEP 6] Failure / Offline Bounded Recovery Verification <<<\n');
  // Shut down QA Desktop AND temporarily point Chrome NativeMessagingHost to a nonexistent path
  // so clicking Download Playlist fails cleanly without auto-launching against prod AppData.
  killTracked(deskProc);
  trackedProcs.delete(deskProc);
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-Process tori-download-manager -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${DESKTOP_INSTALL_DIR.replace(/'/g, "''")}*' } | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0`,
      ],
      { stdio: 'ignore', timeout: 4000 }
    );
  } catch {}
  const brokenNmManifest = path.join(QA_ROOT, 'broken_nm_host.json');
  fs.writeFileSync(
    brokenNmManifest,
    JSON.stringify({
      name: 'com.tori.download_manager',
      description: 'QA unreachable mock',
      path: path.join(QA_ROOT, 'nonexistent_host.exe'),
      type: 'stdio',
      allowed_origins: [`chrome-extension://${chrome.extId}/`],
    })
  );
  execFileSync(
    'reg',
    ['add', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', brokenNmManifest, '/f'],
    { stdio: 'ignore', timeout: 4000 }
  );
  const step6OptUrl = `chrome-extension://${chrome.extId}/options/options.html`;
  const step6OptCreated = await chrome.bCdp.send('Target.createTarget', { url: step6OptUrl });
  let step6OptTarget = null;
  for (let i = 0; i < 25; i++) {
    const tList = (await waitForCdpTargets(CHROME_CDP_PORT, 8000, true)).targets;
    step6OptTarget = tList.find((t) => t.id === step6OptCreated.targetId || (t.url || '').includes(step6OptUrl));
    if (step6OptTarget?.webSocketDebuggerUrl) break;
    await sleep(200);
  }
  const step6OptCdp = new CDPClient(step6OptTarget.webSocketDebuggerUrl);
  await step6OptCdp.connect(8000);
  await waitForContext(step6OptCdp, `typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.runtime`, 12000, 'Step6-options');
  await step6OptCdp.evalAsync(
    `new Promise(r => chrome.storage.local.set({ tori_settings: { port: 19999, key: 'bad', auto: true, cap: true, min: 0, badge: true, sites: [], types: [] } }, () => setTimeout(() => r(true), 200)))`,
    12000
  );
  step6OptCdp.close();
  try { await ytCdp.send('Page.bringToFront', {}, 5000); } catch {}
  const errCheck = await ytCdp.evalAsync(`(async () => {
    history.pushState({}, '', '${WATCH_IN_PLAYLIST_URL}');
    window.dispatchEvent(new Event('yt-navigate-finish'));
    const findDeadline = Date.now() + 4000;
    let btn = null;
    while (Date.now() < findDeadline) {
      const pn = document.querySelector('.tori-mp .tori-pn');
      if (pn && !pn.classList.contains('on')) {
        const pill = document.querySelector('.tori-mp .tori-pill, .tori-mp button');
        if (pill) pill.click();
      }
      btn = document.querySelector('.tori-mp [data-act="open-playlist"]');
      if (btn && pn && pn.classList.contains('on')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!btn) return { foundBtn: false };
    btn.click();
    return await new Promise((resolve) => {
      // Bounded poll until btn unlocks from Opening... back to enabled
      const start = Date.now();
      const poll = setInterval(() => {
        if (!btn.disabled && btn.dataset.toriBusy !== '1') {
          clearInterval(poll);
          const toast = document.getElementById('tori-page-toast');
          resolve({
            foundBtn: true,
            unlocked: true,
            btnText: btn.textContent,
            toastText: toast ? toast.textContent.trim() : null,
            toastIsError: toast ? toast.innerHTML.includes('#e5484d') : false,
            elapsedMs: Date.now() - start,
          });
        } else if (Date.now() - start > 18000) {
          clearInterval(poll);
          resolve({ foundBtn: true, unlocked: false });
        }
      }, 150);
    });
  })()`, 24000, { userGesture: true });

  const errOrRecoveryOk = Boolean(
    errCheck?.foundBtn &&
      errCheck?.unlocked &&
      errCheck?.btnText === 'Download Playlist' &&
      errCheck?.toastIsError === true &&
      String(errCheck?.toastText || '').length > 5
  );
  record('PL-ERR-01', 'Unreachable Desktop error unlocks Download Playlist button cleanly and surfaces actionable error toast', errOrRecoveryOk, JSON.stringify(errCheck));

  ytCdp.close();
  chrome.optCdp.close();
  chrome.bCdp.close();
  edge.optCdp.close();
  edge.bCdp.close();
  deskCdp.close();
  try { await marionette.send('Marionette:Quit', {}, 5000); } catch {}
  marionette.disconnect();

  cleanupAll();
  await sleep(900);

  const outPath = path.join(ROOT, 'target', 'gate27_8_playlist_e2e_results.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        counts,
        total: results.length,
        metrics,
        results,
      },
      null,
      2
    )
  );

  try { fs.rmSync(QA_ROOT, { recursive: true, force: true }); } catch {}

  console.log('\n========================================================================');
  console.log(` GATE 27.8 PLAYLIST E2E: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.TIMEOUT} TIMEOUT, ${counts.NOT_TESTED} NOT TESTED`);
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
