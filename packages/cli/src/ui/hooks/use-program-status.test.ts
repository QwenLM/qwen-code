/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { createElement, StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderHook, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { StreamingState } from '../types.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import {
  useProgramStatus,
  programStatusBlockedKind,
} from './use-program-status.js';
import type { ProgramStatusBlockKind } from './use-program-status.js';

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
    vi.stubEnv('KITTY_WINDOW_ID', '');
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
    write.mockClear();
    rerender({
      state: StreamingState.Responding,
      kind: undefined,
      error: true,
      cancellation: 0,
    });
    expect(write).not.toHaveBeenCalled();
    rerender({
      state: StreamingState.Responding,
      kind: undefined,
      error: false,
      cancellation: 0,
    });
    expect(write).not.toHaveBeenCalled();
    rerender({
      state: StreamingState.WaitingForConfirmation,
      kind: 'permission',
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

  it('upgrades a completed result when asynchronous finalization reports an error', () => {
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
      error: false,
      cancellation: 0,
    });
    expect(write).toHaveBeenLastCalledWith(report('done'));
    rerender({
      state: StreamingState.Idle,
      kind: undefined,
      error: true,
      cancellation: 0,
    });
    expect(write).toHaveBeenLastCalledWith(report('error'));
  });

  it('starts the next turn after a cancellation', () => {
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
      error: false,
      cancellation: 1,
    });
    rerender({
      state: StreamingState.Responding,
      kind: undefined,
      error: false,
      cancellation: 1,
    });
    expect(write).toHaveBeenLastCalledWith(report('working'));
    rerender({
      state: StreamingState.Idle,
      kind: undefined,
      error: false,
      cancellation: 1,
    });
    expect(write).toHaveBeenLastCalledWith(report('done'));
  });

  it.each([false, true])(
    'restores a latched result after a dialog (error=%s)',
    (error) => {
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
        error,
        cancellation: 0,
      });
      rerender({
        state: StreamingState.Idle,
        kind: 'question',
        error,
        cancellation: 0,
      });
      expect(write).toHaveBeenLastCalledWith(report('blocked', 'question'));
      rerender({
        state: StreamingState.Idle,
        kind: undefined,
        error,
        cancellation: 0,
      });
      expect(write).toHaveBeenLastCalledWith(report(error ? 'error' : 'done'));
    },
  );

  it('does not restore or emit updates while another program owns the terminal', () => {
    const before = process.listeners('SIGCONT');
    const { rerender } = mount();
    const resume = process
      .listeners('SIGCONT')
      .find((listener) => !before.includes(listener));
    appEvents.emit(AppEvent.TerminalReleased);
    expect(write).toHaveBeenLastCalledWith(clear);
    write.mockClear();
    resume!('SIGCONT');
    rerender({
      state: StreamingState.Responding,
      kind: undefined,
      error: false,
      cancellation: 0,
    });
    expect(write).not.toHaveBeenCalled();
    appEvents.emit(AppEvent.TerminalAcquired);
    expect(write).toHaveBeenLastCalledWith(report('working'));
  });

  it('leaves startup idle current after StrictMode effect remount', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    function Probe() {
      useProgramStatus(StreamingState.Idle, undefined, false, 0);
      return null;
    }
    try {
      await act(async () =>
        root.render(createElement(StrictMode, null, createElement(Probe))),
      );
      expect(write).toHaveBeenLastCalledWith(report('idle'));
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each(['auth', 'permission', 'question'] as const)(
    'keeps %s blocking visible through cancellation wind-down',
    (kind) => {
      const { rerender } = mount();
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
        kind,
        error: true,
        cancellation: 1,
      });
      expect(write).toHaveBeenLastCalledWith(report('blocked', kind));
      rerender({
        state: StreamingState.Idle,
        kind: undefined,
        error: true,
        cancellation: 1,
      });
      expect(write).toHaveBeenLastCalledWith(report('idle'));
    },
  );

  it('wraps reports and handoff clears for tmux passthrough', () => {
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,12345,0');
    mount();
    expect(write).toHaveBeenLastCalledWith(
      '\x1bPtmux;\x1b' + report('idle') + '\x1b\\',
    );
    appEvents.emit(AppEvent.TerminalReleased);
    expect(write).toHaveBeenLastCalledWith('\x1bPtmux;\x1b' + clear + '\x1b\\');
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

  it.each([false, true])(
    'preserves a completed result on exit and unmount (error=%s)',
    (error) => {
      const before = process.listeners('exit');
      const { rerender, unmount } = mount();
      rerender({
        state: StreamingState.Responding,
        kind: undefined,
        error: false,
        cancellation: 0,
      });
      rerender({
        state: StreamingState.Idle,
        kind: undefined,
        error,
        cancellation: 0,
      });
      expect(write).toHaveBeenLastCalledWith(report(error ? 'error' : 'done'));
      const listener = process
        .listeners('exit')
        .find((entry) => !before.includes(entry));
      write.mockClear();
      listener!(0);
      unmount();
      expect(write).not.toHaveBeenCalled();
      expect(process.listeners('exit')).toEqual(before);
    },
  );

  it('clears a dialog overriding a completed result on exit', () => {
    const before = process.listeners('exit');
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
      error: false,
      cancellation: 0,
    });
    rerender({
      state: StreamingState.Idle,
      kind: 'question',
      error: false,
      cancellation: 0,
    });
    const listener = process
      .listeners('exit')
      .find((entry) => !before.includes(entry));
    listener!(0);
    expect(write).toHaveBeenLastCalledWith(clear);
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

describe('programStatusBlockedKind', () => {
  it.each([
    [{ auth: true, question: true, permission: true, dialog: true }, 'auth'],
    [
      { auth: false, question: true, permission: true, dialog: true },
      'question',
    ],
    [
      { auth: false, question: false, permission: true, dialog: true },
      'permission',
    ],
    [
      { auth: false, question: false, permission: false, dialog: true },
      'question',
    ],
    [
      { auth: false, question: false, permission: false, dialog: false },
      undefined,
    ],
  ] as const)(
    'honors the blocked-state precedence for %j',
    (input, expected) => {
      expect(programStatusBlockedKind(input)).toBe(expected);
    },
  );
});
