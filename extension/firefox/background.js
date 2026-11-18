/**
 * TORI Download Manager — Background Service Worker (Manifest V3)
 * Automatic Media Detection & Native Messaging Coordinator
 */

const NATIVE_HOST = 'com.tori.download_manager';
const MAX_CANDIDATES_PER_TAB = 50;

// Media format signatures
const DIRECT_MEDIA_EXTS = [
  '.mp4', '.webm', '.mkv', '.mov', '.avi', '.flv', '.wmv', '.m4v',
  '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wav', '.ts'
];

const STREAMING_MANIFEST_EXTS = ['.m3u8', '.mpd'];

const MEDIA_MIME_PREFIXES = ['video/', 'audio/'];
const HLS_MIMES = [
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'audio/x-mpegurl',
];
const DASH_MIMES = [
  'application/dash+xml',
];
const STREAMING_MIMES = [
  ...HLS_MIMES,
  ...DASH_MIMES,
];

/**
 * Determines whether a detected media candidate is an HLS or DASH streaming manifest.
 */
function isManifestCandidate(candidate) {
  if (!candidate) return false;
  if (candidate.type === 'hls' || candidate.type === 'dash') {
    return true;
  }
  const url = (candidate.url || '').toLowerCase();
  if (url.includes('.m3u8') || url.includes('.mpd')) {
    return true;
  }
  const mime = (candidate.content_type || '').toLowerCase();
  const baseMime = mime.split(';')[0].trim();
  if (
    STREAMING_MIMES.includes(baseMime) ||
    mime.includes('mpegurl') ||
    mime.includes('dash+xml')
  ) {
    return true;
  }
  return false;
}

/**
 * Prunes a candidate list to maxCount while giving higher retention priority to
 * recognized HLS and DASH manifests over ordinary media fragments.
 */
function pruneCandidateList(list, maxCount = MAX_CANDIDATES_PER_TAB) {
  if (!Array.isArray(list) || list.length <= maxCount) {
    return list || [];
  }

  let excess = list.length - maxCount;
  const pruned = [];

  // First pass: evict oldest non-manifest candidates
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (excess > 0 && !isManifestCandidate(item)) {
      excess--;
    } else {
      pruned.push(item);
    }
  }

  // Second pass: if manifests alone exceed maxCount, apply bounded FIFO among manifests
  if (pruned.length > maxCount) {
    return pruned.slice(pruned.length - maxCount);
  }

  return pruned;
}

// In-memory cache for fast synchronous access
const tabMediaCache = new Map();

// Navigation generations per tab to invalidate obsolete media states on SPA navigation
const tabGenerations = new Map();

// Active in-flight media resolution promises to prevent duplicate fetches
const activeResolutions = new Map();

// Tabs explicitly cleared or navigated during the current service worker life
const clearedTabsDuringStartup = new Set();

// Debounce storage write timers per tab to bound storage write operations
const storageWriteTimers = new Map();

// Promise managing service worker session storage restoration
let sessionRestorePromise = null;

/**
 * Restores detected media candidates from chrome.storage.session on service worker wake-up.
 * Merges safely with any network candidates received while restoration was in flight.
 */
async function restoreSessionStorage() {
  if (!chrome.storage || !chrome.storage.session) {
    return;
  }

  try {
    const allData = await chrome.storage.session.get(null);
    const liveTabs = await chrome.tabs.query({}).catch(() => []);
    const liveTabIds = new Set(liveTabs.map((t) => t.id));
    const keysToRemove = [];

    for (const [key, value] of Object.entries(allData || {})) {
      if (!key.startsWith('media_tab_')) continue;
      const tabId = parseInt(key.replace('media_tab_', ''), 10);
      if (isNaN(tabId)) continue;

      // Clean up stale session keys if tab is no longer open or was cleared during startup
      if (!liveTabIds.has(tabId) || clearedTabsDuringStartup.has(tabId)) {
        keysToRemove.push(key);
        continue;
      }

      if (Array.isArray(value) && value.length > 0) {
        const existing = tabMediaCache.get(tabId) || [];
        if (existing.length === 0) {
          tabMediaCache.set(tabId, pruneCandidateList(value, MAX_CANDIDATES_PER_TAB));
        } else {
          // Merge: preserved restored items + newly arrived items in this wake cycle (dedup by url)
          const seenUrls = new Set(value.map((c) => c.url));
          const merged = [...value];
          for (const item of existing) {
            if (!seenUrls.has(item.url)) {
              seenUrls.add(item.url);
              merged.push(item);
            }
          }
          tabMediaCache.set(tabId, pruneCandidateList(merged, MAX_CANDIDATES_PER_TAB));
        }

        // Restore badge count if enabled
        if (extSettings.badge !== false) {
          const count = (tabMediaCache.get(tabId) || []).length;
          if (count > 0) {
            chrome.action.setBadgeText({ tabId, text: String(count) }).catch(() => { });
            chrome.action.setBadgeBackgroundColor({ tabId, color: '#6366f1' }).catch(() => { });
          }
        }
      }
    }

    if (keysToRemove.length > 0) {
      await chrome.storage.session.remove(keysToRemove).catch(() => { });
    }
  } catch (err) {
    console.warn('[TORI] Failed to restore session media cache:', err);
  }
}

function ensureSessionRestored() {
  if (!sessionRestorePromise) {
    sessionRestorePromise = restoreSessionStorage();
  }
  return sessionRestorePromise;
}

// Proactive restoration trigger on service worker start
ensureSessionRestored();

/**
 * Schedules a debounced write to chrome.storage.session for a specific tab.
 * Bounded to 80ms to avoid thrashing storage during rapid segment streaming.
 */
function scheduleSessionWrite(tabId) {
  if (!chrome.storage || !chrome.storage.session) return;
  if (storageWriteTimers.has(tabId)) {
    return;
  }

  const timerId = setTimeout(async () => {
    storageWriteTimers.delete(tabId);
    const list = tabMediaCache.get(tabId);
    const key = `media_tab_${tabId}`;
    try {
      if (list && list.length > 0) {
        await chrome.storage.session.set({ [key]: list });
      } else {
        await chrome.storage.session.remove(key);
      }
    } catch (_) { }
  }, 80);

  storageWriteTimers.set(tabId, timerId);
}

function cancelPendingStorageWrite(tabId) {
  if (storageWriteTimers.has(tabId)) {
    clearTimeout(storageWriteTimers.get(tabId));
    storageWriteTimers.delete(tabId);
  }
}

/**
 * Clears media candidates for a tab on page reload or URL navigation.
 */
function clearTabMedia(tabId) {
  clearedTabsDuringStartup.add(tabId);
  cancelPendingStorageWrite(tabId);
  tabMediaCache.delete(tabId);
  const nextGen = (tabGenerations.get(tabId) || 0) + 1;
  tabGenerations.set(tabId, nextGen);

  if (chrome.storage && chrome.storage.session) {
    chrome.storage.session.remove(`media_tab_${tabId}`).catch(() => { });
  }
  if (extSettings.badge !== false) {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => { });
  }
}

/**
 * Completely removes tab media and generations when a tab is closed.
 */
function removeTabMedia(tabId) {
  clearedTabsDuringStartup.add(tabId);
  cancelPendingStorageWrite(tabId);
  tabMediaCache.delete(tabId);
  tabGenerations.delete(tabId);

  if (chrome.storage && chrome.storage.session) {
    chrome.storage.session.remove(`media_tab_${tabId}`).catch(() => { });
  }
}

const DEFAULT_CAPTURE_TYPES = [
  'zip', 'rar', '7z', 'iso', 'tar', 'gz', 'bz2', 'xz',
  'exe', 'msi', 'dmg', 'bin',
  'pdf', 'epub',
  'mkv', 'mp4', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus'
];

const LEGACY_DEFAULT_TYPES = ['zip', 'rar', '7z', 'iso', 'exe', 'dmg', 'pdf', 'mp4', 'mp3'];

function normalizeCaptureTypes(types) {
  if (!Array.isArray(types) || types.length === 0) {
    return [...DEFAULT_CAPTURE_TYPES];
  }
  const clean = types.map((t) => (t || '').toLowerCase().replace(/^\./, '').trim()).filter(Boolean);
  const isLegacy = clean.length === LEGACY_DEFAULT_TYPES.length &&
    LEGACY_DEFAULT_TYPES.every((t) => clean.includes(t));
  if (isLegacy) {
    return [...DEFAULT_CAPTURE_TYPES];
  }
  if (!clean.includes('mkv')) {
    clean.push('mkv');
  }
  return clean;
}

// Extension configuration synchronized with storage
let extSettings = {
  port: 6800,
  key: '',
  auto: true,
  cap: true,
  min: 1,
  ask: false,
  alt: true,
  incog: false,
  pill: true,
  pos: 'Top right',
  picker: true,
  kind: 'Video',
  fmt: 'Best available',
  audio: true,
  badge: true,
  theme: 'light',
  accent: 'indigo',
  sites: ['docs.google.com', 'mail.google.com', 'github.com'],
  types: [...DEFAULT_CAPTURE_TYPES],
};

let settingsLoadPromise = null;

function ensureSettingsLoaded() {
  if (!settingsLoadPromise) {
    settingsLoadPromise = new Promise((resolve) => {
      chrome.storage.local.get(['tori_settings', 'tori_theme', 'tori_accent'], (res) => {
        if (res.tori_settings) {
          extSettings = { ...extSettings, ...res.tori_settings };
          extSettings.types = normalizeCaptureTypes(extSettings.types);
        } else {
          extSettings.types = [...DEFAULT_CAPTURE_TYPES];
        }
        if (res.tori_theme) extSettings.theme = res.tori_theme;
        if (res.tori_accent) extSettings.accent = res.tori_accent;
        resolve(extSettings);
      });
    });
  }
  return settingsLoadPromise;
}

// Initial settings load on service worker start
ensureSettingsLoaded();

chrome.storage.onChanged.addListener((changes) => {
  if (changes.tori_settings?.newValue) {
    const prevBadge = extSettings.badge !== false;
    extSettings = { ...extSettings, ...changes.tori_settings.newValue };
    if (extSettings.types) {
      extSettings.types = normalizeCaptureTypes(extSettings.types);
    }
    const nextBadge = extSettings.badge !== false;
    if (prevBadge !== nextBadge) {
      for (const [tabId, list] of tabMediaCache.entries()) {
        const txt = nextBadge && list.length > 0 ? String(list.length) : '';
        chrome.action.setBadgeText({ tabId, text: txt }).catch(() => {});
      }
    }
  }
  if (changes.tori_theme?.newValue) {
    extSettings.theme = changes.tori_theme.newValue;
  }
  if (changes.tori_accent?.newValue) {
    extSettings.accent = changes.tori_accent.newValue;
  }
});

