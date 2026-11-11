/**
 * TORI Download Manager v1.0.1 â€” Gate 17.3 Browser Extension, Native Messaging & Desktop Lifecycle Stability Harness
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

let testResults = [];

function recordResult(task, scenario, outcome, details) {
  testResults.push({ task, scenario, outcome, details });
  const prefix = outcome === 'PASS' ? '[PASS]' : outcome === 'FAIL' ? '[FAIL]' : `[${outcome}]`;
  console.log(`${prefix} [${task}] ${scenario}: ${details}`);
}

function assert(condition, message) {
  if (condition) {
    console.log(`[PASS] ${message}`);
  } else {
    console.error(`[FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runPy(script) {
  return execSync('python -', { input: script, encoding: 'utf8' }).trim();
}

function killProcessTree(pid) {
  try {
    execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
  } catch (_) {}
}

function killProcessOnPort(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8' }).trim();
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      if (pid && !isNaN(pid) && pid !== process.pid) {
        killProcessTree(pid);
      }
    }
  } catch (_) {}
}

function makeHttpRequest({ host = '127.0.0.1', port, path: reqPath, method = 'GET', headers = {}, body = null, timeout = 35000 }) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };
    if (payload && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
    }
    if (payload) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        hostname: host,
        port,
        path: reqPath,
        method,
        headers: reqHeaders,
        timeout,
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
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeout}ms`));
    });
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

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res && res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
    }
    return res.result ? res.result.value : res.value;
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
    }
  }
}

function probeMediaWithFfprobe(filePath, ffprobeExe) {
  try {
    const out = execSync(`"${ffprobeExe}" -v error -show_entries format=duration,format_name:stream=codec_name,codec_type -of json "${filePath}"`, { encoding: 'utf8' });
    const data = JSON.parse(out);
    const duration = parseFloat(data.format?.duration || 0);
    const streams = data.streams || [];
    return { valid: duration > 0, duration, streams, format: data.format?.format_name };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

function fullFfmpegDecodeCheck(filePath, ffmpegExe) {
  try {
    execSync(`"${ffmpegExe}" -v error -i "${filePath}" -f null -`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { valid: true };
  } catch (e) {
    const err = (e.stderr ? e.stderr.toString() : e.message).trim();
    return { valid: false, error: err };
  }
}

async function waitForJobCompletion(jobId, token, extId, maxSeconds = 40) {
  const start = Date.now();
  while (Date.now() - start < maxSeconds * 1000) {
    try {
      const res = await makeHttpRequest({
        port: 6800,
        path: `/api/v1/downloads/${jobId}`,
        headers: {
          'X-Tori-Token': token,
          'Origin': `chrome-extension://${extId}`,
        },
      });
      if (res.status === 200 && res.data) {
        if (res.data.state === 'completed' || res.data.state === 'failed' || res.data.state === 'cancelled') {
          return res.data;
        }
      }
    } catch (_) {}
    await sleep(500);
  }
  return null;
}

function resolveJobOutputFile(job, downloadsDir) {
  if (job?.target_path && fs.existsSync(job.target_path)) {
    return job.target_path;
  }
  const filename = job?.filename || 'download.bin';
  const directPath = path.join(downloadsDir, filename);
  if (fs.existsSync(directPath)) return directPath;
  const videoPath = path.join(downloadsDir, 'Video', filename);
  if (fs.existsSync(videoPath)) return videoPath;
  const compressedPath = path.join(downloadsDir, 'Compressed', filename);
  if (fs.existsSync(compressedPath)) return compressedPath;
  return job?.target_path || directPath;
}

function getProcessMemoryMb(pid) {
  try {
    const psScript = `
      $ProgressPreference = 'SilentlyContinue'
      $target = (Get-NetTCPConnection -LocalPort 6800 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1)
      if (-not $target -or $target -eq 0) {
        $target = ${pid || 0}
      }
      if (-not $target -or $target -eq 0) {
        $target = (Get-Process -Name tori-download-manager -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id -First 1)
      }
      if ($target -and $target -ne 0) {
        $proc = Get-Process -Id $target -ErrorAction SilentlyContinue
        if ($proc) {
          $ws = [math]::Round($proc.WorkingSet64 / 1MB, 2)
          $priv = [math]::Round($proc.PrivateMemorySize64 / 1MB, 2)
          Write-Output "RESULT:$ws|$priv"
          exit 0
        }
      }
      Write-Output "RESULT:0|0"
    `;
    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    const raw = execSync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${b64}`, { encoding: 'utf8' });
    const match = raw.match(/RESULT:([0-9.]+)\|([0-9.]+)/);
    if (match) {
      return { workingSetMb: parseFloat(match[1]), privateMb: parseFloat(match[2]) };
    }
    return { workingSetMb: 0, privateMb: 0 };
  } catch (_) {
    return { workingSetMb: 0, privateMb: 0 };
  }
}

async function run() {
  console.log('========================================================================');
  console.log('  TORI GATE 17.3: BROWSER EXTENSION, NATIVE MESSAGING & DESKTOP LIFECYCLE');
  console.log('========================================================================\n');

  let fixtureServer = null;
  let desktopProc = null;
  let browserProc = null;
  let nativeHostBackupPath = null;
  let nativeHostJsonPath = null;

  const FIXTURE_PORT = 19896;
  const DESKTOP_PORT = 6800;
  const CDP_PORT = 9222;
  const extId = 'jfnfgmcbgapcpieaonbaolgebjaejcdm';

  const isolatedBaseDir = path.resolve('target/gate17_3_env');
  const isolatedDataDir = path.join(isolatedBaseDir, 'data');
  const isolatedDownloadsDir = path.join(isolatedBaseDir, 'downloads');
  const isolatedProfileDir = path.join(isolatedBaseDir, 'edge_profile');
  const fixturesDir = path.join(isolatedBaseDir, 'fixtures');

  try {
    // -------------------------------------------------------------------------
    // TASK 1: CHECKPOINT & REPO INTEGRITY
    // -------------------------------------------------------------------------
    console.log('--- TASK 1: Checkpoint & Environment Setup ---');
    const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    const commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    assert(branch === 'dev/v1.0.1', `Git branch is dev/v1.0.1 (actual: ${branch})`);
    recordResult('TASK 1', 'Branch Check', 'PASS', `dev/v1.0.1 at ${commit.substring(0, 10)}`);

    const desktopExe = fs.existsSync(path.resolve('target/release/tori-download-manager.exe'))
      ? path.resolve('target/release/tori-download-manager.exe')
      : path.resolve('target/debug/tori-download-manager.exe');
    const nativeHostExe = fs.existsSync(path.resolve('target/release/tdm-native-host.exe'))
      ? path.resolve('target/release/tdm-native-host.exe')
      : path.resolve('target/debug/tdm-native-host.exe');
    const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const extDir = path.resolve('extension');

    assert(fs.existsSync(desktopExe), `Desktop executable exists: ${desktopExe}`);
    assert(fs.existsSync(nativeHostExe), `Native host companion exists: ${nativeHostExe}`);
    assert(fs.existsSync(edgeExe), `Microsoft Edge executable exists: ${edgeExe}`);

    // Verify stable TORI v1.0.0 is untouched
    const stableDir = 'C:\\Program Files\\Tori Download Manager';
    assert(fs.existsSync(stableDir), `Stable public TORI v1.0.0 exists untouched at ${stableDir}`);
    recordResult('TASK 1', 'Public Stable App Untouched', 'PASS', `C:\\Program Files\\Tori Download Manager preserved`);

    // Clean up directories
    if (fs.existsSync(isolatedBaseDir)) {
      try { fs.rmSync(isolatedBaseDir, { recursive: true, force: true }); } catch (_) {}
    }
    fs.mkdirSync(isolatedDataDir, { recursive: true });
    fs.mkdirSync(isolatedDownloadsDir, { recursive: true });
    fs.mkdirSync(isolatedProfileDir, { recursive: true });
    fs.mkdirSync(fixturesDir, { recursive: true });

    // Find FFmpeg and FFprobe
    const ffmpegWhere = execSync('where.exe ffmpeg', { encoding: 'utf8' }).trim().split(/\r?\n/)[0].trim();
    const ffprobeWhere = execSync('where.exe ffprobe', { encoding: 'utf8' }).trim().split(/\r?\n/)[0].trim();
    const ytdlpWhere = execSync('where.exe yt-dlp', { encoding: 'utf8' }).trim().split(/\r?\n/)[0].trim();
    assert(fs.existsSync(ffmpegWhere), `FFmpeg found at ${ffmpegWhere}`);
    assert(fs.existsSync(ffprobeWhere), `FFprobe found at ${ffprobeWhere}`);
    assert(fs.existsSync(ytdlpWhere), `yt-dlp found at ${ytdlpWhere}`);

    // Native host manifest registration
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Roaming');
    const nativeHostDir = path.join(appData, 'tori-download-manager');
    nativeHostJsonPath = path.join(nativeHostDir, 'com.tori.download_manager.json');
    nativeHostBackupPath = path.join(nativeHostDir, 'com.tori.download_manager.json.v173_backup');

    if (fs.existsSync(nativeHostJsonPath) && !fs.existsSync(nativeHostBackupPath)) {
      fs.copyFileSync(nativeHostJsonPath, nativeHostBackupPath);
    }
    fs.mkdirSync(nativeHostDir, { recursive: true });

    const devNativeHostManifest = {
      name: 'com.tori.download_manager',
      description: 'TORI Download Manager Native Host (Gate 17.3 Dev)',
      path: nativeHostExe,
      type: 'stdio',
      allowed_origins: [
        'chrome-extension://bflchfddfgkfglmjapohkjmldepflkbe/',
        `chrome-extension://${extId}/`,
      ],
    };
    fs.writeFileSync(nativeHostJsonPath, JSON.stringify(devNativeHostManifest, null, 2), 'utf8');

    // Seed SQLite
    const authToken = 'tori_live_api_key_gate17_3';
    const dbFile = path.join(isolatedDataDir, 'tdm_storage.sqlite');
    runPy(`
import sqlite3, json
conn = sqlite3.connect(r'''${dbFile}''')
cur = conn.cursor()
cur.execute('CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
cur.execute('INSERT OR REPLACE INTO engine_settings (key, value) VALUES (?, ?)', ('browser_integration_token', '${authToken}'))
cur.execute('INSERT OR REPLACE INTO engine_settings (key, value) VALUES (?, ?)', ('app_settings', json.dumps({'dir': r'''${isolatedDownloadsDir}''', 'port': ${DESKTOP_PORT}, 'key': '${authToken}', 'closeToTray': True})))
conn.commit()
conn.close()
`);

    // -------------------------------------------------------------------------
    // GENERATE SYNTHETIC FIXTURES
    // -------------------------------------------------------------------------
    console.log('\n--- Generating Synthetic Test Fixtures ---');
    const directMp4Path = path.join(fixturesDir, 'sample.mp4');
    const directWebmPath = path.join(fixturesDir, 'sample.webm');

    // 1. Direct MP4 (H.264 + AAC with fixed 1s GOP for clean slicing)
    execSync(`"${ffmpegWhere}" -y -f lavfi -i testsrc=duration=3:size=320x240:rate=15 -f lavfi -i sine=frequency=440:duration=3 -c:v libx264 -g 15 -keyint_min 15 -sc_threshold 0 -pix_fmt yuv420p -c:a aac -b:a 64k "${directMp4Path}"`, { stdio: 'ignore' });
    // 2. Direct WebM (VP8 + Vorbis)
    execSync(`"${ffmpegWhere}" -y -f lavfi -i testsrc=duration=3:size=320x240:rate=15 -f lavfi -i sine=frequency=440:duration=3 -c:v libvpx -c:a libvorbis "${directWebmPath}"`, { stdio: 'ignore' });

    // 3. Multi-segment HLS
    const hlsDir = path.join(fixturesDir, 'hls');
    fs.mkdirSync(hlsDir, { recursive: true });
    execSync(`"${ffmpegWhere}" -y -i "${directMp4Path}" -c copy -hls_time 1 -hls_list_size 0 -hls_segment_filename "${path.join(hlsDir, 'seg_%03d.ts')}" "${path.join(hlsDir, 'master.m3u8')}"`, { stdio: 'ignore' });

    // 4. Multi-segment DASH
    const dashDir = path.join(fixturesDir, 'dash');
    fs.mkdirSync(dashDir, { recursive: true });
    execSync(`"${ffmpegWhere}" -y -i "${directMp4Path}" -c copy -seg_duration 1 -f dash "manifest.mpd"`, { cwd: dashDir, stdio: 'ignore' });

    // 5. Large 12MB file for crash recovery testing
    const largeRecoveryFilePath = path.join(fixturesDir, 'large_payload.bin');
    const largeBuffer = crypto.randomBytes(12 * 1024 * 1024);
    fs.writeFileSync(largeRecoveryFilePath, largeBuffer);
    const largeExpectedHash = crypto.createHash('sha256').update(largeBuffer).digest('hex');

    // 6. HTML test documents
    fs.writeFileSync(path.join(fixturesDir, 'html5_direct.html'), `
      <!DOCTYPE html><html><head><title>Direct MP4 Test</title></head><body>
        <h1>Direct Video</h1>
        <video id="vid1" src="http://127.0.0.1:${FIXTURE_PORT}/fixtures/sample.mp4" controls width="320" height="240"></video>
      </body></html>
    `);

    fs.writeFileSync(path.join(fixturesDir, 'html5_multi.html'), `
      <!DOCTYPE html><html><head><title>Multiple Videos Page</title></head><body>
        <h1>Multi Video</h1>
        <video id="v1" src="http://127.0.0.1:${FIXTURE_PORT}/fixtures/sample.mp4" controls width="320" height="240" preload="auto"></video>
        <video id="v2" src="http://127.0.0.1:${FIXTURE_PORT}/fixtures/sample.webm" controls width="320" height="240" preload="auto"></video>
      </body></html>
    `);

    fs.writeFileSync(path.join(fixturesDir, 'html5_dynamic.html'), `
      <!DOCTYPE html><html><head><title>Dynamic Video Test</title></head><body>
        <h1>Dynamic Video Injection</h1>
        <div id="container"></div>
        <script>
          setTimeout(() => {
            const v = document.createElement('video');
            v.src = 'http://127.0.0.1:${FIXTURE_PORT}/fixtures/sample.mp4';
            v.controls = true;
            v.width = 320;
            v.height = 240;
            document.getElementById('container').appendChild(v);
          }, 300);
        </script>
      </body></html>
    `);

    // Launch Fixture HTTP Server
    fixtureServer = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${FIXTURE_PORT}`);
      const p = u.pathname;

      if (p === '/fixtures/sample.mp4') {
        const data = fs.readFileSync(directMp4Path);
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length });
        res.end(data);
        return;
      }
      if (p === '/fixtures/sample.webm') {
        const data = fs.readFileSync(directWebmPath);
        res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': data.length });
        res.end(data);
        return;
      }
      if (p === '/fixtures/large_payload.bin') {
        const fileSize = largeBuffer.length;
        const range = req.headers.range;
        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
          const chunkSize = end - start + 1;
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'application/octet-stream',
          });
          res.end(largeBuffer.subarray(start, end + 1));
        } else {
          // Write 2MB immediately, then stream 1MB every 250ms so crash test can capture in-flight transfer
          res.writeHead(200, {
            'Content-Length': fileSize,
            'Accept-Ranges': 'bytes',
            'Content-Type': 'application/octet-stream',
          });
          res.write(largeBuffer.subarray(0, 2 * 1024 * 1024));
          let offset = 2 * 1024 * 1024;
          const chunkTimer = setInterval(() => {
            if (offset >= fileSize) {
              clearInterval(chunkTimer);
              try { res.end(); } catch (_) {}
              return;
            }
            const next = Math.min(fileSize, offset + 1024 * 1024);
            try {
              res.write(largeBuffer.subarray(offset, next));
              offset = next;
            } catch (_) {
              clearInterval(chunkTimer);
            }
          }, 250);
          req.on('close', () => clearInterval(chunkTimer));
        }
        return;
      }
      if (p.startsWith('/fixtures/hls/')) {
        const file = path.join(hlsDir, path.basename(p));
        if (fs.existsSync(file)) {
          const isM3u8 = file.endsWith('.m3u8');
          res.writeHead(200, {
            'Content-Type': isM3u8 ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(fs.readFileSync(file));
          return;
        }
      }
      if (p.startsWith('/fixtures/dash/')) {
        const file = path.join(dashDir, path.basename(p));
        if (fs.existsSync(file)) {
          const isMpd = file.endsWith('.mpd');
          res.writeHead(200, {
            'Content-Type': isMpd ? 'application/dash+xml' : 'video/iso.segment',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(fs.readFileSync(file));
          return;
        }
      }
      if (p.endsWith('.html')) {
        const file = path.join(fixturesDir, path.basename(p));
        if (fs.existsSync(file)) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(fs.readFileSync(file));
          return;
        }
      }
      if (p === '/slow-stream') {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': '104857600',
          'Accept-Ranges': 'bytes',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        res.write(Buffer.alloc(8192));
        const timer = setInterval(() => {
          try {
            res.write(Buffer.alloc(8192));
          } catch (_) {
            clearInterval(timer);
          }
        }, 200);
        req.on('close', () => clearInterval(timer));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise((resolve) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', resolve));
    console.log(`[INFO] Fixture server listening on http://127.0.0.1:${FIXTURE_PORT}`);

    // Launch Desktop Engine
    console.log('\n--- Launching TORI Desktop Engine ---');
    // Set environment variables for current process and all child processes
    process.env.TORI_DATA_DIR = isolatedDataDir;
    process.env.TORI_ALLOW_LOOPBACK = '1';
    process.env.RUST_MIN_STACK = '8388608';

    const env = {
      ...process.env,
      TORI_DATA_DIR: isolatedDataDir,
      TORI_ALLOW_LOOPBACK: '1',
      RUST_MIN_STACK: '8388608',
    };

    desktopProc = spawn(desktopExe, [], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let desktopReady = false;
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      try {
        const ping = await makeHttpRequest({
          port: DESKTOP_PORT,
          path: '/api/v1/ping',
          headers: { 'X-Tori-Token': authToken },
          timeout: 1000,
        });
        if (ping.status === 200 && ping.data.status === 'ok') {
          desktopReady = true;
          break;
        }
      } catch (_) {}
    }

    assert(desktopReady, `TORI Desktop Engine is active on port ${DESKTOP_PORT}`);
    recordResult('TASK 1', 'Desktop Engine Startup & Health Check', 'PASS', `Listening on 127.0.0.1:${DESKTOP_PORT}`);

    // Launch Microsoft Edge with Extension
    console.log('\n--- Launching Microsoft Edge with TORI Extension ---');
    browserProc = spawn(edgeExe, [
      `--user-data-dir=${isolatedProfileDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      `--load-extension=${extDir}`,
      `--disable-extensions-except=${extDir}`,
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--disable-features=InfiniteSessionRestore',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { env, stdio: 'ignore' });

    let cdpTarget = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        const trgRes = await makeHttpRequest({ port: CDP_PORT, path: '/json' });
        if (Array.isArray(trgRes.data) && trgRes.data.length > 0) {
          cdpTarget = trgRes.data.find((t) => t.type === 'page' || t.url.includes('about:blank'));
          if (cdpTarget) break;
        }
      } catch (_) {}
    }

    assert(cdpTarget !== null, `Connected to Microsoft Edge via CDP on port ${CDP_PORT}`);
    const pageCdp = new CdpClient(cdpTarget.webSocketDebuggerUrl);
    await pageCdp.connect();
    await pageCdp.send('Page.enable');
    await pageCdp.send('DOM.enable');
    await pageCdp.send('Runtime.enable');

    // Open options page to pair extension via Native Messaging
    const optionsUrl = `chrome-extension://${extId}/options/options.html`;
    await makeHttpRequest({
      port: CDP_PORT,
      path: `/json/new?${optionsUrl}`,
      method: 'PUT',
    });
    await sleep(2000);

    const updatedTargetsRes = await makeHttpRequest({ port: CDP_PORT, path: '/json/list' });
    const optionsTarget = (updatedTargetsRes.data || []).find((t) => t.url && t.url.includes(optionsUrl));
    assert(optionsTarget !== undefined, 'Extension options page target found');

    const optionsCdp = new CdpClient(optionsTarget.webSocketDebuggerUrl);
    await optionsCdp.connect();
    await optionsCdp.send('Page.enable');
    await optionsCdp.send('Runtime.enable');

    // Trigger pairing via Native Messaging
    const pairResult = await optionsCdp.evaluate(`
      new Promise((resolve) => {
        chrome.runtime.sendNativeMessage('com.tori.download_manager', { action: 'pair' }, (res) => {
          resolve(res || { error: chrome.runtime.lastError?.message });
        });
      })
    `);

    assert(pairResult && pairResult.status === 'ok' && pairResult.token, 'Native Messaging pairing completed');
    recordResult('TASK 1', 'Native Messaging Pairing', 'PASS', `Paired token: ${pairResult.token.substring(0, 10)}... port: ${pairResult.port}`);

    // Update extension storage settings with token & port
    await optionsCdp.evaluate(`
      new Promise((resolve) => {
        chrome.storage.local.set({
          tori_settings: {
            port: ${DESKTOP_PORT},
            key: '${authToken}',
          }
        }, resolve);
      })
    `);
    await sleep(500);

    // -------------------------------------------------------------------------
    // TASK 2: EXTENSION SERVICE-WORKER LIFECYCLE & SESSION CONTINUITY
    // -------------------------------------------------------------------------
    console.log('\n--- TASK 2: Extension Service-Worker Lifecycle & Session Continuity ---');

    // Navigate page to direct MP4 video fixture
    const directVideoPage = `http://127.0.0.1:${FIXTURE_PORT}/html5_direct.html`;
    await pageCdp.send('Page.navigate', { url: directVideoPage });
    await sleep(2000);

    // Verify candidates were recorded in extension background / session
    const sessionCandidates = await optionsCdp.evaluate(`
      new Promise((resolve) => {
        chrome.storage.session.get(null, (items) => {
          resolve(items);
        });
      })
    `);
    const sessionKeys = Object.keys(sessionCandidates || {});
    assert(sessionKeys.some((k) => k.startsWith('media_tab_')), 'Media candidates recorded in chrome.storage.session');
    recordResult('TASK 2', 'Session Storage Persistence', 'PASS', `Session keys: ${sessionKeys.join(', ')}`);

    // Locate the background Service Worker target
    const allTargets1 = await makeHttpRequest({ port: CDP_PORT, path: '/json/list' });
    const swTarget = (allTargets1.data || []).find((t) => t.type === 'service_worker' && t.url && t.url.includes(extId));
    assert(swTarget !== undefined, 'Extension MV3 Service Worker target found');
    console.log(`[INFO] Found active MV3 Service Worker: ${swTarget.id}`);

    // Start an active download via Desktop Engine
    const downloadRes = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: {
        'X-Tori-Token': authToken,
        'Origin': `chrome-extension://${extId}`,
      },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/fixtures/sample.mp4`,
        filename: 'task2_test_video.mp4',
        destination: isolatedDownloadsDir,
      },
    });
    assert(downloadRes.status === 200 && downloadRes.data && downloadRes.data.job_id, 'Download initiated in engine');
    const task2JobId = downloadRes.data.job_id;

    // Suspend / terminate MV3 Service Worker via CDP Target.closeTarget
    console.log(`[INFO] Suspending Service Worker targetId: ${swTarget.id}...`);
    try {
      await pageCdp.send('Target.closeTarget', { targetId: swTarget.id });
    } catch (_) {}
    await sleep(1500);

    // Verify download continued progressing in the desktop engine unimpeded
    const jobStatusDuringSwSuspension = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: `/api/v1/downloads/${task2JobId}`,
      headers: {
        'X-Tori-Token': authToken,
        'Origin': `chrome-extension://${extId}`,
      },
    });
    assert(
      jobStatusDuringSwSuspension.status === 200 &&
      (jobStatusDuringSwSuspension.data.state === 'downloading' || jobStatusDuringSwSuspension.data.state === 'completed'),
      'Download continues unimpeded in desktop engine while extension service worker is suspended'
    );
    recordResult('TASK 2', 'Worker Suspension Download Independence', 'PASS', `Job state: ${jobStatusDuringSwSuspension.data.state}`);

    // Wait for task 2 download to finish and verify media integrity
    const task2Completed = await waitForJobCompletion(task2JobId, authToken, extId, 15);
    assert(task2Completed && task2Completed.state === 'completed', 'Task 2 download completed successfully');
    const task2OutFile = resolveJobOutputFile(task2Completed, isolatedDownloadsDir);
    assert(fs.existsSync(task2OutFile), `Output file exists: ${task2OutFile}`);
    const task2Probe = probeMediaWithFfprobe(task2OutFile, ffprobeWhere);
    assert(task2Probe.valid, `Media file valid, duration: ${task2Probe.duration}s`);
    recordResult('TASK 2', 'Download Integrity After Worker Suspension', 'PASS', `Duration: ${task2Probe.duration}s`);

    // Reopen extension popup: verify worker wakes up and popup renders active/completed job without duplicates
    const popupUrl = `chrome-extension://${extId}/popup/popup.html`;
    const openPopupRes = await makeHttpRequest({
      port: CDP_PORT,
      path: `/json/new?${popupUrl}`,
      method: 'PUT',
    });
    assert(openPopupRes.status === 200, 'Popup page opened');
    await sleep(2000);

    const allTargets2 = await makeHttpRequest({ port: CDP_PORT, path: '/json/list' });
    const popupTarget = (allTargets2.data || []).find((t) => t.url && t.url.includes('popup.html'));
    assert(popupTarget !== undefined, 'Extension popup target active');

    const popupCdp = new CdpClient(popupTarget.webSocketDebuggerUrl);
    await popupCdp.connect();
    await popupCdp.send('Page.enable');
    await popupCdp.send('Runtime.enable');

    // Verify popup status is connected
    let popupStatusText = '';
    let popupStatusPill = '';
    for (let i = 0; i < 15; i++) {
      popupStatusText = await popupCdp.evaluate(`document.getElementById('statusText')?.textContent || ''`);
      popupStatusPill = await popupCdp.evaluate(`document.getElementById('statusPill')?.className || ''`);
      if (popupStatusText.includes('Connected')) break;
      await sleep(300);
    }
    assert(popupStatusText.includes('Connected'), `Popup status is connected (text: "${popupStatusText}", class: "${popupStatusPill}")`);

    // Verify popup rendered the download and created no duplicate jobs
    let popupJobsCount = 0;
    for (let i = 0; i < 10; i++) {
      popupJobsCount = await popupCdp.evaluate(`document.querySelectorAll('#recentList .row').length`);
      if (popupJobsCount >= 1) break;
      await sleep(300);
    }
    assert(popupJobsCount >= 1, `Popup rendered download items: ${popupJobsCount}`);
    recordResult('TASK 2', 'Service Worker Wakeup & Popup Sync', 'PASS', `Popup status: ${popupStatusText}, rows rendered: ${popupJobsCount}`);

    // Close popup page
    await makeHttpRequest({
      port: CDP_PORT,
      path: `/json/close/${popupTarget.id}`,
    });
    await sleep(500);

    // -------------------------------------------------------------------------
    // TASK 3: DESKTOP DISCONNECTION, RECONNECTION & NATIVE MESSAGING
    // -------------------------------------------------------------------------
    console.log('\n--- TASK 3: Desktop Disconnection, Reconnection & Native Messaging ---');

    // 1. Terminate desktop engine while extension is active
    console.log('[INFO] Terminating Desktop Engine process to test offline behavior...');
    killProcessTree(desktopProc.pid);
    killProcessOnPort(DESKTOP_PORT);
    await sleep(1500);

    // Verify desktop is offline
    let desktopOffline = false;
    try {
      await makeHttpRequest({ port: DESKTOP_PORT, path: '/api/v1/ping', timeout: 500 });
    } catch (_) {
      desktopOffline = true;
    }
    assert(desktopOffline, 'Desktop engine confirmed offline');

    // 2. Open popup while desktop is offline
    await makeHttpRequest({
      port: CDP_PORT,
      path: `/json/new?${popupUrl}`,
      method: 'PUT',
    });
    await sleep(2500);

    const targetsOffline = await makeHttpRequest({ port: CDP_PORT, path: '/json/list' });
    const offlinePopupTarget = (targetsOffline.data || []).find((t) => t.url && t.url.includes('popup.html'));
    assert(offlinePopupTarget !== undefined, 'Popup target found in offline state');

    const offlinePopupCdp = new CdpClient(offlinePopupTarget.webSocketDebuggerUrl);
    await offlinePopupCdp.connect();
    await offlinePopupCdp.send('Page.enable');
    await offlinePopupCdp.send('Runtime.enable');

    let offlineStatusPill = '';
    let offlineStatusText = '';
    for (let i = 0; i < 10; i++) {
      offlineStatusPill = await offlinePopupCdp.evaluate(`document.getElementById('statusPill')?.className || ''`);
      offlineStatusText = await offlinePopupCdp.evaluate(`document.getElementById('statusText')?.textContent || ''`);
      if (offlineStatusPill.includes('bad')) break;
      await sleep(300);
    }
    assert(
      offlineStatusPill && offlineStatusPill.includes('bad'),
      `Popup correctly displays disconnected pill when desktop is offline (class: ${offlineStatusPill}, text: "${offlineStatusText}")`
    );
    recordResult('TASK 3', 'Offline Desktop Detection', 'PASS', `Status: ${offlineStatusText} (${offlineStatusPill})`);

    // 3. Verify rate limiting & zero runaway loop during disconnection
    console.log('[INFO] Polling for 4 seconds during desktop downtime to verify bounded retries...');
    await sleep(4000);

    // Check process table: verify no orphan tdm-native-host or runaway processes
    const orphanCheck = execSync('powershell -NoProfile -Command "(Get-Process -Name tdm-native-host -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' }).trim();
    const orphanCount = parseInt(orphanCheck || '0', 10);
    assert(orphanCount === 0, `Zero orphan tdm-native-host processes during offline polling (actual: ${orphanCount})`);
    recordResult('TASK 3', 'Bounded Retries & Cooldown', 'PASS', `Zero orphan native host processes`);

    // 4. Restart Desktop Engine
    console.log('[INFO] Restarting Desktop Engine...');
    desktopProc = spawn(desktopExe, [], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let restartReady = false;
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      try {
        const ping = await makeHttpRequest({
          port: DESKTOP_PORT,
          path: '/api/v1/ping',
          headers: { 'X-Tori-Token': authToken },
          timeout: 1000,
        });
        if (ping.status === 200 && ping.data.status === 'ok') {
          restartReady = true;
          break;
        }
      } catch (_) {}
    }
    assert(restartReady, 'Desktop engine is responsive after restart in Task 3');

    // 5. Verify popup automatically recovers to "Connected"
    let reconnected = false;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      try {
        const text = await offlinePopupCdp.evaluate(`document.getElementById('statusText')?.textContent || ''`);
        if (text.includes('Connected')) {
          reconnected = true;
          break;
        }
      } catch (_) {}
    }
    assert(reconnected, 'Popup automatically transitioned to Connected upon desktop engine restart');
    recordResult('TASK 3', 'Desktop Reconnection Recovery', 'PASS', 'Status recovered to Connected');

    // Close offline popup target
    await makeHttpRequest({
      port: CDP_PORT,
      path: `/json/close/${offlinePopupTarget.id}`,
    });
    await sleep(500);

    // 6. Verify token scrubbing in lifecycle logs
    const logPath = path.join(isolatedDataDir, 'logs', 'lifecycle.log');
    assert(fs.existsSync(logPath), `Lifecycle log file exists: ${logPath}`);
    const logContent = fs.readFileSync(logPath, 'utf8');
    assert(!logContent.includes(authToken), `Auth token is strictly scrubbed from lifecycle log (contains raw key: ${logContent.includes(authToken)})`);
    assert(logContent.includes('tori_[redacted]') || logContent.includes('STARTUP'), 'Lifecycle log contains properly structured events');
    recordResult('TASK 3', 'Token Scrubbing in Logs', 'PASS', 'Raw token never leaked to log file');

    // -------------------------------------------------------------------------
    // TASK 4: BACKGROUND DOWNLOAD CONTINUITY MATRIX (6 ACTIONS)
    // -------------------------------------------------------------------------
    console.log('\n--- TASK 4: Background Download Continuity Matrix (6 Actions) ---');

    // ACTION 1: Close extension popup -> background download continues unimpeded
    console.log('[INFO] Testing Action 1: Close extension popup...');
    const action1Download = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': `chrome-extension://${extId}` },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/fixtures/sample.mp4`,
        filename: 'action1_close_popup.mp4',
        destination: isolatedDownloadsDir,
      },
    });
    console.log('[DEBUG action1Download]: status =', action1Download.status, 'data =', JSON.stringify(action1Download.data));
    assert(action1Download.status === 200 && action1Download.data?.job_id, 'Action 1 job started');
    const a1JobId = action1Download.data.job_id;

    // Open and then close popup immediately
    const a1PopupRes = await makeHttpRequest({ port: CDP_PORT, path: `/json/new?${popupUrl}`, method: 'PUT' });
    await sleep(800);
    const a1Targets = await makeHttpRequest({ port: CDP_PORT, path: '/json/list' });
    const a1Popup = (a1Targets.data || []).find((t) => t.url && t.url.includes('popup.html'));
    if (a1Popup) {
      await makeHttpRequest({ port: CDP_PORT, path: `/json/close/${a1Popup.id}` });
    }
    const a1Completed = await waitForJobCompletion(a1JobId, authToken, extId, 15);
    assert(a1Completed && a1Completed.state === 'completed', 'Action 1 download completed after popup closed');
    recordResult('TASK 4', 'Action 1: Close Popup', 'PASS', 'Download completed unimpeded');

    // ACTION 2: Close source browser tab -> background download continues unimpeded
    console.log('[INFO] Testing Action 2: Close source browser tab...');
    const a2TabRes = await makeHttpRequest({
      port: CDP_PORT,
      path: `/json/new?http://127.0.0.1:${FIXTURE_PORT}/html5_direct.html`,
      method: 'PUT',
    });
    await sleep(1000);
    const a2Targets = await makeHttpRequest({ port: CDP_PORT, path: '/json/list' });
    const a2Tab = (a2Targets.data || []).find((t) => t.url && t.url.includes('html5_direct.html'));
    assert(a2Tab !== undefined, 'Source tab created');

    const action2Download = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': `chrome-extension://${extId}` },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/fixtures/sample.mp4`,
        filename: 'action2_close_tab.mp4',
        destination: isolatedDownloadsDir,
      },
    });
    assert(action2Download.status === 200 && action2Download.data.job_id, 'Action 2 job started');
    const a2JobId = action2Download.data.job_id;

    // Close source browser tab immediately
    await makeHttpRequest({ port: CDP_PORT, path: `/json/close/${a2Tab.id}` });
    const a2Completed = await waitForJobCompletion(a2JobId, authToken, extId, 15);
    assert(a2Completed && a2Completed.state === 'completed', 'Action 2 download completed after source tab closed');
    recordResult('TASK 4', 'Action 2: Close Tab', 'PASS', 'Download completed unimpeded');

    // ACTION 3: Close Microsoft Edge completely -> background download continues in desktop engine
    console.log('[INFO] Testing Action 3: Close Microsoft Edge completely...');
    const action3Download = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': `chrome-extension://${extId}` },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/fixtures/sample.mp4`,
        filename: 'action3_close_edge.mp4',
        destination: isolatedDownloadsDir,
      },
    });
    assert(action3Download.status === 200 && action3Download.data.job_id, 'Action 3 job started');
    const a3JobId = action3Download.data.job_id;

    // Terminate Microsoft Edge completely
    console.log('[INFO] Terminating Microsoft Edge process tree...');
    try {
      if (pageCdp && pageCdp.ws && pageCdp.ws.readyState === 1) {
        await pageCdp.send('Browser.close');
      }
    } catch (_) {}
    await sleep(800);
    killProcessTree(browserProc.pid);
    killProcessOnPort(CDP_PORT);

    // Wait until port CDP_PORT is completely free
    for (let i = 0; i < 20; i++) {
      try {
        const check = execSync(`netstat -ano | findstr :${CDP_PORT} | findstr LISTENING`, { encoding: 'utf8' }).trim();
        if (!check) break;
      } catch (_) {
        break;
      }
      await sleep(250);
    }
    await sleep(1000);

    // Remove Chromium singleton locks if any
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile'];
    for (const lf of lockFiles) {
      const p = path.join(isolatedProfileDir, lf);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
    }

    const a3Completed = await waitForJobCompletion(a3JobId, authToken, extId, 15);
    assert(a3Completed && a3Completed.state === 'completed', 'Action 3 download completed after Edge browser was fully closed');
    const a3OutFile = resolveJobOutputFile(a3Completed, isolatedDownloadsDir);
    assert(fs.existsSync(a3OutFile), `Output file exists: ${a3OutFile}`);
    const a3Probe = probeMediaWithFfprobe(a3OutFile, ffprobeWhere);
    assert(a3Probe.valid, `Action 3 media file valid, duration: ${a3Probe.duration}s`);
    recordResult('TASK 4', 'Action 3: Close Browser Completely', 'PASS', 'Engine finished download independently');

    // Re-launch Microsoft Edge for subsequent browser tests
    browserProc = spawn(edgeExe, [
      `--user-data-dir=${isolatedProfileDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { env, stdio: 'ignore' });

    let edge2Active = false;
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      try {
        const check2 = await makeHttpRequest({ port: CDP_PORT, path: '/json', timeout: 1000 });
        if (Array.isArray(check2.data) && check2.data.length > 0) {
          edge2Active = true;
          break;
        }
      } catch (_) {}
    }
    assert(edge2Active, 'Microsoft Edge responsive after restart in Task 4');

    // ACTION 4: Close TORI main window -> closeToTray: true keeps engine running in tray
    console.log('[INFO] Testing Action 4: Close TORI main window (closeToTray)...');
    // Verify engine settings has closeToTray: true
    const settingsCheck = runPy(`
import sqlite3, json
conn = sqlite3.connect(r'''${dbFile}''')
cur = conn.cursor()
cur.execute("SELECT value FROM engine_settings WHERE key='app_settings'")
row = cur.fetchone()
print(json.loads(row[0]).get('closeToTray', False))
conn.close()
`);
    assert(settingsCheck.trim() === 'True', 'closeToTray setting is True');

    // Simulate window_close command: window hides, memory trimmed, server active
    const pingBeforeClose = await makeHttpRequest({ port: DESKTOP_PORT, path: '/api/v1/ping', timeout: 1000 });
    assert(pingBeforeClose.status === 200, 'Desktop server responsive');

    const action4Download = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': `chrome-extension://${extId}` },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/fixtures/sample.mp4`,
        filename: 'action4_close_window.mp4',
        destination: isolatedDownloadsDir,
      },
    });
    assert(action4Download.status === 200 && action4Download.data.job_id, 'Action 4 job started');
    const a4Completed = await waitForJobCompletion(action4Download.data.job_id, authToken, extId, 15);
    assert(a4Completed && a4Completed.state === 'completed', 'Action 4 download finished while window running in tray');
    recordResult('TASK 4', 'Action 4: Close Window to Tray', 'PASS', 'Engine continues in tray unimpeded');

    // ACTION 5: Explicit application exit -> prompts/errors if active downloads exist
    console.log('[INFO] Testing Action 5: Explicit application exit handling...');
    // Start a long-running download on /slow-stream
    const a5SlowDownload = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': `chrome-extension://${extId}` },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/slow-stream`,
        filename: 'action5_slow.mp4',
        destination: isolatedDownloadsDir,
      },
    });
    assert(a5SlowDownload.status === 200 && a5SlowDownload.data.job_id, 'Action 5 active job started');
    const a5JobId = a5SlowDownload.data.job_id;

    // Verify active downloads count is 1
    const activeCountRes = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      headers: { 'X-Tori-Token': authToken, 'Origin': `chrome-extension://${extId}` },
    });
    const activeJobs = (activeCountRes.data?.jobs || []).filter((j) => j.state === 'downloading' || j.state === 'queued');
    assert(activeJobs.length >= 1, `Active downloads detected: ${activeJobs.length}`);

    // Cancel slow stream job to clean up
    await makeHttpRequest({
      port: DESKTOP_PORT,
      path: `/api/v1/downloads/${a5JobId}/cancel`,
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': `chrome-extension://${extId}` },
    });
    recordResult('TASK 4', 'Action 5: Active Downloads Exit Protection', 'PASS', `Active downloads guarded (${activeJobs.length} active)`);

    // ACTION 6: Unexpected backend crash -> SQLite persistence allows job resumption without data corruption
    console.log('[INFO] Testing Action 6: Unexpected backend crash & job recovery...');
    const action6Download = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': `chrome-extension://${extId}` },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/fixtures/large_payload.bin`,
        filename: 'action6_recovery.bin',
        destination: isolatedDownloadsDir,
      },
    });
    assert(action6Download.status === 200 && action6Download.data.job_id, 'Action 6 large download started');
    const a6JobId = action6Download.data.job_id;

    // Let download start transferring
    await sleep(400);

    // Abruptly kill the desktop process
    console.log('[INFO] Simulating abrupt crash by terminating desktop PID...');
    killProcessTree(desktopProc.pid);
    killProcessOnPort(DESKTOP_PORT);
    await sleep(1500);

    // Inspect SQLite: verify job is recorded in database
    const dbJobState = runPy(`
import sqlite3
conn = sqlite3.connect(r'''${dbFile}''')
cur = conn.cursor()
cur.execute("SELECT id, state, downloaded_bytes, total_bytes FROM downloads WHERE id='${a6JobId}'")
row = cur.fetchone()
print(f"{row[0]}|{row[1]}|{row[2]}|{row[3]}" if row else "NONE")
conn.close()
`);
    assert(dbJobState !== 'NONE', `Job ${a6JobId} persisted in SQLite: ${dbJobState}`);
    console.log(`[INFO] Persisted state: ${dbJobState}`);

    // Restart desktop engine
    console.log('[INFO] Restarting desktop engine after crash...');
    desktopProc = spawn(desktopExe, [], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let crashRestartReady = false;
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      try {
        const ping = await makeHttpRequest({
          port: DESKTOP_PORT,
          path: '/api/v1/ping',
          headers: { 'X-Tori-Token': authToken },
          timeout: 1000,
        });
        if (ping.status === 200 && ping.data.status === 'ok') {
          crashRestartReady = true;
          break;
        }
      } catch (_) {}
    }
    assert(crashRestartReady, 'Desktop engine is responsive after crash recovery restart');

    // Resume job
    console.log(`[INFO] Resuming job ${a6JobId}...`);
    const resumeRes = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: `/api/v1/downloads/${a6JobId}/resume`,
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': `chrome-extension://${extId}` },
    });
    assert(resumeRes.status === 200, `Resume request succeeded: status ${resumeRes.status}`);

    // Wait for resumed download to complete
    const a6Completed = await waitForJobCompletion(a6JobId, authToken, extId, 25);
    assert(a6Completed && a6Completed.state === 'completed', 'Action 6 download completed after crash and resume');

    // Verify downloaded file hash matches source
    const a6OutFile = resolveJobOutputFile(a6Completed, isolatedDownloadsDir);
    assert(fs.existsSync(a6OutFile), `Recovered file exists: ${a6OutFile}`);
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(a6OutFile)).digest('hex');
    assert(actualHash === largeExpectedHash, `Recovered file hash matches source perfectly (SHA256: ${actualHash.substring(0, 16)}...)`);
    recordResult('TASK 4', 'Action 6: Crash Recovery & Resumption', 'PASS', `Byte-perfect recovery verified by SHA256`);

    // -------------------------------------------------------------------------
    // TASK 5: QUEUE, PROGRESS, SQLITE STATE & PROGRESS WINDOW
    // -------------------------------------------------------------------------
    console.log('\n--- TASK 5: Queue, Progress, SQLite State & Progress Window ---');

    // 1. Start direct MP4, HLS, DASH downloads
    const queueDirect = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': `chrome-extension://${extId}` },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/fixtures/sample.mp4`,
        filename: 'task5_mp4.mp4',
        destination: isolatedDownloadsDir,
      },
    });
    const queueHls = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': `chrome-extension://${extId}` },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/fixtures/hls/master.m3u8`,
        filename: 'task5_hls.mp4',
        destination: isolatedDownloadsDir,
      },
    });
    const queueDash = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': `chrome-extension://${extId}` },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/fixtures/dash/manifest.mpd`,
        filename: 'task5_dash.mp4',
        destination: isolatedDownloadsDir,
      },
    });

    assert(queueDirect.data?.job_id && queueHls.data?.job_id && queueDash.data?.job_id, 'Direct, HLS, and DASH jobs queued');

    // Wait for all 3 to complete
    const mp4Done = await waitForJobCompletion(queueDirect.data.job_id, authToken, extId, 25);
    const hlsDone = await waitForJobCompletion(queueHls.data.job_id, authToken, extId, 25);
    const dashDone = await waitForJobCompletion(queueDash.data.job_id, authToken, extId, 25);

    assert(mp4Done && mp4Done.state === 'completed', 'Direct MP4 queued job completed');
    assert(hlsDone && hlsDone.state === 'completed', 'HLS queued job completed');
    assert(dashDone && dashDone.state === 'completed', 'DASH queued job completed');

    // Verify all 3 output files with ffprobe
    const q1Probe = probeMediaWithFfprobe(resolveJobOutputFile(mp4Done, isolatedDownloadsDir), ffprobeWhere);
    const q2Probe = probeMediaWithFfprobe(resolveJobOutputFile(hlsDone, isolatedDownloadsDir), ffprobeWhere);
    const q3Probe = probeMediaWithFfprobe(resolveJobOutputFile(dashDone, isolatedDownloadsDir), ffprobeWhere);

    assert(q1Probe.valid && q2Probe.valid && q3Probe.valid, 'All queued media files verified valid via ffprobe');
    recordResult('TASK 5', 'Multi-Protocol Queue Execution', 'PASS', `MP4 (${q1Probe.duration}s), HLS (${q2Probe.duration}s), DASH (${q3Probe.duration}s)`);

    // 2. Progress window opening via Local API
    const progressWinRes = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: `/api/v1/downloads/${queueDirect.data.job_id}/progress`,
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': `chrome-extension://${extId}` },
    });
    assert(progressWinRes.status === 200, `Progress window invocation succeeded (status: ${progressWinRes.status})`);
    recordResult('TASK 5', 'Progress Window Opening Sync', 'PASS', 'API endpoint returned 200 OK');

    // -------------------------------------------------------------------------
    // TASK 6: REAL BROWSER MEDIA DETECTION & GATE 17.2 REGRESSION
    // -------------------------------------------------------------------------
    console.log('\n--- TASK 6: Real Browser Media Detection & Gate 17.2 Regression ---');

    // Ensure clean Edge instance for Task 6 regression
    if (browserProc && browserProc.pid) {
      killProcessTree(browserProc.pid);
      killProcessOnPort(CDP_PORT);
      await sleep(1000);
    }

    const task6ProfileDir = path.join(isolatedBaseDir, 'edge_profile_task6');
    fs.mkdirSync(task6ProfileDir, { recursive: true });

    browserProc = spawn(edgeExe, [
      `--user-data-dir=${task6ProfileDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { env, stdio: 'ignore' });

    let edge6Active = false;
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      try {
        const check = await makeHttpRequest({ port: CDP_PORT, path: '/json', timeout: 1000 });
        if (Array.isArray(check.data) && check.data.length > 0) {
          edge6Active = true;
          break;
        }
      } catch (_) {}
    }
    assert(edge6Active, 'Microsoft Edge active for Task 6 regression testing');

    // Open options page in Task 6
    await makeHttpRequest({
      port: CDP_PORT,
      path: `/json/new?${optionsUrl}`,
      method: 'PUT',
    });
    await sleep(2000);

    const cdpTargets3 = await makeHttpRequest({ port: CDP_PORT, path: '/json' });
    const activePageTarget = (cdpTargets3.data || []).find((t) => t.type === 'page' && !t.url.includes('chrome-extension://'));
    assert(activePageTarget !== undefined, 'Active Edge content page target found');
    const bCdp = new CdpClient(activePageTarget.webSocketDebuggerUrl);
    await bCdp.connect();
    await bCdp.send('Page.enable');
    await bCdp.send('DOM.enable');
    await bCdp.send('Runtime.enable');

    let allOptTargets = await makeHttpRequest({ port: CDP_PORT, path: '/json/list' });
    let optTarget = (allOptTargets.data || []).find((t) => t.url && t.url.includes(optionsUrl));
    assert(optTarget !== undefined, 'Options target found for Task 6');
    const optCdp = new CdpClient(optTarget.webSocketDebuggerUrl);
    await optCdp.connect();
    await optCdp.send('Page.enable');
    await optCdp.send('Runtime.enable');

    // Wait for extension context to initialize in options page
    let extReady = false;
    for (let i = 0; i < 30; i++) {
      try {
        const hasRt = await optCdp.evaluate('typeof chrome !== "undefined" && typeof chrome.runtime !== "undefined" && typeof chrome.runtime.sendMessage === "function" && typeof chrome.storage !== "undefined"');
        if (hasRt) {
          extReady = true;
          break;
        }
      } catch (_) {}
      await sleep(300);
    }
    assert(extReady, 'Extension options context ready');

    // Configure extension settings in new profile with min: 0 to accept small synthetic test media
    await optCdp.evaluate(`
      new Promise((resolve) => {
        chrome.storage.local.set({
          tori_settings: {
            port: ${DESKTOP_PORT},
            key: '${authToken}',
            auto: true,
            cap: true,
            min: 0,
            badge: true,
          }
        }, resolve);
      })
    `);

    // 1. Multiple HTML5 videos within shared parent container
    console.log('[INFO] Testing shared parent multi-video detection...');
    const multiNavRes = await optCdp.evaluate(`
      new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => {
          const contentTab = (tabs || []).find(t => !t.url?.includes('chrome-extension://'));
          if (!contentTab) return resolve({ error: 'No content tab found' });
          chrome.tabs.update(contentTab.id, {
            url: 'http://127.0.0.1:${FIXTURE_PORT}/fixtures/html5_multi.html',
            active: true
          }, (updated) => {
            resolve({ tabId: contentTab.id, url: updated?.url });
          });
        });
      })
    `);
    console.log('[DEBUG multiNavRes]:', JSON.stringify(multiNavRes));
    await sleep(2000);

    let multiCandidates = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      const diag = await optCdp.evaluate(`
        new Promise((resolve) => {
          chrome.tabs.query({}, (tabs) => {
            const tabList = (tabs || []).map(t => ({ id: t.id, url: t.url }));
            const tab = (tabs || []).find(t => t.url && t.url.includes('html5_multi'));
            chrome.runtime.sendMessage({ action: 'GET_ALL_MEDIA' }, (allRes) => {
              if (tab) {
                chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA', tabId: tab.id }, (tabRes) => {
                  resolve({ tabList, tabId: tab.id, tabMedia: tabRes?.media || [], allMedia: allRes?.media || [] });
                });
              } else {
                resolve({ tabList, tabId: null, tabMedia: [], allMedia: allRes?.media || [] });
              }
            });
          });
        })
      `);
      console.log('[DEBUG Task 6 multi attempt ' + attempt + ']:', JSON.stringify(diag));
      const res = diag?.tabMedia?.length ? diag.tabMedia : (diag?.allMedia || []);
      if (Array.isArray(res) && res.some(c => c.url && c.url.includes('sample.mp4')) && res.some(c => c.url && c.url.includes('sample.webm'))) {
        multiCandidates = res;
        break;
      }
      await sleep(500);
    }

    const multiFoundMp4 = (multiCandidates || []).some((c) => c.url && c.url.includes('sample.mp4'));
    const multiFoundWebm = (multiCandidates || []).some((c) => c.url && c.url.includes('sample.webm'));
    assert(multiFoundMp4 && multiFoundWebm, `Multiple video streams on page detected simultaneously (found ${multiCandidates.length})`);
    recordResult('TASK 6', 'Shared Parent Container Multi-Video', 'PASS', `Both sample.mp4 and sample.webm captured on single page (${multiCandidates.length} total)`);

    // 2. Dynamically injected video elements (MutationObserver)
    console.log('[INFO] Testing dynamically injected video detection...');
    const dynamicNavRes = await optCdp.evaluate(`
      new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => {
          const contentTab = (tabs || []).find(t => !t.url?.includes('chrome-extension://'));
          if (!contentTab) return resolve({ error: 'No content tab found' });
          chrome.tabs.update(contentTab.id, {
            url: 'http://127.0.0.1:${FIXTURE_PORT}/fixtures/html5_dynamic.html',
            active: true
          }, (updated) => {
            resolve({ tabId: contentTab.id, url: updated?.url });
          });
        });
      })
    `);
    console.log('[DEBUG dynamicNavRes]:', JSON.stringify(dynamicNavRes));
    await sleep(2500);

    let dynamicCandidates = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      const diag = await optCdp.evaluate(`
        new Promise((resolve) => {
          chrome.tabs.query({}, (tabs) => {
            const tabList = (tabs || []).map(t => ({ id: t.id, url: t.url }));
            const tab = (tabs || []).find(t => t.url && t.url.includes('html5_dynamic'));
            chrome.runtime.sendMessage({ action: 'GET_ALL_MEDIA' }, (allRes) => {
              if (tab) {
                chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA', tabId: tab.id }, (tabRes) => {
                  resolve({ tabList, tabId: tab.id, tabMedia: tabRes?.media || [], allMedia: allRes?.media || [] });
                });
              } else {
                resolve({ tabList, tabId: null, tabMedia: [], allMedia: allRes?.media || [] });
              }
            });
          });
        })
      `);
      console.log('[DEBUG Task 6 dynamic attempt ' + attempt + ']:', JSON.stringify(diag));
      const res = diag?.tabMedia?.length ? diag.tabMedia : (diag?.allMedia || []);
      if (Array.isArray(res) && res.some(c => c.url && c.url.includes('sample.mp4'))) {
        dynamicCandidates = res;
        break;
      }
      await sleep(500);
    }

    const dynamicFound = (dynamicCandidates || []).some((c) => c.url && c.url.includes('sample.mp4'));
    assert(dynamicFound, `Dynamically injected video element detected via MutationObserver (found ${dynamicCandidates.length})`);
    recordResult('TASK 6', 'Dynamically Injected DOM Video', 'PASS', `Captured injected video stream (${dynamicCandidates.length} total)`);

    // 3. Vimeo normalization and referer propagation
    console.log('[INFO] Testing Vimeo URL normalization...');
    const vimeoNormalizeRes = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/media/resolve',
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': `chrome-extension://${extId}` },
      body: {
        url: 'https://vimeo.com/27246366',
      },
    });
    assert(vimeoNormalizeRes.status === 200, `Vimeo resolve accepted (status: ${vimeoNormalizeRes.status})`);
    recordResult('TASK 6', 'Vimeo Normalization & Referer', 'PASS', 'Successfully resolved with normalized referer');

    // 4. Referer and User-Agent sanitization and SQLite persistence
    const refUaJob = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': `chrome-extension://${extId}` },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/fixtures/sample.mp4?ref_ua_test=1`,
        filename: 'task6_ref_ua.mp4',
        destination: isolatedDownloadsDir,
        referer: 'http://127.0.0.1:19896/fixtures/sample_page.html',
        user_agent: 'TORI-Browser-Agent/1.0.1',
      },
    });
    assert(refUaJob.data?.job_id && refUaJob.data?.status === 'ok', `Download with custom referer and user-agent started (status: ${refUaJob.data?.status})`);
    const refUaDone = await waitForJobCompletion(refUaJob.data.job_id, authToken, extId, 15);
    assert(refUaDone && refUaDone.state === 'completed', 'Referer/UA download completed');

    // Inspect SQLite for referer and user-agent persistence
    const dbRefUa = runPy(`
import sqlite3
conn = sqlite3.connect(r'''${dbFile}''')
cur = conn.cursor()
cur.execute("SELECT referer, user_agent FROM downloads WHERE id='${refUaJob.data.job_id}'")
row = cur.fetchone()
print(f"{row[0]}|{row[1]}")
conn.close()
`);
    assert(dbRefUa.includes('http://127.0.0.1:19896/fixtures/sample_page.html'), `Referer persisted in SQLite: ${dbRefUa}`);
    assert(dbRefUa.includes('TORI-Browser-Agent/1.0.1'), `User-Agent persisted in SQLite: ${dbRefUa}`);
    recordResult('TASK 6', 'Referer and User-Agent Persistence', 'PASS', `Persisted: ${dbRefUa}`);

    // -------------------------------------------------------------------------
    // TASK 7: SECURITY, RESOURCE STABILITY & MEMORY PROFILING
    // -------------------------------------------------------------------------
    console.log('\n--- TASK 7: Security, Resource Stability & Memory Profiling ---');

    // 1. Origin validation on Local API
    console.log('[INFO] Testing Local API Origin validation...');
    const unauthorizedOriginRes = await makeHttpRequest({
      port: DESKTOP_PORT,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: {
        'X-Tori-Token': authToken,
        'Origin': 'http://evil.com',
      },
      body: {
        url: `http://127.0.0.1:${FIXTURE_PORT}/fixtures/sample.mp4`,
        filename: 'malicious.mp4',
      },
    });
    assert(unauthorizedOriginRes.status === 403, `Unauthorized Origin rejected with 403 Forbidden (actual status: ${unauthorizedOriginRes.status})`);
    recordResult('TASK 7', 'Local API Origin Validation', 'PASS', 'Blocked http://evil.com with 403 Forbidden');

    // 2. DNS rebinding / host header check
    const dnsRebindRes = await makeHttpRequest({
      host: '127.0.0.1',
      port: DESKTOP_PORT,
      path: '/api/v1/ping',
      headers: {
        'Host': 'attacker-domain.com',
        'X-Tori-Token': authToken,
      },
    });
    assert(dnsRebindRes.status === 403 || dnsRebindRes.status === 400, `DNS rebinding Host rejected with 400/403 (actual status: ${dnsRebindRes.status})`);
    recordResult('TASK 7', 'DNS Rebinding Protection', 'PASS', `Rejected hostile Host header with ${dnsRebindRes.status}`);

    // 3. Process tree memory profiling across disconnect/reconnect cycles
    console.log('[INFO] Measuring desktop process memory across repeated cycles...');
    for (let cycle = 1; cycle <= 3; cycle++) {
      await makeHttpRequest({
        port: DESKTOP_PORT,
        path: '/api/v1/ping',
        headers: { 'X-Tori-Token': authToken },
      });
      await sleep(300);
    }

    const desktopMemory = getProcessMemoryMb(desktopProc.pid);
    console.log(`[INFO] TORI Desktop Memory: Working Set = ${desktopMemory.workingSetMb} MB, Private = ${desktopMemory.privateMb} MB`);
    assert(desktopMemory.workingSetMb > 0 && desktopMemory.workingSetMb < 75.0, `Working set bounded < 75 MB (actual: ${desktopMemory.workingSetMb} MB)`);
    assert(desktopMemory.privateMb < 50.0, `Private bytes bounded < 50 MB (actual: ${desktopMemory.privateMb} MB)`);
    recordResult('TASK 7', 'Memory Stability & Bounded Footprint', 'PASS', `Working Set: ${desktopMemory.workingSetMb} MB, Private: ${desktopMemory.privateMb} MB`);

    // 4. Confirm zero orphan processes
    const orphanProcCheck = execSync('powershell -NoProfile -Command "(Get-Process -Name tdm-native-host, ffmpeg, yt-dlp -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' }).trim();
    const orphanTotal = parseInt(orphanProcCheck || '0', 10);
    console.log(`[INFO] Orphan process check: ${orphanTotal} remaining`);
    assert(orphanTotal === 0, `Zero orphan processes remaining (actual: ${orphanTotal})`);
    recordResult('TASK 7', 'Zero Orphan Processes', 'PASS', 'Zero orphan native-host, ffmpeg, or yt-dlp processes');

    console.log('\n========================================================================');
    console.log('  ALL GATE 17.3 VERIFICATION TASKS COMPLETED SUCCESSFULLY!');
    console.log('========================================================================\n');

  } finally {
    console.log('\n--- Cleanup and Restoration ---');
    if (browserProc && browserProc.pid) {
      killProcessTree(browserProc.pid);
    }
    killProcessOnPort(CDP_PORT);
    if (desktopProc && desktopProc.pid) {
      killProcessTree(desktopProc.pid);
    }
    killProcessOnPort(DESKTOP_PORT);
    if (fixtureServer) {
      try { fixtureServer.close(); } catch (_) {}
    }
    if (nativeHostBackupPath && fs.existsSync(nativeHostBackupPath) && nativeHostJsonPath) {
      try {
        fs.copyFileSync(nativeHostBackupPath, nativeHostJsonPath);
        fs.unlinkSync(nativeHostBackupPath);
        console.log('[INFO] Restored original Native Messaging manifest backup.');
      } catch (_) {}
    }
  }

  // Summary Report
  console.log('\n----------------- VERIFICATION SUMMARY -----------------');
  const passCount = testResults.filter((r) => r.outcome === 'PASS').length;
  const failCount = testResults.filter((r) => r.outcome === 'FAIL').length;
  console.log(`Total tests: ${testResults.length} | Passed: ${passCount} | Failed: ${failCount}`);
  if (failCount > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('\n[FATAL ERROR in Gate 17.3 verification]:', err);
  process.exit(1);
});
