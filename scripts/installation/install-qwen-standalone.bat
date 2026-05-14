@echo off
REM Qwen Code Installation Script
REM Installs Qwen Code from a standalone archive when available, with npm fallback.
REM This script intentionally does not install Node.js or change npm config.

setlocal enabledelayedexpansion

set "SOURCE=unknown"
set "METHOD="
if defined QWEN_INSTALL_METHOD set "METHOD=!QWEN_INSTALL_METHOD!"
set "MIRROR=auto"
if defined QWEN_INSTALL_MIRROR set "MIRROR=!QWEN_INSTALL_MIRROR!"
set "NO_MODIFY_PATH=0"
if defined QWEN_NO_MODIFY_PATH set "NO_MODIFY_PATH=!QWEN_NO_MODIFY_PATH!"
set "BASE_URL="
if defined QWEN_INSTALL_BASE_URL set "BASE_URL=!QWEN_INSTALL_BASE_URL!"
set "ARCHIVE_PATH="
if defined QWEN_INSTALL_ARCHIVE set "ARCHIVE_PATH=!QWEN_INSTALL_ARCHIVE!"
set "VERSION=latest"
if defined QWEN_INSTALL_VERSION set "VERSION=!QWEN_INSTALL_VERSION!"
set "NPM_REGISTRY=https://registry.npmmirror.com"
if defined QWEN_NPM_REGISTRY set "NPM_REGISTRY=!QWEN_NPM_REGISTRY!"
if defined LOCALAPPDATA (
    set "INSTALL_BASE=!LOCALAPPDATA!\qwen-code"
) else (
    set "INSTALL_BASE=!USERPROFILE!\AppData\Local\qwen-code"
)
if defined QWEN_INSTALL_ROOT set "INSTALL_BASE=!QWEN_INSTALL_ROOT!"
set "INSTALL_DIR=!INSTALL_BASE!\qwen-code"
if defined QWEN_INSTALL_LIB_DIR set "INSTALL_DIR=!QWEN_INSTALL_LIB_DIR!"
set "INSTALL_BIN_DIR=!INSTALL_BASE!\bin"
if defined QWEN_INSTALL_BIN_DIR set "INSTALL_BIN_DIR=!QWEN_INSTALL_BIN_DIR!"

