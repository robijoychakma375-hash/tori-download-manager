#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 29.2
 * Production-Grade IDM-Style Download Progress Window Migration Verification
 *
 * Strictly isolated under target/gate29_2_qa with custom TORI_DATA_DIR, TORI_IPC_PIPE,
 * WEBVIEW2_USER_DATA_FOLDER, and HTTP port 19950.
 * Never modifies %APPDATA%\tori-download-manager\tdm_storage.sqlite or release artifacts.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP_EXE = path.join(ROOT, 'target', 'release', 'tori-download-manager.exe');
const QA_ROOT = path.join(ROOT, 'target', 'gate29_2_qa');
const QA_DATA_DIR = path.join(QA_ROOT, 'data');
const QA_DL_DIR = path.join(QA_ROOT, 'downloads');
const QA_WV2_DIR = path.join(QA_ROOT, 'webview2');
const SCREENSHOTS_DIR = path.join(ROOT, 'docs', 'reports', 'screenshots', 'gate29_2');

const OEM_APPDATA_DIR = path.join(process.env.APPDATA || '', 'tori-download-manager');
const OEM_DB_PATH = path.join(OEM_APPDATA_DIR, 'tdm_storage.sqlite');
const OEM_EXE_PATH = path.join(
  process.env.LOCALAPPDATA || '',
  'TORI Download Manager',
  'tori-download-manager.exe'
);

const GUI_PORT = 24950;
const CDP_PORT = 24951;
const FIXTURE_PORT = 24955;
const API_TOKEN = 'tori_qa_gate29_2_token';

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
  } catch { }
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
      [
        '-NoProfile',
        '-Command',
        "(Get-Process 'tori-download-manager' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','",
      ],
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
      if (-not $root) { Write-Output "0|0|0"; exit 0 }
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
      $procs = Get-Process -Id $pids -ErrorAction SilentlyContinue
      $ws = 0
      $cpu = 0.0
      foreach ($pr in $procs) {
        $ws += $pr.WorkingSet64
        if ($pr.CPU) { $cpu += $pr.CPU }
      }
      Write-Output "$([math]::Round($ws / 1MB, 1))|$([math]::Round($cpu, 3))|$($procs.Count)"
    `;
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
      timeout: 7000,
    }).trim();
    const [wsMb, cpuSec, procCount] = out.split('|').map(Number);
    return { wsMb: wsMb || 0, cpuSec: cpuSec || 0, procCount: procCount || 0 };
  } catch {
    return { wsMb: 0, cpuSec: 0, procCount: 0 };
  }
}

function httpJson({ port, reqPath, method = 'GET', body = null, headers = {} }) {
  return new Promise((resolve) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: {
          ...headers,
          ...(bodyStr
            ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(bodyStr),
            }
            : {}),
        },
        timeout: 8000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch { }
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: parsed, raw: data });
        });
      }
    );
    req.on('error', (err) => resolve({ status: 0, ok: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, ok: false, error: 'timeout' });
    });
    if (bodyStr) req.write(bodyStr);
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
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (err) => reject(err));
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: res, reject: rej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) rej(new Error(JSON.stringify(msg.error)));
            else res(msg.result);
          }
        } catch { }
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
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, userGesture = true) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (res?.exceptionDetails) {
      throw new Error(
        `CDP eval error: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`
      );
    }
    return res?.result?.value;
  }
  async screenshot(outFile) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    if (!res?.data) throw new Error('No screenshot data');
    fs.writeFileSync(outFile, Buffer.from(res.data, 'base64'));
  }
  close() {
    try {
      this.ws?.close();
    } catch { }
  }
}

async function listCdpTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) return [];
  return await res.json();
}

function getToastTargetId(t) {
  try {
    const u = new URL(t.url);
    if (u.searchParams.get('window') === 'toast' || u.searchParams.get('window') === 'progress') {
      return u.searchParams.get('id');
    }
  } catch { }
  return null;
}

async function waitForMainCdp(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await listCdpTargets(port);
      const main = targets.find(
        (t) =>
          t.type === 'page' &&
          t.webSocketDebuggerUrl &&
          !String(t.url).includes('window=toast')
      );
      if (main) return main;
    } catch { }
    await sleep(250);
  }
  throw new Error(`Main WebView2 CDP not ready on port ${port}`);
}

async function waitForProgressCdp(port, jobId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await listCdpTargets(port);
      const match = targets.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && getToastTargetId(t) === jobId
      );
      if (match) {
        const c = new CDPClient(match.webSocketDebuggerUrl);
        await c.connect();
        await c.send('Runtime.enable');
        await c.send('DOM.enable');
        await c.send('Page.enable');
        for (let i = 0; i < 30; i++) {
          const ready = await c.eval(
            `!!document.querySelector('.dl-popup-root .dl-win') && document.querySelector('#wt')?.textContent?.trim() !== 'TORI Download'`
          );
          if (ready) break;
          await sleep(150);
        }
        await sleep(200);
        return c;
      }
    } catch { }
    await sleep(200);
  }
  throw new Error(`Progress window CDP for job ${jobId} did not open within ${timeoutMs}ms`);
}

function seedQaDatabase(dbPath) {
  const py = `
