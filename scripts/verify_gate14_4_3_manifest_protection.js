/**
 * TORI Download Manager v1.0.1 — Gate 14.4.3 Verification Harness
 * Verifies HLS/DASH Manifest Eviction Protection:
 * 1. One HLS manifest followed by 100+ media segments (.ts) — manifest preserved
 * 2. One DASH manifest followed by 100+ media fragments (.m4s) — manifest preserved
 * 3. Multiple manifests in the same tab (2 HLS + 1 DASH) followed by 100+ segments — all preserved
 * 4. Direct MP4 downloads FIFO behavior
 * 5. Standalone .ts and .aac media candidates recorded without rejection
 * 6. Candidate registry strictly bounded to MAX_CANDIDATES_PER_TAB (<= 50)
 * 7. Exact URL deduplication
 * 8. Multiple tab isolation
 * 9. Service worker restart & session restoration with protected manifests
 * 10. Full navigation & SPA navigation cleanup
 * 11. Tab close cleanup
 * 12. Download request candidate structure preservation
 * 13. High-priority overflow: 55 manifests bounded to 50 manifests via FIFO
 * 14. Manifest arriving after 50 segments is inserted and protected against subsequent segments
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
  const tabsUpdatedListeners = [];
  const tabsRemovedListeners = [];
  const historyUpdatedListeners = [];
  const badges = new Map();

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
      setBadgeText: async ({ tabId, text }) => {
        badges.set(tabId, text);
      },
      setBadgeBackgroundColor: async () => {},
    },
    webNavigation: {
      onHistoryStateUpdated: {
        addListener: (fn) => historyUpdatedListeners.push(fn),
      },
    },
    webRequest: {
      onHeadersReceived: {
        addListener: () => {},
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
    badges,
    messageListeners,
    tabsUpdatedListeners,
    tabsRemovedListeners,
    historyUpdatedListeners,
  };
}

async function runWorker(bgScriptCode, env) {
  vm.runInContext(bgScriptCode, env.context);
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

async function main() {
  console.log('====================================================');
  console.log('TORI GATE 14.4.3: HLS/DASH MANIFEST EVICTION PROTECTION');
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
  // TEST 1: One HLS Manifest Followed by 100+ Media Segments
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 1: HLS Manifest + 100 Segments ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [10]);
    await runWorker(bgScriptCode, env);

    const hlsManifest = {
      url: 'https://cdn.example.com/hls/master.m3u8',
      filename: 'master.m3u8',
      content_type: 'application/x-mpegurl',
      headers: { 'content-type': 'application/x-mpegurl' },
    };

    // 1. Record HLS master manifest
    await sendMessageToWorker(env, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 10,
      candidate: hlsManifest,
    });

    // 2. Stream 120 media segments (.ts)
    for (let i = 1; i <= 120; i++) {
      await sendMessageToWorker(env, {
        action: 'RECORD_MEDIA_FROM_DOM',
        tabId: 10,
        candidate: {
          url: `https://cdn.example.com/hls/segment_${i}.ts`,
          filename: `segment_${i}.ts`,
          content_type: 'video/mp2t',
        },
      });
    }

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 10 });
    assert(res.media.length === 50, `Registry strictly bounded to 50 items (actual: ${res.media.length})`);

    const manifestFound = res.media.find((c) => c.url === hlsManifest.url);
    assert(manifestFound !== undefined, 'HLS master playlist candidate was NOT evicted after 120 segments');
    assert(manifestFound.type === 'hls', 'Preserved candidate retains type=hls');

    // Confirm that the oldest segments (e.g. segment 1..71) were evicted, while recent segments exist
    const seg1Found = res.media.find((c) => c.url.includes('segment_1.ts'));
    const seg120Found = res.media.find((c) => c.url.includes('segment_120.ts'));
    assert(!seg1Found, 'Oldest segment_1.ts was properly evicted to respect capacity');
    assert(seg120Found !== undefined, 'Latest segment_120.ts exists in registry');
  }

  // -------------------------------------------------------------------------
  // TEST 2: One DASH Manifest Followed by 100+ Media Fragments
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 2: DASH Manifest + 100 Fragments ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [20]);
    await runWorker(bgScriptCode, env);

    const dashManifest = {
      url: 'https://cdn.example.com/dash/manifest.mpd',
      filename: 'manifest.mpd',
      content_type: 'application/dash+xml',
      headers: { 'content-type': 'application/dash+xml' },
    };

    await sendMessageToWorker(env, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 20,
      candidate: dashManifest,
    });

    for (let i = 1; i <= 110; i++) {
      await sendMessageToWorker(env, {
        action: 'RECORD_MEDIA_FROM_DOM',
        tabId: 20,
        candidate: {
          url: `https://cdn.example.com/dash/frag_${i}.m4s`,
          filename: `frag_${i}.m4s`,
          content_type: 'video/iso.segment',
        },
      });
    }

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 20 });
    assert(res.media.length === 50, 'Registry holds exactly 50 candidates for DASH stream');
    const manifestFound = res.media.find((c) => c.url === dashManifest.url);
    assert(manifestFound !== undefined, 'DASH manifest.mpd was NOT evicted after 110 fragments');
    assert(
      manifestFound.type === 'dash' || manifestFound.type === 'hls',
      'Preserved candidate retains streaming manifest classification'
    );
  }

  // -------------------------------------------------------------------------
  // TEST 3: Multiple Manifests in the Same Tab
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 3: Multiple Manifests in Single Tab ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [30]);
    await runWorker(bgScriptCode, env);

    const m1 = { url: 'https://example.com/stream1.m3u8', content_type: 'application/x-mpegurl' };
    const m2 = { url: 'https://example.com/stream2.m3u8', content_type: 'application/x-mpegurl' };
    const m3 = { url: 'https://example.com/stream3.mpd', content_type: 'application/dash+xml' };

    await sendMessageToWorker(env, { action: 'RECORD_MEDIA_FROM_DOM', tabId: 30, candidate: m1 });
    await sendMessageToWorker(env, { action: 'RECORD_MEDIA_FROM_DOM', tabId: 30, candidate: m2 });
    await sendMessageToWorker(env, { action: 'RECORD_MEDIA_FROM_DOM', tabId: 30, candidate: m3 });

    // Stream 100 segments
    for (let i = 1; i <= 100; i++) {
      await sendMessageToWorker(env, {
        action: 'RECORD_MEDIA_FROM_DOM',
        tabId: 30,
        candidate: {
          url: `https://example.com/chunk_${i}.ts`,
          content_type: 'video/mp2t',
        },
      });
    }

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 30 });
    assert(res.media.length === 50, 'Registry bounded to 50 items with multiple manifests');

    const hasM1 = res.media.some((c) => c.url === m1.url);
    const hasM2 = res.media.some((c) => c.url === m2.url);
    const hasM3 = res.media.some((c) => c.url === m3.url);

    assert(hasM1 && hasM2 && hasM3, 'All 3 streaming manifests (2 HLS + 1 DASH) are simultaneously protected');
    const segmentCount = res.media.filter((c) => c.url.includes('chunk_')).length;
    assert(segmentCount === 47, `Remaining slots hold exactly 47 newest segments (actual: ${segmentCount})`);
  }

  // -------------------------------------------------------------------------
  // TEST 4: Direct MP4 Downloads FIFO Behavior
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 4: Direct MP4 Standard FIFO Eviction ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [40]);
    await runWorker(bgScriptCode, env);

    for (let i = 1; i <= 60; i++) {
      await sendMessageToWorker(env, {
        action: 'RECORD_MEDIA_FROM_DOM',
        tabId: 40,
        candidate: {
          url: `https://example.com/video_${i}.mp4`,
          filename: `video_${i}.mp4`,
          content_type: 'video/mp4',
        },
      });
    }

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 40 });
    assert(res.media.length === 50, 'Direct MP4 list bounded to 50');
    assert(!res.media.some((c) => c.url.includes('video_1.mp4')), 'Oldest direct video_1.mp4 evicted in FIFO order');
    assert(res.media.some((c) => c.url.includes('video_60.mp4')), 'Latest direct video_60.mp4 preserved');
  }

  // -------------------------------------------------------------------------
  // TEST 5: Standalone .ts and .aac Media Candidates
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 5: Standalone .ts and .aac Candidate Acceptance ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [50]);
    await runWorker(bgScriptCode, env);

    const tsCandidate = {
      url: 'https://archive.org/sample.ts',
      filename: 'sample.ts',
      content_type: 'video/mp2t',
    };
    const aacCandidate = {
      url: 'https://radio.example.com/audio.aac',
      filename: 'audio.aac',
      content_type: 'audio/aac',
    };

    await sendMessageToWorker(env, { action: 'RECORD_MEDIA_FROM_DOM', tabId: 50, candidate: tsCandidate });
    await sendMessageToWorker(env, { action: 'RECORD_MEDIA_FROM_DOM', tabId: 50, candidate: aacCandidate });

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 50 });
    assert(res.media.length === 2, 'Standalone .ts and .aac candidates are recorded and not rejected');
    assert(res.media.some((c) => c.url === tsCandidate.url), 'Standalone .ts candidate present in registry');
    assert(res.media.some((c) => c.url === aacCandidate.url), 'Standalone .aac candidate present in registry');
  }

  // -------------------------------------------------------------------------
  // TEST 6: Exact URL Deduplication
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 6: Exact URL Deduplication ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [60]);
    await runWorker(bgScriptCode, env);

    const manifest = {
      url: 'https://stream.org/live.m3u8',
      content_type: 'application/x-mpegurl',
    };

    // Send the same manifest 5 times
    for (let i = 0; i < 5; i++) {
      await sendMessageToWorker(env, { action: 'RECORD_MEDIA_FROM_DOM', tabId: 60, candidate: manifest });
    }

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 60 });
    assert(res.media.length === 1, 'Exact duplicate manifest URLs are not duplicated');
  }

  // -------------------------------------------------------------------------
  // TEST 7: Tab Isolation
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 7: Multiple Tab Isolation ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [71, 72]);
    await runWorker(bgScriptCode, env);

    await sendMessageToWorker(env, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 71,
      candidate: { url: 'https://tab71.com/master.m3u8', content_type: 'application/x-mpegurl' },
    });
    await sendMessageToWorker(env, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 72,
      candidate: { url: 'https://tab72.com/video.mp4', content_type: 'video/mp4' },
    });

    const res71 = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 71 });
    const res72 = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 72 });

    assert(res71.media.length === 1 && res71.media[0].url.includes('tab71.com'), 'Tab 71 contains only its media');
    assert(res72.media.length === 1 && res72.media[0].url.includes('tab72.com'), 'Tab 72 contains only its media');
  }

  // -------------------------------------------------------------------------
  // TEST 8: Worker Restart & Session Restoration with Protected Manifests
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 8: Worker Restart & Session Restoration ---');
  {
    const env1 = createServiceWorkerEnvironment(sharedSessionStorage, [80]);
    await runWorker(bgScriptCode, env1);

    await sendMessageToWorker(env1, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 80,
      candidate: { url: 'https://persist.com/live.m3u8', content_type: 'application/x-mpegurl' },
    });

    for (let i = 1; i <= 60; i++) {
      await sendMessageToWorker(env1, {
        action: 'RECORD_MEDIA_FROM_DOM',
        tabId: 80,
        candidate: { url: `https://persist.com/seg_${i}.ts`, content_type: 'video/mp2t' },
      });
    }

    // Allow debounce to write to chrome.storage.session
    await sleep(120);

    // Terminate Worker 1 (destroy context) and start Worker 2
    const env2 = createServiceWorkerEnvironment(sharedSessionStorage, [80]);
    await runWorker(bgScriptCode, env2);

    const res2 = await sendMessageToWorker(env2, { action: 'GET_TAB_MEDIA', tabId: 80 });
    assert(res2.media.length === 50, 'Restored registry contains 50 items');
    assert(
      res2.media.some((c) => c.url === 'https://persist.com/live.m3u8'),
      'Restored session retains the protected HLS master manifest across worker restart'
    );
  }

  // -------------------------------------------------------------------------
  // TEST 9: Full Navigation & SPA Navigation Cleanup
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 9: Full & SPA Navigation Cleanup ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [91, 92]);
    await runWorker(bgScriptCode, env);

    await sendMessageToWorker(env, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 91,
      candidate: { url: 'https://site1.com/live.m3u8', content_type: 'application/x-mpegurl' },
    });
    await sendMessageToWorker(env, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 92,
      candidate: { url: 'https://site2.com/live.mpd', content_type: 'application/dash+xml' },
    });

    // Full navigation on Tab 91
    for (const l of env.tabsUpdatedListeners) {
      l(91, { url: 'https://newdomain.com/' });
    }
    const res91 = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 91 });
    assert(res91.media.length === 0, 'Full navigation completely cleared Tab 91 manifest candidate');

    // SPA navigation on Tab 92
    for (const l of env.historyUpdatedListeners) {
      l({ frameId: 0, tabId: 92, url: 'https://site2.com/watch?v=2' });
    }
    const res92 = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 92 });
    assert(res92.media.length === 0, 'SPA navigation completely cleared Tab 92 manifest candidate');
  }

  // -------------------------------------------------------------------------
  // TEST 10: Tab Close Cleanup
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 10: Tab Close Cleanup ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [100]);
    await runWorker(bgScriptCode, env);

    await sendMessageToWorker(env, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 100,
      candidate: { url: 'https://closeme.com/master.m3u8', content_type: 'application/x-mpegurl' },
    });
    await sleep(120);

    assert(sharedSessionStorage.has('media_tab_100'), 'Storage contains media_tab_100');

    for (const l of env.tabsRemovedListeners) {
      l(100);
    }

    assert(!sharedSessionStorage.has('media_tab_100'), 'Tab close removed media_tab_100 from session storage');
    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 100 });
    assert(res.media.length === 0, 'Tab close removed media from in-memory cache');
  }

  // -------------------------------------------------------------------------
  // TEST 11: High-Priority Overflow (55 Manifests Bounded to 50 via FIFO)
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 11: High-Priority Overflow (55 Manifests) ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [110]);
    await runWorker(bgScriptCode, env);

    for (let i = 1; i <= 55; i++) {
      await sendMessageToWorker(env, {
        action: 'RECORD_MEDIA_FROM_DOM',
        tabId: 110,
        candidate: {
          url: `https://multimanifest.com/stream_${i}.m3u8`,
          content_type: 'application/x-mpegurl',
        },
      });
    }

    const res = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 110 });
    assert(res.media.length === 50, 'Manifest-only registry strictly capped at 50');
    assert(!res.media.some((c) => c.url.includes('stream_1.m3u8')), 'Oldest stream_1.m3u8 evicted via bounded FIFO');
    assert(res.media.some((c) => c.url.includes('stream_55.m3u8')), 'Newest stream_55.m3u8 present in registry');

    // Attempt to add a low-priority segment to this manifest-full registry
    await sendMessageToWorker(env, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 110,
      candidate: {
        url: 'https://multimanifest.com/low_prio_seg.ts',
        content_type: 'video/mp2t',
      },
    });

    const resAfterSeg = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 110 });
    assert(resAfterSeg.media.length === 50, 'Registry still strictly 50 items');
    assert(
      !resAfterSeg.media.some((c) => c.url.includes('low_prio_seg.ts')),
      'Low-priority segment was NOT permitted to evict any of the 50 manifests'
    );
  }

  // -------------------------------------------------------------------------
  // TEST 12: Late Manifest Arrival (Manifest Arrives After 50 Segments)
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 12: Manifest Arriving After 50 Segments ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [120]);
    await runWorker(bgScriptCode, env);

    // First, 50 segments arrive
    for (let i = 1; i <= 50; i++) {
      await sendMessageToWorker(env, {
        action: 'RECORD_MEDIA_FROM_DOM',
        tabId: 120,
        candidate: {
          url: `https://late.com/seg_${i}.ts`,
          content_type: 'video/mp2t',
        },
      });
    }

    const resPre = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 120 });
    assert(resPre.media.length === 50, 'Registry full with 50 segments');

    // Now, late master manifest arrives
    await sendMessageToWorker(env, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 120,
      candidate: {
        url: 'https://late.com/late_master.m3u8',
        content_type: 'application/x-mpegurl',
      },
    });

    // Followed by 50 more segments
    for (let i = 51; i <= 100; i++) {
      await sendMessageToWorker(env, {
        action: 'RECORD_MEDIA_FROM_DOM',
        tabId: 120,
        candidate: {
          url: `https://late.com/seg_${i}.ts`,
          content_type: 'video/mp2t',
        },
      });
    }

    const resPost = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 120 });
    assert(resPost.media.length === 50, 'Registry bounded to 50 items');
    assert(
      resPost.media.some((c) => c.url === 'https://late.com/late_master.m3u8'),
      'Late-arriving master manifest evicted oldest segment and was protected from subsequent segments'
    );
  }

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  console.log('\n====================================================');
  console.log(`GATE 14.4.3 MANIFEST PROTECTION RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error during test execution:', err);
  process.exit(1);
});
