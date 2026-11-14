/**
 * Test enhanced extension and filename extraction logic
 */

const DEFAULT_CAPTURE_TYPES = [
  'zip', 'rar', '7z', 'iso', 'exe', 'msi', 'dmg', 'bin', 'tar', 'gz', 'bz2', 'xz',
  'mkv', 'mp4', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus',
  'pdf', 'epub'
];

const DOWNLOAD_MIME_MAP = {
  // Archives & Executables
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar',
  'application/x-7z-compressed': '7z',
  'application/x-iso9660-image': 'iso',
  'application/x-msdownload': 'exe',
  'application/x-msi': 'msi',
  'application/vnd.microsoft.portable-executable': 'exe',
  'application/pdf': 'pdf',
  'application/epub+zip': 'epub',
  'application/x-apple-diskimage': 'dmg',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'application/x-bzip2': 'bz2',
  'application/x-xz': 'xz',
  'application/octet-stream': 'bin',
  // Video
  'video/x-matroska': 'mkv',
  'video/matroska': 'mkv',
  'application/x-matroska': 'mkv',
  'application/mkv': 'mkv',
  'video/mkv': 'mkv',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-msvideo': 'avi',
  'video/avi': 'avi',
  'video/msvideo': 'avi',
  'video/quicktime': 'mov',
  'video/x-flv': 'flv',
  'video/x-ms-wmv': 'wmv',
  'video/x-m4v': 'm4v',
  // Audio
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/x-matroska': 'mka',
  'audio/webm': 'weba',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/opus': 'opus',
};

function parseExt(str) {
  if (!str || typeof str !== 'string') return '';
  let clean = str.trim();
  try { clean = decodeURIComponent(clean); } catch (_) {}
  clean = clean.split('?')[0].split('#')[0].replace(/^.*[\\\/]/, '').trim();
  const dot = clean.lastIndexOf('.');
  if (dot !== -1 && dot < clean.length - 1) {
    const candidate = clean.substring(dot + 1).toLowerCase().trim();
    if (/^[a-z0-9]{1,10}$/i.test(candidate)) {
      return candidate;
    }
  }
  return '';
}

function extractExtensionFromDownloadItem(item) {
  // 1. Direct item.filename
  if (item.filename) {
    const ext = parseExt(item.filename);
    if (ext) return ext;
  }

  // Helper to extract candidate names from a URL string
  const checkUrl = (urlStr) => {
    if (!urlStr) return '';
    try {
      const u = new URL(urlStr);
      // Pathname
      const fromPath = parseExt(u.pathname);
      if (fromPath) return fromPath;

      // Common query parameters that carry the intended filename
      const qParams = ['filename', 'file', 'name', 'fn', 'download', 'title', 'attachment'];
      for (const p of qParams) {
        const val = u.searchParams.get(p);
        if (val) {
          const fromQuery = parseExt(val);
          if (fromQuery) return fromQuery;
        }
      }
    } catch (_) {}
    return '';
  };

  // 2. finalUrl (post-redirect target)
  if (item.finalUrl && item.finalUrl !== item.url) {
    const ext = checkUrl(item.finalUrl);
    if (ext) return ext;
  }

  // 3. url (initial request)
  if (item.url) {
    const ext = checkUrl(item.url);
    if (ext) return ext;
  }

  return '';
}

function testEnhancedLogic(scenarioName, item) {
  const ext = extractExtensionFromDownloadItem(item);
  const baseMime = (item.mime || '').toLowerCase().split(';')[0].trim();
  const mimeExt = DOWNLOAD_MIME_MAP[baseMime] || '';

  // In enhanced settings, DEFAULT_CAPTURE_TYPES includes mkv, avi, mov, webm, etc.
  // And user settings merge with defaults
  const userTypes = DEFAULT_CAPTURE_TYPES.map(t => t.toLowerCase().replace(/^\./, ''));
  const matched = (ext && userTypes.includes(ext)) || (mimeExt && mimeExt !== 'bin' && userTypes.includes(mimeExt));

  console.log(`[${matched ? 'PASS - MATCHED' : 'FAIL - BLOCKED'}] ${scenarioName}:`);
  console.log(`   ext: '${ext}', baseMime: '${baseMime}', mimeExt: '${mimeExt}'`);
  console.log(`   matched: ${matched}\n`);
  return matched;
}

console.log('=== Testing Enhanced Logic on All MKV & Large File Scenarios ===\n');

testEnhancedLogic('1. Direct MKV URL (http://example.com/movie.mkv)', {
  id: 1,
  url: 'http://example.com/movie.mkv',
  filename: 'C:\\Users\\User\\Downloads\\movie.mkv',
  mime: 'video/x-matroska',
  totalBytes: 3113851289
});

testEnhancedLogic('2. MKV with application/octet-stream', {
  id: 2,
  url: 'http://example.com/movie.mkv',
  filename: 'movie.mkv',
  mime: 'application/octet-stream',
  totalBytes: 3113851289
});

testEnhancedLogic('3. Uppercase .MKV extension', {
  id: 3,
  url: 'http://example.com/MOVIE.MKV',
  filename: 'MOVIE.MKV',
  mime: 'video/x-matroska',
  totalBytes: 3113851289
});

testEnhancedLogic('4. Redirect URL (/dl?id=123) with Content-Disposition movie.mkv', {
  id: 4,
  url: 'http://example.com/dl?id=123',
  finalUrl: 'http://cdn.example.com/storage/file_blob',
  filename: 'movie.mkv',
  mime: 'application/octet-stream',
  totalBytes: 3113851289
});

testEnhancedLogic('5. URL with query param filename=Big_Buck_Bunny_1080p.mkv', {
  id: 5,
  url: 'http://cdn.example.com/download?token=xyz987&filename=Big_Buck_Bunny_1080p.mkv',
  filename: '',
  mime: 'application/octet-stream',
  totalBytes: 3113851289
});

testEnhancedLogic('6. URL with percent-encoded spaces and unicode filename', {
  id: 6,
  url: 'http://cdn.example.com/files/%E5%A4%A7%E5%9E%8B%20Video%202.9GB.mkv',
  filename: 'C:\\Users\\User\\Downloads\\大型 Video 2.9GB.mkv',
  mime: 'video/matroska',
  totalBytes: 3113851289
});

testEnhancedLogic('7. FinalUrl has .mkv while initial url is a tracking redirect', {
  id: 7,
  url: 'http://tracking.service.com/click?link_id=992837',
  finalUrl: 'http://direct.filehost.com/2026/media/sample_3gb.mkv?auth=abc',
  filename: '',
  mime: 'application/octet-stream',
  totalBytes: 3113851289
});

