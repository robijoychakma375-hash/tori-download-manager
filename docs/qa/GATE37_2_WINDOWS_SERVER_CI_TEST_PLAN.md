# TORI Download Manager — Gate 37.2 Windows Server CI Smoke Test Plan

**Gate:** Gate 37.2 — Clean Windows 10/11 QA Infrastructure & GitHub Actions CI Integration  
**Workflow File:** `.github/workflows/clean-windows-release-qa.yml` *(staged locally on `feat/gate37_2-clean-windows-ci-integration`; NOT YET on `origin/master`)*  
**Environment Classification:** **`WINDOWS_SERVER_CI_RUNNER`** (`windows-2022`, `windows-2025`)  
**Remote CI Execution Status:** **`CI_REMOTE_EXECUTION_NOT_TESTED`** *(remote workflow activation & dispatch are NOT authorized in Gate 37.2)*

---

## 1. Scope & Non-Interchangeability Policy

GitHub-hosted `windows-2022` and `windows-2025` runners provide clean, ephemeral **Windows Server** virtual machines ideal for automated release smoke verification. They **MUST NEVER** be labeled or counted as Windows 10 or Windows 11 Client OS QA:
- Interactive GUI tests (system tray clicks, SmartScreen interactive dialogs, live browser extension UI capture) are explicitly reported as **`SKIP`** on non-interactive Windows Server CI runners — never falsely reported as `PASS`.
- Every CI report carries `"environment_type": "WINDOWS_SERVER_CI_RUNNER"` and `"is_clean_client_vm": false`.

---

## 2. Parameterized `workflow_dispatch` Interface (Reusable for v1.0.9 & Future Releases)

| Input | Type | Default (`v1.0.9` Baseline) | Validation Rule |
| :--- | :---: | :--- | :--- |
| `release_version` | `string` | `1.0.9` | Regex `^\d+\.\d+\.\d+$` |
| `release_tag` | `string` | `v1.0.9` | Exact match `v<release_version>` |
| `expected_sha256` | `string` | `460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead` | Regex `^[a-fA-F0-9]{64}$` |
| `target_qa_profile` | `choice` | `server-upgrade-smoke` | `server-smoke` or `server-upgrade-smoke` |
| `previous_version` | `string` | `1.0.8` | Validated `X.Y.Z` when `server-upgrade-smoke` |
| `previous_expected_sha256` | `string` | `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb` | 64 hex chars when `server-upgrade-smoke` |
| `run_updater_smoke` | `boolean` | `true` | Read-only public `latest.json` UTF-8 no-BOM & `.sig` parity check |
| `require_authenticode` | `boolean` | `false` | Optional fail-closed Authenticode enforcement once commercial cert is active |

---

## 3. Windows Server CI Smoke Execution Matrix

1. **Untrusted Artifact Download & Supply-Chain Pre-Gate:** Downloads frozen NSIS installer + `.sig` (and optional prior installer) into `$RUNNER_TEMP\tori_ci_qa_root\downloads`, enforcing exact SHA-256 and running `scripts/verify_pe_authenticode.ps1 -TestTamperRejection` (verifying PE Authenticode status, independent Tauri Ed25519 signature under `CDC23D8CC8DA5397`, and 1-byte tamper rejection) BEFORE executing any downloaded binary.
2. **Public Updater Metadata Smoke (`run_updater_smoke=true`):** Fetches `/releases/latest/download/latest.json`, verifies zero UTF-8 BOM, `version == release_version`, and byte-exact `.sig` parity.
3. **Guest Smoke Execution (`scripts/clean_windows_qa_guest.ps1 -RequiredEnvironmentClass WINDOWS_SERVER_CI_RUNNER`):**
   - Optional in-place NSIS upgrade smoke (`v1.0.8` → `v1.0.9`) preserving `tdm_storage.sqlite` and seeded `.tdm-part`
   - NSIS installation & PE `ProductVersion` match
   - Edge WebView2 runtime check (`CWQA-03`), bundled resource presence (`CWQA-18`), and `tdm-cli.exe --help` smoke (`CWQA-CLI-01`)
   - Chrome/Edge/Firefox HKCU Native Messaging registration & manifest JSON schema validation (`CWQA-06`)
   - `--minimized` hidden startup, single-process check (`procCount=1`), `0` visible console windows (`CWQA-02`, `CWQA-17`)
   - `4x` concurrent `tdm-native-host.exe` stdio pairing & spawn-mutex serialization with automatic token redaction (`CWQA-19`)
   - SQLite `PRAGMA integrity_check=ok` & default tables (`CWQA-05`)
   - Bundled `yt-dlp --version`, real synthetic H.264/AAC MP4 mux/probe (`ffmpeg` + `ffprobe`), and live production External Tools manifest rev 2 HTTPS verification (`CWQA-08`, `CWQA-09`, `CWQA-10`)
   - Clean silent uninstall verifying `tdm_storage.sqlite` preservation + repair reinstall (`CWQA-16`)
   - Interactive desktop UI check honestly reported `SKIP` (`CWQA-14`)
4. **Structured Evidence Retention (`retention-days: 30`):** Uploads `qa-results.json`, `qa-summary.md`, `signature_verification.json`, and `guest_qa_console.log` even on failure (`if: always()`).

---

## 4. Resource Demand & Runner Estimates

- **Matrix:** 2 jobs (`windows-2022`, `windows-2025`), `timeout-minutes: 25`, `fail-fast: false`.
- **Expected Wall Time per Dispatch:** ~5–8 minutes per runner (~10–16 Windows runner minutes total per manual release preflight — strictly manual `workflow_dispatch`, zero automatic push/PR runner burn).
- **Network Transfer:** ~118 MB (`server-smoke`) or ~236 MB (`server-upgrade-smoke`) per runner from GitHub Releases CDN.
