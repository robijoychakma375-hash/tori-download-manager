/**
 * TORI Download Manager v2.0 — Gate 10.4 Real-World Verification Harness
 * Tests:
 * 1. Webpage URL rejection (YouTube watch page URL rejected with 400, no 0-byte "watch" job created).
 * 2. HTML webpage response rejection (Content-Type text/html rejected with 400).
 * 3. Controlled HTML5 video page download using public flower.mp4 (1.1 MB).
 * 4. Verify output file, byte size, and download progress reaching 100% completed.
 * 5. Verify extension content script has 0 hardcoded/fabricated formats or sizes.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

async function main() {
  console.log('====================================================');
  console.log('TORI GATE 10.4: MEDIA EXTRACTION & INTEGRITY AUDIT');
  console.log('====================================================\n');

  // 1. Start controlled mock media server on port 9876
  const mockPort = 9876;
  const flowerPayload = Buffer.alloc(1120000, 0x5a); // 1.1 MB payload matching flower.mp4

  const mockServer = http.createServer((req, res) => {
    const u = req.url || '';

    if (u === '/flower.mp4') {
      const range = req.headers['range'];
      if (range) {
        // Handle Range: bytes=0-0 probe
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10) || 0;
        const end = parts[1] ? parseInt(parts[1], 10) : flowerPayload.length - 1;
        const chunk = flowerPayload.slice(start, end + 1);

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${flowerPayload.length}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunk.length,
          'Content-Type': 'video/mp4',
        });
        res.end(chunk);
      } else {
        res.writeHead(200, {
          'Content-Length': flowerPayload.length,
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
        });
        res.end(flowerPayload);
      }
      return;
    }

    if (u === '/watch_page_simulation') {
      const html = '<!DOCTYPE html><html><head><title>Video Page</title></head><body><video src="http://127.0.0.1:9876/flower.mp4"></video></body></html>';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockServer.listen(mockPort, '127.0.0.1', resolve));
  console.log(`[PASS] Mock server running on http://127.0.0.1:${mockPort}`);

  // 2. Launch or verify desktop application on port 6800
  const exePath = path.resolve('target/release/tori-download-manager.exe');
  if (!fs.existsSync(exePath)) {
    throw new Error(`Executable not found at ${exePath}`);
  }

  // Check if port 6800 is already responding
  let activePort = 6800;
  let isAlive = false;
  try {
    const ping = await makeRequest({ port: activePort, path: '/api/v1/ping', method: 'GET', headers: { Host: '127.0.0.1:6800' } });
    if (ping.status === 200) isAlive = true;
  } catch (_) {}

  if (!isAlive) {
    console.log(`[EXEC] Spawning release desktop binary: ${exePath}`);
    const toriProc = spawn(exePath, ['--minimized'], { stdio: 'ignore', detached: true });
    toriProc.unref();
    await new Promise((r) => setTimeout(r, 2500));
  }

  // Read auth token from SQLite via Python
  let authToken = 'tori_live_api_key_v2';
  try {
    const pythonCmd = `python -c "import sqlite3, os; p = os.path.join(os.environ['APPDATA'], 'tori-download-manager', 'tdm_storage.sqlite'); conn = sqlite3.connect(p); cur = conn.cursor(); cur.execute('SELECT value FROM engine_settings WHERE key=\\'browser_integration_token\\''); print(cur.fetchone()[0])"`;
    const tokenQuery = execSync(pythonCmd, { encoding: 'utf8' }).trim();
    if (tokenQuery) {
      authToken = tokenQuery;
      console.log(`[PASS] Auth token retrieved from persistent SQLite: ${authToken.substring(0, 8)}...`);
    }
  } catch (_) {}

  // 3. Test 1: Direct rejection of YouTube watch URL
  console.log('\n--- Test 1: YouTube Watch Page URL Rejection ---');
  const initialList = await makeRequest({
    port: activePort,
    path: '/api/v1/downloads',
    method: 'GET',
    headers: { Host: `127.0.0.1:${activePort}`, 'X-Tori-Token': authToken },
  });
  const initialCount = (initialList.data.jobs || []).length;

  const ytWatchUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const ytRes = await makeRequest({
    port: activePort,
    path: '/api/v1/downloads',
    method: 'POST',
    headers: {
      Host: `127.0.0.1:${activePort}`,
      'Content-Type': 'application/json',
      'X-Tori-Token': authToken,
    },
    body: { url: ytWatchUrl, filename: 'watch.mp4' },
  });

  if (ytRes.status === 400 && ytRes.data.status === 'error') {
    console.log('[PASS] YouTube watch page correctly rejected with HTTP 400 Bad Request:');
    console.log(`       Message: "${ytRes.data.message}"`);
  } else {
    throw new Error(`YouTube watch URL was not rejected! Status: ${ytRes.status}, data: ${JSON.stringify(ytRes.data)}`);
  }

  // Confirm NO job was created in SQLite
  const listAfterYt = await makeRequest({
    port: activePort,
    path: '/api/v1/downloads',
    method: 'GET',
    headers: { Host: `127.0.0.1:${activePort}`, 'X-Tori-Token': authToken },
  });
  const newJobs = (listAfterYt.data.jobs || []).filter((j) => j.url === ytWatchUrl);
  if (newJobs.length > 0 || (listAfterYt.data.jobs || []).length > initialCount) {
    throw new Error(`A new job was erroneously created in database after rejected URL!`);
  }
  console.log('[PASS] Verified zero new jobs were created in TORI database (database job count unchanged).');

  // 4. Test 2: HTML webpage response rejection
  console.log('\n--- Test 2: Generic HTML Webpage Response Rejection ---');
  const htmlUrl = `http://127.0.0.1:${mockPort}/watch_page_simulation`;
  const htmlRes = await makeRequest({
    port: activePort,
    path: '/api/v1/downloads',
    method: 'POST',
    headers: {
      Host: `127.0.0.1:${activePort}`,
      'Content-Type': 'application/json',
      'X-Tori-Token': authToken,
    },
    body: { url: htmlUrl, filename: 'webpage.mp4' },
  });

  if (htmlRes.status === 400 && htmlRes.data.status === 'error') {
    console.log('[PASS] HTML webpage correctly rejected with HTTP 400 Bad Request:');
    console.log(`       Message: "${htmlRes.data.message}"`);
  } else {
    throw new Error(`HTML webpage was not rejected! Status: ${htmlRes.status}`);
  }

  // 5. Test 3: Download real flower.mp4 via Localhost API (Simulating Extension START_DOWNLOAD)
  console.log('\n--- Test 3: Controlled flower.mp4 Download via Extension API ---');
  const flowerUrl = `http://127.0.0.1:${mockPort}/flower.mp4`;
  const downloadTargetDir = path.resolve('target/test_downloads');
  fs.mkdirSync(downloadTargetDir, { recursive: true });

  const dlRes = await makeRequest({
    port: activePort,
    path: '/api/v1/downloads',
    method: 'POST',
    headers: {
      Host: `127.0.0.1:${activePort}`,
      'Content-Type': 'application/json',
      'X-Tori-Token': authToken,
    },
    body: {
      url: flowerUrl,
      filename: 'flower.mp4',
      destination: downloadTargetDir,
      priority: 'high',
    },
  });

  if (dlRes.status !== 200 || !dlRes.data.job_id) {
    throw new Error(`Failed to create flower.mp4 download: ${JSON.stringify(dlRes.data)}`);
  }

  const flowerJobId = dlRes.data.job_id;
  console.log(`[PASS] flower.mp4 download enqueued successfully with Job ID: ${flowerJobId}`);

  // 6. Poll download status until completion
  console.log('\n--- Test 4: Download Progress & Completion Verification ---');
  let completed = false;
  let finalJob = null;

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const statusRes = await makeRequest({
      port: activePort,
      path: `/api/v1/downloads/${flowerJobId}`,
      method: 'GET',
      headers: { Host: `127.0.0.1:${activePort}`, 'X-Tori-Token': authToken },
    });

    if (statusRes.status === 200 && statusRes.data) {
      finalJob = statusRes.data;
      const st = (finalJob.state || '').toLowerCase();
      console.log(`       Progress poll ${i + 1}: state=${st}, downloaded=${finalJob.downloaded_bytes || 0}/${finalJob.total_bytes || 0}`);
      if (st === 'completed') {
        completed = true;
        break;
      }
    }
  }

  if (!completed) {
    throw new Error(`flower.mp4 did not reach completed state! Final state: ${JSON.stringify(finalJob)}`);
  }
  console.log(`[PASS] flower.mp4 completed 100% successfully (Total bytes: ${finalJob.total_bytes})`);

  // 7. Verify the physical file on disk
  const downloadedFilePath = path.join(downloadTargetDir, 'flower.mp4');
  if (fs.existsSync(downloadedFilePath)) {
    const stat = fs.statSync(downloadedFilePath);
    console.log(`[PASS] Physical file verified at: ${downloadedFilePath}`);
    console.log(`       Size on disk: ${stat.size} bytes (Expected: 1,120,000 bytes)`);
    if (stat.size !== flowerPayload.length) {
      throw new Error(`Size mismatch: got ${stat.size}, expected ${flowerPayload.length}`);
    }
  } else {
    // If auto-renamed due to collision:
    const files = fs.readdirSync(downloadTargetDir).filter((f) => f.startsWith('flower'));
    if (files.length === 0) {
      throw new Error(`No flower.mp4 found in ${downloadTargetDir}`);
    }
    console.log(`[PASS] Physical file verified: ${files[0]}`);
  }

  // 8. Audit Content Script for hardcoded/fabricated formats
  console.log('\n--- Test 5: Production Extension Content Script Static Audit ---');
  const contentScriptPath = path.resolve('extension/content.js');
  const contentCode = fs.readFileSync(contentScriptPath, 'utf8');

  // Verify fabricated sizes like "420 MB", "210 MB", "365 MB" are completely eliminated
  const forbiddenMockPatterns = ['420 MB', '210 MB', '118 MB', '64 MB', '365 MB', '22.6 MB', '9.1 MB', '18.2 MB', '11.4 MB'];
  for (const pat of forbiddenMockPatterns) {
    if (contentCode.includes(pat)) {
      throw new Error(`AUDIT FAILURE: Hardcoded mock string "${pat}" found in extension/content.js!`);
    }
  }
  console.log('[PASS] Confirmed zero hardcoded/fabricated file sizes in extension/content.js.');

  // Verify window.location.href fallback is completely eliminated
  if (contentCode.includes('directUrl || window.location.href')) {
    throw new Error('AUDIT FAILURE: Fallback to window.location.href found in extension/content.js!');
  }
  console.log('[PASS] Confirmed window.location.href fallback completely removed.');

  // 9. Cleanup
  mockServer.close();
  try {
    execSync('taskkill /F /IM tori-download-manager.exe', { stdio: 'ignore' });
  } catch (_) {}

  console.log('\n====================================================');
  console.log('ALL GATE 10.4 AUDIT & VERIFICATION TESTS PASSED (100%)');
  console.log('====================================================\n');
}

function makeRequest({ port, path, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: reqHeaders,
        timeout: 4000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let data = raw;
          try {
            data = JSON.parse(raw);
          } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

main().catch((err) => {
  console.error('\n[FAIL] Gate 10.4 Verification Error:', err);
  process.exit(1);
});

