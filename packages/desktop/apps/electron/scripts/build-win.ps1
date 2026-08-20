# Build script for Windows NSIS installer
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-win.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Split-Path -Parent $ScriptDir
$RootDir = Split-Path -Parent (Split-Path -Parent $ElectronDir)

# Configuration
$BunVersion = "bun-v1.3.9"  # Pinned version for reproducible builds

Write-Host "=== Building Qwen Code Desktop Windows Installer using electron-builder ===" -ForegroundColor Cyan

# Debug: System information
Write-Host ""
Write-Host "=== Debug: System Information ===" -ForegroundColor Magenta
Write-Host "OS: $([System.Environment]::OSVersion.VersionString)"
Write-Host "PowerShell: $($PSVersionTable.PSVersion)"
Write-Host "Hostname: $env:COMPUTERNAME"
Write-Host "User: $env:USERNAME"
Write-Host "Temp: $env:TEMP"
Write-Host "Working Dir: $(Get-Location)"

# Debug: Check Windows Defender status
Write-Host ""
Write-Host "=== Debug: Windows Defender Status ===" -ForegroundColor Magenta
try {
    $defenderStatus = Get-MpComputerStatus -ErrorAction SilentlyContinue
    if ($defenderStatus) {
        Write-Host "Real-time Protection: $($defenderStatus.RealTimeProtectionEnabled)"
        Write-Host "Antivirus Enabled: $($defenderStatus.AntivirusEnabled)"
        Write-Host "On Access Protection: $($defenderStatus.OnAccessProtectionEnabled)"
        Write-Host "IO AV Protection: $($defenderStatus.IoavProtectionEnabled)"
    } else {
        Write-Host "Could not get Defender status"
    }
} catch {
    Write-Host "Defender status check failed: $_"
}

# Debug: List exclusions
Write-Host ""
Write-Host "=== Debug: Defender Exclusions ===" -ForegroundColor Magenta
try {
    $prefs = Get-MpPreference -ErrorAction SilentlyContinue
    if ($prefs.ExclusionPath) {
        Write-Host "Path Exclusions: $($prefs.ExclusionPath -join ', ')"
    }
    if ($prefs.ExclusionProcess) {
        Write-Host "Process Exclusions: $($prefs.ExclusionProcess -join ', ')"
    }
} catch {
    Write-Host "Could not get exclusions: $_"
}
Write-Host ""

# 0. Kill any lingering processes that might lock files
Write-Host "Killing any lingering node/npm processes..."
$processesToKill = @('node', 'npm', 'electron', 'electron-builder')
foreach ($procName in $processesToKill) {
    Get-Process -Name $procName -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  Killing $($_.ProcessName) (PID: $($_.Id))..." -ForegroundColor Yellow
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
}
# Give processes time to fully terminate
Start-Sleep -Seconds 2

# 1. Clean previous build artifacts (with retry for locked files)
Write-Host "Cleaning previous builds..."
$foldersToClean = @(
    "$ElectronDir\vendor",
    "$ElectronDir\packages",
    "$ElectronDir\release"
)
foreach ($folder in $foldersToClean) {
    if (Test-Path $folder) {
        $retries = 3
        for ($i = 1; $i -le $retries; $i++) {
            try {
                Remove-Item -Recurse -Force $folder -ErrorAction Stop
                break
            } catch {
                if ($i -eq $retries) { throw }
                Write-Host "  Retrying cleanup of $folder (attempt $i)..." -ForegroundColor Yellow
                Start-Sleep -Seconds 2
            }
        }
    }
}

# 2. Install dependencies
Write-Host "Installing dependencies..."
Push-Location $RootDir
try {
    bun install
} finally {
    Pop-Location
}

# 3. Download Bun binary for Windows
# Use baseline build - works on all x64 CPUs (no AVX2 requirement)
Write-Host "Downloading Bun $BunVersion for Windows x64 (baseline)..."
New-Item -ItemType Directory -Force -Path "$ElectronDir\vendor\bun" | Out-Null

