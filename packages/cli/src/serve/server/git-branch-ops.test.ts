/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  branchExists,
  checkoutRef,
  createBranch,
  deleteBranch,
  getHeadCommit,
  isDirtyTree,
} from './git-branch-ops.js';

// `git-branch-ops.ts` captures `promisify(execFile)` at module load, which
// `vi.mock('node:child_process')` cannot intercept, so these tests exercise the
// real git binary against a throwaway repository. This verifies the actual
// command strings and argument ordering (e.g. the `refs/heads/` prefix,
// `--untracked-files=no`, and `-D`) rather than a mocked stand-in.
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-git-branch-ops-test-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-qm', 'init');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('branchExists', () => {
  it('returns true for an existing branch', async () => {
    await expect(branchExists(repo, 'main')).resolves.toBe(true);
  });

  it('returns false for a missing branch', async () => {
    await expect(branchExists(repo, 'no-such-branch')).resolves.toBe(false);
  });

  it('matches only a local branch ref, not a tag of the same name', async () => {
    git(repo, 'tag', 'v1.0.0');
    await expect(branchExists(repo, 'v1.0.0')).resolves.toBe(false);
  });
});

describe('isDirtyTree', () => {
  it('returns false for a clean tree', async () => {
    await expect(isDirtyTree(repo)).resolves.toBe(false);
  });

  it('returns true when a tracked file is modified', async () => {
    fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n');
    await expect(isDirtyTree(repo)).resolves.toBe(true);
  });

  it('ignores untracked files', async () => {
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
    await expect(isDirtyTree(repo)).resolves.toBe(false);
  });
});

describe('getHeadCommit', () => {
  it('returns the current HEAD commit sha', async () => {
    const expected = git(repo, 'rev-parse', 'HEAD').trim();
    await expect(getHeadCommit(repo)).resolves.toBe(expected);
  });

  it('returns undefined outside a git repository', async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-not-repo-'));
    try {
      await expect(getHeadCommit(notARepo)).resolves.toBeUndefined();
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe('createBranch', () => {
  it('creates and checks out a new branch at the current commit', async () => {
    const before = git(repo, 'rev-parse', 'HEAD').trim();
    await createBranch(repo, 'feature');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      'feature',
    );
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(before);
    await expect(branchExists(repo, 'feature')).resolves.toBe(true);
  });

  it('rejects when the branch already exists', async () => {
    await expect(createBranch(repo, 'main')).rejects.toThrow();
  });
});

describe('checkoutRef', () => {
  it('switches to an existing branch', async () => {
    git(repo, 'branch', 'other');
    await checkoutRef(repo, 'other');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('other');
  });

  it('rejects for an unknown ref', async () => {
    await expect(checkoutRef(repo, 'no-such-ref')).rejects.toThrow();
  });
});

describe('deleteBranch', () => {
  it('deletes an existing branch', async () => {
    git(repo, 'branch', 'doomed');
    await deleteBranch(repo, 'doomed');
    await expect(branchExists(repo, 'doomed')).resolves.toBe(false);
  });

  it('force-deletes an unmerged branch', async () => {
    git(repo, 'checkout', '-qb', 'unmerged');
    fs.writeFileSync(path.join(repo, 'file.txt'), 'x\n');
    git(repo, 'add', 'file.txt');
    git(repo, 'commit', '-qm', 'unmerged commit');
    git(repo, 'checkout', '-q', 'main');
    await deleteBranch(repo, 'unmerged');
    await expect(branchExists(repo, 'unmerged')).resolves.toBe(false);
  });

  it('rejects when deleting the currently checked-out branch', async () => {
    await expect(deleteBranch(repo, 'main')).rejects.toThrow();
  });
});
