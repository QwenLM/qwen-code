/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BACKGROUND_AGENT_CONCURRENCY_ENV,
  BackgroundTaskRegistry,
  DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS,
  MAX_CONCURRENT_BACKGROUND_AGENTS,
  MAX_RETAINED_TERMINAL_AGENTS,
  resolveMaxConcurrentBackgroundAgents,
  type AgentTaskRegistration,
  type BackgroundApproval,
  type BackgroundTaskEntry,
} from './background-tasks.js';
import * as transcript from './agent-transcript.js';
import { AgentEventEmitter, AgentEventType } from './runtime/agent-events.js';
import { ToolConfirmationOutcome } from '../tools/tools.js';

function makeApproval(
  callId: string,
  respond: BackgroundApproval['respond'] = vi.fn(async () => {}),
): BackgroundApproval {
  return {
    callId,
    name: 'Shell',
    description: `run ${callId}`,
    confirmationDetails: {
      type: 'exec',
    } as BackgroundApproval['confirmationDetails'],
    respond,
    at: Date.now(),
  };
}

function makeRegistration(
  agentId: string,
  overrides: Partial<AgentTaskRegistration> = {},
): AgentTaskRegistration {
  return {
    agentId,
    description: agentId,
    status: 'running',
    startTime: Date.now(),
    abortController: new AbortController(),
    isBackgrounded: true,
    outputFile: `/tmp/${agentId}.jsonl`,
    ...overrides,
  };
}

