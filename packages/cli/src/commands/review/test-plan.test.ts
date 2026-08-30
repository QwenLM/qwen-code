/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The two halves this command is made of, tested separately: the parsers (what
// counts as a Test Plan, what counts as a claim) and the rulings (what the tree
// says about each claim). The rulings are where a regression is expensive —
// every `contradicted` verdict becomes a note on someone's pull request, so the
// negative cases (a path that legitimately exists untouched, a count from a
// suite this review did not run) carry as much weight here as the positives.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yargs, { type Argv } from 'yargs';

// The Aone half of the platform registry — mocked so the body-fetch routing
// tests never reach a real `a1`. importOriginal keeps parseRemoteUrl and the
// write-path exports the registry module re-exports untouched. The auth
// gate is mocked with it: the Aone route runs it before any fetch, and a
// real one would exec the machine's actual a1.
const { aoneFetchMetaMock, aoneEnsureAuthMock } = vi.hoisted(() => ({
  aoneFetchMetaMock: vi.fn(),
  aoneEnsureAuthMock: vi.fn(),
}));
vi.mock('./lib/platform/aone.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./lib/platform/aone.js')>();
  return {
    ...actual,
    aoneReader: {
      ...actual.aoneReader,
      getFetchMeta: aoneFetchMetaMock,
      ensureAuthenticated: aoneEnsureAuthMock,
    },
  };
});

import {
  testPlanCommand,
  extractTestPlanSection,
  extractClaims,
  observedTestCounts,
  npmScriptOf,
  platformBodyFetcher,
  fetchPrBody,
  runTestPlan,
  type TestPlanClaim,
  type TestPlanArgs,
} from './test-plan.js';
import { getGhHost, setGhHost } from './lib/gh.js';
import type { BuildTestReport, CommandResult } from './build-test.js';
import { mavenToolchainAdapter, shellSelector } from './lib/maven-toolchain.js';

describe('extractTestPlanSection', () => {
  it('finds a `## Test Plan` heading and stops at the next same-level heading', () => {
    const s = extractTestPlanSection(
      '## Summary\n\nfixes it\n\n## Test Plan\n\n- ran `npm test`\n\n## Risk\n\nlow\n',
    );
    expect(s?.heading).toBe('## Test Plan');
    expect(s?.content).toBe('- ran `npm test`');
  });

  it('keeps sub-headings deeper than its own level', () => {
    const s = extractTestPlanSection(
      '## Test Plan\n\n### Unit\n\n`npm test`\n\n### E2E\n\nmanual\n\n## Risk\n\nlow',
    );
    expect(s?.content).toContain('### Unit');
    expect(s?.content).toContain('### E2E');
    expect(s?.content).not.toContain('## Risk');
  });

  it('stops at a HIGHER-level heading too', () => {
    const s = extractTestPlanSection(
      '### Test Plan\n\nran it\n\n## Risk\n\nlow',
    );
    expect(s?.content).toBe('ran it');
  });

  it('accepts the bold form and the Chinese headings', () => {
    expect(
      extractTestPlanSection('**Test Plan**\n\nran it\n\n**Risk**\n\nlow')
        ?.content,
    ).toBe('ran it');
    expect(
      extractTestPlanSection('## 测试计划\n\n跑了 `npm test`')?.content,
    ).toBe('跑了 `npm test`');
  });

  it('does not end the section on a `#` inside a fenced block', () => {
    // The regression this guards: a repro script's shebang read as a heading,
    // truncating the Test Plan to its first line.
    const s = extractTestPlanSection(
      '## Test Plan\n\n```bash\n#!/usr/bin/env bash\n# build first\nnpm run build\n```\n\ndone\n\n## Risk\n\nlow',
    );
    expect(s?.content).toContain('npm run build');
    expect(s?.content).toContain('done');
    expect(s?.content).not.toContain('low');
  });

  it('tracks fence markers: a ``` line inside a ~~~ fence does not close it', () => {
    const s = extractTestPlanSection(
      '## Test Plan\n\n~~~\n```\n# still fenced\nnpm test\n```\n~~~\n\nafter\n\n## Risk\n\nlow',
    );
    expect(s?.content).toContain('after');
    expect(s?.content).not.toContain('low');
  });

  it('finds a heading whose name is PREFIXED, not anchored', () => {
    // This repo's own PR template writes `## Reviewer Test Plan`. An anchored
    // pattern found neither it nor `## Reviewer 测试计划`, so the command
    // reported "no Test Plan section" on exactly the PRs it was built for.
    expect(
      extractTestPlanSection('## Reviewer Test Plan\n\nran it')?.content,
    ).toBe('ran it');
    expect(
      extractTestPlanSection('## Reviewer 测试计划\n\n跑了它')?.content,
    ).toBe('跑了它');
    expect(
      extractTestPlanSection('## Manual QA / Testing\n\nran it')?.content,
    ).toBe('ran it');
  });

  it('scans a hostile unclosed-bold line in linear time', () => {
    // Reviewed live on this PR: the old bold pattern backtracked
    // catastrophically (3.2s at 3,000 spaces) on `**` + whitespace with no
    // closer — a line an untrusted PR body controls. A regression here does
    // not fail an assertion; it hangs the test into vitest's timeout.
    const hostile = `## Summary\n\n**${' '.repeat(50_000)}\nplain text`;
    expect(extractTestPlanSection(hostile)).toBeNull();
  });

  it('does not end the section on a spaceless # line (ATX rule)', () => {
    // `#8176`, `#tag`, an unfenced `#!/bin/bash` are prose, not headings.
    const s = extractTestPlanSection(
      '## Test Plan\n\nsee #8176\n#!/usr/bin/env bash\nmore\n### done here\n\n## Risk\n\nx',
    );
    expect(s?.content).toContain('#!/usr/bin/env bash');
    expect(s?.content).toContain('more');
    expect(s?.content).not.toContain('## Risk');
  });

  it('returns null when there is no Test Plan section', () => {
    expect(extractTestPlanSection('## Summary\n\njust a change')).toBeNull();
  });
});

describe('extractClaims', () => {
  it('keeps capitalized legacy-runner prose out of the command claims', () => {
    // Case-insensitivity is granted to the Maven alternation alone
    // (`MVNW test`): the script adjudicators stay case-sensitive, so
    // capitalized legacy-runner spans would only add claims that can never
    // settle.
    expect(extractClaims('Needs `Node.js`; run `NPM RUN test:unit`')).toEqual(
      [],
    );
  });

  it('picks commands and paths out of code spans', () => {
    const claims = extractClaims(
      'Ran `npm run build` and `npm test --workspace=packages/cli`.\nAdded `packages/cli/src/a.test.ts`.',
    );
    expect(claims).toContainEqual({ kind: 'command', text: 'npm run build' });
    expect(claims).toContainEqual({
      kind: 'command',
      text: 'npm test --workspace=packages/cli',
    });
    expect(claims).toContainEqual({
      kind: 'path',
      text: 'packages/cli/src/a.test.ts',
    });
  });

  it('reads fenced blocks, stripping prompts and trailing comments', () => {
    const claims = extractClaims(
      '```bash\n$ npm run lint   # should be clean\n```',
    );
    expect(claims).toContainEqual({ kind: 'command', text: 'npm run lint' });
  });

  it('emits ONE count claim for one statement, not one per overlapping pattern', () => {
    const claims = extractClaims('All 471 tests passed.').filter(
      (c) => c.kind === 'count',
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].text).toBe('471 tests passed');
  });

  it('does not extract a Test Files file-count line as a test-count claim', () => {
    // A pasted vitest summary nests 'Test Files  3 passed (3)' above
    // 'Tests  157 passed (157)'. The file-count line must not produce a
    // count claim — it would always 'differs' against the real test count.
    const claims = extractClaims(
      'Test Files  3 passed (3)\n     Tests  157 passed (157)',
    ).filter((c) => c.kind === 'count');
    expect(claims).toHaveLength(1);
    expect(claims[0].text).toContain('157');
  });

  it('does not extract the MIXED file-count shape either', () => {
    // The shape a runner prints the moment any file fails — which is when a
    // summary actually gets pasted into a Test Plan. The label is no longer
    // adjacent to the number it qualifies, so an adjacency rule lets `44`
    // through as a test count and the note reads `claimed 44, observed 1323`.
    const claims = extractClaims(
      'Test Files  1 failed | 44 passed (45)\n     Tests  2 failed | 1323 passed (1325)',
    ).filter((c) => c.kind === 'count');
    expect(claims.map((c) => c.text)).toEqual(['1323 passed']);
  });

  it('does not extract jest Test Suites counts as test counts', () => {
    // Same rule, jest's spelling: every number after the label counts suites.
    const claims = extractClaims(
      'Test Suites: 1 failed, 44 passed, 45 total\nTests:       2 failed, 1323 passed, 1325 total',
    ).filter((c) => c.kind === 'count');
    expect(claims.map((c) => c.text)).toEqual(['1323 passed']);
  });

  it('keeps a bare count on a line that never named files', () => {
    // The mask is per-line: blanking to end of line must not swallow a
    // legitimate count that follows on the NEXT one.
    const claims = extractClaims('Test Files  3 passed\n471 passed').filter(
      (c) => c.kind === 'count',
    );
    expect(claims.map((c) => c.text)).toEqual(['471 passed']);
  });

  it('emits one claim per distinct count', () => {
    const claims = extractClaims(
      'core: 1135 passed, desktop: 41 passed',
    ).filter((c) => c.kind === 'count');
    expect(claims.map((c) => c.text)).toEqual(['1135 passed', '41 passed']);
  });

  it('reads a count stated in the future tense', () => {
    // `expect all four files and 471 tests to pass` — the shape PR #8176 used,
    // and the claim this command exists to check.
    const claims = extractClaims(
      'expect all four files and 471 tests to pass',
    ).filter((c) => c.kind === 'count');
    expect(claims.map((c) => c.text)).toEqual(['471 tests to pass']);
  });

  it('pulls path arguments out of a repro command', () => {
    const claims = extractClaims(
      '```bash\nnpx vitest run src/a.test.ts src/b.test.ts\n```',
    );
    expect(claims).toContainEqual({ kind: 'path', text: 'src/a.test.ts' });
    expect(claims).toContainEqual({ kind: 'path', text: 'src/b.test.ts' });
  });

  it('resolves a repro command path against its leading `cd`', () => {
    // Unresolved, `src/telemetry/loggers.test.ts` does not exist at the repo
    // root and every one of these becomes a false `contradicted` note.
    const claims = extractClaims(
      '`cd packages/core && npx vitest run src/telemetry/loggers.test.ts`',
    );
    // The cd TARGET is claimed (running `cd` proves the dir must exist) —
    // filtered only through the static exclusion list, not the evidence bar.
    expect(claims).toContainEqual({ kind: 'path', text: 'packages/core' });
    expect(claims).toContainEqual({
      kind: 'path',
      text: 'packages/core/src/telemetry/loggers.test.ts',
    });
    expect(claims).not.toContainEqual({
      kind: 'path',
      text: 'src/telemetry/loggers.test.ts',
    });
  });

  it('excludes a cd base under .qwen/ or build output from path claims', () => {
    // The cd base is a directory the Test Plan tells the reader to CREATE
    // (.qwen/) or gitignored build output (dist/) — absent at the reviewed
    // commit by construction, the same exclusion isPathClaim applies to tokens.
    const qwen = extractClaims('`cd .qwen/tmp/review-pr-9 && npm test`');
    expect(qwen.filter((c) => c.kind === 'path')).toEqual([]);

    const dist = extractClaims('`cd dist/foo && npm test`');
    expect(dist.filter((c) => c.kind === 'path')).toEqual([]);
  });

  it('still extracts a normal cd base as a path claim', () => {
    const claims = extractClaims(
      '`cd packages/core && npx vitest run src/a.test.ts`',
    );
    expect(claims).toContainEqual({ kind: 'path', text: 'packages/core' });
  });

  it('extracts no path from a `cd` shape it cannot resolve', () => {
    // Rather than guess a base and file a wrong note.
    expect(
      extractClaims(
        '`for d in a b; do cd $d && npx vitest run src/x.test.ts; done`',
      ),
    ).toEqual([]);
  });

  it('does not read a Test FILES summary as a test-count claim', () => {
    expect(
      extractClaims('Test Files  45 passed (45)').filter(
        (c) => c.kind === 'count',
      ),
    ).toEqual([]);
    expect(
      extractClaims('Tests  100 passed').filter((c) => c.kind === 'count'),
    ).toHaveLength(1);
  });

  it('does not read prose inside a quoted argument as a path', () => {
    // `-t 'covers write/edit tools'` is a test-name filter, not a path claim.
    const claims = extractClaims(
      "`npx vitest run src/a.test.ts -t 'covers write/edit tools'`",
    );
    expect(claims).toContainEqual({ kind: 'path', text: 'src/a.test.ts' });
    expect(
      claims
        .filter((c) => c.kind === 'path')
        .some((c) => c.text.includes('write/edit')),
    ).toBe(false);
  });

  it('bails on path-rebasing flags like --root, as it does on cd', () => {
    // `--root ./integration-tests` rebases relative paths like `cd` does;
    // resolving them against the repo root files false `contradicted` notes.
    const claims = extractClaims(
      '`npx vitest run --root ./integration-tests sdk-typescript/perm.test.ts`',
    );
    expect(
      claims
        .filter((c) => c.kind === 'path')
        .some((c) => c.text.includes('sdk-typescript')),
    ).toBe(false);
  });

  it('bails on the inline --root=./dir form too, not only --root ./dir', () => {
    // The inline `=` form rebases paths exactly like the spaced one; before this
    // bail it extracted them as repo-root-relative and filed false `contradicted`.
    const claims = extractClaims(
      '`npx vitest run --root=./integration-tests src/b.test.ts`',
    );
    expect(
      claims
        .filter((c) => c.kind === 'path')
        .some((c) => c.text.includes('src/b.test.ts')),
    ).toBe(false);
  });

  it('still reads a positional path after an inline --flag=value', () => {
    // `--reporter=verbose` carries its value in the same token and does NOT
    // consume the next one, so the file after it is still a path claim. The old
    // skip treated it as the flag's value and silently dropped the path.
    const claims = extractClaims(
      '`npx vitest run --reporter=verbose src/a.test.ts`',
    );
    expect(claims).toContainEqual({ kind: 'path', text: 'src/a.test.ts' });
  });

  it('does not read a bare parenthesised number as a count', () => {
    expect(
      extractClaims('Follows up on (#8176).').filter((c) => c.kind === 'count'),
    ).toEqual([]);
  });

  it('does not treat prose or a bare word in backticks as a path or command', () => {
    expect(extractClaims('The `status` field is now authoritative.')).toEqual(
      [],
    );
  });

  it('skips unified-diff headers pasted into the Test Plan', () => {
    // The template's Evidence section invites pasting diffs; their a/ b/
    // prefixes are not path claims about the reviewed tree.
    const claims = extractClaims(
      [
        '```diff',
        'diff --git a/packages/cli/src/foo.ts b/packages/cli/src/foo.ts',
        '--- a/packages/cli/src/foo.ts',
        '+++ b/packages/cli/src/foo.ts',
        '@@ -1,3 +1,4 @@',
        '+added line',
        '```',
      ].join('\n'),
    );
    expect(claims.filter((c) => c.kind === 'path')).toEqual([]);
  });

  it('does not extract a gitignored build-output path as a claim', () => {
    // dist/ is absent at the reviewed commit by construction — a Test Plan
    // naming it is telling the reader to build, not claiming the commit ships it.
    const claims = extractClaims(
      'Run `node packages/cli/dist/index.js --yolo`',
    );
    expect(
      claims
        .filter((c) => c.kind === 'path')
        .some((c) => c.text.includes('dist/')),
    ).toBe(false);
  });
});

