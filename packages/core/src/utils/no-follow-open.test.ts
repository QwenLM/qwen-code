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

// Install a node:fs mock with O_NOFOLLOW removed so the module under test
// takes the lstat/open/fstat fallback path. The `default` member is
// LOAD-BEARING: no-follow-open.ts binds node:fs through a DEFAULT import,
// so a mock without it hands the helper the real O_NOFOLLOW and the
// fallback tests would silently pass on the native branch.
function mockNoFollowFs(
  build: (
    actual: typeof import('node:fs'),
  ) => Record<string, unknown> = () => ({}),
): void {
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
    mockNoFollowFs();
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

  it('refuses when the file identity changes between lstat and open', async () => {
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

    const closeSpy = vi.fn();
    mockNoFollowFs((actual) => ({
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

    const { openSyncNoFollow: openSyncFallback } = await import(
      './no-follow-open.js'
    );
    expect(() => openSyncFallback(filePath)).toThrow(
      expect.objectContaining({ code: 'ELOOP' }),
    );
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses when the device identity changes between lstat and open', async () => {
    // dev half of the dev/ino identity re-check: inode numbers are unique
    // only per-device, so a path swapped to a DIFFERENT device carrying a
    // colliding inode (attacker-controlled second mount, bind mount) must
    // still be refused. Mirrors the ino-mismatch variant with dev + 1.
    const dir = makeTempDir();
    const filePath = join(dir, 'data.txt');
    writeFileSync(filePath, 'payload');

    mockNoFollowFs((actual) => ({
      fstatSync: ((fd: number) => {
        const stats = actual.fstatSync(fd);
        return perturbedStats(stats, { dev: differentIdentity(stats.dev) });
      }) as typeof actual.fstatSync,
    }));

    const { openSyncNoFollow: openSyncFallback } = await import(
      './no-follow-open.js'
    );
    expect(() => openSyncFallback(filePath)).toThrow(
      expect.objectContaining({ code: 'ELOOP' }),
    );
  });

  it('refuses an identity that differs only above 2^53 (NTFS file index)', async () => {
    // NTFS reports a 64-bit file index and Node rounds it at the JS number
    // boundary, so these two ids are distinct as bigints yet collapse to the
    // SAME double. A number-backed comparison therefore waves the swap
    // through, and `{ bigint: true }` at the stat call sites is the only thing
    // that keeps the re-check exact on such a volume — this is the case that
    // makes that conversion observable; every other test here passes with it
    // removed, because Linux and macOS inodes are small.
    //
    // The offsets sit above 2^60, where the double spacing is 256: both round
    // to 2^60. Offsets of 1 and 2 above 2^53 would NOT collapse — the spacing
    // there is already 2, so 2^53+2 is exactly representable.
    //
    // The mock mirrors what Node really returns for each form of the call: a
    // BigIntStats carrying the exact id, or a Stats carrying the rounded one.
    // Asserting ELOOP (not EUNVERIFIABLE) pins the identity-mismatch branch:
    // core's hasVerifiableInode is `Number(ino) !== 0`, so an id this large is
    // still verifiable and still reaches the comparison.
    const dir = makeTempDir();
    const filePath = join(dir, 'data.txt');
    writeFileSync(filePath, 'payload');

    const PRE_OPEN_INO = 2n ** 60n + 1n;
    const SWAPPED_INO = 2n ** 60n + 2n;
    // Fixture guard: the whole case rests on these two collapsing to one
    // double while staying distinct as bigints. Without this, editing the
    // constants could silently degrade the test into a no-op.
    expect(PRE_OPEN_INO).not.toBe(SWAPPED_INO);
    expect(Number(PRE_OPEN_INO)).toBe(Number(SWAPPED_INO));

    const wantsBigint = (opts: unknown): boolean =>
      typeof opts === 'object' &&
      opts !== null &&
      (opts as { bigint?: boolean }).bigint === true;

    mockNoFollowFs((actual) => ({
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

    const { openSyncNoFollow: openSyncFallback } = await import(
      './no-follow-open.js'
    );
    expect(() => openSyncFallback(filePath)).toThrow(
      expect.objectContaining({ code: 'ELOOP' }),
    );
  });

  it('refuses when the file identity changes between lstat and open (async)', async () => {
    // Async counterpart of the sync identity-change test. The real opened
    // FileHandle's stat() cannot be intercepted through fs mocks, so the
    // pre-open lstat is doctored instead (same prototype trick, ino + 1)
    // and the identity re-check on the opened handle then mismatches it.
    // This pins the async try/assertSameIdentity/catch-and-close block in
    // openNoFollow: the symlink refusal tests all reject at the earlier
    // isSymbolicLink() check, so deleting that block keeps them green
    // while silently leaking the rejection-path handle unclosed.
    const dir = makeTempDir();
    const filePath = join(dir, 'data.txt');
    writeFileSync(filePath, 'payload');

    let closeSpy: ReturnType<typeof vi.spyOn> | undefined;

    mockNoFollowFs((actual) => ({
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

    const { openNoFollow: openFallback } = await import('./no-follow-open.js');
    const error = await openFallback(filePath).catch((e) => e);
    expect((error as NodeJS.ErrnoException).code).toBe('ELOOP');
    expect(closeSpy).toBeDefined();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  // The identity re-check must compare the opened fd against the PRE-OPEN
  // lstat snapshot. These tests perturb every lstat AFTER the first call,
  // so an implementation re-basing the comparison on a fresh post-open
  // lstat would see the perturbed stats, mismatch the fd, and throw ELOOP;
  // the correct single-lstat implementation opens and reads the payload.
  function mockNoFollowFsWithPerturbedSnapshot(): void {
    let lstatCalls = 0;
    mockNoFollowFs((actual) => {
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
    });
  }

  it('compares the opened fd against the PRE-OPEN lstat snapshot (sync)', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'data.txt');
    writeFileSync(filePath, 'snapshot-payload');

    mockNoFollowFsWithPerturbedSnapshot();

    const { openSyncNoFollow: openSyncFallback } = await import(
      './no-follow-open.js'
    );
    const fd = openSyncFallback(filePath);
    try {
      expect(readFileSync(fd, 'utf8')).toBe('snapshot-payload');
    } finally {
      closeSync(fd);
    }
  });

  it('compares the opened handle against the PRE-OPEN lstat snapshot (async)', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'data.txt');
    writeFileSync(filePath, 'snapshot-payload');

    mockNoFollowFsWithPerturbedSnapshot();

    const { openNoFollow: openFallback } = await import('./no-follow-open.js');
    const handle = await openFallback(filePath);
    try {
      const buffer = Buffer.alloc(16);
      const { bytesRead } = await handle.read(buffer, 0, 16, 0);
      expect(buffer.toString('utf8', 0, bytesRead)).toBe('snapshot-payload');
    } finally {
      await handle.close();
    }
  });

  it('refuses when the filesystem cannot prove identity (inode 0)', async () => {
    // FAT/exFAT/SMB volumes report ino 0 for every file; the comparison
    // would be vacuous there, so the helper fails closed (#8290 posture).
    const dir = makeTempDir();
    const filePath = join(dir, 'data.txt');
    writeFileSync(filePath, 'payload');

    const closeSpy = vi.fn();
    mockNoFollowFs((actual) => ({
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

    const { openSyncNoFollow: openSyncFallback } = await import(
      './no-follow-open.js'
    );
    // Distinct from a genuine symlink refusal: the code must NOT be
    // 'ELOOP', or consumers' ELOOP-specific handling (symlink-escape
    // flags, "not a regular file" errors, binary-row collapses) misfires
    // on legitimate files that merely live on an inode-0 volume.
    const error = (() => {
      try {
        openSyncFallback(filePath);
        return undefined;
      } catch (e) {
        return e as NodeJS.ErrnoException;
      }
    })();
    expect(error).toBeDefined();
    expect(error?.code).toBe(UNVERIFIABLE_IDENTITY_CODE);
    expect(error?.code).not.toBe('ELOOP');
    expect(isUnverifiableIdentityError(error)).toBe(true);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('still rejects with ELOOP when the rejection-path close fails (sync)', async () => {
    // The identity-mismatch close is best-effort: if closeSync itself
    // throws, the pinned ELOOP refusal must still surface, not the
    // close error. Deleting the swallow around fs.closeSync in
    // openSyncNoFollow makes this test fail with the close error.
    const dir = makeTempDir();
    const filePath = join(dir, 'data.txt');
    writeFileSync(filePath, 'payload');

    mockNoFollowFs((actual) => ({
      fstatSync: ((fd: number) => {
        const stats = actual.fstatSync(fd);
        return perturbedStats(stats, { ino: differentIdentity(stats.ino) });
      }) as typeof actual.fstatSync,
      closeSync: (() => {
        throw Object.assign(new Error('close failed'), { code: 'EBADF' });
      }) as typeof actual.closeSync,
    }));

    const { openSyncNoFollow: openSyncFallback } = await import(
      './no-follow-open.js'
    );
    expect(() => openSyncFallback(filePath)).toThrow(
      expect.objectContaining({ code: 'ELOOP' }),
    );
  });

  it('still rejects with EUNVERIFIABLE when the rejection-path close fails (inode 0)', async () => {
    // Same best-effort-close pin for the inode-0 refusal: a throwing
    // closeSync must not mask the UNVERIFIABLE_IDENTITY_CODE error.
    const dir = makeTempDir();
    const filePath = join(dir, 'data.txt');
    writeFileSync(filePath, 'payload');

    mockNoFollowFs((actual) => ({
      lstatSync: ((p: string) =>
        perturbedStats(actual.lstatSync(p), {
          ino: 0,
        })) as typeof actual.lstatSync,
      closeSync: (() => {
        throw Object.assign(new Error('close failed'), { code: 'EBADF' });
      }) as typeof actual.closeSync,
    }));

    const { openSyncNoFollow: openSyncFallback } = await import(
      './no-follow-open.js'
    );
    const error = (() => {
      try {
        openSyncFallback(filePath);
        return undefined;
      } catch (e) {
        return e as NodeJS.ErrnoException;
      }
    })();
    expect(error).toBeDefined();
    expect(error?.code).toBe(UNVERIFIABLE_IDENTITY_CODE);
  });

  it('still rejects with ELOOP when the rejection-path close fails (async)', async () => {
    // Async best-effort-close pin: a rejecting handle.close() must not
    // mask the pinned ELOOP refusal. Deleting the .catch(() => {}) on
    // handle.close() in openNoFollow makes this test fail with the
    // close rejection instead.
    const dir = makeTempDir();
    const filePath = join(dir, 'data.txt');
    writeFileSync(filePath, 'payload');

    mockNoFollowFs((actual) => ({
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

    const { openNoFollow: openFallback } = await import('./no-follow-open.js');
    const error = await openFallback(filePath).catch((e) => e);
    expect((error as NodeJS.ErrnoException).code).toBe('ELOOP');
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
