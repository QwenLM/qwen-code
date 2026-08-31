// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonClient,
  DaemonSessionListPage,
} from '@qwen-code/sdk/daemon';
import {
  SESSION_CATALOG_RETENTION_MS,
  SessionCatalogStore,
  getSessionCatalogQueryKey,
  type SessionCatalogQuery,
} from './session-catalog-store';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function page(
  sessionId: string,
  workspaceCwd = '/work',
): DaemonSessionListPage {
  return {
    sessions: [{ sessionId, workspaceCwd }],
    nextCursor: 'next',
    liveMergeFailed: true,
    truncated: true,
  };
}

function query(
  workspaceCwd: string,
  routeKind: SessionCatalogQuery['routeKind'] = 'legacy',
): SessionCatalogQuery {
  return {
    routeKind,
    workspaceCwd,
    options: { pageSize: 1000, archiveState: 'active' },
  };
}

describe('SessionCatalogStore', () => {
  let legacy: ReturnType<typeof vi.fn>;
  let qualified: ReturnType<typeof vi.fn>;
  let store: SessionCatalogStore;

  beforeEach(() => {
    vi.useFakeTimers();
    legacy = vi.fn();
    qualified = vi.fn();
    const client = {
      listWorkspaceSessionsPage: legacy,
      workspaceByCwd: vi.fn(() => ({
        listWorkspaceSessionsPage: qualified,
      })),
    } as unknown as DaemonClient;
    store = new SessionCatalogStore(client);
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
  });

  it('keys every wire-affecting option and route kind', () => {
    const base = query('/work');
    expect(getSessionCatalogQueryKey(base)).toBe(
      getSessionCatalogQueryKey({ ...base, options: { ...base.options } }),
    );
    expect(getSessionCatalogQueryKey(base)).not.toBe(
      getSessionCatalogQueryKey({ ...base, routeKind: 'qualified' }),
    );
    expect(getSessionCatalogQueryKey(base)).not.toBe(
      getSessionCatalogQueryKey({ ...base, workspaceCwd: '/other' }),
    );
    expect(getSessionCatalogQueryKey(base)).not.toBe(
      getSessionCatalogQueryKey({
        ...base,
        options: { ...base.options, sourceId: 'source' },
      }),
    );
    for (const options of [
      { pageSize: 25 },
      { cursor: 'cursor' },
      { archiveState: 'archived' as const },
      { view: 'organized' as const },
      { group: 'pinned' },
      { parentSessionId: 'parent' },
      { sourceType: 'side-task' },
      { sourceId: 'source' },
    ]) {
      expect(getSessionCatalogQueryKey(base)).not.toBe(
        getSessionCatalogQueryKey({
          ...base,
          options: { ...base.options, ...options },
        }),
      );
    }
  });

  it('shares an automatic request and preserves page metadata', async () => {
    const response = deferred<DaemonSessionListPage>();
    legacy.mockReturnValue(response.promise);
    const target = query('/work');
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = store.subscribe(target, first, { autoLoad: true });
    const unsubscribeSecond = store.subscribe(target, second, {
      autoLoad: true,
    });
    expect(legacy).toHaveBeenCalledTimes(1);

    response.resolve(page('s1'));
    await vi.runAllTimersAsync();
    expect(store.getSnapshot(target).page).toEqual(page('s1'));
    expect(store.getSnapshot(target).stale).toBe(false);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('refreshes an expired retained page for a new automatic subscriber', async () => {
    legacy
      .mockResolvedValueOnce(page('cached'))
      .mockResolvedValueOnce(page('refreshed'));
    const target = query('/work');
    const unsubscribe = store.subscribe(target, vi.fn(), { autoLoad: true });
    await flushMicrotasks();
    unsubscribe();

    const unsubscribeFresh = store.subscribe(target, vi.fn(), {
      autoLoad: true,
      maxAgeMs: 1_000,
    });
    await flushMicrotasks();
    expect(legacy).toHaveBeenCalledTimes(1);
    unsubscribeFresh();

    await vi.advanceTimersByTimeAsync(1_000);
    const unsubscribeAgain = store.subscribe(target, vi.fn(), {
      autoLoad: true,
      maxAgeMs: 1_000,
    });
    await flushMicrotasks();

    expect(legacy).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot(target).page).toEqual(page('refreshed'));
    unsubscribeAgain();
  });

  it('shares an in-flight request between non-fresh command loads', async () => {
    const response = deferred<DaemonSessionListPage>();
    legacy.mockReturnValue(response.promise);
    const target = query('/work');

    const first = store.loadOnce(target);
    const second = store.loadOnce(target);

    expect(legacy).toHaveBeenCalledTimes(1);
    response.resolve(page('shared'));
    await expect(Promise.all([first, second])).resolves.toEqual([
      page('shared'),
      page('shared'),
    ]);
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it('does not attach a command load to an already failed revision', async () => {
    const first = deferred<DaemonSessionListPage>();
    const second = deferred<DaemonSessionListPage>();
    legacy
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const target = query('/work');
    let recovery: Promise<DaemonSessionListPage> | undefined;
    let recoveryStarted = false;
    const unsubscribe = store.subscribe(
      target,
      () => {
        if (store.getSnapshot(target).error && !recoveryStarted) {
          recoveryStarted = true;
          recovery = store.loadOnce(target);
        }
      },
      { autoLoad: true },
    );

    first.reject(new Error('offline'));
    await flushMicrotasks();
    expect(legacy).toHaveBeenCalledTimes(2);

    second.resolve(page('recovered'));
    await expect(recovery).resolves.toEqual(page('recovered'));
    unsubscribe();
  });

  it('reserves one request slot for interactive work', async () => {
    const requests = new Map<string, Deferred<DaemonSessionListPage>>();
    legacy.mockImplementation((cwd: string) => {
      const request = deferred<DaemonSessionListPage>();
      requests.set(cwd, request);
      return request.promise;
    });
    const unsubscribeA = store.subscribe(query('/a'), vi.fn(), {
      autoLoad: true,
    });
    const unsubscribeB = store.subscribe(query('/b'), vi.fn(), {
      autoLoad: true,
    });
    const unsubscribeC = store.subscribe(query('/c'), vi.fn(), {
      autoLoad: true,
    });
    expect(legacy).toHaveBeenCalledTimes(1);

    const interactive = store.loadOnce(query('/interactive'), { fresh: true });
    expect(legacy).toHaveBeenCalledTimes(2);
    expect(legacy).toHaveBeenLastCalledWith('/interactive', expect.any(Object));

    requests.get('/interactive')?.resolve(page('interactive'));
    await interactive;
    expect(legacy).toHaveBeenCalledTimes(2);
    requests.get('/a')?.resolve(page('a'));
    await flushMicrotasks();
    expect(legacy).toHaveBeenCalledTimes(3);
    requests.get('/b')?.resolve(page('b'));
    requests.get('/c')?.resolve(page('c'));
    unsubscribeA();
    unsubscribeB();
    unsubscribeC();
  });

  it('caps total concurrency at two and upgrades an existing queued job', async () => {
    const requests = new Map<string, Deferred<DaemonSessionListPage>>();
    legacy.mockImplementation((cwd: string) => {
      const request = deferred<DaemonSessionListPage>();
      requests.set(cwd, request);
      return request.promise;
    });
    const unsubscribeA = store.subscribe(query('/a'), vi.fn(), {
      autoLoad: true,
    });
    const unsubscribeB = store.subscribe(query('/b'), vi.fn(), {
      autoLoad: true,
    });
    const unsubscribeC = store.subscribe(query('/c'), vi.fn(), {
      autoLoad: true,
    });

    const refreshC = store.refresh(query('/c'));
    expect(legacy.mock.calls.map(([cwd]) => cwd)).toEqual(['/a', '/c']);

    const refreshD = store.refresh(query('/d'));
    expect(legacy).toHaveBeenCalledTimes(2);
    requests.get('/c')?.resolve(page('c'));
    await refreshC;
    await flushMicrotasks();
    expect(legacy.mock.calls.map(([cwd]) => cwd)).toEqual(['/a', '/c', '/d']);

    requests.get('/d')?.resolve(page('d'));
    await refreshD;
    expect(legacy).toHaveBeenCalledTimes(3);
    requests.get('/a')?.resolve(page('a'));
    await flushMicrotasks();
    expect(legacy.mock.calls.map(([cwd]) => cwd)).toEqual([
      '/a',
      '/c',
      '/d',
      '/b',
    ]);
    requests.get('/b')?.resolve(page('b'));
    await flushMicrotasks();
    unsubscribeA();
    unsubscribeB();
    unsubscribeC();
  });

  it('upgrades a queued poll when the query gains an initial-load subscriber', async () => {
    const requests = new Map<string, Deferred<DaemonSessionListPage>>();
    legacy.mockImplementation((cwd: string) => {
      const request = deferred<DaemonSessionListPage>();
      requests.set(cwd, request);
      return request.promise;
    });
    const unsubscribeBlocker = store.subscribe(query('/blocker'), vi.fn(), {
      autoLoad: true,
    });
    const target = query('/poll');
    const unsubscribePoll = store.subscribe(target, vi.fn(), {
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);
    const unsubscribeInitial = store.subscribe(query('/initial'), vi.fn(), {
      autoLoad: true,
    });
    const unsubscribeTargetLoad = store.subscribe(target, vi.fn(), {
      autoLoad: true,
    });

    requests.get('/blocker')?.resolve(page('blocker'));
    await flushMicrotasks();
    expect(legacy.mock.calls.map(([cwd]) => cwd)).toEqual([
      '/blocker',
      '/poll',
    ]);

    requests.get('/poll')?.resolve(page('poll'));
    await flushMicrotasks();
    requests.get('/initial')?.resolve(page('initial'));
    await flushMicrotasks();
    unsubscribeTargetLoad();
    unsubscribeInitial();
    unsubscribePoll();
    unsubscribeBlocker();
  });

  it('discards an in-flight response invalidated by a fresh reload', async () => {
    const first = deferred<DaemonSessionListPage>();
    const second = deferred<DaemonSessionListPage>();
    legacy
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const target = query('/work');
    const unsubscribe = store.subscribe(target, vi.fn(), { autoLoad: true });
    const reload = store.refresh(target);

    first.resolve(page('stale'));
    await flushMicrotasks();
    expect(legacy).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot(target).page).toBeUndefined();

    second.resolve(page('fresh'));
    await expect(reload).resolves.toEqual(page('fresh'));
    expect(store.getSnapshot(target).page?.sessions[0]?.sessionId).toBe(
      'fresh',
    );
    unsubscribe();
  });

  it('finishes an unobserved fresh load after an in-flight invalidation', async () => {
    const first = deferred<DaemonSessionListPage>();
    const second = deferred<DaemonSessionListPage>();
    legacy
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const target = query('/work');
    const load = store.loadOnce(target, { fresh: true });

    store.invalidateWorkspace('/work', { background: true });
    first.resolve(page('stale'));
    await flushMicrotasks();

    expect(legacy).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot(target).page).toBeUndefined();

    second.resolve(page('fresh'));
    await expect(load).resolves.toEqual(page('fresh'));
  });

  it('coalesces poll ticks while a request is in flight', async () => {
    const response = deferred<DaemonSessionListPage>();
    legacy.mockReturnValue(response.promise);
    const target = query('/work');
    const unsubscribe = store.subscribe(target, vi.fn(), {
      autoLoad: true,
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(legacy).toHaveBeenCalledTimes(1);
    response.resolve(page('done'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(99);
    expect(legacy).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('uses the shortest subscriber poll interval', async () => {
    legacy.mockResolvedValue(page('polled'));
    const target = query('/work');
    const unsubscribeSlow = store.subscribe(target, vi.fn(), {
      autoLoad: true,
      pollIntervalMs: 300,
    });
    const unsubscribeFast = store.subscribe(target, vi.fn(), {
      pollIntervalMs: 100,
    });
    await flushMicrotasks();
    legacy.mockClear();

    await vi.advanceTimersByTimeAsync(99);
    expect(legacy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(legacy).toHaveBeenCalledTimes(1);
    unsubscribeFast();
    unsubscribeSlow();
  });

  it('retains stale data on error, backs off automatic retries, and lets manual refresh bypass backoff', async () => {
    legacy.mockResolvedValueOnce(page('cached'));
    const target = query('/work');
    await store.loadOnce(target, { fresh: true });
    const unsubscribe = store.subscribe(target, vi.fn(), { autoLoad: true });

    legacy.mockRejectedValueOnce(new Error('offline'));
    await expect(store.refresh(target)).rejects.toThrow('offline');
    expect(store.getSnapshot(target)).toMatchObject({
      page: page('cached'),
      stale: true,
      error: expect.objectContaining({ message: 'offline' }),
    });

    legacy.mockResolvedValueOnce(page('manual'));
    await expect(store.refresh(target)).resolves.toEqual(page('manual'));
    expect(legacy).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it('waits thirty seconds before retrying a failed automatic load', async () => {
    legacy
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page('retried'));
    const unsubscribe = store.subscribe(query('/work'), vi.fn(), {
      autoLoad: true,
    });
    await flushMicrotasks();
    expect(legacy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(legacy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(legacy).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('preserves an automatic retry when a query resubscribes during backoff', async () => {
    legacy
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page('retried'));
    const target = query('/work');
    const unsubscribeFirst = store.subscribe(target, vi.fn(), {
      autoLoad: true,
    });
    await flushMicrotasks();
    const unsubscribeSecond = store.subscribe(target, vi.fn(), {
      autoLoad: true,
    });
    unsubscribeFirst();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(legacy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(legacy).toHaveBeenCalledTimes(2);

    unsubscribeSecond();
  });

  it('patches only the owning workspace without changing page metadata', async () => {
    legacy.mockImplementation(async (cwd: string) => page(cwd, cwd));
    await store.loadOnce(query('/a'), { fresh: true });
    await store.loadOnce(query('/b'), { fresh: true });

    store.patchSession('/a', '/a', {
      displayName: 'Renamed',
      hasActivePrompt: true,
    });

    const patched = store.getSnapshot(query('/a')).page;
    expect(patched?.sessions[0]).toMatchObject({
      displayName: 'Renamed',
      hasActivePrompt: true,
    });
    expect(patched?.nextCursor).toBe('next');
    expect(store.getSnapshot(query('/b')).page?.sessions[0]?.displayName).toBe(
      undefined,
    );
  });

  it('removes a session only from pages matching the archive-state filter', async () => {
    const activeQuery: SessionCatalogQuery = {
      routeKind: 'legacy',
      workspaceCwd: '/w',
      options: { archiveState: 'active' },
    };
    const archivedQuery: SessionCatalogQuery = {
      routeKind: 'legacy',
      workspaceCwd: '/w',
      options: { archiveState: 'archived' },
    };
    legacy.mockImplementation(
      async (
        _cwd: string,
        options: { archiveState?: string } | undefined,
      ): Promise<DaemonSessionListPage> =>
        options?.archiveState === 'archived'
          ? {
              sessions: [{ sessionId: 'archived-only', workspaceCwd: '/w' }],
              nextCursor: undefined,
            }
          : {
              sessions: [
                { sessionId: 'keep', workspaceCwd: '/w' },
                { sessionId: 'drop', workspaceCwd: '/w' },
              ],
              nextCursor: 'next',
            },
    );
    await store.loadOnce(activeQuery, { fresh: true });
    await store.loadOnce(archivedQuery, { fresh: true });

    store.removeSession('/w', 'drop', { archiveStates: ['active'] });

    const active = store.getSnapshot(activeQuery).page;
    expect(active?.sessions.map((session) => session.sessionId)).toEqual([
      'keep',
    ]);
    expect(active?.nextCursor).toBe('next');
    expect(
      store
        .getSnapshot(archivedQuery)
        .page?.sessions.map((session) => session.sessionId),
    ).toEqual(['archived-only']);
  });

  it('seeds a session into destination pages without touching pinned pages', async () => {
    const listQuery: SessionCatalogQuery = {
      routeKind: 'legacy',
      workspaceCwd: '/w',
      options: { archiveState: 'active', view: 'organized', group: 'all' },
    };
    const archivedQuery: SessionCatalogQuery = {
      routeKind: 'legacy',
      workspaceCwd: '/w',
      options: { archiveState: 'archived', view: 'organized', group: 'all' },
    };
    const pinnedQuery: SessionCatalogQuery = {
      routeKind: 'legacy',
      workspaceCwd: '/w',
      options: { archiveState: 'active', view: 'organized', group: 'pinned' },
    };
    legacy.mockImplementation(
      async (
        _cwd: string,
        options: { archiveState?: string; group?: string } | undefined,
      ): Promise<DaemonSessionListPage> => ({
        sessions: [
          {
            sessionId:
              options?.group === 'pinned'
                ? 'already-pinned'
                : options?.archiveState === 'archived'
                  ? 'old'
                  : 'live',
            workspaceCwd: '/w',
            ...(options?.group === 'pinned' ? { isPinned: true } : {}),
          },
        ],
        nextCursor: undefined,
      }),
    );
    await store.loadOnce(listQuery, { fresh: true });
    await store.loadOnce(archivedQuery, { fresh: true });
    await store.loadOnce(pinnedQuery, { fresh: true });

    store.addSession(
      '/w',
      { sessionId: 'restored', workspaceCwd: '/w', isArchived: false },
      { archiveStates: ['active'] },
    );

    expect(
      store
        .getSnapshot(listQuery)
        .page?.sessions.map((session) => session.sessionId),
    ).toEqual(['live', 'restored']);
    expect(
      store
        .getSnapshot(archivedQuery)
        .page?.sessions.map((session) => session.sessionId),
    ).toEqual(['old']);
    // A non-pinned row never belongs to the pinned section.
    expect(
      store
        .getSnapshot(pinnedQuery)
        .page?.sessions.map((session) => session.sessionId),
    ).toEqual(['already-pinned']);

    // A second seed must not duplicate the row.
    store.addSession(
      '/w',
      { sessionId: 'restored', workspaceCwd: '/w', isArchived: false },
      { archiveStates: ['active'] },
    );
    expect(
      store
        .getSnapshot(listQuery)
        .page?.sessions.filter((session) => session.sessionId === 'restored'),
    ).toHaveLength(1);
  });

  it('reseeds a restored pinned session into pinned pages', async () => {
    const listQuery: SessionCatalogQuery = {
      routeKind: 'legacy',
      workspaceCwd: '/w',
      options: { archiveState: 'active', view: 'organized', group: 'all' },
    };
    const pinnedQuery: SessionCatalogQuery = {
      routeKind: 'legacy',
      workspaceCwd: '/w',
      options: { archiveState: 'active', view: 'organized', group: 'pinned' },
    };
    const archivedQuery: SessionCatalogQuery = {
      routeKind: 'legacy',
      workspaceCwd: '/w',
      options: { archiveState: 'archived', view: 'organized', group: 'all' },
    };
    legacy.mockImplementation(
      async (
        _cwd: string,
        options: { archiveState?: string; group?: string } | undefined,
      ): Promise<DaemonSessionListPage> => ({
        sessions: [
          {
            sessionId: options?.group === 'pinned' ? 'other-pin' : 'live',
            workspaceCwd: '/w',
            ...(options?.group === 'pinned' ? { isPinned: true } : {}),
          },
        ],
        nextCursor: undefined,
      }),
    );
    await store.loadOnce(listQuery, { fresh: true });
    await store.loadOnce(pinnedQuery, { fresh: true });
    await store.loadOnce(archivedQuery, { fresh: true });

    // Pin survives the archive move on the daemon side, so the restored
    // row carries isPinned and must reappear in the pinned section too —
    // otherwise it is absent from every section until the refetch lands.
    store.removeSession('/w', 'pinned-back', { archiveStates: ['archived'] });
    store.addSession(
      '/w',
      {
        sessionId: 'pinned-back',
        workspaceCwd: '/w',
        isArchived: false,
        isPinned: true,
        pinnedAt: '2026-01-02T03:04:05.000Z',
      },
      { archiveStates: ['active'] },
    );

    expect(
      store
        .getSnapshot(listQuery)
        .page?.sessions.map((session) => session.sessionId),
    ).toEqual(['live', 'pinned-back']);
    expect(
      store
        .getSnapshot(pinnedQuery)
        .page?.sessions.map((session) => session.sessionId),
    ).toEqual(['other-pin', 'pinned-back']);
    expect(
      store
        .getSnapshot(archivedQuery)
        .page?.sessions.map((session) => session.sessionId),
    ).toEqual(['live']);
  });

  it('invalidates only catalog entries matching the requested archive states', async () => {
    const activeQuery: SessionCatalogQuery = {
      routeKind: 'legacy',
      workspaceCwd: '/w',
      options: { archiveState: 'active' },
    };
    const archivedQuery: SessionCatalogQuery = {
      routeKind: 'legacy',
      workspaceCwd: '/w',
      options: { archiveState: 'archived' },
    };
    legacy.mockImplementation(
      async (
        cwd: string,
        options: { archiveState?: string } | undefined,
      ): Promise<DaemonSessionListPage> => ({
        sessions: [
          {
            sessionId: options?.archiveState === 'archived' ? 'a' : 's',
            workspaceCwd: cwd,
          },
        ],
        nextCursor: undefined,
      }),
    );
    const unsubscribeActive = store.subscribe(activeQuery, vi.fn(), {
      autoLoad: true,
    });
    const unsubscribeArchived = store.subscribe(archivedQuery, vi.fn(), {
      autoLoad: true,
    });
    await flushMicrotasks();
    expect(legacy).toHaveBeenCalledTimes(2);

    store.invalidateSessionLists('/w', ['active']);

    // Invalidation marks matching entries stale synchronously; the archived
    // entry must be untouched.
    expect(store.getSnapshot(activeQuery).stale).toBe(true);
    expect(store.getSnapshot(archivedQuery).stale).toBe(false);

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(legacy).toHaveBeenCalledTimes(3);

    unsubscribeActive();
    unsubscribeArchived();
  });

  describe('applySessionPinToggle', () => {
    const pinnedView = (workspaceCwd: string): SessionCatalogQuery => ({
      routeKind: 'legacy',
      workspaceCwd,
      options: {
        pageSize: 1000,
        archiveState: 'active',
        view: 'organized',
        group: 'pinned',
      },
    });

    it('pins across loaded pages and leaves unloaded or foreign pages alone', async () => {
      const row = { sessionId: 'plain', workspaceCwd: '/work' };
      const existingPin = {
        sessionId: 'other',
        workspaceCwd: '/work',
        isPinned: true,
        pinnedAt: '2026-01-01T00:00:00.000Z',
      };
      legacy.mockImplementation(async (cwd: string) => ({
        sessions:
          cwd === '/work'
            ? [row]
            : [{ sessionId: 'foreign', workspaceCwd: cwd }],
      }));
      await store.loadOnce(query('/work'), { fresh: true });
      await store.loadOnce(query('/other'), { fresh: true });
      // The pinned-view page stays unloaded for /work: no entry may be
      // invented for it.
      await store.loadOnce(pinnedView('/other'), { fresh: true });
      legacy.mockImplementation(async () => ({ sessions: [existingPin] }));

      store.applySessionPinToggle(
        '/work',
        { ...row },
        {
          pinned: true,
          pinnedAt: '2026-02-02T00:00:00.000Z',
        },
      );

      expect(store.getSnapshot(query('/work')).page?.sessions[0]).toMatchObject(
        {
          isPinned: true,
          pinnedAt: '2026-02-02T00:00:00.000Z',
        },
      );
      expect(
        store.getSnapshot(query('/other')).page?.sessions[0],
      ).toMatchObject({ sessionId: 'foreign' });
      expect(store.getSnapshot(pinnedView('/work')).page).toBeUndefined();
    });

    it('inserts the row into a loaded pinned-view page and patches it in place when already present', async () => {
      const row = { sessionId: 'plain', workspaceCwd: '/work' };
      const existingPin = {
        sessionId: 'other',
        workspaceCwd: '/work',
        isPinned: true,
        pinnedAt: '2026-01-01T00:00:00.000Z',
      };
      legacy.mockImplementation(
        async (_cwd: string, options: { group?: string }) =>
          options?.group === 'pinned'
            ? { sessions: [existingPin] }
            : { sessions: [row] },
      );
      await store.loadOnce(query('/work'), { fresh: true });
      await store.loadOnce(pinnedView('/work'), { fresh: true });

      store.applySessionPinToggle(
        '/work',
        { ...row },
        {
          pinned: true,
          pinnedAt: '2026-02-02T00:00:00.000Z',
        },
      );

      expect(store.getSnapshot(pinnedView('/work')).page?.sessions).toEqual([
        existingPin,
        {
          ...row,
          isPinned: true,
          pinnedAt: '2026-02-02T00:00:00.000Z',
        },
      ]);

      // Re-pin patches the existing row instead of duplicating it.
      store.applySessionPinToggle(
        '/work',
        { ...row },
        {
          pinned: true,
          pinnedAt: '2026-03-03T00:00:00.000Z',
        },
      );
      expect(
        store.getSnapshot(pinnedView('/work')).page?.sessions,
      ).toHaveLength(2);
    });

    it('unpins by removing the row from the pinned page and clearing pinnedAt elsewhere', async () => {
      const row = {
        sessionId: 'plain',
        workspaceCwd: '/work',
        isPinned: true,
        pinnedAt: '2026-01-01T00:00:00.000Z',
      };
      legacy.mockImplementation(
        async (_cwd: string, options: { group?: string }) =>
          options?.group === 'pinned'
            ? { sessions: [row] }
            : { sessions: [row] },
      );
      await store.loadOnce(query('/work'), { fresh: true });
      await store.loadOnce(pinnedView('/work'), { fresh: true });

      store.applySessionPinToggle('/work', { ...row }, { pinned: false });

      expect(store.getSnapshot(pinnedView('/work')).page?.sessions).toEqual([]);
      const patched = store.getSnapshot(query('/work')).page?.sessions[0];
      expect(patched?.isPinned).toBe(false);
      expect(patched?.pinnedAt).toBeUndefined();
    });

    it('survives unrelated patchSession churn after the toggle (R5-1)', async () => {
      const row = { sessionId: 'plain', workspaceCwd: '/work' };
      const sibling = {
        sessionId: 'sibling',
        workspaceCwd: '/work',
        isPinned: true,
        pinnedAt: '2026-01-01T00:00:00.000Z',
      };
      legacy.mockImplementation(
        async (_cwd: string, options: { group?: string }) =>
          options?.group === 'pinned'
            ? { sessions: [sibling] }
            : { sessions: [row, sibling] },
      );
      await store.loadOnce(query('/work'), { fresh: true });
      await store.loadOnce(pinnedView('/work'), { fresh: true });

      store.applySessionPinToggle(
        '/work',
        { ...row },
        {
          pinned: true,
          pinnedAt: '2026-02-02T00:00:00.000Z',
        },
      );
      // Churn that never touches pin state: a rename of another session and
      // a live-state tick both mint fresh page references.
      store.patchSession('/work', 'sibling', { displayName: 'Renamed' });
      store.applyLiveState('/work', [
        {
          sessionId: 'sibling',
          clientCount: 1,
          hasActivePrompt: true,
          isWaitingForPermission: false,
          isWaitingForUserQuestion: false,
          updatedAt: '2026-02-03T00:00:00.000Z',
        },
      ]);

      expect(
        store
          .getSnapshot(pinnedView('/work'))
          .page?.sessions.map((session) => session.sessionId),
      ).toEqual(['sibling', 'plain']);
      // The all-sessions page keeps activity order; the toggled row must
      // still carry the pin state after the churn.
      expect(
        store
          .getSnapshot(query('/work'))
          .page?.sessions.find((session) => session.sessionId === 'plain'),
      ).toMatchObject({
        isPinned: true,
        pinnedAt: '2026-02-02T00:00:00.000Z',
      });
    });
  });

  it('overlays live state and clears volatile fields for persisted-only sessions', async () => {
    legacy.mockResolvedValue({
      sessions: [
        {
          sessionId: 'live',
          workspaceCwd: '/work',
          displayName: 'Live session',
          clientCount: 0,
          hasActivePrompt: false,
        },
        {
          sessionId: 'persisted',
          workspaceCwd: '/work',
          displayName: 'Persisted session',
          clientCount: 2,
          hasActivePrompt: true,
          isWaitingForPermission: true,
          isWaitingForUserQuestion: true,
        },
      ],
    });
    const target = query('/work');
    await store.loadOnce(target, { fresh: true });

    store.applyLiveState('/work', [
      {
        sessionId: 'live',
        clientCount: 1,
        hasActivePrompt: true,
        isWaitingForPermission: true,
        isWaitingForUserQuestion: false,
      },
    ]);

    expect(store.getSnapshot(target).page?.sessions).toEqual([
      expect.objectContaining({
        sessionId: 'live',
        displayName: 'Live session',
        clientCount: 1,
        hasActivePrompt: true,
        isWaitingForPermission: true,
        isWaitingForUserQuestion: false,
      }),
      expect.objectContaining({
        sessionId: 'persisted',
        displayName: 'Persisted session',
        clientCount: 0,
        hasActivePrompt: false,
        isWaitingForPermission: false,
        isWaitingForUserQuestion: false,
      }),
    ]);
  });

  it('stamps a fresher live watermark and reorders the active page', async () => {
    legacy.mockResolvedValue({
      sessions: [
        {
          sessionId: 'b',
          workspaceCwd: '/work',
          updatedAt: '2026-08-17T00:00:02.000Z',
        },
        {
          sessionId: 'a',
          workspaceCwd: '/work',
          updatedAt: '2026-08-17T00:00:01.000Z',
        },
      ],
    });
    const target = query('/work');
    await store.loadOnce(target, { fresh: true });

    store.applyLiveState('/work', [
      {
        sessionId: 'a',
        clientCount: 1,
        hasActivePrompt: false,
        isWaitingForPermission: false,
        isWaitingForUserQuestion: false,
        updatedAt: '2026-08-17T00:00:03.000Z',
      },
    ]);

    expect(
      store.getSnapshot(target).page?.sessions.map((session) => ({
        sessionId: session.sessionId,
        updatedAt: session.updatedAt,
      })),
    ).toEqual([
      { sessionId: 'a', updatedAt: '2026-08-17T00:00:03.000Z' },
      { sessionId: 'b', updatedAt: '2026-08-17T00:00:02.000Z' },
    ]);
  });

  it('ignores stale, invalid, or archived-row watermarks', async () => {
    legacy.mockResolvedValue({
      sessions: [
        {
          sessionId: 'a',
          workspaceCwd: '/work',
          updatedAt: '2026-08-17T00:00:02.000Z',
        },
        {
          sessionId: 'gone',
          workspaceCwd: '/work',
          isArchived: true,
          updatedAt: '2026-08-17T00:00:01.000Z',
        },
      ],
    });
    const target = query('/work');
    await store.loadOnce(target, { fresh: true });

    const volatileState = {
      clientCount: 0,
      hasActivePrompt: false,
      isWaitingForPermission: false,
      isWaitingForUserQuestion: false,
    };
    // Each case applies separately — live-state rows are indexed by session
    // id, so batching duplicate ids would drop all but the last entry.
    // Stale and unparsable stamps must not regress or corrupt the row.
    store.applyLiveState('/work', [
      {
        sessionId: 'a',
        ...volatileState,
        updatedAt: '2026-08-17T00:00:01.000Z',
      },
    ]);
    store.applyLiveState('/work', [
      { sessionId: 'a', ...volatileState, updatedAt: 'not-a-timestamp' },
    ]);
    // An archived row never accepts a live activity stamp.
    store.applyLiveState('/work', [
      {
        sessionId: 'gone',
        ...volatileState,
        updatedAt: '2026-08-17T00:00:09.000Z',
      },
    ]);

    expect(
      store.getSnapshot(target).page?.sessions.map((session) => ({
        sessionId: session.sessionId,
        updatedAt: session.updatedAt,
      })),
    ).toEqual([
      { sessionId: 'a', updatedAt: '2026-08-17T00:00:02.000Z' },
      { sessionId: 'gone', updatedAt: '2026-08-17T00:00:01.000Z' },
    ]);
  });

  it('never stamps archived or cursored pages', async () => {
    legacy.mockResolvedValue({
      sessions: [
        {
          sessionId: 'a',
          workspaceCwd: '/work',
          updatedAt: '2026-08-17T00:00:01.000Z',
        },
      ],
    });
    const archived = {
      ...query('/work'),
      options: { pageSize: 1000, archiveState: 'archived' as const },
    };
    const cursored = {
      ...query('/work'),
      options: { ...query('/work').options, cursor: 'cursor-1' },
    };
    await store.loadOnce(archived, { fresh: true });
    await store.loadOnce(cursored, { fresh: true });

    store.applyLiveState('/work', [
      {
        sessionId: 'a',
        clientCount: 3,
        hasActivePrompt: false,
        isWaitingForPermission: false,
        isWaitingForUserQuestion: false,
        updatedAt: '2026-08-17T00:00:09.000Z',
      },
    ]);

    for (const target of [archived, cursored]) {
      const row = store.getSnapshot(target).page?.sessions[0];
      // The volatile overlay still applies; only the activity stamp is
      // rejected outside reorder-owning pages.
      expect(row).toMatchObject({
        sessionId: 'a',
        clientCount: 3,
        updatedAt: '2026-08-17T00:00:01.000Z',
      });
    }
  });

  it('keeps pinned rows ahead when reordering an organized page', async () => {
    legacy.mockResolvedValue({
      sessions: [
        {
          sessionId: 'pinned',
          workspaceCwd: '/work',
          isPinned: true,
          updatedAt: '2026-08-17T00:00:01.000Z',
        },
        {
          sessionId: 'b',
          workspaceCwd: '/work',
          updatedAt: '2026-08-17T00:00:03.000Z',
        },
        {
          sessionId: 'a',
          workspaceCwd: '/work',
          updatedAt: '2026-08-17T00:00:02.000Z',
        },
      ],
    });
    const organized = {
      ...query('/work'),
      options: {
        ...query('/work').options,
        view: 'organized' as const,
        group: 'all',
      },
    };
    await store.loadOnce(organized, { fresh: true });

    store.applyLiveState('/work', [
      {
        sessionId: 'a',
        clientCount: 0,
        hasActivePrompt: false,
        isWaitingForPermission: false,
        isWaitingForUserQuestion: false,
        updatedAt: '2026-08-17T00:00:04.000Z',
      },
    ]);

    expect(
      store
        .getSnapshot(organized)
        .page?.sessions.map((session) => session.sessionId),
    ).toEqual(['pinned', 'a', 'b']);
  });

  it('records, snapshots, and resolves pending session activity', () => {
    const wake = vi.fn();
    const stopWake = store.onLiveStateWake(wake);

    // Without live-state ownership the record is a no-op.
    store.recordSessionActivity('/work', 'a');
    expect(store.snapshotSessionActivity('/work')).toBeUndefined();
    expect(wake).not.toHaveBeenCalled();

    const releaseLiveState = store.retainWorkspaceLiveState('/work');
    store.recordSessionActivity('/work', 'a');
    expect(wake).toHaveBeenCalledWith('/work');
    const first = store.snapshotSessionActivity('/work');
    const firstSequence = first?.get('a');
    expect(firstSequence).toBeDefined();

    // A completion recorded mid-flight bumps the sequence; settling with
    // the stale sequence must keep the newer pending entry.
    store.recordSessionActivity('/work', 'a');
    store.resolveSessionActivity('/work', 'a', firstSequence!);
    const second = store.snapshotSessionActivity('/work');
    expect(second?.get('a')).toBeGreaterThan(firstSequence!);

    store.resolveSessionActivity('/work', 'a', second!.get('a')!);
    expect(store.snapshotSessionActivity('/work')).toBeUndefined();

    // Releasing the last live-state user drops pending completions.
    store.recordSessionActivity('/work', 'b');
    releaseLiveState();
    expect(store.snapshotSessionActivity('/work')).toBeUndefined();
    stopWake();
  });

  it('absorbs watermarks only for rows on reorder-owning pages', async () => {
    legacy.mockImplementation(
      async (_cwd: string, options: { archiveState?: string }) => ({
        sessions:
          options.archiveState === 'archived'
            ? [{ sessionId: 'archived-only', workspaceCwd: '/work' }]
            : [
                { sessionId: 'a', workspaceCwd: '/work' },
                {
                  sessionId: 'row-archived',
                  workspaceCwd: '/work',
                  isArchived: true,
                },
                { sessionId: 'foreign-row', workspaceCwd: '/elsewhere' },
                { sessionId: 'no-watermark', workspaceCwd: '/work' },
              ],
      }),
    );
    await store.loadOnce(query('/work'), { fresh: true });
    await store.loadOnce(
      {
        ...query('/work'),
        options: { pageSize: 1000, archiveState: 'archived' as const },
      },
      { fresh: true },
    );
    // The cursored page holds the only copy of a distinct session id, so a
    // watermark for it must not be reported as absorbed.
    legacy.mockResolvedValue({
      sessions: [{ sessionId: 'cursor-only', workspaceCwd: '/work' }],
    });
    await store.loadOnce(
      {
        ...query('/work'),
        options: { ...query('/work').options, cursor: 'cursor-1' },
      },
      { fresh: true },
    );

    const volatileState = {
      clientCount: 0,
      hasActivePrompt: false,
      isWaitingForPermission: false,
      isWaitingForUserQuestion: false,
    };
    const stamp = '2026-08-17T00:00:09.000Z';
    const absorbed = store.applyLiveState('/work', [
      { sessionId: 'a', ...volatileState, updatedAt: stamp },
      { sessionId: 'row-archived', ...volatileState, updatedAt: stamp },
      { sessionId: 'foreign-row', ...volatileState, updatedAt: stamp },
      { sessionId: 'archived-only', ...volatileState, updatedAt: stamp },
      { sessionId: 'cursor-only', ...volatileState, updatedAt: stamp },
      { sessionId: 'unknown', ...volatileState, updatedAt: stamp },
      { sessionId: 'no-watermark', ...volatileState },
    ]);

    expect([...absorbed]).toEqual(['a']);
  });

  it('orders unstamped rows by createdAt and bounds stamps by createdAt', async () => {
    legacy.mockResolvedValue({
      sessions: [
        {
          sessionId: 'm',
          workspaceCwd: '/work',
          updatedAt: '2026-08-17T00:00:03.000Z',
        },
        {
          sessionId: 'zzz',
          workspaceCwd: '/work',
          createdAt: '2026-08-17T00:00:02.000Z',
        },
        {
          sessionId: 'aaa',
          workspaceCwd: '/work',
          createdAt: '2026-08-17T00:00:01.000Z',
        },
      ],
    });
    const target = query('/work');
    await store.loadOnce(target, { fresh: true });

    const volatileState = {
      clientCount: 0,
      hasActivePrompt: false,
      isWaitingForPermission: false,
      isWaitingForUserQuestion: false,
    };
    // A live stamp older than a row's createdAt lower bound is rejected.
    store.applyLiveState('/work', [
      {
        sessionId: 'zzz',
        ...volatileState,
        updatedAt: '2026-08-17T00:00:01.500Z',
      },
    ]);
    expect(
      store
        .getSnapshot(target)
        .page?.sessions.find((session) => session.sessionId === 'zzz')
        ?.updatedAt,
    ).toBeUndefined();

    // A fresher stamp on another row triggers a re-sort; the unstamped rows
    // must order by their createdAt lower bound, not the id tie-break.
    store.applyLiveState('/work', [
      {
        sessionId: 'm',
        ...volatileState,
        updatedAt: '2026-08-17T00:00:04.000Z',
      },
    ]);
    expect(
      store.getSnapshot(target).page?.sessions.map((s) => s.sessionId),
    ).toEqual(['m', 'zzz', 'aaa']);

    // A stamp above the createdAt lower bound is accepted.
    store.applyLiveState('/work', [
      {
        sessionId: 'zzz',
        ...volatileState,
        updatedAt: '2026-08-17T00:00:05.000Z',
      },
    ]);
    expect(
      store.getSnapshot(target).page?.sessions.map((s) => s.sessionId),
    ).toEqual(['zzz', 'm', 'aaa']);
  });

  it('stages active queries through their own route kind and stales retained pages', async () => {
    legacy.mockImplementation(async (cwd: string) => page(cwd, cwd));
    const active = query('/work');
    const pinned = {
      ...query('/work'),
      options: { ...query('/work').options, view: 'organized' as const },
    };
    const other = query('/other');
    await store.loadOnce(active, { fresh: true });
    await store.loadOnce(pinned, { fresh: true });
    await store.loadOnce(other, { fresh: true });
    const unsubscribe = store.subscribe(active, vi.fn());
    const activeBefore = store.getSnapshot(active).page;
    const pinnedBefore = store.getSnapshot(pinned).page;
    qualified.mockResolvedValue(page('fresh'));

    const staged = await store.stageWorkspaceRefresh('/work');

    expect(qualified).not.toHaveBeenCalled();
    expect(legacy).toHaveBeenCalledTimes(4);
    expect(store.getSnapshot(active).page).toBe(activeBefore);
    expect(store.getSnapshot(pinned).page).toBe(pinnedBefore);
    expect(store.getSnapshot(active).stale).toBe(true);
    expect(store.commitWorkspaceRefresh(staged)).toBe(true);
    expect(store.getSnapshot(active).stale).toBe(false);
    expect(store.getSnapshot(pinned).stale).toBe(true);
    expect(store.getSnapshot(other).stale).toBe(false);
    expect(store.getSnapshot(active).page?.sessions[0]?.sessionId).toBe(
      '/work',
    );
    unsubscribe();
  });

  it('routes live workspace invalidations and new queries through reconciliation', async () => {
    legacy.mockResolvedValue(page('cached'));
    const active = query('/work');
    await store.loadOnce(active, { fresh: true });
    const releaseLiveState = store.retainWorkspaceLiveState('/work');

    store.invalidateWorkspace('/work');
    const unsubscribeActive = store.subscribe(active, vi.fn(), {
      autoLoad: true,
    });

    expect(legacy).toHaveBeenCalledTimes(1);
    expect(qualified).not.toHaveBeenCalled();
    expect(store.consumeWorkspaceLiveStateRefreshRequest('/work')).toBe(
      'interactive',
    );
    expect(
      store.consumeWorkspaceLiveStateRefreshRequest('/work'),
    ).toBeUndefined();

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();
    expect(legacy).toHaveBeenCalledTimes(1);

    const channel = {
      ...active,
      options: { ...active.options, sourceType: 'channel' },
    };
    const unsubscribeChannel = store.subscribe(channel, vi.fn());

    expect(legacy).toHaveBeenCalledTimes(1);
    expect(qualified).not.toHaveBeenCalled();
    expect(store.consumeWorkspaceLiveStateRefreshRequest('/work')).toBe(
      'interactive',
    );

    unsubscribeChannel();
    releaseLiveState();
    unsubscribeActive();
  });

  it('resolves an explicit live-state refresh only from a staged commit', async () => {
    legacy
      .mockResolvedValueOnce(page('cached'))
      .mockResolvedValueOnce(page('refreshed'));
    const target = query('/work');
    await store.loadOnce(target, { fresh: true });
    const releaseLiveState = store.retainWorkspaceLiveState('/work');

    const refresh = store.refresh(target);

    expect(legacy).toHaveBeenCalledTimes(1);
    expect(qualified).not.toHaveBeenCalled();
    expect(store.consumeWorkspaceLiveStateRefreshRequest('/work')).toBe(
      'interactive',
    );

    const staged = await store.stageWorkspaceRefresh('/work');
    expect(legacy).toHaveBeenCalledTimes(2);
    expect(qualified).not.toHaveBeenCalled();
    expect(store.getSnapshot(target).page).toEqual(page('cached'));
    expect(store.commitWorkspaceRefresh(staged)).toBe(true);
    await expect(refresh).resolves.toEqual(page('refreshed'));

    releaseLiveState();
  });

  it('resumes an explicit refresh when live-state ownership is released', async () => {
    const stagedResponse = deferred<DaemonSessionListPage>();
    legacy
      .mockResolvedValueOnce(page('cached'))
      .mockReturnValueOnce(stagedResponse.promise)
      .mockResolvedValueOnce(page('legacy-refresh'));
    const target = query('/work');
    await store.loadOnce(target, { fresh: true });
    const releaseLiveState = store.retainWorkspaceLiveState('/work');
    const refresh = store.refresh(target);
    const stagedPromise = store.stageWorkspaceRefresh('/work');
    expect(legacy).toHaveBeenCalledTimes(2);
    expect(qualified).not.toHaveBeenCalled();

    releaseLiveState();
    stagedResponse.resolve(page('staged'));
    await stagedPromise;
    await flushMicrotasks();

    expect(legacy).toHaveBeenCalledTimes(3);
    await expect(refresh).resolves.toEqual(page('legacy-refresh'));
  });

  it('does not publish an older request or a staged page before commit', async () => {
    const initial = deferred<DaemonSessionListPage>();
    const stagedResponse = deferred<DaemonSessionListPage>();
    legacy
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(stagedResponse.promise);
    const target = query('/work');
    const unsubscribe = store.subscribe(target, vi.fn(), { autoLoad: true });

    const stagedPromise = store.stageWorkspaceRefresh('/work');
    initial.resolve(page('superseded'));
    await flushMicrotasks();
    expect(legacy).toHaveBeenCalledTimes(2);
    expect(qualified).not.toHaveBeenCalled();
    expect(store.getSnapshot(target).page).toBeUndefined();

    stagedResponse.resolve(page('staged'));
    const staged = await stagedPromise;
    expect(store.getSnapshot(target).page).toBeUndefined();
    expect(store.commitWorkspaceRefresh(staged)).toBe(true);
    expect(store.getSnapshot(target).page).toEqual(page('staged'));
    unsubscribe();
  });

  it('queues an explicit refresh behind staging and rejects the stale commit', async () => {
    legacy.mockResolvedValueOnce(page('cached'));
    const target = query('/work');
    await store.loadOnce(target, { fresh: true });
    const unsubscribe = store.subscribe(target, vi.fn());
    const stagedResponse = deferred<DaemonSessionListPage>();
    const refreshedResponse = deferred<DaemonSessionListPage>();
    legacy
      .mockReturnValueOnce(stagedResponse.promise)
      .mockReturnValueOnce(refreshedResponse.promise);

    const stagedPromise = store.stageWorkspaceRefresh('/work');
    const refreshPromise = store.refresh(target);
    expect(legacy).toHaveBeenCalledTimes(2);
    expect(qualified).not.toHaveBeenCalled();
    stagedResponse.resolve(page('staged'));
    const staged = await stagedPromise;

    expect(store.commitWorkspaceRefresh(staged)).toBe(false);
    expect(store.getSnapshot(target).page).toEqual(page('cached'));
    expect(legacy).toHaveBeenCalledTimes(3);
    refreshedResponse.resolve(page('refreshed'));
    await expect(refreshPromise).resolves.toEqual(page('refreshed'));
    unsubscribe();
  });

  it('does not supersede an explicit request that started before staging', async () => {
    const response = deferred<DaemonSessionListPage>();
    legacy.mockReturnValueOnce(response.promise);
    const target = query('/work');
    const request = store.loadOnce(target, { fresh: true });

    const staged = await store.stageWorkspaceRefresh('/work');

    expect(staged.complete).toBe(false);
    expect(qualified).not.toHaveBeenCalled();
    response.resolve(page('explicit'));
    await expect(request).resolves.toEqual(page('explicit'));
  });

  it('resolves a non-coordinated waiter after a live-mode invalidation', async () => {
    const initial = deferred<DaemonSessionListPage>();
    legacy
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce(page('rescued'));
    const target = query('/work');
    const request = store.loadOnce(target, { fresh: true });
    const releaseLiveState = store.retainWorkspaceLiveState('/work');

    store.invalidateWorkspace('/work');

    initial.resolve(page('stale'));
    await flushMicrotasks();
    // The invalidation bumped the revision past the in-flight job; a real
    // follow-up job must settle the pre-live waiter.
    await expect(request).resolves.toEqual(page('rescued'));
    expect(legacy).toHaveBeenCalledTimes(2);
    releaseLiveState();
  });

  it('scopes a staged failure to the failing entry', async () => {
    legacy.mockResolvedValue(page('cached'));
    const active = query('/work');
    const pinned = {
      ...query('/work'),
      options: { ...query('/work').options, view: 'organized' as const },
    };
    await store.loadOnce(active, { fresh: true });
    await store.loadOnce(pinned, { fresh: true });
    const unsubscribeActive = store.subscribe(active, vi.fn());
    const unsubscribePinned = store.subscribe(pinned, vi.fn());
    let calls = 0;
    legacy.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) throw new Error('pinned blip');
      return page('fresh');
    });

    await expect(store.stageWorkspaceRefresh('/work')).rejects.toThrow(
      'pinned blip',
    );

    expect(store.getSnapshot(active).error).toBeUndefined();
    expect(store.getSnapshot(active).loading).toBe(false);
    expect(store.getSnapshot(pinned).error?.message).toBe('pinned blip');
    expect(store.getSnapshot(pinned).loading).toBe(false);
    unsubscribeActive();
    unsubscribePinned();
  });

  it('flags an interactive refresh when a live-mode subscriber maxAge expires', async () => {
    legacy.mockResolvedValue(page('cached'));
    const target = query('/work');
    await store.loadOnce(target, { fresh: true });
    const releaseLiveState = store.retainWorkspaceLiveState('/work');

    vi.advanceTimersByTime(2_000);
    const unsubscribe = store.subscribe(target, vi.fn(), {
      autoLoad: true,
      maxAgeMs: 1_000,
    });

    expect(store.consumeWorkspaceLiveStateRefreshRequest('/work')).toBe(
      'interactive',
    );
    unsubscribe();
    releaseLiveState();
  });

  it('wakes live-state listeners for interactive refreshes only', () => {
    const wake = vi.fn();
    const stopWake = store.onLiveStateWake(wake);
    const releaseLiveState = store.retainWorkspaceLiveState('/work');
    legacy.mockResolvedValue(page('cached'));

    store.invalidateWorkspace('/work');
    expect(wake).not.toHaveBeenCalled();

    // The waiter settles via a later staged commit (not exercised here), so
    // drop the promise; the wake fires synchronously inside refresh().
    void store.refresh(query('/work')).catch(() => undefined);
    expect(wake).toHaveBeenCalledWith('/work', false);

    void store
      .refresh(query('/work'), { interactive: true })
      .catch(() => undefined);
    expect(wake).toHaveBeenLastCalledWith('/work', true);

    stopWake();
    releaseLiveState();
  });

  it('does not let a trailing non-staged job settle staged-revision waiters', async () => {
    const initial = deferred<DaemonSessionListPage>();
    const trailing = deferred<DaemonSessionListPage>();
    const stagedResponse = deferred<DaemonSessionListPage>();
    legacy
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(trailing.promise)
      .mockReturnValueOnce(stagedResponse.promise);
    const target = query('/work');
    // A legacy background job is in flight when live-state takes over.
    const unsubscribe = store.subscribe(target, vi.fn(), { autoLoad: true });
    const releaseLiveState = store.retainWorkspaceLiveState('/work');

    // Staging begins while the legacy job runs; the follower loadOnce arms
    // a trailing non-staged job at the staging-target revision.
    const stagedPromise = store.stageWorkspaceRefresh('/work');
    const followUp = store.loadOnce(target);
    initial.resolve(page('initial'));
    await flushMicrotasks();

    // The trailing job fails at the staged revision: it must not reject
    // the waiters the staged commit is about to resolve.
    trailing.reject(new Error('trailing blip'));
    stagedResponse.resolve(page('staged'));
    const staged = await stagedPromise;
    expect(staged.complete).toBe(true);
    expect(store.commitWorkspaceRefresh(staged)).toBe(true);
    await expect(followUp).resolves.toEqual(page('staged'));
    expect(store.getSnapshot(target).error).toBeUndefined();

    unsubscribe();
    releaseLiveState();
  });

  it('uses the qualified client only for qualified queries', async () => {
    qualified.mockResolvedValue({
      sessions: [{ sessionId: 'qualified' }],
    } satisfies DaemonSessionListPage);
    await store.loadOnce(query('/work', 'qualified'), { fresh: true });
    expect(qualified).toHaveBeenCalledWith(
      expect.objectContaining({ archiveState: 'active' }),
    );
    expect(legacy).not.toHaveBeenCalled();
    expect(
      store.getSnapshot(query('/work', 'qualified')).page?.sessions[0]
        ?.workspaceCwd,
    ).toBe('/work');
  });

  it('defers background loads while hidden and refreshes when visible', async () => {
    legacy.mockResolvedValue(page('visible'));
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    const target = query('/work');
    const unsubscribe = store.subscribe(target, vi.fn(), { autoLoad: true });
    expect(legacy).not.toHaveBeenCalled();

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(legacy).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    unsubscribe();
  });

  it('does not start queued background work after the page becomes hidden', async () => {
    const first = deferred<DaemonSessionListPage>();
    legacy
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(page('visible'));
    const unsubscribeA = store.subscribe(query('/a'), vi.fn(), {
      autoLoad: true,
    });
    const unsubscribeB = store.subscribe(query('/b'), vi.fn(), {
      autoLoad: true,
    });
    expect(legacy).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    first.resolve(page('a'));
    await flushMicrotasks();
    expect(legacy).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(legacy).toHaveBeenCalledTimes(2);
    unsubscribeA();
    unsubscribeB();
  });

  it('does not invent a tail refresh for a hidden background invalidation', async () => {
    const first = deferred<DaemonSessionListPage>();
    legacy
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(page('new'));
    const target = query('/work');
    const unsubscribe = store.subscribe(target, vi.fn(), { autoLoad: true });
    expect(legacy).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    store.invalidateWorkspace('/work', { background: true });
    first.resolve(page('old'));
    await flushMicrotasks();

    expect(legacy).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot(target)).toMatchObject({
      loading: false,
      stale: true,
    });
    expect(store.getSnapshot(target).page).toBeUndefined();

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();
    expect(legacy).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('does not carry automatic backoff across a hidden mutation invalidation', async () => {
    legacy
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page('recovered'));
    const target = query('/work');
    const unsubscribe = store.subscribe(target, vi.fn(), { autoLoad: true });
    await flushMicrotasks();
    expect(legacy).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    store.invalidateWorkspace('/work', { background: true });

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();

    expect(legacy).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot(target).page).toEqual(page('recovered'));
    unsubscribe();
  });

  it('restores an overdue hidden invalidation for a poll-only subscriber', async () => {
    legacy.mockResolvedValue(page('visible'));
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    const target = query('/work');
    const unsubscribe = store.subscribe(target, vi.fn(), {
      pollIntervalMs: 10_000,
    });
    store.invalidateWorkspace('/work', { background: true });
    expect(legacy).not.toHaveBeenCalled();

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();

    expect(legacy).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('restores a hidden tail invalidation for a snapshot-only subscriber', async () => {
    legacy
      .mockResolvedValueOnce(page('cached'))
      .mockResolvedValueOnce(page('visible'));
    const target = query('/work');
    await store.loadOnce(target, { fresh: true });
    const unsubscribe = store.subscribe(target, vi.fn());

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    store.invalidateWorkspace('/work', { background: true });
    expect(legacy).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();

    expect(legacy).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot(target).page).toEqual(page('visible'));
    unsubscribe();
  });

  it('preserves a hidden invalidation after an older request finishes', async () => {
    const stale = deferred<DaemonSessionListPage>();
    legacy
      .mockResolvedValueOnce(page('cached'))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(page('visible'));
    const target = query('/work');
    await store.loadOnce(target, { fresh: true });
    await flushMicrotasks();
    const unsubscribe = store.subscribe(target, vi.fn());

    store.invalidateWorkspace('/work', { background: true });
    expect(legacy).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    store.invalidateWorkspace('/work', { background: true });
    stale.resolve(page('stale'));
    await flushMicrotasks();

    expect(store.getSnapshot(target)).toMatchObject({
      page: page('cached'),
      loading: false,
      stale: true,
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();

    expect(legacy).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot(target).page).toEqual(page('visible'));
    unsubscribe();
  });

  it('defers a visible trailing background refresh when the page becomes hidden', async () => {
    const stale = deferred<DaemonSessionListPage>();
    legacy
      .mockResolvedValueOnce(page('cached'))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(page('visible'));
    const target = query('/work');
    await store.loadOnce(target, { fresh: true });
    await flushMicrotasks();
    const unsubscribe = store.subscribe(target, vi.fn());

    store.invalidateWorkspace('/work', { background: true });
    expect(legacy).toHaveBeenCalledTimes(2);
    store.invalidateWorkspace('/work', { background: true });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    stale.resolve(page('stale'));
    await flushMicrotasks();

    expect(legacy).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot(target)).toMatchObject({
      page: page('cached'),
      loading: false,
      stale: true,
    });

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();

    expect(legacy).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot(target).page).toEqual(page('visible'));
    unsubscribe();
  });

  it('drops a trailing background refresh after the last subscriber leaves', async () => {
    const stale = deferred<DaemonSessionListPage>();
    legacy
      .mockResolvedValueOnce(page('cached'))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(page('resubscribed'));
    const target = query('/work');
    await store.loadOnce(target, { fresh: true });
    await flushMicrotasks();
    const unsubscribe = store.subscribe(target, vi.fn());

    store.invalidateWorkspace('/work', { background: true });
    expect(legacy).toHaveBeenCalledTimes(2);
    store.invalidateWorkspace('/work', { background: true });
    unsubscribe();
    stale.resolve(page('stale'));
    await flushMicrotasks();

    expect(legacy).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot(target)).toMatchObject({
      page: page('cached'),
      loading: false,
      stale: true,
    });

    const unsubscribeAgain = store.subscribe(target, vi.fn());
    await flushMicrotasks();
    expect(legacy).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot(target).page).toEqual(page('resubscribed'));
    unsubscribeAgain();
  });

  it('restores snapshot-only background work removed from the visible queue', async () => {
    legacy.mockResolvedValueOnce(page('cached'));
    const target = query('/work');
    await store.loadOnce(target, { fresh: true });
    await flushMicrotasks();

    const blocker = deferred<DaemonSessionListPage>();
    legacy
      .mockReturnValueOnce(blocker.promise)
      .mockResolvedValueOnce(page('visible'));
    const unsubscribeBlocker = store.subscribe(query('/blocker'), vi.fn(), {
      autoLoad: true,
    });
    const unsubscribeTarget = store.subscribe(target, vi.fn());
    store.invalidateWorkspace('/work', { background: true });
    expect(legacy).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot(target).loading).toBe(true);

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(store.getSnapshot(target).loading).toBe(false);
    blocker.resolve(page('blocker'));
    await flushMicrotasks();
    expect(legacy).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(store.getSnapshot(target).loading).toBe(true);
    await flushMicrotasks();

    expect(legacy).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot(target).page).toEqual(page('visible'));
    unsubscribeTarget();
    unsubscribeBlocker();
  });

  it('refreshes an invalidated retained entry on its next subscription', async () => {
    legacy
      .mockResolvedValueOnce(page('cached'))
      .mockResolvedValueOnce(page('refreshed'));
    const target = query('/work');
    await store.loadOnce(target, { fresh: true });
    await flushMicrotasks();

    store.invalidateWorkspace('/work');
    expect(store.getSnapshot(target).stale).toBe(true);
    expect(legacy).toHaveBeenCalledTimes(1);

    const unsubscribe = store.subscribe(target, vi.fn());
    await flushMicrotasks();

    expect(legacy).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot(target).page).toEqual(page('refreshed'));
    unsubscribe();
  });

  it('retains an unused snapshot for thirty seconds and then releases it', async () => {
    legacy.mockResolvedValue(page('retained'));
    const target = query('/work');
    const unsubscribe = store.subscribe(target, vi.fn(), { autoLoad: true });
    await flushMicrotasks();
    unsubscribe();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(store.getSnapshot(target).page).toEqual(page('retained'));
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getSnapshot(target).page).toBeUndefined();
  });

  it('releases entries created by an uncommitted snapshot read', async () => {
    const target = query('/work');
    store.getSnapshot(target);
    store.invalidateWorkspace('/work');

    await vi.advanceTimersByTimeAsync(SESSION_CATALOG_RETENTION_MS);
    const unsubscribe = store.subscribe(target, vi.fn());

    expect(legacy).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('SessionCatalogStore live-session snapshots (#9487)', () => {
  let store: SessionCatalogStore;

  function live(sessionId: string, hasActivePrompt: boolean) {
    return {
      sessionId,
      clientCount: 1,
      hasActivePrompt,
      isWaitingForPermission: false,
      isWaitingForUserQuestion: false,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    const client = {
      listWorkspaceSessionsPage: vi.fn(),
      workspaceByCwd: vi.fn(() => ({
        listWorkspaceSessionsPage: vi.fn(),
      })),
    } as unknown as DaemonClient;
    store = new SessionCatalogStore(client);
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  it('answers per-session lookups independently of any loaded page', () => {
    expect(store.hasLiveSessions('/work')).toBe(false);
    expect(store.getLiveSession('/work', 'off-page')).toBeUndefined();

    // One live-state response is enough: no catalog page was ever loaded,
    // yet a session that no page contains resolves from the snapshot.
    store.applyLiveState('/work', [live('off-page', true)]);

    expect(store.hasLiveSessions('/work')).toBe(true);
    expect(store.getLiveSession('/work', 'off-page')?.hasActivePrompt).toBe(
      true,
    );
    expect(store.getLiveSession('/work', 'unknown')).toBeUndefined();
  });

  it('notifies live-session subscribers only when volatile state changes', () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribeLiveSessions('/work', listener);

    store.applyLiveState('/work', [live('s1', true)]);
    expect(listener).toHaveBeenCalledTimes(1);

    // The 2s poll cadence keeps re-applying identical state: no churn.
    store.applyLiveState('/work', [live('s1', true)]);
    expect(listener).toHaveBeenCalledTimes(1);

    store.applyLiveState('/work', [live('s1', false)]);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.applyLiveState('/work', [live('s1', true)]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('drops the snapshot when the last live-state retainer releases', () => {
    const release = store.retainWorkspaceLiveState('/work');
    store.applyLiveState('/work', [live('s1', true)]);
    const listener = vi.fn();
    const unsubscribe = store.subscribeLiveSessions('/work', listener);

    release();

    expect(store.hasLiveSessions('/work')).toBe(false);
    expect(store.getLiveSession('/work', 's1')).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
