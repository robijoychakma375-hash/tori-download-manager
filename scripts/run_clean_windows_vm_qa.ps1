<#
.SYNOPSIS
  TORI Download Manager — Gate 37.2 Hardened Hyper-V Clean Windows 10/11 Client VM QA Orchestrator
.DESCRIPTION
  Audits host virtualization readiness (-AuditOnly, read-only) OR safely orchestrates repeatable
  clean-VM release QA against an explicitly designated disposable TORI Windows 10/11 Hyper-V VM:
    1. Strictly rejects unrelated VMs (requires name matching ^TORI-(Win10|Win11)- OR VM Note 'TORI_DISPOSABLE_QA_VM').
    2. Validates checkpoint existence ('CleanBaseline') BEFORE mutating VM state; NEVER deletes checkpoints.
    3. Validates expected OS class (WINDOWS_10_CLIENT_VM vs WINDOWS_11_CLIENT_VM).
    4. Verifies installer SHA-256 on host AND again inside guest after transfer BEFORE execution.
    5. Runs scripts/clean_windows_qa_guest.ps1 with strict -RequiredEnvironmentClass & bounded timeout.
    6. Pulls qa-results.json + qa-summary.md + logs back to host OutputDir (preserving failure evidence!).
    7. Shuts down VM and verifies clean checkpoint restoration in `finally`.
    8. Supports -MockVmSpecPath for deterministic local Phase 14 negative testing (missing checkpoint,
       unrelated VM, VM startup failure, OS mismatch) without touching any real VM.
#>
param(
    [switch]$AuditOnly,
    [string]$VmName = "",
    [string]$CheckpointName = "CleanBaseline",
    [ValidateSet("", "WINDOWS_10_CLIENT_VM", "WINDOWS_11_CLIENT_VM")]
    [string]$ExpectedOsClass = "",
    [string]$InstallerPath = "",
    [string]$ExpectedInstallerSha256 = "",
    [string]$TauriSigPath = "",
    [string]$PreviousInstallerPath = "",
    [string]$ExpectedVersion = "1.0.9",
    [PSCredential]$GuestCredential = $null,
    [string]$OutputDir = "",
    [int]$BootTimeoutSec = 180,
    [string]$MockVmSpecPath = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) {
    $OutputDir = Join-Path $RepoRoot "target\clean_vm_qa_reports"
}

function Test-DisposableQaVmDesignation {
    param([string]$Name, [string]$Notes)
    $nameOk = ($Name -match '^TORI-(Win10|Win11)-[A-Za-z0-9_\-]+$')
    $noteOk = ($Notes -match 'TORI_DISPOSABLE_QA_VM')
    return ($nameOk -or $noteOk)
}

# Mock VM validation mode (Phase 14 deterministic negative testing — ZERO real VM mutations!)
if ($MockVmSpecPath) {
    if (-not (Test-Path $MockVmSpecPath)) { throw "MOCK_VM_SPEC_MISSING: $MockVmSpecPath" }
    $mock = Get-Content -Raw $MockVmSpecPath | ConvertFrom-Json
    if (-not $VmName) { $VmName = $mock.vmName }
    if (-not (Test-DisposableQaVmDesignation -Name $VmName -Notes ([string]$mock.notes))) {
        throw "VM_SAFETY_ABORT_UNRELATED_VM: Refusing to operate on VM '$VmName' (must match ^TORI-(Win10|Win11)- or carry Note 'TORI_DISPOSABLE_QA_VM')."
    }
    $snaps = @($mock.checkpoints)
    if ($snaps -notcontains $CheckpointName) {
        throw "VM_CHECKPOINT_MISSING: Required clean checkpoint '$CheckpointName' does not exist on VM '$VmName'."
    }
    if ($ExpectedOsClass -and ([string]$mock.osClass -ne $ExpectedOsClass)) {
        throw "VM_OS_CLASS_MISMATCH: VM '$VmName' reports '$($mock.osClass)', expected '$ExpectedOsClass'."
    }
    if ([bool]$mock.simulateBootFailure) {
        throw "VM_STARTUP_FAILURE: Guest PowerShell Direct heartbeat timed out on VM '$VmName' after ${BootTimeoutSec}s."
    }
    if ($InstallerPath -and (-not (Test-Path $InstallerPath))) {
        throw "MISSING_INSTALLER: $InstallerPath"
    }
    [ordered]@{
        mode = "mock_vm_validation"
        status = "MOCK_PREFLIGHT_OK"
        vmName = $VmName
        checkpoint = $CheckpointName
        osClass = $mock.osClass
        realVmTouched = $false
    } | ConvertTo-Json -Depth 4
    exit 0
}

