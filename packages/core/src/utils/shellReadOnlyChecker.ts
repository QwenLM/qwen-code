/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { parse } from 'shell-quote';
import {
  detectCommandSubstitution,
  splitCommands,
  stripShellWrapper,
} from './shell-utils.js';

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
  'env',
  'find',
  'git',
  'grep',
  'head',
  'less',
  'ls',
  'more',
  'printenv',
  'printf',
  'ps',
  'pwd',
  'rg',
  'ripgrep',
  'sed',
  'sort',
  'stat',
  'tail',
  'tree',
  'uniq',
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

const BLOCKED_FIND_PREFIXES = ['-fprint', '-fprintf'];

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
  'rename',
  'set-url',
  'prune',
  'update',
]);

const BLOCKED_GIT_BRANCH_FLAGS = new Set([
  '-d',
  '-D',
  '--delete',
  '--move',
  '-m',
]);

const BLOCKED_SED_PREFIXES = ['-i'];

const ENV_ASSIGNMENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*=/;

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
  const parsed = parse(segment);
  const tokens: string[] = [];
  for (const token of parsed) {
    if (typeof token === 'string') {
      tokens.push(token);
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
      BLOCKED_SED_PREFIXES.some((prefix) => token.startsWith(prefix)) ||
      token === '--in-place'
    ) {
      return false;
    }
  }
  return true;
}

function evaluateGitRemoteArgs(args: string[]): boolean {
  for (const arg of args) {
    if (BLOCKED_GIT_REMOTE_ACTIONS.has(arg.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function evaluateGitBranchArgs(args: string[]): boolean {
  for (const arg of args) {
    if (BLOCKED_GIT_BRANCH_FLAGS.has(arg)) {
      return false;
    }
  }
  return true;
}

function evaluateGitCommand(tokens: string[]): boolean {
  let index = 1;
  while (index < tokens.length && tokens[index]!.startsWith('-')) {
    const flag = tokens[index]!.toLowerCase();
    if (flag === '--version' || flag === '--help') {
      return true;
    }
    index++;
  }

  if (index >= tokens.length) {
    return true;
  }

  const subcommand = tokens[index]!.toLowerCase();
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return false;
  }

  const args = tokens.slice(index + 1);

  if (subcommand === 'remote') {
    return evaluateGitRemoteArgs(args);
  }

  if (subcommand === 'branch') {
    return evaluateGitBranchArgs(args);
  }

  return true;
}

function evaluateShellSegment(segment: string): boolean {
  if (!segment.trim()) {
    return true;
  }

  const stripped = stripShellWrapper(segment);
  if (!stripped) {
    return true;
  }

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

  const normalizedRoot = root.toLowerCase();
  if (!READ_ONLY_ROOT_COMMANDS.has(normalizedRoot)) {
    return false;
  }

  if (normalizedRoot === 'find') {
    return evaluateFindCommand([normalizedRoot, ...args]);
  }

  if (normalizedRoot === 'sed') {
    return evaluateSedCommand([normalizedRoot, ...args]);
  }

  if (normalizedRoot === 'git') {
    return evaluateGitCommand([normalizedRoot, ...args]);
  }

  return true;
}

export function isShellCommandReadOnly(command: string): boolean {
  if (typeof command !== 'string' || !command.trim()) {
    return false;
  }

  const segments = splitCommands(command);
  for (const segment of segments) {
    const isAllowed = evaluateShellSegment(segment);
    if (!isAllowed) {
      return false;
    }
  }

  return true;
}
