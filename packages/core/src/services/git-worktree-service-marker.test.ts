/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { closeSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorktreeSessionMarkerExclusive,
  readWorktreeSessionMarkerStrict,
  readWorktreeSessionMarkerStrictSync,
  replaceWorktreeSessionMarker,
  transferWorktreeSessionMarkerOwner,
  WorktreeMarkerCommittedError,
  WorktreeSessionMarkerOwnerChangedError,
  WORKTREE_SESSION_FILE,
} from './gitWorktreeService.js';

const execFileAsync = promisify(execFile);
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

const expectOwner = (dir: string, sessionId: string) =>
  expect(readWorktreeSessionMarkerStrict(dir)).resolves.toMatchObject({
    state: 'valid',
    sessionId,
  });
const expectInvalid = (dir: string) =>
  expect(readWorktreeSessionMarkerStrict(dir)).resolves.toMatchObject({
    state: 'invalid',
  });
const expectMissing = (dir: string) =>
  expect(readWorktreeSessionMarkerStrict(dir)).resolves.toEqual({
    state: 'missing',
  });
const tmpFiles = async (dir: string) =>
  (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'));

/** The shared FileHandle prototype, reached through a throwaway handle. */
async function handleProto(file: string, flags = 'r'): Promise<fs.FileHandle> {
  const probe = await fs.open(file, flags);
  await probe.close();
  return Object.getPrototypeOf(probe) as fs.FileHandle;
}

/** Transfers the marker in `dir` from `expected` to `next`. */
const transfer = (
  dir: string,
  expected: string | null = 'session-old',
  next = 'session-new',
) => transferWorktreeSessionMarkerOwner(dir, expected, next);

const git = (cwd: string, ...args: string[]) =>
  execFileAsync('git', args, { cwd });

/** A repo with one commit plus a linked worktree on branch `task`. */
async function linkedWorktree(): Promise<{ repo: string; worktree: string }> {
  const dir = await tempDir();
  const repo = path.join(dir, 'repo');
  const worktree = path.join(dir, 'worktree');
  await fs.mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'tracked');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'initial', '--no-verify');
  await git(repo, 'worktree', 'add', '-q', '-b', 'task', worktree);
  return { repo, worktree };
}

const excludeRules = async (repo: string) =>
  (await fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).split(
    /\r?\n/,
  );

async function stagedAfterAddAll(worktree: string): Promise<string> {
  await git(worktree, 'add', '-A');
  return (await git(worktree, 'diff', '--cached', '--name-only')).stdout;
}

