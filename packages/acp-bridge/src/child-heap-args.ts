/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// NODE_OPTIONS uses Node's double-quote/escape rules, not shell tokenization.
function parseNodeOptions(value: string): string[] {
  const args: string[] = [];
  let quoted = false;
  let newArg = true;
  for (let i = 0; i < value.length; i++) {
    let char = value[i];
    if (char === '\\' && quoted) {
      if (++i === value.length) {
        throw new TypeError('Invalid escape in NODE_OPTIONS.');
      }
      char = value[i];
    } else if (char === ' ' && !quoted) {
      newArg = true;
      continue;
    } else if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (newArg) {
      args.push(char);
      newArg = false;
    } else {
      args[args.length - 1] += char;
    }
  }
  if (quoted) throw new TypeError('Unterminated string in NODE_OPTIONS.');
  return args;
}

function withoutInheritedHeapOptions(args: readonly string[]): string[] {
  const retained: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].split('=', 1)[0].replaceAll('_', '-');
    if (flag === '--max-old-space-size-percentage') {
      throw new TypeError(
        'ACP heap enforcement cannot be combined with --max-old-space-size-percentage.',
      );
    }
    if (flag === '--max-old-space-size') {
      if (!args[i].includes('=')) {
        if (i + 1 === args.length || args[i + 1].startsWith('--')) {
          throw new TypeError('Missing value for --max-old-space-size.');
        }
        i++;
      }
    } else {
      retained.push(args[i]);
    }
  }
  return retained;
}

/** Applies a fixed old-space ceiling to argv and the private child environment. */
export function applyChildHeapLimit(
  execArgs: readonly string[],
  childEnv: NodeJS.ProcessEnv,
  ceilingMb: number,
): string[] {
  const args = withoutInheritedHeapOptions(execArgs);
  for (const key of Object.keys(childEnv)) {
    if (
      (process.platform === 'win32' ? key.toUpperCase() : key) !==
      'NODE_OPTIONS'
    ) {
      continue;
    }
    const options = withoutInheritedHeapOptions(
      parseNodeOptions(childEnv[key] ?? ''),
    );
    childEnv[key] = options
      .map((arg) => `"${arg.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
      .join(' ');
  }
  return [...args, `--max-old-space-size=${ceilingMb}`, '--expose-gc'];
}
