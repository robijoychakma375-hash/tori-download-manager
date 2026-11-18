#!/usr/bin/env node
/**
 * TORI Browser Companion v1.0.10 — Cross-Browser Packaging & Sync (Gate 31.1 RC)
 *
 * 1. Verifies historical Mozilla-signed Firefox v1.0.7 & v1.0.9 XPIs remain intact and untouched.
 * 2. Syncs non-manifest extension source files from extension/ into extension/firefox/.
 * 3. Stages release/v1.0.10-extension-rc/ with:
 *    - tori-companion-v1.0.10-chromium/ (unpacked Chromium & Edge directory)
 *    - tori-companion-v1.0.10-chromium.zip (POSIX forward-slash ZIP)
 *    - tori-companion-v1.0.10-firefox.zip (Mozilla web-ext build + web-ext lint 0 errors)
 *    - SHA256SUMS.txt & verification_metadata.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');
const FF_DIR = path.join(EXT_DIR, 'firefox');
const RC_DIR = path.join(ROOT, 'release', 'v1.0.10-extension-rc');

const PRESERVED_XPIS = [
  {
    label: 'v1.0.7 signed XPI',
    file: path.join(ROOT, 'release', 'v1.0.7-extension-rc', 'a70ed17e183648a9bcf4-1.0.7.xpi'),
    expectedSha256: 'b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0',
  },
  {
    label: 'v1.0.9 signed XPI',
    file: path.join(ROOT, 'release', 'v1.0.5-v1.0.9-final-rc', 'Extensions', 'a70ed17e183648a9bcf4-1.0.9.xpi'),
    expectedSha256: 'd4e8d6e585ba6dfaf841eb6b37f2ee27beae1cec55badbbe0dd12960ad5943ec',
  },
];

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function copyTreeFiltered(src, dest, { excludeNames = new Set() } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (excludeNames.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTreeFiltered(s, d, { excludeNames });
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function collectFiles(dir, baseDir = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full, baseDir));
    } else if (entry.isFile()) {
      out.push(path.relative(baseDir, full).replace(/\\/g, '/'));
    }
  }
  return out.sort();
}

function createPosixZip(sourceDir, outZipPath) {
  const pyScript = [
    'import os, sys, zipfile',
    'src = os.path.abspath(sys.argv[1])',
    'out = os.path.abspath(sys.argv[2])',
    'with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:',
    '    for root, dirs, files in os.walk(src):',
    '        dirs.sort()',
    '        files.sort()',
    '        for fn in files:',
    '            full = os.path.join(root, fn)',
    '            rel = os.path.relpath(full, src).replace("\\\\", "/")',
    '            zf.write(full, rel)',
  ].join('\n');
  execFileSync('python', ['-c', pyScript, sourceDir, outZipPath], { stdio: 'inherit' });
}

function inspectZip(zipPath) {
  const pyScript = [
    'import json, sys, zipfile',
    'p = sys.argv[1]',
    'with zipfile.ZipFile(p, "r") as zf:',
    '    bad = zf.testzip()',
    '    names = [info.filename for info in zf.infolist()]',
    '    bs = [n for n in names if "\\\\" in n]',
    '    manifest = json.loads(zf.read("manifest.json").decode("utf-8"))',
    'print(json.dumps({"bad": bad, "count": len(names), "backslashes": bs, "names": names, "version": manifest.get("version")}))',
  ].join('\n');
  const raw = execFileSync('python', ['-c', pyScript, zipPath], { encoding: 'utf8' });
  return JSON.parse(raw);
}

function runCmd(cmd, args, cwd) {
  const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  return execFileSync(`${cmd} ${quoted.join(' ')}`, { cwd, encoding: 'utf8', shell: true });
}

function main() {
  console.log('=== TORI Browser Companion v1.0.10 Packaging ===');

  // 1. Preserve historical signed Firefox XPIs
  for (const item of PRESERVED_XPIS) {
    if (!fs.existsSync(item.file)) {
      throw new Error(`Missing preserved ${item.label} at ${item.file}`);
    }
    const actual = sha256File(item.file);
    if (actual !== item.expectedSha256) {
      throw new Error(`${item.label} hash mismatch: expected ${item.expectedSha256}, got ${actual}`);
    }
    console.log(`[OK] Preserved ${item.label} SHA-256: ${actual}`);
  }

  // 2. Validate manifests at 1.0.10
  const chrManifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  const ffManifest = JSON.parse(fs.readFileSync(path.join(FF_DIR, 'manifest.json'), 'utf8'));
  if (chrManifest.version !== '1.0.10' || ffManifest.version !== '1.0.10') {
    throw new Error(`Manifest version mismatch: chrome=${chrManifest.version}, firefox=${ffManifest.version}`);
  }

  // 3. Sync shared files into extension/firefox/ (preserving firefox/manifest.json)
  const syncItems = ['background.js', 'content.js', 'content.css', 'shared', 'popup', 'options', 'icons'];
  for (const item of syncItems) {
    const src = path.join(EXT_DIR, item);
    const dst = path.join(FF_DIR, item);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing source extension item: ${src}`);
    }
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.rmSync(dst, { recursive: true, force: true });
      copyTreeFiltered(src, dst, { excludeNames: new Set(['preview.html', '.DS_Store']) });
    } else {
      fs.copyFileSync(src, dst);
    }
  }
  console.log('[OK] Synced non-manifest source files -> extension/firefox/');

  const sharedPaths = [
    'background.js',
    'content.js',
    'content.css',
    'shared/tokens.css',
    'popup/popup.html',
    'popup/popup.css',
    'popup/popup.js',
    'options/options.html',
    'options/options.css',
    'options/options.js',
  ];
  for (const rel of sharedPaths) {
    const h1 = sha256File(path.join(EXT_DIR, rel));
    const h2 = sha256File(path.join(FF_DIR, rel));
    if (h1 !== h2) {
      throw new Error(`Byte parity check failed for ${rel}`);
    }
  }
  console.log(`[OK] Verified byte-level parity across ${sharedPaths.length} Chromium/Firefox shared source files`);

  // 4. Clean and stage v1.0.10 RC directory
  fs.rmSync(RC_DIR, { recursive: true, force: true });
  fs.mkdirSync(RC_DIR, { recursive: true });

  const chrUnpackedDir = path.join(RC_DIR, 'tori-companion-v1.0.10-chromium');
  copyTreeFiltered(EXT_DIR, chrUnpackedDir, {
    excludeNames: new Set(['firefox', 'preview.html', '.DS_Store', '.git']),
  });

  const chrZipPath = path.join(RC_DIR, 'tori-companion-v1.0.10-chromium.zip');
  createPosixZip(chrUnpackedDir, chrZipPath);
  const chrInspect = inspectZip(chrZipPath);
  if (chrInspect.bad !== null || chrInspect.backslashes.length > 0 || chrInspect.version !== '1.0.10') {
    throw new Error(`Chromium ZIP verification failed: ${JSON.stringify(chrInspect)}`);
  }
  if (!chrInspect.names.includes('shared/tokens.css') || chrInspect.names.some((n) => n.endsWith('preview.html'))) {
    throw new Error('Chromium ZIP missing shared/tokens.css or unexpectedly includes preview.html');
  }
  console.log(`[OK] Built & verified Chromium ZIP (${chrInspect.count} entries): ${chrZipPath}`);

  // 5. Build Firefox ZIP with web-ext lint + build
  const ffStagingDir = path.join(ROOT, 'target', 'v110_ff_build_stage');
  const ffArtifactsDir = path.join(ROOT, 'target', 'v110_ff_build_out');
  fs.rmSync(ffStagingDir, { recursive: true, force: true });
  fs.rmSync(ffArtifactsDir, { recursive: true, force: true });
  copyTreeFiltered(FF_DIR, ffStagingDir, {
    excludeNames: new Set(['preview.html', '.DS_Store', '.git']),
  });

  console.log('[RUN] npx --no-install web-ext lint...');
  const lintOut = runCmd(
    'npx',
    ['--no-install', 'web-ext', 'lint', '--source-dir', ffStagingDir, '--output', 'json'],
    ROOT
  );
  const lintJson = JSON.parse(lintOut.trim());
  if (lintJson.errors && lintJson.errors.length > 0) {
    throw new Error(`web-ext lint reported errors: ${JSON.stringify(lintJson.errors)}`);
  }
  console.log(
    `[OK] web-ext lint passed: 0 errors, ${lintJson.summary?.warnings || 0} warnings, ${lintJson.summary?.notices || 0} notices`
  );

  console.log('[RUN] npx --no-install web-ext build...');
  runCmd(
    'npx',
    ['--no-install', 'web-ext', 'build', '--source-dir', ffStagingDir, '--artifacts-dir', ffArtifactsDir, '--overwrite-dest'],
    ROOT
  );

  const builtFiles = fs.readdirSync(ffArtifactsDir).filter((f) => f.endsWith('.zip'));
  if (builtFiles.length !== 1) {
    throw new Error(`Expected 1 web-ext artifact, found ${builtFiles.length}: ${builtFiles.join(', ')}`);
  }
  const ffZipPath = path.join(RC_DIR, 'tori-companion-v1.0.10-firefox.zip');
  fs.copyFileSync(path.join(ffArtifactsDir, builtFiles[0]), ffZipPath);

  const ffInspect = inspectZip(ffZipPath);
  if (ffInspect.bad !== null || ffInspect.backslashes.length > 0 || ffInspect.version !== '1.0.10') {
    throw new Error(`Firefox ZIP verification failed: ${JSON.stringify(ffInspect)}`);
  }
  if (!ffInspect.names.includes('shared/tokens.css') || ffInspect.names.some((n) => n.endsWith('preview.html'))) {
    throw new Error('Firefox ZIP missing shared/tokens.css or unexpectedly includes preview.html');
  }
  console.log(`[OK] Built & verified Firefox ZIP (${ffInspect.count} entries): ${ffZipPath}`);

  fs.rmSync(ffStagingDir, { recursive: true, force: true });
  fs.rmSync(ffArtifactsDir, { recursive: true, force: true });

  // 6. Write SHA256SUMS.txt & verification_metadata.json
  const chrSha = sha256File(chrZipPath);
  const ffSha = sha256File(ffZipPath);
  const sumsText = [
    `${chrSha} *tori-companion-v1.0.10-chromium.zip`,
    `${ffSha} *tori-companion-v1.0.10-firefox.zip`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(RC_DIR, 'SHA256SUMS.txt'), sumsText, 'utf8');

  const meta = {
    version: '1.0.10',
    gate: 'Gate 31.1',
    created_at: new Date().toISOString(),
    chromium: {
      zip: 'tori-companion-v1.0.10-chromium.zip',
      sha256: chrSha,
      bytes: fs.statSync(chrZipPath).size,
      entries: chrInspect.count,
      unpacked_dir: 'tori-companion-v1.0.10-chromium',
      unpacked_files: collectFiles(chrUnpackedDir).length,
    },
    firefox: {
      zip: 'tori-companion-v1.0.10-firefox.zip',
      sha256: ffSha,
      bytes: fs.statSync(ffZipPath).size,
      entries: ffInspect.count,
      gecko_id: ffManifest.browser_specific_settings?.gecko?.id || null,
      web_ext_lint: {
        errors: lintJson.summary?.errors ?? 0,
        warnings: lintJson.summary?.warnings ?? 0,
        notices: lintJson.summary?.notices ?? 0,
      },
    },
    preserved_signed_xpis: PRESERVED_XPIS.map((p) => ({
      label: p.label,
      path: path.relative(ROOT, p.file).replace(/\\/g, '/'),
      sha256: p.expectedSha256,
    })),
  };
  fs.writeFileSync(path.join(RC_DIR, 'verification_metadata.json'), JSON.stringify(meta, null, 2), 'utf8');

  console.log('[OK] Packaging v1.0.10 complete:');
  console.log(`  Chromium ZIP SHA-256: ${chrSha}`);
  console.log(`  Firefox  ZIP SHA-256: ${ffSha}`);
}

main();
