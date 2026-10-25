/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Burst safety of the rewind restore-option cursor. The renderer hands every
 * key of one stdin read to the handler the previous render registered, so an
 * arrow auto-repeat followed by Enter used to restore whatever was highlighted
 * before the burst rather than what the arrows landed on.
 */

import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RawKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
  super?: boolean;
  shift?: boolean;
  paste?: boolean;
}

const mocks = vi.hoisted(() => {
  const state = {
    keyboardHandlers: [] as Array<(key: RawKey) => void>,
    width: 100,
  };
  async function buildJsxRuntime() {
    const React = await import('react');
    const jsx = (
      type: unknown,
      props: { children?: unknown } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'box' || type === 'text') {
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          key === undefined ? null : { key },
          children,
        );
      }
      return React.createElement(
        type as React.ElementType,
        config as Record<string, unknown>,
        children,
      );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }
  return { state, buildJsxRuntime };
});

vi.mock('@opentui/react', async () => {
  const React = await import('react');
  return {
    useKeyboard: (handler: (key: RawKey) => void) => {
      const latest = React.useRef(handler);
      latest.current = handler;
      const stable = React.useRef<((key: RawKey) => void) | undefined>(
        undefined,
      );
      if (!stable.current) {
        stable.current = (key: RawKey) => latest.current(key);
        mocks.state.keyboardHandlers.push(stable.current);
      }
    },
    useTerminalDimensions: () => ({ width: mocks.state.width, height: 40 }),
  };
});
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./key-map.js', () => ({
  toOriginalKey: (key: RawKey) => ({
    name: key.name ?? '',
    ctrl: !!key.ctrl,
    meta: !!(key.meta || key.option || key.super),
    shift: !!key.shift,
    paste: !!key.paste,
    sequence: key.sequence ?? '',
  }),
}));

import { OpentuiRewindSelector, type RewindTurn } from './session-rewind.js';

