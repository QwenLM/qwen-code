/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  atomicWriteFile,
  atomicWriteFileSync,
  atomicWriteJSON,
  renameWithRetry,
  renameWithRetrySync,
} from './atomicFileWrite.js';

type AsyncSeams = NonNullable<Parameters<typeof atomicWriteFile>[3]>;
type SyncSeams = NonNullable<Parameters<typeof atomicWriteFileSync>[3]>;
type WriteOptions = Parameters<typeof atomicWriteFile>[2];

const itPosix = it.skipIf(process.platform === 'win32');
// Ownership tests fake another user through process.geteuid.
const itOtherUser = it.skipIf(
  // eslint-disable-next-line vitest/valid-title -- a skip condition, not a title
  process.platform === 'win32' || typeof process.geteuid !== 'function',
);

/** A Node-style fs error: an Error carrying `code`. */
function errno(code: string, message = code): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(message);
  e.code = code;
  return e;
}
/** Seam stand-ins that throw a fresh `errno(code, message)` on every call. */
const failAsync =
  (code: string, message?: string) => async (): Promise<never> => {
    throw errno(code, message);
  };
const failSync = (code: string, message?: string) => (): never => {
  throw errno(code, message);
};

let tmpDir: string;
const tmp = (...segments: string[]) => path.join(tmpDir, ...segments);
const read = (filePath: string) => fsSync.readFileSync(filePath, 'utf-8');
const ls = () => fsSync.readdirSync(tmpDir);
const modeOf = (filePath: string) => fsSync.statSync(filePath).mode & 0o777;

/** Gives each test of the calling describe a fresh temp dir. */
function useTmpDir(prefix: string) {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
}

/** Writes tmp/`name`, optionally chmod-ing it, and returns its path. */
function existing(name: string, content: string, mode?: number) {
  const filePath = tmp(name);
  fsSync.writeFileSync(filePath, content);
  if (mode !== undefined) fsSync.chmodSync(filePath, mode);
  return filePath;
}

/** Writes tmp/`realName` and points the symlink tmp/`linkName` at it. */
function placeLink(realName: string, linkName: string, content: string) {
  const real = existing(realName, content);
  const link = tmp(linkName);
  fsSync.symlinkSync(real, link);
  return { real, link };
}

/** Runs `fn` while process.geteuid reports a uid other than `uid`. */
async function asOtherUser<T>(uid: number, fn: () => Promise<T>) {
  const realGeteuid = process.geteuid!;
  process.geteuid = () => uid + 1;
  try {
    return await fn();
  } finally {
    process.geteuid = realGeteuid;
  }
}

// Frozen, so no test can leak a mutation into another.
const NO_FOLLOW_600 = Object.freeze({ noFollow: true, mode: 0o600 });

/** Writes 'NEW' to `target` while the rename seam fails with EXDEV. */
const writeExdev = (
  target: string,
  options: WriteOptions,
  seams: AsyncSeams = {},
) =>
  atomicWriteFile(target, 'NEW', options, {
    rename: failAsync('EXDEV'),
    ...seams,
  });
const writeExdevSync = (
  target: string,
  options: WriteOptions,
  seams: SyncSeams = {},
) =>
  atomicWriteFileSync(target, 'NEW', options, {
    rename: failSync('EXDEV'),
    ...seams,
  });

/** noFollow outcome: `link` became a regular file; `real` is untouched. */
function expectLinkReplaced(link: string, real: string) {
  expect(fsSync.lstatSync(link).isSymbolicLink()).toBe(false);
  expect(read(link)).toBe('NEW');
  expect(read(real)).toBe('ORIGINAL');
}

