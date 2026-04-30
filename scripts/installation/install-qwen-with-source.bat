@echo off
REM Qwen Code Installation Script
REM Installs Qwen Code from a standalone archive when available, with npm fallback.
REM This script intentionally does not install Node.js or change npm config.

setlocal enabledelayedexpansion

set "SOURCE=unknown"
set "METHOD=%QWEN_INSTALL_METHOD%"
set "MIRROR=github"
if not "%QWEN_INSTALL_MIRROR%"=="" set "MIRROR=%QWEN_INSTALL_MIRROR%"
set "BASE_URL=%QWEN_INSTALL_BASE_URL%"
set "ARCHIVE_PATH=%QWEN_INSTALL_ARCHIVE%"
set "VERSION=latest"
if not "%QWEN_INSTALL_VERSION%"=="" set "VERSION=%QWEN_INSTALL_VERSION%"
set "NPM_REGISTRY=https://registry.npmmirror.com"
if not "%QWEN_NPM_REGISTRY%"=="" set "NPM_REGISTRY=%QWEN_NPM_REGISTRY%"
set "INSTALL_BASE=%LOCALAPPDATA%\qwen-code"
set "INSTALL_DIR=%INSTALL_BASE%\qwen-code"
set "INSTALL_BIN_DIR=%INSTALL_BASE%\bin"

:parse_args
if "%~1"=="" goto end_parse
if /i "%~1"=="--source" (
    if "%~2"=="" (
        echo ERROR: --source requires a value
        exit /b 1
    )
    set "SOURCE=%~2"
    shift
    shift
    goto parse_args
)
if /i "%~1"=="-s" (
    if "%~2"=="" (
        echo ERROR: -s requires a value
        exit /b 1
    )
    set "SOURCE=%~2"
    shift
    shift
    goto parse_args
)
if /i "%~1"=="--method" (
    if "%~2"=="" (
        echo ERROR: --method requires a value
        exit /b 1
    )
    set "METHOD=%~2"
    shift
    shift
    goto parse_args
)
if /i "%~1"=="--mirror" (
    if "%~2"=="" (
        echo ERROR: --mirror requires a value
        exit /b 1
    )
    set "MIRROR=%~2"
    shift
    shift
    goto parse_args
)
if /i "%~1"=="--base-url" (
    if "%~2"=="" (
        echo ERROR: --base-url requires a value
        exit /b 1
    )
    set "BASE_URL=%~2"
    shift
    shift
    goto parse_args
)
if /i "%~1"=="--archive" (
    if "%~2"=="" (
        echo ERROR: --archive requires a value
        exit /b 1
    )
    set "ARCHIVE_PATH=%~2"
    shift
    shift
    goto parse_args
)
if /i "%~1"=="--version" (
    if "%~2"=="" (
        echo ERROR: --version requires a value
        exit /b 1
    )
    set "VERSION=%~2"
    shift
    shift
    goto parse_args
)
if /i "%~1"=="--registry" (
    if "%~2"=="" (
        echo ERROR: --registry requires a value
        exit /b 1
    )
    set "NPM_REGISTRY=%~2"
    shift
    shift
    goto parse_args
)
if /i "%~1"=="-h" goto usage
if /i "%~1"=="--help" goto usage

echo ERROR: Unknown option: %~1
echo.
goto usage_error

:end_parse

call :ValidateOptions
if %ERRORLEVEL% NEQ 0 exit /b 1

echo ===========================================
echo Qwen Code Installation Script
echo ===========================================
echo.
echo INFO: Install method: !METHOD!
if /i not "!METHOD!"=="npm" (
    echo INFO: Standalone mirror: !MIRROR!
    if not "!BASE_URL!"=="" echo INFO: Standalone base URL: !BASE_URL!
    if not "!ARCHIVE_PATH!"=="" (
        echo INFO: Standalone archive: !ARCHIVE_PATH!
    ) else (
        echo INFO: Standalone version: !VERSION!
    )
)
if /i not "!METHOD!"=="standalone" echo INFO: npm registry: !NPM_REGISTRY!
if not "!SOURCE!"=="unknown" echo INFO: Installation source: !SOURCE!
echo.

if /i "!METHOD!"=="standalone" (
    call :InstallStandalone
    if !ERRORLEVEL! NEQ 0 exit /b !ERRORLEVEL!
    call :PrintFinalInstructions "!INSTALL_BIN_DIR!"
    endlocal
    exit /b 0
)

