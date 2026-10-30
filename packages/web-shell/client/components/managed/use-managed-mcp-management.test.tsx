// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagedAgentProvider } from './managed-agent-provider';
import type { ManagedMcpManagementSnapshot } from './managed-mcp-management-types';
import { useManagedMcpManagement } from './use-managed-mcp-management';

const pin = {
  serverId: 'docs',
  serverRevision: 1,
  definitionDigest: 'a'.repeat(64),
};
const snapshot = (sessionId = 'session-a'): ManagedMcpManagementSnapshot => ({
  sessionId,
  revision: 0,
  supported: true,
  availableServers: [{ ...pin, transport: 'stdio' }],
  servers: [{ ...pin, state: 'enabled' }],
});
let root: Root;
let provider: ManagedAgentProvider;
let sessionId: string | undefined;
let workspaceId: string | undefined;
let clientId: string;
let current: ReturnType<typeof useManagedMcpManagement>;
function Probe() {
  current = useManagedMcpManagement(provider, clientId, workspaceId, sessionId);
  return null;
}
const render = (strict = false) =>
  act(async () =>
    root.render(
      strict ? (
        <StrictMode>
          <Probe />
        </StrictMode>
      ) : (
        <Probe />
      ),
    ),
  );

beforeEach(() => {
  sessionStorage.clear();
  root = createRoot(document.createElement('div'));
  sessionId = 'session-a';
  workspaceId = 'workspace';
  clientId = 'client';
  provider = {
    storageKey: 'tenant:actor',
    mcpManagement: {
      query: vi.fn().mockImplementation(async (id: string) => snapshot(id)),
      submit: vi.fn(),
      operation: vi.fn(),
    },
    mcp: {
      list: vi.fn().mockImplementation(async (id: string) => ({
        object: 'agent.mcp_catalog',
        session_id: id,
        servers: [],
      })),
    },
  } as unknown as ManagedAgentProvider;
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

it('loads the target under StrictMode and keeps catalog metadata separate', async () => {
  await render(true);
  expect(current.snapshot).toEqual(snapshot());
  expect(current.catalog?.session_id).toBe(sessionId);
  expect(current.busy).toBe(false);
  expect(current.error).toBeUndefined();
  expect(provider.mcpManagement!.submit).not.toHaveBeenCalled();
});

it('retains inventory after operation responses and allows a full refresh to clear it', async () => {
  const pending: ManagedMcpManagementSnapshot = {
    ...snapshot(),
    availableServers: [],
    revision: 1,
    operation: {
      operationId: 'original',
      action: 'restart',
      serverId: pin.serverId,
      revision: 1,
      state: 'recovery_required',
    },
  };
  const settled: ManagedMcpManagementSnapshot = {
    ...pending,
    operation: { ...pending.operation!, state: 'settled' },
  };
  vi.mocked(provider.mcpManagement!.submit)
    .mockResolvedValueOnce(pending)
    .mockResolvedValueOnce(settled);
  vi.mocked(provider.mcpManagement!.operation).mockResolvedValue(pending);
  await render();
  await act(async () => current.submit('restart', pin.serverId));
  expect(current.snapshot?.availableServers).toEqual(
    snapshot().availableServers,
  );
  await act(async () => current.retry());
  expect(provider.mcpManagement!.operation).toHaveBeenCalledTimes(1);
  expect(provider.mcpManagement!.submit).toHaveBeenCalledTimes(2);
  expect(current.snapshot?.availableServers).toEqual(
    snapshot().availableServers,
  );
  vi.mocked(provider.mcpManagement!.query).mockResolvedValue(settled);
  await act(async () => current.refresh());
  expect(current.snapshot?.availableServers).toEqual([]);
});

it('does not reuse inventory from another Session when its query is empty', async () => {
  await render();
  expect(current.snapshot?.availableServers).toEqual(
    snapshot().availableServers,
  );
  sessionId = 'session-b';
  vi.mocked(provider.mcpManagement!.query).mockResolvedValue({
    ...snapshot('session-b'),
    availableServers: [],
  });
  await render();
  expect(current.snapshot?.sessionId).toBe('session-b');
  expect(current.snapshot?.availableServers).toEqual([]);
});

it('reuses the command identity after a lost reply, then accepts its settled original operation without resubmitting', async () => {
  const pending: ManagedMcpManagementSnapshot = {
    ...snapshot(),
    revision: 1,
    servers: [{ ...pin, state: 'disabled' }],
    operation: {
      operationId: 'original-operation',
      action: 'disable',
      serverId: pin.serverId,
      revision: 1,
      state: 'pending',
    },
  };
  vi.mocked(provider.mcpManagement!.submit)
    .mockRejectedValueOnce(new TypeError('reply lost'))
    .mockResolvedValueOnce(pending);
  vi.mocked(provider.mcpManagement!.operation).mockResolvedValue({
    ...pending,
    availableServers: [],
    operation: { ...pending.operation!, state: 'settled' },
  });
  await render();
  await act(async () => current.submit('disable', pin.serverId));
  expect(current.needsRetry).toBe(true);
  expect(current.error).toContain('reply lost');
  const first = vi.mocked(provider.mcpManagement!.submit).mock.calls[0];
  await act(async () => current.retry());
  const second = vi.mocked(provider.mcpManagement!.submit).mock.calls[1];
  expect(second[1]).toEqual(first[1]);
  expect(second[2].idempotencyKey).toBe(first[2].idempotencyKey);
  expect(second[2].requestId).toBe(first[2].requestId);
  expect(first[1]).toEqual({
    action: 'disable',
    serverId: pin.serverId,
    expectedRevision: 0,
  });
  await act(async () => current.retry());
  expect(provider.mcpManagement!.submit).toHaveBeenCalledTimes(2);
  expect(provider.mcpManagement!.operation).toHaveBeenCalledWith(
    'session-a',
    'original-operation',
    expect.objectContaining({ clientId }),
  );
  expect(current.needsRetry).toBe(false);
  expect(current.snapshot?.servers[0].state).toBe('disabled');
  expect(current.snapshot?.availableServers).toEqual(
    snapshot().availableServers,
  );
});

it.each(['pending', 'recovery_required'] as const)(
  'explicitly resumes a %s operation using the original command only after its status query succeeds',
  async (state) => {
    const pending: ManagedMcpManagementSnapshot = {
      ...snapshot(),
      revision: 1,
      operation: {
        operationId: 'original',
        action: 'restart',
        serverId: pin.serverId,
        revision: 1,
        state,
      },
    };
    const settled = {
      ...pending,
      operation: { ...pending.operation!, state: 'settled' as const },
    };
    vi.mocked(provider.mcpManagement!.submit)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(settled);
    vi.mocked(provider.mcpManagement!.operation).mockResolvedValue(pending);
    await render();
    await act(async () => current.submit('restart', pin.serverId));
    const first = vi.mocked(provider.mcpManagement!.submit).mock.calls[0];
    expect(current.canResume).toBe(true);
    vi.mocked(provider.mcpManagement!.query).mockResolvedValue(pending);
    await act(async () => current.refresh());
    expect(provider.mcpManagement!.submit).toHaveBeenCalledTimes(1);
    await act(async () => current.retry());
    const second = vi.mocked(provider.mcpManagement!.submit).mock.calls[1];
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toEqual(first[1]);
    expect(second[2].requestId).toBe(first[2].requestId);
    expect(second[2].idempotencyKey).toBe(first[2].idempotencyKey);
    expect(
      vi.mocked(provider.mcpManagement!.operation).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(provider.mcpManagement!.submit).mock.invocationCallOrder[1],
    );
    expect(current.snapshot?.operation?.state).toBe('settled');
    expect(current.needsRetry).toBe(false);
    expect(current.canResume).toBe(false);
  },
);

it('retains a lost command identity when the manager is closed and reopened', async () => {
  vi.mocked(provider.mcpManagement!.submit).mockRejectedValue(
    new TypeError('offline'),
  );
  await render();
  await act(async () => current.submit('restart', pin.serverId));
  const first = vi.mocked(provider.mcpManagement!.submit).mock.calls[0];
  await act(async () => root.render(null));
  await render();
  expect(current.needsRetry).toBe(true);
  await act(async () => current.retry());
  const retried = vi.mocked(provider.mcpManagement!.submit).mock.calls[1];
  expect(retried[1]).toEqual(first[1]);
  expect(retried[2].idempotencyKey).toBe(first[2].idempotencyKey);
});

it('does not attach another Session operation to the saved original command', async () => {
  vi.mocked(provider.mcpManagement!.submit)
    .mockResolvedValueOnce({
      ...snapshot('session-b'),
      revision: 1,
      operation: {
        operationId: 'another-session-operation',
        action: 'restart',
        serverId: pin.serverId,
        revision: 1,
        state: 'pending',
      },
    })
    .mockRejectedValueOnce(new TypeError('offline'));
  await render();
  await act(async () => current.submit('restart', pin.serverId));
  expect(current.error).toContain('identity mismatch');
  await act(async () => current.retry());
  const calls = vi.mocked(provider.mcpManagement!.submit).mock.calls;
  expect(calls[1][1]).toEqual(calls[0][1]);
  expect(calls[1][2].idempotencyKey).toBe(calls[0][2].idempotencyKey);
  expect(provider.mcpManagement!.operation).not.toHaveBeenCalled();
});

it('allows a new command after its first submission was definitively rejected', async () => {
  vi.mocked(provider.mcpManagement!.submit).mockRejectedValue(
    Object.assign(new Error('stale revision'), { status: 409 }),
  );
  await render();
  await act(async () => current.submit('restart', pin.serverId));
  expect(current.needsRetry).toBe(false);
  expect(current.canResume).toBe(false);
  await act(async () => current.submit('reload', pin.serverId));
  const calls = vi.mocked(provider.mcpManagement!.submit).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[1][2].idempotencyKey).not.toBe(calls[0][2].idempotencyKey);
});

it('preserves an unknown original command across a refused retry and provider rebuild', async () => {
  provider = {
    ...provider,
    mcpManagement: { ...provider.mcpManagement!, storageScope: 'tenant:actor' },
  };
  vi.mocked(provider.mcpManagement!.submit)
    .mockRejectedValueOnce(new TypeError('reply lost'))
    .mockRejectedValueOnce(
      Object.assign(new Error('permission changed'), { status: 403 }),
    )
    .mockRejectedValueOnce(new TypeError('still offline'));
  await render();
  await act(async () => current.submit('restart', pin.serverId));
  const first = vi.mocked(provider.mcpManagement!.submit).mock.calls[0];
  await act(async () => current.retry());
  expect(current.needsRetry).toBe(true);
  expect(sessionStorage.length).toBe(1);
  await act(async () => root.render(null));
  provider = { ...provider, mcpManagement: { ...provider.mcpManagement! } };
  await render();
  await act(async () => current.submit('remove', pin.serverId));
  expect(provider.mcpManagement!.submit).toHaveBeenCalledTimes(2);
  await act(async () => current.retry());
  const retried = vi.mocked(provider.mcpManagement!.submit).mock.calls[2];
  expect(retried[1]).toEqual(first[1]);
  expect(retried[2].idempotencyKey).toBe(first[2].idempotencyKey);
  expect(retried[2].requestId).toBe(first[2].requestId);
});

it.each([
  ['pending', 'settled'],
  ['recovery_required', 'settled'],
  ['pending', 'failed'],
] as const)(
  'restores a %s command after rebuilding the provider and retains its identity until %s',
  async (state, terminal) => {
    provider = {
      ...provider,
      mcpManagement: {
        ...provider.mcpManagement!,
        storageScope: 'tenant:actor',
      },
    };
    const pending: ManagedMcpManagementSnapshot = {
      ...snapshot(),
      revision: 1,
      operation: {
        operationId: '00000000-0000-4000-8000-000000000001',
        action: 'restart',
        serverId: pin.serverId,
        revision: 1,
        state,
      },
    };
    vi.mocked(provider.mcpManagement!.submit)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({
        ...pending,
        operation: { ...pending.operation!, state: terminal },
      });
    vi.mocked(provider.mcpManagement!.operation).mockResolvedValue(pending);
    await render();
    await act(async () => current.submit('restart', pin.serverId));
    const first = vi.mocked(provider.mcpManagement!.submit).mock.calls[0];
    expect(sessionStorage.length).toBe(1);
    await act(async () => root.render(null));
    provider = { ...provider, mcpManagement: { ...provider.mcpManagement! } };
    vi.mocked(provider.mcpManagement!.query).mockResolvedValue(pending);
    await render();
    expect(current.canResume).toBe(true);
    expect(provider.mcpManagement!.submit).toHaveBeenCalledTimes(1);
    await act(async () => current.retry());
    const second = vi.mocked(provider.mcpManagement!.submit).mock.calls[1];
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toEqual(first[1]);
    expect(second[2].requestId).toBe(first[2].requestId);
    expect(second[2].idempotencyKey).toBe(first[2].idempotencyKey);
    expect(provider.mcpManagement!.operation).toHaveBeenCalledWith(
      'session-a',
      pending.operation!.operationId,
      expect.anything(),
    );
    expect(current.needsRetry).toBe(false);
    expect(sessionStorage.length).toBe(0);
  },
);

it('retains the command in memory if this tab cannot save to storage', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage disabled', 'SecurityError');
  });
  provider = {
    ...provider,
    mcpManagement: { ...provider.mcpManagement!, storageScope: 'tenant:actor' },
  };
  vi.mocked(provider.mcpManagement!.submit).mockRejectedValue(
    new TypeError('offline'),
  );
  await render();
  await act(async () => current.submit('restart', pin.serverId));
  await act(async () => current.retry());
  const calls = vi.mocked(provider.mcpManagement!.submit).mock.calls;
  expect(calls[1][1]).toEqual(calls[0][1]);
  expect(calls[1][2].idempotencyKey).toBe(calls[0][2].idempotencyKey);
  expect(current.canResume).toBe(true);
});

