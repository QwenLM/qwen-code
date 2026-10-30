# Install a gated release's bun/OpenTUI preview archive (win-x64) into a
# scratch directory. Does not touch PATH, the hosted installer chain, or an
# existing classic installation; delete the install directory to uninstall.
#
# Usage:
#   install-opentui-preview.ps1 -Tag v0.1.11 [-Dir DIR]
#   install-opentui-preview.ps1 -Archive FILE [-Dir DIR]

[CmdletBinding()]
param(
    [string]$Tag,
    [ValidateSet('win-x64')][string]$Target = 'win-x64',
    [string]$Dir = (Join-Path $HOME '.qwen-preview'),
    [string]$Archive
)

$ErrorActionPreference = 'Stop'
$repo = 'QwenLM/qwen-code'

if (-not $Archive -and $Tag -notmatch '^v[0-9A-Za-z.\-]+$') {
    throw 'Tag must look like v0.1.11 (required unless -Archive is given).'
}

$archiveName = "qwen-code-$Target-opentui-preview.zip"
$work = $null
$stage = $null
$lock = $null
$lockPath = $null

try {
    if ($Archive) {
        if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) {
            throw "Archive file not found: $Archive"
        }
        $archivePath = $Archive
        Write-Warning '-Archive given; skipping download and SHA256 verification.'
    }
    else {
        $baseUrl = "https://github.com/$repo/releases/download/$Tag"
        $work = Join-Path $env:TEMP ("qwen-preview-" + [IO.Path]::GetRandomFileName())
        New-Item -ItemType Directory -Force -Path $work | Out-Null
        $archivePath = Join-Path $work $archiveName

        try {
            Invoke-WebRequest -UseBasicParsing "$baseUrl/$archiveName" -OutFile $archivePath
        }
        catch {
            throw "Download failed: $baseUrl/$archiveName (was $Tag released with the OpenTUI preview flavor enabled?)"
        }

        $sumsText = (Invoke-WebRequest -UseBasicParsing "$baseUrl/SHA256SUMS").Content
        $entry = $sumsText -split "`n" |
            Where-Object { $_ -match "[ *]$([regex]::Escape($archiveName))\s*$" } |
            Select-Object -First 1
        if (-not $entry) {
            throw "$archiveName is not listed in the release SHA256SUMS."
        }
        $expectedHash = ($entry -split '\s+')[0].ToLowerInvariant()
        $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw "SHA256 mismatch for ${archiveName}: expected $expectedHash, got $actualHash"
        }
    }

    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $Dir = [IO.Path]::GetFullPath($Dir)
    $lockPath = Join-Path $Dir '.qwen-preview-install.lock'
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $active = Join-Path $Dir 'qwen-code'
    $current = Get-Item -LiteralPath $active -Force -ErrorAction SilentlyContinue
    if ($current) {
        if (-not $current.PSIsContainer -or ($current.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Preview destination must be a regular directory.'
        }
    }
    $stagePath = Join-Path $Dir ('.qwen-preview-stage-' + [IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $stagePath | Out-Null
    $stage = $stagePath
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        if ($zip.Entries.Count -eq 0) { throw 'Preview archive is empty.' }
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($name -notmatch '^qwen-code(?:/|$)' -or $name -match '(^|/)\.\.?(/|$)|[ .](?:/|$)|[\x00-\x1f]' -or $name.Contains(':')) {
                throw "Unsafe preview archive path: $name"
            }
            $kind = ($entry.ExternalAttributes -shr 16) -band 0xF000
            if (($kind -ne 0 -and $kind -ne 0x8000 -and $kind -ne 0x4000) -or ($entry.ExternalAttributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "Preview archive contains a link or special entry: $name"
            }
        }
    }
    finally { $zip.Dispose() }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $stage -Force
    $candidate = Join-Path $stage 'qwen-code'
    foreach ($file in @('manifest.json', 'lib/package.json', 'lib/cli.js', 'lib/cli-entry.js', 'bin/qwen.cmd', 'bun/bun.exe', 'node/node.exe')) {
        $item = Get-Item -LiteralPath (Join-Path $candidate $file) -Force
        if ($item.PSIsContainer -or $item.Length -eq 0 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Preview archive is missing regular file $file"
        }
    }
    $previous = Join-Path $stage 'previous'
    if (Test-Path -LiteralPath $active) { [IO.Directory]::Move($active, $previous) }
    try { [IO.Directory]::Move($candidate, $active) }
    catch {
        if ((Test-Path -LiteralPath $previous) -and -not (Test-Path -LiteralPath $active)) {
            [IO.Directory]::Move($previous, $active)
        }
        throw
    }
    if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }

    Write-Host "installed: $(Join-Path $Dir 'qwen-code')"
    Write-Host "run: $(Join-Path $Dir 'qwen-code\bin\qwen.cmd')"
}
finally {
    if ($stage) {
        $previous = Join-Path $stage 'previous'
        if ((Test-Path -LiteralPath $previous) -and -not (Test-Path -LiteralPath $active)) {
            try { [IO.Directory]::Move($previous, $active) }
            catch { Write-Warning "Could not restore previous preview: $_" }
        }
        if (Test-Path -LiteralPath $previous) {
            Write-Warning "Previous preview preserved at $(Join-Path $stage 'previous')"
        }
        else { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if ($lock) {
        $lock.Dispose()
        Remove-Item -LiteralPath $lockPath -Force
    }
    if ($work) {
        Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    }
}
