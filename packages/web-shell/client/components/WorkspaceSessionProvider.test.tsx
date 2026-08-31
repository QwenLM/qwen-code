// @vitest-environment jsdom

import { act, type ReactNode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connection: {
    status: 'connected',
    sessionId: 'session-a',
    workspaceCwd: '/work/a',
  } as Record<string, unknown>,
  workspace: {
    status: 'connected',
    capabilities: {
      workspaceCwd: '/work/a',
      features: ['client_identity'],
      workspaces: [
        { id: 'a', cwd: '/work/a', primary: true, trusted: true },
        { id: 'b', cwd: '/work/b', primary: false, trusted: true },
      ],
    },
    refreshCapabilities: vi.fn(async () => undefined),
  } as Record<string, unknown>,
  addWorkspace: vi.fn(),
  providerMounts: 0,
  providerUnmounts: 0,
  providerProps: [] as Array<Record<string, unknown>>,
  appProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DaemonSessionProvider: ({
    children,
    ...props
  }: Record<string, unknown> & { children: ReactNode }) => {
    mocks.providerProps.push(props);
    useEffect(() => {
      mocks.providerMounts += 1;
      return () => {
        mocks.providerUnmounts += 1;
      };
    }, []);
    return children;
  },
  useWorkspace: () => mocks.workspace,
  useConnection: () => mocks.connection,
  useWorkspaceActions: () => ({ addWorkspace: mocks.addWorkspace }),
}));

vi.mock('../App', () => ({
  App: (props: Record<string, unknown>) => {
    mocks.appProps.push(props);
    return (
      <output>{String(props['initialSelectedWorkspaceCwd'] ?? '')}</output>
    );
  },
}));

import { WorkspaceSessionProvider } from './WorkspaceSessionProvider';