REM Parse flags before any network or filesystem work.
:parse_args
if "%~1"=="" goto end_parse
set "ARG_RAW=%~1"
set "ARG_KEY=%~1"
set "ARG_VALUE="
set "ARG_HAS_INLINE_VALUE=0"
for /f "tokens=1,* delims==" %%A in ("%~1") do (
    set "ARG_KEY=%%~A"
    set "ARG_VALUE=%%~B"
)
if not "!ARG_KEY!"=="!ARG_RAW!" set "ARG_HAS_INLINE_VALUE=1"
if /i "!ARG_KEY!"=="--source" (
    if "!ARG_HAS_INLINE_VALUE!"=="1" (
        if "!ARG_VALUE!"=="" (
            echo ERROR: --source requires a value
            exit /b 1
        )
        set "SOURCE=!ARG_VALUE!"
        shift
        goto parse_args
    )
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
if /i "!ARG_KEY!"=="--method" (
    if "!ARG_HAS_INLINE_VALUE!"=="1" (
        if "!ARG_VALUE!"=="" (
            echo ERROR: --method requires a value
            exit /b 1
        )
        set "METHOD=!ARG_VALUE!"
        shift
        goto parse_args
    )
    if "%~2"=="" (
        echo ERROR: --method requires a value
        exit /b 1
    )
    set "METHOD=%~2"
    shift
    shift
    goto parse_args
)
if /i "!ARG_KEY!"=="--mirror" (
    if "!ARG_HAS_INLINE_VALUE!"=="1" (
        if "!ARG_VALUE!"=="" (
            echo ERROR: --mirror requires a value
            exit /b 1
        )
        set "MIRROR=!ARG_VALUE!"
        shift
        goto parse_args
    )
    if "%~2"=="" (
        echo ERROR: --mirror requires a value
        exit /b 1
    )
    set "MIRROR=%~2"
    shift
    shift
    goto parse_args
)
if /i "!ARG_KEY!"=="--base-url" (
    if "!ARG_HAS_INLINE_VALUE!"=="1" (
        if "!ARG_VALUE!"=="" (
            echo ERROR: --base-url requires a value
            exit /b 1
        )
        set "BASE_URL=!ARG_VALUE!"
        shift
        goto parse_args
    )
    if "%~2"=="" (
        echo ERROR: --base-url requires a value
        exit /b 1
    )
    set "BASE_URL=%~2"
    shift
    shift
    goto parse_args
)
if /i "!ARG_KEY!"=="--archive" (
    if "!ARG_HAS_INLINE_VALUE!"=="1" (
        if "!ARG_VALUE!"=="" (
            echo ERROR: --archive requires a value
            exit /b 1
        )
        set "ARCHIVE_PATH=!ARG_VALUE!"
        shift
        goto parse_args
    )
    if "%~2"=="" (
        echo ERROR: --archive requires a value
        exit /b 1
    )
    set "ARCHIVE_PATH=%~2"
    shift
    shift
    goto parse_args
)
if /i "!ARG_KEY!"=="--version" (
    if "!ARG_HAS_INLINE_VALUE!"=="1" (
        if "!ARG_VALUE!"=="" (
            echo ERROR: --version requires a value
            exit /b 1
        )
        set "VERSION=!ARG_VALUE!"
        shift
        goto parse_args
    )
    if "%~2"=="" (
        echo ERROR: --version requires a value
        exit /b 1
    )
    set "VERSION=%~2"
    shift
    shift
    goto parse_args
)
if /i "!ARG_KEY!"=="--registry" (
    if "!ARG_HAS_INLINE_VALUE!"=="1" (
        if "!ARG_VALUE!"=="" (
            echo ERROR: --registry requires a value
            exit /b 1
        )
        set "NPM_REGISTRY=!ARG_VALUE!"
        shift
        goto parse_args
    )
    if "%~2"=="" (
        echo ERROR: --registry requires a value
        exit /b 1
    )
    set "NPM_REGISTRY=%~2"
    shift
    shift
    goto parse_args
)
if /i "%~1"=="--no-modify-path" (
    set "NO_MODIFY_PATH=1"
    shift
    goto parse_args
)
if /i "%~1"=="-h" goto usage
if /i "%~1"=="--help" goto usage

echo ERROR: Unknown option.
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

REM Discover all qwen executables on disk BEFORE we install. We can't
REM reliably simulate the user's PATH ordering, so enumerate well-known
REM per-tool bin directories plus everything `where qwen` returns.
call :CreateTempFile "qwen-pre-install"
if !ERRORLEVEL! NEQ 0 exit /b 1
set "PRE_INSTALL_QWENS_FILE=!TEMP_FILE!"
for /f "delims=" %%i in ('where qwen 2^>nul') do call echo %%i>>"!PRE_INSTALL_QWENS_FILE!"
for %%c in (
    "!USERPROFILE!\.opencode\bin\qwen.cmd"
    "!APPDATA!\npm\qwen.cmd"
    "!USERPROFILE!\.bun\bin\qwen.cmd"
    "!LOCALAPPDATA!\bun\bin\qwen.cmd"
    "!LOCALAPPDATA!\qwen-code\bin\qwen.cmd"
) do if exist %%c call echo %%~c>>"!PRE_INSTALL_QWENS_FILE!"
for /f "delims=" %%i in ('npm prefix -g 2^>nul') do (
    if exist "%%i\qwen.cmd" call echo %%i\qwen.cmd>>"!PRE_INSTALL_QWENS_FILE!"
)
set "PRE_INSTALL_QWENS_LIST="
if exist "!PRE_INSTALL_QWENS_FILE!" (
    for /f "delims=" %%i in ('sort "!PRE_INSTALL_QWENS_FILE!" 2^>nul ^| findstr /v "^$"') do (
        if "!PRE_INSTALL_QWENS_LIST!"=="" (
            set "PRE_INSTALL_QWENS_LIST=%%i"
        ) else (
            echo !PRE_INSTALL_QWENS_LIST! | findstr /i /c:"%%i" >nul 2>&1
            if errorlevel 1 set "PRE_INSTALL_QWENS_LIST=!PRE_INSTALL_QWENS_LIST!|%%i"
        )
    )
    del /f /q "!PRE_INSTALL_QWENS_FILE!" >nul 2>&1
)

REM Dispatch after validation; detect falls back to npm only when unavailable.
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
    if !ERRORLEVEL! NEQ 0 (
        echo WARNING: Standalone archive was unavailable before npm fallback; npm fallback also failed.
        echo WARNING: Retry with --method standalone to debug the standalone failure, or install Node.js 22+ and rerun --method npm.
        exit /b !ERRORLEVEL!
    )
    call :PrintFinalInstructions ""
    endlocal
    exit /b 0
)

echo WARNING: Standalone install failed. Retry with --method npm to use npm, or --method standalone to debug the standalone failure.
exit /b !STANDALONE_STATUS!

:usage
call :PrintUsage
exit /b 0

:usage_error
call :PrintUsage
exit /b 1

:PrintUsage
echo Qwen Code Installer
echo.
echo Usage: install-qwen-standalone.bat [OPTIONS]
echo.
echo Options:
echo   -s, --source SOURCE      Record the installation source.
echo                            Only letters, numbers, dot, underscore, and dash are allowed.
echo   --method METHOD          Install method: detect, standalone, or npm.
echo   --mirror MIRROR          Standalone archive mirror: auto, github, or aliyun.
echo                            Defaults to QWEN_INSTALL_MIRROR or auto, which picks
echo                            whichever responds first via a HEAD probe.
echo   --base-url URL           Override standalone archive base URL.
echo   --archive PATH           Install from a local standalone archive.
echo   --version VERSION        Standalone release version. Defaults to latest.
echo   --registry REGISTRY      npm registry to use.
echo                            Defaults to QWEN_NPM_REGISTRY or https://registry.npmmirror.com
echo   --no-modify-path         Do not prepend INSTALL_BIN_DIR to user PATH even
echo                            when a shadowing 'qwen' is detected.
echo   -h, --help               Show this help message.
exit /b 0

:ValidateOptions
if "!METHOD!"=="" set "METHOD=detect"

