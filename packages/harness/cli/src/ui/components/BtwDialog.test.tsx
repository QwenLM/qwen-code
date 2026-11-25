/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  QueryEvent,
  SideQuestionParams,
  SideQuestionResult,
} from '@qwen-code/core';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { copyToClipboard } from '../utils/commandUtils.js';
import { BtwHistoryStore } from '../state/btwHistoryStore.js';
import { BtwDialog } from './BtwDialog.js';

const terminalSize = vi.hoisted(() => ({ columns: 100, rows: 1000 }));
vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ ...terminalSize }),
}));

vi.mock('../utils/commandUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/commandUtils.js')>()),
  copyToClipboard: vi.fn(async () => {}),
}));

interface PendingCall {
  params: SideQuestionParams;
  resolve: (result: SideQuestionResult) => void;
  reject: (error: unknown) => void;
}

const ESCAPE = '\x1b';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const SHIFT_LEFT = '\x1b[1;2D';
const SHIFT_RIGHT = '\x1b[1;2C';
const TAB = '\t';
const SHIFT_TAB = '\x1b[Z';
const BROWSE_HINT = '⇧←/→ browse';
const SCROLL_HINT = '↑↓ scroll';

/** Forty two-row paragraphs: overflows a 20-row terminal's answer body. */
function longText(prefix: string): string {
  return Array.from(
    { length: 40 },
    (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`,
  ).join('\n\n');
}

function createStore() {
  const calls: PendingCall[] = [];
  const store = new BtwHistoryStore(
    (params) =>
      new Promise<SideQuestionResult>((resolve, reject) => {
        calls.push({ params, resolve, reject });
      }),
  );
  return { store, calls };
}

function result(textContent: string, synthetic = false): SideQuestionResult {
  return {
    textContent,
    synthetic,
    totalUsage: {} as SideQuestionResult['totalUsage'],
  };
}

function textDelta(text: string): QueryEvent {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
  };
}

async function answered(
  store: BtwHistoryStore,
  calls: PendingCall[],
  question: string,
  answer: string,
): Promise<string> {
  const id = store.ask(question, {
    sessionId: 'btw-test-session',
    config: {} as SideQuestionParams['config'],
  });
  await act(async () => {
    calls.at(-1)?.resolve(result(answer));
  });
  return id;
}

describe('BtwDialog', () => {
  it('shows text that streamed before it mounted, then the answer', async () => {
    const { store, calls } = createStore();
    const id = store.ask('Where is the cache?', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    calls[0].params.onEvent?.(textDelta('Partly streamed'));

    const { lastFrame, unmount } = await renderWithProviders(
      <BtwDialog requestId={id} onClose={vi.fn()} store={store} />,
    );
    expect(lastFrame()).toContain('Where is the cache?');
    expect(lastFrame()).toContain('Partly streamed');

    await act(async () => {
      calls[0].resolve(result('In memory, per session.'));
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('In memory, per session.');
    });
    unmount();
  });

  it('cancels a running question on Esc', async () => {
    const { store, calls } = createStore();
    const id = store.ask('q', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    const onClose = vi.fn();

    const { stdin, unmount } = await renderWithProviders(
      <BtwDialog requestId={id} onClose={onClose} store={store} />,
    );
    act(() => {
      stdin.write(ESCAPE);
    });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(calls[0].params.signal?.aborted).toBe(true);
    unmount();
  });

  it('keeps the question running when the panel is replaced', async () => {
    const { store, calls } = createStore();
    const id = store.ask('q', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });

    const { unmount } = await renderWithProviders(
      <BtwDialog requestId={id} onClose={vi.fn()} store={store} />,
    );
    unmount();
    await act(async () => {
      calls[0].resolve(result('answer'));
    });

    expect(calls[0].params.signal?.aborted).toBe(false);
    expect(store.getSnapshot().exchanges).toEqual([
      { id, question: 'q', response: 'answer' },
    ]);
  });

  it('browses earlier answers with Shift+←/→, ignores bare arrows, and clears them with x', async () => {
    const { store, calls } = createStore();
    await answered(store, calls, 'first question', 'answer one');
    await answered(store, calls, 'second question', 'answer two');
    const current = await answered(store, calls, 'current', 'answer now');

    const { lastFrame, stdin, unmount, waitUntilReady } =
      await renderWithProviders(
        <BtwDialog requestId={current} onClose={vi.fn()} store={store} />,
      );
    expect(lastFrame()).toContain('/btw first question');
    expect(lastFrame()).toContain('answer now');
    expect(lastFrame()).toContain(BROWSE_HINT);

    await act(async () => {
      stdin.write(LEFT);
    });
    await act(async () => {
      stdin.write(RIGHT);
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('answer now');
    expect(lastFrame()).not.toContain('answer two');

    act(() => {
      stdin.write(SHIFT_LEFT);
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('answer two');
    });

    act(() => {
      stdin.write(SHIFT_RIGHT);
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('answer now');
    });
    expect(lastFrame()).not.toContain('answer two');

    act(() => {
      stdin.write('x');
    });
    await waitFor(() => {
      expect(lastFrame()).not.toContain('first question');
    });
    expect(store.getSnapshot().exchanges.map((entry) => entry.id)).toEqual([
      current,
    ]);
    unmount();
  });

  it('browses with [ and ], stopping at either end', async () => {
    const { store, calls } = createStore();
    await answered(store, calls, 'first question', 'answer one');
    await answered(store, calls, 'second question', 'answer two');
    const current = await answered(store, calls, 'current', 'answer now');

    const { lastFrame, stdin, unmount, waitUntilReady } =
      await renderWithProviders(
        <BtwDialog requestId={current} onClose={vi.fn()} store={store} />,
      );

    act(() => {
      stdin.write('[');
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('answer two');
    });
    act(() => {
      stdin.write('[');
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('answer one');
    });
    await act(async () => {
      stdin.write('[');
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('answer one');

    act(() => {
      stdin.write(']');
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('answer two');
    });
    act(() => {
      stdin.write(']');
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('answer now');
    });
    await act(async () => {
      stdin.write(']');
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('answer now');
    unmount();
  });

  it('cycles through history with Tab and Shift+Tab, wrapping to the current answer', async () => {
    const { store, calls } = createStore();
    await answered(store, calls, 'first question', 'answer one');
    await answered(store, calls, 'second question', 'answer two');
    const current = await answered(store, calls, 'current', 'answer now');

    const { lastFrame, stdin, unmount } = await renderWithProviders(
      <BtwDialog requestId={current} onClose={vi.fn()} store={store} />,
    );

    const press = async (sequence: string, expected: string) => {
      act(() => {
        stdin.write(sequence);
      });
      await waitFor(() => {
        const frame = lastFrame();
        for (const answer of ['answer one', 'answer two', 'answer now']) {
          if (answer === expected) expect(frame).toContain(answer);
          else expect(frame).not.toContain(answer);
        }
      });
    };

    await press(TAB, 'answer two');
    await press(TAB, 'answer one');
    await press(TAB, 'answer now');
    await press(SHIFT_TAB, 'answer one');
    await press(SHIFT_TAB, 'answer two');
    await press(SHIFT_TAB, 'answer now');
    unmount();
  });

  it('keeps Tab and Shift+Tab inside the panel when there is no history', async () => {
    const { store, calls } = createStore();
    const id = await answered(store, calls, 'q', 'only answer');

    const { lastFrame, stdin, unmount, waitUntilReady, capturedRegistry } =
      await renderWithProviders(
        <BtwDialog requestId={id} onClose={vi.fn()} store={store} />,
      );
    const cyclePermissionMode = vi.fn(() => true);
    capturedRegistry!.registerHandler(
      'Global',
      'app:cyclePermissionMode',
      cyclePermissionMode,
    );

    await act(async () => {
      stdin.write(SHIFT_TAB);
    });
    await act(async () => {
      stdin.write(TAB);
    });
    await act(async () => {
      stdin.write(SHIFT_LEFT);
    });
    await waitUntilReady();

    expect(cyclePermissionMode).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('only answer');
    expect(lastFrame()).not.toContain(BROWSE_HINT);
    unmount();
  });

  it('copies the displayed answer with c', async () => {
    const { store, calls } = createStore();
    const id = await answered(store, calls, 'q', 'copy me');

    const { stdin, lastFrame, unmount } = await renderWithProviders(
      <BtwDialog requestId={id} onClose={vi.fn()} store={store} />,
    );
    act(() => {
      stdin.write('c');
    });

    await waitFor(() => {
      expect(copyToClipboard).toHaveBeenCalledWith(
        'copy me',
        expect.anything(),
      );
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('Copied to clipboard');
    });
    unmount();
  });

  it('shows retry status while waiting', async () => {
    const { store, calls } = createStore();
    const id = store.ask('q', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    calls[0].params.onEvent?.({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 5_000,
      error_status: 429,
    } as unknown as QueryEvent);

    const { lastFrame, unmount } = await renderWithProviders(
      <BtwDialog requestId={id} onClose={vi.fn()} store={store} />,
    );

    expect(lastFrame()).toContain('Rate limited');
    expect(lastFrame()).toContain('attempt 2/5');
    unmount();
  });

  it('closes itself when the session resets', async () => {
    const { store } = createStore();
    const id = store.ask('q', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    const onClose = vi.fn();

    const { unmount } = await renderWithProviders(
      <BtwDialog requestId={id} onClose={onClose} store={store} />,
    );
    act(() => {
      store.reset();
    });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    unmount();
  });
  it('scrolls a long answer with ↑↓', async () => {
    const { store, calls } = createStore();
    const answer = Array.from(
      { length: 40 },
      (_, i) => `line-${String(i + 1).padStart(2, '0')}`,
    ).join('\n\n');
    const id = await answered(store, calls, 'long?', answer);

    // 20 rows: 11 chrome rows leave a 9-row answer body.
    terminalSize.rows = 20;
    try {
      const { lastFrame, stdin, unmount, waitUntilReady, settleLayout } =
        await renderWithProviders(
          <BtwDialog requestId={id} onClose={vi.fn()} store={store} />,
        );
      await waitFor(() => {
        expect(lastFrame()).toContain('line-01');
      });
      expect(lastFrame()).not.toContain('line-06');
      // The answer body is measured by ResizeObservers; see settleLayout.
      await settleLayout();
      await waitFor(() => {
        expect(lastFrame()).toContain(SCROLL_HINT);
      });

      await act(async () => {
        stdin.write(DOWN);
      });
      await waitUntilReady();
      // 3 rows down: the paragraphs are two rows each, so line-03 leads.
      await waitFor(() => {
        expect(lastFrame()).not.toContain('line-01');
        expect(lastFrame()).not.toContain('line-02');
        expect(lastFrame()).toContain('line-03');
        expect(lastFrame()).toContain('line-06');
      });

      await act(async () => {
        stdin.write(UP);
      });
      await waitUntilReady();
      await waitFor(() => {
        expect(lastFrame()).toContain('line-01');
        expect(lastFrame()).not.toContain('line-06');
      });
      unmount();
    } finally {
      terminalSize.rows = 1000;
    }
  });

  it('hides the scroll hint while waiting and for a short answer', async () => {
    const { store, calls } = createStore();
    const id = store.ask('q', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });

    const { lastFrame, unmount, waitUntilReady, settleLayout } =
      await renderWithProviders(
        <BtwDialog requestId={id} onClose={vi.fn()} store={store} />,
      );
    await settleLayout();
    await waitUntilReady();
    expect(lastFrame()).toContain('Answering');
    expect(lastFrame()).not.toContain(SCROLL_HINT);

    await act(async () => {
      calls[0].resolve(result('A short answer.'));
    });
    await settleLayout();
    await waitUntilReady();
    expect(lastFrame()).toContain('A short answer.');
    expect(lastFrame()).not.toContain(SCROLL_HINT);
    unmount();
  });

  it('shows the scroll hint for a long error', async () => {
    const { store, calls } = createStore();
    const id = store.ask('q', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    await act(async () => {
      calls[0].reject(new Error(longText('error-line')));
    });

    terminalSize.rows = 20;
    try {
      const { lastFrame, unmount, settleLayout } = await renderWithProviders(
        <BtwDialog requestId={id} onClose={vi.fn()} store={store} />,
      );
      await waitFor(() => {
        expect(lastFrame()).toContain('error-line-01');
      });
      await settleLayout();
      await waitFor(() => {
        expect(lastFrame()).toContain(SCROLL_HINT);
      });
      unmount();
    } finally {
      terminalSize.rows = 1000;
    }
  });

  it('shows the browse and scroll hints together', async () => {
    const { store, calls } = createStore();
    await answered(store, calls, 'earlier', 'short earlier answer');
    const id = await answered(store, calls, 'long?', longText('line'));

    terminalSize.rows = 20;
    try {
      const { lastFrame, unmount, settleLayout } = await renderWithProviders(
        <BtwDialog requestId={id} onClose={vi.fn()} store={store} />,
      );
      await waitFor(() => {
        expect(lastFrame()).toContain('line-01');
      });
      await settleLayout();
      await waitFor(() => {
        expect(lastFrame()).toContain(BROWSE_HINT);
        expect(lastFrame()).toContain(SCROLL_HINT);
      });
      unmount();
    } finally {
      terminalSize.rows = 1000;
    }
  });
});
