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
});
