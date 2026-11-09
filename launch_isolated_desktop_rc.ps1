# TORI Download Manager v1.0.1-rc1 — Isolated Desktop QA Launcher (PowerShell)
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$QaRoot = Join-Path $ScriptDir "qa_manual_env"
$QaData = Join-Path $QaRoot "data"
$QaDownloads = Join-Path $QaRoot "downloads"
$QaWv2 = Join-Path $QaRoot "webview2_profile"
$QaDb = Join-Path $QaData "tdm_storage.sqlite"
$RcExe = Join-Path $ScriptDir "release\v1.0.1-rc\bin\tori-download-manager.exe"

New-Item -ItemType Directory -Force -Path $QaData, $QaDownloads, $QaWv2 | Out-Null

if (-not (Test-Path $QaDb)) {
    $SeedScript = Join-Path $ScriptDir "scripts\seed_qa_database.py"
    & python $SeedScript $QaDb $QaDownloads | Out-Null
}

$env:TORI_DATA_DIR = $QaData
$env:TORI_IPC_PIPE = "\\.\pipe\tori-qa-manual-ipc"
$env:WEBVIEW2_USER_DATA_FOLDER = $QaWv2

if (-not (Test-Path $RcExe)) {
    Write-Error "Release Candidate executable not found at: $RcExe"
}

Start-Process -FilePath $RcExe
