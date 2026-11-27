/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryTurn } from '../core/query-turn.js';
import type { Terminal } from '../core/query-event.js';
import type { TurnRunStartInput, TurnRunEndInput } from '../core/turn-hooks.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import { CronFireRegistry } from './cron-fire-registry.js';
import { CronTurn } from './cron-turn.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

const marker = '[Running scheduled task (fixture)]';
const input: Omit<TurnRunStartInput, 'turnId' | 'agentId'> = {
  taskId: 'query-task',
  promptText: 'hello',
  isSubagent: false,
  isWorkflow: false,
  isRemoteWorker: false,
  trigger: 'user_prompt',
};
const terminal: Terminal = {
  reason: 'end_turn',
  numTurns: 2,
  durationMs: 50,
  usage: {
    ...cloneUsage(),
    input_tokens: 10,
    output_tokens: 3,
    cache_read_input_tokens: 7,
    cache_creation: {
      ephemeral_1h_input_tokens: 2,
      ephemeral_5m_input_tokens: 4,
    },
  },
};
const completion = {
  taskId: 'query-task',
  promptId: 'prompt',
  terminal,
  requestIndex: 5,
  model: 'final-model',
  statistics: {
    totalCredits: 4,
    totalOriginalCredits: 6,
    firstRequestCacheReadTokens: 7,
  },
};

/** Drives the real hook chain so the tests do not reach into private methods. */
function lifecycle(getManager: ConstructorParameters<typeof CronTurn>[0]) {
  const module = new CronTurn(getManager).turnHookModule;
  const turn = new QueryTurn({
    turnId: 'turn',
    sessionId: 'session',
    signal: new AbortController().signal,
    modules: [module],
  });
  return {
    turn,
    turnHookModule: module,
    prepare: (input: Omit<TurnRunStartInput, 'turnId' | 'agentId'>) =>
      turn.runStart(input).trigger,
    finish: (input: Omit<TurnRunEndInput, 'turnId' | 'agentId'>) =>
      turn.runEnd(input),
  };
}

function fixture() {
  const registry = new CronFireRegistry();
  const manager = {
    claimPendingFires: vi.fn((text: string) =>
      registry.claimPendingFires(text),
    ),
    markUserActivity: vi.fn(),
    addTaskCredits: vi.fn().mockResolvedValue(undefined),
    addWakeupCredits: vi.fn(),
  };
  const getManager = vi.fn(() => manager);
  const cron = lifecycle(getManager);
  const { turn } = cron;
  const seed = (id = 'task', wakeup = false) =>
    registry.registerFire({ taskId: id, isWakeup: wakeup });
  return { registry, manager, getManager, cron, turn, seed };
}

