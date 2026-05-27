/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  atomicWriteFile,
  atomicWriteJSON,
  writeInPlaceWithFdGuards,
} from './atomicFileWrite.js';

describe('atomicWriteJSON', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-write-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should write valid JSON to the target file', async () => {
    const filePath = path.join(tmpDir, 'test.json');
    const data = { hello: 'world', count: 42 };

    await atomicWriteJSON(filePath, data);

    const content = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(content)).toEqual(data);
  });

  it('should pretty-print with 2-space indent', async () => {
    const filePath = path.join(tmpDir, 'test.json');
    await atomicWriteJSON(filePath, { a: 1 });

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('should overwrite existing file atomically', async () => {
    const filePath = path.join(tmpDir, 'test.json');
    await atomicWriteJSON(filePath, { version: 1 });
    await atomicWriteJSON(filePath, { version: 2 });

    const content = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(content)).toEqual({ version: 2 });
  });

  it('should not leave temp files on success', async () => {
    const filePath = path.join(tmpDir, 'test.json');
    await atomicWriteJSON(filePath, { ok: true });

    const files = await fs.readdir(tmpDir);
    expect(files).toEqual(['test.json']);
  });

  it('should throw if parent directory does not exist', async () => {
    const filePath = path.join(tmpDir, 'nonexistent', 'test.json');
    await expect(atomicWriteJSON(filePath, {})).rejects.toThrow();
  });
});

