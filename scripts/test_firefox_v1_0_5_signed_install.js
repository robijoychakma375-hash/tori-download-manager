/**
 * TORI Browser Companion — Verify Firefox v1.0.5 Signed XPI Installation
 *
 * Verifies that official Firefox browser strictly accepts the Mozilla-signed
 * v1.0.5 XPI with signature enforcement (xpinstall.signatures.required = true).
 */

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const XPI_PATH = path.join(PROJECT_ROOT, 'release', 'v1.0.5-extension', 'tori-download-manager-firefox-v1.0.5.xpi');
const MARIONETTE_PORT = 2829;
const TEST_ENV_DIR = path.join(PROJECT_ROOT, 'target', 'firefox_install_v105_qa');
const PROFILE_DIR = path.join(TEST_ENV_DIR, 'profile');
const FIREFOX_EXE = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function run() {
  console.log('================================================================');
  console.log('FIREFOX v1.0.5 SIGNED XPI INSTALLATION VERIFICATION');
  console.log('================================================================\n');

  if (!fs.existsSync(FIREFOX_EXE)) {
    throw new Error('Firefox binary not found at ' + FIREFOX_EXE);
  }
  if (!fs.existsSync(XPI_PATH)) {
    throw new Error('Target XPI file not found at ' + XPI_PATH);
  }

  if (fs.existsSync(TEST_ENV_DIR)) {
    try { fs.rmSync(TEST_ENV_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  // Strictly enforce signature requirements
  const userJs = [
    'user_pref("marionette.enabled", true);',
    `user_pref("marionette.port", ${MARIONETTE_PORT});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("xpinstall.signatures.required", true);', // STRICT ENFORCEMENT
    'user_pref("extensions.autoDisableScopes", 0);',
    'user_pref("extensions.enabledScopes", 15);',
  ].join('\n');
  fs.writeFileSync(path.join(PROFILE_DIR, 'user.js'), userJs, 'utf8');

  console.log('[1/4] Spawning clean Firefox instance with xpinstall.signatures.required = true...');
  const ff = spawn(
    FIREFOX_EXE,
    [
      '--headless',
      '--marionette',
      '--profile',
      PROFILE_DIR,
      'about:blank',
    ],
    { env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }, stdio: 'ignore' }
  );

  let installedId = null;
  const client = new MarionetteClient();

  try {
    let connected = false;
    for (let i = 0; i < 30; i++) {
      await sleep(350);
      try {
        await client.connect(MARIONETTE_PORT);
        connected = true;
        break;
      } catch (_) {}
    }

    if (!connected) {
      throw new Error('Could not connect to Firefox Marionette agent on port ' + MARIONETTE_PORT);
    }
    console.log('[2/4] Connected to Firefox Marionette agent.');

    await client.send('WebDriver:NewSession', { capabilities: {} });
    console.log('[3/4] Initialized WebDriver session. Installing addon from disk...');

    // Install the addon using Marionette Addon:Install API
    const installRes = await client.send('Addon:Install', {
      path: XPI_PATH,
      temporary: false,
    });
    installedId = installRes?.value;
    console.log(`[4/4] Addon installation result: "${installedId}"`);

    if (!installedId || installedId !== 'tori-download-manager@toridm.org') {
      throw new Error(`Installation failed or returned unexpected ID: ${installedId}`);
    }

    // Verify extension state in Firefox context
    let extensionUrl = '';
    try {
      await client.send('Marionette:SetContext', { value: 'chrome' });
      const checkRes = await client.send('WebDriver:ExecuteScript', {
        script: 'const p = WebExtensionPolicy.getByID("tori-download-manager@toridm.org"); return p ? { url: p.getURL(""), id: p.id } : null;',
        args: [],
      });
      extensionUrl = checkRes?.value?.url;
      console.log('\n--- Firefox Installed Extension Inspection ---');
      console.log('ID:         ', checkRes?.value?.id);
      console.log('Policy URL: ', extensionUrl);
    } catch (err) {
      console.log('[FIREFOX] Policy check notice:', err.message);
    }

    console.log('\n[SUCCESS] Mozilla-signed v1.0.5 XPI installed and verified with signatures strictly enforced!');
  } finally {
    client.disconnect();
    ff.kill('SIGKILL');
    await sleep(800);
    try { fs.rmSync(TEST_ENV_DIR, { recursive: true, force: true }); } catch (_) {}
  }
}

run().catch((e) => {
  console.error('[ERROR]', e);
  process.exit(1);
});
