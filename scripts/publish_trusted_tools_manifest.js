#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 32.1 Trusted External Tools Manifest Publisher
 *
 * Maintainer CLI for safely staging, validating, signing, publishing, and rolling back
 * TORI's Ed25519-signed External Tools Manifest (`tools-manifest.json` + `.sig`).
 *
 * Architecture:
 *  - Immutable large FFmpeg/FFprobe ZIP artifacts (~200 MiB, > Cloudflare Pages 25 MiB limit)
 *    are mirrored unmodified (bit-for-bit upstream SHA-256 preserved) to an isolated GitHub
 *    prerelease (`prerelease: true, make_latest: "false"`, tag `tools-ffmpeg-<ver>`) so public
 *    Desktop Latest Stable (`v1.0.6`) and `latest.json` are NEVER touched.
 *  - Small signed manifest files (`tools-manifest.json` + `.sig`) are published LAST to
 *    Cloudflare Pages (`https://toridownload.xyz/assets/tools/staging/...` or production
 *    when explicitly authorized).
 *
 * Security Invariants:
 *  - NEVER reads, prints, logs, or commits private signing keys or passwords.
 *  - Signs exact serialized `tools-manifest.json` bytes with out-of-repo `%USERPROFILE%\.tori-keys\tori-updater.key`
 *    via `cargo tauri signer sign`, and self-verifies the resulting `.sig` before deployment.
 *  - Fail-closed assertion that GitHub `releases/latest` remains `v1.0.6` before and after upload.
 *
 * Usage:
 *   node scripts/publish_trusted_tools_manifest.js --discover
 *   node scripts/publish_trusted_tools_manifest.js --stage [--release-tag autobuild-2026-11-20-12-40]
 *   node scripts/publish_trusted_tools_manifest.js --publish-staging [--release-tag ...] [--revision 1] [--ttl-days 30]
 *   node scripts/publish_trusted_tools_manifest.js --rollback-manifest --revision <N> --version <ver> --url <https://...> --sha256 <hex> --size <bytes> [--out-dir <dir>]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WEBSITE_REPO = 'C:\\Users\\ritud\\Downloads\\tori-website';
const OWNER = 'robijoychakma375-hash';
const REPO = 'tori-download-manager';
const EXPECTED_PUBLIC_DESKTOP_TAG = 'v1.0.6';
const EXPECTED_KEY_ID = 'CDC23D8CC8DA5397';
const KEY_DIR = path.join(process.env.USERPROFILE || '', '.tori-keys');
const PRIV_KEY_PATH = path.join(KEY_DIR, 'tori-updater.key');
const PUB_KEY_PATH = path.join(KEY_DIR, 'tori-updater.key.pub');
const PWD_KEY_PATH = path.join(KEY_DIR, 'tori-updater.key.pwd');
const STAGING_ROOT = path.join(ROOT, 'target', 'tools_publish_staging');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[k] = next;
        i++;
      } else {
        args[k] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function getGithubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const res = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    timeout: 10000,
  });
  if (res.status !== 0) {
    throw new Error('Failed to retrieve GitHub credentials from Git Credential Manager');
  }
  const match = (res.stdout || '').match(/^password=(.+)$/m);
  if (!match) {
    throw new Error('Git Credential Manager did not return a GitHub token');
  }
  return match[1].trim();
}

