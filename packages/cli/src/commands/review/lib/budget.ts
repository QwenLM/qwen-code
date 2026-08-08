/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// How much review this diff is worth — derived from its size, recorded in the
// plan, read by everyone.
//
// The roster answers *which dimensions* a review owes and is deliberately
// size-blind: security is owed on a four-line diff exactly as on a four-hundred
// one. What the roster does not answer is *how much walking* the size-elastic
// parts of the run should do — the low tier's angle rotation, the optional
// domain specialists, the verifier's shard width. Those were flat constants, and
// a flat constant is wrong at both ends: seven inline walks over a nine-line
// typo fix is six walks of nothing, and "up to 2 specialists when a domain
// dominates" invites a domain-dominance ruling on a diff far too small to have
// one.
//
// Two properties, both borrowed from how `effort` already works here:
//
//  1. **It lives in the plan, not in a flag.** A budget the caller passes is a
//     budget the caller can inflate — and every reader (the orchestrator running
//     the angles, anything that later checks what was owed) must see the same
//     number, or they disagree about what the run promised.
//
//  2. **It never scales a *dimension* away.** Everything below tunes how much
//     the elastic parts do. No arm of it can drop a required agent: that is the
//     roster's job, the roster reads `effort`, and a size input must not become
//     a back door into shrinking coverage.

/** The size inputs the budget is derived from. */
export interface BudgetInput {
  /**
   * Diff lines in `source` files — the same number the topology gate turns on,
   * and for the same reason: test and prose lines inflate a diff without adding
   * anything for a reviewer to get wrong.
   */
  srcDiffLines: number;
  /** Total diff lines, including tests, prose and generated files. */
  diffLines: number;
}

export interface ReviewBudget {
  /**
   * How many of the low tier's directed angles to walk (Step 3C, A–F).
   *
   * Always at least 3, because the three that are always worth walking are the
   * ones defined by *how they walk* rather than by a topic — line-by-line,
   * removed behaviour, and the language's own pitfalls — and each is answerable
   * on a diff of any size. The rest earn their turn as there is more to see.
   */
  inlineAngles: number;
  /**
   * Does the low tier's gap sweep run?
   *
   * The sweep re-reads the diff as a fresh reviewer holding the deduplicated
   * list, hunting only for what is not on it. On a diff small enough to hold
   * entirely in view, a second reader of the same few hunks is the same reader:
   * there is no "what did the first pass not get to" when the first pass got to
   * all of it.
   */
  sweep: boolean;
  /**
   * The cap on Agent 8 diff-specialized finders (high effort only).
   *
   * Zero below the floor, and that is the substantive half of this field. A
   * specialist is launched when "one domain dominates the diff", which is a
   * judgement — and a judgement made about forty lines will find a dominant
   * domain every time, because forty lines are usually all one thing. Dominance
   * is only meaningful once there is enough code for a diff to have been about
   * several things and not be.
   */
  specialistCap: number;
  /**
   * Findings per Step 4 verification agent — `ceil(N / verifyShard)` agents.
   *
   * Flat by design; it is here so the number has one home rather than being
   * re-stated in the skill's prose and in whatever reads it. It is a property of
   * how much a verifier can re-trace before its quality collapses on the tail of
   * its list, which is a fact about the verifier and not about the diff.
   */
  verifyShard: number;
}

/**
 * Below this many source lines, a diff is small enough that a second pass over
 * it is the first pass again.
 */
const SWEEP_FLOOR = 25;

/** Below this, "one domain dominates the diff" is not a finding about the diff. */
const SPECIALIST_FLOOR = 80;

/** Source lines per additional inline angle, above the always-walk three. */
const LINES_PER_ANGLE = 60;

export const MIN_INLINE_ANGLES = 3;
export const MAX_INLINE_ANGLES = 6;
export const VERIFY_SHARD = 8;

/**
 * The review budget for a plan.
 *
 * Negative, non-finite and absent inputs all read as zero rather than throwing:
 * this is computed while a plan is being written, and a plan that fails to write
 * because a line count arrived as `NaN` costs the whole review, while a budget
 * that lands on its floor costs one under-walked small diff. It fails toward the
 * cheap end on purpose — the floors are the *minimum* work, not the maximum, so
 * a garbled input still walks three angles and still verifies.
 */
export function reviewBudget(input: BudgetInput): ReviewBudget {
  const src = sane(input.srcDiffLines);
  const total = sane(input.diffLines);

  // Size is read from source lines, with one exception: a diff that is *all*
  // non-source (a docs-only or lockfile-only change) still has lines somebody
  // has to read, and reading them with three angles when there are two thousand
  // of them is the dilution this budget exists to avoid. So a large non-source
  // diff earns angles too, at a much coarser rate — prose carries less that a
  // reviewer can get wrong, not none.
  const effective = Math.max(src, Math.floor(total / 8));

  const extraAngles = Math.floor(effective / LINES_PER_ANGLE);
  const inlineAngles = clamp(
    MIN_INLINE_ANGLES + extraAngles,
    MIN_INLINE_ANGLES,
    MAX_INLINE_ANGLES,
  );

  return {
    inlineAngles,
    sweep: effective >= SWEEP_FLOOR,
    specialistCap: src >= SPECIALIST_FLOOR ? 2 : 0,
    verifyShard: VERIFY_SHARD,
  };
}

function sane(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
