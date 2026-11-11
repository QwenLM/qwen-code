/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_AGENT_TEAMS, ENV_CONFIG_DIR } from '../config/brand.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { TaskStore } from '../tasks/task-store.js';
import {
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
} from './taskTools.js';
import { TASK_UPDATE_DECLARATION } from './definitions/taskTools.js';
import {
  registerTeammateController,
  resetTeammateControllersForTest,
} from '../agents/teams/agent-team-controller.js';
import {
  readAgentTeamConfig,
  upsertAgentTeamMember,
} from '../agents/teams/agent-team-runtime.js';
import { deriveSessionTeamName } from '../agents/teams/agent-teams-feature.js';
import { _resetConfigHomeDirCache } from '../utils/paths.js';
import { runWithAgentContext } from '../utils/agentContext.js';

describe('task tools', () => {
  let rootDir: string;
  let store: TaskStore;
  let config: Config;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-tools-test-'));
    store = new TaskStore(rootDir, 'session');
    config = {
      getTaskStore: () => store,
      getHookSystem: () => undefined,
    } as unknown as Config;
  });

  afterEach(async () => {
    resetTeammateControllersForTest();
    vi.unstubAllEnvs();
    _resetConfigHomeDirCache();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('uses an upstream-compatible TaskUpdate input schema', () => {
    expect(TASK_UPDATE_DECLARATION.parametersJsonSchema).toMatchObject({
      type: 'object',
      required: ['taskId'],
    });
    expect(TASK_UPDATE_DECLARATION.parametersJsonSchema).not.toHaveProperty(
      'anyOf',
    );
  });

  it('creates, gets, updates, and lists tasks', async () => {
    const create = await new TaskCreateTool(config).buildAndExecute(
      { subject: 'Implement feature', description: 'Acceptance criteria' },
      new AbortController().signal,
    );
    expect(create.llmContent).toContain('Task #1 created successfully');
    expect(create.toolUseResult).toEqual({
      task: { id: '1', subject: 'Implement feature' },
    });

    const get = await new TaskGetTool(config).buildAndExecute(
      { taskId: '1' },
      new AbortController().signal,
    );
    expect(get.llmContent).toContain('Task #1: Implement feature');
    expect(get.toolUseResult).toEqual({
      task: {
        id: '1',
        subject: 'Implement feature',
        description: 'Acceptance criteria',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      },
    });

    const update = await new TaskUpdateTool(config).buildAndExecute(
      { taskId: '1', status: 'in_progress', owner: 'worker-1' },
      new AbortController().signal,
    );
    expect(update.llmContent).toBe('Updated task #1 owner, status');
    expect(update.toolUseResult).toEqual({
      success: true,
      taskId: '1',
      updatedFields: ['owner', 'status'],
      statusChange: { from: 'pending', to: 'in_progress' },
    });

    const list = await new TaskListTool(config).buildAndExecute(
      {},
      new AbortController().signal,
    );
    expect(list.llmContent).toContain(
      '#1 [in_progress] Implement feature (worker-1)',
    );
    expect(list.toolUseResult).toEqual({
      tasks: [
        {
          id: '1',
          subject: 'Implement feature',
          status: 'in_progress',
          owner: 'worker-1',
          blockedBy: [],
        },
      ],
    });
  });

  it('uses the task result text protocol', async () => {
    const emptyList = await new TaskListTool(config).buildAndExecute(
      {},
      new AbortController().signal,
    );
    expect(emptyList.llmContent).toBe('No tasks found');
    expect(emptyList.toolUseResult).toEqual({ tasks: [] });

    const missing = await new TaskGetTool(config).buildAndExecute(
      { taskId: 'missing' },
      new AbortController().signal,
    );
    expect(missing.llmContent).toBe('Task not found');
    expect(missing.error).toBeUndefined();
    expect(missing.toolUseResult).toEqual({ task: null });

    const missingUpdate = await new TaskUpdateTool(config).buildAndExecute(
      { taskId: 'missing', status: 'completed' },
      new AbortController().signal,
    );
    expect(missingUpdate.toolUseResult).toEqual({
      success: false,
      taskId: 'missing',
      updatedFields: [],
      error: 'Task not found',
    });

    await store.createTask({
      subject: 'First',
      description: 'No dependencies',
    });
    const details = await new TaskGetTool(config).buildAndExecute(
      { taskId: '1' },
      new AbortController().signal,
    );
    expect(details.llmContent).toBe(
      'Task #1: First\nStatus: pending\nDescription: No dependencies',
    );

    const deleted = await new TaskUpdateTool(config).buildAndExecute(
      { taskId: '1', status: 'deleted' },
      new AbortController().signal,
    );
    expect(deleted.llmContent).toBe('Updated task #1 deleted');
    expect(deleted.toolUseResult).toEqual({
      success: true,
      taskId: '1',
      updatedFields: ['deleted'],
    });
  });

  it('rolls back a created task when the hook blocks', async () => {
    const finalOutput = {
      shouldStopExecution: vi.fn().mockReturnValue(false),
      getBlockingError: vi
        .fn()
        .mockReturnValue({ blocked: true, reason: 'policy rejected task' }),
    };
    config = {
      getTaskStore: () => store,
      getHookSystem: () =>
        ({
          fireTaskCreatedEvent: vi.fn().mockResolvedValue({ finalOutput }),
        }) as never,
    } as unknown as Config;

    const result = await new TaskCreateTool(config).buildAndExecute(
      { subject: 'Rejected', description: '' },
      new AbortController().signal,
    );

    expect(result.error?.message).toBe('policy rejected task');
    expect(await store.listTasks()).toEqual([]);
  });

  it('does not persist completion when the hook blocks', async () => {
    const task = await store.createTask({ subject: 'Work', description: '' });
    const finalOutput = {
      shouldStopExecution: vi.fn().mockReturnValue(false),
      getBlockingError: vi
        .fn()
        .mockReturnValue({ blocked: true, reason: 'verification failed' }),
    };
    config = {
      getTaskStore: () => store,
      getHookSystem: () =>
        ({
          fireTaskCompletedEvent: vi.fn().mockResolvedValue({ finalOutput }),
        }) as never,
    } as unknown as Config;

    const result = await new TaskUpdateTool(config).buildAndExecute(
      { taskId: task.id, status: 'completed' },
      new AbortController().signal,
    );

    expect(result.error?.message).toBe('verification failed');
    expect(result.toolUseResult).toEqual({
      success: false,
      taskId: task.id,
      updatedFields: [],
      error: 'verification failed',
    });
    expect((await store.getTask(task.id))?.status).toBe('pending');
  });

  it('runs the completion hook once for concurrent updates of one task', async () => {
    const task = await store.createTask({ subject: 'Work', description: '' });
    let releaseHook: (() => void) | undefined;
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    let markHookStarted: (() => void) | undefined;
    const hookStarted = new Promise<void>((resolve) => {
      markHookStarted = resolve;
    });
    const fireTaskCompletedEvent = vi.fn(async () => {
      markHookStarted?.();
      await hookGate;
      return undefined;
    });
    config = {
      getTaskStore: () => store,
      getHookSystem: () =>
        ({
          fireTaskCompletedEvent,
        }) as never,
    } as unknown as Config;

    const signal = new AbortController().signal;
    const firstUpdate = new TaskUpdateTool(config).buildAndExecute(
      { taskId: task.id, status: 'completed' },
      signal,
    );
    await hookStarted;
    let secondUpdateSettled = false;
    const secondUpdate = new TaskUpdateTool(config)
      .buildAndExecute(
        { taskId: task.id, status: 'completed' },
        signal,
      )
      .finally(() => {
        secondUpdateSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(secondUpdateSettled).toBe(false);
    expect(fireTaskCompletedEvent).toHaveBeenCalledTimes(1);

    releaseHook?.();
    await expect(firstUpdate).resolves.toMatchObject({
      llmContent: `Updated task #${task.id} status`,
    });
    await expect(secondUpdate).resolves.toMatchObject({
      llmContent: `Updated task #${task.id}`,
    });
    expect(fireTaskCompletedEvent).toHaveBeenCalledTimes(1);
    expect(await store.getTask(task.id)).toMatchObject({
      status: 'completed',
    });
  });

  it('hides internal tasks and completed blockers from TaskList', async () => {
    const blocker = await store.createTask({
      subject: 'Done',
      description: '',
    });
    const blocked = await store.createTask({
      subject: 'Visible',
      description: '',
    });
    await store.createTask({
      subject: 'Internal',
      description: '',
      metadata: { _internal: true },
    });
    await store.updateTask(blocked.id, { addBlockedBy: [blocker.id] });
    await store.updateTask(blocker.id, { status: 'completed' });

    const result = await new TaskListTool(config).buildAndExecute(
      {},
      new AbortController().signal,
    );

    expect(result.llmContent).toContain('#2 [pending] Visible');
    expect(result.llmContent).not.toContain('blocked by');
    expect(result.llmContent).not.toContain('Internal');
    expect(result.toolUseResult).toEqual({
      tasks: [
        {
          id: blocker.id,
          subject: 'Done',
          status: 'completed',
          blockedBy: [],
        },
        {
          id: blocked.id,
          subject: 'Visible',
          status: 'pending',
          blockedBy: [],
        },
      ],
    });
  });

  it('does not apply Agent Teams ownership semantics to ordinary updates', async () => {
    const task = await store.createTask({
      subject: 'Start work',
      description: '',
    });

    const result = await new TaskUpdateTool(config).buildAndExecute(
      { taskId: task.id, status: 'in_progress' },
      new AbortController().signal,
    );

    expect(result.error).toBeUndefined();
    expect(await store.getTask(task.id)).toMatchObject({
      status: 'in_progress',
    });
    expect((await store.getTask(task.id))?.owner).toBeUndefined();
  });

  it('does not assign main as owner when main starts a task', async () => {
    vi.stubEnv(ENV_AGENT_TEAMS, '1');
    const task = await store.createTask({
      subject: 'Coordinate review',
      description: '',
    });

    const result = await new TaskUpdateTool(config).buildAndExecute(
      { taskId: task.id, status: 'in_progress' },
      new AbortController().signal,
    );

    expect(result.error).toBeUndefined();
    expect(await store.getTask(task.id)).toMatchObject({
      status: 'in_progress',
    });
    expect((await store.getTask(task.id))?.owner).toBeUndefined();
  });

  it('assigns the current teammate when it starts an unowned task', async () => {
    vi.stubEnv(ENV_AGENT_TEAMS, '1');
    config = {
      getTaskStore: () => store,
      getHookSystem: () => undefined,
      getSessionId: () => 'session-root',
    } as unknown as Config;
    const task = await store.createTask({
      subject: 'Review implementation',
      description: '',
    });

    const result = await runWithAgentContext(
      {
        agentId: 'agent-architect',
        agentType: 'Reviewer',
        agentName: 'architect',
        teamName: 'session-root',
      },
      () =>
        new TaskUpdateTool(config).buildAndExecute(
          { taskId: task.id, status: 'in_progress' },
          new AbortController().signal,
        ),
    );

    expect(result.error).toBeUndefined();
    expect(await store.getTask(task.id)).toMatchObject({
      status: 'in_progress',
      owner: 'architect',
    });
  });

  it('signals an idle in-process teammate when assigning a task', async () => {
    vi.stubEnv(ENV_AGENT_TEAMS, '1');
    vi.stubEnv(ENV_CONFIG_DIR, rootDir);
    _resetConfigHomeDirCache();
    const sessionId = 'session-root';
    const teamName = deriveSessionTeamName(sessionId);
    await upsertAgentTeamMember({
      teamName,
      leadSessionId: sessionId,
      member: {
        name: 'architect',
        agentId: 'agent-architect',
        agentType: 'Reviewer',
        sessionId,
        status: 'idle',
      },
    });
    registerTeammateController('agent-architect');
    config = {
      getTaskStore: () => store,
      getHookSystem: () => undefined,
      getSessionId: () => sessionId,
    } as unknown as Config;
    const task = await store.createTask({
      subject: 'Review architecture',
      description: 'Check module boundaries',
    });

    const result = await new TaskUpdateTool(config).buildAndExecute(
      {
        taskId: task.id,
        status: 'in_progress',
        owner: 'architect',
      },
      new AbortController().signal,
    );

    expect(result.error).toBeUndefined();
    expect(await store.getTask(task.id)).toMatchObject({
      status: 'in_progress',
      owner: 'architect',
    });
    expect(await readAgentTeamConfig(teamName)).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({
          name: 'architect',
          status: 'idle',
        }),
      ]),
    });
  });

  it('coerces TaskCreate wrappers, aliases, and missing titles', async () => {
    const wrapped = {
      task: {
        title: 'Wrapped title',
        content: 'Wrapped description',
        active_form: 'Creating wrapped task',
        status: 'pending',
      },
    };
    const result = await new TaskCreateTool(config).buildAndExecute(
      wrapped as never,
      new AbortController().signal,
    );

    expect(result.llmContent).toBe(
      'Task #1 created successfully: Wrapped title',
    );
    expect(await store.getTask('1')).toMatchObject({
      subject: 'Wrapped title',
      description: 'Wrapped description',
      activeForm: 'Creating wrapped task',
    });
  });

  it('coerces TaskUpdate parameter aliases', async () => {
    const task = await store.createTask({
      subject: 'Alias update',
      description: '',
    });
    const input = {
      task_id: task.id,
      active_form: 'Updating aliases',
    };

    const result = await new TaskUpdateTool(config).buildAndExecute(
      input as never,
      new AbortController().signal,
    );

    expect(result.llmContent).toBe(`Updated task #${task.id} activeForm`);
    expect(await store.getTask(task.id)).toMatchObject({
      activeForm: 'Updating aliases',
    });
  });
});
