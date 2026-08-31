/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorktreeSessionMarkerExclusive,
  readWorktreeSessionMarkerStrict,
  WORKTREE_SESSION_FILE,
} from './gitWorktreeService.js';

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

    await expect(readWorktreeSessionMarkerStrict(dir)).resolves.toEqual({
      state: 'valid',
      sessionId: 'owner',
    });
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(readSpy).toHaveBeenCalledWith(expect.any(Buffer), 0, 513, 0);
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
});
