$ErrorActionPreference = "Stop"
Set-Location "F:\TORI\final tori download manager"

Write-Host "Building UI bundle..."
npm --prefix ui run build

Write-Host "Ensuring resource binaries are in sync..."
Copy-Item "target\release\tdm-native-host.exe" "resources\bin\tdm-native-host.exe" -Force
Copy-Item "target\release\tdm-cli.exe" "resources\bin\tdm-cli.exe" -Force
if (Test-Path "target\release\bin") {
    Copy-Item "target\release\tdm-native-host.exe" "target\release\bin\tdm-native-host.exe" -Force
    Copy-Item "target\release\tdm-cli.exe" "target\release\bin\tdm-cli.exe" -Force
}

$keyPath = Join-Path $env:USERPROFILE ".tori-keys\tori-updater.key"
$pwdPath = Join-Path $env:USERPROFILE ".tori-keys\tori-updater.key.pwd"

if ((Test-Path $keyPath) -and (Test-Path $pwdPath)) {
    Write-Host "Loading updater signing key..."
    $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Raw $keyPath).Trim()
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -Raw $pwdPath).Trim()
}

Write-Host "Running cargo tauri build --bundles nsis via cmd..."
cmd.exe /c 'cargo tauri build --bundles nsis --config "{\"build\":{\"beforeBuildCommand\":\"\"}}"'
if ($LASTEXITCODE -ne 0) {
    throw "cargo tauri build failed with exit code $LASTEXITCODE"
}
