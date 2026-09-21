// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import {
  useTrajectoryWindow,
  type TrajectoryPageLoader,
  type TrajectoryPageResult,
  type TrajectoryWindow,
} from './useTrajectoryWindow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function userText(text: string, recordId: string): DaemonEvent {
  return {
    v: 1,
    type: 'session_update',
    data: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
      _meta: {
        qwenTranscript: {
          sourceRecordIds: [recordId],
          segmentId: `${recordId}:0`,
        },
        'qwen.session.recordId': recordId,
      },
    },
  } as unknown as DaemonEvent;
}

function requestFrame(recordId: string, durationMs: number): DaemonEvent {
  return {
    v: 1,
    type: 'session_update',
    data: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: {
        timing: { kind: 'request', durationMs, status: 'ok' },
        'qwen.session.recordId': recordId,
      },
    },
  } as unknown as DaemonEvent;
}

function page(
  events: readonly DaemonEvent[],
  extra: Partial<TrajectoryPageResult> = {},
): TrajectoryPageResult {
  return { events, hasMore: false, ...extra };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(
  loadPage: TrajectoryPageLoader | undefined,
  options?: { pageSize?: number; maxPages?: number },
): {
  latest: () => TrajectoryWindow;
  rerender: (next: TrajectoryPageLoader | undefined) => void;
} {
  let latest: TrajectoryWindow | undefined;
  function Probe({ loader }: { loader: TrajectoryPageLoader | undefined }) {
    latest = useTrajectoryWindow(loader, options);
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Probe loader={loadPage} />);
  });
  return {
    latest: () => latest!,
    rerender: (next) => {
      act(() => {
        root!.render(<Probe loader={next} />);
      });
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe('useTrajectoryWindow', () => {
  it('asks for nothing without a loader', async () => {
    const view = render(undefined);
    await act(async () => {});

    expect(view.latest().status).toBe('idle');
    expect(view.latest().trajectory).toBeUndefined();
  });

  it('folds the newest page on mount', async () => {
    const loadPage = vi.fn(async () =>
      page([userText('go', 'rec-1'), requestFrame('rec-2', 1200)]),
    );
    const view = render(loadPage);
    await act(async () => {});

    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loadPage.mock.calls[0]![0]).toEqual({ limit: 100 });
    expect(view.latest().status).toBe('ready');
    expect(view.latest().trajectory?.rows.map((row) => row.kind)).toEqual([
      'user',
      'request',
    ]);
  });

  it('prepends an older page ahead of the window', async () => {
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) =>
      opts.cursor === 'older-1'
        ? page([userText('first', 'rec-0')])
        : page([userText('second', 'rec-1')], {
            hasMore: true,
            nextCursor: 'older-1',
          }),
    );
    const view = render(loadPage);
    await act(async () => {});
    expect(view.latest().hasOlder).toBe(true);

    await act(async () => {
      view.latest().loadOlder();
    });

    // Order is what makes the window contiguous: the older page has to land
    // ahead of the one already held, not after it.
    const texts = view
      .latest()
      .trajectory!.rows.map((row) =>
        row.kind === 'user' ? row.block.text : '',
      );
    expect(texts).toEqual(['first', 'second']);
    expect(view.latest().hasOlder).toBe(false);
  });

  it('keeps row identity when an older page lands', async () => {
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) =>
      opts.cursor === 'older-1'
        ? page([userText('first', 'rec-0')])
        : page([userText('second', 'rec-1')], {
            hasMore: true,
            nextCursor: 'older-1',
          }),
    );
    const view = render(loadPage);
    await act(async () => {});
    const before = view.latest().trajectory!.rows.map((row) => row.key);

    await act(async () => {
      view.latest().loadOlder();
    });

    const after = view.latest().trajectory!.rows.map((row) => row.key);
    expect(after.slice(after.length - before.length)).toEqual(before);
  });

  it('stops paging once the window is full', async () => {
    const loadPage = vi.fn(async () =>
      page([userText('turn', `rec-${loadPage.mock.calls.length}`)], {
        hasMore: true,
        nextCursor: `older-${loadPage.mock.calls.length}`,
      }),
    );
    const view = render(loadPage, { maxPages: 2 });
    await act(async () => {});

    await act(async () => {
      view.latest().loadOlder();
    });
    expect(view.latest().atCapacity).toBe(true);
    expect(view.latest().hasOlder).toBe(false);

    await act(async () => {
      view.latest().loadOlder();
    });
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it('collapses a double click into one request', async () => {
    const pending = deferred<TrajectoryPageResult>();
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) =>
      opts.cursor
        ? pending.promise
        : page([userText('newest', 'rec-1')], {
            hasMore: true,
            nextCursor: 'older-1',
          }),
    );
    const view = render(loadPage);
    await act(async () => {});

    act(() => {
      view.latest().loadOlder();
      view.latest().loadOlder();
    });

    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(view.latest().loadingOlder).toBe(true);
    await act(async () => {
      pending.resolve(page([userText('older', 'rec-0')]));
    });
    expect(view.latest().loadingOlder).toBe(false);
  });

  it('refuses to page while a refresh is still in flight', async () => {
    const pending = deferred<TrajectoryPageResult>();
    let served = 0;
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) => {
      if (opts.cursor) return page([userText('older', 'rec-0')]);
      served += 1;
      return served === 1
        ? page([userText('newest', 'rec-1')], {
            hasMore: true,
            nextCursor: 'older-1',
          })
        : pending.promise;
    });
    const view = render(loadPage);
    await act(async () => {});

    await act(async () => {
      view.latest().refresh();
    });
    act(() => {
      view.latest().loadOlder();
    });

    // Paging bumps the generation, so letting it through here would throw
    // away the refresh reply and leave the reader with no sign of it.
    expect(loadPage).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.resolve(page([userText('refreshed', 'rec-2')]));
    });
    const rows = view.latest().trajectory!.rows;
    expect(rows[0]!.kind === 'user' && rows[0]!.block.text).toBe('refreshed');
  });

  it('rebuilds the window from the newest page on refresh', async () => {
    let body = 'first';
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) =>
      opts.cursor
        ? page([userText('older', 'rec-0')])
        : page([userText(body, 'rec-1')], {
            hasMore: true,
            nextCursor: 'older-1',
          }),
    );
    const view = render(loadPage);
    await act(async () => {});
    await act(async () => {
      view.latest().loadOlder();
    });
    expect(view.latest().trajectory!.rows).toHaveLength(2);

    body = 'second';
    await act(async () => {
      view.latest().refresh();
    });

    // A refresh starts a new window rather than splicing: page boundaries are
    // picked per request, so the held older page cannot be joined to a fresh
    // newest one without dropping or repeating records.
    const rows = view.latest().trajectory!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind === 'user' && rows[0]!.block.text).toBe('second');
    expect(view.latest().hasOlder).toBe(true);
  });

  it('drops a reply that a refresh has already superseded', async () => {
    const stale = deferred<TrajectoryPageResult>();
    let first = true;
    const loadPage = vi.fn(async () => {
      if (first) {
        first = false;
        return stale.promise;
      }
      return page([userText('fresh', 'rec-2')]);
    });
    const view = render(loadPage);
    await act(async () => {});

    await act(async () => {
      view.latest().refresh();
    });
    await act(async () => {
      stale.resolve(page([userText('stale', 'rec-1')]));
    });

    const rows = view.latest().trajectory!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind === 'user' && rows[0]!.block.text).toBe('fresh');
  });

  it('drops a reply that arrives after the loader changed', async () => {
    const stale = deferred<TrajectoryPageResult>();
    const first: TrajectoryPageLoader = vi.fn(async () => stale.promise);
    const second: TrajectoryPageLoader = vi.fn(async () =>
      page([userText('second session', 'rec-9')]),
    );
    const view = render(first);
    await act(async () => {});

    view.rerender(second);
    await act(async () => {});
    await act(async () => {
      stale.resolve(page([userText('first session', 'rec-1')]));
    });

    const rows = view.latest().trajectory!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind === 'user' && rows[0]!.block.text).toBe(
      'second session',
    );
  });

  it('keeps the held window when a page cannot be read', async () => {
    let fail = false;
    const loadPage = vi.fn(async () =>
      fail
        ? page([], { replayError: 'Replay conversion failed for this page' })
        : page([userText('kept', 'rec-1')]),
    );
    const view = render(loadPage);
    await act(async () => {});

    fail = true;
    await act(async () => {
      view.latest().refresh();
    });

    expect(view.latest().status).toBe('error');
    expect(view.latest().error).toEqual({
      kind: 'unreadable',
      message: 'Replay conversion failed for this page',
    });
    expect(view.latest().trajectory!.rows).toHaveLength(1);
  });

  it('names a partial page as a kind rather than a word', async () => {
    const loadPage = vi.fn(async () =>
      page([userText('half', 'rec-1')], { partial: true as const }),
    );
    const view = render(loadPage);
    await act(async () => {});

    // `partial` is a flag on the page, not a sentence; carrying it as a kind
    // keeps the literal out of the message the reader is shown.
    expect(view.latest().error).toEqual({ kind: 'partial' });
  });

  it('counts the pages it holds', async () => {
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) =>
      opts.cursor
        ? page([userText('older', 'rec-0')])
        : page([userText('newest', 'rec-1')], {
            hasMore: true,
            nextCursor: 'older-1',
          }),
    );
    const view = render(loadPage);
    await act(async () => {});
    expect(view.latest().pageCount).toBe(1);

    await act(async () => {
      view.latest().loadOlder();
    });
    expect(view.latest().pageCount).toBe(2);

    await act(async () => {
      view.latest().refresh();
    });
    expect(view.latest().pageCount).toBe(1);
  });

  it('holds its page count when an older page fails', async () => {
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) =>
      opts.cursor
        ? page([], { replayError: 'unreadable page' })
        : page([userText('newest', 'rec-1')], {
            hasMore: true,
            nextCursor: 'older-1',
          }),
    );
    const view = render(loadPage);
    await act(async () => {});

    await act(async () => {
      view.latest().loadOlder();
    });

    expect(view.latest().status).toBe('error');
    expect(view.latest().pageCount).toBe(1);
  });

  it('reports a partial page as an error rather than folding a prefix', async () => {
    const loadPage = vi.fn(async () =>
      page([userText('half', 'rec-1')], { partial: true as const }),
    );
    const view = render(loadPage);
    await act(async () => {});

    expect(view.latest().status).toBe('error');
    expect(view.latest().trajectory).toBeUndefined();
  });

  it('surfaces a rejected fetch', async () => {
    const loadPage = vi.fn(async () => {
      throw new Error('daemon unreachable');
    });
    const view = render(loadPage);
    await act(async () => {});

    expect(view.latest().status).toBe('error');
    expect(view.latest().error).toEqual({
      kind: 'unreadable',
      message: 'daemon unreachable',
    });
  });

  it('does not write state after unmount', async () => {
    const pending = deferred<TrajectoryPageResult>();
    const loadPage = vi.fn(async () => pending.promise);
    render(loadPage);
    await act(async () => {});

    const current = root!;
    act(() => current.unmount());
    root = null;

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      pending.resolve(page([userText('late', 'rec-1')]));
    });
    expect(errors).not.toHaveBeenCalled();
  });
});
