const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const distDir = path.resolve(__dirname, '../ui/dist');
const outPng = path.resolve(__dirname, '../design/tori_desktop_ui_rendered.png');

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

server.listen(8899, () => {
  console.log('Static preview server listening on http://localhost:8899');

  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const outDarkPng = path.resolve(__dirname, '../design/tori_desktop_ui_dark_rendered.png');

  const argsLight = [
    '--headless=new',
    '--disable-gpu',
    '--window-size=1180,740',
    `--screenshot=${outPng}`,
    'http://localhost:8899/',
  ];

  const p1 = spawn(edge, argsLight);
  p1.on('exit', () => {
    console.log(`Light theme screenshot captured at ${outPng}`);

    // Capture dark theme
    const argsDark = [
      '--headless=new',
      '--disable-gpu',
      '--window-size=1180,740',
      '--force-dark-mode',
      '--enable-features=WebContentsForceDark',
      `--screenshot=${outDarkPng}`,
      'http://localhost:8899/',
    ];
    const p2 = spawn(edge, argsDark);
    p2.on('exit', () => {
      console.log(`Dark theme screenshot captured at ${outDarkPng}`);
      server.close(() => process.exit(0));
    });
  });
});
