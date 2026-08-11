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
