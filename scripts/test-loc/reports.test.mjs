import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  compareCoverage,
  compareFaults,
  compareMutations,
  compareTests,
  testReport,
} from './reports.mjs';

const report = (tests = [['example', 2]]) => ({
  success: true,
  numFailedTests: 0,
  numFailedTestSuites: 0,
  numTotalTests: tests.length,
  numPassedTests: tests.length,
  testResults: [
    {
      name: '/repo/example.test.ts',
      status: 'passed',
      assertionResults: tests.map(([fullName, count]) => ({
        fullName,
        status: 'passed',
        meta: { testLocAssertions: count },
      })),
    },
  ],
});
const coverage = (hits = 1, branches = 'BRDA:1,0,0,1\nBRDA:1,0,1,0\n') => {
  const counts = branches.trim()
    ? branches
        .trim()
        .split('\n')
        .map((line) => +line.split(',').at(-1))
    : [];
  return `SF:src/example.ts\nDA:1,${hits}\n${branches}LF:1\nLH:${hits > 0 ? 1 : 0}\nBRF:${counts.length}\nBRH:${counts.filter((hits) => hits > 0).length}\nend_of_record\n`;
};
const mutation = (status = 'Killed') => ({
  files: {
    'src/example.ts': {
      source: 'true;',
      mutants: [
        {
          location: {
            start: { line: 1, column: 0 },
            end: { line: 1, column: 5 },
          },
          replacement: 'false',
          mutatorName: 'BooleanLiteral',
          status,
        },
      ],
    },
  },
});
const faults = (status = 'detected') => ({
  planSha256: 'plan',
  expectedSHAs: ['abc'],
  complete: true,
  results: [
    {
      sha: 'abc',
      status,
      totalTests: 2,
      failedTests: status === 'detected' ? 1 : 0,
      exit: status === 'detected' ? 1 : 0,
    },
  ],
});

test('a successful process still requires complete successful execution evidence', () => {
  for (const edit of [
    (r) => {
      r.success = false;
    },
    (r) => {
      r.numFailedTestSuites = 1;
    },
    (r) => {
      r.testResults = [];
    },
    (r) => {
      r.testResults[0].status = 'failed';
    },
    (r) => {
      r.numTotalTests = 3;
    },
    (r) => {
      delete r.testResults[0].assertionResults[0].meta;
    },
    (r) => {
      r.testResults[0].assertionResults[0].meta.testLocAssertions = -1;
    },
  ]) {
    const value = report();
    edit(value);
    assert.throws(() => testReport(value));
  }
  assert.throws(() => testReport(report(), 1));
  assert.throws(() => testReport(report([])), /No tests executed/);
  assert.throws(
    () =>
      testReport(
        report([
          ['same', 1],
          ['same', 1],
        ]),
      ),
    /Duplicate/,
  );
});

test('compression requires exact or explicitly mapped names and retained assertions', () => {
  assert.equal(compareTests(report(), report()).ok, true);
  assert.equal(compareTests(report(), report([['renamed', 2]])).ok, false);
  assert.equal(compareTests(report(), report([['example', 1]])).ok, false);
  assert.equal(
    compareTests(report(), report([['renamed', 2]]), {
      mappings: [
        { before: 'example', after: 'renamed', reason: 'table row title' },
      ],
    }).ok,
    true,
  );
  assert.throws(
    () =>
      compareTests(report(), report(), {
        mappings: [{ before: 'absent', after: 'example', reason: 'typo' }],
      }),
    /Unmatched/,
  );
  assert.throws(
    () =>
      compareTests(report(), report(), {
        mappings: [{ before: 'example', after: 'example', reason: '' }],
      }),
    /reason/,
  );
});

test('experiments require explicit reasons for merges, removals and count reductions', () => {
  const before = report([
    ['a', 2],
    ['b', 2],
  ]);
  const after = report([['merged', 2]]);
  const mappings = ['a', 'b'].map((name) => ({
    before: name,
    after: 'merged',
    reason: 'both check the same invariant',
  }));
  assert.throws(() => compareTests(before, after, { mappings }), /Many-to-one/);
  assert.equal(
    compareTests(before, after, { mode: 'experiment', mappings }).ok,
    true,
  );
  assert.equal(compareTests(before, after, { mode: 'experiment' }).ok, false);
  assert.equal(
    compareTests(before, report([['a', 2]]), {
      mode: 'experiment',
      removed: [{ before: 'b', reason: 'a checks the same boundary' }],
    }).ok,
    true,
  );
  assert.throws(
    () =>
      compareTests(before, report([['a', 2]]), {
        removed: [{ before: 'b', reason: 'duplicate' }],
      }),
    /experiment/,
  );
  assert.equal(
    compareTests(report(), report([['example', 1]]), { mode: 'experiment' }).ok,
    false,
  );
  assert.equal(
    compareTests(report(), report([['example', 1]]), {
      mode: 'experiment',
      mappings: [
        {
          before: 'example',
          after: 'example',
          reason: 'remove repeated assertion',
        },
      ],
    }).ok,
    true,
  );
});

