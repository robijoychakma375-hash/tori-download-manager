const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const distDir = path.resolve(__dirname, '../ui/dist');
const outMainPng = path.resolve(__dirname, '../design/tori_desktop_ui_rendered.png');
const outDarkPng = path.resolve(__dirname, '../design/tori_desktop_ui_dark_rendered.png');
const outSettingsPng = path.resolve(__dirname, '../design/tori_settings_rendered.png');
const outSettingsDarkPng = path.resolve(__dirname, '../design/tori_settings_dark_rendered.png');

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(distDir, reqPath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function capture(url, outPath, darkMode) {
  return new Promise((resolve) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--window-size=1180,740',
      darkMode ? '--force-dark-mode' : '',
      darkMode ? '--enable-features=WebContentsForceDark' : '',
      `--screenshot=${outPath}`,
      url,
    ].filter(Boolean);

    const proc = spawn(edge, args);
    proc.on('exit', () => {
      console.log(`Captured: ${path.basename(outPath)}`);
      resolve();
    });
  });
}

server.listen(8899, async () => {
  console.log('Static preview server listening on http://localhost:8899');

  try {
    // 1. Main light
    await capture('http://localhost:8899/', outMainPng, false);
    // 2. Main dark
    await capture('http://localhost:8899/', outDarkPng, true);
    // 3. Settings light
    await capture('http://localhost:8899/?modal=settings', outSettingsPng, false);
    // 4. Settings dark
    await capture('http://localhost:8899/?modal=settings', outSettingsDarkPng, true);
  } finally {
    server.close(() => {
      console.log('All screenshots captured successfully.');
      process.exit(0);
    });
  }
});

