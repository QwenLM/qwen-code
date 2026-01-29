@echo off
REM Script to install Node.js and Qwen Code with source information
REM This script handles the installation process and sets the installation source
REM
REM Usage: install-qwen-with-source.bat --source [github|npm|internal|local-build]
REM        install-qwen-with-source.bat -s [github|npm|internal|local-build]
REM

setlocal enabledelayedexpansion

set "SOURCE=unknown"

REM Parse command line arguments
:parse_args
if "%~1"=="" goto end_parse
if /i "%~1"=="--source" (
    set "SOURCE=%~2"
    shift
    shift
    goto parse_args
)
if /i "%~1"=="-s" (
    set "SOURCE=%~2"
    shift
    shift
    goto parse_args
)
if /i "%~1"=="github" set "SOURCE=github"
if /i "%~1"=="npm" set "SOURCE=npm"
if /i "%~1"=="internal" set "SOURCE=internal"
if /i "%~1"=="local-build" set "SOURCE=local-build"
shift
goto parse_args

:end_parse

echo ===========================================
echo Qwen Code Installation Script with Source Tracking
echo ===========================================
echo.
echo INFO: Installation source: %SOURCE%
echo.

REM Function to check if a command exists
call :CheckCommandExists node
if %ERRORLEVEL% EQU 0 (
    for /f "delims=" %%i in ('node --version') do set "NODE_VERSION=%%i"
    echo INFO: Node.js is already installed: %NODE_VERSION%
    
    REM Extract major version number
    set "MAJOR_VERSION=%NODE_VERSION:v=%"
    for /f "tokens=1 delims=." %%a in ("%MAJOR_VERSION%") do (
        set "MAJOR_VERSION=%%a"
    )
    
    if !MAJOR_VERSION! GEQ 20 (
        echo INFO: Node.js version is sufficient.
    ) else (
        echo INFO: Node.js version is too low. Installing Node.js 20+...
        call :InstallNodeJSViaNVM
    )
) else (
    echo INFO: Node.js not found. Installing Node.js 20+...
    call :InstallNodeJSViaNVM
)

REM Install Qwen Code with source information
echo INFO: Installing Qwen Code with source: %SOURCE%
echo INFO: Running: npm install -g @qwen-code/qwen-code
call npm install -g @qwen-code/qwen-code

if %ERRORLEVEL% EQU 0 (
    echo SUCCESS: Qwen Code installed successfully!
) else (
    echo ERROR: Failed to install Qwen Code.
    exit /b 1
)

REM After installation, create source.json in the .qwen directory
echo INFO: Creating source.json in %USERPROFILE%\.qwen...

set "QWEN_DIR=%USERPROFILE%\.qwen"
if not exist "%QWEN_DIR%" (
    mkdir "%QWEN_DIR%"
)

REM Create the source.json file with the installation source
echo { > "%QWEN_DIR%\source.json"
echo   "source": "%SOURCE%" >> "%QWEN_DIR%\source.json"
echo } >> "%QWEN_DIR%\source.json"

echo SUCCESS: Installation source saved to %USERPROFILE%\.qwen\source.json

REM Verify installation
call :CheckCommandExists qwen
if %ERRORLEVEL% EQU 0 (
    echo SUCCESS: Qwen Code is available as 'qwen' command.
    call qwen --version
) else (
    echo WARNING: Qwen Code may not be in PATH. Please check your npm global bin directory.
)

echo.
echo ===========================================
echo SUCCESS: Installation completed!
echo The source information is stored in %USERPROFILE%\.qwen\source.json
echo.
echo To verify the installation:
echo   qwen --version
echo   type %USERPROFILE%\.qwen\source.json
echo ===========================================

endlocal
exit /b 0

REM ============================================================
REM Function: CheckCommandExists
REM Description: Check if a command exists in the system
REM ============================================================
:CheckCommandExists
where %~1 >nul 2>&1
exit /b %ERRORLEVEL%

REM ============================================================
REM Function: InstallNodeJSViaNVM
REM Description: Install Node.js via nvm-windows
REM ============================================================
:InstallNodeJSViaNVM
echo INFO: Installing Node Version Manager (NVM) for Windows...

REM Check if nvm is already installed
call :CheckCommandExists nvm
if %ERRORLEVEL% EQU 0 (
    echo INFO: NVM is already installed.
) else (
    echo INFO: Please install NVM for Windows manually from:
    echo https://github.com/coreybutler/nvm-windows/releases
    echo.
    echo After installing NVM, run this script again.
    exit /b 1
)

REM Install and use Node.js 20
echo INFO: Installing Node.js 20...
call nvm install 20
call nvm use 20

for /f "delims=" %%i in ('node --version') do set "NODE_VERSION=%%i"
echo INFO: Node.js %NODE_VERSION% installed and activated via NVM.
exit /b 0
