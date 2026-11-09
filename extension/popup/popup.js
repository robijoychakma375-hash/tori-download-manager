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
      const v = u.searchParams.get('v');
      if (v && /^\d+$/.test(v)) {
        return {
          url: `https://www.facebook.com/watch/?v=${v}`,
          videoId: v,
          isSpecific: true,
          platform: 'facebook',
        };
      }

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

      const reelMatch = path.match(/\/(?:reel|reels)\/([^/?#]+)/i);
      if (reelMatch && reelMatch[1] && reelMatch[1] !== 'audio') {
        return {
          url: `https://www.facebook.com/reel/${reelMatch[1]}`,
          videoId: reelMatch[1],
          isSpecific: true,
          platform: 'facebook',
        };
      }

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

      const videoMatch = path.match(/\/(?:videos|watch|p)\/([^/?#]+)/i);
      if (videoMatch && videoMatch[1]) {
        return {
          url: `https://www.facebook.com/watch/?v=${videoMatch[1]}`,
          videoId: videoMatch[1],
          isSpecific: true,
          platform: 'facebook',
        };
      }

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

function cleanMediaTitle(rawTitle, fallbackId = 'media') {
  if (!rawTitle) return fallbackId;
  let t = String(rawTitle).trim();
  t = t.replace(/^\(\d+\)\s*/, '');
  t = t.replace(/\s*[-—|•]\s*(?:YouTube|Vimeo|Facebook|Instagram|TikTok)$/i, '');
  if (!t || t.toLowerCase() === 'facebook' || t.toLowerCase() === 'home') {
    return fallbackId ? `Facebook Reel · ${fallbackId}` : 'Facebook Video';
  }
  return t;
}

/**
 * TORI Download Manager — Extension Popup Controller
 * Implements Design Source A with real Native Messaging engine integration.
 */

const P = {
  dl: 'M12 4v10M8 10l4 4 4-4M5 19h14',
  cp: 'M9 9h10v11H9zM5 15V4h10',
  set: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 7a2 2 0 100 .01M8 17a2 2 0 100 .01',
  op: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  ck: 'M5 12l5 5 9-10',
};

const G = {
  Video: ['#ff453a', 'M9 6.5v11l9-5.5z'],
  Music: ['#ff375f', 'M9 18V6l10-2v12M7 20a2 2 0 100-4 2 2 0 000 4zM17 18a2 2 0 100-4 2 2 0 000 4z'],
  Compressed: ['#bf5af2', 'M12 3v10M10 6h4M10 9h4M8 13h8v6H8z'],
  Segment: ['#ff9f0a', 'M4 6h16M4 12h16M4 18h16'],
  Other: ['#8e8e93', 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z'],
};

function chip(k) {
  const meta = G[k] || G.Other;
  return `<i class="ft" style="--c:${meta[0]}"><svg viewBox="0 0 24 24"><path d="${meta[1]}"/></svg></i>`;
}

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

function showToast(text, isError = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.innerHTML = `<i class="ft" style="--c:${isError ? '#e5484d' : '#30c75e'}"><svg viewBox="0 0 24 24"><path d="${P.ck}"/></svg></i><span>${text}</span>`;
  el.classList.add('on');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.remove('on'), 2000);
}

document.addEventListener('DOMContentLoaded', async () => {
  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');
  const captureToggle = document.getElementById('captureToggle');
  const mediaCountHeader = document.getElementById('mediaCountHeader');
  const mediaList = document.getElementById('mediaList');
  const recentList = document.getElementById('recentList');
  const openToriBtn = document.getElementById('openToriBtn');
  const optionsBtn = document.getElementById('optionsBtn');

  // 1. Sync theme from options/storage
  chrome.storage.local.get(['tori_theme', 'tori_settings'], (res) => {
    const theme = res.tori_theme || res.tori_settings?.theme || 'system';
    const isDark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';

    if (res.tori_settings && typeof res.tori_settings.cap === 'boolean') {
      captureToggle.checked = res.tori_settings.cap;
    }
  });

  // 2. Capture toggle handler
  captureToggle.addEventListener('change', () => {
    chrome.storage.local.get(['tori_settings'], (res) => {
      const settings = res.tori_settings || {};
      settings.cap = captureToggle.checked;
      chrome.storage.local.set({ tori_settings: settings });
      showToast(captureToggle.checked ? 'Capture enabled' : 'Capture disabled');
    });
  });

  // 3. Open Tori button handler
  openToriBtn.addEventListener('click', () => {
    showToast('Opening Tori…');
    chrome.runtime.sendMessage({ action: 'SHOW_DESKTOP' }, () => {
      window.close();
    });
  });

  // 4. Options button handler
  optionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // 5. Check desktop connection status
  function setStatus(state, port, latency) {
    if (state === 'connected') {
      statusPill.className = 'st';
      statusText.textContent = `Connected · 127.0.0.1:${port || 6800}`;
    } else if (state === 'unpaired') {
      statusPill.className = 'st wait';
      statusText.textContent = 'Pairing Required (Click to Pair)';
    } else if (state === 'connecting') {
      statusPill.className = 'st conn';
      statusText.textContent = 'Connecting…';
    } else {
      statusPill.className = 'st bad';
      statusText.textContent = 'Disconnected';
    }
  }

  function updateConnectionStatus() {
    chrome.runtime.sendMessage({ action: 'PING_DESKTOP' }, (res) => {
      if (
        chrome.runtime.lastError ||
        !res ||
        res.status === 'disconnected' ||
        res.status === 'error' ||
        res.status === 'none'
      ) {
        setStatus('disconnected', res?.port);
      } else if (res.status === 'unpaired') {
        setStatus('unpaired', res.port);
      } else if (res.status === 'ok' && res.authenticated) {
        setStatus('connected', res.port, res.latency);
      } else {
        setStatus('disconnected', res?.port);
      }
    });
  }

  // Set initial Connecting status immediately upon popup open
  setStatus('connecting');
  updateConnectionStatus();

  // Bounded status polling while popup is open
  const statusPollTimer = setInterval(updateConnectionStatus, 3000);
  window.addEventListener('unload', () => clearInterval(statusPollTimer));

  statusPill.addEventListener('click', () => {
    if (statusPill.classList.contains('wait') || statusPill.classList.contains('bad')) {
      setStatus('connecting');
      showToast('Connecting / Pairing with Tori…');
      chrome.runtime.sendMessage({ action: 'INITIATE_PAIRING' }, (res) => {
        if (res && res.ok) {
          showToast('Paired with Tori!');
          updateConnectionStatus();
        } else {
          showToast(res?.error || 'Could not pair. Make sure Tori is running.', true);
          updateConnectionStatus();
        }
      });
    }
  });

  // 6. Query media on current tab with dynamic per-tab identity support
  let resolutionPollTimer = null;
  let resolutionPollCount = 0;

  function stopResolutionPolling() {
    if (resolutionPollTimer) {
      clearInterval(resolutionPollTimer);
      resolutionPollTimer = null;
    }
  }

  function startResolutionPolling(tab) {
    if (resolutionPollTimer) return;
    resolutionPollCount = 0;
    resolutionPollTimer = setInterval(() => {
      resolutionPollCount++;
      if (resolutionPollCount > 20) {
        stopResolutionPolling();
        renderResolutionError('Resolution timed out after 20 seconds. Platform took too long to respond.', tab);
        return;
      }
      chrome.tabs.sendMessage(tab.id, { action: 'GET_ACTIVE_MEDIA_INFO' }, (info) => {
        if (!chrome.runtime.lastError && info && info.ok) {
          if (!info.isResolving) {
            stopResolutionPolling();
            if (info.resolvedMeta && Array.isArray(info.resolvedMeta.formats) && info.resolvedMeta.formats.length > 0) {
              renderResolvedFormats(info.resolvedMeta, tab);
            } else if (info.resolveError) {
              renderResolutionError(info.resolveError, tab);
            } else {
              loadActiveTabMedia();
            }
          }
        }
      });
    }, 1000);
  }

  function getDisplayCandidates(items) {
    if (!Array.isArray(items) || items.length === 0) return [];
    // Strictly exclude partial transport fragments (.m4s, .cmfv, .cmfa, numbered .ts chunks)
    // from being displayed as independent downloadable full videos
    return items.filter((c) => !c.is_segment && c.type !== 'segment');
  }

  function renderResolutionError(errMsg, tab) {
    stopResolutionPolling();
    // Check if background webRequest intercepted direct stream candidates for this tab
    chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA', tabId: tab.id }, (res) => {
      const rawItems = res?.media || [];
      const items = getDisplayCandidates(rawItems);
      if (items.length > 0) {
        mediaCountHeader.textContent = `Captured Streams · ${items.length}`;
        renderDirectItems(items, tab);
        return;
      }

      mediaCountHeader.textContent = 'Media Unavailable';
      mediaList.innerHTML = `
        <div class="empty-state" style="padding:16px 12px;text-align:center">
          <div style="font-weight:600;margin-bottom:4px;color:#e5484d">Resolution Failed</div>
          <div style="font-size:11px;color:var(--mut);line-height:1.4;margin-bottom:12px">${escapeHtml(errMsg)}</div>
          <button class="btn mb def" id="btnRetryResolution" style="padding:6px 16px">
            <svg viewBox="0 0 24 24" style="width:14px;height:14px;margin-right:6px"><path d="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>
            Retry Resolution
          </button>
        </div>`;
      const btnRetry = document.getElementById('btnRetryResolution');
      if (btnRetry) {
        btnRetry.addEventListener('click', () => {
          triggerManualResolve(tab);
        });
      }
    });
  }

  function triggerManualResolve(tab, forceRefresh = false) {
    stopResolutionPolling();
    mediaCountHeader.textContent = forceRefresh ? 'Refreshing media formats…' : 'Resolving media on page…';
    mediaList.innerHTML = `
      <div class="empty-state" style="padding:20px 12px;text-align:center">
        <div class="tori-spin"></div>
        <div style="font-weight:600;margin-bottom:4px">${forceRefresh ? 'Refreshing media formats…' : 'Resolving media formats…'}</div>
        <div style="font-size:11px;color:var(--mut);line-height:1.4">Extracting genuine quality streams and formats</div>
      </div>`;

    // Attempt to notify content script
    chrome.tabs.sendMessage(tab.id, { action: 'TRIGGER_RESOLVE_MEDIA', force_refresh: forceRefresh }, () => {
      if (chrome.runtime.lastError) {}
    });

    const isPlatform = isManagedPlatform(tab.url);
    const timeoutMs = isPlatform ? 25000 : 13000;

    // Hard safety timeout for popup manual resolve
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      renderResolutionError(`Media resolution timed out (${Math.round(timeoutMs / 1000)}s). Remote host took too long to respond.`, tab);
    }, timeoutMs);

    const norm = normalizePlatformUrl(tab.url);
    const targetUrl = norm.url || tab.url;

    chrome.runtime.sendMessage({ action: 'RESOLVE_MEDIA', url: targetUrl, tabId: tab.id, force_refresh: forceRefresh }, (rRes) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (rRes && rRes.status === 'ok' && rRes.metadata && Array.isArray(rRes.metadata.formats) && rRes.metadata.formats.length > 0) {
        renderResolvedFormats(rRes.metadata, tab);
      } else {
        const errMsg = rRes?.message || 'Media resolution failed. Remote stream unavailable or restricted.';
        renderResolutionError(errMsg, tab);
      }
    });
  }

  async function loadActiveTabMedia() {
    try {
      let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return;

      if (tab.url && (tab.url.startsWith('moz-extension://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge-extension://'))) {
        const contentTabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
        if (contentTabs && contentTabs.length > 0) {
          tab = contentTabs[contentTabs.length - 1];
        }
      }

      if (tab.url && tab.url.toLowerCase().includes('plex.tv')) {
        mediaCountHeader.textContent = 'Protected Streaming Content';
        mediaList.innerHTML = `
          <div class="empty-state" style="padding:16px 12px;text-align:center">
            <div style="font-weight:600;margin-bottom:4px;color:#e5484d">DRM-Protected Content</div>
            <div style="font-size:11px;color:var(--mut);line-height:1.4">watch.plex.tv content is DRM-protected and not licensed for offline download.</div>
            <div style="font-size:11px;color:var(--mut);margin-top:6px">TORI respects licensing boundaries and does not bypass DRM.</div>
          </div>`;
        return;
      }

      // 1. Try querying active media info from content script
      chrome.tabs.sendMessage(tab.id, { action: 'GET_ACTIVE_MEDIA_INFO' }, (info) => {
        if (!chrome.runtime.lastError && info && info.ok) {
          if (info.isResolving && !info.hasAnyCandidates) {
            mediaCountHeader.textContent = 'Resolving media on page…';
            mediaList.innerHTML = `
              <div class="empty-state" style="padding:20px 12px;text-align:center">
                <div class="tori-spin"></div>
                <div style="font-weight:600;margin-bottom:4px">Resolving media on page…</div>
                <div style="font-size:11px;color:var(--mut);line-height:1.4">Extracting genuine quality streams and formats</div>
              </div>`;
            startResolutionPolling(tab);
            return;
          }

          if (info.resolveError) {
            renderResolutionError(info.resolveError, tab);
            return;
          }

          if (info.resolvedMeta && Array.isArray(info.resolvedMeta.formats) && info.resolvedMeta.formats.length > 0) {
            stopResolutionPolling();
            renderResolvedFormats(info.resolvedMeta, tab);
            return;
          }
        }

        // 2. Fallback: check tab media cache from background
        chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA', tabId: tab.id }, (res) => {
          const rawItems = res?.media || [];
          const items = getDisplayCandidates(rawItems);
          mediaCountHeader.textContent = `Media on this page · ${items.length}`;

          if (items.length === 0) {
            const isPlatform = isManagedPlatform(tab.url);
            mediaList.innerHTML = `
              <div class="empty-state" style="padding:16px 12px;text-align:center">
                <div style="font-weight:600;margin-bottom:4px">${isPlatform ? 'Streaming Media Detected' : 'No direct media stream detected'}</div>
                <div style="font-size:11px;color:var(--mut);line-height:1.4">${isPlatform ? 'Click below to extract high-definition formats using TORI Universal Resolver.' : 'Streaming platforms (YouTube, Vimeo, Facebook, etc.) require media resolution.'}</div>
                <button class="btn mb def" id="btnResolveTabMedia" style="margin-top:12px;padding:6px 16px">
                  <svg viewBox="0 0 24 24" style="width:14px;height:14px;margin-right:6px"><path d="M12 4v10M8 10l4 4 4-4M5 19h14"/></svg>
                  Resolve Media on Page
                </button>
              </div>`;

            const btnResolve = document.getElementById('btnResolveTabMedia');
            if (btnResolve) {
              btnResolve.addEventListener('click', () => {
                triggerManualResolve(tab);
              });
            }
          } else {
            renderDirectItems(items, tab);
          }
        });
      });
    } catch (err) {
      console.warn('Failed to query current tab media:', err);
    }
  }

  function renderResolvedFormats(meta, tab) {
    const rawTitle = meta.title || '';
    const fallbackId = meta.id || (tab.url.match(/\/(?:reel|reels)\/([^/?#]+)/i) || [])[1] || 'Facebook Reel';
    const displayTitle = cleanMediaTitle(rawTitle, fallbackId);

    const isCached = meta.is_cached === true;
    mediaCountHeader.innerHTML = `Resolved Formats${isCached ? ' <span style="font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(255,255,255,0.08);color:var(--mut, #888);font-weight:500">Cached</span> <a href="#" id="lnkRefreshFormats" style="font-size:10px;color:var(--acc, #3e98ff);text-decoration:none;margin-left:6px">Refresh</a>' : ''} · ${meta.formats.length}`;
    showToast(isCached ? `Loaded ${meta.formats.length} formats from cache` : `Found ${meta.formats.length} formats`);

    const lnkRefresh = document.getElementById('lnkRefreshFormats');
    if (lnkRefresh) {
      lnkRefresh.addEventListener('click', (e) => {
        e.preventDefault();
        triggerManualResolve(tab, true);
      });
    }

    mediaList.innerHTML = meta.formats
      .map((fmt, idx) => {
        const isAudio = !fmt.has_video && fmt.has_audio;
        const cat = isAudio ? 'Music' : 'Video';
        const sizeText = formatFilesizeDisplay(fmt, meta.duration_seconds);
        const sub = `${(fmt.container || 'mp4').toUpperCase()} · ${sizeText}`;

        return `
        <div class="row">
          ${chip(cat)}
          <div class="t">
            <b>${escapeHtml(fmt.resolution_label || 'Media')}</b>
            <span class="s">${escapeHtml(displayTitle.substring(0, 36))} · ${escapeHtml(sub)}</span>
          </div>
          <button class="btn mb def" data-fidx="${idx}">Download</button>
        </div>`;
      })
      .join('');

    mediaList.querySelectorAll('button[data-fidx]').forEach((b) => {
      b.addEventListener('click', () => {
        const fidx = parseInt(b.dataset.fidx, 10);
        const selected = meta.formats[fidx];
        if (!selected) return;

        b.textContent = 'Sending…';
        b.disabled = true;
        const correlationId = 'tori_pop_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
        const safeFilename = `${displayTitle.replace(/[\\/:*?"<>|]/g, '') || 'media'}.${selected.container || 'mp4'}`;
        const directUrl = selected.direct_stream_url || null;
        const sourceUrl = directUrl || meta.source_url || tab.url;

        chrome.runtime.sendMessage(
          {
            action: 'START_MEDIA_DOWNLOAD',
            url: sourceUrl,
            direct_stream_url: directUrl,
            format_id: selected.format_id,
            filename: safeFilename,
            priority: 'high',
            correlation_id: correlationId,
            page_url: tab.url,
            thumbnail_url: meta.thumbnail_url || null,
            user_agent: navigator.userAgent,
          },
          (dlRes) => {
            b.disabled = false;
            if (dlRes && dlRes.status === 'ok' && dlRes.job_id) {
              b.textContent = 'Queued';
              b.classList.add('ok');
              showToast(`Queued in Tori (${dlRes.filename || 'media'})`);
              loadRecentDownloads();
            } else {
              b.textContent = 'Retry';
              showToast(dlRes?.message || 'Download failed', true);
            }
          }
        );
      });
    });
  }

  function renderDirectItems(items, tab) {
    mediaList.innerHTML = items
      .map((item, idx) => {
        const isAudio =
          item.type === 'audio' ||
          (item.content_type && item.content_type.startsWith('audio/'));
        const isSeg = item.is_segment || item.type === 'segment';
        const cat = isAudio ? 'Music' : (isSeg ? 'Segment' : 'Video');
        const sizeStr = item.size_bytes ? ` · ${formatBytes(item.size_bytes)}` : '';
        const formatStr = item.format || 'MP4';
        const sub = `${formatStr}${sizeStr}`;

        return `
        <div class="row">
          ${chip(cat)}
          <div class="t">
            <b>${escapeHtml(item.filename || 'media_video')}</b>
            <span class="s">${escapeHtml(sub)}</span>
          </div>
          <button class="btn mb def" data-idx="${idx}">Download</button>
        </div>`;
      })
      .join('');

    mediaList.querySelectorAll('button[data-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const idx = parseInt(btn.dataset.idx, 10);
        const target = items[idx];
        if (!target) return;

        btn.disabled = true;
        btn.textContent = 'Sending…';
        const currentUrl = (tab && tab.url) || window.location.href;
        // Direct media candidates must start immediately through native downloader
        const reqPayload = {
          action: 'START_DOWNLOAD',
          url: target.url,
          filename: target.filename,
          priority: 'high',
          page_url: currentUrl,
          thumbnail_url: target.thumbnail_url || null,
          user_agent: navigator.userAgent,
        };

        chrome.runtime.sendMessage(
          reqPayload,
          (dlRes) => {
            if (dlRes && dlRes.status === 'ok') {
              btn.textContent = 'Sent';
              btn.classList.add('ok');
              showToast('Sent to Tori');
              loadRecentDownloads();
            } else if (dlRes && dlRes.status === 'already_exists') {
              btn.textContent = 'Active';
              showToast('Already in download queue');
            } else {
              btn.disabled = false;
              btn.textContent = 'Retry';
              showToast(dlRes?.message || 'Download failed', true);
            }
          }
        );
      });
    });
  }

  loadActiveTabMedia();

  // Listen for navigation or media updates on active tab while popup remains open
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'MEDIA_NAVIGATED' || msg.action === 'TAB_MEDIA_UPDATED') {
      stopResolutionPolling();
      loadActiveTabMedia();
    } else if (msg.action === 'MEDIA_RESOLVED') {
      stopResolutionPolling();
      if (msg.metadata) {
        chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
          if (tab) renderResolvedFormats(msg.metadata, tab);
        });
      }
    } else if (msg.action === 'MEDIA_RESOLUTION_FAILED') {
      stopResolutionPolling();
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab) renderResolutionError(msg.message || 'Media resolution failed', tab);
      });
    }
  });

  // 7. Load recent downloads from persistent engine
  function loadRecentDownloads() {
    chrome.runtime.sendMessage({ action: 'GET_DOWNLOADS' }, (res) => {
      const jobs = res?.jobs || [];
      if (jobs.length === 0) {
        recentList.innerHTML = '<div class="empty-state">No recent downloads</div>';
        return;
      }

      // Show top 3 recent downloads
      const recent = jobs.slice(0, 3);
      recentList.innerHTML = recent
        .map((j) => {
          const total = j.total_bytes || 0;
          const downloaded = j.downloaded_bytes || 0;
          const percent =
            total > 0
              ? Math.min(100, Math.floor((downloaded / total) * 100))
              : j.state === 'completed'
              ? 100
              : 0;
          const isComplete = j.state === 'completed';
          const isPaused = j.state === 'paused';
          const isFailed = j.state === 'failed';

          let statusLabel = `${percent}%`;
          let barClass = '';
          if (isComplete) {
            statusLabel = 'Done';
            barClass = 'dn';
          } else if (isPaused) {
            statusLabel = 'Paused';
            barClass = 'pz';
          } else if (isFailed) {
            statusLabel = 'Failed';
            barClass = 'pz';
          }

          const cat = j.job_type === 'Torrent' ? 'Compressed' : 'Video';

          return `
          <div class="row">
            ${chip(cat)}
            <div class="t">
              <b>${escapeHtml(j.filename || 'download')}</b>
              <div class="bar"><i class="${barClass}" style="width:${percent}%"></i></div>
            </div>
            <span class="s" style="font-size:11px;font-weight:600;min-width:36px;text-align:right;color:${
              isComplete ? 'var(--green)' : isFailed ? 'var(--bad)' : 'var(--mut)'
            }">${statusLabel}</span>
          </div>`;
        })
        .join('');
    });
  }

  loadRecentDownloads();
  // Refresh recent downloads periodically while popup is open
  const pollTimer = setInterval(loadRecentDownloads, 2000);
  window.addEventListener('unload', () => {
    clearInterval(pollTimer);
    stopResolutionPolling();
  });
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
