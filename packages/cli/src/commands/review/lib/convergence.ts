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

import { LEDGER_ID_TOKEN, type LedgerFinding } from './ledger.js';

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
}

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

/**
 * The diagnosis for this round, or null when the loop looks healthy.
 *
 * Two signals, either of which fires it, and both are self-comparisons:
 *
 * - **Recurrence.** A file that carried a finding in an earlier round and
 *   carries more now. Joined by FILE, deterministically — no model judgement,
 *   no similarity scoring. Title similarity was considered and dropped: the
 *   titles are model-written and capped at 80 characters, which makes them
 *   noise at exactly the length where a match would matter. A cluster that
 *   keeps regenerating siblings usually means the fixes are treating
 *   instances of a shared root cause, and that sentence is the whole value
 *   here.
 * - **Volume not shrinking.** From round 3, this round posting at least as
 *   many comments as the previous one. Round 3 because two rounds give one
 *   step and a step is not a trend; and "not shrinking" rather than "growing"
 *   because a loop holding steady is not converging either.
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
  prevPosted?: number;
  /** The previous round's work list, as the side file recovered it. */
  prevFindings: readonly LedgerFinding[];
  /** Paths this round's drafted comments anchor to. */
  draftedPaths: readonly string[];
}): ConvergenceDiagnosis | null {
  const priorByFile = new Map<string, Set<number>>();
  for (const f of input.prevFindings) {
    if (typeof f?.file !== 'string' || f.file.trim() === '') continue;
    // A body-only Critical carries no real path; it cannot cluster.
    if (f.file === '(body)') continue;
    const round = birthRound(f.id);
    if (round === undefined) continue;
    const set = priorByFile.get(f.file) ?? new Set<number>();
    set.add(round);
    priorByFile.set(f.file, set);
  }

  const thisByFile = new Map<string, number>();
  for (const p of input.draftedPaths) {
    if (typeof p !== 'string' || p.trim() === '') continue;
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
  // render the same paragraph.
  clusters.sort(
    (a, b) =>
      b.priorRounds.length - a.priorRounds.length ||
      b.thisRound - a.thisRound ||
      a.file.localeCompare(b.file),
  );

  // A round that posted NOTHING is the observation a convergence trend most
  // wants, not a symptom: zero is where a settling loop lands, and
  // `0 >= 0` would otherwise narrate "the volume is not falling" at exactly
  // the moment it has finished falling. The signal is about a loop still
  // producing comments at an undiminished rate, so it needs this round to
  // have produced some.
  const volumeNotShrinking =
    input.round >= 3 &&
    input.prevPosted !== undefined &&
    input.posted > 0 &&
    input.posted >= input.prevPosted;

  if (clusters.length === 0 && !volumeNotShrinking) return null;
  return {
    round: input.round,
    posted: input.posted,
    ...(input.prevPosted === undefined ? {} : { prevPosted: input.prevPosted }),
    clusters,
    volumeNotShrinking,
  };
}

/** How many clusters the rendered paragraph names before summarising. */
export const MAX_RENDERED_CLUSTERS = 3;

/**
 * The diagnosis as the two sentences a human reads: what was measured, and
 * what that shape usually means.
 *
 * Facts first and separately, because the facts are certain and the reading
 * is not. The recommendations are process-level on purpose — triage the
 * cluster, split it out, stem the posting surface, batch the fixes — and
 * never a code-architecture prescription: this module cannot verify a claim
 * about how the code should be restructured, and an unverifiable claim is
 * exactly what the rest of this pipeline refuses to post.
 */
export function renderConvergenceDiagnosis(d: ConvergenceDiagnosis): {
  en: string;
  zh: string;
} {
  const shown = d.clusters.slice(0, MAX_RENDERED_CLUSTERS);
  const more = d.clusters.length - shown.length;
  const clusterEn = shown
    .map(
      (c) =>
        `\`${c.file}\` (findings in round${c.priorRounds.length > 1 ? 's' : ''} ${c.priorRounds.join(', ')}, ${c.thisRound} more now)`,
    )
    .join('; ');
  const clusterZh = shown
    .map(
      (c) =>
        `\`${c.file}\`（第 ${c.priorRounds.join('、')} 轮已出过发现，本轮又有 ${c.thisRound} 条）`,
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

  const adviceEn =
    d.clusters.length > 0
      ? `A cluster that keeps producing siblings usually means the fixes are treating instances of a shared root cause — triaging that cause before the next round, or splitting an independent cluster into its own pull request, tends to end the loop faster than fixing them one at a time.`
      : `Batching the remaining fixes and verifying them before the next push, or dropping this PR's reviews to \`--severity-floor critical\`, keeps the loop from re-deriving the same set.`;
  const adviceZh =
    d.clusters.length > 0
      ? `一个不断再生兄弟发现的簇，通常意味着逐条修复只在处理同一根因的实例——先定位并处理该根因，或把独立的簇拆成单独的 PR，通常比逐条修复更快结束循环。`
      : `把剩余修复攒成一批、验证后再推送，或将本 PR 的评审降到 \`--severity-floor critical\`，可以避免循环反复推导同一组发现。`;

  return {
    en: `Convergence: ${factsEn}. ${reasonEn} ${adviceEn} (Observation only — nothing was withheld from this review.)`,
    zh: `收敛情况：${factsZh}。${reasonZh}${adviceZh}（仅为观察——本轮评审未因此扣留任何内容。）`,
  };
}
