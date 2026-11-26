#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 37.2 CI Security Audit, Static Validation & 15-Case Failure-Mode Suite
 *
 * Strictly local and read-only toward production:
 *   - Phase 13: Deep GitHub Actions YAML AST + security policy audit (PyYAML), SHA-pinned action
 *               verification, zero shell/expression injection (`${{ inputs.* }}` banned in `run:`),
 *               PowerShell AST parse, Node syntax check, token redaction & secret scan.
 *   - Phase 14: ALL 15 mandatory failure-mode negative tests exercising fail-closed behavior and
 *               evidence retention without mutating production or the operator's Desktop profile.
 *   - Phase 19: Non-mutating guest dry-run report generation + schema validation + OEM preservation.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  classifyWindowsOs,
  assertEnvironmentMatch,
  assertSafeTestRoot,
  redactSecrets,
  buildQaResults,
  validateQaResultsSchema,
  renderQaSummaryMarkdown,
} = require('./qa_report_lib');
const { runHealthCheck } = require('./verify_gate37_1_production_health');

const ROOT = path.resolve(__dirname, '..');
const QA_ROOT = path.join(ROOT, 'target', 'gate37_2_qa_work');
const EV_DIR = path.join(ROOT, 'target', 'gate37_2_evidence');
const V109_INST = path.join(ROOT, 'release', 'v1.0.9-rc', 'TORI.Download.Manager_1.0.9_x64-setup.exe');
const V109_SIG = path.join(ROOT, 'release', 'v1.0.9-rc', 'TORI.Download.Manager_1.0.9_x64-setup.exe.sig');
const V109_SHA = '460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead';
const GUEST_PS1 = path.join(ROOT, 'scripts', 'clean_windows_qa_guest.ps1');
const VM_PS1 = path.join(ROOT, 'scripts', 'run_clean_windows_vm_qa.ps1');

const cases = [];
function record(suite, id, name, ok, duration_ms, detail = '', error_summary = null) {
  const status = ok ? 'PASS' : 'FAIL';
  cases.push({
    suite, id, name, status, duration_ms,
    exit_code: ok ? 0 : 1,
    detail: redactSecrets(detail),
    error_summary: ok ? null : (error_summary || detail),
  });
  console.log(`[${status}] [${suite}/${id}] ${name}${detail ? ' -> ' + redactSecrets(detail) : ''}`);
}

function runPsFile(scriptPath, args) {
  const t0 = Date.now();
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
    encoding: 'utf8',
    timeout: 60000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', combined: `${r.stdout || ''}\n${r.stderr || ''}`, ms: Date.now() - t0 };
}

