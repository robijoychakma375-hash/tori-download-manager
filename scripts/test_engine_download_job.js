const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MAIN_EXE = path.join(ROOT, 'target', 'debug', 'tori-download-manager.exe');
const QA_DIR = path.join(ROOT, 'target', 'engine_download_test_qa');
const DATA_DIR = path.join(QA_DIR, 'data');
const TOKEN = 'tori_audit_token_test_888';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function req(port, reqPath, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (postData) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }
    const r = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers: reqHeaders }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, data }); }
      });
    });
    r.on('error', reject);
    if (postData) r.write(postData);
    r.end();
  });
}

async function testEngineDownload() {
  console.log('Testing real engine download request on 127.0.0.1:6800...');

  if (fs.existsSync(QA_DIR)) {
    try { fs.rmSync(QA_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Seed SQLite with auth token
  const dbPath = path.join(DATA_DIR, 'tdm_storage.sqlite');
  execSync(`python -c "import sqlite3, json; conn=sqlite3.connect(r'''${dbPath}'''); c=conn.cursor(); c.execute('PRAGMA journal_mode = WAL'); c.execute('CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); c.execute('INSERT OR REPLACE INTO engine_settings VALUES (?,?)', ('browser_integration_token','${TOKEN}')); c.execute('INSERT OR REPLACE INTO engine_settings VALUES (?,?)', ('api_token','${TOKEN}')); payload = json.dumps({'dir': r'''${DATA_DIR}''', 'port': 6800, 'key': '${TOKEN}', 'closeToTray': True}); c.execute('INSERT OR REPLACE INTO engine_settings VALUES (?,?)', ('app_settings', payload)); conn.commit(); conn.close()"`);

  // Mock server serving test video file
  const fileServer = http.createServer((q, s) => {
    const buf = Buffer.alloc(1024 * 256, 0x42);
    s.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length, 'Accept-Ranges': 'bytes' });
    s.end(buf);
  });
  await new Promise(r => fileServer.listen(19890, '127.0.0.1', r));

  const desktopProc = spawn(MAIN_EXE, [], {
    env: {
      ...process.env,
      TORI_DATA_DIR: DATA_DIR,
      WEBVIEW2_USER_DATA_FOLDER: path.join(QA_DIR, 'wv2'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=19892'
    },
    stdio: 'ignore'
  });

  let engineUp = false;
  for (let i = 0; i < 35; i++) {
    await sleep(400);
    try {
      const p = await req(6800, '/api/v1/ping');
      if (p.status === 200) { engineUp = true; break; }
    } catch (_) {}
  }
  if (!engineUp) {
    desktopProc.kill();
    fileServer.close();
    throw new Error('Engine did not start on 6800');
  }

  // 1. Submit download job to engine with auth token
  const dlRes = await req(6800, '/api/v1/downloads', 'POST', {
    url: 'http://127.0.0.1:19890/test-video.mp4',
    filename: 'test-video.mp4',
    priority: 'high'
  }, { 'X-Tori-Token': TOKEN });
  console.log('Download submission response:', dlRes.status, dlRes.data);

  // 2. Query download list from engine with auth token
  await sleep(1000);
  const listRes = await req(6800, '/api/v1/downloads', 'GET', null, { 'X-Tori-Token': TOKEN });
  console.log('Download jobs in engine:', listRes.data?.jobs?.length || 0);

  desktopProc.kill();
  fileServer.close();

  const success = (dlRes.status === 200 || dlRes.status === 201) &&
                  (dlRes.data?.status === 'ok' || dlRes.data?.job_id || dlRes.data?.id);
  console.log('Engine download submission success:', success);
  if (!success) process.exit(1);
}

testEngineDownload().catch(e => {
  console.error(e);
  process.exit(1);
});
