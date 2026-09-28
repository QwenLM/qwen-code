/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session picker parity (ink `SessionPicker`, shared by /resume and /delete):
 * the two-line row, the checkbox column and its commit set, the disabled live
 * session, the implicit-search entry, and the visible-item window. The port
 * used to render one hand-rolled line per session with no checkboxes at all,
 * so /delete could only ever remove the row under the cursor.
 */

import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionListItem } from '@qwen-code/qwen-code-core/services/sessionService.js';

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
    height: 40,
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
    useTerminalDimensions: () => ({
      width: mocks.state.width,
      height: mocks.state.height,
    }),
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

import { OpenTuiSessionPicker } from './session-picker.js';

function press(key: RawKey) {
  if (mocks.state.keyboardHandlers.length === 0) {
    throw new Error('no keyboard handler registered');
  }
  act(() => {
    for (const handler of [...mocks.state.keyboardHandlers]) {
      handler({ ...key });
    }
  });
}

function typeChar(char: string) {
  press({ name: char, sequence: char });
}

/**
 * Every key of one stdin read, against the handler one render registered: no
 * re-render lands between them, which is what a held arrow or a paste produces.
 */
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

const NOW = Date.now();

function session(index: number, overrides: Partial<SessionListItem> = {}) {
  return {
    sessionId: `id-${String(index).padStart(2, '0')}`,
    mtime: NOW - 30_000,
    messageCount: 3,
    gitBranch: 'main',
    prompt: `Session ${String(index).padStart(2, '0')}`,
    ...overrides,
  } as SessionListItem;
}

function renderPicker(
  sessions: SessionListItem[],
  props: Partial<Parameters<typeof OpenTuiSessionPicker>[0]> = {},
) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const onConfirmMulti = vi.fn();
  render(
    <OpenTuiSessionPicker
      // A null service renders ink's loading notice, so the list needs one.
      sessionService={{ listSessions: vi.fn() } as never}
      initialSessions={sessions}
      onSelect={onSelect}
      onCancel={onCancel}
      onConfirmMulti={onConfirmMulti}
      {...props}
    />,
  );
  return { onSelect, onCancel, onConfirmMulti };
}

/** The marker/checkbox line and the dim metadata line of one session row. */
function lines(prompt: string): { row: string; meta: string } {
  const titleSpan = screen.getByText(prompt);
  const rowLine = titleSpan.parentElement?.parentElement as HTMLElement;
  const column = rowLine.parentElement as HTMLElement;
  return {
    row: rowLine.textContent ?? '',
    meta: (column.children[1] as HTMLElement).textContent ?? '',
  };
}

const ROW_TITLE = /^(Session \d\d|Unrelated work)$/;

/** The titles of the rendered rows, in order — i.e. what survived the filter. */
function titles(): string[] {
  return screen.getAllByText(ROW_TITLE).map((el) => el.textContent ?? '');
}

/** A loaded session, shaped the way `sessionService.loadSession` resolves. */
function loadedSession(
  messages: Array<{ type: 'user' | 'assistant'; uuid: string; text: string }>,
) {
  return {
    conversation: {
      messages: messages.map(({ type, uuid, text }) => ({
        uuid,
        type,
        message: {
          role: type === 'user' ? 'user' : 'model',
          parts: [{ text }],
        },
      })),
    },
  } as never;
}

