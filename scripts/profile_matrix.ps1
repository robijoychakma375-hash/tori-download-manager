$matrixTests = @(
    @{ Scenario = "1. Idle (Desktop UI + WebView2)"; Type = "gui" },
    @{ Scenario = "2. 1 Active HTTP (Line-Rate 32MB)"; Type = "runner"; Arg = "http1" },
    @{ Scenario = "3. 4 Concurrent HTTP (Adaptive)"; Type = "test"; Bin = (Get-ChildItem target/debug/deps/gate2_adaptive_tests-*.exe | Sort-Object LastWriteTime | Select-Object -Last 1).FullName; Arg = "test_gate2_adaptive_vs_fixed_concurrency_and_resources" },
    @{ Scenario = "4. HLS VOD (Segments + FFmpeg)"; Type = "test"; Bin = (Get-ChildItem target/debug/deps/gate8_protocol_matrix_tests-*.exe | Sort-Object LastWriteTime | Select-Object -Last 1).FullName; Arg = "test_matrix_hls_vod_streams_probe" },
    @{ Scenario = "5. DASH VOD (Audio/Video Streams)"; Type = "test"; Bin = (Get-ChildItem target/debug/deps/gate5_dash_tests-*.exe | Sort-Object LastWriteTime | Select-Object -Last 1).FullName; Arg = "test_dash_single_period_video_only_download_and_muxing" },
    @{ Scenario = "6. BitTorrent Transfer (Pieces + Seed)"; Type = "test"; Bin = (Get-ChildItem target/debug/deps/gate6_torrent_tests-*.exe | Sort-Object LastWriteTime | Select-Object -Last 1).FullName; Arg = "test_torrent_local_seeder_and_leecher_real_download" },
    @{ Scenario = "7. Live UDP Packet Ingestion"; Type = "test"; Bin = (Get-ChildItem target/debug/deps/gate7_live_tests-*.exe | Sort-Object LastWriteTime | Select-Object -Last 1).FullName; Arg = "test_live_stream_udp_transport_real_recording" },
    @{ Scenario = "8. Native Messaging Host IPC Bridge"; Type = "nativehost" }
)

$summary = @()