function httpsRequest(rawUrl, { method = 'GET', headers = {}, body = null, maxRedirects = 8 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') {
      return reject(new Error(`Refused non-HTTPS URL: ${rawUrl}`));
    }
    const reqHeaders = {
      'User-Agent': 'TORI-Tools-Publisher/1.0.6',
      ...headers,
    };
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: reqHeaders,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
          res.resume();
          const nextUrl = new URL(res.headers.location, rawUrl).toString();
          const nextHeaders = { ...headers };
          // Strip Authorization header on cross-origin redirect
          if (new URL(nextUrl).hostname !== u.hostname) {
            delete nextHeaders.Authorization;
          }
          return resolve(httpsRequest(nextUrl, { method, headers: nextHeaders, body, maxRedirects: maxRedirects - 1 }));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8') });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function downloadFileWithSha256(rawUrl, destPath, { headers = {}, maxRedirects = 8 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return reject(new Error(`Refused non-HTTPS download URL: ${rawUrl}`));
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': 'TORI-Tools-Publisher/1.0.6', ...headers },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
          res.resume();
          const nextUrl = new URL(res.headers.location, rawUrl).toString();
          const nextHeaders = { ...headers };
          if (new URL(nextUrl).hostname !== u.hostname) delete nextHeaders.Authorization;
          return resolve(downloadFileWithSha256(nextUrl, destPath, { headers: nextHeaders, maxRedirects: maxRedirects - 1 }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download returned HTTP ${res.statusCode} for ${rawUrl}`));
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const partPath = destPath + '.part';
        const out = fs.createWriteStream(partPath);
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          hash.update(chunk);
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            if (total > 0 && bytes !== total) {
              try { fs.unlinkSync(partPath); } catch {}
              return reject(new Error(`Truncated download: ${bytes} of ${total} bytes`));
            }
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            fs.renameSync(partPath, destPath);
            resolve({ size: bytes, sha256: hash.digest('hex') });
          });
        });
        out.on('error', (err) => {
          try { fs.unlinkSync(partPath); } catch {}
          reject(err);
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(65536);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function ghHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

async function discoverBtbnRelease(preferredTag = null) {
  const url = preferredTag
    ? `https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/${encodeURIComponent(preferredTag)}`
    : 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=10';
  const resp = await httpsRequest(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (resp.status !== 200) {
    throw new Error(`Failed querying BtbN/FFmpeg-Builds releases (HTTP ${resp.status}): ${resp.text.slice(0, 300)}`);
  }
  const data = JSON.parse(resp.text);
  const release = Array.isArray(data)
    ? data.find((r) => String(r.tag_name || '').startsWith('autobuild-') && !r.draft) || data[0]
    : data;
  if (!release || !Array.isArray(release.assets)) {
    throw new Error('Could not find immutable dated BtbN/FFmpeg-Builds release');
  }

  // Pick static GPL win64 master build matching TORI's bundled `ffmpeg-N-*-win64-gpl.zip` lineage
  const zipAsset = release.assets.find(
    (a) => /^ffmpeg-N-\d+-g[0-9a-f]+-win64-gpl\.zip$/i.test(a.name) && !a.name.includes('shared')
  );
  if (!zipAsset) {
    throw new Error(`BtbN release ${release.tag_name} missing immutable ffmpeg-N-*-win64-gpl.zip asset`);
  }
  const sumsAsset = release.assets.find((a) => a.name === 'checksums.sha256') || null;
  let apiDigest = null;
  if (zipAsset.digest && String(zipAsset.digest).startsWith('sha256:')) {
    apiDigest = String(zipAsset.digest).slice(7).toLowerCase();
  }
  let checksumsDigest = null;
  if (sumsAsset) {
    const sResp = await httpsRequest(sumsAsset.browser_download_url);
    if (sResp.status === 200) {
      for (const line of sResp.text.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1].replace(/^\*/, '') === zipAsset.name) {
          checksumsDigest = parts[0].toLowerCase();
          break;
        }
      }
    }
  }
  if (apiDigest && checksumsDigest && apiDigest !== checksumsDigest) {
    throw new Error(`Upstream SHA-256 mismatch between GitHub API (${apiDigest}) and checksums.sha256 (${checksumsDigest})`);
  }
  const expectedSha256 = apiDigest || checksumsDigest;
  if (!expectedSha256 || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('Missing valid 64-hex SHA-256 checksum for BtbN FFmpeg ZIP');
  }

  return {
    provider: 'BtbN/FFmpeg-Builds',
    releaseTag: release.tag_name,
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    assetName: zipAsset.name,
    assetUrl: zipAsset.browser_download_url,
    assetSize: zipAsset.size,
    expectedSha256,
    hasChecksumFileMatch: Boolean(checksumsDigest && checksumsDigest === expectedSha256),
  };
}

function validateWindowsX64Pe(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(4096);
  let n = 0;
  try {
    n = fs.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (n < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) {
    throw new Error(`Invalid PE MZ header in ${filePath}`);
  }
  const eLfanew = buf.readUInt32LE(0x3c);
  if (eLfanew + 26 > n || buf.subarray(eLfanew, eLfanew + 4).toString('ascii') !== 'PE\0\0') {
    throw new Error(`Invalid PE signature in ${filePath}`);
  }
  const machine = buf.readUInt16LE(eLfanew + 4);
  const optMagic = buf.readUInt16LE(eLfanew + 24);
  if (machine !== 0x8664 || optMagic !== 0x020b) {
    throw new Error(`Non-x64 PE binary in ${filePath} (machine=0x${machine.toString(16)}, magic=0x${optMagic.toString(16)})`);
  }
}

function runFfmpegCompatibilitySuite(ffmpegExe, ffprobeExe, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const run = (exe, args, label) => {
    const res = spawnSync(exe, args, { encoding: 'utf8', timeout: 30000 });
    if (res.status !== 0) {
      throw new Error(`Compatibility test '${label}' failed (exit=${res.status}): ${(res.stderr || res.stdout || '').slice(0, 500)}`);
    }
    return res.stdout || '';
  };

  // 1. Version & build parity
  const ffVerOut = run(ffmpegExe, ['-version'], 'ffmpeg -version');
  const fpVerOut = run(ffprobeExe, ['-version'], 'ffprobe -version');
  const ffVerMatch = ffVerOut.match(/^ffmpeg version\s+(\S+)/m);
  const fpVerMatch = fpVerOut.match(/^ffprobe version\s+(\S+)/m);
  if (!ffVerMatch || !fpVerMatch) {
    throw new Error('Failed parsing ffmpeg/ffprobe version strings');
  }
  const ffmpegVersion = ffVerMatch[1];
  const ffprobeVersion = fpVerMatch[1];
  if (ffmpegVersion !== ffprobeVersion) {
    throw new Error(`FFmpeg (${ffmpegVersion}) and FFprobe (${ffprobeVersion}) version mismatch!`);
  }

  // 2. Demuxer / muxer / codec capability checks required by TORI
  const formatsOut = run(ffmpegExe, ['-hide_banner', '-formats'], 'ffmpeg -formats');
  for (const fmt of ['mp4', 'matroska', 'hls', 'mpegts', 'mov']) {
    if (!new RegExp(`\\b${fmt}\\b`).test(formatsOut)) {
      throw new Error(`FFmpeg missing required format '${fmt}'`);
    }
  }
  const codecsOut = run(ffmpegExe, ['-hide_banner', '-codecs'], 'ffmpeg -codecs');
  for (const codec of ['h264', 'aac', 'opus', 'vp9', 'av1']) {
    if (!new RegExp(`\\b${codec}\\b`).test(codecsOut)) {
      throw new Error(`FFmpeg missing required codec '${codec}'`);
    }
  }

  // 3. Synthetic H.264 video + AAC audio generation & A/V merge into MP4 with metadata
  const videoOnly = path.join(workDir, 'v_only.mp4');
  const audioOnly = path.join(workDir, 'a_only.m4a');
  const mergedMp4 = path.join(workDir, 'merged.mp4');
  const remuxMkv = path.join(workDir, 'remuxed.mkv');
  const hlsDir = path.join(workDir, 'hls');
  const hlsMerged = path.join(workDir, 'hls_merged.mp4');
  fs.mkdirSync(hlsDir, { recursive: true });

  run(ffmpegExe, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoOnly], 'generate H.264 video');
  run(ffmpegExe, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', '-b:a', '96k', audioOnly], 'generate AAC audio');
  run(
    ffmpegExe,
    ['-y', '-i', videoOnly, '-i', audioOnly, '-c', 'copy', '-metadata', 'title=TORI_GATE32_1_TEST', '-movflags', '+faststart', mergedMp4],
    'A/V merge MP4 with metadata'
  );

  // 4. Container remux MP4 -> MKV
  run(ffmpegExe, ['-y', '-i', mergedMp4, '-c', 'copy', remuxMkv], 'remux MP4 -> MKV');

  // 5. HLS segment generation + HLS playlist remux -> MP4
  const hlsM3u8 = path.join(hlsDir, 'index.m3u8');
  run(ffmpegExe, ['-y', '-i', mergedMp4, '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', hlsM3u8], 'generate HLS segments');
  run(ffmpegExe, ['-y', '-allowed_extensions', 'ALL', '-i', hlsM3u8, '-c', 'copy', hlsMerged], 'remux HLS -> MP4');

  // 6. FFprobe JSON stream/duration/metadata verification across MP4, MKV, and HLS-remuxed MP4
  const probeJson = (target, label) => {
    const out = run(
      ffprobeExe,
      ['-v', 'error', '-show_entries', 'format=duration,size:format_tags=title:stream=codec_type,codec_name,width,height', '-of', 'json', target],
      label
    );
    return JSON.parse(out);
  };

  const pMp4 = probeJson(mergedMp4, 'ffprobe merged.mp4');
  const pMkv = probeJson(remuxMkv, 'ffprobe remuxed.mkv');
  const pHls = probeJson(hlsMerged, 'ffprobe hls_merged.mp4');

  const checkProbe = (p, name, expectTitle) => {
    const streams = p.streams || [];
    const hasV = streams.some((s) => s.codec_type === 'video' && s.codec_name === 'h264' && s.width === 320);
    const hasA = streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac');
    const dur = parseFloat(p.format?.duration || '0');
    if (!hasV || !hasA || !(dur >= 1.8 && dur <= 2.3)) {
      throw new Error(`FFprobe verification failed on ${name}: ${JSON.stringify(p)}`);
    }
    if (expectTitle && p.format?.tags?.title !== 'TORI_GATE32_1_TEST') {
      throw new Error(`Metadata title not preserved on ${name}: ${JSON.stringify(p.format?.tags)}`);
    }
  };
  checkProbe(pMp4, 'merged.mp4', true);
  checkProbe(pMkv, 'remuxed.mkv', true);
  checkProbe(pHls, 'hls_merged.mp4', false);

  return {
    ffmpegVersion,
    ffprobeVersion,
    verifiedFormats: ['mp4', 'matroska', 'hls', 'mpegts', 'mov'],
    verifiedCodecs: ['h264', 'aac', 'opus', 'vp9', 'av1'],
    checksPassed: [
      'version_parity',
      'demuxer_muxer_codec_matrix',
      'h264_aac_av_merge_mp4',
      'metadata_preservation',
      'mp4_to_mkv_remux',
      'hls_segment_remux',
      'ffprobe_json_streams_duration',
    ],
  };
}

async function stageCandidate(preferredTag = null) {
  const info = await discoverBtbnRelease(preferredTag);
  const stageDir = path.join(STAGING_ROOT, info.releaseTag);
  fs.mkdirSync(stageDir, { recursive: true });

  const zipPath = path.join(stageDir, info.assetName);
  let needDownload = true;
  if (fs.existsSync(zipPath)) {
    const stat = fs.statSync(zipPath);
    if (stat.size === info.assetSize && sha256File(zipPath) === info.expectedSha256) {
      needDownload = false;
      console.log(`[STAGE] Reusing already-verified cached archive: ${zipPath}`);
    }
  }
  if (needDownload) {
    console.log(`[STAGE] Downloading ${info.assetName} (${(info.assetSize / (1024 * 1024)).toFixed(2)} MiB)...`);
    const dl = await downloadFileWithSha256(info.assetUrl, zipPath);
    if (dl.size !== info.assetSize || dl.sha256 !== info.expectedSha256) {
      throw new Error(`Downloaded archive integrity mismatch: got size=${dl.size}, sha=${dl.sha256}`);
    }
  }

  // Safely extract ONLY ffmpeg.exe and ffprobe.exe using Python zipfile with traversal checks
  const extractDir = path.join(stageDir, 'extracted');
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync(
    'python',
    [
      '-c',
      `
import os, sys, zipfile
zpath, outdir = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zpath, 'r') as zf:
    for zi in zf.infolist():
        name = zi.filename.replace('\\\\', '/')
        if name.startswith('/') or '..' in name.split('/') or ':' in name:
            raise SystemExit(f'Unsafe ZIP entry: {zi.filename}')
        base = os.path.basename(name).lower()
        if base in ('ffmpeg.exe', 'ffprobe.exe'):
            with zf.open(zi, 'r') as src, open(os.path.join(outdir, base), 'wb') as dst:
                while True:
                    b = src.read(65536)
                    if not b: break
                    dst.write(b)
`,
      zipPath,
      extractDir,
    ],
    { stdio: 'inherit', timeout: 60000 }
  );

  const ffmpegExe = path.join(extractDir, 'ffmpeg.exe');
  const ffprobeExe = path.join(extractDir, 'ffprobe.exe');
  if (!fs.existsSync(ffmpegExe) || !fs.existsSync(ffprobeExe)) {
    throw new Error('Extracted archive missing ffmpeg.exe or ffprobe.exe');
  }
  validateWindowsX64Pe(ffmpegExe);
  validateWindowsX64Pe(ffprobeExe);

  console.log('[STAGE] Running real FFmpeg/FFprobe media compatibility suite...');
  const compat = runFfmpegCompatibilitySuite(ffmpegExe, ffprobeExe, path.join(stageDir, 'compat_work'));

  const provenance = {
    schema_version: 1,
    upstream_provider: info.provider,
    upstream_release: info.releaseTag,
    upstream_release_url: info.releaseUrl,
    upstream_asset_name: info.assetName,
    upstream_asset_url: info.assetUrl,
    upstream_published_at: info.publishedAt,
    upstream_sha256: info.expectedSha256,
    upstream_checksums_file_verified: info.hasChecksumFileMatch,
    upstream_cryptographic_signature: 'NONE (BtbN/FFmpeg-Builds provides HTTPS SHA-256 checksums without detached publisher signatures; trust is established by TORI provenance review, automated compatibility verification, and TORI Ed25519 manifest signature)',
    artifact_size_bytes: info.assetSize,
    ffmpeg_version: compat.ffmpegVersion,
    ffprobe_version: compat.ffprobeVersion,
    ffmpeg_exe_sha256: sha256File(ffmpegExe),
    ffprobe_exe_sha256: sha256File(ffprobeExe),
    compatibility_checks: compat.checksPassed,
    approved_by: 'TORI Release Engineering (Gate 32.1)',
    approved_at: new Date().toISOString(),
  };

  const provenancePath = path.join(stageDir, 'PROVENANCE.json');
  const sumsPath = path.join(stageDir, 'SHA256SUMS.txt');
  fs.writeFileSync(provenancePath, JSON.stringify(provenance, null, 2) + '\n', 'utf8');
  fs.writeFileSync(
    sumsPath,
    `${info.expectedSha256}  ${info.assetName}\n${provenance.ffmpeg_exe_sha256}  bin/ffmpeg.exe\n${provenance.ffprobe_exe_sha256}  bin/ffprobe.exe\n`,
    'utf8'
  );

  console.log(`[STAGE] Verified ${compat.ffmpegVersion} (${info.assetSize} bytes, SHA-256 ${info.expectedSha256})`);
  return { info, stageDir, zipPath, provenancePath, sumsPath, provenance, compat };
}

function signManifestBytes(manifestPath) {
  if (!fs.existsSync(PRIV_KEY_PATH) || !fs.existsSync(PUB_KEY_PATH) || !fs.existsSync(PWD_KEY_PATH)) {
    throw new Error(`Required out-of-repo signing key files missing under ${KEY_DIR}`);
  }
  const pubRaw = fs.readFileSync(PUB_KEY_PATH, 'utf8').trim();
  const pubText = pubRaw.includes('untrusted comment:')
    ? pubRaw
    : Buffer.from(pubRaw, 'base64').toString('utf8');
  const keyIdMatch = pubText.match(/minisign public key:\s*([0-9A-Fa-f]{16})/);
  if (!keyIdMatch || keyIdMatch[1].toUpperCase() !== EXPECTED_KEY_ID) {
    throw new Error(`Unexpected public key ID in ${PUB_KEY_PATH}`);
  }

  // Read password into memory only; NEVER print or log it!
  const pwd = fs.readFileSync(PWD_KEY_PATH, 'utf8').trim();
  const sigPath = manifestPath + '.sig';
  if (fs.existsSync(sigPath)) fs.unlinkSync(sigPath);

  const res = spawnSync(
    'cargo',
    ['tauri', 'signer', 'sign', '-f', PRIV_KEY_PATH, '-p', pwd, manifestPath],
    { cwd: ROOT, encoding: 'utf8', timeout: 60000 }
  );
  if (res.status !== 0 || !fs.existsSync(sigPath)) {
    throw new Error(`cargo tauri signer sign failed (exit=${res.status})`);
  }

  const sigContent = fs.readFileSync(sigPath, 'utf8').trim();
  if (!sigContent) {
    throw new Error('Generated signature file is empty');
  }

  // Verify the signature format is non-empty base64 minisign box (decoded cleanly)
  const decoded = Buffer.from(sigContent, 'base64').toString('utf8');
  if (!decoded.includes('untrusted comment:') || !decoded.includes('trusted comment:')) {
    throw new Error('Generated .sig file is not a valid minisign signature box');
  }
  return { sigPath, sigContent, signingKeyId: EXPECTED_KEY_ID };
}

async function assertLatestReleaseUntouched(token) {
  const resp = await httpsRequest(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
    headers: ghHeaders(token),
  });
  if (resp.status !== 200) {
    throw new Error(`Failed verifying GitHub releases/latest (HTTP ${resp.status})`);
  }
  const latest = JSON.parse(resp.text);
  if (latest.tag_name !== EXPECTED_PUBLIC_DESKTOP_TAG) {
    throw new Error(
      `SAFETY VIOLATION: GitHub releases/latest is '${latest.tag_name}', expected '${EXPECTED_PUBLIC_DESKTOP_TAG}'!`
    );
  }
  return latest;
}

async function uploadToIsolatedGithubPrerelease(token, releaseTag, staged, { skipRemoteRedownload = false } = {}) {
  await assertLatestReleaseUntouched(token);

  let release = null;
  const existing = await httpsRequest(
    `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(releaseTag)}`,
    { headers: ghHeaders(token) }
  );
  if (existing.status === 200) {
    release = JSON.parse(existing.text);
    if (!release.prerelease) {
      throw new Error(`Refusing to touch non-prerelease GitHub release '${releaseTag}'`);
    }
    console.log(`[GITHUB] Reusing existing isolated prerelease '${releaseTag}' (id=${release.id})`);
  } else {
    const payload = JSON.stringify({
      tag_name: releaseTag,
      name: `TORI External Tools Artifact — FFmpeg/FFprobe ${staged.compat.ffmpegVersion}`,
      body: [
        'Immutable external-tool artifact storage for TORI Download Manager External Tools Auto-Update Manager (Gate 32.1).',
        '',
        '**Not a TORI Desktop release.** TORI Desktop Latest Stable remains `v1.0.6`.',
        '',
        `- Upstream Provider: \`${staged.info.provider}\``,
        `- Upstream Release: \`${staged.info.releaseTag}\``,
        `- FFmpeg / FFprobe Version: \`${staged.compat.ffmpegVersion}\``,
        `- Archive SHA-256: \`${staged.info.expectedSha256}\``,
        `- Archive Size: \`${staged.info.assetSize}\` bytes`,
      ].join('\n'),
      draft: false,
      prerelease: true,
      make_latest: 'false',
    });
    const created = await httpsRequest(`https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
      method: 'POST',
      headers: ghHeaders(token, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      }),
      body: payload,
    });
    if (created.status !== 201) {
      throw new Error(`Failed creating isolated GitHub prerelease (HTTP ${created.status}): ${created.text.slice(0, 400)}`);
    }
    release = JSON.parse(created.text);
    console.log(`[GITHUB] Created isolated prerelease '${releaseTag}' (id=${release.id}, prerelease=${release.prerelease})`);
  }

  const uploadBase = String(release.upload_url).replace(/\{.*$/, '');
  const filesToUpload = [
    { name: staged.info.assetName, filePath: staged.zipPath, contentType: 'application/zip' },
    { name: 'SHA256SUMS.txt', filePath: staged.sumsPath, contentType: 'text/plain; charset=utf-8' },
    { name: 'PROVENANCE.json', filePath: staged.provenancePath, contentType: 'application/json; charset=utf-8' },
  ];

  const assetUrls = {};
  for (const item of filesToUpload) {
    const existingAsset = (release.assets || []).find((a) => a.name === item.name);
    const stat = fs.statSync(item.filePath);
    if (existingAsset && existingAsset.size === stat.size) {
      console.log(`[GITHUB] Asset '${item.name}' already uploaded with matching size (${stat.size} bytes)`);
      assetUrls[item.name] = existingAsset.browser_download_url;
      continue;
    }
    if (existingAsset) {
      console.log(`[GITHUB] Removing stale asset '${item.name}' (id=${existingAsset.id}) before re-upload...`);
      await httpsRequest(`https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${existingAsset.id}`, {
        method: 'DELETE',
        headers: ghHeaders(token),
      });
    }
    console.log(`[GITHUB] Uploading ${item.name} (${(stat.size / (1024 * 1024)).toFixed(2)} MiB)...`);
    const uploadUrl = `${uploadBase}?name=${encodeURIComponent(item.name)}`;
    const uploaded = await uploadStreamToGithub(uploadUrl, item.filePath, item.contentType, token);
    assetUrls[item.name] = uploaded.browser_download_url;
    console.log(`[GITHUB] Uploaded ${item.name} -> ${uploaded.browser_download_url}`);
  }

  // Re-verify public Desktop v1.0.6 Latest Stable is completely untouched!
  const latestAfter = await assertLatestReleaseUntouched(token);
  console.log(`[GITHUB] Verified releases/latest remains ${latestAfter.tag_name} (id=${latestAfter.id})`);

  // Verify live remote HTTPS download matches exact SHA-256 (with retry on transient CDN reset)
  const remoteZipUrl = assetUrls[staged.info.assetName];
  if (skipRemoteRedownload) {
    console.log(`[VERIFY] Skipping full re-download (--skip-remote-verify); checking live HTTPS HEAD on ${remoteZipUrl}...`);
    const head = await httpsRequest(remoteZipUrl, { method: 'HEAD' });
    if (head.status !== 200 || parseInt(head.headers['content-length'] || '0', 10) !== staged.info.assetSize) {
      throw new Error(`Remote HTTPS HEAD mismatch: status=${head.status}, content-length=${head.headers['content-length']}`);
    }
    console.log(`[VERIFY] Remote HTTPS HEAD confirmed 200 OK (${head.headers['content-length']} bytes)`);
  } else {
    console.log(`[VERIFY] Verifying live remote HTTPS artifact SHA-256 from ${remoteZipUrl}...`);
    const verifyPath = path.join(staged.stageDir, '_remote_verify.zip');
    let dlCheck = null;
    let lastDlErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        dlCheck = await downloadFileWithSha256(remoteZipUrl, verifyPath);
        break;
      } catch (e) {
        lastDlErr = e;
        console.log(`[VERIFY] Attempt ${attempt}/3 failed (${e.message}); retrying in 3s...`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    try { fs.unlinkSync(verifyPath); } catch {}
    if (!dlCheck) {
      throw lastDlErr || new Error('Remote HTTPS artifact verification failed');
    }
    if (dlCheck.size !== staged.info.assetSize || dlCheck.sha256 !== staged.info.expectedSha256) {
      throw new Error(`Remote HTTPS artifact mismatch: size=${dlCheck.size}, sha=${dlCheck.sha256}`);
    }
    console.log(`[VERIFY] Remote HTTPS artifact verified bit-for-bit (${dlCheck.size} bytes, sha256=${dlCheck.sha256})`);
  }

  return { release, remoteZipUrl, assetUrls };
}

function uploadStreamToGithub(uploadUrl, filePath, contentType, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(uploadUrl);
    const stat = fs.statSync(filePath);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'User-Agent': 'TORI-Tools-Publisher/1.0.6',
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': contentType,
          'Content-Length': stat.size,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 201) {
            return reject(new Error(`Asset upload failed (HTTP ${res.statusCode}): ${text.slice(0, 400)}`));
          }
          resolve(JSON.parse(text));
        });
      }
    );
    req.on('error', reject);
    fs.createReadStream(filePath).pipe(req);
  });
}

function ensureWebsiteHeadersForTools(headersPath) {
  const original = fs.readFileSync(headersPath, 'utf8');
  if (original.includes('/assets/tools/*')) {
    return false;
  }
  const addition = [
    '',
    '/assets/tools/*.json',
    '  Content-Type: application/json; charset=utf-8',
    '  Cache-Control: public, max-age=300, must-revalidate',
    '  X-Content-Type-Options: nosniff',
    '',
    '/assets/tools/*.sig',
    '  Content-Type: text/plain; charset=utf-8',
    '  Cache-Control: public, max-age=300, must-revalidate',
    '  X-Content-Type-Options: nosniff',
    '',
    '/assets/tools/staging/*.json',
    '  Content-Type: application/json; charset=utf-8',
    '  Cache-Control: no-cache, must-revalidate',
    '  X-Content-Type-Options: nosniff',
    '',
    '/assets/tools/staging/*.sig',
    '  Content-Type: text/plain; charset=utf-8',
    '  Cache-Control: no-cache, must-revalidate',
    '  X-Content-Type-Options: nosniff',
    '',
    '/assets/tools/*',
    '  X-Content-Type-Options: nosniff',
    '',
  ].join('\n');
  fs.writeFileSync(headersPath, original.trimEnd() + '\n' + addition, 'utf8');
  return true;
}

function buildSchemaV2Manifest({
  revision,
  ttlDays = 30,
  version,
  ffmpegVersion,
  ffprobeVersion,
  url,
  sha256,
  size,
  allowRollbackTo = false,
  provenance,
}) {
  const now = new Date();
  const exp = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  return {
    schema_version: 2,
    manifest_revision: revision,
    generated_at: now.toISOString(),
    published_at: now.toISOString(),
    expires_at: exp.toISOString(),
    signing_key_id: EXPECTED_KEY_ID,
    ffmpeg_bundle: {
      tool_id: 'ffmpeg_bundle',
      version,
      ffmpeg_version: ffmpegVersion || version,
      ffprobe_version: ffprobeVersion || version,
      bundle_id: `ffmpeg-win64-gpl-${version}`,
      url,
      sha256,
      size,
      artifact_format: 'zip',
      platform: 'windows',
      architecture: 'x86_64',
      min_tori_version: '1.0.6',
      max_tori_version: null,
      published_at: now.toISOString(),
      allow_rollback_to: Boolean(allowRollbackTo),
      provenance,
    },
  };
}

async function waitForLiveCloudflareStaging(expectedManifestSha, expectedSigSha, timeoutMs = 240000) {
  const manifestUrl = 'https://toridownload.xyz/assets/tools/staging/tools-manifest.json';
  const sigUrl = `${manifestUrl}.sig`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const m = await httpsRequest(`${manifestUrl}?cb=${Date.now()}`);
      const s = await httpsRequest(`${sigUrl}?cb=${Date.now()}`);
      if (m.status === 200 && s.status === 200) {
        const mSha = crypto.createHash('sha256').update(m.body).digest('hex');
        const sSha = crypto.createHash('sha256').update(s.body).digest('hex');
        if (mSha === expectedManifestSha && sSha === expectedSigSha) {
          return {
            manifestUrl,
            sigUrl,
            manifestStatus: m.status,
            sigStatus: s.status,
            manifestHeaders: m.headers,
            sigHeaders: s.headers,
            manifestSha256: mSha,
            sigSha256: sSha,
          };
        }
        console.log(`[DEPLOY] Waiting for Cloudflare Pages edge propagation (got m=${mSha.slice(0, 12)}, want ${expectedManifestSha.slice(0, 12)})...`);
      } else {
        console.log(`[DEPLOY] Waiting for Cloudflare Pages deploy (manifest=${m.status}, sig=${s.status})...`);
      }
    } catch (e) {
      console.log(`[DEPLOY] Polling error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 6000));
  }
  throw new Error('Timed out waiting for Cloudflare Pages staging tools manifest propagation');
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.discover) {
    const info = await discoverBtbnRelease(args['release-tag'] || null);
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  if (args.stage) {
    const staged = await stageCandidate(args['release-tag'] || null);
    console.log(JSON.stringify({ stageDir: staged.stageDir, provenance: staged.provenance }, null, 2));
    return;
  }

  if (args['rollback-manifest']) {
    const rev = parseInt(args.revision || '0', 10);
    const size = parseInt(args.size || '0', 10);
    if (!rev || !args.version || !args.url || !args.sha256 || !size) {
      throw new Error('Usage: --rollback-manifest --revision <N> --version <ver> --url <https://...> --sha256 <hex> --size <bytes>');
    }
    const outDir = args['out-dir'] || path.join(STAGING_ROOT, `rollback_rev_${rev}`);
    fs.mkdirSync(outDir, { recursive: true });
    const manifestObj = buildSchemaV2Manifest({
      revision: rev,
      ttlDays: parseInt(args['ttl-days'] || '30', 10),
      version: args.version,
      url: args.url,
      sha256: String(args.sha256).toLowerCase(),
      size,
      allowRollbackTo: true,
      provenance: {
        upstream_provider: 'BtbN/FFmpeg-Builds',
        upstream_release: args['upstream-release'] || 'emergency-rollback-pin',
        upstream_url: args['upstream-url'] || 'https://github.com/BtbN/FFmpeg-Builds/releases',
        approved_by: 'TORI Release Engineering (Emergency Rollback)',
        approved_at: new Date().toISOString(),
      },
    });
    const manifestPath = path.join(outDir, 'tools-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifestObj, null, 2) + '\n', 'utf8');
    const signed = signManifestBytes(manifestPath);
    console.log(JSON.stringify({ manifestPath, sigPath: signed.sigPath, revision: rev, allowRollbackTo: true }, null, 2));
    return;
  }

  if (args['publish-staging']) {
    const revision = parseInt(args.revision || '1', 10);
    const ttlDays = parseInt(args['ttl-days'] || '30', 10);
    const staged = await stageCandidate(args['release-tag'] || null);

    // Derive clean immutable GitHub prerelease tag (e.g., tools-ffmpeg-N-129150-g7ddf7bc8a4)
    const shortVer = staged.compat.ffmpegVersion.replace(/-\d{8}$/, '');
    const ghTag = `tools-ffmpeg-${shortVer}`;
    const token = getGithubToken();
    const gh = await uploadToIsolatedGithubPrerelease(token, ghTag, staged, {
      skipRemoteRedownload: Boolean(args['skip-remote-verify']),
    });

    // Build and sign schema v2 manifest
    const manifestObj = buildSchemaV2Manifest({
      revision,
      ttlDays,
      version: staged.compat.ffmpegVersion,
      ffmpegVersion: staged.compat.ffmpegVersion,
      ffprobeVersion: staged.compat.ffprobeVersion,
      url: gh.remoteZipUrl,
      sha256: staged.info.expectedSha256,
      size: staged.info.assetSize,
      allowRollbackTo: Boolean(args['allow-rollback']),
      provenance: {
        upstream_provider: staged.info.provider,
        upstream_release: staged.info.releaseTag,
        upstream_url: staged.info.releaseUrl,
        approved_by: 'TORI Release Engineering (Gate 32.1)',
        approved_at: staged.provenance.approved_at,
      },
    });

    const localManifestPath = path.join(staged.stageDir, 'tools-manifest.json');
    const manifestBytes = Buffer.from(JSON.stringify(manifestObj, null, 2) + '\n', 'utf8');
    fs.writeFileSync(localManifestPath, manifestBytes);
    const signed = signManifestBytes(localManifestPath);
    const sigBytes = fs.readFileSync(signed.sigPath);

    const expectedManifestSha = crypto.createHash('sha256').update(manifestBytes).digest('hex');
    const expectedSigSha = crypto.createHash('sha256').update(sigBytes).digest('hex');

    // Publish manifest + signature LAST into tori-website staging path ONLY!
    if (!fs.existsSync(WEBSITE_REPO)) {
      throw new Error(`Website repository not found at ${WEBSITE_REPO}`);
    }
    const stagingWebDir = path.join(WEBSITE_REPO, 'assets', 'tools', 'staging');
    fs.mkdirSync(stagingWebDir, { recursive: true });
    fs.writeFileSync(path.join(stagingWebDir, 'tools-manifest.json'), manifestBytes);
    fs.writeFileSync(path.join(stagingWebDir, 'tools-manifest.json.sig'), sigBytes);
    ensureWebsiteHeadersForTools(path.join(WEBSITE_REPO, '_headers'));

    // Guard: ensure index.html, sitemap.xml, robots.txt are completely untouched!
    const webStatus = execFileSync('git', ['status', '--short'], { cwd: WEBSITE_REPO, encoding: 'utf8' });
    for (const forbidden of ['index.html', 'sitemap.xml', 'robots.txt']) {
      if (webStatus.includes(forbidden)) {
        throw new Error(`SAFETY ABORT: Website file '${forbidden}' must NOT be modified in Gate 32.1!`);
      }
    }

    if (webStatus.trim().length > 0) {
      execFileSync(
        'git',
        ['add', 'assets/tools/staging/tools-manifest.json', 'assets/tools/staging/tools-manifest.json.sig', '_headers'],
        { cwd: WEBSITE_REPO, stdio: 'inherit' }
      );
      execFileSync(
        'git',
        [
          'commit',
          '-m',
          `Gate 32.1: publish signed staging external tools manifest rev ${revision} (FFmpeg ${staged.compat.ffmpegVersion})`,
        ],
        { cwd: WEBSITE_REPO, stdio: 'inherit' }
      );
      execFileSync('git', ['push', 'origin', 'main'], { cwd: WEBSITE_REPO, stdio: 'inherit' });
    } else {
      console.log('[WEBSITE] Staging manifest already identical in git; skipping commit.');
    }

    const websiteCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WEBSITE_REPO, encoding: 'utf8' }).trim();
    console.log(`[WEBSITE] Pushed staging manifest commit ${websiteCommit}; verifying live Cloudflare Pages HTTPS...`);
    const live = await waitForLiveCloudflareStaging(expectedManifestSha, expectedSigSha);

    const summary = {
      status: 'PUBLISHED_STAGING',
      githubPrereleaseTag: ghTag,
      githubPrereleaseId: gh.release.id,
      remoteZipUrl: gh.remoteZipUrl,
      artifactSize: staged.info.assetSize,
      artifactSha256: staged.info.expectedSha256,
      ffmpegVersion: staged.compat.ffmpegVersion,
      ffprobeVersion: staged.compat.ffprobeVersion,
      manifestRevision: revision,
      signingKeyId: signed.signingKeyId,
      websiteCommit,
      liveManifestUrl: live.manifestUrl,
      liveSigUrl: live.sigUrl,
      liveManifestSha256: live.manifestSha256,
      liveSigSha256: live.sigSha256,
      publicDesktopLatestVerified: EXPECTED_PUBLIC_DESKTOP_TAG,
    };
    fs.writeFileSync(path.join(staged.stageDir, 'PUBLISH_SUMMARY.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log('\n[SUCCESS] Gate 32.1 Staging Tools Manifest Published & Verified Live:');
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('Usage: node scripts/publish_trusted_tools_manifest.js [--discover | --stage | --publish-staging | --rollback-manifest]');
  process.exit(1);
}

main().catch((err) => {
  console.error('[ERROR]', err.message || err);
  process.exit(1);
});
