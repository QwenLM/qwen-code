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
  LEDGER_MAX_TITLE,
  claimLocator,
  isStandInName,
  type LedgerClosure,
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
  /**
   * The carried id fronts a NEW defect — one the fix for that entry
   * introduced — rather than a re-assertion of the entry's own claim.
   *
   * A carried id means two things since the fix-induced disposition shipped,
   * and only one of them is a re-post. Without this the trend counted both,
   * so a round that newly identified six defects, four of them re-reported
   * under the ids whose fixes produced them, recorded a first-time count of
   * two — the baseline falling on exactly the churning pull requests where
   * new work was not falling at all. Read off the comment body beside the id,
   * so a marking the reader cannot see is one the count does not get either.
   */
  fixInduced?: boolean;
}

/**
 * One subsystem whose Criticals keep regrowing (#9905): a file that closed
 * Critical(s) in the previous round and again this round — the previous
 * marker's minted closures (`r === round - 1`) and this round's
 * (`r === round`) — while posting a fresh Critical on it now. That is the
 * patch-and-regress shape: each fix grew the next Critical in the same
 * mechanism, which is a claim about the MECHANISM, not about any one
 * finding.
 */
export interface SuccessorChain {
  /** The subsystem, named by the file every generation landed on. */
  file: string;
  /**
   * The closure ids of each of the two rounds, oldest first —
   * `[round N-1's, round N's]`. `newIds` is the chain's final generation
   * but is NOT in this array; the renderer appends it.
   */
  generations: string[][];
  /** The fresh Critical ids this round posts on the file. */
  newIds: string[];
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
   * The work list is WHOLE — nothing was shed by the marker's byte budget,
   * nothing was refused by the admission test, and it really was recovered.
   * Absence of an id from an incomplete list proves nothing.
   */
  complete?: boolean;
  /**
   * That foreign marker was MERGED over this account's own findings, which
   * survive the union under their own ids. It changes what the disclosure
   * can honestly claim: "may not be this account's own" over a work list
   * that is predominantly this account's own certified entries overstates
   * by exactly the part the union protected.
   */
  merged?: boolean;
  /**
   * Its findings were adopted by an ANONYMOUS whole-write — recovery ran
   * with no identity to vouch them (`pr-context` stamps the record). Not
   * `foreign` to the disclosure caveat — an unknown identity is not a
   * foreign author — but the absence-based inferences read the list like a
   * pure-foreign one: a vanished id may sit in a list no identity vouched,
   * so the closure mint and the `land-and-defer` gate both withhold.
   */
  anonymousAdoption?: boolean;
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
  /** Its own round number; 0 when nothing was recovered. */
  round?: number;
  /**
   * Whether it carried an incremental anchor THIS round can use — a grafted
   * one whose certifier mismatches, or whose re-run this round's fetch
   * refused or resolved to the head, does not count (Step 1 cannot scope to
   * it, so the chain is still broken). Read only by the mechanism-health
   * check: two consecutive withholds mean every later round re-reads the
   * whole diff until a round's marker carries an anchor again or a graft
   * lands that the round running it can use — which a clean close does not
   * guarantee, because the marker also withholds on a missing fetched sha
   * and on a model-identity drift.
   */
  anchored?: boolean;
  /**
   * The Criticals that round closed — the closures its marker minted (each
   * carries `r === round`). Absent on every marker written before the field
   * existed, which reads as "no closures recorded" and silences the
   * successor-chain signal: thin history stays silent rather than guesses.
   */
  closed?: readonly LedgerClosure[];
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
  /**
   * Subsystems whose Criticals keep regrowing (#9905) — the sharper form of
   * a recurrence cluster: not "the file sees findings again" but "the last
   * two rounds each CLOSED a Critical here and this round posts another",
   * the patch-and-regress chain where each fix grows the next Critical.
   */
  successorChains: SuccessorChain[];
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
  /**
   * Blockers THIS round posts — inline plus body. A fact about the round
   * being composed, not about the recovered list: a Critical in the previous
   * work list this round does not re-post was fixed.
   */
  openCriticals?: number;
}

/** How a round's posting floor came to be `critical`. */
export type CriticalFloorKind =
  | 'explicit'
  | 'auto-resolved'
  /**
   * `auto` engaged EARLY, before the round-6 schedule, because the
   * first-time-finding rate had not fallen for the streak's bar of
   * consecutive rounds (#9903) — the trigger acting on the `stem-surface`
   * advice this module already prints instead of only printing it. A kind
   * of its own, not folded into `auto-resolved`, because the round owes its
   * reader the reason the posture changed ahead of schedule: the deferral
   * header and the "already" wording below name the trigger off it.
   */
  | 'auto-signaled';

/**
 * The closed set of handling recommendations this module can match.
 *
 * Closed on purpose: a caller wires actions to these codes without parsing
 * prose, so the vocabulary is a contract. Matching is measurement → advice,
 * with zero constants and zero decisions — every entry carries the factual
 * basis it was matched from, and none of them is a claim about how the code
 * should be restructured.
 *
 * The design's menu is larger than this. The codes NOT emitted here are the
 * ones whose evidence this round does not hold, and each is absent for a
 * stated reason rather than forgotten:
 *
 * - `split` needs the diff-topology test (a separate work item); this module
 *   can see that a cluster recurs, not that its hunks are separable.
 * - `reset-drift` / `rescope` need `srcDelta`, which is gated on the anchor
 *   write-side work.
 * - `fix-pipeline` needs marker content-hash dedup to tell a repost storm
 *   from real volume.
 * - `reduce-cadence` is matched to "many rounds, small per-round increments",
 *   and both halves are thresholds — the one thing this module does not own.
 *   Its threshold-free reading ("healthy but oversampled") is also a round
 *   that produces no diagnosis at all, so there is no paragraph to carry it.
 * - `re-anchor` was matched to an anchorless chain on the premise that agent
 *   budget caps dominate it. Measured on this repository the dominant causes
 *   were a non-converged reverse audit and skipped integration tests, which
 *   one raised-budget round does not clear — so the chain is DISCLOSED below
 *   as mechanism health and prescribes nothing.
 * - `human-triage` is matched to "any shape" in the design, which makes it
 *   advice no measurement selected. Emitting it on every diagnosis would
 *   spend the code set's only real property — that a code means a fact was
 *   observed — on a constant.
 *
 * That is the whole menu: twelve codes in the design, five emitted here
 * (`successor-chain` joined the four existing codes with #9905 — its
 * measurement is the closure lineage the marker now records), seven named
 * above.
 */
