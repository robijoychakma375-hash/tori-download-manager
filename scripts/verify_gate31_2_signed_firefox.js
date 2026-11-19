#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 31.2 Signed Firefox & Cross-Browser Verification Suite
 *
 * Tests Instagram Video Overlay Click-Through Fix & Resolving-State Robustness across:
 *   - Google Chrome (unpacked v1.0.10 RC)
 *   - Microsoft Edge (unpacked v1.0.10 RC)
 *   - Mozilla Firefox (built v1.0.10 RC unpacked in Marionette)
 *
 * Covers:
 *   1. Self-verifying negative control proving un-isolated z-index:0 child mounting fails click-through.
 *   2. Real live Instagram Reels & single Reel pages (paused + playing + SPA nav + resolution).
 *   3. All 12 Phase 3 Instagram scenarios in all 3 browsers with real pointer/mouse/keyboard events.
 *   4. Regression checks (live YouTube, Facebook feed/reel, theme persistence, duplicate prevention, offline/error recovery).
 *
 * Strictly isolated under target/gate31_2_qa. Never modifies OEM SQLite DB or signed v1.0.7 / v1.0.9 XPIs.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP_EXE = path.join(ROOT, 'target', 'release', 'tori-download-manager.exe');
const NATIVE_HOST_EXE = path.join(ROOT, 'target', 'release', 'tdm-native-host.exe');
const FFMPEG_EXE = path.join(ROOT, 'resources', 'bin', 'ffmpeg.exe');
const OEM_DESKTOP_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'tori-download-manager.exe');
const OEM_HOST_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'bin', 'tdm-native-host.exe');

const RC_DIR = path.join(ROOT, 'release', 'v1.0.10-extension-rc');
const CHR_EXT_DIR = path.join(RC_DIR, 'tori-companion-v1.0.10-chromium');
const FF_ZIP_PATH = path.join(RC_DIR, 'tori-companion-v1.0.10-firefox.zip');
const SIGNED_FF_XPI = path.join(RC_DIR, 'tori-companion-v1.0.10-firefox-signed.xpi');
const EXPECTED_XPI_SHA = 'a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8';
const EXPECTED_CHR_SHA = 'f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1';
const EXPECTED_GECKO_ID = 'tori-download-manager@toridm.org';

const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

const QA_ROOT = path.join(ROOT, 'target', 'gate31_2_qa');
const QA_DATA_DIR = path.join(QA_ROOT, 'data');
const QA_DL_DIR = path.join(QA_ROOT, 'downloads');
const QA_WV2_DIR = path.join(QA_ROOT, 'webview2');
const QA_CHR_PROF = path.join(QA_ROOT, 'chrome_profile');
const QA_EDGE_PROF = path.join(QA_ROOT, 'edge_profile');
const QA_FF_PROF = path.join(QA_ROOT, 'firefox_profile');
const QA_FF_EXT_DIR = path.join(QA_ROOT, 'firefox_unpacked');
const QA_SAMPLE_MP4 = path.join(QA_ROOT, 'sample_vertical.mp4');
const SHOTS_DIR = path.join(ROOT, 'docs', 'reports', 'screenshots', 'gate31_2');

const DESKTOP_PORT = 24991;
const WEBVIEW2_CDP_PORT = 24992;
const CHROME_CDP_PORT = 24993;
const EDGE_CDP_PORT = 24994;
const FIXTURE_PORT = 24990;
const FF_MARIONETTE_PORT = 2839;
const API_TOKEN = 'tori_qa_g31_1_token';

const results = [];
const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
const trackedProcs = new Set();
let oemWasRunning = false;
let deskProc = null;
let fixtureServer = null;