$BunDownload = "bun-windows-x64-baseline"
$TempDir = Join-Path $env:TEMP "bun-download-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

try {
    # Download binary and checksums
    $ZipUrl = "https://github.com/oven-sh/bun/releases/download/$BunVersion/$BunDownload.zip"
    $ChecksumUrl = "https://github.com/oven-sh/bun/releases/download/$BunVersion/SHASUMS256.txt"

    Write-Host "Downloading from $ZipUrl..."
    Invoke-WebRequest -Uri $ZipUrl -OutFile "$TempDir\$BunDownload.zip"
    Invoke-WebRequest -Uri $ChecksumUrl -OutFile "$TempDir\SHASUMS256.txt"

    # Verify checksum
    Write-Host "Verifying checksum..."
    $ExpectedHash = (Get-Content "$TempDir\SHASUMS256.txt" | Select-String "$BunDownload.zip").ToString().Split(" ")[0]
    $ActualHash = (Get-FileHash "$TempDir\$BunDownload.zip" -Algorithm SHA256).Hash.ToLower()

    if ($ActualHash -ne $ExpectedHash) {
        throw "Checksum verification failed! Expected: $ExpectedHash, Got: $ActualHash"
    }
    Write-Host "Checksum verified successfully" -ForegroundColor Green

    # Extract and install using robocopy for better file handle management
    Write-Host "Extracting Bun..."
    Expand-Archive -Path "$TempDir\$BunDownload.zip" -DestinationPath $TempDir -Force

    # Unblock in temp first (before copy)
    Unblock-File -Path "$TempDir\$BunDownload\bun.exe" -ErrorAction SilentlyContinue

    # Use robocopy with retries - handles transient file locks better than Copy-Item
    # /R:5 = 5 retries, /W:3 = 3 second wait between retries, /NP = no progress, /NFL /NDL = quiet
    Write-Host "Copying bun.exe with robocopy..."
    $robocopyResult = robocopy "$TempDir\$BunDownload" "$ElectronDir\vendor\bun" "bun.exe" /R:5 /W:3 /NP /NFL /NDL
    # Robocopy exit codes: 0-7 are success, 8+ are errors
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy failed with exit code $LASTEXITCODE"
    }

    $BunExePath = "$ElectronDir\vendor\bun\bun.exe"
    Write-Host "Bun extracted to: $BunExePath" -ForegroundColor Green

    # Give Windows time to release any file handles from the copy
    Write-Host "Waiting for file handles to release..."
    Start-Sleep -Seconds 3
} finally {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}

# 4. Vendor Qwen Code CLI package
Write-Host "Vendoring Qwen Code CLI..."
Push-Location $RootDir
try {
    bun run scripts/vendor-qwen-code.ts
} finally {
    Pop-Location
}

# 5. Build Electron app
Write-Host "Building Electron app..."

