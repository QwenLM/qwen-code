// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedAgentProvider } from './managed-agent-provider';
import type {
  ManagedSideQuery,
  ManagedSideQueriesProvider,
} from './managed-side-query-types';
import {
  sideQuery,
  sideQueryContext,
} from './managed-side-query.test-fixtures';
import { useManagedSideQueries } from './use-managed-side-queries';

describe('useManagedSideQueries', () => {
  let root: Root;
  let provider: ManagedAgentProvider;
  let api: ManagedSideQueriesProvider;
  let options: Parameters<typeof useManagedSideQueries>[3];
  let current: ReturnType<typeof useManagedSideQueries>;
  let hidden: boolean;
  function Probe() {
    current = useManagedSideQueries(provider, 'client', 's1', options);
    return null;
  }
  const render = () =>
    act(async () => {
      root.render(<Probe />);
    });
  const visibility = (value: boolean) =>
    act(async () => {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    });
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  beforeEach(() => {
    vi.useFakeTimers();
    const preferences = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => preferences.get(key) ?? null,
      setItem: (key: string, value: string) => {
        preferences.set(key, value);
      },
      removeItem: (key: string) => {
        preferences.delete(key);
      },
      clear: () => preferences.clear(),
    });
    sessionStorage.clear();
    localStorage.clear();
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    root = createRoot(document.createElement('div'));
    options = { idle: true, interactive: true, btw: true, recap: true };
    api = {
      context: vi.fn().mockResolvedValue(sideQueryContext),
      list: vi.fn().mockResolvedValue({ items: [] }),
      create: vi.fn().mockResolvedValue(sideQuery),
      get: vi.fn().mockResolvedValue(sideQuery),
      cancel: vi.fn().mockResolvedValue({
        ...sideQuery,
        status: 'cancelled',
        resultRevision: 4,
      }),
      stream: vi.fn().mockImplementation(async function* () {}),
    };
    provider = {
      storageKey: 'product',
      sideQueries: api,
    } as unknown as ManagedAgentProvider;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('issues no context or list request when neither btw nor recap is capable', async () => {
    options = { ...options, btw: false, recap: false };
    await render();
    await advance(30_000);
    expect(api.context).not.toHaveBeenCalled();
    expect(api.list).not.toHaveBeenCalled();
    expect(current.available('btw')).toBe(false);
    expect(current.available('recap')).toBe(false);
  });

  it('starts fetching once a capability becomes available', async () => {
    options = { ...options, btw: false, recap: false };
    await render();
    await advance(10_000);
    expect(api.context).not.toHaveBeenCalled();
    options = { ...options, recap: true };
    await render();
    expect(api.context).toHaveBeenCalled();
  });

  it('replays the original payload and key after an unknown admission without storing answer bodies', async () => {
    vi.mocked(api.create).mockRejectedValueOnce(new Error('lost response'));
    await render();
    const request = { kind: 'btw' as const, question: 'original question' };
    await act(async () => {
      await current.create(request);
    });
    const original = vi.mocked(api.create).mock.calls[0];
    expect(current.pending).toEqual(['btw']);
    const pendingKey = Object.keys(sessionStorage)[0];
    expect(JSON.parse(sessionStorage.getItem(pendingKey)!)).toEqual({
      request,
      idempotencyKey: original[2].idempotencyKey,
    });
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await render();
    const replay = vi.mocked(api.create).mock.calls[1];
    expect(replay[1]).toEqual(request);
    expect(replay[2].idempotencyKey).toBe(original[2].idempotencyKey);
    expect(current.queries).toEqual([sideQuery]);
    expect(current.pending).toEqual([]);
    expect(JSON.stringify(sessionStorage)).not.toContain(sideQuery.text);
    expect(sessionStorage.getItem(pendingKey)).toBeNull();
  });

  it('clears only the admitted payload and retains a query ID until its independent execution settles', async () => {
    const running: ManagedSideQuery = {
      ...sideQuery,
      status: 'running',
      text: '',
      resultRevision: 1,
    };
    vi.mocked(api.create).mockResolvedValue(running);
    vi.mocked(api.get).mockResolvedValue(running);
    await render();
    await act(async () => {
      await current.create({ kind: 'btw', question: 'secret prompt' });
    });
    const saved = sessionStorage.getItem(Object.keys(sessionStorage)[0])!;
    expect(JSON.parse(saved)).toEqual({ queryId: 'q1' });
    expect(saved).not.toContain('secret prompt');
    await act(async () => current.cancel(running));
    expect(current.queries[0].status).toBe('cancelled');
    expect(current.pending).toEqual([]);
  });

  it('does not regress a terminal SSE snapshot when the reconnect read is older', async () => {
    const running: ManagedSideQuery = {
      ...sideQuery,
      status: 'running',
      resultRevision: 1,
    };
    vi.mocked(api.create).mockResolvedValue(running);
    vi.mocked(api.get).mockResolvedValue(running);
    vi.mocked(api.stream).mockImplementation(async function* () {
      yield { ...running, text: 'partial', resultRevision: 2 };
      yield sideQuery;
    });
    await render();
    await act(async () => {
      await current.create({ kind: 'btw', question: 'question' });
    });
    expect(current.queries[0]).toEqual(sideQuery);
    expect(current.pending).toEqual([]);
    expect(api.stream).toHaveBeenCalledWith(
      's1',
      'q1',
      expect.objectContaining({ afterRevision: 1 }),
    );
  });

  it('clears private in-memory results and settings when the authenticated actor changes', async () => {
    vi.mocked(api.list).mockResolvedValueOnce({ items: [sideQuery] });
    await render();
    await act(async () => current.setAutomatic(true));
    expect(current.queries).toEqual([sideQuery]);
    const previousOwner = current;
    vi.mocked(api.context).mockResolvedValue({
      ...sideQueryContext,
      actorScopeKey: 'opaque-actor-b',
    });
    await advance(10_000);
    expect(current.queries).toEqual([]);
    expect(current.automatic).toBe(false);
    await act(async () => previousOwner.cancel(sideQuery));
    await act(async () => previousOwner.setAutomatic(true));
    expect(api.cancel).not.toHaveBeenCalled();
    expect(current.automatic).toBe(false);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('defaults automatic recap off and never counts an absence that began before enabling it', async () => {
    await render();
    expect(current.automatic).toBe(false);
    await visibility(true);
    await advance(300_000);
    await act(async () => current.setAutomatic(true));
    await visibility(false);
    expect(api.create).not.toHaveBeenCalled();
    await visibility(true);
    await advance(299_999);
    await visibility(false);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('waits for idle after five minutes away and admits automatic recap with both fresh boundaries', async () => {
    const recap: ManagedSideQuery = {
      ...sideQuery,
      kind: 'recap',
      trigger: 'automatic',
    };
    vi.mocked(api.create).mockResolvedValue(recap);
    await render();
    await act(async () => current.setAutomatic(true));
    await visibility(true);
    await advance(300_000);
    options = { ...options, idle: false };
    await render();
    await visibility(false);
    expect(api.create).not.toHaveBeenCalled();
    options = { ...options, idle: true };
    await render();
    expect(api.create).toHaveBeenCalledExactlyOnceWith(
      's1',
      {
        kind: 'recap',
        trigger: 'automatic',
        expectedContentVersion: 'v3',
        expectedMainInputBoundary: 3,
      },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(current.open).toBe('recap');
    expect(current.queries).toEqual([recap]);
  });

  it('uses server eligibility and discards automatic output after another tab admits a failed or queued input', async () => {
    await render();
    await act(async () => current.setAutomatic(true));
    await visibility(true);
    await advance(300_000);
    vi.mocked(api.context).mockResolvedValue({
      ...sideQueryContext,
      automaticEligible: false,
    });
    await visibility(false);
    expect(api.create).not.toHaveBeenCalled();
    vi.mocked(api.context).mockResolvedValue(sideQueryContext);
    await visibility(true);
    await advance(300_000);
    vi.mocked(api.create).mockImplementation(async () => {
      vi.mocked(api.context).mockResolvedValue({
        ...sideQueryContext,
        mainInputBoundary: 4,
      });
      return { ...sideQuery, kind: 'recap', trigger: 'automatic' };
    });
    await visibility(false);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(current.open).toBeUndefined();
    expect(current.queries).toEqual([]);
  });

  it('displays an automatic recap that settles while its admission response is being handled', async () => {
    const recap: ManagedSideQuery = {
      ...sideQuery,
      kind: 'recap',
      trigger: 'automatic',
    };
    const running: ManagedSideQuery = {
      ...recap,
      status: 'running',
      text: '',
      resultRevision: 1,
    };
    vi.mocked(api.create).mockResolvedValue(running);
    vi.mocked(api.get).mockResolvedValue(recap);
    vi.mocked(api.stream).mockImplementation(async function* () {
      yield recap;
    });
    await render();
    await act(async () => current.setAutomatic(true));
    await visibility(true);
    await advance(300_000);
    await visibility(false);
    expect(current.open).toBe('recap');
    expect(current.queries).toEqual([recap]);
  });

  it('keeps automatic context failures silent', async () => {
    await render();
    await act(async () => current.setAutomatic(true));
    await visibility(true);
    await advance(300_000);
    vi.mocked(api.context)
      .mockResolvedValueOnce(sideQueryContext)
      .mockRejectedValueOnce(new Error('temporary context failure'));
    await visibility(false);
    expect(api.create).not.toHaveBeenCalled();
    expect(current.error).toBeUndefined();
    expect(current.open).toBeUndefined();
  });

  it('does not display a reused automatic result captured before the current main-input boundary', async () => {
    vi.mocked(api.create).mockResolvedValue({
      ...sideQuery,
      kind: 'recap',
      trigger: 'automatic',
      source: { ...sideQuery.source, mainInputBoundary: 2 },
    });
    await render();
    await act(async () => current.setAutomatic(true));
    await visibility(true);
    await advance(300_000);
    await visibility(false);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(current.open).toBeUndefined();
    expect(current.queries).toEqual([]);
  });
});
