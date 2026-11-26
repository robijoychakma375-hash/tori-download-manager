# TORI Download Manager — Gate 37.3 Scoped Pull Request Security Review

**Target Pull Request:** `robijoychakma375-hash/tori-download-manager#1` (`Draft`)  
**PR URL:** `https://github.com/robijoychakma375-hash/tori-download-manager/pull/1`  
**Base → Head:** `master` (`62715926785da3fd7da811da997279931cc5cad0`) ← `ci/gate37_3-clean-windows-qa-pr`  
**Review Mode:** Read-Only Security & Code Review (Zero Merge, Zero Approval on Owner's Behalf, Zero CI Execution)  
**Review Verdict:** **PASS — ZERO BLOCKING SECURITY FINDINGS**

---

## 1. Remote Workflow Trigger Safety Audit (Phase 1)

| Remote Surface Audited | Observed Live State | Trigger Risk |
| :--- | :--- | :---: |
| `.github/workflows/tools-manifest-expiry-monitor.yml` on `origin/master` | `on: schedule (0 6 * * *)` + `workflow_dispatch` only | **CLEAR** |
| Proposed `.github/workflows/clean-windows-release-qa.yml` | `on: workflow_dispatch` only (zero `push`, `pull_request`, `pull_request_target`, `schedule`, `workflow_run`) | **CLEAR** |
| Proposed `.github/workflows/tools-manifest-expiry-monitor.yml` | Preserves `schedule` + `workflow_dispatch` only | **CLEAR** |
| Branch Protection / Rulesets / Webhooks / Third-Party CI | `protected: false`, `rulesets: 0`, `hooks: 0`, `check-runs` on PR HEAD: `0` | **CLEAR** |
| Post-Push & Post-PR Actions Runs | Top run remained unchanged `45657403685` (`2026-11-25T16:45:38Z`) | **0 TRIGGERED** |

**Classification:** **`REMOTE_TRIGGER_RISK_CLEAR`**

---

## 2. Pull Request Security Audit Matrix (Phase 6 & Phase 12)

| # | Security Control | Verification Method | Status |
| :-: | :--- | :--- | :---: |
| 1 | Least-Privilege Token Scope | Both workflows declare top-level `permissions: { contents: read }`; `actions/checkout` explicitly sets `persist-credentials: false`. | **PASS** |
| 2 | Zero Production Secrets / Signing Keys | Zero `secrets.*` references in either workflow; zero private keys or tokens in diff (`SECRET_SCAN: 0 hits`). | **PASS** |
| 3 | Expression / Shell Injection Prevention | Zero `${{ inputs.* }}` or `${{ github.event.* }}` inside `run:` blocks in BOTH workflows (`SEC-CI-01` AST check); all inputs pass via `env:` and are regex-validated fail-closed; artifact name derived from validated step output `steps.prepare.outputs.artifact_name`. | **PASS** |
| 4 | Supply-Chain Action Pinning | All 3 official Actions pinned to full 40-char commit SHAs verified live (`HTTP 200`) via GitHub API: `actions/checkout@11d5960a326750d5838078e36cf38b85af677262`, `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`, `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02`. | **PASS** |
| 5 | Pre-Execution Binary Integrity | Downloaded installers are verified for exact 64-hex SHA-256 AND independent Tauri Ed25519 signature (`CDC23D8CC8DA5397`) + 1-byte tamper rejection BEFORE execution (`FM-01`, `FM-02`). | **PASS** |
| 6 | Path Traversal & Host Mutation Protection | `Test-SafeTestRootPath` / `assertSafeTestRoot` blocks `..`, drive roots, `C:\Windows`, `Program Files`, and user profiles (`FM-06`); guest script aborts without `-AllowCleanMachineMutation` or `-DryRunValidation` (`FM-15`). | **PASS** |
| 7 | Hyper-V VM Isolation & Snapshot Safety | `run_clean_windows_vm_qa.ps1` blocks non-QA VMs (`VM_SAFETY_ABORT_UNRELATED_VM`), blocks missing `CleanBaseline` checkpoint (`VM_CHECKPOINT_MISSING`), never deletes checkpoints, verifies post-transfer SHA-256 inside guest, and restores snapshot in `finally` (`FM-08`, `FM-09`). | **PASS** |
| 8 | Bounded Timeouts & Concurrency | Job timeouts capped (`25` min / `10` min), per-test timeout (`90s`, `FM-10`), `concurrency` group set, artifact retention capped at `30` days. | **PASS** |
| 9 | Honest Reporting & Anti-Inflation | `validateQaResultsSchema` rejects missing fields or inflating `NOT_TESTED`/`SKIP` into `PASS` (`FM-14`); Windows Server runners strictly labeled `WINDOWS_SERVER_CI_RUNNER` (`FM-07`). | **PASS** |
| 10 | Token Redaction in Logs & Reports | `redactSecrets` / `Redact-LogText` strips pairing tokens, Bearer tokens, and GitHub PATs (`SEC-CI-02`). | **PASS** |

---

## 3. Code Review Findings Table (Phase 12)

| Finding ID | Severity | Area | Observation & Disposition |
| :--- | :---: | :--- | :--- |
| `REV-373-01` | Low (Fixed pre-push) | Artifact Naming (`clean-windows-release-qa.yml`) | Replaced raw `${{ inputs.release_version }}` in `upload-artifact` `name:` with validated `steps.prepare.outputs.artifact_name` + safe fallback so malformed inputs cannot disrupt failure-artifact upload. **RESOLVED.** |
| `REV-373-02` | Medium (Fixed pre-push) | Guest VM Ed25519 Closure (`run_clean_windows_vm_qa.ps1`) | Isolated Hyper-V guests lacked `src-tauri/tauri.conf.json` needed by `verify_pe_authenticode.ps1`, and default `-OutputDir` was hardcoded to `F:\TORI\...`. Added `tauri.conf.json` transfer to guest workdir and derived default `-OutputDir` from `$PSScriptRoot`. **RESOLVED.** |
| `REV-373-03` | Medium (Fixed pre-push) | Scoped `master` Compatibility (`verify_release_upgrade_and_engine.js`) | `NM-01` previously assumed `extension/firefox/manifest.json` exists in repo checkout (absent on `master`). Added SHA-256-verified frozen Companion `v1.0.11` ZIP/XPI inspection with honest `NOT_TESTED` fallback when `release/` is absent. **RESOLVED.** |
| `REV-373-04` | Info (Accepted) | Local Linter Tooling | `actionlint` is `NOT_INSTALLED` locally; `PyYAML 6.0.3` AST + custom CI policy auditor (`SEC-CI-01`) + live GitHub API SHA verification executed instead. **DOCUMENTED.** |
| `REV-373-05` | Info (Accepted) | Repo Branch Protection | `master` currently has `protected: false` and `rulesets: 0`; owner should consider enabling branch protection in a separate governance step (out of Gate 37.3 scope). **DOCUMENTED.** |
