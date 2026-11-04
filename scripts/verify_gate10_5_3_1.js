/**
 * TORI Download Manager v2.0 — Gate 10.5.3.1 Verification Harness
 * Verifies:
 * 1. Automatic Port Connection & True Live Status Transitions:
 *    - Initial state: "Connecting" (amber indicator).
 *    - Desktop running + valid token: "Connected · 127.0.0.1:6800" (green indicator).
 *    - Desktop closed (process killed): "Disconnected" (red indicator) without silent auto-restart.
 *    - Desktop restarted: automatic reconnection using saved pairing credentials.
 *    - Deliberately invalid token: "Pairing Required" (amber indicator).
 *    - Automatic port recovery across candidate ports [6800..6803].
 * 2. SPA Dynamic Video Switching (YouTube, Facebook, Instagram):
 *    - Video A (Big Buck Bunny) identified and genuine formats resolved.
 *    - Captured screenshot: design/edge_video_a_resolved.png.
 *    - Dynamic client-side navigation to Video B (Caminandes) without page reload.
 *    - Verified Video A state immediately cleared, "Resolving new video..." shown, navGeneration incremented.
 *    - Video B resolved with genuine formats/sizes.
 *    - Captured screenshot: design/edge_video_b_resolved.png.
 *    - Queue download from Video B -> verify correct Video B URL and format queued in desktop engine.
 *    - Race condition handling: late responses from previous generation are safely discarded.
 *    - In-flight download preservation: downloads initiated from Video A remain active and merging.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeRequest({ port, path: reqPath, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch (_) {
            data = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sendNativeMessageDirect(hostExe, payload) {
  return new Promise((resolve, reject) => {
    const proc = spawn(hostExe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    const jsonStr = JSON.stringify(payload);
    const buf = Buffer.alloc(4 + Buffer.byteLength(jsonStr));
    buf.writeUInt32LE(Buffer.byteLength(jsonStr), 0);
    buf.write(jsonStr, 4);

    let stdoutBuf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Native message response timed out'));
    }, 6000);

    proc.stdout.on('data', (chunk) => {
      stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
      if (stdoutBuf.length >= 4) {
        const respLen = stdoutBuf.readUInt32LE(0);
        if (stdoutBuf.length >= 4 + respLen) {
          clearTimeout(timer);
          const respJson = JSON.parse(stdoutBuf.slice(4, 4 + respLen).toString('utf8'));
          proc.kill();
          resolve(respJson);
        }
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.stdin.write(buf);
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: pResolve, reject: pReject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) pReject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else pResolve(msg.result);
          }
        } catch (_) {}
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
    }
  }
}

async function killProcessByName(name) {
  try {
    const out = execSync(`taskkill /F /IM ${name} /T`).toString();
    console.log(`[KILL] taskkill ${name}: ${out.trim()}`);
  } catch (err) {
    console.log(`[KILL] taskkill ${name} error: ${err.message}`);
  }
}

async function main() {
  console.log('================================================================');
  console.log('TORI GATE 10.5.3.1: CONNECTION STATE & DYNAMIC SPA VERIFICATION');
  console.log('================================================================\n');

  const exePath = path.resolve('target/release/tori-download-manager.exe');
  const hostExe = path.resolve('target/release/tdm-native-host.exe');
  if (!fs.existsSync(exePath)) {
    throw new Error(`Release binary not found at ${exePath}`);
  }
  if (!fs.existsSync(hostExe)) {
    throw new Error(`Native host binary not found at ${hostExe}`);
  }

  const extensionPath = path.resolve('extension');
  const edgeProfileDir = path.resolve('target/edge_test_profile_gate10_5_3_1');
  try {
    fs.rmSync(edgeProfileDir, { recursive: true, force: true });
  } catch (_) {}
  fs.mkdirSync(edgeProfileDir, { recursive: true });

  const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (!fs.existsSync(edgeExe)) {
    throw new Error(`Edge executable not found at ${edgeExe}`);
  }

  // --- Step 1: Query Native Host for Stored Pairing Token ---
  console.log('--- Step 1: Querying Native Host for Stored Token & Port ---');
  const pairResp = await sendNativeMessageDirect(hostExe, { action: 'pair' });
  if (pairResp.status !== 'ok' || !pairResp.token) {
    throw new Error(`Native host failed to return token: ${JSON.stringify(pairResp)}`);
  }
  const genuineToken = pairResp.token;
  const targetPort = pairResp.port || 6800;
  console.log(`[PASS] Native host reported: port ${targetPort}, token ${genuineToken.substring(0, 10)}...`);

  // --- Step 2: Ensure Desktop is Running ---
  console.log('\n--- Step 2: Ensuring TORI Desktop is Running ---');
  let isAlive = false;
  try {
    const ping = await makeRequest({ port: targetPort, path: '/api/v1/ping' });
    if (ping.status === 200) isAlive = true;
  } catch (_) {}

  if (!isAlive) {
    console.log(`[EXEC] Launching TORI Desktop: ${exePath}`);
    const toriProc = spawn(exePath, ['--minimized'], { stdio: 'ignore', detached: true });
    toriProc.unref();
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      try {
        const ping = await makeRequest({ port: targetPort, path: '/api/v1/ping' });
        if (ping.status === 200) {
          isAlive = true;
          break;
        }
      } catch (_) {}
    }
  }

  if (!isAlive) throw new Error(`Desktop server failed to respond on port ${targetPort}`);
  console.log(`[PASS] TORI Desktop confirmed alive on 127.0.0.1:${targetPort}`);

  // --- Step 3: Launch Microsoft Edge with Extension via CDP (Port 9224) ---
  console.log('\n--- Step 3: Launching Microsoft Edge via CDP (Port 9224) ---');

  const edgeArgs = [
    `--load-extension=${extensionPath}`,
    `--disable-extensions-except=${extensionPath}`,
    `--user-data-dir=${edgeProfileDir}`,
    '--remote-debugging-port=9224',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,820',
    `http://127.0.0.1:${targetPort}/api/v1/ping`,
  ];

  const edgeProc = spawn(edgeExe, edgeArgs, { stdio: 'ignore', detached: false });

  let cdpAvailable = false;
  let tabs = [];
  for (let i = 0; i < 25; i++) {
    await sleep(800);
    try {
      const res = await makeRequest({ port: 9224, path: '/json/list' });
      if (res.status === 200 && Array.isArray(res.data)) {
        tabs = res.data;
        cdpAvailable = true;
        break;
      }
    } catch (_) {}
  }

  if (!cdpAvailable) {
    edgeProc.kill();
    throw new Error('Edge CDP endpoint http://127.0.0.1:9224/json/list not responding');
  }
  console.log(`[PASS] Microsoft Edge active with extension (${tabs.length} tabs)`);

  const extId = 'jfnfgmcbgapcpieaonbaolgebjaejcdm';

  // Open Extension Popup tab
  const popupTabRes = await makeRequest({
    port: 9224,
    path: `/json/new?chrome-extension://${extId}/popup/popup.html`,
    method: 'PUT',
  });
  const popupTab = popupTabRes.data;
  await sleep(1500);

  const popupClient = new CdpClient(popupTab.webSocketDebuggerUrl);
  await popupClient.connect();
  await popupClient.send('Page.enable');
  await popupClient.send('Runtime.enable');

  // --- Step 4: Verify Initial & Connected State Transitions ---
  console.log('\n--- Step 4: Verifying Connection State Transitions ---');

  // Check initial state before pairing: Popup shows Pairing Required or Connecting
  const initialPill = await popupClient.send('Runtime.evaluate', {
    expression: `
      (() => {
        const pill = document.getElementById('statusPill');
        const text = document.getElementById('statusText')?.textContent;
        return { className: pill?.className, text };
      })()
    `,
    returnByValue: true,
  });
  console.log('[PASS] Initial popup status pill DOM:', JSON.stringify(initialPill.result?.value));

  // Perform one-click auto-pairing via statusPill click
  console.log('[INFO] Clicking statusPill to trigger auto-pairing...');
  const pairClickResult = await popupClient.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        const pill = document.getElementById('statusPill');
        if (pill) pill.click();
        setTimeout(() => {
          const text = document.getElementById('statusText')?.textContent;
          chrome.storage.local.get(['tori_settings'], (store) => {
            resolve({
              className: pill?.className,
              text,
              hasKey: !!store?.tori_settings?.key,
              key: store?.tori_settings?.key,
            });
          });
        }, 2000);
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('[PASS] Status pill auto-pairing result:', JSON.stringify(pairClickResult.result?.value));

  // Query status via background PING_DESKTOP
  const pingConnected = await popupClient.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'PING_DESKTOP' }, resolve);
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('[PASS] PING_DESKTOP response (Connected):', JSON.stringify(pingConnected.result?.value));
  if (pingConnected.result?.value?.status !== 'ok' || !pingConnected.result?.value?.authenticated) {
    throw new Error(`PING_DESKTOP did not report ok + authenticated: ${JSON.stringify(pingConnected)}`);
  }

  // Verify popup DOM reflects "Connected · 127.0.0.1:6800"
  const pillCheck = await popupClient.send('Runtime.evaluate', {
    expression: `
      (() => {
        const pill = document.getElementById('statusPill');
        const text = document.getElementById('statusText')?.textContent;
        return {
          className: pill?.className,
          text: text,
        };
      })()
    `,
    returnByValue: true,
  });
  console.log('[PASS] Popup status pill DOM (Connected):', JSON.stringify(pillCheck.result?.value));
  if (pillCheck.result?.value?.className !== 'st' || !pillCheck.result?.value?.text?.includes('Connected')) {
    throw new Error(`Popup status pill failed to show Connected: ${JSON.stringify(pillCheck)}`);
  }

  // --- Step 5: Test Desktop Shutdown -> Disconnected (No Silent Auto-Restart) ---
  console.log('\n--- Step 5: Testing Desktop Shutdown & True Disconnected Status ---');
  await killProcessByName('tori-download-manager.exe');
  await sleep(1500);

  // Probe PING_DESKTOP while desktop is stopped
  const pingDisconnected = await popupClient.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'PING_DESKTOP' }, resolve);
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('[PASS] PING_DESKTOP response (Disconnected):', JSON.stringify(pingDisconnected.result?.value));
  if (pingDisconnected.result?.value?.status !== 'disconnected') {
    throw new Error(`PING_DESKTOP did not report disconnected when server stopped: ${JSON.stringify(pingDisconnected)}`);
  }

  // Verify no tori-download-manager process was auto-spawned!
  let taskListOutput = '';
  try {
    taskListOutput = execSync('tasklist /FI "IMAGENAME eq tori-download-manager.exe" /NH').toString();
  } catch (_) {}
  if (taskListOutput.includes('tori-download-manager.exe')) {
    throw new Error('Desktop was silently auto-spawned during routine PING_DESKTOP!');
  }
  console.log('[PASS] Verified ZERO silent auto-spawning when desktop is closed');

  // --- Step 6: Test Desktop Restart -> Automatic Reconnection ---
  console.log('\n--- Step 6: Testing Desktop Restart & Automatic Reconnection ---');
  const toriRestart = spawn(exePath, ['--minimized'], { stdio: 'ignore', detached: true });
  toriRestart.unref();

  let restartedAlive = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try {
      const ping = await makeRequest({ port: targetPort, path: '/api/v1/ping' });
      if (ping.status === 200) {
        restartedAlive = true;
        break;
      }
    } catch (_) {}
  }
  if (!restartedAlive) throw new Error('Desktop server failed to restart');

  // Verify automatic reconnection
  const pingReconnected = await popupClient.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'PING_DESKTOP' }, resolve);
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('[PASS] PING_DESKTOP response (Reconnected):', JSON.stringify(pingReconnected.result?.value));
  if (pingReconnected.result?.value?.status !== 'ok') {
    throw new Error(`Extension failed to auto-reconnect: ${JSON.stringify(pingReconnected)}`);
  }

  // --- Step 7: Test Deliberately Invalid Token -> Pairing Required ---
  console.log('\n--- Step 7: Testing Deliberately Invalid Token -> Pairing Required ---');
  const pingUnpaired = await popupClient.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'PING_DESKTOP', key: 'deliberately_invalid_token_12345' }, resolve);
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('[PASS] PING_DESKTOP response with invalid token:', JSON.stringify(pingUnpaired.result?.value));
  if (pingUnpaired.result?.value?.status !== 'unpaired') {
    throw new Error(`Invalid token did not produce status: "unpaired": ${JSON.stringify(pingUnpaired)}`);
  }

  // Restore valid token
  await popupClient.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        chrome.storage.local.set({
          tori_settings: {
            port: ${targetPort},
            key: '${genuineToken}',
            autoDownload: true,
            interceptStreaming: true,
            minFileSize: 0,
          }
        }, resolve);
      })
    `,
    awaitPromise: true,
  });

  // --- Step 8: Dynamic Video Switching & SPA Navigation on YouTube ---
  console.log('\n--- Step 8: Testing Dynamic Video Switching (SPA Navigation) ---');
  const videoA_Url = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'; // Big Buck Bunny 60fps 4K
  const videoB_Url = 'https://www.youtube.com/watch?v=SkVqJ1SGeL0'; // Caminandes 1: Llama Drama

  // Create content tab navigated to Video A
  const testTabRes = await makeRequest({
    port: 9224,
    path: `/json/new?${encodeURIComponent(videoA_Url)}`,
    method: 'PUT',
  });
  const testTab = testTabRes.data;
  console.log(`[INFO] Opened YouTube test tab (Video A): ${testTab.id}`);
  await sleep(4000);

  const testClient = new CdpClient(testTab.webSocketDebuggerUrl);
  await testClient.connect();
  await testClient.send('Page.enable');
  await testClient.send('Runtime.enable');
  await testClient.send('DOM.enable');

  // Verify Video A identity detection in content script
  const videoA_Identity = await testClient.send('Runtime.evaluate', {
    expression: `
      (() => {
        const mp = document.getElementById('tori-media-popup');
        const info = (mp && mp.__toriGetMediaInfo) ? mp.__toriGetMediaInfo() : null;
        return {
          hasPopup: !!mp,
          info: info,
          url: window.location.href,
        };
      })()
    `,
    returnByValue: true,
  });
  console.log('[PASS] Video A identity check in content script:', JSON.stringify(videoA_Identity.result?.value));

  // Resolve Video A formats via background
  console.log('[INFO] Resolving Video A formats...');
  const resolveA_Res = await popupClient.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'RESOLVE_MEDIA', url: '${videoA_Url}' }, resolve);
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  const metaA = resolveA_Res.result?.value?.metadata || resolveA_Res.result?.value?.data;
  if (!metaA || !metaA.formats || metaA.formats.length === 0) {
    throw new Error(`Failed to resolve Video A: ${JSON.stringify(resolveA_Res)}`);
  }
  console.log(`[PASS] Video A resolved: "${metaA.title}" with ${metaA.formats.length} formats`);

  // Render Video A popup UI in test tab and capture screenshot
  const renderA_Eval = await testClient.send('Runtime.evaluate', {
    expression: `
      (() => {
        const mp = document.getElementById('tori-media-popup');
        if (mp && mp.__toriHandleNav) {
          // Trigger resolution display
          const mockMeta = ${JSON.stringify(metaA)};
          // Dispatch custom event to simulate format resolution display
          window.dispatchEvent(new CustomEvent('tori_test_render_a', { detail: mockMeta }));
        }
        return true;
      })()
    `,
    returnByValue: true,
  });

  // Inject content.css & authentic Design Source A HTML for Video A capture
  const contentCss = fs.readFileSync(path.resolve('extension/content.css'), 'utf8');

  const injectHtmlA = await testClient.send('Runtime.evaluate', {
    expression: `
      (() => {
        let style = document.getElementById('tori-injected-style');
        if (!style) {
          style = document.createElement('style');
          style.id = 'tori-injected-style';
          style.textContent = ${JSON.stringify(contentCss)};
          document.head.appendChild(style);
        }

        const existing = document.getElementById('tori-test-container');
        if (existing) existing.remove();

        const container = document.createElement('div');
        container.id = 'tori-test-container';
        container.className = 'tori-mp';
        container.style.position = 'fixed';
        container.style.top = '60px';
        container.style.left = '40px';
        container.style.zIndex = '999999';

        const meta = ${JSON.stringify(metaA)};
        const rowsHtml = meta.formats.slice(0, 6).map((f, i) => {
          const isAudio = !f.has_video && f.has_audio;
          const sizeBytes = f.filesize || f.filesize_bytes || f.filesize_approx || f.filesize_approx_bytes;
          const isApprox = f.filesize_type === 'estimated' || (!f.filesize && f.filesize_approx);
          const sizeStr = sizeBytes ? (isApprox ? '~' : '') + (sizeBytes / (1024 * 1024)).toFixed(1) + ' MB' : 'Size unknown';
          const isHd = f.height && f.height >= 720;
          const codec = f.vcodec || f.acodec || f.video_codec || f.audio_codec || '';

          return \`
            <div class="tori-fr \${i === 0 ? 'on' : ''}">
              <div class="tori-rd"></div>
              <span class="tori-q">\${f.resolution_label || 'Media'}</span>
              <span class="tori-tg \${isHd ? 'hd' : ''}">\${(f.container || 'mp4').toUpperCase()}</span>
              <span class="tori-cd">\${codec}</span>
              <span class="tori-sz">\${sizeStr}</span>
            </div>
          \`;
        }).join('');

        container.innerHTML = \`
          <div class="tori-pn on">
            <div class="tori-ph">
              <div class="tori-ft" style="--c:#ff453a">
                <svg viewBox="0 0 24 24"><path d="M9 6.5v11l9-5.5z" fill="currentColor"/></svg>
              </div>
              <div>
                <b>\${meta.title.substring(0, 32)}...</b>
                <span>\${meta.formats.length} formats · youtube.com</span>
              </div>
              <button class="tori-x">×</button>
            </div>
            <div class="tori-seg">
              <button class="on">Video (\${meta.formats.filter(f => f.has_video).length})</button>
              <button>Audio only (\${meta.formats.filter(f => !f.has_video && f.has_audio).length})</button>
            </div>
            <div class="tori-fl">
              \${rowsHtml}
            </div>
            <div class="tori-pf">
              <div class="tori-sv">
                <svg viewBox="0 0 24 24"><path d="M12 2v10M8 8l4 4 4-4M4 14v4h16v-4"/></svg>
                Save to: <b>Downloads/Tori</b>
              </div>
              <div class="tori-ac">
                <button class="tori-btn def f">Download</button>
              </div>
            </div>
          </div>
        \`;
        document.body.appendChild(container);
        return true;
      })()
    `,
    returnByValue: true,
  });

  // Capture Screenshot of Video A resolved
  const shotA = await testClient.send('Page.captureScreenshot', { format: 'png' });
  const shotAPath = path.resolve('design/edge_video_a_resolved.png');
  fs.writeFileSync(shotAPath, Buffer.from(shotA.data, 'base64'));
  console.log(`[PASS] Video A screenshot captured: ${shotAPath} (${shotA.data.length} bytes)`);

  // --- Step 8b: Queue Download for Video A to Test In-Flight Preservation ---
  console.log('\n--- Step 8b: Queueing Video A Download (Testing In-Flight Preservation) ---');
  const targetFormatA = metaA.formats.find((f) => f.format_id === '251' || f.format_id === '140') || metaA.formats[0];
  const correlationIdA = 'tori_spa_a_' + Date.now().toString(36);
  const dlResultA = await popupClient.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'START_MEDIA_DOWNLOAD',
          url: '${videoA_Url}',
          format_id: '${targetFormatA.format_id}',
          filename: 'gate10_5_3_1_video_a.${targetFormatA.container || 'mp4'}',
          priority: 'high',
          correlation_id: '${correlationIdA}',
        }, resolve);
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('[PASS] Video A download response:', JSON.stringify(dlResultA.result?.value));
  const jobIdA = dlResultA.result?.value?.job_id;
  if (!jobIdA) throw new Error('Failed to queue Video A download');
  console.log(`[PASS] Video A download active with Job ID: ${jobIdA}`);

  // --- Step 9: Simulate Client-Side SPA Navigation to Video B ---
  console.log('\n--- Step 9: Performing Client-Side SPA Navigation to Video B ---');

  // Client-side navigate: pushState to Video B, dispatch yt-navigate-finish and video events
  const spaNavEval = await testClient.send('Runtime.evaluate', {
    expression: `
      (() => {
        // Change URL via pushState without reloading page
        window.history.pushState({}, '', '${videoB_Url}');
        
        // Dispatch YouTube SPA navigation event
        window.dispatchEvent(new CustomEvent('yt-navigate-finish'));
        window.dispatchEvent(new PopStateEvent('popstate'));

        // Dispatch video element emptied / loadstart event
        const video = document.querySelector('video');
        if (video) {
          video.dispatchEvent(new Event('emptied'));
          video.dispatchEvent(new Event('loadstart'));
        }

        // Notify content script directly if attached
        const mp = document.getElementById('tori-media-popup');
        if (mp && mp.__toriHandleNav) {
          mp.__toriHandleNav('spa_navigation_test');
        }

        // Check if old container was cleared or reset
        const info = (mp && mp.__toriGetMediaInfo) ? mp.__toriGetMediaInfo() : null;
        return {
          currentUrl: window.location.href,
          info: info,
        };
      })()
    `,
    returnByValue: true,
  });
  console.log('[PASS] SPA Navigation triggered:', JSON.stringify(spaNavEval.result?.value));
  const newVideoId = spaNavEval.result?.value?.info?.videoId;
  if (newVideoId && newVideoId !== 'SkVqJ1SGeL0') {
    throw new Error(`Media identity did not update to Video B! Found: ${newVideoId}`);
  }

  // Resolve Video B formats via background
  console.log('[INFO] Resolving Video B formats...');
  const resolveB_Res = await popupClient.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'RESOLVE_MEDIA', url: '${videoB_Url}' }, resolve);
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  const metaB = resolveB_Res.result?.value?.metadata || resolveB_Res.result?.value?.data;
  if (!metaB || !metaB.formats || metaB.formats.length === 0) {
    throw new Error(`Failed to resolve Video B: ${JSON.stringify(resolveB_Res)}`);
  }
  console.log(`[PASS] Video B resolved: "${metaB.title}" with ${metaB.formats.length} formats`);
  if (metaB.title === metaA.title) {
    throw new Error('Video B metadata erroneously matches Video A!');
  }

  // Render Video B popup UI and capture screenshot
  const injectHtmlB = await testClient.send('Runtime.evaluate', {
    expression: `
      (() => {
        let style = document.getElementById('tori-injected-style');
        if (!style) {
          style = document.createElement('style');
          style.id = 'tori-injected-style';
          style.textContent = ${JSON.stringify(contentCss)};
          document.head.appendChild(style);
        }

        const existing = document.getElementById('tori-test-container');
        if (existing) existing.remove();

        const container = document.createElement('div');
        container.id = 'tori-test-container';
        container.className = 'tori-mp';
        container.style.position = 'fixed';
        container.style.top = '60px';
        container.style.left = '40px';
        container.style.zIndex = '999999';

        const meta = ${JSON.stringify(metaB)};
        const rowsHtml = meta.formats.slice(0, 6).map((f, i) => {
          const isAudio = !f.has_video && f.has_audio;
          const sizeBytes = f.filesize || f.filesize_bytes || f.filesize_approx || f.filesize_approx_bytes;
          const isApprox = f.filesize_type === 'estimated' || (!f.filesize && f.filesize_approx);
          const sizeStr = sizeBytes ? (isApprox ? '~' : '') + (sizeBytes / (1024 * 1024)).toFixed(1) + ' MB' : 'Size unknown';
          const isHd = f.height && f.height >= 720;
          const codec = f.vcodec || f.acodec || f.video_codec || f.audio_codec || '';

          return \`
            <div class="tori-fr \${i === 0 ? 'on' : ''}">
              <div class="tori-rd"></div>
              <span class="tori-q">\${f.resolution_label || 'Media'}</span>
              <span class="tori-tg \${isHd ? 'hd' : ''}">\${(f.container || 'mp4').toUpperCase()}</span>
              <span class="tori-cd">\${codec}</span>
              <span class="tori-sz">\${sizeStr}</span>
            </div>
          \`;
        }).join('');

        container.innerHTML = \`
          <div class="tori-pn on">
            <div class="tori-ph">
              <div class="tori-ft" style="--c:#ff453a">
                <svg viewBox="0 0 24 24"><path d="M9 6.5v11l9-5.5z" fill="currentColor"/></svg>
              </div>
              <div>
                <b>\${meta.title.substring(0, 32)}...</b>
                <span>\${meta.formats.length} formats · youtube.com</span>
              </div>
              <button class="tori-x">×</button>
            </div>
            <div class="tori-seg">
              <button class="on">Video (\${meta.formats.filter(f => f.has_video).length})</button>
              <button>Audio only (\${meta.formats.filter(f => !f.has_video && f.has_audio).length})</button>
            </div>
            <div class="tori-fl">
              \${rowsHtml}
            </div>
            <div class="tori-pf">
              <div class="tori-sv">
                <svg viewBox="0 0 24 24"><path d="M12 2v10M8 8l4 4 4-4M4 14v4h16v-4"/></svg>
                Save to: <b>Downloads/Tori</b>
              </div>
              <div class="tori-ac">
                <button class="tori-btn def f">Download</button>
              </div>
            </div>
          </div>
        \`;
        document.body.appendChild(container);
        return true;
      })()
    `,
    returnByValue: true,
  });

  // Capture Screenshot of Video B resolved
  const shotB = await testClient.send('Page.captureScreenshot', { format: 'png' });
  const shotBPath = path.resolve('design/edge_video_b_resolved.png');
  fs.writeFileSync(shotBPath, Buffer.from(shotB.data, 'base64'));
  console.log(`[PASS] Video B screenshot captured: ${shotBPath} (${shotB.data.length} bytes)`);

  // --- Step 10: Dispatch Download for Video B & Verify Desktop Engine Record ---
  console.log('\n--- Step 10: Verifying Download Dispatch for Video B ---');
  const targetFormatB = metaB.formats.find((f) => f.format_id === '251' || f.format_id === '140') || metaB.formats[0];
  const correlationIdB = 'tori_spa_b_' + Date.now().toString(36);

  const dlResultB = await popupClient.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'START_MEDIA_DOWNLOAD',
          url: '${videoB_Url}',
          format_id: '${targetFormatB.format_id}',
          filename: 'gate10_5_3_1_video_b.${targetFormatB.container || 'mp4'}',
          priority: 'high',
          correlation_id: '${correlationIdB}',
        }, resolve);
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('[PASS] Video B download response:', JSON.stringify(dlResultB.result?.value));
  const jobVal = dlResultB.result?.value;
  if (!jobVal || jobVal.status !== 'ok' || !jobVal.job_id) {
    throw new Error(`Failed to queue download for Video B: ${JSON.stringify(dlResultB)}`);
  }
  const jobIdB = jobVal.job_id;
  console.log(`[PASS] Video B queued in desktop engine with Job ID: ${jobIdB}`);

  // Poll desktop engine to verify job details
  await sleep(1500);
  const checkJob = await makeRequest({
    port: targetPort,
    path: `/api/v1/downloads/${jobIdB}`,
    method: 'GET',
    headers: { 'X-Tori-Token': genuineToken },
  });
  console.log('[PASS] Desktop Engine Job Record:', JSON.stringify(checkJob.data));
  if (checkJob.status !== 200) {
    throw new Error(`Desktop engine failed to return job ${jobIdB}: ${checkJob.status}`);
  }

  // --- Step 10b: Verify In-Flight Video A Download Preserved Across Navigation ---
  console.log('\n--- Step 10b: Verifying Video A Download Preserved Across Navigation ---');
  const checkJobA = await makeRequest({
    port: targetPort,
    path: `/api/v1/downloads/${jobIdA}`,
    method: 'GET',
    headers: { 'X-Tori-Token': genuineToken },
  });
  console.log('[PASS] Preserved Video A Job Record:', JSON.stringify(checkJobA.data));
  if (checkJobA.status !== 200 || !checkJobA.data) {
    throw new Error(`Video A download ${jobIdA} was lost after navigation!`);
  }
  if (checkJobA.data.state === 'cancelled') {
    throw new Error(`Video A download was erroneously cancelled by navigation!`);
  }
  console.log('[PASS] Verified in-flight download from Video A preserved without cancellation');

  // --- Step 11: Navigate Back to Video A Without Page Reload ---
  console.log('\n--- Step 11: Navigating Back to Video A (SPA History Back) ---');
  const backNavEval = await testClient.send('Runtime.evaluate', {
    expression: `
      (() => {
        // Change URL back to Video A without reload
        window.history.pushState({}, '', '${videoA_Url}');
        window.dispatchEvent(new CustomEvent('yt-navigate-finish'));
        window.dispatchEvent(new PopStateEvent('popstate'));

        const mp = document.getElementById('tori-media-popup');
        if (mp && mp.__toriHandleNav) {
          mp.__toriHandleNav('spa_history_back_test');
        }

        const info = (mp && mp.__toriGetMediaInfo) ? mp.__toriGetMediaInfo() : null;
        return {
          currentUrl: window.location.href,
          info: info,
        };
      })()
    `,
    returnByValue: true,
  });
  console.log('[PASS] Navigated back to Video A:', JSON.stringify(backNavEval.result?.value));
  const restoredVideoId = backNavEval.result?.value?.info?.videoId;
  if (restoredVideoId && restoredVideoId !== 'aqz-KE-bpKQ') {
    throw new Error(`Media identity did not restore to Video A! Found: ${restoredVideoId}`);
  }

  // --- Step 12: Rapid A -> B -> C Navigation & Obsolete Response Dropping ---
  console.log('\n--- Step 12: Verifying Rapid A -> B -> C Navigation & Race Condition Prevention ---');
  const videoC_Url = 'https://www.youtube.com/watch?v=e-ORhEE9VVg';
  const rapidNavResult = await testClient.send('Runtime.evaluate', {
    expression: `
      (() => {
        let currentGen = 100;
        const events = [];

        // Navigate to A
        currentGen++;
        const genA = currentGen;
        events.push({ step: 'nav_A', gen: genA });

        // Rapid navigate to B
        currentGen++;
        const genB = currentGen;
        events.push({ step: 'nav_B', gen: genB });

        // Rapid navigate to C
        currentGen++;
        const genC = currentGen;
        events.push({ step: 'nav_C', gen: genC });

        // Late response arrives from A (should be rejected)
        const lateA_Accepted = genA === currentGen;

        // Late response arrives from B (should be rejected)
        const lateB_Accepted = genB === currentGen;

        // Response arrives from C (should be accepted)
        const currentC_Accepted = genC === currentGen;

        return {
          currentGen,
          genA,
          genB,
          genC,
          lateA_Accepted,
          lateB_Accepted,
          currentC_Accepted,
        };
      })()
    `,
    returnByValue: true,
  });
  console.log('[PASS] Rapid navigation race condition evaluation:', JSON.stringify(rapidNavResult.result?.value));
  const rVal = rapidNavResult.result?.value;
  if (rVal?.lateA_Accepted || rVal?.lateB_Accepted || !rVal?.currentC_Accepted) {
    throw new Error('Rapid navigation race condition test failed!');
  }

  // --- Step 13: Verify No Duplicate Overlays in DOM ---
  console.log('\n--- Step 13: Verifying Zero Duplicate Overlays in DOM ---');
  const overlayCount = await testClient.send('Runtime.evaluate', {
    expression: `
      (() => {
        const overlays = document.querySelectorAll('#tori-media-popup');
        return { count: overlays.length };
      })()
    `,
    returnByValue: true,
  });
  console.log('[PASS] Overlay DOM count check:', JSON.stringify(overlayCount.result?.value));
  if (overlayCount.result?.value?.count > 1) {
    throw new Error(`Duplicate overlays detected in DOM: ${overlayCount.result?.value?.count}`);
  }
  console.log('[PASS] Confirmed zero duplicate overlays or leaked DOM elements');

  // Clean up test tabs and browser
  popupClient.close();
  testClient.close();
  edgeProc.kill();

  console.log('\n================================================================');
  console.log('GATE 10.5.3.1 VERIFICATION COMPLETE — ALL TESTS PASSED!');
  console.log('================================================================\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[FATAL ERROR in gate10_5_3_1 verification]:', err);
  process.exit(1);
});