export const RECOMMENDATION_CODES = [
  'root-cause-triage',
  'successor-chain',
  'land-and-defer',
  'batch-fixes',
  'stem-surface',
] as const;

/**
 * Derived from the runtime list above, not declared beside it: a validator
 * needs the membership check and a caller needs the type, and two hand-kept
 * copies of a closed vocabulary drift the moment one gains a code.
 */
export type RecommendationCode = (typeof RECOMMENDATION_CODES)[number];

/** One matched recommendation and the measurement that matched it. */
export interface Recommendation {
  code: RecommendationCode;
  /** The deterministic fact this was matched from — never a judgement. */
  basis: string;
}

/**
 * What the round can say about the MECHANISM, as opposed to about the loop.
 *
 * A pipeline that has stopped working is indistinguishable from one with
 * nothing to do: both are silent. These are the shapes where the round can
 * see its own machinery failing, and they are stated as facts with no
 * prescription attached.
 */
export interface MechanismHealth {
  /**
   * The floor resolved to `critical`, and findings it would have deferred —
   * Suggestions, or an axes-pair Critical (#10291) — posted inline anyway.
   * The posture is nominally engaged and mechanically is not.
   */
  postureNotEngaging: boolean;
  /**
   * This round did not close cleanly — unproven scope, a dimension gap that
   * is not depth-only, or any verdict cap other than an unreviewable
   * dimension — which withholds the incremental anchor, and the round it
   * recovered carried none this round could use. Two consecutive withholds
   * mean the next round re-reads the whole diff, and the round after that,
   * until something clears it: the closed loop measured at 119 minutes and
   * 34M tokens on a PR whose code had not changed a line.
   *
   * A stated limit: those are the only withholding legs visible from here.
   * The marker also withholds when the plan carries no fetched sha, when it
   * cannot be read, and when the round's model identity drifted — those are
   * decided where the marker is built, with the plan in hand, and a round
   * withheld only by one of them is a chain this check does not see. It
   * under-reports rather than over-reports, and the wording claims only what
   * it measured.
   */
  anchorChainBroken: boolean;
}

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
  carriedComplete = true,
): boolean {
  const minted = birthRound(d?.carriedId);
  if (minted === undefined) return true;
  // A fix-induced re-report is first-time work wearing an earlier id. The id
  // is bookkeeping — it keeps one churning site on one thread instead of
  // opening a new one every round — and reading it as a re-post is what made
  // this count understate new work precisely where the loop was creating the
  // most of it. Placed before every arm below on purpose: the membership test
  // exists to stop a STRAY id from hiding real work and this id is not stray,
  // and the round-cap arm is the one place the counter stops advancing, which
  // must not also be the place this stops counting.
  //
  // It is the one input here that can only come from the model asserting
  // something, so weigh it the way the caller's own asymmetry note does. An
  // OMITTED marking degrades to the reading every round had before it
  // existed — a re-post, one round of silence. A marking wrongly added to a
  // still-stands would narrate divergence at the steady state, which is the
  // expensive error, and that is why the skill restricts the token to a
  // re-report that genuinely is fix-induced rather than offering it as a way
  // to flag any carried finding as interesting.
  if (d?.fixInduced === true) return true;
  // The id must NAME an entry in the work list it claims to carry forward.
  // Step 6 teaches the model to lead a re-post with `R1-2: <the claim>`, and
  // models emit stray ids at the head of a claim line — so a genuinely new
  // finding written in that shape would otherwise vanish from both signals:
  // out of its file's cluster, and out of the activity guard, leaving a
  // round of real new work reading as the steady state.
  //
  // Only over a list known to be WHOLE, and for the same reason `buildLedger`
  // keeps such an id over a shortened one: a non-member there may be an entry
  // the byte budget shed, which Step 6 re-voices under its original id. Read
  // as first-time work it would post "the rate of new findings is not
  // falling" every round on a loop doing no new work — and one marker would
  // say two things about the same comment, since the work list keeps the id
  // the fresh count calls new.
  if (
    carriedComplete &&
    d.carriedId !== undefined &&
    !carried.has(d.carriedId)
  ) {
    return true;
  }
  if (round >= LEDGER_MAX_ROUND && minted >= LEDGER_MAX_ROUND) return false;
  return minted >= round;
}

