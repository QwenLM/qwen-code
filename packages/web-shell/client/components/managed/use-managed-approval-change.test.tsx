// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedSessionApproval,
} from './managed-agent-provider';
import { useManagedApprovalChange } from './use-managed-approval-change';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const summary: ManagedAgentSessionSummary = {
  sessionId: 's1',
  agentId: `agent_${'a'.repeat(32)}`,
  approvalMode: 'default',
  approvalRevision: 0,
  title: 'Task',
  createdAt: 1,
  updatedAt: 1,
  admittedAt: 1,
  phase: 'completed',
  runtimeReady: true,
  runtimeState: 'ready',
  workspace: { workspaceId: 'workspace', cwdRelative: '.' },
  capabilities: { canSend: true, canCancel: false, approvalModeChange: true },
};
const options: ManagedSessionApproval = {
  supported: true,
  approvalMode: 'default',
  approvalRevision: 0,
  availableApprovalModes: ['default', 'auto-edit', 'yolo'],
};
const result = {
  sessionId: 's1',
  approvalMode: 'yolo' as const,
  approvalRevision: 1,
  replayed: false,
};
const changed = {
  ...summary,
  approvalMode: result.approvalMode,
  approvalRevision: result.approvalRevision,
};
const key = 'qwen-managed-approval:tenant:actor:s1';

