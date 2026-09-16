/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { HookType } from '@qwen-code/qwen-code-core/hooks/types.js';
import { isLegacyMillisecondHookTimeout } from '@qwen-code/qwen-code-core/hooks/hook-timeout.js';
import type { HooksListingRow } from '@qwen-code/qwen-code-core/hooks/hooks-listing.js';

/**
 * Timeout with its unit: function hooks count milliseconds, command hooks
 * still read 1000 or more as legacy milliseconds, everything else seconds.
 */
export function formatHookTimeout(
  row: Pick<HooksListingRow, 'timeout' | 'hookType'>,
): string {
  const timeout = row.timeout;
  if (typeof timeout !== 'number') return String(timeout);
  if (row.hookType === HookType.Function) return `${timeout} ms`;
  if (
    row.hookType === HookType.Command &&
    isLegacyMillisecondHookTimeout(timeout)
  ) {
    return `${timeout} ms`;
  }
  return `${timeout} s`;
}