describe('observedTestCounts', () => {
  const report = (outputs: string[], command = 'npm test'): BuildTestReport =>
    ({
      test: outputs.map((output) => ({
        command,
        exitCode: 0,
        seconds: 1,
        timedOut: false,
        output,
      })),
    }) as BuildTestReport;

  it('reads the vitest summary', () => {
    expect(
      observedTestCounts(report(['\n Tests  472 passed (472)\n'])),
    ).toEqual([472]);
  });

  it('reads the jest summary', () => {
    expect(
      observedTestCounts(report(['Tests:       12 passed, 12 total'])),
    ).toEqual([12]);
  });

  it('reads fresh Maven report summaries and counts passed tests', () => {
    expect(
      observedTestCounts(
        report(
          [
            '[maven-test-report] core (1 failing report(s)): tests=12, failures=3, errors=0, skipped=3\n' +
              '[maven-test-report] app (1 report(s)): tests=8, failures=0, errors=0, skipped=1',
          ],
          './mvnw test',
        ),
      ),
    ).toEqual([13]);
  });

  it('reads rolled-up Maven module summaries too', () => {
    // Clean reports roll up per project dir to keep the evidence block
    // bounded; the count parser must read the rollup shape the same way.
    expect(
      observedTestCounts(
        report(
          [
            '[maven-test-report] core (412 report(s)): tests=8931, failures=0, errors=0, skipped=12',
          ],
          './mvnw test',
        ),
      ),
    ).toEqual([8919]);
  });

  it('emits the changed-module subtotal beside the -am reactor total', () => {
    // `-pl <modules> -am` also tests the UPSTREAM closure: a count claim
    // about the changed modules must be able to match their subtotal, not
    // only the reactor-wide sum — "42 tests pass" for module `core`
    // otherwise reads `differs` against a 187 total that includes
    // upstream `common`'s 145.
    const scoped = {
      test: [
        {
          command:
            './mvnw --batch-mode --no-transfer-progress -pl core -am test',
          exitCode: 0,
          seconds: 10,
          timedOut: false,
          maven: { lifecycle: 'test', modules: ['core'], alsoMake: true },
          output:
            '[maven-test-report] common (12 report(s)): tests=145, failures=0, errors=0, skipped=0\n' +
            '[maven-test-report] core (4 report(s)): tests=42, failures=0, errors=0, skipped=0',
        },
      ],
    } as unknown as BuildTestReport;
    expect(observedTestCounts(scoped)).toEqual([187, 42]);

    // A reactor-wide run carries no module list: the total is the only
    // reading.
    const reactorWide = {
      test: [
        {
          command: './mvnw --batch-mode --no-transfer-progress test',
          exitCode: 0,
          seconds: 10,
          timedOut: false,
          maven: { lifecycle: 'test', modules: null, alsoMake: false },
          output:
            '[maven-test-report] common (12 report(s)): tests=145, failures=0, errors=0, skipped=0\n' +
            '[maven-test-report] core (4 report(s)): tests=42, failures=0, errors=0, skipped=0',
        },
      ],
    } as unknown as BuildTestReport;
    expect(observedTestCounts(reactorWide)).toEqual([187]);
  });

  it('counts no tests from an interrupted or infrastructure-classified run', () => {
    // An interrupted run's partial counts must not adjudicate a count claim
    // — the same exclusion finished() applies to command claims.
    const interrupted = {
      test: [
        {
          command: './mvnw test',
          exitCode: null,
          seconds: 300,
          timedOut: true,
          output:
            '[maven-test-report] core (43 report(s)): tests=43, failures=0, errors=0, skipped=0',
        },
        {
          command: 'mvn test',
          exitCode: 1,
          seconds: 3,
          timedOut: false,
          infrastructure: true,
          output:
            '[maven-test-report] core (7 report(s)): tests=7, failures=0, errors=0, skipped=0',
        },
        {
          // The exitCode===null disjunct pinned ALONE: a spawn-level death
          // (OOM kill, maxBuffer overflow) carries timedOut:false, and the
          // interrupt fixtures above bundle the two disjuncts together.
          command: 'mvn test',
          exitCode: null,
          seconds: 3,
          timedOut: false,
          output:
            '[maven-test-report] core (9 report(s)): tests=9, failures=0, errors=0, skipped=0',
        },
        {
          command: 'mvn -fn test',
          exitCode: 0,
          seconds: 3,
          timedOut: false,
          swallowedFailure: true,
          output:
            '[maven-test-report] core (500 report(s)): tests=500, failures=0, errors=0, skipped=0',
        },
        {
          command: 'mvn test',
          exitCode: 0,
          seconds: 3,
          timedOut: false,
          evidenceCapped: true,
          output:
            '[maven-test-report] core (3 report(s)): tests=1000, failures=0, errors=0, skipped=0',
        },
        // The exclusion's other two branches: a suppressed test phase ran
        // ZERO tests, and a wrapper that never started measured nothing —
        // neither may adjudicate a count claim.
        {
          command: 'mvn test',
          exitCode: 0,
          seconds: 3,
          timedOut: false,
          testsSuppressed: true,
          output:
            '[maven-test-report] core (2 report(s)): tests=2, failures=0, errors=0, skipped=2',
        },
        {
          command: './mvnw test',
          exitCode: 0,
          seconds: 3,
          timedOut: false,
          neverRan: true,
          output:
            '[maven-test-report] core (1 report(s)): tests=1, failures=0, errors=0, skipped=0',
        },
        // Exit 0 over fresh FAILING reports: build-test marks the run
        // ok:false, and its derived pass count must not adjudicate a
        // count claim `reproduces` while the command-claim twin rules
        // the same run contradicted.
        {
          command: './mvnw test',
          exitCode: 0,
          seconds: 3,
          timedOut: false,
          swallowedReports: true,
          output:
            '[maven-test-report] core (1 failing report(s)): tests=43, failures=1, errors=0, skipped=0',
        },
      ],
    } as unknown as BuildTestReport;
    expect(observedTestCounts(interrupted)).toEqual([]);
  });

  it('counts no tests from an interrupted npm-shaped run either', () => {
    // The mirror of the Maven exclusion: a vitest summary inside an
    // INTERRUPTED npm run is a partial count and must not adjudicate.
    const interrupted = {
      test: [
        {
          command: 'npm test',
          exitCode: null,
          seconds: 300,
          timedOut: true,
          output: 'Tests  499 passed (499)',
        },
        // The null-exit disjunct alone, like its Maven twin above.
        {
          command: 'npm test',
          exitCode: null,
          seconds: 3,
          timedOut: false,
          output: 'Tests  499 passed (499)',
        },
      ],
    } as unknown as BuildTestReport;
    expect(observedTestCounts(interrupted)).toEqual([]);
  });

  it('never counts JS console summaries echoed by a Maven run', () => {
    // The mirror of the marker gate: surefire echoes test stdout, and a
    // Maven run's own test printing a vitest-shaped summary is not the
    // run's count — only the `[maven-test-report]` evidence counts.
    expect(
      observedTestCounts(
        report(
          [
            'Tests  499 passed (499)\n' +
              '[maven-test-report] core (1 report(s)): tests=5, failures=0, errors=0, skipped=0',
          ],
          './mvnw test',
        ),
      ),
    ).toEqual([5]);
  });

  it('counts the omitted totals carried by capped rollup markers', () => {
    // The producer caps only the FAILING rollups (clean rollups are
    // uncapped), so the fixture must use the producer's real omission
    // marker — a fabricated "clean" marker would validate parsing of a
    // shape the producer contract forbids.
    expect(
      observedTestCounts(
        report(
          [
            '[maven-test-report] mod0 (1 report(s)): tests=1, failures=0, errors=0, skipped=0\n' +
              '[maven-test-report] 20 more failing project rollup(s) omitted: tests=20, failures=0, errors=0, skipped=0',
          ],
          './mvnw test',
        ),
      ),
    ).toEqual([21]);
  });

  it('never counts a Maven report below zero passed tests', () => {
    // Surefire does not guarantee tests >= failures + errors + skipped
    // (class-level @Disabled and rerunFailingTestsCount reruns both perturb
    // it), and the sum spans every report of the command: one negative value
    // would silently cancel legitimate counts from its neighbours.
    expect(
      observedTestCounts(
        report(
          [
            '[maven-test-report] core (1 report(s)): tests=0, failures=0, errors=0, skipped=1\n' +
              '[maven-test-report] app (1 report(s)): tests=8, failures=0, errors=0, skipped=1',
          ],
          './mvnw test',
        ),
      ),
    ).toEqual([7]);
  });

  it('never counts Maven markers mined from a non-Maven command output', () => {
    // The markers are PR test stdout's own to print: a fabricated
    // `[maven-test-report]` inside a run that never ran Maven must not
    // certify a count claim.
    expect(
      observedTestCounts(
        report([
          'Tests  10 passed (10)\n' +
            '[maven-test-report] x: tests=472, failures=0, errors=0, skipped=0',
        ]),
      ),
    ).toEqual([10]);
  });

  it('reads a summary interleaved with ANSI color codes', () => {
    // What a real color-enabled pipe delivers — the codes sit BETWEEN tokens,
    // so a token-level regex without the strip finds nothing. From a live
    // review of PR #8176.
    expect(
      observedTestCounts(
        report([
          'Tests\x1b[2m  \x1b[22m\x1b[1m\x1b[31m3 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m1132 passed\x1b[39m\x1b[22m (1135)',
        ]),
      ),
    ).toEqual([1132]);
  });

  it('reads a summary that also reports failures', () => {
    expect(
      observedTestCounts(report(['Tests  1 failed | 40 passed (41)'])),
    ).toEqual([40]);
  });

  it('reads a three-segment summary (failed | skipped | passed)', () => {
    expect(
      observedTestCounts(
        report(['Tests  2 failed | 3 skipped | 40 passed (45)']),
      ),
    ).toEqual([40]);
  });

  it('sums the summaries within one command and keeps commands separate', () => {
    expect(
      observedTestCounts(
        report([
          'Tests  10 passed (10)\nTests  5 passed (5)',
          'Tests  41 passed (41)',
        ]),
      ),
    ).toEqual([15, 41]);
  });

  it('returns nothing when there is no report and when no count was printed', () => {
    expect(observedTestCounts(null)).toEqual([]);
    expect(observedTestCounts(report(['no summary here']))).toEqual([]);
  });
});

describe('npmScriptOf', () => {
  it('reads the script name past `run` and past a workspace flag', () => {
    expect(npmScriptOf('npm run build')).toBe('build');
    expect(npmScriptOf('npm test --workspace=packages/cli')).toBe('test');
    expect(npmScriptOf('npm run test:unit')).toBe('test:unit');
  });

  it("never rules bun test against the scripts table — it is bun's built-in runner", () => {
    expect(npmScriptOf('bun test')).toBeNull();
    expect(npmScriptOf('bun run lint')).toBe('lint'); // the run form still rules
  });

  it('bails on a CHAINED cd instead of joining against the first hop', () => {
    // `cd a && cd b && vitest run x.test.ts` once produced `a/x.test.ts`.
    expect(
      extractClaims('`cd a && cd packages/b && npx vitest run src/x.test.ts`'),
    ).toEqual([]);
  });

  it('closes a fence only on its own marker inside codeSpans', () => {
    // A ~~~ line inside a ``` block ended the span early — lines after it
    // fell OUT of the fence and were lost to span extraction entirely.
    const claims = extractClaims(
      '```bash\nnpx vitest run src/real.test.ts\n~~~\nnpx vitest run src/inside.test.ts\n```',
    );
    expect(claims).toContainEqual({ kind: 'path', text: 'src/real.test.ts' });
    // Still inside the ``` block, so still extracted:
    expect(claims).toContainEqual({ kind: 'path', text: 'src/inside.test.ts' });
  });

  it('is null for every npm builtin outside the run form and script aliases', () => {
    // The denylist knew four verbs; npm has ~fifty. Each of the rest became a
    // false `no package defines this script` on a correct Test Plan.
    for (const c of [
      'npm audit',
      'npm ls --workspaces',
      'npm pack',
      'npm publish --dry-run',
      'npm view qwen-code version',
      'npm outdated',
      'yarn add left-pad',
    ]) {
      expect(npmScriptOf(c)).toBeNull();
    }
    expect(npmScriptOf('npm test')).toBe('test'); // the aliases still rule
    expect(npmScriptOf('npm run test:unit')).toBe('test:unit');
  });

  it('is null when a FLAG precedes the script — never a false script name', () => {
    // `--workspace` used to be the capture, and end-to-end that posted
    // `no package defines this script` on a correct Test Plan.
    expect(npmScriptOf('npm --workspace=packages/cli run build')).toBeNull();
    expect(npmScriptOf('npm -w packages/cli run test')).toBeNull();
    expect(npmScriptOf('yarn --cwd packages/cli build')).toBeNull();
  });

  it('is null for npm verbs that are not scripts, and for non-npm runners', () => {
    expect(npmScriptOf('npm ci')).toBeNull();
    expect(npmScriptOf('npm install')).toBeNull();
    expect(npmScriptOf('make build')).toBeNull();
  });

  it('does not truncate a run-less `yarn test:unit` to `test`', () => {
    // `\b` matched at the `:`, so a correct `test:unit` claim was ruled against
    // the wrong script; anchored to a full token, it falls through to unchecked.
    expect(npmScriptOf('yarn test:unit')).toBeNull();
    expect(npmScriptOf('pnpm test:e2e')).toBeNull();
    // The bare alias and the `run` form are unchanged.
    expect(npmScriptOf('yarn test')).toBe('test');
    expect(npmScriptOf('yarn run test:unit')).toBe('test:unit');
  });
});

