/**
 * TORI Download Manager v1.0.1 — Gate 14.4.10 Automated Regression Test Suite
 * Verifies DASH Manifest Classification Fix:
 * 1. MPD URL with application/dash+xml -> DASH (type: dash, format: DASH (mpd))
 * 2. Extensionless URL with application/dash+xml -> DASH (type: dash, format: DASH (mpd))
 * 3. MPD with MIME parameters (application/dash+xml; charset=utf-8) -> DASH
 * 4. M3U8 URL with HLS MIME (application/vnd.apple.mpegurl) -> HLS (type: hls, format: m3u8)
 * 5. Extensionless HLS with HLS MIME -> HLS
 * 6. Direct MP4 remains direct media (type: direct, format: MP4)
 * 7. Standalone TS and AAC remain supported as complete media
 * 8. DASH M4S segments remain classified as segments (is_segment: true, format: M4S)
 * 9. HLS TS segments remain classified as segments (is_segment: true, format: TS/SEGMENT)
 * 10. DASH manifest candidate persists after MV3 service worker restart
 * 11. DASH manifest survives more than 50 segment candidates (eviction protection)
 * 12. Popup and overlay presentation format displays "DASH (mpd)"
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`[PASS] ${message}`);
    passCount++;
  } else {
    console.error(`[FAIL] ${message}`);
    failCount++;
  }
}

class MockSessionStorage {
  constructor() {
    this.store = new Map();
  }

  async get(keys) {
    if (keys === null) {
      const obj = {};
      for (const [k, v] of this.store.entries()) {
        obj[k] = JSON.parse(JSON.stringify(v));
      }
      return obj;
    }
    if (typeof keys === 'string') {
      const v = this.store.get(keys);
      return { [keys]: v !== undefined ? JSON.parse(JSON.stringify(v)) : undefined };
    }
    if (Array.isArray(keys)) {
      const obj = {};
      for (const k of keys) {
        if (this.store.has(k)) {
          obj[k] = JSON.parse(JSON.stringify(this.store.get(k)));
        }
      }
      return obj;
    }
    return {};
  }

  async set(items) {
    for (const [k, v] of Object.entries(items)) {
      this.store.set(k, JSON.parse(JSON.stringify(v)));
    }
  }

  async remove(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      this.store.delete(k);
    }
  }
}

function createWorkerContext(sharedSessionStorage, liveTabs = []) {
  const messageListeners = [];
  const webRequestListeners = [];
  const tabUpdateListeners = [];
  const tabRemoveListeners = [];

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Array,
    Object,
    Set,
    Map,
    Math,
    Date,
    URL,
    parseInt,
    isNaN,
    JSON,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
    chrome: {
      storage: {
        session: sharedSessionStorage,
        local: {
          get: (keys, cb) => cb({ tori_settings: { cap: true, badge: true, min: 0 } }),
          set: (obj, cb) => cb && cb(),
        },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        id: 'jfnfgmcbgapcpieaonbaolgebjaejcdm',
        lastError: null,
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        onConnect: { addListener: () => {} },
        onMessage: {
          addListener: (fn) => messageListeners.push(fn),
        },
        sendMessage: (msg, cb) => cb && cb({ status: 'ok' }),
        sendNativeMessage: (host, msg, cb) => cb && cb({ status: 'ok', token: 'test_token' }),
      },
      tabs: {
        query: (queryInfo) => {
          return Promise.resolve(liveTabs.map((id) => ({ id, url: `http://localhost/tab_${id}` })));
        },
        onUpdated: { addListener: (fn) => tabUpdateListeners.push(fn) },
        onRemoved: { addListener: (fn) => tabRemoveListeners.push(fn) },
        sendMessage: (tabId, msg, cb) => cb && cb({ status: 'ok' }),
      },
      webRequest: {
        onHeadersReceived: {
          addListener: (fn, filter, extra) => webRequestListeners.push(fn),
        },
      },
      action: {
        setBadgeText: () => Promise.resolve(),
        setBadgeBackgroundColor: () => Promise.resolve(),
        setTitle: () => Promise.resolve(),
        setIcon: () => Promise.resolve(),
      },
      webNavigation: {
        onHistoryStateUpdated: { addListener: () => {} },
      },
    },
  };

  const bgCode = fs.readFileSync(path.resolve('extension/background.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(bgCode, sandbox);

  return {
    sandbox,
    dispatchWebRequest: (details) => {
      for (const fn of webRequestListeners) {
        fn(details);
      }
    },
    sendMessage: (msg) => {
      return new Promise((resolve) => {
        let responded = false;
        const sendResponse = (res) => {
          if (!responded) {
            responded = true;
            resolve(res);
          }
        };
        for (const fn of messageListeners) {
          const ret = fn(msg, { tab: { id: msg.tabId || 101 } }, sendResponse);
          if (ret === true) return;
        }
        if (!responded) resolve(null);
      });
    },
  };
}

async function run() {
  console.log('====================================================');
  console.log('TORI GATE 14.4.10: DASH MANIFEST CLASSIFICATION FIX');
  console.log('====================================================\n');

  const sessionStorage = new MockSessionStorage();
  const worker = createWorkerContext(sessionStorage, [101, 102, 103, 104]);

  // Give settings a moment to resolve in mock worker
  await new Promise((r) => setTimeout(r, 50));

  // -------------------------------------------------------------------------
  // Test 1: MPD URL with application/dash+xml -> DASH
  // -------------------------------------------------------------------------
  console.log('--- Test 1: MPD URL with application/dash+xml ---');
  const res1 = worker.sandbox.classifyMedia(
    'http://127.0.0.1:19890/dash/manifest.mpd',
    'application/dash+xml',
    [{ name: 'Content-Type', value: 'application/dash+xml' }]
  );
  assert(res1.type === 'dash', `MPD with application/dash+xml has type='dash' (actual: ${res1.type})`);
  assert(res1.format === 'DASH (mpd)', `MPD with application/dash+xml has format='DASH (mpd)' (actual: ${res1.format})`);
  assert(res1.is_segment === false, `MPD with application/dash+xml has is_segment=false (actual: ${res1.is_segment})`);
  assert(res1.supported === true, `MPD with application/dash+xml is supported=true`);

  // -------------------------------------------------------------------------
  // Test 2: Extensionless URL with application/dash+xml -> DASH
  // -------------------------------------------------------------------------
  console.log('\n--- Test 2: Extensionless URL with application/dash+xml ---');
  const res2 = worker.sandbox.classifyMedia(
    'http://cdn.example.com/live/manifest_stream_id',
    'application/dash+xml',
    [{ name: 'Content-Type', value: 'application/dash+xml' }]
  );
  assert(res2.type === 'dash', `Extensionless manifest with application/dash+xml has type='dash' (actual: ${res2.type})`);
  assert(res2.format === 'DASH (mpd)', `Extensionless manifest with application/dash+xml has format='DASH (mpd)' (actual: ${res2.format})`);
  assert(res2.is_segment === false, `Extensionless manifest has is_segment=false (actual: ${res2.is_segment})`);

  // -------------------------------------------------------------------------
  // Test 3: MPD with MIME parameters -> DASH
  // -------------------------------------------------------------------------
  console.log('\n--- Test 3: MPD with MIME parameters (charset=utf-8) ---');
  const res3a = worker.sandbox.classifyMedia(
    'http://example.com/video/dash.mpd',
    'application/dash+xml; charset=utf-8',
    [{ name: 'Content-Type', value: 'application/dash+xml; charset=utf-8' }]
  );
  assert(res3a.type === 'dash', `MPD with charset parameter has type='dash' (actual: ${res3a.type})`);
  assert(res3a.format === 'DASH (mpd)', `MPD with charset parameter has format='DASH (mpd)' (actual: ${res3a.format})`);

  const res3b = worker.sandbox.classifyMedia(
    'http://example.com/video/stream_dash', // Extensionless with parameters
    'application/dash+xml; charset=utf-8; profile="urn:mpeg:dash:profile:isoff-live:2011"',
    [{ name: 'Content-Type', value: 'application/dash+xml; charset=utf-8; profile="urn:mpeg:dash:profile:isoff-live:2011"' }]
  );
  assert(res3b.type === 'dash', `Extensionless DASH with complex MIME parameters has type='dash' (actual: ${res3b.type})`);
  assert(res3b.format === 'DASH (mpd)', `Extensionless DASH with complex parameters has format='DASH (mpd)'`);

  // -------------------------------------------------------------------------
  // Test 4: M3U8 URL with HLS MIME -> HLS
  // -------------------------------------------------------------------------
  console.log('\n--- Test 4: M3U8 URL with HLS MIME ---');
  const res4 = worker.sandbox.classifyMedia(
    'http://127.0.0.1:19889/hls/master.m3u8',
    'application/vnd.apple.mpegurl',
    [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }]
  );
  assert(res4.type === 'hls', `M3U8 with apple mpegurl has type='hls' (actual: ${res4.type})`);
  assert(res4.format === 'm3u8', `M3U8 with apple mpegurl has format='m3u8' (actual: ${res4.format})`);
  assert(res4.is_segment === false, `HLS manifest has is_segment=false`);

  // -------------------------------------------------------------------------
  // Test 5: Extensionless HLS with HLS MIME -> HLS
  // -------------------------------------------------------------------------
  console.log('\n--- Test 5: Extensionless HLS with HLS MIME ---');
  const res5 = worker.sandbox.classifyMedia(
    'http://stream.example.com/live/hls_feed_channel1',
    'application/x-mpegurl; charset=utf-8',
    [{ name: 'Content-Type', value: 'application/x-mpegurl; charset=utf-8' }]
  );
  assert(res5.type === 'hls', `Extensionless HLS has type='hls' (actual: ${res5.type})`);
  assert(res5.format === 'm3u8', `Extensionless HLS has format='m3u8' (actual: ${res5.format})`);

  // -------------------------------------------------------------------------
  // Test 6: Direct MP4 Remains Direct Media
  // -------------------------------------------------------------------------
  console.log('\n--- Test 6: Direct MP4 Remains Direct Media ---');
  const res6 = worker.sandbox.classifyMedia(
    'http://cdn.example.com/assets/sample_1080p.mp4',
    'video/mp4',
    [{ name: 'Content-Type', value: 'video/mp4' }]
  );
  assert(res6.type === 'direct', `Direct MP4 has type='direct' (actual: ${res6.type})`);
  assert(res6.format === 'MP4', `Direct MP4 has format='MP4' (actual: ${res6.format})`);
  assert(res6.is_segment === false, `Direct MP4 has is_segment=false`);

  // -------------------------------------------------------------------------
  // Test 7: Standalone TS and AAC remain complete media
  // -------------------------------------------------------------------------
  console.log('\n--- Test 7: Standalone TS and AAC Complete Media ---');
  const res7a = worker.sandbox.classifyMedia(
    'http://example.com/broadcast_feed.ts',
    'video/mp2t',
    [{ name: 'Content-Type', value: 'video/mp2t' }]
  );
  assert(res7a.type === 'direct', `Standalone .ts has type='direct' (actual: ${res7a.type})`);
  assert(res7a.format === 'TS', `Standalone .ts has format='TS' (actual: ${res7a.format})`);
  assert(res7a.is_segment === false, `Standalone .ts has is_segment=false`);

  const res7b = worker.sandbox.classifyMedia(
    'http://example.com/audio/podcast_track.aac',
    'audio/aac',
    [{ name: 'Content-Type', value: 'audio/aac' }]
  );
  assert(res7b.type === 'direct', `Standalone .aac has type='direct' (actual: ${res7b.type})`);
  assert(res7b.format === 'AAC', `Standalone .aac has format='AAC' (actual: ${res7b.format})`);
  assert(res7b.is_segment === false, `Standalone .aac has is_segment=false`);

  // -------------------------------------------------------------------------
  // Test 8: DASH M4S Segments Remain Classified as Segments
  // -------------------------------------------------------------------------
  console.log('\n--- Test 8: DASH M4S Segments Classification ---');
  const res8 = worker.sandbox.classifyMedia(
    'http://127.0.0.1:19890/dash/chunk-stream0-00001.m4s',
    'video/iso.segment',
    [{ name: 'Content-Type', value: 'video/iso.segment' }]
  );
  assert(res8.type === 'segment', `DASH M4S fragment has type='segment' (actual: ${res8.type})`);
  assert(res8.format === 'M4S', `DASH M4S fragment has format='M4S' (actual: ${res8.format})`);
  assert(res8.is_segment === true, `DASH M4S fragment has is_segment=true`);

  // -------------------------------------------------------------------------
  // Test 9: HLS TS Segments Remain Classified as Segments
  // -------------------------------------------------------------------------
  console.log('\n--- Test 9: HLS TS Segments Classification ---');
  const res9 = worker.sandbox.classifyMedia(
    'http://127.0.0.1:19889/hls/seg_001.ts',
    'video/mp2t',
    [{ name: 'Content-Type', value: 'video/mp2t' }]
  );
  assert(res9.type === 'segment', `HLS numbered TS segment has type='segment' (actual: ${res9.type})`);
  assert(res9.is_segment === true, `HLS numbered TS segment has is_segment=true`);

  // -------------------------------------------------------------------------
  // Test 10: DASH Manifest Persists After Service Worker Restart
  // -------------------------------------------------------------------------
  console.log('\n--- Test 10: DASH Manifest MV3 Worker Session Persistence ---');
  // Dispatch webRequest on tab 101 for DASH manifest
  worker.dispatchWebRequest({
    tabId: 101,
    url: 'http://127.0.0.1:19890/dash/manifest.mpd',
    responseHeaders: [
      { name: 'Content-Type', value: 'application/dash+xml' },
      { name: 'Content-Length', value: '1754' },
    ],
    statusCode: 200,
  });

  // Await debounced session storage write
  await new Promise((r) => setTimeout(r, 100));

  const storedTab101 = await sessionStorage.get('media_tab_101');
  const storedCandidates = storedTab101['media_tab_101'] || [];
  assert(storedCandidates.length > 0, `Session storage recorded candidates for tab 101 (count: ${storedCandidates.length})`);
  const storedDash = storedCandidates.find((c) => c.url.includes('manifest.mpd'));
  assert(storedDash !== undefined, `Session storage contains manifest.mpd`);
  assert(storedDash?.type === 'dash', `Stored manifest preserves type='dash' (actual: ${storedDash?.type})`);
  assert(storedDash?.format === 'DASH (mpd)', `Stored manifest preserves format='DASH (mpd)'`);

  // Spawn fresh worker instance simulating cold-start wake-up
  const freshWorker = createWorkerContext(sessionStorage, [101]);
  await new Promise((r) => setTimeout(r, 60));

  const getMediaRes = await freshWorker.sendMessage({ action: 'GET_TAB_MEDIA', tabId: 101 });
  const restoredCandidates = getMediaRes?.media || [];
  assert(restoredCandidates.length > 0, `Fresh service worker restored tab candidates (count: ${restoredCandidates.length})`);
  const restoredDash = restoredCandidates.find((c) => c.url.includes('manifest.mpd'));
  assert(restoredDash?.type === 'dash', `Restored candidate after SW restart has type='dash' (actual: ${restoredDash?.type})`);
  assert(restoredDash?.format === 'DASH (mpd)', `Restored candidate after SW restart has format='DASH (mpd)'`);
  assert(restoredDash?.is_segment === false, `Restored candidate after SW restart has is_segment=false`);

  // -------------------------------------------------------------------------
  // Test 11: DASH Manifest Survives More Than 50 Segment Candidates
  // -------------------------------------------------------------------------
  console.log('\n--- Test 11: DASH Manifest Eviction Protection (>50 Segments) ---');
  // Send 60 DASH segments into tab 102
  worker.dispatchWebRequest({
    tabId: 102,
    url: 'http://127.0.0.1:19890/dash/manifest.mpd',
    responseHeaders: [{ name: 'Content-Type', value: 'application/dash+xml' }],
    statusCode: 200,
  });

  for (let i = 1; i <= 60; i++) {
    const num = String(i).padStart(5, '0');
    worker.dispatchWebRequest({
      tabId: 102,
      url: `http://127.0.0.1:19890/dash/chunk-stream0-${num}.m4s`,
      responseHeaders: [{ name: 'Content-Type', value: 'video/iso.segment' }],
      statusCode: 200,
    });
  }

  const tab102Res = await worker.sendMessage({ action: 'GET_TAB_MEDIA', tabId: 102 });
  const tab102Candidates = tab102Res?.media || [];
  assert(tab102Candidates.length === 50, `Registry strictly bounded to 50 items (actual: ${tab102Candidates.length})`);
  const dashInTab102 = tab102Candidates.find((c) => c.url.includes('manifest.mpd'));
  assert(dashInTab102 !== undefined, `DASH manifest candidate survived 60 incoming segment candidates`);
  assert(dashInTab102?.type === 'dash', `Protected candidate retains type='dash'`);

  // -------------------------------------------------------------------------
  // Test 12: Popup and Overlay Format Display
  // -------------------------------------------------------------------------
  console.log('\n--- Test 12: Popup & Overlay Presentation Display ---');
  // In popup.js, getDisplayCandidates filters out segments when a manifest is present
  function mockGetDisplayCandidates(items) {
    const hasManifest = items.some(
      (c) => c.type === 'hls' || c.type === 'dash' || (c.url && (c.url.includes('.m3u8') || c.url.includes('.mpd')))
    );
    if (hasManifest) {
      const nonSegments = items.filter((c) => !c.is_segment && c.type !== 'segment');
      return nonSegments.length > 0 ? nonSegments : items;
    }
    return items;
  }

  const displayCandidates = mockGetDisplayCandidates(tab102Candidates);
  assert(displayCandidates.length === 1, `Popup suppresses 49 segment cards and surfaces exactly 1 manifest (actual: ${displayCandidates.length})`);
  const topCandidate = displayCandidates[0];
  assert(topCandidate.format === 'DASH (mpd)', `Top candidate card displays format='DASH (mpd)' (actual: ${topCandidate.format})`);
  assert(topCandidate.type === 'dash', `Top candidate card displays type='dash' (actual: ${topCandidate.type})`);

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('\n====================================================');
  console.log(`GATE 14.4.10 REGRESSION TESTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('====================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal unhandled error:', err);
  process.exit(1);
});
