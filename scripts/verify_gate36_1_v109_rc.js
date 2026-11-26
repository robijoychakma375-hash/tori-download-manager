#!/usr/bin/env node
/**
 * TORI Gate 36.1 — Desktop v1.0.9 RC Isolated Upgrade, Content-Range Fallback,
 * Native Messaging, Hidden Startup & External Tools Verification Suite
 *
 * Strictly isolated under `target/gate36_1_upgrade_qa/` (separate TORI_DATA_DIR,
 * TORI_IPC_PIPE, TORI_LOCAL_PORT, WEBVIEW2_USER_DATA_FOLDER).
 * Never mutates OEM Desktop, OEM SQLite, OEM Downloads, or Host Registry.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const V108_DESKTOP_EXE = path.join(ROOT, 'release', 'v1.0.8-public', 'tori-download-manager.exe');
const V109_RC_DIR = path.join(ROOT, 'release', 'v1.0.9-rc');
const V109_DESKTOP_EXE = path.join(V109_RC_DIR, 'tori-download-manager.exe');
const V109_HOST_EXE = path.join(V109_RC_DIR, 'tdm-native-host.exe');
const V109_CLI_EXE = path.join(V109_RC_DIR, 'tdm-cli.exe');
const V109_INSTALLER = path.join(V109_RC_DIR, 'TORI.Download.Manager_1.0.9_x64-setup.exe');
const V109_SIG = path.join(V109_RC_DIR, 'TORI.Download.Manager_1.0.9_x64-setup.exe.sig');

const QA_ROOT = path.join(ROOT, 'target', 'gate36_1_upgrade_qa');
const QA_DATA_DIR = path.join(QA_ROOT, 'data');
const QA_DL_DIR = path.join(QA_ROOT, 'downloads');
const QA_WV2_DIR = path.join(QA_ROOT, 'webview2');

const DESKTOP_PORT = 27991;
const FIXTURE_PORT = 27995;
const PIPE_NAME = '\\\\.\\pipe\\tori-gate36-1-upgrade-ipc';
const API_TOKEN = 'tori_qa_g36_1_upgrade_secret_55443';

const DEDICATED_KEY_ID = 'C3FD6626A3718E63';
const LEGACY_KEY_ID = 'CDC23D8CC8DA5397';
const EXPECTED_PROD_MANIFEST_SHA = 'caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a';

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
function sha256File(p) { return sha256Buf(fs.readFileSync(p)); }

function killProcTree(pid) {
  if (!pid) return;
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch {}
}

function cleanupProcs() {
  for (const p of trackedProcs) killProcTree(p.pid);
  trackedProcs.clear();
}

function httpReq({ port, reqPath, method = 'GET', headers = {}, body = null, timeoutMs = 6000 }) {
  return new Promise((resolve) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers: reqHeaders, timeout: timeoutMs }, (res) => {
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

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'TORI-Gate36-1/1.0.9', 'Cache-Control': 'no-cache' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

function seedIsolatedV108Sqlite() {
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
  "showDownloadPopup": "never", "alwaysOnTop": False, "closeToTray": True
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
  const out = execFileSync('python', ['-c', py, dbPath], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

async function startDesktop(exePath) {
  const env = {
    ...process.env,
    TORI_DATA_DIR: QA_DATA_DIR,
    TORI_IPC_PIPE: PIPE_NAME,
    TORI_LOCAL_PORT: String(DESKTOP_PORT),
    TORI_ALLOW_LOOPBACK: '1',
    WEBVIEW2_USER_DATA_FOLDER: QA_WV2_DIR,
  };
  const proc = spawn(exePath, ['--minimized'], { env, stdio: 'ignore' });
  trackedProcs.add(proc);

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const r = await httpReq({
      port: DESKTOP_PORT,
      reqPath: '/api/v1/status',
      headers: { 'X-Tori-Token': API_TOKEN },
      timeoutMs: 1500,
    });
    if (r.ok && r.data?.authenticated) {
      return { proc, status: r.data };
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for Desktop binary ${exePath}`);
}

function sendNativeHostMessage(hostExe, payloadObj) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      TORI_DATA_DIR: QA_DATA_DIR,
      TORI_IPC_PIPE: PIPE_NAME,
      TORI_LOCAL_PORT: String(DESKTOP_PORT),
      TORI_EXE_PATH: V109_DESKTOP_EXE,
    };
    const child = spawn(hostExe, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdoutBuf = Buffer.alloc(0);
    let stderrStr = '';
    const timer = setTimeout(() => {
      killProcTree(child.pid);
      reject(new Error('Native host call timed out'));
    }, 10000);

    child.stdout.on('data', (chunk) => {
      stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
      if (stdoutBuf.length >= 4) {
        const msgLen = stdoutBuf.readUInt32LE(0);
        if (stdoutBuf.length >= 4 + msgLen) {
          clearTimeout(timer);
          const jsonStr = stdoutBuf.subarray(4, 4 + msgLen).toString('utf8');
          killProcTree(child.pid);
          try { resolve(JSON.parse(jsonStr)); }
          catch (e) { reject(new Error(`Invalid NM JSON: ${jsonStr}`)); }
        }
      }
    });
    child.stderr.on('data', (d) => (stderrStr += d.toString()));
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      if (stdoutBuf.length < 4) {
        clearTimeout(timer);
        reject(new Error(`Native host exited (${code}) without response: ${stderrStr}`));
      }
    });

    const body = Buffer.from(JSON.stringify(payloadObj), 'utf8');
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(body.length, 0);
    child.stdin.write(Buffer.concat([hdr, body]));
    child.stdin.end();
  });
}

async function waitForDownloadCompleted(expectedFile, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await httpReq({
      port: DESKTOP_PORT,
      reqPath: '/api/v1/downloads',
      headers: { 'X-Tori-Token': API_TOKEN },
    });
    const jobs = Array.isArray(r.data?.jobs) ? r.data.jobs : [];
    const job = jobs.find((j) => (j.filename || '').includes(expectedFile));
    if (job && job.state === 'completed') return job;
    if (job && job.state === 'failed') {
      throw new Error(`Download ${expectedFile} FAILED: ${job.error || JSON.stringify(job)}`);
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for download ${expectedFile} to complete`);
}

async function main() {
  console.log('=== TORI Gate 36.1 — Desktop v1.0.9 RC Upgrade, Content-Range, Native Messaging & Tools QA ===');

  if (fs.existsSync(QA_ROOT)) fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(QA_DL_DIR, { recursive: true });

  // Build deterministic fixture payloads
  const normalPayload = Buffer.alloc(256 * 1024);
  for (let i = 0; i < normalPayload.length; i++) normalPayload[i] = (i * 19 + 7) & 0xff;
  const normalSha = sha256Buf(normalPayload);

  const brokenRangePayload = Buffer.alloc(1024 * 1024); // 1 MiB
  for (let i = 0; i < brokenRangePayload.length; i++) brokenRangePayload[i] = (i * 41 + 13) & 0xff;
  const brokenRangeSha = sha256Buf(brokenRangePayload);

  const partialBytes = Buffer.alloc(128 * 1024);
  for (let i = 0; i < partialBytes.length; i++) partialBytes[i] = (i * 7 + 99) & 0xff;
  const partialSha = sha256Buf(partialBytes);
  const partialPath = path.join(QA_DL_DIR, 'preserved_partial.bin.tdm-part');

  try {
    // 1. Frozen RC binary & key-embedding check
    const exeBuf = fs.readFileSync(V109_DESKTOP_EXE);
    const hasDedKey = exeBuf.includes(Buffer.from(DEDICATED_KEY_ID, 'ascii'));
    const hasLegKey = exeBuf.includes(Buffer.from(LEGACY_KEY_ID, 'ascii'));
    const hasSecretMarker = exeBuf.includes(Buffer.from('minisign encrypted secret key', 'ascii'));
    record(
      'G361-01',
      'v1.0.9 RC binary embeds Stage 1 dual-key IDs (C3FD6626A3718E63 + CDC23D8CC8DA5397) with zero private key material',
      hasDedKey && hasLegKey && !hasSecretMarker && fs.existsSync(V109_INSTALLER) && fs.existsSync(V109_SIG),
      `ded=${hasDedKey}, leg=${hasLegKey}, noSecret=${!hasSecretMarker}`
    );

    const peVerInfo = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$d=(Get-Item '${V109_DESKTOP_EXE}').VersionInfo.ProductVersion; $i=(Get-Item '${V109_INSTALLER}').VersionInfo.ProductVersion; Write-Output "$d|$i"`,
      ],
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    const [deskPeVer, instPeVer] = peVerInfo.split('|');
    const hasCliBin = fs.existsSync(V109_CLI_EXE) && fs.readFileSync(V109_CLI_EXE).subarray(0, 2).toString('ascii') === 'MZ';
    record(
      'G361-02',
      'v1.0.9 RC Windows PE version metadata reports 1.0.9 on Desktop binary & NSIS installer and tdm-cli.exe is valid PE',
      String(deskPeVer || '').startsWith('1.0.9') && String(instPeVer || '').startsWith('1.0.9') && hasCliBin,
      `desktopPE="${deskPeVer}", installerPE="${instPeVer}", cliPE=${hasCliBin}`
    );

    // 2. Start local fixture HTTP server (normal + broken-CDN Content-Range defect)
    let brokenRange206Hits = 0;
    let brokenRange200Hits = 0;
    fixtureServer = http.createServer((req, res) => {
      if (req.url === '/v108_baseline.bin') {
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': normalPayload.length, 'Accept-Ranges': 'bytes', ETag: '"v108-etag-1"' });
          return res.end();
        }
        const r = req.headers.range;
        if (r && r.startsWith('bytes=')) {
          const [s, e] = r.slice(6).split('-').map((x) => parseInt(x, 10));
          const end = Number.isNaN(e) ? normalPayload.length - 1 : Math.min(e, normalPayload.length - 1);
          const slice = normalPayload.subarray(s, end + 1);
          res.writeHead(206, {
            'Content-Length': slice.length,
            'Content-Range': `bytes ${s}-${end}/${normalPayload.length}`,
            'Accept-Ranges': 'bytes',
            ETag: '"v108-etag-1"',
          });
          return res.end(slice);
        }
        res.writeHead(200, { 'Content-Length': normalPayload.length, 'Accept-Ranges': 'bytes', ETag: '"v108-etag-1"' });
        return res.end(normalPayload);
      }

      if (req.url === '/broken_ledger_cdn.bin') {
        // Exact reproduction of broken CDN: advertises Accept-Ranges: bytes on HEAD,
        // ignores offset on Range GET and responds 206 bytes 0-(N-1)/N, while serving clean 200 on non-Range GET!
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': brokenRangePayload.length, 'Accept-Ranges': 'bytes', ETag: '"broken-cdn-etag"' });
          return res.end();
        }
        if (req.headers.range) {
          brokenRange206Hits++;
          res.writeHead(206, {
            'Content-Length': brokenRangePayload.length,
            'Content-Range': `bytes 0-${brokenRangePayload.length - 1}/${brokenRangePayload.length}`,
            'Accept-Ranges': 'bytes',
            ETag: '"broken-cdn-etag"',
          });
          return res.end(brokenRangePayload);
        }
        brokenRange200Hits++;
        res.writeHead(200, { 'Content-Length': brokenRangePayload.length, ETag: '"broken-cdn-etag"' });
        return res.end(brokenRangePayload);
      }

      res.writeHead(404);
      res.end('not found');
    });
    await new Promise((r) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', r));

    // 3. Isolated v1.0.8 baseline boot & data creation
    seedIsolatedV108Sqlite();
    fs.writeFileSync(partialPath, partialBytes);
    const v108 = await startDesktop(V108_DESKTOP_EXE);
    record('G361-03', 'Frozen public Desktop v1.0.8 boots cleanly in isolated upgrade sandbox', v108.status.authenticated === true, `port=${DESKTOP_PORT}`);

    const addV108 = await httpReq({
      port: DESKTOP_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: `http://127.0.0.1:${FIXTURE_PORT}/v108_baseline.bin`, filename: 'v108_baseline.bin' },
    });
    if (!addV108.ok) throw new Error(`Failed queueing v1.0.8 baseline download: ${addV108.raw}`);
    const v108Job = await waitForDownloadCompleted('v108_baseline.bin');
    const v108FileSha = sha256File(path.join(QA_DL_DIR, 'v108_baseline.bin'));
    record('G361-04', 'Desktop v1.0.8 creates baseline completed download with exact SHA-256', v108Job.state === 'completed' && v108FileSha === normalSha, `shaMatch=${v108FileSha === normalSha}`);

    // Cleanly stop v1.0.8 and snapshot SQLite before upgrading to v1.0.9
    killProcTree(v108.proc.pid);
    trackedProcs.delete(v108.proc);
    await sleep(1500);
    const preUpgradeDb = queryIsolatedSqlite();
    record(
      'G361-05',
      'Pre-upgrade v1.0.8 SQLite baseline snapshotted cleanly',
      preUpgradeDb.integrity === 'ok' && preUpgradeDb.downloads >= 1 && preUpgradeDb.app_settings.closeToTray === true,
      `downloads=${preUpgradeDb.downloads}, chunks=${preUpgradeDb.chunks}, closeToTray=${preUpgradeDb.app_settings.closeToTray}`
    );

    // 4. Upgrade in-place to compiled v1.0.9 RC against the exact same v1.0.8 data dir
    const v109 = await startDesktop(V109_DESKTOP_EXE);
    record(
      'G361-06',
      'Desktop v1.0.9 RC boots cleanly in --minimized mode over existing v1.0.8 data dir',
      v109.status.authenticated === true,
      `port=${DESKTOP_PORT}, apiVer=${v109.status.version}`
    );

    const postUpgradeDb = queryIsolatedSqlite();
    const postPartialSha = sha256File(partialPath);
    const settingsOk =
      postUpgradeDb.integrity === 'ok' &&
      postUpgradeDb.downloads === preUpgradeDb.downloads &&
      postUpgradeDb.app_settings.closeToTray === true &&
      postUpgradeDb.app_settings.theme === 'dark' &&
      postUpgradeDb.app_settings.accent === 'emerald' &&
      postPartialSha === partialSha;
    record(
      'G361-07',
      'v1.0.8 -> v1.0.9 upgrade preserves SQLite integrity, downloads, Close-to-Tray, theme/accent & pre-existing .tdm-part file',
      settingsOk,
      `integrity=${postUpgradeDb.integrity}, dl=${postUpgradeDb.downloads}, closeToTray=${postUpgradeDb.app_settings.closeToTray}, partialIntact=${postPartialSha === partialSha}`
    );

    // 5. Live broken-CDN Content-Range fallback test against running v1.0.9 RC Desktop!
    const addBroken = await httpReq({
      port: DESKTOP_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': API_TOKEN },
      body: { url: `http://127.0.0.1:${FIXTURE_PORT}/broken_ledger_cdn.bin`, filename: 'broken_ledger_cdn.bin' },
    });
    if (!addBroken.ok) throw new Error(`Failed queueing broken-range download: ${addBroken.raw}`);
    const brokenJob = await waitForDownloadCompleted('broken_ledger_cdn.bin', 30000);
    const brokenOutSha = sha256File(path.join(QA_DL_DIR, 'broken_ledger_cdn.bin'));
    const partialStillIntact = sha256File(partialPath) === partialSha;
    record(
      'G361-08',
      'Live v1.0.9 RC recovers from broken-CDN Content-Range (206 bytes 0-(N-1)/N) via safe single-stream fallback with exact SHA-256 & untouched unrelated .tdm-part',
      brokenJob.state === 'completed' && brokenOutSha === brokenRangeSha && partialStillIntact,
      `state=${brokenJob.state}, shaMatch=${brokenOutSha === brokenRangeSha}, range206Hits=${brokenRange206Hits}, full200Hits=${brokenRange200Hits}, unrelatedPartIntact=${partialStillIntact}`
    );

    // 6. Live v1.0.9 Native Messaging Host pairing + concurrent mutex stability
    const nmSingle = await sendNativeHostMessage(V109_HOST_EXE, { action: 'pair' });
    record(
      'G361-09',
      'v1.0.9 tdm-native-host.exe stdio pairing succeeds against live v1.0.9 Desktop RC',
      nmSingle.status === 'ok' && nmSingle.token === API_TOKEN && nmSingle.port === DESKTOP_PORT,
      `status=${nmSingle.status}, tokenMatched=${nmSingle.token === API_TOKEN}, port=${nmSingle.port}`
    );

    const nmConcurrent = await Promise.all([
      sendNativeHostMessage(V109_HOST_EXE, { action: 'pair' }),
      sendNativeHostMessage(V109_HOST_EXE, { action: 'pair' }),
      sendNativeHostMessage(V109_HOST_EXE, { action: 'pair' }),
      sendNativeHostMessage(V109_HOST_EXE, { action: 'pair' }),
    ]);
    const allConcOk = nmConcurrent.every((r) => r.status === 'ok' && r.token === API_TOKEN && r.port === DESKTOP_PORT);
    record(
      'G361-10',
      '4x concurrent v1.0.9 tdm-native-host.exe invocations succeed cleanly without spawn stampede',
      allConcOk,
      `okCount=${nmConcurrent.filter((r) => r.status === 'ok').length}/4`
    );

    // 7. Live Production External Tools Manifest rev 2 reachability & SHA-256 continuity
    const prodMan = await httpsGet('https://toridownload.xyz/assets/tools/tools-manifest.json');
    const prodManSha = sha256Buf(prodMan.body);
    const prodManJson = JSON.parse(prodMan.body.toString('utf8'));
    const prodSig = await httpsGet('https://toridownload.xyz/assets/tools/tools-manifest.json.sig');
    record(
      'G361-11',
      'Production External Tools manifest remains rev 2 (CDC23D8CC8DA5397) with exact SHA-256 & detached signature',
      prodMan.status === 200 &&
        prodManSha === EXPECTED_PROD_MANIFEST_SHA &&
        prodManJson.manifest_revision === 2 &&
        prodManJson.signing_key_id === LEGACY_KEY_ID &&
        prodSig.status === 200 &&
        prodSig.body.length > 64,
      `rev=${prodManJson.manifest_revision}, key=${prodManJson.signing_key_id}, sha=${prodManSha}`
    );

    // Stop v1.0.9 cleanly & verify final isolated SQLite integrity
    killProcTree(v109.proc.pid);
    trackedProcs.delete(v109.proc);
    await sleep(1000);
    const finalDb = queryIsolatedSqlite();
    record(
      'G361-12',
      'Post-QA isolated v1.0.9 SQLite remains healthy (integrity=ok) with both v1.0.8 & v1.0.9 downloads retained',
      finalDb.integrity === 'ok' && finalDb.downloads >= 2,
      `integrity=${finalDb.integrity}, downloads=${finalDb.downloads}, chunks=${finalDb.chunks}`
    );
  } finally {
    cleanupProcs();
    if (fixtureServer) fixtureServer.close();
  }

  const outPath = path.join(ROOT, 'target', 'gate36_1_qa_logs', 'v109_upgrade_and_engine_qa.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), pass, fail, results }, null, 2) + '\n', 'utf8');
  console.log(`\n=== GATE 36.1 UPGRADE & ENGINE QA SUMMARY: PASS=${pass} FAIL=${fail} ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  cleanupProcs();
  if (fixtureServer) fixtureServer.close();
  console.error('[FATAL]', err.message || err);
  process.exit(1);
});
