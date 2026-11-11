/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { analyzePowerShellPaths } from './powerShellPathValidation.js';
import {
  PermissionModes,
  permissionRuleValueFromString,
  type PermissionBehavior,
  type PermissionRule,
} from '../../permissions/manager/decision/index.js';
import {
  checkReadPermissionForPath,
  checkWritePermissionForPath,
} from '../filesystem-permissions/filesystem.js';
import {
  matchWildcardPattern,
  parsePermissionRule,
  suggestionForExactCommand,
} from './shellRuleMatching.js';
import type { PathPermissionContext } from '../tool-checkers/checker-reasons.js';
import {
  applyManagedRuleResult,
  checkManagedContentRules,
  askByRule,
  denyByRule,
  type ToolPermissionResult,
} from '../tool-checkers/rule-precedence.js';
import {
  getAllParsedPowerShellCommands,
  canonicalizePowerShellCommandName,
  getCachedPowerShellParseResult,
  parsePowerShellCommand,
  type ParsedPowerShell,
  type ParsedPowerShellCommand,
  type PowerShellCommandElement,
} from './powerShellParser.js';

import {
  validateReadOnlyPowerShellCommand,
  powerShellNativeSafetyIssue,
} from './powerShellReadOnlyValidation.js';

import {
  gitReadOnlyContextReason,
  type ShellReadOnlyContext,
} from './gitReadOnlySafety.js';

export interface PowerShellPermissionInput {
  command: string;
  executionCwd?: string;
  permissionCwd?: string;
}

const LOCATION_COMMANDS = new Set([
  'set-location',
  'push-location',
  'pop-location',
]);
const DYNAMIC_COMMANDS = new Set([
  'invoke-expression',
  'invoke-command',
  'invoke-item',
  'start-process',
  'new-object',
  'add-type',
  'invoke-cimmethod',
  'invoke-wmimethod',
  'wmic',
  'bash',
  'sh',
  'start-job',
  'start-threadjob',
  'register-scheduledjob',
  'register-engineevent',
  'register-objectevent',
  'register-wmievent',
  'new-pssession',
  'enter-pssession',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'cmd',
  'cmd.exe',
  'wsl',
  'wsl.exe',
  'schtasks',
  'register-scheduledtask',
  'new-scheduledtask',
  'new-scheduledtaskaction',
  'set-scheduledtask',
  'import-module',
  'install-module',
  'save-module',
  'update-module',
  'install-script',
  'save-script',
  'remove-module',
  'set-variable',
  'new-variable',
  'remove-variable',
  'set-alias',
  'new-alias',
]);

function collectContentRulesForTool(
  context: PathPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
): PermissionRule[] {
  const bucket =
    behavior === 'allow'
      ? context.rules.allow
      : behavior === 'deny'
        ? context.rules.deny
        : context.rules.ask;
  const rules: PermissionRule[] = [];
  for (const [source, values] of Object.entries(bucket)) {
    for (const value of values ?? []) {
      const parsed = permissionRuleValueFromString(value);
      if (!parsed.ruleContent) continue;
      if (parsed.toolName !== toolName && parsed.toolName !== '*') continue;
      rules.push({
        source: source as PermissionRule['source'],
        ruleBehavior: behavior,
        ruleValue: parsed,
      });
    }
  }
  return rules;
}

/** Normalize only the command token, keeping native paths and arguments intact. */
function normalizeRuleCommand(command: string): string {
  const source = command.trim();
  const match =
    /^(?:[&.]\s+)?(?:'((?:[^']|'')*)'|"([^"`$]*)"|([^\s]+))(.*)$/su.exec(
      source,
    );
  if (!match) return source;
  const rawName = match[1]?.replaceAll("''", "'") ?? match[2] ?? match[3];
  let name = canonicalizePowerShellCommandName(rawName) ?? rawName;
  if (!/[\\/]/u.test(name)) name = name.replace(/\.(?:exe|com|cmd|bat)$/iu, '');
  return (/\s/u.test(name) ? JSON.stringify(name) : name) + match[4];
}

