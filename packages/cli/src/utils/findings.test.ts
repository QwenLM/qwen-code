/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyOutcomes,
  buildReport,
  compressSummary,
  CONFIDENCES,
  findingsCommand,
  OUTCOMES,
  renderFindings,
  SEVERITIES,
  sortFindings,
  SOURCES,
  validateFindings,
  validateOutcomes,
  type Finding,
  type FindingsReport,
  holdCriticalsFailingOnBase,
  sharedFailingFilesOf,
} from './findings.js';

/** A minimal valid finding, spread-and-overridden per case. */
const base = {
  id: 'f1',
  severity: 'Critical',
  summary: 'The retry counter is never reset, so the third attempt is refused.',
  failureScenario:
    'A request that fails twice then succeeds leaves `attempts` at 2; the next unrelated request starts at 2 and is rejected after one failure.',
  file: 'src/retry.ts',
  line: 42,
};

describe('review vocabulary contract', () => {
  // The Web Shell renderer
  // (packages/web-shell/client/components/artifacts/CodeReviewArtifactDetail.tsx)
  // keeps its own copies of these four lists and fails closed on any value it
  // does not know. This snapshot makes a CLI-side addition turn red HERE —
  // next to the pointer to the renderer copy — instead of surfacing later as
  // saved artifacts that silently stop rendering.
  it('matches the copies the Web Shell renderer duplicates', () => {
    expect([...SEVERITIES]).toEqual(['Critical', 'Suggestion', 'Nice to have']);
    expect([...CONFIDENCES]).toEqual(['high', 'low']);
    expect([...SOURCES]).toEqual(['review', 'build', 'test', 'probe', 'lint']);
    expect([...OUTCOMES]).toEqual(['fixed', 'skipped', 'no_change_needed']);
  });
});

