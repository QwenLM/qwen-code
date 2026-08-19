/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Is this review loop converging, and if not, why?
//
// A push-triggered review plus an agent addressing its findings is a feedback
// loop, and the loop's gain can exceed 1: every accepted fix widens the diff,
// the next round reviews more code, and more findings come back. Measured on
// this repository, PRs have carried hundreds of open threads and still not
// settled — one closed unmerged at ~500.
//
// The damper the pipeline already has is the round-adaptive posting floor, but
// nothing tells the humans WHY a particular loop is not settling. This module
// answers that from facts the round already holds, and it answers only that:
// it states what it measured and what the shapes usually mean, and it makes no
// decision. Whether to keep fixing, restructure, split or land is the author's
// and the operator's call — the skill holds advisory power, never decision
// power, so nothing here withholds a finding, caps a verdict, or changes what
// the round posts.
//
// Every trigger is a comparison between THIS pull request's own rounds. There
// is no threshold, no "too many comments" number: a volume bar is somebody's
// policy, and a policy the tool owns is a policy the tool would have to defend
// on repositories it knows nothing about. A PR diverging at 40 comments
// deserves the reading that a threshold of 100 would have delayed, and a large
// review whose findings are shrinking deserves no interruption at all.

import {
  LEDGER_BODY_FILE,
  LEDGER_ID_TOKEN,
  LEDGER_UNKNOWN_FILE,
  type LedgerFinding,
} from './ledger.js';
import { mdField } from './md-field.js';

/** The id grammar, anchored so a cross-reference in prose cannot match. */
const ID_HEAD = new RegExp(`^(${LEDGER_ID_TOKEN})`);

/** The round an id was minted in, or undefined when the id is not one. */
function birthRound(id: unknown): number | undefined {
  if (typeof id !== 'string') return undefined;
  const m = ID_HEAD.exec(id.trim());
  if (!m) return undefined;
  const round = Number(m[1].slice(1).split('-')[0]);
  return Number.isInteger(round) && round > 0 ? round : undefined;
}

/** A file this round and earlier rounds both produced findings in. */
export interface RecurrenceCluster {
  file: string;
  /**
   * Rounds that already reported a finding here, ascending — read off the
   * carried ledger ids (`R<round>-<n>`), which is why they are the rounds the
   * REPORT used rather than a count this module invents.
   */
  priorRounds: number[];
  /** How many of this round's drafted comments land in this file. */
  thisRound: number;
}

/**
 * One of this round's drafted comments, as far as the diagnosis needs it.
 *
 * The carried id is what separates NEW activity from a still-standing finding
 * the round re-posts. Step 6 re-posts every unfixed ledger Critical under its
 * ORIGINAL id, so a single Critical nobody has fixed yet arrives in
 * `drafts` every round: counted as activity it fires both signals forever —
 * a cluster that gains "1 more now" with no new finding ever appearing, and a
 * flat volume trend — which is the steady state, not divergence.
 */
export interface DraftedFinding {
  /** The path this comment anchors to; empty when it has none. */
  file: string;
  /**
   * The ledger id the body carries when it re-posts an earlier round's
   * finding, as the shared readback extracted it. Absent on a fresh finding,
   * which has no id until this round's ledger is built.
   */
  carriedId?: string;
}

/** What the previous round left behind, and how far it can be trusted. */
export interface PrevRound {
  /** Inline comments the previous round posted, when it recorded the number. */
  posted?: number;
  /** Its work list, as the side file recovered it. */
  findings: readonly LedgerFinding[];
  /**
   * Its marker shed findings to fit the ledger's byte budget, so the list is
   * known-incomplete. Measured at up to 35 shed per round on the worst PRs
   * this feature targets — exactly the loops the diagnosis speaks to, so the
   * undercount is disclosed rather than presented as a full count.
   */
  truncated?: boolean;
  /**
   * The marker it came from was not posted by this account. Recovery adopts
   * the highest-round marker whoever posted it, so the round numbers a
   * cluster cites can name rounds this account never ran. Disclosed rather
   * than dropped: the citation is still the best evidence available, and a
   * reader who knows where it came from can check it.
   */
  foreign?: boolean;
}

