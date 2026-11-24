/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkArtifacts,
  checkBoundary,
  checkExecutionRecord,
  checkMutationCoverage,
  checkTrustClassification,
  containerNonceErrors,
  executionApprovalErrors,
  isFilesystemRoot,
} from '../../scripts/verify-pr-check.mjs';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-check.mjs', import.meta.url),
);
const HEAD = 'b'.repeat(40);

// The container-local nonce plaintext and its hash. The gate record carries
// only the hash (R16-1); a round log must echo a container-nonce line whose
// value hashes to it for the checker to accept mode:"container".
const NONCE = '0123456789abcdef0123456789abcdef';
const NONCE_SHA256 = createHash('sha256').update(NONCE).digest('hex');
const GATE_RECORD = JSON.stringify({
  gate: 'require-isolation',
  passed: true,
  at: '2026-11-14T02:00:00.000Z',
  signals: ['container=qwen-verify', '/.dockerenv'],
  observed: ['/.dockerenv'],
  credentialFree: true,
  nonceSha256: NONCE_SHA256,
});
const APPROVAL =
  'https://github.com/QwenLM/qwen-code/pull/17185#issuecomment-1234567890';

function commentApproval(overrides = {}) {
  return {
    mode: 'waived',
    source: 'comment',
    by: 'maintainer',
    basis: 'maintainer-comment',
    permission: 'admin',
    approval: APPROVAL,
    comment: {
      id: 1234567890,
      bodySha256: 'a'.repeat(64),
    },
    head: HEAD,
    round: 1,
    registrationNonce: 'a2a2a24d-91c8-4c4b-9f87-2f62968a105a',
    reason: 'Java battery needs the host JDK',
    ...overrides,
  };
}

function localTrustApproval(overrides = {}) {
  return {
    mode: 'waived',
    source: 'local-trust',
    by: 'maintainer',
    basis: 'own-pr',
    permission: 'admin',
    head: HEAD,
    round: 1,
    reason: 'why',
    ...overrides,
  };
}

