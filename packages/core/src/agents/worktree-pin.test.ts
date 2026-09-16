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
    getMainWorktreePath: vi.fn(async (): Promise<string | null> => '/repo'),
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
      path: path.resolve('/repo', '.qwen/tmp/review-pr-7'),
      branch: 'pr-7',
      slug: 'review-pr-7',
      repoRoot: '/repo',
    });
  });

  // From inside a linked worktree `--show-toplevel` answers with the
  // worktree's own root; the resolver anchors at the main working tree so
  // the registry gate and labels stay scoped to the repository. A registered
  // sibling worktree is the documented review-pipeline setup.
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
      path: path.resolve('/repo/.qwen/tmp/review-pr-1', '../review-pr-1-base'),
    });
  });

  // The gate is the repository's worktree registry, not directory
  // containment: a registered linked worktree may live anywhere on disk
  // (leader-owned teammate worktrees rely on that).
  it('accepts a registered worktree outside the repository directory', async () => {
    const result = await resolveExternalWorktreeDir(config, '/elsewhere/wt');
    expect(result).toEqual({
      path: path.resolve('/elsewhere/wt'),
      branch: 'pr-7',
      slug: 'wt',
      repoRoot: '/repo',
    });
  });

  // The authoritative gate: an unregistered directory is not isolation, it is
  // a directory that happens to exist — inside OR outside the repository.
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
    expect(result).toMatchObject({
      path: path.resolve('/repo', 'wt'),
      branch: '',
    });
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

  // An ABSENT pin target under a symlinked root must reach the registration
  // gate, whose message names the absence — realpath fails for the target and
  // the single-resolution threading falls back to the lexical spelling.
  it('reports an absent target via the registration gate under a symlinked root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-pin-'));
    try {
      const realRoot = path.join(root, 'real');
      const repoDir = path.join(realRoot, 'repo');
      await fs.mkdir(repoDir, { recursive: true });
      const linkRoot = path.join(root, 'link');
      await fs.symlink(realRoot, linkRoot);
      svc.getMainWorktreePath.mockResolvedValue(path.join(linkRoot, 'repo'));
      svc.isRegisteredLinkedWorktree.mockResolvedValue(false);
      const localConfig = {
        getTargetDir: () => path.join(linkRoot, 'repo'),
      } as unknown as Config;

      const result = await resolveExternalWorktreeDir(localConfig, 'wt-x');
      expect(result).toEqual({
        error: expect.stringContaining('is not a registered linked worktree'),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Resolve once and thread the single resolution: the gate must see — and
  // the result must bind — the exact directory object that was validated,
  // not a lexical spelling a re-pointed symlink could swap out afterwards.
  it('threads the canonical resolution through the gates and the result', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-pin-'));
    try {
      const repoDir = path.join(root, 'repo');
      const wtIn = path.join(repoDir, 'wt-in');
      await fs.mkdir(wtIn, { recursive: true });
      await fs.symlink(wtIn, path.join(repoDir, 'link'));
      svc.getMainWorktreePath.mockResolvedValue(repoDir);
      const localConfig = {
        getTargetDir: () => repoDir,
      } as unknown as Config;

      const result = await resolveExternalWorktreeDir(localConfig, 'link');
      const canonical = await fs.realpath(wtIn);
      expect(result).toEqual({
        path: canonical,
        branch: 'pr-7',
        slug: path.basename(canonical),
        repoRoot: repoDir,
      });
      expect(svc.isRegisteredLinkedWorktree).toHaveBeenCalledWith(canonical);
      expect(svc.getRegisteredWorktreeBranch).toHaveBeenCalledWith(canonical);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
