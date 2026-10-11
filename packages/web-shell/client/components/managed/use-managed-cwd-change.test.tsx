// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedCwdOperation,
} from './managed-agent-provider';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { useManagedCwdChange } from './use-managed-cwd-change';

const summary: ManagedAgentSessionSummary = {
  sessionId: 's1',
  title: 'S',
  workspace: {
    workspaceId: 'ws',
    cwdRelative: 'A',
    contextRevision: 1,
    state: 'ready',
  },
  createdAt: 1,
  admittedAt: 1,
  updatedAt: 1,
  phase: 'completed',
  runtimeReady: true,
  runtimeState: 'ready',
  capabilities: { canSend: true, canCancel: false, cwdChange: true },
};
const operation: ManagedCwdOperation = {
  sessionId: 's1',
  operationId: 'op',
  type: 'cwd_change',
  status: 'completed',
  expectedContextRevision: 1,
  targetCwdRelative: 'B',
  resultContextRevision: 2,
  replayed: false,
};

describe('useManagedCwdChange', () => {
  let root: Root;
  let current: ReturnType<typeof useManagedCwdChange>;
  let provider: ManagedAgentProvider;
  let refresh: ReturnType<typeof vi.fn>;
  function Probe({
    session = summary,
  }: {
    session?: ManagedAgentSessionSummary;
  }) {
    current = useManagedCwdChange(
      provider,
      'client',
      session.sessionId,
      session,
      refresh,
    );
    return null;
  }
  async function render(session = summary) {
    await act(async () => {
      root.render(<Probe session={session} />);
    });
  }
  beforeEach(() => {
    sessionStorage.clear();
    root = createRoot(document.createElement('div'));
    provider = {
      storageKey: 'tenant:actor',
      cwdChange: {
        submit: vi.fn().mockResolvedValue(operation),
        query: vi.fn().mockResolvedValue(operation),
      },
    } as unknown as ManagedAgentProvider;
    refresh = vi.fn().mockResolvedValue({
      ...summary,
      workspace: {
        ...summary.workspace,
        cwdRelative: 'B',
        contextRevision: 2,
      },
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('persists before POST and waits for a committed revision before releasing the intent', async () => {
    let release!: (value: ManagedAgentSessionSummary) => void;
    refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    vi.mocked(provider.cwdChange!.submit).mockImplementation(
      async (_id, _request, options) => {
        expect(
          sessionStorage.getItem('qwen-managed-cwd:tenant:actor:s1'),
        ).toContain(options.idempotencyKey);
        return operation;
      },
    );
    await render();
    let run!: ReturnType<typeof current.submit>;
    await act(async () => {
      run = current.submit('B', 1);
    });
    expect(current.blocked).toBe(true);
    await act(async () => {
      release({
        ...summary,
        workspace: {
          ...summary.workspace!,
          cwdRelative: 'C',
          contextRevision: 3,
        },
      });
      await run;
    });
    expect(current.blocked).toBe(false);
    expect(sessionStorage.length).toBe(0);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps the exact request after a lost ACK and replays only on explicit confirmation', async () => {
    vi.mocked(provider.cwdChange!.submit).mockRejectedValueOnce(
      new Error('lost ACK'),
    );
    await render();
    await act(async () => {
      await current.submit(' 空格 dir ', 1);
    });
    const first = vi.mocked(provider.cwdChange!.submit).mock.calls[0];
    expect(current.blocked).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await render();
    expect(provider.cwdChange!.submit).toHaveBeenCalledTimes(1);
    await act(async () => {
      await current.confirm();
    });
    const second = vi.mocked(provider.cwdChange!.submit).mock.calls[1];
    expect(second[1]).toEqual(first[1]);
    expect(second[2].idempotencyKey).toBe(first[2].idempotencyKey);
  });

  it('queries a persisted operation even after capability revocation', async () => {
    sessionStorage.setItem(
      'qwen-managed-cwd:tenant:actor:s1',
      JSON.stringify({
        sessionId: 's1',
        workspaceId: 'ws',
        cwdRelative: 'B',
        expectedContextRevision: 1,
        idempotencyKey: 'key',
        operationId: 'op',
      }),
    );
    await render({
      ...summary,
      capabilities: { ...summary.capabilities, cwdChange: false },
    });
    expect(provider.cwdChange!.query).toHaveBeenCalledWith(
      's1',
      'op',
      expect.anything(),
    );
    expect(provider.cwdChange!.submit).not.toHaveBeenCalled();
    expect(current.blocked).toBe(false);
  });

  it('releases a lost-ACK intent when confirm replay is refused after permission revocation', async () => {
    // The store's actor-scoped replay lookup runs before the role gate, so
    // a 403 on replay proves the original submit was never recorded: the
    // intent is released with the real refusal instead of parking forever.
    vi.mocked(provider.cwdChange!.submit)
      .mockRejectedValueOnce(new Error('lost ACK'))
      .mockRejectedValueOnce(
        new JavaManagedAgentHttpError(
          403,
          'session_operation_forbidden',
          'revoked',
        ),
      );
    await render();
    await act(async () => {
      await current.submit('B', 1);
    });
    expect(current.blocked).toBe(true);
    await act(async () => {
      await current.confirm();
    });
    expect(current.blocked).toBe(false);
    expect(current.errorCode).toBe('session_operation_forbidden');
    expect(sessionStorage.length).toBe(0);
  });

  it('releases a lost-ACK intent when confirm replay meets a revision conflict', async () => {
    vi.mocked(provider.cwdChange!.submit)
      .mockRejectedValueOnce(new TypeError('lost ACK'))
      .mockRejectedValueOnce(
        new JavaManagedAgentHttpError(
          409,
          'context_revision_conflict',
          'conflict',
        ),
      );
    await render();
    await act(async () => {
      await current.submit('B', 1);
    });
    expect(current.blocked).toBe(true);
    await act(async () => {
      await current.confirm();
    });
    expect(current.blocked).toBe(false);
    expect(current.errorCode).toBe('context_revision_conflict');
    expect(sessionStorage.length).toBe(0);
    expect(refresh).toHaveBeenCalled();
  });

  it('ignores a delayed operation response after selecting another Session', async () => {
    let finish!: (value: ManagedCwdOperation) => void;
    vi.mocked(provider.cwdChange!.submit).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    let run!: ReturnType<typeof current.submit>;
    await act(async () => {
      run = current.submit('B', 1);
    });
    await render({ ...summary, sessionId: 's2' });
    await act(async () => {
      finish(operation);
      await run;
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(current.blocked).toBe(false);
    expect(
      sessionStorage.getItem('qwen-managed-cwd:tenant:actor:s1'),
    ).not.toBeNull();
  });

  it('refuses POST if initial storage is unavailable', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('disabled');
      },
      removeItem: () => {},
    });
    await render();
    await act(async () => {
      await current.submit('B', 1);
    });
    expect(provider.cwdChange!.submit).not.toHaveBeenCalled();
    expect(current.errorCode).toBe('storage_unavailable');
  });

  it('serializes same-tick submissions and ignores the old account response', async () => {
    let finish!: (value: ManagedCwdOperation) => void;
    const submit = vi.mocked(provider.cwdChange!.submit).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    let first!: ReturnType<typeof current.submit>;
    await act(async () => {
      first = current.submit('B', 1);
      await current.submit('C', 1);
    });
    expect(submit).toHaveBeenCalledOnce();
    provider = { ...provider, storageKey: 'other-tenant:other-actor' };
    await render();
    await act(async () => {
      finish(operation);
      await first;
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(current.blocked).toBe(false);
    expect(
      sessionStorage.getItem('qwen-managed-cwd:tenant:actor:s1'),
    ).not.toBeNull();
    expect(
      sessionStorage.getItem('qwen-managed-cwd:other-tenant:other-actor:s1'),
    ).toBeNull();
  });

  it('retains the original intent if saving the acknowledged operation fails', async () => {
    vi.useFakeTimers();
    const browserStorage = sessionStorage;
    let writes = 0;
    let failWrites = true;
    vi.stubGlobal('sessionStorage', {
      getItem: browserStorage.getItem.bind(browserStorage),
      removeItem: browserStorage.removeItem.bind(browserStorage),
      setItem: (key: string, value: string) => {
        if (++writes > 1 && failWrites) throw new Error('quota');
        browserStorage.setItem(key, value);
      },
    });
    vi.mocked(provider.cwdChange!.submit).mockResolvedValueOnce({
      ...operation,
      status: 'pending',
      resultContextRevision: null,
    });
    vi.mocked(provider.cwdChange!.query).mockRejectedValueOnce(
      new Error('offline'),
    );
    await render();
    let first!: ReturnType<typeof current.submit>;
    await act(async () => {
      first = current.submit('B', 1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await first;
    });
    const key = vi.mocked(provider.cwdChange!.submit).mock.calls[0][2]
      .idempotencyKey;
    expect(current.blocked).toBe(true);
    expect(
      JSON.parse(sessionStorage.getItem('qwen-managed-cwd:tenant:actor:s1')!),
    ).toEqual({
      sessionId: 's1',
      workspaceId: 'ws',
      cwdRelative: 'B',
      expectedContextRevision: 1,
      idempotencyKey: key,
    });
    failWrites = false;
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await render();
    expect(provider.cwdChange!.submit).toHaveBeenCalledOnce();
    await act(async () => {
      await current.confirm();
    });
    expect(
      vi.mocked(provider.cwdChange!.submit).mock.calls[1][2].idempotencyKey,
    ).toBe(key);
    expect(current.blocked).toBe(false);
  });

  it('releases a terminal failed operation and keeps the target and reason', async () => {
    vi.mocked(provider.cwdChange!.submit).mockResolvedValue({
      ...operation,
      status: 'failed',
      resultContextRevision: null,
      failureCode: 'invalid_cwd',
    });
    await render();
    await act(async () => {
      await current.submit('B', 1);
    });
    expect(current.blocked).toBe(false);
    expect(current.target).toBe('B');
    expect(current.errorCode).toBe('invalid_cwd');
    expect(refresh).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });

  it('refreshes a definite revision conflict and retains the target for a new action', async () => {
    vi.mocked(provider.cwdChange!.submit).mockRejectedValue(
      new JavaManagedAgentHttpError(409, 'context_revision_conflict', 'stale'),
    );
    await render();
    await act(async () => {
      await current.submit('B', 1);
    });
    expect(current.blocked).toBe(false);
    expect(current.target).toBe('B');
    expect(current.errorCode).toBe('context_revision_conflict');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('bounds polling at 30 seconds without treating pending as failure or resubmitting', async () => {
    vi.useFakeTimers();
    vi.mocked(provider.cwdChange!.submit).mockResolvedValue({
      ...operation,
      status: 'pending',
      resultContextRevision: null,
    });
    vi.mocked(provider.cwdChange!.query).mockResolvedValue({
      ...operation,
      status: 'installing',
      resultContextRevision: null,
    });
    await render();
    let run!: ReturnType<typeof current.submit>;
    await act(async () => {
      run = current.submit('B', 1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await run;
    });
    expect(current.blocked).toBe(true);
    expect(current.busy).toBe(false);
    expect(current.errorCode).toBe('unconfirmed');
    expect(provider.cwdChange!.submit).toHaveBeenCalledOnce();
  });
});
