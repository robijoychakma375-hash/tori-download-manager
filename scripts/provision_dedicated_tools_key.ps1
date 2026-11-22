<#
.SYNOPSIS
  TORI Download Manager — Gate 33.1 / 33.3 Dedicated External Tools Signing Key Provisioning, Verification & Custody Tool
.DESCRIPTION
  Supports strictly separated, fail-closed modes (ZERO private keys or passphrases printed or logged):
    -Mode AuditCustody          : Read-only audit of %USERPROFILE%\.tori-keys (never exposes secrets).
    -Mode TestIsolated          : Runs full encrypted key generation (Ed/Sc scrypt), NTFS owner-only ACL,
                                  public-key derivation, Key ID & SHA-256 fingerprint verification,
                                  sign/verify roundtrip, backup verification simulation, and private-key cleanup.
    -Mode ProductionInteractive : Operator-controlled interactive provisioning of %USERPROFILE%\.tori-keys\tori-tools.key
                                  via Read-Host -AsSecureString (min 16 chars, distinct from tori-updater.key).
                                  Verifies Ed/Sc scrypt encryption, runs in-memory sign/verify roundtrip,
                                  restricts NTFS ACLs to owner-only, refuses to overwrite tori-updater.key or write .pwd.
    -Mode VerifyProductionKey   : Read-only cryptographic verification of existing %USERPROFILE%\.tori-keys\tori-tools.key
                                  and .pub (encryption header, owner-only ACL, independence from CDC23D8CC8DA5397,
                                  derived Rust constants for crates/tdm-core/src/tools/trust.rs).
    -Mode VerifyBackup          : Verifies an offline encrypted backup directory (-BackupDir) matches active
                                  tori-tools.key & tori-tools.key.pub SHA-256 and public key identity without exposing secrets.
    -Mode SignStagingTest       : Operator-controlled interactive local signing of a non-production staging manifest
                                  (-ManifestPath) using tori-tools.key via Read-Host -AsSecureString; strictly blocks
                                  production website paths.
#>
param(
    [ValidateSet("AuditCustody", "TestIsolated", "ProductionInteractive", "VerifyProductionKey", "VerifyBackup", "SignStagingTest")]
    [string]$Mode = "AuditCustody",
    [string]$TestOutDir = "F:\TORI\final tori download manager\target\gate33_3_key_qa",
    [string]$KeyDir = (Join-Path $env:USERPROFILE ".tori-keys"),
    [string]$BackupDir = "",
    [string]$ManifestPath = "",
    [switch]$VerifyPassphrase,
    [switch]$ForceRotate
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$UPDATER_KEY_ID = "CDC23D8CC8DA5397"

function Parse-MinisignPublicKey {
    param([string]$PubFilePath)
    $raw = (Get-Content -Raw $PubFilePath).Trim()
    $text = if ($raw -match "untrusted comment:") {
        $raw
    } else {
        [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw)).Trim()
    }
    $lines = $text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
    $keyLine = $lines | Where-Object { $_ -notmatch "^untrusted comment:" } | Select-Object -First 1
    if (-not $keyLine) { throw "Invalid Minisign public key box in $PubFilePath" }
    $bytes = [Convert]::FromBase64String($keyLine)
    if ($bytes.Length -ne 42) { throw "Unexpected Minisign public key length ($($bytes.Length), expected 42)" }
    $idBytes = New-Object byte[] 8
    [Array]::Copy($bytes, 2, $idBytes, 0, 8)
    $idU64 = [BitConverter]::ToUInt64($idBytes, 0)
    $keyIdHex = $idU64.ToString("X16")
    $rawPub32 = New-Object byte[] 32
    [Array]::Copy($bytes, 10, $rawPub32, 0, 32)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $fpHex = ([BitConverter]::ToString($sha.ComputeHash($rawPub32))).Replace("-", "").ToLower()
    $pubkeyB64 = if ($raw -match "untrusted comment:") {
        [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text + "`n"))
    } else {
        $raw
    }
    return [ordered]@{
        keyIdHex         = $keyIdHex
        pubkeySha256     = $fpHex
        pubkeyB64        = $pubkeyB64
        purpose          = "external_tools_manifest"
        activationStatus = "staged_pending_stage1_embedding"
        retirementPolicy = "Replaceable via authenticated Desktop release (CDC23D8CC8DA5397) + TrustedToolsKeyring::revoked_key_ids"
    }
}

