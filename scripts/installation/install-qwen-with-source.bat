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

REM Check if Node.js is already installed
call :CheckCommandExists node
if !ERRORLEVEL! EQU 0 (
    for /f "delims=" %%i in ('node --version') do set "NODE_VERSION=%%i"
    echo INFO: Node.js is already installed: !NODE_VERSION!
    
    REM Extract major version number
    set "MAJOR_VERSION=!NODE_VERSION:v=!"
    for /f "tokens=1 delims=." %%a in ("!MAJOR_VERSION!") do (
        set "MAJOR_VERSION=%%a"
    )
    
    if !MAJOR_VERSION! GEQ 20 (
        echo INFO: Node.js version !NODE_VERSION! is sufficient. Skipping Node.js installation.
        goto :InstallQwenCode
    ) else (
        echo INFO: Node.js version !NODE_VERSION! is too low. Need version 20 or higher.
        echo INFO: Installing Node.js 20+
        call :InstallNodeJSDirectly
        if !ERRORLEVEL! NEQ 0 (
            echo ERROR: Failed to install Node.js. Cannot continue with Qwen Code installation.
            exit /b 1
        )
    )
) else (
    echo INFO: Node.js not found. Installing Node.js 20+
    call :InstallNodeJSDirectly
    if !ERRORLEVEL! NEQ 0 (
        echo ERROR: Failed to install Node.js. Cannot continue with Qwen Code installation.
        exit /b 1
    )
)

:InstallQwenCode

REM Verify npm is available before installing Qwen Code
REM Always use full path to npm to avoid local node_modules conflicts
set "NODEJS_PATH=C:\Program Files\nodejs"
set "NODEJS_PATH_X86=C:\Program Files (x86)\nodejs"

if exist "!NODEJS_PATH!\npm.cmd" (
    echo INFO: Using npm from !NODEJS_PATH!
    set "NPM_CMD=!NODEJS_PATH!\npm.cmd"
) else if exist "!NODEJS_PATH_X86!\npm.cmd" (
    echo INFO: Using npm from !NODEJS_PATH_X86!
    set "NPM_CMD=!NODEJS_PATH_X86!\npm.cmd"
) else (
    call :CheckCommandExists npm
    if !ERRORLEVEL! NEQ 0 (
        echo ERROR: npm command not found. Node.js installation may have failed.
        echo INFO: Please restart your command prompt and try again.
        echo INFO: If the problem persists, manually install Node.js from: https://nodejs.org/
        exit /b 1
    )
    set "NPM_CMD=npm"
)

REM Install Qwen Code with source information
echo INFO: Installing Qwen Code with source: %SOURCE%
echo INFO: Running: %NPM_CMD% install -g @qwen-code/qwen-code
call "%NPM_CMD%" install -g @qwen-code/qwen-code

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
REM Function: InstallNodeJSDirectly
REM Description: Download and install Node.js directly from official website
REM ============================================================
:InstallNodeJSDirectly
echo INFO: Downloading Node.js LTS (20.x) from official website

REM Create temp directory for download
set "TEMP_DIR=%TEMP%\qwen-nodejs-install"
if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%"

REM Determine architecture
set "ARCH=x64"
if "%PROCESSOR_ARCHITECTURE%"=="x86" set "ARCH=x86"
if "%PROCESSOR_ARCHITECTURE%"=="AMD64" set "ARCH=x64"
if defined PROCESSOR_ARCHITEW6432 set "ARCH=x64"

REM Set Node.js download URL (LTS version 20.x)
set "NODE_VERSION=20.18.1"
set "NODE_URL=https://nodejs.org/dist/v!NODE_VERSION!/node-v!NODE_VERSION!-!ARCH!.msi"
set "NODE_INSTALLER=%TEMP_DIR%\nodejs-installer.msi"

echo INFO: Downloading from: !NODE_URL!
echo INFO: Architecture: !ARCH!

REM Download Node.js installer using PowerShell
powershell -Command "try { Invoke-WebRequest -Uri '!NODE_URL!' -OutFile '!NODE_INSTALLER!' -UseBasicParsing; Write-Host 'Download completed successfully.' } catch { Write-Host 'Download failed:' $_.Exception.Message; exit 1 }"

if !ERRORLEVEL! NEQ 0 (
    echo ERROR: Failed to download Node.js installer from official source.
    echo INFO: Please manually download and install Node.js from: https://nodejs.org/
    echo INFO: After manual installation, restart your command prompt and run this script again.
    exit /b 1
)

