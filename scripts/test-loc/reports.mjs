import assert from 'node:assert/strict';

const check = (condition, message) => assert(condition, message);
const natural = (value) => Number.isInteger(value) && value >= 0;
const countText = (value) => /^\d+$/.test(value) && natural(+value);
const keyPath = (value) =>
  value.replaceAll('\\', '/').replace(/^.*\/src\//, 'src/');

export function testReport(report, exitCode = 0) {
  check(exitCode === 0, `Test process exited ${exitCode}`);
  check(report.success === true, 'Test report did not succeed');
  check(
    report.numFailedTests === 0 && report.numFailedTestSuites === 0,
    'Failed tests or suites',
  );
  check(
    Array.isArray(report.testResults) && report.testResults.length > 0,
    'Missing test results',
  );
  const tests = new Map();
  let total = 0;
  let passed = 0;
  for (const file of report.testResults) {
    check(file.status === 'passed', `Failed suite: ${file.name}`);
    check(
      Array.isArray(file.assertionResults),
      `Missing assertions: ${file.name}`,
    );
    for (const test of file.assertionResults) {
      total++;
      check(
        typeof test.fullName === 'string' && test.fullName.length > 0,
        'Missing test name',
      );
      check(!tests.has(test.fullName), `Duplicate test name: ${test.fullName}`);
      check(
        ['passed', 'pending', 'skipped', 'todo'].includes(test.status),
        `Unfinished/failed test: ${test.fullName}`,
      );
      if (test.status === 'passed') {
        passed++;
        check(
          natural(test.meta?.testLocAssertions),
          `Missing assertion count: ${test.fullName}`,
        );
      }
      tests.set(test.fullName, {
        status: test.status,
        assertions: test.meta?.testLocAssertions,
      });
    }
  }
  check(passed > 0, 'No tests executed');
  check(
    total === report.numTotalTests && passed === report.numPassedTests,
    'Incomplete test report',
  );
  return tests;
}

export function compareTests(
  before,
  after,
  { mode = 'compression', mappings = [], removed = [] } = {},
) {
  check(
    ['compression', 'experiment'].includes(mode),
    'Unknown comparison mode',
  );
  check(
    Array.isArray(mappings) && Array.isArray(removed),
    'Invalid name mapping',
  );
  const a = testReport(before);
  const b = testReport(after);
  const mapping = new Map();
  const deletions = new Map();
  const targets = new Set();
  for (const item of mappings) {
    check(
      a.has(item.before) && b.has(item.after),
      `Unmatched mapping: ${item.before} -> ${item.after}`,
    );
    check(
      typeof item.reason === 'string' && item.reason.trim(),
      `Missing mapping reason: ${item.before}`,
    );
    check(!mapping.has(item.before), `Duplicate mapping: ${item.before}`);
    check(
      mode === 'experiment' || !targets.has(item.after),
      `Many-to-one mapping requires experiment mode: ${item.after}`,
    );
    mapping.set(item.before, item);
    targets.add(item.after);
  }
  for (const item of removed) {
    check(mode === 'experiment', 'Removing tests requires experiment mode');
    check(
      a.has(item.before) && !b.has(item.before) && !mapping.has(item.before),
      `Invalid removed test: ${item.before}`,
    );
    check(
      typeof item.reason === 'string' && item.reason.trim(),
      `Missing deletion reason: ${item.before}`,
    );
    check(!deletions.has(item.before), `Duplicate deletion: ${item.before}`);
    deletions.set(item.before, item);
  }
  const missing = [];
  const fewerAssertions = [];
  const newlySkipped = [];
  const matches = [];
  const used = new Set();
  for (const [name, test] of a) {
    if (deletions.has(name)) continue;
    const target = mapping.get(name)?.after ?? name;
    const next = b.get(target);
    if (!next) {
      missing.push(name);
      continue;
    }
    check(
      mode === 'experiment' || !used.has(target),
      `Many-to-one mapping requires experiment mode: ${target}`,
    );
    used.add(target);
    matches.push({
      before: name,
      after: target,
      reason: mapping.get(name)?.reason,
    });
    if (test.status === 'passed' && next.status !== 'passed')
      newlySkipped.push(name);
    if (
      test.status === 'passed' &&
      next.status === 'passed' &&
      next.assertions < test.assertions
    ) {
      fewerAssertions.push({
        before: name,
        after: target,
        counts: [test.assertions, next.assertions],
      });
    }
  }
  const sum = (tests) =>
    [...tests.values()].reduce((n, t) => n + (t.assertions ?? 0), 0);
  const unexplainedReductions = fewerAssertions.filter(
    (item) => !mapping.has(item.before),
  );
  return {
    ok:
      missing.length === 0 &&
      newlySkipped.length === 0 &&
      (mode === 'experiment'
        ? unexplainedReductions.length === 0
        : fewerAssertions.length === 0),
    mode,
    tests: { before: a.size, after: b.size },
    assertions: { before: sum(a), after: sum(b) },
    missing,
    newlySkipped,
    fewerAssertions,
    unexplainedReductions,
    matches,
    removed,
    added: [...b.keys()].filter((name) => !used.has(name)),
  };
}

export function parseCoverage(text, expectedFiles = []) {
  const files = new Map();
  let record;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('SF:')) {
      check(!record, 'Unterminated LCOV record');
      const name = keyPath(raw.slice(3));
      check(name && !files.has(name), `Duplicate/empty coverage file: ${name}`);
      record = { name, lines: new Map(), branches: new Map(), summary: {} };
    } else if (raw === 'end_of_record') {
      check(record, 'LCOV terminator without a file');
      const branches = [...record.branches.values()].flat();
      const expected = {
        LF: record.lines.size,
        LH: [...record.lines.values()].filter((hits) => hits > 0).length,
        BRF: branches.length,
        BRH: branches.filter((hits) => hits > 0).length,
      };
      for (const [key, count] of Object.entries(expected))
        check(
          record.summary[key] === count,
          `Missing/inconsistent LCOV ${key}: ${record.name}`,
        );
      files.set(record.name, record);
      record = undefined;
    } else if (/^(LF|LH|BRF|BRH):/.test(raw)) {
      const [key, value] = raw.split(':');
      check(
        record && countText(value) && record.summary[key] === undefined,
        `Invalid LCOV summary: ${raw}`,
      );
      record.summary[key] = +value;
    } else if (raw.startsWith('DA:') || raw.startsWith('BRDA:')) {
      check(record, 'LCOV data without a file');
      const values = raw.slice(raw.indexOf(':') + 1).split(',');
      check(countText(values[0]) && +values[0] > 0, 'Invalid coverage line');
      if (raw.startsWith('DA:')) {
        check(
          values.length >= 2 &&
            countText(values[1]) &&
            !record.lines.has(+values[0]),
          'Invalid/duplicate coverage count',
        );
        record.lines.set(+values[0], +values[1]);
      } else {
        check(
          values.length === 4 &&
            countText(values[1]) &&
            countText(values[2]) &&
            (values[3] === '-' || countText(values[3])),
          'Invalid branch coverage count',
        );
        const branches = record.branches.get(+values[0]) ?? [];
        branches.push(values[3] === '-' ? 0 : +values[3]);
        record.branches.set(+values[0], branches);
      }
    }
  }
  check(!record, 'Unterminated LCOV record');
  check(
    files.size > 0 && [...files.values()].some((f) => f.lines.size > 0),
    'Empty coverage report',
  );
  for (const file of expectedFiles)
    check(files.has(keyPath(file)), `Missing coverage file: ${file}`);
  return expectedFiles.length
    ? new Map(expectedFiles.map((f) => [keyPath(f), files.get(keyPath(f))]))
    : files;
}

