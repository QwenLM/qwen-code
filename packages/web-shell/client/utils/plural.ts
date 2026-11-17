/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

function toCount(count: string | number | undefined): number {
  const value = typeof count === 'number' ? count : Number(count ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/** English count plus its noun, pluralised the regular way. */
export function plural(
  count: string | number | undefined,
  noun: string,
): string {
  const safe = toCount(count);
  return `${safe} ${noun}${safe === 1 ? '' : 's'}`;
}

/**
 * Russian plural pick: 1 → `one`, 2–4 → `few`, otherwise → `many`, with the
 * 11–14 exception per decade (ход/ходов, токен/токенов, цель/целей).
 */
export function ruPlural(
  count: string | number | undefined,
  one: string,
  few: string,
  many: string,
): string {
  const safe = toCount(count);
  const last = safe % 10;
  const lastTwo = safe % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
