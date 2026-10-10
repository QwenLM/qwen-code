/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DescriptorFileReadSource } from '../utils/file-read-source.js';
import { Storage } from '../config/storage.js';
import { MAX_DIFF_SIZE_BYTES } from '../utils/gitDiff.js';
import {
  FileHistoryService,
  type FileHistorySnapshot,
  type RetainedFileHistoryStorage,
} from './fileHistoryService.js';

const backup = (name: string | null, failed = false) => ({
  backupFileName: name,
  version: 1,
  backupTime: new Date(0),
  ...(failed ? { failed } : {}),
});
const snapshot = (
  promptId: string,
  entries: Record<string, ReturnType<typeof backup>>,
): FileHistorySnapshot => ({
  promptId,
  trackedFileBackups: entries,
  timestamp: new Date(0),
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('retained history finite consumers', () => {
  let directory: string;
  let storage: RetainedFileHistoryStorage;
  let service: FileHistoryService;
  beforeEach(async () => {
    directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'retained-history-consumer-')),
    );
    const withFile = async <T>(
      file: string,
      operation: (source: DescriptorFileReadSource | null) => Promise<T>,
    ): Promise<T> => {
      let handle;
      try {
        handle = await fs.open(file, 'r');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return operation(null);
      }
      try {
        return await operation({
          kind: 'descriptor',
          fileHandle: handle,
          stats: await handle.stat(),
        });
      } finally {
        await handle.close();
      }
    };
    const withBackupFile = <T>(
      name: string,
      operation: (source: DescriptorFileReadSource) => Promise<T>,
    ) =>
      withFile(path.join(directory, `backup-${name}`), async (source) => {
        if (!source) throw new Error('Original backup unavailable.');
        return operation(source);
      });
    storage = {
      withWorkingFile: withFile,
      withBackupFile,
      createBackup: vi.fn(async (file, version) => {
        const name = randomUUID();
        try {
          await fs.copyFile(file, path.join(directory, `backup-${name}`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return { backupFileName: null, version, backupTime: new Date(0) };
        }
        return { backupFileName: name, version, backupTime: new Date(0) };
      }),
    };
    vi.spyOn(storage, 'withWorkingFile');
    vi.spyOn(storage, 'withBackupFile');
    service = new FileHistoryService(
      'owner',
      true,
      directory,
      undefined,
      storage,
    );
    vi.spyOn(Storage, 'getGlobalQwenDir').mockImplementation(() => {
      throw new Error('Legacy home path must not be used.');
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('routes track, validation, unchanged reuse and both diff consumers through retained endpoints', async () => {
    const file = path.join(directory, 'a');
    await fs.writeFile(file, 'one\n');
    await service.makeSnapshot('first');
    await service.trackEdit(file);
    const first = structuredClone(service.getSnapshots()[0]);
    await service.validateRestoredSnapshots();
    await service.makeSnapshot('second');
    expect(storage.createBackup).toHaveBeenCalledTimes(1);
    expect(service.getSnapshots()[1].trackedFileBackups['a']).toEqual(
      first.trackedFileBackups['a'],
    );
    expect(await service.getTurnDiff('first')).toMatchObject({ files: [] });
    await fs.writeFile(file, 'two\n');
    expect(await service.getDiffStats('second')).toMatchObject({
      filesChanged: [file],
      insertions: 1,
      deletions: 1,
    });
    expect(await service.getTurnDiff('second')).toMatchObject({
      stats: { filesChanged: 1, linesAdded: 1, linesRemoved: 1 },
    });
    expect(storage.withWorkingFile).toHaveBeenCalled();
    expect(storage.withBackupFile).toHaveBeenCalled();
    expect(Storage.getGlobalQwenDir).not.toHaveBeenCalled();
  });

  it('keeps genuine absence separate from unavailable non-null backup', async () => {
    service.restoreFromSnapshots([snapshot('absent', { a: backup(null) })]);
    expect(await service.getDiffStats('absent')).toMatchObject({
      filesChanged: [],
    });
    await fs.writeFile(path.join(directory, 'a'), 'created\n');
    expect(await service.getTurnDiff('absent')).toMatchObject({
      files: [expect.objectContaining({ isNewFile: true })],
    });
    service.restoreFromSnapshots([snapshot('bad', { a: backup('lost') })]);
    await expect(service.validateRestoredSnapshots()).rejects.toThrow();
    await expect(service.getDiffStats('bad')).rejects.toThrow();
    await expect(service.getTurnDiff('bad')).rejects.toThrow();
    expect(
      service.getSnapshots()[0].trackedFileBackups['a'].failed,
    ).toBeUndefined();
  });

  it('authenticates equal backup pointers instead of skipping their integrity check', async () => {
    service.restoreFromSnapshots([
      snapshot('first', { a: backup('same') }),
      snapshot('second', { a: backup('same') }),
    ]);
    await expect(service.getTurnDiff('first')).rejects.toThrow();
    expect(storage.withBackupFile).toHaveBeenCalledWith(
      'same',
      expect.any(Function),
    );
  });

  it.each(['validate', 'track', 'snapshot', 'stats', 'diff'])(
    'propagates a failed backup for %s without healing it',
    async (operation) => {
      service.restoreFromSnapshots([
        snapshot('first', { a: backup('old', true) }),
      ]);
      const action =
        operation === 'validate'
          ? () => service.validateRestoredSnapshots()
          : operation === 'track'
            ? () => service.trackEdit(path.join(directory, 'a'))
            : operation === 'snapshot'
              ? () => service.makeSnapshot('second')
              : operation === 'stats'
                ? () => service.getDiffStats('first')
                : () => service.getTurnDiff('first');
      await expect(action()).rejects.toThrow();
      expect(storage.createBackup).not.toHaveBeenCalled();
      expect(service.getSnapshots()).toHaveLength(1);
      expect(service.getSnapshots()[0].trackedFileBackups['a'].failed).toBe(
        true,
      );
    },
  );

  it('joins every started validation before returning one failed member', async () => {
    const started = deferred();
    const release = deferred();
    storage.withBackupFile = vi.fn(async (name) => {
      if (name === 'bad') throw new Error('bad pin');
      started.resolve();
      await release.promise;
      throw new Error('waiting pin failure');
    });
    service.restoreFromSnapshots([
      snapshot('first', { a: backup('bad'), b: backup('waiting') }),
    ]);
    let settled = false;
    const validation = service.validateRestoredSnapshots().finally(() => {
      settled = true;
    });
    void validation.catch(() => {});
    await started.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    await expect(validation).rejects.toThrow();
    expect(
      service.getSnapshots()[0].trackedFileBackups['a'].failed,
    ).toBeUndefined();
  });

  it('refuses snapshot overflow, unprepared tracking and disabled rewind before storage I/O', async () => {
    await expect(service.trackEdit(path.join(directory, 'a'))).rejects.toThrow(
      'requires a current snapshot',
    );
    const capacity = Array.from({ length: 100 }, (_, index) =>
      snapshot(String(index), {}),
    );
    service.restoreFromSnapshots(capacity);
    await expect(service.makeSnapshot('overflow')).rejects.toThrow(
      'snapshot limit',
    );
    expect(() =>
      service.restoreFromSnapshots([...capacity, snapshot('overflow', {})]),
    ).toThrow('snapshot limit');
    const disabled = new FileHistoryService(
      'owner',
      false,
      directory,
      undefined,
      storage,
    );
    await expect(disabled.rewind('any')).rejects.toThrow('cannot rewind');
    expect(storage.withWorkingFile).not.toHaveBeenCalled();
    expect(storage.withBackupFile).not.toHaveBeenCalled();
    expect(storage.createBackup).not.toHaveBeenCalled();
    expect(service.getSnapshots()).toHaveLength(100);
  });

  it('keeps bounded turn-diff behavior and refuses unbounded retained stats', async () => {
    const file = path.join(directory, 'a');
    await fs.writeFile(file, Buffer.alloc(MAX_DIFF_SIZE_BYTES + 1, 97));
    service.restoreFromSnapshots([snapshot('first', { a: backup(null) })]);
    expect(await service.getTurnDiff('first')).toMatchObject({
      files: [expect.objectContaining({ oversized: true, hunks: [] })],
    });
    await expect(service.getDiffStats('first')).rejects.toThrow();
  });
});
