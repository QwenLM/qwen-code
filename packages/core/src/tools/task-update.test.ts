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
import { createTask, getTask, updateTask } from '../agents/team/tasks.js';
import type { ApprovalMode, Config } from '../config/config.js';
import { runWithTeammateIdentity } from '../agents/team/identity.js';

type UpdateTask = (typeof import('../agents/team/tasks.js'))['updateTask'];

const taskUpdateMock = vi.hoisted(() => ({
  beforeUpdate: undefined as
    | ((updateTask: UpdateTask) => Promise<void>)
    | undefined,
}));

vi.mock('../agents/team/tasks.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../agents/team/tasks.js')>();
  return {
    ...original,
    updateTask: async (...args: Parameters<UpdateTask>) => {
      const beforeUpdate = taskUpdateMock.beforeUpdate;
      taskUpdateMock.beforeUpdate = undefined;
      if (beforeUpdate) await beforeUpdate(original.updateTask);
      return original.updateTask(...args);
    },
  };
});

const DEFAULT_MODE = 'default' as ApprovalMode;
const PLAN_MODE = 'plan' as ApprovalMode;

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

function makeConfig(approvalMode = DEFAULT_MODE, teamManager: unknown = null) {
  return {
    getTeamContext: () => ({ teamName: TEAM }),
    getApprovalMode: () => approvalMode,
    getTeamManager: () => teamManager,
  } as unknown as Config;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-update-test-'));
  __setMockGlobalDir(tmpDir);
});

