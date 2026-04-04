/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskUpdateTool } from './task-update.js';
import { createTask } from '../agents/team/tasks.js';

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-update-test-'));
  __setMockGlobalDir(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('TaskUpdateTool', () => {
  let tool: TaskUpdateTool;

  beforeEach(() => {
    tool = new TaskUpdateTool(makeConfig());
  });

  it('has the correct name', () => {
    expect(tool.name).toBe('task_update');
  });

  it('updates a task status', async () => {
    const task = await createTask(TEAM, {
      subject: 'Test',
      description: 'desc',
    });
    const invocation = tool.build({
      taskId: task.id,
      status: 'completed',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('completed');
  });

  it('deletes a task with status "deleted"', async () => {
    const task = await createTask(TEAM, {
      subject: 'Delete me',
      description: 'desc',
    });
    const invocation = tool.build({
      taskId: task.id,
      status: 'deleted',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('deleted');
  });

  it('returns error for non-existent task', async () => {
    const invocation = tool.build({
      taskId: '999',
      status: 'completed',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('not found');
  });

  it('validates required taskId', () => {
    expect(() => tool.build({} as never)).toThrow();
  });
});
