/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Key } from '../../contexts/KeypressContext.js';
import type { FleetSessionEntry } from '../../contexts/FleetViewContext.js';
import { FleetView, type FleetViewProps } from './FleetView.js';
import { useKeypress } from '../../hooks/useKeypress.js';

vi.mock('../../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));
const mockedUseKeypress = vi.mocked(useKeypress);

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ rows: 30, columns: 120 }),
}));

vi.mock('../AlternateScreen.js', () => ({
  AlternateScreen: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

function makeKey(overrides: Partial<Key> = {}): Key {
  return {
    name: '',
    ctrl: false,
    meta: false,
    shift: false,
    paste: false,
    sequence: '',
    ...overrides,
  };
}

function makeEntry(
  overrides: Partial<FleetSessionEntry> = {},
): FleetSessionEntry {
  return {
    sessionId: 'sess-1',
    cwd: '/home/user/project',
    startTime: '2026-01-01T00:00:00Z',
    mtime: Date.now(),
    prompt: 'Fix the login bug',
    filePath: '/home/user/.qwen/sessions/sess-1.jsonl',
    status: 'idle',
    displayName: 'Fix the login bug',
    ...overrides,
  };
}

function makeProps(overrides: Partial<FleetViewProps> = {}): FleetViewProps {
  return {
    sessions: [
      makeEntry({ sessionId: 'sess-1', status: 'current' }),
      makeEntry({
        sessionId: 'sess-2',
        displayName: 'Add tests',
        prompt: 'Add tests',
      }),
      makeEntry({
        sessionId: 'sess-3',
        displayName: 'Refactor auth',
        prompt: 'Refactor auth',
      }),
    ],
    selectedIndex: 0,
    loading: false,
    error: null,
    groupMode: 'state',
    onSelect: vi.fn(),
    onAttach: vi.fn(),
    onClose: vi.fn(),
    onDelete: vi.fn(() => true),
    onCreateNew: vi.fn(),
    onCycleGroupMode: vi.fn(),
    ...overrides,
  };
}

let capturedHandler: ((key: Key) => void) | null = null;

function renderFleetView(props: FleetViewProps) {
  capturedHandler = null;
  mockedUseKeypress.mockImplementation((handler) => {
    capturedHandler = handler;
  });
  return render(<FleetView {...props} />);
}

function pressKey(overrides: Partial<Key>) {
  if (!capturedHandler) throw new Error('No keypress handler captured');
  act(() => {
    capturedHandler!(makeKey(overrides));
  });
}

describe('<FleetView />', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders session list with group headers', () => {
    const props = makeProps();
    const { lastFrame } = renderFleetView(props);
    const output = lastFrame()!;
    expect(output).toContain('Current');
    expect(output).toContain('Idle');
    expect(output).toContain('Fix the login bug');
    expect(output).toContain('Add tests');
  });

  it('navigates down with down arrow', () => {
    const props = makeProps();
    renderFleetView(props);
    pressKey({ name: 'down' });
    expect(props.onSelect).toHaveBeenCalledWith(1);
  });

  it('navigates up with up arrow', () => {
    const props = makeProps({ selectedIndex: 2 });
    renderFleetView(props);
    pressKey({ name: 'up' });
    expect(props.onSelect).toHaveBeenCalledWith(1);
  });

  it('does not navigate below zero', () => {
    const props = makeProps({ selectedIndex: 0 });
    renderFleetView(props);
    pressKey({ name: 'up' });
    expect(props.onSelect).toHaveBeenCalledWith(0);
  });

  it('attaches on Enter', () => {
    const props = makeProps();
    renderFleetView(props);
    pressKey({ name: 'return' });
    expect(props.onAttach).toHaveBeenCalledWith('sess-1');
  });

  it('attaches on right arrow', () => {
    const props = makeProps();
    renderFleetView(props);
    pressKey({ name: 'right' });
    expect(props.onAttach).toHaveBeenCalledWith('sess-1');
  });

  it('attaches on Enter in peek mode', () => {
    const props = makeProps();
    renderFleetView(props);
    pressKey({ name: 'space' });
    pressKey({ name: 'return' });
    expect(props.onAttach).toHaveBeenCalledWith('sess-1');
  });

  it('opens peek mode on space', () => {
    const props = makeProps();
    const { lastFrame } = renderFleetView(props);
    pressKey({ name: 'space' });
    expect(lastFrame()!).toContain('space to close');
  });

  it('closes peek mode on escape', () => {
    const props = makeProps();
    const { lastFrame } = renderFleetView(props);
    pressKey({ name: 'space' });
    pressKey({ name: 'escape' });
    expect(lastFrame()!).toContain('space to preview');
  });

  it('closes on escape with empty input', () => {
    const props = makeProps();
    renderFleetView(props);
    pressKey({ name: 'escape' });
    expect(props.onClose).toHaveBeenCalled();
  });

  it('closes on Ctrl+C with empty input', () => {
    const props = makeProps();
    renderFleetView(props);
    pressKey({ name: 'c', ctrl: true });
    expect(props.onClose).toHaveBeenCalled();
  });

  describe('delete confirmation (Ctrl+X)', () => {
    it('requires two presses to delete', () => {
      const props = makeProps();
      renderFleetView(props);

      pressKey({ name: 'x', ctrl: true });
      expect(props.onDelete).not.toHaveBeenCalled();

      pressKey({ name: 'x', ctrl: true });
      expect(props.onDelete).toHaveBeenCalledWith('sess-1');
    });

    it('shows confirmation status on first press', () => {
      const props = makeProps();
      const { lastFrame } = renderFleetView(props);
      pressKey({ name: 'x', ctrl: true });
      expect(lastFrame()!).toContain('Press Ctrl+X again to confirm deletion');
    });

    it('resets pending delete after timeout', () => {
      const props = makeProps();
      renderFleetView(props);

      pressKey({ name: 'x', ctrl: true });
      act(() => {
        vi.advanceTimersByTime(2100);
      });

      pressKey({ name: 'x', ctrl: true });
      expect(props.onDelete).not.toHaveBeenCalled();
    });

    it('shows error message when deleting active session', () => {
      const props = makeProps({
        onDelete: vi.fn(() => false),
      });
      const { lastFrame } = renderFleetView(props);

      pressKey({ name: 'x', ctrl: true });
      pressKey({ name: 'x', ctrl: true });
      expect(lastFrame()!).toContain('Cannot delete the active session');
    });
  });

  describe('dispatch input', () => {
    it('captures printable characters when onDispatch is provided', () => {
      const onDispatch = vi.fn();
      const props = makeProps({ onDispatch });
      const { lastFrame } = renderFleetView(props);

      pressKey({ name: 'h', sequence: 'h' });
      pressKey({ name: 'i', sequence: 'i' });
      expect(lastFrame()!).toContain('hi');
    });

    it('dispatches on Enter with text', () => {
      const onDispatch = vi.fn();
      const props = makeProps({ onDispatch });
      renderFleetView(props);

      pressKey({ name: 'h', sequence: 'h' });
      pressKey({ name: 'i', sequence: 'i' });
      pressKey({ name: 'return' });
      expect(onDispatch).toHaveBeenCalledWith('hi');
    });

    it('allows spaces in dispatch input after first character', () => {
      const onDispatch = vi.fn();
      const props = makeProps({ onDispatch });
      renderFleetView(props);

      pressKey({ name: 'h', sequence: 'h' });
      pressKey({ name: 'space', sequence: ' ' });
      pressKey({ name: 'i', sequence: 'i' });
      pressKey({ name: 'return' });
      expect(onDispatch).toHaveBeenCalledWith('h i');
    });

    it('space opens peek mode when input is empty', () => {
      const onDispatch = vi.fn();
      const props = makeProps({ onDispatch });
      const { lastFrame } = renderFleetView(props);

      pressKey({ name: 'space' });
      expect(lastFrame()!).toContain('space to close');
    });

    it('clears input on Ctrl+C', () => {
      const onDispatch = vi.fn();
      const props = makeProps({ onDispatch });
      const { lastFrame } = renderFleetView(props);

      pressKey({ name: 'h', sequence: 'h' });
      pressKey({ name: 'c', ctrl: true });
      expect(lastFrame()!).toContain('type a message to send');
      expect(props.onClose).not.toHaveBeenCalled();
    });

    it('does not capture characters when onDispatch is undefined', () => {
      const props = makeProps();
      const { lastFrame } = renderFleetView(props);

      pressKey({ name: 'h', sequence: 'h' });
      expect(lastFrame()!).not.toContain('type a message');
    });

    it('handles backspace in dispatch input', () => {
      const onDispatch = vi.fn();
      const props = makeProps({ onDispatch });
      renderFleetView(props);

      pressKey({ name: 'h', sequence: 'h' });
      pressKey({ name: 'i', sequence: 'i' });
      pressKey({ name: 'backspace' });
      pressKey({ name: 'return' });
      expect(onDispatch).toHaveBeenCalledWith('h');
    });

    it('handles bracketed paste in dispatch input', () => {
      const onDispatch = vi.fn();
      const props = makeProps({ onDispatch });
      renderFleetView(props);

      pressKey({ name: 'h', sequence: 'h' });
      pressKey({ paste: true, sequence: 'ello world' });
      pressKey({ name: 'return' });
      expect(onDispatch).toHaveBeenCalledWith('hello world');
    });
  });

  describe('rename mode (Ctrl+R)', () => {
    it('enters rename mode on Ctrl+R', () => {
      const props = makeProps({
        sessionService: {
          renameSession: vi.fn().mockResolvedValue(true),
        } as never,
      });
      const { lastFrame } = renderFleetView(props);

      pressKey({ name: 'r', ctrl: true });
      expect(lastFrame()!).toContain('enter to save');
    });

    it('exits rename mode on escape', () => {
      const props = makeProps({
        sessionService: {
          renameSession: vi.fn().mockResolvedValue(true),
        } as never,
      });
      const { lastFrame } = renderFleetView(props);

      pressKey({ name: 'r', ctrl: true });
      pressKey({ name: 'escape' });
      expect(lastFrame()!).not.toContain('enter to save');
    });

    it('saves rename on Enter', async () => {
      const renameSession = vi.fn().mockResolvedValue(true);
      const onRefresh = vi.fn();
      const props = makeProps({
        sessionService: { renameSession } as never,
        onRefresh,
      });
      const { lastFrame } = renderFleetView(props);

      pressKey({ name: 'r', ctrl: true });
      pressKey({ name: 'n', sequence: 'n' });
      pressKey({ name: 'e', sequence: 'e' });
      pressKey({ name: 'w', sequence: 'w' });
      pressKey({ name: 'return' });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(renameSession).toHaveBeenCalledWith(
        'sess-1',
        'Fix the login bugnew',
      );
      expect(onRefresh).toHaveBeenCalled();
      expect(lastFrame()!).toContain('Renamed to "Fix the login bugnew"');
    });

    it('shows failure status and skips refresh when rename returns false', async () => {
      const renameSession = vi.fn().mockResolvedValue(false);
      const onRefresh = vi.fn();
      const props = makeProps({
        sessionService: { renameSession } as never,
        onRefresh,
      });
      const { lastFrame } = renderFleetView(props);

      pressKey({ name: 'r', ctrl: true });
      pressKey({ name: 'n', sequence: 'n' });
      pressKey({ name: 'return' });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(renameSession).toHaveBeenCalledWith(
        'sess-1',
        'Fix the login bugn',
      );
      expect(onRefresh).not.toHaveBeenCalled();
      expect(lastFrame()!).toContain('Rename failed');
    });
  });

  it('cycles group mode on Ctrl+S', () => {
    const props = makeProps();
    renderFleetView(props);
    pressKey({ name: 's', ctrl: true });
    expect(props.onCycleGroupMode).toHaveBeenCalled();
  });

  it('shows loading indicator', () => {
    const props = makeProps({ loading: true });
    const { lastFrame } = renderFleetView(props);
    expect(lastFrame()!).toContain('↻');
  });

  it('shows error message', () => {
    const props = makeProps({ error: 'Something went wrong' });
    const { lastFrame } = renderFleetView(props);
    expect(lastFrame()!).toContain('Something went wrong');
  });

  it('shows empty state when no sessions', () => {
    const props = makeProps({ sessions: [] });
    const { lastFrame } = renderFleetView(props);
    expect(lastFrame()!).toContain('No sessions found');
  });

  describe('selection clamping and scrolling', () => {
    it('clamps selection when the entry list shrinks below selectedIndex', () => {
      const props = makeProps({ selectedIndex: 2 });
      const { rerender } = renderFleetView(props);

      rerender(
        <FleetView
          {...makeProps({
            sessions: [makeEntry({ sessionId: 'sess-1', status: 'current' })],
            selectedIndex: 2,
            onSelect: props.onSelect,
          })}
        />,
      );

      expect(props.onSelect).toHaveBeenCalledWith(0);
    });

    it('does not select anything when the list becomes empty', () => {
      const props = makeProps({ selectedIndex: 2 });
      const { rerender } = renderFleetView(props);

      rerender(
        <FleetView
          {...makeProps({
            sessions: [],
            selectedIndex: 2,
            onSelect: props.onSelect,
          })}
        />,
      );

      expect(props.onSelect).not.toHaveBeenCalled();
    });

    it('scrolls the window so a far-down selection stays visible', () => {
      const sessions = Array.from({ length: 30 }, (_, i) =>
        makeEntry({
          sessionId: `sess-${i}`,
          displayName: `Session ${i}`,
          prompt: `Prompt ${i}`,
          status: 'idle',
        }),
      );
      const props = makeProps({ sessions, selectedIndex: 29 });
      const { lastFrame } = renderFleetView(props);

      expect(lastFrame()!).toContain('Session 29');
      expect(lastFrame()!).not.toContain('Session 0');
    });
  });

  describe('delete key in dispatch input', () => {
    it('removes the last character on Delete', () => {
      const onDispatch = vi.fn();
      const props = makeProps({ onDispatch });
      renderFleetView(props);

      pressKey({ name: 'h', sequence: 'h' });
      pressKey({ name: 'i', sequence: 'i' });
      pressKey({ name: 'delete' });
      pressKey({ name: 'return' });
      expect(onDispatch).toHaveBeenCalledWith('h');
    });
  });

  describe('peek-mode delete failure', () => {
    it('stays in peek mode when the deletion is rejected', () => {
      const props = makeProps({ onDelete: vi.fn(() => false) });
      const { lastFrame } = renderFleetView(props);

      pressKey({ name: 'space' });
      expect(lastFrame()!).toContain('space to close');

      pressKey({ name: 'x', ctrl: true });
      pressKey({ name: 'x', ctrl: true });

      expect(lastFrame()!).toContain('Cannot delete the active session');
      expect(lastFrame()!).toContain('space to close');
    });
  });

  describe('peek-mode delete success', () => {
    it('exits peek mode after successful deletion', () => {
      const props = makeProps({ onDelete: vi.fn(() => true) });
      const { lastFrame } = renderFleetView(props);

      pressKey({ name: 'space' });
      expect(lastFrame()!).toContain('space to close');

      pressKey({ name: 'x', ctrl: true });
      pressKey({ name: 'x', ctrl: true });

      expect(props.onDelete).toHaveBeenCalledWith('sess-1');
      expect(lastFrame()!).not.toContain('space to close');
      expect(lastFrame()!).toContain('Session deleted');
    });
  });
});
