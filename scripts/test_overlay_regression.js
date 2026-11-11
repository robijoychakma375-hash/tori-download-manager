const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.resolve(__dirname, '..');

async function testOverlayRegression() {
  const PORT = 19686;
  const CDP_PORT = 19687;

  let downloadsTriggered = [];

  const server = http.createServer((req, res) => {
    const contentCss = fs.readFileSync(path.join(ROOT, 'extension', 'content.css'), 'utf8');
    const contentJs = fs.readFileSync(path.join(ROOT, 'extension', 'content.js'), 'utf8');

    const pageHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Rick Astley - Never Gonna Give You Up (Official Music Video)</title>
        <style>
          body { margin: 0; background: #0f0f0f; font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
          .player-wrap { position: relative; width: 854px; height: 480px; background: #1a1a1a; border-radius: 12px; }
          video { width: 100%; height: 100%; border-radius: 12px; }
        </style>
        <style>${contentCss}</style>
        <script>
          window.__downloads = [];
          window.chrome = {
            storage: {
              local: {
                get: (keys, cb) => cb({
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
                      { filename: 'rick_1080p.mp4', url: 'https://example.com/1080p.mp4', format: 'MP4', size_bytes: 184549376, is_segment: false, type: 'video' },
                      { filename: 'rick_720p.mp4', url: 'https://example.com/720p.mp4', format: 'MP4', size_bytes: 96468992, is_segment: false, type: 'video' },
                      { filename: 'rick_audio.m4a', url: 'https://example.com/audio.m4a', format: 'M4A', size_bytes: 17825792, is_segment: false, type: 'audio' }
                    ]
                  });
                } else if (msg.action === 'RESOLVE_MEDIA') {
                  cb && cb({
                    status: 'ok',
                    metadata: {
                      title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)',
                      source_url: 'https://example.com/watch?v=123',
                      duration_seconds: 213,
                      formats: [
                        { resolution_label: '1080p', container: 'mp4', filesize: 193489152, format_id: '137+140', has_video: true, has_audio: true, url: 'https://example.com/1080.mp4' },
                        { resolution_label: '720p', container: 'mp4', filesize: 101187584, format_id: '136+140', has_video: true, has_audio: true, url: 'https://example.com/720.mp4' },
                        { resolution_label: '480p', container: 'mp4', filesize: 54525952, format_id: '135+140', has_video: true, has_audio: true, url: 'https://example.com/480.mp4' },
                        { resolution_label: 'Audio High', container: 'm4a', filesize: 17825792, format_id: '140', has_video: false, has_audio: true, url: 'https://example.com/audio.m4a' }
                      ]
                    }
                  });
                } else if (msg.action === 'START_MEDIA_DOWNLOAD' || msg.action === 'START_DOWNLOAD') {
                  window.__downloads.push(msg);
                  cb && cb({ status: 'ok', job_id: 'job_test_123', filename: msg.filename });
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
  });

  await new Promise(r => server.listen(PORT, r));

  const edgeProc = spawn(EDGE_EXE, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--window-size=1280,800',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + path.join(ROOT, 'target', 'temp_overlay_regression_profile'),
    'about:blank'
  ]);
  await new Promise(r => setTimeout(r, 2000));

  const json = await new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => res(JSON.parse(data)));
    }).on('error', rej);
  });

  const ws = new globalThis.WebSocket(json[0].webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);

  let msgId = 1;
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = msgId++;
    const handler = (evt) => {
      const m = JSON.parse(evt.data);
      if (m.id === id) {
        ws.removeEventListener('message', handler);
        resolve(m.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evalExpr = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return res?.result?.value;
  };

  await send('Page.enable');
  await send('Page.navigate', { url: `http://localhost:${PORT}/` });
  await new Promise(r => setTimeout(r, 1500));

  // 1. Check Pill Injection
  const pillExists = await evalExpr('!!document.querySelector(".tori-pill")');
  const pillTagText = await evalExpr('document.querySelector(".tori-pill-tag")?.textContent?.trim()');
  const pillHasIco = await evalExpr('!!document.querySelector(".tori-pill .ico")');
  console.log('1. Pill injected:', pillExists, '| Tag text:', pillTagText, '| Has .ico:', pillHasIco);

  // 2. Dragging Pill Test (5px threshold, position clamping)
  const dragResult = await evalExpr(`
    (() => {
      const pill = document.querySelector('.tori-pill');
      const mp = document.querySelector('.tori-mp');
      const initRect = pill.getBoundingClientRect();
      pill.dispatchEvent(new PointerEvent('pointerdown', { clientX: initRect.left + 10, clientY: initRect.top + 10, button: 0, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: initRect.left + 80, clientY: initRect.top + 50, bubbles: true }));
      const isDraggingClass = mp.classList.contains('tori-dragging');
      const draggedLeft = parseFloat(mp.style.left) || 0;
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: initRect.left + 80, clientY: initRect.top + 50, bubbles: true }));
      return { isDraggingClass, draggedLeft, hasRx: !!mp.getAttribute('data-pos-rx') };
    })()
  `);
  console.log('2. Overlay drag:', dragResult);
  await new Promise(r => setTimeout(r, 250));

  // 3. Click Pill to Open Format Panel
  await evalExpr(`
    (() => {
      const pill = document.querySelector('.tori-pill');
      pill.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 600));

  const isPanelOpen = await evalExpr('document.querySelector(".tori-pn").classList.contains("on")');
  const panelTitle = await evalExpr('document.getElementById("title")?.textContent');
  const formatRowsCount = await evalExpr('document.querySelectorAll(".tori-pn .tori-fr").length');
  console.log('3. Panel open:', isPanelOpen, '| Title:', panelTitle, '| Format rows:', formatRowsCount);

  // 4. Switch to Audio Only Tab
  await evalExpr(`
    (() => {
      const audioTabBtn = document.querySelector('.tori-seg [data-tab="Audio"]');
      if (audioTabBtn) audioTabBtn.click();
    })()
  `);
  const audioRowsCount = await evalExpr('document.querySelectorAll(".tori-pn .tori-fr").length');
  const savePathAudio = await evalExpr('document.getElementById("path")?.textContent');
  console.log('4. Audio tab switched -> Rows:', audioRowsCount, '| Save path:', savePathAudio);

  // Switch back to Video Tab
  await evalExpr(`
    (() => {
      const videoTabBtn = document.querySelector('.tori-seg [data-tab="Video"]');
      if (videoTabBtn) videoTabBtn.click();
    })()
  `);
  const savePathVideo = await evalExpr('document.getElementById("path")?.textContent');
  console.log('5. Video tab switched back -> Save path:', savePathVideo);

  // 5. Trigger Download
  const dlBtnState = await evalExpr(`
    (() => {
      const dlBtn = document.querySelector('[data-act="download"]');
      const isPnOn = document.querySelector('.tori-pn').classList.contains('on');
      return {
        disabled: dlBtn ? dlBtn.disabled : null,
        html: dlBtn ? dlBtn.outerHTML : null,
        classes: dlBtn ? dlBtn.className : null
      };
    })()
  `);
  console.log('5b. Download button state:', dlBtnState);

  await evalExpr(`
    (() => {
      const dlBtn = document.querySelector('[data-act="download"]');
      if (dlBtn) dlBtn.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 600));

  const downloads = await evalExpr('window.__downloads');
  const downloadSuccess = downloads && downloads.length > 0;
  console.log('6. Download triggered:', downloadSuccess, '| Payload:', downloads?.[0]?.action, downloads?.[0]?.filename);

  // 6. Close Panel via Close Button
  await evalExpr(`
    (() => {
      const closeBtn = document.querySelector('[data-act="close"]');
      if (closeBtn) closeBtn.click();
    })()
  `);
  const isPanelClosed = await evalExpr('!document.querySelector(".tori-pn").classList.contains("on")');
  console.log('7. Panel closed via close button:', isPanelClosed);

  ws.close();
  edgeProc.kill();
  server.close();

  const allPassed = pillExists && pillHasIco && dragResult.draggedLeft > 0 && dragResult.hasRx &&
                    isPanelOpen && formatRowsCount > 0 && audioRowsCount > 0 &&
                    savePathAudio.includes('Audio') && savePathVideo.includes('Video') &&
                    downloadSuccess && isPanelClosed;
  console.log('\nOVERLAY REGRESSION RESULT:', allPassed ? 'ALL TESTS PASSED [PASS]' : 'TESTS FAILED [FAIL]');
  if (!allPassed) process.exit(1);
}

testOverlayRegression().catch(e => {
  console.error('Regression error:', e);
  process.exit(1);
});