function Test-EncryptedMinisignSecretKey {
    param([string]$SecretKeyPath)
    if (-not (Test-Path $SecretKeyPath)) { return $false }
    $raw = (Get-Content -Raw $SecretKeyPath).Trim()
    $decoded = if ($raw -match "untrusted comment:") {
        $raw
    } else {
        [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw))
    }
    $lines = $decoded -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
    if ($lines.Count -lt 2) { return $false }
    $box = [Convert]::FromBase64String($lines[1])
    if ($box.Length -lt 10) { return $false }
    $algTag = [System.Text.Encoding]::ASCII.GetString($box, 0, 2)
    $kdfTag = [System.Text.Encoding]::ASCII.GetString($box, 2, 2)
    return (($lines[0] -match "encrypted secret key") -and ($algTag -eq "Ed") -and ($kdfTag -eq "Sc"))
}

function Test-OwnerOnlyAcl {
    param([string]$TargetPath)
    if (-not (Test-Path $TargetPath)) { return $false }
    $aclText = (& icacls $TargetPath | Out-String)
    return (($aclText -notmatch "\(I\)") -and ($aclText -notmatch "Everyone|BUILTIN\\Users"))
}

function Apply-OwnerOnlyAcl {
    param([string]$TargetPath)
    $user = "$env:USERDOMAIN\$env:USERNAME"
    & icacls $TargetPath /inheritance:r /grant:r "${user}:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed restricting NTFS ACLs on $TargetPath (icacls exit=$LASTEXITCODE)"
    }
}

function Invoke-VerifySigNode {
    param([string]$PubKeyB64, [string]$PayloadFile, [string]$SigFile)
    $js = @'
const fs = require('fs');
const crypto = require('crypto');
const [pubB64, payloadPath, sigPath] = process.argv.slice(-3);
const decPub = Buffer.from(pubB64, 'base64').toString('utf8').trim().split(/\r?\n/);
const pkRaw = Buffer.from(decPub[1].trim(), 'base64');
const keyId = pkRaw.subarray(2, 10);
const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pkRaw.subarray(10, 42)]);
const pubKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
const dataBuf = fs.readFileSync(payloadPath);
const sigB64 = fs.readFileSync(sigPath, 'utf8').trim();
const sigText = sigB64.includes('\n') ? sigB64 : Buffer.from(sigB64, 'base64').toString('utf8').trim();
const lines = sigText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
const sigRaw = Buffer.from(lines[1], 'base64');
const alg = sigRaw.subarray(0, 2).toString('ascii');
if (!sigRaw.subarray(2, 10).equals(keyId)) process.exit(2);
const sigBytes = sigRaw.subarray(10, 74);
const tc = lines[2].slice('trusted comment: '.length);
const gsig = Buffer.from(lines[3], 'base64');
const msg = alg === 'ED' ? crypto.createHash('blake2b512').update(dataBuf).digest() : dataBuf;
const ok1 = crypto.verify(null, msg, pubKey, sigBytes);
const ok2 = crypto.verify(null, Buffer.concat([sigBytes, Buffer.from(tc, 'utf8')]), pubKey, gsig);
if (!ok1 || !ok2) process.exit(3);
console.log('SIG_VERIFIED_OK');
'@
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = $js | & node - $PubKeyB64 $PayloadFile $SigFile 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    return ($code -eq 0 -and (($out | Out-String) -match "SIG_VERIFIED_OK"))
}

