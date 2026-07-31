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
  /** Round-scoped id, `R<round>-<n>`. Stable across re-reports. */
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
 *  65,536 chars and the marker rides inside it. */
export const LEDGER_MAX_FINDINGS = 50;
export const LEDGER_MAX_TITLE = 80;

const OPEN = '<!-- qwen-review-ledger ';
const CLOSE = ' -->';

/** Serialize for embedding. `--` never survives into the JSON (it would close
 *  the HTML comment early); JSON.stringify escapes nothing else that could. */
export function serializeLedger(ledger: Ledger): string {
  const capped: Ledger = {
    v: 1,
    round: ledger.round,
    findings: ledger.findings.slice(0, LEDGER_MAX_FINDINGS).map((f) => ({
      ...f,
      title: f.title.slice(0, LEDGER_MAX_TITLE).replace(/--/g, '—'),
      file: f.file.replace(/--/g, '—'),
    })),
  };
  return `${OPEN}${JSON.stringify(capped)}${CLOSE}`;
}

/**
 * Parse the ledger out of a posted review body. Null on absence or ANY
 * malformation — the body is another account's writable surface, and a marker
 * that does not parse contributes nothing rather than throwing.
 */
export function parseLedger(body: string | undefined): Ledger | null {
  if (!body) return null;
  const start = body.indexOf(OPEN);
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
          typeof f.title === 'string',
      )
      .slice(0, LEDGER_MAX_FINDINGS);
    return { v: 1, round: raw.round, findings };
  } catch {
    return null;
  }
}

/** Strip the marker from a body about to be rendered for a model — the JSON
 *  blob is noise there; the parsed copy travels separately. */
export function stripLedgerMarker(body: string): string {
  const start = body.indexOf(OPEN);
  if (start < 0) return body;
  const end = body.indexOf(CLOSE, start);
  if (end < 0) return body;
  return (body.slice(0, start) + body.slice(end + CLOSE.length)).trim();
}
