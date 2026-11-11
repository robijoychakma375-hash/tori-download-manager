const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const profileDir = path.resolve('target/firefox_cdp_test');
if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

const prefs = [
  'user_pref("devtools.debugger.remote-enabled", true);',
  'user_pref("devtools.debugger.prompt-connection", false);',
  'user_pref("devtools.chrome.enabled", true);',
  'user_pref("remote.active-protocols", 3);'
].join('\n');
fs.writeFileSync(path.join(profileDir, 'user.js'), prefs);

console.log('Launching Firefox on port 9229 with isolated profile:', profileDir);
const ff = spawn('C:\\Program Files\\Mozilla Firefox\\firefox.exe', [
  '-no-remote',
  '-profile', profileDir,
  '--remote-debugging-port', '9229',
  'about:blank'
], { stdio: 'ignore' });

let attempts = 0;
const interval = setInterval(() => {
  attempts++;
  http.get('http://127.0.0.1:9229/json/version', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log('SUCCESS! Firefox CDP endpoint active:\n', data);
      clearInterval(interval);
      ff.kill();
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
      process.exit(0);
    });
  }).on('error', (err) => {
    if (attempts >= 10) {
      console.error('Firefox failed to answer CDP after 10 attempts:', err.message);
      clearInterval(interval);
      ff.kill();
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
      process.exit(1);
    }
  });
}, 800);
