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

  // Format bytes helper
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatDuration(sec) {
    if (!sec || isNaN(sec) || !isFinite(sec)) return '';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // Extract platform media identity to detect client-side SPA navigation
  function extractMediaIdentity(url, videoEl = null) {
    const rawUrl = url || window.location.href;
    const normalized = normalizePlatformUrl(rawUrl);

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
    if (videoEl.hasAttribute('data-tori-attached')) return;
    if (isSiteExcluded() || !settings.pill) return;

    // Must have reasonable dimensions
    const rect = videoEl.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 90) return;

    // Anchor to player container if available to avoid stacking context clipping
    const anchor = videoEl.closest('.html5-video-player') ||
                   videoEl.closest('.video-stream-container') ||
                   videoEl.closest('.player-container') ||
                   videoEl.parentElement;
    if (!anchor) return;

    // Prevent duplicate overlays in this anchor
    if (anchor.querySelector(':scope > .tori-mp')) return;

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
    pill.className = 'tori-pill';
    pill.type = 'button';
    pill.innerHTML = `
      <span class="tori-logo">
        <svg viewBox="0 0 24 24"><path d="${P.dl}"/></svg>
      </span>
      <span>Download video</span>
      <em class="tori-pill-tag">Media</em>
    `;

    // Create format panel
    const pn = document.createElement('div');
    pn.className = 'tori-pn';

    mp.appendChild(pill);
    mp.appendChild(pn);
    anchor.appendChild(mp);

    // Stop propagation on clicks inside the panel so player does not intercept
    pn.addEventListener('click', (e) => {
      e.stopPropagation();
    });

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

      if (resolveTimeoutTimer) clearTimeout(resolveTimeoutTimer);
      // Hard bounded 20s timeout ensures UI ALWAYS transitions to a terminal state
      resolveTimeoutTimer = setTimeout(() => {
        if (isResolving && thisGen === currentGeneration) {
          console.warn(`[TORI Content] Resolution timed out for ${targetUrl} (gen ${thisGen})`);
          isResolving = false;
          resolveError = 'Media resolution timed out. Remote platform took longer than 20s to respond.';
          updatePillTag();
          renderPanel();
        }
      }, 20000);

      chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA' }, (mRes) => {
        if (thisGen !== currentGeneration) return;
        tabMediaCandidates = mRes?.media || [];
      });

      chrome.runtime.sendMessage(
        { action: 'RESOLVE_MEDIA', url: targetUrl, generation: thisGen, correlation_id: reqId },
        (rRes) => {
          if (resolveTimeoutTimer) clearTimeout(resolveTimeoutTimer);
          if (thisGen !== currentGeneration) {
            console.log(`[TORI] Dropping stale resolution response for gen ${thisGen}, current is ${currentGeneration}`);
            return;
          }
          isResolving = false;
          if (rRes && rRes.status === 'ok' && rRes.metadata) {
            resolvedMeta = rRes.metadata;
            resolveError = null;
          } else {
            resolveError = rRes?.message || 'Protected, restricted, or unsupported stream.';
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
          let sizeStr = '';
          if (f.filesize_type === 'exact' && f.filesize) {
            sizeStr = formatBytes(f.filesize);
          } else if (f.filesize_type === 'estimated' && f.filesize_approx) {
            sizeStr = `~${formatBytes(f.filesize_approx)}`;
          } else {
            sizeStr = 'Size unknown';
          }

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
            url: f.direct_stream_url || resolvedMeta.source_url,
            format_id: f.format_id,
            filename: sanitizeFilename(title, (f.container || (isAudio ? 'mp3' : 'mp4')).toLowerCase()),
            isAudio,
            isManaged: f.download_capability === 'managed_extractor' || !!f.format_id,
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

      // 3. Tab candidates from background webRequest interception
      tabMediaCandidates.forEach((tc) => {
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

      if (isResolving) {
        tagEl.textContent = 'Resolving…';
        tagEl.style.color = 'var(--tori-blue)';
        tagEl.style.background = 'rgba(79, 70, 229, 0.12)';
      } else if (hasAnyCandidates) {
        const top = videoFormats[0] || audioFormats[0];
        tagEl.textContent = top.q || top.tg || 'Media';
        tagEl.style.color = '';
        tagEl.style.background = '';
      } else if (resolveError) {
        tagEl.textContent = 'Unavailable';
        tagEl.style.color = 'var(--tori-bad)';
        tagEl.style.background = 'rgba(229, 72, 77, 0.12)';
      } else {
        tagEl.textContent = 'Media';
        tagEl.style.color = '';
        tagEl.style.background = '';
      }
    }

    // Pill click handler
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();

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
      } else {
        pn.classList.add('on');
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
          desc: 'Media resolution timed out. The server or platform took longer than 35s to respond.',
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
        lower.includes('encrypted') ||
        lower.includes('plex.tv')
      ) {
        return {
          title: 'Protected Streaming Content (DRM)',
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
        lower.includes('sign in')
      ) {
        return {
          title: 'Platform Login Required',
          desc: e,
          hint: 'This content requires account authentication on the host platform.',
          color: '#f59e0b',
        };
      }
      if (e) {
        return {
          title: 'No Downloadable Stream Detected',
          desc: e,
          hint: 'No direct media, HLS/DASH manifest, or extractor format was found.',
          color: '#8e8e93',
        };
      }
      return {
        title: 'No Media Stream Detected',
        desc: 'No direct media stream or manifest detected on this player.',
        hint: 'Use the extension popup to resolve page media.',
        color: '#8e8e93',
      };
    }

    function renderPanel() {
      const { title, subInfo, videoFormats, audioFormats, hasAnyCandidates } = getAvailableFormats();
      const currentList = activeTab === 'Video' ? videoFormats : audioFormats;
      if (selectedIdx >= currentList.length) selectedIdx = 0;
      const currentItem = currentList[selectedIdx];

      let listHtml = '';
      if (isResolving) {
        listHtml = `
          <div class="tori-empty-box" style="padding:28px 16px">
            <div class="tori-spin"></div>
            <b>Resolving media formats…</b>
            <p>Querying TORI Universal Media Resolver for genuine resolutions and streams</p>
          </div>`;
      } else if (hasAnyCandidates) {
        if (currentList.length > 0) {
          listHtml = currentList
            .map(
              (f, i) => `
            <div class="tori-fr ${i === selectedIdx ? 'on' : ''} ${f.isAudio ? 'audio' : ''}" data-idx="${i}">
              <span class="tori-rd"></span>
              <span class="tori-q" title="${escapeHtml(f.q)}">${escapeHtml(f.q)}</span>
              <span class="tori-tg">${escapeHtml(f.tg)}</span>
              ${f.hd ? `<span class="tori-tg hd">${escapeHtml(f.hd)}</span>` : ''}
              <span class="tori-cd" title="${escapeHtml(f.cd)}">${escapeHtml(f.cd)}</span>
              <span class="tori-sz">${escapeHtml(f.sz)}</span>
            </div>`
            )
            .join('');
        } else {
          listHtml = `
            <div class="tori-empty-box">
              <p>No separate ${escapeHtml(activeTab.toLowerCase())} stream detected for this media.</p>
            </div>`;
        }
      } else {
        const notice = getErrorNotice(resolveError);
        listHtml = `
          <div class="tori-empty-box">
            <i class="tori-ft" style="--c:${notice.color};margin-bottom:4px">
              <svg viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
            </i>
            <b>${escapeHtml(notice.title)}</b>
            <p>${escapeHtml(notice.desc)}</p>
            <span style="font-size:10px;color:var(--tori-mut);margin-bottom:6px">${escapeHtml(notice.hint)}</span>
            <button class="tori-retry-btn" data-act="retry" type="button">
              <svg viewBox="0 0 24 24" style="width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:2.2"><path d="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>
              <span>Retry resolution</span>
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
        ? 'Sent to Tori'
        : `Download · ${currentItem.sz}`;

      pn.innerHTML = `
        <div class="tori-ph">
          <i class="tori-ft" style="--c:${hasAnyCandidates ? '#ff453a' : '#8e8e93'}">
            <svg viewBox="0 0 24 24"><path d="${P.play}"/></svg>
          </i>
          <div style="min-width:0">
            <b>${escapeHtml(title)}</b>
            <span>${escapeHtml(subInfo)}</span>
          </div>
          <button class="tori-x" data-act="close" title="Close">×</button>
        </div>

        ${
          window.location.href.includes('list=')
            ? `
        <div style="margin: 6px 14px 2px; padding: 6px 10px; background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3); border-radius: 6px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
          <span style="font-size: 11px; color: #e0e7ff; font-weight: 500;">⚡ Playlist available</span>
          <button type="button" data-act="open-playlist" style="font-size: 11px; padding: 3px 8px; background: #6366f1; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600;">Download Playlist</button>
        </div>`
            : ''
        }

        <div class="tori-seg">
          <button class="${activeTab === 'Video' ? 'on' : ''}" data-tab="Video">Video</button>
          <button class="${activeTab === 'Audio' ? 'on' : ''}" data-tab="Audio">Audio only</button>
        </div>

        <div class="tori-fl">
          ${listHtml}
        </div>

        <div class="tori-pf">
          <div class="tori-sv">
            <svg viewBox="0 0 24 24"><path d="${P.fd}"/></svg>
            <span>Save to <b>Downloads\\Tori\\${escapeHtml(activeTab)}</b></span>
          </div>
          <div class="tori-ac">
            <button class="tori-btn sq ${canDownload ? '' : 'dis'}" ${canDownload ? '' : 'disabled'} data-act="copy" title="${canDownload ? 'Copy stream URL' : 'No stream URL available'}">
              <svg viewBox="0 0 24 24"><path d="${P.cp}"/></svg>
            </button>
            <button class="tori-btn f def ${canDownload ? '' : 'dis'} ${isDownloaded ? 'ok' : ''}" ${canDownload ? '' : 'disabled'} data-act="download">
              <svg viewBox="0 0 24 24"><path d="${isDownloaded ? P.ck : P.dl}"/></svg>
              <span>${escapeHtml(dlBtnText)}</span>
            </button>
          </div>
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

          const reqPayload = shouldUseManaged
            ? {
                action: 'START_MEDIA_DOWNLOAD',
                url: (resolvedMeta && resolvedMeta.source_url) ? resolvedMeta.source_url : window.location.href,
                format_id: target.format_id || 'best',
                filename: target.filename,
                priority: 'high',
                correlation_id: correlationId,
                page_url: window.location.href,
              }
            : {
                action: 'START_DOWNLOAD',
                url: target.url,
                filename: target.filename,
                priority: 'high',
                correlation_id: correlationId,
                page_url: window.location.href,
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

      const reqPayload = shouldUseManaged
        ? {
            action: 'START_MEDIA_DOWNLOAD',
            url: (resolvedMeta && resolvedMeta.source_url) ? resolvedMeta.source_url : window.location.href,
            format_id: target.format_id || 'best',
            filename: target.filename,
            priority: 'high',
            correlation_id: correlationId,
            page_url: window.location.href,
          }
        : {
            action: 'START_DOWNLOAD',
            url: target.url,
            filename: target.filename,
            priority: 'high',
            correlation_id: correlationId,
            page_url: window.location.href,
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
    videoEl.addEventListener('canplay', () => updatePillTag());
    videoEl.addEventListener('play', () => {
      chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA' }, (res) => {
        tabMediaCandidates = res?.media || [];
        updatePillTag();
      });
    });

    // Check DOM source attributes and inform background worker
    const directSrc = videoEl.currentSrc || videoEl.src;
    if (directSrc && !directSrc.startsWith('blob:') && !directSrc.startsWith('data:')) {
      chrome.runtime.sendMessage({
        action: 'RECORD_MEDIA_FROM_DOM',
        candidate: {
          url: directSrc,
          filename: sanitizeFilename(getMediaTitle(videoEl), 'mp4'),
          size_bytes: null,
          content_type: 'video/mp4',
        },
      });
    }

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

  // Scan document for media elements
  function scanForMedia() {
    if (isSiteExcluded()) return;

    // Clean up any overlays whose associated video is disconnected from DOM
    document.querySelectorAll('.tori-mp').forEach((mp) => {
      if (mp.__toriVideoEl && !document.body.contains(mp.__toriVideoEl)) {
        mp.remove();
      }
    });

    const videos = document.querySelectorAll('video');
    videos.forEach((video) => {
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