set "QWEN_VALIDATE_METHOD=!METHOD!"
set "QWEN_VALIDATE_MIRROR=!MIRROR!"
set "QWEN_VALIDATE_BASE_URL=!BASE_URL!"
set "QWEN_VALIDATE_ARCHIVE_PATH=!ARCHIVE_PATH!"
set "QWEN_VALIDATE_VERSION=!VERSION!"
set "QWEN_VALIDATE_NPM_REGISTRY=!NPM_REGISTRY!"
set "QWEN_VALIDATE_INSTALL_BASE=!INSTALL_BASE!"
set "QWEN_VALIDATE_INSTALL_DIR=!INSTALL_DIR!"
set "QWEN_VALIDATE_INSTALL_BIN_DIR=!INSTALL_BIN_DIR!"
set "QWEN_VALIDATE_SOURCE=!SOURCE!"
call :CreateTempFile "qwen-validate-options" ".ps1"
if !ERRORLEVEL! NEQ 0 exit /b 1
set "QWEN_VALIDATE_OPTIONS_SCRIPT=!TEMP_FILE!"
> "!QWEN_VALIDATE_OPTIONS_SCRIPT!" echo $unsafe = [char[]](10,13,33,34,37,38,60,62,94,96,124)
>> "!QWEN_VALIDATE_OPTIONS_SCRIPT!" echo $names = @('METHOD','MIRROR','BASE_URL','ARCHIVE_PATH','VERSION','NPM_REGISTRY','INSTALL_BASE','INSTALL_DIR','INSTALL_BIN_DIR','SOURCE')
>> "!QWEN_VALIDATE_OPTIONS_SCRIPT!" echo foreach ($name in $names) {
>> "!QWEN_VALIDATE_OPTIONS_SCRIPT!" echo   $value = [Environment]::GetEnvironmentVariable('QWEN_VALIDATE_' + $name)
>> "!QWEN_VALIDATE_OPTIONS_SCRIPT!" echo   if ($null -ne $value -and $value.IndexOfAny($unsafe) -ge 0) { exit 1 }
>> "!QWEN_VALIDATE_OPTIONS_SCRIPT!" echo }
>> "!QWEN_VALIDATE_OPTIONS_SCRIPT!" echo exit 0
powershell -NoProfile -ExecutionPolicy Bypass -File "!QWEN_VALIDATE_OPTIONS_SCRIPT!"
set "PS_STATUS=%ERRORLEVEL%"
del /F /Q "!QWEN_VALIDATE_OPTIONS_SCRIPT!" >nul 2>&1
set "QWEN_VALIDATE_OPTIONS_SCRIPT="
set "QWEN_VALIDATE_METHOD="
set "QWEN_VALIDATE_MIRROR="
set "QWEN_VALIDATE_BASE_URL="
set "QWEN_VALIDATE_ARCHIVE_PATH="
set "QWEN_VALIDATE_VERSION="
set "QWEN_VALIDATE_NPM_REGISTRY="
set "QWEN_VALIDATE_INSTALL_BASE="
set "QWEN_VALIDATE_INSTALL_DIR="
set "QWEN_VALIDATE_INSTALL_BIN_DIR="
set "QWEN_VALIDATE_SOURCE="
if %PS_STATUS% NEQ 0 (
    echo ERROR: installer options contain unsafe command characters.
    exit /b 1
)

if "!INSTALL_BASE!"=="" (
    echo ERROR: QWEN_INSTALL_ROOT must not be empty.
    exit /b 1
)
if "!INSTALL_DIR!"=="" (
    echo ERROR: QWEN_INSTALL_LIB_DIR must not be empty.
    exit /b 1
)
if "!INSTALL_BIN_DIR!"=="" (
    echo ERROR: QWEN_INSTALL_BIN_DIR must not be empty.
    exit /b 1
)
if "!INSTALL_BASE:~1,2!"==":\" goto validate_install_base_ok
if "!INSTALL_BASE:~1,2!"==":/" goto validate_install_base_ok
if "!INSTALL_BASE:~0,2!"=="\\" goto validate_install_base_ok
echo ERROR: QWEN_INSTALL_ROOT must be an absolute path.
exit /b 1
:validate_install_base_ok
if "!INSTALL_DIR:~1,2!"==":\" goto validate_install_dir_ok
if "!INSTALL_DIR:~1,2!"==":/" goto validate_install_dir_ok
if "!INSTALL_DIR:~0,2!"=="\\" goto validate_install_dir_ok
echo ERROR: QWEN_INSTALL_LIB_DIR must be an absolute path.
exit /b 1
:validate_install_dir_ok
if "!INSTALL_BIN_DIR:~1,2!"==":\" goto validate_install_bin_dir_ok
if "!INSTALL_BIN_DIR:~1,2!"==":/" goto validate_install_bin_dir_ok
if "!INSTALL_BIN_DIR:~0,2!"=="\\" goto validate_install_bin_dir_ok
echo ERROR: QWEN_INSTALL_BIN_DIR must be an absolute path.
exit /b 1
:validate_install_bin_dir_ok

if /i "!METHOD!"=="detect" goto validate_method_ok
if /i "!METHOD!"=="standalone" goto validate_method_ok
if /i "!METHOD!"=="npm" goto validate_method_ok
echo ERROR: --method must be detect, standalone, or npm.
exit /b 1

:validate_method_ok
if /i "!MIRROR!"=="github" goto validate_mirror_ok
if /i "!MIRROR!"=="aliyun" goto validate_mirror_ok
if /i "!MIRROR!"=="auto" goto validate_mirror_ok
echo ERROR: --mirror must be auto, github, or aliyun.
exit /b 1

:validate_mirror_ok
call :ValidateHttpsUrlVar "BASE_URL" "--base-url"
if %ERRORLEVEL% NEQ 0 exit /b 1

call :ValidateHttpsUrlVar "NPM_REGISTRY" "--registry"
if %ERRORLEVEL% NEQ 0 exit /b 1

call :ValidateVersion
if %ERRORLEVEL% NEQ 0 exit /b 1

call :ValidateGithubRepo
if %ERRORLEVEL% NEQ 0 exit /b 1

call :ValidateSource
exit /b %ERRORLEVEL%

