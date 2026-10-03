/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import {
  MAX_RETAINED_TERMINAL_MONITORS,
  MonitorRegistry,
  type MonitorNotificationMeta,
  type MonitorTaskRegistration,
} from './monitorRegistry.js';
import { todoWorkChainContext } from '../utils/promptIdContext.js';

type Opts = Partial<MonitorTaskRegistration>;

function createEntry(overrides: Opts = {}): MonitorTaskRegistration {
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
    outputFile: '/tmp/monitor-mon-1.log',
    ...overrides,
  };
}

/** The i-th notification's `[displayText, modelText, meta]`. */
const nth = (cb: Mock, i = 0) =>
  cb.mock.calls[i] as [string, string, MonitorNotificationMeta];

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

  const reg = (monitorId: string, o: Opts = {}) =>
    registry.register(createEntry({ monitorId, ...o }));

  /** Registers `mon-1` (with overrides) behind a parent notification callback. */
  function watch(overrides: Opts = {}) {
    const callback = vi.fn();
    registry.setNotificationCallback(callback);
    const entry = registry.register(createEntry(overrides));
    return { callback, entry, ac: entry.abortController };
  }

  /** Watches `mon-1`, runs `act`, and returns the first notification. */
  function firstNotice(act: () => void, o: Opts = {}) {
    const { callback } = watch(o);
    act();
    return nth(callback);
  }
  const emitOnce = (line: string, o: Opts = {}) =>
    firstNotice(() => registry.emitEvent('mon-1', line), o);

  /** An abort listener that flushes a buffered partial line, as the Monitor tool does. */
  const flushOnAbort = (ac: AbortController, line: string) =>
    ac.signal.addEventListener(
      'abort',
      () => registry.emitEvent('mon-1', line),
      { once: true },
    );

  /** Registers an `agent-1` monitor behind parent and owner callbacks, runs `act`. */
  function routeOwned(act: () => void) {
    const parentCallback = vi.fn();
    const ownerCallback = vi.fn();
    registry.setNotificationCallback(parentCallback);
    registry.setAgentNotificationCallback('agent-1', ownerCallback);
    registry.register(createEntry({ ownerAgentId: 'agent-1' }));
    act();
    return { parentCallback, ownerCallback };
  }

  /** Owner notification and lifecycle callbacks for `agent-1`. */
  function ownAgent1() {
    const owner = vi.fn();
    const lifecycle = vi.fn();
    registry.setAgentNotificationCallback('agent-1', owner);
    registry.setAgentLifecycleCallback('agent-1', lifecycle);
    return { owner, lifecycle };
  }

  /** Registers and completes `n` monitors named `<prefix>-<i>`, 1ms apart. */
  function fillTerminal(n: number, prefix: string) {
    for (let i = 0; i < n; i++) {
      reg(`${prefix}-${i}`);
      registry.complete(`${prefix}-${i}`, 0);
      vi.advanceTimersByTime(1);
    }
  }

  it('does not let an old owner clear a newer status callback', () => {
    const old = vi.fn();
    const current = vi.fn();
    registry.setStatusChangeCallback(old);
    registry.setStatusChangeCallback(current);
    registry.clearStatusChangeCallback(old);
    registry.register(createEntry());
    expect(current).toHaveBeenCalledTimes(1);
    registry.clearStatusChangeCallback(current);
    registry.cancel('mon-1');
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('registers and retrieves a monitor', () => {
    const entry = createEntry();
    registry.register(entry);
    expect(registry.get('mon-1')).toBe(entry);
  });

  it('captures the Todo work-chain owner at registration', () => {
    const entry = todoWorkChainContext.run('work-chain-1', () =>
      registry.register(createEntry()),
    );

    expect(entry.todoWorkChainId).toBe('work-chain-1');
  });

  it('emits event notification via callback', () => {
    const { callback } = watch();
    registry.emitEvent('mon-1', 'hello world');

    expect(callback).toHaveBeenCalledOnce();
    const [displayText, modelText, meta] = nth(callback);
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
    const { parentCallback, ownerCallback } = routeOwned(() =>
      registry.emitEvent('mon-1', 'owned line'),
    );

    expect(parentCallback).not.toHaveBeenCalled();
    expect(ownerCallback).toHaveBeenCalledOnce();
    const [, modelText, meta] = nth(ownerCallback);
    expect(modelText).toContain('owned line');
    expect(meta.ownerAgentId).toBe('agent-1');
  });

  it('does not fall back to the parent callback when owner callback is missing', () => {
    const { callback } = watch({ ownerAgentId: 'agent-1' });
    registry.emitEvent('mon-1', 'owned line');
    expect(callback).not.toHaveBeenCalled();
  });

  it('wakes owner lifecycle callback for silent owner cancellation only', () => {
    const { owner, lifecycle } = ownAgent1();
    const entry = registry.register(createEntry({ ownerAgentId: 'agent-1' }));
    flushOnAbort(entry.abortController, 'late partial line');

    registry.cancel('mon-1', { notify: false });

    expect(registry.get('mon-1')!.eventCount).toBe(0);
    expect(owner).not.toHaveBeenCalled();
    expect(lifecycle).toHaveBeenCalledOnce();
  });

  it('does not lifecycle-wake owner monitors that emit terminal notifications', () => {
    const { owner, lifecycle } = ownAgent1();
    registry.register(createEntry({ ownerAgentId: 'agent-1' }));

    registry.complete('mon-1', 0);

    expect(owner).toHaveBeenCalledOnce();
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it('reset clears stale owner callbacks even when there are no entries', () => {
    const { owner, lifecycle } = ownAgent1();

    registry.reset();
    registry.register(createEntry({ ownerAgentId: 'agent-1' }));
    registry.emitEvent('mon-1', 'line after reset');
    registry.cancel('mon-1', { notify: false });

    expect(owner).not.toHaveBeenCalled();
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it('routes owner monitor terminal notifications to the owning agent callback', () => {
    const { parentCallback, ownerCallback } = routeOwned(() =>
      registry.complete('mon-1', 0),
    );

    expect(parentCallback).not.toHaveBeenCalled();
    expect(ownerCallback).toHaveBeenCalledOnce();
    const [, modelText, meta] = nth(ownerCallback);
    expect(modelText).toContain('<status>completed</status>');
    expect(meta.status).toBe('completed');
    expect(meta.ownerAgentId).toBe('agent-1');
  });

  it('only emits register callbacks for top-level monitors', () => {
    const registerCallback = vi.fn();
    registry.setRegisterCallback(registerCallback);

    reg('top');
    reg('owned', { ownerAgentId: 'a1' });

    expect(registerCallback).toHaveBeenCalledOnce();
    expect(registerCallback.mock.calls[0][0].monitorId).toBe('top');
  });

  it('reports whether an owner has running monitors', () => {
    reg('top');
    reg('owned-1', { ownerAgentId: 'a1' });
    reg('owned-2', { ownerAgentId: 'a2' });

    expect(registry.hasRunningForOwner('a1')).toBe(true);
    expect(registry.hasRunningForOwner('missing')).toBe(false);

    registry.complete('owned-1', 0);

    expect(registry.hasRunningForOwner('a1')).toBe(false);
    expect(registry.hasRunningForOwner('a2')).toBe(true);
  });

  it('cancels running monitors for a specific owner without notifying', () => {
    const ownerCallback = vi.fn();
    registry.setAgentNotificationCallback('agent-1', ownerCallback);
    const ac1 = reg('owned-1', { ownerAgentId: 'agent-1' }).abortController;
    const ac2 = reg('owned-2', { ownerAgentId: 'agent-2' }).abortController;

    registry.cancelRunningForOwner('agent-1', { notify: false });

    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(false);
    expect(registry.get('owned-1')!.status).toBe('cancelled');
    expect(registry.get('owned-2')!.status).toBe('running');
    expect(ownerCallback).not.toHaveBeenCalled();
  });

  it('cancels all running owner monitors even when cancellation prunes entries', () => {
    fillTerminal(MAX_RETAINED_TERMINAL_MONITORS, 'old');
    const owned = ['owned-1', 'owned-2'].map((id) =>
      reg(id, { ownerAgentId: 'agent-1' }),
    );

    registry.cancelRunningForOwner('agent-1', { notify: false });

    expect(owned.every((e) => e.abortController.signal.aborted)).toBe(true);
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
    const { callback, entry } = watch({ command: 'grep "a&b" < /dev/null' });

    registry.complete('mon-1', 0);

    expect(entry.status).toBe('completed');
    expect(entry.endTime).toBeDefined();
    expect(callback).toHaveBeenCalledOnce();
    const [displayText, modelText] = nth(callback);
    expect(displayText).toContain('completed');
    expect(modelText).toContain('<status>completed</status>');
    expect(modelText).toContain(
      '<command>grep &quot;a&amp;b&quot; &lt; /dev/null</command>',
    );
    expect(modelText).toContain('Exited with code 0');
  });

  it('fails a monitor and emits terminal notification', () => {
    const { callback, entry } = watch();

    registry.fail('mon-1', 'spawn ENOENT');

    expect(entry.status).toBe('failed');
    expect(callback).toHaveBeenCalledOnce();
    const [displayText, modelText] = nth(callback);
    expect(displayText).toContain('failed');
    expect(modelText).toContain('<status>failed</status>');
    expect(modelText).toContain('spawn ENOENT');
  });

  it('cancels a running monitor and aborts its controller', () => {
    const { abortController: ac } = registry.register(createEntry());

    registry.cancel('mon-1');

    expect(registry.get('mon-1')!.status).toBe('cancelled');
    expect(ac.signal.aborted).toBe(true);
  });

  it('lets cancel abort handlers flush partial output before settling', () => {
    const { callback, entry, ac } = watch();
    flushOnAbort(ac, 'last partial line');

    registry.cancel('mon-1');

    expect(entry.status).toBe('cancelled');
    expect(entry.eventCount).toBe(1);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(nth(callback, 0)[1]).toContain('last partial line');
    expect(nth(callback, 1)[1]).toContain('<status>cancelled</status>');
  });

  it('supports silent cancellation without terminal notification', () => {
    const { callback } = watch();

    registry.cancel('mon-1', { notify: false });

    expect(registry.get('mon-1')!.status).toBe('cancelled');
    expect(callback).not.toHaveBeenCalled();
  });

  it('no-op: complete after cancel (one-shot terminal guard)', () => {
    const { callback } = watch();

    registry.cancel('mon-1');
    registry.complete('mon-1', 0);

    expect(registry.get('mon-1')!.status).toBe('cancelled');
    expect(callback).toHaveBeenCalledTimes(1); // only cancel notification
  });

  it('no-op: emitEvent after cancel', () => {
    const { callback } = watch();

    registry.cancel('mon-1');
    registry.emitEvent('mon-1', 'late line');

    // Only the cancel notification, no event notification
    expect(callback).toHaveBeenCalledTimes(1);
    expect(registry.get('mon-1')!.eventCount).toBe(0);
  });

  it('auto-stops when maxEvents is reached', () => {
    const { callback, ac } = watch({ maxEvents: 3 });

    registry.emitEvent('mon-1', 'line 1');
    registry.emitEvent('mon-1', 'line 2');
    registry.emitEvent('mon-1', 'line 3'); // triggers auto-stop

    expect(registry.get('mon-1')!.status).toBe('completed');
    expect(ac.signal.aborted).toBe(true);
    // 3 event notifications + 1 terminal notification ("Max events reached")
    expect(callback).toHaveBeenCalledTimes(4);
    const [, terminalModelText] = nth(callback, 3);
    expect(terminalModelText).toContain('Max events reached');
    expect(terminalModelText).toContain('<status>completed</status>');
  });

  it('auto-stop is re-entrancy safe: abort-driven flush cannot overshoot maxEvents or double-emit terminal', () => {
    // The Monitor tool's abort listener flushes a buffered line back into
    // emitEvent() synchronously. Before the fix that re-entrant call saw
    // status === 'running', pushed eventCount past maxEvents and emitted a
    // second "Max events reached"; now settle() runs before abort() so it
    // short-circuits on the status guard.
    const { callback, entry, ac } = watch({ maxEvents: 2 });
    flushOnAbort(ac, 'flushed-after-abort');

    registry.emitEvent('mon-1', 'line 1');
    registry.emitEvent('mon-1', 'line 2'); // triggers auto-stop + abort flush

    expect(entry.status).toBe('completed');
    // eventCount must NOT exceed maxEvents; the flush must be dropped.
    expect(entry.eventCount).toBe(2);
    expect(ac.signal.aborted).toBe(true);
    // Exactly 2 events + 1 terminal: no flushed line, no second terminal.
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

  it('caps notification descriptions at the label max length including ellipsis', () => {
    // The 80-char cap (NOTIFICATION_LABEL_MAX_LENGTH in terminalSafe.ts) is
    // documented in the tool schema and mirrored by the Monitor tool: longer
    // descriptions truncate to exactly 80 chars including the ellipsis, not 83.
    const [displayText, modelText] = emitOnce('evt', {
      description: 'A'.repeat(200),
    });
    const displayMatch = displayText.match(/Monitor "([^"]*)"/);
    expect(displayMatch).not.toBeNull();
    expect(displayMatch![1]!.length).toBeLessThanOrEqual(80);
    expect(displayMatch![1]!.endsWith('...')).toBe(true);

    // The `"` around the description in <summary> are literal template
    // chars; only the description itself flows through escapeXml.
    const modelMatch = modelText.match(/<summary>Monitor "([^"]*)"/);
    expect(modelMatch).not.toBeNull();
    expect(modelMatch![1]!.length).toBeLessThanOrEqual(80);
    expect(modelMatch![1]!.endsWith('...')).toBe(true);
  });

  it('auto-stops on idle timeout', () => {
    const { callback, ac } = watch({ idleTimeoutMs: 5000 });

    // Fast-forward past the idle timeout
    vi.advanceTimersByTime(5001);

    expect(registry.get('mon-1')!.status).toBe('completed');
    expect(ac.signal.aborted).toBe(true);
    // Terminal notification from idle timeout
    expect(callback).toHaveBeenCalledOnce();
    expect(nth(callback)[1]).toContain('Idle timeout');
  });

  it('lets idle-timeout abort handlers flush partial output before settling', () => {
    const { callback, entry, ac } = watch({ idleTimeoutMs: 5000 });
    flushOnAbort(ac, 'idle partial line');

    vi.advanceTimersByTime(5001);

    expect(entry.status).toBe('completed');
    expect(entry.eventCount).toBe(1);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(nth(callback, 0)[1]).toContain('idle partial line');
    expect(nth(callback, 1)[1]).toContain('Idle timeout');
  });

  it('resets idle timer on emitEvent', () => {
    registry.register(createEntry({ idleTimeoutMs: 5000 }));

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
    ['a', 'b', 'c'].forEach((id) => reg(id));

    registry.complete('a', 0);
    registry.cancel('c');

    const running = registry.getRunning();
    expect(running).toHaveLength(1);
    expect(running[0].monitorId).toBe('b');
  });

  it('abortAll cancels all running monitors', () => {
    const ac1 = reg('a').abortController;
    const ac2 = reg('b').abortController;

    registry.abortAll();

    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);
    expect(registry.get('a')!.status).toBe('cancelled');
    expect(registry.get('b')!.status).toBe('cancelled');
  });

  it('truncates long event lines', () => {
    const [, modelText] = emitOnce('x'.repeat(3000));
    expect(modelText).toContain('...[truncated]');
    expect(modelText).not.toContain('x'.repeat(3000));
  });

  it('escapes XML metacharacters in event lines', () => {
    const [, modelText] = emitOnce('<script>alert("xss")</script>');
    expect(modelText).toContain('&lt;script&gt;');
    expect(modelText).not.toContain('<script>');
    // Only one closing task-notification tag
    expect(modelText.match(/<\/task-notification>/g)!.length).toBe(1);
  });

  it('escapes double and single quotes in event lines (defensive for attribute contexts)', () => {
    const [, modelText] = emitOnce(`she said "hi" and it's ok`);
    expect(modelText).toContain('&quot;hi&quot;');
    expect(modelText).toContain('it&apos;s');
    expect(modelText).not.toContain('"hi"');
    expect(modelText).not.toContain("it's");
  });

  it('strips control characters from the displayText (defense-in-depth, not just XML)', () => {
    // NUL, BEL, ESC and a C1 control: the XML path is already escape-safe,
    // but displayText must not leak these bytes into a terminal either.
    const [displayText] = emitOnce('before\x00mid\x07\x1B[31mafter\u0085end');
    // No C0 (except tab) or C1 controls remain. Iterating code points keeps
    // control characters out of a regex literal (`no-control-regex`).
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
    const [, modelText] = firstNotice(() =>
      registry.fail('mon-1', 'before\x00mid\x1B[31mafter\u0085end'),
    );
    expect(modelText).toContain('<result>beforemid[31mafterend</result>');
    expect(modelText).not.toContain('\x00');
    expect(modelText).not.toContain('\x1B');
    expect(modelText).not.toContain('\u0085');
  });

  it('strips BIDI overrides from the streaming event <result>, not just the display line', () => {
    // The display line uses `safeEventLine`, but the model-facing <result>
    // used to render the raw line: the one path carrying live untrusted
    // process output (server logs, third-party stdout) to the model. All
    // nine codepoints of both ranges are pinned so a bound typo ships red.
    const [displayText, modelText] = emitOnce('/tmp/a‪‫‬‭‮evil⁦⁧⁨⁩/out.log');
    expect(modelText).toContain('<result>/tmp/aevil/out.log</result>');
    const bidi = '‪‫‬‭‮⁦⁧⁨⁩';
    for (const ch of bidi) {
      expect(modelText).not.toContain(ch);
      expect(displayText).not.toContain(ch);
    }
  });

  it('propagates toolUseId in notification XML and meta', () => {
    const [, modelText, meta] = emitOnce('test line', {
      toolUseId: 'call-xyz',
    });
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
    const [, modelText] = firstNotice(() => registry.complete('mon-1', null));
    expect(modelText).toContain('<status>completed</status>');
    expect(modelText).not.toContain('<result>');
  });

  it('setNotificationCallback(undefined) clears the callback', () => {
    const { callback } = watch();

    registry.setNotificationCallback(undefined);
    registry.emitEvent('mon-1', 'after clear');

    expect(callback).not.toHaveBeenCalled();
  });

  it('getAll returns all entries regardless of status', () => {
    ['a', 'b', 'c'].forEach((id) => reg(id));

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
    fillTerminal(MAX_RETAINED_TERMINAL_MONITORS + 2, 'mon');

    expect(registry.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_MONITORS);
    expect(registry.get('mon-0')).toBeUndefined();
    expect(registry.get('mon-1')).toBeUndefined();
    expect(
      registry.get(`mon-${MAX_RETAINED_TERMINAL_MONITORS + 1}`),
    ).toBeDefined();
  });

  it('reset clears retained entries and running monitor timers', () => {
    reg('completed');
    registry.complete('completed', 0);
    const ac = reg('running').abortController;

    registry.reset();

    expect(registry.getAll()).toEqual([]);
    vi.advanceTimersByTime(300_001);
    expect(registry.getAll()).toEqual([]);
    expect(ac.signal.aborted).toBe(true);
  });

  it('rejects registration when max concurrent monitors reached', () => {
    for (let i = 0; i < 16; i++) reg(`mon-${i}`);
    expect(() => reg('mon-overflow')).toThrow('maximum concurrent monitors');
  });

  it('allows registration after completed monitors free up slots', () => {
    for (let i = 0; i < 16; i++) reg(`mon-${i}`);
    registry.complete('mon-0', 0);
    expect(() => reg('mon-new')).not.toThrow();
  });

  it('includes droppedLines count in terminal notification text', () => {
    const { callback, entry } = watch();

    // Simulate throttle drops (droppedLines is incremented by Monitor tool)
    entry.droppedLines = 5;
    registry.complete('mon-1', 0);

    const [displayText, modelText] = nth(callback);
    expect(displayText).toContain('5 lines dropped due to throttling');
    expect(modelText).toContain('5 lines dropped due to throttling');
  });

  describe('setStatusChangeCallback', () => {
    const expectChange = (
      cb: Mock,
      i: number,
      monitorId: string,
      status: string,
    ) => expect(cb.mock.calls[i]?.[0]).toMatchObject({ monitorId, status });

    it('fires once on register (nothing → running)', () => {
      const cb = vi.fn();
      registry.setStatusChangeCallback(cb);
      reg('a');
      expect(cb).toHaveBeenCalledTimes(1);
      expectChange(cb, 0, 'a', 'running');
    });

    it('fires on every running → terminal transition (complete / fail / cancel)', () => {
      const cb = vi.fn();
      ['a', 'b', 'c'].forEach((id) => reg(id));
      registry.setStatusChangeCallback(cb);

      registry.complete('a', 0);
      registry.fail('b', 'oops');
      registry.cancel('c');

      expect(cb).toHaveBeenCalledTimes(3);
      expectChange(cb, 0, 'a', 'completed');
      expectChange(cb, 1, 'b', 'failed');
      expectChange(cb, 2, 'c', 'cancelled');
    });

    it('does not fire on non-status events (emitEvent without auto-stop)', () => {
      reg('a', { maxEvents: 10 });
      const cb = vi.fn();
      registry.setStatusChangeCallback(cb);
      registry.emitEvent('a', 'log line 1');
      registry.emitEvent('a', 'log line 2');
      expect(cb).not.toHaveBeenCalled();
    });

    it('fires when emitEvent auto-stops at maxEvents (settle path)', () => {
      reg('a', { maxEvents: 2 });
      const cb = vi.fn();
      registry.setStatusChangeCallback(cb);
      registry.emitEvent('a', 'line 1');
      registry.emitEvent('a', 'line 2'); // this hits maxEvents, settle('completed')
      expect(cb).toHaveBeenCalledTimes(1);
      expectChange(cb, 0, 'a', 'completed');
    });

    it('clearing the callback stops further notifications', () => {
      const cb = vi.fn();
      registry.setStatusChangeCallback(cb);
      reg('a');
      registry.setStatusChangeCallback(undefined);
      registry.complete('a', 0);
      expect(cb).toHaveBeenCalledTimes(1); // register only
    });

    it('callback failure does not poison the registry', () => {
      const cb = vi.fn(() => {
        throw new Error('subscriber blew up');
      });
      registry.setStatusChangeCallback(cb);
      expect(() => reg('a')).not.toThrow();
      expect(registry.get('a')).toBeDefined();
    });

    it('fires once on reset() so dialog snapshots clear stale rows', () => {
      reg('a');
      reg('b');
      const cb = vi.fn();
      registry.setStatusChangeCallback(cb);
      registry.reset();
      expect(cb).toHaveBeenCalledTimes(1);
      expect(registry.getAll()).toEqual([]);
    });

    it('reset() clears owner callbacks while firing one reset statusChange', () => {
      const { owner, lifecycle } = ownAgent1();
      reg('a');
      const cb = vi.fn();
      registry.setStatusChangeCallback(cb);

      registry.reset();
      expect(cb).toHaveBeenCalledTimes(1);

      reg('after-reset', { ownerAgentId: 'agent-1' });
      registry.emitEvent('after-reset', 'line after reset');
      registry.cancel('after-reset', { notify: false });

      expect(cb).toHaveBeenCalledTimes(3);
      expect(owner).not.toHaveBeenCalled();
      expect(lifecycle).not.toHaveBeenCalled();
    });

    it('reset() on an empty registry does not fire statusChange', () => {
      const cb = vi.fn();
      registry.setStatusChangeCallback(cb);
      registry.reset();
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('notified flag prevents duplicate terminal notifications', () => {
    const terminalCalls = (cb: Mock) =>
      cb.mock.calls.filter(
        (args: unknown[]) =>
          (args[1] as string).includes('<status>completed</status>') ||
          (args[1] as string).includes('<status>cancelled</status>'),
      );

    it('complete() then cancel() emits only one terminal notification', () => {
      const { callback } = watch();
      registry.complete('mon-1', 0);
      expect(terminalCalls(callback)).toHaveLength(1);
    });

    it('cancel({notify:false}) prevents subsequent complete() from emitting', () => {
      const { callback } = watch();

      registry.cancel('mon-1', { notify: false });
      registry.complete('mon-1', 0);

      const statusCalls = callback.mock.calls.filter((args: unknown[]) =>
        (args[1] as string).includes('<status>'),
      );
      expect(statusCalls).toHaveLength(0);
    });

    it('idle timeout then cancel emits only one terminal notification', () => {
      const { callback } = watch({ idleTimeoutMs: 100 });
      vi.advanceTimersByTime(100);
      expect(terminalCalls(callback)).toHaveLength(1);
    });
  });
});
