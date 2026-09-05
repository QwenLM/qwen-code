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
  readWorktreeSessionMarkerStrictSync,
  transferWorktreeSessionMarkerOwner,
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

    await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toMatchObject({
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
      await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toMatchObject(
        {
          state: 'valid',
          sessionId: 'owner',
        },
      );
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
      await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toMatchObject(
        {
          state: 'valid',
          sessionId: 'session-owner',
        },
      );
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

describe('readWorktreeSessionMarkerStrictSync', () => {
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

  it('matches the async reader on missing, valid, and invalid markers', async () => {
    const dir = await tempDir();
    expect(readWorktreeSessionMarkerStrictSync(dir)).toEqual({
      state: 'missing',
    });

    await createWorktreeSessionMarkerExclusive(dir, 'session-123');
    const syncResult = readWorktreeSessionMarkerStrictSync(dir);
    expect(syncResult).toMatchObject({
      state: 'valid',
      sessionId: 'session-123',
    });
    const asyncResult = await readWorktreeSessionMarkerStrict(dir);
    expect(syncResult).toEqual(asyncResult);

    const markerPath = path.join(dir, WORKTREE_SESSION_FILE);
    await fs.unlink(markerPath);
    const targetPath = path.join(dir, 'target');
    await fs.writeFile(targetPath, 'keep');
    await fs.symlink(targetPath, markerPath);
    expect(readWorktreeSessionMarkerStrictSync(dir)).toMatchObject({
      state: 'invalid',
    });

    await fs.unlink(markerPath);
    await fs.writeFile(markerPath, ' padded\n');
    expect(readWorktreeSessionMarkerStrictSync(dir)).toMatchObject({
      state: 'invalid',
      reason: 'invalid marker owner',
    });
  });
});

describe('transferWorktreeSessionMarkerOwner', () => {
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

  it('moves an owned marker to the replacement owner', async () => {
    const dir = await tempDir();
    await createWorktreeSessionMarkerExclusive(dir, 'session-old');

    await transferWorktreeSessionMarkerOwner(dir, 'session-old', 'session-new');

    await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toMatchObject({
      state: 'valid',
      sessionId: 'session-new',
    });
    // No transfer temp file lingers next to the marker.
    const siblings = await fs.readdir(dir);
    expect(siblings.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('recreates a missing marker exclusively through the hatch', async () => {
    const dir = await tempDir();

    await transferWorktreeSessionMarkerOwner(dir, null, 'session-new');

    await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toMatchObject({
      state: 'valid',
      sessionId: 'session-new',
    });
  });

  it('refuses the hatch when a marker already exists', async () => {
    const dir = await tempDir();
    await createWorktreeSessionMarkerExclusive(dir, 'session-old');

    await expect(
      transferWorktreeSessionMarkerOwner(dir, null, 'session-new'),
    ).rejects.toBeDefined();
    await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toMatchObject({
      state: 'valid',
      sessionId: 'session-old',
    });
  });

  it('aborts when the opening read does not name the expected owner', async () => {
    const dir = await tempDir();
    await createWorktreeSessionMarkerExclusive(dir, 'session-other');

    await expect(
      transferWorktreeSessionMarkerOwner(dir, 'session-old', 'session-new'),
    ).rejects.toThrow('does not match');
    await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toMatchObject({
      state: 'valid',
      sessionId: 'session-other',
    });
  });

  it('aborts when the marker expected by the transfer is missing', async () => {
    const dir = await tempDir();

    await expect(
      transferWorktreeSessionMarkerOwner(dir, 'session-old', 'session-new'),
    ).rejects.toThrow('does not match');
    await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toEqual({
      state: 'missing',
    });
  });

  it('aborts on an invalid marker without touching it', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, WORKTREE_SESSION_FILE), ' padded\n');

    await expect(
      transferWorktreeSessionMarkerOwner(dir, 'session-old', 'session-new'),
    ).rejects.toThrow('Worktree marker is invalid');
    await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toMatchObject({
      state: 'invalid',
    });
  });

  it('requires the new owner to differ from the expected owner', async () => {
    const dir = await tempDir();
    await createWorktreeSessionMarkerExclusive(dir, 'session-old');

    await expect(
      transferWorktreeSessionMarkerOwner(dir, 'session-old', 'session-old'),
    ).rejects.toThrow('distinct new owner');
    await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toMatchObject({
      state: 'valid',
      sessionId: 'session-old',
    });
  });

  it('leaves the marker excluded from git after a transfer', async () => {
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
    await createWorktreeSessionMarkerExclusive(worktree, 'session-old');

    await transferWorktreeSessionMarkerOwner(
      worktree,
      'session-old',
      'session-new',
    );

    const exclude = await fs.readFile(
      path.join(repo, '.git', 'info', 'exclude'),
      'utf8',
    );
    const rules = exclude.split(/\r?\n/);
    expect(rules).toContain(WORKTREE_SESSION_FILE);
    expect(rules).toContain(`${WORKTREE_SESSION_FILE}.*.tmp`);
    await execFileAsync('git', ['add', '-A'], { cwd: worktree });
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--cached', '--name-only'],
      { cwd: worktree },
    );
    expect(stdout).toBe('');
  });

  it.skipIf(process.geteuid === undefined)(
    'refuses a marker owned by a different uid without touching it',
    async () => {
      const dir = await tempDir();
      await createWorktreeSessionMarkerExclusive(dir, 'session-old');
      const markerPath = path.join(dir, WORKTREE_SESSION_FILE);
      const before = await fs.lstat(markerPath);

      // Stands in for a marker a different unix account owns — a daemon that
      // ran as root wrote it, or the worktree was restored from a backup
      // taken under another uid. The transfer must refuse it outright rather
      // than ride `atomicWriteFile`'s ownership-preserving in-place write.
      // A test cannot chown without privileges, so the foreign uid is
      // injected where the transfer observes it: the fstat behind the strict
      // reader's `handle.stat()`.
      const foreignUid = (process.geteuid?.() ?? 0) + 1000;
      const probe = await fs.open(markerPath, 'r');
      const prototype = Object.getPrototypeOf(probe) as Pick<
        typeof probe,
        'stat'
      >;
      const originalStat = prototype.stat;
      await probe.close();
      const statSpy = vi
        .spyOn(prototype, 'stat')
        .mockImplementation(async function (this: typeof probe) {
          const stats = await originalStat.call(this);
          stats.uid = foreignUid;
          return stats;
        });

      try {
        await expect(
          transferWorktreeSessionMarkerOwner(dir, 'session-old', 'session-new'),
        ).rejects.toThrow('Worktree marker is owned by a different uid');
        // The refusal precedes every write step: the marker keeps its bytes
        // and its inode, and no transfer temp file is staged beside it.
        await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe(
          'session-old',
        );
        expect((await fs.lstat(markerPath)).ino).toBe(before.ino);
        const siblings = await fs.readdir(dir);
        expect(siblings.filter((name) => name.endsWith('.tmp'))).toEqual([]);
      } finally {
        statSpy.mockRestore();
      }
    },
  );

  it('aborts the rename when the marker is swapped in the commit window', async () => {
    const dir = await tempDir();
    await createWorktreeSessionMarkerExclusive(dir, 'session-old');
    const markerPath = path.join(dir, WORKTREE_SESSION_FILE);

    // Stands in for a second writer that takes over the marker path after the
    // opening strict read decided the transfer was allowed. `fs.writeFile`'s
    // flush is the last step before `atomicWriteFile` commits the rename, so
    // hooking it lands the swap inside the window where the staged temp file
    // already exists and only the `assertCanCommit` re-check can stop it.
    const probe = await fs.open(markerPath, 'r');
    const prototype = Object.getPrototypeOf(probe) as Pick<
      typeof probe,
      'sync'
    >;
    const originalSync = prototype.sync;
    await probe.close();
    const syncSpy = vi
      .spyOn(prototype, 'sync')
      .mockImplementation(async function (this: typeof probe) {
        await originalSync.call(this);
        await fs.unlink(markerPath);
        await fs.writeFile(markerPath, 'session-raced');
      });

    try {
      await expect(
        transferWorktreeSessionMarkerOwner(dir, 'session-old', 'session-new'),
      ).rejects.toThrow('Worktree marker changed during ownership transfer');
      // The aborted rename leaves the raced marker — never the stale owner
      // this call was about to commit — and cleans up the staged temp file.
      await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe(
        'session-raced',
      );
      const siblings = await fs.readdir(dir);
      expect(siblings.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      syncSpy.mockRestore();
    }
  });
});
