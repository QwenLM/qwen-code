/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The submit receipt is the WRITE half of cleanup's bypass-audit contract:
// `submit` records the review ids it was authorised to create, and `cleanup`
// reads them to tell a sanctioned review from a bypass. Both sides parse the
// same on-disk shape, so the parse lives here — a schema change (new field,
// renamed key) is a single edit both call sites inherit, rather than two
// implementations that must be kept in lockstep.

/**
 * The review ids a receipt vouches for. Accepts the current
 * `reviewIds: number[]` shape and migrates a legacy single `reviewId` a
 * receipt written by an older CLI carries. Never throws: a malformed shape
 * yields an empty list, and the caller decides what an empty list means.
 */
export function parseReceiptIds(raw: string): number[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  // `JSON.parse('null')` (and any non-object) succeeds but has no fields to
  // read — dereferencing it would throw, breaking the "never throws"
  // contract callers may rely on.
  if (value === null || typeof value !== 'object') return [];
  const parsed = value as { reviewIds?: unknown; reviewId?: unknown };
  const ids = Array.isArray(parsed.reviewIds)
    ? parsed.reviewIds
    : typeof parsed.reviewId === 'number'
      ? [parsed.reviewId]
      : [];
  return ids.filter((n): n is number => typeof n === 'number');
}
