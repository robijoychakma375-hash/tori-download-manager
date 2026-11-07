/**
 * TORI Download Manager v1.0.1 - Gate 14.4.6 QA Verification Harness
 * Verifies Secure Per-Download User-Agent Support across Extension, IPC, and Download Engine.
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

// Extract getSafeUserAgent from extension/background.js
function loadBackgroundContext(navigatorObj) {
  const bgCode = fs.readFileSync(
    path.join(__dirname, '..', 'extension', 'background.js'),
    'utf-8'
  );

  // Extract getSafeUserAgent function definition
  const match = bgCode.match(/function getSafeUserAgent\([\s\S]*?\n\}/);
  if (!match) {
    throw new Error('Could not find getSafeUserAgent in background.js');
  }

  const context = {
    navigator: navigatorObj !== undefined ? navigatorObj : {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    },
  };
  vm.createContext(context);
  vm.runInContext(match[0], context);
  return context.getSafeUserAgent;
}

async function runTests() {
  console.log('====================================================');
  console.log('TORI GATE 14.4.6: SECURE PER-DOWNLOAD USER-AGENT SUPPORT');
  console.log('====================================================\n');

  const getSafeUserAgent = loadBackgroundContext();
  const getSafeUserAgentNoNav = loadBackgroundContext(null);

  // Scenario 1: Standard Chrome User-Agent
  console.log('--- Scenario 1: Standard Chrome User-Agent Validation ---');
  try {
    const chromeUa =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
    const res = getSafeUserAgent(chromeUa);
    assert.strictEqual(res, chromeUa);
    pass('Valid standard Chrome User-Agent is preserved and accepted');
  } catch (e) {
    fail('Standard Chrome UA failed', e);
  }

  // Scenario 2: Standard Edge User-Agent
  console.log('\n--- Scenario 2: Standard Edge User-Agent Validation ---');
  try {
    const edgeUa =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.86';
    const res = getSafeUserAgent(edgeUa);
    assert.strictEqual(res, edgeUa);
    pass('Valid standard Edge User-Agent is preserved and accepted');
  } catch (e) {
    fail('Standard Edge UA failed', e);
  }

  // Scenario 3: Standard Firefox User-Agent
  console.log('\n--- Scenario 3: Standard Firefox User-Agent Validation ---');
  try {
    const firefoxUa =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
    const res = getSafeUserAgent(firefoxUa);
    assert.strictEqual(res, firefoxUa);
    pass('Valid standard Firefox User-Agent is preserved and accepted');
  } catch (e) {
    fail('Standard Firefox UA failed', e);
  }

  // Scenario 4: CRLF Header Injection Defense
  console.log('\n--- Scenario 4: CRLF Header Injection Defense ---');
  try {
    const injection1 =
      'Mozilla/5.0\r\nInjected-Header: evil\r\n\r\nGET /bad HTTP/1.1';
    const injection2 = 'Mozilla/5.0\nInjected-Header: evil';
    const injection3 = 'Mozilla/5.0\rInjected-Header: evil';
    assert.strictEqual(getSafeUserAgent(injection1), null);
    assert.strictEqual(getSafeUserAgent(injection2), null);
    assert.strictEqual(getSafeUserAgent(injection3), null);
    pass('CRLF header injection attempts (\\r, \\n) strictly rejected (return null)');
  } catch (e) {
    fail('CRLF rejection failed', e);
  }

  // Scenario 5: ASCII Control Characters Defense
  console.log('\n--- Scenario 5: ASCII Control Characters Defense ---');
  try {
    const nullByte = 'Mozilla/5.0\x00NullByte';
    const backspace = 'Mozilla/5.0\x08Backspace';
    const escapeChar = 'Mozilla/5.0\x1BEsc';
    const delChar = 'Mozilla/5.0\x7FDel';
    assert.strictEqual(getSafeUserAgent(nullByte), null);
    assert.strictEqual(getSafeUserAgent(backspace), null);
    assert.strictEqual(getSafeUserAgent(escapeChar), null);
    assert.strictEqual(getSafeUserAgent(delChar), null);
    pass('ASCII control characters (0-31, 127) strictly rejected (return null)');
  } catch (e) {
    fail('Control character rejection failed', e);
  }

  // Scenario 6: Excessively Long User-Agent Defense
  console.log('\n--- Scenario 6: Excessively Long User-Agent Defense ---');
  try {
    const longUa = 'A'.repeat(1025);
    const validLongUa = 'A'.repeat(1024);
    assert.strictEqual(getSafeUserAgent(longUa), null);
    assert.strictEqual(getSafeUserAgent(validLongUa), validLongUa);
    pass('User-Agent exceeding 1024 characters strictly rejected; <=1024 accepted');
  } catch (e) {
    fail('Length boundary validation failed', e);
  }

  // Scenario 7: Fallback to Service Worker navigator.userAgent
  console.log('\n--- Scenario 7: Service Worker navigator.userAgent Fallback ---');
  try {
    const defaultNavUa =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
    assert.strictEqual(getSafeUserAgent(''), defaultNavUa);
    assert.strictEqual(getSafeUserAgent('   '), defaultNavUa);
    assert.strictEqual(getSafeUserAgent(null), defaultNavUa);
    assert.strictEqual(getSafeUserAgent(undefined), defaultNavUa);
    pass('When custom UA is empty or null, cleanly falls back to service worker navigator.userAgent');
  } catch (e) {
    fail('Service worker UA fallback failed', e);
  }

  // Scenario 8: Null Safety Without Navigator
  console.log('\n--- Scenario 8: Null Safety Without Navigator ---');
  try {
    assert.strictEqual(getSafeUserAgentNoNav(null), null);
    assert.strictEqual(getSafeUserAgentNoNav(undefined), null);
    assert.strictEqual(getSafeUserAgentNoNav(''), null);
    assert.strictEqual(getSafeUserAgentNoNav('   '), null);
    assert.strictEqual(getSafeUserAgentNoNav(12345), null);
    pass('Without navigator, null/empty/non-string safely returns null without throwing');
  } catch (e) {
    fail('Non-navigator handling failed', e);
  }

  // Scenario 9: Background START_DOWNLOAD REST API Payload Verification
  console.log('\n--- Scenario 9: Background START_DOWNLOAD REST API Payload ---');
  try {
    const bgCode = fs.readFileSync(
      path.join(__dirname, '..', 'extension', 'background.js'),
      'utf-8'
    );
    assert.ok(
      bgCode.includes('getSafeUserAgent'),
      'background.js must define getSafeUserAgent'
    );
    assert.ok(
      bgCode.includes("callDesktopApi('/api/v1/downloads', 'POST',") &&
        bgCode.includes('user_agent: safeUserAgent'),
      'START_DOWNLOAD must pass user_agent: safeUserAgent to /api/v1/downloads'
    );
    pass('background.js START_DOWNLOAD propagates safeUserAgent to REST API');
  } catch (e) {
    fail('REST API START_DOWNLOAD payload verification failed', e);
  }

  // Scenario 10: Background START_DOWNLOAD Native Messaging Fallback Payload
  console.log(
    '\n--- Scenario 10: Background START_DOWNLOAD Native Messaging Fallback ---'
  );
  try {
    const bgCode = fs.readFileSync(
      path.join(__dirname, '..', 'extension', 'background.js'),
      'utf-8'
    );
    assert.ok(
      bgCode.includes("action: 'start_download',") &&
        bgCode.includes('user_agent: safeUserAgent'),
      'Native Messaging start_download must pass user_agent: safeUserAgent'
    );
    pass('background.js START_DOWNLOAD propagates safeUserAgent to Native Messaging fallback');
  } catch (e) {
    fail('Native Messaging payload verification failed', e);
  }

  // Scenario 11: Background START_DOWNLOAD Transient CDN Reroute Payload
  console.log('\n--- Scenario 11: Background START_DOWNLOAD Transient CDN Reroute Payload ---');
  try {
    const bgCode = fs.readFileSync(
      path.join(__dirname, '..', 'extension', 'background.js'),
      'utf-8'
    );
    assert.ok(
      bgCode.includes('isTransientCdnUrl(rawUrl)'),
      'isTransientCdnUrl check must exist in background.js'
    );
    const cdnIndex = bgCode.indexOf('isTransientCdnUrl(rawUrl)');
    const cdnSnippet = bgCode.slice(cdnIndex, cdnIndex + 800);
    assert.ok(
      cdnSnippet.includes('user_agent: safeUserAgent'),
      'Transient CDN reroute block must include user_agent: safeUserAgent'
    );
    pass('background.js transient CDN token reroute path propagates safeUserAgent');
  } catch (e) {
    fail('CDN reroute payload verification failed', e);
  }

  // Scenario 12: Background START_MEDIA_DOWNLOAD REST API Payload
  console.log('\n--- Scenario 12: Background START_MEDIA_DOWNLOAD REST API Payload ---');
  try {
    const bgCode = fs.readFileSync(
      path.join(__dirname, '..', 'extension', 'background.js'),
      'utf-8'
    );
    assert.ok(
      bgCode.includes("callDesktopApi('/api/v1/media/download', 'POST',") &&
        bgCode.includes('user_agent: safeUserAgent'),
      'START_MEDIA_DOWNLOAD must pass user_agent: safeUserAgent to /api/v1/media/download'
    );
    pass('background.js START_MEDIA_DOWNLOAD propagates safeUserAgent to REST API');
  } catch (e) {
    fail('START_MEDIA_DOWNLOAD payload verification failed', e);
  }

  // Scenario 13: Extension Popup Supplies navigator.userAgent
  console.log('\n--- Scenario 13: Extension Popup Supplies navigator.userAgent ---');
  try {
    const popupCode = fs.readFileSync(
      path.join(__dirname, '..', 'extension', 'popup', 'popup.js'),
      'utf-8'
    );
    assert.ok(
      popupCode.includes('user_agent: navigator.userAgent'),
      'popup.js must send navigator.userAgent as user_agent'
    );
    pass('popup.js supplies browser navigator.userAgent on download triggers');
  } catch (e) {
    fail('Popup User-Agent verification failed', e);
  }

  // Scenario 14: Extension Content Script Supplies navigator.userAgent
  console.log('\n--- Scenario 14: Extension Content Script Supplies navigator.userAgent ---');
  try {
    const contentCode = fs.readFileSync(
      path.join(__dirname, '..', 'extension', 'content.js'),
      'utf-8'
    );
    assert.ok(
      contentCode.includes('user_agent: navigator.userAgent'),
      'content.js must send navigator.userAgent as user_agent'
    );
    pass('content.js supplies browser navigator.userAgent on page download triggers');
  } catch (e) {
    fail('Content script User-Agent verification failed', e);
  }

  // Scenario 15: Preservation of Referer & Security Invariants
  console.log('\n--- Scenario 15: Preservation of Referer & Security Invariants ---');
  try {
    const bgCode = fs.readFileSync(
      path.join(__dirname, '..', 'extension', 'background.js'),
      'utf-8'
    );
    assert.ok(
      bgCode.includes('deriveSafeReferer'),
      'deriveSafeReferer must be intact'
    );
    assert.ok(
      bgCode.includes('referer: safeReferer'),
      'referer context must remain alongside user_agent'
    );
    pass('Referer context and prior security invariants completely preserved');
  } catch (e) {
    fail('Security invariants failed', e);
  }

  console.log('\n====================================================');
  console.log(
    `GATE 14.4.6 TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`
  );
  console.log('====================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test execution error:', err);
  process.exit(1);
});
