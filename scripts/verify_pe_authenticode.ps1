<#
.SYNOPSIS
  TORI Download Manager — Gate 37.1 PE Authenticode, Provenance & Independent Tauri Signature Verifier
.DESCRIPTION
  Strictly separates:
    1. Windows PE Authenticode signature verification (publisher identity, chain trust, RFC 3161 timestamp, revocation)
    2. Tauri Ed25519 updater signature verification (independent update integrity; NOT a Windows publisher identity)
  Supports:
    - Expected SHA-256 fail-closed digest verification
    - 1-byte mutation tamper-rejection self-test (-TestTamperRejection)
    - Fail-closed enforcement (-RequireSigned exits non-zero if Authenticode is not Valid)
    - Machine-readable JSON report (-JsonOutPath)
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetPath,
    [string]$ExpectedSha256 = "",
    [string]$TauriSigPath = "",
    [switch]$TestTamperRejection,
    [switch]$RequireSigned,
    [string]$JsonOutPath = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $TargetPath)) {
    throw "Target binary not found: $TargetPath"
}

$resolvedTarget = (Resolve-Path $TargetPath).Path
$fi = Get-Item $resolvedTarget
$actualSha = (Get-FileHash $resolvedTarget -Algorithm SHA256).Hash.ToLower()
$shaMatches = if ($ExpectedSha256) { $actualSha -eq $ExpectedSha256.ToLower() } else { $null }
$peVer = $fi.VersionInfo.ProductVersion
$fileVer = $fi.VersionInfo.FileVersion

# 1. Windows PE Authenticode Verification
$sig = Get-AuthenticodeSignature -FilePath $resolvedTarget
$cert = $sig.SignerCertificate
$tsCert = $sig.TimeStamperCertificate

# Resolve signtool.exe for deep /pa chain & revocation check when signed
$signTool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
if (-not $signTool) {
    $kit = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } | Sort-Object FullName -Descending | Select-Object -First 1
    if ($kit) { $signTool = $kit.FullName }
}

$signtoolPaStatus = "NOT_APPLICABLE_UNSIGNED"
if ($sig.Status -ne "NotSigned" -and $signTool) {
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $stOut = (& $signTool verify /pa /v $resolvedTarget 2>&1 | Out-String)
    $stCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    $signtoolPaStatus = if ($stCode -eq 0) { "VALID_CHAIN_AND_REVOCATION" } else { "FAILED_EXIT_$stCode" }
} elseif ($sig.Status -ne "NotSigned") {
    $signtoolPaStatus = "SIGNTOOL_UNAVAILABLE"
}

$authValid = ($sig.Status.ToString() -eq "Valid")
$authTamperRejected = $null
$tauriSigValid = $null
$tauriTamperRejected = $null
$tauriKeyId = $null
$tauriTrustedComment = $null

# 2. Optional Independent Tauri Ed25519 Signature Verification (NOT Authenticode!)
function Invoke-TauriEd25519Check {
    param([string]$PayloadFile, [string]$SigFile)
    $js = @'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const [repoRoot, payloadPath, sigPath] = process.argv.slice(-3);
const conf = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const pubLines = Buffer.from(conf.plugins.updater.pubkey.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
const pkRaw = Buffer.from(pubLines[1].trim(), 'base64');
const keyId = pkRaw.subarray(2, 10);
const keyIdHex = Buffer.from(keyId).reverse().toString('hex').toUpperCase();
const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pkRaw.subarray(10, 42)]);
const pubKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
const sigB64 = fs.readFileSync(sigPath, 'utf8').trim();
const sigLines = Buffer.from(sigB64, 'base64').toString('utf8').trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
const sigRaw = Buffer.from(sigLines[1], 'base64');
const alg = sigRaw.subarray(0, 2).toString('ascii');
if (!sigRaw.subarray(2, 10).equals(keyId)) { console.log(JSON.stringify({ valid: false, error: 'KEY_ID_MISMATCH' })); process.exit(0); }
const sigBytes = sigRaw.subarray(10, 74);
const tc = sigLines[2].slice('trusted comment: '.length);
const gsig = Buffer.from(sigLines[3], 'base64');
const data = fs.readFileSync(payloadPath);
const msg = alg === 'ED' ? crypto.createHash('blake2b512').update(data).digest() : data;
const ok1 = crypto.verify(null, msg, pubKey, sigBytes);
const ok2 = crypto.verify(null, Buffer.concat([sigBytes, Buffer.from(tc, 'utf8')]), pubKey, gsig);
console.log(JSON.stringify({ valid: Boolean(ok1 && ok2), keyIdHex, trustedComment: tc }));
'@
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $out = ($js | & node - $RepoRoot $PayloadFile $SigFile 2>&1 | Out-String).Trim()
    $ErrorActionPreference = $prevEap
    return ($out | ConvertFrom-Json)
}

