/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimBoardTask,
  completeBoardTask,
  createBoardTask,
  listBoardTasks,
  pruneBoardTasks,
} from './board-tasks.js';
import { getCollectionDir } from './board-lock.js';

vi.mock('../../config/storage.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../config/storage.js')>();
  let globalDir = '';
  return {
    ...original,
    Storage: {
      ...original.Storage,
      getGlobalQwenDir: () => globalDir,
      __setMockGlobalDir: (dir: string) => {
        globalDir = dir;
      },
    },
  };
});

import { Storage } from '../../config/storage.js';

function setGlobalDir(dir: string): void {
  (
    Storage as unknown as { __setMockGlobalDir: (value: string) => void }
  ).__setMockGlobalDir(dir);
}

describe('board tasks', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'board-tasks-'));
    setGlobalDir(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates collision-resistant ids concurrently', async () => {
    const tasks = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        createBoardTask({
          board: 'demo',
          createdBy: 'author',
          subject: `task ${index}`,
        }),
      ),
    );
    expect(new Set(tasks.map((task) => task.id)).size).toBe(40);
    expect(tasks.every((task) => /^t-[0-9a-f-]{36}$/.test(task.id))).toBe(true);
  });

  it('requires ownership before completion', async () => {
    const task = await createBoardTask({
      board: 'demo',
      createdBy: 'author',
      subject: 'check api',
    });
    await expect(completeBoardTask('demo', task.id, 'other')).rejects.toThrow(
      'not in progress',
    );
    await claimBoardTask('demo', task.id, 'worker');
    const completed = await completeBoardTask(
      'demo',
      task.id,
      'worker',
      'done',
    );
    expect(completed.status).toBe('completed');
    expect(completed.notes).toEqual(['done']);
  });

  it('gives a contended task to exactly one concurrent claimant', async () => {
    const task = await createBoardTask({
      board: 'demo',
      createdBy: 'author',
      subject: 'contended',
    });
    // Every claimant races for the same pending task. Without the
    // `already claimed by` guard each serialized writer re-reads an
    // in_progress record and overwrites its owner, so all eight "win" and the
    // board hands the same work to eight agents.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        claimBoardTask('demo', task.id, `worker-${index}`),
      ),
    );
    const winners = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const rejections = results.flatMap((result) =>
      result.status === 'rejected' ? [String(result.reason)] : [],
    );
    expect(winners).toHaveLength(1);
    expect(rejections).toHaveLength(7);
    expect(
      rejections.every((reason) => reason.includes('already claimed by')),
    ).toBe(true);
    await expect(listBoardTasks('demo')).resolves.toMatchObject([
      { id: task.id, status: 'in_progress', owner: winners[0]?.owner },
    ]);
  });

  it('lists every record on a board larger than one read batch', async () => {
    // `listBoardTasks` reads in bounded batches so a large board cannot exhaust
    // the process fd budget; a batch loop that drops or double-counts a slice
    // shows up here as a short listing.
    const total = 70;
    const created = await Promise.all(
      Array.from({ length: total }, (_, index) =>
        createBoardTask({
          board: 'demo',
          createdBy: 'author',
          subject: `task ${index}`,
        }),
      ),
    );
    const listed = await listBoardTasks('demo');
    expect(listed).toHaveLength(total);
    expect(new Set(listed.map((task) => task.id)).size).toBe(total);
    expect(new Set(created.map((task) => task.id)).size).toBe(total);
    for (const task of created) {
      expect(listed.map((entry) => entry.id)).toContain(task.id);
    }
  });

  it('treats board names that differ only by case as one board', async () => {
    // APFS and NTFS fold case, ext4 does not, so the storage layer folds it
    // itself: the same board name has to mean the same board everywhere.
    const task = await createBoardTask({
      board: 'Sprint',
      createdBy: 'author',
      subject: 'shared',
    });
    await expect(listBoardTasks('sprint')).resolves.toMatchObject([
      { id: task.id },
    ]);
    await expect(
      claimBoardTask('sprint', task.id, 'worker'),
    ).resolves.toMatchObject({ owner: 'worker' });
    await expect(listBoardTasks('SPRINT')).resolves.toMatchObject([
      { owner: 'worker' },
    ]);
    const boardsRoot = path.resolve(
      getCollectionDir('Sprint', 'tasks'),
      '..',
      '..',
    );
    await expect(fs.readdir(boardsRoot)).resolves.toEqual(['sprint']);
  });

  it('skips a malformed foreign record without hiding healthy work', async () => {
    await createBoardTask({
      board: 'demo',
      createdBy: 'author',
      subject: 'healthy',
    });
    const malformedId = 't-00000000-0000-4000-8000-000000000000';
    const malformedPath = path.join(
      getCollectionDir('demo', 'tasks'),
      `${malformedId}.json`,
    );
    await fs.writeFile(malformedPath, '{broken');
    // A valid UUIDv4 filename so this record reaches content validation
    // (all-zero names are rejected by the filename filter before parsing).
    await fs.writeFile(
      path.join(
        getCollectionDir('demo', 'tasks'),
        't-00000000-0000-4000-8000-000000000001.json',
      ),
      '{}',
    );
    await expect(listBoardTasks('demo')).resolves.toMatchObject([
      { subject: 'healthy' },
    ]);
    await expect(claimBoardTask('demo', malformedId, 'worker')).rejects.toThrow(
      'JSON',
    );
    await expect(fs.readFile(malformedPath, 'utf8')).resolves.toBe('{broken');
  });

  it('rejects empty owners and records whose id does not match the filename', async () => {
    await expect(
      createBoardTask({
        board: 'demo',
        createdBy: 'author',
        subject: 'empty owner',
        owner: '',
      }),
    ).rejects.toThrow('Invalid actor name');

    const first = await createBoardTask({
      board: 'demo',
      createdBy: 'author',
      subject: 'first',
    });
    const second = await createBoardTask({
      board: 'demo',
      createdBy: 'author',
      subject: 'second',
    });
    const firstPath = path.join(
      getCollectionDir('demo', 'tasks'),
      `${first.id}.json`,
    );
    await fs.writeFile(firstPath, JSON.stringify({ ...first, id: second.id }));
    await expect(listBoardTasks('demo')).resolves.toMatchObject([
      { subject: 'second' },
    ]);
    await expect(claimBoardTask('demo', first.id, 'worker')).rejects.toThrow(
      'does not match its filename',
    );
    await expect(fs.readFile(firstPath, 'utf8')).resolves.toContain(second.id);
  });

  it('creates private directories and files', async () => {
    const task = await createBoardTask({
      board: 'demo',
      createdBy: 'author',
      subject: 'private',
    });
    if (process.platform === 'win32') return;
    const dir = getCollectionDir('demo', 'tasks');
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect(
      (await fs.stat(path.join(dir, `${task.id}.json`))).mode & 0o777,
    ).toBe(0o600);
  });

  it('rejects unsafe board directory names', async () => {
    for (const board of ['../escape', 'con', 'trailing.']) {
      await expect(
        createBoardTask({ board, createdBy: 'author', subject: 'unsafe' }),
      ).rejects.toThrow('Invalid board name');
    }
  });

  it('prunes only completed tasks, keyed on updatedAt', async () => {
    const done = await createBoardTask({
      board: 'demo',
      createdBy: 'author',
      subject: 'done',
    });
    const pending = await createBoardTask({
      board: 'demo',
      createdBy: 'author',
      subject: 'pending',
    });
    const claimed = await createBoardTask({
      board: 'demo',
      createdBy: 'author',
      subject: 'claimed',
    });
    await claimBoardTask('demo', done.id, 'worker');
    await completeBoardTask('demo', done.id, 'worker');
    await claimBoardTask('demo', claimed.id, 'worker');

    // Nothing is old enough yet.
    const completed = (await listBoardTasks('demo')).find(
      (task) => task.id === done.id,
    );
    expect(completed?.status).toBe('completed');
    await expect(pruneBoardTasks('demo', 60_000)).resolves.toEqual([]);

    // Past the window: only the completed task goes.
    await expect(
      pruneBoardTasks('demo', 0, (completed?.updatedAt ?? 0) + 1),
    ).resolves.toEqual([done.id]);
    const remaining = await listBoardTasks('demo');
    expect(remaining.map((task) => task.id).sort()).toEqual(
      [pending.id, claimed.id].sort(),
    );
  });
});
