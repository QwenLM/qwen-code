// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  McpAppHostContext,
  McpAppSessionContext,
  McpAppToolsContext,
} from '../../mcpAppHostContext';
import { ThemeProvider, WebShellThemeId } from '../../themeContext';
import type { McpAppDisplay } from './McpApp';

const appBridgeMocks = vi.hoisted(() => ({
  constructed: 0,
  last: null as {
    onsandboxready?: () => void;
    oninitialized?: () => void;
    oncalltool?: (
      params: {
        name: string;
        arguments?: Record<string, unknown>;
        _meta?: { progressToken?: string | number };
      },
      extra: {
        signal: AbortSignal;
        requestId?: number;
        sendNotification?: ReturnType<typeof vi.fn>;
      },
    ) => Promise<unknown>;
  } | null,
  lastCapabilities: undefined as unknown,
  setHostContext: vi.fn(),
  connect: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  sendSandboxResourceReady: vi.fn(() => Promise.resolve()),
  sendToolInput: vi.fn(() => Promise.resolve()),
  sendToolResult: vi.fn(() => Promise.resolve()),
  teardownResource: vi.fn(() => Promise.resolve()),
}));

vi.mock('@modelcontextprotocol/ext-apps/app-bridge', () => ({
  PostMessageTransport: class PostMessageTransport {},
  AppBridge: class AppBridge {
    setHostContext = appBridgeMocks.setHostContext;
    connect = appBridgeMocks.connect;
    close = appBridgeMocks.close;
    sendSandboxResourceReady = appBridgeMocks.sendSandboxResourceReady;
    sendToolInput = appBridgeMocks.sendToolInput;
    sendToolResult = appBridgeMocks.sendToolResult;
    teardownResource = appBridgeMocks.teardownResource;
    constructor(_app: unknown, _info: unknown, capabilities?: unknown) {
      appBridgeMocks.constructed += 1;
      appBridgeMocks.last = this;
      appBridgeMocks.lastCapabilities = capabilities;
    }
  },
}));

import { McpApp } from './McpApp';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

beforeEach(() => {
  appBridgeMocks.constructed = 0;
  appBridgeMocks.last = null;
  appBridgeMocks.lastCapabilities = undefined;
  appBridgeMocks.setHostContext.mockClear();
  appBridgeMocks.connect.mockClear();
  appBridgeMocks.close.mockClear();
  appBridgeMocks.sendSandboxResourceReady.mockClear();
  appBridgeMocks.sendToolInput.mockClear();
  appBridgeMocks.sendToolResult.mockClear();
  appBridgeMocks.teardownResource.mockReset();
  appBridgeMocks.teardownResource.mockImplementation(() => Promise.resolve());
});

function appDisplay(overrides: Partial<McpAppDisplay> = {}): McpAppDisplay {
  return {
    type: 'mcp_app',
    serverName: 'demo',
    resourceUri: 'ui://demo/app',
    html: '<main>Demo</main>',
    toolResult: { content: [] },
    toolArguments: {},
    fallbackText: 'Demo result',
    ...overrides,
  };
}

function renderApp(
  display: McpAppDisplay,
  theme: (typeof WebShellThemeId)[keyof typeof WebShellThemeId] = WebShellThemeId.Dark,
  baseUrl = 'http://127.0.0.1:4170',
): { container: HTMLElement; rerender: (node: ReactNode) => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const wrap = (node: ReactNode) => (
    <McpAppHostContext.Provider value={baseUrl}>
      <ThemeProvider value={theme}>{node}</ThemeProvider>
    </McpAppHostContext.Provider>
  );
  act(() => root.render(wrap(<McpApp display={display} />)));
  mounted.push({ root, container });
  return {
    container,
    rerender: (node: ReactNode) => {
      act(() => root.render(wrap(node)));
    },
  };
}

