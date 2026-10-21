@echo off
rem ASCII only on purpose: cmd.exe parses .cmd files with the system ANSI
rem codepage (GBK here), and a multi-byte character can swallow the next
rem newline, merging two lines into one broken command.
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Paste Manager

rem Keep npm and the Electron runtime cached inside the project folder.
rem The variable name must be electron_config_cache - that is the only one
rem @electron/get reads.
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "electron_config_cache=%~dp0.electron-cache"

rem Defensive: if the shell that launched this already has ELECTRON_RUN_AS_NODE
rem set (some Electron-based tools export it to their children), the electron
rem binary would run as plain Node and the app would die instantly with
rem "Cannot read properties of undefined (reading 'setAppUserModelId')".
set "ELECTRON_RUN_AS_NODE="

if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/3] Installing dependencies ^(first run downloads about 100 MB^)...
  call npm install
  if errorlevel 1 goto fail
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [2/3] Fetching the Electron runtime...
  node "node_modules\electron\install.js"
  if errorlevel 1 goto fail
)

echo [3/3] Starting Paste Manager...
echo.
echo     Press Ctrl+Shift+V to show the panel, or click the tray icon.
echo     Keep this window open - closing it stops the app.
echo.

if exist "node_modules\.bin\electron.cmd" (
  call "node_modules\.bin\electron.cmd" .
) else (
  call npx electron .
)
if errorlevel 1 pause
exit /b 0

:fail
echo.
echo Install failed. Check your network connection and run start.cmd again.
pause
exit /b 1
