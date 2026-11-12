// Platform and transient stream helpers
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
 * TORI Download Manager — Content Script
 * Implements Design Source A HTML5 Media Overlay (.pill and .pn panel)
 * with real Native Messaging engine integration and settings compliance.
 */

(() => {
  'use strict';

  // Prevent multiple injections
  if (window.__toriContentInjected) return;
  window.__toriContentInjected = true;

  const P = {
    dl: 'M12 4v10M8 10l4 4 4-4M5 19h14',
    cp: 'M9 9h10v11H9zM5 15V4h10',
    ck: 'M5 12l5 5 9-10',
    fd: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
    play: 'M9 6.5v11l9-5.5z',
    music: 'M9 18V6l10-2v12M7 20a2 2 0 100-4 2 2 0 000 4zM17 18a2 2 0 100-4 2 2 0 000 4z',
  };

  let settings = {
    cap: true,
    pill: true,
    pos: 'Top right',
    picker: true,
    kind: 'Video',
    fmt: 'Best available',
    audio: true,
    sites: ['docs.google.com', 'mail.google.com', 'github.com'],
    theme: 'light',
  };

  // Check if current site is excluded
  function isSiteExcluded() {
    const host = window.location.hostname.toLowerCase();
    return settings.sites.some((site) => {
      const clean = site.trim().toLowerCase();
      return host === clean || host.endsWith('.' + clean);
    });
  }

  // Load and observe settings changes
  function syncSettings() {
    chrome.storage.local.get(['tori_settings', 'tori_theme'], (res) => {
      if (res.tori_settings) {
        settings = { ...settings, ...res.tori_settings };
      }
      if (res.tori_theme) {
        settings.theme = res.tori_theme;
      }
      applyTheme();
      if (!isSiteExcluded() && settings.pill) {
        scanForMedia();
      } else {
        removeAllOverlays();
      }
    });
  }

  function applyTheme() {
    const isDark =
      settings.theme === 'dark' ||
      (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.classList.toggle('tori-dark', isDark);
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.tori_settings || changes.tori_theme) {
      syncSettings();
    }
  });

  // Extract clean title for media, eliminating notification counters like (1) Facebook
  function getMediaTitle(videoEl, fallbackId = '') {
    if (videoEl && videoEl.title) return cleanMediaTitle(videoEl.title, fallbackId);
    if (videoEl && videoEl.getAttribute('aria-label')) return cleanMediaTitle(videoEl.getAttribute('aria-label'), fallbackId);

    // Look for caption in enclosing article or reel container
    const container = videoEl?.closest?.('[role="article"], [data-pagelet*="Reel"], [data-pagelet*="FeedUnit"], .html5-video-player');
    if (container) {
      const heading = container.querySelector('h1, h2, span[dir="auto"]');
      if (heading && heading.textContent.trim()) {
        const text = heading.textContent.trim();
        if (text.length > 3 && !/^Facebook\b/i.test(text)) {
          return cleanMediaTitle(text, fallbackId);
        }
      }
    }

    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent.trim() && !/^Facebook\b/i.test(h1.textContent.trim())) {
      return cleanMediaTitle(h1.textContent.trim(), fallbackId);
    }

    if (document.title) {
      return cleanMediaTitle(document.title, fallbackId);
    }
    return fallbackId ? `Facebook Reel · ${fallbackId}` : 'Video Media';
  }

  function cleanMediaTitle(rawTitle, fallbackId = '') {
    if (!rawTitle) return fallbackId ? `Facebook Reel · ${fallbackId}` : 'Video Media';
    let t = rawTitle.trim();
    // Remove notification badges: (1) Facebook, (9+) Facebook, etc.
    t = t.replace(/^\(\d+\+?\)\s*/, '');
    // If title is generic "Facebook", "Facebook - Log In or Sign Up", etc.
    if (/^Facebook\s*([·\-|]|$)/i.test(t) || t.toLowerCase() === 'facebook') {
      return fallbackId ? `Facebook Reel · ${fallbackId}` : 'Facebook Reel';
    }
    // Remove video platform suffixes
    t = t.replace(/ - YouTube$| - Vimeo$| \| Facebook$/i, '').trim();
    return t || (fallbackId ? `Facebook Reel · ${fallbackId}` : 'Video Media');
  }

  // Extract clean filename from URL or title
  function sanitizeFilename(title, ext = 'mp4') {
    const clean = title.replace(/[\\/:*?"<>|]/g, '').trim();
    return `${clean || 'download'}.${ext}`;
  }

  // Extract and record direct DOM video media candidates with background worker
  function recordDomMedia(videoEl) {
    if (!videoEl) return;
    const directSrc = videoEl.currentSrc || videoEl.src;
    if (directSrc && !directSrc.startsWith('blob:') && !directSrc.startsWith('data:')) {
      const lower = directSrc.toLowerCase();
      const ext = lower.includes('.webm') ? 'webm' : (lower.includes('.mkv') ? 'mkv' : 'mp4');
      const cType = lower.includes('.webm') ? 'video/webm' : (lower.includes('.mkv') ? 'video/x-matroska' : 'video/mp4');
      chrome.runtime.sendMessage({
        action: 'RECORD_MEDIA_FROM_DOM',
        candidate: {
          url: directSrc,
          filename: sanitizeFilename(getMediaTitle(videoEl), ext),
          size_bytes: null,
          content_type: cType,
        },
      });
    }

    const sources = videoEl.querySelectorAll('source');
    for (const s of sources) {
      const sSrc = s.src || s.getAttribute('src');
      if (sSrc && !sSrc.startsWith('blob:') && !sSrc.startsWith('data:')) {
        const lower = sSrc.toLowerCase();
        const ext = lower.includes('.webm') ? 'webm' : 'mp4';
        const cType = s.type || (lower.includes('.webm') ? 'video/webm' : 'video/mp4');
        chrome.runtime.sendMessage({
          action: 'RECORD_MEDIA_FROM_DOM',
          candidate: {
            url: sSrc,
            filename: sanitizeFilename(getMediaTitle(videoEl), ext),
            size_bytes: null,
            content_type: cType,
          },
        });
      }
    }
  }

  // Format bytes helper adhering to Gate 12.5.2 display guidelines
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    if (i === 0) return `${val} B`;
    const formatted = val < 100 ? (val.toFixed(1).endsWith('.0') ? val.toFixed(0) : val.toFixed(1)) : val.toFixed(0);
    return `${formatted} ${units[i]}`;
  }

  // Format filesize display strictly following Gate 12.5.2 priority:
  // 1. Exact filesize when reliably available: "24.6 MB"
  // 2. Otherwise filesize_approx: "~24.6 MB"
  // 3. Otherwise duration × bitrate estimate: "~24.6 MB"
  // 4. Otherwise: "Size unknown"
  function formatFilesizeDisplay(fmt, durationSeconds) {
    if (!fmt) return 'Size unknown';
    const fType = String(fmt.filesize_type || '').toLowerCase();
    if (fmt.filesize && fmt.filesize > 0 && fType !== 'estimated') {
      return formatBytes(fmt.filesize);
    }
    if (fmt.filesize_approx && fmt.filesize_approx > 0) {
      return `~${formatBytes(fmt.filesize_approx)}`;
    }
    if (fmt.filesize && fmt.filesize > 0 && fType === 'estimated') {
      return `~${formatBytes(fmt.filesize)}`;
    }
    const dur = durationSeconds || fmt.duration_seconds || fmt.duration || 0;
    const br = fmt.bitrate_kbps || 0;
    if (dur > 0 && br > 0) {
      const est = Math.round((dur * br * 1000) / 8);
      if (est > 0) {
        return `~${formatBytes(est)}`;
      }
    }
    return 'Size unknown';
  }

  function formatDuration(sec) {
    if (!sec || isNaN(sec) || !isFinite(sec)) return '';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // Extract genuine thumbnail image from video element or host page DOM
  function extractPageThumbnail(videoEl = null) {
    try {
      if (videoEl) {
        const poster = videoEl.getAttribute('poster') || videoEl.poster;
        if (poster && typeof poster === 'string' && poster.startsWith('http') && !poster.includes('blank.gif')) {
          return poster;
        }
        const container = videoEl.closest?.(
          '[data-pagelet*="Reel"], [role="article"], [data-pagelet*="FeedUnit"], div[data-video-id], .x1lliihq, [role="main"]'
        ) || videoEl.parentElement;
        if (container) {
          const imgs = container.querySelectorAll('img[src*="fbcdn.net"], img[src*="cdninstagram.com"], img[src*="scontent"]');
          for (const img of imgs) {
            const src = img.currentSrc || img.src || img.getAttribute('src');
            if (src && src.startsWith('http') && !src.includes('rsrc.php') && !src.includes('/static/')) {
              const rect = img.getBoundingClientRect();
              if (rect.width > 50 || rect.height > 50 || !rect.width) {
                return src;
              }
            }
          }
        }
      }

      const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
                    document.querySelector('meta[property="og:image:secure_url"]')?.getAttribute('content') ||
                    document.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ||
                    document.querySelector('link[rel="image_src"]')?.getAttribute('href');
      if (ogImg && ogImg.startsWith('http') && !ogImg.includes('rsrc.php')) {
        return ogImg;
      }
    } catch (_) {}
    return null;
  }

  // Extract direct HTML5 video src, source elements, and OpenGraph/JSON-LD video tags from DOM
  function extractDomMediaCandidates(videoEl = null) {
    const candidates = new Set();
    try {
      if (videoEl) {
        if (videoEl.currentSrc && !videoEl.currentSrc.startsWith('blob:') && !videoEl.currentSrc.startsWith('data:')) {
          candidates.add(videoEl.currentSrc);
        }
        if (videoEl.src && !videoEl.src.startsWith('blob:') && !videoEl.src.startsWith('data:')) {
          candidates.add(videoEl.src);
        }
        // Check custom attributes used by video players (data-src, data-url, data-video-url)
        const customAttrs = ['data-src', 'data-url', 'data-video-url', 'data-orig-src', 'data-mp4', 'data-hls'];
        for (const attr of customAttrs) {
          const val = videoEl.getAttribute(attr);
          if (val && !val.startsWith('blob:') && !val.startsWith('data:')) {
            try {
              candidates.add(new URL(val, window.location.href).href);
            } catch (_) {}
          }
        }
        const sources = videoEl.querySelectorAll('source');
        for (const s of sources) {
          const src = s.src || s.getAttribute('src');
          if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
            candidates.add(src);
          }
          for (const attr of customAttrs) {
            const val = s.getAttribute(attr);
            if (val && !val.startsWith('blob:') && !val.startsWith('data:')) {
              try {
                candidates.add(new URL(val, window.location.href).href);
              } catch (_) {}
            }
          }
        }
      }

      // Check OpenGraph, Twitter, and Link video metadata tags
      const metaSelectors = [
        'meta[property="og:video"]',
        'meta[property="og:video:url"]',
        'meta[property="og:video:secure_url"]',
        'meta[name="twitter:player:stream"]',
        'link[rel="video_src"]',
        'link[rel="preload"][as="video"]',
      ];
      for (const sel of metaSelectors) {
        const el = document.querySelector(sel);
        const val = el?.getAttribute('content') || el?.getAttribute('href');
        if (val && !val.startsWith('blob:') && !val.startsWith('data:')) {
          candidates.add(val);
        }
      }

      // Inspect JSON-LD for VideoObject contentUrl
      document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
        try {
          const json = JSON.parse(script.textContent || '{}');
          const parseObj = (o) => {
            if (!o || typeof o !== 'object') return;
            if (o['@type'] === 'VideoObject' || o.contentUrl) {
              if (o.contentUrl && typeof o.contentUrl === 'string' && !o.contentUrl.startsWith('blob:')) {
                candidates.add(o.contentUrl);
              }
            }
            if (Array.isArray(o['@graph'])) {
              o['@graph'].forEach(parseObj);
            }
          };
          parseObj(json);
        } catch (_) {}
      });
    } catch (_) {}
    return Array.from(candidates);
  }

  // Extract platform media identity to detect client-side SPA navigation
  function extractMediaIdentity(url, videoEl = null) {
    const rawUrl = url || window.location.href;
    const normalized = normalizePlatformUrl(rawUrl);
    const thumbUrl = extractPageThumbnail(videoEl);

    // If on Facebook/Instagram and current page URL is generic feed/home, check video element container
    if (videoEl && !normalized.isSpecific && (window.location.hostname.includes('facebook.com') || window.location.hostname.includes('fb.watch'))) {
      const container = videoEl.closest?.('[data-pagelet*="Reel"], [role="article"], [data-pagelet*="FeedUnit"], div[data-video-id], .x1lliihq, [role="main"]');
      if (container) {
        const anchor = container.querySelector('a[href*="/reel/"], a[href*="/reels/"], a[href*="/watch"], a[href*="/videos/"]');
        if (anchor && anchor.href) {
          const domNormalized = normalizePlatformUrl(anchor.href);
          if (domNormalized.isSpecific) {
            return {
              rawUrl,
              canonicalUrl: domNormalized.url,
              videoId: domNormalized.videoId,
              isSpecific: true,
              platform: domNormalized.platform,
              thumbnailUrl: thumbUrl,
            };
          }
        }
      }
    }

    return {
      rawUrl,
      canonicalUrl: normalized.url,
      videoId: normalized.videoId || normalized.url,
      isSpecific: normalized.isSpecific,
      platform: normalized.platform,
      thumbnailUrl: thumbUrl,
    };
  }

  function isSupportedPlatform(url) {
    const u = (url || window.location.href).toLowerCase();
    return (
      u.includes('youtube.com/watch') ||
      u.includes('youtu.be/') ||
      u.includes('facebook.com') ||
      u.includes('instagram.com') ||
      u.includes('vimeo.com') ||
      u.includes('dailymotion.com') ||
      u.includes('tiktok.com') ||
      u.includes('twitter.com') ||
      u.includes('x.com')
    );
  }

  // Transient in-page toast feedback
  function showToast(text, isError = false) {
    let toast = document.getElementById('tori-page-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'tori-page-toast';
      document.body.appendChild(toast);
    }
    toast.innerHTML = `
      <i class="tori-ft" style="--c:${isError ? '#e5484d' : '#30c75e'};width:20px;height:20px;border-radius:5px">
        <svg viewBox="0 0 24 24" style="width:12px;height:12px"><path d="${P.ck}"/></svg>
      </i>
      <span>${escapeHtml(text)}</span>
    `;
    toast.classList.add('on');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('on'), 2200);
  }

  // Remove all overlays
  function removeAllOverlays() {
    document.querySelectorAll('.tori-mp').forEach((el) => el.remove());
    document.querySelectorAll('[data-tori-attached]').forEach((el) => {
      el.removeAttribute('data-tori-attached');
    });
  }

  // Position class mapper
  function getPosClass(pos) {
    switch (pos) {
      case 'Top left':
        return 'pos-top-left';
      case 'Bottom right':
        return 'pos-bottom-right';
      case 'Bottom left':
        return 'pos-bottom-left';
      default:
        return 'pos-top-right';
    }
  }

  // Attach overlay to HTML5 video element
  function attachVideoOverlay(videoEl) {
    if (!videoEl || videoEl.hasAttribute('data-tori-attached')) return;
    if (isSiteExcluded() || !settings.pill) return;

    // In embedded iframes, skip tiny frames like ad widgets (< 160x120)
    if (window !== window.top) {
      if (window.innerWidth < 160 || window.innerHeight < 120) {
        return;
      }
    }

    // Must have reasonable dimensions
    const rect = videoEl.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 90) {
      if (!videoEl.__toriResizeObserved) {
        videoEl.__toriResizeObserved = true;
        const recheck = () => {
          const r = videoEl.getBoundingClientRect();
          if (r.width >= 120 && r.height >= 90) {
            videoEl.removeEventListener('loadedmetadata', recheck);
            videoEl.removeEventListener('playing', recheck);
            videoEl.removeEventListener('canplay', recheck);
            if (videoEl.__toriResizeObs) {
              videoEl.__toriResizeObs.disconnect();
              delete videoEl.__toriResizeObs;
            }
            attachVideoOverlay(videoEl);
          }
        };
        videoEl.addEventListener('loadedmetadata', recheck, { once: true });
        videoEl.addEventListener('playing', recheck, { once: true });
        videoEl.addEventListener('canplay', recheck, { once: true });
        if (typeof ResizeObserver === 'function') {
          const ro = new ResizeObserver(() => recheck());
          ro.observe(videoEl);
          videoEl.__toriResizeObs = ro;
        }
      }
      return;
    }

    // Anchor to player container if available to avoid stacking context clipping
    const anchor = videoEl.closest('.html5-video-player') ||
                   videoEl.closest('.video-stream-container') ||
                   videoEl.closest('.player-container') ||
                   videoEl.closest('.jwplayer') ||
                   videoEl.closest('.video-js') ||
                   videoEl.closest('.vjs-tech')?.parentElement ||
                   videoEl.closest('.dmp_VideoPlayer') ||
                   videoEl.closest('[data-player-root]') ||
                   videoEl.closest('[class*="player"]') ||
                   videoEl.closest('[class*="Player"]') ||
                   videoEl.parentElement;
    if (!anchor) return;

    // Prevent duplicate overlays for this specific video element or dedicated player anchor
    const existingMps = anchor.querySelectorAll(':scope > .tori-mp');
    for (const em of existingMps) {
      if (em.__toriVideoEl === videoEl) return;
    }
    if (anchor !== videoEl.parentElement && existingMps.length > 0) {
      return;
    }

    videoEl.setAttribute('data-tori-attached', 'true');

    const style = window.getComputedStyle(anchor);
    if (style.position === 'static') {
      anchor.style.position = 'relative';
    }

    // Create container
    const mp = document.createElement('div');
    mp.className = `tori-mp ${getPosClass(settings.pos)}`;
    mp.__toriVideoEl = videoEl;

    // Create pill button
    const pill = document.createElement('button');
    pill.className = 'tori-pill pill';
    pill.type = 'button';
    pill.setAttribute('aria-expanded', 'false');
    pill.innerHTML = `
      <span class="ico tori-logo">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="${P.dl}"/>
        </svg>
      </span>
      <span>Download video</span>
      <span class="chip tori-pill-tag">Media</span>
    `;

    // Create format panel
    const pn = document.createElement('div');
    pn.className = 'tori-pn panel';

    mp.appendChild(pill);
    mp.appendChild(pn);
    anchor.appendChild(mp);

    // Isolate ALL mouse, touch, and click events so video player controls never intercept
    const isolateEvents = (el) => {
      ['mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'contextmenu'].forEach((evt) => {
        el.addEventListener(evt, (e) => {
          e.stopPropagation();
        });
      });
    };

    isolateEvents(mp);
    isolateEvents(pill);
    isolateEvents(pn);

    // Draggable Overlay Implementation
    let isPointerDown = false;
    let isDragging = false;
    let wasDragged = false;
    let activePointerId = null;
    let hasPointerCapture = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let elemStartX = 0;
    let elemStartY = 0;
    const DRAG_THRESHOLD = 5;

    // Restore saved custom position if available
    try {
      chrome.storage.local.get(['tori_custom_overlay_pos'], (res) => {
        if (res && res.tori_custom_overlay_pos) {
          const { rx, ry } = res.tori_custom_overlay_pos;
          if (typeof rx === 'number' && typeof ry === 'number' && rx >= 0 && rx <= 1 && ry >= 0 && ry <= 1) {
            mp.setAttribute('data-pos-rx', rx.toFixed(4));
            mp.setAttribute('data-pos-ry', ry.toFixed(4));
            const aRect = anchor.getBoundingClientRect();
            if (aRect.width > 60 && aRect.height > 60) {
              const maxL = Math.max(4, aRect.width - 160);
              const maxT = Math.max(4, aRect.height - 36);
              const l = Math.min(Math.max(4, Math.round(rx * aRect.width)), maxL);
              const t = Math.min(Math.max(4, Math.round(ry * aRect.height)), maxT);
              mp.style.left = `${l}px`;
              mp.style.top = `${t}px`;
              mp.style.right = 'auto';
              mp.style.bottom = 'auto';
            }
          }
        }
      });
    } catch (_) {}

    const endDrag = (e, savePosition = true) => {
      if (!isPointerDown && !isDragging) return;

      const didDrag = isDragging;
      isPointerDown = false;
      isDragging = false;
      mp.classList.remove('tori-dragging');

      // Unbind capturing window listeners
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerCancel, true);
      window.removeEventListener('blur', onWindowBlur);

      // Unbind element listeners
      pill.removeEventListener('pointerup', onPointerUp);
      pill.removeEventListener('pointercancel', onPointerCancel);
      pill.removeEventListener('lostpointercapture', onLostPointerCapture);

      // Safely release pointer capture if active
      if (hasPointerCapture && activePointerId !== null) {
        try {
          if (pill.hasPointerCapture && pill.hasPointerCapture(activePointerId)) {
            pill.releasePointerCapture(activePointerId);
          }
        } catch (_) {}
        hasPointerCapture = false;
      }
      activePointerId = null;

      if (didDrag) {
        wasDragged = true;

        if (savePosition) {
          const aRect = anchor.getBoundingClientRect();
          if (aRect.width > 0 && aRect.height > 0) {
            const l = parseFloat(mp.style.left) || 0;
            const t = parseFloat(mp.style.top) || 0;
            const rx = Math.min(Math.max(0, l / aRect.width), 1);
            const ry = Math.min(Math.max(0, t / aRect.height), 1);
            mp.setAttribute('data-pos-rx', rx.toFixed(4));
            mp.setAttribute('data-pos-ry', ry.toFixed(4));
            try {
              chrome.storage.local.set({
                tori_custom_overlay_pos: { rx, ry },
              });
            } catch (_) {}
          }
        }

        setTimeout(() => {
          wasDragged = false;
        }, 120);
      }
    };

    const onPointerMove = (e) => {
      if (!isPointerDown) return;
      if (activePointerId !== null && e.pointerId !== activePointerId) return;

      // Primary mouse button must remain pressed during drag
      if (e.pointerType === 'mouse' && (e.buttons & 1) === 0) {
        endDrag(e, false);
        return;
      }

      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;

      if (!isDragging) {
        if (Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
          isDragging = true;
          wasDragged = true;
          mp.classList.add('tori-dragging');
          try {
            pill.setPointerCapture(activePointerId);
            hasPointerCapture = true;
          } catch (_) {}
        } else {
          return;
        }
      }

      if (isDragging) {
        e.preventDefault();
        const aRect = anchor.getBoundingClientRect();
        let targetX = elemStartX + dx;
        let targetY = elemStartY + dy;

        const maxL = Math.max(4, aRect.width - (mp.offsetWidth || 160) - 4);
        const maxT = Math.max(4, aRect.height - (mp.offsetHeight || 36) - 4);

        targetX = Math.min(Math.max(4, targetX), maxL);
        targetY = Math.min(Math.max(4, targetY), maxT);

        mp.style.left = `${targetX}px`;
        mp.style.top = `${targetY}px`;
        mp.style.right = 'auto';
        mp.style.bottom = 'auto';
      }
    };

    const onPointerUp = (e) => {
      endDrag(e, true);
    };

    const onPointerCancel = (e) => {
      endDrag(e, false);
    };

    const onLostPointerCapture = (e) => {
      endDrag(e, true);
    };

    const onWindowBlur = () => {
      endDrag(null, false);
    };

    pill.addEventListener('pointerdown', (e) => {
      // Only primary mouse button can initiate mouse dragging
      if (e.button !== 0) return;

      if (isPointerDown || isDragging) {
        endDrag(e, false);
      }

      isPointerDown = true;
      isDragging = false;
      wasDragged = false;
      activePointerId = e.pointerId;
      hasPointerCapture = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;

      const aRect = anchor.getBoundingClientRect();
      const mRect = mp.getBoundingClientRect();
      elemStartX = mRect.left - aRect.left;
      elemStartY = mRect.top - aRect.top;

      window.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
      window.addEventListener('pointerup', onPointerUp, { capture: true });
      window.addEventListener('pointercancel', onPointerCancel, { capture: true });
      window.addEventListener('blur', onWindowBlur);

      pill.addEventListener('pointerup', onPointerUp);
      pill.addEventListener('pointercancel', onPointerCancel);
      pill.addEventListener('lostpointercapture', onLostPointerCapture);
    });

    const onResizeClamp = () => {
      if (mp.style.left && mp.style.left !== 'auto') {
        const aRect = anchor.getBoundingClientRect();
        if (aRect.width > 0 && aRect.height > 0) {
          let curL = parseFloat(mp.style.left) || 4;
          let curT = parseFloat(mp.style.top) || 4;
          const maxL = Math.max(4, aRect.width - (mp.offsetWidth || 160) - 4);
          const maxT = Math.max(4, aRect.height - (mp.offsetHeight || 36) - 4);
          mp.style.left = `${Math.min(Math.max(4, curL), maxL)}px`;
          mp.style.top = `${Math.min(Math.max(4, curT), maxT)}px`;
        }
      }
    };
    window.addEventListener('resize', onResizeClamp);

    let activeTab = settings.kind === 'Audio only' ? 'Audio' : 'Video';
    let selectedIdx = 0;
    let isDownloaded = false;
    let tabMediaCandidates = [];
    let resolvedMeta = null;
    let isResolving = false;
    let resolveError = null;
    let currentMediaIdentity = extractMediaIdentity(null, videoEl);
    let currentGeneration = 0;
    let resolveTimeoutTimer = null;

    function triggerResolution(force = false) {
      if (isResolving && !force) return;

      // Re-evaluate identity with current DOM context
      currentMediaIdentity = extractMediaIdentity(null, videoEl);

      // If on Facebook/Instagram and no specific Reel/Video was identified, notify user immediately
      if (!currentMediaIdentity.isSpecific && isManagedPlatform(window.location.hostname)) {
        isResolving = false;
        resolveError = 'Feed / stream not isolated. Please open the specific Reel directly in its own tab.';
        updatePillTag();
        renderPanel();
        return;
      }

      isResolving = true;
      resolveError = null;
      renderPanel();
      updatePillTag();

      const thisGen = currentGeneration;
      const targetUrl = currentMediaIdentity?.canonicalUrl || currentMediaIdentity?.rawUrl || window.location.href;
      const reqId = 'req_res_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
      const isPlatform = isSupportedPlatform(window.location.href) || isManagedPlatform(window.location.hostname);
      const resolutionTimeoutMs = isPlatform ? 22000 : 12000;
      const startTime = Date.now();

      // Sanitized diagnostic log
      console.log(`[TORI Diagnostic] Resolve started: ID=${reqId}, Host=${window.location.hostname}, Frame=${window === window.top ? 'top' : 'iframe'}, Platform=${isPlatform ? 'managed' : 'generic'}`);

      if (resolveTimeoutTimer) clearTimeout(resolveTimeoutTimer);
      // Hard bounded timeout ensures UI ALWAYS transitions to a terminal state
      resolveTimeoutTimer = setTimeout(() => {
        if (isResolving && thisGen === currentGeneration) {
          const elapsed = Date.now() - startTime;
          console.warn(`[TORI Diagnostic] Resolution timed out: ID=${reqId}, Elapsed=${elapsed}ms`);
          isResolving = false;
          resolveError = `Media resolution timed out (${Math.round(resolutionTimeoutMs / 1000)}s). Remote host took too long to respond.`;
          updatePillTag();
          renderPanel();
        }
      }, resolutionTimeoutMs);

      chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA' }, (mRes) => {
        if (thisGen !== currentGeneration) return;
        tabMediaCandidates = mRes?.media || [];
        // If on generic site and network candidates are captured, make them visible immediately
        if (tabMediaCandidates.length > 0 && !isPlatform) {
          updatePillTag();
          renderPanel();
        }
      });

      const domCandidates = Array.from(extractDomMediaCandidates(videoEl));
      const domThumbnail = extractPageThumbnail(videoEl);
      const mediaTitle = getMediaTitle(videoEl);

      chrome.runtime.sendMessage(
        {
          action: 'RESOLVE_MEDIA',
          url: targetUrl,
          generation: thisGen,
          correlation_id: reqId,
          candidates: domCandidates,
          page_title: mediaTitle,
          thumbnail_url: domThumbnail,
        },
        (rRes) => {
          if (resolveTimeoutTimer) clearTimeout(resolveTimeoutTimer);
          if (thisGen !== currentGeneration) {
            console.log(`[TORI] Dropping stale resolution response for gen ${thisGen}, current is ${currentGeneration}`);
            return;
          }
          isResolving = false;
          const elapsed = Date.now() - startTime;
          if (rRes && rRes.status === 'ok' && rRes.metadata) {
            resolvedMeta = rRes.metadata;
            resolveError = null;
            console.log(`[TORI Diagnostic] Resolve succeeded: ID=${reqId}, Extractor=${resolvedMeta.extractor || 'unknown'}, Formats=${resolvedMeta.formats?.length || 0}, Elapsed=${elapsed}ms`);
          } else {
            resolveError = rRes?.message || 'Protected, restricted, or unsupported stream.';
            console.log(`[TORI Diagnostic] Resolve terminal failure: ID=${reqId}, Code=${rRes?.code || 'ERROR'}, Message=${resolveError}, Elapsed=${elapsed}ms`);
          }
          updatePillTag();
          renderPanel();
        }
      );
    }

    function handleVideoNavigation(reason) {
      const newIdentity = extractMediaIdentity(null, videoEl);
      // If videoId is identical, this is just buffering, seek, or URL parameter jitter. IGNORE IT!
      if (currentMediaIdentity && currentMediaIdentity.videoId && newIdentity.videoId) {
        if (currentMediaIdentity.videoId === newIdentity.videoId) {
          return;
        }
      }

      console.log(`[TORI Content] Video navigation detected (${reason}):`, currentMediaIdentity?.canonicalUrl, '->', newIdentity.canonicalUrl);
      currentMediaIdentity = newIdentity;
      if (resolveTimeoutTimer) clearTimeout(resolveTimeoutTimer);
      currentGeneration++;

      // Immediately invalidate old media state
      resolvedMeta = null;
      selectedIdx = 0;
      tabMediaCandidates = [];
      resolveError = null;

      // Reset pill tag to "Resolving…"
      const tagEl = pill.querySelector('.tori-pill-tag');
      if (tagEl) {
        tagEl.textContent = 'Resolving…';
        tagEl.style.color = 'var(--tori-blue)';
        tagEl.style.background = 'rgba(79, 70, 229, 0.12)';
      }

      // Automatically trigger resolution for the new video
      triggerResolution(true);
    }

    mp.__toriHandleNav = handleVideoNavigation;
    mp.__toriTriggerResolution = triggerResolution;
    mp.__toriGetMediaInfo = () => ({
      url: window.location.href,
      identity: currentMediaIdentity,
      title: (resolvedMeta && resolvedMeta.title) ? resolvedMeta.title : getMediaTitle(videoEl, currentMediaIdentity?.videoId),
      thumbnailUrl: (resolvedMeta && resolvedMeta.thumbnail_url) || currentMediaIdentity?.thumbnailUrl || extractPageThumbnail(videoEl) || null,
      isResolving,
      resolveError,
      resolvedMeta,
      hasAnyCandidates: getAvailableFormats().hasAnyCandidates,
      videoFormats: getAvailableFormats().videoFormats,
      audioFormats: getAvailableFormats().audioFormats,
    });

    // Collect genuine detected media candidates (never hardcoded, never webpage URL)
    function getAvailableFormats() {
      if (resolvedMeta && Array.isArray(resolvedMeta.formats) && resolvedMeta.formats.length > 0) {
        const title = resolvedMeta.title || getMediaTitle(videoEl, currentMediaIdentity?.videoId);
        const durStr = formatDuration(resolvedMeta.duration_seconds || videoEl.duration);
        const subInfo = durStr ? `${durStr} · ${resolvedMeta.site_name}` : resolvedMeta.site_name;

        const videoFormats = [];
        const audioFormats = [];

        resolvedMeta.formats.forEach((f) => {
          const isAudio = !f.has_video && f.has_audio;
          const isHd = !!(f.height && f.height >= 720);
          const sizeStr = formatFilesizeDisplay(f, resolvedMeta.duration_seconds || videoEl.duration);

          let qLabel = f.resolution_label || (isAudio ? 'Audio' : 'Media');
          if (isAudio && (qLabel.startsWith('Audio (') || qLabel.length > 8)) {
            if (f.bitrate_kbps && f.bitrate_kbps > 0) {
              qLabel = `${Math.round(f.bitrate_kbps)}k`;
            } else {
              qLabel = 'Audio';
            }
          }

          let desc = f.format_note || f.vcodec || f.acodec || f.protocol || '';
          if (isAudio) {
            const codec = f.acodec ? f.acodec.split('.')[0] : '';
            const note = f.format_note && f.format_note !== f.acodec ? f.format_note : '';
            desc = codec && note ? `${codec} · ${note}` : codec || note || 'Audio stream';
          }

          const item = {
            q: qLabel,
            tg: (f.container || (isAudio ? 'mp3' : 'mp4')).toUpperCase(),
            hd: isHd ? 'HD' : null,
            cd: desc,
            sz: sizeStr,
            url: f.direct_stream_url || f.url || resolvedMeta.source_url,
            format_id: f.format_id,
            filename: sanitizeFilename(title, (f.container || (isAudio ? 'mp3' : 'mp4')).toLowerCase()),
            isAudio,
            isManaged: f.download_capability === 'managed_extractor' || !!f.format_id,
            thumbnail_url: (resolvedMeta && resolvedMeta.thumbnail_url) || currentMediaIdentity?.thumbnailUrl || extractPageThumbnail(videoEl) || null,
          };

          if (isAudio) {
            audioFormats.push(item);
          } else {
            videoFormats.push(item);
          }
        });

        return {
          title,
          subInfo,
          videoFormats,
          audioFormats,
          hasAnyCandidates: videoFormats.length > 0 || audioFormats.length > 0,
        };
      }

      const title = getMediaTitle(videoEl, currentMediaIdentity?.videoId);
      const host = window.location.hostname;
      const durationStr = formatDuration(videoEl.duration);
      const subInfo = durationStr ? `${durationStr} · ${host}` : host;

      const candidates = [];
      const seenUrls = new Set();

      function addCandidate(rawUrl, formatHint, sizeBytes, codecHint) {
        if (!rawUrl || typeof rawUrl !== 'string') return;
        const u = rawUrl.trim();
        if (!u || u.startsWith('blob:') || u.startsWith('data:') || u.startsWith('javascript:')) return;
        if (!u.startsWith('http://') && !u.startsWith('https://')) return;
        if (u === window.location.href) return;
        const lower = u.toLowerCase();
        if (lower.includes('youtube.com/watch') || lower.includes('youtu.be/')) return;
        if (lower.endsWith('.html') || lower.endsWith('.htm')) return;
        if (seenUrls.has(u)) return;
        seenUrls.add(u);

        let ext = formatHint;
        let isAudio = false;
        const isHls = lower.includes('.m3u8');
        const isDash = lower.includes('.mpd');

        if (!ext) {
          if (isHls) ext = 'm3u8';
          else if (isDash) ext = 'mpd';
          else {
            const cleanPath = lower.split('?')[0].split('#')[0];
            const seg = cleanPath.split('.').pop() || '';
            if (['mp4', 'webm', 'mkv', 'mov', 'avi', 'flv', 'wmv'].includes(seg)) {
              ext = seg.toUpperCase();
            } else if (['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav'].includes(seg)) {
              ext = seg.toUpperCase();
              isAudio = true;
            } else {
              ext = 'MP4';
            }
          }
        } else {
          const lExt = ext.toLowerCase();
          if (['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav', 'audio'].some((s) => lExt.includes(s))) {
            isAudio = true;
          }
        }

        const isPortrait = videoEl.videoWidth && videoEl.videoHeight && videoEl.videoHeight > videoEl.videoWidth;
        const isHd = (isPortrait ? videoEl.videoWidth : videoEl.videoHeight) >= 720;
        let qualityLabel = '';
        if (isPortrait) {
          qualityLabel = `${videoEl.videoWidth} × ${videoEl.videoHeight} · Portrait`;
        } else if (videoEl.videoHeight) {
          qualityLabel = `${videoEl.videoHeight}p`;
        } else if (isHls) {
          qualityLabel = 'Adaptive';
        } else if (isDash) {
          qualityLabel = 'DASH';
        } else if (isAudio) {
          qualityLabel = ext;
        } else {
          qualityLabel = ext;
        }

        let codecLabel = codecHint;
        if (!codecLabel) {
          if (videoEl.videoWidth && videoEl.videoHeight) {
            codecLabel = `${videoEl.videoWidth}x${videoEl.videoHeight}`;
          } else if (isHls) {
            codecLabel = 'HLS Stream';
          } else if (isDash) {
            codecLabel = 'DASH Manifest';
          } else {
            codecLabel = 'Direct Stream';
          }
        }

        const sizeStr = sizeBytes && sizeBytes > 0 ? formatBytes(sizeBytes) : (isHls || isDash ? 'VOD' : 'Direct');

        candidates.push({
          q: qualityLabel,
          tg: ext.toUpperCase(),
          hd: isHd ? 'HD' : null,
          cd: codecLabel,
          sz: sizeStr,
          url: u,
          filename: sanitizeFilename(title, ext.toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4'),
          isAudio,
        });
      }

      // 1. Direct src / currentSrc on video element
      const direct = videoEl.currentSrc || videoEl.src || '';
      if (direct) {
        addCandidate(direct, null, null, null);
      }

      // 2. Direct sources inside videoEl
      videoEl.querySelectorAll('source').forEach((s) => {
        const sUrl = s.src || s.getAttribute('src');
        if (sUrl) {
          try {
            const abs = new URL(sUrl, window.location.href).href;
            addCandidate(abs, null, null, s.type || null);
          } catch (_) {}
        }
      });

      // 3. Tab candidates from background webRequest interception (strictly excluding partial transport fragments)
      const displayCandidates = tabMediaCandidates.filter((c) => !c.is_segment && c.type !== 'segment');

      displayCandidates.forEach((tc) => {
        if (tc && tc.url) {
          addCandidate(tc.url, tc.format, tc.size_bytes, tc.content_type);
        }
      });

      const videoFormats = candidates.filter((c) => !c.isAudio);
      const audioFormats = candidates.filter((c) => c.isAudio);
      const hasAnyCandidates = candidates.length > 0;

      return { title, subInfo, videoFormats, audioFormats, hasAnyCandidates };
    }

    function updatePillTag() {
      const { videoFormats, audioFormats, hasAnyCandidates } = getAvailableFormats();
      const tagEl = pill.querySelector('.tori-pill-tag');
      if (!tagEl) return;

      pill.classList.toggle('on', hasAnyCandidates);
      mp.classList.toggle('on', hasAnyCandidates);

      if (isResolving) {
        tagEl.textContent = 'Resolving…';
        tagEl.className = 'chip tori-pill-tag';
        tagEl.style.color = '#5b5bf0';
        tagEl.style.background = '#eceafe';
      } else if (hasAnyCandidates) {
        const top = videoFormats[0] || audioFormats[0];
        tagEl.textContent = top.q || top.tg || 'Media';
        tagEl.className = 'chip tori-pill-tag hd';
        tagEl.style.color = '';
        tagEl.style.background = '';
      } else if (resolveError) {
        tagEl.textContent = 'Unavailable';
        tagEl.className = 'chip tori-pill-tag';
        tagEl.style.color = '#dc2626';
        tagEl.style.background = '#fee2e2';
      } else {
        tagEl.textContent = 'Media';
        tagEl.className = 'chip tori-pill-tag';
        tagEl.style.color = '';
        tagEl.style.background = '';
      }
    }

    // Pill click handler
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();

      if (wasDragged) {
        wasDragged = false;
        return;
      }

      // If user disabled format picker, trigger download directly
      if (!settings.picker) {
        triggerDirectDownload(videoEl);
        return;
      }

      const isOpen = pn.classList.contains('on');
      // Close any other open panels
      document.querySelectorAll('.tori-pn.on').forEach((p) => {
        if (p !== pn) p.classList.remove('on');
      });

      if (isOpen) {
        pn.classList.remove('on');
        pill.setAttribute('aria-expanded', 'false');
      } else {
        pn.classList.add('on');
        pill.setAttribute('aria-expanded', 'true');
        // Render panel immediately so there is never an unpopulated/blank frame
        renderPanel();

        // If not yet resolved and not resolving, initiate resolution
        if (!resolvedMeta && !isResolving) {
          triggerResolution(false);
        }
      }
    });

    function getErrorNotice(err) {
      const e = (err || '').trim();
      const lower = e.toLowerCase();

      if (lower.includes('timed out') || lower.includes('timeout')) {
        return {
          title: 'Resolution Timed Out',
          desc: e.includes('(') ? e : 'Media resolution timed out. Remote platform took longer than expected to respond.',
          hint: 'Please check your connection and retry.',
          color: '#f59e0b',
        };
      }
      if (
        lower.includes('unauthorized') ||
        lower.includes('authentication required') ||
        lower.includes('api key') ||
        lower.includes('pairing')
      ) {
        return {
          title: 'Pairing Required',
          desc: 'The browser extension is not authenticated with TORI Desktop.',
          hint: 'Please check the pairing API key in Extension Settings.',
          color: '#e5484d',
        };
      }
      if (
        lower.includes('429') ||
        lower.includes('rate limit') ||
        lower.includes('too many requests')
      ) {
        return {
          title: 'Rate Limited (HTTP 429)',
          desc: 'The streaming platform temporarily limited automated requests.',
          hint: 'Please wait a moment before trying again.',
          color: '#f59e0b',
        };
      }
      if (
        lower.includes('could not connect') ||
        lower.includes('econnrefused') ||
        lower.includes('is tori running')
      ) {
        return {
          title: 'TORI Desktop Offline',
          desc: 'Could not connect to the local TORI server at 127.0.0.1:6800.',
          hint: 'Ensure TORI Download Manager is launched.',
          color: '#e5484d',
        };
      }
      if (
        lower.includes('drm') ||
        lower.includes('widevine') ||
        lower.includes('playready') ||
        lower.includes('fairplay') ||
        lower.includes('encrypted') ||
        lower.includes('plex.tv') ||
        lower.includes('protected')
      ) {
        return {
          title: 'Protected Media (DRM)',
          desc: lower.includes('plex.tv')
            ? 'watch.plex.tv content is DRM-protected and not licensed for offline download.'
            : 'This stream is encrypted by digital rights management (DRM) or licensing restrictions.',
          hint: 'TORI respects content protection boundaries and does not perform DRM circumvention.',
          color: '#8e8e93',
        };
      }
      if (
        lower.includes('logged-in') ||
        lower.includes('cookies') ||
        lower.includes('login') ||
        lower.includes('sign in') ||
        lower.includes('forbidden') ||
        lower.includes('403') ||
        lower.includes('access restricted') ||
        lower.includes('access denied') ||
        lower.includes('private video')
      ) {
        return {
          title: 'Access Restricted',
          desc: e || 'Remote server denied access (HTTP 403 or platform account login required).',
          hint: 'Log in to the host platform or verify your account permissions.',
          color: '#f59e0b',
        };
      }
      if (
        lower.includes('unsupported extractor') ||
        lower.includes('unsupported url') ||
        lower.includes('no suitable extractor') ||
        lower.includes('no supported media extractor')
      ) {
        return {
          title: 'Unsupported Extractor',
          desc: 'No dedicated media extractor is available for this webpage URL.',
          hint: 'Play the video in your browser to capture its direct stream.',
          color: '#8e8e93',
        };
      }
      if (
        lower.includes('connection lost') ||
        lower.includes('connection reset') ||
        lower.includes('network') ||
        lower.includes('econnreset')
      ) {
        return {
          title: 'Network Error',
          desc: 'Connection interrupted or remote server closed the connection.',
          hint: 'Check your network connection and retry.',
          color: '#e5484d',
        };
      }
      if (
        lower.includes('no downloadable media') ||
        lower.includes('no video formats') ||
        lower.includes('no formats found') ||
        lower.includes('no direct media')
      ) {
        return {
          title: 'No Downloadable Media',
          desc: e || 'No direct media, HLS/DASH manifest, or extractor format was found.',
          hint: 'Play the video in your browser to allow network stream capture.',
          color: '#8e8e93',
        };
      }
      return {
        title: 'No Downloadable Media',
        desc: e || 'No direct media stream or manifest detected on this player.',
        hint: 'Play the video in your browser to capture the stream.',
        color: '#8e8e93',
      };
    }

    function renderPanel() {
      const { title, subInfo, videoFormats, audioFormats, hasAnyCandidates } = getAvailableFormats();
      const currentList = activeTab === 'Video' ? videoFormats : audioFormats;
      if (selectedIdx >= currentList.length) selectedIdx = 0;
      const currentItem = currentList[selectedIdx];

      let listHtml = '';
      if (isResolving && !hasAnyCandidates) {
        listHtml = `
          <div class="state" style="padding:24px 14px">
            <div class="tori-spin"></div>
            <b>Resolving media formats…</b>
            <p>Extracting genuine quality streams and formats</p>
          </div>`;
      } else if (hasAnyCandidates) {
        if (currentList.length > 0) {
          listHtml = currentList
            .map(
              (f, i) => `
            <button type="button" class="row tori-fr ${i === selectedIdx ? 'on' : ''} ${f.isAudio ? 'audio' : ''}" data-idx="${i}" role="radio" aria-checked="${i === selectedIdx ? 'true' : 'false'}">
              <b class="tori-q" title="${escapeHtml(f.q)}">${escapeHtml(f.q)}</b>
              <span class="tori-cd" title="${escapeHtml(f.cd)}">${escapeHtml(f.cd)}</span>
              <em class="tori-sz">${escapeHtml(f.sz)}</em>
            </button>`
            )
            .join('');
        } else {
          listHtml = `
            <div class="state">
              <p>No separate ${escapeHtml(activeTab.toLowerCase())} stream detected for this media.</p>
            </div>`;
        }
      } else {
        const notice = getErrorNotice(resolveError);
        listHtml = `
          <div class="state">
            <i></i>
            <b>${escapeHtml(notice.title)}</b>
            <p>${escapeHtml(notice.desc)}</p>
            <span style="font-size:11px;color:#6b7280;margin:4px 0 8px">${escapeHtml(notice.hint)}</span>
            <button class="tori-retry-btn" data-act="retry" type="button" style="border:1px solid #e6e8ee;border-radius:8px;padding:6px 14px;background:#fff;cursor:pointer;font-weight:600;font-size:12px;color:#171a21">
              Retry resolution
            </button>
          </div>`;
      }

      const canDownload = hasAnyCandidates && !isResolving && !!currentItem && !!currentItem.url;
      const dlBtnText = isResolving
        ? 'Resolving formats…'
        : !hasAnyCandidates
        ? 'Source Unavailable'
        : !currentItem
        ? 'No Stream'
        : isDownloaded
        ? 'Sent to Tori ✓'
        : activeTab === 'Video'
        ? 'Download video'
        : 'Download audio';

      pn.innerHTML = `
        <div class="head tori-ph">
          <div class="thumb">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <div class="meta" style="min-width:0">
            <b id="title">${escapeHtml(title)}</b>
            <span id="sub">${escapeHtml(subInfo)}</span>
          </div>
          <button class="x tori-x" data-act="close" aria-label="Close">×</button>
        </div>

        ${
          window.location.href.includes('list=')
            ? `
        <div style="margin: 4px 14px 2px; padding: 6px 10px; background: rgba(91,91,240,0.1); border: 1px solid rgba(91,91,240,0.25); border-radius: 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
          <span style="font-size: 11.5px; color: #4338ca; font-weight: 600;">⚡ Playlist available</span>
          <button type="button" data-act="open-playlist" style="font-size: 11px; padding: 3px 8px; background: #5b5bf0; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">Download Playlist</button>
        </div>`
            : ''
        }

        <div class="seg tori-seg" role="tablist">
          <button type="button" role="tab" class="${activeTab === 'Video' ? 'on' : ''}" data-tab="Video" aria-selected="${activeTab === 'Video' ? 'true' : 'false'}">Video</button>
          <button type="button" role="tab" class="${activeTab === 'Audio' ? 'on' : ''}" data-tab="Audio" aria-selected="${activeTab === 'Audio' ? 'true' : 'false'}">Audio only</button>
        </div>

        <div class="list tori-fl" role="radiogroup" aria-label="Quality">
          ${listHtml}
        </div>

        <div class="btns tori-ac">
          <button type="button" class="copy tori-btn sq ${canDownload ? '' : 'dis'}" ${canDownload ? '' : 'disabled'} data-act="copy" aria-label="Copy link" title="${canDownload ? 'Copy stream URL' : 'No stream URL available'}">⧉</button>
          <button type="button" class="go tori-btn primary def ${canDownload ? '' : 'dis'} ${isDownloaded ? 'ok' : ''}" ${canDownload ? '' : 'disabled'} data-act="download"><span>${escapeHtml(dlBtnText)}</span></button>
        </div>

        <div class="foot tori-pf">
          Save to <b id="path">Downloads\\Tori\\${escapeHtml(activeTab)}</b>
        </div>
      `;

      // Event handlers for panel controls
      pn.querySelectorAll('[data-tab]').forEach((tabBtn) => {
        tabBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          activeTab = tabBtn.dataset.tab;
          selectedIdx = 0;
          renderPanel();
        });
      });

      pn.querySelectorAll('.tori-fr').forEach((row) => {
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          selectedIdx = parseInt(row.dataset.idx, 10);
          renderPanel();
        });
      });

      const closeBtn = pn.querySelector('[data-act="close"]');
      if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.stopImmediatePropagation();
          pn.classList.remove('on');
          pill.setAttribute('aria-expanded', 'false');
        });
      }

      const retryBtn = pn.querySelector('[data-act="retry"]');
      if (retryBtn) {
        retryBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.stopImmediatePropagation();
          triggerResolution(true);
        });
      }

      const copyBtn = pn.querySelector('[data-act="copy"]');
      if (copyBtn) {
        copyBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!canDownload) {
            showToast('No downloadable stream URL available', true);
            return;
          }
          const target = currentList[selectedIdx];
          if (target && target.url) {
            try {
              await navigator.clipboard.writeText(target.url);
              showToast('Link copied');
            } catch (_) {
              showToast('Could not copy link', true);
            }
          }
        });
      }

      const playlistBtn = pn.querySelector('[data-act="open-playlist"]');
      if (playlistBtn) {
        playlistBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          chrome.runtime.sendMessage({ action: 'SHOW_DESKTOP' });
          chrome.runtime.sendMessage({
            action: 'RESOLVE_PLAYLIST',
            url: window.location.href,
          });
          pn.classList.remove('on');
          showToast('Opening Playlist in TORI...');
        });
      }

      const dlBtn = pn.querySelector('[data-act="download"]');
      if (dlBtn) {
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (dlBtn.disabled || dlBtn.classList.contains('pending')) {
            return;
          }
          if (!canDownload) {
            showToast('No downloadable media stream available on this page', true);
            return;
          }
          const target = currentList[selectedIdx];
          if (!target || (!target.url && !target.format_id)) {
            showToast('No downloadable stream available', true);
            return;
          }

          dlBtn.disabled = true;
          dlBtn.classList.add('pending');
          const btnSpan = dlBtn.querySelector('span');
          const originalText = btnSpan ? btnSpan.textContent : 'Download';
          if (btnSpan) btnSpan.textContent = 'Sending to Tori…';

          const correlationId = 'tori_req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
          console.log('[TORI] Manual download click', {
            correlationId,
            format_id: target.format_id,
            isManaged: !!target.format_id || target.isManaged,
            filename: target.filename,
          });

          const isSocialPlatform = isManagedPlatform(window.location.hostname);
          const isTransientCdn = isTransientCdnUrl(target.url);
          const shouldUseManaged = target.format_id || target.isManaged || isSocialPlatform || isTransientCdn;

          const pageThumb = target.thumbnail_url || (resolvedMeta && resolvedMeta.thumbnail_url) || currentMediaIdentity?.thumbnailUrl || extractPageThumbnail(videoEl) || null;
          const reqPayload = shouldUseManaged
            ? {
                action: 'START_MEDIA_DOWNLOAD',
                url: (resolvedMeta && resolvedMeta.source_url) ? resolvedMeta.source_url : window.location.href,
                format_id: target.format_id || 'best',
                filename: target.filename,
                priority: 'high',
                correlation_id: correlationId,
                page_url: window.location.href,
                thumbnail_url: pageThumb,
                user_agent: navigator.userAgent,
              }
            : {
                action: 'START_DOWNLOAD',
                url: target.url,
                filename: target.filename,
                priority: 'high',
                correlation_id: correlationId,
                page_url: window.location.href,
                thumbnail_url: pageThumb,
                user_agent: navigator.userAgent,
              };

          chrome.runtime.sendMessage(reqPayload, (res) => {
            dlBtn.classList.remove('pending');
            if (res && res.status === 'ok' && res.job_id) {
              console.log('[TORI] Download queued successfully', { correlationId, job_id: res.job_id });
              isDownloaded = true;
              dlBtn.classList.add('ok');
              if (btnSpan) btnSpan.textContent = 'Queued in Tori';
              showToast(`Download queued in Tori (${res.filename || target.filename})`);
              setTimeout(() => {
                isDownloaded = false;
                pn.classList.remove('on');
                renderPanel();
              }, 1800);
            } else if (res && res.status === 'already_exists') {
              dlBtn.disabled = false;
              if (btnSpan) btnSpan.textContent = originalText;
              showToast('Already in download queue');
            } else {
              dlBtn.disabled = false;
              if (btnSpan) btnSpan.textContent = originalText;
              const errMsg = res?.message || 'Download failed. Check connection to TORI Desktop.';
              console.warn('[TORI] Download failed', { correlationId, error: errMsg, code: res?.code });
              showToast(errMsg, true);
            }
          });
        });
      }
    }

    function triggerDirectDownload(vid) {
      const { videoFormats, audioFormats, hasAnyCandidates } = getAvailableFormats();
      if (!hasAnyCandidates) {
        showToast('No downloadable media stream detected on this page', true);
        return;
      }
      const list = settings.kind === 'Audio only' && audioFormats.length > 0 ? audioFormats : videoFormats;
      const target = list[0];
      if (!target || (!target.url && !target.format_id)) {
        showToast('No downloadable stream available', true);
        return;
      }

      const correlationId = 'tori_dir_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
      const isSocialPlatform = isManagedPlatform(window.location.hostname);
      const isTransientCdn = isTransientCdnUrl(target.url);
      const shouldUseManaged = target.format_id || target.isManaged || isSocialPlatform || isTransientCdn;

      const pageThumb = target.thumbnail_url || (resolvedMeta && resolvedMeta.thumbnail_url) || currentMediaIdentity?.thumbnailUrl || extractPageThumbnail(videoEl) || null;
      const reqPayload = shouldUseManaged
        ? {
            action: 'START_MEDIA_DOWNLOAD',
            url: (resolvedMeta && resolvedMeta.source_url) ? resolvedMeta.source_url : window.location.href,
            format_id: target.format_id || 'best',
            filename: target.filename,
            priority: 'high',
            correlation_id: correlationId,
            page_url: window.location.href,
            thumbnail_url: pageThumb,
            user_agent: navigator.userAgent,
          }
        : {
            action: 'START_DOWNLOAD',
            url: target.url,
            filename: target.filename,
            priority: 'high',
            correlation_id: correlationId,
            page_url: window.location.href,
            thumbnail_url: pageThumb,
            user_agent: navigator.userAgent,
          };

      chrome.runtime.sendMessage(reqPayload, (res) => {
        if (res && res.status === 'ok' && res.job_id) {
          showToast(`Download queued in Tori (${res.filename || target.filename})`);
        } else if (res && res.status === 'already_exists') {
          showToast('Already downloading in Tori');
        } else {
          showToast(res?.message || 'Download failed', true);
        }
      });
    }

    // Dynamic state updates when media metadata loads or changes
    // Genuine video replacement/emptied event
    videoEl.addEventListener('emptied', () => handleVideoNavigation('video-emptied'));

    // Bounded retry helper for dynamic asynchronous video loading
    let asyncRetryAttempts = 0;
    const MAX_ASYNC_RETRIES = 3;
    let asyncRetryTimer = null;

    const handleDynamicMediaActivity = () => {
      chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA' }, (res) => {
        if (res?.media && Array.isArray(res.media) && res.media.length > 0) {
          tabMediaCandidates = res.media;
        }
        const domC = extractDomMediaCandidates(videoEl);
        const { hasAnyCandidates } = getAvailableFormats();
        if (hasAnyCandidates) {
          if (resolveError) resolveError = null;
          updatePillTag();
          renderPanel();
          return;
        }
        if (!resolvedMeta && !isResolving && asyncRetryAttempts < MAX_ASYNC_RETRIES) {
          asyncRetryAttempts++;
          if (asyncRetryTimer) clearTimeout(asyncRetryTimer);
          asyncRetryTimer = setTimeout(() => {
            if (resolvedMeta || isResolving) return;
            const updatedDom = extractDomMediaCandidates(videoEl);
            if (updatedDom.length > 0 || (tabMediaCandidates && tabMediaCandidates.length > 0)) {
              if (resolveError) resolveError = null;
              triggerResolution(false);
            }
          }, asyncRetryAttempts * 600);
        }
      });
    };

    videoEl.addEventListener('canplay', handleDynamicMediaActivity);
    videoEl.addEventListener('play', handleDynamicMediaActivity);
    videoEl.addEventListener('playing', handleDynamicMediaActivity);
    videoEl.addEventListener('loadedmetadata', handleDynamicMediaActivity);
    videoEl.addEventListener('loadeddata', handleDynamicMediaActivity);

    // Listen for candidate discoveries recorded by background webRequest interceptor
    const onRuntimeCandidateMessage = (msg) => {
      if (msg && msg.action === 'MEDIA_CANDIDATE_RECORDED' && msg.candidate) {
        const cand = msg.candidate;
        if (cand && cand.url && !tabMediaCandidates.some((c) => c.url === cand.url)) {
          tabMediaCandidates.push(cand);
          if (!resolvedMeta) {
            if (resolveError) resolveError = null;
            updatePillTag();
            renderPanel();
          } else {
            updatePillTag();
          }
        }
      }
    };
    chrome.runtime.onMessage.addListener(onRuntimeCandidateMessage);

    // Record DOM media candidates
    recordDomMedia(videoEl);

    // Initial render and proactive platform resolution
    renderPanel();
    updatePillTag();

    if (isSupportedPlatform(window.location.href)) {
      triggerResolution(false);
    }
  }

  // Intercept history.pushState and history.replaceState for SPA frameworks
  const _origPushState = history.pushState;
  history.pushState = function () {
    const ret = _origPushState.apply(this, arguments);
    notifyAllOverlays('spa-pushstate');
    return ret;
  };

  const _origReplaceState = history.replaceState;
  history.replaceState = function () {
    const ret = _origReplaceState.apply(this, arguments);
    notifyAllOverlays('spa-replacestate');
    return ret;
  };

  function notifyAllOverlays(reason) {
    document.querySelectorAll('.tori-mp').forEach((mp) => {
      if (typeof mp.__toriHandleNav === 'function') {
        mp.__toriHandleNav(reason);
      }
    });
  }

  window.addEventListener('popstate', () => notifyAllOverlays('popstate'));
  document.addEventListener('yt-navigate-finish', () => notifyAllOverlays('yt-navigate-finish'));
  document.addEventListener('yt-page-data-updated', () => notifyAllOverlays('yt-page-data-updated'));

  // Watchdog URL polling every 600ms for client-side routing on arbitrary SPAs
  let lastCheckedUrl = window.location.href;
  setInterval(() => {
    if (window.location.href !== lastCheckedUrl) {
      lastCheckedUrl = window.location.href;
      notifyAllOverlays('url-watchdog');
    }
  }, 600);

  // Runtime message listener for background notifications and active media queries from extension popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'MEDIA_NAVIGATED') {
      notifyAllOverlays('background-navigated');
      sendResponse({ ok: true });
      return true;
    }

    if (msg.action === 'TRIGGER_RESOLVE_MEDIA') {
      const activeMp = document.querySelector('.tori-mp');
      if (activeMp && typeof activeMp.__toriTriggerResolution === 'function') {
        activeMp.__toriTriggerResolution(true);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'No active overlay' });
      }
      return true;
    }

    if (msg.action === 'GET_ACTIVE_MEDIA_INFO') {
      const activeMp = document.querySelector('.tori-mp');
      if (activeMp && typeof activeMp.__toriGetMediaInfo === 'function') {
        sendResponse({ ok: true, ...activeMp.__toriGetMediaInfo() });
      } else {
        const vid = document.querySelector('video');
        const ident = extractMediaIdentity(null, vid);
        sendResponse({
          ok: true,
          url: ident.canonicalUrl || window.location.href,
          identity: ident,
          title: vid ? getMediaTitle(vid, ident.videoId) : cleanMediaTitle(document.title, ident.videoId),
          isResolving: false,
          resolveError: null,
          resolvedMeta: null,
          hasAnyCandidates: false,
        });
      }
      return true;
    }
  });

  // Global outside-click listener to close any open panels cleanly
  document.addEventListener('click', (e) => {
    document.querySelectorAll('.tori-mp').forEach((mp) => {
      if (!mp.contains(e.target)) {
        const pn = mp.querySelector('.tori-pn');
        if (pn && pn.classList.contains('on')) {
          pn.classList.remove('on');
        }
      }
    });
  });

  // Recursively collect all videos including inside open shadowRoot DOM trees
  function getAllVideos(root = document) {
    const list = [];
    if (!root) return list;
    try {
      if (typeof root.querySelectorAll === 'function') {
        const vids = root.querySelectorAll('video');
        for (let i = 0; i < vids.length; i++) {
          list.push(vids[i]);
        }
        const allElements = root.querySelectorAll('*');
        for (let i = 0; i < allElements.length; i++) {
          const el = allElements[i];
          if (el.shadowRoot) {
            const shadowVids = getAllVideos(el.shadowRoot);
            for (let j = 0; j < shadowVids.length; j++) {
              list.push(shadowVids[j]);
            }
          }
        }
      }
    } catch (_) {}
    return list;
  }

  // Scan document for media elements
  function scanForMedia() {
    if (isSiteExcluded()) return;

    // Clean up any overlays whose associated video is disconnected from DOM
    document.querySelectorAll('.tori-mp').forEach((mp) => {
      if (mp.__toriVideoEl && !document.body.contains(mp.__toriVideoEl)) {
        mp.remove();
      }
    });

    const videos = getAllVideos(document);
    videos.forEach((video) => {
      recordDomMedia(video);
      attachVideoOverlay(video);
    });
  }

  // DOM MutationObserver for dynamically added videos
  const observer = new MutationObserver(() => {
    if (!isSiteExcluded() && settings.pill) {
      scanForMedia();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Initial execution
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      document.documentElement.dataset.toriExtensionUrl = chrome.runtime.getURL('');
      window.addEventListener('__TORI_DISPATCH__', (e) => {
        const { action, payload, id } = e.detail || {};
        chrome.runtime.sendMessage({ action, ...payload }, (res) => {
          window.dispatchEvent(new CustomEvent('__TORI_RESPONSE__' + id, { detail: res }));
        });
      });
    }
  } catch (_) {}
  syncSettings();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanForMedia);
  } else {
    scanForMedia();
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
