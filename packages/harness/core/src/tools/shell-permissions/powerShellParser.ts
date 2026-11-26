/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';

import { getPowerShellRuntime } from '../../utils/shell/powerShell.js';
import { BRAND_FIXED_ENV_PREFIX } from '../../config/brand.js';

export const ENV_PWSH_PARSE_TIMEOUT_MS = `${BRAND_FIXED_ENV_PREFIX}PWSH_PARSE_TIMEOUT_MS`;
export const MAX_POWERSHELL_PARSE_BYTES = 4500;
const DEFAULT_PARSE_TIMEOUT_MS = 5000;
const MAX_CACHE_ENTRIES = 256;

export type PowerShellElementType =
  | 'ArrayLiteral'
  | 'ScriptBlock'
  | 'SubExpression'
  | 'ExpandableString'
  | 'MemberInvocation'
  | 'Variable'
  | 'StringConstant'
  | 'Parameter'
  | 'Other';

export type PowerShellCommandNameType = 'Cmdlet' | 'Application' | 'Unknown';

export type PowerShellCommandElement = {
  text: string;
  elementType: PowerShellElementType;
  children: PowerShellCommandElement[];
  staticValue?: string;
  parameterName?: string;
  splatted?: boolean;
};

export type PowerShellRedirection = {
  text: string;
  kind: 'file' | 'merge';
  target: PowerShellCommandElement | null;
  append: boolean;
  fromStream: string;
  toStream?: string;
};

export type ParsedPowerShellCommand = {
  name: string | null;
  canonicalName: string | null;
  nameType: PowerShellCommandNameType;
  elementType: PowerShellElementType;
  args: string[];
  text: string;
  elements: PowerShellCommandElement[];
  redirections: string[];
  redirectionDetails?: PowerShellRedirection[];
};

export type ParsedPowerShellStatement = {
  statementType: string;
  blockType?: string;
  nestedCommands?: ParsedPowerShellCommand[];
  securityPatterns?: string[];
  text: string;
  commands: ParsedPowerShellCommand[];
  redirections: string[];
  redirectionDetails?: PowerShellRedirection[];
};

export type ParsedPowerShell = {
  valid: boolean;
  errors: string[];
  structuredErrors?: Array<{ message: string; errorId: string }>;
  splattedVariables?: string[];
  statements: ParsedPowerShellStatement[];
  variables: string[];
  typeLiterals: string[];
  hasStopParsing: boolean;
  hasUsingStatements: boolean;
  hasScriptRequirements: boolean;
  hasBackgroundJob: boolean;
  originalCommand: string;
};

type RunnerResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

type PowerShellParserRunner = (
  executable: string,
  args: string[],
  timeoutMs: number,
) => Promise<RunnerResult>;

const POWERSHELL_AST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__COMMAND_BASE64__'))
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)

function Get-ElementType($node) {
  if ($node -is [System.Management.Automation.Language.ArrayLiteralAst]) { return 'ArrayLiteral' }
  if ($node -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) { return 'ScriptBlock' }
  if ($node -is [System.Management.Automation.Language.SubExpressionAst]) { return 'SubExpression' }
  if (($node -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) -or ($node -is [System.Management.Automation.Language.MemberExpressionAst])) { return 'MemberInvocation' }
  if ($node -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) { return 'ExpandableString' }
  if ($node -is [System.Management.Automation.Language.VariableExpressionAst]) { return 'Variable' }
  if ($node -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return 'StringConstant' }
  if ($node -is [System.Management.Automation.Language.CommandParameterAst]) { return 'Parameter' }
  return 'Other'
}

