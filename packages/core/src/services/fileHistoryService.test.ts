/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockStorageDir = vi.hoisted(() => vi.fn());
vi.mock('../config/storage.js', () => ({
  Storage: { getGlobalQwenDir: mockStorageDir },
}));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { FileHistoryService } from './fileHistoryService.js';

describe('FileHistoryService', () => {
  let projectDir: string;
  let storageDir: string;
  let service: FileHistoryService;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'fh-project-'));
    storageDir = await mkdtemp(join(tmpdir(), 'fh-storage-'));
    mockStorageDir.mockReturnValue(storageDir);
    service = new FileHistoryService('test-session', true, projectDir);
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  });

  describe('disabled service', () => {
    it('should no-op all operations when disabled', async () => {
      const disabled = new FileHistoryService('s', false, projectDir);
      await disabled.makeSnapshot('p1');
      await disabled.trackEdit('/foo');
      const result = await disabled.rewind('p1');
      expect(result).toEqual({ filesChanged: [], filesFailed: [] });
      expect(disabled.getSnapshots()).toEqual([]);
      expect(await disabled.getDiffStats('p1')).toBeUndefined();
    });
  });

  describe('trackEdit', () => {
    it('should back up file before first edit in a snapshot', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'original');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);

      const snapshots = service.getSnapshots();
      expect(snapshots).toHaveLength(1);
      const backups = snapshots[0].trackedFileBackups;
      const key = Object.keys(backups)[0];
      expect(key).toBeDefined();
      expect(backups[key].version).toBe(1);
      expect(backups[key].backupFileName).not.toBeNull();
    });

    it('should skip if file already tracked in current snapshot', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'original');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await service.trackEdit(file); // second call

      const snapshots = service.getSnapshots();
      const backups = snapshots[0].trackedFileBackups;
      expect(Object.keys(backups)).toHaveLength(1);
    });

    it('should record null backup for non-existent file', async () => {
      const file = join(projectDir, 'nonexistent.txt');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);

      const snapshots = service.getSnapshots();
      const backups = snapshots[0].trackedFileBackups;
      const key = Object.keys(backups)[0];
      expect(backups[key].backupFileName).toBeNull();
    });
  });

  describe('makeSnapshot', () => {
    it('should create snapshot with correct promptId', async () => {
      await service.makeSnapshot('prompt-abc');
      const snapshots = service.getSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].promptId).toBe('prompt-abc');
    });

    it('should re-backup files that changed since last snapshot', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'v1');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);

      // Modify the file after tracking
      await writeFile(file, 'v2-modified');

      await service.makeSnapshot('p2');

      const snapshots = service.getSnapshots();
      expect(snapshots).toHaveLength(2);
      const p2Backups = snapshots[1].trackedFileBackups;
      const key = Object.keys(p2Backups)[0];
      // Version should increment
      expect(p2Backups[key].version).toBe(2);
    });

    it('should inherit version for unchanged files', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'unchanged');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await service.makeSnapshot('p2');

      const snapshots = service.getSnapshots();
      const p1Key = Object.keys(snapshots[0].trackedFileBackups)[0];
      const p2Key = Object.keys(snapshots[1].trackedFileBackups)[0];
      // Same backup reference (version unchanged)
      expect(snapshots[1].trackedFileBackups[p2Key].backupFileName).toBe(
        snapshots[0].trackedFileBackups[p1Key].backupFileName,
      );
    });
  });

  describe('rewind', () => {
    it('should restore file to target snapshot state', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'original');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, 'modified');
      await service.makeSnapshot('p2');

      const result = await service.rewind('p1');
      expect(result.filesChanged).toContain(file);
      expect(result.filesFailed).toHaveLength(0);

      const content = await readFile(file, 'utf-8');
      expect(content).toBe('original');
    });

    it('should delete file that did not exist at target snapshot', async () => {
      await service.makeSnapshot('p1');

      const file = join(projectDir, 'new-file.txt');
      await service.trackEdit(file); // non-existent → null backup
      await writeFile(file, 'created');
      await service.makeSnapshot('p2');

      const result = await service.rewind('p1');
      expect(result.filesChanged).toContain(file);
      expect(existsSync(file)).toBe(false);
    });

    it('should return filesFailed when backup file is missing on disk', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'original');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, 'modified');
      await service.makeSnapshot('p2');

      // Delete the backup file to simulate corruption
      const snapshots = service.getSnapshots();
      const key = Object.keys(snapshots[0].trackedFileBackups)[0];
      const backupFileName =
        snapshots[0].trackedFileBackups[key].backupFileName;
      expect(backupFileName).not.toBeNull();
      const backupPath = join(
        storageDir,
        'file-history',
        'test-session',
        backupFileName!,
      );
      await rm(backupPath, { force: true });

      const result = await service.rewind('p1');
      expect(result.filesFailed.length).toBeGreaterThan(0);
    });

    it('should preserve snapshot timeline when truncateHistory=false', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'original');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, 'modified');
      await service.makeSnapshot('p2');

      await service.rewind('p1', false);

      const snapshots = service.getSnapshots();
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0].promptId).toBe('p1');
      expect(snapshots[1].promptId).toBe('p2');
    });

    it('should truncate snapshot timeline when truncateHistory=true', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'original');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, 'modified');
      await service.makeSnapshot('p2');
      await service.makeSnapshot('p3');

      await service.rewind('p1', true);

      const snapshots = service.getSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].promptId).toBe('p1');
    });

    it('should throw when snapshot not found', async () => {
      await service.makeSnapshot('p1');
      await expect(service.rewind('nonexistent')).rejects.toThrow(
        'The selected snapshot was not found',
      );
    });
  });

  describe('snapshot eviction', () => {
    it('should keep at most MAX_SNAPSHOTS (100) snapshots', async () => {
      for (let i = 0; i < 105; i++) {
        await service.makeSnapshot(`p${i}`);
      }
      const snapshots = service.getSnapshots();
      expect(snapshots.length).toBeLessThanOrEqual(100);
      expect(snapshots[snapshots.length - 1].promptId).toBe('p104');
    });
  });

  describe('getDiffStats', () => {
    it('should compute correct insertions and deletions', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'line1\nline2\nline3\n');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, 'line1\nmodified\nline3\nnewline\n');
      await service.makeSnapshot('p2');

      const stats = await service.getDiffStats('p1');
      expect(stats).toBeDefined();
      expect(stats!.insertions).toBeGreaterThan(0);
      expect(stats!.deletions).toBeGreaterThan(0);
      expect(stats!.filesChanged).toContain(file);
    });

    it('should return undefined when disabled', async () => {
      const disabled = new FileHistoryService('s', false, projectDir);
      const stats = await disabled.getDiffStats('p1');
      expect(stats).toBeUndefined();
    });

    it('should return undefined when snapshot not found', async () => {
      const stats = await service.getDiffStats('nonexistent');
      expect(stats).toBeUndefined();
    });
  });
});
