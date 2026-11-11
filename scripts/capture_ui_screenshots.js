const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS_DIR = 'C:\\Users\\ritud\\.gemini\\antigravity\\brain\\4cb6b42b-ac51-4843-b5b6-6960f8030e35\\screenshots';

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new globalThis.WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: pRes, reject: pRej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) pRej(new Error(msg.error.message || JSON.stringify(msg.error)));
            else pRes(msg.result);
          }
        } catch (_) {}
      };
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout ${method}`));
        }
      }, 10000);
      this.pending.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async captureScreenshot(outputPath, clip = null) {
    const params = { format: 'png' };
    if (clip) params.clip = clip;
    const res = await this.send('Page.captureScreenshot', params);
    if (res?.data) {
      fs.writeFileSync(outputPath, Buffer.from(res.data, 'base64'));
      return true;
    }
    return false;
  }
  close() {
    try { this.ws.close(); } catch (_) {}
  }
}

async function capture() {
  const mode = process.argv[2] || 'after';
  const PORT = 19680;
  const CDP_PORT = 19681;

  // Static HTTP server for test pages
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/popup_test.html') {
      const popupHtml = fs.readFileSync(path.join(ROOT, 'extension', 'popup', 'popup.html'), 'utf8');
      const popupCss = fs.readFileSync(path.join(ROOT, 'extension', 'popup', 'popup.css'), 'utf8');
      const popupJs = fs.readFileSync(path.join(ROOT, 'extension', 'popup', 'popup.js'), 'utf8');

      // Inject mock chrome APIs for standalone rendering
      const mockScript = `
        <script>
          window.chrome = {
            storage: {
              local: {
                get: (keys, cb) => cb({
                  tori_theme: 'dark',
                  tori_settings: { cap: true, pill: true, fmt: '1080p', min: 1, port: 6800 }
                }),
                set: (data, cb) => cb && cb()
              }
            },
            runtime: {
              openOptionsPage: () => {},
              sendMessage: (msg, cb) => {
                if (msg.action === 'PING_DESKTOP') {
                  cb({ status: 'ok', authenticated: true, port: 6800, latency: 4 });
                } else if (msg.action === 'GET_TAB_MEDIA') {
                  cb({
                    media: [
                      { filename: 'Sample_1080p_Video.mp4', format: 'MP4', size_bytes: 184549376, is_segment: false, type: 'video' },
                      { filename: 'Sample_720p_Video.mp4', format: 'MP4', size_bytes: 96468992, is_segment: false, type: 'video' }
                    ]
                  });
                } else if (msg.action === 'GET_DOWNLOADS') {
                  cb({
                    jobs: [
                      { filename: 'Big_Buck_Bunny_1080p.mp4', total_bytes: 154200000, downloaded_bytes: 154200000, state: 'completed', job_type: 'Direct' },
                      { filename: 'Ubuntu-24.04-desktop-amd64.iso', total_bytes: 4800000000, downloaded_bytes: 2880000000, state: 'downloading', job_type: 'Torrent' }
                    ]
                  });
                } else {
                  cb && cb({ ok: true });
                }
              },
              onMessage: { addListener: () => {} }
            },
            tabs: {
              query: (q) => Promise.resolve([{ id: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }]),
              sendMessage: (tabId, msg, cb) => {
                if (cb) cb({
                  ok: true,
                  isResolving: false,
                  resolvedMeta: {
                    title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)',
                    formats: [
                      { resolution_label: '1080p', container: 'mp4', filesize: 193489152, format_id: '137+140' },
                      { resolution_label: '720p', container: 'mp4', filesize: 101187584, format_id: '136+140' },
                      { resolution_label: '480p', container: 'mp4', filesize: 54525952, format_id: '135+140' }
                    ]
                  }
                });
              }
            }
          };
        </script>
      `;

      let finalHtml = popupHtml
        .replace('<link rel="stylesheet" href="popup.css">', `<style>${popupCss}</style>`)
        .replace('<script src="popup.js"></script>', `${mockScript}<script>${popupJs}</script>`);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(finalHtml);
      return;
    }

    if (url.pathname === '/overlay_test.html') {
      const contentCss = fs.readFileSync(path.join(ROOT, 'extension', 'content.css'), 'utf8');
      const contentJs = fs.readFileSync(path.join(ROOT, 'extension', 'content.js'), 'utf8');

      const pageHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Rick Astley - Never Gonna Give You Up (Official Music Video)</title>
          <style>
            body { margin: 0; background: #0f0f0f; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; }
            .player-wrap { position: relative; width: 854px; height: 480px; background: #1a1a1a; border-radius: 12px; overflow: visible; }
            video { width: 100%; height: 100%; border-radius: 12px; object-fit: cover; }
          </style>
          <style>${contentCss}</style>
          <script>
            window.chrome = {
              storage: {
                local: {
                  get: (keys, cb) => cb({
                    tori_theme: 'dark',
                    tori_settings: { cap: true, pill: true, fmt: '1080p', min: 1, pos: 'Top right' }
                  }),
                  set: (data, cb) => cb && cb()
                },
                onChanged: { addListener: () => {} }
              },
              runtime: {
                sendMessage: (msg, cb) => {
                  if (msg.action === 'GET_TAB_MEDIA') {
                    cb && cb({
                      media: [
                        { filename: 'sample_1080p.mp4', url: 'https://example.com/1080p.mp4', format: 'MP4', size_bytes: 184549376, is_segment: false, type: 'video' },
                        { filename: 'sample_720p.mp4', url: 'https://example.com/720p.mp4', format: 'MP4', size_bytes: 96468992, is_segment: false, type: 'video' }
                      ]
                    });
                  } else if (msg.action === 'RESOLVE_MEDIA') {
                    cb && cb({
                      status: 'ok',
                      metadata: {
                        title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)',
                        duration_seconds: 213,
                        formats: [
                          { resolution_label: '1080p', container: 'mp4', filesize: 193489152, format_id: '137+140', has_video: true, has_audio: true, url: 'https://example.com/1080.mp4' },
                          { resolution_label: '720p', container: 'mp4', filesize: 101187584, format_id: '136+140', has_video: true, has_audio: true, url: 'https://example.com/720.mp4' },
                          { resolution_label: '480p', container: 'mp4', filesize: 54525952, format_id: '135+140', has_video: true, has_audio: true, url: 'https://example.com/480.mp4' },
                          { resolution_label: 'Audio High', container: 'm4a', filesize: 17825792, format_id: '140', has_video: false, has_audio: true, url: 'https://example.com/audio.m4a' }
                        ]
                      }
                    });
                  } else {
                    cb && cb({ ok: true });
                  }
                },
                onMessage: { addListener: () => {} }
              }
            };
          </script>
        </head>
        <body>
          <div class="player-wrap" id="anchor">
            <video id="vid" controls src="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"></video>
          </div>
          <script>${contentJs}</script>
        </body>
        </html>
      `;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(pageHtml);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Server listening on port ${PORT}`);

  const edgeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--window-size=1280,800',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + path.join(ROOT, 'target', 'temp_edge_screenshot_profile'),
    'about:blank',
  ];

  const edgeProc = spawn(EDGE_EXE, edgeArgs);
  await new Promise((r) => setTimeout(r, 2000));

  // Get WebSocket URL from CDP
  const getWsUrl = async () => {
    for (let i = 0; i < 20; i++) {
      try {
        const json = await new Promise((res, rej) => {
          http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (r) => {
            let data = '';
            r.on('data', (c) => (data += c));
            r.on('end', () => res(JSON.parse(data)));
          }).on('error', rej);
        });
        if (json && json.length > 0 && json[0].webSocketDebuggerUrl) {
          return json[0].webSocketDebuggerUrl;
        }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('CDP target not found');
  };

  const wsUrl = await getWsUrl();
  const cdp = new CdpClient(wsUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');

  // 1. Popup Before Screenshot
  console.log('Navigating to popup_test.html...');
  await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/popup_test.html` });
  await new Promise((r) => setTimeout(r, 1500));

  const popupShotPath = path.join(SCREENSHOTS_DIR, `popup_${mode}.png`);
  await cdp.captureScreenshot(popupShotPath);
  console.log(`Captured popup ${mode} screenshot: ${popupShotPath}`);

  // 2. Overlay Screenshot
  console.log('Navigating to overlay_test.html...');
  await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/overlay_test.html` });
  await new Promise((r) => setTimeout(r, 2000));

  // Click the pill to open the panel
  await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        const pill = document.querySelector('.tori-pill');
        if (pill) pill.click();
      })()
    `
  });
  await new Promise((r) => setTimeout(r, 1000));

  const overlayShotPath = path.join(SCREENSHOTS_DIR, `overlay_${mode}.png`);
  await cdp.captureScreenshot(overlayShotPath);
  console.log(`Captured overlay ${mode} screenshot: ${overlayShotPath}`);

  cdp.close();
  edgeProc.kill();
  server.close();
  console.log('Done capturing before screenshots.');
}

capture().catch((err) => {
  console.error('Error during capture:', err);
  process.exit(1);
});
