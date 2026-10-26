/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { ManagedPackageContributions } from '@qwen-code/qwen-code-core/extension/managed-package.js';

async function executable(
  command: string,
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  const candidates = command.includes('/')
    ? [path.resolve(cwd, command)]
    : (environment['PATH'] ?? '/usr/bin:/bin')
        .split(path.delimiter)
        .map((directory) => path.resolve(cwd, directory, command));
  for (const candidate of candidates) {
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error(`Extension executable is unavailable: ${command}`);
}

export async function preflightManagedExtensionPackage(
  contributions: ManagedPackageContributions,
  root: string,
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<{ dynamicCommands: number }> {
  const env: Record<string, string> = {
    ...environment,
    QWEN_EXTENSION_ROOT: root,
    CLAUDE_PLUGIN_ROOT: root,
    extensionPath: root,
  };
  const expand = (value: string, executionEnvironment = env) =>
    value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu,
      (original, braced: string, plain: string) =>
        executionEnvironment[braced ?? plain] ?? original,
    );
  let dynamicCommands = 0;
  const check = async (
    command: string,
    args: readonly string[],
    executionEnvironment = env,
  ) => {
    const resolved = await executable(
      expand(command, executionEnvironment),
      cwd,
      executionEnvironment,
    );
    const handle = await fs.open(resolved, 'r');
    let head: string;
    try {
      const buffer = Buffer.alloc(512);
      const read = await handle.read(buffer, 0, 512, 0);
      head = buffer.subarray(0, read.bytesRead).toString();
    } finally {
      await handle.close();
    }
    if (head.startsWith('#!')) {
      const shebang = head.split('\n')[0]!.slice(2).trim().split(/\s+/u);
      await executable(shebang[0]!, cwd, executionEnvironment);
      if (
        path.basename(shebang[0]!) === 'env' &&
        shebang[1] &&
        !shebang[1].startsWith('-')
      )
        await executable(shebang[1], cwd, executionEnvironment);
    }
    if (path.basename(resolved) === 'env' && args.length) {
      if (args[0]!.startsWith('-') || args[0]!.includes('=')) {
        dynamicCommands++;
        return;
      }
      await check(args[0]!, args.slice(1), executionEnvironment);
      return;
    }
    if (args.includes('-e') || args.includes('--eval') || args.includes('-c')) {
      dynamicCommands++;
      return;
    }
    for (const argument of args.filter(
      (value) =>
        !value.startsWith('-') && /\.(?:[cm]?js|py|rb|sh)$/u.test(value),
    )) {
      const script = path.resolve(cwd, expand(argument, executionEnvironment));
      if (!(await fs.stat(script)).isFile())
        throw new Error('Extension script is unavailable.');
      await fs.access(script, constants.R_OK);
    }
  };
  const shell = async (command: string, executionEnvironment = env) => {
    // Operators, substitutions and conditional commands need runtime resolution.
    if (/[|;&><`\n]|\$\(/u.test(command)) {
      dynamicCommands++;
      return;
    }
    const tokens = [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/gu)].map(
      (match) => match[1] ?? match[2] ?? match[3]!,
    );
    if (!tokens.length) return;
    if (
      tokens.some(
        (token) =>
          token.includes('$') && expand(token, executionEnvironment) === token,
      )
    ) {
      dynamicCommands++;
      return;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[0]!)) {
      dynamicCommands++;
      return;
    }
    if (
      [
        ':',
        '[',
        'alias',
        'bg',
        'break',
        'cd',
        'continue',
        'exit',
        'export',
        'false',
        'fg',
        'getopts',
        'hash',
        'jobs',
        'pwd',
        'read',
        'readonly',
        'return',
        'set',
        'shift',
        'test',
        'times',
        'trap',
        'true',
        'type',
        'ulimit',
        'umask',
        'unalias',
        'unset',
        'wait',
      ].includes(tokens[0]!)
    )
      return;
    if (tokens[0] === 'eval') {
      dynamicCommands++;
      return;
    }
    if (['exec', 'command'].includes(tokens[0]!)) tokens.shift();
    if (tokens.length)
      await check(tokens[0]!, tokens.slice(1), executionEnvironment);
  };
  for (const value of Object.values(contributions.mcpServers)) {
    const recipe = value as {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    };
    if (recipe.command)
      await check(recipe.command, recipe.args ?? [], { ...env, ...recipe.env });
  }
  for (const groups of Object.values(contributions.hooks)) {
    for (const group of groups as Array<{
      hooks?: Array<{
        type?: string;
        command?: string;
        env?: Record<string, string>;
      }>;
    }>) {
      for (const hook of group.hooks ?? [])
        if (hook.type === 'command' && hook.command)
          await shell(hook.command, { ...env, ...hook.env });
    }
  }
  for (const command of contributions.commands)
    for (const match of command.prompt.matchAll(/!\{([^}]*)\}/gu))
      await shell(match[1]!);
  return { dynamicCommands };
}
