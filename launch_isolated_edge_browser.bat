@echo off
setlocal
cd /d "%~dp0"

set "QA_ROOT=%~dp0qa_manual_env"
set "QA_EDGE=%QA_ROOT%\edge_profile"
set "EXT_DIR=%~dp0release\v1.0.1-rc\extension"

if not exist "%QA_EDGE%" mkdir "%QA_EDGE%"

set "TORI_DATA_DIR=%QA_ROOT%\data"
set "TORI_IPC_PIPE=\\.\pipe\tori-qa-manual-ipc"

set "EDGE_EXE="
if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    set "EDGE_EXE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
) else if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
    set "EDGE_EXE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
)

if "%EDGE_EXE%"=="" (
    echo [ERROR] Microsoft Edge was not found on this system.
    pause
    exit /b 1
)

start "" "%EDGE_EXE%" --user-data-dir="%QA_EDGE%" --load-extension="%EXT_DIR%" --no-first-run --no-default-browser-check "http://127.0.0.1:19600/api/v1/ping"
exit /b 0
