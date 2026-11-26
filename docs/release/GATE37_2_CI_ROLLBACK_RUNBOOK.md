# TORI Download Manager — Gate 37.2 CI Workflow & QA Infrastructure Rollback Runbook

**Gate:** Gate 37.2 — Clean Windows 10/11 QA Infrastructure & GitHub Actions CI Integration  
**Current Remote State:** `origin/master` is **UNTOUCHED** (`62715926785da3fd7da811da997279931cc5cad0`); `.github/workflows/clean-windows-release-qa.yml` is NOT yet active remotely.

---

## 1. Rollback Principles

1. **Zero Production Release Impact:** Because `clean-windows-release-qa.yml` holds strictly read-only permissions (`contents: read`), zero signing keys, and zero publish/deploy steps, disabling or reverting the CI workflow has **zero effect** on Desktop `v1.0.9` (`458899884`), Companion `v1.0.11` (`458864802`), `toridownload.xyz`, or External Tools manifest revision 2 (`caa2d4ed...`).
2. **Preserve Daily Expiry Monitoring:** Never break or delete `.github/workflows/tools-manifest-expiry-monitor.yml` when rolling back `clean-windows-release-qa.yml`.
3. **Never Force-Push `master`:** Always revert cleanly via a forward `git revert` commit (or GitHub UI disable workflow) to preserve full audit history.

---

## 2. Rollback Procedures (Post-Promotion Only)

### Fast Containment — Disable Workflow Without Touching Git History
1. Open **GitHub → Actions → Windows Server Release Smoke QA (Manual Preflight — Not Client Win10/11 VM QA)**.
2. Click **`...` → Disable workflow** (cancels future manual dispatches immediately).
3. Cancel any in-progress runs if experiencing runaway retries or misconfigured inputs.

### Clean Git Rollback on `master`
```powershell
# Identify the merge commit that promoted Gate 37.2 to master, then cleanly revert:
git checkout master
git pull --ff-only origin master
git revert -m 1 <MERGE_COMMIT_SHA>   # or `git revert <COMMIT_SHA>` for squash merge
git push origin master
```
Verify immediately after revert:
1. `.github/workflows/tools-manifest-expiry-monitor.yml` remains active and passes a manual `workflow_dispatch` check.
2. Public Desktop `v1.0.9`, Companion `v1.0.11`, website `toridownload.xyz`, and tools manifest rev 2 pass `node scripts/verify_gate37_1_production_health.js`.

### Local Hyper-V Client VM Rollback
- If a guest QA run aborts mid-flight on `TORI-Win10-Clean` or `TORI-Win11-Clean`, preserve any retrieved failure evidence in `target/clean_vm_qa_reports/`, then restore the immutable clean snapshot:
  ```powershell
  Stop-VM -Name "TORI-Win10-Clean" -Force -TurnOff -ErrorAction SilentlyContinue
  Restore-VMSnapshot -VMName "TORI-Win10-Clean" -Name "CleanBaseline" -Confirm:$false
  ```
- Never delete the `CleanBaseline` checkpoint.
