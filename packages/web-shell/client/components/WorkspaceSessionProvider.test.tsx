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

describe('WorkspaceSessionProvider transactional targets', () => {
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

  it('keeps the modern provider mounted until the desired target commits', async () => {
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
    expect(mocks.appProps.at(-1)).toMatchObject({
      desiredSessionTargetPending: true,
      initialSelectedWorkspaceCwd: '/work/a',
    });

    await act(async () => {
      const commit = mocks.providerProps.at(-1)?.[
        'onSessionTransitionCommit'
      ] as (target: { sessionId: string; workspaceCwd: string }) => void;
      commit({ sessionId: 'session-b', workspaceCwd: '/work/b' });
    });
    expect(container.textContent).toBe('/work/b');
    expect(mocks.providerProps.at(-1)).toMatchObject({
      sessionId: 'session-b',
      workspaceCwd: '/work/b',
    });
    expect(mocks.appProps.at(-1)).toMatchObject({
      desiredSessionTargetPending: false,
    });
    const appReport = mocks.appProps.at(-1)?.['onSessionIdChange'] as (
      sessionId: string,
      workspaceId: string,
      workspaceCwd: string,
    ) => void;
    appReport('session-b', 'b', '/work/b');
    expect(onSessionIdChange).toHaveBeenCalledTimes(1);
    expect(onSessionIdChange).toHaveBeenCalledWith('session-b', 'b', '/work/b');
  });

  it('keeps one modern provider and updates the write gate during rapid props', async () => {
    const onSessionIdChange = await renderTarget('session-a', '/work/a');

    await renderTarget('session-b', '/work/b', onSessionIdChange);
    expect(mocks.appProps.at(-1)).toMatchObject({
      desiredSessionTargetPending: true,
    });

    await renderTarget('session-a', '/work/a', onSessionIdChange);
    expect(mocks.providerMounts).toBe(1);
    expect(mocks.providerUnmounts).toBe(0);
    expect(mocks.providerProps.at(-1)).toMatchObject({
      sessionId: 'session-a',
      workspaceCwd: '/work/a',
    });
    expect(mocks.appProps.at(-1)).toMatchObject({
      desiredSessionTargetPending: false,
      initialSelectedWorkspaceCwd: '/work/a',
    });

    await renderTarget('session-b', '/work/b', onSessionIdChange);
    expect(mocks.providerMounts).toBe(1);
    expect(mocks.providerUnmounts).toBe(0);
    expect(mocks.appProps.at(-1)).toMatchObject({
      desiredSessionTargetPending: true,
    });
  });

  it('does not feed stale host props back after an action-driven commit', async () => {
    const onSessionIdChange = await renderTarget('session-a', '/work/a');

    await act(async () => {
      const commit = mocks.providerProps.at(-1)?.[
        'onSessionTransitionCommit'
      ] as (target: { sessionId: string; workspaceCwd: string }) => void;
      commit({ sessionId: 'session-b', workspaceCwd: '/work/b' });
    });

    expect(mocks.providerProps.at(-1)).toMatchObject({
      sessionId: 'session-b',
      workspaceCwd: '/work/b',
    });
    expect(onSessionIdChange).not.toHaveBeenCalled();
    const appReport = mocks.appProps.at(-1)?.['onSessionIdChange'] as (
      sessionId: string,
      workspaceId: string,
      workspaceCwd: string,
    ) => void;
    appReport('session-b', 'b', '/work/b');
    expect(onSessionIdChange).toHaveBeenCalledWith('session-b', 'b', '/work/b');
  });

  it('keeps the committed app visible while a workspace target is unresolved', async () => {
    const onSessionIdChange = await renderTarget('session-a', '/work/a');
    mocks.workspace = {
      ...mocks.workspace,
      capabilities: undefined,
    };

    await renderTarget('session-b', '/work/missing', onSessionIdChange);
    expect(mocks.providerMounts).toBe(1);
    expect(container.textContent).toBe('/work/a');
    expect(mocks.providerProps.at(-1)).toMatchObject({
      sessionId: 'session-a',
      workspaceCwd: '/work/a',
    });
    expect(mocks.appProps.at(-1)).toMatchObject({
      desiredSessionTargetPending: true,
    });
  });

  it('unblocks the committed session after workspace resolution fails', async () => {
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

    expect(mocks.providerMounts).toBe(1);
    expect(container.textContent).toBe('/work/a');
    expect(mocks.appProps.at(-1)).toMatchObject({
      desiredSessionTargetPending: false,
    });
    expect(onSessionIdChange).toHaveBeenCalledTimes(1);
    expect(onSessionIdChange).toHaveBeenCalledWith('session-a', 'a', '/work/a');

    await renderTarget('session-b', '/work/missing', onSessionIdChange);
    expect(onSessionIdChange).toHaveBeenCalledTimes(1);
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

  it('rolls a still-current controlled target back after restore failure', async () => {
    const onSessionIdChange = await renderTarget('session-a', '/work/a');
    onSessionIdChange.mockClear();
    await renderTarget('session-b', '/work/b', onSessionIdChange);
    mocks.connection = {
      status: 'connected',
      sessionId: 'session-a',
      workspaceCwd: '/work/a',
      sessionTransition: {
        phase: 'failed',
        operation: 'load',
        origin: 'controlled',
        targetSessionId: 'session-b',
        targetWorkspaceCwd: '/work/b',
      },
    };
    await renderTarget('session-b', '/work/b', onSessionIdChange);
    expect(onSessionIdChange).toHaveBeenCalledTimes(1);
    expect(onSessionIdChange).toHaveBeenCalledWith('session-a', 'a', '/work/a');
    expect(mocks.appProps.at(-1)).toMatchObject({
      desiredSessionTargetPending: false,
    });
  });

  it('rolls back a primary-workspace target when workspace props are omitted', async () => {
    const onSessionIdChange = vi.fn();
    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="session-a"
          webShellProps={{ onSessionIdChange }}
        />,
      );
    });
    onSessionIdChange.mockClear();

    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="session-b"
          webShellProps={{ onSessionIdChange }}
        />,
      );
    });
    mocks.connection = {
      status: 'connected',
      sessionId: 'session-a',
      workspaceCwd: '/work/a',
      sessionTransition: {
        phase: 'failed',
        operation: 'load',
        origin: 'controlled',
        targetSessionId: 'session-b',
        targetWorkspaceCwd: '/work/a',
      },
    };
    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="session-b"
          webShellProps={{ onSessionIdChange }}
        />,
      );
    });

    expect(onSessionIdChange).toHaveBeenCalledWith('session-a', 'a', '/work/a');
  });

  it('preserves keyed remounts for legacy daemons', async () => {
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
    expect(mocks.providerMounts).toBe(2);
    expect(mocks.providerUnmounts).toBe(1);
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
