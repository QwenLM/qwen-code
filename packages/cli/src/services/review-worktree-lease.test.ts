// Copyright 2026 Qwen Team
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupReviewWorktreeLeases,
  clearReviewWorktreeLease,
  createReviewWorktreeLease,
} from './review-worktree-lease.js';

const roots: string[] = [];

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'review-lease-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-qm', 'init']);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('review worktree leases', () => {
  it('protects a worktree created after the lease is registered', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });

    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'qwen-review/pr-1',
    ]);
    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(false);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('');
    expect(
      existsSync(join(root, '.qwen', 'tmp', 'qwen-review-lease-pr-1.json')),
    ).toBe(false);
  });

  it('falls back to removing an unregistered worktree directory', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'marker'), 'remove');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(false);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('');
    expect(
      existsSync(join(root, '.qwen', 'tmp', 'qwen-review-lease-pr-1.json')),
    ).toBe(false);
  });

  it('keeps the lease when fallback pruning fails', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(worktree, { recursive: true });
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });
    renameSync(join(root, '.git'), join(root, '.git-hidden'));

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(false);
    expect(
      existsSync(join(root, '.qwen', 'tmp', 'qwen-review-lease-pr-1.json')),
    ).toBe(true);
  });

  it('removes only worktrees owned by the completed session', () => {
    const root = createRepository();
    const owned = join(root, '.qwen', 'tmp', 'review-pr-1');
    const other = join(root, '.qwen', 'tmp', 'review-pr-2');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-2']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      owned,
      'qwen-review/pr-1',
    ]);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      other,
      'qwen-review/pr-2',
    ]);

    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: owned,
      branch: 'qwen-review/pr-1',
    });
    createReviewWorktreeLease({
      sessionId: 'session-b',
      promptId: 'prompt-parent',
      target: 'pr-2',
      repositoryRoot: root,
      worktreePath: other,
      branch: 'qwen-review/pr-2',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(owned)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('');
    expect(
      readFileSync(
        join(root, '.qwen', 'tmp', 'qwen-review-lease-pr-2.json'),
        'utf8',
      ),
    ).toContain('session-b');
  });

  it('does not let a child prompt clean up its parent review lease', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'qwen-review/pr-1',
    ]);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-child',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(true);
    expect(
      existsSync(join(root, '.qwen', 'tmp', 'qwen-review-lease-pr-1.json')),
    ).toBe(true);
  });

  it('does not remove a path outside the review temp directory', () => {
    const root = createRepository();
    const outside = join(root, 'keep-me');
    mkdirSync(outside);
    writeFileSync(join(outside, 'marker'), 'keep');
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: outside,
      branch: 'qwen-review/pr-1',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(readFileSync(join(outside, 'marker'), 'utf8')).toBe('keep');
    expect(
      existsSync(join(root, '.qwen', 'tmp', 'qwen-review-lease-pr-1.json')),
    ).toBe(true);
  });

  it('ignores a lease whose branch does not match its PR target', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', ['-C', root, 'branch', 'keep-me']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'keep-me',
    ]);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'keep-me',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(true);
    expect(
      existsSync(join(root, '.qwen', 'tmp', 'qwen-review-lease-pr-1.json')),
    ).toBe(true);
  });

  it('does not derive lease paths from invalid targets', () => {
    const root = createRepository();
    const marker = join(root, 'keep.json');
    writeFileSync(marker, 'keep');

    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: '../../../keep',
      repositoryRoot: root,
      worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
      branch: 'qwen-review/pr-1',
    });
    clearReviewWorktreeLease(root, '../../../keep');

    expect(readFileSync(marker, 'utf8')).toBe('keep');
    expect(existsSync(join(root, '.qwen', 'tmp'))).toBe(false);
  });

  it('lets explicit review cleanup disarm the finalizer', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'qwen-review/pr-1',
    ]);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });

    clearReviewWorktreeLease(root, 'pr-1');
    expect(
      existsSync(join(root, '.qwen', 'tmp', 'qwen-review-lease-pr-1.json')),
    ).toBe(false);
    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(true);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toContain('qwen-review/pr-1');
  });
});
