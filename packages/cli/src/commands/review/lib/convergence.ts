/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Persistently-critical loop detection — the convergence exit the severity
// floor cannot provide (#9410).
//
// The floor (round 6 onward, or an explicit `critical` floor) removes
// Suggestions from posting, so a healthy loop's posting volume shrinks to its
// Criticals and then to zero as those Criticals get fixed. But a loop whose
// Criticals never clear — the security-sensitive PR under adversarial review
// that PR 9226 ran for twelve rounds — posts Criticals every round forever:
// the floor engages, the Suggestions stop, and the volume flatlines at the
// Critical count instead of falling. The floor has done its job and the loop
// STILL does not converge, and nothing before this module said so.
//
// This module names that shape. It is DATA the operator rules on, never
// authority: it computes one fact from the carried telemetry (Criticals in
// the previous round's work-list AND this round, with the two-round posting
// window not shrinking) and, when it fires, surfaces the ONE recommendation
// that fits — `land-with-residual-risk`, merge and accept the residual risk.
// It decides nothing: it cannot block a post, cannot merge, cannot close, and
// holds no numeric threshold (the "two-round window" is the shortest one the
// ledger's own `posted`/`prevPosted` pair can express, not a tuned constant).
// Every input degrades OPEN — a missing volume or an unrecovered previous
// round costs a missed advisory, never a false one and never a changed post.

/**
 * The facts the signal reads, all carried by the compose boundary — nothing
 * here reads a file or asks the model.
 *
 * `prevHadCritical` is `undefined` (not `false`) when no previous round was
 * recovered: "no prior work-list" is not "the previous round had no
 * Criticals", and conflating them would fire the signal on a second round
 * that merely introduced its first Critical.
 */
export interface ConvergenceFacts {
  /** Did the PREVIOUS round's carried work-list hold a Critical? */
  prevHadCritical: boolean | undefined;
  /** Critical findings THIS round posts (inline + body-only). */
  thisCriticals: number;
  /** THIS round's posting volume (inline comments it sends). */
  posted: number | undefined;
  /** The PREVIOUS round's posting volume (the ledger's two-round window). */
  prevPosted: number | undefined;
}

/** The one shape this module detects. */
export type ConvergenceShape = 'persistently-critical';

/**
 * The one recommendation that fits a persistently-critical loop. Spelled as
 * a stable code because the operator's tooling keys on it: it names the exit
 * (land — merge — with the residual risk accepted), never an action the tool
 * takes itself.
 */
export const LAND_WITH_RESIDUAL_RISK = 'land-with-residual-risk';

/** The fired assessment, all fields pure facts about the loop. */
export interface ConvergenceAssessment {
  shape: ConvergenceShape;
  recommendation: typeof LAND_WITH_RESIDUAL_RISK;
  /** Critical findings this round posts — what the residual inventory covers. */
  criticals: number;
  /** This round's posting volume. */
  posted: number;
  /** The previous round's posting volume. */
  prevPosted: number;
}

/**
 * Detect the persistently-critical shape, or return null when the loop is not
 * (provably) in it.
 *
 * Fires only on the conjunction, and every conjunct degrades open:
 *  - the previous round's work-list held a Critical (`prevHadCritical ===
 *    true` — an UNrecovered previous round is `undefined` and suppresses the
 *    signal, so a second round introducing its first Critical cannot read as
 *    "persistent");
 *  - this round posts at least one Critical;
 *  - the two-round posting window is present and NOT shrinking — both volumes
 *    recorded, and this round's at least the previous round's. A falling
 *    volume is a converging loop even with Criticals present (they are being
 *    worked down), and a missing volume says nothing, so both fail open.
 *
 * No threshold anywhere: "not shrinking" is `posted >= prevPosted` over the
 * shortest window the ledger carries, and "persistent" is two consecutive
 * rounds with Criticals — the minimum evidence for each claim, derived from
 * the carried telemetry, never tuned.
 */
export function convergenceAssessment(
  facts: ConvergenceFacts,
): ConvergenceAssessment | null {
  const { prevHadCritical, thisCriticals, posted, prevPosted } = facts;
  if (prevHadCritical !== true) return null;
  if (thisCriticals <= 0) return null;
  if (posted === undefined || prevPosted === undefined) return null;
  if (posted < prevPosted) return null;
  return {
    shape: 'persistently-critical',
    recommendation: LAND_WITH_RESIDUAL_RISK,
    criticals: thisCriticals,
    posted,
    prevPosted,
  };
}

/**
 * The advisory sentence, bilingual — one rendering shared by the body clause
 * and the terminal line so the two surfaces cannot drift. Pure facts plus the
 * recommendation code; it names the exit, then disclaims itself: advisory
 * only, blocks nothing. The residual-risk inventory is scaffolded as a blank
 * three-column table (attack surface · attacker-dependency · blast radius)
 * for the maintainer to complete — the tool cannot judge those dimensions,
 * and a scaffold it pre-filled would be a verdict it has no authority to
 * make. Bounded by construction: fixed prose plus a count, no model text.
 */
export function convergenceAdvisory(a: ConvergenceAssessment): {
  en: string;
  zh: string;
} {
  const en =
    `Convergence: this loop is persistently critical — Criticals stood in the ` +
    `previous round's work-list and stand again this round (${a.criticals} ` +
    `Critical(s)), and the posting volume is not shrinking (this round ` +
    `${a.posted}, previous ${a.prevPosted}). The severity floor will not ` +
    `converge it. Recommendation: \`${a.recommendation}\` — the exit is a ` +
    `maintainer risk-acceptance decision (merge, carrying the residual risk), ` +
    `not another review round. Residual-risk inventory for that decision ` +
    `(maintainer to complete):\n\n` +
    `| standing Critical | attack surface | attacker-dependency | blast radius |\n` +
    `| --- | --- | --- | --- |\n` +
    `| (each standing Critical) | … | … | … |\n\n` +
    `Advisory only — it does not block this review.`;
  const zh =
    `收敛：本循环处于 persistently-critical 形态——上一轮工作清单中的 Critical ` +
    `本轮依然存在（本轮 ${a.criticals} 条 Critical），且发布音量未收缩（本轮 ` +
    `${a.posted}，上一轮 ${a.prevPosted}）。severity floor 无法使其收敛。` +
    `建议：\`${a.recommendation}\`——出口是 maintainer 的风险接受决定（合入并` +
    `承担残余风险），而非再开一轮评审。供该决定使用的残余风险清单（maintainer 填写）：` +
    `按每条未决 Critical 列出「攻击面 · 攻击者依赖性 · 影响范围」三栏。` +
    `仅为建议——不阻断本次评审。`;
  return { en, zh };
}
