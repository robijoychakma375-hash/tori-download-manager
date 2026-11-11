const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.resolve(__dirname, '..');

async function testPopupInteractions() {
  const PORT = 19684;
  const CDP_PORT = 19685;

  let storageData = {
    tori_settings: { cap: true, pill: true, fmt: '1080p', min: 1, port: 6800 }
  };
  let sentMessages = [];

  const server = http.createServer((req, res) => {
    const popupHtml = fs.readFileSync(path.join(ROOT, 'extension', 'popup', 'popup.html'), 'utf8');
    const popupCss = fs.readFileSync(path.join(ROOT, 'extension', 'popup', 'popup.css'), 'utf8');
    const popupJs = fs.readFileSync(path.join(ROOT, 'extension', 'popup', 'popup.js'), 'utf8');

    const mockScript = `
      <script>
        window.__sentMessages = [];
        window.__storage = ${JSON.stringify(storageData)};
        window.chrome = {
          storage: {
            local: {
              get: (keys, cb) => cb(window.__storage),
              set: (data, cb) => {
                Object.assign(window.__storage, data);
                if (cb) cb();
              }
            }
          },
          runtime: {
            openOptionsPage: () => {},
            sendMessage: (msg, cb) => {
              window.__sentMessages.push(msg);
              if (msg.action === 'PING_DESKTOP') {
                cb({ status: 'ok', authenticated: true, port: 6800, latency: 4 });
              } else if (msg.action === 'INITIATE_PAIRING') {
                cb({ ok: true });
              } else if (msg.action === 'GET_TAB_MEDIA') {
                cb({ media: [] });
              } else if (msg.action === 'GET_DOWNLOADS') {
                cb({ jobs: [] });
              } else {
                cb && cb({ ok: true });
              }
            },
            onMessage: { addListener: () => {} }
          },
          tabs: {
            query: () => Promise.resolve([{ id: 1, url: 'https://example.com' }]),
            sendMessage: (id, msg, cb) => cb && cb({ ok: false })
          }
        };
      </script>
    `;

    let finalHtml = popupHtml
      .replace('<link rel="stylesheet" href="popup.css">', `<style>${popupCss}</style>`)
      .replace('<script src="popup.js"></script>', `${mockScript}<script>${popupJs}</script>`);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(finalHtml);
  });

  await new Promise(r => server.listen(PORT, r));

  const edgeProc = spawn(EDGE_EXE, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--window-size=1280,800',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + path.join(ROOT, 'target', 'temp_popup_verify_profile'),
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

  const evaluate = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (!res || !res.result) console.log('DEBUG EVAL RES:', res);
    return res?.result?.value;
  };

  await send('Page.enable');
  await send('Page.navigate', { url: `http://localhost:${PORT}/` });
  await new Promise(r => setTimeout(r, 1000));

  // Check initial state
  const isMainVisible = await evaluate('!document.getElementById("main").hidden');
  const isSettingsHidden = await evaluate('document.getElementById("settings").hidden');
  const statusText = await evaluate('document.getElementById("stTxt").textContent');
  const isMainOn = await evaluate('document.getElementById("main").classList.contains("on")');

  console.log('1. Main visible:', isMainVisible, '| Settings hidden:', isSettingsHidden);
  console.log('2. Status text:', statusText, '| Main .on class:', isMainOn);

  // Click gear to go to settings
  await evaluate('document.getElementById("gear").click()');
  const isMainHiddenAfterGear = await evaluate('document.getElementById("main").hidden');
  const isSettingsVisibleAfterGear = await evaluate('!document.getElementById("settings").hidden');
  console.log('3. After clicking Gear -> Main hidden:', isMainHiddenAfterGear, '| Settings visible:', isSettingsVisibleAfterGear);

  // Toggle capture switch in settings
  await evaluate('document.getElementById("capSwSet").click()');
  const capValAfter = await evaluate('window.__storage.tori_settings.cap');
  const capSwMainChecked = await evaluate('document.getElementById("capSwMain").getAttribute("aria-checked")');
  console.log('4. After clicking cap switch -> Storage cap:', capValAfter, '| capSwMain checked:', capSwMainChecked);

  // Click done button
  await evaluate('document.getElementById("done").click()');
  const isMainVisibleAfterDone = await evaluate('!document.getElementById("main").hidden');
  console.log('5. After clicking Done -> Main visible:', isMainVisibleAfterDone);

  // Click open tori
  await evaluate('document.getElementById("open").click()');
  const sent = await evaluate('window.__sentMessages');
  const hasShowDesktop = sent.some(m => m.action === 'SHOW_DESKTOP');
  console.log('6. Open Tori clicked -> Sent SHOW_DESKTOP:', hasShowDesktop);

  ws.close();
  edgeProc.kill();
  server.close();

  const allPassed = isMainVisible && isSettingsHidden && statusText === 'Connected' && isMainOn &&
                    isMainHiddenAfterGear && isSettingsVisibleAfterGear && capValAfter === false &&
                    capSwMainChecked === 'false' && isMainVisibleAfterDone && hasShowDesktop;
  console.log('ALL POPUP TESTS PASSED:', allPassed);
  if (!allPassed) process.exit(1);
}

testPopupInteractions().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