it('does not clear an unsettled command when its status query is refused', async () => {
  const pending: ManagedMcpManagementSnapshot = {
    ...snapshot(),
    operation: {
      operationId: 'original',
      action: 'restart',
      serverId: pin.serverId,
      revision: 1,
      state: 'pending',
    },
  };
  vi.mocked(provider.mcpManagement!.submit).mockResolvedValue(pending);
  vi.mocked(provider.mcpManagement!.operation).mockRejectedValue(
    Object.assign(new Error('permission changed'), { status: 403 }),
  );
  await render();
  await act(async () => current.submit('restart', pin.serverId));
  await act(async () => current.retry());
  expect(current.needsRetry).toBe(true);
  expect(current.canResume).toBe(true);
  expect(current.error).toContain('permission changed');
  expect(provider.mcpManagement!.submit).toHaveBeenCalledTimes(1);
  await act(async () => current.submit('remove', pin.serverId));
  expect(provider.mcpManagement!.submit).toHaveBeenCalledTimes(1);
});

it('does not resume an original command after a Session switch during its status query', async () => {
  const pending: ManagedMcpManagementSnapshot = {
    ...snapshot(),
    revision: 1,
    operation: {
      operationId: 'original',
      action: 'restart',
      serverId: pin.serverId,
      revision: 1,
      state: 'recovery_required',
    },
  };
  let release!: (value: ManagedMcpManagementSnapshot) => void;
  vi.mocked(provider.mcpManagement!.submit).mockResolvedValue(pending);
  vi.mocked(provider.mcpManagement!.operation).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await render();
  await act(async () => current.submit('restart', pin.serverId));
  let retry!: Promise<void>;
  await act(async () => {
    retry = current.retry();
  });
  const signal = vi.mocked(provider.mcpManagement!.operation).mock.calls[0][2]
    .signal!;
  sessionId = 'session-b';
  await render();
  expect(signal.aborted).toBe(true);
  await act(async () => {
    release(pending);
    await retry;
  });
  expect(provider.mcpManagement!.submit).toHaveBeenCalledTimes(1);
  expect(current.snapshot?.sessionId).toBe('session-b');
  expect(current.needsRetry).toBe(false);
});

