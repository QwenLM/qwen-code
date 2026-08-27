/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ReportFindingsTool,
  compressFindingSummary,
  REPORT_FINDINGS_FILE_MAX,
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
  it('does not constrain finding summaries in its tool schema', () => {
    const tool = new ReportFindingsTool();
    const schema = tool.schema.parametersJsonSchema as {
      properties: {
        findings: {
          items: { properties: { summary: Record<string, unknown> } };
        };
      };
    };

    expect(
      schema.properties.findings.items.properties.summary,
    ).not.toHaveProperty('maxLength');
  });

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

  it('orders the file and id axes by code units, not locale collation', async () => {
    // Mixed-case names are where ICU collation and code-unit order disagree
    // ('a' collates before 'B' but ranks after it by code unit); every other
    // fixture in this suite is lowercase ASCII, where the two coincide. Each
    // pair arrives lower-sorting first, so a dropped axis (stable sort keeps
    // input order) or one reverted to localeCompare flips the expected order.
    const result = await run({
      findings: [
        finding({
          id: 'a-1',
          file: 'a.ts',
          summary: 'lowercase file',
          failureScenario: 'tie',
        }),
        finding({
          id: 'B-1',
          file: 'B.ts',
          summary: 'uppercase file',
          failureScenario: 'tie',
        }),
        finding({
          id: 'a-2',
          file: 'z.ts',
          line: 7,
          summary: 'lowercase id',
          failureScenario: 'tie',
        }),
        finding({
          id: 'B-2',
          file: 'z.ts',
          line: 7,
          summary: 'uppercase id',
          failureScenario: 'tie',
        }),
      ],
    });
    expect(displayOf(result).findings.map((f) => f.summary)).toEqual([
      'uppercase file',
      'lowercase file',
      'uppercase id',
      'lowercase id',
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

  it('accepts file paths the artifact preserves and refuses beyond the path domain', async () => {
    // The artifact keeps repo-relative paths to the filesystem limit; a
    // 513-character path it preserves must not refuse the whole in-band list.
    const file = `src/${'a'.repeat(506)}.ts`;
    expect(file).toHaveLength(513);
    const result = await run({ findings: [finding({ file })] });
    expect(displayOf(result).findings[0].file).toBe(file);
    const tool = new ReportFindingsTool();
    expect(() =>
      tool.build({
        findings: [finding({ file: 'a'.repeat(REPORT_FINDINGS_FILE_MAX) })],
      }),
    ).not.toThrow();
    expect(() =>
      tool.build({
        findings: [finding({ file: 'a'.repeat(REPORT_FINDINGS_FILE_MAX + 1) })],
      }),
    ).toThrow();
  });

  it('accepts MAX_SAFE_INTEGER line numbers and refuses unsafe ones', async () => {
    const result = await run({
      findings: [finding({ line: Number.MAX_SAFE_INTEGER })],
    });
    expect(displayOf(result).findings[0].line).toBe(Number.MAX_SAFE_INTEGER);
    const tool = new ReportFindingsTool();
    // MAX_SAFE_INTEGER + 1 is representable — JSON keeps it, and the
    // rounding that produced it is invisible — so the schema alone cannot
    // catch it.
    expect(() =>
      tool.build({
        findings: [finding({ line: Number.MAX_SAFE_INTEGER + 1 })],
      }),
    ).toThrow(/safe range/);
  });

  it('requires a non-empty outcomeNote for every skipped outcome', () => {
    const tool = new ReportFindingsTool();
    expect(() =>
      tool.build({ findings: [finding({ outcome: 'skipped' })] }),
    ).toThrow(/"outcomeNote" is required/);
    expect(() =>
      tool.build({
        findings: [finding({ outcome: 'skipped', outcomeNote: '   ' })],
      }),
    ).toThrow(/"outcomeNote" is required/);
    expect(() =>
      tool.build({
        findings: [
          finding({ outcome: 'skipped', outcomeNote: 'needs a product call' }),
        ],
      }),
    ).not.toThrow();
  });

  it('refuses an outcome replacement that does not match the active report', async () => {
    // Nine findings reported, six fixed: the other three must not silently
    // disappear from the client state behind an outcome set that covers only
    // what the fixer handled.
    const tool = new ReportFindingsTool();
    const nine = Array.from({ length: 9 }, (_, i) =>
      finding({ id: `R1-${i + 1}`, file: `src/f${i}.ts` }),
    );
    await tool.build({ findings: nine }).execute(new AbortController().signal);

    const subset = nine
      .slice(0, 6)
      .map((f) => ({ ...f, outcome: 'fixed' as const }));
    expect(() => tool.build({ findings: subset })).toThrow(
      /drops 3 finding\(s\) from the active report: "R1-7", "R1-8", "R1-9"/,
    );

    const ghost = [...nine, finding({ id: 'R1-10', file: 'src/ghost.ts' })].map(
      (f) => ({ ...f, outcome: 'fixed' as const }),
    );
    expect(() => tool.build({ findings: ghost })).toThrow(/"R1-10"/);

    const full = nine.map((f) => ({ ...f, outcome: 'fixed' as const }));
    const result = await tool
      .build({ findings: full })
      .execute(new AbortController().signal);
    expect(displayOf(result).findings).toHaveLength(9);

    // A fresh report without outcomes replaces the active identity.
    await tool
      .build({ findings: [finding({ id: 'R2-1', file: 'src/new.ts' })] })
      .execute(new AbortController().signal);
    await tool
      .build({
        findings: [
          finding({
            id: 'R2-1',
            file: 'src/new.ts',
            outcome: 'no_change_needed',
          }),
        ],
      })
      .execute(new AbortController().signal);
  });

  it('does not hold an outcome call to a report that had no identity', async () => {
    // A low-effort pass reports without artifact ids, so there is no id set
    // a later outcome call could be joined against; an empty report
    // establishes no identity either.
    const tool = new ReportFindingsTool();
    await tool
      .build({ findings: [finding()] })
      .execute(new AbortController().signal);
    await tool
      .build({ findings: [finding({ outcome: 'fixed' })] })
      .execute(new AbortController().signal);
    await tool.build({ findings: [] }).execute(new AbortController().signal);
    await tool
      .build({ findings: [finding({ outcome: 'fixed' })] })
      .execute(new AbortController().signal);
  });

  it('does not commit the identity at build: an undelivered report blocks nothing', async () => {
    // The scheduler builds every invocation of a batch up front and can
    // discard one before it executes (pre-validation cancellation, an
    // aborted signal). Identity committed at build time would make the
    // never-delivered round-2 report the active one, rejecting a
    // legitimate outcome call for the round-1 report the client shows.
    const tool = new ReportFindingsTool();
    await tool
      .build({ findings: [finding({ id: 'R1-1' })] })
      .execute(new AbortController().signal);
    // Built but never executed — a cancelled turn's dropped call.
    tool.build({ findings: [finding({ id: 'R2-1', file: 'src/new.ts' })] });

    const outcome = await tool
      .build({
        findings: [finding({ id: 'R1-1', outcome: 'fixed' })],
      })
      .execute(new AbortController().signal);
    expect(displayOf(outcome).findings[0].outcome).toBe('fixed');
  });

  it('clears the identity when a later report has none', async () => {
    // The removal transition: an id-less re-report (a low-effort pass)
    // replaces the active identity with none, so a following outcome call
    // is accepted on its own terms instead of being held to the old ids.
    const tool = new ReportFindingsTool();
    await tool
      .build({ findings: [finding({ id: 'R1-1' })] })
      .execute(new AbortController().signal);
    await tool
      .build({ findings: [finding({ file: 'src/new.ts' })] })
      .execute(new AbortController().signal);

    const result = await tool
      .build({
        findings: [finding({ id: 'R9-9', outcome: 'fixed' })],
      })
      .execute(new AbortController().signal);
    expect(displayOf(result).findings).toHaveLength(1);
  });

  it('documents the cold-resume limit: a fresh instance has no active identity', async () => {
    // The identity gate is a live-process contract. A cold session resume
    // (--resume, a restart) constructs a fresh tool instance that never saw
    // the pre-restart report, so an outcome call is validated on its own
    // terms — all-or-nothing outcomes — instead of against the old list.
    // The same subset the original instance rejects is accepted here.
    const original = new ReportFindingsTool();
    await original
      .build({
        findings: [
          finding({ id: 'R1-1' }),
          finding({ id: 'R1-2', file: 'src/bar.ts' }),
          finding({ id: 'R1-3', file: 'src/baz.ts' }),
        ],
      })
      .execute(new AbortController().signal);
    expect(() =>
      original.build({
        findings: [finding({ id: 'R1-1', outcome: 'fixed' })],
      }),
    ).toThrow(/drops 2 finding\(s\) from the active report/);

    const resumed = new ReportFindingsTool();
    const result = await resumed
      .build({
        findings: [finding({ id: 'R1-1', outcome: 'fixed' })],
      })
      .execute(new AbortController().signal);
    expect(displayOf(result).findings).toHaveLength(1);
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