function serviceWith(loadSession: unknown) {
  return { listSessions: vi.fn(), loadSession } as never;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const ROW_META = 'just now · 3 messages · main';

beforeEach(() => {
  mocks.state.keyboardHandlers.length = 0;
  mocks.state.width = 100;
  mocks.state.height = 40;
});

describe('OpenTuiSessionPicker', () => {
  it('draws ink’s two-line row: marker plus title, then the metadata line', () => {
    renderPicker([session(1, { prompt: 'Fix the flaky test' }), session(2)]);
    expect(lines('Fix the flaky test').row).toBe('› Fix the flaky test');
    expect(lines('Fix the flaky test').meta).toBe(ROW_META);
    expect(lines('Session 02').row).toBe('  Session 02');
  });

  it('omits the message segment when the count is unknown', () => {
    renderPicker([
      session(1, { messageCount: undefined, gitBranch: undefined }),
    ]);
    expect(lines('Session 01').meta).toBe('just now');
  });

  it('adds a checkbox column and commits the checked set, not the cursor row', () => {
    const { onSelect, onConfirmMulti } = renderPicker(
      [session(1), session(2), session(3)],
      { enableMultiSelect: true },
    );
    expect(lines('Session 01').row).toBe('› [ ] Session 01');
    expect(screen.getByText(/^Space to select multiple/)).toBeTruthy();

    press({ name: 'space', sequence: ' ' });
    press({ name: 'down' });
    press({ name: 'space', sequence: ' ' });
    // Space toggles in place; only ↓ moves the cursor.
    expect(lines('Session 01').row).toBe('  [x] Session 01');
    expect(lines('Session 02').row).toBe('› [x] Session 02');
    expect(screen.getByText(/^Space to toggle · 2 selected/)).toBeTruthy();

    press({ name: 'return' });
    expect(onConfirmMulti).toHaveBeenCalledWith(['id-01', 'id-02']);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps the disabled live session uncheckable and uncommittable', () => {
    const { onSelect, onConfirmMulti } = renderPicker(
      [session(1), session(2)],
      { enableMultiSelect: true, disabledIds: ['id-01'] },
    );
    expect(lines('Session 01').meta).toBe(
      'just now · 3 messages · main · current — cannot delete',
    );

    press({ name: 'space', sequence: ' ' });
    expect(lines('Session 01').row).toBe('› [ ] Session 01');
    press({ name: 'return' });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onConfirmMulti).not.toHaveBeenCalled();
  });

  it('commits checks that the current filter hides', () => {
    const { onConfirmMulti } = renderPicker(
      [session(1), session(2, { prompt: 'Unrelated work' })],
      { enableMultiSelect: true },
    );
    press({ name: 'space', sequence: ' ' });
    typeChar('U');
    expect(titles()).toEqual(['Unrelated work']);
    // The first Enter commits the query and returns to the list; only the
    // second one acts on the checked set.
    press({ name: 'return' });
    expect(onConfirmMulti).not.toHaveBeenCalled();
    press({ name: 'return' });
    // Search is a navigation aid: the commit set stays what was checked.
    expect(onConfirmMulti).toHaveBeenCalledWith(['id-01']);
  });

  it('enters search on a typed letter and drops the query on Esc', () => {
    renderPicker([session(1), session(2, { prompt: 'Unrelated work' })]);
    expect(screen.getByText('Press / to search')).toBeTruthy();

    typeChar('U');
    expect(
      (screen.getByText('Search:').parentElement as HTMLElement).textContent,
    ).toBe('Search: U▌');
    expect(screen.getByText('(1 matches)')).toBeTruthy();
    expect(titles()).toEqual(['Unrelated work']);
    // ink suppresses the cursor highlight while the query is being edited.
    expect(lines('Unrelated work').row).toBe('  Unrelated work');

    press({ name: 'escape' });
    expect(screen.getByText('Press / to search')).toBeTruthy();
    expect(titles()).toEqual(['Session 01', 'Unrelated work']);
  });

  it('swallows a space in list mode instead of seeding a whitespace query', () => {
    renderPicker([session(1), session(2, { prompt: 'Unrelated work' })]);

    // A space can reach the handler with no `name` at all, so the space branch
    // has to match on the sequence too: it is the only thing standing between a
    // stray space and a leading-whitespace query. ink drops it the same way.
    press({ sequence: ' ' });
    expect(screen.getByText('Press / to search')).toBeTruthy();
    expect(screen.queryByText('Search:')).toBeNull();
    expect(titles()).toEqual(['Session 01', 'Unrelated work']);
  });

  it('cancels from list mode but only clears the query from search mode', () => {
    const { onCancel } = renderPicker([session(1)]);
    press({ name: 'escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('windows the list and marks the scroll direction on the edge rows', () => {
    // 40 rows -> floor((40 - 7) / 3) = 11 visible items.
    const sessions = Array.from({ length: 14 }, (_, i) => session(i + 1));
    renderPicker(sessions);
    const visible = screen.getAllByText(/^Session \d\d$/);
    expect(visible).toHaveLength(11);
    expect(lines('Session 01').row).toBe('› Session 01');
    expect(lines('Session 11').row).toBe('↓ Session 11');
  });

  it('loads the first page and pulls the next one when the sentinel shows', async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce({
        items: [session(1), session(2), session(3)],
        hasMore: true,
        nextCursor: 3,
      })
      .mockResolvedValueOnce({
        items: [session(4), session(5)],
        hasMore: false,
        nextCursor: undefined,
      });
    renderPicker([], {
      initialSessions: undefined,
      sessionService: { listSessions } as never,
    });
    expect(screen.getByText('Loading sessions...')).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listSessions).toHaveBeenNthCalledWith(1, { size: 20 });
    expect(listSessions).toHaveBeenNthCalledWith(2, { size: 20, cursor: 3 });
    expect(titles()).toHaveLength(5);
  });

  it('selects the highlighted row on Enter when nothing is checked', () => {
    const { onSelect } = renderPicker([session(1), session(2)]);
    press({ name: 'down' });
    expect(lines('Session 02').row).toBe('› Session 02');
    press({ name: 'return' });
    expect(onSelect).toHaveBeenCalledWith('id-02');
  });

  it('filters by branch on Ctrl+B and says so in the header', () => {
    renderPicker([session(1), session(2, { gitBranch: 'feature' })], {
      currentBranch: 'feature',
    });
    press({ name: 'b', sequence: 'b', ctrl: true });
    expect(screen.getByText('(branch: feature)')).toBeTruthy();
    expect(titles()).toEqual(['Session 02']);
  });
});

