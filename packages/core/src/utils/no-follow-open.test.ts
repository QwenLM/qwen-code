/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  closeSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openNoFollow, openSyncNoFollow } from './no-follow-open.js';

let tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'no-follow-open-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.restoreAllMocks();
});

// Symlink creation needs developer mode on Windows; skip there like the
// other symlink planting tests in this repo.
const itNoSymlink = process.platform === 'win32' ? it.skip : it;

describe('openNoFollow (native O_NOFOLLOW available)', () => {
  it('opens a regular file for reading', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'data.txt');
    writeFileSync(filePath, 'payload');

    const handle = await openNoFollow(filePath);
    try {
      const buffer = Buffer.alloc(7);
      await handle.read(buffer, 0, 7, 0);
      expect(buffer.toString('utf8')).toBe('payload');
    } finally {
      await handle.close();
    }
  });

  it('opens a regular file synchronously', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'data.txt');
    writeFileSync(filePath, 'sync-payload');

    const fd = openSyncNoFollow(filePath);
    try {
      // readFileSync(fd) reads from offset 0 without closing the fd, so it
      // proves the fd is a live read descriptor for the right file.
      expect(readFileSync(fd, 'utf8')).toBe('sync-payload');
    } finally {
      closeSync(fd);
    }
  });

  itNoSymlink('refuses a symlinked path (async)', async () => {
    const dir = makeTempDir();
    const targetPath = join(dir, 'target.txt');
    const linkPath = join(dir, 'link.txt');
    writeFileSync(targetPath, 'secret');
    symlinkSync(targetPath, linkPath);

    const error = await openNoFollow(linkPath).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).toBe('ELOOP');
  });

  itNoSymlink('refuses a symlinked path (sync)', () => {
    const dir = makeTempDir();
    const targetPath = join(dir, 'target.txt');
    const linkPath = join(dir, 'link.txt');
    writeFileSync(targetPath, 'secret');
    symlinkSync(targetPath, linkPath);

    expect(() => openSyncNoFollow(linkPath)).toThrow(
      expect.objectContaining({ code: 'ELOOP' }),
    );
  });

  it('propagates ENOENT for missing paths', async () => {
    const dir = makeTempDir();
    const error = await openNoFollow(join(dir, 'missing.txt')).catch((e) => e);
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(() => openSyncNoFollow(join(dir, 'missing.txt'))).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
  });
});

describe('openNoFollow without O_NOFOLLOW (Windows flag set)', () => {
  async function importWithoutNoFollow() {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      // The helper uses a DEFAULT import of node:fs, so the `default`
      // property must carry the stubbed constants too (`...actual` alone
      // would keep the real default binding with the real O_NOFOLLOW).
      const modified = {
        ...actual,
        constants: { ...actual.constants, O_NOFOLLOW: undefined },
      };
      return { ...modified, default: modified };
    });
    const mockedFs = await import('node:fs');
    const { openNoFollow: openFallback, openSyncNoFollow: openSyncFallback } =
      await import('./no-follow-open.js');
    return { mockedFs, openFallback, openSyncFallback };
  }

  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('opens a regular file through the lstat/open/fstat fallback', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'data.txt');
    writeFileSync(filePath, 'fallback-payload');

    const { openFallback } = await importWithoutNoFollow();
    const handle = await openFallback(filePath);
    try {
      const buffer = Buffer.alloc(16);
      const { bytesRead } = await handle.read(buffer, 0, 16, 0);
      expect(buffer.toString('utf8', 0, bytesRead)).toBe('fallback-payload');
    } finally {
      await handle.close();
    }
  });

  itNoSymlink('refuses a symlinked path via the pre-open lstat', async () => {
    const dir = makeTempDir();
    const targetPath = join(dir, 'target.txt');
    const linkPath = join(dir, 'link.txt');
    writeFileSync(targetPath, 'secret');
    symlinkSync(targetPath, linkPath);

    const { openFallback, openSyncFallback } = await importWithoutNoFollow();
    const error = await openFallback(linkPath).catch((e) => e);
    expect((error as NodeJS.ErrnoException).code).toBe('ELOOP');
    expect(() => openSyncFallback(linkPath)).toThrow(
      expect.objectContaining({ code: 'ELOOP' }),
    );
  });

  itNoSymlink(
    'refuses when the file identity changes between lstat and open',
    async () => {
      // Simulates the TOCTOU race the fallback exists for: the path passes
      // the lstat check, then gets swapped before the identity re-check on
      // the opened fd. A real race is impractical to schedule in a unit
      // test, so the re-check is fed a mismatched identity directly through
      // the fs mock (the async FileHandle.stat() path bypasses fs.fstatSync
      // and cannot be intercepted this way; the identity predicate is shared
      // between the two variants).
      const dir = makeTempDir();
      const filePath = join(dir, 'data.txt');
      writeFileSync(filePath, 'payload');

      vi.resetModules();
      vi.doMock('node:fs', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs')>();
        const modified = {
          ...actual,
          constants: { ...actual.constants, O_NOFOLLOW: undefined },
          fstatSync: ((fd: number) => {
            const stats = actual.fstatSync(fd);
            return Object.assign(
              Object.create(Object.getPrototypeOf(stats)),
              stats,
              { ino: stats.ino + 1 },
            );
          }) as typeof actual.fstatSync,
        };
        return { ...modified, default: modified };
      });

      try {
        const { openSyncNoFollow: openSyncFallback } = await import(
          './no-follow-open.js'
        );
        expect(() => openSyncFallback(filePath)).toThrow(
          expect.objectContaining({ code: 'ELOOP' }),
        );
      } finally {
        vi.doUnmock('node:fs');
        vi.resetModules();
      }
    },
  );

  it('refuses when the filesystem cannot prove identity (inode 0)', async () => {
    // FAT/exFAT/SMB volumes report ino 0 for every file; the comparison
    // would be vacuous there, so the helper fails closed (#8290 posture).
    const dir = makeTempDir();
    const filePath = join(dir, 'data.txt');
    writeFileSync(filePath, 'payload');

    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      const modified = {
        ...actual,
        constants: { ...actual.constants, O_NOFOLLOW: undefined },
        lstatSync: ((p: string) => {
          const stats = actual.lstatSync(p);
          return Object.assign(
            Object.create(Object.getPrototypeOf(stats)),
            stats,
            { ino: 0 },
          );
        }) as typeof actual.lstatSync,
      };
      return { ...modified, default: modified };
    });

    try {
      const { openSyncNoFollow: openSyncFallback } = await import(
        './no-follow-open.js'
      );
      expect(() => openSyncFallback(filePath)).toThrow(
        expect.objectContaining({ code: 'ELOOP' }),
      );
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('propagates ENOENT for missing paths', async () => {
    const dir = makeTempDir();
    const { openFallback, openSyncFallback } = await importWithoutNoFollow();
    const error = await openFallback(join(dir, 'missing.txt')).catch((e) => e);
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(() => openSyncFallback(join(dir, 'missing.txt'))).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
  });
});
