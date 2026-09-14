/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorktreeSessionMarker,
  GitWorktreeService,
  readWorktreeSessionMarker,
  replaceWorktreeSessionMarker,
  writeWorktreeSessionMarker,
  worktreeBranchForSlug,
} from './gitWorktreeService.js';

let repo: string;

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-worktree-marker-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Qwen Test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'qwen@example.invalid'], {
    cwd: repo,
  });
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe('strict worktree session markers', () => {
  it('creates once and refuses to overwrite an existing owner', async () => {
    await createWorktreeSessionMarker(repo, 'session-a');

    expect(await readWorktreeSessionMarker(repo)).toBe('session-a');
    await expect(
      createWorktreeSessionMarker(repo, 'session-b'),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readWorktreeSessionMarker(repo)).toBe('session-a');
  });

  it('replaces only the expected regular-file owner', async () => {
    await createWorktreeSessionMarker(repo, 'session-a');

    await expect(
      replaceWorktreeSessionMarker(repo, 'session-other', 'session-b'),
    ).rejects.toThrow('owner changed');
    expect(await readWorktreeSessionMarker(repo)).toBe('session-a');

    await replaceWorktreeSessionMarker(repo, 'session-a', 'session-b');
    expect(await readWorktreeSessionMarker(repo)).toBe('session-b');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink marker',
    async () => {
      const target = path.join(repo, 'target');
      await fs.writeFile(target, 'session-a', 'utf8');
      await fs.symlink(target, path.join(repo, '.qwen-session'));

      await expect(
        createWorktreeSessionMarker(repo, 'session-b'),
      ).rejects.toBeDefined();
      await expect(
        replaceWorktreeSessionMarker(repo, 'session-a', 'session-b'),
      ).rejects.toBeDefined();
      await expect(
        writeWorktreeSessionMarker(repo, 'session-b'),
      ).rejects.toBeDefined();
      await expect(readWorktreeSessionMarker(repo)).resolves.toBeNull();
      expect(await fs.readFile(target, 'utf8')).toBe('session-a');
    },
  );

  it('refuses a hard-linked marker', async () => {
    const target = path.join(repo, 'target');
    await fs.writeFile(target, 'session-a', 'utf8');
    await fs.link(target, path.join(repo, '.qwen-session'));

    await expect(
      replaceWorktreeSessionMarker(repo, 'session-a', 'session-b'),
    ).rejects.toBeDefined();
    await expect(readWorktreeSessionMarker(repo)).resolves.toBeNull();
    expect(await fs.readFile(target, 'utf8')).toBe('session-a');
  });

  it('writes the exclude rule to the owning repo despite inherited git env', async () => {
    const decoy = await fs.mkdtemp(path.join(os.tmpdir(), 'git-env-decoy-'));
    execFileSync('git', ['init', '-q'], { cwd: decoy });
    const previousGitDir = process.env['GIT_DIR'];
    const previousGitWorkTree = process.env['GIT_WORK_TREE'];
    process.env['GIT_DIR'] = path.join(decoy, '.git');
    process.env['GIT_WORK_TREE'] = decoy;
    try {
      await createWorktreeSessionMarker(repo, 'session-a');
    } finally {
      if (previousGitDir === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = previousGitDir;
      if (previousGitWorkTree === undefined) {
        delete process.env['GIT_WORK_TREE'];
      } else {
        process.env['GIT_WORK_TREE'] = previousGitWorkTree;
      }
    }

    await expect(
      fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8'),
    ).resolves.toContain('/.qwen-session');
    await expect(
      fs.readFile(path.join(decoy, '.git', 'info', 'exclude'), 'utf8'),
    ).resolves.not.toContain('/.qwen-session');
    await fs.rm(decoy, { recursive: true, force: true });
  });
});

describe('prepared worktree cleanup', () => {
  async function createPreparedWorktree(slug: string, marker = true) {
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'base'], {
      cwd: repo,
    });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    const service = new GitWorktreeService(repo);
    const created = await service.createUserWorktree(slug, baseCommit);
    if (!created.success || !created.worktree) {
      throw new Error(created.error ?? 'worktree creation failed');
    }
    if (marker) {
      await createWorktreeSessionMarker(created.worktree.path, 'session-a');
    }
    return { baseCommit, service, worktreePath: created.worktree.path };
  }

  it('checkpoints worktree removal before deleting the branch', async () => {
    const { baseCommit, service, worktreePath } =
      await createPreparedWorktree('cleanup');
    const removedCheckpoint = vi.fn().mockResolvedValue(undefined);

    await expect(
      service.removePreparedUserWorktree(
        'cleanup',
        'session-a',
        baseCommit,
        removedCheckpoint,
      ),
    ).resolves.toEqual({ success: true });
    expect(removedCheckpoint).toHaveBeenCalledOnce();
    await expect(fs.stat(worktreePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      service.getPreparedUserWorktreeBranchTip('cleanup'),
    ).resolves.toBeNull();
  });

  it('removes the owning worktree despite an inherited GIT_DIR', async () => {
    const { baseCommit, service, worktreePath } =
      await createPreparedWorktree('isolated-env');
    const decoyParent = await fs.mkdtemp(
      path.join(os.tmpdir(), 'git-env-decoy-'),
    );
    const decoy = path.join(decoyParent, 'repo');
    execFileSync('git', ['clone', '-q', repo, decoy]);
    execFileSync('git', ['config', 'user.name', 'Qwen Test'], { cwd: decoy });
    execFileSync('git', ['config', 'user.email', 'qwen@example.invalid'], {
      cwd: decoy,
    });
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'decoy'], {
      cwd: decoy,
    });
    const previousGitDir = process.env['GIT_DIR'];
    const previousGitWorkTree = process.env['GIT_WORK_TREE'];
    process.env['GIT_DIR'] = path.join(decoy, '.git');
    delete process.env['GIT_WORK_TREE'];

    try {
      await expect(
        service.removePreparedUserWorktree(
          'isolated-env',
          'session-a',
          baseCommit,
        ),
      ).resolves.toEqual({ success: true });
      await expect(fs.stat(worktreePath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      if (previousGitDir === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = previousGitDir;
      if (previousGitWorkTree === undefined) {
        delete process.env['GIT_WORK_TREE'];
      } else {
        process.env['GIT_WORK_TREE'] = previousGitWorkTree;
      }
      await fs.rm(decoyParent, { recursive: true, force: true });
    }
  });

  it.each(['--skip-worktree', '--assume-unchanged'])(
    'preserves modified files hidden by %s',
    async (hiddenFlag) => {
      await fs.writeFile(path.join(repo, 'tracked.txt'), 'base', 'utf8');
      execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
      const { baseCommit, service, worktreePath } =
        await createPreparedWorktree('hidden-index');
      const trackedPath = path.join(worktreePath, 'tracked.txt');
      await fs.writeFile(trackedPath, 'user change', 'utf8');
      execFileSync('git', ['update-index', hiddenFlag, 'tracked.txt'], {
        cwd: worktreePath,
      });

      await expect(
        service.removePreparedUserWorktree(
          'hidden-index',
          'session-a',
          baseCommit,
        ),
      ).resolves.toEqual({
        success: false,
        error: 'Worktree contains changes',
      });
      await expect(fs.readFile(trackedPath, 'utf8')).resolves.toBe(
        'user change',
      );
    },
  );

  it('preserves a branch whose tip moves after worktree removal', async () => {
    const { baseCommit, service } = await createPreparedWorktree('moved');
    const tree = execFileSync('git', ['rev-parse', `${baseCommit}^{tree}`], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    let movedTip = '';

    const result = await service.removePreparedUserWorktree(
      'moved',
      'session-a',
      baseCommit,
      async () => {
        movedTip = execFileSync(
          'git',
          ['commit-tree', tree, '-p', baseCommit, '-m', 'moved'],
          { cwd: repo, encoding: 'utf8' },
        ).trim();
        execFileSync(
          'git',
          [
            'update-ref',
            `refs/heads/${worktreeBranchForSlug('moved')}`,
            movedTip,
          ],
          { cwd: repo },
        );
      },
    );

    expect(result).toEqual({ success: true, branchPreserved: true });
    await expect(
      service.getPreparedUserWorktreeBranchTip('moved'),
    ).resolves.toBe(movedTip);
  });

  it('refuses cleanup when an unexpected marker appears', async () => {
    const { baseCommit, service, worktreePath } =
      await createPreparedWorktree('claimed');

    await expect(
      service.removePreparedUserWorktree('claimed', null, baseCommit),
    ).resolves.toEqual({
      success: false,
      error: 'Worktree marker owner changed',
    });
    await expect(fs.stat(worktreePath)).resolves.toBeDefined();
  });

  it('removes an unchanged prepared worktree before marker creation', async () => {
    const { baseCommit, service, worktreePath } = await createPreparedWorktree(
      'unclaimed',
      false,
    );

    await expect(
      service.removePreparedUserWorktree('unclaimed', null, baseCommit),
    ).resolves.toEqual({ success: true });
    await expect(fs.stat(worktreePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves files inside an uninitialized tracked submodule', async () => {
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'base'], {
      cwd: repo,
    });
    const gitlinkCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    execFileSync(
      'git',
      [
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${gitlinkCommit},vendor/module`,
      ],
      { cwd: repo },
    );
    execFileSync('git', ['commit', '-qm', 'track submodule'], { cwd: repo });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    const service = new GitWorktreeService(repo);
    const created = await service.createUserWorktree(
      'submodule-data',
      baseCommit,
    );
    if (!created.success || !created.worktree) {
      throw new Error(created.error ?? 'worktree creation failed');
    }
    await createWorktreeSessionMarker(created.worktree.path, 'session-a');
    const submodulePath = path.join(created.worktree.path, 'vendor', 'module');
    await fs.mkdir(submodulePath, { recursive: true });
    await fs.writeFile(path.join(submodulePath, 'user.txt'), 'keep me', 'utf8');

    await expect(
      service.removePreparedUserWorktree(
        'submodule-data',
        'session-a',
        baseCommit,
      ),
    ).resolves.toMatchObject({ success: false });
    await expect(
      fs.readFile(path.join(submodulePath, 'user.txt'), 'utf8'),
    ).resolves.toBe('keep me');
  });

  it('refuses cleanup when the ownership marker is tracked', async () => {
    await fs.writeFile(path.join(repo, '.qwen-session'), 'session-a', 'utf8');
    execFileSync('git', ['add', '.qwen-session'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'tracked marker'], { cwd: repo });
    const { baseCommit, service, worktreePath } = await createPreparedWorktree(
      'tracked-marker',
      false,
    );

    await expect(
      service.removePreparedUserWorktree(
        'tracked-marker',
        'session-a',
        baseCommit,
      ),
    ).resolves.toEqual({
      success: false,
      error: 'Worktree marker is tracked',
    });
    await expect(fs.stat(worktreePath)).resolves.toBeDefined();
  });

  it('preserves a clean detached commit in the prepared worktree', async () => {
    const { baseCommit, service, worktreePath } =
      await createPreparedWorktree('detached-commit');
    execFileSync('git', ['checkout', '--detach', '-q'], { cwd: worktreePath });
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'detached work'], {
      cwd: worktreePath,
    });
    const detachedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8',
    }).trim();

    await expect(
      service.removePreparedUserWorktree(
        'detached-commit',
        'session-a',
        baseCommit,
      ),
    ).resolves.toEqual({
      success: false,
      error: 'Worktree checkout changed',
    });
    await expect(fs.stat(worktreePath)).resolves.toBeDefined();
    expect(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: worktreePath,
        encoding: 'utf8',
      }).trim(),
    ).toBe(detachedCommit);
  });

  it('refuses cleanup for a nested file named like the ownership marker', async () => {
    const { baseCommit, service, worktreePath } =
      await createPreparedWorktree('nested-marker');
    const nestedMarker = path.join(worktreePath, 'nested', '.qwen-session');
    await fs.mkdir(path.dirname(nestedMarker), { recursive: true });
    await fs.writeFile(nestedMarker, 'user-data', 'utf8');

    await expect(
      service.removePreparedUserWorktree(
        'nested-marker',
        'session-a',
        baseCommit,
      ),
    ).resolves.toEqual({
      success: false,
      error: 'Worktree contains changes',
    });
    await expect(fs.readFile(nestedMarker, 'utf8')).resolves.toBe('user-data');
  });

  it('refuses an ignored file created after the first clean check', async () => {
    const { baseCommit, service, worktreePath } =
      await createPreparedWorktree('late-ignored');
    const ignored = path.join(worktreePath, 'late.log');
    await fs.appendFile(path.join(repo, '.git', 'info', 'exclude'), '*.log\n');
    const readTip = service.getPreparedUserWorktreeBranchTip.bind(service);
    vi.spyOn(service, 'getPreparedUserWorktreeBranchTip').mockImplementation(
      async (slug) => {
        const tip = await readTip(slug);
        await fs.writeFile(ignored, 'user-data', 'utf8');
        return tip;
      },
    );

    await expect(
      service.removePreparedUserWorktree(
        'late-ignored',
        'session-a',
        baseCommit,
      ),
    ).resolves.toEqual({
      success: false,
      error: 'Worktree contains changes',
    });
    await expect(fs.readFile(ignored, 'utf8')).resolves.toBe('user-data');
  });

  it('refuses a marker owner changed after the first identity check', async () => {
    const { baseCommit, service, worktreePath } =
      await createPreparedWorktree('late-owner');
    const readTip = service.getPreparedUserWorktreeBranchTip.bind(service);
    vi.spyOn(service, 'getPreparedUserWorktreeBranchTip').mockImplementation(
      async (slug) => {
        const tip = await readTip(slug);
        await fs.writeFile(
          path.join(worktreePath, '.qwen-session'),
          'session-b',
          'utf8',
        );
        return tip;
      },
    );

    await expect(
      service.removePreparedUserWorktree('late-owner', 'session-a', baseCommit),
    ).resolves.toEqual({
      success: false,
      error: 'Worktree marker owner changed',
    });
    await expect(readWorktreeSessionMarker(worktreePath)).resolves.toBe(
      'session-b',
    );
  });
});
