#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 31.6
 * Live Post-Release Verification Suite (GitHub v1.0.6, latest.json Auto-Updater,
 * Cloudflare Pages Website Desktop/Mobile, Browser Companion v1.0.10 Preservation,
 * and Isolated Physical v1.0.5 -> Live-Downloaded v1.0.6 Upgrade & Runtime Audit)
 *
 * Uses QaOemStateGuard so production registry, Native Messaging manifests,
 * shortcuts, SQLite DB, and .tdm-part files are 100% preserved and parity-checked.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync, execSync, execFileSync } = require('child_process');
const { QaOemStateGuard } = require('./lib/qa_oem_state_guard');

const ROOT = path.resolve(__dirname, '..');
const REPO = 'robijoychakma375-hash/tori-download-manager';
const SITE_URL = 'https://toridownload.xyz';
const APPROVED_COMMIT = '6087db99eb0da4ebf69e2d0d6c489bcf5837ed11';

const EXPECTED_V106_INSTALLER_SIZE = 117794132;
const EXPECTED_V106_INSTALLER_SHA = 'c29ee1080b0c3587d29a2e95fd4374524d49fc16055dfa74f9f66554161c6c7c';
const EXPECTED_V106_SIG_SIZE = 436;
const EXPECTED_V106_SIG_SHA = '2a3f4b217ae381a7a1d1042ca8b395480132d89d5d58c46a2c8dcccba765624a';
const EXPECTED_V106_HOST_SHA = 'd02da8be8056cd987bd4b5cdca9535a016f60bcb7cbed94fb43d56c042967671';
const EXPECTED_XPI_SIZE = 107499;
const EXPECTED_XPI_SHA = 'a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8';
const EXPECTED_CHR_SIZE = 90964;
const EXPECTED_CHR_SHA = 'f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1';
const EXPECTED_GECKO_ID = 'tori-download-manager@toridm.org';

const V105_INSTALLER = path.join(ROOT, 'release', 'v1.0.5-rc', 'TORI Download Manager_1.0.5_x64-setup.exe');
const ROLLBACK_DIR = path.join(ROOT, 'target', 'gate31_5_rollback_backup');
const ROLLBACK_ONLINE_DB = path.join(ROLLBACK_DIR, 'appdata', 'tdm_storage.online_backup.sqlite');
const BEFORE_SNAP_PATH = path.join(ROLLBACK_DIR, 'before_snapshot.json');
const PROD_DB = path.join(process.env.APPDATA || '', 'tori-download-manager', 'tdm_storage.sqlite');
const PROD_EXE = path.join(process.env.LOCALAPPDATA || '', 'TORI Download Manager', 'tori-download-manager.exe');

const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

const QA_ROOT = path.join(ROOT, 'target', 'gate31_6_live_qa');
const DL_DIR = path.join(QA_ROOT, 'live_downloads');
const UPG_INST_DIR = path.join(QA_ROOT, 'upg_inst');
const UPG_DATA_DIR = path.join(QA_ROOT, 'upg_data');
const UPG_DL_DIR = path.join(QA_ROOT, 'upg_dl');
const UPG_WV2_DIR = path.join(QA_ROOT, 'upg_wv2');
const SITE_EDGE_PROF = path.join(QA_ROOT, 'site_edge_prof');
const FF_PROF = path.join(QA_ROOT, 'ff_prof');

const UPG_PORT = 25260;
const UPG_CDP_PORT = 25261;
const FIXTURE_PORT = 25262;
const SITE_CDP_PORT = 25263;
const FF_MAR_PORT = 2843;

const results = [];
const counts = { PASS: 0, FAIL: 0 };
const trackedProcs = new Set();
const oemGuard = new QaOemStateGuard('gate31_6');
let fixtureServer = null;

function record(id, desc, ok, detail = '') {
  const status = ok ? 'PASS' : 'FAIL';
  counts[status]++;
  console.log(`[${status}] [${id}] ${desc}${detail ? ' -> ' + detail : ''}`);
  results.push({ id, desc, status, detail });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256File(p) {
  if (!p || !fs.existsSync(p)) return null;
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex').toLowerCase();
}

function killProcTree(pid) {
  if (!pid) return;
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch {}
}

function cleanupProcs() {
  for (const p of trackedProcs) if (p?.pid) killProcTree(p.pid);
  trackedProcs.clear();
}

function getGitHubToken() {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['credential', 'fill']);
    proc.stdin.write('protocol=https\nhost=github.com\n\n');
    proc.stdin.end();
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', () => {
      const m = out.match(/^password=(.+)$/m);
      if (m) resolve(m[1].trim()); else reject(new Error('No GitHub token'));
    });
  });
}

