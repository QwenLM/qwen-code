/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The cross-round findings ledger, carried IN the posted review body.
//
// The round ledger began as a local cache file, and its first live use exposed
// the flaw: the cache lives in one clone's `.qwen/review-cache/`, so a re-review
// from CI, another machine, or a fresh checkout opens with amnesia — while the
// one artifact every environment can see, the posted review itself, carried
// nothing machine-readable. This module moves the authoritative copy into the
// review body as an HTML comment: invisible on the PR page, durable as the
// comment itself, and readable by the next round's `pr-context` wherever it
// runs. The local cache remains a fallback for runs that never posted.
//
// The marker is DATA the next round rules on, not authority it obeys: every
// ledger entry is re-asserted against the code by the Step 6 previous-round
// ruling, so a tampered marker costs the review a few wasted rulings, never a
// wrong verdict. Parsing is correspondingly fail-quiet: a body whose marker is
// malformed simply contributes no ledger.

/** One finding the review stands behind, carried to the next round. */
export interface LedgerFinding {
  /**
   * The finding's id. A **new** finding gets `R<round>-<n>`; a finding carried
   * forward from an earlier round keeps the id it already has — Step 6 re-reports
   * a still-standing entry under its original id, and `buildLedger` reads that id
   * back off the comment body, so `R1-2` names the same claim in every round.
   * Renumbering it by position would hand the next round a work list keyed by
   * ids the report it accompanies never used.
   */
  id: string;
  /** `C` (Critical) or `S` (Suggestion). Compact on purpose — body bytes. */
  sev: 'C' | 'S';
  file: string;
  /**
   * Set only when `file` is a LITERAL path that happens to equal one of the
   * stand-in names below — `(body)`, `(unknown)`. Git permits both as
   * filenames, so the sentinels alone cannot separate "no path to give" from
   * "a file with that name", and a reader keying on the value excluded a
   * real file of that name from clustering, silently.
   *
   * The flag marks the EXCEPTION rather than the rule on purpose. Flagging
   * the stand-ins would have cost bytes on every body Critical, which is
   * routine — and this field rides through all four rungs of the shed
   * cascade, where the serializer's own comment prices ~27 bytes of
   * telemetry at a lost anchor or a lost ruling. Flagging the pathological
   * filename instead costs nothing on any normal round, and it lets a marker
   * written before this field existed read correctly: its sentinels carry no
   * flag, which is exactly what they mean.
   */
  k?: 1;
  line?: number;
  /** One line, capped — enough for the next round to re-locate the claim. */
  title: string;
}

/**
 * One Critical that LEFT the work list at round `r`: open in round `r-1`'s
 * marker, absent from round `r`'s. Compact field names (`r`/`f`) on the same
 * body-bytes discipline as the findings.
 */
export interface LedgerClosure {
  /** The round whose marker the finding is absent from. */
  r: number;
  /** The closed finding's id — its ORIGINAL round's id, e.g. `R9-1`. */
  id: string;
  /** The closed finding's file. */
  f: string;
}

