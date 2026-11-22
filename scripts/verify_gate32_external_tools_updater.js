#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 32 Live End-to-End & Real Tool Compatibility Verification
 *
 * Verifies in strict isolation under target/gate32_qa:
 *  1. Default Gate 32 policy (auto_update=true, 24h, auto_install=true, notify=true, defer_in_use=true)
 *  2. Initial bundled tool detection (yt-dlp 2026.08.19, FFmpeg/FFprobe N-126374-g089a48eb36-20260831)
 *  3. Real live GitHub update check & real OpenPGP RSA-4096 verified yt-dlp upgrade (2026.08.19 -> latest 2026.10.26+)
 *  4. Dual-condition FFmpeg trust verification: Ed25519-signed production manifest accepted while unsigned direct upstream BtbN/FFmpeg-Builds remains strictly blocked as Source Untrusted
 *  5. Real YouTube metadata extraction, format detection, playlist resolution, and media download with updated yt-dlp
 *  6. Real Settings UI (Light & Dark themes), Update History modal, and Manual Rollback back to bundled yt-dlp
 *  7. Real Ed25519-signed FFmpeg + FFprobe bundle update inside isolated desktop app + real mux/merge/probe tests + rollback
 *  8. Zero mutation of OEM production DB, OEM installed v1.0.6 binary, registry, or Browser Companion v1.0.10
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const {
  QaOemStateGuard,
  snapshotOemDatabase,
  compareOemDatabaseSnapshots,
} = require('./lib/qa_oem_state_guard');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP_EXE = path.join(ROOT, 'target', 'release', 'tori-download-manager.exe');
const RESOURCES_BIN = path.join(ROOT, 'resources', 'bin');
const QA_ROOT = path.join(ROOT, 'target', 'gate32_qa');
const QA_DATA_DIR = path.join(QA_ROOT, 'data');
const QA_DL_DIR = path.join(QA_ROOT, 'downloads');
const QA_WV2_DIR = path.join(QA_ROOT, 'webview2');
const SCREENSHOTS_DIR = path.join(ROOT, 'docs', 'reports', 'screenshots', 'gate32');

const OEM_APPDATA_DIR = path.join(process.env.APPDATA || '', 'tori-download-manager');
const OEM_DB_PATH = path.join(OEM_APPDATA_DIR, 'tdm_storage.sqlite');
const OEM_EXE_PATH = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'tori-download-manager.exe');

const CDP_PORT = 24971;
const CDP_PORT_2 = 24972;
const CDP_PORT_3 = 24973;

const results = [];
const counts = { PASS: 0, FAIL: 0 };
const trackedProcs = new Set();

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

function readQaManifestState(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const py = `
import json, os, sqlite3, sys
from urllib.request import pathname2url
uri = "file:" + pathname2url(os.path.abspath(sys.argv[1])) + "?mode=ro"
con = sqlite3.connect(uri, uri=True, timeout=5.0)
row = con.execute("SELECT value FROM engine_settings WHERE key = 'external_tools_manifest_state'").fetchone()
con.close()
print(row[0] if row and row[0] else "null")
`;
  try {
    const out = execFileSync('python', ['-c', py, dbPath], { encoding: 'utf8', timeout: 8000 }).trim();
    return out ? JSON.parse(out) : null;
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

function cleanupTrackedProcs() {
  for (const p of trackedProcs) killProcTree(p.pid);
  trackedProcs.clear();
}

function httpGetJson(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, data: JSON.parse(raw) });
        } catch {
          resolve({ ok: false, raw });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
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
  close() {
    try { if (this.ws) this.ws.close(); } catch {}
  }
}

