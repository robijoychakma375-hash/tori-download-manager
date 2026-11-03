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
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
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
  function updateConnectionStatus() {
    chrome.runtime.sendMessage({ action: 'PING_DESKTOP' }, (res) => {
      if (chrome.runtime.lastError || !res || res.status !== 'ok') {
        statusPill.className = 'st bad';
        statusText.textContent = 'Desktop Offline';
      } else {
        statusPill.className = 'st';
        statusText.textContent = `Connected · TORI Engine v${res.version || '2.0'}`;
      }
    });
  }
  updateConnectionStatus();

  // 6. Query media on current tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA', tabId: tab.id }, (res) => {
        const items = res?.media || [];
        mediaCountHeader.textContent = `Media on this page · ${items.length}`;

        if (items.length === 0) {
          mediaList.innerHTML = '<div class="empty-state">No media detected on this page</div>';
        } else {
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

          // Bind download buttons
          mediaList.querySelectorAll('button[data-idx]').forEach((btn) => {
            btn.addEventListener('click', () => {
              const idx = parseInt(btn.dataset.idx, 10);
              const target = items[idx];
              if (!target) return;

              btn.textContent = 'Sending…';
              chrome.runtime.sendMessage(
                {
                  action: 'START_DOWNLOAD',
                  url: target.url,
                  filename: target.filename,
                  priority: 'high',
                },
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
                    btn.textContent = 'Retry';
                    showToast(dlRes?.message || 'Download failed', true);
                  }
                }
              );
            });
          });
        }
      });
    }
  } catch (err) {
    console.warn('Failed to query current tab media:', err);
  }

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
  window.addEventListener('unload', () => clearInterval(pollTimer));
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
