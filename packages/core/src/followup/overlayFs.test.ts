/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OverlayFs } from './overlayFs.js';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

describe('OverlayFs', () => {
  let testDir: string;
  let overlay: OverlayFs;

  beforeEach(async () => {
    testDir = join(tmpdir(), `overlay-test-${randomUUID().slice(0, 8)}`);
    await mkdir(testDir, { recursive: true });
    overlay = new OverlayFs(testDir);
  });

  afterEach(async () => {
    await overlay.cleanup();
    await rm(testDir, { recursive: true, force: true });
  });

  describe('redirectWrite', () => {
    it('copies existing file to overlay on first write', async () => {
      // Create a real file
      const realFile = join(testDir, 'src', 'app.ts');
      await mkdir(join(testDir, 'src'), { recursive: true });
      await writeFile(realFile, 'original content');

      const overlayPath = await overlay.redirectWrite(realFile);

      // Overlay file should exist with original content
      expect(existsSync(overlayPath)).toBe(true);
      const content = await readFile(overlayPath, 'utf-8');
      expect(content).toBe('original content');
    });

    it('returns same overlay path on subsequent writes', async () => {
      const realFile = join(testDir, 'file.ts');
      await writeFile(realFile, 'content');

      const path1 = await overlay.redirectWrite(realFile);
      const path2 = await overlay.redirectWrite(realFile);

      expect(path1).toBe(path2);
    });

    it('creates overlay path for new files without copying', async () => {
      const newFile = join(testDir, 'new-file.ts');

      const overlayPath = await overlay.redirectWrite(newFile);

      // Overlay directory should be created but file may not exist yet
      // (the tool will write to it)
      expect(overlayPath).toContain('new-file.ts');
      expect(overlay.getWrittenFiles().has('new-file.ts')).toBe(true);
    });

    it('throws for paths outside cwd', async () => {
      await expect(overlay.redirectWrite('/etc/passwd')).rejects.toThrow(
        'Cannot redirect write outside cwd',
      );
    });

    it('throws for path traversal attempts', async () => {
      await expect(
        overlay.redirectWrite(join(testDir, '..', '..', 'etc', 'passwd')),
      ).rejects.toThrow('Cannot redirect write outside cwd');
    });
  });

  describe('resolveReadPath', () => {
    it('returns overlay path for previously written files', async () => {
      const realFile = join(testDir, 'file.ts');
      await writeFile(realFile, 'original');

      const overlayPath = await overlay.redirectWrite(realFile);
      const resolved = overlay.resolveReadPath(realFile);

      expect(resolved).toBe(overlayPath);
    });

    it('returns real path for files not in overlay', () => {
      const realFile = join(testDir, 'untouched.ts');

      const resolved = overlay.resolveReadPath(realFile);

      expect(resolved).toBe(realFile);
    });

    it('returns real path for files outside cwd', () => {
      const outsidePath = '/etc/hosts';

      const resolved = overlay.resolveReadPath(outsidePath);

      expect(resolved).toBe(outsidePath);
    });
  });

  describe('resolveReadPath with relative paths', () => {
    it('resolves relative paths against realCwd', async () => {
      const realFile = join(testDir, 'src', 'app.ts');
      await mkdir(join(testDir, 'src'), { recursive: true });
      await writeFile(realFile, 'content');

      await overlay.redirectWrite(realFile);
      // Resolve using relative path
      const resolved = overlay.resolveReadPath(join(testDir, 'src', 'app.ts'));

      expect(resolved).not.toBe(realFile);
      expect(resolved).toContain('app.ts');
    });
  });

  describe('applyToReal', () => {
    it('copies overlay files back to real filesystem', async () => {
      const realFile = join(testDir, 'file.ts');
      await writeFile(realFile, 'original');

      const overlayPath = await overlay.redirectWrite(realFile);
      await writeFile(overlayPath, 'modified in overlay');

      const applied = await overlay.applyToReal();

      expect(applied).toContain(realFile);
      const content = await readFile(realFile, 'utf-8');
      expect(content).toBe('modified in overlay');
    });

    it('creates directories for new files during apply', async () => {
      const newFile = join(testDir, 'new', 'deep', 'file.ts');
      const overlayPath = await overlay.redirectWrite(newFile);
      await writeFile(overlayPath, 'new file content');

      const applied = await overlay.applyToReal();

      expect(applied).toContain(newFile);
      const content = await readFile(newFile, 'utf-8');
      expect(content).toBe('new file content');
    });

    it('reports a file it could not copy back to disk', async () => {
      // `blocker` is a file, so the directory the child needs cannot be made.
      await writeFile(join(testDir, 'blocker'), 'not a directory');
      const realFile = join(testDir, 'blocker', 'file.ts');
      const overlayPath = await overlay.redirectWrite(realFile);
      await writeFile(overlayPath, 'modified in overlay');

      // Dropping it silently would let the caller report the edit as accepted
      // while nothing reached disk.
      await expect(overlay.applyToReal()).rejects.toThrow(/file\.ts/);
    });

    it('ignores a redirected path nothing was ever written to', async () => {
      // `redirectWrite` registers the path so later reads see the overlay, but for a
      // file that does not exist yet it only makes the directory — no overlay file is
      // created. A tool that redirects a write and then fails (an `edit` of a path
      // that is not there) leaves exactly that: an entry with nothing behind it.
      // Counting it as "could not apply" rejects the whole accept, discarding edits
      // that did land, even though this entry has no content to copy.
      const neverWritten = join(testDir, 'brand-new.ts');
      await overlay.redirectWrite(neverWritten);

      const realFile = join(testDir, 'src', 'app.ts');
      await mkdir(join(testDir, 'src'), { recursive: true });
      await writeFile(realFile, 'original');
      await writeFile(await overlay.redirectWrite(realFile), 'edited');

      const applied = await overlay.applyToReal();

      // Resolves: there is no real failure here to report.
      expect(applied).toContain(realFile);
      expect(applied).not.toContain(neverWritten);
      expect(await readFile(realFile, 'utf-8')).toBe('edited');
      // Nothing was ever written, so nothing is created on the real side either.
      expect(existsSync(neverWritten)).toBe(false);
    });

    it('lands the files it can and reports the one it cannot', async () => {
      // A file that cannot be copied must not stop the others: the point of
      // collecting the failures is that the writable ones still land.
      await writeFile(join(testDir, 'blocker'), 'not a directory');
      const blocked = join(testDir, 'blocker', 'file.ts');
      const writable = join(testDir, 'writable.ts');
      await writeFile(await overlay.redirectWrite(blocked), 'blocked edit');
      await writeFile(await overlay.redirectWrite(writable), 'applied edit');

      await expect(overlay.applyToReal()).rejects.toThrow(/file\.ts/);

      // The file that could be copied is on disk with the edit in it.
      expect(await readFile(writable, 'utf-8')).toBe('applied edit');
    });

    it('carries the underlying failure as the cause', async () => {
      await writeFile(join(testDir, 'blocker'), 'not a directory');
      const blocked = join(testDir, 'blocker', 'file.ts');
      await writeFile(await overlay.redirectWrite(blocked), 'blocked edit');

      // A bare `catch` would leave the caller unable to tell EACCES from
      // ENOSPC from ENOTDIR.
      const error = await overlay.applyToReal().catch((err: unknown) => err);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBeDefined();
    });

    it('returns empty array when no files written', async () => {
      const applied = await overlay.applyToReal();

      expect(applied).toEqual([]);
    });
  });

  describe('cleanup', () => {
    it('removes the overlay directory', async () => {
      const realFile = join(testDir, 'file.ts');
      await writeFile(realFile, 'content');
      await overlay.redirectWrite(realFile);

      const overlayDir = overlay.getOverlayDir();
      expect(existsSync(overlayDir)).toBe(true);

      await overlay.cleanup();

      expect(existsSync(overlayDir)).toBe(false);
    });

    it('does not throw if overlay directory does not exist', async () => {
      await overlay.cleanup();
      // Should not throw on double cleanup
      await expect(overlay.cleanup()).resolves.not.toThrow();
    });
  });

  describe('getWrittenFiles', () => {
    it('returns a copy of written files map', async () => {
      const realFile = join(testDir, 'file.ts');
      await writeFile(realFile, 'content');
      await overlay.redirectWrite(realFile);

      const files = overlay.getWrittenFiles();

      expect(files.size).toBe(1);
      expect(files.has('file.ts')).toBe(true);

      // Modifying returned map should not affect internal state
      files.clear();
      expect(overlay.getWrittenFiles().size).toBe(1);
    });
  });
});