function suggestPowerShellCommand(toolName: string, command: string) {
  // The shared rule format treats stars as wildcards, even inside quotes.
  if (/[*\r\n]/u.test(command)) return [];
  return suggestionForExactCommand(toolName, command);
}

function matchesRule(candidate: string, content: string): boolean {
  if (!content) return false;
  const parsed = parsePermissionRule(content);
  const normalizedCandidate = normalizeRuleCommand(candidate);
  switch (parsed.type) {
    case 'exact':
      return (
        normalizedCandidate.localeCompare(
          normalizeRuleCommand(parsed.command),
          undefined,
          {
            sensitivity: 'accent',
          },
        ) === 0
      );
    case 'prefix': {
      const candidateLower = normalizedCandidate.toLowerCase();
      const prefixLower = normalizeRuleCommand(parsed.prefix).toLowerCase();
      return (
        candidateLower === prefixLower ||
        candidateLower.startsWith(`${prefixLower} `)
      );
    }
    case 'wildcard':
      return matchWildcardPattern(
        normalizeRuleCommand(parsed.pattern),
        normalizedCandidate,
        true,
      );
    default:
      return false;
  }
}

function commandCandidates(parsed: ParsedPowerShell): string[] {
  const candidates = new Set<string>([parsed.originalCommand.trim()]);
  const commands = getAllParsedPowerShellCommands(parsed);
  for (const command of commands) {
    candidates.add(command.text.trim());
    if (
      command.name &&
      command.canonicalName &&
      command.name !== command.canonicalName
    ) {
      candidates.add(
        command.text.replace(command.name, command.canonicalName).trim(),
      );
    }
  }
  return [...candidates].filter(Boolean);
}

function findRule(
  candidates: readonly string[],
  rules: readonly PermissionRule[],
  exactOnly = false,
): PermissionRule | undefined {
  return rules.find((rule) => {
    const content = rule.ruleValue.ruleContent;
    if (!content) return false;
    if (exactOnly && parsePermissionRule(content).type !== 'exact')
      return false;
    return candidates.some((candidate) => matchesRule(candidate, content));
  });
}

function hasUnsafeElement(element: PowerShellCommandElement): boolean {
  if (
    element.elementType === 'ScriptBlock' ||
    element.elementType === 'SubExpression' ||
    (element.elementType === 'ExpandableString' &&
      element.staticValue === undefined) ||
    element.elementType === 'MemberInvocation' ||
    (element.elementType === 'Variable' && element.staticValue === undefined) ||
    (element.text.trimStart().startsWith('@') &&
      element.staticValue === undefined)
  ) {
    return true;
  }
  return element.children.some(hasUnsafeElement);
}

