const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const uiDistDir = path.resolve(__dirname, '../ui/dist');
const designDir = path.resolve(__dirname, '../design/tori-final');
const artifactsDir = path.resolve(process.env.USERPROFILE || 'C:\\Users\\ritud', '.gemini\\antigravity\\brain\\a7c2f92e-8b93-4652-b855-301b023ae246');

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, 'http://localhost:8899');
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

function capture(url, outPath, width = 1180, height = 740) {
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

server.listen(8899, async () => {
  console.log('Design verification server listening on http://localhost:8899');

  try {
    const targets = [
      {
        url: 'http://localhost:8899/?demo=1&theme=light&accent=indigo',
        file: 'actual_app_main_light_indigo.png',
        w: 1180,
        h: 740,
      },
      {
        url: 'http://localhost:8899/?demo=1&theme=dark&accent=indigo',
        file: 'actual_app_main_dark_indigo.png',
        w: 1180,
        h: 740,
      },
      {
        url: 'http://localhost:8899/?demo=1&modal=settings&tab=appearance&theme=light&accent=indigo',
        file: 'actual_app_settings_appearance.png',
        w: 1180,
        h: 740,
      },
      {
        url: 'http://localhost:8899/?demo=1&modal=settings&tab=engine&theme=light&accent=indigo',
        file: 'actual_app_settings_engine.png',
        w: 1180,
        h: 740,
      },
      {
        url: 'http://localhost:8899/?demo=1&modal=settings&tab=integration&theme=light&accent=indigo',
        file: 'actual_app_settings_integration.png',
        w: 1180,
        h: 740,
      },
      {
        url: 'http://localhost:8899/?demo=1&modal=settings&tab=about&theme=light&accent=indigo',
        file: 'actual_app_settings_about.png',
        w: 1180,
        h: 740,
      },
    ];

    for (const t of targets) {
      const outPath = path.join(artifactsDir, t.file);
      await capture(t.url, outPath, t.w, t.h);
    }

    console.log('Screenshots re-captured successfully!');
  } catch (err) {
    console.error('Capture error:', err);
  } finally {
    server.close(() => {
      process.exit(0);
    });
  }
});
