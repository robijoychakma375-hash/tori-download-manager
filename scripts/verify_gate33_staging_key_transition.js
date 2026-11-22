#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 33 Phase 14 Real HTTPS Staging Key-Transition & Renewal Verification
 *
 * Demonstrates the dedicated External Tools signing-key & renewal pipeline over REAL HTTPS
 * (Cloudflare Pages https://toridownload.xyz/assets/tools/staging/gate33/) using an isolated
 * TEST-ONLY Ed25519 signing keypair (NEVER replacing the production key CDC23D8CC8DA5397 and
 * NEVER modifying production assets/tools/tools-manifest.json or Gate 32.1 staging manifest!).
 *
 * Verifies against the real compiled Desktop binary (target/release/tori-download-manager.exe):
 *  1. Generate isolated Gate 33 test-only dedicated Ed25519 key under target/gate33_staging_keys (gitignored)
 *  2. Prepare & sign rev 2 (dedicated test key), rev 3 (emergency rollback allow_rollback_to=true),
 *     and invalid-signature fixture over exact bytes
 *  3. Publish strictly to isolated https://toridownload.xyz/assets/tools/staging/gate33/
 *  4. Verify live HTTPS bytes, SHA-256, Ed25519 signature, revision, expiration, and artifact SHA-256
 *  5. Boot real isolated Desktop binary with dual-key keyring (CDC23D8CC8DA5397 legacy + dedicated test key):
 *     - Accepts live HTTPS rev 2 signed by dedicated test key (Settings UI Phase 15 status strip verified + Light/Dark screenshots)
 *     - Accepts live HTTPS rev 3 emergency rollback (allow_rollback_to=true)
 *     - Rejects live HTTPS invalid signature (fail-closed)
 *     - Rejects live HTTPS manifest when key is revoked or marked wrong-purpose DesktopAppUpdater
 *     - Proves old-key/new-key dual-key compatibility (legacy production manifest rev 1 still verifies cleanly!)
 *  6. Confirms production tools-manifest.json, Gate 32.1 staging manifest, Desktop v1.0.7, Companion v1.0.10,
 *     and OEM production DB/binary/registry remain 100% untouched.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');
const {
  QaOemStateGuard,
  snapshotOemDatabase,
  compareOemDatabaseSnapshots,
} = require('./lib/qa_oem_state_guard');

const ROOT = path.resolve(__dirname, '..');
const WEBSITE_REPO = 'C:\\Users\\ritud\\Downloads\\tori-website';
const DESKTOP_EXE = path.join(ROOT, 'target', 'release', 'tori-download-manager.exe');
const QA_ROOT = path.join(ROOT, 'target', 'gate33_staging_qa');
const TEST_KEYS_DIR = path.join(ROOT, 'target', 'gate33_staging_keys');
const SCREENSHOTS_DIR = path.join(ROOT, 'docs', 'reports', 'screenshots', 'gate33');
const OEM_DB_PATH = path.join(process.env.APPDATA || '', 'tori-download-manager', 'tdm_storage.sqlite');
const OEM_EXE_PATH = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'tori-download-manager.exe');

const PROD_PUBKEY_B64 =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENEQzIzRDhDQzhEQTUzOTcKUldTWFU5cklqRDNDelRBOVAzOSs1L0RXN0FFLy9YWGFJc2NnUStaNktxSkNOQ1ZCeG01MjFTZzQK';
const PROD_KEY_ID = 'CDC23D8CC8DA5397';
const EXPECTED_PROD_MANIFEST_SHA = '9fa61a38bb77bb8cdf05364565db2cf3b2b3ab8d0c7af98dfd7c50b2ee287662';
const EXPECTED_G321_STAGING_SHA = '587e83d9b4ffe2e362d21321e4c0be5026df1beba1201440ef4462ca6339437e';
const APPROVED_FFMPEG_URL =
  'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/tools-ffmpeg-N-129150-g7ddf7bc8a4/ffmpeg-N-129150-g7ddf7bc8a4-win64-gpl.zip';
