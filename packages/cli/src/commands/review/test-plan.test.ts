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
