param(
    [switch]$SignAuthenticode,
    [switch]$RequireAuthenticode,
    [string]$SignToolPath = "",
    [string]$CertThumbprint = $env:TORI_AUTHENTICODE_THUMBPRINT,
    [string]$CertPfxPath = $env:TORI_AUTHENTICODE_PFX_PATH,
    [string]$CertPfxPasswordEnv = "TORI_AUTHENTICODE_PFX_PASSWORD",
    [string]$TimestampUrl = "http://timestamp.digicert.com",
    [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
Set-Location "F:\TORI\final tori download manager"

function Resolve-SignTool {
    param([string]$ExplicitPath)
    if ($ExplicitPath -and (Test-Path $ExplicitPath)) { return $ExplicitPath }
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $kits = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($kits) { return $kits.FullName }
    return $null
}

function Invoke-AuthenticodeSign {
    param(
        [string]$ToolPath,
        [string]$TargetFile,
        [string]$Thumbprint,
        [string]$PfxPath,
        [string]$PfxPassword,
        [string]$TsaUrl
    )
    if (-not (Test-Path $TargetFile)) {
        throw "Authenticode target file not found: $TargetFile"
    }
    $argsList = @("sign", "/fd", "SHA256", "/tr", $TsaUrl, "/td", "SHA256", "/d", "TORI Download Manager")
    if ($Thumbprint) {
        $argsList += @("/sha1", $Thumbprint)
    } elseif ($PfxPath) {
        $argsList += @("/f", $PfxPath)
        if ($PfxPassword) {
            $argsList += @("/p", $PfxPassword)
        }
    } else {
        throw "No Authenticode certificate configured."
    }
    $argsList += $TargetFile

    # Invoke directly without echoing secret password arguments
    & $ToolPath @argsList | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "signtool sign failed for $TargetFile (exit code $LASTEXITCODE)"
    }
    & $ToolPath verify /pa /v $TargetFile | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "signtool verify /pa failed for $TargetFile (exit code $LASTEXITCODE)"
    }
    Write-Host "[AUTHENTICODE] Signed & verified: $TargetFile"
}

$shouldSign = $SignAuthenticode.IsPresent -or $RequireAuthenticode.IsPresent
$resolvedSignTool = Resolve-SignTool -ExplicitPath $SignToolPath
$pfxPassword = if ($CertPfxPasswordEnv) { [Environment]::GetEnvironmentVariable($CertPfxPasswordEnv) } else { $null }
$hasCertCreds = [bool]($CertThumbprint -or ($CertPfxPath -and (Test-Path $CertPfxPath)))

if ($RequireAuthenticode.IsPresent) {
    if (-not $resolvedSignTool) {
        throw "AUTHENTICODE_REQUIRED_ERROR: signtool.exe not found on host; cannot satisfy -RequireAuthenticode."
    }
    if (-not $hasCertCreds) {
        throw "AUTHENTICODE_REQUIRED_ERROR: -RequireAuthenticode was specified, but neither -CertThumbprint (TORI_AUTHENTICODE_THUMBPRINT) nor a valid -CertPfxPath (TORI_AUTHENTICODE_PFX_PATH) is configured. Refusing to produce an unsigned release."
    }
}

if ($VerifyOnly.IsPresent) {
    $status = @{
        signToolAvailable = [bool]$resolvedSignTool
        signToolPath = $resolvedSignTool
        credentialsConfigured = $hasCertCreds
        mode = if ($CertThumbprint) { "certificate_store_or_hsm_thumbprint" } elseif ($CertPfxPath) { "pfx_file" } else { "not_configured" }
        timestampUrl = $TimestampUrl
        authenticodeReady = [bool]($resolvedSignTool -and $hasCertCreds)
    }
    $status | ConvertTo-Json -Depth 4
    exit 0
}

Write-Host "Building UI bundle..."
npm --prefix ui run build
if ($LASTEXITCODE -ne 0) { throw "UI build failed with exit code $LASTEXITCODE" }

Write-Host "Ensuring resource binaries are in sync..."
Copy-Item "target\release\tdm-native-host.exe" "resources\bin\tdm-native-host.exe" -Force
Copy-Item "target\release\tdm-cli.exe" "resources\bin\tdm-cli.exe" -Force
if (Test-Path "target\release\bin") {
    Copy-Item "target\release\tdm-native-host.exe" "target\release\bin\tdm-native-host.exe" -Force
    Copy-Item "target\release\tdm-cli.exe" "target\release\bin\tdm-cli.exe" -Force
}

if ($shouldSign -and $hasCertCreds) {
    if (-not $resolvedSignTool) {
        throw "signtool.exe not found; cannot sign binaries."
    }
    Write-Host "[AUTHENTICODE] Signing inner Windows executables prior to NSIS packaging..."
    foreach ($bin in @("target\release\tori-download-manager.exe", "resources\bin\tdm-native-host.exe", "resources\bin\tdm-cli.exe")) {
        if (Test-Path $bin) {
            Invoke-AuthenticodeSign -ToolPath $resolvedSignTool -TargetFile $bin -Thumbprint $CertThumbprint -PfxPath $CertPfxPath -PfxPassword $pfxPassword -TsaUrl $TimestampUrl
        }
    }
} else {
    Write-Host "[AUTHENTICODE] Optional Authenticode signing NOT active (no certificate configured; installer will remain NotSigned for Authenticode while preserving Tauri Ed25519 signature)."
}

$keyPath = Join-Path $env:USERPROFILE ".tori-keys\tori-updater.key"
$pwdPath = Join-Path $env:USERPROFILE ".tori-keys\tori-updater.key.pwd"

if ((Test-Path $keyPath) -and (Test-Path $pwdPath)) {
    Write-Host "Loading Tauri Ed25519 updater signing key..."
    $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Raw $keyPath).Trim()
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -Raw $pwdPath).Trim()
}

Write-Host "Running cargo tauri build --bundles nsis via cmd..."
cmd.exe /c 'cargo tauri build --bundles nsis --config "{\"build\":{\"beforeBuildCommand\":\"\"}}"'
if ($LASTEXITCODE -ne 0) {
    throw "cargo tauri build failed with exit code $LASTEXITCODE"
}

if ($shouldSign -and $hasCertCreds) {
    $nsisSetup = Get-ChildItem "target\release\bundle\nsis" -Filter "*-setup.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $nsisSetup) {
        throw "Could not locate generated NSIS setup executable for Authenticode signing"
    }
    Invoke-AuthenticodeSign -ToolPath $resolvedSignTool -TargetFile $nsisSetup.FullName -Thumbprint $CertThumbprint -PfxPath $CertPfxPath -PfxPassword $pfxPassword -TsaUrl $TimestampUrl

    # CRITICAL: Authenticode modifies PE bytes, so regenerate Tauri Ed25519 .sig over the final Authenticode-signed bytes!
    if ((Test-Path $keyPath) -and (Test-Path $pwdPath)) {
        Write-Host "[UPDATER] Re-signing Tauri Ed25519 .sig over Authenticode-signed NSIS installer..."
        $sigFile = "$($nsisSetup.FullName).sig"
        if (Test-Path $sigFile) { Remove-Item $sigFile -Force }
        & cargo tauri signer sign -f $keyPath -p $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD $nsisSetup.FullName
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $sigFile)) {
            throw "Failed regenerating Tauri Ed25519 .sig after Authenticode signing!"
        }
        Write-Host "[UPDATER] Preserved independent Tauri Ed25519 signature: $sigFile"
    }
}
