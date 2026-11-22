<#
.SYNOPSIS
  TORI Download Manager — Gate 33 Host Hyper-V Clean Windows 10/11 VM QA Orchestrator (Phase 10)
.DESCRIPTION
  Audits host virtualization readiness (-AuditOnly, safe non-elevated read-only check) OR
  orchestrates repeatable clean-VM release QA against a pre-provisioned Windows 10/11 Hyper-V VM:
    1. Reverts target VM to clean baseline checkpoint (e.g., "CleanBaseline")
    2. Starts VM & waits for PowerShell Direct heartbeat
    3. Copies NSIS installer + scripts/clean_windows_qa_guest.ps1 into clean guest
    4. Executes all 18 clean-machine checks inside guest
    5. Pulls clean_windows_qa_report.json back to host OutputDir
    6. Reverts VM back to clean baseline checkpoint
  NEVER enables hypervisors, installs virtualization software, or alters system configuration.
#>
param(
    [switch]$AuditOnly,
    [string]$VmName = "",
    [string]$CheckpointName = "CleanBaseline",
    [string]$InstallerPath = "",
    [PSCredential]$GuestCredential = $null,
    [string]$OutputDir = "F:\TORI\final tori download manager\target\clean_vm_qa_reports"
)

$ErrorActionPreference = "Stop"

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
            $existingVms = @(Get-VM | Select-Object Name, State, Generation)
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

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Running Hyper-V clean VM orchestration requires an elevated Administrator PowerShell session."
}
if (-not (Test-Path $InstallerPath)) {
    throw "Installer not found: $InstallerPath"
}
if (-not $GuestCredential) {
    throw "Provide -GuestCredential for PowerShell Direct guest execution inside VM '$VmName'."
}

Import-Module Hyper-V -ErrorAction Stop
$vm = Get-VM -Name $VmName -ErrorAction Stop
$snap = Get-VMSnapshot -VMName $VmName -Name $CheckpointName -ErrorAction Stop
$guestScript = Join-Path $PSScriptRoot "clean_windows_qa_guest.ps1"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Write-Host "[VM-QA] Restoring clean baseline checkpoint '$CheckpointName' on VM '$VmName'..."
Restore-VMSnapshot -VMSnapshot $snap -Confirm:$false
Start-VM -Name $VmName
Write-Host "[VM-QA] Waiting for VM '$VmName' PowerShell Direct readiness..."
for ($i = 0; $i -lt 60; $i++) {
    try {
        $ok = Invoke-Command -VMName $VmName -Credential $GuestCredential -ScriptBlock { return $true } -ErrorAction Stop
        if ($ok) { break }
    } catch {
        Start-Sleep -Seconds 3
    }
}

$guestDir = "C:\ToriCleanQA"
$guestInstaller = "$guestDir\$(Split-Path -Leaf $InstallerPath)"
$guestHarness = "$guestDir\clean_windows_qa_guest.ps1"
$session = New-PSSession -VMName $VmName -Credential $GuestCredential
try {
    Invoke-Command -Session $session -ScriptBlock { param($d) New-Item -ItemType Directory -Force -Path $d | Out-Null } -ArgumentList $guestDir
    Copy-Item -Path $InstallerPath -Destination $guestInstaller -ToSession $session -Force
    Copy-Item -Path $guestScript -Destination $guestHarness -ToSession $session -Force

    Write-Host "[VM-QA] Executing 18-check clean guest verification inside '$VmName'..."
    Invoke-Command -Session $session -ScriptBlock {
        param($harness, $inst, $out)
        & powershell -NoProfile -ExecutionPolicy Bypass -File $harness -InstallerPath $inst -OutputDir $out -AllowCleanMachineMutation
    } -ArgumentList $guestHarness, $guestInstaller, "$guestDir\out"

    $hostReport = Join-Path $OutputDir "${VmName}_clean_windows_qa_report.json"
    Copy-Item -Path "$guestDir\out\clean_windows_qa_report.json" -Destination $hostReport -FromSession $session -Force
    Write-Host "[VM-QA] Collected clean guest QA report: $hostReport"
} finally {
    Remove-PSSession -Session $session -ErrorAction SilentlyContinue
    Write-Host "[VM-QA] Stopping VM and restoring clean checkpoint '$CheckpointName'..."
    Stop-VM -Name $VmName -Force -TurnOff -ErrorAction SilentlyContinue
    Restore-VMSnapshot -VMSnapshot $snap -Confirm:$false
}
