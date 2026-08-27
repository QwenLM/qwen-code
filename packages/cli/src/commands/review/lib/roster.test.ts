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
  isPromptPath,
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
    // The counter-frame audit is a persona-tier depth pass: same gate.
    expect(med).not.toContain('6d');
    expect(med).toEqual(
      expect.arrayContaining(['0', '1a', '2', '3a', '3b', '3c', '4', '5', '7']),
    );
    // High, and the default (no effort recorded), still demand them.
    expect(keys({ ...PR, effort: 'high' })).toEqual(
      expect.arrayContaining(['6a', '6b', '6c', '6d']),
    );
    expect(keys(PR)).toEqual(expect.arrayContaining(['6a', '6b', '6c', '6d']));
    // The counter-frame audit alone survives the 3B topology switch: the
    // author's frame spans territories, so it stays a whole-diff agent there —
    // and a chunked PR with a strong narrative is the most frame-capturable
    // shape. Same effort gate as in 3A.
    const fanOut = keys({ ...PR, srcDiffLines: 900, diffLines: 4000 });
    expect(fanOut).not.toContain('6a');
    expect(fanOut).toContain('6d');
    expect(
      keys({ ...PR, srcDiffLines: 900, diffLines: 4000, effort: 'medium' }),
    ).not.toContain('6d');
    // And no frame without a PR: a local or file-path review has no
    // description to counter and no incident to replay — 6d is gated on the
    // PR identity exactly as Agent 0 is, in both topologies.
    const noPr = { ...PR, prNumber: undefined, ownerRepo: undefined };
    expect(keys(noPr)).not.toContain('6d');
    expect(keys({ ...noPr, srcDiffLines: 900, diffLines: 4000 })).not.toContain(
      '6d',
    );
    // But NO mode gate: an identity-bearing cross-repo lightweight review
    // keeps 6d — it reads the diff and the PR context, needing no tree. A
    // `&& mode !== 'diff-only'` "reconciliation" at either add site would
    // silently drop the counter-frame audit from exactly the lightweight PR
    // reviews the SKILL narration promises it to.
    expect(keys({ ...PR, worktreePath: undefined })).toContain('6d');
    expect(
      keys({
        ...PR,
        worktreePath: undefined,
        srcDiffLines: 900,
        diffLines: 4000,
      }),
    ).toContain('6d');
  });

  it('owes the prose-execution audit exactly when the diff touches an instruction file', () => {
    // No prompt file in the diff: no prose to execute, no agent.
    expect(keys(PR)).not.toContain('prose-exec');
    const withSkill = {
      ...PR,
      files: [
        ...PR.files,
        { path: 'packages/core/src/skills/bundled/review/SKILL.md' },
      ],
    };
    // A prompt file plus a tree: owed — and at medium too, unlike the
    // personas: on a prompt-file diff it is the highest-yield agent there is.
    expect(keys(withSkill)).toContain('prose-exec');
    expect(keys({ ...withSkill, effort: 'medium' })).toContain('prose-exec');
    // Both topologies: a chunked PR touching SKILL.md still owes the execution.
    expect(
      keys({ ...withSkill, srcDiffLines: 900, diffLines: 4000 }),
    ).toContain('prose-exec');
    // And in BOTH tree'd modes: a local (uncommitted-change) review runs the
    // repository's tooling too, so `mode !== 'diff-only'` owes the audit there
    // as well — narrowing the gate to pr-worktree alone must fail here.
    expect(
      keys({ ...withSkill, worktreePath: undefined, untrackedFiles: [] }),
    ).toContain('prose-exec');
    // Reserved directories hold their files under any basename, and the
    // pipeline's rules file is prose it provably follows: each owes the
    // audit even as the diff's ONLY prompt-path change.
    expect(
      keys({
        ...PR,
        files: [{ path: '.qwen/commands/release-notes.test.md' }],
      }),
    ).toContain('prose-exec');
    expect(
      keys({ ...PR, files: [{ path: '.qwen/review-rules.md' }] }),
    ).toContain('prose-exec');
    // But never without a tree to run the repository's tooling in.
    expect(
      keys({
        files: withSkill.files,
        chunks: [],
      }),
    ).not.toContain('prose-exec');
    // No `files[]` at all — a plan an older CLI wrote — is "we do not know",
    // and the answer is the one 1b gives the same input: run the audit (one
    // empty-scope return) rather than let the skew drop the role its only
    // add site owes. A recorded, EMPTY list is a different statement — a
    // diff that touched nothing owes nothing.
    expect(keys({ ...PR, files: undefined })).toContain('prose-exec');
    expect(keys({ ...PR, files: 'junk' as unknown as never })).toContain(
      'prose-exec',
    );
    expect(keys({ ...PR, files: [] })).toContain('prose-exec');
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
  ])('gates Agent 0 and 6d on prNumber %o → %s', (prNumber, expected) => {
    // The number arrives from a plan file, so a corrupted or absent value must
    // fail closed to "no PR" rather than demanding an issue agent that has nothing
    // to fetch — but a legitimate numeric string must still count, or every real
    // PR review loses Agent 0.
    const k = keys({ ...PR, prNumber });
    expect(k.includes('0')).toBe(expected);
    // The counter-frame audit shares the prNumber conjunct, pinned here in
    // ISOLATION (ownerRepo still present): dropping `isPositivePrNumber` from
    // `countersFrame` would otherwise ship green, roster 6d on a plan its brief
    // builder throws on, and wedge `agent-prompt --roster` for the whole review.
    expect(k.includes('6d')).toBe(expected);
  });

  it('gates the counter-frame audit on ownerRepo in isolation too', () => {
    // A valid prNumber with no ownerRepo still has no frame to fetch: the
    // ownerRepo conjunct of `countersFrame` must hold on its own, or dropping it
    // rosters 6d on a plan the brief builder rejects.
    expect(keys({ ...PR, ownerRepo: undefined })).not.toContain('6d');
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

    // 6d keeps the persona tier's effort gate: a manifest cannot re-add the
    // counter-frame audit to a medium review (a `case '6d': return true`
    // mutant ships the tier contract's contradiction green).
    expect(
      keys({ ...PR, effort: 'medium', repositoryContext: context(['6d']) }),
    ).not.toContain('6d');
    // …and the identity half of the same gate: a manifest cannot conjure a
    // frame onto a PR-less review — the 6d brief builder throws on such a
    // plan, so honouring this would wedge `agent-prompt --roster` for every
    // local review of a repo whose manifest names 6d (the
    // `return plan.effort !== 'medium'` mutant ships exactly that).
    expect(
      keys({
        ...PR,
        prNumber: undefined,
        ownerRepo: undefined,
        repositoryContext: context(['6d']),
      }),
    ).not.toContain('6d');
    // prose-exec cannot be required into a review with no tree to execute
    // in — check-coverage would exit 3 demanding an agent that can only
    // whiff.
    expect(
      keys({
        ...PR,
        worktreePath: undefined,
        repositoryContext: context(['prose-exec']),
      }),
    ).not.toContain('prose-exec');
    // …but on a tree'd review with NO prompt-path files, the manifest
    // re-add is honoured — the escape hatch isPromptPath's doc comment
    // promises, which a `case 'prose-exec': return false` mutant would
    // silently kill.
    expect(
      keys({ ...PR, repositoryContext: context(['prose-exec']) }),
    ).toContain('prose-exec');
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

describe('isPromptPath — the instruction-file detector', () => {
  it.each([
    // Skills, agent definitions, prompt directories, and prompt/brief-named files.
    ['packages/core/src/skills/bundled/review/SKILL.md', true],
    ['.claude/agents/reviewer.md', true],
    ['.qwen/agents/helper.md', true],
    ['src/prompts/system.txt', true],
    ['packages/cli/src/commands/review/lib/agent-briefs.ts', true],
    ['packages/cli/src/commands/review/agent-prompt.ts', true],
    ['docs/system-prompt.md', true],
    // Root guidance files, by each ecosystem's reserved name — standing
    // instructions with operational recipes, the motivating incident's shape.
    ['AGENTS.md', true],
    ['CLAUDE.md', true],
    ['QWEN.md', true],
    ['packages/cli/GEMINI.md', true],
    ['.github/copilot-instructions.md', true],
    // Slash-command definitions are prompts too — and the dot-directories
    // count NESTED as well as at the root (a `(^|\/)` → `(^)` mutant flips
    // only the nested form, the false-negative direction the doc calls the
    // expensive one).
    ['.claude/commands/deploy.md', true],
    ['.qwen/commands/review.md', true],
    ['packages/x/.claude/agents/foo.md', true],
    // A file in a reserved directory is followed under ANY name:
    // FileCommandLoader globs **/*.md with no test filter, so a command
    // named `release-notes.test` loads live and a `.test.` basename must
    // not hide the file from the execution audit.
    ['.qwen/commands/release-notes.test.md', true],
    ['.claude/agents/reviewer.test.md', true],
    ['prompts/system.test.md', true],
    // The pipeline's own review rules: load-rules reads them first and
    // bakes them into every brief, so a rules-only diff owes the audit —
    // the pre-merge review is the only gate that can execute the change.
    ['.qwen/review-rules.md', true],
    // Singular and embedded tokens — the alternation's both halves (a
    // `briefs`-only or `prompt`-only mutant flips one of these).
    ['docs/brief.md', true],
    ['docs/my-prompts.md', true],
    // Test code ABOUT prompts pins them; it is not itself followed as one —
    // both exclusion spellings.
    ['packages/cli/src/commands/review/agent-prompt.test.ts', false],
    ['src/review-brief.spec.ts', false],
    // Ordinary code and docs.
    ['packages/cli/src/commands/review/drive.ts', false],
    ['README.md', false],
    // A token match, not a substring match: promptness must be a word.
    ['src/prompter.ts', false],
  ])('%s → %s', (path, expected) => {
    expect(isPromptPath(path)).toBe(expected);
  });
});