function record(browser, id, desc, ok, detail = '') {
  const status = ok === 'SKIP' ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  counts[status]++;
  console.log(`[${status}] [${browser}] [${id}] ${desc}${detail ? ' -> ' + detail : ''}`);
  results.push({ browser, id, desc, status, detail });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
    JSON.stringify({ name: 'com.tori.download_manager', description: 'TORI QA Native Host', path: NATIVE_HOST_EXE, type: 'stdio', allowed_origins: Array.from(new Set(origins)) }, null, 2)
  );
  fs.writeFileSync(
    ffManifest,
    JSON.stringify({ name: 'com.tori.download_manager', description: 'TORI QA Native Host FF', path: NATIVE_HOST_EXE, type: 'stdio', allowed_extensions: [firefoxId] }, null, 2)
  );
  for (const k of [
    'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager',
    'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager',
  ]) {
    execFileSync('reg', ['add', k, '/ve', '/t', 'REG_SZ', '/d', chrManifest, '/f'], { stdio: 'ignore', timeout: 4000 });
  }
  execFileSync('reg', ['add', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager', '/ve', '/t', 'REG_SZ', '/d', ffManifest, '/f'], { stdio: 'ignore', timeout: 4000 });
}

function restoreOemNativeHost() {
  try {
    if (fs.existsSync(OEM_HOST_EXE)) {
      execFileSync(OEM_HOST_EXE, ['--register'], { stdio: 'ignore', timeout: 5000 });
    }
  } catch {}
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

function httpJson({ port, reqPath, method = 'GET', headers = {}, timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data, raw });
      });
    });
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
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
  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const ws = new globalThis.WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP connect timeout')); }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = (err) => { clearTimeout(timer); reject(new Error(err?.message || 'CDP error')); };
      ws.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(String(evt.data)); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.res(msg.result);
        }
      };
    });
  }
  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }
      }, timeoutMs);
      this.pending.set(id, {
        res: (v) => { clearTimeout(timer); resolve(v); },
        rej: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalAsync(expression, timeoutMs = 12000, { userGesture = false } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, timeoutMs);
    if (r?.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'Eval exception');
    }
    return r?.result?.value;
  }
  close() { try { this.ws?.close(); } catch {} }
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
        if (String(e.message || e.code).includes('ECONNREFUSED')) { await sleep(300); continue; }
        throw e;
      }
    }
    throw new Error('Marionette connect timeout');
  }
  _connectOnce(timeoutMs) {
    return new Promise((resolve, reject) => {
      this.buf = Buffer.alloc(0);
      const sock = net.createConnection({ host: '127.0.0.1', port: this.port });
      this.socket = sock;
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; sock.destroy(); reject(new Error('Marionette handshake timeout')); } }, timeoutMs);
      sock.on('error', (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
      sock.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        while (true) {
          const ci = this.buf.indexOf(0x3a);
          if (ci === -1) break;
          const len = parseInt(this.buf.subarray(0, ci).toString('ascii'), 10);
          if (Number.isNaN(len) || this.buf.length < ci + 1 + len) break;
          const payload = this.buf.subarray(ci + 1, ci + 1 + len).toString('utf8');
          this.buf = this.buf.subarray(ci + 1 + len);
          const msg = JSON.parse(payload);
          if (msg.marionetteProtocol) {
            if (!done) { done = true; clearTimeout(timer); resolve(msg); }
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Marionette ${cmd} timeout`)); }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(timer); resolve(v); }, rej: (e) => { clearTimeout(timer); reject(e); } });
      const body = JSON.stringify([0, id, cmd, params]);
      this.socket.write(`${Buffer.byteLength(body, 'utf8')}:${body}`);
    });
  }
  async evalAsync(fnBody, timeoutMs = 12000) {
    const r = await this.send('WebDriver:ExecuteAsyncScript', {
      script: `const done = arguments[arguments.length - 1]; Promise.resolve((async () => { ${fnBody} })()).then(v => done({ ok: true, v }), e => done({ ok: false, e: String(e) }));`,
      args: [],
    }, timeoutMs);
    const val = r?.value;
    if (!val?.ok) throw new Error(val?.e || 'Marionette eval failed');
    return val.v;
  }
  close() { try { this.socket?.destroy(); } catch {} }
}

async function waitForCdpTargets(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await httpJson({ port, reqPath: '/json/version', timeoutMs: 2000 });
    const l = await httpJson({ port, reqPath: '/json/list', timeoutMs: 2000 });
    if (v.ok && v.data?.webSocketDebuggerUrl && l.ok && Array.isArray(l.data)) {
      return { version: v.data, targets: l.data };
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for CDP on ${port}`);
}

async function waitForCond(evalFn, expr, timeoutMs = 15000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await evalFn(expr);
      if (v) return v;
    } catch {}
    await sleep(stepMs);
  }
  return null;
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
public static class NativeDlg31 {
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
  if ([NativeDlg31]::Submit([uint32]$ChromePid, $FolderPath)) { Write-Output "OK"; exit 0 }
  Start-Sleep -Milliseconds 150
}
exit 1`,
      'utf8'
    );
    const p = spawn('powershell', ['-NoProfile', '-File', ps1, String(chromePid), folderPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', (c) => { try { fs.unlinkSync(ps1); } catch {} resolve(c === 0 && out.trim() === 'OK'); });
    p.on('error', () => { try { fs.unlinkSync(ps1); } catch {} resolve(false); });
  });
}

function buildInstagramFixtureHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Instagram Gate 31.1 Fixture</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f0f12; color: #fff; font-family: system-ui, sans-serif; }
  /* Mirror real Meta StyleX stacked z-index: 0 + overflow: hidden + role=button shield */
  .ig-mount { position: relative; z-index: 0; padding: 20px; }
  .ig-fixed-header { position: fixed; top: 0; left: 0; right: 0; height: 52px; z-index: 20; pointer-events: none; }
  .ig-scroll-feed { height: 760px; overflow-y: auto; border: 1px solid #262626; padding: 16px; position: relative; }
  .ig-card { width: 380px; margin: 0 auto 28px; background: #000; position: relative; border-radius: 8px; }
  .ig-z0 { position: relative; z-index: 0; width: 380px; height: 640px; }
  .ig-ovclip { overflow: hidden; width: 380px; height: 640px; }
  .ig-vidwrap { position: relative; width: 380px; height: 640px; }
  .ig-vidwrap video { width: 380px; height: 640px; object-fit: cover; display: block; }
  .ig-shield-group { position: absolute; inset: 0; z-index: auto; }
  .ig-shield-pres { position: absolute; inset: 0; z-index: auto; }
  .ig-shield-btn { position: absolute; inset: 0; z-index: auto; cursor: pointer; background: rgba(0,0,0,0.001); }
  .ig-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 500; display: flex; align-items: center; justify-content: center; }
  .ig-modal-dialog { width: 420px; background: #141418; padding: 16px; border-radius: 12px; position: relative; z-index: 501; }
  .ig-modal-dialog .ig-z0, .ig-modal-dialog .ig-ovclip, .ig-modal-dialog .ig-vidwrap, .ig-modal-dialog video { width: 388px; height: 480px; }
  .meta-bar { padding: 8px 10px; font-size: 13px; color: #bbb; display: flex; justify-content: space-between; }
  .meta-bar a { color: #7ca8ff; }
</style>
</head>
<body>
<div class="ig-fixed-header"></div>
<div id="mount_0_0_qa" class="ig-mount">
  <div id="scene-host"></div>
</div>
<script>
  window.__qa = {
    shieldEvents: 0,
    docSpaceCount: 0,
    toggleCount: 0,
    installListeners(root, video) {
      const shield = root.querySelector('.ig-shield-btn');
      const wrap = root.querySelector('.ig-shield-group');
      const mount = document.getElementById('mount_0_0_qa');
      if (shield && !shield.__hooked) {
        shield.__hooked = true;
        ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend'].forEach((t) => {
          shield.addEventListener(t, () => { window.__qa.shieldEvents++; });
        });
        shield.addEventListener('click', (e) => {
          window.__qa.shieldEvents++;
          window.__qa.toggleCount++;
          if (video.paused) video.play().catch(() => {}); else video.pause();
        });
      }
      if (wrap && !wrap.__hooked) {
        wrap.__hooked = true;
        wrap.addEventListener('pointerdown', (e) => {
          if (!e.target.closest('.ig-shield-btn')) window.__qa.shieldEvents++;
        }, true);
      }
      if (mount && !mount.__hooked) {
        mount.__hooked = true;
        ['pointerdown', 'click'].forEach((t) => {
          mount.addEventListener(t, (e) => {
            if (e.target && e.target.closest && e.target.closest('.tori-mp')) {
              window.__qa.shieldEvents++;
            }
          }, true);
        });
      }
    }
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      window.__qa.docSpaceCount++;
      const v = document.querySelector('video');
      if (v) { if (v.paused) v.play().catch(() => {}); else v.pause(); }
    }
  });

  function makeStackedVideoCard({ id, href, src, autoplay = false, inFeedArticle = false }) {
    const card = document.createElement(inFeedArticle ? 'article' : 'div');
    card.className = 'ig-card';
    card.id = id;
    card.innerHTML = \`
      <div class="ig-z0">
        <div class="ig-z0">
          <div class="ig-ovclip">
            <div class="ig-z0">
              <div class="ig-z0">
                <div class="ig-vidwrap"></div>
              </div>
            </div>
          </div>
          <div class="ig-shield-group" role="group" aria-label="Video player">
            <div class="ig-shield-pres" role="presentation">
              <div class="ig-shield-btn" role="button" tabindex="0"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="meta-bar">
        <span>Creator Clip (\${id})</span>
        \${href ? '<a href="' + href + '">View post</a>' : ''}
      </div>
    \`;
    const vid = document.createElement('video');
    vid.id = id + '-vid';
    if (src) vid.src = src;
    vid.loop = true;
    vid.muted = true;
    vid.playsInline = true;
    if (autoplay) vid.autoplay = true;
    card.querySelector('.ig-vidwrap').appendChild(vid);
    window.__qa.installListeners(card, vid);
    return card;
  }

  window.renderScene = function(mode) {
    const host = document.getElementById('scene-host');
    host.innerHTML = '';
    window.__qa.shieldEvents = 0;
    window.__qa.docSpaceCount = 0;
    window.__qa.toggleCount = 0;

    if (mode === 'reel-playing' || mode === 'reel-paused' || mode === 'regular-post') {
      const card = makeStackedVideoCard({
        id: 'reel1',
        href: mode === 'regular-post' ? '/p/QaPost123/' : '/reel/QaReel123/',
        src: '/sample.mp4?scene=' + mode,
        autoplay: mode === 'reel-playing',
      });
      host.appendChild(card);
    } else if (mode === 'modal-video') {
      const bg = makeStackedVideoCard({ id: 'bgvid', href: '/reel/BgReel001/', src: '/sample.mp4?bg=1', autoplay: false });
      host.appendChild(bg);
      const backdrop = document.createElement('div');
      backdrop.className = 'ig-modal-backdrop';
      backdrop.id = 'modal-wrap';
      backdrop.innerHTML = '<div class="ig-modal-dialog" role="dialog" aria-modal="true" aria-label="Instagram Modal"></div>';
      const modalCard = makeStackedVideoCard({ id: 'modalvid', href: '/reel/ModalReel99/', src: '/sample.mp4?modal=1', autoplay: true });
      backdrop.querySelector('.ig-modal-dialog').appendChild(modalCard);
      host.appendChild(backdrop);
    } else if (mode === 'unrelated-modal') {
      const bg = makeStackedVideoCard({ id: 'bgvid', href: '/reel/BgReel001/', src: '/sample.mp4?bg=2', autoplay: false });
      host.appendChild(bg);
      const backdrop = document.createElement('div');
      backdrop.className = 'ig-modal-backdrop';
      backdrop.id = 'login-modal';
      backdrop.innerHTML = '<div class="ig-modal-dialog" role="dialog" aria-modal="true" style="width:480px;height:680px;display:flex;align-items:center;justify-content:center;"><p>Log in dialog</p></div>';
      host.appendChild(backdrop);
    } else if (mode === 'feed') {
      const scroller = document.createElement('div');
      scroller.className = 'ig-scroll-feed';
      scroller.id = 'ig-feed-scroller';
      scroller.appendChild(makeStackedVideoCard({ id: 'feed1', href: '/p/FeedPost111/', src: '/sample.mp4?feed=1', autoplay: true, inFeedArticle: true }));
      const spacer = document.createElement('div');
      spacer.style.height = '320px';
      scroller.appendChild(spacer);
      scroller.appendChild(makeStackedVideoCard({ id: 'feed2', href: '/reel/FeedReel222/', src: '/sample.mp4?feed=2', autoplay: false, inFeedArticle: true }));
      host.appendChild(scroller);
    } else if (mode === 'negative-control-buggy') {
      // Simulate pre-fix bug: mount button INSIDE anchor under z-index:0 BEFORE .ig-shield-group
      // Place it top-left so TORI's portal pill at top-right does not mask its hit-test!
      const card = makeStackedVideoCard({ id: 'buggy1', href: '/reel/Buggy01/', src: '/sample.mp4?buggy=1', autoplay: true });
      host.appendChild(card);
      const wrap = card.querySelector('.ig-vidwrap');
      const fakeBtn = document.createElement('button');
      fakeBtn.id = 'legacy-trapped-pill';
      fakeBtn.textContent = 'Legacy Pill';
      fakeBtn.style.cssText = 'position:absolute;top:12px;left:12px;z-index:2147483640;height:30px;padding:0 12px;';
      fakeBtn.addEventListener('click', (e) => { e.stopPropagation(); window.__legacyClicks = (window.__legacyClicks || 0) + 1; });
      wrap.appendChild(fakeBtn);
      window.__legacyClicks = 0;
    }
  };
</script>
</body>
</html>`;
}

function seedQaSqlite(dbPath) {
  const py = `
import sqlite3, json, sys
db_path, dl_dir, token, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
app_settings = {
  "dir": dl_dir, "sort": True, "con": 4, "maxa": 3, "limMode": "off", "limV": 512, "limU": "KiB/s",
  "retries": 1, "dyn": True, "mps": 256, "mpsU": "KiB", "ua": "", "ssl": False, "lm": False,
  "track": True, "dns": "System DNS", "proxy": "none", "port": port, "key": token,
  "cap": True, "theme": "light", "accent": "indigo", "motion": False, "details": False,
  "showDownloadPopup": "never", "alwaysOnTop": False, "closeToTray": True
}
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES ('app_settings', ?)", (json.dumps(app_settings),))
conn.commit()
conn.close()
`;
  execFileSync('python', ['-c', py, dbPath, QA_DL_DIR, API_TOKEN, String(DESKTOP_PORT)], { stdio: 'inherit' });
}

function ensureSampleMp4() {
  if (fs.existsSync(QA_SAMPLE_MP4) && fs.statSync(QA_SAMPLE_MP4).size > 4096) return;
  execFileSync(
    FFMPEG_EXE,
    ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=360x640:rate=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', QA_SAMPLE_MP4],
    { stdio: 'ignore', timeout: 15000 }
  );
}