if ($AuditOnly.IsPresent -or (-not $VmName)) {
    $os = Get-CimInstance Win32_OperatingSystem
    $cs = Get-CimInstance Win32_ComputerSystem
    $cpu = Get-CimInstance Win32_Processor
    $hvSvc = Get-Service vmms -ErrorAction SilentlyContinue
    $hvHost = Get-Service HvHost -ErrorAction SilentlyContinue
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $existingVms = @()
    $vmQueryError = $null
    if ($isAdmin -and (Get-Module -ListAvailable Hyper-V)) {
        try {
            $existingVms = @(Get-VM | Select-Object Name, State, Generation, Notes)
        } catch {
            $vmQueryError = $_.Exception.Message
        }
    } else {
        $vmQueryError = "Elevation required to enumerate Hyper-V VMs via Get-VM"
    }

    $audit = [ordered]@{
        mode                        = "host_virtualization_audit"
        timestampUtc                = (Get-Date).ToUniversalTime().ToString("o")
        osCaption                   = $os.Caption
        osVersion                   = $os.Version
        osBuild                     = $os.BuildNumber
        cpuName                     = $cpu.Name.Trim()
        cpuCores                    = $cpu.NumberOfCores
        cpuLogical                  = $cpu.NumberOfLogicalProcessors
        virtualizationFirmware      = [bool]$cpu.VirtualizationFirmwareEnabled
        totalRamGb                  = [math]::Round($cs.TotalPhysicalMemory / 1GB, 2)
        freeRamGb                   = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
        freeDiskC_Gb                = [math]::Round((Get-PSDrive C).Free / 1GB, 2)
        freeDiskF_Gb                = [math]::Round((Get-PSDrive F).Free / 1GB, 2)
        hyperVServiceStatus         = if ($hvSvc) { $hvSvc.Status.ToString() } else { "NotInstalled" }
        hvHostServiceStatus         = if ($hvHost) { $hvHost.Status.ToString() } else { "NotInstalled" }
        hyperVModuleInstalled       = [bool](Get-Module -ListAvailable Hyper-V)
        windowsSandboxAvailable     = Test-Path "C:\Windows\System32\WindowsSandbox.exe"
        virtualBoxAvailable         = [bool](Get-Command VBoxManage -ErrorAction SilentlyContinue)
        vmwareAvailable             = [bool](Get-Command vmrun -ErrorAction SilentlyContinue)
        dockerAvailable             = [bool](Get-Command docker -ErrorAction SilentlyContinue)
        elevatedSession             = $isAdmin
        provisionedWindowsVmCount   = $existingVms.Count
        provisionedVms              = $existingVms
        vmQueryNote                 = $vmQueryError
        cleanWin10VmStatus          = "NOT_TESTED (no pre-provisioned licensed Windows 10 clean VM image available)"
        cleanWin11VmStatus          = "NOT_TESTED (no pre-provisioned licensed Windows 11 clean VM image available)"
    }
    $audit | ConvertTo-Json -Depth 5
    exit 0
}

