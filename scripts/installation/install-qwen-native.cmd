@echo off
:: Release template: source copies require placeholder rendering before use.
setlocal DisableDelayedExpansion
:: CMD uses the same Windows PowerShell bootstrap, not a second installer.
:: Usage: curl -fsSL __BASE_URL__/install.cmd -o install.cmd && install.cmd
where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo Error: Windows PowerShell 5.1 or newer is required. 1>&2
  exit /b 1
)
where curl.exe >nul 2>&1
if errorlevel 1 (
  echo Error: curl.exe is required. 1>&2
  exit /b 1
)
set "QWEN_INSTALL_TEMP=%TEMP%\qwen-install-%RANDOM%%RANDOM%"
mkdir "%QWEN_INSTALL_TEMP%" >nul 2>&1
if errorlevel 1 (
  echo Error: cannot create temporary directory. 1>&2
  exit /b 1
)
curl.exe --proto "=https" --proto-redir "=https" -fsSL --retry 2 --connect-timeout 20 --max-time 90 "__BASE_URL__/install.ps1" -o "%QWEN_INSTALL_TEMP%\install.ps1"
if errorlevel 1 goto :failed
:: Execution policy is scoped to this child process; no machine policy is changed.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%QWEN_INSTALL_TEMP%\install.ps1" %*
set "QWEN_INSTALL_EXIT=%ERRORLEVEL%"
rmdir /s /q "%QWEN_INSTALL_TEMP%" >nul 2>&1
exit /b %QWEN_INSTALL_EXIT%
:failed
rmdir /s /q "%QWEN_INSTALL_TEMP%" >nul 2>&1
exit /b 1
