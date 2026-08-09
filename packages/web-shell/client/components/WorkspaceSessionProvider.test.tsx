// @vitest-environment jsdom

import { act, type ReactNode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
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

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
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
  useConnection: () => mocks.connection,
  useWorkspace: () => mocks.workspace,
  useWorkspaceActions: () => ({ addWorkspace: mocks.addWorkspace }),
}));

vi.mock('../App', () => ({
  App: (props: Record<string, unknown>) => {
    mocks.appProps.push(props);
    return (
      <output data-testid="app-workspace">
        {String(
          props['lockedWorkspaceCwd'] ??
            props['initialSelectedWorkspaceCwd'] ??
            '',
        )}
      </output>
    );
  },
}));

import { WorkspaceSessionProvider } from './WorkspaceSessionProvider';

describe('WorkspaceSessionProvider transactional targets', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

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

  const renderTarget = async (
    sessionId: string,
    workspaceCwd?: string,
    onSessionIdChange?: (
      sessionId: string | undefined,
      workspaceId?: string,
      workspaceCwd?: string,
    ) => void,
    clientId?: string,
  ) => {
    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId={sessionId}
          workspaceCwd={workspaceCwd}
          clientId={clientId}
          webShellProps={onSessionIdChange ? { onSessionIdChange } : {}}
        />,
      );
    });
  };

  it('keeps the committed App mounted until the desired workspace commits', async () => {
    await renderTarget('session-a', '/work/a');
    expect(container.textContent).toBe('/work/a');
    expect(mocks.providerMounts).toBe(1);

    await renderTarget('session-b', '/work/b');

    expect(mocks.providerProps.at(-1)).toMatchObject({
      sessionId: 'session-b',
      workspaceCwd: '/work/b',
    });
    expect(mocks.appProps.at(-1)).toMatchObject({
      desiredTargetPending: true,
    });
    expect(container.textContent).toBe('/work/a');
    expect(mocks.providerMounts).toBe(1);
    expect(mocks.providerUnmounts).toBe(0);

    mocks.connection = {
      status: 'connected',
      sessionId: 'session-b',
      workspaceCwd: '/work/b',
    };
    const firstCommittedRender = mocks.appProps.length;
    await renderTarget('session-b', '/work/b');

    expect(container.textContent).toBe('/work/b');
    expect(mocks.appProps[firstCommittedRender]).toMatchObject({
      initialSelectedWorkspaceCwd: '/work/b',
      desiredTargetPending: false,
    });
    expect(mocks.providerMounts).toBe(1);
  });

  it('forwards a session with no explicit workspace before capabilities load', async () => {
    mocks.workspace = {
      status: 'connecting',
      capabilities: undefined,
      refreshCapabilities: vi.fn(async () => undefined),
    };

    await renderTarget('session-a');

    expect(mocks.providerProps.at(-1)).toMatchObject({
      sessionId: 'session-a',
      workspaceCwd: undefined,
    });
  });

  it('stabilizes the implicit primary workspace for older capabilities', async () => {
    mocks.workspace = {
      status: 'connected',
      capabilities: { workspaceCwd: '/work/a' },
      refreshCapabilities: vi.fn(async () => undefined),
    };

    await renderTarget('session-a');

    expect(container.textContent).toBe('/work/a');
    expect(mocks.providerMounts).toBe(1);
    expect(mocks.providerUnmounts).toBe(0);
  });

  it('keeps the committed App gated while workspace resolution is pending', async () => {
    await renderTarget('session-a', '/work/a', undefined, 'client-a');
    mocks.workspace = {
      status: 'connected',
      capabilities: undefined,
      refreshCapabilities: vi.fn(async () => undefined),
    };

    await renderTarget('session-b', '/work/b', undefined, 'client-b');

    expect(container.textContent).toBe('/work/a');
    expect(mocks.providerProps.at(-1)).toMatchObject({
      sessionId: 'session-a',
      workspaceCwd: '/work/a',
      clientId: 'client-a',
    });
    expect(mocks.appProps.at(-1)).toMatchObject({
      desiredTargetPending: true,
    });
    expect(mocks.providerMounts).toBe(1);
    expect(mocks.providerUnmounts).toBe(0);
  });

  it('keeps a same-session cross-workspace target gated until resolution', async () => {
    await renderTarget('session-a', '/work/a', undefined, 'client-a');
    mocks.workspace = {
      status: 'connected',
      capabilities: undefined,
      refreshCapabilities: vi.fn(async () => undefined),
    };

    await renderTarget('session-a', '/work/b', undefined, 'client-a');

    expect(mocks.providerProps.at(-1)).toMatchObject({
      sessionId: 'session-a',
      workspaceCwd: '/work/a',
      clientId: 'client-a',
    });
    expect(mocks.appProps.at(-1)).toMatchObject({
      desiredTargetPending: true,
    });
  });

  it('keeps the committed App and rolls the host back for a missing workspace', async () => {
    const onSessionIdChange = vi.fn();
    await renderTarget('session-a', '/work/a');
    mocks.workspace = {
      ...mocks.workspace,
      capabilities: {
        workspaceCwd: '/work/a',
        workspaces: [{ id: 'a', cwd: '/work/a', primary: true, trusted: true }],
      },
    };

    await renderTarget('session-b', '/work/missing', onSessionIdChange);

    expect(container.textContent).toBe('/work/a');
    expect(mocks.providerProps.at(-1)).toMatchObject({
      sessionId: 'session-a',
      workspaceCwd: '/work/a',
    });
    expect(mocks.providerMounts).toBe(1);
    expect(mocks.providerUnmounts).toBe(0);
    expect(mocks.appProps.at(-1)).toMatchObject({
      desiredTargetPending: false,
    });
    expect(onSessionIdChange).toHaveBeenCalledWith(
      'session-a',
      undefined,
      '/work/a',
    );

    await renderTarget('session-b', '/work/missing', onSessionIdChange);
    await renderTarget('session-b', '/work/missing', onSessionIdChange);
    expect(onSessionIdChange).toHaveBeenCalledTimes(1);
  });

  it('ignores a failed transition from an older requested client', async () => {
    const onSessionIdChange = vi.fn();
    await renderTarget('session-a', '/work/a', onSessionIdChange, 'client-a');
    onSessionIdChange.mockClear();
    mocks.connection = {
      status: 'connected',
      sessionId: 'session-a',
      workspaceCwd: '/work/a',
      clientId: 'client-a',
      sessionTransition: {
        phase: 'failed',
        operation: 'load',
        origin: 'controlled',
        targetSessionId: 'session-b',
        targetWorkspaceCwd: '/work/b',
        targetClientId: 'client-b',
      },
    };

    await renderTarget('session-b', '/work/b', onSessionIdChange, 'client-c');

    expect(onSessionIdChange).not.toHaveBeenCalled();
  });

  it('ungates the committed App after the desired transition fails', async () => {
    const onSessionIdChange = vi.fn();
    await renderTarget('session-a', '/work/a', onSessionIdChange, 'client-a');
    onSessionIdChange.mockClear();

    await renderTarget('session-b', '/work/b', onSessionIdChange, 'client-b');
    expect(mocks.appProps.at(-1)).toMatchObject({
      desiredTargetPending: true,
    });

    mocks.connection = {
      status: 'connected',
      sessionId: 'session-a',
      workspaceCwd: '/work/a',
      clientId: 'client-a',
      sessionTransition: {
        phase: 'failed',
        operation: 'load',
        origin: 'controlled',
        targetSessionId: 'session-b',
        targetWorkspaceCwd: '/work/b',
        targetClientId: 'client-b',
      },
    };
    await renderTarget('session-b', '/work/b', onSessionIdChange, 'client-b');

    expect(mocks.appProps.at(-1)).toMatchObject({
      desiredTargetPending: false,
    });
    expect(onSessionIdChange).toHaveBeenCalledWith(
      'session-a',
      undefined,
      '/work/a',
    );

    await renderTarget('session-b', '/work/b', onSessionIdChange, 'client-b');
    await renderTarget('session-b', '/work/b', onSessionIdChange, 'client-b');
    expect(onSessionIdChange).toHaveBeenCalledTimes(1);
  });
});
