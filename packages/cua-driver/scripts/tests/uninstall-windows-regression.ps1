[CmdletBinding()]
param(
    [string]$UninstallerPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'uninstall.ps1')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$body = [IO.File]::ReadAllText($UninstallerPath)
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($body, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
# Close the native identity query as well as every mutator below, so this
# whole-script regression never needs admin or opens an elevation prompt.
$elevation = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-IsElevated'
}, $true))
if ($elevation.Count -ne 1) { throw 'Expected one native elevation query' }
$extent = $elevation[0].Extent
$body = $body.Remove($extent.StartOffset, $extent.EndOffset - $extent.StartOffset).Insert(
    $extent.StartOffset, 'function Test-IsElevated { return $true }')
$FixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('qwen-uninstall-regression-' + [Guid]::NewGuid().ToString('N'))
$environmentNames = @('CUA_DRIVER_RS_INSTALL_DIR','CUA_DRIVER_RS_HOME','CUA_DRIVER_RS_UNINSTALL_FORCE','CUA_DRIVER_RS_UNINSTALL_PURGE','USERPROFILE','LOCALAPPDATA','APPDATA','PATH')
$previousEnvironment = @{}
foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
$cases=@('foreign','owned-direct','owned-wrapper','owned-pwsh-wrapper','owned-quoted-apostrophe-wrapper','prefix-collision','unknown-command','mixed-exec','mixed-action','wrapper-extra-command','query-failure','malformed-xml','owned-skill','default')
$all=[Collections.Generic.List[object]]::new()
foreach($case in $cases){
 & {
 param($case,$body,$FixtureRoot,$all)
 $script:Trace=[Collections.Generic.List[object]]::new();$script:Forbidden=0;$script:Case=$case
 $env:CUA_DRIVER_RS_INSTALL_DIR=Join-Path $FixtureRoot 'synthetic-selected\bin';$env:CUA_DRIVER_RS_HOME=Join-Path $FixtureRoot 'synthetic-selected\home'
 if($case -eq 'owned-quoted-apostrophe-wrapper'){$env:CUA_DRIVER_RS_HOME=Join-Path $FixtureRoot "synthetic-selected\home'quoted"}
 $env:CUA_DRIVER_RS_UNINSTALL_FORCE='1';$env:CUA_DRIVER_RS_UNINSTALL_PURGE='';$env:USERPROFILE=Join-Path $FixtureRoot 'synthetic-default-user';$env:LOCALAPPDATA=Join-Path $env:USERPROFILE 'AppData\Local';$env:APPDATA=Join-Path $env:USERPROFILE 'AppData\Roaming';$env:PATH=''
 if($case -eq 'default'){$env:CUA_DRIVER_RS_HOME='';$env:CUA_DRIVER_RS_INSTALL_DIR=''}
 $script:SelectedHome=if($env:CUA_DRIVER_RS_HOME){$env:CUA_DRIVER_RS_HOME}else{Join-Path $env:USERPROFILE '.cua-driver'}
 $script:Bin=if($env:CUA_DRIVER_RS_INSTALL_DIR){$env:CUA_DRIVER_RS_INSTALL_DIR}else{Join-Path $env:LOCALAPPDATA 'Programs\Qwen\qwen-cua-driver\bin'}
 $script:LegacyBin=Join-Path $env:LOCALAPPDATA 'Programs\Qwen\qwen-cua-driver-rs\bin';$script:LegacyHome=Join-Path $env:USERPROFILE '.cua-driver-rs';$script:Skill=Join-Path $env:USERPROFILE '.claude\skills\cua-driver'
 $script:OwnExe=Join-Path $script:SelectedHome 'packages\releases\test-version\qwen-cua-driver.exe';$foreign='C:\Program Files\Cua\shared\qwen-cua-driver.exe'
 function x([string]$s){[Security.SecurityElement]::Escape($s)}
 $command=$foreign;$arguments='serve';$extra=''
 switch($case){
  'owned-direct'{$command=$script:OwnExe}
  {$_ -in @('owned-wrapper','owned-pwsh-wrapper','owned-quoted-apostrophe-wrapper','wrapper-extra-command')} {$command='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';if($case -eq 'owned-pwsh-wrapper'){$command='C:\Program Files\PowerShell\7\pwsh.exe'};$arguments='-NoProfile -WindowStyle Hidden -NonInteractive -Command "Start-Process -FilePath '''+$script:OwnExe.Replace("'","''")+''' -ArgumentList ''serve'' -WindowStyle Hidden -WorkingDirectory '''+$script:Bin+'''"';if($case -eq 'wrapper-extra-command'){$arguments+='; exit 0'}}
  'prefix-collision'{$command=$script:SelectedHome+'\packages-foreign\qwen-cua-driver.exe'}
  'unknown-command'{$command=''}
  'mixed-exec'{$command=$script:OwnExe;$extra='<Exec><Command>'+ (x $foreign)+'</Command><Arguments>serve</Arguments></Exec>'}
  'mixed-action'{$command=$script:OwnExe;$extra='<ComHandler><ClassId>{00000000-0000-0000-0000-000000000001}</ClassId><Data>unrelated-handler</Data></ComHandler>'}
 }
 $script:TaskXML='<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Actions Context="Author"><Exec><Command>'+(x $command)+'</Command><Arguments>'+(x $arguments)+'</Arguments></Exec>'+$extra+'</Actions></Task>'
 function schtasks.exe {$script:Trace.Add(@{call='schtasks';args=@($args)});$global:LASTEXITCODE=0;if($args -contains '/Query'){if($args -contains '/XML'){if($script:Case -eq 'query-failure'){$global:LASTEXITCODE=1;return};if($script:Case -eq 'malformed-xml'){'<bad';return};$script:TaskXML}else{'synthetic existing task'}}}
 function Get-Process {param([string[]]$Name,[string]$ErrorAction) $script:Trace.Add(@{call='Get-Process';name=$Name});@([pscustomobject]@{Id=701;Path='C:\Program Files\Cua\shared\qwen-cua-driver.exe'},[pscustomobject]@{Id=702;Path=$script:OwnExe},[pscustomobject]@{Id=703;Path=(Join-Path $script:Bin 'qwen-cua-driver-uia.exe')},[pscustomobject]@{Id=704;Path=($script:SelectedHome+'\packages-foreign\qwen-cua-driver.exe')},[pscustomobject]@{Id=705;Path=$null})}
 function Stop-Process {param([int]$Id,[switch]$Force,[string]$ErrorAction)$script:Trace.Add(@{call='Stop-Process';id=$Id})}
 function Remove-Item {param([string]$LiteralPath,[switch]$Force,[switch]$Recurse,[string]$ErrorAction)$script:Trace.Add(@{call='Remove-Item';path=$LiteralPath})}
 function Test-Path {param([string]$LiteralPath) return ($LiteralPath.StartsWith($script:SelectedHome,[StringComparison]::OrdinalIgnoreCase) -or $LiteralPath -eq $script:Bin -or $LiteralPath -eq $script:LegacyBin -or $LiteralPath -eq (Split-Path $script:LegacyBin) -or $LiteralPath -eq (Split-Path (Split-Path $script:LegacyBin)) -or $LiteralPath.StartsWith($script:LegacyHome,[StringComparison]::OrdinalIgnoreCase) -or $LiteralPath -eq $script:Skill)}
 function Get-Item {param([string]$LiteralPath,[switch]$Force,[string]$ErrorAction)$target=Join-Path $script:LegacyHome 'skills\computer-use';if($script:Case -eq 'owned-skill'){$target=Join-Path $script:SelectedHome 'skills\computer-use'};[pscustomobject]@{Attributes=[IO.FileAttributes]::ReparsePoint;Target=@($target)}}
 function Get-ChildItem {param([string]$LiteralPath,[switch]$Force,[string]$ErrorAction)@()}
 function Start-Sleep {param([int]$Milliseconds)}
 function Start-Process {$script:Forbidden++;throw 'forbidden external launch'}
 function Set-Content {$script:Forbidden++;throw 'forbidden content write'}
 function New-Item {$script:Forbidden++;throw 'forbidden item creation'}
 function Move-Item {$script:Forbidden++;throw 'forbidden move'}
 function Copy-Item {$script:Forbidden++;throw 'forbidden copy'}
 function Invoke-WebRequest {$script:Forbidden++;throw 'forbidden network'}
 function Invoke-RestMethod {$script:Forbidden++;throw 'forbidden network'}
 function Read-Host {$script:Forbidden++;throw 'forbidden prompt'}
 . ([scriptblock]::Create($body)) *> $null
 $stopped=@($script:Trace|Where-Object{$_.call -eq 'Stop-Process'}|ForEach-Object{$_.id})
 $deleted=@($script:Trace|Where-Object{$_.call -eq 'schtasks' -and $_.args -contains '/Delete'}).Count -gt 0
 $legacy=@($script:Trace|Where-Object{$_.call -eq 'Remove-Item' -and ($_.path.StartsWith($script:LegacyHome) -or $_.path -eq $script:LegacyBin)}).Count -gt 0
 $skill=@($script:Trace|Where-Object{$_.call -eq 'Remove-Item' -and $_.path -eq $script:Skill}).Count -gt 0
 $expectedTask=$case -in @('owned-direct','owned-wrapper','owned-pwsh-wrapper','owned-quoted-apostrophe-wrapper','default')
 $expectedStops=if($case -eq 'default'){@(701,702,703,704,705)}else{@(702,703)}
 $result=@{case=$case;trace=@($script:Trace.ToArray());taskXML=$script:TaskXML;taskDelete=$deleted;stopped=$stopped;legacyCleanup=$legacy;skillCleanup=$skill;forbidden=$script:Forbidden;pass=($deleted -eq $expectedTask -and ($stopped -join ',') -eq ($expectedStops -join ',') -and $legacy -eq ($case -eq 'default') -and $skill -eq ($case -in @('owned-skill','default')) -and $script:Forbidden -eq 0)}
 $all.Add($result)
 } $case $body $FixtureRoot $all
}
    $failed = @($all | Where-Object { -not $_.pass })
    if ($failed.Count) { throw ('Uninstall isolation regression: ' + ($failed | ConvertTo-Json -Depth 10)) }
    Write-Host ("Windows whole-script uninstall isolation: {0} cases passed." -f $all.Count)
} finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
}
