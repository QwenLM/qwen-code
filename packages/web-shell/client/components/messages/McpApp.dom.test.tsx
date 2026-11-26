// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  McpAppHostContext,
  McpAppGeneratedUiContext,
  type McpAppGeneratedUi,
  McpAppMessagesContext,
  McpAppModelContextContext,
  McpAppSessionContext,
  McpAppToolsContext,
} from '../../mcpAppHostContext';
import { useMcpAppMessages } from '../../hooks/useMcpAppMessages';
import { I18nProvider } from '../../i18n';
import { ThemeProvider, WebShellThemeId } from '../../themeContext';
import type { McpAppDisplay } from './McpApp';

const appBridgeMocks = vi.hoisted(() => ({
  constructed: 0,
  last: null as {
    onsandboxready?: () => void;
    oninitialized?: () => void;
    onsizechange?: (params: { height?: number; width?: number }) => void;
    onupdatemodelcontext?: (params: {
      content?: Array<{ type: string; text?: string }>;
    }) => Promise<unknown>;
    onmessage?: (
      params: { role: string; content: Array<Record<string, unknown>> },
      extra: { signal: AbortSignal },
    ) => Promise<unknown>;
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
    fallbackRequestHandler?: (
      request: { method: string; params?: Record<string, unknown> },
      extra?: { signal: AbortSignal },
    ) => Promise<unknown>;
    ondownloadfile?: (params: unknown) => Promise<unknown>;
  } | null,
  lastCapabilities: undefined as unknown,
  lastOptions: undefined as unknown,
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
    constructor(
      _app: unknown,
      _info: unknown,
      capabilities?: unknown,
      options?: unknown,
    ) {
      appBridgeMocks.constructed += 1;
      appBridgeMocks.lastOptions = options;
      appBridgeMocks.last = this;
      appBridgeMocks.lastCapabilities = capabilities;
    }
  },
}));

import { McpApp, McpAppRuntime } from './McpApp';

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

// A review that ended before dispatch reports why nothing was sent.
const notSent = (phase: 'cancelled' | 'expired') => ({
  isError: true,
  _meta: { 'qwen-code/message-review': phase },
});

