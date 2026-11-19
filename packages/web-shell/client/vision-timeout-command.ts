/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Mirrors the CLI's `/model --vision --timeout` parsing: Web Shell handles
// `/model --vision` on the client and writes the settings itself.
const TIMEOUT_FLAG = /(?:^|\s)--timeout(?=[=\s]|$)(?:\s+(?!--)(\S+))?/;

/**
 * Splits `--timeout <value>` out of a `/model --vision` argument string in any
 * position. A flag without a value yields `timeout: ''`. Reject remaining
 * options before they can be used as the vision model selector.
 */
export function extractVisionTimeout(modelArg: string): {
  modelArg: string;
  timeout?: string;
  invalidOption?: string;
} {
  const match = TIMEOUT_FLAG.exec(modelArg);
  const remaining = match ? modelArg.replace(match[0], ' ').trim() : modelArg;
  if (!/^--vision(?:\s|$)/.test(remaining)) {
    return match && modelArg.startsWith('--')
      ? { modelArg, invalidOption: '--timeout' }
      : { modelArg };
  }
  const invalidOption = /\s(--\S+)/.exec(remaining)?.[1];
  if (invalidOption) return { modelArg, invalidOption };
  return match
    ? { modelArg: remaining, timeout: match[1] ?? '' }
    : { modelArg };
}

/** `60`, `60s` → seconds, `90000ms` → milliseconds; invalid → undefined. */
export function parseVisionTimeoutMs(value: string): number | undefined {
  const match = /^(\d+)(s|ms)?$/.exec(value);
  if (!match) return undefined;
  const timeoutMs = Number(match[1]) * (match[2] === 'ms' ? 1 : 1000);
  return timeoutMs > 0 && timeoutMs <= 2_147_483_647 ? timeoutMs : undefined;
}