if /i "!METHOD!"=="npm" (
    call :InstallNpm
    if !ERRORLEVEL! NEQ 0 exit /b !ERRORLEVEL!
    call :PrintFinalInstructions ""
    endlocal
    exit /b 0
)

call :InstallStandalone
set "STANDALONE_STATUS=!ERRORLEVEL!"
if !STANDALONE_STATUS! EQU 0 (
    call :PrintFinalInstructions "!INSTALL_BIN_DIR!"
    endlocal
    exit /b 0
)

if !STANDALONE_STATUS! EQU 2 (
    echo WARNING: Falling back to npm installation.
    call :InstallNpm
    if !ERRORLEVEL! NEQ 0 exit /b !ERRORLEVEL!
    call :PrintFinalInstructions ""
    endlocal
    exit /b 0
)

exit /b !STANDALONE_STATUS!

:usage
echo Qwen Code Installer
echo.
echo Usage: install-qwen-with-source.bat [OPTIONS]
echo.
echo Options:
echo   -s, --source SOURCE      Record the installation source.
echo                            Only letters, numbers, dot, underscore, and dash are allowed.
echo   --method METHOD          Install method: detect, standalone, or npm.
echo   --mirror MIRROR          Standalone archive mirror: github or aliyun.
echo   --base-url URL           Override standalone archive base URL.
echo   --archive PATH           Install from a local standalone archive.
echo   --version VERSION        Standalone release version. Defaults to latest.
echo   --registry REGISTRY      npm registry to use.
echo                            Defaults to QWEN_NPM_REGISTRY or https://registry.npmmirror.com
echo   -h, --help               Show this help message.
exit /b 0

:usage_error
echo Qwen Code Installer
echo.
echo Usage: install-qwen-with-source.bat [OPTIONS]
echo.
echo Options:
echo   -s, --source SOURCE      Record the installation source.
echo   --method METHOD          Install method: detect, standalone, or npm.
echo   --mirror MIRROR          Standalone archive mirror: github or aliyun.
echo   --base-url URL           Override standalone archive base URL.
echo   --archive PATH           Install from a local standalone archive.
echo   --version VERSION        Standalone release version. Defaults to latest.
echo   --registry REGISTRY      npm registry to use.
echo   -h, --help               Show this help message.
exit /b 1

:ValidateOptions
if "!METHOD!"=="" set "METHOD=detect"

if /i "!METHOD!"=="detect" goto validate_method_ok
if /i "!METHOD!"=="standalone" goto validate_method_ok
if /i "!METHOD!"=="npm" goto validate_method_ok
echo ERROR: --method must be detect, standalone, or npm.
exit /b 1

:validate_method_ok
if /i "!MIRROR!"=="github" goto validate_mirror_ok
if /i "!MIRROR!"=="aliyun" goto validate_mirror_ok
echo ERROR: --mirror must be github or aliyun.
exit /b 1

:validate_mirror_ok
call :ValidateSource
exit /b %ERRORLEVEL%

