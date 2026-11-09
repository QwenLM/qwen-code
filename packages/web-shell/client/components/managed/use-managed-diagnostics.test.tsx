// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedDiagnosticResources,
  ManagedDiagnosticsProvider,
} from './managed-agent-provider';
import { useManagedDiagnostics } from './use-managed-diagnostics';
import {
  diagnosticResources,
  diagnosticTrace,
} from './managed-diagnostics.test-fixtures';

describe('useManagedDiagnostics', () => {
  let root: Root;
  let container: HTMLDivElement;
  let provider: ManagedDiagnosticsProvider;
  let latest: ReturnType<typeof useManagedDiagnostics>;
  let props: Parameters<typeof useManagedDiagnostics>[0];
  function Harness() {
    latest = useManagedDiagnostics(props);
    return null;
  }
  async function render(change: Partial<typeof props> = {}) {
    props = { ...props, ...change };
    await act(async () => root.render(<Harness />));
  }
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    provider = {
      getResources: vi.fn().mockResolvedValue(diagnosticResources),
      listAgentTrace: vi.fn().mockResolvedValue(diagnosticTrace),
    };
    props = {
      provider,
      sessionId: 's1',
      clientId: 'actor-a',
      tab: 'resources',
      running: false,
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('aborts the old owner and refuses late data after Session and actor replacement', async () => {
    let resolveOld!: (value: ManagedDiagnosticResources) => void;
    vi.mocked(provider.getResources).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    await render();
    const oldSignal = vi.mocked(provider.getResources).mock.calls[0][1].signal;
    vi.mocked(provider.getResources).mockResolvedValue({
      ...diagnosticResources,
      sessionId: 's2',
    });
    await render({ sessionId: 's2', clientId: 'actor-b' });
    expect(oldSignal?.aborted).toBe(true);
    expect(latest.snapshot?.value.sessionId).toBe('s2');
    await act(async () => resolveOld(diagnosticResources));
    expect(latest.snapshot?.value.sessionId).toBe('s2');
  });

  it('clears previously visible observations when access is revoked', async () => {
    await render();
    expect(latest.snapshot).toBeDefined();
    vi.mocked(provider.getResources).mockRejectedValue(
      new Error('session_not_found'),
    );
    await act(async () => latest.refresh());
    expect(latest.error).toBe(true);
    expect(latest.snapshot).toBeUndefined();
  });

  it('polls only a visible running trace and cancels polling when idle', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await render({ tab: 'agents', running: true });
    expect(provider.listAgentTrace).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(provider.listAgentTrace).toHaveBeenCalledTimes(2);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(provider.listAgentTrace).toHaveBeenCalledTimes(2);
    await render({ running: false });
    const count = vi.mocked(provider.listAgentTrace).mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(provider.listAgentTrace).toHaveBeenCalledTimes(count);
    await render({ tab: 'resources', running: true });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(provider.getResources).toHaveBeenCalledTimes(1);
  });

  it('keeps trace cursors local to a Session and tab', async () => {
    vi.mocked(provider.listAgentTrace).mockResolvedValue({
      ...diagnosticTrace,
      nextCursor: 'older',
      hasMore: true,
    });
    await render({ tab: 'agents' });
    await act(async () => latest.next());
    expect(provider.listAgentTrace).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ cursor: 'older', limit: 20 }),
    );
    expect(latest.hasPrevious).toBe(true);
    await act(async () => latest.previous());
    expect(provider.listAgentTrace).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ cursor: undefined }),
    );
    await render({ tab: 'resources' });
    expect(latest.snapshot?.kind).toBe('resources');
    await render({ tab: 'agents' });
    expect(latest.hasPrevious).toBe(false);
  });

  it('rejects a mismatched response instead of displaying another Session', async () => {
    vi.mocked(provider.getResources).mockResolvedValue({
      ...diagnosticResources,
      sessionId: 'foreign',
    });
    await render();
    expect(latest.error).toBe(true);
    expect(latest.snapshot).toBeUndefined();
  });
});
