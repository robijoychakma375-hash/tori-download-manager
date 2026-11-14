/**
 * TORI Gate 27.5.1 — Browser Runtime Environment Simulation & Listener Audit
 * Tests execution of Chrome MV3 service worker and Firefox MV3 background script.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createBrowserMock(browserName) {
  const listeners = {
    'runtime.onMessage': [],
    'runtime.onInstalled': [],
    'runtime.onStartup': [],
    'tabs.onUpdated': [],
    'tabs.onRemoved': [],
    'tabs.onActivated': [],
    'webRequest.onHeadersReceived': [],
    'downloads.onCreated': [],
    'downloads.onDeterminingFilename': [],
    'storage.onChanged': []
  };

  const storageData = {
    tori_settings: {
      port: 6800,
      token: 'test_token',
      cap: true,
      min: 1,
      badge: true,
      sites: ['docs.google.com', 'mail.google.com', 'github.com'],
      types: ['zip', 'rar', '7z', 'iso', 'exe', 'dmg', 'pdf', 'mp4', 'mp3', 'mkv']
    }
  };

  const chromeMock = {
    runtime: {
      getURL: (p) => `${browserName}-extension://mock-id/${p}`,
      onMessage: {
        addListener: (fn) => listeners['runtime.onMessage'].push(fn)
      },
      onInstalled: {
        addListener: (fn) => listeners['runtime.onInstalled'].push(fn)
      },
      onStartup: {
        addListener: (fn) => listeners['runtime.onStartup'].push(fn)
      },
      sendNativeMessage: (host, msg, cb) => {
        if (typeof cb === 'function') cb({ status: 'ok', job_id: 'mock_nm_job' });
        return Promise.resolve({ status: 'ok', job_id: 'mock_nm_job' });
      }
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const res = {};
          if (Array.isArray(keys)) {
            keys.forEach(k => { if (storageData[k] !== undefined) res[k] = storageData[k]; });
          } else if (typeof keys === 'string') {
            if (storageData[keys] !== undefined) res[keys] = storageData[keys];
          }
          if (typeof cb === 'function') cb(res);
          return Promise.resolve(res);
        },
        set: (items, cb) => {
          Object.assign(storageData, items);
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        }
      },
      onChanged: {
        addListener: (fn) => listeners['storage.onChanged'].push(fn)
      }
    },
    tabs: {
      onUpdated: { addListener: (fn) => listeners['tabs.onUpdated'].push(fn) },
      onRemoved: { addListener: (fn) => listeners['tabs.onRemoved'].push(fn) },
      onActivated: { addListener: (fn) => listeners['tabs.onActivated'].push(fn) },
      create: (opts, cb) => { if (cb) cb({ id: 101, ...opts }); },
      sendMessage: (tabId, msg, cb) => { if (cb) cb({ status: 'ok' }); }
    },
    action: {
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
      setTitle: () => {},
      setIcon: () => {}
    },
    webRequest: {
      onHeadersReceived: {
        addListener: (fn, filter, extra) => {
          listeners['webRequest.onHeadersReceived'].push({ fn, filter, extra });
        }
      }
    },
    downloads: {
      onCreated: { addListener: (fn) => listeners['downloads.onCreated'].push(fn) },
      onDeterminingFilename: { addListener: (fn) => listeners['downloads.onDeterminingFilename'].push(fn) },
      cancel: (id, cb) => { if (cb) cb(); }
    }
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    Set,
    Map,
    Date,
    Array,
    Object,
    Promise,
    AbortController: globalThis.AbortController,
    navigator: { userAgent: `Mozilla/5.0 (${browserName}) TORI/1.0.6` },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', authenticated: true, paired: true })
    }),
    chrome: chromeMock,
    browser: chromeMock
  };

  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  return { sandbox, listeners };
}

async function testScriptExecution(scriptPath, browserName) {
  console.log(`\n======================================================`);
  console.log(`Testing [${browserName}] execution: ${scriptPath}`);
  console.log(`======================================================`);

  const code = fs.readFileSync(path.resolve(scriptPath), 'utf8');

  // 1. Syntax check via vm.Script
  let script;
  try {
    script = new vm.Script(code, { filename: scriptPath });
    console.log(`[PASS] Syntax parse: Clean compilation with 0 syntax errors.`);
  } catch (err) {
    console.error(`[FAIL] Syntax parse error:`, err);
    process.exit(1);
  }

  // 2. Execution check in mock environment
  const { sandbox, listeners } = createBrowserMock(browserName);
  const context = vm.createContext(sandbox);

  let unhandledRejection = null;
  const onUnhandled = (reason) => { unhandledRejection = reason; };
  process.on('unhandledRejection', onUnhandled);

  try {
    script.runInContext(context);
    console.log(`[PASS] Script execution: Initialized successfully without exceptions.`);
  } catch (err) {
    console.error(`[FAIL] Runtime exception during initialization:`, err);
    process.exit(1);
  }

  // Allow microtasks and immediate timers to settle
  await new Promise(r => setTimeout(r, 200));
  process.removeListener('unhandledRejection', onUnhandled);

  if (unhandledRejection) {
    console.error(`[FAIL] Unhandled promise rejection during initialization:`, unhandledRejection);
    process.exit(1);
  } else {
    console.log(`[PASS] Async initialization: Zero unhandled promise rejections.`);
  }

  // 3. Listener attachment verification
  console.log(`\nAttached Event Listeners:`);
  for (const [evt, list] of Object.entries(listeners)) {
    console.log(`  - ${evt}: ${list.length} listener(s)`);
    if (evt === 'downloads.onCreated' || evt === 'downloads.onDeterminingFilename') {
      if (list.length !== 1) {
        console.error(`[FAIL] Expected exactly 1 listener for ${evt}, got ${list.length}`);
        process.exit(1);
      }
    }
  }
  console.log(`[PASS] All core event listeners registered cleanly.`);

  // 4. Test handleBrowserDownload execution via download listener
  const onCreatedFn = listeners['downloads.onCreated'][0];
  if (typeof onCreatedFn !== 'function') {
    console.error(`[FAIL] downloads.onCreated listener not attached as function!`);
    process.exit(1);
  }

  console.log(`\nSimulating browser download event handling (MKV 2.9 GB)...`);
  const mockItem = {
    id: 9901,
    url: 'https://example.com/downloads/big_video_archive.mkv?token=xyz123',
    finalUrl: 'https://cdn.example.com/stream/big_video_archive.mkv',
    filename: 'big_video_archive.mkv',
    mime: 'video/x-matroska',
    fileSize: 3113851289, // ~2.9 GB
    totalBytes: 3113851289,
    state: 'in_progress',
    danger: 'safe',
    referrer: 'https://example.com/catalog'
  };

  try {
    await onCreatedFn(mockItem);
    console.log(`[PASS] downloads.onCreated handler processed MKV item cleanly without error.`);
  } catch (err) {
    console.error(`[FAIL] Error during onCreated handler invocation:`, err);
    process.exit(1);
  }

  return true;
}

async function main() {
  await testScriptExecution('extension/background.js', 'Chrome Service Worker');
  await testScriptExecution('extension/firefox/background.js', 'Firefox Background Script');
  console.log(`\n======================================================`);
  console.log(`ALL BROWSER RUNTIME EXECUTION TESTS PASSED!`);
  console.log(`======================================================\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
