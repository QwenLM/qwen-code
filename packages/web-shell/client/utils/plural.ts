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

/**
 * Arabic plural pick following CLDR cardinal rules:
 * 0 → `zero`, 1 → `one`, 2 → `two`, n%100 in 3..10 → `few`,
 * n%100 in 11..99 → `many`, otherwise (100+, decimals, abbreviated strings) → `other`.
 */
export function arPlural(
  count: string | number | undefined,
  zero: string,
  one: string,
  two: string,
  few: string,
  many: string,
  other: string,
): string {
  const value = typeof count === 'number' ? count : Number(count ?? 0);
  if (!Number.isFinite(value)) return other;
  if (value === 0) return zero;
  if (value === 1) return one;
  if (value === 2) return two;
  const mod100 = value % 100;
  if (Number.isInteger(value)) {
    if (mod100 >= 3 && mod100 <= 10) return few;
    if (mod100 >= 11 && mod100 <= 99) return many;
  }
  return other;
}
