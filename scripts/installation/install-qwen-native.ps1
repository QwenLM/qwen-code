# Qwen native bootstrap (Windows PowerShell 5.1+).
# Release template: source copies require placeholder rendering before use.
# Downloads one verified program; the CLI owns placement, PATH and activation.
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$baseUrl = '__BASE_URL__'
$requestedVersion = ''
$installArgs = @()
for ($i = 0; $i -lt $args.Count; $i++) {
    switch ("$($args[$i])") {
        '--version' {
            if ($i + 1 -ge $args.Count) { throw 'Missing version' }
            $i++
            $requestedVersion = "$($args[$i])" -replace '^v', ''
            if (-not $requestedVersion) { throw 'Missing version' }
        }
        '--force' { $installArgs += '--force' }
        '--skip-path' { $installArgs += '--skip-path' }
        '--quiet' { $installArgs += '--quiet' }
        '--help' { Write-Output 'Qwen native installer: [--version <version>] [--force] [--skip-path] [--quiet]'; return }
        '-h' { Write-Output 'Qwen native installer: [--version <version>] [--force] [--skip-path] [--quiet]'; return }
        default { throw "Unknown option: $($args[$i])" }
    }
}

function Assert-QwenVersion([string]$version) {
    $number = '(0|[1-9][0-9]*)'
    $identifier = '[0-9A-Za-z-]+'
    $suffix = "$identifier(?:\.$identifier)*"
    $pattern = "\A$number\.$number\.$number(?:-$suffix)?(?:\+$suffix)?\z"
    if ($version.Length -gt 256 -or $version -cnotmatch $pattern) {
        throw 'Invalid Qwen version'
    }
}

function Read-QwenManifest([string]$url, [string]$manifestPath) {
    # OSS serves manifests as application/octet-stream. Use cmdlets to decode
    # UTF-8 so this also works in ConstrainedLanguage.
    Invoke-WebRequest -Uri $url -OutFile $manifestPath -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 60
    return (Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json)
}

if ($env:OS -ne 'Windows_NT') { throw 'This installer requires Windows.' }
if (-not [Environment]::Is64BitOperatingSystem) { throw '32-bit Windows is not supported.' }
$build = [Environment]::OSVersion.Version.Build
if ($build -lt __WINDOWS_BUN_MIN_BUILD__) {
    throw 'This Qwen build requires Windows build __WINDOWS_BUN_MIN_BUILD__ or newer.'
}
# ConstrainedLanguage can reject this setting. In that case use the host's TLS defaults.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$arch = 'x64'
$probes = @($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE)
try { $probes += "$([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)" } catch {}
if ($probes | Where-Object { "$_" -match '^(arm64|aarch64)$' }) { $arch = 'arm64' }
$tempRoot = $env:TEMP
if (-not $tempRoot) { $tempRoot = $env:TMP }
$tempDir = Join-Path $tempRoot "qwen-install-$(New-Guid)"
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
    $manifestPath = Join-Path $tempDir 'manifest.json'
    if ($requestedVersion) {
        Assert-QwenVersion $requestedVersion
        $version = $requestedVersion
    } else {
        $manifest = Read-QwenManifest "$baseUrl/channels/manifest.json" $manifestPath
        $version = [string]$manifest.latest
        Assert-QwenVersion $version
    }
    # Pin metadata after selecting a version so a moving channel cannot mix releases.
    $manifest = Read-QwenManifest "$baseUrl/channels/$version/manifest.json" $manifestPath
    if ($manifest.latest -cne $version) { throw 'Version manifest mismatch' }
    $file = @($manifest.files | Where-Object { $_.os -ceq 'windows' -and $_.arch -ceq $arch }) | Select-Object -First 1
    if (-not $file) { throw "Release $version has no binary for windows/$arch" }
    if ($file.runtime -cne 'bun' -or $file.sha256 -cnotmatch '\A[a-fA-F0-9]{64}\z') { throw 'Invalid Qwen binary metadata' }
    $uri = [Uri]$file.url
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -cne 'https' -or $uri.UserInfo) { throw 'HTTPS artifact URL required' }
    if ($file.min_windows_build -and $build -lt [int]$file.min_windows_build) { throw 'This Qwen artifact does not support this Windows build.' }

    $archive = Join-Path $tempDir 'qwen.zip'
    Invoke-WebRequest -Uri $uri.AbsoluteUri -OutFile $archive -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 300
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $file.sha256) { throw 'Qwen archive SHA-256 mismatch' }
    try {
        Expand-Archive -LiteralPath $archive -DestinationPath $tempDir
    } catch {
        # The Archive module can itself be restricted by application control.
        if ($_.FullyQualifiedErrorId -notlike '*ConstrainedLanguage*') { throw }
        $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
        if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) {
            $tar = Join-Path $env:SystemRoot 'Sysnative\tar.exe'
            if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { throw }
        }
        & $tar -xf $archive -C $tempDir qwen.exe
        if ($LASTEXITCODE -ne 0) { throw "Qwen archive extraction failed (exit $LASTEXITCODE)" }
    }
    $binary = Join-Path $tempDir 'qwen.exe'
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Missing qwen.exe in archive' }
    & $binary install --version $version @installArgs
    if ($LASTEXITCODE -ne 0) { throw "Qwen install failed (exit $LASTEXITCODE)" }
} finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