function Convert-Element($node) {
  $children = @($node.FindAll({ param($child) $child.Parent -eq $node }, $true) | ForEach-Object { Convert-Element $_ })
  $value = $null
  if (($node -is [System.Management.Automation.Language.VariableExpressionAst]) -and (@('true', 'false', 'null') -contains $node.VariablePath.UserPath.ToLowerInvariant())) { $value = if ($node.VariablePath.UserPath -eq 'null') { '' } else { $node.VariablePath.UserPath.ToLowerInvariant() } }
  if ($node -is [System.Management.Automation.Language.ConstantExpressionAst]) { $value = [string]$node.Value }
  if (($node -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) -and ($node.NestedExpressions.Count -eq 0)) { $value = $node.Value }
  return [ordered]@{
    text = $node.Extent.Text
    elementType = Get-ElementType $node
    children = $children
    staticValue = $value
    parameterName = if ($node -is [System.Management.Automation.Language.CommandParameterAst]) { $node.ParameterName } else { $null }
    splatted = ($node -is [System.Management.Automation.Language.VariableExpressionAst]) -and $node.Splatted
  }
}

function Convert-Redirection($node) {
  $isFile = $node -is [System.Management.Automation.Language.FileRedirectionAst]
  return [ordered]@{
    text = $node.Extent.Text
    kind = if ($isFile) { 'file' } else { 'merge' }
    target = if ($isFile) { Convert-Element $node.Location } else { $null }
    append = $isFile -and $node.Append
    fromStream = [string]$node.FromStream
    toStream = if ($isFile) { $null } else { [string]$node.ToStream }
  }
}

function Get-NameType($name, $element) {
  if ([string]::IsNullOrEmpty($name)) { return 'Unknown' }
  if (($name -match '[\\/]') -or ($name -match '\.(exe|com|bat|cmd|ps1)$')) { return 'Application' }
  if ((Get-ElementType $element) -ne 'StringConstant') { return 'Unknown' }
  return 'Cmdlet'
}

function Convert-Command($commandAst) {
  $elements = @($commandAst.CommandElements)
  $name = $commandAst.GetCommandName()
  $args = @()
  if ($elements.Count -gt 1) {
    $args = @($elements[1..($elements.Count - 1)] | ForEach-Object { $_.Extent.Text })
  }
  return [ordered]@{
    name = $name
    nameType = Get-NameType $name $elements[0]
    elementType = if ($elements.Count -gt 0) { Get-ElementType $elements[0] } else { 'Unknown' }
    args = $args
    text = $commandAst.Extent.Text
    elements = @($elements | ForEach-Object { Convert-Element $_ })
    redirections = @($commandAst.Redirections | ForEach-Object { $_.Extent.Text })
    redirectionDetails = @($commandAst.Redirections | ForEach-Object { Convert-Redirection $_ })
  }
}

$statements = @('ParamBlock', 'DynamicParamBlock', 'BeginBlock', 'ProcessBlock', 'EndBlock', 'CleanBlock' | ForEach-Object {
  $blockName = $_
  $block = $ast.$blockName
  if ($null -ne $block) {
    $blockStatements = if ($blockName -eq 'ParamBlock') { @($block) } else { @($block.Statements) + @($block.Traps) }
    $blockStatements | Where-Object { $null -ne $_ } | ForEach-Object {
      $statement = $_
      $direct = @()
      if ($statement -is [System.Management.Automation.Language.PipelineAst]) {
        $direct = @($statement.PipelineElements | Where-Object { $_ -is [System.Management.Automation.Language.CommandAst] })
      }
      $all = @($statement.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true))
      $redirections = @($statement.FindAll({ param($node) $node -is [System.Management.Automation.Language.RedirectionAst] }, $true))
      $patterns = @()
      if ($statement -isnot [System.Management.Automation.Language.PipelineAst]) { $patterns += $statement.GetType().Name }
      elseif ($direct.Count -ne $statement.PipelineElements.Count) { $patterns += 'CommandExpression' }
      [ordered]@{
        statementType = $statement.GetType().Name
        blockType = $blockName
        text = $statement.Extent.Text
        commands = @($direct | ForEach-Object { Convert-Command $_ })
        nestedCommands = @($all | Where-Object { $direct -notcontains $_ } | ForEach-Object { Convert-Command $_ })
        securityPatterns = $patterns
        redirections = @($redirections | ForEach-Object { $_.Extent.Text })
        redirectionDetails = @($redirections | ForEach-Object { Convert-Redirection $_ })
      }
    }
  }
})

