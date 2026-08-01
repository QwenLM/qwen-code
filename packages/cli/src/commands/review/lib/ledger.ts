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
}

/** Caps keep the marker a footnote, never a payload: GitHub's body limit is
 *  65,536 chars and the marker rides inside it. Every cap binds BOTH halves —
 *  the serializer so the write side is bounded, the parser so a hand-edited
 *  marker cannot exceed what the serializer would have written. */
export const LEDGER_MAX_FINDINGS = 50;
export const LEDGER_MAX_TITLE = 80;
export const LEDGER_MAX_FILE = 200;

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
    title: f.title.slice(0, LEDGER_MAX_TITLE),
    file: f.file.slice(0, LEDGER_MAX_FILE),
  }));
  const render = (findings: LedgerFinding[], dropped: number): string => {
    const payload: Ledger = { v: 1, round: ledger.round, findings };
    if (dropped > 0) payload.dropped = dropped;
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
  let marker = render(capped, total - kept);
  while (marker.length > LEDGER_MAX_BYTES && kept > 0) {
    kept--;
    marker = render(capped.slice(0, kept), total - kept);
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
    if (raw?.v !== 1 || !Number.isInteger(raw.round) || raw.round < 1) {
      return null;
    }
    if (!Array.isArray(raw.findings)) return null;
    const findings = raw.findings
      .filter(
        (f): f is LedgerFinding =>
          !!f &&
          typeof f.id === 'string' &&
          (f.sev === 'C' || f.sev === 'S') &&
          typeof f.file === 'string' &&
          typeof f.title === 'string' &&
          (f.line === undefined || Number.isInteger(f.line)),
      )
      .slice(0, LEDGER_MAX_FINDINGS)
      // Normalise on READ too: the caps are the serializer's contract, and a
      // hand-edited marker is not bound by it.
      .map((f) => ({
        ...f,
        title: f.title.slice(0, LEDGER_MAX_TITLE),
        file: f.file.slice(0, LEDGER_MAX_FILE),
      }));
    const dropped =
      Number.isInteger(raw.dropped) && (raw.dropped as number) > 0
        ? (raw.dropped as number)
        : undefined;
    return {
      v: 1,
      round: raw.round,
      findings,
      ...(dropped ? { dropped } : {}),
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
