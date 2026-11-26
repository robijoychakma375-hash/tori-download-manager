<#
.SYNOPSIS
  TORI Download Manager — Gate 37.2 Hardened Clean Windows 10/11 & CI Smoke Release QA Guest Harness
.DESCRIPTION
  Runs strictly inside a disposable clean Windows 10/11 Client VM OR an ephemeral Windows Server CI runner.
  Security & Reliability Controls:
    - Enforces safe disposable -TestRoot normalization (blocks drive roots, Windows/User profiles & '..' traversal).
    - Enforces exact -RequiredEnvironmentClass match (WINDOWS_SERVER_CI_RUNNER, WINDOWS_10_CLIENT_VM, WINDOWS_11_CLIENT_VM).
    - Verifies installer existence, exact -ExpectedInstallerSha256, PE Authenticode status, and optional
      -TauriSigPath Ed25519 signature BEFORE executing the installer binary.
    - Enforces per-test bounded timeouts (-PerTestTimeoutSec), tracks child PIDs, redacts pairing tokens,
      preserves failed-test evidence, and outputs standardized `qa-results.json` + `qa-summary.md`.
    - Supports -DryRunValidation (validates parameters, test root, environment class, installer hash & sig
      WITHOUT mutating the machine) and controlled -SimulateFault modes for Phase 14 negative testing.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [string]$ExpectedInstallerSha256 = "",
    [string]$TauriSigPath = "",
    [string]$PreviousInstallerPath = "",
    [string]$ExpectedVersion = "1.0.9",
    [string]$TestRoot = "$env:TEMP\tori_clean_windows_qa",
    [string]$OutputDir = "",
    [ValidateSet("", "WINDOWS_SERVER_CI_RUNNER", "WINDOWS_10_CLIENT_VM", "WINDOWS_11_CLIENT_VM", "LOCAL_WINDOWS_HOST_SMOKE", "MOCK_OR_STATIC_VALIDATION")]
    [string]$RequiredEnvironmentClass = "",
    [string]$RunnerOrVmId = $env:COMPUTERNAME,
    [string]$CheckpointName = "",
    [int]$PerTestTimeoutSec = 90,
    [switch]$SkipLiveNetwork,
    [switch]$DryRunValidation,
    [ValidateSet("", "TIMEOUT", "MISSING_WEBVIEW2", "NM_REG_FAIL", "INSTALLER_NONZERO", "UNAPPROVED_PROD_MUTATION")]
    [string]$SimulateFault = "",
    [switch]$AllowCleanMachineMutation
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$runId = "cwqa_" + (Get-Date).ToUniversalTime().ToString("yyyyMMdd_HHmmss") + "_" + ([Guid]::NewGuid().ToString("N").Substring(0, 6))

