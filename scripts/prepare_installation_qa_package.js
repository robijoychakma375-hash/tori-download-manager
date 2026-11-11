const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'release', 'v1.0.1-installer-candidate');
const TARGET_DIR = path.join(ROOT, 'release', 'v1.0.1-installation-qa');

if (!fs.existsSync(TARGET_DIR)) {
  fs.mkdirSync(TARGET_DIR, { recursive: true });
}

console.log('--- Assembling Portable Installation QA Package ---');

const filesToCopy = [
  'TORI Download Manager_1.0.1_x64-setup.exe',
  'TORI Download Manager_1.0.1_x64-setup.exe.sig',
  'tori-download-manager-extension-v1.0.1.zip',
  'LICENSE',
  'LICENSE-THIRD-PARTY.txt',
];

const checksums = [];

for (const file of filesToCopy) {
  const src = path.join(SOURCE_DIR, file);
  const dst = path.join(TARGET_DIR, file);
  if (!fs.existsSync(src)) {
    throw new Error(`Source file missing: ${src}`);
  }
  fs.copyFileSync(src, dst);
  const buf = fs.readFileSync(dst);
  const hash = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
  checksums.push(`${hash}  ${file}`);
  console.log(`Copied: ${file} (${buf.length} bytes, sha256: ${hash})`);
}

fs.writeFileSync(path.join(TARGET_DIR, 'SHA256SUMS.txt'), checksums.join('\n') + '\n', 'utf8');
console.log('Generated SHA256SUMS.txt');

// 1. Installation Instructions
const installDoc = `# TORI Download Manager v1.0.1 â€” Fresh Installation Guide

**Target Environment:** Authorized Separate Windows 10/11 x64 PC
**Package:** \`TORI Download Manager_1.0.1_x64-setup.exe\`
**Checksum (SHA-256):** \`dc00b7058503a5959b5a32083072f87546ce2a9d60c5366e30c6c7798b6b19e8\`

---

## Pre-Installation Safety Checks

1. **Verify Windows Architecture:** Confirm Windows 10 (Build 19041+) or Windows 11 (64-bit AMD64).
2. **Confirm Approval:** Ensure the owner of the test PC has approved running this test.
3. **Check Existing Software:**
   - Check if TORI Download Manager is already installed in \`C:\\Program Files\\Tori Download Manager\` or \`C:\\Users\\<user>\\AppData\\Local\\Programs\\...\`.
   - If v1.0.0 is installed and you want to test **Fresh Installation**, choose a test machine without TORI or perform a backup before uninstalling.
   - If v1.0.0 is installed and you want to test **Upgrade**, follow \`UPGRADE_TEST_INSTRUCTIONS.md\`.
4. **Inspect Processes:** Open Task Manager and confirm no \`tori-download-manager.exe\` or \`tdm-native-host.exe\` processes are currently running.
5. **Disk Space:** Confirm at least 1 GB of free disk space is available on the target drive.

---

## Step-by-Step Installation Procedure

1. **Verify Installer Hash:**
   Open PowerShell in this directory and execute:
   \`\`\`powershell
   Get-FileHash -Algorithm SHA256 "TORI Download Manager_1.0.1_x64-setup.exe"
   \`\`\`
   Confirm the output matches: \`DC00B7058503A5959B5A32083072F87546CE2A9D60C5366E30C6C7798B6B19E8\`.

2. **Execute Installer:**
   - Double-click \`TORI Download Manager_1.0.1_x64-setup.exe\`.
   - **SmartScreen / UAC Warning:** Because this Release Candidate build uses a self-signed / development certificate (UNSIGNED Authenticode), Windows SmartScreen will display "Windows protected your PC". Click **More info** -> **Run anyway**. (Document this prompt in the QA report).
   - Follow the wizard prompts to install into the default location:
     \`C:\\Program Files\\Tori Download Manager\`

3. **Verify File Layout:**
   Confirm the following files exist in the installation directory:
   - \`C:\\Program Files\\Tori Download Manager\\tori-download-manager.exe\`
   - \`C:\\Program Files\\Tori Download Manager\\bin\\tdm-native-host.exe\`
   - \`C:\\Program Files\\Tori Download Manager\\bin\\tdm-cli.exe\`
   - \`C:\\Program Files\\Tori Download Manager\\bin\\ffmpeg.exe\`
   - \`C:\\Program Files\\Tori Download Manager\\bin\\ffprobe.exe\`
   - \`C:\\Program Files\\Tori Download Manager\\bin\\yt-dlp.exe\`
   - \`C:\\Program Files\\Tori Download Manager\\uninstall.exe\`

4. **Verify Windows Shortcuts:**
   - Confirm **Start Menu** entry exists: "TORI Download Manager".
   - Confirm Desktop shortcut exists if selected.

5. **Launch Application:**
   - Launch TORI Download Manager from the Start Menu shortcut.
   - Confirm application window opens without errors.
   - Navigate to **About** page: verify version string is strictly **1.0.1**.
`;

