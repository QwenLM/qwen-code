// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Drive a render throw from inside DaemonWorkspaceProvider so we can prove the
// top-level boundary sits *outside* the daemon providers (a boundary nested
// under them couldn't catch their own throw).
let workspaceShouldThrow = false;
const sessionProviderProps: Array<Record<string, unknown>> = [];
const appProps: Array<Record<string, unknown>> = [];
let workspaceCapabilities: {
  workspaceCwd?: string;
  workspaces?: Array<{
    id: string;
    cwd: string;
    primary: boolean;
    trusted?: boolean;
  }>;
} = {
  workspaceCwd: '/workspace',
  workspaces: [{ id: 'primary', cwd: '/workspace', primary: true }],
};
const addWorkspace = vi.fn();
const refreshCapabilities = vi.fn();
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
    useWorkspace: () => ({
      capabilities: workspaceCapabilities,
      refreshCapabilities,
    }),
    useWorkspaceActions: () => ({ addWorkspace }),
  };
});
vi.mock('./App', async () => {
  const React = await import('react');
  return {
    App: (props: Record<string, unknown>) => {
      appProps.push(props);
      return React.createElement('div', { 'data-testid': 'app-ok' }, 'app');
    },
  };
});
vi.mock('./components/WebShellTranscript', async () => {
  const React = await import('react');
  return {
    WebShellTranscript: () =>
      React.createElement('div', { 'data-testid': 'transcript-ok' }),
  };
});

// A variable specifier loads the TSX library entry without requiring
// allowImportingTsExtensions in this test configuration.
const indexEntry = './index.tsx';
const { WebShellTranscript, WebShellWithProviders } = await import(indexEntry);

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
  sessionProviderProps.length = 0;
  appProps.length = 0;
  workspaceCapabilities = {
    workspaceCwd: '/workspace',
    workspaces: [{ id: 'primary', cwd: '/workspace', primary: true }],
  };
  addWorkspace.mockReset();
  refreshCapabilities.mockReset();
  vi.restoreAllMocks();
});

