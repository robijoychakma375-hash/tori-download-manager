#!/usr/bin/env node
/**
 * Stages TORI Browser Companion v1.0.6-rc in `release/v1.0.6-rc-extension/`
 * while keeping `extension/` and `release/v1.0.5-extension/` 100% untouched.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT_SRC = path.join(ROOT, 'extension');
const STAGE_ROOT = path.join(ROOT, 'release', 'v1.0.6-rc-extension');
const CHROME_STAGE = path.join(STAGE_ROOT, 'chrome');
const FIREFOX_STAGE = path.join(STAGE_ROOT, 'firefox');

const SHARED_FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'content.css',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',
  'options/options.html',
  'options/options.css',
  'options/options.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
];

function copyFileEnsureDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function patchBackgroundJs(bgPath) {
  let code = fs.readFileSync(bgPath, 'utf8');

  const oldDecl = `const recentlyInterceptedDownloadIds = new Set();\nconst recentlyInterceptedUrls = new Map(); // url -> timestamp`;
  const newDecl = `const recentlyInterceptedDownloadIds = new Set();\nconst inFlightDownloadIds = new Set();\nconst recentlyInterceptedUrls = new Map(); // url -> timestamp`;

  if (!code.includes(oldDecl)) {
    throw new Error(`Expected declaration block not found in ${bgPath}`);
  }
  code = code.replace(oldDecl, newDecl);

  const oldHandler = `async function handleBrowserDownload(item) {
  if (!item || !item.id) return;
  if (recentlyInterceptedDownloadIds.has(item.id)) return;

  await ensureSettingsLoaded();

  // 1. Check if download capture is enabled by user
  if (extSettings.cap === false) {
    return;
  }

  // 1b. Check browser danger warnings: respect security boundaries
  if (item.danger && item.danger !== 'safe' && item.danger !== 'accepted') {
    console.debug('[TORI] Download has browser danger status:', item.danger);
    return;
  }

  const rawUrl = item.url || item.finalUrl || '';
  if (!rawUrl) return;
  const lowerUrl = rawUrl.toLowerCase();

  // 2. Ignore browser-internal schemes and inline data
  if (
    lowerUrl.startsWith('blob:') ||
    lowerUrl.startsWith('data:') ||
    lowerUrl.startsWith('about:') ||
    lowerUrl.startsWith('chrome:') ||
    lowerUrl.startsWith('edge:') ||
    lowerUrl.startsWith('moz-extension:') ||
    lowerUrl.startsWith('chrome-extension:')
  ) {
    return;
  }

  // 3. Check site exclusion list
  if (isDomainExcluded(rawUrl, item.referrer)) {
    return;
  }

  // 4. Rate-limit / loop prevention for same URL within 15 seconds
  const now = Date.now();
  if (recentlyInterceptedUrls.has(rawUrl)) {
    const lastTime = recentlyInterceptedUrls.get(rawUrl);
    if (now - lastTime < 15000) {
      return;
    }
  }

  // 5. Match file extension or MIME type against user configured types
  const userTypes = (Array.isArray(extSettings.types) ? extSettings.types : [
    'zip', 'rar', '7z', 'iso', 'exe', 'dmg', 'pdf', 'mp4', 'mp3'
  ]).map((t) => t.toLowerCase().replace(/^\\./, ''));

  const ext = extractExtensionFromDownloadItem(item);
  const baseMime = (item.mime || '').toLowerCase().split(';')[0].trim();
  const mimeExt = DOWNLOAD_MIME_MAP[baseMime] || '';

  const matched = (ext && userTypes.includes(ext)) || (mimeExt && userTypes.includes(mimeExt));
  if (!matched) {
    return;
  }

  // 6. Check minimum file size threshold (extSettings.min in MB)
  const minBytes = (parseFloat(extSettings.min) || 0) * 1024 * 1024;
  const totalBytes = item.totalBytes > 0 ? item.totalBytes : (item.fileSize > 0 ? item.fileSize : 0);
  if (minBytes > 0 && totalBytes > 0 && totalBytes < minBytes) {
    // Smaller than user threshold, leave in browser
    return;
  }

  // 7. Dispatch download to TORI Desktop Engine
  let rawFilename = item.filename ? item.filename.replace(/^.*[\\\\\\/]/, '') : '';
  if (!rawFilename) {
    rawFilename = extractFilenameFromUrl(rawUrl) || \`download.\${ext || mimeExt || 'bin'}\`;
  }

  const payload = {
    url: rawUrl,
    filename: rawFilename,
    referer: item.referrer || '',
    user_agent: navigator.userAgent,
    priority: 'normal',
  };

  try {
    const httpRes = await callDesktopApi('/api/v1/downloads', 'POST', payload, 3500);
    let handoffSuccess = false;

    if (httpRes && httpRes.ok && httpRes.data) {
      const data = httpRes.data;
      if (data.status === 'ok' && data.job_id) {
        handoffSuccess = true;
      } else if (data.status === 'already_exists' && data.job_id) {
        // Strict verification: verify existing job state can complete or has completed the download
        const validStates = ['downloading', 'queued', 'paused', 'completed', 'probing', 'scheduled'];
        if (data.state && validStates.includes(data.state.toLowerCase())) {
          handoffSuccess = true;
        } else {
          // If existing job is failed, cancelled, or unknown, do NOT cancel browser download
          handoffSuccess = false;
        }
      }
    } else if (httpRes && httpRes.status === 401) {
      // Unpaired or bad token: do NOT cancel browser download
      handoffSuccess = false;
    } else {
      // Try Native Messaging fallback
      const nmRes = await sendNativeMessage({
        action: 'start_download',
        ...payload,
      }).catch(() => null);

      if (nmRes && nmRes.status === 'ok' && nmRes.job_id) {
        handoffSuccess = true;
      } else if (nmRes && nmRes.status === 'already_exists' && nmRes.job_id) {
        const validStates = ['downloading', 'queued', 'paused', 'completed', 'probing', 'scheduled'];
        if (nmRes.state && validStates.includes((nmRes.state || '').toLowerCase())) {
          handoffSuccess = true;
        }
      }
    }

    if (handoffSuccess) {
      recentlyInterceptedDownloadIds.add(item.id);
      recentlyInterceptedUrls.set(rawUrl, now);

      // Clean up old entries in recentlyInterceptedUrls periodically
      if (recentlyInterceptedUrls.size > 200) {
        for (const [u, t] of recentlyInterceptedUrls.entries()) {
          if (now - t > 60000) recentlyInterceptedUrls.delete(u);
        }
      }

      // Cancel the browser's internal download while PRESERVING browser download history
      if (chrome.downloads && typeof chrome.downloads.cancel === 'function') {
        chrome.downloads.cancel(item.id, () => {
          // Intentionally do NOT erase: keep record in browser download history for user transparency
        });
      }
    }
  } catch (err) {
    // Desktop engine offline or error: ALWAYS leave browser download active!
    console.debug('[TORI] Failed to intercept download to TORI desktop, preserving browser download:', err);
  }
}`;

  const newHandler = `async function handleBrowserDownload(item) {
  if (!item || !item.id) return;
  // 0. Register interception ID synchronously BEFORE any await so onCreated and
  // onDeterminingFilename cannot enter handleBrowserDownload concurrently.
  if (recentlyInterceptedDownloadIds.has(item.id) || inFlightDownloadIds.has(item.id)) return;
  inFlightDownloadIds.add(item.id);

  try {
    await ensureSettingsLoaded();

    // 1. Check if download capture is enabled by user
    if (extSettings.cap === false) {
      return;
    }

    // 1b. Check browser danger warnings: respect security boundaries
    if (item.danger && item.danger !== 'safe' && item.danger !== 'accepted') {
      console.debug('[TORI] Download has browser danger status:', item.danger);
      return;
    }

    // Preserve exact URL including all security-relevant CDN query parameters (signatures, tokens, expiry)
    const rawUrl = item.url || item.finalUrl || '';
    if (!rawUrl) return;
    const lowerUrl = rawUrl.toLowerCase();

    // 2. Ignore browser-internal schemes and inline data
    if (
      lowerUrl.startsWith('blob:') ||
      lowerUrl.startsWith('data:') ||
      lowerUrl.startsWith('about:') ||
      lowerUrl.startsWith('chrome:') ||
      lowerUrl.startsWith('edge:') ||
      lowerUrl.startsWith('moz-extension:') ||
      lowerUrl.startsWith('chrome-extension:')
    ) {
      return;
    }

    // 3. Check site exclusion list
    if (isDomainExcluded(rawUrl, item.referrer)) {
      return;
    }

    // 4. Short rate-limit (3s) only against duplicate browser events for the identical URL,
    // while preserving legitimate distinct downloads triggered by the user later.
    const now = Date.now();
    if (recentlyInterceptedUrls.has(rawUrl)) {
      const lastTime = recentlyInterceptedUrls.get(rawUrl);
      if (now - lastTime < 3000) {
        return;
      }
    }

    // 5. Match file extension or MIME type against user configured types
    const userTypes = (Array.isArray(extSettings.types) ? extSettings.types : [
      'zip', 'rar', '7z', 'iso', 'exe', 'dmg', 'pdf', 'mp4', 'mp3'
    ]).map((t) => t.toLowerCase().replace(/^\\./, ''));

    const ext = extractExtensionFromDownloadItem(item);
    const baseMime = (item.mime || '').toLowerCase().split(';')[0].trim();
    const mimeExt = DOWNLOAD_MIME_MAP[baseMime] || '';

    const matched = (ext && userTypes.includes(ext)) || (mimeExt && userTypes.includes(mimeExt));
    if (!matched) {
      return;
    }

    // 6. Check minimum file size threshold (extSettings.min in MB)
    const minBytes = (parseFloat(extSettings.min) || 0) * 1024 * 1024;
    const totalBytes = item.totalBytes > 0 ? item.totalBytes : (item.fileSize > 0 ? item.fileSize : 0);
    if (minBytes > 0 && totalBytes > 0 && totalBytes < minBytes) {
      // Smaller than user threshold, leave in browser
      return;
    }

    // 7. Dispatch download to TORI Desktop Engine with deterministic idempotent handoff_id
    let rawFilename = item.filename ? item.filename.replace(/^.*[\\\\\\/]/, '') : '';
    if (!rawFilename) {
      rawFilename = extractFilenameFromUrl(rawUrl) || \`download.\${ext || mimeExt || 'bin'}\`;
    }

    const handoffId = \`ext_\${item.id}_\${item.startTime || now}\`;
    const payload = {
      url: rawUrl,
      filename: rawFilename,
      referer: item.referrer || '',
      user_agent: navigator.userAgent,
      priority: 'normal',
      handoff_id: handoffId,
    };

    const validStates = ['downloading', 'queued', 'paused', 'completed', 'probing', 'scheduled'];
    const isHandoffAccepted = (respData) => {
      if (!respData || !respData.job_id) return false;
      if (respData.status === 'ok') return true;
      if (respData.status === 'already_exists') {
        return Boolean(respData.state && validStates.includes(String(respData.state).toLowerCase()));
      }
      return false;
    };

    const httpRes = await callDesktopApi('/api/v1/downloads', 'POST', payload, 8000);
    let handoffSuccess = false;

    if (httpRes && httpRes.ok && httpRes.data) {
      handoffSuccess = isHandoffAccepted(httpRes.data);
    } else if (
      httpRes &&
      (httpRes.status === 400 || httpRes.status === 401 || httpRes.status === 403 || httpRes.status === 422)
    ) {
      // Explicit rejection or auth failure from desktop server: do NOT retry via Native Messaging
      handoffSuccess = false;
    } else {
      // Unknown API result (status === 0 timeout/network error) or 5xx:
      // First reconcile uncertain handoff via GET /api/v1/downloads before falling back
      if (httpRes && httpRes.status === 0) {
        const checkRes = await callDesktopApi('/api/v1/downloads', 'GET', null, 2000);
        if (checkRes && checkRes.ok && checkRes.data && Array.isArray(checkRes.data.jobs)) {
          const existingJob = checkRes.data.jobs.find(
            (j) => j.url === rawUrl && j.state && validStates.includes(String(j.state).toLowerCase())
          );
          if (existingJob) {
            handoffSuccess = true;
          }
        }
      }

      if (!handoffSuccess) {
        // Fallback to Native Messaging with the SAME idempotent handoff_id so the backend
        // coalesces with any in-flight HTTP probe rather than creating a second download.
        const nmRes = await sendNativeMessage({
          action: 'start_download',
          ...payload,
        }).catch(() => null);

        handoffSuccess = isHandoffAccepted(nmRes);
      }
    }

    if (handoffSuccess) {
      recentlyInterceptedDownloadIds.add(item.id);
      recentlyInterceptedUrls.set(rawUrl, now);

      if (recentlyInterceptedUrls.size > 200) {
        for (const [u, t] of recentlyInterceptedUrls.entries()) {
          if (now - t > 60000) recentlyInterceptedUrls.delete(u);
        }
      }

      // Cancel the browser's internal download while PRESERVING browser download history
      if (chrome.downloads && typeof chrome.downloads.cancel === 'function') {
        chrome.downloads.cancel(item.id, () => {
          // Intentionally do NOT erase: keep record in browser download history for user transparency
        });
      }
    }
  } catch (err) {
    // Desktop engine offline or error: ALWAYS leave browser download active!
    console.debug('[TORI] Failed to intercept download to TORI desktop, preserving browser download:', err);
  } finally {
    inFlightDownloadIds.delete(item.id);
  }
}`;

  const normalizedCode = code.replace(/\r\n/g, '\n');
  const normalizedOld = oldHandler.replace(/\r\n/g, '\n');
  if (!normalizedCode.includes(normalizedOld)) {
    throw new Error(`Expected handleBrowserDownload block not found in ${bgPath}`);
  }
  const updated = normalizedCode.replace(normalizedOld, newHandler);
  fs.writeFileSync(bgPath, updated, 'utf8');
}

function createZipFromDir(sourceDir, outZipPath) {
  if (fs.existsSync(outZipPath)) {
    fs.unlinkSync(outZipPath);
  }
  const py = `
import zipfile, os, sys
src_dir, out_zip = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(src_dir):
        dirs.sort()
        for f in sorted(files):
            full = os.path.join(root, f)
            rel = os.path.relpath(full, src_dir).replace('\\\\', '/')
            zf.write(full, rel)
`;
  execFileSync('python', ['-c', py, sourceDir, outZipPath], { stdio: 'inherit' });
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function main() {
  if (fs.existsSync(STAGE_ROOT)) {
    fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
  }
  fs.mkdirSync(CHROME_STAGE, { recursive: true });
  fs.mkdirSync(FIREFOX_STAGE, { recursive: true });

  // Copy Chrome files
  for (const rel of SHARED_FILES) {
    copyFileEnsureDir(path.join(EXT_SRC, rel), path.join(CHROME_STAGE, rel));
  }

  // Copy Firefox files
  for (const rel of SHARED_FILES) {
    const ffOverride = path.join(EXT_SRC, 'firefox', rel);
    const src = fs.existsSync(ffOverride) ? ffOverride : path.join(EXT_SRC, rel);
    copyFileEnsureDir(src, path.join(FIREFOX_STAGE, rel));
  }

  // Update manifests to 1.0.6-rc
  const chromeManifestPath = path.join(CHROME_STAGE, 'manifest.json');
  const chromeManifest = JSON.parse(fs.readFileSync(chromeManifestPath, 'utf8'));
  chromeManifest.version = '1.0.6';
  chromeManifest.version_name = '1.0.6-rc';
  fs.writeFileSync(chromeManifestPath, JSON.stringify(chromeManifest, null, 2) + '\n', 'utf8');

  const ffManifestPath = path.join(FIREFOX_STAGE, 'manifest.json');
  const ffManifest = JSON.parse(fs.readFileSync(ffManifestPath, 'utf8'));
  ffManifest.version = '1.0.6rc1';
  fs.writeFileSync(ffManifestPath, JSON.stringify(ffManifest, null, 2) + '\n', 'utf8');

  // Patch background.js in both staged trees
  patchBackgroundJs(path.join(CHROME_STAGE, 'background.js'));
  patchBackgroundJs(path.join(FIREFOX_STAGE, 'background.js'));

  // Package staged archives
  const chromeZip = path.join(STAGE_ROOT, 'tori-download-manager-extension-v1.0.6-rc.zip');
  const ffZip = path.join(STAGE_ROOT, 'tori-download-manager-firefox-v1.0.6-rc.zip');
  createZipFromDir(CHROME_STAGE, chromeZip);
  createZipFromDir(FIREFOX_STAGE, ffZip);

  const sums = [
    `${sha256File(chromeZip)}  ${path.basename(chromeZip)}`,
    `${sha256File(ffZip)}  ${path.basename(ffZip)}`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(STAGE_ROOT, 'SHA256SUMS.txt'), sums, 'utf8');

  console.log('[OK] Staged Extension v1.0.6-rc in release/v1.0.6-rc-extension/');
  console.log(sums);
}

main();