export function compareCoverage(before, after, expectedFiles = []) {
  const a = parseCoverage(before, expectedFiles);
  const b = parseCoverage(after, expectedFiles);
  check(
    a.size === b.size && [...a.keys()].every((f) => b.has(f)),
    'Coverage file sets differ',
  );
  const lostLines = [];
  const lostBranches = [];
  const branchShapeChanges = [];
  let coveredBefore = 0;
  let coveredAfter = 0;
  for (const [file, old] of a) {
    const next = b.get(file);
    check(
      old.lines.size === next.lines.size &&
        [...old.lines.keys()].every((line) => next.lines.has(line)),
      `Instrumented line sets differ: ${file}`,
    );
    for (const [line, hits] of old.lines) {
      if (hits > 0) coveredBefore++;
      if (next.lines.get(line) > 0) coveredAfter++;
      if (hits > 0 && next.lines.get(line) === 0)
        lostLines.push(`${file}:${line}`);
    }
    for (const line of new Set([
      ...old.branches.keys(),
      ...next.branches.keys(),
    ])) {
      const x = old.branches.get(line) ?? [];
      const y = next.branches.get(line) ?? [];
      if (x.length !== y.length) {
        branchShapeChanges.push(`${file}:${line}`);
        continue;
      }
      x.forEach((hits, i) => {
        if (hits > 0 && y[i] === 0) lostBranches.push(`${file}:${line}#${i}`);
      });
    }
  }
  return {
    ok:
      lostLines.length === 0 &&
      lostBranches.length === 0 &&
      branchShapeChanges.length === 0,
    files: a.size,
    coveredBefore,
    coveredAfter,
    lostLines,
    lostBranches,
    branchShapeChanges,
  };
}