export interface ConvergenceDiagnosis {
  /** The round being composed. */
  round: number;
  /** Inline comments this round posts, and the previous round's when known. */
  posted: number;
  prevPosted?: number;
  /** Files that carried findings before and carry more now. */
  clusters: RecurrenceCluster[];
  /** True when this round's volume did not fall below the previous round's. */
  volumeNotShrinking: boolean;
  /** Carried through from `PrevRound` so the rendering can disclose them. */
  truncatedEvidence: boolean;
  foreignEvidence: boolean;
  /**
   * The posting floor this round resolved to is already `critical`. The
   * handling advice is matched to the telemetry's shape, so it must not
   * recommend a posture the round is running under as it says it.
   */
  criticalFloorInEffect: boolean;
}

/** Pseudo-paths that name no file and therefore cannot cluster. */
const PSEUDO_PATHS: ReadonlySet<string> = new Set([
  LEDGER_BODY_FILE,
  LEDGER_UNKNOWN_FILE,
]);

/**
 * The diagnosis for this round, or null when the loop looks healthy.
 *
 * Two signals, either of which fires it, and both are self-comparisons:
 *
 * - **Recurrence.** A file that carried a finding in an earlier round and
 *   carries a NEW one now. Joined by FILE, deterministically — no model
 *   judgement, no similarity scoring. Title similarity was considered and
 *   dropped: the titles are model-written and capped at 80 characters, which
 *   makes them noise at exactly the length where a match would matter. A
 *   cluster that keeps regenerating siblings usually means the fixes are
 *   treating instances of a shared root cause, and that sentence is the whole
 *   value here.
 * - **Volume not shrinking.** From round 3, this round posting at least as
 *   many comments as the previous one. Round 3 because two rounds give one
 *   step and a step is not a trend; and "not shrinking" rather than "growing"
 *   because a loop holding steady is not converging either.
 *
 * Both signals read FRESH drafts only. A re-posted still-standing finding is
 * the loop holding its position, not the loop generating work, and counting
 * it as activity fires both signals on the calmest shape there is (see
 * `DraftedFinding`).
 *
 * Returns null — not an empty diagnosis — when neither fires, so a caller
 * cannot accidentally render a section that says nothing. Absent inputs make
 * a signal impossible to evaluate rather than true: a round with no recovered
 * predecessor has no volume to compare against, and one with no previous work
 * list has no recurrence to find.
 */
