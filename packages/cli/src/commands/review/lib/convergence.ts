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
  LEDGER_ID_TOKEN,
  LEDGER_MAX_FILE,
  LEDGER_MAX_ROUND,
  isStandInName,
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
  /**
   * That foreign marker was MERGED over this account's own findings, which
   * survive the union under their own ids. It changes what the disclosure
   * can honestly claim: "may not be this account's own" over a work list
   * that is predominantly this account's own certified entries overstates
   * by exactly the part the union protected.
   */
  merged?: boolean;
  /**
   * The posting floor it ran under, when its marker recorded one. A round
   * that posted under a different floor is not a comparable point on this
   * loop's volume trend — the posture changed, not the loop.
   */
  floor?: 'c' | 'o';
  /**
   * How many of its comments were findings reported for the FIRST time.
   * The number the trend is about — see `fresh` on the diagnosis.
   */
  fresh?: number;
}

export interface ConvergenceDiagnosis {
  /** The round being composed. */
  round: number;
  /** Inline comments this round posts, and the previous round's when known. */
  posted: number;
  prevPosted?: number;
  /**
   * How many of those were reported for the FIRST time, this round and the
   * previous one. The trend runs on these, not on the totals: Step 6
   * re-posts every unfixed ledger Critical under its original id, so the
   * re-post floor only ever rises and a loop whose new findings collapsed
   * from five to one still posts more comments than the round before.
   */
  fresh: number;
  prevFresh?: number;
  /** Files that carried findings before and carry more now. */
  clusters: RecurrenceCluster[];
  /** True when this round's volume did not fall below the previous round's. */
  volumeNotShrinking: boolean;
  /** Carried through from `PrevRound` so the rendering can disclose them. */
  truncatedEvidence: boolean;
  foreignEvidence: boolean;
  mergedEvidence: boolean;
  /**
   * HOW this round's floor resolved to `critical`, or null if it did not.
   *
   * The kind, not a boolean, because the advice quotes it back: `auto` is the
   * default configuration, and wording an auto-resolved floor as an explicit
   * `--severity-floor critical` setting claims a flag nobody passed — beside
   * a floor-enforcement note in the same body that describes it accurately as
   * the RESOLVED floor. Auto also fails open the moment context becomes
   * unavailable, which an unconditional-sounding claim would misstate.
   */
  criticalFloorKind?: CriticalFloorKind;
}

/** How a round's posting floor came to be `critical`. */
export type CriticalFloorKind = 'explicit' | 'auto-resolved';

/**
 * Is this draft a finding reported for the FIRST time?
 *
 * The ONE statement of freshness. Step 6 re-posts every still-standing
 * ledger entry under its ORIGINAL id, so an id minted in an earlier round
 * marks a re-post — the loop holding its position, not the loop generating
 * work. Exported because the marker records the count for the next round's
 * trend, and a second restatement there would let the number the trend reads
 * disagree with the drafts the trend is about.
 *
 * Strict below the round cap. AT the cap the id space collides — consecutive
 * rounds both stamp `R<cap>-*` — so the rule fails toward "carried", because
 * the two errors do not cost the same: calling a re-post fresh narrates
 * divergence at the steady state every round forever, while calling a fresh
 * finding carried costs one round of silence.
 */
export function isFreshDraft(
  d: DraftedFinding,
  round: number,
  carried: ReadonlySet<string> = EVERY_ID,
): boolean {
  const minted = birthRound(d?.carriedId);
  if (minted === undefined) return true;
  // The id must NAME an entry in the work list it claims to carry forward.
  // Step 6 teaches the model to lead a re-post with `R1-2: <the claim>`, and
  // models emit stray ids at the head of a claim line — so a genuinely new
  // finding written in that shape would otherwise vanish from both signals:
  // out of its file's cluster, and out of the activity guard, leaving a
  // round of real new work reading as the steady state.
  if (d.carriedId !== undefined && !carried.has(d.carriedId)) return true;
  if (round >= LEDGER_MAX_ROUND && minted >= LEDGER_MAX_ROUND) return false;
  return minted >= round;
}

/**
 * The default for callers with no work list to check against — the marker
 * that records this round's fresh count runs before any recovery is in
 * scope, and there the id's own round is all there is.
 */
