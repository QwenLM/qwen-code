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
]);

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
]);

export const MAX_SHELL_UNWRAP_DEPTH = 4;

/** The tracker and permission guard consume the same transparent prefix. */
export function getShellPrefixCommand(
  tokens: readonly string[],
  start = 0,
): { commandIndex: number; hasUnsupportedOption: boolean } | undefined {
  const command = tokens[start];
  if (!command || !PREFIX_COMMANDS.has(command)) return undefined;
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
      const flag = [...(flagsWithValue ?? [])].find(
        (value) =>
          token === value ||
          (value.startsWith('--')
            ? token.startsWith(`${value}=`)
            : token.startsWith(value)),
      );
      index++;
      if (!flag) {
        hasUnsupportedOption = true;
      } else if (token === flag) {
        if (index >= tokens.length) hasUnsupportedOption = true;
        index++;
      }
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
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