:ValidateHttpsUrlVar
set "URL_VALUE=!%~1!"
set "URL_OPTION=%~2"
if "!URL_VALUE!"=="" exit /b 0
if /i "!URL_VALUE:~0,8!"=="https://" exit /b 0

echo ERROR: !URL_OPTION! must start with https://
exit /b 1

:ValidateVersion
if /i "!VERSION!"=="latest" exit /b 0
set "QWEN_VERSION_VALUE=!VERSION!"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$value = $env:QWEN_VERSION_VALUE; if ($value -match '^v?[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$') { exit 0 }; exit 1"
set "PS_STATUS=%ERRORLEVEL%"
set "QWEN_VERSION_VALUE="
if %PS_STATUS% EQU 0 exit /b 0
echo ERROR: --version must be 'latest' or a semver string.
exit /b 1

:ValidateGithubRepo
if not defined QWEN_INSTALL_GITHUB_REPO exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -Command "$value = $env:QWEN_INSTALL_GITHUB_REPO; if ($value -match '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$') { exit 0 }; exit 1"
if %ERRORLEVEL% EQU 0 exit /b 0

echo ERROR: QWEN_INSTALL_GITHUB_REPO must be in owner/repo format.
exit /b 1

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

:GithubBaseUrlForVersion
rem args: %~1=version_path  → sets QWEN_GH_BASE_URL
set "QWEN_GH_REPO=QwenLM/qwen-code"
if defined QWEN_INSTALL_GITHUB_REPO set "QWEN_GH_REPO=!QWEN_INSTALL_GITHUB_REPO!"
if /i "%~1"=="latest" (
    set "QWEN_GH_BASE_URL=https://github.com/!QWEN_GH_REPO!/releases/latest/download"
) else (
    set "QWEN_GH_BASE_URL=https://github.com/!QWEN_GH_REPO!/releases/download/%~1"
)
set "QWEN_GH_REPO="
exit /b 0

:AliyunBaseUrlForVersion
rem args: %~1=version_path  → sets QWEN_OSS_BASE_URL
set "QWEN_OSS_BASE_URL=https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code/%~1"
exit /b 0

:RaceMirrorHead
rem args: %~1=timeout_seconds %~2=gh_url %~3=oss_url
rem Sets QWEN_RACE_RESULT to "aliyun", "github", or "timeout". Sequential
rem (OSS first, GH fallback) keeps the PowerShell snippet small; a true
rem parallel race adds a lot of escaping for marginal speedup since OSS HEAD
rem is sub-second when reachable. Caller decides what to do with "timeout"
rem (currently: log it and fall back to github).
set "QWEN_RACE_TIMEOUT=%~1"
set "QWEN_RACE_GH_URL=%~2"
set "QWEN_RACE_OSS_URL=%~3"
set "QWEN_RACE_RESULT=timeout"
for /f "delims=" %%r in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $t=[int]$env:QWEN_RACE_TIMEOUT; try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13 } catch { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 }; function Probe($url) { try { $r = [Net.WebRequest]::Create($url); $r.Method = 'HEAD'; $r.Timeout = $t * 1000; if ($r -is [Net.HttpWebRequest]) { $r.AllowAutoRedirect = $true }; $resp = $r.GetResponse(); $resp.Close(); return $true } catch { return $false } }; if (Probe $env:QWEN_RACE_OSS_URL) { Write-Output 'aliyun'; exit 0 } elseif (Probe $env:QWEN_RACE_GH_URL) { Write-Output 'github'; exit 0 } else { Write-Output 'timeout'; exit 0 }"') do set "QWEN_RACE_RESULT=%%r"
set "QWEN_RACE_TIMEOUT="
set "QWEN_RACE_GH_URL="
set "QWEN_RACE_OSS_URL="
exit /b 0

:StandaloneBaseUrl
if not "!BASE_URL!"=="" (
    set "STANDALONE_BASE_URL=!BASE_URL!"
    exit /b 0
)

call :ReleaseVersionPath

if /i "!MIRROR!"=="auto" (
    call :GithubBaseUrlForVersion "!VERSION_PATH!"
    call :AliyunBaseUrlForVersion "!VERSION_PATH!"
    call :RaceMirrorHead 2 "!QWEN_GH_BASE_URL!/SHA256SUMS" "!QWEN_OSS_BASE_URL!/SHA256SUMS"
    if /i "!QWEN_RACE_RESULT!"=="timeout" (
        echo INFO: Mirror auto-selection timed out; defaulting to github.
        set "MIRROR=github"
    ) else (
        set "MIRROR=!QWEN_RACE_RESULT!"
        echo INFO: Mirror auto-selected via HEAD probe: !QWEN_RACE_RESULT!
    )
    set "QWEN_GH_BASE_URL="
    set "QWEN_OSS_BASE_URL="
    set "QWEN_RACE_RESULT="
)

if /i "!MIRROR!"=="aliyun" (
    call :AliyunBaseUrlForVersion "!VERSION_PATH!"
    set "STANDALONE_BASE_URL=!QWEN_OSS_BASE_URL!"
    set "QWEN_OSS_BASE_URL="
    exit /b 0
)

call :GithubBaseUrlForVersion "!VERSION_PATH!"
set "STANDALONE_BASE_URL=!QWEN_GH_BASE_URL!"
set "QWEN_GH_BASE_URL="
exit /b 0