const EVERY_ID: ReadonlySet<string> = {
  has: () => true,
} as unknown as ReadonlySet<string>;

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
  /**
   * The floor THIS round resolved to, for comparison against the previous —
   * absent when the state named no floor this module recognises. An unknown
   * posture is not a posture that matches, and it is not one that differs:
   * it makes the comparison unavailable, which leaves the trend evaluated as
   * it was before floors were recorded at all.
   */
  floor?: 'c' | 'o';
  criticalFloorKind?: CriticalFloorKind;
}): ConvergenceDiagnosis | null {
  const priorByFile = new Map<string, Set<number>>();
  for (const f of input.prev.findings) {
    if (typeof f?.file !== 'string' || f.file.trim() === '') continue;
    // A body-only Critical, or a comment that arrived without a path, names
    // no file and cannot cluster. Git permits both stand-in spellings as
    // real filenames, so the ledger flags the EXCEPTION — `k` marks a
    // literal path that happens to be spelled like one — and the rule reads
    // the same for a marker written before that flag existed, whose
    // stand-ins carry no flag because they are stand-ins.
    if (isStandInName(f.file) && f.k !== 1) continue;
    const round = birthRound(f.id);
    if (round === undefined) continue;
    const set = priorByFile.get(f.file) ?? new Set<number>();
    set.add(round);
    priorByFile.set(f.file, set);
  }

  // Fresh: not a re-post of a finding minted in an earlier round. An id this
  // round would mint is not "earlier", so the comparison is strict — except
  // AT the round cap, where the id space collides: consecutive rounds at
  // `LEDGER_MAX_ROUND` both stamp `R<cap>-*`, so a re-post of an unfixed
  // Critical is indistinguishable from a fresh finding by its id alone.
  // There the rule fails toward "carried", because the cost of the two
  // errors is not symmetric: calling a re-post fresh narrates divergence at
  // the steady state every round forever, while calling a fresh finding
  // carried costs one round of silence.
  const carriedIds = new Set(
    input.prev.findings
      .map((f) => f?.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  const fresh = input.drafts.filter((d) =>
    isFreshDraft(d, input.round, carriedIds),
  );

  // Keyed by the REAL path, never by a truncated one. The ledger caps `file`
  // at `LEDGER_MAX_FILE`, so the join has to reach across that cap — but
  // truncating the drafted side to meet it does not prevent prefix
  // collisions, it creates them: two distinct files sharing a 200-character
  // prefix collapse to one key, their counts sum as though they were one
  // file, and the paragraph then posts a 200-character prefix as a path that
  // exists in no repository (with a lone surrogate at the cut, for a
  // non-ASCII path). Matching a truncated LEDGER entry by prefix instead
  // keeps every displayed path real; two files behind one truncated entry
  // become two clusters citing the same prior rounds, which over-attributes
  // history rather than inventing a filename.
  const thisByFile = new Map<string, number>();
  for (const d of fresh) {
    const p = d?.file;
    if (typeof p !== 'string' || p.trim() === '') continue;
    thisByFile.set(p, (thisByFile.get(p) ?? 0) + 1);
  }
  const priorFor = (file: string): Set<number> | undefined =>
    priorByFile.get(file) ??
    (file.length > LEDGER_MAX_FILE
      ? priorByFile.get(file.slice(0, LEDGER_MAX_FILE))
      : undefined);

  // Held to round 3 for the same reason the volume signal is: one step is
  // not a trend. A round-1 finding fixed and one new finding landing in the
  // same file is the ordinary healthy re-review — and on a single-file PR
  // the "split it into its own pull request" advice has no referent at all.
  const clusters: RecurrenceCluster[] = [];
  if (input.round >= 3) {
    for (const [file, count] of thisByFile) {
      const prior = priorFor(file);
      if (!prior || prior.size === 0) continue;
      clusters.push({
        file,
        priorRounds: [...prior].sort((a, b) => a - b),
        thisRound: count,
      });
    }
  }
  // Deterministic order: the file producing the most NEW work now first,
  // then the number of earlier rounds, then the path.
  //
  // This round's count leads, not the prior-round depth, because the depth
  // measures the wrong thing for the sentence it ranks. The previous round's
  // ledger is that round's POSTING SET: a finding the author fixed is not
  // re-posted and its round leaves the list, while a finding nobody fixed is
  // re-posted under its original id and contributes its mint round forever.
  // So depth grows exactly where nothing is being fixed — and the advice it
  // ranked reads "a cluster that keeps producing siblings", about a file
  // where no fix happened. Depth is also the key a stranger can set: one
  // marker holding fifty legal ids on one file put a fabricated cluster in
  // the top slot and evicted a genuine one from the rendered three.
  //
  // The path tie-break compares CODE UNITS, not `localeCompare`: collation
  // follows the runtime locale, and the clustered paths belong to whatever
  // repository is under review, so a locale change between the CI bot's
  // round and a maintainer's round would otherwise reorder tied non-ASCII
  // paths and break the invariant this sort states.
  clusters.sort(
    (a, b) =>
      b.thisRound - a.thisRound ||
      b.priorRounds.length - a.priorRounds.length ||
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
  //
  // And the two rounds must have posted under the SAME floor. A posture
  // change is not loop behaviour: an operator who takes this module's own
  // advice, sets `--severity-floor critical`, and later restores it produces
  // a volume jump the trend would read as a loop that will not settle — and
  // the advice would then recommend re-tightening the floor just
  // deliberately loosened. One transient `contextUnavailable` round under
  // `auto` produces the same spike with no operator action at all. A
  // previous floor that was never recorded is not a floor that differs, so a
  // pre-field marker evaluates exactly as it did before.
  const floorChanged =
    input.prev.floor !== undefined &&
    input.floor !== undefined &&
    input.prev.floor !== input.floor;
  //
  // Measured on FRESH findings, not on the round's whole output. Step 6
  // re-posts every unfixed ledger Critical under its original id, so the
  // re-post floor is monotonically non-decreasing: a loop whose new findings
  // collapsed from five to one still posts more comments than the round
  // before, and a trend on the totals would call that convergence
  // "not falling" — forever. A predecessor that recorded no fresh count
  // leaves the trend unevaluable rather than measured on the wrong number.
  const volumeNotShrinking =
    input.round >= 3 &&
    input.prev.fresh !== undefined &&
    input.prev.fresh > 0 &&
    !floorChanged &&
    fresh.length > 0 &&
    fresh.length >= input.prev.fresh;

  if (clusters.length === 0 && !volumeNotShrinking) return null;
  return {
    round: input.round,
    posted: input.posted,
    fresh: fresh.length,
    ...(input.prev.posted === undefined
      ? {}
      : { prevPosted: input.prev.posted }),
    ...(input.prev.fresh === undefined ? {} : { prevFresh: input.prev.fresh }),
    clusters,
    volumeNotShrinking,
    truncatedEvidence: input.prev.truncated === true,
    foreignEvidence: input.prev.foreign === true,
    mergedEvidence: input.prev.merged === true,
    ...(input.criticalFloorKind === undefined
      ? {}
      : { criticalFloorKind: input.criticalFloorKind }),
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
    `round ${d.round} posted ${d.posted} inline comment(s), ${d.fresh} of them reported for the first time`,
    d.prevPosted === undefined
      ? null
      : `the previous round posted ${d.prevPosted}${d.prevFresh === undefined ? '' : ` (${d.prevFresh} new)`}`,
  ]
    .filter(Boolean)
    .join('; ');
  const factsZh = [
    `第 ${d.round} 轮发布了 ${d.posted} 条行内评论，其中 ${d.fresh} 条是首次提出`,
    d.prevPosted === undefined
      ? null
      : `上一轮发布了 ${d.prevPosted} 条${d.prevFresh === undefined ? '' : `（其中 ${d.prevFresh} 条首次提出）`}`,
  ]
    .filter(Boolean)
    .join('；');

  // Both readings are reported when both fired. Discriminating on the
  // clusters alone made the volume sentence — and with it the entire floor
  // recommendation — unreachable on the shape this feature exists for:
  // recurrence and a flat trend together.
  const reasonsEn: string[] = [];
  const reasonsZh: string[] = [];
  if (d.clusters.length > 0) {
    reasonsEn.push(
      `Findings keep coming back to the same files: ${clusterEn}${more > 0 ? `, and ${more} more file(s)` : ''}.`,
    );
    reasonsZh.push(
      `发现反复回到同一批文件：${clusterZh}${more > 0 ? `，另有 ${more} 个文件` : ''}。`,
    );
  }
  if (d.volumeNotShrinking) {
    reasonsEn.push(`The rate of new findings is not falling.`);
    reasonsZh.push(`新发现的产出速度没有下降。`);
  }
  const reasonEn = reasonsEn.join(' ');
  const reasonZh = reasonsZh.join('');

  // A caveat attaches to the reading it actually bears on. Truncation
  // affects only the WORK LIST, so it qualifies the recurrence reading
  // alone. Provenance is broader: a foreign marker carries the previous
  // round's VOLUME too, and the volume reading cites that number as this
  // loop's own baseline — gated on clusters, the disclosure never reached
  // exactly the branch an attacker-supplied count controls.
  const citesWorkList = d.clusters.length > 0;
  const citesPrevVolume =
    d.prevPosted !== undefined || d.prevFresh !== undefined;
  const caveatsEn: string[] = [];
  const caveatsZh: string[] = [];
  if (citesWorkList && d.truncatedEvidence) {
    caveatsEn.push(
      `the previous round's work list was truncated to fit the marker, so the rounds named above may be an undercount`,
    );
    caveatsZh.push(`上一轮的工作清单为放进标记而被截断，上述轮次可能少计`);
  }
  if (d.foreignEvidence && (citesWorkList || citesPrevVolume)) {
    const what = citesWorkList
      ? citesPrevVolume
        ? { en: `those rounds and its counts`, zh: `上述轮次与其计数` }
        : { en: `those rounds`, zh: `上述轮次` }
      : { en: `those counts`, zh: `该计数` };
    caveatsEn.push(
      d.mergedEvidence
        ? `the previous round was recovered from a marker this account did not post and merged over this account's own entries, so some of ${what.en} may not be this account's own`
        : `the previous round was recovered from a marker this account did not post, so ${what.en} may not be this account's own`,
    );
    caveatsZh.push(
      d.mergedEvidence
        ? `上一轮的数据来自并非本账号发布的标记，并与本账号自己的条目合并，${what.zh}中的部分可能不属于本账号`
        : `上一轮的数据来自并非本账号发布的标记，${what.zh}可能不属于本账号`,
    );
  }
  const caveatEn =
    caveatsEn.length > 0 ? ` (Evidence: ${caveatsEn.join('; ')}.)` : '';
  const caveatZh =
    caveatsZh.length > 0 ? `（证据说明：${caveatsZh.join('；')}。）` : '';

  // The floor recommendation is dropped once the floor already resolves to
  // `critical`: advising a posture the round is running under, inside the
  // very body whose floor-enforcement note says so, reads as advice nobody
  // checked. And it names the posture the way that round actually got it —
  // `auto` is the DEFAULT, so wording an auto-resolved floor as an explicit
  // setting claims a flag nobody passed.
  const batchEn = `Batching the remaining fixes and verifying them before the next push`;
  const batchZh = `把剩余修复攒成一批、验证后再推送`;
  const alreadyEn: Record<CriticalFloorKind, string> = {
    explicit: `this PR's reviews are already at \`--severity-floor critical\``,
    'auto-resolved': `this PR's reviews already resolve to a critical posting floor`,
  };
  const alreadyZh: Record<CriticalFloorKind, string> = {
    explicit: `本 PR 的评审已处于 \`--severity-floor critical\``,
    'auto-resolved': `本 PR 的评审已解析为 critical 发布下限`,
  };
  const floorEn =
    d.criticalFloorKind === undefined
      ? `${batchEn}, or dropping this PR's reviews to \`--severity-floor critical\`, keeps the loop from re-deriving the same set.`
      : `${batchEn} keeps the loop from re-deriving the same set; ${alreadyEn[d.criticalFloorKind]}.`;
  const floorZh =
    d.criticalFloorKind === undefined
      ? `${batchZh}，或将本 PR 的评审降到 \`--severity-floor critical\`，可以避免循环反复推导同一组发现。`
      : `${batchZh}，可以避免循环反复推导同一组发现；${alreadyZh[d.criticalFloorKind]}。`;

  const clusterAdviceEn = `A cluster that keeps producing siblings usually means the fixes are treating instances of a shared root cause — triaging that cause before the next round, or splitting an independent cluster into its own pull request, tends to end the loop faster than fixing them one at a time.`;
  const clusterAdviceZh = `一个不断再生兄弟发现的簇，通常意味着逐条修复只在处理同一根因的实例——先定位并处理该根因，或把独立的簇拆成单独的 PR，通常比逐条修复更快结束循环。`;
  const adviceEn = [
    d.clusters.length > 0 ? clusterAdviceEn : null,
    d.volumeNotShrinking ? floorEn : null,
  ]
    .filter(Boolean)
    .join(' ');
  const adviceZh = [
    d.clusters.length > 0 ? clusterAdviceZh : null,
    d.volumeNotShrinking ? floorZh : null,
  ]
    .filter(Boolean)
    .join('');

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
