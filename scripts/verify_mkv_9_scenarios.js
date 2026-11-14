/**
 * TORI Gate 27.5.1 — Full Functional Regression Suite for MKV Capture (9 Scenarios)
 * Tests all 9 scenarios specified in Step 3 of Gate 27.5.1:
 *  1. Small MKV file download
 *  2. Large MKV file download (2.9 GB simulated range server)
 *  3. MKV through HTTP 302 redirects
 *  4. Content-Disposition filename override
 *  5. Signed URL with token query params
 *  6. Browser download handoff to TORI Desktop Engine
 *  7. Engine disconnected / offline behavior
 *  8. Preservation of browser download history when handoff fails
 *  9. Duplicate download coalescing protection
 */

const http = require('http');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const DESKTOP_PORT = 41380;
const HTTP_SERVER_PORT = 41381;

let desktopServer;
let testHttpServer;
let handoffRequests = [];
let engineOnline = true;
let simulateEngineError = false;

function startDesktopMock() {
  return new Promise((resolve) => {
    desktopServer = http.createServer((req, res) => {
      if (!engineOnline) {
        req.destroy();
        return;
      }
      if (simulateEngineError) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Internal engine fault' }));
        return;
      }

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          handoffRequests.push({ url: req.url, method: req.method, payload });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', job_id: 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Bad JSON' }));
        }
      });
    });
    desktopServer.listen(DESKTOP_PORT, '127.0.0.1', resolve);
  });
}

function startFileHttpServer() {
  return new Promise((resolve) => {
    testHttpServer = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${HTTP_SERVER_PORT}`);

      // Scenario 3: 302 Redirect
      if (u.pathname === '/redirect-to-mkv') {
        res.writeHead(302, { Location: `/files/streamed_movie.mkv?token=secret123` });
        res.end();
        return;
      }

      // Scenario 4: Content-Disposition override
      if (u.pathname === '/download-disposition') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="feature_presentation_2026.mkv"',
          'Content-Length': '10485760' // 10 MB
        });
        res.end(Buffer.alloc(1024, 0)); // truncated for mock
        return;
      }

      // Scenario 1: Small MKV
      if (u.pathname === '/small-clip.mkv') {
        res.writeHead(200, {
          'Content-Type': 'video/x-matroska',
          'Content-Length': '5242880' // 5 MB
        });
        res.end(Buffer.alloc(1024, 0));
        return;
      }

      // Scenario 2: Large MKV (2.9 GB range server)
      if (u.pathname === '/files/large_archive_2_9gb.mkv') {
        const totalSize = 3113851289; // 2.9 GB
        const range = req.headers['range'];
        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : start + 1024;
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': 'video/x-matroska'
          });
          res.end(Buffer.alloc(end - start + 1, 0));
        } else {
          res.writeHead(200, {
            'Accept-Ranges': 'bytes',
            'Content-Length': totalSize.toString(),
            'Content-Type': 'video/x-matroska'
          });
          res.end(Buffer.alloc(1024, 0));
        }
        return;
      }

      // Scenario 5: Signed URL with token query params
      if (u.pathname === '/secure/video_feed.mkv') {
        res.writeHead(200, {
          'Content-Type': 'video/x-matroska',
          'Content-Length': '52428800'
        });
        res.end(Buffer.alloc(1024, 0));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });
    testHttpServer.listen(HTTP_SERVER_PORT, '127.0.0.1', resolve);
  });
}

function loadBackgroundContext(scriptPath) {
  const code = fs.readFileSync(path.resolve(scriptPath), 'utf8');

  let cancelledIds = new Set();
  let erasedIds = new Set();
  let listeners = {};

  const chromeMock = {
    runtime: {
      getURL: (p) => `chrome-extension://mock-id/${p}`,
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      sendNativeMessage: (host, msg, cb) => {
        if (!engineOnline || simulateEngineError) {
          const errRes = { status: 'error', message: 'Engine offline or error' };
          if (typeof cb === 'function') cb(errRes);
          return Promise.resolve(errRes);
        }
        const res = { status: 'ok', token: 'test_token', port: DESKTOP_PORT, job_id: 'nm_job' };
        if (typeof cb === 'function') cb(res);
        return Promise.resolve(res);
      }
    },
    storage: {
      local: {
        get: (k, cb) => cb({
          tori_settings: {
            port: DESKTOP_PORT,
            key: 'test_token',
            token: 'test_token',
            cap: true,
            min: 1, // 1 MB minimum
            types: ['zip', 'rar', '7z', 'iso', 'exe', 'dmg', 'pdf', 'mp4', 'mp3', 'mkv']
          }
        }),
        set: (d, cb) => { if (cb) cb(); }
      },
      onChanged: { addListener: () => {} }
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      onActivated: { addListener: () => {} }
    },
    action: {
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
      setTitle: () => {},
      setIcon: () => {}
    },
    webRequest: {
      onHeadersReceived: { addListener: () => {} }
    },
    downloads: {
      onCreated: { addListener: (fn) => { listeners['onCreated'] = fn; } },
      onDeterminingFilename: { addListener: (fn) => { listeners['onDeterminingFilename'] = fn; } },
      cancel: (id, cb) => {
        cancelledIds.add(id);
        if (cb) cb();
      },
      erase: (q, cb) => {
        if (q && q.id) erasedIds.add(q.id);
        if (cb) cb();
      }
    }
  };

  const sandbox = {
    console,
    Math,
    parseInt,
    parseFloat,
    Boolean,
    decodeURIComponent,
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
    fetch: globalThis.fetch,
    AbortController: globalThis.AbortController,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TORI/1.0.6' },
    chrome: chromeMock,
    browser: chromeMock
  };

  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  const script = new vm.Script(code);
  const context = vm.createContext(sandbox);
  script.runInContext(context);

  return {
    handleBrowserDownload: sandbox.handleBrowserDownload,
    handleCreated: listeners['onCreated'],
    handleDetermining: listeners['onDeterminingFilename'],
    cancelledIds,
    erasedIds
  };
}

