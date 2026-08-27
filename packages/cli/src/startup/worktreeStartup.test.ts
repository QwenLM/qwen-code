/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  setupStartupWorktree,
  discardCreatedStartupWorktree,
  buildStartupWorktreeNotice,
  persistStartupWorktreeSidecar,
} from './worktreeStartup.js';
import {
  readWorktreeSessionMarker,
  SessionService,
  Storage,
  writeRuntimeStatus,
  writeWorktreeSessionMarker,
} from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';

const exec = promisify(execFile);

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-startup-test-'));
  // macOS resolves /var → /private/var; pwd -P is the cheapest way to
  // normalise. Use realpath so subsequent string comparisons against
  // process.cwd() match exactly.
  const resolved = await fs.realpath(dir);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: resolved });
  await exec('git', ['config', 'user.email', 't@e.com'], { cwd: resolved });
  await exec('git', ['config', 'user.name', 't'], { cwd: resolved });
  await exec('git', ['config', 'commit.gpgsign', 'false'], { cwd: resolved });
  // Disable autocrlf so file contents committed and read back via the
  // test compare byte-for-byte on Windows runners (where the default
  // `core.autocrlf=true` checks files out with `\r\n`, breaking
  // assertions like `expect(content).toBe('foo\n')`).
  await exec('git', ['config', 'core.autocrlf', 'false'], { cwd: resolved });
  await exec('git', ['config', 'core.eol', 'lf'], { cwd: resolved });
  await fs.writeFile(path.join(resolved, 'README.md'), 'hello\n');
  await exec('git', ['add', 'README.md'], { cwd: resolved });
  await exec('git', ['commit', '-q', '-m', 'initial', '--no-verify'], {
    cwd: resolved,
  });
  return resolved;
}

async function getWorktreeGitDir(worktreePath: string): Promise<string> {
  const gitPath = path.join(worktreePath, '.git');
  const stat = await fs.lstat(gitPath);
  if (stat.isDirectory()) return gitPath;
  const raw = await fs.readFile(gitPath, 'utf8');
  const match = /^gitdir:\s*(.+)\s*$/i.exec(raw.trim());
  if (!match) throw new Error('.git file does not contain a gitdir pointer');
  return path.isAbsolute(match[1]!)
    ? match[1]!
    : path.resolve(worktreePath, match[1]!);
}