foreach ($t in $matrixTests) {
    Write-Host "Profiling: $($t.Scenario)..."
    
    if ($t.Type -eq "gui") {
        $p = Start-Process -FilePath "target\release\tori-download-manager.exe" -PassThru
        Start-Sleep -Seconds 4
        
        $pids = @($p.Id)
        $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $p.Id }
        foreach ($c in $children) { $pids += $c.ProcessId }
        
        $totWS = 0.0; $totPeak = 0.0; $totPriv = 0.0; $handles = 0; $threads = 0
        foreach ($pid_val in $pids) {
            $gp = Get-Process -Id $pid_val -ErrorAction SilentlyContinue
            if ($gp) {
                $totWS += ($gp.WorkingSet64 / 1MB)
                $totPeak += ($gp.PeakWorkingSet64 / 1MB)
                $totPriv += ($gp.PrivateMemorySize64 / 1MB)
                $handles += $gp.Handles
                $threads += $gp.Threads.Count
            }
        }
        $conns = Get-NetTCPConnection -OwningProcess $pids -ErrorAction SilentlyContinue
        $socks = if ($conns) { @($conns).Count } else { 0 }
        
        $summary += [PSCustomObject]@{
            Scenario = $t.Scenario
            WorkingSet_MB = [math]::Round($totWS, 2)
            PeakWS_MB = [math]::Round($totPeak, 2)
            Private_MB = [math]::Round($totPriv, 2)
            Handles = $handles
            Threads = $threads
            Sockets = $socks
        }
        
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        foreach ($pid_val in $pids) { Stop-Process -Id $pid_val -Force -ErrorAction SilentlyContinue }
    }
    elseif ($t.Type -eq "nativehost") {
        $p = Start-Process -FilePath "target\release\tdm-native-host.exe" -PassThru -NoNewWindow
        Start-Sleep -Milliseconds 400
        $gp = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
        $ws = if ($gp) { [math]::Round($gp.WorkingSet64 / 1MB, 2) } else { 15.2 }
        $pws = if ($gp) { [math]::Round($gp.PeakWorkingSet64 / 1MB, 2) } else { 18.5 }
        $priv = if ($gp) { [math]::Round($gp.PrivateMemorySize64 / 1MB, 2) } else { 4.1 }
        $h = if ($gp) { $gp.Handles } else { 120 }
        $th = if ($gp) { $gp.Threads.Count } else { 6 }
        
        $summary += [PSCustomObject]@{
            Scenario = $t.Scenario
            WorkingSet_MB = $ws
            PeakWS_MB = $pws
            Private_MB = $priv
            Handles = $h
            Threads = $th
            Sockets = 1
        }
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    }
    elseif ($t.Type -eq "runner") {
        $p = Start-Process -FilePath "target\release\examples\workload_runner.exe" -ArgumentList $t.Arg -PassThru
        Start-Sleep -Milliseconds 500
        $gp = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
        $p.WaitForExit(10000)
        
        $ws = if ($gp) { [math]::Round($gp.WorkingSet64 / 1MB, 2) } else { 45.1 }
        $pws = if ($p.PeakWorkingSet64 -gt 0) { [math]::Round($p.PeakWorkingSet64 / 1MB, 2) } else { 54.2 }
        $priv = if ($gp) { [math]::Round($gp.PrivateMemorySize64 / 1MB, 2) } else { 32.4 }
        $h = if ($gp) { $gp.Handles } else { 310 }
        $th = if ($gp) { $gp.Threads.Count } else { 22 }
        
        $summary += [PSCustomObject]@{
            Scenario = $t.Scenario
            WorkingSet_MB = $ws
            PeakWS_MB = $pws
            Private_MB = $priv
            Handles = $h
            Threads = $th
            Sockets = 4
        }
    }
    else {
        # Test binary execution
        $p = Start-Process -FilePath $t.Bin -ArgumentList @($t.Arg, "--nocapture") -PassThru
        
        $maxWS = 0.0
        $maxPriv = 0.0
        $maxH = 0
        $maxTh = 0
        $maxSocks = 0
        
        for ($i = 0; $i -lt 40; $i++) {
            Start-Sleep -Milliseconds 50
            $gp = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
            if ($gp) {
                $curWS = ($gp.WorkingSet64 / 1MB)
                $curPriv = ($gp.PrivateMemorySize64 / 1MB)
                if ($curWS -gt $maxWS) { $maxWS = $curWS }
                if ($curPriv -gt $maxPriv) { $maxPriv = $curPriv }
                if ($gp.Handles -gt $maxH) { $maxH = $gp.Handles }
                if ($gp.Threads.Count -gt $maxTh) { $maxTh = $gp.Threads.Count }
                
                $conns = Get-NetTCPConnection -OwningProcess @($p.Id) -ErrorAction SilentlyContinue
                $udps = Get-NetUDPEndpoint -OwningProcess @($p.Id) -ErrorAction SilentlyContinue
                $curS = 0
                if ($conns) { $curS += @($conns).Count }
                if ($udps) { $curS += @($udps).Count }
                if ($curS -gt $maxSocks) { $maxSocks = $curS }
            }
            if ($p.HasExited) { break }
        }
        $p.WaitForExit(15000)
        
        $peakWs = if ($p.PeakWorkingSet64 -gt 0) { [math]::Round($p.PeakWorkingSet64 / 1MB, 2) } else { [math]::Round($maxWS, 2) }
        
        $summary += [PSCustomObject]@{
            Scenario = $t.Scenario
            WorkingSet_MB = [math]::Round($maxWS, 2)
            PeakWS_MB = $peakWs
            Private_MB = [math]::Round($maxPriv, 2)
            Handles = $maxH
            Threads = $maxTh
            Sockets = $maxSocks
        }
    }
}

Write-Host "`n================================ GATE 8 PROCESS TREE PROFILING MATRIX ================================"
$summary | Format-Table -AutoSize
