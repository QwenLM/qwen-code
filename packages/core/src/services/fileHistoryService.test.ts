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
  utimes,
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

const V1_BACKUP = expect.objectContaining({
  backupFileName: expect.any(String),
  version: 1,
});

/** A restorable one-entry p1 snapshot with fixed timestamps. */
const restoredP1 = (key: string, backupFileName: string) => ({
  promptId: 'p1',
  trackedFileBackups: {
    [key]: {
      backupFileName,
      version: 1,
      backupTime: new Date('2026-06-13T00:00:00.000Z'),
    },
  },
  timestamp: new Date('2026-06-13T00:00:01.000Z'),
});

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

  const at = (name: string) => join(projectDir, name);
  const backupPath = (name: string) =>
    join(storageDir, 'file-history', 'test-session', name);
  const backupsAt = (i: number) => service.getSnapshots()[i].trackedFileBackups;
  const backupOf = (i: number) => backupsAt(i)['a.txt']!;
  const onlyBackup = (i: number) => Object.values(backupsAt(i))[0];
  // Replacing the storage root with a regular file makes the recursive
  // `mkdir(dirname(backupPath))` in `safeCopyFile` fail with ENOTDIR, a
  // non-ENOENT error that propagates to the caller's catch.
  const breakStorage = async () => {
    await rm(storageDir, { recursive: true, force: true });
    await writeFile(storageDir, '');
  };
  const repairStorage = async () => {
    await rm(storageDir, { recursive: true, force: true });
    await mkdir(storageDir, { recursive: true });
  };
  /** Writes `content` to `name` (none when undefined), then snapshots p1. */
  const prime = async (name: string, content?: string, svc = service) => {
    const file = at(name);
    if (content !== undefined) await writeFile(file, content);
    await svc.makeSnapshot('p1');
    return file;
  };
  /** prime, then track the file in p1. */
  const track = async (name: string, content?: string, svc = service) => {
    const file = await prime(name, content, svc);
    await svc.trackEdit(file);
    return file;
  };
  /** track, then rewrite the file with `after` and snapshot p2. */
  const trackAndEdit = async (
    name: string,
    before: string | undefined,
    after: string,
  ) => {
    const file = await track(name, before);
    await writeFile(file, after);
    await service.makeSnapshot('p2');
    return file;
  };
  /** A service whose recorder keeps a deep copy of each recorded snapshot. */
  const recording = (impl?: (snapshot: FileHistorySnapshot) => void) => {
    const recorded: FileHistorySnapshot[] = [];
    const recordSnapshot = vi.fn(
      impl ??
        ((snapshot: FileHistorySnapshot) => {
          recorded.push(structuredClone(snapshot));
        }),
    );
    const svc = new FileHistoryService(
      'test-session',
      true,
      projectDir,
      recordSnapshot,
    );
    return { recorded, recordSnapshot, svc };
  };

  it.each(['old mtime', 'invalid UTF-8'])(
    'preserves exact backup bytes with %s',
    async (scenario) => {
      const file = join(projectDir, 'a');
      const before =
        scenario === 'old mtime'
          ? Buffer.from('one')
          : Buffer.from([0xf0, 0x9f, 0x92]);
      const after = Buffer.from(scenario === 'old mtime' ? 'tri' : '\uFFFD');
      await writeFile(file, before);
      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, after);
      if (scenario === 'old mtime') await utimes(file, 0, 0);
      await service.makeSnapshot('p2');
      await writeFile(file, 'new');
      expect((await service.rewind('p2', false)).filesFailed).toEqual([]);
      expect(await readFile(file)).toEqual(after);
      expect((await service.rewind('p1', false)).filesFailed).toEqual([]);
      expect(await readFile(file)).toEqual(before);
    },
  );

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
      const { recorded, recordSnapshot, svc } = recording();
      await track('a.txt', 'original', svc);

      expect(recordSnapshot).toHaveBeenCalledTimes(1);
      expect(recorded[0].promptId).toBe('p1');
      expect(recorded[0].trackedFileBackups['a.txt']).toEqual(V1_BACKUP);
    });

    it('does not record duplicate tracking for the same file', async () => {
      const { recordSnapshot, svc } = recording();
      await svc.trackEdit(await track('a.txt', 'original', svc));

      expect(recordSnapshot).toHaveBeenCalledTimes(1);
    });

    it('does not record when the snapshot is removed while backup is in flight', async () => {
      const { recordSnapshot, svc } = recording();
      const edit = svc.trackEdit(await prime('a.txt', 'original', svc));
      svc.restoreFromSnapshots([]);
      await edit;

      expect(recordSnapshot).not.toHaveBeenCalled();
      expect(svc.getSnapshots()).toEqual([]);
    });

    it('records again when a second file is tracked in the same snapshot', async () => {
      const { recorded, recordSnapshot, svc } = recording();
      const secondFile = at('b.txt');
      await writeFile(secondFile, 'b-original');
      await track('a.txt', 'a-original', svc);
      await svc.trackEdit(secondFile);

      expect(recordSnapshot).toHaveBeenCalledTimes(2);
      expect(recorded[1].trackedFileBackups['a.txt']).toEqual(V1_BACKUP);
      expect(recorded[1].trackedFileBackups['b.txt']).toEqual(V1_BACKUP);
    });

    it('swallows recorder errors after tracking a file', async () => {
      const { recordSnapshot, svc } = recording(() => {
        throw new Error('record failed');
      });
      const file = await prime('a.txt', 'original', svc);
      await expect(svc.trackEdit(file)).resolves.toBeUndefined();

      expect(recordSnapshot).toHaveBeenCalledTimes(1);
      expect(svc.getSnapshots()[0].trackedFileBackups['a.txt']).toEqual(
        V1_BACKUP,
      );
    });

    it('should back up file before first edit in a snapshot', async () => {
      await track('a.txt', 'original');

      const snapshots = service.getSnapshots();
      expect(snapshots).toHaveLength(1);
      const backups = snapshots[0].trackedFileBackups;
      const key = Object.keys(backups)[0];
      expect(key).toBeDefined();
      expect(backups[key].version).toBe(1);
      expect(backups[key].backupFileName).not.toBeNull();
    });

    it('should skip if file already tracked in current snapshot', async () => {
      await service.trackEdit(await track('a.txt', 'original')); // second call

      expect(Object.keys(backupsAt(0))).toHaveLength(1);
    });

    it('should record null backup for non-existent file', async () => {
      await track('nonexistent.txt');

      expect(onlyBackup(0).backupFileName).toBeNull();
    });

    // trackEdit swallows createBackup failures so the calling tool
    // (edit / write_file) never breaks on file-history I/O errors.
    it('does not throw and records nothing when createBackup fails', async () => {
      const file = await prime('a.txt', 'original');
      await breakStorage();

      await expect(service.trackEdit(file)).resolves.toBeUndefined();
      expect(backupsAt(0)).toEqual({});
    });

    // Sticky-failed guard, trackEdit side: after makeSnapshot records a
    // `failed: true` marker (e.g. transient disk full), the next trackEdit
    // (a tool about to modify the file) must not skip because the entry
    // exists; it retries the backup and replaces the marker on success.
    // Otherwise the flag sticks until the content changes, poisoning rewind.
    it('heals a failed entry on the next trackEdit attempt', async () => {
      const { recorded, recordSnapshot, svc } = recording();
      service = svc;
      const file = await track('a.txt', 'p1-content');

      // Change the content so makeSnapshot reaches createBackup (unchanged
      // files short-circuit in checkOriginFileChanged), then make it throw.
      await writeFile(file, 'p2-content');
      await breakStorage();
      await service.makeSnapshot('p2');
      expect(backupOf(1).failed).toBe(true);

      // With storage repaired, trackEdit must run createBackup again.
      await repairStorage();
      await service.trackEdit(file);

      const p2Backup = backupOf(1);
      expect(p2Backup).toBeDefined();
      expect(p2Backup.failed).toBeFalsy();
      expect(p2Backup.backupFileName).not.toBeNull();
      expect(recordSnapshot).toHaveBeenCalledTimes(2);
      expect(recorded[1]).toEqual(
        expect.objectContaining({
          promptId: 'p2',
          trackedFileBackups: expect.objectContaining({ 'a.txt': p2Backup }),
        }),
      );

      // The new backup must hold the current content: guards against the
      // heal path reusing `previous.backupFileName` (the older p1-content).
      expect(
        await readFile(backupPath(p2Backup.backupFileName!), 'utf-8'),
      ).toBe('p2-content');
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
      await trackAndEdit('a.txt', 'v1', 'v2-modified');

      expect(service.getSnapshots()).toHaveLength(2);
      // Version should increment
      expect(onlyBackup(1).version).toBe(2);
    });

    it('should inherit version for unchanged files', async () => {
      await track('a.txt', 'unchanged');
      await service.makeSnapshot('p2');

      // Same backup reference (version unchanged)
      expect(onlyBackup(1).backupFileName).toBe(onlyBackup(0).backupFileName);
    });

    // A per-file backup that throws inside makeSnapshot must not silently
    // inherit the previous snapshot's backup as this turn's state (a later
    // rewind would restore older content while reporting success). It
    // records `failed: true` so rewind lists the file in filesFailed and
    // getDiffStats omits it.
    it('marks per-file backup failures and does not silently inherit', async () => {
      const file = await track('a.txt', 'p1-content');
      // Change the file and break storage so p2's per-file backup throws.
      await writeFile(file, 'p2-content');
      await breakStorage();
      await service.makeSnapshot('p2');

      const p2Backup = backupOf(1);
      expect(p2Backup).toBeDefined();
      expect(p2Backup.failed).toBe(true);

      // Rewind to p2 must report the file as failed, not silently
      // restore p1-content as if it were the captured state of p2.
      const result = await service.rewind('p2');
      expect(result.filesChanged).toEqual([]);
      expect(result.filesFailed).toContain(file);
    });

    // After a transient backup failure, the no-change optimization must not
    // copy the failed entry forward: the flag would stick while the file is
    // unchanged, poisoning rewind even after the backup target recovers.
    it('does not carry a failed marker forward when the file is unchanged', async () => {
      await track('a.txt', 'stable-content');
      // Break storage so p2's backup throws; do NOT change the content.
      await breakStorage();
      await service.makeSnapshot('p2');
      expect(backupOf(1).failed).toBe(true);

      // Storage repaired, file still unchanged: p3 must retry the backup
      // (not copy p2's failed entry forward) and record a fresh entry.
      await repairStorage();
      await service.makeSnapshot('p3');

      const p3Backup = backupOf(2);
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
      const file = await trackAndEdit('a.txt', 'original', 'modified');

      const result = await service.rewind('p1');
      expect(result.filesChanged).toContain(file);
      expect(result.filesFailed).toHaveLength(0);
      expect(await readFile(file, 'utf-8')).toBe('original');
    });

    it('should delete file that did not exist at target snapshot', async () => {
      // Non-existent when tracked → null backup.
      const file = await trackAndEdit('new-file.txt', undefined, 'created');

      const result = await service.rewind('p1');
      expect(result.filesChanged).toContain(file);
      expect(existsSync(file)).toBe(false);
    });

    it('should return filesFailed when backup file is missing on disk', async () => {
      await trackAndEdit('a.txt', 'original', 'modified');

      // Delete the backup file to simulate corruption
      const backupFileName = onlyBackup(0).backupFileName;
      expect(backupFileName).not.toBeNull();
      await rm(backupPath(backupFileName!), { force: true });

      const result = await service.rewind('p1');
      expect(result.filesFailed.length).toBeGreaterThan(0);
    });

    // Edge case: both the on-disk backup and the working file were removed
    // externally. The target snapshot still expects the file, so rewind
    // must report filesFailed instead of silently reporting success.
    it('should report filesFailed when both backup and working file are gone', async () => {
      const file = await trackAndEdit('a.txt', 'original', 'modified');
      await rm(backupPath(backupOf(0).backupFileName!), { force: true });
      await rm(file, { force: true });

      const result = await service.rewind('p1');
      expect(result.filesChanged).toEqual([]);
      expect(result.filesFailed.length).toBeGreaterThan(0);
    });

    it('should preserve snapshot timeline when truncateHistory=false', async () => {
      await trackAndEdit('a.txt', 'original', 'modified');

      await service.rewind('p1', false);

      const snapshots = service.getSnapshots();
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0].promptId).toBe('p1');
      expect(snapshots[1].promptId).toBe('p2');
    });

    it('should truncate snapshot timeline when truncateHistory=true', async () => {
      await trackAndEdit('a.txt', 'original', 'modified');
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

    // A shared id must not select and truncate an arbitrary snapshot.
    it('should refuse to rewind a promptId shared by two snapshots', async () => {
      const file = join(projectDir, 'a.txt');
      await writeFile(file, 'original');

      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, 'modified');
      await service.makeSnapshot('p1');

      await expect(service.rewind('p1', true)).rejects.toThrow(
        'The selected snapshot shares its checkpoint identity with another turn',
      );

      // The refusal must leave the timeline (and the file) untouched.
      expect(service.getSnapshots().map((s) => s.promptId)).toEqual([
        'p1',
        'p1',
      ]);
      expect(await readFile(file, 'utf-8')).toBe('modified');
    });

    it('should not truncate snapshot timeline when restore has failures', async () => {
      await trackAndEdit('a.txt', 'original', 'modified');
      await service.makeSnapshot('p3');

      // Corrupt the p1 backup so applySnapshot reports a failure.
      await rm(backupPath(onlyBackup(0).backupFileName!), { force: true });

      const result = await service.rewind('p1', true);
      expect(result.filesFailed.length).toBeGreaterThan(0);
      // Timeline must stay intact so the user can retry without losing state.
      const after = service.getSnapshots();
      expect(after.map((s) => s.promptId)).toEqual(['p1', 'p2', 'p3']);
    });

    // checkOriginFileChanged short-circuits the restore when the file on
    // disk already matches the target backup. Covered explicitly so a
    // stat/content-comparison regression surfaces here, not as silent
    // extra (or skipped) writes to user files.
    it('does not touch a file whose content matches the target snapshot', async () => {
      const file = await track('a.txt', 'unchanged');
      await service.makeSnapshot('p2');

      // Unchanged since p1: capture mtime to verify rewind does not rewrite it.
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
      const file = at('a.txt');
      await writeFile(file, 'original');

      await service.trackEdit(file);

      expect(service.getSnapshots()).toEqual([]);
    });
  });

  describe('restoreFromSnapshots', () => {
    it('should rehydrate snapshots and derive trackedFiles', async () => {
      const fresh = new FileHistoryService('test-session', true, projectDir);
      const absPath = at('a.txt');
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
      const { recorded, recordSnapshot, svc: fresh } = recording();

      fresh.restoreFromSnapshots([restoredP1('a.txt', 'deadbeefcafebabe@v1')]);
      await fresh.validateRestoredSnapshots();

      const backup = fresh.getSnapshots()[0]!.trackedFileBackups['a.txt']!;
      expect(backup.failed).toBe(true);
      expect(recordSnapshot).toHaveBeenCalledTimes(1);
      expect(recorded[0]!.trackedFileBackups['a.txt']?.failed).toBe(true);
    });

    it('does not restore backup files that escape the session directory', async () => {
      const fresh = new FileHistoryService('test-session', true, projectDir);
      const victim = at('victim.txt');
      await writeFile(victim, 'current');
      await writeFile(join(storageDir, 'outside.txt'), 'outside');

      fresh.restoreFromSnapshots([
        restoredP1('victim.txt', '../../outside.txt'),
      ]);

      const result = await fresh.rewind('p1');

      expect(result.filesChanged).toEqual([]);
      expect(result.filesFailed).toContain(victim);
      expect(await readFile(victim, 'utf-8')).toBe('current');
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

    it('should delete orphaned backup files on overflow', async () => {
      const file = at('a.txt');
      await writeFile(file, 'v0');

      await service.makeSnapshot('p0');
      await service.trackEdit(file); // version 1, content 'v0'

      // Capture v1 from p0 before it gets evicted.
      const evictedNames: string[] = [backupOf(0).backupFileName!];

      // 104 more snapshots, each with new content → fresh backup per snapshot.
      for (let i = 1; i < 105; i++) {
        await writeFile(file, `v${i}`);
        await service.makeSnapshot(`p${i}`);
        if (i < 5) evictedNames.push(backupOf(i).backupFileName!);
      }

      // p0..p4 (versions 1..5) were dropped by slice(-100); their backups should be gone.
      for (const name of evictedNames) {
        expect(existsSync(backupPath(name))).toBe(false);
      }
      // The surviving snapshots' backups must still exist.
      for (const s of service.getSnapshots()) {
        const bn = s.trackedFileBackups['a.txt']?.backupFileName;
        if (bn) expect(existsSync(backupPath(bn))).toBe(true);
      }
    }, 20_000);

    it('should preserve deduplicated backup files referenced by survivors', async () => {
      const file = at('a.txt');
      await writeFile(file, 'unchanged');

      await service.makeSnapshot('p0');
      await service.trackEdit(file);
      const sharedName = backupOf(0).backupFileName!;

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
      const file = await track('a.txt', 'v0');
      const names = [backupOf(0).backupFileName!];
      for (const i of [1, 2]) {
        await writeFile(file, `v${i}`);
        await service.makeSnapshot(`p${i + 1}`);
        names.push(backupOf(i).backupFileName!);
      }
      const [v1, v2, v3] = names;

      await service.rewind('p1', true);

      // p1's backup is still referenced; p2 and p3's unique-version backups are gone.
      expect(existsSync(backupPath(v1))).toBe(true);
      expect(existsSync(backupPath(v2))).toBe(false);
      expect(existsSync(backupPath(v3))).toBe(false);
    });
  });

  describe('getDiffStats', () => {
    it('should compute correct insertions and deletions', async () => {
      const file = await trackAndEdit(
        'a.txt',
        'line1\nline2\nline3\n',
        'line1\nmodified\nline3\nnewline\n',
      );

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
    const turnDiff = async () => {
      const turn = await service.getTurnDiff('p1');
      expect(turn).toBeDefined();
      return turn!;
    };
    const findEntry = async (file: string) =>
      (await turnDiff()).files.find((f) => f.filePath === basename(file));
    const fileEntry = async (file: string) => {
      const entry = await findEntry(file);
      expect(entry).toBeDefined();
      return entry!;
    };

    it('returns undefined when disabled', async () => {
      const disabled = new FileHistoryService('s', false, projectDir);
      expect(await disabled.getTurnDiff('p1')).toBeUndefined();
    });

    it('returns undefined when the prompt has no snapshot', async () => {
      expect(await service.getTurnDiff('missing')).toBeUndefined();
    });

    it('diffs a turn against the next snapshot', async () => {
      // Mirrors what `client.ts` does on every UserQuery turn: turn 1 starts
      // (makeSnapshot → trackEdit captures the pre-edit state), the tool
      // edits, and turn 2's snapshot becomes turn 1's "after".
      const file = await trackAndEdit(
        'a.txt',
        'line1\nline2\nline3\n',
        'line1\nLINE2_EDITED\nline3\n',
      );

      const turn1 = await turnDiff();
      expect(turn1.files).toHaveLength(1);
      // filePath is repo-relative (matches Current source convention).
      expect(turn1.files[0].filePath).toBe(basename(file));
      expect(turn1.files[0].linesAdded).toBe(1);
      expect(turn1.files[0].linesRemoved).toBe(1);
      expect(turn1.files[0].isNewFile).toBe(false);
      expect(turn1.files[0].isDeleted).toBe(false);
      expect(turn1.stats.filesChanged).toBe(1);
    });

    it('compares the latest turn against the live worktree', async () => {
      const file = await track('b.txt', 'before');
      await writeFile(file, 'after-edit-1\nafter-edit-2');

      const turn = await turnDiff();
      expect(turn.files).toHaveLength(1);
      // 2 added lines (or 1 add + content change depending on diff alg)
      expect(
        turn.files[0].linesAdded + turn.files[0].linesRemoved,
      ).toBeGreaterThan(0);
    });

    it('flags newly created files', async () => {
      // The tool creates the file mid-turn 1; trackEdit captures the
      // pre-state (file does not exist) in a snapshot with no other files.
      const file = await trackAndEdit('new.txt', undefined, 'fresh content\n');

      const entry = await fileEntry(file);
      expect(entry.isNewFile).toBe(true);
      expect(entry.isDeleted).toBe(false);
      expect(entry.linesAdded).toBeGreaterThan(0);
    });

    it('skips files with no change between snapshots', async () => {
      await track('untouched.txt', 'stable\n');
      // No actual modification before next snapshot.
      await service.makeSnapshot('p2');

      const turn1 = await turnDiff();
      // Tracked but identical content: must not appear in the per-turn diff.
      expect(turn1.files).toHaveLength(0);
      expect(turn1.stats.filesChanged).toBe(0);
    });

    // Regression for the silent-empty-string bug: a backup with a real
    // backupFileName that is unreadable on disk used to be coerced to '',
    // producing a fake "every line added" diff. The row is now dropped so
    // the dialog doesn't show phantom changes.
    it('skips files whose backup file is missing on disk', async () => {
      await trackAndEdit('lostbackup.txt', 'before', 'after');

      // Wipe the backup directory; the snapshot records still point at it.
      await rm(join(storageDir, 'file-history'), {
        recursive: true,
        force: true,
      });

      expect((await turnDiff()).files).toHaveLength(0);
    });

    it('detects files deleted during a turn', async () => {
      const file = await track('doomed.txt', 'line a\nline b\n');
      // Simulate the tool deleting the file mid-turn.
      await rm(file);
      await service.makeSnapshot('p2');

      const entry = await fileEntry(file);
      expect(entry.isDeleted).toBe(true);
      expect(entry.isNewFile).toBe(false);
      expect(entry.linesRemoved).toBeGreaterThan(0);
    });

    it('flags binary content with isBinary and skips hunk generation', async () => {
      // PNG-ish header: NUL bytes in the sniff window trip looksBinary. The
      // edit appends more binary bytes so before !== after.
      const file = await trackAndEdit(
        'image.bin',
        '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR',
        '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00',
      );

      const entry = await fileEntry(file);
      expect(entry.isBinary).toBe(true);
      expect(entry.hunks).toEqual([]);
    });

    // Files the target snapshot didn't capture (e.g. first tracked in a
    // later turn) must not show up in its diff, or a newer turn's edits
    // would be attributed to an earlier one.
    it('does not attribute later-tracked files to earlier turns', async () => {
      // Turn 1 only edits A; turn 2's snapshot captures A's new state while
      // B does not exist yet and isn't tracked.
      const fileA = await trackAndEdit('a.txt', 'A1', 'A2');

      // Turn 2 creates B; turn 3's snapshot captures it.
      const fileB = at('b.txt');
      await service.trackEdit(fileB);
      await writeFile(fileB, 'B1');
      await service.makeSnapshot('p3');

      // Turn 1's diff must reference only A, never B.
      const paths = (await turnDiff()).files.map((f) => f.filePath);
      expect(paths).toContain(basename(fileA));
      expect(paths).not.toContain(basename(fileB));
    });

    // Regression for the live-worktree read-failure collapse: a file that
    // is unreadable in the worktree (EACCES, EBUSY, …) used to be treated
    // as deleted with a phantom delete hunk. The row is now dropped so the
    // dialog never reports removals that didn't happen.
    it('does not synthesize a delete hunk when the live worktree read fails', async () => {
      const file = await track('flaky.txt', 'still here\n');
      await writeFile(file, 'changed\n');

      // Replace the file with a directory so readFile rejects with EISDIR
      // (a non-ENOENT failure that previously masqueraded as deletion).
      await rm(file);
      await mkdir(file);

      // Row dropped because the live endpoint is unreadable, not because
      // the file is gone.
      expect(await findEntry(file)).toBeUndefined();
    });

    // Regression for the unbounded structuredPatch allocation: one huge
    // file in history could blow up TUI memory when /diff opens. Oversized
    // rows skip hunk construction but still surface in the file list.
    it('flags oversized files instead of allocating large hunks', async () => {
      // 1.5 MB > MAX_DIFF_SIZE_BYTES (1 MB). The edit appends a little so
      // before !== after while both endpoints stay oversized.
      const big = 'x'.repeat(1_500_000);
      const file = await trackAndEdit('big.txt', big, big + '\nappended\n');

      const entry = await fileEntry(file);
      expect(entry.oversized).toBe(true);
      expect(entry.hunks).toEqual([]);
      // The pre-read size guard bails before allocating, so no line-count
      // delta: stats are 0/0; the row only signals the omission.
      expect(entry.linesAdded).toBe(0);
      expect(entry.linesRemoved).toBe(0);
    });

    // Live-worktree branch of the OOM guard: the previous test compares two
    // backups, so it never exercised `readPathWithSizeGuard` on the live
    // file. With a single snapshot, turn 1's `after` is read from the
    // worktree, verifying `stat()` + open/fstat there.
    it('flags oversized in the live-worktree branch (latest-turn endpoint)', async () => {
      const file = await track('live-big.txt', 'tiny seed\n');
      // Inflate past MAX_DIFF_SIZE_BYTES so the worktree-side guard trips.
      await writeFile(file, 'x'.repeat(1_500_000));

      const entry = await fileEntry(file);
      expect(entry.oversized).toBe(true);
      expect(entry.hunks).toEqual([]);
      expect(entry.linesAdded).toBe(0);
      expect(entry.linesRemoved).toBe(0);
      // Worktree exists at read time → not flagged as a deletion.
      expect(entry.isDeleted).toBe(false);
    });

    // Mixed-size endpoints: only `after` trips the cap. The discriminated
    // union must still narrow `.exists` when the two sides return different
    // `kind`s.
    it('handles mixed-size endpoints (small before, oversized after)', async () => {
      // Grow past the cap *before* snapshot p2 captures it as a backup.
      const file = await trackAndEdit(
        'mixed-big.txt',
        'tiny seed\n',
        'x'.repeat(1_500_000),
      );

      const entry = await fileEntry(file);
      expect(entry.oversized).toBe(true);
      // Before existed (tiny content), so neither new nor a deletion even
      // though after is oversized.
      expect(entry.isNewFile).toBe(false);
      expect(entry.isDeleted).toBe(false);
    });

    // filesOmitted must be 0 on the happy path and present on every TurnDiff
    // (regression: a forgotten field default would leave the dialog's
    // truncation indicator silent under cap pressure).
    it('reports stats.filesOmitted === 0 when below the per-turn cap', async () => {
      await trackAndEdit('omit-baseline.txt', 'a\n', 'a\nb\n');

      expect((await turnDiff()).stats.filesOmitted).toBe(0);
    });
  });
});
