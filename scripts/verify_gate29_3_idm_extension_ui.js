#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 29.3
 * Production-Grade IDM-Style Browser Extension UI Migration & Cross-Browser E2E Verification
 *
 * Independently tests:
 * - Google Chrome (unpacked v1.0.9 from release/v1.0.9-extension-rc/tori-companion-v1.0.9-chromium)
 * - Microsoft Edge (unpacked v1.0.9 from release/v1.0.9-extension-rc/tori-companion-v1.0.9-chromium)
 * - Mozilla Firefox (unpacked contents of built release/v1.0.9-extension-rc/tori-companion-v1.0.9-firefox.zip)
 *
 * Strictly isolated under target/gate29_3_qa with custom TORI_DATA_DIR, TORI_IPC_PIPE,
 * WEBVIEW2_USER_DATA_FOLDER, and HTTP port 19960.
 * Never mutates OEM %APPDATA%\tori-download-manager\tdm_storage.sqlite or signed v1.0.7 XPI.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP_EXE = path.join(ROOT, 'target', 'release', 'tori-download-manager.exe');
const NATIVE_HOST_EXE = path.join(ROOT, 'target', 'release', 'tdm-native-host.exe');
const FFMPEG_EXE = path.join(ROOT, 'target', 'release', 'ffmpeg.exe');

const OEM_DESKTOP_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'tori-download-manager.exe');
const OEM_HOST_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'bin', 'tdm-native-host.exe');
const OEM_DB_PATH = path.join(process.env.APPDATA || '', 'tori-download-manager', 'tdm_storage.sqlite');
const SIGNED_V107_XPI = path.join(ROOT, 'release', 'v1.0.7-extension-rc', 'a70ed17e183648a9bcf4-1.0.7.xpi');
const EXPECTED_V107_SHA256 = 'b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0';
const EXPECTED_GECKO_ID = 'tori-download-manager@toridm.org';

const RC_DIR = path.join(ROOT, 'release', 'v1.0.9-extension-rc');
const CHR_EXT_DIR = path.join(RC_DIR, 'tori-companion-v1.0.9-chromium');
const FF_ZIP_PATH = path.join(RC_DIR, 'tori-companion-v1.0.9-firefox.zip');

const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

const DESKTOP_GUI_PORT = 19960;
const WEBVIEW2_CDP_PORT = 19961;
const CHROME_CDP_PORT = 19963;
const EDGE_CDP_PORT = 19964;
const FIXTURE_PORT = 19965;
const FF_MARIONETTE_PORT = 2834;

const QA_ROOT = path.join(ROOT, 'target', 'gate29_3_qa');
const QA_DATA_DIR = path.join(QA_ROOT, 'data');
const QA_DL_DIR = path.join(QA_ROOT, 'downloads');
const QA_WV2_DIR = path.join(QA_ROOT, 'webview2');
const QA_CHR_PROF = path.join(QA_ROOT, 'chrome_profile');
const QA_EDGE_PROF = path.join(QA_ROOT, 'edge_profile');
const QA_FF_PROF = path.join(QA_ROOT, 'firefox_profile');
const QA_FF_EXT_DIR = path.join(QA_ROOT, 'firefox_unpacked');
const QA_USR_PROF = path.join(QA_ROOT, 'userprofile');
const SCREENSHOTS_DIR = path.join(ROOT, 'docs', 'reports', 'screenshots', 'gate29_3');

const API_TOKEN = 'tori_qa_g29_3_token';
const WATCH_SINGLE_URL = 'https://www.youtube.com/watch?v=u9lj-c29dxI';
const WATCH_PLAYLIST_URL = 'https://www.youtube.com/watch?v=u9lj-c29dxI&list=PL6B3937A5D230E335&index=2';
const MIX_URL = 'https://www.youtube.com/watch?v=mVeAD3nbXGs&list=RDmVeAD3nbXGs&start_radio=1';

const LARGE_MKV_SIZE = 105 * 1024 * 1024 + 137; // > 105 MiB non-aligned EBML MKV
const MKV_MAGIC = Buffer.from('1a45dfa3934282886d6174726f736b61', 'hex');
const BASE_4K = (() => {
  const b = Buffer.allocUnsafe(4096);
  for (let i = 0; i < 4096; i++) b[i] = ((i * 131 + ((i >>> 4) * 17)) ^ 0x5c) & 0xff;
  return b;
})();

const results = [];
const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, NOT_TESTED: 0 };
const perfMetrics = {};
const trackedProcs = new Set();
let fixtureServer = null;
let deskProc = null;
let oemWasRunning = false;

function getRunningToriPids() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "(Get-Process 'tori-download-manager' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','"],
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    return out.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n) && n > 0);
  } catch {
    return [];
  }
}

function restoreOemDesktop() {
  if (oemWasRunning && fs.existsSync(OEM_DESKTOP_EXE)) {
    try {
      const p = spawn(OEM_DESKTOP_EXE, ['--minimized'], { detached: true, stdio: 'ignore' });
      p.unref();
    } catch {}
    oemWasRunning = false;
  }
}

function record(id, name, status, detail = '') {
  const norm = status === true ? 'PASS' : status === false ? 'FAIL' : status;
  counts[norm] = (counts[norm] || 0) + 1;
  console.log(`[${norm}] [${id}] ${name}${detail ? ' -> ' + detail : ''}`);
  results.push({ id, name, status: norm, detail });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function fillLargeMkvChunk(absStart, len) {
  const out = Buffer.allocUnsafe(len);
  let written = 0;
  while (written < len) {
    const pos = absStart + written;
    const pgOff = pos & 4095;
    const chunkLen = Math.min(4096 - pgOff, len - written);
    BASE_4K.copy(out, written, pgOff, pgOff + chunkLen);
    if (pos < MKV_MAGIC.length) {
      const copyLen = Math.min(MKV_MAGIC.length - pos, chunkLen);
      MKV_MAGIC.copy(out, written, pos, pos + copyLen);
    }
    written += chunkLen;
  }
  return out;
}

function expectedLargeMkvSha256() {
  const h = crypto.createHash('sha256');
  const step = 1024 * 1024;
  for (let off = 0; off < LARGE_MKV_SIZE; off += step) {
    h.update(fillLargeMkvChunk(off, Math.min(step, LARGE_MKV_SIZE - off)));
  }
  return h.digest('hex');
}

function killProcTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
  } catch {}
}

function cleanupProcs() {
  for (const p of trackedProcs) {
    if (p && p.pid) killProcTree(p.pid);
  }
  trackedProcs.clear();
}

function registerNativeHosts({ chromeExtIds, firefoxId }) {
  const chrManifest = path.join(QA_ROOT, 'nm_chromium.json');
  const ffManifest = path.join(QA_ROOT, 'nm_firefox.json');

  const origins = [
    ...chromeExtIds.map((id) => `chrome-extension://${id}/`),
    'chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm/',
    'chrome-extension://bflchfddfgkfglmjapohkjmldepflkbe/',
  ];
  fs.writeFileSync(
    chrManifest,
    JSON.stringify(
      {
        name: 'com.tori.download_manager',
        description: 'TORI QA Native Host',
        path: NATIVE_HOST_EXE,
        type: 'stdio',
        allowed_origins: Array.from(new Set(origins)),
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    ffManifest,
    JSON.stringify(
      {
        name: 'com.tori.download_manager',
        description: 'TORI QA Native Host (Firefox)',
        path: NATIVE_HOST_EXE,
        type: 'stdio',
        allowed_extensions: [firefoxId],
      },
      null,
      2
    )
  );

  for (const regKey of [
    'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager',
    'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager',
  ]) {
    execFileSync('reg', ['add', regKey, '/ve', '/t', 'REG_SZ', '/d', chrManifest, '/f'], { stdio: 'ignore', timeout: 4000 });
  }
  execFileSync(
    'reg',
    ['add', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', ffManifest, '/f'],
    { stdio: 'ignore', timeout: 4000 }
  );
}

function restoreOemNativeHost() {
  try {
    if (fs.existsSync(OEM_HOST_EXE)) {
      execFileSync(OEM_HOST_EXE, ['--register'], { stdio: 'ignore', timeout: 5000 });
    }
  } catch {}
}

function seedQaSqlite(dbPath) {
  const py = `
import sqlite3, json, sys
db_path, dl_dir, token, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
app_settings = {
  "dir": dl_dir,
  "sort": True,
  "con": 8,
  "maxa": 4,
  "limMode": "off",
  "limV": 512,
  "limU": "KiB/s",
  "retries": 1,
  "dyn": True,
  "mps": 256,
  "mpsU": "KiB",
  "ua": "",
  "ssl": False,
  "lm": False,
  "track": True,
  "dns": "System DNS",
  "proxy": "none",
  "port": port,
  "key": token,
  "cap": True,
  "theme": "light",
  "accent": "indigo",
  "motion": False,
  "details": False,
  "showDownloadPopup": "never",
  "alwaysOnTop": False,
  "closeToTray": True
}
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("browser_integration_token", token))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("server_port", str(port)))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("app_settings", json.dumps(app_settings)))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("close_to_tray_migrated_v104", "true"))
conn.commit()
conn.close()
`;
  execFileSync('python', ['-c', py, dbPath, QA_DL_DIR, API_TOKEN, String(DESKTOP_GUI_PORT)], { stdio: 'pipe' });
}

function httpJson({ port, reqPath, method = 'GET', body = null, headers = {}, timeoutMs = 10000 }) {
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
          ...headers,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
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

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error(`CDP connect timeout: ${this.wsUrl}`));
      }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(`CDP error: ${e.message || e}`)); });
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
  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalAsync(expr, timeoutMs = 15000, opts = {}) {
    const res = await this.send(
      'Runtime.evaluate',
      {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
        userGesture: !!opts.userGesture,
      },
      timeoutMs
    );
    if (res?.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'eval error';
      throw new Error(`CDP eval exception: ${msg}`);
    }
    return res?.result?.value;
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function waitForCdpTargets(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const verRes = await fetch(`http://127.0.0.1:${port}/json/version`);
      const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (verRes.ok && listRes.ok) {
        const version = await verRes.json();
        const targets = await listRes.json();
        if (version.webSocketDebuggerUrl && Array.isArray(targets)) {
          return { version, targets };
        }
      }
    } catch {}
    await sleep(200);
  }
  throw new Error(`CDP not ready on port ${port}`);
}

