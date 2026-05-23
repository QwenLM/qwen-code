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
});