describe('validateFindings', () => {
  it('accepts the minimal shape and defaults confidence and source', () => {
    const [f] = validateFindings([base]);
    expect(f.confidence).toBe('high');
    expect(f.source).toBe('review');
    expect(f.locations).toEqual([{ file: 'src/retry.ts', line: 42 }]);
  });

  it('defaults confidence to high, not low', () => {
    // Defaulting the other way would sweep every finding into the terminal-only
    // bucket, silently emptying the posted review — a review that reports
    // nothing publicly while believing it reported everything.
    const [f] = validateFindings([{ ...base, confidence: undefined }]);
    expect(f.confidence).toBe('high');
  });

  it('accepts snake_case for the fields the prose format spells with a space', () => {
    const [f] = validateFindings([
      {
        ...base,
        failureScenario: undefined,
        failure_scenario: base.failureScenario,
        short_summary: 'Retry counter never reset',
        suggested_fix: 'Reset `attempts` in the `finally`.',
      },
    ]);
    expect(f.failureScenario).toBe(base.failureScenario);
    expect(f.shortSummary).toBe('Retry counter never reset');
    expect(f.suggestedFix).toBe('Reset `attempts` in the `finally`.');
  });

  it('rejects a finding with no failure scenario', () => {
    // The finding format's own gate: a finding that cannot name its trigger and
    // wrong outcome is not a finding, so this is a malformed entry rather than a
    // finding with an empty field.
    expect(() =>
      validateFindings([{ ...base, failureScenario: undefined }]),
    ).toThrow(/failureScenario/);
  });

  it.each([
    ['id', { id: '' }],
    ['summary', { summary: '   ' }],
    ['file', { file: undefined }],
  ])('rejects a finding missing %s', (_name, patch) => {
    expect(() => validateFindings([{ ...base, ...patch }])).toThrow(
      /Finding at index 0/,
    );
  });

  it('names the index and the field, and does not throw a TypeError on null', () => {
    expect(() => validateFindings([base, null])).toThrow(
      /Finding at index 1: is null, not an object/,
    );
  });

  it('rejects an unknown severity, listing the ladder', () => {
    expect(() => validateFindings([{ ...base, severity: 'Blocker' }])).toThrow(
      /"Critical", "Suggestion", "Nice to have"/,
    );
  });

  it('rejects a duplicate id — ids are what outcomes and anchors join on', () => {
    expect(() =>
      validateFindings([base, { ...base, file: 'src/other.ts' }]),
    ).toThrow(/Duplicate finding id "f1"/);
  });

  it('keeps every location of a pattern aggregate', () => {
    // Step 7 expands an aggregate into one comment per location, so an anchor
    // dropped here is a comment that never gets posted — and an anchorless entry
    // handed to `resolve-anchors` throws on the whole batch.
    const [f] = validateFindings([
      {
        ...base,
        file: undefined,
        locations: [
          { file: 'a.ts', line: 1, anchor: 'const a = 1' },
          { file: 'b.ts', line: 2, anchor: 'const b = 2' },
          { file: 'c.ts', line: 3, anchor: 'const c = 3' },
        ],
      },
    ]);
    expect(f.locations).toHaveLength(3);
    expect(f.locations[2]).toEqual({
      file: 'c.ts',
      line: 3,
      anchor: 'const c = 3',
    });
  });

  it('rejects an empty locations array rather than treating it as standalone', () => {
    expect(() =>
      validateFindings([{ ...base, file: undefined, locations: [] }]),
    ).toThrow(/non-empty array/);
  });

  it.each(['42', -1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid line value %s',
    (line) => {
      expect(() => validateFindings([{ ...base, line }])).toThrow(
        /invalid "line"/,
      );
    },
  );

  it('rejects invalid aggregate location lines', () => {
    expect(() =>
      validateFindings([
        {
          ...base,
          file: undefined,
          locations: [{ file: 'a.ts', line: 0 }],
        },
      ]),
    ).toThrow(/location 0 has an invalid "line"/);
  });

  it('rejects a top-level input that is not an array', () => {
    expect(() => validateFindings({ findings: [] })).toThrow(
      /must be a JSON array/,
    );
  });
});

describe('validateFindings — evidence assets', () => {
  it('accepts assetFiles and assets and round-trips both', () => {
    const [f] = validateFindings([
      {
        ...base,
        assetFiles: ['shots/before.png'],
        assets: ['https://github.com/o/r/raw/sha/8346-review/x-before.png'],
      },
    ]);
    expect(f.assetFiles).toEqual(['shots/before.png']);
    expect(f.assets).toEqual([
      'https://github.com/o/r/raw/sha/8346-review/x-before.png',
    ]);
  });

  it('accepts the asset_files snake_case alias like its sibling aliases', () => {
    // failure_scenario/short_summary/suggested_fix all have a snake_case test;
    // an untested member of an otherwise-tested family is the alias a refactor
    // deletes without noticing.
    const [f] = validateFindings([{ ...base, asset_files: ['shots/x.png'] }]);
    expect(f.assetFiles).toEqual(['shots/x.png']);
  });

  it('rejects a non-array assetFiles, naming the finding and the field', () => {
    expect(() =>
      validateFindings([{ ...base, assetFiles: 'shot.png' }]),
    ).toThrow(/Finding at index 0: "assetFiles" must be an array/);
  });

  it('rejects an empty-string entry rather than publishing a nameless file', () => {
    expect(() => validateFindings([{ ...base, assets: ['ok', ''] }])).toThrow(
      /"assets" must be an array of non-empty strings/,
    );
  });

  it('rejects a whitespace-only entry, matching the sibling asString rule', () => {
    expect(() => validateFindings([{ ...base, assetFiles: ['  '] }])).toThrow(
      /"assetFiles" must be an array of non-empty strings/,
    );
  });

  it('treats a null assets field as absent, like every sibling parser', () => {
    const [f] = validateFindings([{ ...base, assetFiles: null, assets: null }]);
    expect(f.assetFiles).toBeUndefined();
    expect(f.assets).toBeUndefined();
  });

  it('drops an empty array instead of carrying a vacuous field', () => {
    const [f] = validateFindings([{ ...base, assetFiles: [] }]);
    expect(f.assetFiles).toBeUndefined();
  });
});

describe('compressSummary', () => {
  it('passes a short summary through unchanged', () => {
    expect(compressSummary('Retry counter never reset')).toBe(
      'Retry counter never reset',
    );
  });

  it('flattens whitespace so a wrapped summary fits one list cell', () => {
    expect(compressSummary('Retry\n  counter   never reset')).toBe(
      'Retry counter never reset',
    );
  });

  it('cuts on a word boundary and stays within the limit', () => {
    const long =
      'The retry counter is never reset, so a later unrelated request is refused after a single failure';
    const short = compressSummary(long);
    expect(short.length).toBeLessThanOrEqual(60);
    expect(short.endsWith('…')).toBe(true);
    expect(short).not.toMatch(/\s…$/);
  });

  it('does not leave a stub when the only word boundary is near the start', () => {
    // A 60-character single token has no usable boundary; cutting at the first
    // space (character 3) would produce a two-letter label.
    const short = compressSummary(`an ${'x'.repeat(80)}`);
    expect(short.length).toBeLessThanOrEqual(60);
    expect(short.length).toBeGreaterThan(50);
  });
});

describe('sortFindings', () => {
  it('orders by severity, then confidence, then file, then line, then id', () => {
    const mk = (o: Partial<Finding> & { id: string }): Finding =>
      ({
        severity: 'Suggestion',
        confidence: 'high',
        source: 'review',
        summary: 's',
        shortSummary: 's',
        failureScenario: 'f',
        locations: [{ file: 'z.ts', line: 1 }],
        ...o,
      }) as Finding;

    const sorted = sortFindings([
      mk({ id: 'nice', severity: 'Nice to have' }),
      mk({ id: 'sug-low', confidence: 'low' }),
      mk({ id: 'crit', severity: 'Critical' }),
      mk({ id: 'sug-a', locations: [{ file: 'a.ts', line: 9 }] }),
      mk({ id: 'sug-a-early', locations: [{ file: 'a.ts', line: 2 }] }),
    ]);
    expect(sorted.map((f) => f.id)).toEqual([
      'crit',
      'sug-a-early',
      'sug-a',
      'sug-low',
      'nice',
    ]);
  });

  it('is total — two findings on one line keep a stable order', () => {
    const mk = (id: string): Finding =>
      ({
        id,
        severity: 'Critical',
        confidence: 'high',
        source: 'review',
        summary: 's',
        shortSummary: 's',
        failureScenario: 'f',
        locations: [{ file: 'a.ts', line: 1 }],
      }) as Finding;
    expect(sortFindings([mk('b'), mk('a')]).map((f) => f.id)).toEqual([
      'a',
      'b',
    ]);
    expect(sortFindings([mk('a'), mk('b')]).map((f) => f.id)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('applyOutcomes — the ledger must account for every finding', () => {
  const findings = validateFindings([
    base,
    { ...base, id: 'f2', severity: 'Suggestion' },
    { ...base, id: 'f3', severity: 'Nice to have' },
  ]);

  it('merges a complete ledger', () => {
    const merged = applyOutcomes(findings, [
      { id: 'f1', outcome: 'fixed' },
      { id: 'f2', outcome: 'skipped', note: 'would change intended behaviour' },
      { id: 'f3', outcome: 'no_change_needed' },
    ]);
    expect(merged.map((f) => f.outcome)).toEqual([
      'fixed',
      'skipped',
      'no_change_needed',
    ]);
    expect(merged[1].outcomeNote).toBe('would change intended behaviour');
  });

  it('refuses a ledger that leaves a finding unaccounted for', () => {
    // The failure this exists for: a fixer that applies two of three findings
    // and reports two has not lied about either — it has silently shortened the
    // list, and the reader cannot see the one that fell off.
    expect(() =>
      applyOutcomes(findings, [
        { id: 'f1', outcome: 'fixed' },
        { id: 'f2', outcome: 'fixed' },
      ]),
    ).toThrow(/No outcome recorded for 1 finding\(s\): "f3"/);
  });

  it('names every unaccounted finding, not just the first', () => {
    expect(() =>
      applyOutcomes(findings, [{ id: 'f1', outcome: 'fixed' }]),
    ).toThrow(/"f2", "f3"/);
  });

  it('refuses an outcome for a finding this review never made', () => {
    expect(() =>
      applyOutcomes(findings, [
        { id: 'f1', outcome: 'fixed' },
        { id: 'f2', outcome: 'fixed' },
        { id: 'f3', outcome: 'fixed' },
        { id: 'ghost', outcome: 'fixed' },
      ]),
    ).toThrow(/unknown finding id\(s\): "ghost"/);
  });

  it('refuses two outcomes for one finding', () => {
    expect(() =>
      applyOutcomes(findings, [
        { id: 'f1', outcome: 'fixed' },
        { id: 'f1', outcome: 'skipped' },
        { id: 'f2', outcome: 'fixed' },
        { id: 'f3', outcome: 'fixed' },
      ]),
    ).toThrow(/appears twice/);
  });
});

describe('validateOutcomes', () => {
  it('rejects an outcome word outside the ladder', () => {
    // `wontfix` reads like `skipped` and means something the reader would act on
    // differently; the three words are three different claims about the code.
    expect(() => validateOutcomes([{ id: 'f1', outcome: 'wontfix' }])).toThrow(
      /"fixed", "skipped", "no_change_needed"/,
    );
  });

  it('rejects an entry with no id', () => {
    expect(() => validateOutcomes([{ outcome: 'fixed' }])).toThrow(
      /index 0 is missing a string "id"/,
    );
  });
});

describe('buildReport', () => {
  it('counts by severity and confidence and reports no outcomes yet', () => {
    const report = buildReport(
      validateFindings([
        base,
        { ...base, id: 'f2', severity: 'Suggestion', confidence: 'low' },
      ]),
    );
    expect(report.counts.total).toBe(2);
    expect(report.counts.bySeverity).toEqual({
      Critical: 1,
      Suggestion: 1,
      'Nice to have': 0,
    });
    expect(report.counts.byConfidence).toEqual({ high: 1, low: 1 });
    expect(report.outcomesRecorded).toBe(false);
    expect(report.counts.byOutcome).toBeUndefined();
  });

  it('reports outcomes only once every finding carries one', () => {
    const findings = validateFindings([base, { ...base, id: 'f2' }]);
    const half = [{ ...findings[0], outcome: 'fixed' as const }, findings[1]];
    expect(buildReport(half).outcomesRecorded).toBe(false);
    expect(buildReport(half).counts.byOutcome).toBeUndefined();

    const full = applyOutcomes(findings, [
      { id: 'f1', outcome: 'fixed' },
      { id: 'f2', outcome: 'skipped' },
    ]);
    const report = buildReport(full);
    expect(report.outcomesRecorded).toBe(true);
    expect(report.counts.byOutcome).toEqual({
      fixed: 1,
      skipped: 1,
      no_change_needed: 0,
    });
  });

  it('an empty review has not "recorded outcomes"', () => {
    // Vacuous truth would make a zero-finding review report `outcomesRecorded:
    // true`, which reads as "the fixer ran and accounted for everything" on a
    // run where it never ran at all.
    expect(buildReport([]).outcomesRecorded).toBe(false);
  });
});

describe('renderFindings', () => {
  it('marks low confidence and outcome, and counts extra locations', () => {
    const report = buildReport(
      applyOutcomes(
        validateFindings([
          {
            ...base,
            confidence: 'low',
            locations: [
              { file: 'a.ts', line: 1 },
              { file: 'b.ts', line: 2 },
            ],
            file: undefined,
          },
        ]),
        [{ id: 'f1', outcome: 'skipped' }],
      ),
    );
    expect(renderFindings(report)[0]).toBe(
      'Critical — a.ts:1 (+1 more) — The retry counter is never reset, so the third attempt is… [low confidence] [skipped]',
    );
    expect(report.findings[0].shortSummary.length).toBeLessThanOrEqual(60);
  });
});

// The exported functions are unit-tested above, and none of them reaches the
// review unless this command's file boundary holds: reading two JSON inputs,
// writing the artifact, and — the part that matters — turning an incomplete
// ledger into a non-zero exit rather than a quietly shortened list.
describe('findings (command boundary)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'review-findings-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(findings: unknown, outcomes?: unknown): FindingsReport {
    const input = join(dir, 'in.json');
    const out = join(dir, 'nested/deeper/findings.json');
    writeFileSync(input, JSON.stringify(findings));
    let outcomesPath: string | undefined;
    if (outcomes !== undefined) {
      outcomesPath = join(dir, 'outcomes.json');
      writeFileSync(outcomesPath, JSON.stringify(outcomes));
    }
    (findingsCommand.handler as (a: unknown) => void)({
      input,
      out,
      outcomes: outcomesPath,
      print: false,
    });
    return JSON.parse(readFileSync(out, 'utf8')) as FindingsReport;
  }

  /** Run the handler and return everything it wrote to stderr. */
  function runCapturingStderr(argv: Record<string, unknown>): string {
    let out = '';
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        out +=
          typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
        return true;
      });
    try {
      (findingsCommand.handler as (a: unknown) => void)(argv);
    } finally {
      spy.mockRestore();
    }
    return out;
  }

  it('announces every hold, naming the finding and the measured file', () => {
    // A severity this command lowered is a change to what the review says. Left
    // unannounced it reads as the reviewer's own judgement, which is the one
    // thing the measurement is not.
    const input = join(dir, 'in.json');
    const out = join(dir, 'findings.json');
    const delta = join(dir, 'test-delta.json');
    writeFileSync(
      input,
      JSON.stringify([
        {
          ...base,
          id: 'R1-3',
          severity: 'Critical',
          failureScenario:
            'packages/cli/src/ui/auth/AuthDialog.test.tsx goes red on this change.',
        },
      ]),
    );
    writeFileSync(
      delta,
      JSON.stringify({
        entries: [
          {
            command: 'npm test --workspace="packages/cli"',
            netNew: [],
            shared: ['src/ui/auth/AuthDialog.test.tsx'],
          },
        ],
      }),
    );
    const stderr = runCapturingStderr({
      input,
      out,
      testDelta: delta,
      print: false,
    });
    expect(stderr).toContain('R1-3');
    expect(stderr).toContain('packages/cli/src/ui/auth/AuthDialog.test.tsx');
    expect(stderr).toContain('held back from Critical');
  });

  it('says nothing about holds or unreadable measurements without the flag', () => {
    // Distinguishes "the guard did not run" from "the guard ran and its read
    // failed": both leave severities untouched, and only stderr tells them
    // apart.
    const input = join(dir, 'in.json');
    writeFileSync(input, JSON.stringify([{ ...base, severity: 'Critical' }]));
    const stderr = runCapturingStderr({
      input,
      out: join(dir, 'findings.json'),
      print: false,
    });
    expect(stderr).not.toContain('held back');
    expect(stderr).not.toContain('no holds applied');
  });

  it('holds a Critical back when --test-delta measured its test as failing on base', () => {
    // Through the handler, not the helper: the option has to be parsed, the
    // artifact read, and the held finding written into the report. The
    // test-delta shape here is the one the command emits — a top-level
    // `shared` beside per-command entries.
    const input = join(dir, 'in.json');
    const out = join(dir, 'findings.json');
    const delta = join(dir, 'test-delta.json');
    writeFileSync(
      input,
      JSON.stringify([
        {
          ...base,
          severity: 'Critical',
          failureScenario:
            'packages/cli/src/ui/auth/AuthDialog.test.tsx goes red on this change.',
        },
      ]),
    );
    writeFileSync(
      delta,
      JSON.stringify({
        entries: [
          {
            command: 'npm test --workspace="packages/cli"',
            netNew: [],
            shared: ['src/ui/auth/AuthDialog.test.tsx'],
          },
        ],
        netNew: [],
        shared: ['src/ui/auth/AuthDialog.test.tsx'],
      }),
    );
    (findingsCommand.handler as (a: unknown) => void)({
      input,
      out,
      testDelta: delta,
      print: false,
    });
    const report = JSON.parse(readFileSync(out, 'utf8')) as FindingsReport;
    expect(report.findings[0].severity).toBe('Suggestion');
    expect(report.counts.bySeverity['Critical']).toBe(0);
    expect(report.findings[0].failureScenario).toContain('failed there too');
  });

  it.each([
    ['a path that does not exist', undefined],
    ['a file that is not valid JSON', '{ "shared": ['],
  ])('still writes the findings when --test-delta is %s', (_name, contents) => {
    // Through the command, because that is where the guarantee lives: the
    // helper tolerates a wrong SHAPE, but the read itself throws on these
    // two, and a cross-check that cannot read its input must not take the
    // findings down with it.
    const input = join(dir, 'in.json');
    const out = join(dir, 'findings.json');
    const delta = join(dir, 'missing/test-delta.json');
    if (contents !== undefined) {
      writeFileSync(join(dir, 'bad.json'), contents);
    }
    writeFileSync(input, JSON.stringify([{ ...base, severity: 'Critical' }]));
    expect(() =>
      (findingsCommand.handler as (a: unknown) => void)({
        input,
        out,
        testDelta: contents === undefined ? delta : join(dir, 'bad.json'),
        print: false,
      }),
    ).not.toThrow();
    const report = JSON.parse(readFileSync(out, 'utf8')) as FindingsReport;
    expect(report.counts.total).toBe(1);
    // Unheld: an absent measurement contradicts nothing.
    expect(report.findings[0].severity).toBe('Critical');
  });

  it('says nothing when the measurement file simply is not there', () => {
    // test-delta only runs when a test command failed AND a base tree built,
    // so on the ordinary review the artifact does not exist. The SKILL passes
    // the flag unconditionally, and a loud line here would report the normal
    // path as a failure on every green run.
    const input = join(dir, 'in.json');
    writeFileSync(input, JSON.stringify([{ ...base, severity: 'Critical' }]));
    const stderr = runCapturingStderr({
      input,
      out: join(dir, 'findings.json'),
      testDelta: join(dir, 'never-written.json'),
      print: false,
    });
    expect(stderr).not.toContain('no holds applied');
    expect(stderr).not.toContain('ENOENT');
  });

  it('still speaks up for a measurement that exists and will not parse', () => {
    const input = join(dir, 'in.json');
    const delta = join(dir, 'broken.json');
    writeFileSync(input, JSON.stringify([{ ...base, severity: 'Critical' }]));
    writeFileSync(delta, '{ "shared": [');
    const stderr = runCapturingStderr({
      input,
      out: join(dir, 'findings.json'),
      testDelta: delta,
      print: false,
    });
    expect(stderr).toContain('no holds applied');
  });

  it('counts the holds and reaches the same severity with and without outcomes', () => {
    const input = join(dir, 'in.json');
    const delta = join(dir, 'test-delta.json');
    writeFileSync(
      input,
      JSON.stringify([
        {
          ...base,
          id: 'R1-1',
          severity: 'Critical',
          failureScenario:
            'packages/cli/src/ui/auth/AuthDialog.test.tsx goes red on this change.',
        },
      ]),
    );
    writeFileSync(
      delta,
      JSON.stringify({
        entries: [
          {
            command: 'npm test --workspace="packages/cli"',
            netNew: [],
            shared: ['src/ui/auth/AuthDialog.test.tsx'],
          },
        ],
      }),
    );
    const outcomes = join(dir, 'outcomes.json');
    writeFileSync(outcomes, JSON.stringify([{ id: 'R1-1', outcome: 'fixed' }]));

    const first = join(dir, 'a.json');
    (findingsCommand.handler as (a: unknown) => void)({
      input,
      out: first,
      testDelta: delta,
      print: false,
    });
    const second = join(dir, 'b.json');
    (findingsCommand.handler as (a: unknown) => void)({
      input,
      out: second,
      outcomes,
      testDelta: delta,
      print: false,
    });
    const a = JSON.parse(readFileSync(first, 'utf8')) as FindingsReport;
    const b = JSON.parse(readFileSync(second, 'utf8')) as FindingsReport;
    expect(a.counts.held).toBe(1);
    expect(b.counts.held).toBe(1);
    // The whole point: one input, one measurement, one answer.
    expect(b.findings[0].severity).toBe(a.findings[0].severity);
    expect(b.findings[0].heldByMeasurement).toEqual(
      a.findings[0].heldByMeasurement,
    );
  });

  it('leaves severities alone when --test-delta is not passed', () => {
    const report = run([{ ...base, severity: 'Critical' }]);
    expect(report.findings[0].severity).toBe('Critical');
    expect(report.counts.bySeverity['Critical']).toBe(1);
  });

  it('writes the artifact, creating intermediate directories', () => {
    const report = run([base]);
    expect(report.counts.total).toBe(1);
    expect(report.findings[0].id).toBe('f1');
    expect(report.outcomesRecorded).toBe(false);
  });

  it('merges a complete ledger and records the outcome counts', () => {
    const report = run(
      [base, { ...base, id: 'f2', severity: 'Suggestion' }],
      [
        { id: 'f1', outcome: 'fixed' },
        { id: 'f2', outcome: 'skipped', note: 'outside the reviewed diff' },
      ],
    );
    expect(report.outcomesRecorded).toBe(true);
    expect(report.counts.byOutcome).toEqual({
      fixed: 1,
      skipped: 1,
      no_change_needed: 0,
    });
    expect(report.findings[1].outcomeNote).toBe('outside the reviewed diff');
  });

  it('throws rather than writing an artifact for an incomplete ledger', () => {
    expect(() =>
      run([base, { ...base, id: 'f2' }], [{ id: 'f1', outcome: 'fixed' }]),
    ).toThrow(/No outcome recorded for 1 finding\(s\)/);
  });

  it('names the file when the input is unreadable', () => {
    expect(() =>
      (findingsCommand.handler as (a: unknown) => void)({
        input: join(dir, 'absent.json'),
        out: join(dir, 'out.json'),
        outcomes: undefined,
        print: false,
      }),
    ).toThrow(/Could not read the findings file/);
  });

  it('names the file when the input is not JSON', () => {
    const input = join(dir, 'in.json');
    writeFileSync(input, 'not json at all');
    expect(() =>
      (findingsCommand.handler as (a: unknown) => void)({
        input,
        out: join(dir, 'out.json'),
        outcomes: undefined,
        print: false,
      }),
    ).toThrow(/is not valid JSON/);
  });
});

describe('holdCriticalsFailingOnBase', () => {
  // The shape test-delta writes: workspace-relative paths, while a finding
  // names the repo-relative one.
  // Repo-relative, which is what `sharedFailingFilesOf` hands the helper: it
  // qualifies each entry's paths from that entry's `--workspace=`.
  const shared = ['packages/cli/src/ui/auth/AuthDialog.test.tsx'];
  const critical = {
    id: 'f1',
    severity: 'Critical' as const,
    confidence: 'high' as const,
    source: 'review' as const,
    summary: 'Height-based pagination breaks AuthDialog.test.tsx',
    shortSummary: 'pagination breaks a test',
    failureScenario:
      "packages/cli/src/ui/auth/AuthDialog.test.tsx > 'drives API key provider steps' expects MiniMax visible without scrolling.",
    locations: [{ file: 'packages/cli/src/ui/auth/AuthDialog.tsx', line: 132 }],
  };

  it('holds a Critical that blames the PR for a test the base also fails', () => {
    const { findings, held } = holdCriticalsFailingOnBase([critical], shared);
    expect(findings[0].severity).toBe('Suggestion');
    expect(findings[0].failureScenario).toContain('failed there too');
    // The original scenario survives — the measurement is added to the
    // evidence, it does not replace it.
    expect(findings[0].failureScenario).toContain('expects MiniMax visible');
    expect(held).toEqual([
      { id: 'f1', file: 'packages/cli/src/ui/auth/AuthDialog.test.tsx' },
    ]);
  });

  it('leaves a Critical alone when the test it names is not shared', () => {
    const { findings, held } = holdCriticalsFailingOnBase(
      [critical],
      ['packages/cli/src/other/unrelated.test.ts'],
    );
    expect(findings[0].severity).toBe('Critical');
    expect(findings[0].failureScenario).toBe(critical.failureScenario);
    expect(held).toEqual([]);
  });

  it('holds the same finding whether or not the fixer already applied it', () => {
    // The SKILL runs this command twice over one input, the second time with
    // --outcomes. An exemption for `fixed` made run 2 answer Critical where
    // run 1 answered Suggestion — the same finding at two severities inside
    // one review, which this file's header names as the failure it exists to
    // prevent. The two statements are about different things: the measurement
    // says the base was already red, the outcome says the tree was edited.
    const plain = holdCriticalsFailingOnBase([critical], shared);
    const fixed = holdCriticalsFailingOnBase(
      [{ ...critical, outcome: 'fixed' as const }],
      shared,
    );
    expect(fixed.findings[0].severity).toBe(plain.findings[0].severity);
    expect(fixed.held).toEqual(plain.held);
  });

  it('leaves a re-filed Critical alone once it already carries the measurement', () => {
    // The escape the report offers — "say which test fails for a NEW reason" —
    // names the test file, which IS the match condition, so re-applying the
    // measurement would make the promised door unopenable. The ledger carries a
    // held finding forward as the Suggestion it became, so Critical plus the
    // marker is a deliberate act by someone who read it.
    const once = holdCriticalsFailingOnBase([critical], shared).findings[0];
    expect(once.severity).toBe('Suggestion');

    const again = holdCriticalsFailingOnBase(
      [{ ...once, severity: 'Critical' as const }],
      shared,
    );
    expect(again.findings[0].severity).toBe('Critical');
    expect(again.held).toEqual([]);
    expect(again.readjudicated).toEqual([
      { id: 'f1', file: 'packages/cli/src/ui/auth/AuthDialog.test.tsx' },
    ]);
    // ...and the explanation is not written twice.
    const count = (t: string) =>
      (t.match(/Held back from Critical by measurement:/g) ?? []).length;
    expect(count(again.findings[0].failureScenario)).toBe(1);
  });

  it('records the hold as a field, not only as prose', () => {
    // A later round reads the artifact. A hold discoverable only by
    // substring-matching the scenario is a hold the round ledger cannot see.
    const { findings } = holdCriticalsFailingOnBase([critical], shared);
    expect(findings[0].heldByMeasurement).toEqual({
      file: 'packages/cli/src/ui/auth/AuthDialog.test.tsx',
    });
  });

  it('does not demote a finding whose subject IS the already-red test', () => {
    // "this new assertion checks the wrong thing" names the test file as its
    // location, and a PR touching an already-red test is exactly when such a
    // finding gets written. The measurement says nothing about that claim.
    const { findings } = holdCriticalsFailingOnBase(
      [
        {
          ...critical,
          summary: 'The new assertion asserts the wrong property',
          failureScenario:
            'It asserts `visible` where the contract is `enabled`, so a regression that flips enabled ships green.',
          locations: [
            {
              file: 'packages/cli/src/ui/auth/AuthDialog.test.tsx',
              line: 40,
            },
          ],
        },
      ],
      shared,
    );
    expect(findings[0].severity).toBe('Critical');
  });

  it('does not match on suggestedFix, where a test file is proposed work', () => {
    // "add a case in src/…test.tsx" is not a claim that the file is red.
    const { findings } = holdCriticalsFailingOnBase(
      [
        {
          ...critical,
          summary: 'The retry counter is never reset',
          failureScenario: 'Two failures then a success leaves attempts at 2.',
          locations: [{ file: 'packages/cli/src/retry.ts' }],
          suggestedFix:
            'Add a case in packages/cli/src/ui/auth/AuthDialog.test.tsx covering the guard.',
        },
      ],
      shared,
    );
    expect(findings[0].severity).toBe('Critical');
  });

  it('never touches a finding that is not Critical', () => {
    const { findings, held } = holdCriticalsFailingOnBase(
      [{ ...critical, severity: 'Suggestion' as const }],
      shared,
    );
    expect(findings[0].severity).toBe('Suggestion');
    expect(findings[0].failureScenario).toBe(critical.failureScenario);
    expect(held).toEqual([]);
  });

  it('does not match a nested copy of the same tree', () => {
    // `/` is not a leading boundary. The probe reaches here repo-relative, so
    // anything in front of it means the match sits under another root: a
    // vendored copy is not this file, and demoting a Critical about the real
    // one on that basis is the cross-tree collapse in miniature.
    const { findings, held } = holdCriticalsFailingOnBase(
      [
        {
          ...critical,
          summary: 'the assertion is wrong',
          failureScenario:
            'third_party/packages/cli/src/ui/auth/AuthDialog.test.tsx is red',
        },
      ],
      shared,
    );
    expect(findings[0].severity).toBe('Critical');
    expect(held).toEqual([]);
  });

  it('matches a path that ends a sentence', () => {
    // Findings are prose. Treating the full stop as part of the name would
    // silently stop matching the ordinary way a file is written.
    const { findings } = holdCriticalsFailingOnBase(
      [
        {
          ...critical,
          failureScenario:
            'It goes red in packages/cli/src/ui/auth/AuthDialog.test.tsx.',
          locations: [{ file: 'packages/cli/src/ui/auth/AuthDialog.tsx' }],
        },
      ],
      shared,
    );
    expect(findings[0].severity).toBe('Suggestion');
  });

  it('does not match a longer extension on the same stem', () => {
    const { findings } = holdCriticalsFailingOnBase(
      [
        {
          ...critical,
          failureScenario:
            'packages/cli/src/ui/auth/AuthDialog.test.tsx.snap is stale',
          locations: [{ file: 'packages/cli/src/ui/auth/AuthDialog.tsx' }],
        },
      ],
      shared,
    );
    expect(findings[0].severity).toBe('Critical');
  });

  it('requires a boundary after the match, not only before it', () => {
    // `src/a.test.ts` sits inside `src/a.test.tsx`, and the leading check
    // cannot see it: both are preceded by `/`.
    const { findings } = holdCriticalsFailingOnBase(
      [
        {
          ...critical,
          failureScenario:
            'packages/cli/src/ui/auth/AuthDialog.test.tsx is red',
          locations: [{ file: 'packages/cli/src/ui/auth/AuthDialog.tsx' }],
        },
      ],
      ['packages/cli/src/ui/auth/AuthDialog.test.ts'],
    );
    expect(findings[0].severity).toBe('Critical');
  });

  it('requires a path boundary, so a longer directory name is not a match', () => {
    const { findings } = holdCriticalsFailingOnBase(
      [
        {
          ...critical,
          failureScenario:
            'vendor/other-src/ui/auth/AuthDialog.test.tsx is red',
          locations: [{ file: 'packages/cli/src/ui/auth/AuthDialog.tsx' }],
        },
      ],
      shared,
    );
    expect(findings[0].severity).toBe('Critical');
  });
});

describe('sharedFailingFilesOf — cross-workspace identity', () => {
  // The artifact test-delta actually writes for this repo: one entry per
  // workspace command, paths relative to that workspace.
  const delta = {
    entries: [
      {
        command: 'npm test --workspace="packages/cli"',
        netNew: [],
        shared: ['src/utils/errors.test.ts'],
      },
      {
        command: 'npm test --workspace="packages/core"',
        netNew: ['src/utils/errors.test.ts'],
        shared: [],
      },
    ],
    netNew: ['src/utils/errors.test.ts'],
    shared: ['src/utils/errors.test.ts'],
  };

  it('qualifies each entry by the workspace its command names', () => {
    expect(sharedFailingFilesOf(delta).shared).toEqual([
      'packages/cli/src/utils/errors.test.ts',
    ]);
  });

  it('does not hold a Critical about the OTHER workspace of the same path', () => {
    // Six test paths in this repo exist under both packages/cli/src and
    // packages/core/src. A bare suffix would demote a real finding about
    // core's copy because cli's copy was already red.
    const { shared } = sharedFailingFilesOf(delta);
    const critical = {
      id: 'f1',
      severity: 'Critical' as const,
      confidence: 'high' as const,
      source: 'review' as const,
      summary: 'this PR breaks core errors',
      shortSummary: 'core errors',
      failureScenario: 'packages/core/src/utils/errors.test.ts goes red.',
      locations: [{ file: 'packages/core/src/utils/errors.ts' }],
    };
    expect(
      holdCriticalsFailingOnBase([critical], shared).findings[0].severity,
    ).toBe('Critical');
    // ...while the workspace it WAS measured in is still held.
    const cli = {
      ...critical,
      failureScenario: 'packages/cli/src/utils/errors.test.ts goes red.',
    };
    expect(holdCriticalsFailingOnBase([cli], shared).findings[0].severity).toBe(
      'Suggestion',
    );
  });

  it('drops a file some other command measured as net-new', () => {
    expect(
      sharedFailingFilesOf({
        entries: [
          { command: 'npm test', netNew: [], shared: ['src/a.test.ts'] },
          { command: 'npm test', netNew: ['src/a.test.ts'], shared: [] },
        ],
      }).shared,
    ).toEqual([]);
  });

  it('refuses a project-keyed path it cannot place in a workspace', () => {
    // The shape the producer can actually emit: `failingFilesOf` writes
    // `project::path` only when the runner prints a project tag, and a
    // `--workspace=` command never does (neither vitest config here names a
    // project), so a key always arrives on a bare `npm test`. Stripping it
    // would leave a project-relative path that matches as a suffix of any
    // directory — the cross-project collapse, from the consumer side.
    const { shared, unidentifiable } = sharedFailingFilesOf({
      entries: [
        {
          command: 'npm test',
          netNew: [],
          shared: [
            '@qwen-code/qwen-code::src/utils/errors.test.ts',
            'src/plain.test.ts',
          ],
        },
      ],
    });
    expect(shared).toEqual(['src/plain.test.ts']);
    expect(unidentifiable).toEqual([
      '@qwen-code/qwen-code::src/utils/errors.test.ts',
    ]);
  });

  it('does not demote a Critical on a path it refused to place', () => {
    const { shared } = sharedFailingFilesOf({
      entries: [
        {
          command: 'npm test',
          netNew: [],
          shared: ['@qwen-code/qwen-code::src/utils/errors.test.ts'],
        },
      ],
    });
    const critical = {
      id: 'f1',
      severity: 'Critical' as const,
      confidence: 'high' as const,
      source: 'review' as const,
      summary: 'this PR breaks core errors',
      shortSummary: 'core errors',
      failureScenario: 'packages/core/src/utils/errors.test.ts goes red.',
      locations: [{ file: 'packages/core/src/utils/errors.ts' }],
    };
    expect(
      holdCriticalsFailingOnBase([critical], shared).findings[0].severity,
    ).toBe('Critical');
  });

  it('holds nothing from an artifact with no entries to qualify against', () => {
    // The top-level list is the union of the entries with the workspace
    // context already lost. Honouring it would put back the bare path that
    // matches inside any package — the collapse, through the last open door.
    expect(
      sharedFailingFilesOf({ shared: ['src/utils/errors.test.ts'] }).shared,
    ).toEqual([]);
  });

  it('reports only shared paths it had to set aside, not net-new ones', () => {
    // A net-new file was never eligible to hold anything back, so dropping it
    // set nothing aside — and on a plain `npm test` with vitest projects, most
    // keyed entries are net-new.
    const { unidentifiable } = sharedFailingFilesOf({
      entries: [
        {
          command: 'npm test',
          netNew: ['proj::src/n.test.ts'],
          shared: ['proj::src/s.test.ts'],
        },
      ],
    });
    expect(unidentifiable).toEqual(['proj::src/s.test.ts']);
  });
});

describe('sharedFailingFilesOf', () => {
  it('takes the shared list from the top level and from every entry', () => {
    expect(
      sharedFailingFilesOf({
        shared: ['src/a.test.ts'],
        entries: [
          { shared: ['src/a.test.ts', 'src/b.test.ts'] },
          { shared: ['src/c.test.ts'] },
        ],
      }).shared.sort(),
    ).toEqual(['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts']);
  });

  it('yields none for a shape it does not recognise, rather than throwing', () => {
    // An unreadable measurement must not hold a Critical back, and must not
    // take the review down either.
    for (const junk of [null, 42, 'shared', {}, { shared: 'nope' }, []]) {
      expect(sharedFailingFilesOf(junk).shared).toEqual([]);
    }
  });
});

describe('validateFindings — the canonical artifact round-trips', () => {
  it('keeps heldByMeasurement, so a hold survives being fed back', () => {
    // The field exists so a LATER round can see that a measurement lowered
    // this finding, and a round reads the artifact by feeding it back through
    // --input. Dropped here, the hold survives exactly one command and
    // counts.held returns to 0.
    const [f] = validateFindings([
      {
        ...base,
        severity: 'Suggestion',
        heldByMeasurement: { file: 'packages/cli/src/a.test.ts' },
      },
    ]);
    expect(f.heldByMeasurement).toEqual({
      file: 'packages/cli/src/a.test.ts',
    });
    expect(buildReport([f]).counts.held).toBe(1);
  });

  it('keeps outcome and outcomeNote when an artifact is fed back through --input', () => {
    // `validateFindings` accepts `outcome`; dropping the note while keeping the
    // outcome would strip exactly the field a `skipped` finding owes the reader.
    const [f] = validateFindings([
      { ...base, outcome: 'skipped', outcomeNote: 'outside the reviewed diff' },
    ]);
    expect(f.outcome).toBe('skipped');
    expect(f.outcomeNote).toBe('outside the reviewed diff');
  });

  it('ignores a note that arrives with no outcome', () => {
    // A note is a reason for an outcome; without one it has nothing to explain.
    const [f] = validateFindings([{ ...base, outcomeNote: 'stray' }]);
    expect(f.outcome).toBeUndefined();
    expect(f.outcomeNote).toBeUndefined();
  });
});