export function compareMutations(before, after, { expected } = {}) {
  const load = (report) => {
    check(
      report.files && typeof report.files === 'object',
      'Missing mutation files',
    );
    const result = new Map();
    const sources = new Map();
    for (const [file, data] of Object.entries(report.files)) {
      check(
        typeof data.source === 'string' && !sources.has(keyPath(file)),
        `Missing/duplicate mutation source: ${file}`,
      );
      sources.set(keyPath(file), data.source);
      check(Array.isArray(data.mutants), `Missing mutants: ${file}`);
      for (const mutant of data.mutants) {
        const { start, end } = mutant.location ?? {};
        check(
          start &&
            end &&
            natural(start.line) &&
            natural(start.column) &&
            natural(end.line) &&
            natural(end.column),
          'Invalid mutant location',
        );
        check(
          typeof mutant.mutatorName === 'string',
          'Missing mutant operator',
        );
        check(
          [
            'Killed',
            'Survived',
            'NoCoverage',
            'Timeout',
            'CompileError',
            'RuntimeError',
            'Ignored',
          ].includes(mutant.status),
          `Unfinished/unknown mutant: ${mutant.status}`,
        );
        const key = `${keyPath(file)}:${start.line}:${start.column}-${end.line}:${end.column}:${mutant.mutatorName}:${mutant.replacement ?? ''}`;
        check(!result.has(key), `Duplicate mutant: ${key}`);
        result.set(key, mutant.status);
      }
    }
    check(result.size > 0, 'Empty mutation report');
    return { mutants: result, sources };
  };
  const { mutants: a, sources: aSources } = load(before);
  const { mutants: b, sources: bSources } = load(after);
  check(
    aSources.size === bSources.size &&
      [...aSources].every(([file, source]) => bSources.get(file) === source),
    'Mutation source sets differ',
  );
  check(
    a.size === b.size && [...a.keys()].every((key) => b.has(key)),
    'Mutation sample sets differ',
  );
  if (expected) {
    const frozen = load(expected);
    check(
      frozen.sources.size === aSources.size &&
        [...frozen.sources].every(
          ([file, source]) => aSources.get(file) === source,
        ),
      'Frozen mutation source sets differ',
    );
    check(
      frozen.mutants.size === a.size &&
        [...frozen.mutants.keys()].every((key) => a.has(key)),
      'Frozen mutation sample is incomplete',
    );
  }
  const lostKills = [];
  const gainedKills = [];
  const inconclusive = [];
  const statusChanges = [];
  const excluded = [];
  for (const [key, status] of a) {
    const next = b.get(key);
    if (status !== next)
      statusChanges.push({ key, before: status, after: next });
    if (status === next && ['CompileError', 'Ignored'].includes(status)) {
      excluded.push({ key, status });
      continue;
    }
    if (
      ['Timeout', 'RuntimeError', 'CompileError', 'Ignored'].includes(status) ||
      ['Timeout', 'RuntimeError', 'CompileError', 'Ignored'].includes(next)
    )
      inconclusive.push({ key, before: status, after: next });
    else if (status === 'Killed' && next !== 'Killed')
      lostKills.push({ key, before: status, after: next });
    else if (status !== 'Killed' && next === 'Killed')
      gainedKills.push({ key, before: status, after: next });
  }
  const counts = (mutants) => {
    const statuses = {};
    for (const status of mutants.values())
      statuses[status] = (statuses[status] ?? 0) + 1;
    return statuses;
  };
  check(a.size > excluded.length, 'No executable mutation sample');
  const executed = (mutants) =>
    [...mutants.values()].filter((status) =>
      ['Killed', 'Survived'].includes(status),
    ).length;
  const executions = { before: executed(a), after: executed(b) };
  return {
    ok:
      lostKills.length === 0 &&
      inconclusive.length === 0 &&
      executions.before > 0 &&
      executions.after > 0 &&
      Boolean(expected),
    mutants: a.size,
    lostKills,
    gainedKills,
    inconclusive,
    statusCounts: { before: counts(a), after: counts(b) },
    statusChanges,
    excluded,
    executions,
    sampleComplete: Boolean(expected),
  };
}