function getStaticSafetyIssue(parsed: ParsedPowerShell): string | undefined {
  if (!parsed.valid)
    return parsed.errors[0] ?? 'PowerShell syntax could not be validated.';
  if (parsed.hasStopParsing)
    return 'The PowerShell stop-parsing token cannot be safely validated.';
  if (parsed.hasUsingStatements)
    return 'PowerShell using statements require confirmation.';
  if (parsed.hasScriptRequirements)
    return 'PowerShell script requirements require confirmation.';
  if (parsed.hasBackgroundJob)
    return 'PowerShell background jobs must use the tool background option.';
  if (parsed.typeLiterals.length > 0)
    return 'PowerShell type literals require confirmation.';
  if (
    parsed.statements.some(
      (statement) => statement.statementType === 'AssignmentStatementAst',
    )
  ) {
    return 'PowerShell assignments require confirmation.';
  }

  if (
    parsed.statements.some(
      (statement) =>
        statement.statementType !== 'PipelineAst' ||
        (statement.securityPatterns?.length ?? 0) > 0 ||
        (statement.nestedCommands?.length ?? 0) > 0 ||
        statement.commands.length === 0,
    )
  ) {
    return 'PowerShell control flow, nested execution, and expression statements require confirmation.';
  }
  const commands = getAllParsedPowerShellCommands(parsed);
  if (
    commands.length > 1 &&
    commands.some((command) =>
      LOCATION_COMMANDS.has(
        (command.canonicalName ?? command.name ?? '').toLowerCase(),
      ),
    )
  ) {
    return 'Changing location in a compound command requires confirmation.';
  }
  for (const command of commands) {
    if (!command.name || command.nameType === 'Unknown') {
      return 'A dynamic PowerShell command name could not be safely validated.';
    }
    for (let index = 1; index < command.elements.length; index++) {
      const element = command.elements[index];
      if (element.elementType !== 'Parameter') continue;
      const parameter = (element.parameterName ?? '').toLowerCase();
      const stateParameters = [
        'outvariable',
        'errorvariable',
        'warningvariable',
        'informationvariable',
        'pipelinevariable',
      ];
      if (
        ['ov', 'ev', 'wv', 'iv', 'pv'].includes(parameter) ||
        (parameter.length > 0 &&
          stateParameters.some((name) => name.startsWith(parameter)))
      ) {
        return 'PowerShell state-capturing common parameters require confirmation.';
      }
      if (
        ['ea', 'wa', 'ia', 'proga'].includes(parameter) ||
        [
          'erroraction',
          'warningaction',
          'informationaction',
          'progressaction',
        ].some((name) => parameter.length > 0 && name.startsWith(parameter))
      ) {
        const value =
          element.children[0]?.staticValue ??
          command.elements[index + 1]?.staticValue;
        if (
          !value ||
          !['continue', 'silentlycontinue', 'stop', 'ignore'].includes(
            value.toLowerCase(),
          )
        )
          return 'Interactive PowerShell action preferences require confirmation.';
      }
    }
    if (command.elements.some(hasUnsafeElement)) {
      return 'Dynamic PowerShell expressions, script blocks, variables, or member invocations require confirmation.';
    }
    const canonical = (command.canonicalName ?? command.name).toLowerCase();
    if (
      canonical === 'foreach-object' &&
      command.elements
        .slice(1)
        .some((element) =>
          element.elementType === 'Parameter'
            ? !!element.parameterName &&
              'membername'.startsWith(element.parameterName.toLowerCase())
            : element.elementType === 'StringConstant',
        )
    ) {
      return 'ForEach-Object -MemberName requires confirmation.';
    }
    if (/^[a-z][\w.-]*\\[a-z]+-[a-z]+$/iu.test(canonical)) {
      return 'An unverified module-qualified command requires confirmation.';
    }
    // Broaden safety recognition only; allow-rule identity keeps the full path.
    const safetyName = path.win32.basename(canonical).replace(/\.exe$/iu, '');
    if (/^(?:start-bitstransfer|certutil)$/iu.test(safetyName)) {
      return 'This transfer utility has unverified file targets and requires confirmation.';
    }
    if (
      safetyName === 'bitsadmin' &&
      command.args.some((arg) => /^\/transfer$/iu.test(stripQuotes(arg)))
    ) {
      return 'BITS downloads require confirmation.';
    }
    if (/\.(?:ps1|cmd|bat)$/iu.test(canonical))
      return 'Shell script invocation requires confirmation.';
    if (DYNAMIC_COMMANDS.has(canonical) || DYNAMIC_COMMANDS.has(safetyName)) {
      return `${command.canonicalName ?? command.name} requires confirmation.`;
    }
    if (
      command.elements
        .slice(1)
        .flatMap((element) => [
          element.staticValue ?? element.text,
          ...element.children.map((child) => child.staticValue ?? child.text),
        ])
        .some((argument) =>
          /^(?:[\\/]{2}|(?:[\w.]+\\)?(?:env|hklm|hkcu|registry|certificate|cert|wsman|variable|alias|function)::?)/iu.test(
            stripQuotes(stripQuotes(argument).replace(/^[-/][\w]+:/u, '')),
          ),
        )
    ) {
      return 'UNC paths and non-filesystem PowerShell providers require confirmation.';
    }
  }
  const downloadsContent = commands.some((command) =>
    /^(?:invoke-webrequest|invoke-restmethod)$/iu.test(
      command.canonicalName ?? command.name ?? '',
    ),
  );
  if (
    downloadsContent &&
    commands.some((command) => command.nameType === 'Application')
  ) {
    return 'Downloading content and executing a native application in the same command requires confirmation.';
  }
  return undefined;
}