$variables = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.VariableExpressionAst] }, $true) | ForEach-Object { $_.VariablePath.UserPath } | Sort-Object -Unique)
$typeLiterals = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.TypeExpressionAst] }, $true) | ForEach-Object { $_.Extent.Text } | Sort-Object -Unique)
$usingStatements = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.UsingStatementAst] }, $true))
$backgroundJobs = @($ast.FindAll({ param($node) ($node -is [System.Management.Automation.Language.PipelineAst]) -and $node.Background }, $true))
$stopParsing = @($tokens | Where-Object { $_.Kind.ToString() -eq 'Generic' -and $_.Text -eq '--%' })
$requirements = $ast.ScriptRequirements

[ordered]@{
  valid = ($parseErrors.Count -eq 0)
  errors = @($parseErrors | ForEach-Object { $_.Message })
  structuredErrors = @($parseErrors | ForEach-Object { [ordered]@{ message = $_.Message; errorId = $_.ErrorId } })
  splattedVariables = @($ast.FindAll({ param($node) ($node -is [System.Management.Automation.Language.VariableExpressionAst]) -and $node.Splatted }, $true) | ForEach-Object { $_.VariablePath.UserPath })
  statements = $statements
  variables = $variables
  typeLiterals = $typeLiterals
  hasStopParsing = ($stopParsing.Count -gt 0)
  hasUsingStatements = ($usingStatements.Count -gt 0)
  hasScriptRequirements = ($null -ne $requirements)
  hasBackgroundJob = ($backgroundJobs.Count -gt 0)
} | ConvertTo-Json -Depth 20 -Compress
`;

const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  ac: 'Add-Content',
  cat: 'Get-Content',
  cd: 'Set-Location',
  chdir: 'Set-Location',
  clc: 'Clear-Content',
  clear: 'Clear-Host',
  clhy: 'Clear-History',
  cli: 'Clear-Item',
  clp: 'Clear-ItemProperty',
  cls: 'Clear-Host',
  clv: 'Clear-Variable',
  cnsn: 'Connect-PSSession',
  compare: 'Compare-Object',
  copy: 'Copy-Item',
  cp: 'Copy-Item',
  cpi: 'Copy-Item',
  cpp: 'Copy-ItemProperty',
  cvpa: 'Convert-Path',
  dbp: 'Disable-PSBreakpoint',
  del: 'Remove-Item',
  diff: 'Compare-Object',
  dir: 'Get-ChildItem',
  dnsn: 'Disconnect-PSSession',
  ebp: 'Enable-PSBreakpoint',
  echo: 'Write-Output',
  epal: 'Export-Alias',
  epcsv: 'Export-Csv',
  epsn: 'Export-PSSession',
  erase: 'Remove-Item',
  etsn: 'Enter-PSSession',
  exsn: 'Exit-PSSession',
  fc: 'Format-Custom',
  fhx: 'Format-Hex',
  fl: 'Format-List',
  foreach: 'ForEach-Object',
  ft: 'Format-Table',
  fw: 'Format-Wide',
  gal: 'Get-Alias',
  gbp: 'Get-PSBreakpoint',
  gc: 'Get-Content',
  gci: 'Get-ChildItem',
  gcm: 'Get-Command',
  gcs: 'Get-PSCallStack',
  gdr: 'Get-PSDrive',
  ghy: 'Get-History',
  gi: 'Get-Item',
  gjb: 'Get-Job',
  gl: 'Get-Location',
  gm: 'Get-Member',
  gmo: 'Get-Module',
  gp: 'Get-ItemProperty',
  gps: 'Get-Process',
  gpv: 'Get-ItemPropertyValue',
  group: 'Group-Object',
  gsn: 'Get-PSSession',
  gsnp: 'Get-PSSnapin',
  gsv: 'Get-Service',
  gu: 'Get-Unique',
  gv: 'Get-Variable',
  history: 'Get-History',
  icm: 'Invoke-Command',
  icim: 'Invoke-CimMethod',
  iwmi: 'Invoke-WmiMethod',
  iex: 'Invoke-Expression',
  ihy: 'Invoke-History',
  ii: 'Invoke-Item',
  ipal: 'Import-Alias',
  ipcsv: 'Import-Csv',
  ipmo: 'Import-Module',
  ipsn: 'Import-PSSession',
  irm: 'Invoke-RestMethod',
  iwr: 'Invoke-WebRequest',
  kill: 'Stop-Process',
  lp: 'Out-Printer',
  ls: 'Get-ChildItem',
  man: 'Help',
  md: 'mkdir',
  measure: 'Measure-Object',
  mi: 'Move-Item',
  mount: 'New-PSDrive',
  move: 'Move-Item',
  mp: 'Move-ItemProperty',
  mv: 'Move-Item',
  nal: 'New-Alias',
  ndr: 'New-PSDrive',
  ni: 'New-Item',
  nmo: 'New-Module',
  npssc: 'New-PSSessionConfigurationFile',
  nsn: 'New-PSSession',
  nv: 'New-Variable',
  ogv: 'Out-GridView',
  oh: 'Out-Host',
  popd: 'Pop-Location',
  ps: 'Get-Process',
  pushd: 'Push-Location',
  pwd: 'Get-Location',
  r: 'Invoke-History',
  rbp: 'Remove-PSBreakpoint',
  rcjb: 'Receive-Job',
  rcsn: 'Receive-PSSession',
  rd: 'Remove-Item',
  rdr: 'Remove-PSDrive',
  ren: 'Rename-Item',
  ri: 'Remove-Item',
  rjb: 'Remove-Job',
  rm: 'Remove-Item',
  rmdir: 'Remove-Item',
  rmo: 'Remove-Module',
  rni: 'Rename-Item',
  rnp: 'Rename-ItemProperty',
  rp: 'Remove-ItemProperty',
  rsn: 'Remove-PSSession',
  rv: 'Remove-Variable',
  rvpa: 'Resolve-Path',
  sajb: 'Start-Job',
  sal: 'Set-Alias',
  saps: 'Start-Process',
  sasv: 'Start-Service',
  sbp: 'Set-PSBreakpoint',
  sc: 'Set-Content',
  select: 'Select-Object',
  set: 'Set-Variable',
  shcm: 'Show-Command',
  si: 'Set-Item',
  sl: 'Set-Location',
  sleep: 'Start-Sleep',
  sls: 'Select-String',
  sort: 'Sort-Object',
  sp: 'Set-ItemProperty',
  spjb: 'Stop-Job',
  spps: 'Stop-Process',
  spsv: 'Stop-Service',
  start: 'Start-Process',
  stz: 'Set-TimeZone',
  sv: 'Set-Variable',
  tee: 'Tee-Object',
  type: 'Get-Content',
  where: 'Where-Object',
  wjb: 'Wait-Job',
  write: 'Write-Output',
};

const parserCache = new Map<string, ParsedPowerShell>();

let parserRunner: PowerShellParserRunner = runParserProcess;

function getParseTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env[ENV_PWSH_PARSE_TIMEOUT_MS]);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_PARSE_TIMEOUT_MS;
}

export function normalizeDash(value: string): string {
  return value.replace(/[\u2010-\u2015\u2212]/gu, '-');
}

export function normalizePowerShellFlag(value: string): string | null {
  const normalized = normalizeDash(
    value.trim().replace(/^(['"])(.*)\1$/su, '$2'),
  ).replace(/`/gu, '');
  const match = /^(?:--?|\/)([^:=]+)(?:[:=].*)?$/u.exec(normalized);
  return match?.[1] ?? null;
}