describe('WorkspaceSessionProvider targets', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.connection = {
      status: 'connected',
      sessionId: 'session-a',
      workspaceCwd: '/work/a',
    };
    mocks.workspace = {
      status: 'connected',
      capabilities: {
        workspaceCwd: '/work/a',
        features: ['client_identity'],
        workspaces: [
          { id: 'a', cwd: '/work/a', primary: true, trusted: true },
          { id: 'b', cwd: '/work/b', primary: false, trusted: true },
        ],
      },
      refreshCapabilities: vi.fn(async () => undefined),
    };
    mocks.addWorkspace.mockReset();
    mocks.providerMounts = 0;
    mocks.providerUnmounts = 0;
    mocks.providerProps = [];
    mocks.appProps = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderTarget(
    sessionId: string,
    workspaceCwd: string,
    onSessionIdChange = vi.fn(),
  ) {
    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId={sessionId}
          workspaceCwd={workspaceCwd}
          webShellProps={{ onSessionIdChange }}
        />,
      );
    });
    return onSessionIdChange;
  }

  it('updates the provider immediately without remounting for a different target', async () => {
    const onSessionIdChange = await renderTarget('session-a', '/work/a');
    expect(mocks.providerMounts).toBe(1);
    expect(container.textContent).toBe('/work/a');

    await renderTarget('session-b', '/work/b', onSessionIdChange);
    expect(mocks.providerMounts).toBe(1);
    expect(mocks.providerUnmounts).toBe(0);
    expect(mocks.providerProps.at(-1)).toMatchObject({
      sessionId: 'session-b',
      workspaceCwd: '/work/b',
    });
    expect(container.textContent).toBe('/work/b');
    expect(mocks.appProps.at(-1)).toMatchObject({
      initialSelectedWorkspaceCwd: '/work/b',
    });
  });

  it('keeps one provider during rapid prop changes', async () => {
    const onSessionIdChange = await renderTarget('session-a', '/work/a');

    await renderTarget('session-b', '/work/b', onSessionIdChange);
    await renderTarget('session-a', '/work/a', onSessionIdChange);
    expect(mocks.providerProps.at(-1)).toMatchObject({
      sessionId: 'session-a',
      workspaceCwd: '/work/a',
    });
    await renderTarget('session-b', '/work/b', onSessionIdChange);
    expect(mocks.providerMounts).toBe(1);
    expect(mocks.providerUnmounts).toBe(0);
  });

  it('passes session changes from the app to the host', async () => {
    const onSessionIdChange = await renderTarget('session-a', '/work/a');
    expect(mocks.providerProps.at(-1)).not.toHaveProperty(
      'transactionalSessionSwitching',
    );
    const appReport = mocks.appProps.at(-1)?.['onSessionIdChange'] as (
      sessionId: string,
      workspaceId: string,
      workspaceCwd: string,
    ) => void;
    appReport('session-b', 'b', '/work/b');
    expect(onSessionIdChange).toHaveBeenCalledWith('session-b', 'b', '/work/b');
    expect(onSessionIdChange).toHaveBeenCalledOnce();
  });

  it('does not keep the previous app visible while a target is unresolved', async () => {
    const onSessionIdChange = await renderTarget('session-a', '/work/a');
    mocks.workspace = {
      ...mocks.workspace,
      capabilities: undefined,
    };

    await renderTarget('session-b', '/work/missing', onSessionIdChange);
    expect(mocks.providerUnmounts).toBe(1);
    expect(container.textContent).not.toContain('/work/a');
  });

  it('shows the target workspace error without restoring the previous app', async () => {
    const onSessionIdChange = await renderTarget('session-a', '/work/a');
    onSessionIdChange.mockClear();
    mocks.workspace = {
      ...mocks.workspace,
      status: 'error',
      capabilities: {
        workspaceCwd: '/work/a',
        features: ['client_identity'],
        workspaces: [{ id: 'a', cwd: '/work/a', primary: true, trusted: true }],
      },
    };

    await renderTarget('session-b', '/work/missing', onSessionIdChange);

    expect(container.textContent).not.toContain('/work/a');
    expect(container.textContent).toContain('Failed to load workspace');
    expect(onSessionIdChange).not.toHaveBeenCalled();

    await renderTarget('session-b', '/work/missing', onSessionIdChange);
    expect(onSessionIdChange).not.toHaveBeenCalled();
  });

  it('does not preserve a target that never connected', async () => {
    mocks.connection = { status: 'error' };
    const onSessionIdChange = await renderTarget('session-a', '/work/a');
    mocks.workspace = {
      ...mocks.workspace,
      capabilities: {
        workspaceCwd: '/work/a',
        features: ['client_identity'],
        workspaces: [{ id: 'a', cwd: '/work/a', primary: true, trusted: true }],
      },
    };

    await renderTarget('session-b', '/work/missing', onSessionIdChange);

    expect(mocks.providerUnmounts).toBe(1);
    expect(container.textContent).not.toContain('/work/a');
  });

  it('keeps one provider for legacy daemons', async () => {
    mocks.workspace = {
      ...mocks.workspace,
      capabilities: {
        workspaceCwd: '/work/a',
        features: [],
        workspaces: [
          { id: 'a', cwd: '/work/a', primary: true, trusted: true },
          { id: 'b', cwd: '/work/b', primary: false, trusted: true },
        ],
      },
    };
    const onSessionIdChange = await renderTarget('session-a', '/work/a');
    await renderTarget('session-b', '/work/b', onSessionIdChange);
    expect(mocks.providerMounts).toBe(1);
    expect(mocks.providerUnmounts).toBe(0);
    expect(mocks.appProps.at(-1)).toMatchObject({
      initialSelectedWorkspaceCwd: '/work/b',
    });
  });

  it('does not remount when an unknown daemon resolves as modern', async () => {
    mocks.workspace = { ...mocks.workspace, capabilities: undefined };
    await act(async () => {
      root.render(
        <WorkspaceSessionProvider sessionId="session-a" webShellProps={{}} />,
      );
    });
    expect(mocks.providerMounts).toBe(1);

    mocks.workspace = {
      ...mocks.workspace,
      capabilities: {
        workspaceCwd: '/work/a',
        features: ['client_identity'],
        workspaces: [{ id: 'a', cwd: '/work/a', primary: true, trusted: true }],
      },
    };
    await act(async () => {
      root.render(
        <WorkspaceSessionProvider sessionId="session-a" webShellProps={{}} />,
      );
    });

    expect(mocks.providerMounts).toBe(1);
    expect(mocks.providerUnmounts).toBe(0);
  });
});
