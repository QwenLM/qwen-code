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

function TestHost({ query }: { query: string }) {
  captured = useSessionContentSearch(client, '/work/a', query);
  return null;
}

async function renderHost(query: string) {
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(React.createElement(TestHost, { query }));
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
});