function validFiles(overrides = {}) {
  return {
    report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n# Report\n\n## Methodology\n\n**Boundary.** node:22-bookworm, --network none, credential-free.\n`,
    verdict: 'merge-ready\n',
    assertions: JSON.stringify({ pass: 4, fail: 0, total: 4 }),
    boundary: JSON.stringify({
      mode: 'container',
      detail: 'node:22-bookworm, --network none, credential-free',
    }),
    boundaryGate: GATE_RECORD,
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
  if (files.boundary !== undefined) {
    writeFileSync(join(dir, 'boundary.json'), files.boundary);
  }
  if (files.boundaryGate !== undefined) {
    writeFileSync(join(dir, 'boundary-gate.json'), files.boundaryGate);
    // The battery echoes the container-local nonce into its logs (R16-1).
    writeFileSync(join(dir, 'harness.log'), `container-nonce: ${NONCE}\n`);
  }
  if (evidence.length > 0) {
    mkdirSync(join(dir, 'evidence'));
    for (const name of evidence) {
      writeFileSync(join(dir, 'evidence', name), 'png');
    }
  }
  return dir;
}

function prepareArtifactWitness(dir, snapshot, root = null) {
  const pr = snapshot.pr ?? snapshot.number;
  const name = `pr${pr}-verify-20261123-000000`;
  const context = JSON.stringify({
    repo: snapshot.repo,
    pr,
    baseRefOid: snapshot.baseRefOid ?? '0'.repeat(40),
    headRefOid: snapshot.headRefOid,
  });
  if (
    root &&
    dirname(dirname(dir)) === root &&
    basename(dir).startsWith(`pr${pr}-verify-`)
  ) {
    writeFileSync(join(dir, 'context.json'), context);
    return { dir, clone: root };
  }
  const clone = mkdtempSync(join(tmpdir(), 'verify-pr-prepared-host-'));
  tmpDirs.push(clone);
  const prepared = join(clone, 'tmp', name);
  mkdirSync(dirname(prepared), { recursive: true });
  cpSync(dir, prepared, { recursive: true });
  writeFileSync(join(prepared, 'context.json'), context);
  return { dir: prepared, clone };
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

  it('calls a suite blank only when it is JSON whitespace', () => {
    // The publisher's jq tests the same class. trim() also calls U+FEFF
    // blank and jq's \S calls U+0085 blank, so with either one here the
    // checker would refuse a suite the publisher renders.
    expect(
      withGates([{ suite: ' \t\n\r', pass: 1, fail: 0 }]).errors.join('\n'),
    ).toMatch(GATES_ERROR);
    for (const suite of ['\u0085', '\ufeff']) {
      expect(withGates([{ suite, pass: 1, fail: 0 }]).errors).toEqual([]);
    }
  });

  it('warns when a suite-sized total comes with no gate results', () => {
    const big = check({
      assertions: JSON.stringify({ pass: 1001, fail: 0, total: 1001 }),
    });
    expect(big.errors).toEqual([]);
    expect(big.warnings.join('\n')).toMatch(
      /counts 1001 assertions and records no gate results/,
    );
    const edge = check({
      assertions: JSON.stringify({ pass: 1000, fail: 0, total: 1000 }),
    });
    expect(edge.warnings.join('\n')).not.toMatch(/records no gate results/);
    const split = withGates([{ suite: 'cli', pass: 1292, fail: 0 }], {
      pass: 1001,
      fail: 0,
      total: 1001,
    });
    expect(split.warnings.join('\n')).not.toMatch(/records no gate results/);
    // An empty list records no suites, so it must not silence the warning
    // either: folding suites in and writing [] is the same smell.
    const empty = withGates([], { pass: 1001, fail: 0, total: 1001 });
    expect(empty.errors).toEqual([]);
    expect(empty.warnings.join('\n')).toMatch(/records no gate results/);
    // Nor do entries that count nothing: a placeholder suite moved no test
    // out of the counts. Skipped tests are not results either.
    for (const gate of [
      { suite: 'placeholder', pass: 0, fail: 0 },
      { suite: 'cli', pass: 0, fail: 0, skipped: 12 },
    ]) {
      const hollow = withGates([gate], { pass: 1001, fail: 0, total: 1001 });
      expect(hollow.errors).toEqual([]);
      expect(hollow.warnings.join('\n')).toMatch(/records no gate results/);
    }
    const allRed = withGates([{ suite: 'cli', pass: 0, fail: 3 }], {
      pass: 1001,
      fail: 0,
      total: 1001,
    });
    expect(allRed.warnings.join('\n')).not.toMatch(/records no gate results/);
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

// Two local rounds on PR #16866 executed the whole battery on the
// maintainer's host with no isolation gate, no waiver, and no boundary line
// in the report: the isolation rule existed only as prose. The declaration
// is the artifact that makes a host round a visible exception.
describe('checkBoundary', () => {
  it('accepts a container declaration backed by a gate record', () => {
    expect(
      checkBoundary(
        JSON.stringify({ mode: 'container', detail: 'node:22-bookworm' }),
        GATE_RECORD,
      ).errors,
    ).toEqual([]);
  });

  // R10-20: a gate record whose only marker is a self-chosen container=
  // string carries no observed boundary, so it cannot back a container claim.
  it('refuses a declared-only record with the prepare-first recovery', () => {
    const declaredOnly = JSON.stringify({
      gate: 'require-isolation',
      passed: true,
      signals: ['container=my-laptop'],
      observed: [],
      credentialFree: true,
    });
    expect(
      checkBoundary(
        JSON.stringify({ mode: 'container', detail: 'my-laptop' }),
        declaredOnly,
      ).errors,
    ).toEqual([
      'boundary-gate.json records no observed boundary marker (/.dockerenv or /run/.containerenv): a declared container= string alone is not an observed boundary; for host/VM execution keep the delivered head/round registration, choose --execution host|vm explicitly, and rerun prepare with its approved approval arguments BEFORE the battery; never hand-write the declaration',
    ]);
    // A record with no observed field at all is refused too.
    expect(
      checkBoundary(
        JSON.stringify({ mode: 'container', detail: 'x' }),
        JSON.stringify({ gate: 'require-isolation', passed: true }),
      ).errors.join('\n'),
    ).toMatch(/no observed boundary marker/);
  });

  // R10-20: an attested VM uses its own mode behind the same maintainer
  // approval the waiver requires, plus an attestation of what was confirmed.
  it('accepts a vm declaration with approval and attestation', () => {
    expect(
      checkBoundary(
        JSON.stringify({
          mode: 'vm',
          by: 'maintainer',
          approval: APPROVAL,
          attestation: 'nothing mounted, no host credentials',
          reason: 'Java battery needs a VM',
        }),
      ).errors,
    ).toEqual([]);
  });

  it('refuses a vm declaration missing attestation or approval', () => {
    expect(
      checkBoundary(
        JSON.stringify({
          mode: 'vm',
          by: 'maintainer',
          approval: APPROVAL,
          reason: 'why',
        }),
      ).errors.join('\n'),
    ).toMatch(/mode vm needs a non-empty attestation/);
    expect(
      checkBoundary(
        JSON.stringify({
          mode: 'vm',
          by: 'maintainer',
          attestation: 'nothing mounted',
          reason: 'why',
        }),
      ).errors.join('\n'),
    ).toMatch(/mode vm needs approval/);
  });

  // The declaration is a value the round can mint for itself; the gate
  // record ties it to a gate run. Without one, container mode is refused.
  it('refuses a container declaration with no gate record', () => {
    expect(
      checkBoundary(
        JSON.stringify({ mode: 'container', detail: 'node:22-bookworm' }),
      ).errors.join('\n'),
    ).toMatch(/boundary-gate\.json is missing/);
    for (const gate of [
      '{',
      '[]',
      JSON.stringify({ gate: 'other', passed: true }),
      JSON.stringify({ gate: 'require-isolation', passed: false }),
    ]) {
      expect(
        checkBoundary(
          JSON.stringify({ mode: 'container', detail: 'node:22-bookworm' }),
          gate,
        ).errors.join('\n'),
      ).toMatch(/boundary-gate\.json/);
    }
  });

  it('accepts the CI lane gate record only under the publish invocation', () => {
    expect(
      checkBoundary(
        JSON.stringify({ mode: 'container', detail: 'CI verify lane' }),
        JSON.stringify({ gate: 'ci-lane', passed: true }),
        { publishLane: true },
      ).errors,
    ).toEqual([]);
    // A local round cannot claim the lane by writing the record itself.
    expect(
      checkBoundary(
        JSON.stringify({ mode: 'container', detail: 'CI verify lane' }),
        JSON.stringify({ gate: 'ci-lane', passed: true }),
      ).errors.join('\n'),
    ).toMatch(/does not record a passed isolation gate/);
  });

  it('accepts a waiver naming the maintainer, the approval and the reason', () => {
    expect(
      checkBoundary(
        JSON.stringify({
          mode: 'waived',
          by: 'maintainer',
          approval: APPROVAL,
          reason: 'Java battery needs the host JDK; approved in words',
        }),
      ).errors,
    ).toEqual([]);
  });

  it('refuses a waiver without a verifiable approval permalink', () => {
    for (const approval of [
      undefined,
      '',
      'approved in words',
      'https://github.com/QwenLM/qwen-code/pull/17185',
    ]) {
      expect(
        checkBoundary(
          JSON.stringify({
            mode: 'waived',
            by: 'maintainer',
            approval,
            reason: 'why',
          }),
        ).errors.join('\n'),
      ).toMatch(/mode waived needs approval/);
    }
  });

  // A git identity `Name <email>` is a filled-in value, not a placeholder.
  it('accepts a maintainer written as a git identity', () => {
    expect(
      checkBoundary(
        JSON.stringify({
          mode: 'waived',
          by: 'Wenshao <wenshao@example.com>',
          approval: APPROVAL,
          reason: 'why',
        }),
      ).errors,
    ).toEqual([]);
  });

  it.each([null, undefined, '', '   '])(
    'refuses a round without a declaration (%s)',
    (text) => {
      expect(checkBoundary(text).errors.join('\n')).toMatch(
        /boundary\.json is missing/,
      );
    },
  );

  it('refuses malformed JSON and non-object shapes', () => {
    expect(checkBoundary('{').errors).toContain(
      'boundary.json is not valid JSON',
    );
    for (const text of ['null', '[]', '"container"']) {
      expect(checkBoundary(text).errors).toContain(
        'boundary.json must be an object with a mode',
      );
    }
  });

  it('refuses an unknown mode', () => {
    expect(
      checkBoundary(JSON.stringify({ mode: 'host' })).errors.join('\n'),
    ).toMatch(/mode must be one of container \| microvm \| vm \| waived/);
  });

  it('refuses a container declaration without a detail', () => {
    for (const detail of [undefined, '', '  ', 42]) {
      expect(
        checkBoundary(
          JSON.stringify({ mode: 'container', detail }),
        ).errors.join('\n'),
      ).toMatch(/mode container needs a non-empty detail/);
    }
  });

  it('refuses a waiver missing the approver or the reason', () => {
    for (const waiver of [
      { mode: 'waived' },
      { mode: 'waived', by: 'maintainer' },
      { mode: 'waived', reason: 'why' },
      { mode: 'waived', by: ' ', reason: 'why' },
      { mode: 'waived', by: 'maintainer', reason: '' },
    ]) {
      expect(checkBoundary(JSON.stringify(waiver)).errors.join('\n')).toMatch(
        /mode waived needs non-empty by .* and reason/,
      );
    }
  });

  it('reaches the verdict through checkArtifacts, not just on its own', () => {
    const result = checkArtifacts({
      files: validFiles({ boundary: null }),
      evidence: ['01-ab-cells.png'],
    });
    expect(result.errors.join('\n')).toMatch(/boundary\.json is missing/);
  });

  // On the CI entry path the publish job writes the declaration after the
  // round finishes; a base-pinned skill still tells the round to self-check
  // before finishing, and that check must not see an error it cannot clear.
  it('warns instead of erroring when the publisher owns the declaration', () => {
    const result = checkArtifacts({
      files: validFiles({ boundary: null }),
      evidence: ['01-ab-cells.png'],
      publisherOwnsBoundary: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/CI entry path/);
  });

  it('still refuses a malformed declaration when the publisher owns it', () => {
    const result = checkArtifacts({
      files: validFiles({ boundary: '{' }),
      evidence: ['01-ab-cells.png'],
      publisherOwnsBoundary: true,
    });
    expect(result.errors.join('\n')).toMatch(/not valid JSON/);
  });

  // A declaration copied from the skill's template without filling it in
  // declares nothing; the <placeholder> shape is the tell.
  it('refuses unfilled template placeholders in either mode', () => {
    expect(
      checkBoundary(
        JSON.stringify({
          mode: 'container',
          detail: '<image, network policy, credential-free mount>',
        }),
      ).errors.join('\n'),
    ).toMatch(/detail still carries a <placeholder>/);
    expect(
      checkBoundary(
        JSON.stringify({
          mode: 'waived',
          by: '<maintainer>',
          reason: 'approved in words',
        }),
      ).errors.join('\n'),
    ).toMatch(/waived declaration still carries a <placeholder>/);
    expect(
      checkBoundary(
        JSON.stringify({
          mode: 'waived',
          by: 'shaojin.wensj',
          reason: '<why this round may run outside a boundary>',
        }),
      ).errors.join('\n'),
    ).toMatch(/waived declaration still carries a <placeholder>/);
  });
});

describe('boundary line in the report', () => {
  it('warns when there is no Methodology section', () => {
    const result = check({
      report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n# Report\n`,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/has no Methodology section/);
  });

  it('warns when the Methodology does not open with the Boundary line', () => {
    const result = check({
      report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n## Methodology\n\nWe ran the battery.\n`,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(
      /first line after the Methodology opening must be the \*\*Boundary\.\*\* line/,
    );
  });

  // A prose mention of the rule is not a declaration: the token search
  // this replaces passed a report that discussed the requirement while
  // reporting nothing about where the PR code ran.
  it('warns when the Boundary token appears only in prose', () => {
    const result = check({
      report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n## Methodology\n\nThe skill requires a **Boundary.** line; see the rule.\n`,
    });
    expect(result.warnings.join('\n')).toMatch(
      /first line after the Methodology opening must be the \*\*Boundary\.\*\* line/,
    );
  });

  it('stays quiet when the Boundary line opens the Methodology', () => {
    expect(check({}).warnings).toEqual([]);
  });

  // The skill's report structure prescribes the numbered bold label, not
  // an H2; a compliant report must not draw a permanent false warning.
  it('accepts the numbered **Methodology** label with a Boundary line', () => {
    const result = check({
      report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n8. **Methodology** — one paragraph.\n\n**Boundary.** node:22-bookworm, --network none.\n`,
    });
    expect(result.warnings).toEqual([]);
  });

  it('accepts the Boundary line on the numbered label line itself', () => {
    const result = check({
      report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n8. **Methodology** — **Boundary.** node:22-bookworm, --network none. The round ran the battery.\n`,
    });
    expect(result.warnings).toEqual([]);
  });

  it('warns when the label line only mentions the Boundary rule in prose', () => {
    const result = check({
      report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n8. **Methodology** — we discuss the **Boundary.** rule here.\n`,
    });
    expect(result.warnings.join('\n')).toMatch(
      /first line after the Methodology opening must be the \*\*Boundary\.\*\* line/,
    );
  });

  it('warns when the numbered label has no Boundary line after it', () => {
    const result = check({
      report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n8. **Methodology** — one paragraph.\n\nWe ran the battery.\n`,
    });
    expect(result.warnings.join('\n')).toMatch(
      /first line after the Methodology opening must be the \*\*Boundary\.\*\* line/,
    );
  });

  // The posted body is what the maintainer reads: the same disclosure
  // rule applies to comment.md, not only report.md.
  it('warns when the posted body has no Methodology section', () => {
    const result = check({
      comment: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n_— test-model via Qwen Code /verify-pr (v0.1.2; skill 0123456789ab)_\n`,
    });
    expect(result.warnings.join('\n')).toMatch(
      /comment\.md has no Methodology section/,
    );
  });

  it('stays quiet when the posted body opens its Methodology with Boundary', () => {
    const result = check({
      comment: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n## Methodology\n\n**Boundary.** node:22-bookworm, --network none.\n\n_— test-model via Qwen Code /verify-pr (v0.1.2; skill 0123456789ab)_\n`,
    });
    expect(result.warnings).toEqual([]);
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
    const result = check({
      report: `${shippedLead.slice(2)}\n\n## Methodology\n\n**Boundary.** test boundary.\n`,
    });
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
    const plain = check({
      report: `${shippedLead.slice(2)}\r\n\r\n## Methodology\r\n\r\n**Boundary.** test boundary.\r\n`,
    });
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
  const body = `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n## Methodology\n\n**Boundary.** test boundary.\n`;

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
  // Hermetic: the skill's own container recipe sets QWEN_VERIFY_CONTEXT,
  // which flips the boundary rule to the publisher-owned warning path —
  // inheriting it would red these local-semantics tests in that boundary.
  const run = (dir) =>
    spawnSync(process.execPath, [SCRIPT, dir], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
    });
  const hostFile = (name, text) => {
    const root = mkdtempSync(join(tmpdir(), 'verify-pr-check-host-'));
    tmpDirs.push(root);
    const path = join(root, name);
    writeFileSync(path, text);
    return path;
  };

  it('downgrades an absent declaration to a warning under QWEN_VERIFY_CONTEXT', () => {
    const dir = makeArtifactDir(validFiles({ boundary: undefined }), [
      '01-ab-cells.png',
    ]);
    const ci = spawnSync(process.execPath, [SCRIPT, dir], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_VERIFY_CONTEXT: '/verify-context/pr.json' },
    });
    expect(ci.status).toBe(0);
    expect(ci.stdout).toMatch(/warn.*CI entry path/);
    const local = spawnSync(process.execPath, [SCRIPT, dir], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
    });
    expect(local.status).toBe(1);
    expect(local.stdout).toMatch(/boundary\.json is missing/);
  });

  // A whitespace-only declaration is absent for the publisher-owned
  // downgrade too: the trim() that keeps the two paths agreeing is load-
  // bearing, not cosmetic.
  it('downgrades a whitespace-only declaration on the CI entry path', () => {
    const dir = makeArtifactDir(validFiles({ boundary: '   ' }), [
      '01-ab-cells.png',
    ]);
    const ci = spawnSync(process.execPath, [SCRIPT, dir], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_VERIFY_CONTEXT: '/verify-context/pr.json' },
    });
    expect(ci.status).toBe(0);
    expect(ci.stdout).toMatch(/warn.*CI entry path/);
  });

  // A host round cannot claim the CI lane by writing the record itself:
  // only the publish job's --publish-lane invocation honors ci-lane.
  it('refuses a self-minted ci-lane record locally, accepts it under --publish-lane', () => {
    const dir = makeArtifactDir(
      validFiles({
        boundaryGate: JSON.stringify({ gate: 'ci-lane', passed: true }),
      }),
      ['01-ab-cells.png'],
    );
    const local = run(dir);
    expect(local.status).toBe(1);
    expect(local.stdout).toMatch(/does not record a passed isolation gate/);
    const publish = spawnSync(
      process.execPath,
      [SCRIPT, '--publish-lane', dir],
      { encoding: 'utf8', env: { ...process.env, QWEN_VERIFY_CONTEXT: '' } },
    );
    expect(publish.status).toBe(0);
    expect(publish.stdout).toContain(
      'ok: verdict=merge-ready (4 passed · 0 failed · 4 total)',
    );
  });

  // The artifact directory is writable by the PR code the round executed:
  // a directory in place of an artifact must degrade to a clean refusal,
  // not crash with EISDIR before any check runs — and an unreadable
  // artifact is reported as unreadable, not silently treated as absent.
  it('refuses a directory in place of boundary.json instead of crashing', () => {
    const dir = makeArtifactDir(validFiles({ boundary: undefined }), [
      '01-ab-cells.png',
    ]);
    mkdirSync(join(dir, 'boundary.json'));
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/boundary\.json is unreadable/);
    expect(result.stderr).not.toMatch(/EISDIR/);
  });

  it('refuses a directory in place of report.md instead of crashing', () => {
    const dir = makeArtifactDir(validFiles(), ['01-ab-cells.png']);
    unlinkSync(join(dir, 'report.md'));
    mkdirSync(join(dir, 'report.md'));
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/report\.md is unreadable/);
    expect(result.stderr).not.toMatch(/EISDIR/);
  });

  // A damaged optional artifact must not silently drop its check: an
  // unreadable mutations.json is an error, not a free pass.
  it('refuses an unreadable mutations.json instead of dropping its check', () => {
    const dir = makeArtifactDir(validFiles(), ['01-ab-cells.png']);
    // A directory at the reserved name is unreadable; the file's content
    // is irrelevant to this case, so plant the directory directly.
    mkdirSync(join(dir, 'mutations.json'));
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/mutations\.json is unreadable/);
  });

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
      join(artifacts, 'boundary.json'),
      JSON.stringify({ mode: 'container', detail: 'test boundary' }),
    );
    writeFileSync(join(artifacts, 'boundary-gate.json'), GATE_RECORD);
    writeFileSync(
      join(artifacts, 'harness.log'),
      `container-nonce: ${NONCE}\n`,
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

  // The artifact directory is writable by the PR code the round just ran, so
  // its own context.json cannot pin the head. --context reads a copy the round
  // never saw and must not fall back to the writable one.
  it('pins the head from a host-held snapshot over the artifact copy', () => {
    const dir = makeArtifactDir(validFiles(), ['01-ab-cells.png']);
    writeFileSync(
      join(dir, 'context.json'),
      JSON.stringify({ headRefOid: 'e'.repeat(40) }),
    );
    const hostSnapshot = join(tmpdir(), `verify-pr-host-${Date.now()}.json`);
    tmpDirs.push(hostSnapshot);
    writeFileSync(hostSnapshot, JSON.stringify({ headRefOid: HEAD }));

    const pinned = spawnSync(
      process.execPath,
      [SCRIPT, '--context', hostSnapshot, dir],
      { encoding: 'utf8' },
    );
    expect(pinned.status).toBe(0);
    expect(pinned.stdout).toContain(`head source: ${hostSnapshot}`);
    expect(pinned.stdout).not.toContain('does not name the verified head');

    const artifactOnly = run(dir);
    expect(artifactOnly.status).toBe(0);
    expect(artifactOnly.stdout).toContain('does not name the verified head');
  });

  it('refuses an unusable --context instead of falling back', () => {
    const dir = makeArtifactDir(validFiles(), ['01-ab-cells.png']);
    // Seed a usable writable copy: a fallback regression would exit 0 here
    // and print its head source, so the exit-1 assertion pins the property.
    writeFileSync(
      join(dir, 'context.json'),
      JSON.stringify({ headRefOid: HEAD }),
    );
    const empty = join(tmpdir(), `verify-pr-host-empty-${Date.now()}.json`);
    tmpDirs.push(empty);
    writeFileSync(empty, '{}');
    for (const snapshot of [join(tmpdir(), 'verify-pr-no-such.json'), empty]) {
      const result = spawnSync(
        process.execPath,
        [SCRIPT, '--context', snapshot, dir],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--context');
      expect(result.stdout).not.toContain('head source:');
    }
  });

  it('exits 2 for an unknown option or a missing --context value', () => {
    const dir = makeArtifactDir(validFiles(), ['01-ab-cells.png']);
    expect(
      spawnSync(process.execPath, [SCRIPT, '--bogus', dir], {
        encoding: 'utf8',
      }).status,
    ).toBe(2);
    expect(
      spawnSync(process.execPath, [SCRIPT, '--context'], {
        encoding: 'utf8',
      }).status,
    ).toBe(2);
    // A forgotten --context turns the snapshot into a second positional:
    // refuse instead of silently using the artifact's writable copy.
    const hostSnapshot = join(tmpdir(), `verify-pr-host-${Date.now()}.json`);
    tmpDirs.push(hostSnapshot);
    writeFileSync(hostSnapshot, JSON.stringify({ headRefOid: HEAD }));
    expect(
      spawnSync(process.execPath, [SCRIPT, dir, hostSnapshot], {
        encoding: 'utf8',
      }).status,
    ).toBe(2);
  });

  // A PR-writable path named evidence may be a regular file: the read
  // must degrade to the documented refusal, not crash out of the CLI.
  it('refuses a regular file in place of evidence/ instead of crashing', () => {
    const dir = makeArtifactDir(validFiles());
    writeFileSync(join(dir, 'evidence'), 'not a directory');
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/evidence\/ is unreadable/);
    expect(result.stderr).not.toMatch(/ENOTDIR/);
    // The empty-evidence warning must not also fire: the directory is
    // unreadable, not empty.
    expect(result.stdout).not.toMatch(/holds no PNG capture/);
  });

  // The waiver's approval permalink must cite this round's PR when the
  // snapshot carries the coordinates — any owner/repo/number is not enough.
  it('checks the approval permalink against the round coordinates', () => {
    const waiver = (approval) =>
      validFiles({
        boundary: JSON.stringify({
          mode: 'waived',
          by: 'maintainer',
          approval,
          reason: 'Java battery needs the host JDK',
        }),
        report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n## Methodology\n\n**Boundary.** host, maintainer-approved waiver for the Java battery.\n`,
      });
    const dir = makeArtifactDir(
      waiver('https://github.com/torvalds/linux/issues/1#issuecomment-1'),
      ['01-ab-cells.png'],
    );
    // The coordinates must come from the HOST-HELD snapshot passed as
    // --context — the invocation the skill's step 7 prescribes.
    const hostSnapshot = join(tmpdir(), `verify-pr-coords-${Date.now()}.json`);
    tmpDirs.push(hostSnapshot);
    writeFileSync(
      hostSnapshot,
      JSON.stringify({ repo: 'QwenLM/qwen-code', pr: 17185, headRefOid: HEAD }),
    );
    const withContext = (snapshot) =>
      spawnSync(process.execPath, [SCRIPT, '--context', snapshot, dir], {
        encoding: 'utf8',
        env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
      });
    const foreign = withContext(hostSnapshot);
    expect(foreign.status).toBe(1);
    expect(foreign.stdout).toMatch(
      /approval permalink cites torvalds\/linux#1, not this round's QwenLM\/qwen-code#17185/,
    );
    // The matching permalink passes only against prepare's host-held approval
    // and its digest, not against the approval-shaped artifact alone.
    const approval = commentApproval();
    writeFileSync(join(dir, 'boundary.json'), JSON.stringify(approval));
    const trustedText = JSON.stringify({
      repo: 'QwenLM/qwen-code',
      pr: 17185,
      headRefOid: HEAD,
      executionApproval: approval,
    });
    writeFileSync(hostSnapshot, trustedText);
    const prepared = prepareArtifactWitness(dir, JSON.parse(trustedText));
    const matching = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '--context',
        hostSnapshot,
        '--context-root',
        prepared.clone,
        '--context-sha256',
        createHash('sha256').update(trustedText).digest('hex'),
        prepared.dir,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
      },
    );
    expect(matching.status).toBe(0);
    expect(matching.stdout).toContain('ok: verdict=merge-ready');
  });

  it.each([{ source: 'comment' }, { source: 'local-trust' }])(
    'binds a $source host approval to the actual PR directory across same-head branches',
    ({ source }) => {
      const approval =
        source === 'comment'
          ? commentApproval({
              approval:
                'https://github.com/QwenLM/qwen-code/pull/42#issuecomment-1234567890',
            })
          : localTrustApproval();
      const setup = (
        directoryPr,
        artifactContext,
        artifactRepo = 'QwenLM/qwen-code',
      ) => {
        const base = mkdtempSync(join(tmpdir(), 'verify-pr-known-pr-'));
        tmpDirs.push(base);
        const clone = join(base, 'clone');
        const dir = join(
          clone,
          'tmp',
          `pr${directoryPr}-verify-20261123-000000`,
        );
        mkdirSync(join(dir, 'evidence'), { recursive: true });
        writeFileSync(
          join(dir, 'report.md'),
          `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n## Methodology\n\n**Boundary.** host, maintainer-approved waiver.\n`,
        );
        writeFileSync(join(dir, 'verdict.txt'), 'merge-ready\n');
        writeFileSync(
          join(dir, 'assertions.json'),
          JSON.stringify({ pass: 4, fail: 0, total: 4 }),
        );
        writeFileSync(join(dir, 'boundary.json'), JSON.stringify(approval));
        writeFileSync(join(dir, 'evidence', '01-ab.png'), 'png');
        if (artifactContext) {
          writeFileSync(
            join(dir, 'context.json'),
            JSON.stringify({
              repo: artifactRepo,
              pr: directoryPr,
              baseRefName: 'main',
              headRefName: 'shared-branch',
              headRefOid: HEAD,
            }),
          );
        }
        const trustedText = JSON.stringify({
          repo: 'QwenLM/qwen-code',
          pr: 42,
          baseRefName: 'main',
          headRefName: 'shared-branch',
          headRefOid: HEAD,
          author: { login: 'maintainer' },
          isCrossRepository: true,
          executionApproval: approval,
        });
        const host = join(base, 'host.json');
        writeFileSync(host, trustedText);
        return { clone, dir, host, trustedText };
      };
      const check = ({ clone, dir, host, trustedText }) =>
        spawnSync(
          process.execPath,
          [
            SCRIPT,
            '--context',
            host,
            '--context-root',
            clone,
            '--context-sha256',
            createHash('sha256').update(trustedText).digest('hex'),
            dir,
          ],
          {
            encoding: 'utf8',
            env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
          },
        );

      const control = check(setup(42, true));
      expect(control.status, control.stdout).toBe(0);
      const missingContext = check(setup(42, false));
      expect(missingContext.status, missingContext.stdout).toBe(1);
      expect(missingContext.stdout).toContain(
        'artifact context.json must provide the same repo and PR coordinates',
      );
      const coordinateFree = setup(42, true);
      writeFileSync(join(coordinateFree.dir, 'context.json'), '{}');
      const noCoordinates = check(coordinateFree);
      expect(noCoordinates.status, noCoordinates.stdout).toBe(1);
      expect(noCoordinates.stdout).toContain(
        'artifact context.json must provide the same repo and PR coordinates',
      );
      const invalidPr = setup(42, true);
      const artifactContext = JSON.parse(
        readFileSync(join(invalidPr.dir, 'context.json'), 'utf8'),
      );
      writeFileSync(
        join(invalidPr.dir, 'context.json'),
        JSON.stringify({ ...artifactContext, pr: '43', number: 42 }),
      );
      const invalidPrResult = check(invalidPr);
      expect(invalidPrResult.status, invalidPrResult.stdout).toBe(1);
      expect(invalidPrResult.stdout).toContain(
        'artifact context.json must provide the same repo and PR coordinates',
      );
      const unnamed = setup(42, true);
      const unnamedDir = join(unnamed.clone, 'tmp', 'round');
      renameSync(unnamed.dir, unnamedDir);
      const unnamedResult = check({ ...unnamed, dir: unnamedDir });
      expect(unnamedResult.status, unnamedResult.stdout).toBe(1);
      expect(unnamedResult.stdout).toContain(
        "does not name a PR in prepare's pr<N>-verify-* form",
      );
      for (const artifactRepo of ['fork/qwen-code', 'QwenLM/fork']) {
        const crossRepo = check(setup(42, true, artifactRepo));
        expect(crossRepo.status, crossRepo.stdout).toBe(1);
        expect(crossRepo.stdout).toContain(
          'artifact context.json identifies another repository',
        );
      }
      for (const artifactContext of [false, true]) {
        const cross = check(setup(43, artifactContext));
        expect(cross.status, cross.stdout).toBe(1);
        expect(cross.stdout).toMatch(
          /pr43-verify-.* names PR 43, but the trusted host snapshot is for QwenLM\/qwen-code#42/,
        );

        const aliased = setup(43, artifactContext);
        const alias = join(aliased.clone, 'tmp', 'pr42-verify-20261123-000000');
        symlinkSync('pr43-verify-20261123-000000', alias, 'dir');
        for (const roundDir of [alias, `${alias}/`]) {
          const crossThroughAlias = check({ ...aliased, dir: roundDir });
          expect(crossThroughAlias.status, crossThroughAlias.stdout).toBe(1);
          expect(crossThroughAlias.stdout).toMatch(
            /artifact directory .* must be a real directory, not a symbolic link or other non-directory, when --context supplies trusted PR coordinates; pass the resolved artifact directory path/,
          );
        }
      }
    },
  );

  it('keeps legacy snapshots outside the new artifact witness requirement', () => {
    const dir = makeArtifactDir(validFiles(), ['01-ab-cells.png']);
    writeFileSync(
      join(dir, 'context.json'),
      JSON.stringify({ repo: 'fork/other', pr: '43', number: 42 }),
    );
    const trustedText = JSON.stringify({
      repo: 'QwenLM/qwen-code',
      pr: 17185,
      headRefOid: HEAD,
    });
    const hostSnapshot = hostFile('legacy-snapshot.json', trustedText);
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '--context',
        hostSnapshot,
        '--context-sha256',
        createHash('sha256').update(trustedText).digest('hex'),
        dir,
      ],
      { encoding: 'utf8', env: { ...process.env, QWEN_VERIFY_CONTEXT: '' } },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  // prepare's snapshot carries `number` (gh's field name), not `pr`, and
  // the slug is added where prepare writes it: the documented invocation
  // must fire the coordinate check with that shape too.
  it('checks coordinates from a prepare-shaped snapshot (number, not pr)', () => {
    const dir = makeArtifactDir(
      validFiles({
        boundary: JSON.stringify({
          mode: 'waived',
          by: 'maintainer',
          approval: 'https://github.com/torvalds/linux/issues/1#issuecomment-1',
          reason: 'why',
        }),
        report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n## Methodology\n\n**Boundary.** host, maintainer-approved waiver.\n`,
      }),
      ['01-ab-cells.png'],
    );
    const hostSnapshot = join(tmpdir(), `verify-pr-prep-${Date.now()}.json`);
    tmpDirs.push(hostSnapshot);
    writeFileSync(
      hostSnapshot,
      JSON.stringify({
        number: 17185,
        repo: 'QwenLM/qwen-code',
        headRefOid: HEAD,
      }),
    );
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--context', hostSnapshot, dir],
      { encoding: 'utf8', env: { ...process.env, QWEN_VERIFY_CONTEXT: '' } },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(
      /approval permalink cites torvalds\/linux#1, not this round's QwenLM\/qwen-code#17185/,
    );
  });

  // The artifact directory is PR-writable: even a fully coherent approval in
  // both artifact files supplies no trusted coordinates or preflight approval.
  it('refuses a waiver whose only approval is inside artifact context.json', () => {
    const approval = commentApproval();
    const dir = makeArtifactDir(
      validFiles({
        boundary: JSON.stringify(approval),
        report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n## Methodology\n\n**Boundary.** host, maintainer-approved waiver.\n`,
      }),
      ['01-ab-cells.png'],
    );
    writeFileSync(
      join(dir, 'context.json'),
      JSON.stringify({
        repo: 'QwenLM/qwen-code',
        pr: 17185,
        headRefOid: HEAD,
        executionApproval: approval,
      }),
    );
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/needs the host-held --context snapshot/);
    expect(result.stdout).not.toMatch(/approval permalink cites/);

    // Supplying a real host file and exact digest does not help when the trust
    // record itself is removed from that file.
    const untrustedText = JSON.stringify({
      repo: 'QwenLM/qwen-code',
      pr: 17185,
      headRefOid: HEAD,
    });
    const hostSnapshot = hostFile('host-without-approval.json', untrustedText);
    const removingTrust = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '--context',
        hostSnapshot,
        '--context-sha256',
        createHash('sha256').update(untrustedText).digest('hex'),
        dir,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
      },
    );
    expect(removingTrust.status).toBe(1);
    expect(removingTrust.stdout).toMatch(/has no executionApproval object/);
  });

  it('accepts VM only with genuine matching host records and refuses both missing authority forms', () => {
    for (const approval of [
      commentApproval({
        mode: 'vm',
        attestation: 'nothing mounted, no host credentials',
      }),
      localTrustApproval({
        mode: 'vm',
        attestation: 'nothing mounted, no host credentials',
      }),
    ]) {
      const dir = makeArtifactDir(
        validFiles({
          boundary: JSON.stringify(approval),
          boundaryGate: undefined,
          report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n## Methodology\n\n**Boundary.** attested VM, no host mounts or credentials.\n`,
        }),
        ['01-ab-cells.png'],
      );
      const noContext = run(dir);
      expect(noContext.status, approval.source).toBe(1);
      expect(noContext.stdout).toMatch(/needs the host-held --context/);
      const trustedText = JSON.stringify({
        repo: 'QwenLM/qwen-code',
        pr: 17185,
        headRefOid: HEAD,
        author: { login: 'maintainer' },
        isCrossRepository: true,
        executionApproval: approval,
      });
      const prepared = prepareArtifactWitness(dir, JSON.parse(trustedText));
      const hostSnapshot = hostFile(
        `host-${approval.source}.json`,
        trustedText,
      );
      const noDigest = spawnSync(
        process.execPath,
        [
          SCRIPT,
          '--context',
          hostSnapshot,
          '--context-root',
          prepared.clone,
          prepared.dir,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
        },
      );
      expect(noDigest.status, approval.source).toBe(1);
      expect(noDigest.stdout).toMatch(/needs --context-sha256/);
      const accepted = spawnSync(
        process.execPath,
        [
          SCRIPT,
          '--context',
          hostSnapshot,
          '--context-root',
          prepared.clone,
          '--context-sha256',
          createHash('sha256').update(trustedText).digest('hex'),
          prepared.dir,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
        },
      );
      expect(accepted.status, `${approval.source}: ${accepted.stdout}`).toBe(0);
      expect(accepted.stdout).toContain('ok: verdict=merge-ready');
    }
  });
});

