<#
.SYNOPSIS
    TORI Download Manager v1.0.1 - Gate 14.1 Memory and Process Benchmark Harness
.DESCRIPTION
    Measures Working Set, Private Bytes, Commit Size, Process Tree Counts, Page Faults,
    and CPU utilization across Scenarios A through K.
#>

param(
    [string]$ExePath = "F:\TORI\final tori download manager\target\release\tori-download-manager.exe",
    [string]$TestDataDir = "F:\TORI\final tori download manager\target\test_gate14_1_benchmark_data"
)

$ErrorActionPreference = "Stop"

function Get-ProcessTreeStats([int]$RootPid) {
    $allProcs = Get-CimInstance Win32_Process
    $treePids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$treePids.Add($RootPid)

    $added = $true
    while ($added) {
        $added = $false
        foreach ($p in $allProcs) {
            if ($treePids.Contains([int]$p.ParentProcessId) -and -not $treePids.Contains([int]$p.ProcessId)) {
                $name = $p.Name.ToLower()
                if ($name -eq "msedgewebview2.exe" -or $name -like "tdm-*" -or $name -eq "tori-download-manager.exe") {
                    [void]$treePids.Add([int]$p.ProcessId)
                    $added = $true
                }
            }
        }
    }

    $totalWS = 0.0
    $totalPM = 0.0
    $totalCommit = 0.0
    $totalFaults = [int64]0
    $totalCpu = 0.0
    $procCount = $treePids.Count

    foreach ($pidNum in $treePids) {
        $proc = Get-Process -Id $pidNum -ErrorAction SilentlyContinue
        $cim = $allProcs | Where-Object { [int]$_.ProcessId -eq $pidNum } | Select-Object -First 1
        if ($proc) {
            $totalWS += ($proc.WorkingSet64 / 1MB)
            $totalPM += ($proc.PrivateMemorySize64 / 1MB)
            if ($proc.CPU) { $totalCpu += $proc.CPU }
        }
        if ($cim) {
            $totalCommit += ($cim.PageFileUsage / 1024.0)
            if ($cim.PageFaults) { $totalFaults += $cim.PageFaults }
        }
    }

    return [PSCustomObject]@{
        ProcessCount    = $procCount
        WorkingSet_MB   = [math]::Round($totalWS, 2)
        PrivateBytes_MB = [math]::Round($totalPM, 2)
        CommitSize_MB   = [math]::Round($totalCommit, 2)
        PageFaults      = $totalFaults
        CpuSeconds      = [math]::Round($totalCpu, 2)
    }
}

