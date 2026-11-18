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
  symlink,
  utimes,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { existsSync, type Stats } from 'node:fs';
import { basename, join, sep } from 'node:path';
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
  serializeSnapshot,
  deserializeSnapshots,
  type FileHistorySnapshot,
  type RetainedFileHistoryStorage,
  type SerializedFileHistorySnapshot,
} from './fileHistoryService.js';

import {
  areSnapshotOriginsEqual,
  getCapturePath,
  deletionDropsRequiredEndpoint,
  removeFileHistorySnapshots,
} from '../utils/file-history-snapshots.js';

import { expectWithinLatencyBudget } from '../test-utils/latency-budget.js';

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

    // Blocking B regression gate: the alias-aware per-file lookups once
    // rescanned every snapshot's every raw key (normalizing each) for each
    // execution path, making ordinary checkpoint creation
    // O(snapshotCount × fileCount²) without any aliases or malformed
    // history — a reviewer probe measured ~22.4 s at 99×500 with the event
    // loop blocked throughout. Identity indexes now make each snapshot's
    // grouping a one-time O(files) build. This fixed-size budget guards
    // against reintroducing that regression; it does not prove asymptotic
    // complexity across arbitrary snapshot and file counts.
    it('bounds ordinary checkpoint creation with a performance regression guard', async () => {
      const snapshotsToBuild = 80;
      const fileCount = 450;
      const working = new Map<string, string>();
      const backups = new Map<string, string>();
      const source = (content: string) => ({
        kind: 'descriptor' as const,
        fileHandle: {} as never,
        stats: {
          mode: 0o644,
          size: Buffer.byteLength(content),
        } as Stats,
      });
      // Entirely in-memory retained storage: sizes grow every turn so the
      // unchanged-reuse check always requests a fresh capture and the run
      // measures lookup cost, never backup I/O.
      const storage: RetainedFileHistoryStorage = {
        async withWorkingFile(path, operation) {
          const content = working.get(path);
          return operation(content === undefined ? null : source(content));
        },
        async withBackupFile(name, operation) {
          const content = backups.get(name);
          if (content === undefined) throw new Error(`missing ${name}`);
          return operation(source(content));
        },
        async createBackup(path, version) {
          const content = working.get(path);
          if (content === undefined)
            return { backupFileName: null, version, backupTime: new Date() };
          const name = `${path}@v${version}`;
          backups.set(name, content);
          return { backupFileName: name, version, backupTime: new Date() };
        },
      };
      const svc = new FileHistoryService(
        'perf-linear',
        true,
        '/perf-root',
        undefined,
        storage,
      );
      const contentAt = (turn: number, index: number) =>
        `t${turn}-${index}-${'x'.repeat(turn + 4)}`;
      const paths = Array.from(
        { length: fileCount },
        (_, index) => `/perf-root/file-${index}.txt`,
      );
      paths.forEach((p, index) => working.set(p, contentAt(0, index)));

      const started = Date.now();
      await svc.makeSnapshot('p0');
      for (const p of paths) await svc.trackEdit(p);
      for (let turn = 1; turn < snapshotsToBuild; turn++) {
        for (let index = 0; index < fileCount; index++)
          working.set(paths[index]!, contentAt(turn, index));
        await svc.makeSnapshot(`p${turn}`);
      }
      const elapsedMs = Date.now() - started;

      // Correctness at scale: every tracked path resolved through the
      // identity groups on every snapshot and its version counter reached
      // exactly one bump per turn.
      const last = svc.getSnapshots().at(-1)!;
      expect(Object.keys(last.trackedFileBackups)).toHaveLength(fileCount);
      for (const backup of Object.values(last.trackedFileBackups))
        expect(backup.version).toBe(snapshotsToBuild);
      expectWithinLatencyBudget(elapsedMs, 4_000);
    }, 120_000);
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
    it.each(
      (['local', 'equivalent', 'legacy', 'foreign'] as const).flatMap(
        (origin) =>
          (['tracked', 'diff'] as const).flatMap((endpoint) =>
            (['relative', 'absolute', 'external'] as const).map((keyKind) => ({
              origin,
              endpoint,
              keyKind,
            })),
          ),
      ),
    )(
      'recaptures only local or legacy candidates ($origin, $endpoint, $keyKind)',
      async ({ origin, endpoint, keyKind }) => {
        const captureRoot = origin === 'foreign' ? at('foreign') : projectDir;
        const key =
          keyKind === 'relative'
            ? 'f'
            : keyKind === 'absolute'
              ? join(captureRoot, 'f')
              : join(storageDir, 'external');
        const candidate = keyKind === 'external' ? key : at('f');
        await writeFile(candidate, 'unrelated local bytes');
        const backups = {
          [key]: { backupFileName: null, version: 1, backupTime: new Date() },
        };
        const snapshot: FileHistorySnapshot = {
          promptId: 'p1',
          timestamp: new Date(),
          cwd:
            origin === 'legacy'
              ? undefined
              : origin === 'equivalent'
                ? projectDir + sep
                : captureRoot,
          trackedFileBackups: endpoint === 'tracked' ? backups : {},
          ...(endpoint === 'diff' ? { diffAfterBackups: backups } : {}),
        };
        service.restoreFromSnapshots([snapshot]);
        const before = service.getSnapshots().map(serializeSnapshot);
        await service.makeSnapshot('p2');
        const next = service.getSnapshots()[1];
        expect(next.cwd).toBe(projectDir);
        expect(
          service.getSnapshots().slice(0, 1).map(serializeSnapshot),
        ).toEqual(before);
        const records = Object.values(next.trackedFileBackups);
        if (origin === 'foreign') {
          expect(records).toEqual([]);
          expect(existsSync(join(storageDir, 'file-history'))).toBe(false);
        } else {
          expect(records).toHaveLength(1);
          expect(records[0].failed).toBeFalsy();
          expect(
            await readFile(backupPath(records[0].backupFileName!), 'utf8'),
          ).toBe('unrelated local bytes');
        }
      },
    );

    it.each([false, true])(
      'keeps newly tracked __proto__ records after hydration (parentSensitive=%s)',
      async (parentSensitive) => {
        const cwd = parentSensitive ? at('child') + sep + '..' : projectDir;
        await mkdir(at('child'));
        const fresh = new FileHistoryService('test-session', true, cwd);
        fresh.restoreFromSnapshots(
          deserializeSnapshots([
            {
              promptId: 'p1',
              cwd,
              timestamp: new Date().toISOString(),
              trackedFileBackups: {},
              diffAfterBackups: {},
            },
          ]),
        );
        await fresh.trackEdit('__proto__');
        const [snapshot] = fresh.getSnapshots();
        expect(Object.hasOwn(snapshot.trackedFileBackups, '__proto__')).toBe(
          true,
        );
        const payload = JSON.parse(JSON.stringify(serializeSnapshot(snapshot)));
        expect(Object.keys(payload.trackedFileBackups)).toEqual(['__proto__']);
        const reloaded = new FileHistoryService('test-session', true, cwd);
        reloaded.restoreFromSnapshots(deserializeSnapshots([payload]));
        await writeFile(at('__proto__'), 'created after capture');
        expect(await reloaded.rewind('p1')).toEqual({
          filesChanged: [cwd + sep + '__proto__'],
          filesFailed: [],
        });
        expect(existsSync(at('__proto__'))).toBe(false);
      },
    );

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

  describe('R11 captured identity', () => {
    const reload = async (cwd: string, snapshots: FileHistorySnapshot[]) => {
      const payload = at('r11-history.json');
      await writeFile(
        payload,
        JSON.stringify(snapshots.map(serializeSnapshot)),
      );
      const fresh = new FileHistoryService('test-session', true, cwd);
      fresh.restoreFromSnapshots(
        deserializeSnapshots(JSON.parse(await readFile(payload, 'utf8'))),
      );
      await fresh.validateRestoredSnapshots();
      return fresh;
    };

    it.each(['same', 'external to local', 'local to external'])(
      'keeps the first confirmed baseline after %s relocation',
      async (direction) => {
        const a = at('A');
        const b = at('B');
        await mkdir(a);
        await mkdir(b);
        const file = join(b, 'f');
        const origin = direction === 'external to local' ? a : b;
        const destination = direction === 'local to external' ? a : b;
        const original = new FileHistoryService('test-session', true, origin);
        await writeFile(file, 'old');
        await original.makeSnapshot('a1');
        await original.trackEdit(file);
        const fresh = await reload(destination, original.getSnapshots());
        await fresh.makeSnapshot('b1');
        if (direction === 'external to local') await fresh.trackEdit(file);
        const before = serializeSnapshot(fresh.getSnapshots()[1]);
        await writeFile(file, 'outside-change');
        await fresh.trackEdit(file);
        if (direction !== 'local to external') {
          await fresh.trackEdit('f');
          expect(serializeSnapshot(fresh.getSnapshots()[1])).toEqual(before);
        }
        await writeFile(file, 'tool-change');
        const resumed = await reload(destination, [fresh.getSnapshots()[1]]);
        expect((await resumed.rewind('b1')).filesFailed).toEqual([]);
        expect(await readFile(file, 'utf8')).toBe(
          direction === 'local to external' ? 'outside-change' : 'old',
        );
        if (direction === 'local to external')
          expect(existsSync(join(a, 'f'))).toBe(false);
        const again = await reload(destination, resumed.getSnapshots());
        expect((await again.rewind('b1', false)).filesFailed).toEqual([]);
      },
    );

    it('does not recapture confirmed nonexistence through an absolute alias', async () => {
      await service.makeSnapshot('p1');
      await service.trackEdit(at('f'));
      const baseline = structuredClone(service.getSnapshots()[0]);
      baseline.trackedFileBackups[at('f')] = baseline.trackedFileBackups['f'];
      delete baseline.trackedFileBackups['f'];
      service.restoreFromSnapshots([baseline]);
      await writeFile(at('f'), 'created later');
      await service.trackEdit('f');
      expect(
        Object.values(service.getSnapshots()[0].trackedFileBackups),
      ).toEqual([baseline.trackedFileBackups[at('f')]]);
      expect((await service.rewind('p1')).filesFailed).toEqual([]);
      expect(existsSync(at('f'))).toBe(false);
    });

    it.each(['insertion', 'reverse', 'lexical'])(
      'preserves ambiguous raw aliases and refuses restoration (%s)',
      async (order) => {
        const file = await track('f', 'old');
        const first = structuredClone(service.getSnapshots()[0]);
        await writeFile(file, 'later');
        await service.makeSnapshot('p2');
        const second = service.getSnapshots()[1];
        const entries: Array<
          [string, (typeof first.trackedFileBackups)[string]]
        > = [
          [file, first.trackedFileBackups['f']],
          ['f', { ...second.trackedFileBackups['f'], backupTime: new Date(0) }],
        ];
        if (order === 'reverse') entries.reverse();
        if (order === 'lexical') entries.sort(([a], [b]) => a.localeCompare(b));
        first.trackedFileBackups = Object.fromEntries(entries);
        const fresh = await reload(projectDir, [first, second]);
        const serialized = fresh.getSnapshots().map(serializeSnapshot);
        expect(
          Object.keys(fresh.getSnapshots()[0].trackedFileBackups),
        ).toHaveLength(2);
        await writeFile(file, 'untouched');
        expect((await fresh.rewind('p1')).filesFailed).toEqual([file]);
        expect(await readFile(file, 'utf8')).toBe('untouched');
        expect(fresh.getSnapshots().map(serializeSnapshot)).toEqual(serialized);
        expect((await fresh.getDiffStats('p1'))?.filesChanged).toEqual([]);
        expect((await fresh.getTurnDiff('p1'))?.files).toEqual([]);
        for (const [, backup] of entries)
          expect(existsSync(backupPath(backup.backupFileName!))).toBe(true);
        const again = await reload(projectDir, fresh.getSnapshots());
        expect(again.getSnapshots().map(serializeSnapshot)).toEqual(serialized);
      },
    );

    it.each([false, true])(
      'reads healed aliases without losing failed version evidence (reverse=%s)',
      async (reverse) => {
        const file = await track('f', 'healed');
        const snapshot = structuredClone(service.getSnapshots()[0]);
        const confirmed = snapshot.trackedFileBackups['f'];
        const entries: Array<[string, typeof confirmed]> = [
          [file, { ...confirmed, failed: true, version: 7 }],
          ['f', confirmed],
        ];
        if (reverse) entries.reverse();
        snapshot.trackedFileBackups = Object.fromEntries(entries);
        const fresh = await reload(projectDir, [snapshot]);
        expect(
          Object.values(fresh.getSnapshots()[0].trackedFileBackups)
            .map((b) => b.version)
            .sort(),
        ).toEqual([1, 7]);
        await writeFile(file, 'changed');
        await fresh.makeSnapshot('p2');
        expect(
          Object.values(fresh.getSnapshots()[1].trackedFileBackups),
        ).toHaveLength(1);
        expect(fresh.getSnapshots()[1].trackedFileBackups['f'].version).toBe(8);
        expect((await fresh.rewind('p1', false)).filesFailed).toEqual([]);
        expect(await readFile(file, 'utf8')).toBe('healed');
      },
    );

    it('keeps tracked and diff-after baselines separate while deduplicating targets', async () => {
      const file = await track('f', 'before');
      const before = structuredClone(service.getSnapshots()[0]);
      await writeFile(file, 'after');
      await service.makeSnapshot('p2');
      before.diffAfterBackups = {
        [file]: service.getSnapshots()[1].trackedFileBackups['f'],
      };
      before.trackedFileBackups[file] = before.trackedFileBackups['f'];
      service = await reload(projectDir, [before]);
      const diff = await service.getTurnDiff('p1');
      expect(diff?.files).toHaveLength(1);
      expect(diff?.files[0].hunks[0].lines).toContain('-before');
      expect(diff?.files[0].hunks[0].lines).toContain('+after');
      expect((await service.rewind('p1', false)).filesFailed).toEqual([]);
      expect(await readFile(file, 'utf8')).toBe('before');
      await writeFile(file, 'new checkpoint');
      await service.makeSnapshot('p3');
      expect(Object.keys(service.getSnapshots()[1].trackedFileBackups)).toEqual(
        ['f'],
      );
      expect(service.getSnapshots()[1].trackedFileBackups['f'].version).toBe(3);
    });

    it('heals a real failed external alias after relocation', async () => {
      const a = at('A');
      const b = at('B');
      await mkdir(a);
      await mkdir(b);
      const file = join(b, 'f');
      const original = new FileHistoryService('test-session', true, a);
      await writeFile(file, 'old');
      await original.makeSnapshot('a1');
      await original.trackEdit(file);
      const fresh = await reload(b, original.getSnapshots());
      await fresh.makeSnapshot('b0');
      await fresh.trackEdit(file);
      await rm(file);
      await mkdir(file);
      await fresh.makeSnapshot('b1');
      expect(
        Object.values(fresh.getSnapshots()[2].trackedFileBackups)[0].failed,
      ).toBe(true);
      await rm(file, { recursive: true });
      await writeFile(file, 'healed');
      await fresh.trackEdit(file);
      await writeFile(file, 'after healing');
      const resumed = await reload(b, [fresh.getSnapshots()[2]]);
      expect((await resumed.rewind('b1')).filesFailed).toEqual([]);
      expect(await readFile(file, 'utf8')).toBe('healed');
    });

    it.each(['tracked', 'diffAfter'] as const)(
      'preserves equal-version conflicting references in the %s endpoint',
      async (endpoint) => {
        const file = await track('f', 'first');
        const first = structuredClone(service.getSnapshots()[0]);
        await service.trackEdit(at('g'));
        const absent = service.getSnapshots()[0].trackedFileBackups['g'];
        const aliases = { [file]: first.trackedFileBackups['f'], f: absent };
        if (endpoint === 'tracked') first.trackedFileBackups = aliases;
        else {
          first.trackedFileBackups = {};
          first.diffAfterBackups = aliases;
        }
        service = await reload(projectDir, [first]);
        const before = service.getSnapshots().map(serializeSnapshot);
        expect(
          Object.keys(
            endpoint === 'tracked'
              ? service.getSnapshots()[0].trackedFileBackups
              : service.getSnapshots()[0].diffAfterBackups!,
          ),
        ).toHaveLength(2);
        await writeFile(file, 'untouched');
        expect((await service.rewind('p1')).filesFailed).toEqual([file]);
        expect(await readFile(file, 'utf8')).toBe('untouched');
        expect(service.getSnapshots().map(serializeSnapshot)).toEqual(before);
        expect((await service.getTurnDiff('p1'))?.files).toEqual([]);
      },
    );

    it('keeps every surviving raw reference during orphan cleanup', async () => {
      const file = await track('f', 'old');
      const p1 = structuredClone(service.getSnapshots()[0]);
      await writeFile(file, 'second');
      await service.makeSnapshot('p2');
      const p2 = structuredClone(service.getSnapshots()[1]);
      await writeFile(file, 'third');
      await service.makeSnapshot('p3');
      const p3 = structuredClone(service.getSnapshots()[2]);
      p1.trackedFileBackups = {
        [file]: p2.trackedFileBackups['f'],
        f: p1.trackedFileBackups['f'],
      };
      p1.diffAfterBackups = { [file]: p3.trackedFileBackups['f'] };
      service = await reload(projectDir, [p1, p2, p3]);
      expect((await service.rewind('p2')).filesFailed).toEqual([]);
      expect(service.getSnapshots()).toHaveLength(2);
      for (const snapshot of [p1, p2, p3])
        for (const backup of Object.values(snapshot.trackedFileBackups))
          expect(existsSync(backupPath(backup.backupFileName!))).toBe(true);
    });

    it.each(['track', 'snapshot', 'stats', 'diff'] as const)(
      'retained %s refuses a failed alias even beside a confirmed alias',
      async (operation) => {
        const createBackup = vi.fn();
        const withBackupFile = vi.fn();
        const retained = new FileHistoryService(
          'retained',
          true,
          projectDir,
          undefined,
          {
            createBackup,
            withBackupFile,
            withWorkingFile: vi.fn(),
          },
        );
        const confirmed = {
          backupFileName: null,
          version: 1,
          backupTime: new Date(),
        };
        retained.restoreFromSnapshots([
          {
            promptId: 'p1',
            cwd: projectDir,
            timestamp: new Date(),
            trackedFileBackups: {
              [at('f')]: { ...confirmed, version: 7, failed: true },
              f: confirmed,
            },
          },
        ]);
        const before = retained.getSnapshots().map(serializeSnapshot);
        const action =
          operation === 'track'
            ? retained.trackEdit(at('f'))
            : operation === 'snapshot'
              ? retained.makeSnapshot('p2')
              : operation === 'stats'
                ? retained.getDiffStats('p1')
                : retained.getTurnDiff('p1');
        await expect(action).rejects.toThrow();
        expect(createBackup).not.toHaveBeenCalled();
        expect(withBackupFile).not.toHaveBeenCalled();
        expect(retained.getSnapshots().map(serializeSnapshot)).toEqual(before);
      },
    );

    it('retained alias lookup authenticates confirmed pointers and deduplicates captures', async () => {
      const createBackup = vi.fn(async (_file: string, version: number) => ({
        backupFileName: null,
        version,
        backupTime: new Date(),
      }));
      const withBackupFile = vi.fn();
      const retained = new FileHistoryService(
        'retained',
        true,
        projectDir,
        undefined,
        {
          createBackup,
          withBackupFile,
          withWorkingFile: vi.fn(),
        },
      );
      const confirmed = {
        backupFileName: 'deadbeefcafebabe@v1',
        version: 1,
        backupTime: new Date(),
      };
      retained.restoreFromSnapshots([
        {
          promptId: 'p1',
          cwd: projectDir,
          timestamp: new Date(),
          trackedFileBackups: { [at('f')]: confirmed, f: confirmed },
        },
      ]);
      await retained.trackEdit(at('f'));
      expect(createBackup).not.toHaveBeenCalled();
      expect(withBackupFile).toHaveBeenCalledExactlyOnceWith(
        confirmed.backupFileName,
        expect.any(Function),
      );
      const nullBaseline = { ...confirmed, backupFileName: null };
      retained.restoreFromSnapshots([
        {
          promptId: 'p1',
          cwd: projectDir,
          timestamp: new Date(),
          trackedFileBackups: { [at('f')]: nullBaseline, f: nullBaseline },
        },
      ]);
      await retained.makeSnapshot('p2');
      expect(createBackup).toHaveBeenCalledExactlyOnceWith(at('f'), 2);
      expect(
        Object.keys(retained.getSnapshots()[1].trackedFileBackups),
      ).toEqual(['f']);
    });

    it('keeps native rewind per-file best effort without truncating on alias conflict', async () => {
      const file = await track('f', 'first');
      await writeFile(at('g'), 'safe baseline');
      await service.trackEdit(at('g'));
      const first = structuredClone(service.getSnapshots()[0]);
      await writeFile(file, 'second');
      await service.makeSnapshot('p2');
      first.trackedFileBackups[file] =
        service.getSnapshots()[1].trackedFileBackups['f'];
      service = await reload(projectDir, [first, service.getSnapshots()[1]]);
      const before = service.getSnapshots().map(serializeSnapshot);
      await writeFile(file, 'untouched conflict');
      await writeFile(at('g'), 'safe changed');
      expect(await service.rewind('p1')).toEqual({
        filesChanged: [at('g')],
        filesFailed: [file],
      });
      expect(await readFile(file, 'utf8')).toBe('untouched conflict');
      expect(await readFile(at('g'), 'utf8')).toBe('safe baseline');
      expect(service.getSnapshots().map(serializeSnapshot)).toEqual(before);
    });

    it('refuses deletion when an existing diff endpoint is disjoint', () => {
      const survivor: FileHistorySnapshot = {
        promptId: 'p1',
        cwd: projectDir,
        timestamp: new Date(),
        trackedFileBackups: {},
        diffAfterBackups: {
          f: { backupFileName: null, version: 1, backupTime: new Date() },
        },
      };
      const deleted = {
        ...survivor,
        promptId: 'p2',
        trackedFileBackups: {
          g: { backupFileName: null, version: 2, backupTime: new Date() },
        },
        diffAfterBackups: undefined,
      };
      const before = JSON.stringify([survivor, deleted]);
      expect(() =>
        removeFileHistorySnapshots([survivor, deleted], new Set(['p2'])),
      ).toThrow(/recovery evidence/);
      expect(JSON.stringify([survivor, deleted])).toBe(before);
    });

    it('starts one capture per execution identity despite raw aliases', async () => {
      const createBackup = vi.fn(async (_file: string, version: number) => ({
        backupFileName: null,
        version,
        backupTime: new Date(),
      }));
      const retained = new FileHistoryService(
        'retained',
        true,
        projectDir,
        undefined,
        {
          createBackup,
          withBackupFile: vi.fn(),
          withWorkingFile: vi.fn(),
        },
      );
      const record = {
        backupFileName: null,
        version: 1,
        backupTime: new Date(),
      };
      retained.restoreFromSnapshots([
        {
          promptId: 'p1',
          cwd: projectDir,
          timestamp: new Date(),
          trackedFileBackups: { [at('f')]: record, f: record },
        },
      ]);
      await retained.makeSnapshot('p2');
      expect(createBackup).toHaveBeenCalledExactlyOnceWith(at('f'), 2);
      expect(
        Object.keys(retained.getSnapshots()[1].trackedFileBackups),
      ).toEqual(['f']);
    });

    it('deduplicates alias candidates before applying the turn diff cap', async () => {
      const backup = {
        backupFileName: null,
        version: 1,
        backupTime: new Date(),
      };
      const entries = Array.from({ length: 300 }, (_, i) => [
        [`f${i}`, backup],
        [at(`f${i}`), backup],
      ]).flat();
      service.restoreFromSnapshots([
        {
          promptId: 'p1',
          cwd: projectDir,
          timestamp: new Date(),
          trackedFileBackups: Object.fromEntries(entries),
        },
      ]);
      expect(await service.getTurnDiff('p1')).toMatchObject({
        files: [],
        stats: { filesChanged: 0, filesOmitted: 0 },
      });
    });

    it('preserves two distinct blobs with equal alias versions', async () => {
      const file = await track('f', 'first');
      const first = structuredClone(service.getSnapshots()[0]);
      await writeFile(file, 'second');
      await service.makeSnapshot('p2');
      const later = {
        ...service.getSnapshots()[1].trackedFileBackups['f'],
        version: 1,
      };
      first.trackedFileBackups = {
        [file]: later,
        f: first.trackedFileBackups['f'],
      };
      service = await reload(projectDir, [first]);
      const before = service.getSnapshots().map(serializeSnapshot);
      await writeFile(file, 'untouched');
      expect(await service.rewind('p1')).toEqual({
        filesChanged: [],
        filesFailed: [file],
      });
      expect(await readFile(file, 'utf8')).toBe('untouched');
      expect(service.getSnapshots().map(serializeSnapshot)).toEqual(before);
      for (const record of Object.values(first.trackedFileBackups))
        expect(
          await readFile(backupPath(record.backupFileName!), 'utf8'),
        ).toMatch(/^(first|second)$/);
    });

    it('reserves diff-after-only failed versions and refuses unavailable fallback', async () => {
      const file = at('f');
      await writeFile(file, 'current');
      service.restoreFromSnapshots([
        {
          promptId: 'p1',
          cwd: projectDir,
          timestamp: new Date(),
          trackedFileBackups: {},
          diffAfterBackups: {
            [file]: {
              backupFileName: null,
              version: 7,
              backupTime: new Date(),
              failed: true,
            },
          },
        },
      ]);
      expect((await service.rewind('p1')).filesFailed).toEqual([file]);
      expect(await readFile(file, 'utf8')).toBe('current');
      expect(service.getSnapshots()).toHaveLength(1);
      await service.makeSnapshot('p2');
      expect(service.getSnapshots()[1].trackedFileBackups['f'].version).toBe(8);
    });

    it('validates every raw reference and keeps native missing-backup healing', async () => {
      const file = await track('f', 'first');
      const snapshot = structuredClone(service.getSnapshots()[0]);
      const good = snapshot.trackedFileBackups['f'];
      snapshot.trackedFileBackups = {
        [file]: good,
        f: { ...good, backupFileName: 'missing@v7', version: 7 },
      };
      service = await reload(projectDir, [snapshot]);
      const aliases = Object.values(
        service.getSnapshots()[0].trackedFileBackups,
      );
      expect(aliases).toHaveLength(2);
      expect(aliases.find((b) => b.version === 7)?.failed).toBe(true);
      await writeFile(file, 'changed');
      expect((await service.rewind('p1', false)).filesFailed).toEqual([]);
      expect(await readFile(file, 'utf8')).toBe('first');
      service.restoreFromSnapshots([
        {
          ...snapshot,
          trackedFileBackups: {
            f: { ...good, backupFileName: 'missing@v7', version: 7 },
          },
        },
      ]);
      await service.validateRestoredSnapshots();
      expect((await service.rewind('p1')).filesFailed).toEqual([file]);
      await writeFile(file, 'healed');
      await service.trackEdit(file);
      expect(service.getSnapshots()[0].trackedFileBackups['f'].version).toBe(8);
      await writeFile(file, 'after healing');
      expect((await service.rewind('p1')).filesFailed).toEqual([]);
      expect(await readFile(file, 'utf8')).toBe('healed');
    });

    it('keeps same-basename version budgets independent across capture roots', async () => {
      await mkdir(at('A'));
      await mkdir(at('B'));
      const a = at('A/f');
      const b = at('B/f');
      await writeFile(a, 'a');
      await writeFile(b, 'b');
      service.restoreFromSnapshots([
        {
          promptId: 'old-a',
          cwd: at('A'),
          timestamp: new Date(),
          trackedFileBackups: {
            f: {
              backupFileName: null,
              version: 7,
              backupTime: new Date(),
              failed: true,
            },
          },
        },
        {
          promptId: 'old-b',
          cwd: at('B'),
          timestamp: new Date(),
          trackedFileBackups: {
            f: {
              backupFileName: null,
              version: 3,
              backupTime: new Date(),
              failed: true,
            },
          },
        },
      ]);
      await service.makeSnapshot('current');
      await service.trackEdit(a);
      await service.trackEdit(b);
      expect(service.getSnapshots()[2].trackedFileBackups['A/f'].version).toBe(
        8,
      );
      expect(service.getSnapshots()[2].trackedFileBackups['B/f'].version).toBe(
        4,
      );
    });

    it.each(['track', 'snapshot', 'stats', 'diff', 'validate'] as const)(
      'retained %s authenticates confirmed aliases and propagates denial',
      async (operation) => {
        const createBackup = vi.fn();
        const withBackupFile = vi.fn(async () => {
          throw new Error('authentication denied');
        });
        const withWorkingFile = vi.fn(async (_path, action) => action(null));
        const retained = new FileHistoryService(
          'retained',
          true,
          projectDir,
          undefined,
          {
            createBackup,
            withBackupFile,
            withWorkingFile,
          },
        );
        const confirmed = {
          backupFileName: 'deadbeefcafebabe@v1',
          version: 1,
          backupTime: new Date(),
        };
        retained.restoreFromSnapshots([
          {
            promptId: 'p1',
            cwd: projectDir,
            timestamp: new Date(),
            trackedFileBackups: { [at('f')]: confirmed, f: confirmed },
          },
        ]);
        const before = retained.getSnapshots().map(serializeSnapshot);
        const action =
          operation === 'track'
            ? retained.trackEdit(at('f'))
            : operation === 'snapshot'
              ? retained.makeSnapshot('p2')
              : operation === 'stats'
                ? retained.getDiffStats('p1')
                : operation === 'diff'
                  ? retained.getTurnDiff('p1')
                  : retained.validateRestoredSnapshots();
        await expect(action).rejects.toThrow();
        expect(withBackupFile).toHaveBeenCalledWith(
          confirmed.backupFileName,
          expect.any(Function),
        );
        expect(createBackup).not.toHaveBeenCalled();
        expect(retained.getSnapshots().map(serializeSnapshot)).toEqual(before);
      },
    );

    it.each([
      ['win32', '/workspace'],
      ['posix', 'C:\\workspace'],
      ['posix', '\\\\host\\share'],
    ] as const)(
      'isolates source grammar through the lifecycle with an explicit %s reader and %s producer',
      async (grammar, foreign) => {
        vi.resetModules();
        vi.doMock('node:path', async (importOriginal) => {
          const actual = await importOriginal<typeof import('node:path')>();
          return {
            ...actual,
            ...actual[grammar],
            resolve: (...args: string[]) =>
              actual[grammar].resolve(
                grammar === 'win32' ? 'C:\\reader' : '/reader',
                ...args,
              ),
          };
        });
        try {
          const { FileHistoryService: Reader } = await import(
            './fileHistoryService.js'
          );
          const fold = await import('../utils/file-history-snapshots.js');
          const local = grammar === 'win32' ? 'C:\\workspace' : '/workspace';
          const empty = (cwd: string): FileHistorySnapshot => ({
            promptId: 'p1',
            cwd,
            timestamp: new Date(),
            trackedFileBackups: {},
          });
          // The deletion-endpoint guard only protects endpoints holding a
          // confirmed capture: give the empty fixture one record so the
          // assertions below keep pinning the fold guard's root-provenance
          // comparison itself (an endpoint with no confirmed capture is
          // deletable across roots — the empty-history control lives in
          // message-group-deletion.test.ts).
          const capturedEmpty = (cwd: string): FileHistorySnapshot => ({
            ...empty(cwd),
            trackedFileBackups: {
              f: {
                backupFileName: 'f@v1',
                version: 1,
                backupTime: new Date(),
              },
            },
          });
          const diagnostic = new Reader('grammar', true, local);
          diagnostic.restoreFromSnapshots([empty(foreign)]);
          expect(diagnostic.getForeignSnapshotCwds()).toEqual([foreign]);
          await expect(diagnostic.rewind('p1')).rejects.toThrow(
            /different working directory/,
          );
          expect(await diagnostic.getDiffStats('p1')).toBeUndefined();
          expect(await diagnostic.getTurnDiff('p1')).toBeUndefined();
          expect(
            fold.deletionDropsRequiredEndpoint(
              capturedEmpty(local),
              capturedEmpty(foreign),
            ),
          ).toBe(true);
          expect(
            fold.deletionDropsRequiredEndpoint(
              capturedEmpty(foreign),
              capturedEmpty(local),
            ),
          ).toBe(true);
          expect(() =>
            fold.removeFileHistorySnapshots(
              [empty(local), { ...capturedEmpty(foreign), promptId: 'p2' }],
              new Set(['p2']),
            ),
          ).toThrow(/capture directory/);
          const createBackup = vi.fn(
            async (_path: string, version: number) => ({
              backupFileName: null,
              version,
              backupTime: new Date(),
            }),
          );
          const retained = new Reader('grammar', true, local, undefined, {
            createBackup,
            withBackupFile: vi.fn(),
            withWorkingFile: vi.fn(),
          });
          const versions = (svc: FileHistoryService, key: string) =>
            [
              ...(
                svc as unknown as {
                  getBackupsForPath(
                    path: string,
                  ): Generator<{ version: number }>;
                }
              ).getBackupsForPath(key),
            ].map((b) => b.version);
          const literal = empty('/workspace');
          literal.trackedFileBackups = {
            'dir\\f': {
              backupFileName: null,
              version: 9,
              backupTime: new Date(),
            },
            'dir/f': {
              backupFileName: null,
              version: 7,
              backupTime: new Date(),
            },
          };
          if (grammar === 'posix') {
            const posixOrigin = new Reader('literal', true, '/workspace');
            posixOrigin.restoreFromSnapshots([literal]);
            expect(versions(posixOrigin, 'dir/f')).toEqual([7]);
            expect(versions(posixOrigin, 'dir\\f')).toEqual([9]);
          } else {
            expect(fold.getCapturePath('/workspace', 'dir/f')).not.toBe(
              fold.getCapturePath('/workspace', 'dir\\f'),
            );
          }
          const aliases = empty(local);
          const record = {
            backupFileName: null,
            version: 3,
            backupTime: new Date(),
          };
          aliases.trackedFileBackups = {
            [local + (grammar === 'win32' ? '\\f' : '/f')]: record,
            f: { ...record, version: 4 },
          };
          diagnostic.restoreFromSnapshots([aliases]);
          expect(
            Object.keys(diagnostic.getSnapshots()[0].trackedFileBackups),
          ).toHaveLength(2);
          expect(versions(diagnostic, 'f').sort()).toEqual([3, 4]);
          const captured = empty(foreign);
          captured.trackedFileBackups['f'] = {
            backupFileName: null,
            version: 7,
            backupTime: new Date(),
          };
          captured.trackedFileBackups[
            grammar === 'win32' ? '/outside/absolute' : 'D:\\outside\\absolute'
          ] = {
            backupFileName: null,
            version: 9,
            backupTime: new Date(),
          };
          const capturedBefore = serializeSnapshot(captured);
          retained.restoreFromSnapshots([captured]);
          expect(versions(retained, 'f')).toEqual([]);
          expect(serializeSnapshot(retained.getSnapshots()[0])).toEqual(
            capturedBefore,
          );
          await retained.trackEdit(
            grammar === 'win32' ? 'C:\\workspace\\f' : '/workspace/f',
          );
          expect(createBackup).not.toHaveBeenCalled();
          await retained.makeSnapshot('local');
          expect(createBackup).not.toHaveBeenCalled();
          await retained.trackEdit(
            grammar === 'win32' ? 'C:\\workspace\\f' : '/workspace/f',
          );
          expect(createBackup).toHaveBeenCalledExactlyOnceWith(
            grammar === 'win32' ? 'C:\\workspace\\f' : '/workspace/f',
            1,
          );
          for (const [left, right, equal] of [
            ['/workspace', '/workspace/', true],
            ['/', '/', true],
            ['C:\\workspace', 'C:\\workspace\\', true],
            ['C:\\', 'C:\\', true],
            ['\\\\host\\share', '\\\\host\\share\\', true],
            ['C:\\workspace', '\\workspace', false],
            ['\\workspace', '\\workspace', false],
            ['\\workspace', '\\workspace\\', false],
            ['C:\\workspace', 'D:\\workspace', false],
            ['\\\\host\\share', '\\\\other\\share', false],
            ['\\\\host\\share', '\\\\host\\other', false],
          ] as const) {
            diagnostic.restoreFromSnapshots([empty(right)]);
            const control = new Reader('control', true, left);
            control.restoreFromSnapshots([empty(right)]);
            const nativeRoot =
              grammar === 'posix'
                ? left.startsWith('/')
                : fold.getSnapshotPathGrammar(left).sep === '\\' &&
                  fold.getSnapshotPathGrammar(left).parse(left).root.length > 1;
            if (nativeRoot)
              expect(control.getForeignSnapshotCwds().length === 0).toBe(equal);
            expect(fold.areSnapshotOriginsEqual(right, left)).toBe(equal);
            expect(
              fold.deletionDropsRequiredEndpoint(
                capturedEmpty(left),
                capturedEmpty(right),
              ),
            ).toBe(!equal);
            expect(
              fold.deletionDropsRequiredEndpoint(
                serializeSnapshot(capturedEmpty(left)),
                serializeSnapshot(capturedEmpty(right)),
              ),
            ).toBe(!equal);
            if (!equal && nativeRoot) {
              const before = control.getSnapshots().map(serializeSnapshot);
              await expect(control.rewind('p1')).rejects.toThrow(
                /different working directory/,
              );
              expect(await control.getDiffStats('p1')).toBeUndefined();
              expect(await control.getTurnDiff('p1')).toBeUndefined();
              expect(control.getSnapshots().map(serializeSnapshot)).toEqual(
                before,
              );
            }
          }
        } finally {
          vi.doUnmock('node:path');
          vi.resetModules();
        }
      },
    );
  });

  // R15 matrix A downstream: the fold decision is judged by what a later
  // rewind reports, not by the folded shape alone (the R14 review's critique
  // of the failed-only test).
  describe('R15 folded endpoint downstream behavior', () => {
    const failedOnly = (key: string) => ({
      [key]: {
        backupFileName: null,
        version: 1,
        failed: true,
        backupTime: '2026-11-17T00:00:00.000Z',
      },
    });
    const serializedP = (
      promptId: string,
      cwd: string | undefined,
      trackedFileBackups: SerializedFileHistorySnapshot['trackedFileBackups'],
    ): SerializedFileHistorySnapshot => ({
      promptId,
      cwd,
      timestamp: '2026-11-17T00:00:00.000Z',
      trackedFileBackups,
    });

    it.each(
      (
        ['empty', 'failed', 'confirmed-local', 'confirmed-foreign'] as const
      ).flatMap((state) =>
        [true, false].map((sameRoot) => ({ state, sameRoot })),
      ),
    )('A-grid $state × sameRoot=$sameRoot', ({ state, sameRoot }) => {
      const confirmed = state.startsWith('confirmed');
      const key = state === 'confirmed-foreign' ? '/B/f' : '/A/f';
      const backups =
        state === 'empty'
          ? {}
          : {
              [key]: {
                backupFileName: null,
                version: 1,
                backupTime: '2026-11-17T00:00:00.000Z',
                ...(state === 'failed' ? { failed: true } : {}),
              },
            };
      const pair = [
        serializedP('p1', '/A', {}),
        serializedP('p2', sameRoot ? '/A' : '/B', backups),
      ];
      // Same matrix against both public representations: runtime Dates
      // and serialized strings cannot change either independent decision.
      const check = <
        T extends FileHistorySnapshot | SerializedFileHistorySnapshot,
      >(
        snapshots: T[],
      ) => {
        expect(deletionDropsRequiredEndpoint(snapshots[0], snapshots[1])).toBe(
          confirmed && !sameRoot,
        );
        if (!sameRoot && state !== 'empty') {
          const before = JSON.stringify(snapshots);
          expect(() =>
            removeFileHistorySnapshots(snapshots, new Set(['p2'])),
          ).toThrow();
          expect(JSON.stringify(snapshots)).toBe(before);
          return;
        }
        const [kept] = removeFileHistorySnapshots(snapshots, new Set(['p2']));
        expect(kept.diffAfterBackups).toEqual(
          sameRoot && state !== 'empty'
            ? snapshots[1].trackedFileBackups
            : undefined,
        );
      };
      check(pair);
      check(deserializeSnapshots(pair));
    });

    it.skipIf(sep === '\\')(
      'A-DS1 never attributes a foreign failed-only endpoint to the survivor root',
      async () => {
        const original = [
          serializedP('p1', '/A', {}),
          serializedP('p2', '/B', failedOnly('f')),
        ];
        const before = JSON.stringify(original);
        expect(() =>
          removeFileHistorySnapshots(original, new Set(['p2'])),
        ).toThrow(/recovery evidence/);
        expect(JSON.stringify(original)).toBe(before);
        // Reservation-only data is retained without assigning it to /A.
        const kept = original;
        const service = new FileHistoryService('r15-ds1', true, '/A');
        service.restoreFromSnapshots(deserializeSnapshots(kept));
        // Keeping foreign provenance must not turn it into local failures.
        await expect(service.rewind('p1', false)).rejects.toThrow(
          /different working directory/,
        );
        // Check the persisted shape only after exercising the consumer.
        expect(kept[0]).not.toHaveProperty('diffAfterBackups');
      },
    );

    it.skipIf(sep === '\\')(
      'A-DS2 keeps reporting a same-root failed fold after reload',
      async () => {
        const kept = removeFileHistorySnapshots(
          [
            serializedP('p1', '/A', {}),
            serializedP('p2', '/A', failedOnly('d.txt')),
          ],
          new Set(['p2']),
        );
        expect(kept[0]?.diffAfterBackups).toEqual(failedOnly('d.txt'));
        const service = new FileHistoryService('r15-ds2', true, '/A');
        service.restoreFromSnapshots(deserializeSnapshots(kept));
        expect(await service.rewind('p1', false)).toEqual({
          filesChanged: [],
          filesFailed: ['/A/d.txt'],
        });
      },
    );
  });

  // R15 matrix B: every Win32 root form must behave identically across
  // track→serialize→hydrate→restore — a recorded capture is never silently
  // dropped from the restoration set after reload, and a form that cannot
  // be restored is refused at record time. The mocked node:path speaks
  // win32 with a fixed reader drive (C:\reader), and node:fs/promises is an
  // in-memory tree that records every unlink the restore performs.
  describe('R15 Win32 root-form lifecycle matrix', () => {
    afterEach(() => {
      vi.doUnmock('node:path');
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    });

    const setup = async () => {
      vi.resetModules();
      const files = new Map<string, string>();
      const unlinkCalls: string[] = [];
      const enoent = (path: string) =>
        Object.assign(new Error(`ENOENT: no such file: ${path}`), {
          code: 'ENOENT',
        });
      vi.doMock('node:path', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:path')>();
        return {
          ...actual,
          ...actual.win32,
          resolve: (...args: string[]) =>
            actual.win32.resolve('C:\\reader', ...args),
        };
      });
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual =
          await importOriginal<typeof import('node:fs/promises')>();
        return {
          ...actual,
          stat: vi.fn(async (path: string) => {
            if (!files.has(path)) throw enoent(path);
            return {
              size: files.get(path)!.length,
              mode: 0o644,
              mtimeMs: 0,
            } as unknown as import('node:fs').Stats;
          }),
          unlink: vi.fn(async (path: string) => {
            unlinkCalls.push(path);
            if (!files.has(path)) throw enoent(path);
            files.delete(path);
          }),
          readFile: vi.fn(async (path: string) => {
            const content = files.get(path);
            if (content === undefined) throw enoent(path);
            return content;
          }),
          writeFile: vi.fn(async (path: string, content: string) => {
            files.set(path, content);
          }),
          mkdir: vi.fn(async () => undefined),
          chmod: vi.fn(async () => undefined),
          copyFile: vi.fn(async () => undefined),
        };
      });
      const { FileHistoryService: Reader } = await import(
        './fileHistoryService.js'
      );
      return { Reader, files, unlinkCalls };
    };

    /**
     * Full lifecycle for a recordable form: track under `cwd`, capture the
     * serialized key spelling, rewind in-session, then reload through
     * serialize→deserialize→restoreFromSnapshots and rewind again. Both
     * rewinds must delete exactly `expectedTargets` (the tracked file is
     * recreated between the two rewinds, as an edit made after the
     * baseline would be).
     */
    const lifecycle = async (options: {
      cwd: string;
      input: string;
      expectedKeys: string[];
      expectedTargets: string[];
    }) => {
      const { Reader, files, unlinkCalls } = await setup();
      const service = new Reader('win-root', true, options.cwd);
      await service.makeSnapshot('p1');
      await service.trackEdit(options.input);
      expect(
        Object.keys(service.getSnapshots().at(-1)!.trackedFileBackups),
      ).toEqual(options.expectedKeys);

      for (const target of options.expectedTargets) files.set(target, 'made');
      const inSession = await service.rewind('p1');
      expect(inSession).toEqual({
        filesChanged: options.expectedTargets,
        filesFailed: [],
      });

      const payload = service.getSnapshots().map(serializeSnapshot);
      const reloaded = new Reader('win-root-2', true, options.cwd);
      reloaded.restoreFromSnapshots(deserializeSnapshots(payload));
      for (const target of options.expectedTargets) files.set(target, 'made');
      const afterHydration = await reloaded.rewind('p1');
      // Chain consistency: the reloaded timeline restores exactly what the
      // live one recorded — never an empty success over a lost capture.
      expect(afterHydration).toEqual(inSession);
      expect(unlinkCalls).toEqual([
        ...options.expectedTargets,
        ...options.expectedTargets,
      ]);
    };

    it('B1 keeps a drive-absolute capture restorable across reload', () =>
      lifecycle({
        cwd: 'C:\\w',
        input: 'C:\\work\\new.txt',
        expectedKeys: ['C:\\work\\new.txt'],
        expectedTargets: ['C:\\work\\new.txt'],
      }));

    // R14 blocking ①: Win32 isAbsolute accepts a rooted path without a
    // drive, trackEdit records it, and collectTrackedFiles used to skip it
    // after reload — an empty success over a real capture. The drive is
    // resolved from the capture cwd, never from the reader.
    it('B2 resolves the drive of a backslash-rooted capture at record time', () =>
      lifecycle({
        cwd: 'C:\\w',
        input: '\\work\\new.txt',
        expectedKeys: ['C:\\work\\new.txt'],
        expectedTargets: ['C:\\work\\new.txt'],
      }));

    it('B5 normalizes a forward-slash drive path into the same identity', () =>
      lifecycle({
        cwd: 'C:\\w',
        input: 'C:/work/new.txt',
        expectedKeys: ['C:\\work\\new.txt'],
        expectedTargets: ['C:\\work\\new.txt'],
      }));

    it('B6 resolves the drive of a forward-slash rooted capture at record time', () =>
      lifecycle({
        cwd: 'C:\\w',
        input: '/work/new.txt',
        expectedKeys: ['C:\\work\\new.txt'],
        expectedTargets: ['C:\\work\\new.txt'],
      }));

    it('B4 keeps a UNC capture restorable across reload', () =>
      lifecycle({
        cwd: 'C:\\w',
        input: '\\\\server\\share\\new.txt',
        expectedKeys: ['\\\\server\\share\\new.txt'],
        expectedTargets: ['\\\\server\\share\\new.txt'],
      }));

    it('B8 keeps a forward-slash UNC capture restorable across reload', () =>
      lifecycle({
        cwd: 'C:\\w',
        input: '//server/share/new.txt',
        expectedKeys: ['\\\\server\\share\\new.txt'],
        expectedTargets: ['\\\\server\\share\\new.txt'],
      }));

    it.each([
      ['B9', '\\work\\new.txt'],
      ['B10', '/work/new.txt'],
    ])(
      '%s qualifies a rooted capture against the capture UNC share',
      (_id, input) =>
        lifecycle({
          cwd: '\\\\server\\share\\w',
          input,
          expectedKeys: ['\\\\server\\share\\work\\new.txt'],
          expectedTargets: ['\\\\server\\share\\work\\new.txt'],
        }),
    );

    it.each([
      ['B11', '\\work\\new.txt'],
      ['B12', '/work/new.txt'],
    ])(
      '%s hydrates an old rooted key using its label, not the reader drive',
      async (_id, key) => {
        const { Reader, files, unlinkCalls } = await setup();
        const target = 'D:\\work\\new.txt';
        files.set(target, 'created later');
        const reloaded = new Reader('old-rooted', true, 'D:\\w');
        const payload = [
          {
            promptId: 'p1',
            cwd: 'D:\\w',
            timestamp: '2026-11-17T00:00:00.000Z',
            trackedFileBackups: {
              [key]: {
                backupFileName: null,
                version: 1,
                backupTime: '2026-11-17T00:00:00.000Z',
              },
            },
          },
        ];
        reloaded.restoreFromSnapshots(
          deserializeSnapshots(JSON.parse(JSON.stringify(payload))),
        );
        expect(await reloaded.rewind('p1')).toEqual({
          filesChanged: [target],
          filesFailed: [],
        });
        expect(unlinkCalls).toEqual([target]);
        expect(files.has(target)).toBe(false);
      },
    );

    it('B13 restores old rooted aliases retained verbatim by hydration exactly once', async () => {
      const { Reader, files, unlinkCalls } = await setup();
      const target = 'D:\\work\\new.txt';
      const backup = {
        backupFileName: null,
        version: 1,
        backupTime: '2026-11-17T00:00:00.000Z',
      };
      const payload = [
        {
          promptId: 'p1',
          cwd: 'D:\\w',
          timestamp: '2026-11-17T00:00:00.000Z',
          trackedFileBackups: {
            '\\work\\new.txt': backup,
            '/work/new.txt': backup,
          },
        },
      ];
      files.set(target, 'created later');
      const reloaded = new Reader('old-rooted-aliases', true, 'D:\\w');
      reloaded.restoreFromSnapshots(
        deserializeSnapshots(JSON.parse(JSON.stringify(payload))),
      );
      expect(
        Object.keys(reloaded.getSnapshots()[0].trackedFileBackups),
      ).toEqual(['\\work\\new.txt', '/work/new.txt']);
      expect(await reloaded.rewind('p1')).toEqual({
        filesChanged: [target],
        filesFailed: [],
      });
      expect(unlinkCalls).toEqual([target]);
      expect(files.has(target)).toBe(false);
    });

    it.each([
      ['//server/share/w', '/work/new.txt', '\\\\server\\share\\work\\new.txt'],
      ['C:/w', '/work/new.txt', 'C:\\work\\new.txt'],
      ['/w', '/work/new.txt', 'C:\\work\\new.txt'],
      ['\\w', 'new.txt', 'C:\\w\\new.txt'],
      ['relative', 'new.txt', 'C:\\reader\\relative\\new.txt'],
    ])('native cwd spelling lifecycle (%s, %s)', async (cwd, input, target) => {
      await lifecycle({
        cwd,
        input,
        expectedKeys: [input === 'new.txt' ? input : target],
        expectedTargets: [target],
      });
    });

    it.each(['\\w', '//server/share/w', '/w'])(
      'refuses historical roots without native producer provenance (%s)',
      async (cwd) => {
        const { Reader, files, unlinkCalls } = await setup();
        const svc = new Reader('historical', true, 'C:\\w');
        const snapshot: FileHistorySnapshot = {
          promptId: 'p1',
          cwd,
          timestamp: new Date(),
          trackedFileBackups: {
            'new.txt': {
              backupFileName: null,
              version: 1,
              backupTime: new Date(),
            },
          },
        };
        const payload = serializeSnapshot(snapshot);
        svc.restoreFromSnapshots(deserializeSnapshots([payload]));
        files.set('C:\\w\\new.txt', 'EDITED');
        expect(svc.getSnapshots().map(serializeSnapshot)).toEqual([payload]);
        expect(svc.getForeignSnapshotCwds()).toEqual([cwd]);
        await expect(svc.rewind('p1')).rejects.toThrow(
          'different working directory',
        );
        expect(unlinkCalls).toEqual([]);
        expect(files.get('C:\\w\\new.txt')).toBe('EDITED');
      },
    );

    it('B7 anchors a native drive-less cwd before recording a relative capture', () =>
      lifecycle({
        cwd: '\\w',
        input: 'new.txt',
        expectedKeys: ['new.txt'],
        expectedTargets: ['C:\\w\\new.txt'],
      }));

    it('B3 anchors a native drive-less cwd before qualifying a rooted capture', () =>
      lifecycle({
        cwd: '\\w',
        input: '\\work\\new.txt',
        expectedKeys: ['C:\\work\\new.txt'],
        expectedTargets: ['C:\\work\\new.txt'],
      }));
  });

  // A separator-only POSIX cwd ('//', '///') spells its root class. The
  // full cross matrix of root-only cwds × leading-slash inputs must keep
  // the caller's coordinate: the persisted key, the capture-side stat and
  // the rewind-side unlink may never cross into another root class.
  describe.skipIf(sep === '\\')('R17 POSIX root-class cwd matrix', () => {
    afterEach(() => {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    });

    const setup = async () => {
      vi.resetModules();
      const files = new Map<string, string>();
      const statCalls: string[] = [];
      const unlinkCalls: string[] = [];
      const enoent = (path: string) =>
        Object.assign(new Error(`ENOENT: no such file: ${path}`), {
          code: 'ENOENT',
        });
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual =
          await importOriginal<typeof import('node:fs/promises')>();
        return {
          ...actual,
          stat: vi.fn(async (path: string) => {
            statCalls.push(path);
            if (!files.has(path)) throw enoent(path);
            return {
              size: files.get(path)!.length,
              mode: 0o644,
              mtimeMs: 0,
            } as unknown as import('node:fs').Stats;
          }),
          unlink: vi.fn(async (path: string) => {
            unlinkCalls.push(path);
            if (!files.has(path)) throw enoent(path);
            files.delete(path);
          }),
          readFile: vi.fn(async (path: string) => {
            const content = files.get(path);
            if (content === undefined) throw enoent(path);
            return content;
          }),
          writeFile: vi.fn(async (path: string, content: string) => {
            files.set(path, content);
          }),
          mkdir: vi.fn(async () => undefined),
          chmod: vi.fn(async () => undefined),
          copyFile: vi.fn(async () => undefined),
        };
      });
      const { FileHistoryService: Reader } = await import(
        './fileHistoryService.js'
      );
      return { Reader, files, statCalls, unlinkCalls };
    };

    /**
     * Full lifecycle under a root-only cwd: record with the target absent
     * (a confirmed-null baseline), assert the persisted key spelling and
     * that the capture stat dispatched against the caller's input
     * coordinate, then rewind in-session and again after
     * serialize→deserialize→restoreFromSnapshots. Both rewinds must
     * delete exactly the original coordinate.
     */
    const lifecycle = async (options: {
      cwd: string;
      input: string;
      expectedKeys: string[];
      expectedTargets: string[];
    }) => {
      const { Reader, files, statCalls, unlinkCalls } = await setup();
      const service = new Reader('posix-root', true, options.cwd);
      await service.makeSnapshot('p1');
      await service.trackEdit(options.input);
      expect(
        Object.keys(service.getSnapshots().at(-1)!.trackedFileBackups),
      ).toEqual(options.expectedKeys);
      expect(statCalls).toEqual(options.expectedTargets);

      for (const target of options.expectedTargets) files.set(target, 'made');
      const inSession = await service.rewind('p1');
      expect(inSession).toEqual({
        filesChanged: options.expectedTargets,
        filesFailed: [],
      });

      const payload = service.getSnapshots().map(serializeSnapshot);
      const reloaded = new Reader('posix-root-2', true, options.cwd);
      reloaded.restoreFromSnapshots(deserializeSnapshots(payload));
      for (const target of options.expectedTargets) files.set(target, 'made');
      const afterHydration = await reloaded.rewind('p1');
      expect(afterHydration).toEqual(inSession);
      expect(unlinkCalls).toEqual([
        ...options.expectedTargets,
        ...options.expectedTargets,
      ]);
    };

    it.each([
      ['/', '/w/f', 'w/f', '/w/f'],
      ['/', '//w/f', '//w/f', '//w/f'],
      ['/', '///w/f', '///w/f', '///w/f'],
      ['//', '/w/f', '/w/f', '/w/f'],
      ['//', '//w/f', 'w/f', '//w/f'],
      ['//', '///w/f', '///w/f', '///w/f'],
      ['///', '/w/f', '/w/f', '/w/f'],
      ['///', '//w/f', '//w/f', '//w/f'],
      ['///', '///w/f', 'w/f', '///w/f'],
    ])(
      'keeps the %s-root cwd coordinate of %s across capture and rewind',
      (cwd, input, key, target) =>
        lifecycle({
          cwd,
          input,
          expectedKeys: [key],
          expectedTargets: [target],
        }),
    );
  });

  // Drive-relative keys ('C:f') name another directory this service never
  // captured, and extended namespaces ('\\?\', '\\.\') have qualification
  // rules the lexical drive/share join does not reproduce (a rooted key
  // under '\\?\UNC\host\share' loses its host/share). Both must be refused
  // at record time instead of accepted with a shifted coordinate, and
  // crafted/legacy spellings must stay unexecuted after reload.
  describe('R17 unsupported Win32 capture forms', () => {
    afterEach(() => {
      vi.doUnmock('node:path');
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    });

    const setup = async () => {
      vi.resetModules();
      const files = new Map<string, string>();
      const statCalls: string[] = [];
      const unlinkCalls: string[] = [];
      const enoent = (path: string) =>
        Object.assign(new Error(`ENOENT: no such file: ${path}`), {
          code: 'ENOENT',
        });
      vi.doMock('node:path', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:path')>();
        return {
          ...actual,
          ...actual.win32,
          resolve: (...args: string[]) =>
            actual.win32.resolve('C:\\reader', ...args),
        };
      });
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual =
          await importOriginal<typeof import('node:fs/promises')>();
        return {
          ...actual,
          stat: vi.fn(async (path: string) => {
            statCalls.push(path);
            if (!files.has(path)) throw enoent(path);
            return {
              size: files.get(path)!.length,
              mode: 0o644,
              mtimeMs: 0,
            } as unknown as import('node:fs').Stats;
          }),
          unlink: vi.fn(async (path: string) => {
            unlinkCalls.push(path);
            if (!files.has(path)) throw enoent(path);
            files.delete(path);
          }),
          readFile: vi.fn(async (path: string) => {
            const content = files.get(path);
            if (content === undefined) throw enoent(path);
            return content;
          }),
          writeFile: vi.fn(async (path: string, content: string) => {
            files.set(path, content);
          }),
          mkdir: vi.fn(async () => undefined),
          chmod: vi.fn(async () => undefined),
          copyFile: vi.fn(async () => undefined),
        };
      });
      const { FileHistoryService: Reader } = await import(
        './fileHistoryService.js'
      );
      return { Reader, files, statCalls, unlinkCalls };
    };

    it.each(['C:f', 'c:notes.txt', 'D:x\\y'])(
      'refuses a drive-relative capture before any dispatch (%s)',
      async (input) => {
        const { Reader, files, statCalls, unlinkCalls } = await setup();
        const service = new Reader('drive-relative', true, 'C:\\w');
        await service.makeSnapshot('p1');
        await service.trackEdit(input);
        expect(
          Object.keys(service.getSnapshots().at(-1)!.trackedFileBackups),
        ).toEqual([]);
        expect(statCalls).toEqual([]);

        const misexpanded = 'C:\\w\\' + input;
        files.set(misexpanded, 'sentinel');
        expect(await service.rewind('p1')).toEqual({
          filesChanged: [],
          filesFailed: [],
        });
        expect(unlinkCalls).toEqual([]);
        expect(files.get(misexpanded)).toBe('sentinel');
      },
    );

    it.each(['\\new.txt', 'new.txt'])(
      'refuses captures under an extended-UNC namespace cwd (%s)',
      async (input) => {
        const { Reader, files, statCalls } = await setup();
        const service = new Reader(
          'namespace-cwd',
          true,
          '\\\\?\\UNC\\host\\share\\w',
        );
        await service.makeSnapshot('p1');
        await service.trackEdit(input);
        // R21 constructor boundary: a refused construction root records
        // NOTHING — trackEdit refuses per capture and makeSnapshot no
        // longer mints even an empty ordinary snapshot. With no
        // checkpoint there is no rewind surface; execution under a
        // refused capture root stays covered by the R20 preview/restore
        // cells that reload labeled snapshots directly.
        expect(service.getSnapshots()).toEqual([]);
        expect(statCalls).toEqual([]);

        files.set('\\\\?\\UNC\\new.txt', 'sentinel');
        files.set('\\\\?\\UNC\\host\\share\\w\\new.txt', 'sentinel');
        expect(files.get('\\\\?\\UNC\\new.txt')).toBe('sentinel');
        expect(files.get('\\\\?\\UNC\\host\\share\\w\\new.txt')).toBe(
          'sentinel',
        );
      },
    );

    it.each(['\\\\?\\C:\\secret\\new.txt', '\\\\.\\Device\\Qwen0'])(
      'refuses a namespace-spelled capture input (%s)',
      async (input) => {
        const { Reader, files, statCalls, unlinkCalls } = await setup();
        const service = new Reader('namespace-input', true, 'C:\\w');
        await service.makeSnapshot('p1');
        await service.trackEdit(input);
        expect(
          Object.keys(service.getSnapshots().at(-1)!.trackedFileBackups),
        ).toEqual([]);
        expect(statCalls).toEqual([]);

        files.set(input, 'sentinel');
        expect(await service.rewind('p1')).toEqual({
          filesChanged: [],
          filesFailed: [],
        });
        expect(unlinkCalls).toEqual([]);
        expect(files.get(input)).toBe('sentinel');
      },
    );

    it.each([
      ['C:\\w', 'C:\\w\\new.txt', 'new.txt', 'C:\\w\\new.txt'],
      [
        '\\\\server\\share\\w',
        '\\new.txt',
        '\\\\server\\share\\new.txt',
        '\\\\server\\share\\new.txt',
      ],
    ])(
      'keeps ordinary drive and UNC captures accepted (%s, %s)',
      async (cwd, input, key, target) => {
        const { Reader, files, statCalls, unlinkCalls } = await setup();
        const service = new Reader('ordinary', true, cwd);
        await service.makeSnapshot('p1');
        await service.trackEdit(input);
        expect(
          Object.keys(service.getSnapshots().at(-1)!.trackedFileBackups),
        ).toEqual([key]);
        expect(statCalls[0]).toBe(target);

        files.set(target, 'made');
        expect(await service.rewind('p1')).toEqual({
          filesChanged: [target],
          filesFailed: [],
        });
        expect(unlinkCalls).toEqual([target]);
      },
    );

    it.each([
      ['C:\\w', 'C:f', 'C:\\w\\C:f'],
      [
        '\\\\?\\UNC\\host\\share\\w',
        'new.txt',
        '\\\\?\\UNC\\host\\share\\w\\new.txt',
      ],
    ])(
      'keeps a crafted key in the %s cwd (%s) unexecuted after reload',
      async (cwd, key, misexpandedTarget) => {
        const { Reader, files, unlinkCalls } = await setup();
        files.set(misexpandedTarget, 'sentinel');
        const reloaded = new Reader('crafted', true, cwd);
        const payload = [
          {
            promptId: 'p1',
            cwd,
            timestamp: '2026-11-17T00:00:00.000Z',
            trackedFileBackups: {
              [key]: {
                backupFileName: null,
                version: 1,
                backupTime: '2026-11-17T00:00:00.000Z',
              },
            },
          },
        ];
        reloaded.restoreFromSnapshots(
          deserializeSnapshots(JSON.parse(JSON.stringify(payload))),
        );
        expect(await reloaded.rewind('p1')).toEqual({
          filesChanged: [],
          filesFailed: [],
        });
        expect(unlinkCalls).toEqual([]);
        expect(files.get(misexpandedTarget)).toBe('sentinel');
      },
    );
  });

  // R18: the admission boundary classifies the CALLER'S ORIGINAL input,
  // never a coordinate that shortening or qualification manufactured.
  // `path.win32.relative(cwd, 'C:\\w\\C:f')` produces exactly the bare
  // `C:f` key the direct drive-relative spelling is refused for, while
  // `normalize('.\\C:f')` keeps the explicit-relative spelling verbatim —
  // classifying after the transform refuses one spelling of a coordinate
  // and accepts its twin. The same rule holds for namespaces:
  // normalizing `\\.\foo\..` or `\\?\UNC\..` erases the prefix into an
  // ordinary drive root, and a historical `\\?/UNC/...` label (mixed
  // separators) normalizes into the namespace only after the raw-prefix
  // check has passed. Every refusal below must observe zero I/O, and
  // every accepted positive control must keep its execution coordinate.
  describe('R18 admission classifies the original Win32 input', () => {
    afterEach(() => {
      vi.doUnmock('node:path');
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    });

    const setup = async () => {
      vi.resetModules();
      const files = new Map<string, string>();
      const statCalls: string[] = [];
      const unlinkCalls: string[] = [];
      const enoent = (path: string) =>
        Object.assign(new Error(`ENOENT: no such file: ${path}`), {
          code: 'ENOENT',
        });
      vi.doMock('node:path', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:path')>();
        return {
          ...actual,
          ...actual.win32,
          resolve: (...args: string[]) =>
            actual.win32.resolve('C:\\reader', ...args),
        };
      });
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual =
          await importOriginal<typeof import('node:fs/promises')>();
        return {
          ...actual,
          stat: vi.fn(async (path: string) => {
            statCalls.push(path);
            if (!files.has(path)) throw enoent(path);
            return {
              size: files.get(path)!.length,
              mode: 0o644,
              mtimeMs: 0,
            } as unknown as import('node:fs').Stats;
          }),
          unlink: vi.fn(async (path: string) => {
            unlinkCalls.push(path);
            if (!files.has(path)) throw enoent(path);
            files.delete(path);
          }),
          readFile: vi.fn(async (path: string) => {
            const content = files.get(path);
            if (content === undefined) throw enoent(path);
            return content;
          }),
          writeFile: vi.fn(async (path: string, content: string) => {
            files.set(path, content);
          }),
          mkdir: vi.fn(async () => undefined),
          chmod: vi.fn(async () => undefined),
          copyFile: vi.fn(async () => undefined),
        };
      });
      const { FileHistoryService: Reader } = await import(
        './fileHistoryService.js'
      );
      return { Reader, files, statCalls, unlinkCalls };
    };

    const nullBackup = {
      backupFileName: null,
      version: 1,
      backupTime: '2026-11-17T00:00:00.000Z',
    };

    // ① The fully-qualified `C:\w\C:f` and the explicit-relative `.\C:f`
    // name the same drive-relative coordinate; both spellings must be
    // refused on the original input, before shortening manufactures (or
    // preserves) the bare `C:f` key.
    it.each([
      ['fully-qualified', 'C:\\w\\C:f'],
      ['explicit-relative', '.\\C:f'],
    ])(
      'refuses the %s drive-relative spelling before any transformation (%s)',
      async (_spelling, input) => {
        const { Reader, files, statCalls, unlinkCalls } = await setup();
        const service = new Reader('r18-drive-record', true, 'C:\\w');
        await service.makeSnapshot('p1');
        await service.trackEdit(input);
        expect(
          Object.keys(service.getSnapshots().at(-1)!.trackedFileBackups),
        ).toEqual([]);
        expect(statCalls).toEqual([]);

        files.set('C:\\w\\C:f', 'sentinel');
        expect(await service.rewind('p1')).toEqual({
          filesChanged: [],
          filesFailed: [],
        });
        expect(unlinkCalls).toEqual([]);
        expect(files.get('C:\\w\\C:f')).toBe('sentinel');
      },
    );

    // ① Hydration must treat every spelling of the refused coordinate
    // identically (all unexecuted) and must not silently drop the
    // ordinary capture recorded beside them.
    it('keeps every crafted drive-relative spelling unexecuted and restores the positive control after reload', async () => {
      const { Reader, files, unlinkCalls } = await setup();
      files.set('C:\\w\\new.txt', 'made');
      files.set('C:\\w\\C:f', 'sentinel');
      const reloaded = new Reader('r18-drive-hydrate', true, 'C:\\w');
      const payload = [
        {
          promptId: 'p1',
          cwd: 'C:\\w',
          timestamp: '2026-11-17T00:00:00.000Z',
          trackedFileBackups: {
            'C:\\w\\C:f': nullBackup,
            '.\\C:f': nullBackup,
            'C:f': nullBackup,
            'new.txt': nullBackup,
          },
        },
      ];
      reloaded.restoreFromSnapshots(
        deserializeSnapshots(JSON.parse(JSON.stringify(payload))),
      );
      expect(await reloaded.rewind('p1')).toEqual({
        filesChanged: ['C:\\w\\new.txt'],
        filesFailed: [],
      });
      expect(unlinkCalls).toEqual(['C:\\w\\new.txt']);
      expect(files.get('C:\\w\\C:f')).toBe('sentinel');
    });

    // ② Dot-segment ablation must not launder a namespace prefix into an
    // ordinary drive root: the refusal runs on the original input, before
    // normalization can erase the prefix.
    it.each([
      ['\\\\.\\foo\\..', 'C:\\'],
      ['\\\\?\\UNC\\..', 'C:\\?'],
    ])(
      'refuses the namespace input before normalization ablates its prefix (%s)',
      async (input, ablatedTarget) => {
        const { Reader, files, statCalls, unlinkCalls } = await setup();
        const service = new Reader('r18-ns-ablate', true, 'C:\\w');
        await service.makeSnapshot('p1');
        await service.trackEdit(input);
        expect(
          Object.keys(service.getSnapshots().at(-1)!.trackedFileBackups),
        ).toEqual([]);
        expect(statCalls).toEqual([]);

        files.set(ablatedTarget, 'sentinel');
        expect(await service.rewind('p1')).toEqual({
          filesChanged: [],
          filesFailed: [],
        });
        expect(unlinkCalls).toEqual([]);
        expect(files.get(ablatedTarget)).toBe('sentinel');
      },
    );

    // ② A historical namespace label may mix separators; the canonical
    // backslash-only spelling is already skipped, and the mixed spelling
    // normalizes into the same namespace — both must stay unexecuted.
    it.each([
      ['canonical', '\\\\?\\UNC\\host\\share\\w'],
      ['mixed-separator', '\\\\?/UNC/host/share/w'],
    ])(
      'keeps a %s namespace label unexecuted after reload',
      async (_spelling, label) => {
        const { Reader, files, unlinkCalls } = await setup();
        const target = '\\\\?\\UNC\\host\\share\\w\\f';
        files.set(target, 'sentinel');
        const reloaded = new Reader(
          'r18-ns-label',
          true,
          '\\\\?\\UNC\\host\\share\\w',
        );
        const payload = [
          {
            promptId: 'p1',
            cwd: label,
            timestamp: '2026-11-17T00:00:00.000Z',
            trackedFileBackups: {
              f: nullBackup,
            },
          },
        ];
        reloaded.restoreFromSnapshots(
          deserializeSnapshots(JSON.parse(JSON.stringify(payload))),
        );
        expect(await reloaded.rewind('p1')).toEqual({
          filesChanged: [],
          filesFailed: [],
        });
        expect(unlinkCalls).toEqual([]);
        expect(files.get(target)).toBe('sentinel');
      },
    );

    // ② Crafted namespace KEYS (either separator) stay unexecuted while
    // the ordinary capture in the same snapshot still restores.
    it('keeps crafted namespace keys unexecuted and restores the positive control after reload', async () => {
      const { Reader, files, unlinkCalls } = await setup();
      files.set('C:\\w\\new.txt', 'made');
      files.set('\\\\?\\UNC\\host\\share\\w\\f', 'sentinel');
      files.set('\\\\?\\UNC\\host\\alt\\g', 'sentinel');
      const reloaded = new Reader('r18-ns-key', true, 'C:\\w');
      const payload = [
        {
          promptId: 'p1',
          cwd: 'C:\\w',
          timestamp: '2026-11-17T00:00:00.000Z',
          trackedFileBackups: {
            'new.txt': nullBackup,
            '\\\\?\\UNC\\host\\share\\w\\f': nullBackup,
            '\\\\?/UNC/host/alt/g': nullBackup,
          },
        },
      ];
      reloaded.restoreFromSnapshots(
        deserializeSnapshots(JSON.parse(JSON.stringify(payload))),
      );
      expect(await reloaded.rewind('p1')).toEqual({
        filesChanged: ['C:\\w\\new.txt'],
        filesFailed: [],
      });
      expect(unlinkCalls).toEqual(['C:\\w\\new.txt']);
      expect(files.get('\\\\?\\UNC\\host\\share\\w\\f')).toBe('sentinel');
      expect(files.get('\\\\?\\UNC\\host\\alt\\g')).toBe('sentinel');
    });

    // ② A namespace input may not dodge the refusal by spelling the
    // prefix separators forward: normalize folds them into the namespace
    // form, so the raw classification refuses both spellings.
    it.each(['\\\\?\\C:\\secret\\new.txt', '\\\\?/C:/secret/new.txt'])(
      'refuses a namespace input in either separator spelling (%s)',
      async (input) => {
        const { Reader, files, statCalls, unlinkCalls } = await setup();
        const service = new Reader('r18-ns-mixed-input', true, 'C:\\w');
        await service.makeSnapshot('p1');
        await service.trackEdit(input);
        expect(
          Object.keys(service.getSnapshots().at(-1)!.trackedFileBackups),
        ).toEqual([]);
        expect(statCalls).toEqual([]);

        files.set(input, 'sentinel');
        expect(await service.rewind('p1')).toEqual({
          filesChanged: [],
          filesFailed: [],
        });
        expect(unlinkCalls).toEqual([]);
        expect(files.get(input)).toBe('sentinel');
      },
    );
  });

  describe('R19 admission aligns the remaining call sites', () => {
    afterEach(() => {
      vi.doUnmock('node:path');
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    });

    const setup = async () => {
      vi.resetModules();
      const files = new Map<string, string>();
      const statCalls: string[] = [];
      const unlinkCalls: string[] = [];
      const openCalls: string[] = [];
      const enoent = (path: string) =>
        Object.assign(new Error(`ENOENT: no such file: ${path}`), {
          code: 'ENOENT',
        });
      vi.doMock('node:path', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:path')>();
        return {
          ...actual,
          ...actual.win32,
          resolve: (...args: string[]) =>
            actual.win32.resolve('C:\\reader', ...args),
        };
      });
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual =
          await importOriginal<typeof import('node:fs/promises')>();
        return {
          ...actual,
          open: vi.fn(async (path: string) => {
            openCalls.push(path);
            const content = files.get(path);
            if (content === undefined) throw enoent(path);
            return {
              stat: async () =>
                ({
                  size: content.length,
                }) as import('node:fs').Stats,
              readFile: async () => content,
              close: async () => undefined,
            } as unknown as import('node:fs/promises').FileHandle;
          }),
          stat: vi.fn(async (path: string) => {
            statCalls.push(path);
            if (!files.has(path)) throw enoent(path);
            return {
              size: files.get(path)!.length,
              mode: 0o644,
              mtimeMs: 0,
            } as unknown as import('node:fs').Stats;
          }),
          unlink: vi.fn(async (path: string) => {
            unlinkCalls.push(path);
            if (!files.has(path)) throw enoent(path);
            files.delete(path);
          }),
          readFile: vi.fn(async (path: string) => {
            const content = files.get(path);
            if (content === undefined) throw enoent(path);
            return content;
          }),
          writeFile: vi.fn(async (path: string, content: string) => {
            files.set(path, content);
          }),
          mkdir: vi.fn(async () => undefined),
          chmod: vi.fn(async () => undefined),
          copyFile: vi.fn(async () => undefined),
        };
      });
      const { FileHistoryService: Reader } = await import(
        './fileHistoryService.js'
      );
      return { Reader, files, statCalls, unlinkCalls, openCalls };
    };

    const nullBackup = {
      backupFileName: null,
      version: 1,
      backupTime: '2026-11-17T00:00:00.000Z',
    };

    // ① Hydration singleton branch: the ONLY hydration branch that replaces
    // a recorded key with a shorter one must classify the raw spelling
    // first. `normalize` cancels `C:f\..`, so `.\\C:f\\..\\victim` and its
    // fully-qualified twin shorten to `victim` — an ordinary-looking key
    // for a coordinate the record-time admission refuses — and rewind then
    // dispatches unlink('C:\\w\\victim') with no failure. The R18 colon
    // test put several aliases in one identity group (raw keys preserved);
    // these singleton cells exercise the branch that actually shortens.
    it.each([
      ['explicit-relative', '.\\C:f\\..\\victim'],
      ['fully-qualified', 'C:\\w\\C:f\\..\\victim'],
    ])(
      'keeps the %s singleton drive-relative key unexecuted after reload and restores the positive control (%s)',
      async (_spelling, key) => {
        const { Reader, files, unlinkCalls } = await setup();
        files.set('C:\\w\\victim', 'sentinel');
        files.set('C:\\w\\new.txt', 'made');
        const reloaded = new Reader('r19-singleton-drive', true, 'C:\\w');
        const payload = [
          {
            promptId: 'p1',
            cwd: 'C:\\w',
            timestamp: '2026-11-17T00:00:00.000Z',
            trackedFileBackups: {
              [key]: nullBackup,
              'new.txt': nullBackup,
            },
          },
        ];
        reloaded.restoreFromSnapshots(
          deserializeSnapshots(JSON.parse(JSON.stringify(payload))),
        );
        expect(await reloaded.rewind('p1')).toEqual({
          filesChanged: ['C:\\w\\new.txt'],
          filesFailed: [],
        });
        expect(unlinkCalls).toEqual(['C:\\w\\new.txt']);
        expect(files.get('C:\\w\\victim')).toBe('sentinel');
      },
    );

    // ① Same branch, namespace axis: `normalize('\\\\.\\foo\\..')` ablates
    // the prefix, the shortened key reaches the drive root, and rewind
    // dispatches unlink at it. The raw spelling must stay for the key
    // predicates to refuse.
    it('keeps a namespace singleton key unexecuted after reload and restores the positive control', async () => {
      const { Reader, files, unlinkCalls } = await setup();
      files.set('C:\\', 'root-sentinel');
      files.set('C:\\w\\new.txt', 'made');
      const reloaded = new Reader('r19-singleton-ns', true, 'C:\\w');
      const payload = [
        {
          promptId: 'p1',
          cwd: 'C:\\w',
          timestamp: '2026-11-17T00:00:00.000Z',
          trackedFileBackups: {
            '\\\\.\\foo\\..': nullBackup,
            'new.txt': nullBackup,
          },
        },
      ];
      reloaded.restoreFromSnapshots(
        deserializeSnapshots(JSON.parse(JSON.stringify(payload))),
      );
      expect(await reloaded.rewind('p1')).toEqual({
        filesChanged: ['C:\\w\\new.txt'],
        filesFailed: [],
      });
      expect(unlinkCalls).toEqual(['C:\\w\\new.txt']);
      expect(files.get('C:\\')).toBe('root-sentinel');
    });

    // ① Same singleton branch through the diffAfterBackups map: both maps
    // hydrate through the same function, and the refused spelling must not
    // execute from either.
    it('keeps the diff-after singleton drive-relative key unexecuted after reload', async () => {
      const { Reader, files, unlinkCalls } = await setup();
      files.set('C:\\w\\victim', 'sentinel');
      files.set('C:\\w\\new.txt', 'made');
      const reloaded = new Reader('r19-singleton-diff', true, 'C:\\w');
      const payload = [
        {
          promptId: 'p1',
          cwd: 'C:\\w',
          timestamp: '2026-11-17T00:00:00.000Z',
          trackedFileBackups: { 'new.txt': nullBackup },
          diffAfterBackups: { '.\\C:f\\..\\victim': nullBackup },
        },
      ];
      reloaded.restoreFromSnapshots(
        deserializeSnapshots(JSON.parse(JSON.stringify(payload))),
      );
      expect(await reloaded.rewind('p1')).toEqual({
        filesChanged: ['C:\\w\\new.txt'],
        filesFailed: [],
      });
      expect(unlinkCalls).toEqual(['C:\\w\\new.txt']);
      expect(files.get('C:\\w\\victim')).toBe('sentinel');
    });

    // ② Read path: getTurnDiff feeds raw snapshot backup keys straight to
    // getExecutionPaths, which historically applied no admission. `.\\C:f`
    // is excluded from rewind yet was opened as `C:\\w\\C:f`; a
    // mixed-separator namespace key was opened as its backslash form. The
    // same predicates must gate the read path, and the ordinary capture
    // must still produce its diff row.
    it.each([
      ['drive-relative', '.\\C:f', 'C:\\w\\C:f'],
      [
        'mixed-separator namespace',
        '\\\\?/UNC/host/share/f',
        '\\\\?\\UNC\\host\\share\\f',
      ],
    ])(
      'does not open the %s spelling from snapshot keys in getTurnDiff (%s)',
      async (_kind, key, openedTarget) => {
        const { Reader, files, openCalls } = await setup();
        files.set(openedTarget, 'crafted\n');
        files.set('C:\\w\\new.txt', 'after\n');
        const reloaded = new Reader('r19-turndiff', true, 'C:\\w');
        const payload = [
          {
            promptId: 'p1',
            cwd: 'C:\\w',
            timestamp: '2026-11-17T00:00:00.000Z',
            trackedFileBackups: {
              [key]: nullBackup,
              'new.txt': nullBackup,
            },
          },
        ];
        reloaded.restoreFromSnapshots(
          deserializeSnapshots(JSON.parse(JSON.stringify(payload))),
        );
        const diff = await reloaded.getTurnDiff('p1');
        expect(diff?.files.map((f) => f.filePath)).toEqual(['new.txt']);
        expect(openCalls).toEqual(['C:\\w\\new.txt']);
        expect(files.get(openedTarget)).toBe('crafted\n');
      },
    );

    // ③ Constructor: win32 resolve() erases incomplete namespace prefixes
    // (`\\\\.` → `C:\\`, `\\\\?` → `C:\\?`), so the namespace admission for
    // the capture root must observe the ORIGINAL spelling before the
    // assignment bakes the erased form in. Recording against the
    // transformed ordinary path would capture a coordinate the caller
    // never named.
    it.each(['\\\\.', '\\\\?'])(
      'refuses every capture when the cwd is the incomplete namespace spelling %s',
      async (cwdInput) => {
        const { Reader, statCalls } = await setup();
        const service = new Reader('r19-cwd-ns', true, cwdInput);
        await service.makeSnapshot('p1');
        await service.trackEdit('victim');
        // R21 constructor boundary: records NOTHING — no empty ordinary
        // snapshot labeled with the erased form either.
        expect(service.getSnapshots()).toEqual([]);
        expect(statCalls).toEqual([]);
      },
    );

    // ③ Positive control: an ordinary cwd still records through the same
    // constructor path (no over-broad refusal).
    it('still records against an ordinary cwd (positive control)', async () => {
      const { Reader, statCalls } = await setup();
      const service = new Reader('r19-cwd-control', true, 'C:\\w');
      await service.makeSnapshot('p1');
      await service.trackEdit('new.txt');
      expect(
        Object.keys(service.getSnapshots().at(-1)!.trackedFileBackups),
      ).toEqual(['new.txt']);
      expect(statCalls).toEqual(['C:\\w\\new.txt']);
    });
  });

  describe('R20 unified raw-coordinate admission', () => {
    afterEach(() => {
      vi.doUnmock('node:path');
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    });

    const setup = async () => {
      vi.resetModules();
      const files = new Map<string, string>();
      const statCalls: string[] = [];
      const unlinkCalls: string[] = [];
      const openCalls: string[] = [];
      const enoent = (path: string) =>
        Object.assign(new Error(`ENOENT: no such file: ${path}`), {
          code: 'ENOENT',
        });
      vi.doMock('node:path', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:path')>();
        return {
          ...actual,
          ...actual.win32,
          resolve: (...args: string[]) =>
            actual.win32.resolve('C:\\reader', ...args),
        };
      });
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual =
          await importOriginal<typeof import('node:fs/promises')>();
        return {
          ...actual,
          open: vi.fn(async (path: string) => {
            openCalls.push(path);
            const content = files.get(path);
            if (content === undefined) throw enoent(path);
            return {
              stat: async () =>
                ({
                  size: content.length,
                }) as import('node:fs').Stats,
              readFile: async () => content,
              close: async () => undefined,
            } as unknown as import('node:fs/promises').FileHandle;
          }),
          stat: vi.fn(async (path: string) => {
            statCalls.push(path);
            if (!files.has(path)) throw enoent(path);
            return {
              size: files.get(path)!.length,
              mode: 0o644,
              mtimeMs: 0,
            } as unknown as import('node:fs').Stats;
          }),
          unlink: vi.fn(async (path: string) => {
            unlinkCalls.push(path);
            if (!files.has(path)) throw enoent(path);
            files.delete(path);
          }),
          readFile: vi.fn(async (path: string) => {
            const content = files.get(path);
            if (content === undefined) throw enoent(path);
            return content;
          }),
          writeFile: vi.fn(async (path: string, content: string) => {
            files.set(path, content);
          }),
          mkdir: vi.fn(async () => undefined),
          chmod: vi.fn(async () => undefined),
          copyFile: vi.fn(async () => undefined),
        };
      });
      const { FileHistoryService: Reader } = await import(
        './fileHistoryService.js'
      );
      return { Reader, files, statCalls, unlinkCalls, openCalls };
    };

    const nullBackup = {
      backupFileName: null,
      version: 1,
      backupTime: '2026-11-17T00:00:00.000Z',
    };
    // The R19-final review's blocking coordinate: a confirmed-null record
    // under a refused drive-relative spelling. The identity index folds it
    // into the ordinary `victim` identity, so R19's candidate filters
    // never exclude its restoration evidence.
    const refusedKey = '.\\C:f\\..\\victim';

    // ① Blocking: an ordinary execution candidate from another checkpoint
    // must not select a refused record's metadata as its restore baseline.
    // The candidate is ordinary (admitted by every R19 filter); the
    // baseline selection itself is what reaches through the identity
    // index. Post-fix the refused record supplies nothing, the ordinary
    // v2 record is not a first-version baseline, and the restore reports
    // an honest filesFailed instead of unlinking the ordinary file.
    it.each([['target-tracked'], ['target-diff-after']])(
      'keeps the refused record unselected as the rewind baseline (%s)',
      async (location) => {
        const inTracked = location === 'target-tracked';
        const { Reader, files, unlinkCalls } = await setup();
        files.set('C:\\w\\victim', 'sentinel');
        files.set('C:\\w\\new.txt', 'made');
        const reloaded = new Reader('r20-baseline', true, 'C:\\w');
        const payload = [
          {
            promptId: 'p1',
            cwd: 'C:\\w',
            timestamp: '2026-11-17T00:00:00.000Z',
            trackedFileBackups: inTracked
              ? { [refusedKey]: nullBackup, 'new.txt': nullBackup }
              : { 'new.txt': nullBackup },
            ...(inTracked
              ? {}
              : { diffAfterBackups: { [refusedKey]: nullBackup } }),
          },
          {
            promptId: 'p2',
            cwd: 'C:\\w',
            timestamp: '2026-11-17T00:01:00.000Z',
            trackedFileBackups: {
              victim: {
                backupFileName: 'missing-backup',
                version: 2,
                backupTime: '2026-11-17T00:01:00.000Z',
              },
            },
          },
        ];
        reloaded.restoreFromSnapshots(
          deserializeSnapshots(JSON.parse(JSON.stringify(payload))),
        );
        expect(await reloaded.rewind('p1', false)).toEqual({
          filesChanged: ['C:\\w\\new.txt'],
          filesFailed: ['C:\\w\\victim'],
        });
        expect(unlinkCalls).toEqual(['C:\\w\\new.txt']);
        expect(files.get('C:\\w\\victim')).toBe('sentinel');
        // The raw record is preserved for serialization/retention — only
        // its selection as an executable baseline is refused.
        const p1 = reloaded.getSnapshots()[0]!;
        expect(
          Object.keys(
            (inTracked ? p1.trackedFileBackups : p1.diffAfterBackups) ?? {},
          ),
        ).toContain(refusedKey);
      },
    );

    // ① Same selection defect through the first-version fallback: the
    // refused version-1 record sits in a NON-target checkpoint, the
    // ordinary candidate comes from a third one. The fallback scan must
    // skip the refused record and report filesFailed, never dispatch its
    // null baseline as unlink.
    it('keeps a refused first-version record in another checkpoint unselected', async () => {
      const { Reader, files, unlinkCalls } = await setup();
      files.set('C:\\w\\victim', 'sentinel');
      files.set('C:\\w\\new.txt', 'made');
      const reloaded = new Reader('r20-fallback', true, 'C:\\w');
      const payload = [
        {
          promptId: 'p1',
          cwd: 'C:\\w',
          timestamp: '2026-11-17T00:00:00.000Z',
          trackedFileBackups: { 'new.txt': nullBackup },
        },
        {
          promptId: 'p2',
          cwd: 'C:\\w',
          timestamp: '2026-11-17T00:01:00.000Z',
          trackedFileBackups: { [refusedKey]: nullBackup },
        },
        {
          promptId: 'p3',
          cwd: 'C:\\w',
          timestamp: '2026-11-17T00:02:00.000Z',
          trackedFileBackups: {
            victim: {
              backupFileName: 'missing-backup',
              version: 2,
              backupTime: '2026-11-17T00:02:00.000Z',
            },
          },
        },
      ];
      reloaded.restoreFromSnapshots(
        deserializeSnapshots(JSON.parse(JSON.stringify(payload))),
      );
      expect(await reloaded.rewind('p1', false)).toEqual({
        filesChanged: ['C:\\w\\new.txt'],
        filesFailed: ['C:\\w\\victim'],
      });
      expect(unlinkCalls).toEqual(['C:\\w\\new.txt']);
      expect(files.get('C:\\w\\victim')).toBe('sentinel');
    });

    // ① Candidate-absent axis: with only the refused record present, its
    // normalized identity used to satisfy trackEdit's existing-baseline
    // lookup, so the ordinary edit was never captured. The lookup must
    // ignore refused records and let the capture proceed (version 2: the
    // refused version-1 record still reserves its number).
    it('captures an ordinary edit whose only existing record is a refused spelling', async () => {
      const { Reader, statCalls } = await setup();
      const reloaded = new Reader('r20-capture', true, 'C:\\w');
      const payload = [
        {
          promptId: 'p1',
          cwd: 'C:\\w',
          timestamp: '2026-11-17T00:00:00.000Z',
          trackedFileBackups: {
            [refusedKey]: nullBackup,
            'new.txt': nullBackup,
          },
        },
      ];
      reloaded.restoreFromSnapshots(
        deserializeSnapshots(JSON.parse(JSON.stringify(payload))),
      );
      await reloaded.trackEdit('victim');
      const snapshot = reloaded.getSnapshots().at(-1)!;
      expect(Object.keys(snapshot.trackedFileBackups)).toContain('victim');
      expect(snapshot.trackedFileBackups['victim']).toEqual(
        expect.objectContaining({ backupFileName: null, version: 2 }),
      );
      expect(statCalls).toContain('C:\\w\\victim');
      // Raw preservation (R21 strengthened): the refused spelling keeps
      // its record verbatim — backup pointer, version and timestamp —
      // instead of being overwritten by the new capture's alias
      // write-back.
      expect(Object.keys(snapshot.trackedFileBackups)).toContain(refusedKey);
      expect(snapshot.trackedFileBackups[refusedKey]).toEqual({
        ...nullBackup,
        backupTime: new Date(nullBackup.backupTime),
      });
    });

    // ② Preview/restore consistency: collectTrackedFiles excludes
    // namespace-root snapshots, but getTurnDiff used to feed their raw
    // keys to getExecutionPaths, whose predicate checked only the key —
    // an ordinary key under a refused capture root was previewed (opened)
    // while restore admitted nothing. The candidate admission must check
    // the capture root together with the key, so both faces admit
    // identically.
    it.each([
      ['unc', '\\\\?\\UNC\\host\\share\\w'],
      ['drive-namespace', '\\\\?\\C:\\w'],
      ['device', '\\\\.\\foo'],
    ])(
      'admits preview identically to restore under the %s capture root (%s)',
      async (_kind, label) => {
        const { Reader, files, openCalls, unlinkCalls } = await setup();
        files.set(`${label}\\victim`, 'crafted\n');
        const reloaded = new Reader('r20-preview', true, label);
        const payload = [
          {
            promptId: 'p1',
            cwd: label,
            timestamp: '2026-11-17T00:00:00.000Z',
            trackedFileBackups: { victim: nullBackup },
          },
        ];
        reloaded.restoreFromSnapshots(
          deserializeSnapshots(JSON.parse(JSON.stringify(payload))),
        );
        expect(await reloaded.rewind('p1')).toEqual({
          filesChanged: [],
          filesFailed: [],
        });
        expect(unlinkCalls).toEqual([]);
        expect((await reloaded.getTurnDiff('p1'))?.files).toEqual([]);
        expect(openCalls).toEqual([]);
        expect(files.get(`${label}\\victim`)).toBe('crafted\n');
      },
    );

    // ③ Constructor: resolve() cancels the `C:f` component of
    // `C:\w\C:f\..` into the ordinary `C:\w`, which then captures
    // `C:\w\victim` — while the direct spelling
    // trackEdit('C:\w\C:f\..\victim') is refused. Conservative
    // unification: the original cwd spelling is classified before
    // resolve() can erase the component, and a cwd whose original
    // spelling names a refused coordinate records nothing.
    it.each([
      ['dot-canceled', 'C:\\w\\C:f\\..'],
      ['mid-path', 'C:\\w\\C:f'],
    ])(
      'refuses capture when the original cwd contains a drive-relative component (%s)',
      async (_kind, cwdInput) => {
        const { Reader, statCalls } = await setup();
        const service = new Reader('r20-cwd-drive', true, cwdInput);
        await service.makeSnapshot('p1');
        await service.trackEdit('victim');
        // R21: makeSnapshot refuses under the same flag — the service
        // records NOTHING, not even an empty ordinary snapshot labeled
        // with the resolved form.
        expect(service.getSnapshots()).toEqual([]);
        expect(statCalls).toEqual([]);
      },
    );

    // ③ Positive control: dot segments alone (no `X:` component) never
    // refused the cwd — `C:\w\sub\..` resolves to `C:\w` and captures
    // exactly like its direct spelling.
    it('still records when the cwd only contains dot segments (positive control)', async () => {
      const { Reader, statCalls } = await setup();
      const service = new Reader('r20-cwd-control', true, 'C:\\w\\sub\\..');
      await service.makeSnapshot('p1');
      await service.trackEdit('victim');
      expect(
        Object.keys(service.getSnapshots().at(-1)!.trackedFileBackups),
      ).toEqual(['victim']);
      expect(statCalls).toEqual(['C:\\w\\victim']);
    });

    // ④ Version reservation stays admission-blind: a refused record's
    // version numbers still reserve the identity's sequence, so a later
    // ordinary capture numbers past them (max refused version 5 → next
    // capture is version 6). Dropping refused records from the reservation
    // scan would let two records share a version number.
    it('keeps a refused record reserving its identity version numbers', async () => {
      const { Reader } = await setup();
      const reloaded = new Reader('r20-version', true, 'C:\\w');
      const payload = [
        {
          promptId: 'p1',
          cwd: 'C:\\w',
          timestamp: '2026-11-17T00:00:00.000Z',
          trackedFileBackups: {
            [refusedKey]: {
              backupFileName: null,
              version: 5,
              backupTime: '2026-11-17T00:00:00.000Z',
            },
            'new.txt': nullBackup,
          },
        },
      ];
      reloaded.restoreFromSnapshots(
        deserializeSnapshots(JSON.parse(JSON.stringify(payload))),
      );
      await reloaded.trackEdit('victim');
      expect(
        reloaded.getSnapshots().at(-1)!.trackedFileBackups['victim'],
      ).toEqual(expect.objectContaining({ backupFileName: null, version: 6 }));
    });
  });

  // R21: three admission-policy completion faces from the R20 review.
  // ① Fold admission (medium): deleting a checkpoint whose LABEL spells
  //    a refused Win32 capture root used to fold its ordinary keys into
  //    the survivor's diff endpoint — `areSnapshotOriginsEqual`
  //    normalizes `C:\w\C:f\..` onto `C:\w`, so the same-root check
  //    alone cannot see the refusal. After serialize/reload the folded
  //    records executed under the survivor's ordinary root: rewind
  //    dispatched unlink on a victim the pre-fold timeline correctly
  //    left untouched (filesFailed before, filesChanged after). Fold
  //    admission now applies the same raw-root policy as every other
  //    admission face; the records go with the deleted checkpoint.
  // ② Write-back preservation (medium): trackEdit's alias write-back
  //    used to overwrite EVERY identity-equivalent raw record — the
  //    newly admitted capture also replaced the refused record's backup
  //    pointer and version, destroying the historical evidence R20
  //    promised to keep while the key survived. Refused aliases now
  //    keep their metadata verbatim.
  // ③ Constructor boundary (low): a service whose original cwd spelled
  //    a refused coordinate records nothing — trackEdit already
  //    refused; makeSnapshot now refuses too instead of minting an
  //    ordinary snapshot labeled with the resolved form.
  describe('R21 admission completion: fold, write-back, constructor', () => {
    afterEach(() => {
      vi.doUnmock('node:path');
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    });

    const setup = async () => {
      vi.resetModules();
      const files = new Map<string, string>();
      const statCalls: string[] = [];
      const unlinkCalls: string[] = [];
      const openCalls: string[] = [];
      const enoent = (path: string) =>
        Object.assign(new Error(`ENOENT: no such file: ${path}`), {
          code: 'ENOENT',
        });
      vi.doMock('node:path', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:path')>();
        return {
          ...actual,
          ...actual.win32,
          resolve: (...args: string[]) =>
            actual.win32.resolve('C:\\reader', ...args),
        };
      });
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual =
          await importOriginal<typeof import('node:fs/promises')>();
        return {
          ...actual,
          open: vi.fn(async (path: string) => {
            openCalls.push(path);
            const content = files.get(path);
            if (content === undefined) throw enoent(path);
            return {
              stat: async () =>
                ({
                  size: content.length,
                }) as import('node:fs').Stats,
              readFile: async () => content,
              // createBackup flushes the temporary copy before
              // publishing it; R20's harness never reached this path.
              sync: async () => undefined,
              close: async () => undefined,
            } as unknown as import('node:fs/promises').FileHandle;
          }),
          stat: vi.fn(async (path: string) => {
            statCalls.push(path);
            if (!files.has(path)) throw enoent(path);
            return {
              size: files.get(path)!.length,
              mode: 0o644,
              mtimeMs: 0,
            } as unknown as import('node:fs').Stats;
          }),
          unlink: vi.fn(async (path: string) => {
            unlinkCalls.push(path);
            if (!files.has(path)) throw enoent(path);
            files.delete(path);
          }),
          readFile: vi.fn(async (path: string) => {
            const content = files.get(path);
            if (content === undefined) throw enoent(path);
            return content;
          }),
          writeFile: vi.fn(async (path: string, content: string) => {
            files.set(path, content);
          }),
          mkdir: vi.fn(async () => undefined),
          chmod: vi.fn(async () => undefined),
          // createBackup copies to a temporary path, fsyncs it and
          // renames it into place; the copy must materialize the bytes
          // so the flush below can open them.
          copyFile: vi.fn(async (source: string, destination: string) => {
            if (!files.has(source))
              throw Object.assign(
                new Error(`ENOENT: no such file: ${source}`),
                { code: 'ENOENT' },
              );
            files.set(destination, files.get(source)!);
          }),
          // Publication renames the temporary copy; the bytes already
          // live in the in-memory map, so rename is a stub.
          rename: vi.fn(async () => undefined),
        };
      });
      const { FileHistoryService: Reader } = await import(
        './fileHistoryService.js'
      );
      return { Reader, files, statCalls, unlinkCalls, openCalls };
    };

    const nullBackup = {
      backupFileName: null,
      version: 1,
      backupTime: '2026-11-17T00:00:00.000Z',
    };
    const refusedKey = '.\\C:f\\..\\victim';

    /** p1 (ordinary, no victim) → p2 (middleRoot, victim v1 null) → p3. */
    const timeline = (middleRoot: string): SerializedFileHistorySnapshot[] => [
      {
        promptId: 'p1',
        cwd: 'C:\\w',
        timestamp: '2026-11-17T00:00:00.000Z',
        trackedFileBackups: { 'new.txt': nullBackup },
      },
      {
        promptId: 'p2',
        cwd: middleRoot,
        timestamp: '2026-11-17T00:01:00.000Z',
        trackedFileBackups: { victim: nullBackup },
      },
      {
        promptId: 'p3',
        cwd: 'C:\\w',
        timestamp: '2026-11-17T00:02:00.000Z',
        trackedFileBackups: {
          victim: {
            backupFileName: 'missing-backup',
            version: 2,
            backupTime: '2026-11-17T00:02:00.000Z',
          },
        },
      },
    ];

    // ① The review's p1/p2/p3 counterexample, end to end through the
    // production fold entry (removeFileHistorySnapshots) and a full
    // serialize/reload round trip: a deleted refused-root checkpoint
    // must not hand its ordinary victim key to the survivor as
    // executable rewind evidence.
    it.each([
      ['dot-canceled', 'C:\\w\\C:f\\..'],
      ['forward-slash', 'C:/w/C:f/..'],
      ['lower-drive', 'c:\\w\\d:x\\..'],
    ])(
      'deleting a %s refused-root checkpoint does not fold it into executable evidence',
      async (_kind, refusedRoot) => {
        const { Reader, files, unlinkCalls } = await setup();
        files.set('C:\\w\\victim', 'sentinel');
        files.set('C:\\w\\new.txt', 'made');
        const surviving = timeline(refusedRoot);
        const before = JSON.stringify(surviving);
        expect(() =>
          removeFileHistorySnapshots(surviving, new Set(['p2'])),
        ).toThrow(/capture directory/);
        expect(JSON.stringify(surviving)).toBe(before);
        expect(surviving.map((snapshot) => snapshot.promptId)).toEqual([
          'p1',
          'p2',
          'p3',
        ]);
        expect(surviving[0]).not.toHaveProperty('diffAfterBackups');
        const reloaded = new Reader('r21-fold', true, 'C:\\w');
        reloaded.restoreFromSnapshots(
          deserializeSnapshots(JSON.parse(JSON.stringify(surviving))),
        );
        expect(await reloaded.rewind('p1', false)).toEqual({
          filesChanged: ['C:\\w\\new.txt'],
          filesFailed: ['C:\\w\\victim'],
        });
        expect(unlinkCalls).toEqual(['C:\\w\\new.txt']);
        expect(files.get('C:\\w\\victim')).toBe('sentinel');
      },
    );

    // ① 正控（折叠前）：before any deletion the refused capture root
    // already keeps the victim out of execution — R20 behavior, kept.
    it('keeps a refused-root checkpoint unexecutable before any deletion', async () => {
      const { Reader, files, unlinkCalls } = await setup();
      files.set('C:\\w\\victim', 'sentinel');
      files.set('C:\\w\\new.txt', 'made');
      const reloaded = new Reader('r21-prefold', true, 'C:\\w');
      reloaded.restoreFromSnapshots(
        deserializeSnapshots(
          JSON.parse(JSON.stringify(timeline('C:\\w\\C:f\\..'))),
        ),
      );
      expect(await reloaded.rewind('p1', false)).toEqual({
        filesChanged: ['C:\\w\\new.txt'],
        filesFailed: ['C:\\w\\victim'],
      });
      expect(unlinkCalls).toEqual(['C:\\w\\new.txt']);
      expect(files.get('C:\\w\\victim')).toBe('sentinel');
    });

    // ① 正控（普通根）：an ordinary same-root checkpoint still folds,
    // and the folded diff endpoint still authorizes the rewind unlink.
    it('still folds and executes a deleted ordinary-root checkpoint', async () => {
      const { Reader, files, unlinkCalls } = await setup();
      files.set('C:\\w\\victim', 'sentinel');
      files.set('C:\\w\\new.txt', 'made');
      const ordinary = timeline('C:\\w');
      // The last checkpoint redundantly retains p1's other baseline.
      ordinary[2].trackedFileBackups['new.txt'] = nullBackup;
      const surviving = removeFileHistorySnapshots(ordinary, new Set(['p2']));
      expect(surviving[0]).toHaveProperty('diffAfterBackups');
      const reloaded = new Reader('r21-ordinary', true, 'C:\\w');
      reloaded.restoreFromSnapshots(
        deserializeSnapshots(JSON.parse(JSON.stringify(surviving))),
      );
      expect(await reloaded.rewind('p1', false)).toEqual({
        filesChanged: ['C:\\w\\new.txt', 'C:\\w\\victim'],
        filesFailed: [],
      });
      expect(unlinkCalls).toEqual(['C:\\w\\new.txt', 'C:\\w\\victim']);
      expect(files.has('C:\\w\\victim')).toBe(false);
    });

    // ② Write-back preservation: the refused alias keeps its backup
    // pointer, version and timestamp when the ordinary spelling is
    // (re)captured under the same identity.
    it('keeps a refused record backup pointer and version when recapturing', async () => {
      const { Reader, files } = await setup();
      files.set('C:\\w\\victim', 'sentinel');
      const refusedRecord = {
        backupFileName: 'historical-backup',
        version: 5,
        backupTime: '2026-11-17T00:00:00.000Z',
      };
      const reloaded = new Reader('r21-writeback', true, 'C:\\w');
      reloaded.restoreFromSnapshots(
        deserializeSnapshots(
          JSON.parse(
            JSON.stringify([
              {
                promptId: 'p1',
                cwd: 'C:\\w',
                timestamp: '2026-11-17T00:00:00.000Z',
                trackedFileBackups: {
                  [refusedKey]: refusedRecord,
                  'new.txt': nullBackup,
                },
              },
            ]),
          ),
        ),
      );
      await reloaded.trackEdit('victim');
      const snapshot = reloaded.getSnapshots().at(-1)!;
      expect(snapshot.trackedFileBackups['victim']).toEqual(
        expect.objectContaining({
          backupFileName: expect.any(String),
          version: 6,
        }),
      );
      // R20 声明的 raw-evidence 保留现在有真断言：拒收记录的 backup
      // 指针与版本原样保留，不被新捕获的 alias write-back 覆写。
      expect(snapshot.trackedFileBackups[refusedKey]).toEqual({
        ...refusedRecord,
        backupTime: new Date(refusedRecord.backupTime),
      });
    });

    // ③ Constructor boundary: a restored ordinary checkpoint must not
    // be re-captured into an ordinary snapshot by a service whose
    // original cwd named a refused coordinate.
    it('emits no ordinary snapshot from a refused original cwd root', async () => {
      const { Reader, files, statCalls } = await setup();
      files.set('C:\\w\\victim', 'sentinel');
      const reloaded = new Reader('r21-snapshot', true, 'C:\\w\\C:f\\..');
      reloaded.restoreFromSnapshots(
        deserializeSnapshots(
          JSON.parse(
            JSON.stringify([
              {
                promptId: 'p1',
                cwd: 'C:\\w',
                timestamp: '2026-11-17T00:00:00.000Z',
                trackedFileBackups: {
                  victim: {
                    backupFileName: 'p1-backup',
                    version: 1,
                    backupTime: '2026-11-17T00:00:00.000Z',
                  },
                },
              },
            ]),
          ),
        ),
      );
      await reloaded.makeSnapshot('p2');
      expect(reloaded.getSnapshots()).toHaveLength(1);
      expect(reloaded.getSnapshots()[0]!.promptId).toBe('p1');
      expect(statCalls).toEqual([]);
    });
  });

  describe.skipIf(sep === '\\')('capture expression lifecycle', () => {
    const reload = async (source: FileHistoryService, cwd = projectDir) => {
      const disk = at('expression-history.json');
      await writeFile(
        disk,
        JSON.stringify(source.getSnapshots().map(serializeSnapshot)),
      );
      const fresh = new FileHistoryService('test-session', true, cwd);
      fresh.restoreFromSnapshots(
        deserializeSnapshots(JSON.parse(await readFile(disk, 'utf8'))),
      );
      await fresh.validateRestoredSnapshots();
      return fresh;
    };

    const fixture = async (kind: string) => {
      const external = join(storageDir, 'external');
      const target = at('target');
      await mkdir(external);
      await mkdir(join(target, 'sub'), { recursive: true });
      const internal = kind === 'internal' || kind === 'relative';
      const parent = internal ? projectDir : external;
      if (kind === 'ordinary') await mkdir(join(parent, 'link'));
      else await symlink(join(target, 'sub'), join(parent, 'link'));
      let raw = parent + '/link/../f';
      if (kind === 'nested') {
        await mkdir(join(target, 'deep', 'sub'), { recursive: true });
        await symlink(join(target, 'deep', 'sub'), join(parent, 'nested'));
        raw = parent + '/nested/../../f';
      }
      const actual =
        kind === 'ordinary' ? join(parent, 'f') : join(target, 'f');
      const decoy =
        kind === 'ordinary'
          ? join(target, 'f')
          : kind === 'nested'
            ? join(storageDir, 'f')
            : join(parent, 'f');
      if (kind !== 'missing') await writeFile(actual, 'TARGET-BEFORE\n');
      await writeFile(decoy, 'DECOY-BEFORE\n');
      return {
        raw,
        actual,
        decoy,
        input: kind === 'relative' ? 'link/../f' : raw,
      };
    };

    it.each([
      'external',
      'internal',
      'relative',
      'ordinary',
      'missing',
      'nested',
    ])(
      'preserves executable parent expressions through disk reload (%s)',
      async (kind) => {
        const { raw, actual, decoy, input } = await fixture(kind);
        await service.makeSnapshot('p1');
        await service.trackEdit(input);
        const entries = Object.entries(backupsAt(0));
        expect(entries).toHaveLength(1);
        expect(entries[0][0]).toBe(
          raw.startsWith(projectDir + '/')
            ? raw.slice(projectDir.length + 1)
            : raw,
        );
        if (kind === 'missing') expect(entries[0][1].backupFileName).toBeNull();
        else
          expect(
            await readFile(backupPath(entries[0][1].backupFileName!), 'utf8'),
          ).toBe('TARGET-BEFORE\n');
        await writeFile(raw, 'TARGET-EDITED\n');
        await writeFile(decoy, 'DECOY-EDITED\n');
        const fresh = await reload(service);
        expect(fresh.getSnapshots().map(serializeSnapshot)).toEqual(
          service.getSnapshots().map(serializeSnapshot),
        );
        const preview = await fresh.getTurnDiff('p1');
        expect(preview?.files[0].hunks.flatMap((hunk) => hunk.lines)).toContain(
          '+TARGET-EDITED',
        );
        expect(
          preview?.files[0].hunks.flatMap((hunk) => hunk.lines),
        ).not.toContain('+DECOY-EDITED');
        expect((await fresh.rewind('p1')).filesFailed).toEqual([]);
        if (kind === 'missing') expect(existsSync(actual)).toBe(false);
        else expect(await readFile(actual, 'utf8')).toBe('TARGET-BEFORE\n');
        expect(await readFile(decoy, 'utf8')).toBe('DECOY-EDITED\n');
      },
    );

    it.each([false, true])(
      'shares only exact absolute-relative parent expressions (missing=%s)',
      async (missing) => {
        const { raw, actual, decoy } = await fixture('internal');
        if (missing) await rm(actual);
        await service.makeSnapshot('p1');
        await service.trackEdit(raw);
        const first = structuredClone(onlyBackup(0));
        await writeFile(actual, 'SECOND\n');
        await service.trackEdit('link/../f');
        expect(onlyBackup(0)).toEqual(first);
        expect(Object.keys(backupsAt(0))).toEqual(['link/../f']);
        await service.makeSnapshot('p2');
        expect(onlyBackup(1).version).toBe(2);
        expect(
          await readFile(backupPath(onlyBackup(1).backupFileName!), 'utf8'),
        ).toBe('SECOND\n');
        const fresh = await reload(service);
        expect((await fresh.rewind('p1')).filesFailed).toEqual([]);
        if (missing) expect(existsSync(actual)).toBe(false);
        else expect(await readFile(actual, 'utf8')).toBe('TARGET-BEFORE\n');
        expect(await readFile(decoy, 'utf8')).toBe('DECOY-BEFORE\n');
      },
    );

    it.each([
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ])(
      'preserves independent captures and fails uncertain collision groups before writes (ordinary=%s, reverse=%s)',
      async (ordinary, reverse) => {
        const { raw, actual, decoy } = await fixture(
          ordinary ? 'ordinary' : 'internal',
        );
        const lexical = ordinary ? actual : decoy;
        const order = reverse ? [raw, lexical] : [lexical, raw];
        await service.makeSnapshot('p1');
        await service.trackEdit(order[0]);
        if (ordinary) await writeFile(actual, 'SECOND\n');
        await service.trackEdit(order[1]);
        const captured = service.getSnapshots().map(serializeSnapshot);
        expect(Object.keys(captured[0].trackedFileBackups)).toHaveLength(2);
        const names = Object.values(captured[0].trackedFileBackups).map(
          (backup) => backup.backupFileName!,
        );
        expect(new Set(names).size).toBe(2);
        const backupBytes = await Promise.all(
          names.map((name) => readFile(backupPath(name), 'utf8')),
        );
        await writeFile(actual, 'TARGET-EDITED\n');
        await writeFile(decoy, 'DECOY-EDITED\n');
        await service.makeSnapshot('p2');
        const fresh = await reload(service);
        const before = fresh.getSnapshots().map(serializeSnapshot);
        const result = await fresh.rewind('p1');
        expect(result.filesFailed).toHaveLength(2);
        expect(result.filesChanged).toEqual([]);
        expect(await readFile(actual, 'utf8')).toBe('TARGET-EDITED\n');
        expect(await readFile(decoy, 'utf8')).toBe('DECOY-EDITED\n');
        expect(fresh.getSnapshots().map(serializeSnapshot)).toEqual(before);
        expect(
          await Promise.all(
            names.map((name) => readFile(backupPath(name), 'utf8')),
          ),
        ).toEqual(backupBytes);
      },
    );

    it.each(['tracked', 'diff'])(
      'refuses uncertain first-version fallback groups while restoring unrelated files (%s)',
      async (endpoint) => {
        const { raw, actual, decoy } = await fixture('internal');
        const unrelated = at('unrelated');
        await writeFile(unrelated, 'UNRELATED-BEFORE');
        await service.makeSnapshot('p0');
        await service.trackEdit(unrelated);
        await service.makeSnapshot('p1');
        await service.trackEdit(raw);
        await service.trackEdit(decoy);
        if (endpoint === 'diff') {
          const snapshot = service.getSnapshots()[1];
          const {
            [raw.slice(projectDir.length + 1)]: parent,
            f: lexical,
            ...rest
          } = snapshot.trackedFileBackups;
          service.restoreFromSnapshots([
            service.getSnapshots()[0],
            {
              ...snapshot,
              trackedFileBackups: rest,
              diffAfterBackups: { 'link/../f': parent, f: lexical },
            },
          ]);
        }
        await writeFile(actual, 'TARGET-EDITED');
        await writeFile(decoy, 'DECOY-EDITED');
        await writeFile(unrelated, 'UNRELATED-EDITED');
        const fresh = await reload(service);
        const result = await fresh.rewind('p0');
        expect(result.filesFailed).toHaveLength(2);
        expect(result.filesChanged).toEqual([unrelated]);
        expect(await readFile(actual, 'utf8')).toBe('TARGET-EDITED');
        expect(await readFile(decoy, 'utf8')).toBe('DECOY-EDITED');
        expect(await readFile(unrelated, 'utf8')).toBe('UNRELATED-BEFORE');
        expect(fresh.getSnapshots()).toHaveLength(2);
      },
    );

    it('allows uncertain expressions with identical confirmed null metadata', async () => {
      const { raw, actual, decoy } = await fixture('internal');
      const backup = {
        backupFileName: null,
        version: 1,
        backupTime: new Date(),
      };
      service.restoreFromSnapshots([
        {
          promptId: 'p1',
          cwd: projectDir,
          timestamp: new Date(),
          trackedFileBackups: { [raw]: backup, [decoy]: backup },
        },
      ]);
      expect((await service.rewind('p1')).filesFailed).toEqual([]);
      expect(existsSync(actual)).toBe(false);
      expect(existsSync(decoy)).toBe(false);
    });

    it.each([false, true])(
      'anchors a parent-sensitive native cwd without cancelling it (relative=%s)',
      async (relative) => {
        const { actual, decoy } = await fixture('internal');
        const cwd = projectDir + '/link/..';
        const nativeCwd = relative ? cwd.slice(1) : cwd;
        const cwdSpy = relative
          ? vi.spyOn(process, 'cwd').mockReturnValue('/')
          : undefined;
        let svc: FileHistoryService;
        try {
          svc = new FileHistoryService('test-session', true, nativeCwd);
        } finally {
          cwdSpy?.mockRestore();
        }
        await svc.makeSnapshot('p1');
        expect(svc.getSnapshots()[0].cwd).toBe(cwd);
        await svc.trackEdit('f');
        await writeFile(actual, 'TARGET-EDITED\n');
        await writeFile(decoy, 'DECOY-EDITED\n');
        const fresh = await reload(svc, cwd);
        expect(fresh.getForeignSnapshotCwds()).toEqual([]);
        expect((await fresh.rewind('p1')).filesFailed).toEqual([]);
        expect(await readFile(actual, 'utf8')).toBe('TARGET-BEFORE\n');
        expect(await readFile(decoy, 'utf8')).toBe('DECOY-EDITED\n');
      },
    );

    it.each(['/', '/.'])(
      'preserves terminal directory syntax (%s)',
      async (suffix) => {
        const file = at('f');
        await writeFile(file, 'BEFORE');
        await service.makeSnapshot('p1');
        await service.trackEdit(file + suffix);
        expect(backupsAt(0)).toEqual({});
        await writeFile(file, 'EDITED');
        expect((await service.rewind('p1')).filesChanged).toEqual([]);
        expect(await readFile(file, 'utf8')).toBe('EDITED');
        expect(getCapturePath(projectDir, file + suffix)).not.toBe(
          getCapturePath(projectDir, file),
        );
      },
    );

    it.each(['dir\\f', '空 格["f"]\n'])(
      'round-trips literal POSIX filename bytes (%s)',
      async (name) => {
        const file = at(name);
        await writeFile(file, 'BEFORE');
        await service.makeSnapshot('p1');
        await service.trackEdit(file);
        await writeFile(file, 'EDITED');
        const fresh = await reload(service);
        expect((await fresh.rewind('p1')).filesFailed).toEqual([]);
        expect(await readFile(file, 'utf8')).toBe('BEFORE');
      },
    );

    it('does not skip a missing parent to capture its decoy', async () => {
      await writeFile(at('f'), 'DECOY');
      await service.makeSnapshot('p1');
      await service.trackEdit(projectDir + '/missing/../f');
      expect(Object.keys(backupsAt(0))).toEqual(['missing/../f']);
      expect(onlyBackup(0).backupFileName).toBeNull();
      expect(await readFile(at('f'), 'utf8')).toBe('DECOY');
    });

    it('retains raw parent-expression keys and references during hydration', async () => {
      const { raw, decoy } = await fixture('internal');
      const backup = {
        backupFileName: null,
        version: 1,
        backupTime: new Date(),
      };
      const snapshot: FileHistorySnapshot = {
        promptId: 'p1',
        cwd: projectDir,
        timestamp: new Date(),
        trackedFileBackups: { [raw]: backup, [decoy]: backup },
        diffAfterBackups: { [raw]: backup },
      };
      service.restoreFromSnapshots([snapshot]);
      expect(service.getSnapshots().map(serializeSnapshot)).toEqual([
        serializeSnapshot(snapshot),
      ]);
    });

    it.each(['//f', '/./f', '//dir/../f'])(
      'preserves repeated separator execution without making a relative key absolute (%s)',
      async (suffix) => {
        await mkdir(at('dir'));
        const file = at('f');
        await writeFile(file, 'BEFORE');
        await service.makeSnapshot('p1');
        await service.trackEdit(projectDir + suffix);
        await writeFile(file, 'EDITED');
        const fresh = await reload(service);
        expect((await fresh.rewind('p1')).filesFailed).toEqual([]);
        expect(await readFile(file, 'utf8')).toBe('BEFORE');
      },
    );

    it('preserves double-leading-slash origin identity', async () => {
      const cwd = '/' + projectDir;
      const svc = new FileHistoryService('test-session', true, cwd);
      await svc.makeSnapshot('p1');
      expect(svc.getSnapshots()[0].cwd).toBe(cwd);
      expect(areSnapshotOriginsEqual(cwd, projectDir)).toBe(false);
      expect(areSnapshotOriginsEqual(cwd + '/link/..', cwd)).toBe(false);
      expect(getCapturePath(cwd, 'f')).toBe('posix:' + cwd + '/f');
    });

    it.each(['', '/', '//', '/.', '/./'])(
      'keeps safe directory-root suffix aliases droppable (%s)',
      (suffix) => {
        const cwd = '/foreign' + suffix;
        const snapshot: FileHistorySnapshot = {
          promptId: 'p2',
          cwd,
          timestamp: new Date(),
          trackedFileBackups: {
            f: { backupFileName: null, version: 1, backupTime: new Date() },
          },
        };
        expect(service.getUnrestorableDiscardedCaptures([snapshot])).toEqual(
          [],
        );
      },
    );

    it.each(['', '/', '//', '/.', '/./'])(
      'requires captures under a current directory-root syntax alias (%s)',
      (suffix) => {
        const cwd = projectDir + '/child' + suffix;
        const current = new FileHistoryService('test-session', true, cwd);
        const snapshot: FileHistorySnapshot = {
          promptId: 'p2',
          cwd: projectDir,
          timestamp: new Date(),
          trackedFileBackups: {
            'child/f': {
              backupFileName: null,
              version: 1,
              backupTime: new Date(),
            },
          },
        };
        expect(current.getUnrestorableDiscardedCaptures([snapshot])).toEqual([
          projectDir + '/child/f',
        ]);
      },
    );

    it.each([
      [true, false, false],
      [false, true, false],
      [true, true, false],
      [true, false, true],
      [false, true, true],
    ])(
      'requires parent-sensitive discarded captures (keyParent=%s, rootParent=%s, covered=%s)',
      (keyParent, rootParent, covered) => {
        const cwd = '/foreign' + (rootParent ? '/link/..' : '');
        const key = keyParent ? 'link/../f' : 'f';
        const absolute = cwd + '/' + key;
        const backup = {
          backupFileName: null,
          version: 1,
          backupTime: new Date(),
        };
        const survivor: FileHistorySnapshot = {
          promptId: 'p1',
          cwd: projectDir,
          timestamp: new Date(),
          trackedFileBackups: covered ? { [absolute]: backup } : {},
        };
        const suffix: FileHistorySnapshot = {
          promptId: 'p2',
          cwd,
          timestamp: new Date(),
          trackedFileBackups: { [key]: backup },
        };
        expect(
          service.getUnrestorableDiscardedCaptures([suffix], [survivor]),
        ).toEqual(covered ? [] : [absolute]);
      },
    );
  });

  describe('backup alias identity', () => {
    it.each([
      ['external to local', 'new'],
      ['external to local', 'old'],
      ['local to external', 'new'],
      ['local to external', 'old'],
    ])(
      'preserves disk backups after %s relocation (%s)',
      async (direction, content) => {
        const dirA = at('A');
        const dirB = at('B');
        await mkdir(dirA);
        await mkdir(dirB);
        const file = join(dirB, 'f');
        const origin = direction === 'external to local' ? dirA : dirB;
        const destination = origin === dirA ? dirB : dirA;
        const reload = async (
          cwd: string,
          snapshots: FileHistorySnapshot[],
        ) => {
          const payload = at('history.json');
          await writeFile(
            payload,
            JSON.stringify(snapshots.map(serializeSnapshot)),
          );
          const restored = new FileHistoryService('test-session', true, cwd);
          restored.restoreFromSnapshots(
            deserializeSnapshots(JSON.parse(await readFile(payload, 'utf-8'))),
          );
          await restored.validateRestoredSnapshots();
          return restored;
        };
        const original = new FileHistoryService('test-session', true, origin);
        await writeFile(file, 'old');
        await original.makeSnapshot('a1');
        await original.trackEdit(file);
        const originalKey = origin === dirB ? 'f' : file;
        const first =
          original.getSnapshots()[0].trackedFileBackups[originalKey];
        expect(first).toEqual(V1_BACKUP);
        const firstBytes = await readFile(backupPath(first.backupFileName!));
        await writeFile(file, content);

        const relocated = await reload(destination, original.getSnapshots());
        expect(
          Object.keys(relocated.getSnapshots()[0].trackedFileBackups),
        ).toEqual([originalKey]);
        await relocated.makeSnapshot('b1');
        expect(relocated.getSnapshots()[1].trackedFileBackups).toEqual({});
        await relocated.trackEdit(file);
        const checkpointBeforeTrack = serializeSnapshot(
          relocated.getSnapshots()[1],
        );
        await relocated.trackEdit(file);
        if (destination === dirB)
          expect(serializeSnapshot(relocated.getSnapshots()[1])).toEqual(
            checkpointBeforeTrack,
          );
        const newKey = destination === dirB ? 'f' : file;
        expect(
          relocated.getSnapshots()[1].trackedFileBackups[newKey].version,
        ).toBe(2);
        expect
          .soft(await readFile(backupPath(first.backupFileName!)))
          .toEqual(firstBytes);

        // Rehydrate aliases, then capture another changed checkpoint.
        const resumed = await reload(destination, relocated.getSnapshots());
        const capturedBytes = await Promise.all(
          resumed.getSnapshots().flatMap((snapshot) =>
            Object.values(snapshot.trackedFileBackups)
              .filter((backup) => backup.backupFileName !== null)
              .map(async (backup) => ({
                path: backupPath(backup.backupFileName!),
                bytes: await readFile(backupPath(backup.backupFileName!)),
              })),
          ),
        );
        await writeFile(file, 'later');
        await resumed.makeSnapshot('b2');
        for (const captured of capturedBytes) {
          expect.soft(await readFile(captured.path)).toEqual(captured.bytes);
        }
        expect
          .soft(await readFile(backupPath(first.backupFileName!)))
          .toEqual(firstBytes);
        const beforeDeletion = JSON.stringify(
          resumed.getSnapshots().map(serializeSnapshot),
        );
        expect(() =>
          removeFileHistorySnapshots(
            resumed.getSnapshots(),
            new Set(['b1', 'b2']),
          ),
        ).toThrow(/capture directory/);
        expect(
          JSON.stringify(resumed.getSnapshots().map(serializeSnapshot)),
        ).toBe(beforeDeletion);
        expect(await readFile(file, 'utf-8')).toBe('later');
        // Refusal preserves the original capture for an explicit source-root reload.
        const returned = await reload(origin, original.getSnapshots());
        expect((await returned.rewind('a1')).filesFailed).toEqual([]);
        expect.soft(await readFile(file, 'utf-8')).toBe('old');
        expect(await readFile(backupPath(first.backupFileName!))).toEqual(
          firstBytes,
        );
      },
    );
    it('allocates past aliases retained only in diffAfterBackups', async () => {
      const dirB = at('B');
      const dirA = at('A');
      await mkdir(dirA);
      await mkdir(dirB);
      service = new FileHistoryService('test-session', true, dirA);
      const file = join(dirB, 'f');
      const svcB = new FileHistoryService('test-session', true, dirB);
      await svcB.makeSnapshot('a0');
      await svcB.makeSnapshot('a1');
      await writeFile(file, 'old');
      await svcB.trackEdit(file);
      const first = svcB.getSnapshots()[1].trackedFileBackups['f'];
      const kept = removeFileHistorySnapshots(
        [...svcB.getSnapshots(), { ...svcB.getSnapshots()[0], promptId: 'a2' }],
        new Set(['a1']),
      );
      expect(kept[0].trackedFileBackups).toEqual({});
      expect(kept[0].diffAfterBackups?.['f']).toEqual(first);
      service.restoreFromSnapshots(
        deserializeSnapshots(kept.map(serializeSnapshot)),
      );
      await writeFile(file, 'new');
      await service.makeSnapshot('b1');
      await service.trackEdit(file);
      expect
        .soft(service.getSnapshots()[2].trackedFileBackups[file].version)
        .toBe(2);
      expect
        .soft(await readFile(backupPath(first.backupFileName!), 'utf-8'))
        .toBe('old');

      const beforeDeletion = JSON.stringify(
        service.getSnapshots().map(serializeSnapshot),
      );
      expect(() =>
        removeFileHistorySnapshots(service.getSnapshots(), new Set(['b1'])),
      ).toThrow(/capture directory/);
      expect(
        JSON.stringify(service.getSnapshots().map(serializeSnapshot)),
      ).toBe(beforeDeletion);
      const returned = new FileHistoryService('test-session', true, dirB);
      returned.restoreFromSnapshots(
        deserializeSnapshots(kept.map(serializeSnapshot)),
      );
      expect((await returned.rewind('a0')).filesFailed).toEqual([]);
      expect(await readFile(file, 'utf-8')).toBe('old');
    });

    it('counts failed alias versions and allocates failures by capture path', async () => {
      const dirB = at('B');
      const dirA = at('A');
      await mkdir(dirA);
      await mkdir(dirB);
      service = new FileHistoryService('test-session', true, dirA);
      const file = join(dirB, 'f');
      await writeFile(file, 'old');
      const svcB = new FileHistoryService('test-session', true, dirB);
      await svcB.makeSnapshot('a1');
      await svcB.trackEdit(file);
      const first = svcB.getSnapshots()[0].trackedFileBackups['f'];
      const failed: FileHistorySnapshot = {
        ...svcB.getSnapshots()[0],
        promptId: 'a2',
        trackedFileBackups: {
          f: { ...first, version: 7, failed: true },
        },
      };
      service.restoreFromSnapshots(
        deserializeSnapshots(
          [svcB.getSnapshots()[0], failed].map(serializeSnapshot),
        ),
      );
      // The old relative f belongs to B, not the new root's f.
      await service.makeSnapshot('b1');
      expect(service.getSnapshots()[2].trackedFileBackups).toEqual({});
      await service.trackEdit('f');
      expect
        .soft(service.getSnapshots()[2].trackedFileBackups['f'].version)
        .toBe(1);
      await service.trackEdit(file);
      expect
        .soft(service.getSnapshots()[2].trackedFileBackups[file].version)
        .toBe(8);
      await rm(file);
      await mkdir(file); // copyFile fails with EISDIR, without losing old blobs.
      await service.makeSnapshot('b2');
      const failure = service.getSnapshots()[3].trackedFileBackups[file];
      expect(failure.failed).toBe(true);
      expect.soft(failure.version).toBe(9);
      expect(await readFile(backupPath(first.backupFileName!), 'utf-8')).toBe(
        'old',
      );
      await rm(file, { recursive: true });
      await writeFile(file, 'healed');
      await service.trackEdit(file);
      expect(service.getSnapshots()[3].trackedFileBackups[file].version).toBe(
        10,
      );
    });
  });

  describe('snapshot cwd compatibility', () => {
    it('records the working directory on every new snapshot', async () => {
      await service.makeSnapshot('p1');

      expect(service.getSnapshots()[0].cwd).toBe(projectDir);
    });

    it('round-trips the snapshot cwd through serialization', () => {
      const snapshot: FileHistorySnapshot = {
        ...restoredP1('a.txt', 'deadbeefcafebabe@v1'),
        cwd: projectDir,
      };

      const [restored] = deserializeSnapshots([serializeSnapshot(snapshot)]);

      expect(restored.cwd).toBe(projectDir);
    });

    it('keeps foreign-cwd checkpoints in the timeline for turn mapping', () => {
      const otherDir = join(tmpdir(), 'fh-other-root');
      const local: FileHistorySnapshot = {
        ...restoredP1('b.txt', 'deadfeed012345678@v1'),
        promptId: 'p2',
        cwd: projectDir,
      };
      service.restoreFromSnapshots([
        { ...restoredP1('a.txt', 'deadbeefcafebabe@v1'), cwd: otherDir },
        local,
      ]);

      // Rewind surfaces resolve turns through these positions, so a foreign
      // checkpoint must stay in place rather than disappear from the list.
      expect(service.getSnapshots().map((s) => s.promptId)).toEqual([
        'p1',
        'p2',
      ]);
    });

    it('mixed absolute/relative aliases of one file never collide backup names or cross-capture', async () => {
      // Same physical file tracked under BOTH spellings in cwd A: the
      // absolute form first, then the relative form. Independent version
      // counters must not overwrite each other's backups, and rewinding to
      // the absolute-spelling snapshot must restore its own captured content.
      const file = join(projectDir, 'alias.txt');
      await writeFile(file, 'one');
      await service.makeSnapshot('p1');
      await service.trackEdit(file); // absolute spelling /proj/alias.txt
      await writeFile(file, 'two');
      await service.makeSnapshot('p2');
      await service.trackEdit('alias.txt'); // relative spelling
      await writeFile(file, 'three');
      await service.makeSnapshot('p3');
      const res = await service.rewind('p1');
      expect(res.filesFailed).toEqual([]);
      expect(await readFile(file, 'utf-8')).toBe('one');
    });

    it('rewinding a foreign-cwd snapshot through a same-named relative key is refused, not mis-restored', async () => {
      // p2 captures alias.txt under cwd A. Hydrate in cwd B, capture the SAME
      // relative spelling there (a different physical file), then ask to
      // rewind to p2: the cross-directory guard must refuse instead of
      // silently restoring A's content into B's file or B's into A's.
      const fileA = join(projectDir, 'alias2.txt');
      await writeFile(fileA, 'from-A');
      await service.makeSnapshot('p1');
      await service.trackEdit('alias2.txt');
      await writeFile(fileA, 'edited-A');
      await service.makeSnapshot('p2');
      const otherDir = join(tmpdir(), 'fh-alias-b');
      await mkdir(otherDir, { recursive: true });
      const fileB = join(otherDir, 'alias2.txt');
      await writeFile(fileB, 'from-B');
      const svcB = new FileHistoryService('alias-b', true, otherDir);
      svcB.restoreFromSnapshots(service.getSnapshots());
      await svcB.trackEdit('alias2.txt'); // same spelling, different file
      await writeFile(fileB, 'edited-B');
      await svcB.makeSnapshot('p3');
      await expect(svcB.rewind('p2')).rejects.toThrow(
        /different working directory/,
      );
      expect(await readFile(fileB, 'utf-8')).toBe('edited-B');
      expect(await readFile(fileA, 'utf-8')).toBe('edited-A');
    });

    it('does not rewrite an absolute external key against the hydrating cwd', () => {
      const otherDir = join(tmpdir(), 'fh-other-root');
      const capturedExternal = join(otherDir, 'x.txt');
      const labeled: FileHistorySnapshot = {
        ...restoredP1(capturedExternal, 'deadbeefcafebabe@v1'),
        cwd: projectDir,
      };

      // Hydrate with a service rooted in otherDir: the absolute key captured
      // under cwd=projectDir must NOT be shortened against otherDir. The key's
      // coordinate system is the snapshot's own cwd label; rewriting it to
      // 'x.txt' would let a later reload in projectDir pass the
      // cross-directory guard and restore otherDir/x.txt's content into
      // projectDir/x.txt.
      const service = new FileHistoryService('hydrate-test', true, otherDir);
      service.restoreFromSnapshots([labeled]);
      const [snapshot] = service.getSnapshots();
      expect(Object.keys(snapshot.trackedFileBackups)).toEqual([
        capturedExternal,
      ]);
    });

    it('does not fold a deleted foreign checkpoint into a local survivor', () => {
      const otherDir = join(tmpdir(), 'fh-other-root');
      const survivor: FileHistorySnapshot = {
        ...restoredP1('a.txt', 'deadbeefcafebabe@v1'),
        promptId: 'p1',
        cwd: projectDir,
      };
      const foreign: FileHistorySnapshot = {
        ...restoredP1('b.txt', 'deadfeed012345678@v1'),
        promptId: 'p2',
        cwd: otherDir,
      };

      const before = JSON.stringify([survivor, foreign]);
      expect(() =>
        removeFileHistorySnapshots([survivor, foreign], new Set(['p2'])),
      ).toThrow(/capture directory/);
      expect(JSON.stringify([survivor, foreign])).toBe(before);
      expect(survivor.diffAfterBackups).toBeUndefined();
    });

    it('reports required captures that a discarded foreign suffix holds', () => {
      // Blocking A companion query: truncating a timeline to a survivor
      // slice discards later checkpoints, and a foreign-root checkpoint in
      // that suffix can hold the only baseline for a file this session
      // still restores (e.g. a confirmed first-version "file did not exist
      // yet" record). Rewind surfaces refuse such truncations based on
      // this list, while droppable records — the checkpoint's own files,
      // and duplicates a surviving checkpoint already restores — stay
      // silent.
      const dirB = join(tmpdir(), 'fh-foreign-own');
      // A restore target outside BOTH roots: an external absolute path
      // (R12 blocking 1).
      const external = join(tmpdir(), 'fh-shared-external', 'new.txt');
      const localEmpty: FileHistorySnapshot = {
        promptId: 'p1',
        cwd: projectDir,
        timestamp: new Date('2026-06-13T00:00:00.000Z'),
        trackedFileBackups: {},
      };
      const capturedInB: FileHistorySnapshot = {
        promptId: 'p2',
        cwd: dirB,
        timestamp: new Date('2026-06-13T00:00:02.000Z'),
        trackedFileBackups: {
          // The file did not exist when it was first tracked from dirB:
          // dropping p2 would also drop the only record of that fact, and a
          // restore of the surviving slice would report empty success while
          // leaving a later-created file in place.
          [join(projectDir, 'new.txt')]: {
            backupFileName: null,
            version: 1,
            backupTime: new Date('2026-06-13T00:00:01.000Z'),
          },
          // The external absolute path's only baseline lives in p2 as well:
          // it is not the checkpoint's own file, so dropping it silently
          // must be refused too.
          [external]: {
            backupFileName: null,
            version: 1,
            backupTime: new Date('2026-06-13T00:00:01.000Z'),
          },
        },
      };
      const foreignOwn: FileHistorySnapshot = {
        promptId: 'p3',
        cwd: dirB,
        timestamp: new Date('2026-06-13T00:00:03.000Z'),
        trackedFileBackups: {
          'own.txt': {
            backupFileName: 'deadfeed012345678@v1',
            version: 1,
            backupTime: new Date('2026-06-13T00:00:02.000Z'),
          },
          [join(dirB, 'abs.txt')]: {
            backupFileName: 'deadfeed012345679@v1',
            version: 1,
            backupTime: new Date('2026-06-13T00:00:02.000Z'),
          },
        },
      };
      service.restoreFromSnapshots([localEmpty, capturedInB, foreignOwn]);
      const snapshots = service.getSnapshots();

      // p2's absolute keys resolve outside dirB — one under the surviving
      // root, one external to both roots — so discarding p2 loses each
      // file's only baseline: both reported for the refusal.
      expect(
        service.getUnrestorableDiscardedCaptures(
          snapshots.slice(1, 2),
          snapshots.slice(0, 1),
        ),
      ).toEqual([join(projectDir, 'new.txt'), external]);
      // p3's records — relative or absolute — stay under dirB: dropping
      // them with p3 must not block the rewind (R1-9).
      expect(
        service.getUnrestorableDiscardedCaptures(
          snapshots.slice(2),
          snapshots.slice(0, 2),
        ),
      ).toEqual([]);
      // Ordinary same-root truncation discards local records unreported.
      expect(
        service.getUnrestorableDiscardedCaptures(snapshots.slice(0, 1)),
      ).toEqual([]);
      // The default still previews the whole timeline as discarded.
      expect(service.getUnrestorableDiscardedCaptures()).toEqual([
        join(projectDir, 'new.txt'),
        external,
      ]);
    });

    it('keeps a redundant foreign capture from blocking a safe rewind', () => {
      // R12 medium: the query must distinguish a required baseline from a
      // duplicate. When the surviving slice already restores the identity
      // (a confirmed baseline — including a confirmed-null one), the
      // discarded foreign capture is redundant and must not be reported.
      const dirB = join(tmpdir(), 'fh-redundant-b');
      const survivor: FileHistorySnapshot = {
        promptId: 'p1',
        cwd: projectDir,
        timestamp: new Date('2026-06-13T00:00:00.000Z'),
        trackedFileBackups: {
          f: {
            backupFileName: 'deadbeefcafebabe@v1',
            version: 1,
            backupTime: new Date('2026-06-13T00:00:00.000Z'),
          },
        },
      };
      const redundant: FileHistorySnapshot = {
        promptId: 'p2',
        cwd: dirB,
        timestamp: new Date('2026-06-13T00:00:02.000Z'),
        trackedFileBackups: {
          // The absolute spelling of p1's relative 'f' at a later version:
          // p1 restores that identity without this record.
          [join(projectDir, 'f')]: {
            backupFileName: 'deadfeed012345678@v2',
            version: 2,
            backupTime: new Date('2026-06-13T00:00:01.000Z'),
          },
          // A sole confirmed-null baseline for a different file: required.
          [join(projectDir, 'g')]: {
            backupFileName: null,
            version: 1,
            backupTime: new Date('2026-06-13T00:00:01.000Z'),
          },
        },
      };
      service.restoreFromSnapshots([survivor, redundant]);
      const [p1, p2] = service.getSnapshots();

      // Only the identity no surviving checkpoint can restore blocks the
      // rewind; the duplicate of p1's confirmed baseline does not.
      expect(service.getUnrestorableDiscardedCaptures([p2], [p1])).toEqual([
        join(projectDir, 'g'),
      ]);

      // A surviving confirmed-null baseline covers the identity just as
      // well: rewinding to "the file did not exist yet" needs no discarded
      // record to prove it.
      const nullSurvivor: FileHistorySnapshot = {
        ...p1,
        trackedFileBackups: {
          [join(projectDir, 'g')]: {
            backupFileName: null,
            version: 1,
            backupTime: new Date('2026-06-13T00:00:00.000Z'),
          },
        },
      };
      expect(
        service.getUnrestorableDiscardedCaptures([p2], [nullSurvivor]),
      ).toEqual([join(projectDir, 'f')]);

      // A FAILED surviving record captured nothing, so it cannot cover the
      // identity: the discarded baseline is still required.
      const failedSurvivor: FileHistorySnapshot = {
        ...p1,
        trackedFileBackups: {
          [join(projectDir, 'f')]: {
            backupFileName: null,
            version: 1,
            failed: true,
            backupTime: new Date('2026-06-13T00:00:00.000Z'),
          },
        },
      };
      expect(
        service.getUnrestorableDiscardedCaptures(
          [p2],
          [failedSurvivor, nullSurvivor],
        ),
      ).toEqual([join(projectDir, 'f')]);
    });

    it('folds Win32 drive-letter case when judging discarded captures', async () => {
      vi.resetModules();
      vi.doMock('node:path', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:path')>();
        return { ...actual, ...actual.win32 };
      });
      const { FileHistoryService: WindowsReader } = await import(
        './fileHistoryService.js'
      );
      vi.doUnmock('node:path');
      vi.resetModules();
      // R12 blocking 2: a Win32 drive letter names the same drive in
      // either case (path.win32 resolves `C:\Current` against
      // `c:\Current\new.txt`), so identity comparisons must not treat the
      // spellings as different files. Later path components keep their
      // case-sensitive spelling.
      const driveService = new WindowsReader(
        'fh-drive-case',
        true,
        'C:\\Current',
      );
      const survivor: FileHistorySnapshot = {
        promptId: 'p1',
        cwd: 'C:\\Current',
        timestamp: new Date('2026-06-13T00:00:00.000Z'),
        trackedFileBackups: {},
      };
      const discarded: FileHistorySnapshot = {
        promptId: 'p2',
        cwd: 'C:\\Other',
        timestamp: new Date('2026-06-13T00:00:02.000Z'),
        trackedFileBackups: {
          // Lowercase-drive spelling of a file under the surviving root.
          'c:\\Current\\new.txt': {
            backupFileName: null,
            version: 1,
            backupTime: new Date('2026-06-13T00:00:01.000Z'),
          },
          // The discarded checkpoint's own files — droppable regardless of
          // drive-letter spelling.
          'own.txt': {
            backupFileName: 'deadfeed012345678@v1',
            version: 1,
            backupTime: new Date('2026-06-13T00:00:01.000Z'),
          },
          'c:\\Other\\abs.txt': {
            backupFileName: 'deadfeed012345679@v1',
            version: 1,
            backupTime: new Date('2026-06-13T00:00:01.000Z'),
          },
        },
      };
      driveService.restoreFromSnapshots([survivor, discarded]);
      const [p1, p2] = driveService.getSnapshots();

      // The lowercase-drive capture is required and reported under the
      // folded spelling; the own-root records stay droppable.
      expect(driveService.getUnrestorableDiscardedCaptures([p2], [p1])).toEqual(
        ['C:\\Current\\new.txt'],
      );
      // A cwd label differing only by drive-letter case is the same
      // directory, not a foreign root.
      expect(
        driveService.getForeignSnapshotCwds([{ ...p1, cwd: 'c:\\Current' }]),
      ).toEqual([]);
    });

    it('reports a required baseline under both the discarded and the current root', () => {
      // R14 blocking: the own-root exemption assumed a discarded
      // checkpoint's own files can never be restore targets of the
      // current root. Nested roots overlap, so the assumption fails: p1
      // was captured empty in /project/A, the session then ran from
      // /project, where p2 first-tracked A/new.txt before it existed
      // (confirmed-null v1), and the session returned to /project/A.
      // Discarding p2 would drop the only proof the file did not exist in
      // p1's era, so the rewind must refuse instead of reporting an empty
      // success while leaving a later-created file in place.
      const projectRoot = join(tmpdir(), 'fh-nested-project');
      const dirA = join(projectRoot, 'A');
      const nestedService = new FileHistoryService('fh-nested', true, dirA);
      const nestedP1: FileHistorySnapshot = {
        promptId: 'p1',
        cwd: dirA,
        timestamp: new Date('2026-11-17T00:00:00.000Z'),
        trackedFileBackups: {},
      };
      const parentCaptured: FileHistorySnapshot = {
        promptId: 'p2',
        cwd: projectRoot,
        timestamp: new Date('2026-11-17T00:00:02.000Z'),
        trackedFileBackups: {
          // Absolute spelling of A/new.txt as captured from /project: the
          // identity sits under p2's own root AND under the service cwd.
          [join(dirA, 'new.txt')]: {
            backupFileName: null,
            version: 1,
            backupTime: new Date('2026-11-17T00:00:01.000Z'),
          },
        },
      };
      nestedService.restoreFromSnapshots([nestedP1, parentCaptured]);
      const [nestedSurvivor, nestedDiscarded] = nestedService.getSnapshots();

      expect(
        nestedService.getUnrestorableDiscardedCaptures(
          [nestedDiscarded],
          [nestedSurvivor],
        ),
      ).toEqual([join(dirA, 'new.txt')]);

      // Filesystem-root extreme: a checkpoint captured under "/" owns
      // every POSIX path by prefix, so the own-root exemption alone would
      // swallow the whole timeline. Captures under the current root are
      // still this service's restore targets and stay required.
      const fsRootService = new FileHistoryService(
        'fh-nested-fsroot',
        true,
        dirA,
      );
      fsRootService.restoreFromSnapshots([
        nestedP1,
        { ...parentCaptured, cwd: '/' },
      ]);
      const [fsSurvivor, fsDiscarded] = fsRootService.getSnapshots();
      expect(
        fsRootService.getUnrestorableDiscardedCaptures(
          [fsDiscarded],
          [fsSurvivor],
        ),
      ).toEqual([join(dirA, 'new.txt')]);
    });

    it('counts only restorable records as surviving coverage', () => {
      // R14 medium: a surviving record covers an identity only when the
      // restore's own selection can use it. `applySnapshot` applies the
      // target checkpoint's confirmed tracked backup directly (any
      // version); every other identity needs a confirmed version-1 record
      // through the first-version fallback. A later-version diff-only
      // record — or a later-version record in a non-target checkpoint —
      // restores nothing, so it must not mark the discarded baseline
      // redundant.
      const dirB = join(tmpdir(), 'fh-coverage-b');
      const fileF = join(projectDir, 'f');
      const discardedForeign: FileHistorySnapshot = {
        promptId: 'p2',
        cwd: dirB,
        timestamp: new Date('2026-11-17T00:00:02.000Z'),
        trackedFileBackups: {
          [fileF]: {
            backupFileName: null,
            version: 1,
            backupTime: new Date('2026-11-17T00:00:01.000Z'),
          },
        },
      };

      // A confirmed-null v2 in the survivor's diffAfterBackups: the
      // fallback rejects it (version 2), so p2's null v1 stays the only
      // usable baseline and must be reported.
      const diffOnlySurvivor: FileHistorySnapshot = {
        promptId: 'p1',
        cwd: projectDir,
        timestamp: new Date('2026-11-17T00:00:00.000Z'),
        trackedFileBackups: {},
        diffAfterBackups: {
          [fileF]: {
            backupFileName: null,
            version: 2,
            backupTime: new Date('2026-11-17T00:00:00.000Z'),
          },
        },
      };
      service.restoreFromSnapshots([diffOnlySurvivor, discardedForeign]);
      expect(
        service.getUnrestorableDiscardedCaptures(
          service.getSnapshots().slice(1),
          service.getSnapshots().slice(0, 1),
        ),
      ).toEqual([fileF]);

      // A later-version tracked record in a NON-target survivor is
      // equally unusable: the empty target has nothing for the identity
      // and the fallback skips the v2 record.
      const laterVersionSurvivor: FileHistorySnapshot = {
        promptId: 'p0',
        cwd: projectDir,
        timestamp: new Date('2026-11-17T00:00:00.000Z'),
        trackedFileBackups: {
          [fileF]: {
            backupFileName: 'deadfeed012345678@v2',
            version: 2,
            backupTime: new Date('2026-11-17T00:00:00.000Z'),
          },
        },
      };
      const emptyTarget: FileHistorySnapshot = {
        promptId: 'p1',
        cwd: projectDir,
        timestamp: new Date('2026-11-17T00:00:01.000Z'),
        trackedFileBackups: {},
      };
      expect(
        service.getUnrestorableDiscardedCaptures(
          [discardedForeign],
          [laterVersionSurvivor, emptyTarget],
        ),
      ).toEqual([fileF]);

      // Contrast: the restore target's own confirmed tracked backup
      // applies directly whatever its version — no fallback needed — so
      // the discarded capture stays redundant and must not block.
      expect(
        service.getUnrestorableDiscardedCaptures(
          [discardedForeign],
          [laterVersionSurvivor],
        ),
      ).toEqual([]);
    });

    it('still folds same-directory and legacy deletions', () => {
      const otherDir = join(tmpdir(), 'fh-other-root');
      const sameDirSurvivor: FileHistorySnapshot = {
        ...restoredP1('a.txt', 'deadbeefcafebabe@v1'),
        promptId: 'p1',
        cwd: projectDir,
      };
      const sameDirDeleted: FileHistorySnapshot = {
        ...restoredP1('b.txt', 'deadfeed012345678@v1'),
        promptId: 'p2',
        // A truly non-canonical spelling (join would normalize '.'
        // away): the fold must survive on resolve() equality, not on
        // raw string equality.
        cwd: `${projectDir}${sep}`,
      };
      const legacySurvivor: FileHistorySnapshot = {
        ...restoredP1('c.txt', 'deadbeefcafebabe@v2'),
        promptId: 'p1',
      };
      const legacyDeleted: FileHistorySnapshot = {
        ...restoredP1('d.txt', 'deadfeed012345678@v2'),
        promptId: 'p2',
      };
      const foreignDeleted: FileHistorySnapshot = {
        ...restoredP1('e.txt', 'deadbeefcafebabe@v3'),
        promptId: 'p2',
        cwd: otherDir,
      };

      const [keptSame] = removeFileHistorySnapshots(
        [
          sameDirSurvivor,
          sameDirDeleted,
          {
            ...sameDirDeleted,
            promptId: 'p3',
            trackedFileBackups: {
              ...sameDirSurvivor.trackedFileBackups,
              ...sameDirDeleted.trackedFileBackups,
            },
          },
        ],
        new Set(['p2']),
      );
      expect(keptSame.diffAfterBackups).toEqual(
        sameDirDeleted.trackedFileBackups,
      );

      const [keptLegacy] = removeFileHistorySnapshots(
        [
          legacySurvivor,
          legacyDeleted,
          {
            ...legacyDeleted,
            promptId: 'p3',
            trackedFileBackups: {
              ...legacySurvivor.trackedFileBackups,
              ...legacyDeleted.trackedFileBackups,
            },
          },
        ],
        new Set(['p2']),
      );
      // Legacy (unlabeled) deleted data keeps folding as before.
      expect(keptLegacy.diffAfterBackups).toEqual(
        legacyDeleted.trackedFileBackups,
      );

      expect(() =>
        removeFileHistorySnapshots(
          [legacySurvivor, foreignDeleted],
          new Set(['p2']),
        ),
      ).toThrow(/capture directory/);
    });

    // R1-4: pin the fold guard's directory comparison itself. The spellings
    // genuinely differ as strings, so a mutation that compares cwd labels by
    // raw string equality (or drops the resolve() normalization) drops this
    // fold and fails here; resolve() must keep admitting equivalent roots.
    it('folds a deleted checkpoint whose cwd differs only by a trailing separator', () => {
      const survivor = (cwd: string): FileHistorySnapshot => ({
        ...restoredP1('a.txt', 'deadbeefcafebabe@v1'),
        promptId: 'p1',
        cwd,
      });
      const deleted = (cwd: string): FileHistorySnapshot => ({
        ...restoredP1('b.txt', 'deadfeed012345678@v1'),
        promptId: 'p2',
        cwd,
      });
      expect(deleted(`${projectDir}${sep}`).cwd).not.toBe(projectDir);

      // Survivor canonical, deleted with a trailing separator.
      const [kept] = removeFileHistorySnapshots(
        [
          survivor(projectDir),
          deleted(`${projectDir}${sep}`),
          {
            ...deleted(projectDir),
            promptId: 'p3',
            trackedFileBackups: {
              ...survivor(projectDir).trackedFileBackups,
              ...deleted(projectDir).trackedFileBackups,
            },
          },
        ],
        new Set(['p2']),
      );
      expect(kept.diffAfterBackups).toEqual(
        deleted(`${projectDir}${sep}`).trackedFileBackups,
      );

      // And the mirrored spelling: survivor carries the trailing separator.
      const [keptMirrored] = removeFileHistorySnapshots(
        [
          survivor(`${projectDir}${sep}`),
          deleted(projectDir),
          {
            ...deleted(projectDir),
            promptId: 'p3',
            trackedFileBackups: {
              ...survivor(projectDir).trackedFileBackups,
              ...deleted(projectDir).trackedFileBackups,
            },
          },
        ],
        new Set(['p2']),
      );
      expect(keptMirrored.diffAfterBackups).toEqual(
        deleted(projectDir).trackedFileBackups,
      );
    });

    it('refuses file rewind when any checkpoint in the timeline is foreign', async () => {
      const otherDir = join(tmpdir(), 'fh-other-root');
      const local: FileHistorySnapshot = {
        ...restoredP1('b.txt', 'deadfeed012345678@v1'),
        promptId: 'p2',
        cwd: projectDir,
      };
      service.restoreFromSnapshots([
        { ...restoredP1('a.txt', 'deadbeefcafebabe@v1'), cwd: otherDir },
        local,
      ]);

      expect(service.getForeignSnapshotCwds()).toEqual([otherDir]);
      // The target itself is local, but tracked paths and first-version
      // fallbacks still consume the earlier foreign checkpoint, so the whole
      // file rewind must be refused.
      await expect(service.rewind('p2', false)).rejects.toThrow(
        /different working directory/,
      );
    });

    // R1-9: callers that are about to apply only a slice of the timeline
    // (e.g. a survivor slice after truncation) must be able to preview just
    // that slice, while the default keeps checking the whole timeline.
    it('checks an explicitly provided snapshot collection without changing the default', async () => {
      const otherDir = join(tmpdir(), 'fh-other-root');
      service.restoreFromSnapshots([
        {
          ...restoredP1('a.txt', 'deadbeefcafebabe@v1'),
          promptId: 'p1',
          cwd: otherDir,
        },
        {
          ...restoredP1('b.txt', 'deadfeed012345678@v1'),
          promptId: 'p2',
          cwd: projectDir,
        },
      ]);
      const [foreign, local] = service.getSnapshots();

      // Default: every existing caller keeps the whole-timeline behavior.
      expect(service.getForeignSnapshotCwds()).toEqual([otherDir]);
      // Explicit collection: a purely local survivor slice previews as
      // restorable even though an earlier foreign checkpoint exists.
      expect(service.getForeignSnapshotCwds([local])).toEqual([]);
      // The explicit collection is not a blanket pass: including the
      // foreign checkpoint must still report its cwd.
      expect(service.getForeignSnapshotCwds([foreign, local])).toEqual([
        otherDir,
      ]);
      expect(service.getForeignSnapshotCwds([foreign])).toEqual([otherDir]);
    });

    // R1-16: rewind defaults to truncateHistory=true; when the cross-directory
    // guard refuses, the refusal must happen before any truncation, or the
    // timeline loses the very endpoints a later same-root session needs.
    // p3 sits after the target so a mutant that prunes on the refusal path
    // (or truncates before the guard) drops it and fails here.
    it('keeps every snapshot when a foreign rewind is refused with default truncation', async () => {
      const otherDir = join(tmpdir(), 'fh-other-root');
      service.restoreFromSnapshots([
        {
          ...restoredP1('a.txt', 'deadbeefcafebabe@v1'),
          promptId: 'p1',
          cwd: otherDir,
        },
        {
          ...restoredP1('b.txt', 'deadfeed012345678@v1'),
          promptId: 'p2',
          cwd: projectDir,
        },
        {
          ...restoredP1('c.txt', 'deadbeefcafebabe@v2'),
          promptId: 'p3',
          cwd: projectDir,
        },
      ]);

      // Default truncateHistory=true, target not last.
      await expect(service.rewind('p2')).rejects.toThrow(
        /different working directory/,
      );
      expect(
        service.getSnapshots().map((snapshot) => snapshot.promptId),
      ).toEqual(['p1', 'p2', 'p3']);
    });

    it('does not fold edits from another directory into a foreign-labeled snapshot', async () => {
      const otherDir = await mkdtemp(join(tmpdir(), 'fh-foreign-label-'));
      try {
        const svcA = new FileHistoryService('test-session', true, otherDir);
        await svcA.makeSnapshot('p1');

        // This service is rooted at projectDir but its last snapshot is
        // labeled with otherDir; a capture from here must not be folded
        // into it, or reloading that snapshot in otherDir would pass the
        // cross-directory guard with mixed-provenance content.
        service.restoreFromSnapshots(svcA.getSnapshots());
        const file = join(projectDir, 'local.txt');
        await writeFile(file, 'local');
        await service.trackEdit(file);
        expect(
          service.getSnapshots()[0].trackedFileBackups['local.txt'],
        ).toBeUndefined();

        // The next makeSnapshot opens a snapshot labeled with the current
        // directory and trackEdit captures normally again.
        await service.makeSnapshot('p2');
        expect(service.getSnapshots().at(-1)?.cwd).toBe(projectDir);
        await service.trackEdit(file);
        expect(
          service.getSnapshots().at(-1)!.trackedFileBackups['local.txt'],
        ).toBeDefined();
      } finally {
        await rm(otherDir, { recursive: true, force: true });
      }
    });

    it('refuses a cross-directory rewind instead of overwriting the new root', async () => {
      const dirA = await mkdtemp(join(tmpdir(), 'fh-root-a-'));
      const dirB = await mkdtemp(join(tmpdir(), 'fh-root-b-'));
      try {
        const fileA = join(dirA, 'file.txt');
        const fileB = join(dirB, 'file.txt');
        await writeFile(fileA, 'captured-in-a');
        await writeFile(fileB, 'unrelated-in-b');

        const svcA = new FileHistoryService('test-session', true, dirA);
        await svcA.makeSnapshot('p1');
        await svcA.trackEdit(fileA);
        const payload = svcA.getSnapshots().map(serializeSnapshot);

        const svcB = new FileHistoryService('test-session', true, dirB);
        svcB.restoreFromSnapshots(deserializeSnapshots(payload));

        expect(svcB.getSnapshots().map((s) => s.promptId)).toEqual(['p1']);
        await expect(svcB.rewind('p1', false)).rejects.toThrow(
          /different working directory/,
        );
        expect(await readFile(fileB, 'utf-8')).toBe('unrelated-in-b');
        // The refusal happens before any history truncation.
        expect(svcB.getSnapshots()).toHaveLength(1);
      } finally {
        await rm(dirA, { recursive: true, force: true });
        await rm(dirB, { recursive: true, force: true });
      }
    });

    it('still restores and rewinds legacy snapshots without a recorded cwd', async () => {
      const file = join(projectDir, 'legacy.txt');
      await writeFile(file, 'before');
      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, 'after');

      const legacy = { ...service.getSnapshots()[0] };
      delete legacy.cwd;

      const fresh = new FileHistoryService('test-session', true, projectDir);
      fresh.restoreFromSnapshots([legacy]);
      expect(fresh.getSnapshots()).toHaveLength(1);
      expect((await fresh.rewind('p1', false)).filesFailed).toEqual([]);
      expect(await readFile(file, 'utf-8')).toBe('before');
    });

    it('admits lexically equivalent cwd spellings', async () => {
      const file = join(projectDir, 'same.txt');
      await writeFile(file, 'before');
      await service.makeSnapshot('p1');
      await service.trackEdit(file);
      await writeFile(file, 'after');
      const captured = service.getSnapshots()[0];

      for (const spelling of [
        join(projectDir, 'sub', '..'),
        join(projectDir, '.'),
        `${projectDir}${sep}`,
      ]) {
        const fresh = new FileHistoryService('test-session', true, projectDir);
        fresh.restoreFromSnapshots([{ ...captured, cwd: spelling }]);
        expect((await fresh.rewind('p1', false)).filesFailed).toEqual([]);
      }
      expect(await readFile(file, 'utf-8')).toBe('before');
    });

    it('re-admits the checkpoint after the session moves back', async () => {
      const dirA = await mkdtemp(join(tmpdir(), 'fh-root-a-'));
      const dirB = await mkdtemp(join(tmpdir(), 'fh-root-b-'));
      try {
        const fileA = join(dirA, 'file.txt');
        await writeFile(fileA, 'captured');
        const svcA = new FileHistoryService('test-session', true, dirA);
        await svcA.makeSnapshot('p1');
        await svcA.trackEdit(fileA);
        await writeFile(fileA, 'modified');
        const payload = svcA.getSnapshots().map(serializeSnapshot);

        const svcB = new FileHistoryService('test-session', true, dirB);
        svcB.restoreFromSnapshots(deserializeSnapshots(payload));
        await expect(svcB.rewind('p1', false)).rejects.toThrow(
          /different working directory/,
        );

        const backHome = new FileHistoryService('test-session', true, dirA);
        backHome.restoreFromSnapshots(deserializeSnapshots(payload));
        expect((await backHome.rewind('p1', false)).filesFailed).toEqual([]);
        expect(await readFile(fileA, 'utf-8')).toBe('captured');
      } finally {
        await rm(dirA, { recursive: true, force: true });
        await rm(dirB, { recursive: true, force: true });
      }
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

    it('should return undefined for a timeline holding foreign-cwd checkpoints', async () => {
      const dirA = await mkdtemp(join(tmpdir(), 'fh-preview-a-'));
      const dirB = await mkdtemp(join(tmpdir(), 'fh-preview-b-'));
      try {
        const fileA = join(dirA, 'file.txt');
        await writeFile(fileA, 'line1\n');
        const svcA = new FileHistoryService('test-session', true, dirA);
        await svcA.makeSnapshot('p1');
        await svcA.trackEdit(fileA);
        await writeFile(fileA, 'line1\nline2\n');

        // Same root: the preview still describes the restorable diff.
        expect(await svcA.getDiffStats('p1')).toBeDefined();

        // After a relocation the timeline is foreign: rewind would refuse,
        // so a diff expanded against the new root would be misleading.
        const svcB = new FileHistoryService('test-session', true, dirB);
        svcB.restoreFromSnapshots(svcA.getSnapshots());
        expect(await svcB.getDiffStats('p1')).toBeUndefined();
      } finally {
        await rm(dirA, { recursive: true, force: true });
        await rm(dirB, { recursive: true, force: true });
      }
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

    // R1-10: for the most recent turn the "after" endpoint is the live
    // worktree of the CURRENT root. On a foreign timeline that would
    // fabricate hunks rewind can never apply (getDiffStats already hides
    // the preview for the same reason), so the turn diff must be hidden
    // too instead of showing a misleading diff.
    it('returns undefined for a timeline holding foreign-cwd checkpoints', async () => {
      const dirA = await mkdtemp(join(tmpdir(), 'fh-turndiff-a-'));
      const dirB = await mkdtemp(join(tmpdir(), 'fh-turndiff-b-'));
      try {
        const fileA = join(dirA, 'file.txt');
        const fileB = join(dirB, 'file.txt');
        await writeFile(fileA, 'line1\n');
        await writeFile(fileB, 'unrelated-in-b');
        const svcA = new FileHistoryService('test-session', true, dirA);
        await svcA.makeSnapshot('p1');
        await svcA.trackEdit(fileA);
        await writeFile(fileA, 'line1\nline2\n');

        // Same root: the live-worktree endpoint is real, the diff is shown.
        expect(await svcA.getTurnDiff('p1')).toBeDefined();

        // Relocated to dirB, p1 is the latest turn: without the guard the
        // diff would compare A's backup against dirB/file.txt and attribute
        // B's unrelated content to the captured turn.
        const svcB = new FileHistoryService('test-session', true, dirB);
        svcB.restoreFromSnapshots(svcA.getSnapshots());
        expect(await svcB.getDiffStats('p1')).toBeUndefined();
        expect(await svcB.getTurnDiff('p1')).toBeUndefined();
        expect(await readFile(fileB, 'utf8')).toBe('unrelated-in-b');
      } finally {
        await rm(dirA, { recursive: true, force: true });
        await rm(dirB, { recursive: true, force: true });
      }
    });

    it('keeps diff and restore data across refused deletion, restart and new turns', async () => {
      const file = await trackAndEdit('a.txt', 'zero\n', 'A\n');
      const created = at('created-in-b.txt');
      await service.trackEdit(created);
      await writeFile(created, 'created in deleted B');
      await writeFile(file, 'B\n');
      await service.makeSnapshot('p3');
      await writeFile(file, 'C\n');
      const original = await service.getTurnDiff('p1');
      expect(original?.files).toHaveLength(1);
      expect(original?.files[0]?.hunks.flatMap((hunk) => hunk.lines)).toContain(
        '+A',
      );
      const beforeFirstDeletion = JSON.stringify(
        service.getSnapshots().map(serializeSnapshot),
      );
      expect(() =>
        removeFileHistorySnapshots(service.getSnapshots(), new Set(['p2'])),
      ).toThrow(/recovery evidence/);
      expect(
        JSON.stringify(service.getSnapshots().map(serializeSnapshot)),
      ).toBe(beforeFirstDeletion);
      expect(service.getSnapshots().map((item) => item.promptId)).toEqual([
        'p1',
        'p2',
        'p3',
      ]);
      expect(await service.getTurnDiff('p1')).toEqual(original);
      const persisted = service.getSnapshots().map(serializeSnapshot);
      service.restoreFromSnapshots(deserializeSnapshots(persisted));
      expect(await service.getTurnDiff('p1')).toEqual(original);
      const beforeSecondDeletion = JSON.stringify(
        service.getSnapshots().map(serializeSnapshot),
      );
      expect(() =>
        removeFileHistorySnapshots(service.getSnapshots(), new Set(['p3'])),
      ).toThrow(/recovery evidence/);
      expect(
        JSON.stringify(service.getSnapshots().map(serializeSnapshot)),
      ).toBe(beforeSecondDeletion);
      const restoredOnlyA = new FileHistoryService(
        'test-session',
        true,
        projectDir,
      );
      restoredOnlyA.restoreFromSnapshots(
        deserializeSnapshots(service.getSnapshots().map(serializeSnapshot)),
      );
      await restoredOnlyA.rewind('p1', false);
      expect(existsSync(created)).toBe(false);
      await writeFile(created, 'created again');
      await restoredOnlyA.rewind('p1', false);
      expect(existsSync(created)).toBe(false);
      await writeFile(created, 'created again');
      await writeFile(file, 'new turn\n');
      await service.makeSnapshot('p4');
      await service.trackEdit(created);
      expect(await service.getTurnDiff('p1')).toEqual(original);
      await service.rewind('p1', false);
      expect(await readFile(file, 'utf8')).toBe('zero\n');
      expect(existsSync(created)).toBe(false);
      expect(await service.getTurnDiff('p1')).toEqual(original);
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
