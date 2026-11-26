$ErrorActionPreference = 'Stop'
Set-Location "F:\TORI\final tori download manager"

$rcDir = "F:\TORI\final tori download manager\release\v1.0.9-rc"
New-Item -ItemType Directory -Force -Path $rcDir | Out-Null

$nsisSetup = "F:\TORI\final tori download manager\target\release\bundle\nsis\TORI Download Manager_1.0.9_x64-setup.exe"
$nsisSig   = "$nsisSetup.sig"
$desktopExe = "F:\TORI\final tori download manager\target\release\tori-download-manager.exe"
$hostExe    = "F:\TORI\final tori download manager\target\release\tdm-native-host.exe"
$cliExe     = "F:\TORI\final tori download manager\target\release\tdm-cli.exe"

foreach ($p in @($nsisSetup, $nsisSig, $desktopExe, $hostExe, $cliExe)) {
  if (-not (Test-Path $p)) { throw "Missing required built artifact: $p" }
}

$destInstaller = Join-Path $rcDir "TORI.Download.Manager_1.0.9_x64-setup.exe"
$destSig       = Join-Path $rcDir "TORI.Download.Manager_1.0.9_x64-setup.exe.sig"
$destDesktop   = Join-Path $rcDir "tori-download-manager.exe"
$destHost      = Join-Path $rcDir "tdm-native-host.exe"
$destCli       = Join-Path $rcDir "tdm-cli.exe"
$destNotes     = Join-Path $rcDir "RELEASE_NOTES_v1.0.9.md"

Copy-Item $nsisSetup  $destInstaller -Force
Copy-Item $nsisSig    $destSig       -Force
Copy-Item $desktopExe $destDesktop   -Force
Copy-Item $hostExe    $destHost      -Force
Copy-Item $cliExe     $destCli       -Force
Copy-Item "docs\release\GATE36_1_DESKTOP_V109_RELEASE_NOTES.md" $destNotes -Force

function Get-ArtMeta($filePath) {
  $fi = Get-Item $filePath
  $sha = (Get-FileHash $filePath -Algorithm SHA256).Hash.ToLower()
  return [ordered]@{
    filename = $fi.Name
    bytes    = $fi.Length
    sha256   = $sha
  }
}

$nowUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$sigContent = (Get-Content -Raw $destSig).Trim()
$headCommit = (git rev-parse HEAD).Trim()
$branchName = (git rev-parse --abbrev-ref HEAD).Trim()

$installerUrl = "https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.9/TORI.Download.Manager_1.0.9_x64-setup.exe"

$draftLatest = [ordered]@{
  version  = "1.0.9"
  notes    = "TORI Download Manager Desktop v1.0.9 RC - Gate 35.1 security hardening, Gate 35.2 Content-Range mismatch safe single-stream fallback, Windows startup popup and spawn-mutex fixes, Stage 1 dual-key External Tools compatibility (rev 2), and full Browser Companion v1.0.11 integration (LOCAL UNPUBLISHED DRAFT)."
  pub_date = $nowUtc
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $sigContent
      url       = $installerUrl
    }
    "windows-x86_64-nsis" = [ordered]@{
      signature = $sigContent
      url       = $installerUrl
    }
  }
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$draftLatestPath = Join-Path $rcDir "draft_latest.json"
[System.IO.File]::WriteAllText($draftLatestPath, (($draftLatest | ConvertTo-Json -Depth 6) + "`n"), $utf8NoBom)

$mInst = Get-ArtMeta $destInstaller
$mSig  = Get-ArtMeta $destSig
$mDesk = Get-ArtMeta $destDesktop
$mHost = Get-ArtMeta $destHost
$mCli  = Get-ArtMeta $destCli
$mDraft = Get-ArtMeta $draftLatestPath
$mNotes = Get-ArtMeta $destNotes

$buildMeta = [ordered]@{
  gate                               = "Gate 36.1"
  version                            = "1.0.9"
  release_type                       = "desktop_v109_rc_local_unpublished"
  branch                             = $branchName
  source_commit                      = $headCommit
  baseline_gate35_1_commit           = "cb885d48cfcfc1557489a033984e12037c10ea80"
  baseline_gate35_2_commit           = "48184cb2b6d05d25e3ffc47f967f4ca11a82a025"
  baseline_gate35_5_checkpoint       = "checkpoint-gate35_5-companion-v1011-public-security-hotfix-released"
  public_desktop_preserved           = "v1.0.8 (GitHub Release ID 455125259)"
  public_companion_preserved         = "v1.0.11 (GitHub Release ID 458864802)"
  published                          = $false
  built_at_utc                       = $nowUtc
  tools_manifest_default_endpoint    = "https://toridownload.xyz/assets/tools/tools-manifest.json"
  desktop_updater_signing_key_id     = "CDC23D8CC8DA5397"
  dedicated_tools_public_key_id      = "C3FD6626A3718E63"
  dedicated_tools_public_key_sha256  = "6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39"
  stage1_dual_key_active             = $true
  dedicated_only_cutover_active      = $false
  authenticode_status                = "NotSigned (Pipeline Ready)"
  clean_windows_vm_qa_status         = "NOT TESTED (0 provisioned local Windows 10/11 VMs)"
  artifacts = [ordered]@{
    installer          = $mInst
    signature          = $mSig
    desktop_exe        = $mDesk
    native_host_exe    = $mHost
    cli_exe            = $mCli
    draft_latest_json  = $mDraft
    release_notes      = $mNotes
  }
}
$buildMetaPath = Join-Path $rcDir "BUILD_METADATA.json"
[System.IO.File]::WriteAllText($buildMetaPath, (($buildMeta | ConvertTo-Json -Depth 6) + "`n"), $utf8NoBom)

$sumsLines = @(
  "$($mInst.sha256) *$($mInst.filename)",
  "$($mSig.sha256) *$($mSig.filename)",
  "$($mDesk.sha256) *$($mDesk.filename)",
  "$($mHost.sha256) *$($mHost.filename)",
  "$($mCli.sha256) *$($mCli.filename)",
  "$($mDraft.sha256) *$($mDraft.filename)",
  "$($mNotes.sha256) *$($mNotes.filename)"
)
$sumsPath = Join-Path $rcDir "SHA256SUMS.txt"
[System.IO.File]::WriteAllText($sumsPath, (($sumsLines -join "`n") + "`n"), $utf8NoBom)

Write-Output "=== STAGED release/v1.0.9-rc/ SUCCESSFULLY ==="
Write-Output "INSTALLER=$($mInst.filename) BYTES=$($mInst.bytes) SHA256=$($mInst.sha256)"
Write-Output "SIGNATURE=$($mSig.filename) BYTES=$($mSig.bytes) SHA256=$($mSig.sha256)"
Write-Output "DESKTOP_EXE=$($mDesk.filename) BYTES=$($mDesk.bytes) SHA256=$($mDesk.sha256)"
Write-Output "NATIVE_HOST=$($mHost.filename) BYTES=$($mHost.bytes) SHA256=$($mHost.sha256)"
Write-Output "CLI_EXE=$($mCli.filename) BYTES=$($mCli.bytes) SHA256=$($mCli.sha256)"