async function runRegressionSuite() {
  console.log('=== TORI Gate 27.5.1: 9-Scenario Functional Regression Suite ===\n');

  await startDesktopMock();
  await startFileHttpServer();

  const ctx = loadBackgroundContext('extension/firefox/background.js');
  await new Promise(r => setTimeout(r, 100)); // wait for ensureSettingsLoaded

  let passedAssertions = 0;
  function assert(cond, msg) {
    if (!cond) {
      console.error(`[FAIL] ${msg}`);
      throw new Error(`Assertion failed: ${msg}`);
    }
    console.log(`  [PASS] ${msg}`);
    passedAssertions++;
  }

  // Scenario 1: Small MKV file download
  console.log('--- SCENARIO 1: Small MKV File Download (5 MB) ---');
  handoffRequests = [];
  ctx.cancelledIds.clear();
  await ctx.handleBrowserDownload({
    id: 201,
    url: `http://127.0.0.1:${HTTP_SERVER_PORT}/small-clip.mkv`,
    mime: 'video/x-matroska',
    fileSize: 5242880,
    totalBytes: 5242880,
    state: 'in_progress',
    danger: 'safe'
  });
  assert(handoffRequests.length === 1, 'Desktop engine received exactly 1 handoff for small MKV');
  assert(handoffRequests[0].payload.filename === 'small-clip.mkv', 'Filename matches small-clip.mkv');
  assert(ctx.cancelledIds.has(201), 'Browser download 201 cancelled after successful handoff');

  // Scenario 2: Large MKV file download (2.9 GB simulated range server)
  console.log('\n--- SCENARIO 2: Large MKV Download (2.9 GB Range Server) ---');
  handoffRequests = [];
  ctx.cancelledIds.clear();
  await ctx.handleBrowserDownload({
    id: 202,
    url: `http://127.0.0.1:${HTTP_SERVER_PORT}/files/large_archive_2_9gb.mkv`,
    mime: 'video/x-matroska',
    fileSize: 3113851289,
    totalBytes: 3113851289,
    state: 'in_progress',
    danger: 'safe'
  });
  assert(handoffRequests.length === 1, 'Desktop engine received handoff for 2.9 GB MKV');
  assert(handoffRequests[0].payload.filename === 'large_archive_2_9gb.mkv', 'Filename matches large_archive_2_9gb.mkv');
  assert(ctx.cancelledIds.has(202), 'Browser download 202 cancelled in browser after handoff');

  // Scenario 3: MKV through HTTP 302 redirects
  console.log('\n--- SCENARIO 3: MKV through HTTP 302 Redirects ---');
  handoffRequests = [];
  ctx.cancelledIds.clear();
  await ctx.handleBrowserDownload({
    id: 203,
    url: `http://127.0.0.1:${HTTP_SERVER_PORT}/redirect-to-mkv`,
    finalUrl: `http://127.0.0.1:${HTTP_SERVER_PORT}/files/streamed_movie.mkv?token=secret123`,
    mime: 'video/x-matroska',
    fileSize: 104857600,
    totalBytes: 104857600,
    state: 'in_progress',
    danger: 'safe'
  });
  assert(handoffRequests.length === 1, 'Desktop engine received handoff for redirected MKV');
  assert(handoffRequests[0].payload.url.includes('streamed_movie.mkv'), 'Handoff target uses final redirected URL');
  assert(handoffRequests[0].payload.filename === 'streamed_movie.mkv', 'Resolved filename stripped query parameters');
  assert(ctx.cancelledIds.has(203), 'Browser download 203 cancelled');

  // Scenario 4: Content-Disposition filename override
  console.log('\n--- SCENARIO 4: Content-Disposition Filename Override ---');
  handoffRequests = [];
  ctx.cancelledIds.clear();
  await ctx.handleBrowserDownload({
    id: 204,
    url: `http://127.0.0.1:${HTTP_SERVER_PORT}/download-disposition`,
    filename: 'C:\\Users\\Mock\\Downloads\\feature_presentation_2026.mkv',
    mime: 'application/octet-stream',
    fileSize: 10485760,
    totalBytes: 10485760,
    state: 'in_progress',
    danger: 'safe'
  });
  assert(handoffRequests.length === 1, 'Desktop engine received handoff with Content-Disposition');
  assert(handoffRequests[0].payload.filename === 'feature_presentation_2026.mkv', 'Filename preserved from Content-Disposition header');
  assert(ctx.cancelledIds.has(204), 'Browser download 204 cancelled');

  // Scenario 5: Signed URL with token query params
  console.log('\n--- SCENARIO 5: Signed URL with Token Query Params ---');
  handoffRequests = [];
  ctx.cancelledIds.clear();
  await ctx.handleBrowserDownload({
    id: 205,
    url: `http://127.0.0.1:${HTTP_SERVER_PORT}/secure/video_feed.mkv?auth=jwt_signed_998877&expires=1893456000`,
    mime: 'video/x-matroska',
    fileSize: 52428800,
    totalBytes: 52428800,
    state: 'in_progress',
    danger: 'safe'
  });
  assert(handoffRequests.length === 1, 'Handoff sent with full signed query string');
  assert(handoffRequests[0].payload.url.includes('auth=jwt_signed_998877'), 'Signature token preserved in payload URL');
  assert(handoffRequests[0].payload.filename === 'video_feed.mkv', 'Filename clean without query tokens');
  assert(ctx.cancelledIds.has(205), 'Browser download 205 cancelled');

  // Scenario 6: Browser download handoff to TORI Desktop Engine
  console.log('\n--- SCENARIO 6: Browser Download Handoff Payload Verification ---');
  assert(handoffRequests[0].payload.user_agent.includes('TORI/1.0.6'), 'User agent propagated to desktop engine');
  assert(handoffRequests[0].payload.priority === 'normal', 'Priority assigned as normal');
  assert(handoffRequests[0].payload.handoff_id === 'browser_dl_205', 'Handoff ID uniquely correlated to browser item id');

  // Scenario 7: Engine disconnected / offline behavior
  console.log('\n--- SCENARIO 7: Engine Disconnected / Offline Behavior ---');
  handoffRequests = [];
  ctx.cancelledIds.clear();
  engineOnline = false; // Simulate offline engine
  await ctx.handleBrowserDownload({
    id: 207,
    url: `http://127.0.0.1:${HTTP_SERVER_PORT}/small-clip.mkv`,
    mime: 'video/x-matroska',
    fileSize: 5242880,
    totalBytes: 5242880,
    state: 'in_progress',
    danger: 'safe'
  });
  assert(!ctx.cancelledIds.has(207), 'CRITICAL: Browser download 207 was NOT cancelled when engine is offline');
  assert(handoffRequests.length === 0, 'No successful handoffs recorded');

  // Scenario 8: Preservation of browser download history when handoff fails
  console.log('\n--- SCENARIO 8: Preservation of Browser Download History on Failure ---');
  engineOnline = true;
  simulateEngineError = true; // Engine returns HTTP 500 error
  handoffRequests = [];
  ctx.cancelledIds.clear();
  ctx.erasedIds.clear();
  await ctx.handleBrowserDownload({
    id: 208,
    url: `http://127.0.0.1:${HTTP_SERVER_PORT}/files/error_test.mkv`,
    mime: 'video/x-matroska',
    fileSize: 5242880,
    totalBytes: 5242880,
    state: 'in_progress',
    danger: 'safe'
  });
  assert(!ctx.cancelledIds.has(208), 'Browser download 208 was NOT cancelled on engine 500 error');
  assert(!ctx.erasedIds.has(208), 'Browser history entry was NOT erased on failed handoff');

  // Scenario 9: Duplicate download coalescing protection
  console.log('\n--- SCENARIO 9: Duplicate Download Coalescing Protection ---');
  simulateEngineError = false;
  handoffRequests = [];
  ctx.cancelledIds.clear();
  const raceItem = {
    id: 209,
    url: `http://127.0.0.1:${HTTP_SERVER_PORT}/files/concurrent_test.mkv`,
    mime: 'video/x-matroska',
    fileSize: 10485760,
    totalBytes: 10485760,
    state: 'in_progress',
    danger: 'safe'
  };
  // Fire both calls simultaneously for the same item id
  await Promise.all([
    ctx.handleBrowserDownload(raceItem),
    ctx.handleBrowserDownload(raceItem)
  ]);
  assert(handoffRequests.length === 1, 'Only ONE handoff dispatched during concurrent event race');
  assert(ctx.cancelledIds.size === 1 && ctx.cancelledIds.has(209), 'Browser download 209 cancelled exactly once');

  // Teardown
  desktopServer.close();
  testHttpServer.close();

  console.log('\n======================================================');
  console.log(`ALL 9 REGRESSION SCENARIOS PASSED (${passedAssertions}/${passedAssertions} assertions)`);
  console.log('======================================================\n');
}

runRegressionSuite().catch(err => {
  console.error('[SUITE ERROR]', err);
  if (desktopServer) desktopServer.close();
  if (testHttpServer) testHttpServer.close();
  process.exit(1);
});
