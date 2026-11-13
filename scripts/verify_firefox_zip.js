/**
 * Programmatic ZIP archive validator for Firefox Add-on packages.
 * Validates against Mozilla Add-on Developer Hub submission requirements.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ZIP_PATH = path.join(PROJECT_ROOT, 'release', 'v1.0.5-rc', 'extensions', 'tori-companion-v1.0.6-firefox.zip');
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'extension', 'firefox', 'manifest.json');

function verifyZip() {
  console.log('=== Firefox Extension ZIP Archive Validation ===\n');
  console.log('Target Archive:', ZIP_PATH);

  if (!fs.existsSync(ZIP_PATH)) {
    console.error(`ERROR: Archive not found at ${ZIP_PATH}`);
    process.exit(1);
  }

  const stat = fs.statSync(ZIP_PATH);
  console.log(`Archive size: ${stat.size} bytes`);

  const buf = fs.readFileSync(ZIP_PATH);

  // Parse End of Central Directory
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    console.error('ERROR: End of Central Directory record (EOCD) not found. Invalid ZIP.');
    process.exit(1);
  }

  const cdEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  console.log(`Central Directory entries count: ${cdEntries}`);
  console.log(`Central Directory size: ${cdSize} bytes`);

  let cur = cdOffset;
  const entries = [];
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(cur) !== 0x02014b50) {
      console.error(`ERROR: Invalid central directory record header at offset ${cur}`);
      process.exit(1);
    }
    const nameLen = buf.readUInt16LE(cur + 28);
    const extraLen = buf.readUInt16LE(cur + 30);
    const commentLen = buf.readUInt16LE(cur + 32);
    const name = buf.toString('utf8', cur + 46, cur + 46 + nameLen);
    entries.push(name);
    cur += 46 + nameLen + extraLen + commentLen;
  }

  console.log('\n--- Archive Central Directory Entries ---');
  entries.forEach((e, idx) => {
    console.log(`[${(idx + 1).toString().padStart(2, '0')}] ${e}`);
  });

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  // Checklist
  const checks = [
    {
      id: 'CHECK 1',
      desc: 'Zero backslashes in entry names',
      pass: !entries.some(e => e.includes('\\')),
      details: entries.filter(e => e.includes('\\')),
    },
    {
      id: 'CHECK 2',
      desc: 'All directory separators use forward slashes (/)',
      pass: entries.every(e => !e.includes('\\')),
      details: 'All directory entries adhere to POSIX / separator',
    },
    {
      id: 'CHECK 3',
      desc: 'manifest.json is located directly at ZIP root',
      pass: entries.includes('manifest.json'),
      details: entries.find(e => e.endsWith('manifest.json')),
    },
    {
      id: 'CHECK 4',
      desc: 'No nested parent folder wrapping the extension root',
      pass: !entries.some(e => e.startsWith('extension/') || e.startsWith('firefox/')),
      details: 'Root-level files located at archive root',
    },
    {
      id: 'CHECK 5',
      desc: 'No absolute paths in entry names',
      pass: !entries.some(e => path.isAbsolute(e) || /^[a-zA-Z]:/.test(e) || e.startsWith('/')),
      details: 'All paths relative to archive root',
    },
    {
      id: 'CHECK 6',
      desc: 'No directory traversal (../) entries',
      pass: !entries.some(e => e.includes('..')),
      details: 'Zero traversal tokens detected',
    },
    {
      id: 'CHECK 7',
      desc: 'All manifest-referenced icons and scripts exist in archive',
      pass: (() => {
        const required = [
          'manifest.json',
          manifest.icons['16'],
          manifest.icons['32'],
          manifest.icons['48'],
          manifest.icons['128'],
          manifest.action.default_popup,
          manifest.options_ui.page,
          ...manifest.background.scripts,
          ...manifest.content_scripts[0].js,
          ...manifest.content_scripts[0].css,
        ];
        const missing = required.filter(f => !entries.includes(f));
        if (missing.length > 0) return false;
        return true;
      })(),
      details: 'All declared entrypoints present',
    },
    {
      id: 'CHECK 8',
      desc: 'No demo or preview files present in archive',
      pass: !entries.some(e => e.toLowerCase().includes('preview') || e.toLowerCase().includes('demo')),
      details: entries.filter(e => e.toLowerCase().includes('preview') || e.toLowerCase().includes('demo')),
    },
    {
      id: 'CHECK 9',
      desc: 'Manifest version equals 1.0.6',
      pass: manifest.version === '1.0.6',
      details: `version = ${manifest.version}`,
    },
    {
      id: 'CHECK 10',
      desc: 'Firefox extension ID preserved (tori-download-manager@toridm.org)',
      pass: manifest.browser_specific_settings?.gecko?.id === 'tori-download-manager@toridm.org',
      details: `gecko.id = ${manifest.browser_specific_settings?.gecko?.id}`,
    },
  ];

  console.log('\n--- Programmatic Verification Results ---');
  let allPass = true;
  for (const c of checks) {
    const mark = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${mark}] ${c.id}: ${c.desc}`);
    if (!c.pass) {
      console.log(`       Failure Details:`, c.details);
    }
  }

  console.log(`\nOVERALL ARCHIVE VERDICT: ${allPass ? 'PASS' : 'FAIL'}\n`);
  if (!allPass) process.exit(1);
}

verifyZip();
