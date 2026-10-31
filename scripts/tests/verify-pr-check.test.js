/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkArtifacts,
  checkMutationCoverage,
} from '../../scripts/verify-pr-check.mjs';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-check.mjs', import.meta.url),
);
const HEAD = 'b'.repeat(40);

function validFiles(overrides = {}) {
  return {
    report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n# Report\n`,
    verdict: 'merge-ready\n',
    assertions: JSON.stringify({ pass: 4, fail: 0, total: 4 }),
    ...overrides,
  };
}

function check(overrides, evidence = ['01-ab-cells.png']) {
  return checkArtifacts({ files: validFiles(overrides), evidence });
}

let tmpDirs = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeArtifactDir(files, evidence = []) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-pr-check-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'report.md'), files.report);
  writeFileSync(join(dir, 'verdict.txt'), files.verdict);
  writeFileSync(join(dir, 'assertions.json'), files.assertions);
  if (evidence.length > 0) {
    mkdirSync(join(dir, 'evidence'));
    for (const name of evidence) {
      writeFileSync(join(dir, 'evidence', name), 'png');
    }
  }
  return dir;
}

describe('checkArtifacts', () => {
  it('accepts a consistent round', () => {
    const result = check({});
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.counts).toEqual({ pass: 4, fail: 0, total: 4 });
    expect(result.verdict).toBe('merge-ready');
  });

  // The publisher refuses this pair, and the local path had no equivalent:
  // a merge-ready report carrying failures is the shape that shipped once and
  // degraded to "no usable structured verdict".
  it('refuses merge-ready when an assertion failed', () => {
    const result = check({
      verdict: 'merge-ready\n',
      assertions: JSON.stringify({ pass: 3, fail: 1, total: 4 }),
    });
    expect(result.errors.join('\n')).toMatch(
      /merge-ready with 1 failed assertion/,
    );
  });

  it('accepts findings with a nonzero fail', () => {
    const result = check({
      verdict: 'findings\n',
      report: `findings · 3 passed · 1 failed · 4 total · ${HEAD}\n`,
      assertions: JSON.stringify({ pass: 3, fail: 1, total: 4 }),
    });
    expect(result.errors).toEqual([]);
  });

  it('requires the four verdict words and nothing else', () => {
    for (const word of ['merge-ready', 'findings', 'blocked', 'inconclusive']) {
      expect(
        check({ verdict: `${word}\n`, report: `${word} · ${HEAD}\n` }).errors,
      ).toEqual([]);
    }
    expect(check({ verdict: 'PASS\n' }).errors.join('\n')).toMatch(
      /verdict.txt must be exactly one of/,
    );
    expect(check({ verdict: 'merge-ready but\n' }).errors.join('\n')).toMatch(
      /verdict.txt must be exactly one of/,
    );
  });

  it('validates the assertion triple rather than each field alone', () => {
    const cases = [
      ['{"pass":4}', /non-negative integers pass, fail and total/],
      ['{"pass":"4","fail":0,"total":4}', /non-negative integers/],
      ['{"pass":4,"fail":-1,"total":3}', /non-negative integers/],
      ['{"pass":4,"fail":0,"total":0}', /total is 0/],
      ['{"pass":2,"fail":1,"total":4}', /inconsistent/],
      ['not json', /not valid JSON/],
      // JSON.parse accepts all three; the publisher's jq requires an object,
      // and a null artifact used to skip every count check and read as clean.
      ['null', /must be an object/],
      ['[]', /must be an object/],
      ['0', /must be an object/],
    ];
    for (const [assertions, message] of cases) {
      expect(check({ assertions }).errors.join('\n')).toMatch(message);
    }
  });

  it('reports missing and empty artifacts as errors', () => {
    const result = checkArtifacts({
      files: { report: null, verdict: '', assertions: ' ' },
      evidence: [],
    });
    expect(result.errors).toContain('report.md is missing');
    expect(result.errors).toContain('verdict.txt is empty');
    expect(result.errors).toContain('assertions.json is empty');
  });

  // A table is the claim, a capture is the witness; the contract calls these
  // mandatory whenever a harness ran, which a checker cannot know, so the
  // absence is a warning and the naming rule is what binds image to claim.
  it('warns about missing or misnamed evidence', () => {
    expect(check({}, []).warnings.join('\n')).toMatch(/no PNG capture/);
    expect(
      check({}, ['01-AB-Cells.PNG', '01_ab.png']).warnings.join('\n'),
    ).toMatch(/01-AB-Cells\.PNG is not a kebab-case caption/);
    expect(check({}, ['01_ab.png']).warnings.join('\n')).toMatch(
      /01_ab\.png is not a kebab-case caption/,
    );
  });

  it('warns when the report does not lead with its verdict and head', () => {
    const result = check({ report: '# Report\n\nbody\n' });
    expect(result.warnings.join('\n')).toMatch(/does not state "merge-ready"/);
    expect(result.warnings.join('\n')).toMatch(/40-character head OID/);
  });

  // Presence is not identity: a base OID is also 40 hex characters. With the
  // round snapshot at hand, the cited OID has to be the head it verified.
  it('warns when the report cites an OID other than the verified head', () => {
    const head = 'c'.repeat(40);
    const base = 'd'.repeat(40);
    const cites = (oid) =>
      `merge-ready · 1 passed · 0 failed · 1 total · ${oid}\n`;

    const correct = checkArtifacts({
      files: validFiles({ report: cites(head) }),
      evidence: [],
      expectedHead: head,
    });
    expect(correct.warnings.join('\n')).not.toContain(
      'does not name the verified head',
    );

    const other = checkArtifacts({
      files: validFiles({ report: cites(base) }),
      evidence: [],
      expectedHead: head,
    });
    expect(other.warnings.join('\n')).toContain(
      `does not name the verified head ${head}`,
    );
    expect(other.warnings.join('\n')).toContain('cites 1 other OID');
  });
});