afterEach(async () => {
  taskUpdateMock.beforeUpdate = undefined;
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

  it('reports not-found, not a derived refusal, for a missing task', async () => {
    // Existence must be answered before the assignment gates: with a
    // missing task the blocked-by set built from this same call's
    // addBlockedBy (and the owner validation) would otherwise produce a
    // wrong reason that sends the caller down a dead end. The referenced
    // blocker must exist so the up-front referenced-ids check passes and
    // only the primary-task existence check can answer; a missing
    // referenced id would satisfy the same assertions on its own and
    // leave this pin blind to the fix it guards.
    const blocker = await createTask(TEAM, {
      subject: 'Blocker',
      description: 'Referenced by the missing task',
    });
    const invocation = tool.build({
      taskId: '999',
      status: 'in_progress',
      owner: 'alice',
      addBlockedBy: [blocker.id],
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(String(result.llmContent)).toContain('not found');
    expect(String(result.llmContent)).not.toContain('blocked by');
  });

  it('allows plan-required teammates to claim a task before approval', async () => {
    const task = await createTask(TEAM, {
      subject: 'Plan first',
      description: 'desc',
    });
    const planTool = new TaskUpdateTool(makeConfig(PLAN_MODE));
    const invocation = planTool.build({
      taskId: task.id,
      status: 'in_progress',
    });

    const result = await runWithTeammateIdentity(
      {
        agentName: 'planner',
        teamName: TEAM,
        agentId: 'planner@test-team',
        isTeamLead: false,
        planModeRequired: true,
      },
      () => invocation.execute(new AbortController().signal),
    );

    expect(result.error).toBeUndefined();
    const reloaded = await getTask(TEAM, task.id);
    expect(reloaded?.status).toBe('in_progress');
    expect(reloaded?.owner).toBe('planner');
  });

  it('blocks plan-required teammates from mutating tasks before approval', async () => {
    const task = await createTask(TEAM, {
      subject: 'Plan first',
      description: 'desc',
    });
    const planTool = new TaskUpdateTool(makeConfig(PLAN_MODE));
    const invocation = planTool.build({
      taskId: task.id,
      description: 'New executable instruction.',
    });

    const result = await runWithTeammateIdentity(
      {
        agentName: 'planner',
        teamName: TEAM,
        agentId: 'planner@test-team',
        isTeamLead: false,
        planModeRequired: true,
      },
      () => invocation.execute(new AbortController().signal),
    );

    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('waiting for leader approval');
    const reloaded = await getTask(TEAM, task.id);
    expect(reloaded?.description).toBe('desc');
  });

  it('does not let plan-required teammates reclaim non-pending tasks before approval', async () => {
    const task = await createTask(TEAM, {
      subject: 'Completed',
      description: 'desc',
    });
    await tool
      .build({ taskId: task.id, status: 'completed' })
      .execute(new AbortController().signal);

    const planTool = new TaskUpdateTool(makeConfig(PLAN_MODE));
    const result = await runWithTeammateIdentity(
      {
        agentName: 'planner',
        teamName: TEAM,
        agentId: 'planner@test-team',
        isTeamLead: false,
        planModeRequired: true,
      },
      () =>
        planTool
          .build({ taskId: task.id, status: 'in_progress' })
          .execute(new AbortController().signal),
    );

    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('unowned pending task');
    const reloaded = await getTask(TEAM, task.id);
    expect(reloaded?.status).toBe('completed');
  });

  it('allows sequential reassignment while the current owner is active', async () => {
    const dispatchedOwners: string[] = [];
    const teamManager = {
      validateTaskOwner: () => undefined,
      dispatchAssignedTask: vi.fn(async (task: { owner?: string }) => {
        if (task.owner) dispatchedOwners.push(task.owner);
        return true;
      }),
    };
    tool = new TaskUpdateTool(makeConfig(DEFAULT_MODE, teamManager));
    const task = await createTask(TEAM, {
      subject: 'Assigned',
      description: 'desc',
      owner: 'alice',
    });
    await updateTask(TEAM, task.id, { status: 'in_progress' });

    const result = await tool
      .build({ taskId: task.id, owner: 'bob' })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(dispatchedOwners).toEqual(['bob']);
    expect((await getTask(TEAM, task.id))?.owner).toBe('bob');
  });

  it('reassigns without consulting the previous owner activity', async () => {
    const dispatchedOwners: string[] = [];
    const validateTaskOwner = vi.fn(() => undefined);
    const teamManager = {
      validateTaskOwner,
      dispatchAssignedTask: vi.fn(async (task: { owner?: string }) => {
        if (task.owner) dispatchedOwners.push(task.owner);
        return true;
      }),
    };
    tool = new TaskUpdateTool(makeConfig(DEFAULT_MODE, teamManager));
    const task = await createTask(TEAM, {
      subject: 'Recovery',
      description: 'desc',
      owner: 'alice',
    });
    await updateTask(TEAM, task.id, { status: 'in_progress' });

    const result = await tool
      .build({ taskId: task.id, owner: 'bob' })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(validateTaskOwner).toHaveBeenCalledWith('bob');
    expect(validateTaskOwner).not.toHaveBeenCalledWith('alice');
    expect(dispatchedOwners).toEqual(['bob']);
    expect((await getTask(TEAM, task.id))?.owner).toBe('bob');
  });

  it('rejects an owner update from a stale unowned snapshot', async () => {
    const dispatchAssignedTask = vi.fn(async () => true);
    const teamManager = {
      validateTaskOwner: vi.fn(() => undefined),
      dispatchAssignedTask,
    };
    tool = new TaskUpdateTool(makeConfig(DEFAULT_MODE, teamManager));
    const task = await createTask(TEAM, {
      subject: 'Pending',
      description: 'desc',
    });
    taskUpdateMock.beforeUpdate = async (realUpdateTask) => {
      await realUpdateTask(
        TEAM,
        task.id,
        { status: 'in_progress', owner: 'alice' },
        { callerName: 'alice' },
      );
    };

    const result = await tool
      .build({ taskId: task.id, owner: 'bob' })
      .execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('owner changed');
    expect(result.error?.message).toContain('content-only task_update');
    expect(result.error?.message).toContain(
      'without re-delivering the assignment',
    );
    expect(dispatchAssignedTask).not.toHaveBeenCalled();
    expect(await getTask(TEAM, task.id)).toMatchObject({
      status: 'in_progress',
      owner: 'alice',
    });
  });

  it('rejects an assignment from a stale status snapshot', async () => {
    const dispatchAssignedTask = vi.fn(async () => true);
    const teamManager = {
      validateTaskOwner: vi.fn(() => undefined),
      dispatchAssignedTask,
    };
    tool = new TaskUpdateTool(makeConfig(DEFAULT_MODE, teamManager));
    const task = await createTask(TEAM, {
      subject: 'Assigned',
      description: 'desc',
      owner: 'alice',
    });
    await updateTask(TEAM, task.id, { status: 'in_progress' });
    taskUpdateMock.beforeUpdate = async (realUpdateTask) => {
      await realUpdateTask(
        TEAM,
        task.id,
        { status: 'completed' },
        { callerName: 'alice' },
      );
    };

    const result = await tool
      .build({ taskId: task.id, status: 'in_progress', owner: 'bob' })
      .execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('status changed');
    expect(dispatchAssignedTask).not.toHaveBeenCalled();
    expect(await getTask(TEAM, task.id)).toMatchObject({
      status: 'completed',
      owner: 'alice',
    });
  });

  it('rejects a status-only update from a stale snapshot', async () => {
    const dispatchAssignedTask = vi.fn(async () => true);
    const teamManager = {
      validateTaskOwner: vi.fn(() => undefined),
      dispatchAssignedTask,
    };
    tool = new TaskUpdateTool(makeConfig(DEFAULT_MODE, teamManager));
    const task = await createTask(TEAM, {
      subject: 'Pending',
      description: 'desc',
    });
    taskUpdateMock.beforeUpdate = async (realUpdateTask) => {
      await realUpdateTask(
        TEAM,
        task.id,
        { status: 'in_progress', owner: 'alice' },
        { callerName: 'alice' },
      );
    };

    const result = await tool
      .build({ taskId: task.id, status: 'completed' })
      .execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('owner changed');
    expect(result.error?.message).toContain('status changed');
    expect(result.error?.message).not.toContain('without re-delivering');
    expect(dispatchAssignedTask).not.toHaveBeenCalled();
    expect(await getTask(TEAM, task.id)).toMatchObject({
      status: 'in_progress',
      owner: 'alice',
    });
  });

  it('does not dispatch during a stale content-only update', async () => {
    const dispatchAssignedTask = vi.fn(async () => true);
    const teamManager = {
      validateTaskOwner: vi.fn(() => undefined),
      dispatchAssignedTask,
    };
    tool = new TaskUpdateTool(makeConfig(DEFAULT_MODE, teamManager));
    const task = await createTask(TEAM, {
      subject: 'Pending',
      description: 'desc',
    });
    taskUpdateMock.beforeUpdate = async (realUpdateTask) => {
      await realUpdateTask(
        TEAM,
        task.id,
        { status: 'in_progress', owner: 'alice' },
        { callerName: 'alice' },
      );
    };

    const result = await tool
      .build({ taskId: task.id, subject: 'New title' })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(dispatchAssignedTask).not.toHaveBeenCalled();
    expect(await getTask(TEAM, task.id)).toMatchObject({
      subject: 'New title',
      status: 'in_progress',
      owner: 'alice',
    });
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