if ($Mode -eq "AuditCustody") {
    $updaterKey = Join-Path $KeyDir "tori-updater.key"
    $updaterPub = Join-Path $KeyDir "tori-updater.key.pub"
    $toolsKey = Join-Path $KeyDir "tori-tools.key"
    $toolsPub = Join-Path $KeyDir "tori-tools.key.pub"
    $toolsPwd = Join-Path $KeyDir "tori-tools.key.pwd"
    $dirAclHardened = Test-OwnerOnlyAcl -TargetPath $KeyDir
    $toolsKeyAclHardened = Test-OwnerOnlyAcl -TargetPath $toolsKey
    $toolsEncrypted = Test-EncryptedMinisignSecretKey -SecretKeyPath $toolsKey

    $updaterMeta = if (Test-Path $updaterPub) { Parse-MinisignPublicKey -PubFilePath $updaterPub } else { $null }
    $toolsMeta = if (Test-Path $toolsPub) { Parse-MinisignPublicKey -PubFilePath $toolsPub } else { $null }

    $custodyStatus = if ((Test-Path $toolsKey) -and (Test-Path $toolsPub) -and $toolsEncrypted -and $toolsKeyAclHardened -and (-not (Test-Path $toolsPwd))) {
        "PRODUCTION_KEY_PRESENT_VERIFY_OFFLINE_BACKUP"
    } else {
        "PRODUCTION_KEY_PROVISIONING_PENDING"
    }

    [ordered]@{
        mode                       = "AuditCustody"
        custodyStatus              = $custodyStatus
        keyDir                     = $KeyDir
        updaterKeyExists           = Test-Path $updaterKey
        updaterKeyId               = if ($updaterMeta) { $updaterMeta.keyIdHex } else { $null }
        dedicatedToolsKeyExists    = Test-Path $toolsKey
        dedicatedToolsPubExists    = Test-Path $toolsPub
        dedicatedToolsEncrypted    = $toolsEncrypted
        dedicatedToolsAclOwnerOnly = $toolsKeyAclHardened
        dedicatedToolsPlaintextPwd = Test-Path $toolsPwd
        dedicatedToolsKeyId        = if ($toolsMeta) { $toolsMeta.keyIdHex } else { $null }
        dedicatedToolsPubSha256    = if ($toolsMeta) { $toolsMeta.pubkeySha256 } else { $null }
        keyDirAclHardenedOwnerOnly = $dirAclHardened
        plaintextPwdFilesPresent   = @(Get-ChildItem $KeyDir -Filter "*.pwd" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
        recommendedOperatorCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision_dedicated_tools_key.ps1 -Mode ProductionInteractive'
    } | ConvertTo-Json -Depth 5
    exit 0
}

if ($Mode -eq "VerifyProductionKey") {
    $toolsKey = Join-Path $KeyDir "tori-tools.key"
    $toolsPub = Join-Path $KeyDir "tori-tools.key.pub"
    $toolsPwd = Join-Path $KeyDir "tori-tools.key.pwd"
    if (-not (Test-Path $toolsKey) -or -not (Test-Path $toolsPub)) {
        [ordered]@{
            mode = "VerifyProductionKey"
            status = "PRODUCTION_KEY_PROVISIONING_PENDING"
            message = "Production dedicated key files not found at $toolsKey / $toolsPub"
        } | ConvertTo-Json -Depth 4
        exit 2
    }
    $encOk = Test-EncryptedMinisignSecretKey -SecretKeyPath $toolsKey
    $aclOk = Test-OwnerOnlyAcl -TargetPath $toolsKey
    $noPwd = -not (Test-Path $toolsPwd)
    $meta = Parse-MinisignPublicKey -PubFilePath $toolsPub
    $independent = ($meta.keyIdHex -ne $UPDATER_KEY_ID)
    $ok = $encOk -and $aclOk -and $noPwd -and $independent
    [ordered]@{
        mode                   = "VerifyProductionKey"
        status                 = if ($ok) { "VALID_PRODUCTION_KEY" } else { "CUSTODY_CHECK_FAILED" }
        encryptedScryptKey     = $encOk
        ntfsAclOwnerOnly       = $aclOk
        noPlaintextPwdFile     = $noPwd
        independentFromUpdater = $independent
        keyIdHex               = $meta.keyIdHex
        pubkeySha256           = $meta.pubkeySha256
        pubkeyB64              = $meta.pubkeyB64
        rustConstantsPreview   = @(
            "pub const TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64: Option<&str> = Some(`"$($meta.pubkeyB64)`");",
            "pub const TORI_DEDICATED_TOOLS_ED25519_KEY_ID: Option<&str> = Some(`"$($meta.keyIdHex)`");"
        )
    } | ConvertTo-Json -Depth 5
    if (-not $ok) { exit 1 }
    exit 0
}