test('a passed test cannot silently become skipped', () => {
  const before = report([
    ['a', 1],
    ['b', 1],
  ]);
  const after = report([
    ['a', 1],
    ['b', 1],
  ]);
  after.testResults[0].assertionResults[1].status = 'skipped';
  after.numPassedTests = 1;
  assert.deepEqual(compareTests(before, after).newlySkipped, ['b']);
});

test('coverage requires records, requested sources and the same line inventory', () => {
  for (const invalid of [
    '',
    'SF:src/example.ts\n',
    'SF:src/example.ts\nend_of_record\n',
  ])
    assert.throws(() => compareCoverage(coverage(), invalid));
  assert.throws(
    () => compareCoverage(coverage(), coverage(), ['src/missing.ts']),
    /Missing coverage file/,
  );
  assert.throws(
    () => compareCoverage(coverage(), coverage().replace('DA:1,1', 'DA:1,')),
    /coverage count/,
  );
  assert.throws(
    () => compareCoverage(coverage(), coverage().replace('DA:1', 'DA:2')),
    /line sets differ/,
  );
  assert.equal(compareCoverage(coverage(), coverage()).ok, true);
  assert.throws(
    () => compareCoverage(coverage(), coverage().replace('LF:1', 'LF:2')),
    /LCOV LF/,
  );
  assert.deepEqual(compareCoverage(coverage(), coverage(0)).lostLines, [
    'src/example.ts:1',
  ]);
});

test('coverage reports switched branch outcomes and incomplete branch shapes', () => {
  const switched = coverage(1, 'BRDA:1,4,0,0\nBRDA:1,4,1,1\n');
  assert.deepEqual(compareCoverage(coverage(), switched).lostBranches, [
    'src/example.ts:1#0',
  ]);
  const missing = compareCoverage(coverage(), coverage(1, ''));
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.branchShapeChanges, ['src/example.ts:1']);
});

test('mutation comparison rejects empty, incomplete, duplicate or different samples', () => {
  assert.throws(() => compareMutations({ files: {} }, mutation()), /Empty/);
  assert.throws(
    () => compareMutations(mutation(), mutation('Pending')),
    /Unfinished/,
  );
  const changed = mutation();
  changed.files['src/example.ts'].mutants[0].replacement = 'true';
  assert.throws(
    () => compareMutations(mutation(), changed),
    /sample sets differ/,
  );
  const changedSource = mutation();
  changedSource.files['src/example.ts'].source = 'false;';
  assert.throws(
    () => compareMutations(mutation(), changedSource),
    /source sets differ/,
  );
  const duplicate = mutation();
  duplicate.files['src/example.ts'].mutants.push(
    duplicate.files['src/example.ts'].mutants[0],
  );
  assert.throws(() => compareMutations(mutation(), duplicate), /Duplicate/);
  assert.equal(
    compareMutations(mutation(), mutation(), { expected: mutation() }).ok,
    true,
  );
  assert.equal(
    compareMutations(mutation(), mutation('Survived')).lostKills.length,
    1,
  );
  assert.equal(
    compareMutations(mutation(), mutation('Timeout')).inconclusive.length,
    1,
  );
  const noCoverage = compareMutations(
    mutation('Survived'),
    mutation('NoCoverage'),
  );
  assert.deepEqual(noCoverage.statusCounts, {
    before: { Survived: 1 },
    after: { NoCoverage: 1 },
  });
  assert.equal(noCoverage.statusChanges[0].after, 'NoCoverage');
  assert.equal(noCoverage.ok, false);
  assert.equal(
    compareMutations(mutation('NoCoverage'), mutation('NoCoverage')).ok,
    false,
  );
  for (const status of ['CompileError', 'Ignored']) {
    assert.equal(
      compareMutations(mutation('Survived'), mutation(status)).ok,
      false,
    );
    assert.throws(
      () => compareMutations(mutation(status), mutation(status)),
      /No executable mutation sample/,
    );
  }
});

