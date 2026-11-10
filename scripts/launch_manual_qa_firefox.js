/**
 * TORI Download Manager v1.0.1 — Manual QA Launcher
 * 
 * Launches:
 * 1. TORI v1.0.1 Desktop Engine on isolated port 19860 with isolated SQLite database and token.
 * 2. Mozilla Firefox in an isolated test profile with Marionette enabled.
 * 3. Installs unpacked Firefox extension v1.0.2 (tori-download-manager@toridm.org).
 * 4. Pairs extension via chrome.storage.local to isolated TORI engine.
 * 5. Opens https://www.dailymotion.com/video/xbvab2y.
 * 6. Leaves both TORI and Firefox open for physical manual testing.
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DESKTOP_PORT = 19860;
const MARIONETTE_PORT = 2828;

const ISOLATED_ENV_DIR = path.join(PROJECT_ROOT, 'target', 'manual_qa_env');
const ISOLATED_DATA_DIR = path.join(ISOLATED_ENV_DIR, 'data');
const ISOLATED_DOWNLOADS_DIR = path.join(ISOLATED_ENV_DIR, 'downloads');
const ISOLATED_FF_PROFILE = path.join(ISOLATED_ENV_DIR, 'firefox_profile');
const ISOLATED_WEBVIEW2_DIR = path.join(ISOLATED_ENV_DIR, 'webview2');

const TEST_API_TOKEN = 'tori_manual_qa_token_' + crypto.randomBytes(8).toString('hex');
const DAILYMOTION_URL = 'https://www.dailymotion.com/video/xbvab2y';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeHttpRequest({ host = '127.0.0.1', port, path: reqPath, method = 'GET', headers = {}, body = null, timeout = 10000 }) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };
    if (payload && !reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
    if (payload) reqHeaders['Content-Length'] = Buffer.byteLength(payload);

    const req = http.request(
      { hostname: host, port, path: reqPath, method, headers: reqHeaders, timeout },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(raw); } catch (_) { data = raw; }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`HTTP request timed out after ${timeout}ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function seedDatabase(dbDir, downloadsDir, port, token) {
  const dbFile = path.join(dbDir, 'tdm_storage.sqlite');
  const py = `
import sqlite3, json
conn = sqlite3.connect(r'${dbFile.replace(/\\/g, '\\\\')}')
cur = conn.cursor()
cur.execute('CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
cur.execute('INSERT OR REPLACE INTO engine_settings VALUES (?, ?)', ('browser_integration_token', '${token}'))
app_settings = {'dir': r'${downloadsDir.replace(/\\/g, '\\\\')}', 'port': ${port}}
cur.execute('INSERT OR REPLACE INTO engine_settings VALUES (?, ?)', ('app_settings', json.dumps(app_settings)))
conn.commit()
conn.close()
`;
  const seedPy = path.join(dbDir, 'seed.py');
  fs.writeFileSync(seedPy, py);
  execSync(`python "${seedPy}"`);
}

class MarionetteClient {
  constructor() {
    this.socket = null;
    this.msgId = 1;
    this.buffer = '';
    this.pending = new Map();
  }

  connect(port = MARIONETTE_PORT) {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(port, '127.0.0.1');
      this.socket.on('data', (data) => {
        this.buffer += data.toString('utf8');
        this.processBuffer(resolve);
      });
      this.socket.on('error', reject);
    });
  }

  processBuffer(initialResolve) {
    while (true) {
      const colonIdx = this.buffer.indexOf(':');
      if (colonIdx === -1) break;
      const lenStr = this.buffer.slice(0, colonIdx);
      const len = parseInt(lenStr, 10);
      if (isNaN(len)) {
        this.buffer = '';
        break;
      }
      if (this.buffer.length < colonIdx + 1 + len) break;
      const payload = this.buffer.slice(colonIdx + 1, colonIdx + 1 + len);
      this.buffer = this.buffer.slice(colonIdx + 1 + len);

      try {
        const parsed = JSON.parse(payload);
        if (parsed.marionetteProtocol !== undefined && initialResolve) {
          initialResolve();
        } else if (Array.isArray(parsed) && parsed[0] === 1) {
          const reqId = parsed[1];
          const error = parsed[2];
          const result = parsed[3];
          const cb = this.pending.get(reqId);
          if (cb) {
            this.pending.delete(reqId);
            if (error) cb.reject(new Error(JSON.stringify(error)));
            else cb.resolve(result);
          }
        }
      } catch (err) {
        console.error('[MARIONETTE] JSON parse error:', err.message);
      }
    }
  }

  send(name, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify([0, id, name, params]);
      const frame = `${Buffer.byteLength(msg, 'utf8')}:${msg}`;
      this.socket.write(frame);
    });
  }

  disconnect() {
    if (this.socket) {
      try { this.socket.destroy(); } catch (_) {}
      this.socket = null;
    }
  }
}

async function main() {
  console.log('================================================================');
  console.log(' TORI Download Manager v1.0.1 — Manual QA Environment Launcher');
  console.log('================================================================\n');

  // 1. Prepare isolated folders
  [ISOLATED_DATA_DIR, ISOLATED_DOWNLOADS_DIR, ISOLATED_FF_PROFILE, ISOLATED_WEBVIEW2_DIR].forEach((d) => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  const desktopExe = path.join(PROJECT_ROOT, 'target', 'release', 'tori-download-manager.exe');
  if (!fs.existsSync(desktopExe)) {
    throw new Error(`Desktop executable missing at ${desktopExe}`);
  }

  // 2. Check extension manifest version
  const ffManifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'extension', 'firefox', 'manifest.json'), 'utf8'));
  console.log(`[EXTENSION] Loaded Firefox manifest version: ${ffManifest.version}`);
  if (ffManifest.version !== '1.0.2') {
    throw new Error(`Expected extension version 1.0.2, but found: ${ffManifest.version}`);
  }

  // 3. Seed isolated database
  console.log(`[DATABASE] Seeding isolated SQLite database with port ${DESKTOP_PORT}...`);
  seedDatabase(ISOLATED_DATA_DIR, ISOLATED_DOWNLOADS_DIR, DESKTOP_PORT, TEST_API_TOKEN);

  // 4. Spawn TORI Desktop Process (visible window)
  console.log(`[DESKTOP] Launching TORI Desktop Engine v1.0.1 on port ${DESKTOP_PORT}...`);
  const desktopEnv = {
    ...process.env,
    TORI_DATA_DIR: ISOLATED_DATA_DIR,
    TORI_ALLOW_LOOPBACK: '1',
    WEBVIEW2_USER_DATA_FOLDER: ISOLATED_WEBVIEW2_DIR,
  };

  const desktopProc = spawn(desktopExe, [], {
    env: desktopEnv,
    detached: true,
    stdio: 'ignore',
  });
  desktopProc.unref();
  console.log(`[DESKTOP] Process spawned (PID: ${desktopProc.pid})`);

  // Wait for desktop ping
  let desktopReady = false;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try {
      const ping = await makeHttpRequest({ port: DESKTOP_PORT, path: '/api/v1/ping' });
      if (ping.status === 200 && ping.data?.status === 'ok') {
        desktopReady = true;
        break;
      }
    } catch (_) {}
  }
  if (!desktopReady) {
    throw new Error(`TORI Desktop failed to respond on http://127.0.0.1:${DESKTOP_PORT}`);
  }
  console.log(`[DESKTOP] Engine active and responding on http://127.0.0.1:${DESKTOP_PORT}`);

  // 5. Setup Firefox preferences
  const ffPrefs = [
    'user_pref("marionette.enabled", true);',
    'user_pref("marionette.port", 2828);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("extensions.autoDisableScopes", 0);',
    'user_pref("xpinstall.signatures.required", false);',
    'user_pref("browser.download.folderList", 2);',
    `user_pref("browser.download.dir", "${ISOLATED_DOWNLOADS_DIR.replace(/\\/g, '\\\\')}");`,
    'user_pref("browser.download.useDownloadDir", true);',
  ].join('\n');
  fs.writeFileSync(path.join(ISOLATED_FF_PROFILE, 'user.js'), ffPrefs);

  // 6. Launch Firefox
  console.log('[FIREFOX] Launching Firefox in isolated test profile...');
  const ffExe = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
  const ffProc = spawn(ffExe, [
    '-no-remote',
    '-marionette',
    '-profile', ISOLATED_FF_PROFILE,
    DAILYMOTION_URL,
  ], {
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    detached: true,
    stdio: 'ignore',
  });
  ffProc.unref();
  console.log(`[FIREFOX] Process spawned (PID: ${ffProc.pid})`);

  await sleep(3000);

  // 7. Connect Marionette
  console.log('[MARIONETTE] Connecting to Firefox on port 2828...');
  const marionette = new MarionetteClient();
  await marionette.connect(MARIONETTE_PORT);
  console.log('[MARIONETTE] Connected');

  await marionette.send('WebDriver:NewSession', {});

  // 8. Install extension v1.0.2 as temporary add-on
  console.log('[FIREFOX] Installing unpacked Firefox extension v1.0.2 from extension/firefox...');
  const extInstallRes = await marionette.send('Addon:Install', {
    path: path.resolve('extension/firefox'),
    temporary: true,
  });
  const geckoId = extInstallRes.value;
  console.log(`[FIREFOX] Extension loaded with Gecko ID: ${geckoId}`);

  // 9. Query WebExtension base URL
  await marionette.send('Marionette:SetContext', { value: 'chrome' });
  const chromePolicyRes = await marionette.send('WebDriver:ExecuteScript', {
    script: 'const policy = WebExtensionPolicy.getByID("tori-download-manager@toridm.org"); return policy ? policy.getURL("") : "";',
    args: [],
  });
  const mozExtUrl = chromePolicyRes.value;
  console.log(`[FIREFOX] Extension origin: ${mozExtUrl}`);

  // 10. Open Options page to pair extension with isolated TORI desktop
  console.log('[FIREFOX] Pairing extension to TORI Desktop Engine...');
  await marionette.send('WebDriver:ExecuteScript', {
    script: `
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      win.gBrowser.addTrustedTab("${mozExtUrl}options/options.html");
    `,
    args: [],
  });
  await sleep(1500);

  // Switch to options tab and pair
  await marionette.send('Marionette:SetContext', { value: 'content' });
  const winHandles = await marionette.send('WebDriver:GetWindowHandles', {});
  let optionsHandle = null;
  let dailymotionHandle = null;

  for (const h of winHandles) {
    await marionette.send('WebDriver:SwitchToWindow', { handle: h });
    const cur = await marionette.send('WebDriver:GetCurrentURL', {});
    if (cur.value && cur.value.includes('options/options.html')) {
      optionsHandle = h;
    } else if (cur.value && cur.value.includes('dailymotion.com')) {
      dailymotionHandle = h;
    }
  }

  if (optionsHandle) {
    await marionette.send('WebDriver:SwitchToWindow', { handle: optionsHandle });
    const pairRes = await marionette.send('WebDriver:ExecuteAsyncScript', {
      script: `
        const done = arguments[arguments.length - 1];
        chrome.storage.local.set({
          tori_settings: {
            port: ${DESKTOP_PORT},
            key: '${TEST_API_TOKEN}',
            cap: true,
            min: 0,
            types: ['zip', 'rar', '7z', 'iso', 'exe', 'dmg', 'pdf', 'mp4', 'mp3', 'mkv']
          }
        }, () => {
          fetch('http://127.0.0.1:${DESKTOP_PORT}/api/v1/status', {
            headers: { 'X-Tori-Token': '${TEST_API_TOKEN}' }
          }).then(r => r.json()).then(data => done({ ok: true, data })).catch(e => done({ ok: false, err: e.message }));
        });
      `,
      args: [],
    });
    console.log('[FIREFOX] Extension pairing result:', pairRes.value);
  }

  // Switch focus back to Dailymotion tab so the user lands on the video directly
  if (dailymotionHandle) {
    console.log('[FIREFOX] Switching active tab back to Dailymotion video...');
    await marionette.send('WebDriver:SwitchToWindow', { handle: dailymotionHandle });
  }

  // Close Marionette connection cleanly, leaving Firefox open
  marionette.disconnect();
  console.log('[MARIONETTE] Disconnected. Firefox and TORI Desktop remain active for manual testing.');

  console.log('\n================================================================');
  console.log(' MANUAL TESTING ENVIRONMENT READY');
  console.log('================================================================');
  console.log(`- Extension Version:   1.0.2 (tori-download-manager@toridm.org)`);
  console.log(`- Firefox Profile:     ${ISOLATED_FF_PROFILE}`);
  console.log(`- TORI Desktop Engine: http://127.0.0.1:${DESKTOP_PORT} (PID: ${desktopProc.pid})`);
  console.log(`- Authentication:      X-Tori-Token: ${TEST_API_TOKEN}`);
  console.log(`- Test Page URL:       ${DAILYMOTION_URL}`);
  console.log(`- Status:              READY FOR MANUAL TESTING`);
  console.log('================================================================\n');

  // Handle termination gracefully
  const cleanup = () => {
    console.log('[CLEANUP] Stopping Firefox and TORI Desktop...');
    try { desktopProc.kill(); } catch (_) {}
    try { ffProc.kill(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  console.log('[DAEMON] Holding Firefox and TORI Desktop processes active for physical manual testing.');
  console.log('[DAEMON] Background runner is active.');

  // Keep process alive indefinitely until killed
  setInterval(() => {}, 60000);
}

main().catch((err) => {
  console.error('[ERROR]', err);
  process.exit(1);
});
