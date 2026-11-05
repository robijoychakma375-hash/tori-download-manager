/**
 * TORI Download Manager — Background Service Worker (Manifest V3)
 * Automatic Media Detection & Native Messaging Coordinator
 */

const NATIVE_HOST = 'com.tori.download_manager';
const MAX_CANDIDATES_PER_TAB = 50;

// Media format signatures
const DIRECT_MEDIA_EXTS = [
  '.mp4', '.webm', '.mkv', '.mov', '.avi', '.flv', '.wmv', '.m4v',
  '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wav'
];

const STREAMING_MANIFEST_EXTS = ['.m3u8', '.mpd'];

const MEDIA_MIME_PREFIXES = ['video/', 'audio/'];
const STREAMING_MIMES = [
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'application/dash+xml'
];

// In-memory cache for fast synchronous access
const tabMediaCache = new Map();

// Navigation generations per tab to invalidate obsolete media states on SPA navigation
const tabGenerations = new Map();

// Active in-flight media resolution promises to prevent duplicate fetches
const activeResolutions = new Map();

// Extension configuration synchronized with storage
let extSettings = {
  port: 6800,
  key: '',
  auto: true,
  cap: true,
  min: 1,
  badge: true,
  sites: ['docs.google.com', 'mail.google.com', 'github.com'],
  types: ['zip', 'rar', '7z', 'iso', 'exe', 'dmg', 'pdf', 'mp4', 'mp3'],
};

chrome.storage.local.get(['tori_settings'], (res) => {
  if (res.tori_settings) {
    extSettings = { ...extSettings, ...res.tori_settings };
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.tori_settings?.newValue) {
    extSettings = { ...extSettings, ...changes.tori_settings.newValue };
  }
});

// Listen for client-side / SPA history updates (YouTube, Facebook, Instagram, etc.)
if (chrome.webNavigation && chrome.webNavigation.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId === 0) {
      tabMediaCache.delete(details.tabId);
      const nextGen = (tabGenerations.get(details.tabId) || 0) + 1;
      tabGenerations.set(details.tabId, nextGen);
      chrome.tabs.sendMessage(details.tabId, {
        action: 'MEDIA_NAVIGATED',
        url: details.url,
        generation: nextGen,
      }).catch(() => {});
    }
  });
}

// Clean up tab state when tab is closed or navigated
chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaCache.delete(tabId);
  tabGenerations.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    tabMediaCache.delete(tabId);
    const nextGen = (tabGenerations.get(tabId) || 0) + 1;
    tabGenerations.set(tabId, nextGen);
  }
});

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
 * Localhost HTTP API client with endpoint-aware timeout and authentication
 */
