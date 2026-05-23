/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Focused regression for the project-root anchoring added to cleanup.ts.
// SKILL.md Step 11 may invoke `qwen review cleanup pr-<n>` from inside the
// PR worktree itself; before the anchoring change, readdirSync would look
// at `<worktree>/.qwen/tmp/` (empty / absent) and silently no-op, leaving
// stale canonical fetch reports behind that the guard then treats as an
// active session marker for the rest of the CLI lifetime.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yargs from 'yargs';
import { cleanupCommand } from './cleanup.js';
import { _resetProjectRootCache } from './lib/paths.js';

async function runCleanup(target: string, cwdOverride?: string): Promise<void> {
  const originalCwd = process.cwd();
  if (cwdOverride) process.chdir(cwdOverride);
  _resetProjectRootCache();
  try {
    await yargs(['cleanup', target])
      .command(cleanupCommand)
      .demandCommand(1)
      .strict()
      .exitProcess(false)
      .parseAsync();
  } finally {
    process.chdir(originalCwd);
    _resetProjectRootCache();
  }
}

describe('cleanup', () => {
  let projectRoot: string;
  let originalCwd: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectRoot = mkdtempSync(join(tmpdir(), 'qwen-review-cleanup-'));
    savedEnv = process.env['QWEN_PROJECT_DIR'];
    process.env['QWEN_PROJECT_DIR'] = projectRoot;
    process.chdir(projectRoot);
    _resetProjectRootCache();
    mkdirSync(join(projectRoot, '.qwen', 'tmp'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
    if (savedEnv === undefined) {
      delete process.env['QWEN_PROJECT_DIR'];
    } else {
      process.env['QWEN_PROJECT_DIR'] = savedEnv;
    }
    _resetProjectRootCache();
  });

  it('removes canonical side files when invoked from the project root', async () => {
    const canonical = join(
      projectRoot,
      '.qwen',
      'tmp',
      'qwen-review-pr-7-fetch.json',
    );
    writeFileSync(canonical, '{}', 'utf8');
    await runCleanup('pr-7');
    expect(existsSync(canonical)).toBe(false);
  });

  it('removes canonical side files when invoked from inside the PR worktree', async () => {
    // Reviewer-flagged regression scenario: Step 11 cleanup from the
    // worktree cwd. With QWEN_PROJECT_DIR pointing at the project root,
    // cleanup's readdirSync must still scan `<project>/.qwen/tmp/`,
    // not `<worktree>/.qwen/tmp/`.
    const worktreeCwd = join(projectRoot, '.qwen', 'tmp', 'review-pr-7');
    mkdirSync(worktreeCwd, { recursive: true });
    const canonical = join(
      projectRoot,
      '.qwen',
      'tmp',
      'qwen-review-pr-7-fetch.json',
    );
    writeFileSync(canonical, '{}', 'utf8');
    // Also write an unrelated side file that should be cleaned alongside.
    const sideFile = join(
      projectRoot,
      '.qwen',
      'tmp',
      'qwen-review-pr-7-context.md',
    );
    writeFileSync(sideFile, '# ctx', 'utf8');
    await runCleanup('pr-7', worktreeCwd);
    expect(existsSync(canonical)).toBe(false);
    expect(existsSync(sideFile)).toBe(false);
  });

  it('removes the /review session marker', async () => {
    // The marker (written by registerSkillHooks at skill activation)
    // must be removed by cleanup so subsequent unrelated shell commands
    // in the same CLI session aren't denied by guard.sh's self-active
    // branch. Closes the lifecycle hole behind the sticky-guard report.
    const marker = join(
      projectRoot,
      '.qwen',
      'tmp',
      'qwen-review-active',
    );
    writeFileSync(marker, '', 'utf8');
    expect(existsSync(marker)).toBe(true);
    await runCleanup('pr-7');
    expect(existsSync(marker)).toBe(false);
  });

  it('does not touch other PRs’ side files', async () => {
    const ours = join(
      projectRoot,
      '.qwen',
      'tmp',
      'qwen-review-pr-7-fetch.json',
    );
    const theirs = join(
      projectRoot,
      '.qwen',
      'tmp',
      'qwen-review-pr-8-fetch.json',
    );
    writeFileSync(ours, '{}', 'utf8');
    writeFileSync(theirs, '{}', 'utf8');
    await runCleanup('pr-7');
    expect(existsSync(ours)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
  });
});