describe('OpenTuiSessionPicker Space-to-preview', () => {
  it('swaps the list for the loaded transcript and resumes it on Enter', async () => {
    const loadSession = vi.fn().mockResolvedValue(
      loadedSession([
        { type: 'user', uuid: 'u1', text: 'Previewed prompt' },
        { type: 'assistant', uuid: 'a1', text: 'Previewed answer' },
      ]),
    );
    const { onSelect, onCancel } = renderPicker([session(1), session(2)], {
      enablePreview: true,
      sessionService: serviceWith(loadSession),
    });
    expect(screen.getByText(/^Space to preview/)).toBeTruthy();

    press({ name: 'down' });
    press({ name: 'space', sequence: ' ' });
    expect(screen.getByText('Loading session preview...')).toBeTruthy();
    expect(screen.getByText('Enter to resume · Esc to back')).toBeTruthy();

    await flush();
    expect(loadSession).toHaveBeenCalledWith('id-02');
    // ink's preview is its own tree: the title comes off the session entry, the
    // meta line counts messages first (unlike the row, which leads with time),
    // and the list rows are gone.
    expect(screen.getByText('Session 02')).toBeTruthy();
    expect(screen.getByText('3 messages · just now · main')).toBeTruthy();
    expect(screen.queryAllByText(ROW_META)).toHaveLength(0);
    expect(screen.getByText('Previewed prompt')).toBeTruthy();

    press({ name: 'return' });
    expect(onSelect).toHaveBeenCalledWith('id-02');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('comes back to the list on Esc with the cursor and the query untouched', async () => {
    const { onCancel } = renderPicker(
      [
        session(1, { prompt: 'Alpha work' }),
        session(2, { prompt: 'Beta work' }),
        session(3, { prompt: 'Gamma work' }),
      ],
      {
        enablePreview: true,
        sessionService: serviceWith(
          vi.fn().mockResolvedValue(loadedSession([])),
        ),
      },
    );
    typeChar('a');
    press({ name: 'return' });
    press({ name: 'down' });
    expect(lines('Beta work').row).toBe('› Beta work');

    press({ name: 'space', sequence: ' ' });
    await flush();
    press({ name: 'escape' });

    expect(onCancel).not.toHaveBeenCalled();
    expect(
      (screen.getByText('Filter:').parentElement as HTMLElement).textContent,
    ).toBe('Filter: a');
    expect(lines('Beta work').row).toBe('› Beta work');
    expect(screen.getByText(/^Space to preview/)).toBeTruthy();
  });

  it('gives the preview the whole keyboard, and ctrl+c backs out instead of cancelling', async () => {
    const { onCancel } = renderPicker([session(1), session(2)], {
      enablePreview: true,
      sessionService: serviceWith(vi.fn().mockResolvedValue(loadedSession([]))),
    });
    press({ name: 'space', sequence: ' ' });
    await flush();

    press({ name: 'down' });
    press({ name: 'j' });
    typeChar('z');
    expect(screen.getByText('Enter to resume · Esc to back')).toBeTruthy();

    press({ name: 'c', sequence: 'c', ctrl: true });
    expect(onCancel).not.toHaveBeenCalled();
    // Neither the cursor nor the query moved while the preview was up.
    expect(lines('Session 01').row).toBe('› Session 01');
    expect(screen.getByText('Press / to search')).toBeTruthy();
  });

  it('renders ink’s not-found wording instead of a blank body', async () => {
    renderPicker([session(1)], {
      enablePreview: true,
      sessionService: serviceWith(vi.fn().mockResolvedValue(undefined)),
    });
    press({ name: 'space', sequence: ' ' });
    await flush();
    expect(screen.getByText('Session not found')).toBeTruthy();
    expect(screen.getByText('Enter to resume · Esc to back')).toBeTruthy();
  });

  it('renders a thrown load failure', async () => {
    renderPicker([session(1)], {
      enablePreview: true,
      sessionService: serviceWith(
        vi.fn().mockRejectedValue(new Error('JSONL is corrupt')),
      ),
    });
    press({ name: 'space', sequence: ' ' });
    await flush();
    expect(screen.getByText('JSONL is corrupt')).toBeTruthy();
  });

  it('counts unique user/assistant uuids when the list entry has no count', async () => {
    renderPicker([session(1, { messageCount: undefined })], {
      enablePreview: true,
      sessionService: serviceWith(
        vi.fn().mockResolvedValue(
          loadedSession([
            { type: 'user', uuid: 'u1', text: 'First' },
            { type: 'assistant', uuid: 'a1', text: 'Answer' },
            { type: 'user', uuid: 'u1', text: 'First' },
            { type: 'assistant', uuid: 'a2', text: 'Second answer' },
          ]),
        ),
      ),
    });
    press({ name: 'space', sequence: ' ' });
    await flush();
    expect(screen.getByText('3 messages · just now · main')).toBeTruthy();
  });

  it('leaves Space to the checkboxes and the hint off in multi-select', () => {
    renderPicker([session(1), session(2)], {
      enableMultiSelect: true,
      enablePreview: true,
    });
    expect(screen.queryByText(/Space to preview/)).toBeNull();

    press({ name: 'space', sequence: ' ' });
    expect(lines('Session 01').row).toBe('› [x] Session 01');
    expect(screen.queryByText('Enter to resume · Esc to back')).toBeNull();
  });

  it('advertises nothing to a flow that did not opt in', () => {
    renderPicker([session(1)]);
    expect(screen.queryByText(/Space to preview/)).toBeNull();

    press({ name: 'space', sequence: ' ' });
    expect(screen.queryByText('Loading session preview...')).toBeNull();
    expect(screen.queryByText('Enter to resume · Esc to back')).toBeNull();
    expect(screen.queryAllByText(ROW_META)).toHaveLength(1);
  });

  it('ignores a preview load that resolves after the user moved on', async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const loadSession = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    renderPicker(
      [
        session(1, { prompt: 'Alpha work' }),
        session(2, { prompt: 'Beta work' }),
      ],
      { enablePreview: true, sessionService: serviceWith(loadSession) },
    );

    press({ name: 'space', sequence: ' ' });
    // Leave before it resolves, then preview the other session.
    press({ name: 'escape' });
    press({ name: 'down' });
    press({ name: 'space', sequence: ' ' });
    await act(async () => {
      resolvers[1](
        loadedSession([{ type: 'user', uuid: 'b1', text: 'Beta transcript' }]),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText('Beta transcript')).toBeTruthy();

    await act(async () => {
      resolvers[0](
        loadedSession([{ type: 'user', uuid: 'a1', text: 'Alpha transcript' }]),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText('Alpha transcript')).toBeNull();
    expect(screen.getByText('Beta transcript')).toBeTruthy();
  });
});

describe('OpenTuiSessionPicker under one stdin read', () => {
  const DOWN = { name: 'down', sequence: '\x1b[B' };
  const UP = { name: 'up', sequence: '\x1b[A' };
  const SPACE = { name: 'space', sequence: ' ' };
  const RETURN = { name: 'return', sequence: '\r' };

  it('resumes the row the arrows of the same read reached', () => {
    const { onSelect } = renderPicker([session(1), session(2), session(3)]);

    // Read from the render that armed the handler, Enter would resume the row
    // that was highlighted before the arrows moved.
    burst([DOWN, DOWN, RETURN]);

    expect(onSelect).toHaveBeenCalledWith('id-03');
  });

  it('commits the checks the same read made', () => {
    const { onSelect, onConfirmMulti } = renderPicker(
      [session(1), session(2), session(3)],
      { enableMultiSelect: true },
    );

    // Read from the render that armed the handler, the checked set is still
    // empty at Enter, so the burst would fall through to the single-row path.
    burst([SPACE, DOWN, SPACE, RETURN]);

    expect(onConfirmMulti).toHaveBeenCalledWith(['id-01', 'id-02']);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps editing the query an arrow of the same read focused', () => {
    const { onSelect } = renderPicker([session(1), session(2)]);

    // ↑ off the first row focuses the query. Read from the render that armed
    // the handler, Enter still sees the list and resumes a row instead.
    burst([UP, RETURN]);

    expect(onSelect).not.toHaveBeenCalled();
    // Enter handed the keyboard back to the list, which is where the burst
    // ends either way — the row it did not resume is the point.
    expect(screen.getByText('Press / to search')).toBeTruthy();
  });

  it('gives the preview a key of the same read opened', () => {
    const { onSelect } = renderPicker([session(1), session(2)], {
      enablePreview: true,
      sessionService: serviceWith(vi.fn().mockResolvedValue(loadedSession([]))),
    });

    // Space puts the preview up and the preview owns the keyboard, so the ↓ is
    // dropped. Read from the render that armed the handler, the preview is not
    // up yet, the ↓ moves the cursor and Enter resumes the other session.
    burst([SPACE, DOWN, RETURN]);

    expect(onSelect).toHaveBeenCalledWith('id-01');
  });
});
