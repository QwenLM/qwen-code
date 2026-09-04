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
    Remove-Item -Recurse -Force (Join-Path $Dir 'qwen-code') -ErrorAction SilentlyContinue
    Expand-Archive -LiteralPath $archivePath -DestinationPath $Dir -Force

    Write-Host "installed: $(Join-Path $Dir 'qwen-code')"
    Write-Host "run: $(Join-Path $Dir 'qwen-code\bin\qwen.cmd')"
}
finally {
    if ($work) {
        Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    }
}