describe('McpApp host lifetime', () => {
  it.each([
    'sendSandboxResourceReady',
    'sendToolInput',
    'sendToolResult',
  ] as const)('revokes the App bridge after %s fails', async (handoff) => {
    let rejectHandoff!: (error: Error) => void;
    appBridgeMocks[handoff].mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectHandoff = reject;
        }),
    );
    const callTool = vi.fn((_request: unknown, _signal: AbortSignal) =>
      Promise.resolve({ content: [] }),
    );
    const { container, rerender } = renderApp(appDisplay());
    const wrap = (display: McpAppDisplay) => (
      <McpAppToolsContext.Provider value={{ sessionId: 's', callTool }}>
        <McpAppSessionContext.Provider value="s">
          <McpApp display={display} />
        </McpAppSessionContext.Provider>
      </McpAppToolsContext.Provider>
    );
    rerender(wrap(appDisplay()));
    const bridge = appBridgeMocks.last!;
    const invoke = bridge.oncalltool!;
    await act(async () => {
      bridge.onsandboxready?.();
      bridge.oninitialized?.();
    });
    await invoke(
      { name: 'before-failure' },
      { signal: new AbortController().signal },
    );
    const activeSignal = callTool.mock.calls[0][1];
    appBridgeMocks.close.mockClear();
    await act(async () => {
      rejectHandoff(new Error('fixture handoff failed'));
    });
    const snapshot = {
      closed: appBridgeMocks.close.mock.calls.length,
      src: container.querySelector('iframe')?.getAttribute('src'),
      registered: typeof bridge.oncalltool === 'function',
      aborted: activeSignal.aborted,
    };
    await invoke(
      { name: 'after-failure' },
      { signal: new AbortController().signal },
    ).catch(() => undefined);
    expect({ ...snapshot, calls: callTool.mock.calls.length }).toEqual({
      closed: 1,
      src: null,
      registered: false,
      aborted: true,
      calls: 1,
    });
  });

  it('ignores a stale handoff rejection after a replacement App is mounted', async () => {
    let rejectHandoff!: (error: Error) => void;
    appBridgeMocks.sendToolResult.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectHandoff = reject;
        }),
    );
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    const { container, rerender } = renderApp(appDisplay());
    const wrap = (display: McpAppDisplay) => (
      <McpAppToolsContext.Provider value={{ sessionId: 's', callTool }}>
        <McpAppSessionContext.Provider value="s">
          <McpApp display={display} />
        </McpAppSessionContext.Provider>
      </McpAppToolsContext.Provider>
    );
    rerender(wrap(appDisplay()));
    const oldBridge = appBridgeMocks.last!;
    await act(async () => {
      oldBridge.onsandboxready?.();
      oldBridge.oninitialized?.();
    });
    rerender(
      wrap(
        appDisplay({
          html: '<main>Replacement</main>',
          resourceUri: 'ui://demo/replacement',
        }),
      ),
    );
    const replacement = appBridgeMocks.last!;
    await act(async () => {
      replacement.onsandboxready?.();
      replacement.oninitialized?.();
    });
    const src = container.querySelector('iframe')?.getAttribute('src');
    appBridgeMocks.close.mockClear();
    await act(async () => {
      rejectHandoff(new Error('stale fixture handoff'));
    });
    await replacement.oncalltool!(
      { name: 'current' },
      { signal: new AbortController().signal },
    );
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(src);
    expect(container.querySelector('iframe')?.style.display).not.toBe('none');
    expect(container.textContent).not.toContain('Demo result');
    expect(callTool).toHaveBeenCalledOnce();
    expect(appBridgeMocks.close).not.toHaveBeenCalled();
  });

  it('does not rebuild AppBridge when display is a new object with the same fields', async () => {
    const { rerender } = renderApp(appDisplay());
    await act(async () => {
      await Promise.resolve();
    });
    expect(appBridgeMocks.constructed).toBe(1);

    rerender(<McpApp display={appDisplay()} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(appBridgeMocks.constructed).toBe(1);
    expect(appBridgeMocks.close).not.toHaveBeenCalled();
  });

  it('pushes theme changes through setHostContext instead of remounting', async () => {
    const display = appDisplay();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    const wrap = (
      theme: (typeof WebShellThemeId)[keyof typeof WebShellThemeId],
    ) => (
      <McpAppHostContext.Provider value="http://127.0.0.1:4170">
        <ThemeProvider value={theme}>
          <McpApp display={display} />
        </ThemeProvider>
      </McpAppHostContext.Provider>
    );

    act(() => root.render(wrap(WebShellThemeId.Dark)));
    await act(async () => {
      await Promise.resolve();
    });
    expect(appBridgeMocks.constructed).toBe(1);

    act(() => root.render(wrap(WebShellThemeId.Light)));
    await act(async () => {
      await Promise.resolve();
    });

    expect(appBridgeMocks.constructed).toBe(1);
    expect(appBridgeMocks.close).not.toHaveBeenCalled();
    expect(appBridgeMocks.setHostContext).toHaveBeenCalledWith(
      expect.objectContaining({ theme: WebShellThemeId.Light }),
    );
  });

  it('sends the sandbox resource after AppBridge reports ready', async () => {
    renderApp(appDisplay({ html: '<main>Ready</main>' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(appBridgeMocks.connect).toHaveBeenCalled();
    expect(appBridgeMocks.last?.onsandboxready).toEqual(expect.any(Function));

    await act(async () => {
      appBridgeMocks.last?.onsandboxready?.();
      await Promise.resolve();
    });

    const iframe = document.querySelector('iframe');
    expect(iframe?.getAttribute('sandbox')).toBe(
      'allow-scripts allow-forms allow-same-origin',
    );

    expect(appBridgeMocks.sendSandboxResourceReady).toHaveBeenCalledWith(
      expect.objectContaining({ html: '<main>Ready</main>' }),
    );

    await act(async () => {
      appBridgeMocks.last?.oninitialized?.();
      await Promise.resolve();
    });

    expect(appBridgeMocks.sendToolInput).toHaveBeenCalledWith({
      arguments: {},
    });
    expect(appBridgeMocks.sendToolResult).toHaveBeenCalledWith({ content: [] });
  });

  it('does not advertise or delegate requested sandbox permissions', async () => {
    const { container } = renderApp(
      appDisplay({
        permissions: {
          clipboardWrite: {},
          camera: {},
        } as McpAppDisplay['permissions'],
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(appBridgeMocks.lastCapabilities).toEqual({ sandbox: {} });
    expect(container.querySelector('iframe')?.getAttribute('allow')).toBeNull();
    expect(appBridgeMocks.last?.onsandboxready).toEqual(expect.any(Function));

    await act(async () => {
      appBridgeMocks.last?.onsandboxready?.();
      await Promise.resolve();
    });

    expect(appBridgeMocks.sendSandboxResourceReady).toHaveBeenCalledWith({
      html: '<main>Demo</main>',
    });
  });

  it('retries an unreachable isolated origin through an isolated data document then shows fallback', async () => {
    vi.useFakeTimers();
    try {
      const { container } = renderApp(appDisplay());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      const iframe = container.querySelector('iframe');
      expect(iframe?.getAttribute('src')).toContain('mode=data');
      expect(iframe?.getAttribute('sandbox')).toBe(
        'allow-scripts allow-forms allow-same-origin',
      );
      expect(new URL(iframe!.src).hostname).toBe('127.0.0.1');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(container.textContent).toContain('Demo result');
      expect(iframe?.getAttribute('src')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts remote Apps in data mode and closes after one failed handshake', async () => {
    vi.useFakeTimers();
    try {
      const { container } = renderApp(
        appDisplay(),
        WebShellThemeId.Dark,
        'https://daemon.example.com/proxy',
      );
      await act(async () => {
        await Promise.resolve();
      });
      const iframe = container.querySelector('iframe');
      expect(iframe?.src).toContain('/proxy/mcp-app-sandbox?');
      expect(iframe?.src).toContain('mode=data');
      expect(appBridgeMocks.constructed).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(iframe?.getAttribute('src')).toBeNull();
      expect(container.textContent).toContain('Demo result');
      expect(appBridgeMocks.constructed).toBe(1);
      expect(appBridgeMocks.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not update a closed bridge after theme change', async () => {
    vi.useFakeTimers();
    try {
      const display = appDisplay({ fallbackText: '' });
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      mounted.push({ root, container });
      const wrap = (
        theme: (typeof WebShellThemeId)[keyof typeof WebShellThemeId],
      ) => (
        <McpAppHostContext.Provider value="http://127.0.0.1:4170">
          <ThemeProvider value={theme}>
            <McpApp display={display} />
          </ThemeProvider>
        </McpAppHostContext.Provider>
      );
      act(() => root.render(wrap(WebShellThemeId.Dark)));
      await act(async () => {
        appBridgeMocks.last?.onsandboxready?.();
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(container.textContent).toContain('MCP App could not initialize.');
      expect(container.querySelector('iframe')?.getAttribute('src')).toBeNull();
      expect(appBridgeMocks.close).toHaveBeenCalledOnce();
      appBridgeMocks.setHostContext.mockClear();
      act(() => root.render(wrap(WebShellThemeId.Light)));
      expect(appBridgeMocks.setHostContext).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders fallbackText for compacted html and never mounts the sandbox', () => {
    const { container } = renderApp(appDisplay({ html: '' }));

    expect(container.textContent).toContain('Demo result');
    expect(container.querySelector('iframe')).toBeNull();
    expect(appBridgeMocks.constructed).toBe(0);
  });

  it('tears down the resource before unloading the iframe', async () => {
    let resolveTeardown: (() => void) | undefined;
    appBridgeMocks.teardownResource.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveTeardown = resolve;
        }),
    );

    const { container } = renderApp(appDisplay());
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      appBridgeMocks.last?.onsandboxready?.();
      await Promise.resolve();
    });
    await act(async () => {
      appBridgeMocks.last?.oninitialized?.();
      await Promise.resolve();
    });

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const removeAttribute = vi.spyOn(iframe!, 'removeAttribute');

    const entry = mounted.pop();
    act(() => entry?.root.unmount());

    expect(appBridgeMocks.teardownResource).toHaveBeenCalled();
    expect(removeAttribute).not.toHaveBeenCalled();

    await act(async () => {
      resolveTeardown?.();
      await Promise.resolve();
    });

    expect(removeAttribute).toHaveBeenCalledWith('src');
    expect(appBridgeMocks.close).toHaveBeenCalled();
    entry?.container.remove();
  });

  it('does not blank the live iframe when a superseded teardown settles', async () => {
    let resolveTeardown: (() => void) | undefined;
    appBridgeMocks.teardownResource.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveTeardown = resolve;
        }),
    );

    const { container, rerender } = renderApp(appDisplay());
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      appBridgeMocks.last?.onsandboxready?.();
      await Promise.resolve();
    });
    await act(async () => {
      appBridgeMocks.last?.oninitialized?.();
      await Promise.resolve();
    });

    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toContain('/mcp-app-sandbox');

    rerender(
      <McpApp
        display={appDisplay({
          toolResult: { content: [{ type: 'text', text: 'updated' }] },
        })}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(appBridgeMocks.constructed).toBe(2);
    expect(iframe?.getAttribute('src')).toContain('/mcp-app-sandbox');

    await act(async () => {
      resolveTeardown?.();
      await Promise.resolve();
    });

    expect(iframe?.getAttribute('src')).toContain('/mcp-app-sandbox');
  });
});

describe('McpApp server tool bridge', () => {
  it('bounds a page shared burst across two App cards to two active calls', async () => {
    const finishes: Array<() => void> = [];
    const callTool = vi.fn(
      () =>
        new Promise((resolve) => {
          finishes.push(() => resolve({ content: [] }));
        }),
    );
    const handlers = [];
    for (let index = 0; index < 2; index++) {
      const { rerender } = renderApp(appDisplay());
      rerender(
        <McpAppToolsContext.Provider value={{ sessionId: 's', callTool }}>
          <McpAppSessionContext.Provider value="s">
            <McpApp
              display={appDisplay({ resourceUri: 'ui://demo/' + index })}
            />
          </McpAppSessionContext.Provider>
        </McpAppToolsContext.Provider>,
      );
      handlers.push(appBridgeMocks.last!.oncalltool!);
    }
    const pending = Array.from({ length: 9 }, (_, index) =>
      handlers[index % 2](
        { name: 'slow' },
        { signal: new AbortController().signal },
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const dispatched = callTool.mock.calls.length;
    for (let i = 0; i < 9; i++) {
      await act(async () => {
        finishes.shift()?.();
        await Promise.resolve();
      });
    }
    await Promise.all(pending);
    expect(dispatched).toBe(2);
    expect(callTool).toHaveBeenCalledTimes(9);
  });
  it('removes cancelled and unmounted queued calls without releasing active requests early', async () => {
    const finishes: Array<() => void> = [];
    const callTool = vi.fn(
      (_request: unknown, _signal: AbortSignal) =>
        new Promise((resolve) => {
          finishes.push(() => resolve({ content: [] }));
        }),
    );
    const cards = [0, 1].map((index) => {
      const rendered = renderApp(appDisplay());
      rendered.rerender(
        <McpAppToolsContext.Provider value={{ sessionId: 's', callTool }}>
          <McpAppSessionContext.Provider value="s">
            <McpApp
              display={appDisplay({ resourceUri: `ui://demo/${index}` })}
            />
          </McpAppSessionContext.Provider>
        </McpAppToolsContext.Provider>,
      );
      return { ...rendered, invoke: appBridgeMocks.last!.oncalltool! };
    });
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const pending = controllers.map((controller, index) =>
      cards[index % 2]
        .invoke({ name: 'slow' }, { signal: controller.signal })
        .then(
          () => 'done',
          () => 'cancelled',
        ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(callTool).toHaveBeenCalledTimes(2);
    controllers[4].abort();
    expect(await pending[4]).toBe('cancelled');
    cards[1].rerender(null);
    expect(await pending[3]).toBe('cancelled');
    controllers[0].abort();
    await act(async () => {
      await Promise.resolve();
    });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect((callTool.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    expect((callTool.mock.calls[1][1] as AbortSignal).aborted).toBe(true);
    await act(async () => {
      finishes.shift()!();
      await Promise.resolve();
    });
    expect(callTool).toHaveBeenCalledTimes(3);
    await act(async () => {
      for (const finish of finishes.splice(0)) finish();
    });
    await Promise.all(pending);
  });

  it.each(['throw', 'reject'] as const)(
    'releases slots when the host call fails by %s',
    async (failure) => {
      const callTool = vi
        .fn()
        .mockImplementationOnce(() => {
          if (failure === 'throw') throw new Error('fixture failure');
          return Promise.reject(new Error('fixture failure'));
        })
        .mockResolvedValue({ content: [] });
      const { rerender } = renderApp(appDisplay());
      rerender(
        <McpAppToolsContext.Provider value={{ sessionId: 's', callTool }}>
          <McpAppSessionContext.Provider value="s">
            <McpApp display={appDisplay()} />
          </McpAppSessionContext.Provider>
        </McpAppToolsContext.Provider>,
      );
      const invoke = appBridgeMocks.last!.oncalltool!;
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          invoke({ name: 'tool' }, { signal: new AbortController().signal }),
        ),
      );
      expect(results.map((result) => result.status)).toEqual([
        'rejected',
        'fulfilled',
        'fulfilled',
        'fulfilled',
        'fulfilled',
      ]);
      expect(callTool).toHaveBeenCalledTimes(5);
    },
  );

  it('keeps queued calls alive and stops their heartbeat on cancellation', async () => {
    vi.useFakeTimers();
    const finishes: Array<() => void> = [];
    const callTool = vi.fn(
      () =>
        new Promise<{ content: [] }>((resolve) => {
          finishes.push(() => resolve({ content: [] }));
        }),
    );
    try {
      const { rerender } = renderApp(appDisplay());
      rerender(
        <McpAppToolsContext.Provider value={{ sessionId: 's', callTool }}>
          <McpAppSessionContext.Provider value="s">
            <McpApp display={appDisplay()} />
          </McpAppSessionContext.Provider>
        </McpAppToolsContext.Provider>,
      );
      await act(async () => {
        appBridgeMocks.last?.oninitialized?.();
      });
      const invoke = appBridgeMocks.last!.oncalltool!;
      const active = [0, 1].map(() =>
        invoke({ name: 'hold' }, { signal: new AbortController().signal }),
      );
      const abort = new AbortController();
      const sendNotification = vi.fn().mockResolvedValue(undefined);
      const queued = invoke(
        { name: 'queued', _meta: { progressToken: 19 } },
        { signal: abort.signal, sendNotification },
      ).catch(() => 'cancelled');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(callTool).toHaveBeenCalledTimes(2);
      expect(sendNotification).toHaveBeenCalledTimes(2);
      expect(sendNotification).toHaveBeenLastCalledWith({
        method: 'notifications/progress',
        params: { progressToken: 19, progress: 2 },
      });
      abort.abort();
      expect(await queued).toBe('cancelled');
      for (const finish of finishes.splice(0)) finish();
      await Promise.all(active);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(callTool).toHaveBeenCalledTimes(2);
      expect(sendNotification).toHaveBeenCalledTimes(2);
    } finally {
      for (const finish of finishes.splice(0)) finish();
      vi.useRealTimers();
    }
  });

  it.each([0, 'app-progress', undefined])(
    'keeps pending calls alive with the declared token %s and stops on abort',
    async (progressToken) => {
      vi.useFakeTimers();
      try {
        let resolve!: (value: unknown) => void;
        const callTool = vi.fn(
          () =>
            new Promise((done) => {
              resolve = done;
            }),
        );
        const { rerender } = renderApp(appDisplay());
        rerender(
          <McpAppToolsContext.Provider value={{ sessionId: 's', callTool }}>
            <McpAppSessionContext.Provider value="s">
              <McpApp display={appDisplay()} />
            </McpAppSessionContext.Provider>
          </McpAppToolsContext.Provider>,
        );
        await act(async () => {
          appBridgeMocks.last?.oninitialized?.();
        });
        const abort = new AbortController();
        const sendNotification = vi.fn().mockResolvedValue(undefined);
        const pending = appBridgeMocks.last!.oncalltool!(
          { name: 'slow', _meta: { progressToken } },
          { signal: abort.signal, requestId: 7, sendNotification },
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        if (progressToken === undefined)
          expect(sendNotification).not.toHaveBeenCalled();
        else {
          expect(sendNotification).toHaveBeenCalledTimes(2);
          expect(sendNotification).toHaveBeenLastCalledWith({
            method: 'notifications/progress',
            params: { progressToken, progress: 2 },
          });
        }
        abort.abort();
        const calls = sendNotification.mock.calls.length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(sendNotification).toHaveBeenCalledTimes(calls);
        resolve({ content: [] });
        await pending;
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(['success', 'failure'] as const)(
    'stops progress after tool %s',
    async (outcome) => {
      vi.useFakeTimers();
      try {
        let finish!: () => void;
        const callTool = vi.fn(
          () =>
            new Promise((resolve, reject) => {
              finish = () =>
                outcome === 'success'
                  ? resolve({ content: [] })
                  : reject(new Error('failed'));
            }),
        );
        const { rerender } = renderApp(appDisplay());
        rerender(
          <McpAppToolsContext.Provider value={{ sessionId: 's', callTool }}>
            <McpAppSessionContext.Provider value="s">
              <McpApp display={appDisplay()} />
            </McpAppSessionContext.Provider>
          </McpAppToolsContext.Provider>,
        );
        await act(async () => {
          appBridgeMocks.last?.oninitialized?.();
        });
        const sendNotification = vi.fn().mockResolvedValue(undefined);
        const result = appBridgeMocks.last!.oncalltool!(
          { name: 'slow', _meta: { progressToken: 7 } },
          {
            signal: new AbortController().signal,
            requestId: 7,
            sendNotification,
          },
        ).catch((error: unknown) => error);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(sendNotification).toHaveBeenCalledOnce();
        finish();
        await result;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(sendNotification).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('pins the source server, forwards raw results, and cancels on session change', async () => {
    const raw = {
      content: [],
      _meta: { token: 'PRIVATE' },
      structuredContent: { token: 'PRIVATE' },
    };
    const callTool = vi.fn().mockResolvedValue(raw);
    const { rerender } = renderApp(appDisplay());
    const render = (sessionId: string) => (
      <McpAppToolsContext.Provider value={{ sessionId: 'original', callTool }}>
        <McpAppSessionContext.Provider value={sessionId}>
          <McpApp display={appDisplay()} />
        </McpAppSessionContext.Provider>
      </McpAppToolsContext.Provider>
    );
    rerender(render('original'));
    expect(appBridgeMocks.lastCapabilities).toEqual({
      sandbox: {},
      serverTools: {},
    });
    const result = await appBridgeMocks.last!.oncalltool!(
      { name: 'get-embed-token' },
      { signal: new AbortController().signal },
    );
    expect(result).toBe(raw);
    expect(callTool).toHaveBeenCalledWith(
      {
        serverName: 'demo',
        resourceUri: 'ui://demo/app',
        name: 'get-embed-token',
        arguments: {},
      },
      expect.any(AbortSignal),
    );
    const signal = callTool.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    rerender(render('other-session'));
    expect(signal.aborted).toBe(true);
    expect(appBridgeMocks.lastCapabilities).toEqual({ sandbox: {} });
    expect(appBridgeMocks.last?.oncalltool).toBeUndefined();
  });
});