async function callDesktopApi(
  endpoint,
  method = 'GET',
  body = null,
  customTimeout = null,
  customPort = null,
  customToken = null
) {
  const port = customPort || extSettings.port || 6800;
  const token = customToken !== null && customToken !== undefined ? customToken : (extSettings.key || '');
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
        errorMsg = 'Media resolution timed out. The server or platform took longer than 35s to respond.';
      } else if (endpoint.startsWith('/api/v1/ping') || endpoint.startsWith('/api/v1/status')) {
        errorMsg = 'Desktop health check timed out (4s). Is TORI running?';
      } else {
        errorMsg = `Request timed out after ${Math.round(timeoutDuration / 1000)}s`;
      }
    } else if (err.message && err.message.includes('Failed to fetch')) {
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

/**
 * One-time secure auto-pairing via Native Messaging bound to this extension
 */
async function autoPairWithDesktop() {
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

// Proactive pairing on startup if unconfigured
chrome.runtime.onInstalled.addListener(() => {
  if (!extSettings.key) {
    autoPairWithDesktop();
  }
});

chrome.runtime.onStartup.addListener(() => {
  if (!extSettings.key) {
    autoPairWithDesktop();
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
    } catch (_) {}
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
  } catch (_) {}
  return 'media_file';
}

/**
 * Classify media item
 */
function classifyMedia(url, mimeType) {
  const lowerUrl = url.toLowerCase();
  const lowerMime = (mimeType || '').toLowerCase();

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
  if (
    lowerUrl.includes('.m3u8') ||
    STREAMING_MIMES.includes(lowerMime) ||
    lowerMime.includes('mpegurl')
  ) {
    return {
      type: 'hls',
      format: 'm3u8',
      supported: true,
      notice: 'RFC 8216 HLS VOD stream with parallel segment downloading & FFmpeg container muxing',
    };
  }

  if (lowerUrl.includes('.mpd') || lowerMime.includes('dash+xml')) {
    return {
      type: 'dash',
      format: 'DASH (mpd)',
      supported: true,
      notice: 'ISO/IEC 23009-1 MPEG-DASH VOD stream with parallel segment downloading & FFmpeg container muxing',
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
  } catch (_) {}

  // Check minimum file size if known and candidate is direct
  if (
    extSettings.min > 0 &&
    candidate.size_bytes &&
    candidate.size_bytes < extSettings.min * 1024 * 1024 &&
    candidate.type === 'direct'
  ) {
    return;
  }

  let list = tabMediaCache.get(tabId) || [];

  // Deduplicate by URL
  if (list.some((c) => c.url === candidate.url)) {
    return;
  }

  if (list.length >= MAX_CANDIDATES_PER_TAB) {
    list.shift();
  }

  list.push(candidate);
  tabMediaCache.set(tabId, list);

  // Update badge if enabled
  if (extSettings.badge !== false) {
    const count = list.length;
    await chrome.action.setBadgeText({ tabId, text: String(count) });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#6366f1' });
  } else {
    await chrome.action.setBadgeText({ tabId, text: '' });
  }
}

// -------------------------------------------------------------------------
// WebRequest Listener: intercept media responses in background
// -------------------------------------------------------------------------
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // Only intercept main or sub-requests in normal tabs
    if (details.tabId < 0) return;
    const url = details.url;

    // Ignore browser internal schemes
    if (url.startsWith('chrome:') || url.startsWith('edge:') || url.startsWith('blob:') || url.startsWith('data:')) {
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
      }
    }

    const lowerUrl = url.toLowerCase();
    const lowerMime = contentType.toLowerCase();

    // Check if matching media
    const isMediaMime = MEDIA_MIME_PREFIXES.some((p) => lowerMime.startsWith(p)) || STREAMING_MIMES.includes(lowerMime);
    const hasMediaExt = DIRECT_MEDIA_EXTS.some((e) => lowerUrl.includes(e)) || STREAMING_MANIFEST_EXTS.some((e) => lowerUrl.includes(e));

    if (isMediaMime || hasMediaExt) {
      const classification = classifyMedia(url, contentType);
      const filename = parseContentDispositionFilename(contentDisposition) || extractFilenameFromUrl(url);

      recordCandidate(details.tabId, {
        id: `${details.tabId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        url,
        filename,
        size_bytes: contentLength > 0 ? contentLength : null,
        content_type: contentType,
        type: classification.type,
        format: classification.format,
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
// Tab Navigation & Lifecycle Listeners
// -------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    // Clear candidates on new page navigation
    tabMediaCache.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaCache.delete(tabId);
});

// -------------------------------------------------------------------------
// Runtime Message Listener (Popup & Content Script interaction)
// -------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id || message.tabId;

  if (message.action === 'GET_TAB_MEDIA') {
    const list = tabMediaCache.get(message.tabId) || [];
    sendResponse({ status: 'ok', media: list });
    return false;
  }

  if (message.action === 'RECORD_MEDIA_FROM_DOM') {
    if (tabId && message.candidate) {
      const classification = classifyMedia(message.candidate.url, message.candidate.content_type);
      recordCandidate(tabId, {
        ...message.candidate,
        type: classification.type,
        format: classification.format,
        supported: classification.supported,
        notice: classification.notice,
        detected_at: new Date().toISOString(),
      });
      sendResponse({ status: 'ok' });
    }
    return false;
  }

  if (message.action === 'INITIATE_PAIRING') {
    autoPairWithDesktop().then((res) => {
      sendResponse(res);
    });
    return true;
  }

  if (message.action === 'GET_CONNECTION_STATUS') {
    const port = message.port || extSettings.port || 6800;
    const token = message.key !== undefined ? message.key : (extSettings.key || '');
    callDesktopApi('/api/v1/pair/status', 'GET', null, 2500, port, token).then((httpRes) => {
      if (httpRes.ok && httpRes.data && httpRes.data.paired) {
        sendResponse({ status: 'ok', paired: true, port: httpRes.data.port, version: httpRes.data.version });
      } else if (httpRes.ok && httpRes.data && httpRes.data.desktop_running) {
        sendResponse({ status: 'unpaired', paired: false, port: httpRes.data.port, message: 'Pairing Required' });
      } else {
        sendResponse({ status: 'disconnected', paired: false, port, message: 'Desktop Offline' });
      }
    });
    return true;
  }

  if (message.action === 'PING_DESKTOP') {
    const start = Date.now();
    let targetPort = message.port || extSettings.port || 6800;
    const targetKey = message.key !== undefined ? message.key : (extSettings.key || '');

    (async () => {
      let httpRes = await callDesktopApi('/api/v1/status', 'GET', null, 2000, targetPort, targetKey);

      // If connection to targetPort failed, probe candidate ports to discover active desktop port
      if (!httpRes.ok && httpRes.status === 0) {
        const candidates = [6800, 6801, 6802, 6803].filter((p) => p !== targetPort);
        for (const candPort of candidates) {
          try {
            const probeRes = await callDesktopApi('/api/v1/ping', 'GET', null, 500, candPort);
            if (probeRes.ok && probeRes.data && probeRes.data.name === 'TORI Download Manager') {
              console.log(`[TORI] Discovered active desktop server on port ${candPort}`);
              targetPort = candPort;
              extSettings.port = candPort;
              chrome.storage.local.set({ tori_settings: extSettings });
              httpRes = await callDesktopApi('/api/v1/status', 'GET', null, 2000, candPort, targetKey);
              break;
            }
          } catch (_) {}
        }
      }

      const latency = Math.max(1, Date.now() - start);

      if (httpRes.ok && httpRes.data && httpRes.data.status === 'ok') {
        if (httpRes.data.authenticated) {
          sendResponse({
            status: 'ok',
            authenticated: true,
            version: httpRes.data.version || '2.0.0',
            port: httpRes.data.port || targetPort,
            latency,
            mode: 'http',
          });
        } else {
          sendResponse({
            status: 'unpaired',
            authenticated: false,
            version: httpRes.data.version || '2.0.0',
            port: httpRes.data.port || targetPort,
            latency,
            mode: 'http',
            message: 'Pairing Required (API Key mismatch)',
          });
        }
      } else if (httpRes.status === 401) {
        sendResponse({
          status: 'unpaired',
          authenticated: false,
          version: '2.0.0',
          port: targetPort,
          latency,
          mode: 'http',
          message: 'Pairing Required (API Key mismatch)',
        });
      } else {
        // Desktop is stopped / unreachable
        sendResponse({
          status: 'disconnected',
          authenticated: false,
          port: targetPort,
          latency,
          mode: 'none',
          message: 'Desktop Offline',
        });
      }
    })();
    return true; // Keep channel open for async response
  }

  if (message.action === 'SHOW_DESKTOP') {
    callDesktopApi('/api/v1/window/show', 'POST').then(async (httpRes) => {
      if (httpRes.ok) {
        sendResponse(httpRes.data);
      } else {
        // Fallback to Native Messaging to spawn/bring desktop forward
        sendResponse(await sendNativeMessage({ action: 'show_window' }));
      }
    });
    return true;
  }

  if (message.action === 'START_DOWNLOAD') {
    const rawUrl = (message.url || '').trim();
    const lower = rawUrl.toLowerCase();

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

    // Deduplicate in-flight resolution requests for the same URL
    if (activeResolutions.has(rawUrl)) {
      activeResolutions
        .get(rawUrl)
        .then((res) => sendResponse({ ...res, generation }))
        .catch((err) =>
          sendResponse({ status: 'error', code: 'ERROR', message: err.message || 'Resolution error', generation })
        );
      return true;
    }

    const resolutionPromise = (async () => {
      const httpRes = await callDesktopApi('/api/v1/media/resolve', 'POST', { url: rawUrl });
      if (httpRes.ok && httpRes.data) {
        return { status: 'ok', metadata: httpRes.data };
      }

      let code = httpRes.code || 'RESOLVER_ERROR';
      let message = httpRes.data?.message || httpRes.error || 'Media resolution failed';
      if (httpRes.status === 401) {
        code = 'UNAUTHORIZED';
        message = 'Authentication required. Check API Key in Extension Settings.';
      } else if (httpRes.status === 429) {
        code = 'RATE_LIMITED';
        message = 'Rate limited by streaming service (HTTP 429). Please wait before retrying.';
      } else if (httpRes.status === 400) {
        code = 'INVALID_REQUEST';
      }
      return { status: 'error', code, message };
    })();

    activeResolutions.set(rawUrl, resolutionPromise);
    resolutionPromise.finally(() => {
      activeResolutions.delete(rawUrl);
    });

    resolutionPromise
      .then((res) => sendResponse({ ...res, generation }))
      .catch((err) =>
        sendResponse({ status: 'error', code: 'ERROR', message: err.message || 'Resolution failed', generation })
      );
    return true;
  }

  if (message.action === 'START_MEDIA_DOWNLOAD') {
    const rawUrl = (message.url || '').trim();
    const formatId = (message.format_id || '').trim();
    if (!rawUrl || !formatId) {
      sendResponse({ status: 'error', code: 'INVALID_REQUEST', message: 'Missing URL or format identifier' });
      return false;
    }

    callDesktopApi('/api/v1/media/download', 'POST', {
      url: rawUrl,
      format_id: formatId,
      filename: message.filename,
      destination: message.destination,
      priority: message.priority || 'normal',
    }).then((httpRes) => {
      if (httpRes.ok && httpRes.data) {
        sendResponse(httpRes.data);
      } else {
        let code = httpRes.code || 'DOWNLOAD_ERROR';
        let message = httpRes.data?.message || httpRes.error || 'Download request failed';
        if (httpRes.status === 401) {
          code = 'UNAUTHORIZED';
          message = 'Authentication required. Check API Key in Extension Settings.';
        }
        sendResponse({
          status: 'error',
          code,
          message,
        });
      }
    }).catch((err) => {
      sendResponse({ status: 'error', code: 'ERROR', message: err.message || 'Download error' });
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

