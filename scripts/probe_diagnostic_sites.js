const https = require('https');
const { execSync } = require('child_process');

const sites = [
  'https://fprime.at',
  'https://flaxjoy.app',
  'https://zetmoon.live'
];

async function probeSite(url) {
  console.log('\n=== Probing Site: ' + url + ' ===');
  try {
    const t0 = Date.now();
    const res = await new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: 8000
      }, resolve);
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP request timeout')); });
    });
    
    let body = '';
    for await (const chunk of res) {
      body += chunk;
      if (body.length > 100000) break;
    }
    const elapsed = Date.now() - t0;
    console.log('HTTP Status:', res.statusCode);
    console.log('Elapsed ms:', elapsed);
    console.log('Server:', res.headers['server'] || 'Unknown');
    console.log('Content-Type:', res.headers['content-type']);
    console.log('Cloudflare Ray:', res.headers['cf-ray'] || 'None');
    console.log('Has Cloudflare challenge/turnstile:', body.includes('cf-chl') || body.includes('cf-turnstile') || body.includes('Just a moment...'));
    console.log('Has <video> in initial HTML:', body.includes('<video'));
    console.log('Has <iframe> in initial HTML:', body.includes('<iframe'));
  } catch (err) {
    console.log('HTTP Fetch Error:', err.message);
  }

  // yt-dlp probe
  try {
    const y0 = Date.now();
    console.log('Running yt-dlp probe...');
    try {
      const ytdlpOut = execSync(`yt-dlp --no-playlist -J "${url}"`, { timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
      console.log('yt-dlp succeeded:', ytdlpOut.toString().slice(0, 100));
    } catch (yErr) {
      const yElapsed = Date.now() - y0;
      const stderr = yErr.stderr ? yErr.stderr.toString().trim() : '';
      console.log(`yt-dlp failed in ${yElapsed}ms with status ${yErr.status}`);
      console.log('yt-dlp stderr snippet:', stderr.slice(0, 250));
    }
  } catch (e) {
    console.log('yt-dlp execution error:', e.message);
  }
}

(async () => {
  for (const s of sites) {
    await probeSite(s);
  }
})();

