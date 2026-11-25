/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read-only shell command validation.
 *
 * Classifies known read-oriented commands for automatic permission and
 * concurrency decisions; it is not a sandbox. Fail closed: ambiguity,
 * redirections, substitutions and unsafe contexts fall through to the normal
 * permission pipeline. Command specs live in `shellReadOnlyCommandConfigs.ts`;
 * flag parsing in `shellCommandValidation.ts`.
 */

import {
  analyzeShellCommand,
  type ShellCommandAnalysis,
} from './shellCommandAnalysis.js';
import { BRAND_FIXED_ENV_PREFIX } from '../../config/brand.js';
import { isDangerousShellCommand } from './dangerousCommandDetection.js';
import { matchDangerousCommand } from './dangerousCommandList.js';
import { isSingleCommandReadOnly } from './shellCommandValidation.js';

export const ENV_DISABLE_READONLY_SHELL_AUTO_ALLOW = `${BRAND_FIXED_ENV_PREFIX}DISABLE_READONLY_SHELL_AUTO_ALLOW`;
import { walkUnquoted } from './shellStringAnalysis.js';
import { isSpecialDeviceTarget } from '../../utils/specialDevicePaths.js';
import { stripSpecialDeviceRedirections } from '../../utils/shell-utils.js';
import { parse, type ParseEntry } from 'shell-quote';
import {
  collectShellExecutions,
  locateHead,
} from './shellExecutionAnalysis.js';
import {
  gitReadOnlyContextReason,
  type ShellReadOnlyContext,
} from './gitReadOnlySafety.js';

type ScanResult = Pick<
  ShellCommandAnalysis,
  'topLevelSegments' | 'features' | 'blocksBroadAllow'
>;

const EVALUATION_FLAGS: Record<string, readonly string[]> = {
  bash: ['-c'],
  sh: ['-c'],
  zsh: ['-c'],
  python: ['-c'],
  python3: ['-c'],
  perl: ['-e'],
  ruby: ['-e'],
  node: ['-e', '--eval'],
};

/** Check executable interpreter and argument-forwarding commands, not messages or file contents. */
function hasNonReadOnlyExecution(
  command: string,
  analysis: ShellCommandAnalysis,
): boolean {
  const executions = collectShellExecutions(command, analysis);
  const names: string[] = [];
  for (const { tokens } of executions) {
    if (tokens[0] === 'xargs' || tokens[0] === 'tee') return true;
    const head = locateHead(tokens);
    if (!head) continue;
    names.push(head.name);
    if (EVALUATION_FLAGS[head.name]?.some((flag) => head.args.includes(flag)))
      return true;
  }
  return (
    names.some((name) => name === 'curl' || name === 'wget') &&
    names.some((name) => name === 'sh' || name === 'bash')
  );
}

// ============================================================================
// Types
// ============================================================================

/**
 * Result of read-only validation for a shell command.
 */
export type ShellReadOnlyDecision =
  | { readonly: true; reason: string; segments: string[] }
  | { readonly: false; reason: string };

// ============================================================================
// Shell structure safety checks
// ============================================================================

/**
 * Checks if a command string has any output redirections (>, >>, 2>, etc.)
 * that write to a real file. Returns true if real redirections are detected.
 * Skips fd-duplication (2>&1) and special device targets (2>/dev/null).
 */