async function waitForMainCdp(cdpPort, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await httpGetJson(`http://127.0.0.1:${cdpPort}/json/list`);
    if (list.ok && Array.isArray(list.data)) {
      const page = list.data.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url || '').includes('window=toast')
      );
      if (page) {
        const client = new CDPClient(page.webSocketDebuggerUrl);
        await client.connect();
        await client.send('Runtime.enable');
        await client.send('Page.enable');
        return client;
      }
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for WebView2 CDP on port ${cdpPort}`);
}

async function launchIsolatedDesktop({ dataDir, wv2Dir, cdpPort, pipeSuffix, extraEnv = {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(wv2Dir, { recursive: true });

  const env = {
    ...process.env,
    TORI_DATA_DIR: dataDir,
    TORI_IPC_PIPE: `\\\\.\\pipe\\tori_qa_${pipeSuffix}_${process.pid}`,
    WEBVIEW2_USER_DATA_FOLDER: wv2Dir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    ...extraEnv,
  };

  const proc = spawn(DESKTOP_EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  trackedProcs.add(proc);
  const cdp = await waitForMainCdp(cdpPort, 30000);
  // Wait for Tauri internals and main UI root to mount
  for (let i = 0; i < 40; i++) {
    const ready = await cdp.evalJson(`return Boolean(window.__TAURI_INTERNALS__ && document.querySelector('#tool'));`);
    if (ready) break;
    await sleep(250);
  }
  return { proc, cdp };
}

// Create uncompressed STORE ZIP archive in pure Node.js (fast, zero external deps)
function buildStoredZip(files) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    parts.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, cdBuf, eocd]);
}

function generateEphemeralMinisignEd25519() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  // Raw 32-byte Ed25519 public key is the tail of SPKI DER
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = spki.subarray(spki.length - 32);
  const keyId = Buffer.from([0x32, 0x32, 0xAB, 0xCD, 0xEF, 0x01, 0x02, 0x03]);

  const pkBuf = Buffer.concat([Buffer.from('Ed'), keyId, rawPub]);
  const pkBox = `untrusted comment: minisign public key: GATE32LIVE\n${pkBuf.toString('base64')}\n`;
  const pubkeyB64 = Buffer.from(pkBox, 'utf8').toString('base64');

  function sign(messageBuf) {
    const sig = crypto.sign(null, messageBuf, privateKey);
    const sigBox = Buffer.concat([Buffer.from('Ed'), keyId, sig]).toString('base64');
    const trustedComment = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:tools-manifest.json`;
    const globalSig = crypto.sign(null, Buffer.concat([sig, Buffer.from(trustedComment, 'utf8')]), privateKey).toString('base64');
    return `untrusted comment: signature from gate32 live test\n${sigBox}\ntrusted comment: ${trustedComment}\n${globalSig}\n`;
  }

  return { pubkeyB64, sign };
}