describe('setupStartupWorktree', () => {
  // Real git operations + fetch through a local bare remote can take
  // 10–15s on slower runners; bump the per-test ceiling so the PR-ref
  // happy-path test doesn't flake.
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  let prevCwd: string;
  let tempRepo: string | null = null;

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    // Restore cwd before cleanup so the test process can rm -rf the temp dir.
    process.chdir(prevCwd);
    if (tempRepo) {
      await fs.rm(tempRepo, { recursive: true, force: true });
      tempRepo = null;
    }
  });

  it('returns null when --worktree was not passed', async () => {
    const res = await setupStartupWorktree(undefined);
    expect(res).toBeNull();
  });

  it('rejects when the launch cwd is not a git repo', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-nongit-'));
    tempRepo = dir;
    process.chdir(await fs.realpath(dir));

    const res = await setupStartupWorktree('foo');
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(false);
    if (!res!.ok) {
      expect(res!.error).toMatch(/not a git repository/i);
    }
  });

  it('creates a worktree with an auto-generated slug for bare --worktree', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);

    const res = await setupStartupWorktree('');
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(true);
    if (res!.ok) {
      // adj-noun-XXXXXX pattern from GitWorktreeService.generateAutoSlug
      // (3 random bytes → 6 hex chars).
      expect(res!.context.slug).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{6}$/);
      expect(res!.context.branch).toBe(`worktree-${res!.context.slug}`);
      expect(res!.context.worktreePath).toContain(
        path.join('.qwen', 'worktrees', res!.context.slug),
      );
      expect(res!.context.repoRoot).toBe(tempRepo);
      expect(res!.context.originalBranch).toBe('main');
      // 40-char SHA
      expect(res!.context.originalHeadCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(res!.context.isPullRequest).toBe(false);

      // process.cwd() was switched into the worktree.
      expect(process.cwd()).toBe(res!.context.worktreePath);

      // The worktree directory exists on disk and is a real dir.
      const stat = await fs.stat(res!.context.worktreePath);
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it('creates a worktree with an explicit slug', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);

    const res = await setupStartupWorktree('my-feature');
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(true);
    if (res!.ok) {
      expect(res!.context.slug).toBe('my-feature');
      expect(res!.context.branch).toBe('worktree-my-feature');
      expect(res!.context.worktreePath).toBe(
        path.join(tempRepo, '.qwen', 'worktrees', 'my-feature'),
      );
    }
  });

  it('discards a newly-created worktree before an early startup exit', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);

    const res = await setupStartupWorktree('managed-resume');
    expect(res?.ok).toBe(true);
    if (!res?.ok) return;

    await expect(discardCreatedStartupWorktree(res.context)).resolves.toEqual(
      {},
    );

    expect(process.cwd()).toBe(tempRepo);
    await expect(fs.stat(res.context.worktreePath)).rejects.toThrow();
    const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], {
      cwd: tempRepo,
    });
    expect(stdout).not.toContain(res.context.worktreePath);
    const { stdout: branches } = await exec(
      'git',
      ['branch', '--list', res.context.branch],
      { cwd: tempRepo },
    );
    expect(branches.trim()).toBe('');
  });

  it('discards a clean worktree with a CLI-created configured symlink', async () => {
    tempRepo = await makeTempRepo();
    await fs.writeFile(path.join(tempRepo, '.env.local'), 'secret');
    process.chdir(tempRepo);

    const res = await setupStartupWorktree('managed-resume-symlink', {
      symlinkDirectories: ['.env.local'],
    });
    expect(res?.ok).toBe(true);
    if (!res?.ok) return;
    expect(res.context.createdSymlinkPaths).toEqual(['.env.local']);
    expect(
      (
        await fs.lstat(path.join(res.context.worktreePath, '.env.local'))
      ).isSymbolicLink(),
    ).toBe(true);

    await expect(discardCreatedStartupWorktree(res.context)).resolves.toEqual(
      {},
    );

    expect(process.cwd()).toBe(tempRepo);
    await expect(fs.stat(res.context.worktreePath)).rejects.toThrow();
  });

  it('does not treat configured symlink names as git pathspec patterns', async () => {
    tempRepo = await makeTempRepo();
    await fs.writeFile(path.join(tempRepo, '[secret]'), 'secret');
    process.chdir(tempRepo);

    const res = await setupStartupWorktree('managed-resume-literal-symlink', {
      symlinkDirectories: ['[secret]'],
    });
    expect(res?.ok).toBe(true);
    if (!res?.ok) return;
    await fs.writeFile(path.join(res.context.worktreePath, 's'), 'user work');

    await expect(discardCreatedStartupWorktree(res.context)).resolves.toEqual({
      preserved: expect.stringContaining('uncommitted changes'),
    });
    expect((await fs.stat(res.context.worktreePath)).isDirectory()).toBe(true);
  });

  it('preserves a configured symlink replaced with user work', async () => {
    tempRepo = await makeTempRepo();
    await fs.writeFile(path.join(tempRepo, '.env.local'), 'secret');
    process.chdir(tempRepo);

    const res = await setupStartupWorktree('managed-resume-replaced-symlink', {
      symlinkDirectories: ['.env.local'],
    });
    expect(res?.ok).toBe(true);
    if (!res?.ok) return;
    const worktreeEnv = path.join(res.context.worktreePath, '.env.local');
    await fs.unlink(worktreeEnv);
    await fs.writeFile(worktreeEnv, 'user work');

    await expect(discardCreatedStartupWorktree(res.context)).resolves.toEqual({
      preserved: expect.stringContaining('uncommitted changes'),
    });
    expect((await fs.stat(res.context.worktreePath)).isDirectory()).toBe(true);
  });

  it('preserves a newly-created worktree when another process may own work', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);

    const res = await setupStartupWorktree('managed-resume-in-use');
    expect(res?.ok).toBe(true);
    if (!res?.ok) return;
    const context = res.context;

    const pendingPath = path.join(context.worktreePath, 'pending.txt');
    await fs.writeFile(pendingPath, 'pending');
    await expect(discardCreatedStartupWorktree(context)).resolves.toEqual({
      preserved: expect.stringContaining('uncommitted changes'),
    });
    await fs.rm(pendingPath);

    await writeWorktreeSessionMarker(context.worktreePath, 'other-session');
    await expect(discardCreatedStartupWorktree(context)).resolves.toEqual({
      preserved: expect.stringContaining('owned by session other-session'),
    });
    await fs.rm(path.join(context.worktreePath, '.qwen-session'));

    await exec('git', ['tag', context.branch, context.originalHeadCommit], {
      cwd: tempRepo,
    });
    await fs.writeFile(
      path.join(context.worktreePath, 'committed.txt'),
      'work',
    );
    await exec('git', ['add', 'committed.txt'], { cwd: context.worktreePath });
    await exec('git', ['commit', '-m', 'work from another process'], {
      cwd: context.worktreePath,
    });
    const { stdout: branchHead } = await exec('git', ['rev-parse', 'HEAD'], {
      cwd: context.worktreePath,
    });
    await expect(discardCreatedStartupWorktree(context)).resolves.toEqual({
      preserved: expect.stringContaining(
        `branch ${context.branch} changed after startup`,
      ),
    });

    expect((await fs.stat(context.worktreePath)).isDirectory()).toBe(true);
    const { stdout: preservedBranchHead } = await exec(
      'git',
      ['rev-parse', `refs/heads/${context.branch}`],
      { cwd: tempRepo },
    );
    expect(preservedBranchHead.trim()).toBe(branchHead.trim());
  });

  it('keeps a reattached worktree on an early startup exit', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);

    const first = await setupStartupWorktree('managed-resume-existing');
    expect(first?.ok).toBe(true);
    if (!first?.ok) return;
    process.chdir(tempRepo);
    const second = await setupStartupWorktree('managed-resume-existing');
    expect(second?.ok).toBe(true);
    if (!second?.ok) return;
    expect(second.context.wasReattached).toBe(true);

    await expect(
      discardCreatedStartupWorktree(second.context),
    ).resolves.toEqual({});

    expect(process.cwd()).toBe(second.context.worktreePath);
    expect((await fs.stat(second.context.worktreePath)).isDirectory()).toBe(
      true,
    );
  });

  it('preserves a created worktree after another process re-attaches before marker write', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);

    const creator = await setupStartupWorktree('reattach-race');
    expect(creator?.ok).toBe(true);
    if (!creator?.ok) return;

    process.chdir(tempRepo);
    const reattacher = await setupStartupWorktree('reattach-race');
    expect(reattacher?.ok).toBe(true);
    if (!reattacher?.ok) return;
    expect(reattacher.context.wasReattached).toBe(true);

    await expect(
      discardCreatedStartupWorktree(creator.context),
    ).resolves.toEqual({
      preserved: expect.stringContaining('being re-attached by process'),
    });

    expect((await fs.stat(creator.context.worktreePath)).isDirectory()).toBe(
      true,
    );
    const { stdout: branches } = await exec(
      'git',
      ['branch', '--list', creator.context.branch],
      { cwd: tempRepo },
    );
    expect(branches.trim()).toContain(creator.context.branch);
  });

  it('preserves cleanup and refuses re-attach while the startup lock is held', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);

    const creator = await setupStartupWorktree('reattach-locked');
    expect(creator?.ok).toBe(true);
    if (!creator?.ok) return;

    const gitDir = await getWorktreeGitDir(creator.context.worktreePath);
    const lockPath = path.join(gitDir, 'qwen-startup-worktree.lock');
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid }));

    process.chdir(tempRepo);
    await expect(
      discardCreatedStartupWorktree(creator.context),
    ).resolves.toEqual({
      preserved: expect.stringContaining('being re-attached or cleaned up'),
    });

    const reattacher = await setupStartupWorktree('reattach-locked');
    expect(reattacher?.ok).toBe(false);
    if (reattacher && !reattacher.ok) {
      expect(reattacher.error).toContain('being cleaned up');
    }
    expect((await fs.stat(creator.context.worktreePath)).isDirectory()).toBe(
      true,
    );
  });

  it('treats EPERM from pid liveness checks as a live reattach process', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);

    const creator = await setupStartupWorktree('reattach-eperm');
    expect(creator?.ok).toBe(true);
    if (!creator?.ok) return;

    process.chdir(tempRepo);
    const reattacher = await setupStartupWorktree('reattach-eperm');
    expect(reattacher?.ok).toBe(true);
    if (!reattacher?.ok) return;
    expect(reattacher.context.wasReattached).toBe(true);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      _pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0) {
        const error = new Error(
          'operation not permitted',
        ) as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return true;
    }) as typeof process.kill);

    try {
      await expect(
        discardCreatedStartupWorktree(creator.context),
      ).resolves.toEqual({
        preserved: expect.stringContaining('being re-attached by process'),
      });
    } finally {
      killSpy.mockRestore();
    }

    expect((await fs.stat(creator.context.worktreePath)).isDirectory()).toBe(
      true,
    );
    const { stdout: branches } = await exec(
      'git',
      ['branch', '--list', creator.context.branch],
      { cwd: tempRepo },
    );
    expect(branches.trim()).toContain(creator.context.branch);
  });

  it('rejects invalid slug characters before any git operation', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);

    const res = await setupStartupWorktree('../escape');
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(false);
    if (!res!.ok) {
      expect(res!.error.toLowerCase()).toMatch(
        /letters|hyphens|invalid|may only/,
      );
    }

    // No worktree directory was created.
    const exists = await fs
      .stat(path.join(tempRepo, '.qwen', 'worktrees'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);

    // cwd was not changed.
    expect(process.cwd()).toBe(tempRepo);
  });

  it('rejects #N PR references when origin remote is missing', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);

    // Temp repo has no `origin` remote — fetch should fail-close with a
    // clear hint about adding origin.
    const res = await setupStartupWorktree('#123');
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(false);
    if (!res!.ok) {
      expect(res!.error).toContain('#123');
      expect(res!.error.toLowerCase()).toContain('origin');
    }

    // No worktree directory was created — fail-close means no side effect.
    const exists = await fs
      .stat(path.join(tempRepo, '.qwen', 'worktrees'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('rejects full GitHub PR URLs when origin remote is missing', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);

    const res = await setupStartupWorktree(
      'https://github.com/QwenLM/qwen-code/pull/4174',
    );
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(false);
    if (!res!.ok) {
      expect(res!.error).toContain('#4174');
      expect(res!.error.toLowerCase()).toContain('origin');
    }
  });

  it('creates a pr-<N> worktree from FETCH_HEAD when fetch succeeds (local fake remote)', async () => {
    // Set up a fake "origin" repo that exposes refs/pull/<N>/head — git
    // fetch only cares that the refspec exists on the remote, not that
    // the remote is github.com. update-ref lets us materialise the ref
    // locally without an actual GitHub round-trip.
    const upstream = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-wt-pr-upstream-'),
    );
    const upstreamResolved = await fs.realpath(upstream);
    await exec('git', ['init', '-q', '--bare', '-b', 'main'], {
      cwd: upstreamResolved,
    });

    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);
    await exec('git', ['remote', 'add', 'origin', upstreamResolved], {
      cwd: tempRepo,
    });
    await exec('git', ['push', '-q', 'origin', 'main'], { cwd: tempRepo });

    // Author a "PR commit" on a feature branch in the local repo, push
    // it to the upstream as refs/pull/42/head.
    await exec('git', ['checkout', '-q', '-b', 'pr-source'], { cwd: tempRepo });
    await fs.writeFile(path.join(tempRepo, 'pr-file.txt'), 'from PR 42\n');
    await exec('git', ['add', 'pr-file.txt'], { cwd: tempRepo });
    await exec('git', ['commit', '-q', '-m', 'PR 42 commit', '--no-verify'], {
      cwd: tempRepo,
    });
    await exec('git', ['push', '-q', 'origin', 'HEAD:refs/pull/42/head'], {
      cwd: tempRepo,
    });
    await exec('git', ['checkout', '-q', 'main'], { cwd: tempRepo });
    // Drop the local pr-source branch so the worktree branch isn't
    // confused with it.
    await exec('git', ['branch', '-q', '-D', 'pr-source'], { cwd: tempRepo });

    try {
      const res = await setupStartupWorktree('#42');
      expect(res).not.toBeNull();
      expect(res!.ok).toBe(true);
      if (res!.ok) {
        expect(res!.context.slug).toBe('pr-42');
        expect(res!.context.branch).toBe('worktree-pr-42');
        expect(res!.context.isPullRequest).toBe(true);
        expect(res!.context.worktreePath).toBe(
          path.join(tempRepo, '.qwen', 'worktrees', 'pr-42'),
        );

        // The PR file lives inside the worktree (proving FETCH_HEAD was
        // the base, not main).
        const prFile = await fs.readFile(
          path.join(res!.context.worktreePath, 'pr-file.txt'),
          'utf8',
        );
        expect(prFile).toBe('from PR 42\n');

        // Phase D-3 round 4: `originalHeadCommit` for PR worktrees must
        // be the resolved FETCH_HEAD SHA (the PR tip), NOT the parent
        // repo's HEAD. `WorktreeExitDialog`'s `rev-list <head>..HEAD`
        // later relies on this to count only the user's own commits in
        // the worktree, not the entire PR's history.
        expect(res!.context.originalHeadCommit).toMatch(/^[0-9a-f]{40}$/);
        // Resolve the PR ref directly and compare: must match.
        const expectedSha = (
          await exec('git', ['rev-parse', 'refs/pull/42/head'], {
            cwd: upstreamResolved,
          })
        ).stdout.trim();
        expect(res!.context.originalHeadCommit).toBe(expectedSha);
        // Sanity: must NOT equal the parent repo's main HEAD.
        const parentHead = (
          await exec('git', ['rev-parse', 'HEAD'], { cwd: tempRepo })
        ).stdout.trim();
        expect(res!.context.originalHeadCommit).not.toBe(parentHead);
      }
    } finally {
      // Restore cwd before rm so the upstream cleanup doesn't hit EBUSY.
      process.chdir(prevCwd);
      await fs.rm(upstreamResolved, { recursive: true, force: true });
    }
  });

  it('re-attaches to an existing worktree instead of erroring (Phase 6 G1 fix)', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);

    // First call creates the worktree.
    const first = await setupStartupWorktree('reattach-test');
    expect(first).not.toBeNull();
    expect(first!.ok).toBe(true);
    if (!first!.ok) return;
    expect(first!.context.wasReattached).toBe(false);

    // Restore cwd so the second call starts from launch cwd, mirroring
    // the real `qwen --resume <sid> --worktree foo` invocation flow.
    process.chdir(tempRepo);

    // Second call with the same slug now re-attaches, doesn't create.
    const second = await setupStartupWorktree('reattach-test');
    expect(second).not.toBeNull();
    expect(second!.ok).toBe(true);
    if (!second!.ok) return;
    expect(second!.context.wasReattached).toBe(true);
    expect(second!.context.slug).toBe('reattach-test');
    expect(second!.context.branch).toBe('worktree-reattach-test');
    expect(second!.context.worktreePath).toBe(first!.context.worktreePath);
    expect(process.cwd()).toBe(first!.context.worktreePath);
  });

  it('refuses to re-attach when an existing dir occupies the slot on a different branch', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);

    // Manually create a directory at the would-be worktree path that
    // is NOT a git worktree (just a plain dir with a file in it).
    const slotPath = path.join(
      tempRepo,
      '.qwen',
      'worktrees',
      'plain-dir-conflict',
    );
    await fs.mkdir(slotPath, { recursive: true });
    await fs.writeFile(path.join(slotPath, 'unexpected-content.txt'), 'oops');

    // setupStartupWorktree should NOT silently re-attach (the dir is
    // not a registered worktree). It also should NOT error — instead,
    // it falls through to createUserWorktree which fails with the
    // "already exists" branch.
    const res = await setupStartupWorktree('plain-dir-conflict');
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(false);
    if (!res!.ok) {
      // Either the re-attach branch error or createUserWorktree's
      // "already exists" message is acceptable — both prevent clobbering.
      expect(res!.error.toLowerCase()).toMatch(
        /already exists|registered git worktree|expected/,
      );
    }

    // Unexpected file survived.
    const survived = await fs.readFile(
      path.join(slotPath, 'unexpected-content.txt'),
      'utf8',
    );
    expect(survived).toBe('oops');
  });

  it('refuses nested worktree creation from inside .qwen/worktrees/', async () => {
    tempRepo = await makeTempRepo();
    // Pre-create a fake worktree path and chdir into it. We don't need a
    // real git worktree — the guard fires on path shape, not git state.
    const nestedPath = path.join(tempRepo, '.qwen', 'worktrees', 'outer');
    await fs.mkdir(nestedPath, { recursive: true });
    process.chdir(nestedPath);

    const res = await setupStartupWorktree('inner');
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(false);
    if (!res!.ok) {
      expect(res!.error.toLowerCase()).toMatch(
        /nested|inside another worktree/,
      );
    }
  });
});

