/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { renderHook, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { StreamingState } from '../types.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import { useProgramStatus } from './use-program-status.js';
import type { ProgramStatusBlockKind } from './use-program-status.js';

vi.mock('../../utils/osc.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../utils/osc.js')>();
  return { ...original, wrapForMultiplexer: (sequence: string) => sequence };
});

const report = (state: string, kind = '') =>
  `\x1b]7501;state=${state}${kind ? `:kind=${kind}` : ''}:app=qwen-code\x07`;
const clear = '\x1b]7501;state=clear\x07';

describe('useProgramStatus', () => {
  let write: MockInstance<typeof process.stdout.write>;
  const ttyDescriptor = Object.getOwnPropertyDescriptor(
    process.stdout,
    'isTTY',
  );

  beforeEach(() => {
    vi.stubEnv('TERM_PROGRAM', 'unknown');
    vi.stubEnv('TERM', 'xterm');
    vi.stubEnv('STY', '');
    vi.stubEnv('TMUX', '');
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (ttyDescriptor)
      Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  });

  function mount() {
    return renderHook(
      ({ state, kind, error, cancellation }) =>
        useProgramStatus(state, kind, error, cancellation),
      {
        initialProps: {
          state: StreamingState.Idle,
          kind: undefined as ProgramStatusBlockKind | undefined,
          error: false,
          cancellation: 0,
        },
      },
    );
  }

  it('reports working, permission, and latched completion until the next turn', () => {
    const { rerender } = mount();
    expect(write).toHaveBeenLastCalledWith(report('idle'));
    rerender({
      state: StreamingState.Responding,
      kind: undefined,
      error: false,
      cancellation: 0,
    });
    expect(write).toHaveBeenLastCalledWith(report('working'));
    rerender({
      state: StreamingState.WaitingForConfirmation,
      kind: undefined,
      error: false,
      cancellation: 0,
    });
    expect(write).toHaveBeenLastCalledWith(report('blocked', 'permission'));
    rerender({
      state: StreamingState.Idle,
      kind: undefined,
      error: false,
      cancellation: 0,
    });
    expect(write).toHaveBeenLastCalledWith(report('done'));
    write.mockClear();
    rerender({
      state: StreamingState.Idle,
      kind: undefined,
      error: false,
      cancellation: 0,
    });
    expect(write).not.toHaveBeenCalled();
    rerender({
      state: StreamingState.Responding,
      kind: undefined,
      error: false,
      cancellation: 0,
    });
    expect(write).toHaveBeenLastCalledWith(report('working'));
  });

  it.each(['auth', 'question', 'permission'] as const)(
    'reports %s dialogs without inventing a completed turn',
    (kind) => {
      const { rerender } = mount();
      rerender({
        state: StreamingState.Idle,
        kind,
        error: false,
        cancellation: 0,
      });
      expect(write).toHaveBeenLastCalledWith(report('blocked', kind));
      rerender({
        state: StreamingState.Idle,
        kind: undefined,
        error: false,
        cancellation: 0,
      });
      expect(write).toHaveBeenLastCalledWith(report('idle'));
    },
  );

  it('latches errors and returns idle on cancellation', () => {
    const { rerender } = mount();
    rerender({
      state: StreamingState.Responding,
      kind: undefined,
      error: false,
      cancellation: 0,
    });
    rerender({
      state: StreamingState.Idle,
      kind: undefined,
      error: true,
      cancellation: 0,
    });
    expect(write).toHaveBeenLastCalledWith(report('error'));
    rerender({
      state: StreamingState.Idle,
      kind: undefined,
      error: false,
      cancellation: 0,
    });
    expect(write).toHaveBeenLastCalledWith(report('error'));
    rerender({
      state: StreamingState.Responding,
      kind: undefined,
      error: false,
      cancellation: 0,
    });
    rerender({
      state: StreamingState.Responding,
      kind: undefined,
      error: false,
      cancellation: 1,
    });
    expect(write).toHaveBeenLastCalledWith(report('idle'));
    rerender({
      state: StreamingState.Idle,
      kind: undefined,
      error: false,
      cancellation: 1,
    });
    expect(write).toHaveBeenLastCalledWith(report('idle'));
  });

  it('clears on handoff and restores on return, then clears on unmount', () => {
    const { unmount, rerender } = mount();
    rerender({
      state: StreamingState.Responding,
      kind: undefined,
      error: false,
      cancellation: 0,
    });
    appEvents.emit(AppEvent.TerminalReleased);
    expect(write).toHaveBeenLastCalledWith(clear);
    appEvents.emit(AppEvent.TerminalAcquired);
    expect(write).toHaveBeenLastCalledWith(report('working'));
    unmount();
    expect(write).toHaveBeenLastCalledWith(clear);
    write.mockClear();
    appEvents.emit(AppEvent.TerminalAcquired);
    expect(write).not.toHaveBeenCalled();
  });

  it('restores its latched report on resume and removes the listener', () => {
    const before = process.listeners('SIGCONT');
    const { unmount } = mount();
    const listener = process
      .listeners('SIGCONT')
      .find((entry) => !before.includes(entry));
    expect(listener).toBeDefined();
    write.mockClear();
    listener!('SIGCONT');
    expect(write).toHaveBeenCalledWith(report('idle'));
    unmount();
    expect(process.listeners('SIGCONT')).toEqual(before);
  });

  it('clears on process exit and removes its listener', () => {
    const before = process.listeners('exit');
    const { unmount } = mount();
    const listener = process
      .listeners('exit')
      .find((entry) => !before.includes(entry));
    expect(listener).toBeDefined();
    listener!(0);
    expect(write).toHaveBeenLastCalledWith(clear);
    unmount();
    expect(process.listeners('exit')).toEqual(before);
  });

  it('emits no status or cleanup when stdout is not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    const { rerender, unmount } = mount();
    rerender({
      state: StreamingState.Responding,
      kind: undefined,
      error: false,
      cancellation: 0,
    });
    appEvents.emit(AppEvent.TerminalReleased);
    appEvents.emit(AppEvent.TerminalAcquired);
    unmount();
    expect(write).not.toHaveBeenCalled();
  });
});
