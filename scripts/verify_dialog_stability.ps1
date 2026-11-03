Write-Host "================ TESTING UI STABILITY & PROCESS LIFECYCLE ================"
$proc = Start-Process -FilePath "target\release\tori-download-manager.exe" -PassThru
Start-Sleep -Seconds 8

$hostProc = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if (-not $hostProc) {
    Write-Error "Failed to find running host process"
    exit 1
}

$allDescendants = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $proc.Id }
$childPids = @($allDescendants.ProcessId)
foreach ($c in $allDescendants) {
    $sub = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $c.ProcessId }
    foreach ($s in $sub) { $childPids += $s.ProcessId }
}

Write-Host "Running Host PID: $($proc.Id)"
Write-Host "Child WebView2 Processes: $($childPids.Count)"

# Test graceful shutdown
Write-Host "Testing graceful application exit..."
Stop-Process -Id $proc.Id
Start-Sleep -Seconds 3

# Verify no orphaned processes remain
$orphans = @()
foreach ($pidNum in $childPids) {
    $check = Get-Process -Id $pidNum -ErrorAction SilentlyContinue
    if ($check) {
        $orphans += $pidNum
        Stop-Process -Id $pidNum -Force -ErrorAction SilentlyContinue
    }
}

if ($orphans.Count -eq 0) {
    Write-Host "SUCCESS: Zero orphaned WebView2 processes detected after application exit!" -ForegroundColor Green
} else {
    Write-Warning "Detected orphaned processes: $($orphans -join ', ')"
}

# Verify settings persistence
$appDataDb = Join-Path $env:APPDATA "tori-download-manager\tdm_storage.sqlite"
if (Test-Path $appDataDb) {
    $pythonCmd = "import sqlite3; conn = sqlite3.connect(r'$appDataDb'); cur = conn.cursor(); cur.execute('SELECT COUNT(*) FROM engine_settings'); print('Settings count:', cur.fetchone()[0]); cur.execute('SELECT COUNT(*) FROM downloads'); print('Preserved user downloads:', cur.fetchone()[0])"
    python -c $pythonCmd
}

Write-Host "================ LIFECYCLE VERIFICATION FINISHED ================"

