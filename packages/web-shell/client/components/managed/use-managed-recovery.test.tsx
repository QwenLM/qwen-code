// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedSessionRecovery,
} from './managed-agent-provider';
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
});
