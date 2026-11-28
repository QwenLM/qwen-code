/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { processQueueIfReady } from './queueProcessor.js';
import { QueryGuard } from './QueryGuard.js';
import {
  enqueue,
  enqueuePendingNotification,
  getCommandQueueLength,
  someInFlightDrainCommand,
  _resetQueueForTest,
} from './messageQueueManager.js';
import {
  getAgentContext,
  runWithAgentContext,
} from '../utils/agentContext.js';

describe('queueProcessor', () => {
  let executeInput: ReturnType<typeof vi.fn>;
  let queryGuard: QueryGuard;

  const processQueue = () =>
    processQueueIfReady({ executeInput, queryGuard });

  beforeEach(() => {
    _resetQueueForTest();
    executeInput = vi.fn().mockResolvedValue(undefined);
    queryGuard = new QueryGuard();
  });

  it('returns processed: false on empty queue', () => {
    const result = processQueue();
    expect(result.processed).toBe(false);
    expect(executeInput).not.toHaveBeenCalled();
  });

  it('processes a single prompt command', () => {
    enqueue({ prompt: 'hello', commandMode: 'prompt' });

    const result = processQueue();
    expect(result.processed).toBe(true);
    expect(executeInput).toHaveBeenCalledTimes(1);
    expect(executeInput.mock.calls[0][0]).toHaveLength(1);
    expect(executeInput.mock.calls[0][0][0].prompt).toBe('hello');
    expect(getCommandQueueLength()).toBe(0);
  });

  it('batches multiple commands with same commandMode', () => {
    enqueuePendingNotification({
      prompt: '<notif-1>',
      commandMode: 'task-notification',
    });
    enqueuePendingNotification({
      prompt: '<notif-2>',
      commandMode: 'task-notification',
    });

    const result = processQueue();
    expect(result.processed).toBe(true);
    expect(executeInput).toHaveBeenCalledTimes(1);
    const commands = executeInput.mock.calls[0][0];
    expect(commands).toHaveLength(2);
    expect(commands[0].prompt).toBe('<notif-1>');
    expect(commands[1].prompt).toBe('<notif-2>');
  });

  it('does not mix different commandModes in one batch', () => {
    enqueue({ prompt: 'user input', commandMode: 'prompt', priority: 'next' });
    enqueuePendingNotification({
      prompt: '<notif>',
      commandMode: 'task-notification',
    });

    const result = processQueue();
    expect(result.processed).toBe(true);
    // Only the highest priority (prompt with 'next') should be processed
    expect(executeInput.mock.calls[0][0]).toHaveLength(1);
    expect(executeInput.mock.calls[0][0][0].commandMode).toBe('prompt');
    // task-notification should remain
    expect(getCommandQueueLength()).toBe(1);
  });

  it('processes slash commands individually', () => {
    enqueue({ prompt: '/help', commandMode: 'prompt' });
    enqueue({ prompt: '/clear', commandMode: 'prompt' });

    const result = processQueue();
    expect(result.processed).toBe(true);
    // Only one slash command processed
    expect(executeInput).toHaveBeenCalledTimes(1);
    expect(executeInput.mock.calls[0][0]).toHaveLength(1);
    expect(executeInput.mock.calls[0][0][0].prompt).toBe('/help');
    // Second slash command remains
    expect(getCommandQueueLength()).toBe(1);
  });

  it('batches an absolute-path prompt with adjacent regular prompts', () => {
    enqueue({
      prompt: '/Users/me/project 这里面有啥',
      commandMode: 'prompt',
    });
    enqueue({ prompt: '再看看测试', commandMode: 'prompt' });

    const result = processQueue();

    expect(result.processed).toBe(true);
    expect(executeInput).toHaveBeenCalledTimes(1);
    expect(executeInput.mock.calls[0][0]).toHaveLength(2);
    expect(getCommandQueueLength()).toBe(0);
  });

  it('processes bash commands individually', () => {
    enqueue({ prompt: 'ls -la', commandMode: 'bash' });
    enqueue({ prompt: 'pwd', commandMode: 'bash' });

    const result = processQueue();
    expect(result.processed).toBe(true);
    expect(executeInput).toHaveBeenCalledTimes(1);
    expect(executeInput.mock.calls[0][0]).toHaveLength(1);
    expect(executeInput.mock.calls[0][0][0].prompt).toBe('ls -la');
    expect(getCommandQueueLength()).toBe(1);
  });

  it('skips sub-agent commands', () => {
    enqueuePendingNotification({
      prompt: '<agent-notif>',
      commandMode: 'task-notification',
      targetAgentId: 'sub-1',
    });

    const result = processQueue();
    expect(result.processed).toBe(false);
    expect(executeInput).not.toHaveBeenCalled();
    // Sub-agent command stays in queue
    expect(getCommandQueueLength()).toBe(1);
  });

  it('processes main-thread commands while skipping sub-agent ones', () => {
    enqueuePendingNotification({
      prompt: '<agent-notif>',
      commandMode: 'task-notification',
      targetAgentId: 'sub-1',
    });
    enqueuePendingNotification({
      prompt: '<main-notif>',
      commandMode: 'task-notification',
    });

    const result = processQueue();
    expect(result.processed).toBe(true);
    expect(executeInput.mock.calls[0][0]).toHaveLength(1);
    expect(executeInput.mock.calls[0][0][0].prompt).toBe('<main-notif>');
    // Sub-agent command remains
    expect(getCommandQueueLength()).toBe(1);
  });

  it('reserves synchronously and retains the dispatched batch until settle', async () => {
    let resolveExecution: (() => void) | undefined;
    executeInput.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveExecution = resolve;
        }),
    );
    enqueuePendingNotification({
      prompt: '<notif>',
      commandMode: 'task-notification',
    });

    const result = processQueue();

    expect(result.processed).toBe(true);
    expect(queryGuard.isActive).toBe(true);
    expect(someInFlightDrainCommand(() => true)).toBe(true);

    resolveExecution?.();
    await vi.waitFor(() => {
      expect(queryGuard.isActive).toBe(false);
      expect(someInFlightDrainCommand(() => true)).toBe(false);
    });
  });

  it('does not dequeue when another dispatch owns the guard', () => {
    enqueue({ prompt: 'hello', commandMode: 'prompt' });
    expect(queryGuard.reserve()).toBe(true);

    const result = processQueue();

    expect(result.processed).toBe(false);
    expect(executeInput).not.toHaveBeenCalled();
    expect(getCommandQueueLength()).toBe(1);
  });

  it('leaves a running query to release the guard', async () => {
    executeInput.mockImplementation(async () => {
      expect(queryGuard.tryStart()).not.toBeNull();
    });
    enqueue({ prompt: 'hello', commandMode: 'prompt' });

    const result = processQueue();
    await vi.waitFor(() =>
      expect(someInFlightDrainCommand(() => true)).toBe(false),
    );

    expect(result.processed).toBe(true);
    expect(queryGuard.isActive).toBe(true);
    queryGuard.forceEnd();
    expect(queryGuard.isActive).toBe(false);
  });

  it('dispatches the main loop without inheriting teammate agent context', async () => {
    const observed: Array<ReturnType<typeof getAgentContext>> = [];
    executeInput.mockImplementation(async () => {
      observed.push(getAgentContext());
      await Promise.resolve();
      observed.push(getAgentContext());
    });

    runWithAgentContext(
      {
        agentId: 'agent-worker-1',
        agentType: 'engineer',
        agentName: 'worker-1',
        teamName: 'team-1',
      },
      () => {
        enqueue({
          prompt:
            '<teammate-message from="worker-1">done</teammate-message>',
          commandMode: 'prompt',
          priority: 'next',
          isMeta: true,
        });
        expect(processQueue().processed).toBe(true);
      },
    );

    await vi.waitFor(() => expect(observed).toHaveLength(2));
    expect(observed).toEqual([undefined, undefined]);
  });
});
