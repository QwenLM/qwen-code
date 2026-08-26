/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The subject is an agent that was never launched, on a review that certified the
// diff anyway.
//
// Every other check in this skill asks a question of an agent that ran — was it
// given the diff, did it open it, was it handed the prompt the CLI built. An agent
// that does not run leaves no transcript to ask, so its absence is invisible
// precisely because it is an absence. Dogfooded against a real PR, Agent 0 (issue
// fidelity) was simply not launched, and nothing in the run could tell.
//
// The cure is a list of who should have been there, derived from something other
// than the thing doing the launching. These tests pin that derivation.

import { describe, it, expect } from 'vitest';
import {
  requiredAgents,
  reviewMode,
  isTerritoryFanOut,
  hasExecutableScript,
} from './roster.js';

/** A same-repo PR: a worktree to build in, a PR number to check an issue against. */
const PR = {
  diffPathAbsolute: '/d.txt',
  prNumber: '6766',
  ownerRepo: 'QwenLM/qwen-code',
  worktreePath: '.qwen/tmp/review-pr-6766',
  files: [{ path: 'a.ts', kind: 'source', removedLines: 0, heavy: false }],
  chunks: [{ id: 1, startLine: 1, endLine: 100 }],
  srcDiffLines: 200,
  diffLines: 300,
};

const keys = (plan: unknown) => requiredAgents(plan as never).map((a) => a.key);

describe('reviewMode — inferred from what the capturing command wrote', () => {
  it('is a PR worktree when there is a worktree', () => {
    expect(reviewMode(PR)).toBe('pr-worktree');
  });

  it('is local when the capture reported the untracked files it swept in', () => {
    expect(reviewMode({ untrackedFiles: [] })).toBe('local');
  });

  it('is diff-only when there is neither — the cross-repo lightweight path', () => {
    expect(reviewMode({ chunks: [] })).toBe('diff-only');
  });
});

describe('the topology gate', () => {
  it.each([
    [{ srcDiffLines: 500, diffLines: 3200 }, false],
    [{ srcDiffLines: 501, diffLines: 3200 }, true],
    [{ srcDiffLines: 500, diffLines: 3201 }, true],
    // Test code is where diff size lies: 200 production lines shipping 3 000 lines
    // of tests is a small change, and carving it into territories would spend most
    // of the reviewers on test files.
    [{ srcDiffLines: 200, diffLines: 3000 }, false],
  ])('%o → territory fan-out: %s', (plan, expected) => {
    expect(isTerritoryFanOut(plan)).toBe(expected);
  });
});

