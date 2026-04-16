/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskListTool } from './task-list.js';
import { createTask, updateTask } from '../agents/team/tasks.js';

vi.mock('../config/storage.js', () => {
  let mockDir = '/tmp/test';
  return {
    Storage: {
      getGlobalQwenDir: () => mockDir,
    },
    __setMockGlobalDir: (d: string) => {
      mockDir = d;
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { __setMockGlobalDir } = (await import('../config/storage.js')) as any;

let tmpDir: string;
const TEAM = 'test-team';

function makeConfig() {
  return {
    getTeamContext: () => ({ teamName: TEAM }),
  } as unknown as import('../config/config.js').Config;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-list-test-'));
  __setMockGlobalDir(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('TaskListTool', () => {
  let tool: TaskListTool;

  beforeEach(() => {
    tool = new TaskListTool(makeConfig());
  });

  it('has the correct name', () => {
    expect(tool.name).toBe('task_list');
  });

  it('returns empty when no tasks exist', async () => {
    const invocation = tool.build({});
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('No tasks found');
  });

  it('lists created tasks', async () => {
    await createTask(TEAM, {
      subject: 'Task A',
      description: 'desc A',
    });
    await createTask(TEAM, {
      subject: 'Task B',
      description: 'desc B',
    });

    const invocation = tool.build({});
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Task A');
    expect(result.llmContent).toContain('Task B');
  });

  it('filters by status', async () => {
    const t = await createTask(TEAM, {
      subject: 'Done',
      description: 'desc',
    });
    await updateTask(TEAM, t.id, { status: 'completed' });
    await createTask(TEAM, {
      subject: 'Pending',
      description: 'desc',
    });

    const invocation = tool.build({ status: 'completed' });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.llmContent).toContain('Done');
    expect(result.llmContent).not.toContain('Pending');
  });

  it('returns TaskListResultDisplay', async () => {
    await createTask(TEAM, {
      subject: 'Task X',
      description: 'desc',
    });

    const invocation = tool.build({});
    const result = await invocation.execute(new AbortController().signal);

    const display = result.returnDisplay as {
      type: string;
      tasks: Array<{ subject: string }>;
    };
    expect(display.type).toBe('task_list');
    expect(display.tasks).toHaveLength(1);
    expect(display.tasks[0].subject).toBe('Task X');
  });

  it('accepts empty params (all optional)', () => {
    expect(() => tool.build({})).not.toThrow();
  });
});