:ValidateSource
if "!SOURCE!"=="unknown" exit /b 0
echo(!SOURCE!| findstr /R /C:"^[A-Za-z0-9._-][A-Za-z0-9._-]*$" >nul
if %ERRORLEVEL% EQU 0 exit /b 0

echo ERROR: --source may only contain letters, numbers, dot, underscore, or dash.
exit /b 1

:DetectTarget
set "TARGET="
if /i "%PROCESSOR_ARCHITECTURE%"=="AMD64" set "TARGET=win-x64"
if /i "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "TARGET=win-x64"
if "!TARGET!"=="" (
    echo WARNING: Standalone archive is not available for this Windows architecture.
    exit /b 1
)
exit /b 0

:ReleaseVersionPath
if /i "!VERSION!"=="latest" (
    set "VERSION_PATH=latest"
    exit /b 0
)
set "VERSION_PATH=!VERSION!"
if /i "!VERSION_PATH:~0,1!"=="v" exit /b 0
set "VERSION_PATH=v!VERSION_PATH!"
exit /b 0

:StandaloneBaseUrl
if not "!BASE_URL!"=="" (
    set "STANDALONE_BASE_URL=!BASE_URL!"
    exit /b 0
)

call :ReleaseVersionPath
if /i "!MIRROR!"=="aliyun" (
    set "STANDALONE_BASE_URL=https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code/!VERSION_PATH!"
    exit /b 0
)

if /i "!VERSION_PATH!"=="latest" (
    set "STANDALONE_BASE_URL=https://github.com/QwenLM/qwen-code/releases/latest/download"
    exit /b 0
)

set "STANDALONE_BASE_URL=https://github.com/QwenLM/qwen-code/releases/download/!VERSION_PATH!"
exit /b 0

:UrlExists
set "CHECK_URL=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$request = [Net.WebRequest]::Create('%CHECK_URL%'); $request.Method = 'HEAD'; try { $response = $request.GetResponse(); $response.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
exit /b %ERRORLEVEL%

:DownloadFile
set "DOWNLOAD_URL=%~1"
set "DOWNLOAD_DEST=%~2"
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('%DOWNLOAD_URL%', '%DOWNLOAD_DEST%')"
exit /b %ERRORLEVEL%

:VerifyChecksum
set "ARCHIVE_FILE=%~1"
set "CHECKSUM_SOURCE=%~2"
set "ARCHIVE_NAME=%~3"
set "CHECKSUM_FILE=!CHECKSUM_SOURCE!"
set "TEMP_CHECKSUM="
set "REQUIRE_CHECKSUM=0"

if "!CHECKSUM_FILE!"=="" (
    for %%I in ("!ARCHIVE_FILE!") do set "CHECKSUM_FILE=%%~dpISHA256SUMS"
) else (
    echo !CHECKSUM_FILE!| findstr /R /C:"^https*://" >nul
    if !ERRORLEVEL! EQU 0 (
        set "REQUIRE_CHECKSUM=1"
        set "TEMP_CHECKSUM=%TEMP%\qwen-code-checksums-%RANDOM%%RANDOM%.txt"
        call :DownloadFile "!CHECKSUM_FILE!" "!TEMP_CHECKSUM!"
        if !ERRORLEVEL! NEQ 0 (
            if exist "!TEMP_CHECKSUM!" del /F /Q "!TEMP_CHECKSUM!" >nul 2>&1
            echo ERROR: Could not download SHA256SUMS for checksum verification.
            exit /b 1
        )
        set "CHECKSUM_FILE=!TEMP_CHECKSUM!"
    )
)

if not exist "!CHECKSUM_FILE!" (
    if "!REQUIRE_CHECKSUM!"=="1" (
        echo ERROR: SHA256SUMS not found; cannot verify remote archive.
        exit /b 1
    )
    echo WARNING: SHA256SUMS not found; skipping checksum verification.
    exit /b 0
)

set "EXPECTED_HASH="
for /f "tokens=1" %%H in ('findstr /C:"!ARCHIVE_NAME!" "!CHECKSUM_FILE!"') do (
    if "!EXPECTED_HASH!"=="" set "EXPECTED_HASH=%%H"
)

if "!EXPECTED_HASH!"=="" (
    if not "!TEMP_CHECKSUM!"=="" del /F /Q "!TEMP_CHECKSUM!" >nul 2>&1
    if "!REQUIRE_CHECKSUM!"=="1" (
        echo ERROR: Checksum entry for !ARCHIVE_NAME! not found.
        exit /b 1
    )
    echo WARNING: Checksum entry for !ARCHIVE_NAME! not found; skipping checksum verification.
    exit /b 0
)

set "ACTUAL_HASH="
for /f "tokens=1" %%H in ('certutil -hashfile "!ARCHIVE_FILE!" SHA256 ^| findstr /R /C:"^[0-9A-Fa-f][0-9A-Fa-f]"') do (
    if "!ACTUAL_HASH!"=="" set "ACTUAL_HASH=%%H"
)

if not "!TEMP_CHECKSUM!"=="" del /F /Q "!TEMP_CHECKSUM!" >nul 2>&1

if "!ACTUAL_HASH!"=="" (
    if "!REQUIRE_CHECKSUM!"=="1" (
        echo ERROR: Could not calculate SHA-256 checksum for remote archive.
        exit /b 1
    )
    echo WARNING: Could not calculate SHA-256 checksum; skipping checksum verification.
    exit /b 0
)

if /i not "!EXPECTED_HASH!"=="!ACTUAL_HASH!" (
    echo ERROR: Checksum verification failed for !ARCHIVE_NAME!.
    exit /b 1
)

echo SUCCESS: Checksum verified for !ARCHIVE_NAME!.
exit /b 0

:InstallStandalone
set "TEMP_DIR="
set "CHECKSUM_SOURCE="

if not "!ARCHIVE_PATH!"=="" (
    set "ARCHIVE_FILE=!ARCHIVE_PATH!"
    for %%I in ("!ARCHIVE_FILE!") do set "ARCHIVE_NAME=%%~nxI"
    if not exist "!ARCHIVE_FILE!" (
        echo ERROR: Standalone archive not found: !ARCHIVE_FILE!
        exit /b 1
    )
) else (
    call :DetectTarget
    if !ERRORLEVEL! NEQ 0 exit /b 2

    set "ARCHIVE_NAME=qwen-code-win-x64.zip"
    call :StandaloneBaseUrl
    set "ARCHIVE_URL=!STANDALONE_BASE_URL!/!ARCHIVE_NAME!"
    set "CHECKSUM_SOURCE=!STANDALONE_BASE_URL!/SHA256SUMS"

    if /i "!METHOD!"=="detect" (
        call :UrlExists "!ARCHIVE_URL!"
        if !ERRORLEVEL! NEQ 0 (
            echo WARNING: Standalone archive not found: !ARCHIVE_NAME!
            exit /b 2
        )
    )

    set "TEMP_DIR=%TEMP%\qwen-code-install-%RANDOM%%RANDOM%"
    mkdir "!TEMP_DIR!" >nul 2>&1
    set "ARCHIVE_FILE=!TEMP_DIR!\!ARCHIVE_NAME!"

    echo INFO: Downloading !ARCHIVE_URL!
    call :DownloadFile "!ARCHIVE_URL!" "!ARCHIVE_FILE!"
    if !ERRORLEVEL! NEQ 0 (
        if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
        echo WARNING: Failed to download standalone archive.
        exit /b 2
    )
)

if "!TEMP_DIR!"=="" (
    set "TEMP_DIR=%TEMP%\qwen-code-install-%RANDOM%%RANDOM%"
    mkdir "!TEMP_DIR!" >nul 2>&1
)

call :VerifyChecksum "!ARCHIVE_FILE!" "!CHECKSUM_SOURCE!" "!ARCHIVE_NAME!"
if !ERRORLEVEL! NEQ 0 (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    exit /b 1
)

set "EXTRACT_DIR=!TEMP_DIR!\extract"
mkdir "!EXTRACT_DIR!" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%ARCHIVE_FILE%' -DestinationPath '%EXTRACT_DIR%' -Force"
if !ERRORLEVEL! NEQ 0 (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    echo ERROR: Failed to extract standalone archive.
    exit /b 1
)

if not exist "!EXTRACT_DIR!\qwen-code\bin\qwen.cmd" (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    echo ERROR: Archive does not contain qwen-code\bin\qwen.cmd.
    exit /b 1
)

if not exist "!EXTRACT_DIR!\qwen-code\node\node.exe" (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    echo ERROR: Archive does not contain qwen-code\node\node.exe.
    exit /b 1
)

if not exist "!INSTALL_BASE!" mkdir "!INSTALL_BASE!"
if not exist "!INSTALL_BIN_DIR!" mkdir "!INSTALL_BIN_DIR!"

set "NEW_INSTALL_DIR=!INSTALL_DIR!.new"
set "OLD_INSTALL_DIR=!INSTALL_DIR!.old"
if exist "!NEW_INSTALL_DIR!" rmdir /S /Q "!NEW_INSTALL_DIR!" >nul 2>&1
if exist "!OLD_INSTALL_DIR!" rmdir /S /Q "!OLD_INSTALL_DIR!" >nul 2>&1
move /Y "!EXTRACT_DIR!\qwen-code" "!NEW_INSTALL_DIR!" >nul
if !ERRORLEVEL! NEQ 0 (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    echo ERROR: Failed to stage standalone archive.
    exit /b 1
)

if exist "!INSTALL_DIR!" move /Y "!INSTALL_DIR!" "!OLD_INSTALL_DIR!" >nul
move /Y "!NEW_INSTALL_DIR!" "!INSTALL_DIR!" >nul
if !ERRORLEVEL! NEQ 0 (
    if exist "!OLD_INSTALL_DIR!" move /Y "!OLD_INSTALL_DIR!" "!INSTALL_DIR!" >nul
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    echo ERROR: Failed to install standalone archive to !INSTALL_DIR!.
    exit /b 1
)

if exist "!OLD_INSTALL_DIR!" rmdir /S /Q "!OLD_INSTALL_DIR!" >nul 2>&1

(
echo @echo off
echo call "!INSTALL_DIR!\bin\qwen.cmd" %%*
) > "!INSTALL_BIN_DIR!\qwen.cmd"

set "PATH=!INSTALL_BIN_DIR!;!PATH!"
call :CreateSourceJson
if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1

echo SUCCESS: Qwen Code standalone archive installed successfully.
echo INFO: Installed to !INSTALL_DIR!
exit /b 0

:RequireNode
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js was not found.
    echo.
    echo Node.js 20 or newer is required before installing Qwen Code with npm.
    echo Please install Node.js from https://nodejs.org/ and rerun this installer.
    exit /b 1
)