describe('useManagedApprovalChange', () => {
  let root: Root;
  let current: ReturnType<typeof useManagedApprovalChange>;
  let provider: ManagedAgentProvider;
  let refresh: ReturnType<typeof vi.fn>;
  function Probe({
    session = summary,
    interactive = true,
  }: {
    session?: ManagedAgentSessionSummary;
    interactive?: boolean;
  }) {
    current = useManagedApprovalChange(
      provider,
      'client',
      session.sessionId,
      session,
      refresh,
      interactive,
    );
    return null;
  }
  async function render(session = summary, interactive = true) {
    await act(async () => {
      root.render(<Probe session={session} interactive={interactive} />);
    });
  }
  beforeEach(() => {
    sessionStorage.clear();
    root = createRoot(document.createElement('div'));
    provider = {
      storageKey: 'tenant:actor',
      approvalChange: {
        queryOptions: vi.fn().mockResolvedValue(options),
        submit: vi.fn().mockResolvedValue(result),
      },
    } as unknown as ManagedAgentProvider;
    refresh = vi.fn().mockResolvedValue(changed);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
  });

  it('persists before sending and keeps the lock until an acknowledged revision is read back', async () => {
    const read = deferred<ManagedAgentSessionSummary>();
    refresh.mockReturnValue(read.promise);
    vi.mocked(provider.approvalChange!.submit).mockImplementation(
      async (_id, request, command) => {
        expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({
          sessionId: 's1',
          ...request,
          idempotencyKey: command.idempotencyKey,
          requestId: command.requestId,
        });
        return result;
      },
    );
    await render();
    let pending!: ReturnType<typeof current.submit>;
    await act(async () => {
      pending = current.submit('yolo');
      expect(current.isBlocked()).toBe(true);
      void current.submit('default');
    });
    expect(current.blocked).toBe(true);
    expect(provider.approvalChange!.submit).toHaveBeenCalledOnce();
    await act(async () => {
      read.resolve(changed);
      await pending;
    });
    expect(current.blocked).toBe(false);
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('persists an independent Plan toggle with the same execution mode and confirms both fields', async () => {
    vi.mocked(provider.approvalChange!.queryOptions).mockResolvedValue({
      ...options,
      planModeSupported: true,
      planMode: false,
    });
    vi.mocked(provider.approvalChange!.submit).mockResolvedValue({
      ...result,
      approvalMode: 'default',
      planMode: true,
    });
    refresh.mockResolvedValue({
      ...summary,
      approvalRevision: 1,
      planMode: true,
    });
    await render();
    await act(async () => {
      await current.submit('default', true);
    });
    expect(provider.approvalChange!.submit).toHaveBeenCalledWith(
      's1',
      { approvalMode: 'default', expectedRevision: 0, planMode: true },
      expect.anything(),
    );
    expect(current.blocked).toBe(false);
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('keeps a Plan receipt unconfirmed if readback reports only the mode and revision', async () => {
    vi.mocked(provider.approvalChange!.queryOptions).mockResolvedValue({
      ...options,
      planModeSupported: true,
    });
    vi.mocked(provider.approvalChange!.submit).mockResolvedValue({
      ...result,
      approvalMode: 'default',
      planMode: true,
    });
    refresh.mockResolvedValue({
      ...summary,
      approvalRevision: 1,
      planMode: false,
    });
    await render();
    await act(async () => {
      await current.submit('default', true);
    });
    expect(current.blocked).toBe(true);
    expect(current.pending?.planMode).toBe(true);
    expect(current.errorCode).toBe('unconfirmed');
  });

  it('restores a lost ACK after refresh and retries the exact frozen request only on confirmation', async () => {
    vi.mocked(provider.approvalChange!.submit).mockRejectedValueOnce(
      new TypeError('lost response'),
    );
    await render();
    await act(async () => {
      await current.submit('yolo');
    });
    const saved: unknown = JSON.parse(sessionStorage.getItem(key)!);
    expect(current.errorCode).toBe('unconfirmed');
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await render();
    expect(provider.approvalChange!.submit).toHaveBeenCalledOnce();
    expect(current.pending).toEqual(saved);
    await act(async () => {
      await current.confirm();
    });
    const calls = vi.mocked(provider.approvalChange!.submit).mock.calls;
    expect(calls[1][0]).toBe(calls[0][0]);
    expect(calls[1][1]).toEqual(calls[0][1]);
    expect(calls[1][2].idempotencyKey).toBe(calls[0][2].idempotencyKey);
    expect(calls[1][2].requestId).toBe(calls[0][2].requestId);
    expect(current.blocked).toBe(false);
  });

  it.each([
    'approval_selection_conflict',
    'turn_active',
    'session_context_busy',
    'unsupported_approval_mode',
    'session_operation_forbidden',
  ])(
    'releases a definitively refused key and refreshes options without resubmission (%s)',
    async (code) => {
      vi.mocked(provider.approvalChange!.submit).mockRejectedValue(
        new JavaManagedAgentHttpError(409, code, code),
      );
      await render();
      await act(async () => {
        await current.submit('yolo');
      });
      expect(current.blocked).toBe(false);
      expect(current.errorCode).toBe(code);
      expect(provider.approvalChange!.submit).toHaveBeenCalledOnce();
      expect(provider.approvalChange!.queryOptions).toHaveBeenCalledTimes(2);
      expect(refresh).toHaveBeenCalledOnce();
    },
  );

  it.each([401, 404, 500, 409])(
    'retains an uncertain key after authentication, availability or idempotency failures (%s)',
    async (status) => {
      vi.mocked(provider.approvalChange!.submit).mockRejectedValue(
        new JavaManagedAgentHttpError(
          status,
          'idempotency_conflict',
          'uncertain',
        ),
      );
      await render();
      await act(async () => {
        await current.submit('yolo');
      });
      expect(current.blocked).toBe(true);
      expect(current.errorCode).toBe('unconfirmed');
      expect(sessionStorage.getItem(key)).not.toBeNull();
    },
  );

  it('keeps an acknowledged request frozen if the readback is stale or names the wrong policy', async () => {
    refresh.mockResolvedValue(summary);
    await render();
    await act(async () => {
      await current.submit('yolo');
    });
    const saved = sessionStorage.getItem(key);
    expect(current.blocked).toBe(true);
    refresh.mockResolvedValue({
      ...changed,
      approvalMode: 'default',
      approvalRevision: 1,
    });
    await act(async () => {
      await current.confirm();
    });
    expect(sessionStorage.getItem(key)).toBe(saved);
    refresh.mockResolvedValue({
      ...changed,
      approvalMode: 'default',
      approvalRevision: 2,
    });
    await act(async () => {
      await current.confirm();
    });
    expect(current.blocked).toBe(false);
  });

  it('ignores stale options from another Session and never changes its selection', async () => {
    const first = deferred<ManagedSessionApproval>();
    vi.mocked(provider.approvalChange!.queryOptions).mockImplementation((id) =>
      id === 's1'
        ? first.promise
        : Promise.resolve({
            ...options,
            availableApprovalModes: ['auto-edit'],
          }),
    );
    await render();
    expect(current.optionsLoading).toBe(true);
    const staleSubmit = current.submit;
    await render({ ...summary, sessionId: 's2' });
    await act(async () => {
      first.resolve(options);
    });
    expect(current.options?.availableApprovalModes).toEqual(['auto-edit']);
    await act(async () => {
      await staleSubmit('auto-edit');
    });
    expect(provider.approvalChange!.submit).not.toHaveBeenCalled();
  });

  it('does not submit when storage cannot retain the original operation', async () => {
    await render();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('unavailable');
    });
    await act(async () => {
      await current.submit('yolo');
    });
    expect(provider.approvalChange!.submit).not.toHaveBeenCalled();
    expect(current.errorCode).toBe('storage_unavailable');
  });

  it('fails closed for missing capability, active Turns and unsupported options', async () => {
    await render({
      ...summary,
      capabilities: { ...summary.capabilities, approvalModeChange: undefined },
    });
    expect(provider.approvalChange!.queryOptions).not.toHaveBeenCalled();
    await act(async () => {
      await current.submit('yolo');
    });
    await render({ ...summary, phase: 'agent_running' });
    await act(async () => {
      await current.submit('yolo');
    });
    vi.mocked(provider.approvalChange!.queryOptions).mockResolvedValue({
      ...options,
      availableApprovalModes: ['default', 'yolo'],
    });
    await render();
    await act(async () => current.reloadOptions());
    await act(async () => {
      await current.submit('auto-edit');
    });
    vi.mocked(provider.approvalChange!.queryOptions).mockResolvedValue({
      ...options,
      supported: false,
    });
    await act(async () => current.reloadOptions());
    await act(async () => {
      await current.submit('yolo');
    });
    expect(provider.approvalChange!.submit).not.toHaveBeenCalled();
  });

  it('does not fetch or submit while hidden and can confirm a frozen receipt after capability withdrawal', async () => {
    await render(summary, false);
    expect(provider.approvalChange!.queryOptions).not.toHaveBeenCalled();
    await act(async () => {
      await current.submit('yolo');
    });
    expect(provider.approvalChange!.submit).not.toHaveBeenCalled();
    sessionStorage.setItem(
      key,
      JSON.stringify({
        sessionId: 's1',
        approvalMode: 'yolo',
        expectedRevision: 0,
        idempotencyKey: 'original',
        requestId: 'original-request',
      }),
    );
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await render({
      ...summary,
      capabilities: { ...summary.capabilities, approvalModeChange: undefined },
    });
    await act(async () => {
      await current.confirm();
    });
    expect(provider.approvalChange!.submit).toHaveBeenCalledWith(
      's1',
      { approvalMode: 'yolo', expectedRevision: 0 },
      expect.objectContaining({ idempotencyKey: 'original' }),
    );
    expect(current.pending).toBeUndefined();
  });

  it('confirms the original receipt after another Turn becomes active without admitting a new selection', async () => {
    vi.mocked(provider.approvalChange!.submit).mockRejectedValueOnce(
      new TypeError('lost response'),
    );
    await render();
    await act(async () => {
      await current.submit('yolo');
    });
    const original = current.pending!;
    await render({
      ...summary,
      phase: 'agent_running',
      capabilities: {
        ...summary.capabilities,
        canSend: false,
        approvalModeChange: false,
      },
    });
    await act(async () => {
      await current.submit('default');
      await current.confirm();
    });
    expect(provider.approvalChange!.submit).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(provider.approvalChange!.submit).mock.calls[1][2]
        .idempotencyKey,
    ).toBe(original.idempotencyKey);
    expect(current.pending).toBeUndefined();
  });
});
