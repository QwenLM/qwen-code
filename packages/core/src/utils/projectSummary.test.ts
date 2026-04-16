/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearWelcomeBackState,
  getProjectSummaryInfo,
  getWelcomeBackState,
  saveWelcomeBackRestartChoice,
} from './projectSummary.js';

describe('projectSummary', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-summary-'));
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('returns hasHistory false when the project summary file is missing', async () => {
    await expect(getProjectSummaryInfo()).resolves.toEqual({
      hasHistory: false,
    });
  });

  it('includes a summary fingerprint when a project summary exists', async () => {
    await fs.mkdir(path.join(testDir, '.qwen'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.qwen', 'PROJECT_SUMMARY.md'),
      [
        '## Overall Goal',
        'Ship the fix.',
        '',
        '## Current Plan',
        '1. [TODO] Reproduce the issue',
        '2. [IN PROGRESS] Implement the fix',
        '3. [DONE] Add tests',
        '',
        '---',
        '',
        '## Summary Metadata',
        '**Update time**: 2026-04-16T12:00:00.000Z',
      ].join('\n'),
      'utf-8',
    );

    const info = await getProjectSummaryInfo();

    expect(info.hasHistory).toBe(true);
    expect(info.summaryFingerprint).toMatch(/^\d+(\.\d+)?:\d+$/);
    expect(info.totalTasks).toBe(3);
    expect(info.inProgressCount).toBe(1);
    expect(info.pendingTasks).toEqual([
      '[TODO] Reproduce the issue',
      '[IN PROGRESS] Implement the fix',
    ]);
  });

  it('persists and clears the project-scoped welcome back restart choice', async () => {
    await saveWelcomeBackRestartChoice('summary-fingerprint');

    await expect(getWelcomeBackState()).resolves.toEqual({
      lastChoice: 'restart',
      summaryFingerprint: 'summary-fingerprint',
    });

    await clearWelcomeBackState();

    await expect(getWelcomeBackState()).resolves.toBeNull();
  });
});
