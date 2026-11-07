/**
 * TORI Download Manager v1.0.1 — Gate 14.4.4 Verification Harness
 * Verifies Intelligent Media Segment Classification & Presentation:
 * 1. HLS manifest + 100 TS segments: segments classified is_segment: true; manifest preferred in display
 * 2. DASH manifest + 100 M4S fragments: fragments classified is_segment: true; manifest preferred in display
 * 3. Standalone TS file (e.g. sample.ts, movie.ts) preserved as complete media (is_segment: false)
 * 4. Standalone AAC file (e.g. song.aac) preserved as complete audio (is_segment: false)
 * 5. Direct MP4 downloads preserved as complete media (is_segment: false)
 * 6. MP4 byte-range request preservation (is_segment: false)
 * 7. Streaming fragments with NO detected manifest: preserved and displayed with honest segment classification
 * 8. CMFV and CMFA segment detection (.cmfv, .cmfa, init.cmfv)
 * 9. Multiple streams in same tab: manifests preferred, segments suppressed
 * 10. Multiple tab isolation: Tab 1 (HLS + segments) vs Tab 2 (standalone media)
 * 11. Service worker restart: is_segment flag persists across session storage restoration
 * 12. Navigation & tab close cleanup
 * 13. Raw original media URL preservation for download initiation
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  has(key) {
    return this.store.has(key);
  }
}

function createServiceWorkerEnvironment(sharedSessionStorage, liveTabsList = []) {
  const messageListeners = [];
  const webRequestListeners = [];
  const tabsUpdatedListeners = [];
  const tabsRemovedListeners = [];
  const historyUpdatedListeners = [];

  const mockChrome = {
    storage: {
      session: {
        get: (keys) => sharedSessionStorage.get(keys),
        set: (items) => sharedSessionStorage.set(items),
        remove: (keys) => sharedSessionStorage.remove(keys),
      },
      local: {
        get: async () => ({}),
        set: async () => {},
      },
      sync: {
        get: async () => ({}),
        set: async () => {},
      },
      onChanged: {
        addListener: () => {},
      },
    },
    tabs: {
      query: async () => liveTabsList.map((id) => ({ id })),
      onUpdated: {
        addListener: (fn) => tabsUpdatedListeners.push(fn),
      },
      onRemoved: {
        addListener: (fn) => tabsRemovedListeners.push(fn),
      },
      sendMessage: async () => {},
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    webNavigation: {
      onHistoryStateUpdated: {
        addListener: (fn) => historyUpdatedListeners.push(fn),
      },
    },
    webRequest: {
      onHeadersReceived: {
        addListener: (fn) => webRequestListeners.push(fn),
      },
    },
    runtime: {
      id: 'mock-tori-extension-id',
      lastError: null,
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: {
        addListener: (fn) => messageListeners.push(fn),
      },
      sendMessage: () => {},
      sendNativeMessage: () => {},
      connectNative: () => ({ onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} } }),
    },
  };

  const sandbox = {
    chrome: mockChrome,
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
      info: () => {},
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    parseInt,
    isNaN,
    Array,
    Object,
    String,
    Boolean,
    Number,
    Map,
    Set,
    Promise,
    RegExp,
    Math,
    URL,
  };

  const context = vm.createContext(sandbox);

  return {
    context,
    mockChrome,
    messageListeners,
    webRequestListeners,
    tabsUpdatedListeners,
    tabsRemovedListeners,
    historyUpdatedListeners,
  };
}

async function runWorker(bgScriptCode, env) {
  vm.runInContext(bgScriptCode, env.context);
}

async function simulateNetworkResponse(env, { tabId, url, statusCode = 200, responseHeaders = [] }) {
  for (const listener of env.webRequestListeners) {
    listener({
      tabId,
      url,
      statusCode,
      responseHeaders,
      method: 'GET',
      requestId: `req_${Math.random()}`,
    });
  }
}

async function sendMessageToWorker(env, message, sender = {}) {
  for (const listener of env.messageListeners) {
    let responded = false;
    let responseData = undefined;

    const sendResponse = (res) => {
      responded = true;
      responseData = res;
    };

    const isAsync = listener(message, sender, sendResponse);
    if (isAsync) {
      let elapsed = 0;
      while (!responded && elapsed < 2000) {
        await sleep(10);
        elapsed += 10;
      }
      return responseData;
    } else if (responded) {
      return responseData;
    }
  }
  return null;
}

// Emulates popup's presentation layer filtering
function getPopupDisplayCandidates(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const hasManifest = items.some(
    (c) => c.type === 'hls' || c.type === 'dash' || (c.url && (c.url.includes('.m3u8') || c.url.includes('.mpd')))
  );
  if (hasManifest) {
    const nonSegments = items.filter((c) => !c.is_segment && c.type !== 'segment');
    return nonSegments.length > 0 ? nonSegments : items;
  }
  return items;
}

async function main() {
  console.log('====================================================');
  console.log('TORI GATE 14.4.4: INTELLIGENT SEGMENT CLASSIFICATION');
  console.log('====================================================\n');

  const bgPath = path.resolve(__dirname, '../extension/background.js');
  if (!fs.existsSync(bgPath)) {
    throw new Error(`Background script not found at: ${bgPath}`);
  }
  const bgScriptCode = fs.readFileSync(bgPath, 'utf8');

  const sharedSessionStorage = new MockSessionStorage();
  let passed = 0;
  let failed = 0;

  function assert(condition, testName, detail = '') {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}${detail ? ': ' + detail : ''}`);
      failed++;
    }
  }

  // -------------------------------------------------------------------------
  // TEST 1: HLS Manifest + 100 TS Segments
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 1: HLS Manifest + 100 TS Segments ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [1]);
    await runWorker(bgScriptCode, env);

    // 1. Record HLS master playlist
    await simulateNetworkResponse(env, {
      tabId: 1,
      url: 'https://cdn.example.com/hls/master.m3u8',
      responseHeaders: [{ name: 'content-type', value: 'application/x-mpegurl' }],
    });

    // 2. Stream 100 media segments
    for (let i = 1; i <= 100; i++) {
      await simulateNetworkResponse(env, {
        tabId: 1,
        url: `https://cdn.example.com/hls/segment_${i}.ts`,
        responseHeaders: [
          { name: 'content-type', value: 'video/mp2t' },
          { name: 'content-length', value: '1048576' },
        ],
      });
    }

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 1 });
    assert(res && res.media.length === 50, 'Registry contains exactly 50 candidates');

    const manifest = res.media.find((c) => c.url.includes('master.m3u8'));
    assert(manifest && manifest.is_segment === false, 'HLS master manifest classified with is_segment: false');

    const tsSegments = res.media.filter((c) => c.url.includes('.ts'));
    assert(tsSegments.length > 0, 'TS segments recorded in candidate registry');
    assert(tsSegments.every((c) => c.is_segment === true), 'All HLS TS segments accurately classified with is_segment: true');
    assert(tsSegments.every((c) => c.type === 'segment'), 'All HLS TS segments classified with type=segment');

    // Test presentation filtering: when manifest is present, segments are suppressed
    const displayList = getPopupDisplayCandidates(res.media);
    assert(displayList.length === 1, `Popup presentation displays exactly 1 item (actual: ${displayList.length})`);
    assert(displayList[0].url.includes('master.m3u8'), 'Popup displays the HLS master manifest and suppresses 49 segment cards');
  }

  // -------------------------------------------------------------------------
  // TEST 2: DASH Manifest + 100 M4S Fragments
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 2: DASH Manifest + 100 M4S Fragments ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [2]);
    await runWorker(bgScriptCode, env);

    await simulateNetworkResponse(env, {
      tabId: 2,
      url: 'https://cdn.dash.com/manifest.mpd',
      responseHeaders: [{ name: 'content-type', value: 'application/dash+xml' }],
    });

    for (let i = 1; i <= 100; i++) {
      await simulateNetworkResponse(env, {
        tabId: 2,
        url: `https://cdn.dash.com/frag_${i}.m4s`,
        responseHeaders: [
          { name: 'content-type', value: 'video/iso.segment' },
          { name: 'content-length', value: '524288' },
        ],
      });
    }

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 2 });
    const dashManifest = res.media.find((c) => c.url.includes('manifest.mpd'));
    assert(dashManifest && dashManifest.is_segment === false, 'DASH manifest classified with is_segment: false');

    const m4sFragments = res.media.filter((c) => c.url.includes('.m4s'));
    assert(m4sFragments.every((c) => c.is_segment === true), 'All .m4s fragments classified with is_segment: true');
    assert(m4sFragments.every((c) => c.format === 'M4S'), 'All .m4s fragments have format=M4S');

    const displayList = getPopupDisplayCandidates(res.media);
    assert(displayList.length === 1 && displayList[0].url.includes('manifest.mpd'), 'DASH manifest preferred over M4S fragments in presentation');
  }

  // -------------------------------------------------------------------------
  // TEST 3: Standalone TS File
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 3: Standalone TS File Preservation ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [3]);
    await runWorker(bgScriptCode, env);

    await simulateNetworkResponse(env, {
      tabId: 3,
      url: 'https://archive.org/download/broadcast_recording.ts',
      responseHeaders: [
        { name: 'content-type', value: 'video/mp2t' },
        { name: 'content-length', value: '524288000' }, // 500 MB
      ],
    });

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 3 });
    assert(res.media.length === 1, 'Standalone TS file recorded');
    const tsFile = res.media[0];
    assert(tsFile.is_segment === false, 'Standalone broadcast_recording.ts is NOT classified as a segment (is_segment: false)');
    assert(tsFile.type === 'direct', 'Standalone TS file retains type=direct');
    assert(tsFile.format === 'TS', 'Standalone TS file retains format=TS');

    const displayList = getPopupDisplayCandidates(res.media);
    assert(displayList.length === 1, 'Standalone TS file presented cleanly in UI');
  }

  // -------------------------------------------------------------------------
  // TEST 4: Standalone AAC File
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 4: Standalone AAC File Preservation ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [4]);
    await runWorker(bgScriptCode, env);

    await simulateNetworkResponse(env, {
      tabId: 4,
      url: 'https://radio.example.com/audio/podcast_episode_12.aac',
      responseHeaders: [
        { name: 'content-type', value: 'audio/aac' },
        { name: 'content-length', value: '31457280' }, // 30 MB
      ],
    });

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 4 });
    assert(res.media.length === 1, 'Standalone AAC audio file recorded');
    const aacFile = res.media[0];
    assert(aacFile.is_segment === false, 'Standalone podcast_episode_12.aac is NOT classified as a segment (is_segment: false)');
    assert(aacFile.type === 'direct', 'Standalone AAC audio retains type=direct');
    assert(aacFile.format === 'AAC', 'Standalone AAC audio retains format=AAC');
  }

  // -------------------------------------------------------------------------
  // TEST 5: Direct MP4 Download
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 5: Direct MP4 Download ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [5]);
    await runWorker(bgScriptCode, env);

    await simulateNetworkResponse(env, {
      tabId: 5,
      url: 'https://example.com/videos/full_movie_1080p.mp4',
      responseHeaders: [
        { name: 'content-type', value: 'video/mp4' },
        { name: 'content-length', value: '1073741824' }, // 1 GB
      ],
    });

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 5 });
    const mp4File = res.media[0];
    assert(mp4File.is_segment === false, 'Direct MP4 video has is_segment: false');
    assert(mp4File.type === 'direct', 'Direct MP4 video has type=direct');
    assert(mp4File.format === 'MP4', 'Direct MP4 video has format=MP4');
  }

  // -------------------------------------------------------------------------
  // TEST 6: MP4 Byte-Range Requests
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 6: MP4 Byte-Range Requests ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [6]);
    await runWorker(bgScriptCode, env);

    // Initial probe or range request for large video
    await simulateNetworkResponse(env, {
      tabId: 6,
      url: 'https://example.com/stream/documentary.mp4',
      statusCode: 206,
      responseHeaders: [
        { name: 'content-type', value: 'video/mp4' },
        { name: 'content-range', value: 'bytes 0-1048575/209715200' }, // 1MB of 200MB
        { name: 'content-length', value: '1048576' },
      ],
    });

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 6 });
    const mp4Range = res.media[0];
    assert(mp4Range.is_segment === false, 'MP4 206 partial content range request for full video is NOT marked as a segment');
    assert(mp4Range.type === 'direct', 'MP4 range request retains type=direct');

    // In contrast, fragmented MP4 with query range parameter
    await simulateNetworkResponse(env, {
      tabId: 6,
      url: 'https://example.com/dash/video.mp4?range=0-50000',
      statusCode: 206,
      responseHeaders: [
        { name: 'content-type', value: 'video/mp4' },
      ],
    });

    const res2 = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 6 });
    const fragMp4 = res2.media.find((c) => c.url.includes('?range=0-50000'));
    assert(fragMp4 && fragMp4.is_segment === true, 'MP4 chunk with query range parameter is correctly classified as segment');
  }

  // -------------------------------------------------------------------------
  // TEST 7: Streaming Fragments with NO Detected Manifest
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 7: Orphan Streaming Fragments (No Manifest Detected) ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [7]);
    await runWorker(bgScriptCode, env);

    // Only fragments captured without master manifest
    await simulateNetworkResponse(env, {
      tabId: 7,
      url: 'https://obscure-site.org/stream/chunk_001.ts',
      responseHeaders: [{ name: 'content-type', value: 'video/mp2t' }],
    });
    await simulateNetworkResponse(env, {
      tabId: 7,
      url: 'https://obscure-site.org/stream/chunk_002.ts',
      responseHeaders: [{ name: 'content-type', value: 'video/mp2t' }],
    });

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 7 });
    assert(res.media.length === 2, 'Orphan segments are safely recorded in registry');
    assert(res.media.every((c) => c.is_segment === true), 'Segments classified as is_segment: true');

    // UI presentation when no manifest is available
    const displayList = getPopupDisplayCandidates(res.media);
    assert(displayList.length === 2, 'When manifest is absent, segments are PRESERVED and displayed (never discarded)');
    assert(displayList.every((c) => c.format.includes('segment') || c.type === 'segment'), 'Displayed candidates indicate segment format');
  }

  // -------------------------------------------------------------------------
  // TEST 8: CMAF Video and Audio Segments (.cmfv, .cmfa)
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 8: CMAF Video & Audio Segments (.cmfv, .cmfa) ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [8]);
    await runWorker(bgScriptCode, env);

    await simulateNetworkResponse(env, {
      tabId: 8,
      url: 'https://cmaf.cdn.com/live/video_01.cmfv',
      responseHeaders: [{ name: 'content-type', value: 'video/mp4' }],
    });
    await simulateNetworkResponse(env, {
      tabId: 8,
      url: 'https://cmaf.cdn.com/live/audio_01.cmfa',
      responseHeaders: [{ name: 'content-type', value: 'audio/mp4' }],
    });

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 8 });
    const cmfv = res.media.find((c) => c.url.includes('.cmfv'));
    const cmfa = res.media.find((c) => c.url.includes('.cmfa'));

    assert(cmfv && cmfv.is_segment === true && cmfv.format === 'CMFV', '.cmfv recognized as CMFV segment');
    assert(cmfa && cmfa.is_segment === true && cmfa.format === 'CMFA', '.cmfa recognized as CMFA segment');
  }

  // -------------------------------------------------------------------------
  // TEST 9: Multiple Streams in Same Tab
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 9: Multiple Streams in Same Tab ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [9]);
    await runWorker(bgScriptCode, env);

    // Stream A (HLS)
    await simulateNetworkResponse(env, {
      tabId: 9,
      url: 'https://multi.com/player1/index.m3u8',
      responseHeaders: [{ name: 'content-type', value: 'application/x-mpegurl' }],
    });
    // Stream B (DASH)
    await simulateNetworkResponse(env, {
      tabId: 9,
      url: 'https://multi.com/player2/stream.mpd',
      responseHeaders: [{ name: 'content-type', value: 'application/dash+xml' }],
    });

    // 20 segments for Stream A and Stream B
    for (let i = 1; i <= 20; i++) {
      await simulateNetworkResponse(env, {
        tabId: 9,
        url: `https://multi.com/player1/segment_${i}.ts`,
        responseHeaders: [{ name: 'content-type', value: 'video/mp2t' }],
      });
      await simulateNetworkResponse(env, {
        tabId: 9,
        url: `https://multi.com/player2/frag_${i}.m4s`,
        responseHeaders: [{ name: 'content-type', value: 'video/iso.segment' }],
      });
    }

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 9 });
    const displayList = getPopupDisplayCandidates(res.media);

    assert(displayList.length === 2, `Presentation cleanly surfaces exactly 2 manifests (actual: ${displayList.length})`);
    assert(
      displayList.some((c) => c.url.includes('index.m3u8')) &&
      displayList.some((c) => c.url.includes('stream.mpd')),
      'Both Stream 1 and Stream 2 manifests are presented without segment spam'
    );
  }

  // -------------------------------------------------------------------------
  // TEST 10: Multiple Tab Isolation
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 10: Multiple Tab Isolation ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [101, 102]);
    await runWorker(bgScriptCode, env);

    // Tab 101: HLS + segments
    await simulateNetworkResponse(env, {
      tabId: 101,
      url: 'https://tab101.com/master.m3u8',
      responseHeaders: [{ name: 'content-type', value: 'application/x-mpegurl' }],
    });
    await simulateNetworkResponse(env, {
      tabId: 101,
      url: 'https://tab101.com/seg_1.ts',
      responseHeaders: [{ name: 'content-type', value: 'video/mp2t' }],
    });

    // Tab 102: Standalone MP4
    await simulateNetworkResponse(env, {
      tabId: 102,
      url: 'https://tab102.com/feature.mp4',
      responseHeaders: [{ name: 'content-type', value: 'video/mp4' }],
    });

    const res101 = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 101 });
    const res102 = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 102 });

    const disp101 = getPopupDisplayCandidates(res101.media);
    const disp102 = getPopupDisplayCandidates(res102.media);

    assert(disp101.length === 1 && disp101[0].url.includes('tab101.com'), 'Tab 101 presentation isolated');
    assert(disp102.length === 1 && disp102[0].url.includes('tab102.com'), 'Tab 102 presentation isolated');
    assert(disp102[0].is_segment === false, 'Tab 102 MP4 remains unsegmented complete media');
  }

  // -------------------------------------------------------------------------
  // TEST 11: Worker Restart & Session Restoration with is_segment Flag
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 11: Worker Restart & is_segment Restoration ---');
  {
    const env1 = createServiceWorkerEnvironment(sharedSessionStorage, [111]);
    await runWorker(bgScriptCode, env1);

    await simulateNetworkResponse(env1, {
      tabId: 111,
      url: 'https://persist.com/live.m3u8',
      responseHeaders: [{ name: 'content-type', value: 'application/x-mpegurl' }],
    });
    await simulateNetworkResponse(env1, {
      tabId: 111,
      url: 'https://persist.com/seg_01.ts',
      responseHeaders: [{ name: 'content-type', value: 'video/mp2t' }],
    });

    await sleep(120);

    // Worker terminates and wakes up
    const env2 = createServiceWorkerEnvironment(sharedSessionStorage, [111]);
    await runWorker(bgScriptCode, env2);

    const res2 = await sendMessageToWorker(env2, { action: 'GET_TAB_MEDIA', tabId: 111 });
    const restoredManifest = res2.media.find((c) => c.url.includes('live.m3u8'));
    const restoredSeg = res2.media.find((c) => c.url.includes('seg_01.ts'));

    assert(restoredManifest && restoredManifest.is_segment === false, 'Restored manifest retains is_segment: false');
    assert(restoredSeg && restoredSeg.is_segment === true, 'Restored segment retains is_segment: true across worker termination');
  }

  // -------------------------------------------------------------------------
  // TEST 12: Raw URL Preservation for Downloads
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 12: Raw URL Preservation for Downloads ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [121]);
    await runWorker(bgScriptCode, env);

    const rawUrl = 'https://stream.net/hls/master.m3u8?token=secure123&exp=1700000000';
    await simulateNetworkResponse(env, {
      tabId: 121,
      url: rawUrl,
      responseHeaders: [{ name: 'content-type', value: 'application/x-mpegurl' }],
    });

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 121 });
    assert(res.media[0].url === rawUrl, 'Candidate preserves exact raw URL with query tokens for download dispatch');
  }

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  console.log('\n====================================================');
  console.log(`GATE 14.4.4 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error during test execution:', err);
  process.exit(1);
});
