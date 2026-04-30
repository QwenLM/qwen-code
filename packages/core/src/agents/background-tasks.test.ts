/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackgroundTaskRegistry } from './background-tasks.js';
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

  it('persists shutdown interruption as running sidecar state', () => {
    const patchSpy = vi
      .spyOn(transcript, 'patchAgentMeta')
      .mockImplementation(() => undefined);
    try {
      registry.register({
        agentId: 'a',
        description: 'agent a',
        status: 'running',
        startTime: Date.now(),
        abortController: new AbortController(),
        metaPath: '/tmp/a.meta.json',
      });

      registry.abortAll();

      expect(patchSpy).toHaveBeenCalledWith(
        '/tmp/a.meta.json',
        expect.objectContaining({
          status: 'running',
          lastError: undefined,
        }),
      );
    } finally {
      patchSpy.mockRestore();
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
    registry.setActivityChangeCallback(activityCb);

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
});