/** One stdin read: every key goes to the same handler closure, no render between. */
function burst(keys: RawKey[]) {
  if (mocks.state.keyboardHandlers.length === 0) {
    throw new Error('no keyboard handler registered');
  }
  act(() => {
    for (const key of keys) {
      for (const handler of [...mocks.state.keyboardHandlers]) {
        handler({ ...key });
      }
    }
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const TURNS: RewindTurn[] = [
  { id: 't1', text: 'First prompt', sentToModel: true },
  { id: 't2', text: 'Second prompt', sentToModel: true },
];

const DOWN = { name: 'down' } as RawKey;
const ENTER = { name: 'return', sequence: '\r' } as RawKey;

function renderSelector(onRewind = vi.fn()) {
  const onCancel = vi.fn();
  render(
    <OpentuiRewindSelector
      turns={TURNS}
      fileCheckpointingEnabled={true}
      getDiffStats={vi.fn().mockResolvedValue({
        filesChanged: ['a.ts'],
        insertions: 3,
        deletions: 1,
      })}
      onRewind={onRewind}
      onCancel={onCancel}
    />,
  );
  return { onRewind, onCancel };
}

/** The label on the row carrying ink's `›` cursor. */
function highlighted(): string {
  const rows = Array.from(document.querySelectorAll('span'))
    .map((el) => el.textContent ?? '')
    .filter((text) => text.startsWith('›'));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

beforeEach(() => {
  mocks.state.keyboardHandlers.length = 0;
  mocks.state.width = 100;
  document.body.innerHTML = '';
});

describe('OpentuiRewindSelector restore-option burst', () => {
  it('restores the option a burst of arrows landed on', async () => {
    const { onRewind } = renderSelector();
    burst([ENTER]);
    await flush();
    // both / conversation / code / cancel — the diff has a changed file.
    expect(screen.getByText('Restore code only')).toBeTruthy();
    expect(highlighted()).toMatch(/^› Restore code and conversation/);

    burst([DOWN, DOWN, ENTER]);
    expect(onRewind).toHaveBeenCalledTimes(1);
    expect(onRewind.mock.calls[0]![1]).toBe('code');
    expect(onRewind.mock.calls[0]![0]).toEqual(TURNS[1]);
  });

  it('re-syncs the cursor after a burst that clamped into "Never mind"', async () => {
    const { onRewind, onCancel } = renderSelector();
    burst([ENTER]);
    await flush();

    // Five downs over four options clamp onto the last one, which cancels.
    burst([DOWN, DOWN, DOWN, DOWN, DOWN, ENTER]);
    expect(onRewind).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText(/turns\)$/)).toBeTruthy();

    // Back on the pick list the reducer reset the cursor, and the handler's
    // own mirror has to follow it or the next burst starts from index 3.
    burst([ENTER]);
    await flush();
    expect(highlighted()).toMatch(/^› Restore code and conversation/);
    burst([DOWN, ENTER]);
    expect(onRewind).toHaveBeenCalledTimes(1);
    expect(onRewind.mock.calls[0]![1]).toBe('conversation');
  });

  it('ignores keys while the diff is still loading', async () => {
    const { onRewind } = renderSelector();
    burst([ENTER]);
    expect(screen.getByText('Computing file changes...')).toBeTruthy();
    burst([DOWN, ENTER]);
    expect(onRewind).not.toHaveBeenCalled();
    await flush();
    burst([ENTER]);
    expect(onRewind.mock.calls[0]![1]).toBe('both');
  });
});

describe('OpentuiRewindSelector region budget', () => {
  it('keeps the selected turn visible through a short region and resize before restoring it', () => {
    const turns = Array.from({ length: 12 }, (_, index) => ({
      id: `turn-${index + 1}`,
      text: `Prompt ${index + 1}`,
      sentToModel: true,
    }));
    const onRewind = vi.fn();
    const props = {
      turns,
      fileCheckpointingEnabled: false,
      onRewind,
      onCancel: vi.fn(),
    };
    const view = render(
      <OpentuiRewindSelector {...props} availableTerminalHeight={30} />,
    );
    expect(screen.getAllByText(/^Prompt \d+$/)).toHaveLength(7);
    view.rerender(
      <OpentuiRewindSelector {...props} availableTerminalHeight={7} />,
    );
    expect(screen.getAllByText(/^Prompt \d+$/)).toHaveLength(5);
    expect(screen.queryByText('Prompt 1')).toBeNull();
    expect(screen.getByText('Prompt 12').parentElement?.textContent).toContain(
      '› #12 ',
    );
    view.rerender(
      <OpentuiRewindSelector {...props} availableTerminalHeight={3} />,
    );
    burst([{ name: 'up' }, ENTER]);
    expect(onRewind).not.toHaveBeenCalled();
    expect(screen.queryByText('Rewind Conversation:')).toBeNull();
    expect(screen.getByText('Prompt 11').parentElement?.textContent).toContain(
      '› #11 ',
    );
    burst([ENTER]);
    expect(screen.getByText('Rewind Conversation:')).toBeTruthy();
    expect(screen.getByText('Prompt 11')).toBeTruthy();
    burst([ENTER]);
    expect(onRewind).toHaveBeenCalledExactlyOnceWith(turns[10], 'conversation');
  });

  it('does not commit a restore option that a key burst moves outside the painted window', async () => {
    const onRewind = vi.fn();
    render(
      <OpentuiRewindSelector
        turns={TURNS}
        fileCheckpointingEnabled
        onRewind={onRewind}
        onCancel={vi.fn()}
        availableTerminalHeight={3}
        getDiffStats={vi.fn().mockResolvedValue({
          filesChanged: ['a.ts'],
          insertions: 3,
          deletions: 1,
        })}
      />,
    );
    burst([ENTER]);
    await flush();
    expect(highlighted()).toMatch(/^› Restore code and conversation/);
    expect(screen.queryByText('Restore conversation only')).toBeNull();
    burst([DOWN, ENTER]);
    expect(onRewind).not.toHaveBeenCalled();
    expect(highlighted()).toBe('› Restore conversation only');
    burst([ENTER]);
    expect(onRewind).toHaveBeenCalledExactlyOnceWith(TURNS[1], 'conversation');
  });

  it('blocks invisible pick and confirm actions until the region can paint their target', () => {
    const onRewind = vi.fn();
    const props = {
      turns: TURNS,
      fileCheckpointingEnabled: false,
      onRewind,
      onCancel: vi.fn(),
    };
    const view = render(
      <OpentuiRewindSelector {...props} availableTerminalHeight={0} />,
    );
    burst([ENTER]);
    expect(screen.queryByText('Rewind Conversation:')).toBeNull();
    expect(onRewind).not.toHaveBeenCalled();
    view.rerender(
      <OpentuiRewindSelector {...props} availableTerminalHeight={3} />,
    );
    burst([ENTER]);
    expect(screen.getByText('Rewind Conversation:')).toBeTruthy();
    expect(screen.getByText('Second prompt')).toBeTruthy();
    view.rerender(
      <OpentuiRewindSelector {...props} availableTerminalHeight={0} />,
    );
    burst([ENTER]);
    expect(onRewind).not.toHaveBeenCalled();
    view.rerender(
      <OpentuiRewindSelector {...props} availableTerminalHeight={3} />,
    );
    burst([ENTER]);
    expect(onRewind).toHaveBeenCalledExactlyOnceWith(TURNS[1], 'conversation');
  });

  it('keeps a pending restore bounded through resize without admitting another action', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onRewind = vi.fn(() => pending);
    const onCancel = vi.fn();
    const getDiffStats = vi.fn().mockResolvedValue({
      filesChanged: ['a.ts'],
      insertions: 3,
      deletions: 1,
    });
    const props = {
      turns: TURNS,
      fileCheckpointingEnabled: true,
      onRewind,
      onCancel,
      getDiffStats,
    };
    const view = render(
      <OpentuiRewindSelector {...props} availableTerminalHeight={3} />,
    );
    burst([ENTER]);
    await flush();
    burst([ENTER]);
    expect(screen.getByText('Restoring...')).toBeTruthy();
    view.rerender(
      <OpentuiRewindSelector {...props} availableTerminalHeight={1} />,
    );
    expect(screen.getByText('Restoring...')).toBeTruthy();
    burst([DOWN, ENTER, { name: 'escape' }]);
    expect(onRewind).toHaveBeenCalledExactlyOnceWith(TURNS[1], 'both');
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => {
      finish();
      await pending;
    });
  });

  it.each([false, true])(
    'keeps phase-owned paint and keys when checkpointing changes from %s',
    async (enabled) => {
      const onRewind = vi.fn();
      const props = {
        turns: TURNS,
        onRewind,
        onCancel: vi.fn(),
        availableTerminalHeight: 3,
      };
      const view = render(
        <OpentuiRewindSelector {...props} fileCheckpointingEnabled={enabled} />,
      );
      burst([ENTER]);
      await flush();
      view.rerender(
        <OpentuiRewindSelector
          {...props}
          fileCheckpointingEnabled={!enabled}
        />,
      );
      if (enabled) {
        expect(highlighted()).toBe('› Restore conversation only');
        burst([{ sequence: 'y' }]);
        expect(onRewind).not.toHaveBeenCalled();
        burst([ENTER]);
      } else {
        expect(screen.getByText('Rewind Conversation:')).toBeTruthy();
        expect(screen.getByText('Second prompt')).toBeTruthy();
        burst([{ sequence: 'y' }]);
      }
      expect(onRewind).toHaveBeenCalledExactlyOnceWith(
        TURNS[1],
        'conversation',
      );
    },
  );

  it('does not confirm when a narrow compact row cannot show the action and target', () => {
    mocks.state.width = 80;
    const onRewind = vi.fn();
    const props = {
      turns: TURNS,
      fileCheckpointingEnabled: false,
      availableTerminalHeight: 3,
      onRewind,
      onCancel: vi.fn(),
    };
    const view = render(<OpentuiRewindSelector {...props} />);
    burst([ENTER]);
    expect(screen.getByText('Rewind Conversation:')).toBeTruthy();
    expect(screen.getByText('Second prompt')).toBeTruthy();
    mocks.state.width = 12;
    view.rerender(<OpentuiRewindSelector {...props} />);
    expect(screen.queryByText('Second prompt')).toBeNull();
    burst([ENTER, { sequence: 'y' }]);
    expect(onRewind).not.toHaveBeenCalled();
  });

  it('keeps the same pick and restore option uncommitted while resize removes their labels', async () => {
    mocks.state.width = 80;
    const onRewind = vi.fn();
    const getDiffStats = vi.fn().mockResolvedValue(undefined);
    const props = {
      turns: TURNS,
      fileCheckpointingEnabled: true,
      onRewind,
      getDiffStats,
      onCancel: vi.fn(),
      availableTerminalHeight: 3,
    };
    const view = render(<OpentuiRewindSelector {...props} />);
    expect(screen.getByText('Second prompt')).toBeTruthy();
    mocks.state.width = 10;
    view.rerender(<OpentuiRewindSelector {...props} />);
    burst([ENTER]);
    expect(getDiffStats).not.toHaveBeenCalled();
    expect(onRewind).not.toHaveBeenCalled();
    mocks.state.width = 80;
    view.rerender(<OpentuiRewindSelector {...props} />);
    expect(screen.getByText('Second prompt')).toBeTruthy();
    burst([ENTER]);
    await flush();
    expect(highlighted()).toBe('› Restore conversation only');
    for (const width of [10, 11]) {
      mocks.state.width = width;
      view.rerender(<OpentuiRewindSelector {...props} />);
      burst([ENTER]);
      expect(onRewind).not.toHaveBeenCalled();
    }
    mocks.state.width = 80;
    view.rerender(<OpentuiRewindSelector {...props} />);
    expect(highlighted()).toBe('› Restore conversation only');
    burst([ENTER]);
    expect(onRewind).toHaveBeenCalledExactlyOnceWith(TURNS[1], 'conversation');
  });

  it.each(['...', '…'])(
    'allows a real %s prompt through pick and confirmation at normal width',
    (text) => {
      mocks.state.width = 80;
      const turn = { id: 'literal-ellipsis', text, sentToModel: true };
      const onRewind = vi.fn();
      render(
        <OpentuiRewindSelector
          turns={[turn]}
          fileCheckpointingEnabled={false}
          availableTerminalHeight={30}
          onRewind={onRewind}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText(text)).toBeTruthy();
      burst([ENTER]);
      expect(screen.getByText('Rewind to:')).toBeTruthy();
      expect(screen.getByText(text)).toBeTruthy();
      burst([ENTER]);
      expect(onRewind).toHaveBeenCalledExactlyOnceWith(turn, 'conversation');
    },
  );
});
