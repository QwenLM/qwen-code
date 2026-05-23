/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yargs from 'yargs';
import { autofixGateCommand } from './autofix-gate.js';
import { fetchReportPath, type FetchReport } from './lib/session.js';

const BASE_REPORT: FetchReport = {
  prNumber: '99',
  ownerRepo: 'octo/repo',
  remote: 'origin',
  ref: 'qwen-review/pr-99',
  fetchedSha: 'a'.repeat(40),
  worktreePath: '.qwen/tmp/review-pr-99',
  baseRefName: 'main',
  headRefName: 'feature',
  isCrossRepository: false,
  diffStat: { files: 1, additions: 2, deletions: 3 },
  commentMode: false,
};

function writeReport(prNumber: string, overrides: Partial<FetchReport>): void {
  mkdirSync('.qwen/tmp', { recursive: true });
  writeFileSync(
    fetchReportPath(prNumber),
    JSON.stringify({ ...BASE_REPORT, ...overrides, prNumber }),
    'utf8',
  );
}

async function runGate(args: string[]): Promise<{ stdout: string }> {
  const captured: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
  try {
    await yargs(args)
      .command(autofixGateCommand)
      .demandCommand(1)
      .strict()
      .exitProcess(false)
      .parseAsync();
  } finally {
    spy.mockRestore();
  }
  return { stdout: captured.join('') };
}

describe('qwen review autofix-gate', () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'qwen-review-autofix-'));
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns skip when commentMode is true', async () => {
    writeReport('99', { commentMode: true });
    const { stdout } = await runGate([
      'autofix-gate',
      'pr-99',
      '--findings-count',
      '5',
    ]);
    const decision = JSON.parse(stdout.trim());
    expect(decision.decision).toBe('skip');
    expect(decision.reason).toMatch(/--comment/);
  });

  it('returns ask for a fork PR with a worktree (isCrossRepository true)', async () => {
    // `gh pr view --json isCrossRepository` returns true for any fork PR,
    // including the common "fork PR reviewed via configured upstream remote"
    // flow where fetch-pr succeeds and a real worktree exists. Real
    // lightweight mode (no matching remote, no worktree) writes no fetch
    // report, so it is already handled by the missing-report branch.
    writeReport('99', { commentMode: false, isCrossRepository: true });
    const { stdout } = await runGate([
      'autofix-gate',
      'pr-99',
      '--findings-count',
      '5',
    ]);
    const decision = JSON.parse(stdout.trim());
    expect(decision.decision).toBe('ask');
  });

  it('returns ask for a normal PR with findings', async () => {
    writeReport('99', { commentMode: false, isCrossRepository: false });
    const { stdout } = await runGate([
      'autofix-gate',
      'pr-99',
      '--findings-count',
      '3',
    ]);
    const decision = JSON.parse(stdout.trim());
    expect(decision.decision).toBe('ask');
    expect(decision.reason).toMatch(/3 auto-fixable/);
  });

  it('returns noop when there are zero findings', async () => {
    writeReport('99', { commentMode: false });
    const { stdout } = await runGate([
      'autofix-gate',
      'pr-99',
      '--findings-count',
      '0',
    ]);
    const decision = JSON.parse(stdout.trim());
    expect(decision.decision).toBe('noop');
  });

  it('returns ask for a local target with findings (no fetch report consulted)', async () => {
    const { stdout } = await runGate([
      'autofix-gate',
      'local',
      '--findings-count',
      '2',
    ]);
    const decision = JSON.parse(stdout.trim());
    expect(decision.decision).toBe('ask');
  });

  it('returns skip when fetch report is missing for a PR target', async () => {
    // No report written for pr-99 — refuse rather than prompting the user
    // for autofix on a worktree that may not exist.
    const { stdout } = await runGate([
      'autofix-gate',
      'pr-99',
      '--findings-count',
      '5',
    ]);
    const decision = JSON.parse(stdout.trim());
    expect(decision.decision).toBe('skip');
    expect(decision.reason).toMatch(/No fetch-pr report for PR #99/);
  });

  it('returns skip when --owner-repo does not match the report', async () => {
    writeReport('99', { ownerRepo: 'octo/repo' });
    const { stdout } = await runGate([
      'autofix-gate',
      'pr-99',
      '--findings-count',
      '5',
      '--owner-repo',
      'attacker/repo',
    ]);
    const decision = JSON.parse(stdout.trim());
    expect(decision.decision).toBe('skip');
    expect(decision.reason).toMatch(/bound to octo\/repo, not attacker\/repo/);
  });

  it('accepts --owner-repo that differs only in case from the report', async () => {
    writeReport('99', { ownerRepo: 'Octo/Repo' });
    const { stdout } = await runGate([
      'autofix-gate',
      'pr-99',
      '--findings-count',
      '3',
      '--owner-repo',
      'octo/repo',
    ]);
    const decision = JSON.parse(stdout.trim());
    expect(decision.decision).toBe('ask');
  });

  it('falls through to findings-count when legacy report omits commentMode', async () => {
    // Pre-existing fetch-pr reports on disk (written before this PR) lack
    // the `commentMode` field. The gate must read the absent field as
    // falsy and proceed to the findings-count check rather than crashing,
    // so users with stale `.qwen/tmp/qwen-review-pr-<n>-fetch.json` from a
    // previous run don't see a regression. Hand-write the JSON to bypass
    // `writeReport`, which always supplies `commentMode`.
    mkdirSync('.qwen/tmp', { recursive: true });
    writeFileSync(
      fetchReportPath('77'),
      JSON.stringify({
        prNumber: '77',
        ownerRepo: 'octo/repo',
        remote: 'origin',
        ref: 'qwen-review/pr-77',
        fetchedSha: 'b'.repeat(40),
        worktreePath: '.qwen/tmp/review-pr-77',
        baseRefName: 'main',
        headRefName: 'legacy',
        isCrossRepository: false,
        diffStat: { files: 1, additions: 0, deletions: 0 },
        // no `commentMode` key on purpose — simulates a stale report.
      }),
      'utf8',
    );
    const { stdout } = await runGate([
      'autofix-gate',
      'pr-77',
      '--findings-count',
      '3',
    ]);
    const decision = JSON.parse(stdout.trim());
    expect(decision.decision).toBe('ask');
  });
});
