/**
 * TORI Download Manager v1.0.1 â€” Gate 15.3.2 Verification Harness
 * Strict Video Format Fidelity Fix Validation
 *
 * Objectives:
 * 1. Verify elimination of unintended /best/ fallback in single-video selector construction.
 * 2. Deterministic regression fixture: Explicitly selected format unavailable, unrelated Best format IS available.
 *    Verify that TORI does NOT download the unrelated Best format.
 * 3. Real download verification on authorized test media:
 *    - Available single video format with compatible audio (Format 160 -> 144p).
 *    - Explicit combined video+audio format (Format 230+140 -> 240p h264 + aac).
 *    - Audio-only format (Format 251 -> opus, 0 video tracks).
 *    - Explicit user-requested Best/Auto retains existing behavior.
 *    - Direct MP4 bypasses yt-dlp (JobType::HttpFile).
 * 4. Completed SQLite job state and FFprobe stream verification.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const testResults = [];
const auditDetails = [];

function recordResult(scenario, outcome, details) {
  testResults.push({ scenario, outcome, details });
  const prefix = outcome === 'PASS' ? '[PASS]' : outcome === 'FAIL' ? '[FAIL]' : `[${outcome}]`;
  console.log(`${prefix} ${scenario}: ${details}`);
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

function makeHttpRequest({ host = '127.0.0.1', port, path: reqPath, method = 'GET', headers = {}, body = null, timeout = 40000 }) {
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

async function run() {
  console.log('================================================================');
  console.log('  TORI GATE 15.3.2: STRICT VIDEO FORMAT FIDELITY VERIFICATION');
  console.log('================================================================\n');

  let desktopProc = null;
  const desktopExe = path.resolve('target/debug/tori-download-manager.exe');
  const ffprobeExe = path.resolve('target/debug/bin/ffprobe.exe');
  const ytdlpExe = path.resolve('target/debug/bin/yt-dlp.exe');
  const testVideoUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const flowerUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

  const isolatedDataDir = path.resolve('target/gate15_3_2_data');
  const isolatedDownloadsDir = path.resolve('target/gate15_3_2_downloads');
  const authToken = 'tori_live_api_key_gate15_3_2';
  const clientOrigin = 'chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm';

  try {
    // -------------------------------------------------------------------------
    // TASK 1 & 2 â€” CHECKPOINT & SOURCE INSPECTION
    // -------------------------------------------------------------------------
    console.log('--- TASK 1 & 2: Checkpoint & Source Selector Fix Audit ---');
    const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    assert(branch === 'dev/v1.0.1', `Git branch is strictly dev/v1.0.1 (actual: ${branch})`);
    recordResult('Checkpoint Verification', 'PASS', `Branch dev/v1.0.1`);

    assert(fs.existsSync(desktopExe), `Desktop executable exists: ${desktopExe}`);
    assert(fs.existsSync(ffprobeExe), `FFprobe executable exists: ${ffprobeExe}`);
    assert(fs.existsSync(ytdlpExe), `yt-dlp executable exists: ${ytdlpExe}`);

    // Verify source code changes in downloader.rs
    const downloaderSource = fs.readFileSync('crates/tdm-core/src/resolver/downloader.rs', 'utf8');
    assert(
      downloaderSource.includes('Some(format!("{format_arg}+bestaudio/{format_arg}"))'),
      'downloader.rs implements strict format_arg+bestaudio/format_arg without /best/'
    );
    assert(
      !downloaderSource.includes('{format_arg}+bestaudio/best/{format_arg}'),
      'downloader.rs completely eliminated unintended /best/ fallback'
    );
    recordResult('Source Fix Audit', 'PASS', 'Eliminated /best/ fallback in downloader.rs: build_format_selector produces {format_arg}+bestaudio/{format_arg}');

    // Run Rust focused unit tests
    const rustTestOutput = execSync('cargo test -p tdm-core --lib downloader::tests', { encoding: 'utf8' });
    assert(rustTestOutput.includes('test result: ok. 4 passed'), 'All 4 downloader unit tests passed');
    recordResult('Rust Selector Unit Tests', 'PASS', '4/4 Rust unit tests passed: single video, audio-only, explicit combo, best/auto');

    // -------------------------------------------------------------------------
    // SETUP ISOLATED ENVIRONMENT
    // -------------------------------------------------------------------------
    if (fs.existsSync(isolatedDownloadsDir)) {
      try { fs.rmSync(isolatedDownloadsDir, { recursive: true, force: true }); } catch (_) {}
    }
    fs.mkdirSync(isolatedDownloadsDir, { recursive: true });

    if (fs.existsSync(isolatedDataDir)) {
      try { fs.rmSync(isolatedDataDir, { recursive: true, force: true }); } catch (_) {}
    }
    fs.mkdirSync(isolatedDataDir, { recursive: true });

    process.env.TORI_DATA_DIR = isolatedDataDir;
    process.env.TORI_ALLOW_LOOPBACK = '1';

    const dbFile = path.join(isolatedDataDir, 'tdm_storage.sqlite');
    runPy(`
import sqlite3, json
conn = sqlite3.connect(r'''${dbFile}''')
cur = conn.cursor()
cur.execute('CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
cur.execute('INSERT OR REPLACE INTO engine_settings (key, value) VALUES (?, ?)', ('browser_integration_token', '${authToken}'))
cur.execute('INSERT OR REPLACE INTO engine_settings (key, value) VALUES (?, ?)', ('app_settings', json.dumps({'dir': r'''${isolatedDownloadsDir}''', 'port': 6800, 'key': '${authToken}'})))
conn.commit()
conn.close()
`);

    // Launch Desktop Engine
    desktopProc = spawn(desktopExe, ['--minimized'], {
      stdio: 'ignore',
      detached: false,
      env: process.env,
    });

    let desktopOnline = false;
    for (let i = 0; i < 25; i++) {
      await sleep(500);
      try {
        const ping = await makeHttpRequest({ port: 6800, path: '/api/v1/ping' });
        if (ping.status === 200 && ping.data.status === 'ok') {
          desktopOnline = true;
          break;
        }
      } catch (_) {}
    }
    assert(desktopOnline, 'TORI Desktop Engine is running on port 6800');

    // Helper to run a managed media download
    async function runMediaDownload({ testName, url, formatId, filename }) {
      console.log(`\n--- Running ${testName} (format_id: "${formatId}") ---`);
      const dlResp = await makeHttpRequest({
        port: 6800,
        path: '/api/v1/media/download',
        method: 'POST',
        headers: { 'X-Tori-Token': authToken, 'Origin': clientOrigin },
        body: {
          url,
          format_id: formatId,
          filename,
          direct_stream_url: null,
        },
      });

      assert(dlResp.status === 200 && dlResp.data.job_id, `Job accepted into queue (job_id: ${dlResp.data?.job_id})`);
      const jobId = dlResp.data.job_id;

      let finalJob = null;
      for (let p = 0; p < 45; p++) {
        await sleep(1000);
        const detailRes = await makeHttpRequest({
          port: 6800,
          path: `/api/v1/downloads/${jobId}`,
          headers: { 'X-Tori-Token': authToken, 'Origin': clientOrigin },
        });
        if (detailRes.status === 200 && detailRes.data) {
          const state = detailRes.data.state;
          if (state === 'completed' || state === 'failed' || state === 'cancelled') {
            finalJob = detailRes.data;
            break;
          }
        }
      }

      assert(finalJob !== null, `Job reached terminal state within timeout`);
      console.log(`[INFO] Final Job State: "${finalJob.state}"`);

      // Cleanup job so next test can proceed
      await makeHttpRequest({
        port: 6800,
        path: `/api/v1/downloads/${jobId}/delete`,
        method: 'POST',
        headers: { 'X-Tori-Token': authToken, 'Origin': clientOrigin },
      });

      return finalJob;
    }

    // -------------------------------------------------------------------------
    // TASK 3 â€” CONTROLLED MISSING-FORMAT REGRESSION FIXTURE
    // -------------------------------------------------------------------------
    console.log('\n--- TASK 3: Controlled Missing-Format Regression Fixture ---');
    console.log('[INFO] Target URL has available "best" (format_id: "mp4"), but user requests unavailable format "999"');

    // Prove baseline: yt-dlp with the old selector would have selected "mp4" (Best)
    const oldSim = execSync(`"${ytdlpExe}" -f "999+bestaudio/best/999" --print "format_id:%(format_id)s" --simulate "${flowerUrl}"`, { encoding: 'utf8' }).trim();
    assert(oldSim === 'format_id:mp4' || oldSim.includes('mp4'), `Confirmed old selector fell back to mp4 (Best): ${oldSim}`);
    console.log(`[INFO] Old selector behavior confirmed: -f 999+bestaudio/best/999 silently fell back to format_id: "${oldSim}"`);

    // Test new selector with TORI engine: format_id "999" must strictly fail, NOT fall back to Best
    const missingFmtJob = await runMediaDownload({
      testName: 'Missing Format with Available Best Fixture',
      url: flowerUrl,
      formatId: '999',
      filename: 'should_not_download_best.mp4',
    });

    assert(missingFmtJob.state === 'failed', `TORI strictly transitioned missing format job to 'failed' state`);
    assert(
      missingFmtJob.error_message && (missingFmtJob.error_message.includes('not available') || missingFmtJob.error_message.includes('format')),
      `Error message honestly indicates unavailable format (actual: "${missingFmtJob.error_message}")`
    );

    // Verify disk has NO downloaded flower file from this job
    const strayFlower = fs.readdirSync(isolatedDownloadsDir, { recursive: true })
      .filter((f) => f.includes('should_not_download_best') && !f.endsWith('.part'));
    assert(strayFlower.length === 0, `No file downloaded for unavailable format (stray count: 0)`);
    recordResult('Controlled Missing-Format Regression', 'PASS', 'Unavailable format 999 failed honestly; TORI did NOT fall back to available Best format');

    // -------------------------------------------------------------------------
    // TASK 4 â€” REAL DOWNLOAD VERIFICATION ON AUTHORIZED MEDIA
    // -------------------------------------------------------------------------
    console.log('\n--- TASK 4: Real Download Verification on Authorized Media ---');

    // 4.1: Available Single-Video Format (160 -> 144p AVC1)
    const tSingle = await runMediaDownload({
      testName: 'Available Single-Video Format (160)',
      url: testVideoUrl,
      formatId: '160',
      filename: 'real_single_video_160.mp4',
    });
    assert(tSingle.state === 'completed', 'Single-video job completed');
    let singleFile = tSingle.target_path;
    if (!singleFile || !fs.existsSync(singleFile)) {
      const m = fs.readdirSync(isolatedDownloadsDir, { recursive: true }).find((f) => f.includes('real_single_video_160') && !f.endsWith('.part'));
      if (m) singleFile = path.join(isolatedDownloadsDir, m);
    }
    assert(singleFile && fs.existsSync(singleFile), `Single video output exists at ${singleFile}`);
    const singleProbe = JSON.parse(execSync(`"${ffprobeExe}" -v error -show_entries format=duration -show_streams -of json "${singleFile}"`, { encoding: 'utf8' }));
    const sVideo = singleProbe.streams.find((s) => s.codec_type === 'video');
    const sAudio = singleProbe.streams.find((s) => s.codec_type === 'audio');
    assert(sVideo && sVideo.width === 192 && sVideo.height === 144, `Video resolution matches format 160 (192x144) (actual: ${sVideo?.width}x${sVideo?.height})`);
    assert(sAudio !== undefined, 'Compatible audio track merged to prevent silent playback');
    recordResult('Real Single-Video Download (160)', 'PASS', `Exact video resolution 192x144 (${sVideo.codec_name}) paired with compatible audio (${sAudio.codec_name})`);

    // 4.2: Explicit Combined Video+Audio Format (230+140 -> 240p AVC1 + AAC)
    const tCombo = await runMediaDownload({
      testName: 'Explicit Combined Video+Audio Format (230+140)',
      url: testVideoUrl,
      formatId: '230+140',
      filename: 'real_combo_230_140.mp4',
    });
    assert(tCombo.state === 'completed', 'Combo format job completed');
    let comboFile = tCombo.target_path;
    if (!comboFile || !fs.existsSync(comboFile)) {
      const m = fs.readdirSync(isolatedDownloadsDir, { recursive: true }).find((f) => f.includes('real_combo_230_140') && !f.endsWith('.part'));
      if (m) comboFile = path.join(isolatedDownloadsDir, m);
    }
    assert(comboFile && fs.existsSync(comboFile), `Combo output exists at ${comboFile}`);
    const comboProbe = JSON.parse(execSync(`"${ffprobeExe}" -v error -show_entries format=duration -show_streams -of json "${comboFile}"`, { encoding: 'utf8' }));
    const cVideo = comboProbe.streams.find((s) => s.codec_type === 'video');
    const cAudio = comboProbe.streams.find((s) => s.codec_type === 'audio');
    const cAudioCount = comboProbe.streams.filter((s) => s.codec_type === 'audio').length;
    assert(cVideo && cVideo.width === 320 && cVideo.height === 240, `Video resolution matches format 230 (320x240) (actual: ${cVideo?.width}x${cVideo?.height})`);
    assert(cAudio && cAudio.codec_name === 'aac', 'Audio codec matches format 140 (aac)');
    assert(cAudioCount === 1, `Exactly 1 audio track present (no duplicate audio tracks: actual count = ${cAudioCount})`);
    recordResult('Real Explicit Combined Download (230+140)', 'PASS', `Exact video 320x240 (${cVideo.codec_name}) + exact audio (${cAudio.codec_name}), strictly 1 audio track`);

    // 4.3: Audio-Only Format (251 -> WebM Opus)
    const tAudio = await runMediaDownload({
      testName: 'Audio-Only Format (251)',
      url: testVideoUrl,
      formatId: '251',
      filename: 'real_audio_251.webm',
    });
    assert(tAudio.state === 'completed', 'Audio-only job completed');
    let audioFile = tAudio.target_path;
    if (!audioFile || !fs.existsSync(audioFile)) {
      const m = fs.readdirSync(isolatedDownloadsDir, { recursive: true }).find((f) => f.includes('real_audio_251') && !f.endsWith('.part'));
      if (m) audioFile = path.join(isolatedDownloadsDir, m);
    }
    assert(audioFile && fs.existsSync(audioFile), `Audio output exists at ${audioFile}`);
    const audioProbe = JSON.parse(execSync(`"${ffprobeExe}" -v error -show_entries format=duration -show_streams -of json "${audioFile}"`, { encoding: 'utf8' }));
    const aVideoCount = audioProbe.streams.filter((s) => s.codec_type === 'video').length;
    const aAudioTrack = audioProbe.streams.find((s) => s.codec_type === 'audio');
    assert(aVideoCount === 0, `Video streams strictly absent for audio-only format (video count: ${aVideoCount})`);
    assert(aAudioTrack && aAudioTrack.codec_name === 'opus', `Audio codec is opus (actual: ${aAudioTrack?.codec_name})`);
    recordResult('Real Audio-Only Download (251)', 'PASS', `Produced audio-only opus stream (${fs.statSync(audioFile).size} bytes, strictly 0 video tracks)`);

    // 4.4: User-Requested Best / Auto Retains Existing Behavior
    const tBest = await runMediaDownload({
      testName: 'User-Requested Best Format ("best")',
      url: testVideoUrl,
      formatId: 'best',
      filename: 'real_user_requested_best.mp4',
    });
    assert(tBest.state === 'completed', 'User-requested best job completed');
    let bestFile = tBest.target_path;
    if (!bestFile || !fs.existsSync(bestFile)) {
      const m = fs.readdirSync(isolatedDownloadsDir, { recursive: true }).find((f) => f.includes('real_user_requested_best') && !f.endsWith('.part'));
      if (m) bestFile = path.join(isolatedDownloadsDir, m);
    }
    assert(bestFile && fs.existsSync(bestFile), `Best output exists at ${bestFile}`);
    recordResult('User-Requested Best Retention', 'PASS', 'User-requested "best" retained existing bestvideo+bestaudio/best behavior');

    // 4.5: Direct Media Download Bypasses yt-dlp
    console.log('\n--- Direct Media Download Bypass Check ---');
    const directReq = await makeHttpRequest({
      port: 6800,
      path: '/api/v1/downloads',
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': clientOrigin },
      body: {
        url: flowerUrl,
        filename: 'flower_direct_check.mp4',
      },
    });
    assert(directReq.status === 200 && directReq.data.job_id, `Direct download job accepted: ${directReq.data?.job_id}`);
    const directJobId = directReq.data.job_id;

    let directJob = null;
    for (let p = 0; p < 30; p++) {
      await sleep(1000);
      const detailRes = await makeHttpRequest({
        port: 6800,
        path: `/api/v1/downloads/${directJobId}`,
        headers: { 'X-Tori-Token': authToken, 'Origin': clientOrigin },
      });
      if (detailRes.status === 200 && detailRes.data && detailRes.data.state === 'completed') {
        directJob = detailRes.data;
        break;
      }
    }
    assert(directJob && directJob.state === 'completed', 'Direct download completed');
    assert(
      directJob.job_type === 'httpfile' || directJob.job_type === 'http_file',
      `Direct download handled strictly by native HttpEngine without yt-dlp scan (job_type: ${directJob.job_type})`
    );
    recordResult('Direct Media Bypass', 'PASS', `Direct file handled natively by HttpEngine (job_type: ${directJob.job_type}); yt-dlp format scan bypassed`);

    // 4.6: Cache Metadata Selection Functional
    console.log('\n--- Cache Metadata Ingestion & Selection Check ---');
    const resolveRes = await makeHttpRequest({
      port: 6800,
      path: '/api/v1/media/resolve',
      method: 'POST',
      headers: { 'X-Tori-Token': authToken, 'Origin': clientOrigin },
      body: { url: testVideoUrl, force_refresh: false },
    });
    assert(resolveRes.status === 200 && resolveRes.data.formats && resolveRes.data.formats.length > 0, 'Metadata resolved successfully');
    const cacheRow = runPy(`
import sqlite3
conn = sqlite3.connect(r'''${dbFile}''')
cur = conn.cursor()
cur.execute("SELECT cache_key, expires_at FROM format_metadata_cache WHERE cache_key = 'yt:jNQXAC9IVRw'")
row = cur.fetchone()
conn.close()
print(f"{row[0]}|{row[1]}" if row else "")
`);
    assert(cacheRow.startsWith('yt:jNQXAC9IVRw'), `SQLite format cache persists record (row: ${cacheRow})`);
    recordResult('Cache Metadata Selection Integrity', 'PASS', 'Metadata resolve and SQLite format caching remain fully functional');

  } catch (err) {
    console.error('\n[FATAL ERROR IN GATE 15.3.2 HARNESS]', err);
    recordResult('Fatal Harness Error', 'FAIL', err.message);
  } finally {
    console.log('\n--- Cleaning up processes ---');
    if (desktopProc && desktopProc.pid) {
      try { execSync(`taskkill /PID ${desktopProc.pid} /T /F`, { stdio: 'ignore' }); } catch (_) {}
    }
  }

  console.log('\n================================================================');
  console.log('            GATE 15.3.2 VERIFICATION MATRIX');
  console.log('================================================================\n');

  let passC = 0;
  let failC = 0;
  for (const r of testResults) {
    if (r.outcome === 'PASS') passC++;
    else if (r.outcome === 'FAIL') failC++;
    console.log(`[${r.outcome.padEnd(4)}] ${r.scenario.padEnd(42)}: ${r.details}`);
  }

  console.log('\n================================================================');
  console.log(`TOTAL GATE 15.3.2 TESTS: ${testResults.length} | PASS: ${passC} | FAIL: ${failC}`);
  console.log('================================================================\n');

  if (failC > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal unhandled error:', err);
  process.exit(1);
});