async function launchChromium(label, exe, profDir, cdpPort, env) {
  fs.mkdirSync(path.join(profDir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profDir, 'First Run'), '');
  const dlDir = path.join(QA_ROOT, `${label.toLowerCase()}_dl`);
  fs.mkdirSync(dlDir, { recursive: true });
  fs.writeFileSync(
    path.join(profDir, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: dlDir, prompt_for_download: false }, profile: { default_content_setting_values: { automatic_downloads: 1 } } })
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
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,900',
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
    const tList = (await waitForCdpTargets(cdpPort, 5000)).targets;
    mgrTgt = tList.find((t) => t.id === mgrCreated.targetId && t.webSocketDebuggerUrl);
    if (mgrTgt) break;
    await sleep(200);
  }
  const mgrCdp = new CDPClient(mgrTgt.webSocketDebuggerUrl);
  await mgrCdp.connect();
  await waitForCond((e) => mgrCdp.evalAsync(e), `typeof chrome !== 'undefined' && !!chrome.developerPrivate && document.readyState === 'complete'`, 12000);
  await mgrCdp.evalAsync(`chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })`, 6000);

  const findExt = async () => {
    const xs = await mgrCdp.evalAsync(`chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true })`, 6000);
    return (xs || []).find((x) => String(x.name || '').includes('TORI') && x.version === '1.0.10');
  };
  let ext = await findExt();
  if (!ext) {
    const loadP = mgrCdp.evalAsync(`chrome.developerPrivate.loadUnpacked().then(() => 'OK').catch(e => String(e))`, 20000, { userGesture: true });
    const dlgOk = await submitChromeFolderDialogWin32(proc.pid, CHR_EXT_DIR);
    await loadP;
    if (!dlgOk) throw new Error(`${label} Win32 folder dialog submission failed`);
    await sleep(600);
    ext = await findExt();
  }
  if (!ext?.id) throw new Error(`${label} failed to load TORI v1.0.10`);
  mgrCdp.close();
  await bCdp.send('Target.closeTarget', { targetId: mgrCreated.targetId }).catch(() => {});

  const tabCreated = await bCdp.send('Target.createTarget', { url: `http://127.0.0.1:${FIXTURE_PORT}/fixture/reel/Init01/` });
  let tabTgt = null;
  for (let i = 0; i < 25; i++) {
    const tList = (await waitForCdpTargets(cdpPort, 5000)).targets;
    tabTgt = tList.find((t) => t.id === tabCreated.targetId && t.webSocketDebuggerUrl);
    if (tabTgt) break;
    await sleep(200);
  }
  const pageCdp = new CDPClient(tabTgt.webSocketDebuggerUrl);
  await pageCdp.connect();
  await pageCdp.send('Page.enable');
  await pageCdp.send('Runtime.enable');

  const configureExt = async (patch) => {
    const optCreated = await bCdp.send('Target.createTarget', { url: `chrome-extension://${ext.id}/options/options.html` });
    let optTgt = null;
    for (let i = 0; i < 20; i++) {
      const tList = (await waitForCdpTargets(cdpPort, 5000)).targets;
      optTgt = tList.find((t) => t.id === optCreated.targetId && t.webSocketDebuggerUrl);
      if (optTgt) break;
      await sleep(150);
    }
    const oc = new CDPClient(optTgt.webSocketDebuggerUrl);
    await oc.connect();
    await waitForCond((e) => oc.evalAsync(e), `typeof chrome !== 'undefined' && !!chrome.storage`, 8000);
    await oc.evalAsync(`new Promise(r => chrome.storage.local.get('tori_settings', cur => {
      const merged = { ...(cur.tori_settings || {}), ...${JSON.stringify(patch)} };
      chrome.storage.local.set({ tori_settings: merged, tori_theme: merged.theme || 'light', tori_accent: merged.accent || 'indigo' }, () => r(true));
    }))`);
    oc.close();
    await bCdp.send('Target.closeTarget', { targetId: optCreated.targetId }).catch(() => {});
  };

  return {
    label,
    extId: ext.id,
    proc,
    bCdp,
    cdp: pageCdp,
    evalExpr: (expr) => pageCdp.evalAsync(expr),
    navigate: async (url) => {
      await pageCdp.send('Page.navigate', { url });
      await sleep(700);
    },
    clickAt: async (x, y) => {
      await pageCdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await sleep(40);
      await pageCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
      await sleep(40);
      await pageCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
    },
    pressKey: async (key) => {
      const def =
        key === ' '
          ? { key: ' ', code: 'Space', text: ' ', unmodifiedText: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }
          : key === 'Enter'
          ? { key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
          : { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
      await pageCdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...def });
      if (def.text) await pageCdp.send('Input.dispatchKeyEvent', { type: 'char', ...def });
      await pageCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...def });
    },
    screenshot: async (name) => {
      const shot = await pageCdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS_DIR, name), Buffer.from(shot.data, 'base64'));
    },
    configureExt,
    close: () => {
      pageCdp.close();
      bCdp.close();
      if (proc.pid) killProcTree(proc.pid);
    },
  };
}