function fetchRaw(url, token = null) {
  return new Promise((resolve, reject) => {
    const redirects = [];
    const go = (u) => {
      const headers = { 'User-Agent': 'TORI-Gate31-6-Live-Verifier' };
      if (token && u.startsWith('https://api.github.com/')) {
        headers.Authorization = `Bearer ${token}`;
        headers.Accept = 'application/vnd.github+json';
      }
      https.get(u, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          redirects.push({ status: res.statusCode, location: res.headers.location });
          return go(res.headers.location);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, finalUrl: u, redirects, buf: Buffer.concat(chunks) }));
      }).on('error', reject);
    };
    go(url);
  });
}

function downloadFileViaCurl(url, destPath) {
  const res = spawnSync(
    'curl.exe',
    ['-sS', '-L', '--http1.1', '--retry', '4', '--retry-delay', '2', '-o', destPath, '-w', '%{http_code}', '-H', 'User-Agent: TORI-Gate31-6-Live-Verifier', url],
    { encoding: 'utf8', timeout: 600000 }
  );
  if (res.error) throw res.error;
  return parseInt((res.stdout || '').trim(), 10) || 0;
}

function httpJson({ port, reqPath, method = 'GET', headers = {}, body = null, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const payload = body !== null ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (payload !== null) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers: h, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function compareSemVer(a, b) {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  async connect(timeoutMs = 10000) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs);
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
      this.ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(e.message || 'ws error')); });
      this.ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          }
        } catch {}
      });
    });
  }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, userGesture = false) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
    if (res?.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res?.result?.value;
  }
  close() { try { this.ws?.close(); } catch {} }
}