describe('persistStartupWorktreeSidecar', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  let prevCwd: string;
  let tempRepo: string | null = null;
  let runtimeDir: string | null = null;

  beforeEach(async () => {
    prevCwd = process.cwd();
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-runtime-'));
    Storage.setRuntimeBaseDir(runtimeDir);
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    Storage.setRuntimeBaseDir(null);
    if (tempRepo) {
      await fs.rm(tempRepo, { recursive: true, force: true });
      tempRepo = null;
    }
    if (runtimeDir) {
      await fs.rm(runtimeDir, { recursive: true, force: true });
      runtimeDir = null;
    }
  });

  function makeConfig(targetDir: string, sessionId: string): Config {
    const sessionService = new SessionService(targetDir);
    return {
      getSessionId: () => sessionId,
      getSessionService: () => sessionService,
    } as unknown as Config;
  }

  it('adopts a stale marker when re-attaching to an inactive owner', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);

    const setup = await setupStartupWorktree('adopt-stale');
    expect(setup?.ok).toBe(true);
    if (!setup?.ok) return;
    await writeWorktreeSessionMarker(setup.context.worktreePath, 'old-session');
    await writeRuntimeStatus(
      new Storage(setup.context.worktreePath).getRuntimeStatusPath(
        'old-session',
      ),
      {
        sessionId: 'old-session',
        workDir: setup.context.worktreePath,
        pid: 2147483647,
      },
    );

    await persistStartupWorktreeSidecar(
      makeConfig(setup.context.worktreePath, 'new-session'),
      { ...setup.context, wasReattached: true },
    );

    expect(await readWorktreeSessionMarker(setup.context.worktreePath)).toBe(
      'new-session',
    );
  });

  it('keeps the marker when the owner runtime is still active', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);

    const setup = await setupStartupWorktree('owner-active');
    expect(setup?.ok).toBe(true);
    if (!setup?.ok) return;
    await writeWorktreeSessionMarker(setup.context.worktreePath, 'old-session');
    await writeRuntimeStatus(
      new Storage(setup.context.worktreePath).getRuntimeStatusPath(
        'old-session',
      ),
      {
        sessionId: 'old-session',
        workDir: setup.context.worktreePath,
        pid: process.pid,
      },
    );

    await persistStartupWorktreeSidecar(
      makeConfig(setup.context.worktreePath, 'new-session'),
      { ...setup.context, wasReattached: true },
    );

    expect(await readWorktreeSessionMarker(setup.context.worktreePath)).toBe(
      'old-session',
    );
  });

  it('finds an active owner under a repo-subdir relative runtime dir', async () => {
    tempRepo = await makeTempRepo();
    process.chdir(tempRepo);
    const packageDir = path.join(tempRepo, 'packages', 'app');
    await fs.mkdir(packageDir, { recursive: true });
    Storage.setRuntimeBaseDir('.qwen', packageDir);

    const setup = await setupStartupWorktree('owner-subdir-runtime');
    expect(setup?.ok).toBe(true);
    if (!setup?.ok) return;
    await writeWorktreeSessionMarker(setup.context.worktreePath, 'old-session');
    await writeRuntimeStatus(
      new Storage(packageDir).getRuntimeStatusPath('old-session'),
      {
        sessionId: 'old-session',
        workDir: packageDir,
        pid: process.pid,
      },
    );

    Storage.setRuntimeBaseDir('.qwen', setup.context.worktreePath);
    await persistStartupWorktreeSidecar(
      makeConfig(setup.context.worktreePath, 'new-session'),
      { ...setup.context, wasReattached: true },
    );

    expect(await readWorktreeSessionMarker(setup.context.worktreePath)).toBe(
      'old-session',
    );
  });
});