if ($Mode -eq "VerifyBackup") {
    if (-not $BackupDir) { throw "Specify -BackupDir pointing to the offline encrypted backup directory." }
    $activeKey = Join-Path $KeyDir "tori-tools.key"
    $activePub = Join-Path $KeyDir "tori-tools.key.pub"
    $bakKey = Join-Path $BackupDir "tori-tools.key"
    $bakPub = Join-Path $BackupDir "tori-tools.key.pub"
    foreach ($f in @($activeKey, $activePub, $bakKey, $bakPub)) {
        if (-not (Test-Path $f)) { throw "Required file missing for backup verification: $f" }
    }
    $hActKey = (Get-FileHash $activeKey -Algorithm SHA256).Hash.ToLower()
    $hBakKey = (Get-FileHash $bakKey -Algorithm SHA256).Hash.ToLower()
    $hActPub = (Get-FileHash $activePub -Algorithm SHA256).Hash.ToLower()
    $hBakPub = (Get-FileHash $bakPub -Algorithm SHA256).Hash.ToLower()
    $bakEnc = Test-EncryptedMinisignSecretKey -SecretKeyPath $bakKey
    $meta = Parse-MinisignPublicKey -PubFilePath $bakPub
    $roundtripOk = $null
    if ($VerifyPassphrase.IsPresent) {
        $sec = Read-Host -Prompt "Enter backup passphrase to run non-destructive sign/verify recovery test" -AsSecureString
        $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        $tmpPayload = Join-Path ([System.IO.Path]::GetTempPath()) ("tori_bak_verify_" + [Guid]::NewGuid().ToString("N") + ".json")
        try {
            $p = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b)
            '{"recovery_check":true}' | Set-Content -Path $tmpPayload -NoNewline -Encoding UTF8
            Push-Location $RepoRoot
            try {
                & cargo tauri signer sign -f $bakKey -p $p $tmpPayload 2>&1 | Out-Null
                $roundtripOk = ($LASTEXITCODE -eq 0) -and (Invoke-VerifySigNode -PubKeyB64 $meta.pubkeyB64 -PayloadFile $tmpPayload -SigFile "$tmpPayload.sig")
            } finally { Pop-Location }
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
            Remove-Item $tmpPayload, "$tmpPayload.sig" -Force -ErrorAction SilentlyContinue
        }
    }
    $allOk = ($hActKey -eq $hBakKey) -and ($hActPub -eq $hBakPub) -and $bakEnc -and ($roundtripOk -ne $false)
    [ordered]@{
        mode                  = "VerifyBackup"
        status                = if ($allOk) { "BACKUP_VERIFIED" } else { "BACKUP_MISMATCH" }
        encryptedKeyMatch     = ($hActKey -eq $hBakKey)
        publicKeyMatch        = ($hActPub -eq $hBakPub)
        backupScryptEncrypted = $bakEnc
        keyIdHex              = $meta.keyIdHex
        pubkeySha256          = $meta.pubkeySha256
        passphraseRoundtripOk = $roundtripOk
    } | ConvertTo-Json -Depth 4
    if (-not $allOk) { exit 1 }
    exit 0
}

