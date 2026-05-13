# Qwen Code Windows hosted PowerShell entrypoint.
# Pairs with install-qwen.bat: this shim downloads the .bat into TEMP and runs
# it, so the documented one-liner can use the standard irm | iex pattern.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -c "irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.ps1 | iex"
#
# To pin a specific release, set $env:QWEN_INSTALL_VERSION before invoking,
# e.g. $env:QWEN_INSTALL_VERSION = 'vX.Y.Z'. This is equivalent to passing
# --version vX.Y.Z to install-qwen.bat directly.

$ErrorActionPreference = 'Stop'

$qwenInstallerUrl = 'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.bat'
$qwenInstallerPath = Join-Path $env:TEMP 'install-qwen.bat'

try {
    Invoke-WebRequest -Uri $qwenInstallerUrl `
        -OutFile $qwenInstallerPath `
        -UseBasicParsing `
        -MaximumRedirection 10
} catch {
    Write-Error "Failed to download Qwen Code installer from ${qwenInstallerUrl}: $($_.Exception.Message)"
    exit 1
}

$qwenInstallerExitCode = 0
try {
    & $qwenInstallerPath @args
    $qwenInstallerExitCode = $LASTEXITCODE
} finally {
    Remove-Item -Path $qwenInstallerPath -Force -ErrorAction SilentlyContinue
}

if ($qwenInstallerExitCode -ne 0) {
    exit $qwenInstallerExitCode
}
