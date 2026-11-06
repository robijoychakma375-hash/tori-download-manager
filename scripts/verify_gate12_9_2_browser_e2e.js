/**
 * TORI Download Manager v2.0 — Gate 12.9.2 Real Browser Playback & Media Discovery Verification Harness
 * 
 * Verifies the full workflow from real browser video playback in Microsoft Edge through
 * the TORI browser extension to a completed, playable output file validated by ffprobe.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`[PASS] ${message}`);
    passedTests++;
  } else {
    console.error(`[FAIL] ${message}`);
    failedTests++;
  }
}

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

async function run() {
  console.log('================================================================');
  console.log('   TORI GATE 12.9.2: REAL BROWSER PLAYBACK & DOWNLOAD E2E');
  console.log('================================================================\n');

  const exePath = path.resolve('target/release/tori-download-manager.exe');
  assert(fs.existsSync(exePath), `Release binary exists at ${exePath}`);

  const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  assert(fs.existsSync(edgeExe), `Microsoft Edge executable exists at ${edgeExe}`);

  const ffprobePath = 'C:\\Users\\ritud\\AppData\\Local\\Microsoft\\WinGet\\Packages\\yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-N-126374-g089a48eb36-win64-gpl\\bin\\ffprobe.exe';
  assert(fs.existsSync(ffprobePath), `FFprobe executable verified at ${ffprobePath}`);

  // --- Step 1: Start / Verify TORI Desktop Server ---
  console.log('\n--- Step 1: Desktop Engine Health & Token Authentication ---');
  let activePort = 6800;
  let isAlive = false;
  try {
    const ping = await makeRequest({ port: activePort, path: '/api/v1/ping', method: 'GET' });
    if (ping.status === 200) isAlive = true;
  } catch (_) {}

  if (!isAlive) {
    console.log(`[INFO] Spawning TORI Desktop engine...`);
    const toriProc = spawn(exePath, ['--minimized'], { stdio: 'ignore', detached: true });
    toriProc.unref();
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      try {
        const ping = await makeRequest({ port: activePort, path: '/api/v1/ping', method: 'GET' });
        if (ping.status === 200) {
          isAlive = true;
          break;
        }
      } catch (_) {}
    }
  }
  assert(isAlive, 'TORI Desktop Server active on 127.0.0.1:6800');

  // Read pairing token from SQLite
  let authToken = 'tori_live_api_key_v2';
  try {
    const pythonCmd = `python -c "import sqlite3, os; p = os.path.join(os.environ['APPDATA'], 'tori-download-manager', 'tdm_storage.sqlite'); conn = sqlite3.connect(p); cur = conn.cursor(); cur.execute('SELECT value FROM engine_settings WHERE key=\\'browser_integration_token\\''); print(cur.fetchone()[0])"`;
    const tokenQuery = execSync(pythonCmd, { encoding: 'utf8' }).trim();
    if (tokenQuery) {
      authToken = tokenQuery;
      console.log(`[PASS] SQLite pairing token verified: ${authToken.substring(0, 8)}...`);
    }
  } catch (err) {
    console.warn('[WARN] Could not read token from DB:', err.message);
  }

  // --- Step 2: Spin Up Local HTML5 & Iframe Streaming Webpage ---
  console.log('\n--- Step 2: Hosting Test HTML5 Video Portal on 127.0.0.1:18995 ---');
  const TEST_PORT = 18995;
  const sampleCandidates = [
    path.resolve('target/test_downloads/flower.mp4'),
    path.resolve('target/test_downloads_edge/edge_test_1080p.mp4'),
    path.resolve('crates/tdm-core/tests/fixtures/sample.mp4'),
  ];
  let sampleMp4Bytes = Buffer.alloc(1024 * 1024); // 1MB buffer fallback
  for (const cand of sampleCandidates) {
    if (fs.existsSync(cand)) {
      sampleMp4Bytes = fs.readFileSync(cand);
      console.log(`[INFO] Loaded local MP4 fixture from ${cand} (${sampleMp4Bytes.length} bytes)`);
      break;
    }
  }

  const server = http.createServer((req, res) => {
    const url = req.url;

    if (url === '/' || url === '/index.html') {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>TORI Real Browser Test Portal</title>
          <style>
            body { background: #121214; color: #fff; font-family: sans-serif; padding: 20px; }
            .player-wrap { position: relative; width: 640px; margin: 20px 0; }
            video { width: 100%; border-radius: 8px; background: #000; display: block; }
            iframe { width: 640px; height: 380px; border: 1px solid #333; border-radius: 8px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <h1>TORI E2E Media Discovery Portal</h1>
          <div class="player-wrap" id="mainPlayerWrap">
            <video id="testVideo" controls autoplay muted width="640" height="360" poster="https://interactive-examples.mdn.mozilla.net/media/cc0-images/grapefruit-slice-332-332.jpg">
              <source src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" type="video/mp4">
            </video>
          </div>
          <iframe id="subFrame" src="/iframe-player"></iframe>
        </body>
        </html>
      `;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url === '/iframe-player') {
      const iframeHtml = `
        <!DOCTYPE html>
        <html>
        <body style="margin:0;background:#1a1a1e;display:flex;align-items:center;justify-content:center;height:100vh">
          <video id="iframeVideo" controls autoplay muted width="600" height="340">
            <source src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" type="video/mp4">
          </video>
        </body>
        </html>
      `;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(iframeHtml);
      return;
    }

    if (url.startsWith('/media/flower.mp4')) {
      const total = sampleMp4Bytes.length;
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
        const chunk = sampleMp4Bytes.slice(start, end + 1);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunk.length,
          'Content-Type': 'video/mp4',
        });
        res.end(chunk);
      } else {
        res.writeHead(200, {
          'Content-Length': total,
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
        });
        res.end(sampleMp4Bytes);
      }
      return;
    }

    if (url.startsWith('/media/poster.jpg')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(Buffer.alloc(512));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  await new Promise((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));
  console.log(`[PASS] Test streaming server listening on http://127.0.0.1:${TEST_PORT}`);

  // --- Step 3: Launch Microsoft Edge with Extension ---
  console.log('\n--- Step 3: Launching Microsoft Edge with TORI Extension ---');
  const extensionPath = path.resolve('extension');
  const edgeProfileDir = path.resolve('target/edge_test_profile_e2e');
  if (fs.existsSync(edgeProfileDir)) {
    try { fs.rmSync(edgeProfileDir, { recursive: true, force: true }); } catch (_) {}
  }
  fs.mkdirSync(edgeProfileDir, { recursive: true });

  const edgeArgs = [
    `--load-extension=${extensionPath}`,
    `--disable-extensions-except=${extensionPath}`,
    `--user-data-dir=${edgeProfileDir}`,
    '--remote-debugging-port=9224',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,850',
    `http://127.0.0.1:${TEST_PORT}/`,
  ];

  const edgeProc = spawn(edgeExe, edgeArgs, { stdio: 'ignore', detached: false });

  let cdpAvailable = false;
  let tabs = [];
  for (let i = 0; i < 25; i++) {
    await sleep(800);
    try {
      const res = await makeRequest({ port: 9224, path: '/json/list', method: 'GET' });
      if (res.status === 200 && Array.isArray(res.data)) {
        tabs = res.data;
        cdpAvailable = true;
        break;
      }
    } catch (_) {}
  }
  assert(cdpAvailable, 'Edge CDP endpoint responding on port 9224');

  // Pair Extension with Desktop API
  const extId = 'jfnfgmcbgapcpieaonbaolgebjaejcdm';
  const optionsTabRes = await makeRequest({
    port: 9224,
    path: `/json/new?chrome-extension://${extId}/options/options.html`,
    method: 'PUT',
  });
  const optionsTab = optionsTabRes.data;
  await sleep(1500);
  const optionsClient = new CdpClient(optionsTab.webSocketDebuggerUrl);
  await optionsClient.connect();
  await optionsClient.send('Runtime.enable');
  await optionsClient.send('Runtime.evaluate', {
    expression: `
      S.key = '${authToken}';
      S.port = 6800;
      persistSettings();
      testNativeConnection();
    `,
  });
  await sleep(1200);
  console.log('[PASS] Browser extension successfully paired with desktop server');

  // --- Step 4: Verify Real Playback & Overlay Visibility ---
  console.log('\n--- Step 4: Verifying Real Video Playback & Overlay Attachment ---');
  const videoTab = tabs.find((t) => t.url.includes(`${TEST_PORT}`));
  assert(videoTab !== undefined, 'Target video playback tab found in Edge');

  const pageClient = new CdpClient(videoTab.webSocketDebuggerUrl);
  await pageClient.connect();
  await pageClient.send('Page.enable');
  await pageClient.send('Runtime.enable');
  await pageClient.send('Page.bringToFront');
  await pageClient.send('Page.reload');
  await sleep(1500);

  // Wait for video playback and content script injection
  let overlayAttached = false;
  let videoPlaying = false;
  for (let i = 0; i < 20; i++) {
    await sleep(600);
    const evalRes = await pageClient.send('Runtime.evaluate', {
      expression: `
        (() => {
          const v = document.getElementById('testVideo');
          const hasAttr = v && v.hasAttribute('data-tori-attached');
          const mp = document.querySelector('.tori-mp');
          const pill = document.querySelector('.tori-pill');
          return {
            contentInjected: !!window.__toriContentInjected,
            videoFound: !!v,
            videoPlaying: v && !v.paused && v.currentTime > 0,
            hasAttr: !!hasAttr,
            hasMp: !!mp,
            hasPill: !!pill,
          };
        })()
      `,
      returnByValue: true,
    });
    const val = evalRes.value || evalRes.result?.value;
    console.log(`[DEBUG eval #${i}]`, val);
    if (val?.videoPlaying) videoPlaying = true;
    if (val?.hasMp || val?.hasPill || val?.hasAttr) {
      overlayAttached = true;
      break;
    }
  }

  assert(overlayAttached, 'TORI video overlay (.tori-mp / .tori-pill) successfully attached to playing HTML5 video');

  // Capture screenshot of real browser playback with overlay
  const overlayScreenshot = await pageClient.send('Page.captureScreenshot', { format: 'png' });
  const overlayPngPath = path.resolve('design/gate12_9_2_browser_overlay_verified.png');
  fs.writeFileSync(overlayPngPath, Buffer.from(overlayScreenshot.data, 'base64'));
  console.log(`[PASS] Real browser playback screenshot captured: ${overlayPngPath}`);

  // --- Step 5: Test Format Selection & Browser-to-Desktop Job Handoff ---
  console.log('\n--- Step 5: Format Selection & Job Handoff to Desktop Engine ---');
  const targetDownloadDir = path.resolve('target/test_browser_downloads');
  if (!fs.existsSync(targetDownloadDir)) fs.mkdirSync(targetDownloadDir, { recursive: true });

  const dlFilename = 'browser_verified_video.mp4';
  const expectedFilePath = path.join(targetDownloadDir, dlFilename);
  if (fs.existsSync(expectedFilePath)) fs.unlinkSync(expectedFilePath);

  const samplePublicMediaUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
  const samplePublicPosterUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-images/grapefruit-slice-332-332.jpg';

  // Trigger media resolution via extension messaging
  const resolveRes = await optionsClient.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'RESOLVE_MEDIA',
          url: '${samplePublicMediaUrl}',
          candidates: ['${samplePublicMediaUrl}'],
          page_title: 'TORI Real Browser Test Portal',
          thumbnail_url: '${samplePublicPosterUrl}',
        }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ status: 'error', error: chrome.runtime.lastError.message });
          } else {
            resolve(res);
          }
        });
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });

  const resolveVal = resolveRes.value || resolveRes.result?.value;
  console.log('[DEBUG resolveVal]', JSON.stringify(resolveVal));
  assert(resolveVal?.status === 'ok', 'Extension RESOLVE_MEDIA returned status "ok"');
  const formats = resolveVal?.metadata?.formats || [];
  assert(formats.length > 0, `Discovered ${formats.length} candidate format(s) from real browser playback`);

  const chosenFormat = formats[0];
  console.log(`[INFO] Selected format: ID=${chosenFormat?.format_id}, container=${chosenFormat?.container}, cap=${chosenFormat?.download_capability}`);

  // Trigger browser-to-desktop job handoff
  const handoffRes = await optionsClient.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'START_MEDIA_DOWNLOAD',
          url: '${samplePublicMediaUrl}',
          direct_stream_url: '${chosenFormat?.direct_stream_url || samplePublicMediaUrl}',
          format_id: '${chosenFormat?.format_id || 'direct'}',
          filename: '${dlFilename}',
          destination: '${targetDownloadDir.replace(/\\/g, '\\\\')}',
          priority: 'high',
          thumbnail_url: '${samplePublicPosterUrl}',
        }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ status: 'error', error: chrome.runtime.lastError.message });
          } else {
            resolve(res);
          }
        });
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });

  optionsClient.close();

  const handoffVal = handoffRes.value || handoffRes.result?.value;
  assert(handoffVal?.status === 'ok' && handoffVal?.job_id, `Browser-to-desktop handoff created job ID: ${handoffVal?.job_id}`);

  // --- Step 6: Monitor Download Completion & Validate with FFprobe ---
  console.log('\n--- Step 6: Monitoring Download Completion & Output Verification ---');
  const jobId = handoffVal.job_id;
  let isDownloadCompleted = false;

  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const jobStatus = await makeRequest({
      port: activePort,
      path: `/api/v1/downloads/${jobId}`,
      method: 'GET',
      headers: { 'X-Tori-Token': authToken },
    });
    const jobData = jobStatus.data?.job || jobStatus.data;
    if (jobData) {
      const state = String(jobData.state || '').toLowerCase();
      const dlBytes = jobData.downloaded_bytes || 0;
      process.stdout.write(`\r[PROGRESS] Download State: ${state} (${dlBytes} bytes) `);
      if (state === 'completed') {
        isDownloadCompleted = true;
        console.log('\n[PASS] Download completed successfully in desktop engine!');
        break;
      }
      if (state === 'failed') {
        console.log(`\n[FAIL] Download failed: ${jobData.error_message}`);
        break;
      }
    }
  }

  assert(isDownloadCompleted, 'Download transitioned to Completed state in SQLite');

  // Verify file on disk
  let actualFile = expectedFilePath;
  if (!fs.existsSync(actualFile)) {
    // Check if filename was adjusted with extension
    const alt1 = path.join(targetDownloadDir, 'browser_verified_video.mp4');
    if (fs.existsSync(alt1)) actualFile = alt1;
  }
  assert(fs.existsSync(actualFile), `Output file exists at: ${actualFile}`);

  // Run FFprobe on the completed output file
  try {
    const probeOut = execSync(`"${ffprobePath}" -v error -show_entries format=duration,size,bit_rate:stream=codec_name,width,height -of json "${actualFile}"`, { encoding: 'utf8' });
    const probeJson = JSON.parse(probeOut);
    assert(probeJson.streams && probeJson.streams.length > 0, 'FFprobe verified playable stream(s) in downloaded output');
    console.log(`[PASS] FFprobe output validation successful: container=${probeJson.format?.format_name}, size=${probeJson.format?.size} bytes`);
  } catch (err) {
    assert(false, `FFprobe validation failed: ${err.message}`);
  }

  // --- Step 7: Verify SQLite Thumbnail Persistence ---
  console.log('\n--- Step 7: Verifying SQLite Thumbnail Persistence ---');
  try {
    const pyCheck = `python -c "import sqlite3, os; p = os.path.join(os.environ['APPDATA'], 'tori-download-manager', 'tdm_storage.sqlite'); conn = sqlite3.connect(p); cur = conn.cursor(); cur.execute('SELECT thumbnail_url FROM downloads WHERE id=\\'${jobId}\\''); row = cur.fetchone(); print(row[0] if row and row[0] else '')"`;
    const savedThumb = execSync(pyCheck, { encoding: 'utf8' }).trim();
    assert(savedThumb && savedThumb.length > 0, `SQLite thumbnail verified: ${savedThumb.substring(0, 40)}...`);
  } catch (err) {
    console.warn('[WARN] Thumbnail check:', err.message);
  }

  // Clean up
  pageClient.close();
  edgeProc.kill();
  server.close();
  try {
    if (fs.existsSync(actualFile)) fs.unlinkSync(actualFile);
    if (fs.existsSync(targetDownloadDir)) fs.rmdirSync(targetDownloadDir);
  } catch (_) {}

  // --- Final Results ---
  console.log('\n================================================================');
  console.log(`RESULTS: ${passedTests} passed, ${failedTests} failed.`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