it('discards a late mutation response and keeps its retry on the original Session', async () => {
  let release!: (value: ManagedMcpManagementSnapshot) => void;
  vi.mocked(provider.mcpManagement!.submit).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await render();
  let pending!: Promise<void>;
  await act(async () => {
    pending = current.submit('restart', pin.serverId);
  });
  const first = vi.mocked(provider.mcpManagement!.submit).mock.calls[0];
  sessionId = 'session-b';
  await render();
  expect(first[2].signal?.aborted).toBe(true);
  await act(async () => {
    release({
      ...snapshot(),
      revision: 20,
      operation: {
        operationId: 'original',
        action: 'restart',
        serverId: pin.serverId,
        revision: 20,
        state: 'settled',
      },
    });
    await pending;
  });
  expect(current.snapshot?.sessionId).toBe('session-b');
  expect(current.snapshot?.revision).toBe(0);
  sessionId = 'session-a';
  vi.mocked(provider.mcpManagement!.submit).mockRejectedValueOnce(
    new TypeError('offline'),
  );
  await render();
  expect(current.needsRetry).toBe(true);
  await act(async () => current.retry());
  const retried = vi.mocked(provider.mcpManagement!.submit).mock.calls[1];
  expect(retried[0]).toBe('session-a');
  expect(retried[2].idempotencyKey).toBe(first[2].idempotencyKey);
});

