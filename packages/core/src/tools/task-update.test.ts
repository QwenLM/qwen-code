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

  it('rejects addBlockedBy that references a missing task', async () => {
    const task = await createTask(TEAM, {
      subject: 'Test',
      description: 'desc',
    });
    const invocation = tool.build({
      taskId: task.id,
      addBlockedBy: ['999'],
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('not found');
    expect(result.llmContent).toContain('#999');

    // Primary task must remain unchanged when validation fails so
    // the model can retry with a real id.
    const { getTask } = await import('../agents/team/tasks.js');
    const reloaded = await getTask(TEAM, task.id);
    expect(reloaded?.blockedBy ?? []).toEqual([]);
  });

  it('rejects addBlocks that references a missing task', async () => {
    const task = await createTask(TEAM, {
      subject: 'Test',
      description: 'desc',
    });
    const invocation = tool.build({
      taskId: task.id,
      addBlocks: ['999'],
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('#999');
  });

  it('mirrors dependency edges when both ids exist', async () => {
    const a = await createTask(TEAM, { subject: 'A', description: 'a' });
    const b = await createTask(TEAM, { subject: 'B', description: 'b' });
    const invocation = tool.build({
      taskId: a.id,
      addBlockedBy: [b.id],
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();

    const { getTask } = await import('../agents/team/tasks.js');
    const aReloaded = await getTask(TEAM, a.id);
    const bReloaded = await getTask(TEAM, b.id);
    expect(aReloaded?.blockedBy).toContain(b.id);
    expect(bReloaded?.blocks).toContain(a.id);
  });

  it('does not re-block a dependent when completing with addBlocks in the same call', async () => {
    // Regression (verified repro): task_update({ status:'completed',
    // addBlocks:['2'] }) merged the edge, ran completion-unblock (a
    // no-op because the reciprocal blockedBy didn't exist yet), then the
    // addBlocks reciprocal added blockedBy:['1'] back — leaving task 2
    // permanently blocked by the already-completed task 1, so auto-claim
    // would never pick it up. The tool now skips the addBlocks reciprocal
    // when the same call completes the task.
    const a = await createTask(TEAM, { subject: 'A', description: 'a' });
    const b = await createTask(TEAM, { subject: 'B', description: 'b' });

    const invocation = tool.build({
      taskId: a.id,
      status: 'completed',
      addBlocks: [b.id],
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();

    const { getTask } = await import('../agents/team/tasks.js');
    const aReloaded = await getTask(TEAM, a.id);
    const bReloaded = await getTask(TEAM, b.id);
    expect(aReloaded?.status).toBe('completed');
    // The completed blocker must leave b claimable, not blocked.
    expect(bReloaded?.blockedBy ?? []).toEqual([]);
  });

  it('rejects a self-edge', async () => {
    // A task blocked by itself can never be auto-claimed (non-empty
    // blockedBy) and can never complete to unblock itself — a silent
    // permanent deadlock if accepted.
    const task = await createTask(TEAM, { subject: 'T', description: 'd' });
    const invocation = tool.build({
      taskId: task.id,
      addBlockedBy: [task.id],
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('itself');

    const { getTask } = await import('../agents/team/tasks.js');
    const reloaded = await getTask(TEAM, task.id);
    expect(reloaded?.blockedBy ?? []).toEqual([]);
  });

  it('rejects an edge that closes a dependency cycle', async () => {
    const a = await createTask(TEAM, { subject: 'A', description: 'a' });
    const b = await createTask(TEAM, { subject: 'B', description: 'b' });
    const c = await createTask(TEAM, { subject: 'C', description: 'c' });

    // a → b → c (blocks direction), then closing c → a must fail.
    let result = await tool
      .build({ taskId: b.id, addBlockedBy: [a.id] })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    result = await tool
      .build({ taskId: c.id, addBlockedBy: [b.id] })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();

    result = await tool
      .build({ taskId: a.id, addBlockedBy: [c.id] })
      .execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('cycle');

    // The rejected edge must not be half-persisted.
    const { getTask } = await import('../agents/team/tasks.js');
    const aReloaded = await getTask(TEAM, a.id);
    expect(aReloaded?.blockedBy ?? []).toEqual([]);
  });

  // ─── Permission surface ───────────────────────────────────
  // Mirrors task-create: a regression back to 'allow' or the base ''
  // classifier sentinel re-opens the instruction-rewrite path.

  it("defaults to 'ask' permission", async () => {
    const invocation = tool.build({ taskId: '1', status: 'completed' });
    await expect(invocation.getDefaultPermission()).resolves.toBe('ask');
  });

  it('projects the mutating fields to the AUTO classifier', () => {
    const projected = tool.toAutoClassifierInput({
      taskId: '1',
      status: 'in_progress',
      owner: 'worker',
      description: 'rewritten instruction',
    });
    expect(projected).toMatchObject({
      taskId: '1',
      status: 'in_progress',
      owner: 'worker',
      description: 'rewritten instruction',
    });
  });

  it('shows an updated description in the confirmation prompt', async () => {
    const invocation = tool.build({
      taskId: '7',
      description: 'New instruction text the teammate will execute.',
    });
    const details = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    expect(details.type).toBe('info');
    expect((details as { prompt: string }).prompt).toContain(
      'New instruction text the teammate will execute.',
    );
  });
});
