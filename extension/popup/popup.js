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
  async function loadActiveTabMedia() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return;

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
          if (info.isResolving) {
            mediaCountHeader.textContent = 'Resolving media on page…';
            mediaList.innerHTML = `
              <div class="empty-state" style="padding:20px 12px;text-align:center">
                <div style="font-weight:600;margin-bottom:4px">Resolving media on page…</div>
                <div style="font-size:11px;color:var(--mut);line-height:1.4">Extracting genuine quality streams and formats</div>
              </div>`;
            return;
          }

          if (info.resolvedMeta && Array.isArray(info.resolvedMeta.formats) && info.resolvedMeta.formats.length > 0) {
            renderResolvedFormats(info.resolvedMeta, tab);
            return;
          }
        }

        // 2. Fallback: check tab media cache from background
        chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA', tabId: tab.id }, (res) => {
          const items = res?.media || [];
          mediaCountHeader.textContent = `Media on this page · ${items.length}`;

          if (items.length === 0) {
            mediaList.innerHTML = `
              <div class="empty-state" style="padding:16px 12px;text-align:center">
                <div style="font-weight:600;margin-bottom:4px">No direct media stream detected</div>
                <div style="font-size:11px;color:var(--mut);line-height:1.4">Streaming platforms (YouTube, Vimeo, Facebook, etc.) require media resolution.</div>
                <button class="btn mb def" id="btnResolveTabMedia" style="margin-top:12px;padding:6px 16px">
                  <svg viewBox="0 0 24 24" style="width:14px;height:14px;margin-right:6px"><path d="M12 4v10M8 10l4 4 4-4M5 19h14"/></svg>
                  Resolve Media on Page
                </button>
              </div>`;

            const btnResolve = document.getElementById('btnResolveTabMedia');
            if (btnResolve) {
              btnResolve.addEventListener('click', () => {
                btnResolve.textContent = 'Resolving media…';
                btnResolve.disabled = true;

                chrome.runtime.sendMessage({ action: 'RESOLVE_MEDIA', url: tab.url }, (rRes) => {
                  if (rRes && rRes.status === 'ok' && rRes.metadata && rRes.metadata.formats) {
                    renderResolvedFormats(rRes.metadata, tab);
                  } else {
                    btnResolve.textContent = 'Resolve Media on Page';
                    btnResolve.disabled = false;
                    showToast(rRes?.message || 'Media resolution failed', true);
                  }
                });
              });
            }
          } else {
            renderDirectItems(items);
          }
        });
      });
    } catch (err) {
      console.warn('Failed to query current tab media:', err);
    }
  }

  function renderResolvedFormats(meta, tab) {
    mediaCountHeader.textContent = `Resolved Formats · ${meta.formats.length}`;
    showToast(`Found ${meta.formats.length} formats`);

    mediaList.innerHTML = meta.formats
      .map((fmt, idx) => {
        const isAudio = !fmt.has_video && fmt.has_audio;
        const cat = isAudio ? 'Music' : 'Video';
        let sizeStr = '';
        if (fmt.filesize_type === 'exact' && fmt.filesize) {
          sizeStr = ` · ${formatBytes(fmt.filesize)}`;
        } else if (fmt.filesize_type === 'estimated' && fmt.filesize_approx) {
          sizeStr = ` · ~${formatBytes(fmt.filesize_approx)}`;
        } else {
          sizeStr = ' · Size unknown';
        }
        const sub = `${(fmt.container || 'mp4').toUpperCase()}${sizeStr}`;

        return `
        <div class="row">
          ${chip(cat)}
          <div class="t">
            <b>${escapeHtml(fmt.resolution_label || 'Media')}</b>
            <span class="s">${escapeHtml(meta.title.substring(0, 36))} · ${escapeHtml(sub)}</span>
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

        chrome.runtime.sendMessage(
          {
            action: 'START_MEDIA_DOWNLOAD',
            url: meta.source_url || tab.url,
            format_id: selected.format_id,
            filename: `${meta.title.replace(/[\\/:*?"<>|]/g, '') || 'media'}.${selected.container || 'mp4'}`,
            priority: 'high',
            correlation_id: correlationId,
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

  function renderDirectItems(items) {
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

    mediaList.querySelectorAll('button[data-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const target = items[idx];
        if (!target) return;

        btn.textContent = 'Sending…';
        const isManaged = isManagedPlatform(tab.url) || isTransientCdnUrl(target.url);
        const reqPayload = isManaged
          ? {
              action: 'START_MEDIA_DOWNLOAD',
              url: tab.url,
              format_id: 'best',
              filename: target.filename,
              priority: 'high',
              page_url: tab.url,
            }
          : {
              action: 'START_DOWNLOAD',
              url: target.url,
              filename: target.filename,
              priority: 'high',
              page_url: tab.url,
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
      loadActiveTabMedia();
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
  window.addEventListener('unload', () => clearInterval(pollTimer));
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