describe('BackgroundTaskRegistry', () => {
  let registry: BackgroundTaskRegistry;

  beforeEach(() => {
    registry = new BackgroundTaskRegistry();
  });

  it('registers and retrieves a background agent', () => {
    const entry = {
      agentId: 'test-1',
      description: 'test agent',
      status: 'running' as const,
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    };

    registry.register(entry);
    expect(registry.get('test-1')).toBe(entry);
  });

  it('completes a background agent and sends notification', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.complete('test-1', 'The result text');

    const entry = registry.get('test-1')!;
    expect(entry.status).toBe('completed');
    expect(entry.result).toBe('The result text');
    expect(entry.endTime).toBeDefined();
    expect(callback).toHaveBeenCalledOnce();
    const [displayText, modelText] = callback.mock.calls[0] as [string, string];
    // Display text: short summary without the full result
    expect(displayText).toContain('completed');
    expect(displayText).toContain('test agent');
    expect(displayText).not.toContain('The result text');
    // Model text: full details including result for the LLM
    expect(modelText).toContain('The result text');
  });

  it('fails a background agent and sends notification', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.fail('test-1', 'Something went wrong');

    const entry = registry.get('test-1')!;
    expect(entry.status).toBe('failed');
    expect(entry.error).toBe('Something went wrong');
    expect(callback).toHaveBeenCalledOnce();
    const [displayText] = callback.mock.calls[0] as [string, string];
    expect(displayText).toContain('failed');
  });

  it('cancels a running background agent without emitting a notification', () => {
    // cancel() is intent-only: it aborts the signal and marks the entry
    // cancelled, but does not emit a task-notification. The natural
    // completion handler (bgBody) emits the terminal notification with
    // the agent's real partial/final result via complete()/fail().
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    const abortController = new AbortController();

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController,
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.cancel('test-1');

    expect(registry.get('test-1')!.status).toBe('cancelled');
    expect(abortController.signal.aborted).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('persists explicit cancellations as cancelled sidecar state', () => {
    const patchSpy = vi
      .spyOn(transcript, 'patchAgentMeta')
      .mockImplementation(() => undefined);
    try {
      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        metaPath: '/tmp/test-1.meta.json',
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      });

      registry.cancel('test-1');

      expect(patchSpy).toHaveBeenCalledWith(
        '/tmp/test-1.meta.json',
        expect.objectContaining({
          status: 'cancelled',
          lastError: undefined,
        }),
      );
    } finally {
      patchSpy.mockRestore();
    }
  });

  it('emits a fallback cancelled notification after the grace period when the natural handler never runs', () => {
    vi.useFakeTimers();
    try {
      const callback = vi.fn();
      registry.setNotificationCallback(callback);

      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      });

      registry.cancel('test-1');
      expect(callback).not.toHaveBeenCalled();

      // Pathological tool case: bgBody never emits. After the grace period
      // the fallback fires so hasUnfinalizedTasks() stops reporting true
      // and the headless wait loop can exit.
      vi.runAllTimers();

      expect(callback).toHaveBeenCalledOnce();
      const [, modelText] = callback.mock.calls[0] as [string, string];
      expect(modelText).toContain('<status>cancelled</status>');
      expect(registry.hasUnfinalizedTasks()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the fallback notification when the natural handler finalizes first', () => {
    vi.useFakeTimers();
    try {
      const callback = vi.fn();
      registry.setNotificationCallback(callback);

      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      });

      registry.cancel('test-1');
      // Natural handler wins the race with the partial result.
      registry.finalizeCancelled('test-1', 'partial output');
      expect(callback).toHaveBeenCalledOnce();
      callback.mockClear();

      vi.runAllTimers();

      // Fallback lands on a notified entry and no-ops.
      expect(callback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('finalizeCancellationIfPending emits a fallback cancelled notification', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.cancel('test-1');
    registry.finalizeCancellationIfPending('test-1');

    expect(callback).toHaveBeenCalledOnce();
    const [, modelText] = callback.mock.calls[0] as [string, string];
    expect(modelText).toContain('<status>cancelled</status>');
  });

  it('complete() after the cancellation has already been notified is a no-op', () => {
    // Once finalizeCancelled has emitted the terminal notification, a
    // late-arriving complete() must not double-fire — the SDK contract
    // is one notification per task_started.
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.cancel('test-1');
    registry.finalizeCancelled('test-1', 'partial');
    expect(callback).toHaveBeenCalledOnce();
    callback.mockClear();

    registry.complete('test-1', 'late result');

    expect(callback).not.toHaveBeenCalled();
    // Status stays cancelled — the notified terminal state wins.
    expect(registry.get('test-1')!.status).toBe('cancelled');
    expect(registry.get('test-1')!.result).toBe('partial');
  });

  it('does not cancel a non-running agent', () => {
    const abortController = new AbortController();

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController,
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.complete('test-1', 'done');
    registry.cancel('test-1'); // should be a no-op

    expect(registry.get('test-1')!.status).toBe('completed');
    expect(abortController.signal.aborted).toBe(false);
  });

  it('abandons a paused agent without emitting a notification', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'paused-1',
      description: 'paused agent',
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.abandon('paused-1');

    expect(registry.get('paused-1')!.status).toBe('cancelled');
    expect(registry.get('paused-1')!.notified).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('abandons a paused agent and rejects parked approvals', () => {
    const respond = vi.fn(async () => {});

    registry.register({
      agentId: 'paused-approval',
      description: 'paused agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    registry.addPendingApproval('paused-approval', makeApproval('c1', respond));
    registry.get('paused-approval')!.status = 'paused';

    registry.abandon('paused-approval');

    expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
    expect(registry.getPendingApprovals('paused-approval')).toEqual([]);
  });

  it('does not treat paused entries as unfinalized work', () => {
    registry.register({
      agentId: 'paused-1',
      description: 'paused agent',
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    expect(registry.hasUnfinalizedTasks()).toBe(false);
  });

  it('lists running agents', () => {
    registry.register({
      agentId: 'a',
      description: 'agent a',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    registry.register({
      agentId: 'b',
      description: 'agent b',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.complete('a', 'done');

    const running = registry.getAll().filter((e) => e.status === 'running');
    expect(running).toHaveLength(1);
    expect(running[0].agentId).toBe('b');
  });

  describe('background concurrency limit', () => {
    it('resolves the default and env override for the background agent cap', () => {
      expect(resolveMaxConcurrentBackgroundAgents({})).toBe(
        DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS,
      );
      expect(
        resolveMaxConcurrentBackgroundAgents({
          [BACKGROUND_AGENT_CONCURRENCY_ENV]: '3',
        }),
      ).toBe(3);
      expect(
        resolveMaxConcurrentBackgroundAgents({
          [BACKGROUND_AGENT_CONCURRENCY_ENV]: '0',
        }),
      ).toBe(DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS);
      expect(MAX_CONCURRENT_BACKGROUND_AGENTS).toBeGreaterThanOrEqual(1);
    });

    it('rejects hex / scientific / non-decimal-integer overrides and falls back', () => {
      // Number('0x10')=16, Number('1e2')=100 and Number('1.0')=1 all pass
      // Number.isInteger, so the loose parse silently accepted them. The cap
      // should only honor plain decimal integers, like the rest of the codebase.
      for (const raw of ['0x10', '1e2', '1.0']) {
        expect(
          resolveMaxConcurrentBackgroundAgents({
            [BACKGROUND_AGENT_CONCURRENCY_ENV]: raw,
          }),
        ).toBe(DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS);
      }
    });

    it('rejects new running background agents once the cap is reached', () => {
      registry = new BackgroundTaskRegistry({
        maxConcurrentBackgroundAgents: 2,
      });

      registry.register(makeRegistration('bg-1'));
      registry.register(makeRegistration('bg-2'));

      expect(() => registry.register(makeRegistration('bg-3'))).toThrow(
        'Cannot start background agent: maximum concurrent background agents ' +
          '(2) reached. Stop an existing agent first.',
      );
      expect(registry.get('bg-3')).toBeUndefined();
    });

    it('allows replacing the same running background agent at the cap', () => {
      registry = new BackgroundTaskRegistry({
        maxConcurrentBackgroundAgents: 1,
      });

      registry.register(makeRegistration('bg-1'));

      expect(() =>
        registry.register(
          makeRegistration('bg-1', {
            prompt: 'resumed continuation',
          }),
        ),
      ).not.toThrow();
      expect(registry.get('bg-1')?.prompt).toBe('resumed continuation');
    });

    it('does not count foreground, paused, or terminal entries toward the cap', () => {
      registry = new BackgroundTaskRegistry({
        maxConcurrentBackgroundAgents: 1,
      });

      registry.register(
        makeRegistration('fg-1', {
          isBackgrounded: false,
        }),
      );
      registry.register(
        makeRegistration('paused-1', {
          status: 'paused',
        }),
      );

      registry.register(makeRegistration('bg-1'));
      expect(() => registry.register(makeRegistration('bg-2'))).toThrow(
        'maximum concurrent background agents (1) reached',
      );

      registry.complete('bg-1', 'done');
      registry.register(makeRegistration('bg-2'));

      expect(registry.get('fg-1')).toBeDefined();
      expect(registry.get('paused-1')).toBeDefined();
      expect(registry.get('bg-2')?.status).toBe('running');
    });
  });

  it('aborts all running agents and emits fallback notifications', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    const ac1 = new AbortController();
    const ac2 = new AbortController();

    registry.register({
      agentId: 'a',
      description: 'agent a',
      status: 'running',
      startTime: Date.now(),
      abortController: ac1,
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    registry.register({
      agentId: 'b',
      description: 'agent b',
      status: 'running',
      startTime: Date.now(),
      abortController: ac2,
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.abortAll();

    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);
    expect(registry.get('a')!.status).toBe('cancelled');
    expect(registry.get('b')!.status).toBe('cancelled');
    // abortAll is a shutdown path — no natural handler will fire, so
    // finalizeCancellationIfPending emits one cancelled notification per
    // agent to keep the SDK contract intact.
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('abortAll({ notify: false }) suppresses terminal notifications from old tasks', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'a',
      description: 'agent a',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.abortAll({ notify: false });

    expect(registry.get('a')!.status).toBe('cancelled');
    expect(registry.hasUnfinalizedTasks()).toBe(false);
    expect(callback).not.toHaveBeenCalled();

    registry.complete('a', 'late result');
    registry.finalizeCancelled('a', 'late partial');

    expect(callback).not.toHaveBeenCalled();
    expect(registry.get('a')!.status).toBe('cancelled');
    expect(registry.get('a')!.result).toBeUndefined();
  });

  it('abortAll({ notify: false }) suppresses pending fallback notifications', () => {
    vi.useFakeTimers();
    try {
      const callback = vi.fn();
      registry.setNotificationCallback(callback);

      registry.register({
        agentId: 'a',
        description: 'agent a',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      });

      registry.cancel('a');
      registry.abortAll({ notify: false });
      vi.runAllTimers();

      expect(callback).not.toHaveBeenCalled();
      expect(registry.hasUnfinalizedTasks()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hasUnfinalizedTasks reports cancelled-but-not-notified entries', () => {
    // Headless runs rely on this to keep the event loop alive after a
    // task_stop until the agent's natural handler has emitted the
    // terminal task-notification — otherwise the matching notification
    // can be dropped before stream-json/SDK consumers observe it.
    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    expect(registry.hasUnfinalizedTasks()).toBe(true);

    registry.cancel('test-1');
    expect(registry.get('test-1')!.status).toBe('cancelled');
    expect(registry.hasUnfinalizedTasks()).toBe(true);

    registry.finalizeCancelled('test-1', '');
    expect(registry.hasUnfinalizedTasks()).toBe(false);
  });

  it('hasUnfinalizedTasks clears once every entry has been notified', () => {
    registry.register({
      agentId: 'a',
      description: 'agent a',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    registry.register({
      agentId: 'b',
      description: 'agent b',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    expect(registry.hasUnfinalizedTasks()).toBe(true);
    registry.complete('a', 'done');
    expect(registry.hasUnfinalizedTasks()).toBe(true);
    registry.fail('b', 'boom');
    expect(registry.hasUnfinalizedTasks()).toBe(false);
  });

  it('complete after cancellation surfaces the real result', () => {
    // When cancel races with the natural completion handler, the agent's
    // reasoning loop may have finished with a real result before the abort
    // landed. complete() transitions cancelled → completed and emits the
    // terminal notification carrying that real result, instead of letting
    // the bare "cancelled" notification discard it.
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.cancel('test-1');
    registry.complete('test-1', 'real result after cancel race');

    expect(registry.get('test-1')!.status).toBe('completed');
    expect(registry.get('test-1')!.result).toBe(
      'real result after cancel race',
    );
    expect(callback).toHaveBeenCalledTimes(1);
    const [, modelText] = callback.mock.calls[0];
    expect(modelText).toContain('<status>completed</status>');
    expect(modelText).toContain('real result after cancel race');
  });

  it('fail after cancellation surfaces the real error', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.cancel('test-1');
    registry.fail('test-1', 'real error after cancel race');

    expect(registry.get('test-1')!.status).toBe('failed');
    expect(registry.get('test-1')!.error).toBe('real error after cancel race');
    expect(callback).toHaveBeenCalledTimes(1);
    const [, modelText] = callback.mock.calls[0];
    expect(modelText).toContain('<status>failed</status>');
  });

  it('second terminal call does not double-notify', () => {
    // Once a terminal notification has fired, subsequent terminal calls
    // (from late fire-and-forget paths) must not produce a duplicate.
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.complete('test-1', 'first');
    registry.fail('test-1', 'late error');

    expect(callback).toHaveBeenCalledTimes(1);
    expect(registry.get('test-1')!.status).toBe('completed');
  });

  it('does not send notification without callback', () => {
    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    // Should not throw
    registry.complete('test-1', 'done');
    expect(registry.get('test-1')!.status).toBe('completed');
  });

  it('propagates toolUseId through XML and notification meta', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      toolUseId: 'call-abc-123',
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.complete('test-1', 'done');

    expect(callback).toHaveBeenCalledOnce();
    const [, modelText, meta] = callback.mock.calls[0];
    expect(modelText).toContain('<tool-use-id>call-abc-123</tool-use-id>');
    expect(meta.toolUseId).toBe('call-abc-123');
  });

  it('omits tool-use-id XML tag when toolUseId is absent', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'test-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.complete('test-1', 'done');

    const [, modelText, meta] = callback.mock.calls[0];
    expect(modelText).not.toContain('<tool-use-id>');
    expect(meta.toolUseId).toBeUndefined();
  });

  it('getAll returns every entry regardless of status', () => {
    registry.register({
      agentId: 'a',
      description: 'agent a',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    registry.register({
      agentId: 'b',
      description: 'agent b',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    registry.register({
      agentId: 'c',
      description: 'agent c',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.complete('a', 'done');
    registry.fail('b', 'boom');

    const all = registry.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.status).sort()).toEqual([
      'completed',
      'failed',
      'running',
    ]);
    // Callers that need only running entries filter getAll() themselves.
    expect(
      registry
        .getAll()
        .filter((e) => e.status === 'running')
        .map((e) => e.agentId),
    ).toEqual(['c']);
  });

  it('statusChange callback fires on register and every state transition', () => {
    const seen: Array<{ id: string; status: string }> = [];
    registry.setStatusChangeCallback((entry) => {
      if (entry) {
        seen.push({ id: entry.agentId, status: entry.status });
      }
    });

    registry.register({
      agentId: 'a',
      description: 'agent a',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    registry.register({
      agentId: 'b',
      description: 'agent b',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    registry.complete('a', 'ok');
    registry.fail('b', 'err');

    expect(seen).toEqual([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'running' },
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'failed' },
    ]);
  });

  it('statusChange callback errors do not break registry operations', () => {
    registry.setStatusChangeCallback(() => {
      throw new Error('listener broke');
    });

    // Should not throw even though the callback does.
    expect(() =>
      registry.register({
        agentId: 'a',
        description: 'agent a',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      }),
    ).not.toThrow();
    expect(registry.get('a')?.status).toBe('running');
  });

  it('statusChange callback can be cleared with undefined', () => {
    const cb = vi.fn();
    registry.setStatusChangeCallback(cb);
    registry.setStatusChangeCallback(undefined);

    registry.register({
      agentId: 'a',
      description: 'agent a',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    expect(cb).not.toHaveBeenCalled();
  });

  it('appendActivity builds a rolling buffer capped at 5', () => {
    registry.register({
      agentId: 'a',
      description: 'agent a',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    for (let i = 0; i < 7; i++) {
      registry.appendActivity('a', {
        name: `Tool${i}`,
        description: `call ${i}`,
        at: i,
      });
    }

    const activities = registry.get('a')!.recentActivities ?? [];
    expect(activities.map((a) => a.name)).toEqual([
      'Tool2',
      'Tool3',
      'Tool4',
      'Tool5',
      'Tool6',
    ]);
  });

  it('appendActivity no-ops after the agent terminates', () => {
    registry.register({
      agentId: 'a',
      description: 'agent a',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.complete('a', 'done');
    registry.appendActivity('a', { name: 'Late', description: 'x', at: 99 });

    expect(registry.get('a')!.recentActivities ?? []).toHaveLength(0);
  });

  it('appendActivity fires activityChange, not statusChange', () => {
    const statusCb = vi.fn();
    const activityCb = vi.fn();
    registry.setStatusChangeCallback(statusCb);
    registry.setActivityChangeCallback(activityCb);

    registry.register({
      agentId: 'a',
      description: 'agent a',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    statusCb.mockClear();
    activityCb.mockClear();

    registry.appendActivity('a', { name: 'T', description: 'd', at: 0 });

    expect(statusCb).not.toHaveBeenCalled();
    expect(activityCb).toHaveBeenCalledOnce();
    expect(activityCb.mock.calls[0][0].agentId).toBe('a');
  });

  it('stores prompt verbatim on the entry', () => {
    registry.register({
      agentId: 'a',
      description: 'agent a',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Run sleep 30 and report done.',
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    expect(registry.get('a')!.prompt).toBe('Run sleep 30 and report done.');
  });

  it('escapes XML metacharacters in interpolated fields', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    registry.register({
      agentId: 'test-1',
      description: 'summarize </result> & </task-notification>',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    registry.complete('test-1', 'here is <b>bold</b> & </task-notification>');

    const [, modelText] = callback.mock.calls[0];
    // No injected closing tags — subagent text is escaped so the
    // parent envelope stays a single task-notification element.
    expect(modelText.match(/<\/task-notification>/g)!.length).toBe(1);
    expect(modelText).toContain('&lt;/result&gt;');
    expect(modelText).toContain('&lt;/task-notification&gt;');
    expect(modelText).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(modelText).toContain('&amp;');
  });

  describe('terminal-entry retention cap', () => {
    function makeRegisteredEntry(id: string, startTime: number) {
      return {
        agentId: id,
        description: id,
        status: 'running' as const,
        startTime,
        abortController: new AbortController(),
        outputFile: `/tmp/${id}.jsonl`,
        isBackgrounded: true,
      };
    }

    it('retains only a bounded number of fully-finalized terminal entries', () => {
      // Register and complete one more entry than the cap allows so
      // the prune kicks in. Use strictly increasing startTimes so the
      // synthetic endTimes (Date.now() inside complete) preserve a
      // deterministic eviction order via the startTime tiebreaker.
      for (let i = 0; i < MAX_RETAINED_TERMINAL_AGENTS + 2; i++) {
        registry.register(makeRegisteredEntry(`a-${i}`, i * 1000));
        registry.complete(`a-${i}`, 'done');
      }
      expect(registry.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_AGENTS);
      // The two oldest (`a-0`, `a-1`) get pruned; the newest survives.
      expect(registry.get('a-0')).toBeUndefined();
      expect(registry.get('a-1')).toBeUndefined();
      expect(
        registry.get(`a-${MAX_RETAINED_TERMINAL_AGENTS + 1}`),
      ).toBeDefined();
    });

    it('never evicts running entries even when terminal entries blow past the cap', () => {
      // The user's only handle on a live subagent is its row in the
      // dialog; a prune that drops a running entry would silently
      // strand work in progress.
      registry.register(makeRegisteredEntry('live', 1));
      for (let i = 0; i < MAX_RETAINED_TERMINAL_AGENTS + 1; i++) {
        registry.register(makeRegisteredEntry(`done-${i}`, 100 + i * 1000));
        registry.complete(`done-${i}`, 'done');
      }
      // Cap-of-32 terminals + 1 running survivor = 33 entries kept.
      expect(registry.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_AGENTS + 1);
      expect(registry.get('live')?.status).toBe('running');
      // The oldest terminal entry is the one evicted.
      expect(registry.get('done-0')).toBeUndefined();
    });

    it('never evicts paused entries (recoverable, awaiting resume/abandon)', () => {
      // Manually plant a paused entry — the registry exposes
      // abandon/resume but no public "transition to paused" call;
      // resume restoration on Config init writes paused entries
      // directly via register().
      registry.register({
        agentId: 'paused-1',
        description: 'paused',
        status: 'paused',
        startTime: 1,
        abortController: new AbortController(),
        outputFile: '/tmp/paused-1.jsonl',
        isBackgrounded: true,
      });
      // Push terminal entries past the cap so prune is forced to choose
      // an eviction set.
      for (let i = 0; i < MAX_RETAINED_TERMINAL_AGENTS + 1; i++) {
        registry.register(makeRegisteredEntry(`done-${i}`, 100 + i * 1000));
        registry.complete(`done-${i}`, 'done');
      }
      expect(registry.get('paused-1')?.status).toBe('paused');
    });

    it('never evicts cancelled-but-not-yet-notified entries', () => {
      // cancel() flips the entry to cancelled immediately but defers
      // the terminal task-notification to the natural handler / grace
      // timer. Pruning here would break the SDK contract that every
      // register pairs with exactly one terminal task-notification.
      registry.setNotificationCallback(() => {});
      registry.register(makeRegisteredEntry('pending-cancel', 1));
      registry.cancel('pending-cancel');
      // Push terminal entries past the cap.
      for (let i = 0; i < MAX_RETAINED_TERMINAL_AGENTS + 1; i++) {
        registry.register(makeRegisteredEntry(`done-${i}`, 100 + i * 1000));
        registry.complete(`done-${i}`, 'done');
      }
      // pending-cancel survives because it has notified=false; it's
      // still owed a terminal notification.
      expect(registry.get('pending-cancel')?.status).toBe('cancelled');
      expect(registry.get('pending-cancel')?.notified).toBeFalsy();
    });

    it('prunes an abandoned (paused → cancelled) entry the same as any other terminal', () => {
      // abandon() is the only path that flips notified=true on a
      // previously-paused entry. Make sure the resulting terminal
      // counts toward the cap so a session that abandons many
      // paused agents doesn't bypass the retention bound.
      registry.register({
        agentId: 'paused-overflow',
        description: 'paused',
        status: 'paused',
        startTime: 1,
        abortController: new AbortController(),
        outputFile: '/tmp/paused-overflow.jsonl',
        isBackgrounded: true,
      });
      registry.abandon('paused-overflow');
      for (let i = 0; i < MAX_RETAINED_TERMINAL_AGENTS; i++) {
        registry.register(makeRegisteredEntry(`done-${i}`, 100 + i * 1000));
        registry.complete(`done-${i}`, 'done');
      }
      // After the loop, terminal count = 1 (abandon) + 32 (complete) =
      // 33, exceeds the cap → oldest evicted. The abandoned entry
      // (startTime=1, endTime=earliest) is the one evicted.
      expect(registry.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_AGENTS);
      expect(registry.get('paused-overflow')).toBeUndefined();
    });
  });

  describe('queueMessage', () => {
    it('queues a message for a running agent', () => {
      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      });

      const result = registry.queueMessage('test-1', 'hello');
      expect(result).toBe(true);
      expect(registry.get('test-1')!.pendingMessages).toEqual(['hello']);
    });

    it('returns false for non-existent agent', () => {
      expect(registry.queueMessage('nope', 'hello')).toBe(false);
    });

    it('returns false for non-running agent', () => {
      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      });
      registry.complete('test-1', 'done');

      expect(registry.queueMessage('test-1', 'hello')).toBe(false);
    });
  });

  describe('drainMessages', () => {
    it('drains all messages and clears the queue', () => {
      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      });

      registry.queueMessage('test-1', 'msg-1');
      registry.queueMessage('test-1', 'msg-2');

      const messages = registry.drainMessages('test-1');
      expect(messages).toEqual(['msg-1', 'msg-2']);
      expect(registry.get('test-1')!.pendingMessages).toEqual([]);
    });

    it('returns empty array when no messages queued', () => {
      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      });

      expect(registry.drainMessages('test-1')).toEqual([]);
    });

    it('returns empty array for non-existent agent', () => {
      expect(registry.drainMessages('nope')).toEqual([]);
    });
  });

  describe('waitForMessages', () => {
    it('resolves with queued input when a running agent is notified', async () => {
      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      });

      const waitPromise = registry.waitForMessages(
        'test-1',
        new AbortController().signal,
      );

      registry.queueExternalInput('test-1', {
        kind: 'notification',
        text: '<task-notification>event</task-notification>',
      });

      await expect(waitPromise).resolves.toEqual([
        {
          kind: 'notification',
          text: '<task-notification>event</task-notification>',
        },
      ]);
      expect(registry.drainMessages('test-1')).toEqual([]);
    });

    it('resolves empty when the wait signal is aborted', async () => {
      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      });
      const waitAbort = new AbortController();
      const waitPromise = registry.waitForMessages('test-1', waitAbort.signal);

      waitAbort.abort();

      await expect(waitPromise).resolves.toEqual([]);
    });

    it('resolves empty if the signal aborts immediately after listener registration', async () => {
      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      });
      let aborted = false;
      const signal = {
        get aborted() {
          return aborted;
        },
        addEventListener: vi.fn(() => {
          aborted = true;
        }),
        removeEventListener: vi.fn(),
      } as unknown as AbortSignal;

      await expect(registry.waitForMessages('test-1', signal)).resolves.toEqual(
        [],
      );
      expect(signal.removeEventListener).toHaveBeenCalled();
    });

    it('wakes external input waiters without queueing input', async () => {
      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      });

      const waitPromise = registry.waitForMessages(
        'test-1',
        new AbortController().signal,
      );

      registry.wakeExternalInputWaiters('test-1');

      await expect(waitPromise).resolves.toEqual([]);
      expect(registry.drainMessages('test-1')).toEqual([]);
    });
  });

  describe('session switch helpers', () => {
    it('reset clears tracked entries without touching persisted sidecars', () => {
      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      });
      registry.register({
        agentId: 'test-2',
        description: 'paused agent',
        status: 'paused',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      });

      registry.reset();

      expect(registry.getAll()).toEqual([]);
    });
  });

  describe('notification XML', () => {
    it('includes output-file tag when outputFile is set', () => {
      const callback = vi.fn();
      registry.setNotificationCallback(callback);

      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        outputFile: '/tmp/agents/test-1.txt',
        isBackgrounded: true,
      });

      registry.complete('test-1', 'done');

      const [, modelText] = callback.mock.calls[0];
      expect(modelText).toContain(
        '<output-file>/tmp/agents/test-1.txt</output-file>',
      );
    });

    it('omits output-file tag when outputFile is empty', () => {
      // outputFile is mandatory on the contract but a caller may pass an
      // empty string (e.g. an agent kind that explicitly opts out of disk
      // persistence). In that case the notification XML should omit the
      // `<output-file>` tag — model-side parsers shouldn't see a path to
      // a file that doesn't exist.
      const callback = vi.fn();
      registry.setNotificationCallback(callback);

      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '',
      });

      registry.complete('test-1', 'done');

      const [, modelText] = callback.mock.calls[0];
      expect(modelText).not.toContain('<output-file>');
    });
  });

  describe('foreground flavor', () => {
    it('does not emit a task-notification on complete', () => {
      const callback = vi.fn();
      registry.setNotificationCallback(callback);

      registry.register({
        agentId: 'fg-1',
        description: 'sync agent',
        isBackgrounded: false,
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        outputFile: '/tmp/test.jsonl',
      });

      registry.complete('fg-1', 'result text');

      // Foreground entries deliver their result through the parent's normal
      // tool-result channel; emitting the XML envelope on top would feed
      // the parent model the same payload twice.
      expect(callback).not.toHaveBeenCalled();
      // The status mutation still happens — internal invariants intact.
      expect(registry.get('fg-1')!.status).toBe('completed');
      expect(registry.get('fg-1')!.notified).toBe(true);
    });

    it('does not emit a task-notification on fail', () => {
      const callback = vi.fn();
      registry.setNotificationCallback(callback);

      registry.register({
        agentId: 'fg-2',
        description: 'sync agent',
        isBackgrounded: false,
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        outputFile: '/tmp/test.jsonl',
      });

      registry.fail('fg-2', 'oops');

      expect(callback).not.toHaveBeenCalled();
    });

    it('is excluded from hasUnfinalizedTasks()', () => {
      registry.register({
        agentId: 'fg-3',
        description: 'sync agent',
        isBackgrounded: false,
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        outputFile: '/tmp/test.jsonl',
      });

      // A still-running foreground entry must NOT keep the headless
      // event loop alive — the parent's tool-call await already does that.
      expect(registry.hasUnfinalizedTasks()).toBe(false);
    });

    it('cancel does not schedule the grace timer', () => {
      // The grace-timer fallback only matters for background entries that
      // might not see their natural completion handler fire. Foreground
      // entries unregister themselves in agent.ts's finally path.
      vi.useFakeTimers();
      try {
        const callback = vi.fn();
        registry.setNotificationCallback(callback);

        registry.register({
          agentId: 'fg-4',
          description: 'sync agent',
          isBackgrounded: false,
          status: 'running',
          startTime: Date.now(),
          abortController: new AbortController(),
          outputFile: '/tmp/test.jsonl',
        });

        registry.cancel('fg-4');

        // Advance well past the 5s grace window — no notification should fire.
        vi.advanceTimersByTime(60_000);
        expect(callback).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('unregisterForeground removes the entry and emits a status change', () => {
      const onStatusChange = vi.fn();
      registry.setStatusChangeCallback(onStatusChange);

      registry.register({
        agentId: 'fg-5',
        description: 'sync agent',
        isBackgrounded: false,
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        outputFile: '/tmp/test.jsonl',
      });
      onStatusChange.mockClear();

      registry.unregisterForeground('fg-5');

      expect(registry.get('fg-5')).toBeUndefined();
      expect(onStatusChange).toHaveBeenCalledTimes(1);
    });

    it('unregisterForeground throws if asked to remove a background entry', () => {
      // Background entries must terminate via complete/fail/finalizeCancelled
      // so the task-notification + headless holdback invariants stay intact.
      // A silent no-op would mask caller bugs, so this throws.
      registry.register({
        agentId: 'bg-1',
        description: 'async agent',
        isBackgrounded: true,
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        outputFile: '/tmp/test.jsonl',
      });

      expect(() => registry.unregisterForeground('bg-1')).toThrow(
        /non-foreground entry bg-1/,
      );
      expect(registry.get('bg-1')).toBeDefined();
    });

    it('unregisterForeground is a no-op for unknown agent ids', () => {
      // Idempotent for already-unregistered/never-registered ids — the
      // foreground finally path runs unconditionally and shouldn't throw
      // if a parallel cancel already cleared the entry.
      expect(() => registry.unregisterForeground('missing')).not.toThrow();
    });

    it('does not invoke the register callback for foreground entries', () => {
      // Non-interactive bridges setRegisterCallback to a `task_started`
      // SDK event. Foreground entries never produce a paired terminal
      // task-notification (see emitNotification's flavor gate), so letting
      // them fire `task_started` would leak orphaned in-flight tasks to
      // SDK consumers.
      const onRegister = vi.fn();
      registry.setRegisterCallback(onRegister);

      registry.register({
        agentId: 'fg-no-register-cb',
        description: 'sync agent',
        isBackgrounded: false,
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        outputFile: '/tmp/test.jsonl',
      });

      expect(onRegister).not.toHaveBeenCalled();

      // Background entries still fire it.
      registry.register({
        agentId: 'bg-fires-register-cb',
        description: 'async agent',
        isBackgrounded: true,
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        outputFile: '/tmp/test.jsonl',
      });
      expect(onRegister).toHaveBeenCalledTimes(1);
      expect(onRegister.mock.calls[0]![0].agentId).toBe('bg-fires-register-cb');
    });

    it('can suppress the register callback for background entries', () => {
      const onRegister = vi.fn();
      registry.setRegisterCallback(onRegister);

      const entry = registry.register(makeRegistration('bg-suppressed'), {
        suppressRegisterCallback: true,
      });

      expect(entry.agentId).toBe('bg-suppressed');
      expect(onRegister).not.toHaveBeenCalled();
    });

    it('unregisterForeground emits status change after removing the entry', () => {
      // The entry is deleted from the Map before the status-change callback
      // fires, so a callback that rebuilds its snapshot via getAll() no
      // longer includes this entry. This ordering prevents the entry from
      // lingering in React state with status='running' — the bug that
      // caused "1 local agent" to stay visible after the foreground agent
      // completed.
      registry.register({
        agentId: 'fg-unregister-order',
        description: 'sync agent',
        isBackgrounded: false,
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        outputFile: '/tmp/test.jsonl',
      });

      let observedFromCallback: BackgroundTaskEntry | undefined;
      let snapshotDuringCallback: BackgroundTaskEntry[] = [];
      registry.setStatusChangeCallback((entry) => {
        if (entry?.agentId === 'fg-unregister-order') {
          observedFromCallback = registry.get(entry.agentId);
          snapshotDuringCallback = registry.getAll();
        }
      });

      registry.unregisterForeground('fg-unregister-order');

      // The entry has been deleted before the callback fires, so
      // registry.get() returns undefined and getAll() omits it.
      expect(observedFromCallback).toBeUndefined();
      expect(snapshotDuringCallback).toEqual([]);
      expect(registry.get('fg-unregister-order')).toBeUndefined();
    });

    it('background entries fire a task-notification on complete', () => {
      // Counterpart to the foreground "does not emit" cases above —
      // background entries deliver their result through the XML envelope,
      // so the notification callback must fire on complete.
      const callback = vi.fn();
      registry.setNotificationCallback(callback);

      registry.register({
        agentId: 'bg-notify-1',
        description: 'async agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        isBackgrounded: true,
        outputFile: '/tmp/test.jsonl',
      });

      registry.complete('bg-notify-1', 'done');

      expect(callback).toHaveBeenCalledOnce();
    });
  });

  describe('permission bubbling (pending approvals)', () => {
    it('parks an approval and surfaces it on the entry', () => {
      const onChange = vi.fn();
      registry.setApprovalChangeCallback(onChange);
      registry.register(makeRegistration('bg-appr-1'));

      const ok = registry.addPendingApproval('bg-appr-1', makeApproval('c1'));

      expect(ok).toBe(true);
      expect(registry.getPendingApprovals('bg-appr-1')).toHaveLength(1);
      expect(registry.get('bg-appr-1')?.pendingApprovals?.[0].callId).toBe(
        'c1',
      );
      expect(onChange).toHaveBeenCalledOnce();
    });

    it('refuses to park for an unknown or terminal entry', () => {
      registry.register(makeRegistration('bg-appr-2'));
      registry.complete('bg-appr-2', 'done');

      expect(registry.addPendingApproval('bg-appr-2', makeApproval('c1'))).toBe(
        false,
      );
      expect(registry.addPendingApproval('missing', makeApproval('c1'))).toBe(
        false,
      );
    });

    it('ignores a duplicate callId', () => {
      registry.register(makeRegistration('bg-appr-3'));
      registry.addPendingApproval('bg-appr-3', makeApproval('c1'));

      expect(registry.addPendingApproval('bg-appr-3', makeApproval('c1'))).toBe(
        false,
      );
      expect(registry.getPendingApprovals('bg-appr-3')).toHaveLength(1);
    });

    it('resolves a parked approval via its respond callback and removes it', async () => {
      const respond = vi.fn(async () => {});
      registry.register(makeRegistration('bg-appr-4'));
      registry.addPendingApproval('bg-appr-4', makeApproval('c1', respond));

      const resolved = await registry.resolvePendingApproval(
        'bg-appr-4',
        'c1',
        ToolConfirmationOutcome.ProceedOnce,
      );

      expect(resolved).toBe(true);
      expect(respond).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        undefined,
      );
      expect(registry.getPendingApprovals('bg-appr-4')).toHaveLength(0);
    });

    it.each([
      ToolConfirmationOutcome.ProceedAlways,
      ToolConfirmationOutcome.ProceedAlwaysProject,
      ToolConfirmationOutcome.ProceedAlwaysUser,
      ToolConfirmationOutcome.ProceedAlwaysServer,
      ToolConfirmationOutcome.ProceedAlwaysTool,
    ])(
      'downgrades persistent approval outcome %s to one-time approval',
      async (outcome) => {
        const respond = vi.fn(async () => {});
        registry.register(makeRegistration(`bg-appr-${outcome}`));
        registry.addPendingApproval(
          `bg-appr-${outcome}`,
          makeApproval('c1', respond),
        );

        const resolved = await registry.resolvePendingApproval(
          `bg-appr-${outcome}`,
          'c1',
          outcome,
        );

        expect(resolved).toBe(true);
        expect(respond).toHaveBeenCalledWith(
          ToolConfirmationOutcome.ProceedOnce,
          undefined,
        );
      },
    );

    it('returns false when resolving a non-parked call', async () => {
      registry.register(makeRegistration('bg-appr-5'));
      expect(
        await registry.resolvePendingApproval(
          'bg-appr-5',
          'nope',
          ToolConfirmationOutcome.Cancel,
        ),
      ).toBe(false);
    });

    it('clears a parked approval without responding', () => {
      const respond = vi.fn(async () => {});
      registry.register(makeRegistration('bg-appr-6'));
      registry.addPendingApproval('bg-appr-6', makeApproval('c1', respond));

      registry.clearPendingApproval('bg-appr-6', 'c1');

      expect(registry.getPendingApprovals('bg-appr-6')).toHaveLength(0);
      expect(respond).not.toHaveBeenCalled();
    });

    it('auto-rejects parked approvals when the agent terminates', () => {
      const respond = vi.fn(async () => {});
      registry.register(makeRegistration('bg-appr-7'));
      registry.addPendingApproval('bg-appr-7', makeApproval('c1', respond));

      registry.complete('bg-appr-7', 'done');

      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
      expect(registry.getPendingApprovals('bg-appr-7')).toHaveLength(0);
    });

    it('auto-rejects parked approvals when the agent fails', () => {
      const respond = vi.fn(async () => {});
      registry.register(makeRegistration('bg-appr-fail'));
      registry.addPendingApproval('bg-appr-fail', makeApproval('c1', respond));

      registry.fail('bg-appr-fail', 'boom');

      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
      expect(registry.getPendingApprovals('bg-appr-fail')).toHaveLength(0);
    });

    it('auto-rejects parked approvals on finalizeCancelled', () => {
      const respond = vi.fn(async () => {});
      registry.register(makeRegistration('bg-appr-fc'));
      registry.addPendingApproval('bg-appr-fc', makeApproval('c1', respond));

      registry.finalizeCancelled('bg-appr-fc', 'partial');

      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
      expect(registry.getPendingApprovals('bg-appr-fc')).toHaveLength(0);
    });

    it('rejects parked approvals on reset so a session switch never strands a respond()', () => {
      const respond = vi.fn(async () => {});
      registry.register(makeRegistration('bg-appr-reset'));
      registry.addPendingApproval('bg-appr-reset', makeApproval('c1', respond));

      registry.reset();

      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
      expect(registry.get('bg-appr-reset')).toBeUndefined();
    });

    it('fails the agent before aborting when a parked approval respond() rejects', async () => {
      const respond = vi.fn(async () => {
        throw new Error('frames torn down');
      });
      const onChange = vi.fn();
      const onStatus = vi.fn();
      const onNotify = vi.fn();
      const abortController = new AbortController();
      const order: string[] = [];
      abortController.signal.addEventListener('abort', () => {
        order.push('abort');
      });
      registry.register(makeRegistration('bg-appr-retry', { abortController }));
      registry.addPendingApproval('bg-appr-retry', makeApproval('c1', respond));
      registry.setApprovalChangeCallback(onChange);
      registry.setStatusChangeCallback((entry) => {
        if (entry?.agentId === 'bg-appr-retry') {
          order.push(`status:${entry.status}`);
        }
        onStatus(entry);
      });
      registry.setNotificationCallback(onNotify);

      const ok = await registry.resolvePendingApproval(
        'bg-appr-retry',
        'c1',
        ToolConfirmationOutcome.ProceedOnce,
      );

      expect(ok).toBe(false);
      expect(registry.getPendingApprovals('bg-appr-retry')).toHaveLength(0);
      expect(registry.get('bg-appr-retry')?.status).toBe('failed');
      expect(registry.get('bg-appr-retry')?.error).toBe(
        'Failed to resolve background approval: c1',
      );
      expect(abortController.signal.aborted).toBe(true);
      expect(order).toEqual(['status:failed', 'abort']);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onStatus).toHaveBeenCalledOnce();
      expect(onNotify).toHaveBeenCalledOnce();
    });

    it('auto-rejects parked approvals on cancel', () => {
      const respond = vi.fn(async () => {});
      registry.register(makeRegistration('bg-appr-8'));
      registry.addPendingApproval('bg-appr-8', makeApproval('c1', respond));

      registry.cancel('bg-appr-8', { notify: false });

      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
      expect(registry.getPendingApprovals('bg-appr-8')).toHaveLength(0);
    });

    it('cancel() rejects parked approvals before the abort-driven clear (production ordering)', () => {
      // In production, abort() synchronously unwinds the agent's awaiting
      // tool batch, which emits a synthetic TOOL_RESULT for the parked call;
      // the bridge's onResult then clears the queue. cancel() must therefore
      // reject BEFORE aborting, or respond(Cancel) never fires. This test
      // wires the bridge AND simulates that abort→TOOL_RESULT chain so the
      // ordering is exercised the way it happens live.
      const emitter = new AgentEventEmitter();
      const abortController = new AbortController();
      registry.register(
        makeRegistration('bg-appr-cancel', { abortController }),
      );
      registry.bridgeApprovalEvents('bg-appr-cancel', emitter);

      const respond = vi.fn(async () => {});
      emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
        subagentId: 'bg-appr-cancel',
        round: 1,
        callId: 'c1',
        name: 'Shell',
        description: 'run c1',
        args: {},
        confirmationDetails: {
          type: 'exec',
        } as BackgroundApproval['confirmationDetails'],
        respond,
        timestamp: Date.now(),
      });
      abortController.signal.addEventListener('abort', () => {
        emitter.emit(AgentEventType.TOOL_RESULT, {
          subagentId: 'bg-appr-cancel',
          round: 1,
          callId: 'c1',
          success: false,
        } as never);
      });

      registry.cancel('bg-appr-cancel', { notify: false });

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
      expect(registry.getPendingApprovals('bg-appr-cancel')).toHaveLength(0);
    });

    it('bridges emitter approval events into the parked queue and clears on result', () => {
      const emitter = new AgentEventEmitter();
      registry.register(makeRegistration('bg-appr-9'));
      const cleanup = registry.bridgeApprovalEvents('bg-appr-9', emitter);

      const respond = vi.fn(async () => {});
      emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
        subagentId: 'bg-appr-9',
        round: 1,
        callId: 'c1',
        name: 'Shell',
        description: 'run c1',
        args: {},
        confirmationDetails: {
          type: 'exec',
        } as BackgroundApproval['confirmationDetails'],
        respond,
        timestamp: Date.now(),
      });
      expect(registry.getPendingApprovals('bg-appr-9')).toHaveLength(1);

      // A tool result for the same call clears the stale prompt without
      // double-answering.
      emitter.emit(AgentEventType.TOOL_RESULT, {
        subagentId: 'bg-appr-9',
        round: 1,
        callId: 'c1',
        success: true,
      } as never);
      expect(registry.getPendingApprovals('bg-appr-9')).toHaveLength(0);
      expect(respond).not.toHaveBeenCalled();

      cleanup();
    });

    it('auto-rejects a bridged approval that arrives after termination', () => {
      const emitter = new AgentEventEmitter();
      registry.register(makeRegistration('bg-appr-10'));
      registry.bridgeApprovalEvents('bg-appr-10', emitter);
      registry.complete('bg-appr-10', 'done');

      const respond = vi.fn(async () => {});
      emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
        subagentId: 'bg-appr-10',
        round: 1,
        callId: 'late',
        name: 'Shell',
        description: 'run late',
        args: {},
        confirmationDetails: {
          type: 'exec',
        } as BackgroundApproval['confirmationDetails'],
        respond,
        timestamp: Date.now(),
      });

      // Couldn't park (entry terminal) → rejected so the agent loop unblocks.
      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
    });
  });
});
