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
import { requiredAgents, reviewMode, isTerritoryFanOut } from './roster.js';

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
        '3',
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
    for (const dim of ['1a', '2', '3', '4', '5', '6a', '6b', '6c']) {
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
});
