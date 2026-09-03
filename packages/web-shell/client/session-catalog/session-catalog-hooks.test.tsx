// @vitest-environment jsdom

import { StrictMode, useMemo } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonClient,
  DaemonSessionListPage,
} from '@qwen-code/sdk/daemon';
import type { SessionCatalogQuery } from './session-catalog-store';
import {
  SESSION_CATALOG_ERROR_RETRY_MS,
  SESSION_CATALOG_TRAILING_REFRESH_MS,
  getSessionCatalogStore,
} from './session-catalog-store';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  workspace: {
    client: undefined as unknown,
    workspaceCwd: '/primary',
    actions: {
      deleteSession: vi.fn(),
      deleteSessions: vi.fn(),
      archiveSession: vi.fn(),
      unarchiveSession: vi.fn(),
    },
  },
  useSessions: vi.fn(() => ({
    deleteSession: vi.fn(),
    deleteSessions: vi.fn(),
    archiveSession: vi.fn(),
    unarchiveSession: vi.fn(),
    exportSession: vi.fn(),
    loadSession: vi.fn(),
    resumeSession: vi.fn(),
    newSession: vi.fn(),
    releaseSession: vi.fn(),
  })),
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useSessions: mocks.useSessions,
  useWorkspace: () => mocks.workspace,
}));

const {
  useSessionCatalogQuery,
  useSessionCatalogController,
  useSessionActivePromptState,
  useWebShellSessions,
} = await import('./session-catalog-hooks');

let root: Root;
let container: HTMLDivElement;
let legacy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  legacy = vi.fn();
  mocks.workspace.actions.deleteSession.mockReset();
  mocks.workspace.actions.deleteSessions.mockReset();
  mocks.workspace.actions.archiveSession.mockReset();
  mocks.workspace.actions.unarchiveSession.mockReset();
  mocks.workspace.client = {
    listWorkspaceSessionsPage: legacy,
    workspaceByCwd: vi.fn(() => ({
      listWorkspaceSessionsPage: vi.fn(),
    })),
  } as unknown as DaemonClient;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function QueryProbe({ id }: { id: string }) {
  const query = useMemo<SessionCatalogQuery>(
    () => ({
      routeKind: 'legacy',
      workspaceCwd: '/work',
      options: { pageSize: 25, archiveState: 'active' },
    }),
    [],
  );
  const result = useSessionCatalogQuery(
    mocks.workspace.client as DaemonClient,
    query,
    { autoLoad: true },
  );
  return <span data-testid={id}>{result.sessions[0]?.sessionId}</span>;
}

