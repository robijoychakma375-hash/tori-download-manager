param(
    [int]$WaitSeconds = 30,
    [switch]$IncludeTimeline = $false
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinApi {
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("psapi.dll", SetLastError = true)]
    public static extern bool GetProcessMemoryInfo(IntPtr hProcess, out PROCESS_MEMORY_COUNTERS_EX counters, uint size);
    
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_MEMORY_COUNTERS_EX {
        public uint cb;
        public uint PageFaultCount;
        public UIntPtr PeakWorkingSetSize;
        public UIntPtr WorkingSetSize;
        public UIntPtr QuotaPeakPagedPoolUsage;
        public UIntPtr QuotaPagedPoolUsage;
        public UIntPtr QuotaPeakNonPagedPoolUsage;
        public UIntPtr QuotaNonPagedPoolUsage;
        public UIntPtr PagefileUsage;
        public UIntPtr PeakPagefileUsage;
        public UIntPtr PrivateUsage;
    }
}
"@

function Get-ProcessTreeDetails {
    param([int]$RootPid)
    
    $allProcs = Get-CimInstance Win32_Process
    $hostWin32 = $allProcs | Where-Object { $_.ProcessId -eq $RootPid }
    if (-not $hostWin32) { return $null }

    # Map tree
    $treePids = @($RootPid)
    $children = $allProcs | Where-Object { $_.ParentProcessId -eq $RootPid }
    foreach ($c in $children) {
        $treePids += $c.ProcessId
        $sub = $allProcs | Where-Object { $_.ParentProcessId -eq $c.ProcessId }
        foreach ($s in $sub) {
            $treePids += $s.ProcessId
        }
    }

    $treeInfo = @()
    $totalWs = 0.0
    $totalPriv = 0.0

    foreach ($pidNum in $treePids) {
        $w32 = $allProcs | Where-Object { $_.ProcessId -eq $pidNum }
        $gp = Get-Process -Id $pidNum -ErrorAction SilentlyContinue
        if ($gp) {
            $wsMB = [math]::Round($gp.WorkingSet64 / 1MB, 2)
            $privMB = [math]::Round($gp.PrivateMemorySize64 / 1MB, 2)
            $cpu = [math]::Round($gp.CPU, 2)
            $cmd = if ($w32) { $w32.CommandLine } else { "" }

            # Identify role
            $role = "Unknown"
            if ($pidNum -eq $RootPid) {
                $role = "Rust / Tauri Host"
            } elseif ($cmd -match "--type=gpu-process") {
                $role = "WebView2 GPU Process"
            } elseif ($cmd -match "--type=renderer") {
                $role = "WebView2 Renderer (React UI)"
            } elseif ($cmd -match "--type=crashpad-handler") {
                $role = "WebView2 Crashpad Handler"
            } elseif ($cmd -match "--type=utility.*network") {
                $role = "WebView2 Network Utility"
            } elseif ($cmd -match "--type=utility") {
                $role = "WebView2 Utility Process"
            } elseif ($w32.ParentProcessId -eq $RootPid) {
                $role = "WebView2 Browser Parent"
            } else {
                $role = "WebView2 Sub-process"
            }

            $totalWs += $wsMB
            $totalPriv += $privMB

            $treeInfo += [PSCustomObject]@{
                PID = $pidNum
                Role = $role
                ProcessName = $gp.ProcessName
                WorkingSetMB = $wsMB
                PrivateBytesMB = $privMB
                CPU = $cpu
                Threads = $gp.Threads.Count
                Handles = $gp.Handles
                MainWindowHandle = $gp.MainWindowHandle
            }
        }
    }

    return [PSCustomObject]@{
        Processes = $treeInfo
        TotalWorkingSetMB = [math]::Round($totalWs, 2)
        TotalPrivateBytesMB = [math]::Round($totalPriv, 2)
        ProcessCount = $treeInfo.Count
    }
}

function Print-AuditReport {
    param($Title, $Audit)
    Write-Host "`n================================================================================"
    Write-Host "AUDIT SNAPSHOT: $Title"
    Write-Host "================================================================================"
    Write-Host ("Process Count: {0}" -f $Audit.ProcessCount)
    Write-Host ("Summed Working Set: {0} MB (Includes shared system/runtime DLL pages across processes)" -f $Audit.TotalWorkingSetMB)
    Write-Host ("Summed Private Bytes: {0} MB (Exclusive committed RAM)" -f $Audit.TotalPrivateBytesMB)
    Write-Host "--------------------------------------------------------------------------------"
    $Audit.Processes | Format-Table -Property PID, Role, WorkingSetMB, PrivateBytesMB, CPU, Threads, Handles -AutoSize | Out-String | Write-Host
}

Write-Host "Launching target\release\tori-download-manager.exe..."
$proc = Start-Process -FilePath "target\release\tori-download-manager.exe" -PassThru
Write-Host "Launched PID: $($proc.Id). Waiting $WaitSeconds seconds for initial stabilization..."
Start-Sleep -Seconds $WaitSeconds

$initialAudit = Get-ProcessTreeDetails -RootPid $proc.Id
Print-AuditReport -Title "30 Seconds After Launch (Window Visible)" -Audit $initialAudit

if ($IncludeTimeline) {
    # 2 Minutes
    Write-Host "Waiting 90 seconds (reaching 2 minutes post-launch)..."
    Start-Sleep -Seconds 90
    $twoMinAudit = Get-ProcessTreeDetails -RootPid $proc.Id
    Print-AuditReport -Title "2 Minutes After Launch (Window Visible)" -Audit $twoMinAudit

    # Window Minimized
    Write-Host "Minimizing window to measure OS working-set trim behavior..."
    $mainHandle = ($initialAudit.Processes | Where-Object { $_.MainWindowHandle -ne 0 }).MainWindowHandle
    if ($mainHandle -and $mainHandle -ne [IntPtr]::Zero) {
        [WinApi]::ShowWindowAsync($mainHandle, 6) # SW_MINIMIZE
        Start-Sleep -Seconds 5
        $minimizedAudit = Get-ProcessTreeDetails -RootPid $proc.Id
        Print-AuditReport -Title "Window Minimized (Trimmed Working Set)" -Audit $minimizedAudit

        # Window Restored
        Write-Host "Restoring window..."
        [WinApi]::ShowWindowAsync($mainHandle, 9) # SW_RESTORE
        Start-Sleep -Seconds 5
        $restoredAudit = Get-ProcessTreeDetails -RootPid $proc.Id
        Print-AuditReport -Title "Window Restored" -Audit $restoredAudit
    }
}

# Clean shutdown
Write-Host "Shutting down process $($proc.Id)..."
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
$children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $proc.Id }
foreach ($c in $children) {
    Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host "Audit run complete."

