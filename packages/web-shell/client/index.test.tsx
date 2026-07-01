// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Drive a render throw from inside DaemonWorkspaceProvider so we can prove the
// top-level boundary sits *outside* the daemon providers (a boundary nested
// under them couldn't catch their own throw).
let workspaceShouldThrow = false;
const sessionProviderProps: Array<Record<string, unknown>> = [];
let connectionState: { sessionId?: string } = {};
const actionMocks = {
  loadSession: vi.fn(() => Promise.resolve()),
  clearSession: vi.fn(() => Promise.resolve()),
};
vi.mock('@qwen-code/webui/daemon-react-sdk', async () => {
  const React = await import('react');
  return {
    DaemonWorkspaceProvider: ({ children }: { children: React.ReactNode }) => {
      if (workspaceShouldThrow) throw new Error('provider boom');
      return React.createElement(React.Fragment, null, children);
    },
    DaemonSessionProvider: ({
      children,
      ...props
    }: {
      children: React.ReactNode;
    }) => {
      sessionProviderProps.push(props);
      return React.createElement(React.Fragment, null, children);
    },
    useConnection: () => connectionState,
    useActions: () => actionMocks,
  };
});
vi.mock('./App', async () => {
  const React = await import('react');
  return {
    App: () => React.createElement('div', { 'data-testid': 'app-ok' }, 'app'),
  };
});

// Bare './index' resolves to the sibling index.ts barrel, which doesn't export
// WebShellWithProviders (see the dual-entry note in the PR). A variable
// specifier loads index.tsx at runtime without tripping tsc's ts-extension rule.
const indexEntry = './index.tsx';
const { WebShellWithProviders } = await import(indexEntry);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function render(node: React.ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  workspaceShouldThrow = false;
  connectionState = {};
  sessionProviderProps.length = 0;
  actionMocks.loadSession.mockClear();
  actionMocks.clearSession.mockClear();
  vi.restoreAllMocks();
});

describe('WebShellWithProviders top-level boundary', () => {
  it('renders normally when the providers are healthy', () => {
    const container = render(<WebShellWithProviders />);
    expect(container.querySelector('[data-testid="app-ok"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('defers session creation until first prompt when no initial session is provided', () => {
    render(<WebShellWithProviders />);
    expect(sessionProviderProps[0]).toMatchObject({
      initialSessionId: undefined,
    });
    expect(sessionProviderProps[0]).not.toHaveProperty('deferSessionCreation');
  });

  it('loads the requested session immediately when initialSessionId is provided', () => {
    render(<WebShellWithProviders initialSessionId="session-1" />);
    expect(sessionProviderProps[0]).toMatchObject({
      initialSessionId: 'session-1',
    });
    expect(sessionProviderProps[0]).not.toHaveProperty('deferSessionCreation');
  });

  it('loads the controlled active session when it differs from the current one', async () => {
    connectionState = { sessionId: 'session-1' };
    render(<WebShellWithProviders activeSessionId="session-2" />);
    await act(async () => {});

    expect(actionMocks.loadSession).toHaveBeenCalledWith('session-2', {
      deferTranscriptReset: true,
    });
    expect(actionMocks.clearSession).not.toHaveBeenCalled();
  });

  it('does not load when the controlled active session matches the current one', async () => {
    connectionState = { sessionId: 'session-1' };
    render(<WebShellWithProviders activeSessionId="session-1" />);
    await act(async () => {});

    expect(actionMocks.loadSession).not.toHaveBeenCalled();
    expect(actionMocks.clearSession).not.toHaveBeenCalled();
  });

  it('clears the current session when controlled activeSessionId is explicitly undefined', async () => {
    connectionState = { sessionId: 'session-1' };
    render(<WebShellWithProviders activeSessionId={undefined} />);
    await act(async () => {});

    expect(actionMocks.clearSession).toHaveBeenCalledOnce();
    expect(actionMocks.loadSession).not.toHaveBeenCalled();
  });

  it('does not clear a deferred session created after an empty controlled render', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    connectionState = {};
    act(() => {
      root.render(<WebShellWithProviders activeSessionId={undefined} />);
    });
    await act(async () => {});

    connectionState = { sessionId: 'created-session' };
    act(() => {
      root.render(<WebShellWithProviders activeSessionId={undefined} />);
    });
    await act(async () => {});

    expect(actionMocks.clearSession).not.toHaveBeenCalled();
    expect(actionMocks.loadSession).not.toHaveBeenCalled();
  });

  it('catches a daemon-provider render crash instead of white-screening', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    workspaceShouldThrow = true;
    const container = render(<WebShellWithProviders />);
    // The boundary is outside the providers, so the provider throw degrades to
    // the recoverable fallback rather than unmounting the whole root.
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Something went wrong',
    );
    expect(container.querySelector('[data-testid="app-ok"]')).toBeNull();
  });
});
