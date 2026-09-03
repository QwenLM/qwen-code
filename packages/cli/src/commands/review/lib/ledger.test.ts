/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

// The marker rides inside a posted review body — another account's writable
// surface — so the parse half is tested as an untrusted-input boundary: every
// malformation contributes nothing, and nothing throws.

import { describe, it, expect } from 'vitest';
import {
  serializeLedger,
  parseLedger,
  stripLedgerMarker,
  LEDGER_ID_READBACK,
  LEDGER_MAX_FINDINGS,
  LEDGER_MAX_FILE,
  LEDGER_MAX_TITLE,
  LEDGER_MAX_BYTES,
  LEDGER_MAX_MODEL,
  LEDGER_MAX_ROUND,
  LEDGER_MAX_VOLUME,
  LEDGER_MAX_ID,
  LEDGER_MAX_CLOSED,
  LEDGER_ID_SHAPE,
  LEDGER_MAX_REC_CODES,
  LEDGER_MAX_REC_CODE,
  axesOf,
  isLedgerFinding,
  normalizeLedgerFinding,
  type Ledger,
  type LedgerFinding,
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

  it('round-trips the incremental anchor sha', () => {
    // The sha is the marker's second job: without it a fresh environment (CI,
    // another clone) recovers the work list but not "last reviewed at", and
    // the incremental range degrades to the full diff every time.
    const anchored: Ledger = { ...LEDGER, sha: 'abc1234def567890' };
    const body = `Reviewed.\n\n${serializeLedger(anchored)}`;
    expect(parseLedger(body)).toEqual(anchored);
  });

  it('round-trips the anchor model beside the sha — incremental is a same-model contract', () => {
    // The cache pairs `lastCommitSha` with `lastModelId`; the marker's anchor
    // rode bare, so a round under another model that recovered it would scope
    // `sha..HEAD` past code the current model never reviewed.
    const anchored: Ledger = {
      ...LEDGER,
      sha: 'abc1234def567890',
      model: 'qwen3.7-max',
    };
    expect(parseLedger(`Reviewed.\n\n${serializeLedger(anchored)}`)).toEqual(
      anchored,
    );
  });

  it('the model rides and falls WITH the anchor, on write and on read', () => {
    // A model naming no range qualifies nothing: the serializer withholds it
    // wherever it withholds the sha (fail-closed, truncated), and the parser
    // drops a hand-edited model whose sha did not survive.
    expect(serializeLedger({ ...LEDGER, model: 'qwen3.7-max' })).not.toContain(
      'model',
    );
    const truncated = serializeLedger({
      v: 1,
      round: 2,
      sha: 'abc1234def567890',
      model: 'qwen3.7-max',
      findings: Array.from({ length: LEDGER_MAX_FINDINGS + 1 }, (_, i) => ({
        id: `R2-${i}`,
        sev: 'C' as const,
        file: 'src/a.ts',
        title: 'x',
      })),
    });
    expect(parseLedger(truncated)!.model).toBeUndefined();
    for (const forged of [
      '<!-- qwen-review-ledger {"v":1,"round":1,"findings":[],"model":"qwen3.7-max"} -->',
      '<!-- qwen-review-ledger {"v":1,"round":1,"findings":[],"sha":"not hex","model":"qwen3.7-max"} -->',
    ]) {
      expect(parseLedger(forged)!.model).toBeUndefined();
    }
  });

  it('normalises the model on both sides — trimmed, WHOLE, never a non-string', () => {
    // The model rides whole or not at all: a truncated id is a prefix, and a
    // prefix can equal a DIFFERENT model's full id — the same-model gate
    // would then scope that other model past code it never reviewed
    // (probe-measured: a 75-char id recovered as its 64-char prefix compared
    // equal to the prefix's owner). On WRITE an over-cap model takes the
    // anchor pair with it; on READ an over-cap model is one the serializer
    // would never have written, so it drops — the gate reads the absence as
    // a mismatch — and the sha survives.
    const wide = serializeLedger({
      v: 1,
      round: 1,
      findings: [],
      sha: 'abc1234',
      model: `  ${'m'.repeat(LEDGER_MAX_MODEL + 1)}  `,
    });
    expect(wide).not.toContain('"model"');
    expect(wide).not.toContain('"sha"');
    const forged = parseLedger(
      `<!-- qwen-review-ledger {"v":1,"round":1,"findings":[],"sha":"abc1234","model":${JSON.stringify('x'.repeat(LEDGER_MAX_MODEL + 1))}} -->`,
    );
    expect(forged!.sha).toBe('abc1234');
    expect(forged!.model).toBeUndefined();
    // Exactly at the cap the identity rides whole — trimmed on both sides.
    const full = serializeLedger({
      v: 1,
      round: 1,
      findings: [],
      sha: 'abc1234',
      model: `  ${'m'.repeat(LEDGER_MAX_MODEL)}  `,
    });
    const recovered = parseLedger(full)!;
    expect(recovered.model).toHaveLength(LEDGER_MAX_MODEL);
    expect(recovered.model).toBe('m'.repeat(LEDGER_MAX_MODEL));
    for (const model of ['', '   ', 42, null]) {
      const raw = `<!-- qwen-review-ledger {"v":1,"round":1,"findings":[],"sha":"abc1234","model":${JSON.stringify(model)}} -->`;
      expect(parseLedger(raw)!.model).toBeUndefined();
    }
  });

  it('a truncated ledger loses its anchor — a partial work list must not certify a range', () => {
    // Dropped entries reference code at or before the anchored head; a next
    // round scoped to `sha..HEAD` would never re-see it, and Step 6 rules
    // only on entries that are IN the list — the dropped ones would retire
    // silently. Both halves hold the line: the serializer withholds the sha
    // when it drops findings, and the parser strips a hand-edited marker
    // that carries both.
    const overflowing: Ledger = {
      v: 1,
      round: 2,
      sha: 'abc1234def567890',
      findings: Array.from({ length: LEDGER_MAX_FINDINGS + 1 }, (_, i) => ({
        id: `R2-${i}`,
        sev: 'C' as const,
        file: 'src/a.ts',
        title: 'x',
      })),
    };
    const back = parseLedger(serializeLedger(overflowing));
    expect(back!.dropped).toBeGreaterThan(0);
    expect(back!.sha).toBeUndefined();
    const handEdited = parseLedger(
      '<!-- qwen-review-ledger {"v":1,"round":1,"findings":[],"dropped":3,"sha":"abc1234"} -->',
    );
    expect(handEdited!.sha).toBeUndefined();
    // The count cap binds on READ too: a hand-edited marker carrying MORE
    // valid entries than the serializer would ever emit — and no `dropped` —
    // is truncated by this parser, and the entries it sliced off are dropped
    // findings. Leaving the anchor on it would certify a range whose work
    // list this very parse made partial (probe-measured on the shipped code:
    // 51 entries parsed to 50 and KEPT the sha).
    const overCount = parseLedger(
      `<!-- qwen-review-ledger ${JSON.stringify({
        v: 1,
        round: 2,
        sha: 'abc1234def567890',
        findings: Array.from({ length: LEDGER_MAX_FINDINGS + 1 }, (_, i) => ({
          id: `R2-${i}`,
          sev: 'C',
          file: 'a.ts',
          title: 't',
        })),
      })} -->`,
    )!;
    expect(overCount.findings).toHaveLength(LEDGER_MAX_FINDINGS);
    expect(overCount.dropped).toBe(1);
    expect(overCount.sha).toBeUndefined();
  });

  it('over the cap, sheds the anchor pair BEFORE the work list', () => {
    // The model field rides every clean marker, so a round that used to
    // fit the cap overflows once it joins — and the loop's first casualty
    // used to be a finding, with `dropped` then withholding the pair in
    // the same render: the next round lost a ruling AND the anchor. The
    // pair now sheds first and the whole work list survives; recovery
    // degrades to the full diff, which the findings ride out.
    const sha = 'deadbeef'.repeat(5);
    const model = 'qwen3.7-max';
    const wide = (i: number): LedgerFinding => ({
      id: `R2-${i}`,
      sev: 'S',
      file: 'p/'.repeat(100).slice(0, LEDGER_MAX_FILE),
      line: 99999,
      title: 'x'.repeat(LEDGER_MAX_TITLE),
    });
    const small = (i: number): LedgerFinding => ({
      id: `R2-${i}`,
      sev: 'S',
      file: 'a.ts',
      line: i,
      title: '',
    });
    const anchoredOf = (findings: LedgerFinding[]): string =>
      serializeLedger({ v: 1, round: 2, findings, sha, model });
    const anchorlessOf = (findings: LedgerFinding[]): string =>
      serializeLedger({ v: 1, round: 2, findings });
    const pairBytes = anchoredOf([]).length - anchorlessOf([]).length;
    // Fill the ANCHORLESS form toward the cap: an over-cap render
    // self-sheds, so a true fit is recognized by its signature — the
    // marker growing by the added finding's width — which a shed render
    // never shows (it reports `dropped` and shrinks instead).
    const findings: LedgerFinding[] = [];
    const fits = (candidate: LedgerFinding): boolean => {
      const growth =
        anchorlessOf([...findings, candidate]).length -
        anchorlessOf(findings).length;
      return growth >= 50;
    };
    for (;;) {
      const i = findings.length;
      if (i > LEDGER_MAX_FINDINGS) break;
      if (fits(wide(i))) findings.push(wide(i));
      else if (fits(small(i))) findings.push(small(i));
      else break;
    }
    // The filled list sits at the boundary this ordering exists for: the
    // anchorless form fits the cap, and the anchor pair's bytes beside it
    // do not. Both halves measured from the below-cap anchorless render,
    // which never self-sheds.
    const anchorless = anchorlessOf(findings).length;
    expect(anchorless).toBeLessThanOrEqual(LEDGER_MAX_BYTES);
    expect(anchorless + pairBytes).toBeGreaterThan(LEDGER_MAX_BYTES);

    const back = parseLedger(anchoredOf(findings))!;
    expect(back.findings).toHaveLength(findings.length);
    expect(back.dropped).toBeUndefined();
    expect(back.sha).toBeUndefined();
    expect(back.model).toBeUndefined();
  });

  it('drops a malformed sha but keeps the ledger — field-level fail-quiet', () => {
    // The body is another account's writable surface. A garbage anchor must
    // not cost the next round its work list, and must not survive as an
    // anchor either — Step 1 would hand it to `git`.
    const forged = `<!-- qwen-review-ledger {"v":1,"round":1,"findings":[],"sha":"$(rm -rf /)"} -->`;
    const parsed = parseLedger(forged);
    expect(parsed).not.toBeNull();
    expect(parsed?.sha).toBeUndefined();
    // The serializer holds the same line: a non-hex sha never reaches the body.
    expect(
      serializeLedger({ v: 1, round: 1, findings: [], sha: 'not a sha' }),
    ).not.toContain('sha');
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

describe('a shortened work list must never read as complete', () => {
  const f = (id: string): LedgerFinding => ({
    id,
    sev: 'S',
    file: 'a.ts',
    title: 't',
  });

  it('counts what the FILTER rejected, not only what the cap sliced', () => {
    // `dropped` decides two things: the anchor is withheld while it is set,
    // and it now publishes the "may be an undercount" caveat. Entries the
    // filter rejected are findings the next round will never rule on, so a
    // list short by them that still certifies its range retires a posted
    // Critical silently AND scopes the next review past its code.
    const marker =
      '<!-- qwen-review-ledger {"v":1,"round":3,"findings":[' +
      '{"id":"R3-1","sev":"S","file":"a.ts","title":"kept"},' +
      '{"id":"nope","sev":"S","file":"b.ts","title":"rejected"}' +
      '],"sha":"deadbeef00112233"} -->';
    const parsed = parseLedger(marker)!;
    expect(parsed.findings.map((x) => x.id)).toEqual(['R3-1']);
    expect(parsed.dropped).toBe(1);
    expect(parsed.sha).toBeUndefined();
  });

  it('never writes an id its own parser would refuse', () => {
    // The id cap slices without re-validating, so an over-long id is cut
    // mid-token and stops being the grammar. Emitted, the next round's
    // filter drops it — the finding retires with no ruling, and the loss is
    // invisible unless it is counted here, where `dropped` still counts it.
    const long = `R${'1'.repeat(30)}-7`;
    const marker = serializeLedger({
      v: 1,
      round: 2,
      findings: [f('R2-1'), { ...f(long), file: 'b.ts' }],
      sha: 'deadbeef00112233',
    });
    // The MARKER, not merely the parse: dropped on the write side the loss is
    // declared in the bytes and the anchor is withheld by the writer; left in,
    // the marker spends its budget on a token its own reader will refuse.
    expect(marker).not.toContain('R1111');
    expect(marker).toContain('"dropped":1');
    const parsed = parseLedger(marker)!;
    expect(parsed.findings.map((x) => x.id)).toEqual(['R2-1']);
    expect(parsed.dropped).toBe(1);
    expect(parsed.sha).toBeUndefined();
  });

  it('writes no floor beside a volume that did not survive', () => {
    // The floor qualifies `posted`. Written whenever the rung ADMITS the
    // group rather than whenever the volume survived it, it is bytes spent
    // on the shed cascade that the parser then discards — on the same ladder
    // the serializer prices at a lost anchor.
    const marker = serializeLedger({
      v: 1,
      round: 2,
      findings: [f('R2-1')],
      posted: -3 as unknown as number,
      floor: 'c',
    });
    expect(marker).not.toContain('floor');
  });

  it('refuses a round-0 id at both ends of the bound', () => {
    // Rounds start at 1, so `R0-*` is not an id this pipeline can mint — but
    // it passes the shape, and every reader that turns an id into a round
    // rejects round 0 and then reads the rejection as "no carried id", i.e.
    // as FRESH. Admitted, a re-posted `R0-1` counts as first-time work every
    // round and the trend narrates divergence at a settled steady state.
    expect(
      isLedgerFinding({ id: 'R0-1', sev: 'C', file: 'x.ts', title: 't' }, 9),
    ).toBe(false);
    expect(
      parseLedger(
        '<!-- qwen-review-ledger {"v":1,"round":3,"findings":[' +
          '{"id":"R0-1","sev":"C","file":"x.ts","title":"boom"}' +
          ']} -->',
      )?.findings,
    ).toEqual([]);
    // The write side applies the same test, so a stray id the model minted
    // out of range never reaches a marker its own reader would refuse.
    const marker = serializeLedger({
      v: 1,
      round: 3,
      findings: [f('R3-1'), { ...f('R0-1'), file: 'b.ts' }],
    });
    expect(marker).not.toContain('R0-1');
    expect(marker).toContain('"dropped":1');
  });

  it('round-trips the stand-in exception flag, and clamps a forged dropped', () => {
    // [1] The flag has to survive serialize -> parse, not merely exist on
    // the builder's output: it is the only thing separating a real file
    // spelled like a stand-in from the stand-in itself, and it crosses the
    // marker boundary on every round.
    const marker = serializeLedger({
      v: 1,
      round: 3,
      findings: [
        { id: 'R3-1', sev: 'C', file: '(body)', title: 'a stand-in' },
        { id: 'R3-2', sev: 'S', file: '(body)', title: 'a real file', k: 1 },
      ],
    });
    const back = parseLedger(marker)!;
    expect(back.findings[0].k).toBeUndefined();
    expect(back.findings[1].k).toBe(1);
    // The stand-in costs no marker bytes; only the exception is spelled.
    expect(marker.match(/"k":1/g)).toHaveLength(1);
  });

  it('clamps a forged `dropped` instead of publishing it', () => {
    // It renders into the model-facing PARTIAL line and publishes the
    // undercount caveat, and unlike a forged finding it cannot be re-ruled.
    const parsed = parseLedger(
      '<!-- qwen-review-ledger {"v":1,"round":3,"findings":[],"dropped":1e308} -->',
    )!;
    // Clamped through the same reader the other counts use, so the PARTIAL
    // line cannot render `1e+308 further finding(s)`.
    expect(parsed.dropped).toBe(LEDGER_MAX_VOLUME);
    // A non-count is still no count at all.
    expect(
      parseLedger(
        '<!-- qwen-review-ledger {"v":1,"round":3,"findings":[],"dropped":-4} -->',
      )?.dropped,
    ).toBeUndefined();
  });

  it('refuses an over-long id rather than cutting it into a different one', () => {
    // Admitted and then sliced, the entry silently changes identity between
    // the round that posted it and the round that rules on it.
    const long = `R2-${'9'.repeat(LEDGER_MAX_ID)}`;
    expect(long.length).toBeGreaterThan(LEDGER_MAX_ID);
    expect(
      isLedgerFinding({ id: long, sev: 'S', file: 'a.ts', title: 't' }, 9),
    ).toBe(false);
  });

  it('bounds an id round by the CAP, not only by the claimed round', () => {
    // The side-file route's round is whatever was written to it, which the
    // admission test's own comment says is not always clamped.
    expect(
      isLedgerFinding(
        {
          id: `R${LEDGER_MAX_ROUND + 1}-1`,
          sev: 'S',
          file: 'a.ts',
          title: 't',
        },
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(false);
    expect(
      isLedgerFinding(
        { id: `R${LEDGER_MAX_ROUND}-1`, sev: 'S', file: 'a.ts', title: 't' },
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(true);
  });

  it('keeps the fresh count only beside a volume that bounds it', () => {
    const ok = parseLedger(
      '<!-- qwen-review-ledger {"v":1,"round":3,"findings":[],"posted":5,"fresh":2} -->',
    )!;
    expect(ok.fresh).toBe(2);
    // Larger than the total it is part of: not a count of anything.
    const over = parseLedger(
      '<!-- qwen-review-ledger {"v":1,"round":3,"findings":[],"posted":2,"fresh":5} -->',
    )!;
    expect(over.fresh).toBeUndefined();
    // No total: nothing for it to be a part of.
    const bare = parseLedger(
      '<!-- qwen-review-ledger {"v":1,"round":3,"findings":[],"fresh":5} -->',
    )!;
    expect(bare.fresh).toBeUndefined();
  });

  it('refuses an over-long id rather than emitting a cut one under it', () => {
    // The cut can still match the grammar — `R3-` plus twenty-two nines
    // slices to a well-formed twenty-four — so validating after the slice
    // emitted a DIFFERENT id under the same entry: the next round's readback
    // of the posted claim returns the full id, matches no ledger entry, and
    // the finding retires with no ruling while the list reads as complete.
    const cuttable = `R3-${'9'.repeat(22)}`;
    expect(cuttable.length).toBeGreaterThan(LEDGER_MAX_ID);
    expect(LEDGER_ID_SHAPE.test(cuttable.slice(0, LEDGER_MAX_ID))).toBe(true);
    const marker = serializeLedger({
      v: 1,
      round: 3,
      findings: [
        { ...f('R3-1'), file: 'a.ts' },
        { ...f(cuttable), file: 'b.ts' },
      ],
      sha: 'deadbeef00112233',
    });
    expect(marker).not.toContain(cuttable.slice(0, LEDGER_MAX_ID));
    const parsed = parseLedger(marker)!;
    expect(parsed.findings.map((x) => x.id)).toEqual(['R3-1']);
    expect(parsed.dropped).toBe(1);
    expect(parsed.sha).toBeUndefined();
  });

  it('clamps the SUMMED dropped, not only its declared term', () => {
    // `raw.findings.length` is attacker-chosen — a body of tens of thousands
    // of single-character invalid entries fits GitHub's limit — and the
    // total is interpolated verbatim into the model-facing PARTIAL line.
    const junk = Array.from({ length: 400 }, () => ({ id: 'x' }));
    const parsed = parseLedger(
      `<!-- qwen-review-ledger {"v":1,"round":3,"dropped":${LEDGER_MAX_VOLUME},"findings":${JSON.stringify(junk)}} -->`,
    )!;
    expect(parsed.dropped).toBe(LEDGER_MAX_VOLUME);
  });

  it('normalises an unrecognised clustering hint instead of dropping the finding', () => {
    // `k` decides nothing. The marker is a cross-environment carrier by
    // design, so a later version adding a third kind — or a hand edit, or a
    // foreign marker — would otherwise make every older CLI drop those
    // findings from the work list: they would owe no Step 6 ruling and
    // retire with nobody ruling on them.
    const marker =
      '<!-- qwen-review-ledger {"v":1,"round":3,"findings":[' +
      '{"id":"R3-1","sev":"C","file":"(body)","title":"t","k":"d"}' +
      ']} -->';
    const parsed = parseLedger(marker)!;
    expect(parsed.findings).toEqual([
      { id: 'R3-1', sev: 'C', file: '(body)', title: 't' },
    ]);
    expect(parsed.dropped).toBeUndefined();
  });

  it('bounds an id round even when the marker round does not', () => {
    // The round is printed verbatim in a public body, and the side-file read
    // shares this admission test with no clamp of its own.
    expect(
      isLedgerFinding(
        { id: 'R99999999999999999999-1', sev: 'S', file: 'a.ts', title: 't' },
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(false);
    // A leading space is the bypass the whole-shape test closes.
    expect(
      isLedgerFinding({ id: ' R9-1', sev: 'S', file: 'a.ts', title: 't' }, 99),
    ).toBe(false);
  });
});

// The prefix-anchored readback both ledger read sides share wholesale:
// compose-review's ledger builder and presubmit's re-post extractor.
describe('LEDGER_ID_READBACK', () => {
  // The shared regex's docstring claims the tolerated terminator set cannot
  // drift between the two ends — which only holds if the set ITSELF is
  // pinned: deleting a terminator from the class survives both consuming
  // suites, and a prose-variant re-post then fails extraction at both ends
  // and is dropped as a plain location overlap, re-creating #9208 with
  // every consumer green (#9212 review).
  const cases: Array<[string, string | null]> = [
    ['R3-2: claim', 'R3-2'],
    ['R3-2. claim', 'R3-2'],
    ['R3-2) claim', 'R3-2'],
    ['R3-2] claim', 'R3-2'],
    ['R3-2 claim', 'R3-2'],
    ['R3-2', 'R3-2'],
    ['R3-2-1: extended run', null],
    ['see R3-2: cross-reference', null],
  ];
  it.each(cases)('reads %j as %j', (line, expected) => {
    expect(LEDGER_ID_READBACK.exec(line)?.[1] ?? null).toBe(expected);
  });
});

// The closure list the divergence sentinel (#9905) rides on the marker:
// validated and capped on both ends like the findings, but with no
// `dropped` counterpart — closures certify nothing, so a truncated history
// has no completeness claim to protect.
describe('ledger marker — the closure list (#9905)', () => {
  it('round-trips the closures through serialize and parse', () => {
    const marker = serializeLedger({
      ...LEDGER,
      closed: [
        { r: 2, id: 'R1-1', f: 'src/a.ts' },
        { r: 2, id: 'R1-2', f: 'src/c.ts' },
      ],
    });
    const back = parseLedger(`body\n\n${marker}`)!;
    expect(back.closed).toEqual([
      { r: 2, id: 'R1-1', f: 'src/a.ts' },
      { r: 2, id: 'R1-2', f: 'src/c.ts' },
    ]);
    expect(back.dropped).toBeUndefined();
    expect(back.findings).toHaveLength(2);
  });

  it('omits the field entirely when there are no closures', () => {
    const back = parseLedger(serializeLedger(LEDGER))!;
    expect(back.closed).toBeUndefined();
    expect(JSON.stringify(back)).not.toContain('closed');
  });

  it('drops malformed entries and a closure claiming a FUTURE round', () => {
    // Same squat rule as the findings: the marker's round is the newest
    // state it can describe, so a closure past it is not one.
    const back = parseLedger(
      '<!-- qwen-review-ledger {"v":1,"round":2,"findings":[],' +
        '"closed":[{"r":2,"id":"R1-1","f":"a.ts"},{"r":3,"id":"R3-1","f":"b.ts"},' +
        '{"r":1},{"r":"2","id":"R1-2","f":"c.ts"},null]} -->',
    )!;
    expect(back.closed).toEqual([{ r: 2, id: 'R1-1', f: 'a.ts' }]);
  });

  it('binds the count cap on read, keeping the NEWEST entries', () => {
    // Fed a RAW marker, not a serialize round-trip: the write side already
    // sheds to the cap, so a round-tripped list never reaches the
    // parse-side slice — the half that binds a hand-edited or planted
    // marker no serializer ever capped.
    const closed = Array.from({ length: LEDGER_MAX_CLOSED + 10 }, (_, i) => ({
      r: 2,
      id: `R1-${i}`,
      f: 'a.ts',
    }));
    const back = parseLedger(
      `<!-- qwen-review-ledger {"v":1,"round":2,"findings":[],"closed":${JSON.stringify(closed)}} -->`,
    )!;
    expect(back.closed).toHaveLength(LEDGER_MAX_CLOSED);
    expect(back.closed![0]!.id).toBe('R1-10');
    expect(back.closed![LEDGER_MAX_CLOSED - 1]!.id).toBe('R1-59');
  });

  it('refuses closure ids the finding grammar refuses — squats, links, empty', () => {
    // The admission test applies the SAME grammar and id-round bounds
    // `isLedgerFinding` does in this file: a hand-edited or forged marker
    // must not plant arbitrary ≤24-char tokens into the posted advisory and
    // the machine-readable `basis` — an empty id renders a blank generation
    // (` → `), `R9999-1` spells a round nobody ran, a link or mention rides
    // the route whose own comment names the planted-marker threat — while
    // the ledger's admission test refuses every one of them as a finding.
    // The one honest entry survives.
    const longFile = 'z'.repeat(LEDGER_MAX_FILE + 1);
    const back = parseLedger(
      '<!-- qwen-review-ledger {"v":1,"round":2,"findings":[],' +
        '"closed":[' +
        '{"r":2,"id":"R9999-1","f":"a.ts"},' +
        '{"r":2,"id":"","f":"a.ts"},' +
        '{"r":2,"id":"not-an-id","f":"a.ts"},' +
        '{"r":2,"id":"[x](http://evil.example)","f":"a.ts"},' +
        '{"r":2,"id":"@mention ping","f":"a.ts"},' +
        '{"r":2,"id":"R1-1","f":""},' +
        // Two fixtures each refused by ONE conjunct alone — the two
        // conjuncts no earlier fixture isolated: `R1-1x` passes the
        // id-round arithmetic (round 1 in bounds, below r), so the shape
        // check is its only refuser; the long `f` passes every other
        // check, so the length bound is its only refuser. Deleting either
        // conjunct admitted its fixture with the suite green.
        '{"r":2,"id":"R1-1x","f":"a.ts"},' +
        `{"r":2,"id":"R1-3","f":"${longFile}"},` +
        '{"r":2,"id":"R2-1","f":"b.ts"},' +
        '{"r":2,"id":"R1-2","f":"a.ts"}' +
        ']} -->',
    )!;
    // `R2-1` at r=2 spells a finding closed the very round it was minted —
    // the pipeline's own writer cannot produce that shape (a closure at
    // round r closes a finding OPEN in round r-1's work list), so the
    // admission test refuses it like the other planted tokens.
    expect(back.closed).toEqual([{ r: 2, id: 'R1-2', f: 'a.ts' }]);
  });

  it('admits a same-round closure id ONLY at the round cap — the escape hatch', () => {
    // At the cap, consecutive rounds re-stamp the same `R<cap>-*` id space,
    // so a minted closure's id round EQUALS its closure round — admitted
    // only via the escape hatch. Below the cap the same shape spells a
    // finding closed the very round it was minted, and the admission test
    // refuses it like the planted `R2-1` above.
    const atCap = parseLedger(
      `<!-- qwen-review-ledger {"v":1,"round":${LEDGER_MAX_ROUND},"findings":[],` +
        `"closed":[{"r":${LEDGER_MAX_ROUND},"id":"R${LEDGER_MAX_ROUND}-1","f":"a.ts"}]} -->`,
    )!;
    expect(atCap.closed).toEqual([
      { r: LEDGER_MAX_ROUND, id: `R${LEDGER_MAX_ROUND}-1`, f: 'a.ts' },
    ]);
    const belowCap = parseLedger(
      `<!-- qwen-review-ledger {"v":1,"round":${LEDGER_MAX_ROUND},"findings":[],` +
        `"closed":[{"r":${LEDGER_MAX_ROUND - 1},"id":"R${LEDGER_MAX_ROUND}-1","f":"a.ts"}]} -->`,
    )!;
    expect(belowCap.closed ?? []).toEqual([]);
  });

  it('sheds closures BEFORE the anchor pair, and never sets `dropped` for them', () => {
    // The cascade order is the priority order: advisory history goes before
    // the anchor (a full re-review) and the work list (a ruling owed). A
    // marker that paid a finding — or its anchor — for a divergence hint
    // would invert the module's priorities, and `dropped` over a trimmed
    // hint would withhold the anchor over advisory data.
    const wide: Ledger = {
      v: 1,
      round: 9,
      // Sized so the findings ALONE nearly fill the byte budget: the
      // closures overflow it, so the shed order is observable — the
      // closures go, the anchor and the work list stay.
      findings: Array.from({ length: 21 }, (_, i) => ({
        id: `R9-${i}`,
        sev: 'C' as const,
        file: 'p/'.repeat(100).slice(0, LEDGER_MAX_FILE),
        line: 99999,
        title: 'x'.repeat(LEDGER_MAX_TITLE),
      })),
      // Ids the admission test ADMITS — the shape and length legal, the
      // id round below the closure round: an invalid id is dropped by the
      // serializer's admission filter before the byte cascade ever runs,
      // and this test would pass vacuously over the shed stage it names.
      closed: Array.from({ length: LEDGER_MAX_CLOSED }, (_, i) => ({
        r: 9,
        id: `R8-${i}`,
        f: 'p/'.repeat(100).slice(0, LEDGER_MAX_FILE),
      })),
      sha: 'deadbeef00112233',
    };
    const marker = serializeLedger(wide);
    expect(marker.length).toBeLessThanOrEqual(LEDGER_MAX_BYTES);
    const back = parseLedger(`body\n\n${marker}`)!;
    expect(back.closed ?? []).toHaveLength(0);
    expect(back.sha).toBe('deadbeef00112233');
    expect(back.findings).toHaveLength(21);
    expect(back.dropped).toBeUndefined();
  });
});

// `src0` is the approach signal's baseline — see `Ledger.src0`. It is the one
// field that survives truncation, because the ruling that withholds an anchor
// from a partial finding list does not extend to a measurement of the diff.
describe('ledger src0 — the approach-signal baseline', () => {
  it('serializes a positive baseline and omits a missing or zero one', () => {
    expect(
      serializeLedger({ v: 1, round: 2, findings: [], src0: 228 }),
    ).toContain('"src0":228');
    expect(serializeLedger({ v: 1, round: 2, findings: [] })).not.toContain(
      'src0',
    );
    expect(
      serializeLedger({ v: 1, round: 2, findings: [], src0: 0 }),
    ).not.toContain('src0');
  });

  // The explicit ruling the schema demands of any new field: `sha` is dropped
  // on a truncated list because a partial work list must not certify a commit
  // range; `src0` certifies nothing, so it rides.
  it('survives truncation where the anchor does not', () => {
    const findings = Array.from({ length: 400 }, (_, i) => ({
      id: `R1-${i}`,
      sev: 'S' as const,
      file: `src/some/reasonably/long/path/to/file-${i}.ts`,
      line: i,
      title: `a finding title long enough to push the marker past its byte cap ${i}`,
    }));
    const parsed = parseLedger(
      serializeLedger({
        v: 1,
        round: 3,
        findings,
        sha: 'deadbeef00112233445566778899aabbccddeeff',
        src0: 228,
      }),
    );
    expect(parsed?.dropped).toBeGreaterThan(0);
    expect(parsed?.sha).toBeUndefined();
    expect(parsed?.src0).toBe(228);
  });

  // A garbled baseline must degrade to "unknown" — which the consumer reads as
  // silence — rather than to a number that would read as no growth.
  it.each([0, -5, 1.5, '228', null, undefined])(
    'drops a non-positive-integer baseline (%p)',
    (bad) => {
      const marker = `<!-- qwen-review-ledger ${JSON.stringify({
        v: 1,
        round: 2,
        findings: [],
        src0: bad,
      })} -->`;
      expect(parseLedger(marker)?.src0).toBeUndefined();
    },
  );

  it('round-trips a baseline alongside the -- escaping', () => {
    const parsed = parseLedger(
      serializeLedger({
        v: 1,
        round: 4,
        findings: [
          { id: 'R1-1', sev: 'C', file: 'a.ts', title: 'rejects --unsafe' },
        ],
        src0: 512,
      }),
    );
    expect(parsed?.src0).toBe(512);
    expect(parsed?.findings[0].title).toBe('rejects --unsafe');
  });
});

describe('the volume fields — telemetry across the untrusted boundary', () => {
  // This suite is the marker's untrusted-input boundary: `parseLedger` reads
  // PR bodies any account can write, so the volume fields are pinned here
  // rather than only through the serializer that always writes them well.
  const base = { v: 1 as const, round: 3, findings: [] };

  it('round-trips both volumes', () => {
    const l = parseLedger(
      serializeLedger({ ...base, posted: 4, prevPosted: 9 }),
    )!;
    expect(l.posted).toBe(4);
    expect(l.prevPosted).toBe(9);
  });

  it('keeps zero — a converged round is the observation', () => {
    const l = parseLedger(
      serializeLedger({ ...base, posted: 0, prevPosted: 0 }),
    )!;
    expect(l.posted).toBe(0);
    expect(l.prevPosted).toBe(0);
  });

  it.each([
    ['a float', 2.5],
    ['a negative', -1],
    ['a string', '7'],
    ['null', null],
    ['a NaN', Number.NaN],
  ])(
    'refuses %s in a hand-crafted marker without losing the ledger',
    (_label, bad) => {
      // The real input domain: a body another account wrote. A volume that
      // does not parse costs the trend a point; the work list it rides beside
      // must survive it.
      const marker = `<!-- qwen-review-ledger ${JSON.stringify({
        v: 1,
        round: 5,
        findings: [{ id: 'R5-1', sev: 'S', file: 'a.ts', title: 'x' }],
        posted: bad,
      })} -->`;
      const l = parseLedger(marker)!;
      expect(l.round).toBe(5);
      expect(l.findings).toHaveLength(1);
      expect(l.posted).toBeUndefined();
    },
  );

  it('clamps to the cap on write AND on read', () => {
    const over = LEDGER_MAX_VOLUME + 1;
    // Assert the RAW serialized text, not only the round trip: the parser
    // clamps independently, so a round-trip assertion alone passes even when
    // the write side emits the uncapped digits — the byte-budget hazard the
    // cap exists for would reach the posted marker unobserved.
    const written = serializeLedger({
      ...base,
      posted: over,
      prevPosted: over,
    });
    expect(written).toContain(`"posted":${LEDGER_MAX_VOLUME}`);
    expect(written).toContain(`"prevPosted":${LEDGER_MAX_VOLUME}`);
    expect(written).not.toContain(String(over));
    expect(
      parseLedger(serializeLedger({ ...base, posted: over }))?.posted,
    ).toBe(LEDGER_MAX_VOLUME);
    // Read side, independently: a hand-crafted marker cannot exceed what the
    // serializer would have written.
    const marker = `<!-- qwen-review-ledger ${JSON.stringify({
      v: 1,
      round: 2,
      findings: [],
      posted: over,
      prevPosted: over,
    })} -->`;
    const l = parseLedger(marker)!;
    expect(l.posted).toBe(LEDGER_MAX_VOLUME);
    expect(l.prevPosted).toBe(LEDGER_MAX_VOLUME);
  });

  it('sheds itself before the anchor when the byte budget binds', () => {
    // The reported window: a ledger that fits WITH its anchor, plus the
    // bytes of volume, crosses the cap — and the re-render must pay with the
    // telemetry, not with the anchor that scopes the next round's diff.
    //
    // The guard at the end counts PRESSURE windows, not comfortable ones.
    // An earlier version counted every window whose anchor survived without
    // volume, which a sweep can satisfy 100+ times while executing the shed
    // cascade zero times — the assertions would then be vacuous exactly
    // where they matter, and the sweep could drift off the narrow band
    // without anything noticing.
    let pressure = 0;
    for (let n = 24; n <= 32; n++) {
      for (let title = 20; title <= 40; title++) {
        const findings = Array.from({ length: n }, (_, i) => ({
          id: `R3-${i + 1}`,
          sev: 'S' as const,
          file: `src/${'p'.repeat(LEDGER_MAX_FILE - 10)}${i}.ts`.slice(
            0,
            LEDGER_MAX_FILE,
          ),
          title: 't'.repeat(title),
        }));
        const bare: Ledger = {
          v: 1,
          round: 3,
          findings,
          sha: 'deadbeef00112233',
          model: 'qwen3.8-max',
        };
        const bareMarker = serializeLedger(bare);
        const withoutVolume = parseLedger(bareMarker);
        // Only windows whose anchor survives WITHOUT volume can regress.
        if (!withoutVolume?.sha || withoutVolume.dropped) continue;
        const withVolume = parseLedger(
          serializeLedger({ ...bare, posted: 12, prevPosted: 9 }),
        )!;
        // The anchor and the work list never pay for telemetry.
        expect(withVolume.sha).toBe('deadbeef00112233');
        expect(withVolume.findings).toHaveLength(withoutVolume.findings.length);
        // A window is under pressure when both volumes would not have fit.
        if (
          bareMarker.length + '"posted":12,"prevPosted":9,'.length >
          LEDGER_MAX_BYTES
        ) {
          pressure++;
          // The carried value sheds first, this round's own count second:
          // `posted` is the next link in the chain the next round reads
          // back, so it survives a rung longer whenever it still fits.
          if (bareMarker.length + '"posted":12,'.length <= LEDGER_MAX_BYTES) {
            expect(withVolume.posted).toBe(12);
            expect(withVolume.prevPosted).toBeUndefined();
          }
        }
      }
    }
    // The sweep must actually reach the band where the cascade runs, or
    // every assertion above is about comfortable markers only.
    expect(pressure).toBeGreaterThan(0);
  });

  it('survives a truncated work list, unlike the anchor pair', () => {
    // The anchor is withheld when the list is partial because a partial list
    // cannot certify a range. A volume certifies nothing, and a trend that
    // went blank exactly on the rounds that overflow would be blind where it
    // matters most.
    const findings = Array.from(
      { length: LEDGER_MAX_FINDINGS + 5 },
      (_, i) => ({
        id: `R3-${i + 1}`,
        sev: 'S' as const,
        file: `f${i}.ts`,
        title: `finding ${i}`,
      }),
    );
    const l = parseLedger(
      serializeLedger({
        ...base,
        findings,
        sha: 'deadbeef00112233',
        posted: 12,
      }),
    )!;
    expect(l.dropped).toBeGreaterThan(0);
    expect(l.sha).toBeUndefined();
    expect(l.posted).toBe(12);
  });
});

describe('the churn streak', () => {
  const base = { v: 1 as const, round: 3, findings: [] };
  const handCrafted = (over: Record<string, unknown>) =>
    `<!-- qwen-review-ledger ${JSON.stringify({
      v: 1,
      round: 5,
      findings: [{ id: 'R5-1', sev: 'S', file: 'a.ts', title: 'x' }],
      ...over,
    })} -->`;

  // The boundary is located by the PROPERTY, never by a byte count: the
  // serializer self-sheds, so `serializeLedger(...).length` can never be
  // observed above the cap and any arithmetic built on it measures the shed
  // output rather than the pressure. So: grow the last entry's path a byte
  // at a time until the carried volume is the thing that stops fitting, and
  // keep the render one byte BELOW that as the control.
  const withVolume = (findings: LedgerFinding[], over: Partial<Ledger> = {}) =>
    serializeLedger({
      ...base,
      ...over,
      findings,
      posted: 12,
      prevPosted: 9,
    });

  const atTheVolumeBoundary = (over: Partial<Ledger> = {}) => {
    const findings: LedgerFinding[] = [];
    for (let i = 0; i < LEDGER_MAX_FINDINGS; i++) {
      const next: LedgerFinding = {
        id: `R3-${i + 1}`,
        sev: 'S',
        file: `packages/cli/src/commands/review/deep/path/file-${i}.ts`,
        title: 'x'.repeat(LEDGER_MAX_TITLE),
      };
      if (withVolume([...findings, next], over).includes('"prevPosted"')) {
        findings.push(next);
      } else {
        break;
      }
    }
    // Whole findings are ~130 bytes each, so the coarse fill lands up to one
    // entry short. Pad the last entry's PATH — the one capped field with room
    // left — until the carried volume is exactly what no longer fits.
    const grow = (n: number): LedgerFinding[] => {
      const fs = findings.slice();
      const last = fs[fs.length - 1];
      fs[fs.length - 1] = { ...last, file: last.file + 'x'.repeat(n) };
      return fs;
    };
    const room = LEDGER_MAX_FILE - findings[findings.length - 1].file.length;
    let pad = 0;
    while (pad < room && withVolume(grow(pad), over).includes('"prevPosted"')) {
      pad++;
    }
    return { over: grow(pad), under: grow(pad - 1) };
  };

  it('keeps the streak through the FIRST byte squeeze', () => {
    // The streak is NOT telemetry: it is the review's own standing claim
    // about the pull request, and `compose-review` reads it back to decide
    // whether to file the non-convergence finding. The pull request most
    // likely to be churning is also the one whose marker is closest to its
    // byte cap, so shedding the streak there would disarm the mechanism on
    // exactly the pull requests it exists for.
    const { over, under } = atTheVolumeBoundary({ churnRounds: 3 });
    // The control proves the fixture is AT the boundary rather than merely
    // over-fat: one byte less and the carried volume still fits.
    expect(withVolume(under, { churnRounds: 3 })).toContain('"prevPosted":9');
    const written = withVolume(over, { churnRounds: 3 });
    expect(written.length).toBeLessThanOrEqual(LEDGER_MAX_BYTES);
    expect(written).not.toContain('"prevPosted"');
    expect(written).toContain('"churnRounds":3');
    expect(parseLedger(written)?.churnRounds).toBe(3);
    expect(parseLedger(written)?.findings).toHaveLength(over.length);
  });

  it('keeps the streak past the rung where the VOLUME itself goes', () => {
    // The census rung alone cannot tell the two placements apart: a streak
    // wrongly nested inside the volume block still survives the first squeeze
    // (the cascade's second rung still writes a volume). The discriminating
    // fixture is the rung where `posted` ITSELF is shed — there the correct
    // placement keeps the streak and the nested one drops it, which is
    // exactly the pull request this mechanism is for: fifty findings, marker
    // at its cap, and the one integer that can end the loop.
    const fat = (n: number): LedgerFinding[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `R3-${i + 1}`,
        sev: 'S' as const,
        file: `packages/cli/src/commands/review/deep/path/file-${i}.ts`,
        title: 'x'.repeat(LEDGER_MAX_TITLE),
      }));
    let n = 1;
    let written = '';
    for (; n <= LEDGER_MAX_FINDINGS; n++) {
      written = serializeLedger({
        ...base,
        findings: fat(n),
        posted: 12,
        prevPosted: 9,
        churnRounds: 3,
      });
      if (!written.includes('"posted"')) break;
    }
    // The fixture reached that rung at all — otherwise the assertions below
    // are about a marker that never squeezed and prove nothing.
    expect(written).not.toContain('"posted"');
    expect(written).toContain('"churnRounds":3');
    expect(parseLedger(written)?.churnRounds).toBe(3);
  });

  it('omits a zero streak rather than spending bytes on it', () => {
    // A converging pull request is the common case; it should cost nothing.
    const written = serializeLedger({ ...base, churnRounds: 0 });
    expect(written).not.toContain('churnRounds');
    expect(parseLedger(written)?.churnRounds).toBeUndefined();
  });

  it.each([
    ['a float', 2.5],
    ['a negative', -1],
    ['a string', '7'],
    ['null', null],
    ['a NaN', Number.NaN],
  ])('refuses %s as a streak without losing the ledger', (_label, bad) => {
    const l = parseLedger(handCrafted({ churnRounds: bad }))!;
    expect(l.findings).toHaveLength(1);
    expect(l.churnRounds).toBeUndefined();
  });

  it('clamps the streak to the round cap on write AND on read', () => {
    // Same domain as `round`, same arithmetic hazard past the cap — and the
    // raw text is asserted for the same reason the volume cap's is: a
    // round-trip alone passes while the write side emits uncapped digits.
    const over = LEDGER_MAX_ROUND + 1;
    const written = serializeLedger({ ...base, churnRounds: over });
    expect(written).toContain(`"churnRounds":${LEDGER_MAX_ROUND}`);
    expect(written).not.toContain(String(over));
    expect(
      parseLedger(handCrafted({ round: LEDGER_MAX_ROUND, churnRounds: over }))
        ?.churnRounds,
    ).toBe(LEDGER_MAX_ROUND);
  });

  it('clamps a recovered streak to the marker’s own round', () => {
    // The streak counts rounds INSIDE the round it rides, so a legitimate
    // marker can never carry more counted rounds than rounds it claims.
    // The marker body is any GitHub user's writable surface: unclamped,
    // `{round: 2, churnRounds: 9999}` beside one honest above-bar round
    // posts "the 10000th round…" on a pull request in its third. Same
    // invariant the finding-id squat filter enforces — a claim about rounds
    // that did not exist is not read.
    const forged = `<!-- qwen-review-ledger ${JSON.stringify({
      v: 1,
      round: 2,
      findings: [{ id: 'R2-1', sev: 'S', file: 'a.ts', title: 'x' }],
      churnRounds: 9999,
    })} -->`;
    expect(parseLedger(forged)?.churnRounds).toBe(2);
    // A streak AT the round rides untouched — the clamp strips nothing a
    // legitimate marker can carry (round 5 is the handCrafted default).
    expect(parseLedger(handCrafted({ churnRounds: 5 }))?.churnRounds).toBe(5);
  });
});

describe('the flat streak', () => {
  // Mirror of the churn block above for the floor trigger's streak (#9903):
  // the two fields share the serializer rung and the trust shape, and two
  // mutations of the diff's own lines — nesting the write inside the
  // volume-shed block, and deleting the parse-side clamp — survive the whole
  // suite unless pinned here. The values used are HONEST ones (round 3
  // carries at most 1): the read clamps to the honest maximum, because the
  // signal that advances the streak gates on round >= 3.
  const base = { v: 1 as const, round: 3, findings: [] };
  const handCrafted = (over: Record<string, unknown>) =>
    `<!-- qwen-review-ledger ${JSON.stringify({
      v: 1,
      round: 5,
      findings: [{ id: 'R5-1', sev: 'S', file: 'a.ts', title: 'x' }],
      ...over,
    })} -->`;

  const withVolume = (findings: LedgerFinding[], over: Partial<Ledger> = {}) =>
    serializeLedger({
      ...base,
      ...over,
      findings,
      posted: 12,
      prevPosted: 9,
    });

  const atTheVolumeBoundary = (over: Partial<Ledger> = {}) => {
    const findings: LedgerFinding[] = [];
    for (let i = 0; i < LEDGER_MAX_FINDINGS; i++) {
      const next: LedgerFinding = {
        id: `R3-${i + 1}`,
        sev: 'S',
        file: `packages/cli/src/commands/review/deep/path/file-${i}.ts`,
        title: 'x'.repeat(LEDGER_MAX_TITLE),
      };
      if (withVolume([...findings, next], over).includes('"prevPosted"')) {
        findings.push(next);
      } else {
        break;
      }
    }
    const grow = (n: number): LedgerFinding[] => {
      const fs = findings.slice();
      const last = fs[fs.length - 1];
      fs[fs.length - 1] = { ...last, file: last.file + 'x'.repeat(n) };
      return fs;
    };
    const room = LEDGER_MAX_FILE - findings[findings.length - 1].file.length;
    let pad = 0;
    while (pad < room && withVolume(grow(pad), over).includes('"prevPosted"')) {
      pad++;
    }
    return { over: grow(pad), under: grow(pad - 1) };
  };

  it('keeps the streak through the FIRST byte squeeze', () => {
    // The pull request whose first-time-finding rate never falls is exactly
    // the one whose marker sits at the byte cap; shedding the latched streak
    // there would silently release the floor between rounds 4 and 6.
    const { over, under } = atTheVolumeBoundary({ flatRounds: 1 });
    expect(withVolume(under, { flatRounds: 1 })).toContain('"prevPosted":9');
    const written = withVolume(over, { flatRounds: 1 });
    expect(written.length).toBeLessThanOrEqual(LEDGER_MAX_BYTES);
    expect(written).not.toContain('"prevPosted"');
    expect(written).toContain('"flatRounds":1');
    expect(parseLedger(written)?.flatRounds).toBe(1);
    expect(parseLedger(written)?.findings).toHaveLength(over.length);
  });

  it('keeps the streak past the rung where the VOLUME itself goes', () => {
    // The discriminating rung: a streak wrongly nested inside the volume
    // block survives the first squeeze but sheds with `posted` itself — the
    // correct placement keeps it, on exactly the over-cap markers.
    const fat = (n: number): LedgerFinding[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `R3-${i + 1}`,
        sev: 'S' as const,
        file: `packages/cli/src/commands/review/deep/path/file-${i}.ts`,
        title: 'x'.repeat(LEDGER_MAX_TITLE),
      }));
    let n = 1;
    let written = '';
    for (; n <= LEDGER_MAX_FINDINGS; n++) {
      written = serializeLedger({
        ...base,
        findings: fat(n),
        posted: 12,
        prevPosted: 9,
        flatRounds: 1,
      });
      if (!written.includes('"posted"')) break;
    }
    expect(written).not.toContain('"posted"');
    expect(written).toContain('"flatRounds":1');
    expect(parseLedger(written)?.flatRounds).toBe(1);
  });

  it('omits a zero streak rather than spending bytes on it', () => {
    const written = serializeLedger({ ...base, flatRounds: 0 });
    expect(written).not.toContain('flatRounds');
    expect(parseLedger(written)?.flatRounds).toBeUndefined();
  });

  it.each([
    ['a float', 2.5],
    ['a negative', -1],
    ['a string', '7'],
    ['null', null],
    ['a NaN', Number.NaN],
  ])('refuses %s as a streak without losing the ledger', (_label, bad) => {
    const l = parseLedger(handCrafted({ flatRounds: bad }))!;
    expect(l.findings).toHaveLength(1);
    expect(l.flatRounds).toBeUndefined();
  });

  it('clamps the streak to the round cap on write AND on read', () => {
    const over = LEDGER_MAX_ROUND + 1;
    const written = serializeLedger({ ...base, flatRounds: over });
    expect(written).toContain(`"flatRounds":${LEDGER_MAX_ROUND}`);
    expect(written).not.toContain(String(over));
    // The read side clamps TIGHTER — to the honest maximum: at the round
    // cap no honest run has measured more than cap - 2 firing rounds.
    expect(
      parseLedger(handCrafted({ round: LEDGER_MAX_ROUND, flatRounds: over }))
        ?.flatRounds,
    ).toBe(LEDGER_MAX_ROUND - 2);
  });

  it('clamps a recovered streak to the honest maximum, not merely the round', () => {
    // The signal that advances the streak gates on round >= 3, so rounds
    // 1–2 are unmeasurable and at round N no honest marker carries more
    // than N - 2. The round-clamp alone admitted `{round: 2, flatRounds: 2}`
    // — a streak the serializer never emits, which the model-side routing
    // reads raw off the side file.
    const forged = `<!-- qwen-review-ledger ${JSON.stringify({
      v: 1,
      round: 2,
      findings: [{ id: 'R2-1', sev: 'S', file: 'a.ts', title: 'x' }],
      flatRounds: 9999,
    })} -->`;
    expect(parseLedger(forged)?.flatRounds).toBeUndefined();
    expect(parseLedger(handCrafted({ flatRounds: 9999 }))?.flatRounds).toBe(3);
    // A streak AT the honest maximum rides untouched (round 5 → 3).
    expect(parseLedger(handCrafted({ flatRounds: 3 }))?.flatRounds).toBe(3);
  });
});

describe('the recommendation-code carrier (#10107)', () => {
  // The field is the workflow consumer's ONLY view of the diagnosis's
  // machine-readable half, so the tests pin the two properties that carry
  // the feature: it survives the byte cascade on exactly the over-cap
  // markers where a non-converging loop lives, and it is write-only — a
  // recovered marker contributes no codes, because nothing CLI-side may act
  // on a value another account's writable surface controls.
  const base = { v: 1 as const, round: 3, findings: [] };

  it('carries the codes past the rung where the volume sheds', () => {
    const fat = (n: number): LedgerFinding[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `R3-${i + 1}`,
        sev: 'S' as const,
        file: `packages/cli/src/commands/review/deep/path/file-${i}.ts`,
        title: 'x'.repeat(LEDGER_MAX_TITLE),
      }));
    let written = '';
    for (let n = 1; n <= LEDGER_MAX_FINDINGS; n++) {
      written = serializeLedger({
        ...base,
        findings: fat(n),
        posted: 12,
        prevPosted: 9,
        rec: ['root-cause-triage', 'batch-fixes'],
      });
      if (!written.includes('"posted"')) break;
    }
    expect(written).not.toContain('"posted"');
    expect(written).toContain('"rec":["root-cause-triage","batch-fixes"]');
    expect(written.length).toBeLessThanOrEqual(LEDGER_MAX_BYTES);
  });

  it('omits an empty or absent set rather than spending bytes on it', () => {
    expect(serializeLedger({ ...base })).not.toContain('"rec"');
    expect(serializeLedger({ ...base, rec: [] })).not.toContain('"rec"');
  });

  it('bounds the shape: drops non-strings and overlong codes, dedupes, caps the count', () => {
    const written = serializeLedger({
      ...base,
      rec: [
        'batch-fixes',
        'batch-fixes',
        '',
        'x'.repeat(LEDGER_MAX_REC_CODE + 1),
        7 as unknown as string,
        null as unknown as string,
        ...Array.from({ length: LEDGER_MAX_REC_CODES + 3 }, (_, i) => `c${i}`),
      ],
    });
    const parsed = JSON.parse(
      written.replace('<!-- qwen-review-ledger ', '').replace(' -->', ''),
    ) as { rec: string[] };
    expect(parsed.rec[0]).toBe('batch-fixes');
    expect(parsed.rec).toHaveLength(LEDGER_MAX_REC_CODES);
    expect(new Set(parsed.rec).size).toBe(parsed.rec.length);
    expect(parsed.rec.every((c) => c.length <= LEDGER_MAX_REC_CODE)).toBe(true);
  });

  it('is write-only: parseLedger recovers no codes from a marker that carries them', () => {
    const written = serializeLedger({ ...base, rec: ['stem-surface'] });
    expect(written).toContain('"rec":["stem-surface"]');
    expect(parseLedger(written)).not.toHaveProperty('rec');
  });

  it('stays comment-safe under the -- escape a code could smuggle', () => {
    // Codes are vocabulary-bound at the write site, but the serializer's
    // escape must hold for the shape bound alone: a `--` inside the payload
    // would close the HTML comment early and spill the tail as visible text.
    const written = serializeLedger({ ...base, rec: ['a--b'] });
    expect(written.indexOf('-->')).toBe(written.length - '-->'.length);
    expect(
      (
        JSON.parse(
          written.replace('<!-- qwen-review-ledger ', '').replace(' -->', ''),
        ) as { rec: string[] }
      ).rec,
    ).toEqual(['a--b']);
  });
});

describe('the finding axes (#10291)', () => {
  it('round-trips a classified Critical, and spends no bytes on an unclassified one', () => {
    const marker = serializeLedger({
      v: 1,
      round: 3,
      findings: [
        { id: 'R3-1', sev: 'C', d: 'f', b: 'n', file: 'a.ts', title: 'wedge' },
        { id: 'R3-2', sev: 'C', d: 'c', file: 'b.ts', title: 'lie' },
        { id: 'R3-3', sev: 'C', file: 'c.ts', title: 'unclassified' },
      ],
    });
    const back = parseLedger(marker)!;
    expect(back.findings[0]).toMatchObject({ d: 'f', b: 'n' });
    expect(back.findings[1]).toMatchObject({ d: 'c' });
    expect(back.findings[1].b).toBeUndefined();
    expect(back.findings[2].d).toBeUndefined();
    expect(back.findings[2].b).toBeUndefined();
    expect(marker.match(/"d":/g)).toHaveLength(2);
    expect(marker.match(/"b":/g)).toHaveLength(1);
  });

  it('normalises an unrecognised axis instead of dropping the finding — the fields decide nothing', () => {
    // The marker is a cross-environment carrier: a later version adding a
    // third direction, a hand edit, or a foreign marker must not make an
    // older CLI drop the finding from the work list.
    const marker =
      '<!-- qwen-review-ledger {"v":1,"round":3,"findings":[' +
      '{"id":"R3-1","sev":"C","file":"a.ts","title":"t","d":"x","b":"n"}' +
      ']} -->';
    const parsed = parseLedger(marker)!;
    expect(parsed.findings).toEqual([
      { id: 'R3-1', sev: 'C', file: 'a.ts', title: 't', b: 'n' },
    ]);
    expect(parsed.dropped).toBeUndefined();
    expect(
      normalizeLedgerFinding({
        id: 'R3-1',
        sev: 'C',
        file: 'a.ts',
        title: 't',
        d: 'f',
        b: 'z' as never,
      }),
    ).toEqual({ id: 'R3-1', sev: 'C', file: 'a.ts', title: 't', d: 'f' });
  });

  it('spells the axes out once, for every renderer', () => {
    expect(axesOf({ d: 'f', b: 'n' })).toBe('fails-closed, new-surface');
    expect(axesOf({ d: 'c' })).toBe('certifies-falsely');
    expect(axesOf({ b: 'r' })).toBe('regression');
    expect(axesOf({})).toBe('');
  });
});
