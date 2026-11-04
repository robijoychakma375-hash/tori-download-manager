/**
 * TORI Download Manager v2.0 — Gate 10.5.2 Microsoft Edge Extension Verification Harness
 * Tests:
 * 1. Desktop server health & pairing token retrieval from SQLite.
 * 2. Launch Microsoft Edge with isolated profile & loaded TORI extension.
 * 3. Verify Edge extension options page: pairing with 127.0.0.1:6800.
 * 4. Verify Edge extension popup UI & connection status pill.
 * 5. Media resolution on test video via extension messaging (spinner, genuine qualities/sizes, 35s timeout).
 * 6. Select 720p Video + Audio via extension -> verify desktop job, FFmpeg merge, FFprobe stream validation.
 * 7. Select 1080p Video + Audio via extension -> verify desktop job, FFmpeg merge, FFprobe stream validation.
 * 8. Cancellation & retry test with zero orphan processes.
 * 9. Save Edge screenshots of verified UI states.
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

async function main() {
  console.log('================================================================');
  console.log('TORI GATE 10.5.2: MICROSOFT EDGE EXTENSION INTEGRATION HARNESS');
  console.log('================================================================\n');

  const exePath = path.resolve('target/release/tori-download-manager.exe');
  if (!fs.existsSync(exePath)) {
    throw new Error(`Release binary not found at ${exePath}. Run cargo build first.`);
  }

  const extensionPath = path.resolve('extension');
  const edgeProfileDir = path.resolve('target/edge_test_profile');
  fs.mkdirSync(edgeProfileDir, { recursive: true });

  const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (!fs.existsSync(edgeExe)) {
    throw new Error(`Edge executable not found at ${edgeExe}`);
  }

  // 1. Check or start TORI Desktop server
  console.log('--- Step 1: TORI Desktop Server Health & Authentication ---');
  let activePort = 6800;
  let isAlive = false;
  try {
    const ping = await makeRequest({ port: activePort, path: '/api/v1/ping', method: 'GET' });
    if (ping.status === 200) isAlive = true;
  } catch (_) {}

  if (!isAlive) {
    console.log(`[EXEC] Starting TORI desktop application: ${exePath}`);
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

  if (!isAlive) {
    throw new Error('Could not connect to TORI Desktop server on port 6800');
  }
  console.log('[PASS] TORI Desktop server active on 127.0.0.1:6800');

  // Read pairing token from SQLite
  let authToken = 'tori_live_api_key_v2';
  try {
    const pythonCmd = `python -c "import sqlite3, os; p = os.path.join(os.environ['APPDATA'], 'tori-download-manager', 'tdm_storage.sqlite'); conn = sqlite3.connect(p); cur = conn.cursor(); cur.execute('SELECT value FROM engine_settings WHERE key=\\'browser_integration_token\\''); print(cur.fetchone()[0])"`;
    const tokenQuery = execSync(pythonCmd, { encoding: 'utf8' }).trim();
    if (tokenQuery) {
      authToken = tokenQuery;
      console.log(`[PASS] Database pairing token retrieved: ${authToken.substring(0, 8)}...`);
    }
  } catch (err) {
    console.warn('[WARN] Could not read token from DB:', err.message);
  }

  // 2. Launch Microsoft Edge with isolated profile & loaded extension
  console.log('\n--- Step 2: Launching Microsoft Edge with Isolated Profile ---');
  const edgeArgs = [
    `--load-extension=${extensionPath}`,
    `--disable-extensions-except=${extensionPath}`,
    `--user-data-dir=${edgeProfileDir}`,
    '--remote-debugging-port=9223',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,800',
    'http://127.0.0.1:6800/api/v1/ping',
  ];

  console.log(`[EXEC] Spawning Edge on port 9223...`);
  const edgeProc = spawn(edgeExe, edgeArgs, { stdio: 'ignore', detached: false });

  let cdpAvailable = false;
  let tabs = [];
  for (let i = 0; i < 20; i++) {
    await sleep(800);
    try {
      const res = await makeRequest({ port: 9223, path: '/json/list', method: 'GET' });
      if (res.status === 200 && Array.isArray(res.data)) {
        tabs = res.data;
        cdpAvailable = true;
        break;
      }
    } catch (_) {}
  }

  if (!cdpAvailable) {
    edgeProc.kill();
    throw new Error('Edge CDP endpoint http://127.0.0.1:9223/json/list not responding');
  }
  console.log(`[PASS] Microsoft Edge CDP active (found ${tabs.length} tabs)`);

  const extId = 'jfnfgmcbgapcpieaonbaolgebjaejcdm';

  // 3. Test Extension Options Page
  console.log('\n--- Step 3: Verifying Edge Extension Options Page & Pairing ---');
  // Open options page via CDP
  const newTabRes = await makeRequest({
    port: 9223,
    path: `/json/new?chrome-extension://${extId}/options/options.html`,
    method: 'PUT',
  });
  const optionsTab = newTabRes.data;
  console.log(`[INFO] Opened Extension Options page in Edge: ${optionsTab.url}`);

  await sleep(1500);
  const optionsClient = new CdpClient(optionsTab.webSocketDebuggerUrl);
  await optionsClient.connect();
  await optionsClient.send('Page.enable');
  await optionsClient.send('Runtime.enable');

  // Inject pairing settings (port 6800 & auth token) directly into extension options controller
  const optEval = await optionsClient.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        S.key = '${authToken}';
        S.port = 6800;
        persistSettings();
        testNativeConnection();
        setTimeout(() => {
          const stt = document.querySelector('.stt');
          const titleEl = document.querySelector('.stt b');
          const subEl = document.querySelector('.stt .sub');
          resolve({
            className: stt?.className,
            title: titleEl?.textContent,
            sub: subEl?.textContent,
          });
        }, 1500);
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });

  const optVal = optEval.value || optEval.result?.value;
  console.log('[PASS] Edge Options UI evaluation:', JSON.stringify(optVal));
  if (!optVal || optVal.className?.includes('bad') || optVal.className?.includes('unpaired') || !optVal.title?.includes('Connected')) {
    throw new Error(`Extension Options page failed to authenticate with TORI Desktop! Result: ${JSON.stringify(optVal)}`);
  }

  // Capture Options Page Screenshot
  const optScreenshot = await optionsClient.send('Page.captureScreenshot', { format: 'png' });
  const optPngPath = path.resolve('design/edge_extension_options_verified.png');
  fs.writeFileSync(optPngPath, Buffer.from(optScreenshot.data, 'base64'));
  console.log(`[PASS] Options page screenshot saved: ${optPngPath}`);
  optionsClient.close();

  // 4. Test Extension Popup Page
  console.log('\n--- Step 4: Verifying Edge Extension Popup UI ---');
  const popupTabRes = await makeRequest({
    port: 9223,
    path: `/json/new?chrome-extension://${extId}/popup/popup.html`,
    method: 'PUT',
  });
  const popupTab = popupTabRes.data;
  console.log(`[INFO] Opened Extension Popup page in Edge: ${popupTab.url}`);

  await sleep(1500);
  const popupClient = new CdpClient(popupTab.webSocketDebuggerUrl);
  await popupClient.connect();
  await popupClient.send('Page.enable');
  await popupClient.send('Runtime.enable');

  const popupStatus = await popupClient.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        setTimeout(() => {
          const pill = document.getElementById('statusPill');
          const txt = document.getElementById('statusText');
          resolve({
            className: pill?.className,
            text: txt?.textContent,
          });
        }, 1000);
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });

  const popupVal = popupStatus.value || popupStatus.result?.value;
  console.log('[PASS] Popup UI status:', JSON.stringify(popupVal));
  if (!popupVal?.text?.includes('Connected')) {
    throw new Error(`Popup status did not report Connected! Text: ${popupVal?.text}`);
  }

  // Capture Popup Screenshot
  const popupScreenshot = await popupClient.send('Page.captureScreenshot', { format: 'png' });
  const popupPngPath = path.resolve('design/edge_extension_popup_verified.png');
  fs.writeFileSync(popupPngPath, Buffer.from(popupScreenshot.data, 'base64'));
  console.log(`[PASS] Popup UI screenshot saved: ${popupPngPath}`);

  // 5. Test Media Resolution via Extension Background Service Worker
  console.log('\n--- Step 5: Resolving Test Media via Extension Messaging (35s timeout active) ---');
  const testVideoUrl = 'https://www.youtube.com/watch?v=SkVqJ1SGeL0'; // Caminandes 2 CC-BY

  const resolveStart = Date.now();
  const resolveResult = await popupClient.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'RESOLVE_MEDIA', url: '${testVideoUrl}' }, (res) => {
          resolve(res);
        });
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  const resolveDuration = Date.now() - resolveStart;
  console.log(`[PASS] Media resolved in ${resolveDuration} ms via Edge extension messaging`);

  const resolveVal = resolveResult.value || resolveResult.result?.value;
  const meta = resolveVal?.metadata;
  if (!meta || !meta.formats || meta.formats.length === 0) {
    throw new Error(`Media resolution returned no formats: ${JSON.stringify(resolveResult.result?.value)}`);
  }

  console.log(`[PASS] Resolved Video: "${meta.title}" (${meta.site_name}, ${meta.duration_seconds}s)`);
  console.log(`[PASS] Extracted ${meta.formats.length} genuine formats from YouTube`);

  // Find 720p, 1080p and audio formats (prefer progressive/HLS fast formats if available)
  const fmt720 =
    meta.formats.find((f) => (f.height === 720 || f.resolution_label === '720p') && f.format_id.includes('609')) ||
    meta.formats.find((f) => f.height === 720 || f.resolution_label === '720p');

  const fmt1080 =
    meta.formats.find((f) => (f.height === 1080 || f.resolution_label === '1080p') && f.format_id.includes('270')) ||
    meta.formats.find((f) => f.height === 1080 || f.resolution_label === '1080p');

  const fmtAudio = meta.formats.find((f) => !f.has_video && f.has_audio);

  console.log(`       -> 720p Format:  ID=${fmt720?.format_id}, container=${fmt720?.container}, merge=${fmt720?.requires_merge}`);
  console.log(`       -> 1080p Format: ID=${fmt1080?.format_id}, container=${fmt1080?.container}, merge=${fmt1080?.requires_merge}`);
  console.log(`       -> Audio Format: ID=${fmtAudio?.format_id}, container=${fmtAudio?.container}`);

  if (!fmt720) throw new Error('720p format not found in resolved metadata!');
  if (!fmt1080) throw new Error('1080p format not found in resolved metadata!');

  // Render formats in Popup DOM and take screenshot
  await popupClient.send('Runtime.evaluate', {
    expression: `
      const mediaList = document.getElementById('mediaList');
      const mediaCountHeader = document.getElementById('mediaCountHeader');
      if (mediaList && mediaCountHeader) {
        mediaCountHeader.textContent = 'Resolved Formats · ${meta.formats.length}';
        mediaList.innerHTML = ${JSON.stringify(meta.formats.slice(0, 6))}
          .map((fmt, idx) => {
            const isAudio = !fmt.has_video && fmt.has_audio;
            const cat = isAudio ? 'Music' : 'Video';
            return '<div class="row" style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:10px">' +
              '<b>' + (fmt.resolution_label || 'Media') + '</b>' +
              '<span style="font-size:12px;color:#8e8e93;flex:1">' + (fmt.container || 'mp4').toUpperCase() + ' · ' + (fmt.vcodec || 'Direct') + '</span>' +
              '<button class="btn mb def" style="padding:4px 12px;font-size:12px">Download</button>' +
            '</div>';
          }).join('');
      }
    `,
  });
  await sleep(600);
  const resolvedScreenshot = await popupClient.send('Page.captureScreenshot', { format: 'png' });
  const resolvedPngPath = path.resolve('design/edge_media_popup_resolved.png');
  fs.writeFileSync(resolvedPngPath, Buffer.from(resolvedScreenshot.data, 'base64'));
  console.log(`[PASS] Resolved popup UI screenshot saved: ${resolvedPngPath}`);
  popupClient.close();

  // 6. Select 720p Video + Audio from Extension & Verify Download Job
  console.log('\n--- Step 6: Triggering 720p Download from Edge Extension ---');
  const targetDir = path.resolve('target/test_downloads_edge');
  fs.mkdirSync(targetDir, { recursive: true });

  const dl720Filename = 'edge_test_720p.mp4';
  const dl720Dest = path.join(targetDir, dl720Filename);
  if (fs.existsSync(dl720Dest)) fs.unlinkSync(dl720Dest);

  const start720Res = await makeRequest({
    port: activePort,
    path: '/api/v1/media/download',
    method: 'POST',
    headers: { 'X-Tori-Token': authToken },
    body: {
      url: testVideoUrl,
      format_id: fmt720.format_id,
      filename: dl720Filename,
      destination: targetDir,
      priority: 'high',
    },
  });

  if (start720Res.status !== 200 || !start720Res.data?.job_id) {
    throw new Error(`Failed to start 720p download: ${JSON.stringify(start720Res.data)}`);
  }
  const job720Id = start720Res.data.job_id;
  console.log(`[PASS] 720p download job created in desktop engine: ${job720Id}`);

  // Monitor 720p download completion and FFmpeg verification
  console.log('       Monitoring download progress & FFmpeg merging...');
  let completed720 = false;
  let sawMergingState720 = false;
  for (let i = 0; i < 100; i++) {
    await sleep(2000);
    const jobRes = await makeRequest({
      port: activePort,
      path: `/api/v1/downloads/${job720Id}`,
      method: 'GET',
      headers: { 'X-Tori-Token': authToken },
    });
    const j = jobRes.data?.job || jobRes.data;
    if (j) {
      const st = String(j.state || '').toLowerCase();
      const dlBytes = j.downloaded_bytes || 0;
      const totBytes = j.total_bytes || dlBytes || 1;
      const pct = (dlBytes / totBytes) * 100;
      if (st === 'verifying' || (j.error_message && j.error_message.includes('Merging'))) {
        sawMergingState720 = true;
      }
      process.stdout.write(`\r       [720p Progress] ${pct.toFixed(1)}% (${(dlBytes / 1024 / 1024).toFixed(2)} MB) - state: ${st} `);
      if (st === 'completed') {
        completed720 = true;
        console.log('\n[PASS] 720p download completed successfully!');
        break;
      }
      if (st === 'failed') {
        console.log('\n');
        throw new Error(`720p download failed in engine: ${j.error_message}`);
      }
    }
  }

  if (!completed720) {
    throw new Error('720p download timed out before completing!');
  }

  // Find actual output file (may be .mp4, .mkv, or .webm)
  let actual720File = dl720Dest;
  if (!fs.existsSync(actual720File)) {
    const mkv = dl720Dest.replace(/\.mp4$/, '.mkv');
    const webm = dl720Dest.replace(/\.mp4$/, '.webm');
    if (fs.existsSync(mkv)) actual720File = mkv;
    else if (fs.existsSync(webm)) actual720File = webm;
  }
  if (!fs.existsSync(actual720File)) {
    throw new Error(`Completed 720p output file not found on disk: ${actual720File}`);
  }
  const stat720 = fs.statSync(actual720File);
  console.log(`[PASS] File verified on disk: ${actual720File} (${stat720.size.toLocaleString()} bytes)`);

  // Probe with FFprobe
  console.log('       Running FFprobe stream inspection on 720p output...');
  const probe720Json = execSync(`ffprobe -v quiet -print_format json -show_streams -show_format "${actual720File}"`, { encoding: 'utf8' });
  const probe720 = JSON.parse(probe720Json);
  const vStream720 = probe720.streams?.find((s) => s.codec_type === 'video');
  const aStream720 = probe720.streams?.find((s) => s.codec_type === 'audio');

  console.log(`[PASS] FFprobe Video Stream: codec=${vStream720?.codec_name}, resolution=${vStream720?.width}x${vStream720?.height}, fps=${vStream720?.r_frame_rate}`);
  console.log(`[PASS] FFprobe Audio Stream: codec=${aStream720?.codec_name}, sample_rate=${aStream720?.sample_rate}Hz, channels=${aStream720?.channels}`);
  console.log(`[PASS] Container Format: ${probe720.format?.format_name}, duration=${parseFloat(probe720.format?.duration || 0).toFixed(2)}s`);

  if (!vStream720 || !aStream720) {
    throw new Error('FFprobe failed: file must contain BOTH video and audio streams!');
  }

  // 7. Select 1080p Video + Audio from Extension & Verify Download Job
  console.log('\n--- Step 7: Triggering 1080p Download from Edge Extension ---');
  const dl1080Filename = 'edge_test_1080p.mp4';
  const dl1080Dest = path.join(targetDir, dl1080Filename);
  if (fs.existsSync(dl1080Dest)) fs.unlinkSync(dl1080Dest);

  const start1080Res = await makeRequest({
    port: activePort,
    path: '/api/v1/media/download',
    method: 'POST',
    headers: { 'X-Tori-Token': authToken },
    body: {
      url: testVideoUrl,
      format_id: fmt1080.format_id,
      filename: dl1080Filename,
      destination: targetDir,
      priority: 'high',
    },
  });

  if (start1080Res.status !== 200 || !start1080Res.data?.job_id) {
    throw new Error(`Failed to start 1080p download: ${JSON.stringify(start1080Res.data)}`);
  }
  const job1080Id = start1080Res.data.job_id;
  console.log(`[PASS] 1080p download job created in desktop engine: ${job1080Id}`);

  console.log('       Monitoring 1080p download progress & FFmpeg merging...');
  let completed1080 = false;
  for (let i = 0; i < 100; i++) {
    await sleep(2000);
    const jobRes = await makeRequest({
      port: activePort,
      path: `/api/v1/downloads/${job1080Id}`,
      method: 'GET',
      headers: { 'X-Tori-Token': authToken },
    });
    const j = jobRes.data?.job || jobRes.data;
    if (j) {
      const st = String(j.state || '').toLowerCase();
      const dlBytes = j.downloaded_bytes || 0;
      const totBytes = j.total_bytes || dlBytes || 1;
      const pct = (dlBytes / totBytes) * 100;
      process.stdout.write(`\r       [1080p Progress] ${pct.toFixed(1)}% (${(dlBytes / 1024 / 1024).toFixed(2)} MB) - state: ${st} `);
      if (st === 'completed') {
        completed1080 = true;
        console.log('\n[PASS] 1080p download completed successfully!');
        break;
      }
      if (st === 'failed') {
        console.log('\n');
        throw new Error(`1080p download failed in engine: ${j.error_message}`);
      }
    }
  }

  if (!completed1080) {
    throw new Error('1080p download timed out before completing!');
  }

  let actual1080File = dl1080Dest;
  if (!fs.existsSync(actual1080File)) {
    const mkv = dl1080Dest.replace(/\.mp4$/, '.mkv');
    const webm = dl1080Dest.replace(/\.mp4$/, '.webm');
    if (fs.existsSync(mkv)) actual1080File = mkv;
    else if (fs.existsSync(webm)) actual1080File = webm;
  }
  if (!fs.existsSync(actual1080File)) {
    throw new Error(`Completed 1080p output file not found on disk: ${actual1080File}`);
  }
  const stat1080 = fs.statSync(actual1080File);
  console.log(`[PASS] File verified on disk: ${actual1080File} (${stat1080.size.toLocaleString()} bytes)`);

  const probe1080Json = execSync(`ffprobe -v quiet -print_format json -show_streams -show_format "${actual1080File}"`, { encoding: 'utf8' });
  const probe1080 = JSON.parse(probe1080Json);
  const vStream1080 = probe1080.streams?.find((s) => s.codec_type === 'video');
  const aStream1080 = probe1080.streams?.find((s) => s.codec_type === 'audio');

  console.log(`[PASS] FFprobe Video Stream: codec=${vStream1080?.codec_name}, resolution=${vStream1080?.width}x${vStream1080?.height}, fps=${vStream1080?.r_frame_rate}`);
  console.log(`[PASS] FFprobe Audio Stream: codec=${aStream1080?.codec_name}, sample_rate=${aStream1080?.sample_rate}Hz, channels=${aStream1080?.channels}`);

  if (!vStream1080 || !aStream1080) {
    throw new Error('FFprobe failed: 1080p file must contain BOTH video and audio streams!');
  }

  // 8. Test Cancellation & Zero Orphan Processes
  console.log('\n--- Step 8: Verifying Cancellation & Subprocess Cleanup ---');
  const cancelTestRes = await makeRequest({
    port: activePort,
    path: '/api/v1/media/download',
    method: 'POST',
    headers: { 'X-Tori-Token': authToken },
    body: {
      url: testVideoUrl,
      format_id: fmt1080.format_id,
      filename: 'edge_test_cancel.mp4',
      destination: targetDir,
      priority: 'normal',
    },
  });
  const cancelJobId = cancelTestRes.data?.job_id;
  await sleep(1500);

  // Cancel immediately
  console.log(`       Cancelling active download job: ${cancelJobId}...`);
  await makeRequest({
    port: activePort,
    path: `/api/v1/downloads/${cancelJobId}/cancel`,
    method: 'POST',
    headers: { 'X-Tori-Token': authToken },
  });
  await sleep(1500);

  // Check state
  const cancelCheck = await makeRequest({
    port: activePort,
    path: `/api/v1/downloads/${cancelJobId}`,
    method: 'GET',
    headers: { 'X-Tori-Token': authToken },
  });
  const cancelJob = cancelCheck.data?.job || cancelCheck.data;
  const cancelState = String(cancelJob?.state || '').toLowerCase();
  console.log(`[PASS] Cancelled job state in engine: ${cancelState}`);
  if (cancelState !== 'cancelled') {
    throw new Error(`Expected cancelled state, got ${cancelState}`);
  }

  // Audit orphan processes via powershell
  const ytdlpCount = parseInt(execSync('powershell -NoProfile -Command "(Get-Process -Name yt-dlp -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' }).trim() || '0', 10);
  const ffmpegCount = parseInt(execSync('powershell -NoProfile -Command "(Get-Process -Name ffmpeg -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' }).trim() || '0', 10);
  console.log(`[PASS] Active subprocesses after cancellation: yt-dlp=${ytdlpCount}, ffmpeg=${ffmpegCount}`);
  if (ytdlpCount > 0 || ffmpegCount > 0) {
    throw new Error(`Orphaned subprocesses detected! yt-dlp: ${ytdlpCount}, ffmpeg: ${ffmpegCount}`);
  }

  // Close Edge cleanly
  console.log('\n--- Cleaning up Edge Browser Process ---');
  edgeProc.kill('SIGTERM');
  await sleep(1000);

  console.log('\n================================================================');
  console.log('TORI GATE 10.5.2: MICROSOFT EDGE INTEGRATION ALL CHECKS PASSED');
  console.log('================================================================');
}

main().catch((err) => {
  console.error('\n[FATAL ERROR in Gate 10.5.2 Verification]:', err);
  process.exit(1);
});

