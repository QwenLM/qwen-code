@echo off
setlocal enabledelayedexpansion

REM Setup paths
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "NODE_SCRIPT=%SCRIPT_DIR%\index.js"

REM Setup log directory - prefer user-writable locations
REM Windows: %LOCALAPPDATA%\mcp-chrome-bridge\logs
set "LOG_DIR=%LOCALAPPDATA%\mcp-chrome-bridge\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" 2>nul
if not exist "%LOG_DIR%" (
    REM Fallback to package directory if user directory not writable
    set "LOG_DIR=%SCRIPT_DIR%\logs"
    if not exist "!LOG_DIR!" mkdir "!LOG_DIR!" 2>nul
)

REM Generate timestamp
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format 'yyyyMMdd_HHmmss'"') do set "TIMESTAMP=%%i"
set "WRAPPER_LOG=%LOG_DIR%\native_host_wrapper_windows_%TIMESTAMP%.log"
set "STDERR_LOG=%LOG_DIR%\native_host_stderr_windows_%TIMESTAMP%.log"

REM Initial logging
echo Wrapper script called at %DATE% %TIME% > "%WRAPPER_LOG%"
echo SCRIPT_DIR: %SCRIPT_DIR% >> "%WRAPPER_LOG%"
echo LOG_DIR: %LOG_DIR% >> "%WRAPPER_LOG%"
echo NODE_SCRIPT: %NODE_SCRIPT% >> "%WRAPPER_LOG%"
echo Initial PATH: %PATH% >> "%WRAPPER_LOG%"
echo CHROME_MCP_NODE_PATH: %CHROME_MCP_NODE_PATH% >> "%WRAPPER_LOG%"
echo VOLTA_HOME: %VOLTA_HOME% >> "%WRAPPER_LOG%"
echo ASDF_DATA_DIR: %ASDF_DATA_DIR% >> "%WRAPPER_LOG%"
echo FNM_DIR: %FNM_DIR% >> "%WRAPPER_LOG%"
echo User: %USERNAME% >> "%WRAPPER_LOG%"
echo Current PWD: %CD% >> "%WRAPPER_LOG%"

REM Node.js discovery
set "NODE_EXEC="
set "NODE_EXEC_SOURCE="

REM Priority 0: CHROME_MCP_NODE_PATH environment variable override
echo [Priority 0] Checking CHROME_MCP_NODE_PATH override >> "%WRAPPER_LOG%"
if defined CHROME_MCP_NODE_PATH (
    set "CANDIDATE_NODE=%CHROME_MCP_NODE_PATH%"
    REM Check if it's a directory, then append node.exe
    if exist "!CANDIDATE_NODE!\*" (
        set "CANDIDATE_NODE=!CANDIDATE_NODE!\node.exe"
    )
    if exist "!CANDIDATE_NODE!" (
        set "NODE_EXEC=!CANDIDATE_NODE!"
        set "NODE_EXEC_SOURCE=CHROME_MCP_NODE_PATH"
        echo Found node via CHROME_MCP_NODE_PATH: !NODE_EXEC! >> "%WRAPPER_LOG%"
    ) else (
        echo CHROME_MCP_NODE_PATH is set but not found: !CANDIDATE_NODE! >> "%WRAPPER_LOG%"
    )
)

REM Priority 1: Installation-time node path
set "NODE_PATH_FILE=%SCRIPT_DIR%\node_path.txt"
echo [Priority 1] Checking installation-time node path >> "%WRAPPER_LOG%"
if not defined NODE_EXEC (
    if exist "%NODE_PATH_FILE%" (
        set /p EXPECTED_NODE=<"%NODE_PATH_FILE%"
        if exist "!EXPECTED_NODE!" (
            set "NODE_EXEC=!EXPECTED_NODE!"
            set "NODE_EXEC_SOURCE=node_path.txt"
            echo Found installation-time node at !NODE_EXEC! >> "%WRAPPER_LOG%"
        ) else (
            echo node_path.txt exists but path invalid: !EXPECTED_NODE! >> "%WRAPPER_LOG%"
        )
    )
)

