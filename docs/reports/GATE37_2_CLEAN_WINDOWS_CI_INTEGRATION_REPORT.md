# TORI Download Manager — Gate 37.2 Clean Windows 10/11 QA Infrastructure & GitHub Actions CI Integration Report

**Gate:** Gate 37.2 — Clean Windows 10/11 QA Infrastructure & GitHub Actions CI Integration  
**Date:** 2026-11-26  
**Source Baseline:** `9066a2faa24e43eb19df07a0bcb50ad1036a15cc` (`checkpoint-gate37_1-production-hardening-verified`)  
**Local Implementation Branch:** `feat/gate37_2-clean-windows-ci-integration` *(LOCAL ONLY — NOT PUSHED)*  
**Public Release / Remote CI Activation / Branch Push:** **NOT AUTHORIZED / NOT PERFORMED (`0` remote writes)**  
**Final Verdict:** **`CONDITIONAL GO`** *(All local CI security hardening, SHA-pinned workflow design, reusable guest/VM/upgrade harnesses, `qa-results.json` v2 reporting, static AST/YAML checks, and all 15 failure-mode negative tests PASSED; genuine Windows 10/11 Client VM execution remains `NOT_TESTED` [`0` licensed client VMs provisioned] and remote GitHub Actions CI remains `CI_REMOTE_EXECUTION_NOT_TESTED` pending explicit Owner Approvals A–F.)*

---

## 1. Executive Summary & Architectural Hardening Completed

Gate 37.2 upgraded TORI's local Clean Windows QA and GitHub Actions CI infrastructure into a release-independent, security-hardened, fail-closed framework anchored on Desktop `v1.0.9` and reusable for future Desktop versions without hardcoded assumptions:

| Component | Path | Key Gate 37.2 Hardening Improvements | Status |
| :--- | :--- | :--- | :---: |
| Hardened CI Workflow | `.github/workflows/clean-windows-release-qa.yml` | SHA-pinned Actions (`checkout@11d5960a`, `setup-node@49933ea5`, `upload-artifact@ea165f8d`), `persist-credentials: false`, `permissions: contents: read`, zero `secrets.`, **zero `${{ inputs.* }}` inside `run:`**, fail-closed regex input validation, pre-execution SHA-256 + Ed25519 + tamper checks, `server-smoke` & `server-upgrade-smoke` profiles, explicit `WINDOWS_SERVER_CI_RUNNER` labeling, 30-day artifact retention | **LOCAL READY** (`REMOTE_CI_NOT_EXECUTED`) |
| Expiry Monitor Hardening | `.github/workflows/tools-manifest-expiry-monitor.yml` | Hardened locally to eliminate `${{ inputs.strict_exit }}` shell interpolation, SHA-pin all 3 official actions, add `persist-credentials: false` & `timeout-minutes: 10` *(remote `origin/master` untouched)* | **LOCAL READY** |
| Shared QA Reporter Library | `scripts/qa_report_lib.js` | Canonical 5 environment classes (`WINDOWS_SERVER_CI_RUNNER`, `WINDOWS_10_CLIENT_VM`, `WINDOWS_11_CLIENT_VM`, `LOCAL_WINDOWS_HOST_SMOKE`, `MOCK_OR_STATIC_VALIDATION`), 6 strict statuses (`PASS`/`FAIL`/`SKIP`/`TIMEOUT`/`NOT_TESTED`/`BLOCKED`), schema & PASS-inflation validator, safe test-root guard, pairing-token/PAT redactor, `qa-results.json` + `qa-summary.md` generator | **VERIFIED** |
| Hardened Clean Guest Harness | `scripts/clean_windows_qa_guest.ps1` | Safe test-root path enforcement, strict `-RequiredEnvironmentClass` mismatch guard, pre-execution SHA-256 + PE Authenticode + Tauri Ed25519 verification, per-test timeouts, `tdm-cli.exe` check, Chrome/Edge/Firefox manifest JSON validation, 4x concurrent native-host pairing with token redaction, honest `SKIP`/`NOT_TESTED` for non-interactive UI, standardized `qa-results.json` + `qa-summary.md`, `-DryRunValidation` & fault hooks | **VERIFIED** |
| Hardened Hyper-V VM Runner | `scripts/run_clean_windows_vm_qa.ps1` | Strict disposable VM designation guard (`^TORI-(Win10|Win11)-` or `TORI_DISPOSABLE_QA_VM`), checkpoint existence check (`CleanBaseline`, never deleted), OS class validation, post-transfer guest SHA-256 verification before execution, failure-evidence retention, guaranteed snapshot restoration, `-MockVmSpecPath` negative testing | **VERIFIED** (`0` Client VMs provisioned) |
| Parameterized Release Runner | `scripts/verify_release_upgrade_and_engine.js` | Version-parameterized `baseline -> target` (`v1.0.8 -> v1.0.9` default), deterministic Content-Range fixture hash manifest (`7` cases), Companion `v1.0.11` manifest contract check, standardized `qa-results.json` output | **VERIFIED** |
| CI Security & 15-Case Failure Suite | `scripts/verify_gate37_2_ci_and_qa_suite.js` | Deep PyYAML AST security audit, PowerShell AST parse (`5` scripts), Node syntax (`6` scripts), environment classifier, token redaction, non-mutating guest dry-run, and **all 15 mandatory Phase 14 failure modes (`FM-01`..`FM-15`)** | **22 / 22 PASS** |

---

## 2. Executed Verification Results (Separated Honestly by Category)

