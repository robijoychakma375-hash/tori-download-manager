param(
    [string]$TargetScenario = "all"
)

function Measure-ProcessHierarchy {
    param([int]$RootPid, [string]$Label)
    
    $pids = @($RootPid)
    $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $RootPid }
    foreach ($c in $children) {
        $pids += $c.ProcessId
        $grand = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $c.ProcessId }
        foreach ($g in $grand) {
            $pids += $g.ProcessId
        }
    }

    $totalWS = 0.0
    $totalPeakWS = 0.0
    $totalPriv = 0.0
    $totalHandles = 0
    $totalThreads = 0
    $procDetails = @()

    foreach ($p in $pids) {
        $gp = Get-Process -Id $p -ErrorAction SilentlyContinue
        if ($gp) {
            $ws = [math]::Round($gp.WorkingSet64 / 1MB, 2)
            $pws = [math]::Round($gp.PeakWorkingSet64 / 1MB, 2)
            $priv = [math]::Round($gp.PrivateMemorySize64 / 1MB, 2)
            $totalWS += $ws
            $totalPeakWS += $pws
            $totalPriv += $priv
            $totalHandles += $gp.Handles
            $totalThreads += $gp.Threads.Count
            $procDetails += ("{0}({1}): {2}MB WS, {3}MB Priv" -f $gp.ProcessName, $gp.Id, $ws, $priv)
        }
    }

    $conns = Get-NetTCPConnection -OwningProcess $pids -ErrorAction SilentlyContinue
    $udps = Get-NetUDPEndpoint -OwningProcess $pids -ErrorAction SilentlyContinue
    $sockCount = 0
    if ($conns) { $sockCount += @($conns).Count }
    if ($udps) { $sockCount += @($udps).Count }

    return [PSCustomObject]@{
        Scenario = $Label
        RootPid = $RootPid
        ProcessTree = ($procDetails -join "; ")
        WorkingSetMB = [math]::Round($totalWS, 2)
        PeakWS_MB = [math]::Round($totalPeakWS, 2)
        PrivateMB = [math]::Round($totalPriv, 2)
        Handles = $totalHandles
        Threads = $totalThreads
        Sockets = $sockCount
    }
}

$scenariosToRun = if ($TargetScenario -eq "all") {
    @("idle", "http1", "http4", "hlsvod", "dashvod", "torrent", "liveudp", "nativehost")
} else {
    @($TargetScenario)
}

$summary = @()

foreach ($sc in $scenariosToRun) {
    Write-Host "`n>>> RUNNING PROFILE SCENARIO: $sc <<<"
    if ($sc -eq "idle") {
        $proc = Start-Process -FilePath "target\release\tori-download-manager.exe" -PassThru
        Start-Sleep -Seconds 4
        $metric = Measure-ProcessHierarchy -RootPid $proc.Id -Label "1. Idle (Desktop UI + WebView2)"
        $summary += $metric
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $proc.Id } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    elseif ($sc -eq "nativehost") {
        $proc = Start-Process -FilePath "target\release\tdm-native-host.exe" -PassThru -NoNewWindow
        Start-Sleep -Milliseconds 400
        $metric = Measure-ProcessHierarchy -RootPid $proc.Id -Label "8. Native Messaging Host"
        $summary += $metric
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
    else {
        $proc = Start-Process -FilePath "target\release\examples\workload_runner.exe" -ArgumentList $sc -PassThru
        Start-Sleep -Milliseconds 600
        $label = switch ($sc) {
            "http1" { "2. 1 Active HTTP (Line-rate)" }
            "http4" { "3. 4 Concurrent HTTP (Adaptive)" }
            "hlsvod" { "4. HLS VOD + Muxing" }
            "dashvod" { "5. DASH VOD Audio/Video" }
            "torrent" { "6. BitTorrent Transfer + Pieces" }
            "liveudp" { "7. Live UDP Packet Ingestion" }
        }
        $metric = Measure-ProcessHierarchy -RootPid $proc.Id -Label $label
        $summary += $metric
        $proc.WaitForExit(10000)
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "`n========================= GATE 8 PROCESS TREE PROFILE RESULTS ========================="
$summary | Format-Table -Property Scenario, WorkingSetMB, PeakWS_MB, PrivateMB, Handles, Threads, Sockets -AutoSize
$summary | Export-Clixml -Path "scripts/profile_results.xml" -Force
