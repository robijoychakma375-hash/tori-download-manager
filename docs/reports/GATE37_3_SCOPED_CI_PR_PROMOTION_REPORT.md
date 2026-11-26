# TORI Download Manager — Gate 37.3 Scoped GitHub CI Promotion & Draft PR Report

**Gate:** Gate 37.3 — Scoped GitHub CI Promotion & Pull Request Review (Owner-Authorized Permissions A+B Only)  
**Date:** 2026-11-26  
**Final Verdict:** **`GO (Permissions A+B Completed Safely)`**  
**Default Branch Merge Readiness:** **`MERGE_REVIEW_READY`** *(NOT MERGED — Permission C NOT AUTHORIZED)*

---

## 1. Authority & Lineage Summary

| Field | Verified Value |
| :--- | :--- |
| **Owner Permissions Executed** | **Permission A** (Scoped Branch Push) & **Permission B** (Draft Pull Request Creation) |
| **Owner Permissions NOT Authorized** | **Permission C** (Merge PR), **Permission D** (`workflow_dispatch` CI Run), **Permission E** (Win10/11 VM Provisioning), **Permission F** (Self-Hosted Runners) |
| **Gate 37.2 Source Commit (Intact)** | `04540805d86193f10cf94c1dbabfe6dcdd29e9cb` (`feat/gate37_2-clean-windows-ci-integration`, `checkpoint-gate37_2-clean-windows-ci-local-prepared`) |
| **Current Remote `origin/master` SHA** | `62715926785da3fd7da811da997279931cc5cad0` *(UNTOUCHED — `protected: false`, `rulesets: 0`)* |
| **Scoped Integration Branch** | `ci/gate37_3-clean-windows-qa-pr` *(derived directly from `origin/master`)* |
| **Initial Scoped PR Commit** | `41edc1a61b49697eccdf41bfdf028e1c4d45076d` (`15` CI/QA/doc files, `+2922 / -8`) |
| **Remote Branch URL** | `https://github.com/robijoychakma375-hash/tori-download-manager/tree/ci/gate37_3-clean-windows-qa-pr` |
| **Pull Request** | **PR #1** — `https://github.com/robijoychakma375-hash/tori-download-manager/pull/1` (`state: open`, `draft: true`, `mergeable: true`, `mergeable_state: clean`) |
| **Remote Workflow Trigger Audit** | **`REMOTE_TRIGGER_RISK_CLEAR`** — `0` workflows triggered on push; `0` workflows or check runs triggered on PR creation (latest repo run remains `45657403685` from `2026-11-25T16:45:38Z`) |

---

## 2. Scoped Change Inventory & Dependency Closure

Instead of merging Gate 37.2's full Desktop/extension history into `master`, `ci/gate37_3-clean-windows-qa-pr` was created cleanly from `origin/master` (`62715926...`) containing ONLY approved CI workflows, required QA dependencies, and review documentation:

