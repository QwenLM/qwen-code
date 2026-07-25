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
  let parsed: { reviewIds?: unknown; reviewId?: unknown };
  try {
    parsed = JSON.parse(raw) as { reviewIds?: unknown; reviewId?: unknown };
  } catch {
    return [];
  }
  const ids = Array.isArray(parsed.reviewIds)
    ? parsed.reviewIds
    : typeof parsed.reviewId === 'number'
      ? [parsed.reviewId]
      : [];
  return ids.filter((n): n is number => typeof n === 'number');
}