describe('buildStartupWorktreeNotice', () => {
  // Only the four fields the function actually consumes — the `Pick<>`
  // signature lets us keep the fixture minimal so adding new
  // StartupWorktreeContext fields doesn't churn this file.
  const baseContext = {
    worktreePath: '/repo/.qwen/worktrees/foo',
    slug: 'foo',
    branch: 'worktree-foo',
    wasReattached: false,
  };

  it('produces a single line for the no-override created case', () => {
    const notice = buildStartupWorktreeNotice(baseContext);
    expect(notice).toContain('[Startup]');
    expect(notice).toContain('Active worktree');
    expect(notice).toContain('"foo"');
    expect(notice).toContain('/repo/.qwen/worktrees/foo');
    expect(notice).toContain('worktree-foo');
    expect(notice).not.toContain('Re-attached');
    expect(notice).not.toContain('overrode');
  });

  it('uses "Re-attached" verb when wasReattached is true', () => {
    const notice = buildStartupWorktreeNotice({
      ...baseContext,
      wasReattached: true,
    });
    expect(notice).toContain('[Startup]');
    expect(notice).toContain('Re-attached to worktree');
    expect(notice).not.toContain('Active worktree');
  });

  it('appends an override hint when a previous worktree was overridden', () => {
    const notice = buildStartupWorktreeNotice(baseContext, {
      overrodeResumedWorktree: true,
      overriddenSlug: 'old-slug',
      sidecarPath: '/anywhere/sidecar.json',
    });
    expect(notice).toContain('[Startup]');
    expect(notice).toContain('overrode');
    expect(notice).toContain('"old-slug"');
    expect(notice).toContain('qwen --worktree old-slug');
  });

  it('does NOT append the override hint when overrodeResumedWorktree is false', () => {
    const notice = buildStartupWorktreeNotice(baseContext, {
      overrodeResumedWorktree: false,
      sidecarPath: '/anywhere/sidecar.json',
    });
    expect(notice).not.toContain('overrode');
  });
});
