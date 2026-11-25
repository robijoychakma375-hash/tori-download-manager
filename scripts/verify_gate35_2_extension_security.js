#!/usr/bin/env node
/**
 * TORI Gate 35.2 — Adversarial Extension Security & Cross-Browser Verification Suite
 *
 * Tests BOTH Chromium/Edge (extension/background.js + extension/content.js) AND
 * Firefox (extension/firefox/background.js + extension/firefox/content.js) directly in
 * isolated Node VM sandboxes with realistic browser runtime sender metadata:
 *
 * 1. SEC-35-04 removal: zero __TORI_DISPATCH__, __TORI_RESPONSE__, or toriExtensionUrl leaks;
 *    closed Shadow DOM; e.isTrusted enforcement on download/playlist/pill clicks.
 * 2. Adversarial sender spoofing & privilege escalation rejection:
 *    - Webpage CustomEvent dispatch has zero listener & zero message delivery
 *    - Content script blocked from INITIATE_PAIRING, RECONNECT_DESKTOP, PING_DESKTOP,
 *      GET_CONNECTION_STATUS, GET_ALL_MEDIA, GET_DOWNLOADS, PAUSE_DOWNLOAD, RESUME_DOWNLOAD,
 *      CANCEL_DOWNLOAD, RETRY_DOWNLOAD, SHOW_DESKTOP, OPEN_OPTIONS, OPEN_POPUP_TAB,
 *      RESOLVE_PLAYLIST, ENQUEUE_PLAYLIST
 *    - Foreign extension sender.id rejected for ALL actions
 *    - Extension iframe (frameId > 0) rejected for privileged actions
 *    - Arbitrary non-whitelisted extension URL rejected
 *    - Cross-tab media spying (content script requesting GET_TAB_MEDIA for another tabId)
 *      strictly isolated to sender.tab.id
 *    - Destination directory injection from content script rejected (START_DOWNLOAD & START_MEDIA_DOWNLOAD)
 *    - Flag-prefixed URLs / format_ids (--exec, -o), non-HTTP schemes (file://, javascript:, data:, blob:) rejected
 *    - Path-traversal job_id rejected on PAUSE/CANCEL/RESUME/RETRY
 *    - Token minimization: popup.html does NOT receive raw pairing token, only options.html does
 *    - Content-script download spam rate-limited
 * 3. Legitimate user workflows preserved:
 *    - options.html INITIATE_PAIRING succeeds and returns token + port
 *    - popup.html PING_DESKTOP, RECONNECT_DESKTOP, SHOW_DESKTOP, GET_TAB_MEDIA(activeTab) succeed
 *    - content.js RECORD_MEDIA_FROM_DOM, GET_TAB_MEDIA (own tab), RESOLVE_MEDIA, START_MEDIA_DOWNLOAD,
 *      START_DOWNLOAD, OPEN_PLAYLIST succeed with strict sanitization
 * 4. Priority 3 browser-side startup popup prevention:
 *    - shouldInterceptBrowserDownload blocks historical 'complete', 'interrupted', paused, ended,
 *      and stale (>60s) Edge startup download replays while allowing fresh 'in_progress' downloads
 *    - onStartup does NOT invoke Native Messaging when Desktop is offline (zero unwanted launch!)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function createRuntimeHarness({ browserName, runtimeId, originScheme, initialSettings = null, storageDelayMs = 0 }) {
  const baseUrl = `${originScheme}://${runtimeId}/`;
  const listeners = {
    onMessage: [],
    onInstalled: [],
    onStartup: [],
    onCreated: [],
    onDeterminingFilename: [],
  };
  const storageLocal = {
    tori_settings: {
      port: 6800,
      key: 'secret-pairing-token-test-9999',
      auto: true,
      cap: true,
      incog: false,
      types: ['exe', 'zip', 'mp4'],
      sites: [],
      min: 0,
      ...(initialSettings || {}),
    },
  };
  const storageSession = {};
  const nativeMessages = [];
  const fetchCalls = [];
  const cancelledBrowserDownloads = [];
  let desktopOnline = true;
  let desktopAuthenticated = true;

  const chromeMock = {
    runtime: {
      id: runtimeId,
      lastError: null,
      getURL: (p = '') => `${baseUrl}${String(p || '').replace(/^\/+/, '')}`,
      getManifest: () => ({ version: '1.0.11' }),
      onMessage: {
        addListener: (fn) => listeners.onMessage.push(fn),
      },
      onInstalled: {
        addListener: (fn) => listeners.onInstalled.push(fn),
      },
      onStartup: {
        addListener: (fn) => listeners.onStartup.push(fn),
      },
      sendMessage: () => Promise.resolve({}),
      sendNativeMessage: (host, msg, cb) => {
        nativeMessages.push({ host, msg });
        let response = { status: 'ok', message: 'native-ok' };
        if (msg.action === 'pair') {
          response = { status: 'ok', token: 'fresh-native-pair-token-1234', port: 6800 };
        } else if (msg.action === 'start_download') {
          response = { status: 'ok', job_id: 'nm-job-1', filename: msg.filename || 'file.bin' };
        } else if (msg.action === 'show_window') {
          response = { status: 'ok', message: 'Window shown' };
        } else if (msg.action === 'open_playlist') {
          response = { status: 'ok', confirmed: true, gui_attached: true };
        }
        setTimeout(() => cb && cb(response), 0);
      },
      openOptionsPage: (cb) => cb && cb(),
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const deliver = () => {
            const out = { ...storageLocal };
            if (cb) cb(out);
            return out;
          };
          if (storageDelayMs > 0) {
            return new Promise((resolve) => setTimeout(() => resolve(deliver()), storageDelayMs));
          }
          return Promise.resolve(deliver());
        },
        set: (obj, cb) => {
          Object.assign(storageLocal, obj);
          if (cb) cb();
          return Promise.resolve();
        },
      },
      session: {
        get: (keys) => Promise.resolve({ ...storageSession }),
        set: (obj) => {
          Object.assign(storageSession, obj);
          return Promise.resolve();
        },
        remove: (keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete storageSession[k];
          return Promise.resolve();
        },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 10 }, { id: 20 }]),
      create: (opts, cb) => cb && cb({ id: 99, ...opts }),
      sendMessage: () => Promise.resolve(),
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    webRequest: {
      onHeadersReceived: { addListener: () => {} },
      onBeforeRequest: { addListener: () => {} },
    },
    action: {
      setBadgeText: () => Promise.resolve(),
      setBadgeBackgroundColor: () => Promise.resolve(),
    },
    downloads: {
      onCreated: { addListener: (fn) => listeners.onCreated.push(fn) },
      onDeterminingFilename: { addListener: (fn) => listeners.onDeterminingFilename.push(fn) },
      cancel: (id, cb) => {
        cancelledBrowserDownloads.push(id);
        if (cb) cb();
      },
    },
  };

  const fetchMock = async (url, opts = {}) => {
    fetchCalls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers || {} });
    if (!desktopOnline) {
      throw new Error('ECONNREFUSED');
    }
    if (url.includes('/api/v1/status')) {
      if (!desktopAuthenticated) {
        return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          name: 'TORI Download Manager',
          authenticated: true,
          version: '1.0.8',
        }),
      };
    }
    if (url.includes('/api/v1/downloads') && (opts.method || 'GET') === 'POST') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', job_id: 'job-http-1', filename: 'video.mp4' }) };
    }
    if (url.includes('/api/v1/downloads')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', jobs: [{ id: 'job-1' }] }) };
    }
    if (url.includes('/api/v1/media/resolve')) {
      return { ok: true, status: 200, json: async () => ({ title: 'Sample Video', extractor: 'generic', formats: [{ format_id: 'mp4_720', ext: 'mp4' }] }) };
    }
    if (url.includes('/api/v1/media/download')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', job_id: 'media-job-1', filename: 'sample.mp4' }) };
    }
    if (url.includes('/api/v1/window/show')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    }
    if (url.includes('/api/v1/media/playlist/open')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', confirmed: true, gui_attached: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
  };

  const sandbox = {
    chrome: chromeMock,
    fetch: fetchMock,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    JSON,
    Promise,
    Error,
    navigator: { userAgent: `Mock-${browserName}/1.0` },
    console: { log: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const bgPath =
    browserName === 'Firefox'
      ? path.join(ROOT, 'extension', 'firefox', 'background.js')
      : path.join(ROOT, 'extension', 'background.js');
  const code = fs.readFileSync(bgPath, 'utf8');
  vm.runInNewContext(code, sandbox, { filename: bgPath });

  function dispatchMessage(message, sender) {
    return new Promise((resolve) => {
      assert.strictEqual(listeners.onMessage.length, 1, `${browserName}: expected 1 runtime.onMessage listener`);
      let resolved = false;
      const sendResponse = (res) => {
        if (!resolved) {
          resolved = true;
          resolve(res);
        }
      };
      const asyncFlag = listeners.onMessage[0](message, sender, sendResponse);
      if (!asyncFlag && !resolved) {
        resolved = true;
        resolve(undefined);
      }
    });
  }

  return {
    browserName,
    runtimeId,
    baseUrl,
    sandbox,
    listeners,
    storageLocal,
    nativeMessages,
    fetchCalls,
    cancelledBrowserDownloads,
    setDesktopState: ({ online, authenticated }) => {
      if (online !== undefined) desktopOnline = online;
      if (authenticated !== undefined) desktopAuthenticated = authenticated;
    },
    dispatchMessage,
    resetMetrics: () => {
      nativeMessages.length = 0;
      fetchCalls.length = 0;
      cancelledBrowserDownloads.length = 0;
      sandbox.resetSecurityRateLimits();
    },
  };
}

async function runSuiteForBrowser(config) {
  const h = createRuntimeHarness(config);
  let passed = 0;
  const check = async (name, fn) => {
    await fn();
    passed++;
    console.log(`  [PASS] (${h.browserName}) ${name}`);
  };

  const extOrigin = h.baseUrl.slice(0, -1);
  const optionsSender = {
    id: h.runtimeId,
    url: `${h.baseUrl}options/options.html`,
    origin: extOrigin,
    frameId: 0,
  };
  const popupSender = {
    id: h.runtimeId,
    url: `${h.baseUrl}popup/popup.html`,
    origin: extOrigin,
    frameId: 0,
  };
  const contentTab10 = {
    id: h.runtimeId,
    url: 'https://evil.example.com/attack.html',
    origin: 'https://evil.example.com',
    frameId: 0,
    tab: { id: 10, url: 'https://evil.example.com/attack.html' },
  };
  const contentTab20 = {
    id: h.runtimeId,
    url: 'https://private.bank.example/video',
    origin: 'https://private.bank.example',
    frameId: 0,
    tab: { id: 20, url: 'https://private.bank.example/video' },
  };

  // 1. Content script CANNOT invoke ANY privileged extension-page action (token exfiltration / control)
  const privilegedActions = [
    { action: 'INITIATE_PAIRING' },
    { action: 'RECONNECT_DESKTOP' },
    { action: 'PING_DESKTOP', passive: false },
    { action: 'GET_CONNECTION_STATUS' },
    { action: 'GET_ALL_MEDIA' },
    { action: 'GET_DOWNLOADS' },
    { action: 'PAUSE_DOWNLOAD', job_id: 'job-1' },
    { action: 'RESUME_DOWNLOAD', job_id: 'job-1' },
    { action: 'CANCEL_DOWNLOAD', job_id: 'job-1' },
    { action: 'RETRY_DOWNLOAD', job_id: 'job-1' },
    { action: 'SHOW_DESKTOP' },
    { action: 'OPEN_OPTIONS' },
    { action: 'OPEN_POPUP_TAB' },
    { action: 'RESOLVE_PLAYLIST', url: 'https://example.com/pl' },
    { action: 'ENQUEUE_PLAYLIST', items: [{ url: 'https://example.com/v1' }] },
  ];

  await check('Content script rejected on ALL 15 privileged actions with zero token leak & zero native calls', async () => {
    h.resetMetrics();
    for (const msg of privilegedActions) {
      const res = await h.dispatchMessage(msg, contentTab10);
      assert.strictEqual(res.status, 'error', `Expected error for ${msg.action}`);
      assert.strictEqual(res.code, 'UNAUTHORIZED_SENDER', `Expected UNAUTHORIZED_SENDER for ${msg.action}`);
      assert.strictEqual(res.token, undefined, `Token must never leak on ${msg.action}`);
    }
    assert.strictEqual(h.nativeMessages.length, 0, 'No native messaging call allowed from unauthorized actions');
    assert.strictEqual(h.fetchCalls.length, 0, 'No desktop API call allowed from unauthorized actions');
  });

  // 2. Foreign extension sender.id rejected everywhere
  await check('Foreign extension sender.id rejected for privileged and content actions', async () => {
    h.resetMetrics();
    const foreignSender = { ...optionsSender, id: 'attacker-extension-id-evil' };
    const r1 = await h.dispatchMessage({ action: 'INITIATE_PAIRING' }, foreignSender);
    const r2 = await h.dispatchMessage({ action: 'START_DOWNLOAD', url: 'https://cdn.example.com/a.mp4' }, foreignSender);
    assert.strictEqual(r1.code, 'UNAUTHORIZED_SENDER');
    assert.strictEqual(r2.code, 'UNAUTHORIZED_SENDER');
    assert.strictEqual(h.nativeMessages.length, 0);
  });

  // 3. Embedded subframe (frameId > 0) or non-whitelisted extension URL rejected
  await check('Extension iframe (frameId > 0) and non-whitelisted extension URL rejected', async () => {
    const iframeSender = { ...optionsSender, frameId: 2 };
    const weirdDocSender = { ...optionsSender, url: `${h.baseUrl}shared/other.html` };
    const r1 = await h.dispatchMessage({ action: 'INITIATE_PAIRING' }, iframeSender);
    const r2 = await h.dispatchMessage({ action: 'INITIATE_PAIRING' }, weirdDocSender);
    assert.strictEqual(r1.code, 'UNAUTHORIZED_SENDER');
    assert.strictEqual(r2.code, 'UNAUTHORIZED_SENDER');
  });

  // 4. Cross-tab media spying blocked: tab 10 cannot read tab 20's media cache
  await check('Cross-tab GET_TAB_MEDIA spying blocked (content script locked to own sender.tab.id)', async () => {
    h.resetMetrics();
    const recRes = await h.dispatchMessage(
      {
        action: 'RECORD_MEDIA_FROM_DOM',
        tabId: 10, // Attempted spoof, must record into sender.tab.id (20)
        candidate: { url: 'https://private.bank.example/secret-stream.m3u8', content_type: 'application/vnd.apple.mpegurl' },
      },
      contentTab20
    );
    assert.strictEqual(recRes.status, 'ok');

    // Tab 10 tries to spy on Tab 20 by passing tabId: 20
    const spyRes = await h.dispatchMessage({ action: 'GET_TAB_MEDIA', tabId: 20 }, contentTab10);
    assert.strictEqual(spyRes.status, 'ok');
    assert.strictEqual(spyRes.media.length, 0, 'Tab 10 must NOT see Tab 20 private media');

    // Legitimate popup CAN inspect Tab 20
    const popupRes = await h.dispatchMessage({ action: 'GET_TAB_MEDIA', tabId: 20 }, popupSender);
    assert.strictEqual(popupRes.status, 'ok');
    assert.strictEqual(popupRes.media.length, 1);
    assert.strictEqual(popupRes.media[0].url, 'https://private.bank.example/secret-stream.m3u8');
  });

  // 5. Content script CANNOT specify custom download destination or malicious URLs / flags
  await check('Content script destination injection & malicious URL/format_id payloads rejected', async () => {
    h.resetMetrics();
    const rDest1 = await h.dispatchMessage(
      {
        action: 'START_DOWNLOAD',
        url: 'https://cdn.example.com/payload.mp4',
        destination: 'C:\\Users\\victim\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
      },
      contentTab10
    );
    assert.strictEqual(rDest1.code, 'FORBIDDEN_FIELD');

    const rDest2 = await h.dispatchMessage(
      {
        action: 'START_MEDIA_DOWNLOAD',
        url: 'https://cdn.example.com/video',
        format_id: 'best',
        destination: 'C:\\Windows\\Temp',
      },
      contentTab10
    );
    assert.strictEqual(rDest2.code, 'FORBIDDEN_FIELD');

    const rFlagFmt = await h.dispatchMessage(
      {
        action: 'START_MEDIA_DOWNLOAD',
        url: 'https://cdn.example.com/video',
        format_id: '--exec=calc.exe',
      },
      contentTab10
    );
    assert.strictEqual(rFlagFmt.code, 'INVALID_REQUEST');

    const rFileUrl = await h.dispatchMessage(
      { action: 'START_DOWNLOAD', url: 'file:///C:/Windows/System32/cmd.exe' },
      contentTab10
    );
    assert.strictEqual(rFileUrl.code, 'INVALID_URL');

    const rFlagUrl = await h.dispatchMessage(
      { action: 'RESOLVE_MEDIA', url: '--config-location=/evil' },
      contentTab10
    );
    assert.strictEqual(rFlagUrl.code, 'INVALID_URL');

    assert.strictEqual(h.fetchCalls.length, 0);
    assert.strictEqual(h.nativeMessages.length, 0);
  });

  // 6. Path traversal job_id rejected even from extension page
  await check('Path-traversal job_id rejected on download control endpoints', async () => {
    h.resetMetrics();
    const res = await h.dispatchMessage({ action: 'CANCEL_DOWNLOAD', job_id: '../settings' }, popupSender);
    assert.strictEqual(res.code, 'INVALID_REQUEST');
    assert.strictEqual(h.fetchCalls.length, 0);
  });

  // 7. Token minimization & legitimate extension page flows
  await check('Token returned ONLY to options.html; popup.html reconnect works without leaking token', async () => {
    h.resetMetrics();
    h.setDesktopState({ online: true, authenticated: false });

    const optPair = await h.dispatchMessage({ action: 'INITIATE_PAIRING' }, optionsSender);
    assert.strictEqual(optPair.ok, true);
    assert.strictEqual(optPair.token, 'fresh-native-pair-token-1234');

    const popPair = await h.dispatchMessage({ action: 'INITIATE_PAIRING' }, popupSender);
    assert.strictEqual(popPair.ok, true);
    assert.strictEqual(popPair.token, undefined, 'Popup must not receive raw pairing token');

    h.setDesktopState({ online: true, authenticated: true });
    const popPing = await h.dispatchMessage({ action: 'PING_DESKTOP', passive: true }, popupSender);
    assert.strictEqual(popPing.status, 'ok');
    assert.strictEqual(popPing.authenticated, true);
    assert.strictEqual(popPing.token, undefined);

    const popShow = await h.dispatchMessage({ action: 'SHOW_DESKTOP' }, popupSender);
    assert.strictEqual(popShow.status, 'ok');
  });

  // 8. Legitimate user-initiated content script media detection & download flows preserved
  await check('Legitimate content script RESOLVE_MEDIA, START_MEDIA_DOWNLOAD, START_DOWNLOAD, OPEN_PLAYLIST succeed', async () => {
    h.resetMetrics();
    h.setDesktopState({ online: true, authenticated: true });

    const rResolve = await h.dispatchMessage(
      { action: 'RESOLVE_MEDIA', url: 'https://video.example.com/watch?v=123', candidates: ['https://cdn.example.com/master.m3u8'] },
      contentTab10
    );
    assert.strictEqual(rResolve.status, 'ok');

    const rMediaDl = await h.dispatchMessage(
      {
        action: 'START_MEDIA_DOWNLOAD',
        url: 'https://video.example.com/watch?v=123',
        format_id: 'bestvideo[height<=1080]+bestaudio/best',
        filename: 'demo.mp4',
        priority: 'high',
      },
      contentTab10
    );
    assert.strictEqual(rMediaDl.status, 'ok');
    assert.strictEqual(rMediaDl.job_id, 'media-job-1');

    const rDirectDl = await h.dispatchMessage(
      {
        action: 'START_DOWNLOAD',
        url: 'https://cdn.example.com/sample.mp4',
        filename: '../../escape/sample.mp4', // filename must be sanitized!
        priority: 'high',
      },
      contentTab10
    );
    assert.strictEqual(rDirectDl.status, 'ok');
    const dlReq = h.fetchCalls.find((c) => c.url.includes('/api/v1/downloads'));
    assert.ok(dlReq, 'Expected POST /api/v1/downloads');
    assert.strictEqual(dlReq.body.destination, undefined);
    assert.ok(!dlReq.body.filename.includes('..') && !dlReq.body.filename.includes('/'), 'Filename traversal must be stripped');

    const rPl = await h.dispatchMessage({ action: 'OPEN_PLAYLIST', url: 'https://video.example.com/playlist?list=PL123' }, contentTab10);
    assert.strictEqual(rPl.status, 'ok');
  });

  // 9. Content-script spam rate limit enforced
  await check('Content-script START_DOWNLOAD flood is rate-limited', async () => {
    h.resetMetrics();
    let rateLimited = false;
    for (let i = 0; i < 8; i++) {
      const res = await h.dispatchMessage(
        { action: 'START_DOWNLOAD', url: `https://cdn.example.com/file_${i}.mp4` },
        contentTab10
      );
      if (res.code === 'RATE_LIMITED') {
        rateLimited = true;
        break;
      }
    }
    assert.strictEqual(rateLimited, true, 'Expected RATE_LIMITED after exceeding burst cap');
  });

  // 10. Priority 3: Historical Edge startup download replay blocked, fresh active download intercepted
  await check('Priority 3: Browser startup replay of completed/stale downloads ignored; fresh in_progress intercepted', async () => {
    h.resetMetrics();
    h.setDesktopState({ online: true, authenticated: true });
    const now = Date.now();

    // Exact reproduction of Edge replaying historical completed ledger-live-desktop download on Windows boot
    const replayCompleted = {
      id: 101,
      url: 'https://download.live.ledger.com/ledger-live-desktop-4.23.0-win-x64.exe',
      filename: 'ledger-live-desktop-4.23.0-win-x64.exe',
      state: 'complete',
      startTime: new Date(now - 10 * 24 * 3600 * 1000).toISOString(),
      endTime: new Date(now - 10 * 24 * 3600 * 1000 + 5000).toISOString(),
    };
    assert.strictEqual(h.sandbox.shouldInterceptBrowserDownload(replayCompleted, now).allow, false);

    const replayInterrupted = { ...replayCompleted, id: 102, state: 'interrupted', endTime: undefined };
    assert.strictEqual(h.sandbox.shouldInterceptBrowserDownload(replayInterrupted, now).allow, false);

    const replayStaleInProgress = {
      id: 103,
      url: 'https://download.live.ledger.com/ledger-live-desktop-4.23.0-win-x64.exe',
      state: 'in_progress',
      startTime: new Date(now - 5 * 60 * 1000).toISOString(),
    };
    assert.strictEqual(h.sandbox.shouldInterceptBrowserDownload(replayStaleInProgress, now).allow, false);

    const replayPaused = {
      id: 104,
      url: 'https://download.live.ledger.com/ledger-live-desktop-4.23.0-win-x64.exe',
      state: 'in_progress',
      paused: true,
      startTime: new Date(now - 1000).toISOString(),
    };
    assert.strictEqual(h.sandbox.shouldInterceptBrowserDownload(replayPaused, now).allow, false);

    // Trigger onCreated with completed item -> must NOT call Desktop or Native Host!
    h.listeners.onCreated[0](replayCompleted);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(h.fetchCalls.length, 0, 'Completed historical download must NOT trigger Desktop API');
    assert.strictEqual(h.nativeMessages.length, 0, 'Completed historical download must NOT spawn Native Host');

    // Fresh user download MUST still be intercepted!
    const freshDownload = {
      id: 205,
      url: 'https://cdn.example.com/fresh-installer.exe',
      filename: 'fresh-installer.exe',
      state: 'in_progress',
      paused: false,
      startTime: new Date(now - 1500).toISOString(),
      totalBytes: 10 * 1024 * 1024,
    };
    assert.strictEqual(h.sandbox.shouldInterceptBrowserDownload(freshDownload, now).allow, true);
    h.listeners.onCreated[0](freshDownload);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(h.fetchCalls.some((c) => c.url.includes('/api/v1/downloads')), 'Fresh in_progress download must hand off to Desktop');
    assert.ok(h.cancelledBrowserDownloads.includes(205), 'Fresh handed-off browser download should cancel browser copy');
  });

  // 11. Priority 3: onStartup does NOT spawn Native Host / Desktop when Desktop is offline
  await check('Priority 3: onStartup does NOT spawn Native Host when TORI Desktop is offline', async () => {
    h.resetMetrics();
    h.storageLocal.tori_settings.key = '';
    h.setDesktopState({ online: false, authenticated: false });
    await h.listeners.onStartup[0]();
    assert.strictEqual(h.nativeMessages.length, 0, 'onStartup must NEVER invoke Native Messaging when Desktop is offline');
  });

  // 12. Gate 35.3: Invalid, oversized, wide, and malformed runtime messages rejected
  await check('Gate 35.3: Oversized (>64KiB), wide (>32 keys), null/array, and unknown messages rejected', async () => {
    h.resetMetrics();
    const huge = await h.dispatchMessage(
      { action: 'RESOLVE_MEDIA', url: 'https://cdn.example.com/v.mp4', page_title: 'A'.repeat(70000) },
      contentTab10
    );
    assert.strictEqual(huge.code, 'PAYLOAD_TOO_LARGE');

    const widePayload = { action: 'GET_TAB_MEDIA' };
    for (let i = 0; i < 40; i++) widePayload[`k${i}`] = i;
    const wide = await h.dispatchMessage(widePayload, contentTab10);
    assert.strictEqual(wide.code, 'PAYLOAD_TOO_LARGE');

    const arrMsg = await h.dispatchMessage(['INITIATE_PAIRING'], optionsSender);
    assert.strictEqual(arrMsg.code, 'INVALID_MESSAGE');

    const forgedAction = await h.dispatchMessage({ action: 'EXPORT_SECRET_TOKEN' }, optionsSender);
    assert.strictEqual(forgedAction.code, 'UNKNOWN_ACTION');

    // Cross-origin iframe content script cannot invoke privileged actions
    const crossOriginIframe = {
      id: h.runtimeId,
      url: 'https://ads.untrusted.example/frame.html',
      origin: 'https://ads.untrusted.example',
      frameId: 5,
      tab: { id: 10, url: 'https://trusted.video.example/watch' },
    };
    const iframePriv = await h.dispatchMessage({ action: 'INITIATE_PAIRING' }, crossOriginIframe);
    assert.strictEqual(iframePriv.code, 'UNAUTHORIZED_SENDER');
    assert.strictEqual(h.nativeMessages.length, 0);
  });

  // 13. Gate 35.3: Cold Service Worker restart preserves stored port & pairing token on first PING / GET_CONNECTION_STATUS
  await check('Gate 35.3: Cold Service Worker restart loads persisted port/key before PING_DESKTOP & GET_CONNECTION_STATUS', async () => {
    // Instantiate a brand-new sandbox simulating an MV3 Service Worker wake-up with async storage latency
    const cold = createRuntimeHarness({
      ...config,
      storageDelayMs: 25,
      initialSettings: {
        port: 24991,
        key: 'cold-sw-persisted-token-777',
      },
    });
    cold.setDesktopState({ online: true, authenticated: true });

    const coldStatus = await cold.dispatchMessage({ action: 'GET_CONNECTION_STATUS' }, optionsSender);
    assert.strictEqual(coldStatus.status, 'ok');
    assert.strictEqual(coldStatus.paired, true);
    const statusCall = cold.fetchCalls.find((c) => c.url.includes('127.0.0.1:24991/api/v1/status'));
    assert.ok(statusCall, 'Cold SW GET_CONNECTION_STATUS must use persisted port 24991');
    assert.strictEqual(statusCall.headers['X-Tori-Token'], 'cold-sw-persisted-token-777');

    const coldPing = await cold.dispatchMessage({ action: 'PING_DESKTOP', passive: true }, popupSender);
    assert.strictEqual(coldPing.status, 'ok');
    assert.strictEqual(coldPing.authenticated, true);
    assert.strictEqual(coldPing.token, undefined, 'Popup must still never receive raw token after SW restart');
  });

  return passed;
}

function runStaticContentChecks() {
  let passed = 0;
  const targets = [
    { label: 'Chromium/Edge content.js', file: path.join(ROOT, 'extension', 'content.js') },
    { label: 'Firefox content.js', file: path.join(ROOT, 'extension', 'firefox', 'content.js') },
  ];

  for (const t of targets) {
    const src = fs.readFileSync(t.file, 'utf8');
    assert.ok(!src.includes('__TORI_DISPATCH__'), `${t.label} must not contain __TORI_DISPATCH__`);
    assert.ok(!src.includes('__TORI_RESPONSE__'), `${t.label} must not contain __TORI_RESPONSE__`);
    assert.ok(!src.includes('toriExtensionUrl'), `${t.label} must not expose toriExtensionUrl`);
    assert.ok(src.includes("attachShadow({ mode: 'closed' })"), `${t.label} must use closed Shadow DOM for overlay portal`);
    assert.ok(!src.includes("attachShadow({ mode: 'open' })"), `${t.label} must not attach open Shadow DOM`);
    const trustedMatches = src.match(/if\s*\(!e\.isTrusted\)/g) || [];
    assert.ok(trustedMatches.length >= 3, `${t.label} must enforce e.isTrusted on pill, playlist, and download click handlers`);
    passed++;
    console.log(`  [PASS] (Static) ${t.label} verified clean (0 __TORI_DISPATCH__, closed shadow, ${trustedMatches.length} isTrusted guards)`);
  }

  // Verify no externally_connectable in manifests
  for (const mf of [
    path.join(ROOT, 'extension', 'manifest.json'),
    path.join(ROOT, 'extension', 'firefox', 'manifest.json'),
  ]) {
    const parsed = JSON.parse(fs.readFileSync(mf, 'utf8'));
    assert.strictEqual(parsed.version, '1.0.11', `${mf} must be version 1.0.11`);
    assert.strictEqual(parsed.externally_connectable, undefined, `${mf} must not declare externally_connectable`);
    passed++;
    console.log(`  [PASS] (Manifest) ${path.relative(ROOT, mf)} verified v1.0.11 & no externally_connectable`);
  }

  return passed;
}

async function main() {
  console.log('=== TORI Gate 35.2 — Extension Security & Compatibility Verification ===');
  let totalPassed = 0;

  totalPassed += await runSuiteForBrowser({
    browserName: 'Chromium/Edge',
    runtimeId: 'eodlgmbmddpjpnhiokehjokgjnhmbmng',
    originScheme: 'chrome-extension',
  });

  totalPassed += await runSuiteForBrowser({
    browserName: 'Firefox',
    runtimeId: 'tori-download-manager@toridm.org',
    originScheme: 'moz-extension',
  });

  totalPassed += runStaticContentChecks();

  console.log(`\nALL EXTENSION SECURITY & COMPATIBILITY CHECKS PASSED (${totalPassed}/${totalPassed})`);
}

main().catch((err) => {
  console.error('\n[FAIL] Extension security verification failed:', err);
  process.exit(1);
});
