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

/**
 * Localhost HTTP API client with timeout and authentication
 */
async function callDesktopApi(endpoint, method = 'GET', body = null) {
  const port = extSettings.port || 6800;
  const token = extSettings.key || '';
  const url = `http://127.0.0.1:${port}${endpoint}`;
  const headers = {
    'X-Tori-Token': token,
  };
  if (body && (method === 'POST' || method === 'PUT')) {
    headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);

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
    return {
      ok: false,
      status: 0,
      error: err.name === 'AbortError' ? 'Connection timeout' : err.message,
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

  if (message.action === 'PING_DESKTOP') {
    const start = Date.now();
    callDesktopApi('/api/v1/status').then(async (httpRes) => {
      const latency = Math.max(1, Date.now() - start);
      if (httpRes.ok && httpRes.data && httpRes.data.status === 'ok') {
        sendResponse({
          status: httpRes.data.authenticated ? 'ok' : 'unpaired',
          authenticated: !!httpRes.data.authenticated,
          version: httpRes.data.version || '2.0.0',
          port: httpRes.data.port || (extSettings.port || 6800),
          latency,
          mode: 'http',
        });
      } else if (httpRes.status === 401) {
        sendResponse({
          status: 'unpaired',
          authenticated: false,
          message: 'API Key mismatch / Pairing required',
          port: extSettings.port || 6800,
          latency,
          mode: 'http',
        });
      } else {
        // Desktop HTTP server unreachable. Optional Native Messaging bootstrap check:
        const nmRes = await sendNativeMessage({ action: 'ping' });
        if (nmRes && nmRes.status === 'ok') {
          sendResponse({
            status: 'ok',
            authenticated: true,
            version: nmRes.version || '2.0.0',
            port: extSettings.port || 6800,
            latency,
            mode: 'native',
          });
        } else {
          sendResponse({
            status: 'error',
            authenticated: false,
            message: 'Could not connect to TORI Desktop. Is TORI running?',
            error: httpRes.error,
            port: extSettings.port || 6800,
            mode: 'none',
          });
        }
      }
    });
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
    callDesktopApi('/api/v1/downloads').then(async (httpRes) => {
      if (httpRes.ok && httpRes.data && Array.isArray(httpRes.data.jobs)) {
        sendResponse({ status: 'ok', jobs: httpRes.data.jobs });
      } else {
        // Fallback to Native Messaging
        const nmRes = await sendNativeMessage({ action: 'get_downloads' });
        sendResponse(nmRes);
      }
    });
    return true;
  }

  if (message.action === 'PAUSE_DOWNLOAD') {
    callDesktopApi(`/api/v1/downloads/${message.job_id}/pause`, 'POST').then(async (httpRes) => {
      if (httpRes.ok) sendResponse(httpRes.data);
      else sendResponse(await sendNativeMessage({ action: 'pause_download', job_id: message.job_id }));
    });
    return true;
  }

  if (message.action === 'RESUME_DOWNLOAD') {
    callDesktopApi(`/api/v1/downloads/${message.job_id}/resume`, 'POST').then(async (httpRes) => {
      if (httpRes.ok) sendResponse(httpRes.data);
      else sendResponse(await sendNativeMessage({ action: 'resume_download', job_id: message.job_id }));
    });
    return true;
  }

  if (message.action === 'CANCEL_DOWNLOAD') {
    callDesktopApi(`/api/v1/downloads/${message.job_id}/cancel`, 'POST').then(async (httpRes) => {
      if (httpRes.ok) sendResponse(httpRes.data);
      else sendResponse(await sendNativeMessage({ action: 'cancel_download', job_id: message.job_id }));
    });
    return true;
  }

  if (message.action === 'RETRY_DOWNLOAD') {
    callDesktopApi(`/api/v1/downloads/${message.job_id}/retry`, 'POST').then((httpRes) => {
      sendResponse(httpRes.ok ? httpRes.data : { status: 'error' });
    });
    return true;
  }

  return false;
});

