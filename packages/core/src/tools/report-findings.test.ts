/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ReportFindingsTool,
  compressFindingSummary,
  REPORT_FINDINGS_MAX,
  type ReportFindingsFindingParams,
  type ReportFindingsParams,
} from './report-findings.js';
import type { FindingsResultDisplay } from './tools.js';

function finding(
  overrides: Partial<ReportFindingsFindingParams> = {},
): ReportFindingsFindingParams {
  return {
    severity: 'Critical',
    file: 'src/foo.ts',
    line: 42,
    summary: 'wrong return value on cold cache',
    failureScenario: 'first call after start returns undefined',
    ...overrides,
  };
}

async function run(params: ReportFindingsParams) {
  const tool = new ReportFindingsTool();
  const invocation = tool.build(params);
  return invocation.execute(new AbortController().signal);
}

function displayOf(result: { returnDisplay: unknown }): FindingsResultDisplay {
  return result.returnDisplay as FindingsResultDisplay;
}

describe('ReportFindingsTool', () => {
  it('reports findings as a findings_list display with counts in llmContent', async () => {
    const result = await run({
      level: 'high',
      findings: [
        finding(),
        finding({
          severity: 'Suggestion',
          file: 'src/bar.ts',
          summary: 'duplicated helper',
          failureScenario: 'two copies drift',
        }),
      ],
    });
    const display = displayOf(result);
    expect(display.type).toBe('findings_list');
    expect(display.level).toBe('high');
    expect(display.findings).toHaveLength(2);
    expect(result.llmContent).toContain('2 findings');
    expect(result.llmContent).toContain('1 Critical');
    expect(result.llmContent).toContain('1 Suggestion');
    expect(result.error).toBeUndefined();
  });

  it('sorts severity first, then confidence, then location', async () => {
    const result = await run({
      findings: [
        finding({
          severity: 'Nice to have',
          file: 'a.ts',
          summary: 'nit',
          failureScenario: 'cost',
        }),
        finding({
          severity: 'Critical',
          confidence: 'low',
          file: 'z.ts',
          summary: 'possible race',
          failureScenario: 'unlikely interleaving',
        }),
        finding({
          severity: 'Critical',
          confidence: 'high',
          file: 'z.ts',
          summary: 'confirmed race',
          failureScenario: 'interleaving observed',
        }),
        finding({
          severity: 'Suggestion',
          file: 'm.ts',
          summary: 'clearer name',
          failureScenario: 'reader cost',
        }),
      ],
    });
    const summaries = displayOf(result).findings.map((f) => f.summary);
    expect(summaries).toEqual([
      'confirmed race',
      'possible race',
      'clearer name',
      'nit',
    ]);
  });

  it('breaks location ties the way the artifact does: missing line first, then id by code units', async () => {
    // The two entries on z.ts:42 arrive with the LOWER-sorting id last, so a
    // dropped id tiebreak (stable sort keeps input order) flips the expected
    // order; the body finding has no line and must rank before every
    // line-anchored one on the same file (`?? 0`, the artifact's rule).
    const result = await run({
      findings: [
        finding({
          id: 'R1-2',
          file: 'z.ts',
          line: 42,
          summary: 'second by id',
          failureScenario: 'tie',
        }),
        finding({
          id: 'R1-10',
          file: 'z.ts',
          line: 42,
          summary: 'first by id',
          failureScenario: 'tie',
        }),
        finding({
          id: 'R1-3',
          file: 'z.ts',
          line: undefined,
          summary: 'body finding without a line',
          failureScenario: 'unanchored',
        }),
      ],
    });
    expect(displayOf(result).findings.map((f) => f.summary)).toEqual([
      'body finding without a line',
      'first by id',
      'second by id',
    ]);
  });

  it('derives shortSummary from summary, prefers a supplied one, and compresses both', async () => {
    // Pins both branches of the `raw.shortSummary?.trim() || raw.summary`
    // derivation by exact value: the derived label must be the compressed
    // SUMMARY (word-boundary cut), the supplied label must survive as itself.
    const longSummary =
      'the retry guard drops the final attempt when the backoff timer fires after the abort signal has already resolved';
    const result = await run({
      findings: [
        finding({ summary: longSummary }),
        finding({ file: 'src/other.ts', shortSummary: 'supplied label' }),
        finding({
          file: 'src/third.ts',
          shortSummary: `supplied ${'x'.repeat(100)}`,
        }),
      ],
    });
    const byFile = Object.fromEntries(
      displayOf(result).findings.map((f) => [f.file, f]),
    );
    expect(byFile['src/foo.ts'].shortSummary).toBe(
      'the retry guard drops the final attempt when the backoff…',
    );
    expect(byFile['src/other.ts'].shortSummary).toBe('supplied label');
    const compressedSupplied = byFile['src/third.ts'].shortSummary;
    expect(compressedSupplied.length).toBeLessThanOrEqual(60);
    expect(compressedSupplied.startsWith('supplied x')).toBe(true);
    expect(compressedSupplied.endsWith('…')).toBe(true);
  });

  it('accepts an empty findings list as a valid nothing-found report', async () => {
    const result = await run({ findings: [] });
    expect(displayOf(result).findings).toEqual([]);
    expect(result.llmContent).toContain('empty findings list');
  });

  it('reports outcome counts when every finding carries one', async () => {
    const result = await run({
      findings: [
        finding({ id: 'R1-1', outcome: 'fixed' }),
        finding({
          id: 'R1-2',
          file: 'src/bar.ts',
          outcome: 'skipped',
          outcomeNote: 'fix would change intended behaviour',
        }),
      ],
    });
    expect(result.llmContent).toContain('1 fixed');
    expect(result.llmContent).toContain('1 skipped');
    expect(displayOf(result).findings.map((f) => f.outcome)).toEqual([
      'skipped',
      'fixed',
    ]);
  });

  it('refuses a partial outcome set', () => {
    const tool = new ReportFindingsTool();
    expect(() =>
      tool.build({
        findings: [
          finding({ outcome: 'fixed' }),
          finding({ file: 'src/bar.ts' }),
        ],
      }),
    ).toThrow(/every finding or none/);
  });

  it('refuses duplicate ids', () => {
    const tool = new ReportFindingsTool();
    expect(() =>
      tool.build({
        findings: [
          finding({ id: 'R1-1' }),
          finding({ id: 'R1-1', file: 'src/bar.ts' }),
        ],
      }),
    ).toThrow(/duplicate id "R1-1"/);
  });

  it.each([
    ['file', { file: 'src/foo.ts\u0007' }],
    ['id', { id: 'R1\u00071' }],
    ['summary', { summary: 'beep\u0007boop' }],
    ['shortSummary', { shortSummary: 'short\u0007' }],
    ['failureScenario', { failureScenario: 'boom\u0007' }],
    ['category', { category: 'corr\u0007' }],
    ['outcomeNote', { outcome: 'skipped' as const, outcomeNote: 'no\u0007te' }],
  ])(
    'refuses control characters in %s',
    (_field: string, overrides: Partial<ReportFindingsFindingParams>) => {
      const tool = new ReportFindingsTool();
      expect(() => tool.build({ findings: [finding(overrides)] })).toThrow(
        /control characters/,
      );
    },
  );

  it('allows line whitespace only in the prose fields', () => {
    const tool = new ReportFindingsTool();
    expect(() =>
      tool.build({
        findings: [finding({ summary: 'line one\nline two' })],
      }),
    ).not.toThrow();
    expect(() =>
      tool.build({
        findings: [finding({ failureScenario: 'step one\nstep two' })],
      }),
    ).not.toThrow();
    expect(() =>
      tool.build({
        findings: [
          finding({ outcome: 'skipped', outcomeNote: 'reason one\ntwo' }),
        ],
      }),
    ).not.toThrow();
    expect(() =>
      tool.build({
        findings: [finding({ file: 'src/\nfoo.ts' })],
      }),
    ).toThrow(/control characters/);
    expect(() =>
      tool.build({
        findings: [finding({ shortSummary: 'one\ntwo' })],
      }),
    ).toThrow(/control characters/);
  });

  it('refuses schema violations: missing failureScenario, bad enums, over-long lists', () => {
    const tool = new ReportFindingsTool();
    expect(() =>
      tool.build({
        findings: [
          { severity: 'Critical', file: 'a.ts', summary: 's' },
        ] as ReportFindingsFindingParams[],
      }),
    ).toThrow();
    expect(() =>
      tool.build({
        findings: [finding({ severity: 'blocker' as 'Critical' })],
      }),
    ).toThrow();
    expect(() =>
      tool.build({
        level: 'ultra' as 'high',
        findings: [finding()],
      }),
    ).toThrow();
    expect(() =>
      tool.build({
        findings: Array.from({ length: REPORT_FINDINGS_MAX + 1 }, (_, i) =>
          finding({ file: `src/f${i}.ts` }),
        ),
      }),
    ).toThrow();
  });

  it('refuses blank required fields after trimming', () => {
    const tool = new ReportFindingsTool();
    expect(() => tool.build({ findings: [finding({ file: '   ' })] })).toThrow(
      /"file" must not be empty/,
    );
    expect(() =>
      tool.build({ findings: [finding({ summary: '  ' })] }),
    ).toThrow(/"summary" must not be empty/);
    expect(() =>
      tool.build({ findings: [finding({ failureScenario: ' ' })] }),
    ).toThrow(/"failureScenario" must not be empty/);
  });

  it('trims fields and drops empty optionals in the display', async () => {
    const result = await run({
      findings: [
        finding({
          id: '  ',
          file: ' src/foo.ts ',
          summary: ' padded summary ',
          category: '',
        }),
      ],
    });
    const [item] = displayOf(result).findings;
    expect(item.id).toBeUndefined();
    expect(item.file).toBe('src/foo.ts');
    expect(item.summary).toBe('padded summary');
    expect(item.category).toBeUndefined();
  });

  it('passes id and line through to the display item', async () => {
    const result = await run({
      findings: [finding({ id: 'R2-7', line: 314 })],
    });
    const [item] = displayOf(result).findings;
    expect(item.id).toBe('R2-7');
    expect(item.line).toBe(314);
  });
});

describe('compressFindingSummary', () => {
  it('returns short summaries unchanged, collapsed to one line', () => {
    expect(compressFindingSummary('a  short\nsummary')).toBe('a short summary');
  });

  it('cuts on a word boundary with a single ellipsis character', () => {
    // Exact value on purpose: a hard cut at 59 units would yield
    // '…keeps on ru…', which satisfies every length/ellipsis assertion —
    // only the full string pins the word-boundary logic itself.
    expect(
      compressFindingSummary(
        'the quick brown fox jumps over the lazy dog and keeps on running far beyond the fence',
      ),
    ).toBe('the quick brown fox jumps over the lazy dog and keeps on…');
  });

  it('keeps a hard cut off the middle of a surrogate pair', () => {
    // 58 filler units put the astral character across units 58-59, exactly
    // where the hard cut lands; spaceless input keeps the word-boundary
    // rescue out of the way.
    const short = compressFindingSummary(`${'a'.repeat(58)}𝕏 tail words`);
    expect(short).toBe(`${'a'.repeat(58)}…`);
  });
});
