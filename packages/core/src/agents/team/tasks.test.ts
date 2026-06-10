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
  TaskOwnershipError,
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

    it('rejects non-numeric task IDs to prevent path traversal', async () => {
      await expect(getTask('team', '../../etc/passwd')).rejects.toThrow(
        'Invalid task ID',
      );
      await expect(getTask('team', '../../settings')).rejects.toThrow(
        'Invalid task ID',
      );
      await expect(getTask('team', 'abc')).rejects.toThrow('Invalid task ID');
      await expect(getTask('team', '')).rejects.toThrow('Invalid task ID');
      await expect(getTask('team', '0')).rejects.toThrow('Invalid task ID');
    });

    it('rejects non-numeric task IDs from updateTask and deleteTask', async () => {
      await expect(
        updateTask('team', '../../oops', { status: 'completed' }),
      ).rejects.toThrow('Invalid task ID');
      await expect(deleteTask('team', '../../oops')).rejects.toThrow(
        'Invalid task ID',
      );
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

    it('persists completion even when unblocking one dependent fails', async () => {
      // Regression: unblockDependents used Promise.all, so a single
      // dependent failing (e.g. corrupt task file) rejected out of
      // updateTask *before* the completed status was written — the
      // task stayed in_progress on disk while the healthy dependents
      // were already unblocked.
      const blocker = await createTask('team', {
        subject: 'Blocker',
        description: 'A',
      });
      const healthy = await createTask('team', {
        subject: 'Healthy dependent',
        description: 'B',
      });
      const corrupt = await createTask('team', {
        subject: 'Corrupt dependent',
        description: 'C',
      });
      await blockTask('team', blocker.id, healthy.id);
      await blockTask('team', blocker.id, corrupt.id);

      // Truncate the second dependent's file so its unblock throws.
      const corruptPath = path.join(
        tmpDir,
        'tasks',
        'team',
        `${corrupt.id}.json`,
      );
      await fs.writeFile(corruptPath, '{ "id": "3", "subj', 'utf-8');

      const updated = await updateTask('team', blocker.id, {
        status: 'completed',
      });
      expect(updated!.status).toBe('completed');

      // Completed status reached disk and the healthy dependent
      // was unblocked despite the corrupt sibling.
      const persisted = await getTask('team', blocker.id);
      expect(persisted!.status).toBe('completed');
      const unblocked = await getTask('team', healthy.id);
      expect(unblocked!.blockedBy).toEqual([]);
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

    it('rejects a teammate caller from clobbering a different owner', async () => {
      // Regression: when a task is already claimed, a second teammate
      // calling task_update used to silently overwrite `owner` (last
      // writer wins) because the ownership check was outside the
      // file lock. The check now lives inside `updateTask` and throws.
      const task = await createTask('team', {
        subject: 'Shared',
        description: '',
      });
      await updateTask('team', task.id, {
        status: 'in_progress',
        owner: 'alice',
      });

      await expect(
        updateTask(
          'team',
          task.id,
          { status: 'in_progress', owner: 'bob' },
          { callerName: 'bob' },
        ),
      ).rejects.toBeInstanceOf(TaskOwnershipError);

      // Alice's claim still stands.
      const after = await getTask('team', task.id);
      expect(after?.owner).toBe('alice');
    });

    it('serializes concurrent teammate claims under the lock', async () => {
      // Two teammates race to claim the same pending task. The lock
      // serializes the writes; the first claim wins, the second sees
      // the first's owner inside the same lock and throws.
      const task = await createTask('team', {
        subject: 'Shared',
        description: '',
      });

      const aliceClaim = updateTask(
        'team',
        task.id,
        { status: 'in_progress', owner: 'alice' },
        { callerName: 'alice' },
      );
      const bobClaim = updateTask(
        'team',
        task.id,
        { status: 'in_progress', owner: 'bob' },
        { callerName: 'bob' },
      );
      const results = await Promise.allSettled([aliceClaim, bobClaim]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        TaskOwnershipError,
      );

      const final = await getTask('team', task.id);
      expect(['alice', 'bob']).toContain(final?.owner);
    });

    it('lets the leader (no callerName) override an existing owner', async () => {
      const task = await createTask('team', {
        subject: 'Shared',
        description: '',
        owner: 'alice',
      });
      const updated = await updateTask('team', task.id, {
        owner: 'bob',
      });
      expect(updated?.owner).toBe('bob');
    });

    it('lets the existing owner change their own task', async () => {
      const task = await createTask('team', {
        subject: 'Shared',
        description: '',
      });
      await updateTask(
        'team',
        task.id,
        { status: 'in_progress', owner: 'alice' },
        { callerName: 'alice' },
      );
      const updated = await updateTask(
        'team',
        task.id,
        { status: 'completed' },
        { callerName: 'alice' },
      );
      expect(updated?.status).toBe('completed');
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

    it('removes the deleted id from dependents blockedBy / blocks', async () => {
      // Regression: deleting a task that appears in another task's
      // `blockedBy` used to leave the dead id behind, and auto-claim
      // skips any task with a non-empty `blockedBy` — so the dependent
      // became unclaimable forever.
      const blocker = await createTask('team', {
        subject: 'Blocker',
        description: '',
      });
      const dependent = await createTask('team', {
        subject: 'Dependent',
        description: '',
      });
      await blockTask('team', blocker.id, dependent.id);

      const before = await getTask('team', dependent.id);
      expect(before?.blockedBy).toEqual([blocker.id]);

      expect(await deleteTask('team', blocker.id)).toBe(true);

      const after = await getTask('team', dependent.id);
      expect(after?.blockedBy).toEqual([]);
    });

    it('removes the deleted id from neighbors blocks list too', async () => {
      const upstream = await createTask('team', {
        subject: 'Upstream',
        description: '',
      });
      const target = await createTask('team', {
        subject: 'Target',
        description: '',
      });
      await blockTask('team', upstream.id, target.id);

      // Sanity: upstream now lists `target.id` in its `blocks`.
      const upstreamBefore = await getTask('team', upstream.id);
      expect(upstreamBefore?.blocks).toEqual([target.id]);

      expect(await deleteTask('team', target.id)).toBe(true);

      const upstreamAfter = await getTask('team', upstream.id);
      expect(upstreamAfter?.blocks).toEqual([]);
    });

    it("rejects a teammate caller from deleting another owner's task", async () => {
      // Regression: status:'deleted' took a separate code path that
      // skipped the ownership guard updateTask enforces, so any teammate
      // could delete any task. deleteTask now mirrors that guard.
      const task = await createTask('team', {
        subject: 'Alice task',
        description: '',
        owner: 'alice',
      });
      await expect(
        deleteTask('team', task.id, { callerName: 'bob' }),
      ).rejects.toBeInstanceOf(TaskOwnershipError);
      // The task survives the rejected delete.
      expect(await getTask('team', task.id)).toBeDefined();
    });

    it('lets the owner, the leader, and any teammate (unowned) delete', async () => {
      const owned = await createTask('team', {
        subject: 'Owned',
        description: '',
        owner: 'alice',
      });
      // Owner can delete their own task.
      expect(await deleteTask('team', owned.id, { callerName: 'alice' })).toBe(
        true,
      );

      // Leader (no callerName) can delete anyone's task.
      const bobs = await createTask('team', {
        subject: 'Bob task',
        description: '',
        owner: 'bob',
      });
      expect(await deleteTask('team', bobs.id)).toBe(true);

      // A teammate can delete an unowned task.
      const unowned = await createTask('team', {
        subject: 'Unowned',
        description: '',
      });
      expect(await deleteTask('team', unowned.id, { callerName: 'bob' })).toBe(
        true,
      );
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

    it('quarantines corrupt task files instead of silently skipping', async () => {
      // Regression: previously a corrupt or truncated `{id}.json`
      // (e.g. process killed mid-write) was swallowed as undefined
      // and silently filtered out. The leader saw an apparently
      // empty board while in-flight work was invisible.
      const t1 = await createTask('team', {
        subject: 'Real one',
        description: 'A',
      });

      // Write a truncated JSON file alongside the real task.
      const dir = path.join(tmpDir, 'tasks', 'team');
      const corruptPath = path.join(dir, '999.json');
      await fs.writeFile(corruptPath, '{ "id": "999", "subj', 'utf-8');

      // Listing still succeeds for the well-formed task.
      const tasks = await listTasks('team');
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.id).toBe(t1.id);

      // The corrupt file is renamed out of `.json` so it stops
      // failing parses on every subsequent listTasks call.
      await expect(fs.access(corruptPath)).rejects.toThrow();
      const entries = await fs.readdir(dir);
      expect(entries.some((e) => e.startsWith('999.json.corrupt-'))).toBe(true);
    });

    it('skips an empty (mid-create) task file without quarantining it', async () => {
      // Regression: createTask claims the id with O_CREAT|O_EXCL and
      // writes the content as a second step. A concurrent listTasks
      // landing in that window read the empty file, failed JSON.parse,
      // and quarantined it — losing the just-created task and orphaning
      // its id. An empty file is now treated as a create in flight:
      // skipped this round, left intact for the next listTasks.
      const t1 = await createTask('team', {
        subject: 'Real one',
        description: 'A',
      });

      const dir = path.join(tmpDir, 'tasks', 'team');
      const pendingPath = path.join(dir, '999.json');
      await fs.writeFile(pendingPath, '', 'utf-8'); // empty, like a mid-create

      const tasks = await listTasks('team');
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.id).toBe(t1.id);

      // The empty file is neither quarantined nor lost.
      await expect(fs.access(pendingPath)).resolves.toBeUndefined();
      const entries = await fs.readdir(dir);
      expect(entries).toContain('999.json');
      expect(entries.some((e) => e.includes('.corrupt-'))).toBe(false);
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