describe('atomicWriteJSON', () => {
  useTmpDir('atomic-write-test-');

  it('should write valid JSON to the target file', async () => {
    const filePath = tmp('test.json');
    const data = { hello: 'world', count: 42 };
    await atomicWriteJSON(filePath, data);
    expect(JSON.parse(read(filePath))).toEqual(data);
  });

  it('should pretty-print with 2-space indent', async () => {
    const filePath = tmp('test.json');
    await atomicWriteJSON(filePath, { a: 1 });
    expect(read(filePath)).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('should overwrite existing file atomically', async () => {
    const filePath = tmp('test.json');
    await atomicWriteJSON(filePath, { version: 1 });
    await atomicWriteJSON(filePath, { version: 2 });
    expect(JSON.parse(read(filePath))).toEqual({ version: 2 });
  });

  it('should not leave temp files on success', async () => {
    await atomicWriteJSON(tmp('test.json'), { ok: true });
    expect(ls()).toEqual(['test.json']);
  });

  it('should throw if parent directory does not exist', async () => {
    const filePath = tmp('nonexistent', 'test.json');
    await expect(atomicWriteJSON(filePath, {})).rejects.toThrow();
  });
});

describe('atomicWriteFile', () => {
  useTmpDir('atomic-write-file-test-');

  it('should write string content to a new file', async () => {
    const filePath = tmp('test.txt');
    await atomicWriteFile(filePath, 'hello world');
    expect(read(filePath)).toBe('hello world');
  });

  it('should write Buffer content to a new file', async () => {
    const filePath = tmp('test.bin');
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    await atomicWriteFile(filePath, buf);
    expect(fsSync.readFileSync(filePath)).toEqual(buf);
  });

  itPosix('should preserve existing file permissions', async () => {
    const filePath = existing('test.txt', 'original', 0o600);
    await atomicWriteFile(filePath, 'updated');
    expect(modeOf(filePath)).toBe(0o600);
    expect(read(filePath)).toBe('updated');
  });

  itPosix('should apply explicit mode option for new files', async () => {
    const filePath = tmp('secret.txt');
    await atomicWriteFile(filePath, 'secret', { mode: 0o600 });
    expect(modeOf(filePath)).toBe(0o600);
  });

  it('should not leave temp files on success', async () => {
    await atomicWriteFile(tmp('test.txt'), 'content');
    expect(ls()).toEqual(['test.txt']);
  });

  it('should clean up temp file when write fails', async () => {
    // Writing to a path whose parent doesn't exist will fail
    const filePath = tmp('nonexistent', 'test.txt');
    await expect(atomicWriteFile(filePath, 'data')).rejects.toThrow();
    expect(ls()).toEqual([]);
  });

  it('should overwrite existing file atomically', async () => {
    const filePath = tmp('test.txt');
    await atomicWriteFile(filePath, 'version 1');
    await atomicWriteFile(filePath, 'version 2');
    expect(read(filePath)).toBe('version 2');
  });

  it('should respect encoding option', async () => {
    const filePath = tmp('test.txt');
    await atomicWriteFile(filePath, 'café', { encoding: 'utf-8' });
    expect(read(filePath)).toBe('café');
  });

  it('should resolve symlinks and write to the real target', async () => {
    const { real, link } = placeLink('real.txt', 'link.txt', 'original');

    await atomicWriteFile(link, 'updated via symlink');

    // The symlink still points to the real file, which holds the update.
    expect(fsSync.readlinkSync(link)).toBe(real);
    expect(read(real)).toBe('updated via symlink');
  });

  it('should write through a broken symlink without replacing it', async () => {
    const realFile = tmp('target.txt');
    const linkFile = tmp('broken-link.txt');
    // A symlink whose target does not exist yet.
    fsSync.symlinkSync(realFile, linkFile);

    await atomicWriteFile(linkFile, 'created via broken symlink');

    // The symlink still points to the target, now created with the content.
    expect(fsSync.readlinkSync(linkFile)).toBe(realFile);
    expect(read(realFile)).toBe('created via broken symlink');
  });

  it('should resolve relative symlinks against the symlink directory', async () => {
    const realFile = existing('real.txt', 'original');
    const linkFile = tmp('link.txt');
    fsSync.symlinkSync('real.txt', linkFile); // relative target

    await atomicWriteFile(linkFile, 'updated via relative symlink');

    // The symlink still exists; the real file holds the update.
    expect(fsSync.readlinkSync(linkFile)).toBe('real.txt');
    expect(read(realFile)).toBe('updated via relative symlink');
  });

  it('should resolve multi-level symlink chains', async () => {
    const { real: realFile, link: linkA } = placeLink(
      'real.txt',
      'link-a.txt',
      'original',
    );
    const linkB = tmp('link-b.txt');
    fsSync.symlinkSync(linkA, linkB); // linkB → linkA → real

    await atomicWriteFile(linkB, 'updated via chain');

    // Both symlinks still exist; the real file holds the update.
    expect(fsSync.readlinkSync(linkB)).toBe(linkA);
    expect(fsSync.readlinkSync(linkA)).toBe(realFile);
    expect(read(realFile)).toBe('updated via chain');
  });

  it('should throw if parent directory does not exist', async () => {
    const filePath = tmp('no', 'such', 'dir', 'file.txt');
    await expect(atomicWriteFile(filePath, 'data')).rejects.toThrow();
  });

  it('should resolve relative symlink targets through directory symlinks', async () => {
    // realDir/file.txt → ../otherDir/target.txt (relative to its parent) and
    // linkDir → realDir; writing via linkDir/file.txt must resolve through
    // both. (A plain tmpDir/target.txt would come out the same under a
    // string-only dirname, hence this trickier setup.)
    const realDir = tmp('realDir');
    const otherDir = tmp('otherDir');
    const targetFile = path.join(otherDir, 'target.txt');
    const linkInRealDir = path.join(realDir, 'file.txt');
    const linkDir = tmp('linkDir');
    fsSync.mkdirSync(realDir);
    fsSync.mkdirSync(otherDir);
    fsSync.writeFileSync(targetFile, 'original');
    fsSync.symlinkSync('../otherDir/target.txt', linkInRealDir);
    fsSync.symlinkSync(realDir, linkDir); // directory symlink

    await atomicWriteFile(
      path.join(linkDir, 'file.txt'),
      'updated via dir symlink',
    );

    expect(read(targetFile)).toBe('updated via dir symlink');
    // Symlinks themselves stay intact (normalized for Windows separators).
    expect(path.normalize(fsSync.readlinkSync(linkDir))).toBe(
      path.normalize(realDir),
    );
    expect(path.normalize(fsSync.readlinkSync(linkInRealDir))).toBe(
      path.normalize('../otherDir/target.txt'),
    );
  });

  itPosix(
    'should use atomic rename when ownership matches (inode changes)',
    async () => {
      const filePath = existing('mine.txt', 'original');
      const inoBefore = fsSync.statSync(filePath).ino;

      await atomicWriteFile(filePath, 'updated');

      // Atomic rename produces a new inode.
      expect(fsSync.statSync(filePath).ino).not.toBe(inoBefore);
      expect(read(filePath)).toBe('updated');
    },
  );

  itOtherUser(
    'should fall back to in-place write when atomic rename would change ownership',
    async () => {
      // process.geteuid reports a uid other than the file's owner, so the
      // code detects rename would strip ownership and falls back to in-place
      // writeFile, which preserves the inode: our signal the fallback ran.
      const filePath = existing('shared.txt', 'original', 0o664);
      const { uid, ino } = fsSync.statSync(filePath);

      await asOtherUser(uid, () => atomicWriteFile(filePath, 'updated'));

      expect(read(filePath)).toBe('updated');
      const statAfter = fsSync.statSync(filePath);
      // In-place write keeps the inode (rename was skipped) and the
      // permissions, and leaves no temp file.
      expect(statAfter.ino).toBe(ino);
      expect(statAfter.mode & 0o777).toBe(0o664);
      expect(ls()).toEqual(['shared.txt']);
    },
  );

  itOtherUser(
    'should skip in-place fallback for non-regular files and use atomic replace',
    async () => {
      // FIFO + ownership mismatch must NOT take the in-place fallback:
      // open(O_WRONLY|O_TRUNC) on a FIFO blocks forever waiting for a
      // reader. The atomic rename path replaces the FIFO with a regular
      // file, the only sane "write to this path" semantics for it.
      const { execSync } = await import('node:child_process');
      const fifoPath = tmp('pipe.fifo');
      execSync(`mkfifo "${fifoPath}"`);
      const realStat = fsSync.statSync(fifoPath);
      expect(realStat.isFIFO()).toBe(true);

      // The in-place fallback would hang here; Vitest's timeout catches it.
      await asOtherUser(realStat.uid, () =>
        atomicWriteFile(fifoPath, 'content'),
      );

      // The atomic path replaced the FIFO with a regular file.
      expect(fsSync.statSync(fifoPath).isFile()).toBe(true);
      expect(read(fifoPath)).toBe('content');
    },
  );

  itOtherUser(
    'should write via in-place fallback through a resolved symlink when ownership differs',
    async () => {
      // atomicWriteFile resolves the symlink via resolveSymlinkChain before
      // stat, so the in-place write targets the real file and the symlink
      // itself is preserved.
      const { real, link } = placeLink(
        'real.txt',
        'attacker-symlink.txt',
        'real-content',
      );
      const { uid, ino } = fsSync.statSync(real);

      await asOtherUser(uid, () => atomicWriteFile(link, 'updated'));

      expect(read(real)).toBe('updated');
      expect(fsSync.statSync(real).ino).toBe(ino);
      expect(fsSync.lstatSync(link).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(
    process.platform === 'win32' ||
      typeof process.geteuid !== 'function' ||
      // chmod 0o000 against the file's real owner still succeeds via
      // POSIX rename in CI/sandbox setups where the user is effectively
      // root; only assert real EACCES when we own and can be denied.
      process.geteuid() === 0,
  )(
    'should surface EACCES when in-place fallback hits an unwritable file',
    async () => {
      // Atomic rename used to silently replace files the caller cannot
      // write (rename only needs parent-dir write). The in-place fallback
      // respects the file's mode and surfaces EACCES: the right outcome
      // for "you don't own this, you shouldn't be replacing it".
      const filePath = existing('readonly.txt', 'original', 0o444);
      const { uid } = fsSync.statSync(filePath);

      try {
        await asOtherUser(uid, () =>
          expect(atomicWriteFile(filePath, 'updated')).rejects.toThrow(
            /EACCES/,
          ),
        );
      } finally {
        // Restore mode so afterEach's rm can clean up.
        await fs.chmod(filePath, 0o644);
      }

      // Original content untouched.
      expect(read(filePath)).toBe('original');
    },
  );
});

describe('atomicWriteFileSync', () => {
  useTmpDir('atomic-write-sync-test-');

  it('should write string content to a new file', () => {
    const filePath = tmp('test.txt');
    atomicWriteFileSync(filePath, 'hello sync');
    expect(read(filePath)).toBe('hello sync');
  });

  it('should write Buffer content to a new file', () => {
    const filePath = tmp('test.bin');
    const buf = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
    atomicWriteFileSync(filePath, buf);
    expect(fsSync.readFileSync(filePath)).toEqual(buf);
  });

  itPosix('should preserve existing file permissions', () => {
    const filePath = existing('test.txt', 'original', 0o600);
    atomicWriteFileSync(filePath, 'updated');
    expect(modeOf(filePath)).toBe(0o600);
    expect(read(filePath)).toBe('updated');
  });

  itPosix('should apply explicit mode option for new files', () => {
    const filePath = tmp('secret.txt');
    atomicWriteFileSync(filePath, 'secret', { mode: 0o600 });
    expect(modeOf(filePath)).toBe(0o600);
  });

  it('should not leave temp files on success', () => {
    atomicWriteFileSync(tmp('test.txt'), 'content');
    expect(ls()).toEqual(['test.txt']);
  });

  it('should clean up temp file when write fails', () => {
    const filePath = tmp('nonexistent', 'test.txt');
    expect(() => atomicWriteFileSync(filePath, 'data')).toThrow();
    expect(ls()).toEqual([]);
  });

  it('should overwrite existing file atomically', () => {
    const filePath = tmp('test.txt');
    atomicWriteFileSync(filePath, 'v1');
    atomicWriteFileSync(filePath, 'v2');
    expect(read(filePath)).toBe('v2');
  });

  it('should respect encoding option', () => {
    const filePath = tmp('test.txt');
    atomicWriteFileSync(filePath, 'café', { encoding: 'utf-8' });
    expect(read(filePath)).toBe('café');
  });

  it('should resolve symlinks and write to the real target', () => {
    const { real, link } = placeLink('real.txt', 'link.txt', 'original');
    atomicWriteFileSync(link, 'updated via symlink');
    expect(fsSync.readlinkSync(link)).toBe(real);
    expect(read(real)).toBe('updated via symlink');
  });

  it('should write through a broken symlink without replacing it', () => {
    const realFile = tmp('target.txt');
    const linkFile = tmp('broken-link.txt');
    fsSync.symlinkSync(realFile, linkFile);

    atomicWriteFileSync(linkFile, 'created via broken symlink');

    expect(fsSync.readlinkSync(linkFile)).toBe(realFile);
    expect(read(realFile)).toBe('created via broken symlink');
  });

  it('should resolve multi-level symlink chains', () => {
    const { real: realFile, link: linkA } = placeLink(
      'real.txt',
      'link-a.txt',
      'original',
    );
    const linkB = tmp('link-b.txt');
    fsSync.symlinkSync(linkA, linkB);

    atomicWriteFileSync(linkB, 'updated via chain');

    expect(fsSync.readlinkSync(linkB)).toBe(linkA);
    expect(fsSync.readlinkSync(linkA)).toBe(realFile);
    expect(read(realFile)).toBe('updated via chain');
  });

  it('should throw if parent directory does not exist', () => {
    const filePath = tmp('no', 'such', 'dir', 'file.txt');
    expect(() => atomicWriteFileSync(filePath, 'data')).toThrow();
  });
});

describe('forceMode option', () => {
  useTmpDir('force-mode-test-');

  itPosix(
    'atomicWriteFile: forceMode tightens an over-permissive existing file',
    async () => {
      const filePath = existing('creds.json', 'old', 0o644); // legacy bad perms
      await atomicWriteFile(filePath, 'new', { mode: 0o600, forceMode: true });
      expect(modeOf(filePath)).toBe(0o600);
    },
  );

  itPosix(
    'atomicWriteFile: without forceMode, existing 0o644 is preserved',
    async () => {
      const filePath = existing('creds.json', 'old', 0o644);
      await atomicWriteFile(filePath, 'new', { mode: 0o600 });
      // Existing mode wins — documented default behavior.
      expect(modeOf(filePath)).toBe(0o644);
    },
  );

  itPosix(
    'atomicWriteFileSync: forceMode tightens an over-permissive existing file',
    () => {
      const filePath = existing('creds.json', 'old', 0o644);
      atomicWriteFileSync(filePath, 'new', { mode: 0o600, forceMode: true });
      expect(modeOf(filePath)).toBe(0o600);
    },
  );

  itPosix(
    'forceMode without mode preserves existing permissions (does not drop to umask)',
    async () => {
      const filePath = existing('file.txt', 'old', 0o600);

      // forceMode:true without mode is meaningless (nothing to force) — must
      // not silently downgrade to umask default. Regression: pre-fix this
      // dropped the file to 0o644 because forceMode skipped the stat.
      await atomicWriteFile(filePath, 'new', { forceMode: true });

      expect(read(filePath)).toBe('new');
      expect(modeOf(filePath)).toBe(0o600);
    },
  );

  itPosix(
    'atomicWriteFileSync: forceMode without mode preserves existing permissions',
    () => {
      const filePath = existing('file.txt', 'old', 0o600);
      atomicWriteFileSync(filePath, 'new', { forceMode: true });
      expect(read(filePath)).toBe('new');
      expect(modeOf(filePath)).toBe(0o600);
    },
  );
});

// PR #4333 review fold-in: cover rename-retry + EXDEV-fallback paths the
// existing behavior tests can't exercise (vitest can't spy on ESM exports
// of node:fs). Uses the `_testFs` / `_renameImpl` seams added to the
// production helpers.
describe('renameWithRetry (async, dependency-injected rename)', () => {
  useTmpDir('rename-retry-async-');

  it('retries on EPERM and eventually succeeds', async () => {
    const src = existing('src.txt', 'data');
    const dest = tmp('dest.txt');
    let attempts = 0;
    const mockRename = async (s: string, d: string) => {
      attempts++;
      if (attempts < 3) throw errno('EPERM');
      await fs.rename(s, d);
    };

    await renameWithRetry(src, dest, 3, 1, mockRename);
    expect(attempts).toBe(3);
    expect(fsSync.existsSync(dest)).toBe(true);
  });

  it('gives up after retries exhausted', async () => {
    const mockRename = vi.fn(failAsync('EPERM'));
    await expect(renameWithRetry('s', 'd', 2, 1, mockRename)).rejects.toThrow(
      /EPERM/,
    );
    expect(mockRename).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it('does not retry on non-retryable errors (ENOSPC)', async () => {
    const mockRename = vi.fn(failAsync('ENOSPC'));
    await expect(renameWithRetry('s', 'd', 3, 1, mockRename)).rejects.toThrow(
      /ENOSPC/,
    );
    expect(mockRename).toHaveBeenCalledTimes(1);
  });

  // The tests above cover retry count + error propagation but not the
  // backoff curve. A regression swapping `delayMs * 2 ** attempt` for
  // linear, constant, or (worst) regressive backoff, which intensifies under
  // Windows AV-scan stress, would pass every other test. Fake timers make
  // the assertion deterministic without burning real wall-clock time.
  it('backs off exponentially: delayMs, 2*delayMs, 4*delayMs, ...', async () => {
    vi.useFakeTimers();
    try {
      const gaps: number[] = [];
      let lastInvocation = Date.now();
      const mockRename = async () => {
        const now = Date.now();
        gaps.push(now - lastInvocation);
        lastInvocation = now;
        throw errno('EPERM');
      };

      const promise = renameWithRetry('s', 'd', 3, 50, mockRename);
      // Catch eventual rejection so unhandled-rejection doesn't fire.
      promise.catch(() => {});

      // 4 invocations total (initial + 3 retries); the gaps after the
      // first should be [50, 100, 200].
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);

      await expect(promise).rejects.toThrow(/EPERM/);
      // gaps[0] is the first invocation's offset from the timer start
      // (effectively 0). gaps[1..] are the post-retry waits.
      expect(gaps.slice(1)).toEqual([50, 100, 200]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('renameWithRetrySync (dependency-injected rename)', () => {
  useTmpDir('rename-retry-sync-');

  it('retries on EACCES and succeeds', () => {
    const src = existing('src.txt', 'data');
    const dest = tmp('dest.txt');
    let attempts = 0;
    const mockRename = (s: string, d: string) => {
      attempts++;
      if (attempts < 3) throw errno('EACCES');
      fsSync.renameSync(s, d);
    };

    renameWithRetrySync(src, dest, 3, 1, mockRename);
    expect(attempts).toBe(3);
    expect(fsSync.existsSync(dest)).toBe(true);
  });

  it('gives up after retries exhausted', () => {
    const mockRename = vi.fn(failSync('EPERM'));
    expect(() => renameWithRetrySync('s', 'd', 2, 1, mockRename)).toThrow(
      /EPERM/,
    );
    expect(mockRename).toHaveBeenCalledTimes(3);
  });

  it('does not retry on non-retryable errors (EINVAL)', () => {
    const mockRename = vi.fn(failSync('EINVAL'));
    expect(() => renameWithRetrySync('s', 'd', 3, 1, mockRename)).toThrow(
      /EINVAL/,
    );
    expect(mockRename).toHaveBeenCalledTimes(1);
  });
});

describe('EXDEV fallback (async + sync)', () => {
  useTmpDir('exdev-fallback-');

  it('atomicWriteFile: falls back to direct write on EXDEV, cleans up tmp', async () => {
    const filePath = tmp('exdev.txt');
    await atomicWriteFile(filePath, 'fallback-payload', undefined, {
      rename: failAsync('EXDEV'),
    });

    expect(read(filePath)).toBe('fallback-payload');
    // No tmp residue
    expect(ls()).toEqual(['exdev.txt']);
  });

  it('atomicWriteFileSync: falls back to direct write on EXDEV, cleans up tmp', () => {
    const filePath = tmp('exdev-sync.txt');
    atomicWriteFileSync(filePath, 'sync-fallback-payload', undefined, {
      rename: failSync('EXDEV'),
    });

    expect(read(filePath)).toBe('sync-fallback-payload');
    expect(ls()).toEqual(['exdev-sync.txt']);
  });

  it('atomicWriteFile: non-EXDEV rename failure propagates (no fallback)', async () => {
    const filePath = tmp('eio.txt');
    await expect(
      atomicWriteFile(filePath, 'data', undefined, {
        rename: failAsync('EIO'),
      }),
    ).rejects.toThrow(/atomicWriteFile\(.*eio\.txt.*\):.*EIO/);
    // Tmp cleaned up even though rename failed
    expect(ls()).toEqual([]);
  });

  it('atomicWriteFileSync: non-EXDEV rename failure propagates and cleans up tmp', () => {
    // Mirror of the async EIO test (review fold-in): the sync variant had
    // the same `unlinkSync + re-throw` path but no test exercising it (the
    // "should clean up temp file when write fails" test only covers a
    // writeFileSync failure before rename).
    const filePath = tmp('eio-sync.txt');
    expect(() =>
      atomicWriteFileSync(filePath, 'data', undefined, {
        rename: failSync('EIO'),
      }),
    ).toThrow(/atomicWriteFileSync\(.*eio-sync\.txt.*\):.*EIO/);
    expect(ls()).toEqual([]);
  });

  it('atomicWriteFile: annotates errors whose message contains the target path (startsWith guard, not includes)', async () => {
    // Guards the documented idempotency-guard bug: it once used
    // `message.includes(targetPath)`, but real syscall errors embed the *tmp*
    // path (containing the target as a substring), so annotation was
    // silently skipped on every real failure. This rename error embeds such
    // a path; the correct `startsWith` guard still annotates it, and
    // reverting to `includes` would skip annotation and fail this test.
    const filePath = tmp('pathinmsg.txt');
    const rename = failAsync(
      'EIO',
      `EIO: i/o error, rename '${filePath}.abc123.tmp'`,
    );

    await expect(
      atomicWriteFile(filePath, 'data', undefined, { rename }),
    ).rejects.toThrow(/^atomicWriteFile\(/);
  });

  // PR #4333 review fold-in: the EXDEV-then-fallback-write-fails path is
  // the only place fnName='atomicWriteFileSync' is exercised, so without
  // these tests a regression that dropped or misapplied the annotation
  // would go undetected on sync.
  it('atomicWriteFile: EXDEV fallback write failure is annotated with target + fn name', async () => {
    const filePath = tmp('exdev-write-fail.txt');
    // Selective failure: the first call (the tmp-file write) succeeds so the
    // EXDEV branch is actually reached; the second (the direct write inside
    // the EXDEV fallback) fails. Otherwise the tmp-file write would fail
    // FIRST with ENOSPC, skipping the EXDEV branch and leaving the inner
    // annotateWriteError call untested dead code.
    let writeCalls = 0;
    const failingWrite = async (
      p: string,
      d: string | Buffer | NodeJS.ArrayBufferView,
      opts: unknown,
    ) => {
      writeCalls++;
      if (writeCalls === 1) {
        // Actually write the tmp file so subsequent cleanup works.
        await fs.writeFile(
          p,
          d as Buffer,
          opts as Parameters<typeof fs.writeFile>[2],
        );
        return;
      }
      throw errno(
        'ENOSPC',
        `ENOSPC: no space left on device, open '${filePath}'`,
      );
    };

    let caught: unknown;
    try {
      await atomicWriteFile(filePath, 'data', undefined, {
        rename: failAsync('EXDEV'),
        writeFile: failingWrite as unknown as typeof fs.writeFile,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as NodeJS.ErrnoException)?.code).toBe('ENOSPC');
    expect((caught as Error).message).toMatch(
      /atomicWriteFile\(.*exdev-write-fail\.txt.*\):.*ENOSPC/,
    );
  });

  it('atomicWriteFileSync: EXDEV fallback write failure is annotated with sync fn name', () => {
    const filePath = tmp('exdev-sync-write-fail.txt');
    // Same selective-failure pattern as the async test: the first call (tmp
    // write) succeeds so the EXDEV branch is genuinely reached; the second
    // (fallback write) throws.
    let writeCalls = 0;
    const failingWrite = (
      p: string,
      d: string | NodeJS.ArrayBufferView,
      opts: unknown,
    ) => {
      writeCalls++;
      if (writeCalls === 1) {
        fsSync.writeFileSync(
          p,
          d,
          opts as Parameters<typeof fsSync.writeFileSync>[2],
        );
        return;
      }
      throw errno(
        'ENOSPC',
        `ENOSPC: no space left on device, open '${filePath}'`,
      );
    };

    let caught: unknown;
    try {
      atomicWriteFileSync(filePath, 'data', undefined, {
        rename: failSync('EXDEV'),
        writeFile: failingWrite as unknown as typeof fsSync.writeFileSync,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as NodeJS.ErrnoException)?.code).toBe('ENOSPC');
    expect((caught as Error).message).toMatch(
      /atomicWriteFileSync\(.*exdev-sync-write-fail\.txt.*\):.*ENOSPC/,
    );
  });
});

// PR #4333 review fold-in: noFollow is a security-critical option used
// by all credential write sites — these tests verify the actual
// symlink-skipping behavior (happy path AND EXDEV fallback path),
// not just that the option is passed through to a mock.
describe('noFollow option — symlink protection', () => {
  useTmpDir('no-follow-test-');

  it('atomicWriteFile: noFollow replaces a pre-placed symlink instead of writing through it', async () => {
    const { real, link } = placeLink('real.txt', 'link.txt', 'ORIGINAL');
    await atomicWriteFile(link, 'NEW', { noFollow: true });
    // link is now a regular file; the real file was NOT followed through to.
    expectLinkReplaced(link, real);
  });

  itOtherUser(
    'atomicWriteFile: noFollow still replaces a symlink when ownership differs',
    async () => {
      const { real, link } = placeLink(
        'owned-by-another-user.txt',
        'record.json',
        'ORIGINAL',
      );
      const { uid } = fsSync.statSync(real);

      await asOtherUser(uid, () =>
        atomicWriteFile(link, 'NEW', { noFollow: true, mode: 0o600 }),
      );

      expectLinkReplaced(link, real);
    },
  );

  it('atomicWriteFileSync: noFollow replaces a pre-placed symlink instead of writing through it', () => {
    const { real, link } = placeLink('real.txt', 'link.txt', 'ORIGINAL');
    atomicWriteFileSync(link, 'NEW', { noFollow: true });
    expectLinkReplaced(link, real);
  });

  it('atomicWriteFile: noFollow EXDEV fallback also refuses to follow symlinks', async () => {
    const { real, link } = placeLink('real.txt', 'link.txt', 'ORIGINAL');
    // EXDEV on rename exercises the noFollow-aware fallback (the security
    // regression Codex caught): the real file MUST stay untouched, as
    // pre-fix the attacker's symlink redirected credentials there.
    await writeExdev(link, { noFollow: true });
    expectLinkReplaced(link, real);
  });

  it('atomicWriteFile: noFollow EXDEV completes the replacement after unlink', async () => {
    const target = existing('generation-closed.txt', 'ORIGINAL');
    let canCommit = true;
    const unlink = async (p: Parameters<typeof fs.unlink>[0]) => {
      await fs.unlink(p);
      if (p === target) canCommit = false;
    };
    const openSpy = vi.fn(fs.open);

    await writeExdev(
      target,
      {
        noFollow: true,
        assertCanCommit: () => {
          if (!canCommit) throw new Error('generation closed');
        },
      },
      { unlink, open: openSpy },
    );

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(read(target)).toBe('NEW');
  });

  it('atomicWriteFileSync: noFollow EXDEV fallback also refuses to follow symlinks', () => {
    const { real, link } = placeLink('real.txt', 'link.txt', 'ORIGINAL');
    writeExdevSync(link, { noFollow: true });
    expectLinkReplaced(link, real);
  });

  // Earlier noFollow EXDEV tests pre-place a symlink, so the fallback's
  // `unlink(targetPath)` always succeeds. These exercise the ENOENT-swallow
  // branch: first writes (initial credential provisioning on a cross-device
  // mount). Mode assertions are Linux/macOS only: Windows NTFS reports
  // 0o666 for any non-read-only file regardless of chmod.
  //
  // They also spy on path-based chmod to verify the *mechanism*, not just
  // the outcome. Under a typical umask 0o022, `open(O_EXCL, 0o600)` already
  // creates the file at 0o600, so a regression swapping `fd.chmod()` back
  // to a path-based `tryChmod(targetPath)` (the pre-fix TOCTOU-vulnerable
  // form) would keep the mode assertion passing. Asserting path-based chmod
  // never ran against `targetPath` catches that regression directly.
  itPosix(
    'atomicWriteFile: noFollow EXDEV fallback creates a new file when target does not exist',
    async () => {
      const target = tmp('never-created.txt');
      const chmodSpy = vi.fn(fs.chmod);

      await writeExdev(target, NO_FOLLOW_600, { chmod: chmodSpy });

      expect(fsSync.lstatSync(target).isSymbolicLink()).toBe(false);
      expect(read(target)).toBe('NEW');
      expect(modeOf(target)).toBe(0o600);
      // Path-based chmod may run on the tmp file (pre-rename) but never on
      // the credential target, which is exclusively for the open-fd fchmod.
      const targetCalls = chmodSpy.mock.calls.filter(([p]) => p === target);
      expect(targetCalls).toEqual([]);
    },
  );

  itPosix(
    'atomicWriteFileSync: noFollow EXDEV fallback creates a new file when target does not exist',
    () => {
      const target = tmp('never-created-sync.txt');
      const chmodSpy = vi.fn(fsSync.chmodSync);

      writeExdevSync(target, NO_FOLLOW_600, { chmod: chmodSpy });

      expect(fsSync.lstatSync(target).isSymbolicLink()).toBe(false);
      expect(read(target)).toBe('NEW');
      expect(modeOf(target)).toBe(0o600);
      const targetCalls = chmodSpy.mock.calls.filter(([p]) => p === target);
      expect(targetCalls).toEqual([]);
    },
  );

  // The narrowed fchmod catch (round-8 fix) swallows ENOSYS/ENOTSUP
  // (FAT/exFAT, the typical removable-storage credential mount) but
  // propagates every other error. Without injection neither side of the
  // branch runs, so a one-line revert of the narrowing would pass every
  // test, and the orphan-cleanup-on-fchmod-failure path has no coverage.
  // Both ENOSYS (Linux FAT) and ENOTSUP (macOS exFAT) must be swallowed:
  // dropping either would leave a credential file at the umask-masked
  // open() mode on one of the two common removable-media filesystems.
  it.each(['ENOSYS', 'ENOTSUP'] as const)(
    'atomicWriteFile: noFollow EXDEV swallows fchmod %s (FAT/exFAT)',
    async (chmodCode) => {
      const target = tmp(`fat-target-${chmodCode}.txt`);
      await writeExdev(target, NO_FOLLOW_600, { fchmod: failAsync(chmodCode) });
      expect(read(target)).toBe('NEW');
    },
  );

  it('atomicWriteFile: noFollow EXDEV propagates fchmod EPERM and removes the orphan', async () => {
    const target = tmp('eperm-target.txt');

    await expect(
      writeExdev(target, NO_FOLLOW_600, { fchmod: failAsync('EPERM') }),
    ).rejects.toThrow(/EPERM/);

    // The O_EXCL-created file MUST be removed so the next retry doesn't
    // deadlock: the credential-refresh-loop bug round-8 review surfaced.
    expect(fsSync.existsSync(target)).toBe(false);
  });

  it.each(['ENOSYS', 'ENOTSUP'] as const)(
    'atomicWriteFileSync: noFollow EXDEV swallows fchmod %s (FAT/exFAT)',
    (chmodCode) => {
      const target = tmp(`fat-target-sync-${chmodCode}.txt`);
      writeExdevSync(target, NO_FOLLOW_600, { fchmod: failSync(chmodCode) });
      expect(read(target)).toBe('NEW');
    },
  );

  it('atomicWriteFileSync: noFollow EXDEV propagates fchmod EPERM and removes the orphan', () => {
    const target = tmp('eperm-target-sync.txt');

    expect(() =>
      writeExdevSync(target, NO_FOLLOW_600, { fchmod: failSync('EPERM') }),
    ).toThrow(/EPERM/);

    expect(fsSync.existsSync(target)).toBe(false);
  });

  // The pre-open unlink at `targetPath` swallows ENOENT (first write) but
  // propagates anything else. Without injection no test exercises the
  // propagation path, and a regression to a blanket catch would let a real
  // error (EACCES on the parent directory, EROFS on a remount) hide behind
  // the subsequent EEXIST from O_EXCL.
  it('atomicWriteFile: noFollow EXDEV pre-open unlink propagates non-ENOENT errors', async () => {
    const target = tmp('eacces-target.txt');
    // Only the pre-open unlink at targetPath fails; tmp-file cleanup goes
    // through `fs.unlink` directly (not the seam).
    const unlink = async (p: fsSync.PathLike) => {
      if (p === target) throw errno('EACCES');
    };

    await expect(
      writeExdev(target, NO_FOLLOW_600, { unlink: unlink as typeof fs.unlink }),
    ).rejects.toThrow(/EACCES/);
  });

  it('atomicWriteFileSync: noFollow EXDEV pre-open unlink propagates non-ENOENT errors', () => {
    const target = tmp('eacces-target-sync.txt');
    const unlink = (p: fsSync.PathLike) => {
      if (p === target) throw errno('EACCES');
    };

    expect(() =>
      writeExdevSync(target, NO_FOLLOW_600, {
        unlink: unlink as typeof fsSync.unlinkSync,
      }),
    ).toThrow(/EACCES/);
  });

  // Symlink-resolution failures (EACCES on an intermediate dir, ELOOP) must
  // share the `atomicWriteFile("path"): ...` annotation prefix so logs
  // name the logical filePath, not an internal intermediate component.
  itPosix(
    'atomicWriteFile: annotates resolveSymlinkChain ELOOP failures with the logical filePath',
    async () => {
      const linkA = tmp('loop-a');
      const linkB = tmp('loop-b');
      fsSync.symlinkSync(linkB, linkA);
      fsSync.symlinkSync(linkA, linkB);

      await expect(atomicWriteFile(linkA, 'X')).rejects.toThrow(
        new RegExp(`atomicWriteFile\\(.*${path.basename(linkA)}.*\\):`),
      );
    },
  );

  itPosix(
    'atomicWriteFileSync: annotates resolveSymlinkChainSync ELOOP failures with the logical filePath',
    () => {
      const linkA = tmp('loop-a-sync');
      const linkB = tmp('loop-b-sync');
      fsSync.symlinkSync(linkB, linkA);
      fsSync.symlinkSync(linkA, linkB);

      expect(() => atomicWriteFileSync(linkA, 'X')).toThrow(
        new RegExp(`atomicWriteFileSync\\(.*${path.basename(linkA)}.*\\):`),
      );
    },
  );

  // Round-13 narrowed the path-level tryChmod / tryChmodSync catch to
  // ENOSYS/ENOTSUP only (the shape of the round-8 fd-level fchmod
  // narrowing), but unlike fchmod the tryChmod path had no direct coverage:
  // the EXDEV tests pass `options: undefined`, so `desiredMode === undefined`
  // short-circuits before chmod. Inject `_testFs.chmod` and exercise both
  // sides of the narrowed catch.
  it.each(['ENOSYS', 'ENOTSUP'] as const)(
    'atomicWriteFile: tryChmod swallows %s (FAT/exFAT — non-noFollow EXDEV path)',
    async (chmodCode) => {
      const target = tmp(`trychmod-${chmodCode}.txt`);
      await writeExdev(
        target,
        { mode: 0o600 },
        { chmod: failAsync(chmodCode) },
      );
      expect(read(target)).toBe('NEW');
    },
  );

  it('atomicWriteFile: tryChmod propagates EPERM (non-noFollow EXDEV path)', async () => {
    const target = tmp('trychmod-eperm.txt');
    await expect(
      writeExdev(target, { mode: 0o600 }, { chmod: failAsync('EPERM') }),
    ).rejects.toThrow(/EPERM/);
  });

  it.each(['ENOSYS', 'ENOTSUP'] as const)(
    'atomicWriteFileSync: tryChmodSync swallows %s (FAT/exFAT — non-noFollow EXDEV path)',
    (chmodCode) => {
      const target = tmp(`trychmod-sync-${chmodCode}.txt`);
      writeExdevSync(target, { mode: 0o600 }, { chmod: failSync(chmodCode) });
      expect(read(target)).toBe('NEW');
    },
  );

  it('atomicWriteFileSync: tryChmodSync propagates EPERM (non-noFollow EXDEV path)', () => {
    const target = tmp('trychmod-sync-eperm.txt');
    expect(() =>
      writeExdevSync(target, { mode: 0o600 }, { chmod: failSync('EPERM') }),
    ).toThrow(/EPERM/);
  });

  // Round-13's orphan-cleanup unlink (after a failed write/sync/fchmod on the
  // noFollow EXDEV path) used raw `fs.unlink` / `fsSync.unlinkSync` instead
  // of the injected `unlinkImpl` seam every other fs op flows through. These
  // inject a spy on unlinkImpl and assert it's invoked with targetPath on
  // the failure path, guarding against a refactor silently bypassing it.
  it('atomicWriteFile: orphan cleanup on fchmod failure goes through unlinkImpl', async () => {
    const target = tmp('orphan-via-seam.txt');
    const unlinkSpy = vi.fn(fs.unlink);

    await expect(
      writeExdev(target, NO_FOLLOW_600, {
        fchmod: failAsync('EPERM'),
        unlink: unlinkSpy as typeof fs.unlink,
      }),
    ).rejects.toThrow(/EPERM/);

    const orphanCleanupCalls = unlinkSpy.mock.calls.filter(
      ([p]) => p === target,
    );
    // Pre-open unlink + post-failure orphan cleanup: target appears twice.
    expect(orphanCleanupCalls.length).toBeGreaterThanOrEqual(2);
    expect(fsSync.existsSync(target)).toBe(false);
  });

  it('atomicWriteFileSync: orphan cleanup on fchmod failure goes through unlinkImpl', () => {
    const target = tmp('orphan-via-seam-sync.txt');
    const unlinkSpy = vi.fn(fsSync.unlinkSync);

    expect(() =>
      writeExdevSync(target, NO_FOLLOW_600, {
        fchmod: failSync('EPERM'),
        unlink: unlinkSpy as typeof fsSync.unlinkSync,
      }),
    ).toThrow(/EPERM/);

    const orphanCleanupCalls = unlinkSpy.mock.calls.filter(
      ([p]) => p === target,
    );
    expect(orphanCleanupCalls.length).toBeGreaterThanOrEqual(2);
    expect(fsSync.existsSync(target)).toBe(false);
  });

  // PR #4333 review fold-in: the noFollow EXDEV fallback must open the target
  // with O_EXCL so a symlink racing back between the pre-open unlink and the
  // open cannot redirect the credential write (the TOCTOU the noFollow
  // branch defends against). open/openSync goes through the `_testFs` seam
  // so these tests assert the no-clobber flag *directly*: dropping O_EXCL
  // reopens the symlink-follow hole yet leaves every behavioral test green
  // (their static symlink never races the unlink-then-open window), and the
  // earlier tests only inject an EEXIST-style error.
  it('atomicWriteFile: noFollow EXDEV opens the target with O_EXCL (no-clobber create)', async () => {
    const target = tmp('oexcl-async.txt');
    const openSpy = vi.fn(fs.open);

    await writeExdev(target, { noFollow: true }, { open: openSpy });

    expect(openSpy).toHaveBeenCalledTimes(1);
    const flags = openSpy.mock.calls[0][1] as number;
    // The load-bearing assertion: O_EXCL must be set (no-clobber create).
    expect(flags & fsSync.constants.O_EXCL).toBe(fsSync.constants.O_EXCL);
    expect(flags & fsSync.constants.O_CREAT).toBe(fsSync.constants.O_CREAT);
    // Sanity: the write genuinely went through the seam-routed open.
    expect(read(target)).toBe('NEW');
  });

  it('atomicWriteFileSync: noFollow EXDEV opens the target with O_EXCL (no-clobber create)', () => {
    const target = tmp('oexcl-sync.txt');
    const openSpy = vi.fn(fsSync.openSync);

    writeExdevSync(target, { noFollow: true }, { open: openSpy });

    expect(openSpy).toHaveBeenCalledTimes(1);
    const flags = openSpy.mock.calls[0][1] as number;
    expect(flags & fsSync.constants.O_EXCL).toBe(fsSync.constants.O_EXCL);
    expect(flags & fsSync.constants.O_CREAT).toBe(fsSync.constants.O_CREAT);
    expect(read(target)).toBe('NEW');
  });
});