// A round proved a repo test red on both arms, booked that red twice (head and
// its base control), and published `findings` while its own verdict line said
// neither reason was a defect in the PR. The prose taught how to prove a red
// environmental and never how to count it afterwards.
describe('failures ledger', () => {
  const withFailures = (
    failures,
    verdict = 'findings',
    fail = failures.length,
  ) =>
    check({
      verdict: `${verdict}\n`,
      report: `${verdict} · ${4 - fail} passed · ${fail} failed · 4 total · ${HEAD}\n`,
      assertions: JSON.stringify({ pass: 4 - fail, fail, total: 4, failures }),
    });

  it('refuses the exact shape that shipped: findings with only environment reds', () => {
    const result = withFailures(
      [
        { id: 'gh-config-dir-head', attribution: 'environment' },
        { id: 'gh-config-dir-base-aa', attribution: 'environment' },
      ],
      'findings',
      2,
    );
    expect(result.errors.join('\n')).toMatch(
      /findings with 2 failed assertions and none attributed to the PR \(environment\)/,
    );
    expect(result.errors.join('\n')).toMatch(/expected-red pass/);
  });

  it('accepts findings when a failure is attributed to the PR', () => {
    expect(
      withFailures([{ id: 'budget-halt', attribution: 'pr' }]).errors,
    ).toEqual([]);
    expect(
      withFailures([
        { id: 'budget-halt', attribution: 'pr' },
        { id: 'host-path', attribution: 'environment' },
      ]).errors,
    ).toEqual([]);
  });

  it('accepts inconclusive for a harness fault, which is the prescribed pairing', () => {
    expect(
      withFailures(
        [{ id: 'flaky-probe', attribution: 'harness' }],
        'inconclusive',
      ).errors,
    ).toEqual([]);
  });

  it('refuses blocked on a harness fault too', () => {
    expect(
      withFailures(
        [{ id: 'flaky-probe', attribution: 'harness' }],
        'blocked',
      ).errors.join('\n'),
    ).toMatch(/blocked with 1 failed assertion and none attributed to the PR/);
  });

  it('validates the ledger against the count and the vocabulary', () => {
    const cases = [
      ['not-an-array', /failures must be an array/],
      [
        [{ id: 'x', attribution: 'unknown' }],
        /need an id and an attribution of/,
      ],
      [[{ attribution: 'pr' }], /need an id and an attribution of/],
      [[{ id: '  ', attribution: 'pr' }], /need an id and an attribution of/],
      [[], /lists 0 failures but counts fail 1/],
    ];
    for (const [failures, message] of cases) {
      expect(withFailures(failures, 'findings', 1).errors.join('\n')).toMatch(
        message,
      );
    }
  });

  // A malformed ledger is not an absent one: "carries no ledger" sends the
  // reader looking in the wrong place, and the branch that skips that warning
  // must not then read a null attribution list.
  it('does not call a malformed ledger absent, and does not crash on it', () => {
    for (const failures of [
      'not-an-array',
      [{ id: 'x', attribution: 'nope' }],
      [],
    ]) {
      const result = withFailures(failures, 'findings', 1);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.warnings.join('\n')).not.toMatch(
        /carries no failures ledger/,
      );
    }
  });

  it('warns rather than fails when an older round carries no ledger', () => {
    const result = check({
      verdict: 'findings\n',
      report: `findings · 3 passed · 1 failed · 4 total · ${HEAD}\n`,
      assertions: JSON.stringify({ pass: 3, fail: 1, total: 4 }),
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/carries no failures ledger/);
  });

  it('accepts an empty ledger on a clean round', () => {
    const result = check({
      assertions: JSON.stringify({ pass: 4, fail: 0, total: 4, failures: [] }),
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

// "Every production commit since the previous round was mutated on its own"
// shipped while two commits had no row. A coverage claim is universally
// quantified over an enumerable set, so it is checked against that set.
describe('checkMutationCoverage', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const C = 'c'.repeat(40);
  const matrix = (overrides = {}) =>
    JSON.stringify({
      coverageClaim: 'per-commit',
      productionCommits: [A, B, C],
      rows: [
        { id: 'M1', commit: A },
        { id: 'M2', commit: B },
        { id: 'M3', commit: C },
      ],
      ...overrides,
    });

  it('stays silent when the round makes no per-commit claim', () => {
    expect(checkMutationCoverage(null).errors).toEqual([]);
    expect(checkMutationCoverage('').errors).toEqual([]);
    expect(checkMutationCoverage('{"rows":[]}').errors).toEqual([]);
    expect(
      checkMutationCoverage(
        JSON.stringify({ coverageClaim: 'per-guard', rows: [] }),
      ).errors,
    ).toEqual([]);
  });

  it('accepts a claim every commit backs', () => {
    expect(checkMutationCoverage(matrix()).errors).toEqual([]);
  });

  // "Every commit was mutated" over no commits is vacuously true, and an
  // empty list is the cheapest enumeration to supply. It is also the one
  // incomplete list that satisfies the coverage check without this refusal.
  it('refuses a claim over an empty enumeration', () => {
    const result = checkMutationCoverage(
      matrix({ productionCommits: [], rows: [] }),
    );
    expect(result.errors.join('\n')).toMatch(
      /empty productionCommits list: a claim over an empty set is vacuously true/,
    );
    // The refusal has to recommend the recipe the skill actually teaches: the
    // one that cuts at the first parent drops the PR's own feature-merge
    // commits, which is the under-count this rule exists to prevent.
    expect(result.errors.join('\n')).toContain(
      'git log --no-merges <previous>..<head> --not <target>',
    );
    expect(result.errors.join('\n')).not.toContain('--first-parent');
    // Dropping the claim is the honest way out for a docs-only round.
    expect(
      checkMutationCoverage(JSON.stringify({ rows: [], productionCommits: [] }))
        .errors,
    ).toEqual([]);
  });

  it('names the commits that have no row', () => {
    const result = checkMutationCoverage(
      matrix({ rows: [{ id: 'M1', commit: A }] }),
    );
    expect(result.errors.join('\n')).toMatch(
      /2 of 3 production commits have no row/,
    );
    expect(result.errors.join('\n')).toContain(B);
    expect(result.errors.join('\n')).toContain(C);
  });

  it('matches abbreviated and full OIDs in either direction', () => {
    expect(
      checkMutationCoverage(
        matrix({
          productionCommits: [A.slice(0, 10)],
          rows: [{ id: 'M1', commit: A }],
        }),
      ).errors,
    ).toEqual([]);
    expect(
      checkMutationCoverage(
        matrix({
          productionCommits: [A],
          rows: [{ id: 'M1', commit: A.slice(0, 10) }],
        }),
      ).errors,
    ).toEqual([]);
  });

  it('refuses a claim with no enumeration, and a malformed matrix', () => {
    expect(
      checkMutationCoverage(
        matrix({ productionCommits: undefined }),
      ).errors.join('\n'),
    ).toMatch(/needs productionCommits\[\] from git log and rows\[\]/);
    expect(
      checkMutationCoverage(matrix({ rows: null })).errors.join('\n'),
    ).toMatch(/needs productionCommits\[\] from git log and rows\[\]/);
    expect(
      checkMutationCoverage(
        matrix({ productionCommits: ['zzzzzzz'] }),
      ).errors.join('\n'),
    ).toMatch(/must be hex commit ids/);
    expect(checkMutationCoverage('not json').errors).toContain(
      'mutations.json is not valid JSON',
    );
    expect(checkMutationCoverage('[]').errors).toContain(
      'mutations.json must be an object with rows',
    );
  });

  it('reaches the verdict through checkArtifacts, not just on its own', () => {
    const result = checkArtifacts({
      files: {
        ...validFiles(),
        mutations: matrix({ rows: [{ id: 'M1', commit: A }] }),
      },
      evidence: ['01-ab-cells.png'],
    });
    expect(result.errors.join('\n')).toMatch(/claims per-commit coverage but/);
  });
});

// The CLI is the path a maintainer runs, so the exit codes are the contract.
describe.skipIf(process.platform === 'win32')('check (CLI)', () => {
  const run = (dir) =>
    spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });

  it('exits 0 on a consistent round and 1 on a contradiction', () => {
    const ok = run(makeArtifactDir(validFiles(), ['01-ab-cells.png']));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(
      'ok: verdict=merge-ready (4 passed · 0 failed · 4 total)',
    );

    const bad = run(
      makeArtifactDir(
        validFiles({
          assertions: JSON.stringify({ pass: 3, fail: 1, total: 4 }),
        }),
      ),
    );
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('error merge-ready with 1 failed assertion');
    expect(bad.stdout).toContain('failed: verdict=merge-ready');
  });

  it('names the legacy snapshot when the round has none', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-pr-check-snapshot-'));
    tmpDirs.push(root);
    const artifacts = join(root, 'tmp', 'pr7-verify-20261026-120000');
    mkdirSync(join(artifacts, 'evidence'), { recursive: true });
    mkdirSync(join(root, 'tmp', 'verify-context'), { recursive: true });
    const head = 'e'.repeat(40);
    const base = 'f'.repeat(40);
    writeFileSync(
      join(root, 'tmp', 'verify-context', 'pr7.json'),
      JSON.stringify({ number: 7, headRefOid: head }),
    );
    writeFileSync(join(artifacts, 'verdict.txt'), 'merge-ready\n');
    writeFileSync(
      join(artifacts, 'assertions.json'),
      JSON.stringify({ pass: 1, fail: 0, total: 1 }),
    );
    writeFileSync(
      join(artifacts, 'report.md'),
      `merge-ready · 1 passed · 0 failed · 1 total · ${base}\n`,
    );

    const result = spawnSync(process.execPath, [SCRIPT, artifacts], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`does not name the verified head ${head}`);
    expect(result.stdout).toContain(
      join(root, 'tmp', 'verify-context', 'pr7.json'),
    );

    for (const snapshot of ['{', '{}']) {
      writeFileSync(join(artifacts, 'context.json'), snapshot);
      const unreadable = run(artifacts);
      expect(unreadable.status).toBe(0);
      expect(unreadable.stdout).toContain(join(artifacts, 'context.json'));
      expect(unreadable.stdout).toContain('fell back to presence-only');
      expect(unreadable.stdout).not.toContain(
        `does not name the verified head ${head}`,
      );
    }
  });

  it('exits 2 without a directory and 1 on a missing one', () => {
    expect(
      spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status,
    ).toBe(2);
    expect(run(join(tmpdir(), 'verify-pr-check-does-not-exist')).status).toBe(
      1,
    );
  });
});
