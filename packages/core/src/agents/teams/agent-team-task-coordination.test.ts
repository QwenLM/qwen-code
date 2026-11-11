/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../config/config.js';
import { TaskStore } from '../../tasks/task-store.js';
import {
  buildClaimedTaskPrompt,
  claimNextAvailableTask,
  releaseClaimedTask,
} from './agent-team-task-coordination.js';

describe('agent team task coordination', () => {
  let rootDir: string;
  let taskStore: TaskStore;
  let config: Config;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), 'test-team-tasks-'));
    taskStore = new TaskStore(rootDir, 'session-root');
    config = {
      getTaskStore: () => taskStore,
    } as unknown as Config;
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('claims the first unowned and unblocked pending task', async () => {
    const blocker = await taskStore.createTask({
      subject: 'Prepare API',
      description: 'Define the API',
    });
    await taskStore.updateTask(blocker.id, {
      status: 'in_progress',
      owner: 'team-lead',
    });
    const blocked = await taskStore.createTask({
      subject: 'Implement client',
      description: 'Use the API',
    });
    await taskStore.updateTask(blocked.id, {
      addBlockedBy: [blocker.id],
    });
    const available = await taskStore.createTask({
      subject: 'Write migration notes',
      description: 'Document compatibility',
    });

    const claimed = await claimNextAvailableTask(config, 'architect');

    expect(claimed).toMatchObject({
      id: available.id,
      owner: 'architect',
      status: 'in_progress',
    });
    expect(buildClaimedTaskPrompt(claimed!)).toContain(
      `Start with task #${available.id}`,
    );
  });

  it('does not assign one task to two teammates', async () => {
    const task = await taskStore.createTask({
      subject: 'Review implementation',
      description: 'Check behavior',
    });

    const [first, second] = await Promise.all([
      claimNextAvailableTask(config, 'architect'),
      claimNextAvailableTask(config, 'reviewer'),
    ]);

    const claims = [first, second].filter((entry) => entry !== null);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      id: task.id,
      status: 'in_progress',
    });
  });

  it('releases only a task still owned by the failed teammate launch', async () => {
    const task = await taskStore.createTask({
      subject: 'Review implementation',
      description: 'Check behavior',
    });
    await claimNextAvailableTask(config, 'reviewer');

    await expect(
      releaseClaimedTask(config, task.id, 'architect'),
    ).resolves.toBe(false);
    await expect(
      releaseClaimedTask(config, task.id, 'reviewer'),
    ).resolves.toBe(true);

    expect(await taskStore.getTask(task.id)).toMatchObject({
      id: task.id,
      status: 'pending',
    });
    expect(await taskStore.getTask(task.id)).not.toHaveProperty('owner');
  });
});
