/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom
import { EventEmitter } from 'node:events';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  MessageBusType,
  type HookProgress,
} from '@qwen-code/qwen-code-core/confirmation-bus/types.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { hookProgressToRow, useHookProgress } from './use-hook-progress.js';

class FakeBus extends EventEmitter {
  subscribe = vi.fn((type: string, listener: (msg: HookProgress) => void) => {
    this.on(type, listener);
  });
  unsubscribe = vi.fn((type: string, listener: (msg: HookProgress) => void) => {
    this.off(type, listener);
  });
  publish(msg: HookProgress) {
    this.emit(msg.type, msg);
  }
}
const progress = (overrides: Partial<HookProgress> = {}): HookProgress => ({
  type: MessageBusType.HOOK_PROGRESS,
  phase: 'end',
  eventName: 'PreToolUse',
  hookName: 'lint',
  hookType: 'command',
  index: 0,
  total: 1,
  ...overrides,
});
function setup() {
  const bus = new FakeBus();
  const config = {
    getMessageBus: () => bus,
    onMessageBusChange: () => vi.fn(),
  } as unknown as Config;
  const onOutcome = vi.fn();
  const hook = renderHook(() => useHookProgress({ config, onOutcome }));
  return {
    ...hook,
    bus,
    onOutcome,
    send: (msg: Partial<HookProgress>) =>
      act(() => {
        bus.publish(progress(msg));
      }),
  };
}
describe('useHookProgress', () => {
  it('shows the event fallback, uses the oldest status, and clears ended hooks', () => {
    const { result, send } = setup();
    send({ phase: 'start' });
    expect(result.current).toBe('Running PreToolUse hooks…');
    send({ phase: 'start', index: 1, statusMessage: 'Later' });
    expect(result.current).toBe('Running PreToolUse hooks…');
    send({ index: 1 });
    expect(result.current).toBe('Running PreToolUse hooks…');
    send({});
    expect(result.current).toBeNull();
  });
  it('shows and sanitizes configured status even while idle', () => {
    const { result, send } = setup();
    send({ phase: 'start', statusMessage: '\x1b[31mLinting…\x1b[0m' });
    expect(result.current).toBe('Linting…');
  });
  it('keeps overlapping batches visible until their final end', () => {
    const { result, send } = setup();
    send({ phase: 'start', statusMessage: 'First batch' });
    send({ phase: 'start', statusMessage: 'Second batch' });
    expect(result.current).toBe('First batch');
    send({});
    expect(result.current).toBe('First batch');
    send({});
    expect(result.current).toBeNull();
  });
  it('falls back when the configured status contains only terminal controls', () => {
    const { result, send } = setup();
    send({ phase: 'start', statusMessage: '\x1b[31m\x1b[0m' });
    expect(result.current).toBe('Running PreToolUse hooks…');
  });
  it('reports outcomes and unsubscribes the exact listener', () => {
    const { bus, onOutcome, send, unmount } = setup();
    send({ outcome: 'timeout', durationMs: 2000 });
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        text: expect.stringContaining("2.0s — raise the hook's timeout"),
      }),
    );
    unmount();
    expect(bus.unsubscribe).toHaveBeenCalledExactlyOnceWith(
      ...bus.subscribe.mock.calls[0],
    );
    send({ outcome: 'error' });
    expect(onOutcome).toHaveBeenCalledTimes(1);
  });
  it('attaches when initialization creates the bus and detaches replaced buses', () => {
    let onBusChange: (bus: FakeBus) => void = () => undefined;
    const unsubscribe = vi.fn();
    const config = {
      getMessageBus: () => undefined,
      onMessageBusChange: (listener: typeof onBusChange) => {
        onBusChange = listener;
        return unsubscribe;
      },
    } as unknown as Config;
    const { result, unmount } = renderHook(() =>
      useHookProgress({ config, onOutcome: vi.fn() }),
    );
    expect(result.current).toBeNull();
    const first = new FakeBus();
    act(() => {
      onBusChange(first);
      first.publish(
        progress({
          phase: 'start',
          eventName: 'SessionStart',
          statusMessage: 'Linting…',
        }),
      );
    });
    expect(result.current).toBe('Linting…');
    const second = new FakeBus();
    act(() => {
      onBusChange(second);
    });
    expect(result.current).toBeNull();
    expect(first.unsubscribe).toHaveBeenCalledExactlyOnceWith(
      ...first.subscribe.mock.calls[0],
    );
    act(() => {
      first.publish(progress({ phase: 'start' }));
    });
    expect(result.current).toBeNull();
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(second.unsubscribe).toHaveBeenCalledExactlyOnceWith(
      ...second.subscribe.mock.calls[0],
    );
  });

  it('allows an absent config', () => {
    const { result } = renderHook(() =>
      useHookProgress({ config: undefined, onOutcome: vi.fn() }),
    );
    expect(result.current).toBeNull();
  });
  it('uses the latest outcome callback without resubscribing', () => {
    const bus = new FakeBus();
    const config = {
      getMessageBus: () => bus,
      onMessageBusChange: () => vi.fn(),
    } as unknown as Config;
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ onOutcome }) => useHookProgress({ config, onOutcome }),
      { initialProps: { onOutcome: first } },
    );
    rerender({ onOutcome: second });
    act(() => {
      bus.publish(progress({ outcome: 'error' }));
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(bus.subscribe).toHaveBeenCalledOnce();
  });
});
describe('hookProgressToRow', () => {
  it.each([
    [
      { outcome: 'error', exitCode: 127, error: 'command not found' },
      'warning',
      'exited with code 127: command not found',
    ],
    [
      { outcome: 'error', error: 'spawn failed' },
      'error',
      'failed: spawn failed',
    ],
    [
      { outcome: 'blocked', blockedReason: 'Denied' },
      'warning',
      'blocked PreToolUse: Denied',
    ],
    [{ outcome: 'success', systemMessage: 'done' }, 'info', 'done'],
    [
      { outcome: 'success', systemMessage: 'warn', level: 'warning' },
      'info',
      'warn',
    ],
    [
      { outcome: 'timeout', durationMs: 2000 },
      'error',
      "2.0s — raise the hook's timeout",
    ],
  ] satisfies Array<[Partial<HookProgress>, string, string]>)(
    'maps %j',
    (msg, level, text) => {
      expect(hookProgressToRow(progress(msg))).toMatchObject({
        level,
        text: expect.stringContaining(text),
      });
    },
  );
  it.each([
    { phase: 'start' },
    { outcome: 'cancelled' },
    { outcome: 'error', async: true },
    { outcome: 'blocked', eventName: 'Stop' },
    { outcome: 'blocked', eventName: 'UserPromptSubmit' },
    { outcome: 'success', eventName: 'Stop', systemMessage: 'stop' },
    { outcome: 'success' },
  ] satisfies Array<Partial<HookProgress>>)('suppresses %j', (msg) => {
    expect(hookProgressToRow(progress(msg))).toBeNull();
  });
  it.each([
    ['command', 'error'],
    ['http', 'error'],
    ['command', 'timeout'],
    ['http', 'timeout'],
    ['command', 'blocked'],
    ['http', 'blocked'],
  ] as const)(
    'does not expose a credential-bearing %s name for %s in text or metadata',
    (hookType, outcome) => {
      const row = hookProgressToRow(
        progress({
          hookType,
          hookName: 'https://user:FAKE_SECRET@example.com?token=FAKE_SECRET',
          outcome,
          exitCode: 1,
          error: 'failed',
        }),
      );
      expect(row).not.toBeNull();
      expect(JSON.stringify(row)).not.toContain('FAKE_SECRET');
      expect(row?.text).toContain(hookType);
    },
  );
  it('removes terminal escapes, invisible formatting and newlines and bounds output', () => {
    const row = hookProgressToRow(
      progress({
        outcome: 'error',
        error: '\x1b[31mred\x1b[0m\n\u202esecret' + 'x'.repeat(600),
      }),
    );
    for (const control of ['\x1b', '\n', '\u202e']) {
      expect(row?.text).not.toContain(control);
    }
    expect(row?.text.length).toBeLessThanOrEqual(503);
  });
});
