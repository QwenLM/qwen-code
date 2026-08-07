/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  ExternalToolGuardHandler,
  ExternalToolGuardPrepareRequest,
  ExternalToolGuardPrepareResult,
} from '@qwen-code/acp-bridge/bridgeOptions';

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'blame',
  'cat-file',
  'describe',
  'diff',
  'grep',
  'log',
  'ls-files',
  'rev-parse',
  'show',
  'status',
]);

const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set([
  '-c',
  '--config-env',
  '--namespace',
  '--super-prefix',
]);

const EXTERNAL_GUARD_UNSUPPORTED_TOOLS = new Set([
  'agent',
  'workflow',
  'create_sub_session',
  'send_message',
]);

interface TrustedDaemonToolGuardRequest
  extends ExternalToolGuardPrepareRequest {
  readonly workspaceCwd: string;
  readonly effectiveCwd: string;
}

interface GitInvocation {
  readonly relocations: Array<{
    readonly target: string;
    readonly kind: 'cwd' | 'git-dir' | 'work-tree';
  }>;
  readonly subcommand?: string;
  readonly unresolvedRelocation: boolean;
}

async function canonicalize(candidate: string): Promise<string> {
  const resolved = path.resolve(candidate);
  let current = resolved;
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(current), ...suffix.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function readGitInvocation(tokens: string[]): GitInvocation | null {
  const relocations: GitInvocation['relocations'] = [];
  let unresolvedRelocation = false;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === '-C' || token === '--git-dir' || token === '--work-tree') {
      const value = tokens[index + 1];
      if (!value) return null;
      if (value.includes('$')) {
        unresolvedRelocation = true;
      } else {
        relocations.push({
          target: value,
          kind:
            token === '-C'
              ? 'cwd'
              : token === '--git-dir'
                ? 'git-dir'
                : 'work-tree',
        });
      }
      index += 2;
      continue;
    }
    if (token.length > 2 && token.startsWith('-C')) {
      const value = token.slice(2);
      if (value.includes('$')) {
        unresolvedRelocation = true;
      } else {
        relocations.push({ target: value, kind: 'cwd' });
      }
      index++;
      continue;
    }
    if (token.startsWith('--git-dir=') || token.startsWith('--work-tree=')) {
      const separator = token.indexOf('=');
      const value = token.slice(separator + 1);
      if (!value) return null;
      if (value.includes('$')) {
        unresolvedRelocation = true;
      } else {
        relocations.push({
          target: value,
          kind: token.startsWith('--git-dir=') ? 'git-dir' : 'work-tree',
        });
      }
      index++;
      continue;
    }
    if (GIT_GLOBAL_OPTIONS_WITH_VALUES.has(token)) {
      index += 2;
      continue;
    }
    if (
      token.startsWith('--config-env=') ||
      token.startsWith('--exec-path=') ||
      token.startsWith('--namespace=') ||
      token.startsWith('--super-prefix=')
    ) {
      index++;
      continue;
    }
    if (token.startsWith('-')) {
      index++;
      continue;
    }
    return relocations.length > 0 || unresolvedRelocation
      ? { relocations, subcommand: token, unresolvedRelocation }
      : null;
  }
  return relocations.length > 0 || unresolvedRelocation
    ? { relocations, unresolvedRelocation }
    : null;
}

let shellQuotePromise: Promise<typeof import('shell-quote')> | undefined;

async function readCommandSegments(command: string): Promise<string[][]> {
  const segments: string[][] = [];
  try {
    shellQuotePromise ??= import('shell-quote');
    const { parse } = await shellQuotePromise;
    for (const line of command.split(/\r?\n/)) {
      const parsed = parse(line, (key) => `$${key}`);
      segments.push([]);
      for (const token of parsed) {
        if (typeof token === 'string') {
          segments.at(-1)!.push(token);
        } else if ('op' in token) {
          segments.push([]);
        } else {
          return [];
        }
      }
    }
    return segments.filter((segment) => segment.length > 0);
  } catch {
    return [];
  }
}

function findGitInvocationStart(tokens: string[]): number {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index++;
  if (tokens[index] === 'command') {
    index++;
    while (tokens[index]?.startsWith('-')) index++;
  } else if (tokens[index] === 'env') {
    index++;
    while (
      tokens[index]?.startsWith('-') ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')
    ) {
      index++;
    }
  }
  return tokens[index] === 'git' ? index : -1;
}

async function evaluateBuiltInGuard(
  request: TrustedDaemonToolGuardRequest,
): Promise<ExternalToolGuardPrepareResult> {
  if (request.toolName !== 'run_shell_command') return { allowed: true };
  const command = request.arguments['command'];
  if (typeof command !== 'string') return { allowed: true };

  const startDirectoryValue = request.arguments['directory'];
  const startDirectory =
    typeof startDirectoryValue === 'string'
      ? startDirectoryValue
      : request.effectiveCwd;
  const canonicalEffectiveCwd = await canonicalize(request.effectiveCwd);

  for (const segment of await readCommandSegments(command)) {
    const invocationStart = findGitInvocationStart(segment);
    if (invocationStart < 0) continue;
    const invocation = readGitInvocation(segment.slice(invocationStart));
    if (
      !invocation ||
      READ_ONLY_GIT_SUBCOMMANDS.has(invocation.subcommand ?? '')
    ) {
      continue;
    }
    if (invocation.unresolvedRelocation) {
      return {
        allowed: false,
        reason:
          'Daemon shell guard denied a mutating Git command with a dynamic repository location.',
      };
    }

    let gitCwd = startDirectory;
    const repositoryTargets: string[] = [];
    for (const relocation of invocation.relocations) {
      const target = path.resolve(gitCwd, relocation.target);
      if (relocation.kind === 'cwd') {
        gitCwd = target;
        continue;
      }
      repositoryTargets.push(
        relocation.kind === 'git-dir' && path.basename(target) === '.git'
          ? path.dirname(target)
          : target,
      );
    }
    repositoryTargets.push(gitCwd);

    for (const repositoryTarget of repositoryTargets) {
      const canonicalTarget = await canonicalize(repositoryTarget);
      if (isWithin(canonicalTarget, canonicalEffectiveCwd)) continue;
      return {
        allowed: false,
        reason: `Daemon shell guard denied a mutating Git command outside the session working directory: ${canonicalTarget}`,
      };
    }
  }
  return { allowed: true };
}

export function createDaemonToolGuard(
  externalGuard?: ExternalToolGuardHandler,
): ExternalToolGuardHandler {
  return async (request) => {
    const trusted = request as TrustedDaemonToolGuardRequest;
    if (
      typeof trusted.workspaceCwd !== 'string' ||
      typeof trusted.effectiveCwd !== 'string'
    ) {
      throw new Error('Daemon tool guard requires trusted workspace context.');
    }
    const builtInDecision = await evaluateBuiltInGuard(trusted);
    if (!builtInDecision.allowed || !externalGuard) return builtInDecision;
    if (EXTERNAL_GUARD_UNSUPPORTED_TOOLS.has(request.toolName)) {
      return {
        allowed: false,
        reason:
          'Managed external tool guard v1 does not support nested or delegated agent execution.',
      };
    }
    return externalGuard(request);
  };
}