function isArchiveCommand(command: ParsedPowerShellCommand): boolean {
  const name = path.win32.basename(command.canonicalName ?? command.name ?? '');
  return /^(?:expand-archive|(?:tar|bsdtar|unzip|7z|7za|gzip|gunzip)(?:\.exe)?)$/iu.test(
    name,
  );
}

function withPowerShellSuggestion(
  decision: ToolPermissionResult,
  toolName: string,
  command: string,
): ToolPermissionResult {
  if (decision.kind !== 'ask') return decision;
  return {
    ...decision,
    suggestions: [
      ...suggestPowerShellCommand(toolName, command),
      ...(decision.suggestions ?? []),
    ],
  };
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/su, '$2');
}

function isParsedPowerShellReadOnly(
  parsed: ParsedPowerShell,
  safetyIssue: string | undefined = getStaticSafetyIssue(parsed),
  executionContext?: ShellReadOnlyContext,
): boolean {
  if (safetyIssue) return false;
  if (
    getAllParsedPowerShellCommands(parsed).some((entry) =>
      powerShellNativeSafetyIssue(entry, executionContext?.cwd),
    )
  )
    return false;
  const commands = getAllParsedPowerShellCommands(parsed);
  if (commands.length === 0) return false;
  if (
    commands.length > 1 &&
    commands.some((command) =>
      LOCATION_COMMANDS.has(
        (command.canonicalName ?? command.name ?? '').toLowerCase(),
      ),
    )
  ) {
    return false;
  }
  if (
    commands.some((command) =>
      /^(git|git\.exe)$/i.test(command.canonicalName ?? command.name ?? ''),
    ) &&
    (!executionContext || gitReadOnlyContextReason(executionContext))
  )
    return false;
  if (
    parsed.statements.some((statement) =>
      statement.commands.some((entry, index) => {
        const paths = analyzePowerShellPaths(
          entry,
          executionContext?.cwd ?? process.cwd(),
          index > 0,
        );
        return (
          !!paths.issue ||
          paths.targets.some((target) => target.access === 'write')
        );
      }),
    )
  )
    return false;
  return commands.every(validateReadOnlyPowerShellCommand);
}

export async function isPowerShellReadOnly(
  command: string,
  context?: ShellReadOnlyContext,
): Promise<boolean> {
  const parsed = await parsePowerShellCommand(command);
  return isParsedPowerShellReadOnly(parsed, undefined, context);
}

export function isPowerShellReadOnlyCached(
  command: string,
  context?: ShellReadOnlyContext,
): boolean {
  const parsed = getCachedPowerShellParseResult(command);
  return parsed
    ? isParsedPowerShellReadOnly(parsed, undefined, context)
    : false;
}

export async function isPowerShellAutoBackgroundAllowed(
  command: string,
): Promise<boolean> {
  // Scheduling eligibility is not a permission decision and must work even
  // when the host policy prevents the AST analyzer from running.
  const root = command.trim().split(/\s+/u)[0];
  if (!root) return true;
  return (
    canonicalizePowerShellCommandName(root)?.toLowerCase() !== 'start-sleep'
  );
}

export async function checkPowerShellPermission(
  input: PowerShellPermissionInput,
  context: PathPermissionContext,
  toolName: string,
): Promise<ToolPermissionResult> {
  const command = input.command.trim();
  const denyRules = collectContentRulesForTool(context, toolName, 'deny');
  const initialDeny = findRule([command], denyRules, true);
  if (initialDeny) return denyByRule(toolName, initialDeny);
  const parsed = await parsePowerShellCommand(command);
  const candidates = commandCandidates(parsed);
  const managed = checkManagedContentRules(
    toolName,
    context.globalRules,
    (content) =>
      candidates.some((candidate) => matchesRule(candidate, content)),
  );
  if (managed?.kind === 'deny') return managed;
  // Preserve local path and safety checks before applying managed confirmation.
  return applyManagedRuleResult(
    checkParsedPowerShellPermission(
      input,
      context,
      toolName,
      parsed,
      candidates,
    ),
    managed,
    PermissionModes.Default,
  );
}