# Build main process with OAuth credentials
Write-Host "  Building main process..."
$MainArgs = @(
    "apps/electron/src/main/index.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--outfile=apps/electron/dist/main.cjs",
    "--external:electron"
)
# Add OAuth defines if env vars are set
if ($env:GOOGLE_OAUTH_CLIENT_ID) {
    $MainArgs += "--define:process.env.GOOGLE_OAUTH_CLIENT_ID=`"'$env:GOOGLE_OAUTH_CLIENT_ID'`""
}
if ($env:GOOGLE_OAUTH_CLIENT_SECRET) {
    $MainArgs += "--define:process.env.GOOGLE_OAUTH_CLIENT_SECRET=`"'$env:GOOGLE_OAUTH_CLIENT_SECRET'`""
}
if ($env:SLACK_OAUTH_CLIENT_ID) {
    $MainArgs += "--define:process.env.SLACK_OAUTH_CLIENT_ID=`"'$env:SLACK_OAUTH_CLIENT_ID'`""
}
if ($env:SLACK_OAUTH_CLIENT_SECRET) {
    $MainArgs += "--define:process.env.SLACK_OAUTH_CLIENT_SECRET=`"'$env:SLACK_OAUTH_CLIENT_SECRET'`""
}
if ($env:MICROSOFT_OAUTH_CLIENT_ID) {
    $MainArgs += "--define:process.env.MICROSOFT_OAUTH_CLIENT_ID=`"'$env:MICROSOFT_OAUTH_CLIENT_ID'`""
}
Push-Location $RootDir
try {
    & npx esbuild @MainArgs
    if ($LASTEXITCODE -ne 0) { throw "Main process build failed" }
} finally {
    Pop-Location
}

# Build preload
Write-Host "  Building preload..."
Push-Location $RootDir
try {
    bun run electron:build:preload
    if ($LASTEXITCODE -ne 0) { throw "Preload build failed" }
} finally {
    Pop-Location
}

# Build renderer (frontend)
Write-Host "  Building renderer (frontend)..."
Push-Location $RootDir
try {
    # Clean previous renderer build
    $RendererDir = "$ElectronDir\dist\renderer"
    if (Test-Path $RendererDir) { Remove-Item -Recurse -Force $RendererDir }

    # Run vite build
    npx vite build --config apps/electron/vite.config.ts
    if ($LASTEXITCODE -ne 0) { throw "Renderer build failed" }

    # Verify renderer was built
    if (-not (Test-Path "$RendererDir\index.html")) {
        throw "Renderer build verification failed: index.html not found"
    }
    Write-Host "  Renderer build verified: $RendererDir" -ForegroundColor Green
} finally {
    Pop-Location
}

# Copy all resources and bundled assets using the shared script.
# Single source of truth — matches Mac/Linux build (bun run build:copy).
# Copies: resources (icons, DMG bg), docs, tool-icons, themes, permissions, config-defaults.
Write-Host "  Copying resources and bundled assets..."
Push-Location $ElectronDir
try {
    bun scripts/copy-assets.ts
    if ($LASTEXITCODE -ne 0) { throw "Asset copy failed" }
    Write-Host "  Assets copied" -ForegroundColor Green
} finally {
    Pop-Location
}

# 8. Package with electron-builder
Write-Host "Packaging app with electron-builder..."

# Debug: Show bun.exe file info
Write-Host ""
Write-Host "=== Debug: bun.exe File Info ===" -ForegroundColor Magenta
$BunExe = "$ElectronDir\vendor\bun\bun.exe"
if (Test-Path $BunExe) {
    $fileInfo = Get-Item $BunExe
    Write-Host "Path: $($fileInfo.FullName)"
    Write-Host "Size: $([math]::Round($fileInfo.Length / 1MB, 2)) MB"
    Write-Host "Created: $($fileInfo.CreationTime)"
    Write-Host "Modified: $($fileInfo.LastWriteTime)"
    Write-Host "Attributes: $($fileInfo.Attributes)"

    # Check Zone.Identifier (Mark of the Web)
    $zoneFile = "$BunExe`:Zone.Identifier"
    if (Test-Path $zoneFile -ErrorAction SilentlyContinue) {
        Write-Host "Zone.Identifier: EXISTS (file may be blocked)" -ForegroundColor Yellow
    } else {
        Write-Host "Zone.Identifier: None (file is unblocked)"
    }

    # Check file hash
    $hash = (Get-FileHash $BunExe -Algorithm SHA256).Hash
    Write-Host "SHA256: $hash"
} else {
    Write-Host "ERROR: bun.exe not found at $BunExe" -ForegroundColor Red
}

# Debug: List vendor directory contents
Write-Host ""
Write-Host "=== Debug: vendor/bun Directory ===" -ForegroundColor Magenta
Get-ChildItem "$ElectronDir\vendor\bun" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  $($_.Name) - $($_.Length) bytes"
}

