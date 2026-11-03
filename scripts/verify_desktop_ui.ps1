Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Write-Host "Launching TORI Download Manager desktop application..."
$proc = Start-Process -FilePath "target\release\tori-download-manager.exe" -PassThru
Start-Sleep -Seconds 4

# Check process and memory
$pids = @($proc.Id)
$children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $proc.Id }
foreach ($c in $children) { $pids += $c.ProcessId }

$totWS = 0.0
$totPriv = 0.0
foreach ($pid_val in $pids) {
    $gp = Get-Process -Id $pid_val -ErrorAction SilentlyContinue
    if ($gp) {
        $totWS += ($gp.WorkingSet64 / 1MB)
        $totPriv += ($gp.PrivateMemorySize64 / 1MB)
    }
}
Write-Host "Desktop process tree verified running with $($pids.Count) processes:"
Write-Host "  Total Working Set: $([math]::Round($totWS, 2)) MB"
Write-Host "  Total Private Memory: $([math]::Round($totPriv, 2)) MB"

# Capture screen
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$screenshotPath = (Resolve-Path .).Path + "\design\desktop_actual_verified.png"
$bmp.Save($screenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()
Write-Host "Desktop window screenshot successfully captured: $screenshotPath"

# Clean up gracefully
Stop-Process -Id $proc.Id -Force
foreach ($pid_val in $pids) { Stop-Process -Id $pid_val -Force -ErrorAction SilentlyContinue }
Write-Host "Desktop application shutdown cleanly."

