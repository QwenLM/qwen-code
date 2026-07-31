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
import {
  detectCommandSubstitution,
  splitCommands,
  stripShellWrapper,
} from './shell-utils.js';
import {
  classifyAwkCommandSafety,
  classifySedCommandSafety,
  hasShellBraceExpansion,
} from './shell-safety-rules.js';

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

function evaluateGitCommand(tokens: string[]): boolean {
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

  if (subcommand === 'remote') {
    return evaluateGitRemoteArgs(args);
  }

  if (subcommand === 'branch') {
    return evaluateGitBranchArgs(args);
  }

  if (['blame', 'diff', 'log', 'show'].includes(subcommand)) {
    return !options.some((arg) => /^--output(?:=|$)/.test(arg));
  }
  return true;
}

function evaluateShellSegment(segment: string): boolean {
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
    return evaluateGitCommand([normalizedRoot, ...args]);
  }

  return true;
}

/**
 * @deprecated Use `isShellCommandReadOnlyAST` from `./shellAstParser.js` instead.
 * This function uses regex + shell-quote for command parsing with known edge-case
 * limitations. The AST-based replacement provides accurate parsing via tree-sitter-bash.
 */
export function isShellCommandReadOnly(command: string): boolean {
  if (typeof command !== 'string' || !command.trim()) {
    return false;
  }
  if (MALFORMED_CONTROL_OPERATOR.test(command)) return false;
  if (
    /[({;&|]\s*[A-Za-z_][A-Za-z0-9_]*=/.test(command) ||
    /^[A-Za-z_][A-Za-z0-9_]*=.*[;&|]/s.test(command)
  )
    return false;

  const segments = splitCommands(command);

  for (const segment of segments) {
    if (!evaluateShellSegment(segment)) {
      return false;
    }
  }

  return segments.length > 0;
}
