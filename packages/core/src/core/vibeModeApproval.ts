/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { parse } from 'shell-quote';
import { ToolNames } from '../tools/tool-names.js';
import { isSubpath } from '../utils/paths.js';
import { splitCommands, stripShellWrapper } from '../utils/shell-utils.js';

type ShellLikeArgs = {
  command?: unknown;
  directory?: unknown;
};

const ALLOWED_ROOT_COMMANDS = new Set([
  'npm',
  'yarn',
  'pnpm',
  'bun',
  'vitest',
  'jest',
  'next',
  'git',
  'ls',
  'mkdir',
  'touch',
]);

const ALLOWED_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'add']);

function toTokenStrings(segment: string): string[] {
  const parsed = parse(segment);
  const tokens: string[] = [];
  for (const token of parsed) {
    if (typeof token === 'string') {
      tokens.push(token);
      continue;
    }
    // shell-quote operators are represented as objects. Keep operator text so
    // redirection checks can detect writes to sensitive locations.
    if (token && typeof token === 'object' && 'op' in token) {
      const op = token.op;
      if (typeof op === 'string') {
        tokens.push(op);
      }
    }
  }
  return tokens;
}

function hasSensitivePathToken(token: string): boolean {
  const normalized = token.toLowerCase();
  return (
    normalized.startsWith('~/.') ||
    normalized.startsWith('$home/') ||
    normalized.startsWith('${home}/') ||
    normalized.startsWith('/etc') ||
    normalized.includes('/etc/')
  );
}

function isDangerousSegment(segment: string, projectDir: string): boolean {
  const tokens = toTokenStrings(segment);
  if (tokens.length === 0) {
    return true;
  }

  const root = tokens[0]?.toLowerCase();
  if (!root) {
    return true;
  }

  if (root === 'sudo') {
    return true;
  }

  // Explicit root-wipe pattern must never be auto-approved.
  if (
    root === 'rm' &&
    tokens.some((t) => t === '/' || t === '--no-preserve-root') &&
    tokens.some((t) => /-.*r/.test(t) || t === '--recursive') &&
    tokens.some((t) => /-.*f/.test(t) || t === '--force')
  ) {
    return true;
  }

  // chmod/chown are system-level sensitive when targeting non-project absolute
  // paths.
  if (root === 'chmod' || root === 'chown') {
    for (const token of tokens) {
      if (!path.isAbsolute(token)) {
        continue;
      }
      const resolved = path.resolve(token);
      if (!isSubpath(projectDir, resolved)) {
        return true;
      }
    }
  }

  // Any obvious writes to ~/. or /etc should require manual confirmation.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    const next = tokens[i + 1] ?? '';
    if (token === '>' || token === '>>' || token === '1>' || token === '1>>') {
      if (hasSensitivePathToken(next)) {
        return true;
      }
    }

    if (hasSensitivePathToken(token) && (root !== 'ls' || i > 0)) {
      return true;
    }
  }

  return false;
}

function isAllowedByWorkflow(tokens: string[]): boolean {
  const root = tokens[0]?.toLowerCase();
  if (!root || !ALLOWED_ROOT_COMMANDS.has(root)) {
    return false;
  }

  // Keep git conservative in Vibe mode.
  if (root === 'git') {
    const sub = tokens[1]?.toLowerCase();
    return !!sub && ALLOWED_GIT_SUBCOMMANDS.has(sub);
  }

  // Keep Next.js scoped to dev server flow.
  if (root === 'next') {
    return tokens[1]?.toLowerCase() === 'dev';
  }

  return true;
}

export function shouldAutoApproveShellInVibeMode(
  toolName: string,
  args: unknown,
  projectDir: string,
): boolean {
  if (toolName !== ToolNames.SHELL) {
    return false;
  }

  const shellArgs = (args ?? {}) as ShellLikeArgs;
  if (typeof shellArgs.command !== 'string' || !shellArgs.command.trim()) {
    return false;
  }

  const resolvedProjectDir = path.resolve(projectDir);
  const resolvedExecutionDir =
    typeof shellArgs.directory === 'string' && shellArgs.directory
      ? path.resolve(shellArgs.directory)
      : resolvedProjectDir;

  // Path-restricted: only permit execution from inside current project dir.
  if (!isSubpath(resolvedProjectDir, resolvedExecutionDir)) {
    return false;
  }

  const command = stripShellWrapper(shellArgs.command);
  const segments = splitCommands(command);
  if (segments.length === 0) {
    return false;
  }

  // Avoid implicit cwd transitions in auto-approve mode; manual approval path
  // remains available as fallback.
  if (segments.some((segment) => toTokenStrings(segment)[0] === 'cd')) {
    return false;
  }

  for (const segment of segments) {
    const tokens = toTokenStrings(segment);
    if (!isAllowedByWorkflow(tokens)) {
      return false;
    }
    if (isDangerousSegment(segment, resolvedProjectDir)) {
      return false;
    }
  }

  return true;
}
