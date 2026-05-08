/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MAX_RETAINED_TERMINAL_MONITORS,
  MonitorRegistry,
  type MonitorEntry,
} from './monitorRegistry.js';

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
    droppedLines: 0,
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

  it('routes owner monitor event notifications to the owning agent callback only', () => {
    const parentCallback = vi.fn();
    const ownerCallback = vi.fn();
    registry.setNotificationCallback(parentCallback);
    registry.setAgentNotificationCallback('agent-1', ownerCallback);
    registry.register(createEntry({ ownerAgentId: 'agent-1' }));

    registry.emitEvent('mon-1', 'owned line');

    expect(parentCallback).not.toHaveBeenCalled();
    expect(ownerCallback).toHaveBeenCalledOnce();
    const [, modelText, meta] = ownerCallback.mock.calls[0] as [
      string,
      string,
      { ownerAgentId?: string },
    ];
    expect(modelText).toContain('owned line');
    expect(meta.ownerAgentId).toBe('agent-1');
  });

  it('does not fall back to the parent callback when owner callback is missing', () => {
    const parentCallback = vi.fn();
    registry.setNotificationCallback(parentCallback);
    registry.register(createEntry({ ownerAgentId: 'agent-1' }));

    registry.emitEvent('mon-1', 'owned line');

    expect(parentCallback).not.toHaveBeenCalled();
  });

  it('wakes owner lifecycle callback for silent owner cancellation only', () => {
    const ownerCallback = vi.fn();
    const lifecycleCallback = vi.fn();
    const ac = new AbortController();
    registry.setAgentNotificationCallback('agent-1', ownerCallback);
    registry.setAgentLifecycleCallback('agent-1', lifecycleCallback);
    registry.register(
      createEntry({ ownerAgentId: 'agent-1', abortController: ac }),
    );
    ac.signal.addEventListener(
      'abort',
      () => {
        registry.emitEvent('mon-1', 'late partial line');
      },
      { once: true },
    );

    registry.cancel('mon-1', { notify: false });

    expect(registry.get('mon-1')!.eventCount).toBe(0);
    expect(ownerCallback).not.toHaveBeenCalled();
    expect(lifecycleCallback).toHaveBeenCalledOnce();
  });

  it('does not lifecycle-wake owner monitors that emit terminal notifications', () => {
    const ownerCallback = vi.fn();
    const lifecycleCallback = vi.fn();
    registry.setAgentNotificationCallback('agent-1', ownerCallback);
    registry.setAgentLifecycleCallback('agent-1', lifecycleCallback);
    registry.register(createEntry({ ownerAgentId: 'agent-1' }));

    registry.complete('mon-1', 0);

    expect(ownerCallback).toHaveBeenCalledOnce();
    expect(lifecycleCallback).not.toHaveBeenCalled();
  });

  it('reset clears stale owner callbacks even when there are no entries', () => {
    const ownerCallback = vi.fn();
    const lifecycleCallback = vi.fn();
    registry.setAgentNotificationCallback('agent-1', ownerCallback);
    registry.setAgentLifecycleCallback('agent-1', lifecycleCallback);

    registry.reset();
    registry.register(createEntry({ ownerAgentId: 'agent-1' }));
    registry.emitEvent('mon-1', 'line after reset');
    registry.cancel('mon-1', { notify: false });

    expect(ownerCallback).not.toHaveBeenCalled();
    expect(lifecycleCallback).not.toHaveBeenCalled();
  });

  it('routes owner monitor terminal notifications to the owning agent callback', () => {
    const parentCallback = vi.fn();
    const ownerCallback = vi.fn();
    registry.setNotificationCallback(parentCallback);
    registry.setAgentNotificationCallback('agent-1', ownerCallback);
    registry.register(createEntry({ ownerAgentId: 'agent-1' }));

    registry.complete('mon-1', 0);

    expect(parentCallback).not.toHaveBeenCalled();
    expect(ownerCallback).toHaveBeenCalledOnce();
    const [, modelText, meta] = ownerCallback.mock.calls[0] as [
      string,
      string,
      { ownerAgentId?: string; status: string },
    ];
    expect(modelText).toContain('<status>completed</status>');
    expect(meta.status).toBe('completed');
    expect(meta.ownerAgentId).toBe('agent-1');
  });

  it('only emits register callbacks for top-level monitors', () => {
    const registerCallback = vi.fn();
    registry.setRegisterCallback(registerCallback);

    registry.register(createEntry({ monitorId: 'top' }));
    registry.register(createEntry({ monitorId: 'owned', ownerAgentId: 'a1' }));

    expect(registerCallback).toHaveBeenCalledOnce();
    expect(registerCallback.mock.calls[0][0].monitorId).toBe('top');
  });

  it('reports whether an owner has running monitors', () => {
    registry.register(createEntry({ monitorId: 'top' }));
    registry.register(
      createEntry({ monitorId: 'owned-1', ownerAgentId: 'a1' }),
    );
    registry.register(
      createEntry({ monitorId: 'owned-2', ownerAgentId: 'a2' }),
    );

    expect(registry.hasRunningForOwner('a1')).toBe(true);
    expect(registry.hasRunningForOwner('missing')).toBe(false);

    registry.complete('owned-1', 0);

    expect(registry.hasRunningForOwner('a1')).toBe(false);
    expect(registry.hasRunningForOwner('a2')).toBe(true);
  });

  it('cancels running monitors for a specific owner without notifying', () => {
    const ownerCallback = vi.fn();
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    registry.setAgentNotificationCallback('agent-1', ownerCallback);
    registry.register(
      createEntry({
        monitorId: 'owned-1',
        ownerAgentId: 'agent-1',
        abortController: ac1,
      }),
    );
    registry.register(
      createEntry({
        monitorId: 'owned-2',
        ownerAgentId: 'agent-2',
        abortController: ac2,
      }),
    );

    registry.cancelRunningForOwner('agent-1', { notify: false });

    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(false);
    expect(registry.get('owned-1')!.status).toBe('cancelled');
    expect(registry.get('owned-2')!.status).toBe('running');
    expect(ownerCallback).not.toHaveBeenCalled();
  });

  it('cancels all running owner monitors even when cancellation prunes entries', () => {
    for (let i = 0; i < MAX_RETAINED_TERMINAL_MONITORS; i++) {
      registry.register(createEntry({ monitorId: `old-${i}` }));
      registry.complete(`old-${i}`, 0);
      vi.advanceTimersByTime(1);
    }

    const ownerControllers = [new AbortController(), new AbortController()];
    registry.register(
      createEntry({
        monitorId: 'owned-1',
        ownerAgentId: 'agent-1',
        abortController: ownerControllers[0],
      }),
    );
    registry.register(
      createEntry({
        monitorId: 'owned-2',
        ownerAgentId: 'agent-1',
        abortController: ownerControllers[1],
      }),
    );

    registry.cancelRunningForOwner('agent-1', { notify: false });

    expect(ownerControllers.every(({ signal }) => signal.aborted)).toBe(true);
    expect(registry.get('owned-1')!.status).toBe('cancelled');
    expect(registry.get('owned-2')!.status).toBe('cancelled');
    expect(registry.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_MONITORS);
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

  it('lets cancel abort handlers flush partial output before settling', () => {
    const ac = new AbortController();
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry({ abortController: ac }));
    ac.signal.addEventListener(
      'abort',
      () => {
        registry.emitEvent('mon-1', 'last partial line');
      },
      { once: true },
    );

    registry.cancel('mon-1');

    const entry = registry.get('mon-1')!;
    expect(entry.status).toBe('cancelled');
    expect(entry.eventCount).toBe(1);
    expect(callback).toHaveBeenCalledTimes(2);
    const [, eventModelText] = callback.mock.calls[0] as [string, string];
    const [, terminalModelText] = callback.mock.calls[1] as [string, string];
    expect(eventModelText).toContain('last partial line');
    expect(terminalModelText).toContain('<status>cancelled</status>');
  });

  it('supports silent cancellation without terminal notification', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry());

    registry.cancel('mon-1', { notify: false });

    expect(registry.get('mon-1')!.status).toBe('cancelled');
    expect(callback).not.toHaveBeenCalled();
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

  it('auto-stop is re-entrancy safe: abort-driven flush cannot overshoot maxEvents or double-emit terminal', () => {
    // Simulate the Monitor tool's abort listener flushing a buffered line
    // back into emitEvent() synchronously. Before the fix, this re-entrant
    // call would find status === 'running', increment eventCount past
    // maxEvents, and emit a second "Max events reached" terminal
    // notification. After the fix, settle() runs before abort() so the
    // re-entrant emitEvent() short-circuits on the status guard.
    const ac = new AbortController();
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry({ maxEvents: 2, abortController: ac }));

    // Abort listener that attempts to flush a buffered partial line.
    ac.signal.addEventListener(
      'abort',
      () => {
        registry.emitEvent('mon-1', 'flushed-after-abort');
      },
      { once: true },
    );

    registry.emitEvent('mon-1', 'line 1');
    registry.emitEvent('mon-1', 'line 2'); // triggers auto-stop + abort flush

    const entry = registry.get('mon-1')!;
    expect(entry.status).toBe('completed');
    // eventCount must NOT exceed maxEvents; the flush must be dropped.
    expect(entry.eventCount).toBe(2);
    expect(ac.signal.aborted).toBe(true);
    // Exactly 2 event notifications + 1 terminal notification. Neither the
    // flushed line nor a second "Max events reached" notification fires.
    expect(callback).toHaveBeenCalledTimes(3);
    const terminalCalls = callback.mock.calls.filter(
      (args) =>
        typeof args[1] === 'string' &&
        (args[1] as string).includes('Max events reached'),
    );
    expect(terminalCalls).toHaveLength(1);
    // And no flushed content leaked into any notification.
    for (const args of callback.mock.calls) {
      expect(args[0]).not.toContain('flushed-after-abort');
      expect(args[1]).not.toContain('flushed-after-abort');
    }
  });

  it('truncateDescription caps output at MAX_DESCRIPTION_LENGTH including ellipsis', () => {
    // MAX_DESCRIPTION_LENGTH is a private constant but its value (80) is
    // documented in the tool schema and mirrored by the Monitor tool. Verify
    // that descriptions longer than the cap are truncated to exactly 80
    // chars total (ellipsis included), not 83.
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    const longDesc = 'A'.repeat(200);
    registry.register(createEntry({ description: longDesc }));

    registry.emitEvent('mon-1', 'evt');

    const [displayText, modelText] = callback.mock.calls[0] as [string, string];
    const displayMatch = displayText.match(/Monitor "([^"]*)"/);
    expect(displayMatch).not.toBeNull();
    expect(displayMatch![1]!.length).toBeLessThanOrEqual(80);
    expect(displayMatch![1]!.endsWith('...')).toBe(true);

    // The surrounding `"` chars in the <summary> template are literal;
    // only the description itself flows through escapeXml.
    const modelMatch = modelText.match(/<summary>Monitor "([^"]*)"/);
    expect(modelMatch).not.toBeNull();
    expect(modelMatch![1]!.length).toBeLessThanOrEqual(80);
    expect(modelMatch![1]!.endsWith('...')).toBe(true);
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

  it('lets idle-timeout abort handlers flush partial output before settling', () => {
    const ac = new AbortController();
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(
      createEntry({
        idleTimeoutMs: 5000,
        abortController: ac,
      }),
    );
    ac.signal.addEventListener(
      'abort',
      () => {
        registry.emitEvent('mon-1', 'idle partial line');
      },
      { once: true },
    );

    vi.advanceTimersByTime(5001);

    const entry = registry.get('mon-1')!;
    expect(entry.status).toBe('completed');
    expect(entry.eventCount).toBe(1);
    expect(callback).toHaveBeenCalledTimes(2);
    const [, eventModelText] = callback.mock.calls[0] as [string, string];
    const [, terminalModelText] = callback.mock.calls[1] as [string, string];
    expect(eventModelText).toContain('idle partial line');
    expect(terminalModelText).toContain('Idle timeout');
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

  it('escapes double and single quotes in event lines (defensive for attribute contexts)', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry());

    registry.emitEvent('mon-1', `she said "hi" and it's ok`);

    const [, modelText] = callback.mock.calls[0] as [string, string];
    expect(modelText).toContain('&quot;hi&quot;');
    expect(modelText).toContain('it&apos;s');
    expect(modelText).not.toContain('"hi"');
    expect(modelText).not.toContain("it's");
  });

  it('strips control characters from the displayText (defense-in-depth, not just XML)', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry());

    // Caller passes a line containing NUL, BEL, ESC, and a C1 control.
    // The XML path is already escape-safe; the displayText path must also
    // not leak these bytes into a terminal.
    registry.emitEvent('mon-1', 'before\x00mid\x07\x1B[31mafter\u0085end');

    const [displayText] = callback.mock.calls[0] as [string, string];
    // Verify no C0 (except tab) or C1 controls remain. Iterating code
    // points keeps the assertion free of control characters in the regex
    // literal, which would otherwise trip `no-control-regex`.
    for (let i = 0; i < displayText.length; i++) {
      const code = displayText.charCodeAt(i);
      const isForbidden =
        (code < 0x20 && code !== 0x09) || (code >= 0x80 && code <= 0x9f);
      expect(isForbidden).toBe(false);
    }
    expect(displayText).toContain('before');
    expect(displayText).toContain('mid');
    expect(displayText).toContain('after');
    expect(displayText).toContain('end');
  });

  it('strips control characters from terminal detail XML', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    registry.register(createEntry());

    registry.fail('mon-1', 'before\x00mid\x1B[31mafter\u0085end');

    const [, modelText] = callback.mock.calls[0] as [string, string];
    expect(modelText).toContain('<result>beforemid[31mafterend</result>');
    expect(modelText).not.toContain('\x00');
    expect(modelText).not.toContain('\x1B');
    expect(modelText).not.toContain('\u0085');
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

  it('retains only a bounded number of terminal entries', () => {
    for (let i = 0; i < MAX_RETAINED_TERMINAL_MONITORS + 2; i++) {
      registry.register(createEntry({ monitorId: `mon-${i}` }));
      registry.complete(`mon-${i}`, 0);
      vi.advanceTimersByTime(1);
    }

    expect(registry.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_MONITORS);
    expect(registry.get('mon-0')).toBeUndefined();
    expect(registry.get('mon-1')).toBeUndefined();
    expect(
      registry.get(`mon-${MAX_RETAINED_TERMINAL_MONITORS + 1}`),
    ).toBeDefined();
  });

  it('reset clears retained entries and running monitor timers', () => {
    const ac = new AbortController();
    registry.register(createEntry({ monitorId: 'completed' }));
    registry.complete('completed', 0);
    registry.register(
      createEntry({ monitorId: 'running', abortController: ac }),
    );

    registry.reset();

    expect(registry.getAll()).toEqual([]);
    vi.advanceTimersByTime(300_001);
    expect(registry.getAll()).toEqual([]);
    expect(ac.signal.aborted).toBe(true);
  });

  it('rejects registration when max concurrent monitors reached', () => {
    for (let i = 0; i < 16; i++) {
      registry.register(createEntry({ monitorId: `mon-${i}` }));
    }
    expect(() =>
      registry.register(createEntry({ monitorId: 'mon-overflow' })),
    ).toThrow('maximum concurrent monitors');
  });

  it('allows registration after completed monitors free up slots', () => {
    for (let i = 0; i < 16; i++) {
      registry.register(createEntry({ monitorId: `mon-${i}` }));
    }
    registry.complete('mon-0', 0);
    expect(() =>
      registry.register(createEntry({ monitorId: 'mon-new' })),
    ).not.toThrow();
  });

  it('includes droppedLines count in terminal notification text', () => {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    const entry = createEntry();
    registry.register(entry);

    // Simulate throttle drops (droppedLines is incremented by Monitor tool)
    entry.droppedLines = 5;
    registry.complete('mon-1', 0);

    const [displayText, modelText] = callback.mock.calls[0] as [string, string];
    expect(displayText).toContain('5 lines dropped due to throttling');
    expect(modelText).toContain('5 lines dropped due to throttling');
  });

  describe('setStatusChangeCallback', () => {
    it('fires once on register (nothing → running)', () => {
      const cb = vi.fn();
      registry.setStatusChangeCallback(cb);
      registry.register(createEntry({ monitorId: 'a' }));
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0]?.[0]).toMatchObject({
        monitorId: 'a',
        status: 'running',
      });
    });

    it('fires on every running → terminal transition (complete / fail / cancel)', () => {
      const cb = vi.fn();
      registry.register(createEntry({ monitorId: 'a' }));
      registry.register(createEntry({ monitorId: 'b' }));
      registry.register(createEntry({ monitorId: 'c' }));
      registry.setStatusChangeCallback(cb);

      registry.complete('a', 0);
      registry.fail('b', 'oops');
      registry.cancel('c');

      expect(cb).toHaveBeenCalledTimes(3);
      expect(cb.mock.calls[0]?.[0]).toMatchObject({
        monitorId: 'a',
        status: 'completed',
      });
      expect(cb.mock.calls[1]?.[0]).toMatchObject({
        monitorId: 'b',
        status: 'failed',
      });
      expect(cb.mock.calls[2]?.[0]).toMatchObject({
        monitorId: 'c',
        status: 'cancelled',
      });
    });

    it('does not fire on non-status events (emitEvent without auto-stop)', () => {
      registry.register(createEntry({ monitorId: 'a', maxEvents: 10 }));
      const cb = vi.fn();
      registry.setStatusChangeCallback(cb);
      registry.emitEvent('a', 'log line 1');
      registry.emitEvent('a', 'log line 2');
      expect(cb).not.toHaveBeenCalled();
    });

    it('fires when emitEvent auto-stops at maxEvents (settle path)', () => {
      registry.register(createEntry({ monitorId: 'a', maxEvents: 2 }));
      const cb = vi.fn();
      registry.setStatusChangeCallback(cb);
      registry.emitEvent('a', 'line 1');
      registry.emitEvent('a', 'line 2'); // this hits maxEvents, settle('completed')
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0]?.[0]).toMatchObject({
        monitorId: 'a',
        status: 'completed',
      });
    });

    it('clearing the callback stops further notifications', () => {
      const cb = vi.fn();
      registry.setStatusChangeCallback(cb);
      registry.register(createEntry({ monitorId: 'a' }));
      registry.setStatusChangeCallback(undefined);
      registry.complete('a', 0);
      expect(cb).toHaveBeenCalledTimes(1); // register only
    });

    it('callback failure does not poison the registry', () => {
      const cb = vi.fn(() => {
        throw new Error('subscriber blew up');
      });
      registry.setStatusChangeCallback(cb);
      expect(() =>
        registry.register(createEntry({ monitorId: 'a' })),
      ).not.toThrow();
      expect(registry.get('a')).toBeDefined();
    });

    it('fires once on reset() so dialog snapshots clear stale rows', () => {
      registry.register(createEntry({ monitorId: 'a' }));
      registry.register(createEntry({ monitorId: 'b' }));
      const cb = vi.fn();
      registry.setStatusChangeCallback(cb);
      registry.reset();
      expect(cb).toHaveBeenCalledTimes(1);
      expect(registry.getAll()).toEqual([]);
    });

    it('reset() clears owner callbacks while firing one reset statusChange', () => {
      const ownerCallback = vi.fn();
      const lifecycleCallback = vi.fn();
      registry.setAgentNotificationCallback('agent-1', ownerCallback);
      registry.setAgentLifecycleCallback('agent-1', lifecycleCallback);
      registry.register(createEntry({ monitorId: 'a' }));
      const cb = vi.fn();
      registry.setStatusChangeCallback(cb);

      registry.reset();
      expect(cb).toHaveBeenCalledTimes(1);

      registry.register(
        createEntry({ monitorId: 'after-reset', ownerAgentId: 'agent-1' }),
      );
      registry.emitEvent('after-reset', 'line after reset');
      registry.cancel('after-reset', { notify: false });

      expect(cb).toHaveBeenCalledTimes(3);
      expect(ownerCallback).not.toHaveBeenCalled();
      expect(lifecycleCallback).not.toHaveBeenCalled();
    });

    it('reset() on an empty registry does not fire statusChange', () => {
      const cb = vi.fn();
      registry.setStatusChangeCallback(cb);
      registry.reset();
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
