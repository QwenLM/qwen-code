/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getAutoModeReviewPresets,
  type AutoModeReviewPresets,
} from '../../../config-service/features/autoModeReviewPresets.js';
import {
  SHELL_TOOL_NAME,
  MONITOR_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
} from '../../../tools/tool-names.js';
import type {
  ToolPermissionExtra,
  ToolPermissionReason,
} from '../../../tools/tool-checkers/checker-reasons.js';
import type { ToolCheckContext } from '../../manager/decision/index.js';
import type { ToolPermissionResult } from '../../../tools/tool-checkers/rule-precedence.js';
import { analyzeShellCommand } from '../../../tools/shell-permissions/shellCommandAnalysis.js';
import {
  collectShellExecutions,
  locateHead,
} from '../../../tools/shell-permissions/shellExecutionAnalysis.js';
import { dangerousExecutableWarning } from '../../../tools/shell-permissions/dangerousCommandDetection.js';
import { checkDangerousRemoval } from '../../../tools/shell-permissions/dangerousRemoval.js';
import {
  parsePowerShellCommand,
  getAllParsedPowerShellCommands,
} from '../../../tools/shell-permissions/powerShellParser.js';

type Review = NonNullable<ToolPermissionExtra['autoReview']>;
type Head = { name: string; args: readonly string[] };
type Ask = Extract<ToolPermissionResult, { kind: 'ask' }>;

const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
]);
const FIND_VALUE_OPTIONS = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-wholename',
  '-iwholename',
  '-regex',
  '-iregex',
  '-lname',
  '-ilname',
  '-type',
  '-xtype',
  '-size',
  '-user',
  '-group',
  '-uid',
  '-gid',
  '-perm',
  '-links',
  '-inum',
  '-samefile',
  '-newer',
  '-anewer',
  '-cnewer',
  '-mtime',
  '-atime',
  '-ctime',
  '-mmin',
  '-amin',
  '-cmin',
  '-mindepth',
  '-maxdepth',
  '-depth',
  '-regextype',
  '-printf',
  '-fprint',
  '-fprint0',
  '-fls',
  '-files0-from',
]);

export function isAutoReviewShell(toolName: string): boolean {
  return (
    toolName === SHELL_TOOL_NAME ||
    toolName === MONITOR_TOOL_NAME ||
    toolName === POWERSHELL_TOOL_NAME
  );
}

export function autoReviewMetadata(
  toolName: string,
  input: Record<string, unknown>,
  reason: Review['reason'],
  ruleId?: string,
): Review {
  return {
    version: 'risk_blacklist_v1',
    reason,
    ...(isAutoReviewShell(toolName)
      ? {
          risk:
            toolName !== SHELL_TOOL_NAME || input['risk'] === undefined
              ? ('missing' as const)
              : input['risk'] === true
                ? ('true' as const)
                : ('false' as const),
        }
      : {}),
    ...(ruleId ? { ruleId } : {}),
  };
}

export async function evaluateAutoReview(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolCheckContext<ToolPermissionReason>,
  ask: Ask,
): Promise<Review> {
  const attribution = ask.reason.attribution;
  const result = (reason: Review['reason'], ruleId?: string) =>
    autoReviewMetadata(toolName, input, reason, ruleId);
  if (attribution.type === 'rule') return result('rule_ask');
  if (attribution.type === 'hook') return result('hook_ask');
  const shell = isAutoReviewShell(toolName);
  if (
    attribution.type === 'safetyCheck' &&
    (!shell || attribution.safetyCheckKind === 'protectedPath')
  ) {
    return result('safety_check');
  }
  if (toolName === SHELL_TOOL_NAME && input['risk'] === true)
    return result('model_risk');
  if (!shell) return result('non_shell');

  const presets = getAutoModeReviewPresets();
  const command = input['command'] as string;
  let analysis: ReturnType<typeof analyzeShellCommand> | undefined;
  let heads: Head[];
  if (toolName === POWERSHELL_TOOL_NAME) {
    const parsed = await parsePowerShellCommand(command);
    heads = getAllParsedPowerShellCommands(parsed).map((entry) => ({
      name: entry.canonicalName ?? entry.name ?? '',
      args: entry.elements
        .slice(1)
        .map((element) => element.staticValue ?? element.text),
    }));
  } else {
    analysis = analyzeShellCommand(command);
    heads = collectShellExecutions(command, analysis)
      .map(({ tokens }) => locateHead(tokens))
      .filter((head): head is NonNullable<typeof head> => head !== null);
  }
  const normalized = heads.map(normalizeHead);
  // Normalized so paths, .exe and git global options cannot hide a flag-based rule.
  if (normalized.some((head) => dangerousExecutableWarning(head)))
    return result('dangerous_command');
  if (
    analysis &&
    checkDangerousRemoval(command, analysis, {
      permissionCwd: ctx.cwd,
      executionCwd: ask.extra?.shellExecutionCwd ?? ctx.cwd,
      additionalDirectories: ctx.additionalDirectories,
    })
  )
    return result('dangerous_removal');
  for (const head of normalized) {
    const preset = matchPreset(head, presets);
    if (preset) return result('preset', preset);
  }
  return result('no_match');
}

function normalizeHead(head: Head): Head {
  const name = head.name
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.exe$/i, '')
    .toLowerCase();
  if (name !== 'git') return { name, args: head.args };
  let index = 0;
  while (index < head.args.length && head.args[index].startsWith('-')) {
    const option = head.args[index++];
    if (option === '--') break;
    if (GIT_VALUE_OPTIONS.has(option)) index++;
  }
  return { name, args: head.args.slice(index) };
}

function matchPreset(
  { name, args }: Head,
  presets: AutoModeReviewPresets,
): string | undefined {
  if (presets.commands.includes(name)) return 'preset.' + name;
  if (presets.mkfs_variants && name.startsWith('mkfs.')) return 'preset.mkfs';
  if (name === 'git') {
    const subcommand = presets.git_subcommands.find((tokens) =>
      tokens.every((token, index) => token === args[index]),
    );
    if (subcommand) return 'preset.git.' + subcommand.join('.');
  }
  if (presets.find_delete && name === 'find' && hasFindDelete(args))
    return 'preset.find.delete';
  return undefined;
}

function hasFindDelete(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '-delete') return true;
    if (['-exec', '-execdir', '-ok', '-okdir'].includes(arg)) {
      while (index + 1 < args.length && ![';', '+'].includes(args[++index])) {
        /* command argv */
      }
    } else if (arg === '-fprintf') {
      index += 2;
    } else if (FIND_VALUE_OPTIONS.has(arg) || /^-newer[a-zA-Z]{2}$/.test(arg)) {
      // GNU -depth is a flag; BSD's numeric -depth expression consumes a value.
      if (arg !== '-depth' || /^[+-]?\d+$/.test(args[index + 1] ?? '')) index++;
    }
  }
  return false;
}