# Debug: Check for processes that might have files open
Write-Host ""
Write-Host "=== Debug: Potentially Relevant Processes ===" -ForegroundColor Magenta
$relevantProcesses = Get-Process | Where-Object {
    $_.ProcessName -match 'node|npm|bun|electron|defender|antimalware|mpcmdrun'
} | Select-Object ProcessName, Id, CPU, WorkingSet64
if ($relevantProcesses) {
    $relevantProcesses | ForEach-Object {
        Write-Host "  $($_.ProcessName) (PID: $($_.Id)) - Memory: $([math]::Round($_.WorkingSet64 / 1MB, 1)) MB"
    }
} else {
    Write-Host "  No relevant processes found"
}
Write-Host ""

# NOTE: bun.exe is now copied via extraResources in electron-builder.yml
# This avoids EBUSY errors from the npm node module collector.
# See electron-builder.yml for details.

# Verify bun.exe is accessible (not locked by another process)
Write-Host "  Verifying $BunExe is accessible..."
$retryCount = 0
$maxRetries = 6
while ($retryCount -lt $maxRetries) {
    try {
        # Try to open the file exclusively to verify no other process has it locked
        $stream = [System.IO.File]::Open($BunExe, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
        $stream.Close()
        $stream.Dispose()
        Write-Host "  File is accessible" -ForegroundColor Green
        break
    } catch {
        $retryCount++
        if ($retryCount -ge $maxRetries) {
            Write-Host "  WARNING: File may be locked after $maxRetries attempts, proceeding anyway..." -ForegroundColor Yellow
        } else {
            Write-Host "  File locked, waiting 5 seconds (attempt $retryCount/$maxRetries)..." -ForegroundColor Yellow
            Start-Sleep -Seconds 5
        }
    }
}

# Force garbage collection to release any managed file handles
[System.GC]::Collect()
[System.GC]::WaitForPendingFinalizers()

# Run electron-builder with retry logic for EBUSY errors
Push-Location $ElectronDir
$maxBuilderRetries = 3
$builderRetry = 0
$builderSuccess = $false

while (-not $builderSuccess -and $builderRetry -lt $maxBuilderRetries) {
    $builderRetry++
    Write-Host "  electron-builder attempt $builderRetry of $maxBuilderRetries..." -ForegroundColor Cyan

    # Clean release directory before each attempt to avoid stale files
    if (Test-Path "$ElectronDir\release") {
        Write-Host "  Cleaning release directory before attempt..."
        Remove-Item -Recurse -Force "$ElectronDir\release" -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    npx electron-builder --win --x64 2>&1 | Tee-Object -Variable builderOutput

    if ($LASTEXITCODE -eq 0) {
        $builderSuccess = $true
        Write-Host "  electron-builder succeeded on attempt $builderRetry" -ForegroundColor Green
    } else {
        Write-Host "  electron-builder failed with exit code $LASTEXITCODE" -ForegroundColor Yellow

        if ($builderRetry -lt $maxBuilderRetries) {
            Write-Host "  Waiting 10 seconds before retry..." -ForegroundColor Yellow

            # Kill any processes that might be holding file locks
            Get-Process -Name 'node', 'npm' -ErrorAction SilentlyContinue | ForEach-Object {
                Write-Host "    Killing $($_.ProcessName) (PID: $($_.Id))..." -ForegroundColor Yellow
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            }

            Start-Sleep -Seconds 10
        }
    }
}

Pop-Location

if (-not $builderSuccess) {
    throw "electron-builder failed after $maxBuilderRetries attempts"
}

# 9. Verify the installer was built
$InstallerPath = Get-ChildItem -Path "$ElectronDir\release" -Filter "*.exe" | Select-Object -First 1

if (-not $InstallerPath) {
    Write-Host "ERROR: Installer not found in $ElectronDir\release" -ForegroundColor Red
    Write-Host "Contents of release directory:"
    Get-ChildItem "$ElectronDir\release"
    exit 1
}

Write-Host ""
Write-Host "=== Build Complete ===" -ForegroundColor Green
Write-Host "Installer: $($InstallerPath.FullName)"
Write-Host "Size: $([math]::Round($InstallerPath.Length / 1MB, 2)) MB"
