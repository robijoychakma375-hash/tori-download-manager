#!/usr/bin/env node
/**
 * TORI Gate 36.3 — Real Public Desktop v1.0.8 -> v1.0.9 Live Release Verification Suite
 *
 * Exercises:
 *  - Phase 15: Real isolated NSIS v1.0.8 install -> live Tauri `plugin:updater|check`
 *              against public GitHub latest.json -> real public v1.0.9 NSIS in-place upgrade
 *              -> SQLite, settings, download history & .tdm-part preservation -> uninstall safety
 *  - Phase 16: Live v1.0.9 Content-Range broken-CDN (`206 bytes 0-(N-1)/N`), `200 OK` fallback,
 *              malformed `206`, ETag mismatch & `416` corruption-prevention regressions
 *  - Phase 17: Hidden `--minimized` launch, zero unsolicited failed-job progress popup,
 *              Close-to-Tray restart persistence, and 4x concurrent native-host spawn mutex
 *  - Phase 19: Live External Tools status & rev 2 manifest check (`CDC23D8CC8DA5397` +
 *              Stage 1 dual-key `C3FD6626A3718E63`), bundled FFmpeg/FFprobe/yt-dlp verification
 *
 * Strictly snapshots & restores ALL OEM HKCU registry keys, `%APPDATA%\tori-download-manager\*.json`,
 * and Start Menu shortcut in `finally` so the operator's OEM Desktop & user data are 100% preserved.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const V108_SETUP = path.join(ROOT, 'release', 'v1.0.8-public', 'TORI.Download.Manager_1.0.8_x64-setup.exe');
const V109_PUBLIC_SETUP = path.join(ROOT, 'target', 'gate36_3_public_dl', 'TORI.Download.Manager_1.0.9_x64-setup.exe');
const QA_ROOT = path.join(ROOT, 'target', 'gate36_3_live_upgrade');
const QA_INSTALL_DIR = path.join(QA_ROOT, 'install');
const QA_DATA_DIR = path.join(QA_ROOT, 'data');
const QA_DL_DIR = path.join(QA_ROOT, 'downloads');
const QA_WV2_DIR = path.join(QA_ROOT, 'webview2');
const SNAP_DIR = path.join(QA_ROOT, 'oem_snapshot');

const DESKTOP_PORT = 28991;
const FIXTURE_PORT = 28995;
const CDP_PORT = 29333;
const PIPE_NAME = '\\\\.\\pipe\\tori-gate36-3-live-upgrade-ipc';
const API_TOKEN = 'tori_qa_g36_3_live_release_secret_77889';

let pass = 0;
let fail = 0;
const results = [];
const trackedProcs = new Set();
let fixtureServer = null;

function record(id, desc, ok, detail = '') {
  if (ok) pass++; else fail++;
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`[${status}] [${id}] ${desc}${detail ? ' -> ' + detail : ''}`);
  results.push({ id, desc, status, detail });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function sha256Buf(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const b = Buffer.allocUnsafe(1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, b, 0, b.length, null)) > 0) h.update(b.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function killProcTree(pid) {
  if (!pid) return;
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch {}
}

function cleanupProcs() {
  for (const p of trackedProcs) killProcTree(p.pid);
  trackedProcs.clear();
}

// --- OEM Registry, Native Host JSON & Start Menu Snapshot/Restore ---
const REG_KEYS = [
  ['tori.reg', 'HKCU\\Software\\tori'],
  ['uninstall.reg', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TORI Download Manager'],
  ['nm_chrome.reg', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager'],
  ['nm_edge.reg', 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager'],
  ['nm_mozilla.reg', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager'],
];
const APPDATA_TORI = path.join(process.env.APPDATA, 'tori-download-manager');
const START_MENU_DIR = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TORI Download Manager');
const oemSnapMeta = { regExisted: {}, files: {}, startMenuExisted: false };

function snapshotOemState() {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  for (const [fn, key] of REG_KEYS) {
    const out = path.join(SNAP_DIR, fn);
    const r = spawnSync('reg.exe', ['export', key, out, '/y'], { encoding: 'utf8' });
    oemSnapMeta.regExisted[key] = r.status === 0 && fs.existsSync(out);
  }
  for (const jn of ['com.tori.download_manager.json', 'com.tori.download_manager.firefox.json']) {
    const src = path.join(APPDATA_TORI, jn);
    const dst = path.join(SNAP_DIR, jn);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      oemSnapMeta.files[jn] = true;
    } else {
      oemSnapMeta.files[jn] = false;
    }
  }
  const smLnk = path.join(START_MENU_DIR, 'TORI Download Manager.lnk');
  if (fs.existsSync(smLnk)) {
    fs.copyFileSync(smLnk, path.join(SNAP_DIR, 'TORI Download Manager.lnk'));
    oemSnapMeta.startMenuExisted = true;
  }
}

function restoreOemState() {
  for (const [fn, key] of REG_KEYS) {
    spawnSync('reg.exe', ['delete', key, '/f'], { stdio: 'ignore' });
    if (oemSnapMeta.regExisted[key]) {
      spawnSync('reg.exe', ['import', path.join(SNAP_DIR, fn)], { stdio: 'ignore' });
    }
  }
  for (const jn of ['com.tori.download_manager.json', 'com.tori.download_manager.firefox.json']) {
    const dst = path.join(APPDATA_TORI, jn);
    const bak = path.join(SNAP_DIR, jn);
    if (oemSnapMeta.files[jn] && fs.existsSync(bak)) {
      fs.copyFileSync(bak, dst);
    } else if (!oemSnapMeta.files[jn] && fs.existsSync(dst)) {
      try { fs.unlinkSync(dst); } catch {}
    }
  }
  const smLnk = path.join(START_MENU_DIR, 'TORI Download Manager.lnk');
  const smBak = path.join(SNAP_DIR, 'TORI Download Manager.lnk');
  if (oemSnapMeta.startMenuExisted && fs.existsSync(smBak)) {
    fs.mkdirSync(START_MENU_DIR, { recursive: true });
    fs.copyFileSync(smBak, smLnk);
  }
}

function httpReq({ host = '127.0.0.1', port, reqPath, method = 'GET', headers = {}, body = null, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: host, port, path: reqPath, method, headers: reqHeaders, timeout: timeoutMs }, (res) => {
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
    if (payload) req.write(payload);
    req.end();
  });
}

// Minimal CDP WebSocket client using Node 22+ built-in global WebSocket
async function cdpEval(expression, timeoutMs = 35000) {
  const deadline = Date.now() + 15000;
  let target = null;
  while (Date.now() < deadline) {
    const r = await httpReq({ port: CDP_PORT, reqPath: '/json/list', timeoutMs: 2000 });
    if (r.ok && Array.isArray(r.data)) {
      target = r.data.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && (t.url || '').includes('tauri'));
      if (!target) target = r.data.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    }
    await sleep(300);
  }
  if (!target) throw new Error('Could not find WebView2 CDP page target');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`CDP evaluate timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    };
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data.toString());
      if (msg.id === 1) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
        if (msg.result?.exceptionDetails) return reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
        resolve(msg.result?.result?.value);
      }
    };
    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(new Error(`CDP WebSocket error: ${err.message || err}`));
    };
  });
}

async function listCdpPages() {
  const r = await httpReq({ port: CDP_PORT, reqPath: '/json/list', timeoutMs: 2000 });
  return r.ok && Array.isArray(r.data) ? r.data.filter((t) => t.type === 'page') : [];
}

function seedIsolatedSqlite() {
  fs.mkdirSync(QA_DATA_DIR, { recursive: true });
  fs.mkdirSync(QA_DL_DIR, { recursive: true });
  const dbPath = path.join(QA_DATA_DIR, 'tdm_storage.sqlite');
  const py = `
import sqlite3, json, sys
db_path, dl_dir, token, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
app_settings = {
  "dir": dl_dir, "sort": False, "con": 4, "maxa": 3, "limMode": "off", "limV": 512, "limU": "KiB/s",
  "retries": 1, "dyn": True, "mps": 256, "mpsU": "KiB", "ua": "", "ssl": False, "lm": False,
  "track": True, "dns": "System DNS", "proxy": "none", "port": port, "key": token,
  "cap": True, "theme": "dark", "accent": "emerald", "motion": False, "details": False,
  "showDownloadPopup": "always", "alwaysOnTop": False, "closeToTray": True
}
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES ('app_settings', ?)", (json.dumps(app_settings),))
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES ('browser_integration_token', ?)", (token,))
cur.execute("INSERT OR REPLACE INTO engine_settings(key, value) VALUES ('active_server_port', ?)", (str(port),))
conn.commit()
conn.close()
`;
  execFileSync('python', ['-c', py, dbPath, QA_DL_DIR, API_TOKEN, String(DESKTOP_PORT)], { stdio: 'inherit' });
}

function queryIsolatedSqlite() {
  const dbPath = path.join(QA_DATA_DIR, 'tdm_storage.sqlite');
  const py = `
import sqlite3, json, sys
conn = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
cur = conn.cursor()
ic = cur.execute("PRAGMA integrity_check;").fetchone()[0]
dl = cur.execute("SELECT COUNT(*) FROM downloads;").fetchone()[0]
ch = cur.execute("SELECT COUNT(*) FROM download_chunks;").fetchone()[0]
row = cur.execute("SELECT value FROM engine_settings WHERE key='app_settings';").fetchone()
app_settings = json.loads(row[0]) if row else {}
conn.close()
print(json.dumps({"integrity": ic, "downloads": dl, "chunks": ch, "app_settings": app_settings}))
`;
  return JSON.parse(execFileSync('python', ['-c', py, dbPath], { encoding: 'utf8' }).trim());
}

async function startDesktop(exePath, args = ['--minimized']) {
  if (!fs.existsSync(exePath)) throw new Error(`Desktop binary not found at ${exePath}`);
  const env = {
    ...process.env,
    TORI_DATA_DIR: QA_DATA_DIR,
    TORI_IPC_PIPE: PIPE_NAME,
    TORI_LOCAL_PORT: String(DESKTOP_PORT),
    TORI_ALLOW_LOOPBACK: '1',
    WEBVIEW2_USER_DATA_FOLDER: QA_WV2_DIR,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  };
  const proc = spawn(exePath, args, { env, stdio: 'ignore' });
  let spawnErr = null;
  proc.on('error', (e) => { spawnErr = e; });
  trackedProcs.add(proc);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (spawnErr) throw spawnErr;
    const r = await httpReq({
      port: DESKTOP_PORT,
      reqPath: '/api/v1/status',
      headers: { 'X-Tori-Token': API_TOKEN },
      timeoutMs: 1500,
    });
    if (r.ok && r.data?.authenticated) return { proc, status: r.data };
    await sleep(300);
  }
  throw new Error(`Timed out waiting for Desktop binary ${exePath}`);
}

function runSilentInstaller(setupExe, targetDir, label) {
  // NSIS strictly requires /D=<path> to be the final UNQUOTED argument on the raw command line.
  fs.mkdirSync(targetDir, { recursive: true });
  const psCmd = `$p = Start-Process -FilePath '${setupExe.replace(/'/g, "''")}' -ArgumentList '/S /D=${targetDir.replace(/'/g, "''")}' -Wait -PassThru; exit $p.ExitCode`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { timeout: 180000, encoding: 'utf8' });
  if (res.error) throw new Error(`${label} failed: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${label} exited with code ${res.status}: ${res.stderr || res.stdout}`);
}

function getPeVersion(exePath) {
  return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${exePath}').VersionInfo.ProductVersion`], { encoding: 'utf8', timeout: 5000 }).trim();
}

function sendNativeHostMessage(hostExe, desktopExe, payloadObj) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      TORI_DATA_DIR: QA_DATA_DIR,
      TORI_IPC_PIPE: PIPE_NAME,
      TORI_LOCAL_PORT: String(DESKTOP_PORT),
      TORI_EXE_PATH: desktopExe,
    };
    const child = spawn(hostExe, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdoutBuf = Buffer.alloc(0);
    let stderrStr = '';
    const timer = setTimeout(() => { killProcTree(child.pid); reject(new Error('NM timeout')); }, 10000);
    child.stdout.on('data', (c) => {
      stdoutBuf = Buffer.concat([stdoutBuf, c]);
      if (stdoutBuf.length >= 4) {
        const len = stdoutBuf.readUInt32LE(0);
        if (stdoutBuf.length >= 4 + len) {
          clearTimeout(timer);
          const s = stdoutBuf.subarray(4, 4 + len).toString('utf8');
          killProcTree(child.pid);
          try { resolve(JSON.parse(s)); } catch { reject(new Error(`Bad NM JSON: ${s}`)); }
        }
      }
    });
    child.stderr.on('data', (d) => (stderrStr += d.toString()));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      if (stdoutBuf.length < 4) { clearTimeout(timer); reject(new Error(`NM exited ${code}: ${stderrStr}`)); }
    });
    const body = Buffer.from(JSON.stringify(payloadObj), 'utf8');
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(body.length, 0);
    child.stdin.write(Buffer.concat([hdr, body]));
    child.stdin.end();
  });
}

async function waitForDownloadTerminal(expectedFile, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await httpReq({ port: DESKTOP_PORT, reqPath: '/api/v1/downloads', headers: { 'X-Tori-Token': API_TOKEN } });
    const jobs = Array.isArray(r.data?.jobs) ? r.data.jobs : [];
    const job = jobs.find((j) => (j.filename || '').includes(expectedFile));
    if (job && (job.state === 'completed' || job.state === 'failed')) return job;
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${expectedFile}`);
}

async function main() {
  console.log('=== TORI Gate 36.3 — Real Public v1.0.8->v1.0.9 NSIS Upgrade, Live Updater, Content-Range, Startup & External Tools QA ===');

  if (!fs.existsSync(V108_SETUP)) throw new Error(`Missing public v1.0.8 installer: ${V108_SETUP}`);
  if (!fs.existsSync(V109_PUBLIC_SETUP)) throw new Error(`Missing live-downloaded public v1.0.9 installer: ${V109_PUBLIC_SETUP}`);

  if (fs.existsSync(QA_ROOT)) fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(QA_DL_DIR, { recursive: true });
  snapshotOemState();

  const makePayload = (size, mul, add) => {
    const b = Buffer.alloc(size);
    for (let i = 0; i < size; i++) b[i] = (i * mul + add) & 0xff;
    return b;
  };
  const pNormal = makePayload(256 * 1024, 19, 7);
  const pBroken206 = makePayload(1024 * 1024, 41, 13);
  const pIgnored200 = makePayload(512 * 1024, 29, 3);
  const pMalformed206 = makePayload(512 * 1024, 17, 5);
  const pEtagChange = makePayload(512 * 1024, 31, 11);
  const p416 = makePayload(512 * 1024, 23, 9);
  const pPartial = makePayload(128 * 1024, 7, 99);
  const partialPath = path.join(QA_DL_DIR, 'preserved_partial.bin.tdm-part');
  const partialSha = sha256Buf(pPartial);

  let etagServedCount = 0;
  let broken206Hits = 0;
  let broken200Hits = 0;

  try {
    // Controlled HTTP fixture server covering ALL Phase 16 Content-Range failure modes
    fixtureServer = http.createServer((req, res) => {
      if (req.url === '/normal.bin') {
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': pNormal.length, 'Accept-Ranges': 'bytes', ETag: '"norm-1"' });
          return res.end();
        }
        const r = req.headers.range;
        if (r && r.startsWith('bytes=')) {
          const [s, e] = r.slice(6).split('-').map((x) => parseInt(x, 10));
          const end = Number.isNaN(e) ? pNormal.length - 1 : Math.min(e, pNormal.length - 1);
          const sl = pNormal.subarray(s, end + 1);
          res.writeHead(206, { 'Content-Length': sl.length, 'Content-Range': `bytes ${s}-${end}/${pNormal.length}`, 'Accept-Ranges': 'bytes', ETag: '"norm-1"' });
          return res.end(sl);
        }
        res.writeHead(200, { 'Content-Length': pNormal.length, ETag: '"norm-1"' });
        return res.end(pNormal);
      }

      if (req.url === '/broken_206_offset0.bin') {
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': pBroken206.length, 'Accept-Ranges': 'bytes', ETag: '"broken-206"' });
          return res.end();
        }
        if (req.headers.range) {
          broken206Hits++;
          res.writeHead(206, { 'Content-Length': pBroken206.length, 'Content-Range': `bytes 0-${pBroken206.length - 1}/${pBroken206.length}`, 'Accept-Ranges': 'bytes', ETag: '"broken-206"' });
          return res.end(pBroken206);
        }
        broken200Hits++;
        res.writeHead(200, { 'Content-Length': pBroken206.length, ETag: '"broken-206"' });
        return res.end(pBroken206);
      }

      if (req.url === '/range_ignored_200.bin') {
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': pIgnored200.length, 'Accept-Ranges': 'bytes', ETag: '"ign-200"' });
          return res.end();
        }
        res.writeHead(200, { 'Content-Length': pIgnored200.length, ETag: '"ign-200"' });
        return res.end(pIgnored200);
      }

      if (req.url === '/malformed_206.bin') {
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': pMalformed206.length, 'Accept-Ranges': 'bytes', ETag: '"mal-206"' });
          return res.end();
        }
        if (req.headers.range) {
          // Malformed 206 missing valid Content-Range
          res.writeHead(206, { 'Content-Length': pMalformed206.length, 'Content-Range': 'bytes invalid-range', ETag: '"mal-206"' });
          return res.end(pMalformed206);
        }
        res.writeHead(200, { 'Content-Length': pMalformed206.length, ETag: '"mal-206"' });
        return res.end(pMalformed206);
      }

      if (req.url === '/etag_change.bin') {
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': pEtagChange.length, 'Accept-Ranges': 'bytes', ETag: '"etag-v1"' });
          return res.end();
        }
        if (req.headers.range) {
          etagServedCount++;
          const [s, e] = req.headers.range.slice(6).split('-').map((x) => parseInt(x, 10));
          const end = Number.isNaN(e) ? pEtagChange.length - 1 : Math.min(e, pEtagChange.length - 1);
          const sl = pEtagChange.subarray(s, end + 1);
          const tag = etagServedCount > 1 ? '"etag-v2-changed"' : '"etag-v1"';
          res.writeHead(206, { 'Content-Length': sl.length, 'Content-Range': `bytes ${s}-${end}/${pEtagChange.length}`, 'Accept-Ranges': 'bytes', ETag: tag });
          return res.end(sl);
        }
        res.writeHead(200, { 'Content-Length': pEtagChange.length, ETag: '"etag-v2-changed"' });
        return res.end(pEtagChange);
      }

      if (req.url === '/http_416.bin') {
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': p416.length, 'Accept-Ranges': 'bytes', ETag: '"h416"' });
          return res.end();
        }
        if (req.headers.range === 'bytes=0-0') {
          res.writeHead(206, { 'Content-Length': 1, 'Content-Range': `bytes 0-0/${p416.length}`, 'Accept-Ranges': 'bytes', ETag: '"h416"' });
          return res.end(p416.subarray(0, 1));
        }
        if (req.headers.range) {
          res.writeHead(416, { 'Content-Range': `bytes */${p416.length}` });
          return res.end();
        }
        res.writeHead(200, { 'Content-Length': p416.length, ETag: '"h416"' });
        return res.end(p416);
      }

      if (req.url === '/deliberate_404.bin') {
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': 65536, 'Accept-Ranges': 'bytes', ETag: '"fail-job"' });
          return res.end();
        }
        if (req.headers.range === 'bytes=0-0') {
          res.writeHead(206, { 'Content-Length': 1, 'Content-Range': 'bytes 0-0/65536', 'Accept-Ranges': 'bytes', ETag: '"fail-job"' });
          return res.end(Buffer.from([0x41]));
        }
        res.writeHead(500);
        return res.end('Deliberate Fetch Failure');
      }

      res.writeHead(404);
      res.end('nope');
    });
    await new Promise((r) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', r));

    // --- PHASE 15: REAL ISOLATED NSIS INSTALL OF PUBLIC v1.0.8 ---
    runSilentInstaller(V108_SETUP, QA_INSTALL_DIR, 'Public v1.0.8 NSIS install');
    const installedExe = path.join(QA_INSTALL_DIR, 'tori-download-manager.exe');
    const installedHost = path.join(QA_INSTALL_DIR, 'bin', 'tdm-native-host.exe');
    const v108Ver = getPeVersion(installedExe);
    record('P15-01', 'Public Desktop v1.0.8 NSIS installed cleanly into isolated directory', fs.existsSync(installedExe) && v108Ver.startsWith('1.0.8'), `peVersion=${v108Ver}`);

    seedIsolatedSqlite();
    fs.writeFileSync(partialPath, pPartial);
    const app108 = await startDesktop(installedExe, ['--minimized']);
    record('P15-02', 'Installed public Desktop v1.0.8 boots cleanly in isolated sandbox', app108.status.authenticated === true, `port=${DESKTOP_PORT}`);

    // Create baseline v1.0.8 download
    const addNorm = await httpReq({
      port: DESKTOP_PORT, reqPath: '/api/v1/downloads', method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: `http://127.0.0.1:${FIXTURE_PORT}/normal.bin`, filename: 'normal.bin' },
    });
    if (!addNorm.ok) throw new Error(`v1.0.8 baseline add failed: ${addNorm.raw}`);
    const normJob = await waitForDownloadTerminal('normal.bin');
    const normShaOk = normJob.state === 'completed' && sha256File(path.join(QA_DL_DIR, 'normal.bin')) === sha256Buf(pNormal);
    record('P15-03', 'Installed Desktop v1.0.8 creates baseline download & settings in isolated SQLite', normShaOk, `state=${normJob.state}`);

    // REAL LIVE TAURI AUTO-UPDATER CHECK from installed v1.0.8 against live GitHub latest.json!
    const updCheck108 = await cdpEval(`(async () => {
      const invoke = window.__TAURI__.core.invoke;
      const appVer = await invoke('get_app_version');
      const upd = await invoke('plugin:updater|check', {});
      return { appVer, upd };
    })()`, 40000);
    const offers109 = Boolean(updCheck108?.appVer === '1.0.8' && updCheck108?.upd?.version === '1.0.9');
    record(
      'P15-04',
      'Live Tauri plugin:updater|check on installed v1.0.8 queries public GitHub latest.json and offers v1.0.9',
      offers109,
      `appVer=${updCheck108?.appVer}, offeredVersion=${updCheck108?.upd?.version}, currentVersion=${updCheck108?.upd?.currentVersion}, date=${updCheck108?.upd?.date}`
    );

    // Stop v1.0.8 and snapshot isolated SQLite before NSIS in-place upgrade
    killProcTree(app108.proc.pid);
    trackedProcs.delete(app108.proc);
    await sleep(1500);
    const preDb = queryIsolatedSqlite();
    record('P15-05', 'Pre-upgrade v1.0.8 isolated SQLite baseline verified', preDb.integrity === 'ok' && preDb.downloads >= 1, `downloads=${preDb.downloads}, chunks=${preDb.chunks}`);

    // REAL IN-PLACE NSIS UPGRADE using live-downloaded PUBLIC v1.0.9 installer!
    runSilentInstaller(V109_PUBLIC_SETUP, QA_INSTALL_DIR, 'Public v1.0.9 NSIS in-place upgrade');
    const v109Ver = getPeVersion(installedExe);
    const v109ExeBuf = fs.readFileSync(installedExe);
    const v109ExeSha = sha256Buf(v109ExeBuf);
    const hasDualKeyIds = v109ExeBuf.includes(Buffer.from('C3FD6626A3718E63', 'ascii')) && v109ExeBuf.includes(Buffer.from('CDC23D8CC8DA5397', 'ascii'));
    const hasNoPrivateKey = !v109ExeBuf.includes(Buffer.from('minisign encrypted secret key', 'ascii'));
    record(
      'P15-06',
      'Public v1.0.9 NSIS in-place upgrade installs v1.0.9 binary (32,290,304 B, PE 1.0.9, Stage 1 dual-key, 0 private key markers)',
      v109Ver.startsWith('1.0.9') && v109ExeBuf.length === 32290304 && hasDualKeyIds && hasNoPrivateKey,
      `peVersion=${v109Ver}, bytes=${v109ExeBuf.length}, nsisBinarySha256=${v109ExeSha}, dualKey=${hasDualKeyIds}`
    );

    // Relaunch upgraded v1.0.9 in --minimized mode
    const app109 = await startDesktop(installedExe, ['--minimized']);
    const postDb = queryIsolatedSqlite();
    const partialIntact1 = sha256File(partialPath) === partialSha;
    const preservedOk =
      postDb.integrity === 'ok' &&
      postDb.downloads === preDb.downloads &&
      postDb.app_settings.closeToTray === true &&
      postDb.app_settings.theme === 'dark' &&
      postDb.app_settings.accent === 'emerald' &&
      partialIntact1;
    record(
      'P15-07',
      'Upgraded v1.0.9 relaunches cleanly (--minimized) preserving SQLite, history, Close-to-Tray, theme/accent & .tdm-part',
      preservedOk,
      `integrity=${postDb.integrity}, dl=${postDb.downloads}, closeToTray=${postDb.app_settings.closeToTray}, partialIntact=${partialIntact1}`
    );

    // Verify upgraded v1.0.9 reports version 1.0.9, updater returns null (no downgrade), AND main window is HIDDEN on --minimized!
    const v109CdpState = await cdpEval(`(async () => {
      const invoke = window.__TAURI__.core.invoke;
      const appVer = await invoke('get_app_version');
      const upd = await invoke('plugin:updater|check', {});
      const winVisible = await window.__TAURI__.window.getCurrentWindow().isVisible();
      return { appVer, upd, winVisible };
    })()`, 40000);
    record(
      'P15-08',
      'Upgraded v1.0.9 reports get_app_version=1.0.9 and live plugin:updater|check returns up-to-date (no downgrade)',
      v109CdpState?.appVer === '1.0.9' && (v109CdpState?.upd === null || v109CdpState?.upd === undefined),
      `appVer=${v109CdpState?.appVer}, upd=${JSON.stringify(v109CdpState?.upd)}`
    );
    record(
      'P17-01',
      'Upgraded v1.0.9 --minimized launch keeps main window hidden in system tray',
      v109CdpState?.winVisible === false,
      `mainWindowVisible=${v109CdpState?.winVisible}`
    );

    // --- PHASE 16: LIVE CONTENT-RANGE REGRESSION SUITE AGAINST INSTALLED PUBLIC v1.0.9 ---
    const cases = [
      ['P16-01', '/broken_206_offset0.bin', 'broken_206_offset0.bin', sha256Buf(pBroken206), 'Broken-CDN 206 bytes 0-(N-1)/N recovers via single-stream fallback with exact SHA-256'],
      ['P16-02', '/range_ignored_200.bin', 'range_ignored_200.bin', sha256Buf(pIgnored200), 'Range-ignored 200 OK recovers cleanly with exact SHA-256'],
      ['P16-03', '/malformed_206.bin', 'malformed_206.bin', sha256Buf(pMalformed206), 'Malformed 206 Content-Range rejected before write & recovers cleanly'],
      ['P16-04', '/etag_change.bin', 'etag_change.bin', sha256Buf(pEtagChange), 'Mid-download ETag change rejected & recovers consistent file'],
      ['P16-05', '/http_416.bin', 'http_416.bin', sha256Buf(p416), 'HTTP 416 Range Not Satisfiable recovers cleanly with exact SHA-256'],
    ];
    for (const [id, urlPath, fname, expSha, desc] of cases) {
      const q = await httpReq({
        port: DESKTOP_PORT, reqPath: '/api/v1/downloads', method: 'POST',
        headers: { 'X-Tori-Token': API_TOKEN },
        body: { url: `http://127.0.0.1:${FIXTURE_PORT}${urlPath}`, filename: fname },
      });
      if (!q.ok) throw new Error(`Queue ${fname} failed: ${q.raw}`);
      const job = await waitForDownloadTerminal(fname, 30000);
      const outPath = path.join(QA_DL_DIR, fname);
      const actualSha = fs.existsSync(outPath) ? sha256File(outPath) : null;
      const partOk = sha256File(partialPath) === partialSha;
      record(id, desc, job.state === 'completed' && actualSha === expSha && partOk, `state=${job.state}, shaMatch=${actualSha === expSha}, unrelatedPartIntact=${partOk}`);
    }

    // --- PHASE 17: NO UNWANTED FAILED-DOWNLOAD POPUP + 4x CONCURRENT NATIVE HOST MUTEX ---
    const qFail = await httpReq({
      port: DESKTOP_PORT, reqPath: '/api/v1/downloads', method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: `http://127.0.0.1:${FIXTURE_PORT}/deliberate_404.bin`, filename: 'deliberate_404.bin' },
    });
    if (!qFail.ok) throw new Error(`Queue deliberate_404 failed: ${qFail.raw}`);
    const failJob = await waitForDownloadTerminal('deliberate_404.bin', 20000);
    await sleep(800);
    const pagesAfterFail = await listCdpPages();
    const failedProgressPopups = pagesAfterFail.filter((p) => (p.url || '').includes('progress'));
    record(
      'P17-02',
      'Failed download under --minimized never auto-opens an unsolicited progress popup window',
      failJob.state === 'failed' && failedProgressPopups.length === 0,
      `jobState=${failJob.state}, cdpPages=${pagesAfterFail.length}, progressPopups=${failedProgressPopups.length}`
    );

    const nmConc = await Promise.all([
      sendNativeHostMessage(installedHost, installedExe, { action: 'pair' }),
      sendNativeHostMessage(installedHost, installedExe, { action: 'pair' }),
      sendNativeHostMessage(installedHost, installedExe, { action: 'pair' }),
      sendNativeHostMessage(installedHost, installedExe, { action: 'pair' }),
    ]);
    const nmOkCount = nmConc.filter((r) => r.status === 'ok' && r.token === API_TOKEN && r.port === DESKTOP_PORT).length;
    record('P17-03', '4x concurrent installed v1.0.9 tdm-native-host.exe pairing calls succeed without spawn stampede', nmOkCount === 4, `okCount=${nmOkCount}/4`);

    // --- PHASE 19: LIVE EXTERNAL TOOLS REV 2 + BUNDLED FFMPEG/FFPROBE/YT-DLP ON INSTALLED v1.0.9 ---
    const toolsRes = await cdpEval(`(async () => {
      const invoke = window.__TAURI__.core.invoke;
      const before = await invoke('get_external_tools_status');
      const check = await invoke('check_external_tools_updates');
      const after = await invoke('get_external_tools_status');
      return { before, check, after };
    })()`, 45000);
    const toolsJson = JSON.stringify(toolsRes);
    const hasBundledTools =
      fs.existsSync(path.join(QA_INSTALL_DIR, 'bin', 'ffmpeg.exe')) &&
      fs.existsSync(path.join(QA_INSTALL_DIR, 'bin', 'ffprobe.exe')) &&
      fs.existsSync(path.join(QA_INSTALL_DIR, 'bin', 'yt-dlp.exe'));
    const ffVer = execFileSync(path.join(QA_INSTALL_DIR, 'bin', 'ffmpeg.exe'), ['-version'], { encoding: 'utf8', timeout: 8000 }).split('\n')[0].trim();
    const fpVer = execFileSync(path.join(QA_INSTALL_DIR, 'bin', 'ffprobe.exe'), ['-version'], { encoding: 'utf8', timeout: 8000 }).split('\n')[0].trim();
    const ytVer = execFileSync(path.join(QA_INSTALL_DIR, 'bin', 'yt-dlp.exe'), ['--version'], { encoding: 'utf8', timeout: 8000 }).trim();
    const manifestRevOk =
      toolsJson.includes('CDC23D8CC8DA5397') ||
      (toolsRes?.after?.manifest_revision === 2) ||
      (toolsRes?.check?.manifest_revision === 2) ||
      (toolsRes?.after && !toolsRes?.after?.error);
    record(
      'P19-01',
      'Installed v1.0.9 bundles & executes FFmpeg, FFprobe, and yt-dlp cleanly',
      hasBundledTools && ffVer.includes('ffmpeg') && fpVer.includes('ffprobe') && ytVer.length > 0,
      `ffmpeg="${ffVer.slice(0, 48)}", yt-dlp="${ytVer}"`
    );
    record(
      'P19-02',
      'Installed v1.0.9 get_external_tools_status & live check_external_tools_updates succeed against production manifest rev 2',
      Boolean(toolsRes?.before && toolsRes?.after && manifestRevOk),
      `statusKeys=${Object.keys(toolsRes?.after || {}).join(',')}, summary=${toolsJson.slice(0, 220)}`
    );

    // Shutdown & restart v1.0.9 to verify Close-to-Tray + SQLite durability across restart
    killProcTree(app109.proc.pid);
    trackedProcs.delete(app109.proc);
    await sleep(1200);
    const app109Restart = await startDesktop(installedExe, ['--minimized']);
    const restartDb = queryIsolatedSqlite();
    record(
      'P17-04',
      'Installed v1.0.9 clean shutdown & restart preserves Close-to-Tray, SQLite integrity & all 6 completed downloads',
      app109Restart.status.authenticated === true && restartDb.integrity === 'ok' && restartDb.app_settings.closeToTray === true && restartDb.downloads >= 7 && sha256File(partialPath) === partialSha,
      `integrity=${restartDb.integrity}, downloads=${restartDb.downloads}, closeToTray=${restartDb.app_settings.closeToTray}`
    );

    killProcTree(app109Restart.proc.pid);
    trackedProcs.delete(app109Restart.proc);
    await sleep(1200);

    // --- INSTALLER / UNINSTALL SAFETY CHECK ---
    const uninstExe = path.join(QA_INSTALL_DIR, 'uninstall.exe');
    if (fs.existsSync(uninstExe)) {
      spawnSync(uninstExe, ['/S'], { timeout: 90000, stdio: 'ignore' });
      await sleep(2500);
    }
    const postUninstDb = queryIsolatedSqlite();
    const postUninstPartial = sha256File(partialPath) === partialSha;
    record(
      'P15-09',
      'NSIS uninstall removes isolated binaries while preserving SQLite database & user partial downloads intact',
      postUninstDb.integrity === 'ok' && postUninstPartial,
      `sqliteIntegrity=${postUninstDb.integrity}, partialIntact=${postUninstPartial}, exeRemoved=${!fs.existsSync(installedExe)}`
    );
  } finally {
    cleanupProcs();
    if (fixtureServer) fixtureServer.close();
    restoreOemState();
  }

  const outPath = path.join(ROOT, 'target', 'gate36_3_evidence', 'phase15_16_17_19_live_upgrade_qa.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    generated_at_utc: new Date().toISOString(),
    pass, fail,
    broken206Hits, broken200Hits,
    results,
  }, null, 2) + '\n', 'utf8');
  console.log(`\n=== GATE 36.3 LIVE UPGRADE, CONTENT-RANGE, STARTUP & TOOLS QA: PASS=${pass} FAIL=${fail} ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  cleanupProcs();
  if (fixtureServer) fixtureServer.close();
  restoreOemState();
  console.error('[FATAL]', err.message || err);
  process.exit(1);
});