if ($Mode -eq "TestIsolated") {
    if (Test-Path $TestOutDir) { Remove-Item -Recurse -Force $TestOutDir }
    New-Item -ItemType Directory -Force -Path $TestOutDir | Out-Null

    $testKeyPath = Join-Path $TestOutDir "tori-tools-test-only.key"
    $testPubPath = "$testKeyPath.pub"
    $bakDir = Join-Path $TestOutDir "simulated_offline_backup"
    New-Item -ItemType Directory -Force -Path $bakDir | Out-Null
    $ephemeralPwd = "Gate33_3_TestOnly_" + ([Guid]::NewGuid().ToString("N"))

    Push-Location $RepoRoot
    try {
        & cargo tauri signer generate -w $testKeyPath -p $ephemeralPwd --ci 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $testKeyPath) -or -not (Test-Path $testPubPath)) {
            throw "cargo tauri signer generate failed in TestIsolated mode (exit=$LASTEXITCODE)"
        }
        Apply-OwnerOnlyAcl -TargetPath $testKeyPath
        $aclRestricted = Test-OwnerOnlyAcl -TargetPath $testKeyPath
        $isEncrypted = Test-EncryptedMinisignSecretKey -SecretKeyPath $testKeyPath

        # Copy to simulated offline backup and test recovery signing from backup copy
        $bakKeyPath = Join-Path $bakDir "tori-tools-test-only.key"
        $bakPubPath = Join-Path $bakDir "tori-tools-test-only.key.pub"
        Copy-Item $testKeyPath $bakKeyPath -Force
        Copy-Item $testPubPath $bakPubPath -Force
        Apply-OwnerOnlyAcl -TargetPath $bakKeyPath

        $payloadPath = Join-Path $TestOutDir "test-manifest.json"
        '{"schema_version":2,"manifest_revision":2,"key_purpose":"external_tools_manifest"}' | Set-Content -Path $payloadPath -NoNewline -Encoding UTF8
        & cargo tauri signer sign -f $bakKeyPath -p $ephemeralPwd $payloadPath 2>&1 | Out-Null
        $sigPath = "$payloadPath.sig"
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $sigPath)) {
            throw "cargo tauri signer sign failed in TestIsolated backup recovery check"
        }

        $meta = Parse-MinisignPublicKey -PubFilePath $testPubPath
        $sigVerified = Invoke-VerifySigNode -PubKeyB64 $meta.pubkeyB64 -PayloadFile $payloadPath -SigFile $sigPath
        # Verify tampered payload is strictly rejected
        $tamperedPath = Join-Path $TestOutDir "test-manifest-tampered.json"
        '{"schema_version":2,"manifest_revision":9,"key_purpose":"external_tools_manifest"}' | Set-Content -Path $tamperedPath -NoNewline -Encoding UTF8
        $tamperRejected = -not (Invoke-VerifySigNode -PubKeyB64 $meta.pubkeyB64 -PayloadFile $tamperedPath -SigFile $sigPath)
        $independent = ($meta.keyIdHex -ne $UPDATER_KEY_ID)

        # Immediately destroy all test private keys
        Remove-Item $testKeyPath, $bakKeyPath -Force -ErrorAction SilentlyContinue

        $allOk = $isEncrypted -and $aclRestricted -and $independent -and $sigVerified -and $tamperRejected
        [ordered]@{
            mode                   = "TestIsolated"
            status                 = if ($allOk) { "PASS" } else { "FAIL" }
            isNonProductionTest    = $true
            encryptedSecretKey     = $isEncrypted
            ntfsAclOwnerOnly       = $aclRestricted
            independentFromUpdater = $independent
            backupRecoverySignOk   = $sigVerified
            tamperPayloadRejected  = $tamperRejected
            testKeyIdHex           = $meta.keyIdHex
            testPubkeySha256       = $meta.pubkeySha256
            sigGeneratedBytes      = (Get-Item $sigPath).Length
            privateKeysCleanedUp   = ((-not (Test-Path $testKeyPath)) -and (-not (Test-Path $bakKeyPath)))
        } | ConvertTo-Json -Depth 5

        if (-not $allOk) { exit 1 }
    } finally {
        Pop-Location
    }
    exit 0
}

if ($Mode -eq "SignStagingTest") {
    if (-not $ManifestPath -or -not (Test-Path $ManifestPath)) {
        throw "Specify -ManifestPath pointing to a non-production staging manifest JSON."
    }
    $resolvedManifest = (Resolve-Path $ManifestPath).Path
    if ($resolvedManifest -match "\\tori-website\\assets\\tools\\tools-manifest\.json$") {
        throw "SAFETY_ABORT: -Mode SignStagingTest refuses to sign live production website manifest paths!"
    }
    $toolsKey = Join-Path $KeyDir "tori-tools.key"
    $toolsPub = Join-Path $KeyDir "tori-tools.key.pub"
    if (-not (Test-Path $toolsKey) -or -not (Test-Path $toolsPub)) {
        throw "Production dedicated key not found at $toolsKey"
    }
    $meta = Parse-MinisignPublicKey -PubFilePath $toolsPub
    $sec = Read-Host -Prompt "Enter tori-tools.key passphrase to sign non-production staging manifest" -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try {
        $p = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b)
        Push-Location $RepoRoot
        try {
            & cargo tauri signer sign -f $toolsKey -p $p $resolvedManifest 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Signing failed (exit=$LASTEXITCODE)" }
            $sigOk = Invoke-VerifySigNode -PubKeyB64 $meta.pubkeyB64 -PayloadFile $resolvedManifest -SigFile "$resolvedManifest.sig"
            if (-not $sigOk) { throw "Post-sign cryptographic verification failed!" }
        } finally { Pop-Location }
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
    }
    [ordered]@{
        mode = "SignStagingTest"
        status = "SIGNED_AND_VERIFIED"
        manifestPath = $resolvedManifest
        sigPath = "$resolvedManifest.sig"
        signingKeyId = $meta.keyIdHex
        pubkeySha256 = $meta.pubkeySha256
    } | ConvertTo-Json -Depth 4
    exit 0
}

