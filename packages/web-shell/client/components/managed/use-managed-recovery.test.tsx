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
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
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

  const ready: ManagedSessionRecovery = {
    ...blocked,
    state: 'ready',
    reasonCode: 'ready',
    turnId: 't1',
    nextTurnAllowed: true,
    actions: { recheck: false, cancel: false, continueInNewSession: false },
  };
  const miss: ManagedSessionRecovery = {
    ...blocked,
    state: 'operator_required',
    reasonCode: 'recovery_evidence_unavailable',
    turnId: 't1',
  };

  it('keeps a confirmed ready verdict when a summary miss is contradicted', async () => {
    summary.recovery = ready;
    summary.capabilities = { canSend: true, canCancel: false };
    // The confirming read reaches a replica that holds the attachment.
    vi.mocked(provider.recovery!.query).mockResolvedValue({ ...ready });
    await render();
    expect(current.value?.state).toBe('ready');
    summary = {
      ...summary,
      capabilities: { canSend: false, canCancel: false },
      recovery: { ...miss },
    };
    await render();
    expect(current.value?.state).toBe('ready');
    // The held verdict also keeps the send gate the summary no longer reports.
    expect(current.canSend).toBe(true);
    expect(current.value).not.toBe(summary.recovery);
  });

  it('adopts the miss once the recovery read agrees', async () => {
    summary.recovery = ready;
    summary.capabilities = { canSend: true, canCancel: false };
    vi.mocked(provider.recovery!.query).mockResolvedValue({ ...miss });
    await render();
    expect(current.value?.state).toBe('ready');
    summary = {
      ...summary,
      capabilities: { canSend: false, canCancel: false },
      recovery: { ...miss },
    };
    await render();
    expect(current.value?.state).toBe('operator_required');
    expect(current.canSend).toBeUndefined();
  });

  it('holds a first miss even when nothing has been published yet', async () => {
    summary.recovery = undefined;
    vi.mocked(provider.recovery!.query).mockResolvedValue({ ...ready });
    await render();
    expect(current.value).toBeUndefined();
    summary = { ...summary, recovery: { ...miss } };
    await render();
    expect(current.value?.state).toBe('ready');
    expect(provider.recovery!.query).toHaveBeenCalled();
  });

  it('keeps the summary send gate while a first miss is unconfirmed', async () => {
    // No trusted read exists yet, so the hold must not open sending: the
    // summary's own restriction is the only authorization on screen.
    summary.recovery = { ...miss };
    summary.capabilities = { canSend: false, canCancel: false };
    vi.mocked(provider.recovery!.query).mockReturnValue(
      new Promise<never>(() => undefined),
    );
    await render();
    expect(current.value).toBeUndefined();
    expect(current.canSend).toBe(false);
  });

  it('clears the verdict when a summary drops recovery', async () => {
    interactive = false;
    await render();
    expect(current.value?.state).toBe('awaiting_evidence');
    summary = { ...summary, recovery: undefined };
    await render();
    expect(current.value).toBeUndefined();
  });

  it('backs off while operator_required stays stable and caps at thirty seconds', async () => {
    const stable: ManagedSessionRecovery = {
      ...blocked,
      state: 'operator_required',
      reasonCode: 'recovery_blocked',
    };
    summary.recovery = stable;
    vi.mocked(provider.recovery!.query).mockImplementation(async () => ({
      ...stable,
    }));
    await render();
    expect(provider.recovery!.query).toHaveBeenCalledTimes(1);
    await advance(5_000);
    expect(provider.recovery!.query).toHaveBeenCalledTimes(2);
    await advance(10_000);
    expect(provider.recovery!.query).toHaveBeenCalledTimes(3);
    await advance(20_000);
    expect(provider.recovery!.query).toHaveBeenCalledTimes(4);
    await advance(30_000);
    expect(provider.recovery!.query).toHaveBeenCalledTimes(5);
    await advance(30_000);
    expect(provider.recovery!.query).toHaveBeenCalledTimes(6);
  });

  it('restarts the backoff when another Session becomes selected', async () => {
    const stable: ManagedSessionRecovery = {
      ...blocked,
      state: 'operator_required',
      reasonCode: 'recovery_blocked',
    };
    summary.recovery = stable;
    vi.mocked(provider.recovery!.query).mockImplementation(async () => ({
      ...stable,
    }));
    await render();
    await advance(35_000);
    expect(provider.recovery!.query).toHaveBeenCalledTimes(4);
    summary = { ...summary, sessionId: 's2', recovery: { ...stable } };
    await render();
    const afterSwitch = vi.mocked(provider.recovery!.query).mock.calls.length;
    await advance(5_000);
    expect(provider.recovery!.query).toHaveBeenCalledTimes(afterSwitch + 1);
  });

  it('keeps the recheck state while a summary refresh lands', async () => {
    vi.mocked(provider.recovery!.recheck).mockReturnValue(
      new Promise<never>(() => undefined),
    );
    await render();
    await act(async () => {
      void current.recheck();
    });
    expect(current.busy).toBe(true);
    summary = { ...summary, recovery: { ...blocked } };
    await render();
    expect(current.busy).toBe(true);
  });

  it('keeps the recheck refusal while a summary refresh lands', async () => {
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
    summary = { ...summary, recovery: { ...blocked } };
    await render();
    expect(current.errorCode).toBe('recovery_recheck_unavailable');
  });

  it('re-reads the summary when recheck reports a changed target', async () => {
    vi.mocked(provider.recovery!.recheck).mockRejectedValueOnce(
      new JavaManagedAgentHttpError(409, 'recovery_target_changed', 'moved'),
    );
    await render();
    await act(async () => {
      await current.recheck();
    });
    expect(current.errorCode).toBe('recovery_target_changed');
    expect(refresh).toHaveBeenCalledTimes(1);
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
