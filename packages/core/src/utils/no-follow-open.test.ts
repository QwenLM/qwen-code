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
import type { BigIntStats, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isUnverifiableIdentityError,
  openNoFollow,
  openSyncNoFollow,
  UNVERIFIABLE_IDENTITY_CODE,
} from './no-follow-open.js';

let tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'no-follow-open-'));
  tmpDirs.push(dir);
  return dir;
}

/** Writes `content` to data.txt in a fresh temp dir; returns its path. */
function writeTempFile(content: string): string {
  const filePath = join(makeTempDir(), 'data.txt');
  writeFileSync(filePath, content);
  return filePath;
}

/** Plants link.txt -> target.txt ('secret'); returns the link path. */
function plantSymlink(): string {
  const dir = makeTempDir();
  const targetPath = join(dir, 'target.txt');
  const linkPath = join(dir, 'link.txt');
  writeFileSync(targetPath, 'secret');
  symlinkSync(targetPath, linkPath);
  return linkPath;
}

async function readAndClose(handle: FileHandle): Promise<string> {
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, 16, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function readSyncAndClose(fd: number): string {
  try {
    // readFileSync(fd) reads from offset 0 without closing the fd, so it
    // proves the fd is a live read descriptor for the right file.
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

const expectThrowsCode = (open: () => unknown, code: string) =>
  expect(open).toThrow(expect.objectContaining({ code }));

const rejectionCode = async (promise: Promise<unknown>) =>
  ((await promise.catch((e) => e)) as NodeJS.ErrnoException).code;

function thrownBy(open: () => unknown): NodeJS.ErrnoException | undefined {
  try {
    open();
    return undefined;
  } catch (e) {
    return e as NodeJS.ErrnoException;
  }
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

// Copy a Stats object with identity fields patched, keeping the prototype
// so isSymbolicLink()/isFile() keep working on the perturbed result.
function perturbedStats<T extends BigIntStats | Stats>(
  stats: T,
  patch: Partial<Pick<T, 'dev' | 'ino'>>,
): T {
  return Object.assign(
    Object.create(Object.getPrototypeOf(stats)),
    stats,
    patch,
  );
}

function differentIdentity<T extends bigint | number>(value: T): T {
  return (
    typeof value === 'bigint' ? (value === 1n ? 2n : 1n) : value === 1 ? 2 : 1
  ) as T;
}

type FsOverrides = (
  actual: typeof import('node:fs'),
) => Record<string, unknown>;

// Install a node:fs mock with O_NOFOLLOW removed so the module under test
// takes the lstat/open/fstat fallback path. The `default` member is
// LOAD-BEARING: no-follow-open.ts binds node:fs through a DEFAULT import,
// so a mock without it hands the helper the real O_NOFOLLOW and the
// fallback tests would silently pass on the native branch.
function mockNoFollowFs(build: FsOverrides = () => ({})): void {
  vi.resetModules();
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const modified = {
      ...actual,
      ...build(actual),
      constants: { ...actual.constants, O_NOFOLLOW: undefined },
    };
    return { ...modified, default: modified };
  });
}

describe('openNoFollow (native O_NOFOLLOW available)', () => {
  it('opens a regular file for reading', async () => {
    const filePath = writeTempFile('payload');
    expect(await readAndClose(await openNoFollow(filePath))).toBe('payload');
  });

  it('opens a regular file synchronously', () => {
    const filePath = writeTempFile('sync-payload');
    expect(readSyncAndClose(openSyncNoFollow(filePath))).toBe('sync-payload');
  });

  itNoSymlink('refuses a symlinked path (async)', async () => {
    const error = await openNoFollow(plantSymlink()).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).toBe('ELOOP');
  });

  itNoSymlink('refuses a symlinked path (sync)', () => {
    const linkPath = plantSymlink();
    expectThrowsCode(() => openSyncNoFollow(linkPath), 'ELOOP');
  });

  it('propagates ENOENT for missing paths', async () => {
    const dir = makeTempDir();
    expect(await rejectionCode(openNoFollow(join(dir, 'missing.txt')))).toBe(
      'ENOENT',
    );
    expectThrowsCode(
      () => openSyncNoFollow(join(dir, 'missing.txt')),
      'ENOENT',
    );
  });
});

describe('openNoFollow without O_NOFOLLOW (Windows flag set)', () => {
  async function importWithoutNoFollow(build?: FsOverrides) {
    mockNoFollowFs(build);
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
    const filePath = writeTempFile('fallback-payload');
    const { openFallback } = await importWithoutNoFollow();
    expect(await readAndClose(await openFallback(filePath))).toBe(
      'fallback-payload',
    );
  });

  itNoSymlink('refuses a symlinked path via the pre-open lstat', async () => {
    const linkPath = plantSymlink();
    const { openFallback, openSyncFallback } = await importWithoutNoFollow();
    expect(await rejectionCode(openFallback(linkPath))).toBe('ELOOP');
    expectThrowsCode(() => openSyncFallback(linkPath), 'ELOOP');
  });

  it('refuses when the file identity changes between lstat and open', async () => {
    // Simulates the TOCTOU race the fallback exists for: the path passes
    // the lstat check, then gets swapped before the identity re-check on
    // the opened fd. A real race is impractical to schedule in a unit
    // test, so the re-check is fed a mismatched identity directly through
    // the fs mock (the async FileHandle.stat() path bypasses fs.fstatSync
    // and cannot be intercepted this way; the identity predicate is shared
    // between the two variants).
    const filePath = writeTempFile('payload');
    const closeSpy = vi.fn();
    const { openSyncFallback } = await importWithoutNoFollow((actual) => ({
      fstatSync: ((fd: number) => {
        const stats = actual.fstatSync(fd);
        return perturbedStats(stats, { ino: differentIdentity(stats.ino) });
      }) as typeof actual.fstatSync,
      // Pin the rejection-path fd close: without it every sync fallback
      // refusal leaks the raw fd it opened for the identity re-check.
      closeSync: ((fd: number) => {
        closeSpy();
        return actual.closeSync(fd);
      }) as typeof actual.closeSync,
    }));

    expectThrowsCode(() => openSyncFallback(filePath), 'ELOOP');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses when the device identity changes between lstat and open', async () => {
    // dev half of the dev/ino identity re-check: inode numbers are unique
    // only per-device, so a path swapped to a DIFFERENT device carrying a
    // colliding inode (attacker-controlled second mount, bind mount) must
    // still be refused. Mirrors the ino-mismatch variant with dev + 1.
    const filePath = writeTempFile('payload');
    const { openSyncFallback } = await importWithoutNoFollow((actual) => ({
      fstatSync: ((fd: number) => {
        const stats = actual.fstatSync(fd);
        return perturbedStats(stats, { dev: differentIdentity(stats.dev) });
      }) as typeof actual.fstatSync,
    }));

    expectThrowsCode(() => openSyncFallback(filePath), 'ELOOP');
  });

  it('refuses an identity that differs only above 2^53 (NTFS file index)', async () => {
    // NTFS reports a 64-bit file index that Node rounds at the JS number
    // boundary, so these ids are distinct as bigints yet the SAME double. A
    // number-backed comparison waves the swap through; `{ bigint: true }` at
    // the stat call sites is the only thing keeping the re-check exact on
    // such a volume, and only this case observes it (Linux and macOS inodes
    // are small, so every other test passes with it removed).
    //
    // The offsets sit above 2^60, where double spacing is 256: both round to
    // 2^60. 2^53+1 and 2^53+2 would NOT collapse (spacing there is 2).
    //
    // The mock mirrors Node: a BigIntStats with the exact id for the bigint
    // call, a Stats with the rounded one otherwise. ELOOP (not EUNVERIFIABLE)
    // pins the mismatch branch: core's hasVerifiableInode is
    // `Number(ino) !== 0`, so this id is still verifiable and compared.
    const filePath = writeTempFile('payload');

    const PRE_OPEN_INO = 2n ** 60n + 1n;
    const SWAPPED_INO = 2n ** 60n + 2n;
    // Fixture guard: without it, editing the constants could silently turn
    // the case into a no-op (they must collapse as doubles, not as bigints).
    expect(PRE_OPEN_INO).not.toBe(SWAPPED_INO);
    expect(Number(PRE_OPEN_INO)).toBe(Number(SWAPPED_INO));

    const wantsBigint = (opts: unknown): boolean =>
      typeof opts === 'object' &&
      opts !== null &&
      (opts as { bigint?: boolean }).bigint === true;

    const { openSyncFallback } = await importWithoutNoFollow((actual) => ({
      lstatSync: ((...args: Parameters<typeof actual.lstatSync>) => {
        if (wantsBigint(args[1])) {
          return perturbedStats(actual.lstatSync(args[0], { bigint: true }), {
            ino: PRE_OPEN_INO,
          });
        }
        return perturbedStats(actual.lstatSync(args[0]), {
          ino: Number(PRE_OPEN_INO),
        });
      }) as typeof actual.lstatSync,
      fstatSync: ((...args: Parameters<typeof actual.fstatSync>) => {
        if (wantsBigint(args[1])) {
          return perturbedStats(actual.fstatSync(args[0], { bigint: true }), {
            ino: SWAPPED_INO,
          });
        }
        return perturbedStats(actual.fstatSync(args[0]), {
          ino: Number(SWAPPED_INO),
        });
      }) as typeof actual.fstatSync,
    }));

    expectThrowsCode(() => openSyncFallback(filePath), 'ELOOP');
  });

  it('refuses when the file identity changes between lstat and open (async)', async () => {
    // Async counterpart of the sync identity-change test. The opened
    // FileHandle's stat() cannot be intercepted through fs mocks, so the
    // pre-open lstat is doctored instead (same prototype trick, ino + 1).
    // This pins openNoFollow's try/assertSameIdentity/catch-and-close block:
    // the symlink tests all reject earlier at isSymbolicLink(), so deleting
    // that block keeps them green while leaking the rejection-path handle.
    const filePath = writeTempFile('payload');
    let closeSpy: ReturnType<typeof vi.spyOn> | undefined;
    const { openFallback } = await importWithoutNoFollow((actual) => ({
      promises: {
        ...actual.promises,
        lstat: (async (p: string) => {
          const stats = await actual.promises.lstat(p);
          return perturbedStats(stats, { ino: differentIdentity(stats.ino) });
        }) as typeof actual.promises.lstat,
        open: (async (...args: Parameters<typeof actual.promises.open>) => {
          const handle = await actual.promises.open(...args);
          closeSpy = vi.spyOn(handle, 'close');
          return handle;
        }) as typeof actual.promises.open,
      },
    }));

    expect(await rejectionCode(openFallback(filePath))).toBe('ELOOP');
    expect(closeSpy).toBeDefined();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  // The identity re-check must compare the opened fd against the PRE-OPEN
  // lstat snapshot. These tests perturb every lstat AFTER the first call,
  // so an implementation re-basing the comparison on a fresh post-open
  // lstat would see the perturbed stats, mismatch the fd, and throw ELOOP;
  // the correct single-lstat implementation opens and reads the payload.
  function perturbedSnapshotFs(): FsOverrides {
    let lstatCalls = 0;
    return (actual) => {
      const snapshotStats = <T extends BigIntStats | Stats>(stats: T): T => {
        lstatCalls += 1;
        return lstatCalls === 1
          ? stats
          : perturbedStats(stats, { ino: differentIdentity(stats.ino) });
      };
      return {
        lstatSync: ((...args: Parameters<typeof actual.lstatSync>) => {
          const stats = actual.lstatSync(...args);
          return stats ? snapshotStats(stats) : stats;
        }) as typeof actual.lstatSync,
        promises: {
          ...actual.promises,
          lstat: (async (...args: Parameters<typeof actual.promises.lstat>) =>
            snapshotStats(
              await actual.promises.lstat(...args),
            )) as typeof actual.promises.lstat,
        },
      };
    };
  }

  it('compares the opened fd against the PRE-OPEN lstat snapshot (sync)', async () => {
    const filePath = writeTempFile('snapshot-payload');
    const { openSyncFallback } = await importWithoutNoFollow(
      perturbedSnapshotFs(),
    );
    expect(readSyncAndClose(openSyncFallback(filePath))).toBe(
      'snapshot-payload',
    );
  });

  it('compares the opened handle against the PRE-OPEN lstat snapshot (async)', async () => {
    const filePath = writeTempFile('snapshot-payload');
    const { openFallback } = await importWithoutNoFollow(perturbedSnapshotFs());
    expect(await readAndClose(await openFallback(filePath))).toBe(
      'snapshot-payload',
    );
  });

  it('refuses when the filesystem cannot prove identity (inode 0)', async () => {
    // FAT/exFAT/SMB volumes report ino 0 for every file; the comparison
    // would be vacuous there, so the helper fails closed (#8290 posture).
    const filePath = writeTempFile('payload');
    const closeSpy = vi.fn();
    const { openSyncFallback } = await importWithoutNoFollow((actual) => ({
      lstatSync: ((p: string) =>
        perturbedStats(actual.lstatSync(p), {
          ino: 0,
        })) as typeof actual.lstatSync,
      // Same rejection-path fd close pin as the identity-change test.
      closeSync: ((fd: number) => {
        closeSpy();
        return actual.closeSync(fd);
      }) as typeof actual.closeSync,
    }));

    // Distinct from a genuine symlink refusal: the code must NOT be
    // 'ELOOP', or consumers' ELOOP-specific handling (symlink-escape
    // flags, "not a regular file" errors, binary-row collapses) misfires
    // on legitimate files that merely live on an inode-0 volume.
    const error = thrownBy(() => openSyncFallback(filePath));
    expect(error).toBeDefined();
    expect(error?.code).toBe(UNVERIFIABLE_IDENTITY_CODE);
    expect(error?.code).not.toBe('ELOOP');
    expect(isUnverifiableIdentityError(error)).toBe(true);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('still rejects with ELOOP when the rejection-path close fails (sync)', async () => {
    // The identity-mismatch close is best-effort: if closeSync itself
    // throws, the pinned ELOOP refusal must still surface, not the close
    // error (deleting the swallow around fs.closeSync fails this test).
    const filePath = writeTempFile('payload');
    const { openSyncFallback } = await importWithoutNoFollow((actual) => ({
      fstatSync: ((fd: number) => {
        const stats = actual.fstatSync(fd);
        return perturbedStats(stats, { ino: differentIdentity(stats.ino) });
      }) as typeof actual.fstatSync,
      closeSync: (() => {
        throw Object.assign(new Error('close failed'), { code: 'EBADF' });
      }) as typeof actual.closeSync,
    }));

    expectThrowsCode(() => openSyncFallback(filePath), 'ELOOP');
  });

  it('still rejects with EUNVERIFIABLE when the rejection-path close fails (inode 0)', async () => {
    // Same best-effort-close pin for the inode-0 refusal: a throwing
    // closeSync must not mask the UNVERIFIABLE_IDENTITY_CODE error.
    const filePath = writeTempFile('payload');
    const { openSyncFallback } = await importWithoutNoFollow((actual) => ({
      lstatSync: ((p: string) =>
        perturbedStats(actual.lstatSync(p), {
          ino: 0,
        })) as typeof actual.lstatSync,
      closeSync: (() => {
        throw Object.assign(new Error('close failed'), { code: 'EBADF' });
      }) as typeof actual.closeSync,
    }));

    const error = thrownBy(() => openSyncFallback(filePath));
    expect(error).toBeDefined();
    expect(error?.code).toBe(UNVERIFIABLE_IDENTITY_CODE);
  });

  it('still rejects with ELOOP when the rejection-path close fails (async)', async () => {
    // Async best-effort-close pin: a rejecting handle.close() must not mask
    // the pinned ELOOP refusal (deleting the .catch(() => {}) on
    // handle.close() in openNoFollow fails this test with the rejection).
    const filePath = writeTempFile('payload');
    const { openFallback } = await importWithoutNoFollow((actual) => ({
      promises: {
        ...actual.promises,
        lstat: (async (p: string) => {
          const stats = await actual.promises.lstat(p);
          return perturbedStats(stats, { ino: differentIdentity(stats.ino) });
        }) as typeof actual.promises.lstat,
        open: (async (...args: Parameters<typeof actual.promises.open>) => {
          const handle = await actual.promises.open(...args);
          vi.spyOn(handle, 'close').mockRejectedValue(
            Object.assign(new Error('close failed'), { code: 'EIO' }),
          );
          return handle;
        }) as typeof actual.promises.open,
      },
    }));

    expect(await rejectionCode(openFallback(filePath))).toBe('ELOOP');
  });

  it('propagates ENOENT for missing paths', async () => {
    const dir = makeTempDir();
    const { openFallback, openSyncFallback } = await importWithoutNoFollow();
    expect(await rejectionCode(openFallback(join(dir, 'missing.txt')))).toBe(
      'ENOENT',
    );
    expectThrowsCode(
      () => openSyncFallback(join(dir, 'missing.txt')),
      'ENOENT',
    );
  });
});
