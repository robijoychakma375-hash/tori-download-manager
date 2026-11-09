/**
 * TORI Download Manager v1.0.1 — Gate 17.4.2 Native Scheduler E2E Acceptance Harness
 *
 * Validates real Native Host HTTP Local API, SQLite persistence, and Scheduler event loop:
 * - Scenario 1: Future-scheduled download creation & auto-dispatch
 * - Scenario 2: Reschedule endpoint (/api/v1/downloads/:id/reschedule) to earlier time
 * - Scenario 3: Cancellation of scheduled download
 * - Scenario 4: Offline overdue catch-up on engine restart
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(PROJECT_ROOT, 'target', 'test_gate17_4_2_e2e');
const NATIVE_HOST_BIN = path.join(PROJECT_ROOT, 'target', 'release', 'tdm-native-host.exe');

let testResults = [];

function recordResult(scenario, outcome, details) {
  testResults.push({ scenario, outcome, details });
  const prefix = outcome === 'PASS' ? '[PASS]' : '[FAIL]';
  console.log(`${prefix} ${scenario}: ${details}`);
}

function assert(cond, msg) {
  if (cond) {
    console.log(`  [OK] ${msg}`);
  } else {
    console.error(`  [FAIL] ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function killProcess(proc) {
  if (!proc || !proc.pid) return;
  try {
    execSync(`taskkill /F /PID ${proc.pid} /T`, { stdio: 'ignore' });
  } catch (_) {}
}

function killProcessOnPort(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8' }).trim();
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      if (pid && !isNaN(pid) && pid !== process.pid) {
        try {
          execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
        } catch (_) {}
      }
    }
  } catch (_) {}
}

function runPy(script) {
  return execSync('python -', { input: script, encoding: 'utf8' }).trim();
}

function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const reqHeaders = {
      ...(options.headers || {}),
      Host: `127.0.0.1:${options.port}`,
      Origin: 'http://tauri.localhost',
    };
    if (body) {
      reqHeaders['Content-Type'] = 'application/json';
    }
    const req = http.request({ ...options, headers: reqHeaders }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch (_) {
          parsed = raw;
        }
        resolve({ statusCode: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// 1. Run local mock server serving 64 KB test file with Range support
function startMockServer(payload) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10) || 0;
        const end = parts[1] ? parseInt(parts[1], 10) : payload.length - 1;
        const chunk = payload.slice(start, end + 1);

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${payload.length}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunk.length,
          'Content-Type': 'application/octet-stream',
          ETag: '"gate17-4-2-etag"',
        });
        res.end(chunk);
      } else {
        res.writeHead(200, {
          'Content-Length': payload.length,
          'Accept-Ranges': 'bytes',
          'Content-Type': 'application/octet-stream',
          ETag: '"gate17-4-2-etag"',
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          res.end(payload);
        }
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

async function runE2ESuite() {
  console.log('================================================================');
  console.log('TORI v1.0.1 — GATE 17.4.2 NATIVE TIME-BASED SCHEDULER E2E TEST');
  console.log('================================================================\n');

  if (!fs.existsSync(NATIVE_HOST_BIN)) {
    throw new Error(`tdm-native-host.exe not found at ${NATIVE_HOST_BIN}`);
  }

  // Setup test sandbox directory
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const testPort = 6800;
  killProcessOnPort(testPort);

  const testToken = 'gate17-4-2-auth-token-12345';
  const dbPath = path.join(TEST_DIR, 'tdm_storage.sqlite');

  // Pre-seed SQLite with auth token and port
  runPy(`
import sqlite3, os
os.makedirs(r'${TEST_DIR}', exist_ok=True)
conn = sqlite3.connect(r'${dbPath}')
c = conn.cursor()
c.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
c.execute("INSERT OR REPLACE INTO engine_settings (key, value) VALUES ('browser_integration_token', '${testToken}')")
c.execute("INSERT OR REPLACE INTO engine_settings (key, value) VALUES ('browser_pairing_token', '${testToken}')")
c.execute("INSERT OR REPLACE INTO engine_settings (key, value) VALUES ('server_port', '${testPort}')")
conn.commit()
conn.close()
`);

  const payload = crypto.randomBytes(64 * 1024);
  const expectedSha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const { server: mockServer, port: mockPort } = await startMockServer(payload);
  console.log(`[INFO] Mock HTTP server listening on http://127.0.0.1:${mockPort}`);

  let hostProc = null;

  function spawnNativeHost() {
    const env = {
      ...process.env,
      TORI_DATA_DIR: TEST_DIR,
      TORI_ALLOWED_EXTENSION_ID: 'jfnfgmcbgapcpieaonbaolgebjaejcdm,bflchfddfgkfglmjapohkjmldepflkbe',
    };
    const proc = spawn(NATIVE_HOST_BIN, ['--server'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => process.stdout.write(`[HOST-STDOUT] ${d}`));
    proc.stderr.on('data', (d) => process.stderr.write(`[HOST-STDERR] ${d}`));
    return proc;
  }

  try {
    hostProc = spawnNativeHost();
    console.log('[INFO] Spawned tdm-native-host.exe --server. Waiting for readiness...');

    // Wait for ping
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await httpRequest({
          hostname: '127.0.0.1',
          port: testPort,
          path: '/api/v1/ping',
          method: 'GET',
          headers: { 'X-Tori-Token': testToken },
          timeout: 1000,
        });
        if (res.statusCode === 200 && res.data && res.data.status === 'ok') {
          ready = true;
          break;
        }
      } catch (_) {}
      await sleep(300);
    }
    assert(ready, 'Native host Local API server is responsive on /api/v1/ping');

    // =========================================================================
    // SCENARIO 1: Near-Future Scheduled Download
    // =========================================================================
    console.log('\n--- Scenario 1: Near-Future Scheduled Download (Auto-triggers & Completes) ---');
    const schedTime1 = new Date(Date.now() + 3000).toISOString();
    const destDir1 = path.join(TEST_DIR, 'downloads_s1');
    fs.mkdirSync(destDir1, { recursive: true });

    const createRes1 = await httpRequest(
      {
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/v1/downloads',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tori-Token': testToken,
        },
        timeout: 4000,
      },
      {
        url: `http://127.0.0.1:${mockPort}/file1.bin`,
        destination: destDir1,
        priority: 'normal',
        scheduled_at: schedTime1,
      }
    );

    assert(createRes1.statusCode === 200, `Created scheduled download HTTP 200 (got ${createRes1.statusCode})`);
    assert(createRes1.data.status === 'ok', `Response status is ok (got ${createRes1.data.status})`);
    assert(createRes1.data.state === 'scheduled', `Initial state is 'scheduled' (got ${createRes1.data.state})`);
    const jobId1 = createRes1.data.job_id;

    // Check before due time: must still be scheduled
    await sleep(800);
    const getResBefore = await httpRequest({
      hostname: '127.0.0.1',
      port: testPort,
      path: `/api/v1/downloads/${jobId1}`,
      method: 'GET',
      headers: { 'X-Tori-Token': testToken },
    });
    assert(getResBefore.data.state === 'scheduled', `Job still 'scheduled' before due time (got ${getResBefore.data.state})`);
    assert(getResBefore.data.scheduled_at !== null, `Job scheduled_at is populated`);

    // Wait until due time arrives and download completes
    console.log('  Waiting 3.5s for scheduler timer to trigger download...');
    await sleep(3500);

    let completed1 = false;
    for (let i = 0; i < 20; i++) {
      const getResAfter = await httpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: `/api/v1/downloads/${jobId1}`,
        method: 'GET',
        headers: { 'X-Tori-Token': testToken },
      });
      if (getResAfter.data.state === 'completed') {
        completed1 = true;
        break;
      }
      await sleep(300);
    }
    assert(completed1, 'Job transitioned from Scheduled to Completed after due time arrived');

    const targetFile1 = path.join(destDir1, 'file1.bin');
    assert(fs.existsSync(targetFile1), `Target file exists at ${targetFile1}`);
    const actualSha1 = crypto.createHash('sha256').update(fs.readFileSync(targetFile1)).digest('hex');
    assert(actualSha1 === expectedSha256, `SHA-256 integrity matches expected (${actualSha1})`);
    recordResult('Scenario 1: Scheduled Download Creation & Auto-Completion', 'PASS', 'Download stayed scheduled and automatically triggered & completed upon due time with verified SHA256');

    // =========================================================================
    // SCENARIO 2: Reschedule Endpoint
    // =========================================================================
    console.log('\n--- Scenario 2: Reschedule Endpoint (/api/v1/downloads/:id/reschedule) ---');
    const farFuture = new Date(Date.now() + 60000).toISOString();
    const destDir2 = path.join(TEST_DIR, 'downloads_s2');
    fs.mkdirSync(destDir2, { recursive: true });

    const createRes2 = await httpRequest(
      {
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/v1/downloads',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tori-Token': testToken,
        },
      },
      {
        url: `http://127.0.0.1:${mockPort}/file2_resched.bin`,
        destination: destDir2,
        priority: 'high',
        scheduled_at: farFuture,
      }
    );
    const jobId2 = createRes2.data.job_id;
    assert(createRes2.data.state === 'scheduled', `Job2 initialized in 'scheduled' for +60s`);

    // Reschedule to +2 seconds from now
    const nearResched = new Date(Date.now() + 2000).toISOString();
    const reschedRes = await httpRequest(
      {
        hostname: '127.0.0.1',
        port: testPort,
        path: `/api/v1/downloads/${jobId2}/reschedule`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tori-Token': testToken,
        },
      },
      { scheduled_at: nearResched }
    );
    assert(reschedRes.statusCode === 200, `Reschedule returned 200 (got ${reschedRes.statusCode})`);
    assert(reschedRes.data.status === 'ok', `Reschedule status is ok`);

    // Wait 3.5s: verify it completes at the new earlier time
    await sleep(3500);
    let completed2 = false;
    for (let i = 0; i < 15; i++) {
      const getRes2 = await httpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: `/api/v1/downloads/${jobId2}`,
        method: 'GET',
        headers: { 'X-Tori-Token': testToken },
      });
      if (getRes2.data.state === 'completed') {
        completed2 = true;
        break;
      }
      await sleep(300);
    }
    assert(completed2, 'Job2 completed at rescheduled earlier time without waiting 60s');
    recordResult('Scenario 2: Reschedule Endpoint', 'PASS', 'Successfully updated scheduled timestamp via API and verified immediate earlier trigger');

    // =========================================================================
    // SCENARIO 3: Cancellation of Scheduled Download
    // =========================================================================
    console.log('\n--- Scenario 3: Cancel Scheduled Download ---');
    const destDir3 = path.join(TEST_DIR, 'downloads_s3');
    fs.mkdirSync(destDir3, { recursive: true });

    const createRes3 = await httpRequest(
      {
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/v1/downloads',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tori-Token': testToken,
        },
      },
      {
        url: `http://127.0.0.1:${mockPort}/file3_cancel.bin`,
        destination: destDir3,
        scheduled_at: new Date(Date.now() + 30000).toISOString(),
      }
    );
    const jobId3 = createRes3.data.job_id;

    // Cancel it
    const cancelRes = await httpRequest({
      hostname: '127.0.0.1',
      port: testPort,
      path: `/api/v1/downloads/${jobId3}/cancel`,
      method: 'POST',
      headers: { 'X-Tori-Token': testToken },
    });
    assert(cancelRes.statusCode === 200, `Cancel returned 200`);

    const getRes3 = await httpRequest({
      hostname: '127.0.0.1',
      port: testPort,
      path: `/api/v1/downloads/${jobId3}`,
      method: 'GET',
      headers: { 'X-Tori-Token': testToken },
    });
    assert(getRes3.data.state === 'cancelled', `State is cancelled (got ${getRes3.data.state})`);
    assert(getRes3.data.scheduled_at === null, `scheduled_at cleared upon cancellation`);
    recordResult('Scenario 3: Cancel Scheduled Download', 'PASS', 'Scheduled download cancelled cleanly, cleared scheduler registration and database timestamp');

    // =========================================================================
    // SCENARIO 4: Overdue Startup Catch-Up Policy
    // =========================================================================
    console.log('\n--- Scenario 4: Overdue Startup Catch-Up Policy ---');
    const destDir4 = path.join(TEST_DIR, 'downloads_s4');
    fs.mkdirSync(destDir4, { recursive: true });

    // Create a job scheduled for future
    const createRes4 = await httpRequest(
      {
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/v1/downloads',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tori-Token': testToken,
        },
      },
      {
        url: `http://127.0.0.1:${mockPort}/file4_catchup.bin`,
        destination: destDir4,
        scheduled_at: new Date(Date.now() + 60000).toISOString(),
      }
    );
    const jobId4 = createRes4.data.job_id;

    // Stop Native Host and desktop engine processes
    console.log('  Stopping host and engine processes...');
    killProcess(hostProc);
    killProcessOnPort(testPort);
    try {
      execSync('taskkill /F /IM tori-download-manager.exe /T', { stdio: 'ignore' });
    } catch (_) {}
    await sleep(1500);

    // Find SQLite db in TEST_DIR
    const dbFiles = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.sqlite') || f.endsWith('.db'));
    assert(dbFiles.length > 0, `Found SQLite database file: ${dbFiles[0]}`);
    const actualDbPath = path.join(TEST_DIR, dbFiles[0]);

    // Backdate scheduled_at in SQLite to 20 seconds in the past using python
    runPy(`
import sqlite3
con = sqlite3.connect(r"${actualDbPath}")
cur = con.cursor()
cur.execute("UPDATE downloads SET scheduled_at = '2020-01-01T00:00:00Z' WHERE id = '${jobId4}'")
con.commit()
con.close()
print("UPDATED")
`);
    console.log('  Backdated scheduled_at in SQLite to simulate offline overdue job.');

    killProcessOnPort(testPort);
    await sleep(500);

    // Restart host process
    console.log('  Restarting Native Host process...');
    hostProc = spawnNativeHost();

    // Wait for readiness
    let restartedReady = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await httpRequest({
          hostname: '127.0.0.1',
          port: testPort,
          path: '/api/v1/ping',
          method: 'GET',
          headers: { 'X-Tori-Token': testToken },
          timeout: 1000,
        });
        if (res.statusCode === 200) {
          restartedReady = true;
          break;
        }
      } catch (_) {}
      await sleep(300);
    }
    assert(restartedReady, 'Restarted host is responsive');

    // Verify overdue catch-up: startup reconciliation should admit overdue job immediately into queued/downloading
    let catchupDone = false;
    for (let i = 0; i < 20; i++) {
      const getRes4 = await httpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: `/api/v1/downloads/${jobId4}`,
        method: 'GET',
        headers: { 'X-Tori-Token': testToken },
      });
      if (getRes4.data.state === 'completed') {
        catchupDone = true;
        break;
      }
      await sleep(300);
    }
    assert(catchupDone, 'Overdue scheduled job automatically caught up on startup and completed');
    recordResult('Scenario 4: Overdue Startup Catch-Up Policy', 'PASS', 'Offline overdue scheduled download immediately admitted by reconcile_on_startup and executed without manual intervention');

  } finally {
    if (hostProc) killProcess(hostProc);
    mockServer.close();
  }

  console.log('\n================================================================');
  console.log('GATE 17.4.2 E2E VERIFICATION SUMMARY');
  console.log('================================================================');
  testResults.forEach((r) => {
    console.log(`- [${r.outcome}] ${r.scenario}: ${r.details}`);
  });

  const allPassed = testResults.every((r) => r.outcome === 'PASS');
  if (allPassed) {
    console.log('\n>>> ALL 4 GATE 17.4.2 E2E SCENARIOS PASSED SUCCESSFULLY <<<');
    process.exit(0);
  } else {
    console.error('\n>>> SOME SCENARIOS FAILED <<<');
    process.exit(1);
  }
}

runE2ESuite().catch((err) => {
  console.error('\n[FATAL ERROR in E2E harness]:', err);
  process.exit(1);
});