test('fault infrastructure failures cannot become missed or retained detections', () => {
  assert.equal(compareFaults(faults(), faults()).ok, true);
  assert.deepEqual(compareFaults(faults(), faults('missed')).lost, ['abc']);
  const changed = faults();
  changed.results[0].failedTests = 2;
  changed.results[0].failedFiles = ['src/another.test.ts'];
  assert.equal(compareFaults(faults(), changed).ok, true);
  assert.deepEqual(compareFaults(faults(), changed).detectionChanges[0].after, {
    failedTests: 2,
    failedFiles: ['src/another.test.ts'],
  });
  for (const status of ['apply-failed', 'no-result'])
    assert.throws(() => compareFaults(faults(), faults(status)), /Incomplete/);
  const missing = faults();
  missing.results[0].totalTests = 0;
  assert.throws(() => compareFaults(faults(), missing), /execution evidence/);
  missing.results[0].totalTests = 2;
  missing.results[0].exit = 0;
  assert.throws(() => compareFaults(faults(), missing), /Contradictory/);
  missing.results[0].exit = 1;
  missing.results[0].failedTests = 100;
  assert.throws(() => compareFaults(faults(), missing), /execution evidence/);
  missing.results[0].failedTests = 1;
  missing.results[0].healthFailures = -1;
  assert.throws(() => compareFaults(faults(), missing), /execution evidence/);
});

test('fault exclusions require identical reasons and healthy executions remain separate', () => {
  const before = faults();
  before.expectedSHAs.push('excluded');
  before.results.push({
    sha: 'excluded',
    status: 'ineligible',
    reason: 'patch does not apply',
  });
  const after = structuredClone(before);
  assert.deepEqual(compareFaults(before, after).excluded, [
    { sha: 'excluded', reason: 'patch does not apply' },
  ]);
  after.results[1].reason = 'different reason';
  assert.throws(() => compareFaults(before, after), /eligibility differs/);
  const unhealthy = faults('missed');
  unhealthy.results[0].healthFailures = 1;
  unhealthy.results[0].exit = 1;
  assert.equal(compareFaults(unhealthy, unhealthy).ok, false);
  assert.equal(compareFaults(unhealthy, unhealthy).baselineFailures.length, 1);
  assert.throws(
    () =>
      compareFaults(
        { ...faults(), planSha256: 'a' },
        { ...faults(), planSha256: 'b' },
      ),
    /plan hashes differ/,
  );
});

test('a shared truncated fault report cannot pass a complete frozen plan', () => {
  const legacy = faults();
  delete legacy.planSha256;
  delete legacy.expectedSHAs;
  delete legacy.complete;
  assert.equal(compareFaults(legacy, legacy).ok, false);
  assert.equal(compareFaults(legacy, legacy).sampleComplete, false);
  const complete = {
    ...faults(),
    planSha256: 'plan',
    expectedSHAs: ['abc', 'excluded'],
    complete: true,
  };
  complete.results.push({
    sha: 'excluded',
    status: 'ineligible',
    reason: 'not applicable',
  });
  assert.equal(compareFaults(complete, complete).ok, true);
  const partial = structuredClone(complete);
  partial.results.pop();
  assert.throws(() => compareFaults(partial, partial), /complete plan/);
  const unfinished = { ...complete, complete: false };
  assert.throws(() => compareFaults(unfinished, unfinished), /incomplete/);
  const missingExpected = { ...complete };
  delete missingExpected.expectedSHAs;
  assert.throws(
    () => compareFaults(missingExpected, missingExpected),
    /expected fault identities/,
  );
});

test('mutation completeness requires an independent frozen sample and rejects shared truncation', () => {
  const frozen = mutation();
  const second = structuredClone(frozen.files['src/example.ts'].mutants[0]);
  second.replacement = 'undefined';
  frozen.files['src/example.ts'].mutants.push(second);
  const partial = mutation();
  assert.throws(
    () => compareMutations(partial, partial, { expected: frozen }),
    /Frozen mutation sample is incomplete/,
  );
  assert.equal(compareMutations(frozen, frozen, { expected: frozen }).ok, true);
  const unverified = compareMutations(frozen, frozen);
  assert.equal(unverified.sampleComplete, false);
  assert.equal(unverified.ok, false);
});

test('CLI returns error for missing/invalid reports and failure for lost coverage, including spaced paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test loc '));
  const cli = fileURLToPath(new URL('./compare.mjs', import.meta.url));
  try {
    const before = path.join(dir, 'before report.lcov');
    const after = path.join(dir, 'after report.lcov');
    fs.writeFileSync(before, coverage());
    assert.equal(
      spawnSync(process.execPath, [cli, 'coverage', before, after]).status,
      2,
    );
    fs.writeFileSync(after, '');
    assert.equal(
      spawnSync(process.execPath, [cli, 'coverage', before, after]).status,
      2,
    );
    fs.writeFileSync(after, coverage(0));
    assert.equal(
      spawnSync(process.execPath, [cli, 'coverage', before, after]).status,
      1,
    );
    fs.writeFileSync(after, coverage());
    assert.equal(
      spawnSync(process.execPath, [cli, 'coverage', before, after]).status,
      0,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