describe('WebShellWithProviders top-level boundary', () => {
  it('exports the readonly transcript entry', () => {
    const container = render(<WebShellTranscript blocks={[]} />);
    expect(
      container.querySelector('[data-testid="transcript-ok"]'),
    ).not.toBeNull();
  });

  it('renders normally when the providers are healthy', () => {
    const container = render(<WebShellWithProviders />);
    expect(container.querySelector('[data-testid="app-ok"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('starts on an empty session by default', () => {
    render(<WebShellWithProviders />);
    expect(sessionProviderProps[0]).toMatchObject({
      sessionId: undefined,
    });
    expect(sessionProviderProps[0]).not.toHaveProperty('deferSessionCreation');
  });

  it('passes controlled sessionId to the daemon session provider', () => {
    render(<WebShellWithProviders sessionId="session-2" />);
    expect(sessionProviderProps[0]).toMatchObject({
      sessionId: 'session-2',
    });
  });

  it('passes explicit undefined sessionId to the daemon session provider', () => {
    render(<WebShellWithProviders sessionId={undefined} />);
    expect(sessionProviderProps[0]).toHaveProperty('sessionId', undefined);
  });

  it('enables prompt SSE restarts only when explicitly requested', () => {
    render(<WebShellWithProviders restartSseOnPrompt />);
    expect(sessionProviderProps[0]).toMatchObject({
      restartEventStreamOnPrompt: true,
    });
    expect(appProps[0]).toMatchObject({ restartSseOnPrompt: true });
  });

  it('selects a registered workspace by path without locking the UI', () => {
    workspaceCapabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true },
        { id: 'secondary', cwd: '/work/secondary', primary: false },
      ],
    };

    render(
      <WebShellWithProviders
        workspaceId="primary"
        workspaceCwd="/work/secondary"
      />,
    );

    expect(addWorkspace).not.toHaveBeenCalled();
    expect(sessionProviderProps[0]).toMatchObject({
      workspaceCwd: '/work/secondary',
    });
    expect(appProps[0]?.lockedWorkspaceCwd).toBeUndefined();
  });

  it('initializes an unlocked workspace selector from workspace id', () => {
    workspaceCapabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true },
        { id: 'secondary', cwd: '/work/secondary', primary: false },
      ],
    };

    render(<WebShellWithProviders workspaceId="secondary" />);

    expect(sessionProviderProps[0]).toMatchObject({
      workspaceCwd: '/work/secondary',
    });
    expect(appProps[0]).toMatchObject({
      initialSelectedWorkspaceCwd: '/work/secondary',
    });
    expect(appProps[0]?.lockedWorkspaceCwd).toBeUndefined();
  });

  it('does not register an unknown unlocked workspace path', () => {
    const container = render(
      <WebShellWithProviders workspaceCwd="/work/missing" />,
    );

    expect(addWorkspace).not.toHaveBeenCalled();
    expect(sessionProviderProps).toHaveLength(0);
    expect(container.textContent).toContain('Workspace not found');
  });

  it('locks directly to an already registered workspace path', () => {
    workspaceCapabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true },
        { id: 'secondary', cwd: '/work/secondary', primary: false },
      ],
    };

    render(<WebShellWithProviders lockWorkspaceCwd="/work/secondary" />);

    expect(addWorkspace).not.toHaveBeenCalled();
    expect(sessionProviderProps[0]).toMatchObject({
      workspaceCwd: '/work/secondary',
    });
    expect(appProps[0]).toMatchObject({
      lockedWorkspaceCwd: '/work/secondary',
    });
  });

  it('locks to the primary workspace without registering it again', () => {
    render(<WebShellWithProviders lockWorkspaceCwd="/workspace" />);

    expect(addWorkspace).not.toHaveBeenCalled();
    expect(sessionProviderProps[0]).toMatchObject({
      workspaceCwd: '/workspace',
    });
    expect(appProps[0]).toMatchObject({
      lockedWorkspaceCwd: '/workspace',
    });
  });

  it('recognizes the primary path when single-workspace capabilities omit workspaces', () => {
    workspaceCapabilities = { workspaceCwd: '/workspace' };

    render(<WebShellWithProviders lockWorkspaceCwd="/workspace" />);

    expect(addWorkspace).not.toHaveBeenCalled();
    expect(sessionProviderProps[0]).toMatchObject({
      workspaceCwd: '/workspace',
    });
    expect(appProps[0]).toMatchObject({
      lockedWorkspaceCwd: '/workspace',
      lockedWorkspaceCapability: expect.objectContaining({
        cwd: '/workspace',
        primary: true,
      }),
    });
  });

  it('selects the primary path without locking when workspaces are omitted', () => {
    workspaceCapabilities = { workspaceCwd: '/workspace' };

    render(<WebShellWithProviders workspaceCwd="/workspace" />);

    expect(addWorkspace).not.toHaveBeenCalled();
    expect(sessionProviderProps[0]).toMatchObject({
      workspaceCwd: '/workspace',
    });
    expect(appProps[0]?.lockedWorkspaceCwd).toBeUndefined();
  });

  it('registers a missing workspace persistently before rendering', async () => {
    addWorkspace.mockResolvedValue({
      id: 'secondary',
      cwd: '/canonical/secondary',
      primary: false,
      trusted: true,
      persisted: true,
    });

    const container = render(
      <WebShellWithProviders lockWorkspaceCwd="/work/../work/secondary" />,
    );
    expect(container.querySelector('[role="status"]')).not.toBeNull();

    await act(async () => {
      await addWorkspace.mock.results[0]?.value;
    });

    expect(addWorkspace).toHaveBeenCalledTimes(1);
    expect(addWorkspace).toHaveBeenCalledWith('/work/../work/secondary', {
      persist: true,
    });
    expect(sessionProviderProps.at(-1)).toMatchObject({
      workspaceCwd: '/canonical/secondary',
    });
    expect(appProps.at(-1)).toMatchObject({
      lockedWorkspaceCwd: '/canonical/secondary',
    });
  });

  it('keeps the registered workspace available when capabilities refresh fails', async () => {
    addWorkspace.mockResolvedValue({
      id: 'secondary',
      cwd: '/work/secondary',
      primary: false,
      trusted: true,
      persisted: true,
    });
    refreshCapabilities.mockRejectedValue(new Error('offline'));

    render(<WebShellWithProviders lockWorkspaceCwd="/work/secondary" />);
    await act(async () => {
      await addWorkspace.mock.results[0]?.value;
      await Promise.resolve();
    });

    expect(appProps.at(-1)).toMatchObject({
      lockedWorkspaceCwd: '/work/secondary',
      lockedWorkspaceCapability: expect.objectContaining({
        id: 'secondary',
        cwd: '/work/secondary',
      }),
    });
  });

  it('ignores an older registration response after the locked path changes', async () => {
    let resolveA!: (workspace: {
      id: string;
      cwd: string;
      primary: boolean;
      persisted: true;
    }) => void;
    let resolveB!: typeof resolveA;
    addWorkspace.mockImplementation((cwd: string) => {
      return new Promise((resolve) => {
        if (cwd === '/a') resolveA = resolve;
        else resolveB = resolve;
      });
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => root.render(<WebShellWithProviders lockWorkspaceCwd="/a" />));
    act(() => root.render(<WebShellWithProviders lockWorkspaceCwd="/b" />));

    await act(async () => {
      resolveA({ id: 'a', cwd: '/a', primary: false, persisted: true });
      await Promise.resolve();
    });
    expect(appProps).toHaveLength(0);

    await act(async () => {
      resolveB({ id: 'b', cwd: '/b', primary: false, persisted: true });
      await Promise.resolve();
    });
    expect(sessionProviderProps.at(-1)).toMatchObject({ workspaceCwd: '/b' });
    expect(appProps.at(-1)).toMatchObject({ lockedWorkspaceCwd: '/b' });
    expect(refreshCapabilities).toHaveBeenCalledTimes(1);
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
