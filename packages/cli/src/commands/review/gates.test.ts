/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Verifies the hard preconditions added in lib/session.ts: the LLM driver
// cannot call pr-context / presubmit / deterministic --pr / load-rules --pr
// for a PR target without an active fetch-pr session. A weakly instruction-
// following model that bypasses fetch-pr is intercepted here rather than
// silently corrupting the user's working tree.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yargs from 'yargs';
import { prContextCommand } from './pr-context.js';
import { presubmitCommand } from './presubmit.js';
import { deterministicCommand } from './deterministic.js';
import { loadRulesCommand } from './load-rules.js';
import { fetchReportPath, type FetchReport } from './lib/session.js';

const FIXTURE: FetchReport = {
  prNumber: '7',
  ownerRepo: 'octo/repo',
  remote: 'origin',
  ref: 'qwen-review/pr-7',
  fetchedSha: 'b'.repeat(40),
  worktreePath: '.qwen/tmp/review-pr-7',
  baseRefName: 'main',
  headRefName: 'feature',
  isCrossRepository: false,
  diffStat: { files: 1, additions: 0, deletions: 0 },
  commentMode: false,
};

function writeReport(prNumber: string, overrides: Partial<FetchReport>): void {
  mkdirSync('.qwen/tmp', { recursive: true });
  writeFileSync(
    fetchReportPath(prNumber),
    JSON.stringify({ ...FIXTURE, ...overrides, prNumber }),
    'utf8',
  );
}

async function runOrCapture(args: string[]): Promise<Error | null> {
  // Each command's `command:` is the bare subcommand (e.g. `pr-context`),
  // so we inject the right CommandModule here and let yargs route to it.
  try {
    await yargs(args)
      .command(prContextCommand)
      .command(presubmitCommand)
      .command(deterministicCommand)
      .command(loadRulesCommand)
      .demandCommand(1)
      .strict()
      .fail((_msg, err) => {
        throw err ?? new Error(_msg);
      })
      .exitProcess(false)
      .parseAsync();
    return null;
  } catch (err) {
    return err as Error;
  }
}