describe('requiredAgents — Step 3A', () => {
  it('demands every dimension, because every dimension walks the whole diff', () => {
    expect(keys(PR)).toEqual(
      expect.arrayContaining([
        '0',
        '1a',
        '1c',
        '2',
        '3a',
        '3b',
        '3c',
        '4',
        '5',
        '6a',
        '6b',
        '6c',
        '7',
      ]),
    );
    // And no territory agents: there are none at this size.
    expect(keys(PR).filter((k) => k.startsWith('chunk-'))).toEqual([]);
  });

  it('drops the adversarial personas when the plan records medium effort, but keeps every other dimension', () => {
    // The personas (6a/6b/6c) are a high-only dimension; a balanced (medium)
    // review deliberately does not launch them, so they must not be *required*
    // — otherwise check-coverage flags them missing and exits 3, halting every
    // small-diff medium review. The effort is read from the plan itself
    // (`plan.effort`, written by the capturing command), never from a caller
    // argument — a roster the caller could shrink is a roster that gets shrunk.
    const med = keys({ ...PR, effort: 'medium' });
    expect(med).not.toContain('6a');
    expect(med).not.toContain('6b');
    expect(med).not.toContain('6c');
    expect(med).toEqual(
      expect.arrayContaining(['0', '1a', '2', '3a', '3b', '3c', '4', '5', '7']),
    );
    // High, and the default (no effort recorded), still demand them.
    expect(keys({ ...PR, effort: 'high' })).toEqual(
      expect.arrayContaining(['6a', '6b', '6c']),
    );
    expect(keys(PR)).toEqual(expect.arrayContaining(['6a', '6b', '6c']));
  });

  it('skips the removed-behavior audit on a diff that removes nothing', () => {
    expect(keys(PR)).not.toContain('1b');
    expect(
      keys({
        ...PR,
        files: [{ path: 'a.ts', kind: 'source', removedLines: 3 }],
      }),
    ).toContain('1b');
  });

  it('runs the audit when the plan does not say — not knowing is not "no"', () => {
    // An agent with nothing to find costs one return. A removed guard nobody looked
    // for costs whatever it was guarding.
    expect(keys({ ...PR, files: [] })).toContain('1b');
  });

  it('asks nothing of a lightweight review that it cannot do', () => {
    // Cross-repo: the diff and nothing else. No tree to grep, none to build, and no
    // PR number in the plan to fetch an issue against. Demanding those would fail
    // every such review for not doing something impossible.
    const light = { ...PR, worktreePath: undefined, prNumber: undefined };
    expect(keys(light)).not.toContain('7');
    expect(keys(light)).not.toContain('1c');
    expect(keys(light)).not.toContain('0');
    expect(keys(light)).toContain('2');
  });

  it.each([
    ['6766', true], // fetch-pr writes the number as a string
    [6766, true], // …a number is fine too
    [undefined, false],
    [null, false],
    [0, false],
    ['0', false],
    ['', false],
    ['not-a-number', false],
  ])('requires Agent 0 for prNumber %o → %s', (prNumber, expected) => {
    // The number arrives from a plan file, so a corrupted or absent value must
    // fail closed to "no PR" rather than demanding an issue agent that has nothing
    // to fetch — but a legitimate numeric string must still count, or every real
    // PR review loses Agent 0.
    expect(keys({ ...PR, prNumber }).includes('0')).toBe(expected);
  });

  it('asks for no issue-fidelity agent on a local review — there is no issue', () => {
    const local = {
      ...PR,
      worktreePath: undefined,
      prNumber: undefined,
      untrackedFiles: [],
    };
    expect(keys(local)).not.toContain('0');
    // But there IS a tree, so the tracer and the build still run.
    expect(keys(local)).toEqual(expect.arrayContaining(['1c', '7']));
  });

  it('requires existing roles recorded by validated repository context without duplicates', () => {
    const context = {
      version: 1,
      provider: 'fake-provider',
      label: 'Example project',
      domains: ['runtime'],
      relatedPaths: ['src/runtime.ts'],
      recommendedTests: ['test:runtime'],
      requiredConfigurations: ['linux-x64'],
      requiredAgents: ['1a', '1b'],
      unverifiedDimensions: ['Alternate runtime was not exercised'],
      verificationNotes: ['Use the repository native test runner'],
    };
    // 1b is policy-permitted but data-gated away here (the diff deletes
    // nothing); a context may require it back. 1a is already required and
    // must not duplicate.
    const roster = keys({ ...PR, repositoryContext: context });
    expect(roster).toContain('1b');
    expect(roster.filter((role) => role === '1a')).toHaveLength(1);
  });

  it('does not let repository context override the effort, topology, or mode gates', () => {
    // A manifest may require agents the policy already runs; it may not
    // inflate or wedge the run by re-adding roles the policy excludes.
    const context = (requiredAgents: string[]) => ({
      version: 1,
      provider: 'fake-provider',
      label: 'Example project',
      domains: [],
      relatedPaths: [],
      recommendedTests: [],
      requiredConfigurations: [],
      requiredAgents,
      unverifiedDimensions: [],
      verificationNotes: [],
    });

    // The adversarial personas are a high-effort dimension: a medium review
    // stays medium even when the repository names them.
    const medium = keys({
      ...PR,
      effort: 'medium',
      repositoryContext: context(['6a', '6b', '6c']),
    });
    expect(medium).not.toContain('6a');
    expect(medium).not.toContain('6b');
    expect(medium).not.toContain('6c');
    // At high effort the same requirement is honoured (and deduplicated).
    expect(
      keys({ ...PR, repositoryContext: context(['6a']) }).filter(
        (role) => role === '6a',
      ),
    ).toHaveLength(1);

    // A lightweight review has no tree to grep: 1c cannot be required back.
    const light = {
      ...PR,
      worktreePath: undefined,
      prNumber: undefined,
      repositoryContext: context(['1c']),
    };
    expect(keys(light)).not.toContain('1c');

    // test-matrix is a fan-out role: a manifest cannot require it into a
    // whole-diff (Step 3A) review, whose flow is not built around it — the
    // denial half of the gate, which a `return fanOut` → `return true`
    // regression would silently drop.
    expect(
      keys({ ...PR, repositoryContext: context(['test-matrix']) }),
    ).not.toContain('test-matrix');

    // A Step 3B fan-out keeps its topology: whole-diff dimension walkers and
    // the high-effort personas stay out, while 3B's own roles are honoured.
    const big = { ...PR, srcDiffLines: 5000, diffLines: 6000 };
    const fanOut = keys({
      ...big,
      repositoryContext: context(['1b', '2', '6a', 'test-matrix']),
    });
    expect(fanOut).not.toContain('2');
    expect(fanOut).not.toContain('6a');
    expect(fanOut.filter((role) => role === 'test-matrix')).toHaveLength(1);
    expect(fanOut).toContain('1b');
  });

  it('fails closed on a present-but-invalid repository context', () => {
    // Full wire shape but version 2: the exact-keys check passes, the
    // version gate throws. A try/catch-return-null wrapper around
    // repositoryContextOf would silently drop every context-required role
    // from the roster AND the coverage certification — certifying a run
    // where the agents the repository required never launched.
    const future = {
      version: 2,
      provider: 'fake-provider',
      label: 'Example project',
      domains: [],
      relatedPaths: [],
      recommendedTests: [],
      requiredConfigurations: [],
      requiredAgents: [],
      unverifiedDimensions: [],
      verificationNotes: [],
    };
    expect(() => keys({ ...PR, repositoryContext: future })).toThrow(
      'unsupported repositoryContext version',
    );
  });

  it('keeps the generic roster when repository context is absent', () => {
    expect(keys(PR)).not.toContain('test-matrix');
  });
});