export function diagnoseConvergence(input: {
  round: number;
  posted: number;
  prev: PrevRound;
  /** This round's drafted comments. */
  drafts: readonly DraftedFinding[];
  criticalFloorInEffect?: boolean;
}): ConvergenceDiagnosis | null {
  const priorByFile = new Map<string, Set<number>>();
  for (const f of input.prev.findings) {
    if (typeof f?.file !== 'string' || f.file.trim() === '') continue;
    // A body-only Critical carries no real path; it cannot cluster.
    if (PSEUDO_PATHS.has(f.file)) continue;
    const round = birthRound(f.id);
    if (round === undefined) continue;
    const set = priorByFile.get(f.file) ?? new Set<number>();
    set.add(round);
    priorByFile.set(f.file, set);
  }

  // Fresh: not a re-post of a finding minted in an earlier round. An id this
  // round would mint is not "earlier", so the comparison is strict.
  const fresh = input.drafts.filter((d) => {
    const minted = birthRound(d?.carriedId);
    return minted === undefined || minted >= input.round;
  });

  const thisByFile = new Map<string, number>();
  for (const d of fresh) {
    const p = d?.file;
    if (typeof p !== 'string' || p.trim() === '') continue;
    if (PSEUDO_PATHS.has(p)) continue;
    thisByFile.set(p, (thisByFile.get(p) ?? 0) + 1);
  }

  const clusters: RecurrenceCluster[] = [];
  for (const [file, count] of thisByFile) {
    const prior = priorByFile.get(file);
    if (!prior || prior.size === 0) continue;
    clusters.push({
      file,
      priorRounds: [...prior].sort((a, b) => a - b),
      thisRound: count,
    });
  }
  // Deterministic order: the most persistent cluster first, then the
  // busiest this round, then the path — so two runs over the same facts
  // render the same paragraph. The path tie-break compares CODE UNITS, not
  // `localeCompare`: collation follows the runtime locale, and the clustered
  // paths belong to whatever repository is under review, so a locale change
  // between the CI bot's round and a maintainer's round would otherwise
  // reorder tied non-ASCII paths and break the invariant this sort states.
  clusters.sort(
    (a, b) =>
      b.priorRounds.length - a.priorRounds.length ||
      b.thisRound - a.thisRound ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  );

  // A round that produced NO fresh finding is the observation a convergence
  // trend most wants, not a symptom: zero new work is where a settling loop
  // lands, and `0 >= 0` would otherwise narrate "the volume is not falling"
  // at exactly the moment it has finished falling. The guard subsumes the
  // zero-posting case — a round with no drafts has no fresh drafts either —
  // and additionally covers the round whose whole output is carried re-posts.
  //
  // `prevPosted > 0` for the mirror reason on the other end: a trend measured
  // against a zero predecessor is `N >= 0`, true for every N, so restarting
  // from a settled round would fire on the healthiest shape there is (fix
  // everything, settle at zero, push again, get new findings).
  const volumeNotShrinking =
    input.round >= 3 &&
    input.prev.posted !== undefined &&
    input.prev.posted > 0 &&
    fresh.length > 0 &&
    input.posted >= input.prev.posted;

  if (clusters.length === 0 && !volumeNotShrinking) return null;
  return {
    round: input.round,
    posted: input.posted,
    ...(input.prev.posted === undefined
      ? {}
      : { prevPosted: input.prev.posted }),
    clusters,
    volumeNotShrinking,
    truncatedEvidence: input.prev.truncated === true,
    foreignEvidence: input.prev.foreign === true,
    criticalFloorInEffect: input.criticalFloorInEffect === true,
  };
}

/** How many clusters the rendered paragraph names before summarising. */
export const MAX_RENDERED_CLUSTERS = 3;

/**
 * The diagnosis as the two sentences a human reads: what was measured, and
 * what that shape usually means.
 *
 * Facts first and separately, because the facts are certain and the reading
 * is not. Where the evidence itself is qualified — a truncated work list, one
 * recovered from another account's marker — the qualification is stated in
 * the same paragraph rather than left for the reader to discover, matching
 * the PARTIAL disclosure `pr-context` already renders for the same data.
 *
 * The recommendations are process-level on purpose — triage the cluster,
 * split it out, stem the posting surface, batch the fixes — and never a
 * code-architecture prescription: this module cannot verify a claim about how
 * the code should be restructured, and an unverifiable claim is exactly what
 * the rest of this pipeline refuses to post.
 */
