// @vitest-environment jsdom

import { act, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonClient,
  DaemonSessionGroupCatalog,
  DaemonSessionListPage,
  DaemonWorkspaceSessionLiveState,
} from '@qwen-code/sdk/daemon';
import {
  useSessionCatalogController,
  useSessionCatalogQuery,
} from './session-catalog-hooks';
import {
  getSessionCatalogStore,
  type SessionCatalogQuery,
} from './session-catalog-store';
import {
  SESSION_LIVE_STATE_ERROR_RETRY_MS,
  SESSION_LIVE_STATE_POLL_MS,
  SESSION_LIVE_STATE_RECONCILE_COOLDOWN_MS,
  useWorkspaceSessionLiveState,
} from './workspace-session-live-state';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function liveState(
  revision: number,
  hasActivePrompt = false,
  updatedAt?: string,
): DaemonWorkspaceSessionLiveState {
  return {
    v: 1,
    catalogVersion: { generation: 'generation-a', revision },
    sessions: [
      {
        sessionId: 'session-a',
        clientCount: 1,
        hasActivePrompt,
        isWaitingForPermission: hasActivePrompt,
        isWaitingForUserQuestion: false,
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      },
    ],
  };
}

function sessionPage(): DaemonSessionListPage {
  return {
    sessions: [
      {
        sessionId: 'session-a',
        workspaceCwd: '/work',
        displayName: 'Session A',
        clientCount: 0,
        hasActivePrompt: false,
      },
    ],
  };
}

const query: SessionCatalogQuery = {
  routeKind: 'legacy',
  workspaceCwd: '/work',
  options: { pageSize: 100, archiveState: 'active' },
};

