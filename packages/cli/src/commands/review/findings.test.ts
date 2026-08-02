/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyOutcomes,
  buildReport,
  compressSummary,
  findingsCommand,
  renderFindings,
  sortFindings,
  validateFindings,
  validateOutcomes,
  type Finding,
  type FindingsReport,
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

  it('rejects a non-numeric line', () => {
    expect(() => validateFindings([{ ...base, line: '42' }])).toThrow(
      /non-numeric "line"/,
    );
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

describe('validateFindings — the canonical artifact round-trips', () => {
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
