/**
 * TORI Browser Companion — Toolbar Popup Controller
 * Implements IDM popup layout (tori-extension.html) with live backend state checks,
 * Open TORI handoff/launch, settings sync, and genuine page media quick download.
 */

const ACCENTS = ['indigo', 'ocean', 'emerald', 'rose'];

const SVG_PATHS = {
  play: 'M9 6.5v11l9-5.5z',
  music: 'M9 18V6l10-2v12M7 20a2 2 0 100-4 2 2 0 000 4zM17 18a2 2 0 100-4 2 2 0 000 4z',
  dl: 'M12 4v10M8 10l4 4 4-4M5 19h14',
};

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveTheme(themePref) {
  if (themePref === 'dark') return 'dark';
  if (themePref === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

function applyAppearance(settings) {
  const root = document.documentElement;
  const theme = resolveTheme(settings?.theme || 'light');
  const accent = ACCENTS.includes(settings?.accent) ? settings.accent : 'indigo';
  root.dataset.theme = theme;
  if (accent === 'indigo') {
    root.removeAttribute('data-accent');
  } else {
    root.dataset.accent = accent;
  }
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
  const formatted =
    val < 100 ? (val.toFixed(1).endsWith('.0') ? val.toFixed(0) : val.toFixed(1)) : val.toFixed(0);
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
    if (est > 0) return `~${formatBytes(est)}`;
  }
  return 'Size unknown';
}

function chipIcon(isAudio) {
  const color = isAudio ? '#ff375f' : '#ff453a';
  const path = isAudio ? SVG_PATHS.music : SVG_PATHS.play;
  return `<span class="ft" style="--c:${color}" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="${path}"/></svg></span>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const mainEl = document.getElementById('main');
  const statusPill = document.getElementById('statusPill');
  const stTxt = document.getElementById('stTxt');
  const capSwMain = document.getElementById('capSwMain');
  const connBanner = document.getElementById('connBanner');
  const connBannerTxt = document.getElementById('connBannerTxt');
  const btnReconnect = document.getElementById('btnReconnect');
  const mediaSection = document.getElementById('mediaSection');
  const mediaCountHeader = document.getElementById('mediaCountHeader');
  const mediaList = document.getElementById('mediaList');
  const btnRefreshMedia = document.getElementById('btnRefreshMedia');
  const popupNotice = document.getElementById('popupNotice');
  const openBtn = document.getElementById('open');
  const openLabel = document.getElementById('openLabel');
  const gearBtn = document.getElementById('gear');

  let currentSettings = { cap: true, theme: 'light', accent: 'indigo', port: 6800 };
  let currentConnState = 'connecting';
  let noticeTimer = null;
  let openInFlight = false;
  let checkInFlight = false;

  function showNotice(text, kind = 'info', durationMs = 2600) {
    if (!popupNotice) return;
    if (!text) {
      popupNotice.hidden = true;
      popupNotice.textContent = '';
      popupNotice.className = 'notice-bar';
      return;
    }
    popupNotice.textContent = text;
    popupNotice.className = `notice-bar ${kind === 'error' ? 'err' : kind === 'ok' ? 'ok' : ''}`.trim();
    popupNotice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      popupNotice.hidden = true;
    }, durationMs);
  }

  function setStatus(state, port, detailMsg) {
    currentConnState = state;
    statusPill.className = `st ${state}`;
    mainEl.classList.toggle('on', state === 'connected');

    if (state === 'connected') {
      stTxt.textContent = port ? `Connected · :${port}` : 'Connected';
      statusPill.title = `Connected to TORI Desktop on 127.0.0.1:${port || currentSettings.port}`;
      connBanner.hidden = true;
    } else if (state === 'connecting') {
      stTxt.textContent = 'Connecting…';
      statusPill.title = 'Checking live TORI Desktop connection…';
      connBanner.hidden = true;
    } else if (state === 'reconnecting') {
      stTxt.textContent = 'Reconnecting…';
      statusPill.title = 'Reconnecting to TORI Desktop…';
      connBanner.hidden = false;
      connBannerTxt.textContent = 'Attempting to reach or pair with TORI Desktop…';
      btnReconnect.disabled = true;
    } else if (state === 'disconnected') {
      stTxt.textContent = 'Disconnected';
      statusPill.title = detailMsg || 'TORI Desktop is running but unpaired or disconnected.';
      connBanner.hidden = false;
      connBannerTxt.textContent = detailMsg || 'Pairing required to communicate with TORI.';
      btnReconnect.disabled = false;
      btnReconnect.textContent = 'Reconnect';
    } else {
      // Desktop unavailable
      stTxt.textContent = 'Desktop unavailable';
      statusPill.title = detailMsg || 'TORI Desktop is not running or unreachable.';
      connBanner.hidden = false;
      connBannerTxt.textContent = detailMsg || 'TORI Desktop is not responding on local port.';
      btnReconnect.disabled = false;
      btnReconnect.textContent = 'Reconnect';
    }
  }

  // Never trust cached connection status on open — start in Connecting... and verify live.
  setStatus('connecting');

  function syncSettingsFromStorage() {
    chrome.storage.local.get(['tori_settings', 'tori_theme', 'tori_accent'], (res) => {
      const stored = res?.tori_settings || {};
      currentSettings = {
        ...currentSettings,
        ...stored,
        theme: stored.theme || res?.tori_theme || 'light',
        accent: stored.accent || res?.tori_accent || 'indigo',
      };
      capSwMain.checked = currentSettings.cap !== false;
      applyAppearance(currentSettings);
    });
  }

  syncSettingsFromStorage();

  const mqlDark = window.matchMedia('(prefers-color-scheme: dark)');
  const onMqlChange = () => {
    if (currentSettings.theme === 'system') applyAppearance(currentSettings);
  };
  mqlDark.addEventListener('change', onMqlChange);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.tori_settings || changes.tori_theme || changes.tori_accent) {
      syncSettingsFromStorage();
    }
  });

  // Capture Downloads toggle
  capSwMain.addEventListener('change', () => {
    const enabled = capSwMain.checked;
    chrome.storage.local.get(['tori_settings'], (res) => {
      const next = { ...(res?.tori_settings || {}), cap: enabled };
      chrome.storage.local.set({ tori_settings: next }, () => {
        showNotice(enabled ? 'Download capture enabled' : 'Download capture paused', 'ok');
      });
    });
  });

  // Live Connectivity Verification
  function checkLiveConnection() {
    if (checkInFlight) return;
    checkInFlight = true;

    const timer = setTimeout(() => {
      if (!checkInFlight) return;
      checkInFlight = false;
      setStatus('unavailable', currentSettings.port, 'Desktop health check timed out.');
    }, 4500);

    chrome.runtime.sendMessage({ action: 'PING_DESKTOP', passive: true }, (res) => {
      clearTimeout(timer);
      checkInFlight = false;
      if (chrome.runtime.lastError || !res) {
        setStatus('unavailable', currentSettings.port, 'Background worker unavailable.');
        return;
      }
      if (res.status === 'ok' && res.authenticated) {
        setStatus('connected', res.port || currentSettings.port);
      } else if (res.status === 'unpaired' || res.status === 'disconnected') {
        setStatus('disconnected', res.port || currentSettings.port, res.message);
      } else {
        setStatus('unavailable', res.port || currentSettings.port, res.message);
      }
    });
  }

  function triggerReconnect() {
    if (checkInFlight) return;
    checkInFlight = true;
    setStatus('reconnecting', currentSettings.port);

    const timer = setTimeout(() => {
      if (!checkInFlight) return;
      checkInFlight = false;
      setStatus('unavailable', currentSettings.port, 'Reconnect timed out. Launch TORI Desktop and retry.');
    }, 8000);

    chrome.runtime.sendMessage({ action: 'RECONNECT_DESKTOP' }, (res) => {
      clearTimeout(timer);
      checkInFlight = false;
      if (chrome.runtime.lastError || !res) {
        setStatus('unavailable', currentSettings.port, 'Could not reach TORI Desktop.');
        return;
      }
      if (res.status === 'ok' && res.authenticated) {
        setStatus('connected', res.port || currentSettings.port);
        showNotice('Connected to TORI Desktop', 'ok');
        loadActiveTabMedia();
      } else if (res.status === 'unpaired' || res.status === 'disconnected') {
        setStatus('disconnected', res.port || currentSettings.port, res.message);
        showNotice(res.message || 'Pairing required', 'error');
      } else {
        setStatus('unavailable', res.port || currentSettings.port, res.message);
        showNotice(res.message || 'TORI Desktop is unavailable', 'error');
      }
    });
  }

  btnReconnect.addEventListener('click', triggerReconnect);
  statusPill.addEventListener('click', () => {
    if (currentConnState === 'disconnected' || currentConnState === 'unavailable') {
      triggerReconnect();
    } else {
      setStatus('connecting', currentSettings.port);
      checkLiveConnection();
    }
  });

  checkLiveConnection();
  const statusPollTimer = setInterval(() => {
    if (currentConnState !== 'reconnecting') {
      checkLiveConnection();
    }
  }, 3500);

  // Open TORI Desktop cleanly (restore if running, start via Native Messaging if closed, never duplicate)
  openBtn.addEventListener('click', () => {
    if (openInFlight) return;
    openInFlight = true;
    openBtn.disabled = true;
    openLabel.textContent = 'Opening…';

    let settled = false;
    const resetOpenUi = () => {
      openInFlight = false;
      openBtn.disabled = false;
      openLabel.textContent = 'Open Tori';
    };

    const timeoutGuard = setTimeout(() => {
      if (settled) return;
      settled = true;
      resetOpenUi();
      showNotice('Timed out waiting for TORI Desktop. Make sure TORI is installed.', 'error', 4000);
    }, 10000);

    chrome.runtime.sendMessage({ action: 'SHOW_DESKTOP' }, (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutGuard);
      resetOpenUi();

      const err = chrome.runtime.lastError;
      if (err) {
        showNotice(err.message || 'Could not reach background extension worker.', 'error', 4000);
        return;
      }
      if (res && res.status === 'ok') {
        checkLiveConnection();
        window.close();
      } else {
        const msg = res?.message || res?.error || 'Could not launch or reach TORI Desktop.';
        setStatus('unavailable', currentSettings.port, msg);
        showNotice(msg, 'error', 4500);
      }
    });
  });

  // Settings action -> opens Options page cleanly
  gearBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'OPEN_OPTIONS' }, () => {
      window.close();
    });
  });

  // Genuine active-tab media inspection (shown ONLY when real media exists)
  function sendDownloadWithTimeout(payload, btn, onDoneLabel) {
    if (btn.disabled) return;
    btn.disabled = true;
    const prevText = btn.textContent;
    btn.textContent = 'Sending…';

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      btn.disabled = false;
      btn.textContent = 'Retry';
      showNotice('Download request timed out waiting for TORI.', 'error', 3500);
    }, 15000);

    chrome.runtime.sendMessage(payload, (dlRes) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const err = chrome.runtime.lastError;
      if (err) {
        btn.disabled = false;
        btn.textContent = prevText;
        showNotice(err.message || 'Extension communication failed', 'error', 3500);
        return;
      }

      if (dlRes && dlRes.status === 'ok' && dlRes.job_id) {
        btn.textContent = onDoneLabel;
        btn.classList.add('ok');
        showNotice(`Queued in TORI (${dlRes.filename || payload.filename || 'media'})`, 'ok');
      } else if (dlRes && dlRes.status === 'already_exists') {
        btn.disabled = false;
        btn.textContent = 'Active';
        showNotice('Already in TORI download queue', 'info');
      } else {
        btn.disabled = false;
        btn.textContent = 'Retry';
        showNotice(dlRes?.message || dlRes?.error || 'Download failed', 'error', 3500);
      }
    });
  }

  function renderResolvedItems(meta, tab) {
    const formats = Array.isArray(meta?.formats) ? meta.formats : [];
    if (formats.length === 0) {
      mediaSection.hidden = true;
      return;
    }
    mediaSection.hidden = false;
    mediaCountHeader.textContent = `Detected formats · ${formats.length}`;
    const topFormats = formats.slice(0, 4);

    mediaList.innerHTML = topFormats
      .map((fmt, idx) => {
        const isAudio = !fmt.has_video && fmt.has_audio;
        const sizeTxt = formatFilesizeDisplay(fmt, meta.duration_seconds);
        const sub = `${(fmt.container || 'mp4').toUpperCase()} · ${sizeTxt}`;
        return `
        <div class="row">
          ${chipIcon(isAudio)}
          <div class="t">
            <b>${escapeHtml(fmt.resolution_label || meta.title || 'Media')}</b>
            <span class="s">${escapeHtml(sub)}</span>
          </div>
          <button type="button" class="btn mb" data-fidx="${idx}">Download</button>
        </div>`;
      })
      .join('');

    mediaList.querySelectorAll('button[data-fidx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.fidx, 10);
        const sel = topFormats[idx];
        if (!sel) return;
        const safeTitle = String(meta.title || 'media').replace(/[\\/:*?"<>|]/g, '').trim() || 'media';
        sendDownloadWithTimeout(
          {
            action: 'START_MEDIA_DOWNLOAD',
            url: meta.source_url || tab.url,
            direct_stream_url: sel.direct_stream_url || null,
            format_id: sel.format_id,
            filename: `${safeTitle}.${sel.container || 'mp4'}`,
            priority: 'high',
            page_url: tab.url,
            thumbnail_url: meta.thumbnail_url || null,
            user_agent: navigator.userAgent,
          },
          btn,
          'Queued'
        );
      });
    });
  }

  function renderDirectCandidates(items, tab) {
    const usable = (items || []).filter((c) => c && !c.is_segment && c.type !== 'segment' && c.url);
    if (usable.length === 0) {
      mediaSection.hidden = true;
      return;
    }
    mediaSection.hidden = false;
    mediaCountHeader.textContent = `Media on this page · ${usable.length}`;
    const topItems = usable.slice(0, 4);

    mediaList.innerHTML = topItems
      .map((item, idx) => {
        const isAudio =
          item.type === 'audio' || (item.content_type && item.content_type.startsWith('audio/'));
        const sizeStr = item.size_bytes ? ` · ${formatBytes(item.size_bytes)}` : '';
        return `
        <div class="row">
          ${chipIcon(isAudio)}
          <div class="t">
            <b>${escapeHtml(item.filename || 'media_video')}</b>
            <span class="s">${escapeHtml((item.format || 'MP4') + sizeStr)}</span>
          </div>
          <button type="button" class="btn mb" data-idx="${idx}">Download</button>
        </div>`;
      })
      .join('');

    mediaList.querySelectorAll('button[data-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const target = topItems[idx];
        if (!target) return;
        sendDownloadWithTimeout(
          {
            action: 'START_DOWNLOAD',
            url: target.url,
            filename: target.filename,
            priority: 'high',
            page_url: tab?.url || '',
            thumbnail_url: target.thumbnail_url || null,
            user_agent: navigator.userAgent,
          },
          btn,
          'Queued'
        );
      });
    });
  }

  async function resolveActiveTab() {
    const qp = new URLSearchParams(window.location.search).get('tabId');
    if (qp && /^\d+$/.test(qp)) {
      try {
        const targetTab = await chrome.tabs.get(parseInt(qp, 10));
        if (targetTab && targetTab.url && targetTab.url.startsWith('http')) {
          return targetTab;
        }
      } catch (_) {}
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function loadActiveTabMedia() {
    try {
      const tab = await resolveActiveTab();
      if (!tab || !tab.id || !tab.url || !tab.url.startsWith('http')) {
        mediaSection.hidden = true;
        return;
      }

      chrome.tabs.sendMessage(tab.id, { action: 'GET_ACTIVE_MEDIA_INFO' }, (info) => {
        if (!chrome.runtime.lastError && info?.ok && info.resolvedMeta?.formats?.length > 0) {
          renderResolvedItems(info.resolvedMeta, tab);
          return;
        }
        chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA', tabId: tab.id }, (res) => {
          if (chrome.runtime.lastError || !res) {
            mediaSection.hidden = true;
            return;
          }
          renderDirectCandidates(res.media || [], tab);
        });
      });
    } catch {
      mediaSection.hidden = true;
    }
  }

  btnRefreshMedia.addEventListener('click', async () => {
    const tab = await resolveActiveTab().catch(() => null);
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { action: 'TRIGGER_RESOLVE_MEDIA', force_refresh: true }, () => {
        if (chrome.runtime.lastError) {
          /* content script may not be on restricted page */
        }
      });
      setTimeout(loadActiveTabMedia, 400);
    }
  });

  loadActiveTabMedia();

  window.addEventListener('pagehide', () => {
    clearInterval(statusPollTimer);
    clearTimeout(noticeTimer);
    mqlDark.removeEventListener('change', onMqlChange);
  });
});
