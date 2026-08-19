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
  line?: number;
  /** One line, capped — enough for the next round to re-locate the claim. */
  title: string;
}

export interface Ledger {
  v: 1;
  round: number;
  findings: LedgerFinding[];
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
}

/**
 * A usable anchor: abbreviated-to-full hex, matching what `git rev-parse`
 * emits. The parser drops a field that fails this rather than the ledger —
 * the findings are still a work list even when the anchor is garbage — and
 * `fetch-pr --since` additionally verifies the anchor is an ancestor of the
 * fetched head before scoping to it (in the CLI; the orchestrator never runs
 * git against an anchor), so a tampered sha costs a full-range review, never
 * a mis-scoped one.
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

/** Caps keep the marker a footnote, never a payload: GitHub's body limit is
 *  65,536 chars and the marker rides inside it. Every cap binds BOTH halves —
 *  the serializer so the write side is bounded, the parser so a hand-edited
 *  marker cannot exceed what the serializer would have written. */
export const LEDGER_MAX_FINDINGS = 50;
export const LEDGER_MAX_TITLE = 80;
export const LEDGER_MAX_FILE = 200;
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
  const capped = ledger.findings.slice(0, LEDGER_MAX_FINDINGS).map((f) => ({
    ...f,
    id: f.id.slice(0, LEDGER_MAX_ID),
    title: f.title.slice(0, LEDGER_MAX_TITLE),
    file: f.file.slice(0, LEDGER_MAX_FILE),
  }));
  const render = (
    findings: LedgerFinding[],
    dropped: number,
    anchor: boolean,
    volume: 'both' | 'posted' | 'none',
  ): string => {
    const payload: Ledger = {
      v: 1,
      // Mirrored on the write side like every other cap: a serializer that can
      // emit what its own parser refuses would round-trip to nothing.
      round: Math.min(ledger.round, LEDGER_MAX_ROUND),
      findings,
    };
    // The volume telemetry rides OUTSIDE the truncation rule that governs the
    // anchor — it qualifies no range, so a partial work list says nothing
    // about it — but it is the FIRST thing the byte budget sheds (see the
    // cascade below). Bounded like every other written field: a non-integer
    // or negative count is not a volume, and the cap keeps a forged marker
    // from spending the byte budget on digits.
    if (volume !== 'none') {
      const postedOut = volumeOf(ledger.posted);
      if (postedOut !== undefined) payload.posted = postedOut;
      if (volume === 'both') {
        const prevPostedOut = volumeOf(ledger.prevPosted);
        if (prevPostedOut !== undefined) payload.prevPosted = prevPostedOut;
      }
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
  let marker = render(capped, total - kept, true, 'both');
  if (marker.length > LEDGER_MAX_BYTES) {
    // Between "both volumes" and "no volume" there is a rung worth having:
    // the CARRIED value goes first, this round's own count second. The
    // carried one only gives THIS marker a two-round window; `posted` is
    // the next link in the chain — the value the next compose reads back
    // and stamps as its own `prevPosted` — so shedding them as one unit
    // dropped a count that still fitted, and broke the chain a round
    // earlier than the budget required.
    marker = render(capped, total - kept, true, 'posted');
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
    marker = render(capped, total - kept, true, 'none');
  }
  if (marker.length > LEDGER_MAX_BYTES) {
    // Shed the anchor PAIR before any finding: `dropped` withholds the pair
    // the moment a finding goes anyway, so the old order paid a ruling from
    // the work list for bytes the pair alone could have paid. The pair shed
    // first keeps the whole work list — recovery degrades to the full diff,
    // which the findings survive — and findings start going only when the
    // anchorless form still exceeds the cap.
    marker = render(capped, total - kept, false, 'none');
  }
  while (marker.length > LEDGER_MAX_BYTES && kept > 0) {
    kept--;
    marker = render(capped.slice(0, kept), total - kept, false, 'none');
  }
  return marker;
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
    const valid = raw.findings.filter(
      (f): f is LedgerFinding =>
        !!f &&
        typeof f.id === 'string' &&
        // An id claiming a FUTURE round is a squat, not a finding. The
        // pipeline's own ids obey `id round <= marker round` by construction —
        // a round stamps its new findings `R<round>-<n>` and carries older ids
        // forward — so a legitimate marker can never violate this. A foreign
        // one can, and recovery now reads foreign markers: a marker at round N
        // carrying `R<N+1>-*` ids would pre-claim exactly the prefix the next
        // compose stamps, splitting one claim across two ids and renumbering
        // every genuinely new finding past the squatted block. Read-side only,
        // deliberately: the pipeline's one writer stamps
        // `min(prevRound + 1, LEDGER_MAX_ROUND)` (compose-review), so its ids
        // never exceed the round it writes — the coexisting round clamp below
        // cannot reintroduce the mismatch this filter would then hide.
        !(() => {
          const m = /^R(\d+)-/.exec(f.id);
          return m !== null && Number(m[1]) > raw.round;
        })() &&
        (f.sev === 'C' || f.sev === 'S') &&
        typeof f.file === 'string' &&
        typeof f.title === 'string' &&
        (f.line === undefined || Number.isInteger(f.line)),
    );
    const findings = valid
      .slice(0, LEDGER_MAX_FINDINGS)
      // Normalise on READ too: the caps are the serializer's contract, and a
      // hand-edited marker is not bound by it.
      .map((f) => ({
        ...f,
        id: f.id.slice(0, LEDGER_MAX_ID),
        title: f.title.slice(0, LEDGER_MAX_TITLE),
        file: f.file.slice(0, LEDGER_MAX_FILE),
      }));
    const declared =
      Number.isInteger(raw.dropped) && (raw.dropped as number) > 0
        ? (raw.dropped as number)
        : 0;
    // The count cap binds on READ as it does on write: valid entries this
    // parser sliced off ARE dropped findings, and a hand-edited marker whose
    // list was truncated here must not read as complete — nor keep an anchor
    // the serializer's own truncation path would have refused to certify.
    const dropped = declared + (valid.length - findings.length) || undefined;
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
    // The volume fields are normalised on READ exactly as they are bounded
    // on write, and independently of `dropped`: they qualify no range, so a
    // truncated work list has no bearing on them. A shape the serializer
    // would not have written (a float, a negative, a string) simply does not
    // survive — the trend loses a point, which is the whole cost of a field
    // no gate reads.
    const posted = volumeOf(raw.posted);
    const prevPosted = volumeOf(raw.prevPosted);
    return {
      v: 1,
      round: raw.round,
      findings,
      ...(dropped ? { dropped } : {}),
      ...(sha ? { sha } : {}),
      ...(model ? { model } : {}),
      ...(posted === undefined ? {} : { posted }),
      ...(prevPosted === undefined ? {} : { prevPosted }),
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
