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
    // The cd TARGET itself is no longer claimed (a bare dir has no path
    // evidence — round-3 review); it only resolves the file tokens after it.
    expect(claims).not.toContainEqual({ kind: 'path', text: 'packages/core' });
    expect(claims).toContainEqual({
      kind: 'path',
      text: 'packages/core/src/telemetry/loggers.test.ts',
    });
    expect(claims).not.toContainEqual({
      kind: 'path',
      text: 'src/telemetry/loggers.test.ts',
    });
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

    it('rules a gitignored path unchecked — absent by construction', () => {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      writeFileSync(join(dir, '.gitignore'), 'dist/\n');
      const r = run(
        '## Test Plan\n\nRun `node dist/index.js` against `dist/index.js`',
      );
      const claim = r.claims.find((c) => c.text === 'dist/index.js');
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
