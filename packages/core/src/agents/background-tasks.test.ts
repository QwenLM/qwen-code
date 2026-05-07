/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BackgroundTaskRegistry,
  MAX_RETAINED_TERMINAL_BACKGROUND_TASKS,
  type BackgroundTaskEntry,
} from './background-tasks.js';
import * as transcript from './agent-transcript.js';

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
    });

    registry.abandon('paused-1');

    expect(registry.get('paused-1')!.status).toBe('cancelled');
    expect(registry.get('paused-1')!.notified).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not treat paused entries as unfinalized work', () => {
    registry.register({
      agentId: 'paused-1',
      description: 'paused agent',
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
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
    });
    registry.register({
      agentId: 'b',
      description: 'agent b',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
    });

    registry.complete('a', 'done');

    const running = registry.getAll().filter((e) => e.status === 'running');
    expect(running).toHaveLength(1);
    expect(running[0].agentId).toBe('b');
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
    });
    registry.register({
      agentId: 'b',
      description: 'agent b',
      status: 'running',
      startTime: Date.now(),
      abortController: ac2,
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
    });
    registry.register({
      agentId: 'b',
      description: 'agent b',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
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
    });
    registry.register({
      agentId: 'b',
      description: 'agent b',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
    });
    registry.register({
      agentId: 'c',
      description: 'agent c',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
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
    });
    registry.register({
      agentId: 'b',
      description: 'agent b',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
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
    });

    registry.complete('a', 'done');
    registry.appendActivity('a', { name: 'Late', description: 'x', at: 99 });

    expect(registry.get('a')!.recentActivities ?? []).toHaveLength(0);
  });

  it('appendActivity fires activityChange, not statusChange', () => {
    const statusCb = vi.fn();
    const activityCb = vi.fn();
    registry.setStatusChangeCallback(statusCb);
    registry.addActivityChangeListener(activityCb);

    registry.register({
      agentId: 'a',
      description: 'agent a',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
    });
    statusCb.mockClear();
    activityCb.mockClear();

    registry.appendActivity('a', { name: 'T', description: 'd', at: 0 });

    expect(statusCb).not.toHaveBeenCalled();
    expect(activityCb).toHaveBeenCalledOnce();
    expect(activityCb.mock.calls[0][0].agentId).toBe('a');
  });

  it('fans appendActivity out to every registered listener', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = registry.addActivityChangeListener(a);
    registry.addActivityChangeListener(b);

    registry.register({
      agentId: 'x',
      description: 'agent x',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
    });

    registry.appendActivity('x', { name: 'T', description: 'd', at: 0 });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();

    unsubA();
    registry.appendActivity('x', { name: 'T', description: 'd2', at: 1 });
    // a unsubscribed; only b should pick up the second event.
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('keeps emitting to remaining listeners when one throws', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    registry.addActivityChangeListener(bad);
    registry.addActivityChangeListener(good);

    registry.register({
      agentId: 'y',
      description: 'agent y',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
    });

    expect(() =>
      registry.appendActivity('y', { name: 'T', description: 'd', at: 0 }),
    ).not.toThrow();
    expect(bad).toHaveBeenCalledOnce();
    expect(good).toHaveBeenCalledOnce();
  });

  it('stores prompt verbatim on the entry', () => {
    registry.register({
      agentId: 'a',
      description: 'agent a',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      prompt: 'Run sleep 30 and report done.',
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

  describe('queueMessage', () => {
    it('queues a message for a running agent', () => {
      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
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
      });

      expect(registry.drainMessages('test-1')).toEqual([]);
    });

    it('returns empty array for non-existent agent', () => {
      expect(registry.drainMessages('nope')).toEqual([]);
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
      });
      registry.register({
        agentId: 'test-2',
        description: 'paused agent',
        status: 'paused',
        startTime: Date.now(),
        abortController: new AbortController(),
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
      });

      registry.complete('test-1', 'done');

      const [, modelText] = callback.mock.calls[0];
      expect(modelText).toContain(
        '<output-file>/tmp/agents/test-1.txt</output-file>',
      );
    });

    it('omits output-file tag when outputFile is not set', () => {
      const callback = vi.fn();
      registry.setNotificationCallback(callback);

      registry.register({
        agentId: 'test-1',
        description: 'test agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
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
        flavor: 'foreground',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
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
        flavor: 'foreground',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
      });

      registry.fail('fg-2', 'oops');

      expect(callback).not.toHaveBeenCalled();
    });

    it('is excluded from hasUnfinalizedTasks()', () => {
      registry.register({
        agentId: 'fg-3',
        description: 'sync agent',
        flavor: 'foreground',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
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
          flavor: 'foreground',
          status: 'running',
          startTime: Date.now(),
          abortController: new AbortController(),
        });

        registry.cancel('fg-4');

        // Advance well past the 5s grace window — no notification should fire.
        vi.advanceTimersByTime(60_000);
        expect(callback).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('settleForeground transitions to terminal status, retains the entry, and emits a status change', () => {
      const onStatusChange = vi.fn();
      registry.setStatusChangeCallback(onStatusChange);

      registry.register({
        agentId: 'fg-5',
        description: 'sync agent',
        flavor: 'foreground',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
      });
      onStatusChange.mockClear();

      registry.settleForeground('fg-5', 'completed');

      const settled = registry.get('fg-5');
      expect(settled).toBeDefined();
      expect(settled!.status).toBe('completed');
      expect(settled!.endTime).toBeGreaterThan(0);
      expect(onStatusChange).toHaveBeenCalledTimes(1);
    });

    it('settleForeground attaches details (error, stats) for failed runs', () => {
      registry.register({
        agentId: 'fg-failed',
        description: 'sync agent',
        flavor: 'foreground',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
      });

      registry.settleForeground('fg-failed', 'failed', {
        error: 'tool error: syntax',
        stats: { totalTokens: 42, toolUses: 3, durationMs: 1200 },
      });

      const settled = registry.get('fg-failed');
      expect(settled!.status).toBe('failed');
      expect(settled!.error).toBe('tool error: syntax');
      expect(settled!.stats).toEqual({
        totalTokens: 42,
        toolUses: 3,
        durationMs: 1200,
      });
    });

    it('settleForeground throws if asked to settle a background entry', () => {
      // Background entries must terminate via complete/fail/finalizeCancelled
      // so the task-notification + headless holdback invariants stay intact.
      // A silent no-op would mask caller bugs, so this throws.
      registry.register({
        agentId: 'bg-1',
        description: 'async agent',
        flavor: 'background',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
      });

      expect(() => registry.settleForeground('bg-1', 'completed')).toThrow(
        /non-foreground entry bg-1/,
      );
      // Background entry's status is unchanged.
      expect(registry.get('bg-1')!.status).toBe('running');
    });

    it('settleForeground is a no-op for unknown agent ids', () => {
      // Idempotent for already-unregistered/never-registered ids — the
      // foreground finally path runs unconditionally and shouldn't throw
      // if a parallel cancel already cleared the entry.
      expect(() =>
        registry.settleForeground('missing', 'completed'),
      ).not.toThrow();
    });

    it('settleForeground is idempotent on already-terminal entries', () => {
      // Already-terminal entries early-return: no mutation, no prune,
      // no status-change emit — avoids a redundant UI refresh in the
      // double-settle case (external `cancel()` racing the tool-call's
      // finally).
      const onStatusChange = vi.fn();
      registry.setStatusChangeCallback(onStatusChange);

      registry.register({
        agentId: 'fg-twice',
        description: 'sync agent',
        flavor: 'foreground',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
      });

      registry.settleForeground('fg-twice', 'completed', { error: 'first' });
      const firstEnd = registry.get('fg-twice')!.endTime;
      onStatusChange.mockClear();

      registry.settleForeground('fg-twice', 'failed', { error: 'second' });

      const settled = registry.get('fg-twice');
      expect(settled!.status).toBe('completed');
      expect(settled!.endTime).toBe(firstEnd);
      expect(settled!.error).toBe('first');
      expect(onStatusChange).not.toHaveBeenCalled();
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
        flavor: 'foreground',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
      });

      expect(onRegister).not.toHaveBeenCalled();

      // Background entries still fire it.
      registry.register({
        agentId: 'bg-fires-register-cb',
        description: 'async agent',
        flavor: 'background',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
      });
      expect(onRegister).toHaveBeenCalledTimes(1);
      expect(onRegister.mock.calls[0]![0].agentId).toBe('bg-fires-register-cb');
    });

    it('settleForeground prunes before emitting so subscribers see post-prune state', () => {
      // Subscribers that snapshot `registry.getAll()` from inside the
      // status-change callback must observe the registry with the cap
      // already enforced — otherwise an over-cap settle would briefly
      // expose a phantom entry that is gone from the registry by the
      // next read. Mirrors `MonitorRegistry.settle()`'s order.
      registry.register({
        agentId: 'fg-settle-order',
        description: 'sync agent',
        flavor: 'foreground',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
      });

      let observedFromCallback: BackgroundTaskEntry | undefined;
      registry.setStatusChangeCallback((entry) => {
        if (entry?.agentId === 'fg-settle-order') {
          observedFromCallback = registry.get(entry.agentId);
        }
      });

      registry.settleForeground('fg-settle-order', 'completed');

      // The just-settled entry has the newest endTime, so prune never
      // evicts it. The callback sees it with terminal status.
      expect(observedFromCallback).toBeDefined();
      expect(observedFromCallback!.status).toBe('completed');
      expect(registry.get('fg-settle-order')).toBeDefined();
    });

    it('default flavor (absent) behaves as background for emitNotification', () => {
      // Older callers omit the flavor field. Backwards compatibility:
      // missing flavor is treated as background everywhere.
      const callback = vi.fn();
      registry.setNotificationCallback(callback);

      registry.register({
        agentId: 'legacy-1',
        description: 'legacy agent',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
      });

      registry.complete('legacy-1', 'done');

      expect(callback).toHaveBeenCalledOnce();
    });
  });

  describe('terminal entry retention (cap + FIFO eviction)', () => {
    function registerForeground(
      id: string,
      startTime: number,
    ): BackgroundTaskEntry {
      const entry: BackgroundTaskEntry = {
        agentId: id,
        description: id,
        flavor: 'foreground',
        status: 'running',
        startTime,
        abortController: new AbortController(),
      };
      registry.register(entry);
      return entry;
    }

    it('retains terminal foreground entries up to the cap', () => {
      const cap = MAX_RETAINED_TERMINAL_BACKGROUND_TASKS;
      // Sanity-check the constant matches the design intent before
      // committing to a slow eviction test below.
      expect(cap).toBe(128);

      for (let i = 0; i < cap; i++) {
        registerForeground(`fg-${i}`, 1_000 + i);
        registry.settleForeground(`fg-${i}`, 'completed');
      }
      expect(registry.getAll().length).toBe(cap);
      // Spot-check the first and last entries are still retained.
      expect(registry.get('fg-0')).toBeDefined();
      expect(registry.get(`fg-${cap - 1}`)).toBeDefined();
    });

    it('evicts the oldest terminal entry when the cap is exceeded (FIFO by endTime)', () => {
      vi.useFakeTimers();
      try {
        const cap = MAX_RETAINED_TERMINAL_BACKGROUND_TASKS;
        // Settle each entry at a strictly increasing endTime so FIFO order
        // is unambiguous. After cap+1 settles, the very first one (oldest
        // endTime) must be the eviction victim.
        for (let i = 0; i < cap + 1; i++) {
          vi.setSystemTime(new Date(2_000_000_000_000 + i * 1000));
          registerForeground(`fg-${i}`, 2_000_000_000_000 + i * 1000);
          registry.settleForeground(`fg-${i}`, 'completed');
        }
        expect(registry.getAll().length).toBe(cap);
        expect(registry.get('fg-0')).toBeUndefined();
        expect(registry.get('fg-1')).toBeDefined();
        expect(registry.get(`fg-${cap}`)).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('eviction is uniform across foreground and background flavors', () => {
      vi.useFakeTimers();
      try {
        const cap = MAX_RETAINED_TERMINAL_BACKGROUND_TASKS;
        // Settle one background entry first (oldest), then `cap` foreground
        // entries. The background entry should be evicted because its
        // endTime is the smallest.
        vi.setSystemTime(new Date(3_000_000_000_000));
        registry.register({
          agentId: 'bg-oldest',
          description: 'bg',
          flavor: 'background',
          status: 'running',
          startTime: 3_000_000_000_000,
          abortController: new AbortController(),
        });
        registry.complete('bg-oldest', 'done');

        for (let i = 0; i < cap; i++) {
          vi.setSystemTime(new Date(3_000_000_000_000 + (i + 1) * 1000));
          registerForeground(`fg-${i}`, 3_000_000_000_000 + (i + 1) * 1000);
          registry.settleForeground(`fg-${i}`, 'completed');
        }

        expect(registry.getAll().length).toBe(cap);
        expect(registry.get('bg-oldest')).toBeUndefined();
        expect(registry.get('fg-0')).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not evict a cancelled-but-not-finalized background entry', () => {
      // `cancel()` sets status to 'cancelled' but does NOT emit the terminal
      // task-notification — the natural handler (or grace timer) does that
      // later via `finalizeCancelled` / `finalizeCancellationIfPending`.
      // Pruning the entry before finalization would orphan the
      // task-notification and strand any headless caller waiting on the
      // holdback. The guard requires `notified === true` for background
      // entries before they're considered prunable.
      vi.useFakeTimers();
      try {
        const cap = MAX_RETAINED_TERMINAL_BACKGROUND_TASKS;
        vi.setSystemTime(new Date(5_000_000_000_000));
        registry.register({
          agentId: 'bg-cancelling',
          description: 'mid-cancel',
          flavor: 'background',
          status: 'running',
          startTime: 5_000_000_000_000,
          abortController: new AbortController(),
        });
        // Plain cancel() schedules the grace timer; the entry is now
        // status='cancelled' but notified is still false. (Passing
        // notify:false would set notified=true intentionally — that's
        // the session-reset path, not what we're modeling here.)
        registry.cancel('bg-cancelling');

        // Push the cap with foreground settles. Without the guard, the
        // oldest (cancelled-not-notified) bg entry would be evicted.
        for (let i = 0; i < cap + 5; i++) {
          vi.setSystemTime(new Date(5_000_000_000_000 + (i + 1) * 1000));
          registerForeground(`fg-${i}`, 5_000_000_000_000 + (i + 1) * 1000);
          registry.settleForeground(`fg-${i}`, 'completed');
        }

        // Cancelled-not-notified entry survives; foreground entries beyond
        // the cap are evicted instead.
        expect(registry.get('bg-cancelling')).toBeDefined();
        expect(registry.get('bg-cancelling')!.status).toBe('cancelled');
        expect(registry.get('bg-cancelling')!.notified).not.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('background terminal transitions trigger the cap (no foreground required)', () => {
      // A session that runs many background agents to completion without
      // ever spawning a foreground subagent must still enforce the cap —
      // otherwise `complete()` / `fail()` / `finalizeCancelled()` would
      // accumulate forever.
      vi.useFakeTimers();
      try {
        const cap = MAX_RETAINED_TERMINAL_BACKGROUND_TASKS;
        for (let i = 0; i < cap + 3; i++) {
          vi.setSystemTime(new Date(6_000_000_000_000 + i * 1000));
          registry.register({
            agentId: `bg-${i}`,
            description: `bg ${i}`,
            flavor: 'background',
            status: 'running',
            startTime: 6_000_000_000_000 + i * 1000,
            abortController: new AbortController(),
          });
          registry.complete(`bg-${i}`, 'done');
        }
        expect(registry.getAll().length).toBe(cap);
        // Oldest 3 evicted, newest cap retained.
        expect(registry.get('bg-0')).toBeUndefined();
        expect(registry.get('bg-1')).toBeUndefined();
        expect(registry.get('bg-2')).toBeUndefined();
        expect(registry.get(`bg-${cap + 2}`)).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('settleForeground after cancel() attaches final stats and runs prune', () => {
      // Cancel-then-settle race: the dialog's `x` confirms cancellation
      // (which sets entry.status='cancelled' synchronously), then the
      // tool-call's finally calls settleForeground with the agent's
      // authoritative final stats. The settle must NOT skip on the
      // already-terminal status — otherwise the dialog row would render
      // with the live-refresh's last snapshot rather than the final
      // execution-summary numbers.
      registry.register({
        agentId: 'fg-cancel-race',
        description: 'sync agent',
        flavor: 'foreground',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        stats: { totalTokens: 100, toolUses: 1, durationMs: 50 },
      });

      registry.cancel('fg-cancel-race');
      // Foreground entries don't notify, but cancel set status='cancelled'.
      expect(registry.get('fg-cancel-race')!.status).toBe('cancelled');

      const finalStats = { totalTokens: 250, toolUses: 3, durationMs: 200 };
      registry.settleForeground('fg-cancel-race', 'cancelled', {
        stats: finalStats,
      });

      const settled = registry.get('fg-cancel-race');
      // Status preserved (user intent wins), but final stats attached.
      expect(settled!.status).toBe('cancelled');
      expect(settled!.stats).toEqual(finalStats);
    });

    it('does not evict still-running entries', () => {
      vi.useFakeTimers();
      try {
        const cap = MAX_RETAINED_TERMINAL_BACKGROUND_TASKS;
        // A long-running background entry registered at t=0 (oldest of all)
        // must survive even when `cap+5` foreground entries settle around it.
        vi.setSystemTime(new Date(4_000_000_000_000));
        registry.register({
          agentId: 'bg-running',
          description: 'still running',
          flavor: 'background',
          status: 'running',
          startTime: 4_000_000_000_000,
          abortController: new AbortController(),
        });
        for (let i = 0; i < cap + 5; i++) {
          vi.setSystemTime(new Date(4_000_000_000_000 + (i + 1) * 1000));
          registerForeground(`fg-${i}`, 4_000_000_000_000 + (i + 1) * 1000);
          registry.settleForeground(`fg-${i}`, 'completed');
        }

        // Running entry stays; total is cap (terminal) + 1 (running).
        expect(registry.get('bg-running')).toBeDefined();
        expect(registry.get('bg-running')!.status).toBe('running');
        expect(registry.getAll().length).toBe(cap + 1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