describe('requiredAgents — the angles promoted out of Agent 1a (#9788)', () => {
  it('requires the language-pitfall scan at high effort, like the personas', () => {
    expect(keys(PR)).toContain('1d');
    expect(keys({ ...PR, effort: 'high' })).toContain('1d');
    // Not knowing the effort fails safe to the full roster.
    expect(keys({ ...PR, effort: undefined })).toContain('1d');
  });

  it('drops both angles when the plan records medium effort', () => {
    // They are a high-effort dimension, exactly like the personas: a balanced
    // review deliberately skips them, so requiring them would halt every
    // medium review of a small diff at check-coverage.
    const med = keys({ ...PR, effort: 'medium' });
    expect(med).not.toContain('1d');
    expect(med).not.toContain('1e');
  });

  it('requires the wrapper/proxy check unless the plan explicitly says no wrapping type', () => {
    // No signal recorded — a plan an older CLI wrote — is not "no wrappers",
    // it is "we do not know", and the safe answer is to run the check: this
    // change removes the clause from 1a, so a miss here leaves the class
    // owned by nobody.
    expect(keys(PR)).toContain('1e');
    expect(keys({ ...PR, wrapperSignal: true })).toContain('1e');
    expect(keys({ ...PR, wrapperSignal: 'nope' })).toContain('1e');
    expect(keys({ ...PR, wrapperSignal: false })).not.toContain('1e');
    // The explicit false drops ONLY 1e: 1d is unconditional at high effort,
    // so a refactor nesting `add('1d')` inside the wrapper gate must fail
    // here — every other fixture omits the field, which reads as true.
    expect(keys({ ...PR, wrapperSignal: false })).toContain('1d');
  });

  it('does not demand either in a Step 3B fan-out — a chunk agent owns the dimensions for its lines', () => {
    const big = { ...PR, srcDiffLines: 5000, diffLines: 6000 };
    expect(keys(big)).not.toContain('1d');
    expect(keys(big)).not.toContain('1e');
  });
});

