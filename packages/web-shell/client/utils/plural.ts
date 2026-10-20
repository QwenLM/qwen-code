/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** English count plus its noun, pluralised the regular way. */
export function plural(
  count: string | number | undefined,
  noun: string,
): string {
  const value = typeof count === 'number' ? count : Number(count ?? 0);
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe} ${noun}${safe === 1 ? '' : 's'}`;
}
