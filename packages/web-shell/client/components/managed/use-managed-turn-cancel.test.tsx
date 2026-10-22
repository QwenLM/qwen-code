// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedTurnCancelOperation,
} from './managed-agent-provider';
import { useManagedTurnCancel } from './use-managed-turn-cancel';

describe('useManagedTurnCancel', () => {
  let root: Root;
  let provider: ManagedAgentProvider;
  let summary: ManagedAgentSessionSummary;
  let current: ReturnType<typeof useManagedTurnCancel>;
  let refresh: ReturnType<typeof vi.fn>;
  let interactive: boolean;
  const key = 'qwen-managed-turn-cancel:["tenant:actor","s1"]';
  const operation: ManagedTurnCancelOperation = {
    operationId: 'op1',
    sessionId: 's1',
    type: 'cancel',
    status: 'running',
    admissionStage: 'java_durable',
    deliveryState: 'leased',
    replayed: false,
  };
  function Probe() {
    current = useManagedTurnCancel(
      provider,
      'client',
      's1',
      summary,
      interactive,
      refresh,
    );
    return null;
  }
  const render = () =>
    act(async () => {
      root.render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      );
    });
  const tick = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    interactive = true;
    summary = {
      sessionId: 's1',
      title: '',
      activeTurnId: 't1',
      phase: 'cancelling',
      createdAt: 1,
      admittedAt: 1,
      updatedAt: 2,
      runtimeReady: true,
      runtimeState: 'ready',
      capabilities: {
        canSend: false,
        canCancel: true,
        durableOperations: true,
      },
    };
    refresh = vi.fn().mockImplementation(async () => summary);
    provider = {
      storageKey: 'tenant:actor',
      cancel: vi.fn().mockResolvedValue({
        sessionId: 's1',
        turnId: 't1',
        operationId: 'op1',
      }),
      queryCancelOperation: vi.fn().mockResolvedValue(operation),
    } as unknown as ManagedAgentProvider;
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('persists before submit and waits beyond ACK until the original durable cancellation completes', async () => {
    vi.mocked(provider.cancel).mockImplementation(
      async (_session, _turn, options) => {
        expect(sessionStorage.getItem(key)).toContain(options.idempotencyKey);
        expect(options.admissionProfile).toBe('java_durable');
        return { sessionId: 's1', turnId: 't1', operationId: 'op1' };
      },
    );
    await render();
    await act(async () => {
      await current.request();
    });
    expect(current.pending).toBe(true);
    vi.mocked(provider.queryCancelOperation!).mockResolvedValue({
      ...operation,
      status: 'completed',
    });
    await tick();
    expect(current.pending).toBe(false);
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(provider.cancel).toHaveBeenCalledTimes(1);
  });

  it('retires a completed original operation after a later Turn appears and can stop that later Turn', async () => {
    await render();
    await act(async () => {
      await current.request();
    });
    summary = { ...summary, activeTurnId: 't2', phase: 'agent_running' };
    vi.mocked(provider.queryCancelOperation!).mockResolvedValue({
      ...operation,
      status: 'completed',
    });
    await render();
    await tick();
    expect(current.pending).toBe(false);
    await act(async () => {
      await current.request();
    });
    expect(vi.mocked(provider.cancel).mock.calls[1][1]).toBe('t2');
    expect(vi.mocked(provider.cancel).mock.calls[1][2].idempotencyKey).not.toBe(
      vi.mocked(provider.cancel).mock.calls[0][2].idempotencyKey,
    );
  });

  it('resumes the original operation after refresh without posting another cancellation', async () => {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        sessionId: 's1',
        turnId: 't1',
        idempotencyKey: 'original',
        durable: true,
        operationId: 'op1',
        submitted: true,
      }),
    );
    await render();
    expect(provider.cancel).not.toHaveBeenCalled();
    expect(provider.queryCancelOperation).toHaveBeenCalledWith(
      's1',
      'op1',
      expect.anything(),
    );
    expect(current.pending).toBe(true);
  });

  it('retries a lost reply with the same key and original Turn even after a newer Turn appears', async () => {
    vi.mocked(provider.cancel).mockRejectedValueOnce(
      new Error('connection lost'),
    );
    await render();
    await act(async () => {
      await current.request();
    });
    const original = vi.mocked(provider.cancel).mock.calls[0];
    summary = { ...summary, activeTurnId: 't2' };
    await render();
    await tick();
    const retried = vi.mocked(provider.cancel).mock.calls[1];
    expect(retried[1]).toBe('t1');
    expect(retried[2].idempotencyKey).toBe(original[2].idempotencyKey);
    expect(current.pending).toBe(true);
  });

  function compatibilityCancellation() {
    summary.capabilities.durableOperations = false;
    vi.mocked(provider.cancel).mockImplementation(
      async (sessionId, turnId) => ({
        sessionId,
        turnId,
      }),
    );
  }

  it.each([false, true])(
    'retires only an acknowledged compatibility delivery slot and stops the explicitly selected later Turn (poll first: %s)',
    async (pollFirst) => {
      compatibilityCancellation();
      await render();
      await act(async () => {
        await current.request();
      });
      const original = vi.mocked(provider.cancel).mock.calls[0];
      expect(current.pending).toBe(true);
      summary = {
        ...summary,
        activeTurnId: 't2',
        phase: 'agent_running',
        updatedAt: 3,
      };
      await render();
      if (pollFirst) {
        await tick();
        expect(current.pending).toBe(false);
        expect(provider.cancel).toHaveBeenCalledTimes(1);
        expect(summary.phase).toBe('agent_running');
        expect(summary.capabilities.canSend).toBe(false);
      }
      await act(async () => {
        await current.request();
      });
      expect(provider.cancel).toHaveBeenCalledTimes(2);
      const later = vi.mocked(provider.cancel).mock.calls[1];
      expect(later[1]).toBe('t2');
      expect(later[2].idempotencyKey).not.toBe(original[2].idempotencyKey);
      expect(later[2].admissionProfile).toBeUndefined();
      expect(provider.queryCancelOperation).not.toHaveBeenCalled();
      expect(JSON.parse(sessionStorage.getItem(key)!).turnId).toBe('t2');
      expect(current.pending).toBe(true);
    },
  );

  it('retires a restored acknowledged compatibility slot when the fresh summary has a different Turn', async () => {
    compatibilityCancellation();
    summary = {
      ...summary,
      activeTurnId: 't2',
      phase: 'agent_running',
      updatedAt: 3,
    };
    sessionStorage.setItem(
      key,
      JSON.stringify({
        sessionId: 's1',
        turnId: 't1',
        idempotencyKey: 'original',
        durable: false,
        submitted: true,
      }),
    );
    await render();
    await tick();
    expect(current.pending).toBe(false);
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(provider.cancel).not.toHaveBeenCalled();
    await act(async () => {
      await current.request();
    });
    expect(vi.mocked(provider.cancel).mock.calls[0][1]).toBe('t2');
    expect(vi.mocked(provider.cancel).mock.calls[0][2].idempotencyKey).not.toBe(
      'original',
    );
  });

  it.each(['missing', 'unknown', 'foreign'] as const)(
    'keeps an acknowledged compatibility intent on FAILED without original ready evidence (%s)',
    async (evidence) => {
      compatibilityCancellation();
      await render();
      await act(async () => {
        await current.request();
      });
      const original = vi.mocked(provider.cancel).mock.calls[0];
      summary = {
        ...summary,
        phase: 'failed',
        updatedAt: 3,
        recovery:
          evidence === 'missing'
            ? undefined
            : {
                state: evidence === 'unknown' ? 'operator_required' : 'ready',
                reasonCode:
                  evidence === 'unknown' ? 'inputs_unsettled' : 'ready',
                turnId: evidence === 'foreign' ? 'other-turn' : 't1',
                nextTurnAllowed: evidence !== 'unknown',
                actions: {
                  recheck: false,
                  cancel: false,
                  continueInNewSession: true,
                },
              },
      };
      await render();
      await tick();
      expect(current.pending).toBe(true);
      expect(sessionStorage.getItem(key)).toContain(original[2].idempotencyKey);
      expect(provider.cancel).toHaveBeenCalledTimes(1);
    },
  );

  it('retires an original FAILED compatibility intent only after matching ready evidence', async () => {
    compatibilityCancellation();
    await render();
    await act(async () => {
      await current.request();
    });
    summary = {
      ...summary,
      phase: 'failed',
      updatedAt: 3,
      recovery: {
        state: 'ready',
        reasonCode: 'ready',
        turnId: 't1',
        nextTurnAllowed: true,
        actions: { recheck: false, cancel: false, continueInNewSession: true },
      },
    };
    await render();
    await tick();
    expect(current.pending).toBe(false);
    expect(current.status).toBeUndefined();
    expect(summary.phase).toBe('failed');
    expect(summary.capabilities.canSend).toBe(false);
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('keeps a lost compatibility reply on the original key and Turn despite an explicit later Stop', async () => {
    compatibilityCancellation();
    vi.mocked(provider.cancel).mockRejectedValue(new Error('connection lost'));
    await render();
    await act(async () => {
      await current.request();
    });
    const original = vi.mocked(provider.cancel).mock.calls[0];
    summary = {
      ...summary,
      activeTurnId: 't2',
      phase: 'agent_running',
      updatedAt: 3,
    };
    await render();
    await act(async () => {
      await current.request();
    });
    const retried = vi.mocked(provider.cancel).mock.calls[1];
    expect(retried[1]).toBe('t1');
    expect(retried[2].idempotencyKey).toBe(original[2].idempotencyKey);
    expect(current.pending).toBe(true);
    expect(current.status).toBe('unconfirmed');
  });

  it.each(['foreign-session', 'older-summary'] as const)(
    'keeps acknowledged compatibility tracking on a non-current summary (%s)',
    async (answer) => {
      compatibilityCancellation();
      await render();
      await act(async () => {
        await current.request();
      });
      refresh.mockResolvedValue({
        ...summary,
        activeTurnId: 't2',
        phase: 'agent_running',
        sessionId: answer === 'foreign-session' ? 'other-session' : 's1',
        updatedAt: answer === 'older-summary' ? 1 : 3,
      });
      await tick();
      expect(current.pending).toBe(true);
      expect(JSON.parse(sessionStorage.getItem(key)!).turnId).toBe('t1');
      expect(provider.cancel).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the original durable operation pending when a later Turn is visible', async () => {
    await render();
    await act(async () => {
      await current.request();
    });
    summary = {
      ...summary,
      activeTurnId: 't2',
      phase: 'agent_running',
      updatedAt: 3,
    };
    await render();
    await tick();
    expect(current.pending).toBe(true);
    expect(provider.cancel).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(key)!).operationId).toBe('op1');
  });

  it('does not cancel a third Turn that appears during compatibility preflight', async () => {
    compatibilityCancellation();
    await render();
    await act(async () => {
      await current.request();
    });
    summary = {
      ...summary,
      activeTurnId: 't2',
      phase: 'agent_running',
      updatedAt: 3,
    };
    await render();
    let release!: (value: ManagedAgentSessionSummary) => void;
    const gate = new Promise<ManagedAgentSessionSummary>((resolve) => {
      release = resolve;
    });
    refresh.mockReturnValueOnce(gate);
    let requesting!: Promise<void>;
    await act(async () => {
      requesting = current.request();
    });
    summary = { ...summary, activeTurnId: 't3', updatedAt: 4 };
    await render();
    await act(async () => {
      release(summary);
      await requesting;
    });
    expect(provider.cancel).toHaveBeenCalledTimes(1);
    expect(current.pending).toBe(false);
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('pauses polling when inactive and never treats foreign operation evidence as cancellation', async () => {
    await render();
    vi.mocked(provider.queryCancelOperation!).mockResolvedValue({
      ...operation,
      sessionId: 'other',
    });
    await act(async () => {
      await current.request();
    });
    expect(current.status).toBe('unconfirmed');
    expect(current.pending).toBe(true);
    interactive = false;
    await render();
    const count = vi.mocked(provider.queryCancelOperation!).mock.calls.length;
    await tick();
    expect(provider.queryCancelOperation).toHaveBeenCalledTimes(count);
  });
});