export function renderConvergenceDiagnosis(d: ConvergenceDiagnosis): {
  en: string;
  zh: string;
} {
  const shown = d.clusters.slice(0, MAX_RENDERED_CLUSTERS);
  const more = d.clusters.length - shown.length;
  // Every path here is PR-controlled and goes out in a body this bot posts
  // under its own identity — `mdField`, never hand-spelled backticks.
  const clusterEn = shown
    .map(
      (c) =>
        `${mdField(c.file)} (findings in round${c.priorRounds.length > 1 ? 's' : ''} ${c.priorRounds.join(', ')}, ${c.thisRound} more now)`,
    )
    .join('; ');
  const clusterZh = shown
    .map(
      (c) =>
        `${mdField(c.file)}（第 ${c.priorRounds.join('、')} 轮已出过发现，本轮又有 ${c.thisRound} 条）`,
    )
    .join('；');

  const factsEn = [
    `round ${d.round} posted ${d.posted} inline comment(s)`,
    d.prevPosted === undefined
      ? null
      : `the previous round posted ${d.prevPosted}`,
  ]
    .filter(Boolean)
    .join('; ');
  const factsZh = [
    `第 ${d.round} 轮发布了 ${d.posted} 条行内评论`,
    d.prevPosted === undefined ? null : `上一轮发布了 ${d.prevPosted} 条`,
  ]
    .filter(Boolean)
    .join('；');

  const reasonEn =
    d.clusters.length > 0
      ? `Findings keep coming back to the same files: ${clusterEn}${more > 0 ? `, and ${more} more file(s)` : ''}.`
      : `The posting volume is not falling.`;
  const reasonZh =
    d.clusters.length > 0
      ? `发现反复回到同一批文件：${clusterZh}${more > 0 ? `，另有 ${more} 个文件` : ''}。`
      : `发布量没有下降。`;

  // Only the recurrence reading cites the previous work list, so only it can
  // be qualified by how that list was obtained.
  const caveatsEn: string[] = [];
  const caveatsZh: string[] = [];
  if (d.clusters.length > 0) {
    if (d.truncatedEvidence) {
      caveatsEn.push(
        `the previous round's work list was truncated to fit the marker, so the rounds named above may be an undercount`,
      );
      caveatsZh.push(`上一轮的工作清单为放进标记而被截断，上述轮次可能少计`);
    }
    if (d.foreignEvidence) {
      caveatsEn.push(
        `it was recovered from a marker this account did not post, so those rounds may not be this account's own`,
      );
      caveatsZh.push(
        `该清单来自并非本账号发布的标记，上述轮次可能不属于本账号`,
      );
    }
  }
  const caveatEn =
    caveatsEn.length > 0 ? ` (Evidence: ${caveatsEn.join('; ')}.)` : '';
  const caveatZh =
    caveatsZh.length > 0 ? `（证据说明：${caveatsZh.join('；')}。）` : '';

  // The floor recommendation is dropped once the floor already resolves to
  // `critical`: advising a posture the round is running under, inside the
  // very body whose floor-enforcement note says so, reads as advice nobody
  // checked.
  const floorEn = d.criticalFloorInEffect
    ? `Batching the remaining fixes and verifying them before the next push keeps the loop from re-deriving the same set; this PR's reviews are already at \`--severity-floor critical\`.`
    : `Batching the remaining fixes and verifying them before the next push, or dropping this PR's reviews to \`--severity-floor critical\`, keeps the loop from re-deriving the same set.`;
  const floorZh = d.criticalFloorInEffect
    ? `把剩余修复攒成一批、验证后再推送，可以避免循环反复推导同一组发现；本 PR 的评审已处于 \`--severity-floor critical\`。`
    : `把剩余修复攒成一批、验证后再推送，或将本 PR 的评审降到 \`--severity-floor critical\`，可以避免循环反复推导同一组发现。`;

  const adviceEn =
    d.clusters.length > 0
      ? `A cluster that keeps producing siblings usually means the fixes are treating instances of a shared root cause — triaging that cause before the next round, or splitting an independent cluster into its own pull request, tends to end the loop faster than fixing them one at a time.`
      : floorEn;
  const adviceZh =
    d.clusters.length > 0
      ? `一个不断再生兄弟发现的簇，通常意味着逐条修复只在处理同一根因的实例——先定位并处理该根因，或把独立的簇拆成单独的 PR，通常比逐条修复更快结束循环。`
      : floorZh;

  // The closing claim is scoped to THIS observation, not to the review: the
  // same body can carry a floor-enforcement note, a deferral list, or a
  // discarded-Suggestion count — all of them things withheld from this
  // round's posting surface. An absolute "nothing was withheld" beside those
  // is a sentence the body itself refutes.
  return {
    en: `Convergence: ${factsEn}. ${reasonEn}${caveatEn} ${adviceEn} (Observation only — nothing was withheld from this review because of this observation.)`,
    zh: `收敛情况：${factsZh}。${reasonZh}${caveatZh}${adviceZh}（仅为观察——本轮评审未因此扣留任何内容。）`,
  };
}