function normalizeCommandName(value: string): string {
  // Rooted and relative executable paths must retain their path identity.
  return normalizeDash(value.trim());
}

export function canonicalizePowerShellCommandName(
  name: string | null,
): string | null {
  if (!name) return null;
  const normalized = normalizeCommandName(name);
  // Only known built-in module qualification denotes the same cmdlet.
  // Unknown modules and executable paths retain their original identity.
  const builtin =
    /^(?:Microsoft\.PowerShell\.(?:Management|Utility|Core|Security))\\([a-z][a-z0-9-]*)$/iu.exec(
      normalized,
    );
  const command = builtin?.[1] ?? normalized;
  return COMMAND_ALIASES[command.toLowerCase()] ?? command;
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeElement(raw: unknown): PowerShellCommandElement {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    text: String(value['text'] ?? ''),
    elementType: String(
      value['elementType'] ?? 'Other',
    ) as PowerShellElementType,
    children: asArray(value['children']).map(normalizeElement),
    staticValue:
      value['staticValue'] == null ? undefined : String(value['staticValue']),
    parameterName:
      value['parameterName'] == null
        ? undefined
        : String(value['parameterName']),
    splatted: value['splatted'] === true,
  };
}

function normalizeRedirection(raw: unknown): PowerShellRedirection {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    text: String(value['text'] ?? ''),
    kind: value['kind'] === 'merge' ? 'merge' : 'file',
    target: value['target'] == null ? null : normalizeElement(value['target']),
    append: value['append'] === true,
    fromStream: String(value['fromStream'] ?? ''),
    toStream: value['toStream'] == null ? undefined : String(value['toStream']),
  };
}