describe('hasExecutableScript — the script-lint gate predicate', () => {
  // No longer an agent requirement: the orchestrator runs `qwen review
  // script-lint` and compose-review reads its report. This predicate is what
  // both share to decide whether the lint was OWED — detected by path, the same
  // `pathTool` the command dispatches on, so the two cannot disagree.
  it('is never in the agent roster', () => {
    const plan = { ...PR, files: [{ path: 'deploy.sh', kind: 'source' }] };
    expect(keys(plan)).not.toContain('script-lint');
  });

  it.each([
    ['deploy.sh', true],
    ['scripts/build.bash', true],
    ['.github/workflows/ci.yml', true],
    ['Dockerfile', true],
    ['docker/api.Dockerfile', true],
    ['src/pay.ts', false], // production TS: nothing a shell linter owns
    ['README.md', false],
    ['config.yml', false], // yaml, but not a workflow
  ])('a diff touching %s is an executable script: %s', (path, owed) => {
    expect(hasExecutableScript({ files: [{ path }] })).toBe(owed);
  });

  it('is true when any one file among many is an executable script', () => {
    expect(
      hasExecutableScript({
        files: [
          { path: 'src/a.ts' },
          { path: 'src/b.ts' },
          { path: '.husky/pre-commit.sh' },
        ],
      }),
    ).toBe(true);
  });

  it('trusts fileLines only in pr-worktree — a true deletion is exempt there, but never in local/diff-only', () => {
    const wt = { worktreePath: '.qwen/tmp/review-pr-1' }; // pr-worktree mode
    // pr-worktree: fileLines is a real post-image count, so 0 is a TRUE deletion
    // (no file to lint) and is exempt...
    expect(
      hasExecutableScript({
        ...wt,
        files: [{ path: 'gone.sh', fileLines: 0 }],
      }),
    ).toBe(false);
    // ...while a surviving file (fileLines > 0) with addedLines 0 — a removed `fi`
    // that breaks a `.sh` — is still owed.
    expect(
      hasExecutableScript({
        ...wt,
        files: [{ path: 'broke.sh', addedLines: 0, fileLines: 12 }],
      }),
    ).toBe(true);
    // local/diff-only: the report builder writes fileLines 0 for EVERY file (no
    // post-image), so 0 is "unknown", NOT "deleted" — a surviving script must still
    // be owed, or a missing report would pass uncapped. This is the fail-open fix.
    expect(
      hasExecutableScript({
        untrackedFiles: [], // local mode
        files: [{ path: 'deploy.sh', fileLines: 0 }],
      }),
    ).toBe(true);
    // Absent fileLines fails safe to owed.
    expect(
      hasExecutableScript({
        ...wt,
        files: [{ path: 'kept.sh', addedLines: 3 }],
      }),
    ).toBe(true);
  });
});

describe('requiredAgents — Step 3B', () => {
  const BIG = {
    ...PR,
    srcDiffLines: 5000,
    diffLines: 6000,
    chunks: [
      { id: 1, startLine: 1, endLine: 400 },
      { id: 2, startLine: 401, endLine: 800 },
      { id: 3, startLine: 801, endLine: 1200 },
    ],
  };

  it('demands one agent per territory, plus the ones no territory can see', () => {
    expect(keys(BIG)).toEqual(
      expect.arrayContaining([
        'chunk-1',
        'chunk-2',
        'chunk-3',
        'test-matrix',
        '1c',
        '0',
        '7',
      ]),
    );
  });

  it('does not demand the dimension agents — a chunk agent owns them for its lines', () => {
    for (const dim of [
      '1a',
      '2',
      '3a',
      '3b',
      '3c',
      '4',
      '5',
      '6a',
      '6b',
      '6c',
    ]) {
      expect(keys(BIG)).not.toContain(dim);
    }
  });

  it('demands three invariant agents per heavily-rewritten file', () => {
    // One agent holding all eight checks found one of five real invariant defects
    // in a rewritten file; the same model split three ways found all five.
    const heavy = {
      ...BIG,
      files: [
        { path: 'src/big.ts', kind: 'source', removedLines: 9, heavy: true },
        { path: 'src/small.ts', kind: 'source', removedLines: 1, heavy: false },
      ],
    };
    expect(keys(heavy)).toEqual(
      expect.arrayContaining([
        'invariant-a--src/big.ts',
        'invariant-b--src/big.ts',
        'invariant-c--src/big.ts',
      ]),
    );
    expect(keys(heavy)).not.toContain('invariant-a--src/small.ts');
  });

  it('a heavy INTERACTION file KEEPS its invariant agents', () => {
    // The skip that used to live here rested on the merge base holding still
    // between rounds: an interaction file's full-range slice is only "already
    // cleared" while the base it is measured against has not moved. Nothing
    // enforces that — a backward base move (retargeting the PR to an older
    // base) is accepted by the anchor gate — and then the file's slice
    // carries hunks no round has read, with these three the only agents that
    // would walk them. Its chunk agent is briefed for the seam alone.
    const base = {
      ...BIG,
      files: [
        { path: 'src/delta.ts', kind: 'source', removedLines: 9, heavy: true },
        { path: 'src/seam.ts', kind: 'source', removedLines: 9, heavy: true },
      ],
    };
    const incremental = {
      ...base,
      incremental: {
        scope: {
          anchor: 'abc1234def567890',
          deltaFiles: ['src/delta.ts'],
          interaction: [
            { path: 'src/seam.ts', importsChanged: ['src/delta.ts'] },
          ],
        },
      },
    };
    const k = keys(incremental as typeof base);
    expect(k).toContain('invariant-a--src/delta.ts');
    expect(k).toContain('invariant-a--src/seam.ts');
    expect(k).toContain('invariant-b--src/seam.ts');
    expect(k).toContain('invariant-c--src/seam.ts');
  });
});