/**
 * The default for a caller with no work list to check against — the id's own
 * round is then all there is.
 *
 * Every production caller HAS one and must pass it: the marker's fresh count
 * and the posted paragraph's are the same number about the same round, and
 * two different carried-sets made one body state two volumes — with the
 * marker's undercount persisting as the next round's `prev.fresh`, where the
 * trend's own guard reads it.
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
 * - **Volume not shrinking.** From round 3, this round producing at least as
 *   many NEW findings as the previous one. Round 3 because two rounds give
 *   one step and a step is not a trend; "not shrinking" rather than
 *   "growing" because a loop holding steady is not converging either; and
 *   NEW findings rather than the comment total because Step 6 re-posts every
 *   unfixed entry, so the total only ever rises.
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
  /**
   * Blockers THIS round posts — inline plus body. The one fact
   * `land-and-defer` turns on, and it is a fact about the round being
   * composed rather than about the recovered list: a Critical in the
   * previous work list this round does not re-post was fixed.
   */
  openCriticals?: number;
  /**
   * The closures THIS round mints — the previous work list's Criticals this
   * round does not re-post — computed by the caller from the same built
   * ledger the marker stamps, so the marker's `closed` field and this
   * signal can never disagree about what closed when. Empty whenever the
   * previous work list is incomplete: a vanished id in a truncated list
   * may be the budget, not a ruling, so a partial list mints nothing.
   */
  closuresThisRound?: readonly LedgerClosure[];
  /**
   * This round's findings AS THE BUILT LEDGER stamps them. The successor
   * chain reads its new side from here — the built ids, post readback and
   * admission — rather than from the drafts, so the note's `R<round>-<n>`
   * references are the ones the posted review and the next round's work
   * list actually use.
   */
  thisRoundFindings?: readonly LedgerFinding[];
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
    isFreshDraft(d, input.round, carriedIds, input.prev.complete === true),
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
  //
  // The depth key is DROPPED entirely when the work list came from another
  // account's marker. Leading with this round's count takes the top slot
  // back from a fabricated cluster, but depth still decides every tie — and
  // ties are the ordinary shape, one fresh finding per file — so fifty
  // planted ids on one file still evicted a genuine cluster from the
  // rendered three. Provenance is disclosed for the ROUNDS; the ordering
  // cannot disclose anything, so on a foreign list it simply does not use a
  // number a stranger set.
  const trustDepth = input.prev.foreign !== true;
  clusters.sort(
    (a, b) =>
      b.thisRound - a.thisRound ||
      (trustDepth ? b.priorRounds.length - a.priorRounds.length : 0) ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  );

  // The successor chain (#9905): a file that CLOSED a Critical in each of
  // the last two rounds — this round's minted set (`r === round`) and the
  // previous marker's (`r === round - 1`) — while this round posts a FRESH
  // Critical on it. The cluster signal above says "the file sees findings
  // again"; this says "the fix closed one and the mechanism grew another",
  // twice in a row — the #9659 rebound shape, where every finding was
  // individually correct and the subsystem was diverging. Joined by file,
  // deterministically, like the cluster.
  const successorChains: SuccessorChain[] = [];
  const closedNow = input.closuresThisRound ?? [];
  const closedPrev = input.prev.closed ?? [];
  const thisRoundFindings = input.thisRoundFindings ?? [];
  // The fresh side's claim-identity defense — the mint's mirror. A re-post
  // whose readback lost the carried id is stamped with a FRESH id in the
  // build (see `idFor`), so `birthRound === round` alone counts a
  // still-standing claim as the chain's new generation — the note firing
  // over a claim the same round's work list says never left. Join on the
  // locator projection the mint uses, over the recovered previous list:
  // PRESENT in it is evidence regardless of its completeness, and its
  // titles are already write-capped, so the built side caps before
  // projecting the way the serializer would.
  if (
    input.round >= 2 &&
    closedNow.length > 0 &&
    closedPrev.length > 0 &&
    thisRoundFindings.length > 0
  ) {
    const standingPrevClaims = new Set(
      input.prev.findings
        .map((g) => claimLocator(g.title))
        .filter((k) => k !== ''),
    );
    const freshCriticalsByFile = new Map<string, string[]>();
    for (const f of thisRoundFindings) {
      if (f.sev !== 'C') continue;
      // The stand-in rule the cluster join applies: a pathless or body-only
      // Critical names no subsystem. `k` is respected the same way — the
      // built ledger flags a REAL path that happens to spell like one.
      if (isStandInName(f.file) && f.k !== 1) continue;
      // The built id's round IS the first-reported round: a fresh finding
      // was stamped this round, a carried one keeps its original id.
      if (birthRound(f.id) !== input.round) continue;
      // A re-mint of a claim still standing in the previous list is a
      // re-post, not a new generation — see `standingPrevClaims` above.
      const locator = claimLocator(f.title.slice(0, LEDGER_MAX_TITLE));
      if (locator !== '' && standingPrevClaims.has(locator)) continue;
      const ids = freshCriticalsByFile.get(f.file);
      if (ids) ids.push(f.id);
      else freshCriticalsByFile.set(f.file, [f.id]);
    }
    for (const [file, newIds] of freshCriticalsByFile) {
      const generations: string[][] = [];
      for (const [closures, r] of [
        [closedPrev, input.round - 1],
        [closedNow, input.round],
      ] as const) {
        const idsAt = closures
          .filter(
            (c) =>
              c.r === r &&
              // Stand-in-named closures never join: `LedgerClosure` carries
              // no `k`, so a body-only closure is indistinguishable from a
              // closure on a REAL file spelled like the stand-in. Joining
              // them would post a lineage over a mechanism the closures
              // never anchored on — silence, never a guess.
              !isStandInName(c.f) &&
              // Closures are capped at LEDGER_MAX_FILE on every route while
              // this side keys on the RAW built path, so an exact join is
              // permanently silent past the cap — mirror `priorFor`'s slice
              // fallback, or the advisory disarms on exactly the deep
              // subsystems it exists for.
              (c.f === file ||
                (file.length > LEDGER_MAX_FILE &&
                  c.f === file.slice(0, LEDGER_MAX_FILE))),
          )
          .map((c) => c.id);
        if (idsAt.length === 0) {
          generations.length = 0;
          break;
        }
        generations.push(idsAt);
      }
      if (generations.length === 0) continue;
      successorChains.push({ file, generations, newIds });
    }
    // Sorted, like the cluster above, so WHICH diverging subsystems the two
    // `.slice(0, MAX_RENDERED_CLUSTERS)` consumers name is a measured
    // property, never the map's insertion order: the most new work first,
    // closure volume second, the code-unit path the tie-break.
    successorChains.sort(
      (a, b) =>
        b.newIds.length - a.newIds.length ||
        b.generations.flat().length - a.generations.flat().length ||
        (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
    );
  }

  // A round that produced NO fresh finding is the observation a convergence
  // trend most wants, not a symptom: zero new work is where a settling loop
  // lands, and `0 >= 0` would otherwise narrate "the volume is not falling"
  // at exactly the moment it has finished falling. The guard subsumes the
  // zero-posting case — a round with no drafts has no fresh drafts either —
  // and additionally covers the round whose whole output is carried re-posts.
  //
  // `prev.fresh > 0` for the mirror reason on the other end: a trend measured
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

  if (
    clusters.length === 0 &&
    !volumeNotShrinking &&
    successorChains.length === 0
  )
    return null;

  return {
    ...(input.openCriticals === undefined
      ? {}
      : { openCriticals: input.openCriticals }),
    round: input.round,
    posted: input.posted,
    fresh: fresh.length,
    ...(input.prev.posted === undefined
      ? {}
      : { prevPosted: input.prev.posted }),
    ...(input.prev.fresh === undefined ? {} : { prevFresh: input.prev.fresh }),
    clusters,
    successorChains,
    volumeNotShrinking,
    truncatedEvidence: input.prev.truncated === true,
    foreignEvidence: input.prev.foreign === true,
    mergedEvidence: input.prev.merged === true,
    ...(input.criticalFloorKind === undefined
      ? {}
      : { criticalFloorKind: input.criticalFloorKind }),
  };
}