// The Methodology label is matched by name, not by a hand-listed line
// shape: any heading level, and the Boundary disclosure on the label line
// itself, are compliant forms that must not draw a false warning.
describe('Methodology heading shapes', () => {
  const lead = `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n`;
  it('accepts the Boundary line on an H2 label line itself', () => {
    expect(
      check({
        report: `${lead}## Methodology - **Boundary.** node:22-bookworm, no network.\n`,
      }).warnings,
    ).toEqual([]);
  });
  it('accepts deeper heading levels', () => {
    for (const heading of ['### Methodology', '# Methodology']) {
      expect(
        check({
          report: `${lead}${heading}\n\n**Boundary.** node:22-bookworm, --network none.\n`,
        }).warnings,
      ).toEqual([]);
    }
  });
  it('accepts an unbolded numbered label', () => {
    expect(
      check({
        report: `${lead}8. Methodology — one paragraph.\n\n**Boundary.** node:22-bookworm, --network none.\n`,
      }).warnings,
    ).toEqual([]);
  });
});

// The disclosure is checked by content, not position alone: an empty or
// template Boundary line ships a placeholder, and the prose must not name
// a boundary the recorded declaration contradicts.
describe('Boundary disclosure content', () => {
  const lead = `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n`;
  it('warns when the Boundary line carries no disclosure', () => {
    expect(
      check({
        report: `${lead}## Methodology\n\n**Boundary.**\n`,
      }).warnings.join('\n'),
    ).toMatch(/carries no disclosure/);
  });
  it('warns when the Boundary line is still a template placeholder', () => {
    expect(
      check({
        report: `${lead}## Methodology\n\n**Boundary.** <where it ran>\n`,
      }).warnings.join('\n'),
    ).toMatch(/carries a <placeholder> disclosure/);
  });
  // The same-line form carries the label before the token: the content
  // check must read what follows the token, not the start of the line.
  it('checks the disclosure on the same-line form too', () => {
    expect(
      check({
        report: `${lead}## Methodology - **Boundary.**\n`,
      }).warnings.join('\n'),
    ).toMatch(/carries no disclosure/);
    expect(
      check({
        report: `${lead}8. **Methodology** — **Boundary.** <where it ran>\n`,
      }).warnings.join('\n'),
    ).toMatch(/carries a <placeholder> disclosure/);
  });
  it('warns when a waived declaration ships container prose', () => {
    const result = check({
      boundary: JSON.stringify({
        mode: 'waived',
        by: 'maintainer',
        approval: APPROVAL,
        reason: 'why',
      }),
      report: `${lead}## Methodology\n\n**Boundary.** node:22-bookworm, --network none, credential-free.\n`,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(
      /records a waived but the \*\*Boundary\.\*\* line names a container runtime/,
    );
  });
  it('warns when a container declaration ships waiver prose', () => {
    const result = check({
      report: `${lead}## Methodology\n\n**Boundary.** host execution, waived by the maintainer.\n`,
    });
    expect(result.warnings.join('\n')).toMatch(
      /records a container but the \*\*Boundary\.\*\* line claims a waiver/,
    );
  });
  it('stays quiet when the waiver prose matches the declaration', () => {
    const result = checkArtifacts({
      files: validFiles({
        boundary: JSON.stringify({
          mode: 'waived',
          by: 'maintainer',
          approval: APPROVAL,
          reason: 'why',
        }),
        report: `${lead}## Methodology\n\n**Boundary.** host, maintainer-approved waiver.\n`,
      }),
      evidence: ['01-ab-cells.png'],
      coordinates: { owner: 'QwenLM', repo: 'qwen-code', number: 17185 },
    });
    expect(result.warnings).toEqual([]);
  });
  // R10-8: a truthful waiver phrased without the "waiv" stem is not accused
  // of contradicting its own declaration; the recorded mode is authoritative.
  it('does not flag a truthful waiver prose lacking the waiv stem', () => {
    const result = checkArtifacts({
      files: validFiles({
        boundary: JSON.stringify({
          mode: 'waived',
          by: 'maintainer',
          approval: APPROVAL,
          reason: 'why',
        }),
        report: `${lead}## Methodology\n\n**Boundary.** Host execution approved by the maintainer in the linked approval comment; no container was used.\n`,
      }),
      evidence: ['01-ab-cells.png'],
      coordinates: { owner: 'QwenLM', repo: 'qwen-code', number: 17185 },
    });
    expect(result.warnings).toEqual([]);
  });
});

describe('waiver approval coordinates', () => {
  const COORDS = { owner: 'QwenLM', repo: 'qwen-code', number: 17185 };
  const waiver = (approval) =>
    JSON.stringify({
      mode: 'waived',
      by: 'maintainer',
      approval,
      reason: 'why',
    });
  it('accepts a permalink citing the round PR, case-insensitively', () => {
    for (const approval of [
      APPROVAL,
      'https://github.com/qwenlm/qwen-code/pull/17185#issuecomment-1234567890',
    ]) {
      expect(
        checkBoundary(waiver(approval), null, { coordinates: COORDS }).errors,
      ).toEqual([]);
    }
  });
  it('refuses a permalink citing another repo, owner or number', () => {
    for (const approval of [
      'https://github.com/torvalds/linux/issues/1#issuecomment-1',
      'https://github.com/QwenLM/other-repo/pull/17185#issuecomment-1',
      'https://github.com/QwenLM/qwen-code/pull/1#issuecomment-1',
    ]) {
      expect(
        checkBoundary(waiver(approval), null, {
          coordinates: COORDS,
        }).errors.join('\n'),
      ).toMatch(
        /approval permalink cites .* not this round's QwenLM\/qwen-code#17185/,
      );
    }
  });
  it('keeps the shape check when no coordinates are available, and says so', () => {
    expect(
      checkBoundary(
        waiver('https://github.com/torvalds/linux/issues/1#issuecomment-1'),
      ).errors,
    ).toEqual([]);
    expect(
      checkBoundary(waiver('approved in words')).errors.join('\n'),
    ).toMatch(/only the URL shape is checked/);
  });
  it('reaches the verdict through checkArtifacts', () => {
    const result = checkArtifacts({
      files: validFiles({
        boundary: waiver(
          'https://github.com/torvalds/linux/issues/1#issuecomment-1',
        ),
      }),
      evidence: ['01-ab-cells.png'],
      coordinates: COORDS,
    });
    expect(result.errors.join('\n')).toMatch(/approval permalink cites/);
  });
});

describe('executionApproval host binding', () => {
  const verified = {
    contextProvided: true,
    contextDigestVerified: true,
  };
  const snapshot = (executionApproval) => ({
    repo: 'QwenLM/qwen-code',
    number: 17185,
    headRefOid: HEAD,
    author: { login: 'maintainer' },
    isCrossRepository: true,
    executionApproval,
  });

  it('accepts matching comment and local-trust records including same-repository trust', () => {
    const comment = commentApproval();
    expect(
      executionApprovalErrors(
        JSON.stringify(comment),
        snapshot(comment),
        verified,
      ),
    ).toEqual([]);
    expect(checkBoundary(JSON.stringify(comment)).errors).toEqual([]);
    for (const [cross, basis] of [
      [true, 'own-pr'],
      [false, 'same-repository'],
    ]) {
      const local = localTrustApproval({ basis });
      const context = {
        ...snapshot(local),
        isCrossRepository: cross,
        ...(basis === 'same-repository'
          ? { author: { login: 'colleague' } }
          : {}),
      };
      expect(
        executionApprovalErrors(JSON.stringify(local), context, verified),
      ).toEqual([]);
      // Without the CLI's authority, this is only a shape check and has no
      // comment URL to validate; executionApprovalErrors above is the gate.
      expect(checkBoundary(JSON.stringify(local)).errors).toEqual([]);
    }
  });

  it('rejects an unsupported source even with otherwise valid comment approval evidence', () => {
    const unsupported = commentApproval({ source: 'ci-lane' });
    expect(
      executionApprovalErrors(
        JSON.stringify(unsupported),
        snapshot(unsupported),
        verified,
      ),
    ).toEqual([
      'executionApproval source must be local-trust or comment, with its matching basis',
    ]);
  });

  it('rejects a local-trust basis with otherwise valid comment approval evidence', () => {
    const mismatched = commentApproval({ basis: 'own-pr' });
    expect(
      executionApprovalErrors(
        JSON.stringify(mismatched),
        snapshot(mismatched),
        verified,
      ),
    ).toEqual([
      'comment executionApproval needs basis maintainer-comment, an approval permalink, numeric comment.id, 64-hex comment.bodySha256 and its registrationNonce',
    ]);
  });

  it('requires a host context and a verified digest even for an old valid waiver', () => {
    const legacy = {
      mode: 'waived',
      by: 'maintainer',
      approval: APPROVAL,
      reason: 'why',
    };
    expect(executionApprovalErrors(JSON.stringify(legacy), null)).toEqual([
      expect.stringMatching(/host-held --context/),
    ]);
    expect(
      executionApprovalErrors(JSON.stringify(legacy), snapshot(null), {
        contextProvided: true,
        contextDigestVerified: false,
      }),
    ).toEqual([expect.stringMatching(/--context-sha256/)]);
    expect(
      executionApprovalErrors(JSON.stringify(legacy), snapshot(null), verified),
    ).toEqual([expect.stringMatching(/no executionApproval object/)]);
  });

  it('rejects declaration tampering and a moved head', () => {
    const original = localTrustApproval();
    const context = snapshot(original);
    expect(
      executionApprovalErrors(
        JSON.stringify({ ...original, round: 2 }),
        context,
        verified,
      ),
    ).toEqual([
      expect.stringMatching(/differs from the host-held executionApproval/),
    ]);
    expect(
      executionApprovalErrors(
        JSON.stringify(original),
        { ...context, headRefOid: 'c'.repeat(40) },
        verified,
      ),
    ).toEqual([expect.stringMatching(/mode\/head does not match/)]);
  });

  it('accepts a local-trust VM with its attestation in both authority checks', () => {
    const vm = localTrustApproval({
      mode: 'vm',
      attestation: 'nothing mounted, no host credentials',
    });
    expect(
      executionApprovalErrors(JSON.stringify(vm), snapshot(vm), verified),
    ).toEqual([]);
    expect(checkBoundary(JSON.stringify(vm)).errors).toEqual([]);
  });

  it('requires local-trust VM attestation at both authority layers', () => {
    const missing = localTrustApproval({ mode: 'vm' });
    expect(
      executionApprovalErrors(
        JSON.stringify(missing),
        snapshot(missing),
        verified,
      ),
    ).toEqual([expect.stringMatching(/VM attestation/)]);
    expect(checkBoundary(JSON.stringify(missing)).errors).toEqual([
      expect.stringMatching(/mode vm needs a non-empty attestation/),
    ]);
  });

  it('rejects invalid permission and non-40-hex approval heads explicitly', () => {
    for (const bad of [
      localTrustApproval({ permission: 'read' }),
      localTrustApproval({ head: 'abc123' }),
    ]) {
      expect(
        executionApprovalErrors(JSON.stringify(bad), snapshot(bad), verified),
      ).toEqual([expect.stringMatching(/valid round and permission/)]);
    }
  });

  it('rejects local trust by another fork even when artifact and record agree', () => {
    const local = localTrustApproval();
    const forged = { ...snapshot(local), author: { login: 'someone-else' } };
    expect(
      executionApprovalErrors(JSON.stringify(local), forged, verified),
    ).toEqual([
      expect.stringMatching(/local-trust executionApproval does not match/),
    ]);
  });

  it('validates the comment record instead of only comparing JSON', () => {
    for (const bad of [
      commentApproval({
        comment: { id: 0, bodySha256: 'a'.repeat(64) },
      }),
      commentApproval({ comment: { id: 1234567890, bodySha256: 'bad' } }),
      commentApproval({ registrationNonce: 'not-a-registration' }),
    ]) {
      expect(
        executionApprovalErrors(JSON.stringify(bad), snapshot(bad), verified),
      ).toEqual([expect.stringMatching(/comment executionApproval needs/)]);
    }
    const malformed = localTrustApproval({ round: 0 });
    expect(
      executionApprovalErrors(
        JSON.stringify(malformed),
        snapshot(malformed),
        verified,
      ),
    ).toEqual([expect.stringMatching(/valid round and permission/)]);
  });

  it('does not add host requirements to container declarations', () => {
    expect(executionApprovalErrors(validFiles().boundary, null)).toEqual([]);
  });
});

// The wholly-<…> arm catches any copied template, not only the skill's
// named tokens.
describe('generic placeholder arm', () => {
  it('refuses any wholly-<…> detail or approver', () => {
    expect(
      checkBoundary(
        JSON.stringify({ mode: 'container', detail: '<anything at all>' }),
      ).errors.join('\n'),
    ).toMatch(/detail still carries a <placeholder>/);
    expect(
      checkBoundary(
        JSON.stringify({
          mode: 'waived',
          by: '<someone>',
          approval: APPROVAL,
          reason: 'why',
        }),
      ).errors.join('\n'),
    ).toMatch(/waived declaration still carries a <placeholder>/);
  });
});

describe('round-10 witnesses', () => {
  // R10-28: a two-key gate record (no observed marker, no attestation, no
  // signals) cannot back a container claim.
  it('refuses a minimal two-key gate record', () => {
    expect(
      checkBoundary(
        JSON.stringify({ mode: 'container', detail: 'node:22-bookworm' }),
        JSON.stringify({ gate: 'require-isolation', passed: true }),
      ).errors.join('\n'),
    ).toMatch(/no observed boundary marker/);
    expect(
      checkBoundary(
        JSON.stringify({ mode: 'container', detail: 'node:22-bookworm' }),
        JSON.stringify({
          gate: 'require-isolation',
          passed: true,
          observed: ['/.dockerenv'],
          signals: ['/.dockerenv'],
        }),
      ).errors.join('\n'),
    ).toMatch(/credential-free attestation/);
  });

  // R10-27: a surviving template token inside an otherwise filled value is
  // still a placeholder.
  it('flags a surviving template token in a filled detail', () => {
    expect(
      checkBoundary(
        JSON.stringify({
          mode: 'container',
          detail: 'node:22-bookworm, <network policy>, credential-free mount',
        }),
        GATE_RECORD,
      ).errors.join('\n'),
    ).toMatch(/detail still carries a <placeholder>/);
  });

  // R10-22/R10-24: a waiver/vm with no trusted coordinates discloses that
  // the approval target was only shape-checked.
  it('discloses the coordinate-check downgrade for a waiver', () => {
    const result = checkArtifacts({
      files: validFiles({
        boundary: JSON.stringify({
          mode: 'waived',
          by: 'maintainer',
          approval: APPROVAL,
          reason: 'why',
        }),
      }),
      evidence: ['01-ab-cells.png'],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(
      /approval target was not compared against this PR/,
    );
  });

  // R10-13: an unreadable artifact is reported as unreadable, not also missing.
  it('does not also call an unreadable artifact missing', () => {
    const result = checkArtifacts({
      files: {
        report: null,
        verdict: 'merge-ready\n',
        assertions: '{"pass":1,"fail":0,"total":1}',
        boundary: null,
        boundaryGate: null,
      },
      evidence: ['01-ab-cells.png'],
      unreadableKeys: new Set(['report', 'boundary']),
    });
    expect(result.errors.join('\n')).not.toMatch(/report\.md is missing/);
    expect(result.errors.join('\n')).not.toMatch(/boundary\.json is missing/);
  });

  // R10-2: the directory name never supplies trusted identity. A host/VM
  // approval without a trusted PR number is refused even in a pr999-verify dir.
  it('requires the trusted PR number instead of taking it from the artifact directory name', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-pr-r10-'));
    tmpDirs.push(root);
    const dir = join(root, 'pr999-verify-x');
    mkdirSync(join(dir, 'evidence'), { recursive: true });
    writeFileSync(
      join(dir, 'report.md'),
      `merge-ready · 1 passed · 0 failed · 1 total · ${HEAD}\n\n## Methodology\n\n**Boundary.** host, maintainer-approved waiver.\n`,
    );
    writeFileSync(join(dir, 'verdict.txt'), 'merge-ready\n');
    writeFileSync(
      join(dir, 'assertions.json'),
      '{"pass":1,"fail":0,"total":1}',
    );
    const approval = commentApproval({
      approval: 'https://github.com/QwenLM/qwen-code/pull/999#issuecomment-123',
      comment: { id: 123, bodySha256: 'a'.repeat(64) },
      reason: 'why',
    });
    writeFileSync(join(dir, 'boundary.json'), JSON.stringify(approval));
    writeFileSync(join(dir, 'evidence/01-x.png'), 'png');
    const snap = join(root, 'snap.json');
    const trustedText = JSON.stringify({
      repo: 'QwenLM/qwen-code',
      headRefOid: HEAD,
      executionApproval: approval,
    });
    writeFileSync(snap, trustedText);
    const res = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '--context',
        snap,
        '--context-sha256',
        createHash('sha256').update(trustedText).digest('hex'),
        dir,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
      },
    );
    // The digest, approval body, head and directory shape are all valid. Only
    // the trusted number is absent; pr999 must not fill that identity gap.
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(
      /needs trusted repo and positive PR coordinates in --context/,
    );
    expect(res.stdout).not.toMatch(/approval permalink cites/);
    expect(res.stdout).not.toMatch(/--context-sha256 matching/);
  });

  it.each([{ source: 'comment' }, { source: 'local-trust' }])(
    'fails closed when a $source approval has missing trusted coordinates, including aliases',
    ({ source }) => {
      const approval =
        source === 'comment'
          ? commentApproval({
              approval:
                'https://github.com/QwenLM/qwen-code/pull/42#issuecomment-1234567890',
            })
          : localTrustApproval();
      const setup = (directoryPr, coordinates) => {
        const base = mkdtempSync(join(tmpdir(), 'verify-pr-missing-coords-'));
        tmpDirs.push(base);
        const clone = join(base, 'clone');
        const dir = join(
          clone,
          'tmp',
          `pr${directoryPr}-verify-20261123-000000`,
        );
        mkdirSync(join(dir, 'evidence'), { recursive: true });
        writeFileSync(
          join(dir, 'report.md'),
          `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n## Methodology\n\n**Boundary.** host, maintainer-approved waiver.\n`,
        );
        writeFileSync(join(dir, 'verdict.txt'), 'merge-ready\n');
        writeFileSync(
          join(dir, 'assertions.json'),
          JSON.stringify({ pass: 4, fail: 0, total: 4 }),
        );
        writeFileSync(join(dir, 'boundary.json'), JSON.stringify(approval));
        writeFileSync(join(dir, 'evidence', '01-ab.png'), 'png');
        const trustedText = JSON.stringify({
          ...coordinates,
          headRefOid: HEAD,
          author: { login: 'maintainer' },
          isCrossRepository: true,
          executionApproval: approval,
        });
        const host = join(base, 'host.json');
        writeFileSync(host, trustedText);
        return { base, clone, dir, host, trustedText };
      };
      const check = ({ dir, clone, host, trustedText }) =>
        spawnSync(
          process.execPath,
          [
            SCRIPT,
            '--context',
            host,
            '--context-root',
            clone,
            '--context-sha256',
            createHash('sha256').update(trustedText).digest('hex'),
            dir,
          ],
          {
            encoding: 'utf8',
            env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
          },
        );

      for (const coordinates of [
        { pr: 42 },
        { repo: 'QwenLM/qwen-code' },
        {},
        { repo: 'not-a-slug', pr: 42 },
        { repo: 'QwenLM/qwen-code', pr: 0 },
        { repo: ['QwenLM/qwen-code'], pr: 42 },
        { repo: { slug: 'QwenLM/qwen-code' }, pr: 42 },
      ]) {
        const round = setup(43, coordinates);
        const cross = check(round);
        expect(cross.status, cross.stdout).toBe(1);
        expect(cross.stdout).toMatch(
          /needs trusted repo and positive PR coordinates in --context/,
        );
        expect(cross.stdout).not.toMatch(/--context-sha256 matching/);

        const alias = join(round.clone, 'tmp', 'pr42-verify-20261123-000000');
        symlinkSync('pr43-verify-20261123-000000', alias, 'dir');
        for (const roundDir of [alias, `${alias}/`]) {
          const replay = check({ ...round, dir: roundDir });
          expect(replay.status, replay.stdout).toBe(1);
          expect(replay.stdout).toMatch(
            /needs trusted repo and positive PR coordinates in --context/,
          );
        }
      }

      const controlFixture = setup(42, {
        repo: 'QwenLM/qwen-code',
        pr: 42,
      });
      const control = check({
        ...controlFixture,
        ...prepareArtifactWitness(
          controlFixture.dir,
          { repo: 'QwenLM/qwen-code', pr: 42, headRefOid: HEAD },
          controlFixture.clone,
        ),
      });
      expect(control.status, control.stdout).toBe(0);
      expect(control.stdout).toContain('ok: verdict=merge-ready');
    },
  );

  // R10-49 (false negative): a Methodology heading and Boundary disclosure
  // that live only inside a code fence are a copied template, not the round's
  // own declaration — the prose says the battery ran on the host.
  it('does not accept a fenced-only Methodology and Boundary disclosure', () => {
    const report = `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n# Report\n\nThe declaration format:\n\n\`\`\`\n## Methodology\n\n**Boundary.** node:22-bookworm, --network none.\n\`\`\`\n\nWe ran the battery on the host.\n`;
    const result = checkArtifacts({
      files: validFiles({ report }),
      evidence: ['01-ab-cells.png'],
    });
    expect(result.warnings.join('\n')).toMatch(/has no Methodology section/);
  });

  // R10-49 (false positive): a fenced template example preceding the real
  // Methodology must not accuse the round of shipping a placeholder it does
  // not have — the real disclosure is filled in.
  it('does not accuse a real Methodology preceded by a fenced example', () => {
    const report = `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n# Report\n\nThe declaration now reads:\n\n\`\`\`\n## Methodology\n\n**Boundary.** <image, network policy, credential-free mount>\n\`\`\`\n\n## Methodology\n\n**Boundary.** node:22-bookworm, --network none, credential-free.\n`;
    const result = checkArtifacts({
      files: validFiles({ report }),
      evidence: ['01-ab-cells.png'],
    });
    const warnings = result.warnings.join('\n');
    expect(warnings).not.toMatch(/placeholder/);
    expect(warnings).not.toMatch(/has no Methodology section/);
    expect(warnings).not.toMatch(/first line after the Methodology opening/);
  });

  // A10-1: a Setext Methodology's underline (=== / ---) belongs to the
  // heading, not the body — it must not be read as the first line after the
  // opening and accused of missing the Boundary line.
  it('does not accuse a Setext Methodology of missing its Boundary line', () => {
    for (const underline of ['===', '---']) {
      const report = `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\nMethodology\n${underline}\n\n**Boundary.** node:22-bookworm, --network none, credential-free.\n`;
      const result = checkArtifacts({
        files: validFiles({ report }),
        evidence: ['01-ab-cells.png'],
      });
      const warnings = result.warnings.join('\n');
      expect(warnings).not.toMatch(/has no Methodology section/);
      expect(warnings).not.toMatch(/first line after the Methodology opening/);
    }
  });

  // R10-51: the publisher owns the gate record too — a round-authored
  // container declaration whose gate run has not happened is the same
  // expected gap as an absent declaration on the CI entry path, not a
  // refusal pointing at a prepare step this lane never runs.
  it('downgrades a container declaration with no gate record on the CI entry path', () => {
    const dir = makeArtifactDir(validFiles({ boundaryGate: undefined }), [
      '01-ab-cells.png',
    ]);
    const ci = spawnSync(process.execPath, [SCRIPT, dir], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_VERIFY_CONTEXT: '/verify-context/pr.json' },
    });
    expect(ci.status).toBe(0);
    expect(ci.stdout).toMatch(
      /warn.*boundary-gate\.json is absent on the CI entry path/,
    );
    const local = spawnSync(process.execPath, [SCRIPT, dir], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
    });
    expect(local.status).toBe(1);
    expect(local.stdout).toMatch(/boundary-gate\.json is missing/);
  });

  // R10-50: a FIFO in place of an artifact blocks open(2) forever with no
  // writer; the checker must refuse it, not hang. The spawnSync timeout is
  // what turns the pre-fix hang into a failure rather than a hung suite.
  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO in place of report.md instead of hanging',
    () => {
      const dir = makeArtifactDir(validFiles({}), ['01-ab-cells.png']);
      unlinkSync(join(dir, 'report.md'));
      execFileSync('mkfifo', [join(dir, 'report.md')]);
      const res = spawnSync(process.execPath, [SCRIPT, dir], {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
      });
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/report\.md is unreadable/);
    },
  );

  // R10-23: spelling the round's own PR-writable context.json as --context
  // is shape-identical to the prescribed invocation; it must be refused, not
  // allowed to supply the coordinates that judge the round's own waiver.
  it('refuses a --context snapshot inside the artifact directory', () => {
    const dir = makeArtifactDir(
      validFiles({
        boundary: JSON.stringify({
          mode: 'waived',
          by: 'maintainer',
          approval: APPROVAL,
          reason: 'why',
        }),
      }),
      ['01-ab-cells.png'],
    );
    writeFileSync(
      join(dir, 'context.json'),
      JSON.stringify({ repo: 'QwenLM/qwen-code', pr: 17185, headRefOid: HEAD }),
    );
    const res = spawnSync(
      process.execPath,
      [SCRIPT, '--context', join(dir, 'context.json'), dir],
      { encoding: 'utf8', env: { ...process.env, QWEN_VERIFY_CONTEXT: '' } },
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(
      /must not point inside the PR-writable worktree/,
    );
  });
});

