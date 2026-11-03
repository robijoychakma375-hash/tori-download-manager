$ErrorActionPreference = "Stop"

Write-Host "=== TORI Download Manager -- Standalone Execution Verification ==="

Get-Process -Name 'tori-download-manager' -ErrorAction SilentlyContinue | Stop-Process -Force

$exePath = (Resolve-Path "target\release\tori-download-manager.exe").Path
Write-Host "Launching $exePath..."
$proc = Start-Process -FilePath $exePath -PassThru

Start-Sleep -Seconds 3

$toriProcesses = Get-Process -Name 'tori-download-manager' -ErrorAction SilentlyContinue
if ($toriProcesses) {
    Write-Host "Successfully running! Found $($toriProcesses.Count) TORI desktop process(es):"
    foreach ($p in $toriProcesses) {
        $wsMB = [math]::Round($p.WorkingSet64 / 1MB, 2)
        $pmMB = [math]::Round($p.PrivateMemorySize64 / 1MB, 2)
        Write-Host "  PID: $($p.Id) | WorkingSet: ${wsMB} MB | PrivateMemory: ${pmMB} MB"
    }
} else {
    Write-Error "Desktop executable failed to remain running!"
}

Write-Host "Shutting down application cleanly..."
$proc | Stop-Process -Force
Start-Sleep -Seconds 1
Write-Host "Standalone execution verification completed successfully."