/**
 * The per-generation id bound for a rendered chain, so a round that closed
 * a whole family on the file cannot grow the paragraph unboundedly.
 */
const MAX_CHAIN_IDS_PER_GENERATION = 6;

/**
 * The chain as the paragraph and the recommendation's basis render it —
 * `R9-1 → R10-2/R10-3 → R11-4`, oldest generation first, the new ids last.
 * ONE renderer for both, so the prose and the machine-readable half cannot
 * disagree about the lineage they name.
 */
export function renderSuccessorChain(c: SuccessorChain): string {
  const renderGeneration = (ids: string[]): string => {
    const shown = ids.slice(0, MAX_CHAIN_IDS_PER_GENERATION).join('/');
    return ids.length > MAX_CHAIN_IDS_PER_GENERATION
      ? `${shown} … (+${ids.length - MAX_CHAIN_IDS_PER_GENERATION})`
      : shown;
  };
  return [...c.generations, c.newIds].map(renderGeneration).join(' → ');
}

/**
 * The handling recommendations this diagnosis matches — measurement to
 * advice, with zero constants and zero decisions.
 *
 * DERIVED from the diagnosis rather than stored on it. Carried as a field,
 * the same round would have two representations of one thing, and a caller
 * (or a test) could hold a diagnosis whose codes and whose facts describe
 * different rounds. Derived, the paragraph a human reads and the codes a
 * caller wires cannot disagree, because there is only one of them.
 */
export function recommendationsFor(d: ConvergenceDiagnosis): Recommendation[] {
  const out: Recommendation[] = [];
  if (d.clusters.length > 0) {
    const shown = d.clusters.slice(0, MAX_RENDERED_CLUSTERS).map((c) => c.file);
    out.push({
      code: 'root-cause-triage',
      basis: `${d.clusters.length} file(s) carried findings in earlier rounds and carry new ones now: ${shown.join(', ')}${d.clusters.length > shown.length ? ', …' : ''}`,
    });
  }
  if (d.successorChains.length > 0) {
    const shown = d.successorChains
      .slice(0, MAX_RENDERED_CLUSTERS)
      .map((c) => `${c.file} (${renderSuccessorChain(c)})`);
    out.push({
      code: 'successor-chain',
      basis:
        `${d.successorChains.length} subsystem(s) closed Critical(s) in the previous round and again this round, and post a new one now: ` +
        `${shown.join(', ')}${d.successorChains.length > shown.length ? ', …' : ''}`,
    });
  }
  if (d.volumeNotShrinking) {
    out.push({
      code: 'batch-fixes',
      basis: `round ${d.round} produced ${d.fresh} first-time finding(s); the previous round produced ${d.prevFresh}`,
    });
    // The floor rung is offered only where there is a rung left to take.
    if (d.criticalFloorKind === undefined) {
      out.push({
        code: 'stem-surface',
        basis: `the posting floor for this round did not resolve to critical`,
      });
    }
  }
  // Decidable, and decidable ONLY from this round: a loop whose blockers are
  // all fixed can end by merging, and a merged pull request cannot diverge
  // further. Absent `openCriticals` is not zero — an unrecorded count is not
  // a count of none.
  if (d.openCriticals === 0) {
    out.push({
      code: 'land-and-defer',
      basis: `this round posts no Critical finding(s)`,
    });
  }
  return out;
}

/**
 * The mechanism-health disclosure, or null when nothing is wrong with the
 * machinery itself.
 *
 * Separate from the loop reading on purpose. A diverging loop is a fact
 * about the WORK; these are facts about the pipeline, and they are the
 * shapes where a failure is otherwise indistinguishable from having nothing
 * to do — both are silent. Stated, never prescribed: what to do about a
 * posture that is not engaging, or an anchor chain that has stopped, is the
 * operator's call, and the one prescription the design once carried here
 * (`re-anchor`) was matched to a cause the measurements did not bear out.
 */