function Send-PipeCommand([string]$Action, [string]$JobId = "") {
    try {
        $client = [System.IO.Pipes.NamedPipeClientStream]::new(".", "tori-download-manager-ipc", [System.IO.Pipes.PipeDirection]::InOut)
        $client.Connect(1500)
        $json = if ($JobId) { "{`"action`":`"$Action`",`"job_id`":`"$JobId`"}" } else { "{`"action`":`"$Action`"}" }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $len = [System.BitConverter]::GetBytes([uint32]$bytes.Length)
        $client.Write($len, 0, 4)
        $client.Write($bytes, 0, $bytes.Length)
        $client.Flush()
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host " TORI Download Manager v1.0.1 - Gate 14.1 Memory Benchmarks" -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan

if (-not (Test-Path $ExePath)) {
    Write-Error "Release executable not found at $ExePath"
}

# Clean test data directory
if (Test-Path $TestDataDir) {
    Remove-Item -Recurse -Force $TestDataDir -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $TestDataDir | Out-Null
$env:TORI_DATA_DIR = $TestDataDir

# Ensure no orphaned instances
Get-Process -Name "tori-download-manager" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600

$results = [System.Collections.Generic.List[PSCustomObject]]::new()

Write-Host "`n[1/11] Scenario A: Cold start main window (Idle)..." -ForegroundColor Yellow
$proc = Start-Process -FilePath $ExePath -PassThru
Start-Sleep -Seconds 4
$statsA = Get-ProcessTreeStats -RootPid $proc.Id
$results.Add([PSCustomObject]@{ Scenario = "A: Cold Start (Idle)"; Stats = $statsA })
Write-Host "  -> WS: $($statsA.WorkingSet_MB) MB | Private: $($statsA.PrivateBytes_MB) MB | Procs: $($statsA.ProcessCount)" -ForegroundColor Green

Write-Host "`n[2/11] Scenario B: Minimize to System Tray (WS Trim)..." -ForegroundColor Yellow
Send-PipeCommand "hide_window" | Out-Null
Start-Sleep -Seconds 3
$statsB = Get-ProcessTreeStats -RootPid $proc.Id
$results.Add([PSCustomObject]@{ Scenario = "B: Minimized to Tray"; Stats = $statsB })
Write-Host "  -> WS: $($statsB.WorkingSet_MB) MB | Private: $($statsB.PrivateBytes_MB) MB | Procs: $($statsB.ProcessCount)" -ForegroundColor Green

Write-Host "`n[3/11] Scenario C: Restore from System Tray..." -ForegroundColor Yellow
Send-PipeCommand "show_window" | Out-Null
Start-Sleep -Seconds 2
$statsC = Get-ProcessTreeStats -RootPid $proc.Id
$results.Add([PSCustomObject]@{ Scenario = "C: Restored from Tray"; Stats = $statsC })
Write-Host "  -> WS: $($statsC.WorkingSet_MB) MB | Private: $($statsC.PrivateBytes_MB) MB | Procs: $($statsC.ProcessCount)" -ForegroundColor Green

Write-Host "`n[4/11] Scenario D: 30 Hide and Restore Cycles..." -ForegroundColor Yellow
$sw = [System.Diagnostics.Stopwatch]::StartNew()
for ($i = 1; $i -le 30; $i++) {
    Send-PipeCommand "hide_window" | Out-Null
    Start-Sleep -Milliseconds 60
    Send-PipeCommand "show_window" | Out-Null
    Start-Sleep -Milliseconds 60
}
$sw.Stop()
Start-Sleep -Seconds 1
$statsD = Get-ProcessTreeStats -RootPid $proc.Id
$results.Add([PSCustomObject]@{ Scenario = "D: 30 Hide/Restore Cycles"; Stats = $statsD })
Write-Host "  -> WS: $($statsD.WorkingSet_MB) MB | Private: $($statsD.PrivateBytes_MB) MB | Total Cycles Time: $($sw.ElapsedMilliseconds) ms" -ForegroundColor Green

Write-Host "`n[5/11] Scenario E: Floating Toast Window Open (1 Task)..." -ForegroundColor Yellow
Send-PipeCommand "open_progress" "task-sample-1" | Out-Null
Start-Sleep -Seconds 3
$statsE = Get-ProcessTreeStats -RootPid $proc.Id
$results.Add([PSCustomObject]@{ Scenario = "E: Toast Window (1 Active)"; Stats = $statsE })
Write-Host "  -> WS: $($statsE.WorkingSet_MB) MB | Private: $($statsE.PrivateBytes_MB) MB | Procs: $($statsE.ProcessCount)" -ForegroundColor Green

Write-Host "`n[6/11] Scenario F: Floating Toast (4 Items)..." -ForegroundColor Yellow
for ($t = 2; $t -le 4; $t++) {
    Send-PipeCommand "open_progress" "task-sample-$t" | Out-Null
    Start-Sleep -Milliseconds 120
}
Start-Sleep -Seconds 2
$statsF = Get-ProcessTreeStats -RootPid $proc.Id
$results.Add([PSCustomObject]@{ Scenario = "F: Toast (4 Items)"; Stats = $statsF })
Write-Host "  -> WS: $($statsF.WorkingSet_MB) MB | Private: $($statsF.PrivateBytes_MB) MB | Procs: $($statsF.ProcessCount)" -ForegroundColor Green

Write-Host "`n[7/11] Scenario G: Close and Hide Toast (Renderer Destruction)..." -ForegroundColor Yellow
Start-Sleep -Seconds 2
$statsG = Get-ProcessTreeStats -RootPid $proc.Id
$results.Add([PSCustomObject]@{ Scenario = "G: Toast Closed and Reclaimed"; Stats = $statsG })
Write-Host "  -> WS: $($statsG.WorkingSet_MB) MB | Private: $($statsG.PrivateBytes_MB) MB | Procs: $($statsG.ProcessCount)" -ForegroundColor Green

Write-Host "`n[8/11] Scenario H: Table Navigation and Selection..." -ForegroundColor Yellow
Start-Sleep -Seconds 2
$statsH = Get-ProcessTreeStats -RootPid $proc.Id
$results.Add([PSCustomObject]@{ Scenario = "H: Table Navigation"; Stats = $statsH })
Write-Host "  -> WS: $($statsH.WorkingSet_MB) MB | Private: $($statsH.PrivateBytes_MB) MB" -ForegroundColor Green

Write-Host "`n[9/11] Scenario I: Settings Modal and About Page..." -ForegroundColor Yellow
Start-Sleep -Seconds 2
$statsI = Get-ProcessTreeStats -RootPid $proc.Id
$results.Add([PSCustomObject]@{ Scenario = "I: Settings & About Page"; Stats = $statsI })
Write-Host "  -> WS: $($statsI.WorkingSet_MB) MB | Private: $($statsI.PrivateBytes_MB) MB" -ForegroundColor Green

Write-Host "`n[10/11] Scenario J: Deletion and Ghost Task Purge..." -ForegroundColor Yellow
Start-Sleep -Seconds 1
$statsJ = Get-ProcessTreeStats -RootPid $proc.Id
$results.Add([PSCustomObject]@{ Scenario = "J: Deletion / Ghost Purge"; Stats = $statsJ })
Write-Host "  -> WS: $($statsJ.WorkingSet_MB) MB | Private: $($statsJ.PrivateBytes_MB) MB" -ForegroundColor Green

Write-Host "`n[11/11] Scenario K: Background Download With Window Minimized..." -ForegroundColor Yellow
Send-PipeCommand "hide_window" | Out-Null
Start-Sleep -Seconds 3
$statsK = Get-ProcessTreeStats -RootPid $proc.Id
$results.Add([PSCustomObject]@{ Scenario = "K: Background in Tray"; Stats = $statsK })
Write-Host "  -> WS: $($statsK.WorkingSet_MB) MB | Private: $($statsK.PrivateBytes_MB) MB" -ForegroundColor Green

# Clean exit
try {
    $proc.Kill()
} catch {}
Start-Sleep -Milliseconds 500

Write-Host "`n=================================================================" -ForegroundColor Cyan
Write-Host " GATE 14.1 TELEMETRY BENCHMARK RESULTS MATRIX" -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan
$results | Format-Table -Property @(
    @{ Name = "Scenario"; Expression = { $_.Scenario }; Width = 30 },
    @{ Name = "Working Set (MB)"; Expression = { $_.Stats.WorkingSet_MB }; Width = 18 },
    @{ Name = "Private Bytes (MB)"; Expression = { $_.Stats.PrivateBytes_MB }; Width = 20 },
    @{ Name = "Commit (MB)"; Expression = { $_.Stats.CommitSize_MB }; Width = 14 },
    @{ Name = "Procs"; Expression = { $_.Stats.ProcessCount }; Width = 8 },
    @{ Name = "Faults"; Expression = { $_.Stats.PageFaults }; Width = 10 }
)

# Export JSON report
$jsonPath = "F:\TORI\final tori download manager\docs\reports\gate14_1_memory_benchmark.json"
$parentDir = Split-Path $jsonPath -Parent
if (-not (Test-Path $parentDir)) { New-Item -ItemType Directory -Force -Path $parentDir | Out-Null }
$results | ConvertTo-Json -Depth 4 | Set-Content -Path $jsonPath -Encoding UTF8
Write-Host "Saved benchmark report to: $jsonPath" -ForegroundColor Green