function normalizeCommand(raw: unknown): ParsedPowerShellCommand {
  const value = (raw ?? {}) as Record<string, unknown>;
  const name = value['name'] == null ? null : String(value['name']);
  return {
    name,
    canonicalName: canonicalizePowerShellCommandName(name),
    nameType: String(
      value['nameType'] ?? 'Unknown',
    ) as PowerShellCommandNameType,
    elementType: String(
      value['elementType'] ?? 'Other',
    ) as PowerShellElementType,
    args: asArray(value['args']).map(String),
    text: String(value['text'] ?? ''),
    elements: asArray(value['elements']).map(normalizeElement),
    redirections: asArray(value['redirections']).map(String),
    redirectionDetails: asArray(value['redirectionDetails']).map(
      normalizeRedirection,
    ),
  };
}

function normalizeParsed(raw: unknown, command: string): ParsedPowerShell {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    valid: value['valid'] === true,
    errors: asArray(value['errors']).map(String),
    structuredErrors: asArray(value['structuredErrors']).map((raw) => {
      const error = (raw ?? {}) as Record<string, unknown>;
      return {
        message: String(error['message'] ?? ''),
        errorId: String(error['errorId'] ?? ''),
      };
    }),
    splattedVariables: asArray(value['splattedVariables']).map(String),
    statements: asArray(value['statements']).map((statement) => {
      const entry = (statement ?? {}) as Record<string, unknown>;
      return {
        statementType: String(entry['statementType'] ?? 'Unknown'),
        blockType: String(entry['blockType'] ?? 'EndBlock'),
        nestedCommands: asArray(entry['nestedCommands']).map(normalizeCommand),
        securityPatterns: asArray(entry['securityPatterns']).map(String),
        redirectionDetails: asArray(entry['redirectionDetails']).map(
          normalizeRedirection,
        ),
        text: String(entry['text'] ?? ''),
        commands: asArray(entry['commands']).map(normalizeCommand),
        redirections: asArray(entry['redirections']).map(String),
      };
    }),
    variables: asArray(value['variables']).map(String),
    typeLiterals: asArray(value['typeLiterals']).map(String),
    hasStopParsing: value['hasStopParsing'] === true,
    hasUsingStatements: value['hasUsingStatements'] === true,
    hasScriptRequirements: value['hasScriptRequirements'] === true,
    hasBackgroundJob: value['hasBackgroundJob'] === true,
    originalCommand: command,
  };
}

function invalidResult(command: string, error: string): ParsedPowerShell {
  return {
    valid: false,
    errors: [error],
    statements: [],
    variables: [],
    typeLiterals: [],
    hasStopParsing: false,
    hasUsingStatements: false,
    hasScriptRequirements: false,
    hasBackgroundJob: false,
    originalCommand: command,
  };
}