:MaybeUpdateUserPath
rem args: %~1=install_bin_dir
rem Prepend the install dir to the user-level PATH (HKCU\Environment) via
rem [Environment]::SetEnvironmentVariable. Idempotent: skips if the dir is
rem already on the user PATH. Uses PowerShell rather than `setx` because setx
rem truncates PATH at 1024 chars, which can silently mangle long PATHs.
set "QWEN_NEW_BIN=%~1"
if "!QWEN_NEW_BIN!"=="" exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -Command "$bin = $env:QWEN_NEW_BIN; $userPath = [Environment]::GetEnvironmentVariable('Path', 'User'); if ([string]::IsNullOrEmpty($userPath)) { $userPath = '' }; $entries = $userPath -split ';' | Where-Object { $_ -ne '' }; if ($entries -contains $bin) { Write-Output ('INFO: User PATH already contains ' + $bin + ' (skipping).'); exit 0 }; $newPath = (@($bin) + $entries) -join ';'; [Environment]::SetEnvironmentVariable('Path', $newPath, 'User'); Write-Output ('SUCCESS: Prepended ' + $bin + ' to your user PATH.'); Write-Output 'INFO: Open a NEW command prompt for the change to take effect.'"
set "PS_STATUS=%ERRORLEVEL%"
set "QWEN_NEW_BIN="
exit /b %PS_STATUS%