describe('atomicWriteFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'atomic-write-file-test-'),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should write string content to a new file', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await atomicWriteFile(filePath, 'hello world');

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('hello world');
  });

  it('should write Buffer content to a new file', async () => {
    const filePath = path.join(tmpDir, 'test.bin');
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    await atomicWriteFile(filePath, buf);

    const content = await fs.readFile(filePath);
    expect(content).toEqual(buf);
  });

  it.skipIf(process.platform === 'win32')(
    'should preserve existing file permissions',
    async () => {
      const filePath = path.join(tmpDir, 'test.txt');
      await fs.writeFile(filePath, 'original');
      await fs.chmod(filePath, 0o600);

      await atomicWriteFile(filePath, 'updated');

      const stat = await fs.stat(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('updated');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'should apply explicit mode option for new files',
    async () => {
      const filePath = path.join(tmpDir, 'secret.txt');
      await atomicWriteFile(filePath, 'secret', { mode: 0o600 });

      const stat = await fs.stat(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    },
  );

  it('should not leave temp files on success', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await atomicWriteFile(filePath, 'content');

    const files = await fs.readdir(tmpDir);
    expect(files).toEqual(['test.txt']);
  });

  it('should clean up temp file when write fails', async () => {
    // Writing to a path whose parent doesn't exist will fail
    const filePath = path.join(tmpDir, 'nonexistent', 'test.txt');
    await expect(atomicWriteFile(filePath, 'data')).rejects.toThrow();

    const files = await fs.readdir(tmpDir);
    expect(files).toEqual([]);
  });

  it('should overwrite existing file atomically', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await atomicWriteFile(filePath, 'version 1');
    await atomicWriteFile(filePath, 'version 2');

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('version 2');
  });

  it('should respect encoding option', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await atomicWriteFile(filePath, 'café', { encoding: 'utf-8' });

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('café');
  });

  it('should resolve symlinks and write to the real target', async () => {
    const realFile = path.join(tmpDir, 'real.txt');
    const linkFile = path.join(tmpDir, 'link.txt');

    await fs.writeFile(realFile, 'original');
    await fs.symlink(realFile, linkFile);

    await atomicWriteFile(linkFile, 'updated via symlink');

    // The symlink should still exist and point to the real file.
    const linkTarget = await fs.readlink(linkFile);
    expect(linkTarget).toBe(realFile);

    // The real file should have the updated content.
    const content = await fs.readFile(realFile, 'utf-8');
    expect(content).toBe('updated via symlink');
  });

  it('should write through a broken symlink without replacing it', async () => {
    const realFile = path.join(tmpDir, 'target.txt');
    const linkFile = path.join(tmpDir, 'broken-link.txt');

    // Create a symlink whose target does not exist yet.
    await fs.symlink(realFile, linkFile);

    await atomicWriteFile(linkFile, 'created via broken symlink');

    // The symlink should still exist and point to the target.
    const linkTarget = await fs.readlink(linkFile);
    expect(linkTarget).toBe(realFile);

    // The real target file should have been created with the content.
    const content = await fs.readFile(realFile, 'utf-8');
    expect(content).toBe('created via broken symlink');
  });

  it('should resolve relative symlinks against the symlink directory', async () => {
    const realFile = path.join(tmpDir, 'real.txt');
    const linkFile = path.join(tmpDir, 'link.txt');

    await fs.writeFile(realFile, 'original');
    await fs.symlink('real.txt', linkFile); // relative target

    await atomicWriteFile(linkFile, 'updated via relative symlink');

    // The symlink should still exist.
    const linkTarget = await fs.readlink(linkFile);
    expect(linkTarget).toBe('real.txt');

    // The real file should have the updated content.
    const content = await fs.readFile(realFile, 'utf-8');
    expect(content).toBe('updated via relative symlink');
  });

  it('should resolve multi-level symlink chains', async () => {
    const realFile = path.join(tmpDir, 'real.txt');
    const linkA = path.join(tmpDir, 'link-a.txt');
    const linkB = path.join(tmpDir, 'link-b.txt');

    await fs.writeFile(realFile, 'original');
    await fs.symlink(realFile, linkA); // linkA → real
    await fs.symlink(linkA, linkB); // linkB → linkA → real

    await atomicWriteFile(linkB, 'updated via chain');

    // Both symlinks should still exist.
    expect(await fs.readlink(linkB)).toBe(linkA);
    expect(await fs.readlink(linkA)).toBe(realFile);

    // The real file should have the updated content.
    const content = await fs.readFile(realFile, 'utf-8');
    expect(content).toBe('updated via chain');
  });

  it('should throw if parent directory does not exist', async () => {
    const filePath = path.join(tmpDir, 'no', 'such', 'dir', 'file.txt');
    await expect(atomicWriteFile(filePath, 'data')).rejects.toThrow();
  });

  it('should resolve relative symlink targets through directory symlinks', async () => {
    // Set up: tmpDir/realDir/file.txt is a symlink to ../target.txt
    //         tmpDir/linkDir is a symlink to realDir
    // Writing via tmpDir/linkDir/file.txt should resolve correctly to
    // tmpDir/target.txt (NOT tmpDir/target.txt via string-only dirname,
    // which would happen to be the same here — so we use a more tricky setup)
    const realDir = path.join(tmpDir, 'realDir');
    const otherDir = path.join(tmpDir, 'otherDir');
    const targetFile = path.join(otherDir, 'target.txt');
    const linkInRealDir = path.join(realDir, 'file.txt');
    const linkDir = path.join(tmpDir, 'linkDir');

    await fs.mkdir(realDir);
    await fs.mkdir(otherDir);
    await fs.writeFile(targetFile, 'original');
    // file.txt → ../otherDir/target.txt (relative to its parent)
    await fs.symlink('../otherDir/target.txt', linkInRealDir);
    // linkDir → realDir (directory symlink)
    await fs.symlink(realDir, linkDir);

    // Write via the path that goes through the directory symlink.
    await atomicWriteFile(
      path.join(linkDir, 'file.txt'),
      'updated via dir symlink',
    );

    // Should have updated the real target through both symlinks.
    const content = await fs.readFile(targetFile, 'utf-8');
    expect(content).toBe('updated via dir symlink');
    // Symlinks themselves should be intact (normalize for Windows path separators).
    expect(path.normalize(await fs.readlink(linkDir))).toBe(
      path.normalize(realDir),
    );
    expect(path.normalize(await fs.readlink(linkInRealDir))).toBe(
      path.normalize('../otherDir/target.txt'),
    );
  });

  it.skipIf(process.platform === 'win32')(
    'should use atomic rename when ownership matches (inode changes)',
    async () => {
      const filePath = path.join(tmpDir, 'mine.txt');
      await fs.writeFile(filePath, 'original');
      const inoBefore = (await fs.stat(filePath)).ino;

      await atomicWriteFile(filePath, 'updated');

      const statAfter = await fs.stat(filePath);
      // Atomic rename produces a new inode.
      expect(statAfter.ino).not.toBe(inoBefore);
      expect(await fs.readFile(filePath, 'utf-8')).toBe('updated');
    },
  );

  it.skipIf(
    process.platform === 'win32' || typeof process.geteuid !== 'function',
  )(
    'should fall back to in-place write when atomic rename would change ownership',
    async () => {
      // Simulate a file owned by a different user by replacing process.geteuid
      // so it reports a uid that doesn't match the file's real uid. The code
      // should detect rename would strip ownership and fall back to in-place
      // writeFile, which preserves the inode — our signal that fallback ran.
      const filePath = path.join(tmpDir, 'shared.txt');
      await fs.writeFile(filePath, 'original');
      await fs.chmod(filePath, 0o664);

      const realStat = await fs.stat(filePath);
      const inoBefore = realStat.ino;
      const realGeteuid = process.geteuid!;
      process.geteuid = () => realStat.uid + 1;

      try {
        await atomicWriteFile(filePath, 'updated');
      } finally {
        process.geteuid = realGeteuid;
      }

      expect(await fs.readFile(filePath, 'utf-8')).toBe('updated');

      const statAfter = await fs.stat(filePath);
      // In-place write preserves the inode — proves rename was skipped.
      expect(statAfter.ino).toBe(inoBefore);
      // Permissions preserved.
      expect(statAfter.mode & 0o777).toBe(0o664);
      // No leftover temp file.
      expect(await fs.readdir(tmpDir)).toEqual(['shared.txt']);
    },
  );

  it.skipIf(
    process.platform === 'win32' || typeof process.getegid !== 'function',
  )(
    'should fall back to in-place write when group differs from process gid',
    async () => {
      // Same scenario triggered via gid mismatch.
      const filePath = path.join(tmpDir, 'shared-group.txt');
      await fs.writeFile(filePath, 'original');
      await fs.chmod(filePath, 0o664);

      const realStat = await fs.stat(filePath);
      const inoBefore = realStat.ino;
      const realGetegid = process.getegid!;
      process.getegid = () => realStat.gid + 1;

      try {
        await atomicWriteFile(filePath, 'updated');
      } finally {
        process.getegid = realGetegid;
      }

      const statAfter = await fs.stat(filePath);
      expect(statAfter.ino).toBe(inoBefore);
      expect(await fs.readFile(filePath, 'utf-8')).toBe('updated');
      // Permissions preserved (parity with uid-mismatch test).
      expect(statAfter.mode & 0o777).toBe(0o664);
      // No leftover temp file (parity with uid-mismatch test).
      expect(await fs.readdir(tmpDir)).toEqual(['shared-group.txt']);
    },
  );

  it.skipIf(
    process.platform === 'win32' || typeof process.geteuid !== 'function',
  )(
    'should skip in-place fallback for non-regular files and use atomic replace',
    async () => {
      // FIFO + ownership mismatch must NOT take the in-place fallback —
      // open(O_WRONLY|O_TRUNC) against a FIFO would block forever
      // waiting for a reader. The atomic rename path instead replaces
      // the FIFO with a regular file, which is the only sane behavior
      // for "write to this path" semantics on a special file.
      const { execSync } = await import('node:child_process');
      const fifoPath = path.join(tmpDir, 'pipe.fifo');
      execSync(`mkfifo "${fifoPath}"`);

      const realStat = await fs.stat(fifoPath);
      expect(realStat.isFIFO()).toBe(true);

      const realGeteuid = process.geteuid!;
      process.geteuid = () => realStat.uid + 1;

      try {
        // If the in-place fallback were taken, this would hang
        // indefinitely. Vitest's default timeout will catch that.
        await atomicWriteFile(fifoPath, 'content');
      } finally {
        process.geteuid = realGeteuid;
      }

      // Atomic path replaced the FIFO with a regular file.
      const statAfter = await fs.stat(fifoPath);
      expect(statAfter.isFile()).toBe(true);
      expect(await fs.readFile(fifoPath, 'utf-8')).toBe('content');
    },
  );

  it.skipIf(
    process.platform === 'win32' || typeof process.geteuid !== 'function',
  )(
    'should write via in-place fallback through a resolved symlink when ownership differs',
    async () => {
      // atomicWriteFile resolves the symlink via resolveSymlinkChain
      // before stat, so by the time writeInPlaceWithFdGuards runs the
      // target is already the real file. This test exercises the
      // resolve-then-stat-then-open flow and verifies the symlink itself
      // is preserved (not replaced by a regular file). The direct
      // O_NOFOLLOW-rejects-symlink case is tested separately below via
      // writeInPlaceWithFdGuards directly.
      const realFile = path.join(tmpDir, 'real.txt');
      const symlinkAt = path.join(tmpDir, 'attacker-symlink.txt');
      await fs.writeFile(realFile, 'real-content');
      await fs.symlink(realFile, symlinkAt);

      const realGeteuid = process.geteuid!;
      const realStat = await fs.stat(realFile);
      process.geteuid = () => realStat.uid + 1;

      try {
        await atomicWriteFile(symlinkAt, 'updated');
      } finally {
        process.geteuid = realGeteuid;
      }

      // The real file is updated; the symlink itself is preserved.
      expect(await fs.readFile(realFile, 'utf-8')).toBe('updated');
      expect((await fs.lstat(symlinkAt)).isSymbolicLink()).toBe(true);
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
      // Atomic rename used to silently replace files the calling user
      // has no write permission on (rename only needs parent-dir write).
      // The in-place fallback respects the file's mode and surfaces
      // EACCES — the correct behavior for "you don't own this, you
      // shouldn't be replacing it" scenarios.
      const filePath = path.join(tmpDir, 'readonly.txt');
      await fs.writeFile(filePath, 'original');
      await fs.chmod(filePath, 0o444);

      const realStat = await fs.stat(filePath);
      const realGeteuid = process.geteuid!;
      process.geteuid = () => realStat.uid + 1;

      try {
        await expect(atomicWriteFile(filePath, 'updated')).rejects.toThrow(
          /EACCES/,
        );
      } finally {
        process.geteuid = realGeteuid;
        // Restore mode so afterEach's rm can clean up.
        await fs.chmod(filePath, 0o644);
      }

      // Original content untouched.
      expect(await fs.readFile(filePath, 'utf-8')).toBe('original');
    },
  );
});