async function launchFirefox(env) {
  fs.mkdirSync(QA_FF_PROF, { recursive: true });
  fs.writeFileSync(
    path.join(QA_FF_PROF, 'user.js'),
    [
      'user_pref("marionette.enabled", true);',
      `user_pref("marionette.port", ${FF_MARIONETTE_PORT});`,
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("browser.startup.homepage_override.mstone", "ignore");',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.enabled", false);',
      'user_pref("xpinstall.signatures.required", true);', // STRICT MOZILLA SIGNATURE ENFORCEMENT!
      'user_pref("media.autoplay.default", 0);',
    ].join('\n'),
    'utf8'
  );

  const proc = spawn(
    FIREFOX_EXE,
    ['-no-remote', '-marionette', '-profile', QA_FF_PROF, `http://127.0.0.1:${FIXTURE_PORT}/fixture/reel/Init01/`],
    { env: { ...env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }, stdio: 'ignore' }
  );
  trackedProcs.add(proc);

  const mar = new MarionetteClient(FF_MARIONETTE_PORT);
  await mar.connect(25000);
  await mar.send('WebDriver:NewSession', { capabilities: {} });
  await mar.send('WebDriver:SetWindowRect', { width: 1280, height: 900 });

  // PERMANENT INSTALLATION (temporary: false) OF MOZILLA-SIGNED XPI UNDER STRICT SIGNATURE ENFORCEMENT
  const inst = await mar.send('Addon:Install', { path: SIGNED_FF_XPI, temporary: false }, 25000);
  if (inst?.value !== EXPECTED_GECKO_ID) throw new Error(`Firefox Addon:Install mismatch: ${JSON.stringify(inst)}`);

  await mar.send('Marionette:SetContext', { value: 'chrome' });
  const sigCheck = (await mar.send('WebDriver:ExecuteAsyncScript', {
    script: `
      const done = arguments[arguments.length - 1];
      (async () => {
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const sigReq = Services.prefs.getBoolPref("xpinstall.signatures.required", false);
        let addon = null, policy = null;
        for (let i = 0; i < 30; i++) {
          addon = await AddonManager.getAddonByID("${EXPECTED_GECKO_ID}");
          policy = WebExtensionPolicy.getByID("${EXPECTED_GECKO_ID}");
          if (addon && addon.isActive && policy && policy.active) break;
          await new Promise(r => setTimeout(r, 200));
        }
        done({
          sigRequiredPref: sigReq,
          installedId: addon?.id || null,
          version: addon?.version || null,
          isActive: !!addon?.isActive,
          temporarilyInstalled: addon?.temporarilyInstalled,
          signedState: addon?.signedState,
          expectedSignedState: AddonManager.SIGNEDSTATE_SIGNED,
          signedMatch: addon?.signedState === AddonManager.SIGNEDSTATE_SIGNED,
          baseUrl: policy ? policy.getURL("") : null,
        });
      })();
    `,
    args: [],
  }, 15000))?.value;

  const sigOk = Boolean(
    inst?.value === EXPECTED_GECKO_ID &&
      sigCheck?.sigRequiredPref === true &&
      sigCheck?.installedId === EXPECTED_GECKO_ID &&
      sigCheck?.version === '1.0.10' &&
      sigCheck?.isActive === true &&
      sigCheck?.temporarilyInstalled === false &&
      sigCheck?.signedMatch === true &&
      String(sigCheck?.baseUrl || '').startsWith('moz-extension://')
  );
  record(
    'Firefox',
    'FF110-SIG-01',
    'Clean Firefox profile with xpinstall.signatures.required=true accepts and activates signed v1.0.10 XPI permanently',
    sigOk,
    JSON.stringify(sigCheck)
  );
  if (!sigOk) throw new Error(`Mozilla signature validation failed: ${JSON.stringify(sigCheck)}`);

  const mozUrl = sigCheck.baseUrl;
  await mar.send('WebDriver:ExecuteScript', {
    script: `
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      win.gBrowser.addTrustedTab("${mozUrl}options/options.html");
      win.gBrowser.addTrustedTab("${mozUrl}popup/popup.html");
    `,
    args: [],
  });
  await sleep(1000);

  await mar.send('Marionette:SetContext', { value: 'content' });
  const rawHandles = await mar.send('WebDriver:GetWindowHandles', {});
  const handles = Array.isArray(rawHandles) ? rawHandles : (rawHandles?.value || []);
  let optH = null;
  let popH = null;
  let tabH = null;
  for (const h of handles) {
    await mar.send('WebDriver:SwitchToWindow', { handle: h });
    const u = (await mar.send('WebDriver:GetCurrentURL', {}))?.value || '';
    if (u.includes('options/options.html')) optH = h;
    else if (u.includes('popup/popup.html')) popH = h;
    else if (u.includes('/fixture/')) tabH = h;
  }
  if (!optH || !tabH) throw new Error(`Firefox handles not found: optH=${optH}, tabH=${tabH}, handles=${JSON.stringify(handles)}`);

  // Verify Native Messaging Pair & Reconnect
  await mar.send('WebDriver:SwitchToWindow', { handle: optH });
  const nativeRes = (await mar.send('WebDriver:ExecuteAsyncScript', {
    script: `
      const done = arguments[arguments.length - 1];
      (async () => {
        try {
          const api = typeof browser !== 'undefined' ? browser : chrome;
          await api.storage.local.set({
            tori_settings: {
              port: ${DESKTOP_PORT}, key: '', auto: true, cap: true, min: 0, pill: true,
              pos: 'Top right', picker: true, kind: 'Video', fmt: 'Best available',
              audio: true, badge: true, theme: 'light', accent: 'indigo',
              sites: [], types: ['zip','mkv','mp4']
            }
          });
          const pairRes = await api.runtime.sendMessage({ action: 'INITIATE_PAIRING' });
          const reconnRes = await api.runtime.sendMessage({ action: 'RECONNECT_DESKTOP', port: ${DESKTOP_PORT}, key: '' });
          done({ pairRes, reconnRes });
        } catch (e) { done({ error: String(e) }); }
      })();
    `,
    args: [],
  }, 15000))?.value;

  const nativeOk = Boolean(
    nativeRes?.pairRes?.ok === true &&
      nativeRes?.pairRes?.token === API_TOKEN &&
      nativeRes?.reconnRes?.status === 'ok' &&
      nativeRes?.reconnRes?.nativeHost === true
  );
  record(
    'Firefox',
    'FF110-NATIVE-01',
    'Signed Firefox v1.0.10 Native Messaging INITIATE_PAIRING and RECONNECT_DESKTOP authenticate cleanly with QA Desktop',
    nativeOk,
    JSON.stringify(nativeRes)
  );

  // Check Popup & Options UI
  let popCheck = null;
  if (popH) {
    await mar.send('WebDriver:SwitchToWindow', { handle: popH });
    await sleep(400);
    popCheck = (await mar.send('WebDriver:ExecuteScript', {
      script: `return { text: document.body.innerText, hasConnected: /Connected/i.test(document.body.innerText) };`,
      args: [],
    }))?.value;
  }
  await mar.send('WebDriver:SwitchToWindow', { handle: optH });
  await mar.send('WebDriver:Refresh', {});
  await sleep(400);
  const optCheck = (await mar.send('WebDriver:ExecuteScript', {
    script: `return { text: document.body.innerText, hasVer110: document.body.innerText.includes('1.0.10'), portVal: document.getElementById('port')?.value || null };`,
    args: [],
  }))?.value;
  record(
    'Firefox',
    'FF110-CONN-01',
    'Firefox Popup & Options UI connect cleanly to v1.0.5 Desktop and display v1.0.10 metadata',
    Boolean(optCheck?.hasVer110),
    JSON.stringify({ popConnected: popCheck?.hasConnected, optVer110: optCheck?.hasVer110, optPort: optCheck?.portVal })
  );

  const configureExt = async (patch) => {
    await mar.send('WebDriver:SwitchToWindow', { handle: optH });
    await mar.evalAsync(`
      const api = typeof browser !== 'undefined' ? browser : chrome;
      const cur = await api.storage.local.get('tori_settings');
      const merged = { ...(cur.tori_settings || {}), ...${JSON.stringify(patch)} };
      await api.storage.local.set({ tori_settings: merged, tori_theme: merged.theme || 'light', tori_accent: merged.accent || 'indigo' });
      return true;
    `);
    await mar.send('WebDriver:SwitchToWindow', { handle: tabH });
  };

  return {
    label: 'Firefox',
    extId: EXPECTED_GECKO_ID,
    proc,
    mar,
    evalExpr: (expr) => mar.evalAsync(`return (${expr});`),
    navigate: async (url) => {
      await mar.send('WebDriver:SwitchToWindow', { handle: tabH });
      await mar.send('WebDriver:Navigate', { url }, 45000);
      await sleep(700);
    },
    clickAt: async (x, y) => {
      await mar.send('WebDriver:PerformActions', {
        actions: [{
          type: 'pointer', id: 'mouse1', parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 40 },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      });
      await mar.send('WebDriver:ReleaseActions', {});
    },
    pressKey: async (key) => {
      const k = key === ' ' ? ' ' : key === 'Enter' ? '\uE007' : '\uE00C';
      await mar.send('WebDriver:PerformActions', {
        actions: [{
          type: 'key', id: 'kbd1',
          actions: [{ type: 'keyDown', value: k }, { type: 'pause', duration: 40 }, { type: 'keyUp', value: k }],
        }],
      });
      await mar.send('WebDriver:ReleaseActions', {});
    },
    screenshot: async (name) => {
      const shot = await mar.send('WebDriver:TakeScreenshot', { full: false });
      fs.writeFileSync(path.join(SHOTS_DIR, name), Buffer.from(shot.value, 'base64'));
    },
    configureExt,
    close: () => { try { mar.close(); } catch {} if (proc.pid) killProcTree(proc.pid); },
  };
}

async function runInstagramBrowserSuite(drv) {
  const B = drv.label;
  console.log(`\n==================== ${B.toUpperCase()} GATE 31.1 SUITE ====================`);

  await drv.configureExt({
    port: DESKTOP_PORT,
    key: API_TOKEN,
    auto: true,
    cap: true,
    min: 0,
    pill: true,
    pos: 'Top right',
    picker: true,
    kind: 'Video',
    fmt: 'Best available',
    audio: true,
    badge: true,
    theme: 'light',
    accent: 'indigo',
    sites: [],
  });

  // ------------------------------------------------------------------
  // Negative control: Prove un-isolated z-index:0 child pill fails
  // ------------------------------------------------------------------
  await drv.navigate(`http://127.0.0.1:${FIXTURE_PORT}/fixture/reel/BuggyCtrl01/`);
  await drv.evalExpr(`(window.renderScene('negative-control-buggy'), true)`);
  await sleep(250);
  const negRect = await drv.evalExpr(`(() => {
    const r = document.getElementById('legacy-trapped-pill').getBoundingClientRect();
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
  })()`);
  await drv.clickAt(negRect.cx, negRect.cy);
  await sleep(150);
  const negState = await drv.evalExpr(`({
    legacyClicks: window.__legacyClicks,
    shieldEvents: window.__qa.shieldEvents,
    hitRole: document.elementFromPoint(${negRect.cx}, ${negRect.cy})?.getAttribute('role')
  })`);
  record(B, 'NEG-CTRL', 'Un-isolated z-index:0 child pill fails (hits role=button shield instead of pill)', negState.legacyClicks === 0 && negState.shieldEvents > 0 && negState.hitRole === 'button', JSON.stringify(negState));

  // ------------------------------------------------------------------
  // Fixtures Scenarios 1-9 & 12 (Exact StyleX/React Stacking Harness)
  // ------------------------------------------------------------------
  const scenarios = [
    { id: 'IG-1-PAUSED', mode: 'reel-paused', url: `/fixture/reel/IgPaused01/`, expectPlaying: false },
    { id: 'IG-2-PLAYING', mode: 'reel-playing', url: `/fixture/reel/IgPlay01/`, expectPlaying: true },
    { id: 'IG-3-POST', mode: 'regular-post', url: `/fixture/p/IgPost01/`, expectPlaying: false },
    { id: 'IG-4-MODAL', mode: 'modal-video', url: `/fixture/profile/modal/`, expectPlaying: true },
  ];

  for (const sc of scenarios) {
    await drv.navigate(`http://127.0.0.1:${FIXTURE_PORT}${sc.url}`);
    await drv.evalExpr(`(window.renderScene('${sc.mode}'), true)`);
    if (sc.expectPlaying) {
      await waitForCond(drv.evalExpr, `(() => { const vs = Array.from(document.querySelectorAll('video')); const v = vs[vs.length - 1]; return v && v.readyState >= 2 && !v.paused; })()`, 8000);
    } else {
      await waitForCond(drv.evalExpr, `(() => { const vs = Array.from(document.querySelectorAll('video')); const v = vs[vs.length - 1]; return v && v.readyState >= 1; })()`, 8000);
    }
    const mounted = await waitForCond(
      drv.evalExpr,
      `(() => {
        const visibleMps = Array.from(document.querySelectorAll('.tori-mp')).filter(m => {
          const f = m.closest('.tori-anchor-frame');
          const r = m.querySelector('.tori-pill')?.getBoundingClientRect();
          return (!f || getComputedStyle(f).display !== 'none') && r && r.width > 20;
        });
        const targetMp = visibleMps[visibleMps.length - 1];
        if (!targetMp) return null;
        const p = targetMp.querySelector('.tori-pill');
        const r = p.getBoundingClientRect();
        const vids = Array.from(document.querySelectorAll('video'));
        const v = vids[vids.length - 1];
        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), vidPaused: v.paused, visMpCount: visibleMps.length };
      })()`,
      10000
    );
    const hitSelf = await drv.evalExpr(`(() => {
      const top = document.elementFromPoint(${mounted.cx}, ${mounted.cy});
      const portal = document.getElementById('tori-overlay-portal-host');
      return {
        topTag: top?.tagName,
        inPill: !!top?.closest('.tori-pill'),
        inPortal: !!(portal && portal.contains(top)),
        hasShadow: !!portal?.shadowRoot,
      };
    })()`);
    await drv.evalExpr(`(window.__qa.shieldEvents = 0, window.__qa.toggleCount = 0, true)`);
    await drv.clickAt(mounted.cx, mounted.cy);
    await sleep(220);
    const postClick = await drv.evalExpr(`(() => {
      const vids = Array.from(document.querySelectorAll('video'));
      const v = vids[vids.length - 1];
      const visibleMps = Array.from(document.querySelectorAll('.tori-mp')).filter(m => {
        const f = m.closest('.tori-anchor-frame');
        const r = m.querySelector('.tori-pill')?.getBoundingClientRect();
        return (!f || getComputedStyle(f).display !== 'none') && r && r.width > 20;
      });
      const mp = visibleMps[visibleMps.length - 1];
      return {
        pnOpen: !!mp?.querySelector('.tori-pn')?.classList.contains('on'),
        ariaExpanded: mp?.querySelector('.tori-pill')?.getAttribute('aria-expanded'),
        pausedAfter: v?.paused,
        shieldEvents: window.__qa.shieldEvents,
        toggleCount: window.__qa.toggleCount,
      };
    })()`);

    let outsideOk = true;
    if (sc.id === 'IG-2-PLAYING') {
      // Verify video outside pill still toggles playback normally AND outside click closes TORI panel
      const vidPt = await drv.evalExpr(`(() => { const r = document.querySelector('video').getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);
      await drv.clickAt(vidPt.x, vidPt.y);
      await sleep(180);
      const afterOut = await drv.evalExpr(`({ paused: document.querySelector('video').paused, pnOpen: document.querySelector('.tori-pn')?.classList.contains('on'), toggles: window.__qa.toggleCount })`);
      outsideOk = afterOut.paused === true && afterOut.pnOpen === false && afterOut.toggles === 1;
    }

    const ok =
      Boolean(hitSelf?.inPill && hitSelf?.hasShadow && hitSelf?.inPortal) &&
      postClick.pnOpen === true &&
      postClick.ariaExpanded === 'true' &&
      postClick.pausedAfter === mounted.vidPaused &&
      postClick.shieldEvents === 0 &&
      outsideOk;
    record(B, sc.id, `${sc.mode}: elementFromPoint hits .tori-pill, click opens panel without toggling video`, ok, JSON.stringify({ hitSelf, mounted, postClick, outsideOk }));
  }

  // Verify unrelated blocking modal hides background overlay & reveals again when dismissed
  await drv.navigate(`http://127.0.0.1:${FIXTURE_PORT}/fixture/feed/unrelated/`);
  await drv.evalExpr(`(window.renderScene('unrelated-modal'), true)`);
  await sleep(350);
  const bgHidden = await drv.evalExpr(`(() => { const f = document.querySelector('.tori-anchor-frame'); return !f || getComputedStyle(f).display === 'none'; })()`);
  await drv.evalExpr(`(document.getElementById('login-modal')?.remove(), true)`);
  await sleep(300);
  const bgRestored = await drv.evalExpr(`(() => { const p = document.querySelector('.tori-pill'); return !!p && getComputedStyle(p.closest('.tori-anchor-frame')).display !== 'none'; })()`);
  record(B, 'IG-4B-OCCLUDE', 'Unrelated aria-modal hides covered background pill and restores on dismiss', bgHidden && bgRestored, `hidden=${bgHidden}, restored=${bgRestored}`);

  // ------------------------------------------------------------------
  // IG-5: Feed Video & Scroll Sync Tracking
  // ------------------------------------------------------------------
  await drv.navigate(`http://127.0.0.1:${FIXTURE_PORT}/fixture/feed/`);
  await drv.evalExpr(`(window.renderScene('feed'), true)`);
  await sleep(350);
  const feedClickPt = await drv.evalExpr(`(() => {
    const c = document.getElementById('feed1');
    const vr = c.querySelector('video').getBoundingClientRect();
    const pills = Array.from(document.querySelectorAll('.tori-pill')).map(p => ({ p, r: p.getBoundingClientRect(), vis: getComputedStyle(p.closest('.tori-anchor-frame')).display !== 'none' }));
    const visCount = pills.filter(x => x.vis && x.r.width > 0).length;
    const topPill = pills[0];
    return {
      visCount,
      deltaTop: Math.abs(topPill.r.top - (vr.top + 12)),
      cx: Math.round(topPill.r.left + topPill.r.width / 2),
      cy: Math.round(topPill.r.top + topPill.r.height / 2),
      paused: c.querySelector('video').paused,
    };
  })()`);
  await drv.clickAt(feedClickPt.cx, feedClickPt.cy);
  await sleep(200);
  const feedAfter = await drv.evalExpr(`({
    pnOpen: document.querySelectorAll('.tori-pn')[0]?.classList.contains('on'),
    paused: document.getElementById('feed1-vid').paused,
    shieldEvents: window.__qa.shieldEvents,
  })`);
  // Scroll second feed video into view and verify frame syncs precisely
  await drv.evalExpr(`(() => { const s = document.getElementById('ig-feed-scroller'); s.scrollTop = s.scrollHeight; return true; })()`);
  await sleep(250);
  const scrolledSync = await drv.evalExpr(`(() => {
    const f2 = document.getElementById('feed2');
    const vr = f2.querySelector('video').getBoundingClientRect();
    const p2 = document.querySelectorAll('.tori-pill')[1].getBoundingClientRect();
    return { deltaTop: Math.round(Math.abs(p2.top - (vr.top + 12))), vis: getComputedStyle(document.querySelectorAll('.tori-anchor-frame')[1]).display !== 'none' };
  })()`);
  record(B, 'IG-5-FEED', 'Feed cards suppress offscreen pill, keep visible pill isolated & synced on scroll', feedClickPt.deltaTop < 4 && feedAfter.pnOpen && feedAfter.shieldEvents === 0 && scrolledSync.vis && scrolledSync.deltaTop < 4, JSON.stringify({ feedClickPt, feedAfter, scrolledSync }));

  // ------------------------------------------------------------------
  // IG-6 (Deterministic): SPA Navigation between multiple Reels
  // ------------------------------------------------------------------
  await drv.navigate(`http://127.0.0.1:${FIXTURE_PORT}/fixture/reel/SpaReelAlpha/`);
  await drv.evalExpr(`(window.renderScene('reel-playing'), true)`);
  await waitForCond(drv.evalExpr, `!!document.querySelector('.tori-pill') && document.querySelector('video')?.readyState >= 2`, 8000);
  await drv.evalExpr(`(() => {
    window.__qa.shieldEvents = 0;
    const v = document.querySelector('video');
    v.pause();
    v.src = '/sample.mp4?spa=beta';
    v.load();
    v.play().catch(() => {});
    history.replaceState({}, '', '/fixture/reel/SpaReelBeta/');
    return true;
  })()`);
  await waitForCond(drv.evalExpr, `(() => { const v = document.querySelector('video'); return v && v.readyState >= 2 && !v.paused && location.pathname.includes('SpaReelBeta'); })()`, 8000);
  await sleep(750);
  const spaFixPt = await drv.evalExpr(`(() => {
    const mp = document.querySelector('.tori-mp');
    if (!mp) return null;
    const r = mp.querySelector('.tori-pill').getBoundingClientRect();
    return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2), paused: document.querySelector('video').paused, href: location.href };
  })()`);
  let spaFixPass = false;
  if (spaFixPt) {
    await drv.clickAt(spaFixPt.cx, spaFixPt.cy);
    await sleep(300);
    const afterSpaFix = await drv.evalExpr(`({
      pnOpen: document.querySelector('.tori-pn')?.classList.contains('on'),
      paused: document.querySelector('video')?.paused,
      shieldEvents: window.__qa.shieldEvents,
      tag: document.querySelector('.tori-pill-tag')?.textContent?.trim(),
    })`);
    spaFixPass = String(spaFixPt.href).includes('SpaReelBeta') && afterSpaFix.pnOpen && afterSpaFix.paused === spaFixPt.paused && afterSpaFix.shieldEvents === 0;
  }
  record(B, 'IG-6-SPA-NAV', 'SPA navigation invalidates previous Reel identity and keeps overlay isolated', spaFixPass, JSON.stringify(spaFixPt));

  // ------------------------------------------------------------------
  // IG-7: Dynamic DOM Replacement & Resize Recovery
  // ------------------------------------------------------------------
  await drv.navigate(`http://127.0.0.1:${FIXTURE_PORT}/fixture/reel/DynDom01/`);
  await drv.evalExpr(`(window.renderScene('reel-playing'), true)`);
  await waitForCond(drv.evalExpr, `!!document.querySelector('.tori-pill')`, 8000);
  await drv.evalExpr(`(() => {
    const v = document.getElementById('reel1-vid');
    const oldWrap = v.parentElement;
    const newWrap = document.createElement('div');
    newWrap.className = 'ig-vidwrap';
    oldWrap.parentElement.replaceChild(newWrap, oldWrap);
    newWrap.appendChild(v);
    // Inject late higher-z click shield sibling
    const lateShield = document.createElement('div');
    lateShield.className = 'ig-shield-btn';
    lateShield.setAttribute('role', 'button');
    lateShield.style.zIndex = '99999';
    lateShield.addEventListener('click', () => { window.__qa.shieldEvents++; window.__qa.toggleCount++; if (v.paused) v.play(); else v.pause(); });
    newWrap.parentElement.appendChild(lateShield);
    window.__qa.shieldEvents = 0;
    window.__qa.toggleCount = 0;
    return true;
  })()`);
  // Wait >150ms so debounced MutationObserver scan detects detached anchor and re-attaches fresh portal overlay
  await sleep(320);
  const dynPt = await waitForCond(
    drv.evalExpr,
    `(() => {
      const p = document.querySelector('.tori-pill');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      if (r.width < 20) return null;
      const hit = document.elementFromPoint(Math.round(r.left + r.width/2), Math.round(r.top + r.height/2));
      if (!hit || !hit.closest('.tori-pill')) return null;
      return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2), paused: document.getElementById('reel1-vid').paused };
    })()`,
    8000
  );
  await drv.clickAt(dynPt.cx, dynPt.cy);
  await sleep(250);
  const dynAfter = await drv.evalExpr(`({ pnOpen: document.querySelector('.tori-pn')?.classList.contains('on'), paused: document.getElementById('reel1-vid').paused, shieldEvents: window.__qa.shieldEvents })`);
  record(B, 'IG-7-DYNDOM', 'Recovers clickable overlay above late high-z click shield after anchor DOM replacement', Boolean(dynPt) && dynAfter.pnOpen && dynAfter.paused === dynPt.paused && dynAfter.shieldEvents === 0, JSON.stringify({ dynPt, dynAfter }));

  // ------------------------------------------------------------------
  // IG-12: Keyboard Activation (Space / Enter / Escape) without toggling playback
  // ------------------------------------------------------------------
  await drv.evalExpr(`(() => { const pn = document.querySelector('.tori-pn'); if (pn?.classList.contains('on')) pn.classList.remove('on'); window.__qa.docSpaceCount = 0; document.querySelector('.tori-pill').focus(); return document.activeElement === document.querySelector('.tori-pill'); })()`);
  await drv.pressKey(' ');
  await sleep(200);
  const kbdOpen = await drv.evalExpr(`({ pnOpen: document.querySelector('.tori-pn')?.classList.contains('on'), expanded: document.querySelector('.tori-pill')?.getAttribute('aria-expanded'), docSpace: window.__qa.docSpaceCount })`);
  await drv.pressKey('Escape');
  await sleep(180);
  const kbdClose = await drv.evalExpr(`({ pnOpen: document.querySelector('.tori-pn')?.classList.contains('on'), expanded: document.querySelector('.tori-pill')?.getAttribute('aria-expanded'), focusedPill: document.activeElement === document.querySelector('.tori-pill'), docSpace: window.__qa.docSpaceCount })`);
  record(B, 'IG-12-KEYBD', 'Keyboard Space opens picker and Escape closes without leaking hotkey to video player', kbdOpen.pnOpen === true && kbdOpen.docSpace === 0 && kbdClose.pnOpen === false && kbdClose.focusedPill === true && kbdClose.docSpace === 0, JSON.stringify({ kbdOpen, kbdClose }));

  // ------------------------------------------------------------------
  // IG-8, IG-9, IG-11, Regression (Theme/FB/Direct): Failure, Retry Recovery, Rapid Clicks
  // ------------------------------------------------------------------
  await drv.configureExt({ port: DESKTOP_PORT, picker: true, theme: 'dark', accent: 'ocean' });
  await drv.navigate(`http://127.0.0.1:${FIXTURE_PORT}/fixture/failtest/`);
  await drv.evalExpr(`(() => {
    const host = document.getElementById('scene-host');
    host.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'ig-card';
    const wrap = document.createElement('div');
    wrap.className = 'ig-vidwrap';
    const v = document.createElement('video');
    v.id = 'fail-vid';
    v.width = 380;
    v.height = 320;
    v.controls = true;
    wrap.appendChild(v);
    d.appendChild(wrap);
    host.appendChild(d);
    return true;
  })()`);
  await waitForCond(drv.evalExpr, `!!document.querySelector('.tori-pill')`, 8000);
  const pPt = await drv.evalExpr(`(() => { const r = document.querySelector('.tori-pill').getBoundingClientRect(); return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) }; })()`);
  await drv.clickAt(pPt.cx, pPt.cy);
  const errState = await waitForCond(
    drv.evalExpr,
    `(() => {
      const mp = document.querySelector('.tori-mp');
      const tag = document.querySelector('.tori-pill-tag')?.textContent?.trim();
      const stateTitle = document.querySelector('.tori-pn .state b')?.textContent?.trim();
      const isDark = mp?.classList.contains('tori-dark');
      const accent = mp?.getAttribute('data-accent');
      const retry = document.querySelector('[data-act="retry"]');
      if (tag === 'Unavailable' && stateTitle && retry) {
        return { tag, stateTitle, hasRetry: true, isDark, accent };
      }
      return null;
    })()`,
    24000
  );
  const failDiagSnapshot = errState || await drv.evalExpr(`({
    tag: document.querySelector('.tori-pill-tag')?.textContent?.trim(),
    stateTitle: document.querySelector('.tori-pn .state b')?.textContent?.trim(),
    pnOpen: document.querySelector('.tori-pn')?.classList.contains('on'),
    pnText: document.querySelector('.tori-pn')?.innerText?.replace(/\\s+/g, ' ').trim()?.slice(0, 180),
    isDark: document.querySelector('.tori-mp')?.classList.contains('tori-dark'),
    accent: document.querySelector('.tori-mp')?.getAttribute('data-accent'),
  })`);
  // Inject a valid stream and click real Retry resolution button -> must recover to playable formats
  let retryRecovered = false;
  if (errState?.hasRetry) {
    const retryPt = await drv.evalExpr(`(() => {
      const v = document.getElementById('fail-vid');
      v.src = '/sample.mp4?recovered=' + Date.now();
      v.load();
      const r = document.querySelector('[data-act="retry"]').getBoundingClientRect();
      return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) };
    })()`);
    await drv.clickAt(retryPt.cx, retryPt.cy);
    retryRecovered = Boolean(await waitForCond(
      drv.evalExpr,
      `(() => {
        const dl = document.querySelector('.tori-mp [data-act="download"]');
        return dl && !dl.disabled && document.querySelectorAll('.tori-fr').length >= 1;
      })()`,
      20000
    ));
  }
  record(B, 'IG-11-ERR-RECOV', 'Resolution failure leaves Resolving state cleanly with actionable error and real Retry button recovery', Boolean(errState?.hasRetry && errState?.tag === 'Unavailable' && retryRecovered), JSON.stringify({ failDiagSnapshot, retryRecovered }));
  record(B, 'REGR-THEME', 'Theme persistence applies tori-dark + ocean accent inside top-level portal overlay', Boolean(failDiagSnapshot?.isDark && failDiagSnapshot?.accent === 'ocean'), JSON.stringify({ isDark: failDiagSnapshot?.isDark, accent: failDiagSnapshot?.accent }));

  // Verify Picker Mode 5 Rapid Clicks -> 1 Job, then Direct Mode (picker: false) 5 Rapid Clicks -> 1 Job (unique URLs per browser!)
  await drv.configureExt({ port: DESKTOP_PORT, picker: true, theme: 'light', accent: 'indigo' });
  await drv.navigate(`http://127.0.0.1:${FIXTURE_PORT}/fixture/p/IgRapid_${B}/`);
  await drv.evalExpr(`(window.renderScene('regular-post'), true)`);
  await drv.evalExpr(`(() => { const v = document.querySelector('video'); v.src = '/sample.mp4?rapid=${B}_' + Date.now(); v.load(); return true; })()`);
  await waitForCond(drv.evalExpr, `!!document.querySelector('.tori-pill') && document.querySelector('video').readyState >= 1`, 8000);
  const rapidPill = await drv.evalExpr(`(() => { const r = document.querySelector('.tori-pill').getBoundingClientRect(); return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) }; })()`);
  await drv.clickAt(rapidPill.cx, rapidPill.cy);
  const dlReady = await waitForCond(
    drv.evalExpr,
    `(() => { const b = document.querySelector('.tori-mp [data-act="download"]'); return b && !b.disabled && document.querySelectorAll('.tori-fr').length >= 1; })()`,
    20000
  );
  const beforeJobs = await httpJson({ port: DESKTOP_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': API_TOKEN } });
  const beforeIds = new Set((beforeJobs.data?.jobs || beforeJobs.data?.downloads || []).map((d) => d.id));
  let rapidShield = -1;
  let newJobs = [];
  if (dlReady) {
    const dlPt = await drv.evalExpr(`(() => { const b = document.querySelector('.tori-mp [data-act="download"]'); b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) }; })()`);
    await drv.evalExpr(`(window.__qa.shieldEvents = 0, true)`);
    for (let i = 0; i < 5; i++) {
      await drv.clickAt(dlPt.cx, dlPt.cy);
      await sleep(30);
    }
    await sleep(1600);
    const afterJobs = await httpJson({ port: DESKTOP_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': API_TOKEN } });
    newJobs = (afterJobs.data?.jobs || afterJobs.data?.downloads || []).filter((d) => !beforeIds.has(d.id));
    rapidShield = await drv.evalExpr(`window.__qa.shieldEvents`);
  }
  record(B, 'IG-8-9-RAPID-DL', '5 rapid real clicks enqueue at most 1 job via TORI Desktop with zero Instagram leakage', dlReady && newJobs.length === 1 && rapidShield === 0, `dlReady=${dlReady}, newJobs=${newJobs.length}, shieldEvents=${rapidShield}`);

  // Direct-mode (picker: false) rapid click dedup & zero playback toggle
  await drv.configureExt({ port: DESKTOP_PORT, picker: false });
  await drv.navigate(`http://127.0.0.1:${FIXTURE_PORT}/fixture/p/IgDirect_${B}/`);
  await drv.evalExpr(`(window.renderScene('reel-playing'), true)`);
  await drv.evalExpr(`(() => { const v = document.querySelector('video'); v.src = '/sample.mp4?direct=${B}_' + Date.now(); v.load(); v.play().catch(()=>{}); return true; })()`);
  await waitForCond(drv.evalExpr, `!!document.querySelector('.tori-pill') && document.querySelector('video').readyState >= 2`, 8000);
  await sleep(300);
  const dirPill = await drv.evalExpr(`(() => { const r = document.querySelector('.tori-pill').getBoundingClientRect(); return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2), paused: document.querySelector('video').paused }; })()`);
  const beforeDirIds = new Set(((await httpJson({ port: DESKTOP_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': API_TOKEN } })).data?.jobs || (await httpJson({ port: DESKTOP_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': API_TOKEN } })).data?.downloads || []).map((d) => d.id));
  await drv.evalExpr(`(window.__qa.shieldEvents = 0, true)`);
  for (let i = 0; i < 4; i++) {
    await drv.clickAt(dirPill.cx, dirPill.cy);
    await sleep(25);
  }
  await sleep(1600);
  const afterDirRes = await httpJson({ port: DESKTOP_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': API_TOKEN } });
  const afterDirJobs = (afterDirRes.data?.jobs || afterDirRes.data?.downloads || []).filter((d) => !beforeDirIds.has(d.id));
  const dirShield = await drv.evalExpr(`({ shieldEvents: window.__qa.shieldEvents, paused: document.querySelector('video').paused })`);
  record(B, 'IG-9B-DIRECT', 'Direct download mode (picker=false) deduplicates rapid pill clicks without toggling playback', afterDirJobs.length === 1 && dirShield.shieldEvents === 0 && dirShield.paused === dirPill.paused, JSON.stringify({ newJobs: afterDirJobs.length, dirShield }));
  await drv.configureExt({ port: DESKTOP_PORT, picker: true });

  // Facebook & Generic Video Overlay Detection Regression Check
  await drv.navigate(`http://127.0.0.1:${FIXTURE_PORT}/facebook.com/watch/?v=1234567890`);
  await drv.evalExpr(`(window.renderScene('reel-playing'), true)`);
  const fbReady = await waitForCond(drv.evalExpr, `(() => { const mp = document.querySelector('.tori-mp'); if (!mp) return null; const r = mp.querySelector('.tori-pill').getBoundingClientRect(); return { cx: Math.round(r.left+r.width/2), cy: Math.round(r.top+r.height/2), paused: document.querySelector('video').paused }; })()`, 8000);
  if (fbReady) {
    await drv.clickAt(fbReady.cx, fbReady.cy);
    await sleep(200);
  }
  const fbAfter = await drv.evalExpr(`({ pnOpen: document.querySelector('.tori-pn')?.classList.contains('on'), paused: document.querySelector('video')?.paused })`);
  record(B, 'REGR-FACEBOOK', 'Facebook video detection & overlay click isolation remain functional', Boolean(fbReady && fbAfter.pnOpen && fbAfter.paused === fbReady.paused), JSON.stringify({ fbReady, fbAfter }));

  // ------------------------------------------------------------------
  // LIVE REAL INSTAGRAM TESTS (Reels + Single Reel + SPA Nav) + LIVE YOUTUBE REGRESSION
  // ------------------------------------------------------------------
  console.log(`[${B}] Navigating to LIVE https://www.instagram.com/reels/ ...`);
  await drv.navigate('https://www.instagram.com/reels/');
  const liveReady = await waitForCond(
    drv.evalExpr,
    `(() => {
      const portal = document.getElementById('tori-overlay-portal-host');
      const vids = Array.from(document.querySelectorAll('video')).filter(v => {
        const r = v.getBoundingClientRect();
        return r.width > 120 && r.height > 120 && r.bottom > 80 && r.top < window.innerHeight - 80;
      });
      const visMp = Array.from(document.querySelectorAll('.tori-mp')).find(m => {
        const f = m.closest('.tori-anchor-frame');
        const p = m.querySelector('.tori-pill');
        if (!p || (f && getComputedStyle(f).display === 'none')) return false;
        const r = p.getBoundingClientRect();
        return r.width > 20 && r.top >= 0 && r.bottom <= window.innerHeight;
      });
      if (!portal || !visMp || vids.length === 0) return null;
      const p = visMp.querySelector('.tori-pill');
      const r = p.getBoundingClientRect();
      return {
        href: location.href,
        portalRootTag: portal.parentElement?.tagName,
        hasShadow: !!portal.shadowRoot,
        cx: Math.round(r.left + r.width / 2),
        cy: Math.round(r.top + r.height / 2),
        pillText: p.innerText.replace(/\\s+/g, ' ').trim(),
        vidPaused: vids[0].paused,
      };
    })()`,
    24000,
    400
  );

  if (!liveReady) {
    record(B, 'LIVE-IG-REELS', 'Live Instagram /reels/ loaded & overlay attached', false, 'Timed out waiting for visible video & pill on live Instagram');
  } else {
    const liveHit = await drv.evalExpr(`(() => {
      const top = document.elementFromPoint(${liveReady.cx}, ${liveReady.cy});
      return { topTag: top?.tagName, inPill: !!top?.closest('.tori-pill'), role: top?.getAttribute('role') };
    })()`);
    // Wait up to 20s for live resolution on visible pill to finish (leave "Resolving…")
    const liveResolved = await waitForCond(
      drv.evalExpr,
      `(() => {
        const visMp = Array.from(document.querySelectorAll('.tori-mp')).find(m => {
          const f = m.closest('.tori-anchor-frame');
          const r = m.querySelector('.tori-pill')?.getBoundingClientRect();
          return (!f || getComputedStyle(f).display !== 'none') && r && r.width > 20 && r.top >= 0 && r.bottom <= window.innerHeight;
        });
        if (!visMp) return null;
        const tag = visMp.querySelector('.tori-pill-tag')?.textContent?.trim() || '';
        if (!tag || tag.includes('Resolving')) return null;
        return { tag };
      })()`,
      20000,
      400
    );

    const pillPtNow = await drv.evalExpr(`(() => {
      const visMp = Array.from(document.querySelectorAll('.tori-mp')).find(m => {
        const f = m.closest('.tori-anchor-frame');
        const r = m.querySelector('.tori-pill')?.getBoundingClientRect();
        return (!f || getComputedStyle(f).display !== 'none') && r && r.width > 20 && r.top >= 0 && r.bottom <= window.innerHeight;
      });
      const r = visMp.querySelector('.tori-pill').getBoundingClientRect();
      const vids = Array.from(document.querySelectorAll('video')).filter(v => {
        const vr = v.getBoundingClientRect();
        return vr.width > 120 && vr.height > 120 && vr.bottom > 80 && vr.top < window.innerHeight - 80;
      });
      window.__liveV = vids[0];
      window.__liveVisMp = visMp;
      return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), pausedBefore: vids[0]?.paused };
    })()`);

    await drv.screenshot(`${B.toLowerCase()}_live_ig_before.png`);
    await drv.clickAt(pillPtNow.cx, pillPtNow.cy);
    await sleep(450);
    const liveAfterClick = await drv.evalExpr(`({
      pnOpen: window.__liveVisMp.querySelector('.tori-pn').classList.contains('on'),
      pausedAfter: window.__liveV.paused,
      pnText: window.__liveVisMp.querySelector('.tori-pn').innerText.replace(/\\s+/g, ' ').trim().slice(0, 180),
      formatsCount: window.__liveVisMp.querySelectorAll('.tori-fr').length,
    })`);
    await drv.screenshot(`${B.toLowerCase()}_live_ig_after_click.png`);

    // Click outside open .tori-pn panel near bottom exposed portion of video -> must toggle video and close panel
    const vidOutPt = await drv.evalExpr(`(() => {
      const r = window.__liveV.getBoundingClientRect();
      const pn = window.__liveVisMp.querySelector('.tori-pn').getBoundingClientRect();
      const clickY = Math.min(Math.round(r.bottom - 55), Math.max(Math.round(pn.bottom + 40), Math.round(r.bottom - 55)));
      return { x: Math.round(r.left + r.width / 2), y: clickY };
    })()`);
    await drv.clickAt(vidOutPt.x, vidOutPt.y);
    await sleep(350);
    const livePausedToggle = await drv.evalExpr(`({
      pausedAfterOutClick: window.__liveV.paused,
      pnOpenAfterOutClick: window.__liveVisMp.querySelector('.tori-pn').classList.contains('on'),
    })`);

    // Now click TORI pill while live Instagram Reel is PAUSED -> must open without resuming
    await drv.clickAt(pillPtNow.cx, pillPtNow.cy);
    await sleep(350);
    const livePausedClick = await drv.evalExpr(`({
      pnOpenOnPaused: window.__liveVisMp.querySelector('.tori-pn').classList.contains('on'),
      pausedStillTrue: window.__liveV.paused,
    })`);

    const livePass =
      liveHit.inPill === true &&
      liveReady.hasShadow === true &&
      liveAfterClick.pnOpen === true &&
      liveAfterClick.pausedAfter === pillPtNow.pausedBefore &&
      livePausedClick.pnOpenOnPaused === true &&
      livePausedClick.pausedStillTrue === livePausedToggle.pausedAfterOutClick &&
      livePausedToggle.pausedAfterOutClick !== pillPtNow.pausedBefore &&
      livePausedToggle.pnOpenAfterOutClick === false &&
      Boolean(liveResolved);
    record(B, 'LIVE-IG-REELS', 'Live Instagram /reels/: hit target=pill, click opens panel (playing & paused) without toggling playback, Resolving finishes cleanly', livePass, JSON.stringify({ liveHit, liveAfterClick, livePausedToggle, livePausedClick, liveResolved }));

    // Live SPA Next Reel check
    const hrefBeforeSpa = await drv.evalExpr(`location.href`);
    await drv.evalExpr(`(() => { const pn = window.__liveVisMp.querySelector('.tori-pn'); if (pn?.classList.contains('on')) pn.classList.remove('on'); const btn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => /next/i.test(b.getAttribute('aria-label') || '')); if (btn) btn.click(); else window.scrollBy(0, 750); return true; })()`);
    await sleep(2500);
    const spaAfter = await drv.evalExpr(`(() => {
      const visMp = Array.from(document.querySelectorAll('.tori-mp')).find(m => {
        const f = m.closest('.tori-anchor-frame');
        const r = m.querySelector('.tori-pill')?.getBoundingClientRect();
        return (!f || getComputedStyle(f).display !== 'none') && r && r.width > 20 && r.top >= 0 && r.bottom <= window.innerHeight;
      });
      const vids = Array.from(document.querySelectorAll('video')).filter(v => {
        const vr = v.getBoundingClientRect();
        return vr.width > 120 && vr.height > 120 && vr.bottom > 80 && vr.top < window.innerHeight - 80;
      });
      if (!visMp || vids.length === 0) return null;
      window.__spaV = vids[0];
      window.__spaMp = visMp;
      const r = visMp.querySelector('.tori-pill').getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width/2), Math.round(r.top + r.height/2));
      return { href: location.href, cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2), inPill: !!top?.closest('.tori-pill'), paused: vids[0].paused };
    })()`);
    let spaClickOk = false;
    if (spaAfter) {
      await drv.clickAt(spaAfter.cx, spaAfter.cy);
      await sleep(300);
      spaClickOk = await drv.evalExpr(`window.__spaMp.querySelector('.tori-pn').classList.contains('on') && window.__spaV.paused === ${Boolean(spaAfter.paused)}`);
    }
    record(B, 'LIVE-IG-SPA', 'Live Instagram SPA next Reel keeps pill clickable without playback toggle', Boolean(spaAfter?.inPill && spaClickOk), JSON.stringify({ hrefBeforeSpa, hrefAfter: spaAfter?.href, spaClickOk }));
  }

  // Live single Reel URL (/reel/DfuP-8HKvdj/) with fixed header stacking + "Never miss a post" dialog banner
  await drv.navigate('https://www.instagram.com/reel/DfuP-8HKvdj/');
  // Dismiss Instagram unauthenticated modal banner if present
  await sleep(1500);
  await drv.evalExpr(`(() => {
    const btns = Array.from(document.querySelectorAll('div[role="dialog"] button, div[role="dialog"] [role="button"], svg[aria-label="Close"], [aria-label="Close"]'));
    for (const b of btns) {
      if (/close/i.test(b.getAttribute('aria-label') || b.textContent || '') || b.tagName.toLowerCase() === 'svg') {
        const target = b.closest('button, [role="button"]') || b;
        target.click?.();
      }
    }
    return true;
  })()`);
  await sleep(600);

  const singleReady = await waitForCond(
    drv.evalExpr,
    `(() => {
      // Dismiss Instagram unauthenticated popup dialog if present
      const btns = Array.from(document.querySelectorAll('div[role="dialog"] button, div[role="dialog"] [role="button"], svg[aria-label="Close"], [aria-label="Close"]'));
      for (const b of btns) {
        if (/close/i.test(b.getAttribute('aria-label') || b.textContent || '') || b.tagName.toLowerCase() === 'svg') {
          const target = b.closest('button, [role="button"]') || b;
          target.click?.();
        }
      }
      const mp = document.querySelector('.tori-mp');
      const f = mp?.closest('.tori-anchor-frame');
      const p = mp?.querySelector('.tori-pill');
      const v = document.querySelector('video');
      if (!p || !v || (f && getComputedStyle(f).display === 'none')) return null;
      const r = p.getBoundingClientRect();
      if (r.width < 20) return null;
      const top = document.elementFromPoint(Math.round(r.left + r.width/2), Math.round(r.top + r.height/2));
      return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2), inPill: !!top?.closest('.tori-pill'), paused: v.paused };
    })()`,
    35000,
    500
  );
  if (singleReady) {
    await sleep(400);
    const beforeClick = await drv.evalExpr(`(() => {
      const p = document.querySelector('.tori-mp .tori-pill');
      const r = p?.getBoundingClientRect();
      const v = document.querySelector('video');
      return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2), paused: v ? v.paused : null };
    })()`) || singleReady;
    await drv.clickAt(beforeClick.cx, beforeClick.cy);
    await sleep(400);
    const singleAfter = await drv.evalExpr(`({ pnOpen: document.querySelector('.tori-pn')?.classList.contains('on'), paused: document.querySelector('video')?.paused })`);
    record(B, 'LIVE-IG-SINGLE', 'Live Instagram /reel/DfuP-8HKvdj/ stays visible past bottom banner & escapes fixed headers', singleReady.inPill && singleAfter.pnOpen && singleAfter.paused === beforeClick.paused, JSON.stringify({ singleReady, beforeClick, singleAfter }));
  } else {
    record(B, 'LIVE-IG-SINGLE', 'Live Instagram /reel/DfuP-8HKvdj/ loaded', false, 'No visible pill mounted');
  }

  // Live YouTube Regression Check
  await drv.navigate('https://www.youtube.com/watch?v=u9lj-c29dxI');
  const ytReady = await waitForCond(
    drv.evalExpr,
    `(() => {
      const mp = document.querySelector('.tori-mp');
      const p = mp?.querySelector('.tori-pill');
      const v = document.querySelector('video');
      if (!p || !v) return null;
      const r = p.getBoundingClientRect();
      if (r.width < 20 || r.top < 0) return null;
      const top = document.elementFromPoint(Math.round(r.left + r.width/2), Math.round(r.top + r.height/2));
      const inPill = !!top?.closest('.tori-pill');
      if (!inPill) return null;
      return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2), inPill: true, paused: v.paused };
    })()`,
    35000,
    500
  );
  if (ytReady) {
    const ytPillPt = await drv.evalExpr(`(() => {
      const p = document.querySelector('.tori-mp .tori-pill');
      const r = p?.getBoundingClientRect();
      return r ? { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) } : null;
    })()`);
    const cx = ytPillPt?.cx ?? ytReady.cx;
    const cy = ytPillPt?.cy ?? ytReady.cy;
    await drv.clickAt(cx, cy);
    const pnOpenCond = Boolean(await waitForCond(drv.evalExpr, `document.querySelector('.tori-pn')?.classList.contains('on')`, 6000));
    const ytFormats = await waitForCond(drv.evalExpr, `document.querySelectorAll('.tori-fr').length >= 2 && !document.querySelector('[data-act="download"]')?.disabled`, 20000);
    const pausedNow = await drv.evalExpr(`document.querySelector('video')?.paused`);
    record(B, 'REGR-YOUTUBE', 'YouTube overlay & Format Picker remain functional without playback toggle', Boolean(ytReady.inPill && pnOpenCond && pausedNow === ytReady.paused && ytFormats), JSON.stringify({ ytReady, pnOpen: pnOpenCond, pausedNow, ytFormats }));
  } else {
    record(B, 'REGR-YOUTUBE', 'YouTube overlay mounted', false, 'Timed out after 35s');
  }

  // If Firefox, perform explicit end-to-end download task creation and completion check
  if (B === 'Firefox') {
    await drv.navigate(`http://127.0.0.1:${FIXTURE_PORT}/fixture/reel/DlTestReel/`);
    await drv.evalExpr(`(window.renderScene('regular-post'), true)`);
    await drv.evalExpr(`(() => { const v = document.querySelector('video'); v.src = '/sample.mp4?dltest=1'; v.load(); return true; })()`);
    await waitForCond(drv.evalExpr, `!!document.querySelector('.tori-pill') && document.querySelector('video').readyState >= 1`, 8000);
    const dlPill = await drv.evalExpr(`(() => { const r = document.querySelector('.tori-pill').getBoundingClientRect(); return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) }; })()`);
    await drv.clickAt(dlPill.cx, dlPill.cy);
    const dlBtnReady = await waitForCond(drv.evalExpr, `(() => { const b = document.querySelector('.tori-mp [data-act="download"]'); return b && !b.disabled && document.querySelectorAll('.tori-fr').length >= 1; })()`, 20000);
    let dlTaskOk = false;
    let dlFileOk = false;
    if (dlBtnReady) {
      const beforeRes = await httpJson({ port: DESKTOP_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': API_TOKEN } });
      const beforeIds = new Set((beforeRes.data?.jobs || beforeRes.data?.downloads || []).map(d => d.id));
      const dlBtnPt = await drv.evalExpr(`(() => { const b = document.querySelector('.tori-mp [data-act="download"]'); const r = b.getBoundingClientRect(); return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) }; })()`);
      await drv.clickAt(dlBtnPt.cx, dlBtnPt.cy);
      
      // Wait for Desktop v1.0.5 to register and complete the download job
      let completedJob = null;
      for (let i = 0; i < 40; i++) {
        await sleep(400);
        const poll = await httpJson({ port: DESKTOP_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': API_TOKEN } });
        const jobs = poll.data?.jobs || poll.data?.downloads || [];
        const newJob = jobs.find(j => !beforeIds.has(j.id));
        if (newJob && (newJob.state === 'completed' || newJob.state === 'finished' || newJob.status === 'completed')) {
          completedJob = newJob;
          break;
        }
      }
      dlTaskOk = Boolean(completedJob);
      function findDownloadedFiles(dir) {
        let list = [];
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) list = list.concat(findDownloadedFiles(full));
            else if (e.isFile() && full.endsWith('.mp4')) list.push(full);
          }
        } catch (_) {}
        return list;
      }
      const dlFiles = findDownloadedFiles(QA_DL_DIR);
      dlFileOk = dlFiles.some(f => fs.statSync(f).size > 5000);
    }
    record(B, 'FF110-DL-COMPLETE', 'Signed Firefox v1.0.10 initiates download to Desktop v1.0.5, tracks progress, and saves file', Boolean(dlTaskOk && dlFileOk), JSON.stringify({ dlTaskOk, dlFileOk }));
  }
}

async function main() {
  console.log('=== TORI GATE 31.2 — SIGNED FIREFOX & CROSS-BROWSER SUITE ===');
  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(QA_DATA_DIR, { recursive: true });
  fs.mkdirSync(QA_DL_DIR, { recursive: true });
  fs.mkdirSync(QA_WV2_DIR, { recursive: true });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  // ------------------------------------------------------------------
  // Phase 1: Package Checksum & Integrity Preflight
  // ------------------------------------------------------------------
  const crypto = require('crypto');
  function fileSha256(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
  const xpiSha = fileSha256(SIGNED_FF_XPI);
  const chrSha = fileSha256(path.join(RC_DIR, 'tori-companion-v1.0.10-chromium.zip'));
  const xpiMatch = xpiSha === EXPECTED_XPI_SHA;
  const chrMatch = chrSha === EXPECTED_CHR_SHA;
  record('Release', 'PKG-XPI-SHA', 'Mozilla-signed Firefox v1.0.10 XPI matches expected SHA-256', xpiMatch, `actual=${xpiSha}, exp=${EXPECTED_XPI_SHA}`);
  record('Release', 'PKG-CHR-SHA', 'Chromium Companion v1.0.10 ZIP matches Gate 31.1 frozen SHA-256', chrMatch, `actual=${chrSha}, exp=${EXPECTED_CHR_SHA}`);
  if (!xpiMatch || !chrMatch) throw new Error('Package preflight checksum mismatch');

  const runningPids = getRunningToriPids();
  if (runningPids.length > 0) {
    oemWasRunning = true;
    console.log(`[CLEANUP] Stopping OEM TORI Desktop PIDs for isolated Native Messaging/port QA: ${runningPids.join(',')}`);
    for (const pid of runningPids) killProcTree(pid);
    await sleep(1500);
  }

  ensureSampleMp4();
  seedQaSqlite(path.join(QA_DATA_DIR, 'tdm_storage.sqlite'));

  const fixtureHtml = buildInstagramFixtureHtml();
  const sampleBuf = fs.readFileSync(QA_SAMPLE_MP4);
  fixtureServer = http.createServer((req, res) => {
    const cleanUrl = (req.url || '/').split('?')[0];
    if (cleanUrl === '/sample.mp4') {
      const range = req.headers.range;
      if (range && range.startsWith('bytes=')) {
        const [s, e] = range.slice(6).split('-');
        const start = parseInt(s, 10) || 0;
        const end = e ? Math.min(parseInt(e, 10), sampleBuf.length - 1) : sampleBuf.length - 1;
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${sampleBuf.length}`, 'Content-Length': end - start + 1 });
        return res.end(sampleBuf.subarray(start, end + 1));
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': sampleBuf.length });
      return res.end(sampleBuf);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fixtureHtml);
  });
  await new Promise((r) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', r));

  const pipeName = `\\\\.\\pipe\\tori-qa-g31-2-${process.pid}`;
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

  deskProc = spawn(DESKTOP_EXE, [], { cwd: ROOT, env: qaEnv, stdio: 'ignore' });
  trackedProcs.add(deskProc);
  let ready = false;
  for (let i = 0; i < 65; i++) {
    await sleep(350);
    const ping = await httpJson({ port: DESKTOP_PORT, reqPath: '/api/v1/ping', headers: { 'X-Tori-Token': API_TOKEN } });
    if (ping.ok && ping.data?.name === 'TORI Download Manager') { ready = true; break; }
  }
  if (!ready) throw new Error('QA TORI Desktop failed to start cleanly');
  console.log(`[BOOT] QA TORI Desktop online at 127.0.0.1:${DESKTOP_PORT}`);

  registerNativeHosts({ chromeExtIds: ['jfnfgmcbgapcpieaonbaolgebjaejcdm', 'bflchfddfgkfglmjapohkjmldepflkbe'], firefoxId: EXPECTED_GECKO_ID });

  let edge = null;
  let chrome = null;
  let firefox = null;
  try {
    edge = await launchChromium('Edge', EDGE_EXE, QA_EDGE_PROF, EDGE_CDP_PORT, qaEnv);
    registerNativeHosts({ chromeExtIds: [edge.extId], firefoxId: EXPECTED_GECKO_ID });
    await runInstagramBrowserSuite(edge);
    edge.close();
    edge = null;

    chrome = await launchChromium('Chrome', CHROME_EXE, QA_CHR_PROF, CHROME_CDP_PORT, qaEnv);
    registerNativeHosts({ chromeExtIds: [chrome.extId], firefoxId: EXPECTED_GECKO_ID });
    await runInstagramBrowserSuite(chrome);
    chrome.close();
    chrome = null;

    firefox = await launchFirefox(qaEnv);
    await runInstagramBrowserSuite(firefox);
    firefox.close();
    firefox = null;
  } finally {
    try { edge?.close(); } catch {}
    try { chrome?.close(); } catch {}
    try { firefox?.close(); } catch {}
    cleanupProcs();
    try { fixtureServer?.close(); } catch {}
    restoreOemNativeHost();
    restoreOemDesktop();
  }

  fs.writeFileSync(path.join(QA_ROOT, 'gate31_2_results.json'), JSON.stringify({ counts, results }, null, 2), 'utf8');
  console.log(`\n=== SUMMARY: PASS=${counts.PASS} FAIL=${counts.FAIL} SKIP=${counts.SKIP} ===`);
  if (counts.FAIL > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  cleanupProcs();
  restoreOemNativeHost();
  restoreOemDesktop();
  process.exit(1);
});
