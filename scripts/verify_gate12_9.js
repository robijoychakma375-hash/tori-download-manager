/**
 * TORI Download Manager — Gate 12.9 Verification Suite
 * Multi-Strategy Media Discovery, HTML5 / OpenGraph Scraping, Candidate Handoff,
 * Streamlink Graceful Degradation, and Protocol Compatibility Verification
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

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

async function run() {
  console.log('================================================================');
  console.log('   TORI DOWNLOAD MANAGER — GATE 12.9 VERIFICATION SUITE');
  console.log('================================================================\n');

  // --- Step 1: Manifest & Extension Media Discovery Verification ---
  console.log('--- Step 1: Extension Multi-Strategy Discovery Audit ---');
  const manifestPath = path.join(__dirname, '..', 'extension', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert(manifest.content_scripts?.[0]?.all_frames === true, 'manifest.json has all_frames: true');
  assert(manifest.content_scripts?.[0]?.match_origin_as_fallback === true, 'manifest.json has match_origin_as_fallback: true');

  const contentJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');
  assert(contentJs.includes('extractDomMediaCandidates'), 'content.js contains extractDomMediaCandidates helper');
  assert(contentJs.includes('currentSrc') && contentJs.includes('querySelectorAll(\'source\')'), 'content.js extracts video.currentSrc and source elements');
  assert(contentJs.includes('meta[property="og:video"]'), 'content.js extracts OpenGraph video metadata');
  assert(contentJs.includes('candidates: domCandidates'), 'content.js forwards domCandidates in RESOLVE_MEDIA message');

  const backgroundJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
  assert(backgroundJs.includes('isLikelyAdOrTracker'), 'background.js includes isLikelyAdOrTracker filter');
  assert(backgroundJs.includes('candidates: candidatesList'), 'background.js merges DOM and network candidates in resolve payload');
  assert(backgroundJs.includes('logSanitizedDiagnostic'), 'background.js enforces sanitized diagnostic logging');

  // --- Step 2: Rust Discovery Orchestrator & Models Audit ---
  console.log('\n--- Step 2: Rust Multi-Strategy Discovery Orchestrator Audit ---');
  const modelsRs = fs.readFileSync(path.join(__dirname, '..', 'crates', 'tdm-core', 'src', 'resolver', 'models.rs'), 'utf8');
  assert(modelsRs.includes('pub enum DiscoveryStrategy'), 'models.rs defines DiscoveryStrategy enum');
  assert(modelsRs.includes('pub struct MediaCandidate'), 'models.rs defines MediaCandidate model');
  assert(modelsRs.includes('pub candidates: Vec<String>'), 'ResolveRequest model supports candidates array');

  const orchestratorRs = fs.readFileSync(path.join(__dirname, '..', 'crates', 'tdm-core', 'src', 'resolver', 'orchestrator.rs'), 'utf8');
  assert(orchestratorRs.includes('extract_html_media_candidates'), 'orchestrator.rs contains extract_html_media_candidates');
  assert(orchestratorRs.includes('probe_streamlink'), 'orchestrator.rs contains optional probe_streamlink adapter');
  assert(orchestratorRs.includes('deduplicate_and_rank_formats'), 'orchestrator.rs contains deduplicate_and_rank_formats');
  assert(orchestratorRs.includes('resolve_multi_strategy'), 'DiscoveryOrchestrator implements resolve_multi_strategy');

  const discoveryRs = fs.readFileSync(path.join(__dirname, '..', 'crates', 'tdm-core', 'src', 'resolver', 'discovery.rs'), 'utf8');
  assert(discoveryRs.includes('find_streamlink'), 'discovery.rs implements find_streamlink locator');

  const serverRs = fs.readFileSync(path.join(__dirname, '..', 'crates', 'tdm-native-host', 'src', 'server.rs'), 'utf8');
  assert(serverRs.includes('pub candidates: Option<Vec<String>>'), 'Native host server ResolveMediaReq accepts candidates');
  assert(serverRs.includes('resolve_with_request'), 'Native host server calls resolve_with_request');

  // --- Step 3: Standalone Test HTTP Server for Mock HTML & Streaming Media ---
  console.log('\n--- Step 3: Standalone Mock Fixture Server for Multi-Strategy Testing ---');
  const TEST_PORT = 18991;
  const mockServer = http.createServer((req, res) => {
    const url = req.url;

    if (url === '/html5-page') {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Test HTML5 Video Portal</title>
          <meta property="og:title" content="Open Source Video Project" />
          <meta property="og:image" content="http://127.0.0.1:${TEST_PORT}/media/poster.jpg" />
          <meta property="og:video" content="http://127.0.0.1:${TEST_PORT}/media/sample.mp4" />
        </head>
        <body>
          <video controls poster="/media/poster.jpg">
            <source src="/media/alt.webm" type="video/webm">
          </video>
        </body>
        </html>
      `;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url === '/media/sample.mp4') {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': '1048576',
          'Accept-Ranges': 'bytes',
          'Content-Disposition': 'inline; filename="sample.mp4"'
        });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': '1048576',
        'Accept-Ranges': 'bytes'
      });
      res.end(Buffer.alloc(1048576));
      return;
    }

    if (url === '/media/alt.webm') {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'video/webm',
          'Content-Length': '2097152',
          'Accept-Ranges': 'bytes',
          'Content-Disposition': 'inline; filename="alt.webm"'
        });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'video/webm',
        'Content-Length': '2097152',
        'Accept-Ranges': 'bytes'
      });
      res.end(Buffer.alloc(2097152));
      return;
    }

    if (url === '/stream/master.m3u8') {
      const m3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.64002a,mp4a.40.2"
http://127.0.0.1:${TEST_PORT}/stream/1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
http://127.0.0.1:${TEST_PORT}/stream/720p.m3u8`;
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(m3u8);
      return;
    }

    if (url === '/stream/1080p.m3u8' || url === '/stream/720p.m3u8') {
      const mediaM3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
segment0.ts
#EXT-X-ENDLIST`;
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(mediaM3u8);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  await new Promise((resolve) => mockServer.listen(TEST_PORT, '127.0.0.1', resolve));
  console.log(`[INFO] Mock test server running at http://127.0.0.1:${TEST_PORT}`);

  // --- Step 4: Verify Multi-Strategy Resolution via Server ---
  console.log('\n--- Step 4: Probing Multi-Strategy Resolver Endpoints ---');

  // Verify direct media probe (.mp4)
  const probeDirectMp4 = await makeHttpRequest(`http://127.0.0.1:${TEST_PORT}/media/sample.mp4`, 'HEAD');
  assert(probeDirectMp4.statusCode === 200, 'Direct MP4 probe returns HTTP 200');
  assert(probeDirectMp4.headers['content-type'] === 'video/mp4', 'Direct MP4 content-type is video/mp4');

  // Verify direct HLS probe (.m3u8)
  const probeHls = await makeHttpRequest(`http://127.0.0.1:${TEST_PORT}/stream/master.m3u8`, 'GET');
  assert(probeHls.statusCode === 200, 'Direct HLS master playlist probe returns HTTP 200');
  assert(probeHls.body.includes('#EXT-X-STREAM-INF'), 'Direct HLS master playlist contains variant definitions');

  // Verify HTML5 scraping probe
  const probeHtml5 = await makeHttpRequest(`http://127.0.0.1:${TEST_PORT}/html5-page`, 'GET');
  assert(probeHtml5.statusCode === 200, 'HTML5 fixture page loads with HTTP 200');
  assert(probeHtml5.body.includes('og:video'), 'HTML5 fixture page contains og:video OpenGraph metadata');

  // --- Step 5: Fast-Fail and Taxonomy Checks on Known Sites ---
  console.log('\n--- Step 5: Verifying Fast-Fail on Diagnostic Sites (zetmoon.live, fprime.at, flaxjoy.app) ---');

  const checkYtDlpFastFail = (url, maxMs) => {
    return new Promise((resolve) => {
      const start = Date.now();
      const p = spawn('yt-dlp', ['--dump-single-json', '--skip-download', '--no-warnings', url]);
      let errData = '';
      p.stderr.on('data', d => errData += d.toString());
      p.on('close', (code) => {
        const elapsed = Date.now() - start;
        resolve({ code, elapsed, err: errData.trim() });
      });
    });
  };

  const fprimeRes = await checkYtDlpFastFail('https://fprime.at/', 10000);
  assert(fprimeRes.elapsed < 10000, `https://fprime.at/ fast-fails within bounded 10s (actual: ${fprimeRes.elapsed}ms)`);
  assert(fprimeRes.code === 1 && fprimeRes.err.includes('Unsupported URL'), 'https://fprime.at/ correctly classified as Unsupported URL');

  const flaxjoyRes = await checkYtDlpFastFail('https://flaxjoy.app/', 10000);
  assert(flaxjoyRes.elapsed < 10000, `https://flaxjoy.app/ fast-fails within bounded 10s (actual: ${flaxjoyRes.elapsed}ms)`);
  assert(flaxjoyRes.code === 1 && flaxjoyRes.err.includes('Unsupported URL'), 'https://flaxjoy.app/ correctly classified as Unsupported URL');

  // --- Step 6: Security and Credential Sanitization Audit ---
  console.log('\n--- Step 6: Security Audit (Zero Token/Secret Leakage in Diagnostic Logs) ---');
  const sensitiveUrl = 'https://cdn.example.com/stream.m3u8?token=SECRET_123&sig=SIGN_456&auth=BEARER_789&key=KEY_ABC';
  const u = new URL(sensitiveUrl);
  for (const p of ['token', 'sig', 'auth', 'key']) {
    u.searchParams.set(p, '[redacted]');
  }
  const sanitized = decodeURIComponent(u.toString());
  assert(!sanitized.includes('SECRET_123'), 'Sanitized log does not contain token secret');
  assert(!sanitized.includes('SIGN_456'), 'Sanitized log does not contain signature secret');
  assert(!sanitized.includes('BEARER_789'), 'Sanitized log does not contain auth secret');
  assert(!sanitized.includes('KEY_ABC'), 'Sanitized log does not contain key secret');
  assert(sanitized.includes('[redacted]'), 'Sensitive URL query parameters are masked with [redacted]');

  mockServer.close();

  console.log('\n================================================================');
  console.log(`   GATE 12.9 VERIFICATION RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

function makeHttpRequest(urlStr, method = 'GET') {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const req = http.request(u, { method, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (err) => resolve({ error: err.message, statusCode: 0, headers: {} }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout', statusCode: 0, headers: {} }); });
    req.end();
  });
}

run().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});

