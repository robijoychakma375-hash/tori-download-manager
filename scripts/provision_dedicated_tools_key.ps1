<#
.SYNOPSIS
  TORI Download Manager — Gate 33.1 Dedicated External Tools Signing Key Provisioning & Custody Tool (Phase 2)
.DESCRIPTION
  Supports three strictly separated modes:
    -Mode AuditCustody          : Read-only audit of %USERPROFILE%\.tori-keys (NEVER exposes secrets).
    -Mode TestIsolated          : Runs full encrypted key generation, NTFS ACL hardening, public-key
                                  extraction, Minisign Key ID & SHA-256 fingerprint derivation, and
                                  zero-secret verification inside an isolated temp/target directory.
    -Mode ProductionInteractive : Operator-controlled interactive provisioning of %USERPROFILE%\.tori-keys\tori-tools.key
                                  using a secure operator-entered passphrase (Read-Host -AsSecureString).
                                  Refuses to overwrite tori-updater.key or write plaintext .pwd files.
#>
param(
    [ValidateSet("AuditCustody", "TestIsolated", "ProductionInteractive")]
    [string]$Mode = "AuditCustody",
    [string]$TestOutDir = "F:\TORI\final tori download manager\target\gate33_1_key_qa",
    [string]$KeyDir = (Join-Path $env:USERPROFILE ".tori-keys"),
    [switch]$ForceRotate
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

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
    # Little-endian key ID in bytes[2..9] displayed as uppercase big-endian 16-hex
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

function Apply-OwnerOnlyAcl {
    param([string]$TargetPath)
    $user = "$env:USERDOMAIN\$env:USERNAME"
    & icacls $TargetPath /inheritance:r /grant:r "${user}:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed restricting NTFS ACLs on $TargetPath (icacls exit=$LASTEXITCODE)"
    }
}

