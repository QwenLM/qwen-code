[CmdletBinding()]
param(
    [string]$InstallerPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "install.ps1"),
    [switch]$UnitOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Legacy detection/cleanup tests must never rewrite the real user's PATH.
class InstallerTestEnvironment {
    static [string] GetEnvironmentVariable([string]$name, [string]$target) { return '' }
    static [void] SetEnvironmentVariable([string]$name, [string]$value, [string]$target) {
        throw 'Persistent environment writes are forbidden in installer unit tests'
    }
}

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) { throw $Message }
}

function Import-InstallerFunction {
    param(
        [Parameter(Mandatory = $true)]$Ast,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $definition = $Ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $Name
    }, $true) | Select-Object -First 1
    if (-not $definition) { throw "function $Name not found in $InstallerPath" }
    $scriptDefinition = $definition.Extent.Text -replace "^function\s+$([regex]::Escape($Name))", "function script:$Name"
    if ($Name -eq 'Remove-LegacyInstall') {
        $scriptDefinition = $scriptDefinition.Replace('[Environment]::', '[InstallerTestEnvironment]::')
    }
    . ([scriptblock]::Create($scriptDefinition))
}

& (Join-Path $PSScriptRoot 'uninstall-windows-regression.ps1') -UninstallerPath (Join-Path (Split-Path -Parent $InstallerPath) 'uninstall.ps1')

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $InstallerPath,
    [ref]$tokens,
    [ref]$parseErrors)
if ($parseErrors.Count -ne 0) {
    throw "install.ps1 parse errors: $($parseErrors -join '; ')"
}

Import-InstallerFunction -Ast $ast -Name "Remove-LegacyInstall"
$modulePath = Join-Path (Split-Path -Parent $InstallerPath) '_install-common.psm1'
$moduleAst = [System.Management.Automation.Language.Parser]::ParseFile(
    $modulePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw "module parse errors: $($parseErrors -join '; ')" }
foreach ($name in @('Get-CuaDriverAncestorProcessIds', 'Get-CuaDriverProcesses', 'Stop-CuaDriverDaemons', 'Stop-CuaDriverDaemonsWithHealth')) {
    Import-InstallerFunction -Ast $moduleAst -Name $name
}

$script:Steps = @()
$script:TaskkillCalls = @()
$script:ScheduledTaskCalls = @()
$script:StoppedProcessIds = @()
$script:Processes = @()
$script:ParentByPid = @{}
$script:CreatedByPid = @{}
$script:QueryThrows = $false

function Write-Step { param($Message); $script:Steps += [string]$Message }
function Start-Sleep { [CmdletBinding()] param([int]$Milliseconds, [int]$Seconds) }
function taskkill.exe { $script:TaskkillCalls += ,@($args); $global:LASTEXITCODE = 0 }
function schtasks.exe { $script:ScheduledTaskCalls += ,@($args); $global:LASTEXITCODE = 0 }
function Test-CuaDriverPipeAlive { return $false }
function Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter)
    if ($script:QueryThrows) { throw 'controlled provider failure' }
    $processId = [int]($Filter -replace '^ProcessId=', '')
    if (-not $script:ParentByPid.ContainsKey($processId)) { return $null }
    [pscustomobject]@{
        ProcessId = $processId
        ParentProcessId = $script:ParentByPid[$processId]
        CreationDate = $script:CreatedByPid[$processId]
    }
}
function Get-Process {
    [CmdletBinding()]
    param([string[]]$Name)
    return @($script:Processes | Where-Object { $Name -contains $_.ProcessName })
}
function Stop-Process {
    [CmdletBinding()]
    param([int]$Id, [switch]$Force)
    $script:StoppedProcessIds += $Id
}

$savedInstallDir = $env:CUA_DRIVER_RS_INSTALL_DIR
$savedHome = $env:CUA_DRIVER_RS_HOME
$env:CUA_DRIVER_RS_INSTALL_DIR = $null
$env:CUA_DRIVER_RS_HOME = $null

