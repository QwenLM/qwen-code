// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedModelChangeResult,
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
const result: ManagedModelChangeResult = {
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

  it.each(['pending', 'failed'])(
    'finishes on the successful receipt while the background summary read is %s',
    async (read) => {
      if (read === 'pending') refresh.mockReturnValue(new Promise(() => {}));
      else refresh.mockRejectedValue(new TypeError('read failed'));
      await render();
      let succeeded: boolean | undefined;
      await act(async () => {
        succeeded = await current.submit('B');
      });
      expect(succeeded).toBe(true);
      expect(current.selection).toEqual(result.modelSelection);
      expect(current.blocked).toBe(false);
      expect(current.isBlocked()).toBe(false);
      expect(current.errorCode).toBeUndefined();
      expect(provider.modelChange!.submit).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledOnce();
      expect(sessionStorage.getItem(key)).toBeNull();
    },
  );

  it('serializes in-flight writes without requiring storage or a second confirmation', async () => {
    const receipt = deferred<ManagedModelChangeResult>();
    vi.mocked(provider.modelChange!.submit).mockReturnValue(receipt.promise);
    await render();
    let write!: ReturnType<typeof current.submit>;
    await act(async () => {
      write = current.submit('B');
      expect(current.isBlocked()).toBe(true);
      void current.submit('A');
    });
    expect(current.blocked).toBe(true);
    expect(provider.modelChange!.submit).toHaveBeenCalledOnce();
    expect(
      vi.mocked(provider.modelChange!.submit).mock.calls[0][2].idempotencyKey,
    ).toEqual(expect.any(String));
    await act(async () => {
      receipt.resolve(result);
      await write;
    });
    expect(current.blocked).toBe(false);
    expect(current.selection).toEqual(result.modelSelection);
  });

  it('releases a timed-out write even when the provider ignores cancellation', async () => {
    vi.mocked(provider.modelChange!.submit).mockReturnValue(
      new Promise(() => {}),
    );
    await render();
    vi.useFakeTimers();
    try {
      let write!: ReturnType<typeof current.submit>;
      await act(async () => {
        write = current.submit('B');
      });
      expect(current.blocked).toBe(true);
      let succeeded: boolean | undefined;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
        succeeded = await write;
      });
      expect(succeeded).toBe(false);
      expect(current.blocked).toBe(false);
      expect(current.isBlocked()).toBe(false);
      expect(current.errorCode).toBe('failed');
      expect(provider.modelChange!.submit).toHaveBeenCalledOnce();
      // The released UI must not leave the abandoned write running.
      expect(
        vi.mocked(provider.modelChange!.submit).mock.calls[0][2].signal.aborted,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not roll back a receipt under stale reads and uses its revision for the next choice', async () => {
    const stale = { ...summary, modelSelection: { modelId: 'A', revision: 0 } };
    refresh.mockResolvedValue(stale);
    await render();
    await act(async () => {
      await current.submit('B');
    });
    await render(stale);
    await act(async () => current.reloadOptions());
    expect(current.selection).toEqual(result.modelSelection);
    vi.mocked(provider.modelChange!.submit).mockResolvedValue({
      sessionId: 's1',
      modelSelection: { modelId: 'A', revision: 2 },
      replayed: false,
    });
    await act(async () => {
      await current.submit('A');
    });
    expect(provider.modelChange!.submit).toHaveBeenLastCalledWith(
      's1',
      { modelId: 'A', expectedRevision: 1 },
      expect.anything(),
    );
    expect(current.selection).toEqual({ modelId: 'A', revision: 2 });
  });

  it('accepts a future model selection while a Turn is running', async () => {
    await render({
      ...summary,
      phase: 'agent_running',
      capabilities: { ...summary.capabilities, canSend: false },
    });
    await act(async () => {
      await current.submit('B');
    });
    expect(provider.modelChange!.submit).toHaveBeenCalledOnce();
    expect(current.selection).toEqual(result.modelSelection);
    expect(current.blocked).toBe(false);
  });

  it('retains the highest catalog revision when summary refresh fails and later catalogs lag', async () => {
    refresh.mockRejectedValue(new TypeError('read failed'));
    await render();
    await act(async () => {
      await current.submit('B');
    });
    vi.mocked(provider.modelChange!.queryOptions).mockResolvedValue({
      ...options,
      modelSelection: { modelId: 'A', revision: 3 },
    });
    await act(async () => current.reloadOptions());
    expect(current.selection).toEqual({ modelId: 'A', revision: 3 });
    vi.mocked(provider.modelChange!.queryOptions).mockResolvedValue({
      ...options,
      modelSelection: { modelId: 'B', revision: 2 },
    });
    await act(async () => current.reloadOptions());
    expect(current.selection).toEqual({ modelId: 'A', revision: 3 });
    vi.mocked(provider.modelChange!.submit).mockResolvedValue({
      sessionId: 's1',
      modelSelection: { modelId: 'B', revision: 4 },
      replayed: false,
    });
    await act(async () => {
      await current.submit('B');
    });
    expect(provider.modelChange!.submit).toHaveBeenLastCalledWith(
      's1',
      { modelId: 'B', expectedRevision: 3 },
      expect.anything(),
    );
    expect(current.selection).toEqual({ modelId: 'B', revision: 4 });
  });

  it('ignores retired pending state and still switches when browser storage is unavailable', async () => {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        sessionId: 's1',
        modelId: 'A',
        expectedRevision: 0,
        idempotencyKey: 'retired-request',
      }),
    );
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('unavailable');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('unavailable');
    });
    await render();
    expect(current.blocked).toBe(false);
    await act(async () => {
      await current.submit('B');
    });
    expect(provider.modelChange!.submit).toHaveBeenCalledOnce();
    expect(
      vi.mocked(provider.modelChange!.submit).mock.calls[0][2].idempotencyKey,
    ).not.toBe('retired-request');
    expect(current.selection).toEqual(result.modelSelection);
  });

  it.each([
    { failure: new TypeError('lost response'), code: 'failed' },
    {
      failure: new JavaManagedAgentHttpError(
        409,
        'model_selection_conflict',
        'stale revision',
      ),
      code: 'model_selection_conflict',
    },
    {
      failure: new JavaManagedAgentHttpError(
        409,
        'session_context_busy',
        'session busy',
      ),
      code: 'session_context_busy',
    },
  ])(
    'releases a failed write without automatically replaying it ($code)',
    async ({ failure, code }) => {
      vi.mocked(provider.modelChange!.submit).mockRejectedValue(failure);
      await render();
      await act(async () => {
        await current.submit('B');
      });
      expect(current.blocked).toBe(false);
      expect(current.isBlocked()).toBe(false);
      expect(current.errorCode).toBe(code);
      expect(sessionStorage.getItem(key)).toBeNull();
      const retry = deferred<ManagedModelChangeResult>();
      vi.mocked(provider.modelChange!.submit).mockReturnValue(retry.promise);
      let retryWrite!: ReturnType<typeof current.submit>;
      await act(async () => {
        retryWrite = current.submit('B');
      });
      // The banner goes away as the retry starts, not only when it succeeds.
      expect(current.errorCode).toBeUndefined();
      expect(current.blocked).toBe(true);
      await act(async () => {
        retry.resolve(result);
        await retryWrite;
      });
      expect(current.errorCode).toBeUndefined();
      expect(current.selection).toEqual(result.modelSelection);
      await render(changed);
      expect(provider.modelChange!.submit).toHaveBeenCalledTimes(2);
    },
  );

  it('retires a lost-response failure once a read reports a revision past the failed write', async () => {
    refresh.mockResolvedValue({
      ...summary,
      modelSelection: { modelId: 'B', revision: 1 },
    });
    vi.mocked(provider.modelChange!.submit).mockRejectedValue(
      new TypeError('lost response'),
    );
    await render();
    await act(async () => {
      await current.submit('B');
    });
    expect(current.errorCode).toBe('failed');
    await render({ ...summary, modelSelection: { modelId: 'B', revision: 1 } });
    expect(current.selection).toEqual({ modelId: 'B', revision: 1 });
    expect(current.errorCode).toBeUndefined();
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

  it('refuses a write until the current Session catalog arrives after switching away and back', async () => {
    let firstCalls = 0;
    const otherSession = deferred<ManagedSessionModels>();
    const returning = deferred<ManagedSessionModels>();
    vi.mocked(provider.modelChange!.queryOptions).mockImplementation((id) => {
      if (id !== 's1') return otherSession.promise;
      firstCalls += 1;
      return firstCalls === 1 ? Promise.resolve(options) : returning.promise;
    });
    await render();
    await render({ ...summary, sessionId: 's2' });
    await render();
    // The catalog from the earlier mount of s1 must not authorize a write now:
    // its selection revision belongs to that window, not to this one.
    await act(async () => {
      await current.submit('B');
    });
    expect(provider.modelChange!.submit).not.toHaveBeenCalled();
    await act(async () => {
      returning.resolve(options);
    });
    await act(async () => {
      await current.submit('B');
    });
    expect(provider.modelChange!.submit).toHaveBeenCalledOnce();
  });

  it('rejects a mismatched receipt instead of claiming the requested model was selected', async () => {
    refresh.mockResolvedValue(summary);
    vi.mocked(provider.modelChange!.submit).mockResolvedValue({
      ...result,
      sessionId: 'another-session',
    });
    await render();
    await act(async () => {
      await current.submit('B');
    });
    expect(current.errorCode).toBe('failed');
    expect(current.selection?.modelId).not.toBe('B');
    expect(current.blocked).toBe(false);
  });

  it('ignores an old Session receipt after the user changes Session', async () => {
    const receipt = deferred<ManagedModelChangeResult>();
    vi.mocked(provider.modelChange!.submit).mockReturnValue(receipt.promise);
    await render();
    let write!: ReturnType<typeof current.submit>;
    await act(async () => {
      write = current.submit('B');
    });
    await render({ ...summary, sessionId: 's2' });
    expect(
      vi.mocked(provider.modelChange!.submit).mock.calls[0][2].signal.aborted,
    ).toBe(true);
    await act(async () => {
      receipt.resolve(result);
      await write;
    });
    expect(current.selection?.modelId).not.toBe('B');
    expect(current.blocked).toBe(false);
  });

  it('does not fetch or submit without capability, visibility or a supported catalog choice', async () => {
    await render({
      ...summary,
      capabilities: { ...summary.capabilities, modelChange: undefined },
    });
    expect(provider.modelChange!.queryOptions).not.toHaveBeenCalled();
    await act(async () => {
      await current.submit('B');
    });
    await render(summary, false);
    expect(provider.modelChange!.queryOptions).not.toHaveBeenCalled();
    await act(async () => {
      await current.submit('B');
    });
    await render();
    const staleSubmit = current.submit;
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
    await render({ ...summary, sessionId: 's2' });
    await act(async () => {
      await staleSubmit('B');
    });
    expect(provider.modelChange!.submit).not.toHaveBeenCalled();
  });
});
