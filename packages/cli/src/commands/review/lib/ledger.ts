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
}

/** Caps keep the marker a footnote, never a payload: GitHub's body limit is
 *  65,536 chars and the marker rides inside it. Every cap binds BOTH halves —
 *  the serializer so the write side is bounded, the parser so a hand-edited
 *  marker cannot exceed what the serializer would have written. */
export const LEDGER_MAX_FINDINGS = 50;
export const LEDGER_MAX_TITLE = 80;
export const LEDGER_MAX_FILE = 200;

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
  const capped: Ledger = {
    v: 1,
    round: ledger.round,
    findings: ledger.findings.slice(0, LEDGER_MAX_FINDINGS).map((f) => ({
      ...f,
      title: f.title.slice(0, LEDGER_MAX_TITLE),
      file: f.file.slice(0, LEDGER_MAX_FILE),
    })),
  };
  return `${OPEN}${JSON.stringify(capped).replace(/--/g, '-\\u002d')}${CLOSE}`;
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
    return { v: 1, round: raw.round, findings };
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