describe('review subcommand gates (require fetch-pr report)', () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'qwen-review-gate-'));
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('pr-context refuses when no fetch report exists', async () => {
    const err = await runOrCapture([
      'pr-context',
      '7',
      'octo/repo',
      '--out',
      '.qwen/tmp/ctx.md',
    ]);
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/Missing fetch-pr report for PR #7/);
    expect(err?.message).toMatch(/qwen review fetch-pr 7/);
  });

  it('presubmit refuses when no fetch report exists', async () => {
    const err = await runOrCapture([
      'presubmit',
      '7',
      'b'.repeat(40),
      'octo/repo',
      '.qwen/tmp/presubmit.json',
    ]);
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/Missing fetch-pr report for PR #7/);
  });

  it('load-rules --pr refuses when no fetch report exists', async () => {
    const err = await runOrCapture([
      'load-rules',
      'origin/main',
      '--out',
      '.qwen/tmp/rules.md',
      '--pr',
      '7',
      '--owner-repo',
      'octo/repo',
    ]);
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/Missing fetch-pr report for PR #7/);
  });

  it('load-rules --pr refuses when --owner-repo is not supplied', async () => {
    // SKILL.md now passes both flags together; tightening the contract here
    // catches a weakly instruction-following model that drops --owner-repo
    // and would have inherited the previous "presence-only" gate.
    const err = await runOrCapture([
      'load-rules',
      'origin/main',
      '--out',
      '.qwen/tmp/rules.md',
      '--pr',
      '7',
    ]);
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/--owner-repo is required when --pr is set/);
  });

  it('load-rules --pr refuses when report.ownerRepo does not match', async () => {
    writeReport('7', { ownerRepo: 'attacker/repo' });
    const err = await runOrCapture([
      'load-rules',
      'origin/main',
      '--out',
      '.qwen/tmp/rules.md',
      '--pr',
      '7',
      '--owner-repo',
      'octo/repo',
    ]);
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/bound to a different repo/);
  });

  it('load-rules without --pr does not require a fetch report', async () => {
    // Initialize a real (empty) git repo so `git show <ref>:<path>` doesn't
    // error before load-rules has a chance to find no rule files.
    const { execSync } = await import('node:child_process');
    execSync('git init -q', { cwd });
    execSync(
      'git -c user.email=a@b.c -c user.name=test commit --allow-empty -m init -q',
      { cwd },
    );
    const err = await runOrCapture([
      'load-rules',
      'HEAD',
      '--out',
      '.qwen/tmp/rules.md',
    ]);
    expect(err).toBeNull();
  });

  it('deterministic --pr refuses when no fetch report exists', async () => {
    mkdirSync('.qwen/tmp/review-pr-7', { recursive: true });
    writeFileSync('.qwen/tmp/changed.json', '[]', 'utf8');
    const err = await runOrCapture([
      'deterministic',
      '.qwen/tmp/review-pr-7',
      '--changed-files',
      '.qwen/tmp/changed.json',
      '--out',
      '.qwen/tmp/det.json',
      '--pr',
      '7',
      '--owner-repo',
      'octo/repo',
    ]);
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/Missing fetch-pr report for PR #7/);
  });

  it('deterministic --pr refuses when --owner-repo is not supplied', async () => {
    mkdirSync('.qwen/tmp/review-pr-7', { recursive: true });
    writeFileSync('.qwen/tmp/changed.json', '[]', 'utf8');
    const err = await runOrCapture([
      'deterministic',
      '.qwen/tmp/review-pr-7',
      '--changed-files',
      '.qwen/tmp/changed.json',
      '--out',
      '.qwen/tmp/det.json',
      '--pr',
      '7',
    ]);
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/--owner-repo is required when --pr is set/);
  });

  it('deterministic --pr refuses when report.ownerRepo does not match', async () => {
    writeReport('7', { ownerRepo: 'attacker/repo' });
    mkdirSync('.qwen/tmp/review-pr-7', { recursive: true });
    writeFileSync('.qwen/tmp/changed.json', '[]', 'utf8');
    const err = await runOrCapture([
      'deterministic',
      '.qwen/tmp/review-pr-7',
      '--changed-files',
      '.qwen/tmp/changed.json',
      '--out',
      '.qwen/tmp/det.json',
      '--pr',
      '7',
      '--owner-repo',
      'octo/repo',
    ]);
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/bound to a different repo/);
  });

  it('pr-context refuses when report.ownerRepo does not match the command arg', async () => {
    writeReport('7', { ownerRepo: 'attacker/repo' });
    const err = await runOrCapture([
      'pr-context',
      '7',
      'octo/repo',
      '--out',
      '.qwen/tmp/ctx.md',
    ]);
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/bound to a different repo/);
  });

  it('presubmit refuses when report.ownerRepo does not match the command arg', async () => {
    writeReport('7', { ownerRepo: 'attacker/repo' });
    const err = await runOrCapture([
      'presubmit',
      '7',
      'b'.repeat(40),
      'octo/repo',
      '.qwen/tmp/presubmit.json',
    ]);
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/bound to a different repo/);
  });

  it('deterministic --pr refuses when worktree path does not match the report', async () => {
    writeReport('7', { worktreePath: '.qwen/tmp/review-pr-7' });
    mkdirSync('.qwen/tmp/some-other-dir', { recursive: true });
    writeFileSync('.qwen/tmp/changed.json', '[]', 'utf8');
    const err = await runOrCapture([
      'deterministic',
      '.qwen/tmp/some-other-dir',
      '--changed-files',
      '.qwen/tmp/changed.json',
      '--out',
      '.qwen/tmp/det.json',
      '--pr',
      '7',
      '--owner-repo',
      'octo/repo',
    ]);
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/Worktree path mismatch/);
  });

  it('load-rules --pr passes the gate when report + ownerRepo match', async () => {
    // Happy-path companion to the four `load-rules` failure tests above —
    // proves the gate actually opens for a valid session and we're not just
    // testing a door that's always locked. The git fixture below (init +
    // empty initial commit) lets `git show HEAD:.qwen/review-rules.md`
    // resolve cleanly to "file not present" rather than blowing up the
    // subcommand on the unrelated git layer.
    const { execSync } = await import('node:child_process');
    execSync('git init -q', { cwd });
    execSync(
      'git -c user.email=a@b.c -c user.name=test commit --allow-empty -m init -q',
      { cwd },
    );
    writeReport('7', { ownerRepo: 'octo/repo' });
    const err = await runOrCapture([
      'load-rules',
      'HEAD',
      '--out',
      '.qwen/tmp/rules.md',
      '--pr',
      '7',
      '--owner-repo',
      'octo/repo',
    ]);
    expect(err).toBeNull();
  });

  it('deterministic --pr passes the gate when report + worktree + ownerRepo all match', async () => {
    // Happy-path companion to the four `deterministic` failure tests.
    // No tsconfig.json / eslint config / etc. is present, so every tool
    // is skipped — the subcommand still completes successfully and
    // writes an empty findings report, proving the gate opened.
    writeReport('7', {
      ownerRepo: 'octo/repo',
      worktreePath: '.qwen/tmp/review-pr-7',
    });
    mkdirSync('.qwen/tmp/review-pr-7', { recursive: true });
    writeFileSync('.qwen/tmp/changed.json', '[]', 'utf8');
    const err = await runOrCapture([
      'deterministic',
      '.qwen/tmp/review-pr-7',
      '--changed-files',
      '.qwen/tmp/changed.json',
      '--out',
      '.qwen/tmp/det.json',
      '--pr',
      '7',
      '--owner-repo',
      'octo/repo',
    ]);
    expect(err).toBeNull();
  });
});