if ($TauriSigPath -and (Test-Path $TauriSigPath)) {
    $tcRes = Invoke-TauriEd25519Check -PayloadFile $resolvedTarget -SigFile $TauriSigPath
    $tauriSigValid = [bool]$tcRes.valid
    $tauriKeyId = $tcRes.keyIdHex
    $tauriTrustedComment = $tcRes.trustedComment
}

# 3. Tamper-Rejection Self-Test (mutates a disposable temp copy; NEVER touches TargetPath)
if ($TestTamperRejection.IsPresent) {
    $tmpCopy = Join-Path ([System.IO.Path]::GetTempPath()) ("tori_tamper_test_" + [Guid]::NewGuid().ToString("N") + ".exe")
    try {
        Copy-Item $resolvedTarget $tmpCopy -Force
        $fs = [System.IO.File]::Open($tmpCopy, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite)
        try {
            $pos = [int64][Math]::Floor($fs.Length / 2)
            $fs.Seek($pos, [System.IO.SeekOrigin]::Begin) | Out-Null
            $origByte = $fs.ReadByte()
            $fs.Seek($pos, [System.IO.SeekOrigin]::Begin) | Out-Null
            $fs.WriteByte([byte]($origByte -bxor 0x5A))
        } finally {
            $fs.Dispose()
        }
        $mutSig = Get-AuthenticodeSignature -FilePath $tmpCopy
        $authTamperRejected = ($mutSig.Status.ToString() -ne "Valid")
        if ($TauriSigPath -and (Test-Path $TauriSigPath)) {
            $mutTauri = Invoke-TauriEd25519Check -PayloadFile $tmpCopy -SigFile $TauriSigPath
            $tauriTamperRejected = (-not [bool]$mutTauri.valid)
        }
    } finally {
        Remove-Item $tmpCopy -Force -ErrorAction SilentlyContinue
    }
}

$report = [ordered]@{
    timestampUtc = (Get-Date).ToUniversalTime().ToString("o")
    targetFile   = $resolvedTarget
    bytes        = $fi.Length
    sha256       = $actualSha
    expectedSha256 = if ($ExpectedSha256) { $ExpectedSha256.ToLower() } else { $null }
    sha256Match  = $shaMatches
    peMetadata   = [ordered]@{
        productVersion = $peVer
        fileVersion    = $fileVer
    }
    authenticode = [ordered]@{
        status                   = $sig.Status.ToString()
        statusMessage            = $sig.StatusMessage
        valid                    = $authValid
        signtoolVerifyPa         = $signtoolPaStatus
        signerSubject            = if ($cert) { $cert.Subject } else { $null }
        signerIssuer             = if ($cert) { $cert.Issuer } else { $null }
        signerThumbprint         = if ($cert) { $cert.Thumbprint } else { $null }
        signerNotBeforeUtc       = if ($cert) { $cert.NotBefore.ToUniversalTime().ToString("o") } else { $null }
        signerNotAfterUtc        = if ($cert) { $cert.NotAfter.ToUniversalTime().ToString("o") } else { $null }
        timestamperSubject       = if ($tsCert) { $tsCert.Subject } else { $null }
        tamperCopyRejected       = $authTamperRejected
        note                     = "Windows PE Authenticode is strictly independent from Tauri Ed25519 updater signing."
    }
    tauriEd25519Updater = [ordered]@{
        sigFileChecked     = if ($TauriSigPath) { $TauriSigPath } else { $null }
        valid              = $tauriSigValid
        keyId              = $tauriKeyId
        trustedComment     = $tauriTrustedComment
        tamperCopyRejected = $tauriTamperRejected
    }
}

$jsonText = $report | ConvertTo-Json -Depth 6
if ($JsonOutPath) {
    $parent = Split-Path -Parent $JsonOutPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($JsonOutPath, $jsonText + "`n", $utf8NoBom)
}
Write-Output $jsonText

if ($shaMatches -eq $false) {
    [Console]::Error.WriteLine("SHA256_MISMATCH: Expected $ExpectedSha256, got $actualSha")
    exit 2
}
if ($TauriSigPath -and ($tauriSigValid -ne $true -or ($TestTamperRejection.IsPresent -and $tauriTamperRejected -ne $true))) {
    [Console]::Error.WriteLine("TAURI_ED25519_VERIFICATION_FAILED")
    exit 3
}
if ($RequireSigned.IsPresent -and (-not $authValid)) {
    [Console]::Error.WriteLine("AUTHENTICODE_NOT_SIGNED_OR_INVALID: Status=$($sig.Status)")
    exit 4
}
exit 0