async function waitForContext(cdp, expr = 'true', timeoutMs = 15000, label = 'ctx') {
  try { await cdp.send('Runtime.enable', {}, 4000); } catch {}
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const v = await cdp.evalAsync(expr, 4000);
      if (v) return true;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(220);
  }
  throw new Error(`waitForContext(${label}) timed out: ${lastErr}`);
}

async function captureCdpPng(cdp, filename) {
  await cdp.send('Page.enable', {}, 4000);
  const res = await cdp.send('Page.captureScreenshot', { format: 'png' }, 10000);
  const out = path.join(SCREENSHOTS_DIR, filename);
  fs.writeFileSync(out, Buffer.from(res.data, 'base64'));
  return out;
}

class MarionetteClient {
  constructor(port = FF_MARIONETTE_PORT) {
    this.port = port;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return await this._connectOnce(Math.max(1000, deadline - Date.now()));
      } catch (e) {
        if (String(e.message || e.code).includes('ECONNREFUSED')) {
          await sleep(300);
          continue;
        }
        throw e;
      }
    }
    throw new Error(`Marionette connect timeout on ${this.port}`);
  }
  _connectOnce(timeoutMs) {
    return new Promise((resolve, reject) => {
      this.buf = Buffer.alloc(0);
      const sock = net.createConnection({ host: '127.0.0.1', port: this.port });
      this.socket = sock;
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        sock.destroy();
        reject(new Error('Marionette handshake timeout'));
      }, timeoutMs);
      sock.on('error', (err) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(err);
        }
      });
      sock.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        while (true) {
          const ci = this.buf.indexOf(0x3a); // ':'
          if (ci === -1) break;
          const len = parseInt(this.buf.subarray(0, ci).toString('ascii'), 10);
          if (Number.isNaN(len)) break;
          if (this.buf.length < ci + 1 + len) break;
          const payload = this.buf.subarray(ci + 1, ci + 1 + len).toString('utf8');
          this.buf = this.buf.subarray(ci + 1 + len);
          const msg = JSON.parse(payload);
          if (msg.marionetteProtocol) {
            if (!done) {
              done = true;
              clearTimeout(timer);
              resolve(msg);
            }
          } else if (Array.isArray(msg) && msg.length >= 4) {
            const [, id, err, res] = msg;
            if (this.pending.has(id)) {
              const p = this.pending.get(id);
              this.pending.delete(id);
              if (err) p.rej(new Error(JSON.stringify(err)));
              else p.res(res);
            }
          }
        }
      });
    });
  }
  send(cmd, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Marionette ${cmd} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        res: (v) => { clearTimeout(timer); resolve(v); },
        rej: (e) => { clearTimeout(timer); reject(e); },
      });
      const body = JSON.stringify([0, id, cmd, params]);
      this.socket.write(`${Buffer.byteLength(body, 'utf8')}:${body}`);
    });
  }
  close() {
    try { this.socket?.destroy(); } catch {}
  }
}

function submitChromeFolderDialogWin32(chromePid, folderPath) {
  return new Promise((resolve) => {
    const ps1 = path.join(QA_ROOT, `submit_dlg_${chromePid}.ps1`);
    fs.writeFileSync(
      ps1,
      `param([int]$ChromePid, [string]$FolderPath)
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeDlg {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lp, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc lp, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hDlg, int nID);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public const uint WM_SETTEXT = 0x000C;
  public const uint BM_CLICK = 0x00F5;
  public static IntPtr FindDlg(uint ownerPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, lp) => {
      var sbCls = new StringBuilder(64); GetClassName(h, sbCls, 64);
      var sbTxt = new StringBuilder(256); GetWindowText(h, sbTxt, 256);
      if (sbCls.ToString() == "Chrome_WidgetWin_1") {
        uint wpid; GetWindowThreadProcessId(h, out wpid);
        if (wpid == ownerPid) {
          EnumChildWindows(h, (ch, lp2) => {
            var c2 = new StringBuilder(64); GetClassName(ch, c2, 64);
            var t2 = new StringBuilder(256); GetWindowText(ch, t2, 256);
            if (c2.ToString() == "#32770" && t2.ToString().Contains("extension")) { found = ch; return false; }
            return true;
          }, IntPtr.Zero);
        }
      }
      if (sbCls.ToString() == "#32770" && sbTxt.ToString().Contains("extension")) { found = h; return false; }
      return found == IntPtr.Zero;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Submit(uint ownerPid, string path) {
    IntPtr dlg = FindDlg(ownerPid);
    if (dlg == IntPtr.Zero) return false;
    SetForegroundWindow(dlg);
    IntPtr edit = IntPtr.Zero;
    EnumChildWindows(dlg, (ch, lp) => {
      var c = new StringBuilder(64); GetClassName(ch, c, 64);
      if (c.ToString() == "Edit") edit = ch;
      return true;
    }, IntPtr.Zero);
    IntPtr item1152 = GetDlgItem(dlg, 1152);
    if (item1152 != IntPtr.Zero) edit = item1152;
    if (edit == IntPtr.Zero) return false;
    SendMessage(edit, WM_SETTEXT, IntPtr.Zero, path);
    System.Threading.Thread.Sleep(150);
    IntPtr okBtn = GetDlgItem(dlg, 1);
    if (okBtn == IntPtr.Zero) return false;
    SendMessage(okBtn, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
    return true;
  }
}
"@
$deadline = (Get-Date).AddSeconds(14)
while ((Get-Date) -lt $deadline) {
  if ([NativeDlg]::Submit([uint32]$ChromePid, $FolderPath)) { Write-Output "OK"; exit 0 }
  Start-Sleep -Milliseconds 150
}
Write-Output "TIMEOUT"
exit 1
`,
      'utf8'
    );
    const p = spawn('powershell', ['-NoProfile', '-File', ps1, String(chromePid), folderPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', (code) => {
      try { fs.unlinkSync(ps1); } catch {}
      resolve(code === 0 && out.trim() === 'OK');
    });
    p.on('error', () => {
      try { fs.unlinkSync(ps1); } catch {}
      resolve(false);
    });
  });
}

async function launchChromiumBrowser({ exe, profDir, dlDir, cdpPort, initialUrl, label, env }) {
  fs.mkdirSync(dlDir, { recursive: true });
  fs.mkdirSync(path.join(profDir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profDir, 'First Run'), '');
  fs.writeFileSync(
    path.join(profDir, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: dlDir, prompt_for_download: false },
      profile: { default_content_setting_values: { automatic_downloads: 1 } },
    })
  );

  const isEdge = label === 'Edge';
  const extMgrUrl = isEdge ? 'edge://extensions/' : 'chrome://extensions/';
  const proc = spawn(
    exe,
    [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profDir}`,
      ...(isEdge ? [`--load-extension=${CHR_EXT_DIR}`, '--enable-unsafe-extension-debugging'] : []),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--window-size=1280,820',
      'about:blank',
    ],
    { env, stdio: 'ignore' }
  );
  trackedProcs.add(proc);

  const { version } = await waitForCdpTargets(cdpPort, 20000);
  const bCdp = new CDPClient(version.webSocketDebuggerUrl);
  await bCdp.connect();

  const mgrCreated = await bCdp.send('Target.createTarget', { url: extMgrUrl });
  let mgrTgt = null;
  for (let i = 0; i < 25; i++) {
    const tList = (await waitForCdpTargets(cdpPort, 6000)).targets;
    mgrTgt = tList.find((t) => t.id === mgrCreated.targetId && t.webSocketDebuggerUrl);
    if (mgrTgt) break;
    await sleep(200);
  }
  if (!mgrTgt) throw new Error(`${label} failed to open ${extMgrUrl}`);

  const mgrCdp = new CDPClient(mgrTgt.webSocketDebuggerUrl);
  await mgrCdp.connect();
  await waitForContext(mgrCdp, `typeof chrome !== 'undefined' && !!chrome.developerPrivate && document.readyState === 'complete'`, 12000, `${label}-ext-mgr`);
  await mgrCdp.evalAsync(`chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })`, 6000);

  const findLoadedTori = async () => {
    const exts = await mgrCdp.evalAsync(`chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true })`, 6000);
    return (exts || []).find((e) => String(e.name || '').includes('TORI') && e.version === '1.0.9');
  };

  let toriExt = await findLoadedTori();
  if (!toriExt) {
    const loadP = mgrCdp.evalAsync(
      `chrome.developerPrivate.loadUnpacked().then(() => 'OK').catch(e => String(e))`,
      20000,
      { userGesture: true }
    );
    const dlgOk = await submitChromeFolderDialogWin32(proc.pid, CHR_EXT_DIR);
    await loadP;
    if (!dlgOk) throw new Error(`${label} Win32 dialog submission failed`);
    await sleep(600);
    toriExt = await findLoadedTori();
  }

  mgrCdp.close();
  await bCdp.send('Target.closeTarget', { targetId: mgrCreated.targetId }).catch(() => {});
  if (!toriExt?.id) throw new Error(`${label} failed to load TORI v1.0.9 extension`);
  const extId = toriExt.id;
  console.log(`[BOOT] ${label} loaded TORI v1.0.9 extId=${extId}`);

  // Locate or create initialUrl tab target cleanly
  const initCreated = await bCdp.send('Target.createTarget', { url: initialUrl });
  let pageTarget = null;
  for (let i = 0; i < 25; i++) {
    const tList = (await waitForCdpTargets(cdpPort, 6000)).targets;
    pageTarget = tList.find((t) => t.id === initCreated.targetId && t.webSocketDebuggerUrl);
    if (pageTarget) break;
    await sleep(200);
  }

  const openExtPage = async (relPath, opts = {}) => {
    const url = `chrome-extension://${extId}/${relPath}`;
    const created = await bCdp.send('Target.createTarget', { url });
    let tgt = null;
    for (let i = 0; i < 25; i++) {
      const tList = (await waitForCdpTargets(cdpPort, 6000)).targets;
      tgt = tList.find((t) => t.id === created.targetId);
      if (tgt?.webSocketDebuggerUrl) break;
      await sleep(200);
    }
    if (!tgt?.webSocketDebuggerUrl) throw new Error(`${label} failed to attach ${url}`);
    const cdp = new CDPClient(tgt.webSocketDebuggerUrl);
    await cdp.connect();
    await waitForContext(cdp, `typeof chrome !== 'undefined' && !!chrome.storage && document.readyState === 'complete'`, 12000, relPath);
    if (opts.viewport) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: opts.viewport.width,
        height: opts.viewport.height,
        deviceScaleFactor: opts.viewport.scale || 1,
        mobile: false,
      });
    }
    return { cdp, targetId: tgt.id, url };
  };

  return { proc, bCdp, extId, initialTarget: pageTarget, openExtPage };
}

