/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTask,
  getTask,
  updateTask,
  deleteTask,
  listTasks,
  resetTaskList,
  blockTask,
  claimTask,
  unassignTeammateTasks,
  getAgentStatuses,
  onTasksUpdated,
  notifyTasksUpdated,
} from './tasks.js';

vi.mock('../../config/storage.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../config/storage.js')>();
  let mockGlobalDir = '';
  return {
    ...original,
    Storage: {
      ...original.Storage,
      getGlobalQwenDir: () => mockGlobalDir,
      __setMockGlobalDir: (dir: string) => {
        mockGlobalDir = dir;
      },
    },
  };
});

import { Storage } from '../../config/storage.js';

function setMockDir(dir: string): void {
  (
    Storage as unknown as {
      __setMockGlobalDir: (d: string) => void;
    }
  ).__setMockGlobalDir(dir);
}

describe('tasks', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-test-'));
    setMockDir(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── createTask ────────────────────────────────────────────

  describe('createTask', () => {
    it('creates a task with auto-incremented ID', async () => {
      const t1 = await createTask('team', {
        subject: 'First',
        description: 'First task',
      });
      expect(t1.id).toBe('1');
      expect(t1.subject).toBe('First');
      expect(t1.status).toBe('pending');
      expect(t1.blocks).toEqual([]);
      expect(t1.blockedBy).toEqual([]);

      const t2 = await createTask('team', {
        subject: 'Second',
        description: 'Second task',
      });
      expect(t2.id).toBe('2');
    });

    it('creates task with optional fields', async () => {
      const task = await createTask('team', {
        subject: 'Test',
        description: 'Test task',
        activeForm: 'Running tests',
        owner: 'worker@team',
        metadata: { priority: 'high' },
      });
      expect(task.activeForm).toBe('Running tests');
      expect(task.owner).toBe('worker@team');
      expect(task.metadata).toEqual({ priority: 'high' });
    });
  });

  // ─── getTask ───────────────────────────────────────────────

  describe('getTask', () => {
    it('reads a created task', async () => {
      const created = await createTask('team', {
        subject: 'Test',
        description: 'Desc',
      });
      const fetched = await getTask('team', created.id);
      expect(fetched).toEqual(created);
    });

    it('returns undefined for nonexistent task', async () => {
      expect(await getTask('team', '999')).toBeUndefined();
    });
  });

  // ─── updateTask ────────────────────────────────────────────

  describe('updateTask', () => {
    it('updates status and owner', async () => {
      const task = await createTask('team', {
        subject: 'Test',
        description: 'Desc',
      });
      const updated = await updateTask('team', task.id, {
        status: 'in_progress',
        owner: 'worker@team',
      });
      expect(updated!.status).toBe('in_progress');
      expect(updated!.owner).toBe('worker@team');
    });

    it('clears owner with null', async () => {
      const task = await createTask('team', {
        subject: 'Test',
        description: 'Desc',
        owner: 'worker@team',
      });
      const updated = await updateTask('team', task.id, {
        owner: null,
      });
      expect(updated!.owner).toBeUndefined();
    });

    it('updates subject and description', async () => {
      const task = await createTask('team', {
        subject: 'Old',
        description: 'Old desc',
      });
      const updated = await updateTask('team', task.id, {
        subject: 'New',
        description: 'New desc',
      });
      expect(updated!.subject).toBe('New');
      expect(updated!.description).toBe('New desc');
    });

    it('clears activeForm with null', async () => {
      const task = await createTask('team', {
        subject: 'Test',
        description: 'Desc',
        activeForm: 'Running',
      });
      const updated = await updateTask('team', task.id, {
        activeForm: null,
      });
      expect(updated!.activeForm).toBeUndefined();
    });

    it('merges metadata and removes null keys', async () => {
      const task = await createTask('team', {
        subject: 'Test',
        description: 'Desc',
        metadata: { a: 1, b: 2 },
      });
      const updated = await updateTask('team', task.id, {
        metadata: { b: null, c: 3 },
      });
      expect(updated!.metadata).toEqual({ a: 1, c: 3 });
    });

    it('removes metadata entirely if all keys deleted', async () => {
      const task = await createTask('team', {
        subject: 'Test',
        description: 'Desc',
        metadata: { a: 1 },
      });
      const updated = await updateTask('team', task.id, {
        metadata: { a: null },
      });
      expect(updated!.metadata).toBeUndefined();
    });

    it('adds block relationships', async () => {
      const task = await createTask('team', {
        subject: 'Test',
        description: 'Desc',
      });
      const updated = await updateTask('team', task.id, {
        addBlocks: ['2', '3'],
      });
      expect(updated!.blocks).toEqual(['2', '3']);
    });

    it('deduplicates block IDs', async () => {
      const task = await createTask('team', {
        subject: 'Test',
        description: 'Desc',
      });
      await updateTask('team', task.id, {
        addBlocks: ['2'],
      });
      const updated = await updateTask('team', task.id, {
        addBlocks: ['2', '3'],
      });
      expect(updated!.blocks).toEqual(['2', '3']);
    });

    it('returns undefined for nonexistent task', async () => {
      expect(
        await updateTask('team', '999', {
          status: 'completed',
        }),
      ).toBeUndefined();
    });
  });

  // ─── deleteTask ────────────────────────────────────────────

  describe('deleteTask', () => {
    it('deletes an existing task', async () => {
      const task = await createTask('team', {
        subject: 'Test',
        description: 'Desc',
      });
      expect(await deleteTask('team', task.id)).toBe(true);
      expect(await getTask('team', task.id)).toBeUndefined();
    });

    it('returns false for nonexistent task', async () => {
      expect(await deleteTask('team', '999')).toBe(false);
    });
  });

  // ─── listTasks ─────────────────────────────────────────────

  describe('listTasks', () => {
    it('lists all tasks sorted by ID', async () => {
      await createTask('team', {
        subject: 'Third',
        description: 'C',
      });
      await createTask('team', {
        subject: 'First',
        description: 'A',
      });

      const tasks = await listTasks('team');
      expect(tasks).toHaveLength(2);
      expect(tasks[0]!.id).toBe('1');
      expect(tasks[1]!.id).toBe('2');
    });

    it('filters by status', async () => {
      const t1 = await createTask('team', {
        subject: 'A',
        description: 'A',
      });
      await createTask('team', {
        subject: 'B',
        description: 'B',
      });
      await updateTask('team', t1.id, {
        status: 'in_progress',
      });

      const inProgress = await listTasks('team', {
        status: 'in_progress',
      });
      expect(inProgress).toHaveLength(1);
      expect(inProgress[0]!.subject).toBe('A');
    });

    it('filters by owner', async () => {
      await createTask('team', {
        subject: 'A',
        description: 'A',
        owner: 'alice',
      });
      await createTask('team', {
        subject: 'B',
        description: 'B',
        owner: 'bob',
      });

      const aliceTasks = await listTasks('team', {
        owner: 'alice',
      });
      expect(aliceTasks).toHaveLength(1);
      expect(aliceTasks[0]!.owner).toBe('alice');
    });

    it('returns empty for nonexistent team', async () => {
      expect(await listTasks('nope')).toEqual([]);
    });
  });

  // ─── resetTaskList ─────────────────────────────────────────

  describe('resetTaskList', () => {
    it('deletes all tasks', async () => {
      await createTask('team', {
        subject: 'A',
        description: 'A',
      });
      await createTask('team', {
        subject: 'B',
        description: 'B',
      });

      await resetTaskList('team');
      expect(await listTasks('team')).toEqual([]);
    });

    it('does not throw for nonexistent team', async () => {
      await expect(resetTaskList('nope')).resolves.not.toThrow();
    });
  });

  // ─── blockTask ─────────────────────────────────────────────

  describe('blockTask', () => {
    it('sets bidirectional block relationship', async () => {
      const t1 = await createTask('team', {
        subject: 'A',
        description: 'A',
      });
      const t2 = await createTask('team', {
        subject: 'B',
        description: 'B',
      });

      await blockTask('team', t1.id, t2.id);

      const a = await getTask('team', t1.id);
      const b = await getTask('team', t2.id);
      expect(a!.blocks).toContain(t2.id);
      expect(b!.blockedBy).toContain(t1.id);
    });
  });

  // ─── claimTask ─────────────────────────────────────────────

  describe('claimTask', () => {
    it('claims a pending task', async () => {
      const task = await createTask('team', {
        subject: 'Work',
        description: 'Do work',
      });

      const claimed = await claimTask('team', task.id, 'worker@team');
      expect(claimed!.owner).toBe('worker@team');
      expect(claimed!.status).toBe('in_progress');
    });

    it('returns undefined for already claimed task', async () => {
      const task = await createTask('team', {
        subject: 'Work',
        description: 'Do work',
      });
      await claimTask('team', task.id, 'alice');

      const result = await claimTask('team', task.id, 'bob');
      expect(result).toBeUndefined();
    });

    it('returns undefined for nonexistent task', async () => {
      expect(await claimTask('team', '999', 'worker')).toBeUndefined();
    });

    it('respects checkAgentBusy option', async () => {
      const t1 = await createTask('team', {
        subject: 'A',
        description: 'A',
      });
      const t2 = await createTask('team', {
        subject: 'B',
        description: 'B',
      });

      await claimTask('team', t1.id, 'worker');

      // Worker is busy — should fail with checkAgentBusy
      const result = await claimTask('team', t2.id, 'worker', {
        checkAgentBusy: true,
      });
      expect(result).toBeUndefined();

      // Without check — should succeed
      const result2 = await claimTask('team', t2.id, 'worker');
      expect(result2).toBeDefined();
    });
  });

  // ─── unassignTeammateTasks ─────────────────────────────────

  describe('unassignTeammateTasks', () => {
    it('resets in_progress tasks to pending', async () => {
      const t1 = await createTask('team', {
        subject: 'A',
        description: 'A',
      });
      const t2 = await createTask('team', {
        subject: 'B',
        description: 'B',
      });
      await claimTask('team', t1.id, 'worker');
      await claimTask('team', t2.id, 'worker');

      const count = await unassignTeammateTasks('team', 'worker');
      expect(count).toBe(2);

      const tasks = await listTasks('team');
      expect(tasks.every((t) => t.status === 'pending')).toBe(true);
      expect(tasks.every((t) => t.owner === undefined)).toBe(true);
    });

    it('does not affect completed tasks', async () => {
      const task = await createTask('team', {
        subject: 'A',
        description: 'A',
      });
      await claimTask('team', task.id, 'worker');
      await updateTask('team', task.id, {
        status: 'completed',
      });

      const count = await unassignTeammateTasks('team', 'worker');
      expect(count).toBe(0);
    });
  });

  // ─── getAgentStatuses ──────────────────────────────────────

  describe('getAgentStatuses', () => {
    it('returns per-agent task counts', async () => {
      const t1 = await createTask('team', {
        subject: 'A',
        description: 'A',
      });
      const t2 = await createTask('team', {
        subject: 'B',
        description: 'B',
      });
      await claimTask('team', t1.id, 'alice');
      await claimTask('team', t2.id, 'bob');
      await updateTask('team', t2.id, {
        status: 'completed',
      });

      const statuses = await getAgentStatuses('team');
      expect(statuses.get('alice')).toEqual({
        inProgress: 1,
        completed: 0,
      });
      expect(statuses.get('bob')).toEqual({
        inProgress: 0,
        completed: 1,
      });
    });
  });

  // ─── Pub/sub ───────────────────────────────────────────────

  describe('onTasksUpdated / notifyTasksUpdated', () => {
    it('listener receives team name on notify', () => {
      const calls: string[] = [];
      const unsubscribe = onTasksUpdated((name) => calls.push(name));

      notifyTasksUpdated('my-team');
      expect(calls).toEqual(['my-team']);

      unsubscribe();
      notifyTasksUpdated('my-team');
      expect(calls).toEqual(['my-team']); // no second call
    });

    it('createTask triggers notification', async () => {
      const calls: string[] = [];
      const unsubscribe = onTasksUpdated((name) => calls.push(name));

      await createTask('team', {
        subject: 'Test',
        description: 'D',
      });
      expect(calls).toEqual(['team']);

      unsubscribe();
    });
  });

  // ─── Concurrent claims ────────────────────────────────────

  describe('concurrent operations', () => {
    it('only one claimTask wins under concurrency', async () => {
      const task = await createTask('team', {
        subject: 'Race',
        description: 'Race condition test',
      });

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          claimTask('team', task.id, `worker-${i}`),
        ),
      );

      const winners = results.filter((r) => r !== undefined);
      expect(winners).toHaveLength(1);

      const final = await getTask('team', task.id);
      expect(final!.status).toBe('in_progress');
      expect(final!.owner).toBeDefined();
    });
  });
});
