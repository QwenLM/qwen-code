/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { Task } from '../services/task-store.js';
import { TaskUpdateTool, type TaskUpdateParams } from './task-update.js';
import type { TaskUpdateDiffDisplay, ToolResult } from './tools.js';

type TaskUpdateToolTestable = TaskUpdateTool & {
  createInvocation: (params: TaskUpdateParams) => {
    execute: (signal: AbortSignal) => Promise<ToolResult>;
  };
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Do the thing',
    status: 'pending',
    priority: 'medium',
    description: undefined,
    createdBy: 'agent',
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeConfig(before: Task | null, after: Task | null) {
  const store = {
    get: vi.fn().mockReturnValue(before ?? undefined),
    update: vi.fn().mockReturnValue(after ?? undefined),
    list: vi.fn().mockReturnValue(after ? [after] : []),
  };
  return {
    getTaskStore: () => store,
    _store: store,
  } as unknown as Config;
}

function createInvocation(
  config: Config,
  params: TaskUpdateParams,
): { execute: (signal: AbortSignal) => Promise<ToolResult> } {
  return (
    new TaskUpdateTool(config) as TaskUpdateToolTestable
  ).createInvocation(params);
}

describe('task-update returnDisplay', () => {
  it('returns task_update_diff type', async () => {
    const before = makeTask({ status: 'pending' });
    const after = makeTask({ status: 'in_progress' });
    const config = makeConfig(before, after);
    const invocation = createInvocation(config, {
      taskId: 'task-1',
      status: 'in_progress',
    });
    const result = await invocation.execute(new AbortController().signal);
    const display = result.returnDisplay as TaskUpdateDiffDisplay;

    expect(display.type).toBe('task_update_diff');
  });

  it('includes taskId and post-update title in display', async () => {
    const before = makeTask({ status: 'pending' });
    const after = makeTask({ status: 'in_progress' });
    const config = makeConfig(before, after);
    const invocation = createInvocation(config, {
      taskId: 'task-1',
      status: 'in_progress',
    });
    const result = await invocation.execute(new AbortController().signal);
    const display = result.returnDisplay as TaskUpdateDiffDisplay;

    expect(display.taskId).toBe('task-1');
    expect(display.title).toBe('Do the thing');
  });

  it('shows status diff when status changes', async () => {
    const before = makeTask({ status: 'pending' });
    const after = makeTask({ status: 'in_progress' });
    const config = makeConfig(before, after);
    const invocation = createInvocation(config, {
      taskId: 'task-1',
      status: 'in_progress',
    });
    const result = await invocation.execute(new AbortController().signal);
    const display = result.returnDisplay as TaskUpdateDiffDisplay;

    expect(display.changes).toContainEqual({
      field: 'status',
      from: 'pending',
      to: 'in_progress',
    });
  });

  it('shows title diff when title changes', async () => {
    const before = makeTask({ title: 'Old title' });
    const after = makeTask({ title: 'New title' });
    const config = makeConfig(before, after);
    const invocation = createInvocation(config, {
      taskId: 'task-1',
      title: 'New title',
    });
    const result = await invocation.execute(new AbortController().signal);
    const display = result.returnDisplay as TaskUpdateDiffDisplay;

    expect(display.changes).toContainEqual({
      field: 'title',
      from: 'Old title',
      to: 'New title',
    });
  });

  it('shows priority diff when priority changes', async () => {
    const before = makeTask({ priority: 'low' });
    const after = makeTask({ priority: 'high' });
    const config = makeConfig(before, after);
    const invocation = createInvocation(config, {
      taskId: 'task-1',
      priority: 'high',
    });
    const result = await invocation.execute(new AbortController().signal);
    const display = result.returnDisplay as TaskUpdateDiffDisplay;

    expect(display.changes).toContainEqual({
      field: 'priority',
      from: 'low',
      to: 'high',
    });
  });

  it('shows description diff when description changes', async () => {
    const before = makeTask({ description: 'Before desc' });
    const after = makeTask({ description: 'After desc' });
    const config = makeConfig(before, after);
    const invocation = createInvocation(config, {
      taskId: 'task-1',
      description: 'After desc',
    });
    const result = await invocation.execute(new AbortController().signal);
    const display = result.returnDisplay as TaskUpdateDiffDisplay;

    expect(display.changes).toContainEqual({
      field: 'description',
      from: 'Before desc',
      to: 'After desc',
    });
  });

  it('returns empty changes array when no field values differ', async () => {
    const task = makeTask({ status: 'pending' });
    const after = makeTask({ status: 'pending' });
    const config = makeConfig(task, after);
    const invocation = createInvocation(config, {
      taskId: 'task-1',
      status: 'pending',
    });
    const result = await invocation.execute(new AbortController().signal);
    const display = result.returnDisplay as TaskUpdateDiffDisplay;

    expect(display.changes).toEqual([]);
  });

  it('omits fields that did not change', async () => {
    const before = makeTask({ status: 'pending', title: 'Same title' });
    const after = makeTask({ status: 'in_progress', title: 'Same title' });
    const config = makeConfig(before, after);
    const invocation = createInvocation(config, {
      taskId: 'task-1',
      status: 'in_progress',
    });
    const result = await invocation.execute(new AbortController().signal);
    const display = result.returnDisplay as TaskUpdateDiffDisplay;

    expect(display.changes).toHaveLength(1);
    expect(display.changes[0].field).toBe('status');
  });

  it('returns error string display when task not found', async () => {
    const config = makeConfig(null, null);
    const invocation = createInvocation(config, {
      taskId: 'missing',
      status: 'completed',
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(result.returnDisplay).toContain('not found');
  });
});