it.each(['session', 'provider', 'client', 'workspace', 'unmount'] as const)(
  'aborts a query and discards its late response after %s changes',
  async (change) => {
    let release!: (value: ManagedMcpManagementSnapshot) => void;
    vi.mocked(provider.mcpManagement!.query).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await render();
    const previous = current;
    const oldApi = provider.mcpManagement!;
    const signal = vi.mocked(oldApi.query).mock.calls[0][1].signal!;
    if (change === 'session') sessionId = 'session-b';
    if (change === 'provider') provider = { ...provider };
    if (change === 'client') clientId = 'new-client';
    if (change === 'workspace') workspaceId = 'new-workspace';
    if (change === 'unmount') await act(async () => root.render(null));
    else await render();
    expect(signal.aborted).toBe(true);
    await act(async () => release({ ...snapshot(), revision: 99 }));
    if (change !== 'unmount') {
      expect(current.snapshot?.revision).toBe(0);
      expect(current.snapshot?.sessionId).toBe(sessionId);
      expect(current.error).toBeUndefined();
    }
    await act(async () => previous.submit('restart', pin.serverId));
    expect(oldApi.submit).not.toHaveBeenCalled();
  },
);

it('queries a recovery-required original command and prevents fresh mutations', async () => {
  const pending = {
    ...snapshot(),
    operation: {
      operationId: 'recover-original',
      action: 'restart' as const,
      serverId: pin.serverId,
      revision: 0,
      state: 'recovery_required' as const,
    },
  };
  vi.mocked(provider.mcpManagement!.query).mockResolvedValue(pending);
  vi.mocked(provider.mcpManagement!.operation).mockResolvedValue(pending);
  await render();
  await act(async () => current.submit('remove', pin.serverId));
  expect(provider.mcpManagement!.submit).not.toHaveBeenCalled();
  await act(async () => current.retry());
  expect(provider.mcpManagement!.operation).toHaveBeenCalledWith(
    'session-a',
    'recover-original',
    expect.anything(),
  );
  expect(current.needsRetry).toBe(true);
  expect(current.canResume).toBe(false);
});

it('does not issue requests without the selected Session, Workspace or provider capability', async () => {
  sessionId = undefined;
  await render();
  expect(provider.mcpManagement!.query).not.toHaveBeenCalled();
  sessionId = 'session-a';
  workspaceId = undefined;
  await render();
  expect(provider.mcpManagement!.query).not.toHaveBeenCalled();
  provider = { ...provider, mcpManagement: undefined };
  workspaceId = 'workspace';
  await render();
  expect(current.snapshot).toBeUndefined();
});