# Real Hyper-V Clean Client VM Execution (requires Administrator + designated disposable QA VM)
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "ELEVATION_REQUIRED: Running Hyper-V clean VM orchestration requires an elevated Administrator PowerShell session."
}
if (-not $InstallerPath -or (-not (Test-Path $InstallerPath))) {
    throw "MISSING_INSTALLER: Installer not found at '$InstallerPath'."
}
if (-not $GuestCredential) {
    throw "MISSING_CREDENTIAL: Provide -GuestCredential for PowerShell Direct guest execution inside VM '$VmName'."
}
if (-not $ExpectedOsClass) {
    $ExpectedOsClass = if ($VmName -match 'Win11') { "WINDOWS_11_CLIENT_VM" } elseif ($VmName -match 'Win10') { "WINDOWS_10_CLIENT_VM" } else { throw "Specify -ExpectedOsClass (WINDOWS_10_CLIENT_VM or WINDOWS_11_CLIENT_VM)." }
}

$hostSha = (Get-FileHash $InstallerPath -Algorithm SHA256).Hash.ToLower()
if ($ExpectedInstallerSha256 -and ($hostSha -ne $ExpectedInstallerSha256.ToLower())) {
    throw "INSTALLER_SHA256_MISMATCH: Host installer SHA-256 ($hostSha) != expected ($($ExpectedInstallerSha256.ToLower()))."
}

Import-Module Hyper-V -ErrorAction Stop
$vm = Get-VM -Name $VmName -ErrorAction Stop
if (-not (Test-DisposableQaVmDesignation -Name $vm.Name -Notes ([string]$vm.Notes))) {
    throw "VM_SAFETY_ABORT_UNRELATED_VM: Refusing to reset VM '$($vm.Name)'. Only explicitly designated TORI QA VMs (^TORI-(Win10|Win11)- or Notes containing TORI_DISPOSABLE_QA_VM) are permitted."
}
$snap = Get-VMSnapshot -VMName $vm.Name -Name $CheckpointName -ErrorAction SilentlyContinue
if (-not $snap) {
    throw "VM_CHECKPOINT_MISSING: Required clean baseline checkpoint '$CheckpointName' does not exist on VM '$($vm.Name)'."
}

$guestScript = Join-Path $PSScriptRoot "clean_windows_qa_guest.ps1"
$peScript    = Join-Path $PSScriptRoot "verify_pe_authenticode.ps1"
$runOutDir   = Join-Path $OutputDir ("${VmName}_" + (Get-Date).ToUniversalTime().ToString("yyyyMMdd_HHmmss"))
New-Item -ItemType Directory -Force -Path $runOutDir | Out-Null

Write-Host "[VM-QA] Restoring verified clean baseline checkpoint '$CheckpointName' on '$($vm.Name)'..."
Restore-VMSnapshot -VMSnapshot $snap -Confirm:$false
Start-VM -Name $vm.Name

Write-Host "[VM-QA] Waiting up to ${BootTimeoutSec}s for PowerShell Direct heartbeat on '$($vm.Name)'..."
$bootReady = $false
$maxPolls = [Math]::Max(1, [int]($BootTimeoutSec / 3))
for ($i = 0; $i -lt $maxPolls; $i++) {
    try {
        $ok = Invoke-Command -VMName $vm.Name -Credential $GuestCredential -ScriptBlock { return $true } -ErrorAction Stop
        if ($ok) { $bootReady = $true; break }
    } catch {
        Start-Sleep -Seconds 3
    }
}
if (-not $bootReady) {
    Stop-VM -Name $vm.Name -Force -TurnOff -ErrorAction SilentlyContinue
    Restore-VMSnapshot -VMSnapshot $snap -Confirm:$false -ErrorAction SilentlyContinue
    throw "VM_STARTUP_FAILURE: PowerShell Direct did not become ready on '$($vm.Name)' within ${BootTimeoutSec}s."
}

