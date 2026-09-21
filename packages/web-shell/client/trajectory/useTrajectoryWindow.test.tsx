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
  options?: { pageSize?: number },
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
    expect(loadPage.mock.calls[0]![0]).toEqual({ limit: 250 });
    expect(view.latest().status).toBe('ready');
    expect(view.latest().truncated).toBe(false);
    expect(view.latest().trajectory?.rows.map((row) => row.kind)).toEqual([
      'user',
      'request',
    ]);
  });

  it('says when the session has history the page left out', async () => {
    const loadPage = vi.fn(async () =>
      page([userText('newest', 'rec-1')], { hasMore: true }),
    );
    const view = render(loadPage);
    await act(async () => {});

    // Nothing here can reach that history yet, so the window reports it as a
    // fact about the page rather than as something to act on.
    expect(view.latest().truncated).toBe(true);
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it('replaces the page on refresh rather than adding to it', async () => {
    let body = 'first';
    const loadPage = vi.fn(async () => page([userText(body, 'rec-1')]));
    const view = render(loadPage);
    await act(async () => {});
    expect(view.latest().trajectory!.rows).toHaveLength(1);

    body = 'second';
    await act(async () => {
      view.latest().refresh();
    });

    // Page boundaries are picked per request, so a fresh page and the held one
    // overlap by an unknown amount and cannot be joined without dropping or
    // repeating records.
    const rows = view.latest().trajectory!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind === 'user' && rows[0]!.block.text).toBe('second');
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

  it('drops a failure that a refresh has already superseded', async () => {
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
      stale.reject(new Error('socket hang up'));
    });

    // The read that failed is not the one on screen, so its error is not
    // this window's to report.
    expect(view.latest().status).toBe('ready');
    expect(view.latest().error).toBeUndefined();
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

  it("drops the previous loader's page when the loader changes", async () => {
    const first: TrajectoryPageLoader = vi.fn(async () =>
      page([userText('first session', 'rec-1')]),
    );
    const failing = deferred<TrajectoryPageResult>();
    const second: TrajectoryPageLoader = vi.fn(async () => failing.promise);
    const view = render(first);
    await act(async () => {});
    expect(view.latest().trajectory!.rows).toHaveLength(1);

    view.rerender(second);
    await act(async () => {
      failing.reject(new Error('second session is unreadable'));
    });

    // A different loader is a different session. Holding the old rows is what
    // `refresh` does, and doing it here would leave one session's trajectory
    // on screen underneath another session's error.
    expect(view.latest().trajectory).toBeUndefined();
    expect(view.latest().error).toEqual({
      kind: 'unreadable',
      message: 'second session is unreadable',
    });
  });

  it('reads again after a failure', async () => {
    let calls = 0;
    const loadPage: TrajectoryPageLoader = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('down');
      return page([userText('recovered', 'rec-1')]);
    });
    const view = render(loadPage);
    await act(async () => {});
    expect(view.latest().error).toEqual({
      kind: 'unreadable',
      message: 'down',
    });

    await act(async () => view.latest().refresh());

    expect(view.latest().trajectory!.rows).toHaveLength(1);
    expect(view.latest().error).toBeUndefined();
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