fs.writeFileSync(path.join(TARGET_DIR, 'INSTALLATION_INSTRUCTIONS.md'), installDoc, 'utf8');
console.log('Generated INSTALLATION_INSTRUCTIONS.md');

// 2. Upgrade Test Instructions
const upgradeDoc = `# TORI Download Manager v1.0.1 â€” In-Place Upgrade Test Guide

**Target Environment:** Authorized Separate Windows PC with existing TORI v1.0.0
**Package:** \`TORI Download Manager_1.0.1_x64-setup.exe\`

> [!CAUTION]
> Do NOT execute this upgrade test on the primary TORI development PC. Only run on an authorized separate PC.

---

## Pre-Upgrade Baseline Preservation

Before launching the v1.0.1 installer over an existing v1.0.0 installation:

1. **Close Existing TORI:**
   - Ensure TORI v1.0.0 is closed (check system tray and Task Manager).
2. **Create Backups:**
   Open PowerShell and execute:
   \`\`\`powershell
   $backupDir = "$env:USERPROFILE\\Desktop\\TORI_v100_Backup"
   New-Item -ItemType Directory -Path $backupDir -Force
   Copy-Item -Path "$env:APPDATA\\tori-download-manager\\*" -Destination $backupDir -Recurse -Force
   \`\`\`
3. **Record v1.0.0 Registry State:**
   \`\`\`powershell
   Get-ItemProperty "HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager" | Out-File "$backupDir\\registry_edge_v100.txt"
   \`\`\`
4. **Document Download History:**
   - Note down existing completed downloads, custom download directory, and configured settings.

---

## Upgrade Execution

1. Double-click \`TORI Download Manager_1.0.1_x64-setup.exe\`.
2. Proceed through the installer wizard without changing the destination folder.
3. Confirm installation completes without file-in-use errors.

---

## Post-Upgrade Verification Checklist

1. **Version Verification:** Launch TORI. Check **About** page: version must show **1.0.1**.
2. **Database Schema Migration:** Confirm SQLite migrated cleanly without errors (no crash on launch).
3. **History Retention:** Confirm all previously completed downloads and history from v1.0.0 appear in the table.
4. **Settings Retention:** Confirm custom download paths and settings are preserved.
5. **Download Integrity:** Confirm existing files on disk were not altered or deleted.
6. **Native Messaging Update:** Confirm registry points to the new \`tdm-native-host.exe\`.
`;

fs.writeFileSync(path.join(TARGET_DIR, 'UPGRADE_TEST_INSTRUCTIONS.md'), upgradeDoc, 'utf8');
console.log('Generated UPGRADE_TEST_INSTRUCTIONS.md');