for /f "delims=" %%i in ('node -p "process.versions.node" 2^>nul') do set "NODE_VERSION=%%i"
if "%NODE_VERSION%"=="" (
    echo ERROR: Unable to determine Node.js version.
    echo Node.js 20 or newer is required before installing Qwen Code with npm.
    exit /b 1
)

for /f "tokens=1 delims=." %%a in ("%NODE_VERSION%") do set "MAJOR_VERSION=%%a"
set /a NODE_MAJOR_NUM=%MAJOR_VERSION% >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Unable to determine Node.js version.
    echo Node.js 20 or newer is required before installing Qwen Code with npm.
    exit /b 1
)

if %NODE_MAJOR_NUM% LSS 20 (
    echo ERROR: Node.js %NODE_VERSION% is installed, but Node.js 20 or newer is required.
    echo Please install Node.js from https://nodejs.org/ and rerun this installer.
    exit /b 1
)

echo SUCCESS: Node.js %NODE_VERSION% detected.
exit /b 0

:RequireNpm
where npm >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: npm was not found.
    echo Please install Node.js with npm included, then rerun this installer.
    exit /b 1
)

for /f "delims=" %%i in ('npm -v 2^>nul') do set "NPM_VERSION=%%i"
echo SUCCESS: npm %NPM_VERSION% detected.
exit /b 0