export function compareFaults(before, after) {
  if (before.planSha256 !== undefined || after.planSha256 !== undefined) {
    check(
      typeof before.planSha256 === 'string' &&
        before.planSha256.length > 0 &&
        before.planSha256 === after.planSha256,
      'Fault plan hashes differ',
    );
  }
  const load = (report) => {
    check(
      Array.isArray(report.results) && report.results.length > 0,
      'Empty fault replay report',
    );
    const entries = new Map();
    for (const result of report.results) {
      check(
        typeof result.sha === 'string' &&
          result.sha.length > 0 &&
          !entries.has(result.sha),
        'Invalid/duplicate fault identity',
      );
      if (result.status === 'ineligible') {
        check(
          typeof result.reason === 'string' && result.reason.trim(),
          `Missing ineligibility reason: ${result.sha}`,
        );
        entries.set(result.sha, result);
        continue;
      }
      check(
        ['detected', 'missed'].includes(result.status),
        `Incomplete fault replay: ${result.sha} (${result.status})`,
      );
      check(
        natural(result.totalTests) &&
          result.totalTests > 0 &&
          natural(result.failedTests) &&
          result.failedTests <= result.totalTests &&
          ((report.planSha256 === undefined &&
            result.healthFailures === undefined) ||
            natural(result.healthFailures)),
        `Missing fault execution evidence: ${result.sha}`,
      );
      check(
        result.status === 'detected'
          ? result.failedTests > 0 && result.exit === 1
          : result.failedTests === 0 &&
              (result.exit === 0 ||
                (result.exit === 1 &&
                  natural(result.healthFailures) &&
                  result.healthFailures > 0)),
        `Contradictory fault result: ${result.sha}`,
      );
      entries.set(result.sha, result);
    }
    if (report.planSha256 !== undefined) {
      check(report.complete === true, 'Fault replay is incomplete');
      check(
        Array.isArray(report.expectedSHAs) &&
          report.expectedSHAs.length > 0 &&
          report.expectedSHAs.every(
            (sha) => typeof sha === 'string' && sha.length > 0,
          ),
        'Missing expected fault identities',
      );
      const expected = new Set(report.expectedSHAs);
      check(
        expected.size === report.expectedSHAs.length &&
          entries.size === expected.size &&
          [...entries.keys()].every((sha) => expected.has(sha)),
        'Fault replay does not cover the complete plan',
      );
    }
    return entries;
  };
  const a = load(before);
  const b = load(after);
  check(
    a.size === b.size && [...a.keys()].every((key) => b.has(key)),
    'Fault corpus sets differ',
  );
  const lost = [];
  const excluded = [];
  const baselineFailures = [];
  const detectionChanges = [];
  for (const [sha, old] of a) {
    const next = b.get(sha);
    if (old.status === 'ineligible' || next.status === 'ineligible') {
      check(
        old.status === next.status && old.reason === next.reason,
        `Fault eligibility differs: ${sha}`,
      );
      excluded.push({ sha, reason: old.reason });
    } else {
      if (old.status === 'detected' && next.status !== 'detected')
        lost.push(sha);
      const files = (result) => (result.failedFiles ?? []).map(keyPath).sort();
      if (
        old.failedTests !== next.failedTests ||
        JSON.stringify(files(old)) !== JSON.stringify(files(next))
      ) {
        detectionChanges.push({
          sha,
          before: { failedTests: old.failedTests, failedFiles: files(old) },
          after: { failedTests: next.failedTests, failedFiles: files(next) },
        });
      }
      if (old.healthFailures > 0 || next.healthFailures > 0)
        baselineFailures.push({
          sha,
          before: old.healthFailures ?? 0,
          after: next.healthFailures ?? 0,
        });
    }
  }
  check(a.size > excluded.length, 'No eligible faults executed');
  return {
    ok:
      lost.length === 0 &&
      baselineFailures.length === 0 &&
      Boolean(before.planSha256 && after.planSha256),
    sampleComplete: Boolean(before.planSha256 && after.planSha256),
    faults: a.size - excluded.length,
    lost,
    excluded,
    baselineFailures,
    detectionChanges,
  };
}
