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

/** Builds and executes one report on `tool`. */
function exec(
  tool: ReportFindingsTool,
  ...findings: ReportFindingsFindingParams[]
) {
  return tool.build({ findings }).execute(new AbortController().signal);
}

/** Executes one report on a fresh tool. */
const run = (...findings: ReportFindingsFindingParams[]) =>
  exec(new ReportFindingsTool(), ...findings);

/** A deferred build on a fresh tool (build commits no state), for toThrow. */
const tryBuild =
  (...findings: ReportFindingsFindingParams[]) =>
  () =>
    new ReportFindingsTool().build({ findings });
const tryOne = (overrides: Partial<ReportFindingsFindingParams>) =>
  tryBuild(finding(overrides));

function displayOf(result: { returnDisplay: unknown }): FindingsResultDisplay {
  return result.returnDisplay as FindingsResultDisplay;
}
/** A finding whose failure scenario is an ordering tie. */
const tie = (overrides: Partial<ReportFindingsFindingParams>) =>
  finding({ failureScenario: 'tie', ...overrides });
const summariesOf = (result: { returnDisplay: unknown }) =>
  displayOf(result).findings.map((f) => f.summary);

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
    const result = await new ReportFindingsTool()
      .build({
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
      })
      .execute(new AbortController().signal);
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
    const result = await run(
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
    );
    expect(summariesOf(result)).toEqual([
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
    const result = await run(
      tie({ id: 'R1-2', file: 'z.ts', line: 42, summary: 'second by id' }),
      tie({ id: 'R1-10', file: 'z.ts', line: 42, summary: 'first by id' }),
      finding({
        id: 'R1-3',
        file: 'z.ts',
        line: undefined,
        summary: 'body finding without a line',
        failureScenario: 'unanchored',
      }),
    );
    expect(summariesOf(result)).toEqual([
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
    const result = await run(
      tie({ id: 'a-1', file: 'a.ts', summary: 'lowercase file' }),
      tie({ id: 'B-1', file: 'B.ts', summary: 'uppercase file' }),
      tie({ id: 'a-2', file: 'z.ts', line: 7, summary: 'lowercase id' }),
      tie({ id: 'B-2', file: 'z.ts', line: 7, summary: 'uppercase id' }),
    );
    expect(summariesOf(result)).toEqual([
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
    const result = await run(
      finding({ summary: longSummary }),
      finding({ file: 'src/other.ts', shortSummary: 'supplied label' }),
      finding({
        file: 'src/third.ts',
        shortSummary: `supplied ${'x'.repeat(100)}`,
      }),
    );
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
    const result = await run();
    expect(displayOf(result).findings).toEqual([]);
    expect(result.llmContent).toContain('empty findings list');
  });

  it('reports outcome counts when every finding carries one', async () => {
    const result = await run(
      finding({ id: 'R1-1', outcome: 'fixed' }),
      finding({
        id: 'R1-2',
        file: 'src/bar.ts',
        outcome: 'skipped',
        outcomeNote: 'fix would change intended behaviour',
      }),
    );
    expect(result.llmContent).toContain('1 fixed');
    expect(result.llmContent).toContain('1 skipped');
    expect(displayOf(result).findings.map((f) => f.outcome)).toEqual([
      'skipped',
      'fixed',
    ]);
  });

  it('refuses a partial outcome set', () => {
    expect(
      tryBuild(finding({ outcome: 'fixed' }), finding({ file: 'src/bar.ts' })),
    ).toThrow(/every finding or none/);
  });

  it('refuses duplicate ids', () => {
    expect(
      tryBuild(
        finding({ id: 'R1-1' }),
        finding({ id: 'R1-1', file: 'src/bar.ts' }),
      ),
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
      expect(tryOne(overrides)).toThrow(/control characters/);
    },
  );

  it('allows line whitespace only in the prose fields', () => {
    expect(tryOne({ summary: 'line one\nline two' })).not.toThrow();
    expect(tryOne({ failureScenario: 'step one\nstep two' })).not.toThrow();
    expect(
      tryOne({ outcome: 'skipped', outcomeNote: 'reason one\ntwo' }),
    ).not.toThrow();
    expect(tryOne({ file: 'src/\nfoo.ts' })).toThrow(/control characters/);
    expect(tryOne({ shortSummary: 'one\ntwo' })).toThrow(/control characters/);
  });

  it('refuses schema violations: missing failureScenario, bad enums, over-long lists', () => {
    expect(
      tryBuild({
        severity: 'Critical',
        file: 'a.ts',
        summary: 's',
      } as ReportFindingsFindingParams),
    ).toThrow();
    expect(tryOne({ severity: 'blocker' as 'Critical' })).toThrow();
    expect(() =>
      new ReportFindingsTool().build({
        level: 'ultra' as 'high',
        findings: [finding()],
      }),
    ).toThrow();
    expect(
      tryBuild(
        ...Array.from({ length: REPORT_FINDINGS_MAX + 1 }, (_, i) =>
          finding({ file: `src/f${i}.ts` }),
        ),
      ),
    ).toThrow();
  });

  it('refuses blank required fields after trimming', () => {
    expect(tryOne({ file: '   ' })).toThrow(/"file" must not be empty/);
    expect(tryOne({ summary: '  ' })).toThrow(/"summary" must not be empty/);
    expect(tryOne({ failureScenario: ' ' })).toThrow(
      /"failureScenario" must not be empty/,
    );
  });

  it('trims fields and drops empty optionals in the display', async () => {
    const result = await run(
      finding({
        id: '  ',
        file: ' src/foo.ts ',
        summary: ' padded summary ',
        category: '',
      }),
    );
    const [item] = displayOf(result).findings;
    expect(item.id).toBeUndefined();
    expect(item.file).toBe('src/foo.ts');
    expect(item.summary).toBe('padded summary');
    expect(item.category).toBeUndefined();
  });

  it('passes id and line through to the display item', async () => {
    const result = await run(finding({ id: 'R2-7', line: 314 }));
    const [item] = displayOf(result).findings;
    expect(item.id).toBe('R2-7');
    expect(item.line).toBe(314);
  });

  it('accepts file paths the artifact preserves and refuses beyond the path domain', async () => {
    // The artifact keeps repo-relative paths to the filesystem limit; a
    // 513-character path it preserves must not refuse the whole in-band list.
    const file = `src/${'a'.repeat(506)}.ts`;
    expect(file).toHaveLength(513);
    const result = await run(finding({ file }));
    expect(displayOf(result).findings[0].file).toBe(file);
    const max = REPORT_FINDINGS_FILE_MAX;
    expect(tryOne({ file: 'a'.repeat(max) })).not.toThrow();
    expect(tryOne({ file: 'a'.repeat(max + 1) })).toThrow();
  });

  it('accepts MAX_SAFE_INTEGER line numbers and refuses unsafe ones', async () => {
    const result = await run(finding({ line: Number.MAX_SAFE_INTEGER }));
    expect(displayOf(result).findings[0].line).toBe(Number.MAX_SAFE_INTEGER);
    // MAX_SAFE_INTEGER + 1 is representable — JSON keeps it, and the
    // rounding that produced it is invisible — so the schema alone cannot
    // catch it.
    expect(tryOne({ line: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe range/);
  });

  it('requires a non-empty outcomeNote for every skipped outcome', () => {
    expect(tryOne({ outcome: 'skipped' })).toThrow(/"outcomeNote" is required/);
    expect(tryOne({ outcome: 'skipped', outcomeNote: '   ' })).toThrow(
      /"outcomeNote" is required/,
    );
    expect(
      tryOne({ outcome: 'skipped', outcomeNote: 'needs a product call' }),
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
    await exec(tool, ...nine);

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
    const result = await exec(tool, ...full);
    expect(displayOf(result).findings).toHaveLength(9);

    // A fresh report without outcomes replaces the active identity.
    await exec(tool, finding({ id: 'R2-1', file: 'src/new.ts' }));
    await exec(
      tool,
      finding({ id: 'R2-1', file: 'src/new.ts', outcome: 'no_change_needed' }),
    );
  });

  it('does not hold an outcome call to a report that had no identity', async () => {
    // A low-effort pass reports without artifact ids, so there is no id set
    // a later outcome call could be joined against; an empty report
    // establishes no identity either.
    const tool = new ReportFindingsTool();
    await exec(tool, finding());
    await exec(tool, finding({ outcome: 'fixed' }));
    await exec(tool);
    await exec(tool, finding({ outcome: 'fixed' }));
  });

  it('does not commit the identity at build: an undelivered report blocks nothing', async () => {
    // The scheduler builds every invocation of a batch up front and can
    // discard one before it executes (pre-validation cancellation, an
    // aborted signal). Identity committed at build time would make the
    // never-delivered round-2 report the active one, rejecting a
    // legitimate outcome call for the round-1 report the client shows.
    const tool = new ReportFindingsTool();
    await exec(tool, finding({ id: 'R1-1' }));
    // Built but never executed — a cancelled turn's dropped call.
    tool.build({ findings: [finding({ id: 'R2-1', file: 'src/new.ts' })] });

    const outcome = await exec(tool, finding({ id: 'R1-1', outcome: 'fixed' }));
    expect(displayOf(outcome).findings[0].outcome).toBe('fixed');
  });

  it('clears the identity when a later report has none', async () => {
    // The removal transition: an id-less re-report (a low-effort pass)
    // replaces the active identity with none, so a following outcome call
    // is accepted on its own terms instead of being held to the old ids.
    const tool = new ReportFindingsTool();
    await exec(tool, finding({ id: 'R1-1' }));
    await exec(tool, finding({ file: 'src/new.ts' }));

    const result = await exec(tool, finding({ id: 'R9-9', outcome: 'fixed' }));
    expect(displayOf(result).findings).toHaveLength(1);
  });

  it('documents the cold-resume limit: a fresh instance has no active identity', async () => {
    // The identity gate is a live-process contract. A cold session resume
    // (--resume, a restart) constructs a fresh tool instance that never saw
    // the pre-restart report, so an outcome call is validated on its own
    // terms — all-or-nothing outcomes — instead of against the old list.
    // The same subset the original instance rejects is accepted here.
    const original = new ReportFindingsTool();
    await exec(
      original,
      finding({ id: 'R1-1' }),
      finding({ id: 'R1-2', file: 'src/bar.ts' }),
      finding({ id: 'R1-3', file: 'src/baz.ts' }),
    );
    const subset = finding({ id: 'R1-1', outcome: 'fixed' });
    expect(() => original.build({ findings: [subset] })).toThrow(
      /drops 2 finding\(s\) from the active report/,
    );

    const result = await exec(new ReportFindingsTool(), subset);
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

describe('the finding axes (#10291)', () => {
  it('passes direction and baseline through to the display, and omits them when absent', async () => {
    const display = displayOf(
      await run(
        finding({ direction: 'fails-closed', baseline: 'new-surface' }),
        finding({ file: 'src/bar.ts' }),
      ),
    );
    // Located by file: the display is sorted, and `src/bar.ts` sorts first.
    const foo = display.findings.find((f) => f.file === 'src/foo.ts')!;
    const bar = display.findings.find((f) => f.file === 'src/bar.ts')!;
    expect(foo).toMatchObject({
      direction: 'fails-closed',
      baseline: 'new-surface',
    });
    expect(bar.direction).toBeUndefined();
    expect(bar.baseline).toBeUndefined();
  });

  it('refuses an axis outside its list', () => {
    expect(tryOne({ direction: 'fails-open' as 'fails-closed' })).toThrow();
    expect(tryOne({ baseline: 'old-surface' as 'regression' })).toThrow();
  });
});
