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
            curl.exe --connect-timeout 15 --max-time 300 --retry 2 -sSfLo $OutFile $Url
            if ($LASTEXITCODE -ne 0) {
                throw "curl.exe download failed (exit code $LASTEXITCODE)"
            }
            return
        }
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -MaximumRedirection 10 -TimeoutSec 300
    } finally {
        $global:ProgressPreference = $prevProgressPreference
    }
}

function Get-QwenInstallBase {
    if (-not [string]::IsNullOrEmpty($env:QWEN_INSTALL_ROOT)) {
        return $env:QWEN_INSTALL_ROOT
    }

    if (-not [string]::IsNullOrEmpty($env:LOCALAPPDATA)) {
        return Join-Path $env:LOCALAPPDATA 'qwen-code'
    }

    return Join-Path (Join-Path $env:USERPROFILE 'AppData\Local') 'qwen-code'
}

function Get-QwenInstallBinDir {
    if (-not [string]::IsNullOrEmpty($env:QWEN_INSTALL_BIN_DIR)) {
        return $env:QWEN_INSTALL_BIN_DIR
    }

    return Join-Path (Get-QwenInstallBase) 'bin'
}

function Get-CurrentCmdShimStatePath {
    return Join-Path (Get-QwenInstallBase) 'current-cmd-shim.txt'
}

function Save-CurrentCmdPathShim {
    param([string]$ShimPath)

    if ([string]::IsNullOrEmpty($ShimPath)) {
        return
    }

    try {
        $statePath = Get-CurrentCmdShimStatePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $statePath) -Force | Out-Null
        [IO.File]::WriteAllText($statePath, $ShimPath, [Text.UTF8Encoding]::new($false))
    } catch {
        # Best-effort cleanup hint only. The installer still works if this fails.
    }
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

