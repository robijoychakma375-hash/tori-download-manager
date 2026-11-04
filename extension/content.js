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

  // Extract clean title for media
  function getMediaTitle(videoEl) {
    if (videoEl.title) return videoEl.title;
    if (videoEl.getAttribute('aria-label')) return videoEl.getAttribute('aria-label');
    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent.trim()) return h1.textContent.trim();
    if (document.title) return document.title.replace(/ - YouTube$| - Vimeo$/i, '').trim();
    return 'Video Media';
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

    videoEl.setAttribute('data-tori-attached', 'true');

    // Create container
    const mp = document.createElement('div');
    mp.className = `tori-mp ${getPosClass(settings.pos)}`;

    // Create pill button
    const pill = document.createElement('button');
    pill.className = 'tori-pill';
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

    // Find suitable positioning anchor
    let anchor = videoEl.parentElement;
    if (anchor) {
      const style = window.getComputedStyle(anchor);
      if (style.position === 'static') {
        anchor.style.position = 'relative';
      }
      anchor.appendChild(mp);
    }

    let activeTab = settings.kind === 'Audio only' ? 'Audio' : 'Video';
    let selectedIdx = 0;
    let isDownloaded = false;
    let tabMediaCandidates = [];
    let resolvedMeta = null;
    let isResolving = false;
    let resolveError = null;

    // Collect genuine detected media candidates (never hardcoded, never webpage URL)
    function getAvailableFormats() {
      if (resolvedMeta && Array.isArray(resolvedMeta.formats) && resolvedMeta.formats.length > 0) {
        const title = resolvedMeta.title || getMediaTitle(videoEl);
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

          const item = {
            q: f.resolution_label,
            tg: (f.container || 'mp4').toUpperCase(),
            hd: isHd ? 'HD' : null,
            cd: f.format_note || f.vcodec || f.acodec || f.protocol,
            sz: sizeStr,
            url: f.direct_stream_url || resolvedMeta.source_url,
            format_id: f.format_id,
            filename: sanitizeFilename(title, (f.container || 'mp4').toLowerCase()),
            isAudio,
            isManaged: f.download_capability === 'managed_extractor',
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

      const title = getMediaTitle(videoEl);
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

        const isHd = videoEl.videoHeight >= 720;
        let qualityLabel = '';
        if (videoEl.videoHeight) {
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
      if (hasAnyCandidates) {
        const top = videoFormats[0] || audioFormats[0];
        tagEl.textContent = top.q || top.tg || 'Media';
        tagEl.style.color = '';
        tagEl.style.background = '';
      } else {
        tagEl.textContent = 'Unavailable';
        tagEl.style.color = 'var(--tori-bad)';
        tagEl.style.background = 'rgba(229, 72, 77, 0.12)';
      }
    }

    // Pill click handler
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();

      // If user disabled format picker, trigger download directly
      if (!settings.picker) {
        triggerDirectDownload(videoEl);
        return;
      }

      const isOpen = pn.classList.contains('on');
      // Close any other open panels
      document.querySelectorAll('.tori-pn.on').forEach((p) => p.classList.remove('on'));

      if (!isOpen) {
        pn.classList.add('on');

        // Query background service worker for all streams captured on this tab
        chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA' }, (res) => {
          tabMediaCandidates = res?.media || [];
          updatePillTag();

          const { hasAnyCandidates } = getAvailableFormats();
          if (!hasAnyCandidates && !resolvedMeta && !isResolving) {
            isResolving = true;
            resolveError = null;
            renderPanel();

            chrome.runtime.sendMessage(
              { action: 'RESOLVE_MEDIA', url: window.location.href },
              (rRes) => {
                isResolving = false;
                if (rRes && rRes.status === 'ok' && rRes.metadata) {
                  resolvedMeta = rRes.metadata;
                  updatePillTag();
                } else {
                  resolveError = rRes?.message || 'Protected or unsupported stream';
                }
                renderPanel();
              }
            );
          } else {
            renderPanel();
          }
        });
      }
    });

    // Close panel on outside click
    document.addEventListener('click', (e) => {
      if (!mp.contains(e.target)) {
        pn.classList.remove('on');
      }
    });

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
            <div class="tori-fr ${i === selectedIdx ? 'on' : ''}" data-idx="${i}">
              <span class="tori-rd"></span>
              <span class="tori-q">${escapeHtml(f.q)}</span>
              <span class="tori-tg">${escapeHtml(f.tg)}</span>
              ${f.hd ? `<span class="tori-tg hd">${escapeHtml(f.hd)}</span>` : ''}
              <span class="tori-cd">${escapeHtml(f.cd)}</span>
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
        listHtml = `
          <div class="tori-empty-box">
            <i class="tori-ft" style="--c:#f59e0b;margin-bottom:4px">
              <svg viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
            </i>
            <b>${escapeHtml(resolveError || 'No Downloadable Stream Detected')}</b>
            <p>This player uses protected MediaSource blob streaming without an accessible direct file or HLS/DASH manifest.</p>
            <span style="font-size:10px;color:var(--tori-mut)">TORI respects DRM boundaries and does not inject scrapers.</span>
          </div>`;
      }

      const canDownload = hasAnyCandidates && !!currentItem && !!currentItem.url;
      const dlBtnText = !hasAnyCandidates
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
          pn.classList.remove('on');
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

      const dlBtn = pn.querySelector('[data-act="download"]');
      if (dlBtn) {
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!canDownload) {
            showToast('No downloadable media stream available on this page', true);
            return;
          }
          const target = currentList[selectedIdx];
          if (!target || (!target.url && !target.format_id)) {
            showToast('No downloadable stream available', true);
            return;
          }

          const reqPayload = target.isManaged && resolvedMeta
            ? {
                action: 'START_MEDIA_DOWNLOAD',
                url: resolvedMeta.source_url,
                format_id: target.format_id,
                filename: target.filename,
                priority: 'high',
              }
            : {
                action: 'START_DOWNLOAD',
                url: target.url,
                filename: target.filename,
                priority: 'high',
              };

          chrome.runtime.sendMessage(reqPayload, (res) => {
            if (res && res.status === 'ok') {
              isDownloaded = true;
              renderPanel();
              showToast('Sent to Tori');
              setTimeout(() => {
                isDownloaded = false;
                pn.classList.remove('on');
              }, 1600);
            } else if (res && res.status === 'already_exists') {
              showToast('Already downloading in Tori');
            } else {
              showToast(res?.message || 'Download failed', true);
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

      const reqPayload = target.isManaged && resolvedMeta
        ? {
            action: 'START_MEDIA_DOWNLOAD',
            url: resolvedMeta.source_url,
            format_id: target.format_id,
            filename: target.filename,
            priority: 'high',
          }
        : {
            action: 'START_DOWNLOAD',
            url: target.url,
            filename: target.filename,
            priority: 'high',
          };

      chrome.runtime.sendMessage(reqPayload, (res) => {
        if (res && res.status === 'ok') {
          showToast('Sent to Tori');
        } else if (res && res.status === 'already_exists') {
          showToast('Already downloading in Tori');
        } else {
          showToast(res?.message || 'Download failed', true);
        }
      });
    }

    // Dynamic state updates when media metadata loads or changes
    videoEl.addEventListener('loadedmetadata', updatePillTag);
    videoEl.addEventListener('canplay', updatePillTag);
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

    updatePillTag();
  }

  // Scan document for media elements
  function scanForMedia() {
    if (isSiteExcluded()) return;

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