describe('daemon worktree session markers', () => {
  it('creates and strictly reads an exclusive owner marker', async () => {
    const dir = await tempDir();

    await createWorktreeSessionMarkerExclusive(dir, 'session-123');

    await expectOwner(dir, 'session-123');
  });

  it('keeps the marker ignored and unstaged in a linked worktree', async () => {
    const { repo, worktree } = await linkedWorktree();

    await createWorktreeSessionMarkerExclusive(worktree, 'session-123');
    expect(await excludeRules(repo)).toContain(`/${WORKTREE_SESSION_FILE}`);
    expect(await stagedAfterAddAll(worktree)).toBe('');
  });

  it('distinguishes a missing marker from invalid marker contents', async () => {
    const dir = await tempDir();
    await expectMissing(dir);

    await fs.writeFile(path.join(dir, WORKTREE_SESSION_FILE), ' owner\n');
    await expectInvalid(dir);
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
    await expectInvalid(dir);

    await fs.unlink(markerPath);
    await fs.writeFile(markerPath, 'x'.repeat(513));
    await expectInvalid(dir);
  });

  it('uses a bounded read for marker contents', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, WORKTREE_SESSION_FILE), 'owner');
    const prototype = await handleProto(path.join(dir, WORKTREE_SESSION_FILE));
    const readSpy = vi.spyOn(prototype, 'read');
    const readFileSpy = vi.spyOn(prototype, 'readFile');

    try {
      await expectOwner(dir, 'owner');
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
    const prototype = await handleProto(path.join(dir, WORKTREE_SESSION_FILE));
    const originalRead = prototype.read;
    const shortRead = function (
      this: fs.FileHandle,
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
      await expectOwner(dir, 'session-owner');
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
      await expectMissing(dir);
    }
  });

  it('leaves no file behind when the write fails after creation', async () => {
    const dir = await tempDir();
    const prototype = await handleProto(path.join(dir, 'probe'), 'w');
    const writeSpy = vi
      .spyOn(prototype, 'writeFile')
      .mockRejectedValue(new Error('injected write failure'));

    try {
      await expect(
        createWorktreeSessionMarkerExclusive(dir, 'session-123'),
      ).rejects.toThrow('injected write failure');
      // The failed create must not wedge the path with an EEXIST-raising
      // empty file: the strict reader sees a clean absence.
      await expectMissing(dir);
      expect(await tmpFiles(dir)).toEqual([]);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('never lets the marker path exist before its owner is fsynced', async () => {
    const dir = await tempDir();
    const markerPath = path.join(dir, WORKTREE_SESSION_FILE);
    const prototype = await handleProto(path.join(dir, 'probe'), 'w');
    const originalStat = prototype.stat;
    const originalWriteFile = prototype.writeFile;
    const originalSync = prototype.sync;

    // A crash between the marker path appearing and its owner landing is the
    // unrecoverable shape: a 0-byte or partial `.qwen-session` reads as
    // `invalid`, which no route repairs and every retried reset refuses.
    // Sample the path at every await the create yields on; each sample must
    // be absent or already hold the whole owner.
    const markerSizes: Array<number | 'absent'> = [];
    const sample = async (): Promise<void> => {
      try {
        markerSizes.push((await fs.lstat(markerPath)).size);
      } catch {
        markerSizes.push('absent');
      }
    };
    const statSpy = vi
      .spyOn(prototype, 'stat')
      .mockImplementation(async function (this: fs.FileHandle) {
        await sample();
        const stats = await originalStat.call(this);
        await sample();
        return stats;
      });
    const writeSpy = vi
      .spyOn(prototype, 'writeFile')
      .mockImplementation(async function (
        this: fs.FileHandle,
        ...args: Parameters<typeof originalWriteFile>
      ) {
        await sample();
        await originalWriteFile.apply(this, args);
        await sample();
      });
    const syncSpy = vi
      .spyOn(prototype, 'sync')
      .mockImplementation(async function (this: fs.FileHandle) {
        await sample();
        await originalSync.call(this);
        await sample();
      });

    try {
      await createWorktreeSessionMarkerExclusive(dir, 'session-123');
    } finally {
      statSpy.mockRestore();
      writeSpy.mockRestore();
      syncSpy.mockRestore();
    }

    expect(markerSizes.length).toBeGreaterThan(0);
    const ownerBytes = Buffer.byteLength('session-123');
    expect(
      markerSizes.filter((size) => size !== 'absent' && size !== ownerBytes),
    ).toEqual([]);
    await expectOwner(dir, 'session-123');
    expect(await tmpFiles(dir)).toEqual([]);
  });

  it('lets exactly one of two concurrent exclusive creates win', async () => {
    const dir = await tempDir();

    const results = await Promise.allSettled([
      createWorktreeSessionMarkerExclusive(dir, 'session-a'),
      createWorktreeSessionMarkerExclusive(dir, 'session-b'),
    ]);

    // The publishing link is the compare-and-swap: the loser must fail rather
    // than overwrite the owner the winner just committed.
    const winners = results.filter((result) => result.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    await expectOwner(
      dir,
      winners[0] === results[0] ? 'session-a' : 'session-b',
    );
    expect(await tmpFiles(dir)).toEqual([]);
  });

  it('does not remove a foreign file swapped in during the write window', async () => {
    const dir = await tempDir();
    const prototype = await handleProto(path.join(dir, 'probe'), 'w');
    const originalWriteFile = prototype.writeFile;
    // Another writer swaps the staged file while our write is in flight, so
    // the identity check fires with a foreign inode now occupying the path.
    let stagedPath = '';
    const writeSpy = vi
      .spyOn(prototype, 'writeFile')
      .mockImplementation(async function (this: fs.FileHandle) {
        stagedPath = path.join(dir, (await tmpFiles(dir))[0] as string);
        await fs.unlink(stagedPath);
        await fs.writeFile(stagedPath, 'foreign-owner');
        await originalWriteFile.call(this, 'session-123', 'utf8');
      });

    try {
      await expect(
        createWorktreeSessionMarkerExclusive(dir, 'session-123'),
      ).rejects.toThrow('Worktree session marker identity changed');
      // The cleanup must not delete the file the identity check proved is
      // not ours, and a create that never published leaves no marker behind.
      await expect(fs.readFile(stagedPath, 'utf8')).resolves.toBe(
        'foreign-owner',
      );
      await expectMissing(dir);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('reports a committed marker when the post-commit close rejects', async () => {
    const createDir = await tempDir();
    const transferDir = await tempDir();
    const prototype = await handleProto(path.join(createDir, 'probe'), 'w');
    const realStat = prototype.stat;
    let statCalls = 0;
    // A FileHandle's `close` is a per-instance property, so the seam is the
    // prototype's `stat`: the marker create stats exactly twice (pre-write
    // identity, post-write verification), and closing the raw fd under the
    // second one makes production's own post-commit `handle.close()` reject
    // with the marker already written, fsync'd and identity-verified.
    const statSpy = vi
      .spyOn(prototype, 'stat')
      .mockImplementation(async function (this: fs.FileHandle) {
        const stats = await realStat.call(this);
        statCalls += 1;
        if (statCalls % 2 === 0) closeSync(this.fd);
        return stats;
      });

    const settle = (run: () => Promise<unknown>): Promise<unknown> =>
      run().then(
        () => undefined,
        (error: unknown) => error,
      );
    let createError: unknown;
    let transferError: unknown;
    try {
      createError = await settle(() =>
        createWorktreeSessionMarkerExclusive(createDir, 'session-new'),
      );
      // The reset route's missing-marker hatch reaches the same tail through
      // the transfer primitive, so the classification must propagate.
      transferError = await settle(() => transfer(transferDir, null));
    } finally {
      statSpy.mockRestore();
    }

    expect(statCalls).toBe(4);
    for (const error of [createError, transferError]) {
      expect(error).toBeInstanceOf(WorktreeMarkerCommittedError);
      expect((error as WorktreeMarkerCommittedError).committedOwner).toBe(
        'session-new',
      );
      expect((error as Error).cause).toMatchObject({ code: 'EBADF' });
    }
    // The close rejection propagates with the marker intact: no cleanup of a
    // valid file, so a caller that compensates on failure would dismantle a
    // session the marker already names.
    for (const dir of [createDir, transferDir]) {
      await expectOwner(dir, 'session-new');
    }
  });
});

describe('readWorktreeSessionMarkerStrictSync', () => {
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
    expect(syncResult).toEqual(await readWorktreeSessionMarkerStrict(dir));

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
  async function ownedDir(owner: string): Promise<string> {
    const dir = await tempDir();
    await createWorktreeSessionMarkerExclusive(dir, owner);
    return dir;
  }

  it('moves an owned marker to the replacement owner', async () => {
    const dir = await ownedDir('session-old');

    await transfer(dir);

    await expectOwner(dir, 'session-new');
    // No transfer temp file lingers next to the marker.
    expect(await tmpFiles(dir)).toEqual([]);
  });

  it('recreates a missing marker exclusively through the hatch', async () => {
    const dir = await tempDir();

    await transfer(dir, null);

    await expectOwner(dir, 'session-new');
  });

  it('refuses the hatch when a marker already exists', async () => {
    const dir = await ownedDir('session-old');

    await expect(transfer(dir, null)).rejects.toBeDefined();
    await expectOwner(dir, 'session-old');
  });

  it('aborts when the opening read does not name the expected owner', async () => {
    const dir = await ownedDir('session-other');

    await expect(transfer(dir)).rejects.toBeInstanceOf(
      WorktreeSessionMarkerOwnerChangedError,
    );
    await expectOwner(dir, 'session-other');
  });

  it('aborts when the marker expected by the transfer is missing', async () => {
    const dir = await tempDir();

    await expect(transfer(dir)).rejects.toBeInstanceOf(
      WorktreeSessionMarkerOwnerChangedError,
    );
    await expectMissing(dir);
  });

  it('aborts on an invalid marker without touching it', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, WORKTREE_SESSION_FILE), ' padded\n');

    await expect(transfer(dir)).rejects.toThrow('Worktree marker is invalid');
    await expectInvalid(dir);
  });

  it('requires the new owner to differ from the expected owner', async () => {
    const dir = await ownedDir('session-old');

    await expect(transfer(dir, 'session-old', 'session-old')).rejects.toThrow(
      'distinct new owner',
    );
    await expectOwner(dir, 'session-old');
  });

  it('leaves the marker excluded from git after a transfer', async () => {
    const { repo, worktree } = await linkedWorktree();
    await createWorktreeSessionMarkerExclusive(worktree, 'session-old');

    await transfer(worktree);

    const rules = await excludeRules(repo);
    expect(rules).toContain(`/${WORKTREE_SESSION_FILE}`);
    expect(rules).toContain(`/${WORKTREE_SESSION_FILE}.*.tmp`);
    expect(await stagedAfterAddAll(worktree)).toBe('');
  });

  it.skipIf(process.geteuid === undefined)(
    'refuses a marker owned by a different uid without touching it',
    async () => {
      const dir = await ownedDir('session-old');
      const markerPath = path.join(dir, WORKTREE_SESSION_FILE);
      const before = await fs.lstat(markerPath);

      // Stands in for a marker a different unix account owns (a daemon that
      // ran as root wrote it, or a backup restored under another uid). The
      // transfer must refuse it outright rather than ride `atomicWriteFile`'s
      // ownership-preserving in-place write. A test cannot chown without
      // privileges, so the foreign uid is injected where the transfer
      // observes it: the fstat behind the strict reader's `handle.stat()`.
      const foreignUid = (process.geteuid?.() ?? 0) + 1000;
      const prototype = await handleProto(markerPath);
      const originalStat = prototype.stat;
      const statSpy = vi
        .spyOn(prototype, 'stat')
        .mockImplementation(async function (this: fs.FileHandle) {
          const stats = await originalStat.call(this);
          stats.uid = foreignUid;
          return stats;
        });

      try {
        await expect(transfer(dir)).rejects.toThrow(
          'Worktree marker is owned by a different uid',
        );
        // The refusal precedes every write step: the marker keeps its bytes
        // and its inode, and no transfer temp file is staged beside it.
        await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe(
          'session-old',
        );
        expect((await fs.lstat(markerPath)).ino).toBe(before.ino);
        expect(await tmpFiles(dir)).toEqual([]);
      } finally {
        statSpy.mockRestore();
      }
    },
  );

  it('types a replace race when the marker is swapped in the commit window', async () => {
    const dir = await ownedDir('session-old');
    const markerPath = path.join(dir, WORKTREE_SESSION_FILE);

    // Stands in for a second writer that takes over the marker path after the
    // opening strict read decided the transfer was allowed. `fs.writeFile`'s
    // flush is the last step before `atomicWriteFile` commits the rename, so
    // hooking it lands the swap inside the window where the staged temp file
    // already exists and only the `assertCanCommit` re-check can stop it.
    const prototype = await handleProto(markerPath);
    const originalSync = prototype.sync;
    const syncSpy = vi
      .spyOn(prototype, 'sync')
      .mockImplementation(async function (this: fs.FileHandle) {
        await originalSync.call(this);
        await fs.unlink(markerPath);
        await fs.writeFile(markerPath, 'session-raced');
      });

    try {
      await expect(
        replaceWorktreeSessionMarker(dir, 'session-old', 'session-new'),
      ).rejects.toBeInstanceOf(WorktreeSessionMarkerOwnerChangedError);
      // The aborted rename leaves the raced marker — never the stale owner
      // this call was about to commit — and cleans up the staged temp file.
      await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe(
        'session-raced',
      );
      expect(await tmpFiles(dir)).toEqual([]);
    } finally {
      syncSpy.mockRestore();
    }
  });
});