async function main() {
  if (!fs.existsSync(DESKTOP_EXE)) {
    throw new Error(`Release binary not found at ${DESKTOP_EXE}. Build it first.`);
  }

  const oemGuard = new QaOemStateGuard('gate32');
  oemGuard.backup({ stopRunningOem: true });
  oemGuard.temporarilySilenceNativeHostAutoSpawn();
  await sleep(600);

  const oemDbBefore = snapshotOemDatabase(OEM_DB_PATH);
  const oemExeShaBefore = sha256File(OEM_EXE_PATH);
  let oemDbAfter = null;

  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(QA_DATA_DIR, { recursive: true });
  fs.mkdirSync(QA_DL_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  let cdp = null;
  let untrustedManifestServer = null;
  let signedServer = null;

  try {
    // =========================================================================
    // PHASE A: Real Live Upstream yt-dlp Upgrade (2026.08.19 -> latest 2026.10.26+)
    //          + Honest Untrusted Blocking of Unsigned BtbN/FFmpeg-Builds
    //          + Real YouTube Metadata, Playlist & Media Download Compatibility
    //          + Real Settings UI Screenshots + Manual Rollback
    // =========================================================================
    console.log('\n=== PHASE A: Live Isolated Desktop App & Real Upstream yt-dlp Upgrade ===');
    const sessionA = await launchIsolatedDesktop({
      dataDir: QA_DATA_DIR,
      wv2Dir: QA_WV2_DIR,
      cdpPort: CDP_PORT,
      pipeSuffix: 'g32_live',
    });
    cdp = sessionA.cdp;

    // 1. Verify initial settings defaults & bundled baseline via Tauri IPC
    const initialSnap = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('get_external_tools_status');
    `);
    const s = initialSnap.settings;
    record(
      'G32-01',
      'Default external tools update policy matches mandatory Gate 32 spec',
      s.auto_update === true &&
        s.check_interval_hours === 24 &&
        s.auto_install === true &&
        s.notify_on_update === true &&
        s.defer_while_in_use === true,
      JSON.stringify(s)
    );

    const initYt = initialSnap.tools.find((t) => t.tool_id === 'yt-dlp');
    const initFf = initialSnap.tools.find((t) => t.tool_id === 'ffmpeg');
    const initFp = initialSnap.tools.find((t) => t.tool_id === 'ffprobe');
    record(
      'G32-02',
      'Initial bundled versions detected accurately without PATH pollution',
      Boolean(initYt?.installed_version && initFf?.installed_version && initFp?.installed_version) &&
        initYt.source === 'bundled' &&
        initFf.source === 'bundled' &&
        initFp.source === 'bundled',
      `yt-dlp=${initYt?.installed_version} (${initYt?.source}), ffmpeg=${initFf?.installed_version}, ffprobe=${initFp?.installed_version}`
    );

    // 2. Open Settings -> External Tools tab in real Desktop UI & capture Light theme screenshot
    await cdp.evalJson(`
      document.documentElement.setAttribute('data-theme', 'light');
      const btn = Array.from(document.querySelectorAll('#tool button')).find(b => b.textContent.includes('Settings'));
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 350));
      const tab = document.querySelector('[data-tab="tools"]');
      if (tab) tab.click();
      await new Promise(r => setTimeout(r, 450));
      return Boolean(document.querySelector('[data-testid="external-tools-panel"]'));
    `);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, 'gate32_01_external_tools_initial_light.png'));

    const uiControlsCheck = await cdp.evalJson(`
      return {
        hasHeading: document.querySelector('#ext-tools-heading')?.textContent?.trim() === 'External Tools Update Manager',
        hasTable: Boolean(document.querySelector('[data-testid="external-tools-table"]')),
        rowCount: document.querySelectorAll('[data-tool-row]').length,
        hasCheckBtn: Boolean(document.querySelector('[data-testid="btn-check-tools-updates"]')),
        hasUpdateBtn: Boolean(document.querySelector('[data-testid="btn-update-tools-now"]')),
        hasHistoryBtn: Boolean(document.querySelector('[data-testid="btn-view-tools-history"]')),
        hasLocationBtn: Boolean(document.querySelector('[data-testid="btn-open-tool-location"]')),
        intervalVal: document.querySelector('[data-testid="select-tools-interval"]')?.value,
      };
    `);
    record(
      'G32-03',
      'Settings -> External Tools UI renders accessible table, 3 tool rows, and all controls',
      uiControlsCheck.hasHeading &&
        uiControlsCheck.hasTable &&
        uiControlsCheck.rowCount === 3 &&
        uiControlsCheck.hasCheckBtn &&
        uiControlsCheck.hasUpdateBtn &&
        uiControlsCheck.hasHistoryBtn &&
        uiControlsCheck.hasLocationBtn &&
        uiControlsCheck.intervalVal === '24',
      JSON.stringify(uiControlsCheck)
    );

    // Temporarily pause background auto-install just so we can inspect & screenshot the
    // intermediate "Update Available" + "Source Untrusted" state cleanly before clicking Update Now.
    await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: {
          auto_update: true,
          check_interval_hours: 24,
          auto_install: false,
          notify_on_update: true,
          defer_while_in_use: true
        }
      });
    `);

    // 3. Trigger REAL live upstream check (GitHub yt-dlp/yt-dlp OpenPGP + BtbN/FFmpeg-Builds)
    const afterCheck = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');
    `);
    await sleep(500);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, 'gate32_02_live_check_ytdlp_verified_ffmpeg_untrusted.png'));

    // Restore default auto_install=true policy
    await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: {
          auto_update: true,
          check_interval_hours: 24,
          auto_install: true,
          notify_on_update: true,
          defer_while_in_use: true
        }
      });
    `);

    const chkYt = afterCheck.tools.find((t) => t.tool_id === 'yt-dlp');
    const chkFf = afterCheck.tools.find((t) => t.tool_id === 'ffmpeg');
    const chkFp = afterCheck.tools.find((t) => t.tool_id === 'ffprobe');
    record(
      'G32-04',
      'Live GitHub yt-dlp OpenPGP RSA-4096 verification succeeded and detected newer release',
      chkYt &&
        chkYt.available_version &&
        chkYt.available_version !== initYt.installed_version &&
        (chkYt.update_status === 'update_available' || chkYt.update_status === 'updated'),
      `installed=${chkYt?.installed_version}, available=${chkYt?.available_version}, status=${chkYt?.update_status}`
    );

    // G32-05 Condition A: Production Ed25519-signed tools manifest on toridownload.xyz is verified & accepted
    const prodManifestState = readQaManifestState(path.join(QA_DATA_DIR, 'tdm_storage.sqlite'));
    const signedProdManifestAccepted =
      chkFf?.update_status === 'update_available' &&
      chkFp?.update_status === 'update_available' &&
      Boolean(chkFf?.available_version) &&
      chkFf.available_version === chkFp.available_version &&
      chkFf.available_version !== initFf.installed_version &&
      Boolean(prodManifestState) &&
      prodManifestState.highest_accepted_revision >= 1 &&
      prodManifestState.last_signing_key_id === 'CDC23D8CC8DA5397' &&
      typeof prodManifestState.last_accepted_manifest_sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(prodManifestState.last_accepted_manifest_sha256);

    // 4. Perform REAL live yt-dlp update (download -> SHA-256 -> OpenPGP -> PE x64 -> health -> atomic activate!)
    const afterUpdate = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'yt-dlp' });
    `);
    await sleep(500);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, 'gate32_03_ytdlp_updated_live.png'));

    const updYt = afterUpdate.tools.find((t) => t.tool_id === 'yt-dlp');
    const activeManifestPath = path.join(QA_DATA_DIR, 'tools', 'manifests', 'active-tools.json');
    const activeManifest = fs.existsSync(activeManifestPath)
      ? JSON.parse(fs.readFileSync(activeManifestPath, 'utf8'))
      : null;

    record(
      'G32-06',
      'Real live yt-dlp upgraded atomically to verified managed version with rollback retained',
      updYt &&
        updYt.source === 'managed' &&
        updYt.update_status === 'updated' &&
        updYt.installed_version === chkYt.available_version &&
        updYt.rollback_available === true &&
        Boolean(activeManifest?.yt_dlp_active?.binary_path && fs.existsSync(activeManifest.yt_dlp_active.binary_path)),
      `newVersion=${updYt?.installed_version}, path=${updYt?.active_binary_path}, rollback=${updYt?.rollback_version}`
    );

    // Verify security allowlist rejects arbitrary path / URL injection via Tauri command
    const injectionRejected = await cdp.evalJson(`
      try {
        await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'https://evil.example/yt-dlp.exe' });
        return false;
      } catch (e) {
        return String(e).includes('Unsupported external tool identifier');
      }
    `);
    record(
      'G32-07',
      'Tauri IPC command strictly rejects arbitrary URL/path injection',
      injectionRejected === true
    );

    // 5. Real YouTube compatibility tests using the newly activated managed yt-dlp!
    const ytMediaMeta = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('resolve_media', {
        url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
      });
    `);
    record(
      'G32-08',
      'Real YouTube metadata extraction & format detection succeed with newly activated yt-dlp',
      Boolean(ytMediaMeta && ytMediaMeta.title && Array.isArray(ytMediaMeta.formats) && ytMediaMeta.formats.length > 0),
      `title="${ytMediaMeta?.title}", formats=${ytMediaMeta?.formats?.length}`
    );

    const ytPlaylist = await cdp.evalJson(`
      try {
        return await window.__TAURI_INTERNALS__.invoke('resolve_playlist', {
          url: 'https://www.youtube.com/playlist?list=PL6B3937A5D230E335',
          limit: 3
        });
      } catch (e) {
        return { __error: String(e) };
      }
    `);
    record(
      'G32-09',
      'Real YouTube playlist resolution succeeds with newly activated yt-dlp',
      Boolean(ytPlaylist && !ytPlaylist.__error && Array.isArray(ytPlaylist.items) && ytPlaylist.items.length > 0),
      ytPlaylist?.__error ? ytPlaylist.__error : `playlist="${ytPlaylist?.title}", items=${ytPlaylist?.items?.length}`
    );

    // Real YouTube download end-to-end using newly activated yt-dlp + FFmpeg stream merge!
    const dlJob = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('create_media_download', {
        args: {
          url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
          format_id: '230+234/bestvideo+bestaudio/best',
          filename: 'gate32_ytdlp_live_test.mp4',
          destination: ${JSON.stringify(QA_DL_DIR)},
          start_immediately: true
        }
      });
    `);
    let finalJob = dlJob;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      finalJob = await cdp.evalJson(`
        return await window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(dlJob.id)} });
      `);
      if (finalJob && (finalJob.state === 'completed' || finalJob.state === 'failed')) break;
    }
    const dlExists = finalJob?.target_path && fs.existsSync(finalJob.target_path);
    const dlSize = dlExists ? fs.statSync(finalJob.target_path).size : 0;
    record(
      'G32-10',
      'Real YouTube video download completes end-to-end using newly activated yt-dlp',
      finalJob?.state === 'completed' && dlSize > 10000,
      `state=${finalJob?.state}, size=${dlSize} bytes, file=${finalJob?.target_path}`
    );

    // Verify downloaded file via active ffprobe!
    let probeOut = '';
    if (dlExists) {
      probeOut = execFileSync(
        initFp.active_binary_path,
        ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'default=noprint_wrappers=1', finalJob.target_path],
        { encoding: 'utf8', timeout: 15000 }
      );
    }
    record(
      'G32-11',
      'Downloaded YouTube media file passes real FFprobe container & stream verification',
      probeOut.includes('codec_type=video') && probeOut.includes('duration='),
      probeOut.replace(/\r?\n/g, ' | ').trim()
    );

    // 6. Open Update History modal & capture screenshot
    await cdp.evalJson(`
      const btn = document.querySelector('[data-testid="btn-view-tools-history"]');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 450));
      return Boolean(document.querySelector('[data-testid="external-tools-history-modal"]'));
    `);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, 'gate32_04_update_history_modal.png'));
    const historyEntries = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('get_external_tool_update_history', { limit: 50 });
    `);
    record(
      'G32-12',
      'Update history recorded accurately in SQLite and rendered in History modal',
      Array.isArray(historyEntries) &&
        historyEntries.some((h) => h.tool_id === 'yt-dlp' && h.action === 'update' && h.status === 'updated'),
      `entries=${historyEntries?.length}`
    );
    // Close history modal, switch to dark theme for Dark screenshot
    await cdp.evalJson(`
      const closeBtn = document.querySelector('[data-testid="external-tools-history-modal"] button');
      if (closeBtn) closeBtn.click();
      document.documentElement.setAttribute('data-theme', 'dark');
      await new Promise(r => setTimeout(r, 300));
    `);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, 'gate32_05_external_tools_dark_theme.png'));
    await cdp.evalJson(`document.documentElement.setAttribute('data-theme', 'light');`);

    // 7. Manual rollback of yt-dlp back to bundled 2026.08.19 & post-rollback functional verification
    const afterRb = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('rollback_external_tool', { toolId: 'yt-dlp' });
    `);
    await sleep(400);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, 'gate32_06_ytdlp_rolled_back.png'));
    const rbYt = afterRb.tools.find((t) => t.tool_id === 'yt-dlp');
    record(
      'G32-13',
      'Manual rollback cleanly restores bundled yt-dlp 2026.08.19',
      rbYt?.installed_version === initYt.installed_version &&
        rbYt?.source === 'bundled' &&
        rbYt?.update_status === 'rolled_back',
      `restored=${rbYt?.installed_version} (${rbYt?.source}), status=${rbYt?.update_status}`
    );

    cdp.close();
    cdp = null;
    cleanupTrackedProcs();
    await sleep(600);

    // =========================================================================
    // PHASE A2: G32-05 Condition B — Direct Unsigned Upstream BtbN/FFmpeg-Builds
    //           Must Remain Strictly Blocked as Source Untrusted (No Signed Manifest)
    // =========================================================================
    console.log('\n=== PHASE A2: Direct Unsigned Upstream BtbN/FFmpeg-Builds Fail-Closed Verification ===');
    const qaDataUntrusted = path.join(QA_ROOT, 'data_untrusted_upstream');
    const qaWv2Untrusted = path.join(QA_ROOT, 'webview2_untrusted_upstream');
    untrustedManifestServer = http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not published');
    });
    await new Promise((r) => untrustedManifestServer.listen(0, '127.0.0.1', r));
    const untrustedPort = untrustedManifestServer.address().port;

    const sessionA2 = await launchIsolatedDesktop({
      dataDir: qaDataUntrusted,
      wv2Dir: qaWv2Untrusted,
      cdpPort: CDP_PORT_3,
      pipeSuffix: 'g32_ff_untrusted',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: `http://127.0.0.1:${untrustedPort}/tools-manifest.json`,
      },
    });
    cdp = sessionA2.cdp;

    // Disable background auto-install so we isolate the direct upstream FFmpeg untrusted policy cleanly
    await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: {
          auto_update: true,
          check_interval_hours: 24,
          auto_install: false,
          notify_on_update: true,
          defer_while_in_use: true
        }
      });
    `);

    const untrustedCheck = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');
    `);
    const uFf = untrustedCheck.tools.find((t) => t.tool_id === 'ffmpeg');
    const uFp = untrustedCheck.tools.find((t) => t.tool_id === 'ffprobe');
    const unsignedUpstreamBlocked =
      uFf?.update_status === 'source_untrusted' && uFp?.update_status === 'source_untrusted';

    // Also prove that attempting to install unsigned direct upstream FFmpeg is strictly refused
    const untrustedInstallAttempt = await cdp.evalJson(`
      try {
        const snap = await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'ffmpeg' });
        return { threw: false, snap };
      } catch (e) {
        return { threw: true, error: String(e) };
      }
    `);
    const postAttemptSnap = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('get_external_tools_status');
    `);
    const uFfAfter = postAttemptSnap.tools.find((t) => t.tool_id === 'ffmpeg');
    const uFpAfter = postAttemptSnap.tools.find((t) => t.tool_id === 'ffprobe');
    const untrustedActiveManifestPath = path.join(qaDataUntrusted, 'tools', 'manifests', 'active-tools.json');
    const untrustedActiveManifest = fs.existsSync(untrustedActiveManifestPath)
      ? JSON.parse(fs.readFileSync(untrustedActiveManifestPath, 'utf8'))
      : null;
    const unsignedInstallRefused =
      uFfAfter?.source === 'bundled' &&
      uFpAfter?.source === 'bundled' &&
      uFfAfter?.update_status === 'source_untrusted' &&
      uFpAfter?.update_status === 'source_untrusted' &&
      !untrustedActiveManifest?.ffmpeg_bundle_active;

    record(
      'G32-05',
      'Signed production manifest accepted for FFmpeg/FFprobe while unsigned direct upstream BtbN remains blocked as Source Untrusted',
      signedProdManifestAccepted && unsignedUpstreamBlocked && unsignedInstallRefused,
      `prodSigned=${signedProdManifestAccepted} (ffmpeg=${chkFf?.update_status}/${chkFf?.available_version}, key=${prodManifestState?.last_signing_key_id}, rev=${prodManifestState?.highest_accepted_revision}, sha=${prodManifestState?.last_accepted_manifest_sha256?.slice(0, 12)}); unsignedDirect=${unsignedUpstreamBlocked} (ffmpeg=${uFf?.update_status}/${uFf?.available_version}, ffprobe=${uFp?.update_status}, installRefused=${unsignedInstallRefused}, threw=${untrustedInstallAttempt.threw})`
    );

    cdp.close();
    cdp = null;
    untrustedManifestServer.close();
    untrustedManifestServer = null;
    cleanupTrackedProcs();
    await sleep(600);

    // =========================================================================
    // PHASE B: Real Ed25519-Signed FFmpeg + FFprobe Bundle Update inside
    //          Isolated Desktop Binary + Real Mux/Merge/Transcode/FFprobe Tests
    // =========================================================================
    console.log('\n=== PHASE B: Real Ed25519-Signed FFmpeg + FFprobe Bundle Upgrade & Media Pipeline ===');
    const qaDataB = path.join(QA_ROOT, 'data_ffmpeg_signed');
    const qaWv2B = path.join(QA_ROOT, 'webview2_ffmpeg_signed');
    const edKey = generateEphemeralMinisignEd25519();

    const ffBytes = fs.readFileSync(path.join(RESOURCES_BIN, 'ffmpeg.exe'));
    const fpBytes = fs.readFileSync(path.join(RESOURCES_BIN, 'ffprobe.exe'));
    const zipBuf = buildStoredZip([
      { name: 'ffmpeg-N-126375-win64-gpl/bin/ffmpeg.exe', data: ffBytes },
      { name: 'ffmpeg-N-126375-win64-gpl/bin/ffprobe.exe', data: fpBytes },
      { name: 'ffmpeg-N-126375-win64-gpl/README.txt', data: Buffer.from('TORI Gate 32 test bundle') },
    ]);
    const zipSha = crypto.createHash('sha256').update(zipBuf).digest('hex');

    let signedPort = 0;
    let manifestBuf = null;
    let manifestSig = null;

    signedServer = http.createServer((req, res) => {
      if (req.url === '/tools-manifest.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': manifestBuf.length });
        res.end(manifestBuf);
      } else if (req.url === '/tools-manifest.json.sig') {
        const b = Buffer.from(manifestSig, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': b.length });
        res.end(b);
      } else if (req.url === '/ffmpeg-bundle.zip') {
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zipBuf.length });
        res.end(zipBuf);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => signedServer.listen(0, '127.0.0.1', r));
    signedPort = signedServer.address().port;

    const manifestObj = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      ffmpeg_bundle: {
        version: 'N-126375-g089a48eb36-20260901',
        url: `http://127.0.0.1:${signedPort}/ffmpeg-bundle.zip`,
        sha256: zipSha,
        size: zipBuf.length,
        platform: 'windows',
        architecture: 'x86_64',
        published_at: '2026-09-01T00:00:00Z',
      },
    };
    manifestBuf = Buffer.from(JSON.stringify(manifestObj, null, 2), 'utf8');
    manifestSig = edKey.sign(manifestBuf);

    const sessionB = await launchIsolatedDesktop({
      dataDir: qaDataB,
      wv2Dir: qaWv2B,
      cdpPort: CDP_PORT_2,
      pipeSuffix: 'g32_ff_signed',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: `http://127.0.0.1:${signedPort}/tools-manifest.json`,
        TORI_TEST_TOOLS_PUBKEY: edKey.pubkeyB64,
      },
    });
    cdp = sessionB.cdp;

    await cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');`);
    const ffUpdated = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('update_external_tool', { toolId: 'ffmpeg' });
    `);
    const managedFf = ffUpdated.tools.find((t) => t.tool_id === 'ffmpeg');
    const managedFp = ffUpdated.tools.find((t) => t.tool_id === 'ffprobe');
    record(
      'G32-14',
      'Ed25519-signed FFmpeg + FFprobe bundle verified, extracted, self-tested, and activated atomically',
      managedFf?.source === 'managed' &&
        managedFp?.source === 'managed' &&
        managedFf?.update_status === 'updated' &&
        managedFp?.update_status === 'updated' &&
        managedFf?.rollback_available === true &&
        fs.existsSync(managedFf.active_binary_path) &&
        fs.existsSync(managedFp.active_binary_path),
      `ffmpeg=${managedFf?.active_binary_path}, ffprobe=${managedFp?.active_binary_path}`
    );

    // Run real FFmpeg A/V merge + container remux + FFprobe stream/duration checks on the newly activated managed binaries!
    const mediaScratch = path.join(QA_ROOT, 'media_compat');
    fs.mkdirSync(mediaScratch, { recursive: true });
    const vidOnly = path.join(mediaScratch, 'video.mp4');
    const audOnly = path.join(mediaScratch, 'audio.m4a');
    const mergedMp4 = path.join(mediaScratch, 'merged.mp4');
    const remuxedMkv = path.join(mediaScratch, 'remuxed.mkv');

    execFileSync(managedFf.active_binary_path, [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=24',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vidOnly,
    ], { timeout: 25000 });
    execFileSync(managedFf.active_binary_path, [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:a', 'aac', audOnly,
    ], { timeout: 25000 });
    execFileSync(managedFf.active_binary_path, [
      '-y', '-v', 'error', '-i', vidOnly, '-i', audOnly,
      '-c', 'copy', '-movflags', '+faststart', mergedMp4,
    ], { timeout: 25000 });
    execFileSync(managedFf.active_binary_path, [
      '-y', '-v', 'error', '-i', mergedMp4, '-c', 'copy', remuxedMkv,
    ], { timeout: 25000 });

    const probeMerged = execFileSync(managedFp.active_binary_path, [
      '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name',
      '-of', 'default=noprint_wrappers=1', mergedMp4,
    ], { encoding: 'utf8', timeout: 15000 });
    const probeMkv = execFileSync(managedFp.active_binary_path, [
      '-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
      '-of', 'default=noprint_wrappers=1', remuxedMkv,
    ], { encoding: 'utf8', timeout: 15000 });

    record(
      'G32-15',
      'Newly activated managed FFmpeg + FFprobe pass real A/V merge, MKV remux, and stream/duration probe',
      probeMerged.includes('codec_type=video') &&
        probeMerged.includes('codec_type=audio') &&
        probeMerged.includes('codec_name=h264') &&
        probeMerged.includes('codec_name=aac') &&
        probeMkv.includes('codec_type=video') &&
        probeMkv.includes('codec_type=audio'),
      `mp4Size=${fs.statSync(mergedMp4).size}B, mkvSize=${fs.statSync(remuxedMkv).size}B`
    );

    // Verify atomic FFmpeg + FFprobe rollback restores BOTH together!
    const ffRb = await cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('rollback_external_tool', { toolId: 'ffmpeg' });
    `);
    const rbFf = ffRb.tools.find((t) => t.tool_id === 'ffmpeg');
    const rbFp = ffRb.tools.find((t) => t.tool_id === 'ffprobe');
    record(
      'G32-16',
      'Atomic rollback of FFmpeg bundle restores BOTH ffmpeg and ffprobe together cleanly',
      rbFf?.source === 'bundled' &&
        rbFp?.source === 'bundled' &&
        rbFf?.update_status === 'rolled_back' &&
        rbFp?.update_status === 'rolled_back',
      `ffmpeg=${rbFf?.source}/${rbFf?.update_status}, ffprobe=${rbFp?.source}/${rbFp?.update_status}`
    );

    cdp.close();
    cdp = null;
  } finally {
    if (cdp) cdp.close();
    if (untrustedManifestServer) untrustedManifestServer.close();
    if (signedServer) signedServer.close();
    cleanupTrackedProcs();
    await sleep(300);
    oemDbAfter = snapshotOemDatabase(OEM_DB_PATH);
    const parity = oemGuard.restore({ qaPathMarker: 'gate32_qa', restartOem: true });
    record('G32-17', 'OEM Windows Registry & Native Messaging parity preserved', parity.ok === true, JSON.stringify(parity.checks || {}));
  }

  const dbCmp = compareOemDatabaseSnapshots(oemDbBefore, oemDbAfter);
  const oemExeShaAfter = sha256File(OEM_EXE_PATH);
  record(
    'G32-18',
    'Production user DB & installed v1.0.6 binary completely untouched (PRAGMA integrity_check=ok)',
    Boolean(dbCmp && dbCmp.ok) && oemExeShaBefore === oemExeShaAfter,
    `dbOk=${dbCmp?.ok}, exeMatch=${oemExeShaBefore === oemExeShaAfter}`
  );

  console.log(`\n=== GATE 32 LIVE VERIFICATION SUMMARY: PASS=${counts.PASS} FAIL=${counts.FAIL} ===`);
  if (counts.FAIL > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  cleanupTrackedProcs();
  process.exit(1);
});