describe('writeInPlaceWithFdGuards', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fd-guards-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'should write content and preserve inode on the happy path (stat matches)',
    async () => {
      // Primary contract: when the stat matches at open time, the helper
      // truncates + writes + chmods through the fd, preserving the
      // existing inode.
      const filePath = path.join(tmpDir, 'happy.txt');
      await fs.writeFile(filePath, 'original-much-longer-than-replacement');
      await fs.chmod(filePath, 0o644);
      const beforeStat = await fs.stat(filePath);

      await writeInPlaceWithFdGuards(filePath, 'updated', beforeStat, {
        encoding: 'utf-8',
        flush: true,
        mode: 0o644,
      });

      const afterStat = await fs.stat(filePath);
      expect(afterStat.ino).toBe(beforeStat.ino);
      expect(await fs.readFile(filePath, 'utf-8')).toBe('updated');
      expect(afterStat.mode & 0o777).toBe(0o644);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'should throw ENOENT (not silently recreate) when target was unlinked after stat',
    async () => {
      // Regression test for the missing-O_CREAT security property:
      // if the file disappears between caller stat and our open, we
      // must surface ENOENT instead of recreating a file owned by the
      // current process (which is exactly the ownership reset the
      // fallback exists to prevent).
      const filePath = path.join(tmpDir, 'will-be-unlinked.txt');
      await fs.writeFile(filePath, 'original');
      const staleStat = await fs.stat(filePath);

      await fs.unlink(filePath);

      await expect(
        writeInPlaceWithFdGuards(filePath, 'should-not-recreate', staleStat, {
          encoding: 'utf-8',
        }),
      ).rejects.toThrow(/ENOENT/);

      // Confirm the file was not recreated.
      await expect(fs.stat(filePath)).rejects.toThrow(/ENOENT/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'should throw EOWNERSHIP_CHANGED when the inode at the path was swapped between caller stat and open',
    async () => {
      // Simulate the post-stat swap by capturing a stat, then renaming
      // a different file over the original. rename guarantees a fresh
      // inode at the path (unlike unlink+create, which on Linux tmpfs
      // often reuses the freshly-freed inode number).
      const filePath = path.join(tmpDir, 'race.txt');
      const decoyPath = path.join(tmpDir, 'decoy.txt');
      await fs.writeFile(filePath, 'original');
      const staleStat = await fs.stat(filePath);

      // Create a separate inode and rename it over the target. The
      // target now holds the decoy's inode (guaranteed different from
      // staleStat.ino — they were two distinct live files just now).
      await fs.writeFile(decoyPath, 'attacker-content');
      await fs.rename(decoyPath, filePath);

      const sanity = await fs.stat(filePath);
      expect(sanity.ino).not.toBe(staleStat.ino);

      await expect(
        writeInPlaceWithFdGuards(filePath, 'should-not-land', staleStat, {
          encoding: 'utf-8',
          flush: true,
        }),
      ).rejects.toThrow(/swapped between stat and open/);

      // Attacker's content survives — our write was refused.
      expect(await fs.readFile(filePath, 'utf-8')).toBe('attacker-content');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'should not hang and must refuse the write when path is a FIFO at open time',
    async () => {
      // Caller might pass an expectedStat captured for a regular file,
      // but the path has been swapped to a FIFO post-stat. Defense in
      // depth: O_NONBLOCK makes open() fail fast with ENXIO on a
      // reader-less FIFO; if a reader were present and open succeeded,
      // the fstat isFile() check would still catch it. Either way the
      // helper must NOT hang and must NOT write to the special file.
      //
      // Pass a stat captured from the FIFO itself so the inode/dev
      // match and only the FIFO-specific defense (ENXIO from O_NONBLOCK,
      // or !isFile() from fstat) can fire — not the dev/ino mismatch
      // from passing a stale regular-file stat.
      const { execSync } = await import('node:child_process');
      const fifoPath = path.join(tmpDir, 'pipe.fifo');
      execSync(`mkfifo "${fifoPath}"`);
      const fifoStat = await fs.stat(fifoPath);

      // Accept either ENXIO (open failed fast — preferred) or
      // EOWNERSHIP_CHANGED (open succeeded with a reader, fstat caught
      // it via !isFile()). Both prove the FIFO race window is closed.
      await expect(
        writeInPlaceWithFdGuards(fifoPath, 'should-not-land', fifoStat, {
          encoding: 'utf-8',
          flush: true,
        }),
      ).rejects.toThrow(/ENXIO|swapped between stat and open/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'should reject a symlink at the target with ELOOP via O_NOFOLLOW',
    async () => {
      // Direct test of the O_NOFOLLOW guard: if the path resolves to a
      // symlink at open time (without resolveSymlinkChain pre-resolving
      // it), the open must fail rather than follow to an
      // attacker-chosen target.
      if (fs.constants.O_NOFOLLOW === undefined) return;

      const realFile = path.join(tmpDir, 'real.txt');
      const symlinkPath = path.join(tmpDir, 'a-symlink.txt');
      await fs.writeFile(realFile, 'real-content');
      await fs.symlink(realFile, symlinkPath);

      const symlinkLstat = await fs.lstat(symlinkPath);

      await expect(
        writeInPlaceWithFdGuards(
          symlinkPath,
          'should-not-follow',
          symlinkLstat as Stats,
          { encoding: 'utf-8' },
        ),
      ).rejects.toThrow(/ELOOP|EMLINK|symlink/i);

      // The real file (symlink's target) must not have been touched.
      expect(await fs.readFile(realFile, 'utf-8')).toBe('real-content');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'should wrap fh.writeFile failure as EINPLACE_WRITE_FAILED after truncate',
    async () => {
      // Trigger the data-loss path: truncate succeeds, then writeFile
      // throws. Verify the error is wrapped with EINPLACE_WRITE_FAILED
      // + cause, and the file is observably empty (truncate ran).
      const filePath = path.join(tmpDir, 'will-be-truncated.txt');
      await fs.writeFile(filePath, 'original content longer than zero');
      const beforeStat = await fs.stat(filePath);

      // Monkey-patch FileHandle.prototype.writeFile to fail. Use an
      // open handle to find the prototype, then restore after the test.
      const probeFh = await fs.open(filePath, 'r');
      const FileHandleProto = Object.getPrototypeOf(probeFh);
      const origWriteFile = FileHandleProto.writeFile;
      await probeFh.close();

      FileHandleProto.writeFile =
        async function mockWriteFile(): Promise<void> {
          const err: NodeJS.ErrnoException = new Error('mock ENOSPC');
          err.code = 'ENOSPC';
          throw err;
        };

      try {
        await expect(
          writeInPlaceWithFdGuards(filePath, 'updated', beforeStat, {
            encoding: 'utf-8',
          }),
        ).rejects.toMatchObject({
          code: 'EINPLACE_WRITE_FAILED',
          message: expect.stringMatching(/empty or partially written/),
          cause: expect.objectContaining({ code: 'ENOSPC' }),
        });
      } finally {
        FileHandleProto.writeFile = origWriteFile;
      }

      // truncate ran before writeFile threw — file is now empty.
      expect((await fs.stat(filePath)).size).toBe(0);
    },
  );

  it.skipIf(
    process.platform === 'win32' || typeof process.geteuid !== 'function',
  )(
    'should actually skip chmod (not just no-op set to same mode) when canChmod is false',
    async () => {
      // The skip-when-non-root optimization fires when euid is neither
      // root nor the file owner. Pass a desiredMode that differs from
      // the file's current mode so we can observe the skip via the
      // file's final mode being unchanged.
      const filePath = path.join(tmpDir, 'skip-chmod.txt');
      await fs.writeFile(filePath, 'original');
      await fs.chmod(filePath, 0o644);
      const beforeStat = await fs.stat(filePath);

      // Mock geteuid to a "foreign" uid so canChmod=false.
      const realGeteuid = process.geteuid!;
      process.geteuid = () => beforeStat.uid + 1;

      try {
        await writeInPlaceWithFdGuards(filePath, 'updated', beforeStat, {
          encoding: 'utf-8',
          mode: 0o755, // intentionally different from 0o644
        });
      } finally {
        process.geteuid = realGeteuid;
      }

      // Write went through, but chmod was skipped — mode stays at 0o644.
      expect(await fs.readFile(filePath, 'utf-8')).toBe('updated');
      const afterStat = await fs.stat(filePath);
      expect(afterStat.mode & 0o777).toBe(0o644);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'should wrap fh.truncate failure as EINPLACE_TRUNCATE_FAILED with original content intact',
    async () => {
      // Sibling test to EINPLACE_WRITE_FAILED. truncate failing means
      // the original content is still intact — verify the error code
      // and that the file's bytes are unchanged.
      const filePath = path.join(tmpDir, 'truncate-fail.txt');
      const original = 'original content that must survive';
      await fs.writeFile(filePath, original);
      const beforeStat = await fs.stat(filePath);

      const probeFh = await fs.open(filePath, 'r');
      const FileHandleProto = Object.getPrototypeOf(probeFh);
      const origTruncate = FileHandleProto.truncate;
      await probeFh.close();

      FileHandleProto.truncate = async function mockTruncate(): Promise<void> {
        const err: NodeJS.ErrnoException = new Error('mock EIO');
        err.code = 'EIO';
        throw err;
      };

      try {
        await expect(
          writeInPlaceWithFdGuards(filePath, 'should-not-land', beforeStat, {
            encoding: 'utf-8',
          }),
        ).rejects.toMatchObject({
          code: 'EINPLACE_TRUNCATE_FAILED',
          message: expect.stringMatching(/original content is intact/),
          cause: expect.objectContaining({ code: 'EIO' }),
        });
      } finally {
        FileHandleProto.truncate = origTruncate;
      }

      // Original content must be intact since truncate failed.
      expect(await fs.readFile(filePath, 'utf-8')).toBe(original);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'should write Buffer data correctly through in-place fallback',
    async () => {
      // String tests above don't exercise the Buffer code path. If a
      // future refactor passes encoding through for Buffer data, binary
      // content would be corrupted; this test locks in binary fidelity.
      const filePath = path.join(tmpDir, 'binary.bin');
      const original = Buffer.from([0xff, 0xfe, 0xfd]);
      await fs.writeFile(filePath, original);
      const beforeStat = await fs.stat(filePath);

      const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
      await writeInPlaceWithFdGuards(filePath, buf, beforeStat, {
        flush: true,
      });

      // Byte-exact comparison.
      const written = await fs.readFile(filePath);
      expect(Buffer.compare(written, buf)).toBe(0);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'should call fh.sync() when flush:true and skip it when flush is absent',
    async () => {
      const filePath = path.join(tmpDir, 'sync-guard.txt');
      await fs.writeFile(filePath, 'original');
      const beforeStat = await fs.stat(filePath);

      const probeFh = await fs.open(filePath, 'r');
      const FileHandleProto = Object.getPrototypeOf(probeFh);
      const origSync = FileHandleProto.sync;
      await probeFh.close();

      let syncCallCount = 0;
      FileHandleProto.sync = async function mockSync(): Promise<void> {
        syncCallCount++;
        return origSync.call(this);
      };

      try {
        await writeInPlaceWithFdGuards(filePath, 'with-flush', beforeStat, {
          encoding: 'utf-8',
          flush: true,
        });
        expect(syncCallCount).toBeGreaterThanOrEqual(1);

        const stat2 = await fs.stat(filePath);
        syncCallCount = 0;
        await writeInPlaceWithFdGuards(filePath, 'no-flush', stat2, {
          encoding: 'utf-8',
        });
        expect(syncCallCount).toBe(0);
      } finally {
        FileHandleProto.sync = origSync;
      }
    },
  );
});
