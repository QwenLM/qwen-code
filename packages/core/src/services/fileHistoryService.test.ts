/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const mockStorageDir = vi.hoisted(() => vi.fn());
vi.mock('../config/storage.js', () => ({
  Storage: { getGlobalQwenDir: mockStorageDir },
}));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  FileHistoryService,
  type FileHistorySnapshot,
} from './fileHistoryService.js';

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
    it('records the updated latest snapshot after tracking a file', async () => {
      const recordedSnapshots: FileHistorySnapshot[] = [];
      const recordSnapshot = vi.fn((snapshot: FileHistorySnapshot) => {
        recordedSnapshots.push(structuredClone(snapshot));
      });
      const recordingService = new FileHistoryService(
        'test-session',
        true,
        projectDir,
        recordSnapshot,
      );
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'original');

      await recordingService.makeSnapshot('p1');
      await recordingService.trackEdit(file);

      expect(recordSnapshot).toHaveBeenCalledTimes(1);
      const recorded = recordedSnapshots[0];
      expect(recorded.promptId).toBe('p1');
      expect(recorded.trackedFileBackups['a.txt']).toEqual(
        expect.objectContaining({
          backupFileName: expect.any(String),
          version: 1,
        }),
      );
    });

    it('does not record duplicate tracking for the same file', async () => {
      const recordSnapshot = vi.fn();
      const recordingService = new FileHistoryService(
        'test-session',
        true,
        projectDir,
        recordSnapshot,
      );
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'original');

      await recordingService.makeSnapshot('p1');
      await recordingService.trackEdit(file);
      await recordingService.trackEdit(file);

      expect(recordSnapshot).toHaveBeenCalledTimes(1);
    });

    it('does not record when the snapshot is removed while backup is in flight', async () => {
      const recordSnapshot = vi.fn();
      const recordingService = new FileHistoryService(
        'test-session',
        true,
        projectDir,
        recordSnapshot,
      );
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'original');

      await recordingService.makeSnapshot('p1');
      const edit = recordingService.trackEdit(file);
      recordingService.restoreFromSnapshots([]);
      await edit;

      expect(recordSnapshot).not.toHaveBeenCalled();
      expect(recordingService.getSnapshots()).toEqual([]);
    });

    it('records again when a second file is tracked in the same snapshot', async () => {
      const recordedSnapshots: FileHistorySnapshot[] = [];
      const recordSnapshot = vi.fn((snapshot: FileHistorySnapshot) => {
        recordedSnapshots.push(structuredClone(snapshot));
      });
      const recordingService = new FileHistoryService(
        'test-session',
        true,
        projectDir,
        recordSnapshot,
      );
      const firstFile = join(projectDir, 'a.txt');
      const secondFile = join(projectDir, 'b.txt');
      await writeFile(firstFile, 'a-original');
      await writeFile(secondFile, 'b-original');

      await recordingService.makeSnapshot('p1');
      await recordingService.trackEdit(firstFile);
      await recordingService.trackEdit(secondFile);

      expect(recordSnapshot).toHaveBeenCalledTimes(2);
      const recorded = recordedSnapshots[1];
      expect(recorded.trackedFileBackups['a.txt']).toEqual(
        expect.objectContaining({
          backupFileName: expect.any(String),
          version: 1,
        }),
      );
      expect(recorded.trackedFileBackups['b.txt']).toEqual(
        expect.objectContaining({
          backupFileName: expect.any(String),
          version: 1,
        }),
      );
    });

    it('swallows recorder errors after tracking a file', async () => {
      const recordSnapshot = vi.fn(() => {
        throw new Error('record failed');
      });
      const recordingService = new FileHistoryService(
        'test-session',
        true,
        projectDir,
        recordSnapshot,
      );
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'original');

      await recordingService.makeSnapshot('p1');
      await expect(recordingService.trackEdit(file)).resolves.toBeUndefined();

      expect(recordSnapshot).toHaveBeenCalledTimes(1);
      expect(
        recordingService.getSnapshots()[0].trackedFileBackups['a.txt'],
      ).toEqual(
        expect.objectContaining({
          backupFileName: expect.any(String),
          version: 1,
        }),
      );
    });

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

    // trackEdit must swallow createBackup failures so that the calling tool
    // (edit / write_file) is never broken by file-history-side I/O errors.
    it('does not throw and records nothing when createBackup fails', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'original');
      await service.makeSnapshot('p1');

      // Replace the backup storage root with a regular file so the recursive
      // `mkdir(dirname(backupPath))` inside `safeCopyFile` fails with
      // ENOTDIR — a non-ENOENT error that propagates back into `trackEdit`'s
      // catch.
      await rm(storageDir, { recursive: true, force: true });
      await writeFile(storageDir, '');

      await expect(service.trackEdit(file)).resolves.toBeUndefined();
      expect(service.getSnapshots()[0].trackedFileBackups).toEqual({});
    });

    // The sticky-failed guard symmetry test for trackEdit. After
    // makeSnapshot recorded a `failed: true` marker for a file (e.g.
    // transient disk full), the next trackEdit invocation — typically
    // triggered by a tool about to modify the same file — must NOT
    // skip just because the entry exists. It must attempt a fresh
    // backup; on success the failed marker is replaced. Without this
    // the failed flag stays sticky until the file content changes,
    // permanently poisoning rewind for that file.
    it('heals a failed entry on the next trackEdit attempt', async () => {
      const recordedSnapshots: FileHistorySnapshot[] = [];
      const recordSnapshot = vi.fn((snapshot: FileHistorySnapshot) => {
        recordedSnapshots.push(structuredClone(snapshot));
      });
      service = new FileHistoryService(
        'test-session',
        true,
        projectDir,
        recordSnapshot,
      );
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'p1-content');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);

      // Force makeSnapshot's per-file backup to throw. The file content
      // is unchanged so checkOriginFileChanged short-circuits to "no
      // change" — but we want the failure path here, so modify the file
      // first to ensure createBackup is reached.
      await writeFile(file, 'p2-content');
      await rm(storageDir, { recursive: true, force: true });
      await writeFile(storageDir, '');
      await service.makeSnapshot('p2');
      expect(
        service.getSnapshots()[1].trackedFileBackups['a.txt']!.failed,
      ).toBe(true);

      // Restore the backup target and have a tool about to edit the file
      // call trackEdit. The guard must let createBackup run again; on
      // success the failed marker is replaced with a real entry.
      await rm(storageDir, { recursive: true, force: true });
      await mkdir(storageDir, { recursive: true });
      await service.trackEdit(file);

      const p2Backup = service.getSnapshots()[1].trackedFileBackups['a.txt'];
      expect(p2Backup).toBeDefined();
      expect(p2Backup.failed).toBeFalsy();
      expect(p2Backup.backupFileName).not.toBeNull();
      expect(recordSnapshot).toHaveBeenCalledTimes(2);
      expect(recordedSnapshots[1]).toEqual(
        expect.objectContaining({
          promptId: 'p2',
          trackedFileBackups: expect.objectContaining({
            'a.txt': p2Backup,
          }),
        }),
      );

      // Verify the on-disk backup at the new name actually contains the
      // current file content. Catches a regression where the heal path
      // accidentally reuses `previous.backupFileName` (pointing at the
      // older `p1-content`) instead of writing a fresh backup.
      const backupPath = join(
        storageDir,
        'file-history',
        'test-session',
        p2Backup.backupFileName!,
      );
      expect(await readFile(backupPath, 'utf-8')).toBe('p2-content');
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

    // When a per-file backup attempt throws inside makeSnapshot, the new
    // snapshot must NOT silently inherit the previous snapshot's backup
    // and present it as the captured state of this turn — that would
    // make a later rewind restore older content while reporting success.
    // Instead the snapshot records a `failed: true` marker so rewind
    // surfaces the file via filesFailed and getDiffStats omits it.
    it('marks per-file backup failures and does not silently inherit', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'p1-content');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);

      // Modify the file and break the backup target (replace storageDir
      // with a regular file → ENOTDIR inside `safeCopyFile`'s recursive
      // mkdir). The next makeSnapshot's per-file backup attempt throws.
      await writeFile(file, 'p2-content');
      await rm(storageDir, { recursive: true, force: true });
      await writeFile(storageDir, '');

      await service.makeSnapshot('p2');

      const p2Backups = service.getSnapshots()[1].trackedFileBackups;
      const p2Backup = p2Backups['a.txt'];
      expect(p2Backup).toBeDefined();
      expect(p2Backup.failed).toBe(true);

      // Rewind to p2 must report the file as failed, not silently
      // restore p1-content as if it were the captured state of p2.
      const result = await service.rewind('p2');
      expect(result.filesChanged).toEqual([]);
      expect(result.filesFailed).toContain(file);
    });

    // After a transient backup failure, the no-change optimization must NOT
    // copy the failed entry forward into the next snapshot. If we did, the
    // failed flag would stay sticky for as long as the file is unchanged,
    // permanently poisoning rewind for that file even after the backup
    // target recovers.
    it('does not carry a failed marker forward when the file is unchanged', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'stable-content');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);

      // Break the backup target so p2's per-file backup throws; do NOT
      // change the file content.
      await rm(storageDir, { recursive: true, force: true });
      await writeFile(storageDir, '');
      await service.makeSnapshot('p2');
      expect(
        service.getSnapshots()[1].trackedFileBackups['a.txt']!.failed,
      ).toBe(true);

      // Restore the backup target. The file is still unchanged. p3 must
      // retry the backup (instead of copying p2's failed entry forward) and
      // record a fresh non-failed entry.
      await rm(storageDir, { recursive: true, force: true });
      await mkdir(storageDir, { recursive: true });

      await service.makeSnapshot('p3');

      const p3Backup = service.getSnapshots()[2].trackedFileBackups['a.txt'];
      expect(p3Backup).toBeDefined();
      expect(p3Backup.failed).toBeFalsy();
      expect(p3Backup.backupFileName).not.toBeNull();

      // Rewind to p3 succeeds (file is unchanged but the backup is now real).
      const result = await service.rewind('p3');
      expect(result.filesFailed).toEqual([]);
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

    // Edge case: both the on-disk backup and the working file have been
    // removed externally. The target snapshot still expects the file to
    // exist, so rewind must surface this as filesFailed instead of
    // silently reporting success.
    it('should report filesFailed when both backup and working file are gone', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'original');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, 'modified');
      await service.makeSnapshot('p2');

      const snapshots = service.getSnapshots();
      const backupName =
        snapshots[0].trackedFileBackups['a.txt']!.backupFileName!;
      await rm(join(storageDir, 'file-history', 'test-session', backupName), {
        force: true,
      });
      await rm(file, { force: true });

      const result = await service.rewind('p1');
      expect(result.filesChanged).toEqual([]);
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

    it('should not truncate snapshot timeline when restore has failures', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'original');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, 'modified');
      await service.makeSnapshot('p2');
      await service.makeSnapshot('p3');

      // Corrupt the p1 backup so applySnapshot reports a failure.
      const snapshots = service.getSnapshots();
      const key = Object.keys(snapshots[0].trackedFileBackups)[0];
      const backupFileName =
        snapshots[0].trackedFileBackups[key].backupFileName!;
      await rm(
        join(storageDir, 'file-history', 'test-session', backupFileName),
        { force: true },
      );

      const result = await service.rewind('p1', true);
      expect(result.filesFailed.length).toBeGreaterThan(0);
      // Timeline must stay intact so the user can retry without losing state.
      const after = service.getSnapshots();
      expect(after.map((s) => s.promptId)).toEqual(['p1', 'p2', 'p3']);
    });

    // checkOriginFileChanged short-circuits the restore when the file on
    // disk already matches the target backup. Cover it explicitly so a
    // future regression in stat/content comparison surfaces here instead
    // of as silent extra writes (or skipped writes) to user files.
    it('does not touch a file whose content matches the target snapshot', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'unchanged');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await service.makeSnapshot('p2');

      // File content has not changed since p1 was tracked. Capture mtime so
      // we can verify the file is not rewritten by the rewind.
      const mtimeBefore = (await stat(file)).mtimeMs;

      const result = await service.rewind('p1');

      expect(result.filesChanged).toEqual([]);
      expect(result.filesFailed).toEqual([]);
      expect(await readFile(file, 'utf-8')).toBe('unchanged');
      expect((await stat(file)).mtimeMs).toBe(mtimeBefore);
    });
  });

  describe('trackEdit before any snapshot', () => {
    it('should no-op when there is no most-recent snapshot', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'original');

      await service.trackEdit(file);

      expect(service.getSnapshots()).toEqual([]);
    });
  });

  describe('restoreFromSnapshots', () => {
    it('should rehydrate snapshots and derive trackedFiles', async () => {
      const fresh = new FileHistoryService('test-session', true, projectDir);
      const absPath = join(projectDir, 'a.txt');
      const externalPath = join(tmpdir(), 'fh-external-x.txt');

      fresh.restoreFromSnapshots([
        {
          promptId: 'p1',
          trackedFileBackups: {
            [absPath]: {
              backupFileName: 'deadbeefcafebabe@v1',
              version: 1,
              backupTime: new Date(),
            },
            [externalPath]: {
              backupFileName: null,
              version: 1,
              backupTime: new Date(),
            },
          },
          timestamp: new Date(),
        },
      ]);

      const snapshots = fresh.getSnapshots();
      expect(snapshots).toHaveLength(1);
      // Path under cwd should be shortened to a relative key.
      expect(snapshots[0].trackedFileBackups['a.txt']).toBeDefined();
      // Path outside cwd should be preserved as-is.
      expect(snapshots[0].trackedFileBackups[externalPath]).toBeDefined();
    });

    it('records failed markers when restored backup files are missing', async () => {
      const recordedSnapshots: FileHistorySnapshot[] = [];
      const recordSnapshot = vi.fn((snapshot: FileHistorySnapshot) => {
        recordedSnapshots.push(structuredClone(snapshot));
      });
      const fresh = new FileHistoryService(
        'test-session',
        true,
        projectDir,
        recordSnapshot,
      );

      fresh.restoreFromSnapshots([
        {
          promptId: 'p1',
          trackedFileBackups: {
            'a.txt': {
              backupFileName: 'deadbeefcafebabe@v1',
              version: 1,
              backupTime: new Date('2026-06-13T00:00:00.000Z'),
            },
          },
          timestamp: new Date('2026-06-13T00:00:01.000Z'),
        },
      ]);

      await fresh.validateRestoredSnapshots();

      const backup = fresh.getSnapshots()[0]!.trackedFileBackups['a.txt']!;
      expect(backup.failed).toBe(true);
      expect(recordSnapshot).toHaveBeenCalledTimes(1);
      expect(recordedSnapshots[0]!.trackedFileBackups['a.txt']?.failed).toBe(
        true,
      );
    });

    it('does not restore backup files that escape the session directory', async () => {
      const fresh = new FileHistoryService('test-session', true, projectDir);
      const victim = join(projectDir, 'victim.txt');
      await writeFile(victim, 'current');
      await writeFile(join(storageDir, 'outside.txt'), 'outside');

      fresh.restoreFromSnapshots([
        {
          promptId: 'p1',
          trackedFileBackups: {
            'victim.txt': {
              backupFileName: '../../outside.txt',
              version: 1,
              backupTime: new Date('2026-06-13T00:00:00.000Z'),
            },
          },
          timestamp: new Date('2026-06-13T00:00:01.000Z'),
        },
      ]);

      const result = await fresh.rewind('p1');

      expect(result.filesChanged).toEqual([]);
      expect(result.filesFailed).toContain(victim);
      expect(await readFile(victim, 'utf-8')).toBe('current');
    });
  });

  describe('snapshot eviction', () => {
    const backupPath = (name: string) =>
      join(storageDir, 'file-history', 'test-session', name);

    it('should keep at most MAX_SNAPSHOTS (100) snapshots', async () => {
      for (let i = 0; i < 105; i++) {
        await service.makeSnapshot(`p${i}`);
      }
      const snapshots = service.getSnapshots();
      expect(snapshots.length).toBeLessThanOrEqual(100);
      expect(snapshots[snapshots.length - 1].promptId).toBe('p104');
    });

    it('should delete orphaned backup files on overflow', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'v0');

      await service.makeSnapshot('p0');
      await service.trackEdit(file); // version 1, content 'v0'

      const evictedNames: string[] = [];
      // Capture v1 from p0 before it gets evicted.
      evictedNames.push(
        service.getSnapshots()[0].trackedFileBackups['a.txt']!.backupFileName!,
      );

      // 104 more snapshots, each with new content → fresh backup per snapshot.
      for (let i = 1; i < 105; i++) {
        await writeFile(file, `v${i}`);
        await service.makeSnapshot(`p${i}`);
        if (i < 5) {
          evictedNames.push(
            service.getSnapshots()[i].trackedFileBackups['a.txt']!
              .backupFileName!,
          );
        }
      }

      // p0..p4 (versions 1..5) were dropped by slice(-100); their backups should be gone.
      for (const name of evictedNames) {
        expect(existsSync(backupPath(name))).toBe(false);
      }
      // The surviving snapshots' backups must still exist.
      const survivors = service.getSnapshots();
      for (const s of survivors) {
        const bn = s.trackedFileBackups['a.txt']?.backupFileName;
        if (bn) expect(existsSync(backupPath(bn))).toBe(true);
      }
    });

    it('should preserve deduplicated backup files referenced by survivors', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'unchanged');

      await service.makeSnapshot('p0');
      await service.trackEdit(file);
      const sharedName =
        service.getSnapshots()[0].trackedFileBackups['a.txt']!.backupFileName!;

      // Content never changes → makeSnapshot reuses the same backup reference.
      for (let i = 1; i < 105; i++) {
        await service.makeSnapshot(`p${i}`);
      }

      // Same backupFileName is held by every survivor → must NOT be deleted.
      expect(existsSync(backupPath(sharedName))).toBe(true);
    });
  });

  describe('rewind cleanup', () => {
    it('should delete backups orphaned by truncation', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'v0');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      const v1 =
        service.getSnapshots()[0].trackedFileBackups['a.txt']!.backupFileName!;

      await writeFile(file, 'v1');
      await service.makeSnapshot('p2');
      const v2 =
        service.getSnapshots()[1].trackedFileBackups['a.txt']!.backupFileName!;

      await writeFile(file, 'v2');
      await service.makeSnapshot('p3');
      const v3 =
        service.getSnapshots()[2].trackedFileBackups['a.txt']!.backupFileName!;

      await service.rewind('p1', true);

      const backupsDir = join(storageDir, 'file-history', 'test-session');
      // p1's backup is still referenced; p2 and p3's unique-version backups are gone.
      expect(existsSync(join(backupsDir, v1))).toBe(true);
      expect(existsSync(join(backupsDir, v2))).toBe(false);
      expect(existsSync(join(backupsDir, v3))).toBe(false);
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

  describe('getTurnDiff', () => {
    it('returns undefined when disabled', async () => {
      const disabled = new FileHistoryService('s', false, projectDir);
      expect(await disabled.getTurnDiff('p1')).toBeUndefined();
    });

    it('returns undefined when the prompt has no snapshot', async () => {
      expect(await service.getTurnDiff('missing')).toBeUndefined();
    });

    it('diffs a turn against the next snapshot', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'line1\nline2\nline3\n');

      // Turn 1 begins — captures pre-edit state — then the tool would
      // modify the file. We mirror that order: makeSnapshot → trackEdit
      // → mutate. This is the same sequence `client.ts` follows on
      // every UserQuery turn.
      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, 'line1\nLINE2_EDITED\nline3\n');

      // Turn 2 begins — this snapshot becomes the "after" for turn 1.
      await service.makeSnapshot('p2');

      const turn1 = await service.getTurnDiff('p1');
      expect(turn1).toBeDefined();
      expect(turn1!.files).toHaveLength(1);
      // filePath is repo-relative (matches Current source convention).
      expect(turn1!.files[0].filePath).toBe(basename(file));
      expect(turn1!.files[0].linesAdded).toBe(1);
      expect(turn1!.files[0].linesRemoved).toBe(1);
      expect(turn1!.files[0].isNewFile).toBe(false);
      expect(turn1!.files[0].isDeleted).toBe(false);
      expect(turn1!.stats.filesChanged).toBe(1);
    });

    it('compares the latest turn against the live worktree', async () => {
      const file = join(projectDir, 'b.txt');
      await writeFile(file, 'before');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, 'after-edit-1\nafter-edit-2');

      const turn = await service.getTurnDiff('p1');
      expect(turn).toBeDefined();
      expect(turn!.files).toHaveLength(1);
      // 2 added lines (or 1 add + content change depending on diff alg)
      expect(
        turn!.files[0].linesAdded + turn!.files[0].linesRemoved,
      ).toBeGreaterThan(0);
    });

    it('flags newly created files', async () => {
      const file = join(projectDir, 'new.txt');

      // Pre-existing snapshot with no tracked files.
      await service.makeSnapshot('p1');
      // Now the tool creates the file mid-turn 1. trackEdit captures
      // the pre-state (file does not exist).
      await service.trackEdit(file);
      await writeFile(file, 'fresh content\n');
      await service.makeSnapshot('p2');

      const turn1 = await service.getTurnDiff('p1');
      expect(turn1).toBeDefined();
      const entry = turn1!.files.find((f) => f.filePath === basename(file));
      expect(entry).toBeDefined();
      expect(entry!.isNewFile).toBe(true);
      expect(entry!.isDeleted).toBe(false);
      expect(entry!.linesAdded).toBeGreaterThan(0);
    });

    it('skips files with no change between snapshots', async () => {
      const file = join(projectDir, 'untouched.txt');
      await writeFile(file, 'stable\n');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      // No actual modification before next snapshot.
      await service.makeSnapshot('p2');

      const turn1 = await service.getTurnDiff('p1');
      expect(turn1).toBeDefined();
      // The file got tracked but content is identical — should not appear
      // in the per-turn diff.
      expect(turn1!.files).toHaveLength(0);
      expect(turn1!.stats.filesChanged).toBe(0);
    });

    // Regression for the silent-empty-string bug: a backup that records a
    // real backupFileName but is unreadable on disk used to be coerced to
    // '', producing a fake "every line added" diff. Now we drop the row
    // entirely so the dialog doesn't lie about phantom changes.
    it('skips files whose backup file is missing on disk', async () => {
      const file = join(projectDir, 'lostbackup.txt');
      await writeFile(file, 'before');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, 'after');
      await service.makeSnapshot('p2');

      // Wipe the backup directory between makeSnapshot('p2') and the diff
      // read. The snapshot records still point at the deleted file paths.
      await rm(join(storageDir, 'file-history'), {
        recursive: true,
        force: true,
      });

      const turn1 = await service.getTurnDiff('p1');
      expect(turn1).toBeDefined();
      expect(turn1!.files).toHaveLength(0);
    });

    // Regression for the unbounded structuredPatch allocation: a single
    // huge file in history could blow up TUI memory when /diff opens.
    // Oversized rows now skip hunk construction but still surface in the
    // file list with best-effort line-count stats.
    it('detects files deleted during a turn', async () => {
      const file = join(projectDir, 'doomed.txt');
      await writeFile(file, 'line a\nline b\n');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      // Simulate the tool deleting the file mid-turn.
      await rm(file);
      await service.makeSnapshot('p2');

      const turn1 = await service.getTurnDiff('p1');
      expect(turn1).toBeDefined();
      const entry = turn1!.files.find((f) => f.filePath === basename(file));
      expect(entry).toBeDefined();
      expect(entry!.isDeleted).toBe(true);
      expect(entry!.isNewFile).toBe(false);
      expect(entry!.linesRemoved).toBeGreaterThan(0);
    });

    it('flags binary content with isBinary and skips hunk generation', async () => {
      const file = join(projectDir, 'image.bin');
      // PNG-ish header — NUL bytes within the sniff window trip the
      // looksBinary heuristic.
      await writeFile(file, '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      // Append more binary bytes so before !== after.
      await writeFile(
        file,
        '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00',
      );
      await service.makeSnapshot('p2');

      const turn1 = await service.getTurnDiff('p1');
      expect(turn1).toBeDefined();
      const entry = turn1!.files.find((f) => f.filePath === basename(file));
      expect(entry).toBeDefined();
      expect(entry!.isBinary).toBe(true);
      expect(entry!.hunks).toEqual([]);
    });

    // Files that target's snapshot didn't capture (e.g. they were first
    // tracked in a later turn) must not show up in target's diff —
    // otherwise we'd attribute a newer turn's edits to an earlier one.
    it('does not attribute later-tracked files to earlier turns', async () => {
      const fileA = join(projectDir, 'a.txt');
      const fileB = join(projectDir, 'b.txt');
      await writeFile(fileA, 'A1');

      // Turn 1 only edits file A.
      await service.makeSnapshot('p1');
      await service.trackEdit(fileA);
      await writeFile(fileA, 'A2');

      // Turn 2 begins. makeSnapshot captures A's new state. File B does
      // not exist yet and isn't tracked.
      await service.makeSnapshot('p2');

      // Turn 2 creates file B for the first time.
      await service.trackEdit(fileB);
      await writeFile(fileB, 'B1');

      // Turn 3 begins. Now B is in trackedFiles → snapshot[2] captures it.
      await service.makeSnapshot('p3');

      // Turn 1's diff must reference only A, never B.
      const turn1 = await service.getTurnDiff('p1');
      expect(turn1).toBeDefined();
      const paths = turn1!.files.map((f) => f.filePath);
      expect(paths).toContain(basename(fileA));
      expect(paths).not.toContain(basename(fileB));
    });

    // Regression for the live-worktree read-failure collapse: if a file
    // becomes unreadable in the worktree (EACCES, EBUSY, …) we used to
    // treat it as deleted and synthesize a phantom delete hunk. Now we
    // drop the row so the dialog never lies about removals that didn't
    // actually happen.
    it('does not synthesize a delete hunk when the live worktree read fails', async () => {
      const file = join(projectDir, 'flaky.txt');
      await writeFile(file, 'still here\n');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, 'changed\n');

      // Replace the file with a directory so readFile rejects with EISDIR
      // (a non-ENOENT failure that previously masqueraded as deletion).
      await rm(file);
      await mkdir(file);

      const turn1 = await service.getTurnDiff('p1');
      expect(turn1).toBeDefined();
      const entry = turn1!.files.find((f) => f.filePath === basename(file));
      // Row dropped because the live endpoint is unreadable, not because
      // the file is gone.
      expect(entry).toBeUndefined();
    });

    it('flags oversized files instead of allocating large hunks', async () => {
      const file = join(projectDir, 'big.txt');
      // 1.5 MB > MAX_DIFF_SIZE_BYTES (1 MB)
      const big = 'x'.repeat(1_500_000);
      await writeFile(file, big);

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      // Append a small amount so before !== after but both endpoints are
      // still oversized.
      await writeFile(file, big + '\nappended\n');
      await service.makeSnapshot('p2');

      const turn1 = await service.getTurnDiff('p1');
      expect(turn1).toBeDefined();
      const entry = turn1!.files.find((f) => f.filePath === basename(file));
      expect(entry).toBeDefined();
      expect(entry!.oversized).toBe(true);
      expect(entry!.hunks).toEqual([]);
      // Pre-read size guard bails before allocating, so we cannot compute
      // a line-count delta. Stats are 0/0; the row's purpose is to signal
      // the omission, not to estimate changes.
      expect(entry!.linesAdded).toBe(0);
      expect(entry!.linesRemoved).toBe(0);
    });

    // Regression for the live-worktree branch of the OOM guard: the
    // previous oversized test compares two backups (both endpoints take
    // the backup branch), so it never exercised `readPathWithSizeGuard`
    // on the live worktree. This case has a single snapshot, so `after`
    // is read from the live file — verifying `stat()` + open/fstat there.
    it('flags oversized in the live-worktree branch (latest-turn endpoint)', async () => {
      const file = join(projectDir, 'live-big.txt');
      await writeFile(file, 'tiny seed\n');

      // Single snapshot: turn 1 has no successor, so its `after`
      // endpoint is the live worktree, not a backup.
      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      // Inflate past MAX_DIFF_SIZE_BYTES so the worktree-side guard
      // trips during getTurnDiff.
      await writeFile(file, 'x'.repeat(1_500_000));

      const turn1 = await service.getTurnDiff('p1');
      expect(turn1).toBeDefined();
      const entry = turn1!.files.find((f) => f.filePath === basename(file));
      expect(entry).toBeDefined();
      expect(entry!.oversized).toBe(true);
      expect(entry!.hunks).toEqual([]);
      expect(entry!.linesAdded).toBe(0);
      expect(entry!.linesRemoved).toBe(0);
      // Worktree exists at read time → not flagged as a deletion.
      expect(entry!.isDeleted).toBe(false);
    });

    // Mixed-size endpoint: only the `after` endpoint trips the cap. The
    // discriminated union must still narrow `.exists` correctly when the
    // two sides return different `kind`s.
    it('handles mixed-size endpoints (small before, oversized after)', async () => {
      const file = join(projectDir, 'mixed-big.txt');
      await writeFile(file, 'tiny seed\n');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      // Grow past cap *before* snapshot p2 captures it as a backup.
      await writeFile(file, 'x'.repeat(1_500_000));
      await service.makeSnapshot('p2');

      const turn1 = await service.getTurnDiff('p1');
      expect(turn1).toBeDefined();
      const entry = turn1!.files.find((f) => f.filePath === basename(file));
      expect(entry).toBeDefined();
      expect(entry!.oversized).toBe(true);
      // Before existed (snapshot has tiny content), so it's neither new
      // nor a deletion even though after is oversized.
      expect(entry!.isNewFile).toBe(false);
      expect(entry!.isDeleted).toBe(false);
    });

    // filesOmitted should be 0 in the happy-path cases and reflected on
    // every TurnDiff (regression: a forgetten field default would let
    // the dialog's truncation indicator stay silent under cap pressure).
    it('reports stats.filesOmitted === 0 when below the per-turn cap', async () => {
      const file = join(projectDir, 'omit-baseline.txt');
      await writeFile(file, 'a\n');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, 'a\nb\n');
      await service.makeSnapshot('p2');

      const turn1 = await service.getTurnDiff('p1');
      expect(turn1).toBeDefined();
      expect(turn1!.stats.filesOmitted).toBe(0);
    });
  });
});
