// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedSessionModels,
} from './managed-agent-provider';
import { useManagedModelChange } from './use-managed-model-change';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const summary: ManagedAgentSessionSummary = {
  sessionId: 's1',
  title: 'Task',
  createdAt: 1,
  updatedAt: 1,
  admittedAt: 1,
  phase: 'completed',
  runtimeReady: true,
  runtimeState: 'ready',
  workspace: { workspaceId: 'workspace', cwdRelative: '.' },
  capabilities: { canSend: true, canCancel: false, modelChange: true },
};
const options: ManagedSessionModels = {
  supported: true,
  modelSelection: { revision: 0 },
  models: [
    { modelId: 'A', label: 'Model A' },
    { modelId: 'B', label: 'Model B' },
  ],
};
const result = {
  sessionId: 's1',
  modelSelection: { modelId: 'B', revision: 1 },
  replayed: false,
};
const changed = { ...summary, modelSelection: result.modelSelection };
const key = 'qwen-managed-model:tenant:actor:s1';

describe('useManagedModelChange', () => {
  let root: Root;
  let current: ReturnType<typeof useManagedModelChange>;
  let provider: ManagedAgentProvider;
  let refresh: ReturnType<typeof vi.fn>;
  function Probe({
    session = summary,
    interactive = true,
  }: {
    session?: ManagedAgentSessionSummary;
    interactive?: boolean;
  }) {
    current = useManagedModelChange(
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
      modelChange: {
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
    vi.mocked(provider.modelChange!.submit).mockImplementation(
      async (_id, request, command) => {
        expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({
          sessionId: 's1',
          ...request,
          idempotencyKey: command.idempotencyKey,
        });
        return result;
      },
    );
    await render();
    let pending!: ReturnType<typeof current.submit>;
    await act(async () => {
      pending = current.submit('B');
      expect(current.isBlocked()).toBe(true);
      void current.submit('A');
    });
    expect(current.blocked).toBe(true);
    expect(provider.modelChange!.submit).toHaveBeenCalledOnce();
    await act(async () => {
      read.resolve(changed);
      await pending;
    });
    expect(current.blocked).toBe(false);
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('restores a lost ACK after refresh and retries the exact frozen request only on confirmation', async () => {
    vi.mocked(provider.modelChange!.submit).mockRejectedValueOnce(
      new TypeError('lost response'),
    );
    await render();
    await act(async () => {
      await current.submit('B');
    });
    const saved: unknown = JSON.parse(sessionStorage.getItem(key)!);
    expect(current.errorCode).toBe('unconfirmed');
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await render();
    expect(provider.modelChange!.submit).toHaveBeenCalledOnce();
    expect(current.pending).toEqual(saved);
    await act(async () => {
      await current.confirm();
    });
    const calls = vi.mocked(provider.modelChange!.submit).mock.calls;
    expect(calls[1][0]).toBe(calls[0][0]);
    expect(calls[1][1]).toEqual(calls[0][1]);
    expect(calls[1][2].idempotencyKey).toBe(calls[0][2].idempotencyKey);
    expect(current.blocked).toBe(false);
  });

  it.each([
    'model_selection_conflict',
    'turn_active',
    'session_context_busy',
    'unsupported_model',
    'session_operation_forbidden',
  ])(
    'releases a definitively refused key and refreshes options without resubmission (%s)',
    async (code) => {
      vi.mocked(provider.modelChange!.submit).mockRejectedValue(
        new JavaManagedAgentHttpError(409, code, code),
      );
      await render();
      await act(async () => {
        await current.submit('B');
      });
      expect(current.blocked).toBe(false);
      expect(current.errorCode).toBe(code);
      expect(provider.modelChange!.submit).toHaveBeenCalledOnce();
      expect(provider.modelChange!.queryOptions).toHaveBeenCalledTimes(2);
      expect(refresh).toHaveBeenCalledOnce();
    },
  );

  it.each([401, 404, 500, 409])(
    'retains an uncertain key after authentication, availability or idempotency failures (%s)',
    async (status) => {
      vi.mocked(provider.modelChange!.submit).mockRejectedValue(
        new JavaManagedAgentHttpError(
          status,
          'idempotency_conflict',
          'uncertain',
        ),
      );
      await render();
      await act(async () => {
        await current.submit('B');
      });
      expect(current.blocked).toBe(true);
      expect(current.errorCode).toBe('unconfirmed');
      expect(sessionStorage.getItem(key)).not.toBeNull();
    },
  );

  it('keeps an acknowledged request frozen if the readback is stale or names the wrong model', async () => {
    refresh.mockResolvedValue(summary);
    await render();
    await act(async () => {
      await current.submit('B');
    });
    const saved = sessionStorage.getItem(key);
    expect(current.blocked).toBe(true);
    refresh.mockResolvedValue({
      ...changed,
      modelSelection: { modelId: 'A', revision: 1 },
    });
    await act(async () => {
      await current.confirm();
    });
    expect(sessionStorage.getItem(key)).toBe(saved);
    refresh.mockResolvedValue({
      ...changed,
      modelSelection: { modelId: 'A', revision: 2 },
    });
    await act(async () => {
      await current.confirm();
    });
    expect(current.blocked).toBe(false);
  });

  it('ignores stale options from another Session and never changes its selection', async () => {
    const first = deferred<ManagedSessionModels>();
    vi.mocked(provider.modelChange!.queryOptions).mockImplementation((id) =>
      id === 's1'
        ? first.promise
        : Promise.resolve({
            ...options,
            models: [{ modelId: 'new', label: 'New' }],
          }),
    );
    await render();
    expect(current.optionsLoading).toBe(true);
    const staleSubmit = current.submit;
    await render({ ...summary, sessionId: 's2' });
    await act(async () => {
      first.resolve(options);
    });
    expect(current.options?.models).toEqual([{ modelId: 'new', label: 'New' }]);
    await act(async () => {
      await staleSubmit('new');
    });
    expect(provider.modelChange!.submit).not.toHaveBeenCalled();
  });

  it('does not submit when storage cannot retain the original operation', async () => {
    await render();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('unavailable');
    });
    await act(async () => {
      await current.submit('B');
    });
    expect(provider.modelChange!.submit).not.toHaveBeenCalled();
    expect(current.errorCode).toBe('storage_unavailable');
  });

  it('fails closed for missing capability, active Turns, unsupported options and arbitrary models', async () => {
    await render({
      ...summary,
      capabilities: { ...summary.capabilities, modelChange: undefined },
    });
    expect(provider.modelChange!.queryOptions).not.toHaveBeenCalled();
    await act(async () => {
      await current.submit('B');
    });
    await render({ ...summary, phase: 'agent_running' });
    await act(async () => {
      await current.submit('B');
    });
    await render();
    await act(async () => {
      await current.submit('arbitrary-route');
    });
    vi.mocked(provider.modelChange!.queryOptions).mockResolvedValue({
      ...options,
      supported: false,
    });
    await act(async () => current.reloadOptions());
    await act(async () => {
      await current.submit('B');
    });
    expect(provider.modelChange!.submit).not.toHaveBeenCalled();
  });

  it('does not fetch or submit while hidden and can confirm a frozen receipt after capability withdrawal', async () => {
    await render(summary, false);
    expect(provider.modelChange!.queryOptions).not.toHaveBeenCalled();
    await act(async () => {
      await current.submit('B');
    });
    expect(provider.modelChange!.submit).not.toHaveBeenCalled();
    sessionStorage.setItem(
      key,
      JSON.stringify({
        sessionId: 's1',
        modelId: 'B',
        expectedRevision: 0,
        idempotencyKey: 'original',
      }),
    );
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await render({
      ...summary,
      capabilities: { ...summary.capabilities, modelChange: undefined },
    });
    await act(async () => {
      await current.confirm();
    });
    expect(provider.modelChange!.submit).toHaveBeenCalledWith(
      's1',
      { modelId: 'B', expectedRevision: 0 },
      expect.objectContaining({ idempotencyKey: 'original' }),
    );
    expect(current.pending).toBeUndefined();
  });

  it('confirms the original receipt after another Turn becomes active without admitting a new selection', async () => {
    vi.mocked(provider.modelChange!.submit).mockRejectedValueOnce(
      new TypeError('lost response'),
    );
    await render();
    await act(async () => {
      await current.submit('B');
    });
    const original = current.pending!;
    await render({
      ...summary,
      phase: 'agent_running',
      capabilities: {
        ...summary.capabilities,
        canSend: false,
        modelChange: false,
      },
    });
    await act(async () => {
      await current.submit('A');
      await current.confirm();
    });
    expect(provider.modelChange!.submit).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(provider.modelChange!.submit).mock.calls[1][2].idempotencyKey,
    ).toBe(original.idempotencyKey);
    expect(current.pending).toBeUndefined();
  });
});
