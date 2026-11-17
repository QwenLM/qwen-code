/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const PREFIX_COMMAND_FLAGS_WITH_VALUE = new Map<string, ReadonlySet<string>>([
  [
    'sudo',
    new Set([
      '-u',
      '--user',
      '-g',
      '--group',
      '-C',
      '--close-from',
      '-c',
      '--login-class',
      '-D',
      '--chdir',
      '-p',
      '--prompt',
      '-r',
      '--role',
      '-t',
      '--type',
      '-T',
      '--command-timeout',
      '-U',
      '--other-user',
    ]),
  ],
  ['env', new Set(['-u', '--unset'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
  ['exec', new Set(['-a'])],
]);

const PREFIX_COMMAND_FLAGS_WITHOUT_VALUE = new Map<string, ReadonlySet<string>>(
  [
    ['sudo', new Set(['-n', '--non-interactive'])],
    ['env', new Set(['-i', '--ignore-environment'])],
    ['time', new Set(['-p'])],
    ['timeout', new Set(['--foreground'])],
    ['exec', new Set(['-c', '-l'])],
    ['command', new Set(['-p'])],
    ['setsid', new Set(['-c', '--ctty', '-f', '--fork', '-w', '--wait'])],
  ],
);

const PREFIX_COMMANDS = new Set([
  'sudo',
  'doas',
  'env',
  'time',
  'nice',
  'ionice',
  'nohup',
  'timeout',
  'unbuffer',
  'stdbuf',
  'exec',
  'command',
  'builtin',
  'setsid',
]);

export const MAX_SHELL_UNWRAP_DEPTH = 4;

export const SHELL_ASSIGNMENT_PREFIX =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

/** The tracker and permission guard consume the same transparent prefix. */
export function getShellPrefixCommand(
  tokens: readonly string[],
  start = 0,
): { commandIndex: number; hasUnsupportedOption: boolean } | undefined {
  const executable = tokens[start];
  const command = executable?.split('/').at(-1);
  if (
    !command ||
    !PREFIX_COMMANDS.has(command) ||
    // These names are shell builtins, not path-addressed executables.
    (executable !== command && ['exec', 'command', 'builtin'].includes(command))
  ) {
    return undefined;
  }
  const flagsWithValue = PREFIX_COMMAND_FLAGS_WITH_VALUE.get(command);
  let index = start + 1;
  let hasUnsupportedOption = false;
  let options = true;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (options && token === '--') {
      index++;
      options = false;
    } else if (options && token.startsWith('-')) {
      if (
        PREFIX_COMMAND_FLAGS_WITHOUT_VALUE.get(command)?.has(token) ||
        (command === 'nice' && /^-\d+$/.test(token))
      ) {
        index++;
        continue;
      }
      const flag = [...(flagsWithValue ?? [])].find(
        (value) =>
          token === value ||
          (value.startsWith('--')
            ? token.startsWith(`${value}=`)
            : token.startsWith(value)),
      );
      // The operation tracker cannot follow a prefix's working-directory change.
      if (command === 'sudo' && (flag === '-D' || flag === '--chdir')) {
        hasUnsupportedOption = true;
      }
      index++;
      if (!flag) {
        hasUnsupportedOption = true;
      } else if (token === flag) {
        if (index >= tokens.length) hasUnsupportedOption = true;
        index++;
      }
    } else if (SHELL_ASSIGNMENT_PREFIX.test(token)) {
      index++;
    } else {
      break;
    }
  }
  if (command === 'timeout') {
    if (index < tokens.length && /^\d/.test(tokens[index]!)) index++;
    else hasUnsupportedOption = true;
  }
  return { commandIndex: index, hasUnsupportedOption };
}
