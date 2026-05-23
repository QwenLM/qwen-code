/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  fetchReportPath,
  readFetchReport,
  requireFetchReport,
  requireFetchReportFor,
  ensureWorktreeMatches,
  type FetchReport,
} from './session.js';

const REPORT_FIXTURE: FetchReport = {
  prNumber: '42',
  ownerRepo: 'octo/repo',
  remote: 'origin',
  ref: 'qwen-review/pr-42',
  fetchedSha: 'a'.repeat(40),
  worktreePath: '.qwen/tmp/review-pr-42',
  baseRefName: 'main',
  headRefName: 'feature',
  isCrossRepository: false,
  diffStat: { files: 1, additions: 2, deletions: 3 },
  commentMode: false,
};

describe('review/lib/session', () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'qwen-review-session-'));
    process.chdir(cwd);
    mkdirSync('.qwen/tmp', { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('fetchReportPath returns the canonical .qwen/tmp path', () => {
    expect(fetchReportPath('42')).toBe(
      join('.qwen', 'tmp', 'qwen-review-pr-42-fetch.json'),
    );
    expect(fetchReportPath(7)).toBe(
      join('.qwen', 'tmp', 'qwen-review-pr-7-fetch.json'),
    );
  });

  it('readFetchReport returns null when the file is missing', () => {
    expect(readFetchReport('42')).toBeNull();
  });

  it('readFetchReport returns null when the file is malformed', () => {
    writeFileSync(fetchReportPath('42'), '{not json', 'utf8');
    expect(readFetchReport('42')).toBeNull();
  });

  it('readFetchReport returns the parsed report when present', () => {
    writeFileSync(
      fetchReportPath('42'),
      JSON.stringify(REPORT_FIXTURE),
      'utf8',
    );
    const got = readFetchReport('42');
    expect(got).toEqual(REPORT_FIXTURE);
  });

  it('requireFetchReport throws a recovery-pointer error when missing', () => {
    expect(() => requireFetchReport('42')).toThrow(/qwen review fetch-pr 42/);
    expect(() => requireFetchReport('42')).toThrow(/Do NOT use/);
  });

  it('requireFetchReport returns the parsed report when present', () => {
    writeFileSync(
      fetchReportPath('42'),
      JSON.stringify(REPORT_FIXTURE),
      'utf8',
    );
    const got = requireFetchReport('42');
    expect(got.prNumber).toBe('42');
    expect(got.commentMode).toBe(false);
  });

  it('ensureWorktreeMatches accepts identical paths regardless of ./ prefix', () => {
    const report = { ...REPORT_FIXTURE };
    expect(() =>
      ensureWorktreeMatches(report, report.worktreePath),
    ).not.toThrow();
    expect(() =>
      ensureWorktreeMatches(report, `./${report.worktreePath}`),
    ).not.toThrow();
    expect(() =>
      ensureWorktreeMatches(report, resolve(report.worktreePath)),
    ).not.toThrow();
  });

  it('ensureWorktreeMatches rejects mismatched paths', () => {
    const report = { ...REPORT_FIXTURE };
    expect(() => ensureWorktreeMatches(report, '/some/other/path')).toThrow(
      /Worktree path mismatch/,
    );
  });

  it('requireFetchReportFor accepts a report bound to the same owner/repo', () => {
    writeFileSync(
      fetchReportPath('42'),
      JSON.stringify(REPORT_FIXTURE),
      'utf8',
    );
    const got = requireFetchReportFor({
      prNumber: '42',
      ownerRepo: 'octo/repo',
    });
    expect(got.ownerRepo).toBe('octo/repo');
  });

  it('requireFetchReportFor rejects a report bound to a different repo', () => {
    // Stale report from reviewing PR #42 in repoA must not satisfy a /review
    // pointed at PR #42 in repoB — the LLM driver should be told to re-run
    // fetch-pr for the correct repo rather than silently reusing the
    // mis-targeted worktree.
    writeFileSync(
      fetchReportPath('42'),
      JSON.stringify({ ...REPORT_FIXTURE, ownerRepo: 'attacker/repo' }),
      'utf8',
    );
    expect(() =>
      requireFetchReportFor({ prNumber: '42', ownerRepo: 'octo/repo' }),
    ).toThrow(/bound to a different repo/);
    expect(() =>
      requireFetchReportFor({ prNumber: '42', ownerRepo: 'octo/repo' }),
    ).toThrow(/qwen review fetch-pr 42 octo\/repo/);
  });

  it('requireFetchReportFor surfaces the missing-report message when no report exists', () => {
    expect(() =>
      requireFetchReportFor({ prNumber: '42', ownerRepo: 'octo/repo' }),
    ).toThrow(/Missing fetch-pr report/);
  });

  it('requireFetchReportFor matches owner/repo case-insensitively', () => {
    // GitHub treats `Owner/Repo` and `owner/repo` as the same repository.
    // fetch-pr can preserve URL casing (`Owner/Repo`) while downstream
    // commands may receive canonical-cased values from `gh repo view`.
    writeFileSync(
      fetchReportPath('42'),
      JSON.stringify({ ...REPORT_FIXTURE, ownerRepo: 'Octo/Repo' }),
      'utf8',
    );
    expect(() =>
      requireFetchReportFor({ prNumber: '42', ownerRepo: 'octo/repo' }),
    ).not.toThrow();
    expect(() =>
      requireFetchReportFor({ prNumber: '42', ownerRepo: 'OCTO/REPO' }),
    ).not.toThrow();
  });

  it('requireFetchReport recovery message hints at preserving --remote / --comment', () => {
    // Weakly instruction-following models that hit this error mid-pipeline
    // need an explicit reminder; otherwise the literal recovery defaults
    // --remote to `origin` (breaking fork-via-upstream workflows) and drops
    // --comment (re-enabling interactive autofix mid-`--comment` review).
    expect(() => requireFetchReport('42')).toThrow(
      /Preserve any `--remote.*--comment.*flags from the original/s,
    );
  });
});