if not exist "!NODE_INSTALLER!" (
    echo ERROR: Node.js installer not found after download.
    exit /b 1
)

echo INFO: Installing Node.js silently
REM Install Node.js silently
msiexec /i "!NODE_INSTALLER!" /quiet /norestart ADDLOCAL=ALL

if !ERRORLEVEL! NEQ 0 (
    echo ERROR: Failed to install Node.js.
    echo INFO: You may need to run this script as Administrator.
    echo INFO: Or manually install Node.js from: https://nodejs.org/
    exit /b 1
)

echo INFO: Node.js installation completed.

REM Clean up installer
del "!NODE_INSTALLER!" 2>nul
rmdir "!TEMP_DIR!" 2>nul

REM Refresh environment variables
echo INFO: Refreshing environment variables
call :RefreshEnvVars

REM Verify installation and return success
set "NODEJS_INSTALL_PATH=C:\Program Files\nodejs"
if exist "!NODEJS_INSTALL_PATH!\node.exe" (
    for /f "delims=" %%i in ('"!NODEJS_INSTALL_PATH!\node.exe" --version') do set "NODE_VERSION=%%i"
    echo SUCCESS: Node.js !NODE_VERSION! installed successfully!
    exit /b 0
)

set "NODEJS_INSTALL_PATH_X86=C:\Program Files (x86)\nodejs"
if exist "!NODEJS_INSTALL_PATH_X86!\node.exe" (
    for /f "delims=" %%i in ('"!NODEJS_INSTALL_PATH_X86!\node.exe" --version') do set "NODE_VERSION=%%i"
    echo SUCCESS: Node.js !NODE_VERSION! installed successfully!
    exit /b 0
)

call :CheckCommandExists node
if !ERRORLEVEL! EQU 0 (
    for /f "delims=" %%i in ('node --version') do set "NODE_VERSION=%%i"
    echo SUCCESS: Node.js !NODE_VERSION! installed successfully!
    exit /b 0
) else (
    echo WARNING: Node.js installed but not found in PATH.
    echo INFO: Trying to use Node.js from default installation path
    
    REM Try to use Node.js directly from installation path
    set "NODE_PATH=C:\Program Files\nodejs"
    if exist "%NODE_PATH%\node.exe" (
        echo INFO: Found Node.js at %NODE_PATH%
        REM Update PATH for current session
        set "PATH=%PATH%;%NODE_PATH%"
        
        REM Test if node works now
        "%NODE_PATH%\node.exe" --version >nul 2>&1
        if !ERRORLEVEL! EQU 0 (
            for /f "delims=" %%i in ('"%NODE_PATH%\node.exe" --version') do set "NODE_VERSION=%%i"
            echo SUCCESS: Node.js %NODE_VERSION% is working from %NODE_PATH%
            exit /b 0
        )
    )
    
    REM Try x86 path
    set "NODE_PATH_X86=C:\Program Files (x86)\nodejs"
    if exist "%NODE_PATH_X86%\node.exe" (
        echo INFO: Found Node.js at %NODE_PATH_X86%
        REM Update PATH for current session
        set "PATH=%PATH%;%NODE_PATH_X86%"
        
        REM Test if node works now
        "%NODE_PATH_X86%\node.exe" --version >nul 2>&1
        if !ERRORLEVEL! EQU 0 (
            for /f "delims=" %%i in ('"%NODE_PATH_X86%\node.exe" --version') do set "NODE_VERSION=%%i"
            echo SUCCESS: Node.js %NODE_VERSION% is working from %NODE_PATH_X86%
            exit /b 0
        )
    )
    
    echo ERROR: Node.js installation completed but cannot be executed
    exit /b 1
)

exit /b 0

REM ============================================================
REM Function: RefreshEnvVars
REM Description: Refresh environment variables without restarting
REM ============================================================
:RefreshEnvVars
REM Add Node.js to PATH if not already there
set "NODEJS_DIR=C:\Program Files\nodejs"
if exist "!NODEJS_DIR!\node.exe" (
    echo INFO: Found Node.js at !NODEJS_DIR!
    set "PATH=!PATH!;!NODEJS_DIR!"
)

REM Try alternative path for x86 systems
set "NODEJS_DIR_X86=C:\Program Files (x86)\nodejs"
if exist "!NODEJS_DIR_X86!\node.exe" (
    echo INFO: Found Node.js at !NODEJS_DIR_X86!
    set "PATH=!PATH!;!NODEJS_DIR_X86!"
)

exit /b 0
