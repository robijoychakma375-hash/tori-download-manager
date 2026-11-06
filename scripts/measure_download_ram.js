const http = require('http');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeReq(port, reqPath, method, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers: {
        'X-Tori-Token': token,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(_) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function getProcessMemory(pid) {
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).WorkingSet64 / 1MB; (Get-Process -Id ${pid}).PrivateMemorySize64 / 1MB"`, { encoding: 'utf8' }).trim().split('\r\n');
    return {
      wsMB: parseFloat(out[0]),
      pmMB: parseFloat(out[1])
    };
  } catch (e) {
    return { wsMB: 0, pmMB: 0 };
  }
}

async function main() {
  console.log('--- Starting controlled HTTP test server on port 19888 ---');
  const payloadChunk = Buffer.alloc(1024 * 1024, 0x5a); // 1 MB chunk
  const totalSize = 40 * 1024 * 1024; // 40 MB
  
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': totalSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream'
      });
      res.end();
      return;
    }
    
    const range = req.headers.range;
    if (range && range.startsWith('bytes=')) {
      const parts = range.replace('bytes=', '').split('-');
      const start = parseInt(parts[0], 10) || 0;
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
      const len = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Content-Length': len,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream'
      });
      // Stream in 1 MB chunks with slight delay to capture in-flight memory
      let sent = 0;
      const interval = setInterval(() => {
        if (sent >= len) {
          clearInterval(interval);
          res.end();
          return;
        }
        const toSend = Math.min(len - sent, 1024 * 1024);
        res.write(payloadChunk.subarray(0, toSend));
        sent += toSend;
      }, 50);
      req.on('close', () => clearInterval(interval));
    } else {
      res.writeHead(200, { 'Content-Length': totalSize, 'Content-Type': 'application/octet-stream' });
      res.end(payloadChunk);
    }
  });

  await new Promise(r => server.listen(19888, '127.0.0.1', r));
  console.log('Server listening on http://127.0.0.1:19888');

  // Spawn TORI Desktop release engine
  const exePath = path.resolve('target/release/tori-download-manager.exe');
  const toriProc = spawn(exePath, ['--minimized'], { stdio: 'ignore' });
  await sleep(2500);

  // Read auth token
  const pythonCmd = `python -c "import sqlite3, os; p = os.path.join(os.environ['APPDATA'], 'tori-download-manager', 'tdm_storage.sqlite'); conn = sqlite3.connect(p); cur = conn.cursor(); cur.execute('SELECT value FROM engine_settings WHERE key=\\'browser_integration_token\\''); print(cur.fetchone()[0])"`;
  const token = execSync(pythonCmd, { encoding: 'utf8' }).trim();
  console.log('Pairing token acquired:', token.substring(0, 8) + '...');

  const idleMem = getProcessMemory(toriProc.pid);
  console.log(`[MEASUREMENT: IDLE RAM] Working Set: ${idleMem.wsMB.toFixed(2)} MB | Private Bytes: ${idleMem.pmMB.toFixed(2)} MB`);

  const destDir = path.resolve('target/test_mem_downloads');
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  // 1 Download Active
  console.log('\n--- Starting 1 Download ---');
  const dl1 = await makeReq(6800, '/api/v1/downloads', 'POST', token, {
    url: 'http://127.0.0.1:19888/test1.bin',
    destination: destDir,
    filename: 'test1.bin'
  });
  console.log('Job 1 ID:', dl1.job_id);

  let mem1 = getProcessMemory(toriProc.pid);
  for (let i = 0; i < 5; i++) {
    await sleep(400);
    const m = getProcessMemory(toriProc.pid);
    if (m.wsMB > mem1.wsMB) mem1 = m;
  }
  console.log(`[MEASUREMENT: 1 ACTIVE DOWNLOAD] Working Set: ${mem1.wsMB.toFixed(2)} MB | Private Bytes: ${mem1.pmMB.toFixed(2)} MB`);

  // 4 Concurrent Downloads Active
  console.log('\n--- Starting 3 additional downloads (total 4 concurrent) ---');
  const jobs = [dl1.job_id];
  for (let j = 2; j <= 4; j++) {
    const res = await makeReq(6800, '/api/v1/downloads', 'POST', token, {
      url: `http://127.0.0.1:19888/test${j}.bin`,
      destination: destDir,
      filename: `test${j}.bin`
    });
    jobs.push(res.job_id);
  }

  let mem4 = getProcessMemory(toriProc.pid);
  for (let i = 0; i < 8; i++) {
    await sleep(400);
    const m = getProcessMemory(toriProc.pid);
    if (m.wsMB > mem4.wsMB) mem4 = m;
  }
  console.log(`[MEASUREMENT: 4 CONCURRENT DOWNLOADS] Working Set: ${mem4.wsMB.toFixed(2)} MB | Private Bytes: ${mem4.pmMB.toFixed(2)} MB`);

  // Cleanup
  console.log('\n--- Cleaning up ---');
  for (const id of jobs) {
    if (id) await makeReq(6800, `/api/v1/downloads/${id}/delete`, 'POST', token);
  }
  toriProc.kill();
  server.close();
  console.log('Benchmark finished.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
