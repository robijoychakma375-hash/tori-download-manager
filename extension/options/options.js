(() => {
  'use strict';

  const DEFAULT_EXTS = [
    'zip', 'rar', '7z', 'iso', 'tar', 'gz', 'bz2', 'xz',
    'exe', 'msi', 'dmg', 'bin',
    'pdf', 'epub',
    'mkv', 'mp4', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v',
    'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus',
  ];

  const DEFAULT_SETTINGS = {
    port: 6800,
    key: '',
    auto: true,
    cap: true,
    min: 1,
    ask: false,
    alt: true,
    incog: false,
    pill: true,
    pos: 'Top right',
    picker: true,
    kind: 'Video',
    fmt: 'Best available',
    audio: true,
    badge: true,
    theme: 'light',
    accent: 'indigo',
    sites: [],
    types: [...DEFAULT_EXTS],
  };

  let cur = { ...DEFAULT_SETTINGS };
  let activeTab = 'conn';
  let saveTimer = null;
  let sysMql = null;
  let lastNativeHostState = null;

  const $ = (id) => document.getElementById(id);

  // ---------- Theme & Accent ----------
  function resolveTheme(mode) {
    if (mode === 'dark') return 'dark';
    if (mode === 'system') {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    return 'light';
  }

  function applyAppearance(themeMode, accent) {
    const resolvedTheme = resolveTheme(themeMode);
    const resolvedAccent = ['indigo', 'ocean', 'emerald', 'rose'].includes(accent) ? accent : 'indigo';
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.accent = resolvedAccent;
  }

  function bindSystemThemeWatcher() {
    if (!window.matchMedia || sysMql) return;
    sysMql = window.matchMedia('(prefers-color-scheme: dark)');
    const onSysChange = () => {
      if (cur.theme === 'system') {
        applyAppearance('system', cur.accent);
      }
    };
    if (typeof sysMql.addEventListener === 'function') {
      sysMql.addEventListener('change', onSysChange);
    } else if (typeof sysMql.addListener === 'function') {
      sysMql.addListener(onSysChange);
    }
  }

  // ---------- Navigation Tabs ----------
  const tabs = Array.from(document.querySelectorAll('#nav .ni[role="tab"]'));
  const panels = Array.from(document.querySelectorAll('.opt-panel[role="tabpanel"]'));

  function setActiveTab(name, focusTab = false) {
    const valid = tabs.some((t) => t.dataset.tab === name);
    activeTab = valid ? name : 'conn';
    tabs.forEach((tab) => {
      const isSelected = tab.dataset.tab === activeTab;
      tab.classList.toggle('on', isSelected);
      tab.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      tab.setAttribute('tabindex', isSelected ? '0' : '-1');
      if (isSelected && focusTab) tab.focus();
    });
    panels.forEach((panel) => {
      const match = panel.dataset.panel === activeTab;
      if (match) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    });
  }

  tabs.forEach((tab, idx) => {
    tab.addEventListener('click', () => setActiveTab(tab.dataset.tab));
    tab.addEventListener('keydown', (e) => {
      let next = -1;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next >= 0) {
        e.preventDefault();
        setActiveTab(tabs[next].dataset.tab, true);
      }
    });
  });

  // ---------- Storage & Save Indicator ----------
  function showSaved(label = 'Saved') {
    const el = $('sv');
    if (!el) return;
    el.textContent = label;
    el.classList.add('on');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => el.classList.remove('on'), 1500);
  }

  function persistSettings(patch, toast = 'Saved') {
    cur = { ...cur, ...patch };
    applyAppearance(cur.theme, cur.accent);
    chrome.storage.local.set(
      {
        tori_settings: cur,
        tori_theme: cur.theme,
        tori_accent: cur.accent,
      },
      () => {
        if (!chrome.runtime.lastError) {
          showSaved(toast);
        }
      }
    );
  }

  function sendRuntimeMsg(payload, timeoutMs = 12000) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ status: 'timeout', error: 'Request timed out' });
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(payload, (res) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({
              status: 'error',
              error: chrome.runtime.lastError.message || 'Extension communication failed',
            });
            return;
          }
          resolve(res || {});
        });
      } catch (err) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ status: 'error', error: String(err) });
        }
      }
    });
  }

  // ---------- Live 5-State Connection UI ----------
  function setConnFeedback(text, tone = '') {
    const el = $('conn-msg');
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      el.className = 'inline-note';
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.className = tone ? `inline-note ${tone}` : 'inline-note';
  }

  function renderConnectionState(state, detail = {}) {
    const dot = $('cdot');
    const sdot = $('sdot');
    const stxt = $('stxt');
    const tit = $('ctit');
    const sub = $('csub');
    const cdEnd = $('cd-end');
    const cdVer = $('cd-ver');
    const cdLat = $('cd-lat');
    const cdNat = $('cd-nat');
    const abDesk = $('ab-desk');

    const activePort = detail.port || cur.port || 6800;
    if (cdEnd) cdEnd.textContent = `127.0.0.1:${activePort}`;

    if (typeof detail.nativeHost === 'boolean') {
      lastNativeHostState = detail.nativeHost;
    }
    if (cdNat) {
      cdNat.textContent =
        lastNativeHostState === true
          ? 'Reachable'
          : lastNativeHostState === false
            ? 'Not registered / Error'
            : 'Standby (on-demand)';
    }

    let cls = 'wait';
    let label = 'Connecting…';
    let desc = 'Probing local Tori Desktop HTTP bridge…';

    if (state === 'connected') {
      cls = 'ok';
      label = 'Connected';
      desc = `Authenticated with Tori Desktop${detail.version ? ` v${detail.version}` : ''} on port ${activePort}.`;
      if (cdVer) cdVer.textContent = detail.version ? `v${detail.version}` : 'Online';
      if (cdLat) cdLat.textContent = typeof detail.latency === 'number' ? `${detail.latency} ms` : 'OK';
    } else if (state === 'reconnecting') {
      cls = 'wait';
      label = 'Reconnecting…';
      desc = 'Scanning local bridge ports and refreshing pairing state…';
    } else if (state === 'disconnected') {
      cls = 'off';
      label = 'Disconnected';
      desc = detail.message || 'Tori Desktop is running, but pairing or API key authentication is required.';
      if (cdVer) cdVer.textContent = detail.version ? `v${detail.version}` : 'Running';
      if (cdLat) cdLat.textContent = typeof detail.latency === 'number' ? `${detail.latency} ms` : 'Unpaired';
    } else if (state === 'unavailable') {
      cls = 'off';
      label = 'Desktop unavailable';
      desc = detail.message || 'Tori Desktop is not responding on localhost. Click Open Tori to launch or restore it.';
      if (cdVer) cdVer.textContent = 'Offline';
      if (cdLat) cdLat.textContent = '—';
    } else {
      cls = 'wait';
      label = 'Connecting…';
      if (cdVer) cdVer.textContent = '…';
      if (cdLat) cdLat.textContent = '…';
    }

    if (dot) dot.className = `dot lg ${cls}`;
    if (sdot) sdot.className = `dot ${cls}`;
    if (stxt) stxt.textContent = label;
    if (tit) tit.textContent = label;
    if (sub) sub.textContent = desc;
    if (abDesk) abDesk.textContent = detail.version ? `${label} (v${detail.version})` : label;
  }

  async function refreshConnection(passive = true) {
    renderConnectionState(passive ? 'connecting' : 'reconnecting', { port: cur.port });
    const res = await sendRuntimeMsg({
      action: passive ? 'PING_DESKTOP' : 'RECONNECT_DESKTOP',
      port: cur.port,
      key: cur.key,
      passive,
    });

    if (res.status === 'ok') {
      if (res.token && res.token !== cur.key) {
        cur.key = res.token;
        const keyInput = $('key');
        if (keyInput) keyInput.value = res.token;
        persistSettings({ key: res.token, port: res.port || cur.port }, 'Paired');
      } else if (res.port && res.port !== cur.port) {
        cur.port = res.port;
        const portInput = $('port');
        if (portInput) portInput.value = res.port;
        persistSettings({ port: res.port }, 'Port synced');
      }
      renderConnectionState('connected', res);
      if (!passive) setConnFeedback('Reconnected to Tori Desktop successfully.', 'ok');
      return;
    }

    if (res.status === 'unpaired' || res.connectionState === 'disconnected' || res.desktop_running) {
      renderConnectionState('disconnected', res);
      if (!passive) {
        setConnFeedback(res.message || 'Tori Desktop requires pairing. Click Auto-Pair or check the API key.', 'err');
      }
      return;
    }

    renderConnectionState('unavailable', res);
    if (!passive) {
      setConnFeedback(res.message || res.error || 'Unable to reach Tori Desktop.', 'err');
    }
  }

  // ---------- Render Dynamic Lists ----------
  function createRemoveSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M4.5 4.5l7 7M11.5 4.5l-7 7');
    svg.appendChild(p);
    return svg;
  }

  function renderExts() {
    const root = $('exts');
    if (!root) return;
    root.textContent = '';
    const list = Array.isArray(cur.types) ? cur.types : [];
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No extensions configured. Add extensions like .zip or .mkv above.';
      root.appendChild(empty);
      return;
    }

    list.forEach((rawExt) => {
      const ext = String(rawExt || '').toLowerCase().replace(/^\./, '').trim();
      if (!ext) return;
      const chip = document.createElement('span');
      chip.className = 'chip';
      const txt = document.createElement('span');
      txt.textContent = `.${ext}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip-rm';
      btn.setAttribute('aria-label', `Remove .${ext}`);
      btn.appendChild(createRemoveSvg());
      btn.addEventListener('click', () => {
        const next = (cur.types || [])
          .map((i) => String(i || '').toLowerCase().replace(/^\./, '').trim())
          .filter((item) => item && item !== ext);
        persistSettings({ types: next }, `Removed .${ext}`);
        renderExts();
      });
      chip.append(txt, btn);
      root.appendChild(chip);
    });
  }

  function normalizeDomain(raw) {
    let v = String(raw || '').trim().toLowerCase();
    if (!v) return '';
    v = v.replace(/^[a-z]+:\/\//i, '');
    v = v.split(/[/?#]/)[0];
    v = v.replace(/:\d+$/, '');
    v = v.replace(/^www\./, '');
    if (!v || /\s/.test(v) || !/^[a-z0-9.-]+$/i.test(v)) return '';
    if (!v.includes('.') && v !== 'localhost') return '';
    return v;
  }

  function renderSites() {
    const root = $('sites');
    const countEl = $('site-count');
    if (!root) return;
    root.textContent = '';
    const list = Array.isArray(cur.sites) ? cur.sites : [];
    if (countEl) {
      countEl.textContent = list.length === 1 ? '1 domain excluded' : `${list.length} domains excluded`;
    }

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No excluded sites. Download capture and media overlays remain active everywhere.';
      root.appendChild(empty);
      return;
    }

    list.forEach((host) => {
      const row = document.createElement('div');
      row.className = 'site-row';
      const span = document.createElement('span');
      span.className = 'site-host mono';
      span.textContent = host;
      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn sm';
      rmBtn.textContent = 'Remove';
      rmBtn.setAttribute('aria-label', `Remove ${host}`);
      rmBtn.addEventListener('click', () => {
        const next = (cur.sites || []).filter((s) => s !== host);
        persistSettings({ sites: next }, `Removed ${host}`);
        renderSites();
      });
      row.append(span, rmBtn);
      root.appendChild(row);
    });
  }

  function renderThemeRadios() {
    document.querySelectorAll('.th-opt[data-theme-val]').forEach((btn) => {
      const checked = btn.dataset.themeVal === cur.theme;
      btn.setAttribute('aria-checked', checked ? 'true' : 'false');
    });
  }

  function renderAccentRadios() {
    document.querySelectorAll('.ac-sw[data-accent-val]').forEach((btn) => {
      const checked = btn.dataset.accentVal === cur.accent;
      btn.setAttribute('aria-checked', checked ? 'true' : 'false');
    });
  }

  function updateCustomPosStatus() {
    chrome.storage.local.get('tori_custom_overlay_pos', (res) => {
      const el = $('pos-status');
      const btn = $('reset-pos');
      if (!el) return;
      const saved = res && res.tori_custom_overlay_pos;
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
        el.textContent = `Custom dragged position saved (${Math.round(saved.x)}px, ${Math.round(saved.y)}px).`;
        if (btn) btn.disabled = false;
      } else {
        el.textContent = `Anchored to ${cur.pos || 'Top right'} corner.`;
        if (btn) btn.disabled = false;
      }
    });
  }

  function populateForm() {
    const manifestVer = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '1.0.9';
    if ($('nav-ver')) $('nav-ver').textContent = `v${manifestVer}`;
    if ($('ab-ver')) $('ab-ver').textContent = manifestVer;
    if ($('ab-ver2')) $('ab-ver2').textContent = manifestVer;

    const ua = navigator.userAgent || '';
    let browserName = 'Google Chrome MV3';
    if (/Edg\//.test(ua)) browserName = 'Microsoft Edge MV3';
    else if (/Firefox\//.test(ua)) browserName = 'Mozilla Firefox MV3';
    if ($('ab-browser')) $('ab-browser').textContent = browserName;

    const checks = ['auto', 'cap', 'ask', 'alt', 'incog', 'pill', 'picker', 'audio', 'badge'];
    checks.forEach((k) => {
      const el = $(k);
      if (el) el.checked = Boolean(cur[k]);
    });

    if ($('port')) $('port').value = cur.port || 6800;
    if ($('key')) $('key').value = cur.key || '';
    if ($('min')) $('min').value = Number.isFinite(Number(cur.min)) ? cur.min : 1;
    if ($('pos')) $('pos').value = cur.pos || 'Top right';
    if ($('kind')) $('kind').value = cur.kind || 'Video';
    if ($('fmt')) $('fmt').value = cur.fmt || 'Best available';

    applyAppearance(cur.theme, cur.accent);
    renderThemeRadios();
    renderAccentRadios();
    renderExts();
    renderSites();
    updateCustomPosStatus();
  }

  // ---------- Event Wiring ----------
  function bindInputs() {
    ['auto', 'cap', 'ask', 'alt', 'incog', 'pill', 'picker', 'audio', 'badge'].forEach((k) => {
      const el = $(k);
      if (!el) return;
      el.addEventListener('change', () => {
        persistSettings({ [k]: el.checked });
      });
    });

    ['pos', 'kind', 'fmt'].forEach((k) => {
      const el = $(k);
      if (!el) return;
      el.addEventListener('change', () => {
        persistSettings({ [k]: el.value });
        if (k === 'pos') updateCustomPosStatus();
      });
    });

    const portEl = $('port');
    if (portEl) {
      portEl.addEventListener('change', () => {
        const parsed = Number.parseInt(portEl.value, 10);
        if (!Number.isFinite(parsed) || parsed < 1024 || parsed > 65535) {
          portEl.value = cur.port || 6800;
          setConnFeedback('Port must be between 1024 and 65535.', 'err');
          return;
        }
        setConnFeedback('');
        persistSettings({ port: parsed }, 'Port updated');
        refreshConnection(true);
      });
    }

    const minEl = $('min');
    if (minEl) {
      minEl.addEventListener('change', () => {
        const val = Math.max(0, Number.parseInt(minEl.value, 10) || 0);
        minEl.value = val;
        persistSettings({ min: val });
      });
    }

    const keyEl = $('key');
    if (keyEl) {
      keyEl.addEventListener('change', () => {
        persistSettings({ key: keyEl.value.trim() }, 'API Key updated');
        refreshConnection(true);
      });
    }

    const toggleKeyBtn = $('toggle-key');
    if (toggleKeyBtn && keyEl) {
      toggleKeyBtn.addEventListener('click', () => {
        const isPw = keyEl.type === 'password';
        keyEl.type = isPw ? 'text' : 'password';
        toggleKeyBtn.textContent = isPw ? 'Hide' : 'Show';
      });
    }

    const pasteBtn = $('paste-btn');
    if (pasteBtn && keyEl) {
      pasteBtn.addEventListener('click', async () => {
        try {
          const text = await navigator.clipboard.readText();
          const cleaned = String(text || '').trim();
          if (!cleaned) {
            setConnFeedback('Clipboard is empty.', 'err');
            return;
          }
          keyEl.value = cleaned;
          persistSettings({ key: cleaned }, 'API Key pasted');
          setConnFeedback('API Key pasted from clipboard. Verifying connection…');
          refreshConnection(true);
        } catch (_) {
          setConnFeedback('Clipboard read permission was not granted. Paste directly into the field.', 'err');
          keyEl.focus();
        }
      });
    }

    const pairBtn = $('pair-btn');
    if (pairBtn) {
      pairBtn.addEventListener('click', async () => {
        pairBtn.disabled = true;
        const orig = pairBtn.textContent;
        pairBtn.textContent = 'Pairing…';
        setConnFeedback('Requesting pairing token from Tori Desktop…');
        const res = await sendRuntimeMsg({ action: 'INITIATE_PAIRING' });
        pairBtn.disabled = false;
        pairBtn.textContent = orig;
        if (res && res.ok && res.token) {
          if (keyEl) keyEl.value = res.token;
          if (portEl && res.port) portEl.value = res.port;
          persistSettings({ key: res.token, port: res.port || cur.port }, 'Paired');
          setConnFeedback('Paired automatically with Tori Desktop.', 'ok');
          refreshConnection(true);
        } else {
          setConnFeedback((res && (res.error || res.message)) || 'Auto-pairing failed. Make sure Tori Desktop is open.', 'err');
          refreshConnection(true);
        }
      });
    }

    const recBtn = $('crec');
    if (recBtn) {
      recBtn.addEventListener('click', async () => {
        recBtn.disabled = true;
        setConnFeedback('');
        await refreshConnection(false);
        recBtn.disabled = false;
      });
    }

    async function handleOpenTori(btnEl) {
      if (!btnEl) return;
      btnEl.disabled = true;
      const prev = btnEl.textContent;
      btnEl.textContent = 'Opening…';
      const res = await sendRuntimeMsg({ action: 'SHOW_DESKTOP' });
      btnEl.disabled = false;
      btnEl.textContent = prev;
      if (res && res.status === 'ok') {
        setConnFeedback('Tori Desktop window opened.', 'ok');
        refreshConnection(true);
      } else {
        setConnFeedback((res && (res.message || res.error)) || 'Failed to open Tori Desktop.', 'err');
      }
    }

    if ($('copen')) $('copen').addEventListener('click', () => handleOpenTori($('copen')));
    if ($('ab-open')) $('ab-open').addEventListener('click', () => handleOpenTori($('ab-open')));
    if ($('ab-test')) {
      $('ab-test').addEventListener('click', async () => {
        setActiveTab('conn');
        await refreshConnection(false);
      });
    }

    // Extension chips form
    const extForm = $('ext-form');
    const extInput = $('ext-input');
    const extErr = $('ext-err');
    if (extForm && extInput) {
      extForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (extErr) extErr.hidden = true;
        let raw = extInput.value.trim().toLowerCase();
        if (!raw) return;
        const parts = raw.split(/[\s,;]+/).filter(Boolean);
        const current = (Array.isArray(cur.types) ? cur.types : [])
          .map((t) => String(t || '').toLowerCase().replace(/^\./, '').trim())
          .filter(Boolean);
        let added = 0;
        for (const p of parts) {
          const clean = p.replace(/^\.+/, '');
          if (!/^[a-z0-9]{1,12}$/i.test(clean)) {
            if (extErr) {
              extErr.textContent = `Invalid extension "${p}". Use alphanumeric characters like mkv or zip.`;
              extErr.hidden = false;
            }
            return;
          }
          if (!current.includes(clean)) {
            current.push(clean);
            added++;
          }
        }
        extInput.value = '';
        if (added > 0) {
          persistSettings({ types: current }, `Added ${added} extension${added > 1 ? 's' : ''}`);
          renderExts();
        }
      });
    }

    if ($('ext-reset')) {
      $('ext-reset').addEventListener('click', () => {
        persistSettings({ types: [...DEFAULT_EXTS] }, 'Extensions reset');
        renderExts();
      });
    }

    // Excluded sites form
    const siteForm = $('site-form');
    const siteInput = $('site-input');
    const siteErr = $('site-err');
    if (siteForm && siteInput) {
      siteForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (siteErr) siteErr.hidden = true;
        const host = normalizeDomain(siteInput.value);
        if (!host) {
          if (siteErr) {
            siteErr.textContent = 'Enter a valid domain name such as example.com';
            siteErr.hidden = false;
          }
          return;
        }
        const current = Array.isArray(cur.sites) ? [...cur.sites] : [];
        if (current.includes(host)) {
          if (siteErr) {
            siteErr.textContent = `${host} is already in the excluded list.`;
            siteErr.hidden = false;
          }
          return;
        }
        current.push(host);
        siteInput.value = '';
        persistSettings({ sites: current }, `Excluded ${host}`);
        renderSites();
      });
    }

    // Reset dragged overlay position
    if ($('reset-pos')) {
      $('reset-pos').addEventListener('click', () => {
        chrome.storage.local.remove('tori_custom_overlay_pos', () => {
          updateCustomPosStatus();
          showSaved('Position reset');
        });
      });
    }

    // Theme radios
    document.querySelectorAll('.th-opt[data-theme-val]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.themeVal;
        persistSettings({ theme: val }, `Theme: ${val}`);
        renderThemeRadios();
      });
    });

    // Accent radios
    document.querySelectorAll('.ac-sw[data-accent-val]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.accentVal;
        persistSettings({ accent: val }, `Accent: ${val}`);
        renderAccentRadios();
      });
    });

    // Restore all defaults
    if ($('ab-reset-all')) {
      $('ab-reset-all').addEventListener('click', () => {
        const preservedKey = cur.key || '';
        const preservedPort = cur.port || 6800;
        const reset = {
          ...DEFAULT_SETTINGS,
          port: preservedPort,
          key: preservedKey,
          types: [...DEFAULT_EXTS],
          sites: [],
        };
        persistSettings(reset, 'Defaults restored');
        populateForm();
      });
    }
  }

  // ---------- Init ----------
  function init() {
    bindSystemThemeWatcher();

    // Respect hash navigation if opened via #sites, #look, etc.
    const hashTab = (window.location.hash || '').replace('#', '').trim();
    if (hashTab) {
      setActiveTab(hashTab);
    }

    chrome.storage.local.get(['tori_settings', 'tori_theme', 'tori_accent'], (res) => {
      const saved = (res && res.tori_settings) || {};
      cur = {
        ...DEFAULT_SETTINGS,
        ...saved,
        sites: Array.isArray(saved.sites) ? saved.sites : [...DEFAULT_SETTINGS.sites],
        types: Array.isArray(saved.types) ? saved.types : [...DEFAULT_EXTS],
      };
      if (!saved.theme && res && res.tori_theme) cur.theme = res.tori_theme;
      if (!saved.accent && res && res.tori_accent) cur.accent = res.tori_accent;

      populateForm();
      bindInputs();
      refreshConnection(true);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
