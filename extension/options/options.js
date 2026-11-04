/**
 * TORI Download Manager — Extension Options Controller
 * Faithful implementation of Design Source B (design/extension-options/tori-extension-options.html)
 * with real Native Messaging engine integration and chrome.storage persistence.
 */

const P = {
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  dl: 'M12 4v10M8 10l4 4 4-4M5 19h14',
  play: 'M9 6.5v11l9-5.5z',
  globe: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  half: 'M12 3a9 9 0 100 18zM12 3v18',
  info: 'M12 3a9 9 0 100 18zM12 11v5M12 8h.01',
  ck: 'M5 12l5 5 9-10',
};

const N = [
  ['conn', 'Connection', '#6366f1', 'link'],
  ['cap', 'Capture', '#22b45a', 'dl'],
  ['media', 'Media', '#ff453a', 'play'],
  ['sites', 'Sites', '#3b82f6', 'globe'],
  ['app', 'Appearance', '#bf5af2', 'half'],
  ['about', 'About', '#8e8e93', 'info'],
];

const DEFAULT_SETTINGS = {
  port: 6800,
  key: '',
  auto: true,
  cap: true,
  min: 1,
  ask: false,
  alt: true,
  types: ['zip', 'rar', '7z', 'iso', 'exe', 'dmg', 'pdf', 'mp4', 'mp3'],
  incog: false,
  pill: true,
  pos: 'Top right',
  audio: true,
  fmt: 'Best available',
  kind: 'Video',
  picker: true,
  sites: ['docs.google.com', 'mail.google.com', 'github.com'],
  theme: 'light',
  badge: true,
};

let S = { ...DEFAULT_SETTINGS };
let sec = 'conn';
let testState = 'wait';
let testLatency = 0;
let testEngineVer = '2.0.0';
let testPort = 6800;

const $ = (s) => document.querySelector(s);
const svg = (d) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
const tg = (k) => `<label class="swl"><input type="checkbox" data-k="${k}" ${S[k] ? 'checked' : ''}><span class="sw-track"><span class="sw-knob"></span></span></label>`;
const sr = (t, s, c, cls = '') => `<div class="sr ${cls}"><div><b>${t}</b><span class="sub">${s}</span></div><div class="sc">${c}</div></div>`;
const sel = (k, o) => `<select class="fi" data-k="${k}">${o.map((x) => `<option ${S[k] === x ? 'selected' : ''}>${x}</option>`).join('')}</select>`;

