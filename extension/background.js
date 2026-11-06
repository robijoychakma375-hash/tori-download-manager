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
      const match = path.match(/\/(?:reel|reels|p)\/([^/?#]+)/i);
      if (match && match[1]) {
        return {
          url: `https://www.instagram.com/reel/${match[1]}/`,
          videoId: match[1],
          isSpecific: true,
          platform: 'instagram',
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
        errorMsg = `Media resolution timed out (${Math.round(timeoutDuration / 1000)}s). The server or platform took too long to respond.`;
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
function classifyMedia(url, mimeType) {
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

    if (lower.includes('watch.plex.tv') || lower.includes('plex.tv')) {
      sendResponse({
        status: 'error',
        message: 'watch.plex.tv content is DRM-protected and not licensed for offline download.',
      });
      return false;
    }

    if (isTransientCdnUrl(rawUrl)) {
      const pageUrl = message.page_url || sender.tab?.url;
      if (pageUrl && !pageUrl.startsWith('chrome:') && !pageUrl.startsWith('edge:') && !pageUrl.startsWith('about:')) {
        console.log('[TORI] Rerouting transient CDN URL to managed media download for page:', pageUrl);
        callDesktopApi('/api/v1/media/download', 'POST', {
          url: pageUrl,
          format_id: message.format_id || 'best',
          filename: message.filename,
          destination: message.destination,
          priority: message.priority || 'normal',
        }).then((httpRes) => {
          if (httpRes.ok && httpRes.data) {
            sendResponse(httpRes.data);
          } else {
            sendResponse({
              status: 'error',
              message: httpRes.data?.message || 'Managed media download failed',
            });
          }
        }).catch((err) => {
          sendResponse({ status: 'error', message: err.message || 'Download error' });
        });
        return true;
      }
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

    const norm = normalizePlatformUrl(rawUrl);
    if (norm.platform === 'facebook' && !norm.isSpecific) {
      sendResponse({
        status: 'error',
        code: 'SPECIFIC_MEDIA_REQUIRED',
        message: 'Facebook feed or homepage does not contain a specific Reel ID. Please provide a direct Reel or Video URL (e.g. facebook.com/reel/<id>).',
        generation,
      });
      return false;
    }

    const targetUrl = norm.url || rawUrl;
    const isPlatform = isManagedPlatform(targetUrl) || norm.platform !== 'generic';
    const correlationId = message.correlation_id || ('req_res_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
    const customTimeout = isPlatform ? 32000 : 12000;
    const startTime = Date.now();

    logSanitizedDiagnostic('RESOLVE_START', {
      requestId: correlationId,
      url: targetUrl,
      method: 'POST',
      protocol: isPlatform ? 'platform' : 'generic',
    });

    // Deduplicate in-flight resolution requests for the same URL
    if (activeResolutions.has(targetUrl)) {
      activeResolutions
        .get(targetUrl)
        .then((res) => sendResponse({ ...res, generation }))
        .catch((err) =>
          sendResponse({ status: 'error', code: 'ERROR', message: (err.stack || err.message || 'Resolution error'), generation })
        );
      return true;
    }

    const resolutionPromise = (async () => {
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
          }).catch(() => {});
          return { status: 'ok', metadata: streamRes.data };
        }
      }

      const resolvePayload = {
        url: targetUrl,
        candidates: candidatesList,
        page_title: message.page_title || null,
        thumbnail_url: message.thumbnail_url || null,
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
        }).catch(() => {});
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
      }).catch(() => {});

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

    callDesktopApi('/api/v1/media/download', 'POST', {
      url: targetUrl,
      format_id: formatId,
      filename: message.filename,
      destination: message.destination,
      priority: message.priority || 'normal',
      thumbnail_url: message.thumbnail_url || null,
      direct_stream_url: message.direct_stream_url || null,
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

