# Qwen Code Windows hosted PowerShell entrypoint.
# Pairs with install-qwen-standalone.bat: this shim downloads the .bat into TEMP,
# verifies its checksum, and runs it with forwarded arguments.
#
# PowerShell (runs in current session, qwen available immediately):
#   irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex
#
# cmd.exe (runs in current session, qwen available immediately):
#   curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.bat -o %TEMP%\install-qwen.bat && %TEMP%\install-qwen.bat
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

function Download-File {
    param([string]$Url, [string]$OutFile)
    $prevProgressPreference = $global:ProgressPreference
    $global:ProgressPreference = 'SilentlyContinue'
    try {
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            curl.exe -sSfLo $OutFile $Url
            if ($LASTEXITCODE -ne 0) {
                throw "curl.exe download failed (exit code $LASTEXITCODE)"
            }
            return
        }
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -MaximumRedirection 10
    } finally {
        $global:ProgressPreference = $prevProgressPreference
    }
}

function Get-QwenInstallBinDir {
    if (-not [string]::IsNullOrEmpty($env:QWEN_INSTALL_BIN_DIR)) {
        return $env:QWEN_INSTALL_BIN_DIR
    }

    if (-not [string]::IsNullOrEmpty($env:QWEN_INSTALL_ROOT)) {
        return Join-Path $env:QWEN_INSTALL_ROOT 'bin'
    }

    if (-not [string]::IsNullOrEmpty($env:LOCALAPPDATA)) {
        return Join-Path (Join-Path $env:LOCALAPPDATA 'qwen-code') 'bin'
    }

    return Join-Path (Join-Path $env:USERPROFILE 'AppData\Local\qwen-code') 'bin'
}

function Update-CurrentSessionPath {
    param([string]$BinDir)

    if ([string]::IsNullOrEmpty($BinDir)) {
        return
    }

    $entries = @($env:Path -split ';' | Where-Object { -not [string]::IsNullOrEmpty($_) })
    foreach ($entry in $entries) {
        if ([string]::Equals($entry, $BinDir, [StringComparison]::OrdinalIgnoreCase)) {
            return
        }
    }

    $env:Path = (@($BinDir) + $entries) -join ';'
}

function Get-ParentProcessName {
    try {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop
        if ($null -eq $current -or $null -eq $current.ParentProcessId) {
            return $null
        }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($current.ParentProcessId)" -ErrorAction Stop
        if ($null -eq $parent) {
            return $null
        }
        return $parent.Name
    } catch {
        return $null
    }
}

function Update-CurrentShell {
    $qwenInstallBinDir = Get-QwenInstallBinDir
    $qwenCommandPath = Join-Path $qwenInstallBinDir 'qwen.cmd'
    if (-not (Test-Path -LiteralPath $qwenCommandPath -PathType Leaf)) {
        return
    }

    Update-CurrentSessionPath -BinDir $qwenInstallBinDir

    Write-Output "Run: qwen"
    $parentProcessName = Get-ParentProcessName
    if ($parentProcessName -ieq 'cmd.exe') {
        Write-Output "Or, for this cmd.exe window, run:"
        Write-Output "  set `"PATH=${qwenInstallBinDir};%PATH%`""
        return
    }
}

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
    Download-File -Url $qwenInstallerUrl -OutFile $qwenInstallerPath
} catch {
    Write-Error "Failed to download Qwen Code installer from ${qwenInstallerUrl}: $($_.Exception.Message)"
    exit 1
}

try {
    Download-File -Url $qwenChecksumsUrl -OutFile $qwenChecksumsPath
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
$qwenPreviousParentPowerShell = $env:QWEN_INSTALLER_PARENT_POWERSHELL
try {
    $env:QWEN_INSTALLER_PARENT_POWERSHELL = '1'
    & $qwenInstallerPath @args
    $qwenInstallerExitCode = $LASTEXITCODE
} finally {
    if ($null -eq $qwenPreviousParentPowerShell) {
        Remove-Item Env:\QWEN_INSTALLER_PARENT_POWERSHELL -ErrorAction SilentlyContinue
    } else {
        $env:QWEN_INSTALLER_PARENT_POWERSHELL = $qwenPreviousParentPowerShell
    }
    Remove-Item -LiteralPath $qwenInstallerPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $qwenChecksumsPath -Force -ErrorAction SilentlyContinue
}

if ($qwenInstallerExitCode -ne 0) {
    exit $qwenInstallerExitCode
}

Update-CurrentShell
