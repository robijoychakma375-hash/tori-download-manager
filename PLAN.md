# TORI Download Manager v1.0.1 — Milestone Plan: Gate 18.3
## Real Windows Installation, Upgrade & Uninstall QA Preparation

### Objectives
1. Verify source and installer integrity on `dev/v1.0.1` (`c0a90ba`).
2. Forensically investigate and resolve the Rust test count discrepancy (Gate 17.6: 188 vs Gate 18.2: 105 vs Actual: 208).
3. Assemble dedicated portable installation QA package in `release/v1.0.1-installation-qa/`.
4. Establish separate-PC safety guidelines, checklists, and result report templates.
5. Strictly protect primary development PC, stable v1.0.0 (`C:\Program Files\Tori Download Manager`), and user AppData (`%APPDATA%\tori-download-manager`).
6. Classify separate-PC installation, functional testing, native messaging, upgrade, and uninstallation scenarios honestly as `NOT TESTED (AWAITING SEPARATE PC EXECUTION)`.
7. Deliver full engineering handoff report `GATE18_3_INSTALLATION_UPGRADE_UNINSTALL_QA_REPORT.md`.

---

### Specific Measurable Milestones

#### Milestone 1: Source & Installer Integrity (Task 1) — COMPLETED
- [x] Verified `dev/v1.0.1` branch and HEAD commit `c0a90ba`.
- [x] Confirmed working tree is clean on tracked files.
- [x] Verified `src-tauri/tauri.conf.json` is committed cleanly with version `1.0.1`.
- [x] Verified stable installed v1.0.0 on development PC remains untouched (`tdm.exe` timestamp 10/29/2026 19:06:24).
- [x] Verified installer SHA-256 matches release manifest: `DC00B7058503A5959B5A32083072F87546CE2A9D60C5366E30C6C7798B6B19E8`.
- [x] Verified updater Ed25519 signature cryptographically against public key (`updater_cryptography_tests.rs` 5/5 passing).

#### Milestone 2: Forensic Discrepancy Investigation (Task 1) — COMPLETED
- [x] Investigated why Gate 17.6 reported 188 tests and Gate 18.2 reported 105 tests.
- [x] Examined raw un-truncated test execution output in `.system_generated/steps/16579/output.txt`.
- [x] Confirmed 105 was an artifact of tool preview truncation (middle 39,688 bytes omitted from preview).
- [x] Confirmed actual test count was **208 passed tests across 28 test suites** (0 failed).
- [x] Confirmed 0 test binaries were skipped; zero test coverage was lost; coverage expanded from 188 to 208 tests with Gate 17.4.2 scheduler and recovery suites.

#### Milestone 3: Portable Installation QA Package Assembly (Task 2) — COMPLETED
- [x] Created `release/v1.0.1-installation-qa/`.
- [x] Copied verified fresh installer `TORI Download Manager_1.0.1_x64-setup.exe` (116,996,177 bytes).
- [x] Copied updater signature `TORI Download Manager_1.0.1_x64-setup.exe.sig` (436 bytes).
- [x] Copied sideloadable browser extension `tori-download-manager-extension-v1.0.1.zip` (68,945 bytes).
- [x] Copied `LICENSE` and `LICENSE-THIRD-PARTY.txt`.
- [x] Generated `SHA256SUMS.txt`.
- [x] Authored `INSTALLATION_INSTRUCTIONS.md` (fresh install walkthrough).
- [x] Authored `UPGRADE_TEST_INSTRUCTIONS.md` (upgrade walkthrough).
- [x] Authored `UNINSTALL_TEST_INSTRUCTIONS.md` (clean uninstallation walkthrough).
- [x] Authored `SEPARATE_PC_QA_CHECKLIST.md` (30-point QA verification matrix).
- [x] Authored `QA_RESULTS_TEMPLATE.md` (result report template).
- [x] Excluded all build caches, databases, credentials, and debug files.

#### Milestone 4: Safety & Scenario Classification (Tasks 3–8) — COMPLETED
- [x] Confirmed development PC must not execute the installer.
- [x] Confirmed Windows Sandbox and Hyper-V must not be used.
- [x] Formally classified separate-PC execution scenarios (Tasks 4–8) as `NOT TESTED (AWAITING SEPARATE PC EXECUTION)`.
- [x] Authored `GATE18_3_INSTALLATION_UPGRADE_UNINSTALL_QA_REPORT.md`.
