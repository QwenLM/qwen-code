/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Money helpers for the acceptance checks. Every comparison happens in integer
 * cents so floating-point rounding in a generated view cannot hide or invent a
 * lost cent.
 */

/**
 * Reads every money amount in a text, tolerating currency symbols and codes,
 * thousands separators and full-width digits. Returns integer cents.
 */
export function parseAmounts(text: string): number[] {
  const normalized = text
    .replace(/[\uFF10-\uFF19]/g, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
    )
    .replace(/[\uFF0E]/g, '.')
    .replace(/(\d)[,\s\u00A0\u202F](?=\d{3}(?:\D|$))/g, '$1');
  const amounts: number[] = [];
  for (const match of normalized.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const value = Number(match[0]);
    if (Number.isFinite(value)) amounts.push(Math.round(value * 100));
  }
  return amounts;
}

/** The single amount in a text, or `undefined` when there is not exactly one. */
export function parseSingleAmount(text: string): number | undefined {
  const amounts = parseAmounts(text);
  return amounts.length === 1 ? amounts[0] : undefined;
}

/** The last amount in a text, for labels such as "Person 3: 137.84". */
export function parseLastAmount(text: string): number | undefined {
  const amounts = parseAmounts(text);
  return amounts.length ? amounts[amounts.length - 1] : undefined;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

/** Rounds half away from zero to whole cents. */
export function roundCents(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value) + Number.EPSILON);
}

/**
 * Splits a total in cents across `people`, giving the leftover cents to the
 * first shares, so shares differ by at most one cent and sum to the total.
 */
export function splitCents(total: number, people: number): number[] {
  const base = Math.floor(total / people);
  const remainder = total - base * people;
  return Array.from({ length: people }, (_, index) =>
    index < remainder ? base + 1 : base,
  );
}
