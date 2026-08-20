/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ForkRecord } from './forkTranscript.js';

/** Typed rejection reasons for {@link resolveTurn}. */
export type ResolveTurnError = 'invalid_turn' | 'rewind_not_applicable';

/**
 * A resolved turn boundary: `targetTurnIndex` is the 0-indexed count of
 * user turns to keep (the same number the route maps onto a daemon rewind
 * snapshot); `addressableTurnCount` is the total number of addressable user
 * turns — `targetTurnIndex === addressableTurnCount` means `toTurn` addressed
 * the tip (no truncation); `truncatedEventId` is a record-ARRAY index into
 * the same `records` this function was called with — the same "slice
 * boundary" convention `routes/fork.ts`'s `fromEventId` already uses
 * (`records.slice(0, truncatedEventId)` keeps exactly the records before
 * the target turn).
 */
export interface ResolvedTurn {
  targetTurnIndex: number;
  addressableTurnCount: number;
  truncatedEventId: number;
}

export type ResolveTurnResult =
  | ({ ok: true } & ResolvedTurn)
  | { ok: false; error: ResolveTurnError };

/**
 * Resolve a 0-indexed user-turn number to the coordinates both rewind and
 * turn-addressed fork need. A "turn" is a `type: 'user'` record; `toTurn: 0`
 * means "the state before any user turn" (an empty/preamble-only slice);
 * `toTurn: N` (1 <= N <= addressable turn count) means "keep the first N
 * user turns". `toTurn` equal to the addressable turn count addresses the
 * tip (no truncation at all).
 *
 * Turns at or before the LAST `{ type: 'system', subtype: 'chat_compression'
 * }` checkpoint are not addressable — core's own `reconstructHistory`
 * (packages/core/src/services/sessionService.ts) only rebuilds history from
 * after that checkpoint, so nothing before it can be faithfully rewound to.
 * This collapses the design's two rejection cases ("beyond tip" and "inside
 * a compression checkpoint") into one bound check: `toTurn` only ever
 * indexes ADDRESSABLE (post-checkpoint) turns, so anything past the last
 * addressable turn is uniformly `rewind_not_applicable`.
 *
 * Pure and synchronous — never touches the filesystem or the daemon.
 */
export function resolveTurn(
  records: readonly ForkRecord[],
  toTurn: unknown,
): ResolveTurnResult {
  if (typeof toTurn !== 'number' || !Number.isInteger(toTurn) || toTurn < 0) {
    return { ok: false, error: 'invalid_turn' };
  }

  let checkpointIdx = -1;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r['type'] === 'system' && r['subtype'] === 'chat_compression') {
      checkpointIdx = i;
    }
  }

  const userTurnIndices: number[] = [];
  for (let i = checkpointIdx + 1; i < records.length; i++) {
    if (records[i]!['type'] === 'user') {
      userTurnIndices.push(i);
    }
  }

  if (toTurn > userTurnIndices.length) {
    return { ok: false, error: 'rewind_not_applicable' };
  }

  const truncatedEventId =
    toTurn === userTurnIndices.length
      ? records.length
      : userTurnIndices[toTurn]!;

  return {
    ok: true,
    targetTurnIndex: toTurn,
    addressableTurnCount: userTurnIndices.length,
    truncatedEventId,
  };
}
