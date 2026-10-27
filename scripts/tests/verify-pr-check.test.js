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
import { checkArtifacts } from '../../scripts/verify-pr-check.mjs';

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

  it('reads the verified head from the round snapshot', () => {
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
