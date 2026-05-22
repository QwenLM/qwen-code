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
});
