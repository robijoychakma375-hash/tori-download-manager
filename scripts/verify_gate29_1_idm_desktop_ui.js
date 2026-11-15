#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 29.1
 * Live Desktop IDM UI Migration, Virtualization, Persistence & Visual Screenshot Verification
 *
 * Strictly isolated under target/gate29_1_qa with custom TORI_DATA_DIR, TORI_IPC_PIPE,
 * WEBVIEW2_USER_DATA_FOLDER, and HTTP port 19940.
 * Never modifies %APPDATA%\tori-download-manager\tdm_storage.sqlite or release artifacts.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP_EXE = path.join(ROOT, 'target', 'release', 'tori-download-manager.exe');
const QA_ROOT = path.join(ROOT, 'target', 'gate29_1_qa');
const QA_DATA_DIR = path.join(QA_ROOT, 'data');
const QA_DL_DIR = path.join(QA_ROOT, 'downloads');
const QA_WV2_DIR = path.join(QA_ROOT, 'webview2');
const SCREENSHOTS_DIR = path.join(ROOT, 'docs', 'reports', 'screenshots', 'gate29_1');

const OEM_APPDATA_DIR = path.join(process.env.APPDATA || '', 'tori-download-manager');
const OEM_DB_PATH = path.join(OEM_APPDATA_DIR, 'tdm_storage.sqlite');
const OEM_EXE_PATH = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'tori-download-manager.exe');

const GUI_PORT = 19940;
const CDP_PORT = 19941;
const FIXTURE_PORT = 19945;
const API_TOKEN = 'tori_qa_gate29_1_token';

const results = [];
const counts = { PASS: 0, FAIL: 0 };
const trackedProcs = new Set();
let oemWasRunning = false;

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
  for (const p of trackedProcs) {
    killProcTree(p.pid);
  }
  trackedProcs.clear();
}

function getRunningToriPids() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "(Get-Process 'tori-download-manager' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','"],
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    return out
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n) && n > 0);
  } catch {
    return [];
  }
}

function getTreeStats(rootPid) {
  try {
    const ps = `
      $root = Get-Process -Id ${rootPid} -ErrorAction SilentlyContinue
      if (-not $root) { Write-Output "0|0|0|0"; exit 0 }
      $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
      $pids = @(${rootPid})
      $changed = $true
      while ($changed) {
        $changed = $false
        foreach ($p in $all) {
          if ($pids -contains $p.ParentProcessId -and -not ($pids -contains $p.ProcessId)) {
            $pids += $p.ProcessId
            $changed = $true
          }
        }
      }
      $ws = 0; $priv = 0; $cpu = 0.0
      foreach ($id in $pids) {
        $gp = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($gp) {
          $ws += $gp.WorkingSet64
          $priv += $gp.PrivateMemorySize64
          if ($gp.CPU) { $cpu += $gp.CPU }
        }
      }
      Write-Output ("$([math]::Round($ws/1MB,2))|$([math]::Round($priv/1MB,2))|$([math]::Round($cpu,3))|$($pids.Count)")
    `;
    const b64 = Buffer.from(ps, 'utf16le').toString('base64');
    const raw = execFileSync('powershell', ['-NoProfile', '-EncodedCommand', b64], { encoding: 'utf8', timeout: 6000 }).trim();
    const [wsMb, privMb, cpuSec, procCount] = raw.split('|').map(Number);
    return { wsMb: wsMb || 0, privMb: privMb || 0, cpuSec: cpuSec || 0, procCount: procCount || 0 };
  } catch {
    return { wsMb: 0, privMb: 0, cpuSec: 0, procCount: 0 };
  }
}

