/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the three cron tools (CronCreate / CronDelete / CronList).
 *
 * Strategy:
 *   - The tools reach the cron subsystem only through
 *     `config.getCronManager()`, so the seam is a fake Config carrying a fake
 *     manager. Nothing touches the real fs, and no scheduler or watcher is
 *     spun up.
 *   - Tools are exercised through their public Tool API (build → execute) so
 *     we cover param validation in addition to the invocation path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { CronTask } from './cron-tasks.js';
// `CronTask` is referenced inside vi.hoisted; its erased import keeps the
// hoisted factory typed without forcing a runtime dependency cycle.

// ---------------------------------------------------------------------------
// Fake cron manager (hoisted so the fake Config below can reference it).
// ---------------------------------------------------------------------------

const {
  taskStore,
  ensureStartedMock,
  addTaskMock,
  removeTasksMock,
  listTasksMock,
  fakeConfig,
} = vi.hoisted(() => {
  // Single shared task store so addTask / removeTasks / listTasks reflect each
  // other across calls (mirroring real semantics).
  const taskStore: CronTask[] = [];
  const ensureStartedMock = vi.fn();
  const addTaskMock = vi.fn(
    async (
      cron: string,
      prompt: string,
      recurring: boolean,
      durable: boolean,
    ) => {
      const id = `id-${taskStore.length + 1}`;
      taskStore.push({
        id,
        cron,
        prompt,
        createdAt: Date.now(),
        ...(recurring ? { recurring: true } : {}),
        ...(durable ? {} : { durable: false }),
      });
      return id;
    },
  );
  const removeTasksMock = vi.fn(async (ids: string[]) => {
    for (const id of ids) {
      const idx = taskStore.findIndex((t) => t.id === id);
      if (idx >= 0) taskStore.splice(idx, 1);
    }
  });
  const listTasksMock = vi.fn(async () => taskStore.slice());

  const manager = {
    ensureStarted: ensureStartedMock,
    addTask: addTaskMock,
    removeTasks: removeTasksMock,
    listTasks: listTasksMock,
  };

  /**
   * Minimal Config stand-in. Every cron tool now goes through
   * `getCronManager()`; CronCreate additionally reads the session id,
   * ScheduleWakeup nothing else.
   */
  const fakeConfig = {
    getSessionId: () => 'test-session',
    getProjectRoot: () => '/test-project',
    getCronManager: () => manager,
  };

  return {
    taskStore,
    ensureStartedMock,
    addTaskMock,
    removeTasksMock,
    listTasksMock,
    fakeConfig,
  };
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { CronCreateTool } from '../tools/cron-create.js';
import { CronDeleteTool } from '../tools/cron-delete.js';
import { CronListTool } from '../tools/cron-list.js';
import type { Config } from '../config/config.js';

const config = fakeConfig as unknown as Config;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

beforeEach(() => {
  taskStore.length = 0;
  ensureStartedMock.mockClear();
  addTaskMock.mockClear();
  removeTasksMock.mockClear();
  listTasksMock.mockClear();
});

// ===========================================================================
// CronCreateTool
// ===========================================================================

describe('CronCreateTool', () => {
  it('rejects an invalid cron expression with a structured error', async () => {
    const tool = new CronCreateTool(config);
    const inv = tool.build({ cron: 'not-a-cron', prompt: 'hi' });
    const result = await inv.execute(makeAbortSignal());

    // Should produce a tool-level error, not throw.
    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('Invalid cron expression');
    // Side effects should not have run on the error path.
    expect(addTaskMock).not.toHaveBeenCalled();
    expect(ensureStartedMock).not.toHaveBeenCalled();
  });

  it('rejects empty params via validateToolParams', () => {
    const tool = new CronCreateTool(config);
    expect(tool.validateToolParams({ cron: '', prompt: 'x' })).toMatch(
      /cron.*cannot be empty/i,
    );
    expect(tool.validateToolParams({ cron: '* * * * *', prompt: '   ' })).toMatch(
      /prompt.*cannot be empty/i,
    );
  });

  it('creates a recurring task and returns the create result-display shape', async () => {
    const tool = new CronCreateTool(config);
    const inv = tool.build({
      cron: '*/5 * * * *',
      prompt: 'ping',
      recurring: true,
      durable: false,
    });
    const result = await inv.execute(makeAbortSignal());

    // Public contract: a CronCreateResultDisplay carries the discriminator
    // 'create' plus echo of the inputs.
    expect(result.error).toBeUndefined();
    expect(result.returnDisplay).toMatchObject({
      cronResultType: 'create',
      cron: '*/5 * * * *',
      prompt: 'ping',
      recurring: true,
      durable: false,
    });
    expect(addTaskMock).toHaveBeenCalledWith(
      '*/5 * * * *',
      'ping',
      true,
      false,
      { permanent: false, expiresAt: undefined, customContext: undefined },
    );
    // Scheduler must be lazily started after the first successful create.
    expect(ensureStartedMock).toHaveBeenCalledTimes(1);
  });

  it('handles edge inputs: empty prompt rejected; very long prompt accepted', async () => {
    const tool = new CronCreateTool(config);

    // Empty prompt is rejected at validateToolParams level.
    expect(tool.validateToolParams({ cron: '* * * * *', prompt: '' })).toMatch(
      /prompt.*cannot be empty/i,
    );

    // Long prompts (4KB) flow through unchanged — no truncation here.
    const longPrompt = 'x'.repeat(4096);
    const inv = tool.build({ cron: '* * * * *', prompt: longPrompt });
    const result = await inv.execute(makeAbortSignal());
    expect(result.error).toBeUndefined();
    expect(addTaskMock).toHaveBeenCalledWith(
      '* * * * *',
      longPrompt,
      true, // default recurring
      false, // default durable
      { permanent: false, expiresAt: undefined, customContext: undefined },
    );
  });

  it('blocks creation when the project already has 50 tasks', async () => {
    // Pre-load the store right at the cap.
    for (let i = 0; i < 50; i++) {
      taskStore.push({
        id: `pre-${i}`,
        cron: '* * * * *',
        prompt: 'pre',
        createdAt: 0,
        recurring: true,
      });
    }

    const tool = new CronCreateTool(config);
    const inv = tool.build({ cron: '* * * * *', prompt: 'overflow' });
    const result = await inv.execute(makeAbortSignal());

    expect(result.error?.message).toMatch(/Too many scheduled jobs/i);
    expect(addTaskMock).not.toHaveBeenCalled();
    expect(ensureStartedMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// CronDeleteTool
// ===========================================================================

describe('CronDeleteTool', () => {
  it('returns the delete result-display shape and removes the task', async () => {
    taskStore.push({
      id: 'abc12345',
      cron: '* * * * *',
      prompt: 'doomed',
      createdAt: 0,
      recurring: true,
    });

    const tool = new CronDeleteTool(config);
    const inv = tool.build({ id: 'abc12345' });
    const result = await inv.execute(makeAbortSignal());

    expect(result.error).toBeUndefined();
    expect(result.returnDisplay).toMatchObject({
      cronResultType: 'delete',
      id: 'abc12345',
    });
    expect(removeTasksMock).toHaveBeenCalledWith(['abc12345']);
    expect(taskStore.find(t => t.id === 'abc12345')).toBeUndefined();
  });

  it('returns a structured error for an unknown id', async () => {
    const tool = new CronDeleteTool(config);
    const inv = tool.build({ id: 'does-not-exist' });
    const result = await inv.execute(makeAbortSignal());

    expect(result.error).toBeDefined();
    expect(result.error?.message).toMatch(/No scheduled job with id/i);
    expect(removeTasksMock).not.toHaveBeenCalled();
  });

  it('rejects empty id via validateToolParams', () => {
    const tool = new CronDeleteTool(config);
    expect(tool.validateToolParams({ id: '' })).toMatch(
      /id.*cannot be empty/i,
    );
    expect(tool.validateToolParams({ id: '   ' })).toMatch(
      /id.*cannot be empty/i,
    );
  });
});

// ===========================================================================
// CronListTool
// ===========================================================================

describe('CronListTool', () => {
  it('returns an empty list result-display when no tasks exist', async () => {
    const tool = new CronListTool(config);
    const inv = tool.build({});
    const result = await inv.execute(makeAbortSignal());

    expect(result.error).toBeUndefined();
    expect(result.returnDisplay).toEqual({
      cronResultType: 'list',
      jobs: [],
    });
    expect(result.llmContent).toBe('No scheduled jobs.');
  });

  it('returns the full list shape when tasks exist', async () => {
    taskStore.push(
      {
        id: 'job-a',
        cron: '*/5 * * * *',
        prompt: 'task A',
        createdAt: 0,
        recurring: true,
      },
      {
        id: 'job-b',
        cron: '0 9 * * 1',
        prompt: 'task B',
        createdAt: 0,
      },
    );

    const tool = new CronListTool(config);
    const inv = tool.build({});
    const result = await inv.execute(makeAbortSignal());

    expect(result.error).toBeUndefined();
    const display = result.returnDisplay as {
      cronResultType: string;
      jobs: Array<{
        id: string;
        cron: string;
        humanSchedule: string;
        prompt: string;
        recurring: boolean;
        durable: boolean;
      }>;
    };
    expect(display.cronResultType).toBe('list');
    expect(display.jobs).toHaveLength(2);

    const a = display.jobs.find(j => j.id === 'job-a')!;
    expect(a.cron).toBe('*/5 * * * *');
    expect(a.recurring).toBe(true);
    expect(typeof a.humanSchedule).toBe('string');
    expect(a.humanSchedule.length).toBeGreaterThan(0);

    const b = display.jobs.find(j => j.id === 'job-b')!;
    expect(b.recurring).toBe(false);
  });
});