describe('McpApp host lifetime', () => {
  it('advertises messages only for the bound transcript session', () => {
    const requestMessage = vi.fn().mockResolvedValue({});
    const { rerender } = renderApp(appDisplay());
    const wrap = (sessionId: string) => (
      <McpAppMessagesContext.Provider
        value={{ sessionId: 'live', requestMessage }}
      >
        <McpAppSessionContext.Provider value={sessionId}>
          <McpApp display={appDisplay()} />
        </McpAppSessionContext.Provider>
      </McpAppMessagesContext.Provider>
    );
    rerender(wrap('live'));
    expect(appBridgeMocks.lastCapabilities).toMatchObject({
      message: { text: {} },
    });
    expect(appBridgeMocks.last?.onmessage).toBeTypeOf('function');
    rerender(wrap('historical'));
    expect(appBridgeMocks.lastCapabilities).not.toHaveProperty('message');
    expect(appBridgeMocks.last?.onmessage).toBeUndefined();
  });

  it('validates the role, single text block and UTF-8 byte limit before review', async () => {
    const requestMessage = vi.fn().mockResolvedValue({});
    const { rerender } = renderApp(appDisplay());
    rerender(
      <McpAppMessagesContext.Provider
        value={{ sessionId: 's', requestMessage }}
      >
        <McpAppSessionContext.Provider value="s">
          <McpApp display={appDisplay()} />
        </McpAppSessionContext.Provider>
      </McpAppMessagesContext.Provider>,
    );
    const invoke = appBridgeMocks.last!.onmessage!;
    for (const params of [
      { role: 'assistant', content: [{ type: 'text', text: 'no' }] },
      { role: 'system', content: [{ type: 'text', text: 'no' }] },
      { role: 'user', content: [] },
      { role: 'user', content: [{ type: 'text', text: '   ' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'image', data: 'x', mimeType: 'image/png' }],
      },
      {
        role: 'user',
        content: [{ type: 'resource', resource: { uri: 'file:///a' } }],
      },
      { role: 'user', content: [{ type: 'text', text: '界'.repeat(5462) }] },
    ]) {
      expect(
        await invoke(params, { signal: new AbortController().signal }),
      ).toEqual({ isError: true });
    }
    expect(requestMessage).not.toHaveBeenCalled();
    const text = '界'.repeat(5461) + 'a';
    expect(
      await invoke(
        { role: 'user', content: [{ type: 'text', text }] },
        { signal: new AbortController().signal },
      ),
    ).toEqual({});
    expect(requestMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'demo',
        resourceUri: 'ui://demo/app',
        text,
      }),
    );
    expect(requestMessage.mock.calls[0][0]).not.toHaveProperty(
      'requiredFeature',
    );
  });

  it('releases settled message requests and aborts pending ones on resource replacement', async () => {
    let settle!: (result: object) => void;
    const requestMessage = vi.fn(
      (_request: { signal: AbortSignal }) =>
        new Promise<object>((resolve) => {
          settle = resolve;
        }),
    );
    const { rerender } = renderApp(appDisplay());
    const wrap = (resourceUri: string) => (
      <McpAppMessagesContext.Provider
        value={{ sessionId: 's', requestMessage }}
      >
        <McpAppSessionContext.Provider value="s">
          <McpApp display={appDisplay({ resourceUri })} />
        </McpAppSessionContext.Provider>
      </McpAppMessagesContext.Provider>
    );
    rerender(wrap('ui://demo/app'));
    const oldBridge = appBridgeMocks.last!;
    const invoke = oldBridge.onmessage!;
    const params = {
      role: 'user',
      content: [{ type: 'text', text: 'review me' }],
    };
    const first = invoke(params, { signal: new AbortController().signal });
    expect(
      await invoke(params, { signal: new AbortController().signal }),
    ).toEqual({ isError: true });
    expect(requestMessage).toHaveBeenCalledTimes(1);
    rerender(wrap('ui://demo/replacement'));
    expect(requestMessage.mock.calls[0][0].signal.aborted).toBe(true);
    expect(oldBridge.onmessage).toBeUndefined();
    expect(
      await invoke(params, { signal: new AbortController().signal }),
    ).toEqual({ isError: true });
    settle({ isError: true });
    await first;
    const second = appBridgeMocks.last!.onmessage!(params, {
      signal: new AbortController().signal,
    });
    settle({});
    expect(await second).toEqual({});
    const third = appBridgeMocks.last!.onmessage!(params, {
      signal: new AbortController().signal,
    });
    expect(requestMessage).toHaveBeenCalledTimes(3);
    settle({ isError: true });
    await third;
  });

  it.each(['client recovery', 'transport reconnect'])(
    'preserves the iframe and tool calls across %s while invalidating old reviews',
    async (change) => {
      let finishTool!: (result: { content: [] }) => void;
      const callTool = vi.fn(
        (_request: unknown, _signal: AbortSignal) =>
          new Promise<{ content: [] }>((resolve) => {
            finishTool = resolve;
          }),
      );
      const submit = vi.fn().mockResolvedValue(undefined);
      const captureOwner = () => ({ isCurrent: () => true });
      function BoundApp({ clientId = 'client-a', enabled = true }) {
        const { context } = useMcpAppMessages({
          sessionId: 's',
          clientId,
          enabled,
          captureOwner,
          submit,
        });
        return (
          <McpAppMessagesContext.Provider value={context}>
            <McpAppToolsContext.Provider value={{ sessionId: 's', callTool }}>
              <McpAppSessionContext.Provider value="s">
                <McpApp display={appDisplay()} />
              </McpAppSessionContext.Provider>
            </McpAppToolsContext.Provider>
          </McpAppMessagesContext.Provider>
        );
      }
      const { container, rerender } = renderApp(appDisplay());
      await act(async () => rerender(<BoundApp />));
      const bridge = appBridgeMocks.last!;
      const iframe = container.querySelector('iframe');
      const src = iframe!.src;
      const constructed = appBridgeMocks.constructed;
      const params = {
        role: 'user',
        content: [{ type: 'text', text: 'review' }],
      };
      let pendingMessage!: Promise<unknown>;
      let pendingTool!: Promise<unknown>;
      await act(async () => {
        pendingMessage = bridge.onmessage!(params, {
          signal: new AbortController().signal,
        });
        pendingTool = bridge.oncalltool!(
          { name: 'query' },
          { signal: new AbortController().signal },
        );
      });
      await act(async () =>
        rerender(
          <BoundApp
            clientId={change === 'client recovery' ? 'client-b' : 'client-a'}
            enabled={change !== 'transport reconnect'}
          />,
        ),
      );
      expect(await pendingMessage).toEqual(notSent('cancelled'));
      expect(appBridgeMocks.last).toBe(bridge);
      expect(appBridgeMocks.constructed).toBe(constructed);
      expect(container.querySelector('iframe')).toBe(iframe);
      expect(iframe!.src).toBe(src);
      expect(callTool.mock.calls[0][1].aborted).toBe(false);
      await act(async () => rerender(<BoundApp clientId="client-b" />));
      expect(appBridgeMocks.last).toBe(bridge);
      let fresh!: Promise<unknown>;
      await act(async () => {
        fresh = bridge.onmessage!(params, {
          signal: new AbortController().signal,
        });
      });
      await act(async () =>
        rerender(<BoundApp clientId="client-b" enabled={false} />),
      );
      expect(await fresh).toEqual(notSent('cancelled'));
      expect(submit).not.toHaveBeenCalled();
      finishTool({ content: [] });
      await pendingTool;
    },
  );

  it('propagates RPC cancellation and revokes messages on failed initialization', async () => {
    appBridgeMocks.sendToolInput.mockRejectedValueOnce(
      new Error('handoff failed'),
    );
    let signal: AbortSignal | undefined;
    const requestMessage = vi.fn((request: { signal: AbortSignal }) => {
      signal = request.signal;
      return Promise.resolve({ isError: true });
    });
    const { rerender } = renderApp(appDisplay());
    rerender(
      <McpAppMessagesContext.Provider
        value={{ sessionId: 's', requestMessage }}
      >
        <McpAppSessionContext.Provider value="s">
          <McpApp display={appDisplay()} />
        </McpAppSessionContext.Provider>
      </McpAppMessagesContext.Provider>,
    );
    const bridge = appBridgeMocks.last!;
    const caller = new AbortController();
    await bridge.onmessage!(
      { role: 'user', content: [{ type: 'text', text: 'review' }] },
      { signal: caller.signal },
    );
    caller.abort();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      bridge.oninitialized?.();
    });
    expect(bridge.onmessage).toBeUndefined();
  });

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

  it('sends the Web Shell language and pushes language changes', async () => {
    const display = appDisplay();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const wrap = (language: 'zh-CN' | 'en') => (
      <I18nProvider language={language}>
        <McpAppHostContext.Provider value="http://127.0.0.1:4170">
          <ThemeProvider value={WebShellThemeId.Dark}>
            <McpApp display={display} />
          </ThemeProvider>
        </McpAppHostContext.Provider>
      </I18nProvider>
    );

    act(() => root.render(wrap('zh-CN')));
    await act(async () => {
      await Promise.resolve();
    });
    expect(appBridgeMocks.lastOptions).toMatchObject({
      hostContext: { locale: 'zh-CN' },
    });

    act(() => root.render(wrap('en')));
    await act(async () => {
      await Promise.resolve();
    });
    expect(appBridgeMocks.constructed).toBe(1);
    expect(appBridgeMocks.setHostContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ locale: 'en' }),
    );
  });

  it('passes theme-specific style variables resolved from Web Shell tokens', async () => {
    const display = appDisplay();
    // jsdom does not inherit custom properties, so declare them on the card.
    const tokens = document.createElement('style');
    tokens.textContent =
      '[data-testid="mcp-app"] { --background: rgb(10, 10, 10); ' +
      '--foreground: rgb(250, 250, 250); --muted-foreground: rgb(161, 161, 161); ' +
      '--secondary-foreground: rgb(116, 116, 118); }';
    document.head.appendChild(tokens);
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
    expect(appBridgeMocks.lastOptions).toMatchObject({
      hostContext: {
        theme: WebShellThemeId.Dark,
        styles: {
          variables: expect.objectContaining({
            '--color-background-primary': 'rgb(10, 10, 10)',
            '--color-text-primary': 'rgb(250, 250, 250)',
            '--color-text-secondary': 'rgb(161, 161, 161)',
          }),
        },
      },
    });

    act(() => root.render(wrap(WebShellThemeId.Light)));
    await act(async () => {
      await Promise.resolve();
    });
    expect(appBridgeMocks.setHostContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: WebShellThemeId.Light,
        styles: {
          variables: expect.objectContaining({
            '--color-text-secondary': 'rgb(116, 116, 118)',
          }),
        },
      }),
    );
    tokens.remove();
  });

  it('ignores a size reported while the App had no width', async () => {
    const { container } = renderApp(appDisplay({ html: '<main>Ready</main>' }));
    await act(async () => {
      await Promise.resolve();
    });
    const iframe = container.querySelector('iframe')!;
    await act(async () => {
      appBridgeMocks.last?.onsizechange?.({ height: 300, width: 600 });
    });
    expect(iframe.style.height).toBe('300px');
    await act(async () => {
      appBridgeMocks.last?.onsizechange?.({ height: 3656, width: 0 });
    });
    expect(iframe.style.height).toBe('300px');
    await act(async () => {
      appBridgeMocks.last?.onsizechange?.({ height: 3000, width: 600 });
    });
    // Other MCP Apps keep the generic cap.
    expect(iframe.style.height).toBe('960px');
  });

  it('keeps the frame out of sight until the App initializes', async () => {
    const { container } = renderApp(appDisplay({ html: '<main>Ready</main>' }));
    await act(async () => {
      await Promise.resolve();
    });
    const iframe = container.querySelector('iframe')!;
    // A sandbox origin that is not reachable yet must not show its error page.
    expect(iframe.style.visibility).toBe('hidden');
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'mcpApp.loading',
    );
    await act(async () => {
      appBridgeMocks.last?.onsandboxready?.();
      appBridgeMocks.last?.oninitialized?.();
      await Promise.resolve();
    });
    expect(iframe.style.visibility).toBe('');
    expect(container.querySelector('[role="status"]')).toBeNull();
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

describe('built-in Generated UI admission', () => {
  const display = appDisplay({
    serverName: 'generated-ui',
    resourceUri: 'ui://qwen-code-generated-ui/view-v1.html',
    requiredFeature: 'generated-ui',
    fallbackText: 'Saved calculation summary',
  });

  it.each([
    undefined,
    { sessionId: 'other', status: { version: 1, enabled: true } },
    { sessionId: 'owner', status: { version: 1, enabled: false } },
    { sessionId: 'owner', status: { version: 2, enabled: true } },
    { sessionId: 'owner', status: { version: 1, enabled: 'true' } },
  ])(
    'does not create an App bridge or iframe without an enabled owner: %j',
    (value) => {
      const { container, rerender } = renderApp(display);
      rerender(
        <McpAppGeneratedUiContext.Provider
          value={value as McpAppGeneratedUi | undefined}
        >
          <McpAppSessionContext.Provider value="owner">
            <McpApp display={display} />
          </McpAppSessionContext.Provider>
        </McpAppGeneratedUiContext.Provider>,
      );
      expect(container.textContent).toContain('Saved calculation summary');
      expect(container.querySelector('iframe')).toBeNull();
      expect(appBridgeMocks.constructed).toBe(0);
    },
  );

  it('mounts only with its owner and tears down before falling back on detach', async () => {
    const { container, rerender } = renderApp(display);
    const render = (sessionId: string) => (
      <McpAppGeneratedUiContext.Provider
        value={{ sessionId: 'owner', status: { version: 1, enabled: true } }}
      >
        <McpAppSessionContext.Provider value={sessionId}>
          <McpApp display={display} />
        </McpAppSessionContext.Provider>
      </McpAppGeneratedUiContext.Provider>
    );
    rerender(render('owner'));
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(appBridgeMocks.constructed).toBe(1);
    rerender(render('other'));
    expect(container.querySelector('iframe')).toBeNull();
    expect(appBridgeMocks.constructed).toBe(1);
    await vi.waitFor(() => expect(appBridgeMocks.close).toHaveBeenCalledOnce());
  });

  it.each([
    { requiredFeature: undefined },
    { resourceUri: 'ui://unrelated/app' },
  ] as Partial<McpAppDisplay>[])(
    'restricts either built-in identity independently: %j',
    (override) => {
      const { container } = renderApp({ ...display, ...override });
      expect(container.querySelector('iframe')).toBeNull();
      expect(appBridgeMocks.constructed).toBe(0);
    },
  );

  it('shows the saved title and summary instead of the structured result text', () => {
    const { container } = renderApp({
      ...display,
      fallbackText:
        '{"schemaVersion":1,"documentId":"g1_abc","title":"Bill","summary":"Each pays 154."}\nBill\nEach pays 154.',
      toolResult: {
        content: [{ type: 'text', text: 'Bill\nEach pays 154.' }],
        structuredContent: {
          schemaVersion: 1,
          documentId: 'g1_abc',
          title: 'Bill',
          summary: 'Each pays 154.',
        },
      },
    });
    expect(container.textContent).toContain('Bill');
    expect(container.textContent).toContain('Each pays 154.');
    expect(container.textContent).not.toContain('schemaVersion');
    expect(container.textContent).toContain('mcpApp.generatedUi.unavailable');
  });

  it('lets the built-in card grow past the generic App height cap', async () => {
    const { rerender } = renderApp(display);
    rerender(
      <McpAppGeneratedUiContext.Provider
        value={{ sessionId: 'owner', status: { version: 1, enabled: true } }}
      >
        <McpAppSessionContext.Provider value="owner">
          <McpApp display={display} />
        </McpAppSessionContext.Provider>
      </McpAppGeneratedUiContext.Provider>,
    );
    expect(appBridgeMocks.lastOptions).toMatchObject({
      hostContext: { containerDimensions: { maxHeight: 4000 } },
    });
  });

  it('labels the built-in card as an interactive view without MCP plumbing', () => {
    const { container, rerender } = renderApp(display);
    rerender(
      <McpAppGeneratedUiContext.Provider
        value={{ sessionId: 'owner', status: { version: 1, enabled: true } }}
      >
        <McpAppSessionContext.Provider value="owner">
          <McpApp display={display} />
        </McpAppSessionContext.Provider>
      </McpAppGeneratedUiContext.Provider>,
    );
    // This suite renders without an I18nProvider, so keys stand in for text.
    expect(container.querySelector('iframe')?.title).toBe(
      'mcpApp.generatedUi.title',
    );
    expect(container.textContent).not.toContain('MCP App');
  });

  it('marks its messages as coming from the bundled server', async () => {
    const requestMessage = vi.fn().mockResolvedValue({});
    const { rerender } = renderApp(display);
    rerender(
      <McpAppGeneratedUiContext.Provider
        value={{ sessionId: 'owner', status: { version: 1, enabled: true } }}
      >
        <McpAppMessagesContext.Provider
          value={{ sessionId: 'owner', requestMessage }}
        >
          <McpAppSessionContext.Provider value="owner">
            <McpApp display={display} />
          </McpAppSessionContext.Provider>
        </McpAppMessagesContext.Provider>
      </McpAppGeneratedUiContext.Provider>,
    );
    await appBridgeMocks.last!.onmessage!(
      { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
      { signal: new AbortController().signal },
    );
    expect(requestMessage).toHaveBeenCalledWith(
      expect.objectContaining({ requiredFeature: 'generated-ui' }),
    );
  });

  it('keeps the MCP framing for a server that only claims the bundled resource', () => {
    const claimed = { ...display, serverName: 'third-party' };
    delete claimed.requiredFeature;
    const { container, rerender } = renderApp(claimed);
    rerender(
      <McpAppGeneratedUiContext.Provider
        value={{ sessionId: 'owner', status: { version: 1, enabled: true } }}
      >
        <McpAppSessionContext.Provider value="owner">
          <McpApp display={claimed} />
        </McpAppSessionContext.Provider>
      </McpAppGeneratedUiContext.Provider>,
    );
    expect(container.querySelector('iframe')?.title).toBe(
      'third-party MCP App',
    );
    expect(container.textContent).toContain('MCP App');
    expect(container.textContent).toContain('third-party');
    expect(appBridgeMocks.lastOptions).toMatchObject({
      hostContext: { containerDimensions: { maxHeight: 960 } },
    });
  });

  it('attaches the card values to the owning session composer', async () => {
    const attach = vi.fn();
    const requestMessage = vi.fn().mockResolvedValue({});
    const card = {
      ...display,
      toolResult: {
        content: [{ type: 'text', text: 'Bill' }],
        structuredContent: {
          schemaVersion: 1,
          documentId: 'g1_doc',
          title: 'Bill',
          summary: 'Each pays 154.',
        },
      },
    };
    const { rerender } = renderApp(card);
    const wrap = (contextSession: string) => (
      <McpAppGeneratedUiContext.Provider
        value={{ sessionId: 'owner', status: { version: 1, enabled: true } }}
      >
        <McpAppSessionContext.Provider value="owner">
          <McpAppMessagesContext.Provider
            value={{ sessionId: 'owner', requestMessage }}
          >
            <McpAppModelContextContext.Provider
              value={{ sessionId: contextSession, attach }}
            >
              <McpApp display={card} />
            </McpAppModelContextContext.Provider>
          </McpAppMessagesContext.Provider>
        </McpAppSessionContext.Provider>
      </McpAppGeneratedUiContext.Provider>
    );
    rerender(wrap('owner'));
    expect(appBridgeMocks.lastCapabilities).toMatchObject({
      updateModelContext: { text: {} },
    });
    const update = appBridgeMocks.last!.onupdatemodelcontext!;
    await act(async () => {
      await update({ content: [{ type: 'text', text: 'people: 7' }] });
    });
    expect(attach).toHaveBeenCalledWith({
      id: 'generated-ui:g1_doc',
      title: 'Bill',
      text: 'people: 7',
    });
    attach.mockClear();
    await act(async () => {
      await update({ content: [{ type: 'text', text: 'x'.repeat(17000) }] });
    });
    expect(attach).not.toHaveBeenCalled();
    // A composer that now belongs to another session never receives it.
    rerender(wrap('other'));
    await act(async () => {
      await appBridgeMocks.last!.onupdatemodelcontext!({
        content: [{ type: 'text', text: 'people: 8' }],
      });
    });
    expect(attach).not.toHaveBeenCalled();
  });

  it('does not offer model context to other MCP Apps', () => {
    const { rerender } = renderApp(appDisplay());
    rerender(
      <McpAppMessagesContext.Provider
        value={{ sessionId: 'live', requestMessage: vi.fn() }}
      >
        <McpAppSessionContext.Provider value="live">
          <McpAppModelContextContext.Provider
            value={{ sessionId: 'live', attach: vi.fn() }}
          >
            <McpApp display={appDisplay()} />
          </McpAppModelContextContext.Provider>
        </McpAppSessionContext.Provider>
      </McpAppMessagesContext.Provider>,
    );
    expect(appBridgeMocks.lastCapabilities).not.toHaveProperty(
      'updateModelContext',
    );
    expect(appBridgeMocks.last?.onupdatemodelcontext).toBeUndefined();
  });

  describe('saved card state', () => {
    const CARD = 'gc_aaaaaaaaaaaaaaaaaaaaaa';
    const card = {
      ...display,
      toolResult: {
        content: [{ type: 'text', text: 'Checklist' }],
        _meta: { 'qwen/generated-ui': { cardId: CARD } },
      },
    };
    function host(
      shown: McpAppDisplay,
      viewState: {
        get: ReturnType<typeof vi.fn>;
        set: ReturnType<typeof vi.fn>;
      },
      toolSession = 'owner',
    ) {
      const { container, rerender } = renderApp(shown);
      rerender(
        <McpAppGeneratedUiContext.Provider
          value={{ sessionId: 'owner', status: { version: 1, enabled: true } }}
        >
          <McpAppSessionContext.Provider value="owner">
            <McpAppToolsContext.Provider
              value={{ sessionId: toolSession, callTool: vi.fn(), viewState }}
            >
              <McpApp display={shown} />
            </McpAppToolsContext.Provider>
          </McpAppSessionContext.Provider>
        </McpAppGeneratedUiContext.Provider>,
      );
      return container;
    }
    const store = () => ({
      get: vi.fn().mockResolvedValue({ cardId: CARD, revision: 3, value: [1] }),
      set: vi
        .fn()
        .mockResolvedValue({ outcome: 'saved', cardId: CARD, revision: 4 }),
    });

    it('answers for the card it mounted and shows the outcome itself', async () => {
      const viewState = store();
      const container = host(card, viewState);
      expect(appBridgeMocks.lastCapabilities).toMatchObject({
        experimental: { 'qwen-code/generated-ui-state': {} },
      });
      const request = appBridgeMocks.last!.fallbackRequestHandler!;
      await act(async () => {
        await expect(
          request({ method: 'qwen-code/generated-ui-state/load', params: {} }),
        ).resolves.toEqual({ value: [1] });
      });
      expect(viewState.get).toHaveBeenCalledWith(CARD);
      await act(async () => {
        await request({
          method: 'qwen-code/generated-ui-state/save',
          params: { value: [1, 2], cardId: 'gc_bbbbbbbbbbbbbbbbbbbbbb' },
        });
      });
      expect(viewState.set).toHaveBeenCalledWith(CARD, {
        baseRevision: 3,
        value: [1, 2],
      });
      await vi.waitFor(() =>
        expect(
          container
            .querySelector('[data-generated-ui-save]')
            ?.getAttribute('data-generated-ui-save'),
        ).toBe('saved'),
      );
      await expect(
        request({ method: 'qwen-code/other', params: {} }),
      ).rejects.toThrow();
    });

    it('reports a cancelled load and ignores a late successful read', async () => {
      const viewState = store();
      const read = Promise.withResolvers<{
        cardId: string;
        revision: number;
        value: number[];
      }>();
      viewState.get.mockReturnValueOnce(read.promise);
      const container = host(card, viewState);
      const request = appBridgeMocks.last!.fallbackRequestHandler!;
      const abort = new AbortController();
      const loading = request(
        { method: 'qwen-code/generated-ui-state/load' },
        { signal: abort.signal },
      );
      await vi.waitFor(() => expect(viewState.get).toHaveBeenCalledWith(CARD));
      await act(async () => abort.abort(new Error('Request timed out')));
      const unavailable = container.querySelector(
        '[data-generated-ui-save="unavailable"]',
      );
      read.resolve({ cardId: CARD, revision: 3, value: [1] });
      await expect(loading).rejects.toThrow('Request timed out');
      expect(unavailable).not.toBeNull();
      await request({
        method: 'qwen-code/generated-ui-state/save',
        params: { value: [2] },
      });
      expect(viewState.set).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a result without a card id',
        { ...display, toolResult: { content: [] } },
        'owner',
      ],
      [
        'another MCP App claiming a card id',
        { ...card, serverName: 'demo', requiredFeature: undefined },
        'owner',
      ],
      ['a host of another session', card, 'other'],
    ])('does not offer state for %s', async (_name, shown, toolSession) => {
      const viewState = store();
      host(shown as McpAppDisplay, viewState, toolSession);
      expect(appBridgeMocks.lastCapabilities).not.toHaveProperty([
        'experimental',
        'qwen-code/generated-ui-state',
      ]);
      const request = appBridgeMocks.last?.fallbackRequestHandler;
      if (request) {
        await expect(
          request({ method: 'qwen-code/generated-ui-state/load', params: {} }),
        ).rejects.toThrow();
      }
      expect(viewState.get).not.toHaveBeenCalled();
    });
  });

  describe('copy and download', () => {
    const writeText = vi.fn();
    beforeEach(() => {
      writeText.mockReset().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });
    function host(shown: McpAppDisplay = display) {
      const { container, rerender } = renderApp(shown);
      rerender(
        <McpAppGeneratedUiContext.Provider
          value={{ sessionId: 'owner', status: { version: 1, enabled: true } }}
        >
          <McpAppSessionContext.Provider value="owner">
            <McpApp display={shown} />
          </McpAppSessionContext.Provider>
        </McpAppGeneratedUiContext.Provider>,
      );
      return container;
    }
    const outcome = (container: HTMLElement) => {
      const status = container.querySelector('[data-generated-ui-effect]');
      return status
        ? {
            status: status.getAttribute('data-generated-ui-effect'),
            count: status.getAttribute('data-generated-ui-effect-count'),
            text: status.textContent,
          }
        : undefined;
    };
    const copy = (text: unknown) =>
      appBridgeMocks.last!.fallbackRequestHandler!({
        method: 'qwen-code/generated-ui-copy/write',
        params: { text } as Record<string, unknown>,
      });
    const download = (resource: Record<string, unknown>) =>
      appBridgeMocks.last!.ondownloadfile!({
        contents: [
          {
            type: 'resource',
            resource: {
              uri: 'file:///plans',
              mimeType: 'text/csv',
              text: 'plan,payment\n',
              ...resource,
            },
          },
        ],
      });

    it('is offered to the bundled card only', () => {
      host();
      expect(appBridgeMocks.lastCapabilities).toMatchObject({
        downloadFile: {},
        experimental: { 'qwen-code/generated-ui-copy': {} },
      });
      renderApp(appDisplay());
      expect(appBridgeMocks.lastCapabilities).not.toHaveProperty(
        'downloadFile',
      );
      expect(appBridgeMocks.lastCapabilities).not.toHaveProperty(
        'experimental',
      );
      expect(appBridgeMocks.last?.ondownloadfile).toBeUndefined();
    });

    // This suite renders without an I18nProvider, so keys stand in for text.
    it('copies in the page and counts each outcome as a new observation', async () => {
      const container = host();
      await act(async () => {
        await expect(copy('Total: 12.30')).resolves.toEqual({});
      });
      expect(writeText).toHaveBeenCalledWith('Total: 12.30');
      expect(outcome(container)).toEqual({
        status: 'copied',
        count: '1',
        text: 'mcpApp.generatedUi.effect.copied',
      });
      await act(async () => {
        await copy('Total: 12.40');
      });
      expect(outcome(container)).toMatchObject({
        status: 'copied',
        count: '2',
      });
    });

    it('refuses invalid text without touching the clipboard', async () => {
      const container = host();
      await act(async () => {
        await expect(copy('')).rejects.toThrow();
        await expect(copy('x'.repeat(16 * 1024 + 1))).rejects.toThrow();
      });
      expect(writeText).not.toHaveBeenCalled();
      expect(outcome(container)).toMatchObject({
        status: 'refused',
        count: '2',
      });
    });

    it('offers its own Copy button when the browser refuses the write', async () => {
      writeText.mockRejectedValueOnce(new DOMException('', 'NotAllowedError'));
      const container = host();
      await act(async () => {
        await copy('Total: 12.30');
      });
      expect(outcome(container)).toMatchObject({ status: 'copy-pending' });
      const button = [...container.querySelectorAll('button')].find(
        (candidate) =>
          candidate.textContent === 'mcpApp.generatedUi.effect.copy',
      )!;
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenLastCalledWith('Total: 12.30');
      expect(outcome(container)).toMatchObject({
        status: 'copied',
        count: '2',
      });
      expect(
        [...container.querySelectorAll('button')].some(
          (candidate) =>
            candidate.textContent === 'mcpApp.generatedUi.effect.copy',
        ),
      ).toBe(false);
    });

    it('holds the effect slot during a host Copy retry', async () => {
      const retry = Promise.withResolvers<void>();
      writeText
        .mockRejectedValueOnce(new DOMException('', 'NotAllowedError'))
        .mockReturnValueOnce(retry.promise);
      const container = host();
      const copyButton = () =>
        [...container.querySelectorAll('button')].find(
          (candidate) =>
            candidate.textContent === 'mcpApp.generatedUi.effect.copy',
        )!;
      await act(async () => {
        await copy('Original text');
      });
      await act(async () => {
        const button = copyButton();
        button.click();
        button.click();
      });
      expect(writeText).toHaveBeenCalledTimes(2);
      await act(async () => {
        await expect(copy('New text')).rejects.toThrow();
        await expect(download({})).resolves.toEqual({ isError: true });
        retry.reject(new DOMException('', 'NotAllowedError'));
      });
      expect(outcome(container)).toMatchObject({ status: 'copy-pending' });
      await act(async () => {
        copyButton().click();
      });
      expect(writeText.mock.calls).toEqual([
        ['Original text'],
        ['Original text'],
        ['Original text'],
      ]);
      expect(outcome(container)).toMatchObject({ status: 'copied' });
    });

    it('refuses a second effect while a copy is still being written', async () => {
      const write = Promise.withResolvers<void>();
      writeText.mockReturnValueOnce(write.promise);
      const container = host();
      let first!: Promise<unknown>;
      await act(async () => {
        first = copy('first');
        await expect(copy('second')).rejects.toThrow();
        await expect(download({})).resolves.toEqual({ isError: true });
      });
      expect(outcome(container)).toMatchObject({
        status: 'refused',
        count: '2',
      });
      await act(async () => {
        write.resolve();
        await first;
      });
      expect(writeText).toHaveBeenCalledExactlyOnceWith('first');
      expect(outcome(container)).toMatchObject({
        status: 'copied',
        count: '3',
      });
    });

    it('refuses effects while a retained card is hidden', async () => {
      let visible = false;
      const retained = {
        reopened: false,
        getSignal: () => new AbortController().signal,
        isVisible: () => visible,
        reset: vi.fn(),
      };
      const { container, rerender } = renderApp(display);
      rerender(<McpAppRuntime display={display} retained={retained} />);
      await act(async () => {
        await expect(copy('Total: 12.30')).rejects.toThrow();
        await expect(download({})).resolves.toEqual({ isError: true });
      });
      expect(writeText).not.toHaveBeenCalled();
      visible = true;
      await act(async () => {
        await copy('Total: 12.30');
      });
      expect(writeText).toHaveBeenCalledOnce();
      expect(outcome(container)).toMatchObject({
        status: 'copied',
        count: '3',
      });
    });

    it('offers neither effect in the transcript view', () => {
      vi.stubEnv('MODE', 'transcript');
      try {
        const { rerender } = renderApp(display);
        rerender(<McpAppRuntime display={display} />);
        expect(appBridgeMocks.lastCapabilities).toBeDefined();
        expect(appBridgeMocks.lastCapabilities).not.toHaveProperty(
          'downloadFile',
        );
        expect(appBridgeMocks.lastCapabilities).not.toHaveProperty([
          'experimental',
          'qwen-code/generated-ui-copy',
        ]);
        expect(appBridgeMocks.last?.ondownloadfile).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('starts a sanitized download and refuses links or binary content', async () => {
      const clicked: HTMLAnchorElement[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
        function (this: HTMLAnchorElement) {
          clicked.push(this);
        },
      );
      URL.createObjectURL ??= () => 'blob:download';
      URL.revokeObjectURL ??= () => {};
      const container = host();
      await act(async () => {
        await expect(
          download({ uri: 'file:///../plans.exe' }),
        ).resolves.toEqual({});
      });
      expect(clicked.map((link) => link.download)).toEqual(['plans.exe.csv']);
      expect(outcome(container)).toEqual({
        status: 'downloaded',
        count: '1',
        text: 'mcpApp.generatedUi.effect.downloaded',
      });
      await act(async () => {
        await expect(download({ blob: 'AAAA' })).resolves.toEqual({
          isError: true,
        });
        await expect(
          appBridgeMocks.last!.ondownloadfile!({
            contents: [{ type: 'resource_link', uri: 'https://example.com' }],
          }),
        ).resolves.toEqual({ isError: true });
      });
      expect(clicked).toHaveLength(1);
      expect(outcome(container)).toMatchObject({
        status: 'refused',
        count: '3',
      });
    });
  });

  it('retains manually installed legacy Generated UI behavior', () => {
    const { container } = renderApp(
      appDisplay({
        serverName: 'generated-ui',
        resourceUri: 'ui://generated-ui/view-v1.html',
      }),
    );
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(appBridgeMocks.constructed).toBe(1);
  });
});
