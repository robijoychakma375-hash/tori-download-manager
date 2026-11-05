const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const uiDistDir = path.resolve(__dirname, '../ui/dist');
const designDir = path.resolve(__dirname, '../design/tori-final');
const artifactsDir = path.resolve(
  process.env.USERPROFILE || 'C:\\Users\\ritud',
  '.gemini\\antigravity\\brain\\a7c2f92e-8b93-4652-b855-301b023ae246'
);

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, 'http://localhost:8897');
  let pathname = parsedUrl.pathname;

  if (pathname.startsWith('/design/')) {
    const relPath = pathname.replace('/design/', '');
    const filePath = path.join(designDir, relPath);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found in design');
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(data);
    });
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(uiDistDir, pathname);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found in ui/dist');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function capture(url, outPath, width = 600, height = 300) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      `--window-size=${width},${height}`,
      `--screenshot=${outPath}`,
      url,
    ];

    const proc = spawn(edge, args);
    proc.on('exit', (code) => {
      if (code === 0) {
        console.log(`Captured: ${path.basename(outPath)}`);
        resolve();
      } else {
        reject(new Error(`Edge exited with code ${code}`));
      }
    });
  });
}

server.listen(8897, async () => {
  console.log('Toast verification server listening on http://localhost:8897');

  try {
    // 1. Reference states
    // In tori-download-toast.html, container is inside #stage
    await capture(
      'http://localhost:8897/design/tori-download-toast.html',
      path.join(artifactsDir, 'ref_toast_stage.png'),
      1080,
      680
    );

    // 2. Actual Toast states (width 520, height 180 or 320 for expanded)
    // Downloading (default)
    await capture(
      'http://localhost:8897/index.html?window=toast&demo=1&state=down',
      path.join(artifactsDir, 'actual_toast_down.png'),
      520,
      140
    );

    // Paused
    await capture(
      'http://localhost:8897/index.html?window=toast&demo=1&state=paused',
      path.join(artifactsDir, 'actual_toast_paused.png'),
      520,
      140
    );

    // Done
    await capture(
      'http://localhost:8897/index.html?window=toast&demo=1&state=done',
      path.join(artifactsDir, 'actual_toast_done.png'),
      520,
      140
    );

    // Failed
    await capture(
      'http://localhost:8897/index.html?window=toast&demo=1&state=failed',
      path.join(artifactsDir, 'actual_toast_failed.png'),
      520,
      140
    );

    // Expanded with connection meters
    await capture(
      'http://localhost:8897/index.html?window=toast&demo=1&state=expanded',
      path.join(artifactsDir, 'actual_toast_expanded.png'),
      520,
      250
    );

    // Dark theme
    await capture(
      'http://localhost:8897/index.html?window=toast&demo=1&state=down&theme=dark',
      path.join(artifactsDir, 'actual_toast_dark.png'),
      520,
      140
    );

    // Ocean accent
    await capture(
      'http://localhost:8897/index.html?window=toast&demo=1&state=down&accent=ocean',
      path.join(artifactsDir, 'actual_toast_ocean.png'),
      520,
      140
    );

    // Emerald accent
    await capture(
      'http://localhost:8897/index.html?window=toast&demo=1&state=down&accent=emerald',
      path.join(artifactsDir, 'actual_toast_emerald.png'),
      520,
      140
    );

    // Rose accent
    await capture(
      'http://localhost:8897/index.html?window=toast&demo=1&state=down&accent=rose',
      path.join(artifactsDir, 'actual_toast_rose.png'),
      520,
      140
    );

    console.log('All toast screenshots successfully captured!');
  } catch (err) {
    console.error('Error during capture:', err);
  } finally {
    server.close();
  }
});

