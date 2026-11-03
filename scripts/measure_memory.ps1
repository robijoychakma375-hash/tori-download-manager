$proc = Start-Process -FilePath "target\release\tori-download-manager.exe" -PassThru
Start-Sleep -Seconds 5

Write-Host "================ PROCESS TREE MEMORY AUDIT ================"
$hostProc = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if ($hostProc) {
    $hostWs = [math]::Round($hostProc.WorkingSet64 / 1MB, 2)
    $hostPm = [math]::Round($hostProc.PrivateMemorySize64 / 1MB, 2)
    Write-Host ("[Rust Host Process] PID: {0} ({1})" -f $hostProc.Id, $hostProc.ProcessName)
    Write-Host ("  Working Set: {0} MB | Private Bytes: {1} MB" -f $hostWs, $hostPm)
}

$allDescendants = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $proc.Id }
$totalTreeWs = if ($hostProc) { $hostProc.WorkingSet64 } else { 0 }
$totalTreePm = if ($hostProc) { $hostProc.PrivateMemorySize64 } else { 0 }

Write-Host "`n[WebView2 Process Tree]"
foreach ($child in $allDescendants) {
    $cp = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
    if ($cp) {
        $cWs = [math]::Round($cp.WorkingSet64 / 1MB, 2)
        $cPm = [math]::Round($cp.PrivateMemorySize64 / 1MB, 2)
        $totalTreeWs += $cp.WorkingSet64
        $totalTreePm += $cp.PrivateMemorySize64
        Write-Host ("  Child PID: {0} ({1}) - Working Set: {2} MB | Private Bytes: {3} MB" -f $cp.Id, $cp.ProcessName, $cWs, $cPm)
        
        # Grandchildren
        $subChildren = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $cp.Id }
        foreach ($sub in $subChildren) {
            $sp = Get-Process -Id $sub.ProcessId -ErrorAction SilentlyContinue
            if ($sp) {
                $sWs = [math]::Round($sp.WorkingSet64 / 1MB, 2)
                $sPm = [math]::Round($sp.PrivateMemorySize64 / 1MB, 2)
                $totalTreeWs += $sp.WorkingSet64
                $totalTreePm += $sp.PrivateMemorySize64
                Write-Host ("    Sub-Child PID: {0} ({1}) - Working Set: {2} MB | Private Bytes: {3} MB" -f $sp.Id, $sp.ProcessName, $sWs, $sPm)
            }
        }
    }
}

Write-Host "`n[Summary Totals]"
Write-Host ("  Total Process Tree Working Set: {0} MB" -f [math]::Round($totalTreeWs / 1MB, 2))
Write-Host ("  Total Process Tree Private Bytes: {0} MB" -f [math]::Round($totalTreePm / 1MB, 2))
Write-Host "=========================================================="

Stop-Process -Id $proc.Id -Force
Get-Process -Name "msedgewebview2" -ErrorAction SilentlyContinue | Where-Object { $allDescendants.ProcessId -contains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue

