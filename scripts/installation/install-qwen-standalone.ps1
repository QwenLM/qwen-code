# Qwen Code Windows hosted PowerShell entrypoint.
# Pairs with install-qwen-standalone.bat: this shim downloads the .bat into TEMP and runs
# it, so the documented one-liner can use the standard irm | iex pattern.
# Note: irm (Invoke-RestMethod) and iwr (Invoke-WebRequest) both return the raw
# text of a .ps1 file unchanged, so the one-liner works with either alias.
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
#
# By default the matching SHA256SUMS file is read from the same hosted
# directory as the .bat. Set $env:QWEN_INSTALLER_CHECKSUMS_URL to override it
# when testing a custom installer endpoint.

$ErrorActionPreference = 'Stop'

$qwenDefaultInstallerUrl = 'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.bat'
$qwenDefaultChecksumsUrl = 'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/SHA256SUMS'
if ([string]::IsNullOrEmpty($env:QWEN_INSTALLER_BAT_URL)) {
    $qwenInstallerUrl = $qwenDefaultInstallerUrl
} else {
    if ($env:QWEN_INSTALLER_BAT_URL -notmatch '^https://') {
        Write-Error "QWEN_INSTALLER_BAT_URL must start with https://"
        exit 1
    }
    $qwenInstallerUrl = $env:QWEN_INSTALLER_BAT_URL
}

if ([string]::IsNullOrEmpty($env:QWEN_INSTALLER_CHECKSUMS_URL)) {
    if ($qwenInstallerUrl -eq $qwenDefaultInstallerUrl) {
        $qwenChecksumsUrl = $qwenDefaultChecksumsUrl
    } else {
        $qwenChecksumsUrl = [Uri]::new([Uri]$qwenInstallerUrl, 'SHA256SUMS').AbsoluteUri
    }
} else {
    if ($env:QWEN_INSTALLER_CHECKSUMS_URL -notmatch '^https://') {
        Write-Error "QWEN_INSTALLER_CHECKSUMS_URL must start with https://"
        exit 1
    }
    $qwenChecksumsUrl = $env:QWEN_INSTALLER_CHECKSUMS_URL
}

$qwenInstallerName = [IO.Path]::GetFileName(([Uri]$qwenInstallerUrl).AbsolutePath)
if ([string]::IsNullOrEmpty($qwenInstallerName)) {
    $qwenInstallerName = 'install-qwen-standalone.bat'
}
$qwenInstallerPath = Join-Path $env:TEMP $qwenInstallerName
$qwenChecksumsPath = Join-Path $env:TEMP 'qwen-installation-SHA256SUMS'

try {
    Invoke-WebRequest -Uri $qwenInstallerUrl `
        -OutFile $qwenInstallerPath `
        -UseBasicParsing `
        -MaximumRedirection 10
} catch {
    Write-Error "Failed to download Qwen Code installer from ${qwenInstallerUrl}: $($_.Exception.Message)"
    exit 1
}

try {
    Invoke-WebRequest -Uri $qwenChecksumsUrl `
        -OutFile $qwenChecksumsPath `
        -UseBasicParsing `
        -MaximumRedirection 10
} catch {
    Remove-Item -LiteralPath $qwenInstallerPath -Force -ErrorAction SilentlyContinue
    Write-Error "Failed to download Qwen Code installer checksums from ${qwenChecksumsUrl}: $($_.Exception.Message)"
    exit 1
}

$qwenExpectedHash = $null
foreach ($qwenChecksumLine in Get-Content -LiteralPath $qwenChecksumsPath) {
    if ($qwenChecksumLine -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
        if ($Matches[2] -eq $qwenInstallerName) {
            $qwenExpectedHash = $Matches[1].ToLowerInvariant()
            break
        }
    }
}
if ([string]::IsNullOrEmpty($qwenExpectedHash)) {
    Remove-Item -LiteralPath $qwenInstallerPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $qwenChecksumsPath -Force -ErrorAction SilentlyContinue
    Write-Error "Checksum entry for ${qwenInstallerName} not found in ${qwenChecksumsUrl}"
    exit 1
}

$qwenActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $qwenInstallerPath).Hash.ToLowerInvariant()
if ($qwenActualHash -ne $qwenExpectedHash) {
    Remove-Item -LiteralPath $qwenInstallerPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $qwenChecksumsPath -Force -ErrorAction SilentlyContinue
    Write-Error "Checksum verification failed for ${qwenInstallerName}."
    exit 1
}

$qwenInstallerExitCode = 0
try {
    & $qwenInstallerPath @args
    $qwenInstallerExitCode = $LASTEXITCODE
} finally {
    Remove-Item -LiteralPath $qwenInstallerPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $qwenChecksumsPath -Force -ErrorAction SilentlyContinue
}

if ($qwenInstallerExitCode -ne 0) {
    exit $qwenInstallerExitCode
}