try {
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ("cua-driver-installer-regression-" + [guid]::NewGuid().ToString("N"))
    $HomeDir = Join-Path $root "modern-home"
    $LegacyHomeDir = Join-Path $root "profile\.cua-driver-rs"
    $LegacyVendorDir = Join-Path $root "localappdata\Programs\trycua"
    $LegacyVisibleBinDir = Join-Path $LegacyVendorDir "cua-driver-rs\bin"

    # Current releases write cache and telemetry state here. Neither file is a
    # legacy installation marker, and migration must leave both untouched.
    New-Item -ItemType Directory -Force -Path $LegacyHomeDir | Out-Null
    Set-Content -LiteralPath (Join-Path $LegacyHomeDir "version_check.json") -Value "{}"
    Set-Content -LiteralPath (Join-Path $LegacyHomeDir ".telemetry_id") -Value "synthetic-test-id"
    Remove-LegacyInstall
    Assert-True ($script:Steps.Count -eq 0) "cache/telemetry-only home was detected as legacy"
    Assert-True ($script:TaskkillCalls.Count -eq 0) "cache/telemetry-only home triggered process cleanup"
    Assert-True (Test-Path -LiteralPath $LegacyHomeDir) "cache/telemetry-only home was removed"

    # Every supported on-disk legacy marker independently enters migration.
    foreach ($marker in @("packages", "bin", "visible-bin")) {
        $scenarioRoot = Join-Path $root $marker
        $HomeDir = Join-Path $scenarioRoot "modern-home"
        $LegacyHomeDir = Join-Path $scenarioRoot "profile\.cua-driver-rs"
        $LegacyVendorDir = Join-Path $scenarioRoot "localappdata\Programs\trycua"
        $LegacyVisibleBinDir = Join-Path $LegacyVendorDir "cua-driver-rs\bin"
        if ($marker -eq "visible-bin") {
            New-Item -ItemType Directory -Force -Path $LegacyVisibleBinDir | Out-Null
        } else {
            New-Item -ItemType Directory -Force -Path (Join-Path $LegacyHomeDir $marker) | Out-Null
        }
        $script:Steps = @()
        $script:TaskkillCalls = @()
        $script:ScheduledTaskCalls = @()
        $script:Processes = @()
        $script:StoppedProcessIds = @()
        $script:ParentByPid = @{}
        $script:ParentByPid[[int]$PID] = 0
        Remove-LegacyInstall
        Assert-True ($script:Steps -contains "detected legacy Qwen install layout; migrating to Qwen\qwen-cua-driver") `
            "$marker was not detected as a legacy marker"
    }

    # Model update --apply: PowerShell is a child of qwen-cua-driver.exe, which in
    # turn has another ancestor. Both must be excluded from taskkill and the
    # Stop-Process backstop, while an unrelated daemon must still be stopped.
    $HomeDir = Join-Path $root "process-tree\modern-home"
    $LegacyHomeDir = Join-Path $root "process-tree\profile\.cua-driver-rs"
    $LegacyVendorDir = Join-Path $root "process-tree\localappdata\Programs\trycua"
    $LegacyVisibleBinDir = Join-Path $LegacyVendorDir "cua-driver-rs\bin"
    New-Item -ItemType Directory -Force -Path (Join-Path $LegacyHomeDir "packages") | Out-Null
    $script:Steps = @()
    $script:TaskkillCalls = @()
    $script:ScheduledTaskCalls = @()
    $script:StoppedProcessIds = @()
    $script:ParentByPid = @{}
    $script:ParentByPid[[int]$PID] = 4100
    $script:ParentByPid[4100] = 4200
    $script:ParentByPid[4200] = 0
    $script:Processes = @(
        [pscustomobject]@{ Id = 4100; ProcessName = "qwen-cua-driver" },
        [pscustomobject]@{ Id = 4300; ProcessName = "qwen-cua-driver" }
    )

    $ancestors = @(Get-CuaDriverAncestorProcessIds)
    Assert-True (($ancestors -join ',') -eq "$PID,4100,4200") "ancestor discovery did not traverse the complete synthetic chain"
    Remove-LegacyInstall

    Assert-True ($script:TaskkillCalls.Count -eq 1) "expected only the unrelated driver PID to be targeted"
    foreach ($call in $script:TaskkillCalls) {
        $commandLine = $call -join ' '
        Assert-True ($commandLine -eq '/F /T /PID 4300') "cleanup did not target only the unrelated driver PID"
    }
    Assert-True (-not (@($script:ScheduledTaskCalls | Where-Object { $_ -contains '/End' }).Count)) `
        "task-wide termination can kill the updater ancestor"
    Assert-True (-not ($script:StoppedProcessIds -contains 4100)) "Stop-Process targeted the cua-driver launcher"
    Assert-True ($script:StoppedProcessIds -contains 4300) "unrelated cua-driver daemon was not stopped"

    $script:Processes = @([pscustomobject]@{ Id = 4100; ProcessName = 'qwen-cua-driver' })
    $health = Stop-CuaDriverDaemonsWithHealth
    Assert-True (@($health.Survivors).Count -eq 0 -and -not $health.Stale) `
        "the updater ancestor was reported as a stale daemon"

    $script:Processes += [pscustomobject]@{ Id = 4300; ProcessName = 'qwen-cua-driver' }
    $health = Stop-CuaDriverDaemonsWithHealth
    Assert-True (@($health.Survivors).Count -eq 1 -and $health.Survivors.Id -eq 4300 -and $health.Stale) `
        "a surviving unrelated daemon was not reported as stale"

    $script:CreatedByPid[[int]$PID] = [datetime]'2026-01-02'
    $script:CreatedByPid[4100] = [datetime]'2026-01-03'
    Assert-True ((@(Get-CuaDriverAncestorProcessIds) -join ',') -eq "$PID") `
        "a reused parent PID was treated as a live ancestor"
    $script:CreatedByPid[4100] = [datetime]'2026-01-01'
    $script:ParentByPid[4200] = 4100
    Assert-True ((@(Get-CuaDriverAncestorProcessIds) -join ',') -eq "$PID,4100,4200") `
        "a cycle did not terminate ancestor discovery"
    $script:ParentByPid.Remove(4100)
    Assert-True ((@(Get-CuaDriverAncestorProcessIds) -join ',') -eq "$PID") `
        "an exited parent was included as an ancestor"

    foreach ($failure in @('provider', 'current-process-missing')) {
        $script:TaskkillCalls = @()
        $script:ScheduledTaskCalls = @()
        $script:StoppedProcessIds = @()
        $script:QueryThrows = ($failure -eq 'provider')
        if ($failure -eq 'current-process-missing') { $script:ParentByPid.Remove([int]$PID) }
        $refused = $false
        try { $null = Stop-CuaDriverDaemons } catch { $refused = $true }
        Assert-True $refused "$failure did not refuse cleanup"
        Assert-True ($script:TaskkillCalls.Count -eq 0 -and $script:ScheduledTaskCalls.Count -eq 0 -and $script:StoppedProcessIds.Count -eq 0) `
            "$failure attempted termination without known ancestors"
    }

    Write-Host "Windows installer legacy/update regression checks passed."
}
finally {
    $env:CUA_DRIVER_RS_INSTALL_DIR = $savedInstallDir
    $env:CUA_DRIVER_RS_HOME = $savedHome
}

