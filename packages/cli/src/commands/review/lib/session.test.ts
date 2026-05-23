/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
    // Use the realpath'd form so macOS `/var → /private/var` symlink
    // doesn't make string equality on absolute paths fail spuriously.
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-review-session-')));
    process.chdir(cwd);
    mkdirSync('.qwen/tmp', { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('fetchReportPath returns an absolute path anchored at the project root', () => {
    // Anchored at `projectRoot()` (cwd or QWEN_PROJECT_DIR fallback chain)
    // so the canonical path is invariant under `process.chdir(...)` —
    // gated subcommands invoked from inside the PR worktree must still
    // resolve the same canonical fetch-pr report.
    expect(fetchReportPath('42')).toBe(
      join(cwd, '.qwen', 'tmp', 'qwen-review-pr-42-fetch.json'),
    );
    expect(fetchReportPath(7)).toBe(
      join(cwd, '.qwen', 'tmp', 'qwen-review-pr-7-fetch.json'),
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

  it('fetchReportPath resolves to the project-root canonical path regardless of cwd', () => {
    // The bug this guards against: a gated subcommand invoked from inside
    // the PR worktree (`cd .qwen/tmp/review-pr-N`) used to look for the
    // fetch report under `<worktree>/.qwen/tmp/...` instead of the main
    // project root, making the report invisible and the hard gate fail.
    // With paths.ts anchored at `projectRoot()` (via QWEN_PROJECT_DIR
    // env), the canonical path must resolve identically from both cwds.
    writeFileSync(
      fetchReportPath('42'),
      JSON.stringify(REPORT_FIXTURE),
      'utf8',
    );
    const fromProjectRoot = fetchReportPath('42');

    const worktreeCwd = join(cwd, '.qwen', 'tmp', 'review-pr-42');
    mkdirSync(worktreeCwd, { recursive: true });
    const prevEnv = process.env['QWEN_PROJECT_DIR'];
    process.env['QWEN_PROJECT_DIR'] = cwd;
    process.chdir(worktreeCwd);
    try {
      const fromWorktree = fetchReportPath('42');
      expect(fromWorktree).toBe(fromProjectRoot);
      // And the file must be findable from the worktree cwd too.
      const report = requireFetchReport('42');
      expect(report.prNumber).toBe('42');
    } finally {
      process.chdir(cwd);
      if (prevEnv === undefined) {
        delete process.env['QWEN_PROJECT_DIR'];
      } else {
        process.env['QWEN_PROJECT_DIR'] = prevEnv;
      }
    }
  });
});