describe('useWorkspaceSessionLiveState', () => {
  let root: Root;
  let container: HTMLDivElement;
  let listSessions: ReturnType<typeof vi.fn>;
  let getLiveState: ReturnType<typeof vi.fn>;
  let listGroups: ReturnType<typeof vi.fn>;
  let client: DaemonClient;
  let controller: ReturnType<typeof useSessionCatalogController>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    listSessions = vi.fn().mockResolvedValue(sessionPage());
    getLiveState = vi.fn().mockResolvedValue(liveState(1));
    listGroups = vi.fn().mockResolvedValue({
      groups: [],
      colorOptions: [],
    } satisfies DaemonSessionGroupCatalog);
    client = {
      listWorkspaceSessionsPage: listSessions,
      getWorkspaceSessionLiveState: getLiveState,
      workspaceByCwd: vi.fn(() => ({
        listWorkspaceSessionsPage: listSessions,
        listSessionGroups: listGroups,
      })),
    } as unknown as DaemonClient;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function Probe({
    organizationEnabled = false,
    sourceType,
  }: {
    organizationEnabled?: boolean;
    sourceType?: string;
  }) {
    const activeQuery = useMemo<SessionCatalogQuery>(
      () => ({
        ...query,
        options: { ...query.options, sourceType },
      }),
      [sourceType],
    );
    const catalog = useSessionCatalogQuery(client, activeQuery);
    controller = useSessionCatalogController(client);
    const groupCatalogs = useWorkspaceSessionLiveState(client, {
      enabled: true,
      workspaceCwds: ['/work'],
      groupWorkspaceCwds: organizationEnabled ? ['/work'] : [],
    });
    const session = catalog.sessions[0];
    return (
      <span>
        {String(session?.hasActivePrompt)}:
        {String(session?.isWaitingForPermission)}:
        {groupCatalogs.get('/work')?.groups[0]?.name ?? 'no-group'}
      </span>
    );
  }

  async function renderProbe(
    organizationEnabled = false,
    sourceType?: string,
  ): Promise<void> {
    await act(async () => {
      root.render(
        <Probe
          organizationEnabled={organizationEnabled}
          sourceType={sourceType}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('polls only live-state after the initial version-fenced catalog load', async () => {
    let active = false;
    getLiveState.mockImplementation(async () => liveState(1, active));
    await renderProbe();
    const initialCatalogRequests = listSessions.mock.calls.length;
    expect(initialCatalogRequests).toBe(1);
    expect(getLiveState).toHaveBeenCalledTimes(2);

    active = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS * 3);
    });

    expect(getLiveState).toHaveBeenCalledTimes(5);
    expect(listSessions).toHaveBeenCalledTimes(initialCatalogRequests);
    expect(listGroups).not.toHaveBeenCalled();
    expect(container.textContent).toBe('true:true:no-group');
  });

  it('does not rescan the catalog for prompt admission, and rate-limits unusable-watermark completions', async () => {
    await renderProbe();
    const catalogRequests = listSessions.mock.calls.length;

    act(() => controller.promptAdmitted('/work', 'session-a'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });
    expect(listSessions).toHaveBeenCalledTimes(catalogRequests);

    // The live rows carry no updatedAt (old server / no running terminal
    // yet), so completions fall back to the rate-limited reconcile path:
    // one rescan per cooldown window.
    act(() => {
      controller.turnCompleted('/work', 'session-a');
      controller.turnCompleted('/work', 'session-a');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });
    expect(listSessions).toHaveBeenCalledTimes(catalogRequests + 1);

    act(() => controller.turnCompleted('/work', 'session-a'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });
    expect(listSessions).toHaveBeenCalledTimes(catalogRequests + 1);
    // Falling back must still resolve the pending completion — a leaked
    // entry would re-flag the invalidation on every poll and re-run a full
    // rescan once per cooldown window, forever.
    expect(
      getSessionCatalogStore(client).snapshotSessionActivity('/work'),
    ).toBeUndefined();
  });

  it('settles a turn completion from the live watermark without a catalog scan', async () => {
    let stamp = '2026-08-17T00:00:01.000Z';
    getLiveState.mockImplementation(async () => liveState(1, false, stamp));
    await renderProbe();
    const catalogRequests = listSessions.mock.calls.length;
    const store = getSessionCatalogStore(client);

    stamp = '2026-08-17T00:00:05.000Z';
    act(() => controller.turnCompleted('/work', 'session-a'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });

    expect(listSessions).toHaveBeenCalledTimes(catalogRequests);
    expect(store.snapshotSessionActivity('/work')).toBeUndefined();
    expect(store.getSnapshot(query).page?.sessions[0]?.updatedAt).toBe(
      '2026-08-17T00:00:05.000Z',
    );

    // Repeated completions keep settling in place — the full catalog scan
    // stays retired for the recency path.
    stamp = '2026-08-17T00:00:07.000Z';
    act(() => controller.turnCompleted('/work', 'session-a'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });
    expect(listSessions).toHaveBeenCalledTimes(catalogRequests);
    expect(store.getSnapshot(query).page?.sessions[0]?.updatedAt).toBe(
      '2026-08-17T00:00:07.000Z',
    );
  });

  it('does not let an in-flight response settle a newer completion', async () => {
    getLiveState.mockImplementation(async () =>
      liveState(1, false, '2026-08-17T00:00:01.000Z'),
    );
    await renderProbe();
    const catalogRequests = listSessions.mock.calls.length;
    const store = getSessionCatalogStore(client);

    let resolveInFlight!: (state: DaemonWorkspaceSessionLiveState) => void;
    getLiveState.mockImplementationOnce(
      () =>
        new Promise<DaemonWorkspaceSessionLiveState>((resolve) => {
          resolveInFlight = resolve;
        }),
    );
    // The wake-driven request snapshots the first completion, then a second
    // completion lands while that request is in flight.
    act(() => controller.turnCompleted('/work', 'session-a'));
    act(() => controller.turnCompleted('/work', 'session-a'));
    await act(async () => {
      resolveInFlight(liveState(1, false, '2026-08-17T00:00:02.000Z'));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The stale response must leave the newer completion pending.
    expect(
      store.snapshotSessionActivity('/work')?.get('session-a'),
    ).toBeDefined();

    getLiveState.mockImplementation(async () =>
      liveState(1, false, '2026-08-17T00:00:03.000Z'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });
    expect(store.snapshotSessionActivity('/work')).toBeUndefined();
    expect(listSessions).toHaveBeenCalledTimes(catalogRequests);
  });

  it('falls back to the rate-limited reconcile when the completed session is not loaded', async () => {
    getLiveState.mockImplementation(async () => ({
      ...liveState(1),
      sessions: [
        ...liveState(1).sessions,
        {
          sessionId: 'session-unloaded',
          clientCount: 1,
          hasActivePrompt: false,
          isWaitingForPermission: false,
          isWaitingForUserQuestion: false,
          updatedAt: '2026-08-17T00:00:05.000Z',
        },
      ],
    }));
    await renderProbe();
    const catalogRequests = listSessions.mock.calls.length;

    // The row carries a valid watermark but is absent from the loaded
    // active page, so recency must come from a full reconcile.
    act(() => controller.turnCompleted('/work', 'session-unloaded'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });
    expect(listSessions).toHaveBeenCalledTimes(catalogRequests + 1);
    expect(
      getSessionCatalogStore(client).snapshotSessionActivity('/work'),
    ).toBeUndefined();

    // With the completion resolved, an idle cooldown window must stay quiet
    // — no further rescan may be re-triggered by leaked pending state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        SESSION_LIVE_STATE_RECONCILE_COOLDOWN_MS,
      );
    });
    expect(listSessions).toHaveBeenCalledTimes(catalogRequests + 1);
  });

  it('falls back when the completed session is absent from the live response', async () => {
    await renderProbe();
    const catalogRequests = listSessions.mock.calls.length;

    // The live response only ever lists session-a; a completion for a
    // session the daemon no longer reports live must fall back.
    act(() => controller.turnCompleted('/work', 'session-ghost'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });
    expect(listSessions).toHaveBeenCalledTimes(catalogRequests + 1);
    expect(
      getSessionCatalogStore(client).snapshotSessionActivity('/work'),
    ).toBeUndefined();
  });

  it('keeps a completion pending across a reconcile and settles on the next poll', async () => {
    let revision = 1;
    let stamp: string | undefined = undefined;
    getLiveState.mockImplementation(async () =>
      liveState(revision, false, stamp),
    );
    await renderProbe();
    const store = getSessionCatalogStore(client);

    // A version bump past the cooldown window starts a reconcile whose
    // staged catalog fetch is held open.
    let releaseStaged!: (page: DaemonSessionListPage) => void;
    listSessions.mockImplementationOnce(
      () =>
        new Promise<DaemonSessionListPage>((resolve) => {
          releaseStaged = resolve;
        }),
    );
    revision = 2;
    stamp = '2026-08-17T00:00:05.000Z';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        SESSION_LIVE_STATE_RECONCILE_COOLDOWN_MS,
      );
    });

    // The completion lands while the reconcile is in flight; its liveB read
    // must not settle it (the staged page it commits may be staler than the
    // liveB watermark).
    act(() => controller.turnCompleted('/work', 'session-a'));
    const liveReadsBeforeRelease = getLiveState.mock.calls.length;
    await act(async () => {
      releaseStaged(sessionPage());
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
    // The reconcile's liveB read has happened, yet the completion is still
    // pending — only a direct poll read may settle it.
    expect(getLiveState.mock.calls.length).toBeGreaterThan(
      liveReadsBeforeRelease,
    );
    expect(
      store.snapshotSessionActivity('/work')?.get('session-a'),
    ).toBeDefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });
    expect(store.snapshotSessionActivity('/work')).toBeUndefined();
    expect(store.getSnapshot(query).page?.sessions[0]?.updatedAt).toBe(
      '2026-08-17T00:00:05.000Z',
    );
  });

  it('keeps a completion pending across a live-state failure and settles after recovery', async () => {
    getLiveState.mockImplementation(async () =>
      liveState(1, false, '2026-08-17T00:00:01.000Z'),
    );
    await renderProbe();
    const catalogRequests = listSessions.mock.calls.length;
    const store = getSessionCatalogStore(client);

    getLiveState.mockRejectedValueOnce(new Error('offline'));
    act(() => controller.turnCompleted('/work', 'session-a'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The failed request settles nothing; the completion waits out the
    // error backoff.
    expect(
      store.snapshotSessionActivity('/work')?.get('session-a'),
    ).toBeDefined();

    getLiveState.mockImplementation(async () =>
      liveState(1, false, '2026-08-17T00:00:06.000Z'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        SESSION_LIVE_STATE_ERROR_RETRY_MS + SESSION_LIVE_STATE_POLL_MS,
      );
    });
    expect(store.snapshotSessionActivity('/work')).toBeUndefined();
    expect(store.getSnapshot(query).page?.sessions[0]?.updatedAt).toBe(
      '2026-08-17T00:00:06.000Z',
    );
    expect(listSessions).toHaveBeenCalledTimes(catalogRequests);
  });

  it('does not schedule a second catalog scan after a local session creation', async () => {
    await renderProbe();
    const initialCatalogRequests = listSessions.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS / 2);
    });

    act(() => controller.sessionCreated('/work', 'session-b'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS / 2);
    });
    expect(listSessions).toHaveBeenCalledTimes(initialCatalogRequests + 1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });
    expect(listSessions).toHaveBeenCalledTimes(initialCatalogRequests + 1);
  });

  it('reconciles a newly selected source through the live-state handshake', async () => {
    await renderProbe();
    expect(listSessions).toHaveBeenCalledTimes(1);

    // The new source subscription raises an interactive refresh request,
    // which wakes the loop immediately rather than waiting for a tick.
    await renderProbe(false, 'channel');
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenLastCalledWith(
      '/work',
      expect.objectContaining({ sourceType: 'channel' }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });

    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it('uses one trailing reconciliation for an A/B mismatch and publishes only the stable groups', async () => {
    const states = [liveState(1), liveState(2), liveState(2)];
    getLiveState.mockImplementation(async () => states.shift() ?? liveState(2));
    listGroups
      .mockResolvedValueOnce({
        groups: [{ id: 'old', name: 'Old', color: 'red' }],
        colorOptions: ['red'],
      })
      .mockResolvedValueOnce({
        groups: [{ id: 'new', name: 'New', color: 'blue' }],
        colorOptions: ['blue'],
      });

    await renderProbe(true);

    expect(getLiveState).toHaveBeenCalledTimes(3);
    expect(listGroups).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('false:false:New');
  });

  it('rate-limits full reconciliation during sustained catalog churn', async () => {
    let revision = 1;
    let churning = false;
    getLiveState.mockImplementation(async () =>
      liveState(churning ? ++revision : revision),
    );
    await renderProbe();
    const initialCatalogRequests = listSessions.mock.calls.length;

    churning = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        SESSION_LIVE_STATE_RECONCILE_COOLDOWN_MS,
      );
    });
    expect(listSessions).toHaveBeenCalledTimes(initialCatalogRequests + 2);
    const catalogRequestsAfterTrailingReload = listSessions.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        SESSION_LIVE_STATE_RECONCILE_COOLDOWN_MS - SESSION_LIVE_STATE_POLL_MS,
      );
    });
    expect(listSessions).toHaveBeenCalledTimes(
      catalogRequestsAfterTrailingReload,
    );
  });

  it('restores the cooldown after an explicit refresh meets sustained churn', async () => {
    let revision = 1;
    let churning = false;
    getLiveState.mockImplementation(async () =>
      liveState(churning ? ++revision : revision),
    );
    await renderProbe();
    const initialCatalogRequests = listSessions.mock.calls.length;

    churning = true;
    act(() => controller.invalidateWorkspace('/work'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });
    expect(listSessions).toHaveBeenCalledTimes(initialCatalogRequests + 2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });
    expect(listSessions).toHaveBeenCalledTimes(initialCatalogRequests + 2);
  });

  it('backs off after a live-state failure without dropping the catalog', async () => {
    getLiveState.mockRejectedValueOnce(new Error('offline'));
    await renderProbe();
    expect(container.textContent).toBe('false:undefined:no-group');
    expect(getLiveState).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        SESSION_LIVE_STATE_ERROR_RETRY_MS - SESSION_LIVE_STATE_POLL_MS,
      );
    });
    expect(getLiveState).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });
    expect(getLiveState.mock.calls.length).toBeGreaterThan(1);
    expect(container.textContent).toBe('false:false:no-group');
  });

  it('lets an explicit refresh bypass live-state error backoff', async () => {
    await renderProbe();
    getLiveState.mockRejectedValueOnce(new Error('offline'));

    act(() => controller.refreshWorkspace('/work'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getLiveState).toHaveBeenCalledTimes(3);
    expect(listSessions).toHaveBeenCalledTimes(1);

    act(() => controller.refreshWorkspace('/work'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getLiveState).toHaveBeenCalledTimes(5);
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it('keeps internal fresh loads behind live-state error backoff', async () => {
    getLiveState.mockRejectedValueOnce(new Error('offline'));
    await renderProbe();
    const liveRequests = getLiveState.mock.calls.length;
    const catalogRequests = listSessions.mock.calls.length;

    act(() => {
      void getSessionCatalogStore(client)
        .refresh(query)
        .catch(() => undefined);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getLiveState).toHaveBeenCalledTimes(liveRequests);
    expect(listSessions).toHaveBeenCalledTimes(catalogRequests);
  });

  it('preserves an explicit refresh while a live-state request is in flight', async () => {
    await renderProbe();
    let rejectInFlight!: (error: Error) => void;
    getLiveState.mockImplementationOnce(
      () =>
        new Promise<DaemonWorkspaceSessionLiveState>((_resolve, reject) => {
          rejectInFlight = reject;
        }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });

    act(() => controller.refreshWorkspace('/work'));
    await act(async () => {
      rejectInFlight(new Error('offline'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getLiveState).toHaveBeenCalledTimes(5);
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it('lets an explicit refresh bypass reconciliation error backoff', async () => {
    await renderProbe();
    listSessions.mockRejectedValueOnce(new Error('catalog offline'));

    act(() => controller.refreshWorkspace('/work'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listSessions).toHaveBeenCalledTimes(2);

    act(() => controller.refreshWorkspace('/work'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getLiveState).toHaveBeenCalledTimes(5);
    expect(listSessions).toHaveBeenCalledTimes(3);
  });

  it('keeps internal fresh loads behind reconciliation error backoff', async () => {
    await renderProbe();
    listSessions.mockRejectedValueOnce(new Error('catalog offline'));

    act(() => controller.refreshWorkspace('/work'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const catalogRequests = listSessions.mock.calls.length;

    act(() => {
      void getSessionCatalogStore(client)
        .refresh(query)
        .catch(() => undefined);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listSessions).toHaveBeenCalledTimes(catalogRequests);
  });

  it('preserves an explicit refresh during an in-flight live request', async () => {
    await renderProbe();
    listSessions.mockRejectedValueOnce(new Error('catalog offline'));
    act(() => controller.refreshWorkspace('/work'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const catalogRequests = listSessions.mock.calls.length;

    let resolveInFlight!: (value: DaemonWorkspaceSessionLiveState) => void;
    getLiveState.mockImplementationOnce(
      () =>
        new Promise<DaemonWorkspaceSessionLiveState>((resolve) => {
          resolveInFlight = resolve;
        }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });
    act(() => controller.refreshWorkspace('/work'));
    await act(async () => {
      resolveInFlight(liveState(1));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listSessions).toHaveBeenCalledTimes(catalogRequests + 1);
  });

  it('keeps polling volatile state while catalog reconciliation is backed off', async () => {
    let revision = 1;
    let active = false;
    getLiveState.mockImplementation(async () => liveState(revision, active));
    listGroups
      .mockResolvedValueOnce({ groups: [], colorOptions: [] })
      .mockRejectedValue(new Error('groups unavailable'));
    await renderProbe(true);
    revision = 2;
    active = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        SESSION_LIVE_STATE_RECONCILE_COOLDOWN_MS,
      );
    });
    const catalogRequestsAfterFailure = listSessions.mock.calls.length;
    expect(listGroups).toHaveBeenCalledTimes(2);
    const liveRequestsAfterFailure = getLiveState.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });

    expect(getLiveState.mock.calls.length).toBeGreaterThan(
      liveRequestsAfterFailure,
    );
    expect(listGroups).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenCalledTimes(catalogRequestsAfterFailure);
    expect(container.textContent).toBe('true:true:no-group');
  });

  it('retries the initial catalog fallback until it commits', async () => {
    getLiveState.mockRejectedValue(new Error('live down'));
    listSessions.mockRejectedValueOnce(new Error('catalog blip'));
    await renderProbe();
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('undefined:undefined:no-group');

    // The failed fallback must not consume the one-shot latch: the next
    // live-state failure cycle retries it and the catalog renders.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        SESSION_LIVE_STATE_ERROR_RETRY_MS + SESSION_LIVE_STATE_POLL_MS,
      );
    });
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('false:undefined:no-group');
  });

  it('rate-limits sustained lifecycle invalidations to one reconcile per window', async () => {
    await renderProbe();
    const initialCatalogRequests = listSessions.mock.calls.length;

    // A single local change still reconciles immediately.
    act(() => controller.sessionCreated('/work', 'session-b'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS);
    });
    expect(listSessions).toHaveBeenCalledTimes(initialCatalogRequests + 1);

    // Sustained invalidations inside the cooldown window coalesce instead
    // of one full catalog rescan per event.
    act(() => {
      controller.sessionCreated('/work', 'session-c');
      controller.renamed('/work', 'session-b', 'Renamed');
      controller.promptAdmissionUncertain('/work');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS * 3);
    });
    expect(listSessions).toHaveBeenCalledTimes(initialCatalogRequests + 1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        SESSION_LIVE_STATE_RECONCILE_COOLDOWN_MS,
      );
    });
    expect(listSessions).toHaveBeenCalledTimes(initialCatalogRequests + 2);
  });

  it('reconciles when the catalog generation changes at the same revision', async () => {
    await renderProbe();
    expect(listSessions).toHaveBeenCalledTimes(1);

    getLiveState.mockImplementation(async () => ({
      ...liveState(1),
      catalogVersion: { generation: 'generation-b', revision: 1 },
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        SESSION_LIVE_STATE_RECONCILE_COOLDOWN_MS,
      );
    });
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it('pauses polling while hidden and polls immediately on visibility return', async () => {
    await renderProbe();
    const liveCallsAfterMount = getLiveState.mock.calls.length;

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS * 3);
    });
    expect(getLiveState).toHaveBeenCalledTimes(liveCallsAfterMount);

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getLiveState.mock.calls.length).toBeGreaterThan(liveCallsAfterMount);
  });

  it('applies the promptAdmitted optimistic patch immediately in live mode', async () => {
    await renderProbe();
    expect(container.textContent).toBe('false:false:no-group');

    // The optimistic patch must apply synchronously — the sidebar's active
    // indicator cannot wait for the next live-state poll.
    act(() => controller.promptAdmitted('/work', 'session-a'));
    expect(container.textContent).toBe('true:false:no-group');
  });

  it('does not hot-loop when a staged commit is persistently refused', async () => {
    await renderProbe();
    const initialCatalogRequests = listSessions.mock.calls.length;

    // Every staged fetch bumps the revision mid-flight, so every commit
    // misses its fence. The give-up path must clear the request flags —
    // otherwise an interactive refresh spins a full reconcile every tick.
    listSessions.mockImplementation(async () => {
      controller.invalidateWorkspace('/work');
      return sessionPage();
    });
    act(() => controller.refreshQueries([query]));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const callsAfterGiveUp = listSessions.mock.calls.length;
    expect(callsAfterGiveUp).toBeGreaterThan(initialCatalogRequests);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS * 4);
    });
    // One invalidation-gated retry per cooldown window at most — without
    // the fix every 2s tick re-runs two catalog fetches.
    expect(listSessions.mock.calls.length).toBeLessThanOrEqual(
      callsAfterGiveUp + 2,
    );
  });

  it('stays inert when disabled', async () => {
    function DisabledProbe() {
      useWorkspaceSessionLiveState(client, {
        enabled: false,
        workspaceCwds: ['/work'],
        groupWorkspaceCwds: [],
      });
      return null;
    }
    await act(async () => {
      root.render(<DisabledProbe />);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_LIVE_STATE_POLL_MS * 3);
    });
    expect(getLiveState).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
  });
});