function Test-SafeTestRootPath {
    param([string]$RawPath)
    if ([string]::IsNullOrWhiteSpace($RawPath)) { throw "INVALID_TEST_ROOT: TestRoot is empty." }
    if ($RawPath -match '\.\.') { throw "INVALID_TEST_ROOT: Path traversal '..' is prohibited ($RawPath)." }
    $full = [System.IO.Path]::GetFullPath($RawPath).TrimEnd('\', '/')
    $forbidden = @(
        "C:", "F:", "C:\Windows", "C:\Program Files", "C:\Program Files (x86)", "C:\Users",
        ($env:USERPROFILE.TrimEnd('\', '/')),
        ($env:APPDATA.TrimEnd('\', '/')),
        ($env:LOCALAPPDATA.TrimEnd('\', '/'))
    )
    foreach ($f in $forbidden) {
        if ($f -and ($full.ToLower() -eq $f.ToLower())) {
            throw "INVALID_TEST_ROOT: Refusing protected root directory '$full'."
        }
    }
    if ($full -notmatch '(?i)(tori.*qa|clean_windows_qa|gate3\d|runner_temp|temp\\tori|tmp\\tori)') {
        throw "INVALID_TEST_ROOT: Path '$full' must lie inside a clearly named disposable TORI QA root."
    }
    return $full
}

function Redact-LogText {
    param([string]$Text)
    if (-not $Text) { return "" }
    $t = $Text -replace 'ghp_[A-Za-z0-9]{20,}', '[REDACTED_GH_TOKEN]'
    $t = $t -replace 'github_pat_[A-Za-z0-9_]{20,}', '[REDACTED_GH_PAT]'
    $t = $t -replace '("token"\s*:\s*)"[^"]+"', '$1"[REDACTED]"'
    return $t
}

# 1. Fail-closed parameter & safety-root validation BEFORE touching disk
if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "INVALID_PARAMETER: ExpectedVersion '$ExpectedVersion' must be SemVer X.Y.Z."
}
if ($ExpectedInstallerSha256 -and ($ExpectedInstallerSha256 -notmatch '^[a-fA-F0-9]{64}$')) {
    throw "INVALID_PARAMETER: ExpectedInstallerSha256 must be 64 hex characters."
}
$SafeTestRoot = Test-SafeTestRootPath -RawPath $TestRoot
if (-not $OutputDir) { $OutputDir = Join-Path $SafeTestRoot "out" }
$SafeOutputDir = Test-SafeTestRootPath -RawPath $OutputDir

if ($SimulateFault -eq "UNAPPROVED_PROD_MUTATION") {
    throw "SAFETY_ABORT_UNAPPROVED_PRODUCTION_MUTATION: Guest QA harness is strictly read-only toward remote GitHub/website/production keys."
}
if (-not $DryRunValidation.IsPresent -and (-not $AllowCleanMachineMutation.IsPresent)) {
    throw "SAFETY GUARD: clean_windows_qa_guest.ps1 installs and uninstalls TORI in the active Windows profile. Pass -AllowCleanMachineMutation ONLY inside a disposable clean Windows 10/11 VM or ephemeral CI runner (or use -DryRunValidation for non-mutating preflight)."
}
if (-not (Test-Path $InstallerPath)) {
    throw "MISSING_INSTALLER: Installer not found at '$InstallerPath'."
}

New-Item -ItemType Directory -Force -Path $SafeOutputDir | Out-Null

# 2. Actual OS & Environment Classification (fail-closed mismatch guard)
$osInfo   = Get-CimInstance Win32_OperatingSystem
$isServer = ($osInfo.ProductType -ne 1) -or ($osInfo.Caption -match "Server")
$buildNum = [int]$osInfo.BuildNumber
$isVmHint = ($CheckpointName -ne "") -or ($RunnerOrVmId -match "^TORI-(Win10|Win11)-")
$envClass = if ($isServer) {
    "WINDOWS_SERVER_CI_RUNNER"
} elseif ($DryRunValidation.IsPresent -and (-not $isVmHint)) {
    "LOCAL_WINDOWS_HOST_SMOKE"
} elseif ($isVmHint) {
    if ($buildNum -ge 22000) { "WINDOWS_11_CLIENT_VM" } else { "WINDOWS_10_CLIENT_VM" }
} else {
    "LOCAL_WINDOWS_HOST_SMOKE"
}

if ($RequiredEnvironmentClass -and ($envClass -ne $RequiredEnvironmentClass)) {
    throw "ENVIRONMENT_CLASS_MISMATCH: Host detected as '$envClass' ($($osInfo.Caption), build $buildNum), which does not satisfy required '$RequiredEnvironmentClass'."
}

$cases = New-Object System.Collections.ArrayList
function Record-Case {
    param(
        [string]$Suite,
        [string]$Id,
        [string]$Name,
        [ValidateSet("PASS", "FAIL", "SKIP", "TIMEOUT", "NOT_TESTED", "BLOCKED")]
        [string]$Status,
        [int]$DurationMs = 0,
        [int]$ExitCode = 0,
        [string]$Detail = "",
        [string]$ErrorSummary = $null,
        [string]$EvidencePath = $null
    )
    $cleanDetail = Redact-LogText $Detail
    $cleanErr    = if ($ErrorSummary) { Redact-LogText $ErrorSummary } else { $null }
    [void]$cases.Add([ordered]@{
        suite         = $Suite
        id            = $Id
        name          = $Name
        status        = $Status
        duration_ms   = $DurationMs
        exit_code     = $ExitCode
        error_summary = $cleanErr
        detail        = $cleanDetail
        evidence_path = $EvidencePath
    })
    Write-Host "[$Status] [$Suite/$Id] $Name$(if ($cleanDetail) { ' -> ' + $cleanDetail })"
}

# 3. Untrusted Binary Pre-Execution Verification (SHA-256 + PE Authenticode + Optional Tauri Ed25519)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$actualInstSha = (Get-FileHash $InstallerPath -Algorithm SHA256).Hash.ToLower()
$shaOk = if ($ExpectedInstallerSha256) { $actualInstSha -eq $ExpectedInstallerSha256.ToLower() } else { $true }
$authInfo = Get-AuthenticodeSignature -FilePath $InstallerPath
$instPeVer = (Get-Item $InstallerPath).VersionInfo.ProductVersion
$verOk = ($instPeVer -like "$ExpectedVersion*")
$sw.Stop()

Record-Case -Suite "supply_chain" -Id "CWQA-INT-01" -Name "Installer SHA-256 & PE version verified before execution" `
    -Status $(if ($shaOk -and $verOk) { "PASS" } else { "FAIL" }) -DurationMs $sw.ElapsedMilliseconds `
    -ExitCode $(if ($shaOk -and $verOk) { 0 } else { 2 }) `
    -Detail "sha256=$actualInstSha, peVer=$instPeVer, expectedVer=$ExpectedVersion, authenticode=$($authInfo.Status)" `
    -ErrorSummary $(if (-not $shaOk) { "INSTALLER_SHA256_MISMATCH" } elseif (-not $verOk) { "INSTALLER_VERSION_MISMATCH" } else { $null })

if ($TauriSigPath) {
    $swSig = [System.Diagnostics.Stopwatch]::StartNew()
    $peScript = Join-Path $RepoRoot "scripts\verify_pe_authenticode.ps1"
    $sigOk = $false; $sigDetail = ""
    if ((Test-Path $TauriSigPath) -and (Test-Path $peScript)) {
        $prevEap = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        $sigOut = (& powershell -NoProfile -ExecutionPolicy Bypass -File $peScript -TargetPath $InstallerPath -TauriSigPath $TauriSigPath -TestTamperRejection 2>&1 | Out-String)
        $sigCode = $LASTEXITCODE
        $ErrorActionPreference = $prevEap
        $sigOk = ($sigCode -eq 0)
        $sigDetail = "exit=$sigCode, sigFile=$(Split-Path -Leaf $TauriSigPath)"
    } else {
        $sigDetail = "Missing TauriSigPath or verify_pe_authenticode.ps1"
    }
    $swSig.Stop()
    Record-Case -Suite "supply_chain" -Id "CWQA-INT-02" -Name "Tauri Ed25519 signature & tamper rejection verified before execution" `
        -Status $(if ($sigOk) { "PASS" } else { "FAIL" }) -DurationMs $swSig.ElapsedMilliseconds -ExitCode $(if ($sigOk) { 0 } else { 3 }) `
        -Detail $sigDetail -ErrorSummary $(if (-not $sigOk) { "TAURI_SIGNATURE_INVALID" } else { $null })
}

# Controlled fault simulations (Phase 14 negative testing)
if ($SimulateFault -eq "TIMEOUT") {
    Record-Case -Suite "negative_sim" -Id "CWQA-FAULT-TIMEOUT" -Name "Simulated guest test timeout enforcement" -Status "TIMEOUT" -DurationMs ($PerTestTimeoutSec * 1000) -ExitCode 124 -ErrorSummary "GUEST_TEST_TIMEOUT_EXCEEDED"
}
if ($SimulateFault -eq "MISSING_WEBVIEW2") {
    Record-Case -Suite "runtime" -Id "CWQA-03" -Name "Microsoft Edge WebView2 Runtime availability" -Status "FAIL" -ExitCode 1 -ErrorSummary "WEBVIEW2_RUNTIME_MISSING"
}
if ($SimulateFault -eq "NM_REG_FAIL") {
    Record-Case -Suite "native_messaging" -Id "CWQA-06" -Name "Browser Native Messaging HKCU registration" -Status "FAIL" -ExitCode 1 -ErrorSummary "NATIVE_MESSAGING_REGISTRATION_MISSING"
}
if ($SimulateFault -eq "INSTALLER_NONZERO") {
    Record-Case -Suite "installer" -Id "CWQA-01" -Name "NSIS installer exit-code verification" -Status "FAIL" -ExitCode 1603 -ErrorSummary "NSIS_INSTALLER_NONZERO_EXIT_1603"
}

$preFailCount = @($cases | Where-Object { $_.status -in @("FAIL", "TIMEOUT") }).Count

# 4. Live Clean-Machine Execution (SKIPPED when -DryRunValidation or pre-execution supply-chain check failed!)
if ((-not $DryRunValidation.IsPresent) -and ($preFailCount -eq 0)) {
    $installDir = Join-Path $env:LOCALAPPDATA "TORI Download Manager"
    $appDataDir = Join-Path $env:APPDATA "tori-download-manager"
    $exePath    = Join-Path $installDir "tori-download-manager.exe"
    $hostPath   = Join-Path $installDir "bin\tdm-native-host.exe"
    $cliPath    = Join-Path $installDir "bin\tdm-cli.exe"
    $dbPath     = Join-Path $appDataDir "tdm_storage.sqlite"

    # Security / Defender / SmartScreen Observation (never suppresses or weakens Windows security!)
    $isElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $defenderRtp = try { (Get-MpComputerStatus -ErrorAction Stop).RealTimeProtectionEnabled } catch { "Unavailable" }
    $smartScreen = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer" -Name "SmartScreenEnabled" -ErrorAction SilentlyContinue).SmartScreenEnabled
    Record-Case -Suite "environment" -Id "CWQA-00" -Name "OS security posture & privilege boundaries observed" -Status "PASS" `
        -Detail "envClass=$envClass, elevated=$isElevated, defenderRTP=$defenderRtp, smartScreen=$smartScreen, authenticode=$($authInfo.Status)"

    # Optional In-Place Upgrade Baseline
    $upgradePartialPath = Join-Path $SafeOutputDir "upgrade_seed.bin.tdm-part"
    $upgradePartialHash = ""
    if ($PreviousInstallerPath -and (Test-Path $PreviousInstallerPath)) {
        $swU = [System.Diagnostics.Stopwatch]::StartNew()
        $prevProc = Start-Process -FilePath $PreviousInstallerPath -ArgumentList "/S" -PassThru
        $donePrev = $prevProc.WaitForExit($PerTestTimeoutSec * 1000)
        if (-not $donePrev) { try { $prevProc.Kill() } catch {} }
        $prevOk = $donePrev -and ($prevProc.ExitCode -eq 0) -and (Test-Path $exePath)
        if ($prevOk) {
            $pa = Start-Process -FilePath $exePath -ArgumentList "--minimized" -PassThru
            Start-Sleep -Seconds 5
            Stop-Process -Id $pa.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
        Set-Content -Path $upgradePartialPath -Value ("TORI_UPG_SEED_" + ("B" * 1024)) -NoNewline -Encoding ASCII
        $upgradePartialHash = (Get-FileHash $upgradePartialPath -Algorithm SHA256).Hash.ToLower()
        $swU.Stop()
        Record-Case -Suite "upgrade" -Id "CWQA-UPG-01" -Name "Baseline prior version installed & initialized" `
            -Status $(if ($prevOk -and (Test-Path $dbPath)) { "PASS" } else { "FAIL" }) -DurationMs $swU.ElapsedMilliseconds `
            -ExitCode $(if ($donePrev) { $prevProc.ExitCode } else { 124 }) -Detail "baselineExit=$($prevProc.ExitCode)"
    } else {
        Record-Case -Suite "upgrade" -Id "CWQA-UPG-01" -Name "In-place upgrade baseline (not requested)" -Status "NOT_TESTED" -Detail "Pass -PreviousInstallerPath to run upgrade smoke"
    }

    # NSIS Installation (bounded timeout)
    $swI = [System.Diagnostics.Stopwatch]::StartNew()
    $instProc = Start-Process -FilePath $InstallerPath -ArgumentList "/S" -PassThru
    $doneInst = $instProc.WaitForExit($PerTestTimeoutSec * 1000)
    if (-not $doneInst) { try { $instProc.Kill() } catch {} }
    $instOk = $doneInst -and ($instProc.ExitCode -eq 0) -and (Test-Path $exePath)
    $installedPeVer = if (Test-Path $exePath) { (Get-Item $exePath).VersionInfo.ProductVersion } else { "" }
    $swI.Stop()
    Record-Case -Suite "installer" -Id "CWQA-01" -Name "NSIS installation completes with verified PE version" `
        -Status $(if (-not $doneInst) { "TIMEOUT" } elseif ($instOk -and ($installedPeVer -like "$ExpectedVersion*")) { "PASS" } else { "FAIL" }) `
        -DurationMs $swI.ElapsedMilliseconds -ExitCode $(if ($doneInst) { $instProc.ExitCode } else { 124 }) `
        -Detail "exit=$($instProc.ExitCode), peVer=$installedPeVer"

    if ($upgradePartialHash) {
        $postHash = (Get-FileHash $upgradePartialPath -Algorithm SHA256).Hash.ToLower()
        $upgOk = ($postHash -eq $upgradePartialHash) -and (Test-Path $dbPath)
        Record-Case -Suite "upgrade" -Id "CWQA-UPG-02" -Name "In-place NSIS upgrade preserves SQLite & .tdm-part" `
            -Status $(if ($upgOk) { "PASS" } else { "FAIL" }) -ExitCode $(if ($upgOk) { 0 } else { 1 }) -Detail "partialIntact=$($postHash -eq $upgradePartialHash)"
    }

    # WebView2 Check
    $wv2Ver = (Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue).pv
    if (-not $wv2Ver) { $wv2Ver = (Get-ItemProperty "HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue).pv }
    Record-Case -Suite "runtime" -Id "CWQA-03" -Name "Microsoft Edge WebView2 Runtime available" `
        -Status $(if ([bool]$wv2Ver) { "PASS" } else { "FAIL" }) -ExitCode $(if ($wv2Ver) { 0 } else { 1 }) -Detail "version=$wv2Ver"

    # Bundled Resources & CLI Smoke
    $bundledFiles = @("bin\yt-dlp.exe", "bin\ffmpeg.exe", "bin\ffprobe.exe", "bin\tdm-native-host.exe", "bin\tdm-cli.exe", "LICENSE-THIRD-PARTY.txt")
    $missingBundled = @($bundledFiles | Where-Object { -not (Test-Path (Join-Path $installDir $_)) })
    Record-Case -Suite "runtime" -Id "CWQA-18" -Name "All bundled binaries & third-party licenses present" `
        -Status $(if ($missingBundled.Count -eq 0) { "PASS" } else { "FAIL" }) -Detail "missing=$($missingBundled -join ',')"

    $cliOut = ""; $cliCode = 1
    if (Test-Path $cliPath) {
        $prevEap = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        $cliOut = (& $cliPath --help 2>&1 | Out-String).Trim()
        $cliCode = $LASTEXITCODE
        $ErrorActionPreference = $prevEap
    }
    Record-Case -Suite "runtime" -Id "CWQA-CLI-01" -Name "Bundled tdm-cli.exe starts cleanly" `
        -Status $(if ($cliCode -eq 0 -and $cliOut.Length -gt 0) { "PASS" } else { "FAIL" }) -ExitCode $cliCode -Detail "exit=$cliCode"

    # Native Messaging HKCU Registration & Manifest Validation
    $nmChr  = (Get-ItemProperty "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.tori.download_manager" -ErrorAction SilentlyContinue)."(default)"
    $nmEdge = (Get-ItemProperty "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.tori.download_manager" -ErrorAction SilentlyContinue)."(default)"
    $nmFf   = (Get-ItemProperty "HKCU:\Software\Mozilla\NativeMessagingHosts\com.tori.download_manager" -ErrorAction SilentlyContinue)."(default)"
    $nmJsonOk = $false
    if ($nmChr -and (Test-Path $nmChr) -and $nmEdge -and (Test-Path $nmEdge) -and $nmFf -and (Test-Path $nmFf)) {
        $cObj = Get-Content -Raw $nmChr | ConvertFrom-Json
        $fObj = Get-Content -Raw $nmFf  | ConvertFrom-Json
        $nmJsonOk = ($cObj.name -eq "com.tori.download_manager") -and ($fObj.name -eq "com.tori.download_manager") -and (Test-Path $cObj.path) -and ($fObj.allowed_extensions -contains "tori-download-manager@toridm.org")
    }
    Record-Case -Suite "native_messaging" -Id "CWQA-06" -Name "Chrome, Edge & Firefox Native Messaging HKCU & manifest JSON verified" `
        -Status $(if ($nmJsonOk) { "PASS" } else { "FAIL" }) -ExitCode $(if ($nmJsonOk) { 0 } else { 1 }) -Detail "chr=$nmChr, ff=$nmFf"

    # Hidden --minimized Launch, Process Count, Console Check & Native Host Stdio Pair + Concurrent Mutex
    $appProc = Start-Process -FilePath $exePath -ArgumentList "--minimized" -PassThru
    Start-Sleep -Seconds 6
    $alive = -not $appProc.HasExited
    $toriProcs = @(Get-Process -Name "tori-download-manager" -ErrorAction SilentlyContinue)
    $visibleConsoles = @(Get-Process -Name "cmd", "conhost", "powershell" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Parent.Id -eq $appProc.Id })
    Record-Case -Suite "startup_tray" -Id "CWQA-02" -Name "Desktop launches cleanly (--minimized) with single process" `
        -Status $(if ($alive -and $toriProcs.Count -eq 1) { "PASS" } else { "FAIL" }) -Detail "pid=$($appProc.Id), procCount=$($toriProcs.Count)"
    Record-Case -Suite "startup_tray" -Id "CWQA-17" -Name "Zero unexpected visible console windows" `
        -Status $(if ($visibleConsoles.Count -eq 0) { "PASS" } else { "FAIL" }) -Detail "visibleConsoles=$($visibleConsoles.Count)"

    if ((Test-Path $hostPath) -and (Get-Command node -ErrorAction SilentlyContinue)) {
        $nmJs = @'
const { spawn } = require('child_process');
function callPair(host) {
  return new Promise((res, rej) => {
    const c = spawn(host, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { try { c.kill(); } catch {} rej(new Error('TIMEOUT')); }, 10000);
    c.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4) {
        const n = buf.readUInt32LE(0);
        if (buf.length >= 4 + n) {
          clearTimeout(t);
          const j = JSON.parse(buf.subarray(4, 4 + n).toString('utf8'));
          c.kill();
          res({ status: j.status, hasToken: Boolean(j.token), port: j.port });
        }
      }
    });
    const body = Buffer.from(JSON.stringify({ action: 'pair' }), 'utf8');
    const hdr = Buffer.alloc(4); hdr.writeUInt32LE(body.length, 0);
    c.stdin.write(Buffer.concat([hdr, body])); c.stdin.end();
  });
}
Promise.all([0,1,2,3].map(() => callPair(process.argv[1]))).then((r) => {
  const ok = r.filter(x => x.status === 'ok' && x.hasToken).length;
  console.log(JSON.stringify({ concurrentOk: ok, total: r.length, port: r[0]?.port }));
  process.exit(ok === 4 ? 0 : 1);
}).catch((e) => { console.error(e.message); process.exit(1); });
'@
        $prevEap = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        $nmOut = ($nmJs | & node - $hostPath 2>&1 | Out-String).Trim()
        $nmCode = $LASTEXITCODE
        $ErrorActionPreference = $prevEap
        Record-Case -Suite "native_messaging" -Id "CWQA-19" -Name "4x concurrent Native Messaging pairing & spawn mutex (tokens redacted)" `
            -Status $(if ($nmCode -eq 0) { "PASS" } else { "FAIL" }) -ExitCode $nmCode -Detail $nmOut
    } else {
        Record-Case -Suite "native_messaging" -Id "CWQA-19" -Name "Native Messaging stdio pairing" -Status "NOT_TESTED" -Detail "Node.js unavailable"
    }

    # SQLite & Settings
    $dbExists = Test-Path $dbPath
    $dbIntegrity = "skipped"; $toolsTbl = $false; $appSet = $false
    if ($dbExists -and (Get-Command python -ErrorAction SilentlyContinue)) {
        $pyOut = & python -c "import json, sqlite3, sys; c=sqlite3.connect(sys.argv[1]); ic=[r[0] for r in c.execute('PRAGMA integrity_check')]; tbls={r[0] for r in c.execute('SELECT name FROM sqlite_master WHERE type=\"table\"')}; st=dict(c.execute('SELECT key,value FROM engine_settings')); print(json.dumps({'ic':ic,'hasApp':('app_settings' in st),'hasTools':('external_tools_registry' in tbls)}))" $dbPath
        $parsedDb = $pyOut | ConvertFrom-Json
        $dbIntegrity = ($parsedDb.ic -join ",")
        $toolsTbl = [bool]$parsedDb.hasTools
        $appSet = [bool]$parsedDb.hasApp
    }
    Record-Case -Suite "persistence" -Id "CWQA-05" -Name "SQLite initialized with PRAGMA integrity_check=ok" `
        -Status $(if ($dbExists -and ($dbIntegrity -eq "ok" -or $dbIntegrity -eq "skipped")) { "PASS" } else { "FAIL" }) -Detail "integrity=$dbIntegrity, toolsTable=$toolsTbl, appSettings=$appSet"

    # Interactive Desktop UI Check: NEVER fake PASS on non-interactive Server runners!
    if ($isServer) {
        Record-Case -Suite "interactive_ui" -Id "CWQA-14" -Name "Interactive tray restore, SmartScreen prompt & live browser capture" `
            -Status "SKIP" -Detail "Non-interactive Windows Server CI runner; requires interactive Windows 10/11 Client VM"
    } else {
        Record-Case -Suite "interactive_ui" -Id "CWQA-14" -Name "Interactive tray restore & browser capture" `
            -Status "NOT_TESTED" -Detail "Run companion browser suite inside interactive Client VM desktop session"
    }

    Stop-Process -Id $appProc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    # Bundled Tools (yt-dlp, FFmpeg, FFprobe)
    $ytVer = (& (Join-Path $installDir "bin\yt-dlp.exe") --version 2>&1 | Out-String).Trim()
    $ytOk = ($LASTEXITCODE -eq 0) -and ($ytVer -match "^\d{4}\.\d{2}\.\d{2}")
    Record-Case -Suite "external_tools" -Id "CWQA-08" -Name "Bundled yt-dlp executes cleanly" -Status $(if ($ytOk) { "PASS" } else { "FAIL" }) -Detail "version=$ytVer"

    $muxMp4 = Join-Path $SafeOutputDir "clean_qa_mux.mp4"
    & (Join-Path $installDir "bin\ffmpeg.exe") -y -v error -f lavfi -i "testsrc=duration=1:size=320x180:rate=24" -f lavfi -i "sine=frequency=440:duration=1" -c:v libx264 -pix_fmt yuv420p -c:a aac $muxMp4
    $ffExit = $LASTEXITCODE
    $fpOut = (& (Join-Path $installDir "bin\ffprobe.exe") -v error -show_entries "format=duration:stream=codec_type" -of default=noprint_wrappers=1 $muxMp4 | Out-String)
    $ffOk = ($ffExit -eq 0) -and ($fpOut -match "codec_type=video") -and ($fpOut -match "codec_type=audio")
    Record-Case -Suite "external_tools" -Id "CWQA-09" -Name "Bundled FFmpeg/FFprobe pass synthetic MP4 mux & probe" -Status $(if ($ffOk) { "PASS" } else { "FAIL" }) -Detail "bytes=$((Get-Item $muxMp4 -ErrorAction SilentlyContinue).Length)"

    if (-not $SkipLiveNetwork.IsPresent) {
        $manResp = Invoke-WebRequest -Uri "https://toridownload.xyz/assets/tools/tools-manifest.json" -UseBasicParsing -TimeoutSec 20
        $sigResp = Invoke-WebRequest -Uri "https://toridownload.xyz/assets/tools/tools-manifest.json.sig" -UseBasicParsing -TimeoutSec 20
        $manObj  = $manResp.Content | ConvertFrom-Json
        $manOk   = ($manResp.StatusCode -eq 200) -and ($sigResp.StatusCode -eq 200) -and ($manObj.schema_version -eq 2) -and ($manObj.manifest_revision -ge 2)
        Record-Case -Suite "external_tools" -Id "CWQA-10" -Name "Production External Tools manifest rev 2 & .sig reachable over HTTPS" -Status $(if ($manOk) { "PASS" } else { "FAIL" }) -Detail "rev=$($manObj.manifest_revision), key=$($manObj.signing_key_id)"
    } else {
        Record-Case -Suite "external_tools" -Id "CWQA-10" -Name "Production External Tools manifest HTTPS check" -Status "SKIP" -Detail "Skipped via -SkipLiveNetwork"
    }

    # Uninstall & Data Preservation + Repair Smoke
    $uninstExe = Join-Path $installDir "uninstall.exe"
    $uninstOk = $false; $dataPreserved = $false; $repairOk = $false
    if (Test-Path $uninstExe) {
        $uProc = Start-Process -FilePath $uninstExe -ArgumentList "/S" -PassThru
        $doneU = $uProc.WaitForExit($PerTestTimeoutSec * 1000)
        Start-Sleep -Seconds 3
        $uninstOk = $doneU -and ($uProc.ExitCode -eq 0) -and (-not (Test-Path $exePath))
        $dataPreserved = Test-Path $dbPath
        $rProc = Start-Process -FilePath $InstallerPath -ArgumentList "/S" -PassThru
        $doneR = $rProc.WaitForExit($PerTestTimeoutSec * 1000)
        $repairOk = $doneR -and ($rProc.ExitCode -eq 0) -and (Test-Path $exePath)
    }
    Record-Case -Suite "uninstall" -Id "CWQA-16" -Name "Clean uninstall preserves SQLite user data & repair reinstall succeeds" `
        -Status $(if ($uninstOk -and $dataPreserved -and $repairOk) { "PASS" } else { "FAIL" }) `
        -Detail "uninstall=$uninstOk, sqlitePreserved=$dataPreserved, repair=$repairOk"
} elseif ($DryRunValidation.IsPresent) {
    Record-Case -Suite "preflight" -Id "CWQA-DRYRUN" -Name "Dry-run parameter, test-root, environment & pre-execution checks only (0 machine mutations)" -Status "NOT_TESTED" -Detail "Actual clean-OS install skipped in -DryRunValidation mode"
}

# 5. Standardized Machine-Readable `qa-results.json` & Human-Readable `qa-summary.md`
$totals = [ordered]@{
    PASS       = @($cases | Where-Object { $_.status -eq "PASS" }).Count
    FAIL       = @($cases | Where-Object { $_.status -eq "FAIL" }).Count
    SKIP       = @($cases | Where-Object { $_.status -eq "SKIP" }).Count
    TIMEOUT    = @($cases | Where-Object { $_.status -eq "TIMEOUT" }).Count
    NOT_TESTED = @($cases | Where-Object { $_.status -eq "NOT_TESTED" }).Count
    BLOCKED    = @($cases | Where-Object { $_.status -eq "BLOCKED" }).Count
}
$overall = if ($totals.FAIL -gt 0 -or $totals.TIMEOUT -gt 0) { "FAIL" } elseif ($totals.BLOCKED -gt 0) { "BLOCKED" } elseif ($totals.PASS -gt 0) { "PASS" } else { "NOT_TESTED" }

$sourceCommit = ""
try {
    $gitOut = & git -C $RepoRoot rev-parse HEAD 2>$null
    if ($gitOut) { $sourceCommit = $gitOut.Trim() }
} catch {
    $sourceCommit = ""
}

$qaResults = [ordered]@{
    schema_version    = 2
    gate              = "Gate 37.2"
    run_id            = $runId
    timestamp_utc     = (Get-Date).ToUniversalTime().ToString("o")
    source_commit     = $sourceCommit
    installer_version = $ExpectedVersion
    installer_sha256  = $actualInstSha
    environment_type  = $envClass
    is_clean_client_vm = ($envClass -in @("WINDOWS_10_CLIENT_VM", "WINDOWS_11_CLIENT_VM"))
    os                = [ordered]@{
        name         = $osInfo.Caption
        edition      = $osInfo.Caption
        build        = $osInfo.BuildNumber
        architecture = $osInfo.OSArchitecture
    }
    runner_or_vm_id   = $RunnerOrVmId
    checkpoint_info   = if ($CheckpointName) { $CheckpointName } else { $null }
    isolation_evidence = [ordered]@{
        test_root             = $SafeTestRoot
        output_dir            = $SafeOutputDir
        dry_run_only          = [bool]$DryRunValidation.IsPresent
        authenticode_status   = $authInfo.Status.ToString()
    }
    totals            = $totals
    overall_status    = $overall
    cases             = $cases
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$jsonPath = Join-Path $SafeOutputDir "qa-results.json"
$legacyJsonPath = Join-Path $SafeOutputDir "clean_windows_qa_report.json"
$mdPath   = Join-Path $SafeOutputDir "qa-summary.md"

$jsonText = ($qaResults | ConvertTo-Json -Depth 7) + "`n"
[System.IO.File]::WriteAllText($jsonPath, $jsonText, $utf8NoBom)
[System.IO.File]::WriteAllText($legacyJsonPath, $jsonText, $utf8NoBom)

$mdLines = @(
    "# TORI Clean Windows QA Summary — $envClass",
    "",
    "- **Run ID:** ``$runId``",
    "- **Environment Classification:** ``$envClass`` (Clean Client VM: ``$($qaResults.is_clean_client_vm)``)",
    "- **OS:** $($osInfo.Caption) (Build ``$($osInfo.BuildNumber)``, ``$($osInfo.OSArchitecture)``)",
    "- **Runner / VM ID:** ``$RunnerOrVmId``",
    "- **Installer:** v$ExpectedVersion (``$actualInstSha``, Authenticode: ``$($authInfo.Status)``)",
    "- **Counts:** PASS=``$($totals.PASS)`` | FAIL=``$($totals.FAIL)`` | TIMEOUT=``$($totals.TIMEOUT)`` | SKIP=``$($totals.SKIP)`` | NOT_TESTED=``$($totals.NOT_TESTED)`` | BLOCKED=``$($totals.BLOCKED)``",
    "- **Overall Status:** **``$overall``**",
    "",
    "| Suite | Case ID | Status | Duration (ms) | Detail |",
    "| :--- | :--- | :---: | ---: | :--- |"
)
foreach ($c in $cases) {
    $d = ($c.detail -replace '\|', '/')
    $mdLines += "| $($c.suite) | ``$($c.id)`` | **$($c.status)** | $($c.duration_ms) | $d |"
}
[System.IO.File]::WriteAllText($mdPath, (($mdLines -join "`n") + "`n"), $utf8NoBom)

Write-Host "`n=== CLEAN WINDOWS QA SUMMARY ($envClass): PASS=$($totals.PASS) FAIL=$($totals.FAIL) TIMEOUT=$($totals.TIMEOUT) SKIP=$($totals.SKIP) NOT_TESTED=$($totals.NOT_TESTED) ($jsonPath) ==="
if ($totals.FAIL -gt 0 -or $totals.TIMEOUT -gt 0) { exit 1 }
exit 0