:InstallNpm
call :RequireNode
if %ERRORLEVEL% NEQ 0 exit /b 1

call :RequireNpm
if %ERRORLEVEL% NEQ 0 exit /b 1

where qwen >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    for /f "delims=" %%i in ('qwen --version 2^>nul') do set "QWEN_VERSION=%%i"
    echo INFO: Existing Qwen Code detected: !QWEN_VERSION!
    echo INFO: Upgrading to the latest version.
)

echo INFO: Running: npm install -g @qwen-code/qwen-code@latest --registry !NPM_REGISTRY!
call npm install -g @qwen-code/qwen-code@latest --registry "!NPM_REGISTRY!"
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Failed to install Qwen Code.
    echo.
    echo This installer does not change your npm prefix or PATH.
    echo If the failure is a permission error, fix your npm global package directory, then run:
    echo   npm install -g @qwen-code/qwen-code@latest --registry !NPM_REGISTRY!
    exit /b 1
)

echo SUCCESS: Qwen Code installed successfully.
call :CreateSourceJson
exit /b 0

:CreateSourceJson
if "!SOURCE!"=="unknown" exit /b 0

set "QWEN_DIR=%USERPROFILE%\.qwen"
if not exist "%QWEN_DIR%" mkdir "%QWEN_DIR%"

(
echo {
echo   "source": "!SOURCE!"
echo }
) > "%QWEN_DIR%\source.json"

echo SUCCESS: Installation source saved to %USERPROFILE%\.qwen\source.json
exit /b 0

:PrintFinalInstructions
set "EXTRA_BIN=%~1"
if not "!EXTRA_BIN!"=="" set "PATH=!EXTRA_BIN!;!PATH!"

echo.
echo ===========================================
echo Installation completed!
echo ===========================================
echo.

where qwen >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    for /f "delims=" %%i in ('qwen --version 2^>nul') do set "QWEN_VERSION=%%i"
    echo SUCCESS: Qwen Code is ready to use: !QWEN_VERSION!
    echo.
    echo You can now run: qwen
    echo.
    echo INFO: Run qwen in your project directory to start an interactive session.
    exit /b 0
)

echo WARNING: Qwen Code was installed, but qwen is not on PATH in this prompt.
echo.
echo Restart your command prompt, then run: qwen
if not "!EXTRA_BIN!"=="" (
    echo.
    echo Or add this directory to PATH:
    echo   !EXTRA_BIN!
    echo Then run:
    echo   qwen
    exit /b 0
)

for /f "delims=" %%i in ('npm prefix -g 2^>nul') do set "NPM_PREFIX=%%i"
if not "!NPM_PREFIX!"=="" (
    echo.
    echo Or add this npm global directory to PATH:
    echo   !NPM_PREFIX!
    echo Then run:
    echo   qwen
)
exit /b 0
