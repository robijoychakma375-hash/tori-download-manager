/**
 * TORI Download Manager — Extension Popup Controller (Design 1)
 * Integrates Design 1 UI with real Native Messaging engine communication.
 */

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

const P = {
  dl: 'M12 4v11m0 0l-4-4m4 4l4-4M5 20h14',
  play: 'M9 6.5v11l9-5.5z',
  music: 'M9 18V6l10-2v12M7 20a2 2 0 100-4 2 2 0 000 4zM17 18a2 2 0 100-4 2 2 0 000 4z',
  file: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z',
  ck: 'M5 12l5 5 9-10',
};

function chip(k) {
  if (k === 'Music') {
    return `<div class="fi" style="color:#f472b6"><svg viewBox="0 0 24 24"><path d="${P.music}"/></svg></div>`;
  }
  if (k === 'Video') {
    return `<div class="fi" style="color:var(--accent2)"><svg viewBox="0 0 24 24"><path d="${P.play}"/></svg></div>`;
  }
  return `<div class="fi" style="color:var(--mute)"><svg viewBox="0 0 24 24"><path d="${P.file}"/></svg></div>`;
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
  el.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${isError ? '#f87171' : '#34d399'}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="${P.ck}"/></svg><span>${escapeHtml(text)}</span>`;
  el.classList.add('on');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.remove('on'), 2200);
}

document.addEventListener('DOMContentLoaded', async () => {
  const main = document.getElementById('main');
  const settings = document.getElementById('settings');
  const statusPill = document.getElementById('statusPill');
  const stTxt = document.getElementById('stTxt');
  const capSwMain = document.getElementById('capSwMain');
  const capSwSet = document.getElementById('capSwSet');
  const pillSwSet = document.getElementById('pillSwSet');
  const qualitySel = document.getElementById('qualitySel');
  const minSizeSel = document.getElementById('minSizeSel');
  const connVal = document.getElementById('connVal');
  const openBtn = document.getElementById('open');
  const gearBtn = document.getElementById('gear');
  const backBtn = document.getElementById('back');
  const doneBtn = document.getElementById('done');
  const mediaCountHeader = document.getElementById('mediaCountHeader');
  const mediaList = document.getElementById('mediaList');
  const recentHeader = document.getElementById('recentHeader');
  const recentList = document.getElementById('recentList');

  // Navigation handlers
  const showView = (v) => {
    main.hidden = v !== 'main';
    settings.hidden = v !== 'settings';
  };
  gearBtn.addEventListener('click', () => showView('settings'));
  backBtn.addEventListener('click', () => showView('main'));
  doneBtn.addEventListener('click', () => showView('main'));

  // 1. Sync settings from storage
  chrome.storage.local.get(['tori_settings'], (res) => {
    const s = res?.tori_settings || {};
    const cap = s.cap !== false;
    const pill = s.pill !== false;
    capSwMain.setAttribute('aria-checked', String(cap));
    capSwSet.setAttribute('aria-checked', String(cap));
    pillSwSet.setAttribute('aria-checked', String(pill));

    if (s.fmt) qualitySel.value = s.fmt;
    if (typeof s.min === 'number') minSizeSel.value = String(s.min);
    if (s.port) connVal.textContent = `127.0.0.1:${s.port}`;
  });

  // Switch helper
  function updateSetting(key, val) {
    chrome.storage.local.get(['tori_settings'], (res) => {
      const s = res?.tori_settings || {};
      s[key] = val;
      chrome.storage.local.set({ tori_settings: s });
    });
  }

  // Toggle Capture Downloads
  const toggleCapture = () => {
    const current = capSwMain.getAttribute('aria-checked') === 'true';
    const next = !current;
    capSwMain.setAttribute('aria-checked', String(next));
    capSwSet.setAttribute('aria-checked', String(next));
    updateSetting('cap', next);
    showToast(next ? 'Capture enabled' : 'Capture disabled');
  };
  capSwMain.addEventListener('click', toggleCapture);
  capSwSet.addEventListener('click', toggleCapture);

  // Toggle Download Button on Videos
  pillSwSet.addEventListener('click', () => {
    const current = pillSwSet.getAttribute('aria-checked') === 'true';
    const next = !current;
    pillSwSet.setAttribute('aria-checked', String(next));
    updateSetting('pill', next);
    showToast(next ? 'Video button enabled' : 'Video button disabled');
  });

  // Default Quality select
  qualitySel.addEventListener('change', () => {
    updateSetting('fmt', qualitySel.value);
    showToast(`Default quality: ${qualitySel.value}`);
  });

  // Minimum Size select
  minSizeSel.addEventListener('change', () => {
    const size = parseInt(minSizeSel.value, 10) || 0;
    updateSetting('min', size);
    showToast(size > 0 ? `Skip files under ${size} MB` : 'Capture all sizes');
  });

  // Open Tori button handler
  openBtn.addEventListener('click', () => {
    showToast('Opening Tori…');
    chrome.runtime.sendMessage({ action: 'SHOW_DESKTOP' }, () => {
      window.close();
    });
  });

  // Desktop Connection Status
  function setStatus(state, port, latency) {
    statusPill.className = 'status';
    if (state === 'connected') {
      main.classList.add('on');
      statusPill.classList.add('on');
      stTxt.textContent = 'Connected';
      if (port) connVal.textContent = `127.0.0.1:${port}`;
    } else if (state === 'unpaired') {
      main.classList.remove('on');
      statusPill.classList.add('wait');
      stTxt.textContent = 'Pairing Required (Click)';
    } else if (state === 'connecting') {
      main.classList.remove('on');
      statusPill.classList.add('conn');
      stTxt.textContent = 'Connecting…';
    } else {
      main.classList.remove('on');
      statusPill.classList.add('bad');
      stTxt.textContent = 'Disconnected';
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

  // Query media on current tab
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
    return items.filter((c) => !c.is_segment && c.type !== 'segment');
  }

  function renderResolutionError(errMsg, tab) {
    stopResolutionPolling();
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
        <div class="empty" style="padding:16px 12px;text-align:center">
          <div style="font-weight:600;margin-bottom:4px;color:#f87171">Resolution Failed</div>
          <div style="font-size:11px;color:var(--mute);line-height:1.4;margin-bottom:12px">${escapeHtml(errMsg)}</div>
          <button class="btn primary" id="btnRetryResolution" style="padding:6px 14px;font-size:12px;margin:0 auto">
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
      <div class="empty" style="padding:20px 12px;text-align:center">
        <div class="tori-spin"></div>
        <div style="font-weight:600;margin-bottom:4px">${forceRefresh ? 'Refreshing media formats…' : 'Resolving media formats…'}</div>
        <div style="font-size:11px;color:var(--mute);line-height:1.4">Extracting genuine quality streams and formats</div>
      </div>`;

    chrome.tabs.sendMessage(tab.id, { action: 'TRIGGER_RESOLVE_MEDIA', force_refresh: forceRefresh }, () => {
      if (chrome.runtime.lastError) {}
    });

    const isPlatform = isManagedPlatform(tab.url);
    const timeoutMs = isPlatform ? 25000 : 13000;

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
        mediaCountHeader.textContent = 'Protected Content';
        mediaList.innerHTML = `
          <div class="empty" style="padding:16px 12px;text-align:center">
            <div style="font-weight:600;margin-bottom:4px;color:#f87171">DRM-Protected Content</div>
            <div style="font-size:11px;color:var(--mute);line-height:1.4">watch.plex.tv content is DRM-protected and not licensed for offline download.</div>
          </div>`;
        return;
      }

      chrome.tabs.sendMessage(tab.id, { action: 'GET_ACTIVE_MEDIA_INFO' }, (info) => {
        if (!chrome.runtime.lastError && info && info.ok) {
          if (info.isResolving && !info.hasAnyCandidates) {
            mediaCountHeader.textContent = 'Resolving media on page…';
            mediaList.innerHTML = `
              <div class="empty" style="padding:20px 12px;text-align:center">
                <div class="tori-spin"></div>
                <div style="font-weight:600;margin-bottom:4px">Resolving media on page…</div>
                <div style="font-size:11px;color:var(--mute);line-height:1.4">Extracting genuine quality streams and formats</div>
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

        chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA', tabId: tab.id }, (res) => {
          const rawItems = res?.media || [];
          const items = getDisplayCandidates(rawItems);
          mediaCountHeader.textContent = `Media on this page · ${items.length}`;

          if (items.length === 0) {
            const isPlatform = isManagedPlatform(tab.url);
            mediaList.innerHTML = `
              <div class="empty" style="padding:16px 12px;text-align:center">
                <div style="font-weight:600;margin-bottom:4px">${isPlatform ? 'Streaming Media Detected' : 'No direct media detected'}</div>
                <div style="font-size:11px;color:var(--mute);line-height:1.4">${isPlatform ? 'Click below to extract high-definition formats using TORI Resolver.' : 'Play the video or click below to resolve.'}</div>
                <button class="btn primary" id="btnResolveTabMedia" style="margin:12px auto 0;padding:6px 14px;font-size:12px">
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
    mediaCountHeader.innerHTML = `<span>Resolved Formats${isCached ? ' <span style="font-size:10px;padding:1px 5px;border-radius:4px;background:var(--raise);color:var(--mute)">Cached</span>' : ''} · ${meta.formats.length}</span><a href="#" id="lnkRefreshFormats" style="font-size:11px;color:var(--accent2);text-decoration:none">Refresh</a>`;
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
        <div class="dl">
          ${chip(cat)}
          <div class="n">
            <b>${escapeHtml(fmt.resolution_label || 'Media')}</b>
            <small>${escapeHtml(displayTitle.substring(0, 36))} · ${escapeHtml(sub)}</small>
          </div>
          <button class="btn-dl" data-fidx="${idx}">Download</button>
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
        const cat = isAudio ? 'Music' : 'Video';
        const sizeStr = item.size_bytes ? ` · ${formatBytes(item.size_bytes)}` : '';
        const formatStr = item.format || 'MP4';
        const sub = `${formatStr}${sizeStr}`;

        return `
        <div class="dl">
          ${chip(cat)}
          <div class="n">
            <b>${escapeHtml(item.filename || 'media_video')}</b>
            <small>${escapeHtml(sub)}</small>
          </div>
          <button class="btn-dl" data-idx="${idx}">Download</button>
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

  // Recent Downloads
  function loadRecentDownloads() {
    chrome.runtime.sendMessage({ action: 'GET_DOWNLOADS' }, (res) => {
      const jobs = res?.jobs || [];
      if (jobs.length === 0) {
        recentList.innerHTML = '<div class="empty">No recent downloads</div>';
        return;
      }

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

          const cat = j.job_type === 'Torrent' ? 'Other' : 'Video';

          return `
          <div class="dl">
            ${chip(cat)}
            <div class="n">
              <b>${escapeHtml(j.filename || 'download')}</b>
              <div class="pr"><i class="${barClass}" style="width:${percent}%"></i></div>
            </div>
            <small style="font-size:11px;font-weight:600;min-width:38px;text-align:right;color:${
              isComplete ? 'var(--ok)' : isFailed ? 'var(--bad)' : 'var(--mute)'
            }">${statusLabel}</small>
          </div>`;
        })
        .join('');
    });
  }

  loadRecentDownloads();
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