describe('round-11 witnesses', () => {
  // R11-3: a FIFO at context.json (the eighth read from the PR-writable dir)
  // must refuse with a warning, not block open(2) forever. The timeout turns
  // the pre-fix hang into a failure rather than a hung suite.
  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO context.json instead of hanging',
    () => {
      const dir = makeArtifactDir(validFiles({}), ['01-ab-cells.png']);
      execFileSync('mkfifo', [join(dir, 'context.json')]);
      const res = spawnSync(process.execPath, [SCRIPT, dir], {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/snapshot .*context\.json is unreadable/);
    },
  );

  // R11 deferred: a filled git identity whose local part starts with a token
  // word is not a placeholder; a bare skill token still is.
  it('does not accuse an email-shaped git identity', () => {
    const ok = checkBoundary(
      JSON.stringify({
        mode: 'waived',
        by: 'Name <repo@example.com>',
        approval: APPROVAL,
        reason: 'why',
      }),
    );
    expect(ok.errors).toEqual([]);
    const bad = checkBoundary(
      JSON.stringify({
        mode: 'waived',
        by: 'Name <maintainer>',
        approval: APPROVAL,
        reason: 'why',
      }),
    );
    expect(bad.errors.join('\n')).toMatch(/placeholder/);
  });

  // R11 deferred: a table-of-contents bullet must not claim the Methodology
  // section ahead of the real heading.
  it('does not let a TOC bullet claim the Methodology section', () => {
    const report = `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\nContents:\n\n- Methodology\n- Results\n\n## Methodology\n\n**Boundary.** node:22-bookworm, --network none, credential-free.\n`;
    const result = checkArtifacts({
      files: validFiles({ report }),
      evidence: ['01-ab-cells.png'],
    });
    const warnings = result.warnings.join('\n');
    expect(warnings).not.toMatch(/has no Methodology section/);
    expect(warnings).not.toMatch(/first line after the Methodology opening/);
  });

  // R11 deferred: a truthful container report mentioning "not a VM" is not
  // accused; a positive VM claim still is.
  it('does not accuse a container report that negates a VM', () => {
    const negated = checkArtifacts({
      files: validFiles({
        report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n## Methodology\n\n**Boundary.** node:22-bookworm, --network none (not a VM).\n`,
      }),
      evidence: ['01-ab-cells.png'],
    });
    expect(negated.warnings.join('\n')).not.toMatch(/claims a waiver or VM/);
    const positive = checkArtifacts({
      files: validFiles({
        report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n## Methodology\n\n**Boundary.** ran in a VM, credential-free.\n`,
      }),
      evidence: ['01-ab-cells.png'],
    });
    expect(positive.warnings.join('\n')).toMatch(/claims a waiver or VM/);
  });

  // R11 deferred: the boundaryGate half of "unreadable is not missing" — a
  // directory at boundary-gate.json is reported unreadable, not missing.
  it('reports an unreadable boundary-gate.json as unreadable, not missing', () => {
    const dir = makeArtifactDir(validFiles({}), ['01-ab-cells.png']);
    rmSync(join(dir, 'boundary-gate.json'));
    mkdirSync(join(dir, 'boundary-gate.json'));
    const res = spawnSync(process.execPath, [SCRIPT, dir], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/boundary-gate\.json is unreadable/);
    expect(res.stdout).not.toMatch(/boundary-gate\.json is missing/);
  });

  // R11-1 cross-tool contract: the gate refuses a SANDBOX-only record (no
  // observed marker), and the checker refuses the same record — removing
  // either side of the tightened contract reds one of these.
  it('gate and checker agree a SANDBOX-only record is not a boundary', () => {
    const sandboxOnly = JSON.stringify({
      gate: 'require-isolation',
      passed: true,
      signals: ['SANDBOX=docker'],
      observed: [],
      credentialFree: true,
    });
    const refused = checkBoundary(
      JSON.stringify({ mode: 'container', detail: 'node:22-bookworm' }),
      sandboxOnly,
    );
    expect(refused.errors.join('\n')).toMatch(/no observed boundary marker/);
    const observed = JSON.stringify({
      gate: 'require-isolation',
      passed: true,
      signals: ['/.dockerenv'],
      observed: ['/.dockerenv'],
      credentialFree: true,
    });
    const accepted = checkBoundary(
      JSON.stringify({ mode: 'container', detail: 'node:22-bookworm' }),
      observed,
    );
    expect(accepted.errors).toEqual([]);
  });
});

describe('round-12 witnesses', () => {
  const waiver = JSON.stringify({
    mode: 'waived',
    by: 'maintainer',
    approval: APPROVAL,
    reason: 'why',
  });

  // R12-1 (a): a symlink whose target is the round's own context.json is
  // refused by its REAL path, not followed.
  it.skipIf(process.platform === 'win32')(
    'refuses a --context symlink targeting the artifact context.json',
    () => {
      const dir = makeArtifactDir(validFiles({ boundary: waiver }), [
        '01-ab-cells.png',
      ]);
      writeFileSync(
        join(dir, 'context.json'),
        JSON.stringify({ repo: 'evil/repo', pr: 999, headRefOid: HEAD }),
      );
      const link = join(dir, '..', `snap-${Date.now()}.json`);
      symlinkSync(join(dir, 'context.json'), link);
      const res = spawnSync(
        process.execPath,
        [SCRIPT, '--context', link, dir],
        {
          encoding: 'utf8',
          env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
        },
      );
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(
        /must not point inside the PR-writable worktree/,
      );
    },
  );

  // R12-1 (b): a FIFO at the --context path refuses with exit 1, not a hang.
  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO --context path instead of hanging',
    () => {
      const dir = makeArtifactDir(validFiles({ boundary: waiver }), [
        '01-ab-cells.png',
      ]);
      const fifo = join(dir, '..', `ctx-fifo-${Date.now()}`);
      execFileSync('mkfifo', [fifo]);
      const res = spawnSync(
        process.execPath,
        [SCRIPT, '--context', fifo, dir],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
        },
      );
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(
        /missing, unreadable, or carries no valid head OID/,
      );
    },
  );

  // R12-1 (c): the tmp/verify-context sibling prepare prints is inside the
  // PR-writable worktree too, so a planted snapshot there is refused.
  it.skipIf(process.platform === 'win32')(
    'refuses a --context snapshot in the verify-context sibling',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'verify-pr-r12-'));
      tmpDirs.push(root);
      execFileSync('git', ['init', '--quiet', root], {
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      });
      const dir = join(root, 'tmp', 'pr7-verify-20261115-000000');
      mkdirSync(join(dir, 'evidence'), { recursive: true });
      writeFileSync(join(dir, 'report.md'), validFiles({}).report);
      writeFileSync(join(dir, 'verdict.txt'), 'merge-ready\n');
      writeFileSync(
        join(dir, 'assertions.json'),
        '{"pass":1,"fail":0,"total":1}',
      );
      writeFileSync(join(dir, 'boundary.json'), waiver);
      writeFileSync(join(dir, 'evidence/01-x.png'), 'png');
      const sibling = join(root, 'tmp', 'verify-context', 'pr7.json');
      mkdirSync(join(root, 'tmp', 'verify-context'), { recursive: true });
      writeFileSync(
        sibling,
        JSON.stringify({ repo: 'evil/repo', pr: 9, headRefOid: HEAD }),
      );
      const res = spawnSync(
        process.execPath,
        [SCRIPT, '--context', sibling, dir],
        { encoding: 'utf8', env: { ...process.env, QWEN_VERIFY_CONTEXT: '' } },
      );
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(
        /must not point inside the PR-writable worktree/,
      );
    },
  );

  // R12 deferred: an oversized (sparse) artifact is refused, not read whole
  // into memory.
  it('refuses an oversized artifact', () => {
    const dir = makeArtifactDir(validFiles({}), ['01-ab-cells.png']);
    truncateSync(join(dir, 'report.md'), 17 * 1024 * 1024);
    const res = spawnSync(process.execPath, [SCRIPT, dir], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/report\.md is unreadable/);
  });

  // R12 deferred: an unreadable gate record must not suppress the
  // declaration's own defects.
  it('reports boundary defects even when the gate record is unreadable', () => {
    const dir = makeArtifactDir(
      validFiles({ boundary: JSON.stringify({ mode: 'bogus' }) }),
      ['01-ab-cells.png'],
    );
    rmSync(join(dir, 'boundary-gate.json'));
    mkdirSync(join(dir, 'boundary-gate.json'));
    const res = spawnSync(process.execPath, [SCRIPT, dir], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/boundary-gate\.json is unreadable/);
    expect(res.stdout).toMatch(/mode must be one of/);
  });

  // R12 deferred: an ATX heading carrying a number ("## 8. Methodology") is
  // a Methodology section, not reported absent.
  it('recognises an ATX heading that carries a number', () => {
    const report = `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n## 8. Methodology\n\n**Boundary.** node:22-bookworm, --network none, credential-free.\n`;
    const result = checkArtifacts({
      files: validFiles({ report }),
      evidence: ['01-ab-cells.png'],
    });
    expect(result.warnings.join('\n')).not.toMatch(
      /has no Methodology section/,
    );
  });

  // R12 deferred: a symlink artifact is refused (lstat, not stat) — a
  // lstat→stat mutation would follow the link and read the target.
  it.skipIf(process.platform === 'win32')(
    'refuses a symlink artifact rather than following it',
    () => {
      const dir = makeArtifactDir(validFiles({}), ['01-ab-cells.png']);
      const target = join(dir, '..', `target-${Date.now()}.md`);
      writeFileSync(target, validFiles({}).report);
      rmSync(join(dir, 'report.md'));
      symlinkSync(target, join(dir, 'report.md'));
      const res = spawnSync(process.execPath, [SCRIPT, dir], {
        encoding: 'utf8',
        env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
      });
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/report\.md is unreadable/);
    },
  );
});