const V = {
  conn: () => `
    <h2>Connection</h2>
    <div class="sub0">Connect this extension to the Tori Download Manager app on your computer.</div>
    <div class="card">
      <div class="stt ${testState === 'bad' ? 'bad' : testState === 'wait' ? 'wait' : testState === 'unpaired' ? 'unpaired' : ''}">
        <span class="big"><i></i></span>
        <div style="flex:1">
          <b style="font-size:14px">${
            testState === 'bad'
              ? 'Can’t reach Tori'
              : testState === 'wait'
              ? 'Connecting…'
              : testState === 'unpaired'
              ? 'Pairing Required'
              : 'Connected to Tori'
          }</b>
          <span class="sub" style="display:block;color:var(--mut);font-size:11.5px;margin-top:2px">${
            testState === 'bad'
              ? `Nothing is listening on 127.0.0.1:${S.port}. Is Tori Download Manager running?`
              : testState === 'wait'
              ? `Checking 127.0.0.1:${S.port}…`
              : testState === 'unpaired'
              ? `Tori is listening on 127.0.0.1:${testPort}. Click 'Pair with Tori' to pair automatically.`
              : `Tori v${testEngineVer} · 127.0.0.1:${testPort} · ${testLatency} ms · Paired`
          }</span>
        </div>
        ${
          testState === 'unpaired'
            ? '<button class="btn pri" data-a="pair" style="margin-right:8px">Pair with Tori</button>'
            : ''
        }
        <button class="btn def" data-a="test">Test connection</button>
      </div>
    </div>
    <div class="card">
      ${sr('Server Address', 'The Tori app runs on this computer only', '<input class="fi" value="127.0.0.1" disabled style="width:130px">')}
      ${sr('Server Port', 'Same as Browser Integration → Server Port in Tori', `<input class="fi" type="number" data-k="port" value="${S.port}" style="width:90px">`)}
      ${sr(
        'API Key',
        'Auto-paired with Tori Desktop',
        `<input class="fi" id="key" type="password" data-k="key" value="${escapeHtml(S.key)}" style="width:200px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px"><button class="btn" data-a="show">Show</button><button class="btn" data-a="pair" title="Pair automatically with desktop">Auto-pair</button><button class="btn" data-a="paste">Paste</button>`
      )}
      ${sr('Connect automatically', 'Connect when the browser starts', tg('auto'))}
    </div>`,

  cap: () => `
    <h2>Capture</h2>
    <div class="sub0">Choose which downloads are sent to Tori.</div>
    <div class="card">
      ${sr('Capture downloads', 'Send browser downloads to Tori', tg('cap'))}
    </div>
    <div class="card ${S.cap ? '' : 'dis'}" style="${S.cap ? '' : 'opacity:.45;pointer-events:none'}">
      ${sr(
        'Minimum file size',
        'Smaller files stay in the browser',
        `<input class="fi" type="number" data-k="min" value="${S.min}" min="0" style="width:70px"><span class="sub" style="margin:0">MB</span>`
      )}
      ${sr('Ask before sending to Tori', 'Show a confirmation for each download', tg('ask'))}
      ${sr('Hold Alt to skip Tori', 'Download in the browser while holding Alt', tg('alt'))}
      ${sr('Capture in private windows', 'Off by default for privacy', tg('incog'))}
      <div class="sr" style="display:block">
        <b>File types</b>
        <span class="sub">Only these file types are captured</span>
        <div class="chips">
          ${S.types
            .map(
              (t, i) =>
                `<span class="chp">.${escapeHtml(t)}<u data-a="rt" data-i="${i}" title="Remove">×</u></span>`
            )
            .join('')}
        </div>
        <div class="add" style="padding-top:0">
          <input class="fi" id="ty" placeholder="Add extension, e.g. torrent">
          <button class="btn" data-a="at">Add</button>
        </div>
      </div>
    </div>`,

  media: () => `
    <h2>Media</h2>
    <div class="sub0">Control the download button that appears on videos.</div>
    <div class="card">
      ${sr('Show download button on videos', 'The “Download video” pill over the player', tg('pill'))}
    </div>
    <div class="card ${S.pill ? '' : 'dis'}" style="${S.pill ? '' : 'opacity:.45;pointer-events:none'}">
      ${sr(
        'Button position',
        'Where the pill appears on the video',
        sel('pos', ['Top right', 'Top left', 'Bottom right', 'Bottom left'])
      )}
      ${sr('Always show format picker', 'Choose quality each time instead of using the default', tg('picker'))}
      ${sr('Default type', 'Used when the picker is off', sel('kind', ['Video', 'Audio only']))}
      ${sr(
        'Default quality',
        'Picks the closest available format',
        sel('fmt', ['Best available', '1080p', '720p', '480p', '360p'])
      )}
      ${sr('Detect audio-only media', 'Show music and podcasts too', tg('audio'))}
    </div>`,

  sites: () => `
    <h2>Sites</h2>
    <div class="sub0">Tori will not capture downloads or show the video button on these sites.</div>
    <div class="card ls">
      ${
        S.sites.length
          ? S.sites
              .map(
                (d, i) => `
          <div class="sr">
            <span class="nm"><i class="ft" style="--c:#3b82f6">${svg(P.globe)}</i>${escapeHtml(d)}</span>
            <button class="x" data-a="rs" data-i="${i}" title="Remove site">×</button>
          </div>`
              )
              .join('')
          : '<div class="sr"><span class="sub">No excluded sites</span></div>'
      }
    </div>
    <div class="add">
      <input class="fi" id="st" placeholder="Add a site, e.g. example.com">
      <button class="btn def" data-a="as">Add site</button>
    </div>`,

  app: () => `
    <h2>Appearance</h2>
    <div class="sub0">How the extension looks.</div>
    <div class="card">
      ${sr(
        'Theme',
        'Light, dark, or follow the browser',
        `<select class="fi" data-k="theme">${[
          ['light', 'Light'],
          ['dark', 'Dark'],
          ['system', 'System (auto)'],
        ]
          .map(([v, l]) => `<option value="${v}" ${S.theme === v ? 'selected' : ''}>${l}</option>`)
          .join('')}</select>`
      )}
      ${sr('Show media count on the icon', 'Badge with the number of videos found on the page', tg('badge'))}
    </div>`,

  about: () => `
    <div class="ab2">
      <span class="logo">${svg(P.dl)}</span>
      <h2 style="margin:0">Tori Extension</h2>
      <div class="sub0" style="margin:6px 0 16px">Version 2.0.0 · Native Messaging Host: com.tori.download_manager</div>
      <div style="display:flex;gap:10px;justify-content:center">
        <button class="btn" data-a="toast_updates">Check for updates</button>
        <button class="btn def" data-a="open_desktop">Open Tori</button>
      </div>
    </div>`,
};

function render() {
  $('#nav').innerHTML =
    `<div class="brand"><span class="logo">${svg(P.dl)}</span><div><b>Tori</b><span>Extension options</span></div></div>` +
    N.map(
      ([k, l, c, p]) =>
        `<div class="ni ${k === sec ? 'on' : ''}" data-s="${k}"><i class="ft" style="--c:${c}">${svg(
          P[p] || P.dl
        )}</i>${l}</div>`
    ).join('');

  $('#content').innerHTML = V[sec]();
}