describe('session catalog hooks', () => {
  it('shares one request across StrictMode consumers and remounts', async () => {
    const response = deferred<DaemonSessionListPage>();
    legacy.mockReturnValue(response.promise);
    act(() => {
      root.render(
        <StrictMode>
          <QueryProbe id="first" />
          <QueryProbe id="second" />
        </StrictMode>,
      );
    });
    expect(legacy).toHaveBeenCalledTimes(1);

    await act(async () => {
      response.resolve({ sessions: [{ sessionId: 'shared' }] });
      await response.promise;
    });
    expect(container.textContent).toBe('sharedshared');

    act(() => root.unmount());
    root = createRoot(container);
    act(() => {
      root.render(
        <StrictMode>
          <QueryProbe id="remounted" />
        </StrictMode>,
      );
    });
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('shared');
  });

  it('provides the legacy Web Shell facade without dropping page metadata', async () => {
    legacy.mockResolvedValue({
      sessions: [{ sessionId: 'primary' }],
      nextCursor: 'next',
      liveMergeFailed: true,
      truncated: true,
    } satisfies DaemonSessionListPage);

    function FacadeProbe() {
      const result = useWebShellSessions({
        autoLoad: true,
        pageSize: 25,
        archiveState: 'active',
        sourceType: 'default',
      });
      return (
        <span>
          {result.sessions[0]?.sessionId}:{result.nextCursor}:
          {String(result.liveMergeFailed)}:{String(result.truncated)}
        </span>
      );
    }

    await act(async () => {
      root.render(<FacadeProbe />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(legacy).toHaveBeenCalledWith('/primary', {
      pageSize: 25,
      archiveState: 'active',
      sourceType: 'default',
    });
    expect(container.textContent).toBe('primary:next:true:true');
  });

  it('runs mutations directly and performs only the Store resynchronization', async () => {
    legacy.mockResolvedValue({ sessions: [{ sessionId: 'primary' }] });
    mocks.workspace.actions.deleteSession.mockResolvedValue(true);
    let facade: ReturnType<typeof useWebShellSessions> | undefined;

    function FacadeProbe() {
      facade = useWebShellSessions({ autoLoad: true });
      return null;
    }

    await act(async () => {
      root.render(<FacadeProbe />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(legacy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await facade!.deleteSession('primary');
    });

    expect(mocks.workspace.actions.deleteSession).toHaveBeenCalledWith(
      'primary',
    );
    expect(
      mocks.useSessions.mock.results.at(-1)?.value.deleteSession,
    ).not.toHaveBeenCalled();
    expect(legacy).toHaveBeenCalledTimes(2);
  });

  it('keeps the legacy reload contract when a list request fails', async () => {
    legacy.mockRejectedValue(new Error('offline'));
    let facade: ReturnType<typeof useWebShellSessions> | undefined;

    function FacadeProbe() {
      facade = useWebShellSessions();
      return null;
    }

    act(() => root.render(<FacadeProbe />));
    let result: unknown;
    await act(async () => {
      result = await facade!.reload();
    });
    expect(result).toBeUndefined();
  });

  it('routes turn completions by live-state ownership', () => {
    const client = mocks.workspace.client as DaemonClient;
    const store = getSessionCatalogStore(client);
    let controller: ReturnType<typeof useSessionCatalogController> | undefined;

    function ControllerProbe() {
      controller = useSessionCatalogController(client);
      return null;
    }

    act(() => root.render(<ControllerProbe />));
    const record = vi.spyOn(store, 'recordSessionActivity');
    const invalidate = vi.spyOn(store, 'invalidateWorkspace');
    const schedule = vi.spyOn(store, 'scheduleWorkspaceRefresh');

    // Without live-state ownership the legacy rescan path stays.
    act(() => controller!.turnCompleted('/w', 'sess-1'));
    expect(invalidate).toHaveBeenCalledWith('/w');
    expect(schedule).toHaveBeenCalledWith('/w');
    expect(store.snapshotSessionActivity('/w')).toBeUndefined();

    invalidate.mockClear();
    schedule.mockClear();
    const releaseLiveState = store.retainWorkspaceLiveState('/w');
    act(() => controller!.turnCompleted('/w', 'sess-1'));
    expect(record).toHaveBeenCalledWith('/w', 'sess-1');
    expect(store.snapshotSessionActivity('/w')?.get('sess-1')).toBeDefined();
    expect(invalidate).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    releaseLiveState();
  });
});

describe('useSessionActivePromptState (#9487)', () => {
  function setQualifiedPage(sessions: unknown[]): ReturnType<typeof vi.fn> {
    const listPage = vi.fn().mockResolvedValue({ sessions });
    (mocks.workspace.client as { workspaceByCwd: unknown }).workspaceByCwd =
      vi.fn(() => ({ listWorkspaceSessionsPage: listPage }));
    return listPage;
  }

  function ActivePromptProbe({ sessionId = 'sess-1' }: { sessionId?: string }) {
    const { hasActivePrompt } = useSessionActivePromptState(
      mocks.workspace.client as DaemonClient,
      '/work',
      sessionId,
    );
    return <span>{String(hasActivePrompt)}</span>;
  }

  it('does not load the catalog while live-state is retained', async () => {
    const listPage = setQualifiedPage([
      { sessionId: 'sess-1', workspaceCwd: '/work', hasActivePrompt: true },
    ]);
    const store = getSessionCatalogStore(
      mocks.workspace.client as DaemonClient,
    );
    const releaseLiveState = store.retainWorkspaceLiveState('/work');

    await act(async () => {
      root.render(<ActivePromptProbe />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(listPage).not.toHaveBeenCalled();
    expect(container.textContent).toBe('false');
    releaseLiveState();
  });

  it('loads the catalog fallback when live-state is not retained', async () => {
    const listPage = setQualifiedPage([
      { sessionId: 'sess-1', workspaceCwd: '/work', hasActivePrompt: true },
    ]);

    await act(async () => {
      root.render(<ActivePromptProbe />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(listPage).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('true');
  });

  it('prefers the daemon live-state snapshot over a catalog page', async () => {
    setQualifiedPage([
      { sessionId: 'sess-1', workspaceCwd: '/work', hasActivePrompt: true },
    ]);
    const client = mocks.workspace.client as DaemonClient;
    const store = getSessionCatalogStore(client);

    await act(async () => {
      root.render(<ActivePromptProbe />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    // No live-state snapshot yet: the catalog page fallback answers.
    expect(container.textContent).toBe('true');

    act(() => {
      store.applyLiveState('/work', [
        {
          sessionId: 'sess-1',
          clientCount: 1,
          hasActivePrompt: false,
          isWaitingForPermission: false,
          isWaitingForUserQuestion: false,
        },
      ]);
    });
    // Live state is authoritative even when it disagrees with the page.
    expect(container.textContent).toBe('false');

    act(() => {
      store.applyLiveState('/work', []);
    });
    // A session absent from the live response has no active prompt.
    expect(container.textContent).toBe('false');
  });

  it('reports the answer as unknown until an authority covers the workspace', async () => {
    // `known` gates settling a running turn: a `false` that only means
    // "nothing has answered yet" must never be mistaken for "turn finished".
    const listPage = vi.fn(
      () =>
        new Promise<{ sessions: unknown[] }>(() => {
          // never resolves: the fallback page is still in flight
        }),
    );
    (mocks.workspace.client as { workspaceByCwd: unknown }).workspaceByCwd =
      vi.fn(() => ({ listWorkspaceSessionsPage: listPage }));
    const client = mocks.workspace.client as DaemonClient;
    const store = getSessionCatalogStore(client);

    function KnownProbe() {
      const state = useSessionActivePromptState(client, '/work', 'sess-1');
      return <span>{`${state.hasActivePrompt}/${state.known}`}</span>;
    }

    await act(async () => {
      root.render(<KnownProbe />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(container.textContent).toBe('false/false');

    act(() => {
      store.applyLiveState('/work', []);
    });
    // A live-state response that covers the workspace answers definitively:
    // absent from it means the session has no prompt in flight.
    expect(container.textContent).toBe('false/true');
  });

  it('tracks a live flip for a workspace it is already covering', async () => {
    // Regression: the subscription used to expose only "does this workspace
    // have live state", which stays true across polls — so useSyncExternalStore
    // bailed out of re-rendering on the one change that matters, and the reader
    // kept serving a stale answer through exactly the silent gaps this signal
    // exists to cover.
    setQualifiedPage([]);
    const client = mocks.workspace.client as DaemonClient;
    const store = getSessionCatalogStore(client);
    const live = (hasActivePrompt: boolean) => [
      {
        sessionId: 'sess-1',
        clientCount: 1,
        hasActivePrompt,
        isWaitingForPermission: false,
        isWaitingForUserQuestion: false,
      },
    ];

    await act(async () => {
      root.render(<ActivePromptProbe />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    // Establish live-state coverage first, so hasLiveSessions is already true.
    act(() => {
      store.applyLiveState('/work', live(false));
    });
    expect(container.textContent).toBe('false');
    // Now only the per-session flag flips.
    act(() => {
      store.applyLiveState('/work', live(true));
    });
    expect(container.textContent).toBe('true');
  });

  it('does not answer for a session the bounded fallback page omits', async () => {
    // The page is bounded, so "not on it" may just mean the session fell off a
    // fresher first page. Reporting that as a known `false` would let a caller
    // settle a turn that is still running.
    setQualifiedPage([
      { sessionId: 'other', workspaceCwd: '/work', hasActivePrompt: true },
    ]);
    const client = mocks.workspace.client as DaemonClient;

    function KnownProbe() {
      const state = useSessionActivePromptState(client, '/work', 'sess-1');
      return <span>{`${state.hasActivePrompt}/${state.known}`}</span>;
    }

    await act(async () => {
      root.render(<KnownProbe />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(container.textContent).toBe('false/false');
  });

  it('sees an active prompt the loaded catalog page does not contain', async () => {
    // The connected session fell off the bounded first page (20+ fresher
    // sessions): only the live-state snapshot can still see it.
    setQualifiedPage([
      { sessionId: 'other', workspaceCwd: '/work', hasActivePrompt: false },
    ]);
    const client = mocks.workspace.client as DaemonClient;
    const store = getSessionCatalogStore(client);

    await act(async () => {
      root.render(<ActivePromptProbe />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(container.textContent).toBe('false');

    act(() => {
      store.applyLiveState('/work', [
        {
          sessionId: 'sess-1',
          clientCount: 1,
          hasActivePrompt: true,
          isWaitingForPermission: false,
          isWaitingForUserQuestion: false,
        },
      ]);
    });
    expect(container.textContent).toBe('true');
  });

  it('keeps a turn-completion clear when every clearing refresh fails', async () => {
    vi.useFakeTimers();
    try {
      legacy
        .mockResolvedValueOnce({
          sessions: [
            { sessionId: 'sess-1', workspaceCwd: '/w', hasActivePrompt: true },
          ],
        })
        .mockRejectedValue(new Error('offline'));
      const client = mocks.workspace.client as DaemonClient;
      let controller: ReturnType<typeof useSessionCatalogController>;
      let latestFlag: boolean | undefined;

      function Probe() {
        controller = useSessionCatalogController(client);
        const result = useSessionCatalogQuery(
          client,
          { routeKind: 'legacy', workspaceCwd: '/w', options: {} },
          { autoLoad: true },
        );
        latestFlag = result.sessions[0]?.hasActivePrompt;
        return null;
      }

      await act(async () => {
        root.render(<Probe />);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(latestFlag!).toBe(true);

      act(() => controller!.turnCompleted('/w', 'sess-1'));
      // The optimistic clear lands ahead of any refresh.
      expect(latestFlag!).toBe(false);

      // Trailing refresh and error retries all fail (daemon restart window):
      // they must refresh the PAGE, never resurrect the stale true.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          SESSION_CATALOG_TRAILING_REFRESH_MS + 10,
        );
      });
      expect(latestFlag!).toBe(false);
      const callsAfterTrailing = legacy.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SESSION_CATALOG_ERROR_RETRY_MS + 10);
      });
      // The autoLoad subscription arms the store's error-retry timer, so the
      // catalog keeps reconciling instead of freezing on the failed refresh.
      expect(legacy.mock.calls.length).toBeGreaterThan(callsAfterTrailing);
      expect(latestFlag!).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