| Category | Files Included | Dependency Closure Justification |
| :--- | :--- | :--- |
| **Required CI Workflow** | `.github/workflows/clean-windows-release-qa.yml` | Manual-only (`workflow_dispatch`) Windows Server (`windows-2022`/`windows-2025`) smoke workflow; read-only perms, SHA-pinned actions, `persist-credentials: false`, zero `secrets.`, zero `${{ inputs.* }}` inside `run:`, validated artifact name output. |
| **Existing Workflow Security Hardening** | `.github/workflows/tools-manifest-expiry-monitor.yml` | Preserves exact daily `0 6 * * *` UTC schedule, `workflow_dispatch`, `strict_exit`, `scripts/monitor_tools_manifest_expiry.js`, thresholds & 30d artifact; pins all 3 official actions to verified 40-char SHAs, sets `persist-credentials: false` & `timeout-minutes: 10`, and moves `${{ inputs.strict_exit }}` / `${{ github.event_name }}` out of `run:` into `env:`. |
| **Required QA Dependencies** | `scripts/verify_pe_authenticode.ps1`, `scripts/clean_windows_qa_guest.ps1`, `scripts/run_clean_windows_vm_qa.ps1`, `scripts/qa_report_lib.js`, `scripts/verify_gate37_1_production_health.js`, `scripts/verify_release_upgrade_and_engine.js` | Every script referenced by `clean-windows-release-qa.yml`, guest/VM harnesses, rollback checks, and local `require('./...')` imports resolves cleanly against `origin/master` (`src-tauri/tauri.conf.json` already provides updater pubkey `CDC23D8CC8DA5397`; `scripts/monitor_tools_manifest_expiry.js` is already identical on `origin/master`). |
| **Test-Only Dependency** | `scripts/verify_gate37_2_ci_and_qa_suite.js` | Local static AST/YAML/security/dependency-closure (`DEP-01`) + 15-case fail-closed negative test suite (`FM-01..FM-15`). |
| **Required Documentation** | `docs/qa/GATE37_2_WINDOWS_SERVER_CI_TEST_PLAN.md`, `docs/qa/GATE37_2_WINDOWS10_WINDOWS11_CLIENT_VM_QA_PLAN.md`, `docs/security/GATE37_2_CI_WORKFLOW_SECURITY_REVIEW.md`, `docs/release/GATE37_2_CI_PROMOTION_AND_ACTIVATION_RUNBOOK.md`, `docs/release/GATE37_2_CI_ROLLBACK_RUNBOOK.md`, `docs/reports/GATE37_2_CLEAN_WINDOWS_CI_INTEGRATION_REPORT.md` + Gate 37.3 review/readiness/handoff/report docs | Complete audit trail, security review, rollback instructions, and owner authorization gate. |
| **Unrelated Files** | **0** | Zero Rust/UI/Desktop/extension code, zero release binaries, zero signing keys, zero SQLite/OEM files, zero version bumps, zero website files. |

### Dependency Closure Fixes Identified & Applied During Scoped Integration
1. **Included `scripts/verify_pe_authenticode.ps1` & `scripts/verify_gate37_1_production_health.js`** (absent on `origin/master`, required directly by `clean-windows-release-qa.yml`, `clean_windows_qa_guest.ps1`, `verify_release_upgrade_and_engine.js`, and `FM-05`).
2. **Hyper-V Guest Ed25519 Closure (`scripts/run_clean_windows_vm_qa.ps1`):** Added transfer of `src-tauri/tauri.conf.json` into the isolated guest workdir (`C:\ToriCleanQA\src-tauri\tauri.conf.json`) and derived default `-OutputDir` from `$PSScriptRoot` instead of hardcoding a local drive path.
3. **Scoped Branch Companion Contract Check (`scripts/verify_release_upgrade_and_engine.js`):** When `extension/firefox/manifest.json` is absent on `master` (since extension source is intentionally excluded), `NM-01` verifies the SHA-256-matched frozen `v1.0.11` Chromium ZIP & Mozilla-signed Firefox XPI manifests directly (or records honest `NOT_TESTED` when `release/` is absent).
4. **Automated Workflow-to-Script Closure Test (`DEP-01` in `scripts/verify_gate37_2_ci_and_qa_suite.js`):** Parses both workflows and all scoped JS modules to guarantee `missing=0` on every checkout.

---

## 3. Executed Local Verification Results (On Scoped Branch `ci/gate37_3-clean-windows-qa-pr`)