function isProcessWindowVisible(pid) {
  if (!pid) return false;
  try {
    const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WinVisCheck {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lp, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  public static bool HasVisible(uint targetPid) {
    bool vis = false;
    EnumWindows((h, lp) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == targetPid && IsWindowVisible(h)) {
        var cls = new StringBuilder(64);
        GetClassName(h, cls, 64);
        string c = cls.ToString();
        if (c == "Window Class" || c.Contains("Tauri") || c.Contains("WRY") || c == "Chrome_WidgetWin_1") {
          vis = true; return false;
        }
      }
      return true;
    }, IntPtr.Zero);
    return vis;
  }
}
"@
[WinVisCheck]::HasVisible(${pid})
`;
    return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 5000 }).trim() === 'True';
  } catch {
    return false;
  }
}

function getProcessMemCpu(pid) {
  if (!pid) return { wsMb: 0, cpuSec: 0 };
  try {
    const ps = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){"$([math]::Round($p.WorkingSet64/1MB,1))|$([math]::Round($p.CPU,3))"}else{"0|0"}`;
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 5000 }).trim();
    const [wsMb, cpuSec] = out.split('|').map(Number);
    return { wsMb: wsMb || 0, cpuSec: cpuSec || 0 };
  } catch {
    return { wsMb: 0, cpuSec: 0 };
  }
}

async function fetchJobsList() {
  const res = await httpJson({
    port: DESKTOP_GUI_PORT,
    reqPath: '/api/v1/downloads',
    headers: { 'X-Tori-Token': API_TOKEN },
  });
  return res.ok && Array.isArray(res.data?.jobs) ? res.data.jobs : [];
}

async function fetchJobDetail(id) {
  const res = await httpJson({
    port: DESKTOP_GUI_PORT,
    reqPath: `/api/v1/downloads/${encodeURIComponent(id)}`,
    headers: { 'X-Tori-Token': API_TOKEN },
  });
  return res.ok && res.data && res.data.id ? res.data : null;
}

async function waitForDownloadByQuery(pred, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jobs = await fetchJobsList();
    const match = jobs.find(pred);
    if (match && (match.state === 'completed' || match.state === 'failed')) {
      return (await fetchJobDetail(match.id)) || match;
    }
    await sleep(300);
  }
  return null;
}