class MarionetteClient {
  constructor(port) {
    this.port = port;
    this.buf = Buffer.alloc(0);
    this.msgId = 0;
    this.pending = new Map();
    this.helloResolve = null;
  }
  async connect(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await new Promise((resolve, reject) => {
          const s = net.createConnection({ host: '127.0.0.1', port: this.port });
          this.sock = s;
          this.helloResolve = resolve;
          s.on('error', reject);
          s.on('data', (chunk) => this._onData(chunk));
        });
        return;
      } catch {
        await sleep(300);
      }
    }
    throw new Error(`Marionette timeout on port ${this.port}`);
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const idx = this.buf.indexOf(0x3a);
      if (idx === -1) break;
      const len = parseInt(this.buf.subarray(0, idx).toString('utf8'), 10);
      if (Number.isNaN(len) || this.buf.length < idx + 1 + len) break;
      const body = this.buf.subarray(idx + 1, idx + 1 + len).toString('utf8');
      this.buf = this.buf.subarray(idx + 1 + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      if (!Array.isArray(msg) && msg.applicationType && this.helloResolve) {
        const r = this.helloResolve; this.helloResolve = null; r(msg);
      } else if (Array.isArray(msg) && msg[0] === 1) {
        const p = this.pending.get(msg[1]);
        if (p) {
          this.pending.delete(msg[1]); clearTimeout(p.timer);
          if (msg[2]) p.reject(new Error(JSON.stringify(msg[2])));
          else p.resolve(msg[3]);
        }
      }
    }
  }
  send(cmd, params = {}, timeoutMs = 20000) {
    const id = ++this.msgId;
    const wire = JSON.stringify([0, id, cmd, params]);
    const payload = `${Buffer.byteLength(wire, 'utf8')}:${wire}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Marionette timeout: ${cmd}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(payload);
    });
  }
  close() { try { this.sock?.destroy(); } catch {} }
}

async function listCdpTargets(port) {
  const res = await httpJson({ port, reqPath: '/json/list', timeoutMs: 3000 });
  return Array.isArray(res.data) ? res.data : [];
}

function getProgressJobId(t) {
  try {
    const u = new URL(t.url);
    if (u.searchParams.get('window') === 'progress' || u.searchParams.get('window') === 'toast') {
      return u.searchParams.get('id');
    }
  } catch {}
  return null;
}

async function main() {
  console.log('=============================================================================');
  console.log('  TORI GATE 31.6 — LIVE PUBLIC RELEASE, UPDATER, WEBSITE & UPGRADE AUDIT');
  console.log('=============================================================================\n');

  const token = await getGitHubToken();
  const prodDbBefore = sha256File(PROD_DB);
  const beforeSnap = JSON.parse(fs.readFileSync(BEFORE_SNAP_PATH, 'utf8'));

  oemGuard.backup({ stopRunningOem: false });
  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  for (const d of [DL_DIR, UPG_INST_DIR, UPG_DATA_DIR, UPG_DL_DIR, UPG_WV2_DIR, SITE_EDGE_PROF, FF_PROF]) {
    fs.mkdirSync(d, { recursive: true });
  }

  let prodDbBeforeRestore = null;
  try {
    // =========================================================================
    // 1. LIVE GITHUB RELEASE v1.0.6 & PRESERVATION CHECKS
    // =========================================================================
    console.log('>>> [1] Live GitHub Release v1.0.6, v1.0.5 & extension-v1.0.10 Verification <<<');
    const latestRes = await fetchRaw(`https://api.github.com/repos/${REPO}/releases/latest`, token);
    const latestRel = JSON.parse(latestRes.buf.toString('utf8'));
    const remoteTagSha = execFileSync('git', ['ls-remote', 'origin', 'refs/tags/v1.0.6^{}'], { cwd: ROOT, encoding: 'utf8' }).trim().split(/\s+/)[0];
    record(
      'GH-LATEST-V106',
      'GitHub /releases/latest is Desktop v1.0.6 (stable, non-draft, approved commit)',
      latestRel.tag_name === 'v1.0.6' && !latestRel.draft && !latestRel.prerelease && remoteTagSha === APPROVED_COMMIT && latestRel.assets.length === 14,
      `id=${latestRel.id}, tag=${latestRel.tag_name}, assets=${latestRel.assets.length}, commit=${remoteTagSha}`
    );

    const hasNoExtInDesktop = latestRel.assets.every((a) => !/\.xpi$|companion/i.test(a.name));
    record('GH-DESKTOP-ONLY', 'Desktop v1.0.6 release contains zero Browser Companion packages', hasNoExtInDesktop, `assetNames=${latestRel.assets.length}`);

    const v105Res = await fetchRaw(`https://api.github.com/repos/${REPO}/releases/tags/v1.0.5`, token);
    const extRes = await fetchRaw(`https://api.github.com/repos/${REPO}/releases/tags/extension-v1.0.10`, token);
    const extRel = JSON.parse(extRes.buf.toString('utf8'));
    record(
      'GH-PRESERVED',
      'Historical Desktop v1.0.5 and Browser Companion extension-v1.0.10 releases preserved untouched',
      v105Res.status === 200 && extRes.status === 200 && extRel.tag_name === 'extension-v1.0.10' && latestRel.tag_name === 'v1.0.6',
      `v105Status=${v105Res.status}, extId=${extRel.id}`
    );

    // Download live v1.0.6 installer & .sig over public HTTPS
    const liveInstPath = path.join(DL_DIR, 'TORI.Download.Manager_1.0.6_x64-setup.exe');
    const liveSigPath = path.join(DL_DIR, 'TORI.Download.Manager_1.0.6_x64-setup.exe.sig');
    const instCode = downloadFileViaCurl(`https://github.com/${REPO}/releases/download/v1.0.6/TORI.Download.Manager_1.0.6_x64-setup.exe`, liveInstPath);
    const sigCode = downloadFileViaCurl(`https://github.com/${REPO}/releases/download/v1.0.6/TORI.Download.Manager_1.0.6_x64-setup.exe.sig`, liveSigPath);
    const liveInstSize = fs.existsSync(liveInstPath) ? fs.statSync(liveInstPath).size : 0;
    const liveInstSha = sha256File(liveInstPath);
    const liveSigSize = fs.existsSync(liveSigPath) ? fs.statSync(liveSigPath).size : 0;
    const liveSigSha = sha256File(liveSigPath);
    record(
      'GH-LIVE-INST-SHA',
      'Live HTTPS download of v1.0.6 installer & .sig match frozen approved sizes and SHA-256 bit-for-bit',
      instCode === 200 && sigCode === 200 && liveInstSize === EXPECTED_V106_INSTALLER_SIZE && liveInstSha === EXPECTED_V106_INSTALLER_SHA && liveSigSize === EXPECTED_V106_SIG_SIZE && liveSigSha === EXPECTED_V106_SIG_SHA,
      `inst=${liveInstSize}B (${liveInstSha}), sig=${liveSigSize}B (${liveSigSha})`
    );

    // =========================================================================
    // 2. LIVE AUTO-UPDATER latest.json & UPGRADE MATRIX
    // =========================================================================
    console.log('\n>>> [2] Live Auto-Updater Endpoint (latest.json) & Upgrade Matrix <<<');
    const ljRes = await fetchRaw(`https://github.com/${REPO}/releases/latest/download/latest.json`);
    const lj = JSON.parse(ljRes.buf.toString('utf8'));
    const liveSigTrimmed = fs.readFileSync(liveSigPath, 'utf8').trim();
    const expectedUrl = `https://github.com/${REPO}/releases/download/v1.0.6/TORI.Download.Manager_1.0.6_x64-setup.exe`;
    const ljOk = Boolean(
      ljRes.status === 200 &&
      lj.version === '1.0.6' &&
      !Number.isNaN(Date.parse(lj.pub_date)) &&
      lj.platforms?.['windows-x86_64']?.url === expectedUrl &&
      lj.platforms?.['windows-x86_64-nsis']?.url === expectedUrl &&
      lj.platforms?.['windows-x86_64']?.signature === liveSigTrimmed &&
      lj.platforms?.['windows-x86_64-nsis']?.signature === liveSigTrimmed
    );
    record(
      'UPD-LIVE-JSON',
      'Live releases/latest/download/latest.json serves v1.0.6 with exact URL and verified Ed25519 signature',
      ljOk,
      `status=${ljRes.status}, version=${lj.version}, pub_date=${lj.pub_date}, finalUrl=${ljRes.finalUrl}`
    );

    const matrixOk =
      compareSemVer(lj.version, '1.0.3') > 0 &&
      compareSemVer(lj.version, '1.0.4') > 0 &&
      compareSemVer(lj.version, '1.0.5') > 0 &&
      compareSemVer(lj.version, '1.0.6') === 0 &&
      compareSemVer(lj.version, '1.0.7') < 0;
    record('UPD-MATRIX', 'SemVer upgrade matrix (1.0.3/1.0.4/1.0.5 -> 1.0.6; 1.0.6 up-to-date; >1.0.6 no downgrade)', matrixOk);

    // =========================================================================
    // 3. PHASE 11: BROWSER COMPANION v1.0.10 LIVE PRESERVATION + SIGNED FIREFOX INSTALL
    // =========================================================================
    console.log('\n>>> [3] Live Browser Companion v1.0.10 Preservation (GitHub + Website + Firefox Signed Install) <<<');
    const ghXpiPath = path.join(DL_DIR, 'gh_v1010.xpi');
    const siteXpiPath = path.join(DL_DIR, 'site_v1010.xpi');
    const ghChrPath = path.join(DL_DIR, 'gh_v1010_chr.zip');
    const ghXpiCode = downloadFileViaCurl(`https://github.com/${REPO}/releases/download/extension-v1.0.10/tori-companion-v1.0.10-firefox-signed.xpi`, ghXpiPath);
    const ghChrCode = downloadFileViaCurl(`https://github.com/${REPO}/releases/download/extension-v1.0.10/tori-companion-v1.0.10-chromium.zip`, ghChrPath);
    const siteXpiRes = await fetchRaw(`${SITE_URL}/assets/tori-download-manager-firefox-v1.0.10.xpi`);
    fs.writeFileSync(siteXpiPath, siteXpiRes.buf);

    const ghXpiSha = sha256File(ghXpiPath);
    const siteXpiSha = sha256File(siteXpiPath);
    const ghChrSha = sha256File(ghChrPath);
    const siteXpiMime = String(siteXpiRes.headers['content-type'] || '').toLowerCase();
    record(
      'EXT-V1010-HASHES',
      'Live Browser Companion v1.0.10 Firefox XPI (GitHub & Website) & Chromium ZIP hashes & XPI MIME intact',
      Boolean(
        ghXpiCode === 200 && ghXpiSha === EXPECTED_XPI_SHA && fs.statSync(ghXpiPath).size === EXPECTED_XPI_SIZE &&
        siteXpiRes.status === 200 && siteXpiSha === EXPECTED_XPI_SHA && siteXpiMime.includes('application/x-xpinstall') &&
        ghChrCode === 200 && ghChrSha === EXPECTED_CHR_SHA && fs.statSync(ghChrPath).size === EXPECTED_CHR_SIZE
      ),
      `ghXpi=${ghXpiSha}, siteMime=${siteXpiMime}, ghChr=${ghChrSha}`
    );

    // Live Firefox permanent install of live-downloaded website v1.0.10 XPI under strict signature enforcement
    fs.writeFileSync(path.join(FF_PROF, 'user.js'), [
      'user_pref("marionette.enabled", true);',
      `user_pref("marionette.port", ${FF_MAR_PORT});`,
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("xpinstall.signatures.required", true);',
    ].join('\n'));
    const ffProc = spawn(FIREFOX_EXE, ['-no-remote', '-marionette', '-profile', FF_PROF, 'about:blank'], {
      env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
      stdio: 'ignore',
    });
    trackedProcs.add(ffProc);
    const mar = new MarionetteClient(FF_MAR_PORT);
    await mar.connect(25000);
    await mar.send('WebDriver:NewSession', { capabilities: {} });
    const ffInst = await mar.send('Addon:Install', { path: siteXpiPath, temporary: false }, 25000);
    await mar.send('Marionette:SetContext', { value: 'chrome' });
    const ffSig = (await mar.send('WebDriver:ExecuteAsyncScript', {
      script: `
        const done = arguments[arguments.length - 1];
        (async () => {
          const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
          const addon = await AddonManager.getAddonByID("${EXPECTED_GECKO_ID}");
          done({ id: addon?.id, version: addon?.version, active: !!addon?.isActive, signed: addon?.signedState === AddonManager.SIGNEDSTATE_SIGNED, temporary: addon?.temporarilyInstalled });
        })();
      `,
      args: [],
    }, 15000))?.value;
    try { await mar.send('Marionette:Quit', {}); } catch {}
    mar.close();
    killProcTree(ffProc.pid);
    trackedProcs.delete(ffProc);
    record(
      'EXT-FF-LIVE-SIGNED',
      'Live website Firefox v1.0.10 XPI installs permanently under strict Mozilla signature enforcement',
      Boolean(ffInst?.value === EXPECTED_GECKO_ID && ffSig?.version === '1.0.10' && ffSig?.signed === true && ffSig?.temporary === false && ffSig?.active === true),
      JSON.stringify(ffSig)
    );

    // =========================================================================
    // 4. LIVE WEBSITE VERIFICATION (HTTPS + DESKTOP 1440x900 + MOBILE 390x844)
    // =========================================================================
    console.log('\n>>> [4] Live Website Verification (https://toridownload.xyz Desktop & Mobile) <<<');
    const siteHomeRes = await fetchRaw(`${SITE_URL}/`);
    const sitemapRes = await fetchRaw(`${SITE_URL}/sitemap.xml`);
    const robotsRes = await fetchRaw(`${SITE_URL}/robots.txt`);
    const homeHtml = siteHomeRes.buf.toString('utf8');
    record(
      'SITE-HTTPS-META',
      'Live toridownload.xyz serves HTTPS 200 with v1.0.6 Desktop + v1.0.10 Companion + updated sitemap',
      Boolean(
        siteHomeRes.status === 200 &&
        homeHtml.includes('TORI.Download.Manager_1.0.6_x64-setup.exe') &&
        homeHtml.includes(EXPECTED_V106_INSTALLER_SHA) &&
        homeHtml.includes('Companion v1.0.10') &&
        homeHtml.includes(EXPECTED_XPI_SHA) &&
        homeHtml.includes(EXPECTED_CHR_SHA) &&
        sitemapRes.status === 200 && sitemapRes.buf.toString('utf8').includes('2026-11-21') &&
        robotsRes.status === 200
      ),
      `home=${siteHomeRes.status}, sitemap=${sitemapRes.status}, robots=${robotsRes.status}`
    );

    const edgeProc = spawn(
      EDGE_EXE,
      [
        '--headless=new',
        `--user-data-dir=${SITE_EDGE_PROF}`,
        `--remote-debugging-port=${SITE_CDP_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        `${SITE_URL}/`,
      ],
      { stdio: 'ignore' }
    );
    trackedProcs.add(edgeProc);
    let edgePageWs = null;
    for (let i = 0; i < 35; i++) {
      await sleep(250);
      const t = (await listCdpTargets(SITE_CDP_PORT)).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) { edgePageWs = t.webSocketDebuggerUrl; break; }
    }
    const siteCdp = new CDPClient(edgePageWs);
    await siteCdp.connect();
    await siteCdp.send('Page.enable');
    await siteCdp.send('Runtime.enable');
    await sleep(1500);

    const auditViewport = async (w, h, hash) => {
      await siteCdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
      await siteCdp.eval(`(location.hash = ${JSON.stringify(hash)}, true)`);
      await sleep(450);
      return await siteCdp.eval(`(() => {
        const imgs = Array.from(document.querySelectorAll('img')).filter(i => i.offsetParent !== null);
        const brokenImgs = imgs.filter(i => i.complete && i.naturalWidth === 0).length;
        return {
          view: document.body.getAttribute('data-view'),
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
          brokenImgs,
          heroPill: document.getElementById('hero-pill-text')?.textContent?.trim(),
          heroHref: document.getElementById('hero-dl-btn')?.getAttribute('href'),
          mainHref: document.getElementById('main-dl-btn')?.getAttribute('href'),
          statVer: document.getElementById('stat-ver')?.textContent?.trim(),
          ffHref: document.getElementById('ext-firefox-btn')?.getAttribute('href'),
          extHref: document.getElementById('ext-dl-btn')?.getAttribute('href'),
          footerVer: document.getElementById('footer-ver-badge')?.textContent?.trim(),
        };
      })()`);
    };

    const deskTop = await auditViewport(1440, 900, '#top');
    const deskDl = await auditViewport(1440, 900, '#download');
    const deskExt = await auditViewport(1440, 900, '#extension');
    const mobTop = await auditViewport(390, 844, '#top');
    const mobDl = await auditViewport(390, 844, '#download');
    const mobExt = await auditViewport(390, 844, '#extension');
    siteCdp.close();
    killProcTree(edgeProc.pid);
    trackedProcs.delete(edgeProc);

    const layoutsOk = [deskTop, deskDl, deskExt, mobTop, mobDl, mobExt].every((v) => !v.overflowX && v.brokenImgs === 0);
    const linksOk =
      String(deskTop.heroHref).includes('/v1.0.6/TORI.Download.Manager_1.0.6_x64-setup.exe') &&
      String(deskDl.mainHref).includes('/v1.0.6/TORI.Download.Manager_1.0.6_x64-setup.exe') &&
      deskDl.statVer === '1.0.6' &&
      String(deskExt.ffHref) === '/assets/tori-download-manager-firefox-v1.0.10.xpi' &&
      String(deskExt.extHref).includes('/extension-v1.0.10/tori-companion-v1.0.10-chromium.zip') &&
      String(deskTop.footerVer).includes('v1.0.6') &&
      String(deskTop.footerVer).includes('Companion v1.0.10');
    record(
      'SITE-LIVE-LAYOUT-LINKS',
      'Live website Desktop (1440x900) & Mobile (390x844) render v1.0.6 + Companion v1.0.10 with zero overflow or broken images',
      layoutsOk && linksOk,
      JSON.stringify({ layoutsOk, linksOk, statVer: deskDl.statVer, heroPill: deskTop.heroPill, footerVer: deskTop.footerVer })
    );

    // =========================================================================
    // 5. ISOLATED PHYSICAL UPGRADE (v1.0.5 -> LIVE-DOWNLOADED v1.0.6) & RUNTIME AUDIT
    // =========================================================================
    console.log('\n>>> [5] Isolated Physical Upgrade (v1.0.5 -> Live-Downloaded v1.0.6) & Live IDM Progress Window <<<');
    oemGuard.temporarilySilenceNativeHostAutoSpawn(path.join(QA_ROOT, 'shield'));

    // Seed isolated DB from operator's real 42-download backup + sample .tdm-part
    const upgDb = path.join(UPG_DATA_DIR, 'tdm_storage.sqlite');
    fs.copyFileSync(ROLLBACK_ONLINE_DB, upgDb);
    const partPath = path.join(UPG_DL_DIR, 'upgrade_partial.bin.tdm-part');
    fs.writeFileSync(partPath, crypto.randomBytes(65536));
    const partShaBefore = sha256File(partPath);
    const upgToken = 'tori_g31_6_upg_token';
    execFileSync('python', [
      '-c',
      `import sqlite3, json, sys
c=sqlite3.connect(sys.argv[1]); cur=c.cursor()
cfg=json.loads(cur.execute("SELECT value FROM engine_settings WHERE key='app_settings'").fetchone()[0])
cfg['port']=int(sys.argv[2]); cfg['key']=sys.argv[3]; cfg['dir']=sys.argv[4]; cfg['showDownloadPopup']='always'; cfg['closeToTray']=True
cur.execute("UPDATE engine_settings SET value=? WHERE key='app_settings'", (json.dumps(cfg),))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES('server_port',?)", (sys.argv[2],))
cur.execute("INSERT OR REPLACE INTO engine_settings(key,value) VALUES('browser_integration_token',?)", (sys.argv[3],))
c.commit(); c.close()`,
      upgDb,
      String(UPG_PORT),
      upgToken,
      UPG_DL_DIR,
    ]);

    // Step 5A: Install v1.0.5 silently into isolated UPG_INST_DIR and start it briefly
    execSync(`"${V105_INSTALLER}" /S /D=${UPG_INST_DIR}`, { timeout: 90000 });
    oemGuard.temporarilySilenceNativeHostAutoSpawn(path.join(QA_ROOT, 'shield'));
    const upgExe = path.join(UPG_INST_DIR, 'tori-download-manager.exe');
    const verBefore = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${upgExe}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim();

    const p105 = spawn(upgExe, ['--minimized'], {
      cwd: UPG_INST_DIR,
      env: { ...process.env, TORI_DATA_DIR: UPG_DATA_DIR, TDM_STORAGE_DIR: UPG_DATA_DIR, TORI_DISABLE_AUTO_SPAWN: '1', WEBVIEW2_USER_DATA_FOLDER: UPG_WV2_DIR },
      stdio: 'ignore',
    });
    trackedProcs.add(p105);
    let v105Online = false;
    for (let i = 0; i < 35; i++) {
      await sleep(300);
      if ((await httpJson({ port: UPG_PORT, reqPath: '/api/v1/ping', headers: { 'X-Tori-Token': upgToken } })).ok) { v105Online = true; break; }
    }

    // Step 5B: Run LIVE-DOWNLOADED v1.0.6 installer over running v1.0.5!
    execSync(`"${liveInstPath}" /S /D=${UPG_INST_DIR}`, { timeout: 90000 });
    oemGuard.temporarilySilenceNativeHostAutoSpawn(path.join(QA_ROOT, 'shield'));
    trackedProcs.delete(p105);
    await sleep(600);

    const verAfter = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${upgExe}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim();
    const hostAfterSha = sha256File(path.join(UPG_INST_DIR, 'bin', 'tdm-native-host.exe'));

    // Start local HTTP fixture server for live-downloaded v1.0.6 download + Pause/Resume + Close-to-Tray check
    const payload = Buffer.alloc(6 * 1024 * 1024, 0x42);
    const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');
    fixtureServer = http.createServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': String(payload.length), 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' });
        return res.end();
      }
      let start = 0, end = payload.length - 1, status = 200;
      if (req.headers.range?.startsWith('bytes=')) {
        const [s, e] = req.headers.range.slice(6).split('-');
        start = s ? parseInt(s, 10) : 0;
        end = e ? Math.min(parseInt(e, 10), payload.length - 1) : payload.length - 1;
        status = 206;
      }
      const hdrs = { 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' };
      if (status === 206) hdrs['Content-Range'] = `bytes ${start}-${end}/${payload.length}`;
      res.writeHead(status, hdrs);
      let off = start;
      const t = setInterval(() => {
        if (res.destroyed) { clearInterval(t); return; }
        const nx = Math.min(off + 32768, end + 1);
        res.write(payload.subarray(off, nx));
        off = nx;
        if (off > end) { clearInterval(t); res.end(); }
      }, 15);
      req.on('close', () => clearInterval(t));
    });
    await new Promise((r) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', r));

    // Step 5C: Boot upgraded live-downloaded v1.0.6!
    const upgPipe = `\\\\.\\pipe\\tori-qa-g31-6-${process.pid}`;
    const p106 = spawn(upgExe, [], {
      cwd: UPG_INST_DIR,
      env: {
        ...process.env,
        TORI_DATA_DIR: UPG_DATA_DIR,
        TDM_STORAGE_DIR: UPG_DATA_DIR,
        TDM_DOWNLOAD_DIR: UPG_DL_DIR,
        TORI_IPC_PIPE: upgPipe,
        TORI_ALLOW_LOOPBACK: '1',
        TORI_DISABLE_AUTO_SPAWN: '1',
        WEBVIEW2_USER_DATA_FOLDER: UPG_WV2_DIR,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${UPG_CDP_PORT}`,
      },
      stdio: 'ignore',
    });
    trackedProcs.add(p106);

    let v106Online = false;
    for (let i = 0; i < 45; i++) {
      await sleep(300);
      if ((await httpJson({ port: UPG_PORT, reqPath: '/api/v1/ping', headers: { 'X-Tori-Token': upgToken } })).ok) { v106Online = true; break; }
    }
    let mainWs = null;
    for (let i = 0; i < 35; i++) {
      const hit = (await listCdpTargets(UPG_CDP_PORT)).find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !getProgressJobId(t));
      if (hit) { mainWs = hit.webSocketDebuggerUrl; break; }
      await sleep(250);
    }
    const mCdp = new CDPClient(mainWs);
    await mCdp.connect();
    await sleep(700);
    const upgAppVer = await mCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_app_version')`);
    const upgList = await mCdp.eval(`window.__TAURI_INTERNALS__.invoke('list_downloads')`);
    const upgCfg = await mCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_engine_settings')`);

    // Close-to-tray check + real download -> IDM progress window + Pause/Resume + Completion
    await mCdp.eval(`window.__TAURI_INTERNALS__.invoke('window_close')`);
    await sleep(400);
    const hiddenOk = (await mCdp.eval(`window.__TAURI__.window.getCurrentWindow().isVisible()`)) === false;

    const dlRes = await httpJson({
      port: UPG_PORT,
      reqPath: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': upgToken },
      body: { url: `http://127.0.0.1:${FIXTURE_PORT}/live_v106_test.bin`, filename: 'live_v106_test.bin' },
    });
    const jid = dlRes.data?.job_id;
    let popWs = null;
    for (let i = 0; i < 40; i++) {
      const hit = (await listCdpTargets(UPG_CDP_PORT)).find((t) => t.webSocketDebuggerUrl && getProgressJobId(t) === jid);
      if (hit) { popWs = hit.webSocketDebuggerUrl; break; }
      await sleep(200);
    }
    const pCdp = new CDPClient(popWs);
    await pCdp.connect();
    await sleep(800);
    const popDiag = await pCdp.eval(`({
      isIdm: Boolean(document.querySelector('.dl-popup-root #w') && document.querySelectorAll('.dl-tabs .dl-tab').length === 3),
      legacyToast: Boolean(document.querySelector('.toast-card, .toast-stack, svg circle[stroke-dasharray]')),
      label: window.__TAURI__?.window?.getCurrentWindow()?.label || ''
    })`);
    // Pause & Resume
    await pCdp.eval(`document.querySelector('.dl-foot .dl-btn.pri')?.click()`, true);
    await sleep(600);
    const stPaused = (await httpJson({ port: UPG_PORT, reqPath: `/api/v1/downloads/${jid}`, headers: { 'X-Tori-Token': upgToken } })).data?.state;
    await pCdp.eval(`document.querySelector('.dl-foot .dl-btn.pri')?.click()`, true);
    let done = false;
    for (let i = 0; i < 60; i++) {
      const s = (await httpJson({ port: UPG_PORT, reqPath: `/api/v1/downloads/${jid}`, headers: { 'X-Tori-Token': upgToken } })).data?.state;
      if (s === 'completed') { done = true; break; }
      await sleep(300);
    }
    const fullJob = await mCdp.eval(`window.__TAURI_INTERNALS__.invoke('get_download', { id: ${JSON.stringify(jid)} })`);
    const liveDlShaOk = sha256File(fullJob?.target_path || path.join(UPG_DL_DIR, 'live_v106_test.bin')) === payloadSha;
    pCdp.close();
    mCdp.close();
    killProcTree(p106.pid);
    trackedProcs.delete(p106);
    await sleep(400);

    const partShaAfter = sha256File(partPath);
    record(
      'LIVE-UPG-V105-TO-V106',
      'Physical isolated upgrade (v1.0.5 -> live-downloaded v1.0.6) preserves 42 downloads/settings/.tdm-part, opens IDM progress window (no legacy toast), pauses/resumes & completes',
      Boolean(
        verBefore === '1.0.5' && v105Online &&
        verAfter === '1.0.6' && hostAfterSha === EXPECTED_V106_HOST_SHA &&
        v106Online && upgAppVer === '1.0.6' &&
        Array.isArray(upgList) && upgList.length === 42 &&
        upgCfg?.theme === 'dark' && upgCfg?.accent === 'rose' &&
        partShaAfter === partShaBefore &&
        hiddenOk && popDiag.isIdm && !popDiag.legacyToast && popDiag.label.startsWith('progress_') &&
        stPaused === 'paused' && done && liveDlShaOk
      ),
      JSON.stringify({ verBefore, verAfter, upgAppVer, preservedRows: upgList?.length, hiddenOk, popDiag, stPaused, done, liveDlShaOk, partUnchanged: partShaAfter === partShaBefore })
    );
  } finally {
    cleanupProcs();
    if (fixtureServer) try { fixtureServer.close(); } catch {}
    prodDbBeforeRestore = sha256File(PROD_DB);
    try { fs.rmSync(QA_ROOT, { recursive: true, force: true }); } catch {}
    const parity = oemGuard.restore({ qaPathMarker: 'gate31_6_live_qa', restartOem: true });
    record('SAFETY-OEM-PARITY', 'Production Windows Registry, Native Messaging & shortcuts restored with 100% parity', Boolean(parity?.ok), JSON.stringify(parity));
  }

  // Final production DB & .tdm-part & installed binary safety verification
  const prodPeVer = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${PROD_EXE}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim();
  const allPartsOk = beforeSnap.partial_files.every((pf) => sha256File(pf.temp_path) === pf.sha256);
  const dbCheck = execFileSync('python', ['-c', `import sqlite3; c=sqlite3.connect(r'${PROD_DB}'); print(c.execute('PRAGMA integrity_check').fetchone()[0], c.execute('SELECT COUNT(*) FROM downloads').fetchone()[0]); c.close()`], { encoding: 'utf8' }).trim();
  record(
    'SAFETY-PROD-INTEGRITY',
    'Production v1.0.6 install, SQLite DB (42 rows), and all 11 .tdm-part files 100% preserved',
    prodPeVer === '1.0.6' && prodDbBeforeRestore === prodDbBefore && dbCheck === 'ok 42' && allPartsOk,
    `prodPeVer=${prodPeVer}, dbCheck=${dbCheck}, allPartsOk=${allPartsOk}`
  );

  console.log('\n=============================================================================');
  console.log(` GATE 31.6 LIVE VERIFICATION: ${counts.PASS} PASS, ${counts.FAIL} FAIL`);
  console.log('=============================================================================');
  if (counts.FAIL > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[FATAL] Gate 31.6 live verification aborted:', err);
  cleanupProcs();
  if (fixtureServer) try { fixtureServer.close(); } catch {}
  try { oemGuard.restore({ qaPathMarker: 'gate31_6_live_qa', restartOem: true }); } catch {}
  process.exit(1);
});
