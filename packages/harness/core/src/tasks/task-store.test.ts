/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lock } from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from './task-store.js';

describe('TaskStore', () => {
  let rootDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-store-test-'));
    store = new TaskStore(rootDir, 'session-1');
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('persists attribution when a task is assigned to a new user turn', async () => {
    const businessInfo = {
      version: '1',
      id: 'first-turn',
      model_key: 'auto',
      product: 'cli',
    };
    const task = await store.createTask({
      subject: 'Work',
      description: 'test',
      businessInfo,
    });
    expect((await store.getTask(task.id))?.businessInfo).toEqual(businessInfo);
    await store.updateTask(task.id, {
      owner: 'worker',
      businessInfo: {
        ...businessInfo,
        id: 'second-turn',
        model_key: 'ultimate',
      },
    });
    expect((await store.getTask(task.id))?.businessInfo).toEqual({
      ...businessInfo,
      id: 'second-turn',
      model_key: 'ultimate',
    });
  });

  it('allocates monotonic decimal IDs without reusing deleted IDs', async () => {
    const first = await store.createTask({
      subject: 'First',
      description: 'First task',
    });
    await store.deleteTask(first.id);
    const second = await store.createTask({
      subject: 'Second',
      description: 'Second task',
    });

    expect(first.id).toBe('1');
    expect(second.id).toBe('2');
  });

  it('ignores non-decimal task files when allocating IDs', async () => {
    await fs.mkdir(store.taskListDir, { recursive: true });
    await fs.writeFile(
      path.join(store.taskListDir, 'invalid.json'),
      JSON.stringify({
        id: 'invalid',
        subject: 'Foreign task',
        description: '',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      }),
    );

    const first = await store.createTask({
      subject: 'First generated task',
      description: '',
    });
    const second = await store.createTask({
      subject: 'Second generated task',
      description: '',
    });

    expect(first.id).toBe('1');
    expect(second.id).toBe('2');
    await expect(
      fs.stat(path.join(store.taskListDir, 'NaN.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.readFile(path.join(store.taskListDir, '.highwatermark'), 'utf8'),
    ).resolves.toBe('2\n');
  });

  it('serializes concurrent creates', async () => {
    const tasks = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.createTask({
          subject: `Task ${index}`,
          description: `Description ${index}`,
        }),
      ),
    );

    expect(tasks.map((task) => task.id).sort((a, b) => +a - +b)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
    ]);
  });

  it('coordinates writes through a renewable task list lease', async () => {
    await fs.mkdir(store.taskListDir, { recursive: true });
    const lockPath = path.join(store.taskListDir, '.lock');
    await fs.writeFile(lockPath, '', { mode: 0o600 });
    const releaseExternalLock = await lock(lockPath);
    let creationSettled = false;
    const creation = store
      .createTask({
        subject: 'Wait for lease',
        description: '',
      })
      .finally(() => {
        creationSettled = true;
      });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(creationSettled).toBe(false);
    } finally {
      await releaseExternalLock();
    }

    await expect(creation).resolves.toMatchObject({ id: '1' });
    await expect(fs.stat(lockPath)).resolves.toBeDefined();
  });

  it('serializes mutations of the same task across store instances', async () => {
    const task = await store.createTask({
      subject: 'Original subject',
      description: '',
    });
    const peerStore = new TaskStore(rootDir, 'session-1');
    let releaseFirstMutation: (() => void) | undefined;
    const firstMutationGate = new Promise<void>((resolve) => {
      releaseFirstMutation = resolve;
    });
    let markFirstMutationStarted: (() => void) | undefined;
    const firstMutationStarted = new Promise<void>((resolve) => {
      markFirstMutationStarted = resolve;
    });
    const firstMutation = store.withTaskMutation(
      task.id,
      async (mutation) => {
        markFirstMutationStarted?.();
        await firstMutationGate;
        return mutation.updateTask({ status: 'in_progress' });
      },
    );
    await firstMutationStarted;

    let secondMutationSettled = false;
    const secondMutation = peerStore
      .updateTask(task.id, { subject: 'Updated subject' })
      .finally(() => {
        secondMutationSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondMutationSettled).toBe(false);

    releaseFirstMutation?.();
    await expect(firstMutation).resolves.toMatchObject({
      status: 'in_progress',
    });
    await expect(secondMutation).resolves.toMatchObject({
      subject: 'Updated subject',
      status: 'in_progress',
    });
  });

  it('allows different tasks to mutate while one task lease is held', async () => {
    const first = await store.createTask({
      subject: 'First',
      description: '',
    });
    const second = await store.createTask({
      subject: 'Second',
      description: '',
    });
    let releaseFirstMutation: (() => void) | undefined;
    const firstMutationGate = new Promise<void>((resolve) => {
      releaseFirstMutation = resolve;
    });
    let markFirstMutationStarted: (() => void) | undefined;
    const firstMutationStarted = new Promise<void>((resolve) => {
      markFirstMutationStarted = resolve;
    });
    const firstMutation = store.withTaskMutation(first.id, async () => {
      markFirstMutationStarted?.();
      await firstMutationGate;
    });
    await firstMutationStarted;

    await expect(
      store.updateTask(second.id, { status: 'in_progress' }),
    ).resolves.toMatchObject({ status: 'in_progress' });

    releaseFirstMutation?.();
    await firstMutation;
  });

  it('stops waiting for a task lease when the operation is aborted', async () => {
    const task = await store.createTask({
      subject: 'Abort waiting mutation',
      description: '',
    });
    let releaseFirstMutation: (() => void) | undefined;
    const firstMutationGate = new Promise<void>((resolve) => {
      releaseFirstMutation = resolve;
    });
    let markFirstMutationStarted: (() => void) | undefined;
    const firstMutationStarted = new Promise<void>((resolve) => {
      markFirstMutationStarted = resolve;
    });
    const firstMutation = store.withTaskMutation(task.id, async () => {
      markFirstMutationStarted?.();
      await firstMutationGate;
    });
    await firstMutationStarted;

    const controller = new AbortController();
    const waitingMutation = store.withTaskMutation(
      task.id,
      async () => {
        throw new Error('Aborted mutation must not start');
      },
      controller.signal,
    );
    controller.abort();

    await expect(waitingMutation).rejects.toMatchObject({
      name: 'AbortError',
    });
    releaseFirstMutation?.();
    await firstMutation;
  });

  it('persists dependencies in both directions and removes references', async () => {
    const blocker = await store.createTask({
      subject: 'Blocker',
      description: '',
    });
    const blocked = await store.createTask({
      subject: 'Blocked',
      description: '',
    });

    await store.updateTask(blocker.id, { addBlocks: [blocked.id] });
    expect(await store.getTask(blocker.id)).toMatchObject({
      blocks: [blocked.id],
    });
    expect(await store.getTask(blocked.id)).toMatchObject({
      blockedBy: [blocker.id],
    });

    await store.deleteTask(blocker.id);
    expect(await store.getTask(blocked.id)).toMatchObject({ blockedBy: [] });
  });

  it('merges metadata and deletes keys assigned null', async () => {
    const task = await store.createTask({
      subject: 'Metadata',
      description: '',
      metadata: { keep: true, remove: true },
    });

    const updated = await store.updateTask(task.id, {
      metadata: { remove: null, add: 'value' },
    });

    expect(updated?.metadata).toEqual({ keep: true, add: 'value' });
  });

  it('emits process-local change notifications', async () => {
    const listener = vi.fn();
    const dispose = store.onDidChange(listener);
    const task = await store.createTask({ subject: 'Signal', description: '' });
    await store.updateTask(task.id, { status: 'in_progress' });
    dispose();

    expect(listener).toHaveBeenNthCalledWith(1, {
      taskListId: 'session-1',
      operation: 'create',
      taskId: '1',
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      taskListId: 'session-1',
      operation: 'update',
      taskId: '1',
    });
  });

  it('persists empty strings and an empty metadata object', async () => {
    const task = await store.createTask({
      subject: '',
      description: '',
      activeForm: '',
      metadata: { remove: true },
    });
    const updated = await store.updateTask(task.id, {
      owner: '',
      metadata: { remove: null },
    });

    expect(updated).toMatchObject({
      subject: '',
      activeForm: '',
      owner: '',
      metadata: {},
    });
  });

  it('removes the owner field when owner is null', async () => {
    const task = await store.createTask({
      subject: 'Reassignable task',
      description: '',
    });
    await store.updateTask(task.id, { owner: 'reviewer' });

    const updated = await store.updateTask(task.id, { owner: null });

    expect(updated).not.toHaveProperty('owner');
    expect(await store.getTask(task.id)).not.toHaveProperty('owner');
  });

  it('ignores dependency updates that reference a missing task', async () => {
    const task = await store.createTask({
      subject: 'Existing',
      description: '',
    });

    await expect(
      store.updateTask(task.id, {
        addBlocks: ['999'],
        addBlockedBy: ['998'],
      }),
    ).resolves.toMatchObject({ blocks: [], blockedBy: [] });
  });

  it('clears tasks only when every persisted task is completed', async () => {
    const completed = await store.createTask({
      subject: 'Completed',
      description: '',
    });
    const pending = await store.createTask({
      subject: 'Pending',
      description: '',
    });
    await store.updateTask(completed.id, { status: 'completed' });

    await expect(store.clearCompletedTasks()).resolves.toBe(0);
    await expect(store.getTask(completed.id)).resolves.toMatchObject({
      status: 'completed',
    });

    await store.updateTask(pending.id, { status: 'completed' });
    await expect(store.clearCompletedTasks()).resolves.toBe(2);
    await expect(store.listTasks()).resolves.toEqual([]);
  });

  it('waits for an active task mutation before clearing completed tasks', async () => {
    const task = await store.createTask({
      subject: 'Reopen completed task',
      description: '',
    });
    await store.updateTask(task.id, { status: 'completed' });
    let releaseMutation: (() => void) | undefined;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let markMutationStarted: (() => void) | undefined;
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutation = store.withTaskMutation(task.id, async (context) => {
      expect(await context.getTask()).toMatchObject({ status: 'completed' });
      markMutationStarted?.();
      await mutationGate;
      return context.updateTask({ status: 'pending' });
    });
    await mutationStarted;

    let cleanupSettled = false;
    const cleanup = store.clearCompletedTasks().finally(() => {
      cleanupSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cleanupSettled).toBe(false);

    releaseMutation?.();
    await expect(mutation).resolves.toMatchObject({ status: 'pending' });
    await expect(cleanup).resolves.toBe(0);
    await expect(store.getTask(task.id)).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('does not clear a task set that changes while leases are acquired', async () => {
    const completed = await store.createTask({
      subject: 'Completed task',
      description: '',
    });
    await store.updateTask(completed.id, { status: 'completed' });
    let releaseMutation: (() => void) | undefined;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let markMutationStarted: (() => void) | undefined;
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutation = store.withTaskMutation(completed.id, async () => {
      markMutationStarted?.();
      await mutationGate;
    });
    await mutationStarted;

    let cleanupSettled = false;
    const cleanup = store.clearCompletedTasks().finally(() => {
      cleanupSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cleanupSettled).toBe(false);

    const pending = await store.createTask({
      subject: 'New pending task',
      description: '',
    });
    releaseMutation?.();

    await mutation;
    await expect(cleanup).resolves.toBe(0);
    await expect(store.getTask(completed.id)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(store.getTask(pending.id)).resolves.toMatchObject({
      status: 'pending',
    });
  });
});
