/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Key } from '../contexts/KeypressContext.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { useSessionPicker } from './useSessionPicker.js';

const keypressState = vi.hoisted(() => ({
  handlers: [] as Array<(key: Key) => void>,
}));

vi.mock('./useKeypress.js', () => ({
  useKeypress: vi.fn((handler: (key: Key) => void, options) => {
    if (options.isActive) {
      keypressState.handlers.push(handler);
    }
  }),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <KeypressProvider kittyProtocolEnabled={false}>{children}</KeypressProvider>
);

function pressKey(key: Partial<Key>) {
  const handler = keypressState.handlers.at(-1);
  expect(handler).toBeDefined();
  act(() => {
    handler?.({
      name: '',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
      ...key,
    });
  });
}

const sessions = [
  {
    sessionId: 's1',
    prompt: 'one',
    cwd: '/tmp',
    gitBranch: 'main',
    startTime: '2025-01-01T00:00:00Z',
    mtime: 0,
    filePath: '/tmp/s1.json',
    messageCount: 1,
  },
  {
    sessionId: 's2',
    prompt: 'two',
    cwd: '/tmp',
    gitBranch: 'main',
    startTime: '2025-01-01T00:00:00Z',
    mtime: 0,
    filePath: '/tmp/s2.json',
    messageCount: 1,
  },
];

beforeEach(() => {
  keypressState.handlers = [];
  vi.clearAllMocks();
});

describe('useSessionPicker invariants', () => {
  it('throws when enableMultiSelect is on without onConfirmMulti', () => {
    // Without onConfirmMulti the Enter handler skips the multi-select
    // branch and silently falls through to single-select on the cursor
    // row — Space still toggles checkboxes and the footer reads
    // "N selected", so the user thinks N items will be deleted but only
    // one is. Refuse the misconfiguration loudly.
    const renderFn = () =>
      renderHook(
        () =>
          useSessionPicker({
            sessionService: null,
            onSelect: vi.fn(),
            onCancel: vi.fn(),
            maxVisibleItems: 5,
            enableMultiSelect: true,
            initialSessions: [],
          }),
        { wrapper },
      );

    expect(renderFn).toThrow(/onConfirmMulti/);
  });

  it('throws when enableMultiSelect and enablePreview both bind Space', () => {
    const renderFn = () =>
      renderHook(
        () =>
          useSessionPicker({
            sessionService: null,
            onSelect: vi.fn(),
            onCancel: vi.fn(),
            maxVisibleItems: 5,
            enableMultiSelect: true,
            enablePreview: true,
            onConfirmMulti: vi.fn(),
            initialSessions: [],
          }),
        { wrapper },
      );

    expect(renderFn).toThrow(/both bind Space/);
  });
});

describe('useSessionPicker multi-select state', () => {
  const renderPicker = (disabledIds?: readonly string[]) =>
    renderHook(
      () =>
        useSessionPicker({
          sessionService: null,
          onSelect: vi.fn(),
          onCancel: vi.fn(),
          onConfirmMulti: vi.fn(),
          maxVisibleItems: 5,
          enableMultiSelect: true,
          initialSessions: sessions,
          disabledIds,
        }),
      { wrapper },
    );

  it('toggleChecked adds and removes ids', () => {
    const { result } = renderPicker();

    expect(result.current.checkedIds.size).toBe(0);

    act(() => result.current.toggleChecked('s1'));
    expect(result.current.checkedIds.has('s1')).toBe(true);

    act(() => result.current.toggleChecked('s1'));
    expect(result.current.checkedIds.has('s1')).toBe(false);
  });

  it('toggleChecked is a no-op on disabled ids', () => {
    // Active session must never enter the commit set even if a future
    // caller wires a Space binding that bypasses the picker's UI gate.
    const { result } = renderPicker(['s1']);

    act(() => result.current.toggleChecked('s1'));

    expect(result.current.checkedIds.has('s1')).toBe(false);
    expect(result.current.disabledIdSet.has('s1')).toBe(true);
  });

  it('toggles the cursor row with Space and commits checked ids with Enter', () => {
    const onConfirmMulti = vi.fn();
    renderHook(
      () =>
        useSessionPicker({
          sessionService: null,
          onSelect: vi.fn(),
          onCancel: vi.fn(),
          onConfirmMulti,
          maxVisibleItems: 5,
          enableMultiSelect: true,
          initialSessions: sessions,
        }),
      { wrapper },
    );

    pressKey({ name: 'space', sequence: ' ' });
    pressKey({ name: 'return', sequence: '\r' });

    expect(onConfirmMulti).toHaveBeenCalledWith(['s1']);
  });

  it('does not commit disabled ids from the keyboard path', () => {
    const onSelect = vi.fn();
    const onConfirmMulti = vi.fn();
    renderHook(
      () =>
        useSessionPicker({
          sessionService: null,
          onSelect,
          onCancel: vi.fn(),
          onConfirmMulti,
          maxVisibleItems: 5,
          enableMultiSelect: true,
          initialSessions: sessions.slice(0, 1),
          disabledIds: ['s1'],
        }),
      { wrapper },
    );

    pressKey({ name: 'space', sequence: ' ' });
    pressKey({ name: 'return', sequence: '\r' });

    expect(onConfirmMulti).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