REM Priority 1.5: Fallback to relative path
if not defined NODE_EXEC (
    set "EXPECTED_NODE=%SCRIPT_DIR%\..\..\..\node.exe"
    echo [Priority 1.5] Checking relative path >> "%WRAPPER_LOG%"
    if exist "%EXPECTED_NODE%" (
        set "NODE_EXEC=%EXPECTED_NODE%"
        set "NODE_EXEC_SOURCE=relative"
        echo Found node at relative path: !NODE_EXEC! >> "%WRAPPER_LOG%"
    )
)

REM Priority 2: Volta
if not defined NODE_EXEC (
    echo [Priority 2] Checking Volta >> "%WRAPPER_LOG%"
    if defined VOLTA_HOME (
        if exist "%VOLTA_HOME%\bin\node.exe" (
            set "NODE_EXEC=%VOLTA_HOME%\bin\node.exe"
            set "NODE_EXEC_SOURCE=volta"
            echo Found Volta node: !NODE_EXEC! >> "%WRAPPER_LOG%"
        )
    ) else (
        if exist "%USERPROFILE%\.volta\bin\node.exe" (
            set "NODE_EXEC=%USERPROFILE%\.volta\bin\node.exe"
            set "NODE_EXEC_SOURCE=volta"
            echo Found Volta node: !NODE_EXEC! >> "%WRAPPER_LOG%"
        )
    )
)

REM Priority 3: asdf (use PowerShell to find latest version)
if not defined NODE_EXEC (
    echo [Priority 3] Checking asdf >> "%WRAPPER_LOG%"
    set "ASDF_NODE="
    for /f "delims=" %%i in ('powershell -NoProfile -Command "$base=$env:ASDF_DATA_DIR; if(-not $base){$base=Join-Path $env:USERPROFILE '.asdf'}; $root=Join-Path $base 'installs\nodejs'; $best=$null; if(Test-Path $root){ foreach($d in (Get-ChildItem -Directory -Path $root -ErrorAction SilentlyContinue)){ if($d.Name -match '^v?\d+(\.\d+){1,3}$'){ $v=[version]($d.Name -replace '^v',''); if(-not $best -or $v -gt $best.Ver){ $best=[pscustomobject]@{Ver=$v;Dir=$d.FullName} } } } }; if($best){ $p=Join-Path $best.Dir 'bin\node.exe'; if(Test-Path $p){ Write-Output $p } }" 2^>nul') do set "ASDF_NODE=%%i"
    if defined ASDF_NODE (
        set "NODE_EXEC=!ASDF_NODE!"
        set "NODE_EXEC_SOURCE=asdf"
        echo Found asdf node: !NODE_EXEC! >> "%WRAPPER_LOG%"
    )
)

REM Priority 4: fnm (use PowerShell to find latest version)
if not defined NODE_EXEC (
    echo [Priority 4] Checking fnm >> "%WRAPPER_LOG%"
    set "FNM_NODE="
    for /f "delims=" %%i in ('powershell -NoProfile -Command "$base=$env:FNM_DIR; if(-not $base){$base=Join-Path $env:USERPROFILE '.fnm'}; $root=Join-Path $base 'node-versions'; $best=$null; if(Test-Path $root){ foreach($d in (Get-ChildItem -Directory -Path $root -ErrorAction SilentlyContinue)){ if($d.Name -match '^v?\d+(\.\d+){1,3}$'){ $v=[version]($d.Name -replace '^v',''); if(-not $best -or $v -gt $best.Ver){ $best=[pscustomobject]@{Ver=$v;Dir=$d.FullName} } } } }; if($best){ $p=Join-Path $best.Dir 'installation\node.exe'; if(Test-Path $p){ Write-Output $p } }" 2^>nul') do set "FNM_NODE=%%i"
    if defined FNM_NODE (
        set "NODE_EXEC=!FNM_NODE!"
        set "NODE_EXEC_SOURCE=fnm"
        echo Found fnm node: !NODE_EXEC! >> "%WRAPPER_LOG%"
    )
)