export function renderMechanismHealth(
  h: MechanismHealth,
): { en: string; zh: string } | null {
  const en: string[] = [];
  const zh: string[] = [];
  if (h.postureNotEngaging) {
    en.push(
      `the posting floor for this round resolved to critical, and findings the floor would have deferred posted inline anyway — the posture is engaged in name and not in effect`,
    );
    zh.push(
      `本轮的发布下限解析为 critical，但仍有本应被下限延后的发现以行内评论发布——该姿态名义上生效、实际未生效`,
    );
  }
  if (h.anchorChainBroken) {
    en.push(
      `this round did not close cleanly, so it withholds the incremental anchor — and the round it recovered had no anchor this round could use either — none at all, one with no certifier, one certified by an identity other than the one this round runs under, or one this round's fetch refused or resolved to the head — so the next review re-reads the whole diff unless recovery grafts an earlier own anchor that the round running it can use onto the complete work list this round leaves behind, and keeps doing so until a round's marker carries an anchor again or a graft lands that the round running it can use`,
    );
    zh.push(
      `本轮未能干净收尾，因而扣留了增量锚点，而它恢复到的那一轮也没有留下本轮可用的锚点——要么完全没有、要么没有认证者、要么由本轮运行身份之外的身份认证、要么被本轮的获取拒绝或解析为头提交——因此下一次评审将重读整个 diff，除非恢复流程把本轮能使用的更早自有锚点嫁接到本轮留下的完整工作清单上；并会一直如此，直到某一轮的标记重新带上锚点，或落地的嫁接能被运行该轮的评审使用`,
    );
  }
  if (en.length === 0) return null;
  return {
    en: `Mechanism health: ${en.join('; ')}. (Stated, not acted on — this changes nothing about what the round posts.)`,
    zh: `机制健康：${zh.join('；')}。（仅陈述，不据此行动——这不改变本轮发布的任何内容。）`,
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
        `${mdField(c.file)} (findings in round${c.priorRounds.length > 1 ? 's' : ''} ${c.priorRounds.join(', ')}; ${c.thisRound} more now)`,
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
  if (d.successorChains.length > 0) {
    // The sharpest shape, named first: not "the file sees findings again"
    // but "the last two rounds each CLOSED a Critical here and this round
    // posts another" — the chain is named in full because the ids are the
    // evidence the author acts on. `mdField` on every segment: the file is
    // PR-controlled and the ids arrive over the marker.
    const shown = d.successorChains.slice(0, MAX_RENDERED_CLUSTERS);
    const more = d.successorChains.length - shown.length;
    const chainsEn = shown
      .map((c) => `${mdField(c.file)} (${mdField(renderSuccessorChain(c))})`)
      .join('; ');
    const chainsZh = shown
      .map((c) => `${mdField(c.file)}(${mdField(renderSuccessorChain(c))})`)
      .join('；');
    reasonsEn.push(
      `⚠️ Divergence: the same subsystem closed Critical(s) in the previous round and again this round, and posts a new one now — ${chainsEn}${more > 0 ? `; and ${more} more` : ''}.`,
    );
    reasonsZh.push(
      `⚠️ 发散：同一子系统在上一轮和本轮各关闭了至少一个 Critical，本轮又出现了新的 Critical——${chainsZh}${more > 0 ? `；另有 ${more} 个` : ''}。`,
    );
  }
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
  // loop's own baseline — and its MINTED CLOSURES too, which the chain
  // cites as this loop's own lineage. Gated on clusters, the disclosure
  // never reached exactly the branches an attacker-supplied count or
  // closure list controls.
  const citesWorkList = d.clusters.length > 0;
  const citesPrevVolume =
    d.prevPosted !== undefined || d.prevFresh !== undefined;
  const citesClosures = d.successorChains.length > 0;
  const caveatsEn: string[] = [];
  const caveatsZh: string[] = [];
  // Truncation qualifies BOTH readings, not only the recurrence one: the
  // work list IS the carried-id set that defines freshness. The direction it
  // moves the count is UNDER, not over — the stray-id rescue is gated on the
  // list being whole, so over a shortened one a genuinely new finding the
  // model prefixed with an earlier round's id cannot be rescued and is read
  // as a re-post. (A re-post of a SHED entry is read as carried too, which
  // is correct: it is one.)
  if (d.truncatedEvidence) {
    // The count clause is unconditional, because the facts clause cites this
    // round's fresh count unconditionally. Only the rounds half depends on
    // rounds being named.
    const understated = {
      en: `a new finding written under an earlier round's id cannot be told from a re-post over a partial list, so the new-finding count may be understated`,
      zh: `在不完整的清单上，冠以早先轮次 id 的新发现无法与重发区分，首次提出的条数可能少计`,
    };
    const what = citesWorkList
      ? {
          en: `the rounds named above may be an undercount, and ${understated.en}`,
          zh: `上述轮次可能少计；${understated.zh}`,
        }
      : understated;
    caveatsEn.push(
      `the previous round's work list was truncated to fit the marker, so ${what.en}`,
    );
    caveatsZh.push(`上一轮的工作清单为放进标记而被截断，${what.zh}`);
  }
  if (
    d.foreignEvidence &&
    (citesWorkList || citesPrevVolume || citesClosures)
  ) {
    const partsEn: string[] = [];
    const partsZh: string[] = [];
    if (citesWorkList) {
      partsEn.push(`those rounds`);
      partsZh.push(`上述轮次`);
    }
    if (citesPrevVolume) {
      partsEn.push(citesWorkList ? `its counts` : `those counts`);
      partsZh.push(citesWorkList ? `其计数` : `该计数`);
    }
    if (citesClosures) {
      partsEn.push(`the closure lineage named above`);
      partsZh.push(`上述闭包血缘`);
    }
    const what = { en: partsEn.join(` and `), zh: partsZh.join(`与`) };
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
  // The chain's newest generation is fresh-stamped BY CONSTRUCTION — the
  // fresh scan admits no carried id — and a re-voice of a still-open claim
  // whose readback lost its id is textually indistinguishable from a new
  // Critical. Blanket suppression cannot separate that shape from the
  // legitimate rebound the signal exists for, so the note discloses the
  // identity gap instead of asserting the generation is new.
  if (d.successorChains.length > 0) {
    caveatsEn.push(
      `the chain's newest generation carries ids stamped this round — a still-open claim re-voiced without its carried id reads the same there as a new Critical`,
    );
    caveatsZh.push(
      `链条最新一代携带的 id 由本轮铸造——一个未解决断言若在不携带原 id 的情况下被重新表述，在那里与新的 Critical 无法区分`,
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
  const matched = recommendationsFor(d);
  const has = (code: RecommendationCode): boolean =>
    matched.some((r) => r.code === code);
  const batchEn = `Batching the remaining fixes and verifying them before the next push`;
  const batchZh = `把剩余修复攒成一批、验证后再推送`;
  const alreadyEn: Record<CriticalFloorKind, string> = {
    explicit: `this PR's reviews are already at \`--severity-floor critical\``,
    'auto-resolved': `this PR's reviews already resolve to a critical posting floor`,
    'auto-signaled': `this PR's reviews already engage the critical posting floor — it resolved early, ahead of the round-6 schedule, because the first-time-finding rate has not fallen for consecutive rounds`,
  };
  const alreadyZh: Record<CriticalFloorKind, string> = {
    explicit: `本 PR 的评审已处于 \`--severity-floor critical\``,
    'auto-resolved': `本 PR 的评审已解析为 critical 发布下限`,
    'auto-signaled': `本 PR 的评审已处于 critical 发布下限——因首次发现速率连续多轮未下降，已先于第 6 轮的既定计划提前生效`,
  };
  // The floor rung rides the batching sentence when it was MATCHED — the
  // same condition, read off the set rather than re-derived from the flag.
  const stem = has('stem-surface');
  const floorEn = stem
    ? `${batchEn}, or dropping this PR's reviews to \`--severity-floor critical\`, keeps the loop from re-deriving the same set.`
    : `${batchEn} keeps the loop from re-deriving the same set${
        d.criticalFloorKind === undefined
          ? ''
          : `; ${alreadyEn[d.criticalFloorKind]}`
      }.`;
  const floorZh = stem
    ? `${batchZh}，或将本 PR 的评审降到 \`--severity-floor critical\`，可以避免循环反复推导同一组发现。`
    : `${batchZh}，可以避免循环反复推导同一组发现${
        d.criticalFloorKind === undefined
          ? ''
          : `；${alreadyZh[d.criticalFloorKind]}`
      }。`;

  const clusterAdviceEn = `A cluster that keeps producing siblings usually means the fixes are treating instances of a shared root cause — triaging that cause before the next round, or splitting an independent cluster into its own pull request, tends to end the loop faster than fixing them one at a time.`;
  const clusterAdviceZh = `一个不断再生兄弟发现的簇，通常意味着逐条修复只在处理同一根因的实例——先定位并处理该根因，或把独立的簇拆成单独的 PR，通常比逐条修复更快结束循环。`;
  const chainAdviceEn = `A mechanism whose fix grows the next Critical is diverging, not converging — raising the pattern with the mechanism's owner before the next round tends to end the loop faster than patching it again.`;
  const chainAdviceZh = `每次修复都长出下一个 Critical 的机制是在发散而非收敛——先把这一模式提给该机制的负责人，通常比继续打补丁更快结束循环。`;
  const landEn = `No Critical finding is open on this round, so merging and moving the remaining Suggestion threads to a follow-up issue is available as an ending — a merged pull request cannot diverge further.`;
  const landZh = `本轮没有未决的 Critical，因此"合入后把剩余 Suggestion 线程转到后续 issue"是一个可选的结束方式——已合入的 PR 不会继续发散。`;

  // The prose is generated FROM the matched set, not beside it. Two lists
  // would let the paragraph a human reads and the codes a caller wires
  // describe different rounds — and this module's whole claim is that its
  // advice is matched to what it measured.
  const adviceEn = [
    has('successor-chain') ? chainAdviceEn : null,
    has('root-cause-triage') ? clusterAdviceEn : null,
    has('batch-fixes') ? floorEn : null,
    has('land-and-defer') ? landEn : null,
  ]
    .filter(Boolean)
    .join(' ');
  const adviceZh = [
    has('successor-chain') ? chainAdviceZh : null,
    has('root-cause-triage') ? clusterAdviceZh : null,
    has('batch-fixes') ? floorZh : null,
    has('land-and-defer') ? landZh : null,
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

// ---------------------------------------------------------------------------
// The convergence EXIT, past the diagnosis above.
//
// Everything above answers "is this loop settling, and if not, why", and its
// handling advice ends at a posture the operator can still change — including
// dropping the round to a Critical-only floor. What follows picks up where
// that advice has already been taken and the loop STILL does not settle: the
// floor is engaged, the Suggestions are gone, and the volume has flatlined on
// Criticals that never clear. The diagnosis names the shape; this names the
// way out of it (#9410).
// ---------------------------------------------------------------------------

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
// the previous round's work-list AND this round, the severity floor
// engaged, and the two-round posting window not shrinking) and, when it
// fires, surfaces the ONE recommendation
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
 * Criticals". Both `false` and `undefined` suppress the signal (the guard
 * is `!== true`); `undefined` marks "no previous round recovered" for
 * readability, and production only ever yields `true | undefined`.
 */
export interface ConvergenceFacts {
  /** Did the PREVIOUS round's carried work-list hold a Critical? */
  prevHadCritical: boolean | undefined;
  /**
   * Critical findings THIS round posts — inline, body-only, and relocated
   * (deferred Critical markers restored to the posting set).
   */
  thisCriticals: number;
  /**
   * How many of THIS round's comments report a finding for the FIRST time.
   *
   * The FRESH count, not the posting total, and for the reason the sibling
   * diagnosis above measures its own trend on the same number: Step 6
   * re-posts every still-standing ledger Critical under its ORIGINAL id, so
   * the re-post floor only ever rises. Measured on totals, a loop whose new
   * findings collapsed from five to one still posts more comments than the
   * round before — and this signal would read that as "not shrinking" and
   * recommend landing with residual risk over a loop that is converging.
   */
  fresh: number | undefined;
  /** The PREVIOUS round's fresh count (the ledger's two-round window). */
  prevFresh: number | undefined;
  /**
   * How many Criticals stood in the PREVIOUS round's carried work-list, when
   * that can be counted.
   *
   * The backlog, and it is here because the fresh window alone cannot see
   * it. A loop whose reviewer finds nothing new for two rounds while the
   * author clears blockers — the healthiest state a still-Critical PR can be
   * in — has fresh 0 on both sides, which "not shrinking" reads as stuck.
   * The standing count is what tells the two apart.
   *
   * A veto, not a requirement: it suppresses on OBSERVED shrinkage and
   * abstains otherwise. That is what keeps it sound over a work-list the
   * marker's byte budget shortened — an undercounted predecessor can only
   * make the shrinkage harder to observe, never invent one.
   */
  prevCriticals: number | undefined;
  /**
   * Was the previous round's work-list known to be INCOMPLETE — shed by the
   * marker's byte budget, or refused by the admission test?
   *
   * It changes nothing about whether the signal fires, and that is
   * deliberate: requiring a whole list would silence the advisory on the
   * deep-work-list rounds it exists for, which are precisely the rounds the
   * budget shortens (measured at up to 35 shed per round). What it changes
   * is what the advisory may CLAIM. Two of the facts read off that list —
   * "no Suggestion, so the floor was enforcing" and "the backlog is not
   * shrinking" — are read off ABSENCE, and absence in a shortened list is
   * not evidence. Both therefore lean toward FIRING here, against the
   * fail-open direction every other input has, so the rendered paragraph
   * discloses it rather than publishing an unqualified reading. The sibling
   * diagnosis in this file qualifies its own recurrence reading on the same
   * fact, for the same reason.
   */
  prevTruncated: boolean | undefined;
  /**
   * Is the severity floor ENGAGED this round — an explicit `critical`
   * floor, or `auto` from round 6 with the round knowable? The advisory
   * claims the floor "will not converge" the loop; that claim is provable
   * only where the floor is actually running, so a disengaged floor (early
   * `auto` rounds, an explicit `suggestion`, an unknowable round)
   * suppresses the signal — fail open, like every other conjunct.
   */
  floorEngaged: boolean | undefined;
  /**
   * The posting floor the PREVIOUS round ran under, when its marker
   * recorded one. The volume window is a two-round comparison, and two
   * rounds that posted under different postures are not two points on one
   * loop's trend: the round the floor engages on drops its Suggestions, so
   * its volume falls against a predecessor that still posted them, and the
   * round after an operator loosens the floor rises for the same reason.
   * Neither movement is the loop.
   *
   * Read the way the sibling diagnosis in this file reads it — a floor that
   * was never recorded is not a floor that DIFFERS, so a pre-field marker
   * evaluates exactly as it did before this conjunct existed.
   */
  prevFloor: 'c' | 'o' | undefined;
  /**
   * Did the PREVIOUS round's work-list still carry a Suggestion?
   *
   * The direct evidence that the floor was NOT enforcing there, and it is
   * needed because the recorded `prevFloor` above cannot supply it. That
   * stamp is written from the REPORTING reading, which folds an absent
   * `severityFloor` into `auto` and so stamps `c` on any round >= 6 whose
   * state named no floor at all — while the strict enforcement reading
   * moved nothing and Suggestions posted normally. Pairing that stamp
   * against this round's enforcement reading let a genuinely un-enforced
   * predecessor pass as an engaged one, and the advisory then published
   * "the severity floor will not converge it" against a window whose far
   * end still included Suggestions (#9526).
   *
   * The work-list settles it without either reading: enforcement moves
   * drafted Suggestions out of the posting set before the marker is built,
   * so an engaged round's list is Critical-only and an un-enforced one is
   * not. Suppresses on the POSITIVE observation, so the two ways it can be
   * wrong land on opposite sides and only one of them fires: a shortened
   * list that shed its Suggestion reads as engaged (bounded by the same
   * truncation caveat the backlog veto carries), while a pathless
   * Suggestion that an engaged round left inline reads as un-enforced and
   * costs one round of silence.
   */
  prevPostedSuggestion: boolean | undefined;
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
  /** Findings this round reported for the first time. */
  fresh: number;
  /** The previous round's, the other end of the window. */
  prevFresh: number;
  /**
   * The predecessor's work-list was known-incomplete, so the two readings
   * taken off its ABSENCES are weaker than the rest. Carried onto the
   * assessment because the paragraph has to disclose it — see the field of
   * the same name on `ConvergenceFacts`.
   */
  prevTruncated: boolean;
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
 *  - the severity floor is ENGAGED this round (`floorEngaged === true`) —
 *    the advisory's "the floor will not converge it" claim is provable only
 *    where the floor is actually running; before engagement the loop may
 *    still converge once it does, so a disengaged floor suppresses the
 *    signal;
 *  - the previous round posted under the SAME engaged floor. Two facts say
 *    so and both must hold: its recorded floor is not `o`, and its
 *    work-list carried no Suggestion. The stamp alone is not enough — it is
 *    written from the reporting reading, which folds an absent floor into
 *    `auto` and stamps `c` on a round enforcement never touched. The round
 *    the floor engages on compares a Critical-only window against a
 *    predecessor that still posted Suggestions, and "the floor will not
 *    converge it" is not a claim one round of the floor can support;
 *  - the two-round FRESH window is present and NOT shrinking — both counts
 *    recorded, and this round's at least the previous round's. A falling
 *    rate of new findings is a converging loop even with Criticals present,
 *    and a missing count says nothing, so both fail open. Fresh rather than
 *    total, because Step 6 re-posts every standing Critical and the total
 *    therefore only ever rises;
 *  - and the standing Critical backlog is not observably shrinking. The
 *    fresh window cannot see this one: a loop finding nothing new while the
 *    author clears blockers sits at fresh 0 on both sides, which "not
 *    shrinking" reads as stuck. This conjunct vetoes on observed shrinkage
 *    and abstains when the predecessor's count is unknown.
 *
 * No threshold anywhere: "not shrinking" is `fresh >= prevFresh` over the
 * shortest window the ledger carries, the backlog veto is a plain `<`, and
 * "persistent" is two consecutive rounds with Criticals — the minimum
 * evidence for each claim, derived from the carried telemetry, never tuned.
 *
 * One deliberate difference from the sibling diagnosis above, which also
 * runs on fresh counts: it additionally requires `prev.fresh > 0`, because
 * it is about a loop GENERATING work. This one must fire at fresh 0 on both
 * sides — Criticals standing round after round with nothing new is not a
 * quiet loop, it is the persistently-critical shape itself, and the backlog
 * veto is what separates it from a backlog being cleared.
 */
export function convergenceAssessment(
  facts: ConvergenceFacts,
): ConvergenceAssessment | null {
  const {
    prevHadCritical,
    thisCriticals,
    fresh,
    prevFresh,
    floorEngaged,
    prevFloor,
    prevPostedSuggestion,
    prevCriticals,
    prevTruncated,
  } = facts;
  if (prevHadCritical !== true) return null;
  if (thisCriticals <= 0) return null;
  if (floorEngaged !== true) return null;
  // This round is `c` by the line above, so a RECORDED `o` predecessor is a
  // posture change and its window is not a comparable point. Unrecorded
  // stays evaluable, like the sibling diagnosis above.
  if (prevFloor !== undefined && prevFloor !== 'c') return null;
  // And a `c` STAMP is not proof the floor enforced: the stamp comes from
  // the reporting fold. A Suggestion in the predecessor's work-list is the
  // proof, and it says the floor did not.
  if (prevPostedSuggestion === true) return null;
  if (fresh === undefined || prevFresh === undefined) return null;
  if (fresh < prevFresh) return null;
  // The backlog veto. Positive evidence only: an unknown predecessor count
  // abstains rather than suppressing, and a shortened work-list can only
  // hide shrinkage, never manufacture it.
  if (prevCriticals !== undefined && thisCriticals < prevCriticals) {
    return null;
  }
  return {
    shape: 'persistently-critical',
    recommendation: LAND_WITH_RESIDUAL_RISK,
    criticals: thisCriticals,
    fresh,
    prevFresh,
    prevTruncated: prevTruncated === true,
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
 *
 * Led by "Residual risk", not by "Convergence": the loop-settling
 * observation above already opens its paragraph that way, both can render
 * into the SAME body, and two paragraphs with one opening word is a body
 * whose reader cannot tell which one is speaking. The lead-in matches the
 * recommendation it carries and the terminal label it prints under.
 */
export function convergenceAdvisory(a: ConvergenceAssessment): {
  en: string;
  zh: string;
} {
  const en =
    `Residual risk: this loop is persistently critical — Criticals stood in ` +
    `the previous round's work-list and stand again this round (${a.criticals} ` +
    `Critical(s)), the rate of first-time findings is not falling (this ` +
    `round ${a.fresh}, previous ${a.prevFresh}), and the standing Critical ` +
    `backlog is not shrinking${
      a.prevTruncated
        ? ` — though the previous round's work list was truncated to fit the ` +
          `marker, so "the backlog is not shrinking" and "the floor was ` +
          `enforcing" are both read off a list known to be incomplete`
        : ''
    }. The severity floor will not ` +
    `converge it. Recommendation: \`${a.recommendation}\` — the exit is a ` +
    `maintainer risk-acceptance decision (merge, carrying the residual risk), ` +
    `not another review round. Residual-risk inventory for that decision ` +
    `(maintainer to complete):\n\n` +
    `| standing Critical | attack surface | attacker-dependency | blast radius |\n` +
    `| --- | --- | --- | --- |\n` +
    `| (each standing Critical) | … | … | … |\n\n` +
    `Advisory only — it does not block this review.`;
  const zh =
    `残余风险：本循环处于 persistently-critical 形态——上一轮工作清单中的 Critical ` +
    `本轮依然存在（本轮 ${a.criticals} 条 Critical），首次发现的速率没有下降（本轮 ` +
    `${a.fresh}，上一轮 ${a.prevFresh}），且未决 Critical 积压没有减少${
      a.prevTruncated
        ? `——但上一轮的工作清单为适配 marker 被截断，因此「积压没有减少」与` +
          `「floor 已在执法」都是从一份已知不完整的清单上读出的`
        : ''
    }。severity floor 无法使其收敛。` +
    `建议：\`${a.recommendation}\`——出口是 maintainer 的风险接受决定（合入并` +
    `承担残余风险），而非再开一轮评审。供该决定使用的残余风险清单（maintainer 填写）：` +
    `按每条未决 Critical 列出「攻击面 · 攻击者依赖性 · 影响范围」三栏。` +
    `仅为建议——不阻断本次评审。`;
  return { en, zh };
}
