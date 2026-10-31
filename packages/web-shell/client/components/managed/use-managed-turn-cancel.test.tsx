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
        expect(options).not.toHaveProperty('admissionProfile');
        return { sessionId: 's1', turnId: 't1', operationId: 'op1' };
      },
    );
    await render();
    await act(async () => {
      await current.request();
    });
    expect(current.pending).toBe(true);
    vi.mocked(provider.queryCancelOperation).mockResolvedValue({
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
    vi.mocked(provider.queryCancelOperation).mockResolvedValue({
      ...operation,
      status: 'completed',
    });
    await render();
    await tick();
    expect(current.pending).toBe(false);
    vi.mocked(provider.cancel).mockResolvedValue({
      sessionId: 's1',
      turnId: 't2',
      operationId: 'op2',
    });
    vi.mocked(provider.queryCancelOperation).mockResolvedValue({
      ...operation,
      operationId: 'op2',
    });
    await act(async () => {
      await current.request();
    });
    expect(current.pending).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(key)!).operationId).toBe('op2');
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
        operationId: 'op1',
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

  it('does not retire a blocked cancellation from a terminal summary or ready recovery', async () => {
    vi.mocked(provider.queryCancelOperation).mockResolvedValue({
      ...operation,
      status: 'recovery_blocked',
      failureCode: 'cancel_unconfirmed',
    });
    await render();
    await act(async () => {
      await current.request();
    });
    summary = {
      ...summary,
      phase: 'cancelled',
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
    expect(current.pending).toBe(true);
    expect(current.status).toBe('unconfirmed');
    expect(provider.cancel).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(key)!).operationId).toBe('op1');
  });

  it('reports the original operation failure and permits a new explicit cancellation', async () => {
    vi.mocked(provider.queryCancelOperation).mockResolvedValue({
      ...operation,
      status: 'failed',
      failureCode: 'turn_already_settled',
    });
    await render();
    await act(async () => {
      await current.request();
    });
    expect(current.pending).toBe(false);
    expect(current.status).toBe('failed');
    expect(current.error).toBe('turn_already_settled');
    expect(sessionStorage.getItem(key)).toBeNull();
    summary = { ...summary, activeTurnId: 't2', phase: 'agent_running' };
    vi.mocked(provider.cancel).mockResolvedValue({
      sessionId: 's1',
      turnId: 't2',
      operationId: 'op2',
    });
    vi.mocked(provider.queryCancelOperation).mockResolvedValue({
      ...operation,
      operationId: 'op2',
    });
    await render();
    await act(async () => {
      await current.request();
    });
    expect(current.status).toBe('stopping');
    expect(current.error).toBeUndefined();
    expect(current.pending).toBe(true);
    expect(vi.mocked(provider.cancel).mock.calls[1][1]).toBe('t2');
  });

  it('pauses polling when inactive and never treats foreign operation evidence as cancellation', async () => {
    await render();
    vi.mocked(provider.queryCancelOperation).mockResolvedValue({
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
    const count = vi.mocked(provider.queryCancelOperation).mock.calls.length;
    await tick();
    expect(provider.queryCancelOperation).toHaveBeenCalledTimes(count);
  });
});