export interface Ledger {
  v: 1;
  round: number;
  findings: LedgerFinding[];
  /**
   * The Criticals that LEFT the work list at THIS marker's round — open in
   * the previous round's marker, absent from this one. The divergence
   * sentinel (#9905) reads them: `fixed` and `superseded` both read as
   * closure, a positional diff cannot tell them apart, and the advisory
   * note does not need it to.
   *
   * This round's own minted set only — NO carry-forward: the sentinel's
   * K=2 check reads closures at round N (minted while composing) and N-1
   * (read back off this field), so older entries are dead bytes. Absent on
   * every ledger written before the field existed, which reads as "no
   * closures recorded" and silences the sentinel — the honest posture on
   * thin history.
   */
  closed?: LedgerClosure[];
  /**
   * How many findings the size cap dropped, when it dropped any. Absent means
   * the list is complete — which is the claim the next round acts on, so the
   * incomplete case has to say so rather than look identical to it.
   */
  dropped?: number;
  /**
   * The head commit this round reviewed — the anchor the next round scopes its
   * incremental diff from. This is the marker's second job, and the one the
   * local cache could never do for CI: a fresh environment recovers the
   * previous findings from the posted body but had nowhere to recover "last
   * reviewed at", so its incremental range always degraded to the full diff.
   * Absent on a fail-closed round ON PURPOSE — a run that could not show it
   * READ the whole diff must not hand the next round an anchor that scopes
   * past the part it missed. "Fail-closed" here is the net `ledgerMarkerFor`
   * computes (any undecided blocker, unproven coverage, or any cap in the
   * verdict the module derived other than `unreviewed-dimension` — a
   * dimension nobody could run says nothing about which lines were read), and
   * Step 8's cache-skip rule names the same net for `lastCommitSha` — the two
   * anchors must not disagree about what a clean round is. The findings
   * still ride; only the anchor is withheld.
   *
   * Withheld is not lost when the graft's guards allow the recovery: a
   * fail-closed round's marker carries no `sha`, but recovery (`pr-context`)
   * grafts the anchor forward from the most recent EARLIER own marker that
   * carries one — the withhold is about the fail-closed round's own range,
   * while an earlier round's "clean up to sha" stays true, and scoping the
   * next round `sha..HEAD` re-covers the gap. The graft fires only when the
   * winning work list is complete, the source is a STRICTLY earlier own
   * round, and the walk has a known identity; refused, the withhold stands
   * and later rounds stay full-range until a round re-establishes the chain
   * (issue #9902).
   *
   * It also never crosses accounts: `pr-context` strips it from a marker
   * another account posted, so a foreign body can never decide which lines
   * this pipeline stops looking at.
   */
  sha?: string;
  /**
   * The model that certified `sha` — incremental scoping is a SAME-MODEL
   * contract. "Clean up to the anchor" is one model's verdict: the local
   * cache has always paired its anchor with `lastModelId` and Step 1 refuses
   * the same-SHA shortcut across models, but the marker carried its anchor
   * bare, so a round that recovered it from the posted body would scope
   * `sha..HEAD` past code the CURRENT model never reviewed — permanently,
   * since each clean round re-anchors past the last. Rides and falls WITH
   * the anchor: the serializer withholds it whenever it withholds `sha`
   * (fail-closed or truncated rounds) — and withholds the PAIR when the
   * model itself does not fit the cap, since a truncated id is a prefix and
   * a prefix can equal another model's full id — and the parser drops it
   * when the sha beside it did not survive (or it exceeds the cap) — a
   * model naming no range qualifies nothing.
   */
  model?: string;
  /**
   * Source-diff line count as of the FIRST round that recorded one, carried
   * forward unchanged. A baseline, never re-measured: growth is only legible
   * cumulatively. A change that arrives at 228 source lines and leaves at 920
   * grew 4x, yet only ~1.3x per round across six rounds — a per-round delta
   * would never notice, which is why this is a baseline and not "last round's
   * size".
   *
   * Its only consumer is one advisory paragraph telling a human that the shape
   * of the change, rather than the current patch, may be the open question.
   * Like every other marker field this is untrusted body data, but unlike a
   * finding there is no code to re-assert a bare number against: a forged small
   * value fires the paragraph, a forged large one silences it. That is the
   * entire blast radius — it never reaches a verdict, a cap, or an event.
   *
   * Unlike `sha`, this survives truncation. A partial finding list must not
   * certify a commit range, but it says nothing about how big the diff is, and
   * the measurement is true either way.
   */
  src0?: number;
  /**
   * How many inline comments this round posted — convergence telemetry, and
   * the ONLY field here that decides nothing.
   *
   * Every other field gates something (`findings` is the next round's work
   * list, `sha`/`model` scope its diff, `dropped` withholds that scoping),
   * which is why they all fail closed. These two are read by no gate: they
   * exist so a later round — or a caller applying its own policy — can see
   * whether the loop's posting volume is shrinking, without asking the
   * model or counting a comment list that cannot distinguish this account's
   * rounds from anyone else's. A tampered or absent value costs a trend
   * line and nothing else, so they fail OPEN (absent) rather than
   * withholding anything.
   *
   * Kept across a truncated list on purpose, unlike the anchor pair: a
   * `dropped` work list says the next round cannot scope from here, not
   * that this round posted a different number of comments than it did.
   */
  posted?: number;
  /**
   * The PREVIOUS round's `posted`, carried forward so one marker holds a
   * two-round window: a round reading this marker knows its predecessor's
   * volume AND the one before that, which is the shortest window in which
   * "still shrinking" is a statement rather than a single step. Same
   * fail-open, decides-nothing contract as `posted`.
   */
  prevPosted?: number;
  /**
   * The posting floor this round RESOLVED to — `c` when the critical floor
   * was in effect, `o` when Suggestions were postable.
   *
   * It qualifies `posted`, and travels and sheds with it. Without it the
   * volume trend measures a POSTURE change as loop divergence: an operator
   * who takes this pipeline's own advice and sets `--severity-floor
   * critical` collapses the volume, and restoring it later produces a jump
   * the trend reads as a loop that will not settle — and then advises
   * re-tightening the floor just deliberately loosened. The bias is
   * one-directional (loosening fires it, tightening only shrinks volume),
   * and one transient `contextUnavailable` round under `auto` produces the
   * same spike with no operator action at all.
   *
   * Same fail-open, decides-nothing contract as the volumes: absent means
   * "not recorded", which leaves the trend evaluated as it was before this
   * field existed.
   */
  floor?: 'c' | 'o';
  /**
   * How many of `posted` were findings this round REPORTED FOR THE FIRST
   * TIME — not re-posts of still-standing entries from earlier rounds.
   *
   * The number the convergence trend is actually about. `posted` is the
   * round's whole output, and Step 6 re-posts every unfixed ledger Critical
   * under its original id, so the re-post floor only ever rises: a loop whose
   * NEW findings collapsed from five to one still posts more comments than
   * the round before, and a trend measured on the totals reads that
   * convergence as divergence, permanently. Absent means "not recorded",
   * which leaves the trend unevaluable rather than measured on the wrong
   * number.
   *
   * One accepted seam: the counting RULE changed once — a fix-induced
   * re-report (a carried id fronting a NEW defect) moved from re-post to
   * first-time — and nothing parts an old-rule marker from a new one, on
   * purpose. A loop in flight at the change compares one round counted under
   * each rule for exactly one round; the old rule UNDERCOUNTED (it dropped
   * the marked re-reports), so the mixed comparison can fire the volume
   * advisory spuriously — and, when the undercount reaches 0 because the
   * predecessor's whole new output was re-reports the old rule dropped, the
   * `prev.fresh > 0` restart guard suppresses the comparison, masking the
   * advisory for that one round. Either way the advisory decides
   * nothing, names itself an observation, and heals the round after, when
   * both points are counted under the new rule. A marker version was not
   * paid for that: `parseLedger` refuses any `v` it does not know, so
   * bumping it for a count no gate reads would cost an old reader the WHOLE
   * marker — work list, anchor, streak — the same reason every field added
   * since has degraded by absence instead.
   *
   * Rides and sheds with `posted`, which it qualifies.
   */
  fresh?: number;
  /**
   * How many rounds — this one included — have been counted against the
   * churn bar since the last round measured converging; a round that could
   * not measure carries the count without adding to it. This is the ONE
   * field here that is neither telemetry nor a gate on scope: it is the
   * review's own standing claim about the pull request, carried exactly the
   * way a finding id is, and `compose-review` reads it back to decide
   * whether to file the non-convergence finding.
   *
   * So it does NOT ride in the volume tier that sheds first. It is a single
   * small integer, and the pull request most likely to be churning is also
   * the one whose marker is closest to its byte cap — shedding it there
   * would disarm the mechanism on exactly the pull requests it exists for.
   *
   * It cannot decide alone, and that is deliberate: the body it rides on is
   * another account's writable surface, so `compose-review` files nothing on
   * a recovered streak unless THIS round's own census is also above the bar.
   * Recovery hands this account only its OWN streak besides — a foreign
   * winner's is stripped at the seam (`pr-context`) — so a forged marker
   * plants neither the streak nor the finding.
   */
  churnRounds?: number;
  /**
   * How many consecutive rounds — this one included — the first-time-finding
   * rate did not fall; the streak the severity floor's early trigger reads
   * (#9903). A round whose rate fell resets it to zero — there is no
   * carry-on-unmeasured here, unlike `churnRounds`: the churn streak arms a
   * blocking Critical where late filing loses the mechanism, while this one
   * engages a disclosed, non-capping deferral posture where a FALSE
   * engagement silently defers real Suggestions, so the cheap error is a
   * wiped streak (one delayed engagement), never a carried one.
   *
   * Once the streak reaches the bar it is PINNED, not re-measured: the
   * floor it engages moves fresh Suggestions into the deferral channel, so
   * the posted-set trend the signal reads goes quiet precisely because the
   * floor is working — and re-measuring against a pre-trigger floor
   * assumption would flap engagement at period two through the trend's own
   * `floorChanged` guard. The pin is the latch: later rounds engage on the
   * recorded streak alone until the round-6 rule takes over anyway.
   *
   * Same trust shape as `churnRounds`, whose group it rides in: clamped to
   * the marker's own round at every read, stripped from foreign winners at
   * the `pr-context` seam, and kept out of the volume tier that sheds first
   * — the pull request whose rate never falls is exactly the one whose
   * marker sits at the byte cap. Worst case for a planted streak:
   * Suggestions move into a DISCLOSED deferral list — nothing is withheld,
   * no verdict is capped, and an explicit `--severity-floor suggestion`
   * disengages.
   */
  flatRounds?: number;
  /**
   * The recommendation codes this round's convergence diagnosis matched —
   * the machine-readable half of the observation (#9623), re-published on
   * the one surface an OUTSIDE consumer can reach. The composed result and
   * the durable artifact already carry them, but both live inside this
   * process; the autofix takeover loop reads the posted review body, and
   * without the codes there its only view of "is this loop converging" is
   * prose (#10107).
   *
   * A carrier, not a contract restatement: the closed vocabulary is owned
   * by `RECOMMENDATION_CODES` in `convergence.ts`, and membership is
   * enforced at the ONE write site (`compose-review` passes the codes off
   * `result.recommendations`, which `recommendationsFor` derived — typed,
   * so an out-of-vocabulary code cannot arrive). Spelled `string[]` here
   * because this module is `convergence.ts`'s runtime dependency and the
   * narrow type would close an import cycle for a field this side only
   * bounds and never interprets.
   *
   * Write-only telemetry: `parseLedger` deliberately does not read it back.
   * Nothing CLI-side consumes a PRIOR round's codes — each round re-derives
   * its own from its own diagnosis — and recovering them would hand the
   * next round a value another account's writable surface controls, for no
   * reader. Same rung as the streaks above (small, zero-omitted, above the
   * shed cascade), and for the same reason: the pull request whose loop is
   * not converging is exactly the one whose marker sits at the byte cap.
   */
  rec?: string[];
}