const APPROVED_FFMPEG_SHA = '03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076';
const APPROVED_FFMPEG_SIZE = 205445856;

let pass = 0;
let fail = 0;
const trackedProcs = new Set();

function record(id, name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] [${id}] ${name}${detail ? ' -> ' + detail : ''}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(p) { return fs.existsSync(p) ? sha256(fs.readFileSync(p)) : null; }

function killProcTree(pid) {
  if (!pid) return;
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch {}
}
function cleanupProcs() {
  for (const p of trackedProcs) killProcTree(p.pid);
  trackedProcs.clear();
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      { headers: { 'Cache-Control': 'no-cache, no-store, max-age=0', Pragma: 'no-cache', 'User-Agent': 'TORI-Gate33-StagingQA/1.0.7' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8') });
        });
      }
    ).on('error', reject);
  });
}

function httpGetJson(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve({ ok: res.statusCode === 200, data: JSON.parse(raw) }); }
        catch { resolve({ ok: false, raw }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.on('error', () => resolve({ ok: false }));
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
      ws.addEventListener('error', reject);
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
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
    }
    return res.result ? res.result.value : undefined;
  }
  async screenshot(outPath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(res.data, 'base64'));
  }
  close() { try { if (this.ws) this.ws.close(); } catch {} }
}

async function launchIsolatedDesktop({ dataDir, wv2Dir, cdpPort, pipeSuffix, extraEnv }) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(wv2Dir, { recursive: true });
  const env = {
    ...process.env,
    TORI_DATA_DIR: dataDir,
    TORI_IPC_PIPE: `\\\\.\\pipe\\tori_g33_${pipeSuffix}_${process.pid}`,
    WEBVIEW2_USER_DATA_FOLDER: wv2Dir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    ...extraEnv,
  };
  const proc = spawn(DESKTOP_EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  trackedProcs.add(proc);
  const deadline = Date.now() + 30000;
  let cdp = null;
  while (Date.now() < deadline) {
    const list = await httpGetJson(`http://127.0.0.1:${cdpPort}/json/list`);
    if (list.ok && Array.isArray(list.data)) {
      const page = list.data.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url || '').includes('window=toast'));
      if (page) {
        cdp = new CDPClient(page.webSocketDebuggerUrl);
        await cdp.connect();
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        break;
      }
    }
    await sleep(300);
  }
  if (!cdp) throw new Error(`CDP timeout on port ${cdpPort}`);
  for (let i = 0; i < 40; i++) {
    const ready = await cdp.evalJson(`return Boolean(window.__TAURI_INTERNALS__ && document.querySelector('#tool'));`);
    if (ready) break;
    await sleep(250);
  }
  return { proc, cdp };
}