function saved(t = 'Saved') {
  const e = $('#sv');
  if (!e) return;
  e.innerHTML = `<i class="ft" style="--c:#30c75e">${svg(P.ck)}</i><span>${t}</span>`;
  e.classList.add('on');
  clearTimeout(saved.t);
  saved.t = setTimeout(() => e.classList.remove('on'), 1400);
}

function applyTheme() {
  const h = document.documentElement;
  h.dataset.theme =
    S.theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : S.theme;
}

function persistSettings() {
  chrome.storage.local.set({ tori_settings: S, tori_theme: S.theme }, () => {
    saved();
  });
}

function testNativeConnection() {
  testState = 'wait';
  render();
  const startTime = performance.now();

  chrome.runtime.sendMessage({ action: 'PING_DESKTOP', port: S.port, key: S.key }, (res) => {
    const elapsed = Math.round(performance.now() - startTime);
    testLatency = Math.max(1, elapsed);

    if (chrome.runtime.lastError || !res || res.status === 'disconnected') {
      testState = 'bad';
    } else if (res.status === 'unpaired') {
      testState = 'unpaired';
      testPort = res.port || S.port || 6800;
      testEngineVer = res.version || '2.0.0';
    } else if (res.status === 'ok' && res.authenticated) {
      testState = 'ok';
      testPort = res.port || S.port || 6800;
      testEngineVer = res.version || '2.0.0';
      if (res.token && res.token !== S.key) {
        S.key = res.token;
        persistSettings();
      }
      if (res.port && res.port !== S.port) {
        S.port = res.port;
        persistSettings();
      }
    } else {
      testState = 'bad';
    }
    render();
  });
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------
document.addEventListener('input', (e) => {
  const k = e.target.dataset.k;
  if (!k) return;

  S[k] =
    e.target.type === 'checkbox'
      ? e.target.checked
      : e.target.type === 'number'
      ? +e.target.value
      : e.target.value;

  if (k === 'theme') {
    applyTheme();
  }

  if (k === 'cap' || k === 'pill') {
    render();
  }

  persistSettings();
});

document.addEventListener('click', async (e) => {
  const t = e.target;

  // Tab navigation
  const n = t.closest('[data-s]');
  if (n) {
    sec = n.dataset.s;
    render();
    return;
  }

  // Actions
  const a = t.closest('[data-a]');
  if (!a) return;
  const k = a.dataset.a;
  const i = +a.dataset.i;

  if (k === 'test') {
    testNativeConnection();
  }

  if (k === 'pair') {
    saved('Pairing with Tori…');
    chrome.runtime.sendMessage({ action: 'INITIATE_PAIRING' }, (res) => {
      if (res && res.ok && res.token) {
        S.key = res.token;
        if (res.port) S.port = res.port;
        persistSettings();
        testNativeConnection();
        saved('Paired successfully');
      } else {
        saved(res?.error || 'Pairing failed. Make sure Tori Desktop is running.');
      }
    });
  }

  if (k === 'show') {
    const x = $('#key');
    if (x) {
      x.type = x.type === 'password' ? 'text' : 'password';
      a.textContent = x.type === 'password' ? 'Show' : 'Hide';
    }
  }

  if (k === 'paste') {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        S.key = text.trim();
        persistSettings();
        render();
        saved('Pasted from clipboard');
      }
    } catch (_) {
      saved('Could not access clipboard');
    }
  }

  if (k === 'rt') {
    S.types.splice(i, 1);
    persistSettings();
    render();
  }

  if (k === 'at') {
    const input = $('#ty');
    const val = input ? input.value.trim().replace(/^\./, '').toLowerCase() : '';
    if (val && !S.types.includes(val)) {
      S.types.push(val);
      persistSettings();
      render();
    }
  }

  if (k === 'rs') {
    S.sites.splice(i, 1);
    persistSettings();
    render();
  }

  if (k === 'as') {
    const input = $('#st');
    const val = input ? input.value.trim().toLowerCase() : '';
    if (val && !S.sites.includes(val)) {
      S.sites.push(val);
      persistSettings();
      render();
    }
  }

  if (k === 'toast_updates') {
    saved('Up to date');
  }

  if (k === 'open_desktop') {
    saved('Opening Tori…');
    chrome.runtime.sendMessage({ action: 'SHOW_DESKTOP' });
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const id = e.target.id;
    if (id === 'ty') {
      const btn = $('[data-a=at]');
      if (btn) btn.click();
    }
    if (id === 'st') {
      const btn = $('[data-a=as]');
      if (btn) btn.click();
    }
  }
});

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
chrome.storage.local.get(['tori_settings', 'tori_theme'], (res) => {
  if (res.tori_settings) {
    S = { ...DEFAULT_SETTINGS, ...res.tori_settings };
  }
  if (res.tori_theme) {
    S.theme = res.tori_theme;
  }
  applyTheme();
  testNativeConnection();
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

