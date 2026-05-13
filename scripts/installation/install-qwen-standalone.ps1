# Qwen Code Windows hosted PowerShell entrypoint.
# Pairs with install-qwen-standalone.bat: this shim downloads the .bat into TEMP and runs
# it, so the documented one-liner can use the standard irm | iex pattern.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -c "irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex"
#
# To pin a specific release, set $env:QWEN_INSTALL_VERSION before invoking,
# e.g. $env:QWEN_INSTALL_VERSION = 'vX.Y.Z'. This is equivalent to passing
# --version vX.Y.Z to install-qwen-standalone.bat directly.
#
# To point this shim at a non-production hosted endpoint (staging buckets,
# private mirrors), set $env:QWEN_INSTALLER_BAT_URL to the alternate .bat URL.
# The override is required to be HTTPS so a misconfigured value can't silently
# downgrade the download channel. The downstream .bat continues to honor
# QWEN_INSTALL_BASE_URL for archive resolution.

$ErrorActionPreference = 'Stop'

$qwenDefaultInstallerUrl = 'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.bat'
if ([string]::IsNullOrEmpty($env:QWEN_INSTALLER_BAT_URL)) {
    $qwenInstallerUrl = $qwenDefaultInstallerUrl
} else {
    if ($env:QWEN_INSTALLER_BAT_URL -notmatch '^https://') {
        Write-Error "QWEN_INSTALLER_BAT_URL must start with https://"
        exit 1
    }
    $qwenInstallerUrl = $env:QWEN_INSTALLER_BAT_URL
}
$qwenInstallerPath = Join-Path $env:TEMP 'install-qwen-standalone.bat'

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
