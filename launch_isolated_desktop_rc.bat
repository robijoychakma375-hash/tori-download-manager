@echo off
setlocal
cd /d "%~dp0"

set "QA_ROOT=%~dp0qa_manual_env"
set "QA_DATA=%QA_ROOT%\data"
set "QA_DOWNLOADS=%QA_ROOT%\downloads"
set "QA_WEBVIEW2=%QA_ROOT%\webview2_profile"
set "QA_DB=%QA_DATA%\tdm_storage.sqlite"
set "RC_EXE=%~dp0release\v1.0.1-rc\bin\tori-download-manager.exe"

if not exist "%QA_DATA%" mkdir "%QA_DATA%"
if not exist "%QA_DOWNLOADS%" mkdir "%QA_DOWNLOADS%"
if not exist "%QA_WEBVIEW2%" mkdir "%QA_WEBVIEW2%"

rem Ensure isolated database is seeded with isolated port 19600 and secure random token
if not exist "%QA_DB%" (
    python "%~dp0scripts\seed_qa_database.py" "%QA_DB%" "%QA_DOWNLOADS%" >nul 2>&1
)

set "TORI_DATA_DIR=%QA_DATA%"
set "TORI_IPC_PIPE=\\.\pipe\tori-qa-manual-ipc"
set "WEBVIEW2_USER_DATA_FOLDER=%QA_WEBVIEW2%"

if not exist "%RC_EXE%" (
    echo [ERROR] Release Candidate executable not found at: %RC_EXE%
    pause
    exit /b 1
)

start "" "%RC_EXE%"
exit /b 0
