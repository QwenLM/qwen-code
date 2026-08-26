/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The plan-time reading of the round's posting posture (#10104).
//
// The posting floor itself resolves at compose time, where the previous
// posted round's number is in hand (`floorResolvesCritical`). But by then
// the round's SHAPE is spent: a re-review that was always going to post
// Criticals only has already run the full territory fan-out and the
// full-width reverse-audit waves over territory whose sub-Critical yield the
// floor defers wholesale. Measured on one long-lived PR, that shape cost a
// 3h13m round whose entire finder fan-out contributed nothing postable.
//
// So the capture command predicts the resolution from the same facts compose
// will read — the CLI-recorded invocation floor and the side file
// `pr-context` persisted — and predicts ONLY off the monotone arms, so the
// prediction cannot outrun the resolution:
//
// - an explicit/configured `critical` floor resolves `critical` at compose
//   unconditionally;
// - the round arm (`thisRound >= CRITICAL_FLOOR_ROUND`) reads the side
//   file's round, which is exactly what compose's `prevRound` reads, and
//   rounds only grow;
// - the flat-trend arm reads the recorded streak: at or past
//   `FLAT_STREAK_TO_ENGAGE` compose's latch holds engagement on the recorded
//   value alone ("the pin is the latch"), so a streak at the bar today is a
//   floor resolved `critical` at compose.
//
// What it deliberately does NOT predict: a streak one measurement short of
// the bar (compose may advance it this round — this prediction stays
// conservative and the round keeps the full shape), and this round's own
// explicit `--severity-floor suggestion`, which reaches this reading through
// the same recorded invocation and turns the posture off. Every doubt state
// — no side file, an unreadable one, a round it cannot place — reads as "no
// posture", which is the ordinary full round.
//
// The alignment is closed from the other side too: the plan record this
// prediction produces is itself an arm of compose's floor resolution
// (`floorResolvesCritical`'s fix-audit arm), so even where compose cannot
// re-derive the arms this read predicted from — a context-unavailable
// round, a side file rewritten in between — the posting bar follows the
// shape the round already ran, and an explicit `suggestion` floor at
// compose still wins.

import { streakOf } from './ledger.js';

/**
 * The `auto` floor's round schedule: from this round on it resolves
 * `critical`. One constant shared by compose's resolution and the capture
 * command's prediction, so the two cannot disagree about the schedule.
 */
export const CRITICAL_FLOOR_ROUND = 6;

/**
 * How many consecutive rounds of a not-falling first-time-finding rate
 * engage the severity floor ahead of the round-6 schedule (#9903).
 *
 * Two: one flat round is a step, two is the shortest window in which "the
 * rate is not falling" is an observation rather than a single step. The bar
 * is read off the ledger's `flatRounds` streak, which a round advances when
 * its OWN measured trend fires and resets when it falls — so reaching it
 * always takes two measured firing rounds; a carried or pinned streak never
 * adds. (Moved here from `compose-review` so the plan-time prediction and
 * the compose-time latch read one bar.)
 */
export const FLAT_STREAK_TO_ENGAGE = 2;

/** Why the capture resolved the critical posture, for the plan's record. */
export type CriticalPostureCause = 'explicit' | 'round' | 'flat-trend';

/**
 * Resolve the round's posture at capture time, or null for the full shape.
 *
 * `recordedFloor` is the invocation's floor as `recordedSeverityFloor`
 * recovered it from the CLI-written args record — `undefined` when nothing
 * was recorded (the `auto` default). `sideLedger` is the parsed side file
 * `pr-context` wrote (`qwen-review-pr-<n>-prev-ledger.json`), `null` when
 * absent or unreadable; it is the same untrusted shape compose's own
 * recovery reads, so the round and streak take the same clamps.
 */
export function resolveCriticalPosture(input: {
  recordedFloor?: string;
  sideLedger: unknown;
}): CriticalPostureCause | null {
  if (input.recordedFloor === 'suggestion') return null;
  if (input.recordedFloor === 'critical') return 'explicit';
  const prev = input.sideLedger;
  if (typeof prev !== 'object' || prev === null) return null;
  const rec = prev as { round?: unknown; flatRounds?: unknown };
  const round =
    typeof rec.round === 'number' && Number.isInteger(rec.round) && rec.round > 0
      ? rec.round
      : 0;
  if (round === 0) return null;
  if (round + 1 >= CRITICAL_FLOOR_ROUND) return 'round';
  // Clamped to the honest maximum exactly as compose's read is: the signal
  // that advances the streak gates on round >= 3, so at round N no honest
  // run carries more than N - 2, and a planted file claiming more would
  // engage the posture off rounds the signal never measured.
  const flat = Math.min(streakOf(rec.flatRounds) ?? 0, Math.max(round - 2, 0));
  return flat >= FLAT_STREAK_TO_ENGAGE ? 'flat-trend' : null;
}
