// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedContextCompressionOperation,
} from './managed-agent-provider';
import { useManagedContextCompression } from './use-managed-context-compression';

const summary: ManagedAgentSessionSummary = {
  sessionId: 's1',
  title: 'Session',
  workspace: { workspaceId: 'ws', cwdRelative: '.', contextRevision: 1 },
  compactionRevision: 0,
  createdAt: 1,
  admittedAt: 1,
  updatedAt: 1,
  phase: 'completed',
  runtimeReady: true,
  runtimeState: 'ready',
  capabilities: { canSend: true, canCancel: false, contextCompression: true },
};
const operation: ManagedContextCompressionOperation = {
  sessionId: 's1',
  operationId: 'op',
  type: 'context_compression',
  status: 'completed',
  expectedCompactionRevision: 0,
  compactionRevision: 9,
  outcome: 'compressed',
  replayed: false,
};
const storageKey = 'qwen-managed-compression:tenant:actor:s1';

describe('useManagedContextCompression', () => {
  let root: Root;
  let current: ReturnType<typeof useManagedContextCompression>;
  let provider: ManagedAgentProvider;
  let refresh: ReturnType<typeof vi.fn>;

  function Probe({
    session,
    available,
  }: {
    session: ManagedAgentSessionSummary;
    available: boolean;
  }) {
    current = useManagedContextCompression(
      provider,
      'client',
      session.sessionId,
      session,
      refresh,
      () => available,
    );
    return null;
  }
  const render = (session = summary, available = true) =>
    act(async () => {
      root.render(<Probe session={session} available={available} />);
    });
  beforeEach(() => {
    sessionStorage.clear();
    root = createRoot(document.createElement('div'));
    provider = {
      storageKey: 'tenant:actor',
      contextCompression: {
        submit: vi.fn().mockResolvedValue(operation),
        query: vi.fn().mockResolvedValue(operation),
      },
    } as unknown as ManagedAgentProvider;
    refresh = vi.fn().mockResolvedValue({ ...summary, compactionRevision: 9 });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('saves a revision-zero request before POST and waits for its committed projection', async () => {
    let resolve!: (value: ManagedAgentSessionSummary) => void;
    refresh.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    vi.mocked(provider.contextCompression!.submit).mockImplementation(
      async (_id, request, options) => {
        expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toMatchObject({
          expectedCompactionRevision: 0,
          idempotencyKey: options.idempotencyKey,
        });
        expect(request).toEqual({ expectedCompactionRevision: 0 });
        return operation;
      },
    );
    await render();
    let pending!: Promise<void>;
    await act(async () => {
      pending = current.controls!.compress();
    });
    expect(current.blocked).toBe(true);
    expect(current.usageInvalidated).toBe(true);
    await act(async () => {
      resolve({ ...summary, compactionRevision: 9 });
      await pending;
    });
    expect(current.blocked).toBe(false);
    expect(current.controls?.result).toEqual({ kind: 'compressed' });
    expect(sessionStorage.length).toBe(0);
  });

  it('retains a lost-ACK request through refresh and reuses its key on confirmation', async () => {
    vi.mocked(provider.contextCompression!.submit).mockRejectedValueOnce(
      new TypeError('lost ACK'),
    );
    await render();
    await act(async () => current.controls!.compress());
    const first = vi.mocked(provider.contextCompression!.submit).mock.calls[0];
    expect(current.errorCode).toBe('unconfirmed');
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await render();
    expect(current.blocked).toBe(true);
    expect(provider.contextCompression!.submit).toHaveBeenCalledOnce();
    await act(async () => current.confirm());
    const second = vi.mocked(provider.contextCompression!.submit).mock.calls[1];
    expect(second[1]).toEqual(first[1]);
    expect(second[2].idempotencyKey).toBe(first[2].idempotencyKey);
    expect(current.blocked).toBe(false);
  });

  it('queries a known operation on remount even after capability revocation', async () => {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        sessionId: 's1',
        operationId: 'op',
        expectedCompactionRevision: 0,
        idempotencyKey: 'original',
      }),
    );
    await render({
      ...summary,
      capabilities: { ...summary.capabilities, contextCompression: false },
    });
    expect(provider.contextCompression!.query).toHaveBeenCalledWith(
      's1',
      'op',
      expect.anything(),
    );
    expect(provider.contextCompression!.submit).not.toHaveBeenCalled();
    expect(current.blocked).toBe(false);
  });

  it('adopts another tab operation from the summary without creating a new request', async () => {
    await render({ ...summary, contextCompressionOperationId: 'op' });
    expect(provider.contextCompression!.query).toHaveBeenCalledWith(
      's1',
      'op',
      expect.anything(),
    );
    expect(provider.contextCompression!.submit).not.toHaveBeenCalled();
    expect(current.controls?.result).toEqual({ kind: 'compressed' });
    expect(current.blocked).toBe(false);
    await render({ ...summary, contextCompressionOperationId: 'op' });
    expect(provider.contextCompression!.query).toHaveBeenCalledOnce();
  });

  it('accepts a durable noop without advancing the revision or invalidating usage', async () => {
    vi.mocked(provider.contextCompression!.submit).mockResolvedValue({
      ...operation,
      outcome: 'noop',
      compactionRevision: 0,
    });
    refresh.mockResolvedValue(summary);
    await render();
    await act(async () => current.controls!.compress());
    expect(current.controls?.result).toEqual({ kind: 'noop' });
    expect(current.usageInvalidated).toBe(false);
    expect(current.blocked).toBe(false);
  });

  it('keeps recovery-blocked work in the same operation and queries until complete', async () => {
    vi.useFakeTimers();
    vi.mocked(provider.contextCompression!.submit).mockResolvedValue({
      ...operation,
      status: 'recovery_blocked',
      outcome: undefined,
      compactionRevision: undefined,
    });
    await render();
    let pending!: Promise<void>;
    await act(async () => {
      pending = current.controls!.compress();
    });
    expect(current.blocked).toBe(true);
    expect(current.errorCode).toBe('recovery_blocked');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
    });
    expect(provider.contextCompression!.submit).toHaveBeenCalledOnce();
    expect(provider.contextCompression!.query).toHaveBeenCalledOnce();
    expect(current.blocked).toBe(false);
  });

  it('retains accepted work after a request timeout and confirms by query', async () => {
    vi.useFakeTimers();
    vi.mocked(provider.contextCompression!.submit).mockResolvedValue({
      ...operation,
      status: 'running',
      outcome: undefined,
      compactionRevision: undefined,
    });
    vi.mocked(provider.contextCompression!.query).mockResolvedValue({
      ...operation,
      status: 'running',
      outcome: undefined,
      compactionRevision: undefined,
    });
    await render();
    let pending!: Promise<void>;
    await act(async () => {
      pending = current.controls!.compress();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      await pending;
    });
    expect(current.blocked).toBe(true);
    expect(current.busy).toBe(false);
    expect(current.errorCode).toBe('unconfirmed');
    vi.mocked(provider.contextCompression!.query).mockResolvedValue(operation);
    await act(async () => current.confirm());
    expect(provider.contextCompression!.submit).toHaveBeenCalledOnce();
    expect(current.blocked).toBe(false);
  });

  it('does not treat a mismatched accepted result as permission to send', async () => {
    vi.mocked(provider.contextCompression!.submit).mockResolvedValue({
      ...operation,
      sessionId: 'other',
    });
    await render();
    await act(async () => current.controls!.compress());
    expect(current.blocked).toBe(true);
    expect(current.controls?.result).toBeUndefined();
    expect(current.errorCode).toBe('unconfirmed');
  });

  it('settles a known failure even when refreshing the summary fails', async () => {
    vi.mocked(provider.contextCompression!.submit).mockResolvedValue({
      ...operation,
      status: 'failed',
      outcome: undefined,
      failureCode: 'model_error',
    });
    refresh.mockRejectedValue(new Error('offline'));
    await render();
    await act(async () => current.controls!.compress());
    expect(current.blocked).toBe(false);
    expect(current.errorCode).toBe('model_error');
    expect(current.controls?.result).toEqual({ kind: 'failed' });
    expect(sessionStorage.length).toBe(0);
  });

  it.each([403, 409])(
    'releases an unaccepted request after a definitive %s refusal',
    async (status) => {
      vi.mocked(provider.contextCompression!.submit).mockRejectedValue(
        new JavaManagedAgentHttpError(status, 'session_context_busy', 'busy'),
      );
      await render();
      await act(async () => current.controls!.compress());
      expect(current.blocked).toBe(false);
      expect(current.errorCode).toBe('session_context_busy');
      expect(sessionStorage.length).toBe(0);
    },
  );

  it.each([401, 404, 408, 429, 500])(
    'retains the original key after an uncertain %s response',
    async (status) => {
      vi.mocked(provider.contextCompression!.submit).mockRejectedValue(
        new JavaManagedAgentHttpError(status, 'unavailable', 'unavailable'),
      );
      await render();
      await act(async () => current.controls!.compress());
      expect(current.blocked).toBe(true);
      expect(current.errorCode).toBe('unconfirmed');
      expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toHaveProperty(
        'idempotencyKey',
      );
    },
  );

  it('does not submit when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    await render();
    await act(async () => current.controls!.compress());
    expect(provider.contextCompression!.submit).not.toHaveBeenCalled();
    expect(current.blocked).toBe(false);
    expect(current.errorCode).toBe('storage_unavailable');
  });

  it('keeps a confirmed success when removing the saved intent fails and reads it again on refresh', async () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    await render();
    await act(async () => current.controls!.compress());
    expect(current.blocked).toBe(false);
    expect(current.controls?.result).toEqual({ kind: 'compressed' });
    expect(current.errorCode).toBe('storage_update_failed');
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await render();
    expect(provider.contextCompression!.query).toHaveBeenCalledWith(
      's1',
      'op',
      expect.anything(),
    );
    expect(provider.contextCompression!.submit).toHaveBeenCalledOnce();
    expect(current.controls?.result).toEqual({ kind: 'compressed' });
  });

  it('keeps usage unknown and retains the operation if its completed projection cannot be refreshed', async () => {
    refresh.mockRejectedValue(new Error('offline'));
    await render();
    await act(async () => current.controls!.compress());
    expect(current.usageInvalidated).toBe(true);
    expect(current.blocked).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toHaveProperty(
      'operationId',
      'op',
    );
  });

  it('ignores late responses after selecting a different Session', async () => {
    let resolve!: (value: ManagedContextCompressionOperation) => void;
    vi.mocked(provider.contextCompression!.submit).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    let pending!: Promise<void>;
    await act(async () => {
      pending = current.controls!.compress();
    });
    await render({ ...summary, sessionId: 's2' });
    await act(async () => {
      resolve(operation);
      await pending;
    });
    expect(current.blocked).toBe(false);
    expect(current.controls?.result).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(storageKey)).not.toBeNull();
  });

  it('blocks duplicate clicks synchronously and observes the current availability guard', async () => {
    let resolve!: (value: ManagedContextCompressionOperation) => void;
    vi.mocked(provider.contextCompression!.submit).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    const staleCompress = current.controls!.compress;
    let pending!: Promise<void>;
    await act(async () => {
      pending = staleCompress();
      await staleCompress();
    });
    expect(provider.contextCompression!.submit).toHaveBeenCalledOnce();
    await act(async () => {
      resolve(operation);
      await pending;
    });
    await render(summary, false);
    await act(async () => staleCompress());
    expect(provider.contextCompression!.submit).toHaveBeenCalledOnce();
  });
});