describe('runTestPlan', () => {
  let dir: string;

  const plan = (files: string[]) => {
    const p = join(dir, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({
        files: files.map((path) => ({ path, kind: 'source' })),
        diffPathAbsolute: join(dir, 'diff.txt'),
      }),
    );
    return p;
  };

  const run = (
    body: string,
    files: string[] = [],
    buildTest?: BuildTestReport,
  ) => {
    let btPath: string | undefined;
    if (buildTest) {
      btPath = join(dir, 'bt.json');
      writeFileSync(btPath, JSON.stringify(buildTest));
    }
    return runTestPlan(
      {
        plan: plan(files),
        pr: '1',
        repo: 'o/r',
        worktree: dir,
        buildTest: btPath,
      },
      () => body,
    );
  };

  const verdictOf = (claims: TestPlanClaim[], text: string) =>
    claims.find((c) => c.text === text)?.verdict;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qwen-test-plan-'));
    writeFileSync(join(dir, 'diff.txt'), 'diff');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        workspaces: ['packages/*'],
        scripts: { build: 'tsc', test: 'vitest' },
      }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports a missing Test Plan as absent, not as a finding', () => {
    const r = run('## Summary\n\nno plan here');
    expect(r.found).toBe(false);
    expect(r.claims).toEqual([]);
    expect(r.note).toMatch(/no Test Plan section/);
  });

  it('distinguishes a failed body fetch from an absent Test Plan', () => {
    const r = runTestPlan(
      { plan: plan([]), pr: '1', repo: 'o/r', worktree: dir },
      () => {
        throw new Error('gh: not authenticated');
      },
    );
    expect(r.found).toBe(false);
    expect(r.note).toMatch(/could not be fetched/);
    expect(r.note).toMatch(/not authenticated/);
  });

  it('binds the report to the diff it ran against', () => {
    expect(run('## Test Plan\n\nran it').diffHash).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('path claims', () => {
    it('reproduces a path the diff changes', () => {
      const r = run('## Test Plan\n\nAdded `packages/cli/src/a.test.ts`', [
        'packages/cli/src/a.test.ts',
      ]);
      expect(verdictOf(r.claims, 'packages/cli/src/a.test.ts')).toBe(
        'reproduces',
      );
    });

    it('reproduces a path that exists but the diff does not touch', () => {
      // A Test Plan may legitimately say "ran the existing suite at X".
      mkdirSync(join(dir, 'packages/core/src'), { recursive: true });
      writeFileSync(join(dir, 'packages/core/src/old.test.ts'), '');
      const r = run('## Test Plan\n\nRan `packages/core/src/old.test.ts`');
      expect(verdictOf(r.claims, 'packages/core/src/old.test.ts')).toBe(
        'reproduces',
      );
    });

    it('contradicts a path that is in neither the diff nor the tree', () => {
      const r = run('## Test Plan\n\nAdded `packages/cli/src/ghost.test.ts`');
      const claim = r.claims.find(
        (c) => c.text === 'packages/cli/src/ghost.test.ts',
      );
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('no such file or directory');
    });

    it('ignores a line suffix when resolving a path', () => {
      mkdirSync(join(dir, 'packages/cli/src'), { recursive: true });
      writeFileSync(join(dir, 'packages/cli/src/a.ts'), '');
      const r = run('## Test Plan\n\nSee `packages/cli/src/a.ts:42`');
      expect(verdictOf(r.claims, 'packages/cli/src/a.ts:42')).toBe(
        'reproduces',
      );
    });

    it('claims a slash token as a path only with EVIDENCE it is one', () => {
      // This PR's own Test Plan produced two false `contradicted` notes before
      // this bar: `QwenLM/qwen-code` (a --repo slug) and `.qwen/tmp/review-…`
      // (a path the reader is told to CREATE). A bare two-segment token with
      // no extension is a slug or a ref far more often than a directory.
      const r = run(
        '## Test Plan\n\nRun `gh pr view 1 --repo QwenLM/qwen-code`, ' +
          'check `origin/main`, create `.qwen/tmp/review-pr-1/x.json`, ' +
          'then read `packages/cli/` and `./run.sh`',
      );
      const texts = r.claims.map((c) => c.text);
      expect(texts).not.toContain('QwenLM/qwen-code'); // flag value AND slug
      expect(texts).not.toContain('origin/main'); // ref, no extension
      expect(texts.some((t) => t.startsWith('.qwen/'))).toBe(false); // temp root
      expect(texts).not.toContain('packages/cli/'); // bare dir, no evidence
      expect(texts).toContain('./run.sh'); // explicit ./ prefix qualifies
    });

    it('does not claim the VALUE of a flag inside a repro command', () => {
      const r = run(
        '## Test Plan\n\n`docker compose -f infra/docker-compose.yml up`',
      );
      expect(r.claims.map((c) => c.text)).not.toContain(
        'infra/docker-compose.yml',
      );
    });

    it('does not rule on a path that escapes the repo root', () => {
      const r = run('## Test Plan\n\nWrote `../other/x.ts`');
      expect(verdictOf(r.claims, '../other/x.ts')).toBe('unchecked');
    });

    it('sheds no claims from a pasted unified diff in an Evidence block', () => {
      // The PR template invites pasting logs/diffs INSIDE the Test Plan;
      // `+++ b/<path>` once became a contradicted claim on a correct body.
      const r = run(
        '## Test Plan\n\n```diff\ndiff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n```',
      );
      expect(r.claims).toEqual([]);
    });

    it('sheds no claim from a pasted diff BODY line with a path shape', () => {
      // `-packages/old/gone.ts` matched PATH_RE (its class admits -/+) and
      // ruled a false contradicted on a realistic pasted diff.
      const r = run(
        '## Test Plan\n\n```diff\ndiff --git a/s.ts b/s.ts\n--- a/s.ts\n+++ b/s.ts\n@@ -1,2 +1,2 @@\n-packages/old/gone.ts\n+packages/new/added.ts\n```',
      );
      expect(r.claims).toEqual([]);
    });

    it('a gitignored file that EXISTS still rules reproduces, and says which kind', () => {
      // build-test may have produced it earlier in this worktree; the ignore
      // guard only ever downgrades a would-be contradiction. The NOTE is the
      // part a reader acts on: an ignored file that is present is something
      // this run produced, not state at the reviewed commit, and collapsing
      // both cases onto one sentence retires that distinction silently.
      execFileSync('git', ['init', '-q'], { cwd: dir });
      writeFileSync(join(dir, '.gitignore'), 'artifacts/\n');
      mkdirSync(join(dir, 'artifacts'), { recursive: true });
      writeFileSync(join(dir, 'artifacts/report.json'), '{}');
      const r = run('## Test Plan\n\nWrote `artifacts/report.json`');
      const claim = r.claims.find((c) => c.text === 'artifacts/report.json');
      expect(claim?.verdict).toBe('reproduces');
      expect(claim?.note).toContain('gitignored');
      expect(claim?.note).toContain('this run produced');
    });

    it('a TRACKED file that exists says it is state at the reviewed commit', () => {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/kept.ts'), 'export {};\n');
      const r = run('## Test Plan\n\nSee `src/kept.ts`');
      const claim = r.claims.find((c) => c.text === 'src/kept.ts');
      expect(claim?.verdict).toBe('reproduces');
      expect(claim?.note).toBe(
        'exists at the reviewed commit (the diff does not change it)',
      );
    });

    it('sheds no claim at all for a well-known build directory', () => {
      // `dist/` is on the static exclusion list, so the claim never forms.
      const r = run('## Test Plan\n\nRun `node dist/index.js`');
      expect(r.claims.find((c) => c.text === 'dist/index.js')).toBeUndefined();
    });

    it('rules a gitignored path OUTSIDE the static list unchecked', () => {
      // The check-ignore backstop covers ignored dirs the list cannot name.
      execFileSync('git', ['init', '-q'], { cwd: dir });
      writeFileSync(join(dir, '.gitignore'), 'artifacts/\n');
      const r = run('## Test Plan\n\nWrote `artifacts/report.json`');
      const claim = r.claims.find((c) => c.text === 'artifacts/report.json');
      expect(claim?.verdict).toBe('unchecked');
      expect(claim?.note).toContain('gitignored');
    });

    it('never extracts an absolute path as a repo claim', () => {
      // `/tmp/out/log.json` is a real thing to write in a Test Plan and is not
      // a statement about the repository — it must produce no claim at all.
      expect(extractClaims('Wrote `/tmp/out/log.json`')).toEqual([]);
    });
  });

  describe('command claims', () => {
    /**
     * One recorded Maven lifecycle run, in the shape the adapter emits: the
     * command line AND the `maven` facts it rendered that line from.
     *
     * Both come from ONE input here, exactly as they do in the adapter —
     * which is the whole reason `test-plan` reads the facts instead of
     * parsing the string back. The fixture is deliberately BROADER than the
     * adapter, though: the `alsoMake` override can render a narrowed `-pl`
     * run WITHOUT `-am`, a shape the adapter never emits (its rendering
     * always pairs the two) — that impossible shape exists to pin the
     * claim-side `-am` carve-outs against adversarial inputs. Pass
     * `command` to render a line the adapter would not (a claim-side
     * spelling under test); pass `maven: undefined` for a non-Maven run.
     */
    const mavenCmd = (
      opts: {
        exe?: string;
        lifecycle?: string;
        /** null for a reactor-wide run — no `-pl`, no `-am`. */
        modules?: string[] | null;
        /** Defaults to true whenever the run is narrowed. */
        alsoMake?: boolean;
        /** A config-declared GLOBAL skip (vs a stdout-only module-local one). */
        globalSkip?: boolean;
      } & Partial<CommandResult> = {},
    ): CommandResult => {
      const {
        exe = './mvnw',
        lifecycle = 'test',
        modules = ['core'],
        alsoMake = modules !== null,
        globalSkip = false,
        ...overrides
      } = opts;
      // Selectors are rendered BY the adapter's own shellSelector: quoting
      // each module and joining would emit a line the adapter can never
      // produce (it joins first, then wraps the whole selector). A selector
      // shellSelector refuses is widened to a reactor-wide run exactly like
      // the adapter does — fabricating a `-pl` line it cannot launch would
      // pair an impossible (command, facts) shape.
      const selector = modules === null ? null : shellSelector(modules);
      const widened = modules !== null && selector === null;
      const narrowing =
        selector === null ? '' : ` -pl ${selector}${alsoMake ? ' -am' : ''}`;
      return {
        command: `${exe} --batch-mode --no-transfer-progress${narrowing} ${lifecycle}`,
        exitCode: 0,
        seconds: 3,
        timedOut: false,
        output: '',
        maven: widened
          ? { lifecycle, modules: null, alsoMake: false, globalSkip }
          : { lifecycle, modules, alsoMake, globalSkip },
        ...overrides,
      };
    };

    it('reproduces a script the manifests define', () => {
      const r = run('## Test Plan\n\nRan `npm run build`');
      expect(verdictOf(r.claims, 'npm run build')).toBe('reproduces');
    });

    it('finds a script defined by a workspace package, not just the root', () => {
      mkdirSync(join(dir, 'packages/cli'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/cli/package.json'),
        JSON.stringify({ name: '@x/cli', scripts: { 'test:e2e': 'vitest' } }),
      );
      const r = run('## Test Plan\n\nRan `npm run test:e2e`');
      expect(verdictOf(r.claims, 'npm run test:e2e')).toBe('reproduces');
    });

    it('contradicts a script no package defines', () => {
      const r = run('## Test Plan\n\nRan `npm run test:ghost`');
      const claim = r.claims.find((c) => c.text === 'npm run test:ghost');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('no package defines this script');
    });

    it('reproduces a script defined only by a nameless-but-parseable member', () => {
      // A nameless member lands in `skipped`, but its manifest PARSES — the
      // scripts table is fully readable (scripts need no `name` to enumerate),
      // so the ruling uses the evidence it holds rather than declaring the
      // whole table unreadable.
      mkdirSync(join(dir, 'packages/nameless'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/nameless/package.json'),
        JSON.stringify({ scripts: { 'test:ghost': 'vitest' } }),
      );
      const r = run('## Test Plan\n\nRan `npm run test:ghost`');
      const claim = r.claims.find((c) => c.text === 'npm run test:ghost');
      expect(claim?.verdict).toBe('reproduces');
    });

    it('contradicts a fabricated script even when a nameless member exists', () => {
      // Every manifest parses — the script table is complete — so a positive
      // absence is sound; `unchecked` is reserved for genuinely unreadable
      // manifests.
      mkdirSync(join(dir, 'packages/nameless'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/nameless/package.json'),
        JSON.stringify({ scripts: { 'test:ghost': 'vitest' } }),
      );
      const r = run('## Test Plan\n\nRan `npm run test:nonexistent`');
      const claim = r.claims.find((c) => c.text === 'npm run test:nonexistent');
      expect(claim?.verdict).toBe('contradicted');
    });

    it('rules unchecked — not contradicted — when only an unreadable manifest could define the script', () => {
      // A manifest that does not PARSE proves nothing about its scripts, so
      // the ruling must not assert a positive absence from a table it was
      // told may be incomplete.
      mkdirSync(join(dir, 'packages/broken'), { recursive: true });
      writeFileSync(join(dir, 'packages/broken/package.json'), '{ not json');
      const r = run('## Test Plan\n\nRan `npm run test:ghost`');
      const claim = r.claims.find((c) => c.text === 'npm run test:ghost');
      expect(claim?.verdict).toBe('unchecked');
      expect(claim?.note).toContain('packages/broken');
    });

    it('rules unchecked when the workspace globs use a shape the walker does not model', () => {
      // `packages/**` lands in NEITHER `packages` nor `skipped` — the table
      // may be silently incomplete, so a positive absence would be unsound.
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'r',
          workspaces: ['packages/**'],
          scripts: { build: 'exit 0' },
        }),
      );
      mkdirSync(join(dir, 'packages/cli'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/cli/package.json'),
        JSON.stringify({ name: '@x/cli', scripts: { 'test:unit': 'vitest' } }),
      );
      const r = run('## Test Plan\n\nRan `npm run test:unit`');
      expect(verdictOf(r.claims, 'npm run test:unit')).toBe('unchecked');
    });

    it('models ./-prefixed workspace globs like their bare form', () => {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'r',
          workspaces: ['./packages/*'],
          scripts: { build: 'exit 0' },
        }),
      );
      mkdirSync(join(dir, 'packages/cli'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/cli/package.json'),
        JSON.stringify({ name: '@x/cli', scripts: { 'test:unit': 'vitest' } }),
      );
      const r = run('## Test Plan\n\nRan `npm run test:unit`');
      expect(verdictOf(r.claims, 'npm run test:unit')).toBe('reproduces');
    });

    it("prefers this review's own exit code over the manifest lookup", () => {
      const bt = {
        build: [
          {
            command: 'npm run build',
            exitCode: 1,
            seconds: 3,
            timedOut: false,
            output: 'TS2307',
          },
        ],
        test: [],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `npm run build`', [], bt);
      const claim = r.claims.find((c) => c.text === 'npm run build');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('exit 1');
    });

    it("rules a clean exit from this review's own run as reproduces", () => {
      // The exit-1 case above pins one ternary arm; this pins the other, so a
      // swap of the two arms cannot pass both tests.
      const bt = {
        build: [
          {
            command: 'npm run build',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output: '',
          },
        ],
        test: [],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `npm run build`', [], bt);
      const claim = r.claims.find((c) => c.text === 'npm run build');
      expect(claim?.verdict).toBe('reproduces');
      expect(claim?.observed).toBe('exit 0');
    });

    it("matches this review's workspace-scoped run of the plan's bare command", () => {
      // build-test runs `npm run build --workspace=...`; the plan names the bare
      // `npm run build`. An exact-string match misses it and falls through to the
      // manifest, which would report `reproduces` even though the build failed.
      const bt = {
        build: [
          {
            command: 'npm run build --workspace="packages/cli"',
            exitCode: 1,
            seconds: 3,
            timedOut: false,
            output: 'TS2307',
          },
        ],
        test: [],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `npm run build`', [], bt);
      const claim = r.claims.find((c) => c.text === 'npm run build');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('exit 1');
    });

    it('does not rule on a command killed by the deadline', () => {
      // A timeout is an infrastructure result, never a defect in the PR.
      const bt = {
        build: [
          {
            command: 'npm run build',
            exitCode: null,
            seconds: 120,
            timedOut: true,
            output: '',
          },
        ],
        test: [],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `npm run build`', [], bt);
      // Falls through to the manifest lookup, which defines `build`.
      expect(verdictOf(r.claims, 'npm run build')).toBe('reproduces');
    });

    it('does not rule on a non-npm runner', () => {
      const r = run('## Test Plan\n\nRan `make check`');
      expect(verdictOf(r.claims, 'make check')).toBe('unchecked');
    });

    it("matches this review's scoped Maven lifecycle command", () => {
      const bt = {
        build: [],
        test: [mavenCmd({ exitCode: 1, output: 'There are test failures.' })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('exit 1');
      expect(claim?.note).toContain('module-scoped');
    });

    it('reads the Maven lifecycle after a lifecycle-named module selector', () => {
      const bt = {
        build: [],
        test: [
          mavenCmd({
            modules: ['validate'],
            exitCode: 1,
            output: 'There are test failures.',
          }),
        ],
      } as unknown as BuildTestReport;

      const test = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      expect(verdictOf(test.claims, './mvnw test')).toBe('contradicted');

      const validate = run('## Test Plan\n\nRan `./mvnw validate`', [], bt);
      expect(verdictOf(validate.claims, './mvnw validate')).toBe('unchecked');
    });

    it('recognizes Maven wrapper command spellings', () => {
      for (const command of [
        'mvn test',
        // The spelling Windows `cmd.exe` users type for system Maven, and
        // parent-dir wrapper invocations — silently never extracted before.
        'mvn.cmd test',
        'mvnw test',
        'mvnw.cmd test',
        './mvnw test',
        './mvnw.cmd test',
        '.\\mvnw test',
        '.\\mvnw.cmd test',
        '../mvnw test',
        '..\\mvnw test',
        // A normal nested-module spelling two levels deep — silently
        // never extracted before, and `../../mvnw.cmd` mis-extracted as a
        // PATH claim.
        '../../mvnw test',
        '..\\..\\mvnw test',
        '../../mvnw.cmd test',
        // The Maven daemon and the debug launcher are Maven too, with the
        // platform suffixes their Windows distributions ship.
        'mvnd test',
        'mvnd.cmd test',
        'mvnd.exe test',
        'mvnDebug test',
        'mvnDebug.cmd test',
        'mvnDebug.exe test',
        // Bare system Maven from a module directory — same relative hops
        // as the wrapper, same rule.
        './mvn test',
        './mvn.cmd test',
        '../mvn test',
        '..\\mvn test',
      ]) {
        const claims = extractClaims(`## Test Plan\n\nRan \`${command}\``);
        expect(claims.some((claim) => claim.text === command)).toBe(true);
        // The runner token is a command, not a path claim about the tree.
        expect(
          claims.filter((c) => c.kind === 'path' && c.text === command),
        ).toEqual([]);
      }

      // The bare deep spelling is a FILENAME claim about the tree: the
      // command reading can never settle (no phase to compare against any
      // recorded run), and the path reading is the verification the token
      // actually is.
      const bare = extractClaims('## Test Plan\n\nRan `../../mvnw.cmd`');
      expect(
        bare.some((c) => c.kind === 'path' && c.text === '../../mvnw.cmd'),
      ).toBe(true);
      expect(bare.filter((c) => c.kind === 'command')).toEqual([]);
    });

    it('matches bare Maven wrapper spellings to a scoped lifecycle run', () => {
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;

      for (const command of [
        'mvnw test',
        'mvnw.cmd test',
        '.\\mvnw.cmd test',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${command}\``, [], bt);
        expect(verdictOf(r.claims, command)).toBe('reproduces');
        const claim = r.claims.find((c) => c.text === command);
        expect(claim?.note).toContain('module-scoped');
      }
    });

    it('reports a matching Maven timeout as an attempted run', () => {
      const bt = {
        build: [],
        test: [mavenCmd({ exitCode: null, seconds: 120, timedOut: true })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('unchecked');
      expect(claim?.note).toContain('timed out');
      expect(claim?.note).not.toContain('not run');
    });

    it('does not rule on a Maven run that ended without an exit code', () => {
      // A spawn-level death (OOM kill, outside signal) is infrastructure —
      // the adapter says so about the same result; it must not read as a
      // contradiction of the author's claim.
      const bt = {
        build: [],
        test: [mavenCmd({ exitCode: null })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('unchecked');
      expect(claim?.note).toContain('ended without an exit code');
      expect(claim?.note).not.toContain('not run');
    });

    it('does not settle a claim whose quoted flag consumes the phase token', () => {
      // `"-l"` is the `-l` flag once its quote layer is stripped: `test`
      // is its VALUE, not a phase. Matching the raw token let the claim
      // settle on a lifecycle it never named.
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;

      const quoted = run(
        '## Test Plan\n\nRan `./mvnw verify "-l" test`',
        [],
        bt,
      );
      expect(verdictOf(quoted.claims, './mvnw verify "-l" test')).toBe(
        'unchecked',
      );

      // The unquoted control means the same thing either way.
      const unquoted = run(
        '## Test Plan\n\nRan `./mvnw verify -l test`',
        [],
        bt,
      );
      expect(verdictOf(unquoted.claims, './mvnw verify -l test')).toBe(
        'unchecked',
      );
    });

    it('detects -am through a quoted flag spelling', () => {
      // A quoted `"-am"` is the same flag: missing it discarded the
      // failing `-am` run and left the claim unchecked.
      const bt = {
        build: [],
        test: [
          mavenCmd({ exitCode: 1, output: 'There are test failures.' }),
          mavenCmd({ modules: ['sibling'], exitCode: 0 }),
        ],
      } as unknown as BuildTestReport;

      const r = run('## Test Plan\n\nRan `./mvnw -pl core "-am" test`', [], bt);
      expect(verdictOf(r.claims, './mvnw -pl core "-am" test')).toBe(
        'contradicted',
      );
    });

    it('does not settle a fail-never claim on a run that can exit non-zero', () => {
      // fail-never makes Maven exit 0 over failures it would otherwise die
      // on: a run without it recorded exit codes the claimed command
      // cannot produce. All three spellings carry the same scope.
      const bt = {
        build: [],
        test: [mavenCmd({ exitCode: 1, output: '[ERROR] COMPILATION ERROR' })],
      } as unknown as BuildTestReport;

      for (const command of [
        'mvn -fn test',
        'mvn --fail-never test',
        'mvn -fail-never test',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${command}\``, [], bt);
        expect(verdictOf(r.claims, command)).toBe('unchecked');
      }

      // The unflagged control still contradicts.
      const control = run('## Test Plan\n\nRan `mvn test`', [], bt);
      expect(verdictOf(control.claims, 'mvn test')).toBe('contradicted');
    });

    it('reads a quote spanning a flag=value pair as one word', () => {
      // `"-settings=my settings.xml"` is one shell word; the whitespace
      // split broke it and the fragments slipped past the scope guards.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;

      const r = run(
        '## Test Plan\n\nRan `./mvnw "-settings=my settings.xml" test`',
        [],
        bt,
      );
      expect(
        verdictOf(r.claims, './mvnw "-settings=my settings.xml" test'),
      ).toBe('unchecked');
    });

    it('still contradicts on never-ran and suppressed -am runs', () => {
      // A wrapper that never started Maven and a global skip setting
      // cannot live in an upstream module: the `-am` exclusion must not
      // discard either run.
      const neverRanBt = {
        build: [],
        test: [
          mavenCmd({
            exitCode: 0,
            output: '[INFO] BUILD SUCCESS',
            neverRan: true,
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run(
        '## Test Plan\n\nRan `./mvnw -pl core test`',
        [],
        neverRanBt,
      );
      const claim = r.claims.find((c) => c.text === './mvnw -pl core test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toContain('Maven never started');

      const suppressedBt = {
        build: [],
        test: [
          mavenCmd({
            exitCode: 0,
            output: 'Tests are skipped.',
            testsSuppressed: true,
            // The adapter's own invariant: suppression is one of the
            // swallowed-failure shapes, so the two flags always travel
            // together on a real result. `globalSkip` marks this a GLOBAL
            // (config-declared) skip — the shape that cannot live in an
            // upstream module, so the carve-out must keep it.
            globalSkip: true,
            swallowedFailure: true,
          }),
        ],
      } as unknown as BuildTestReport;
      const s = run(
        '## Test Plan\n\nRan `./mvnw -pl core test`',
        [],
        suppressedBt,
      );
      const sClaim = s.claims.find((c) => c.text === './mvnw -pl core test');
      expect(sClaim?.verdict).toBe('contradicted');
      expect(sClaim?.observed).toContain('skip setting');
    });

    it('reads an exit-0 never-ran run under the evidence cap as uncertified', () => {
      // The states that fire the cap — a rejected fresh report, a
      // truncated sweep — are positive proof the toolchain DID start,
      // which defeats the zero-summaries inference `neverRan` rests on.
      // A capped never-ran run therefore settles nothing: it reads
      // unchecked, never the never-ran contradiction.
      const bt = {
        build: [],
        test: [mavenCmd({ exitCode: 0, neverRan: true, evidenceCapped: true })],
      } as unknown as BuildTestReport;

      const r = run('## Test Plan\n\nRan `./mvnw -pl core test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw -pl core test');
      expect(claim?.verdict).toBe('unchecked');
      expect(claim?.note).toContain('never read');
    });

    it('ranks a capped run with definitive failure evidence above a green finished sibling', () => {
      // build-test records one scoped run per module, and a bare claim
      // matches every one of them — a green finished sibling used to
      // shadow a capped run whose own evidence is definitive (a non-zero
      // exit, or exit-0 failure markers the cap cannot defeat), and the
      // claim read `reproduces` over a run the build-test report marks
      // failed. The same capped run alone rules contradicted — the
      // sibling must not flip it.
      const exit1 = {
        build: [],
        test: [
          mavenCmd({
            modules: ['core'],
            exitCode: 1,
            evidenceCapped: true,
            output:
              '[maven-test-failure] core/target/surefire-reports/TEST-A.xml: example.ATest#fails',
          }),
          mavenCmd({ modules: ['cli'], exitCode: 0 }),
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], exit1);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('exit 1');
      expect(claim?.note).toContain('non-zero exit is definitive');

      // The exit-0 twin: fresh-failure markers survive the cap the same
      // way — the sibling must not shadow them either.
      const exit0 = {
        build: [],
        test: [
          mavenCmd({
            modules: ['core'],
            exitCode: 0,
            evidenceCapped: true,
            output:
              '[maven-test-report] core (1 failing report(s)): tests=2, failures=1, errors=0, skipped=0\n' +
              '[maven-test-failure] core/target/surefire-reports/TEST-A.xml: example.ATest#fails',
          }),
          mavenCmd({ modules: ['cli'], exitCode: 0 }),
        ],
      } as unknown as BuildTestReport;
      const s = run('## Test Plan\n\nRan `./mvnw test`', [], exit0);
      const sClaim = s.claims.find((c) => c.text === './mvnw test');
      expect(sClaim?.verdict).toBe('contradicted');
      expect(sClaim?.observed).toContain('fresh Surefire/Failsafe reports');
    });

    it('does not settle a claim on an infrastructure-classified Maven run', () => {
      // A dependency-resolution failure the same review labels
      // 'infrastructure evidence' must not falsify the author's claim.
      const bt = {
        build: [],
        test: [
          mavenCmd({
            exitCode: 1,
            output: '[ERROR] Could not resolve dependencies',
            infrastructure: true,
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('unchecked');
      expect(claim?.note).toContain('environmental reasons');
      expect(claim?.note).not.toContain('not run');
    });

    it('does not reproduce a claim when the matched run recorded fresh test failures', () => {
      // surefire testFailureIgnore lets `mvn test` exit 0 over failing tests;
      // the adapter flags ok:false on the same result, so the Test Plan must
      // not certify it as reproduced.
      const bt = {
        build: [],
        test: [
          mavenCmd({
            modules: null,
            output:
              '[maven-test-report] core (1 failing report(s)): tests=2, failures=1, errors=0, skipped=0\n' +
              '[maven-test-failure] core/target/surefire-reports/TEST-A.xml: example.ATest#fails',
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toContain('fresh Surefire/Failsafe reports');
    });

    it('verifies a bare wrapper token as a path claim, not an unsettleable command', () => {
      // `./mvnw` alone carries no lifecycle: the command reading can
      // never settle, and it used to suppress the path verification the
      // token actually is — "added `./mvnw`" is a claim about the tree.
      // As a path claim it reproduces when the wrapper is in the tree...
      writeFileSync(join(dir, 'mvnw'), '#!/bin/sh\n');
      const present = run('## Test Plan\n\nAdded `./mvnw`');
      expect(verdictOf(present.claims, './mvnw')).toBe('reproduces');
      expect(
        present.claims.filter(
          (c) => c.kind === 'command' && c.text === './mvnw',
        ),
      ).toEqual([]);

      // ...and contradicts when the tree does not hold it.
      rmSync(join(dir, 'mvnw'));
      const absent = run('## Test Plan\n\nAdded `./mvnw`');
      expect(verdictOf(absent.claims, './mvnw')).toBe('contradicted');
    });

    it('gives Maven wording to Maven claims whose final token is not a lifecycle', () => {
      for (const command of ['mvn test -Dtest=ChangedTest']) {
        const r = run(`## Test Plan\n\nRan \`${command}\``);
        const claim = r.claims.find((c) => c.text === command);
        expect(claim?.verdict).toBe('unchecked');
        expect(claim?.note).toContain('Maven command was not run');
        expect(claim?.note).not.toContain('npm script');
      }

      // A bare runner token naming no work is no claim at all: the
      // command reading can never settle, and without a `./` or path
      // shape there is no filename reading either.
      const bare = run('## Test Plan\n\nRan `mvn`');
      expect(bare.claims.filter((c) => c.text === 'mvn')).toEqual([]);
    });

    it('settles a multi-token Maven lifecycle claim on its final phase', () => {
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;

      const green = run('## Test Plan\n\nRan `./mvnw clean test`', [], bt);
      const claim = green.claims.find((c) => c.text === './mvnw clean test');
      expect(claim?.verdict).toBe('reproduces');
      expect(claim?.note).toContain('module-scoped');

      // Flag-only additions do not scope the claim either.
      const batch = run('## Test Plan\n\nRan `mvn -B test`', [], bt);
      expect(verdictOf(batch.claims, 'mvn -B test')).toBe('reproduces');
    });

    it('says the full reactor ran when the recorded command did not narrow', () => {
      const bt = {
        build: [],
        test: [mavenCmd({ exe: 'mvn', modules: null })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `mvn test`', [], bt);
      const claim = r.claims.find((c) => c.text === 'mvn test');
      expect(claim?.verdict).toBe('reproduces');
      expect(claim?.note).toBe('this review ran it');
    });

    it('leaves an unobserved Maven command unchecked with Maven wording', () => {
      const r = run('## Test Plan\n\nRan `mvn -q verify`');
      const claim = r.claims.find((c) => c.text === 'mvn -q verify');
      expect(claim?.verdict).toBe('unchecked');
      expect(claim?.note).toContain('Maven command was not run');
    });

    it('does not match Maven claims with different profiles or project scopes', () => {
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;

      for (const command of ['./mvnw -Pjdk25 test', './mvnw -pl app test']) {
        const r = run(`## Test Plan\n\nRan \`${command}\``, [], bt);
        const claim = r.claims.find((c) => c.text === command);
        expect(claim?.verdict).toBe('unchecked');
        expect(claim?.note).toContain('Maven command was not run');
      }
    });

    it('settles a -pl claim on a recorded run of the same module scope', () => {
      // The review injects its own flags, so exact/prefix matching fails; the
      // identical scope and phase still settle the claim.
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl core -am test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw -pl core -am test');
      expect(claim?.verdict).toBe('reproduces');
      expect(claim?.note).toContain('module-scoped');
    });

    it('contradicts a -pl claim when the same-scope run failed', () => {
      const bt = {
        build: [],
        test: [mavenCmd({ exitCode: 1, output: '[ERROR] Tests failed' })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl core -am test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw -pl core -am test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('exit 1');
    });

    it('says a differently scoped Maven run happened instead of nothing', () => {
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl app -am test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw -pl app -am test');
      expect(claim?.verdict).toBe('unchecked');
      expect(claim?.note).toContain('Maven command was not run');
      expect(claim?.note).toContain('different scope or phase');
    });

    it('does not settle -rf/-N/-f claims from differently scoped runs', () => {
      const bt = {
        build: [],
        test: [mavenCmd({ exitCode: 1, output: '[ERROR] Tests failed' })],
      } as unknown as BuildTestReport;
      for (const command of [
        'mvn -rf :core test',
        'mvn -N test',
        'mvn -f other/pom.xml test',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${command}\``, [], bt);
        expect(verdictOf(r.claims, command)).toBe('unchecked');
      }
    });

    it('does not settle long-form-scoped claims from differently scoped runs', () => {
      // The long forms of -P/-D/-rf/-N scope a claim exactly like the short
      // forms; -amd/--also-make-dependents' downstream closure is an
      // uncomparable scope too.
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;

      for (const command of [
        './mvnw --non-recursive test',
        './mvnw --activate-profiles jdk25 test',
        './mvnw --define foo=bar test',
        './mvnw --resume-from :core test',
        './mvnw -pl core -amd test',
        './mvnw -pl core --also-make-dependents test',
        './mvnw -pl core --settings ci-settings.xml test',
        './mvnw -pl core --global-settings global-settings.xml test',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${command}\``, [], bt);
        expect(verdictOf(r.claims, command)).toBe('unchecked');
      }

      // The flip direction too: a FAILED recorded run must not contradict a
      // claim whose extra scope that run never exercised.
      const failed = {
        build: [],
        test: [mavenCmd({ exitCode: 1, output: '[ERROR] Tests failed' })],
      } as unknown as BuildTestReport;
      const flip = run(
        '## Test Plan\n\nRan `./mvnw -pl core -amd test`',
        [],
        failed,
      );
      expect(verdictOf(flip.claims, './mvnw -pl core -amd test')).toBe(
        'unchecked',
      );
    });

    it('settles multi-module -pl claims on the same module set, in any order', () => {
      const withModules = (modules: string[]) =>
        ({
          build: [],
          test: [mavenCmd({ modules })],
        }) as unknown as BuildTestReport;

      // Order independence and cardinality: the adapter records multi-module
      // selectors, and the claim names the same set the other way round.
      const same = run(
        '## Test Plan\n\nRan `./mvnw -pl app,core test`',
        [],
        withModules(['core', 'app']),
      );
      expect(verdictOf(same.claims, './mvnw -pl app,core test')).toBe(
        'reproduces',
      );

      // A recorded run with FEWER modules never tested the extra one.
      const fewer = run(
        '## Test Plan\n\nRan `./mvnw -pl core,app test`',
        [],
        withModules(['core']),
      );
      expect(verdictOf(fewer.claims, './mvnw -pl core,app test')).toBe(
        'unchecked',
      );
    });

    it('does not contradict a -pl claim on a FAILED -am run of the same module set', () => {
      // `-am` pulls the UPSTREAM modules into the run; a failure in one of
      // them never falsifies a claim without `-am`, which never tests them.
      // The green direction stays settled (pinned above): only the failing
      // direction falls through to the conservative unchecked cascade.
      const failed = {
        build: [],
        test: [mavenCmd({ exitCode: 1, output: '[ERROR] Tests failed' })],
      } as unknown as BuildTestReport;

      const r = run('## Test Plan\n\nRan `./mvnw -pl core test`', [], failed);
      expect(verdictOf(r.claims, './mvnw -pl core test')).toBe('unchecked');

      // The -am-less claim's other spellings carry the same carve-out.
      const longForm = run(
        '## Test Plan\n\nRan `./mvnw --projects core test`',
        [],
        failed,
      );
      expect(verdictOf(longForm.claims, './mvnw --projects core test')).toBe(
        'unchecked',
      );
    });

    it('reads -pl= and --projects selector spellings in a claim', () => {
      // Claim-side only: a PR author writes any spelling Maven accepts. The
      // RUN side is not parsed at all — it reports its module set as data —
      // so there is no recorded spelling left to normalize.
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;

      for (const claim of [
        './mvnw -pl=core test',
        './mvnw --projects core test',
        './mvnw --projects=core test',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${claim}\``, [], bt);
        expect(verdictOf(r.claims, claim)).toBe('reproduces');
      }
    });

    it('settles a test-compile claim on the recorded build-only run', () => {
      // --build-only records `test-compile`; disavowing the phase would say
      // the review never ran what it did.
      const bt = {
        build: [mavenCmd({ lifecycle: 'test-compile' })],
        test: [],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test-compile`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test-compile');
      expect(claim?.verdict).toBe('reproduces');
      expect(claim?.note).toContain('module-scoped');
    });

    it('does not settle a -pl claim combined with other scopes from a same-module run', () => {
      // `-pl core -Pjdk25` is profile-scoped AS WELL AS module-scoped; the
      // same-module recorded run never activated that profile.
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;

      for (const command of [
        './mvnw -pl core -Pjdk25 test',
        './mvnw -pl core -Dfoo=bar test',
        './mvnw -pl core -rf :core test',
        './mvnw -pl core -N test',
        './mvnw -pl core -f other/pom.xml test',
        // The other semantics-altering value flags MAVEN_VALUE_FLAGS
        // models: a claim carrying one cannot settle on a run that never
        // used it — the adapter never injects any of these.
        './mvnw -pl core -s ci-settings.xml test',
        './mvnw -pl core -gs global-settings.xml test',
        './mvnw -pl core -t jdk11-toolchains.xml test',
        './mvnw -pl core -gt global-toolchains.xml test',
        './mvnw -pl core -b smart test',
        // The attached-value spelling the exact-token match missed.
        './mvnw -pl core -amd=app test',
        // Offline mode and forced snapshot updates change what resolution
        // the run performs; the long spellings carry the same scope.
        './mvnw -pl core -o test',
        './mvnw -pl core --offline test',
        './mvnw -pl core -U test',
        './mvnw -pl core --update-snapshots test',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${command}\``, [], bt);
        expect(verdictOf(r.claims, command)).toBe('unchecked');
      }
    });

    it('does not settle a claim whose final positional token is not the claimed lifecycle', () => {
      // `mvn test deploy` names deploy as its LAST work; settling the
      // recognized `test` phase alone would read undisclosed. Trailing
      // flag tokens (`-B`) still settle.
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;

      const deploy = run('## Test Plan\n\nRan `mvn test deploy`', [], bt);
      expect(verdictOf(deploy.claims, 'mvn test deploy')).toBe('unchecked');
      expect(
        deploy.claims.find((c) => c.text === 'mvn test deploy')?.note,
      ).toContain('different scope or phase');

      const site = run('## Test Plan\n\nRan `mvn test site`', [], bt);
      expect(verdictOf(site.claims, 'mvn test site')).toBe('unchecked');

      // Phase reduction still settles when the final token IS the phase.
      const clean = run('## Test Plan\n\nRan `mvn clean test`', [], bt);
      expect(verdictOf(clean.claims, 'mvn clean test')).toBe('reproduces');
    });

    it('leaves a coordinate -pl claim unsettleable rather than matching it against a directory run', () => {
      // `-pl :core` selects by artifactId — a different NAMESPACE than the
      // recorded module directories. artifactId and dir name can disagree,
      // and two dirs can share one artifactId, so string-matching the
      // reduced coordinate against a dir could settle — or contradict — the
      // claim with a DIFFERENT module's run. Unchecked beats wrong.
      const green = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl :core test`', [], green);
      const claim = r.claims.find((c) => c.text === './mvnw -pl :core test');
      expect(claim?.verdict).toBe('unchecked');
    });

    it('settles a ./-prefixed -pl claim exactly like the bare spelling', () => {
      // Maven treats `-pl ./core` identically to `-pl core`, and the
      // recorded modules never carry the prefix — without the
      // normalization the natural spelling could never settle or be
      // contradicted.
      const green = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;
      const r = run(
        '## Test Plan\n\nRan `./mvnw -pl ./core -am test`',
        [],
        green,
      );
      const claim = r.claims.find(
        (c) => c.text === './mvnw -pl ./core -am test',
      );
      expect(claim?.verdict).toBe('reproduces');
    });

    it('does not read an -am inside a quoted attached -pl= selector as the flag', () => {
      // The space-form twin already consumes the quoted selector; the
      // attached form broke at the space and the bare `-am` token inside it
      // disabled the upstream-failure carve-out, contradicting a correct
      // claim.
      const output =
        '[maven-test-report] aaa (1 failing report(s)): tests=2, failures=1, errors=0, skipped=0\n' +
        '[maven-test-failure] aaa/target/surefire-reports/TEST-A.xml: example.ATest#fails';
      const bt = {
        build: [],
        test: [
          mavenCmd({
            modules: ['foo -am bar'],
            exitCode: 1,
            output,
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run(
        "## Test Plan\n\nRan `./mvnw -pl='foo -am bar' test`",
        [],
        bt,
      );
      const claim = r.claims.find(
        (c) => c.text === "./mvnw -pl='foo -am bar' test",
      );
      // The failure lives in upstream `aaa`, which the claim (no `-am`)
      // never tests — the carve-out applies and the claim stays unchecked.
      expect(claim?.verdict).toBe('unchecked');
    });

    it('discloses the phase reduction when a claim carries unrun work in non-trailing position', () => {
      // `mvn deploy test` never ran `deploy` here: settling through the
      // trailing in-vocabulary phase must disclose the reduction rather
      // than read as if the whole claim ran.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `mvn deploy test`', [], bt);
      const claim = r.claims.find((c) => c.text === 'mvn deploy test');
      expect(claim?.verdict).toBe('reproduces');
      expect(claim?.note).toContain('final phase');
      expect(claim?.note).toContain('deploy test');
    });

    it('discloses the phase reduction for every out-of-vocabulary phase', () => {
      // MAVEN_UNRUN_WORK_RE covers the whole phase vocabulary outside the
      // settlement set — pre-clean, prepare-package, and the integration
      // phases included; each must disclose, not silently settle.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;
      for (const command of [
        'mvn pre-clean test',
        'mvn post-clean test',
        'mvn prepare-package test',
        'mvn pre-integration-test test',
        'mvn integration-test test',
        'mvn post-integration-test test',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${command}\``, [], bt);
        const claim = r.claims.find((c) => c.text === command);
        expect(claim?.verdict).toBe('reproduces');
        expect(claim?.note).toContain('final phase');
      }
    });

    it('contradicts an -am-excluded claim when the failure survives as a report line inside the claim', () => {
      // The 200-line case cap can drop every [maven-test-failure] line of
      // the claimed module while its [maven-test-report] line survives with
      // failures>0 — that surviving line is in-scope failure evidence, or
      // truncation alone would flip the verdict.
      const output =
        '[maven-test-report] aaa (1 failing report(s)): tests=300, failures=250, errors=0, skipped=0\n' +
        Array.from(
          { length: 200 },
          (_, i) =>
            `[maven-test-failure] aaa/target/surefire-reports/TEST-A.xml: example.ATest#f${i}`,
        ).join('\n') +
        '\n[maven-test-failure] 51 more failing case(s) omitted\n' +
        '[maven-test-report] zzz (1 failing report(s)): tests=5, failures=1, errors=0, skipped=0';
      const bt = {
        build: [],
        test: [
          mavenCmd({
            modules: ['zzz'],
            exitCode: 0,
            output,
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl zzz test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw -pl zzz test');
      expect(claim?.verdict).toBe('contradicted');
    });

    it('settles nothing against a run whose evidence the adapter refused to certify', () => {
      // An evidenceCapped run is ok:false because its parsed subset is
      // partial BY DEFINITION — it must not rule a claim reproduced, and
      // its counts must not adjudicate a count claim.
      const bt = {
        build: [],
        test: [
          mavenCmd({
            modules: null,
            evidenceCapped: true,
            output:
              '[maven-test-report] core (3 report(s)): tests=1000, failures=0, errors=0, skipped=0',
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('unchecked');
      expect(claim?.note).toContain('not certified');
    });

    it('discloses the reduced form of an interrupted matching run too', () => {
      // The interrupted-failure note must not read "this review ran it"
      // when the run that recorded the failures was a module-scoped
      // reduced form of the claim.
      const output =
        '[maven-test-report] core (1 failing report(s)): tests=2, failures=1, errors=0, skipped=0\n' +
        '[maven-test-failure] core/target/surefire-reports/TEST-A.xml: example.ATest#fails';
      const bt = {
        build: [],
        test: [mavenCmd({ exitCode: null, timedOut: true, output })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.note).toContain('module-scoped');
      expect(claim?.note).toContain('interrupted');
    });

    it('discloses the reduced form in the timeout and spawn-death notes', () => {
      // The unchecked cascade phrased every matched run as "this Maven
      // command was run by this review" — overstating a module-scoped
      // reduced form of the claim exactly as the finished-run branches
      // used to.
      const timedOutBt = {
        build: [],
        test: [mavenCmd({ exitCode: null, seconds: 120, timedOut: true })],
      } as unknown as BuildTestReport;
      const timedOut = run('## Test Plan\n\nRan `./mvnw test`', [], timedOutBt);
      const claim = timedOut.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('unchecked');
      expect(claim?.note).toContain('module-scoped');
      expect(claim?.note).toContain('timed out');

      const deathBt = {
        build: [],
        test: [mavenCmd({ exitCode: null })],
      } as unknown as BuildTestReport;
      const death = run('## Test Plan\n\nRan `./mvnw test`', [], deathBt);
      const deathClaim = death.claims.find((c) => c.text === './mvnw test');
      expect(deathClaim?.verdict).toBe('unchecked');
      expect(deathClaim?.note).toContain('module-scoped');
      expect(deathClaim?.note).toContain('ended without an exit code');
    });

    it('contradicts a claim when the interrupted run recorded fresh failures', () => {
      const output =
        '[maven-test-report] core (1 failing report(s)): tests=2, failures=1, errors=0, skipped=0\n' +
        '[maven-test-failure] core/target/surefire-reports/TEST-A.xml: example.ATest#fails';
      // The deadline kill and the spawn death both keep the captured
      // regressions as contradicting evidence.
      for (const timedOut of [true, false]) {
        const bt = {
          build: [],
          test: [mavenCmd({ exitCode: null, timedOut, output })],
        } as unknown as BuildTestReport;
        const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
        const claim = r.claims.find((c) => c.text === './mvnw test');
        expect(claim?.verdict).toBe('contradicted');
        expect(claim?.observed).toContain('interrupted');
      }
    });

    it('does not let a green finished sibling shadow an interrupted run with fresh failures', () => {
      // The finished-run ranking used to win whenever ANY finished run
      // matched: the claim read `reproduces` off the green sibling while
      // the build-test report said ok:false with recorded failures.
      const output =
        '[maven-test-report] core (1 failing report(s)): tests=2, failures=1, errors=0, skipped=0\n' +
        '[maven-test-failure] core/target/surefire-reports/TEST-A.xml: example.ATest#fails';
      const bt = {
        build: [],
        test: [
          mavenCmd(),
          mavenCmd({ exitCode: null, timedOut: true, output }),
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toContain('interrupted');
    });

    it('does not contradict a -pl claim on an INTERRUPTED -am run of the same module set', () => {
      // The finished twin of this guard is pinned above; the interrupted
      // fresh-failure branch must apply the same scope asymmetry — the
      // failures may live entirely in upstream modules only `-am` pulled
      // in, which the claim never tests.
      const output =
        '[maven-test-report] upstream (1 failing report(s)): tests=2, failures=1, errors=0, skipped=0\n' +
        '[maven-test-failure] upstream/target/surefire-reports/TEST-A.xml: example.ATest#fails';
      for (const timedOut of [true, false]) {
        const bt = {
          build: [],
          test: [mavenCmd({ exitCode: null, timedOut, output })],
        } as unknown as BuildTestReport;
        const r = run('## Test Plan\n\nRan `./mvnw -pl core test`', [], bt);
        expect(verdictOf(r.claims, './mvnw -pl core test')).toBe('unchecked');
      }
    });

    it('rules a spawn-level death contradicted for non-Maven claims', () => {
      // exitCode null without a deadline kill is a run that never finished;
      // the manifest fallback must not certify it as reproduced. (Maven
      // claims keep their unchecked cascade, pinned above, and a deadline
      // kill keeps falling through to the manifest, pinned as 'does not
      // rule on a command killed by the deadline'.)
      const bt = {
        build: [],
        test: [
          {
            command: 'npm test --workspace="packages/a"',
            exitCode: null,
            seconds: 3,
            timedOut: false,
            output: '',
          },
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `npm test`', [], bt);
      const claim = r.claims.find((c) => c.text === 'npm test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('it ended without an exit code');
    });

    it('does not leak an attached quoted flag value into the positionals', () => {
      // The attached `<flag>='…'` form carries its quoted value in-token
      // for EVERY value flag — the old consumption covered only `-pl=`/
      // `--projects=`, so `-l='a test -B'` leaked the `test` fragment and
      // settled a claim that runs no lifecycle work.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;
      const leaked = run("## Test Plan\n\nRan `mvn -l='a test -B'`", [], bt);
      expect(verdictOf(leaked.claims, "mvn -l='a test -B'")).toBe('unchecked');

      // The mirror false negative: the same value beside a real phase used
      // to never settle while its space-form twin did.
      const settled = run(
        "## Test Plan\n\nRan `mvn test -l='build log.txt'`",
        [],
        bt,
      );
      expect(verdictOf(settled.claims, "mvn test -l='build log.txt'")).toBe(
        'reproduces',
      );
    });

    it('does not leak a quoted value whose first word is empty', () => {
      // A quoted value starting with a space breaks into a BARE opening
      // quote token; the rejoin/consume loops checked the closing quote
      // before advancing, so the span was never rejoined and `test` leaked
      // into the positionals.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;
      const leaked = run("## Test Plan\n\nRan `mvn -l ' x test -B'`", [], bt);
      expect(verdictOf(leaked.claims, "mvn -l ' x test -B'")).toBe('unchecked');

      const settled = run(
        "## Test Plan\n\nRan `mvn test -l ' x verify -e'`",
        [],
        bt,
      );
      expect(verdictOf(settled.claims, "mvn test -l ' x verify -e'")).toBe(
        'reproduces',
      );
    });

    it('does not settle claims on the password-encryption options', () => {
      // `-emp`/`-ep` and their long spellings consume their argument and
      // perform ZERO lifecycle work; reading the argument as a positional
      // phase settled claims that built and tested nothing. All four
      // spellings — including the commons-cli single-dash long one — carry
      // the same treatment.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;
      for (const claim of [
        'mvn -emp test',
        'mvn -ep test',
        'mvn --encrypt-master-password test',
        'mvn -encrypt-master-password test',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${claim}\``, [], bt);
        expect(verdictOf(r.claims, claim)).toBe('unchecked');
      }
    });

    it('does not settle a claim carrying mid-position unknown work', () => {
      // Maven dies on 'Unknown lifecycle phase' for a bare positional that
      // names no work (`mvn foo test` runs nothing); settling the trailing
      // phase anyway read `reproduces` over a command that errored out.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `mvn foo test`', [], bt);
      expect(verdictOf(r.claims, 'mvn foo test')).toBe('unchecked');
    });

    it('extracts ././-prefixed runner spellings as commands', () => {
      // A leading `./` before upward hops (or another `./`) used to fall
      // out of the runner grammar, so the claim was never extracted.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `././mvnw test`', [], bt);
      expect(verdictOf(r.claims, '././mvnw test')).toBe('reproduces');
    });

    it('extracts case- and .exe-variant runner spellings as commands', () => {
      // scoop/Chocolatey installs create an `mvn.exe` shim, and Windows
      // authors type `MVNW`/`mvnw.CMD` on a case-insensitive filesystem —
      // a span the runner check rejects is a claim never extracted.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null, exe: 'mvn' })],
      } as unknown as BuildTestReport;
      const exe = run('## Test Plan\n\nRan `mvn.exe test`', [], bt);
      expect(verdictOf(exe.claims, 'mvn.exe test')).toBe('reproduces');
      const upper = run('## Test Plan\n\nRan `MVNW test`', [], bt);
      expect(verdictOf(upper.claims, 'MVNW test')).toBe('reproduces');
    });

    it('does not attribute a src/-named module failure to a root claim', () => {
      // The root-project arm keyed on the `<worktree>/src/` substring: a
      // module literally named `src` sits beneath it, and attributing its
      // compile failure to a claim naming the root module defeats the
      // `-am` carve-out in the accusing direction. Attribution walks to
      // the owning pom.xml instead; a failure inside a CLAIMED module
      // still contradicts.
      writeFileSync(join(dir, 'pom.xml'), '<project/>');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'pom.xml'), '<project/>');
      mkdirSync(join(dir, 'app'), { recursive: true });
      writeFileSync(join(dir, 'app', 'pom.xml'), '<project/>');
      const wt = dir.replace(/\\/g, '/');

      const outside = {
        build: [],
        test: [
          mavenCmd({
            modules: ['.', 'app'],
            exitCode: 1,
            output: `[ERROR] ${wt}/src/src/main/java/Foo.java:[10,5] boom`,
          }),
        ],
      } as unknown as BuildTestReport;
      const uncheckedRun = run(
        '## Test Plan\n\nRan `./mvnw -pl .,app test`',
        [],
        outside,
      );
      expect(verdictOf(uncheckedRun.claims, './mvnw -pl .,app test')).toBe(
        'unchecked',
      );

      const inside = {
        build: [],
        test: [
          mavenCmd({
            modules: ['.', 'app'],
            exitCode: 1,
            output: `[ERROR] ${wt}/app/src/main/java/Bar.java:[10,5] boom`,
          }),
        ],
      } as unknown as BuildTestReport;
      const contradictedRun = run(
        '## Test Plan\n\nRan `./mvnw -pl .,app test`',
        [],
        inside,
      );
      expect(verdictOf(contradictedRun.claims, './mvnw -pl .,app test')).toBe(
        'contradicted',
      );
    });

    it('compares quoted -pl selectors as their module sets', () => {
      // A module dir with a space passes the ownership walk, and the CLAIM
      // may quote it; the claim parser must rejoin the selector instead of
      // collapsing it to its first word.
      const recorded = {
        build: [],
        test: [mavenCmd({ modules: ['my module', 'my other'] })],
      } as unknown as BuildTestReport;

      const same = run(
        "## Test Plan\n\nRan `./mvnw -pl 'my module,my other' test`",
        [],
        recorded,
      );
      expect(
        verdictOf(same.claims, "./mvnw -pl 'my module,my other' test"),
      ).toBe('reproduces');

      // Sharing a first word is NOT the same module set: the recorded run
      // never tested `my module` alone.
      const different = run(
        "## Test Plan\n\nRan `./mvnw -pl 'my module' test`",
        [],
        recorded,
      );
      expect(verdictOf(different.claims, "./mvnw -pl 'my module' test")).toBe(
        'unchecked',
      );
    });

    it('settles adjacent-quote -pl selectors shell-quote joins into one word', () => {
      // A selector whose quoting does not open on a token boundary —
      // `core","other`'s adjacent quotes — leaked past a whitespace-split
      // walker as separate tokens and settled the wrong module set (or
      // fell through to a false "was not run by this review"). A shell
      // joins them into one word, and the claim parses like a shell.
      const recorded = {
        build: [],
        test: [mavenCmd({ modules: ['core', 'other'] })],
      } as unknown as BuildTestReport;

      const adjacent = run(
        '## Test Plan\n\nRan `./mvnw -pl core","other test`',
        [],
        recorded,
      );
      expect(verdictOf(adjacent.claims, './mvnw -pl core","other test')).toBe(
        'reproduces',
      );
    });

    it('does not read a maven failure marker out of a non-Maven run', () => {
      // Only the Maven adapter emits `[maven-test-failure]`; a green npm
      // run whose stdout merely prints the literal (any test can
      // console.log it, and this repo's own suites do) must stay
      // reproduced — the marker can never be legitimate evidence in a
      // non-Maven result.
      const bt = {
        build: [],
        test: [
          {
            command: 'npm test',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output:
              '[maven-test-failure] core/target/surefire-reports/TEST-A.xml: example.ATest#fails',
          },
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `npm test`', [], bt);
      const claim = r.claims.find((c) => c.text === 'npm test');
      expect(claim?.verdict).toBe('reproduces');
      expect(claim?.observed).toBe('exit 0');
    });

    it('contradicts a space-bearing -pl claim when the same-scope run failed inside it', () => {
      // Module dirs with spaces pass the POM gate and shellSelector quotes
      // them; the selector rejoin must advance past the flag before
      // reading, or the duplicated first word breaks failure attribution
      // against real report paths and silently discards the evidence.
      const bt = {
        build: [],
        test: [
          mavenCmd({
            modules: ['my module'],
            exitCode: 1,
            output:
              '[maven-test-report] my module (1 failing report(s)): tests=2, failures=1, errors=0, skipped=0\n' +
              '[maven-test-failure] my module/target/surefire-reports/TEST-A.xml: example.ATest#fails',
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run(
        "## Test Plan\n\nRan `./mvnw -pl 'my module' test`",
        [],
        bt,
      );
      expect(verdictOf(r.claims, "./mvnw -pl 'my module' test")).toBe(
        'contradicted',
      );
    });

    it('does not read -b/-t/-gt flag values as lifecycle phases', () => {
      // Maven's other space-separated value flags consume their next
      // token: a toolchains/builder FILE named `test` used to read as a
      // claimed `test` phase and let a module-scoped test run certify a
      // `verify` claim.
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;
      for (const command of [
        'mvn verify -t test',
        'mvn verify -b test',
        'mvn verify -gt test',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${command}\``, [], bt);
        expect(verdictOf(r.claims, command)).toBe('unchecked');
      }
    });

    it('contradicts an -am claim when a same-scope run WITHOUT -am failed', () => {
      // The converse of the -am exclusion: a run that never pulled in
      // upstream modules and still failed inside the claimed module set
      // falsifies the wider claim too. The implementation comment relies
      // on this direction, so pin it.
      const failed = {
        build: [],
        test: [
          mavenCmd({
            alsoMake: false,
            exitCode: 1,
            output: '[ERROR] Tests failed',
          }),
        ],
      } as unknown as BuildTestReport;

      const r = run(
        '## Test Plan\n\nRan `./mvnw -pl core -am test`',
        [],
        failed,
      );
      const claim = r.claims.find((c) => c.text === './mvnw -pl core -am test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('exit 1');

      // The long spelling of the claim's also-make flag behaves identically.
      const longForm = run(
        '## Test Plan\n\nRan `./mvnw -pl core --also-make test`',
        [],
        failed,
      );
      const longClaim = longForm.claims.find(
        (c) => c.text === './mvnw -pl core --also-make test',
      );
      expect(longClaim?.verdict).toBe('contradicted');
      expect(longClaim?.observed).toBe('exit 1');
    });

    it('discloses the phase reduction of a multi-phase claim', () => {
      // The adapter only ever runs `test`/`test-compile`; settling
      // `clean test` on one must not read as if `clean` ran — neither in
      // the reactor-wide shape nor the module-scoped one.
      const reactorWide = {
        build: [],
        test: [mavenCmd({ exe: 'mvn', modules: null })],
      } as unknown as BuildTestReport;
      const wide = run(
        '## Test Plan\n\nRan `./mvnw clean test`',
        [],
        reactorWide,
      );
      const wideClaim = wide.claims.find((c) => c.text === './mvnw clean test');
      expect(wideClaim?.verdict).toBe('reproduces');
      expect(wideClaim?.note).toContain('final phase (`test`)');
      expect(wideClaim?.note).toContain('`clean test`');

      const scoped = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;
      const narrow = run('## Test Plan\n\nRan `./mvnw clean test`', [], scoped);
      expect(
        narrow.claims.find((c) => c.text === './mvnw clean test')?.note,
      ).toContain('module-scoped form of its final phase');
    });

    it('discloses the phase reduction of a -pl-scoped multi-phase claim too', () => {
      // settledBySameScope settlements of a `-pl` multi-phase claim must
      // say the earlier phases did not run, exactly as the unscoped twin.
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl core clean test`', [], bt);
      const claim = r.claims.find(
        (c) => c.text === './mvnw -pl core clean test',
      );
      expect(claim?.verdict).toBe('reproduces');
      expect(claim?.note).toContain('module-scoped form of its final phase');
      expect(claim?.note).toContain('`clean test`');
    });

    it('does not read a phase-named -pl value as the claimed lifecycle', () => {
      // A module dir named `test`: the claimed lifecycle is `verify`, not
      // the selector value, so a mere `test` run must not settle it.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: ['test'] })],
      } as unknown as BuildTestReport;
      const phaseNamed = run(
        '## Test Plan\n\nRan `./mvnw verify -pl test`',
        [],
        bt,
      );
      expect(verdictOf(phaseNamed.claims, './mvnw verify -pl test')).toBe(
        'unchecked',
      );

      // Control: the same claim shape with an ordinary module name stays
      // unchecked the same way — behavior must not depend on the module
      // name being a phase word.
      const ordinary = run(
        '## Test Plan\n\nRan `./mvnw verify -pl core`',
        [],
        bt,
      );
      expect(verdictOf(ordinary.claims, './mvnw verify -pl core')).toBe(
        'unchecked',
      );
    });

    it('settles a phase-first Maven claim whose flags follow the phase', () => {
      // `./mvnw test -pl core` carries tokens after its final phase; the
      // claim still settles on the same-scope recorded run instead of
      // falling through to a false "different scope or phase" note.
      const green = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;

      const pl = run('## Test Plan\n\nRan `./mvnw test -pl core`', [], green);
      const plClaim = pl.claims.find((c) => c.text === './mvnw test -pl core');
      expect(plClaim?.verdict).toBe('reproduces');
      expect(plClaim?.note).toContain('module-scoped');

      const flag = run('## Test Plan\n\nRan `mvn test -B`', [], green);
      expect(verdictOf(flag.claims, 'mvn test -B')).toBe('reproduces');
    });

    it('keeps a failed -am run contradicting when its failures are inside the claimed set', () => {
      // The `-am` carve-out yields when the run's own markers attribute a
      // failure to a module the claim DOES test — the common shape, since
      // the adapter always records `-am` while author claims omit it.
      const output =
        '[maven-test-report] core (1 failing report(s)): tests=2, failures=1, errors=0, skipped=0\n' +
        '[maven-test-failure] core/target/surefire-reports/TEST-A.xml: example.ATest#fails';
      const failed = {
        build: [],
        test: [mavenCmd({ exitCode: 1, output })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl core test`', [], failed);
      const claim = r.claims.find((c) => c.text === './mvnw -pl core test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('exit 1');
    });

    it('keeps an ERRORS-only failed -am run contradicting when the errors are inside the claimed set', () => {
      // The attribution branch reads failures AND errors off the surviving
      // rollup line; an errors-only rollup (no case markers past the cap)
      // must contradict exactly like its failures-only twin.
      const output =
        '[maven-test-report] core (1 failing report(s)): tests=2, failures=0, errors=2, skipped=0';
      const failed = {
        build: [],
        test: [mavenCmd({ exitCode: 1, output })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl core test`', [], failed);
      const claim = r.claims.find((c) => c.text === './mvnw -pl core test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('exit 1');
    });

    it('contradicts a root-module claim on failures in the root project', () => {
      // The root twin of the guard above: `-pl .` claims the root module,
      // and a failure marker rooted at `target/` (no module prefix) is
      // INSIDE that claim even though the same marker sits outside every
      // non-root module set.
      const output =
        '[maven-test-report] . (1 failing report(s)): tests=2, failures=1, errors=0, skipped=0\n' +
        '[maven-test-failure] target/surefire-reports/TEST-Root.xml: example.RootTest#fails';
      const failed = {
        build: [],
        test: [mavenCmd({ modules: ['.'], exitCode: 1, output })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl . test`', [], failed);
      const claim = r.claims.find((c) => c.text === './mvnw -pl . test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('exit 1');
    });

    it('keeps an interrupted -am run contradicting when its failures are inside the claimed set', () => {
      // The interrupted twin of the guard above: a deadline kill does not
      // excuse failures Surefire recorded inside the claimed modules.
      const output =
        '[maven-test-report] core (1 failing report(s)): tests=2, failures=1, errors=0, skipped=0\n' +
        '[maven-test-failure] core/target/surefire-reports/TEST-A.xml: example.ATest#fails';
      for (const timedOut of [true, false]) {
        const bt = {
          build: [],
          test: [mavenCmd({ exitCode: null, timedOut, output })],
        } as unknown as BuildTestReport;
        const r = run('## Test Plan\n\nRan `./mvnw -pl core test`', [], bt);
        expect(verdictOf(r.claims, './mvnw -pl core test')).toBe(
          'contradicted',
        );
      }
    });

    it('does not read a quoted -am inside a -pl selector as the flag', () => {
      // A module dir with a space passes the POM entry gate; `-am` inside
      // the quoted selector is part of the name, not --also-make, so the
      // upstream-failure carve-out still applies.
      const failed = {
        build: [],
        test: [
          mavenCmd({
            modules: ['foo -am bar'],
            exitCode: 1,
            output: '[ERROR] Tests failed',
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run(
        "## Test Plan\n\nRan `./mvnw -pl 'foo -am bar' test`",
        [],
        failed,
      );
      expect(verdictOf(r.claims, "./mvnw -pl 'foo -am bar' test")).toBe(
        'unchecked',
      );
    });

    it('settles a claim against the REAL adapter output, not a hand-built one', () => {
      // Every other case here feeds a fixture. This one drives the actual
      // Maven adapter and settles a claim against what it recorded, so the
      // two halves of the contract are pinned together: if the adapter ever
      // stops reporting `maven` facts — or reports ones that disagree with
      // the command line it rendered — no fixture would notice, but this
      // does.
      const repo = join(dir, 'reactor');
      mkdirSync(join(repo, 'core'), { recursive: true });
      const pom = (modules: string[] = []) =>
        `<project><modelVersion>4.0.0</modelVersion><groupId>e</groupId>` +
        `<artifactId>a</artifactId><version>1</version><modules>` +
        `${modules.map((m) => `<module>${m}</module>`).join('')}</modules></project>`;
      writeFileSync(join(repo, 'pom.xml'), pom(['core']));
      writeFileSync(join(repo, 'core', 'pom.xml'), pom());

      const bt = mavenToolchainAdapter.run({
        root: repo,
        changedFiles: ['core/src/main/java/Main.java'],
        timeout: 5,
        install: false,
        exec: (command) => ({
          command,
          exitCode: 1,
          seconds: 1,
          timedOut: false,
          output: '[ERROR] Tests failed',
        }),
      });
      expect(bt.test[0]?.command).toContain('-pl core -am test');
      expect(bt.test[0]?.maven).toEqual({
        lifecycle: 'test',
        modules: ['core'],
        alsoMake: true,
        globalSkip: false,
      });

      const r = run('## Test Plan\n\nRan `./mvnw -pl core -am test`', [], bt);
      expect(verdictOf(r.claims, './mvnw -pl core -am test')).toBe(
        'contradicted',
      );
    });

    it('ranks a spawn-level death above a green finished sibling run', () => {
      // One green package must not shadow a spawn-dead sibling: the claim
      // reads contradicted while the build-test report says ok:false.
      const bt = {
        build: [],
        test: [
          {
            command: 'npm test --workspace="packages/a"',
            exitCode: 0,
            seconds: 1,
            timedOut: false,
            output: '',
          },
          {
            command: 'npm test --workspace="packages/b"',
            exitCode: null,
            seconds: 1,
            timedOut: false,
            output: '',
          },
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `npm test`', [], bt);
      const claim = r.claims.find((c) => c.text === 'npm test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('it ended without an exit code');
    });

    it('does not reproduce a claim on a run whose exit 0 swallowed failures', () => {
      const bt = {
        build: [],
        test: [
          mavenCmd({
            modules: null,
            output: '[ERROR] COMPILATION ERROR :',
            swallowedFailure: true,
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toContain('did not fail on');
    });

    it('words a suppressed test phase as suppression, not recorded failures', () => {
      // A skip setting ran ZERO tests: there are no failures to hunt, so
      // the contradiction must say the phase never ran — the old wording
      // sent the PR after a fail-never setting that was never involved.
      const bt = {
        build: [],
        test: [
          mavenCmd({
            output: '[INFO] Tests are skipped.\n[INFO] BUILD SUCCESS',
            swallowedFailure: true,
            testsSuppressed: true,
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toContain(
        'skip setting suppressed the test phase',
      );
      expect(claim?.note).toContain('nothing was tested');
      expect(claim?.note).not.toContain('recorded failures');
    });

    it('does not reproduce a claim on a wrapper that never started Maven', () => {
      // A stub wrapper's exit 0 verified nothing — the run must contradict
      // with its own wording, and never rule the claim reproduced.
      const bt = {
        build: [],
        test: [mavenCmd({ output: '', neverRan: true })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toContain('Maven never started');
      expect(claim?.note).toContain('nothing was built or tested');
    });

    it('contradicts a capped run on its non-zero exit', () => {
      // The cap withholds certification of a PASS; it does not retroactively
      // excuse a failure — the non-zero exit is definitive.
      const bt = {
        build: [],
        test: [
          mavenCmd({
            modules: null,
            exitCode: 1,
            evidenceCapped: true,
            output: '[ERROR] Tests failed',
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('exit 1');
      expect(claim?.note).toContain('non-zero exit is definitive');
    });

    it('leaves an exit-0 capped run unsettled', () => {
      // Only the non-zero exit is definitive; exit 0 over unread evidence is
      // genuinely unknown.
      const bt = {
        build: [],
        test: [
          mavenCmd({
            modules: null,
            evidenceCapped: true,
            output: '[INFO] BUILD SUCCESS',
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      expect(verdictOf(r.claims, './mvnw test')).toBe('unchecked');
    });

    it('contradicts an exit-0 capped run on cap-independent failure evidence', () => {
      // The cap withholds certification of a PASS; it must not flip the
      // verdict on failure evidence the run DID record — markers from
      // reports the sweep parsed, or failures a fail-never setting
      // swallowed. The finished path rules the identical evidence
      // contradicted.
      const markers = {
        build: [],
        test: [
          mavenCmd({
            alsoMake: false,
            evidenceCapped: true,
            output:
              '[maven-test-failure] core/target/surefire-reports/TEST-A.xml: example.ATest#fails',
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl core test`', [], markers);
      const claim = r.claims.find((c) => c.text === './mvnw -pl core test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toContain('fresh Surefire/Failsafe reports');

      const swallowed = {
        build: [],
        test: [
          mavenCmd({
            alsoMake: false,
            evidenceCapped: true,
            swallowedFailure: true,
            output: '[ERROR] COMPILATION ERROR :',
          }),
        ],
      } as unknown as BuildTestReport;
      const s2 = run(
        '## Test Plan\n\nRan `./mvnw -pl core test`',
        [],
        swallowed,
      );
      const sClaim = s2.claims.find((c) => c.text === './mvnw -pl core test');
      expect(sClaim?.verdict).toBe('contradicted');
      expect(sClaim?.observed).toContain('did not fail on');
    });

    it('never carves a CAPPED -am run — the non-zero exit contradicts even on upstream-only markers', () => {
      // R2-3: a capped run's markers are incomplete BY CONSTRUCTION — a
      // rejected report emits none, and upstream markers do not prove the
      // claimed module also passed. So whether the failure lives inside the
      // claim is unknowable; the carve-out must not discard the run, and
      // the capped cascade rules the non-zero exit definitive. (The earlier
      // pin expected `unchecked` here — R2-3 reverses it: discarding the
      // run read a definitive failure as "not run".)
      const upstreamOnly = {
        build: [],
        test: [
          mavenCmd({
            exitCode: 1,
            evidenceCapped: true,
            output:
              '[maven-test-report] upstream (1 failing report(s)): tests=2, failures=1, errors=0, skipped=0\n' +
              '[maven-test-failure] upstream/target/surefire-reports/TEST-A.xml: example.ATest#fails',
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run(
        '## Test Plan\n\nRan `./mvnw -pl core test`',
        [],
        upstreamOnly,
      );
      expect(verdictOf(r.claims, './mvnw -pl core test')).toBe('contradicted');

      // The in-claim marker case contradicts too (unchanged direction).
      const insideClaim = {
        build: [],
        test: [
          mavenCmd({
            exitCode: 1,
            evidenceCapped: true,
            output:
              '[maven-test-report] core (1 failing report(s)): tests=2, failures=1, errors=0, skipped=0\n' +
              '[maven-test-failure] core/target/surefire-reports/TEST-A.xml: example.ATest#fails',
          }),
        ],
      } as unknown as BuildTestReport;
      const flip = run(
        '## Test Plan\n\nRan `./mvnw -pl core test`',
        [],
        insideClaim,
      );
      expect(verdictOf(flip.claims, './mvnw -pl core test')).toBe(
        'contradicted',
      );
    });

    it('does not settle a claim off a capped run classified as infrastructure', () => {
      // The capped-definitive ranking arm admits any non-zero exit unless
      // guarded: an environmental acquisition failure that also carries
      // evidenceCapped (a trim rescue overflow) would otherwise rule the
      // claim `contradicted`, laundering the environmental death into a
      // definitive ruling. Arms 1/2/4 all exclude infrastructure.
      const bt = {
        build: [],
        test: [
          mavenCmd({
            infrastructure: true,
            evidenceCapped: true,
            exitCode: 1,
            output: '[ERROR] Could not resolve dependencies',
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('unchecked');
      expect(claim?.note).toContain('environmental');
    });

    it('reads single-dash long option spellings like their -- twins', () => {
      // commons-cli accepts `mvn -projects core` (verified on real Maven
      // 3.8.7): normalized before parsing, or the claim bypassed the
      // selector grammar and the also-make checks modeled on `--` forms.
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;

      for (const claim of [
        './mvnw -projects core test',
        './mvnw -projects=core test',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${claim}\``, [], bt);
        expect(verdictOf(r.claims, claim)).toBe('reproduces');
      }

      // The selector grammar — not just the lifecycle — must be reading
      // the spelling: a run scoped to a DIFFERENT module never tested
      // `core`, and an unscoped lifecycle settlement would wrongly rule
      // this reproduces.
      const other = {
        build: [],
        test: [mavenCmd({ modules: ['cli'] })],
      } as unknown as BuildTestReport;
      const mismatched = run(
        '## Test Plan\n\nRan `./mvnw -projects core test`',
        [],
        other,
      );
      expect(verdictOf(mismatched.claims, './mvnw -projects core test')).toBe(
        'unchecked',
      );

      // The `-also-make` spelling is recognized as upstream closure: the
      // finished -am carve-out must NOT apply to it (the claim runs
      // upstream too), so an upstream-only failure still contradicts.
      const failed = {
        build: [],
        test: [mavenCmd({ exitCode: 1, output: '[ERROR] Tests failed' })],
      } as unknown as BuildTestReport;
      const am = run(
        '## Test Plan\n\nRan `./mvnw -pl core -also-make test`',
        [],
        failed,
      );
      const amClaim = am.claims.find(
        (c) => c.text === './mvnw -pl core -also-make test',
      );
      expect(amClaim?.verdict).toBe('contradicted');

      // The -am-less single-dash spelling keeps the carve-out exactly
      // like its `-pl` twin pinned above.
      const carve = run(
        '## Test Plan\n\nRan `./mvnw -projects core test`',
        [],
        failed,
      );
      expect(verdictOf(carve.claims, './mvnw -projects core test')).toBe(
        'unchecked',
      );
    });

    it('contradicts a -pl claim when the -am run failed compiling inside the claimed module', () => {
      // A compile failure writes no Surefire reports, so the marker-based
      // attribution cannot see it; the compiler error's own path names the
      // module. The carve-out used to discard the failing run and read
      // 'this Maven command was not run' over a claim whose own command
      // would fail identically.
      const output =
        `[ERROR] ${join(dir, 'core/src/main/java/Foo.java')}:[10,5] cannot find symbol\n` +
        '[INFO] BUILD FAILURE';
      const bt = {
        build: [],
        test: [mavenCmd({ exitCode: 1, output })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl core test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw -pl core test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('exit 1');

      // Control: the same failure in an UPSTREAM module stays inside the
      // carve-out — the claim never compiles it.
      const upstream = {
        build: [],
        test: [
          mavenCmd({
            exitCode: 1,
            output:
              `[ERROR] ${join(dir, 'upstream/src/main/java/Bar.java')}:[10,5] cannot find symbol\n` +
              '[INFO] BUILD FAILURE',
          }),
        ],
      } as unknown as BuildTestReport;
      const u = run('## Test Plan\n\nRan `./mvnw -pl core test`', [], upstream);
      expect(verdictOf(u.claims, './mvnw -pl core test')).toBe('unchecked');
    });

    it('contradicts a -pl . claim when the -am run failed compiling the root project', () => {
      // failureInsideClaim's root-module arm keys on `<worktree>/src/`: a
      // compile failure in the root project's own sources must defeat the
      // `-am` carve-out exactly like a module failure does, or the claim
      // stands unchecked on evidence the review's own run contradicts.
      const output =
        `[ERROR] ${join(dir, 'src/main/java/Foo.java')}:[10,5] cannot find symbol\n` +
        '[INFO] BUILD FAILURE';
      const bt = {
        build: [],
        test: [mavenCmd({ modules: ['.'], exitCode: 1, output })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl . test`', [], bt);
      expect(verdictOf(r.claims, './mvnw -pl . test')).toBe('contradicted');
    });

    it('treats relative mvnd/mvnDebug spellings as command claims', () => {
      // The relative wrapper spellings were modeled for mvnw alone;
      // `./mvnd test` fell through extraction (no extension, no runner
      // match) and could never be ruled.
      expect(extractClaims('Run `./mvnd test`').map((c) => c.kind)).toEqual([
        'command',
      ]);
      expect(
        extractClaims('Run `../mvnDebug test`').map((c) => c.kind),
      ).toEqual(['command']);

      // And a recorded green run settles the spelling like its mvnw twin.
      const bt = {
        build: [],
        test: [mavenCmd({ exe: './mvnd', modules: null })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnd test`', [], bt);
      expect(verdictOf(r.claims, './mvnd test')).toBe('reproduces');
    });

    it('settles a -l/--log-file claim and never reads the log value as a phase', () => {
      // `-l` redirects the log; it changes no outcomes, so it is the one
      // value flag that does not scope — but its VALUE must be consumed,
      // or `mvn verify -l test` read `test` as a claimed phase.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;

      const settled = run(
        '## Test Plan\n\nRan `mvn test -l build.log`',
        [],
        bt,
      );
      expect(verdictOf(settled.claims, 'mvn test -l build.log')).toBe(
        'reproduces',
      );

      const consumed = run('## Test Plan\n\nRan `mvn verify -l test`', [], bt);
      expect(verdictOf(consumed.claims, 'mvn verify -l test')).toBe(
        'unchecked',
      );
    });

    it('does not settle a claim ending on a value flag missing its value', () => {
      // Real Maven dies in argument parsing on the dangling form
      // (`MissingArgumentException`) and runs zero lifecycle work — the
      // claim names a command that cannot execute. `-l` is the one value
      // flag whose presence does not scope, so its dangling spelling
      // slipped through every settlement gate.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;
      for (const claim of [
        'mvn test -l',
        'mvn test --log-file',
        'mvn test -log-file',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${claim}\``, [], bt);
        expect(verdictOf(r.claims, claim)).toBe('unchecked');
      }
      // The valued form still settles — only the missing value blocks.
      const valued = run('## Test Plan\n\nRan `mvn test -l build.log`', [], bt);
      expect(verdictOf(valued.claims, 'mvn test -l build.log')).toBe(
        'reproduces',
      );
    });

    it('does not double-read a -pl that a sibling value flag consumes', () => {
      // `mvn -l -pl test`: real Maven's commons-cli hands `-pl` to `-l`
      // as its log-file value (or dies in argument parsing when the
      // isArgument gate below applies) — the `-pl` token is NOT a
      // selector. The double read once yielded lifecycle `test` AND a
      // phantom module set `['test']`, settling the claim module-scoped
      // against a `-pl test` run and masking every sibling module the
      // claimed full-reactor command would have run.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: ['test'] })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `mvn -l -pl test`', [], bt);
      expect(verdictOf(r.claims, 'mvn -l -pl test')).toBe('unchecked');
      // The same walker must not read the consumed value as `-am` either.
      expect(verdictOf(r.claims, 'mvn -l -pl test')).not.toBe('reproduces');
    });

    it("does not read an option-like token as a value flag's value", () => {
      // commons-cli's isArgument gate: a value flag followed by an
      // option-like token is a MISSING VALUE (`MissingArgumentException`)
      // — zero lifecycle work runs — not a flag with a dash-prefixed
      // value. Without the gate, `-l -am` swallowed `-am` as the log
      // file for one walker while another read it as `--also-make`: a
      // claim real Maven rejects settled `reproduces`, and its
      // failing-run twin contradicted through the `-am` carve-out a run
      // the claim could never have executed.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;
      const logThenAm = run('## Test Plan\n\nRan `mvn -l -am test`', [], bt);
      expect(verdictOf(logThenAm.claims, 'mvn -l -am test')).toBe('unchecked');

      const failing = {
        build: [],
        test: [
          mavenCmd({
            modules: ['core'],
            exitCode: 1,
            output: '[ERROR] Tests run: 1, Failures: 1',
          }),
        ],
      } as unknown as BuildTestReport;
      const carveOut = run(
        '## Test Plan\n\nRan `./mvnw -pl core -l -am test`',
        [],
        failing,
      );
      expect(verdictOf(carveOut.claims, './mvnw -pl core -l -am test')).toBe(
        'unchecked',
      );
      expect(
        carveOut.claims.find((c) => c.text === './mvnw -pl core -l -am test')
          ?.note,
      ).not.toContain('failed for environmental reasons');
    });

    it('rules a claim with an unclosed shell substitution instead of aborting', () => {
      // An unclosed `${` (or an empty `${}`) makes the shell parser throw
      // `Bad substitution`; one malformed span — adversarial or a truncated
      // `${` log paste, common in Maven logs — otherwise aborted the
      // ENTIRE test-plan step and no claim in the plan was ruled. The
      // whitespace-split fallback keeps the claim ruling.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `mvn test ${FOO`', [], bt);
      const claim = r.claims.find((c) => c.text === 'mvn test ${FOO');
      expect(claim?.kind).toBe('command');
      expect(claim?.verdict).toBe('unchecked');
    });

    it('does not settle a claim carrying an option Maven rejects', () => {
      // Maven dies on 'Unable to parse command line options' for an option
      // it does not have — zero lifecycle work runs, exactly like an
      // unknown bare positional — so the claim must not settle.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test --verbose`', [], bt);
      expect(verdictOf(r.claims, './mvnw test --verbose')).toBe('unchecked');
      // A modeled neutral flag still settles.
      const modeled = run('## Test Plan\n\nRan `./mvnw -B test`', [], bt);
      expect(verdictOf(modeled.claims, './mvnw -B test')).toBe('reproduces');
    });

    it('does not settle claims carrying the zero-work usage or version options', () => {
      // Real Maven prints usage/version and exits 0 with zero lifecycle
      // work for them — certifying one would read a command that built and
      // tested nothing as run-and-passed. `-V` deliberately stays neutral:
      // it prints the version WITHOUT stopping the build.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;
      for (const flag of ['-h', '--help', '-v', '--version', '-help']) {
        const r = run(`## Test Plan\n\nRan \`mvn ${flag} test\``, [], bt);
        expect(verdictOf(r.claims, `mvn ${flag} test`)).toBe('unchecked');
      }
      const show = run('## Test Plan\n\nRan `mvn -V test`', [], bt);
      expect(verdictOf(show.claims, 'mvn -V test')).toBe('reproduces');
    });

    it('settles default-lifecycle phase claims with the reduction disclosed', () => {
      // Maven accepts every default-lifecycle phase as a bare positional;
      // the review never runs them explicitly, so the claim settles on its
      // final phase with the reduction disclosed instead of reading
      // unchecked over work the recorded run DID execute.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `mvn generate-sources test`', [], bt);
      const claim = r.claims.find(
        (c) => c.text === 'mvn generate-sources test',
      );
      expect(claim?.verdict).toBe('reproduces');
      expect(claim?.note).toContain('final phase (`test`)');
    });

    it('discloses the -am asymmetry when a -pl claim settles on an -am run', () => {
      // The recorded run resolved inter-module dependencies from the
      // reactor; the claim's bare command resolves them from the local
      // repository — the note must not read as if the exact command ran.
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl core test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw -pl core test');
      expect(claim?.verdict).toBe('reproduces');
      expect(claim?.note).toContain(
        'with the upstream closure (`-am`) the claim does not name',
      );
    });

    it('words a capped infrastructure -am run as environmental', () => {
      // An infrastructure run cannot contradict — the cascade's
      // environmental arm is its only consumer — so the `-am` carve-out
      // must not hide a capped one from that arm and force the false
      // "different scope or phase" note.
      const bt = {
        build: [],
        test: [mavenCmd({ infrastructure: true, evidenceCapped: true })],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl core test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw -pl core test');
      expect(claim?.verdict).toBe('unchecked');
      expect(claim?.note).toContain('environmental reasons');
    });

    it('settles an apostrophe module dir spelled with the quoting dance', () => {
      // shellSelector wraps `it's dir` as `'it'\''s dir'`; the claim
      // pipeline strips one quote layer before mavenPlModules runs, so the
      // space-separated spelling arrives with the dance exposed and no
      // outer quote left to detect — the undo must apply regardless, or
      // the claim can never settle or be contradicted.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: ["it's dir"], alsoMake: false })],
      } as unknown as BuildTestReport;
      const r = run(
        "## Test Plan\n\nRan `./mvnw -pl 'it'\\''s dir' test`",
        [],
        bt,
      );
      expect(verdictOf(r.claims, "./mvnw -pl 'it'\\''s dir' test")).toBe(
        'reproduces',
      );
    });

    it('attributes a compiler failure through a source path with a space', () => {
      // A module dir can carry a space, and the compiler-error path it
      // emits does too: the path capture must not stop at the space, or
      // the `-am` carve-out keeps discarding a run that failed inside the
      // claim and reads it unchecked.
      mkdirSync(join(dir, 'my module'), { recursive: true });
      writeFileSync(join(dir, 'my module', 'pom.xml'), '<project/>');
      const wt = dir.replace(/\\/g, '/');

      const bt = {
        build: [],
        test: [
          mavenCmd({
            modules: ['my module'],
            exitCode: 1,
            output: `[ERROR] ${wt}/my module/src/Foo.java:[10,5] cannot find symbol`,
          }),
        ],
      } as unknown as BuildTestReport;
      const r = run(
        "## Test Plan\n\nRan `./mvnw -pl 'my module' test`",
        [],
        bt,
      );
      expect(verdictOf(r.claims, "./mvnw -pl 'my module' test")).toBe(
        'contradicted',
      );
    });

    it('does not settle a claim that repeats the -pl selector', () => {
      // Maven ACCUMULATES repeated -pl: `mvn -pl core -pl cli test` builds
      // both modules, so reading only the last occurrence let a claim that
      // also covered `core` settle (or contradict) on a run scoped to `cli`.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: ['cli'] })],
      } as unknown as BuildTestReport;
      const command = './mvnw -pl core -pl cli test';
      const r = run(`## Test Plan\n\nRan \`${command}\``, [], bt);
      expect(verdictOf(r.claims, command)).toBe('unchecked');
    });

    it('does not settle attached short-form claims the recorded run never used', () => {
      // commons-cli accepts separator-less attached short forms; the
      // exact-token matches alone let every one of them bypass the
      // conservative treatment.
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;

      for (const command of [
        './mvnw -plcore test',
        './mvnw -pl core -fother/pom.xml test',
        './mvnw -pl core -rf:core test',
        './mvnw -pl core -ssettings.xml test',
        './mvnw -pl core -gssettings.xml test',
        './mvnw -pl core -ttoolchains.xml test',
        './mvnw -pl core -bmybuilder test',
        './mvnw -pl core -amdapp test',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${command}\``, [], bt);
        expect(verdictOf(r.claims, command)).toBe('unchecked');
      }
    });

    it('does not settle claims whose scope rides a quoted flag token', () => {
      // One layer of surrounding quotes must not hide the flag from the
      // scope guards or the selector parser.
      const bt = {
        build: [],
        test: [mavenCmd({ modules: null })],
      } as unknown as BuildTestReport;

      const pl = run('## Test Plan\n\nRan `mvn "-pl" core test`', [], bt);
      expect(verdictOf(pl.claims, 'mvn "-pl" core test')).toBe('unchecked');

      const prop = run('## Test Plan\n\nRan `mvn "-Dfoo=bar" test`', [], bt);
      expect(verdictOf(prop.claims, 'mvn "-Dfoo=bar" test')).toBe('unchecked');
    });

    it('does not settle parallelism claims on a serial run', () => {
      // `-T`/`--threads` change outcomes (modules racing shared state); the
      // review only ever runs serial.
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;

      for (const command of [
        './mvnw -pl core -T 1C test',
        './mvnw -pl core -T1C test',
        './mvnw -pl core --threads=4 test',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${command}\``, [], bt);
        expect(verdictOf(r.claims, command)).toBe('unchecked');
      }
    });

    it('settles backslash and trailing-slash -pl spellings on their recorded modules', () => {
      // Windows-style selectors name the same module dirs; discarding them
      // as unmatched silently wasted the recorded green evidence.
      const bt = {
        build: [],
        test: [mavenCmd()],
      } as unknown as BuildTestReport;

      for (const command of [
        './mvnw -pl .\\core test',
        './mvnw -pl core/ test',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${command}\``, [], bt);
        expect(verdictOf(r.claims, command)).toBe('reproduces');
      }
    });

    it('does not lift a Maven runner out of its command span', () => {
      const plain = run('## Test Plan\n\nRan `./mvnw test`');
      expect(
        plain.claims.filter((c) => c.kind === 'path' && c.text === './mvnw'),
      ).toEqual([]);

      // A cd-chained runner used to normalize into a false `core/mvnw` path.
      const chained = run('## Test Plan\n\nRan `cd core && ./mvnw test`');
      expect(
        chained.claims.filter((c) => c.kind === 'path' && /mvnw/.test(c.text)),
      ).toEqual([]);
    });

    it('rules a bare command contradicted when ANY scoped run failed', () => {
      // build-test records one scoped command per package and does not stop on
      // failure; the first match could be the green package that sorted first,
      // stating the opposite of the authoritative `ok: false`.
      const bt = {
        build: [],
        test: [
          {
            command: 'npm test --workspace="packages/a"',
            exitCode: 0,
            seconds: 1,
            timedOut: false,
            output: '',
          },
          {
            command: 'npm test --workspace="packages/b"',
            exitCode: 1,
            seconds: 1,
            timedOut: false,
            output: 'fail',
          },
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `npm test`', [], bt);
      const claim = r.claims.find((c) => c.text === 'npm test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('exit 1');
    });

    it('finds a root-only script when the root defines no build/test', () => {
      // `readRootPackage` returns null when the root has neither build nor test,
      // which used to drop a root-only `lint` and rule a correct claim contradicted.
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          workspaces: ['packages/*'],
          scripts: { lint: 'eslint .' },
        }),
      );
      mkdirSync(join(dir, 'packages/cli'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/cli/package.json'),
        JSON.stringify({ name: '@x/cli', scripts: { build: 'tsc' } }),
      );
      const r = run('## Test Plan\n\nRan `npm run lint`');
      expect(verdictOf(r.claims, 'npm run lint')).toBe('reproduces');
    });
  });

  describe('count claims', () => {
    const withCounts = (...counts: number[]) =>
      ({
        build: [],
        test: counts.map((n) => ({
          command: 'npm test',
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: `Tests  ${n} passed (${n})`,
        })),
      }) as unknown as BuildTestReport;

    it('reproduces a count a suite in this review reported', () => {
      const r = run('## Test Plan\n\n471 tests passed', [], withCounts(471));
      expect(verdictOf(r.claims, '471 tests passed')).toBe('reproduces');
    });

    it('reports a mismatch as `differs`, NOT as a contradiction', () => {
      // The whole point: 471 vs 472 may be two different suites, and this
      // command cannot tell. It must never become a blocker.
      const r = run('## Test Plan\n\n471 tests passed', [], withCounts(472));
      const claim = r.claims.find((c) => c.text === '471 tests passed');
      expect(claim?.verdict).toBe('differs');
      expect(claim?.observed).toBe('472 passed');
      expect(r.claims.some((c) => c.verdict === 'contradicted')).toBe(false);
    });

    it('reproduces a changed-module count on the -am subtotal, not only the reactor total', () => {
      // `-pl core -am` also tests the upstream closure: the claim "42
      // tests passed" for `core` matches the changed-module subtotal even
      // though the reactor-wide sum is 187 — both readings are emitted,
      // and either settles the claim.
      const bt = {
        build: [],
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 0,
            seconds: 10,
            timedOut: false,
            maven: { lifecycle: 'test', modules: ['core'], alsoMake: true },
            output:
              '[maven-test-report] common (12 report(s)): tests=145, failures=0, errors=0, skipped=0\n' +
              '[maven-test-report] core (4 report(s)): tests=42, failures=0, errors=0, skipped=0',
          },
        ],
      } as unknown as BuildTestReport;

      const r = run('## Test Plan\n\n42 tests passed', [], bt);
      expect(verdictOf(r.claims, '42 tests passed')).toBe('reproduces');
      const total = run('## Test Plan\n\n187 tests passed', [], bt);
      expect(verdictOf(total.claims, '187 tests passed')).toBe('reproduces');
    });

    it('is unchecked when no suite reported a count', () => {
      const r = run('## Test Plan\n\n471 tests passed');
      expect(verdictOf(r.claims, '471 tests passed')).toBe('unchecked');
    });
  });

  it('summarises the verdicts in its note', () => {
    const r = run(
      '## Test Plan\n\nAdded `src/ghost.ts`, ran `npm run build`, 9 tests passed',
    );
    expect(r.note).toMatch(/1 contradicted/);
    expect(r.note).toMatch(/1 reproduced/);
    expect(r.note).toMatch(/1 unchecked/);
  });
});

describe('platformBodyFetcher — the body fetch routes through the platform reader', () => {
  // The gap this closes: the body fetch used to be `gh pr view` always, so
  // on an Aone target the Test Plan went unchecked on EVERY run. Routed
  // through the reader, the MR description (already in the reader's fetch
  // metadata) backs it — no new API surface.
  beforeEach(() => {
    aoneFetchMetaMock.mockReset();
    // A leaking throwing implementation (the refused-gate test below) would
    // arm every later fetcher construction in this file.
    aoneEnsureAuthMock.mockReset();
  });

  it('routes an Aone host at the reader: the MR description', () => {
    aoneFetchMetaMock.mockReturnValue({ body: '## Test Plan\n\nran it' });
    const fetcher = platformBodyFetcher('gitlab.alibaba-inc.com');
    expect(fetcher('maxcompute/odps_src', '29295886')).toBe(
      '## Test Plan\n\nran it',
    );
    expect(aoneFetchMetaMock).toHaveBeenCalledWith(
      29295886,
      'maxcompute/odps_src',
    );
  });

  it('the web host is Aone too — one platform under two host names', () => {
    aoneFetchMetaMock.mockReturnValue({ body: 'x' });
    expect(platformBodyFetcher('code.alibaba-inc.com')('g/p', '7')).toBe('x');
  });

  it('an absent description degrades to an empty body, not a fetch failure', () => {
    // An MR with no description is a legal shape — it reads as "no Test
    // Plan section", the same as a body-less PR on GitHub, never as a
    // failed fetch.
    aoneFetchMetaMock.mockReturnValue({});
    expect(platformBodyFetcher('gitlab.alibaba-inc.com')('g/p', '7')).toBe('');
  });

  it('refuses a malformed MR id before any platform call', () => {
    const fetcher = platformBodyFetcher('gitlab.alibaba-inc.com');
    expect(() => fetcher('g/p', 'not-a-number')).toThrow(TypeError);
    expect(() => fetcher('g/p', '0')).toThrow(TypeError);
    // Non-decimal spellings a bare `Number()` would admit — '0x10' is MR
    // 16, not an error; the decimal-shape gate refuses them all.
    expect(() => fetcher('g/p', '0x10')).toThrow(TypeError);
    expect(() => fetcher('g/p', '1e3')).toThrow(TypeError);
    expect(() => fetcher('g/p', ' 7 ')).toThrow(TypeError);
    // A past-2^53 id would double-round to a DIFFERENT MR — isSafeInteger
    // (the pipeline's isDiffLine gate) rejects it instead.
    expect(() => fetcher('g/p', '9007199254740993')).toThrow(TypeError);
    expect(aoneFetchMetaMock).not.toHaveBeenCalled();
  });

  it('routes a non-Aone host at the GitHub fetcher (behavior unchanged)', () => {
    expect(platformBodyFetcher('github.com')).toBe(fetchPrBody);
    // The GitHub arm keeps its historical degrade — no auth gate.
    expect(aoneEnsureAuthMock).not.toHaveBeenCalled();
  });

  it('runs the auth gate BEFORE any fetch — a refused gate throws at fetcher construction', () => {
    // Every other a1-backed flow gates first; a standalone invocation on a
    // missing/stale/logged-out a1 must fail with the actionable message,
    // not exit 0 into the generic "could not be fetched" note.
    aoneEnsureAuthMock.mockImplementation(() => {
      throw new Error('a1 CLI not found on PATH — install the `a1` CLI first.');
    });
    expect(() => platformBodyFetcher('gitlab.alibaba-inc.com')).toThrow(
      /a1 CLI not found on PATH/,
    );
    expect(aoneFetchMetaMock).not.toHaveBeenCalled();
  });

  it('passes the gate when the a1 is fresh and authed', () => {
    platformBodyFetcher('gitlab.alibaba-inc.com');
    expect(aoneEnsureAuthMock).toHaveBeenCalledTimes(1);
  });

  describe('end to end through runTestPlan', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'qwen-test-plan-aone-'));
      writeFileSync(join(dir, 'diff.txt'), 'diff');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const planFile = (files: string[]) => {
      const p = join(dir, 'plan.json');
      writeFileSync(
        p,
        JSON.stringify({
          files: files.map((path) => ({ path, kind: 'source' })),
          diffPathAbsolute: join(dir, 'diff.txt'),
        }),
      );
      return p;
    };

    it('rules on an MR description exactly as it rules on a PR body', () => {
      aoneFetchMetaMock.mockReturnValue({
        body: '## Test Plan\n\nAdded `packages/cli/src/a.test.ts`',
      });
      const r = runTestPlan(
        {
          plan: planFile(['packages/cli/src/a.test.ts']),
          pr: '29295886',
          repo: 'maxcompute/odps_src',
          worktree: dir,
        },
        platformBodyFetcher('gitlab.alibaba-inc.com'),
      );
      expect(r.found).toBe(true);
      expect(r.claims).toHaveLength(1);
      expect(r.claims[0].verdict).toBe('reproduces');
    });

    it('a failed a1 fetch degrades to the unchecked note, same as a failed gh fetch', () => {
      aoneFetchMetaMock.mockImplementation(() => {
        throw new Error('Command failed: a1 repo mr view\nnot logged in');
      });
      const r = runTestPlan(
        {
          plan: planFile([]),
          pr: '7',
          repo: 'g/p',
          worktree: dir,
        },
        platformBodyFetcher('gitlab.alibaba-inc.com'),
      );
      expect(r.found).toBe(false);
      expect(r.note).toMatch(/could not be fetched/);
    });
  });
});

describe('the handler wiring — the integration point of the Aone fix', () => {
  // Nothing else in this file exercises testPlanCommand.handler: a revert
  // to `runTestPlan(args)` (or a dropped `args.host`) would silently
  // restore the pre-#9619 gh-direct body fetch on Aone targets while every
  // test above stays green. Sibling suites pin their handlers the same way
  // (comment-status.test.ts, pr-context.test.ts) — drive the real one.
  let dir: string;
  let savedGhHost: string | undefined;

  beforeEach(() => {
    aoneFetchMetaMock.mockReset();
    aoneEnsureAuthMock.mockReset();
    dir = mkdtempSync(join(tmpdir(), 'qwen-test-plan-handler-'));
    writeFileSync(join(dir, 'diff.txt'), 'diff');
    savedGhHost = getGhHost();
    process.exitCode = undefined;
  });
  afterEach(() => {
    setGhHost(savedGhHost);
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const argv = () =>
    ({
      plan: (() => {
        const p = join(dir, 'plan.json');
        writeFileSync(
          p,
          JSON.stringify({
            files: [{ path: 'packages/cli/src/a.test.ts', kind: 'source' }],
            diffPathAbsolute: join(dir, 'diff.txt'),
          }),
        );
        return p;
      })(),
      pr: '29295886',
      repo: 'maxcompute/odps_src',
      worktree: dir,
      out: join(dir, 'report.json'),
      host: 'gitlab.alibaba-inc.com',
    }) as never;

  it('an Aone --host routes the body through the reader, gates first, and never touches gh', async () => {
    aoneFetchMetaMock.mockReturnValue({
      body: '## Test Plan\n\nAdded `packages/cli/src/a.test.ts`',
    });
    await testPlanCommand.handler?.(argv());
    const report = JSON.parse(
      readFileSync(join(dir, 'report.json'), 'utf8'),
    ) as { found: boolean; claims: Array<{ verdict: string }> };
    // The verdict is reachable ONLY through the Aone fetcher's body — the
    // default fetchPrBody (gh pr view) never runs in this path.
    expect(report.found).toBe(true);
    expect(report.claims[0].verdict).toBe('reproduces');
    expect(aoneEnsureAuthMock).toHaveBeenCalledTimes(1);
    expect(aoneFetchMetaMock).toHaveBeenCalledWith(
      29295886,
      'maxcompute/odps_src',
    );
  });

  it('a refused gate fails the command (exit 1) with the actionable message, before any fetch', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    aoneEnsureAuthMock.mockImplementation(() => {
      throw new Error(
        'a1 0.1.89 is older than the 0.1.90 this review provider requires',
      );
    });
    await testPlanCommand.handler?.(argv());
    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('older than the 0.1.90'),
    );
    expect(aoneFetchMetaMock).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'report.json'))).toBe(false);
    stderrSpy.mockRestore();
  });
});

describe('the CLI option contract', () => {
  // Every test above calls `runTestPlan` with a hand-built args object, which is
  // exactly how the flag-name bug got in: yargs' camel-case expansion turns
  // `--build-test` into `buildTest`, and a field named `build_test` reads
  // `undefined` on every real invocation — silently downgrading every count
  // claim to `unchecked` while the whole suite stayed green.
  //
  // So this test does not assert the parsed shape and stop; asserting yargs
  // produces `buildTest` would still pass if `runTestPlan` read some other name.
  // It feeds the PARSED object straight into `runTestPlan` and asserts on a
  // verdict only reachable when the build-test report was actually loaded.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qwen-test-plan-cli-'));
    writeFileSync(join(dir, 'diff.txt'), 'diff');
    writeFileSync(
      join(dir, 'plan.json'),
      JSON.stringify({ files: [], diffPathAbsolute: join(dir, 'diff.txt') }),
    );
    writeFileSync(
      join(dir, 'bt.json'),
      JSON.stringify({
        build: [],
        test: [
          {
            command: 'npm test',
            exitCode: 0,
            seconds: 1,
            timedOut: false,
            output: 'Tests  472 passed (472)',
          },
        ],
      }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('parses --build-test into the field runTestPlan actually reads', () => {
    const parsed = (testPlanCommand.builder as (y: Argv) => Argv)(
      yargs([]),
    ).parseSync([
      '--plan',
      join(dir, 'plan.json'),
      '--pr',
      '8176',
      '--repo',
      'o/r',
      '--worktree',
      dir,
      '--build-test',
      join(dir, 'bt.json'),
    ]) as unknown as TestPlanArgs;

    const report = runTestPlan(
      parsed,
      () => '## Test Plan\n\n471 tests passed',
    );
    // `differs` is reachable ONLY if the build-test report was loaded and its
    // 472 compared against the claimed 471. A dropped flag yields `unchecked`.
    expect(report.claims.map((c) => c.verdict)).toEqual(['differs']);
    expect(report.claims[0].observed).toBe('472 passed');
  });
});