describe('round-13 witnesses', () => {
  // R13 R12-1: the trust root must not collapse to the round dir when git
  // fails. A damaged .git refuses outright; a cleanly absent .git falls back
  // to the tmp container that also holds the verify-context sibling.
  const setupClone = () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-pr-r13-'));
    tmpDirs.push(root);
    execFileSync('git', ['init', '--quiet', root], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    });
    const dir = join(root, 'tmp', 'pr7-verify-20261115-000000');
    mkdirSync(join(dir, 'evidence'), { recursive: true });
    writeFileSync(join(dir, 'report.md'), validFiles({}).report);
    writeFileSync(join(dir, 'verdict.txt'), 'merge-ready\n');
    writeFileSync(
      join(dir, 'assertions.json'),
      '{"pass":1,"fail":0,"total":1}',
    );
    writeFileSync(
      join(dir, 'boundary.json'),
      JSON.stringify({
        mode: 'waived',
        by: 'maintainer',
        approval: APPROVAL,
        reason: 'why',
      }),
    );
    writeFileSync(join(dir, 'evidence/01-x.png'), 'png');
    const sibling = join(root, 'tmp', 'verify-context', 'pr7.json');
    mkdirSync(join(root, 'tmp', 'verify-context'), { recursive: true });
    writeFileSync(
      sibling,
      JSON.stringify({ repo: 'evil/repo', pr: 9, headRefOid: HEAD }),
    );
    return { root, dir, sibling };
  };
  const runContext = (dir, sibling) =>
    spawnSync(process.execPath, [SCRIPT, '--context', sibling, dir], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
    });

  it.skipIf(process.platform === 'win32')(
    'refuses the verify-context sibling when .git is absent',
    () => {
      const { root, dir, sibling } = setupClone();
      rmSync(join(root, '.git'), { recursive: true, force: true });
      const res = runContext(dir, sibling);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(
        /must not point inside the PR-writable worktree/,
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses the sibling regardless of damaged git state (root is not git-derived)',
    () => {
      const { root, dir, sibling } = setupClone();
      writeFileSync(
        join(root, '.git', 'config'),
        '[core]\nrepositoryformatversion = 99\n',
      );
      const res = runContext(dir, sibling);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(
        /must not point inside the PR-writable worktree/,
      );
    },
  );
});

describe('round-14 witnesses', () => {
  // R14-1: the trust root is host-provided (--context-root) or derived from
  // the artifact dir's path, never from git state the round controls. A
  // `git init` inside the artifact dir must not shrink the root to the dir.
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-pr-r14-'));
    tmpDirs.push(root);
    const dir = join(root, 'tmp', 'pr17185-verify-20261115-000000');
    mkdirSync(join(dir, 'evidence'), { recursive: true });
    writeFileSync(join(dir, 'report.md'), validFiles({}).report);
    writeFileSync(join(dir, 'verdict.txt'), 'merge-ready\n');
    writeFileSync(
      join(dir, 'assertions.json'),
      '{"pass":1,"fail":0,"total":1}',
    );
    writeFileSync(
      join(dir, 'boundary.json'),
      JSON.stringify(commentApproval({ reason: 'why' })),
    );
    writeFileSync(join(dir, 'evidence/01-x.png'), 'png');
    const sibling = join(root, 'tmp', 'verify-context', 'pr7.json');
    mkdirSync(join(root, 'tmp', 'verify-context'), { recursive: true });
    writeFileSync(
      sibling,
      JSON.stringify({ repo: 'evil/repo', pr: 9, headRefOid: HEAD }),
    );
    return { root, dir, sibling };
  };

  it.skipIf(process.platform === 'win32')(
    'a git init inside the artifact dir does not shrink the trust root',
    () => {
      const { dir, sibling } = setup();
      execFileSync('git', ['init', '--quiet', dir], {
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      });
      const res = spawnSync(
        process.execPath,
        [SCRIPT, '--context', sibling, dir],
        { encoding: 'utf8', env: { ...process.env, QWEN_VERIFY_CONTEXT: '' } },
      );
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(
        /must not point inside the PR-writable worktree/,
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a host-provided --context-root refuses the sibling and accepts an outside copy',
    () => {
      const { root, dir, sibling } = setup();
      const refused = spawnSync(
        process.execPath,
        [SCRIPT, '--context', sibling, '--context-root', root, dir],
        { encoding: 'utf8', env: { ...process.env, QWEN_VERIFY_CONTEXT: '' } },
      );
      expect(refused.status).toBe(1);
      expect(refused.stderr).toMatch(
        /must not point inside the PR-writable worktree/,
      );
      // A host-held copy outside the named root is accepted when its approval
      // matches and the digest binds the bytes prepare wrote.
      const outside = join(root, '..', `host-snap-${Date.now()}.json`);
      const trustedText = JSON.stringify({
        repo: 'QwenLM/qwen-code',
        pr: 17185,
        headRefOid: HEAD,
        executionApproval: commentApproval({ reason: 'why' }),
      });
      writeFileSync(outside, trustedText);
      const prepared = prepareArtifactWitness(dir, JSON.parse(trustedText));
      const accepted = spawnSync(
        process.execPath,
        [
          SCRIPT,
          '--context',
          outside,
          '--context-root',
          prepared.clone,
          '--context-sha256',
          createHash('sha256').update(trustedText).digest('hex'),
          prepared.dir,
        ],
        { encoding: 'utf8', env: { ...process.env, QWEN_VERIFY_CONTEXT: '' } },
      );
      expect(accepted.status).toBe(0);
    },
  );

  it('a host-provided root covers a sibling the structural fallback would miss', () => {
    // A plain (non pr-verify) artifact dir is its own structural root, so a
    // sibling outside it is only refused because --context-root names the
    // wider host-held tree. Ignoring --context-root would accept the sibling.
    const root = mkdtempSync(join(tmpdir(), 'verify-pr-r14b-'));
    tmpDirs.push(root);
    const dir = join(root, 'plain-round');
    mkdirSync(join(dir, 'evidence'), { recursive: true });
    writeFileSync(join(dir, 'report.md'), validFiles({}).report);
    writeFileSync(join(dir, 'verdict.txt'), 'merge-ready\n');
    writeFileSync(
      join(dir, 'assertions.json'),
      '{"pass":1,"fail":0,"total":1}',
    );
    writeFileSync(
      join(dir, 'boundary.json'),
      JSON.stringify({
        mode: 'waived',
        by: 'maintainer',
        approval: APPROVAL,
        reason: 'why',
      }),
    );
    writeFileSync(join(dir, 'evidence/01-x.png'), 'png');
    const sibling = join(root, 'planted-snapshot.json');
    writeFileSync(
      sibling,
      JSON.stringify({ repo: 'evil/repo', pr: 9, headRefOid: HEAD }),
    );
    const res = spawnSync(
      process.execPath,
      [SCRIPT, '--context', sibling, '--context-root', root, dir],
      { encoding: 'utf8', env: { ...process.env, QWEN_VERIFY_CONTEXT: '' } },
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(
      /must not point inside the PR-writable worktree/,
    );
  });

  it('rejects a valueless --context-root', () => {
    const dir = makeArtifactDir(validFiles({}), ['01-ab-cells.png']);
    const res = spawnSync(
      process.execPath,
      [SCRIPT, '--context-root', '', dir],
      { encoding: 'utf8', env: { ...process.env, QWEN_VERIFY_CONTEXT: '' } },
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--context-root requires a path/);
  });
});

describe('round-15 witnesses', () => {
  // R15 R14-1: without --context-root the fallback must cover the whole
  // clone, not just tmp/ — a snapshot planted at the clone root is refused.
  const setupClone = () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-pr-r15-'));
    tmpDirs.push(root);
    const dir = join(root, 'tmp', 'pr7-verify-20261115-000000');
    mkdirSync(join(dir, 'evidence'), { recursive: true });
    writeFileSync(join(dir, 'report.md'), validFiles({}).report);
    writeFileSync(join(dir, 'verdict.txt'), 'merge-ready\n');
    writeFileSync(
      join(dir, 'assertions.json'),
      '{"pass":1,"fail":0,"total":1}',
    );
    writeFileSync(
      join(dir, 'boundary.json'),
      JSON.stringify({
        mode: 'waived',
        by: 'maintainer',
        approval: APPROVAL,
        reason: 'why',
      }),
    );
    writeFileSync(join(dir, 'evidence/01-x.png'), 'png');
    return { root, dir };
  };

  it('refuses a snapshot planted at the clone root without --context-root', () => {
    const { root, dir } = setupClone();
    const planted = join(root, 'snapshot.json');
    writeFileSync(
      planted,
      JSON.stringify({ repo: 'evil/repo', pr: 9, headRefOid: HEAD }),
    );
    const res = spawnSync(
      process.execPath,
      [SCRIPT, '--context', planted, dir],
      { encoding: 'utf8', env: { ...process.env, QWEN_VERIFY_CONTEXT: '' } },
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(
      /must not point inside the PR-writable worktree/,
    );
  });

  it('rejects a --context-root that does not contain the artifact dir', () => {
    const { dir } = setupClone();
    const elsewhere = mkdtempSync(join(tmpdir(), 'verify-pr-r15-other-'));
    tmpDirs.push(elsewhere);
    const res = spawnSync(
      process.execPath,
      [SCRIPT, '--context-root', elsewhere, dir],
      { encoding: 'utf8', env: { ...process.env, QWEN_VERIFY_CONTEXT: '' } },
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/does not contain the artifact directory/);
  });

  it('rejects a --context-root that is not a directory', () => {
    const { root, dir } = setupClone();
    const file = join(root, 'not-a-dir');
    writeFileSync(file, 'x');
    const res = spawnSync(
      process.execPath,
      [SCRIPT, '--context-root', file, dir],
      { encoding: 'utf8', env: { ...process.env, QWEN_VERIFY_CONTEXT: '' } },
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/does not contain the artifact directory/);
  });
});

describe('containerNonceErrors (R16-1 / D17-1 / D17-2)', () => {
  const boundary = JSON.stringify({
    mode: 'container',
    detail: 'node:22-bookworm, --network none',
  });
  const gateWith = (extra = {}) =>
    JSON.stringify({
      gate: 'require-isolation',
      passed: true,
      observed: ['/.dockerenv'],
      signals: ['/.dockerenv'],
      credentialFree: true,
      nonceSha256: NONCE_SHA256,
      ...extra,
    });
  const dirWithLog = (line) => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-pr-nonce-'));
    tmpDirs.push(dir);
    if (line !== null) writeFileSync(join(dir, 'harness.log'), line);
    return dir;
  };

  it('accepts a container claim whose log line hashes to the record', () => {
    const dir = dirWithLog(`container-nonce: ${NONCE}\n`);
    expect(containerNonceErrors(boundary, gateWith(), dir)).toEqual([]);
  });

  it('finds the nonce line in a nested log directory', () => {
    const dir = dirWithLog(null);
    mkdirSync(join(dir, 'logs'));
    writeFileSync(join(dir, 'logs', 'run.log'), `container-nonce: ${NONCE}\n`);
    expect(containerNonceErrors(boundary, gateWith(), dir)).toEqual([]);
  });

  // R1-2/R2-5: the checker is the single authoritative matcher and reads each
  // file whole (aggregate-bounded), so a 17 MiB log with the nonce on line 1
  // is accepted, and so is a marker sitting BEHIND >1 MiB of earlier output
  // (a consolidated harness.log) — a per-file prefix cap would falsely refuse
  // both. The aggregate budget, not a per-file cap, bounds the work.
  it('accepts a nonce line at the start of a 17 MiB log', () => {
    const dir = dirWithLog(null);
    writeFileSync(
      join(dir, 'big.log'),
      `container-nonce: ${NONCE}\n` + 'x'.repeat(17 * 1024 * 1024),
    );
    expect(containerNonceErrors(boundary, gateWith(), dir)).toEqual([]);
  });

  it('accepts a marker behind more than 1 MiB of earlier output', () => {
    const dir = dirWithLog(null);
    writeFileSync(
      join(dir, 'harness.log'),
      'x'.repeat(2 * 1024 * 1024) + `\ncontainer-nonce: ${NONCE}\n`,
    );
    expect(containerNonceErrors(boundary, gateWith(), dir)).toEqual([]);
  });

  // R2-6: pin the checker's own line semantics (the shell no longer mirrors
  // them). The marker may sit anywhere on the line (not anchored), and the
  // WHOLE first whitespace-delimited token is hashed (a suffix changes it).
  it('matches a marker preceded by other text on the line', () => {
    const dir = dirWithLog(`[12:04] container-nonce: ${NONCE}\n`);
    expect(containerNonceErrors(boundary, gateWith(), dir)).toEqual([]);
  });

  it('hashes the whole first token, so a suffix breaks the match', () => {
    const dir = dirWithLog(`container-nonce: ${NONCE}XYZ\n`);
    expect(containerNonceErrors(boundary, gateWith(), dir).join('\n')).toMatch(
      /no container-nonce line whose sha256 matches/,
    );
  });

  it('matches a marker line split across read chunks', () => {
    const dir = dirWithLog(null);
    // Pad to just under a chunk so the marker line straddles the 1 MiB boundary.
    const pad = 'x'.repeat(1024 * 1024 - 10);
    writeFileSync(
      join(dir, 'harness.log'),
      `${pad}\ncontainer-nonce: ${NONCE}\n`,
    );
    expect(containerNonceErrors(boundary, gateWith(), dir)).toEqual([]);
  });

  // R3-1: the byte budget must not be charged against the binary evidence/
  // subtree, or a compliant round with large evidence is refused even though
  // harness.log carries the marker.
  it('accepts a marker when evidence alone exceeds the byte budget', () => {
    const dir = dirWithLog(`container-nonce: ${NONCE}\n`);
    mkdirSync(join(dir, 'evidence'));
    writeFileSync(
      join(dir, 'evidence', 'big.png'),
      'x'.repeat(65 * 1024 * 1024),
    );
    expect(containerNonceErrors(boundary, gateWith(), dir)).toEqual([]);
  });

  // R3-3: a marker line with no trailing newline is still matched (final carry),
  // including at the end of a multi-MiB no-newline file (capped carry, bounded).
  it('matches a marker line with no trailing newline', () => {
    const dir = dirWithLog(`container-nonce: ${NONCE}`);
    expect(containerNonceErrors(boundary, gateWith(), dir)).toEqual([]);
  });

  it('matches a marker at the end of a no-newline multi-MiB file', () => {
    const dir = dirWithLog(null);
    writeFileSync(
      join(dir, 'harness.log'),
      'x'.repeat(2 * 1024 * 1024) + `container-nonce: ${NONCE}`,
    );
    expect(containerNonceErrors(boundary, gateWith(), dir)).toEqual([]);
  });

  // R3-2: the matcher's own CRLF / NUL witnesses (the shell no longer mirrors it).
  it('accepts a CRLF-terminated marker line', () => {
    const dir = dirWithLog(`container-nonce: ${NONCE}\r\n`);
    expect(containerNonceErrors(boundary, gateWith(), dir)).toEqual([]);
  });

  it('accepts a marker in a log that also contains a NUL byte', () => {
    const dir = dirWithLog(null);
    writeFileSync(
      join(dir, 'harness.log'),
      `PASS\x00cell\ncontainer-nonce: ${NONCE}\n`,
    );
    expect(containerNonceErrors(boundary, gateWith(), dir)).toEqual([]);
  });

  // R3-3: a compliant marker line straddling a chunk boundary with >256 B of
  // itself before the boundary must still be found. A complete line precedes it
  // so the chunk has a newline (lastNl >= 0): the marker sits in the partial
  // line after that newline, which must be SCANNED before the carry is capped,
  // or the marker at its head is dropped and the round falsely refused.
  it('accepts a marker line straddling a chunk boundary with >256 B before it', () => {
    const dir = dirWithLog(null);
    const lineA = 'x'.repeat(1024 * 1024 - 500 - 1) + '\n';
    const lineB = `container-nonce: ${NONCE} ` + 'y'.repeat(599);
    writeFileSync(join(dir, 'harness.log'), lineA + lineB + '\n');
    expect(containerNonceErrors(boundary, gateWith(), dir)).toEqual([]);
  });

  // R4-1: exhausting the byte budget before reaching the marker gives a
  // bound-specific refusal, not the false "no matching line" diagnosis.
  it('gives a bound-specific refusal when the marker is beyond the byte budget', () => {
    const dir = dirWithLog(null);
    writeFileSync(
      join(dir, 'harness.log'),
      'x'.repeat(65 * 1024 * 1024) + `\ncontainer-nonce: ${NONCE}\n`,
    );
    const message = containerNonceErrors(boundary, gateWith(), dir).join('\n');
    expect(message).toMatch(/hit its resource bound/);
    expect(message).toMatch(/--execution host\|vm/);
    expect(message).toMatch(/BEFORE the battery/);
    expect(message).toMatch(/never hand-write the declaration/);
    expect(message).not.toMatch(/declare mode:"waived"/);
  });

  // R4-4: directories count against the entry cap, so a planted forest of empty
  // dirs trips the bound (bounded message) rather than walking unbounded.
  it('counts directories against the entry cap', () => {
    const dir = dirWithLog(null);
    for (let i = 0; i < 20001; i++) mkdirSync(join(dir, `d${i}`));
    expect(containerNonceErrors(boundary, gateWith(), dir).join('\n')).toMatch(
      /hit its resource bound/,
    );
  });

  // R5-3: regular files count against the entry cap too — the byte budget
  // cannot bound zero-byte logs, so the file branch's visited++ is the only
  // bound left. Deleting it must red this: the walk would otherwise traverse
  // an unbounded number of empty files before answering (a hang, not a refusal).
  it('counts files against the entry cap', () => {
    const dir = dirWithLog(null);
    for (let i = 0; i < 20001; i++) writeFileSync(join(dir, `f${i}`), '');
    expect(containerNonceErrors(boundary, gateWith(), dir).join('\n')).toMatch(
      /hit its resource bound/,
    );
  });

  // R4-5: only the TOP-LEVEL evidence/ subtree is exempt; a nested dir named
  // evidence (under logs/) is still scanned, so a marker there is found.
  it('scans a nested evidence dir that is not the top-level subtree', () => {
    const dir = dirWithLog(null);
    mkdirSync(join(dir, 'logs', 'evidence'), { recursive: true });
    writeFileSync(
      join(dir, 'logs', 'evidence', 'run.log'),
      `container-nonce: ${NONCE}\n`,
    );
    expect(containerNonceErrors(boundary, gateWith(), dir)).toEqual([]);
  });

  it('refuses a plaintext-only legacy record with no nonceSha256', () => {
    const dir = dirWithLog(`container-nonce: ${NONCE}\n`);
    const legacy = JSON.stringify({
      gate: 'require-isolation',
      passed: true,
      observed: ['/.dockerenv'],
      signals: ['/.dockerenv'],
      credentialFree: true,
      nonce: NONCE,
    });
    expect(containerNonceErrors(boundary, legacy, dir).join('\n')).toMatch(
      /records no nonceSha256/,
    );
  });

  it('refuses a non-hex nonceSha256', () => {
    const dir = dirWithLog(`container-nonce: ${NONCE}\n`);
    expect(
      containerNonceErrors(
        boundary,
        gateWith({ nonceSha256: 'xyz' }),
        dir,
      ).join('\n'),
    ).toMatch(/records no nonceSha256/);
  });

  it('refuses when a log line hashes differently from the record', () => {
    const dir = dirWithLog('container-nonce: deadbeef\n');
    expect(containerNonceErrors(boundary, gateWith(), dir).join('\n')).toMatch(
      /no container-nonce line whose sha256 matches/,
    );
  });

  it('refuses when the round dir carries no nonce line at all', () => {
    const dir = dirWithLog(null);
    expect(containerNonceErrors(boundary, gateWith(), dir).join('\n')).toMatch(
      /no container-nonce line whose sha256 matches/,
    );
  });

  it('does not follow a symlinked log outside the round dir', () => {
    const dir = dirWithLog(null);
    const outside = mkdtempSync(join(tmpdir(), 'verify-pr-nonce-src-'));
    tmpDirs.push(outside);
    writeFileSync(join(outside, 'src.log'), `container-nonce: ${NONCE}\n`);
    symlinkSync(join(outside, 'src.log'), join(dir, 'link.log'));
    expect(containerNonceErrors(boundary, gateWith(), dir).join('\n')).toMatch(
      /no container-nonce line whose sha256 matches/,
    );
  });

  it('names prepare-authored host/VM approval before the battery (D17-2)', () => {
    const dir = dirWithLog(null);
    const message = containerNonceErrors(boundary, gateWith(), dir).join('\n');
    expect(message).toMatch(
      /keep the current head\/round in-flight registration/,
    );
    expect(message).not.toMatch(/release any in-flight registration/);
    expect(message).toMatch(/--execution host\|vm/);
    expect(message).toMatch(/BEFORE the battery/);
    expect(message).toMatch(/never hand-write the declaration/);
  });

  it('exempts the ci-lane record and non-container modes', () => {
    const dir = dirWithLog(null);
    expect(
      containerNonceErrors(
        boundary,
        JSON.stringify({ gate: 'ci-lane', passed: true }),
        dir,
      ),
    ).toEqual([]);
    expect(
      containerNonceErrors(JSON.stringify({ mode: 'waived' }), gateWith(), dir),
    ).toEqual([]);
    expect(
      containerNonceErrors(JSON.stringify({ mode: 'vm' }), gateWith(), dir),
    ).toEqual([]);
  });

  it('leaves a missing or invalid gate to gateRecordErrors', () => {
    const dir = dirWithLog(null);
    expect(containerNonceErrors(boundary, null, dir)).toEqual([]);
    expect(containerNonceErrors(boundary, '{bad', dir)).toEqual([]);
    expect(
      containerNonceErrors(boundary, gateWith({ passed: false }), dir),
    ).toEqual([]);
  });

  it('the CLI refuses a container round whose logs lack the nonce line', () => {
    const dir = makeArtifactDir(validFiles({}));
    rmSync(join(dir, 'harness.log'));
    const res = spawnSync(process.execPath, [SCRIPT, dir], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/no container-nonce line whose sha256 matches/);
  });

  // R1-7: the exemption is the record, not the flag. A local run that passes
  // --publish-lane with a require-isolation record and no nonce line is still
  // refused; the ci-lane record the publish job writes stays exempt.
  it('refuses a no-nonce require-isolation round even under --publish-lane', () => {
    const dir = makeArtifactDir(validFiles({}));
    rmSync(join(dir, 'harness.log'));
    const res = spawnSync(process.execPath, [SCRIPT, '--publish-lane', dir], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/no container-nonce line whose sha256 matches/);
  });

  it('exempts the ci-lane record under --publish-lane without a nonce line', () => {
    const dir = makeArtifactDir(
      validFiles({
        boundaryGate: JSON.stringify({ gate: 'ci-lane', passed: true }),
      }),
    );
    rmSync(join(dir, 'harness.log'));
    const res = spawnSync(process.execPath, [SCRIPT, '--publish-lane', dir], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
    });
    expect(res.status).toBe(0);
  });

  // R2-7: $QWEN_VERIFY_CONTEXT non-empty must not switch the binding off for a
  // require-isolation container claim — the exemption is the record, not a flag.
  it('refuses a no-nonce require-isolation round even with QWEN_VERIFY_CONTEXT set', () => {
    const dir = makeArtifactDir(validFiles({}));
    rmSync(join(dir, 'harness.log'));
    const res = spawnSync(process.execPath, [SCRIPT, dir], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_VERIFY_CONTEXT: '1' },
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/no container-nonce line whose sha256 matches/);
  });
});

