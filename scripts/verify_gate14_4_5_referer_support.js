/**
 * TORI Download Manager v1.0.1 - Gate 14.4.5 QA Verification Harness
 * Verifies Secure Per-Download Referer Support across Extension, IPC, and Download Engine.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passCount = 0;
let failCount = 0;

function pass(msg) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

function fail(msg, err) {
  console.error(`[FAIL] ${msg}`);
  if (err) console.error(err);
  failCount++;
}

// Extract deriveSafeReferer from extension/background.js
function loadBackgroundContext() {
  const bgCode = fs.readFileSync(
    path.join(__dirname, '..', 'extension', 'background.js'),
    'utf-8'
  );

  // Extract deriveSafeReferer function definition
  const match = bgCode.match(/function deriveSafeReferer\([\s\S]*?\n\}/);
  if (!match) {
    throw new Error('Could not find deriveSafeReferer in background.js');
  }

  const context = { URL };
  vm.createContext(context);
  vm.runInContext(match[0], context);
  return context.deriveSafeReferer;
}

async function runTests() {
  console.log('====================================================');
  console.log('TORI GATE 14.4.5: SECURE PER-DOWNLOAD REFERER SUPPORT');
  console.log('====================================================\n');

  const deriveSafeReferer = loadBackgroundContext();

  // Scenario 1: Same-Origin Referer Sanitization
  console.log('--- Scenario 1: Same-Origin Referer Sanitization ---');
  try {
    const pageUrl = 'https://example.com/watch/video123?token=secret123&auth=true#part2';
    const mediaUrl = 'https://example.com/media/stream.mp4';
    const ref = deriveSafeReferer(pageUrl, mediaUrl);
    assert.strictEqual(ref, 'https://example.com/watch/video123');
    pass('Same-origin referer preserves path and origin, strips query tokens and fragment');
  } catch (e) {
    fail('Same-origin referer failed', e);
  }

  // Scenario 2: Cross-Origin Referer Truncation
  console.log('\n--- Scenario 2: Cross-Origin Referer Truncation ---');
  try {
    const pageUrl = 'https://example.com/watch/video123?token=secret123#part2';
    const mediaUrl = 'https://cdn.fastly.net/media/stream.mp4';
    const ref = deriveSafeReferer(pageUrl, mediaUrl);
    assert.strictEqual(ref, 'https://example.com/');
    pass('Cross-origin referer truncated strictly to origin only (strict-origin-when-cross-origin)');
  } catch (e) {
    fail('Cross-origin referer failed', e);
  }

  // Scenario 3: HTTPS to HTTP Downgrade Protection
  console.log('\n--- Scenario 3: HTTPS to HTTP Downgrade Protection ---');
  try {
    const pageUrl = 'https://secure-portal.com/watch';
    const mediaUrl = 'http://insecure-cdn.com/media.mp4';
    const ref = deriveSafeReferer(pageUrl, mediaUrl);
    assert.strictEqual(ref, null);
    pass('HTTPS to HTTP downgrade strictly omits Referer (returns null)');
  } catch (e) {
    fail('Downgrade protection failed', e);
  }

  // Scenario 4: HTTP to HTTP Same-Origin
  console.log('\n--- Scenario 4: HTTP to HTTP Same-Origin ---');
  try {
    const pageUrl = 'http://example.com/watch/page?query=1';
    const mediaUrl = 'http://example.com/media.mp4';
    const ref = deriveSafeReferer(pageUrl, mediaUrl);
    assert.strictEqual(ref, 'http://example.com/watch/page');
    pass('HTTP to HTTP same-origin referer correctly permitted without query params');
  } catch (e) {
    fail('HTTP same-origin referer failed', e);
  }

  // Scenario 5: User Credentials Stripped
  console.log('\n--- Scenario 5: User Credentials Stripped ---');
  try {
    const pageUrl = 'https://admin:superpassword123@example.com/dashboard/video';
    const mediaUrl = 'https://example.com/video.mp4';
    const ref = deriveSafeReferer(pageUrl, mediaUrl);
    assert.strictEqual(ref, 'https://example.com/dashboard/video');
    assert.ok(!ref.includes('superpassword123'));
    assert.ok(!ref.includes('admin'));
    pass('User credentials (userinfo) completely stripped from Referer');
  } catch (e) {
    fail('Credentials stripping failed', e);
  }

  // Scenario 6: CRLF and Header Injection Defense
  console.log('\n--- Scenario 6: CRLF and Header Injection Defense ---');
  try {
    const injection1 = 'https://example.com/watch\r\nEvil-Header: injected';
    const injection2 = 'https://example.com/watch\nEvil-Header: injected';
    const injection3 = 'https://example.com/watch\rEvil-Header: injected';
    assert.strictEqual(deriveSafeReferer(injection1, 'https://example.com/video.mp4'), null);
    assert.strictEqual(deriveSafeReferer(injection2, 'https://example.com/video.mp4'), null);
    assert.strictEqual(deriveSafeReferer(injection3, 'https://example.com/video.mp4'), null);
    pass('CRLF header injection strings strictly rejected (return null)');
  } catch (e) {
    fail('CRLF rejection failed', e);
  }

  // Scenario 7: Control Characters Rejected
  console.log('\n--- Scenario 7: Control Characters Rejected ---');
  try {
    const ctrlCharUrl = 'https://example.com/watch\x00nullbyte';
    assert.strictEqual(deriveSafeReferer(ctrlCharUrl, 'https://example.com/video.mp4'), null);
    pass('ASCII control characters (0-31, 127) strictly rejected');
  } catch (e) {
    fail('Control character rejection failed', e);
  }

  // Scenario 8: Invalid Schemes Rejected
  console.log('\n--- Scenario 8: Invalid Schemes Rejected ---');
  try {
    const invalidSchemes = [
      'javascript:alert(1)',
      'chrome-extension://egijhkhpknppjfdkmffbdmeinklnombl/popup.html',
      'edge://extensions',
      'about:blank',
      'blob:https://example.com/1234',
      'data:text/html,test',
      'file:///C:/Users/Admin/secrets.txt',
    ];
    for (const s of invalidSchemes) {
      assert.strictEqual(
        deriveSafeReferer(s, 'https://example.com/video.mp4'),
        null,
        `Scheme must be rejected: ${s}`
      );
    }
    pass('Non-HTTP/HTTPS schemes (javascript, chrome-extension, blob, data, file, about) rejected');
  } catch (e) {
    fail('Invalid schemes rejection failed', e);
  }

  // Scenario 9: Empty, Whitespace, and Null Safety
  console.log('\n--- Scenario 9: Empty, Whitespace, and Null Safety ---');
  try {
    assert.strictEqual(deriveSafeReferer(null, 'https://example.com/video.mp4'), null);
    assert.strictEqual(deriveSafeReferer(undefined, 'https://example.com/video.mp4'), null);
    assert.strictEqual(deriveSafeReferer('', 'https://example.com/video.mp4'), null);
    assert.strictEqual(deriveSafeReferer('   ', 'https://example.com/video.mp4'), null);
    assert.strictEqual(deriveSafeReferer(12345, 'https://example.com/video.mp4'), null);
    pass('Null, undefined, empty strings, and non-strings safely handled without throwing');
  } catch (e) {
    fail('Null/empty handling failed', e);
  }

  // Scenario 10: Extension Background START_DOWNLOAD Payload Verification
  console.log('\n--- Scenario 10: Background START_DOWNLOAD Payload Verification ---');
  try {
    const bgCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf-8');
    assert.ok(bgCode.includes('deriveSafeReferer'), 'background.js must define deriveSafeReferer');
    assert.ok(
      bgCode.includes("callDesktopApi('/api/v1/downloads', 'POST',") &&
      bgCode.includes('referer: safeReferer'),
      'START_DOWNLOAD must pass referer: safeReferer to /api/v1/downloads'
    );
    assert.ok(
      bgCode.includes("action: 'start_download',") &&
      bgCode.includes('referer: safeReferer'),
      'Native Messaging start_download must pass referer: safeReferer'
    );
    pass('background.js START_DOWNLOAD propagates safeReferer to REST API and Native Messaging');
  } catch (e) {
    fail('START_DOWNLOAD payload verification failed', e);
  }

  // Scenario 11: Extension Background START_MEDIA_DOWNLOAD Payload Verification
  console.log('\n--- Scenario 11: Background START_MEDIA_DOWNLOAD Payload Verification ---');
  try {
    const bgCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf-8');
    assert.ok(
      bgCode.includes("callDesktopApi('/api/v1/media/download', 'POST',") &&
      bgCode.includes('referer: safeReferer'),
      'START_MEDIA_DOWNLOAD must pass referer: safeReferer to /api/v1/media/download'
    );
    pass('background.js START_MEDIA_DOWNLOAD propagates safeReferer to /api/v1/media/download');
  } catch (e) {
    fail('START_MEDIA_DOWNLOAD payload verification failed', e);
  }

  // Scenario 12: Extension Popup & Content Script Page URL Passing
  console.log('\n--- Scenario 12: Popup & Content Script Page URL Passing ---');
  try {
    const popupCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup', 'popup.js'), 'utf-8');
    const contentCode = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf-8');
    assert.ok(popupCode.includes('page_url: tab.url'), 'popup.js must send tab.url as page_url');
    assert.ok(popupCode.includes('page_url: currentUrl'), 'popup.js direct items must send currentUrl as page_url');
    assert.ok(contentCode.includes('page_url: window.location.href'), 'content.js must send window.location.href as page_url');
    pass('popup.js and content.js supply genuine user source page URLs');
  } catch (e) {
    fail('Popup/content script verification failed', e);
  }

  console.log('\n====================================================');
  console.log(`GATE 14.4.5 TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('====================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test execution error:', err);
  process.exit(1);
});

