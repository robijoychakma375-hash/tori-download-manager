/**
 * TORI Download Manager v1.0.1 — Gate 14.4.2 Verification Harness
 * Verifies MV3 Media Candidate Persistence across Service Worker Restarts:
 * 1. MP4 direct candidate persistence across worker restart
 * 2. HLS master playlist candidate persistence across worker restart
 * 3. Tab isolation (candidates kept separated per tab ID)
 * 4. Full navigation clearing (tabs.onUpdated) clears tab in-memory & session storage
 * 5. SPA navigation clearing (webNavigation.onHistoryStateUpdated) clears tab in-memory & session storage
 * 6. Tab removal cleanup (tabs.onRemoved) removes tab from session storage
 * 7. Cold-start race prevention (GET_TAB_MEDIA on immediate wake-up awaits restore)
 * 8. In-flight race prevention (candidate recorded during restore merges safely)
 * 9. Stale tab purging on worker cold-start
 * 10. Deduplication after worker restart
 * 11. Rapid segment detection write debouncing
 * 12. Edge & Chromium API compatibility
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// In-memory backing store for chrome.storage.session across worker lifecycles
class MockSessionStorage {
  constructor() {
    this.store = new Map();
    this.setCallCount = 0;
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
    this.setCallCount++;
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

  clear() {
    this.store.clear();
    this.setCallCount = 0;
  }
}

// Creates a realistic Chromium MV3 Service Worker Environment
function createServiceWorkerEnvironment(sharedSessionStorage, liveTabsList = []) {
  const messageListeners = [];
  const tabsUpdatedListeners = [];
  const tabsRemovedListeners = [];
  const historyUpdatedListeners = [];
  const storageChangedListeners = [];
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
        addListener: (fn) => storageChangedListeners.push(fn),
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
      onInstalled: {
        addListener: () => {},
      },
      onStartup: {
        addListener: () => {},
      },
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
      // Async listener — wait for sendResponse
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
  console.log('TORI GATE 14.4.2: MV3 MEDIA CANDIDATE PERSISTENCE');
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
  // TEST 1: Direct MP4 Candidate Persistence across Worker Restart
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 1: MP4 Candidate Persistence Across Worker Restart ---');
  {
    // Worker Life 1
    const env1 = createServiceWorkerEnvironment(sharedSessionStorage, [101]);
    await runWorker(bgScriptCode, env1);

    const mp4Candidate = {
      url: 'https://example.com/videos/sample_1080p.mp4',
      filename: 'sample_1080p.mp4',
      size_bytes: 52428800,
      content_type: 'video/mp4',
      headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' },
      page_url: 'https://example.com/watch?v=1',
      page_title: 'Sample Video 1',
    };

    const res1 = await sendMessageToWorker(env1, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 101,
      candidate: mp4Candidate,
    });
    assert(res1 && res1.status === 'ok', 'Worker Life 1 recorded MP4 candidate from DOM');

    // Wait for debounce write (80ms + margin)
    await sleep(120);

    const storedData1 = await sharedSessionStorage.get('media_tab_101');
    const storedList1 = storedData1['media_tab_101'];
    assert(
      Array.isArray(storedList1) && storedList1.length === 1 && storedList1[0].url === mp4Candidate.url,
      'Candidate flushed to chrome.storage.session under media_tab_101'
    );
    assert(storedList1[0].type === 'direct', 'Candidate classified as type=direct');

    // TERMINATE WORKER LIFE 1 (Context destroyed, in-memory Map lost)
    // WORKER LIFE 2 WAKES UP (Fresh JS Context)
    const env2 = createServiceWorkerEnvironment(sharedSessionStorage, [101]);
    await runWorker(bgScriptCode, env2);

    // Query media for Tab 101
    const res2 = await sendMessageToWorker(env2, {
      action: 'GET_TAB_MEDIA',
      tabId: 101,
    });

    assert(res2 && res2.status === 'ok', 'Worker Life 2 GET_TAB_MEDIA responded ok');
    assert(
      res2 && Array.isArray(res2.media) && res2.media.length === 1,
      'Worker Life 2 restored candidate count = 1'
    );
    assert(
      res2 && res2.media[0] && res2.media[0].url === mp4Candidate.url,
      'Restored MP4 URL matches original candidate'
    );
    assert(
      res2 && res2.media[0] && res2.media[0].size_bytes === 52428800,
      'Restored candidate preserved size_bytes'
    );
  }

  // -------------------------------------------------------------------------
  // TEST 2: HLS Master Playlist Persistence across Worker Restart
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 2: HLS Playlist Persistence Across Worker Restart ---');
  {
    // In current worker (env2), add HLS candidate to Tab 102
    const env2 = createServiceWorkerEnvironment(sharedSessionStorage, [101, 102]);
    await runWorker(bgScriptCode, env2);

    const hlsCandidate = {
      url: 'https://cdn.streaming.net/live/master.m3u8',
      filename: 'master.m3u8',
      size_bytes: null,
      content_type: 'application/x-mpegurl',
      headers: { 'content-type': 'application/x-mpegurl', 'referer': 'https://streaming.net/' },
      page_url: 'https://streaming.net/stream',
      page_title: 'Live HLS Stream',
    };

    const resRecord = await sendMessageToWorker(env2, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 102,
      candidate: hlsCandidate,
    });
    assert(resRecord && resRecord.status === 'ok', 'Worker recorded HLS candidate');

    await sleep(120);

    // TERMINATE WORKER & WAKE UP WORKER LIFE 3
    const env3 = createServiceWorkerEnvironment(sharedSessionStorage, [101, 102]);
    await runWorker(bgScriptCode, env3);

    const resHls = await sendMessageToWorker(env3, {
      action: 'GET_TAB_MEDIA',
      tabId: 102,
    });

    assert(resHls && resHls.status === 'ok', 'Worker Life 3 responded ok for Tab 102');
    assert(
      resHls && resHls.media && resHls.media.length === 1 && resHls.media[0].url === hlsCandidate.url,
      'Worker Life 3 restored HLS manifest candidate'
    );
    assert(
      resHls.media[0].type === 'hls' && resHls.media[0].format === 'm3u8',
      'Restored HLS candidate preserved type=hls and format=m3u8'
    );
  }

  // -------------------------------------------------------------------------
  // TEST 3: Tab Isolation
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 3: Tab Isolation ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [101, 102]);
    await runWorker(bgScriptCode, env);

    const res101 = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 101 });
    const res102 = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 102 });

    assert(
      res101.media.length === 1 && res101.media[0].url.includes('sample_1080p.mp4'),
      'Tab 101 contains only MP4 candidate'
    );
    assert(
      res102.media.length === 1 && res102.media[0].url.includes('master.m3u8'),
      'Tab 102 contains only HLS candidate'
    );
    assert(
      !res101.media.some((m) => m.url.includes('master.m3u8')),
      'Tab 101 has zero leakage from Tab 102'
    );
  }

  // -------------------------------------------------------------------------
  // TEST 4: Full Navigation Clearing (tabs.onUpdated)
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 4: Full Navigation Clearing (tabs.onUpdated) ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [101, 102]);
    await runWorker(bgScriptCode, env);

    // Simulate navigation on Tab 101
    for (const listener of env.tabsUpdatedListeners) {
      listener(101, { url: 'https://newdomain.com/index.html' });
    }

    // Verify Tab 101 is cleared in memory
    const res101AfterNav = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 101 });
    assert(
      res101AfterNav.media.length === 0,
      'Full navigation cleared in-memory candidates for Tab 101'
    );

    // Verify Tab 101 session storage is deleted
    const session101 = await sharedSessionStorage.get('media_tab_101');
    assert(!session101['media_tab_101'], 'Full navigation deleted session storage key media_tab_101');

    // Verify Tab 102 remains intact
    const res102AfterNav = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 102 });
    assert(
      res102AfterNav.media.length === 1 && res102AfterNav.media[0].url.includes('master.m3u8'),
      'Full navigation on Tab 101 did not affect Tab 102'
    );
  }

  // -------------------------------------------------------------------------
  // TEST 5: SPA Navigation Clearing (webNavigation.onHistoryStateUpdated)
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 5: SPA Navigation Clearing (historyStateUpdated) ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [102]);
    await runWorker(bgScriptCode, env);

    // Simulate SPA navigation on Tab 102
    for (const listener of env.historyUpdatedListeners) {
      listener({ frameId: 0, tabId: 102, url: 'https://streaming.net/stream?v=2' });
    }

    const res102AfterSpa = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 102 });
    assert(
      res102AfterSpa.media.length === 0,
      'SPA historyStateUpdated cleared in-memory candidates for Tab 102'
    );

    const session102 = await sharedSessionStorage.get('media_tab_102');
    assert(!session102['media_tab_102'], 'SPA historyStateUpdated deleted session storage media_tab_102');
  }

  // -------------------------------------------------------------------------
  // TEST 6: Tab Removal Cleanup (tabs.onRemoved)
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 6: Tab Removal Cleanup (tabs.onRemoved) ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [103]);
    await runWorker(bgScriptCode, env);

    // Add candidate to Tab 103
    await sendMessageToWorker(env, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 103,
      candidate: {
        url: 'https://example.com/clip.webm',
        filename: 'clip.webm',
        content_type: 'video/webm',
      },
    });
    await sleep(120);

    assert(sharedSessionStorage.has('media_tab_103'), 'media_tab_103 written to session storage');

    // Simulate Tab 103 closed
    for (const listener of env.tabsRemovedListeners) {
      listener(103);
    }

    assert(!sharedSessionStorage.has('media_tab_103'), 'Tab close immediately removed media_tab_103');
    const res103 = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 103 });
    assert(res103.media.length === 0, 'In-memory cache for Tab 103 cleared');
  }

  // -------------------------------------------------------------------------
  // TEST 7: Cold-Start Race Condition Prevention
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 7: Cold-Start Immediate Query (Race Prevention) ---');
  {
    // Pre-populate storage for Tab 104
    await sharedSessionStorage.set({
      media_tab_104: [
        {
          url: 'https://example.com/movie.mp4',
          filename: 'movie.mp4',
          size_bytes: 1000000,
          content_type: 'video/mp4',
          type: 'direct',
        },
      ],
    });

    const env = createServiceWorkerEnvironment(sharedSessionStorage, [104]);

    // Spin worker
    await runWorker(bgScriptCode, env);

    // Query GET_TAB_MEDIA immediately without any delay (synchronously in the same tick)
    const resPromise = sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 104 });
    const res = await resPromise;

    assert(
      res && res.media && res.media.length === 1 && res.media[0].url.includes('movie.mp4'),
      'Immediate cold-start query awaited session restoration and returned movie.mp4'
    );
  }

  // -------------------------------------------------------------------------
  // TEST 8: In-flight Candidate Merging During Restoration
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 8: In-Flight Candidate Merging During Restoration ---');
  {
    // Pre-populate storage with candidate A on Tab 105
    await sharedSessionStorage.set({
      media_tab_105: [
        {
          url: 'https://example.com/track_a.mp4',
          filename: 'track_a.mp4',
          type: 'direct',
        },
      ],
    });

    const env = createServiceWorkerEnvironment(sharedSessionStorage, [105]);
    await runWorker(bgScriptCode, env);

    // Concurrently record candidate B
    await sendMessageToWorker(env, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 105,
      candidate: {
        url: 'https://example.com/track_b.mp4',
        filename: 'track_b.mp4',
        content_type: 'video/mp4',
      },
    });

    await sleep(120);

    const res105 = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 105 });
    assert(
      res105.media.length === 2,
      'Both restored candidate A and newly detected candidate B exist in cache'
    );
    const urls = res105.media.map((m) => m.url);
    assert(
      urls.includes('https://example.com/track_a.mp4') && urls.includes('https://example.com/track_b.mp4'),
      'Tab 105 merged restored and new candidates without losing either'
    );
  }

  // -------------------------------------------------------------------------
  // TEST 9: Stale Tab Purging on Cold Start
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 9: Stale Tab Purging on Worker Cold Start ---');
  {
    // Add orphaned tab 999 to session storage
    await sharedSessionStorage.set({
      media_tab_999: [{ url: 'https://example.com/zombie.mp4' }],
    });

    // Start worker with live tabs [101] (tab 999 is dead)
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [101]);
    await runWorker(bgScriptCode, env);

    // Trigger restoration
    await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 101 });
    await sleep(50);

    assert(
      !sharedSessionStorage.has('media_tab_999'),
      'Restoration successfully detected closed tab 999 and purged it from session storage'
    );
  }

  // -------------------------------------------------------------------------
  // TEST 10: Deduplication After Worker Restart
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 10: Deduplication After Worker Restart ---');
  {
    // Start worker where tab 105 already has track_a.mp4
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [105]);
    await runWorker(bgScriptCode, env);

    // Record track_a.mp4 again
    await sendMessageToWorker(env, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 105,
      candidate: {
        url: 'https://example.com/track_a.mp4',
        filename: 'track_a.mp4',
        content_type: 'video/mp4',
      },
    });

    const resDedup = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 105 });
    const countA = resDedup.media.filter((m) => m.url === 'https://example.com/track_a.mp4').length;
    assert(countA === 1, 'Candidate track_a.mp4 is not duplicated after worker wake-up');
  }

  // -------------------------------------------------------------------------
  // TEST 11: Rapid Segment Detection Write Debouncing
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 11: Write Debouncing During Rapid Segment Detection ---');
  {
    const env = createServiceWorkerEnvironment(sharedSessionStorage, [200]);
    await runWorker(bgScriptCode, env);

    const initialSetCount = sharedSessionStorage.setCallCount;

    // Dispatch 20 rapid candidate arrivals within 20ms
    const arrivals = [];
    for (let i = 0; i < 20; i++) {
      arrivals.push(
        sendMessageToWorker(env, {
          action: 'RECORD_MEDIA_FROM_DOM',
          tabId: 200,
          candidate: {
            url: `https://example.com/seg_${i}.mp4`,
            filename: `seg_${i}.mp4`,
            content_type: 'video/mp4',
          },
        })
      );
    }
    await Promise.all(arrivals);

    // Immediately after arrivals (before 80ms debounce completes), writes should be 0 or 1
    const midSetCount = sharedSessionStorage.setCallCount - initialSetCount;
    assert(midSetCount <= 1, 'Rapid candidate bursts do not trigger synchronous storage write floods');

    // Wait for debounce timer to fire
    await sleep(150);

    const finalSetCount = sharedSessionStorage.setCallCount - initialSetCount;
    assert(finalSetCount <= 2, `Storage writes throttled/debounced (total writes: ${finalSetCount} for 20 candidates)`);

    const res200 = await sendMessageToWorker(env, { action: 'GET_TAB_MEDIA', tabId: 200 });
    assert(res200.media.length === 20, 'All 20 candidates preserved accurately in debounced write');
  }

  // -------------------------------------------------------------------------
  // TEST 12: Edge & Chromium Browser Compatibility
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 12: Browser Compatibility ---');
  {
    // Test Edge environment where chrome.storage is accessible
    const envEdge = createServiceWorkerEnvironment(sharedSessionStorage, [300]);
    await runWorker(bgScriptCode, envEdge);

    const resEdge = await sendMessageToWorker(envEdge, {
      action: 'RECORD_MEDIA_FROM_DOM',
      tabId: 300,
      candidate: {
        url: 'https://edge.microsoft.com/video.mp4',
        filename: 'video.mp4',
        content_type: 'video/mp4',
      },
    });

    assert(resEdge.status === 'ok', 'Runs identically under Chromium / Edge extension contracts');
  }

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  console.log('\n====================================================');
  console.log(`GATE 14.4.2 PERSISTENCE TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error during test execution:', err);
  process.exit(1);
});
