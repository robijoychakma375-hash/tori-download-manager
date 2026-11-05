<#
.SYNOPSIS
    TORI Download Manager - Production Release Verification Guard Script (Gate 12.6)

.DESCRIPTION
    Verifies that the release binary:
    1. Embeds compiled React production assets (no dev server dependency).
    2. Has valid Tauri configuration (custom-protocol active, frontendDist correct).
    3. Is not blocked by stale running processes.
    4. Runs cleanly when port 5173 / Vite is NOT running.
    5. Loads `http://tauri.localhost/` for the main window (no ERR_CONNECTION_REFUSED).
    6. Loads `http://tauri.localhost/index.html?window=toast` for progress toast window.
    7. Keeps Desktop integration server active on 127.0.0.1:6800.
    8. Does not attempt to load `http://localhost:5173` or `http://localhost:1420`.
#>

[CmdletBinding()]
param(
    [string]$ExePath = "target\release\tori-download-manager.exe"
)

$ErrorActionPreference = "Stop"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " TORI PRODUCTION RELEASE BUILD GUARD VERIFICATION" -ForegroundColor Cyan
Write-Host "================================================================`n" -ForegroundColor Cyan

# 1. Check React production assets
Write-Host "[CHECK 1] Verifying built React production assets..."
$distIndex = "ui\dist\index.html"
if (-not (Test-Path $distIndex)) {
    Write-Error "FAIL: $distIndex does not exist! Run 'npm --prefix ui run build' first."
}
$distSize = (Get-Item $distIndex).Length
if ($distSize -lt 50) {
    Write-Error "FAIL: $distIndex is unexpectedly small ($distSize bytes)."
}
Write-Host "  -> PASS: ui\dist\index.html verified ($distSize bytes)" -ForegroundColor Green

# 2. Check Tauri configuration and Cargo features
Write-Host "[CHECK 2] Verifying Tauri production configuration..."
$tauriConf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
if ($tauriConf.build.frontendDist -ne "../ui/dist") {
    Write-Error "FAIL: build.frontendDist in tauri.conf.json is '$($tauriConf.build.frontendDist)', expected '../ui/dist'."
}
$cargoToml = Get-Content "src-tauri\Cargo.toml" -Raw
if ($cargoToml -notmatch 'default\s*=\s*\[.*"custom-protocol".*\]') {
    Write-Error "FAIL: src-tauri\Cargo.toml does not have 'custom-protocol' in default features!"
}
Write-Host "  -> PASS: src-tauri\Cargo.toml and tauri.conf.json configured for embedded assets" -ForegroundColor Green

# 3. Check for stale running processes
Write-Host "[CHECK 3] Checking for stale TORI processes..."
$staleProcs = Get-Process -Name "tori-download-manager" -ErrorAction SilentlyContinue
if ($staleProcs) {
    Write-Host "  -> Terminating $($staleProcs.Count) stale tori-download-manager processes to ensure clean test..." -ForegroundColor Yellow
    $staleProcs | Stop-Process -Force
    Start-Sleep -Seconds 1
}
Write-Host "  -> PASS: No stale processes locking the executable" -ForegroundColor Green

# 4. Verify no Vite development server is running on port 5173
Write-Host "[CHECK 4] Verifying no dev server running on port 5173..."
$devConn = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if ($devConn) {
    Write-Error "FAIL: A dev server is listening on port 5173! Stop Vite before running production verification."
}
Write-Host "  -> PASS: Port 5173 is free (standalone production test guarantee)" -ForegroundColor Green

# 5. Check release binary exists
Write-Host "[CHECK 5] Checking release executable..."
if (-not (Test-Path $ExePath)) {
    Write-Error "FAIL: Executable not found at $ExePath. Run 'cargo tauri build --no-bundle' first."
}
$exeItem = Get-Item $ExePath
$hash = (Get-FileHash -Path $ExePath -Algorithm SHA256).Hash
Write-Host "  -> Target binary: $($exeItem.FullName)"
Write-Host "  -> File size:     $($exeItem.Length) bytes ($([math]::Round($exeItem.Length / 1MB, 2)) MB)"
Write-Host "  -> SHA-256:       $hash"
Write-Host "  -> PASS: Release executable exists and hash computed" -ForegroundColor Green

# 6. Execute deep CDP verification via Node helper
Write-Host "[CHECK 6] Launching production executable for deep WebView2 & CDP audit..."
$nodeScript = "scripts\verify_production_release.js"
if (-not (Test-Path $nodeScript)) {
    Write-Error "FAIL: $nodeScript missing!"
}

$proc = Start-Process -FilePath "node" -ArgumentList $nodeScript -NoNewWindow -PassThru -Wait
if ($proc.ExitCode -ne 0) {
    Write-Error "FAIL: Production release verification failed with exit code $($proc.ExitCode)"
}

Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host " ALL PRODUCTION RELEASE GUARD CHECKS PASSED (GATE 12.6 VERIFIED)" -ForegroundColor Green
Write-Host "================================================================`n" -ForegroundColor Cyan

