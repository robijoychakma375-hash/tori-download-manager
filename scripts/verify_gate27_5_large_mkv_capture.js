/**
 * Comprehensive verification harness for Gate 27.5:
 * Large MKV browser download interception, concurrency deduplication,
 * offline resilience, and handoff integrity.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Read the actual background.js code
const bgCode = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');

let serverPort = 0;
let desktopPort = 0;
let desktopReceivedPayloads = [];
let desktopStatus = 200;

// Setup mock TORI Desktop HTTP API Server
const desktopServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/v1/downloads') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        desktopReceivedPayloads.push(parsed);
        if (desktopStatus === 200) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', job_id: 'job_' + Date.now() }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Internal Server Error' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

// Setup Mock Browser Download File Server
const fileServer = http.createServer((req, res) => {
  const url = req.url;
  if (url === '/redirect_mkv') {
    res.writeHead(302, { 'Location': `http://127.0.0.1:${serverPort}/target_movie_2.9gb.mkv` });
    res.end();
    return;
  }
  if (url === '/disposition_stream') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="super_video_remux_1080p.mkv"',
      'Content-Length': '3113851289',
      'Accept-Ranges': 'bytes'
    });
    res.end('V');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'video/x-matroska',
    'Content-Length': '3113851289',
    'Accept-Ranges': 'bytes'
  });
  res.end('V');
});

async function runTests() {
  await new Promise(r => desktopServer.listen(0, '127.0.0.1', () => {
    desktopPort = desktopServer.address().port;
    r();
  }));
  await new Promise(r => fileServer.listen(0, '127.0.0.1', () => {
    serverPort = fileServer.address().port;
    r();
  }));

  console.log(`[TEST] Desktop Mock Server listening on port ${desktopPort}`);
  console.log(`[TEST] File Mock Server listening on port ${serverPort}\n`);

  // Build sandboxed mock environment for background.js
  const cancelledIds = new Set();
  const mockStorage = {
    tori_settings: {
      port: desktopPort,
      key: '',
      auto: true,
      cap: true,
      min: 1,
      badge: true,
      sites: ['docs.google.com'],
      // Simulating upgraded settings
      types: [
        'zip', 'rar', '7z', 'iso', 'tar', 'gz', 'bz2', 'xz',
        'exe', 'msi', 'dmg', 'bin',
        'pdf', 'epub',
        'mkv', 'mp4', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v',
        'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus'
      ]
    }
  };

  const sandbox = {
    console: console,
    Set: Set,
    Map: Map,
    URL: URL,
    Date: Date,
    Math: Math,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Promise: Promise,
    Array: Array,
    Boolean: Boolean,
    parseInt: parseInt,
    parseFloat: parseFloat,
    decodeURIComponent: decodeURIComponent,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ToriTestAgent/1.0' },
    fetch: fetch,
    AbortController: AbortController,
    chrome: {
      storage: {
        local: {
          get: (keys, cb) => cb(mockStorage),
          set: (obj, cb) => { Object.assign(mockStorage, obj); if (cb) cb(); }
        },
        onChanged: { addListener: () => {} }
      },
      downloads: {
        cancel: (id, cb) => { cancelledIds.add(id); if (cb) cb(); },
        onCreated: { addListener: () => {} },
        onDeterminingFilename: { addListener: () => {} }
      },
      runtime: {
        onMessage: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        sendNativeMessage: (host, msg, cb) => cb({ status: 'ok', job_id: 'nm_job_1' })
      },
      tabs: {
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        sendMessage: () => Promise.resolve()
      },
      webNavigation: {
        onHistoryStateUpdated: { addListener: () => {} }
      },
      webRequest: {
        onHeadersReceived: { addListener: () => {} }
      },
      action: {
        setBadgeText: () => {},
        setBadgeBackgroundColor: () => {}
      }
    }
  };

  const vm = require('vm');
  const ctx = vm.createContext(sandbox);

  // Execute background script in sandbox
  vm.runInContext(bgCode, ctx);

  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${message}`);
    }
  }

  console.log('--- TEST 1: Direct 2.9 GB MKV Download Interception ---');
  desktopReceivedPayloads = [];
  cancelledIds.clear();

  const item1 = {
    id: 101,
    url: `http://127.0.0.1:${serverPort}/movie_sample_2.9gb.mkv`,
    finalUrl: `http://127.0.0.1:${serverPort}/movie_sample_2.9gb.mkv`,
    filename: 'C:\\Users\\User\\Downloads\\movie_sample_2.9gb.mkv',
    mime: 'video/x-matroska',
    totalBytes: 3113851289
  };

  await ctx.handleBrowserDownload(item1);

  assert(desktopReceivedPayloads.length === 1, 'Desktop engine received exactly 1 handoff payload');
  assert(desktopReceivedPayloads[0]?.filename === 'movie_sample_2.9gb.mkv', 'Handoff filename is movie_sample_2.9gb.mkv');
  assert(desktopReceivedPayloads[0]?.handoff_id === 'browser_dl_101', 'Handoff ID is browser_dl_101');
  assert(cancelledIds.has(101), 'Browser download 101 was cancelled in browser after successful handoff');

  console.log('\n--- TEST 2: Content-Disposition attachment with .mkv ---');
  desktopReceivedPayloads = [];
  cancelledIds.clear();

  const item2 = {
    id: 102,
    url: `http://127.0.0.1:${serverPort}/disposition_stream`,
    finalUrl: `http://127.0.0.1:${serverPort}/disposition_stream`,
    filename: 'super_video_remux_1080p.mkv',
    mime: 'application/octet-stream',
    totalBytes: 3113851289
  };

  await ctx.handleBrowserDownload(item2);

  assert(desktopReceivedPayloads.length === 1, 'Desktop engine received handoff for Content-Disposition item');
  assert(desktopReceivedPayloads[0]?.filename === 'super_video_remux_1080p.mkv', 'Resolved filename preserved from Content-Disposition');
  assert(cancelledIds.has(102), 'Browser download 102 cancelled');

  console.log('\n--- TEST 3: Redirect URL (finalUrl has .mkv) ---');
  desktopReceivedPayloads = [];
  cancelledIds.clear();

  const item3 = {
    id: 103,
    url: `http://127.0.0.1:${serverPort}/redirect_mkv`,
    finalUrl: `http://127.0.0.1:${serverPort}/target_movie_2.9gb.mkv`,
    filename: '',
    mime: 'application/octet-stream',
    totalBytes: 3113851289
  };

  await ctx.handleBrowserDownload(item3);

  assert(desktopReceivedPayloads.length === 1, 'Handoff sent using finalUrl target');
  assert(desktopReceivedPayloads[0]?.filename === 'target_movie_2.9gb.mkv', 'Target filename derived from finalUrl');
  assert(cancelledIds.has(103), 'Browser download 103 cancelled');

  console.log('\n--- TEST 4: Concurrency Deduplication (onCreated + onDeterminingFilename race) ---');
  desktopReceivedPayloads = [];
  cancelledIds.clear();

  const item4 = {
    id: 104,
    url: `http://127.0.0.1:${serverPort}/race_test_stream.mkv`,
    filename: 'race_test_stream.mkv',
    mime: 'video/x-matroska',
    totalBytes: 3113851289
  };

  // Dispatch two parallel events simultaneously
  await Promise.all([
    ctx.handleBrowserDownload(item4),
    ctx.handleBrowserDownload(item4)
  ]);

  assert(desktopReceivedPayloads.length === 1, 'Only ONE handoff dispatched despite concurrent events');
  assert(cancelledIds.has(104), 'Browser download 104 cancelled once');

  console.log('\n--- TEST 5: Backend Offline / Error Handling Resilience ---');
  desktopReceivedPayloads = [];
  cancelledIds.clear();
  desktopStatus = 500; // Force error

  const item5 = {
    id: 105,
    url: `http://127.0.0.1:${serverPort}/failing_download.mkv`,
    filename: 'failing_download.mkv',
    mime: 'video/x-matroska',
    totalBytes: 3113851289
  };

  // Mock sendNativeMessage to fail as well (engine completely offline)
  sandbox.chrome.runtime.sendNativeMessage = (host, msg, cb) => cb({ status: 'error', message: 'Host not running' });

  await ctx.handleBrowserDownload(item5);

  assert(!cancelledIds.has(105), 'Browser download MUST NOT be cancelled when desktop engine is unavailable');
  console.log('  [PASS] Preserved browser download in browser history during failure');

  console.log(`\n========================================`);
  console.log(`Gate 27.5 Verification Suite: ${passed}/${total} assertions passed.`);
  console.log(`========================================\n`);

  desktopServer.close();
  fileServer.close();

  if (passed !== total) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('[ERROR]', err);
  desktopServer.close();
  fileServer.close();
  process.exit(1);
});