describe('a heavy file in a Step-3A-sized diff', () => {
  it('does NOT demand invariant agents — Step 3A never launches them', () => {
    // `heavy` is decided independently of topology: a 300-line source file with
    // ~120 changed lines clears the rewrite-ratio branch while `srcDiffLines` stays
    // under 500 — a Step 3A review. Requiring invariant agents there demanded agents
    // the review never launches, and `check-coverage` then exit-3'd an otherwise
    // complete small PR. (A real finding from a human review of this change.)
    const smallButHeavy = {
      ...PR, // srcDiffLines 200, diffLines 300 → Step 3A
      files: [
        {
          path: 'src/rewritten.ts',
          kind: 'source',
          removedLines: 40,
          heavy: true,
        },
      ],
    };
    expect(isTerritoryFanOut(smallButHeavy)).toBe(false);
    const k = keys(smallButHeavy);
    expect(k).not.toContain('invariant-a--src/rewritten.ts');
    expect(k).not.toContain('invariant-b--src/rewritten.ts');
    expect(k).not.toContain('invariant-c--src/rewritten.ts');
    // It is still a normal 3A review: the dimension agents each walk the whole diff,
    // and one that walks the whole diff already sees both ends of the file.
    expect(k).toEqual(expect.arrayContaining(['1a', '2', '6a']));
  });
});

describe('the fix-audit roster (#10104)', () => {
  const posture = {
    since: 'a'.repeat(40),
    effective: true,
    posture: 'critical' as const,
    scope: {
      anchor: 'a'.repeat(40),
      deltaFiles: ['src/a.ts'],
      interaction: [],
    },
  };

  it('drops Agent 0 and keeps the territory shape on a small delta', () => {
    const plan = {
      prNumber: '123',
      ownerRepo: 'o/r',
      worktreePath: '/wt',
      srcDiffLines: 120,
      diffLines: 300,
      chunks: [{ id: 1 }, { id: 2 }],
      files: [{ path: 'src/a.ts', removedLines: 1, fileLines: 10 }],
      incremental: posture,
    };
    const keys = requiredAgents(plan).map((a) => a.key);
    expect(keys).not.toContain('0');
    // The chunk fan-out, not the 3A dimension set — the posture flips the
    // shared predicate whatever the narrowed delta's size says.
    expect(keys).toContain('chunk-1');
    expect(keys).toContain('chunk-2');
    expect(keys).toContain('test-matrix');
    expect(keys).not.toContain('1a');
    expect(keys).not.toContain('6a');
    // The cross-chunk safety nets stay.
    expect(keys).toContain('1b');
    expect(keys).toContain('1c');
    expect(keys).toContain('7');
  });

  it('keeps Agent 0 on the same plan without the posture', () => {
    const plan = {
      prNumber: '123',
      ownerRepo: 'o/r',
      worktreePath: '/wt',
      srcDiffLines: 120,
      diffLines: 300,
      chunks: [{ id: 1 }],
      files: [{ path: 'src/a.ts', removedLines: 1, fileLines: 10 }],
      incremental: { ...posture, posture: undefined },
    };
    const keys = requiredAgents(plan).map((a) => a.key);
    expect(keys).toContain('0');
    // …and reads as 3A: the dimension set, no chunk agents.
    expect(keys).toContain('1a');
    expect(keys).not.toContain('chunk-1');
  });

  it('gives a heavy file its invariant agents under the posture', () => {
    const plan = {
      prNumber: '123',
      ownerRepo: 'o/r',
      worktreePath: '/wt',
      srcDiffLines: 120,
      diffLines: 300,
      chunks: [{ id: 1 }],
      files: [
        { path: 'src/a.ts', removedLines: 0, fileLines: 10, heavy: true },
      ],
      incremental: posture,
    };
    const keys = requiredAgents(plan).map((a) => a.key);
    expect(keys).toContain('invariant-a--src/a.ts');
    expect(keys).toContain('invariant-b--src/a.ts');
    expect(keys).toContain('invariant-c--src/a.ts');
  });
});
