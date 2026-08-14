// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { McpAppHostContext } from '../../mcpAppHostContext';
import { ThemeProvider, WebShellThemeId } from '../../themeContext';
import type { McpAppDisplay } from './McpApp';

const appBridgeMocks = vi.hoisted(() => ({
  constructed: 0,
  last: null as {
    onsandboxready?: () => void;
    oninitialized?: () => void;
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
  buildAllowAttribute: () => '',
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
  appBridgeMocks.teardownResource.mockClear();
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
): { container: HTMLElement; rerender: (node: ReactNode) => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const wrap = (node: ReactNode) => (
    <McpAppHostContext.Provider value="http://127.0.0.1:4170">
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

  it('advertises only clipboardWrite as a host-granted sandbox permission', async () => {
    renderApp(
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

    expect(appBridgeMocks.lastCapabilities).toEqual({
      sandbox: { permissions: { clipboardWrite: {} } },
    });
    expect(appBridgeMocks.last?.onsandboxready).toEqual(expect.any(Function));

    await act(async () => {
      appBridgeMocks.last?.onsandboxready?.();
      await Promise.resolve();
    });

    expect(appBridgeMocks.sendSandboxResourceReady).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: { clipboardWrite: {}, camera: {} },
      }),
    );
  });
});