function checkParsedPowerShellPermission(
  input: PowerShellPermissionInput,
  context: PathPermissionContext,
  toolName: string,
  parsed: ParsedPowerShell,
  candidates: readonly string[],
): ToolPermissionResult {
  const command = input.command.trim();
  const denyRules = collectContentRulesForTool(context, toolName, 'deny');
  const askRules = collectContentRulesForTool(context, toolName, 'ask');
  const deny = findRule(candidates, denyRules);
  if (deny) return denyByRule(toolName, deny);
  // Scan recognizable file operands for explicit denies, including nested
  // commands, before returning any ask. Flattening here can only deny, never allow.
  if (input.permissionCwd) {
    for (const entry of getAllParsedPowerShellCommands(parsed)) {
      const paths = analyzePowerShellPaths(
        entry,
        input.executionCwd ?? input.permissionCwd,
      );
      for (const target of paths.targets) {
        const decision =
          target.access === 'write'
            ? checkWritePermissionForPath(
                target.path,
                context,
                input.permissionCwd,
              )
            : checkReadPermissionForPath(
                target.path,
                context,
                input.permissionCwd,
              );
        if (decision.kind === 'deny') return decision;
      }
    }
  }
  const ask = findRule(candidates, askRules);
  if (ask) return askByRule(toolName, ask);
  const executionContext = input.executionCwd ?? input.permissionCwd;
  const hasGit = getAllParsedPowerShellCommands(parsed).some((entry) =>
    /^(git|git\.exe)$/i.test(entry.canonicalName ?? entry.name ?? ''),
  );
  const safetyIssue =
    getStaticSafetyIssue(parsed) ??
    getAllParsedPowerShellCommands(parsed)
      .map((entry) => powerShellNativeSafetyIssue(entry, executionContext))
      .find(Boolean) ??
    (hasGit && executionContext
      ? gitReadOnlyContextReason({ cwd: executionContext })
      : undefined);
  const readOnly = isParsedPowerShellReadOnly(
    parsed,
    safetyIssue,
    executionContext ? { cwd: executionContext } : undefined,
  );
  if (safetyIssue)
    return {
      kind: 'ask',
      reason: {
        message: `${safetyIssue} Command: ${command}`,
        attribution: {
          type: 'safetyCheck',
          reason: safetyIssue,
          classifierApprovable: false,
        },
      },
      suggestions: suggestPowerShellCommand(toolName, command),
    };
  const permissionCwd = input.permissionCwd;
  const analyses = parsed.statements.flatMap((statement) =>
    statement.commands.map((entry, index) => ({
      entry,
      paths: analyzePowerShellPaths(
        entry,
        executionContext ?? process.cwd(),
        index > 0,
      ),
    })),
  );
  let combinationIssue: string | undefined;
  for (let index = 1; index < analyses.length; index++) {
    const current = analyses[index].entry;
    const name = (current.canonicalName ?? current.name ?? '').toLowerCase();
    const earlier = analyses.slice(0, index);
    if (
      /^(?:git|git\.exe)$/u.test(name) &&
      earlier.some(
        ({ paths, entry }) =>
          paths.targets.some(
            (target) =>
              target.access === 'write' &&
              /(?:^|[\\/])(?:\.git|HEAD|objects|refs|hooks|config)(?:$|[\\/])/iu.test(
                target.path,
              ),
          ) ||
          isArchiveCommand(entry) ||
          /^(?:copy-item|move-item|xcopy(?:\.exe)?|robocopy(?:\.exe)?)$/iu.test(
            path.win32.basename(entry.canonicalName ?? entry.name ?? ''),
          ),
      )
    )
      combinationIssue =
        'Filesystem changes before Git may alter its repository or executable configuration.';
    if (current.nameType === 'Application' || !name.includes('-')) {
      const base = path.win32
        .basename(name)
        .replace(/\.(exe|com|cmd|bat|ps1)$/iu, '');
      if (
        earlier.some(
          ({ paths, entry }) =>
            paths.targets.some(
              (target) =>
                target.access === 'write' &&
                path.win32
                  .basename(target.path.replaceAll('/', '\\'))
                  .replace(/\.(exe|com|cmd|bat|ps1)$/iu, '')
                  .toLowerCase() === base,
            ) ||
            isArchiveCommand(entry) ||
            /^start-bitstransfer$/iu.test(
              entry.canonicalName ?? entry.name ?? '',
            ),
        )
      )
        combinationIssue =
          'A preceding file operation may replace the program being executed.';
    }
  }
  const pathIssue =
    combinationIssue ??
    analyses.find((analysis) => analysis.paths.issue)?.paths.issue;
  if (pathIssue)
    return {
      kind: 'ask',
      reason: {
        message: pathIssue,
        attribution: {
          type: 'safetyCheck',
          reason: pathIssue,
          classifierApprovable: false,
        },
      },
    };
  let ordinaryWriteAsk:
    | Extract<ToolPermissionResult, { kind: 'ask' }>
    | undefined;
  let constrainedPathAsk:
    | Extract<ToolPermissionResult, { kind: 'ask' }>
    | undefined;
  if (permissionCwd) {
    for (const { paths } of analyses) {
      for (const target of paths.targets) {
        const decision =
          target.access === 'write'
            ? checkWritePermissionForPath(target.path, context, permissionCwd)
            : checkReadPermissionForPath(target.path, context, permissionCwd);
        if (decision.kind === 'deny') return decision;
        if (decision.kind === 'ask') {
          const decorated = withPowerShellSuggestion(
            decision,
            toolName,
            command,
          ) as Extract<ToolPermissionResult, { kind: 'ask' }>;
          if (
            target.access !== 'write' ||
            decision.reason.decisionPoint !== 'fs_write.default.ask'
          ) {
            constrainedPathAsk ??= decorated;
          } else {
            ordinaryWriteAsk ??= decorated;
          }
        }
      }
    }
  }
  if (constrainedPathAsk) return constrainedPathAsk;
  const allowRules = collectContentRulesForTool(context, toolName, 'allow');
  const wholeCommandAllow = findRule([command], allowRules, true);
  if (wholeCommandAllow) return { kind: 'allow' };
  // A prefix match for one command grants only that command, not its siblings.
  const commands = parsed.statements.flatMap((statement) => statement.commands);
  const individuallyAllowed =
    commands.length > 0 &&
    commands.every((entry) => {
      const segmentCandidates = commandCandidates({
        ...parsed,
        originalCommand: entry.text,
        statements: [
          {
            statementType: 'PipelineAst',
            text: entry.text,
            commands: [entry],
            redirections: entry.redirections,
          },
        ],
      });
      return (
        !!findRule(segmentCandidates, allowRules) ||
        isParsedPowerShellReadOnly(
          {
            ...parsed,
            statements: [
              {
                statementType: 'PipelineAst',
                text: entry.text,
                commands: [entry],
                redirections: entry.redirections,
              },
            ],
          },
          undefined,
          executionContext ? { cwd: executionContext } : undefined,
        )
      );
    });
  if (readOnly || individuallyAllowed) return { kind: 'allow' };
  const acceptEditsEligible =
    !!permissionCwd &&
    analyses.some((a) => a.paths.acceptEditsEligible) &&
    analyses.every(
      (a) =>
        a.paths.acceptEditsEligible ||
        (a.paths.targets.every((target) => target.access === 'read') &&
          validateReadOnlyPowerShellCommand(a.entry)),
    );
  if (ordinaryWriteAsk)
    return {
      ...ordinaryWriteAsk,
      extra: { ...ordinaryWriteAsk.extra, acceptEditsEligible },
    };
  return {
    kind: 'ask',
    reason: {
      message: `PowerShell command requires confirmation: ${command}`,
      attribution: { type: 'other', reason: 'Command requires confirmation' },
    },
    extra: { fillableByAllow: true, acceptEditsEligible },
    suggestions: suggestPowerShellCommand(toolName, command),
  };
}

/** @internal test-only */
export function _resetPowerShellPermissionCachesForTest(): void {
  // Read-only decisions are not cached; syntax cache reset is owned by the parser.
}