$guestRoot = "C:\ToriCleanQA"
$guestOut  = "$guestRoot\out"
$guestInst = "$guestRoot\$(Split-Path -Leaf $InstallerPath)"
$session   = New-PSSession -VMName $vm.Name -Credential $GuestCredential
$guestExit = 1
try {
    Invoke-Command -Session $session -ScriptBlock {
        param($r, $o)
        New-Item -ItemType Directory -Force -Path $r, $o, "$r\scripts", "$r\src-tauri" | Out-Null
    } -ArgumentList $guestRoot, $guestOut

    Copy-Item -Path $InstallerPath -Destination $guestInst -ToSession $session -Force
    Copy-Item -Path $guestScript   -Destination "$guestRoot\scripts\clean_windows_qa_guest.ps1" -ToSession $session -Force
    if (Test-Path $peScript) { Copy-Item -Path $peScript -Destination "$guestRoot\scripts\verify_pe_authenticode.ps1" -ToSession $session -Force }
    $tauriConf = Join-Path $RepoRoot "src-tauri\tauri.conf.json"
    if (Test-Path $tauriConf) { Copy-Item -Path $tauriConf -Destination "$guestRoot\src-tauri\tauri.conf.json" -ToSession $session -Force }

    $guestSig = ""
    if ($TauriSigPath -and (Test-Path $TauriSigPath)) {
        $guestSig = "$guestInst.sig"
        Copy-Item -Path $TauriSigPath -Destination $guestSig -ToSession $session -Force
    }
    $guestPrev = ""
    if ($PreviousInstallerPath -and (Test-Path $PreviousInstallerPath)) {
        $guestPrev = "$guestRoot\$(Split-Path -Leaf $PreviousInstallerPath)"
        Copy-Item -Path $PreviousInstallerPath -Destination $guestPrev -ToSession $session -Force
    }

    # Verify transferred installer SHA-256 INSIDE guest before executing anything!
    $guestSha = Invoke-Command -Session $session -ScriptBlock { param($p) (Get-FileHash $p -Algorithm SHA256).Hash.ToLower() } -ArgumentList $guestInst
    if ($guestSha -ne $hostSha) {
        throw "TRANSFER_INTEGRITY_ERROR: Guest installer SHA-256 ($guestSha) != host ($hostSha)."
    }

    Write-Host "[VM-QA] Executing hardened guest QA suite inside '$($vm.Name)' ($ExpectedOsClass)..."
    $guestExit = Invoke-Command -Session $session -ScriptBlock {
        param($root, $inst, $sha, $sig, $prev, $ver, $out, $reqClass, $vmId, $ckpt)
        $a = @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$root\scripts\clean_windows_qa_guest.ps1",
            "-InstallerPath", $inst,
            "-ExpectedInstallerSha256", $sha,
            "-ExpectedVersion", $ver,
            "-TestRoot", $root,
            "-OutputDir", $out,
            "-RequiredEnvironmentClass", $reqClass,
            "-RunnerOrVmId", $vmId,
            "-CheckpointName", $ckpt,
            "-AllowCleanMachineMutation"
        )
        if ($sig)  { $a += @("-TauriSigPath", $sig) }
        if ($prev) { $a += @("-PreviousInstallerPath", $prev) }
        & powershell @a 2>&1 | Tee-Object -FilePath "$out\guest_console.log"
        return $LASTEXITCODE
    } -ArgumentList $guestRoot, $guestInst, $hostSha, $guestSig, $guestPrev, $ExpectedVersion, $guestOut, $ExpectedOsClass, $vm.Name, $CheckpointName

    foreach ($art in @("qa-results.json", "qa-summary.md", "guest_console.log")) {
        $srcArt = "$guestOut\$art"
        try { Copy-Item -Path $srcArt -Destination (Join-Path $runOutDir $art) -FromSession $session -Force -ErrorAction Stop } catch {}
    }
    Write-Host "[VM-QA] Evidence retained at: $runOutDir (guestExit=$guestExit)"
} finally {
    Remove-PSSession -Session $session -ErrorAction SilentlyContinue
    Write-Host "[VM-QA] Stopping '$($vm.Name)' and restoring clean checkpoint '$CheckpointName'..."
    Stop-VM -Name $vm.Name -Force -TurnOff -ErrorAction SilentlyContinue
    Restore-VMSnapshot -VMSnapshot $snap -Confirm:$false
    $afterVm = Get-VM -Name $vm.Name
    Write-Host "[VM-QA] Post-run VM state=$($afterVm.State), parentSnapshot=$($afterVm.ParentSnapshotName)"
}
exit $guestExit
