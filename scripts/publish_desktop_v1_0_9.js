#!/usr/bin/env node
/**
 * TORI Download Manager — Safe Idempotent Desktop v1.0.9 Stager & GitHub Publisher (Gate 36.2)
 *
 * SAFETY BY DEFAULT:
 * - Defaults strictly to `--dry-run`: stages all 16 verified assets locally into
 *   `release/v1.0.9-public-staging/` from the frozen `release/v1.0.9-rc/` artifacts,
 *   verifies Ed25519 signature + tamper rejection + zero secrets, performs READ-ONLY
 *   GitHub API permission and state checks, writes `github_publish_dry_run_report.json`,
 *   and performs ZERO remote GitHub writes.
 * - Live draft staging (`--stage-draft --owner-authorized`) and publication
 *   (`--publish-draft --owner-authorized`) require explicit owner authorization flags
 *   AND require the signed annotated tag `v1.0.9` to already exist remotely on the
 *   approved commit.
 * - Never modifies Desktop v1.0.8 (ID 455125259), Browser Companion v1.0.11 (ID 458864802),
 *   production External Tools manifest rev 2, or signing keys.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RC_DIR = path.join(ROOT, 'release', 'v1.0.9-rc');
const STAGING_DIR = path.join(ROOT, 'release', 'v1.0.9-public-staging');
const REPO = 'robijoychakma375-hash/tori-download-manager';
const TARGET_TAG = 'v1.0.9';
const VERSION = '1.0.9';
const RELEASE_NAME = 'TORI Download Manager v1.0.9 — Security & Reliability Update';
const DEFAULT_TAG_TARGET = 'b60770b1c5124a5a9e5b5c2b883e9a0ecd3fc308';
const UPDATER_KEY_ID = 'CDC23D8CC8DA5397';
const DEDICATED_TOOLS_KEY_ID = 'C3FD6626A3718E63';
const DEDICATED_TOOLS_KEY_FP = '6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39';

const EXPECTED_FROZEN = {
  installer: {
    name: 'TORI.Download.Manager_1.0.9_x64-setup.exe',
    bytes: 118170722,
    sha256: '460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead',
    contentType: 'application/vnd.microsoft.portable-executable',
  },
  signature: {
    name: 'TORI.Download.Manager_1.0.9_x64-setup.exe.sig',
    bytes: 436,
    sha256: '9fd6f9e8a46e93dd1e1f6212b9d174aba3cc23761c55704f2a407965cb385aa0',
    contentType: 'text/plain',
  },
  desktopExe: {
    name: 'tori-download-manager.exe',
    bytes: 32290304,
    sha256: '94995ea2eae40ec9101dd9f5f08f64ff717662143e8db936aae650f7daf17442',
    contentType: 'application/vnd.microsoft.portable-executable',
  },
  nativeHostExe: {
    name: 'tdm-native-host.exe',
    bytes: 19449344,
    sha256: '90cbb76fe03c42b03736df78262b3486068f410d604c664d5e22fd4c7247479f',
    contentType: 'application/vnd.microsoft.portable-executable',
  },
  cliExe: {
    name: 'tdm-cli.exe',
    bytes: 17102848,
    sha256: 'f25c29376e27d3a1025bbc39d09bae273c21d1fa6da4b62f44e0eea93a6ac368',
    contentType: 'application/vnd.microsoft.portable-executable',
  },
};

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex').toLowerCase();
}

function verifyTauriEd25519Sig(payloadPath, sigTextB64) {
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const pubB64 = conf.plugins.updater.pubkey.trim();
  const decPubLines = Buffer.from(pubB64, 'base64').toString('utf8').trim().split(/\r?\n/);
  const pkRaw = Buffer.from(decPubLines[1].trim(), 'base64');
  const keyId = pkRaw.subarray(2, 10);
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pkRaw.subarray(10, 42)]);
  const pubKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });

  const sigText = Buffer.from(sigTextB64.trim(), 'base64').toString('utf8').trim();
  const lines = sigText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sigRaw = Buffer.from(lines[1], 'base64');
  const alg = sigRaw.subarray(0, 2).toString('ascii');
  if (!sigRaw.subarray(2, 10).equals(keyId)) throw new Error('Signature key ID mismatch against tauri.conf.json');
  const sigBytes = sigRaw.subarray(10, 74);
  const tc = lines[2].slice('trusted comment: '.length);
  const gsig = Buffer.from(lines[3], 'base64');
  const dataBuf = fs.readFileSync(payloadPath);
  const msg = alg === 'ED' ? crypto.createHash('blake2b512').update(dataBuf).digest() : dataBuf;
  const ok1 = crypto.verify(null, msg, pubKey, sigBytes);
  const ok2 = crypto.verify(null, Buffer.concat([sigBytes, Buffer.from(tc, 'utf8')]), pubKey, gsig);
  if (!ok1 || !ok2) throw new Error(`Ed25519 signature verification failed for ${payloadPath}`);

  // Tamper negative check on flipped buffer
  const tampered = Buffer.from(dataBuf);
  tampered[Math.floor(tampered.length / 2)] ^= 0x5a;
  const tMsg = alg === 'ED' ? crypto.createHash('blake2b512').update(tampered).digest() : tampered;
  if (crypto.verify(null, tMsg, pubKey, sigBytes)) {
    throw new Error('CRITICAL: Tampered installer unexpectedly passed Ed25519 verification!');
  }
  return { ok: true, tamperRejected: true, trustedComment: tc };
}

function getGitHubToken() {
  return new Promise((resolve, reject) => {
    if (process.env.GITHUB_TOKEN) return resolve(process.env.GITHUB_TOKEN.trim());
    if (process.env.GH_TOKEN) return resolve(process.env.GH_TOKEN.trim());
    const proc = spawn('git', ['credential', 'fill']);
    proc.stdin.write('protocol=https\nhost=github.com\n\n');
    proc.stdin.end();
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', () => {
      const m = out.match(/^password=(.+)$/m);
      if (m) resolve(m[1].trim());
      else reject(new Error('No GitHub credential found'));
    });
    proc.on('error', reject);
  });
}

function requestJson(method, urlPath, token, body = null) {
  return new Promise((resolve, reject) => {
    const postData = body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const headers = {
      'User-Agent': 'TORI-Gate36-2-Desktop-Publisher',
      Accept: 'application/vnd.github+json',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (postData !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(postData);
    }
    const req = https.request({ hostname: 'api.github.com', path: urlPath, method, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let data = raw;
        try { data = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('GitHub API request timeout')));
    req.on('error', reject);
    if (postData !== null) req.write(postData);
    req.end();
  });
}

function uploadAssetViaCurl(uploadUrlTemplate, filePath, fileName, contentType, token) {
  const cleanUrl = uploadUrlTemplate.replace(/\{.*?\}$/, '') + `?name=${encodeURIComponent(fileName)}`;
  const args = [
    '-sS', '--http1.1', '-w', '\n%{http_code}', '-X', 'POST',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', `Content-Type: ${contentType}`,
    '-H', 'Expect:',
    '-T', filePath,
    cleanUrl,
  ];
  const res = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 900000 });
  if (res.error) throw res.error;
  const lines = (res.stdout || '').trim().split(/\r?\n/);
  const code = parseInt(lines[lines.length - 1], 10) || 0;
  let data = lines.slice(0, -1).join('\n');
  try { data = JSON.parse(data); } catch {}
  return { status: code, data };
}

function downloadAssetHashViaCurl(apiAssetUrl, token) {
  const tmpFile = path.join(ROOT, 'target', `gh_v109_verify_${Date.now()}_${Math.random().toString(16).slice(2)}.tmp`);
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  try {
    const res = spawnSync(
      'curl.exe',
      ['-sS', '-L', '-w', '%{http_code}', '-H', `Authorization: Bearer ${token}`, '-H', 'Accept: application/octet-stream', '-H', 'User-Agent: TORI-Gate36-2-Desktop-Publisher', '-o', tmpFile, apiAssetUrl],
      { encoding: 'utf8', timeout: 600000 }
    );
    if (res.error) throw res.error;
    const code = parseInt((res.stdout || '').trim(), 10);
    if (code !== 200 || !fs.existsSync(tmpFile)) throw new Error(`Roundtrip download failed: HTTP ${code}`);
    return { status: code, bytes: fs.statSync(tmpFile).size, sha256: sha256File(tmpFile) };
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
  }
}

function buildInstallationGuideMd() {
  return `# TORI Download Manager v1.0.9 — Installation & Upgrade Guide

## Supported Upgrade Paths

- **Clean Install:** Windows 10 / 11 (64-bit, \`x86_64\`)
- **In-Place Upgrade:** TORI Desktop \`v1.0.8\` (or \`v1.0.7\` / \`v1.0.6\`) → \`v1.0.9\`
- **Default Install Directory:** \`%LOCALAPPDATA%\\TORI Download Manager\`
- **User Data & SQLite Database:** \`%APPDATA%\\tori-download-manager\\tdm_storage.sqlite\` (preserved automatically)
- **Managed External Tools Directory:** \`%APPDATA%\\tori-download-manager\\tools\\\`
- **Browser Companion:** Fully compatible with public **Browser Companion v1.0.11** (Firefox, Chrome, Edge) without re-pairing or reinstallation.

## Interactive Installation / Upgrade Steps

1. Verify \`TORI.Download.Manager_1.0.9_x64-setup.exe\` SHA-256 against \`SHA256SUMS.txt\`:
   \`460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead\`
2. Run \`TORI.Download.Manager_1.0.9_x64-setup.exe\`.
   - Note: Windows Authenticode signing is currently \`NotSigned\`; Windows SmartScreen may display **"More info" → "Run anyway"**. In-app updates independently enforce Tauri Ed25519 cryptography (\`${UPDATER_KEY_ID}\`).
   - During upgrade, NSIS cleanly replaces binaries, preserves downloads, \`.tdm-part\` files, SQLite history, themes, and Close-to-Tray settings, and refreshes Native Messaging registration.
3. Launch **TORI Download Manager**, open **Settings → About**, and verify version **\`1.0.9\`**.
4. Open **Settings → External Tools** to confirm live production manifest revision 2 verification (\`${UPDATER_KEY_ID}\`) and Stage 1 dual-key readiness (\`${DEDICATED_TOOLS_KEY_ID}\`).

## Silent Enterprise / QA Install Syntax

\`\`\`powershell
& ".\\TORI.Download.Manager_1.0.9_x64-setup.exe" /S /D=C:\\Path\\To\\InstallDir
\`\`\`

## Rollback & Recovery

- **Desktop Rollback (\`v1.0.9 → v1.0.8\`):** Re-run \`TORI.Download.Manager_1.0.8_x64-setup.exe\` from GitHub release \`v1.0.8\`; SQLite schema remains additive and backward-compatible.
- **External Tools Rollback:** Click **Roll Back** in **Settings → External Tools** (restores paired \`FFmpeg\` + \`FFprobe\` atomically, with verified bundled fallback).
`;
}

function stageLocalPublicAssets(targetCommit) {
  // 1. Verify frozen release/v1.0.9-rc/ binaries & signature WITHOUT mutating or rebuilding them
  for (const spec of Object.values(EXPECTED_FROZEN)) {
    const src = path.join(RC_DIR, spec.name);
    if (!fs.existsSync(src)) throw new Error(`Missing frozen RC artifact: ${src}`);
    const sz = fs.statSync(src).size;
    const sha = sha256File(src);
    if (sz !== spec.bytes || sha !== spec.sha256) {
      throw new Error(`Frozen RC integrity failure on ${spec.name}: got (${sz} B, ${sha}), expected (${spec.bytes} B, ${spec.sha256})`);
    }
  }

  const sigContent = fs.readFileSync(path.join(RC_DIR, EXPECTED_FROZEN.signature.name), 'utf8').trim();
  const sigAudit = verifyTauriEd25519Sig(path.join(RC_DIR, EXPECTED_FROZEN.installer.name), sigContent);

  fs.mkdirSync(STAGING_DIR, { recursive: true });
  // Copy frozen 5 binary/sig files byte-identically
  for (const spec of Object.values(EXPECTED_FROZEN)) {
    fs.copyFileSync(path.join(RC_DIR, spec.name), path.join(STAGING_DIR, spec.name));
  }

  // Copy 5 license files matching exact v1.0.8 public release inventory
  const licenses = [
    [path.join(ROOT, 'LICENSE'), 'LICENSE', 'text/plain'],
    [path.join(ROOT, 'LICENSE-MIT'), 'LICENSE-MIT', 'text/plain'],
    [path.join(ROOT, 'LICENSE-APACHE'), 'LICENSE-APACHE', 'text/plain'],
    [path.join(ROOT, 'resources', 'LICENSE-GPLv3.txt'), 'LICENSE-GPLv3.txt', 'text/plain'],
    [path.join(ROOT, 'resources', 'LICENSE-THIRD-PARTY.txt'), 'LICENSE-THIRD-PARTY.txt', 'text/plain'],
  ];
  for (const [src, dst] of licenses) {
    if (!fs.existsSync(src)) throw new Error(`Missing license file: ${src}`);
    fs.copyFileSync(src, path.join(STAGING_DIR, dst));
  }

  // Copy verified public stable release notes & generate installation guide
  const notesSrc = path.join(ROOT, 'docs', 'release', 'GATE36_3_DESKTOP_V109_PUBLIC_RELEASE_NOTES.md');
  fs.copyFileSync(notesSrc, path.join(STAGING_DIR, 'RELEASE_NOTES_v1.0.9.md'));
  fs.writeFileSync(path.join(STAGING_DIR, 'INSTALLATION_AND_UPGRADE.md'), buildInstallationGuideMd(), 'utf8');

  // Convert draft_latest.json -> final public latest.json (UTF-8 no-BOM, verified parity, zero draft markers)
  const draftLatest = JSON.parse(fs.readFileSync(path.join(RC_DIR, 'draft_latest.json'), 'utf8'));
  const proposedLatest = {
    version: VERSION,
    notes:
      'TORI Download Manager v1.0.9 — Security & Reliability Update: strict HTTP Content-Range/ETag/416 validation with safe single-stream fallback, Windows silent --minimized startup & native-host spawn mutex, Gate 35.1 security hardening, Stage 1 dual-key External Tools rev 2 compatibility, and Browser Companion v1.0.11 compatibility.',
    pub_date: draftLatest.pub_date,
    platforms: {
      'windows-x86_64': {
        signature: sigContent,
        url: `https://github.com/${REPO}/releases/download/${TARGET_TAG}/${EXPECTED_FROZEN.installer.name}`,
      },
      'windows-x86_64-nsis': {
        signature: sigContent,
        url: `https://github.com/${REPO}/releases/download/${TARGET_TAG}/${EXPECTED_FROZEN.installer.name}`,
      },
    },
  };
  fs.writeFileSync(path.join(STAGING_DIR, 'latest.json'), JSON.stringify(proposedLatest, null, 2) + '\n', 'utf8');

  const rcMeta = JSON.parse(fs.readFileSync(path.join(RC_DIR, 'BUILD_METADATA.json'), 'utf8'));
  const stagedBuildMeta = {
    ...rcMeta,
    gate: 'Gate 36.3',
    release_type: 'desktop_v109_public_stable_stage1',
    release_channel: 'PUBLIC STABLE',
    release_tag: TARGET_TAG,
    release_tag_target_commit: targetCommit,
    published: true,
    authenticode_status: 'AUTHENTICODE_NOT_SIGNED',
    clean_windows_vm_qa_status: 'CLEAN_WINDOWS_QA_NOT_TESTED',
    dedicated_tools_backup_status: 'BACKUP_RECOVERY_NOT_VERIFIED',
    owner_accepted_risks_stage1_only: {
      'RISK-36-01': 'ACCEPTED_FOR_STAGE1_DESKTOP_V109_PUBLIC_RELEASE',
      'RISK-36-02': 'ACCEPTED_FOR_STAGE1_DESKTOP_V109_PUBLIC_RELEASE',
      'RISK-36-03': 'ACCEPTED_FOR_STAGE1_DESKTOP_V109_PUBLIC_RELEASE',
    },
  };
  delete stagedBuildMeta.artifacts?.draft_latest_json;
  fs.writeFileSync(path.join(STAGING_DIR, 'BUILD_METADATA.json'), JSON.stringify(stagedBuildMeta, null, 2) + '\n', 'utf8');

  const releaseManifest = {
    schema_version: 1,
    gate: 'Gate 36.3',
    component: 'desktop',
    version: VERSION,
    release_channel: 'PUBLIC STABLE',
    release_stage: 'STAGE 1 — LEGACY PRODUCTION SIGNER + DUAL-KEY TRUST COMPATIBILITY',
    tag_name: TARGET_TAG,
    target_commit: targetCommit,
    status: 'OWNER_AUTHORIZED_PUBLIC_STABLE',
    published: true,
    make_latest: 'true',
    desktop_updater_key_id: UPDATER_KEY_ID,
    dedicated_tools_key_id: DEDICATED_TOOLS_KEY_ID,
    dedicated_tools_key_sha256: DEDICATED_TOOLS_KEY_FP,
    stage1_dual_key_active: true,
    dedicated_only_cutover: false,
    compatible_browser_companion: 'v1.0.11',
    compatible_tools_manifest_revision: 2,
    owner_accepted_risks_stage1_only: {
      'RISK-36-01': 'BACKUP_RECOVERY_NOT_VERIFIED — ACCEPTED_FOR_STAGE1_DESKTOP_V109_PUBLIC_RELEASE (Stage 2 blocked)',
      'RISK-36-02': 'CLEAN_WINDOWS_QA_NOT_TESTED — ACCEPTED_FOR_STAGE1_DESKTOP_V109_PUBLIC_RELEASE',
      'RISK-36-03': 'AUTHENTICODE_NOT_SIGNED — ACCEPTED_FOR_STAGE1_DESKTOP_V109_PUBLIC_RELEASE',
    },
  };
  fs.writeFileSync(path.join(STAGING_DIR, 'RELEASE_MANIFEST.json'), JSON.stringify(releaseManifest, null, 2) + '\n', 'utf8');

  // Generate SHA256SUMS.txt covering all primary binary/metadata/doc assets
  const sumFiles = [
    EXPECTED_FROZEN.installer.name,
    EXPECTED_FROZEN.signature.name,
    'latest.json',
    EXPECTED_FROZEN.desktopExe.name,
    EXPECTED_FROZEN.nativeHostExe.name,
    EXPECTED_FROZEN.cliExe.name,
    'BUILD_METADATA.json',
    'RELEASE_MANIFEST.json',
    'RELEASE_NOTES_v1.0.9.md',
    'INSTALLATION_AND_UPGRADE.md',
  ];
  const sumsContent = sumFiles.map((f) => `${sha256File(path.join(STAGING_DIR, f))} *${f}`).join('\n') + '\n';
  fs.writeFileSync(path.join(STAGING_DIR, 'SHA256SUMS.txt'), sumsContent, 'utf8');

  // Assemble exact 16-asset inventory matching established v1.0.8 Desktop release conventions
  const assetInventorySpec = [
    [EXPECTED_FROZEN.installer.name, EXPECTED_FROZEN.installer.contentType],
    [EXPECTED_FROZEN.signature.name, EXPECTED_FROZEN.signature.contentType],
    ['latest.json', 'application/json'],
    [EXPECTED_FROZEN.desktopExe.name, EXPECTED_FROZEN.desktopExe.contentType],
    [EXPECTED_FROZEN.nativeHostExe.name, EXPECTED_FROZEN.nativeHostExe.contentType],
    [EXPECTED_FROZEN.cliExe.name, EXPECTED_FROZEN.cliExe.contentType],
    ['SHA256SUMS.txt', 'text/plain'],
    ['RELEASE_NOTES_v1.0.9.md', 'text/markdown'],
    ['INSTALLATION_AND_UPGRADE.md', 'text/markdown'],
    ['BUILD_METADATA.json', 'application/json'],
    ['RELEASE_MANIFEST.json', 'application/json'],
    ['LICENSE', 'text/plain'],
    ['LICENSE-MIT', 'text/plain'],
    ['LICENSE-APACHE', 'text/plain'],
    ['LICENSE-GPLv3.txt', 'text/plain'],
    ['LICENSE-THIRD-PARTY.txt', 'text/plain'],
  ];

  // Confirm zero forbidden secret files in STAGING_DIR
  for (const entry of fs.readdirSync(STAGING_DIR)) {
    if (/\.(key|pwd|pfx|p12)$/i.test(entry)) {
      throw new Error(`Forbidden secret file found in staging dir: ${entry}`);
    }
  }

  const verifiedAssets = assetInventorySpec.map(([name, contentType]) => {
    const p = path.join(STAGING_DIR, name);
    return {
      name,
      path: path.relative(ROOT, p).replace(/\\/g, '/'),
      contentType,
      bytes: fs.statSync(p).size,
      sha256: sha256File(p),
    };
  });

  return { verifiedAssets, sigAudit, proposedLatest };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const targetIdx = argv.indexOf('--target-commit');
  const requestedTarget = targetIdx >= 0 && argv[targetIdx + 1] ? argv[targetIdx + 1] : DEFAULT_TAG_TARGET;
  const targetCommit = execSync(`git rev-parse "${requestedTarget}^{commit}"`, { cwd: ROOT, encoding: 'utf8' }).trim();

  const ownerAuthorized = args.has('--owner-authorized');
  const stageDraftMode = ownerAuthorized && args.has('--stage-draft');
  const publishDraftMode = ownerAuthorized && args.has('--publish-draft');
  const isDryRun = args.has('--dry-run') || (!stageDraftMode && !publishDraftMode);

  console.log(`=== TORI Desktop v1.0.9 GitHub Publisher (${isDryRun ? 'DRY-RUN — ZERO REMOTE WRITES' : stageDraftMode ? 'AUTHORIZED DRAFT STAGING' : 'AUTHORIZED PUBLISH'}) ===`);

  const { verifiedAssets, sigAudit, proposedLatest } = stageLocalPublicAssets(targetCommit);

  if (isDryRun) {
    const token = await getGitHubToken();
    const repoRes = await requestJson('GET', `/repos/${REPO}`, token);
    const latestRes = await requestJson('GET', `/repos/${REPO}/releases/latest`, token);
    const v109Res = await requestJson('GET', `/repos/${REPO}/releases/tags/${TARGET_TAG}`, token);
    const comp11Res = await requestJson('GET', `/repos/${REPO}/releases/tags/extension-v1.0.11`, token);

    const dryRunReport = {
      mode: 'DRY_RUN_NO_REMOTE_WRITES',
      generated_at: new Date().toISOString(),
      repository: REPO,
      proposed_tag: TARGET_TAG,
      proposed_tag_target_commit: targetCommit,
      planned_release: {
        tag_name: TARGET_TAG,
        name: RELEASE_NAME,
        draft: false,
        prerelease: false,
        make_latest: 'true',
      },
      cryptographic_verification: {
        updater_key_id: UPDATER_KEY_ID,
        ed25519_signature_valid: sigAudit.ok,
        tamper_rejection_verified: sigAudit.tamperRejected,
        trusted_comment: sigAudit.trustedComment,
        latest_json_version: proposedLatest.version,
        latest_json_url_matches_installer: proposedLatest.platforms['windows-x86_64'].url.endsWith(EXPECTED_FROZEN.installer.name),
      },
      asset_count: verifiedAssets.length,
      assets_to_upload: verifiedAssets,
      read_only_remote_checks: {
        github_permissions: {
          httpStatus: repoRes.status,
          push: Boolean(repoRes.data?.permissions?.push),
          admin: Boolean(repoRes.data?.permissions?.admin),
        },
        current_latest_stable: {
          httpStatus: latestRes.status,
          tag_name: latestRes.data?.tag_name,
          release_id: latestRes.data?.id,
          desktopV108Preserved: latestRes.status === 200 && latestRes.data?.tag_name === 'v1.0.8' && latestRes.data?.id === 455125259,
        },
        target_tag_v1_0_9: {
          httpStatus: v109Res.status,
          alreadyPublished: v109Res.status === 200,
        },
        public_companion_v1_0_11: {
          httpStatus: comp11Res.status,
          release_id: comp11Res.data?.id,
          intact: comp11Res.status === 200 && comp11Res.data?.id === 458864802,
        },
      },
      safety_assertions: {
        frozen_rc_untouched: true,
        exact_v108_asset_convention_matched: verifiedAssets.length === 16,
        no_secrets_in_staging: true,
        remote_writes_performed: 0,
      },
    };

    const reportPath = path.join(STAGING_DIR, 'github_publish_dry_run_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(dryRunReport, null, 2) + '\n', 'utf8');
    console.log(`[DRY-RUN OK] Staged & verified ${verifiedAssets.length} Desktop v1.0.9 assets locally with 0 remote writes.`);
    console.log(`[DRY-RUN OK] Ed25519 signature valid & tamper-rejected (${sigAudit.trustedComment})`);
    console.log(`[DRY-RUN OK] GitHub permissions: push=${dryRunReport.read_only_remote_checks.github_permissions.push}, admin=${dryRunReport.read_only_remote_checks.github_permissions.admin}`);
    console.log(`[DRY-RUN OK] Live /releases/latest: ${latestRes.data?.tag_name} (ID ${latestRes.data?.id}) | v1.0.9 published: ${dryRunReport.read_only_remote_checks.target_tag_v1_0_9.alreadyPublished} | Companion v1.0.11 intact: ${dryRunReport.read_only_remote_checks.public_companion_v1_0_11.intact}`);
    console.log(`[DRY-RUN OK] Report written to: ${reportPath}`);
    return;
  }

  // AUTHORIZED LIVE EXECUTION (STRICTLY GATED ON EXPLICIT OWNER APPROVAL)
  const token = await getGitHubToken();
  const remoteTagRef = await requestJson('GET', `/repos/${REPO}/git/ref/tags/${TARGET_TAG}`, token);
  if (remoteTagRef.status !== 200) {
    throw new Error(`Remote tag ${TARGET_TAG} does not exist yet (HTTP ${remoteTagRef.status}). Push signed/annotated tag first!`);
  }
  let remoteTagCommit = remoteTagRef.data?.object?.sha;
  if (remoteTagRef.data?.object?.type === 'tag') {
    const tagObj = await requestJson('GET', `/repos/${REPO}/git/tags/${remoteTagCommit}`, token);
    if (tagObj.status === 200 && tagObj.data?.object?.sha) remoteTagCommit = tagObj.data.object.sha;
  }
  if (remoteTagCommit !== targetCommit) {
    throw new Error(`Remote tag ${TARGET_TAG} resolves to ${remoteTagCommit}, expected approved source commit ${targetCommit}!`);
  }

  const bodyContent = fs.readFileSync(path.join(STAGING_DIR, 'RELEASE_NOTES_v1.0.9.md'), 'utf8');
  const listRes = await requestJson('GET', `/repos/${REPO}/releases?per_page=30`, token);
  const existing = Array.isArray(listRes.data) ? listRes.data.find((r) => r.tag_name === TARGET_TAG) : null;
  const evidenceDir = path.join(ROOT, 'target', 'gate36_3_evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });

  if (stageDraftMode) {
    if (existing && !existing.draft) throw new Error(`Release ${TARGET_TAG} is already published!`);
    let releaseId, uploadUrl, htmlUrl;
    if (existing) {
      releaseId = existing.id;
      uploadUrl = existing.upload_url;
      htmlUrl = existing.html_url;
    } else {
      const cr = await requestJson('POST', `/repos/${REPO}/releases`, token, {
        tag_name: TARGET_TAG, target_commitish: targetCommit, name: RELEASE_NAME, body: bodyContent, draft: true, prerelease: false, make_latest: 'false',
      });
      if (cr.status !== 201) throw new Error(`Failed creating draft release: HTTP ${cr.status} ${JSON.stringify(cr.data)}`);
      releaseId = cr.data.id;
      uploadUrl = cr.data.upload_url;
      htmlUrl = cr.data.html_url;
    }
    const curAssets = (await requestJson('GET', `/repos/${REPO}/releases/${releaseId}/assets?per_page=50`, token)).data || [];
    const uploadedReport = [];
    for (const asset of verifiedAssets) {
      const prev = curAssets.find((a) => a.name === asset.name);
      if (prev) await requestJson('DELETE', `/repos/${REPO}/releases/assets/${prev.id}`, token);
      const up = uploadAssetViaCurl(uploadUrl, path.join(STAGING_DIR, asset.name), asset.name, asset.contentType, token);
      if (up.status !== 201) throw new Error(`Upload failed for ${asset.name}: HTTP ${up.status}`);
      const dl = downloadAssetHashViaCurl(up.data.url, token);
      if (dl.bytes !== asset.bytes || dl.sha256 !== asset.sha256) {
        throw new Error(`Roundtrip mismatch for ${asset.name}: remote=(${dl.bytes}, ${dl.sha256}) local=(${asset.bytes}, ${asset.sha256})`);
      }
      console.log(`[ASSET VERIFIED] id=${up.data.id} name=${asset.name} bytes=${dl.bytes} sha256=${dl.sha256}`);
      uploadedReport.push({
        asset_id: up.data.id,
        name: asset.name,
        release_id: releaseId,
        bytes: dl.bytes,
        sha256: dl.sha256,
        browser_download_url: up.data.browser_download_url,
        roundtrip_verified: true,
      });
    }
    const draftReport = {
      generated_at_utc: new Date().toISOString(),
      repository: REPO,
      release_id: releaseId,
      tag_name: TARGET_TAG,
      target_commit: targetCommit,
      name: RELEASE_NAME,
      draft: true,
      html_url: htmlUrl,
      asset_count: uploadedReport.length,
      assets: uploadedReport,
    };
    fs.writeFileSync(path.join(evidenceDir, 'github_draft_staging_report.json'), JSON.stringify(draftReport, null, 2) + '\n', 'utf8');
    console.log(`[DRAFT STAGED & VERIFIED] ID=${releaseId} assets=${uploadedReport.length} tagCommit=${remoteTagCommit}`);
  } else if (publishDraftMode) {
    if (!existing || !existing.draft) throw new Error(`No staged draft found for ${TARGET_TAG}`);
    const curAssets = (await requestJson('GET', `/repos/${REPO}/releases/${existing.id}/assets?per_page=50`, token)).data || [];
    if (curAssets.length !== 16) throw new Error(`Draft release has ${curAssets.length} assets, expected 16!`);
    const pub = await requestJson('PATCH', `/repos/${REPO}/releases/${existing.id}`, token, {
      name: RELEASE_NAME, body: bodyContent, draft: false, prerelease: false, make_latest: 'true',
    });
    if (pub.status !== 200) throw new Error(`Publish failed: HTTP ${pub.status} ${JSON.stringify(pub.data)}`);
    const pubReport = {
      generated_at_utc: new Date().toISOString(),
      id: pub.data.id,
      tag_name: pub.data.tag_name,
      target_commitish: pub.data.target_commitish,
      name: pub.data.name,
      draft: pub.data.draft,
      prerelease: pub.data.prerelease,
      published_at: pub.data.published_at,
      html_url: pub.data.html_url,
      asset_count: (pub.data.assets || []).length,
    };
    fs.writeFileSync(path.join(evidenceDir, 'github_publish_report.json'), JSON.stringify(pubReport, null, 2) + '\n', 'utf8');
    console.log(`[PUBLISHED OK] ID=${pub.data.id} PUBLISHED_AT=${pub.data.published_at} URL=${pub.data.html_url}`);
  }
}

main().catch((err) => {
  console.error('[ERROR]', err.message || err);
  process.exit(1);
});
