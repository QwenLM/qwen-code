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
  if (files.comment !== undefined) {
    writeFileSync(join(dir, 'comment.md'), files.comment);
  }
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

// Rounds folded whole workspace suites into their own counts: "7737 scripted
// assertions" held a few dozen checks the round wrote. Suite results have a
// field of their own, and the triple counts what the round wrote.
describe('gates', () => {
  const GATES_ERROR = /gates must be an array of \{ suite, pass, fail \}/;
  const withGates = (gates, counts = { pass: 4, fail: 0, total: 4 }) =>
    check({ assertions: JSON.stringify({ ...counts, gates }) });

  it("accepts suite counts beside the round's own", () => {
    const result = withGates([
      { suite: 'cli acp-session', pass: 1290, fail: 2, skipped: 1 },
      { suite: 'core client', pass: 535, fail: 0 },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.counts).toEqual({ pass: 4, fail: 0, total: 4 });
    // An empty list is a round that ran no suites: valid, and below the
    // size threshold it has nothing to warn about.
    const empty = withGates([]);
    expect(empty.errors).toEqual([]);
    expect(empty.warnings).toEqual([]);
  });

  it('refuses a malformed list without echoing the suite name', () => {
    for (const gates of [
      { cli: { pass: 1, fail: 0 } },
      [null],
      [{ pass: 1, fail: 0 }],
      [{ suite: '  ', pass: 1, fail: 0 }],
      [{ suite: 'x', pass: -1, fail: 0 }],
      [{ suite: 'x', pass: 1, fail: 0.5 }],
      [{ suite: 'x', pass: 1, fail: 0, skipped: '2' }],
      [{ suite: 'x', pass: 1, fail: 0, skipped: false }],
      [{ suite: 'x', pass: 1, fail: 0, skipped: null }],
      [{ suite: 'x', pass: '1', fail: 0 }],
    ]) {
      const result = withGates(gates);
      expect(result.errors.join('\n')).toMatch(GATES_ERROR);
    }
    // The publisher forwards error lines to its log; a suite name is
    // agent-chosen text.
    const named = withGates([
      { suite: '@everyone <!-- x -->', pass: -1, fail: 0 },
    ]);
    expect(named.errors.join('\n')).not.toContain('@everyone');
  });

  it('refuses counts beyond the safe integer range', () => {
    // Raw literals: JSON.stringify would turn 1e309 into null and hide the
    // overflow that the publisher's jq clamps to a finite double.
    const raw = (pass) =>
      check({
        assertions: `{"pass":4,"fail":0,"total":4,"gates":[{"suite":"x","pass":${pass},"fail":0}]}`,
      });
    for (const pass of ['1e309', '1e308', '9007199254740992']) {
      expect(raw(pass).errors.join('\n')).toMatch(GATES_ERROR);
    }
    expect(raw('9007199254740991').errors).toEqual([]);
  });

  it('warns when a suite-sized total comes with no gates', () => {
    const big = check({
      assertions: JSON.stringify({ pass: 1001, fail: 0, total: 1001 }),
    });
    expect(big.errors).toEqual([]);
    expect(big.warnings.join('\n')).toMatch(
      /counts 1001 assertions and records no gates/,
    );
    const edge = check({
      assertions: JSON.stringify({ pass: 1000, fail: 0, total: 1000 }),
    });
    expect(edge.warnings.join('\n')).not.toMatch(/records no gates/);
    const split = withGates([{ suite: 'cli', pass: 1292, fail: 0 }], {
      pass: 1001,
      fail: 0,
      total: 1001,
    });
    expect(split.warnings.join('\n')).not.toMatch(/records no gates/);
    // An empty list records no suites, so it must not silence the warning
    // either: folding suites in and writing [] is the same smell.
    const empty = withGates([], { pass: 1001, fail: 0, total: 1001 });
    expect(empty.errors).toEqual([]);
    expect(empty.warnings.join('\n')).toMatch(/records no gates/);
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

// Three rounds of PR #15984 opened with the title and the whole verdict
// paragraph merged into one `#` line. The Markdown is structurally valid;
// GitHub renders it as a single giant H1, a wall of bold text. The shape is
// a warning, not an error: a cosmetic defect must not make the CI publisher
// refuse an otherwise consistent verdict.
describe('verdict line shape', () => {
  const shippedLead = `# PR 15984 round 3 verification — **Verdict: merge-ready** — 63/63 scripted assertions passed, 0 failed. Verified head: \`${HEAD}\`.`;

  it('warns when the verdict paragraph is a heading, without failing the round', () => {
    const result = check({ report: `${shippedLead}\n` });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(
      /report\.md opens with a heading carrying the verdict/,
    );
  });

  it('accepts the same line as a plain paragraph', () => {
    const result = check({ report: `${shippedLead.slice(2)}\n` });
    expect(result.warnings).toEqual([]);
  });

  it('accepts a short title heading that carries no verdict', () => {
    const result = check({ report: `# Report\n\nmerge-ready · ${HEAD}\n` });
    expect(result.warnings.join('\n')).not.toMatch(/opens with a heading/);
  });

  it('warns on an over-long heading even without the verdict word', () => {
    const result = check({
      report: `# ${'t'.repeat(130)}\n\nmerge-ready · ${HEAD}\n`,
    });
    expect(result.warnings.join('\n')).toMatch(
      /opens with a heading of 132 characters/,
    );
  });

  it('keeps the shape verdicts under CRLF line endings', () => {
    const heading = check({ report: `${shippedLead}\r\n` });
    expect(heading.warnings.join('\n')).toMatch(
      /report\.md opens with a heading carrying the verdict/,
    );
    const plain = check({ report: `${shippedLead.slice(2)}\r\n` });
    expect(plain.warnings).toEqual([]);
  });

  // GFM renders an ATX heading indented up to three spaces as a heading
  // (verified against the GitHub markdown API); four spaces are a code
  // block. The indent must not be a way around the shape check.
  it('warns on a verdict heading indented up to three spaces', () => {
    for (const indent of [' ', '  ', '   ']) {
      const result = check({ report: `${indent}${shippedLead}\n` });
      expect(result.warnings.join('\n')).toMatch(
        /report\.md opens with a heading carrying the verdict/,
      );
    }
    const codeBlock = check({ report: `    ${shippedLead}\n` });
    expect(codeBlock.warnings.join('\n')).not.toMatch(/opens with a heading/);
  });
});

// report.md deliberately carries no footer — both publish paths append it at
// comment time — so the footer is checkable only on comment.md, the exact
// body a local round posts. All three PR #15984 rounds shipped without it.
describe('comment.md footer', () => {
  const footer =
    '_— test-model via Qwen Code /verify-pr (v0.1.2; skill 0123456789ab)_';
  const body = `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n`;

  it('accepts a body ending in the resolved footer', () => {
    const result = check({ comment: `${body}\n${footer}\n` });
    expect(result.warnings).toEqual([]);
  });

  // PR #16002 review: a Windows-authored comment.md with CRLF line endings
  // failed the anchored footer regex on the stray \r, and the local publish
  // gate sent a valid artifact back for unnecessary repair. GitHub renders
  // CRLF and LF identically; the checker has to agree.
  it('accepts the same footer with CRLF line endings (LF/CRLF parity)', () => {
    const lf = check({ comment: `${body}\n${footer}\n` });
    const crlf = check({
      comment: `${body}\n${footer}\n`.replace(/\n/g, '\r\n'),
    });
    expect(lf.warnings).toEqual([]);
    expect(crlf.warnings).toEqual([]);
  });

  it('still flags a missing footer and a heading lead under CRLF', () => {
    const missing = check({ comment: body.replace(/\n/g, '\r\n') });
    expect(missing.warnings.join('\n')).toMatch(
      /does not end with the attribution footer/,
    );
    const heading = check({
      comment: `# PR 15984 round 3 verification — **Verdict: merge-ready** — ${HEAD}\r\n\r\n${footer}\r\n`,
    });
    expect(heading.warnings.join('\n')).toMatch(
      /comment\.md opens with a heading carrying the verdict/,
    );
  });

  it('warns when the footer is missing', () => {
    const result = check({ comment: body });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(
      /comment\.md does not end with the attribution footer/,
    );
  });

  it('warns on a malformed footer', () => {
    for (const bad of [
      '_— test-model via Qwen Code /verify-pr (v0.1.2; skill xyz)_',
      '_— test-model via Qwen Code /verify-pr (0.1.2; skill 0123456789ab)_',
      '— test-model via Qwen Code /verify-pr (v0.1.2; skill 0123456789ab)',
    ]) {
      const result = check({ comment: `${body}\n${bad}\n` });
      expect(result.warnings.join('\n')).toMatch(
        /does not end with the attribution footer/,
      );
    }
  });

  it('checks the lead shape on the posted body too', () => {
    const result = check({
      comment: `# PR 15984 round 3 verification — **Verdict: merge-ready** — ${HEAD}\n\n${footer}\n`,
    });
    expect(result.warnings.join('\n')).toMatch(
      /comment\.md opens with a heading carrying the verdict/,
    );
  });

  it('stays silent when the round has no comment.md, which the workflow never writes', () => {
    expect(check({}).warnings).toEqual([]);
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

  // The CI publisher parses the last stdout line; shape and footer warnings
  // must stay above it and keep the exit code at 0.
  it('warns without failing when comment.md lacks the footer', () => {
    const dir = makeArtifactDir(
      validFiles({ comment: `merge-ready · ${HEAD}\n` }),
      ['01-ab-cells.png'],
    );
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'warn  comment.md does not end with the attribution footer',
    );
    expect(result.stdout).toContain(
      'ok: verdict=merge-ready (4 passed · 0 failed · 4 total)',
    );
  });

  // The reviewer's CLI probe: the same valid footer, only the line endings
  // changed to CRLF, must not produce the footer warning.
  it('accepts a CRLF comment.md with a valid footer end to end', () => {
    const dir = makeArtifactDir(
      validFiles({
        comment: `merge-ready · ${HEAD}\r\n\r\n_— test-model via Qwen Code /verify-pr (v0.26.4; skill 0123456789ab)_\r\n`,
      }),
      ['01-ab-cells.png'],
    );
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(
      'does not end with the attribution footer',
    );
    expect(result.stdout).toContain(
      'ok: verdict=merge-ready (4 passed · 0 failed · 4 total)',
    );
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