if ($Mode -eq "ProductionInteractive") {
    New-Item -ItemType Directory -Force -Path $KeyDir | Out-Null
    $toolsKeyPath = Join-Path $KeyDir "tori-tools.key"
    $toolsPubPath = "$toolsKeyPath.pub"
    $updaterKeyPath = Join-Path $KeyDir "tori-updater.key"

    if ((Test-Path $toolsKeyPath) -and (-not $ForceRotate.IsPresent)) {
        throw "Refusing to overwrite existing production key $toolsKeyPath (pass -ForceRotate only during an authorized rotation)."
    }
    if (-not (Test-Path $updaterKeyPath)) {
        Write-Warning "Desktop updater key $updaterKeyPath not found; proceeding strictly for dedicated tori-tools.key."
    }

    Write-Host "=== TORI PRODUCTION DEDICATED EXTERNAL TOOLS KEY PROVISIONING ==="
    Write-Host "Target: $toolsKeyPath (Desktop updater key tori-updater.key will NOT be modified)"
    $sec1 = Read-Host -Prompt "Enter a strong dedicated passphrase for tori-tools.key (min 16 chars, distinct from tori-updater.key)" -AsSecureString
    $sec2 = Read-Host -Prompt "Confirm passphrase" -AsSecureString
    $b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec1)
    $b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec2)
    $tmpProbe = Join-Path ([System.IO.Path]::GetTempPath()) ("tori_prod_key_verify_" + [Guid]::NewGuid().ToString("N") + ".json")
    try {
        $p1 = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b1)
        $p2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b2)
        if ($p1 -ne $p2) { throw "Passphrases do not match; aborting." }
        if ($p1.Length -lt 16) { throw "Passphrase too short (minimum 16 characters required for production custody)." }

        Push-Location $RepoRoot
        try {
            & cargo tauri signer generate -w $toolsKeyPath -p $p1 --ci 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path $toolsKeyPath) -or -not (Test-Path $toolsPubPath)) {
                throw "cargo tauri signer generate failed (exit=$LASTEXITCODE)"
            }
            if (-not (Test-EncryptedMinisignSecretKey -SecretKeyPath $toolsKeyPath)) {
                Remove-Item $toolsKeyPath, $toolsPubPath -Force -ErrorAction SilentlyContinue
                throw "Generated secret key failed Ed/Sc scrypt encryption verification; deleted immediately."
            }
            Apply-OwnerOnlyAcl -TargetPath $toolsKeyPath
            $meta = Parse-MinisignPublicKey -PubFilePath $toolsPubPath
            if ($meta.keyIdHex -eq $UPDATER_KEY_ID) {
                throw "CRITICAL: Generated key ID unexpectedly collided with Desktop updater key!"
            }
            # Immediate private/public consistency roundtrip test
            '{"key_consistency_check":true}' | Set-Content -Path $tmpProbe -NoNewline -Encoding UTF8
            & cargo tauri signer sign -f $toolsKeyPath -p $p1 $tmpProbe 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0 -or -not (Invoke-VerifySigNode -PubKeyB64 $meta.pubkeyB64 -PayloadFile $tmpProbe -SigFile "$tmpProbe.sig")) {
                throw "Generated key failed immediate sign/verify consistency check!"
            }
        } finally {
            Pop-Location
        }
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b1)
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2)
        Remove-Item $tmpProbe, "$tmpProbe.sig" -Force -ErrorAction SilentlyContinue
    }

    Write-Host "`n[SUCCESS] Production dedicated External Tools key generated, scrypt-encrypted, ACL-hardened & verified."
    Write-Host "ZERO plaintext .pwd files were written."
    Write-Host "Mandatory Next Steps:"
    Write-Host "  1. Copy encrypted $toolsKeyPath + $toolsPubPath to an offline encrypted backup medium separate from tori-updater.key."
    Write-Host "  2. Verify backup: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision_dedicated_tools_key.ps1 -Mode VerifyBackup -BackupDir <BACKUP_DIR> -VerifyPassphrase"
    Write-Host "  3. Embed ONLY the public key below into crates/tdm-core/src/tools/trust.rs (TORI_DEDICATED_TOOLS_ED25519_*)."
    $meta | ConvertTo-Json -Depth 4
    exit 0
}
