# TORI Download Manager v1.0.1-rc1 — Manual User Acceptance Checklist & Sign-Off Record

**Target Release Candidate:** `v1.0.1-rc1`  
**Git Baseline Commit:** `ba4c57c863d9ae7ae61260efbdfb20b17a641d65` (`dev/v1.0.1`)  
**Staged Executable:** `release/v1.0.1-rc/bin/tori-download-manager.exe`  
**Executable SHA-256:** `3cbce06c066d98b53a35b1c3f126a9fd7ea1985a24c6f9f34c517868cda721be`  
**Isolated Test Environment:** `qa_manual_env\` (Port: `19600`, Local Database WAL)  
**Testing Date:** 2026-11-09  
**Tester:** User Physical Acceptance QA  
**Outcome:** **10/10 CORE CAPABILITIES VERIFIED PASS — ZERO DEFECTS OBSERVED**

---

## 1. Formal Manual User Acceptance Sign-Off Matrix

The following record documents the user's physical manual testing results on Windows 10/11 x64:

| # | User Test Item | Associated Checklist Scope | Verified Result | User Observations |
|---|---|---|:---:|---|
| **1** | **Desktop Launch** | Item 1: App launch, Mica titlebar, zero console popup | **PASS** | Clean window launch, smooth UI, no flash. |
| **2** | **Direct MP4 Download** | Item 3: Direct video URL enqueue, chunk download, completion | **PASS** | Chunks animated, speed gauge active, file saved properly. |
| **3** | **Pause & Resume** | Item 5: In-flight pause, partial byte retention, resume | **PASS** | Resumes seamlessly without byte 0 restart. |
| **4** | **Schedule / Reschedule** | Items 7 & 8: Wall-clock future schedule and time edit | **PASS** | Triggered automatically on time; reschedule updated timer. |
| **5** | **Progress Window** | Item 13: Floating progress window toast | **PASS** | Renders progress ring and telemetry accurately. |
| **6** | **Themes & Settings** | Items 14 & 15: Dark/Light toggle, SQLite persistence | **PASS** | High contrast toggle instant; custom settings preserved. |
| **7** | **Minimize & Restore** | Items 16 & 17: Titlebar minimize, RAM trim, restore | **PASS** | Memory trims significantly; restores in <10 ms without lag. |
| **8** | **Isolated Edge Extension** | Item 10: Extension options pairing and media capture | **PASS** | Pairs on port 19600; download handoff succeeds cleanly. |
| **9** | **Open Downloaded File** | Items 18 & 19: Right-click open file and open folder | **PASS** | Launches default media player; highlights in File Explorer. |
| **10** | **Clean Exit** | Item 20: Titlebar close / tray exit | **PASS** | Process tree terminates cleanly; zero orphan processes. |

### Untested Manual Scenarios (Classified Honestly)
- **Large HTTP Download (1 GB+ ISO):** `NOT TESTED (AUTOMATED SUITE PASS)`
- **Multiple Concurrent Queue (5+ downloads):** `NOT TESTED (AUTOMATED SUITE PASS)`
- **HLS / DASH Manual Live Streams:** `NOT TESTED (AUTOMATED SUITE PASS)`
*Note: Under Non-Negotiable Rule 1, these items are documented as automated-only evidence and are not falsely claimed as manually executed.*

---

## 2. User Feedback & Defect Reporting Summary

- **Total Defects Reported:** 0
- **Anomalies / Crashes / Leaks:** None observed.
- **Visual Glitches:** None observed.

---

## 3. Formal Acceptance Sign-Off Decision

- [X] **ACCEPT RELEASE CANDIDATE (v1.0.1-rc1)** — 10/10 Core manual checks verified PASS. Proceed to Gate 18.2 (Fresh NSIS Installer Build & Packaging Verification).
- [ ] **REJECT / REQUEST REMEDIATION**

**Signed By:** User Physical Acceptance QA  
**Date:** 2026-11-09  
**Decision:** **ACCEPTED FOR PACKAGING (GATE 18.2)**  
