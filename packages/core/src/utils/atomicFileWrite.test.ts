/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { atomicWriteFile, atomicWriteJSON } from './atomicFileWrite.js';

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
      // before stat, so the in-place write targets the real file.
      // Verifies the symlink itself is preserved.
      const realFile = path.join(tmpDir, 'real.txt');
      const symlinkAt = path.join(tmpDir, 'attacker-symlink.txt');
      await fs.writeFile(realFile, 'real-content');
      await fs.symlink(realFile, symlinkAt);

      const realGeteuid = process.geteuid!;
      const realStat = await fs.stat(realFile);
      const inoBefore = realStat.ino;
      process.geteuid = () => realStat.uid + 1;

      try {
        await atomicWriteFile(symlinkAt, 'updated');
      } finally {
        process.geteuid = realGeteuid;
      }

      // The real file is updated; the symlink itself is preserved.
      expect(await fs.readFile(realFile, 'utf-8')).toBe('updated');
      expect((await fs.stat(realFile)).ino).toBe(inoBefore);
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
