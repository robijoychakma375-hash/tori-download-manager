/**
 * TORI Download Manager v1.0.1 — Gate 14.1 Comprehensive QA Suite
 * 
 * Verifies:
 * 1. Strict version alignment (v1.0.1 development build, v1.0.0 release preserved)
 * 2. Ghost Toast elimination architecture & event propagation
 * 3. Download completion synchronization & finishing state handling
 * 4. WebView2 renderer destruction on toast dismissal & background memory optimizations
 * 5. Rust cryptographic updater verification & database schema integrity
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message, details = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASS] ${message}`);
  } else {
    failedTests++;
    console.error(`  [FAIL] ${message} - ${details}`);
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('TORI Download Manager v1.0.1 — Gate 14.1 Verification Suite');
  console.log('================================================================\n');

  // -------------------------------------------------------------
  // TEST GROUP 1: Version Policy & v1.0.0 Preservation
  // -------------------------------------------------------------
  console.log('--- TEST GROUP 1: Version Policy & Release Preservation ---');

  const cargoToml = fs.readFileSync(path.join(PROJECT_ROOT, 'Cargo.toml'), 'utf8');
  const cargoMatch = cargoToml.match(/\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/);
  assert(cargoMatch && cargoMatch[1] === '1.0.1', `Cargo.toml workspace package version is 1.0.1 (got ${cargoMatch ? cargoMatch[1] : 'null'})`);

  const tauriConf = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert(tauriConf.version === '1.0.1', `tauri.conf.json version is 1.0.1 (got ${tauriConf.version})`);

  const uiPkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'package.json'), 'utf8'));
  assert(uiPkg.version === '1.0.1', `ui/package.json version is 1.0.1 (got ${uiPkg.version})`);

  // SettingsModal dynamic version display
  const settingsModalSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'src', 'components', 'SettingsModal.tsx'), 'utf8');
  assert(
    settingsModalSrc.includes("appVersion === '1.0.0' ? '(Production Release)' : '(Development Build)'"),
    'SettingsModal.tsx dynamically marks non-1.0.0 versions as Development Build'
  );

  // Extension manifest remains 1.0.0
  const extManifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert(extManifest.version === '1.0.0', `extension/manifest.json is preserved at 1.0.0 (got ${extManifest.version})`);

  // v1.0.0 public release assets preserved
  const releaseDir = path.join(PROJECT_ROOT, 'release', 'v1.0.0');
  assert(fs.existsSync(releaseDir), 'release/v1.0.0 directory exists and is preserved');
  if (fs.existsSync(releaseDir)) {
    const releaseFiles = fs.readdirSync(releaseDir);
    assert(releaseFiles.some((f) => f.includes('1.0.0') && f.endsWith('.exe')), 'release/v1.0.0 contains v1.0.0 NSIS installer');
    assert(releaseFiles.includes('latest.json'), 'release/v1.0.0 contains latest.json updater manifest');
  }

  // Verify git branch is dev/v1.0.1
  const currentBranch = execSync('git branch --show-current', { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
  assert(currentBranch === 'dev/v1.0.1', `Active git branch is dev/v1.0.1 (got ${currentBranch})`);

  // -------------------------------------------------------------
  // TEST GROUP 2: Ghost Toast Elimination Architecture
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 2: Ghost Toast Elimination Architecture ---');

  const eventsRs = fs.readFileSync(path.join(PROJECT_ROOT, 'crates', 'tdm-core', 'src', 'engine', 'events.rs'), 'utf8');
  assert(/Deleted\s*\{\s*id:\s*String\s*,?\s*\}/.test(eventsRs), 'tdm-core DownloadEvent defines Deleted { id: String } variant');

  const managerRs = fs.readFileSync(path.join(PROJECT_ROOT, 'crates', 'tdm-core', 'src', 'engine', 'manager.rs'), 'utf8');
  assert(
    managerRs.includes('DownloadEvent::Deleted { id: id.to_string() }'),
    'DownloadManager.delete_download emits DownloadEvent::Deleted event'
  );

  const repoRs = fs.readFileSync(path.join(PROJECT_ROOT, 'crates', 'tdm-core', 'src', 'db', 'repo.rs'), 'utf8');
  assert(
    repoRs.includes('DELETE FROM download_chunks WHERE download_id = ?1'),
    'Database.delete_job explicitly purges download_chunks prior to downloads table deletion'
  );

  const commandsRs = fs.readFileSync(path.join(PROJECT_ROOT, 'src-tauri', 'src', 'commands.rs'), 'utf8');
  assert(
    commandsRs.includes('app.emit("download-deleted", &id)'),
    'commands.rs delete_download emits "download-deleted" event across all Tauri windows'
  );
  assert(
    commandsRs.includes('for id in ids') && commandsRs.includes('app.emit("download-deleted", &id)'),
    'commands.rs delete_downloads emits "download-deleted" event for all deleted IDs'
  );
  assert(
    commandsRs.includes('win.destroy()'),
    'commands.rs hide_toast_window calls win.destroy() to terminate WebView2 renderer process'
  );

  const typesTs = fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'src', 'types.ts'), 'utf8');
  assert(
    typesTs.includes("| { type: 'Deleted'; payload: { id: string } }"),
    'ui/src/types.ts DownloadEvent union includes Deleted variant'
  );

  const toastTsx = fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'src', 'components', 'DownloadToast.tsx'), 'utf8');
  assert(toastTsx.includes('deletedIdsRef'), 'DownloadToast.tsx maintains deletedIdsRef set');
  assert(toastTsx.includes('handleTaskDeleted'), 'DownloadToast.tsx defines centralized handleTaskDeleted');
  assert(
    toastTsx.includes('deletedIdsRef.current.has(prog.id)'),
    'DownloadToast.tsx ignores late progress events for deleted tasks'
  );
  assert(
    toastTsx.includes("payload.type === 'Deleted'"),
    'DownloadToast.tsx listens for DownloadEvent::Deleted event'
  );
  assert(
    toastTsx.includes("listen<string>('download-deleted'"),
    'DownloadToast.tsx listens for Tauri "download-deleted" event'
  );
  assert(
    toastTsx.includes('const missingIds = activeIds.filter((id) => !existingIds.has(id))'),
    'DownloadToast.tsx 2.5s reconciliation loop detects missing SQLite tasks and purges them'
  );

  // -------------------------------------------------------------
  // TEST GROUP 3: Download Completion & Finishing State Sync
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 3: Download Completion & Finishing State Sync ---');

  const appTsx = fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'src', 'App.tsx'), 'utf8');
  assert(
    appTsx.includes("speed_bps: isDone || isPaused ? 0 : job.speed_bps"),
    'App.tsx zeroes speed_bps when download completes or pauses'
  );
  assert(
    appTsx.includes("eta_seconds: isDone || isPaused ? null : job.eta_seconds"),
    'App.tsx nulls eta_seconds when download completes or pauses'
  );
  assert(
    appTsx.includes("payload.type === 'Deleted'"),
    'App.tsx handles DownloadEvent::Deleted to synchronize main table and selection'
  );
  assert(
    appTsx.includes("listen<string>('download-deleted'"),
    'App.tsx listens to Tauri "download-deleted" event'
  );
  assert(
    appTsx.includes("document.hidden && now - lastProgressRenderRef.current < 1500"),
    'App.tsx throttles high-frequency Progress re-rendering while document is hidden'
  );
  assert(
    appTsx.includes("document.addEventListener('visibilitychange', handleVisibilityChange)"),
    'App.tsx flushes table state immediately when returning to foreground via visibilitychange'
  );

  const tableTsx = fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'src', 'components', 'DownloadTable.tsx'), 'utf8');
  assert(
    tableTsx.includes('const isFinishing = isDownloading && hasKnownTotal && downloaded >= total;'),
    'DownloadTable.tsx computes distinct isFinishing state'
  );
  assert(
    tableTsx.includes("isFinishing ? 'Finishing…' : `${Math.floor(percent)}%`"),
    'DownloadTable.tsx displays "Finishing…" instead of prematurely showing remaining time'
  );
  assert(
    tableTsx.replace(/\s+/g, ' ').includes("isComplete ? '' : isFinishing ? 'Finishing…' : isDownloading ? fmtT(job.eta_seconds) : stateLabel(job.state)"),
    'DownloadTable.tsx suppresses remaining time when complete or finishing'
  );

  assert(
    toastTsx.includes('const isFinishing = isDown && hasKnownTotal && downloaded >= total;'),
    'DownloadToast.tsx computes distinct isFinishing state'
  );
  assert(
    toastTsx.includes("subtext = `${fmtB(total)} · Finishing…`;"),
    'DownloadToast.tsx shows "Finishing…" subtext while finalizing file'
  );
  assert(
    toastTsx.includes("etaNum = 'Finishing…';"),
    'DownloadToast.tsx shows "Finishing…" badge while finalizing file'
  );
  assert(
    toastTsx.includes("etaNum = 'Done';") && toastTsx.includes("etaSub = 'Finished';"),
    'DownloadToast.tsx shows "Done · Finished" badge when complete'
  );

  // -------------------------------------------------------------
  // TEST GROUP 4: Minisign Updater Cryptography Verification
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 4: Minisign Updater Cryptography ---');
  try {
    const testOut = execSync('cargo test --test updater_cryptography_tests', {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: { ...process.env, CARGO_BUILD_JOBS: '2' },
    });
    assert(testOut.includes('5 passed; 0 failed'), 'All 5 Minisign updater cryptography tests pass in Rust');
  } catch (err) {
    assert(false, 'Minisign updater cryptography tests passed', err.message);
  }

  // -------------------------------------------------------------
  // TEST GROUP 5: Production Verification Script
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 5: Production Release Verification Script ---');
  try {
    const psOut = execSync('powershell -ExecutionPolicy Bypass -File scripts\\verify_production_release.ps1', {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
    assert(
      psOut.includes('ALL PRODUCTION RELEASE GUARD CHECKS PASSED') && psOut.includes('[PASS 15]'),
      'verify_production_release.ps1 passes 15/15 release checks'
    );
  } catch (err) {
    assert(false, 'verify_production_release.ps1 passes 15/15 release checks', err.message);
  }

  // -------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------
  console.log('\n================================================================');
  console.log(`Gate 14.1 QA Test Results: ${passedTests}/${totalTests} Passed (${failedTests} Failed)`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

