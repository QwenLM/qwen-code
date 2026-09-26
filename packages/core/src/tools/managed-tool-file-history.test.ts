/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileHistoryService,
  type SerializedFileHistorySnapshot,
} from '../services/fileHistoryService.js';
import { ManagedToolFileHistory } from './managed-tool-file-history.js';
import { managedToolDigest } from './managed-tool-protocol.js';

const storageDir = vi.hoisted(() => vi.fn());
vi.mock('../config/storage.js', () => ({
  Storage: { getGlobalQwenDir: storageDir },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ownerSessionId = '1e4a1b6a-9a0f-47e4-aef6-6ce937ac0988';

describe('ManagedToolFileHistory', () => {
  let cwd: string;
  let backupRoot: string;
  let owner: ManagedToolFileHistory;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'managed-history-workspace-'));
    backupRoot = await mkdtemp(join(tmpdir(), 'managed-history-backups-'));
    storageDir.mockReturnValue(backupRoot);
    owner = new ManagedToolFileHistory(ownerSessionId, cwd, []);
    await owner.ready();
  });

  afterEach(async () => {
    await owner.drain();
    await rm(cwd, { recursive: true, force: true });
    await rm(backupRoot, { recursive: true, force: true });
  });

  it('records empty parent checkpoints, deduplicates the last one and refuses older turns', async () => {
    expect(owner.state()).toEqual({
      ownerSessionId,
      revision: 0,
      snapshots: [],
    });
    await Promise.all([
      owner.checkpoint('parent-1'),
      owner.checkpoint('parent-1'),
    ]);
    expect(owner.state()).toMatchObject({
      revision: 1,
      snapshots: [{ promptId: 'parent-1', trackedFileBackups: {} }],
    });
    await owner.checkpoint('parent-2');
    await expect(owner.checkpoint('parent-1')).rejects.toThrow('earlier turn');
    expect(owner.state().revision).toBe(2);
    expect(() => managedToolDigest(owner.state())).not.toThrow();
  });

  it('orders real writes and parent checkpoints around the same shared backup owner', async () => {
    const filePath = join(cwd, 'shared.txt');
    await writeFile(filePath, 'zero');
    await owner.checkpoint('parent-1');
    const entered = deferred();
    const finishWrite = deferred();
    const first = owner.run(async () => {
      await owner.service.trackEdit(filePath);
      entered.resolve();
      await finishWrite.promise;
      await writeFile(filePath, 'one');
    });
    await entered.promise;
    const checkpoint = owner.checkpoint('parent-2');
    let secondStarted = false;
    const second = owner.run(async () => {
      secondStarted = true;
      await owner.service.trackEdit(filePath);
      await writeFile(filePath, 'two');
    });
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    expect(owner.state().snapshots).toHaveLength(1);
    finishWrite.resolve();
    await Promise.all([first, checkpoint, second]);

    const state = owner.state();
    expect(state.snapshots.map(({ promptId }) => promptId)).toEqual([
      'parent-1',
      'parent-2',
    ]);
    const backups = state.snapshots.map(
      (snapshot) => snapshot.trackedFileBackups['shared.txt'],
    );
    expect(backups.map(({ version }) => version)).toEqual([1, 2]);
    for (const [index, backup] of backups.entries()) {
      expect(
        await readFile(
          join(
            backupRoot,
            'file-history',
            ownerSessionId,
            backup.backupFileName!,
          ),
          'utf8',
        ),
      ).toBe(index === 0 ? 'zero' : 'one');
    }
    expect(await readFile(filePath, 'utf8')).toBe('two');
    expect(() => managedToolDigest(state)).not.toThrow();
    expect(backups.every((backup) => !Object.hasOwn(backup, 'failed'))).toBe(
      true,
    );
  });

  it('captures callback changes synchronously and isolates returned state', async () => {
    const filePath = join(cwd, 'a.txt');
    await writeFile(filePath, 'before');
    await owner.checkpoint('parent-1');
    await owner.run(async () => {
      await owner.service.trackEdit(filePath);
      const state = owner.state();
      expect(state.revision).toBe(2);
      state.snapshots[0].trackedFileBackups['a.txt'].version = 999;
      state.snapshots.length = 0;
      expect(
        owner.state().snapshots[0].trackedFileBackups['a.txt'].version,
      ).toBe(1);
    });
    expect(owner.state().revision).toBe(2);
  });

  it('restores real durable backups and captures rewind without a recorder callback', async () => {
    const filePath = join(cwd, 'a.txt');
    await writeFile(filePath, 'before');
    await owner.checkpoint('parent-1');
    await owner.run(async () => {
      await owner.service.trackEdit(filePath);
      await writeFile(filePath, 'after');
    });
    await owner.checkpoint('parent-2');
    const stored = owner.state().snapshots;
    const restored = new ManagedToolFileHistory(ownerSessionId, cwd, stored);
    await restored.ready();
    stored[0].trackedFileBackups['a.txt'].version = 999;
    expect(
      restored.state().snapshots[0].trackedFileBackups['a.txt'].version,
    ).toBe(1);
    expect(
      await restored.run(() => restored.service.rewind('parent-1')),
    ).toEqual({
      filesChanged: [filePath],
      filesFailed: [],
    });
    expect(await readFile(filePath, 'utf8')).toBe('before');
    expect(restored.state()).toMatchObject({
      revision: 1,
      snapshots: [{ promptId: 'parent-1' }],
    });
    await expect(restored.checkpoint('parent-2')).rejects.toThrow(
      'earlier turn',
    );
  });

  it('waits for restore validation and publishes missing-backup failures as JSON', async () => {
    const snapshots: SerializedFileHistorySnapshot[] = [
      {
        promptId: 'parent-1',
        timestamp: new Date().toISOString(),
        trackedFileBackups: {
          'missing.txt': {
            backupFileName: 'missing@v1',
            version: 1,
            backupTime: new Date().toISOString(),
            failed: undefined,
          },
        },
      },
    ];
    const restored = new ManagedToolFileHistory(ownerSessionId, cwd, snapshots);
    await restored.run(async () => {
      expect(
        restored.state().snapshots[0].trackedFileBackups['missing.txt'].failed,
      ).toBe(true);
    });
    expect(restored.state().revision).toBe(1);
    expect(() => managedToolDigest(restored.state())).not.toThrow();
    expect(
      snapshots[0].trackedFileBackups['missing.txt'].failed,
    ).toBeUndefined();
  });

  it('preserves parent-relative and outside-parent path attribution', async () => {
    const filePath = join(backupRoot, 'outside.txt');
    await writeFile(filePath, 'outside');
    await owner.checkpoint('parent-1');
    await owner.run(() => owner.service.trackEdit(filePath));
    expect(Object.keys(owner.state().snapshots[0].trackedFileBackups)).toEqual([
      filePath,
    ]);
  });

  it('drains queued work and keeps admitting operations after an execution error', async () => {
    const entered = deferred();
    const finish = deferred();
    const failed = owner.run(async () => {
      entered.resolve();
      await finish.promise;
      throw new Error('execution failed');
    });
    const observed = failed.catch((error: unknown) => error);
    await entered.promise;
    const next = owner.checkpoint('parent-1');
    let drained = false;
    const drain = owner.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish.resolve();
    expect(await observed).toMatchObject({ message: 'execution failed' });
    await Promise.all([next, drain]);
    expect(drained).toBe(true);
    expect(owner.state().snapshots).toHaveLength(1);
  });

  it('rejects non-JSON numeric backup versions before restore', () => {
    expect(
      () =>
        new ManagedToolFileHistory(ownerSessionId, cwd, [
          {
            promptId: 'parent-1',
            timestamp: new Date().toISOString(),
            trackedFileBackups: {
              'a.txt': {
                backupFileName: null,
                version: Infinity,
                backupTime: '',
              },
            },
          },
        ]),
    ).toThrow('backup version');
  });

  it('does not run tools or report a successful drain after initialization fails', async () => {
    const failure = new Error('restore validation failed');
    const validate = vi
      .spyOn(FileHistoryService.prototype, 'validateRestoredSnapshots')
      .mockRejectedValueOnce(failure);
    try {
      const failed = new ManagedToolFileHistory(ownerSessionId, cwd, []);
      const operation = vi.fn(async () => {});
      await expect(failed.ready()).rejects.toBe(failure);
      await expect(failed.run(operation)).rejects.toBe(failure);
      await expect(failed.run(operation)).rejects.toBe(failure);
      await expect(failed.drain()).rejects.toBe(failure);
      expect(operation).not.toHaveBeenCalled();
    } finally {
      validate.mockRestore();
    }
  });
});
