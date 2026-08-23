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

  it('derives shortSummary from summary and compresses long values to 60 chars', async () => {
    const longSummary =
      'the retry guard drops the final attempt when the backoff timer fires after the abort signal has already resolved';
    const result = await run({
      findings: [
        finding({ summary: longSummary }),
        finding({
          file: 'src/other.ts',
          shortSummary: `supplied ${'x'.repeat(100)}`,
        }),
      ],
    });
    for (const f of displayOf(result).findings) {
      expect(f.shortSummary.length).toBeLessThanOrEqual(60);
    }
    expect(
      displayOf(result).findings.some((f) => f.shortSummary.endsWith('…')),
    ).toBe(true);
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

  it('refuses control characters in display fields', () => {
    const tool = new ReportFindingsTool();
    expect(() =>
      tool.build({
        findings: [finding({ file: 'src/foo.ts\u0007' })],
      }),
    ).toThrow(/control characters/);
  });

  it('allows line whitespace in summary but not in file', () => {
    const tool = new ReportFindingsTool();
    expect(() =>
      tool.build({
        findings: [finding({ summary: 'line one\nline two' })],
      }),
    ).not.toThrow();
    expect(() =>
      tool.build({
        findings: [finding({ file: 'src/\nfoo.ts' })],
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
});

describe('compressFindingSummary', () => {
  it('returns short summaries unchanged, collapsed to one line', () => {
    expect(compressFindingSummary('a  short\nsummary')).toBe('a short summary');
  });

  it('cuts on a word boundary with a single ellipsis character', () => {
    const compressed = compressFindingSummary(
      'the quick brown fox jumps over the lazy dog and keeps on running far beyond the fence',
    );
    expect(compressed.length).toBeLessThanOrEqual(60);
    expect(compressed.endsWith('…')).toBe(true);
    expect(compressed).not.toContain('...');
  });
});
