/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorktreeSessionMarkerExclusive,
  readWorktreeSessionMarkerStrict,
  WORKTREE_SESSION_FILE,
} from './gitWorktreeService.js';

const execFileAsync = promisify(execFile);

describe('daemon worktree session markers', () => {
  const tempDirs: string[] = [];

  async function tempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-marker-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it('creates and strictly reads an exclusive owner marker', async () => {
    const dir = await tempDir();

    await createWorktreeSessionMarkerExclusive(dir, 'session-123');

    await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toEqual({
      state: 'valid',
      sessionId: 'session-123',
    });
  });

  it('keeps the marker ignored and unstaged in a linked worktree', async () => {
    const dir = await tempDir();
    const repo = path.join(dir, 'repo');
    const worktree = path.join(dir, 'worktree');
    await fs.mkdir(repo);
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repo,
    });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], {
      cwd: repo,
    });
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'tracked');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync(
      'git',
      ['commit', '-q', '-m', 'initial', '--no-verify'],
      {
        cwd: repo,
      },
    );
    await execFileAsync(
      'git',
      ['worktree', 'add', '-q', '-b', 'task', worktree],
      {
        cwd: repo,
      },
    );

    await createWorktreeSessionMarkerExclusive(worktree, 'session-123');
    const exclude = await fs.readFile(
      path.join(repo, '.git', 'info', 'exclude'),
      'utf8',
    );
    expect(exclude.split(/\r?\n/)).toContain(WORKTREE_SESSION_FILE);
    await execFileAsync('git', ['add', '-A'], { cwd: worktree });

    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--cached', '--name-only'],
      { cwd: worktree },
    );
    expect(stdout).toBe('');
  });

  it('distinguishes a missing marker from invalid marker contents', async () => {
    const dir = await tempDir();
    await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toEqual({
      state: 'missing',
    });

    await fs.writeFile(path.join(dir, WORKTREE_SESSION_FILE), ' owner\n');
    await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toMatchObject({
      state: 'invalid',
    });
  });

  it.each(['file', 'symlink', 'directory', 'hardlink'] as const)(
    'refuses an existing %s without modifying its target',
    async (kind) => {
      const dir = await tempDir();
      const markerPath = path.join(dir, WORKTREE_SESSION_FILE);
      const targetPath = path.join(dir, 'target');
      await fs.writeFile(targetPath, 'keep');
      if (kind === 'file') await fs.writeFile(markerPath, 'existing');
      if (kind === 'symlink') await fs.symlink(targetPath, markerPath);
      if (kind === 'directory') await fs.mkdir(markerPath);
      if (kind === 'hardlink') await fs.link(targetPath, markerPath);

      await expect(
        createWorktreeSessionMarkerExclusive(dir, 'new-owner'),
      ).rejects.toBeDefined();
      await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe('keep');
    },
  );

  it('rejects hard-linked and oversized markers during strict reads', async () => {
    const dir = await tempDir();
    const markerPath = path.join(dir, WORKTREE_SESSION_FILE);
    const targetPath = path.join(dir, 'target');
    await fs.writeFile(targetPath, 'owner');
    await fs.link(targetPath, markerPath);
    await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toMatchObject({
      state: 'invalid',
    });

    await fs.unlink(markerPath);
    await fs.writeFile(markerPath, 'x'.repeat(513));
    await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toMatchObject({
      state: 'invalid',
    });
  });

  it('uses a bounded read for marker contents', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, WORKTREE_SESSION_FILE), 'owner');
    const probe = await fs.open(path.join(dir, WORKTREE_SESSION_FILE), 'r');
    const prototype = Object.getPrototypeOf(probe) as Pick<
      typeof probe,
      'read' | 'readFile'
    >;
    const readSpy = vi.spyOn(prototype, 'read');
    const readFileSpy = vi.spyOn(prototype, 'readFile');
    await probe.close();

    try {
      await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toEqual({
        state: 'valid',
        sessionId: 'owner',
      });
      expect(readFileSpy).not.toHaveBeenCalled();
      expect(readSpy).toHaveBeenCalledWith(expect.any(Buffer), 0, 513, 0);
    } finally {
      readSpy.mockRestore();
      readFileSpy.mockRestore();
    }
  });

  it('continues reading a stable marker after a short read', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, WORKTREE_SESSION_FILE), 'session-owner');
    const probe = await fs.open(path.join(dir, WORKTREE_SESSION_FILE), 'r');
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    const originalRead = prototype.read;
    await probe.close();
    const shortRead = function (
      this: typeof probe,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) {
      return originalRead.call(this, {
        buffer,
        offset,
        length: Math.min(length, 5),
        position,
      });
    };
    const readSpy = vi
      .spyOn(prototype, 'read')
      .mockImplementation(shortRead as typeof prototype.read);

    try {
      await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toEqual({
        state: 'valid',
        sessionId: 'session-owner',
      });
      expect(readSpy.mock.calls.length).toBeGreaterThan(1);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('rejects empty, padded, and oversized owners before creating a marker', async () => {
    for (const owner of ['', ' padded', 'x'.repeat(513)]) {
      const dir = await tempDir();
      await expect(
        createWorktreeSessionMarkerExclusive(dir, owner),
      ).rejects.toThrow('Invalid worktree session marker owner');
      await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toEqual({
        state: 'missing',
      });
    }
  });

  it('leaves no file behind when the write fails after creation', async () => {
    const dir = await tempDir();
    const probe = await fs.open(path.join(dir, 'probe'), 'w');
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    await probe.close();
    const writeSpy = vi
      .spyOn(prototype, 'writeFile')
      .mockRejectedValue(new Error('injected write failure'));

    try {
      await expect(
        createWorktreeSessionMarkerExclusive(dir, 'session-123'),
      ).rejects.toThrow('injected write failure');
      // The failed create must not wedge the path with an EEXIST-raising
      // empty file: the strict reader sees a clean absence.
      await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toEqual({
        state: 'missing',
      });
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('does not remove a foreign file swapped in during the write window', async () => {
    const dir = await tempDir();
    const markerPath = path.join(dir, WORKTREE_SESSION_FILE);
    const probe = await fs.open(path.join(dir, 'probe'), 'w');
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    await probe.close();
    // Another writer swaps the marker path while our write is in flight, so
    // the identity check fires with a foreign inode now occupying the path.
    const writeSpy = vi
      .spyOn(prototype, 'writeFile')
      .mockImplementation(async () => {
        await fs.unlink(markerPath);
        await fs.writeFile(markerPath, 'foreign-owner');
      });

    try {
      await expect(
        createWorktreeSessionMarkerExclusive(dir, 'session-123'),
      ).rejects.toThrow('Worktree session marker identity changed');
      // The cleanup must not delete the file the identity check proved is
      // not ours.
      await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe(
        'foreign-owner',
      );
    } finally {
      writeSpy.mockRestore();
    }
  });
});
