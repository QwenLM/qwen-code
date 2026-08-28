/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildTestReport } from '../build-test.js';
import {
  PREBUILD_BUDGET_S,
  PREBUILD_COMMAND_TIMEOUT_S,
  PREBUILD_ENV,
  prebuildRequested,
  prebuildWorktree,
} from './prebuild.js';

describe('prebuildRequested', () => {
  const never = () => false;

  it('is on for 1 and true, whatever the case or padding', () => {
    for (const value of ['1', 'true', ' TRUE ', 'True']) {
      expect(prebuildRequested({ [PREBUILD_ENV]: value }, never)).toBe(true);
    }
  });

  it('is off when unset and for every other value', () => {
    expect(prebuildRequested({}, never)).toBe(false);
    for (const value of ['', '0', 'false', 'yes', 'on']) {
      expect(prebuildRequested({ [PREBUILD_ENV]: value }, never)).toBe(false);
    }
  });

  it('ignores a value sourced from a .env file', () => {
    // The reviewed checkout's `.qwen/.env` reaches process.env through the
    // environment loader; a repository must not decide to prebuild its own
    // review. Same rule as QWEN_REVIEW_SANDBOX.
    expect(
      prebuildRequested({ [PREBUILD_ENV]: '1' }, (key) => key === PREBUILD_ENV),
    ).toBe(false);
  });
});

describe('prebuildWorktree', () => {
  let root: string;
  let worktree: string;
  let plan: string;
  let report: string;

  beforeEach(() => {
    // realpath once: macOS's tmpdir is a symlink, and the paths handed back
    // must compare equal to what the seam receives.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-prebuild-')));
    worktree = join(root, 'wt');
    mkdirSync(worktree);
    plan = join(root, 'fetch.json');
    writeFileSync(plan, '{}');
    report = join(root, 'prebuild.json');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const green: BuildTestReport = {
    toolchain: 'npm',
    affected: ['packages/cli'],
    buildSet: ['packages/core', 'packages/cli'],
    widenedWith: [],
    install: null,
    build: [],
    test: [],
    buildOnly: true,
    ok: true,
    timedOut: [],
    note: '',
  };

  /** A build step that installs the way npm does: the marker lands last. */
  function installs(result: BuildTestReport) {
    return vi.fn((args: { worktree: string }) => {
      mkdirSync(join(args.worktree, 'node_modules'), { recursive: true });
      writeFileSync(
        join(args.worktree, 'node_modules', '.package-lock.json'),
        '{}',
      );
      return result;
    });
  }

  it("runs Agent 7's build-test with install and build-only under the step-sized budget", () => {
    const run = installs(green);
    const clock = [1_000, 4_500];
    const out = prebuildWorktree({
      plan,
      worktree,
      report,
      run,
      now: () => clock.shift() ?? 4_500,
    });
    // Every argument is the contract: the same command Agent 7 runs, with
    // the tests left to Agent 7 and the budget sized to a workflow step.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      plan,
      worktree,
      out: report,
      timeout: PREBUILD_COMMAND_TIMEOUT_S,
      budget: PREBUILD_BUDGET_S,
      install: true,
      buildOnly: true,
    });
    expect(PREBUILD_BUDGET_S).toBeGreaterThan(600);
    expect(PREBUILD_COMMAND_TIMEOUT_S).toBeGreaterThan(600);
    expect(PREBUILD_BUDGET_S).toBeGreaterThanOrEqual(
      PREBUILD_COMMAND_TIMEOUT_S,
    );
    expect(out).toEqual({
      installed: true,
      built: true,
      note: '',
      report,
      durationMs: 3_500,
    });
    // The report is build-test's own, verbatim — one format for whoever
    // diagnoses a prebuild next.
    expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual(green);
  });

  it('is not built when the budget cut the closure short, even on ok: true', () => {
    // build-test keeps `ok` for the packages it did build; a closure with a
    // package never compiled is not a tree a probe can run against — the
    // same rule base-tree applies to the merge-base tree.
    const out = prebuildWorktree({
      plan,
      worktree,
      report,
      run: installs({ ...green, notBuilt: ['packages/cli'] }),
    });
    expect(out.installed).toBe(true);
    expect(out.built).toBe(false);
  });

  it("carries build-test's verdict and note when the build failed", () => {
    const out = prebuildWorktree({
      plan,
      worktree,
      report,
      run: installs({
        ...green,
        ok: false,
        note: 'packages/cli: build exited 2',
      }),
    });
    expect(out.installed).toBe(true);
    expect(out.built).toBe(false);
    expect(out.note).toBe('packages/cli: build exited 2');
    expect(out.report).toBe(report);
  });

  it("reads `installed` off npm's marker, not off build-test's word", () => {
    // A green report over a tree with no marker (the install phase was
    // skipped, or npm never wrote it) must not claim a complete
    // node_modules: Agent 7's install gate reads the marker, and the report
    // must agree with the gate.
    const out = prebuildWorktree({
      plan,
      worktree,
      report,
      run: vi.fn(() => green),
    });
    expect(out.installed).toBe(false);
    expect(out.built).toBe(true);
  });

  it('never throws: a build-test that throws is recorded, not raised', () => {
    const out = prebuildWorktree({
      plan,
      worktree,
      report,
      run: vi.fn(() => {
        throw new Error('plan report is not valid JSON');
      }),
    });
    expect(out).toEqual({
      installed: false,
      built: false,
      note: 'prebuild did not run: plan report is not valid JSON',
      report: null,
      durationMs: expect.any(Number),
    });
    expect(existsSync(report)).toBe(false);
  });

  it('keeps the outcome when the report file cannot be written', () => {
    const out = prebuildWorktree({
      plan,
      worktree,
      report: join(root, 'no-such-dir', 'prebuild.json'),
      run: installs(green),
    });
    expect(out.installed).toBe(true);
    expect(out.built).toBe(true);
    expect(out.report).toBeNull();
  });
});