REM Priority 5: where command
if not defined NODE_EXEC (
    echo [Priority 5] Trying 'where node.exe' >> "%WRAPPER_LOG%"
    for /f "delims=" %%i in ('where node.exe 2^>nul') do (
        if not defined NODE_EXEC (
            set "NODE_EXEC=%%i"
            set "NODE_EXEC_SOURCE=where"
            echo Found node using 'where': !NODE_EXEC! >> "%WRAPPER_LOG%"
        )
    )
)

REM Priority 6: Common paths
if not defined NODE_EXEC (
    echo [Priority 6] Checking common paths >> "%WRAPPER_LOG%"
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "NODE_EXEC=%ProgramFiles%\nodejs\node.exe"
        set "NODE_EXEC_SOURCE=common"
        echo Found node at !NODE_EXEC! >> "%WRAPPER_LOG%"
    ) else if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
        set "NODE_EXEC=%ProgramFiles(x86)%\nodejs\node.exe"
        set "NODE_EXEC_SOURCE=common"
        echo Found node at !NODE_EXEC! >> "%WRAPPER_LOG%"
    ) else if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
        set "NODE_EXEC=%LOCALAPPDATA%\Programs\nodejs\node.exe"
        set "NODE_EXEC_SOURCE=common"
        echo Found node at !NODE_EXEC! >> "%WRAPPER_LOG%"
    )
)

REM Validation
if not defined NODE_EXEC (
    echo ERROR: Node.js executable not found! >> "%WRAPPER_LOG%"
    echo Searched: CHROME_MCP_NODE_PATH, node_path.txt, relative, Volta, asdf, fnm, where, common paths >> "%WRAPPER_LOG%"
    echo To fix: Set CHROME_MCP_NODE_PATH environment variable or run 'mcp-chrome-bridge doctor --fix' >> "%WRAPPER_LOG%"
    exit /B 1
)

echo Using Node executable: %NODE_EXEC% >> "%WRAPPER_LOG%"
echo Node discovery source: %NODE_EXEC_SOURCE% >> "%WRAPPER_LOG%"
call "%NODE_EXEC%" -v >> "%WRAPPER_LOG%" 2>>&1

if not exist "%NODE_SCRIPT%" (
    echo ERROR: Node.js script not found at %NODE_SCRIPT% >> "%WRAPPER_LOG%"
    exit /B 1
)

REM Add Node.js bin directory to PATH for child processes
for %%I in ("%NODE_EXEC%") do set "NODE_BIN_DIR=%%~dpI"
if defined PATH (set "PATH=%NODE_BIN_DIR%;%PATH%") else (set "PATH=%NODE_BIN_DIR%")
echo Added %NODE_BIN_DIR% to PATH >> "%WRAPPER_LOG%"

REM Log Claude Code Router (CCR) related env vars for debugging
REM These are set via System Properties or PowerShell profile
if defined ANTHROPIC_BASE_URL (
    echo ANTHROPIC_BASE_URL is set: %ANTHROPIC_BASE_URL% >> "%WRAPPER_LOG%"
)
if defined ANTHROPIC_AUTH_TOKEN (
    echo ANTHROPIC_AUTH_TOKEN is set (value hidden) >> "%WRAPPER_LOG%"
)

echo Executing: "%NODE_EXEC%" "%NODE_SCRIPT%" >> "%WRAPPER_LOG%"
call "%NODE_EXEC%" "%NODE_SCRIPT%" 2>> "%STDERR_LOG%"
set "EXIT_CODE=%ERRORLEVEL%"

echo Exit code: %EXIT_CODE% >> "%WRAPPER_LOG%"
endlocal
exit /B %EXIT_CODE%