:UrlExists
set "QWEN_CHECK_URL=%~1"
rem Prefer Tls12+Tls13; fall back to Tls12 alone on older .NET Framework where the Tls13 enum is missing.
rem AllowAutoRedirect=true is required for GitHub release asset URLs which return HTTP 302.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13 } catch { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 }; $request = [Net.WebRequest]::Create($env:QWEN_CHECK_URL); $request.Method = 'HEAD'; if ($request -is [Net.HttpWebRequest]) { $request.AllowAutoRedirect = $true }; try { $response = $request.GetResponse(); $response.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
set "PS_STATUS=%ERRORLEVEL%"
set "QWEN_CHECK_URL="
exit /b %PS_STATUS%

:DownloadFile
set "QWEN_DOWNLOAD_URL=%~1"
set "QWEN_DOWNLOAD_DEST=%~2"
rem Suppress PowerShell's full-screen progress UI; the installer logs the URL.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; try { try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13 } catch { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 }; Invoke-WebRequest -Uri $env:QWEN_DOWNLOAD_URL -OutFile $env:QWEN_DOWNLOAD_DEST -UseBasicParsing -MaximumRedirection 10; exit 0 } catch { [Console]::Error.WriteLine('Download error: ' + $_.Exception.Message); exit 1 }"
set "PS_STATUS=%ERRORLEVEL%"
set "QWEN_DOWNLOAD_URL="
set "QWEN_DOWNLOAD_DEST="
exit /b %PS_STATUS%

:VerifyChecksum
set "ARCHIVE_FILE=%~1"
set "CHECKSUM_SOURCE=%~2"
set "ARCHIVE_NAME=%~3"
set "CHECKSUM_FILE=!CHECKSUM_SOURCE!"
set "TEMP_CHECKSUM="
set "REQUIRE_CHECKSUM=1"

if "!CHECKSUM_FILE!"=="" (
    for %%I in ("!ARCHIVE_FILE!") do set "CHECKSUM_FILE=%%~dpISHA256SUMS"
) else (
    if /i "!CHECKSUM_FILE:~0,8!"=="https://" (
        set "REQUIRE_CHECKSUM=1"
        call :CreateTempFile "qwen-code-checksums"
        if !ERRORLEVEL! NEQ 0 exit /b 1
        set "TEMP_CHECKSUM=!TEMP_FILE!"
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
        echo ERROR: SHA256SUMS not found; cannot verify archive.
        exit /b 1
    )
    echo WARNING: SHA256SUMS not found; skipping checksum verification.
    exit /b 0
)

set "EXPECTED_HASH="
for /f "usebackq tokens=1,2" %%H in ("!CHECKSUM_FILE!") do (
    set "CHECKSUM_HASH=%%H"
    set "CHECKSUM_NAME=%%I"
    if "!CHECKSUM_NAME:~0,1!"=="*" set "CHECKSUM_NAME=!CHECKSUM_NAME:~1!"
    if "!CHECKSUM_NAME!"=="!ARCHIVE_NAME!" (
        if "!EXPECTED_HASH!"=="" set "EXPECTED_HASH=!CHECKSUM_HASH!"
    )
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
set "QWEN_HASH_FILE=!ARCHIVE_FILE!"
for /f "delims=" %%H in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; (Get-FileHash -Algorithm SHA256 -LiteralPath $env:QWEN_HASH_FILE).Hash" 2^>nul') do (
    if "!ACTUAL_HASH!"=="" set "ACTUAL_HASH=%%H"
)
set "QWEN_HASH_FILE="

if not "!TEMP_CHECKSUM!"=="" del /F /Q "!TEMP_CHECKSUM!" >nul 2>&1

if "!ACTUAL_HASH!"=="" (
    if "!REQUIRE_CHECKSUM!"=="1" (
        echo ERROR: Could not calculate SHA-256 checksum for archive.
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

REM Resolve the archive from a local file or from the configured release mirror.
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

    call :CreateTempDir
    if !ERRORLEVEL! NEQ 0 exit /b 1
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
    call :CreateTempDir
    if !ERRORLEVEL! NEQ 0 exit /b 1
)

REM Verify integrity before extraction or changing the install directory.
call :VerifyChecksum "!ARCHIVE_FILE!" "!CHECKSUM_SOURCE!" "!ARCHIVE_NAME!"
if !ERRORLEVEL! NEQ 0 (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    exit /b 1
)

REM Extract into a temporary directory, then validate required entry points.
set "EXTRACT_DIR=!TEMP_DIR!\extract"
call :EnsureDir "!EXTRACT_DIR!"
if !ERRORLEVEL! NEQ 0 (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    exit /b 1
)
call :ValidateArchiveContents "!ARCHIVE_FILE!"
if !ERRORLEVEL! NEQ 0 (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    exit /b 1
)
set "QWEN_ARCHIVE_FILE=!ARCHIVE_FILE!"
set "QWEN_EXTRACT_DIR=!EXTRACT_DIR!"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath $env:QWEN_ARCHIVE_FILE -DestinationPath $env:QWEN_EXTRACT_DIR -Force"
set "PS_STATUS=!ERRORLEVEL!"
set "QWEN_ARCHIVE_FILE="
set "QWEN_EXTRACT_DIR="
if !PS_STATUS! NEQ 0 (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    echo ERROR: Failed to extract standalone archive.
    exit /b 1
)

call :RejectArchiveLinks "!EXTRACT_DIR!"
if !ERRORLEVEL! NEQ 0 (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
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

call :EnsureDir "!INSTALL_BASE!"
if !ERRORLEVEL! NEQ 0 (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    exit /b 1
)
call :EnsureDir "!INSTALL_BIN_DIR!"
if !ERRORLEVEL! NEQ 0 (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    exit /b 1
)
for %%I in ("!INSTALL_DIR!") do set "INSTALL_PARENT=%%~dpI"
call :EnsureDir "!INSTALL_PARENT!"
if !ERRORLEVEL! NEQ 0 (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    exit /b 1
)

REM Stage into .new and keep .old so failed upgrades can roll back.
set "NEW_INSTALL_DIR=!INSTALL_DIR!.new"
set "OLD_INSTALL_DIR=!INSTALL_DIR!.old"

call :EnsureManagedInstallDir "!INSTALL_DIR!"
if !ERRORLEVEL! NEQ 0 (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    exit /b 1
)
call :EnsureManagedInstallDir "!NEW_INSTALL_DIR!"
if !ERRORLEVEL! NEQ 0 (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    exit /b 1
)
call :EnsureManagedInstallDir "!OLD_INSTALL_DIR!"
if !ERRORLEVEL! NEQ 0 (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    exit /b 1
)

if exist "!NEW_INSTALL_DIR!" (
    rmdir /S /Q "!NEW_INSTALL_DIR!" >nul 2>&1
    if !ERRORLEVEL! NEQ 0 (
        if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
        echo ERROR: Failed to remove stale staging directory: !NEW_INSTALL_DIR!.
        exit /b 1
    )
)
if exist "!OLD_INSTALL_DIR!" (
    rmdir /S /Q "!OLD_INSTALL_DIR!" >nul 2>&1
    if !ERRORLEVEL! NEQ 0 (
        if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
        echo ERROR: Failed to remove stale backup directory: !OLD_INSTALL_DIR!.
        exit /b 1
    )
)
move /Y "!EXTRACT_DIR!\qwen-code" "!NEW_INSTALL_DIR!" >nul
if !ERRORLEVEL! NEQ 0 (
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    echo ERROR: Failed to stage standalone archive.
    exit /b 1
)

if exist "!INSTALL_DIR!" (
    move /Y "!INSTALL_DIR!" "!OLD_INSTALL_DIR!" >nul
    if !ERRORLEVEL! NEQ 0 (
        if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
        echo ERROR: Failed to back up existing install at !INSTALL_DIR!.
        exit /b 1
    )
)
move /Y "!NEW_INSTALL_DIR!" "!INSTALL_DIR!" >nul
if !ERRORLEVEL! NEQ 0 (
    call :RestoreOldInstall
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    echo ERROR: Failed to install standalone archive to !INSTALL_DIR!.
    exit /b 1
)

rem SAFETY: this writer expands !INSTALL_DIR! / !INSTALL_BIN_DIR! into a generated
rem .cmd file. :ValidateOptions must continue to reject delayed-expansion sentinels
rem (`!`) and other shell-metacharacters in those values; if that validator is ever
rem loosened, the wrapper write below becomes a command injection sink.
(
echo @echo off
echo call "!INSTALL_DIR!\bin\qwen.cmd" %%*
) > "!INSTALL_BIN_DIR!\qwen.cmd.new"
if !ERRORLEVEL! NEQ 0 (
    call :RemoveInstalledDirWithWarning
    call :RestoreOldInstall
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    echo ERROR: Failed to create qwen wrapper in !INSTALL_BIN_DIR!.
    exit /b 1
)
move /Y "!INSTALL_BIN_DIR!\qwen.cmd.new" "!INSTALL_BIN_DIR!\qwen.cmd" >nul
if !ERRORLEVEL! NEQ 0 (
    if exist "!INSTALL_BIN_DIR!\qwen.cmd.new" del /F /Q "!INSTALL_BIN_DIR!\qwen.cmd.new" >nul 2>&1
    call :RemoveInstalledDirWithWarning
    call :RestoreOldInstall
    if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1
    echo ERROR: Failed to create qwen wrapper in !INSTALL_BIN_DIR!.
    exit /b 1
)

if exist "!OLD_INSTALL_DIR!" (
    rmdir /S /Q "!OLD_INSTALL_DIR!" >nul 2>&1
    if !ERRORLEVEL! NEQ 0 echo WARNING: Failed to remove old install backup: !OLD_INSTALL_DIR!
)

set "PATH=!INSTALL_BIN_DIR!;!PATH!"
call :CreateSourceJson
if exist "!TEMP_DIR!" rmdir /S /Q "!TEMP_DIR!" >nul 2>&1

echo SUCCESS: Qwen Code standalone archive installed successfully.
echo INFO: Installed to !INSTALL_DIR!
exit /b 0

:CreateTempDir
set "TEMP_DIR="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $dir = Join-Path $env:TEMP ('qwen-code-install-' + [IO.Path]::GetRandomFileName()); New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null; [Console]::Write($dir)"`) do set "TEMP_DIR=%%I"
if "!TEMP_DIR!"=="" (
    echo ERROR: Failed to create a temporary directory.
    exit /b 1
)
exit /b 0

:CreateTempFile
set "TEMP_FILE="
set "QWEN_TEMP_FILE_PREFIX=%~1"
set "QWEN_TEMP_FILE_EXTENSION=%~2"
for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $file = Join-Path $env:TEMP ($env:QWEN_TEMP_FILE_PREFIX + '-' + [IO.Path]::GetRandomFileName() + $env:QWEN_TEMP_FILE_EXTENSION); New-Item -ItemType File -Path $file -ErrorAction Stop | Out-Null; [Console]::Write($file)"`) do set "TEMP_FILE=%%I"
set "QWEN_TEMP_FILE_PREFIX="
set "QWEN_TEMP_FILE_EXTENSION="
if "!TEMP_FILE!"=="" (
    echo ERROR: Failed to create a temporary file.
    exit /b 1
)
exit /b 0

:EnsureDir
set "REQUIRED_DIR=%~1"
set "QWEN_REQUIRED_DIR=!REQUIRED_DIR!"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $path = $env:QWEN_REQUIRED_DIR; if (Test-Path -LiteralPath $path -PathType Container) { exit 0 }; if (Test-Path -LiteralPath $path) { exit 2 }; New-Item -ItemType Directory -Path $path -Force | Out-Null; exit 0"
set "PS_STATUS=!ERRORLEVEL!"
set "QWEN_REQUIRED_DIR="
if !PS_STATUS! EQU 0 exit /b 0
if !PS_STATUS! EQU 2 (
    echo ERROR: Path exists but is not a directory: !REQUIRED_DIR!
    exit /b 1
)
echo ERROR: Failed to create directory: !REQUIRED_DIR!
exit /b 1

:ValidateArchiveContents
set "QWEN_ARCHIVE_FILE=%~1"
REM Normalize backslashes to forward slashes before checking. Some Windows
REM zip producers (including PowerShell's Compress-Archive) emit entries
REM with backslash separators even though the ZIP spec requires '/'. We
REM accept either separator and reject only entries that, after
REM normalization, are empty, absolute, drive-rooted, or contain a '..'
REM segment.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $archive = $null; try { Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive = [IO.Compression.ZipFile]::OpenRead($env:QWEN_ARCHIVE_FILE); foreach ($entry in $archive.Entries) { $raw = $entry.FullName; if ($raw.IndexOfAny([char[]](10,13)) -ge 0) { [Console]::Error.WriteLine('Archive contains unsafe path with control character: ' + $raw); exit 1 }; $name = $raw -replace '\\', '/'; while ($name.StartsWith('./')) { $name = $name.Substring(2) }; if ($name -eq '' -or $name.StartsWith('/') -or $name -match '^[A-Za-z]:' -or $name -match '(^|/)\.\.(/|$)') { [Console]::Error.WriteLine('Archive contains unsafe path: ' + $entry.FullName); exit 1 } } } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 } finally { if ($null -ne $archive) { $archive.Dispose() } }"
set "PS_STATUS=%ERRORLEVEL%"
set "QWEN_ARCHIVE_FILE="
if %PS_STATUS% EQU 0 exit /b 0
if %PS_STATUS% EQU 1 (
    echo ERROR: Archive contains unsafe path entries.
    exit /b 1
)
if %PS_STATUS% EQU 2 (
    echo ERROR: Archive could not be inspected before extraction.
    exit /b 1
)
echo ERROR: Archive validation failed before extraction.
exit /b %PS_STATUS%

:RemoveInstalledDirWithWarning
if not exist "!INSTALL_DIR!" exit /b 0
rmdir /S /Q "!INSTALL_DIR!" >nul 2>&1
if !ERRORLEVEL! NEQ 0 echo WARNING: Failed to remove failed install directory: !INSTALL_DIR!
exit /b 0

:RestoreOldInstall
if not exist "!OLD_INSTALL_DIR!" exit /b 0
move /Y "!OLD_INSTALL_DIR!" "!INSTALL_DIR!" >nul
if !ERRORLEVEL! NEQ 0 (
    echo WARNING: Failed to restore previous install from !OLD_INSTALL_DIR! to !INSTALL_DIR!.
    exit /b 1
)
exit /b 0

:RejectArchiveLinks
set "QWEN_EXTRACT_DIR=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$item = Get-ChildItem -LiteralPath $env:QWEN_EXTRACT_DIR -Recurse -Force | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } | Select-Object -First 1; if ($item) { exit 1 }"
set "PS_STATUS=%ERRORLEVEL%"
set "QWEN_EXTRACT_DIR="
if %PS_STATUS% NEQ 0 echo ERROR: Archive contains symlinks or reparse points; refusing to install.
exit /b %PS_STATUS%

:EnsureManagedInstallDir
set "MANAGED_DIR=%~1"
set "QWEN_MANAGED_DIR=!MANAGED_DIR!"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $dir = $env:QWEN_MANAGED_DIR; if (!(Test-Path -LiteralPath $dir)) { exit 0 }; if (!(Test-Path -LiteralPath $dir -PathType Container)) { exit 1 }; $manifest = Join-Path $dir 'manifest.json'; if (!(Test-Path -LiteralPath $manifest -PathType Leaf)) { exit 1 }; try { $data = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json } catch { exit 1 }; if ($data.name -ne '@qwen-code/qwen-code') { exit 1 }; if ([string]$data.target -notmatch '^win-(x64|arm64)$') { exit 1 }; if (!(Test-Path -LiteralPath (Join-Path $dir 'bin\qwen.cmd') -PathType Leaf)) { exit 1 }; if (!(Test-Path -LiteralPath (Join-Path $dir 'node\node.exe') -PathType Leaf)) { exit 1 }; exit 0"
set "PS_STATUS=!ERRORLEVEL!"
set "QWEN_MANAGED_DIR="
if !PS_STATUS! EQU 0 exit /b 0

echo ERROR: !MANAGED_DIR! exists but is not a Qwen Code standalone install.
echo ERROR: Refusing to overwrite it. Move or remove it manually, then rerun the installer.
exit /b 1

:RequireNode
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js was not found.
    echo.
    echo Node.js 22 or newer is required before installing Qwen Code with npm.
    echo Please install Node.js from https://nodejs.org/ and rerun this installer.
    exit /b 1
)

for /f "delims=" %%i in ('node -p "process.versions.node" 2^>nul') do set "NODE_VERSION=%%i"
if "%NODE_VERSION%"=="" (
    echo ERROR: Unable to determine Node.js version.
    echo Node.js 22 or newer is required before installing Qwen Code with npm.
    exit /b 1
)

for /f "tokens=1 delims=." %%a in ("%NODE_VERSION%") do set "MAJOR_VERSION=%%a"
set /a NODE_MAJOR_NUM=%MAJOR_VERSION% >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Unable to determine Node.js version.
    echo Node.js 22 or newer is required before installing Qwen Code with npm.
    exit /b 1
)

if %NODE_MAJOR_NUM% LSS 22 (
    echo ERROR: Node.js %NODE_VERSION% is installed, but Node.js 22 or newer is required.
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

set "QWEN_DIR=!USERPROFILE!\.qwen"
call :EnsureDir "!QWEN_DIR!"
if !ERRORLEVEL! NEQ 0 exit /b 1

(
echo {
echo   "source": "!SOURCE!"
echo }
) > "!QWEN_DIR!\source.json"

echo SUCCESS: Installation source saved to !USERPROFILE!\.qwen\source.json
exit /b 0

:PrintFinalInstructions
set "EXTRA_BIN=%~1"

set "INSTALLED_BIN="
if not "!EXTRA_BIN!"=="" (
    set "INSTALLED_BIN=!EXTRA_BIN!\qwen.cmd"
    set "PATH=!EXTRA_BIN!;!PATH!"
)

echo.
echo ===========================================
echo Installation completed!
echo ===========================================
echo.

set "INSTALLED_VERSION=unknown"
if not "!INSTALLED_BIN!"=="" if exist "!INSTALLED_BIN!" (
    for /f "delims=" %%i in ('"!INSTALLED_BIN!" --version 2^>nul') do set "INSTALLED_VERSION=%%i"
)

if not "!INSTALLED_BIN!"=="" (
    echo SUCCESS: Installed at !INSTALLED_BIN!: !INSTALLED_VERSION!
) else (
    echo SUCCESS: Qwen Code installed: !INSTALLED_VERSION!
)

rem Build OTHER_QWENS = PRE_INSTALL_QWENS_LIST minus the install we just made.
set "OTHER_QWENS="
if defined PRE_INSTALL_QWENS_LIST (
    for %%i in ("!PRE_INSTALL_QWENS_LIST:|=" "!") do (
        set "ENTRY=%%~i"
        if not "!ENTRY!"=="" if /i not "!ENTRY!"=="!INSTALLED_BIN!" (
            if "!OTHER_QWENS!"=="" (
                set "OTHER_QWENS=!ENTRY!"
            ) else (
                set "OTHER_QWENS=!OTHER_QWENS!|!ENTRY!"
            )
        )
    )
)

if defined OTHER_QWENS (
    echo.
    echo WARNING: Other 'qwen' executables exist on this system. Depending on
    echo WARNING: your PATH order, one of these may run instead of the install above:
    for %%i in ("!OTHER_QWENS:|=" "!") do (
        set "OQ=%%~i"
        if not "!OQ!"=="" echo WARNING:   !OQ!
    )
    echo.
    if /i "!NO_MODIFY_PATH!"=="1" (
        echo Skipped user PATH update because --no-modify-path is set.
        echo To make this install win, add this to your user PATH manually:
        echo   !EXTRA_BIN!
    ) else (
        call :MaybeUpdateUserPath "!EXTRA_BIN!"
        if !ERRORLEVEL! NEQ 0 (
            echo WARNING: Failed to update user PATH. Add the directory manually:
            echo   !EXTRA_BIN!
        )
        echo.
        echo If you prefer not to modify user PATH, rerun with --no-modify-path
        echo and pick one of:
        echo   - npm uninstall -g @qwen-code/qwen-code   ^(if the shadow is an npm install^)
        echo   - invoke directly: "!INSTALLED_BIN!"
    )
    exit /b 0
)

where qwen >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
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
)

echo.
echo You can now run: qwen
echo.
echo INFO: Run qwen in your project directory to start an interactive session.
exit /b 0
