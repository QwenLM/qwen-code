// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedSessionRecovery,
} from './managed-agent-provider';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { useManagedRecovery } from './use-managed-recovery';

describe('useManagedRecovery', () => {
  let root: Root;
  let provider: ManagedAgentProvider;
  let summary: ManagedAgentSessionSummary;
  let current: ReturnType<typeof useManagedRecovery>;
  let refresh: ReturnType<typeof vi.fn>;
  let interactive: boolean;
  const blocked: ManagedSessionRecovery = {
    state: 'awaiting_evidence',
    reasonCode: 'input_unsettled',
    turnId: 't1',
    nextTurnAllowed: false,
    actions: { recheck: true, cancel: false, continueInNewSession: true },
  };
  function Probe() {
    current = useManagedRecovery(
      provider,
      'client',
      summary,
      interactive,
      refresh,
    );
    return null;
  }
  const render = () =>
    act(async () => {
      root.render(<Probe />);
    });
  const tick = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
  beforeEach(() => {
    vi.useFakeTimers();
    interactive = true;
    summary = {
      sessionId: 's1',
      title: '',
      activeTurnId: 't1',
      phase: 'failed',
      createdAt: 1,
      admittedAt: 1,
      updatedAt: 2,
      runtimeReady: true,
      runtimeState: 'ready',
      capabilities: { canSend: false, canCancel: false },
      recovery: blocked,
    };
    refresh = vi.fn();
    provider = {
      storageKey: 'tenant:actor',
      recovery: {
        query: vi.fn().mockResolvedValue(blocked),
        recheck: vi.fn().mockResolvedValue({ ...blocked, state: 'recovering' }),
      },
    } as unknown as ManagedAgentProvider;
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('polls every five seconds while visible and rechecks only the original Turn', async () => {
    await render();
    expect(provider.recovery!.query).toHaveBeenCalledTimes(1);
    await tick();
    expect(provider.recovery!.query).toHaveBeenCalledTimes(2);
    vi.mocked(provider.recovery!.query).mockResolvedValue({
      ...blocked,
      state: 'recovering',
    });
    await act(async () => {
      await current.recheck();
    });
    expect(provider.recovery!.recheck).toHaveBeenCalledWith(
      's1',
      't1',
      expect.anything(),
    );
    expect(current.value?.state).toBe('recovering');
    interactive = false;
    await render();
    const count = vi.mocked(provider.recovery!.query).mock.calls.length;
    await tick();
    expect(provider.recovery!.query).toHaveBeenCalledTimes(count);
  });

  it('keeps restrictions after unreadable evidence and refreshes summary on affirmative settlement', async () => {
    vi.mocked(provider.recovery!.query).mockRejectedValueOnce(
      new Error('unreadable'),
    );
    await render();
    expect(current.value?.nextTurnAllowed).toBe(false);
    expect(current.error).toContain('unreadable');
    vi.mocked(provider.recovery!.query).mockResolvedValue({
      ...blocked,
      state: 'ready',
      nextTurnAllowed: true,
    });
    await tick();
    expect(current.value?.state).toBe('ready');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not install stale evidence for a different Turn', async () => {
    vi.mocked(provider.recovery!.query).mockResolvedValue({
      ...blocked,
      turnId: 'old',
      state: 'ready',
      nextTurnAllowed: true,
    });
    await render();
    expect(current.value?.nextTurnAllowed).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps a confirmed ready verdict until an evidence miss repeats', async () => {
    summary.recovery = {
      ...blocked,
      state: 'ready',
      reasonCode: 'ready',
      nextTurnAllowed: true,
      actions: { recheck: false, cancel: false, continueInNewSession: false },
    };
    const miss: ManagedSessionRecovery = {
      ...blocked,
      state: 'operator_required',
      reasonCode: 'recovery_evidence_unavailable',
    };
    vi.mocked(provider.recovery!.query).mockResolvedValue(miss);
    await render();
    summary.recovery = { ...miss };
    await render();
    expect(current.value?.state).toBe('ready');
    expect(refresh).not.toHaveBeenCalled();
    summary.recovery = { ...miss };
    await render();
    expect(current.value?.state).toBe('operator_required');
  });

  it('stops polling once the Session is terminal', async () => {
    summary.recovery = {
      ...blocked,
      state: 'operator_required',
      reasonCode: 'session_not_active',
      actions: { recheck: false, cancel: false, continueInNewSession: true },
    };
    await render();
    expect(provider.recovery!.query).not.toHaveBeenCalled();
    await tick();
    expect(provider.recovery!.query).not.toHaveBeenCalled();
  });

  it('surfaces the recheck refusal code', async () => {
    vi.mocked(provider.recovery!.recheck).mockRejectedValueOnce(
      new JavaManagedAgentHttpError(
        409,
        'recovery_recheck_unavailable',
        'no work',
      ),
    );
    await render();
    await act(async () => {
      await current.recheck();
    });
    expect(current.errorCode).toBe('recovery_recheck_unavailable');
  });
});