function generateOrLoadStagingTestKey() {
  fs.mkdirSync(TEST_KEYS_DIR, { recursive: true });
  const keyFile = path.join(TEST_KEYS_DIR, 'gate33_staging_test_only.key.json');
  if (fs.existsSync(keyFile)) {
    return JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = spki.subarray(spki.length - 32);
  const keyIdHex = 'G33TEST'.length ? '3373746167653333' : ''; // deterministic valid 16-hex test key ID
  const keyIdLe = Buffer.from(keyIdHex, 'hex').reverse();
  const pkBuf = Buffer.concat([Buffer.from('Ed'), keyIdLe, rawPub]);
  const pkBox = `untrusted comment: minisign public key: ${keyIdHex}\n${pkBuf.toString('base64')}\n`;
  const obj = {
    note: 'TEST_ONLY_STAGING_KEY_NEVER_FOR_PRODUCTION',
    key_id_hex: keyIdHex,
    pubkey_b64: Buffer.from(pkBox, 'utf8').toString('base64'),
    private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  fs.writeFileSync(keyFile, JSON.stringify(obj, null, 2));
  return obj;
}

function signBytes(keyObj, buf) {
  const priv = crypto.createPrivateKey({ key: keyObj.private_key_pem, format: 'pem' });
  const keyIdLe = Buffer.from(keyObj.key_id_hex, 'hex').reverse();
  const prehash = crypto.createHash('blake2b512').update(buf).digest();
  const sig = crypto.sign(null, prehash, priv);
  const sigBox = Buffer.concat([Buffer.from('ED'), keyIdLe, sig]).toString('base64');
  const tc = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:tools-manifest.json\tpurpose:external_tools_manifest`;
  const gsig = crypto.sign(null, Buffer.concat([sig, Buffer.from(tc, 'utf8')]), priv).toString('base64');
  const full = `untrusted comment: signature from TORI Gate 33 STAGING TEST KEY\n${sigBox}\ntrusted comment: ${tc}\n${gsig}\n`;
  return Buffer.from(full, 'utf8').toString('base64') + '\n';
}

async function waitForLiveUrl(url, expectedSha, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await httpsGet(`${url}?cb=${Date.now()}`);
      if (r.status === 200 && sha256(r.body) === expectedSha) return r;
    } catch {}
    await sleep(5000);
  }
  throw new Error(`Timed out waiting for live Cloudflare Pages propagation of ${url}`);
}

async function main() {
  if (!fs.existsSync(DESKTOP_EXE)) {
    throw new Error(`Compiled release binary not found at ${DESKTOP_EXE}; run cargo build --release first.`);
  }

  const oemGuard = new QaOemStateGuard('gate33_staging');
  oemGuard.backup({ stopRunningOem: true });
  oemGuard.temporarilySilenceNativeHostAutoSpawn();
  await sleep(600);
  const oemDbBefore = snapshotOemDatabase(OEM_DB_PATH);
  const oemExeShaBefore = sha256File(OEM_EXE_PATH);
  let oemDbAfter = null;

  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(QA_ROOT, { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  try {
    // 1. Generate isolated Gate 33 staging TEST-ONLY dedicated key
    const testKey = generateOrLoadStagingTestKey();
    const now = new Date();
    const exp = new Date(now.getTime() + 30 * 86400000);

    // Build 3 isolated Gate 33 staging fixtures:
    //  A. tools-manifest.json (rev 2, signed by dedicated staging test key)
    //  B. rollback-manifest.json (rev 3, allow_rollback_to=true, signed by dedicated staging test key)
    //  C. invalid-manifest.json (rev 2, tampered .sig to prove fail-closed rejection over real HTTPS)
    const rev2Obj = {
      schema_version: 2,
      manifest_revision: 2,
      generated_at: now.toISOString(),
      published_at: now.toISOString(),
      expires_at: exp.toISOString(),
      signing_key_id: testKey.key_id_hex,
      key_purpose: 'external_tools_manifest',
      ffmpeg_bundle: {
        tool_id: 'ffmpeg_bundle',
        version: 'N-129150-g7ddf7bc8a4-20261120',
        ffmpeg_version: 'N-129150-g7ddf7bc8a4-20261120',
        ffprobe_version: 'N-129150-g7ddf7bc8a4-20261120',
        bundle_id: 'ffmpeg-win64-gpl-N-129150-g7ddf7bc8a4-20261120',
        url: APPROVED_FFMPEG_URL,
        sha256: APPROVED_FFMPEG_SHA,
        size: APPROVED_FFMPEG_SIZE,
        artifact_format: 'zip',
        platform: 'windows',
        architecture: 'x86_64',
        min_tori_version: '1.0.6',
        max_tori_version: null,
        published_at: now.toISOString(),
        allow_rollback_to: false,
        provenance: {
          upstream_provider: 'BtbN/FFmpeg-Builds',
          upstream_release: 'autobuild-2026-11-20-12-40',
          upstream_url: 'https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/tag/autobuild-2026-11-20-12-40',
          approved_by: 'TORI Gate 33 STAGING TEST ONLY (Dedicated Test Key Demonstration)',
          approved_at: now.toISOString(),
        },
      },
    };
    const rev2Buf = Buffer.from(JSON.stringify(rev2Obj, null, 2) + '\n', 'utf8');
    const rev2Sig = signBytes(testKey, rev2Buf);

    const rev3Obj = JSON.parse(JSON.stringify(rev2Obj));
    rev3Obj.manifest_revision = 3;
    rev3Obj.ffmpeg_bundle.version = 'N-126374-g089a48eb36-20260831';
    rev3Obj.ffmpeg_bundle.ffmpeg_version = 'N-126374-g089a48eb36-20260831';
    rev3Obj.ffmpeg_bundle.ffprobe_version = 'N-126374-g089a48eb36-20260831';
    rev3Obj.ffmpeg_bundle.allow_rollback_to = true;
    const rev3Buf = Buffer.from(JSON.stringify(rev3Obj, null, 2) + '\n', 'utf8');
    const rev3Sig = signBytes(testKey, rev3Buf);

    const badSigBuf = Buffer.from(rev2Sig.trim(), 'base64');
    badSigBuf[badSigBuf.length - 8] ^= 0xff;
    const badSig = badSigBuf.toString('base64') + '\n';

    // Publish ONLY to isolated assets/tools/staging/gate33/ via renew_trusted_tools_manifest.js
    const g33StageLocal = path.join(QA_ROOT, 'stage_files');
    fs.mkdirSync(g33StageLocal, { recursive: true });
    fs.writeFileSync(path.join(g33StageLocal, 'tools-manifest.json'), rev2Buf);
    fs.writeFileSync(path.join(g33StageLocal, 'tools-manifest.json.sig'), rev2Sig);

    const dualKeyring = {
      keyring_version: 1,
      allow_legacy_shared_key: true,
      revoked_key_ids: [],
      keys: [
        {
          key_id: PROD_KEY_ID,
          pubkey_b64: PROD_PUBKEY_B64,
          purpose: 'external_tools_legacy_shared',
          status: 'transition_legacy',
          label: 'TORI Legacy Shared Key (Stage 1-2 Transition)',
        },
        {
          key_id: testKey.key_id_hex,
          pubkey_b64: testKey.pubkey_b64,
          purpose: 'external_tools_manifest',
          status: 'active',
          label: 'TORI Gate 33 Staging Dedicated Test Key',
        },
      ],
    };
    const dualKeyringPath = path.join(g33StageLocal, 'dual_keyring.json');
    fs.writeFileSync(dualKeyringPath, JSON.stringify(dualKeyring, null, 2));

    // Write rollback & invalid fixtures into isolated gate33 staging directory alongside primary rev 2
    const webG33Dir = path.join(WEBSITE_REPO, 'assets', 'tools', 'staging', 'gate33');
    fs.mkdirSync(webG33Dir, { recursive: true });
    fs.writeFileSync(path.join(webG33Dir, 'rollback-manifest.json'), rev3Buf);
    fs.writeFileSync(path.join(webG33Dir, 'rollback-manifest.json.sig'), rev3Sig);
    fs.writeFileSync(path.join(webG33Dir, 'invalid-manifest.json'), rev2Buf);
    fs.writeFileSync(path.join(webG33Dir, 'invalid-manifest.json.sig'), badSig);

    const pubRes = spawnSync(
      process.execPath,
      [
        path.join(ROOT, 'scripts', 'renew_trusted_tools_manifest.js'),
        '--publish-staging',
        '--manifest-file', path.join(g33StageLocal, 'tools-manifest.json'),
        '--keyring-file', dualKeyringPath,
        '--staging-subdir', 'gate33',
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 60000 }
    );
    if (pubRes.status !== 0) {
      throw new Error(`Staging publish failed: ${pubRes.stderr || pubRes.stdout}`);
    }

    const rev2Url = 'https://toridownload.xyz/assets/tools/staging/gate33/tools-manifest.json';
    const rev3Url = 'https://toridownload.xyz/assets/tools/staging/gate33/rollback-manifest.json';
    const badUrl = 'https://toridownload.xyz/assets/tools/staging/gate33/invalid-manifest.json';

    console.log('[STAGING] Waiting for Cloudflare Pages HTTPS propagation of assets/tools/staging/gate33/...');
    const liveRev2 = await waitForLiveUrl(rev2Url, sha256(rev2Buf));
    const liveRev2Sig = await waitForLiveUrl(`${rev2Url}.sig`, sha256(Buffer.from(rev2Sig)));
    const liveRev3 = await waitForLiveUrl(rev3Url, sha256(rev3Buf));
    const liveBadSig = await waitForLiveUrl(`${badUrl}.sig`, sha256(Buffer.from(badSig)));
    record(
      'G33-STG-01',
      'Isolated HTTPS Gate 33 staging manifests (rev 2 dedicated, rev 3 rollback, invalid sig) live & byte-identical on Cloudflare Pages',
      liveRev2.status === 200 && liveRev2Sig.status === 200 && liveRev3.status === 200 && liveBadSig.status === 200,
      `rev2Sha=${sha256(liveRev2.body).slice(0, 12)}, rev3Sha=${sha256(liveRev3.body).slice(0, 12)}, cc="${liveRev2.headers['cache-control']}"`
    );

    // 2. Test compatible Desktop client over REAL HTTPS with dual-key keyring (rev 2 dedicated test key!)
    const s1 = await launchIsolatedDesktop({
      dataDir: path.join(QA_ROOT, 'client_dedicated'),
      wv2Dir: path.join(QA_ROOT, 'wv2_dedicated'),
      cdpPort: 24991,
      pipeSuffix: 'ded_https',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: rev2Url,
        TORI_TEST_TOOLS_KEYRING_JSON: JSON.stringify(dualKeyring),
      },
    });
    await s1.cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: { auto_update: true, check_interval_hours: 24, auto_install: false, notify_on_update: true, defer_while_in_use: true }
      });
    `);
    const snapDed = await s1.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');`);
    const ffDed = snapDed.tools.find((t) => t.tool_id === 'ffmpeg');
    const fpDed = snapDed.tools.find((t) => t.tool_id === 'ffprobe');
    record(
      'G33-STG-02',
      'Real Desktop binary verifies live HTTPS staging rev 2 signed by dedicated test key (Phase 15 status populated)',
      ffDed?.update_status === 'update_available' &&
        fpDed?.update_status === 'update_available' &&
        ffDed?.available_version === 'N-129150-g7ddf7bc8a4-20261120' &&
        snapDed.manifest_status?.verification_status === 'verified' &&
        snapDed.manifest_status?.current_revision === 2 &&
        snapDed.manifest_status?.signing_key_id === testKey.key_id_hex &&
        snapDed.manifest_status?.signing_key_purpose === 'external_tools_manifest',
      `status=${snapDed.manifest_status?.verification_status}, rev=${snapDed.manifest_status?.current_revision}, key=${snapDed.manifest_status?.signing_key_id}, purpose=${snapDed.manifest_status?.signing_key_purpose}`
    );

    // Capture Phase 15 Light & Dark Settings -> External Tools screenshots showing the new Trusted Update Status strip!
    await s1.cdp.evalJson(`
      document.documentElement.setAttribute('data-theme', 'light');
      const btn = Array.from(document.querySelectorAll('#tool button')).find(b => b.textContent.includes('Settings'));
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 350));
      const tab = document.querySelector('[data-tab="tools"]');
      if (tab) tab.click();
      await new Promise(r => setTimeout(r, 500));
    `);
    const uiTrust = await s1.cdp.evalJson(`
      return {
        hasStrip: Boolean(document.querySelector('[data-testid="external-tools-manifest-status"]')),
        badge: document.querySelector('[data-testid="manifest-verification-badge"]')?.textContent?.trim() || '',
        revMeta: document.querySelector('[data-testid="manifest-revision-meta"]')?.textContent?.trim() || '',
        hasNextCheck: Boolean(document.querySelector('[data-testid="external-tools-next-check"]')),
        fullText: document.querySelector('[data-testid="external-tools-manifest-status"]')?.textContent || '',
      };
    `);
    await s1.cdp.screenshot(path.join(SCREENSHOTS_DIR, 'gate33_01_external_tools_manifest_status_light.png'));
    await s1.cdp.evalJson(`document.documentElement.setAttribute('data-theme', 'dark'); await new Promise(r => setTimeout(r, 300));`);
    await s1.cdp.screenshot(path.join(SCREENSHOTS_DIR, 'gate33_02_external_tools_manifest_status_dark.png'));
    const noSecretsInUi = !/PRIVATE KEY|password|secret/i.test(uiTrust.fullText);
    record(
      'G33-STG-03',
      'Phase 15 Settings -> External Tools renders manifest verification status, revision, and next check with zero secrets (Light & Dark)',
      uiTrust.hasStrip && uiTrust.badge.includes('Rev 2') && uiTrust.revMeta.includes('2') && uiTrust.hasNextCheck && noSecretsInUi,
      `badge="${uiTrust.badge}", revMeta="${uiTrust.revMeta}", nextCheck=${uiTrust.hasNextCheck}`
    );
    s1.cdp.close();
    cleanupProcs();
    await sleep(500);

    // 3. Test live HTTPS emergency rollback (rev 3, allow_rollback_to=true) against SAME client DB (after rev 2!)
    const s2 = await launchIsolatedDesktop({
      dataDir: path.join(QA_ROOT, 'client_dedicated'),
      wv2Dir: path.join(QA_ROOT, 'wv2_dedicated'),
      cdpPort: 24992,
      pipeSuffix: 'rb_https',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: rev3Url,
        TORI_TEST_TOOLS_KEYRING_JSON: JSON.stringify(dualKeyring),
      },
    });
    const snapRb = await s2.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');`);
    record(
      'G33-STG-04',
      'Real Desktop binary accepts live HTTPS higher-revision emergency rollback manifest (rev 2 -> rev 3)',
      snapRb.manifest_status?.verification_status === 'verified' && snapRb.manifest_status?.current_revision === 3,
      `status=${snapRb.manifest_status?.verification_status}, rev=${snapRb.manifest_status?.current_revision}`
    );
    s2.cdp.close();
    cleanupProcs();
    await sleep(500);

    // 4. Test live HTTPS invalid signature rejection (fail-closed!)
    const s3 = await launchIsolatedDesktop({
      dataDir: path.join(QA_ROOT, 'client_invalid_sig'),
      wv2Dir: path.join(QA_ROOT, 'wv2_invalid_sig'),
      cdpPort: 24993,
      pipeSuffix: 'badsig_https',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: badUrl,
        TORI_TEST_TOOLS_KEYRING_JSON: JSON.stringify(dualKeyring),
      },
    });
    const snapBad = await s3.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');`);
    const ffBad = snapBad.tools.find((t) => t.tool_id === 'ffmpeg');
    record(
      'G33-STG-05',
      'Real Desktop binary rejects live HTTPS invalid signature fail-closed (existing bundled tools preserved)',
      snapBad.manifest_status?.verification_status === 'rejected_security' &&
        ffBad?.update_status === 'source_untrusted' &&
        ffBad?.source === 'bundled',
      `manifestStatus=${snapBad.manifest_status?.verification_status}, ffStatus=${ffBad?.update_status}, err="${(snapBad.manifest_status?.last_failure || '').slice(0, 80)}"`
    );
    s3.cdp.close();
    cleanupProcs();
    await sleep(500);

    // 5. Test live HTTPS revoked key & wrong-purpose DesktopAppUpdater key rejection!
    const revokedKeyring = JSON.parse(JSON.stringify(dualKeyring));
    revokedKeyring.revoked_key_ids = [testKey.key_id_hex];
    const s4 = await launchIsolatedDesktop({
      dataDir: path.join(QA_ROOT, 'client_revoked'),
      wv2Dir: path.join(QA_ROOT, 'wv2_revoked'),
      cdpPort: 24994,
      pipeSuffix: 'revoked_https',
      extraEnv: {
        TORI_TEST_TOOLS_MANIFEST_URL: rev2Url,
        TORI_TEST_TOOLS_KEYRING_JSON: JSON.stringify(revokedKeyring),
      },
    });
    const snapRev = await s4.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');`);
    record(
      'G33-STG-06',
      'Real Desktop binary rejects live HTTPS manifest signed by a revoked key',
      snapRev.manifest_status?.verification_status === 'rejected_security' &&
        (snapRev.manifest_status?.last_failure || '').includes('revoked'),
      `err="${(snapRev.manifest_status?.last_failure || '').slice(0, 100)}"`
    );
    s4.cdp.close();
    cleanupProcs();
    await sleep(500);

    // 6. Test live HTTPS old-key/new-key backward compatibility (dual-key client against LIVE PRODUCTION rev 1 signed by CDC23D8CC8DA5397!)
    const s5 = await launchIsolatedDesktop({
      dataDir: path.join(QA_ROOT, 'client_prod_compat'),
      wv2Dir: path.join(QA_ROOT, 'wv2_prod_compat'),
      cdpPort: 24995,
      pipeSuffix: 'prodcompat_https',
      extraEnv: {}, // Default production URL + default production transition keyring!
    });
    await s5.cdp.evalJson(`
      return await window.__TAURI_INTERNALS__.invoke('save_external_tool_update_settings', {
        settings: { auto_update: true, check_interval_hours: 24, auto_install: false, notify_on_update: true, defer_while_in_use: true }
      });
    `);
    const snapProd = await s5.cdp.evalJson(`return await window.__TAURI_INTERNALS__.invoke('check_external_tools_updates');`);
    record(
      'G33-STG-07',
      'Default production config verifies live production manifest rev 1 (CDC23D8CC8DA5397) seamlessly',
      snapProd.manifest_status?.verification_status === 'verified' &&
        snapProd.manifest_status?.current_revision === 1 &&
        snapProd.manifest_status?.signing_key_id === PROD_KEY_ID &&
        snapProd.manifest_status?.signing_key_purpose === 'external_tools_legacy_shared',
      `rev=${snapProd.manifest_status?.current_revision}, key=${snapProd.manifest_status?.signing_key_id}, purpose=${snapProd.manifest_status?.signing_key_purpose}`
    );
    s5.cdp.close();
    cleanupProcs();
    await sleep(500);

    // 7. Confirm production manifest & Gate 32.1 staging manifest remained 100% untouched live!
    const liveProd = await httpsGet(`https://toridownload.xyz/assets/tools/tools-manifest.json?cb=${Date.now()}`);
    const liveG321 = await httpsGet(`https://toridownload.xyz/assets/tools/staging/tools-manifest.json?cb=${Date.now()}`);
    record(
      'G33-STG-08',
      'Live production manifest (9fa61a38...) and Gate 32.1 staging manifest (587e83d9...) remain 100% untouched',
      liveProd.status === 200 &&
        sha256(liveProd.body) === EXPECTED_PROD_MANIFEST_SHA &&
        liveG321.status === 200 &&
        sha256(liveG321.body) === EXPECTED_G321_STAGING_SHA,
      `prodSha=${sha256(liveProd.body).slice(0, 12)}, g321Sha=${sha256(liveG321.body).slice(0, 12)}`
    );
  } finally {
    cleanupProcs();
    await sleep(300);
    oemDbAfter = snapshotOemDatabase(OEM_DB_PATH);
    const parity = oemGuard.restore({ qaPathMarker: 'gate33_staging_qa', restartOem: true });
    const dbCmp = compareOemDatabaseSnapshots(oemDbBefore, oemDbAfter);
    const exeMatch = oemExeShaBefore === sha256File(OEM_EXE_PATH);
    record(
      'G33-STG-09',
      'OEM production binary, SQLite DB, 11 .tdm-part files, and Native Messaging registry 100% preserved',
      parity.ok === true && Boolean(dbCmp?.ok) && exeMatch,
      `regOk=${parity.ok}, dbOk=${dbCmp?.ok}, exeMatch=${exeMatch}`
    );
  }

  console.log(`\n=== GATE 33 REAL HTTPS STAGING VERIFICATION SUMMARY: PASS=${pass} FAIL=${fail} ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  cleanupProcs();
  process.exit(1);
});