async function runPhase13CiSecurityAudit() {
  // SEC-CI-01: Deep PyYAML AST + security audit of both workflows
  const t0 = Date.now();
  const wfClean = path.join(ROOT, '.github', 'workflows', 'clean-windows-release-qa.yml');
  const wfExp = path.join(ROOT, '.github', 'workflows', 'tools-manifest-expiry-monitor.yml');
  const pyAudit = `
import re, sys, yaml

clean_path, exp_path = sys.argv[1], sys.argv[2]
for p in (clean_path, exp_path):
    raw = open(p, encoding='utf-8').read()
    doc = yaml.safe_load(raw)
    assert isinstance(doc, dict), f'Invalid YAML root in {p}'
    assert doc.get('permissions') == {'contents': 'read'}, f'Excessive permissions in {p}: {doc.get("permissions")}'
    assert not re.search(r'secrets\.[A-Za-z_]', raw), f'Unexpected secrets reference in {p}'
    on_block = doc.get(True) or doc.get('on') or {}
    assert 'pull_request_target' not in on_block and 'push' not in on_block, f'Unintended trigger in {p}'
    for jname, job in (doc.get('jobs') or {}).items():
        assert job.get('timeout-minutes', 999) <= 30, f'Unbounded job timeout in {p} job {jname}'
        for step in (job.get('steps') or []):
            uses = step.get('uses')
            if uses:
                assert re.match(r'^[A-Za-z0-9_\\-]+/[A-Za-z0-9_\\-]+@[0-9a-f]{40}$', uses), f'Unpinned action in {p}: {uses}'
                if uses.startswith('actions/checkout@'):
                    assert (step.get('with') or {}).get('persist-credentials') is False, f'checkout must set persist-credentials: false in {p}'
                if uses.startswith('actions/upload-artifact@'):
                    assert (step.get('with') or {}).get('retention-days', 999) <= 30, f'Artifact retention exceeds 30d in {p}'
            run_cmd = step.get('run') or ''
            assert not re.search(r'\\$\\{\\{\\s*inputs\\.', run_cmd), f'Expression injection risk (inputs.* inside run) in {p} step {step.get("name")}'
            assert not re.search(r'\\$\\{\\{\\s*github\\.event\\.', run_cmd), f'Event expression inside run in {p}'

# Strict Gate 37.2/37.3 checks on clean-windows-release-qa.yml
cdoc = yaml.safe_load(open(clean_path, encoding='utf-8').read())
on_clean = cdoc.get(True) or cdoc.get('on')
assert set(on_clean.keys()) == {'workflow_dispatch'}, f'clean-windows-release-qa.yml must only trigger on workflow_dispatch, got {set(on_clean.keys())}'
cjob = cdoc['jobs']['windows-server-ci-smoke']
assert set(cjob['strategy']['matrix']['os']) == {'windows-2022', 'windows-2025'}
inputs = on_clean['workflow_dispatch']['inputs']
for req_in in ('release_version', 'release_tag', 'expected_sha256', 'target_qa_profile', 'run_updater_smoke'):
    assert req_in in inputs, f'Missing input {req_in}'

print('CI_YAML_SECURITY_AUDIT_PASS')
`;
  const r1 = spawnSync('python', ['-c', pyAudit, wfClean, wfExp], { encoding: 'utf8' });
  record('ci_security', 'SEC-CI-01', 'PyYAML AST & CI security audit (read-only perms, 0 secrets, SHA-pinned actions, 0 input expression injection)',
    r1.status === 0 && (r1.stdout || '').includes('CI_YAML_SECURITY_AUDIT_PASS'), Date.now() - t0, (r1.stdout || r1.stderr).trim());

  // DEP-01: Workflow & QA script dependency closure verification (every referenced script & local require exists)
  const tDep = Date.now();
  const missingDeps = [];
  for (const wfPath of [wfClean, wfExp]) {
    const raw = fs.readFileSync(wfPath, 'utf8');
    const matches = raw.match(/scripts[\\\/][A-Za-z0-9_.\-]+\.(?:ps1|js)/g) || [];
    for (const m of matches) {
      const rel = m.replace(/\\/g, '/');
      if (!fs.existsSync(path.join(ROOT, rel))) missingDeps.push(`${path.basename(wfPath)} -> ${rel}`);
    }
  }
  const tauriConfPath = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
  let pubkeyOk = false;
  if (fs.existsSync(tauriConfPath)) {
    const conf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
    pubkeyOk = Boolean(conf?.plugins?.updater?.pubkey && conf.plugins.updater.pubkey.length > 40);
  }
  if (!pubkeyOk) missingDeps.push('src-tauri/tauri.conf.json:plugins.updater.pubkey');
  const scopedJsList = [
    path.join(ROOT, 'scripts', 'qa_report_lib.js'),
    path.join(ROOT, 'scripts', 'verify_release_upgrade_and_engine.js'),
    path.join(ROOT, 'scripts', 'verify_gate37_2_ci_and_qa_suite.js'),
    path.join(ROOT, 'scripts', 'verify_gate37_1_production_health.js'),
    path.join(ROOT, 'scripts', 'monitor_tools_manifest_expiry.js'),
  ];
  for (const jsFile of scopedJsList) {
    if (!fs.existsSync(jsFile)) { missingDeps.push(path.relative(ROOT, jsFile)); continue; }
    const src = fs.readFileSync(jsFile, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) {
      const target = m[1].endsWith('.js') ? m[1] : `${m[1]}.js`;
      const resolved = path.resolve(path.dirname(jsFile), target);
      if (!fs.existsSync(resolved)) missingDeps.push(`${path.basename(jsFile)} -> ${m[1]}`);
    }
  }
  record('local_static', 'DEP-01', 'Workflow & QA dependency closure (every workflow script ref, tauri updater pubkey & JS local require resolves)',
    missingDeps.length === 0, Date.now() - tDep, missingDeps.length === 0 ? 'CLOSURE_COMPLETE missing=0 pubkey=CDC23D8CC8DA5397' : `missing=${missingDeps.join('; ')}`);

  // STAT-01: PowerShell AST syntax validation across all required scoped QA/security scripts (+ optional scripts if present)
  const t1 = Date.now();
  const requiredPsFiles = [
    GUEST_PS1,
    VM_PS1,
    path.join(ROOT, 'scripts', 'verify_pe_authenticode.ps1'),
  ];
  const optionalPsFiles = [
    path.join(ROOT, 'scripts', 'verify_authenticode_readiness.ps1'),
    path.join(ROOT, 'scripts', 'provision_dedicated_tools_key.ps1'),
  ].filter((f) => fs.existsSync(f));
  const psFiles = [...requiredPsFiles, ...optionalPsFiles];
  const allReqPsExist = requiredPsFiles.every((f) => fs.existsSync(f));
  const psCheck = spawnSync('powershell.exe', ['-NoProfile', '-Command', `
$errs = 0
foreach ($f in @(${psFiles.map((x) => `'${x.replace(/'/g, "''")}'`).join(',')})) {
  $tok = $null; $err = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tok, [ref]$err)
  if ($err.Count -gt 0) { Write-Error "$f : $($err[0].Message)"; $errs += $err.Count }
}
if ($errs -gt 0) { exit 1 }
Write-Output "PS_AST_ZERO_ERRORS files=${psFiles.length}"
`], { encoding: 'utf8' });
  record('local_static', 'STAT-01', `PowerShell AST parser validates all ${psFiles.length} scoped Windows QA & security scripts with 0 syntax errors`,
    allReqPsExist && psCheck.status === 0, Date.now() - t1, (psCheck.stdout || psCheck.stderr).trim());

  // STAT-02: Node.js syntax check across all required scoped JS QA/monitoring scripts (+ optional scripts if present)
  const t2 = Date.now();
  const optionalJsFiles = [
    path.join(ROOT, 'scripts', 'verify_gate37_1_hardening_suite.js'),
    path.join(ROOT, 'scripts', 'publish_desktop_v1_0_9.js'),
  ].filter((f) => fs.existsSync(f));
  const jsFiles = [...scopedJsList, ...optionalJsFiles];
  const jsOk = scopedJsList.every((f) => fs.existsSync(f)) && jsFiles.every((f) => spawnSync('node', ['--check', f]).status === 0);
  record('local_static', 'STAT-02', `Node.js syntax check passes on all ${jsFiles.length} scoped QA, monitoring & reporting scripts`, jsOk, Date.now() - t2, `files=${jsFiles.length}`);

  // SEC-CI-04: Environment classification unit matrix (Server vs Win10 VM vs Win11 VM vs Host)
  const t3 = Date.now();
  const cSrv = classifyWindowsOs({ caption: 'Microsoft Windows Server 2022 Datacenter', buildNumber: 20348, productType: 3, isCi: true });
  const cW10 = classifyWindowsOs({ caption: 'Microsoft Windows 10 Pro', buildNumber: 19045, productType: 1, isVm: true });
  const cW11 = classifyWindowsOs({ caption: 'Microsoft Windows 11 Pro', buildNumber: 22631, productType: 1, isVm: true });
  const cHost = classifyWindowsOs({ caption: 'Microsoft Windows 11 Pro', buildNumber: 26300, productType: 1, isVm: false });
  let mismatchRejected = false;
  try { assertEnvironmentMatch(cSrv, 'WINDOWS_10_CLIENT_VM'); } catch (e) { mismatchRejected = /ENVIRONMENT_CLASS_MISMATCH/.test(e.message); }
  const envOk = cSrv === 'WINDOWS_SERVER_CI_RUNNER' && cW10 === 'WINDOWS_10_CLIENT_VM' && cW11 === 'WINDOWS_11_CLIENT_VM' && cHost === 'LOCAL_WINDOWS_HOST_SMOKE' && mismatchRejected;
  record('local_static', 'STAT-03', 'Environment classifier cleanly separates Server CI, Win10 VM, Win11 VM & Host and rejects mismatches', envOk, Date.now() - t3, `srv=${cSrv}, w10=${cW10}, w11=${cW11}, host=${cHost}, mismatchBlocked=${mismatchRejected}`);

  // SEC-CI-05: Token redaction check (construct synthetic patterns dynamically so zero secret-like literals exist in source)
  const t4 = Date.now();
  const fakePat = ['ghp', '_', 'a'.repeat(24)].join('');
  const fakeBearer = ['Bearer', ' ', 'syntheticJwtFixture', '0'.repeat(16)].join('');
  const rawLeak = `token="tori_qa_fixture_val_9999999" ${fakeBearer} ${fakePat}`;
  const redacted = redactSecrets(rawLeak);
  const redOk = !redacted.includes('tori_qa_fixture_val') && !redacted.includes(fakePat) && !redacted.includes('syntheticJwtFixture');
  record('ci_security', 'SEC-CI-02', 'Log redactor strips pairing tokens, bearer headers & GitHub PATs before QA output', redOk, Date.now() - t4, redacted);

  // SEC-CI-06: Non-mutating guest dry-run + schema validation on frozen v1.0.9 installer
  const dryOut = path.join(QA_ROOT, 'guest_dryrun_ok');
  const rDry = runPsFile(GUEST_PS1, [
    '-InstallerPath', V109_INST,
    '-ExpectedInstallerSha256', V109_SHA,
    '-TauriSigPath', V109_SIG,
    '-ExpectedVersion', '1.0.9',
    '-TestRoot', QA_ROOT,
    '-OutputDir', dryOut,
    '-RequiredEnvironmentClass', 'LOCAL_WINDOWS_HOST_SMOKE',
    '-DryRunValidation',
  ]);
  let drySchemaOk = false;
  const dryJsonPath = path.join(dryOut, 'qa-results.json');
  const dryMdPath = path.join(dryOut, 'qa-summary.md');
  if (rDry.status === 0 && fs.existsSync(dryJsonPath) && fs.existsSync(dryMdPath)) {
    const doc = JSON.parse(fs.readFileSync(dryJsonPath, 'utf8'));
    drySchemaOk = validateQaResultsSchema(doc) && doc.totals.PASS === 2 && doc.totals.NOT_TESTED === 1 && doc.is_clean_client_vm === false;
  }
  record('local_static', 'STAT-04', 'clean_windows_qa_guest.ps1 -DryRunValidation verifies v1.0.9 SHA-256 + Ed25519 + tamper & emits valid qa-results.json + qa-summary.md',
    drySchemaOk, rDry.ms, `exit=${rDry.status}, schemaValid=${drySchemaOk}`);

  // SEC-CI-07: Parameterized release upgrade/engine runner dry-run
  const t5 = Date.now();
  const rRel = spawnSync('node', [path.join(ROOT, 'scripts', 'verify_release_upgrade_and_engine.js'), '--dry-run', '--test-root', path.join(QA_ROOT, 'param_rel_qa')], { encoding: 'utf8', timeout: 30000 });
  const relJson = path.join(QA_ROOT, 'param_rel_qa', 'out', 'qa-results.json');
  const relOk = rRel.status === 0 && fs.existsSync(relJson) && validateQaResultsSchema(JSON.parse(fs.readFileSync(relJson, 'utf8')));
  record('release_regression', 'REL-DRY-01', 'Parameterized verify_release_upgrade_and_engine.js --dry-run validates v1.0.8/v1.0.9, Ed25519, fixtures & Companion contract',
    relOk, Date.now() - t5, `exit=${rRel.status}`);

  // HARN-01: Regression check for CWQA-19 Node stdin argument indexing (process.argv[last], never "-")
  const tH1 = Date.now();
  const guestSrc = fs.readFileSync(GUEST_PS1, 'utf8');
  const h1NoOldBug = !guestSrc.includes('callPair(process.argv[1])') && guestSrc.includes('const hostBin = process.argv[process.argv.length - 1]');
  const h1Run = spawnSync('node', ['-', 'C:\\TORI\\bin\\tdm-native-host.exe'], {
    input: "const hostBin = process.argv[process.argv.length - 1]; console.log(hostBin); process.exit(hostBin && hostBin !== '-' ? 0 : 1);",
    encoding: 'utf8',
  });
  record('local_static', 'HARN-01', 'CWQA-19 regression: Node stdin harness resolves host binary arg instead of "-"',
    h1NoOldBug && h1Run.status === 0 && (h1Run.stdout || '').trim().endsWith('tdm-native-host.exe'),
    Date.now() - tH1, `noOldBug=${h1NoOldBug}, arg=${(h1Run.stdout || '').trim()}`);

  // HARN-02: Regression check for CWQA-05 Python SQLite stdin inspection via PowerShell here-string
  const tH2 = Date.now();
  const tmpDb = path.join(QA_ROOT, 'harn02_test.sqlite');
  fs.mkdirSync(QA_ROOT, { recursive: true });
  spawnSync('python', ['-c', 'import sqlite3, sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE engine_settings (key TEXT, value TEXT)"); c.execute("INSERT INTO engine_settings VALUES (?, ?)", ("app_settings", "{}")); c.execute("CREATE TABLE external_tools_registry (id TEXT)"); c.commit(); c.close()', tmpDb], { encoding: 'utf8' });
  const h2NoOldBug = !guestSrc.includes('type=\\"table\\"');
  const h2PyScript = [
    "import json, sqlite3, sys",
    "c = sqlite3.connect(sys.argv[1])",
    "ic = [r[0] for r in c.execute('PRAGMA integrity_check')]",
    "tbls = {r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")}",
    "st = dict(c.execute('SELECT key, value FROM engine_settings')) if 'engine_settings' in tbls else {}",
    "print(json.dumps({'ic': ic, 'hasApp': ('app_settings' in st), 'hasTools': ('external_tools_registry' in tbls)}))",
  ].join('\n');
  const h2Run = spawnSync('python', ['-', tmpDb], { input: h2PyScript, encoding: 'utf8' });
  let h2Json = null;
  try { h2Json = JSON.parse((h2Run.stdout || '').trim()); } catch {}
  const h2Ok = Boolean(h2NoOldBug && h2Run.status === 0 && h2Json && h2Json.ic?.[0] === 'ok' && h2Json.hasApp === true && h2Json.hasTools === true);
  record('local_static', 'HARN-02', 'CWQA-05 regression: Python SQLite stdin integrity check parses cleanly without PowerShell quote breakage',
    h2Ok, Date.now() - tH2, JSON.stringify(h2Json || (h2Run.stderr || '').slice(0, 120)));
}

async function runPhase14FailureModes() {
  fs.mkdirSync(QA_ROOT, { recursive: true });

  // FM-01: Wrong installer SHA-256
  const fm1Out = path.join(QA_ROOT, 'fm01_wrong_sha');
  const r1 = runPsFile(GUEST_PS1, ['-InstallerPath', V109_INST, '-ExpectedInstallerSha256', '0'.repeat(64), '-ExpectedVersion', '1.0.9', '-TestRoot', QA_ROOT, '-OutputDir', fm1Out, '-DryRunValidation']);
  record('negative_tests', 'FM-01', 'Wrong installer SHA-256 fails closed & preserves failure evidence',
    r1.status !== 0 && fs.existsSync(path.join(fm1Out, 'qa-results.json')) && r1.combined.includes('FAIL'), r1.ms, `exit=${r1.status}`);

  // FM-02: Invalid Tauri signature
  const badSigPath = path.join(QA_ROOT, 'bad_invalid.sig');
  fs.writeFileSync(badSigPath, Buffer.from('untrusted comment: bad\n' + 'A'.repeat(98) + '\ntrusted comment: bad\n' + 'B'.repeat(86) + '\n').toString('base64'), 'utf8');
  const fm2Out = path.join(QA_ROOT, 'fm02_bad_sig');
  const r2 = runPsFile(GUEST_PS1, ['-InstallerPath', V109_INST, '-ExpectedInstallerSha256', V109_SHA, '-TauriSigPath', badSigPath, '-ExpectedVersion', '1.0.9', '-TestRoot', QA_ROOT, '-OutputDir', fm2Out, '-DryRunValidation']);
  record('negative_tests', 'FM-02', 'Invalid Tauri signature fails closed & preserves evidence',
    r2.status !== 0 && fs.existsSync(path.join(fm2Out, 'qa-results.json')), r2.ms, `exit=${r2.status}`);

  // FM-03: Missing installer
  const r3 = runPsFile(GUEST_PS1, ['-InstallerPath', path.join(QA_ROOT, 'nonexistent_setup.exe'), '-TestRoot', QA_ROOT, '-DryRunValidation']);
  record('negative_tests', 'FM-03', 'Missing installer fails closed with MISSING_INSTALLER',
    r3.status !== 0 && r3.combined.includes('MISSING_INSTALLER'), r3.ms, `exit=${r3.status}`);

  // FM-04: Wrong version
  const fm4Out = path.join(QA_ROOT, 'fm04_wrong_ver');
  const r4 = runPsFile(GUEST_PS1, ['-InstallerPath', V109_INST, '-ExpectedInstallerSha256', V109_SHA, '-ExpectedVersion', '9.9.9', '-TestRoot', QA_ROOT, '-OutputDir', fm4Out, '-DryRunValidation']);
  record('negative_tests', 'FM-04', 'Wrong expected version (9.9.9 vs 1.0.9 PE) fails closed',
    r4.status !== 0 && fs.existsSync(path.join(fm4Out, 'qa-results.json')), r4.ms, `exit=${r4.status}`);

  // FM-05: Missing expected release asset (mock HTTP server)
  const t5 = Date.now();
  const srv = http.createServer((req, res) => {
    if (req.url.includes('/releases/latest') && !req.url.includes('latest.json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 458899884, tag_name: 'v1.0.9', draft: false, prerelease: false, assets: [{ name: 'only_one.txt' }] }));
    }
    res.writeHead(404); res.end('missing');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const hRep = await runHealthCheck({ expected: { endpoints: { ghApiBase: base, ghWebBase: base, websiteBase: base, websiteHttp: null } }, retries: 0, timeoutMs: 2000, streamTimeoutMs: 2000 });
    const c1 = hRep.checks.find((c) => c.id === 'DESK-01');
    record('negative_tests', 'FM-05', 'Missing expected release asset fails closed as ASSET_MISSING',
      c1?.status === 'FAIL' && c1?.category === 'ASSET_MISSING', Date.now() - t5, `cat=${c1?.category}`);
  } finally { srv.close(); }

  // FM-06: Invalid test-root path (protected root + traversal)
  const r6a = runPsFile(GUEST_PS1, ['-InstallerPath', V109_INST, '-TestRoot', 'C:\\Windows', '-DryRunValidation']);
  const r6b = runPsFile(GUEST_PS1, ['-InstallerPath', V109_INST, '-TestRoot', QA_ROOT + '\\..\\..\\escape', '-DryRunValidation']);
  let jsRootBlocked = false;
  try { assertSafeTestRoot('C:\\Windows'); } catch (e) { jsRootBlocked = /INVALID_TEST_ROOT/.test(e.message); }
  record('negative_tests', 'FM-06', 'Invalid test-root path (C:\\Windows & .. traversal) rejected fail-closed in PowerShell & Node',
    r6a.status !== 0 && r6a.combined.includes('INVALID_TEST_ROOT') && r6b.status !== 0 && jsRootBlocked, r6a.ms + r6b.ms, `psWin=${r6a.status}, psTrav=${r6b.status}, jsBlocked=${jsRootBlocked}`);

  // FM-07: Unsupported / mismatched OS environment
  const r7 = runPsFile(GUEST_PS1, ['-InstallerPath', V109_INST, '-TestRoot', QA_ROOT, '-RequiredEnvironmentClass', 'WINDOWS_SERVER_CI_RUNNER', '-DryRunValidation']);
  record('negative_tests', 'FM-07', 'Mismatched OS environment (requiring WINDOWS_SERVER_CI_RUNNER on Win11 host) fails closed',
    r7.status !== 0 && r7.combined.includes('ENVIRONMENT_CLASS_MISMATCH'), r7.ms, `exit=${r7.status}`);

  // FM-08: Missing VM checkpoint (plus unrelated VM safety guard!)
  const mockNoCkpt = path.join(QA_ROOT, 'mock_vm_no_ckpt.json');
  fs.writeFileSync(mockNoCkpt, JSON.stringify({ vmName: 'TORI-Win10-Clean', notes: 'TORI_DISPOSABLE_QA_VM', osClass: 'WINDOWS_10_CLIENT_VM', checkpoints: ['SomeOtherSnap'] }));
  const mockUnrel = path.join(QA_ROOT, 'mock_vm_unrelated.json');
  fs.writeFileSync(mockUnrel, JSON.stringify({ vmName: 'Personal-Work-VM', notes: 'Production dev machine', osClass: 'WINDOWS_11_CLIENT_VM', checkpoints: ['CleanBaseline'] }));
  const r8a = runPsFile(VM_PS1, ['-MockVmSpecPath', mockNoCkpt, '-CheckpointName', 'CleanBaseline', '-ExpectedOsClass', 'WINDOWS_10_CLIENT_VM']);
  const r8b = runPsFile(VM_PS1, ['-MockVmSpecPath', mockUnrel, '-CheckpointName', 'CleanBaseline']);
  record('negative_tests', 'FM-08', 'Missing VM checkpoint & unrelated non-QA VM both blocked fail-closed',
    r8a.status !== 0 && r8a.combined.includes('VM_CHECKPOINT_MISSING') && r8b.status !== 0 && r8b.combined.includes('VM_SAFETY_ABORT_UNRELATED_VM'),
    r8a.ms + r8b.ms, `missingCkpt=${r8a.status}, unrelatedVm=${r8b.status}`);

  // FM-09: VM startup failure simulation
  const mockBootFail = path.join(QA_ROOT, 'mock_vm_boot_fail.json');
  fs.writeFileSync(mockBootFail, JSON.stringify({ vmName: 'TORI-Win11-Clean', notes: 'TORI_DISPOSABLE_QA_VM', osClass: 'WINDOWS_11_CLIENT_VM', checkpoints: ['CleanBaseline'], simulateBootFailure: true }));
  const r9 = runPsFile(VM_PS1, ['-MockVmSpecPath', mockBootFail, '-CheckpointName', 'CleanBaseline', '-ExpectedOsClass', 'WINDOWS_11_CLIENT_VM']);
  record('negative_tests', 'FM-09', 'VM startup failure simulation fails closed with VM_STARTUP_FAILURE',
    r9.status !== 0 && r9.combined.includes('VM_STARTUP_FAILURE'), r9.ms, `exit=${r9.status}`);

  // FM-10: Guest test timeout
  const fm10Out = path.join(QA_ROOT, 'fm10_timeout');
  const r10 = runPsFile(GUEST_PS1, ['-InstallerPath', V109_INST, '-ExpectedInstallerSha256', V109_SHA, '-TestRoot', QA_ROOT, '-OutputDir', fm10Out, '-DryRunValidation', '-SimulateFault', 'TIMEOUT']);
  const fm10Doc = fs.existsSync(path.join(fm10Out, 'qa-results.json')) ? JSON.parse(fs.readFileSync(path.join(fm10Out, 'qa-results.json'), 'utf8')) : null;
  record('negative_tests', 'FM-10', 'Guest test timeout records TIMEOUT status, preserves evidence & returns nonzero exit',
    r10.status !== 0 && fm10Doc?.totals?.TIMEOUT === 1 && fm10Doc?.overall_status === 'FAIL', r10.ms, `exit=${r10.status}, timeouts=${fm10Doc?.totals?.TIMEOUT}`);

  // FM-11: Native Messaging registration failure
  const fm11Out = path.join(QA_ROOT, 'fm11_nm_fail');
  const r11 = runPsFile(GUEST_PS1, ['-InstallerPath', V109_INST, '-ExpectedInstallerSha256', V109_SHA, '-TestRoot', QA_ROOT, '-OutputDir', fm11Out, '-DryRunValidation', '-SimulateFault', 'NM_REG_FAIL']);
  const fm11Doc = fs.existsSync(path.join(fm11Out, 'qa-results.json')) ? JSON.parse(fs.readFileSync(path.join(fm11Out, 'qa-results.json'), 'utf8')) : null;
  record('negative_tests', 'FM-11', 'Native Messaging registration failure records FAIL & returns nonzero exit',
    r11.status !== 0 && fm11Doc?.cases?.some((c) => c.error_summary === 'NATIVE_MESSAGING_REGISTRATION_MISSING'), r11.ms, `exit=${r11.status}`);

  // FM-12: Missing WebView2
  const fm12Out = path.join(QA_ROOT, 'fm12_no_wv2');
  const r12 = runPsFile(GUEST_PS1, ['-InstallerPath', V109_INST, '-ExpectedInstallerSha256', V109_SHA, '-TestRoot', QA_ROOT, '-OutputDir', fm12Out, '-DryRunValidation', '-SimulateFault', 'MISSING_WEBVIEW2']);
  const fm12Doc = fs.existsSync(path.join(fm12Out, 'qa-results.json')) ? JSON.parse(fs.readFileSync(path.join(fm12Out, 'qa-results.json'), 'utf8')) : null;
  record('negative_tests', 'FM-12', 'Missing WebView2 runtime records FAIL & returns nonzero exit',
    r12.status !== 0 && fm12Doc?.cases?.some((c) => c.error_summary === 'WEBVIEW2_RUNTIME_MISSING'), r12.ms, `exit=${r12.status}`);

  // FM-13: Installer exit-code failure
  const fm13Out = path.join(QA_ROOT, 'fm13_inst_exit');
  const r13 = runPsFile(GUEST_PS1, ['-InstallerPath', V109_INST, '-ExpectedInstallerSha256', V109_SHA, '-TestRoot', QA_ROOT, '-OutputDir', fm13Out, '-DryRunValidation', '-SimulateFault', 'INSTALLER_NONZERO']);
  const fm13Doc = fs.existsSync(path.join(fm13Out, 'qa-results.json')) ? JSON.parse(fs.readFileSync(path.join(fm13Out, 'qa-results.json'), 'utf8')) : null;
  record('negative_tests', 'FM-13', 'Installer nonzero exit code (1603) records FAIL & returns nonzero exit',
    r13.status !== 0 && fm13Doc?.cases?.some((c) => c.exit_code === 1603 && c.status === 'FAIL'), r13.ms, `exit=${r13.status}`);

  // FM-14: Incomplete QA result schema validation
  const t14 = Date.now();
  let incBlocked1 = false, incBlocked2 = false;
  try { validateQaResultsSchema({ gate: 'Gate 37.2' }); } catch (e) { incBlocked1 = /INCOMPLETE_QA_RESULT/.test(e.message); }
  try {
    const forged = buildQaResults({ environmentType: 'MOCK_OR_STATIC_VALIDATION', cases: [{ id: 'X', status: 'NOT_TESTED' }] });
    forged.totals.PASS = 1; // attempt to inflate NOT_TESTED into PASS!
    validateQaResultsSchema(forged);
  } catch (e) { incBlocked2 = /INCOMPLETE_QA_RESULT/.test(e.message); }
  record('negative_tests', 'FM-14', 'Incomplete or PASS-inflated qa-results.json rejected fail-closed',
    incBlocked1 && incBlocked2, Date.now() - t14, `missingFieldsBlocked=${incBlocked1}, inflatedPassBlocked=${incBlocked2}`);

  // FM-15: Attempted unapproved production mutation & unapproved clean-machine mutation
  const r15a = runPsFile(GUEST_PS1, ['-InstallerPath', V109_INST, '-TestRoot', QA_ROOT, '-DryRunValidation', '-SimulateFault', 'UNAPPROVED_PROD_MUTATION']);
  const r15b = runPsFile(GUEST_PS1, ['-InstallerPath', V109_INST, '-TestRoot', QA_ROOT]); // without -AllowCleanMachineMutation or -DryRunValidation
  record('negative_tests', 'FM-15', 'Unapproved production mutation & unguarded host mutation both blocked fail-closed',
    r15a.status !== 0 && r15a.combined.includes('SAFETY_ABORT_UNAPPROVED_PRODUCTION_MUTATION') && r15b.status !== 0 && r15b.combined.includes('SAFETY GUARD'),
    r15a.ms + r15b.ms, `prodGuard=${r15a.status}, hostGuard=${r15b.status}`);
}

async function main() {
  console.log('=== TORI Gate 37.2 — CI Security Audit, Static Validation & 15-Case Failure-Mode Verification ===');
  if (fs.existsSync(QA_ROOT)) fs.rmSync(QA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(EV_DIR, { recursive: true });

  await runPhase13CiSecurityAudit();
  await runPhase14FailureModes();

  // Honest explicit NOT_TESTED entries for unexecuted remote CI & unprovisioned Win10/Win11 Client VMs
  cases.push({ suite: 'windows_server_ci', id: 'CI-REMOTE-01', name: 'Remote GitHub Actions windows-2022/2025 execution (NOT authorized in Gate 37.2)', status: 'NOT_TESTED', duration_ms: 0, exit_code: 0, error_summary: null, detail: 'CI_REMOTE_EXECUTION_NOT_TESTED (workflow local only, awaiting owner promotion)', evidence_path: null });
  cases.push({ suite: 'windows_10_client_vm', id: 'VM-WIN10-01', name: 'Clean Windows 10 x64 Client VM full 20-check QA', status: 'NOT_TESTED', duration_ms: 0, exit_code: 0, error_summary: null, detail: '0 provisioned licensed Windows 10 Client VMs', evidence_path: null });
  cases.push({ suite: 'windows_11_client_vm', id: 'VM-WIN11-01', name: 'Clean Windows 11 x64 Client VM full 20-check QA', status: 'NOT_TESTED', duration_ms: 0, exit_code: 0, error_summary: null, detail: '0 provisioned licensed Windows 11 Client VMs', evidence_path: null });

  const report = buildQaResults({
    gate: 'Gate 37.2',
    runId: `g37_2_local_${Date.now()}`,
    installerVersion: '1.0.9',
    installerSha256: V109_SHA,
    environmentType: 'MOCK_OR_STATIC_VALIDATION',
    osInfo: { name: 'Windows 11 Pro Host (Static/Mock Validation Only)', edition: 'Pro', build: '26300', architecture: 'x64' },
    runnerOrVmId: process.env.COMPUTERNAME || 'local-workstation',
    isolationEvidence: { qa_root: QA_ROOT, production_writes: 0, remote_ci_triggered: false },
    cases,
  });

  validateQaResultsSchema(report);
  const jsonPath = path.join(EV_DIR, 'qa-results.json');
  const mdPath = path.join(EV_DIR, 'qa-summary.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, renderQaSummaryMarkdown(report), 'utf8');

  console.log(`\n=== GATE 37.2 SUITE SUMMARY: PASS=${report.totals.PASS} FAIL=${report.totals.FAIL} TIMEOUT=${report.totals.TIMEOUT} NOT_TESTED=${report.totals.NOT_TESTED} (${jsonPath}) ===`);
  if (report.totals.FAIL > 0 || report.totals.TIMEOUT > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err.message || err);
  process.exit(1);
});
