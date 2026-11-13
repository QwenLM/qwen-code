/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arePermissionBitsEnforced } from '../test-utils/permission-bits.js';
import { writeUserFile } from './write-user-file.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, access: vi.fn(actual.access) };
});

describe('writeUserFile', () => {
  let root: string;
  let first: string;
  let second: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'user-file-write-'));
    first = path.join(root, 'first');
    second = path.join(root, 'second');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates binary files and atomically replaces a single-link file', async () => {
    const bytes = Buffer.from([0, 0xff, 10]);
    await writeUserFile(first, bytes);
    expect(await fs.readFile(first)).toEqual(bytes);
    await fs.chmod(first, 0o600);
    const before = await fs.stat(first);

    await writeUserFile(first, 'replacement');

    expect(await fs.readFile(first, 'utf8')).toBe('replacement');
    const after = await fs.stat(first);
    expect(after.ino).not.toBe(before.ino);
    if (process.platform !== 'win32') expect(after.mode & 0o777).toBe(0o600);
    expect(await fs.readdir(root)).toEqual(['first']);
  });

  it('preserves hard links including an alias outside the workspace', async () => {
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    first = path.join(workspace, 'first');
    await fs.writeFile(first, 'shared');
    await fs.link(first, second);
    const before = await fs.stat(first);

    await writeUserFile(first, 'edited', { encoding: 'utf16le' });

    const bytes = Buffer.from('edited', 'utf16le');
    expect(await fs.readFile(first)).toEqual(bytes);
    expect(await fs.readFile(second)).toEqual(bytes);
    const after = await fs.stat(first);
    expect(after.ino).toBe(before.ino);
    expect(after.nlink).toBe(2);
    expect(await fs.readdir(workspace)).toEqual(['first']);
  });

  it.skipIf(process.platform === 'win32')(
    'follows a symlink without replacing it or splitting the hard links',
    async () => {
      await fs.writeFile(first, 'shared');
      await fs.link(first, second);
      const link = path.join(root, 'link');
      await fs.symlink('first', link);
      const before = await fs.stat(first);

      await writeUserFile(link, Buffer.from([0, 0xff]));

      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(second)).toEqual(Buffer.from([0, 0xff]));
      expect((await fs.stat(first)).ino).toBe(before.ino);
      expect((await fs.stat(first)).nlink).toBe(2);
    },
  );

  it.each([false, true])(
    'honors a commit veto before writing (hard links: %s)',
    async (hardLinked) => {
      await fs.writeFile(first, 'shared');
      if (hardLinked) await fs.link(first, second);
      const reason = new Error('generation closed');
      const assertCanCommit = vi.fn(() => {
        throw reason;
      });

      await expect(
        writeUserFile(first, 'edited', { assertCanCommit }),
      ).rejects.toBe(reason);

      expect(assertCanCommit).toHaveBeenCalledOnce();
      expect(await fs.readFile(first, 'utf8')).toBe('shared');
      if (hardLinked) expect(await fs.readFile(second, 'utf8')).toBe('shared');
      expect(await fs.readdir(root)).toEqual(
        hardLinked ? ['first', 'second'] : ['first'],
      );
    },
  );

  it.skipIf(!arePermissionBitsEnforced())(
    'refuses a read-only hard-linked file without changing either alias',
    async () => {
      await fs.writeFile(first, 'original');
      await fs.link(first, second);
      await fs.chmod(first, 0o444);
      try {
        await expect(writeUserFile(first, 'edited')).rejects.toMatchObject({
          code: 'EACCES',
        });
        expect(await fs.readFile(first, 'utf8')).toBe('original');
        expect(await fs.readFile(second, 'utf8')).toBe('original');
        expect((await fs.stat(first)).nlink).toBe(2);
        expect(await fs.readdir(root)).toEqual(['first', 'second']);
      } finally {
        await fs.chmod(first, 0o600);
      }
    },
  );

  it('normalizes Windows read-only access errors without writing', async () => {
    await fs.writeFile(first, 'original');
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.mocked(fs.access).mockRejectedValueOnce(
      Object.assign(new Error('read only'), { code: 'EPERM' }),
    );

    await expect(writeUserFile(first, 'edited')).rejects.toMatchObject({
      code: 'EACCES',
      path: first,
      syscall: 'access',
    });
    expect(await fs.readFile(first, 'utf8')).toBe('original');
    expect(await fs.readdir(root)).toEqual(['first']);
  });

  it('propagates access failures without replacing the file', async () => {
    await fs.writeFile(first, 'original');
    const error = Object.assign(new Error('I/O failure'), { code: 'EIO' });
    vi.mocked(fs.access).mockRejectedValueOnce(error);

    await expect(writeUserFile(first, 'edited')).rejects.toBe(error);
    expect(await fs.readFile(first, 'utf8')).toBe('original');
    expect(await fs.readdir(root)).toEqual(['first']);
  });
});
