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
  ['env', new Set(['-u', '--unset', '-S', '--split-string'])],
  ['doas', new Set(['-u', '-C'])],
  ['stdbuf', new Set(['-i', '--input', '-o', '--output', '-e', '--error'])],
  [
    'ionice',
    new Set([
      '-c',
      '--class',
      '-n',
      '--classdata',
      '-p',
      '--pid',
      '-P',
      '--pgid',
      '-u',
      '--uid',
    ]),
  ],
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

// These variables can change directory lookup, shell options or startup code.
// An assignment is not a transparent prefix to the command being analysed.
export const SHELL_EXECUTION_ENV_VARIABLE =
  /^(?:CDPATH|BASHOPTS|SHELLOPTS|BASH_ENV|ENV)(?:\[|\+?=|$)/;

const ENV_SPLIT_ESCAPES: Readonly<Record<string, string>> = {
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '"': '"',
  "'": "'",
  '\\': '\\',
  '#': '#',
  $: '$',
};

/** Rebuild static GNU env -S argv without turning argument data into shell syntax. */
export function envSplitStringCommand(
  value: string,
  trailing: readonly string[],
): string | undefined {
  const words = splitEnvString(value);
  if (words === undefined) return undefined;
  // -S inserts arguments into env itself, so injected options and assignments
  // must be consumed before selecting the executable.
  return ['env', ...words, ...trailing]
    .map((word) => `'${word.replaceAll("'", "'\\''")}'`)
    .join(' ');
}

function splitEnvString(value: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote = '';
  const finishWord = () => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (!quote && /[ \t\n\v\f\r]/.test(character)) {
      finishWord();
      continue;
    }
    if (character === '#' && !started) break;
    if (
      (character === "'" || character === '"') &&
      (!quote || quote === character)
    ) {
      quote = quote ? '' : character;
      started = true;
      continue;
    }
    if (
      character === '\\' &&
      (quote !== "'" || /['\\]/.test(value[index + 1] ?? ''))
    ) {
      const escaped = value[++index];
      if (escaped === undefined) return undefined;
      if (escaped === '_') {
        if (quote !== '"') {
          finishWord();
          continue;
        }
        word += ' ';
      } else if (escaped === 'c') {
        if (quote === '"') return undefined;
        break;
      } else {
        const decoded = ENV_SPLIT_ESCAPES[escaped];
        if (decoded === undefined) return undefined;
        word += decoded;
      }
    } else {
      // env expands ${NAME} from its environment, not from the shell word
      // grammar. An unresolved expansion cannot certify a static argv.
      if (character === '$' && quote !== "'") return undefined;
      word += character;
    }
    started = true;
  }
  if (quote) return undefined;
  finishWord();
  return words;
}

/** The tracker and permission guard consume the same transparent prefix. */
export function getShellPrefixCommand(
  tokens: readonly string[],
  start = 0,
):
  | {
      commandIndex: number;
      hasUnsupportedOption: boolean;
      splitString?: string;
    }
  | undefined {
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
      // These operand positions support restrictive inspection only. Keep
      // their previous unsupported-option boundary for persistent grants.
      if (['doas', 'stdbuf', 'ionice'].includes(command)) {
        hasUnsupportedOption = true;
      }
      index++;
      // env -S parses another argument vector. It is never a transparent
      // grant prefix, but its command text remains available to deny checks.
      if (command === 'env' && (flag === '-S' || flag === '--split-string')) {
        const splitString =
          token === flag
            ? tokens[index++]
            : token.slice(flag.length + (flag.startsWith('--') ? 1 : 0));
        return { commandIndex: index, hasUnsupportedOption: true, splitString };
      }
      if (!flag) {
        hasUnsupportedOption = true;
      } else if (token === flag) {
        if (index >= tokens.length) hasUnsupportedOption = true;
        index++;
      }
    } else if (SHELL_ASSIGNMENT_PREFIX.test(token)) {
      if (command === 'env') {
        options = false;
        if (SHELL_EXECUTION_ENV_VARIABLE.test(token))
          hasUnsupportedOption = true;
      }
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