describe('Cron turn preparation', () => {
  it.each(['manager', 'claim', 'activity'] as const)(
    'preserves preparation failure from %s without replay',
    (source) => {
      const { cron, manager, getManager } = fixture();
      const failure = new Error(source);
      if (source === 'manager')
        getManager.mockImplementation(() => {
          throw failure;
        });
      else if (source === 'claim')
        manager.claimPendingFires.mockImplementation(() => {
          throw failure;
        });
      else
        manager.markUserActivity.mockImplementation(() => {
          throw failure;
        });
      expect(() => cron.prepare(input)).toThrow(failure);
      expect(getManager).toHaveBeenCalledTimes(source === 'activity' ? 2 : 1);
      expect(manager.claimPendingFires).toHaveBeenCalledTimes(
        source === 'manager' ? 0 : 1,
      );
    },
  );

  it('does not claim or mark presence at turn.start before preparation', async () => {
    const { cron, turn, seed, registry, manager, getManager } = fixture();
    seed();
    await turn.start(marker);
    await turn.complete('abort');
    cron.finish(completion);
    expect(registry.pendingFireCount()).toBe(1);
    expect(getManager).not.toHaveBeenCalled();
    expect(manager.markUserActivity).not.toHaveBeenCalled();
  });

  it.each([
    {
      scheduled: false,
      child: false,
      workflow: false,
      remote: false,
      trigger: 'user_prompt',
      presence: 1,
    },
    {
      scheduled: true,
      child: false,
      workflow: false,
      remote: false,
      trigger: 'scheduled',
      presence: 0,
    },
    {
      scheduled: true,
      child: true,
      workflow: true,
      remote: false,
      trigger: 'subagent',
      presence: 0,
    },
    {
      scheduled: true,
      child: false,
      workflow: true,
      remote: false,
      trigger: 'workflow',
      presence: 0,
    },
    {
      scheduled: false,
      child: false,
      workflow: true,
      remote: false,
      trigger: 'workflow',
      presence: 1,
    },
    {
      scheduled: false,
      child: false,
      workflow: false,
      remote: true,
      trigger: 'user_prompt',
      presence: 0,
    },
    {
      scheduled: false,
      child: true,
      workflow: false,
      remote: false,
      trigger: 'subagent',
      presence: 0,
    },
  ])(
    'preserves source and presence for %j',
    ({ scheduled, child, workflow, remote, trigger, presence }) => {
      const { cron, seed, manager } = fixture();
      if (scheduled) seed();
      expect(
        cron.prepare({
          ...input,
          promptText: marker,
          isSubagent: child,
          isWorkflow: workflow,
          isRemoteWorker: remote,
        }),
      ).toBe(trigger);
      expect(manager.markUserActivity).toHaveBeenCalledTimes(presence);
    },
  );

  it('uses actual claims, not prompt markers or explicit source labels, for presence', () => {
    const { cron, manager } = fixture();
    expect(
      cron.prepare({ ...input, promptText: marker, trigger: 'scheduled' }),
    ).toBe('scheduled');
    expect(manager.markUserActivity).toHaveBeenCalledOnce();
  });

  it('preserves unknown and continuation sources', () => {
    expect(fixture().cron.prepare({ ...input, trigger: undefined })).toBe(
      'unknown',
    );
    expect(fixture().cron.prepare({ ...input, trigger: 'continuation' })).toBe(
      'continuation',
    );
  });

  it('leaves unrelated and excess fires parked and isolates session registries', () => {
    const first = fixture();
    const second = fixture();
    first.seed('a');
    first.seed('b');
    second.seed('c');
    expect(second.cron.prepare(input)).toBe('user_prompt');
    expect(first.cron.prepare({ ...input, promptText: marker })).toBe(
      'scheduled',
    );
    expect(first.registry.pendingFireCount()).toBe(1);
    expect(second.registry.pendingFireCount()).toBe(1);
  });

  it('prunes expired fires at preparation time rather than turn.start', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { cron, turn, seed, manager } = fixture();
    seed();
    await turn.start(marker);
    now += 3 * 60 * 60 * 1000;
    expect(cron.prepare({ ...input, promptText: marker })).toBe('user_prompt');
    expect(manager.markUserActivity).toHaveBeenCalledOnce();
  });
});

describe('Cron turn settlement', () => {
  it('splits the turn cost across a claimed task and a claimed wakeup', () => {
    const { cron, seed, manager } = fixture();
    seed('task');
    seed('wakeup', true);
    cron.prepare({ ...input, promptText: `${marker}\n${marker}` });
    cron.finish(completion);

    expect(manager.addWakeupCredits).toHaveBeenCalledExactlyOnceWith(2);
    expect(manager.addTaskCredits).toHaveBeenCalledExactlyOnceWith('task', 2);
  });

  it.each([0, -1])(
    'charges nothing when the turn reports no credits (%i)',
    (totalCredits) => {
      const { cron, seed, manager } = fixture();
      seed('task');
      cron.prepare({ ...input, promptText: marker });
      cron.finish({
        ...completion,
        statistics: { ...completion.statistics, totalCredits },
      });
      expect(manager.addTaskCredits).not.toHaveBeenCalled();
    },
  );

  it('charges synchronously at the run.end hook boundary, not at turn.complete', async () => {
    const { cron, turn, seed, manager } = fixture();
    seed('wakeup', true);
    await turn.start(marker);
    cron.prepare({ ...input, promptText: marker });
    turn.recordTerminal(terminal);
    expect(manager.addWakeupCredits).not.toHaveBeenCalled();
    cron.finish(completion);
    expect(manager.addWakeupCredits).toHaveBeenCalledExactlyOnceWith(4);
    await turn.complete('end_turn');
    expect(manager.addWakeupCredits).toHaveBeenCalledOnce();
  });

  it('does not wait for asynchronous accounting and suppresses its rejection', async () => {
    const { cron, seed, manager } = fixture();
    seed();
    seed('wakeup', true);
    let reject!: (reason: Error) => void;
    manager.addTaskCredits.mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    cron.prepare({ ...input, promptText: `${marker}\n${marker}` });
    expect(cron.finish(completion)).toBeUndefined();
    expect(manager.addWakeupCredits).toHaveBeenCalledExactlyOnceWith(2);
    reject(new Error('store failed'));
    await Promise.resolve();
  });

  it('does nothing when no manager is available', () => {
    const cron = lifecycle(() => undefined);
    expect(cron.prepare(input)).toBe('user_prompt');
    expect(cron.finish(completion)).toBeUndefined();
  });
});
