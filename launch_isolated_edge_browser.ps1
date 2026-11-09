# TORI v1.0.1-rc1 — Isolated Microsoft Edge Extension QA Launcher (PowerShell)
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$QaRoot = Join-Path $ScriptDir "qa_manual_env"
$QaEdge = Join-Path $QaRoot "edge_profile"
$ExtDir = Join-Path $ScriptDir "release\v1.0.1-rc\extension"

New-Item -ItemType Directory -Force -Path $QaEdge | Out-Null

$env:TORI_DATA_DIR = Join-Path $QaRoot "data"
$env:TORI_IPC_PIPE = "\\.\pipe\tori-qa-manual-ipc"

$EdgeCands = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
)

$EdgePath = $null
foreach ($c in $EdgeCands) {
    if (Test-Path $c) {
        $EdgePath = $c
        break
    }
}

if (-not $EdgePath) {
    Write-Error "Microsoft Edge executable not found at standard installation paths."
}

$Args = @(
    "--user-data-dir=$QaEdge",
    "--load-extension=$ExtDir",
    "--no-first-run",
    "--no-default-browser-check",
    "http://127.0.0.1:19600/api/v1/ping"
)

Start-Process -FilePath $EdgePath -ArgumentList $Args