function Get-NormalizedPath {
    param([string]$PathValue)

    if ([string]::IsNullOrEmpty($PathValue)) {
        return $null
    }

    $trimmed = $PathValue.Trim().Trim('"')
    if ([string]::IsNullOrEmpty($trimmed)) {
        return $null
    }

    try {
        return [IO.Path]::GetFullPath($trimmed).TrimEnd('\')
    } catch {
        return $trimmed.TrimEnd('\')
    }
}

function Test-PathContainsDirectory {
    param([string]$PathValue, [string]$Directory)

    $target = Get-NormalizedPath -PathValue $Directory
    if ([string]::IsNullOrEmpty($target)) {
        return $false
    }

    foreach ($entry in @($PathValue -split ';')) {
        $normalizedEntry = Get-NormalizedPath -PathValue $entry
        if ([string]::Equals($normalizedEntry, $target, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    return $false
}

function Test-WritableDirectory {
    param([string]$Directory)

    if ([string]::IsNullOrEmpty($Directory)) {
        return $false
    }

    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        return $false
    }

    $probe = Join-Path $Directory ('.qwen-write-test-' + [IO.Path]::GetRandomFileName())
    try {
        [IO.File]::WriteAllText($probe, '')
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $false
    }
}

function Add-PathCandidate {
    param(
        [System.Collections.Generic.List[string]]$Candidates,
        [string]$Directory
    )

    $normalizedDirectory = Get-NormalizedPath -PathValue $Directory
    if ([string]::IsNullOrEmpty($normalizedDirectory)) {
        return
    }

    foreach ($candidate in $Candidates) {
        $normalizedCandidate = Get-NormalizedPath -PathValue $candidate
        if ([string]::Equals($normalizedCandidate, $normalizedDirectory, [StringComparison]::OrdinalIgnoreCase)) {
            return
        }
    }

    [void]$Candidates.Add($Directory.Trim().Trim('"'))
}

function Test-SystemManagedPathDirectory {
    param([string]$Directory)

    $normalizedDirectory = Get-NormalizedPath -PathValue $Directory
    return (
        -not [string]::IsNullOrEmpty($normalizedDirectory) -and
        $normalizedDirectory -match '\\Microsoft\\WindowsApps$'
    )
}

function Install-CurrentCmdPathShim {
    param([string]$QwenCommand, [string]$PathValue)

    $pathEntries = @($PathValue -split ';' | Where-Object { -not [string]::IsNullOrEmpty($_) })
    $candidates = [System.Collections.Generic.List[string]]::new()
    $preferredDirectories = @()

    if (-not [string]::IsNullOrEmpty($env:APPDATA)) {
        $preferredDirectories += Join-Path $env:APPDATA 'npm'
    }
    if (-not [string]::IsNullOrEmpty($env:USERPROFILE)) {
        $preferredDirectories += Join-Path $env:USERPROFILE '.bun\bin'
    }

    foreach ($preferredDirectory in $preferredDirectories) {
        $preferredNormalized = Get-NormalizedPath -PathValue $preferredDirectory
        foreach ($entry in $pathEntries) {
            $entryNormalized = Get-NormalizedPath -PathValue $entry
            if ([string]::Equals($entryNormalized, $preferredNormalized, [StringComparison]::OrdinalIgnoreCase)) {
                Add-PathCandidate -Candidates $candidates -Directory $entry
            }
        }
    }

    $userRoot = Get-NormalizedPath -PathValue $env:USERPROFILE
    foreach ($entry in $pathEntries) {
        if (Test-SystemManagedPathDirectory -Directory $entry) {
            continue
        }
        $entryNormalized = Get-NormalizedPath -PathValue $entry
        if (
            -not [string]::IsNullOrEmpty($userRoot) -and
            -not [string]::IsNullOrEmpty($entryNormalized) -and
            $entryNormalized.StartsWith($userRoot, [StringComparison]::OrdinalIgnoreCase)
        ) {
            Add-PathCandidate -Candidates $candidates -Directory $entry
        }
    }

    foreach ($candidate in $candidates) {
        if (-not (Test-WritableDirectory -Directory $candidate)) {
            continue
        }

        $shimPath = Join-Path $candidate 'qwen.cmd'
        if (Test-Path -LiteralPath $shimPath -PathType Leaf) {
            $existingShim = Get-Content -LiteralPath $shimPath -Raw -ErrorAction SilentlyContinue
            if ($existingShim -notmatch 'Qwen Code current-session shim') {
                continue
            }
        }

        $shim = "@echo off`r`nREM Qwen Code current-session shim. Generated by install-qwen-standalone.ps1.`r`ncall `"$QwenCommand`" %*`r`n"
        # Write to a sibling temp file first, then atomically rename so a partial
        # write (process killed, disk full) cannot leave a half-written shim on
        # PATH.
        $shimTempPath = "$shimPath.new"
        [IO.File]::WriteAllText($shimTempPath, $shim, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $shimTempPath -Destination $shimPath -Force
        Save-CurrentCmdPathShim -ShimPath $shimPath
        return $shimPath
    }

    return $null
}

function Update-CurrentShell {
    $qwenInstallBinDir = Get-QwenInstallBinDir
    $qwenCommandPath = Join-Path $qwenInstallBinDir 'qwen.cmd'
    if (-not (Test-Path -LiteralPath $qwenCommandPath -PathType Leaf)) {
        return
    }

    if ($env:QWEN_NO_MODIFY_PATH -eq '1') {
        Write-Output "Run: ${qwenCommandPath}"
        Write-Output "INFO: QWEN_NO_MODIFY_PATH=1; skipping current-session PATH refresh."
        return
    }

    $inheritedPath = $env:Path
    Update-CurrentSessionPath -BinDir $qwenInstallBinDir

    Write-Output "Run: qwen"
    $parentProcessName = Get-ParentProcessName
    if ($parentProcessName -ieq 'cmd.exe') {
        if (Test-PathContainsDirectory -PathValue $inheritedPath -Directory $qwenInstallBinDir) {
            Write-Output "qwen is ready to use after this installer command returns."
            return
        }

        $shimPath = Install-CurrentCmdPathShim -QwenCommand $qwenCommandPath -PathValue $inheritedPath
        if (-not [string]::IsNullOrEmpty($shimPath)) {
            Write-Output "INFO: Added qwen.cmd to a directory already on this cmd.exe PATH:"
            Write-Output "INFO:   ${shimPath}"
            Write-Output "qwen is ready to use after this installer command returns."
            return
        }

        Write-Output "WARNING: Windows does not allow this PowerShell child process to update the parent cmd.exe PATH directly."
        Write-Output "Or, for this cmd.exe window, run:"
        Write-Output "  set `"PATH=${qwenInstallBinDir};%PATH%`""
        return
    }

    Write-Output "qwen is ready to use in this PowerShell session."
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
if ([string]::IsNullOrEmpty($env:TEMP)) {
    Write-Error "TEMP environment variable is not set. Please set TEMP to a writable directory."
    exit 1
}
# Use a cryptographically random staging filename so a same-user attacker cannot
# pre-stage a malicious .bat at a predictable path and race the verify/execute
# window between Get-FileHash and `& $qwenInstallerPath`.
$qwenStagingSuffix = [IO.Path]::GetRandomFileName()
$qwenInstallerPath = Join-Path $env:TEMP "qwen-installer-$qwenStagingSuffix.bat"
$qwenChecksumsPath = Join-Path $env:TEMP "qwen-installation-SHA256SUMS-$qwenStagingSuffix"

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
    Write-Error "Checksum mismatch for ${qwenInstallerName}: expected ${qwenExpectedHash}, got ${qwenActualHash}."
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