// 3. Uninstall Test Instructions
const uninstallDoc = `# TORI Download Manager v1.0.1 â€” Uninstallation & Cleanup Test Guide

**Target Environment:** Authorized Separate Windows PC after v1.0.1 testing

---

## Step-by-Step Uninstallation Procedure

1. **Exit Application:**
   - Confirm TORI Download Manager is closed (exit from System Tray).
   - Confirm no \`tori-download-manager.exe\` or \`tdm-native-host.exe\` in Task Manager.

2. **Trigger Uninstaller:**
   - Open **Windows Settings** -> **Apps** -> **Installed apps** (or **Control Panel** -> **Programs and Features**).
   - Locate **TORI Download Manager**.
   - Click **Uninstall** and confirm prompts.
   - Alternatively, execute:
     \`\`\`powershell
     & "C:\\Program Files\\Tori Download Manager\\uninstall.exe"
     \`\`\`

3. **Verify Program Files Removal:**
   Confirm \`C:\\Program Files\\Tori Download Manager\` is cleanly removed (or contains only user-modified files if prompted).

4. **Verify Registry Removal:**
   Confirm Native Messaging registry keys are removed:
   \`\`\`powershell
   Test-Path "HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager"
   Test-Path "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager"
   \`\`\`
   Both should return **False**.

5. **Verify User Data Safety:**
   - Confirm downloaded files in \`Downloads\\...\` are **100% PRESERVED**.
   - The uninstaller must NEVER delete user downloads.
`;

fs.writeFileSync(path.join(TARGET_DIR, 'UNINSTALL_TEST_INSTRUCTIONS.md'), uninstallDoc, 'utf8');
console.log('Generated UNINSTALL_TEST_INSTRUCTIONS.md');