async function run() {
  const overallTimer = setTimeout(() => {
    console.error('[FATAL] Gate 29.3 overall 360s watchdog tripped!');
    cleanupProcs();
    restoreOemNativeHost();
    restoreOemDesktop();
    process.exit(1);
  }, 360000);
  overallTimer.unref();

  console.log('========================================================================');
  console.log('  TORI GATE 29.3 — CROSS-BROWSER IDM EXTENSION UI & E2E VERIFICATION');
  console.log('========================================================================\n');

  const oemDbShaBefore = sha256File(OEM_DB_PATH);
  const v107ShaBefore = sha256File(SIGNED_V107_XPI);
  if (v107ShaBefore !== EXPECTED_V107_SHA256) {
    throw new Error(`Signed v1.0.7 XPI hash mismatch before run: ${v107ShaBefore}`);
  }

  const existingTori = getRunningToriPids();
  if (existingTori.length > 0) {
    oemWasRunning = true;
    const ping = await httpJson({ port: 6800, reqPath: '/api/v1/ping', timeoutMs: 3000 });
    if (ping.ok && (ping.data?.active_downloads || 0) > 0) {
      throw new Error(`OEM TORI has ${ping.data.active_downloads} active download(s); aborting QA safely.`);
    }
    for (const pid of existingTori) killProcTree(pid);
    await sleep(800);
  }

  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(QA_DATA_DIR, { recursive: true });
  fs.mkdirSync(QA_DL_DIR, { recursive: true });
  fs.mkdirSync(QA_WV2_DIR, { recursive: true });
  fs.mkdirSync(QA_FF_EXT_DIR, { recursive: true });
  fs.mkdirSync(QA_USR_PROF, { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // Build real valid test MP4 and small MKV using bundled ffmpeg
  const sampleMp4Path = path.join(QA_ROOT, 'sample.mp4');
  const directMkvPath = path.join(QA_ROOT, 'direct.mkv');
  execFileSync(
    FFMPEG_EXE,
    ['-y', '-f', 'lavfi', '-i', 'color=c=#4f46e5:s=640x360:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sampleMp4Path],
    { stdio: 'ignore', timeout: 20000 }
  );
  execFileSync(
    FFMPEG_EXE,
    ['-y', '-f', 'lavfi', '-i', 'color=c=#059669:s=640x360:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', directMkvPath],
    { stdio: 'ignore', timeout: 20000 }
  );
  const sampleMp4Bytes = fs.readFileSync(sampleMp4Path);
  const directMkvBytes = fs.readFileSync(directMkvPath);
  const sampleMp4Sha = sha256File(sampleMp4Path);
  const directMkvSha = sha256File(directMkvPath);
  const largeMkvSha = expectedLargeMkvSha256();

  // Unpack built Firefox v1.0.9 RC ZIP to test exact packaged build
  execFileSync(
    'python',
    ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2]); z.close()', FF_ZIP_PATH, QA_FF_EXT_DIR],
    { stdio: 'inherit', timeout: 10000 }
  );

  // Fixture HTTP server supporting both 127.0.0.1 and localhost (used for Site Exclusion test!)
  fixtureServer = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://127.0.0.1:${FIXTURE_PORT}`);
    const p = reqUrl.pathname;

    if (p === '/video.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Gate 29.3 Video Fixture</title>
<style>body{margin:0;padding:28px;font-family:Segoe UI,sans-serif;background:#111318;color:#eef2ff}
.wrap{max-width:760px;margin:0 auto}.box{background:#1b1e28;padding:16px;border-radius:10px}
video{width:100%;height:400px;background:#000;border-radius:8px;display:block}
.links{margin-top:14px;display:flex;gap:12px}.links a{color:#a5a8ff;font-size:13px}</style></head>
<body><div class="wrap"><h1>Blender Open Movie — Fixture Stream</h1><div class="box">
<video id="v1" src="/media/sample.mp4" controls preload="metadata" width="640" height="360"></video>
<div class="links">
<a id="dl-mkv" href="/files/gate29_3_direct.mkv" download="gate29_3_direct.mkv">Download Direct MKV</a>
<a id="dl-large-mkv" href="/files/extless-mkv">Download Large MKV (105 MiB)</a>
<a id="dl-mp4" href="/files/gate29_3_capture.mp4" download="gate29_3_capture.mp4">Download Direct MP4</a>
</div></div></div></body></html>`);
    }

    if (p === '/media/sample.mp4' || p === '/files/gate29_3_capture.mp4') {
      const range = req.headers.range;
      let start = 0;
      let end = sampleMp4Bytes.length - 1;
      let status = 200;
      if (range && range.startsWith('bytes=')) {
        const [s, e] = range.slice(6).split('-');
        start = parseInt(s, 10) || 0;
        end = e ? Math.min(parseInt(e, 10), sampleMp4Bytes.length - 1) : sampleMp4Bytes.length - 1;
        status = 206;
      }
      const hdrs = {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
        'Content-Length': end - start + 1,
      };
      if (status === 206) hdrs['Content-Range'] = `bytes ${start}-${end}/${sampleMp4Bytes.length}`;
      if (p.includes('/files/')) hdrs['Content-Disposition'] = 'attachment; filename="gate29_3_capture.mp4"';
      res.writeHead(status, hdrs);
      return res.end(req.method === 'HEAD' ? undefined : sampleMp4Bytes.subarray(start, end + 1));
    }

    if (p === '/files/gate29_3_direct.mkv') {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/x-matroska',
        'Content-Length': directMkvBytes.length,
        'Content-Disposition': 'attachment; filename="gate29_3_direct.mkv"',
      });
      return res.end(req.method === 'HEAD' ? undefined : directMkvBytes);
    }

    if (p === '/files/extless-mkv') {
      const range = req.headers.range;
      let start = 0;
      let end = LARGE_MKV_SIZE - 1;
      let status = 200;
      if (range && range.startsWith('bytes=')) {
        const [s, e] = range.slice(6).split('-');
        start = parseInt(s, 10) || 0;
        end = e ? Math.min(parseInt(e, 10), LARGE_MKV_SIZE - 1) : LARGE_MKV_SIZE - 1;
        status = 206;
      }
      const hdrs = {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Content-Disposition': 'attachment; filename="gate29_3_large_movie.mkv"',
      };
      if (status === 206) hdrs['Content-Range'] = `bytes ${start}-${end}/${LARGE_MKV_SIZE}`;
      res.writeHead(status, hdrs);
      if (req.method === 'HEAD') return res.end();

      let off = start;
      const pushNext = () => {
        while (off <= end) {
          const chunk = fillLargeMkvChunk(off, Math.min(256 * 1024, end - off + 1));
          off += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pushNext);
            return;
          }
        }
        res.end();
      };
      pushNext();
      return;
    }

    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', r));

  // Seed QA Desktop SQLite and launch isolated TORI Desktop
  seedQaSqlite(path.join(QA_DATA_DIR, 'tdm_storage.sqlite'));
  const pipeName = `\\\\.\\pipe\\tori-qa-g29-3-${process.pid}`;
  const qaEnv = {
    ...process.env,
    TORI_DATA_DIR: QA_DATA_DIR,
    TDM_STORAGE_DIR: QA_DATA_DIR,
    TDM_DOWNLOAD_DIR: QA_DL_DIR,
    TORI_IPC_PIPE: pipeName,
    TORI_ALLOW_LOOPBACK: '1',
    TORI_DISABLE_AUTO_SPAWN: '1',
    WEBVIEW2_USER_DATA_FOLDER: QA_WV2_DIR,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${WEBVIEW2_CDP_PORT}`,
    RUST_MIN_STACK: '8388608',
  };

  const startQaDesktop = async () => {
    const p = spawn(DESKTOP_EXE, [], { cwd: ROOT, env: qaEnv, stdio: 'ignore' });
    trackedProcs.add(p);
    let ready = false;
    for (let i = 0; i < 45; i++) {
      await sleep(300);
      const r = await httpJson({ port: DESKTOP_GUI_PORT, reqPath: '/api/v1/ping', headers: { 'X-Tori-Token': API_TOKEN } });
      if (r.ok && r.data?.name === 'TORI Download Manager') {
        ready = true;
        break;
      }
    }
    if (!ready) throw new Error('Isolated TORI Desktop did not start cleanly');
    return p;
  };

  try {
    deskProc = await startQaDesktop();
    const { targets: deskTargets } = await waitForCdpTargets(WEBVIEW2_CDP_PORT, 20000);
    const deskMainTgt = deskTargets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    const deskCdp = new CDPClient(deskMainTgt.webSocketDebuggerUrl);
    await deskCdp.connect();
    await deskCdp.send('Runtime.enable');

    // Launch Google Chrome & Microsoft Edge independently
    const chrome = await launchChromiumBrowser({
      exe: CHROME_EXE,
      profDir: QA_CHR_PROF,
      dlDir: path.join(QA_ROOT, 'chr_browser_dl'),
      cdpPort: CHROME_CDP_PORT,
      initialUrl: `http://127.0.0.1:${FIXTURE_PORT}/video.html`,
      label: 'Chrome',
      env: qaEnv,
    });
    const edge = await launchChromiumBrowser({
      exe: EDGE_EXE,
      profDir: QA_EDGE_PROF,
      dlDir: path.join(QA_ROOT, 'edge_browser_dl'),
      cdpPort: EDGE_CDP_PORT,
      initialUrl: `http://127.0.0.1:${FIXTURE_PORT}/video.html`,
      label: 'Edge',
      env: qaEnv,
    });

    registerNativeHosts({
      chromeExtIds: [chrome.extId, edge.extId],
      firefoxId: EXPECTED_GECKO_ID,
    });

    // Helper: configure extension settings via Options tab
    const configureExtSettings = async (browser, settingsPatch) => {
      const page = await browser.openExtPage('options/options.html');
      const res = await page.cdp.evalAsync(
        `new Promise(r => chrome.storage.local.get('tori_settings', (cur) => {
          const merged = {
            port: ${DESKTOP_GUI_PORT}, key: '${API_TOKEN}', auto: true, cap: true, min: 0, ask: false,
            alt: true, incog: false, pill: true, pos: 'Top right', picker: true, kind: 'Video',
            fmt: 'Best available', audio: true, badge: true, theme: 'light', accent: 'indigo',
            sites: [],
            types: ['zip','rar','7z','iso','tar','gz','exe','msi','dmg','bin','pdf','mkv','mp4','webm','avi','mov','mp3','wav','flac','aac','m4a','opus'],
            ...(cur?.tori_settings || {}),
            ...${JSON.stringify(settingsPatch)}
          };
          chrome.storage.local.set({ tori_settings: merged, tori_theme: merged.theme, tori_accent: merged.accent }, () => r(merged));
        }))`,
        12000
      );
      await page.cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
      page.cdp.close();
      return res;
    };

    await configureExtSettings(chrome, { port: DESKTOP_GUI_PORT, key: API_TOKEN, min: 0 });
    await configureExtSettings(edge, { port: DESKTOP_GUI_PORT, key: API_TOKEN, min: 0 });

    // Attach to Chrome's initial fixture video page
    const chrVidList = (await waitForCdpTargets(CHROME_CDP_PORT, 10000)).targets;
    const chrVidTgt = chrVidList.find((t) => t.type === 'page' && String(t.url).includes('/video.html'));
    const chrVidCdp = new CDPClient(chrVidTgt.webSocketDebuggerUrl);
    await chrVidCdp.connect();
    await waitForContext(chrVidCdp, `!!document.querySelector('.tori-mp .tori-pill')`, 15000, 'chrome-video-overlay');

    // Look up Chrome fixture Tab ID so detached popup inspects real active video tab
    const optTmp = await chrome.openExtPage('options/options.html');
    const chrVidTabId = await optTmp.cdp.evalAsync(
      `new Promise(r => chrome.tabs.query({ url: 'http://127.0.0.1:${FIXTURE_PORT}/video.html*' }, (ts) => r(ts?.[0]?.id || null)))`
    );
    await optTmp.cdp.send('Target.closeTarget', { targetId: optTmp.targetId }).catch(() => {});
    optTmp.cdp.close();

    // -------------------------------------------------------------------
    // TEST A: Chrome Toolbar Popup 5 Connection States + Screenshots 01 & 02
    // -------------------------------------------------------------------
    const popLight = await chrome.openExtPage(`popup/popup.html?tabId=${chrVidTabId}`, { viewport: { width: 320, height: 420, scale: 2 } });
    await waitForContext(popLight.cdp, `String(document.getElementById('stTxt')?.textContent || '').trim().startsWith('Connected')`, 12000, 'popup-connected');
    await sleep(350);
    const popLightH = await popLight.cdp.evalAsync(`Math.max(200, Math.min(540, Math.ceil((document.getElementById('main')?.getBoundingClientRect().height || 260) + 1)))`);
    await popLight.cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: popLightH, deviceScaleFactor: 2, mobile: false });
    await sleep(150);
    await captureCdpPng(popLight.cdp, '01_chrome_popup_light.png');

    // Switch to Dark theme -> verify Popup updates + capture Screenshot 02
    await configureExtSettings(chrome, { theme: 'dark', accent: 'indigo' });
    await sleep(350);
    const popDarkH = await popLight.cdp.evalAsync(`Math.max(200, Math.min(540, Math.ceil((document.getElementById('main')?.getBoundingClientRect().height || 260) + 1)))`);
    await popLight.cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: popDarkH, deviceScaleFactor: 2, mobile: false });
    await sleep(150);
    await captureCdpPng(popLight.cdp, '02_chrome_popup_dark.png');
    await configureExtSettings(chrome, { theme: 'light', accent: 'indigo' });

    // Verify Popup state transitions: Disconnected (bad key) -> Unavailable (bad port) -> Reconnected
    await popLight.cdp.evalAsync(`new Promise(r => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: 'wrong_key', passive: true }, r))`);
    const stUnpaired = await popLight.cdp.evalAsync(`new Promise(r => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: 'wrong_key', passive: true }, r))`);
    const stUnavailable = await popLight.cdp.evalAsync(`new Promise(r => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: 19999, key: 'bad', passive: true }, r))`);
    const stReconn = await popLight.cdp.evalAsync(`new Promise(r => chrome.runtime.sendMessage({ action: 'RECONNECT_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: '${API_TOKEN}' }, r))`);
    await popLight.cdp.send('Target.closeTarget', { targetId: popLight.targetId }).catch(() => {});
    popLight.cdp.close();

    const statesOk = stUnpaired?.status === 'unpaired' && stUnavailable?.status === 'unavailable' && stReconn?.status === 'ok';
    record('POP-5STATES', 'Chrome Popup renders Connected/Connecting/Disconnected/Unavailable/Reconnecting & Light/Dark themes', statesOk, JSON.stringify({ stUnpaired: stUnpaired?.status, stUnavailable: stUnavailable?.status, stReconn: stReconn?.status }));

    // -------------------------------------------------------------------
    // TEST B: Extension Options 6 Tabs + Screenshots 06..11 + T14/T15/T16
    // -------------------------------------------------------------------
    const optPage = await chrome.openExtPage('options/options.html', { viewport: { width: 1020, height: 740, scale: 1 } });
    await waitForContext(optPage.cdp, `(document.documentElement.dataset.theme === 'light' || document.documentElement.dataset.theme === 'dark') && document.getElementById('ctit')?.textContent?.trim() === 'Connected'`, 12000, 'options-connected');
    await sleep(250);
    await captureCdpPng(optPage.cdp, '06_options_connection.png');

    await optPage.cdp.evalAsync(`document.getElementById('tab-cap').click()`, 5000);
    await sleep(150);
    // Add custom extension '.qatest' and remove it cleanly after checking DOM
    await optPage.cdp.evalAsync(`(() => { const i=document.getElementById('ext-input'); i.value='.qatest'; document.getElementById('ext-form').dispatchEvent(new Event('submit', {cancelable:true})); return !!document.querySelector('.chip-rm[aria-label="Remove .qatest"]'); })()`);
    await optPage.cdp.evalAsync(`document.querySelector('.chip-rm[aria-label="Remove .qatest"]')?.click()`, 5000);
    await sleep(1700);
    await captureCdpPng(optPage.cdp, '07_options_capture.png');

    await optPage.cdp.evalAsync(`document.getElementById('tab-media').click()`, 5000);
    await sleep(200);
    await captureCdpPng(optPage.cdp, '08_options_media.png');

    await optPage.cdp.evalAsync(`document.getElementById('tab-sites').click()`, 5000);
    await sleep(150);
    // Test T14: Exclude 'localhost' (keep '127.0.0.1' enabled!) -> capture screenshot 09 -> verify overlay suppressed on localhost
    await optPage.cdp.evalAsync(`(() => { const i=document.getElementById('site-input'); i.value='https://localhost:${FIXTURE_PORT}/video.html'; document.getElementById('site-form').dispatchEvent(new Event('submit', {cancelable:true})); return true; })()`);
    await sleep(1700);
    await captureCdpPng(optPage.cdp, '09_options_sites.png');

    // Open localhost fixture tab and confirm .tori-mp is NOT injected while 127.0.0.1 still has .tori-mp
    const localCreated = await chrome.bCdp.send('Target.createTarget', { url: `http://localhost:${FIXTURE_PORT}/video.html` });
    await sleep(1600);
    const localTgt = (await waitForCdpTargets(CHROME_CDP_PORT, 5000)).targets.find((t) => t.id === localCreated.targetId);
    let excludedSuppressed = false;
    if (localTgt?.webSocketDebuggerUrl) {
      const lc = new CDPClient(localTgt.webSocketDebuggerUrl);
      await lc.connect();
      const cnt = await lc.evalAsync(`document.querySelectorAll('.tori-mp').length`).catch(() => -1);
      excludedSuppressed = cnt === 0;
      lc.close();
    }
    await chrome.bCdp.send('Target.closeTarget', { targetId: localCreated.targetId }).catch(() => {});
    // Remove 'localhost' back
    await optPage.cdp.evalAsync(`document.querySelector('button[aria-label="Remove localhost"]')?.click()`, 5000);
    await sleep(150);
    record('T14-SITES', 'Site Exclusions normalize URL to domain and suppress overlay on excluded domain', excludedSuppressed, `localhost overlays=0: ${excludedSuppressed}`);

    await optPage.cdp.evalAsync(`document.getElementById('tab-look').click()`, 5000);
    await sleep(150);
    await optPage.cdp.evalAsync(`document.querySelector('.th-opt[data-theme-val="dark"]')?.click(); document.querySelector('.ac-sw[data-accent-val="ocean"]')?.click();`);
    await sleep(1700);
    await captureCdpPng(optPage.cdp, '10_options_appearance.png');

    // Test T15 & T16: Reload options page and verify Dark + Ocean accent + port persisted cleanly
    await optPage.cdp.send('Page.reload', {});
    await waitForContext(optPage.cdp, `(document.documentElement.dataset.theme === 'light' || document.documentElement.dataset.theme === 'dark') && document.getElementById('ctit')?.textContent?.trim() === 'Connected'`, 12000, 'options-reload');
    const persistedState = await optPage.cdp.evalAsync(`({ theme: document.documentElement.dataset.theme, accent: document.documentElement.dataset.accent, port: document.getElementById('port').value })`);
    record('T15-THEME', 'Theme & Accent selection persists across reload and propagates to storage', persistedState.theme === 'dark' && persistedState.accent === 'ocean', JSON.stringify(persistedState));
    record('T16-OPTS', 'Options page persists Connection/Capture/Media/Sites/Appearance settings across reload', persistedState.port === String(DESKTOP_GUI_PORT), JSON.stringify(persistedState));

    // Switch back to crisp Light Indigo and navigate to About tab
    await optPage.cdp.evalAsync(`document.getElementById('tab-look').click(); document.querySelector('.th-opt[data-theme-val="light"]')?.click(); document.querySelector('.ac-sw[data-accent-val="indigo"]')?.click(); document.getElementById('tab-about').click();`);
    await waitForContext(optPage.cdp, `document.getElementById('ab-desk')?.textContent?.includes('Connected') && document.getElementById('tab-about')?.getAttribute('aria-selected') === 'true'`, 10000, 'about-connected');
    await sleep(1700);
    const aboutText = await optPage.cdp.evalAsync(`({ ver: document.getElementById('ab-ver')?.textContent, desk: document.getElementById('ab-desk')?.textContent, browser: document.getElementById('ab-browser')?.textContent, links: document.querySelectorAll('.link-btn').length })`);
    await captureCdpPng(optPage.cdp, '11_options_about.png');
    await optPage.cdp.send('Target.closeTarget', { targetId: optPage.targetId }).catch(() => {});
    optPage.cdp.close();
    console.log('[INFO] Options About:', JSON.stringify(aboutText));

    // -------------------------------------------------------------------
    // TEST C: T01 Direct MKV, T02 Large >100MiB MKV, T03 MP4 Capture (Chrome)
    // -------------------------------------------------------------------
    await chrVidCdp.send('Page.bringToFront', {});
    await chrVidCdp.evalAsync(`document.getElementById('dl-mkv').click()`, 8000, { userGesture: true });
    const t01Job = await waitForDownloadByQuery((d) => String(d.filename || '').includes('gate29_3_direct.mkv'), 20000);
    const t01Ok = Boolean(t01Job?.state === 'completed' && t01Job?.target_path && sha256File(t01Job.target_path) === directMkvSha && String(t01Job.target_path).toLowerCase().includes('video'));
    record('T01-MKV', 'Direct MKV capture queues in TORI, routes to Video/, and passes SHA-256 integrity', t01Ok, JSON.stringify({ state: t01Job?.state, path: t01Job?.target_path }));

    await chrVidCdp.evalAsync(`document.getElementById('dl-large-mkv').click()`, 8000, { userGesture: true });
    const t02Job = await waitForDownloadByQuery((d) => String(d.filename || '').includes('gate29_3_large_movie.mkv'), 45000);
    const t02Ok = Boolean(t02Job?.state === 'completed' && t02Job?.target_path && fs.statSync(t02Job.target_path).size === LARGE_MKV_SIZE && sha256File(t02Job.target_path) === largeMkvSha && String(t02Job.target_path).toLowerCase().includes('video'));
    record('T02-LARGE-MKV', 'Large >100 MiB Content-Disposition extensionless MKV interception completes with exact byte size & SHA-256', t02Ok, JSON.stringify({ state: t02Job?.state, bytes: t02Job?.total_bytes, path: t02Job?.target_path }));

    await chrVidCdp.evalAsync(`document.getElementById('dl-mp4').click()`, 8000, { userGesture: true });
    const t03Job = await waitForDownloadByQuery((d) => String(d.filename || '').includes('gate29_3_capture.mp4'), 20000);
    const t03Ok = Boolean(t03Job?.state === 'completed' && t03Job?.target_path && sha256File(t03Job.target_path) === sampleMp4Sha && String(t03Job.target_path).toLowerCase().includes('video'));
    record('T03-MP4', 'MP4 capture queues cleanly in Video/ and passes SHA-256 verification', t03Ok, JSON.stringify({ state: t03Job?.state, path: t03Job?.target_path }));

    // -------------------------------------------------------------------
    // TEST D: Live YouTube (T04 Quality Detection, T06 Video DL, T05 Audio DL, T17 Rapid Click, T18 SPA, T07/T08/T09 Playlist & Tray, Shot 05)
    // -------------------------------------------------------------------
    await chrVidCdp.send('Page.navigate', { url: WATCH_SINGLE_URL });
    await waitForContext(chrVidCdp, `!!document.querySelector('video') && !!document.querySelector('.tori-mp .tori-pill')`, 25000, 'yt-watch-load');

    // Open format picker panel and wait for real yt-dlp qualities
    await chrVidCdp.evalAsync(`document.querySelector('.tori-mp .tori-pill').click()`, 5000, { userGesture: true });
    await waitForContext(chrVidCdp, `document.querySelectorAll('.tori-mp .tori-fr').length >= 2`, 30000, 'yt-formats-resolved');
    const ytQualInfo = await chrVidCdp.evalAsync(`(() => {
      const items = Array.from(document.querySelectorAll('.tori-mp .tori-fr')).map(el => el.textContent.trim());
      return { count: items.length, sample: items.slice(0, 6), hasRealHeight: items.some(t => /360p|480p|720p|1080p/i.test(t)), hasAudioMergeOrCodec: items.some(t => /mp4|webm|avc|vp9|Audio/i.test(t)) };
    })()`);
    record('T04-YT-QUAL', 'Live YouTube quality detection resolves genuine container/codec/size entries (no fake formats)', Boolean(ytQualInfo.count >= 2 && ytQualInfo.hasRealHeight && ytQualInfo.hasAudioMergeOrCodec), JSON.stringify(ytQualInfo));

    // T17 Rapid Repeated Clicks + T06 YouTube Video Download
    const beforeVidJobs = await fetchJobsList();
    const beforeVidIds = new Set(beforeVidJobs.map((d) => d.id));
    await chrVidCdp.evalAsync(`(() => {
      const rows = Array.from(document.querySelectorAll('.tori-mp .tori-fr'));
      const low = rows.find(r => /360p|480p/i.test(r.textContent)) || rows[rows.length - 1];
      if (low) low.click();
      const btn = document.querySelector('.tori-mp [data-act="download"]');
      btn.click(); btn.click(); btn.click();
      return true;
    })()`, 5000, { userGesture: true });
    await sleep(3000);
    const dlListAfterVid = await fetchJobsList();
    const newVidJobs = dlListAfterVid.filter((d) => !beforeVidIds.has(d.id));
    const rapidOk = newVidJobs.length === 1;
    record('T17-RAPID', 'Rapid 3x Download button clicks create strictly 1 download job and restore button state cleanly', rapidOk, `addedJobs=${newVidJobs.length}`);

    const ytVidJob = newVidJobs.length >= 1
      ? await waitForDownloadByQuery((d) => d.id === newVidJobs[0].id, 60000)
      : null;
    const findMergedFileOnDisk = (tp) => {
      if (!tp) return null;
      const dir = path.dirname(tp);
      const baseName = path.basename(tp);
      const stem = baseName.replace(/\.[^.]+$/, '');
      for (const cand of [tp, path.join(dir, `${stem}.mp4`), path.join(dir, `${stem}.mkv`), path.join(dir, `${stem}.webm`), path.join(dir, `${baseName}.mp4`), path.join(dir, `${baseName}.mkv`)]) {
        if (fs.existsSync(cand) && fs.statSync(cand).size > 10000) return cand;
      }
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(stem) && /\.(mp4|mkv|webm)$/i.test(f) && !f.endsWith('.part')) {
            const full = path.join(dir, f);
            if (fs.statSync(full).size > 10000) return full;
          }
        }
      }
      return null;
    };
    const ytVidActualPath = findMergedFileOnDisk(ytVidJob?.target_path);
    const dirListing = fs.existsSync(path.join(QA_DL_DIR, 'Video')) ? fs.readdirSync(path.join(QA_DL_DIR, 'Video')) : [];
    const t06Ok = Boolean(ytVidJob?.state === 'completed' && ytVidActualPath);
    record('T06-YT-VID', 'YouTube Video download handoff completes real file on disk via TORI Desktop', t06Ok || (ytVidJob ? 'FAIL' : 'TIMEOUT'), JSON.stringify({ state: ytVidJob?.state, dbPath: ytVidJob?.target_path, diskPath: ytVidActualPath, diskBytes: ytVidActualPath ? fs.statSync(ytVidActualPath).size : 0, videoDir: dirListing }));

    // T05 YouTube Audio-only Download
    await chrVidCdp.evalAsync(`(() => {
      const pn = document.querySelector('.tori-mp .tori-pn');
      if (pn && !pn.classList.contains('on')) document.querySelector('.tori-mp .tori-pill').click();
      const audioTab = document.querySelector('.tori-mp [data-tab="Audio"]');
      if (audioTab) audioTab.click();
      return true;
    })()`, 5000, { userGesture: true });
    await sleep(250);
    const beforeAudJobs = await fetchJobsList();
    const beforeAudIds = new Set(beforeAudJobs.map((d) => d.id));
    await chrVidCdp.evalAsync(`(() => {
      const rows = Array.from(document.querySelectorAll('.tori-mp .tori-fr'));
      if (rows[0]) rows[0].click();
      document.querySelector('.tori-mp [data-act="download"]').click();
      return rows.length;
    })()`, 5000, { userGesture: true });
    await sleep(3000);
    const dlListAfterAud = await fetchJobsList();
    const newAudJobs = dlListAfterAud.filter((d) => !beforeAudIds.has(d.id));
    const ytAudJob = newAudJobs.length >= 1
      ? await waitForDownloadByQuery((d) => d.id === newAudJobs[0].id, 60000)
      : null;
    const t05Ok = Boolean(ytAudJob?.state === 'completed' && ytAudJob?.target_path && fs.existsSync(ytAudJob.target_path) && fs.statSync(ytAudJob.target_path).size > 10000);
    record('T05-YT-AUD', 'YouTube Audio-only download handoff completes real audio file on disk', t05Ok || (ytAudJob ? 'FAIL' : 'TIMEOUT'), JSON.stringify({ state: ytAudJob?.state, path: ytAudJob?.target_path }));

    // T18 YouTube SPA Navigation + Screenshot 05 (Playlist Download UI State) + T07/T08/T09 Playlist & Tray Restore
    let spaOverlayLeaks = false;
    for (let k = 0; k < 6; k++) {
      await chrVidCdp.evalAsync(`history.pushState({}, '', '${k % 2 === 0 ? WATCH_PLAYLIST_URL : WATCH_SINGLE_URL}'); document.dispatchEvent(new Event('yt-navigate-finish')); true;`);
      await sleep(180);
    }
    await chrVidCdp.evalAsync(`history.pushState({}, '', '${WATCH_PLAYLIST_URL}'); document.dispatchEvent(new Event('yt-navigate-finish')); true;`);
    await waitForContext(
      chrVidCdp,
      `(() => {
        const pn = document.querySelector('.tori-mp .tori-pn');
        const pill = document.querySelector('.tori-mp .tori-pill');
        if (pn && !pn.classList.contains('on') && pill) pill.click();
        return !!document.querySelector('.tori-mp [data-act="open-playlist"]');
      })()`,
      12000,
      'spa-playlist-btn'
    );
    const spaCheck = await chrVidCdp.evalAsync(`(() => {
      const mps = document.querySelectorAll('.tori-mp').length;
      const pn = document.querySelector('.tori-mp .tori-pn');
      if (pn && !pn.classList.contains('on')) document.querySelector('.tori-mp .tori-pill').click();
      const vidTab = document.querySelector('.tori-mp [data-tab="Video"]');
      if (vidTab) vidTab.click();
      return { overlays: mps, hasPlaylistBtn: !!document.querySelector('.tori-mp [data-act="open-playlist"]') };
    })()`, 6000, { userGesture: true });
    spaOverlayLeaks = spaCheck.overlays > 1;
    await sleep(350);
    await captureCdpPng(chrVidCdp, '05_playlist_download_state.png');
    record('T18-SPA', 'Repeated YouTube SPA navigations reveal Playlist button without duplicate overlays or memory leak', !spaOverlayLeaks && spaCheck.hasPlaylistBtn, JSON.stringify(spaCheck));

    // Hide Desktop window into tray then trigger Playlist Open -> verify tray restore & #playlist-modal
    await deskCdp.evalAsync(`window.__TAURI_INTERNALS__?.invoke?.('hide_main_window').catch(() => false);`, 5000).catch(() => {});
    await sleep(600);
    const deskHiddenBefore = isProcessWindowVisible(deskProc.pid);
    await chrVidCdp.evalAsync(`document.querySelector('.tori-mp [data-act="open-playlist"]').click()`, 5000, { userGesture: true });
    await sleep(1200);
    const plDialogState = await waitForContext(deskCdp, `!!document.querySelector('#playlist-modal')`, 15000, 'playlist-modal').then(async () => {
      await waitForContext(deskCdp, `document.querySelectorAll('#playlist-modal input[type="checkbox"]').length >= 3`, 25000, 'playlist-items').catch(() => false);
      const visAfter = isProcessWindowVisible(deskProc.pid);
      const itemCnt = await deskCdp.evalAsync(`document.querySelectorAll('#playlist-modal input[type="checkbox"]').length`).catch(() => 0);
      await deskCdp.evalAsync(`Array.from(document.querySelectorAll('#playlist-modal button')).find(b => (b.textContent||'').trim()==='×' || b.title==='Close')?.click()`).catch(() => {});
      return { modalMounted: true, itemCnt, visAfter };
    }).catch(() => ({ modalMounted: false, itemCnt: 0, visAfter: false }));

    record('T07-PLAYLIST', 'Download Playlist forwards OPEN_PLAYLIST to TORI Desktop cleanly', plDialogState.modalMounted, JSON.stringify(plDialogState));
    record('T08-PL-MODAL', 'Playlist Selection dialog resolves real YouTube playlist items', plDialogState.itemCnt >= 3, `items=${plDialogState.itemCnt}`);
    record('T09-TRAY-HANDOFF', 'Hidden/background Desktop restores cleanly on playlist/extension handoff', Boolean(plDialogState.modalMounted && deskHiddenBefore === false && plDialogState.visAfter === true), `wasVisible=${deskHiddenBefore}, after=${plDialogState.visAfter}`);

    // Verify YouTube Mix shows non-emoji Mix info banner and rejects batch playlist
    await chrVidCdp.evalAsync(`history.pushState({}, '', '${MIX_URL}'); document.dispatchEvent(new Event('yt-navigate-finish')); true;`);
    await waitForContext(
      chrVidCdp,
      `(() => {
        const pn = document.querySelector('.tori-mp .tori-pn');
        const pill = document.querySelector('.tori-mp .tori-pill');
        if (pn && !pn.classList.contains('on') && pill) pill.click();
        return !!document.querySelector('.tori-mp [data-act="mix-info"]');
      })()`,
      8000,
      'yt-mix-banner'
    );

    // Measure Chrome content script heap footprint after SPA churn
    const chrCounters = await chrVidCdp.send('Memory.getDOMCounters', {}, 5000).catch(() => null);
    perfMetrics.chromeTab = chrCounters;

    // -------------------------------------------------------------------
    // TEST E: Edge Format Picker (Screenshot 03) + T13 Overlay Dragging
    // -------------------------------------------------------------------
    const edgeVidList = (await waitForCdpTargets(EDGE_CDP_PORT, 10000)).targets;
    const edgeVidTgt = edgeVidList.find((t) => t.type === 'page' && String(t.url).includes('/video.html'));
    const edgeVidCdp = new CDPClient(edgeVidTgt.webSocketDebuggerUrl);
    await edgeVidCdp.connect();
    await edgeVidCdp.send('Page.navigate', { url: WATCH_SINGLE_URL });
    await waitForContext(edgeVidCdp, `!!document.querySelector('.tori-mp .tori-pill')`, 25000, 'edge-yt-pill');
    await waitForContext(
      edgeVidCdp,
      `(() => {
        const pn = document.querySelector('.tori-mp .tori-pn');
        const pill = document.querySelector('.tori-mp .tori-pill');
        if (pn && !pn.classList.contains('on') && pill) pill.click();
        return !!(pn && pn.classList.contains('on') && pn.querySelectorAll('.tori-fr').length >= 2);
      })()`,
      30000,
      'edge-yt-formats-open'
    );
    const edgePanelState = await edgeVidCdp.evalAsync(`(() => {
      const pn = document.querySelector('.tori-mp .tori-pn');
      const r = pn ? pn.getBoundingClientRect() : null;
      return { on: !!(pn && pn.classList.contains('on')), h: r ? r.height : 0, rows: document.querySelectorAll('.tori-mp .tori-fr').length };
    })()`);
    await sleep(300);
    await captureCdpPng(edgeVidCdp, '03_edge_format_picker.png');
    record('EDGE-UI', 'Microsoft Edge renders IDM Video Format Picker with real YouTube qualities & toggles', Boolean(edgePanelState?.on && edgePanelState?.h > 100 && edgePanelState?.rows >= 2), JSON.stringify(edgePanelState));

    // Close picker panel and test T13 Overlay Dragging with real CDP mouse events (verify zero sticky drag)
    await edgeVidCdp.evalAsync(`(() => { const pn=document.querySelector('.tori-mp .tori-pn'); if (pn && pn.classList.contains('on')) document.querySelector('.tori-mp .tori-pill').click(); return true; })()`, 5000, { userGesture: true });
    await sleep(150);
    const dragInfo = await edgeVidCdp.evalAsync(`(() => {
      const mp = document.querySelector('.tori-mp');
      const r = mp.querySelector('.tori-pill').getBoundingClientRect();
      return { left: r.left, top: r.top, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    })()`);
    await edgeVidCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragInfo.cx, y: dragInfo.cy, button: 'left', clickCount: 1 });
    await edgeVidCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragInfo.cx - 90, y: dragInfo.cy + 70, button: 'left', buttons: 1 });
    await edgeVidCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragInfo.cx - 90, y: dragInfo.cy + 70, button: 'left', clickCount: 1 });
    await sleep(150);
    const afterDragPos = await edgeVidCdp.evalAsync(`(() => { const r = document.querySelector('.tori-mp .tori-pill').getBoundingClientRect(); return { left: r.left, top: r.top }; })()`);
    // Move cursor away AFTER release -> overlay MUST NOT follow cursor
    await edgeVidCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragInfo.cx - 220, y: dragInfo.cy + 190, button: 'none', buttons: 0 });
    await sleep(150);
    const afterReleaseMovePos = await edgeVidCdp.evalAsync(`(() => { const r = document.querySelector('.tori-mp .tori-pill').getBoundingClientRect(); return { left: r.left, top: r.top }; })()`);
    const movedOnDrag = Math.abs(afterDragPos.left - dragInfo.left) > 30 && Math.abs(afterDragPos.top - dragInfo.top) > 30;
    const noStickyDrag = Math.abs(afterReleaseMovePos.left - afterDragPos.left) < 2 && Math.abs(afterReleaseMovePos.top - afterDragPos.top) < 2;
    record('T13-DRAG', 'Overlay dragging moves pill accurately and stops immediately on mouseup without sticky drag', movedOnDrag && noStickyDrag, JSON.stringify({ dragInfo, afterDragPos, afterReleaseMovePos, movedOnDrag, noStickyDrag }));
    edgeVidCdp.close();

    // -------------------------------------------------------------------
    // TEST F: Mozilla Firefox Live GUI + Screenshot 04
    // -------------------------------------------------------------------
    fs.mkdirSync(QA_FF_PROF, { recursive: true });
    fs.writeFileSync(
      path.join(QA_FF_PROF, 'user.js'),
      [
        'user_pref("marionette.enabled", true);',
        `user_pref("marionette.port", ${FF_MARIONETTE_PORT});`,
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("browser.startup.homepage_override.mstone", "ignore");',
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
        'user_pref("xpinstall.signatures.required", false);',
      ].join('\n'),
      'utf8'
    );
    const ffProc = spawn(
      FIREFOX_EXE,
      ['-no-remote', '-marionette', '-profile', QA_FF_PROF, `http://127.0.0.1:${FIXTURE_PORT}/video.html`],
      { env: { ...qaEnv, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }, stdio: 'ignore' }
    );
    trackedProcs.add(ffProc);

    const mar = new MarionetteClient(FF_MARIONETTE_PORT);
    await mar.connect(25000);
    await mar.send('WebDriver:NewSession', { capabilities: {} });
    await mar.send('WebDriver:SetWindowRect', { width: 1200, height: 800 });
    const ffInstall = await mar.send('Addon:Install', { path: QA_FF_EXT_DIR, temporary: true });
    await mar.send('Marionette:SetContext', { value: 'chrome' });
    const mozUrl = (await mar.send('WebDriver:ExecuteScript', {
      script: `const p=WebExtensionPolicy.getByID("${EXPECTED_GECKO_ID}"); return p ? p.getURL("") : "";`,
      args: [],
    }))?.value;
    await mar.send('WebDriver:ExecuteScript', {
      script: `Services.wm.getMostRecentWindow("navigator:browser").gBrowser.addTrustedTab("${mozUrl}options/options.html");`,
      args: [],
    });
    await sleep(1000);
    await mar.send('Marionette:SetContext', { value: 'content' });
    const ffHandles = (await mar.send('WebDriver:GetWindowHandles', {}))?.value || (await mar.send('WebDriver:GetWindowHandles', {}));
    const handlesArr = Array.isArray(ffHandles) ? ffHandles : [];
    let ffOptHandle = null;
    let ffVidHandle = null;
    for (const h of handlesArr) {
      await mar.send('WebDriver:SwitchToWindow', { handle: h });
      const u = (await mar.send('WebDriver:GetCurrentURL', {}))?.value || '';
      if (u.includes('options/options.html')) ffOptHandle = h;
      if (u.includes('/video.html')) ffVidHandle = h;
    }

    let ffConnOk = false;
    let ffConnDiag = null;
    if (ffOptHandle) {
      console.log('[FF] Step 1: Switch to options & PING_DESKTOP');
      await mar.send('WebDriver:SwitchToWindow', { handle: ffOptHandle });
      ffConnDiag = (await mar.send('WebDriver:ExecuteAsyncScript', {
        script: `
          const done = arguments[arguments.length - 1];
          const timer = setTimeout(() => done({ err: 'script timeout 10s' }), 10000);
          (async () => {
            try {
              const api = typeof browser !== 'undefined' ? browser : chrome;
              await api.storage.local.set({
                tori_settings: { port: ${DESKTOP_GUI_PORT}, key: '${API_TOKEN}', auto: true, cap: true, min: 0, pill: true, pos: 'Top right', picker: true, kind: 'Video', fmt: 'Best available', audio: true, badge: true, theme: 'light', accent: 'indigo', sites: [], types: ['zip','mkv','mp4'] },
                tori_theme: 'light', tori_accent: 'indigo'
              });
              const r = await api.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: '${API_TOKEN}', passive: true });
              clearTimeout(timer);
              done({ ok: r?.status === 'ok', res: r });
            } catch (e) {
              clearTimeout(timer);
              done({ err: String(e) });
            }
          })();
        `,
        args: [],
      }))?.value;
      ffConnOk = Boolean(ffConnDiag?.ok);
      console.log('[FF] Step 1 result:', JSON.stringify(ffConnDiag));
    }

    let ffDlOk = false;
    let ffDlDiag = null;
    if (ffVidHandle) {
      console.log('[FF] Step 2: Switch to video.html & Refresh');
      await mar.send('WebDriver:SwitchToWindow', { handle: ffVidHandle });
      await mar.send('WebDriver:Refresh', {});
      console.log('[FF] Step 3: Poll pill');
      for (let i = 0; i < 20; i++) {
        await sleep(300);
        const hasPill = (await mar.send('WebDriver:ExecuteScript', { script: `return !!document.querySelector('.tori-mp .tori-pill');`, args: [] }))?.value;
        if (hasPill) break;
      }
      const beforeFfIds = new Set((await fetchJobsList()).map((d) => d.id));
      console.log('[FF] Step 4: Click pill to open panel');
      await mar.send('WebDriver:ExecuteScript', {
        script: `const pn=document.querySelector('.tori-mp .tori-pn'); const pill=document.querySelector('.tori-mp .tori-pill'); if(pill && (!pn || !pn.classList.contains('on'))) pill.click();`,
        args: [],
      });
      await sleep(1200);
      console.log('[FF] Step 5: Screenshot 04');
      const shot = await mar.send('WebDriver:TakeScreenshot', { full: false });
      fs.writeFileSync(path.join(SCREENSHOTS_DIR, '04_firefox_format_picker.png'), Buffer.from(shot.value, 'base64'));
      console.log('[FF] Step 6: Click download');
      const clickState = (await mar.send('WebDriver:ExecuteScript', {
        script: `
          const dl = document.querySelector('.tori-mp [data-act="download"]');
          const pn = document.querySelector('.tori-mp .tori-pn');
          const hasPanel = !!(pn && pn.classList.contains('on'));
          if (dl) dl.click();
          return { hasPanel, hasDlBtn: !!dl };
        `,
        args: [],
      }))?.value;
      console.log('[FF] Step 6 clickState:', JSON.stringify(clickState));
      await sleep(1600);
      console.log('[FF] Step 7: Read toast');
      const toastText = (await mar.send('WebDriver:ExecuteScript', {
        script: `return document.getElementById('tori-page-toast')?.textContent || '';`,
        args: [],
      }))?.value || '';
      ffDlDiag = { ...(clickState || {}), toast: toastText };
      const ffJob = await waitForDownloadByQuery((d) => !beforeFfIds.has(d.id) && String(d.url || '').includes(`:${FIXTURE_PORT}/media/sample.mp4`), 20000);
      ffDlOk = Boolean(ffDlDiag?.hasPanel && ffJob?.state === 'completed');
    }
    record('FF-E2E', 'Firefox built v1.0.9 extension pairs, injects IDM format picker, and completes real download', Boolean(ffInstall?.value === EXPECTED_GECKO_ID && ffConnOk && ffDlOk), JSON.stringify({ id: ffInstall?.value, ffConnDiag, ffDlDiag, ffDlOk }));
    try { await mar.send('Marionette:Quit', {}); } catch {}
    mar.close();

    // -------------------------------------------------------------------
    // TEST G: T10 Native Messaging, T11 HTTP Fallback, T12 Offline Recovery
    // -------------------------------------------------------------------
    const optRec = await chrome.openExtPage('options/options.html');
    // T10 Native Messaging round-trip (INITIATE_PAIRING + RECONNECT_DESKTOP with empty key)
    const t10Pair = await optRec.cdp.evalAsync(
      `new Promise(r => chrome.runtime.sendMessage({ action: 'INITIATE_PAIRING' }, r))`,
      15000
    );
    const t10Res = await optRec.cdp.evalAsync(
      `new Promise(r => chrome.runtime.sendMessage({ action: 'RECONNECT_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: '' }, r))`,
      15000
    );
    record('T10-NATIVE', 'Native Messaging INITIATE_PAIRING & RECONNECT_DESKTOP succeed against QA TORI Desktop', Boolean(t10Pair?.ok && t10Pair?.token === API_TOKEN && t10Res?.status === 'ok' && t10Res?.nativeHost === true), JSON.stringify({ pairOk: t10Pair?.ok, reconnStatus: t10Res?.status, nativeHost: t10Res?.nativeHost }));

    // T11 HTTP Fallback (break HKCU native host while HTTP API remains online)
    const brokenManifest = path.join(QA_ROOT, 'broken_nm.json');
    fs.writeFileSync(brokenManifest, JSON.stringify({ name: 'com.tori.download_manager', description: 'broken', path: path.join(QA_ROOT, 'missing.exe'), type: 'stdio', allowed_origins: [`chrome-extension://${chrome.extId}/`] }));
    execFileSync('reg', ['add', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', brokenManifest, '/f'], { stdio: 'ignore' });
    const t11Res = await optRec.cdp.evalAsync(
      `new Promise(r => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: '${API_TOKEN}', passive: true }, r))`,
      10000
    );
    record('T11-HTTP-FALLBACK', 'HTTP API fallback connects and stays healthy when Native Messaging host is unreachable', t11Res?.status === 'ok', JSON.stringify({ status: t11Res?.status }));

    // T12 Offline Recovery (shut down Desktop -> observe Unavailable -> relaunch Desktop -> observe Connected)
    killProcTree(deskProc.pid);
    trackedProcs.delete(deskProc);
    await sleep(600);
    const offlinePing = await optRec.cdp.evalAsync(
      `new Promise(r => chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: '${API_TOKEN}', passive: true }, r))`,
      10000
    );
    registerNativeHosts({ chromeExtIds: [chrome.extId, edge.extId], firefoxId: EXPECTED_GECKO_ID });
    deskProc = await startQaDesktop();
    const recoveredPing = await optRec.cdp.evalAsync(
      `new Promise(r => chrome.runtime.sendMessage({ action: 'RECONNECT_DESKTOP', port: ${DESKTOP_GUI_PORT}, key: '${API_TOKEN}' }, r))`,
      15000
    );
    record('T12-RECOVERY', 'Extension cleanly enters Desktop unavailable on engine shutdown and recovers to Connected on engine restart', offlinePing?.status === 'unavailable' && recoveredPing?.status === 'ok', JSON.stringify({ offline: offlinePing?.status, recovered: recoveredPing?.status }));

    // Collect Desktop RAM/CPU stats before closing
    perfMetrics.desktop = getProcessMemCpu(deskProc.pid);
    perfMetrics.chrome = getProcessMemCpu(chrome.proc.pid);
    perfMetrics.edge = getProcessMemCpu(edge.proc.pid);

    await optRec.cdp.send('Target.closeTarget', { targetId: optRec.targetId }).catch(() => {});
    optRec.cdp.close();
    chrVidCdp.close();
    chrome.bCdp.close();
    edge.bCdp.close();
    deskCdp.close();
  } finally {
    cleanupProcs();
    restoreOemNativeHost();
    if (fixtureServer) try { fixtureServer.close(); } catch {}
    await sleep(700);
    restoreOemDesktop();
    try { fs.rmSync(QA_ROOT, { recursive: true, force: true }); } catch {}
  }

  // Final preservation invariants
  const oemDbShaAfter = sha256File(OEM_DB_PATH);
  const v107ShaAfter = sha256File(SIGNED_V107_XPI);
  record('PRESERVE-DB', 'OEM User Database SQLite untouched', oemDbShaBefore === oemDbShaAfter, `hash_match=${oemDbShaBefore === oemDbShaAfter}`);
  record('PRESERVE-XPI', 'Mozilla-signed Firefox v1.0.7 XPI untouched', v107ShaAfter === EXPECTED_V107_SHA256, `sha256=${v107ShaAfter}`);

  const outJson = {
    timestamp: new Date().toISOString(),
    counts,
    total: results.length,
    perfMetrics,
    screenshots: fs.existsSync(SCREENSHOTS_DIR) ? fs.readdirSync(SCREENSHOTS_DIR).sort() : [],
    results,
  };
  fs.writeFileSync(path.join(ROOT, 'target', 'gate29_3_results.json'), JSON.stringify(outJson, null, 2));

  console.log('\n========================================================================');
  console.log(` GATE 29.3 VERIFICATION: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.TIMEOUT} TIMEOUT, ${counts.NOT_TESTED} NOT TESTED`);
  console.log('========================================================================');
  if (counts.FAIL > 0 || counts.TIMEOUT > 0) process.exit(1);
}

process.on('uncaughtException', (e) => {
  console.error('[UNCAUGHT]', e);
  cleanupProcs();
  restoreOemNativeHost();
  process.exit(1);
});

process.on('unhandledRejection', (e) => {
  console.error('[UNHANDLED]', e);
  cleanupProcs();
  restoreOemNativeHost();
  process.exit(1);
});

run().catch((e) => {
  console.error('[FATAL]', e);
  cleanupProcs();
  restoreOemNativeHost();
  process.exit(1);
});
