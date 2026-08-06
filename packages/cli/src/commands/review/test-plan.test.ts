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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yargs, { type Argv } from 'yargs';
import {
  testPlanCommand,
  extractTestPlanSection,
  extractClaims,
  observedTestCounts,
  npmScriptOf,
  runTestPlan,
  type TestPlanClaim,
  type TestPlanArgs,
} from './test-plan.js';
import type { BuildTestReport } from './build-test.js';

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
  const report = (outputs: string[]): BuildTestReport =>
    ({
      test: outputs.map((output) => ({
        command: 'npm test',
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
        report([
          '[maven-test-report] core/target/surefire-reports/TEST-A.xml: tests=12, failures=1, errors=2, skipped=3\n' +
            '[maven-test-report] app/target/failsafe-reports/TEST-B.xml: tests=8, failures=0, errors=0, skipped=1',
        ]),
      ),
    ).toEqual([13]);
  });

  it('reads rolled-up Maven module summaries too', () => {
    // Clean reports roll up per project dir to keep the evidence block
    // bounded; the count parser must read the rollup shape the same way.
    expect(
      observedTestCounts(
        report([
          '[maven-test-report] core (412 report(s)): tests=8931, failures=0, errors=0, skipped=12',
        ]),
      ),
    ).toEqual([8919]);
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
          command: 'mvn -fn test',
          exitCode: 0,
          seconds: 3,
          timedOut: false,
          swallowedFailure: true,
          output:
            '[maven-test-report] core (500 report(s)): tests=500, failures=0, errors=0, skipped=0',
        },
      ],
    } as unknown as BuildTestReport;
    expect(observedTestCounts(interrupted)).toEqual([]);
  });

  it('counts the omitted totals carried by capped rollup markers', () => {
    expect(
      observedTestCounts(
        report([
          '[maven-test-report] mod0 (1 report(s)): tests=1, failures=0, errors=0, skipped=0\n' +
            '[maven-test-report] 20 more clean project rollup(s) omitted: tests=20, failures=0, errors=0, skipped=0',
        ]),
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
        report([
          '[maven-test-report] core/target/surefire-reports/TEST-A.xml: tests=0, failures=0, errors=0, skipped=1\n' +
            '[maven-test-report] app/target/surefire-reports/TEST-B.xml: tests=8, failures=0, errors=0, skipped=1',
        ]),
      ),
    ).toEqual([7]);
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
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 1,
            seconds: 3,
            timedOut: false,
            output: 'There are test failures.',
          },
        ],
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
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl validate -am test',
            exitCode: 1,
            seconds: 3,
            timedOut: false,
            output: 'There are test failures.',
          },
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
      ]) {
        const claims = extractClaims(`## Test Plan\n\nRan \`${command}\``);
        expect(claims.some((claim) => claim.text === command)).toBe(true);
        // The runner token is a command, not a path claim about the tree.
        expect(
          claims.filter((c) => c.kind === 'path' && c.text === command),
        ).toEqual([]);
      }
    });

    it('matches bare Maven wrapper spellings to a scoped lifecycle run', () => {
      const bt = {
        build: [],
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output: '',
          },
        ],
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
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: null,
            seconds: 120,
            timedOut: true,
            output: '',
          },
        ],
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
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: null,
            seconds: 3,
            timedOut: false,
            output: '',
          },
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('unchecked');
      expect(claim?.note).toContain('ended without an exit code');
      expect(claim?.note).not.toContain('not run');
    });

    it('does not settle a claim on an infrastructure-classified Maven run', () => {
      // A dependency-resolution failure the same review labels
      // 'infrastructure evidence' must not falsify the author's claim.
      const bt = {
        build: [],
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 1,
            seconds: 3,
            timedOut: false,
            output: '[ERROR] Could not resolve dependencies',
            infrastructure: true,
          },
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
          {
            command: './mvnw --batch-mode --no-transfer-progress test',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output:
              '[maven-test-report] core/target/surefire-reports/TEST-A.xml: tests=2, failures=1, errors=0, skipped=0\n' +
              '[maven-test-failure] core/target/surefire-reports/TEST-A.xml: example.ATest#fails',
          },
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toContain('fresh Surefire/Failsafe reports');
    });

    it('does not settle a bare Maven runner claim from a module-scoped run', () => {
      // `./mvnw` alone carries no lifecycle: prefix-matching it would
      // certify or deny the WHOLE wrapper run from one module's test.
      const bt = {
        build: [],
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output: '',
          },
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw');
      expect(claim?.verdict).toBe('unchecked');
      expect(claim?.note).toContain('Maven command was not run');
      // The bare runner token is not a path claim either.
      expect(
        r.claims.filter((c) => c.kind === 'path' && c.text === './mvnw'),
      ).toEqual([]);
    });

    it('gives Maven wording to Maven claims whose final token is not a lifecycle', () => {
      for (const command of ['mvn', 'mvn test -Dtest=ChangedTest']) {
        const r = run(`## Test Plan\n\nRan \`${command}\``);
        const claim = r.claims.find((c) => c.text === command);
        expect(claim?.verdict).toBe('unchecked');
        expect(claim?.note).toContain('Maven command was not run');
        expect(claim?.note).not.toContain('npm script');
      }
    });

    it('settles a multi-token Maven lifecycle claim on its final phase', () => {
      const bt = {
        build: [],
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output: '',
          },
        ],
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
        test: [
          {
            command: 'mvn --batch-mode --no-transfer-progress test',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output: '',
          },
        ],
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
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output: '',
          },
        ],
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
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output: '',
          },
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl core -am test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw -pl core -am test');
      expect(claim?.verdict).toBe('reproduces');
      expect(claim?.note).toContain('module-scoped');
    });

    it('contradicts a -pl claim when the same-scope run failed', () => {
      const bt = {
        build: [],
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 1,
            seconds: 3,
            timedOut: false,
            output: '[ERROR] Tests failed',
          },
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw -pl core -am test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw -pl core -am test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toBe('exit 1');
    });

    it('says a differently scoped Maven run happened instead of nothing', () => {
      const bt = {
        build: [],
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output: '',
          },
        ],
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
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 1,
            seconds: 3,
            timedOut: false,
            output: '[ERROR] Tests failed',
          },
        ],
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
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output: '',
          },
        ],
      } as unknown as BuildTestReport;

      for (const command of [
        './mvnw --non-recursive test',
        './mvnw --activate-profiles jdk25 test',
        './mvnw --define foo=bar test',
        './mvnw --resume-from :core test',
        './mvnw -pl core -amd test',
        './mvnw -pl core --also-make-dependents test',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${command}\``, [], bt);
        expect(verdictOf(r.claims, command)).toBe('unchecked');
      }

      // The flip direction too: a FAILED recorded run must not contradict a
      // claim whose extra scope that run never exercised.
      const failed = {
        build: [],
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 1,
            seconds: 3,
            timedOut: false,
            output: '[ERROR] Tests failed',
          },
        ],
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
      const withRecorded = (command: string) =>
        ({
          build: [],
          test: [
            { command, exitCode: 0, seconds: 3, timedOut: false, output: '' },
          ],
        }) as unknown as BuildTestReport;

      // Order independence and cardinality: the adapter records multi-module
      // selectors (`-pl core,app -am test`).
      const same = run(
        '## Test Plan\n\nRan `./mvnw -pl app,core test`',
        [],
        withRecorded(
          './mvnw --batch-mode --no-transfer-progress -pl core,app -am test',
        ),
      );
      expect(verdictOf(same.claims, './mvnw -pl app,core test')).toBe(
        'reproduces',
      );

      // A recorded run with FEWER modules never tested the extra one.
      const fewer = run(
        '## Test Plan\n\nRan `./mvnw -pl core,app test`',
        [],
        withRecorded(
          './mvnw --batch-mode --no-transfer-progress -pl core -am test',
        ),
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
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 1,
            seconds: 3,
            timedOut: false,
            output: '[ERROR] Tests failed',
          },
        ],
      } as unknown as BuildTestReport;

      const r = run('## Test Plan\n\nRan `./mvnw -pl core test`', [], failed);
      expect(verdictOf(r.claims, './mvnw -pl core test')).toBe('unchecked');
    });

    it('reads -pl= and --projects selector spellings in both directions', () => {
      const withRecorded = (command: string) =>
        ({
          build: [],
          test: [
            { command, exitCode: 0, seconds: 3, timedOut: false, output: '' },
          ],
        }) as unknown as BuildTestReport;
      const canonical =
        './mvnw --batch-mode --no-transfer-progress -pl core -am test';

      for (const claim of [
        './mvnw -pl=core test',
        './mvnw --projects core test',
        './mvnw --projects=core test',
      ]) {
        const r = run(
          `## Test Plan\n\nRan \`${claim}\``,
          [],
          withRecorded(canonical),
        );
        expect(verdictOf(r.claims, claim)).toBe('reproduces');
      }

      for (const recorded of [
        './mvnw --batch-mode --no-transfer-progress -pl=core -am test',
        './mvnw --batch-mode --no-transfer-progress --projects core -am test',
      ]) {
        const r = run(
          '## Test Plan\n\nRan `./mvnw -pl core test`',
          [],
          withRecorded(recorded),
        );
        expect(verdictOf(r.claims, './mvnw -pl core test')).toBe('reproduces');
      }
    });

    it('settles a test-compile claim on the recorded build-only run', () => {
      // --build-only records `test-compile`; disavowing the phase would say
      // the review never ran what it did.
      const bt = {
        build: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test-compile',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output: '',
          },
        ],
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
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output: '',
          },
        ],
      } as unknown as BuildTestReport;

      for (const command of [
        './mvnw -pl core -Pjdk25 test',
        './mvnw -pl core -Dfoo=bar test',
        './mvnw -pl core -rf :core test',
        './mvnw -pl core -N test',
        './mvnw -pl core -f other/pom.xml test',
      ]) {
        const r = run(`## Test Plan\n\nRan \`${command}\``, [], bt);
        expect(verdictOf(r.claims, command)).toBe('unchecked');
      }
    });

    it('contradicts a claim when the interrupted run recorded fresh failures', () => {
      const output =
        '[maven-test-report] core/target/surefire-reports/TEST-A.xml: tests=2, failures=1, errors=0, skipped=0\n' +
        '[maven-test-failure] core/target/surefire-reports/TEST-A.xml: example.ATest#fails';
      // The deadline kill and the spawn death both keep the captured
      // regressions as contradicting evidence.
      for (const timedOut of [true, false]) {
        const bt = {
          build: [],
          test: [
            {
              command:
                './mvnw --batch-mode --no-transfer-progress -pl core -am test',
              exitCode: null,
              seconds: 3,
              timedOut,
              output,
            },
          ],
        } as unknown as BuildTestReport;
        const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
        const claim = r.claims.find((c) => c.text === './mvnw test');
        expect(claim?.verdict).toBe('contradicted');
        expect(claim?.observed).toContain('interrupted');
      }
    });

    it('does not contradict a -pl claim on an INTERRUPTED -am run of the same module set', () => {
      // The finished twin of this guard is pinned above; the interrupted
      // fresh-failure branch must apply the same scope asymmetry — the
      // failures may live entirely in upstream modules only `-am` pulled
      // in, which the claim never tests.
      const output =
        '[maven-test-report] upstream/target/surefire-reports/TEST-A.xml: tests=2, failures=1, errors=0, skipped=0\n' +
        '[maven-test-failure] upstream/target/surefire-reports/TEST-A.xml: example.ATest#fails';
      for (const timedOut of [true, false]) {
        const bt = {
          build: [],
          test: [
            {
              command:
                './mvnw --batch-mode --no-transfer-progress -pl core -am test',
              exitCode: null,
              seconds: 3,
              timedOut,
              output,
            },
          ],
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
      expect(claim?.observed).toBe('exit null');
    });

    it('compares quoted -pl selectors as their module sets', () => {
      // A module dir with a space passes the POM entry gate, and
      // shellSelector quotes the whole selector; the parser must rejoin it
      // instead of collapsing it to its first word.
      const withRecorded = (command: string) =>
        ({
          build: [],
          test: [
            { command, exitCode: 0, seconds: 3, timedOut: false, output: '' },
          ],
        }) as unknown as BuildTestReport;

      const same = run(
        "## Test Plan\n\nRan `./mvnw -pl 'my module,my other' test`",
        [],
        withRecorded(
          "./mvnw --batch-mode --no-transfer-progress -pl 'my module,my other' -am test",
        ),
      );
      expect(
        verdictOf(same.claims, "./mvnw -pl 'my module,my other' test"),
      ).toBe('reproduces');

      // Sharing a first word is NOT the same module set: the recorded run
      // never tested `my module` alone.
      const different = run(
        "## Test Plan\n\nRan `./mvnw -pl 'my module' test`",
        [],
        withRecorded(
          "./mvnw --batch-mode --no-transfer-progress -pl 'my module,my other' -am test",
        ),
      );
      expect(verdictOf(different.claims, "./mvnw -pl 'my module' test")).toBe(
        'unchecked',
      );
    });

    it('contradicts an -am claim when a same-scope run WITHOUT -am failed', () => {
      // The converse of the -am exclusion: a run that never pulled in
      // upstream modules and still failed inside the claimed module set
      // falsifies the wider claim too. The implementation comment relies
      // on this direction, so pin it.
      const failed = {
        build: [],
        test: [
          {
            command: './mvnw --batch-mode --no-transfer-progress -pl core test',
            exitCode: 1,
            seconds: 3,
            timedOut: false,
            output: '[ERROR] Tests failed',
          },
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
    });

    it('discloses the phase reduction of a multi-phase claim', () => {
      // The adapter only ever runs `test`/`test-compile`; settling
      // `clean test` on one must not read as if `clean` ran — neither in
      // the reactor-wide shape nor the module-scoped one.
      const reactorWide = {
        build: [],
        test: [
          {
            command: 'mvn --batch-mode --no-transfer-progress test',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output: '',
          },
        ],
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
        test: [
          {
            command:
              './mvnw --batch-mode --no-transfer-progress -pl core -am test',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output: '',
          },
        ],
      } as unknown as BuildTestReport;
      const narrow = run('## Test Plan\n\nRan `./mvnw clean test`', [], scoped);
      expect(
        narrow.claims.find((c) => c.text === './mvnw clean test')?.note,
      ).toContain('module-scoped form of its final phase');
    });

    it('does not reproduce a claim on a run whose exit 0 swallowed failures', () => {
      const bt = {
        build: [],
        test: [
          {
            command: './mvnw --batch-mode --no-transfer-progress test',
            exitCode: 0,
            seconds: 3,
            timedOut: false,
            output: '[ERROR] COMPILATION ERROR :',
            swallowedFailure: true,
          },
        ],
      } as unknown as BuildTestReport;
      const r = run('## Test Plan\n\nRan `./mvnw test`', [], bt);
      const claim = r.claims.find((c) => c.text === './mvnw test');
      expect(claim?.verdict).toBe('contradicted');
      expect(claim?.observed).toContain('did not fail on');
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
