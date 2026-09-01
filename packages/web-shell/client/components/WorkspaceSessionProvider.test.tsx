// @vitest-environment jsdom

import { act, type ReactNode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import type { WebShellProps } from '../App';

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
  getStandaloneSession: vi.fn(),
  unarchiveStandaloneSessions: vi.fn(),
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
    mocks.getStandaloneSession.mockReset();
    mocks.unarchiveStandaloneSessions.mockReset();
    mocks.workspace.client = {
      getStandaloneSession: mocks.getStandaloneSession,
      unarchiveStandaloneSessions: mocks.unarchiveStandaloneSessions,
    };
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

  it('preserves an explicit workspace context for provider conflict checks', async () => {
    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="session-b"
          workspaceCwd="/work/b"
          sessionContext={{ kind: 'workspace', cwd: '/work/a' }}
          webShellProps={{}}
        />,
      );
    });

    expect(mocks.providerProps.at(-1)).toMatchObject({
      sessionId: 'session-b',
      sessionContext: { kind: 'workspace', cwd: '/work/a' },
      workspaceCwd: '/work/b',
    });
  });

  it('resolves an explicit workspace context through the workspace gate', async () => {
    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="session-b"
          sessionContext={{ kind: 'workspace', cwd: '/work/b' }}
          webShellProps={{}}
        />,
      );
    });

    expect(mocks.providerProps.at(-1)).toMatchObject({
      sessionId: 'session-b',
      sessionContext: { kind: 'workspace', cwd: '/work/b' },
      workspaceCwd: '/work/b',
    });
    expect(mocks.appProps.at(-1)).toMatchObject({
      initialSelectedWorkspaceCwd: '/work/b',
    });
  });

  it('drops an unavailable explicit context for a primary new session', async () => {
    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="session-missing"
          sessionContext={{ kind: 'workspace', cwd: '/work/missing' }}
          webShellProps={{}}
        />,
      );
    });

    const startFresh = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'New session',
    );
    await act(async () => startFresh?.click());

    expect(mocks.providerProps.at(-1)).toMatchObject({
      sessionId: undefined,
      sessionContext: undefined,
      workspaceCwd: undefined,
    });
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

  it('exact-checks a standalone deep link before mounting its provider', async () => {
    mocks.workspace = {
      ...mocks.workspace,
      capabilities: {
        workspaceCwd: '/work/a',
        features: ['standalone_sessions_v1'],
        workspaces: [{ id: 'a', cwd: '/work/a', primary: true, trusted: true }],
      },
      client: {
        getStandaloneSession: mocks.getStandaloneSession,
        unarchiveStandaloneSessions: mocks.unarchiveStandaloneSessions,
      },
    };
    mocks.getStandaloneSession.mockResolvedValue({
      sessionId: 'standalone-a',
      workspaceCwd: '/internal/conversations/standalone-a',
      sourceType: 'standalone',
      context: { kind: 'standalone' },
      isArchived: false,
    });

    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="standalone-a"
          sessionContext={{ kind: 'standalone' }}
          webShellProps={{}}
        />,
      );
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(mocks.getStandaloneSession).toHaveBeenCalledWith('standalone-a'),
      );
    });
    await act(async () => Promise.resolve());

    expect(mocks.providerMounts).toBe(1);
    expect(mocks.providerProps.at(-1)).toMatchObject({
      sessionId: 'standalone-a',
      sessionContext: { kind: 'standalone' },
    });
    expect(mocks.providerProps.at(-1)).not.toHaveProperty('workspaceCwd');
  });

  it('never calls a standalone route when the capability is absent', async () => {
    mocks.workspace = {
      ...mocks.workspace,
      capabilities: {
        workspaceCwd: '/work/a',
        features: [],
        workspaces: [{ id: 'a', cwd: '/work/a', primary: true, trusted: true }],
      },
      client: {
        getStandaloneSession: mocks.getStandaloneSession,
        unarchiveStandaloneSessions: mocks.unarchiveStandaloneSessions,
      },
    };

    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="standalone-a"
          sessionContext={{ kind: 'standalone' }}
          webShellProps={{}}
        />,
      );
    });

    expect(mocks.getStandaloneSession).not.toHaveBeenCalled();
    expect(mocks.providerMounts).toBe(0);
    expect(container.textContent).toContain(
      'Standalone conversations are unavailable',
    );
  });

  it('offers a standalone draft when an exact deep link is missing', async () => {
    const onSessionIdChange = vi.fn();
    mocks.workspace = {
      ...mocks.workspace,
      capabilities: {
        workspaceCwd: '/work/a',
        features: ['standalone_sessions_v1'],
        workspaces: [{ id: 'a', cwd: '/work/a', primary: true, trusted: true }],
      },
      client: {
        getStandaloneSession: mocks.getStandaloneSession,
        unarchiveStandaloneSessions: mocks.unarchiveStandaloneSessions,
      },
    };
    mocks.getStandaloneSession.mockRejectedValue(
      new DaemonHttpError(
        404,
        { code: 'standalone_session_not_found' },
        'not found',
      ),
    );

    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="standalone-missing"
          sessionContext={{ kind: 'standalone' }}
          webShellProps={{ onSessionIdChange }}
        />,
      );
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain('Conversation not found'),
      );
    });

    const startFresh = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'New session',
    );
    await act(async () => startFresh?.click());

    expect(onSessionIdChange).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      { kind: 'standalone' },
    );
    expect(mocks.providerMounts).toBe(0);
  });

  it('requires an explicit successful unarchive before mounting an archived deep link', async () => {
    mocks.workspace = {
      ...mocks.workspace,
      capabilities: {
        workspaceCwd: '/work/a',
        features: ['standalone_sessions_v1'],
        workspaces: [{ id: 'a', cwd: '/work/a', primary: true, trusted: true }],
      },
      client: {
        getStandaloneSession: mocks.getStandaloneSession,
        unarchiveStandaloneSessions: mocks.unarchiveStandaloneSessions,
      },
    };
    mocks.getStandaloneSession.mockResolvedValue({
      sessionId: 'standalone-a',
      workspaceCwd: '/internal/conversations/standalone-a',
      sourceType: 'standalone',
      context: { kind: 'standalone' },
      isArchived: true,
    });
    mocks.unarchiveStandaloneSessions.mockResolvedValue({
      unarchived: ['standalone-a'],
      alreadyActive: [],
      resolvedConflicts: [],
      notFound: [],
      errors: [],
    });

    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="standalone-a"
          sessionContext={{ kind: 'standalone' }}
          webShellProps={{}}
        />,
      );
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          'This conversation is archived',
        ),
      );
    });
    expect(mocks.providerMounts).toBe(0);

    const unarchive = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Unarchive',
    );
    await act(async () => unarchive?.click());

    expect(mocks.unarchiveStandaloneSessions).toHaveBeenCalledWith([
      'standalone-a',
    ]);
    expect(mocks.providerMounts).toBe(1);
  });

  it('accepts normalized daemon ids when unarchiving a mixed-case deep link', async () => {
    mocks.workspace = {
      ...mocks.workspace,
      capabilities: {
        workspaceCwd: '/work/a',
        features: ['standalone_sessions_v1'],
        workspaces: [{ id: 'a', cwd: '/work/a', primary: true, trusted: true }],
      },
      client: {
        getStandaloneSession: mocks.getStandaloneSession,
        unarchiveStandaloneSessions: mocks.unarchiveStandaloneSessions,
      },
    };
    mocks.getStandaloneSession.mockResolvedValue({
      sessionId: 'standalone-a',
      sourceType: 'standalone',
      context: { kind: 'standalone' },
      isArchived: true,
    });
    mocks.unarchiveStandaloneSessions.mockResolvedValue({
      unarchived: ['standalone-a'],
      alreadyActive: [],
      resolvedConflicts: [],
      notFound: [],
      errors: [],
    });

    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="Standalone-A"
          sessionContext={{ kind: 'standalone' }}
          webShellProps={{}}
        />,
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain('This conversation is archived'),
    );
    const unarchive = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Unarchive',
    );

    await act(async () => unarchive?.click());

    expect(mocks.unarchiveStandaloneSessions).toHaveBeenCalledWith([
      'Standalone-A',
    ]);
    expect(mocks.providerMounts).toBe(1);
  });

  it('ignores a stale unarchive result after navigating to another standalone session', async () => {
    let resolveUnarchive!: (value: {
      unarchived: string[];
      alreadyActive: string[];
      resolvedConflicts: string[];
      notFound: string[];
      errors: Array<{ sessionId: string; message: string }>;
    }) => void;
    let resolveNextLookup!: (value: {
      sessionId: string;
      sourceType: 'standalone';
      context: { kind: 'standalone' };
      isArchived: boolean;
    }) => void;
    const unarchivePromise = new Promise<
      Parameters<typeof resolveUnarchive>[0]
    >((resolve) => {
      resolveUnarchive = resolve;
    });
    const nextLookupPromise = new Promise<
      Parameters<typeof resolveNextLookup>[0]
    >((resolve) => {
      resolveNextLookup = resolve;
    });
    mocks.workspace = {
      ...mocks.workspace,
      capabilities: {
        workspaceCwd: '/work/a',
        features: ['standalone_sessions_v1'],
        workspaces: [{ id: 'a', cwd: '/work/a', primary: true, trusted: true }],
      },
      client: {
        getStandaloneSession: mocks.getStandaloneSession,
        unarchiveStandaloneSessions: mocks.unarchiveStandaloneSessions,
      },
    };
    mocks.getStandaloneSession.mockImplementation((requestedSessionId) =>
      requestedSessionId === 'standalone-a'
        ? Promise.resolve({
            sessionId: 'standalone-a',
            sourceType: 'standalone',
            context: { kind: 'standalone' },
            isArchived: true,
          })
        : nextLookupPromise,
    );
    mocks.unarchiveStandaloneSessions.mockReturnValue(unarchivePromise);

    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="standalone-a"
          sessionContext={{ kind: 'standalone' }}
          webShellProps={{}}
        />,
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain('This conversation is archived'),
    );
    const unarchive = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Unarchive',
    );
    act(() => unarchive?.click());

    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="standalone-b"
          sessionContext={{ kind: 'standalone' }}
          webShellProps={{}}
        />,
      );
    });
    await vi.waitFor(() =>
      expect(mocks.getStandaloneSession).toHaveBeenCalledWith('standalone-b'),
    );
    await act(async () => {
      resolveUnarchive({
        unarchived: ['standalone-a'],
        alreadyActive: [],
        resolvedConflicts: [],
        notFound: [],
        errors: [],
      });
      await unarchivePromise;
    });

    expect(container.textContent).toContain('Opening conversation');
    expect(mocks.providerMounts).toBe(0);

    await act(async () => {
      resolveNextLookup({
        sessionId: 'standalone-b',
        sourceType: 'standalone',
        context: { kind: 'standalone' },
        isArchived: true,
      });
      await nextLookupPromise;
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain('This conversation is archived'),
    );
    expect(mocks.providerMounts).toBe(0);
  });

  it('shows not found when an archived deep link disappears during unarchive', async () => {
    mocks.workspace = {
      ...mocks.workspace,
      capabilities: {
        workspaceCwd: '/work/a',
        features: ['standalone_sessions_v1'],
        workspaces: [{ id: 'a', cwd: '/work/a', primary: true, trusted: true }],
      },
      client: {
        getStandaloneSession: mocks.getStandaloneSession,
        unarchiveStandaloneSessions: mocks.unarchiveStandaloneSessions,
      },
    };
    mocks.getStandaloneSession.mockResolvedValue({
      sessionId: 'standalone-a',
      sourceType: 'standalone',
      context: { kind: 'standalone' },
      isArchived: true,
    });
    mocks.unarchiveStandaloneSessions.mockResolvedValue({
      unarchived: [],
      alreadyActive: [],
      notFound: ['standalone-a'],
      errors: [],
    });

    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="standalone-a"
          sessionContext={{ kind: 'standalone' }}
          webShellProps={{}}
        />,
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain('This conversation is archived'),
    );
    const unarchive = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Unarchive',
    );

    await act(async () => unarchive?.click());

    expect(container.textContent).toContain('Conversation not found');
    expect(mocks.providerMounts).toBe(0);
  });

  it('keeps a resolved standalone provider mounted across language and capability refreshes', async () => {
    mocks.workspace = {
      ...mocks.workspace,
      capabilities: {
        workspaceCwd: '/work/a',
        features: ['standalone_sessions_v1'],
      },
    };
    mocks.getStandaloneSession.mockResolvedValue({
      sessionId: 'standalone-a',
      sourceType: 'standalone',
      context: { kind: 'standalone' },
      isArchived: false,
    });
    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="standalone-a"
          sessionContext={{ kind: 'standalone' }}
          webShellProps={{ language: 'en' }}
        />,
      );
    });
    await vi.waitFor(() => expect(mocks.providerMounts).toBe(1));

    mocks.workspace = {
      ...mocks.workspace,
      capabilities: {
        workspaceCwd: '/work/a',
        features: ['standalone_sessions_v1'],
      },
    };
    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="standalone-a"
          sessionContext={{ kind: 'standalone' }}
          webShellProps={{ language: 'zh-CN' }}
        />,
      );
    });

    expect(mocks.getStandaloneSession).toHaveBeenCalledOnce();
    expect(mocks.providerMounts).toBe(1);
    expect(mocks.providerUnmounts).toBe(0);
  });

  it('trusts a standalone session id reported by the mounted App', async () => {
    const onSessionIdChange = vi.fn();
    mocks.workspace = {
      ...mocks.workspace,
      capabilities: {
        workspaceCwd: '/work/a',
        features: ['standalone_sessions_v1'],
      },
    };
    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionContext={{ kind: 'standalone' }}
          webShellProps={{ onSessionIdChange }}
        />,
      );
    });
    expect(mocks.providerMounts).toBe(1);
    const reportedChange = mocks.appProps.at(-1)?.['onSessionIdChange'] as
      | NonNullable<WebShellProps['onSessionIdChange']>
      | undefined;
    act(() => {
      reportedChange?.('standalone-created', undefined, undefined, {
        kind: 'standalone',
      });
    });
    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="standalone-created"
          sessionContext={{ kind: 'standalone' }}
          webShellProps={{ onSessionIdChange }}
        />,
      );
    });

    expect(onSessionIdChange).toHaveBeenCalled();
    expect(mocks.getStandaloneSession).not.toHaveBeenCalled();
    expect(mocks.providerMounts).toBe(1);
    expect(mocks.providerUnmounts).toBe(0);
  });

  it('rejects conflicting standalone and workspace targets', async () => {
    await act(async () => {
      root.render(
        <WorkspaceSessionProvider
          sessionId="standalone-a"
          workspaceId="a"
          sessionContext={{ kind: 'standalone' }}
          webShellProps={{}}
        />,
      );
    });

    expect(mocks.getStandaloneSession).not.toHaveBeenCalled();
    expect(mocks.providerMounts).toBe(0);
    expect(container.textContent).toContain(
      'A standalone or Live conversation link cannot include a workspace target.',
    );
  });
});