/**
 * A usable anchor: abbreviated-to-full hex, matching what `git rev-parse`
 * emits. The parser drops a field that fails this rather than the ledger —
 * the findings are still a work list even when the anchor is garbage — and
 * `fetch-pr --since` additionally validates the anchor against the fetched
 * history — existence always; ancestry except on Aone, where AGit-Flow
 * amends orphan the cached head (design D7) — before scoping to it (in the
 * CLI; the orchestrator never runs git against an anchor). The published
 * scope is joined against the CR's own diff either way, so a tampered sha
 * costs a full-range review, never a mis-scoped one.
 *
 * Exported because `fetch-pr --since` gates on the SAME shape: an anchor the
 * marker will not carry must not be one the fetch accepts, or a
 * ledger-blessed anchor and a cache-supplied one would be judged by two
 * predicates that can drift (a second, case-insensitive copy shipped once).
 * One answer about the shape, applied at every gate that reads an anchor.
 *
 * Sibling check, deliberately not shared: `repo-context.ts` validates
 * `plan.mergeBaseSha` as a FULL 40/64-char object id and hard-throws — that
 * field comes from the trusted plan and is then resolved via git. This one
 * fail-quietly filters a possibly-abbreviated anchor out of an untrusted
 * body. Two claims, two strictnesses; one shared helper would invite using
 * the loose one where the strict one is meant.
 */
export const SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * Grammar of a ledger finding id (`R<round>-<n>`). Shared by every site
 * that reads carried ids — compose-review's re-post prefix parser and
 * presubmit's carried-id extractor — so the two ends cannot drift: a
 * divergence makes re-posts read as plain overlaps and get dropped,
 * silently re-creating #9208.
 */
export const LEDGER_ID_TOKEN = String.raw`R\d+-\d+`;

/**
 * Prefix-anchored readback of a carried id off the claim line: the write side
 * guarantees the id leads the line right after the severity marker, so the
 * read sides key on that same position. Shared WHOLESALE — terminator
 * included — by compose-review's ledger builder and presubmit's re-post
 * extractor, so the tolerated terminator set cannot drift on one end only
 * (#9212 review). The earlier `\b`-bounded whole-body scan also matched
 * cross-references ("see R3-2 for context") and ids embedded in longer
 * hyphen runs, exempting a re-post under an unrelated thread.
 */
export const LEDGER_ID_READBACK = new RegExp(
  `^(${LEDGER_ID_TOKEN})[:.)\\]]?(?=\\s|$)\\s*`,
);

/**
 * The id as a WHOLE string — nothing before it, nothing after. The one
 * admission test, shared with presubmit's entry check.
 *
 * Anchored at both ends on purpose. A prefix-only test (`^R\d+-`) admitted
 * ids the readers then interpreted differently from the test: every reader
 * downstream trims before matching (`birthRound`, `readClaim`), so ` R9999-1`
 * failed the untrimmed squat filter, was therefore never dropped, and read as
 * round 9999 everywhere it mattered — pre-claiming the next round's id prefix
 * and citing a round no account ever ran.
 */
export const LEDGER_ID_SHAPE = new RegExp(`^${LEDGER_ID_TOKEN}$`);

/**
 * The claim LOCATOR of a work-list entry or a built finding's title: the
 * carried id stripped through the readback above, the part before the first
 * ' — ' kept, backticks gone. Stated once because every consumer that joins
 * claims by it — the gate-repost dedup, the closure mint (#9905), and the
 * successor chain's fresh side — must project the SAME shape, and a second
 * spelling is the drift class this module's header exists to prevent.
 */
