/**
 * Diagnostic test for browser download capture & MKV detection logic
 */

const DOWNLOAD_MIME_MAP = {
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar',
  'application/x-7z-compressed': '7z',
  'application/x-iso9660-image': 'iso',
  'application/x-msdownload': 'exe',
  'application/vnd.microsoft.portable-executable': 'exe',
  'application/pdf': 'pdf',
  'application/x-apple-diskimage': 'dmg',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'application/x-bzip2': 'bz2',
  'application/x-xz': 'xz',
  'video/mp4': 'mp4',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
};

// Current extension defaults from background.js line 249
const CURRENT_DEFAULT_TYPES = ['zip', 'rar', '7z', 'iso', 'exe', 'dmg', 'pdf', 'mp4', 'mp3'];

function currentExtractExtension(item) {
  let name = item.filename ? item.filename.replace(/^.*[\\\/]/, '') : '';
  if (!name && item.url) {
    try {
      const p = new URL(item.url).pathname;
      name = p.substring(p.lastIndexOf('/') + 1);
    } catch (_) {}
  }
  if (name) {
    name = name.split('?')[0].split('#')[0];
    const dot = name.lastIndexOf('.');
    if (dot !== -1) {
      return name.substring(dot + 1).toLowerCase();
    }
  }
  return '';
}

function testCurrentLogic(scenarioName, item) {
  const ext = currentExtractExtension(item);
  const baseMime = (item.mime || '').toLowerCase().split(';')[0].trim();
  const mimeExt = DOWNLOAD_MIME_MAP[baseMime] || '';
  const userTypes = CURRENT_DEFAULT_TYPES.map(t => t.toLowerCase().replace(/^\./, ''));
  const matched = (ext && userTypes.includes(ext)) || (mimeExt && userTypes.includes(mimeExt));

  console.log(`[${matched ? 'MATCH' : 'BLOCKED'}] ${scenarioName}:`);
  console.log(`   ext: '${ext}', baseMime: '${baseMime}', mimeExt: '${mimeExt}'`);
  console.log(`   ext in userTypes: ${userTypes.includes(ext)}, mimeExt in userTypes: ${userTypes.includes(mimeExt)}\n`);
  return matched;
}

console.log('=== Testing Current (Unfixed) Extension Logic ===\n');

// Scenario 1: Direct MKV download URL
testCurrentLogic('1. Direct MKV URL (http://example.com/movie.mkv)', {
  id: 1,
  url: 'http://example.com/movie.mkv',
  filename: 'C:\\Users\\User\\Downloads\\movie.mkv',
  mime: 'video/x-matroska',
  totalBytes: 3113851289
});

// Scenario 2: MKV with application/octet-stream
testCurrentLogic('2. MKV with application/octet-stream', {
  id: 2,
  url: 'http://example.com/movie.mkv',
  filename: 'movie.mkv',
  mime: 'application/octet-stream',
  totalBytes: 3113851289
});

// Scenario 3: Uppercase .MKV extension
testCurrentLogic('3. Uppercase .MKV extension', {
  id: 3,
  url: 'http://example.com/MOVIE.MKV',
  filename: 'MOVIE.MKV',
  mime: 'video/x-matroska',
  totalBytes: 3113851289
});

// Scenario 4: Content-Disposition on determining filename with redirect URL
testCurrentLogic('4. Redirect URL (/dl?id=123) with Content-Disposition movie.mkv', {
  id: 4,
  url: 'http://example.com/dl?id=123',
  finalUrl: 'http://cdn.example.com/storage/file_blob',
  filename: 'movie.mkv',
  mime: 'application/octet-stream',
  totalBytes: 3113851289
});

// Scenario 5: Initial onCreated event where filename is empty
testCurrentLogic('5. Initial onCreated event where filename is empty', {
  id: 5,
  url: 'http://example.com/dl?id=123',
  filename: '',
  mime: 'video/x-matroska',
  totalBytes: 3113851289
});

