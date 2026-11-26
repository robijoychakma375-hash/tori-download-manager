# TORI Download Manager — Gate 37.2 GitHub Actions CI & QA Harness Security Review

**Gate:** Gate 37.2 — Clean Windows 10/11 QA Infrastructure & GitHub Actions CI Integration  
**Audited Files:**
- `.github/workflows/clean-windows-release-qa.yml`
- `.github/workflows/tools-manifest-expiry-monitor.yml`
- `scripts/clean_windows_qa_guest.ps1`
- `scripts/run_clean_windows_vm_qa.ps1`
- `scripts/qa_report_lib.js`
- `scripts/verify_pe_authenticode.ps1`
- `scripts/verify_release_upgrade_and_engine.js`

**Static Validation Tools Executed:** Python 3.13 `PyYAML 6.0.3` AST + custom security policy auditor (`SEC-CI-01`), PowerShell 5.1 Language AST Parser (`STAT-01`), Node.js v24.18 syntax checker (`STAT-02`), and 15-case fail-closed negative test suite (`FM-01`..`FM-15`).  
*Tooling Transparency Note:* `actionlint` is **`NOT_INSTALLED`** on the local workstation; full YAML AST parsing and strict security rule checks were executed via `PyYAML 6.0.3` as documented fallback.

---

## 1. Security Control Audit Matrix

| # | Threat / Control Area | Implemented Mitigation | Audit Result |
| :-: | :--- | :--- | :---: |
| 1 | Excessive GitHub Token Permissions | Both workflows declare top-level `permissions: { contents: read }`; `actions/checkout` explicitly sets `persist-credentials: false`. Zero `write` scopes. | **PASS** |
| 2 | Secret Exposure & Logging | Zero `secrets.*` references in either workflow; `qa_report_lib.js` (`redactSecrets`) and `clean_windows_qa_guest.ps1` (`Redact-LogText`) strip pairing tokens, bearer tokens, and GitHub PATs before output (`SEC-CI-02`). | **PASS** |
| 3 | Workflow Expression / Shell Injection | **Remediation caught & fixed in Gate 37.2:** Removed raw `${{ inputs.* }}` interpolation from `run:` blocks in BOTH `clean-windows-release-qa.yml` AND local `tools-manifest-expiry-monitor.yml`. All inputs pass solely via `env:` and are regex-validated fail-closed. | **PASS** |
| 4 | Supply-Chain Action Pinning | All third-party Actions pinned to verified 40-char immutable commit SHAs: `actions/checkout@11d5960a...`, `actions/setup-node@49933ea5...`, `actions/upload-artifact@ea165f8d...`. | **PASS** |
| 5 | Untrusted Binary Execution | Downloaded installers are never executed before BOTH exact 64-hex SHA-256 AND Tauri Ed25519 `.sig` + 1-byte tamper-rejection verification pass (`CWQA-INT-01/02`, `FM-01`, `FM-02`). | **PASS** |
| 6 | Path Traversal & Unsafe Cleanup | `assertSafeTestRoot` / `Test-SafeTestRootPath` rejects `..`, drive roots (`C:\`, `F:\`), `C:\Windows`, `Program Files`, `%USERPROFILE%`, `%APPDATA%`, `%LOCALAPPDATA%`, and paths outside designated disposable TORI QA roots (`FM-06`). | **PASS** |
| 7 | Unapproved Host / VM / Production Mutation | Guest harness aborts without `-AllowCleanMachineMutation` or `-DryRunValidation` (`FM-15`); Hyper-V orchestrator aborts on any VM not designated `^TORI-(Win10|Win11)-` / `TORI_DISPOSABLE_QA_VM` (`FM-08`); zero remote release/website/key writes. | **PASS** |
| 8 | Unintended Workflow Triggers | `clean-windows-release-qa.yml` triggers strictly on manual `workflow_dispatch`; `tools-manifest-expiry-monitor.yml` triggers only on `schedule` + `workflow_dispatch`. Zero `push`, `pull_request`, or `pull_request_target` triggers. | **PASS** |
| 9 | Unbounded Timeouts & Artifact Retention | Job timeout capped (`timeout-minutes: 25` / `10`), per-test process wait bounded (`-PerTestTimeoutSec 90`), `concurrency` group configured, artifact retention capped at `30` days. | **PASS** |
| 10 | Environment Misclassification & PASS Inflation | `assertEnvironmentMatch` rejects Server-vs-Client mismatches fail-closed (`FM-07`); `validateQaResultsSchema` rejects incomplete reports or inflating `NOT_TESTED`/`SKIP` into `PASS` (`FM-14`). | **PASS** |

---

## 2. Findings Caught & Remediated During Gate 37.2 Audit

1. **Expression Interpolation in `clean-windows-release-qa.yml` & `tools-manifest-expiry-monitor.yml`:** Replaced all `${{ inputs.* }}` inside `run:` blocks with `env:` bindings + strict regex validation.
2. **Unpinned `@v4` Action Tags:** Upgraded all `actions/checkout`, `actions/setup-node`, and `actions/upload-artifact` references to verified 40-char commit SHAs with `persist-credentials: false`.
3. **PowerShell 5.1 Inline `try` Expression Bug:** Caught during `STAT-04` execution on Windows PowerShell `5.1.26100.10068`; refactored `(try { ... } catch { "" })` into a clean statement block in `clean_windows_qa_guest.ps1`.
4. **Synthetic Fixture Secret Pattern in Test Code:** Caught by local secret scanner in `SEC-CI-02`; refactored synthetic redactor test fixtures to dynamic assembly so zero secret-like literals exist in source.