| Check / Suite | Result | Details |
| :--- | :---: | :--- |
| `node scripts/verify_gate37_2_ci_and_qa_suite.js` | **23 / 23 PASS** | `0` FAIL, `0` TIMEOUT, `3` honest `NOT_TESTED` (`CI-REMOTE-01`, `VM-WIN10-01`, `VM-WIN11-01`). Includes `SEC-CI-01`, `DEP-01` (`missing=0`), `STAT-01` (`3/3` PS AST), `STAT-02` (`5/5` JS syntax), `STAT-03`, `SEC-CI-02`, `STAT-04`, `REL-DRY-01`, and `FM-01..FM-15`. |
| Live GitHub API Action SHA Verification | **3 / 3 HTTP 200** | `actions/checkout@11d5960a...` (`2026-07-16`), `actions/setup-node@49933ea5...` (`2025-04-02`), `actions/upload-artifact@ea165f8d...` (`2025-03-19`). |
| `scripts/verify_pe_authenticode.ps1 -TestTamperRejection` | **PASS** | `v1.0.9` SHA-256 `460f5da0...` match, Ed25519 valid (`CDC23D8CC8DA5397`), 1-byte tamper rejected, Authenticode honestly `NotSigned`. |
| `scripts/run_clean_windows_vm_qa.ps1 -AuditOnly` | **PASS** | Hyper-V `Running`, `0` provisioned client VMs, `C: 61.69 GB` free, `F: 38.12 GB` free. |
| `actionlint` | **`NOT_INSTALLED`** | Documented honestly; `PyYAML 6.0.3` AST + strict CI policy auditor executed as fallback. |
| Secret Scan | **CLEAN (`0` hits)** | Scanned all scoped files + `qa-results.json` + `qa-summary.md` (`0` secret matches). |

---

## 4. Post-PR Live Production & Operator Preservation Audit (Phase 14)

Verified via read-only live checks AFTER Permission A push and Permission B Draft PR creation:

- **`origin/master`:** `62715926785da3fd7da811da997279931cc5cad0` (**UNTOUCHED**).
- **Public Desktop:** `v1.0.9` (GitHub Latest Stable, Release ID `458899884`, `16` assets, `SHA256SUMS.txt` confirms `460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead`).
- **Public Browser Companion:** `extension-v1.0.11` (Release ID `458864802`, live Firefox Signed XPI SHA-256 `4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd`, live Chromium ZIP SHA-256 `1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559`).
- **Production External Tools Manifest:** Revision `2` (`toridownload.xyz/assets/tools/tools-manifest.json`, signer `CDC23D8CC8DA5397`, SHA-256 `caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`, Stage 2 dedicated-only signing **`DISABLED`**).
- **Official Website (`tori-website`):** Clean on `main` (`330846d19333a9b98bea83d52bf95c2c3a4a1eef`), zero Cloudflare deployments.
- **Operator OEM Installation & Data:** Installed OEM Desktop `v1.0.6` (`570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda`), SQLite `tdm_storage.sqlite` (`4a2d77719d965d651e9fdb0fb84777b20a0eeb4d4482715673400ff125ce9f66`, `PRAGMA integrity_check=ok`, `56` downloads, `531` `download_chunks`, `7` `engine_settings`), `21` `.tdm-part` files, HKCU `NativeMessagingHosts` (`Chrome=True`, `Edge=True`, `Mozilla=True`), `0` stray processes.

---

## 5. Remaining Operational Blockers & Next Gate

- **Unresolved Blockers (External / Future Gates):**
  1. Remote Windows Server CI execution (`CI_REMOTE_EXECUTION_NOT_TESTED` — awaits Permissions C & D).
  2. Clean Windows 10 & Windows 11 Client VM QA (`NOT_TESTED` — `0` licensed VMs provisioned; awaits Permission E).
  3. Windows PE Authenticode (`NotSigned` — awaits commercial EV/OV certificate onboarding, `RISK-36-03`).
  4. Offline dedicated signing-key backup verification (`RISK-36-01` — awaits owner offline backup check).
  5. Local `actionlint` binary `NOT_INSTALLED`.
- **Next Recommended Gate:** **Gate 37.4 — Owner Review & Merge of Draft PR #1 (Permission C) and First Controlled Windows Server CI Smoke `workflow_dispatch` (Permission D)**.