// Listen for client-side / SPA history updates (YouTube, Facebook, Instagram, etc.)
if (chrome.webNavigation && chrome.webNavigation.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId === 0) {
      clearTabMedia(details.tabId);
      const nextGen = tabGenerations.get(details.tabId) || 1;
      chrome.tabs.sendMessage(details.tabId, {
        action: 'MEDIA_NAVIGATED',
        url: details.url,
        generation: nextGen,
      }).catch(() => { });
    }
  });
}

// Clean up tab state when tab is closed or navigated
chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabMedia(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || (changeInfo.status === 'loading' && changeInfo.url)) {
    clearTabMedia(tabId);
  }
});

/**
 * Derives a sanitized, policy-compliant Referer URL according to W3C strict-origin-when-cross-origin.
 * Strips credentials, fragment, and query parameters to prevent token/session leakage.
 * Rejects non-HTTP schemes and HTTPS->HTTP downgrades.
 */
function deriveSafeReferer(pageUrl, targetUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return null;
  const pTrim = pageUrl.trim();
  if (!pTrim || pTrim.length > 4096) return null;

  // Strict check: no control characters or CRLF
  for (let i = 0; i < pTrim.length; i++) {
    const code = pTrim.charCodeAt(i);
    if (code <= 31 || code === 127) return null;
  }

  let pUrl, tUrl;
  try {
    pUrl = new URL(pTrim);
  } catch {
    return null;
  }

  if (pUrl.protocol !== 'http:' && pUrl.protocol !== 'https:') {
    return null;
  }

  if (targetUrl && typeof targetUrl === 'string') {
    try {
      tUrl = new URL(targetUrl.trim());
      // Strict downgrade protection: HTTPS -> HTTP emits no referer
      if (pUrl.protocol === 'https:' && tUrl.protocol === 'http:') {
        return null;
      }
      // Strict cross-origin: if origins differ, emit origin only
      if (pUrl.origin !== tUrl.origin) {
        return pUrl.origin + '/';
      }
    } catch {
      return pUrl.origin + '/';
    }
  }

  return pUrl.origin + pUrl.pathname;
}

/**
 * Obtains and sanitizes the browser runtime's User-Agent string.
 * Rejects CRLF, ASCII control characters, and lengths exceeding 1024 characters.
 */
function getSafeUserAgent(customUserAgent) {
  let ua = null;
  if (typeof customUserAgent === 'string' && customUserAgent.trim()) {
    ua = customUserAgent.trim();
  } else if (typeof navigator !== 'undefined' && navigator && navigator.userAgent) {
    ua = navigator.userAgent.trim();
  }

  if (!ua || ua.length > 1024) return null;

  for (let i = 0; i < ua.length; i++) {
    const code = ua.charCodeAt(i);
    if (code <= 31 || code === 127) return null;
  }

  return ua;
}