function hasOutputRedirection(command: string): boolean {
  return walkUnquoted(command, (ch, i, _inDouble) => {
    if (ch === '>') {
      // Safe: N>&M fd-duplication (e.g., 2>&1)
      if (i > 0 && /\d/.test(command[i - 1])) {
        if (i + 1 < command.length && command[i + 1] === '&') {
          return false;
        }
      }
      // Safe: >&N (stdout fd dup)
      if (
        i + 1 < command.length &&
        command[i + 1] === '&' &&
        i + 2 < command.length &&
        /\d/.test(command[i + 2])
      ) {
        return false;
      }
      // Extract the redirect target token after > or >>.
      let targetStart = i + 1;
      if (command[targetStart] === '>') targetStart++; // >> case
      // Skip spaces between operator and target.
      while (targetStart < command.length && command[targetStart] === ' ') {
        targetStart++;
      }
      // Extract the target word (until space, |, &, ;, newline, or end).
      let targetEnd = targetStart;
      while (
        targetEnd < command.length &&
        !/\s|[|;&]/.test(command[targetEnd])
      ) {
        targetEnd++;
      }
      const target = command.slice(targetStart, targetEnd);
      // Safe: redirect to a special device (e.g. /dev/null, NUL).
      if (isSpecialDeviceTarget(target)) {
        return false;
      }
      return true; // real redirection to a file
    }
    return false;
  });
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Checks whether a shell command is provably read-only.
 *
 * This is the main entry point for the read-only validation module.
 * It validates the entire command (including compound commands) and returns
 * a decision indicating whether the command can be auto-allowed.
 *
 * @param command The shell command string to validate
 * @param precomputedScan Optional pre-computed scan result from the caller.
 *   It is reused only when normalization leaves the command unchanged.
 * @returns A decision indicating whether the command is read-only
 */
export function checkReadOnlyShellCommand(
  command: string,
  precomputedScan?: ScanResult,
  context?: ShellReadOnlyContext,
): ShellReadOnlyDecision {
  // Early exit: check rollback env var
  if (process.env[ENV_DISABLE_READONLY_SHELL_AUTO_ALLOW] === '1') {
    return {
      readonly: false,
      reason: 'Read-only auto-allow disabled by env var',
    };
  }

  // Empty command is not read-only
  if (!command.trim()) {
    return { readonly: false, reason: 'Empty command' };
  }

  // Strip safe stderr-to-stdout redirections before analysis.
  // These are semantically safe (just routing stderr) but confuse the shell
  // scanner which interprets `&` in `2>&1` as a background operator.
  const originalCommand = command.trim();
  const originalAnalysis =
    precomputedScan && 'original' in precomputedScan
      ? (precomputedScan as ShellCommandAnalysis)
      : analyzeShellCommand(command);
  if (originalAnalysis.analysisIncomplete)
    return {
      readonly: false,
      reason: 'Shell syntax could not be fully analyzed',
    };
  let normalizedCommand = originalAnalysis.syntax?.source ?? originalCommand;
  const hadFdRedirect = /\s+\d+>&\d+/.test(normalizedCommand);
  if (hadFdRedirect) {
    normalizedCommand = normalizedCommand
      .replace(/\s+\d+>&\d+\s*$/g, '')
      .trim();
    normalizedCommand = normalizedCommand.replace(
      /\s+\d+>&\d+(?=\s*[|;&])/g,
      '',
    );
  }

  // Strip redirections to special devices (e.g. 2>/dev/null, > NUL).
  // These don't write to the real filesystem and should not affect
  // read-only classification.
  normalizedCommand = stripSpecialDeviceRedirections(normalizedCommand);

  if (!normalizedCommand) {
    return { readonly: false, reason: 'Empty command after normalization' };
  }

  // Check dangerous command list
  if (hasNonReadOnlyExecution(command, originalAnalysis)) {
    return {
      readonly: false,
      reason:
        'Command contains an execution that cannot be auto-allowed as read-only',
    };
  }
  if (isDangerousShellCommand({ command }, originalAnalysis)) {
    return { readonly: false, reason: 'Command matches dangerous pattern' };
  }

  // A scan is tied to the exact command text it analyzed. Reuse the caller's
  // scan only when normalization did not alter that text; otherwise rescan the
  // normalized command so segment validation cannot see stripped redirects.
  const commandWasNormalized = normalizedCommand !== originalCommand;
  const analysis =
    !commandWasNormalized && precomputedScan
      ? precomputedScan
      : analyzeShellCommand(normalizedCommand);

  // Reject commands with nested execution boundaries
  // ($(), backticks, process substitution, subshell)
  if (
    originalAnalysis.features.hasNestedExecution ||
    analysis.features.hasNestedExecution
  ) {
    return {
      readonly: false,
      reason:
        'Command contains nested execution (command substitution, subshell, etc.)',
    };
  }

  // A read-only command still changes process/lifecycle semantics when it is
  // detached into the background. Keep auto-allow limited to invocations that
  // complete within the tool execution boundary.
  if (analysis.features.hasBackgroundExecution) {
    return {
      readonly: false,
      reason: 'Command contains background execution',
    };
  }

  // Check for output redirections in the full command
  if (hasOutputRedirection(normalizedCommand)) {
    return { readonly: false, reason: 'Command contains output redirection' };
  }

  // Split into top-level segments and validate each one
  const segments = analysis.topLevelSegments;

  // Parse command heads rather than matching "git" in arguments or filenames.
  let heads: Array<ParseEntry | undefined>;
  try {
    heads = segments.map((segment) => parse(segment)[0]);
  } catch {
    return { readonly: false, reason: 'Command could not be parsed' };
  }
  if (heads.includes('git')) {
    if (heads.includes('cd')) {
      return {
        readonly: false,
        reason: 'Compound cd and Git commands require permission checks',
      };
    }
    const reason = context && gitReadOnlyContextReason(context);
    if (reason) return { readonly: false, reason };
  }

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // Check the base command against the dangerous command set
    const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (matchDangerousCommand(firstWord)) {
      return {
        readonly: false,
        reason: `Segment contains dangerous command: ${firstWord}`,
      };
    }

    // Validate each subcommand via the mature command validation module
    if (!isSingleCommandReadOnly(trimmed)) {
      return {
        readonly: false,
        reason: `Segment is not provably read-only: ${trimmed.slice(0, 60)}`,
      };
    }
  }

  return {
    readonly: true,
    reason: 'All segments validated as read-only',
    segments,
  };
}
