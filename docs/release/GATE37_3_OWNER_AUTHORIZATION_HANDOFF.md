# TORI Download Manager — Gate 37.3 Owner Authorization Handoff

**Gate Completed:** Gate 37.3 — Scoped GitHub CI Promotion & Pull Request Review (Permissions A+B Only)  
**Draft Pull Request:** `https://github.com/robijoychakma375-hash/tori-download-manager/pull/1`  
**Scoped Branch:** `ci/gate37_3-clean-windows-qa-pr`  
**Local Checkpoint Tag (NOT PUSHED):** `checkpoint-gate37_3-scoped-ci-pr-created`

---

## 1. Permission Status Matrix

| Permission | Scope | Gate 37.3 Status |
| :--- | :--- | :---: |
| **Permission A** | Push narrowly scoped CI integration branch (`ci/gate37_3-clean-windows-qa-pr`) to GitHub | **AUTHORIZED & EXECUTED** |
| **Permission B** | Open Draft Pull Request (`#1`) targeting `master` with security review & evidence | **AUTHORIZED & EXECUTED** |
| **Permission C** | Mark PR `#1` Ready for Review and merge into `master` | **NOT AUTHORIZED (AWAITING OWNER)** |
| **Permission D** | Trigger first live `workflow_dispatch` on `Windows Server Release Smoke QA` (`windows-2022` / `windows-2025`) | **NOT AUTHORIZED (AWAITING OWNER)** |
| **Permission E** | Provision licensed Windows 10 & Windows 11 Hyper-V Client VMs (`TORI-Win10-Clean`, `TORI-Win11-Clean`, `CleanBaseline`) and execute `scripts/run_clean_windows_vm_qa.ps1` | **NOT AUTHORIZED (AWAITING OWNER)** |
| **Permission F** | Register or configure self-hosted runners (optional / not required initially) | **NOT AUTHORIZED (AWAITING OWNER)** |

---

## 2. Exact Next Steps Available for Owner Authorization

> **Approving one permission never implies approval of any other permission.**

### Next Step 1 — Owner Review & Merge of PR #1 (**Requires Explicit Permission C**)
1. Inspect Draft PR `#1` (`https://github.com/robijoychakma375-hash/tori-download-manager/pull/1`) and review `docs/security/GATE37_3_SCOPED_PR_SECURITY_REVIEW.md` and `docs/release/GATE37_3_CI_PR_MERGE_READINESS.md`.
2. Verify zero unrelated product/release/manifest changes exist in the PR diff.
3. Explicitly authorize marking PR `#1` ready and merging into `master` (normal merge commit or squash merge; never force-push `master`).
4. Confirm `.github/workflows/tools-manifest-expiry-monitor.yml` continues succeeding on its daily `06:00 UTC` schedule.

### Next Step 2 — First Controlled Windows Server CI Smoke Run (**Requires Explicit Permission D**, After Permission C)
1. Manually trigger `workflow_dispatch` on `.github/workflows/clean-windows-release-qa.yml` from `master` with pinned Desktop `v1.0.9` inputs:
   - `release_version`: `1.0.9`
   - `release_tag`: `v1.0.9`
   - `expected_sha256`: `460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead`
   - `target_qa_profile`: `server-upgrade-smoke`
   - `previous_version`: `1.0.8`
   - `previous_expected_sha256`: `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb`
   - `run_updater_smoke`: `true`
   - `require_authenticode`: `false`
2. Inspect uploaded `qa-results.json`, `qa-summary.md`, and `signature_verification.json` artifacts for both `windows-2022` and `windows-2025` (confirming `environment_type == "WINDOWS_SERVER_CI_RUNNER"`, `FAIL == 0`, `TIMEOUT == 0`, and honest `SKIP` for non-interactive UI checks).

### Next Step 3 — Clean Windows 10 & Windows 11 Client VM QA (**Requires Explicit Permission E**)
- Provision owner-licensed `TORI-Win10-Clean` (Windows 10 x64 22H2) and `TORI-Win11-Clean` (Windows 11 x64 23H2/24H2) Hyper-V VMs with immutable `CleanBaseline` checkpoints and execute `scripts/run_clean_windows_vm_qa.ps1` per `docs/qa/GATE37_2_WINDOWS10_WINDOWS11_CLIENT_VM_QA_PLAN.md`.

### Separate Operational Security Tracks (Outside Gate 37.3)
- **`RISK-36-01` (Offline Key Backup):** Mount dedicated offline encrypted media and run `provision_dedicated_tools_key.ps1 -Mode VerifyBackup` on `feat/gate37_1-production-hardening` / offline workstation before ever considering Stage 2 signing.
- **`RISK-36-03` (Authenticode):** Onboard commercial EV/OV or SignPath Foundation Cloud HSM certificate when ready.
- **External Tools Manifest Revision 3 Renewal:** Schedule Stage 1 metadata renewal ahead of `2027-01-21T19:46:42.049Z` (`56+` days remaining).
