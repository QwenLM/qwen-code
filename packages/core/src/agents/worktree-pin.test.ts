/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const stubs = vi.hoisted(() => ({
  make: () => ({
    checkGitAvailable: vi.fn(async () => ({
      available: true,
      error: undefined as string | undefined,
    })),
    isGitRepository: vi.fn(async () => true),
    getRepoTopLevel: vi.fn(async () => '/repo'),
    getMainWorktreePath: vi.fn(async () => '/repo'),
    isRegisteredLinkedWorktree: vi.fn(async () => true),
    getRegisteredWorktreeBranch: vi.fn(async () => ({ branch: 'pr-7' })),
  }),
  current: null as ReturnType<() => Record<string, unknown>> | null,
}));

vi.mock('../services/gitWorktreeService.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/gitWorktreeService.js')>();
  return {
    ...actual,
    GitWorktreeService: vi
      .fn()
      .mockImplementation(() => stubs.current as unknown),
  };
});

import { resolveExternalWorktreeDir } from './worktree-pin.js';
import type { Config } from '../config/config.js';

const config = { getTargetDir: () => '/repo' } as unknown as Config;

describe('resolveExternalWorktreeDir', () => {
  let svc: ReturnType<typeof stubs.make>;

  beforeEach(() => {
    svc = stubs.make();
    stubs.current = svc as unknown as Record<string, unknown>;
  });

  it('resolves a registered worktree inside the repository', async () => {
    const result = await resolveExternalWorktreeDir(
      config,
      '.qwen/tmp/review-pr-7',
    );
    expect(result).toEqual({
      path: '/repo/.qwen/tmp/review-pr-7',
      branch: 'pr-7',
      slug: 'review-pr-7',
      repoRoot: '/repo',
    });
  });

  it('accepts an in-repository worktree whose name starts with two dots', async () => {
    const result = await resolveExternalWorktreeDir(config, '..hidden-wt');
    expect(result).toMatchObject({ path: '/repo/..hidden-wt' });
  });

  // From inside a linked worktree `--show-toplevel` answers with the
  // worktree's own root. Containment must still anchor at the main working
  // tree, or a registered sibling worktree — the documented review-pipeline
  // setup — is spuriously refused.
  it('accepts a sibling worktree when the parent runs inside a linked worktree', async () => {
    svc.getRepoTopLevel.mockResolvedValue('/repo/.qwen/tmp/review-pr-1');
    const insideWorktree = {
      getTargetDir: () => '/repo/.qwen/tmp/review-pr-1',
    } as unknown as Config;
    const result = await resolveExternalWorktreeDir(
      insideWorktree,
      '../review-pr-1-base',
    );
    expect(result).toMatchObject({
      path: '/repo/.qwen/tmp/review-pr-1-base',
    });
  });

  // The containment comparison canonicalises both sides, so a symlink cannot
  // straddle the repository boundary. Real temp dirs (not stubs) force the
  // fs.realpath calls to actually run — with plain-string stubs both reject
  // and the .catch() fallbacks degrade the check to string comparison.
  it('refuses an in-repo symlink that canonicalizes outside the repository', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-pin-'));
    try {
      const repoDir = path.join(root, 'repo');
      const outsideTarget = path.join(root, 'outside', 'wt');
      await fs.mkdir(repoDir, { recursive: true });
      await fs.mkdir(outsideTarget, { recursive: true });
      await fs.symlink(outsideTarget, path.join(repoDir, 'link-wt'));
      svc.getMainWorktreePath.mockResolvedValue(repoDir);
      const localConfig = {
        getTargetDir: () => repoDir,
      } as unknown as Config;
      const result = await resolveExternalWorktreeDir(localConfig, 'link-wt');
      expect(result).toEqual({
        error: expect.stringContaining('resolves outside this repository'),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Pinning replaces the child's WorkspaceContext wholesale, so a path that
  // escapes the repository would silently move the boundary of every file,
  // shell and search tool the agent has.
  it('refuses a path outside the repository', async () => {
    const result = await resolveExternalWorktreeDir(config, '/elsewhere/tree');
    expect(result).toEqual({
      error: expect.stringContaining('resolves outside this repository'),
    });
  });

  // The authoritative gate: an unregistered directory is not isolation, it is
  // a directory that happens to exist.
  it('refuses a directory git does not know as a linked worktree', async () => {
    svc.isRegisteredLinkedWorktree.mockResolvedValue(false);
    const result = await resolveExternalWorktreeDir(config, 'plain-subdir');
    expect(result).toEqual({
      error: expect.stringContaining('is not a registered linked worktree'),
    });
  });

  it('names the missing git tooling rather than the directory', async () => {
    svc.checkGitAvailable.mockResolvedValue({
      available: false,
      error: 'git not found on PATH',
    });
    const result = await resolveExternalWorktreeDir(config, 'wt');
    expect(result).toEqual({ error: expect.stringContaining('git not found') });
  });

  // Without this preflight a non-repo parent produced the confusing "not a
  // registered worktree" message instead of naming the real cause.
  it('names a non-repository parent rather than the registration check', async () => {
    svc.isGitRepository.mockResolvedValue(false);
    const result = await resolveExternalWorktreeDir(config, 'wt');
    expect(result).toEqual({
      error: expect.stringContaining('/repo is not a git repository'),
    });
  });

  // A detached-HEAD worktree is legitimate and has no branch; the branch is a
  // label, never a gate.
  it('accepts a worktree with no branch label', async () => {
    svc.getRegisteredWorktreeBranch.mockResolvedValue(
      null as unknown as { branch: string },
    );
    const result = await resolveExternalWorktreeDir(config, 'wt');
    expect(result).toMatchObject({ path: '/repo/wt', branch: '' });
  });

  // The same resolver serves AgentTool's `working_dir` and a workflow's
  // `workingDir`; the caller says which name the reader will recognise.
  it('names the caller parameter in its errors', async () => {
    svc.isRegisteredLinkedWorktree.mockResolvedValue(false);
    const asTool = await resolveExternalWorktreeDir(config, 'wt');
    const asOpt = await resolveExternalWorktreeDir(config, 'wt', 'workingDir');
    expect((asTool as { error: string }).error).toMatch(/^working_dir "/);
    expect((asOpt as { error: string }).error).toMatch(/^workingDir "/);
  });
});