function putCache(command: string, result: ParsedPowerShell): void {
  parserCache.delete(command);
  parserCache.set(command, result);
  if (parserCache.size > MAX_CACHE_ENTRIES) {
    const oldest = parserCache.keys().next().value;
    if (oldest !== undefined) parserCache.delete(oldest);
  }
}

export function getCachedPowerShellParseResult(
  command: string,
): ParsedPowerShell | undefined {
  const cached = parserCache.get(command);
  if (!cached) return undefined;
  parserCache.delete(command);
  parserCache.set(command, cached);
  return cached;
}

const inflightParses = new Map<string, Promise<ParsedPowerShell>>();

export function parsePowerShellCommand(
  command: string,
): Promise<ParsedPowerShell> {
  const cached = getCachedPowerShellParseResult(command);
  if (cached) return Promise.resolve(cached);

  const inflight = inflightParses.get(command);
  if (inflight) return inflight;

  const parsePromise = parsePowerShellCommandUncached(command).finally(() => {
    inflightParses.delete(command);
  });
  inflightParses.set(command, parsePromise);
  return parsePromise;
}

async function parsePowerShellCommandUncached(
  command: string,
): Promise<ParsedPowerShell> {
  if (Buffer.byteLength(command, 'utf8') > MAX_POWERSHELL_PARSE_BYTES) {
    return invalidResult(
      command,
      `PowerShell command exceeds the ${MAX_POWERSHELL_PARSE_BYTES}-byte static analysis limit.`,
    );
  }
  if (/`u\{[0-9a-f]+\}/iu.test(command)) {
    return invalidResult(
      command,
      'PowerShell Unicode escape syntax cannot be statically validated.',
    );
  }

  const runtime = await getPowerShellRuntime();
  if (!runtime) {
    return invalidResult(
      command,
      'PowerShell is not available on this system.',
    );
  }

  const commandBase64 = Buffer.from(command, 'utf8').toString('base64');
  const parserScript = POWERSHELL_AST_SCRIPT.replace(
    '__COMMAND_BASE64__',
    commandBase64,
  );
  const encodedParser = Buffer.from(parserScript, 'utf16le').toString('base64');
  const timeoutMs = getParseTimeoutMs();
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-NoLogo',
    '-EncodedCommand',
    encodedParser,
  ];

  let lastFailure = 'PowerShell AST parser failed.';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await runWithOuterTimeout(
        parserRunner(runtime.executable, args, timeoutMs),
        timeoutMs + Math.min(timeoutMs, 10_000),
      );
      if (result.timedOut) {
        lastFailure = `PowerShell AST parser timed out after ${timeoutMs}ms.`;
        continue;
      }
      if (result.exitCode !== 0 || !result.stdout.trim()) {
        lastFailure =
          result.stderr.trim() ||
          `PowerShell AST parser exited with code ${String(result.exitCode)}.`;
        continue;
      }
      const parsed = normalizeParsed(JSON.parse(result.stdout), command);
      putCache(command, parsed);
      return parsed;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
  }
  return invalidResult(command, lastFailure);
}

function runWithOuterTimeout(
  result: Promise<RunnerResult>,
  timeoutMs: number,
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`PowerShell AST parser did not settle after ${timeoutMs}ms.`),
      );
    }, timeoutMs);
    timer.unref();
    result.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function getAllParsedPowerShellCommands(
  parsed: ParsedPowerShell,
): ParsedPowerShellCommand[] {
  return parsed.statements.flatMap((statement) => [
    ...statement.commands,
    ...(statement.nestedCommands ?? []),
  ]);
}

function runParserProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}

/** @internal test-only */
export function _setPowerShellParserRunnerForTest(
  runner?: PowerShellParserRunner,
): void {
  parserRunner = runner ?? runParserProcess;
  parserCache.clear();
  inflightParses.clear();
}