function normalizePlatformUrl(rawUrl) {
  if (!rawUrl) return { url: '', videoId: '', isSpecific: false, platform: 'unknown' };
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    const path = u.pathname;

    if (host.includes('facebook.com') || host.includes('fb.watch')) {
      // 1. Check for watch URL with query param ?v=<id>
      const v = u.searchParams.get('v');
      if (v && /^\d+$/.test(v)) {
        return {
          url: `https://www.facebook.com/watch/?v=${v}`,
          videoId: v,
          isSpecific: true,
          platform: 'facebook',
        };
      }

      // 2. Generic home or feed URLs without a specific item ID
      if (
        path === '/' ||
        path === '' ||
        path === '/reel' ||
        path === '/reel/' ||
        path === '/reels' ||
        path === '/reels/' ||
        path === '/watch' ||
        path === '/watch/'
      ) {
        return {
          url: `https://www.facebook.com${path}`,
          videoId: '',
          isSpecific: false,
          platform: 'facebook',
        };
      }

      // 3. /reel/<id> or /reels/<id> (plural reels -> canonical /reel/<id>)
      const reelMatch = path.match(/\/(?:reel|reels)\/([^/?#]+)/i);
      if (reelMatch && reelMatch[1] && reelMatch[1] !== 'audio') {
        return {
          url: `https://www.facebook.com/reel/${reelMatch[1]}`,
          videoId: reelMatch[1],
          isSpecific: true,
          platform: 'facebook',
        };
      }

      // 4. /share/r/<id> or /share/v/<id>
      const shareMatch = path.match(/\/share\/([rv])\/([^/?#]+)/i);
      if (shareMatch && shareMatch[2]) {
        const isReel = shareMatch[1].toLowerCase() === 'r';
        return {
          url: isReel
            ? `https://www.facebook.com/reel/${shareMatch[2]}`
            : `https://www.facebook.com/watch/?v=${shareMatch[2]}`,
          videoId: shareMatch[2],
          isSpecific: true,
          platform: 'facebook',
        };
      }

      // 5. /<user>/videos/<id> or /<user>/reels/<id> or /videos/<id>
      const videoMatch = path.match(/\/(?:videos|watch|p)\/([^/?#]+)/i);
      if (videoMatch && videoMatch[1]) {
        return {
          url: `https://www.facebook.com/watch/?v=${videoMatch[1]}`,
          videoId: videoMatch[1],
          isSpecific: true,
          platform: 'facebook',
        };
      }

      // 6. fb.watch/<id>
      if (host.includes('fb.watch')) {
        const watchId = path.replace(/^\//, '').split('/')[0];
        if (watchId) {
          return {
            url: `https://fb.watch/${watchId}`,
            videoId: watchId,
            isSpecific: true,
            platform: 'facebook',
          };
        }
      }

      return {
        url: `${u.origin}${path}`,
        videoId: '',
        isSpecific: false,
        platform: 'facebook',
      };
    }

    if (host.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) {
        return {
          url: `https://${u.hostname}/watch?v=${v}`,
          videoId: v,
          isSpecific: true,
          platform: 'youtube',
        };
      }
    } else if (host.includes('youtu.be')) {
      const v = path.replace(/^\//, '').split('/')[0];
      if (v) {
        return {
          url: `https://youtu.be/${v}`,
          videoId: v,
          isSpecific: true,
          platform: 'youtube',
        };
      }
    } else if (host.includes('instagram.com')) {
      const match = path.match(/\/(?:[a-zA-Z0-9._]+\/)?(reel|reels|p|tv)\/([^/?#]+)/i);
      const reserved = new Set(['audio', 'effects', 'videos', 'explore', 'reels', 'reel', 'p', 'tv']);
      if (match && match[2] && !reserved.has(match[2].toLowerCase())) {
        const rawKind = match[1].toLowerCase();
        const kind = rawKind === 'p' ? 'p' : rawKind === 'tv' ? 'tv' : 'reel';
        return {
          url: `https://www.instagram.com/${kind}/${match[2]}/`,
          videoId: match[2],
          isSpecific: true,
          platform: 'instagram',
        };
      }
      return {
        url: `${u.origin}${path}`,
        videoId: '',
        isSpecific: false,
        platform: 'instagram',
      };
    } else if (host.includes('vimeo.com') && !host.includes('player.vimeo.com')) {
      const segments = path.split('/').filter(Boolean);
      const last = segments[segments.length - 1];
      if (last && /^\d+$/.test(last)) {
        return {
          url: `https://player.vimeo.com/video/${last}`,
          videoId: last,
          isSpecific: true,
          platform: 'vimeo',
        };
      }
    }

    return {
      url: rawUrl,
      videoId: rawUrl,
      isSpecific: true,
      platform: 'generic',
    };
  } catch (_) {
    return { url: rawUrl, videoId: rawUrl, isSpecific: false, platform: 'unknown' };
  }
}

/**
 * Sanitizes URLs for diagnostic logging, removing sensitive tokens, keys, signatures, and cookies
 */
function sanitizeLogUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    const sensitive = ['token', 'auth', 'sig', 'signature', 'key', 'pass', 'session', 'hmac', 'secret', 'oe', 'oh'];
    for (const p of sensitive) {
      if (u.searchParams.has(p)) {
        u.searchParams.set(p, '[redacted]');
      }
    }
    return u.toString();
  } catch (_) {
    return (rawUrl || '').split('?')[0];
  }
}

/**
 * Structured diagnostic logger ensuring NO secrets/tokens/credentials are ever emitted
 */
function logSanitizedDiagnostic(stage, details) {
  const sanitizedUrl = sanitizeLogUrl(details.url);
  console.log(`[TORI Diagnostic] [${stage}]`, {
    requestId: details.requestId || 'n/a',
    url: sanitizedUrl,
    method: details.method || 'GET',
    extractor: details.extractor || 'n/a',
    protocol: details.protocol || 'n/a',
    durationMs: details.durationMs || 0,
    outcome: details.outcome || 'pending',
    errorCategory: details.errorCategory || null,
  });
}

/**
 * Determine endpoint-specific timeout deadline
 */
function getEndpointTimeout(endpoint, customTimeout = null) {
  if (typeof customTimeout === 'number' && customTimeout > 0) {
    return customTimeout;
  }
  if (endpoint.startsWith('/api/v1/media/resolve')) {
    // Media resolution: coordinated with backend 30s timeout, giving 35s total deadline
    return 35000;
  }
  if (endpoint.startsWith('/api/v1/media/playlist/open')) {
    // Coordinated with Desktop UI mount confirmation timeout (12s) + startup margin
    return 15000;
  }
  if (endpoint.startsWith('/api/v1/media/download') || endpoint.startsWith('/api/v1/downloads')) {
    // Download enqueue operations or listings: bounded 12s timeout
    return 12000;
  }
  if (endpoint.startsWith('/api/v1/ping') || endpoint.startsWith('/api/v1/status')) {
    // Fast health checks: 4s timeout
    return 4000;
  }
  // Default for other commands (pause, resume, cancel, show window, etc.): 10s
  return 10000;
}

/**
 * Native Messaging helper with timeout and graceful error reporting
 */
async function sendNativeMessage(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, (response) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          resolve({
            status: 'error',
            message: lastErr.message || 'Could not communicate with TORI desktop native host.',
            desktop_running: false,
          });
        } else {
          resolve(response || { status: 'ok' });
        }
      });
    } catch (err) {
      resolve({
        status: 'error',
        message: err.message || 'Native messaging invocation failed.',
        desktop_running: false,
      });
    }
  });
}

// Automatic Native Messaging auto-pair and candidate port sweep rate limiting
let lastAutoPairAttempt = 0;
const AUTO_PAIR_COOLDOWN_MS = 10000; // 10s cooldown for automatic native messaging invocations

let lastCandidateSweep = 0;
const CANDIDATE_SWEEP_COOLDOWN_MS = 8000; // 8s cooldown between candidate port sweeps

/**
 * One-time secure auto-pairing via Native Messaging bound to this extension.
 * Supports force=true to bypass the 10s failure cooldown (e.g. on explicit user click).
 */
async function autoPairWithDesktop(force = false) {
  const now = Date.now();
  if (!force && now - lastAutoPairAttempt < AUTO_PAIR_COOLDOWN_MS) {
    return { ok: false, error: 'Auto-pairing cooldown active (desktop offline)', cooledDown: true };
  }
  lastAutoPairAttempt = now;
  try {
    const res = await sendNativeMessage({ action: 'pair' });
    if (res && res.status === 'ok' && res.token) {
      extSettings.key = res.token;
      if (res.port) extSettings.port = res.port;
      await chrome.storage.local.set({ tori_settings: extSettings });
      console.log('[TORI] Auto-paired successfully with desktop. Port:', extSettings.port);
      return { ok: true, token: res.token, port: extSettings.port };
    }
    return { ok: false, error: res?.message || 'Native host did not return pairing token' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Localhost HTTP API client with endpoint-aware timeout, auto-recovery, and authentication
 */
async function callDesktopApi(
  endpoint,
  method = 'GET',
  body = null,
  customTimeout = null,
  customPort = null,
  customToken = null,
  isRetry = false
) {
  await ensureSettingsLoaded();

  let port = customPort || extSettings.port || 6800;
  let token = customToken !== null && customToken !== undefined ? customToken : (extSettings.key || '');

  // Proactive auto-pairing if key is empty and this endpoint requires auth
  if (!token && !endpoint.startsWith('/api/v1/ping')) {
    const pairRes = await autoPairWithDesktop(false);
    if (pairRes.ok && pairRes.token) {
      token = pairRes.token;
      if (!customPort && pairRes.port) port = pairRes.port;
    }
  }

  const url = `http://127.0.0.1:${port}${endpoint}`;
  const headers = {
    'X-Tori-Token': token,
  };
  if (body && (method === 'POST' || method === 'PUT')) {
    headers['Content-Type'] = 'application/json';
  }

  const timeoutDuration = getEndpointTimeout(endpoint, customTimeout);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await res.json().catch(() => ({}));

    // Auto-recovery: if 401 Unauthorized, token may be invalidated; attempt re-pairing once
    if (res.status === 401 && !isRetry) {
      console.warn('[TORI] 401 Unauthorized from desktop API. Attempting auto-pairing via Native Messaging...');
      const pairRes = await autoPairWithDesktop(false);
      if (pairRes && pairRes.ok && pairRes.token) {
        return callDesktopApi(endpoint, method, body, customTimeout, port, pairRes.token, true);
      }
    }

    return {
      ok: res.ok,
      status: res.status,
      data,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    let errorMsg = err.message;
    let code = 'NETWORK_ERROR';
    if (err.name === 'AbortError') {
      code = 'TIMEOUT';
      if (endpoint.startsWith('/api/v1/media/resolve')) {
        errorMsg = `Media resolution timed out (${Math.round(timeoutDuration / 1000)}s). The server or platform took too long to respond.`;
      } else if (endpoint.startsWith('/api/v1/ping') || endpoint.startsWith('/api/v1/status')) {
        errorMsg = 'Desktop health check timed out (4s). Is TORI running?';
      } else {
        errorMsg = `Request timed out after ${Math.round(timeoutDuration / 1000)}s`;
      }
    } else if (err && (err.name === 'TypeError' || (err.message && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError'))))) {
      // Auto-recovery: if connection failed on the default/configured port, try candidate ports or auto-launch
      if (!isRetry && !customPort) {
        const now = Date.now();
        // 1. Probe candidate ports (6800-6803) with bounded cooldown
        if (now - lastCandidateSweep >= CANDIDATE_SWEEP_COOLDOWN_MS) {
          lastCandidateSweep = now;
          const candidates = [6800, 6801, 6802, 6803].filter((p) => p !== port);
          for (const candPort of candidates) {
            try {
              const probeCtrl = new AbortController();
              const probeTimer = setTimeout(() => probeCtrl.abort(), 500);
              const probeHeaders = {};
              if (token) probeHeaders['X-Tori-Token'] = token;
              const probeRes = await fetch(`http://127.0.0.1:${candPort}/api/v1/ping`, {
                headers: probeHeaders,
                signal: probeCtrl.signal,
              });
              clearTimeout(probeTimer);
              if (probeRes.ok) {
                const probeData = await probeRes.json().catch(() => ({}));
                if (
                  probeData &&
                  probeData.status === 'ok' &&
                  probeData.name === 'TORI Download Manager' &&
                  probeData.engine_active === true
                ) {
                  console.log(`[TORI] Discovered authoritative desktop server on port ${candPort} (authenticated: ${probeData.authenticated})`);
                  extSettings.port = candPort;
                  let activeToken = token;
                  if (!probeData.authenticated) {
                    // Token expired or mismatched: pair via Native Messaging with local SQLite DB
                    const pairRes = await autoPairWithDesktop(false);
                    if (pairRes && pairRes.ok && pairRes.token) {
                      activeToken = pairRes.token;
                    }
                  } else {
                    await chrome.storage.local.set({ tori_settings: extSettings });
                  }
                  return callDesktopApi(endpoint, method, body, customTimeout, candPort, activeToken, true);
                }
              }
            } catch (_) { }
          }
        }

        // 2. If candidate ports failed, attempt to launch / wake TORI via Native Messaging (bounded by cooldown)
        if (now - lastAutoPairAttempt >= AUTO_PAIR_COOLDOWN_MS) {
          console.log('[TORI] Desktop unreachable on candidate ports. Attempting auto-launch via Native Messaging...');
          const launchRes = await autoPairWithDesktop(false);
          if (launchRes && launchRes.ok) {
            // Allow desktop engine HTTP listener a brief moment to bind
            await new Promise((r) => setTimeout(r, 600));
            const newPort = launchRes.port || extSettings.port || 6800;
            return callDesktopApi(endpoint, method, body, customTimeout, newPort, launchRes.token || token, true);
          }
        }
      }
      errorMsg = 'Could not connect to TORI Desktop at 127.0.0.1:' + port + '. Is TORI running?';
    }
    return {
      ok: false,
      status: 0,
      code,
      error: errorMsg,
    };
  }
}

const inFlightPlaylistOpens = new Map();

/**
 * Coordinates opening the Desktop Playlist modal with explicit pairing retry,
 * cold-launch Native Messaging fallback, and deduplication of concurrent clicks.
 */
async function openPlaylistInDesktopWithDedup(rawUrl) {
  const existing = inFlightPlaylistOpens.get(rawUrl);
  if (existing) {
    return existing;
  }

  const run = (async () => {
    let httpRes = await callDesktopApi('/api/v1/media/playlist/open', 'POST', { url: rawUrl }, 15000);

    if (httpRes && httpRes.status === 401) {
      const pairRes = await autoPairWithDesktop(true);
      if (pairRes && pairRes.ok && pairRes.token) {
        httpRes = await callDesktopApi(
          '/api/v1/media/playlist/open',
          'POST',
          { url: rawUrl },
          15000,
          pairRes.port || null,
          pairRes.token,
          true
        );
      }
    }

    if (httpRes && httpRes.ok && httpRes.data) {
      return httpRes.data;
    }

    if (httpRes && httpRes.status && httpRes.status > 0 && httpRes.status !== 404) {
      return {
        status: 'error',
        confirmed: false,
        httpStatus: httpRes.status,
        message:
          httpRes.data?.message ||
          httpRes.error ||
          `TORI Desktop rejected playlist request (HTTP ${httpRes.status}).`,
      };
    }

    const nativeRes = await sendNativeMessage({ action: 'open_playlist', url: rawUrl });
    if (nativeRes && nativeRes.status === 'ok') {
      autoPairWithDesktop(true).catch(() => {});
      return nativeRes;
    }

    const nativeMsg = nativeRes?.message || '';
    if (httpRes?.status === 404 || /unknown action/i.test(nativeMsg)) {
      return {
        status: 'error',
        confirmed: false,
        code: 'UNSUPPORTED_DESKTOP_VERSION',
        message:
          'Installed TORI Desktop version does not support Playlist Download. Please update or reinstall TORI Desktop.',
      };
    }

    return {
      status: 'error',
      confirmed: false,
      message:
        nativeMsg ||
        httpRes?.error ||
        'Could not launch or reach TORI Desktop. Please open TORI Download Manager and try again.',
    };
  })().finally(() => {
    inFlightPlaylistOpens.delete(rawUrl);
  });

  inFlightPlaylistOpens.set(rawUrl, run);
  return run;
}

// Proactive pairing on startup if unconfigured (wait for stored settings first!)
chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettingsLoaded();
  if (!extSettings.key) {
    autoPairWithDesktop(false);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSettingsLoaded();
  if (!extSettings.key) {
    autoPairWithDesktop(false);
  }
});

/**
 * Parse filename from Content-Disposition header
 */
function parseContentDispositionFilename(headerVal) {
  if (!headerVal) return null;
  const utf8Match = headerVal.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch (_) { }
  }
  const simpleMatch = headerVal.match(/filename="?([^";]+)"?/i);
  if (simpleMatch && simpleMatch[1]) {
    return simpleMatch[1].trim();
  }
  return null;
}

/**
 * Extract clean filename from URL
 */
function extractFilenameFromUrl(rawUrl) {
  try {
    if (rawUrl.startsWith('magnet:')) {
      const match = rawUrl.match(/dn=([^&]+)/i);
      if (match && match[1]) {
        return decodeURIComponent(match[1].replace(/\+/g, ' '));
      }
      return 'magnet_torrent';
    }
    const u = new URL(rawUrl);
    const pathname = u.pathname;
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      const clean = decodeURIComponent(last).split('?')[0].split('#')[0];
      if (clean && clean.includes('.')) {
        return clean;
      }
    }
  } catch (_) { }
  return 'media_file';
}

function isTransientCdnUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes('.fbcdn.net') ||
    lower.includes('.cdninstagram.com') ||
    lower.includes('.tiktokcdn.com') ||
    lower.includes('.googlevideo.com') ||
    lower.includes('video.twimg.com') ||
    (lower.includes('oe=') && lower.includes('oh='))
  );
}

function isManagedPlatform(urlOrHost) {
  if (!urlOrHost) return false;
  const lower = urlOrHost.toLowerCase();
  return (
    lower.includes('facebook.com') ||
    lower.includes('fb.watch') ||
    lower.includes('instagram.com') ||
    lower.includes('tiktok.com') ||
    lower.includes('youtube.com') ||
    lower.includes('youtu.be') ||
    lower.includes('twitter.com') ||
    lower.includes('x.com') ||
    lower.includes('reddit.com')
  );
}

/**
 * Classify media item
 */
function isMediaSegment(lowerUrl, lowerMime, headers = [], statusCode = 200, tabId = -1) {
  // 1. Definite segment extensions
  if (
    lowerUrl.includes('.m4s') ||
    lowerUrl.includes('.cmfv') ||
    lowerUrl.includes('.cmfa')
  ) {
    const fmt = lowerUrl.includes('.m4s') ? 'M4S' : (lowerUrl.includes('.cmfv') ? 'CMFV' : 'CMFA');
    return { isSegment: true, format: fmt };
  }

  // 2. Definite segment MIME types
  if (
    lowerMime.includes('iso.segment') ||
    lowerMime.includes('application/vnd.apple.mpegurl.segment')
  ) {
    return { isSegment: true, format: 'SEGMENT' };
  }

  // 3. Segment URL path patterns (e.g. segment_1.ts, seg-10.ts, chunk_005.aac, frag-3.mp4, slice_12.ts)
  const segmentPatternRegex = /(?:[/-]|_|\b)(?:segment|seg|chunk|fragment|frag|slice|part)[-_]?\d+/i;
  const isNumberedSegment = segmentPatternRegex.test(lowerUrl);

  // Initialization segments (init.mp4, init.m4s, etc.)
  const isInitSegment = /(?:[/-]|_)init(?:[/-]|_|\.)(?:mp4|m4s|cmfv|cmfa|ts)/i.test(lowerUrl) || lowerUrl.endsWith('/init.mp4');

  // Query parameter chunk index indicators: e.g. ?sq=1, ?segment=2, ?frag=3
  const isQueryNumbered = /[?&](?:sq|segment|frag|chunk|slice|part)=\d+/i.test(lowerUrl);

  // Byte-range query parameters: e.g. ?range=100-200 or ?bytestart=0&byteend=1000
  const isQueryRange = /[?&](?:range|bytestart|byteend)=\d+/i.test(lowerUrl);

  // Check HTTP byte range headers
  let hasByteRangeHeader = false;
  let isSmallRangeChunk = false;
  let isFullMediaWithRanges = false;
  if (Array.isArray(headers) && headers.length > 0) {
    for (const h of headers) {
      const hName = (h.name || '').toLowerCase();
      if (hName === 'content-range') {
        hasByteRangeHeader = true;
        const m = (h.value || '').match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = parseInt(m[2], 10);
          const total = m[3] === '*' ? null : parseInt(m[3], 10);
          const chunkSize = end - start;
          if (total && total > 5 * 1024 * 1024) {
            isFullMediaWithRanges = true;
          } else if (chunkSize > 0 && chunkSize < 4 * 1024 * 1024) {
            isSmallRangeChunk = true;
          }
        }
      }
    }
  }

  const hasTsExt = lowerUrl.includes('.ts');
  const hasAacExt = lowerUrl.includes('.aac');
  const hasMp4Ext = lowerUrl.includes('.mp4');

  // If numbered segment pattern, init segment, or query chunk index:
  if (isNumberedSegment || isInitSegment || isQueryNumbered) {
    const fmt = hasTsExt ? 'TS (segment)' : (hasAacExt ? 'AAC (segment)' : (hasMp4Ext ? 'MP4 (segment)' : 'SEGMENT'));
    return { isSegment: true, format: fmt };
  }

  // If byte-range streaming indicator:
  if (!isFullMediaWithRanges) {
    if (isQueryRange || (hasByteRangeHeader && isSmallRangeChunk && (hasTsExt || lowerUrl.includes('frag') || lowerUrl.includes('segment')))) {
      const fmt = hasTsExt ? 'TS (segment)' : (hasMp4Ext ? 'MP4 (segment)' : 'SEGMENT');
      return { isSegment: true, format: fmt };
    }
  }

  // Tab manifest context check:
  if (tabId > 0 && tabMediaCache.has(tabId)) {
    const cached = tabMediaCache.get(tabId) || [];
    const hasManifest = cached.some((c) => c.type === 'hls' || c.type === 'dash');
    if (hasManifest) {
      if (hasTsExt && (lowerMime.includes('mp2t') || lowerMime.includes('video/'))) {
        return { isSegment: true, format: 'TS (segment)' };
      }
    }
  }

  return { isSegment: false, format: '' };
}

function classifyMedia(url, mimeType, headers = [], statusCode = 200, tabId = -1) {
  const lowerUrl = url.toLowerCase();
  const lowerMime = (mimeType || '').toLowerCase();

  // Check DRM and platform protection
  if (lowerUrl.includes('watch.plex.tv') || lowerUrl.includes('plex.tv')) {
    return {
      type: 'protected',
      format: 'DRM Protected',
      supported: false,
      notice: 'watch.plex.tv content is DRM-protected and not licensed for offline download',
    };
  }
  if (lowerUrl.includes('widevine') || lowerUrl.includes('playready') || lowerUrl.includes('fairplay')) {
    return {
      type: 'protected',
      format: 'DRM Protected',
      supported: false,
      notice: 'This stream is protected by DRM and cannot be downloaded offline',
    };
  }

  // Check magnet and torrent
  if (lowerUrl.startsWith('magnet:')) {
    return {
      type: 'torrent',
      format: 'MAGNET',
      supported: true,
      notice: 'BitTorrent P2P magnet link with DHT & piece verification',
    };
  }

  // Live streaming protocols
  if (lowerUrl.startsWith('rtsp://')) {
    return {
      type: 'live',
      format: 'RTSP',
      supported: true,
      notice: 'RTSP live stream recording with TCP interleaved transport & fragmented MP4',
    };
  }
  if (lowerUrl.startsWith('rtmp://') || lowerUrl.startsWith('rtmps://')) {
    return {
      type: 'live',
      format: 'RTMP',
      supported: true,
      notice: 'RTMP/RTMPS live stream recording with stream copy',
    };
  }
  if (lowerUrl.startsWith('srt://')) {
    return {
      type: 'live',
      format: 'SRT',
      supported: true,
      notice: 'SRT secure reliable transport live stream recording',
    };
  }
  if (lowerUrl.startsWith('rist://') || lowerUrl.startsWith('rtp://') || lowerUrl.startsWith('udp://')) {
    return {
      type: 'live',
      format: 'LIVE',
      supported: true,
      notice: 'Low-latency broadcast live stream recording',
    };
  }

  if (lowerUrl.includes('.torrent') || lowerMime.includes('application/x-bittorrent')) {
    return {
      type: 'torrent',
      format: 'TORRENT',
      supported: true,
      notice: 'BitTorrent metainfo file with librqbit piece verification',
    };
  }

  // Check streaming manifests
  const baseMime = lowerMime.split(';')[0].trim();

  // Check DASH streaming manifests
  if (
    lowerUrl.includes('.mpd') ||
    DASH_MIMES.includes(baseMime) ||
    lowerMime.includes('dash+xml')
  ) {
    return {
      type: 'dash',
      format: 'DASH (mpd)',
      is_segment: false,
      supported: true,
      notice: 'ISO/IEC 23009-1 MPEG-DASH VOD stream with parallel segment downloading & FFmpeg container muxing',
    };
  }

  // Check HLS streaming manifests
  if (
    lowerUrl.includes('.m3u8') ||
    HLS_MIMES.includes(baseMime) ||
    lowerMime.includes('mpegurl')
  ) {
    return {
      type: 'hls',
      format: 'm3u8',
      is_segment: false,
      supported: true,
      notice: 'RFC 8216 HLS VOD stream with parallel segment downloading & FFmpeg container muxing',
    };
  }

  // Check streaming segments
  const segCheck = isMediaSegment(lowerUrl, lowerMime, headers, statusCode, tabId);
  if (segCheck.isSegment) {
    return {
      type: 'segment',
      format: segCheck.format || 'SEGMENT',
      is_segment: true,
      supported: true,
      notice: 'HLS/DASH media stream segment (partial chunk)',
    };
  }

  // Check direct media
  let ext = '';
  for (const e of DIRECT_MEDIA_EXTS) {
    if (lowerUrl.includes(e)) {
      ext = e.substring(1).toUpperCase();
      break;
    }
  }

  if (!ext && lowerMime) {
    if (lowerMime.includes('mp4')) ext = 'MP4';
    else if (lowerMime.includes('webm')) ext = 'WEBM';
    else if (lowerMime.includes('mpeg') || lowerMime.includes('mp3')) ext = 'MP3';
    else if (lowerMime.includes('ogg')) ext = 'OGG';
    else if (lowerMime.includes('audio')) ext = 'AUDIO';
    else if (lowerMime.includes('video')) ext = 'VIDEO';
  }

  return {
    type: 'direct',
    format: ext || 'MEDIA',
    is_segment: false,
    supported: true,
    notice: 'Direct high-speed HTTP multi-range partitioned download',
  };
}

/**
 * Store a candidate in tab cache and update icon badge
 */
async function recordCandidate(tabId, candidate) {
  if (tabId < 0) return;
  if (!candidate.url || candidate.url.startsWith('blob:') || candidate.url.startsWith('data:') || candidate.url.startsWith('javascript:')) {
    return;
  }

  // Reject webpage URLs that are not direct media streams
  const lowerCand = candidate.url.toLowerCase();
  if (
    lowerCand.includes('youtube.com/watch') ||
    lowerCand.includes('youtu.be/') ||
    lowerCand.endsWith('.html') ||
    lowerCand.endsWith('.htm')
  ) {
    return;
  }

  // Check if capture is globally enabled
  if (extSettings.cap === false) {
    return;
  }

  // Check excluded sites
  try {
    const u = new URL(candidate.url);
    const host = u.hostname.toLowerCase();
    if (
      extSettings.sites &&
      extSettings.sites.some((s) => {
        const clean = s.trim().toLowerCase();
        return host === clean || host.endsWith('.' + clean);
      })
    ) {
      return;
    }
  } catch (_) { }

  // Check minimum file size if known and candidate is direct
  if (
    extSettings.min > 0 &&
    candidate.size_bytes &&
    candidate.size_bytes < extSettings.min * 1024 * 1024 &&
    candidate.type === 'direct'
  ) {
    return;
  }

  // Ensure session storage restoration has completed before modifying cache
  await ensureSessionRestored();

  let list = tabMediaCache.get(tabId) || [];

  // Deduplicate by URL
  if (list.some((c) => c.url === candidate.url)) {
    return;
  }

  if (list.length >= MAX_CANDIDATES_PER_TAB) {
    const isNewManifest = isManifestCandidate(candidate);
    const nonManifestIdx = list.findIndex((item) => !isManifestCandidate(item));

    if (nonManifestIdx !== -1) {
      // Evict oldest non-manifest candidate to protect manifests
      list.splice(nonManifestIdx, 1);
      list.push(candidate);
    } else if (isNewManifest) {
      // All 50 items are manifests; bounded FIFO among high-priority manifests
      list.shift();
      list.push(candidate);
    } else {
      // All 50 items are manifests; low-priority candidate cannot evict any manifest
      return;
    }
  } else {
    list.push(candidate);
  }
  tabMediaCache.set(tabId, list);
  scheduleSessionWrite(tabId);

  // Notify active tab content scripts of newly recorded candidate
  chrome.tabs.sendMessage(tabId, {
    action: 'MEDIA_CANDIDATE_RECORDED',
    candidate,
  }).catch(() => { });

  // Update badge if enabled
  if (extSettings.badge !== false) {
    const count = list.length;
    await chrome.action.setBadgeText({ tabId, text: String(count) }).catch(() => { });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#6366f1' }).catch(() => { });
  } else {
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => { });
  }
}

function isLikelyAdOrTracker(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  const adHosts = [
    'doubleclick.net',
    'google-analytics.com',
    'googletagmanager.com',
    'adservice.google.com',
    'adnxs.com',
    'advertising.com',
    'scorecardresearch.com',
    'amazon-adsystem.com',
    'facebook.com/tr/',
    'analytics.',
    'telemetry.',
  ];
  if (adHosts.some((h) => lower.includes(h))) return true;
  if (lower.includes('/ads/') || lower.includes('/ad_break') || lower.includes('ad_type=') || lower.includes('pagead/')) {
    return true;
  }
  return false;
}

// -------------------------------------------------------------------------
// WebRequest Listener: intercept media responses in background
// -------------------------------------------------------------------------
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // Only intercept main or sub-requests in normal tabs
    if (details.tabId < 0) return;
    const url = details.url;

    // Ignore browser internal schemes and ad/tracker requests
    if (
      url.startsWith('chrome:') ||
      url.startsWith('edge:') ||
      url.startsWith('about:') ||
      url.startsWith('moz-extension:') ||
      url.startsWith('blob:') ||
      url.startsWith('data:') ||
      isLikelyAdOrTracker(url)
    ) {
      return;
    }

    const headers = details.responseHeaders || [];
    let contentType = '';
    let contentLength = 0;
    let contentDisposition = '';

    for (const h of headers) {
      const name = h.name.toLowerCase();
      if (name === 'content-type') {
        contentType = h.value || '';
      } else if (name === 'content-length') {
        contentLength = parseInt(h.value || '0', 10) || 0;
      } else if (name === 'content-disposition') {
        contentDisposition = h.value || '';
      } else if (name === 'content-range') {
        const m = (h.value || '').match(/bytes\s+\d+-\d+\/(\d+)/i);
        if (m) {
          const total = parseInt(m[1], 10);
          if (total > 0) contentLength = total;
        }
      }
    }

    const lowerUrl = url.toLowerCase();
    const lowerMime = contentType.toLowerCase();
    const baseMime = lowerMime.split(';')[0].trim();
    const dispFilename = parseContentDispositionFilename(contentDisposition);
    const hasMediaDisp = dispFilename && DIRECT_MEDIA_EXTS.some((e) => dispFilename.toLowerCase().endsWith(e));

    // Check if matching media
    const isMediaMime =
      MEDIA_MIME_PREFIXES.some((p) => lowerMime.startsWith(p)) ||
      STREAMING_MIMES.includes(baseMime) ||
      STREAMING_MIMES.some((m) => lowerMime.includes(m));
    const hasMediaExt =
      DIRECT_MEDIA_EXTS.some((e) => lowerUrl.includes(e)) ||
      STREAMING_MANIFEST_EXTS.some((e) => lowerUrl.includes(e)) ||
      hasMediaDisp;

    if (isMediaMime || hasMediaExt) {
      const classification = classifyMedia(url, contentType, details.responseHeaders, details.statusCode, details.tabId);
      const filename = dispFilename || extractFilenameFromUrl(url);

      recordCandidate(details.tabId, {
        id: `${details.tabId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        url,
        filename,
        size_bytes: contentLength > 0 ? contentLength : null,
        content_type: contentType,
        type: classification.type,
        format: classification.format,
        is_segment: classification.is_segment === true,
        supported: classification.supported,
        notice: classification.notice,
        detected_at: new Date().toISOString(),
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// -------------------------------------------------------------------------
// Browser Download Interception (ISO, RAR, EXE, 7Z, ZIP, PDF, MKV, MP4, etc.)
// -------------------------------------------------------------------------
const recentlyInterceptedDownloadIds = new Set();
const recentlyInterceptedUrls = new Map(); // url -> timestamp
const inFlightDownloadIds = new Set(); // Prevent duplicate concurrent handoffs

// Comprehensive mapping of MIME types to file extensions
const DOWNLOAD_MIME_MAP = {
  // Archives & Compressed
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar',
  'application/x-7z-compressed': '7z',
  'application/x-iso9660-image': 'iso',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'application/x-bzip2': 'bz2',
  'application/x-xz': 'xz',
  // Executables & Installers
  'application/x-msdownload': 'exe',
  'application/vnd.microsoft.portable-executable': 'exe',
  'application/x-msi': 'msi',
  'application/x-apple-diskimage': 'dmg',
  'application/octet-stream': '',
  // Documents
  'application/pdf': 'pdf',
  'application/epub+zip': 'epub',
  // Video
  'video/x-matroska': 'mkv',
  'video/matroska': 'mkv',
  'application/x-matroska': 'mkv',
  'application/mkv': 'mkv',
  'video/mkv': 'mkv',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-msvideo': 'avi',
  'video/avi': 'avi',
  'video/msvideo': 'avi',
  'video/quicktime': 'mov',
  'video/x-flv': 'flv',
  'video/x-ms-wmv': 'wmv',
  'video/x-m4v': 'm4v',
  // Audio
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/x-matroska': 'mka',
  'audio/webm': 'weba',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/opus': 'opus',
};

function parseExt(str) {
  if (!str || typeof str !== 'string') return '';
  let clean = str.trim();
  try { clean = decodeURIComponent(clean); } catch (_) {}
  clean = clean.split('?')[0].split('#')[0].replace(/^.*[\\\/]/, '').trim();
  const dot = clean.lastIndexOf('.');
  if (dot !== -1 && dot < clean.length - 1) {
    const candidate = clean.substring(dot + 1).toLowerCase().trim();
    if (/^[a-z0-9]{1,10}$/i.test(candidate)) {
      return candidate;
    }
  }
  return '';
}

function extractExtensionFromDownloadItem(item) {
  if (!item) return '';

  if (item.filename) {
    const ext = parseExt(item.filename);
    if (ext) return ext;
  }

  const checkUrl = (urlStr) => {
    if (!urlStr) return '';
    try {
      const u = new URL(urlStr);
      const fromPath = parseExt(u.pathname);
      if (fromPath) return fromPath;

      const qParams = ['filename', 'file', 'name', 'fn', 'download', 'title', 'attachment', 'response-content-disposition'];
      for (const p of qParams) {
        const val = u.searchParams.get(p);
        if (val) {
          const fromQuery = parseExt(val);
          if (fromQuery) return fromQuery;
        }
      }
    } catch (_) {}
    return '';
  };

  if (item.finalUrl && item.finalUrl !== item.url) {
    const ext = checkUrl(item.finalUrl);
    if (ext) return ext;
  }

  if (item.url) {
    const ext = checkUrl(item.url);
    if (ext) return ext;
  }

  return '';
}

function extractFilenameFromDownloadItem(item) {
  if (!item) return '';

  if (item.filename) {
    let name = item.filename.replace(/^.*[\\\/]/, '').trim();
    if (name) return name;
  }

  const checkUrl = (urlStr) => {
    if (!urlStr) return '';
    try {
      const u = new URL(urlStr);
      const qParams = ['filename', 'file', 'name', 'fn', 'download', 'title', 'attachment'];
      for (const p of qParams) {
        const val = u.searchParams.get(p);
        if (val) {
          let clean = val.trim();
          try { clean = decodeURIComponent(clean); } catch (_) {}
          clean = clean.split('?')[0].split('#')[0].replace(/^.*[\\\/]/, '').trim();
          if (clean && clean.includes('.')) return clean;
        }
      }
      const p = u.pathname;
      let leaf = p.substring(p.lastIndexOf('/') + 1);
      try { leaf = decodeURIComponent(leaf); } catch (_) {}
      leaf = leaf.split('?')[0].split('#')[0].trim();
      if (leaf && leaf.includes('.')) return leaf;
    } catch (_) {}
    return '';
  };

  if (item.finalUrl && item.finalUrl !== item.url) {
    const fn = checkUrl(item.finalUrl);
    if (fn) return fn;
  }

  if (item.url) {
    const fn = checkUrl(item.url);
    if (fn) return fn;
  }

  return '';
}

function isDomainExcluded(urlStr, referrerStr) {
  const excluded = Array.isArray(extSettings.sites) ? extSettings.sites : [];
  if (excluded.length === 0) return false;
  const check = (s) => {
    if (!s) return false;
    try {
      const h = new URL(s).hostname.toLowerCase();
      return excluded.some((d) => {
        const ld = (d || '').toLowerCase();
        return h === ld || h.endsWith('.' + ld);
      });
    } catch (_) {
      return false;
    }
  };
  return check(urlStr) || check(referrerStr);
}

async function handleBrowserDownload(item) {
  if (!item || !item.id) return;
  if (recentlyInterceptedDownloadIds.has(item.id)) return;
  if (inFlightDownloadIds.has(item.id)) return;

  await ensureSettingsLoaded();

  // 1. Check if download capture is enabled by user
  if (extSettings.cap === false) {
    return;
  }

  // 1a. Respect private/incognito capture preference
  if (item.incognito && !extSettings.incog) {
    return;
  }

  // 1b. Check browser danger warnings: respect security boundaries
  if (item.danger && item.danger !== 'safe' && item.danger !== 'accepted') {
    console.debug('[TORI] Download has browser danger status:', item.danger);
    return;
  }

  const rawUrl = item.finalUrl || item.url || '';
  if (!rawUrl) return;
  const lowerUrl = rawUrl.toLowerCase();

  // 2. Ignore browser-internal schemes and inline data
  if (
    lowerUrl.startsWith('blob:') ||
    lowerUrl.startsWith('data:') ||
    lowerUrl.startsWith('about:') ||
    lowerUrl.startsWith('chrome:') ||
    lowerUrl.startsWith('edge:') ||
    lowerUrl.startsWith('moz-extension:') ||
    lowerUrl.startsWith('chrome-extension:')
  ) {
    return;
  }

  // 3. Check site exclusion list
  if (isDomainExcluded(rawUrl, item.referrer)) {
    return;
  }

  // 4. Rate-limit / loop prevention for same URL within 15 seconds
  const now = Date.now();
  if (recentlyInterceptedUrls.has(rawUrl)) {
    const lastTime = recentlyInterceptedUrls.get(rawUrl);
    if (now - lastTime < 15000) {
      return;
    }
  }

  // 5. Match file extension or MIME type against user configured types
  const userTypes = (Array.isArray(extSettings.types) ? extSettings.types : DEFAULT_CAPTURE_TYPES)
    .map((t) => (t || '').toLowerCase().replace(/^\./, '').trim())
    .filter(Boolean);

  const ext = extractExtensionFromDownloadItem(item);
  const baseMime = (item.mime || '').toLowerCase().split(';')[0].trim();
  const mimeExt = DOWNLOAD_MIME_MAP[baseMime] || '';

  const matched = (ext && userTypes.includes(ext)) || (mimeExt && mimeExt !== 'bin' && userTypes.includes(mimeExt));
  if (!matched) {
    return;
  }

  // Prevent duplicate concurrent handoffs for this download item (e.g. onCreated + onDeterminingFilename race)
  if (inFlightDownloadIds.has(item.id)) return;
  inFlightDownloadIds.add(item.id);

  try {
    // 6. Check minimum file size threshold (extSettings.min in MB)
    const minBytes = (parseFloat(extSettings.min) || 0) * 1024 * 1024;
    const totalBytes = item.totalBytes > 0 ? item.totalBytes : (item.fileSize > 0 ? item.fileSize : 0);
    if (minBytes > 0 && totalBytes > 0 && totalBytes < minBytes) {
      // Smaller than user threshold, leave in browser
      return;
    }

    // 7. Dispatch download to TORI Desktop Engine
    let rawFilename = extractFilenameFromDownloadItem(item);
    if (!rawFilename) {
      rawFilename = `download.${ext || mimeExt || 'bin'}`;
    }

    const payload = {
      url: rawUrl,
      filename: rawFilename,
      referer: item.referrer || '',
      user_agent: navigator.userAgent,
      priority: 'normal',
      handoff_id: 'browser_dl_' + item.id,
    };

    const httpRes = await callDesktopApi('/api/v1/downloads', 'POST', payload);
    let handoffSuccess = false;

    if (httpRes && httpRes.ok && httpRes.data) {
      const data = httpRes.data;
      if (data.status === 'ok' && data.job_id) {
        handoffSuccess = true;
      } else if (data.status === 'already_exists' && data.job_id) {
        // Strict verification: verify existing job state can complete or has completed the download
        const validStates = ['downloading', 'queued', 'paused', 'completed', 'probing', 'scheduled'];
        if (data.state && validStates.includes(data.state.toLowerCase())) {
          handoffSuccess = true;
        } else {
          // If existing job is failed, cancelled, or unknown, do NOT cancel browser download
          handoffSuccess = false;
        }
      }
    } else if (httpRes && httpRes.status === 401) {
      // Unpaired or bad token: do NOT cancel browser download
      handoffSuccess = false;
    } else {
      // Try Native Messaging fallback
      const nmRes = await sendNativeMessage({
        action: 'start_download',
        ...payload,
      }).catch(() => null);

      if (nmRes && nmRes.status === 'ok' && nmRes.job_id) {
        handoffSuccess = true;
      } else if (nmRes && nmRes.status === 'already_exists' && nmRes.job_id) {
        const validStates = ['downloading', 'queued', 'paused', 'completed', 'probing', 'scheduled'];
        if (nmRes.state && validStates.includes((nmRes.state || '').toLowerCase())) {
          handoffSuccess = true;
        }
      }
    }

    if (handoffSuccess) {
      recentlyInterceptedDownloadIds.add(item.id);
      recentlyInterceptedUrls.set(rawUrl, now);

      // Clean up old entries in recentlyInterceptedUrls periodically
      if (recentlyInterceptedUrls.size > 200) {
        for (const [u, t] of recentlyInterceptedUrls.entries()) {
          if (now - t > 60000) recentlyInterceptedUrls.delete(u);
        }
      }

      // Cancel the browser's internal download while PRESERVING browser download history
      if (chrome.downloads && typeof chrome.downloads.cancel === 'function') {
        chrome.downloads.cancel(item.id, () => {
          // Intentionally do NOT erase: keep record in browser download history for user transparency
        });
      }
    }
  } catch (err) {
    // Desktop engine offline or error: ALWAYS leave browser download active!
    console.debug('[TORI] Failed to intercept download to TORI desktop, preserving browser download:', err);
  } finally {
    inFlightDownloadIds.delete(item.id);
  }
}

if (chrome.downloads && chrome.downloads.onCreated) {
  chrome.downloads.onCreated.addListener((downloadItem) => {
    handleBrowserDownload(downloadItem);
  });
}

// In Chromium, onDeterminingFilename provides the final filename for downloads with Content-Disposition
if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item) => {
    if (!recentlyInterceptedDownloadIds.has(item.id)) {
      handleBrowserDownload(item);
    }
  });
}

let showDesktopInFlight = null;

async function fetchStatusOnce(port, token, timeoutMs = 1800) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {};
    if (token) headers['X-Tori-Token'] = token;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
      method: 'GET',
      headers,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    return { reached: true, status: res.status, ok: res.ok, data, port };
  } catch (err) {
    clearTimeout(timer);
    return {
      reached: false,
      status: 0,
      ok: false,
      error: err?.name === 'AbortError' ? 'Timed out checking Desktop status' : err?.message || 'Unreachable',
      port,
    };
  }
}

async function probeDesktopPassive(customPort = null, customKey = undefined, allowSweep = true) {
  await ensureSettingsLoaded();
  const start = Date.now();
  const targetPort = Number(customPort) || Number(extSettings.port) || 6800;
  const targetKey = customKey !== undefined ? customKey : (extSettings.key || '');

  let probe = await fetchStatusOnce(targetPort, targetKey, 1800);
  if (!probe.reached && allowSweep && !customPort) {
    const candidates = [6800, 6801, 6802, 6803].filter((p) => p !== targetPort);
    for (const cand of candidates) {
      const candProbe = await fetchStatusOnce(cand, targetKey, 500);
      if (candProbe.reached && candProbe.data?.name === 'TORI Download Manager') {
        probe = candProbe;
        if (cand !== extSettings.port) {
          extSettings.port = cand;
          await chrome.storage.local.set({ tori_settings: extSettings }).catch(() => {});
        }
        break;
      }
    }
  }

  const latency = Math.max(1, Date.now() - start);
  if (probe.reached && probe.data && probe.data.status === 'ok') {
    if (probe.data.authenticated) {
      return {
        status: 'ok',
        connectionState: 'connected',
        authenticated: true,
        desktop_running: true,
        version: probe.data.version || '2.0.0',
        port: probe.data.port || probe.port,
        latency,
        mode: 'http',
      };
    }
    return {
      status: 'unpaired',
      connectionState: 'disconnected',
      authenticated: false,
      desktop_running: true,
      version: probe.data.version || '2.0.0',
      port: probe.data.port || probe.port,
      latency,
      mode: 'http',
      message: 'Pairing required (API key mismatch)',
    };
  }

  if (probe.status === 401) {
    return {
      status: 'unpaired',
      connectionState: 'disconnected',
      authenticated: false,
      desktop_running: true,
      version: '2.0.0',
      port: probe.port,
      latency,
      mode: 'http',
      message: 'Pairing required (API key mismatch)',
    };
  }

  return {
    status: 'unavailable',
    connectionState: 'unavailable',
    authenticated: false,
    desktop_running: false,
    port: targetPort,
    latency,
    mode: 'none',
    message: 'TORI Desktop is not running or unreachable on 127.0.0.1:' + targetPort,
  };
}

async function openDesktopWindowUnified() {
  if (showDesktopInFlight) {
    return showDesktopInFlight;
  }

  showDesktopInFlight = (async () => {
    await ensureSettingsLoaded();
    let probe = await probeDesktopPassive(null, undefined, true);

    if (probe.desktop_running && !probe.authenticated) {
      const paired = await autoPairWithDesktop(true);
      if (paired?.ok && paired.token) {
        probe = await probeDesktopPassive(paired.port || null, paired.token, false);
      }
    }

    if (probe.desktop_running && probe.authenticated) {
      const httpRes = await callDesktopApi(
        '/api/v1/window/show',
        'POST',
        null,
        5000,
        probe.port,
        extSettings.key || ''
      );
      if (httpRes.ok) {
        return {
          status: 'ok',
          mode: 'http',
          port: probe.port,
          message: 'TORI Desktop window restored',
        };
      }
    }

    const nmRes = await sendNativeMessage({ action: 'show_window' });
    if (nmRes && nmRes.status === 'ok') {
      autoPairWithDesktop(false).catch(() => {});
      return {
        status: 'ok',
        mode: 'native',
        message: nmRes.message || 'TORI Desktop launched',
      };
    }

    return {
      status: 'error',
      message:
        nmRes?.message ||
        'Could not launch or reach TORI Desktop. Verify TORI Download Manager is installed and native messaging is registered.',
    };
  })().finally(() => {
    showDesktopInFlight = null;
  });

  return showDesktopInFlight;
}

// -------------------------------------------------------------------------
// Runtime Message Listener (Popup & Content Script interaction)
// -------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id || message.tabId;

  if (message.action === 'GET_ALL_MEDIA') {
    // Restrict GET_ALL_MEDIA to internal extension contexts (popup / options).
    // Reject calls originated from content scripts (where sender.tab is defined on a non-extension URL) to prevent cross-tab media exposure.
    if (sender.tab && sender.url && !sender.url.startsWith('chrome-extension://') && !sender.url.startsWith('edge-extension://') && !sender.url.startsWith('moz-extension://') && !sender.url.startsWith('extension://')) {
      sendResponse({ status: 'error', message: 'Unauthorized: GET_ALL_MEDIA cannot be called from a content script' });
      return false;
    }
    ensureSessionRestored().then(() => {
      const all = [];
      for (const candidates of tabMediaCache.values()) {
        all.push(...candidates);
      }
      sendResponse({ status: 'ok', media: all });
    });
    return true;
  }

  if (message.action === 'GET_TAB_MEDIA') {
    const targetTabId = message.tabId !== undefined ? message.tabId : sender.tab?.id;
    ensureSessionRestored().then(() => {
      const list = targetTabId ? (tabMediaCache.get(targetTabId) || []) : [];
      sendResponse({ status: 'ok', media: list });
    });
    return true;
  }

  if (message.action === 'RECORD_MEDIA_FROM_DOM') {
    if (tabId && message.candidate) {
      const classification = classifyMedia(message.candidate.url, message.candidate.content_type, [], 200, tabId);
      recordCandidate(tabId, {
        ...message.candidate,
        type: classification.type,
        format: classification.format,
        is_segment: classification.is_segment === true,
        supported: classification.supported,
        notice: classification.notice,
        detected_at: new Date().toISOString(),
      }).then(() => {
        try { sendResponse({ status: 'ok' }); } catch (_) { }
      }).catch((err) => {
        try { sendResponse({ status: 'error', message: String(err) }); } catch (_) { }
      });
      return true;
    }
    sendResponse({ status: 'ignored' });
    return false;
  }

  if (message.action === 'INITIATE_PAIRING') {
    autoPairWithDesktop(true).then((res) => {
      sendResponse(res);
    });
    return true;
  }

  if (message.action === 'GET_CONNECTION_STATUS') {
    const targetPort = Number(message.port) || Number(extSettings.port) || 6800;
    const token = message.key !== undefined ? message.key : (extSettings.key || '');
    probeDesktopPassive(targetPort, token, !message.port).then((probe) => {
      if (probe.status === 'ok' && probe.authenticated) {
        sendResponse({
          status: 'ok',
          connectionState: 'connected',
          paired: true,
          port: probe.port,
          version: probe.version,
          latency: probe.latency,
        });
      } else if (probe.desktop_running) {
        sendResponse({
          status: 'unpaired',
          connectionState: 'disconnected',
          paired: false,
          port: probe.port,
          version: probe.version,
          message: 'Pairing Required',
        });
      } else {
        sendResponse({
          status: 'unavailable',
          connectionState: 'unavailable',
          paired: false,
          port: probe.port,
          message: 'Desktop Unavailable',
        });
      }
    });
    return true;
  }

  if (message.action === 'PING_DESKTOP') {
    const start = Date.now();
    const hasCustomPort = message.port !== undefined && message.port !== null && message.port !== '';
    let targetPort = hasCustomPort ? Number(message.port) : (Number(extSettings.port) || 6800);
    let targetKey = message.key !== undefined ? message.key : (extSettings.key || '');
    const isPassive = message.passive === true;

    (async () => {
      let result = await probeDesktopPassive(hasCustomPort ? targetPort : null, targetKey, !hasCustomPort);

      // Only attempt auto-pairing when desktop is already responding (401/unpaired) OR when explicitly non-passive
      if (!isPassive && result.desktop_running && !result.authenticated && extSettings.auto !== false) {
        const pairRes = await autoPairWithDesktop(false);
        if (pairRes.ok && pairRes.token) {
          targetPort = pairRes.port || targetPort;
          targetKey = pairRes.token;
          result = await probeDesktopPassive(targetPort, targetKey, false);
          result.token = pairRes.token;
        }
      }

      result.latency = result.latency || Math.max(1, Date.now() - start);
      sendResponse(result);
    })();
    return true; // Keep channel open for async response
  }

  if (message.action === 'RECONNECT_DESKTOP') {
    const start = Date.now();
    (async () => {
      await ensureSettingsLoaded();
      const targetPort = Number(message.port) || Number(extSettings.port) || 6800;
      let result = await probeDesktopPassive(message.port || null, message.key, !message.port);

      // Explicitly force pairing / native check when user initiates reconnect
      if (!result.authenticated) {
        const pairRes = await autoPairWithDesktop(true);
        if (pairRes.ok && pairRes.token) {
          result = await probeDesktopPassive(pairRes.port || targetPort, pairRes.token, false);
          result.token = pairRes.token;
          result.nativeHost = true;
        } else {
          result.nativeHost = false;
          if (!result.desktop_running && pairRes?.error) {
            result.message = pairRes.error;
          }
        }
      }

      result.latency = Math.max(1, Date.now() - start);
      sendResponse(result);
    })();
    return true;
  }

  if (message.action === 'SHOW_DESKTOP') {
    openDesktopWindowUnified().then((res) => {
      sendResponse(res);
    });
    return true;
  }

  if (message.action === 'OPEN_OPTIONS') {
    try {
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage(() => {
          if (chrome.runtime.lastError) {
            chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') }, (tab) => {
              sendResponse({ status: 'ok', tabId: tab?.id });
            });
          } else {
            sendResponse({ status: 'ok' });
          }
        });
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') }, (tab) => {
          sendResponse({ status: 'ok', tabId: tab?.id });
        });
      }
    } catch (_) {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') }, (tab) => {
        sendResponse({ status: 'ok', tabId: tab?.id });
      });
    }
    return true;
  }

  if (message.action === 'OPEN_POPUP_TAB') {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') }, (tab) => {
      sendResponse({ status: 'ok', tabId: tab?.id });
    });
    return true;
  }

  if (message.action === 'START_DOWNLOAD') {
    const rawUrl = (message.url || '').trim();
    const lower = rawUrl.toLowerCase();
    const sourcePageUrl = message.page_url || message.referer || sender.tab?.url;
    const safeReferer = deriveSafeReferer(sourcePageUrl, rawUrl);
    const safeUserAgent = getSafeUserAgent(message.user_agent);

    if (lower.includes('watch.plex.tv') || lower.includes('plex.tv')) {
      sendResponse({
        status: 'error',
        message: 'watch.plex.tv content is DRM-protected and not licensed for offline download.',
      });
      return false;
    }

    if (!rawUrl || rawUrl.startsWith('blob:') || rawUrl.startsWith('data:') || rawUrl.startsWith('javascript:')) {
      sendResponse({
        status: 'error',
        message: 'Invalid or blob-based media stream. Direct media URL required.',
      });
      return false;
    }

    if (
      lower.includes('youtube.com/watch') ||
      lower.includes('youtu.be/') ||
      lower.endsWith('.html') ||
      lower.endsWith('.htm')
    ) {
      sendResponse({
        status: 'error',
        message: 'Webpage or watch portal URLs cannot be downloaded directly as media. Playable stream required.',
      });
      return false;
    }

    callDesktopApi('/api/v1/downloads', 'POST', {
      url: message.url,
      filename: message.filename,
      destination: message.destination,
      priority: message.priority || 'normal',
      thumbnail_url: message.thumbnail_url || null,
      referer: safeReferer,
      user_agent: safeUserAgent,
    }).then(async (httpRes) => {
      if (httpRes.ok && httpRes.data) {
        sendResponse(httpRes.data);
      } else if (httpRes.status === 401) {
        sendResponse({
          status: 'error',
          message: 'Pairing required. Check API Key in Extension Options.',
        });
      } else {
        // Fallback to Native Messaging
        const nmRes = await sendNativeMessage({
          action: 'start_download',
          url: message.url,
          filename: message.filename,
          destination: message.destination,
          priority: message.priority || 'normal',
          referer: safeReferer,
          user_agent: safeUserAgent,
        });
        sendResponse(nmRes);
      }
    });
    return true;
  }

  if (message.action === 'GET_DOWNLOADS') {
    callDesktopApi('/api/v1/downloads').then((httpRes) => {
      if (httpRes.ok && httpRes.data && Array.isArray(httpRes.data.jobs)) {
        sendResponse({ status: 'ok', jobs: httpRes.data.jobs });
      } else {
        sendResponse({ status: 'ok', jobs: [] });
      }
    });
    return true;
  }

  if (message.action === 'PAUSE_DOWNLOAD') {
    callDesktopApi(`/api/v1/downloads/${message.job_id}/pause`, 'POST').then((httpRes) => {
      sendResponse(httpRes.ok ? httpRes.data : { status: 'error', message: 'Desktop disconnected' });
    });
    return true;
  }

  if (message.action === 'RESUME_DOWNLOAD') {
    callDesktopApi(`/api/v1/downloads/${message.job_id}/resume`, 'POST').then((httpRes) => {
      sendResponse(httpRes.ok ? httpRes.data : { status: 'error', message: 'Desktop disconnected' });
    });
    return true;
  }

  if (message.action === 'CANCEL_DOWNLOAD') {
    callDesktopApi(`/api/v1/downloads/${message.job_id}/cancel`, 'POST').then((httpRes) => {
      sendResponse(httpRes.ok ? httpRes.data : { status: 'error', message: 'Desktop disconnected' });
    });
    return true;
  }

  if (message.action === 'RETRY_DOWNLOAD') {
    callDesktopApi(`/api/v1/downloads/${message.job_id}/retry`, 'POST').then((httpRes) => {
      sendResponse(httpRes.ok ? httpRes.data : { status: 'error' });
    });
    return true;
  }

  if (message.action === 'RESOLVE_MEDIA') {
    const rawUrl = (message.url || '').trim();
    const generation = message.generation;
    if (!rawUrl) {
      sendResponse({ status: 'error', code: 'INVALID_URL', message: 'Missing URL to resolve', generation });
      return false;
    }

    const norm = normalizePlatformUrl(rawUrl);
    const tabIdInitial = sender.tab?.id || message.tabId;
    const preCachedStreams = tabIdInitial ? (tabMediaCache.get(tabIdInitial) || []) : [];
    const hasPreCandidates =
      (Array.isArray(message.candidates) && message.candidates.length > 0) ||
      preCachedStreams.some((c) => c && c.url && !c.url.startsWith('blob:') && !c.url.startsWith('data:'));

    if ((norm.platform === 'facebook' || norm.platform === 'instagram') && !norm.isSpecific && !hasPreCandidates) {
      const platName = norm.platform === 'instagram' ? 'Instagram' : 'Facebook';
      const exampleHint = norm.platform === 'instagram' ? 'instagram.com/reel/<id>' : 'facebook.com/reel/<id>';
      sendResponse({
        status: 'error',
        code: 'SPECIFIC_MEDIA_REQUIRED',
        message: `${platName} feed or homepage does not expose a specific media ID. Open the specific Reel or Post (${exampleHint}) or play the video to capture its direct stream.`,
        generation,
      });
      return false;
    }

    const targetUrl = norm.url || rawUrl;
    const isSpecificSocial = (norm.platform === 'facebook' || norm.platform === 'instagram') ? norm.isSpecific : true;
    const isPlatform = (isSpecificSocial && isManagedPlatform(targetUrl)) || (norm.platform !== 'generic' && norm.isSpecific);
    const correlationId = message.correlation_id || ('req_res_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
    const customTimeout = isPlatform ? 32000 : 12000;
    const startTime = Date.now();

    logSanitizedDiagnostic('RESOLVE_START', {
      requestId: correlationId,
      url: targetUrl,
      method: 'POST',
      protocol: isPlatform ? 'platform' : 'generic',
    });

    // Deduplicate in-flight resolution requests for the same URL (unless force_refresh is requested)
    if (!message.force_refresh && activeResolutions.has(targetUrl)) {
      activeResolutions
        .get(targetUrl)
        .then((res) => sendResponse({ ...res, generation }))
        .catch((err) =>
          sendResponse({ status: 'error', code: 'ERROR', message: (err.stack || err.message || 'Resolution error'), generation })
        );
      return true;
    }

    const resolutionPromise = (async () => {
      await ensureSessionRestored();
      const tabId = sender.tab?.id || message.tabId;
      const cachedStreams = tabId ? (tabMediaCache.get(tabId) || []) : [];

      // Merge DOM candidates and network-captured candidates
      const candidateSet = new Set(Array.isArray(message.candidates) ? message.candidates : []);
      for (const item of cachedStreams) {
        if (item.url && !item.url.startsWith('blob:') && !item.url.startsWith('data:')) {
          candidateSet.add(item.url);
        }
      }
      const candidatesList = Array.from(candidateSet);

      // If we have an intercepted stream manifest or direct media candidate on a generic site, probe it directly!
      const streamingCandidate = cachedStreams.find((c) => c.type === 'hls' || c.type === 'dash') ||
        cachedStreams.find((c) => c.type === 'direct');

      if (!isPlatform && streamingCandidate && streamingCandidate.url) {
        logSanitizedDiagnostic('RESOLVE_STREAM_PROBE', {
          requestId: correlationId,
          url: streamingCandidate.url,
          protocol: streamingCandidate.type,
        });
        const streamRes = await callDesktopApi(
          '/api/v1/media/resolve',
          'POST',
          {
            url: streamingCandidate.url,
            candidates: candidatesList,
            page_title: message.page_title || null,
            thumbnail_url: message.thumbnail_url || null,
          },
          8000
        );
        if (streamRes.ok && streamRes.data && Array.isArray(streamRes.data.formats) && streamRes.data.formats.length > 0) {
          logSanitizedDiagnostic('RESOLVE_SUCCESS', {
            requestId: correlationId,
            url: streamingCandidate.url,
            extractor: streamRes.data.extractor,
            durationMs: Date.now() - startTime,
            outcome: 'Formats Available',
          });
          chrome.runtime.sendMessage({
            action: 'MEDIA_RESOLVED',
            url: targetUrl,
            rawUrl,
            status: 'ok',
            metadata: streamRes.data,
            generation,
          }).catch(() => { });
          return { status: 'ok', metadata: streamRes.data };
        }
      }

      const resolvePayload = {
        url: targetUrl,
        candidates: candidatesList,
        page_title: message.page_title || null,
        thumbnail_url: message.thumbnail_url || null,
        force_refresh: message.force_refresh || false,
      };

      const httpRes = await callDesktopApi('/api/v1/media/resolve', 'POST', resolvePayload, customTimeout);
      const elapsed = Date.now() - startTime;

      if (httpRes.ok && httpRes.data) {
        logSanitizedDiagnostic('RESOLVE_SUCCESS', {
          requestId: correlationId,
          url: targetUrl,
          extractor: httpRes.data.extractor || 'yt-dlp',
          durationMs: elapsed,
          outcome: 'Formats Available',
        });
        chrome.runtime.sendMessage({
          action: 'MEDIA_RESOLVED',
          url: targetUrl,
          rawUrl,
          status: 'ok',
          metadata: httpRes.data,
          generation,
        }).catch(() => { });
        return { status: 'ok', metadata: httpRes.data };
      }

      console.warn('[TORI Diagnostic] Resolve HTTP response not ok:', JSON.stringify(httpRes));

      let code = httpRes.data?.error_category || httpRes.code || 'RESOLVER_ERROR';
      let errorMsg = httpRes.data?.message || httpRes.error || 'Media resolution failed';
      if (httpRes.status === 401) {
        code = 'UNAUTHORIZED';
        errorMsg = 'Authentication required. Check API Key in Extension Settings.';
      } else if (httpRes.status === 429) {
        code = 'RATE_LIMITED';
        errorMsg = 'Rate limited by streaming service (HTTP 429). Please wait before retrying.';
      } else if (httpRes.status === 400) {
        code = 'INVALID_REQUEST';
      }

      logSanitizedDiagnostic('RESOLVE_FAILED', {
        requestId: correlationId,
        url: targetUrl,
        durationMs: elapsed,
        outcome: code,
        errorCategory: code,
      });

      chrome.runtime.sendMessage({
        action: 'MEDIA_RESOLUTION_FAILED',
        url: targetUrl,
        rawUrl,
        status: 'error',
        code,
        message: errorMsg,
        generation,
      }).catch(() => { });

      return { status: 'error', code, message: errorMsg };
    })();

    activeResolutions.set(targetUrl, resolutionPromise);
    resolutionPromise.finally(() => {
      activeResolutions.delete(targetUrl);
    });

    resolutionPromise
      .then((res) => sendResponse({ ...res, generation }))
      .catch((err) => {
        console.error('[TORI Catch]', err);
        sendResponse({ status: 'error', code: 'ERROR', message: (err.stack || err.message || 'Resolution failed'), generation });
      });
    return true;
  }

  if (message.action === 'START_MEDIA_DOWNLOAD') {
    const rawUrl = (message.url || '').trim();
    const formatId = (message.format_id || '').trim();
    if (!rawUrl || !formatId) {
      sendResponse({ status: 'error', code: 'INVALID_REQUEST', message: 'Missing URL or format identifier' });
      return false;
    }

    const norm = normalizePlatformUrl(rawUrl);
    const targetUrl = norm.url || rawUrl;
    const sourcePageUrl = message.page_url || message.referer || sender.tab?.url;
    const safeReferer = deriveSafeReferer(sourcePageUrl, targetUrl);
    const safeUserAgent = getSafeUserAgent(message.user_agent);

    callDesktopApi('/api/v1/media/download', 'POST', {
      url: targetUrl,
      format_id: formatId,
      filename: message.filename,
      destination: message.destination,
      priority: message.priority || 'normal',
      thumbnail_url: message.thumbnail_url || null,
      direct_stream_url: message.direct_stream_url || null,
      referer: safeReferer,
      user_agent: safeUserAgent,
    }).then((httpRes) => {
      if (httpRes.ok && httpRes.data) {
        sendResponse(httpRes.data);
      } else {
        let code = httpRes.code || 'DOWNLOAD_ERROR';
        let errorMsg = httpRes.data?.message || httpRes.error || 'Download request failed';
        if (httpRes.status === 401) {
          code = 'UNAUTHORIZED';
          errorMsg = 'Authentication required. Check API Key in Extension Settings.';
        }
        sendResponse({
          status: 'error',
          code,
          message: errorMsg,
        });
      }
    }).catch((err) => {
      sendResponse({ status: 'error', code: 'ERROR', message: err.message || 'Download error' });
    });
    return true;
  }

  if (message.action === 'OPEN_PLAYLIST') {
    const rawUrl = (message.url || '').trim();
    if (!rawUrl) {
      sendResponse({ status: 'error', confirmed: false, message: 'Missing playlist URL' });
      return false;
    }

    openPlaylistInDesktopWithDedup(rawUrl)
      .then((res) => sendResponse(res))
      .catch((err) => {
        sendResponse({
          status: 'error',
          confirmed: false,
          message: err?.message || 'Failed to open playlist in TORI Desktop.',
        });
      });
    return true;
  }

  if (message.action === 'RESOLVE_PLAYLIST') {
    const rawUrl = (message.url || '').trim();
    if (!rawUrl) {
      sendResponse({ status: 'error', message: 'Missing playlist URL' });
      return false;
    }
    callDesktopApi('/api/v1/media/playlist/resolve', 'POST', { url: rawUrl, limit: message.limit || 100 }).then((httpRes) => {
      if (httpRes.ok && httpRes.data) {
        sendResponse({ status: 'ok', playlist: httpRes.data });
      } else {
        sendResponse({ status: 'error', message: httpRes.data?.message || 'Playlist resolution failed' });
      }
    }).catch((err) => {
      sendResponse({ status: 'error', message: err.message });
    });
    return true;
  }

  if (message.action === 'ENQUEUE_PLAYLIST') {
    callDesktopApi('/api/v1/media/playlist/enqueue', 'POST', {
      items: message.items,
      destination: message.destination,
      format_id: message.format_id,
      playlist_title: message.playlist_title,
    }).then((httpRes) => {
      if (httpRes.ok && httpRes.data) {
        sendResponse(httpRes.data);
      } else {
        sendResponse({ status: 'error', message: httpRes.data?.message || 'Playlist enqueue failed' });
      }
    }).catch((err) => {
      sendResponse({ status: 'error', message: err.message });
    });
    return true;
  }

  return false;
});

