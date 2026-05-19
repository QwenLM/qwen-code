/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  atomicWriteFile,
  atomicWriteFileSync,
  atomicWriteJSON,
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
});

describe('atomicWriteFileSync', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'atomic-write-sync-test-'),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should write string content to a new file', () => {
    const filePath = path.join(tmpDir, 'test.txt');
    atomicWriteFileSync(filePath, 'hello sync');

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('hello sync');
  });

  it('should write Buffer content to a new file', () => {
    const filePath = path.join(tmpDir, 'test.bin');
    const buf = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
    atomicWriteFileSync(filePath, buf);

    expect(fsSync.readFileSync(filePath)).toEqual(buf);
  });

  it.skipIf(process.platform === 'win32')(
    'should preserve existing file permissions',
    () => {
      const filePath = path.join(tmpDir, 'test.txt');
      fsSync.writeFileSync(filePath, 'original');
      fsSync.chmodSync(filePath, 0o600);

      atomicWriteFileSync(filePath, 'updated');

      expect(fsSync.statSync(filePath).mode & 0o777).toBe(0o600);
      expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('updated');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'should apply explicit mode option for new files',
    () => {
      const filePath = path.join(tmpDir, 'secret.txt');
      atomicWriteFileSync(filePath, 'secret', { mode: 0o600 });

      expect(fsSync.statSync(filePath).mode & 0o777).toBe(0o600);
    },
  );

  it('should not leave temp files on success', () => {
    const filePath = path.join(tmpDir, 'test.txt');
    atomicWriteFileSync(filePath, 'content');

    expect(fsSync.readdirSync(tmpDir)).toEqual(['test.txt']);
  });

  it('should clean up temp file when write fails', () => {
    const filePath = path.join(tmpDir, 'nonexistent', 'test.txt');
    expect(() => atomicWriteFileSync(filePath, 'data')).toThrow();

    expect(fsSync.readdirSync(tmpDir)).toEqual([]);
  });

  it('should overwrite existing file atomically', () => {
    const filePath = path.join(tmpDir, 'test.txt');
    atomicWriteFileSync(filePath, 'v1');
    atomicWriteFileSync(filePath, 'v2');

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('v2');
  });

  it('should respect encoding option', () => {
    const filePath = path.join(tmpDir, 'test.txt');
    atomicWriteFileSync(filePath, 'café', { encoding: 'utf-8' });

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('café');
  });

  it('should resolve symlinks and write to the real target', () => {
    const realFile = path.join(tmpDir, 'real.txt');
    const linkFile = path.join(tmpDir, 'link.txt');

    fsSync.writeFileSync(realFile, 'original');
    fsSync.symlinkSync(realFile, linkFile);

    atomicWriteFileSync(linkFile, 'updated via symlink');

    expect(fsSync.readlinkSync(linkFile)).toBe(realFile);
    expect(fsSync.readFileSync(realFile, 'utf-8')).toBe('updated via symlink');
  });

  it('should write through a broken symlink without replacing it', () => {
    const realFile = path.join(tmpDir, 'target.txt');
    const linkFile = path.join(tmpDir, 'broken-link.txt');

    fsSync.symlinkSync(realFile, linkFile);

    atomicWriteFileSync(linkFile, 'created via broken symlink');

    expect(fsSync.readlinkSync(linkFile)).toBe(realFile);
    expect(fsSync.readFileSync(realFile, 'utf-8')).toBe(
      'created via broken symlink',
    );
  });

  it('should resolve multi-level symlink chains', () => {
    const realFile = path.join(tmpDir, 'real.txt');
    const linkA = path.join(tmpDir, 'link-a.txt');
    const linkB = path.join(tmpDir, 'link-b.txt');

    fsSync.writeFileSync(realFile, 'original');
    fsSync.symlinkSync(realFile, linkA);
    fsSync.symlinkSync(linkA, linkB);

    atomicWriteFileSync(linkB, 'updated via chain');

    expect(fsSync.readlinkSync(linkB)).toBe(linkA);
    expect(fsSync.readlinkSync(linkA)).toBe(realFile);
    expect(fsSync.readFileSync(realFile, 'utf-8')).toBe('updated via chain');
  });

  it('should throw if parent directory does not exist', () => {
    const filePath = path.join(tmpDir, 'no', 'such', 'dir', 'file.txt');
    expect(() => atomicWriteFileSync(filePath, 'data')).toThrow();
  });
});

describe('forceMode option', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'force-mode-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'atomicWriteFile: forceMode tightens an over-permissive existing file',
    async () => {
      const filePath = path.join(tmpDir, 'creds.json');
      await fs.writeFile(filePath, 'old');
      await fs.chmod(filePath, 0o644); // legacy bad perms

      await atomicWriteFile(filePath, 'new', {
        mode: 0o600,
        forceMode: true,
      });

      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'atomicWriteFile: without forceMode, existing 0o644 is preserved',
    async () => {
      const filePath = path.join(tmpDir, 'creds.json');
      await fs.writeFile(filePath, 'old');
      await fs.chmod(filePath, 0o644);

      await atomicWriteFile(filePath, 'new', { mode: 0o600 });

      // Existing mode wins — documented default behavior.
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o644);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'atomicWriteFileSync: forceMode tightens an over-permissive existing file',
    () => {
      const filePath = path.join(tmpDir, 'creds.json');
      fsSync.writeFileSync(filePath, 'old');
      fsSync.chmodSync(filePath, 0o644);

      atomicWriteFileSync(filePath, 'new', {
        mode: 0o600,
        forceMode: true,
      });

      expect(fsSync.statSync(filePath).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'forceMode without mode preserves existing permissions (does not drop to umask)',
    async () => {
      const filePath = path.join(tmpDir, 'file.txt');
      await fs.writeFile(filePath, 'old');
      await fs.chmod(filePath, 0o600);

      // forceMode:true without mode is meaningless (nothing to force) — must
      // not silently downgrade to umask default. Regression: pre-fix this
      // dropped the file to 0o644 because forceMode skipped the stat.
      await atomicWriteFile(filePath, 'new', { forceMode: true });

      expect(await fs.readFile(filePath, 'utf-8')).toBe('new');
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'atomicWriteFileSync: forceMode without mode preserves existing permissions',
    () => {
      const filePath = path.join(tmpDir, 'file.txt');
      fsSync.writeFileSync(filePath, 'old');
      fsSync.chmodSync(filePath, 0o600);

      atomicWriteFileSync(filePath, 'new', { forceMode: true });

      expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('new');
      expect(fsSync.statSync(filePath).mode & 0o777).toBe(0o600);
    },
  );
});
