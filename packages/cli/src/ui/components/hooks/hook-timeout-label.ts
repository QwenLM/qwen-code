/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { HookType } from '@qwen-code/qwen-code-core/hooks/types.js';
import {
  isLegacyMillisecondHookTimeout,
  resolveCommandHookTimeoutMs,
} from '@qwen-code/qwen-code-core/hooks/hook-timeout.js';
import type { HooksListingRow } from '@qwen-code/qwen-code-core/hooks/hooks-listing.js';

/**
 * Timeout with its unit: function hooks count milliseconds, command hooks
 * still read 1000 or more as legacy milliseconds, everything else seconds.
 */
export function formatHookTimeout(
  row: Pick<HooksListingRow, 'timeout' | 'hookType'>,
): string {
  const configured: unknown = row.timeout;
  if (row.hookType === HookType.Command) {
    const effective = resolveCommandHookTimeoutMs(configured, 'hook listing');
    const numeric =
      typeof configured === 'string' ? Number(configured) : configured;
    return typeof numeric === 'number' &&
      isLegacyMillisecondHookTimeout(numeric)
      ? `${effective} ms`
      : `${effective / 1000} s`;
  }
  const timeout = row.timeout;
  if (row.hookType === HookType.Http) {
    const seconds = timeout ? Number(timeout) : 600;
    return seconds > 0 ? `${seconds} s` : '∞';
  }
  if (typeof timeout !== 'number') return String(timeout);
  if (row.hookType === HookType.Function) return `${timeout} ms`;
  return `${timeout} s`;
}
