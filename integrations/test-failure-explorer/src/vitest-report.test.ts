/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_ASSERTIONS,
  MAX_FILES,
  normalizedReportSchema,
} from './contracts.js';
import { parseVitestReport } from './vitest-report.js';

function assertion(status = 'failed') {
  return {
    ancestorTitles: ['suite'],
    fullName: 'suite repeated title',
    title: 'repeated title',
    status,
    failureMessages: status === 'failed' ? ['Error: failure'] : [],
  };
}
function file(
  assertions: unknown[] = [assertion()],
  status = 'failed',
  message = '',
) {
  return {
    name: '/workspace/example.test.ts',
    status,
    message,
    startTime: 100,
    endTime: 101,
    assertionResults: assertions,
  };
}
function report(files = [file()]) {
  return {
    numTotalTestSuites: 3,
    numPassedTestSuites: 0,
    numFailedTestSuites: 3,
    numPendingTestSuites: 0,
    numTotalTests: 1,
    numPassedTests: 0,
    numFailedTests: 1,
    numPendingTests: 0,
    numTodoTests: 0,
    startTime: 100,
    success: false,
    testResults: files,
  };
}

describe('Vitest 3.2 report normalization', () => {
  it.each([
    ['mixed.json', 2, 4, 1, 0],
    ['file-error.json', 1, 0, 1, 1],
    ['statuses.json', 1, 4, 0, 0],
    ['no-tests-fail.json', 0, 0, 0, 0],
    ['no-tests-pass.json', 0, 0, 0, 0],
    ['unhandled.json', 1, 1, 0, 0],
    ['duplicate-titles.json', 1, 2, 2, 0],
    ['hostile-text.json', 1, 1, 1, 0],
    ['duplicate-paths.derived.json', 2, 4, 4, 0],
  ])(
    'normalizes committed runner output %s against independently known source facts',
    (name, files, assertions, failures, fileErrors) => {
      const raw: unknown = JSON.parse(
        readFileSync(
          new URL(`../test-fixtures/${name}`, import.meta.url),
          'utf8',
        ),
      );
      const parsed = parseVitestReport(raw);
      expect(parsed.computed).toMatchObject({
        fileEntries: files,
        assertions,
        failures,
        fileErrors,
      });
      expect(parsed.consistencyWarnings).toEqual([]);
      expect(normalizedReportSchema.parse(parsed)).toEqual(parsed);
    },
  );

  it('exposes the real unhandled-rejection fixture as report success with unknown execution', () => {
    const raw: unknown = JSON.parse(
      readFileSync(
        new URL('../test-fixtures/unhandled.json', import.meta.url),
        'utf8',
      ),
    );
    const parsed = parseVitestReport(raw);
    expect(parsed.reported.success).toBe(true);
    expect(parsed.provenance.processExitCode).toBe('unknown');
    expect(parsed.provenance.unhandledErrors).toBe('unavailable');
    expect(parsed.files[0].items[0].status).toBe('passed');
    expect(parsed.files[0].items[0].diagnostics).toBe('');
  });

  it('preserves statuses observed by the real runner and the separate pending aggregate', () => {
    const raw: unknown = JSON.parse(
      readFileSync(
        new URL('../test-fixtures/statuses.json', import.meta.url),
        'utf8',
      ),
    );
    const parsed = parseVitestReport(raw);
    expect(parsed.computed.statuses).toEqual({
      passed: 1,
      failed: 0,
      skipped: 2,
      pending: 0,
      todo: 1,
      disabled: 0,
    });
    expect(parsed.reported.numPendingTests).toBe(2);
  });

  it('keeps suite counters separate from files and assigns ordinal identities', () => {
    const parsed = parseVitestReport({
      ...report([file([assertion(), assertion()]), file()]),
      numTotalTests: 3,
      numFailedTests: 3,
      coverageMap: { ignored: true },
    });
    expect(parsed.reported.numTotalTestSuites).toBe(3);
    expect(parsed.computed.fileEntries).toBe(2);
    expect(parsed.consistencyWarnings).toEqual([]);
    expect(
      parsed.files.flatMap((entry) => entry.items.map((item) => item.itemId)),
    ).toEqual(['f0:a0', 'f0:a1', 'f1:a0']);
    expect(normalizedReportSchema.parse(parsed)).toEqual(parsed);
    expect(parsed).not.toHaveProperty('coverageMap');
  });

  it('separates skipped, pending, todo and disabled without renaming pending totals', () => {
    const parsed = parseVitestReport({
      ...report([
        file(
          ['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled'].map(
            assertion,
          ),
        ),
      ]),
      numTotalTests: 6,
      numPassedTests: 1,
      numTodoTests: 1,
      numPendingTests: 2,
    });
    expect(parsed.computed.statuses).toEqual({
      passed: 1,
      failed: 1,
      skipped: 1,
      pending: 1,
      todo: 1,
      disabled: 1,
    });
    expect(parsed.reported.numPendingTests).toBe(2);
    expect(parsed.consistencyWarnings).toEqual([]);
  });

  it('retains file-level errors while avoiding redundant empty file diagnostics', () => {
    const parsed = parseVitestReport(
      report([
        file(),
        file([], 'failed', 'Collection failed'),
        file([], 'failed'),
        file([assertion()], 'failed', 'File-specific problem'),
        file([], 'passed', 'Inconsistent passed file'),
      ]),
    );
    expect(parsed.computed.fileErrors).toBe(4);
    expect(parsed.computed.failures).toBe(5);
    expect(parsed.files[0].items).toHaveLength(1);
    expect(parsed.files[2].items[0]).toMatchObject({
      kind: 'file-error',
      diagnostics: '',
    });
    expect(parsed.files[4].items[0].status).toBe('passed');
    expect(
      parsed.consistencyWarnings.some((warning) =>
        warning.includes('File entry 4'),
      ),
    ).toBe(true);
  });

  it('handles absent optional duration/location and null diagnostics', () => {
    const parsed = parseVitestReport(
      report([file([{ ...assertion(), failureMessages: null }])]),
    );
    expect(parsed.files[0].items[0]).toMatchObject({
      diagnostics: '',
      duration: null,
      location: null,
    });
    const nulls = parseVitestReport(
      report([file([{ ...assertion(), duration: null, location: null }])]),
    );
    expect(nulls.files[0].items[0]).toMatchObject({
      duration: null,
      location: null,
    });
  });

  it('never infers process exit, unhandled errors or tested commit from success', () => {
    const parsed = parseVitestReport({
      ...report([file([assertion('passed')], 'passed')]),
      numFailedTestSuites: 0,
      numPassedTestSuites: 3,
      numPassedTests: 1,
      numFailedTests: 0,
      success: true,
    });
    expect(parsed.provenance).toEqual({
      kind: 'report-only',
      processExitCode: 'unknown',
      runCompleteness: 'unknown',
      unhandledErrors: 'unavailable',
      testedCommit: 'unknown',
    });
    expect(parsed.consistencyWarnings).toEqual([]);
  });

  it('keeps no-test reports report-only and warns about inconsistent comparable counts', () => {
    const parsed = parseVitestReport({
      ...report([]),
      numTotalTests: 0,
      numFailedTests: 0,
    });
    expect(parsed.computed.assertions).toBe(0);
    expect(parsed.reported.success).toBe(false);
    expect(parsed.consistencyWarnings).toEqual([]);
    const mismatch = parseVitestReport({
      ...report(),
      numFailedTests: 0,
      success: true,
    });
    expect(mismatch.consistencyWarnings).toEqual([
      'numFailedTests reports 0 but entries contain 1.',
      'Report success is true despite failure entries.',
    ]);
  });

  it.each([
    { ...report(), numTotalTests: -1 },
    { ...report(), numTotalTests: 1.5 },
    { ...report(), success: 'true' },
    { ...report(), testResults: undefined },
    report([file([{ ...assertion(), status: 'broken' }])]),
    report([file([{ ...assertion(), failureMessages: [3] }])]),
    report([file([{ ...assertion(), duration: Infinity }])]),
  ])(
    'rejects invalid essential data instead of inventing an empty success',
    (value) => {
      expect(() => parseVitestReport(value)).toThrow(
        expect.objectContaining({ code: 'INVALID_REPORT' }),
      );
    },
  );

  it('rejects oversized collections without dropping records', () => {
    expect(() =>
      parseVitestReport(
        report(Array.from({ length: MAX_FILES + 1 }, () => file([]))),
      ),
    ).toThrow(expect.objectContaining({ code: 'REPORT_TOO_LARGE' }));
    expect(() =>
      parseVitestReport(
        report([
          file(Array.from({ length: MAX_ASSERTIONS + 1 }, () => assertion())),
        ]),
      ),
    ).toThrow(expect.objectContaining({ code: 'REPORT_TOO_LARGE' }));
  });
});
