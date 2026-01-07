@echo off
setlocal enabledelayedexpansion

REM Qwen CLI Chrome Extension - Native Host Installation Script for Windows
REM This script installs the Native Messaging host for the Chrome extension

echo ========================================
echo Qwen CLI Chrome Extension - Native Host Installer
echo ========================================
echo.

REM Set variables
set HOST_NAME=com.qwen.cli.bridge
set SCRIPT_DIR=%~dp0
set HOST_SCRIPT=%SCRIPT_DIR%host.bat

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Error: Node.js is not installed
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

REM Check if qwen CLI is installed
where qwen >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Warning: qwen CLI is not installed
    echo Please install qwen CLI to use all features
    echo Installation will continue...
    echo.
)

REM Check if host files exist
if not exist "%HOST_SCRIPT%" (
    echo Error: host.bat not found in %SCRIPT_DIR%
    pause
    exit /b 1
)

if not exist "%SCRIPT_DIR%host.js" (
    echo Error: host.js not found in %SCRIPT_DIR%
    pause
    exit /b 1
)

REM Get extension ID
set /p EXTENSION_ID="Enter your Chrome extension ID (found in chrome://extensions): "

if "%EXTENSION_ID%"=="" (
    echo Error: Extension ID is required
    pause
    exit /b 1
)

REM Create manifest
set MANIFEST_FILE=%SCRIPT_DIR%manifest-windows.json
echo Creating manifest: %MANIFEST_FILE%

(
echo {
echo   "name": "%HOST_NAME%",
echo   "description": "Native messaging host for Qwen CLI Chrome Extension",
echo   "path": "%HOST_SCRIPT:\=\\%",
echo   "type": "stdio",
echo   "allowed_origins": [
echo     "chrome-extension://%EXTENSION_ID%/"
echo   ]
echo }
) > "%MANIFEST_FILE%"

REM Add registry entry for Chrome
echo.
echo Adding registry entry for Chrome...
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_FILE%" /f

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ✅ Installation complete!
    echo.
    echo Next steps:
    echo 1. Load the Chrome extension in chrome://extensions
    echo 2. Enable 'Developer mode'
    echo 3. Click 'Load unpacked' and select: %SCRIPT_DIR%..\extension
    echo 4. Copy the extension ID and re-run this script if needed
    echo 5. Click the extension icon and connect to Qwen CLI
    echo.
    echo Host manifest: %MANIFEST_FILE%
    echo Log file location: %%TEMP%%\qwen-bridge-host.log
) else (
    echo.
    echo ❌ Failed to add registry entry
    echo Please run this script as Administrator
)

echo.
pause
