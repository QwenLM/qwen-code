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
    getTeamManager: () => null,
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

  it('canonicalizes owner filters', async () => {
    const t = await createTask(TEAM, {
      subject: 'Owned',
      description: 'desc',
    });
    await updateTask(TEAM, t.id, { owner: 'alice' });
    // Negative control: without it, dropping the owner filter entirely
    // still passes the positive assertion above.
    await createTask(TEAM, {
      subject: 'Unrelated',
      description: 'desc',
    }).then((other) => updateTask(TEAM, other.id, { owner: 'bob' }));

    const invocation = tool.build({ owner: 'Alice' });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.llmContent).toContain('Owned');
    expect(result.llmContent).not.toContain('Unrelated');
  });

  it('matches legacy raw-spelled owners against a canonical filter', async () => {
    const t = await createTask(TEAM, {
      subject: 'Legacy',
      description: 'desc',
    });
    // Owners persisted before the sanitization landed keep their raw
    // spelling on disk; the filter must still find them.
    await updateTask(TEAM, t.id, { owner: 'Bob' });

    const invocation = tool.build({ owner: 'bob' });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.llmContent).toContain('Legacy');
  });

  it('rejects owner filters that sanitize to empty', async () => {
    const invocation = tool.build({ owner: '!!!' });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(String(result.llmContent)).toContain('owner must include');
  });

  // #9281: blank optional filters must behave like absent filters,
  // matching how the tool's description/schema present them.
  describe('blank filters are treated as absent (#9281)', () => {
    it('treats an empty owner filter as no filter', async () => {
      await createTask(TEAM, {
        subject: 'Owned',
        description: 'desc',
        owner: 'alice',
      });
      await createTask(TEAM, {
        subject: 'Unowned',
        description: 'desc',
      });

      const invocation = tool.build({ owner: '' });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Owned');
      expect(result.llmContent).toContain('Unowned');
    });

    it('treats a whitespace-only owner filter as no filter', async () => {
      await createTask(TEAM, {
        subject: 'Owned',
        description: 'desc',
        owner: 'alice',
      });

      const invocation = tool.build({ owner: '   ' });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Owned');
      expect(invocation.getDescription()).toBe('List all tasks');
    });

    it('treats an empty blockedBy filter as no filter', async () => {
      await createTask(TEAM, {
        subject: 'Task A',
        description: 'desc',
      });

      const invocation = tool.build({ blockedBy: '' });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Task A');
    });

    it('treats a whitespace-only blockedBy filter as no filter', async () => {
      await createTask(TEAM, {
        subject: 'Task A',
        description: 'desc',
      });

      const invocation = tool.build({ blockedBy: '   ' });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Task A');
      expect(invocation.getDescription()).toBe('List all tasks');
    });

    it('still filters precisely by a non-empty blockedBy', async () => {
      const blocker = await createTask(TEAM, {
        subject: 'Blocker',
        description: 'desc',
      });
      const blocked = await createTask(TEAM, {
        subject: 'Blocked',
        description: 'desc',
      });
      await createTask(TEAM, {
        subject: 'Free',
        description: 'desc',
      });
      await updateTask(TEAM, blocked.id, { addBlockedBy: [blocker.id] });

      const invocation = tool.build({ blockedBy: blocker.id });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Blocked');
      expect(result.llmContent).not.toContain('Blocker');
      expect(result.llmContent).not.toContain('Free');

      const formatted = tool.build({ blockedBy: ` #${blocker.id} ` });
      const formattedResult = await formatted.execute(
        new AbortController().signal,
      );
      expect(formattedResult.error).toBeUndefined();
      expect(formattedResult.llmContent).toContain('Blocked');

      const invalid = await tool
        .build({ blockedBy: 'task-1' })
        .execute(new AbortController().signal);
      expect(invalid.error).toBeDefined();
    });

    it('rejects a non-blank blockedBy that normalizes to nothing', async () => {
      await createTask(TEAM, {
        subject: 'Task A',
        description: 'desc',
      });

      // A bare '#' must fail closed like the owner path, not activate
      // a never-matching '' filter (silent empty board) nor behave as
      // absent while getDescription() still advertises the filter.
      for (const blockedBy of ['#', ' #']) {
        const result = await tool
          .build({ blockedBy })
          .execute(new AbortController().signal);
        expect(result.error).toBeDefined();
        expect(result.llmContent).toContain('blockedBy');
      }
    });
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