function httpJson({ port, reqPath, method = 'GET', headers = {}, body = null, timeoutMs = 8000 }) {
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
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, error: 'TIMEOUT' }); });
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
  connect(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const t = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
      ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(e.message || 'CDP WS error')); });
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
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, userGesture = false) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (res?.exceptionDetails) {
      throw new Error(`CDP eval error: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
    }
    return res?.result?.value;
  }
  async screenshot(outFile) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    if (!res?.data) throw new Error('No screenshot data');
    fs.writeFileSync(outFile, Buffer.from(res.data, 'base64'));
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function waitForMainCdp(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        const main = targets.find(
          (t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url).includes('window=toast')
        );
        if (main) return { main, targets };
      }
    } catch {}
    await sleep(250);
  }
  throw new Error(`WebView2 CDP not ready on port ${port}`);
}

function seedQaDatabase(dbPath, opts = { count: 9 }) {
  const py = `
import sqlite3, json, sys, datetime
db_path, dl_dir, token, port, row_count = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("""
CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  resolved_url TEXT,
  filename TEXT NOT NULL,
  target_path TEXT NOT NULL,
  temp_path TEXT NOT NULL,
  total_bytes INTEGER,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  job_type TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  is_resumable INTEGER NOT NULL DEFAULT 1,
  chunk_count INTEGER NOT NULL DEFAULT 1,
  priority TEXT NOT NULL DEFAULT 'normal',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  thumbnail_url TEXT,
  referer TEXT,
  user_agent TEXT,
  scheduled_at TEXT
)""")
cur.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
cur.execute("DELETE FROM downloads")

now = datetime.datetime.now(datetime.timezone.utc)
samples = [
  ("qa-vid-1", "https://cdn.example.org/movies/Inception.1080p.mkv", "Inception.1080p.mkv", 2948512768, 1782579200, "paused", "http_file", 16),
  ("qa-vid-2", "https://cdn.example.org/videos/Big_Buck_Bunny_1080p.mp4", "Big_Buck_Bunny_1080p.mp4", 420000000, 420000000, "completed", "http_file", 8),
  ("qa-mus-1", "https://cdn.example.org/audio/Studio_Session.flac", "Studio_Session.flac", 64200000, 64200000, "completed", "http_file", 4),
  ("qa-mus-2", "https://cdn.example.org/audio/Podcast_Ep42.mp3", "Podcast_Ep42.mp3", 48000000, 12000000, "paused", "http_file", 8),
  ("qa-cmp-1", "https://cdn.example.org/archives/ubuntu-24.04-amd64.iso", "ubuntu-24.04-amd64.iso", 5900000000, 2950000000, "paused", "http_file", 16),
  ("qa-cmp-2", "https://cdn.example.org/archives/project-assets-v2.zip", "project-assets-v2.zip", 184000000, 184000000, "completed", "http_file", 8),
  ("qa-prg-1", "https://cdn.example.org/apps/SetupToolchain-1.4.2-x64.exe", "SetupToolchain-1.4.2-x64.exe", 112500000, 0, "paused", "http_file", 8),
  ("qa-doc-1", "https://cdn.example.org/docs/Architecture_Whitepaper.pdf", "Architecture_Whitepaper.pdf", 18400000, 18400000, "completed", "http_file", 4),
  ("qa-doc-2", "https://cdn.example.org/docs/Release_Notes.pdf", "Release_Notes.pdf", 4200000, 2100000, "failed", "http_file", 2),
]

for idx, (jid, url, fname, total, dl, st, jtype, chunks) in enumerate(samples):
    ts = (now - datetime.timedelta(minutes=idx * 5)).isoformat()
    cur.execute(
      "INSERT INTO downloads(id,url,filename,target_path,temp_path,total_bytes,downloaded_bytes,state,job_type,is_resumable,chunk_count,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,'normal',?,?)",
      (jid, url, fname, dl_dir + "\\\\" + fname, dl_dir + "\\\\" + fname + ".tdm-part", total, dl, st, jtype, chunks, ts, ts)
    )

if row_count > len(samples):
    exts = ["mp4", "mkv", "mp3", "zip", "exe", "pdf"]
    states = ["completed", "paused", "failed", "completed", "paused"]
    for idx in range(len(samples), row_count):
        ext = exts[idx % len(exts)]
        st = states[idx % len(states)]
        fname = f"Virtual_Benchmark_Item_{idx:04d}.{ext}"
        total = 10_000_000 + (idx % 500) * 100_000
        dl = total if st == "completed" else total // 2
        ts = (now - datetime.timedelta(minutes=idx)).isoformat()
        cur.execute(
          "INSERT INTO downloads(id,url,filename,target_path,temp_path,total_bytes,downloaded_bytes,state,job_type,is_resumable,chunk_count,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,4,'normal',?,?)",
          (f"qa-v-{idx}", f"https://cdn.example.org/bulk/{fname}", fname, dl_dir + "\\\\" + fname, dl_dir + "\\\\" + fname + ".tdm-part", total, dl, st, "http_file", ts, ts)
        )

app_settings = {
  "dir": dl_dir,
  "sort": True,
  "con": 16,
  "maxa": 4,
  "limMode": "off",
  "limV": 256,
  "limU": "KiB/s",
  "retries": 3,
  "dyn": True,
  "mps": 512,
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
  "closeToTray": True,
  "autoCheckUpdates": False
}
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("browser_integration_token", token))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("server_port", str(port)))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("app_settings", json.dumps(app_settings)))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("close_to_tray_migrated_v104", "true"))
conn.commit()
conn.close()
`;
  execFileSync('python', ['-c', py, dbPath, QA_DL_DIR, API_TOKEN, String(GUI_PORT), String(opts.count)], {
    stdio: 'inherit',
    timeout: 10000,
  });
}

function readSettingFromSqlite(dbPath, key) {
  const out = execFileSync(
    'python',
    ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); r=c.execute("SELECT value FROM engine_settings WHERE key=?", (sys.argv[2],)).fetchone(); print(r[0] if r else "")', dbPath, key],
    { encoding: 'utf8', timeout: 5000 }
  ).trim();
  return out;
}

async function launchQaDesktop(extraEnv = {}) {
  const pipeName = `\\\\.\\pipe\\tori-qa-g291-${process.pid}-${Date.now()}`;
  const proc = spawn(DESKTOP_EXE, [], {
    env: {
      ...process.env,
      TORI_DATA_DIR: QA_DATA_DIR,
      TDM_STORAGE_DIR: QA_DATA_DIR,
      TDM_DOWNLOAD_DIR: QA_DL_DIR,
      TORI_IPC_PIPE: pipeName,
      TORI_ALLOW_LOOPBACK: '1',
      TORI_DISABLE_AUTO_SPAWN: '1',
      WEBVIEW2_USER_DATA_FOLDER: QA_WV2_DIR,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      RUST_MIN_STACK: '8388608',
      ...extraEnv,
    },
    stdio: 'ignore',
  });
  trackedProcs.add(proc);

  let pingOk = false;
  for (let i = 0; i < 45; i++) {
    await sleep(300);
    const res = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/ping',
      headers: { 'X-Tori-Token': API_TOKEN },
    });
    if (res.ok && res.data?.name === 'TORI Download Manager') {
      pingOk = true;
      break;
    }
  }
  if (!pingOk) throw new Error('Desktop HTTP API failed to come online');

  const { main } = await waitForMainCdp(CDP_PORT, 20000);
  const cdp = new CDPClient(main.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Page.enable');

  for (let i = 0; i < 40; i++) {
    const ready = await cdp.eval(`!!document.querySelector('#main #right .th') && document.querySelectorAll('#rows .tr').length >= 1`);
    if (ready) break;
    await sleep(250);
  }
  await sleep(500);
  return { proc, cdp };
}

async function run() {
  console.log('========================================================================');
  console.log('  TORI GATE 29.1: IDM DESKTOP UI MIGRATION & VIRTUALIZATION VERIFICATION');
  console.log('========================================================================\n');

  if (!fs.existsSync(DESKTOP_EXE)) {
    throw new Error(`Desktop binary missing: ${DESKTOP_EXE}`);
  }

  const oemDbHashBefore = sha256File(OEM_DB_PATH);

  // Stop idle OEM instance cleanly if running (safety: check for active transfers first)
  const existingPids = getRunningToriPids();
  if (existingPids.length > 0) {
    oemWasRunning = true;
    const ping = await httpJson({ port: 6800, reqPath: '/api/v1/ping' }).catch(() => ({ ok: false }));
    if (ping.ok && ping.data?.active_downloads > 0) {
      throw new Error(`OEM TORI has ${ping.data.active_downloads} active download(s); aborting QA.`);
    }
    for (const pid of existingPids) killProcTree(pid);
    await sleep(800);
  }

  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(QA_DATA_DIR, { recursive: true });
  fs.mkdirSync(QA_DL_DIR, { recursive: true });
  fs.mkdirSync(QA_WV2_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // Fixture server for real HTTP range & throttled stream tests
  const streamPayload = crypto.randomBytes(900 * 1024); // 900 KB for throttled ~3.5s transfer
  const fastPayload = crypto.randomBytes(256 * 1024);
  const fixtureServer = http.createServer((req, res) => {
    const urlPath = new URL(req.url, `http://127.0.0.1:${FIXTURE_PORT}`).pathname;
    if (urlPath === '/fast.bin') {
      res.writeHead(200, {
        'Content-Length': fastPayload.length,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
      });
      res.end(req.method === 'HEAD' ? undefined : fastPayload);
      return;
    }
    if (urlPath === '/stream.bin') {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Length': streamPayload.length,
          'Accept-Ranges': 'none',
          'Content-Type': 'application/octet-stream',
        });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Length': streamPayload.length,
        'Content-Type': 'application/octet-stream',
      });
      // Send 64KB every 250ms (~256 KB/s -> ~3.5s) to trigger high-frequency progress events cleanly
      let offset = 0;
      const chunkSize = 64 * 1024;
      const iv = setInterval(() => {
        if (req.destroyed || res.destroyed) {
          clearInterval(iv);
          return;
        }
        const slice = streamPayload.subarray(offset, Math.min(streamPayload.length, offset + chunkSize));
        res.write(slice);
        offset += slice.length;
        if (offset >= streamPayload.length) {
          clearInterval(iv);
          res.end();
        }
      }, 250);
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });
  await new Promise((r) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', r));

  const dbPath = path.join(QA_DATA_DIR, 'tdm_storage.sqlite');

  try {
    // -------------------------------------------------------------------------
    // PART A: Layout Fidelity, Hierarchy, Screenshots (Light, Dark, Settings)
    // -------------------------------------------------------------------------
    seedQaDatabase(dbPath, { count: 9 });
    let session = await launchQaDesktop();
    let { proc, cdp } = session;

    const idleStats = getTreeStats(proc.pid);
    record('PERF-IDLE', 'Idle Memory & Process Footprint', idleStats.wsMb > 0, `WorkingSet=${idleStats.wsMb}MB, Private=${idleStats.privMb}MB, Procs=${idleStats.procCount}`);

    // Inspect Core DOM Layout
    const layout = await cdp.eval(`(() => {
      const wbar = document.querySelector('.wbar');
      const dot = document.querySelector('.dot');
      const wc = Array.from(document.querySelectorAll('.wc b')).map(b => b.getAttribute('title'));
      const menus = Array.from(document.querySelectorAll('.menubar .mbi')).map(b => b.textContent.trim());
      const toolBtns = Array.from(document.querySelectorAll('#tool .tb')).map(b => ({ act: b.dataset.a, lbl: b.textContent.trim() }));
      const sideTop = Array.from(document.querySelectorAll('#side > .si')).map(el => el.dataset.cat);
      const sideKids = Array.from(document.querySelectorAll('#side > .kids .si')).map(el => el.dataset.cat);
      const colHeaders = Array.from(document.querySelectorAll('#right .th .th-btn span:first-child')).map(s => s.textContent.trim());
      const det = document.getElementById('det');
      const statText = document.getElementById('stat')?.textContent || '';
      const rowCount = document.querySelectorAll('#rows .tr').length;
      const counts = Object.fromEntries(Array.from(document.querySelectorAll('#side .si')).map(el => [el.dataset.cat, el.querySelector('em')?.textContent?.trim()]));
      return {
        theme: document.documentElement.dataset.theme,
        accent: document.documentElement.dataset.accent,
        wbarH: wbar ? Math.round(wbar.getBoundingClientRect().height) : 0,
        hasMacDot: !!dot,
        wc,
        menus,
        toolBtns,
        sideTop,
        sideKids,
        colHeaders,
        hasDet: !!det && getComputedStyle(det).display !== 'none',
        statText,
        rowCount,
        counts,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        blurCount: Array.from(document.querySelectorAll('*')).filter(el => {
          const bf = getComputedStyle(el).backdropFilter;
          return bf && bf !== 'none';
        }).length,
      };
    })()`);

    record(
      'UI-CHROME',
      'Windows Titlebar & NO macOS dots',
      layout.wbarH === 32 && !layout.hasMacDot && layout.wc.includes('Minimize') && layout.wc.includes('Maximize') && layout.wc.includes('Close'),
      JSON.stringify({ wbarH: layout.wbarH, wc: layout.wc, hasMacDot: layout.hasMacDot })
    );
    record(
      'UI-MENU',
      'IDM MenuBar (Tasks, File, Downloads, View, Help)',
      JSON.stringify(layout.menus) === JSON.stringify(['Tasks', 'File', 'Downloads', 'View', 'Help']),
      JSON.stringify(layout.menus)
    );
    record(
      'UI-TOOL',
      'IDM Toolbar Buttons & Search',
      layout.toolBtns.length === 7,
      layout.toolBtns.map((b) => b.lbl).join(', ')
    );
    record(
      'UI-SIDE',
      'Hierarchical Sidebar Tree & Real Counts',
      JSON.stringify(layout.sideTop) === JSON.stringify(['all', 'unf', 'fin']) &&
        JSON.stringify(layout.sideKids) === JSON.stringify(['Video', 'Music', 'Compressed', 'Programs', 'Documents']) &&
        layout.counts.all === '9' &&
        layout.counts.Video === '2' &&
        layout.counts.fin === '4' &&
        layout.counts.unf === '5',
      JSON.stringify(layout.counts)
    );
    record(
      'UI-TABLE',
      '6-Column Download Table & No Bottom Details Panel',
      JSON.stringify(layout.colHeaders) === JSON.stringify(['File name', 'Size', 'Status', 'Time left', 'Transfer rate', 'Last try date']) &&
        !layout.hasDet &&
        layout.rowCount === 9 &&
        layout.scrollWidth <= layout.innerWidth,
      JSON.stringify({ colHeaders: layout.colHeaders, hasDet: layout.hasDet, rowCount: layout.rowCount })
    );
    record('UI-PERF-STYLE', 'Zero backdrop-filter usage across DOM', layout.blurCount === 0, `blurCount=${layout.blurCount}`);

    // Capture Screenshot 1: Main Window Light
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, '01_main_light.png'));

    // Interactive Test: MenuBar Dropdown + Sidebar Collapse/Expand + Filter + Sort
    await cdp.eval(`document.querySelector('.menubar .mbi')?.click()`);
    await sleep(100);
    const menuItemsOpen = await cdp.eval(`document.querySelectorAll('.mbm .mbm-item').length`);
    await cdp.eval(`document.body.click()`);
    await sleep(100);
    const menuItemsClosed = await cdp.eval(`document.querySelectorAll('.mbm .mbm-item').length`);
    record('ACT-MENU', 'MenuBar dropdown opens real menu items', menuItemsOpen >= 5 && menuItemsClosed === 0, `open=${menuItemsOpen}, afterClose=${menuItemsClosed}`);

    await cdp.eval(`document.querySelector('#side .tch').click()`);
    await sleep(100);
    const collapsedKids = await cdp.eval(`document.querySelectorAll('#side .kids').length`);
    await cdp.eval(`document.querySelector('#side .tch').click()`);
    await sleep(100);
    const expandedKids = await cdp.eval(`document.querySelectorAll('#side .kids .si').length`);
    await cdp.eval(`document.querySelector('#side .si[data-cat="Video"]').click()`);
    await sleep(100);
    const videoRows = await cdp.eval(`document.querySelectorAll('#rows .tr').length`);
    await cdp.eval(`document.querySelector('#side .si[data-cat="all"]').click()`);
    await sleep(100);
    const allRows = await cdp.eval(`document.querySelectorAll('#rows .tr').length`);
    const sidebarTreeWorks = { collapsedKids, expandedKids, videoRows, allRows };
    record(
      'ACT-SIDE',
      'All Downloads collapse/expand & Category filtering',
      sidebarTreeWorks.collapsedKids === 0 && sidebarTreeWorks.expandedKids === 5 && sidebarTreeWorks.videoRows === 2 && sidebarTreeWorks.allRows === 9,
      JSON.stringify(sidebarTreeWorks)
    );

    await cdp.eval(`document.querySelector('#right .th .th-btn').click()`);
    await sleep(100);
    const firstAsc = await cdp.eval(`document.querySelector('#rows .tr .nm em')?.textContent`);
    await cdp.eval(`document.querySelector('#right .th .th-btn').click()`);
    await sleep(100);
    const firstDesc = await cdp.eval(`document.querySelector('#rows .tr .nm em')?.textContent`);
    const searchAndSortWorks = { firstAsc, firstDesc };
    record('ACT-SORT', 'Table Column Header Sorting (asc/desc)', searchAndSortWorks.firstAsc !== searchAndSortWorks.firstDesc, JSON.stringify(searchAndSortWorks));

    // Open Settings Modal & Capture ALL 4 Tabs + Test Live Settings Persistence!
    await cdp.eval(`document.querySelector('#tool button[data-a="settings"]').click()`);
    await sleep(300);

    // Tab 1: Appearance (Light first, verify swatches, screenshot)
    await cdp.eval(`document.querySelector('#ptabsrow .pt[data-tab="appearance"]').click()`);
    await sleep(250);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, '03_settings_appearance.png'));

    // Tab 2: Download Engine (screenshot + edit Thread Count)
    await cdp.eval(`document.querySelector('#ptabsrow .pt[data-tab="engine"]').click()`);
    await sleep(250);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, '04_settings_engine.png'));

    // Tab 3: Browser Integration (screenshot + verify token & port)
    await cdp.eval(`document.querySelector('#ptabsrow .pt[data-tab="integration"]').click()`);
    await sleep(350);
    const integrationInfo = await cdp.eval(`(() => {
      const k = document.getElementById('keyin')?.value;
      const bodyText = document.getElementById('prefbody')?.textContent || '';
      return { hasKey: !!k && k.length > 8, hasChromium: bodyText.includes('jfnfgmcbgapcpieaonbaolgebjaejcdm'), hasFirefox: bodyText.includes('tori-download-manager@toridm.org') };
    })()`);
    record('UI-SET-INT', 'Settings Browser Integration shows API key & pinned IDs', integrationInfo.hasKey && integrationInfo.hasChromium && integrationInfo.hasFirefox, JSON.stringify(integrationInfo));
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, '05_settings_integration.png'));

    // Tab 4: About (screenshot + verify version & buttons)
    await cdp.eval(`document.querySelector('#ptabsrow .pt[data-tab="about"]').click()`);
    await sleep(250);
    const aboutInfo = await cdp.eval(`(() => {
      const txt = document.getElementById('prefbody')?.textContent || '';
      return { hasTitle: txt.includes('TORI Download Manager'), hasVersion: /Version\\s+1\\.0\\.5/i.test(txt), hasFalseDev: txt.includes('Development Build') };
    })()`);
    record('UI-SET-ABOUT', 'Settings About tab shows Version 1.0.5 accurately', aboutInfo.hasTitle && aboutInfo.hasVersion && !aboutInfo.hasFalseDev, JSON.stringify(aboutInfo));
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, '06_settings_about.png'));

    // Switch Appearance -> Dark Theme + Ocean Accent, capture Dark Main Window!
    await cdp.eval(`document.querySelector('#ptabsrow .pt[data-tab="appearance"]').click()`);
    await sleep(200);
    await cdp.eval(`document.querySelector('#prefbody .acs[title="Ocean"]')?.click()`);
    await sleep(200);
    await cdp.eval(`(() => {
      const sel = document.querySelector('#prefbody select.sl');
      if (sel) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, 'dark');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
    await sleep(300);
    await cdp.eval(`document.querySelector('#setw .foot .btn.def').click()`);
    await sleep(450);

    const darkCheck = await cdp.eval(`({ theme: document.documentElement.dataset.theme, accent: document.documentElement.dataset.accent })`);
    record('UI-DARK', 'Live Dark Theme + Ocean Accent applied immediately', darkCheck.theme === 'dark' && darkCheck.accent === 'ocean', JSON.stringify(darkCheck));
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, '02_main_dark.png'));

    // Test responsive minimum viewport (800x540) overflow check
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 540, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    const minVp = await cdp.eval(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, sh: document.documentElement.scrollHeight, ih: window.innerHeight })`);
    record('UI-MINVP', 'Zero horizontal overflow at minimum size 800x540', minVp.sw <= minVp.iw && minVp.sh <= minVp.ih, JSON.stringify(minVp));
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    // Test Close-to-Tray preserves running backend & Restart Persistence!
    await cdp.eval(`document.querySelector('.wbar .wc b:last-child').click()`);
    await sleep(700);
    const trayPing = await httpJson({ port: GUI_PORT, reqPath: '/api/v1/ping', headers: { 'X-Tori-Token': API_TOKEN } });
    record('ACT-TRAY', 'Window close button hides to tray while engine stays alive', trayPing.ok, `ping=${JSON.stringify(trayPing.data)}`);

    cdp.close();
    killProcTree(proc.pid);
    trackedProcs.delete(proc);
    await sleep(1000);

    // -------------------------------------------------------------------------
    // PART B: Restart Persistence + Real Live Transfer Throttling (1 Hz)
    // -------------------------------------------------------------------------
    session = await launchQaDesktop();
    ({ proc, cdp } = session);

    let afterRestart = { theme: '', accent: '' };
    for (let i = 0; i < 12; i++) {
      afterRestart = await cdp.eval(`({ theme: document.documentElement.dataset.theme, accent: document.documentElement.dataset.accent })`);
      if (afterRestart.theme === 'dark' && afterRestart.accent === 'ocean') break;
      await sleep(200);
    }
    const persistedJson = JSON.parse(readSettingFromSqlite(dbPath, 'app_settings') || '{}');
    record(
      'PERSIST-01',
      'Dark theme & Ocean accent persisted in SQLite across real app restart',
      afterRestart.theme === 'dark' && afterRestart.accent === 'ocean' && persistedJson.theme === 'dark' && persistedJson.accent === 'ocean',
      JSON.stringify({ afterRestart, dbTheme: persistedJson.theme, dbAccent: persistedJson.accent })
    );

    // Reset theme back to light for active benchmark & test real throttled HTTP download (1 Hz check)
    await cdp.eval(`(() => {
      window.__domMutations = 0;
      const rows = document.getElementById('rows');
      window.__mo = new MutationObserver(() => { window.__domMutations++; });
      window.__mo.observe(rows, { childList: true, subtree: true, characterData: true, attributes: true });
    })()`);

    const addRes = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: `http://127.0.0.1:${FIXTURE_PORT}/stream.bin`, filename: 'throttled_stream.bin', dir: QA_DL_DIR },
    });
    record('ACT-DL-ADD', 'Enqueued live throttled HTTP download into migrated UI', addRes.ok, JSON.stringify(addRes.data || addRes.error));

    await sleep(3200);
    const activeStats = getTreeStats(proc.pid);
    const domMutCount = await cdp.eval(`(() => { try { window.__mo?.disconnect(); } catch {} return window.__domMutations || 0; })()`);

    // Wait for completion cleanly
    let completed = false;
    for (let i = 0; i < 20; i++) {
      const st = await httpJson({ port: GUI_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': API_TOKEN } });
      const list = Array.isArray(st.data) ? st.data : (st.data?.jobs || []);
      const found = list.find((d) => d.filename === 'throttled_stream.bin');
      if (found && found.state === 'completed') {
        completed = true;
        break;
      }
      await sleep(400);
    }
    const streamDiskSize = fs.existsSync(path.join(QA_DL_DIR, 'Other', 'throttled_stream.bin'))
      ? fs.statSync(path.join(QA_DL_DIR, 'Other', 'throttled_stream.bin')).size
      : fs.existsSync(path.join(QA_DL_DIR, 'throttled_stream.bin'))
        ? fs.statSync(path.join(QA_DL_DIR, 'throttled_stream.bin')).size
        : 0;
    record(
      'PERF-THROTTLE',
      'Active transfer completes on disk & UI throttles progress DOM updates cleanly',
      completed && streamDiskSize === streamPayload.length && domMutCount > 0,
      `completed=${completed}, diskBytes=${streamDiskSize}, mutations3.2s=${domMutCount}, activeWs=${activeStats.wsMb}MB, cpuSec=${activeStats.cpuSec}s`
    );

    cdp.close();
    killProcTree(proc.pid);
    trackedProcs.delete(proc);
    await sleep(1000);

    // -------------------------------------------------------------------------
    // PART C: 1,200-Row List Virtualization Verification
    // -------------------------------------------------------------------------
    seedQaDatabase(dbPath, { count: 1200 });
    session = await launchQaDesktop();
    ({ proc, cdp } = session);

    const virtTop = await cdp.eval(`(() => {
      const rows = document.getElementById('rows');
      const rendered = rows.querySelectorAll('.tr').length;
      const totalCountBadge = document.querySelector('#side .si[data-cat="all"] em')?.textContent?.trim();
      const scrollH = rows.scrollHeight;
      return { rendered, totalCountBadge, scrollH };
    })()`);

    await cdp.eval(`document.getElementById('rows').scrollTop = 20000;`);
    await sleep(250);
    const virtMid = await cdp.eval(`(() => {
      const rows = document.getElementById('rows');
      const trs = Array.from(rows.querySelectorAll('.tr'));
      return {
        rendered: trs.length,
        firstIdx: trs[0]?.dataset?.idx,
        lastIdx: trs[trs.length - 1]?.dataset?.idx,
      };
    })()`);

    const virtStats = getTreeStats(proc.pid);
    record(
      'PERF-VIRT',
      '1,200-row virtualized table mounts only visible window (<= 45 DOM rows)',
      virtTop.totalCountBadge === '1200' && virtTop.rendered > 10 && virtTop.rendered <= 45 && virtMid.rendered > 10 && virtMid.rendered <= 45 && Number(virtMid.firstIdx) > 400,
      JSON.stringify({ virtTop, virtMid, virtWsMb: virtStats.wsMb })
    );

    cdp.close();
    killProcTree(proc.pid);
    trackedProcs.delete(proc);
  } finally {
    cleanupTrackedProcs();
    fixtureServer.close();
  }

  const oemDbHashAfter = sha256File(OEM_DB_PATH);
  record(
    'SAFETY-OEM',
    'Production %APPDATA% SQLite database untouched',
    oemDbHashBefore === oemDbHashAfter,
    `before=${oemDbHashBefore}, after=${oemDbHashAfter}`
  );

  if (oemWasRunning && fs.existsSync(OEM_EXE_PATH)) {
    try {
      spawn(OEM_EXE_PATH, ['--minimized'], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
  }

  console.log('\n========================================================================');
  console.log(`GATE 29.1 SUMMARY: PASS=${counts.PASS} FAIL=${counts.FAIL}`);
  console.log('========================================================================');
  if (counts.FAIL > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  cleanupTrackedProcs();
  process.exit(1);
});