| Category | Executed Suite | PASS | FAIL | TIMEOUT | NOT_TESTED | Evidence / Log Path |
| :--- | :--- | ---: | ---: | ---: | ---: | :--- |
| **Local Static Validation** | `STAT-01..04` (PowerShell AST `5/5`, Node syntax `6/6`, env classifier, guest `-DryRunValidation` + `qa-results.json` schema) | **4** | 0 | 0 | 0 | `target/gate37_2_evidence/qa-results.json` |
| **CI Security Audit** | `SEC-CI-01..02` (PyYAML 6.0.3 AST + zero injection + SHA-pinning + read-only perms + log redactor; `actionlint` `NOT_INSTALLED` documented) | **2** | 0 | 0 | 0 | `target/gate37_2_qa_logs/01_ci_security_and_15_failure_modes.log` |
| **Release Regression (Dry-Run)** | `REL-DRY-01` (Parameterized `v1.0.8`/`v1.0.9` provenance, Ed25519 + tamper, 7 Content-Range fixtures, Companion `v1.0.11` contract) | **1** | 0 | 0 | 0 | `target/gate37_2_qa_work/param_rel_qa/out/qa-results.json` |
| **15-Case Failure Modes (Phase 14)** | `FM-01..FM-15` (wrong SHA, bad sig, missing installer, wrong version, missing asset, bad test-root/traversal, mismatched OS, missing checkpoint & unrelated VM, VM startup failure, timeout, NM reg fail, missing WebView2, installer exit 1603, incomplete/PASS-inflated report, unapproved prod/host mutation) | **15** | 0 | 0 | 0 | `target/gate37_2_evidence/qa-results.json` |
| **Gate 37.1 Regression Check** | `verify_gate37_1_hardening_suite.js` (9 production-health negative modes + mock Stage 1 renewal + rollback dry-run + CI) | **16** | 0 | 0 | 0 | `target/gate37_2_qa_logs/02_gate37_1_regression.log` |
| **Authenticode & Ed25519 Check** | `verify_authenticode_readiness.ps1` (`signtool 10.0.26100.0`, fail-closed exit `4`, `v1.0.9` `NotSigned`, Ed25519 valid & tamper-rejected) | **1** | 0 | 0 | 0 | `target/gate37_2_qa_logs/03_authenticode_check.log` |
| **Windows Server CI Remote Execution** | `CI-REMOTE-01` (GitHub Actions `windows-2022` / `windows-2025`) | 0 | 0 | 0 | **1** | `CI_REMOTE_EXECUTION_NOT_TESTED` (local only) |
| **Windows 10 Client VM QA** | `VM-WIN10-01` | 0 | 0 | 0 | **1** | `NOT_TESTED` (`0` licensed Win10 VMs) |
| **Windows 11 Client VM QA** | `VM-WIN11-01` | 0 | 0 | 0 | **1** | `NOT_TESTED` (`0` licensed Win11 VMs) |

---

## 3. Production, Storage & Operator OEM Preservation

- **Public Production Untouched (`0` remote writes):** Desktop `v1.0.9` (ID `458899884`, `460f5da0...`), Browser Companion `v1.0.11` (ID `458864802`, Firefox XPI `4cd6d6fb...`, Chromium ZIP `1e77592b...`), `origin/master` (`62715926...`), `toridownload.xyz` (`8b11dde1...`), and External Tools manifest rev 2 (`caa2d4ed...`, Stage 2 disabled).
- **Operator OEM Untouched:** Installed OEM Desktop `v1.0.6` (`570833b3...`), OEM SQLite (`4a2d7771...`, `ok`, `56` downloads, `531` chunks, `7` settings), `21/21` `.tdm-part` files, HKCU `NativeMessagingHosts` keys, and `0` stray `tori-download-manager` processes.
- **Disk Space:** `C: = 61.68 GB` free, `F: = 38.11 GB` free (no unnecessary Rust rebuild performed).
- **Secret Scan:** **CLEAN (`0` secret matches)** across all Gate 37.2 workflows, scripts, docs, and generated JSON/Markdown reports.

---

## 4. Explicit Owner Authorization Checkpoint (Permissions A–F — All Currently UNGRANTED)

Execution stops cleanly here before any remote mutation. Future activation requires separate explicit owner approval for each item (detailed in `docs/release/GATE37_2_CI_PROMOTION_AND_ACTIVATION_RUNBOOK.md`):

- **A.** Push `feat/gate37_2-clean-windows-ci-integration` (or scoped CI branch) to GitHub.
- **B.** Open a reviewed pull request targeting `master`.
- **C.** Merge the reviewed CI workflow & helper scripts into `master`.
- **D.** Manually trigger `workflow_dispatch` on Windows Server CI Smoke (`windows-2022` / `windows-2025`).
- **E.** Provision licensed `TORI-Win10-Clean` and `TORI-Win11-Clean` Hyper-V Client VMs (`CleanBaseline`) and execute `scripts/run_clean_windows_vm_qa.ps1`.
- **F.** Register or configure self-hosted runners (only if separately elected later).

---

## 5. Final Verdict & Next Recommended Gate

- **Final Verdict:** **`CONDITIONAL GO`** — Local Clean Windows QA infrastructure, SHA-pinned CI workflow, parameterized release upgrade/engine/Native Messaging harnesses, security review, and all 15 failure-mode tests are complete and verified (`39/39` executed local checks PASS, `0` FAIL); full Clean Windows OS certification remains honestly `NOT_TESTED` pending Owner Approvals A–E.
- **Next Recommended Gate:** **Gate 37.3 — Owner-Authorized GitHub CI Promotion & First Live Windows Server Smoke Dispatch (Permissions A–D), Clean Windows 10/11 Hyper-V VM Execution (Permission E), and Offline Dedicated Key Backup Verification (`RISK-36-01`)**.
