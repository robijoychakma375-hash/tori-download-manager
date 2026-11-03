// TORI Download Manager - Extension Popup Controller

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const desktopStatusBadge = document.getElementById('desktopStatusBadge');
  const desktopStatusText = document.getElementById('desktopStatusText');
  const themeToggleBtn = document.getElementById('themeToggleBtn');

  const tabDetectedBtn = document.getElementById('tabDetectedBtn');
  const tabDownloadsBtn = document.getElementById('tabDownloadsBtn');
  const detectedSection = document.getElementById('detectedSection');
  const downloadsSection = document.getElementById('downloadsSection');
  const detectedCountBadge = document.getElementById('detectedCountBadge');
  const downloadsCountBadge = document.getElementById('downloadsCountBadge');

  const mediaListContainer = document.getElementById('mediaListContainer');
  const noMediaState = document.getElementById('noMediaState');
  const downloadsListContainer = document.getElementById('downloadsListContainer');
  const noDownloadsState = document.getElementById('noDownloadsState');

  const quickDownloadForm = document.getElementById('quickDownloadForm');
  const quickUrlInput = document.getElementById('quickUrlInput');
  const quickPrioritySelect = document.getElementById('quickPrioritySelect');
  const popupToast = document.getElementById('popupToast');

  let currentTabId = null;
  let activeTabName = 'detected';
  let queuePollInterval = null;

  // 1. Initialize Theme
  chrome.storage.local.get(['tori_theme'], (result) => {
    if (result.tori_theme === 'light') {
      document.body.classList.remove('dark-theme');
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
      document.body.classList.add('dark-theme');
    }
  });

  themeToggleBtn.addEventListener('click', () => {
    const isLight = document.body.classList.contains('light-theme');
    if (isLight) {
      document.body.classList.remove('light-theme');
      document.body.classList.add('dark-theme');
      chrome.storage.local.set({ tori_theme: 'dark' });
    } else {
      document.body.classList.remove('dark-theme');
      document.body.classList.add('light-theme');
      chrome.storage.local.set({ tori_theme: 'light' });
    }
  });

  // 2. Toast Notification Helper
  function showToast(message, isSuccess = true) {
    popupToast.textContent = message;
    popupToast.className = 'popup-toast show ' + (isSuccess ? 'toast-success' : 'toast-error');
    setTimeout(() => {
      popupToast.classList.remove('show');
    }, 2800);
  }

  // 3. Tab Switching
  tabDetectedBtn.addEventListener('click', () => {
    activeTabName = 'detected';
    tabDetectedBtn.classList.add('active');
    tabDownloadsBtn.classList.remove('active');
    detectedSection.classList.add('active');
    downloadsSection.classList.remove('active');
    if (queuePollInterval) {
      clearInterval(queuePollInterval);
      queuePollInterval = null;
    }
    loadDetectedMedia();
  });

  tabDownloadsBtn.addEventListener('click', () => {
    activeTabName = 'downloads';
    tabDownloadsBtn.classList.add('active');
    tabDetectedBtn.classList.remove('active');
    downloadsSection.classList.add('active');
    detectedSection.classList.remove('active');
    loadDesktopQueue();
    // Poll queue while queue tab is active (every 1.5s)
    if (!queuePollInterval) {
      queuePollInterval = setInterval(loadDesktopQueue, 1500);
    }
  });

  // 4. Desktop Status Check
  function checkDesktopStatus() {
    desktopStatusBadge.className = 'status-pill status-checking';
    desktopStatusText.textContent = 'Checking...';

    chrome.runtime.sendMessage({ action: 'PING_DESKTOP' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.success) {
        desktopStatusBadge.className = 'status-pill status-offline';
        desktopStatusText.textContent = 'Desktop Offline';
        desktopStatusBadge.title = (response && response.error) ? response.error : 'TORI native desktop host not responding';
      } else {
        desktopStatusBadge.className = 'status-pill status-connected';
        desktopStatusText.textContent = 'Connected';
        desktopStatusBadge.title = `Host PID: ${response.pid || 'running'}`;
      }
    });
  }

  desktopStatusBadge.addEventListener('click', checkDesktopStatus);

  // Format bytes helper
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return 'Unknown size';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Format speed helper
  function formatSpeed(bps) {
    if (!bps || bps <= 0) return '';
    return formatBytes(bps) + '/s';
  }

  // 5. Load Detected Media for Current Active Tab
  function loadDetectedMedia() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) return;
      currentTabId = tabs[0].id;

      chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA', tabId: currentTabId }, (response) => {
        if (!response || !response.success) return;

        const mediaItems = response.items || [];
        detectedCountBadge.textContent = mediaItems.length;

        if (mediaItems.length === 0) {
          mediaListContainer.innerHTML = '';
          noMediaState.style.display = 'flex';
          return;
        }

        noMediaState.style.display = 'none';
        mediaListContainer.innerHTML = '';

        mediaItems.forEach((item) => {
          const card = document.createElement('div');
          card.className = 'media-card';

          const isDASH = item.format === 'mpd' || item.category === 'dash' || (item.url && item.url.includes('.mpd'));
          const isHls = item.format === 'm3u8' || item.category === 'hls' || (item.url && item.url.includes('.m3u8'));
          const isTorrent = item.category === 'torrent' || item.format === 'TORRENT' || item.format === 'MAGNET' || (item.url && (item.url.startsWith('magnet:') || item.url.includes('.torrent')));
          const isLive = item.category === 'live' || (item.url && (item.url.startsWith('rtsp://') || item.url.startsWith('rtmp://') || item.url.startsWith('rtmps://') || item.url.startsWith('srt://') || item.url.startsWith('udp://')));
          
          let badgeClass = 'badge-video';
          let badgeLabel = (item.format || 'MEDIA').toUpperCase();
          if (isLive) {
            badgeClass = 'badge-stream';
            badgeLabel = 'LIVE STREAM';
          } else if (isTorrent) {
            badgeClass = 'badge-stream';
            badgeLabel = item.format || 'TORRENT';
          } else if (isDASH) {
            badgeClass = 'badge-stream';
            badgeLabel = 'DASH VOD';
          } else if (isHls) {
            badgeClass = 'badge-stream';
            badgeLabel = 'HLS VOD';
          } else if (item.category === 'audio') {
            badgeClass = 'badge-audio';
          }

          const sizeText = item.size ? formatBytes(item.size) : (isLive ? 'Live Stream Recording' : (isHls ? 'Adaptive HLS Stream' : (isDASH ? 'Adaptive DASH Stream' : (isTorrent ? 'BitTorrent P2P' : 'Direct file'))));

          card.innerHTML = `
            <div class="media-card-top">
              <div class="media-info">
                <div class="media-filename" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</div>
                <div class="media-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</div>
                <div class="media-meta">
                  <span class="badge ${badgeClass}">${badgeLabel}</span>
                  <span class="media-size">${sizeText}</span>
                </div>
              </div>
              <div class="media-actions">
                <button class="btn-download" data-url="${escapeHtml(item.url)}" data-filename="${escapeHtml(item.filename)}">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                  Download
                </button>
              </div>
            </div>
          `;

          // Attach click handler for download
          const dlBtn = card.querySelector('.btn-download');
          dlBtn.addEventListener('click', () => {
            dlBtn.disabled = true;
            dlBtn.textContent = 'Starting...';

            chrome.runtime.sendMessage({
              action: 'START_DOWNLOAD',
              url: item.url,
              filename: item.filename,
              priority: 'normal',
              }, (dlRes) => {
                if (chrome.runtime.lastError || !dlRes || !dlRes.success) {
                  const errMsg = (dlRes && dlRes.error) ? dlRes.error : 'Failed to reach TORI';
                  showToast(errMsg, false);
                  dlBtn.disabled = false;
                  dlBtn.textContent = 'Download';
                } else if (dlRes.status === 'already_exists') {
                  showToast('Job already active or completed in TORI', true);
                  dlBtn.textContent = 'In Queue';
                } else {
                  showToast('Download started in TORI engine!', true);
                  dlBtn.textContent = 'Added';
                  // Auto-switch to desktop queue
                  setTimeout(() => {
                    tabDownloadsBtn.click();
                  }, 600);
                }
              });
            });
          }

          mediaListContainer.appendChild(card);
        });
      });
    });
  }

  // 6. Load Desktop Queue
  function loadDesktopQueue() {
    chrome.runtime.sendMessage({ action: 'GET_DOWNLOADS' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.success) {
        downloadsCountBadge.textContent = '0';
        downloadsListContainer.innerHTML = '';
        noDownloadsState.style.display = 'flex';
        return;
      }

      const downloads = response.downloads || [];
      downloadsCountBadge.textContent = downloads.length;

      if (downloads.length === 0) {
        downloadsListContainer.innerHTML = '';
        noDownloadsState.style.display = 'flex';
        return;
      }

      noDownloadsState.style.display = 'none';
      downloadsListContainer.innerHTML = '';

      downloads.forEach((job) => {
        const card = document.createElement('div');
        card.className = 'media-card';

        const total = job.total_bytes || 0;
        const current = job.downloaded_bytes || 0;
        const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
        const state = (job.state || 'Unknown').toLowerCase();

        let stateBadgeClass = 'badge-video';
        if (state === 'completed') stateBadgeClass = 'badge-audio';
        else if (state === 'failed' || state === 'cancelled') stateBadgeClass = 'badge-unsupported';
        else if (state === 'paused') stateBadgeClass = 'badge-stream';

        card.innerHTML = `
          <div class="media-card-top">
            <div class="media-info">
              <div class="media-filename" title="${escapeHtml(job.filename)}">${escapeHtml(job.filename)}</div>
              <div class="media-meta">
                <span class="badge ${stateBadgeClass}">${escapeHtml(job.state)}</span>
                <span class="media-size">${formatBytes(current)} / ${formatBytes(total)} (${percent}%)</span>
                ${job.priority ? `<span class="media-size" style="text-transform:capitalize;">[${escapeHtml(job.priority)}]</span>` : ''}
              </div>
            </div>
            <div class="media-actions">
              ${(state === 'downloading' || state === 'queued')
                ? `<button class="btn-action-small btn-pause" data-id="${job.id}">Pause</button>`
                : (state === 'paused'
                    ? `<button class="btn-action-small btn-resume" data-id="${job.id}">Resume</button>`
                    : '')
              }
              ${(state !== 'completed')
                ? `<button class="btn-action-small btn-cancel" data-id="${job.id}" style="color:var(--color-danger);">Cancel</button>`
                : ''
              }
            </div>
          </div>
          ${(state === 'downloading' || state === 'paused') ? `
            <div class="queue-progress-bar-bg">
              <div class="queue-progress-bar-fill" style="width: ${percent}%;"></div>
            </div>
          ` : ''}
          ${job.error_message ? `<div style="font-size:11px; color:var(--color-danger); margin-top:4px;">${escapeHtml(job.error_message)}</div>` : ''}
        `;

        // Wire Action Buttons
        const pauseBtn = card.querySelector('.btn-pause');
        if (pauseBtn) {
          pauseBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'PAUSE_DOWNLOAD', id: job.id }, () => {
              loadDesktopQueue();
            });
          });
        }

        const resumeBtn = card.querySelector('.btn-resume');
        if (resumeBtn) {
          resumeBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'RESUME_DOWNLOAD', id: job.id }, () => {
              loadDesktopQueue();
            });
          });
        }

        const cancelBtn = card.querySelector('.btn-cancel');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'CANCEL_DOWNLOAD', id: job.id }, () => {
              loadDesktopQueue();
            });
          });
        }

        downloadsListContainer.appendChild(card);
      });
    });
  }

  // 7. Quick Intake Form
  quickDownloadForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const rawUrl = quickUrlInput.value.trim();
    if (!rawUrl) return;

    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
      showToast('Only HTTP and HTTPS URLs are supported', false);
      return;
    }

    const priority = quickPrioritySelect.value || 'normal';
    quickUrlInput.disabled = true;

    chrome.runtime.sendMessage({
      action: 'START_DOWNLOAD',
      url: rawUrl,
      priority: priority,
    }, (response) => {
      quickUrlInput.disabled = false;
      if (chrome.runtime.lastError || !response || !response.success) {
        const errMsg = (response && response.error) ? response.error : 'Failed to dispatch to TORI';
        showToast(errMsg, false);
      } else {
        showToast('Download started in TORI engine!', true);
        quickUrlInput.value = '';
        tabDownloadsBtn.click();
      }
    });
  });

  // Utility to prevent XSS
  function escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Initial runs
  checkDesktopStatus();
  loadDetectedMedia();
});