// 4. Manual QA Checklist
const checklistDoc = `# TORI Download Manager v1.0.1 â€” Separate PC Manual QA Checklist

**Tester Name:**
**Date of Execution:**
**Test Machine OS & Build:**
**Hardware Architecture:** x64 (AMD64)
**Test PC Approval:** [ ] Yes, approved by machine owner

---

## 1. Fresh Installation Verification (Task 4)

| Check ID | Verification Item | Expected Behavior | Status (PASS/FAIL/NOT TESTED) | Notes |
|---|---|---|:---:|---|
| **INS-01** | Installer Launch | Installer window opens with official TORI branding | | |
| **INS-02** | SmartScreen Warning | Unsigned publisher warning documented accurately | | |
| **INS-03** | Destination Directory | Defaults to \`C:\\Program Files\\Tori Download Manager\` | | |
| **INS-04** | Runtime Sidecars | All 6 binaries present in program folder | | |
| **INS-05** | Shortcuts Created | Start Menu and optional Desktop shortcut present | | |
| **INS-06** | Desktop First Launch | App launches, splash completes, main window visible | | |
| **INS-07** | Version Display | About dialog reports version \`1.0.1\` | | |

---

## 2. Installed Application Functional Verification (Task 5)

| Check ID | Verification Item | Expected Behavior | Status (PASS/FAIL/NOT TESTED) | Notes |
|---|---|---|:---:|---|
| **FN-01** | Direct HTTP/HTTPS | Downloads small sample file (e.g. 5 MB) | | |
| **FN-02** | Direct MP4 Video | Downloads MP4 video; file playable | | |
| **FN-03** | Pause & Resume | Pauses mid-stream, resumes without byte corruption | | |
| **FN-04** | Concurrent Downloads | 2+ simultaneous downloads proceed cleanly | | |
| **FN-05** | Download Scheduler | One-time schedule at future time executes on time | | |
| **FN-06** | Reschedule Download | Scheduled task rescheduled to new time | | |
| **FN-07** | HLS VOD Stream | HLS stream fetches segments, muxes via FFmpeg | | |
| **FN-08** | DASH VOD Stream | DASH representation fetches and muxes cleanly | | |
| **FN-09** | Progress Window | Floating progress window reflects active status | | |
| **FN-10** | Themes Toggle | Switching Dark/Light theme applies immediately | | |
| **FN-11** | Settings Persistence | Changed settings survive application restart | | |
| **FN-12** | Tray Minimize & Restore | Minimizing to tray works; restoring works | | |
| **FN-13** | Clean Exit | App exits cleanly; 0 orphaned background processes | | |

---

## 3. Browser Extension & Native Messaging (Task 6)

| Check ID | Verification Item | Expected Behavior | Status (PASS/FAIL/NOT TESTED) | Notes |
|---|---|---|:---:|---|
| **NM-01** | Registry Registration | \`com.tori.download_manager\` key exists in HKCU | | |
| **NM-02** | Manifest Path | JSON manifest points to installed \`tdm-native-host.exe\` | | |
| **NM-03** | Extension Sideload | Unpacked extension loads in Edge/Chrome | | |
| **NM-04** | Extension Pairing | Extension popup shows "Desktop Connected" | | |
| **NM-05** | Media Capture | Media on page intercepted and sent to TORI | | |
| **NM-06** | App Reconnection | Reconnecting after desktop restart succeeds | | |

---

## 4. In-Place Upgrade Verification (Task 7 - Optional if v1.0.0 exists)

| Check ID | Verification Item | Expected Behavior | Status (PASS/FAIL/NOT TESTED) | Notes |
|---|---|---|:---:|---|
| **UPG-01** | Overwrite Install | Installer runs over v1.0.0 cleanly without errors | | |
| **UPG-02** | Version Upgrade | About page shows \`1.0.1\` | | |
| **UPG-03** | DB Migration | Download history retained; no schema error | | |
| **UPG-04** | Settings Preserved | Custom settings retained | | |
| **UPG-05** | Downloads Untouched | Disk files in user folders preserved | | |

---

## 5. Uninstallation Verification (Task 8)

| Check ID | Verification Item | Expected Behavior | Status (PASS/FAIL/NOT TESTED) | Notes |
|---|---|---|:---:|---|
| **UN-01** | Uninstaller Execution | Uninstaller runs and removes program folder | | |
| **UN-02** | Registry Cleaned | Native Messaging registry keys removed from HKCU | | |
| **UN-03** | User Files Preserved | Downloaded files in user directories remain intact | | |
`;

fs.writeFileSync(path.join(TARGET_DIR, 'SEPARATE_PC_QA_CHECKLIST.md'), checklistDoc, 'utf8');
console.log('Generated SEPARATE_PC_QA_CHECKLIST.md');

// 5. Result Report Template
const reportTemplate = `# TORI Download Manager v1.0.1 â€” Installation QA Report

**Test Machine Identifier:**
**Windows OS Version & Build:**
**Execution Date:**
**Overall Verdict:** [ PASS / FAIL / NOT TESTED ]

---

## Summary of Results

- **Fresh Installation (Task 4):** [ PASS / FAIL / NOT TESTED ]
- **Functional Testing (Task 5):** [ PASS / FAIL / NOT TESTED ]
- **Browser Native Messaging (Task 6):** [ PASS / FAIL / NOT TESTED ]
- **In-Place Upgrade (Task 7):** [ PASS / FAIL / NOT TESTED ]
- **Uninstallation (Task 8):** [ PASS / FAIL / NOT TESTED ]

---

## Detailed Notes & Observations

*(Document SmartScreen warnings, timing, errors, or anomalies observed during testing)*

---

## Sign-Off
**Tester Signature:** ___________________________
**Date:** ___________________________
`;

fs.writeFileSync(path.join(TARGET_DIR, 'QA_RESULTS_TEMPLATE.md'), reportTemplate, 'utf8');
console.log('Generated QA_RESULTS_TEMPLATE.md');

console.log('--- Installation QA Package Successfully Prepared in release/v1.0.1-installation-qa/ ---');
