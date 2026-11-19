/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Mirrors the CLI's `/model --vision --timeout` parsing: Web Shell handles
// `/model --vision` on the client and writes the settings itself.
const TIMEOUT_FLAG = /(?:^|\s)--timeout(?=\s|$)(?:\s+(?!--)(\S+))?/;

/**
 * Splits `--timeout <value>` out of a `/model --vision` argument string in any
 * position. Anything else is returned untouched with `timeout` undefined; a
 * flag without a value yields `timeout: ''`.
 */
export function extractVisionTimeout(modelArg: string): {
  modelArg: string;
  timeout?: string;
} {
  const match = TIMEOUT_FLAG.exec(modelArg);
  if (!match) return { modelArg };
  const remaining = modelArg.replace(match[0], ' ').trim();
  return remaining === '--vision' || remaining.startsWith('--vision ')
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
