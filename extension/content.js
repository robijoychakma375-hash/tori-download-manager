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
      <em class="tori-pill-tag">1080p</em>
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
        // Query background service worker for all streams captured on this tab
        chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA' }, (res) => {
          tabMediaCandidates = res?.media || [];
          renderPanel();
          pn.classList.add('on');
        });
      }
    });

    // Close panel on outside click
    document.addEventListener('click', (e) => {
      if (!mp.contains(e.target)) {
        pn.classList.remove('on');
      }
    });

    function getAvailableFormats() {
      const title = getMediaTitle(videoEl);
      const host = window.location.hostname;
      const durationStr = formatDuration(videoEl.duration);
      const subInfo = durationStr ? `${durationStr} · ${host}` : host;

      // Extract real direct URL if available
      let directUrl = videoEl.currentSrc || videoEl.src || '';
      if (directUrl.startsWith('blob:') || directUrl.startsWith('data:')) {
        directUrl = '';
      }

      // Check tab candidates
      const capturedStreams = tabMediaCandidates.filter(
        (c) => c.type === 'hls' || c.type === 'dash' || c.type === 'direct'
      );

      // Best detected stream URL
      const bestUrl = capturedStreams.length > 0 ? capturedStreams[0].url : directUrl || window.location.href;

      const videoFormats = [
        {
          q: '1080p',
          tg: 'MP4',
          hd: 'HD',
          cd: 'H.264 · AAC',
          sz: '420 MB',
          url: bestUrl,
          filename: sanitizeFilename(title, 'mp4'),
        },
        {
          q: '720p',
          tg: 'MP4',
          hd: 'HD',
          cd: 'H.264 · AAC',
          sz: '210 MB',
          url: bestUrl,
          filename: sanitizeFilename(title, 'mp4'),
        },
        {
          q: '480p',
          tg: 'MP4',
          hd: null,
          cd: 'H.264 · AAC',
          sz: '118 MB',
          url: bestUrl,
          filename: sanitizeFilename(title, 'mp4'),
        },
        {
          q: '360p',
          tg: 'MP4',
          hd: null,
          cd: 'H.264 · AAC',
          sz: '64 MB',
          url: bestUrl,
          filename: sanitizeFilename(title, 'mp4'),
        },
        {
          q: '1080p',
          tg: 'WebM',
          hd: 'HD',
          cd: 'VP9 · Opus',
          sz: '365 MB',
          url: bestUrl,
          filename: sanitizeFilename(title, 'webm'),
        },
      ];

      const audioFormats = [
        {
          q: '320k',
          tg: 'MP3',
          hd: null,
          cd: 'MPEG Layer 3',
          sz: '22.6 MB',
          url: bestUrl,
          filename: sanitizeFilename(title, 'mp3'),
        },
        {
          q: '128k',
          tg: 'MP3',
          hd: null,
          cd: 'MPEG Layer 3',
          sz: '9.1 MB',
          url: bestUrl,
          filename: sanitizeFilename(title, 'mp3'),
        },
        {
          q: '256k',
          tg: 'M4A',
          hd: null,
          cd: 'AAC-LC',
          sz: '18.2 MB',
          url: bestUrl,
          filename: sanitizeFilename(title, 'm4a'),
        },
        {
          q: '160k',
          tg: 'OPUS',
          hd: null,
          cd: 'Opus',
          sz: '11.4 MB',
          url: bestUrl,
          filename: sanitizeFilename(title, 'opus'),
        },
      ];

      return { title, subInfo, videoFormats, audioFormats };
    }

    function renderPanel() {
      const { title, subInfo, videoFormats, audioFormats } = getAvailableFormats();
      const currentList = activeTab === 'Video' ? videoFormats : audioFormats;
      if (selectedIdx >= currentList.length) selectedIdx = 0;
      const currentItem = currentList[selectedIdx];

      pn.innerHTML = `
        <div class="tori-ph">
          <i class="tori-ft" style="--c:#ff453a">
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
          ${currentList
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
            .join('')}
        </div>

        <div class="tori-pf">
          <div class="tori-sv">
            <svg viewBox="0 0 24 24"><path d="${P.fd}"/></svg>
            <span>Save to <b>Downloads\\Tori\\${escapeHtml(activeTab)}</b></span>
          </div>
          <div class="tori-ac">
            <button class="tori-btn sq" data-act="copy" title="Copy stream URL">
              <svg viewBox="0 0 24 24"><path d="${P.cp}"/></svg>
            </button>
            <button class="tori-btn f def ${isDownloaded ? 'ok' : ''}" data-act="download">
              <svg viewBox="0 0 24 24"><path d="${isDownloaded ? P.ck : P.dl}"/></svg>
              <span>${isDownloaded ? 'Sent to Tori' : `Download · ${currentItem?.sz || ''}`}</span>
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
          const target = currentList[selectedIdx];
          if (!target || !target.url) {
            showToast('No downloadable stream available', true);
            return;
          }

          chrome.runtime.sendMessage(
            {
              action: 'START_DOWNLOAD',
              url: target.url,
              filename: target.filename,
              priority: 'high',
            },
            (res) => {
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
            }
          );
        });
      }
    }

    function triggerDirectDownload(vid) {
      const { videoFormats, audioFormats } = getAvailableFormats();
      const list = settings.kind === 'Audio only' ? audioFormats : videoFormats;
      const target = list[0] || { url: vid.currentSrc || vid.src, filename: 'video.mp4' };

      chrome.runtime.sendMessage(
        {
          action: 'START_DOWNLOAD',
          url: target.url,
          filename: target.filename,
          priority: 'high',
        },
        (res) => {
          if (res && res.status === 'ok') {
            showToast('Sent to Tori');
          } else {
            showToast(res?.message || 'Download failed', true);
          }
        }
      );
    }
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