describe('R17-1 / R2-1 trust-boundary witnesses', () => {
  // The trust refusal must fail closed on the layouts the path-string test
  // missed, and a hard link must not let a PR-writable snapshot judge its own
  // waiver. The alias guard is the link count: a freshly written host copy has
  // exactly one name, so a second name means the round may control the file —
  // wherever the source lives, readable or not (R1-1, R1-2). The link count
  // still does not prove the host wrote a single-link file, so the content
  // digest prepare printed host-side binds the bytes (R2-1).
  const populate = (dir) => {
    const files = validFiles({});
    mkdirSync(join(dir, 'evidence'), { recursive: true });
    writeFileSync(join(dir, 'report.md'), files.report);
    writeFileSync(join(dir, 'verdict.txt'), files.verdict);
    writeFileSync(join(dir, 'assertions.json'), files.assertions);
    writeFileSync(join(dir, 'boundary.json'), files.boundary);
    writeFileSync(join(dir, 'boundary-gate.json'), files.boundaryGate);
    writeFileSync(join(dir, 'harness.log'), `container-nonce: ${NONCE}\n`);
    writeFileSync(join(dir, 'evidence/01-x.png'), 'png');
  };
  const snapshot = JSON.stringify({
    repo: 'QwenLM/qwen-code',
    pr: 7,
    headRefOid: HEAD,
  });
  const run = (args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_VERIFY_CONTEXT: '' },
    });
  // The derived-'/' witnesses need a real, writable root-level /tmp; CI routes
  // os.tmpdir() elsewhere, so they must not rely on it (R1-3).
  const rootTmpUsable = (() => {
    try {
      accessSync('/tmp', constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();
  const cloneLayout = (prefix) => {
    const base = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(base);
    const clone = join(base, 'clone');
    const dir = join(clone, 'tmp', 'pr7-verify-20261115-000000');
    mkdirSync(dir, { recursive: true });
    populate(dir);
    return { base, clone, dir };
  };

  it.skipIf(process.platform === 'win32' || !rootTmpUsable)(
    'refuses a host copy when the round dir sits directly under root-level tmp',
    () => {
      // Literal root-level /tmp so the fallback trustRoot is '/'. The snapshot
      // is a genuine one-link host copy OUTSIDE the artifact dir, so only the
      // root-aware path predicate can refuse it — not the link count.
      const dir = mkdtempSync('/tmp/pr7-verify-r17a-');
      tmpDirs.push(dir);
      populate(dir);
      const base = mkdtempSync(join(tmpdir(), 'verify-pr-r17a-host-'));
      tmpDirs.push(base);
      const host = join(base, 'host-snapshot.json');
      writeFileSync(host, snapshot);
      const res = run(['--context', host, dir]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/contains every path/);
      // Derived-root remedy is to move the dir, not to pass --context-root
      // (no clone can contain it) — R1-4.
      expect(res.stderr).toMatch(/move the artifact dir/);
      expect(res.stderr).not.toMatch(/pass the PR clone path/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a hard-link alias of the round context planted outside the root',
    () => {
      const { base, clone, dir } = cloneLayout('verify-pr-r17b-');
      writeFileSync(join(dir, 'context.json'), snapshot);
      const outside = join(base, 'host-copy.json');
      linkSync(join(dir, 'context.json'), outside);
      const res = run(['--context', outside, '--context-root', clone, dir]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/hard link/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a hard-link alias sourced from the clone verify-context sibling',
    () => {
      // R1-1: the source is outside the artifact dir, so a one-directory walk
      // would miss it; the link count catches it regardless of source path.
      const { base, clone, dir } = cloneLayout('verify-pr-r17b2-');
      const siblingDir = join(clone, 'tmp', 'verify-context');
      mkdirSync(siblingDir, { recursive: true });
      writeFileSync(join(siblingDir, 'pr7.json'), snapshot);
      const outside = join(base, 'host-copy.json');
      linkSync(join(siblingDir, 'pr7.json'), outside);
      const res = run(['--context', outside, '--context-root', clone, dir]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/hard link/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a hard-link alias whose in-dir source is unreadable',
    () => {
      // R1-2 / F1: the source sits under a chmod-000 subdirectory. The link
      // count refuses without reading that directory, so hiding it cannot help.
      const { base, clone, dir } = cloneLayout('verify-pr-r17b3-');
      const hidden = join(dir, 'hidden');
      mkdirSync(hidden, { recursive: true });
      writeFileSync(join(hidden, 'planted.json'), snapshot);
      const outside = join(base, 'host-copy.json');
      linkSync(join(hidden, 'planted.json'), outside);
      chmodSync(hidden, 0o000);
      try {
        const res = run(['--context', outside, '--context-root', clone, dir]);
        expect(res.status).toBe(1);
        expect(res.stderr).toMatch(/hard link/);
      } finally {
        chmodSync(hidden, 0o755);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a hard-link alias under the fallback trust root',
    () => {
      // No --context-root: the alias is refused with the derived root too.
      const { base, dir } = cloneLayout('verify-pr-r17b4-');
      writeFileSync(join(dir, 'context.json'), snapshot);
      const outside = join(base, 'host-copy.json');
      linkSync(join(dir, 'context.json'), outside);
      const res = run(['--context', outside, dir]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/hard link/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'accepts a genuine host-held snapshot outside the root (no false alias)',
    () => {
      const { base, clone, dir } = cloneLayout('verify-pr-r17c-');
      const outside = join(base, 'host-snapshot.json');
      writeFileSync(outside, snapshot);
      const res = run(['--context', outside, '--context-root', clone, dir]);
      expect(res.status).toBe(0);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'accepts a host copy that only shares the clone name prefix',
    () => {
      // A bare startsWith(root) would falsely refuse this sibling (M7).
      const base = mkdtempSync(join(tmpdir(), 'verify-pr-r17c2-'));
      tmpDirs.push(base);
      const clone = join(base, 'qwen-code');
      const dir = join(clone, 'tmp', 'pr7-verify-20261115-000000');
      mkdirSync(dir, { recursive: true });
      populate(dir);
      const beside = join(base, 'qwen-code-verify');
      mkdirSync(beside, { recursive: true });
      const host = join(beside, 'pr7.json');
      writeFileSync(host, snapshot);
      const res = run(['--context', host, '--context-root', clone, dir]);
      expect(res.status).toBe(0);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a --context-root of / is a usage error that names the clone remedy',
    () => {
      const dir = makeArtifactDir(validFiles({}), ['01-ab-cells.png']);
      const base = mkdtempSync(join(tmpdir(), 'verify-pr-r17d-'));
      tmpDirs.push(base);
      const host = join(base, 'host-snapshot.json');
      writeFileSync(host, snapshot);
      const res = run(['--context', host, '--context-root', '/', dir]);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/filesystem root/);
      expect(res.stderr).toMatch(/pass the PR clone path/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a --context-root of / is a usage error even without --context (R2-2)',
    () => {
      const dir = makeArtifactDir(validFiles({}), ['01-ab-cells.png']);
      const res = run(['--context-root', '/', dir]);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/filesystem root/);
    },
  );

  // R2-1: a single link does not prove the host wrote the snapshot. The round
  // can rewrite the bytes through an in-clone alias then unlink it (link count
  // back to 1), or write a fresh single-link file at a writable path. The
  // content digest prepare printed host-side is what binds the provenance.
  const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
  const forged = JSON.stringify({
    repo: 'QwenLM/qwen-code',
    pr: 17185,
    headRefOid: 'c'.repeat(40),
  });

  it.skipIf(process.platform === 'win32')(
    'refuses coords rewritten through an in-clone alias then unlinked (R2-1 B)',
    () => {
      const { base, clone, dir } = cloneLayout('verify-pr-r2-1b-');
      const host = join(base, 'host-snapshot.json');
      writeFileSync(host, snapshot);
      const digest = sha256(snapshot);
      const inDir = join(dir, 'linked-host.json');
      linkSync(host, inDir);
      writeFileSync(inDir, forged); // rewrites the shared inode, host included
      unlinkSync(inDir); // link count back to 1
      const res = run([
        '--context',
        host,
        '--context-sha256',
        digest,
        '--context-root',
        clone,
        dir,
      ]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/does not match --context-sha256/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a fresh single-link file written at a writable path (R2-1 E)',
    () => {
      const { base, clone, dir } = cloneLayout('verify-pr-r2-1e-');
      const genuine = join(base, 'genuine.json');
      writeFileSync(genuine, snapshot);
      const digest = sha256(snapshot);
      const writable = join(base, 'round-writable');
      mkdirSync(writable, { recursive: true });
      const planted = join(writable, 'ctx.json');
      writeFileSync(planted, forged);
      const res = run([
        '--context',
        planted,
        '--context-sha256',
        digest,
        '--context-root',
        clone,
        dir,
      ]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/does not match --context-sha256/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'accepts a genuine host copy whose bytes match the digest (R2-1 control)',
    () => {
      const { base, clone, dir } = cloneLayout('verify-pr-r2-1c-');
      const host = join(base, 'host-snapshot.json');
      writeFileSync(host, snapshot);
      const res = run([
        '--context',
        host,
        '--context-sha256',
        sha256(snapshot),
        '--context-root',
        clone,
        dir,
      ]);
      expect(res.status).toBe(0);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a genuine host-held approval without a context digest through the CLI',
    () => {
      const { base, clone, dir } = cloneLayout('verify-pr-approval-digest-');
      const approval = localTrustApproval();
      writeFileSync(join(dir, 'boundary.json'), JSON.stringify(approval));
      const host = join(base, 'genuine-host-approval.json');
      const trustedText = JSON.stringify({
        repo: 'QwenLM/qwen-code',
        pr: 7,
        headRefOid: HEAD,
        author: { login: 'maintainer' },
        isCrossRepository: true,
        executionApproval: approval,
      });
      writeFileSync(host, trustedText);
      const prepared = prepareArtifactWitness(
        dir,
        JSON.parse(trustedText),
        clone,
      );

      const noDigest = run([
        '--context',
        host,
        '--context-root',
        clone,
        prepared.dir,
      ]);
      expect(noDigest.status, noDigest.stdout + noDigest.stderr).toBe(1);
      expect(noDigest.stdout).toMatch(
        /boundary\.json mode waived needs --context-sha256 matching the host snapshot's bytes/,
      );

      const control = run([
        '--context',
        host,
        '--context-sha256',
        sha256(trustedText),
        '--context-root',
        clone,
        prepared.dir,
      ]);
      expect(control.status).toBe(0, control.stdout);
    },
  );

  it('rejects --context-sha256 without --context as a usage error', () => {
    const dir = makeArtifactDir(validFiles({}), ['01-ab-cells.png']);
    const res = run(['--context-sha256', sha256(snapshot), dir]);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--context-sha256 binds a --context snapshot/);
  });

  it('rejects a malformed --context-sha256 value', () => {
    const dir = makeArtifactDir(validFiles({}), ['01-ab-cells.png']);
    const res = run(['--context', 'x.json', '--context-sha256', 'nothex', dir]);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--context-sha256 requires the 64-hex digest/);
  });

  it('refuses a missing context with a diagnostic, not a crash (R3-3)', () => {
    const dir = makeArtifactDir(validFiles({}), ['01-ab-cells.png']);
    const missing = join(dir, '..', `nonexistent-${Date.now()}.json`);
    const res = run([
      '--context',
      missing,
      '--context-sha256',
      sha256(snapshot),
      dir,
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(
      /missing or unreadable; cannot verify it against --context-sha256/,
    );
  });

  it('discloses when a context is accepted without a digest binding', () => {
    const { base, clone, dir } = cloneLayout('verify-pr-disclose-');
    const host = join(base, 'host-snapshot.json');
    writeFileSync(host, snapshot);
    const res = run(['--context', host, '--context-root', clone, dir]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(
      /no --context-sha256 binding; provenance rests on the path\/link checks alone/,
    );
  });
});

// Runs on every lane (not Unix-gated): the drive-root arm must be exercised
// even where the CLI root witnesses skip (R5-2).
describe('isFilesystemRoot', () => {
  it('treats a POSIX root and a Windows drive root as filesystem roots', () => {
    expect(isFilesystemRoot('/')).toBe(true);
    expect(isFilesystemRoot('C:\\')).toBe(true);
    expect(isFilesystemRoot('C:/')).toBe(true);
    expect(isFilesystemRoot('d:\\')).toBe(true);
  });

  it('does not treat a non-root path as a filesystem root', () => {
    expect(isFilesystemRoot('/tmp')).toBe(false);
    expect(isFilesystemRoot('C:\\Users')).toBe(false);
    expect(isFilesystemRoot('C:')).toBe(false);
    expect(isFilesystemRoot('')).toBe(false);
  });
});

describe('checkExecutionRecord and microvm/provider-vm gate', () => {
  const BASE_OID = 'a'.repeat(40);
  const SHA = (ch) => ch.repeat(64);
  const sha256 = (text) =>
    createHash('sha256').update(text, 'utf8').digest('hex');

  const ANCHOR = {
    expectedHead: HEAD,
    coordinates: { owner: 'QwenLM', repo: 'qwen-code', number: 17185 },
  };

  function makeExecRecord(overrides = {}) {
    return {
      schemaVersion: 'verify-pr-exec-record-v1',
      runId: 'fc-run-01',
      repo: 'QwenLM/qwen-code',
      pr: 17185,
      baseRefOid: BASE_OID,
      headRefOid: HEAD,
      contextDigest: SHA('0'),
      prTrust: 'external',
      executionClass: 'hardware-isolated',
      backend: 'firecracker',
      backendVersion: 'v1.18.0',
      platform: 'linux-aarch64',
      kernelDigest: SHA('1'),
      rootfsDigest: SHA('2'),
      trustedInputDigest: SHA('3'),
      launchPolicyDigest: SHA('4'),
      startedAt: '2026-11-23T11:00:00Z',
      endedAt: '2026-11-23T11:00:08Z',
      destroyedAt: '2026-11-23T11:00:09Z',
      supervisorPid: 20001,
      workerPid: 20002,
      workerExe: '/firecracker-v1.18.0-aarch64',
      workerExitEvidence: 'absent',
      teardownStatus: 'destroyed',
      diskDestroyed: true,
      tokenRevoked: true,
      outputStatus: 'complete',
      ...overrides,
    };
  }

  function makeMicrovmBoundary(record, recordText, overrides = {}) {
    return {
      mode: record.backend === 'provider-vm' ? 'vm' : 'microvm',
      backend: record.backend,
      executionClass: record.executionClass,
      prTrust: record.prTrust,
      runId: record.runId,
      headRefOid: record.headRefOid,
      executionRecordSha256: sha256(recordText),
      writtenAfterTeardown: true,
      ...overrides,
    };
  }

  it('accepts a valid firecracker execution record and matching microvm boundary', () => {
    const rec = makeExecRecord();
    const recText = JSON.stringify(rec);
    const recSha = sha256(recText);
    const result = checkArtifacts({
      files: validFiles({
        report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n# Report\n\n## Methodology\n\n**Boundary.** Firecracker microVM (hardware-isolated).\n`,
        boundary: JSON.stringify(makeMicrovmBoundary(rec, recText)),
        boundaryGate: null,
      }),
      evidence: ['01-ab-cells.png'],
      expectedHead: HEAD,
      coordinates: { owner: 'QwenLM', repo: 'qwen-code', number: 17185 },
      executionRecordText: recText,
      executionRecordSha256: recSha,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('refuses an execution record presented without host-held anchoring coordinates', () => {
    // A self-consistent forged record with no --context must NOT pass: repo and
    // headRefOid would otherwise only be shape-checked (single-signal probe gap).
    const recText = JSON.stringify(makeExecRecord({ repo: 'evil/repo' }));
    const unanchored = checkExecutionRecord(recText);
    expect(unanchored.errors.join('\n')).toMatch(
      /requires a host-held --context to anchor repo, pr, and headRefOid/,
    );
    expect(unanchored.errors.join('\n')).toMatch(
      /requires a host-held --context headRefOid/,
    );

    const wrongRepo = checkExecutionRecord(recText, { ...ANCHOR });
    expect(wrongRepo.errors.join('\n')).toMatch(
      /not this round's QwenLM\/qwen-code#17185/,
    );

    const movedHead = checkExecutionRecord(
      JSON.stringify(makeExecRecord({ headRefOid: 'c'.repeat(40) })),
      { ...ANCHOR },
    );
    expect(movedHead.errors.join('\n')).toMatch(/does not match expected head/);

    const badSchema = checkExecutionRecord(
      JSON.stringify(makeExecRecord({ schemaVersion: 'poc-exec-record-v1' })),
      { ...ANCHOR },
    );
    expect(badSchema.errors.join('\n')).toMatch(/schemaVersion must be/);

    const badSupervisor = checkExecutionRecord(
      JSON.stringify(makeExecRecord({ supervisorPid: 0.5 })),
      { ...ANCHOR },
    );
    expect(badSupervisor.errors.join('\n')).toMatch(
      /supervisorPid must be an integer/,
    );
  });

  it('accepts a valid provider-vm execution record and mode vm boundary', () => {
    const rec = makeExecRecord({
      backend: 'provider-vm',
      backendVersion: 'aliyun-ecs-2014-05-26',
      platform: 'aliyun-cn-hangzhou',
      providerLifecycle: {
        allocationId: 'i-bp1test001',
        freshDiskId: 'd-bp1test001',
        boundRunId: 'fc-run-01',
        boundHeadRefOid: HEAD,
        terminationState: 'terminated',
        diskDeleted: true,
      },
    });
    const recText = JSON.stringify(rec);
    const result = checkArtifacts({
      files: validFiles({
        report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n# Report\n\n## Methodology\n\n**Boundary.** Disposable Aliyun provider-vm (hardware-isolated).\n`,
        boundary: JSON.stringify(makeMicrovmBoundary(rec, recText)),
        boundaryGate: null,
      }),
      evidence: ['01-ab-cells.png'],
      expectedHead: HEAD,
      coordinates: { owner: 'QwenLM', repo: 'qwen-code', number: 17185 },
      executionRecordText: recText,
      executionRecordSha256: sha256(recText),
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('refuses mode microvm or backend provider-vm without a host execution record', () => {
    const rec = makeExecRecord();
    const recText = JSON.stringify(rec);
    expect(
      checkBoundary(
        JSON.stringify(makeMicrovmBoundary(rec, recText)),
      ).errors.join('\n'),
    ).toMatch(/requires a host-held --execution-record/);
    expect(
      checkBoundary(
        JSON.stringify({ mode: 'vm', backend: 'provider-vm' }),
      ).errors.join('\n'),
    ).toMatch(/requires a host-held --execution-record/);
  });

  it('refuses incomplete outputStatus, undestroyed teardown, live worker, and missing disk/token cleanup', () => {
    for (const [override, pattern] of [
      [{ outputStatus: 'truncated' }, /outputStatus must be "complete"/],
      [{ outputStatus: 'timeout' }, /outputStatus must be "complete"/],
      [{ teardownStatus: 'running' }, /teardownStatus must be "destroyed"/],
      [{ teardownStatus: 'failed' }, /teardownStatus must be "destroyed"/],
      [{ workerExitEvidence: 'alive' }, /workerExitEvidence must be "absent"/],
      [{ diskDestroyed: false }, /diskDestroyed must be true/],
      [{ tokenRevoked: false }, /tokenRevoked must be true/],
    ]) {
      const checkRes = checkExecutionRecord(
        JSON.stringify(makeExecRecord(override)),
        { ...ANCHOR },
      );
      expect(checkRes.errors.join('\n')).toMatch(pattern);
    }
  });

  it('refuses external/unknown PRs on trusted-shared-kernel and container backends claiming hardware-isolated', () => {
    for (const prTrust of ['external', 'unknown']) {
      const res = checkExecutionRecord(
        JSON.stringify(
          makeExecRecord({
            prTrust,
            executionClass: 'trusted-shared-kernel',
            backend: 'container',
          }),
        ),
        { ...ANCHOR },
      );
      expect(res.errors.join('\n')).toMatch(
        /requires executionClass=hardware-isolated/,
      );
    }
    const fakeHw = checkExecutionRecord(
      JSON.stringify(
        makeExecRecord({
          executionClass: 'hardware-isolated',
          backend: 'docker',
        }),
      ),
      { expectedHead: HEAD },
    );
    expect(fakeHw.errors.join('\n')).toMatch(
      /executionClass=hardware-isolated requires backend in/,
    );
  });

  it('refuses provider-vm records missing termination or disk deletion proof', () => {
    const missing = checkExecutionRecord(
      JSON.stringify(makeExecRecord({ backend: 'provider-vm' })),
      { expectedHead: HEAD },
    );
    expect(missing.errors.join('\n')).toMatch(/providerLifecycle is required/);

    const alive = checkExecutionRecord(
      JSON.stringify(
        makeExecRecord({
          backend: 'provider-vm',
          providerLifecycle: {
            allocationId: 'i-1',
            freshDiskId: 'd-1',
            boundRunId: 'fc-run-01',
            boundHeadRefOid: HEAD,
            terminationState: 'running',
            diskDeleted: false,
          },
        }),
      ),
      { expectedHead: HEAD },
    );
    expect(alive.errors.join('\n')).toMatch(
      /terminationState must be "terminated"/,
    );
    expect(alive.errors.join('\n')).toMatch(/diskDeleted must be true/);
  });

  it('refuses headRefOid mismatch and coordinate mismatch', () => {
    const moved = checkExecutionRecord(
      JSON.stringify(makeExecRecord({ headRefOid: 'c'.repeat(40) })),
      { expectedHead: HEAD },
    );
    expect(moved.errors.join('\n')).toMatch(/does not match expected head/);

    const wrongPr = checkExecutionRecord(
      JSON.stringify(makeExecRecord({ pr: 12345 })),
      {
        expectedHead: HEAD,
        coordinates: { owner: 'QwenLM', repo: 'qwen-code', number: 17185 },
      },
    );
    expect(wrongPr.errors.join('\n')).toMatch(
      /not this round's QwenLM\/qwen-code#17185/,
    );

    const wrongCtxSha = checkExecutionRecord(JSON.stringify(makeExecRecord()), {
      ...ANCHOR,
      expectedContextSha256: SHA('9'),
    });
    expect(wrongCtxSha.errors.join('\n')).toMatch(
      /contextDigest .* does not match host context sha256/,
    );

    const downgraded = checkExecutionRecord(
      JSON.stringify(
        makeExecRecord({
          prTrust: 'collaborator',
          executionClass: 'trusted-shared-kernel',
          backend: 'container',
        }),
      ),
      {
        ...ANCHOR,
        requiredExecutionClass: 'hardware-isolated',
      },
    );
    expect(downgraded.errors.join('\n')).toMatch(
      /violates host context requirement executionClass=hardware-isolated/,
    );

    const badTime = checkExecutionRecord(
      JSON.stringify(
        makeExecRecord({
          startedAt: '1',
          endedAt: '2026-11-23T10:00:00Z',
        }),
      ),
      { expectedHead: HEAD },
    );
    expect(badTime.errors.join('\n')).toMatch(
      /valid ISO startedAt and endedAt/,
    );

    const reversedTime = checkExecutionRecord(
      JSON.stringify(
        makeExecRecord({
          startedAt: '2026-11-23T11:00:10Z',
          endedAt: '2026-11-23T11:00:05Z',
        }),
      ),
      { expectedHead: HEAD },
    );
    expect(reversedTime.errors.join('\n')).toMatch(
      /endedAt must not precede startedAt/,
    );

    const waivedConflict = checkBoundary(
      JSON.stringify({
        mode: 'waived',
        by: 'maintainer',
        reason: 'test',
        approval: APPROVAL,
      }),
      null,
      { executionRecord: makeExecRecord() },
    );
    expect(waivedConflict.errors.join('\n')).toMatch(
      /mode waived contradicts a host --execution-record/,
    );
  });

  it('CLI accepts a host-held --execution-record with matching --execution-record-sha256 and refuses tampered, linked, in-tree, or guest-planted records', () => {
    const base = mkdtempSync(join(tmpdir(), 'verify-pr-exec-rec-'));
    tmpDirs.push(base);
    const clone = join(base, 'clone');
    const dir = join(clone, 'tmp', 'pr17185-verify-20261123');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'evidence'), { recursive: true });
    writeFileSync(join(dir, 'evidence', '01-ab.png'), 'png');

    const files = validFiles({
      report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n# Report\n\n## Methodology\n\n**Boundary.** Firecracker microVM (hardware-isolated).\n`,
      boundaryGate: undefined,
    });
    writeFileSync(join(dir, 'report.md'), files.report);
    writeFileSync(join(dir, 'verdict.txt'), files.verdict);
    writeFileSync(join(dir, 'assertions.json'), files.assertions);

    const run = (args) =>
      spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

    // Host-held context anchoring the record to this round (required since
    // an execution record without --context cannot be anchored).
    const hostCtx = join(base, 'host-context.json');
    const ctxText = JSON.stringify({
      repo: 'QwenLM/qwen-code',
      pr: 17185,
      baseRefOid: BASE_OID,
      headRefOid: HEAD,
      trustClassification: {
        prTrust: 'external',
        executionClass: 'hardware-isolated',
        escalationReasons: [],
        headRefOid: HEAD,
      },
    });
    writeFileSync(hostCtx, ctxText);
    const ctxSha = sha256(ctxText);
    const anchor = ['--context', hostCtx, '--context-sha256', ctxSha];

    // Rebuild the record bound to the real context digest so the positive
    // control exercises anchoring + contextDigest binding together.
    const boundRec = makeExecRecord({ contextDigest: ctxSha });
    const boundRecText = JSON.stringify(boundRec, null, 2);
    const boundRecSha = sha256(boundRecText);
    const hostRec = join(base, 'host-execution-record.json');
    writeFileSync(hostRec, boundRecText);
    writeFileSync(
      join(dir, 'boundary.json'),
      JSON.stringify(makeMicrovmBoundary(boundRec, boundRecText)),
    );

    // 1. Valid host-held record with digest binding AND anchoring context exits 0
    const ok = run([
      '--context-root',
      clone,
      ...anchor,
      '--execution-record',
      hostRec,
      '--execution-record-sha256',
      boundRecSha,
      dir,
    ]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/ok: verdict=merge-ready/);

    // 1b. An otherwise valid record presented WITHOUT a --context anchor is refused
    const noAnchor = run([
      '--context-root',
      clone,
      '--execution-record',
      hostRec,
      '--execution-record-sha256',
      boundRecSha,
      dir,
    ]);
    expect(noAnchor.status).toBe(1);
    expect(noAnchor.stdout).toMatch(
      /requires a host-held --context to anchor repo, pr, and headRefOid/,
    );

    // 2. Wrong sha256 fails closed
    const badSha = run([
      '--context-root',
      clone,
      ...anchor,
      '--execution-record',
      hostRec,
      '--execution-record-sha256',
      SHA('f'),
      dir,
    ]);
    expect(badSha.status).toBe(1);
    expect(badSha.stderr).toMatch(/does not match --execution-record-sha256/);

    // 3. --execution-record-sha256 without --execution-record is usage error 2
    const orphanSha = run(['--execution-record-sha256', boundRecSha, dir]);
    expect(orphanSha.status).toBe(2);

    // 4. Execution record placed inside PR-writable clone is refused
    const inTreeRec = join(clone, 'in-tree-record.json');
    writeFileSync(inTreeRec, boundRecText);
    const inTree = run([
      '--context-root',
      clone,
      ...anchor,
      '--execution-record',
      inTreeRec,
      '--execution-record-sha256',
      boundRecSha,
      dir,
    ]);
    expect(inTree.status).toBe(1);
    expect(inTree.stderr).toMatch(
      /must not point inside the PR-writable worktree/,
    );

    // 5. Symlink --execution-record is refused
    const symRec = join(base, 'sym-record.json');
    symlinkSync(hostRec, symRec);
    const symRes = run([
      '--context-root',
      clone,
      ...anchor,
      '--execution-record',
      symRec,
      '--execution-record-sha256',
      boundRecSha,
      dir,
    ]);
    expect(symRes.status).toBe(1);
    expect(symRes.stderr).toMatch(/missing or unreadable/);

    // 6. Hardlink alias on --execution-record is refused
    const linkedSource = join(base, 'linked-record.json');
    const linkedAlias = join(base, 'linked-alias.json');
    writeFileSync(linkedSource, boundRecText);
    linkSync(linkedSource, linkedAlias);
    const linkRes = run([
      '--context-root',
      clone,
      ...anchor,
      '--execution-record',
      linkedAlias,
      '--execution-record-sha256',
      boundRecSha,
      dir,
    ]);
    expect(linkRes.status).toBe(1);
    expect(linkRes.stderr).toMatch(/is a hard link/);

    // 7. Guest-planted execution-record.json inside artifact dir is refused
    writeFileSync(join(dir, 'execution-record.json'), boundRecText);
    const planted = run([
      '--context-root',
      clone,
      ...anchor,
      '--execution-record',
      hostRec,
      '--execution-record-sha256',
      boundRecSha,
      dir,
    ]);
    expect(planted.status).toBe(1);
    expect(planted.stdout).toMatch(
      /execution-record\.json must not reside inside the PR-writable artifact directory/,
    );
    unlinkSync(join(dir, 'execution-record.json'));

    // 8. CLI wires host --context trustClassification & contextDigest / baseRefOid binding
    const ctxObj = {
      repo: 'QwenLM/qwen-code',
      pr: 17185,
      baseRefOid: BASE_OID,
      headRefOid: HEAD,
      trustClassification: {
        prTrust: 'external',
        executionClass: 'hardware-isolated',
        headRefOid: HEAD,
      },
    };
    // 8a. Execution record with wrong contextDigest is rejected via CLI
    const unboundRecText = JSON.stringify(makeExecRecord(), null, 2);
    const unboundRecSha = sha256(unboundRecText);
    const unboundHostRec = join(base, 'unbound-exec-record.json');
    writeFileSync(unboundHostRec, unboundRecText);
    const wrongCtxRes = run([
      ...anchor,
      '--context-root',
      clone,
      '--execution-record',
      unboundHostRec,
      '--execution-record-sha256',
      unboundRecSha,
      dir,
    ]);
    expect(wrongCtxRes.status).toBe(1);
    expect(wrongCtxRes.stdout).toMatch(
      /contextDigest .* does not match host context sha256/,
    );

    // 8b. The context-bound record from step 1 already exited 0 (ok.status above).
    expect(boundRec.contextDigest).toBe(ctxSha);

    // 8c. Stale trustClassification.headRefOid in --context is refused by CLI
    const staleCtx = join(base, 'stale-ctx.json');
    const staleText = JSON.stringify({
      ...ctxObj,
      trustClassification: {
        ...ctxObj.trustClassification,
        headRefOid: 'e'.repeat(40),
      },
    });
    writeFileSync(staleCtx, staleText);
    const staleRes = run([
      '--context',
      staleCtx,
      '--context-sha256',
      sha256(staleText),
      '--context-root',
      clone,
      dir,
    ]);
    expect(staleRes.status).toBe(1);
    expect(staleRes.stderr).toMatch(/stale trustClassification\.headRefOid/);

    // 8d. Container boundary is refused by CLI when host --context requires hardware-isolated
    const containerDir = join(
      clone,
      'tmp',
      'pr17185-verify-container-downgrade',
    );
    mkdirSync(join(containerDir, 'evidence'), { recursive: true });
    writeFileSync(join(containerDir, 'evidence', '01-ab.png'), 'png');
    const cFiles = validFiles();
    writeFileSync(join(containerDir, 'report.md'), cFiles.report);
    writeFileSync(join(containerDir, 'verdict.txt'), cFiles.verdict);
    writeFileSync(join(containerDir, 'assertions.json'), cFiles.assertions);
    writeFileSync(join(containerDir, 'boundary.json'), cFiles.boundary);
    writeFileSync(
      join(containerDir, 'boundary-gate.json'),
      cFiles.boundaryGate,
    );
    writeFileSync(join(containerDir, 'run.log'), `container-nonce: ${NONCE}\n`);
    const downgradeRes = run([
      '--context',
      hostCtx,
      '--context-sha256',
      ctxSha,
      '--context-root',
      clone,
      containerDir,
    ]);
    expect(downgradeRes.status).toBe(1);
    expect(downgradeRes.stdout).toMatch(
      /mode container violates host context requirement executionClass=hardware-isolated/,
    );

    // 8e. Self-contradictory trustClassification (external/unknown or non-empty
    // escalationReasons paired with trusted-shared-kernel) is refused by CLI & pure gate
    for (const [label, contradictoryTc, expectedRe] of [
      [
        'external-shared',
        {
          prTrust: 'external',
          executionClass: 'trusted-shared-kernel',
          escalationReasons: [],
          headRefOid: HEAD,
        },
        /prTrust=external cannot pair with executionClass="trusted-shared-kernel"/,
      ],
      [
        'unknown-shared',
        {
          prTrust: 'unknown',
          executionClass: 'trusted-shared-kernel',
          escalationReasons: [],
          headRefOid: HEAD,
        },
        /prTrust=unknown cannot pair with executionClass="trusted-shared-kernel"/,
      ],
      [
        'escalated-shared',
        {
          prTrust: 'collaborator',
          executionClass: 'trusted-shared-kernel',
          escalationReasons: ['ci-workflow:.github/workflows/ci.yml'],
          headRefOid: HEAD,
        },
        /non-empty escalationReasons cannot pair with executionClass="trusted-shared-kernel"/,
      ],
    ]) {
      const pure = checkTrustClassification(contradictoryTc, HEAD);
      expect(pure.errors.join('\n')).toMatch(expectedRe);
      expect(pure.requiredExecutionClass).toBe('hardware-isolated');

      const badCtx = join(base, `contradictory-${label}.json`);
      const badCtxText = JSON.stringify({
        ...ctxObj,
        trustClassification: contradictoryTc,
      });
      writeFileSync(badCtx, badCtxText);
      const cliBad = run([
        '--context',
        badCtx,
        '--context-sha256',
        sha256(badCtxText),
        '--context-root',
        clone,
        containerDir,
      ]);
      expect(cliBad.status).toBe(1);
      expect(cliBad.stderr).toMatch(expectedRe);
    }

    // 8f. Explicit trustClassification: null is rejected (unlike omitted legacy field)
    expect(checkTrustClassification(undefined, HEAD).errors).toEqual([]);
    expect(checkTrustClassification(null, HEAD).errors.join('\n')).toMatch(
      /trustClassification must be a JSON object/,
    );
    const directNullArtifacts = checkArtifacts({
      files: validFiles(),
      evidence: ['01-ab-cells.png'],
      expectedHead: HEAD,
      trustClassification: null,
    });
    expect(directNullArtifacts.errors.join('\n')).toMatch(
      /trustClassification must be a JSON object/,
    );
    const directUndefArtifacts = checkArtifacts({
      files: validFiles(),
      evidence: ['01-ab-cells.png'],
      expectedHead: HEAD,
      trustClassification: undefined,
    });
    expect(directUndefArtifacts.errors).toEqual([]);
    const nullTcCtx = join(base, 'null-tc.json');
    const nullTcText = JSON.stringify({ ...ctxObj, trustClassification: null });
    writeFileSync(nullTcCtx, nullTcText);
    const cliNullTc = run([
      '--context',
      nullTcCtx,
      '--context-sha256',
      sha256(nullTcText),
      '--context-root',
      clone,
      containerDir,
    ]);
    expect(cliNullTc.status).toBe(1);
    expect(cliNullTc.stderr).toMatch(
      /trustClassification must be a JSON object/,
    );

    // 8g. Hardware-isolated provider-vm uses mode:"vm" + backend:"provider-vm"
    // certified by --execution-record, not preflight executionApproval; an
    // unrecorded provider-vm declaration is still refused fail-closed.
    const providerDir = join(clone, 'tmp', 'pr17185-verify-20261124-030000');
    mkdirSync(join(providerDir, 'evidence'), { recursive: true });
    const providerRec = makeExecRecord({
      backend: 'provider-vm',
      backendVersion: 'aliyun-ecs-2014-05-26',
      platform: 'aliyun-cn-hangzhou',
      contextDigest: ctxSha,
      providerLifecycle: {
        allocationId: 'i-bp1test001',
        freshDiskId: 'd-bp1test001',
        boundRunId: 'fc-run-01',
        boundHeadRefOid: HEAD,
        terminationState: 'terminated',
        diskDeleted: true,
      },
    });
    const providerRecText = JSON.stringify(providerRec, null, 2);
    const providerRecPath = join(base, 'provider-execution-record.json');
    writeFileSync(providerRecPath, providerRecText);
    const providerFiles = validFiles({
      report: `merge-ready · 4 passed · 0 failed · 4 total · ${HEAD}\n\n# Report\n\n## Methodology\n\n**Boundary.** Disposable Aliyun provider-vm (hardware-isolated).\n`,
      boundary: JSON.stringify(
        makeMicrovmBoundary(providerRec, providerRecText),
      ),
      boundaryGate: null,
    });
    writeFileSync(join(providerDir, 'report.md'), providerFiles.report);
    writeFileSync(join(providerDir, 'verdict.txt'), providerFiles.verdict);
    writeFileSync(
      join(providerDir, 'assertions.json'),
      providerFiles.assertions,
    );
    writeFileSync(join(providerDir, 'boundary.json'), providerFiles.boundary);
    writeFileSync(join(providerDir, 'evidence', '01-ab-cells.png'), 'png');

    const providerOk = run([
      '--context-root',
      clone,
      ...anchor,
      '--execution-record',
      providerRecPath,
      '--execution-record-sha256',
      sha256(providerRecText),
      providerDir,
    ]);
    expect(providerOk.status, providerOk.stdout + providerOk.stderr).toBe(0);
    expect(providerOk.stdout).toMatch(/ok: verdict=merge-ready/);

    const providerUnrecorded = run([
      '--context-root',
      clone,
      ...anchor,
      providerDir,
    ]);
    expect(providerUnrecorded.status).toBe(1);
    expect(providerUnrecorded.stdout).toMatch(
      /requires a host-held --execution-record/,
    );

    // 8h. Attested mode:"vm" (without backend:"provider-vm") contradicts a
    // non-provider-vm host --execution-record, symmetrically with mode:"waived".
    expect(
      checkBoundary(
        JSON.stringify({
          mode: 'vm',
          by: 'wenshao',
          reason: 'manual VM round',
          attestation: 'nothing mounted, no host credentials',
          approval:
            'https://github.com/QwenLM/qwen-code/pull/17185#issuecomment-1',
        }),
        null,
        {
          coordinates: { owner: 'QwenLM', repo: 'qwen-code', number: 17185 },
          executionRecord: boundRec,
        },
      ).errors.join('\n'),
    ).toMatch(/boundary\.json mode vm contradicts a host --execution-record/);

    // 8i. A parent-directory symlink aliasing <clone>/tmp under another name
    // must not downgrade derived trustRoot/execTrustRoot when --context-root
    // is omitted: in-clone --context and --execution-record stay refused.
    const aliasParent = join(base, 'alias');
    symlinkSync(join(clone, 'tmp'), aliasParent);
    const aliasedDir = join(aliasParent, basename(dir));
    const inCloneCtx = join(clone, 'tmp', 'verify-context', 'pr17185.json');
    mkdirSync(dirname(inCloneCtx), { recursive: true });
    writeFileSync(inCloneCtx, ctxText);
    const inCloneRec = join(clone, 'forged-exec-record.json');
    writeFileSync(inCloneRec, boundRecText);

    const aliasedCtxRefused = run([
      '--context',
      inCloneCtx,
      '--context-sha256',
      ctxSha,
      '--execution-record',
      hostRec,
      '--execution-record-sha256',
      boundRecSha,
      aliasedDir,
    ]);
    expect(aliasedCtxRefused.status).toBe(1);
    expect(aliasedCtxRefused.stderr).toMatch(
      /--context must not point inside the PR-writable worktree/,
    );

    const aliasedRecRefused = run([
      '--context',
      hostCtx,
      '--context-sha256',
      ctxSha,
      '--execution-record',
      inCloneRec,
      '--execution-record-sha256',
      boundRecSha,
      aliasedDir,
    ]);
    expect(aliasedRecRefused.status).toBe(1);
    expect(aliasedRecRefused.stderr).toMatch(
      /--execution-record must not point inside the PR-writable worktree/,
    );

    // 8j. When <clone>/tmp itself is a symlink to an external directory not
    // named "tmp", both the clone root and the external container stay enclosed.
    const symlinkedClone = join(base, 'clone-symlink-tmp');
    const externalArtifacts = join(base, 'outside-artifacts');
    mkdirSync(symlinkedClone, { recursive: true });
    mkdirSync(join(externalArtifacts, 'verify-context'), { recursive: true });
    symlinkSync(externalArtifacts, join(symlinkedClone, 'tmp'));
    const symRoundDir = join(
      symlinkedClone,
      'tmp',
      'pr17185-verify-20261124-031500',
    );
    mkdirSync(join(symRoundDir, 'evidence'), { recursive: true });
    writeFileSync(join(symRoundDir, 'report.md'), validFiles().report);
    writeFileSync(join(symRoundDir, 'verdict.txt'), validFiles().verdict);
    writeFileSync(
      join(symRoundDir, 'assertions.json'),
      validFiles().assertions,
    );
    writeFileSync(
      join(symRoundDir, 'boundary.json'),
      JSON.stringify(makeMicrovmBoundary(boundRec, boundRecText)),
    );
    writeFileSync(join(symRoundDir, 'evidence', '01-ab-cells.png'), 'png');
    const cloneRootCtx = join(symlinkedClone, 'forged-ctx.json');
    writeFileSync(cloneRootCtx, ctxText);
    const cloneRootRec = join(symlinkedClone, 'forged-rec.json');
    writeFileSync(cloneRootRec, boundRecText);
    const siblingCtx = join(
      symlinkedClone,
      'tmp',
      'verify-context',
      'pr17185.json',
    );
    writeFileSync(siblingCtx, ctxText);
    for (const [label, args] of [
      [
        'clone-root context',
        [
          '--context',
          cloneRootCtx,
          '--context-sha256',
          ctxSha,
          '--execution-record',
          hostRec,
          '--execution-record-sha256',
          boundRecSha,
          symRoundDir,
        ],
      ],
      [
        'clone-root execution-record',
        [
          '--context',
          hostCtx,
          '--context-sha256',
          ctxSha,
          '--execution-record',
          cloneRootRec,
          '--execution-record-sha256',
          boundRecSha,
          symRoundDir,
        ],
      ],
      [
        'symlinked-tmp sibling context',
        [
          '--context',
          siblingCtx,
          '--context-sha256',
          ctxSha,
          '--execution-record',
          hostRec,
          '--execution-record-sha256',
          boundRecSha,
          symRoundDir,
        ],
      ],
    ]) {
      const res = run(args);
      expect(res.status, `${label}: ${res.stdout}${res.stderr}`).toBe(1);
      expect(res.stderr, label).toMatch(/must not point inside/);
    }

    // 8k. Container mode unconditionally rejects contradictory executionClass,
    // and checkArtifacts rejects mismatched prTrust between trustClassification
    // and execution-record.json.
    expect(
      checkBoundary(
        JSON.stringify({
          mode: 'container',
          detail: 'img',
          executionClass: 'hardware-isolated',
        }),
        validFiles().boundaryGate,
      ).errors.join('\n'),
    ).toMatch(/mode container cannot declare executionClass/);
    const mismatchedTrustRec = makeExecRecord({
      prTrust: 'local-owner',
      contextDigest: ctxSha,
    });
    const mismatchedTrustRecText = JSON.stringify(mismatchedTrustRec);
    const mismatchedTrustResult = checkArtifacts({
      files: validFiles({
        boundary: JSON.stringify(
          makeMicrovmBoundary(mismatchedTrustRec, mismatchedTrustRecText),
        ),
        boundaryGate: null,
      }),
      evidence: ['01-ab-cells.png'],
      expectedHead: HEAD,
      coordinates: { owner: 'QwenLM', repo: 'qwen-code', number: 17185 },
      executionRecordText: mismatchedTrustRecText,
      executionRecordSha256: sha256(mismatchedTrustRecText),
      expectedContextSha256: ctxSha,
      trustClassification: {
        prTrust: 'external',
        executionClass: 'hardware-isolated',
        escalationReasons: [],
        headRefOid: HEAD,
      },
    });
    expect(mismatchedTrustResult.errors.join('\n')).toMatch(
      /execution-record\.json prTrust .* does not match host trustClassification\.prTrust/,
    );

    // 8l. Nested symlink (<clone>/sub/alias -> <clone>/tmp -> <external-box>)
    // still encloses both the clone root and the external container when
    // --context-root is omitted.
    mkdirSync(join(symlinkedClone, 'sub'), { recursive: true });
    symlinkSync(
      join(symlinkedClone, 'tmp'),
      join(symlinkedClone, 'sub', 'alias'),
    );
    const nestedRoundDir = join(
      symlinkedClone,
      'sub',
      'alias',
      basename(symRoundDir),
    );
    for (const [label, ctxCandidate] of [
      ['nested clone-root context', cloneRootCtx],
      ['nested external-box sibling context', siblingCtx],
    ]) {
      const res = run([
        '--context',
        ctxCandidate,
        '--context-sha256',
        ctxSha,
        '--execution-record',
        hostRec,
        '--execution-record-sha256',
        boundRecSha,
        nestedRoundDir,
      ]);
      expect(res.status, `${label}: ${res.stdout}${res.stderr}`).toBe(1);
      expect(res.stderr, label).toMatch(/must not point inside/);
    }

    // 8m. Host --context with preflight executionApproval contradicts a PR-side
    // rewrite of boundary.json to mode:"container".
    expect(
      executionApprovalErrors(
        JSON.stringify({ mode: 'container', detail: 'forged' }),
        {
          headRefOid: HEAD,
          executionApproval: {
            mode: 'waived',
            source: 'local-trust',
            basis: 'own-pr',
            by: 'wenshao',
            permission: 'admin',
            head: HEAD,
            round: 1,
            reason: 'host round',
          },
        },
        { contextProvided: true, contextDigestVerified: true },
      ).join('\n'),
    ).toMatch(/contradicts boundary\.json mode container/);

    // 8n. On case-insensitive filesystems (macOS/Windows), casing variants of
    // the PR clone path cannot bypass in-clone --context / --execution-record
    // refusals.
    if (process.platform === 'darwin' || process.platform === 'win32') {
      const mixedClone = join(base, 'MixedCaseClone');
      const mixedDir = join(
        mixedClone,
        'tmp',
        'pr17185-verify-20261124-032000',
      );
      mkdirSync(join(mixedDir, 'evidence'), { recursive: true });
      mkdirSync(join(mixedClone, 'tmp', 'verify-context'), { recursive: true });
      writeFileSync(join(mixedDir, 'report.md'), validFiles().report);
      writeFileSync(join(mixedDir, 'verdict.txt'), validFiles().verdict);
      writeFileSync(join(mixedDir, 'assertions.json'), validFiles().assertions);
      writeFileSync(
        join(mixedDir, 'boundary.json'),
        JSON.stringify(makeMicrovmBoundary(boundRec, boundRecText)),
      );
      writeFileSync(join(mixedDir, 'evidence', '01-ab-cells.png'), 'png');
      const mixedCtx = join(
        mixedClone,
        'tmp',
        'verify-context',
        'pr17185.json',
      );
      writeFileSync(mixedCtx, ctxText);
      const mixedRec = join(mixedClone, 'forged-rec.json');
      writeFileSync(mixedRec, boundRecText);

      const flippedCtx = mixedCtx.replace('MixedCaseClone', 'mixedcaseclone');
      const flippedRec = mixedRec.replace('MixedCaseClone', 'mixedcaseclone');
      const caseCtxRes = run([
        '--context',
        flippedCtx,
        '--context-sha256',
        ctxSha,
        '--execution-record',
        hostRec,
        '--execution-record-sha256',
        boundRecSha,
        mixedDir,
      ]);
      expect(caseCtxRes.status).toBe(1);
      expect(caseCtxRes.stderr).toMatch(/must not point inside/);

      const caseRecRes = run([
        '--context',
        hostCtx,
        '--context-sha256',
        ctxSha,
        '--execution-record',
        flippedRec,
        '--execution-record-sha256',
        boundRecSha,
        mixedDir,
      ]);
      expect(caseRecRes.status).toBe(1);
      expect(caseRecRes.stderr).toMatch(/must not point inside/);
    }
  });
});
