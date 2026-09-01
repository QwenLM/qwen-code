/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonClient,
  DaemonSessionSearchResult,
} from '@qwen-code/sdk/daemon';
import {
  useSessionContentSearch,
  type SessionContentSearchHit,
} from './useSessionContentSearch';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let captured: ReadonlyMap<string, SessionContentSearchHit> | undefined;

const searchWorkspaceSessions =
  vi.fn<(typeof DaemonClient.prototype)['searchWorkspaceSessions']>();
const client = { searchWorkspaceSessions } as unknown as DaemonClient;

function TestHost({
  query,
  reloadToken = 0,
}: {
  query: string;
  reloadToken?: number;
}) {
  captured = useSessionContentSearch(client, '/work/a', query, reloadToken);
  return null;
}

async function renderHost(query: string, reloadToken = 0) {
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(React.createElement(TestHost, { query, reloadToken }));
  });
  if (!captured) throw new Error('hook did not render');
  return captured;
}

async function advanceDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  // Flush the search promise and resulting state update.
  await act(async () => {});
}

beforeEach(() => {
  captured = undefined;
  searchWorkspaceSessions.mockReset();
  vi.useFakeTimers();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  vi.useRealTimers();
});

describe('useSessionContentSearch', () => {
  it('does not search for queries shorter than two characters', async () => {
    const hits = await renderHost('a');
    await advanceDebounce();

    expect(searchWorkspaceSessions).not.toHaveBeenCalled();
    expect(hits.size).toBe(0);
  });

  it('debounces and maps results into hits keyed by session id', async () => {
    const result: DaemonSessionSearchResult = {
      results: [
        {
          session: { sessionId: 's1', workspaceCwd: '/work/a' },
          snippet: '...qdrant...',
        },
      ],
    };
    searchWorkspaceSessions.mockResolvedValue(result);

    await renderHost('  qdrant  ');
    expect(searchWorkspaceSessions).not.toHaveBeenCalled();
    await advanceDebounce();

    expect(searchWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(searchWorkspaceSessions).toHaveBeenCalledWith(
      '/work/a',
      'qdrant',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(captured?.get('s1')?.snippet).toBe('...qdrant...');
  });

  it('searches only for the latest query while typing', async () => {
    searchWorkspaceSessions.mockResolvedValue({ results: [] });

    await renderHost('qd');
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    await renderHost('qdrant');
    await advanceDebounce();

    expect(searchWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(searchWorkspaceSessions).toHaveBeenCalledWith(
      '/work/a',
      'qdrant',
      expect.anything(),
    );
  });

  it('degrades to empty hits when the request fails', async () => {
    searchWorkspaceSessions.mockRejectedValue(new Error('404'));

    await renderHost('qdrant');
    await advanceDebounce();

    expect(captured?.size).toBe(0);
  });

  it('clears established hits when a later request fails', async () => {
    searchWorkspaceSessions.mockResolvedValueOnce({
      results: [
        {
          session: { sessionId: 's1', workspaceCwd: '/work/a' },
          snippet: 'hit',
        },
      ],
    });
    await renderHost('qdrant');
    await advanceDebounce();
    expect(captured?.size).toBe(1);

    searchWorkspaceSessions.mockRejectedValueOnce(new Error('500'));
    await renderHost('other');
    await advanceDebounce();

    expect(captured?.size).toBe(0);
  });

  it('resets settled hits as soon as the query changes', async () => {
    searchWorkspaceSessions.mockResolvedValue({
      results: [
        {
          session: { sessionId: 's1', workspaceCwd: '/work/a' },
          snippet: 'hit',
        },
      ],
    });
    await renderHost('qd');
    await advanceDebounce();
    expect(captured?.size).toBe(1);

    // Before the new debounce fires, the previous query's hits must not
    // render under the new query.
    const changed = await renderHost('qdrant');
    expect(changed.size).toBe(0);
  });

  it('ignores a superseded request resolving after the newer one', async () => {
    let resolveFirst: ((result: DaemonSessionSearchResult) => void) | undefined;
    let resolveSecond:
      | ((result: DaemonSessionSearchResult) => void)
      | undefined;
    searchWorkspaceSessions
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );

    await renderHost('qd');
    await advanceDebounce();
    expect(searchWorkspaceSessions).toHaveBeenCalledTimes(1);

    await renderHost('qdrant');
    await advanceDebounce();
    expect(searchWorkspaceSessions).toHaveBeenCalledTimes(2);

    // The newer request resolves first, then the superseded one — its late
    // response must not overwrite the fresh hits.
    await act(async () => {
      resolveSecond?.({
        results: [
          {
            session: { sessionId: 'fresh', workspaceCwd: '/work/a' },
            snippet: 'fresh',
          },
        ],
      });
    });
    await act(async () => {
      resolveFirst?.({
        results: [
          {
            session: { sessionId: 'stale', workspaceCwd: '/work/a' },
            snippet: 'stale',
          },
        ],
      });
    });

    expect(captured?.has('fresh')).toBe(true);
    expect(captured?.has('stale')).toBe(false);
  });

  it('caps over-long queries at the daemon route limit', async () => {
    searchWorkspaceSessions.mockResolvedValue({
      results: [
        {
          session: { sessionId: 's1', workspaceCwd: '/work/a' },
          snippet: 'hit',
        },
      ],
    });

    await renderHost(` ${'a'.repeat(250)} `);
    await advanceDebounce();

    expect(searchWorkspaceSessions).toHaveBeenCalledWith(
      '/work/a',
      'a'.repeat(200),
      expect.anything(),
    );
    expect(captured?.size).toBe(1);
  });

  it('drops a lead surrogate straddling the query cap instead of slicing mid-pair', async () => {
    searchWorkspaceSessions.mockResolvedValue({
      results: [
        {
          session: { sessionId: 's1', workspaceCwd: '/work/a' },
          snippet: 'hit',
        },
      ],
    });

    await renderHost(`${'a'.repeat(199)}${'🚀'.repeat(5)}`);
    await advanceDebounce();

    // Slicing at code unit 200 would cut the first rocket's surrogate pair
    // and send a corrupted (U+FFFD) query the daemon can't match.
    expect(searchWorkspaceSessions).toHaveBeenCalledWith(
      '/work/a',
      'a'.repeat(199),
      expect.anything(),
    );
    expect(captured?.size).toBe(1);
  });

  it('ignores whitespace-only edits after hits settle', async () => {
    searchWorkspaceSessions.mockResolvedValue({
      results: [
        {
          session: { sessionId: 's1', workspaceCwd: '/work/a' },
          snippet: 'hit',
        },
      ],
    });
    await renderHost('qdrant');
    await advanceDebounce();
    expect(captured?.size).toBe(1);
    expect(searchWorkspaceSessions).toHaveBeenCalledTimes(1);

    // The trimmed query is unchanged: no blanking, no redundant refetch.
    const spaced = await renderHost('qdrant ');
    await advanceDebounce();
    expect(spaced.size).toBe(1);
    expect(searchWorkspaceSessions).toHaveBeenCalledTimes(1);
  });

  it('never commits a render pairing a changed query with settled hits', async () => {
    const committed: Array<[string, number]> = [];
    function RecordingHost({ query }: { query: string }) {
      const hits = useSessionContentSearch(client, '/work/a', query);
      // A layout effect observes committed renders before passive effects
      // run — a passive-effect reset would still paint one stale frame.
      React.useLayoutEffect(() => {
        committed.push([query, hits.size]);
      });
      return null;
    }
    searchWorkspaceSessions.mockResolvedValue({
      results: [
        {
          session: { sessionId: 's1', workspaceCwd: '/work/a' },
          snippet: 'hit',
        },
      ],
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(RecordingHost, { query: 'qd' }));
    });
    await advanceDebounce();
    expect(committed).toContainEqual(['qd', 1]);

    await act(async () => {
      root?.render(React.createElement(RecordingHost, { query: 'qdrant' }));
    });

    expect(committed.some(([query]) => query === 'qdrant')).toBe(true);
    for (const [query, size] of committed) {
      if (query === 'qdrant') expect(size).toBe(0);
    }
  });

  it('clears hits when the query is cleared', async () => {
    searchWorkspaceSessions.mockResolvedValue({
      results: [
        {
          session: { sessionId: 's1', workspaceCwd: '/work/a' },
          snippet: 'hit',
        },
      ],
    });

    await renderHost('qdrant');
    await advanceDebounce();
    expect(captured?.size).toBe(1);

    const cleared = await renderHost('');
    expect(cleared.size).toBe(0);
  });

  it('invalidates settled hits when the reload token bumps', async () => {
    searchWorkspaceSessions.mockResolvedValue({
      results: [
        {
          session: { sessionId: 's1', workspaceCwd: '/work/a' },
          snippet: 'hit',
        },
      ],
    });
    await renderHost('qdrant', 0);
    await advanceDebounce();
    expect(captured?.size).toBe(1);

    // A catalog mutation (delete/archive) bumps the token: hits blank
    // immediately and the refetch observes the session is gone.
    searchWorkspaceSessions.mockResolvedValue({ results: [] });
    const bumped = await renderHost('qdrant', 1);
    expect(bumped.size).toBe(0);
    await advanceDebounce();

    expect(searchWorkspaceSessions).toHaveBeenCalledTimes(2);
    expect(captured?.size).toBe(0);
  });
});
