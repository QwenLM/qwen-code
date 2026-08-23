/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const settingsMock = vi.hoisted(() => vi.fn(() => ({ merged: {} })));
vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  return { ...actual, loadSettings: settingsMock };
});
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDiffCommand } from './plan-diff.js';
import { chunksCoverDiff } from './lib/diff-plan.js';
import { makeDiff, seedParseArgs } from './lib/test-utils.js';
import { DEADLINE_ENV } from './lib/deadline.js';

let dir: string;
let cwd: string;
const run = (diffPath: string, out: string, maxChunkLines = 400) =>
  (planDiffCommand.handler as (a: unknown) => void)({
    diff_path: diffPath,
    out,
    maxChunkLines,
  });

beforeEach(() => {
  // The settings mock is module-level, so a test that sets a ceiling leaves it
  // set for every test after it — including the whole trailing describe, which
  // would then run the real handler with an undeclared ceiling in play.
  settingsMock.mockReturnValue({ merged: {} });
  dir = mkdtempSync(join(tmpdir(), 'plan-diff-'));
  cwd = process.cwd();
  process.chdir(dir);
  process.exitCode = undefined;
});
afterEach(() => {
  process.chdir(cwd);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('plan-diff — the round cap the handler actually records', () => {
  // The capture handlers are where the two machine facts enter a plan, and
  // until now nothing exercised that wiring: the budget unit tests pass the
  // context directly, so a handler that forgot to read the environment would
  // have kept every one of them green. This drives the real handler with a
  // real env and reads the number out of the file it wrote.
  const hugeDiff = () => makeDiff('src/huge.ts', 9000);

  it('records the huge tier only when the environment has a deadline', () => {
    const diffPath = join(dir, 'huge.diff');
    writeFileSync(diffPath, hugeDiff());
    const before = process.env[DEADLINE_ENV];
    try {
      delete process.env[DEADLINE_ENV];
      const noClock = join(dir, 'no-clock.json');
      run(diffPath, noClock);
      const a = JSON.parse(readFileSync(noClock, 'utf8'));
      expect(a.srcDiffLines).toBeGreaterThanOrEqual(3000);
      expect(a.budget.reverseAuditRounds).toBe(5);

      process.env[DEADLINE_ENV] = String(Math.floor(Date.now() / 1000) + 7200);
      const withClock = join(dir, 'with-clock.json');
      run(diffPath, withClock);
      expect(
        JSON.parse(readFileSync(withClock, 'utf8')).budget.reverseAuditRounds,
      ).toBe(3);
    } finally {
      if (before === undefined) delete process.env[DEADLINE_ENV];
      else process.env[DEADLINE_ENV] = before;
    }
  });

  it('records the operator ceiling the settings actually carry', () => {
    // The write half of `review.reverseAuditRounds`: capture command →
    // buildPlanReport → reviewBudget. Every budget unit test passes the
    // ceiling in directly, so a handler that never read the setting would
    // have kept them all green. This drives the handler with the setting
    // mocked at its source and reads the number out of the file it wrote.
    const diffPath = join(dir, 'small.diff');
    writeFileSync(diffPath, makeDiff('src/small.ts', 120));
    const out = join(dir, 'ceiling.json');
    settingsMock.mockReturnValue({ merged: { review: {} } });
    run(diffPath, out);
    expect(
      JSON.parse(readFileSync(out, 'utf8')).budget.reverseAuditRounds,
    ).toBe(10);
    settingsMock.mockReturnValue({
      merged: { review: { reverseAuditRounds: 4 } },
    });
    const capped = join(dir, 'ceiling-4.json');
    run(diffPath, capped);
    expect(
      JSON.parse(readFileSync(capped, 'utf8')).budget.reverseAuditRounds,
    ).toBe(4);
    // …and a ceiling above the tier still buys nothing, through the handler.
    settingsMock.mockReturnValue({
      merged: { review: { reverseAuditRounds: 20 } },
    });
    const raised = join(dir, 'ceiling-20.json');
    run(diffPath, raised);
    expect(
      JSON.parse(readFileSync(raised, 'utf8')).budget.reverseAuditRounds,
    ).toBe(10);
  });

  it('reads a malformed deadline as no deadline, exactly as the gates do', () => {
    // `hasReviewDeadline` shares the gates' parse on purpose: a value the gate
    // will not enforce must not make the budget behave as though it would.
    const diffPath = join(dir, 'huge2.diff');
    writeFileSync(diffPath, hugeDiff());
    const before = process.env[DEADLINE_ENV];
    try {
      for (const bad of ['', '   ', 'soon', '0', '-1']) {
        process.env[DEADLINE_ENV] = bad;
        const out = join(dir, `bad-${bad.trim() || 'empty'}.json`);
        run(diffPath, out);
        expect(
          JSON.parse(readFileSync(out, 'utf8')).budget.reverseAuditRounds,
        ).toBe(5);
      }
    } finally {
      if (before === undefined) delete process.env[DEADLINE_ENV];
      else process.env[DEADLINE_ENV] = before;
    }
  });
});

describe('plan-diff', () => {
  it('emits the same chunk plan a fetch report carries', () => {
    // This is what makes Step 3B reachable for a local-diff review: the
    // territory fan-out needs a `chunks[]` list, and only `fetch-pr` used to
    // produce one.
    const diffPath = join(dir, 'local.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(diffPath, makeDiff('src/a.ts', 1200));
    run(diffPath, out);

    const plan = JSON.parse(readFileSync(out, 'utf8'));
    expect(plan.diffPathAbsolute).toBe(diffPath);
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(chunksCoverDiff(plan.chunks, plan.diffLines)).toBe(true);
    expect(plan.srcDiffLines).toBe(plan.diffLines);
    expect(plan.files[0].path).toBe('src/a.ts');
    expect(plan.files[0].kind).toBe('source');
  });

  it('carries the PR identity when told to — the roster requires Agent 0 from it', () => {
    // A lightweight cross-repo review has a PR but no worktree. Without these
    // fields the plan classifies as diff-only, the roster omits issue fidelity,
    // and check-coverage blesses the omission — the skill's own lightweight path
    // says Agent 0 runs whenever pr-context succeeded. Presence of the pair IS
    // the context-availability signal: the skill passes the flags only then.
    const diffPath = join(dir, 'local.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(diffPath, makeDiff('src/a.ts', 60));
    (planDiffCommand.handler as (a: unknown) => void)({
      diff_path: diffPath,
      out,
      maxChunkLines: 400,
      pr: 6998,
      repo: 'QwenLM/qwen-code',
      host: 'ghe.example.com',
    });

    const plan = JSON.parse(readFileSync(out, 'utf8'));
    expect(plan.prNumber).toBe('6998');
    expect(plan.ownerRepo).toBe('QwenLM/qwen-code');
    // The host rides along — Agent 0's welded issue-context command routes
    // at it (a lightweight run has no fetch-pr to carry it otherwise).
    expect(plan.host).toBe('ghe.example.com');
    // And no worktree appears — the identity does not fake a tree.
    expect(plan.worktreePath).toBeUndefined();
  });

  it('omits host when none is passed, and rejects a non-hostname', () => {
    const diffPath = join(dir, 'local.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(diffPath, makeDiff('src/a.ts', 60));
    (planDiffCommand.handler as (a: unknown) => void)({
      diff_path: diffPath,
      out,
      maxChunkLines: 400,
      pr: 6998,
      repo: 'QwenLM/qwen-code',
    });
    expect(JSON.parse(readFileSync(out, 'utf8')).host).toBeUndefined();

    // The role-0 weld interpolates this value unquoted into a shell command
    // — a metacharacter payload must die here, not in an agent's shell. And
    // the error is the usage class: exit 2, not an uncaught crash.
    (planDiffCommand.handler as (a: unknown) => void)({
      diff_path: diffPath,
      out,
      maxChunkLines: 400,
      pr: 6998,
      repo: 'QwenLM/qwen-code',
      host: 'ghe.example.com; touch /tmp/pwned',
    });
    expect(process.exitCode).toBe(2);
    // The no-record half of "the payload must die here": validation runs
    // BEFORE the write, so the plan on disk never carries the metacharacter
    // host the role-0 weld would interpolate unquoted into a shell command.
    expect(JSON.parse(readFileSync(out, 'utf8')).host).not.toBe(
      'ghe.example.com; touch /tmp/pwned',
    );
  });

  it('records the effort the caller passed, so the roster reads it from the plan', () => {
    // The effort belongs IN the plan, not in a flag to `requiredAgents`: the
    // roster, check-coverage and compose-review then all read one value and
    // cannot disagree, and no caller can shrink the roster by omitting a flag.
    const diffPath = join(dir, 'local.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(diffPath, makeDiff('src/a.ts', 60));
    (planDiffCommand.handler as (a: unknown) => void)({
      diff_path: diffPath,
      out,
      maxChunkLines: 400,
      effort: 'medium',
    });
    expect(JSON.parse(readFileSync(out, 'utf8')).effort).toBe('medium');
  });

  it('recovers the effort from the parse-args report when --effort is not re-threaded', () => {
    seedParseArgs(dir, 'medium');
    const diffPath = join(dir, 'local.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(diffPath, makeDiff('src/a.ts', 60));
    run(diffPath, out); // note: no effort passed

    expect(JSON.parse(readFileSync(out, 'utf8')).effort).toBe('medium');
  });

  it('omits effort when none is passed — the roster then keeps the full set', () => {
    const diffPath = join(dir, 'local.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(diffPath, makeDiff('src/a.ts', 60));
    (planDiffCommand.handler as (a: unknown) => void)({
      diff_path: diffPath,
      out,
      maxChunkLines: 400,
    });
    expect(JSON.parse(readFileSync(out, 'utf8')).effort).toBeUndefined();
  });

  it('refuses half a PR identity — a roster cannot require an agent nobody can build', () => {
    const diffPath = join(dir, 'local.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(diffPath, makeDiff('src/a.ts', 60));
    (planDiffCommand.handler as (a: unknown) => void)({
      diff_path: diffPath,
      out,
      maxChunkLines: 400,
      pr: 6998,
    });
    // A usage error, so exit 2 under the sibling-handler contract.
    expect(process.exitCode).toBe(2);
  });

  it('cannot decide heaviness without a tree, and says so by omission', () => {
    // A bare diff file has no ref to resolve a post-image against, so no file
    // is heavy and no `addedRanges` are emitted. Chunk coverage still holds.
    const diffPath = join(dir, 'local.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(diffPath, makeDiff('src/big.ts', 2000));
    run(diffPath, out);

    const plan = JSON.parse(readFileSync(out, 'utf8'));
    expect(plan.files.every((f: { heavy: boolean }) => !f.heavy)).toBe(true);
    expect(plan.files[0].addedRanges).toBeUndefined();
    expect(plan.files[0].fileLines).toBe(0);
  });

  it('carries the topology numbers a local review needs', () => {
    const diffPath = join(dir, 'local.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(
      diffPath,
      makeDiff('src/a.ts', 10) +
        makeDiff('src/a.test.ts', 20) +
        makeDiff('docs/guide.md', 30) +
        makeDiff('package-lock.json', 40),
    );
    run(diffPath, out);

    const plan = JSON.parse(readFileSync(out, 'utf8'));
    expect(plan.srcDiffLines).toBe(14); // 4 header lines + 10 body
    expect(plan.testDiffLines).toBe(24);
    expect(plan.docsDiffLines).toBe(34);
    expect(plan.generatedDiffLines).toBe(44);
  });

  it('emits addedRanges only where they are consumed', () => {
    // The report is read with `read_file` and truncates at the same ~25 000
    // chars a chunk does. Only heavy files feed invariant agents, so only they
    // carry the ranges — and a bare diff has no heavy files at all.
    const diffPath = join(dir, 'local.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(diffPath, makeDiff('src/a.ts', 50));
    run(diffPath, out);
    const raw = readFileSync(out, 'utf8');
    expect(raw).not.toContain('addedRanges');
    expect(raw).toContain('"hunks"'); // anchors still need these
  });

  it('refuses a diff whose chunks would not tile it', () => {
    // `buildDiffPlan` asserts the tiling invariant. `plan-diff` has no worktree
    // to protect, so it fails loudly rather than degrading — exit 1, a real
    // content failure, not a usage error.
    const diffPath = join(dir, 'junk.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(diffPath, 'this is not a diff\nnot at all\n');
    run(diffPath, out);
    expect(process.exitCode).toBe(1);
  });

  it('plans an empty diff without pretending it reviewed anything', () => {
    // A file-path review of an unchanged file lands here. The plan is empty and
    // valid; what must not happen is a clean verdict over nothing, so the
    // command says so and the skill has a no-diff branch.
    const diffPath = join(dir, 'empty.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(diffPath, '');
    run(diffPath, out);
    const plan = JSON.parse(readFileSync(out, 'utf8'));
    expect(plan.chunks).toEqual([]);
    expect(plan.files).toEqual([]);
    expect(plan.diffLines).toBe(0);
  });

  it('reports a missing diff file by name', () => {
    run(join(dir, 'absent.diff'), join(dir, 'p.json'));
    expect(process.exitCode).toBe(1);
  });
});