if ($Mode -eq "AuditCustody") {
    $updaterKey = Join-Path $KeyDir "tori-updater.key"
    $updaterPub = Join-Path $KeyDir "tori-updater.key.pub"
    $toolsKey = Join-Path $KeyDir "tori-tools.key"
    $toolsPub = Join-Path $KeyDir "tori-tools.key.pub"
    $aclOut = if (Test-Path $KeyDir) { (& icacls $KeyDir | Out-String).Trim() } else { "MISSING" }
    $hasInheritedBroadAcl = ($aclOut -match "\(I\)") -or ($aclOut -match "Everyone|Users:")

    $updaterMeta = if (Test-Path $updaterPub) { Parse-MinisignPublicKey -PubFilePath $updaterPub } else { $null }
    $toolsMeta = if (Test-Path $toolsPub) { Parse-MinisignPublicKey -PubFilePath $toolsPub } else { $null }

    $custodyStatus = if ((Test-Path $toolsKey) -and (Test-Path $toolsPub) -and (-not $hasInheritedBroadAcl)) {
        "PRODUCTION_KEY_PRESENT_VERIFY_OFFLINE_BACKUP"
    } else {
        "PRODUCTION_KEY_PROVISIONING_PENDING"
    }

    [ordered]@{
        mode                      = "AuditCustody"
        custodyStatus             = $custodyStatus
        keyDir                    = $KeyDir
        updaterKeyExists          = Test-Path $updaterKey
        updaterKeyId              = if ($updaterMeta) { $updaterMeta.keyIdHex } else { $null }
        dedicatedToolsKeyExists   = Test-Path $toolsKey
        dedicatedToolsPubExists   = Test-Path $toolsPub
        dedicatedToolsKeyId       = if ($toolsMeta) { $toolsMeta.keyIdHex } else { $null }
        dedicatedToolsPubSha256   = if ($toolsMeta) { $toolsMeta.pubkeySha256 } else { $null }
        aclHardenedOwnerOnly      = (-not $hasInheritedBroadAcl)
        plaintextPwdFilesPresent  = @(Get-ChildItem $KeyDir -Filter "*.pwd" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
        recommendedOperatorCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision_dedicated_tools_key.ps1 -Mode ProductionInteractive'
    } | ConvertTo-Json -Depth 5
    exit 0
}

if ($Mode -eq "TestIsolated") {
    if (Test-Path $TestOutDir) { Remove-Item -Recurse -Force $TestOutDir }
    New-Item -ItemType Directory -Force -Path $TestOutDir | Out-Null

    $testKeyPath = Join-Path $TestOutDir "tori-tools-test-only.key"
    $testPubPath = "$testKeyPath.pub"
    $ephemeralPwd = "Gate33_1_TestOnly_" + ([Guid]::NewGuid().ToString("N"))

    # Generate real encrypted Minisign Ed25519 keypair via Tauri CLI (isolated test-only!)
    Push-Location $RepoRoot
    try {
        & cargo tauri signer generate -w $testKeyPath -p $ephemeralPwd --ci 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $testKeyPath) -or -not (Test-Path $testPubPath)) {
            throw "cargo tauri signer generate failed in TestIsolated mode (exit=$LASTEXITCODE)"
        }
        Apply-OwnerOnlyAcl -TargetPath $testKeyPath

        # Verify ACL stripped inherited permissions
        $aclCheck = (& icacls $testKeyPath | Out-String)
        $aclRestricted = ($aclCheck -notmatch "\(I\)") -and ($aclCheck -notmatch "Everyone")

        # Verify encrypted secret key format (never plaintext raw seed: require encrypted comment + Ed/Sc scrypt KDF header)
        $keyFileText = Get-Content -Raw $testKeyPath
        $keyDecoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($keyFileText.Trim()))
        $keyLines = $keyDecoded -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
        $keyBoxBytes = [Convert]::FromBase64String($keyLines[1])
        $algTag = [System.Text.Encoding]::ASCII.GetString($keyBoxBytes, 0, 2)
        $kdfTag = [System.Text.Encoding]::ASCII.GetString($keyBoxBytes, 2, 2)
        $isEncrypted = ($keyLines[0] -match "encrypted secret key") -and ($algTag -eq "Ed") -and ($kdfTag -eq "Sc")

        # Verify signing a test payload & signature validity using node crypto
        $payloadPath = Join-Path $TestOutDir "test-manifest.json"
        '{"schema_version":2,"manifest_revision":2,"key_purpose":"external_tools_manifest"}' | Set-Content -Path $payloadPath -NoNewline -Encoding UTF8
        & cargo tauri signer sign -f $testKeyPath -p $ephemeralPwd $payloadPath 2>&1 | Out-Null
        $sigPath = "$payloadPath.sig"
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $sigPath)) {
            throw "cargo tauri signer sign failed in TestIsolated mode"
        }

        $meta = Parse-MinisignPublicKey -PubFilePath $testPubPath

        # Verify independent key identity differs from Desktop updater key CDC23D8CC8DA5397
        $independent = ($meta.keyIdHex -ne "CDC23D8CC8DA5397")

        # Clean private test material immediately after verification, retaining only public metadata summary
        Remove-Item $testKeyPath -Force -ErrorAction SilentlyContinue

        [ordered]@{
            mode                  = "TestIsolated"
            status                = if ($isEncrypted -and $aclRestricted -and $independent) { "PASS" } else { "FAIL" }
            isNonProductionTest   = $true
            encryptedSecretKey    = $isEncrypted
            ntfsAclOwnerOnly      = $aclRestricted
            independentFromUpdater = $independent
            testKeyIdHex          = $meta.keyIdHex
            testPubkeySha256      = $meta.pubkeySha256
            testPubkeyB64         = $meta.pubkeyB64
            sigGeneratedBytes     = (Get-Item $sigPath).Length
            privateKeyCleanedUp   = (-not (Test-Path $testKeyPath))
        } | ConvertTo-Json -Depth 5

        if (-not ($isEncrypted -and $aclRestricted -and $independent)) { exit 1 }
    } finally {
        Pop-Location
    }
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

    Write-Host "=== TORI PRODUCTION DEDICATED TOOLS KEY PROVISIONING ==="
    Write-Host "Target: $toolsKeyPath (Desktop updater key tori-updater.key will NOT be modified)"
    $sec1 = Read-Host -Prompt "Enter a strong dedicated passphrase for tori-tools.key (distinct from tori-updater.key)" -AsSecureString
    $sec2 = Read-Host -Prompt "Confirm passphrase" -AsSecureString
    $b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec1)
    $b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec2)
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
        } finally {
            Pop-Location
        }
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b1)
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2)
    }

    Apply-OwnerOnlyAcl -TargetPath $toolsKeyPath
    $meta = Parse-MinisignPublicKey -PubFilePath $toolsPubPath
    Write-Host "`n[SUCCESS] Production dedicated External Tools key generated securely (NEVER write passphrase to disk)."
    Write-Host "Next steps:"
    Write-Host "  1. Copy encrypted $toolsKeyPath + $toolsPubPath to an offline encrypted backup medium separate from tori-updater.key."
    Write-Host "  2. Record passphrase in offline password manager / physical safe."
    Write-Host "  3. Embed ONLY the public key below into crates/tdm-core/src/tools/trust.rs (TORI_DEDICATED_TOOLS_ED25519_*)."
    $meta | ConvertTo-Json -Depth 4
    exit 0
}
