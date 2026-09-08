// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonSessionActions,
  DaemonSessionContextUsageStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { I18nProvider } from '../../i18n';
import { ContextUsagePanel } from './ContextUsagePanel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});

function fixture(sessionId = 's-1'): DaemonSessionContextUsageStatus {
  return {
    v: 1,
    sessionId,
    workspaceCwd: '/workspace',
    formattedText: '',
    usage: {
      modelName: 'context-model',
      totalTokens: 60,
      contextWindowSize: 100,
      breakdown: {
        systemPrompt: 10,
        builtinTools: 10,
        mcpTools: 5,
        memoryFiles: 5,
        skills: 10,
        messages: 20,
        freeSpace: 30,
        autocompactBuffer: 10,
      },
      builtinTools: [{ name: 'read_file', tokens: 10 }],
      mcpTools: [{ name: 'mcp_search', tokens: 5 }],
      memoryFiles: [{ path: '/workspace/QWEN.md', tokens: 5 }],
      skills: [{ name: 'review', tokens: 5, loaded: true, bodyTokens: 5 }],
      showDetails: true,
      isEstimated: true,
    },
  };
}

function deferred() {
  let resolve!: (value: DaemonSessionContextUsageStatus) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<DaemonSessionContextUsageStatus>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPanel(getContextUsage?: ReturnType<typeof vi.fn>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const actions = getContextUsage
    ? ({ getContextUsage } as unknown as DaemonSessionActions)
    : undefined;
  const rerender = (sessionActions = actions, sessionId = 's-1') => {
    act(() =>
      root.render(
        <I18nProvider language="en">
          <ContextUsagePanel
            sessionActions={sessionActions}
            sessionId={sessionId}
          />
        </I18nProvider>,
      ),
    );
  };
  rerender();
  return { container, rerender, root };
}

function refresh(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('button[aria-label]')!;
}

describe('ContextUsagePanel', () => {
  it('reuses the in-flight request across a StrictMode-replayed mount', async () => {
    const request = deferred();
    const get = vi.fn().mockReturnValue(request.promise);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() =>
      root.render(
        <StrictMode>
          <I18nProvider language="en">
            <ContextUsagePanel
              sessionActions={
                { getContextUsage: get } as unknown as DaemonSessionActions
              }
              sessionId="s-1"
            />
          </I18nProvider>
        </StrictMode>,
      ),
    );
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve(fixture()));
    expect(container.textContent).toContain('context-model');
  });

  it('loads detailed data once and refreshes manually without overlapping requests', async () => {
    vi.useFakeTimers();
    const initial = deferred();
    const next = deferred();
    const get = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(next.promise);
    const { container } = renderPanel(get);
    expect(container.textContent).toContain('Loading');
    expect(refresh(container).disabled).toBe(true);
    act(() => refresh(container).click());
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith({ detail: true, silent: true });
    await act(async () => initial.resolve(fixture()));
    for (const text of [
      'context-model',
      'read_file',
      'mcp_search',
      '/workspace/QWEN.md',
      'review',
      'Messages',
      'Token usage is estimated until provider usage is received.',
    ]) {
      expect(container.textContent).toContain(text);
    }
    expect(container.querySelector('[class*="compact"]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(60_000));
    expect(get).toHaveBeenCalledTimes(1);
    act(() => {
      refresh(container).click();
      refresh(container).click();
    });
    expect(get).toHaveBeenCalledTimes(2);
    const updated = fixture();
    updated.usage.modelName = 'updated-model';
    await act(async () => next.resolve(updated));
    expect(container.textContent).toContain('updated-model');
  });

  it('shows a localized error and supports retry', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce(fixture());
    const { container } = renderPanel(get);
    await act(async () => {});
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain('Failed to load context usage.');
    expect(container.textContent).not.toContain('private transport detail');
    const retry = container.querySelector<HTMLButtonElement>(
      '[role="alert"] button',
    )!;
    await act(async () => retry.click());
    expect(get).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('context-model');
  });

  it.each([
    'Daemon session is not connected',
    'fetch failed',
    'DaemonTransportClosedError',
  ])('suppresses the alert for transient failures: %s', async (message) => {
    const transient =
      message === 'DaemonTransportClosedError'
        ? Object.assign(new Error('transport closed'), {
            name: 'DaemonTransportClosedError',
          })
        : new TypeError(message);
    const get = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(fixture());
    const { container } = renderPanel(get);
    await act(async () => {});
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain(
      'Context usage is unavailable for this session.',
    );
    const retry = refresh(container);
    expect(retry.disabled).toBe(false);
    await act(async () => retry.click());
    expect(get).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('context-model');
  });

  it('keeps the last good reading while a refresh is in flight', async () => {
    const initial = deferred();
    const second = deferred();
    const get = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(second.promise);
    const { container } = renderPanel(get);
    await act(async () => initial.resolve(fixture()));
    expect(container.textContent).toContain('context-model');
    act(() => refresh(container).click());
    await act(async () => {});
    expect(container.textContent).toContain('context-model');
    expect(container.querySelector('[role="status"]')).toBeNull();
    // aria-busy is the only DOM evidence of a background refetch.
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => second.resolve(fixture()));
    expect(container.textContent).toContain('context-model');
  });

  it('clears a retained reading when a refresh resolves unusable', async () => {
    for (const mutate of [
      (snapshot: ReturnType<typeof fixture>) => {
        snapshot.usage.contextWindowSize = 0;
      },
      (snapshot: ReturnType<typeof fixture>) => {
        snapshot.sessionId = 'other-session';
      },
    ]) {
      const initial = deferred();
      const second = deferred();
      const get = vi
        .fn()
        .mockReturnValueOnce(initial.promise)
        .mockReturnValueOnce(second.promise);
      const { container } = renderPanel(get);
      await act(async () => initial.resolve(fixture()));
      expect(container.textContent).toContain('context-model');
      act(() => refresh(container).click());
      const invalid = fixture();
      mutate(invalid);
      await act(async () => second.resolve(invalid));
      expect(container.textContent).not.toContain('context-model');
      expect(container.textContent).toContain(
        'Context usage is unavailable for this session.',
      );
    }
  });

  it('keeps the last good reading when a refresh fails transiently', async () => {
    const initial = deferred();
    const second = deferred();
    const get = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(second.promise);
    const { container } = renderPanel(get);
    await act(async () => initial.resolve(fixture()));
    act(() => refresh(container).click());
    await act(async () =>
      second.reject(new Error('Daemon session is not connected')),
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('context-model');
  });

  it('renders full detail names because the panel opts out of the cap', async () => {
    const snapshot = fixture();
    snapshot.usage.showDetails = true;
    const longName = 'mcp__github__create_repository_issue';
    snapshot.usage.builtinTools = [{ name: longName, tokens: 10 }];
    const { container } = renderPanel(vi.fn().mockResolvedValue(snapshot));
    await act(async () => {});
    expect(container.textContent).toContain(longName);
    expect(container.textContent).not.toContain('…');
  });

  it('replaces the retained reading with the alert when a refresh really fails', async () => {
    const initial = deferred();
    const second = deferred();
    const get = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(second.promise);
    const { container } = renderPanel(get);
    await act(async () => initial.resolve(fixture()));
    expect(container.textContent).toContain('context-model');
    act(() => refresh(container).click());
    await act(async () => second.reject(new Error('boom')));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain('context-model');
  });

  it('does not load without actions', () => {
    const { container } = renderPanel();
    expect(refresh(container).disabled).toBe(true);
    expect(container.querySelector('[aria-busy="false"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain(
      'Context usage is unavailable for this session.',
    );
  });

  it.each(['mismatch', 'zero window'])(
    'does not display unavailable data: %s',
    async (reason) => {
      const snapshot = fixture(reason === 'mismatch' ? 'other-session' : 's-1');
      if (reason === 'zero window') snapshot.usage.contextWindowSize = 0;
      const { container } = renderPanel(vi.fn().mockResolvedValue(snapshot));
      await act(async () => {});
      expect(container.textContent).not.toContain('context-model');
      expect(container.textContent).toContain(
        'Context usage is unavailable for this session.',
      );
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(refresh(container).disabled).toBe(false);
    },
  );

  it('preserves no-provider wording', async () => {
    const snapshot = fixture();
    snapshot.usage.totalTokens = 0;
    const { container } = renderPanel(vi.fn().mockResolvedValue(snapshot));
    await act(async () => {});
    expect(container.textContent).toContain('No API response yet.');
    expect(container.textContent).toContain(
      'Estimated pre-conversation overhead',
    );
  });

  it.each(['session', 'actions'])(
    'ignores stale responses after %s changes',
    async (change) => {
      const old = deferred();
      const current = deferred();
      const get = vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      const { container, rerender } = renderPanel(get);
      if (change === 'session') rerender(undefined, 's-2');
      else
        rerender({
          getContextUsage: vi.fn().mockReturnValue(current.promise),
        } as unknown as DaemonSessionActions);
      await act(async () =>
        current.resolve(fixture(change === 'session' ? 's-2' : 's-1')),
      );
      const stale = fixture();
      stale.usage.modelName = 'stale-model';
      await act(async () => old.resolve(stale));
      expect(container.textContent).toContain('context-model');
      expect(container.textContent).not.toContain('stale-model');
    },
  );

  it('ignores stale failures while a new owner is loading', async () => {
    const old = deferred();
    const current = deferred();
    const get = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const { container, rerender } = renderPanel(get);
    rerender(undefined, 's-2');
    await act(async () => old.reject(new Error('old owner failed')));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(refresh(container).disabled).toBe(true);
    await act(async () => current.resolve(fixture('s-2')));
    expect(container.textContent).toContain('context-model');
  });

  // Smoke check only: React no-ops setState after unmount, so the stale-state
  // guard's unmount half is pinned by the ownership-change cases above.
  it.each(['resolve', 'reject'] as const)(
    'does not throw when a request %ss after unmount',
    async (outcome) => {
      const request = deferred();
      const { root, container } = renderPanel(
        vi.fn().mockReturnValue(request.promise),
      );
      act(() => root.unmount());
      mounted.splice(0);
      await act(async () => {
        if (outcome === 'resolve') request.resolve(fixture());
        else request.reject(new Error('late failure'));
      });
      expect(container.textContent).toBe('');
      container.remove();
    },
  );
});
