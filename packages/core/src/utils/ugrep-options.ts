/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const UGREP_SHORT_OPTIONS_WITH_REQUIRED_VALUES = [
  'A',
  'B',
  'C',
  'D',
  'd',
  'e',
  'f',
  'g',
  'J',
  'K',
  'M',
  'm',
  'N',
  'O',
  't',
  '?',
] as const;

export const UGREP_LONG_OPTIONS_WITH_REQUIRED_VALUES = [
  '--after-context',
  '--before-context',
  '--binary-files',
  '--context',
  '--devices',
  '--directories',
  '--depth',
  '--regexp',
  '--exclude-from',
  '--file',
  '--from',
  '--include-dir',
  '--include-from',
] as const;

const SHORT_OPTIONS_WITH_REQUIRED_VALUES = new Set<string>(
  UGREP_SHORT_OPTIONS_WITH_REQUIRED_VALUES,
);
const LONG_OPTIONS_WITH_REQUIRED_VALUES = new Set<string>(
  UGREP_LONG_OPTIONS_WITH_REQUIRED_VALUES,
);

export interface UgrepOptionScan {
  safety: 'read-only' | 'unknown' | 'write';
  saveConfigTarget?: string;
}

export function scanUgrepOptions(args: readonly string[]): UgrepOptionScan {
  let consumeNext = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (consumeNext) {
      consumeNext = false;
      continue;
    }
    if (arg === '--') {
      break;
    }
    if (arg === '--save-config') {
      return { safety: 'write', saveConfigTarget: '.ugrep' };
    }
    if (arg.startsWith('--save-config=')) {
      const attached = arg.slice('--save-config='.length);
      const target = attached || args[index + 1];
      return target
        ? { safety: 'write', saveConfigTarget: target }
        : { safety: 'write' };
    }
    if (/^(?:---|--(?:config|filter|pager|query|view)(?:=|$))/.test(arg)) {
      return { safety: 'unknown' };
    }
    if (LONG_OPTIONS_WITH_REQUIRED_VALUES.has(arg)) {
      consumeNext = true;
      continue;
    }
    if (!arg.startsWith('-') || arg.startsWith('--')) {
      continue;
    }

    const options = arg.slice(1);
    for (let optionIndex = 0; optionIndex < options.length; optionIndex++) {
      const option = options[optionIndex]!;
      if (option === 'Q') {
        return { safety: 'unknown' };
      }
      if (SHORT_OPTIONS_WITH_REQUIRED_VALUES.has(option)) {
        consumeNext = optionIndex === options.length - 1;
        break;
      }
    }
  }

  return { safety: 'read-only' };
}
