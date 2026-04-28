/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MonitorRegistry, type MonitorEntry } from './monitorRegistry.js';

function createEntry(overrides: Partial<MonitorEntry> = {}): MonitorEntry {
  return {
    monitorId: 'mon-1',
    command: 'tail -f /var/log/app.log',
    description: 'watch app logs',
    status: 'running' as const,
    startTime: Date.now(),
    abortController: new AbortController(),
    eventCount: 0,
    lastEventTime: 0,
    maxEvents: 1000,
    idleTimeoutMs: 300_000,
    ...overrides,
  };
}

describe('MonitorRegistry', () => {
  let registry: MonitorRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new MonitorRegistry();
  });

  afterEach(() => {
    // Cancel all to clear idle timers before restoring real timers
    registry.abortAll();
    vi.useRealTimers();
  });

  it('registers and retrieves a monitor', () => {
    const entry = createEntry();
    registry.register(entry);
    expect(registry.get('mon-1')).toBe(entry);
  });

  it('emits event notification via callback', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry());

    registry.emitEvent('mon-1', 'hello world');

    expect(callback).toHaveBeenCalledOnce();
    const [displayText, modelText, meta] = callback.mock.calls[0] as [
      string,
      string,
      { monitorId: string; status: string; eventCount: number },
    ];
    expect(displayText).toContain('watch app logs');
    expect(displayText).toContain('hello world');
    expect(modelText).toContain('<kind>monitor</kind>');
    expect(modelText).toContain('<status>running</status>');
    expect(modelText).toContain('<event-count>1</event-count>');
    expect(modelText).toContain('hello world');
    expect(meta.monitorId).toBe('mon-1');
    expect(meta.status).toBe('running');
    expect(meta.eventCount).toBe(1);
  });

  it('increments eventCount on each emitEvent', () => {
    registry.register(createEntry());
    registry.emitEvent('mon-1', 'line 1');
    registry.emitEvent('mon-1', 'line 2');
    registry.emitEvent('mon-1', 'line 3');

    expect(registry.get('mon-1')!.eventCount).toBe(3);
  });

  it('completes a monitor and emits terminal notification', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry());

    registry.complete('mon-1', 0);

    const entry = registry.get('mon-1')!;
    expect(entry.status).toBe('completed');
    expect(entry.endTime).toBeDefined();
    expect(callback).toHaveBeenCalledOnce();
    const [displayText, modelText] = callback.mock.calls[0] as [string, string];
    expect(displayText).toContain('completed');
    expect(modelText).toContain('<status>completed</status>');
    expect(modelText).toContain('Exited with code 0');
  });

  it('fails a monitor and emits terminal notification', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry());

    registry.fail('mon-1', 'spawn ENOENT');

    const entry = registry.get('mon-1')!;
    expect(entry.status).toBe('failed');
    expect(callback).toHaveBeenCalledOnce();
    const [displayText, modelText] = callback.mock.calls[0] as [string, string];
    expect(displayText).toContain('failed');
    expect(modelText).toContain('<status>failed</status>');
    expect(modelText).toContain('spawn ENOENT');
  });

  it('cancels a running monitor and aborts its controller', () => {
    const ac = new AbortController();
    registry.register(createEntry({ abortController: ac }));

    registry.cancel('mon-1');

    expect(registry.get('mon-1')!.status).toBe('cancelled');
    expect(ac.signal.aborted).toBe(true);
  });

  it('no-op: complete after cancel (one-shot terminal guard)', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry());

    registry.cancel('mon-1');
    registry.complete('mon-1', 0);

    expect(registry.get('mon-1')!.status).toBe('cancelled');
    expect(callback).toHaveBeenCalledTimes(1); // only cancel notification
  });

  it('no-op: emitEvent after cancel', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry());

    registry.cancel('mon-1');
    registry.emitEvent('mon-1', 'late line');

    // Only the cancel notification, no event notification
    expect(callback).toHaveBeenCalledTimes(1);
    expect(registry.get('mon-1')!.eventCount).toBe(0);
  });

  it('auto-stops when maxEvents is reached', () => {
    const ac = new AbortController();
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry({ maxEvents: 3, abortController: ac }));

    registry.emitEvent('mon-1', 'line 1');
    registry.emitEvent('mon-1', 'line 2');
    registry.emitEvent('mon-1', 'line 3'); // triggers auto-stop

    expect(registry.get('mon-1')!.status).toBe('completed');
    expect(ac.signal.aborted).toBe(true);
    // 3 event notifications + 1 terminal notification ("Max events reached")
    expect(callback).toHaveBeenCalledTimes(4);
    const [, terminalModelText] = callback.mock.calls[3] as [string, string];
    expect(terminalModelText).toContain('Max events reached');
    expect(terminalModelText).toContain('<status>completed</status>');
  });

  it('auto-stops on idle timeout', () => {
    const ac = new AbortController();
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(
      createEntry({
        idleTimeoutMs: 5000,
        abortController: ac,
      }),
    );

    // Fast-forward past the idle timeout
    vi.advanceTimersByTime(5001);

    expect(registry.get('mon-1')!.status).toBe('completed');
    expect(ac.signal.aborted).toBe(true);
    // Terminal notification from idle timeout
    expect(callback).toHaveBeenCalledOnce();
    const [, modelText] = callback.mock.calls[0] as [string, string];
    expect(modelText).toContain('Idle timeout');
  });

  it('resets idle timer on emitEvent', () => {
    const ac = new AbortController();
    registry.register(
      createEntry({
        idleTimeoutMs: 5000,
        abortController: ac,
      }),
    );

    // Advance 4s, emit event, advance 4s again — should NOT timeout
    vi.advanceTimersByTime(4000);
    registry.emitEvent('mon-1', 'keep alive');
    vi.advanceTimersByTime(4000);

    expect(registry.get('mon-1')!.status).toBe('running');

    // Now advance past the timeout
    vi.advanceTimersByTime(2000);
    expect(registry.get('mon-1')!.status).toBe('completed');
  });

  it('getRunning filters by status', () => {
    registry.register(createEntry({ monitorId: 'a' }));
    registry.register(createEntry({ monitorId: 'b' }));
    registry.register(createEntry({ monitorId: 'c' }));

    registry.complete('a', 0);
    registry.cancel('c');

    const running = registry.getRunning();
    expect(running).toHaveLength(1);
    expect(running[0].monitorId).toBe('b');
  });

  it('abortAll cancels all running monitors', () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    registry.register(createEntry({ monitorId: 'a', abortController: ac1 }));
    registry.register(createEntry({ monitorId: 'b', abortController: ac2 }));

    registry.abortAll();

    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);
    expect(registry.get('a')!.status).toBe('cancelled');
    expect(registry.get('b')!.status).toBe('cancelled');
  });

  it('truncates long event lines', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry());

    const longLine = 'x'.repeat(3000);
    registry.emitEvent('mon-1', longLine);

    const [, modelText] = callback.mock.calls[0] as [string, string];
    expect(modelText).toContain('...[truncated]');
    expect(modelText).not.toContain('x'.repeat(3000));
  });

  it('escapes XML metacharacters in event lines', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry());

    registry.emitEvent('mon-1', '<script>alert("xss")</script>');

    const [, modelText] = callback.mock.calls[0] as [string, string];
    expect(modelText).toContain('&lt;script&gt;');
    expect(modelText).not.toContain('<script>');
    // Only one closing task-notification tag
    expect(modelText.match(/<\/task-notification>/g)!.length).toBe(1);
  });

  it('propagates toolUseId in notification XML and meta', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry({ toolUseId: 'call-xyz' }));

    registry.emitEvent('mon-1', 'test line');

    const [, modelText, meta] = callback.mock.calls[0] as [
      string,
      string,
      { toolUseId?: string },
    ];
    expect(modelText).toContain('<tool-use-id>call-xyz</tool-use-id>');
    expect(meta.toolUseId).toBe('call-xyz');
  });

  it('does not throw without notification callback', () => {
    registry.register(createEntry());

    // Should not throw
    registry.emitEvent('mon-1', 'line');
    registry.complete('mon-1', 0);
    expect(registry.get('mon-1')!.status).toBe('completed');
  });

  it('no-op on nonexistent monitorId for all methods', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);

    // None of these should throw
    registry.emitEvent('nonexistent', 'line');
    registry.complete('nonexistent', 0);
    registry.fail('nonexistent', 'err');
    registry.cancel('nonexistent');

    expect(callback).not.toHaveBeenCalled();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('complete with null exitCode omits result tag', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry());

    registry.complete('mon-1', null);

    const [, modelText] = callback.mock.calls[0] as [string, string];
    expect(modelText).toContain('<status>completed</status>');
    expect(modelText).not.toContain('<result>');
  });

  it('setNotificationCallback(undefined) clears the callback', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry());

    registry.setNotificationCallback(undefined);
    registry.emitEvent('mon-1', 'after clear');

    expect(callback).not.toHaveBeenCalled();
  });

  it('getAll returns all entries regardless of status', () => {
    registry.register(createEntry({ monitorId: 'a' }));
    registry.register(createEntry({ monitorId: 'b' }));
    registry.register(createEntry({ monitorId: 'c' }));

    registry.complete('a', 0);
    registry.fail('b', 'err');

    const all = registry.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.status).sort()).toEqual([
      'completed',
      'failed',
      'running',
    ]);
  });
});
