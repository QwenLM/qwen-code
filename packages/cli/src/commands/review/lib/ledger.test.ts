/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The marker rides inside a posted review body — another account's writable
// surface — so the parse half is tested as an untrusted-input boundary: every
// malformation contributes nothing, and nothing throws.

import { describe, it, expect } from 'vitest';
import {
  serializeLedger,
  parseLedger,
  stripLedgerMarker,
  LEDGER_MAX_FINDINGS,
  LEDGER_MAX_FILE,
  LEDGER_MAX_TITLE,
  LEDGER_MAX_BYTES,
  type Ledger,
} from './ledger.js';

const LEDGER: Ledger = {
  v: 1,
  round: 2,
  findings: [
    { id: 'R2-1', sev: 'C', file: 'src/a.ts', line: 10, title: 'off by one' },
    { id: 'R2-2', sev: 'S', file: 'src/b.ts', title: 'untested guard' },
  ],
};

describe('ledger marker', () => {
  it('caps the WHOLE marker, not just each field, and says what it dropped', () => {
    // The per-field caps leave the total unbounded: fifty findings at full
    // width serialize to ~17,000 characters, four times the largest review
    // body this pipeline has ever posted (measured: n=66, max 3,925). The
    // marker is billed as a footnote; this is what makes it one.
    const wide = {
      v: 1 as const,
      round: 9,
      findings: Array.from({ length: LEDGER_MAX_FINDINGS }, (_, i) => ({
        id: `R9-${i}`,
        sev: 'C' as const,
        file: 'p/'.repeat(100).slice(0, LEDGER_MAX_FILE),
        line: 99999,
        title: 'x'.repeat(LEDGER_MAX_TITLE),
      })),
    };
    const marker = serializeLedger(wide);
    expect(marker.length).toBeLessThanOrEqual(LEDGER_MAX_BYTES);
    const back = parseLedger(`review body\n\n${marker}`);
    // Nothing is lost silently: what was kept plus what was dropped is what
    // went in, and `dropped` is what tells the next round the list is partial.
    expect(back!.findings.length + back!.dropped!).toBe(LEDGER_MAX_FINDINGS);
    expect(back!.dropped).toBeGreaterThan(0);
  });

  it('counts BOTH caps as dropped, not just the byte one', () => {
    // `LEDGER_MAX_FINDINGS` truncates before the byte cap ever runs. Measuring
    // `dropped` against the already-sliced list made it under-report by
    // exactly that share: 51 in, 24 kept, and it said 26 missing. The number
    // the next round reads has to be the number that went missing.
    const mk = (n: number, wide: boolean) => ({
      v: 1 as const,
      round: 2,
      findings: Array.from({ length: n }, (_, i) => ({
        id: `R2-${i}`,
        sev: 'S' as const,
        file: wide ? 'p/'.repeat(100).slice(0, LEDGER_MAX_FILE) : 'a.ts',
        line: i,
        title: wide ? 'x'.repeat(LEDGER_MAX_TITLE) : 't',
      })),
    });
    // count cap only, byte cap only, both at once, and neither
    for (const [n, wide] of [
      [LEDGER_MAX_FINDINGS + 1, false],
      [LEDGER_MAX_FINDINGS, true],
      [LEDGER_MAX_FINDINGS + 1, true],
      [3, false],
    ] as Array<[number, boolean]>) {
      const back = parseLedger(serializeLedger(mk(n, wide)))!;
      expect(back.findings.length + (back.dropped ?? 0)).toBe(n);
    }
  });

  it('leaves a realistic ledger whole — the cap is a bound, not a budget to spend', () => {
    // Fifty findings at realistic widths still fit, so the truncation path is
    // reached only by a ledger no round has produced.
    const realistic = {
      v: 1 as const,
      round: 2,
      findings: Array.from({ length: LEDGER_MAX_FINDINGS }, (_, i) => ({
        id: `R2-${i}`,
        sev: 'S' as const,
        file: 'packages/cli/src/commands/review/test-delta.ts',
        line: 123,
        title: 'the base rerun attributes nothing when it could not run',
      })),
    };
    const back = parseLedger(serializeLedger(realistic));
    expect(back!.findings).toHaveLength(LEDGER_MAX_FINDINGS);
    expect(back!.dropped).toBeUndefined();
  });

  it('round-trips through a posted body', () => {
    const body = `Reviewed. Suggestions inline.\n\n${serializeLedger(LEDGER)}`;
    expect(parseLedger(body)).toEqual(LEDGER);
  });

  it('is invisible-safe: no `--` survives into the comment payload', () => {
    // `--` inside an HTML comment ends it early and the tail renders as text.
    const s = serializeLedger({
      v: 1,
      round: 1,
      findings: [
        { id: 'R1-1', sev: 'C', file: 'a--b.ts', title: 'uses -- twice --' },
      ],
    });
    expect(s.slice(4, -3)).not.toContain('--');
    expect(parseLedger(s)).not.toBeNull();
  });

  it('escapes `--` LOSSLESSLY — the next round re-locates by this text', () => {
    // The first cut rewrote `--` to an em dash, which is comment-safe but
    // lies: a finding about `--comment` came back as `—comment`, on a work
    // list whose only job is to name a claim precisely enough to re-find it.
    const ledger: Ledger = {
      v: 1,
      round: 1,
      findings: [
        {
          id: 'R1-1',
          sev: 'C',
          file: 'scripts/run--all.sh',
          line: -1,
          title: 'the `--comment` gate misreads ---- as a flag',
        },
      ],
    };
    const s = serializeLedger(ledger);
    expect(s.slice(4, -3)).not.toContain('--');
    expect(parseLedger(s)).toEqual(ledger);
  });

  it('caps findings and titles rather than growing the body unboundedly', () => {
    const big: Ledger = {
      v: 1,
      round: 1,
      findings: Array.from({ length: 80 }, (_, i) => ({
        id: `R1-${i + 1}`,
        sev: 'S' as const,
        file: 'f.ts',
        title: 'x'.repeat(500),
      })),
    };
    const parsed = parseLedger(serializeLedger(big))!;
    expect(parsed.findings).toHaveLength(LEDGER_MAX_FINDINGS);
    expect(parsed.findings[0].title.length).toBeLessThanOrEqual(80);
  });

  it('bounds the WRITE side too — the cap was read-only and one-sided', () => {
    // `parseLedger` sliced `file` to 200 and `serializeLedger` did not, so the
    // "keep the marker a footnote" contract held only for markers this code
    // read, never for the ones it wrote into a body with a 65,536-char limit.
    const s = serializeLedger({
      v: 1,
      round: 1,
      findings: [{ id: 'R1-1', sev: 'C', file: 'x'.repeat(5_000), title: 't' }],
    });
    expect(s.length).toBeLessThan(LEDGER_MAX_FILE + 200);
    expect(parseLedger(s)!.findings[0].file).toHaveLength(LEDGER_MAX_FILE);
  });

  it('contributes NOTHING on any malformation, and never throws', () => {
    for (const body of [
      undefined,
      '',
      'no marker here',
      '<!-- qwen-review-ledger not-json -->',
      '<!-- qwen-review-ledger {"v":2,"round":1,"findings":[]} -->',
      '<!-- qwen-review-ledger {"v":1,"round":0,"findings":[]} -->',
      '<!-- qwen-review-ledger {"v":1,"round":1,"findings":"nope"} -->',
      '<!-- qwen-review-ledger {"v":1,"round":1',
    ]) {
      expect(parseLedger(body)).toBeNull();
    }
    // Entries that fail the shape check are dropped, valid siblings kept.
    const mixed = parseLedger(
      '<!-- qwen-review-ledger {"v":1,"round":1,"findings":[{"id":"R1-1","sev":"C","file":"a.ts","title":"ok"},{"sev":"X"},null]} -->',
    )!;
    expect(mixed.findings).toHaveLength(1);
  });

  it('strips the marker for model-facing rendering', () => {
    const body = `prose before\n\n${serializeLedger(LEDGER)}\n\nprose after`;
    const stripped = stripLedgerMarker(body);
    expect(stripped).toContain('prose before');
    expect(stripped).toContain('prose after');
    expect(stripped).not.toContain('qwen-review-ledger');
    expect(stripLedgerMarker('untouched')).toBe('untouched');
  });

  it('strips EVERY marker — the parser reads the last one', () => {
    // Stripping only the first left behind exactly the marker `parseLedger`
    // trusts: the JSON reached the model as prose, and a canonical LGTM stopped
    // matching its `^…$`-anchored filter, so the no-op round rendered in full.
    const body = `No issues found. LGTM! ✅\n\n${serializeLedger({
      ...LEDGER,
      round: 1,
    })}\n\n${serializeLedger(LEDGER)}`;
    expect(parseLedger(body)?.round).toBe(2);
    expect(stripLedgerMarker(body)).toBe('No issues found. LGTM! ✅');
  });

  it('leaves an unterminated marker alone rather than truncating the body', () => {
    const body = 'prose <!-- qwen-review-ledger {"v":1 and the rest of it';
    expect(stripLedgerMarker(body)).toBe(body);
  });
});
