/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ENV_SHELL_PREFIX,
  ENV_SHELL_PREFIX_COMPAT,
} from '../../config/brand.js';

const SAFE_SHELL_ARGUMENT = /^[A-Za-z0-9_./:=@+,-]+$/;

/**
 * Quotes one argument so a POSIX shell passes its bytes through unchanged.
 *
 * Shell prefixes form a compatibility boundary: the wrapper must receive the
 * exact command the CLI assembled, including characters such as `!` and a
 * leading `~`. A deliberately small safe-character set avoids shell expansion
 * while leaving ordinary executable paths and flags readable.
 */
function quoteShellArg(value: string): string {
  if (value === '') {
    return "''";
  }

  if (SAFE_SHELL_ARGUMENT.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteShellArgs(values: readonly string[]): string {
  return values.map(quoteShellArg).join(' ');
}

/**
 * Resolves the shell prefix for a single execution.
 *
 * An explicitly defined branded variable always wins, including an empty
 * value, which disables the compatibility fallback. Values are intentionally
 * not trimmed: a whitespace-only prefix is still an enabled configuration.
 */
export function resolveShellPrefix(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (Object.hasOwn(env, ENV_SHELL_PREFIX)) {
    return env[ENV_SHELL_PREFIX] || undefined;
  }

  return env[ENV_SHELL_PREFIX_COMPAT] || undefined;
}

/**
 * Wraps an assembled POSIX shell command with a prefix executable.
 *
 * The final ` -` in the prefix separates a single executable token from an
 * option suffix. The suffix is kept verbatim; both the executable and the
 * complete command are independently shell-quoted.
 */
export function wrapPosixShellCommand(
  command: string,
  prefix: string,
): string {
  const splitAt = prefix.lastIndexOf(' -');
  if (splitAt > 0) {
    const executable = prefix.substring(0, splitAt);
    const optionSuffix = prefix.substring(splitAt + 1);
    return `${quoteShellArg(executable)} ${optionSuffix} ${quoteShellArg(command)}`;
  }

  return `${quoteShellArg(prefix)} ${quoteShellArg(command)}`;
}

/**
 * Applies the distinct stdio MCP launch transformation.
 *
 * Unlike the POSIX command wrapper, the entire prefix is the spawned
 * executable and the original command plus argv are encoded as one argument.
 */
export function applyStdioShellPrefix(
  command: string,
  args: string[],
  prefix: string,
): { command: string; args: string[] } {
  return {
    command: prefix,
    args: [quoteShellArgs([command, ...args])],
  };
}
