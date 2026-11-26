# TORI Download Manager — Gate 37.2 CI Promotion & Activation Runbook (Owner-Gated)

**Gate:** Gate 37.2 — Clean Windows 10/11 QA Infrastructure & GitHub Actions CI Integration  
**Source Branch (LOCAL ONLY — NOT PUSHED):** `feat/gate37_2-clean-windows-ci-integration`  
**Target Default Branch (UNTOUCHED):** `origin/master` (`62715926785da3fd7da811da997279931cc5cad0`)  
**Remote CI Activation Status:** **`REMOTE_CI_NOT_EXECUTED` — STRICTLY GATED ON SEPARATE OWNER APPROVALS A–F BELOW**

---

## 1. Important GitHub Actions Promotion Constraint

GitHub Actions manual `workflow_dispatch` workflows generally **must exist on the repository default branch (`master`)** to appear in the Actions tab and accept manual dispatches. Storing `.github/workflows/clean-windows-release-qa.yml` solely on a local branch does **NOT** activate remote CI.

---

## 2. Reusable CI Promotion Package Inventory

| Category | Files Included | Security & Scope Notes |
| :--- | :--- | :--- |
| **Hardened Workflows** | `.github/workflows/clean-windows-release-qa.yml`, `.github/workflows/tools-manifest-expiry-monitor.yml` | `permissions: contents: read`, SHA-pinned Actions (`v4`), `persist-credentials: false`, zero `secrets.`, zero `${{ inputs.* }}` inside `run:`, manual `workflow_dispatch` (+ daily cron on expiry monitor) |
| **Clean Windows QA & Reporting Scripts** | `scripts/clean_windows_qa_guest.ps1`, `scripts/run_clean_windows_vm_qa.ps1`, `scripts/qa_report_lib.js`, `scripts/verify_pe_authenticode.ps1`, `scripts/verify_authenticode_readiness.ps1`, `scripts/verify_release_upgrade_and_engine.js`, `scripts/verify_gate37_2_ci_and_qa_suite.js` | Pre-exec SHA-256 + Ed25519 verification, safe disposable test-root enforcement, strict OS class validation, pairing-token redaction, 15/15 failure-mode checks verified |
| **Documentation & Runbooks** | `docs/qa/GATE37_2_WINDOWS_SERVER_CI_TEST_PLAN.md`, `docs/qa/GATE37_2_WINDOWS10_WINDOWS11_CLIENT_VM_QA_PLAN.md`, `docs/security/GATE37_2_CI_WORKFLOW_SECURITY_REVIEW.md`, `docs/release/GATE37_2_CI_PROMOTION_AND_ACTIVATION_RUNBOOK.md`, `docs/release/GATE37_2_CI_ROLLBACK_RUNBOOK.md`, `docs/reports/GATE37_2_CLEAN_WINDOWS_CI_INTEGRATION_REPORT.md` | Complete audit trail & rollback controls |

- **Required GitHub Permissions for Promotion:** Maintainer push/PR permissions (`workflow` token scope required by GitHub when pushing `.github/workflows/*.yml`).
- **Branch Protection Implications:** Promote strictly via a clean reviewed PR or cherry-picked CI-only branch onto `master` — **never** force-push `master` and preserve `.github/workflows/tools-manifest-expiry-monitor.yml`'s continuous daily UTC execution.
- **Estimated GitHub Actions Usage:** `windows-2022` + `windows-2025` manual dispatch ≈ 10–16 Windows runner minutes per invoked release check (`0` automatic push/PR minutes).

---

## 3. Explicit Owner Authorization Matrix (Separate Permissions A–F)

**NONE of A–F are authorized in Gate 37.2.** Approving one item does **NOT** authorize any other item:

- [ ] **Permission A — Push Branch:** Authorize `git push origin feat/gate37_2-clean-windows-ci-integration` (and/or a minimal scoped CI promotion branch containing only the workflow + helper scripts).
- [ ] **Permission B — Open Reviewed PR:** Authorize opening a pull request targeting `master` with full diff review.
- [ ] **Permission C — Merge CI Workflow to `master`:** Authorize merging the reviewed CI workflow & helper scripts into `master` (preserving `tools-manifest-expiry-monitor.yml` and Desktop/Companion/manifest state).
- [ ] **Permission D — Enable / Manually Trigger Remote CI Smoke Run:** Authorize running manual `workflow_dispatch` on `Windows Server Release Smoke QA` for Desktop `v1.0.9` (`460f5da0...`, `windows-2022` & `windows-2025`) and inspecting uploaded `qa-results.json` artifacts.
- [ ] **Permission E — Provision Licensed Windows 10 & Windows 11 Client VMs:** Authorize owner creation of licensed `TORI-Win10-Clean` and `TORI-Win11-Clean` Hyper-V VMs (`CleanBaseline`) and running `scripts/run_clean_windows_vm_qa.ps1`.
- [ ] **Permission F — Self-Hosted Runners (Optional / Not Required Initially):** Explicitly authorize only if the owner later elects to attach hardened self-hosted Windows 10/11 client runners (strictly isolated, never sharing production signing keys).

---

## 4. Future Execution Sequence (ONLY After Explicit Permissions A–D Are Granted)

```powershell
# Step 1 (Requires Permission A): Push reviewed branch — NEVER force-push!
git push origin feat/gate37_2-clean-windows-ci-integration

# Step 2 (Requires Permission B & C): Review diff and merge PR into master (preserve history; no force-push).

# Step 3 (Requires Permission D): Trigger manual workflow_dispatch via GitHub UI or API:
#   release_version: "1.0.9"
#   release_tag: "v1.0.9"
#   expected_sha256: "460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead"
#   target_qa_profile: "server-upgrade-smoke"
#   previous_version: "1.0.8"
#   previous_expected_sha256: "728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb"
#   run_updater_smoke: true
#   require_authenticode: false
```
Verify downloaded artifact `qa-results.json` confirms `environment_type == "WINDOWS_SERVER_CI_RUNNER"`, `FAIL == 0`, `TIMEOUT == 0`, and that `tools-manifest-expiry-monitor.yml` continues succeeding daily.
