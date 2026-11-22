<#
.SYNOPSIS
  TORI Download Manager — Gate 33 Windows Authenticode Readiness Verification (Phase 11)
.DESCRIPTION
  Verifies:
   1. signtool.exe availability on the build host.
   2. Optional Authenticode integration in scripts/build_nsis_installer.ps1 (-VerifyOnly).
   3. Fail-closed behavior: invoking build_nsis_installer.ps1 -RequireAuthenticode without
      credentials MUST exit non-zero with AUTHENTICODE_REQUIRED_ERROR.
   4. Honest inspection of current release installer Authenticode status (NotSigned) while
      confirming Tauri Ed25519 .sig remains independent and present.
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$buildScript = Join-Path $root "scripts\build_nsis_installer.ps1"

$verifyJson = & powershell -NoProfile -ExecutionPolicy Bypass -File $buildScript -VerifyOnly | Out-String
$verify = $verifyJson | ConvertFrom-Json

# Confirm fail-closed behavior when -RequireAuthenticode is passed with zero credentials
$prevThumb = $env:TORI_AUTHENTICODE_THUMBPRINT
$prevPfx = $env:TORI_AUTHENTICODE_PFX_PATH
$env:TORI_AUTHENTICODE_THUMBPRINT = ""
$env:TORI_AUTHENTICODE_PFX_PATH = ""
$failClosedOutput = ""
$failClosedCode = 0
$prevEap = $ErrorActionPreference
try {
    $ErrorActionPreference = "Continue"
    $failClosedOutput = (& powershell -NoProfile -ExecutionPolicy Bypass -File $buildScript -RequireAuthenticode 2>&1 | Out-String)
    $failClosedCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $prevEap
    $env:TORI_AUTHENTICODE_THUMBPRINT = $prevThumb
    $env:TORI_AUTHENTICODE_PFX_PATH = $prevPfx
}

$installerPath = Join-Path $root "release\v1.0.7-rc\TORI Download Manager_1.0.7_x64-setup.exe"
$sigPath = "$installerPath.sig"
$authSig = if (Test-Path $installerPath) { (Get-AuthenticodeSignature $installerPath).Status.ToString() } else { "InstallerNotLocal" }

$result = [ordered]@{
    signToolAvailable       = [bool]$verify.signToolAvailable
    signToolPath            = $verify.signToolPath
    credentialsProvisioned  = [bool]$verify.credentialsConfigured
    authenticodeActive      = [bool]$verify.authenticodeReady
    requireFailClosedOk     = ($failClosedCode -ne 0) -and ($failClosedOutput -match "AUTHENTICODE_REQUIRED_ERROR")
    currentV107Authenticode = $authSig
    tauriEd25519SigPresent  = Test-Path $sigPath
    honestStatus            = if ($verify.authenticodeReady) { "AVAILABLE" } else { "NOT_AVAILABLE_PIPELINE_READY" }
}

$result | ConvertTo-Json -Depth 4
if (-not $result.signToolAvailable -or -not $result.requireFailClosedOk) {
    exit 1
}
exit 0
