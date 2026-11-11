/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Only accepts values that are already numbers. */
export function readNumberStrict(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export const REASONING_EFFORT_LEVELS = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];

const VALID_EFFORT_LEVELS: ReadonlySet<string> = new Set(
  REASONING_EFFORT_LEVELS,
);

const REASONING_EFFORT_ALIASES: ReadonlyMap<string, ReasoningEffortLevel> =
  new Map([
    ['disabled', 'none'],
    ['off', 'none'],
  ]);

export function parseReasoningEffortLevel(
  value: unknown,
): ReasoningEffortLevel | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase().trim();
  const alias = REASONING_EFFORT_ALIASES.get(normalized);
  if (alias) return alias;
  return VALID_EFFORT_LEVELS.has(normalized)
    ? (normalized as ReasoningEffortLevel)
    : undefined;
}
export function reasoningEffortFromThinkingBudget(
  budget: number | undefined,
): ReasoningEffortLevel | undefined {
  if (budget === undefined) return undefined;
  if (budget <= 0) return 'none';
  if (budget <= 1024) return 'low';
  if (budget <= 8192) return 'medium';
  if (budget <= 24576) return 'high';
  if (budget <= 49152) return 'xhigh';
  return 'max';
}

/** Accepts numbers and numeric strings, coercing strings to numbers. */
export function readNumberCoerce(value: unknown): number | undefined {
  if (typeof value === 'number')
    return !Number.isFinite(value) ? undefined : value;
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized === '') return undefined;
    const n = Number(normalized);
    return !Number.isFinite(n) ? undefined : n;
  }
  return undefined;
}

/** Coerces to integer, truncating decimals. */
export function readIntegerCoerce(value: unknown): number | undefined {
  const n = readNumberCoerce(value);
  return n !== undefined ? Math.trunc(n) : undefined;
}

/** Only accepts values that are already non-negative integers. */
export function readNonNegativeInteger(value: unknown): number | undefined {
  const number = readNumberStrict(value);
  return number !== undefined && Number.isInteger(number) && number >= 0
    ? number
    : undefined;
}

/** Only accepts values that are already finite, non-negative numbers. */
export function readNonNegativeNumber(value: unknown): number | undefined {
  const number = readNumberStrict(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

/** Only accepts values that are already non-empty strings. */
export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Accepts any string, including the empty string. Use this instead of
 * {@link readString} when `''` carries meaning of its own and must be
 * distinguished from an absent value.
 */
export function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Checks if value is a plain object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