import sqlite3, json, sys
db_path, dl_dir, token, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("""
CREATE TABLE IF NOT EXISTS engine_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
""")
app_settings = {
  "dir": dl_dir,
  "sort": False,
  "con": 8,
  "maxa": 4,
  "limMode": "off",
  "limV": 512,
  "limU": "KiB/s",
  "retries": 0,
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
  "showDownloadPopup": "always",
  "alwaysOnTop": True,
  "closeToTray": True
}
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("browser_integration_token", token))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("server_port", str(port)))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("app_settings", json.dumps(app_settings)))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES (?,?)", ("close_to_tray_migrated_v104", "true"))
conn.commit()
conn.close()
`;
  execFileSync('python', ['-c', py, dbPath, QA_DL_DIR, API_TOKEN, String(GUI_PORT)], {
    stdio: 'pipe',
  });
}

function readSettingFromSqlite(dbPath, key) {
  try {
    return execFileSync(
      'python',
      [
        '-c',
        'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); r=c.execute("SELECT value FROM engine_settings WHERE key=?", (sys.argv[2],)).fetchone(); print(r[0] if r else "")',
        dbPath,
        key,
      ],
      { encoding: 'utf8', timeout: 4000 }
    ).trim();
  } catch {
    return '';
  }
}

async function run() {
  console.log('========================================================================');
  console.log('  TORI GATE 29.2: IDM PROGRESS WINDOW MIGRATION VERIFICATION');
  console.log('========================================================================\n');

  if (!fs.existsSync(DESKTOP_EXE)) {
    throw new Error(`Desktop binary missing: ${DESKTOP_EXE}`);
  }

  const oemDbHashBefore = sha256File(OEM_DB_PATH);

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

  // Payloads for fixture HTTP server
  // 1) Multi-chunk range throttled payload (~6s across 8 connections at ~8 KB/45ms/conn)
  const multiRangePayload = crypto.randomBytes(6 * 1024 * 1024); // 6 MiB
  // 2) Fast payload for per-download speed limiter comparison (900 KB)
  const limitPayload = crypto.randomBytes(900 * 1024);
  // 3) Completion options payload (384 KB)
  const completeOptPayload = crypto.randomBytes(384 * 1024);
  // 4) Unknown total bytes streamed payload (180 KB)
  const unknownPayload = crypto.randomBytes(180 * 1024);
  // 5) Flaky/failing -> retryable payload
  const retryPayload = crypto.randomBytes(64 * 1024);
  let flakyShouldFail = true;

  const fixtureServer = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://127.0.0.1:${FIXTURE_PORT}`);
    const p = reqUrl.pathname;

    if (p === '/range-multi.bin' || p === '/range-close.bin') {
      const data = multiRangePayload;
      const total = data.length;
      const rangeHdr = req.headers.range;
      let start = 0;
      let end = total - 1;
      let status = 200;
      if (rangeHdr && rangeHdr.startsWith('bytes=')) {
        const [s, e] = rangeHdr.slice(6).split('-');
        start = parseInt(s, 10) || 0;
        end = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
        status = 206;
      }
      const headers = {
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'application/octet-stream',
      };
      if (status === 206) {
        headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
      }
      res.writeHead(status, headers);
      if (req.method === 'HEAD') return res.end();

      let offset = start;
      const chunkSz = 12 * 1024;
      const intervalMs = p === '/range-close.bin' ? 18 : 38;
      const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(timer);
          return;
        }
        const nextEnd = Math.min(offset + chunkSz - 1, end);
        res.write(data.subarray(offset, nextEnd + 1));
        offset = nextEnd + 1;
        if (offset > end) {
          clearInterval(timer);
          res.end();
        }
      }, intervalMs);
      req.on('close', () => clearInterval(timer));
      return;
    }

    if (p === '/limit-test.bin') {
      const data = limitPayload;
      const total = data.length;
      const rangeHdr = req.headers.range;
      if (rangeHdr && rangeHdr.startsWith('bytes=')) {
        const [s, e] = rangeHdr.slice(6).split('-');
        const start = parseInt(s, 10) || 0;
        const end = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
        res.writeHead(206, {
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Type': 'application/octet-stream',
        });
        return res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1));
      }
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': total,
        'Content-Type': 'application/octet-stream',
      });
      return res.end(req.method === 'HEAD' ? undefined : data);
    }

    if (p === '/complete-opt.txt') {
      const data = completeOptPayload;
      res.writeHead(200, {
        'Accept-Ranges': 'none',
        'Content-Length': data.length,
        'Content-Type': 'text/plain',
      });
      if (req.method === 'HEAD') return res.end();
      let off = 0;
      const t = setInterval(() => {
        if (res.writableEnded || res.destroyed) return clearInterval(t);
        const nxt = Math.min(off + 64 * 1024, data.length);
        res.write(data.subarray(off, nxt));
        off = nxt;
        if (off >= data.length) {
          clearInterval(t);
          res.end();
        }
      }, 250);
      req.on('close', () => clearInterval(t));
      return;
    }

    if (p === '/unknown-size.bin') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'none',
      });
      if (req.method === 'HEAD') return res.end();
      let off = 0;
      const t = setInterval(() => {
        if (res.writableEnded || res.destroyed) return clearInterval(t);
        const nxt = Math.min(off + 30 * 1024, unknownPayload.length);
        res.write(unknownPayload.subarray(off, nxt));
        off = nxt;
        if (off >= unknownPayload.length) {
          clearInterval(t);
          res.end();
        }
      }, 300);
      req.on('close', () => clearInterval(t));
      return;
    }

    if (p === '/flaky.bin') {
      if (flakyShouldFail && req.method === 'GET' && !req.headers.range) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('Upstream error');
      }
      res.writeHead(200, {
        'Content-Length': retryPayload.length,
        'Accept-Ranges': 'none',
        'Content-Type': 'application/octet-stream',
      });
      return res.end(req.method === 'HEAD' ? undefined : retryPayload);
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', resolve));

  const dbPath = path.join(QA_DATA_DIR, 'tdm_storage.sqlite');
  seedQaDatabase(dbPath);
  const pipeName = `\\\\.\\pipe\\tori-qa-g29-2-${process.pid}`;

  const proc = spawn(DESKTOP_EXE, [], {
    cwd: ROOT,
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
    },
    stdio: 'ignore',
  });
  trackedProcs.add(proc);

  try {
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

    const mainTarget = await waitForMainCdp(CDP_PORT, 20000);
    const mainCdp = new CDPClient(mainTarget.webSocketDebuggerUrl);
    await mainCdp.connect();
    await mainCdp.send('Runtime.enable');
    await mainCdp.send('DOM.enable');
    await mainCdp.send('Page.enable');
    for (let i = 0; i < 30; i++) {
      const ready = await mainCdp.eval(`!!document.querySelector('#main #right')`);
      if (ready) break;
      await sleep(200);
    }

    const baseStats = getTreeStats(proc.pid);
    record(
      'PERF-BASE',
      'Idle MainWindow memory & process baseline measured (no progress popups open)',
      baseStats.wsMb > 0,
      `ws=${baseStats.wsMb}MB, cpuSec=${baseStats.cpuSec}s, procs=${baseStats.procCount}`
    );

    // -------------------------------------------------------------------------
    // 1. Create active multi-chunk download & verify independent Light progress popup
    // -------------------------------------------------------------------------
    const addRes1 = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/range-multi.bin`,
        filename: 'range-multi.bin',
      },
    });
    const job1Id = addRes1.data?.job_id || addRes1.data?.job?.id || addRes1.data?.id;
    if (!job1Id) throw new Error(`Failed creating range-multi.bin: ${JSON.stringify(addRes1)}`);

    const pop1 = await waitForProgressCdp(CDP_PORT, job1Id, 15000);
    await sleep(1100);

    // Install <= 1 Hz DOM commit observer on active transfer
    await pop1.eval(`(() => {
      window.__popTitleChanges = 0;
      const wt = document.getElementById('wt');
      if (wt) {
        new MutationObserver(() => { window.__popTitleChanges++; }).observe(wt, { childList: true, characterData: true, subtree: true });
      }
    })()`);

    const lightSnapshot = await pop1.eval(`(() => {
      const w = document.getElementById('w');
      const rect = w.getBoundingClientRect();
      const cs = getComputedStyle(document.body);
      const gridTexts = Array.from(document.querySelectorAll('.dl-grid .k, .dl-grid .v')).map(e => e.textContent.trim());
      const conn = Number(document.getElementById('dl-conn-count')?.textContent?.trim() || '0');
      const segs = document.querySelectorAll('.dl-sg i').length;
      const btns = Array.from(document.querySelectorAll('.dl-foot .dl-btn')).map(b => ({ text: b.textContent.trim(), width: Math.round(b.getBoundingClientRect().width) }));
      return {
        theme: document.documentElement.dataset.theme,
        title: document.getElementById('wt')?.textContent?.trim(),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        blur: getComputedStyle(w).backdropFilter,
        conn,
        segs,
        btns,
        gridTexts,
      };
    })()`);

    await pop1.screenshot(path.join(SCREENSHOTS_DIR, '01_progress_downloading_light.png'));
    const hasCoreFields =
      lightSnapshot.theme === 'light' &&
      lightSnapshot.width === 460 &&
      lightSnapshot.conn >= 1 &&
      lightSnapshot.segs >= 1 &&
      lightSnapshot.btns.length === 2 &&
      lightSnapshot.btns[0].width === 110 &&
      lightSnapshot.btns[1].width === 110 &&
      lightSnapshot.gridTexts.includes('URL') &&
      lightSnapshot.gridTexts.includes('Resume capability') &&
      lightSnapshot.gridTexts.includes('Yes') &&
      (lightSnapshot.blur === 'none' || !lightSnapshot.blur);
    record(
      'UI-LIGHT',
      'Downloading Light Mode popup renders 460px IDM layout, real connections/segments & 110px buttons',
      hasCoreFields,
      JSON.stringify(lightSnapshot)
    );

    // Measure <= 1 Hz cadence over ~3.1s AND test Pause button -> Resume -> Complete!
    await sleep(3100);
    const titleChanges = await pop1.eval(`window.__popTitleChanges || 0`);
    record(
      'PERF-HZ',
      'Progress UI updates strictly throttled to <= 1 Hz during active transfer',
      titleChanges >= 1 && titleChanges <= 5,
      `titleUpdatesIn3.1s=${titleChanges}`
    );

    // Pause right inside popup
    await pop1.eval(`document.querySelector('.dl-foot .dl-btn.pri').click()`);
    for (let i = 0; i < 20; i++) {
      const st = await pop1.eval(`document.getElementById('w')?.dataset?.state`);
      if (st === 'paused') break;
      await sleep(150);
    }
    await sleep(250);

    // While paused, test reactive Theme -> Dark & Accent -> Ocean via MainWindow settings!
    await mainCdp.eval(`(async () => {
      const raw = JSON.parse(localStorage.getItem('tori_settings_v2') || '{}');
      raw.theme = 'dark';
      raw.accent = 'ocean';
      localStorage.setItem('tori_settings_v2', JSON.stringify(raw));
      await window.__TORI_INVOKE__('update_engine_settings', { settings: raw });
    })()`);
    await sleep(400);
    const pausedDarkCheck = await pop1.eval(`({
      state: document.getElementById('w')?.dataset?.state,
      theme: document.documentElement.dataset.theme,
      accent: document.documentElement.dataset.accent,
      conn: Number(document.getElementById('dl-conn-count')?.textContent?.trim() || '-1'),
      priBtn: document.querySelector('.dl-foot .dl-btn.pri')?.textContent?.trim(),
      barHasPaused: document.querySelector('.dl-bar')?.classList?.contains('paused')
    })`);
    await pop1.screenshot(path.join(SCREENSHOTS_DIR, '03_progress_paused.png'));
    record(
      'STATE-PAUSE-THEME',
      'Pause switches connections->0, bar->paused, btn->Resume & live Dark+Ocean theme propagates without restart',
      pausedDarkCheck.state === 'paused' &&
      pausedDarkCheck.theme === 'dark' &&
      pausedDarkCheck.accent === 'ocean' &&
      pausedDarkCheck.conn === 0 &&
      pausedDarkCheck.priBtn === 'Resume' &&
      pausedDarkCheck.barHasPaused,
      JSON.stringify(pausedDarkCheck)
    );

    // Compact Progress Mode (.dl-win.m) test & screenshot #08!
    await pop1.eval(`document.getElementById('mn').click()`);
    await sleep(300);
    const compactCheck = await pop1.eval(`({
      hasM: document.getElementById('w')?.classList?.contains('m'),
      winH: Math.round(document.getElementById('w').getBoundingClientRect().height),
      innerH: window.innerHeight,
      miniVisible: getComputedStyle(document.querySelector('.dl-mini')).display !== 'none',
      tabsHidden: getComputedStyle(document.querySelector('.dl-tabs')).display === 'none',
    })`);
    await pop1.screenshot(path.join(SCREENSHOTS_DIR, '08_compact_progress_mode.png'));
    record(
      'UI-COMPACT',
      'Compact Progress Mode (.m + .mini) shrinks native popup height <= 46px cleanly with restore toggle',
      compactCheck.hasM && compactCheck.winH <= 44 && compactCheck.innerH <= 46 && compactCheck.miniVisible && compactCheck.tabsHidden,
      JSON.stringify(compactCheck)
    );

    // Restore from Compact Mode back to Full Mode
    await pop1.eval(`document.getElementById('mn').click()`);
    await sleep(300);
    const restoredFullH = await pop1.eval(`window.innerHeight`);
    record('UI-RESTORE-COMPACT', 'Clicking restore square returns popup to full height', restoredFullH > 250, `restoredH=${restoredFullH}`);

    // Duplicate window prevention & restore when same download opened again!
    await mainCdp.eval(`window.__TORI_INVOKE__('open_progress_window', { id: ${JSON.stringify(job1Id)} })`);
    await sleep(300);
    const allTargetsAfterReopen = await listCdpTargets(CDP_PORT);
    const countJob1Targets = allTargetsAfterReopen.filter((t) => getToastTargetId(t) === job1Id).length;
    record(
      'WIN-NODUP',
      'Duplicate progress window prevented when same download opened again',
      countJob1Targets === 1,
      `targetsForJob1=${countJob1Targets}`
    );

    // Test Always-on-Top toggle ON -> OFF -> ON live!
    const aotOn = await pop1.eval(`window.__TAURI__.window.getCurrentWindow().isAlwaysOnTop()`);
    await mainCdp.eval(`(async () => {
      const s = JSON.parse(localStorage.getItem('tori_settings_v2') || '{}');
      s.alwaysOnTop = false;
      localStorage.setItem('tori_settings_v2', JSON.stringify(s));
      await window.__TORI_INVOKE__('update_engine_settings', { settings: s });
    })()`);
    await sleep(250);
    const aotOff = await pop1.eval(`window.__TAURI__.window.getCurrentWindow().isAlwaysOnTop()`);
    await mainCdp.eval(`(async () => {
      const s = JSON.parse(localStorage.getItem('tori_settings_v2') || '{}');
      s.alwaysOnTop = true;
      localStorage.setItem('tori_settings_v2', JSON.stringify(s));
      await window.__TORI_INVOKE__('update_engine_settings', { settings: s });
    })()`);
    await sleep(200);
    const aotRestored = await pop1.eval(`window.__TAURI__.window.getCurrentWindow().isAlwaysOnTop()`);
    record(
      'WIN-AOT',
      'Always-on-Top setting applies live to independent progress windows (true -> false -> true)',
      aotOn === true && aotOff === false && aotRestored === true,
      `on=${aotOn}, off=${aotOff}, restored=${aotRestored}`
    );

    // Measure RAM/CPU with both Main Window & Progress Window OPEN and visible (un-trimmed comparison vs baseline)
    const openPopStats = getTreeStats(proc.pid);
    record(
      'PERF-OPEN-STATS',
      'Measured desktop memory & CPU with Progress Window open',
      openPopStats.wsMb > 0,
      `ws=${openPopStats.wsMb}MB (delta=+${(openPopStats.wsMb - baseStats.wsMb).toFixed(1)}MB), cpu=${openPopStats.cpuSec}s, procs=${openPopStats.procCount}`
    );

    // Test Main Window minimized while Progress Window stays visible & live!
    await mainCdp.eval(`window.__TORI_INVOKE__('window_minimize')`);
    await sleep(300);
    const popVisibleWhileMainMin = await pop1.eval(`window.__TAURI__.window.getCurrentWindow().isVisible()`);
    record(
      'WIN-MAIN-MIN',
      'Progress window remains visible when Main Window is minimized',
      popVisibleWhileMainMin === true,
      `popVisible=${popVisibleWhileMainMin}`
    );

    // Restore Main Window cleanly
    await mainCdp.eval(`window.__TORI_INVOKE__('show_main_window')`);
    await sleep(200);

    // Resume download -> capture Dark Mode Downloading #02 -> wait for Completion -> #04!
    await pop1.eval(`document.querySelector('.dl-foot .dl-btn.pri').click()`);
    await sleep(1100);
    const darkActiveSnap = await pop1.eval(`({
      state: document.getElementById('w')?.dataset?.state,
      theme: document.documentElement.dataset.theme,
      conn: Number(document.getElementById('dl-conn-count')?.textContent?.trim() || '0'),
    })`);
    await pop1.screenshot(path.join(SCREENSHOTS_DIR, '02_progress_downloading_dark.png'));
    record(
      'UI-DARK-ACTIVE',
      'Dark Mode active downloading screenshot captured with resumed connections',
      darkActiveSnap.theme === 'dark' && darkActiveSnap.state === 'downloading' && darkActiveSnap.conn >= 1,
      JSON.stringify(darkActiveSnap)
    );

    // Wait for range-multi.bin completion
    let completed1 = false;
    for (let i = 0; i < 60; i++) {
      const st = await pop1.eval(`document.getElementById('w')?.dataset?.state`);
      if (st === 'completed') {
        completed1 = true;
        break;
      }
      await sleep(250);
    }
    await sleep(350);
    const completeSnap = await pop1.eval(`({
      state: document.getElementById('w')?.dataset?.state,
      title: document.getElementById('wt')?.textContent?.trim(),
      btns: Array.from(document.querySelectorAll('.dl-foot .dl-btn')).map(b => b.textContent.trim()),
      hasOpenFolderLink: !!document.querySelector('.dl-hint-link'),
      barDone: document.querySelector('.dl-bar')?.classList?.contains('done'),
    })`);
    await pop1.screenshot(path.join(SCREENSHOTS_DIR, '04_progress_completed.png'));
    const diskMulti = sha256File(path.join(QA_DL_DIR, 'range-multi.bin'));
    const expectedMultiSha = crypto.createHash('sha256').update(multiRangePayload).digest('hex');
    record(
      'STATE-COMPLETE',
      'Completed popup displays "Download complete", Close/Open buttons, Open folder link & exact SHA-256 on disk',
      completed1 &&
      completeSnap.title === 'Download complete' &&
      completeSnap.btns.join(',') === 'Close,Open' &&
      completeSnap.hasOpenFolderLink &&
      completeSnap.barDone &&
      diskMulti === expectedMultiSha,
      JSON.stringify(completeSnap)
    );

    // Switch back to Light mode for remaining tab screenshots & close pop1 cleanly
    await mainCdp.eval(`(async () => {
      const s = JSON.parse(localStorage.getItem('tori_settings_v2') || '{}');
      s.theme = 'light';
      s.accent = 'indigo';
      localStorage.setItem('tori_settings_v2', JSON.stringify(s));
      await window.__TORI_INVOKE__('update_engine_settings', { settings: s });
    })()`);
    await pop1.eval(`document.querySelector('.dl-foot .dl-btn:not(.pri)').click()`);
    pop1.close();
    await sleep(400);

    // -------------------------------------------------------------------------
    // 2. Failed + Retry verification & Screenshot #05
    // -------------------------------------------------------------------------
    const addFail = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/flaky.bin`,
        filename: 'flaky.bin',
      },
    });
    const failId = addFail.data?.job_id || addFail.data?.job?.id || addFail.data?.id;
    const popFail = await waitForProgressCdp(CDP_PORT, failId, 15000);
    for (let i = 0; i < 40; i++) {
      const st = await popFail.eval(`document.getElementById('w')?.dataset?.state`);
      if (st === 'failed') break;
      await sleep(150);
    }
    await sleep(250);
    const failSnap = await popFail.eval(`({
      state: document.getElementById('w')?.dataset?.state,
      title: document.getElementById('wt')?.textContent?.trim(),
      btns: Array.from(document.querySelectorAll('.dl-foot .dl-btn')).map(b => b.textContent.trim()),
      errVisible: !!document.querySelector('.dl-err-banner'),
      barFailed: document.querySelector('.dl-bar')?.classList?.contains('failed'),
    })`);
    await popFail.screenshot(path.join(SCREENSHOTS_DIR, '05_progress_failed.png'));

    flakyShouldFail = false;
    await popFail.eval(`document.querySelector('.dl-foot .dl-btn.pri').click()`);
    let retriedCompleted = false;
    for (let i = 0; i < 40; i++) {
      const st = await popFail.eval(`document.getElementById('w')?.dataset?.state`);
      if (st === 'completed') {
        retriedCompleted = true;
        break;
      }
      await sleep(150);
    }
    record(
      'STATE-FAIL-RETRY',
      'Failed download shows error UI & Retry recovers to 100% completion',
      failSnap.state === 'failed' &&
      failSnap.title === 'Download failed' &&
      failSnap.btns.join(',') === 'Close,Retry' &&
      failSnap.errVisible &&
      failSnap.barFailed &&
      retriedCompleted,
      JSON.stringify(failSnap)
    );
    await popFail.eval(`document.getElementById('cl').click()`);
    popFail.close();
    await sleep(300);

    // -------------------------------------------------------------------------
    // 3. Speed Limiter Tab UI Screenshot (#06) & Real Throttling + Independence vs Multiple Popups
    // -------------------------------------------------------------------------
    // Create paused job or fast limit job (pause right after create or test via open_progress_window)
    const limitJobRes = await mainCdp.eval(`(async () => {
      const j = await window.__TORI_INVOKE__('create_download', {
        url: 'http://127.0.0.1:${FIXTURE_PORT}/limit-test.bin',
        destination: null,
        priority: 'normal',
        referer: null,
        userAgent: null,
        scheduledAt: null
      });
      await window.__TORI_INVOKE__('pause_download', { id: j.id });
      await window.__TORI_INVOKE__('open_progress_window', { id: j.id });
      return j;
    })()`);
    const limitJobId = limitJobRes.id;
    const popLim = await waitForProgressCdp(CDP_PORT, limitJobId, 15000);
    await popLim.eval(`document.querySelector('.dl-tab[data-tab="limiter"]').click()`);
    await sleep(250);
    // Toggle speed limiter ON and set 180 KB/s cleanly
    await popLim.eval(`(() => {
      const cb = document.getElementById('dl-lim-enable');
      if (!cb.checked) cb.click();
      const inp = document.getElementById('dl-lim-value');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '180');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('blur', { bubbles: true }));
    })()`);
    await sleep(350);
    await popLim.screenshot(path.join(SCREENSHOTS_DIR, '06_progress_speed_limiter.png'));

    const limPersisted = readSettingFromSqlite(dbPath, `job_speed_limit:${limitJobId}`);
    // Measure real limited transfer time (900 KB at 180 KB/s -> >= 2.2s after initial burst)
    const startLimMs = Date.now();
    await popLim.eval(`document.querySelector('.dl-tab[data-tab="status"]').click()`);
    await sleep(100);
    await popLim.eval(`document.querySelector('.dl-foot .dl-btn.pri').click()`);
    let limDone = false;
    for (let i = 0; i < 80; i++) {
      const st = await popLim.eval(`document.getElementById('w')?.dataset?.state`);
      if (st === 'completed') {
        limDone = true;
        break;
      }
      await sleep(150);
    }
    const elapsedLimMs = Date.now() - startLimMs;
    const globalSettingsAfter = JSON.parse(readSettingFromSqlite(dbPath, 'app_settings') || '{}');
    record(
      'FEAT-LIMITER',
      'Per-download speed limiter (180 KB/s) persists, throttles real transfer & leaves global settings untouched',
      limDone && limPersisted === '180000' && elapsedLimMs >= 2000 && globalSettingsAfter.limMode === 'off',
      `persisted=${limPersisted}B/s, elapsedMs=${elapsedLimMs}, globalLimMode=${globalSettingsAfter.limMode}`
    );
    await popLim.eval(`document.getElementById('cl').click()`);
    popLim.close();
    await sleep(300);

    // -------------------------------------------------------------------------
    // 4. Options on Completion (#07: Close window + Notification)
    // -------------------------------------------------------------------------
    const optJobRes = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/complete-opt.txt`,
        filename: 'complete-opt.txt',
      },
    });
    const optJobId = optJobRes.data?.job_id || optJobRes.data?.job?.id || optJobRes.data?.id;
    const popOpt = await waitForProgressCdp(CDP_PORT, optJobId, 15000);
    await popOpt.eval(`document.querySelector('.dl-tab[data-tab="completion"]').click()`);
    await sleep(200);
    await popOpt.eval(`(async () => {
      const c1 = document.getElementById('dl-opt-close');
      if (!c1.checked) c1.click();
      await new Promise((r) => setTimeout(r, 120));
      const c2 = document.getElementById('dl-opt-notify');
      if (!c2.checked) c2.click();
      await new Promise((r) => setTimeout(r, 120));
    })()`);
    await sleep(250);
    await popOpt.screenshot(path.join(SCREENSHOTS_DIR, '07_progress_options_completion.png'));
    const optsSqlite = readSettingFromSqlite(dbPath, `job_completion_opts:${optJobId}`);

    let autoClosed = false;
    for (let i = 0; i < 40; i++) {
      const ts = await listCdpTargets(CDP_PORT);
      if (!ts.some((t) => getToastTargetId(t) === optJobId)) {
        autoClosed = true;
        break;
      }
      await sleep(250);
    }
    popOpt.close();
    const logPath = path.join(QA_DATA_DIR, 'logs', 'lifecycle.log');
    const logTxt = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    const notifyLogged = logTxt.includes('DOWNLOAD_COMPLETE') && logTxt.includes('complete-opt.txt');
    record(
      'FEAT-COMPLETE-OPTS',
      'Completion options persist, auto-close progress popup & dispatch completion notification',
      autoClosed && notifyLogged && optsSqlite.includes('"close_on_complete":true'),
      `autoClosed=${autoClosed}, notifyLogged=${notifyLogged}, opts=${optsSqlite}`
    );

    // -------------------------------------------------------------------------
    // 5. Unknown Total Bytes Stream + Multi-Popup Coexistence + Close-Does-Not-Cancel
    // -------------------------------------------------------------------------
    const unkRes = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/unknown-size.bin`,
        filename: 'unknown-size.bin',
      },
    });
    const unkId = unkRes.data?.job_id || unkRes.data?.job?.id || unkRes.data?.id;

    const bgCloseRes = await httpJson({
      port: GUI_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/range-close.bin`,
        filename: 'range-close.bin',
      },
    });
    const bgCloseId = bgCloseRes.data?.job_id || bgCloseRes.data?.job?.id || bgCloseRes.data?.id;

    const [popUnk, popBg] = await Promise.all([
      waitForProgressCdp(CDP_PORT, unkId, 15000),
      waitForProgressCdp(CDP_PORT, bgCloseId, 15000),
    ]);

    const targetsDuringDual = await listCdpTargets(CDP_PORT);
    const hasTwoIndependentPopups =
      targetsDuringDual.some((t) => getToastTargetId(t) === unkId) &&
      targetsDuringDual.some((t) => getToastTargetId(t) === bgCloseId);

    const unkSnap = await popUnk.eval(`({
      texts: Array.from(document.querySelectorAll('.dl-grid .v')).map(e => e.textContent.trim()),
      barUnknown: document.querySelector('.dl-bar')?.classList?.contains('unknown'),
    })`);

    // Close popBg immediately while transferring -> download MUST continue to 100% completion!
    await popBg.eval(`document.getElementById('cl').click()`);
    popBg.close();
    await sleep(400);
    const targetsAfterCloseBg = await listCdpTargets(CDP_PORT);
    const bgWindowClosed = !targetsAfterCloseBg.some((t) => getToastTargetId(t) === bgCloseId);

    // Wait for both unknown-size.bin and range-close.bin to finish in backend
    let bothFinished = false;
    for (let i = 0; i < 60; i++) {
      const listRes = await httpJson({
        port: GUI_PORT,
        reqPath: '/api/v1/downloads',
        headers: { 'X-Tori-Token': API_TOKEN },
      });
      const jobs = listRes.data?.jobs || listRes.data?.downloads || [];
      const u = jobs.find((j) => j.id === unkId);
      const b = jobs.find((j) => j.id === bgCloseId);
      if (u?.state === 'completed' && b?.state === 'completed') {
        bothFinished = true;
        break;
      }
      await sleep(250);
    }
    popUnk.close();
    const bgDiskSha = sha256File(path.join(QA_DL_DIR, 'range-close.bin'));
    const unkDiskSha = sha256File(path.join(QA_DL_DIR, 'unknown-size.bin'));
    const expectedUnkSha = crypto.createHash('sha256').update(unknownPayload).digest('hex');

    record(
      'MULTI-AND-CLOSE',
      'Multiple independent popups coexist cleanly & closing progress window leaves transfer running to exact completion',
      hasTwoIndependentPopups &&
      bgWindowClosed &&
      bothFinished &&
      bgDiskSha === expectedMultiSha &&
      unkDiskSha === expectedUnkSha &&
      unkSnap.texts.includes('Unknown') &&
      !unkSnap.texts.some((t) => t.includes('NaN')),
      JSON.stringify({ hasTwoIndependentPopups, bgWindowClosed, bothFinished, unkSnap })
    );

    mainCdp.close();
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
    } catch { }
  }

  console.log('\n========================================================================');
  console.log(`GATE 29.2 SUMMARY: PASS=${counts.PASS} FAIL=${counts.FAIL}`);
  console.log('========================================================================');
  if (counts.FAIL > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  cleanupTrackedProcs();
  process.exit(1);
});
