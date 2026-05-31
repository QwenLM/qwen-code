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

// PR #4333 review fold-in: cover rename-retry + EXDEV-fallback paths the
// existing behavior tests can't exercise (vitest can't spy on ESM exports
// of node:fs). Uses the `_testFs` / `_renameImpl` seams added to the
// production helpers.
describe('renameWithRetry (async, dependency-injected rename)', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-retry-async-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('retries on EPERM and eventually succeeds', async () => {
    const src = path.join(tmpDir, 'src.txt');
    const dest = path.join(tmpDir, 'dest.txt');
    await fs.writeFile(src, 'data');

    let attempts = 0;
    const mockRename = async (s: string, d: string) => {
      attempts++;
      if (attempts < 3) {
        const e: NodeJS.ErrnoException = new Error('EPERM');
        e.code = 'EPERM';
        throw e;
      }
      await fs.rename(s, d);
    };

    await renameWithRetry(src, dest, 3, 1, mockRename);
    expect(attempts).toBe(3);
    expect(fsSync.existsSync(dest)).toBe(true);
  });

  it('gives up after retries exhausted', async () => {
    let attempts = 0;
    const mockRename = async () => {
      attempts++;
      const e: NodeJS.ErrnoException = new Error('EPERM');
      e.code = 'EPERM';
      throw e;
    };
    await expect(renameWithRetry('s', 'd', 2, 1, mockRename)).rejects.toThrow(
      /EPERM/,
    );
    expect(attempts).toBe(3); // initial attempt + 2 retries
  });

  it('does not retry on non-retryable errors (ENOSPC)', async () => {
    let attempts = 0;
    const mockRename = async () => {
      attempts++;
      const e: NodeJS.ErrnoException = new Error('ENOSPC');
      e.code = 'ENOSPC';
      throw e;
    };
    await expect(renameWithRetry('s', 'd', 3, 1, mockRename)).rejects.toThrow(
      /ENOSPC/,
    );
    expect(attempts).toBe(1);
  });

  // The existing tests cover retry count + error propagation but not the
  // backoff curve itself. A regression that swapped `delayMs * 2 ** attempt`
  // for linear, constant, or — worst — regressive backoff (which intensifies
  // under Windows AV-scan stress) would pass every other test. Fake timers
  // make the assertion deterministic without burning real wall-clock time.
  it('backs off exponentially: delayMs, 2*delayMs, 4*delayMs, ...', async () => {
    vi.useFakeTimers();
    try {
      const gaps: number[] = [];
      let lastInvocation = Date.now();
      const mockRename = async () => {
        const now = Date.now();
        gaps.push(now - lastInvocation);
        lastInvocation = now;
        const e: NodeJS.ErrnoException = new Error('EPERM');
        e.code = 'EPERM';
        throw e;
      };

      const promise = renameWithRetry('s', 'd', 3, 50, mockRename);
      // Catch eventual rejection so unhandled-rejection doesn't fire.
      promise.catch(() => {});

      // 4 invocations total (initial + 3 retries), gaps after the
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
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-retry-sync-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('retries on EACCES and succeeds', () => {
    const src = path.join(tmpDir, 'src.txt');
    const dest = path.join(tmpDir, 'dest.txt');
    fsSync.writeFileSync(src, 'data');

    let attempts = 0;
    const mockRename = (s: string, d: string) => {
      attempts++;
      if (attempts < 3) {
        const e: NodeJS.ErrnoException = new Error('EACCES');
        e.code = 'EACCES';
        throw e;
      }
      fsSync.renameSync(s, d);
    };

    renameWithRetrySync(src, dest, 3, 1, mockRename);
    expect(attempts).toBe(3);
    expect(fsSync.existsSync(dest)).toBe(true);
  });

  it('gives up after retries exhausted', () => {
    let attempts = 0;
    const mockRename = () => {
      attempts++;
      const e: NodeJS.ErrnoException = new Error('EPERM');
      e.code = 'EPERM';
      throw e;
    };
    expect(() => renameWithRetrySync('s', 'd', 2, 1, mockRename)).toThrow(
      /EPERM/,
    );
    expect(attempts).toBe(3);
  });

  it('does not retry on non-retryable errors (EINVAL)', () => {
    let attempts = 0;
    const mockRename = () => {
      attempts++;
      const e: NodeJS.ErrnoException = new Error('EINVAL');
      e.code = 'EINVAL';
      throw e;
    };
    expect(() => renameWithRetrySync('s', 'd', 3, 1, mockRename)).toThrow(
      /EINVAL/,
    );
    expect(attempts).toBe(1);
  });
});

describe('EXDEV fallback (async + sync)', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exdev-fallback-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('atomicWriteFile: falls back to direct write on EXDEV, cleans up tmp', async () => {
    const filePath = path.join(tmpDir, 'exdev.txt');
    const exdevRename = async () => {
      const e: NodeJS.ErrnoException = new Error('EXDEV');
      e.code = 'EXDEV';
      throw e;
    };

    await atomicWriteFile(filePath, 'fallback-payload', undefined, {
      rename: exdevRename,
    });

    expect(await fs.readFile(filePath, 'utf-8')).toBe('fallback-payload');
    // No tmp residue
    expect(await fs.readdir(tmpDir)).toEqual(['exdev.txt']);
  });

  it('atomicWriteFileSync: falls back to direct write on EXDEV, cleans up tmp', () => {
    const filePath = path.join(tmpDir, 'exdev-sync.txt');
    const exdevRename = () => {
      const e: NodeJS.ErrnoException = new Error('EXDEV');
      e.code = 'EXDEV';
      throw e;
    };

    atomicWriteFileSync(filePath, 'sync-fallback-payload', undefined, {
      rename: exdevRename,
    });

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe(
      'sync-fallback-payload',
    );
    expect(fsSync.readdirSync(tmpDir)).toEqual(['exdev-sync.txt']);
  });

  it('atomicWriteFile: non-EXDEV rename failure propagates (no fallback)', async () => {
    const filePath = path.join(tmpDir, 'eio.txt');
    const eioRename = async () => {
      const e: NodeJS.ErrnoException = new Error('EIO');
      e.code = 'EIO';
      throw e;
    };

    await expect(
      atomicWriteFile(filePath, 'data', undefined, { rename: eioRename }),
    ).rejects.toThrow(/atomicWriteFile\(.*eio\.txt.*\):.*EIO/);
    // Tmp cleaned up even though rename failed
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it('atomicWriteFileSync: non-EXDEV rename failure propagates and cleans up tmp', () => {
    // Mirror of the async EIO test above — review fold-in: sync variant
    // had the same `unlinkSync + re-throw` path but no test exercising
    // it (the previous "should clean up temp file when write fails"
    // test only covered writeFileSync failure before rename).
    const filePath = path.join(tmpDir, 'eio-sync.txt');
    const eioRename = () => {
      const e: NodeJS.ErrnoException = new Error('EIO');
      e.code = 'EIO';
      throw e;
    };

    expect(() =>
      atomicWriteFileSync(filePath, 'data', undefined, { rename: eioRename }),
    ).toThrow(/atomicWriteFileSync\(.*eio-sync\.txt.*\):.*EIO/);
    expect(fsSync.readdirSync(tmpDir)).toEqual([]);
  });

  it('atomicWriteFile: annotates errors whose message contains the target path (startsWith guard, not includes)', async () => {
    // Guards the documented idempotency-guard bug: it once used
    // `message.includes(targetPath)`, but real syscall errors embed the
    // *tmp* path (which contains the target as a substring), so annotation
    // was silently skipped on every real failure. Here the rename error
    // message embeds a tmp-style path containing the target; with the
    // correct `startsWith` guard the message is still annotated. Reverting
    // to the `includes` guard would skip annotation and fail this test.
    const filePath = path.join(tmpDir, 'pathinmsg.txt');
    const renameWithPathInMsg = async () => {
      const e: NodeJS.ErrnoException = new Error(
        `EIO: i/o error, rename '${filePath}.abc123.tmp'`,
      );
      e.code = 'EIO';
      throw e;
    };

    await expect(
      atomicWriteFile(filePath, 'data', undefined, {
        rename: renameWithPathInMsg,
      }),
    ).rejects.toThrow(/^atomicWriteFile\(/);
  });

  // PR #4333 review fold-in: the EXDEV-then-fallback-write-fails path is
  // the only place fnName='atomicWriteFileSync' is exercised, so without
  // these tests a regression that dropped or misapplied the annotation
  // would go undetected on sync.
  it('atomicWriteFile: EXDEV fallback write failure is annotated with target + fn name', async () => {
    const filePath = path.join(tmpDir, 'exdev-write-fail.txt');
    const exdevRename = async () => {
      const e: NodeJS.ErrnoException = new Error('EXDEV');
      e.code = 'EXDEV';
      throw e;
    };
    // Selective failure: succeed on the first call (the tmp-file write)
    // so the EXDEV branch is actually reached; fail on the second call
    // (the direct write inside the EXDEV fallback). Without this
    // distinction the tmp-file write would fail FIRST with ENOSPC,
    // skipping the EXDEV branch entirely and leaving the inner
    // annotateWriteError call dead-code untested.
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
      const e: NodeJS.ErrnoException = new Error(
        `ENOSPC: no space left on device, open '${filePath}'`,
      );
      e.code = 'ENOSPC';
      throw e;
    };

    let caught: unknown;
    try {
      await atomicWriteFile(filePath, 'data', undefined, {
        rename: exdevRename,
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
    const filePath = path.join(tmpDir, 'exdev-sync-write-fail.txt');
    const exdevRename = () => {
      const e: NodeJS.ErrnoException = new Error('EXDEV');
      e.code = 'EXDEV';
      throw e;
    };
    // Same selective-failure pattern as the async test: first call (tmp
    // write) succeeds so the EXDEV branch is genuinely reached; second
    // call (fallback write) throws.
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
      const e: NodeJS.ErrnoException = new Error(
        `ENOSPC: no space left on device, open '${filePath}'`,
      );
      e.code = 'ENOSPC';
      throw e;
    };

    let caught: unknown;
    try {
      atomicWriteFileSync(filePath, 'data', undefined, {
        rename: exdevRename,
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
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-follow-test-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('atomicWriteFile: noFollow replaces a pre-placed symlink instead of writing through it', async () => {
    const real = path.join(tmpDir, 'real.txt');
    const link = path.join(tmpDir, 'link.txt');
    await fs.writeFile(real, 'ORIGINAL');
    await fs.symlink(real, link);

    await atomicWriteFile(link, 'NEW', { noFollow: true });

    // link is now a regular file, not a symlink
    expect(fsSync.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(link, 'utf-8')).toBe('NEW');
    // real file was NOT followed-through to
    expect(await fs.readFile(real, 'utf-8')).toBe('ORIGINAL');
  });

  it('atomicWriteFileSync: noFollow replaces a pre-placed symlink instead of writing through it', () => {
    const real = path.join(tmpDir, 'real.txt');
    const link = path.join(tmpDir, 'link.txt');
    fsSync.writeFileSync(real, 'ORIGINAL');
    fsSync.symlinkSync(real, link);

    atomicWriteFileSync(link, 'NEW', { noFollow: true });

    expect(fsSync.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(fsSync.readFileSync(link, 'utf-8')).toBe('NEW');
    expect(fsSync.readFileSync(real, 'utf-8')).toBe('ORIGINAL');
  });

  it('atomicWriteFile: noFollow EXDEV fallback also refuses to follow symlinks', async () => {
    const real = path.join(tmpDir, 'real.txt');
    const link = path.join(tmpDir, 'link.txt');
    await fs.writeFile(real, 'ORIGINAL');
    await fs.symlink(real, link);

    // Force the rename path to fail with EXDEV → exercise the
    // noFollow-aware fallback (was the security regression Codex caught).
    const exdevRename = async () => {
      const e: NodeJS.ErrnoException = new Error('EXDEV');
      e.code = 'EXDEV';
      throw e;
    };

    await atomicWriteFile(
      link,
      'NEW',
      { noFollow: true },
      { rename: exdevRename },
    );

    expect(fsSync.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(link, 'utf-8')).toBe('NEW');
    // The real file MUST be untouched — pre-fix this is where the
    // attacker's symlink would have redirected credentials to.
    expect(await fs.readFile(real, 'utf-8')).toBe('ORIGINAL');
  });

  it('atomicWriteFileSync: noFollow EXDEV fallback also refuses to follow symlinks', () => {
    const real = path.join(tmpDir, 'real.txt');
    const link = path.join(tmpDir, 'link.txt');
    fsSync.writeFileSync(real, 'ORIGINAL');
    fsSync.symlinkSync(real, link);

    const exdevRename = () => {
      const e: NodeJS.ErrnoException = new Error('EXDEV');
      e.code = 'EXDEV';
      throw e;
    };

    atomicWriteFileSync(
      link,
      'NEW',
      { noFollow: true },
      { rename: exdevRename },
    );

    expect(fsSync.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(fsSync.readFileSync(link, 'utf-8')).toBe('NEW');
    expect(fsSync.readFileSync(real, 'utf-8')).toBe('ORIGINAL');
  });

  // Earlier noFollow EXDEV tests pre-place a symlink, so the
  // `unlink(targetPath)` in the fallback always succeeds. These exercise
  // the ENOENT-swallow branch — first-write scenarios (initial credential
  // provisioning on a cross-device mount).
  // Mode assertions are Linux/macOS only — Windows NTFS reports 0o666
  // for any non-read-only file regardless of chmod, matching the existing
  // platform-guard pattern used elsewhere in this file.
  //
  // These tests also spy on path-based chmod to verify the *mechanism*,
  // not just the outcome. Under typical umask 0o022, `open(O_EXCL, 0o600)`
  // already creates the file at 0o600, so a regression that swapped
  // `fd.chmod()` back to a path-based `tryChmod(targetPath)` (the
  // pre-fix TOCTOU-vulnerable form) would leave the mode assertion
  // passing. Asserting the path-based chmod was never called against
  // `targetPath` catches that regression directly.
  it.skipIf(process.platform === 'win32')(
    'atomicWriteFile: noFollow EXDEV fallback creates a new file when target does not exist',
    async () => {
      const target = path.join(tmpDir, 'never-created.txt');
      const exdevRename = async () => {
        const e: NodeJS.ErrnoException = new Error('EXDEV');
        e.code = 'EXDEV';
        throw e;
      };
      const chmodSpy = vi.fn(fs.chmod);

      await atomicWriteFile(
        target,
        'NEW',
        { noFollow: true, mode: 0o600 },
        { rename: exdevRename, chmod: chmodSpy },
      );

      expect(fsSync.lstatSync(target).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(target, 'utf-8')).toBe('NEW');
      expect(fsSync.statSync(target).mode & 0o777).toBe(0o600);
      // Path-based chmod is permitted on the tmp file (pre-rename) but
      // must never run against the credential target — that path is
      // exclusively for the open-fd fchmod.
      const targetCalls = chmodSpy.mock.calls.filter(([p]) => p === target);
      expect(targetCalls).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'atomicWriteFileSync: noFollow EXDEV fallback creates a new file when target does not exist',
    () => {
      const target = path.join(tmpDir, 'never-created-sync.txt');
      const exdevRename = () => {
        const e: NodeJS.ErrnoException = new Error('EXDEV');
        e.code = 'EXDEV';
        throw e;
      };
      const chmodSpy = vi.fn(fsSync.chmodSync);

      atomicWriteFileSync(
        target,
        'NEW',
        { noFollow: true, mode: 0o600 },
        { rename: exdevRename, chmod: chmodSpy },
      );

      expect(fsSync.lstatSync(target).isSymbolicLink()).toBe(false);
      expect(fsSync.readFileSync(target, 'utf-8')).toBe('NEW');
      expect(fsSync.statSync(target).mode & 0o777).toBe(0o600);
      const targetCalls = chmodSpy.mock.calls.filter(([p]) => p === target);
      expect(targetCalls).toEqual([]);
    },
  );

  // The narrowed fchmod catch (round-8 fix) silently swallows ENOSYS/ENOTSUP
  // (FAT/exFAT — typical removable-storage credential mount) but propagates
  // every other error. Without injection, neither side of the branch is
  // exercised and a one-line revert of the catch narrowing would pass
  // every test. The orphan-cleanup-on-fchmod-failure path also has no
  // coverage without these injections.
  // Both ENOSYS (Linux FAT) and ENOTSUP (macOS exFAT) must be swallowed
  // — dropping either from the catch condition would silently leave a
  // credential file at the umask-masked open() mode on one of the two
  // common removable-media filesystems.
  it.each(['ENOSYS', 'ENOTSUP'] as const)(
    'atomicWriteFile: noFollow EXDEV swallows fchmod %s (FAT/exFAT)',
    async (chmodCode) => {
      const target = path.join(tmpDir, `fat-target-${chmodCode}.txt`);
      const exdevRename = async () => {
        const e: NodeJS.ErrnoException = new Error('EXDEV');
        e.code = 'EXDEV';
        throw e;
      };
      const fchmod = async () => {
        const e: NodeJS.ErrnoException = new Error(chmodCode);
        e.code = chmodCode;
        throw e;
      };

      await atomicWriteFile(
        target,
        'NEW',
        { noFollow: true, mode: 0o600 },
        { rename: exdevRename, fchmod },
      );

      expect(await fs.readFile(target, 'utf-8')).toBe('NEW');
    },
  );

  it('atomicWriteFile: noFollow EXDEV propagates fchmod EPERM and removes the orphan', async () => {
    const target = path.join(tmpDir, 'eperm-target.txt');
    const exdevRename = async () => {
      const e: NodeJS.ErrnoException = new Error('EXDEV');
      e.code = 'EXDEV';
      throw e;
    };
    const fchmod = async () => {
      const e: NodeJS.ErrnoException = new Error('EPERM');
      e.code = 'EPERM';
      throw e;
    };

    await expect(
      atomicWriteFile(
        target,
        'NEW',
        { noFollow: true, mode: 0o600 },
        { rename: exdevRename, fchmod },
      ),
    ).rejects.toThrow(/EPERM/);

    // The O_EXCL-created file MUST be removed so the next retry doesn't
    // deadlock. This is the credential-refresh-loop bug round-8 review
    // surfaced.
    expect(fsSync.existsSync(target)).toBe(false);
  });

  it.each(['ENOSYS', 'ENOTSUP'] as const)(
    'atomicWriteFileSync: noFollow EXDEV swallows fchmod %s (FAT/exFAT)',
    (chmodCode) => {
      const target = path.join(tmpDir, `fat-target-sync-${chmodCode}.txt`);
      const exdevRename = () => {
        const e: NodeJS.ErrnoException = new Error('EXDEV');
        e.code = 'EXDEV';
        throw e;
      };
      const fchmod = () => {
        const e: NodeJS.ErrnoException = new Error(chmodCode);
        e.code = chmodCode;
        throw e;
      };

      atomicWriteFileSync(
        target,
        'NEW',
        { noFollow: true, mode: 0o600 },
        { rename: exdevRename, fchmod },
      );

      expect(fsSync.readFileSync(target, 'utf-8')).toBe('NEW');
    },
  );

  it('atomicWriteFileSync: noFollow EXDEV propagates fchmod EPERM and removes the orphan', () => {
    const target = path.join(tmpDir, 'eperm-target-sync.txt');
    const exdevRename = () => {
      const e: NodeJS.ErrnoException = new Error('EXDEV');
      e.code = 'EXDEV';
      throw e;
    };
    const fchmod = () => {
      const e: NodeJS.ErrnoException = new Error('EPERM');
      e.code = 'EPERM';
      throw e;
    };

    expect(() =>
      atomicWriteFileSync(
        target,
        'NEW',
        { noFollow: true, mode: 0o600 },
        { rename: exdevRename, fchmod },
      ),
    ).toThrow(/EPERM/);

    expect(fsSync.existsSync(target)).toBe(false);
  });

  // The pre-open unlink at `targetPath` swallows ENOENT (first-write
  // case) but propagates anything else. Without injection, no test
  // exercises the propagation path — a regression to a blanket catch
  // would let a real error (EACCES on the parent directory, EROFS on
  // a remount) hide behind the subsequent EEXIST from O_EXCL.
  it('atomicWriteFile: noFollow EXDEV pre-open unlink propagates non-ENOENT errors', async () => {
    const target = path.join(tmpDir, 'eacces-target.txt');
    const exdevRename = async () => {
      const e: NodeJS.ErrnoException = new Error('EXDEV');
      e.code = 'EXDEV';
      throw e;
    };
    const unlink = async (p: fsSync.PathLike) => {
      // Only the pre-open unlink at targetPath should fail; tmp-file
      // cleanup goes through `fs.unlink` directly (not the seam).
      if (p === target) {
        const e: NodeJS.ErrnoException = new Error('EACCES');
        e.code = 'EACCES';
        throw e;
      }
    };

    await expect(
      atomicWriteFile(
        target,
        'NEW',
        { noFollow: true, mode: 0o600 },
        { rename: exdevRename, unlink: unlink as typeof fs.unlink },
      ),
    ).rejects.toThrow(/EACCES/);
  });

  it('atomicWriteFileSync: noFollow EXDEV pre-open unlink propagates non-ENOENT errors', () => {
    const target = path.join(tmpDir, 'eacces-target-sync.txt');
    const exdevRename = () => {
      const e: NodeJS.ErrnoException = new Error('EXDEV');
      e.code = 'EXDEV';
      throw e;
    };
    const unlink = (p: fsSync.PathLike) => {
      if (p === target) {
        const e: NodeJS.ErrnoException = new Error('EACCES');
        e.code = 'EACCES';
        throw e;
      }
    };

    expect(() =>
      atomicWriteFileSync(
        target,
        'NEW',
        { noFollow: true, mode: 0o600 },
        { rename: exdevRename, unlink: unlink as typeof fsSync.unlinkSync },
      ),
    ).toThrow(/EACCES/);
  });

  // Symlink-resolution failures (EACCES on intermediate dir, ELOOP)
  // must share the `atomicWriteFile("path"): ...` annotation prefix
  // so logs reference the logical filePath instead of an internal
  // intermediate component.
  it.skipIf(process.platform === 'win32')(
    'atomicWriteFile: annotates resolveSymlinkChain ELOOP failures with the logical filePath',
    async () => {
      const linkA = path.join(tmpDir, 'loop-a');
      const linkB = path.join(tmpDir, 'loop-b');
      await fs.symlink(linkB, linkA);
      await fs.symlink(linkA, linkB);

      await expect(atomicWriteFile(linkA, 'X')).rejects.toThrow(
        new RegExp(`atomicWriteFile\\(.*${path.basename(linkA)}.*\\):`),
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'atomicWriteFileSync: annotates resolveSymlinkChainSync ELOOP failures with the logical filePath',
    () => {
      const linkA = path.join(tmpDir, 'loop-a-sync');
      const linkB = path.join(tmpDir, 'loop-b-sync');
      fsSync.symlinkSync(linkB, linkA);
      fsSync.symlinkSync(linkA, linkB);

      expect(() => atomicWriteFileSync(linkA, 'X')).toThrow(
        new RegExp(`atomicWriteFileSync\\(.*${path.basename(linkA)}.*\\):`),
      );
    },
  );

  // Round-13 narrowed the path-level tryChmod / tryChmodSync catch to
  // ENOSYS/ENOTSUP only — same shape as the round-8 fd-level fchmod
  // narrowing — but unlike fchmod the tryChmod path had zero direct
  // coverage. The existing EXDEV tests pass `options: undefined`, so
  // `desiredMode === undefined` short-circuits before chmod is even
  // attempted. Inject `_testFs.chmod` and exercise both sides of the
  // narrowed catch.
  it.each(['ENOSYS', 'ENOTSUP'] as const)(
    'atomicWriteFile: tryChmod swallows %s (FAT/exFAT — non-noFollow EXDEV path)',
    async (chmodCode) => {
      const target = path.join(tmpDir, `trychmod-${chmodCode}.txt`);
      const exdevRename = async () => {
        const e: NodeJS.ErrnoException = new Error('EXDEV');
        e.code = 'EXDEV';
        throw e;
      };
      const chmod = async () => {
        const e: NodeJS.ErrnoException = new Error(chmodCode);
        e.code = chmodCode;
        throw e;
      };

      await atomicWriteFile(
        target,
        'NEW',
        { mode: 0o600 },
        { rename: exdevRename, chmod },
      );

      expect(await fs.readFile(target, 'utf-8')).toBe('NEW');
    },
  );

  it('atomicWriteFile: tryChmod propagates EPERM (non-noFollow EXDEV path)', async () => {
    const target = path.join(tmpDir, 'trychmod-eperm.txt');
    const exdevRename = async () => {
      const e: NodeJS.ErrnoException = new Error('EXDEV');
      e.code = 'EXDEV';
      throw e;
    };
    const chmod = async () => {
      const e: NodeJS.ErrnoException = new Error('EPERM');
      e.code = 'EPERM';
      throw e;
    };

    await expect(
      atomicWriteFile(
        target,
        'NEW',
        { mode: 0o600 },
        { rename: exdevRename, chmod },
      ),
    ).rejects.toThrow(/EPERM/);
  });

  it.each(['ENOSYS', 'ENOTSUP'] as const)(
    'atomicWriteFileSync: tryChmodSync swallows %s (FAT/exFAT — non-noFollow EXDEV path)',
    (chmodCode) => {
      const target = path.join(tmpDir, `trychmod-sync-${chmodCode}.txt`);
      const exdevRename = () => {
        const e: NodeJS.ErrnoException = new Error('EXDEV');
        e.code = 'EXDEV';
        throw e;
      };
      const chmod = () => {
        const e: NodeJS.ErrnoException = new Error(chmodCode);
        e.code = chmodCode;
        throw e;
      };

      atomicWriteFileSync(
        target,
        'NEW',
        { mode: 0o600 },
        { rename: exdevRename, chmod },
      );

      expect(fsSync.readFileSync(target, 'utf-8')).toBe('NEW');
    },
  );

  it('atomicWriteFileSync: tryChmodSync propagates EPERM (non-noFollow EXDEV path)', () => {
    const target = path.join(tmpDir, 'trychmod-sync-eperm.txt');
    const exdevRename = () => {
      const e: NodeJS.ErrnoException = new Error('EXDEV');
      e.code = 'EXDEV';
      throw e;
    };
    const chmod = () => {
      const e: NodeJS.ErrnoException = new Error('EPERM');
      e.code = 'EPERM';
      throw e;
    };

    expect(() =>
      atomicWriteFileSync(
        target,
        'NEW',
        { mode: 0o600 },
        { rename: exdevRename, chmod },
      ),
    ).toThrow(/EPERM/);
  });

  // Round-13's orphan-cleanup unlink (after a failed write/sync/fchmod
  // on the noFollow EXDEV path) was using raw `fs.unlink` /
  // `fsSync.unlinkSync` instead of the injected `unlinkImpl` seam
  // every other fs op flows through. These tests inject a spy on
  // unlinkImpl and assert it's invoked with targetPath on the
  // failure path — guards against silently bypassing the seam in
  // any future refactor.
  it('atomicWriteFile: orphan cleanup on fchmod failure goes through unlinkImpl', async () => {
    const target = path.join(tmpDir, 'orphan-via-seam.txt');
    const exdevRename = async () => {
      const e: NodeJS.ErrnoException = new Error('EXDEV');
      e.code = 'EXDEV';
      throw e;
    };
    const fchmod = async () => {
      const e: NodeJS.ErrnoException = new Error('EPERM');
      e.code = 'EPERM';
      throw e;
    };
    const unlinkSpy = vi.fn(fs.unlink);

    await expect(
      atomicWriteFile(
        target,
        'NEW',
        { noFollow: true, mode: 0o600 },
        {
          rename: exdevRename,
          fchmod,
          unlink: unlinkSpy as typeof fs.unlink,
        },
      ),
    ).rejects.toThrow(/EPERM/);

    const orphanCleanupCalls = unlinkSpy.mock.calls.filter(
      ([p]) => p === target,
    );
    // Pre-open unlink + post-failure orphan cleanup: target appears twice.
    expect(orphanCleanupCalls.length).toBeGreaterThanOrEqual(2);
    expect(fsSync.existsSync(target)).toBe(false);
  });

  it('atomicWriteFileSync: orphan cleanup on fchmod failure goes through unlinkImpl', () => {
    const target = path.join(tmpDir, 'orphan-via-seam-sync.txt');
    const exdevRename = () => {
      const e: NodeJS.ErrnoException = new Error('EXDEV');
      e.code = 'EXDEV';
      throw e;
    };
    const fchmod = () => {
      const e: NodeJS.ErrnoException = new Error('EPERM');
      e.code = 'EPERM';
      throw e;
    };
    const unlinkSpy = vi.fn(fsSync.unlinkSync);

    expect(() =>
      atomicWriteFileSync(
        target,
        'NEW',
        { noFollow: true, mode: 0o600 },
        {
          rename: exdevRename,
          fchmod,
          unlink: unlinkSpy as typeof fsSync.unlinkSync,
        },
      ),
    ).toThrow(/EPERM/);

    const orphanCleanupCalls = unlinkSpy.mock.calls.filter(
      ([p]) => p === target,
    );
    expect(orphanCleanupCalls.length).toBeGreaterThanOrEqual(2);
    expect(fsSync.existsSync(target)).toBe(false);
  });
});