if ($UnitOnly) { return }

$rustWorkspace = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "rust"
Push-Location $rustWorkspace
try {
    & cargo test -p cua-driver --bin qwen-cua-driver 'autostart::tests::' --locked -- --nocapture
    if ($LASTEXITCODE -ne 0) {
        throw "Windows autostart path tests failed with exit $LASTEXITCODE"
    }

    & cargo build -p cua-driver --bin qwen-cua-driver --locked
    if ($LASTEXITCODE -ne 0) {
        throw "Windows autostart task probe build failed with exit $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

# Exercise the installed topology and Task Scheduler end to end. Register the
# task through bin -> current -> probe-v1, retarget current to probe-v2, then
# prove the unchanged action reaches the new executable.
$taskName = "qwen-cua-driver-serve"
$taskProbeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cua-driver-autostart-task-" + [guid]::NewGuid().ToString("N"))
$taskPackages = Join-Path $taskProbeRoot "packages"
$taskReleaseV1 = Join-Path $taskPackages "releases\probe-v1"
$taskReleaseV2 = Join-Path $taskPackages "releases\probe-v2"
$taskCurrent = Join-Path $taskPackages "current"
$taskVisible = Join-Path $taskProbeRoot "bin"
$taskVisibleExe = Join-Path $taskVisible "qwen-cua-driver.exe"
$taskMarker = Join-Path $taskProbeRoot "probe-v2.txt"
$realSchtasks = Join-Path $env:SystemRoot "System32\schtasks.exe"

try {
    New-Item -ItemType Directory -Force -Path $taskReleaseV1, $taskReleaseV2 | Out-Null
    Copy-Item -LiteralPath (Join-Path $rustWorkspace "target\debug\qwen-cua-driver.exe") `
        -Destination (Join-Path $taskReleaseV1 "qwen-cua-driver.exe")

    $markerLiteral = $taskMarker.Replace('\', '\\').Replace('"', '\"')
    $probeSourcePath = Join-Path $taskProbeRoot "probe-v2.rs"
    $probeSource = @"
fn main() {
    std::fs::write("$markerLiteral", "probe-v2").unwrap();
}
"@
    Set-Content -LiteralPath $probeSourcePath -Value $probeSource -Encoding UTF8
    & rustc $probeSourcePath -o (Join-Path $taskReleaseV2 "qwen-cua-driver.exe")
    if ($LASTEXITCODE -ne 0) {
        throw "probe-v2 build failed with exit $LASTEXITCODE"
    }

    New-Item -ItemType Junction -Path $taskCurrent -Target $taskReleaseV1 | Out-Null
    New-Item -ItemType Junction -Path $taskVisible -Target $taskCurrent | Out-Null

    & $taskVisibleExe autostart enable
    if ($LASTEXITCODE -ne 0) {
        throw "autostart task registration failed with exit $LASTEXITCODE"
    }
    $beforeAction = (Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).Actions | Select-Object -First 1
    Assert-True ($beforeAction.Arguments -like "*$taskVisibleExe*") `
        "Scheduled Task action did not retain the visible junction path: $($beforeAction.Arguments)"

    [System.IO.Directory]::Delete($taskCurrent, $false)
    New-Item -ItemType Junction -Path $taskCurrent -Target $taskReleaseV2 | Out-Null
    $afterAction = (Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).Actions | Select-Object -First 1
    Assert-True ($afterAction.Arguments -eq $beforeAction.Arguments) `
        "Scheduled Task action changed when the current junction was retargeted"

    & $realSchtasks /Run /TN $taskName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "retargeted autostart task failed to start with exit $LASTEXITCODE"
    }
    for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath $taskMarker); $attempt++) {
        [System.Threading.Thread]::Sleep(100)
    }
    Assert-True (Test-Path -LiteralPath $taskMarker) "retargeted task did not launch probe-v2"
    Assert-True ((Get-Content -LiteralPath $taskMarker -Raw) -eq "probe-v2") `
        "retargeted task did not report the next probe version"

    Write-Host "Windows Scheduled Task junction-retarget regression check passed."
}
finally {
    & $realSchtasks /End /TN $taskName 2>$null | Out-Null
    & $realSchtasks /Delete /TN $taskName /F 2>$null | Out-Null
}