export function claimLocator(entry: string): string {
  const claim = entry.trim().replace(LEDGER_ID_READBACK, '').trim();
  const dash = claim.indexOf(' — ');
  // Backticks stripped: the gate renders the path through `mdField`, and a
  // re-post that types the locator plainly names the same finding.
  return (dash === -1 ? claim : claim.slice(0, dash)).replace(/`/g, '').trim();
}

/** Caps keep the marker a footnote, never a payload: GitHub's body limit is
 *  65,536 chars and the marker rides inside it. Every cap binds BOTH halves —
 *  the serializer so the write side is bounded, the parser so a hand-edited
 *  marker cannot exceed what the serializer would have written. */
export const LEDGER_MAX_FINDINGS = 50;
export const LEDGER_MAX_TITLE = 80;
export const LEDGER_MAX_FILE = 200;
/**
 * The pseudo-paths a finding carries when it has no file to name: a body-only
 * Critical anchors to the review body itself, and a drafted comment that
 * arrived without a path anchors to nothing at all.
 *
 * Named here because BOTH ends must agree. The ledger builder stamps them into
 * `findings[].file`, and every reader that must not treat them as real files
 * compares against them — the convergence join excludes them from clustering.
 * Spelled as bare literals on each end, a rename on one end alone turns a
 * pseudo-path into an ordinary file the reader clusters on and NAMES in a
 * posted paragraph: the same two-ends drift the shared id constants above
 * exist to prevent.
 */
export const LEDGER_BODY_FILE = '(body)';
export const LEDGER_UNKNOWN_FILE = '(unknown)';

/**
 * Is this path spelled like one of the stand-ins? The one place that
 * question is asked, so the writer's exception flag and the reader's
 * exclusion cannot disagree about which names need disambiguating.
 */
export function isStandInName(file: string): boolean {
  return file === LEDGER_BODY_FILE || file === LEDGER_UNKNOWN_FILE;
}
/**
 * The longest model id the marker can carry — and it carries one WHOLE or
 * not at all: a truncated id is a prefix, and a prefix can equal a DIFFERENT
 * model's full id, which the same-model gate would then accept past code it
 * never reviewed. An id over this cap takes the whole anchor pair with it,
 * degrading recovery to the full diff — the fail-safe direction. Real ids run
 * short even qualified by their provider (`qwen3.7-max@1a2b3c4d` — the model,
 * `@`, and eight hex); the cap bounds the marker, not them.
 */
export const LEDGER_MAX_MODEL = 64;
/**
 * The id, capped like every other field it travels with.
 *
 * It was the one field with no bound, which was survivable while only this
 * account's own markers were ever parsed. Recovery now crosses accounts, so
 * the read path takes text any GitHub user can post: an id is a short label
 * (`R2-1`), and anything longer is not one.
 */
export const LEDGER_MAX_ID = 24;
/**
 * The closure list's bound. One round's closures are bounded by the previous
 * work list's size (`LEDGER_MAX_FINDINGS`), so fifty covers every mintable
 * round; the cap exists for the hand-edited marker, which is bound by no
 * mint. The byte cap below still binds the whole marker either way.
 */
export const LEDGER_MAX_CLOSED = 50;
/**
 * The highest round a marker may claim.
 *
 * The round is not decoration: `compose-review` stamps this round's findings
 * `R<round + 1>-<n>`, so the number IS the id space. Recovery now prefers the
 * highest round it can find — the counter only ever advances, so that is what
 * keeps ids monotonic across accounts — which means an unbounded round from
 * any poster wins every recovery from then on. At 2^53 the increment stops
 * advancing in float64 and every subsequent round re-stamps the same ids
 * against different findings. Ten thousand rounds is far past any real PR and
 * far short of where the arithmetic breaks.
 */
export const LEDGER_MAX_ROUND = 10_000;

/**
 * The volume fields' ceiling. A round posting more than this many inline
 * comments is past anything the API or a human review surface tolerates, and
 * the cap exists for the same reason the round's does: the number is written
 * from a count this module does not own, and an unbounded one spends the
 * marker's byte budget on digits.
 */
export const LEDGER_MAX_VOLUME = 100_000;

/**
 * The ONE reading of a volume field: a non-negative whole number, clamped to
 * the cap — or `undefined` for anything else.
 *
 * Shared by every boundary that reads one (the serializer, the parser, and
 * `compose-review`'s side-file recovery) because the shape check and the
 * clamp have to travel together: a boundary that validated without clamping
 * let one compose emit an uncapped number to its terminal line while its own
 * marker recorded the capped one — two outputs of a single round disagreeing
 * about the same count.
 *
 * Zero survives on purpose: "this round posted nothing" is exactly the
 * observation a convergence trend is looking for, and dropping it would make
 * a converged round indistinguishable from one that never recorded a volume.
 */
export function volumeOf(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
    ? Math.min(n, LEDGER_MAX_VOLUME)
    : undefined;
}

/**
 * The ONE reading of the churn streak: a non-negative whole number of rounds,
 * clamped to the round cap it shares a domain with — or `undefined`.
 *
 * Separate from `volumeOf` because the ceilings mean different things: a
 * volume is a comment count and caps where a review surface stops being one;
 * a streak counts ROUNDS, and past `LEDGER_MAX_ROUND` the same float64
 * argument that bounds `round` applies to it unchanged.
 */
export function streakOf(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
    ? Math.min(n, LEDGER_MAX_ROUND)
    : undefined;
}

/**
 * Bounds on the recommendation-code carrier (`Ledger.rec`). The vocabulary
 * is closed at the write site; these bound only the SHAPE, so a value the
 * vocabulary could never contain cannot spend the byte budget. Eight is
 * twice the design's emitted set; forty covers the longest code in the
 * design's full menu with room for a successor vocabulary.
 */
export const LEDGER_MAX_REC_CODES = 8;
export const LEDGER_MAX_REC_CODE = 40;

/**
 * ...and a cap on the WHOLE marker, because the per-field ones do not bound it:
 * fifty findings at full width serialize to just under 17,000 characters.
 *
 * The budget is set against measurement, not against the 65,536 body limit.
 * Across every review this pipeline has posted on its own stack (n=66), the
 * body runs a median of 721 characters, p90 2,178, max 3,925 — so the limit
 * has ~61 KiB of headroom and an over-long marker was never going to 422 the
 * post. What the 17,000 would do is put four times more invisible payload than
 * visible review into the comment, and "footnote, never a payload" is the
 * claim the paragraph above makes. 8 KiB holds the largest ledger a real round
 * has produced without truncating anything, and stays about twice the biggest
 * body observed rather than four times it.
 */
export const LEDGER_MAX_BYTES = 8192;

const OPEN = '<!-- qwen-review-ledger ';
const CLOSE = ' -->';

/**
 * Serialize for embedding, capped and comment-safe.
 *
 * `--` would close the HTML comment early and spill the tail onto the PR page
 * as visible text, so none may survive into the payload. The escape is applied
 * at the JSON layer rather than by rewriting the data: the second dash becomes
 * a `\u002d` escape, which parses back to a literal `-`, so a title quoting
 * `--comment` reaches the next round verbatim — where the earlier rewrite to an
 * em dash delivered `—comment`, on a work list whose whole job is to re-locate
 * the claim it names. Escaping the serialized text also means a field added to
 * `Ledger` later cannot reintroduce the hazard by being forgotten below.
 */
export function serializeLedger(ledger: Ledger): string {
  const roundOut = Math.min(ledger.round, LEDGER_MAX_ROUND);
  const capped = ledger.findings
    // Admitted BEFORE anything is sliced, the way the parse side does it. An
    // over-long id cut at the cap can still match the grammar — `R3-` plus
    // twenty-two nines slices to a well-formed twenty-four — so validating
    // after the slice emitted a DIFFERENT id under the same entry: the next
    // round's readback of the posted claim line returns the full id, matches
    // no ledger entry, and the finding retires with no ruling while the list
    // reads as complete and the anchor still scopes past it. A carried id the
    // model minted out of range (`R0-1`) is refused here for the same reason.
    .filter((f) => isLedgerFinding(f, roundOut))
    .slice(0, LEDGER_MAX_FINDINGS)
    .map((f) => ({
      ...f,
      // Length-safe by construction now: the admission test bounds the id,
      // so this slice can only be a no-op on it.
      id: f.id.slice(0, LEDGER_MAX_ID),
      title: f.title.slice(0, LEDGER_MAX_TITLE),
      file: f.file.slice(0, LEDGER_MAX_FILE),
    }));
  const render = (
    findings: LedgerFinding[],
    dropped: number,
    anchor: boolean,
    volume: 'both' | 'posted' | 'none',
    closures: boolean,
  ): string => {
    const payload: Ledger = {
      v: 1,
      // Mirrored on the write side like every other cap: a serializer that can
      // emit what its own parser refuses would round-trip to nothing.
      round: roundOut,
      findings,
    };
    // The closure list rides with the findings but is NOT one of them: it
    // feeds an advisory note, so the byte budget sheds it ahead of the
    // anchor pair and the work list (see the cascade below), and shedding
    // it never sets `dropped` — closures certify no range, so there is no
    // completeness claim to protect. Newest-kept, like the findings.
    if (closures) {
      const closedOut = (ledger.closed ?? [])
        .filter((c) => isLedgerClosure(c, roundOut))
        .slice(-LEDGER_MAX_CLOSED)
        .map((c) => ({
          r: c.r,
          id: c.id.slice(0, LEDGER_MAX_ID),
          f: c.f.slice(0, LEDGER_MAX_FILE),
        }));
      if (closedOut.length > 0) payload.closed = closedOut;
    }
    // The volume telemetry rides OUTSIDE the truncation rule that governs the
    // anchor — it qualifies no range, so a partial work list says nothing
    // about it — but it is the FIRST thing the byte budget sheds (see the
    // cascade below). Bounded like every other written field: a non-integer
    // or negative count is not a volume, and the cap keeps a forged marker
    // from spending the byte budget on digits.
    if (volume !== 'none') {
      const postedOut = volumeOf(ledger.posted);
      if (postedOut !== undefined) payload.posted = postedOut;
      // The floor and the fresh count qualify `posted`, so they ride with the
      // volume that actually SURVIVED — not merely with the rung that admits
      // the group. A volume that fails `volumeOf` leaves them qualifying
      // nothing, which is bytes spent on this same ladder that the parser
      // then discards.
      if (postedOut !== undefined) {
        if (ledger.floor === 'c' || ledger.floor === 'o') {
          payload.floor = ledger.floor;
        }
        const freshOut = volumeOf(ledger.fresh);
        if (freshOut !== undefined) payload.fresh = freshOut;
      }
      if (volume === 'both') {
        const prevPostedOut = volumeOf(ledger.prevPosted);
        if (prevPostedOut !== undefined) payload.prevPosted = prevPostedOut;
      }
    }
    // The streak rides ABOVE the shed cascade — see the field's own note. It
    // is bounded like the round it counts (same domain, same arithmetic
    // hazard past the cap) and omitted at zero, so a converging pull request
    // spends no bytes on it at all.
    const streak = streakOf(ledger.churnRounds);
    if (streak !== undefined && streak > 0) payload.churnRounds = streak;
    // Same rung, same bound, same zero-omission for the floor trigger's
    // streak — the pull request whose rate never falls is exactly the one
    // whose marker sits at the byte cap.
    const flat = streakOf(ledger.flatRounds);
    if (flat !== undefined && flat > 0) payload.flatRounds = flat;
    // The recommendation codes ride the streak rung — same size class, same
    // zero-omission, and the same argument for sitting above the shed
    // cascade. Bounded here the way every written field is: membership
    // belongs to the write site (see `Ledger.rec`); this bounds only the
    // shape, deduplicated in first-seen order so a repeated code cannot
    // spend the budget twice.
    if (Array.isArray(ledger.rec)) {
      const rec = [
        ...new Set(
          ledger.rec.filter(
            (c): c is string =>
              typeof c === 'string' &&
              c.length > 0 &&
              c.length <= LEDGER_MAX_REC_CODE,
          ),
        ),
      ].slice(0, LEDGER_MAX_REC_CODES);
      if (rec.length > 0) payload.rec = rec;
    }
    if (dropped > 0) payload.dropped = dropped;
    // A truncated list must not certify a range: the dropped entries reference
    // code at or before the anchored head, and a next round scoped to
    // `sha..HEAD` would never re-see it — Step 6 rules only on entries that
    // are IN the work list, so they would retire silently. A partial ledger
    // keeps its findings and loses its anchor, exactly as a fail-closed round
    // does.
    else if (anchor && ledger.sha && SHA_RE.test(ledger.sha)) {
      // The same-model qualifier travels only beside the anchor it qualifies
      // — and only WHOLE: a truncated id is a prefix, and a prefix can equal
      // a DIFFERENT model's full id, which the gate would then accept past
      // code it never reviewed. A model that does not fit takes the anchor
      // pair with it; recovery degrades to the full diff.
      const model = ledger.model?.trim();
      if (model === undefined || model.length <= LEDGER_MAX_MODEL) {
        payload.sha = ledger.sha;
        if (model) payload.model = model;
      }
    }
    // Unconditional, unlike `sha` above: the ruling that withholds an anchor
    // from a partial list does not extend to a measurement of the diff. ~12
    // bytes against LEDGER_MAX_BYTES, and losing it would silently reset a
    // baseline the next round cannot recompute.
    if (Number.isInteger(ledger.src0) && (ledger.src0 as number) > 0) {
      payload.src0 = ledger.src0;
    }
    return `${OPEN}${JSON.stringify(payload).replace(/--/g, '-\\u002d')}${CLOSE}`;
  };
  // Drop from the END until the whole marker fits. Trailing entries are the
  // highest-numbered, which within a round is the order they were written; a
  // ledger short by its tail is still a work list, a marker that pushes the
  // body past the API's limit is no review at all. The count of what went
  // travels with it, because a list the next round reads as complete and
  // silently is not one is the failure this whole module is built against.
  // Both caps count, not just the byte one. `dropped` exists so a truncated
  // list cannot read as complete, and measuring it against `capped` rather than
  // against what came IN made it under-report by exactly the count cap's share:
  // 51 findings in, 24 kept, and it said 26 missing.
  const total = ledger.findings.length;
  let kept = capped.length;
  let marker = render(capped, total - kept, true, 'both', true);
  if (marker.length > LEDGER_MAX_BYTES) {
    // Between "both volumes" and "no volume" there is a rung worth having:
    // the CARRIED value goes first, this round's own count second. The
    // carried one only gives THIS marker a two-round window; `posted` is
    // the next link in the chain — the value the next compose reads back
    // and stamps as its own `prevPosted` — so shedding them as one unit
    // dropped a count that still fitted, and broke the chain a round
    // earlier than the budget required.
    marker = render(capped, total - kept, true, 'posted', true);
  }
  if (marker.length > LEDGER_MAX_BYTES) {
    // The VOLUME sheds first — it is the only thing here that decides
    // nothing, and its absence is a documented, free reading ("not
    // recorded"). Everything below it buys something the next round spends:
    // the anchor scopes that round's diff, and a finding is a ruling it
    // owes. Written unconditionally, ~27 bytes of telemetry could push a
    // marker that fit WITH its anchor over the cap and make the re-render
    // pay with the anchor instead — trading a full-diff re-review for a
    // trend line.
    marker = render(capped, total - kept, true, 'none', true);
  }
  if (marker.length > LEDGER_MAX_BYTES) {
    // The closure list sheds next: it feeds the sentinel's advisory note,
    // and losing it costs one round of lineage, while everything below it
    // — the anchor, the work list — is a claim the next round acts on.
    marker = render(capped, total - kept, true, 'none', false);
  }
  if (marker.length > LEDGER_MAX_BYTES) {
    // Shed the anchor PAIR before any finding: `dropped` withholds the pair
    // the moment a finding goes anyway, so the old order paid a ruling from
    // the work list for bytes the pair alone could have paid. The pair shed
    // first keeps the whole work list — recovery degrades to the full diff,
    // which the findings survive — and findings start going only when the
    // anchorless form still exceeds the cap.
    marker = render(capped, total - kept, false, 'none', false);
  }
  while (marker.length > LEDGER_MAX_BYTES && kept > 0) {
    kept--;
    marker = render(capped.slice(0, kept), total - kept, false, 'none', false);
  }
  return marker;
}

/**
 * Is this a ledger finding this pipeline would admit, against the round the
 * marker (or side file) claims?
 *
 * The ONE admission test. `parseLedger` applies it to a marker recovered from
 * a posted body; `compose-review`'s side-file read applies it to the JSON
 * `pr-context` wrote — the same untrusted shape arriving by a different
 * route. That read restated two of these checks and skipped the rest, which
 * is how a side file written before the id hardening could keep an id the
 * marker path now rejects and publish a round number off it: a reader that
 * trims is only as strict as the admission test in front of it.
 */
export function isLedgerFinding(
  f: unknown,
  markerRound: number,
): f is LedgerFinding {
  const c = f as LedgerFinding | null | undefined;
  if (!c || typeof c.id !== 'string') return false;
  // The WHOLE shape, before anything reads a round out of it. A prefix-only
  // test admitted ids the readers then interpreted differently from the test:
  // every reader downstream trims before matching, so ` R9999-1` failed the
  // untrimmed squat rule that exists to stop it and took full effect
  // everywhere else.
  if (!LEDGER_ID_SHAPE.test(c.id)) return false;
  // The length cap belongs to the admission test, not only to the two
  // slices: an over-long id admitted here is one the normalizer then CUTS,
  // and a cut id is a different id — the entry silently changes identity
  // between the round that posted it and the round that rules on it.
  if (c.id.length > LEDGER_MAX_ID) return false;
  // An id claiming a FUTURE round is a squat, not a finding. The pipeline's
  // own ids obey `id round <= marker round` by construction — a round stamps
  // its new findings `R<round>-<n>` and carries older ids forward — so a
  // legitimate marker can never violate this. A foreign one can, and recovery
  // reads foreign markers: a marker at round N carrying `R<N+1>-*` ids would
  // pre-claim exactly the prefix the next compose stamps, splitting one claim
  // across two ids and renumbering every genuinely new finding past the
  // squatted block.
  //
  // Bounded by the CAP as well as by the claimed round, because the claimed
  // round is not always one the caller clamped: the side file's is whatever
  // was written to it, and an unbounded id round is printed verbatim in a
  // public body ("findings in round 100000000000000000000").
  const idRound = Number(c.id.slice(1).split('-')[0]);
  if (!Number.isSafeInteger(idRound)) return false;
  // Both ends. Rounds start at 1, so `R0-*` is not an id this pipeline can
  // mint — but it passes the shape, and every reader that turns an id into a
  // round rejects round 0 and then treats the rejection as "no carried id",
  // i.e. as FRESH. Admitted, a re-posted `R0-1` counts as first-time work
  // every round, and the trend narrates divergence at a fully settled steady
  // state forever.
  if (idRound < 1) return false;
  if (idRound > Math.min(markerRound, LEDGER_MAX_ROUND)) return false;
  return (
    (c.sev === 'C' || c.sev === 'S') &&
    typeof c.file === 'string' &&
    typeof c.title === 'string' &&
    (c.line === undefined || Number.isInteger(c.line))
  );
}

/**
 * Is this a closure entry this pipeline would admit, against the round the
 * marker claims? The same rules as the findings, minus the fields a closure
 * does not carry: the caps bind on read as on write, a closure claiming a
 * round past the marker's own is a squat — the marker's round IS the newest
 * state it can describe — and the id obeys the SAME grammar and id-round
 * bounds `isLedgerFinding` applies in this file. Skipping them here let a
 * hand-edited or forged marker plant arbitrary ≤24-char tokens — an empty
 * string, `R9999-1` spelling a round nobody ran, a live link or mention —
 * into the posted advisory and the machine-readable `basis`, through the
 * route whose comment names the planted-marker threat.
 */
export function isLedgerClosure(
  c: unknown,
  markerRound: number,
): c is LedgerClosure {
  const e = c as LedgerClosure | null | undefined;
  if (
    !e ||
    typeof e !== 'object' ||
    !Number.isInteger(e.r) ||
    e.r < 1 ||
    e.r > markerRound ||
    typeof e.id !== 'string' ||
    e.id.length > LEDGER_MAX_ID ||
    !LEDGER_ID_SHAPE.test(e.id) ||
    typeof e.f !== 'string' ||
    e.f === '' ||
    e.f.length > LEDGER_MAX_FILE
  ) {
    return false;
  }
  const idRound = Number(e.id.slice(1).split('-')[0]);
  if (!Number.isSafeInteger(idRound)) return false;
  if (idRound < 1 || idRound > Math.min(markerRound, LEDGER_MAX_ROUND)) {
    return false;
  }
  // The id must also be OLDER than the closure: a closure at round r
  // records a finding still OPEN in round r-1's work list, so its mint
  // round is strictly below r — equality is only possible at the round cap,
  // where consecutive rounds re-stamp the same `R<cap>-*` space. The mint
  // (compose-review) copies ids out of the recovered work list, so its own
  // output cannot violate this; the cross-check binds the hand-edited and
  // planted routes, where an `idRound >= r` entry seeds the chain join with
  // a generation that never stood open.
  return idRound < e.r || e.r >= LEDGER_MAX_ROUND;
}

/**
 * A finding normalised to the caps the serializer writes under. Applied on
 * READ too: the caps are the serializer's contract, and neither a
 * hand-edited marker nor a side file is bound by it.
 */
export function normalizeLedgerFinding(f: LedgerFinding): LedgerFinding {
  const { k: _k, ...rest } = f;
  return {
    ...rest,
    id: f.id.slice(0, LEDGER_MAX_ID),
    title: f.title.slice(0, LEDGER_MAX_TITLE),
    file: f.file.slice(0, LEDGER_MAX_FILE),
    // Normalised to absent, never used to REJECT the entry. `k` is a
    // clustering hint that decides nothing, and the marker is a
    // cross-environment carrier by design: a later version adding a third
    // kind, a hand edit, or a foreign marker would otherwise make every
    // older CLI drop those findings from the work list — they would owe no
    // Step 6 ruling and retire with nobody ruling on them. Its
    // decides-nothing siblings (`posted`, `prevPosted`, `floor`) are all
    // normalised the same way.
    ...(f.k === 1 ? { k: 1 as const } : {}),
  };
}

/**
 * Parse the ledger out of a posted review body. Null on absence or ANY
 * malformation — the body is another account's writable surface, and a marker
 * that does not parse contributes nothing rather than throwing.
 */
export function parseLedger(body: string | undefined): Ledger | null {
  if (!body) return null;
  // LAST marker, not the first: an edited or quote-carrying body can hold more
  // than one, and the newest round is the one that describes the current state.
  const start = body.lastIndexOf(OPEN);
  if (start < 0) return null;
  const end = body.indexOf(CLOSE, start);
  if (end < 0) return null;
  try {
    const raw = JSON.parse(body.slice(start + OPEN.length, end)) as Ledger;
    if (
      raw?.v !== 1 ||
      !Number.isInteger(raw.round) ||
      raw.round < 1 ||
      raw.round > LEDGER_MAX_ROUND
    ) {
      return null;
    }
    if (!Array.isArray(raw.findings)) return null;
    const valid = raw.findings.filter((f): f is LedgerFinding =>
      isLedgerFinding(f, raw.round),
    );
    const findings = valid
      .slice(0, LEDGER_MAX_FINDINGS)
      .map(normalizeLedgerFinding);
    // Clamped through the shared reader like every other number here. It
    // was the one field admitted unbounded, and it is no longer internal:
    // it renders into the model-facing PARTIAL line and publishes the
    // "may be an undercount" caveat, so a forged `1e308` instructs the model
    // to hedge about findings that never existed — and unlike a forged
    // finding, a forged count cannot be re-ruled.
    const declared = volumeOf(raw.dropped) ?? 0;
    // The count cap binds on READ as it does on write: valid entries this
    // parser sliced off ARE dropped findings, and a hand-edited marker whose
    // list was truncated here must not read as complete — nor keep an anchor
    // the serializer's own truncation path would have refused to certify.
    // Both losses count, not only the cap's. Entries this parser's own
    // filter rejected are findings the next round will never rule on, and a
    // list short by them must not read as complete — nor keep an anchor the
    // serializer's truncation path would have refused to certify. The
    // filter's share was uncounted while the reasons to reject were few and
    // pipeline-impossible; it is now the larger share, and `dropped` is no
    // longer internal — it publishes the "may be an undercount" caveat.
    // The SUM is clamped, not merely the declared term: `raw.findings.length`
    // is attacker-chosen (a body of ~32,700 single-character invalid entries
    // fits GitHub's limit), and the total is interpolated verbatim into the
    // model-facing PARTIAL line — a forged count instructing the model to
    // hedge about findings that never existed, which unlike a forged finding
    // cannot be re-ruled.
    const rejected = raw.findings.length - valid.length;
    const dropped =
      volumeOf(declared + rejected + (valid.length - findings.length)) ||
      undefined;
    const sha =
      // Normalised on READ as the serializer holds on WRITE: a hand-edited
      // marker carrying both `dropped` and `sha` would certify a range its
      // own work list admits is partial.
      typeof raw.sha === 'string' && SHA_RE.test(raw.sha) && !dropped
        ? raw.sha
        : undefined;
    const rawModel = typeof raw.model === 'string' ? raw.model.trim() : '';
    const model =
      // Anchored-only on READ as on WRITE: a model beside no surviving sha
      // qualifies no range, and a hand-edited marker must not make it look
      // as if it did. Whole or not at all here too: an over-cap model is one
      // the serializer would never have written — drop it, and the gate
      // reads the absence as a mismatch.
      sha && rawModel !== '' && rawModel.length <= LEDGER_MAX_MODEL
        ? rawModel
        : undefined;
    // Survives truncation on read as it does on write — a partial list still
    // measured the same diff. Anything that is not a positive integer is
    // dropped, so a garbled baseline degrades to "unknown" (silence) rather
    // than to a number that would read as no growth.
    const src0 =
      Number.isInteger(raw.src0) && (raw.src0 as number) > 0
        ? (raw.src0 as number)
        : undefined;
    // The volume fields are normalised on READ exactly as they are bounded
    // on write, and independently of `dropped`: they qualify no range, so a
    // truncated work list has no bearing on them. A shape the serializer
    // would not have written (a float, a negative, a string) simply does not
    // survive — the trend loses a point, which is the whole cost of a field
    // no gate reads.
    const posted = volumeOf(raw.posted);
    const prevPosted = volumeOf(raw.prevPosted);
    // The streak survives a truncated work list for the same reason the
    // volumes do — it qualifies no range — and it is the field the
    // non-convergence rule reads. Clamped on read as on write; a shape
    // the serializer would not have written does not survive. Clamped to
    // the marker's own ROUND too:
    // the streak counts rounds INSIDE the round it rides, and the pipeline's
    // own writes advance it at most once per round, so a legitimate marker
    // can never carry more counted rounds than rounds it claims. The marker
    // body is any GitHub user's writable surface, and an unclamped streak
    // inflates the posted ordinal ("the 10000th round…") past everything the
    // pull request ever ran. Same invariant the finding-id filter enforces
    // above: a claim about rounds that did not exist is not read.
    const churnRounds = Math.min(streakOf(raw.churnRounds) ?? 0, raw.round);
    // Same read for the floor trigger's streak — with the honest-maximum
    // clamp `prevLedgerFacts` applies on the other route into the trigger:
    // the signal that advances the streak gates on round >= 3, so at round
    // N no honest marker carries more than N - 2, and a planted one
    // claiming more would engage the floor off rounds the signal could
    // never have measured.
    const flatRounds = Math.min(
      streakOf(raw.flatRounds) ?? 0,
      Math.max(raw.round - 2, 0),
    );
    // The floor qualifies `posted`, so it survives only beside it: a floor
    // alone would let a later round compare postures across rounds whose
    // volumes it does not have, which is not a comparison anyone can act on.
    const floor =
      posted !== undefined && (raw.floor === 'c' || raw.floor === 'o')
        ? raw.floor
        : undefined;
    // Bounded by the total it is a part of: a "fresh" count exceeding the
    // round's whole output is not a count of anything, and a forged one
    // would let a marker's trend beat a real one's.
    const freshRaw = posted === undefined ? undefined : volumeOf(raw.fresh);
    const fresh =
      freshRaw !== undefined && posted !== undefined && freshRaw <= posted
        ? freshRaw
        : undefined;
    // The closure history, validated like the findings: the caps and the
    // round bind on read as on write. No `dropped` counterpart — closures
    // certify nothing, so a truncated history has no completeness claim to
    // protect, and the sentinel reads absence as silence either way.
    const closed = (Array.isArray(raw.closed) ? raw.closed : [])
      .filter((c): c is LedgerClosure => isLedgerClosure(c, raw.round))
      .slice(-LEDGER_MAX_CLOSED);
    // `rec` is deliberately NOT recovered — write-only telemetry for the
    // workflow consumer, per the field's own note: every round re-derives
    // its own codes, and reading a prior round's back would hand this
    // account a value another account's writable surface controls.
    return {
      v: 1,
      round: raw.round,
      findings,
      ...(closed.length > 0 ? { closed } : {}),
      ...(dropped ? { dropped } : {}),
      ...(sha ? { sha } : {}),
      ...(model ? { model } : {}),
      ...(src0 ? { src0 } : {}),
      ...(posted === undefined ? {} : { posted }),
      ...(prevPosted === undefined ? {} : { prevPosted }),
      ...(churnRounds === 0 ? {} : { churnRounds }),
      ...(flatRounds === 0 ? {} : { flatRounds }),
      ...(floor === undefined ? {} : { floor }),
      ...(fresh === undefined ? {} : { fresh }),
    };
  } catch {
    return null;
  }
}

/**
 * Strip the marker from a body about to be rendered for a model — the JSON
 * blob is noise there; the parsed copy travels separately.
 *
 * EVERY marker, not the first. `parseLedger` deliberately reads the LAST one
 * because an edited or quote-carrying body can hold more than one, so a
 * stripper that removed only the first left exactly the marker the parser
 * trusts sitting in the model-facing prose — and left a canonical LGTM
 * unmatched by its `^…$`-anchored filter, which is the no-op-round noise the
 * filter exists to remove.
 */
export function stripLedgerMarker(body: string): string {
  let out = body;
  for (;;) {
    const start = out.indexOf(OPEN);
    if (start < 0) break;
    const end = out.indexOf(CLOSE, start);
    // An unterminated marker is not a marker: leave the tail alone rather than
    // truncating a body at a stray `<!-- qwen-review-ledger`.
    if (end < 0) break;
    out = out.slice(0, start) + out.slice(end + CLOSE.length);
  }
  return out === body ? body : out.trim();
}
