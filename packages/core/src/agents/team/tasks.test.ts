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
  releaseOwnedTask,
  unassignTeammateTasks,
  getAgentStatuses,
  onTasksUpdated,
  notifyTasksUpdated,
  TaskOwnershipError,
  TaskSnapshotChangedError,
  RECIPROCAL_CALLER,
  normalizeTaskId,
} from './tasks.js';
import { mockCompromisedLock } from '../../test-utils/mock-compromised-lock.js';

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

type DropTeam<T> = T extends [string, ...infer R] ? R : never;

describe('normalizeTaskId', () => {
  it('trims whitespace and strips one leading #', () => {
    expect(normalizeTaskId(' 1 ')).toBe('1');
    expect(normalizeTaskId('#1')).toBe('1');
    expect(normalizeTaskId(' #42 ')).toBe('42');
    // Only one leading # is stripped.
    expect(normalizeTaskId('##1')).toBe('#1');
  });

  it('returns undefined when nothing remains', () => {
    expect(normalizeTaskId('')).toBeUndefined();
    expect(normalizeTaskId('   ')).toBeUndefined();
    expect(normalizeTaskId('#')).toBeUndefined();
    expect(normalizeTaskId(' # ')).toBeUndefined();
  });
});

describe('tasks', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-test-'));
    (
      Storage as unknown as { __setMockGlobalDir: (d: string) => void }
    ).__setMockGlobalDir(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Team 'team' shorthands; `extra` / the remaining args pass through verbatim.
  const create = (
    subject: string,
    description: string,
    extra?: Omit<Parameters<typeof createTask>[1], 'subject' | 'description'>,
  ) => createTask('team', { subject, description, ...extra });
  const update = (...args: DropTeam<Parameters<typeof updateTask>>) =>
    updateTask('team', ...args);
  const read = (id: string) => getTask('team', id);
  const tasksDir = () => path.join(tmpDir, 'tasks', 'team');
  // A teammate claiming `id` for itself (callerName = owner).
  const claimAs = (id: string, owner: string) =>
    update(id, { status: 'in_progress', owner }, { callerName: owner });

  // ─── createTask ────────────────────────────────────────────

  describe('createTask', () => {
    it('creates a task with auto-incremented ID', async () => {
      const t1 = await create('First', 'First task');
      expect(t1.id).toBe('1');
      expect(t1.subject).toBe('First');
      expect(t1.status).toBe('pending');
      expect(t1.blocks).toEqual([]);
      expect(t1.blockedBy).toEqual([]);

      const t2 = await create('Second', 'Second task');
      expect(t2.id).toBe('2');
    });

    it('creates task with optional fields', async () => {
      const task = await create('Test', 'Test task', {
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
      const created = await create('Test', 'Desc');
      expect(await getTask('team', created.id)).toEqual(created);
    });

    it('returns undefined for nonexistent task', async () => {
      expect(await getTask('team', '999')).toBeUndefined();
    });

    it('rejects non-numeric task IDs to prevent path traversal', async () => {
      for (const id of ['../../etc/passwd', '../../settings', 'abc', '', '0']) {
        await expect(getTask('team', id)).rejects.toThrow('Invalid task ID');
      }
    });

    it('rejects non-numeric task IDs from updateTask and deleteTask', async () => {
      await expect(
        update('../../oops', { status: 'completed' }),
      ).rejects.toThrow('Invalid task ID');
      await expect(deleteTask('team', '../../oops')).rejects.toThrow(
        'Invalid task ID',
      );
    });
  });

  // ─── updateTask ────────────────────────────────────────────

  describe('updateTask', () => {
    it('updates status and owner', async () => {
      const task = await create('Test', 'Desc');
      const updated = await update(task.id, {
        status: 'in_progress',
        owner: 'worker@team',
      });
      expect(updated!.status).toBe('in_progress');
      expect(updated!.owner).toBe('worker@team');
    });

    it('still updates the task when the lock is compromised', async () => {
      const task = await create('Test', 'Desc');
      const { lockSpy, getOnCompromised } = mockCompromisedLock();

      try {
        await expect(
          update(task.id, { status: 'in_progress' }),
        ).resolves.toMatchObject({ id: task.id, status: 'in_progress' });
        expect(getOnCompromised()).toBeTypeOf('function');
      } finally {
        lockSpy.mockRestore();
      }

      expect(await read(task.id)).toMatchObject({ status: 'in_progress' });
    });

    it('clears owner with null', async () => {
      const task = await create('Test', 'Desc', { owner: 'worker@team' });
      const updated = await update(task.id, { owner: null });
      expect(updated!.owner).toBeUndefined();
    });

    it('updates subject and description', async () => {
      const task = await create('Old', 'Old desc');
      const updated = await update(task.id, {
        subject: 'New',
        description: 'New desc',
      });
      expect(updated!.subject).toBe('New');
      expect(updated!.description).toBe('New desc');
    });

    it('clears activeForm with null', async () => {
      const task = await create('Test', 'Desc', { activeForm: 'Running' });
      const updated = await update(task.id, { activeForm: null });
      expect(updated!.activeForm).toBeUndefined();
    });

    it('merges metadata and removes null keys', async () => {
      const task = await create('Test', 'Desc', { metadata: { a: 1, b: 2 } });
      const updated = await update(task.id, { metadata: { b: null, c: 3 } });
      expect(updated!.metadata).toEqual({ a: 1, c: 3 });
    });

    it('removes metadata entirely if all keys deleted', async () => {
      const task = await create('Test', 'Desc', { metadata: { a: 1 } });
      const updated = await update(task.id, { metadata: { a: null } });
      expect(updated!.metadata).toBeUndefined();
    });

    it('adds block relationships', async () => {
      const task = await create('Test', 'Desc');
      const updated = await update(task.id, { addBlocks: ['2', '3'] });
      expect(updated!.blocks).toEqual(['2', '3']);
    });

    it('persists completion even when unblocking one dependent fails', async () => {
      // Regression: unblockDependents used Promise.all, so one failing
      // dependent (e.g. corrupt task file) rejected out of updateTask
      // *before* the completed status was written — the task stayed
      // in_progress on disk while healthy dependents were already unblocked.
      const blocker = await create('Blocker', 'A');
      const healthy = await create('Healthy dependent', 'B');
      const corrupt = await create('Corrupt dependent', 'C');
      await blockTask('team', blocker.id, healthy.id);
      await blockTask('team', blocker.id, corrupt.id);

      // Truncate the second dependent's file so its unblock throws.
      const corruptPath = path.join(tasksDir(), `${corrupt.id}.json`);
      await fs.writeFile(corruptPath, '{ "id": "3", "subj', 'utf-8');

      const updated = await update(blocker.id, { status: 'completed' });
      expect(updated!.status).toBe('completed');

      // Completed status reached disk and the healthy dependent
      // was unblocked despite the corrupt sibling.
      expect((await read(blocker.id))!.status).toBe('completed');
      expect((await read(healthy.id))!.blockedBy).toEqual([]);
    });

    it('deduplicates block IDs', async () => {
      const task = await create('Test', 'Desc');
      await update(task.id, { addBlocks: ['2'] });
      const updated = await update(task.id, { addBlocks: ['2', '3'] });
      expect(updated!.blocks).toEqual(['2', '3']);
    });

    it('returns undefined for nonexistent task', async () => {
      expect(await update('999', { status: 'completed' })).toBeUndefined();
    });

    it('rejects a teammate caller from clobbering a different owner', async () => {
      // Regression: a second teammate's task_update on a claimed task used
      // to silently overwrite `owner` (last writer wins) because the
      // ownership check was outside the file lock. It now lives inside
      // `updateTask` and throws.
      const task = await create('Shared', '');
      await update(task.id, { status: 'in_progress', owner: 'alice' });

      await expect(claimAs(task.id, 'bob')).rejects.toBeInstanceOf(
        TaskOwnershipError,
      );

      // Alice's claim still stands.
      expect((await read(task.id))?.owner).toBe('alice');
    });

    it('serializes concurrent teammate claims under the lock', async () => {
      // Two teammates race to claim the same pending task. The lock
      // serializes the writes; the first claim wins, the second sees
      // the first's owner inside the same lock and throws.
      const task = await create('Shared', '');

      const results = await Promise.allSettled([
        claimAs(task.id, 'alice'),
        claimAs(task.id, 'bob'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        TaskOwnershipError,
      );

      expect(['alice', 'bob']).toContain((await read(task.id))?.owner);
    });

    it('rejects a stale leader assignment when the expected owner changed', async () => {
      const task = await create('Shared', '');
      const options = { expectedOwner: null };

      const results = await Promise.allSettled([
        update(task.id, { status: 'in_progress', owner: 'alice' }, options),
        update(task.id, { status: 'in_progress', owner: 'bob' }, options),
      ]);

      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(TaskSnapshotChangedError);
      expect((rejected[0]!.reason as Error).message).toContain('owner changed');
      expect(['alice', 'bob']).toContain((await read(task.id))?.owner);
    });

    it('reports only the expected fields that changed', async () => {
      const task = await create('Shared', '', { owner: 'alice' });
      await update(task.id, { status: 'in_progress' });
      await update(task.id, { status: 'completed' }, { callerName: 'alice' });

      const attempt = update(
        task.id,
        { status: 'pending' },
        { expectedStatus: 'in_progress' },
      );

      await expect(attempt).rejects.toMatchObject({
        expectedStatus: 'in_progress',
        actualStatus: 'completed',
      });
      await expect(attempt).rejects.toThrow('status changed');
      await expect(attempt).rejects.not.toThrow('owner changed');
    });

    it('does not check an undefined expected status', async () => {
      const task = await create('Shared', '');

      await expect(
        update(
          task.id,
          { status: 'in_progress' },
          { expectedStatus: undefined },
        ),
      ).resolves.toMatchObject({ status: 'in_progress' });
    });

    it('rejects a stale leader assignment when status changed', async () => {
      const task = await create('Shared', '', { owner: 'alice' });
      await update(task.id, { status: 'in_progress' });
      await update(task.id, { status: 'completed' }, { callerName: 'alice' });

      await expect(
        update(
          task.id,
          { status: 'in_progress', owner: 'bob' },
          { expectedOwner: 'alice', expectedStatus: 'in_progress' },
        ),
      ).rejects.toMatchObject({
        name: 'TaskSnapshotChangedError',
        expectedStatus: 'in_progress',
        actualStatus: 'completed',
      });
      expect(await read(task.id)).toMatchObject({
        status: 'completed',
        owner: 'alice',
      });
    });

    it('lets the leader (no callerName) override an existing owner', async () => {
      const task = await create('Shared', '', { owner: 'alice' });
      const updated = await update(task.id, { owner: 'bob' });
      expect(updated?.owner).toBe('bob');
    });

    it('lets the existing owner change their own task', async () => {
      const task = await create('Shared', '');
      await claimAs(task.id, 'alice');
      const updated = await update(
        task.id,
        { status: 'completed' },
        { callerName: 'alice' },
      );
      expect(updated?.status).toBe('completed');
    });

    it('lets the reciprocal sentinel bypass the ownership guard', async () => {
      // The reciprocal edge-mirror must touch a neighbor task the caller
      // may not own; it passes RECIPROCAL_CALLER, which bypasses the guard
      // just like the leader's undefined callerName — but is greppable.
      const task = await create('Owned', '', { owner: 'alice' });
      const other = await create('Neighbor', '');

      // A non-owner edge mirror onto alice's task succeeds via the sentinel.
      const updated = await update(
        task.id,
        { addBlockedBy: [other.id] },
        { callerName: RECIPROCAL_CALLER },
      );
      expect(updated?.blockedBy).toContain(other.id);

      // A real non-owner caller is still blocked.
      await expect(
        update(task.id, { addBlockedBy: [other.id] }, { callerName: 'bob' }),
      ).rejects.toBeInstanceOf(TaskOwnershipError);
    });
  });

  // ─── deleteTask ────────────────────────────────────────────

  describe('deleteTask', () => {
    it('deletes an existing task', async () => {
      const task = await create('Test', 'Desc');
      expect(await deleteTask('team', task.id)).toBe(true);
      expect(await read(task.id)).toBeUndefined();
    });

    it('returns false for nonexistent task', async () => {
      expect(await deleteTask('team', '999')).toBe(false);
    });

    it('removes the deleted id from dependents blockedBy / blocks', async () => {
      // Regression: deleting a task left its dead id in dependents'
      // `blockedBy`, and auto-claim skips any task with a non-empty
      // `blockedBy` — so the dependent became unclaimable forever.
      const blocker = await create('Blocker', '');
      const dependent = await create('Dependent', '');
      await blockTask('team', blocker.id, dependent.id);

      expect((await read(dependent.id))?.blockedBy).toEqual([blocker.id]);

      expect(await deleteTask('team', blocker.id)).toBe(true);

      expect((await read(dependent.id))?.blockedBy).toEqual([]);
    });

    it('removes the deleted id from neighbors blocks list too', async () => {
      const upstream = await create('Upstream', '');
      const target = await create('Target', '');
      await blockTask('team', upstream.id, target.id);

      // Sanity: upstream now lists `target.id` in its `blocks`.
      expect((await read(upstream.id))?.blocks).toEqual([target.id]);

      expect(await deleteTask('team', target.id)).toBe(true);

      expect((await read(upstream.id))?.blocks).toEqual([]);
    });

    it("rejects a teammate caller from deleting another owner's task", async () => {
      // Regression: status:'deleted' took a separate code path that
      // skipped the ownership guard updateTask enforces, so any teammate
      // could delete any task. deleteTask now mirrors that guard.
      const task = await create('Alice task', '', { owner: 'alice' });
      await expect(
        deleteTask('team', task.id, { callerName: 'bob' }),
      ).rejects.toBeInstanceOf(TaskOwnershipError);
      // The task survives the rejected delete.
      expect(await read(task.id)).toBeDefined();
    });

    it('lets the owner, the leader, and any teammate (unowned) delete', async () => {
      const owned = await create('Owned', '', { owner: 'alice' });
      // Owner can delete their own task.
      expect(await deleteTask('team', owned.id, { callerName: 'alice' })).toBe(
        true,
      );

      // Leader (no callerName) can delete anyone's task.
      const bobs = await create('Bob task', '', { owner: 'bob' });
      expect(await deleteTask('team', bobs.id)).toBe(true);

      // A teammate can delete an unowned task.
      const unowned = await create('Unowned', '');
      expect(await deleteTask('team', unowned.id, { callerName: 'bob' })).toBe(
        true,
      );
    });
  });

  // ─── listTasks ─────────────────────────────────────────────

  describe('listTasks', () => {
    it('lists all tasks sorted by ID', async () => {
      await create('Third', 'C');
      await create('First', 'A');

      const tasks = await listTasks('team');
      expect(tasks).toHaveLength(2);
      expect(tasks[0]!.id).toBe('1');
      expect(tasks[1]!.id).toBe('2');
    });

    it('filters by status', async () => {
      const t1 = await create('A', 'A');
      await create('B', 'B');
      await update(t1.id, { status: 'in_progress' });

      const inProgress = await listTasks('team', { status: 'in_progress' });
      expect(inProgress).toHaveLength(1);
      expect(inProgress[0]!.subject).toBe('A');
    });

    it('filters by owner', async () => {
      await create('A', 'A', { owner: 'alice' });
      await create('B', 'B', { owner: 'bob' });

      const aliceTasks = await listTasks('team', { owner: 'alice' });
      expect(aliceTasks).toHaveLength(1);
      expect(aliceTasks[0]!.owner).toBe('alice');
    });

    it('returns empty for nonexistent team', async () => {
      expect(await listTasks('nope')).toEqual([]);
    });

    it('quarantines corrupt task files instead of silently skipping', async () => {
      // Regression: a corrupt or truncated `{id}.json` (e.g. process killed
      // mid-write) was swallowed as undefined and silently filtered out, so
      // the leader saw an apparently empty board while in-flight work was
      // invisible.
      const t1 = await create('Real one', 'A');

      // Write a truncated JSON file alongside the real task.
      const dir = tasksDir();
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
      // writes the content as a second step. A concurrent listTasks in
      // that window read the empty file, failed JSON.parse, and
      // quarantined it — losing the just-created task and orphaning its
      // id. An empty file is now a create in flight: skipped this round,
      // left intact for the next listTasks.
      const t1 = await create('Real one', 'A');

      const dir = tasksDir();
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
      await create('A', 'A');
      await create('B', 'B');

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
      const t1 = await create('A', 'A');
      const t2 = await create('B', 'B');

      await blockTask('team', t1.id, t2.id);

      const a = await read(t1.id);
      const b = await read(t2.id);
      expect(a!.blocks).toContain(t2.id);
      expect(b!.blockedBy).toContain(t1.id);
    });
  });

  // ─── claimTask ─────────────────────────────────────────────

  describe('claimTask', () => {
    it('claims a pending task', async () => {
      const task = await create('Work', 'Do work');

      const claimed = await claimTask('team', task.id, 'worker@team');
      expect(claimed!.owner).toBe('worker@team');
      expect(claimed!.status).toBe('in_progress');
    });

    it('returns undefined for already claimed task', async () => {
      const task = await create('Work', 'Do work');
      await claimTask('team', task.id, 'alice');

      expect(await claimTask('team', task.id, 'bob')).toBeUndefined();
    });

    it('returns undefined for nonexistent task', async () => {
      expect(await claimTask('team', '999', 'worker')).toBeUndefined();
    });

    it('respects checkAgentBusy option', async () => {
      const t1 = await create('A', 'A');
      const t2 = await create('B', 'B');

      await claimTask('team', t1.id, 'worker');

      // Worker is busy — should fail with checkAgentBusy
      const result = await claimTask('team', t2.id, 'worker', {
        checkAgentBusy: true,
      });
      expect(result).toBeUndefined();

      // Without check — should succeed
      expect(await claimTask('team', t2.id, 'worker')).toBeDefined();
    });

    it('serializes concurrent busy-checked claims for the same agent (no double-ownership)', async () => {
      // Regression for the claimTask busy-check TOCTOU: two concurrent
      // auto-claim paths (scanIdleAgentsForTasks vs a message flush) for the
      // SAME idle agent, each on a DIFFERENT task, both passed the stale
      // isAgentBusy read on their own task locks, so the agent owned two
      // in_progress tasks. The per-agent claim mutex makes the second
      // observe the first's committed claim and bail.
      const t1 = await create('A', 'A');
      const t2 = await create('B', 'B');

      const [r1, r2] = await Promise.all([
        claimTask('team', t1.id, 'worker@team', {
          checkAgentBusy: true,
          ownerName: 'worker',
        }),
        claimTask('team', t2.id, 'worker@team', {
          checkAgentBusy: true,
          ownerName: 'worker',
        }),
      ]);

      // Exactly one claim succeeds; the other is refused.
      const succeeded = [r1, r2].filter((r) => r !== undefined);
      expect(succeeded).toHaveLength(1);

      // And on disk the agent owns exactly one in_progress task.
      const inProgress = await listTasks('team', { status: 'in_progress' });
      expect(inProgress).toHaveLength(1);
      expect(inProgress[0]!.owner).toBe('worker');
    });

    it('different agents claiming the same task: exactly one wins', async () => {
      // The per-agent mutex must not serialize across agents — distinct
      // agents racing the SAME task contend only on the per-file lock, and
      // exactly one claims it.
      const task = await create('X', 'X');

      const [r1, r2] = await Promise.all([
        claimTask('team', task.id, 'alice@team', {
          checkAgentBusy: true,
          ownerName: 'alice',
        }),
        claimTask('team', task.id, 'bob@team', {
          checkAgentBusy: true,
          ownerName: 'bob',
        }),
      ]);

      const winners = [r1, r2].filter((r) => r !== undefined);
      expect(winners).toHaveLength(1);
      const inProgress = await listTasks('team', { status: 'in_progress' });
      expect(inProgress).toHaveLength(1);
    });
  });

  // ─── unassignTeammateTasks ─────────────────────────────────

  describe('unassignTeammateTasks', () => {
    it('resets in_progress tasks to pending', async () => {
      const t1 = await create('A', 'A');
      const t2 = await create('B', 'B');
      await claimTask('team', t1.id, 'worker');
      await claimTask('team', t2.id, 'worker');

      expect(await unassignTeammateTasks('team', 'worker')).toBe(2);

      const tasks = await listTasks('team');
      expect(tasks.every((t) => t.status === 'pending')).toBe(true);
      expect(tasks.every((t) => t.owner === undefined)).toBe(true);
    });

    it('does not affect completed tasks', async () => {
      const task = await create('A', 'A');
      await claimTask('team', task.id, 'worker');
      await update(task.id, { status: 'completed' });

      expect(await unassignTeammateTasks('team', 'worker')).toBe(0);
    });
  });

  // ─── releaseOwnedTask ──────────────────────────────────────

  describe('releaseOwnedTask', () => {
    it('resets an in_progress task owned by the expected owner', async () => {
      const task = await create('A', 'A');
      await claimTask('team', task.id, 'worker');

      expect(await releaseOwnedTask('team', task.id, 'worker')).toBe(true);

      const after = await read(task.id);
      expect(after?.status).toBe('pending');
      expect(after?.owner).toBeUndefined();
    });

    it('returns false when the task is no longer in_progress', async () => {
      // Models the dying agent's final task_update (completion) landing
      // between the caller's snapshot and the release.
      const task = await create('A', 'A');
      await claimTask('team', task.id, 'worker');
      await update(task.id, { status: 'completed' });

      expect(await releaseOwnedTask('team', task.id, 'worker')).toBe(false);

      const after = await read(task.id);
      expect(after?.status).toBe('completed');
      expect(after?.owner).toBe('worker');
    });

    it('returns false when the task was reassigned to another owner', async () => {
      const task = await create('A', 'A');
      await claimTask('team', task.id, 'worker');
      await update(task.id, { owner: 'other' });

      expect(await releaseOwnedTask('team', task.id, 'worker')).toBe(false);

      const after = await read(task.id);
      expect(after?.status).toBe('in_progress');
      expect(after?.owner).toBe('other');
    });

    it('returns false when the task file no longer exists', async () => {
      const task = await create('A', 'A');
      await claimTask('team', task.id, 'worker');
      await deleteTask('team', task.id);

      expect(await releaseOwnedTask('team', task.id, 'worker')).toBe(false);
    });
  });

  // ─── getAgentStatuses ──────────────────────────────────────

  describe('getAgentStatuses', () => {
    it('returns per-agent task counts', async () => {
      const t1 = await create('A', 'A');
      const t2 = await create('B', 'B');
      await claimTask('team', t1.id, 'alice');
      await claimTask('team', t2.id, 'bob');
      await update(t2.id, { status: 'completed' });

      const statuses = await getAgentStatuses('team');
      expect(statuses.get('alice')).toEqual({ inProgress: 1, completed: 0 });
      expect(statuses.get('bob')).toEqual({ inProgress: 0, completed: 1 });
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

      await create('Test', 'D');
      expect(calls).toEqual(['team']);

      unsubscribe();
    });

    it('keeps notifying remaining listeners after one throws', () => {
      const calls: string[] = [];
      const unsubThrowing = onTasksUpdated(() => {
        throw new Error('boom');
      });
      const unsubGood = onTasksUpdated((name) => calls.push(name));

      expect(() => notifyTasksUpdated('team')).not.toThrow();
      expect(calls).toEqual(['team']);

      unsubThrowing();
      unsubGood();
    });
  });

  // ─── Concurrent claims ────────────────────────────────────

  describe('concurrent operations', () => {
    it('only one claimTask wins under concurrency', async () => {
      const task = await create('Race', 'Race condition test');

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          claimTask('team', task.id, `worker-${i}`),
        ),
      );

      const winners = results.filter((r) => r !== undefined);
      expect(winners).toHaveLength(1);

      const final = await read(task.id);
      expect(final!.status).toBe('in_progress');
      expect(final!.owner).toBeDefined();
    });
  });
});
