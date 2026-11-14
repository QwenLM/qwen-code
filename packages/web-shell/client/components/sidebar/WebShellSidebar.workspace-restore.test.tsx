// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import {
  flushSidebar,
  installSidebarDomShims,
  resolveWebShellSessions,
} from '../../test/sidebarHarness';

const { connection, workspace, workspaceActions, active } = vi.hoisted(() => {
  const active = {
    sessions: [] as DaemonSessionSummary[],
    data: [] as DaemonSessionSummary[] | undefined,
    loading: false,
    error: null as Error | null,
    reload: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(true),
    archiveSession: vi.fn().mockResolvedValue(true),
    unarchiveSession: vi.fn().mockResolvedValue(true),
    exportSession: vi.fn(),
  };
  return {
    connection: {
      status: 'connected',
      sessionId: null as string | null,
      workspaceCwd: '/tmp/project',
      capabilities: undefined as
        | {
            qwenCodeVersion: string;
            features: string[];
            workspaces?: DaemonWorkspaceCapability[];
          }
        | undefined,
    },
    workspace: {
      baseUrl: '',
      capabilities: undefined as
        | {
            qwenCodeVersion: string;
            features: string[];
            workspaces?: DaemonWorkspaceCapability[];
          }
        | undefined,
      client: {
        getWorkspaceOrder: vi.fn().mockResolvedValue({ cwds: [] }),
        setWorkspaceOrder: vi.fn().mockResolvedValue({ cwds: [] }),
        searchWorkspaceSessions: vi.fn().mockResolvedValue({ results: [] }),
        workspaceByCwd: vi.fn(() => ({
          listWorkspaceSessions: vi.fn().mockResolvedValue([]),
          // The header actions poll git; answer as a non-git workspace.
          workspaceGit: vi
            .fn()
            .mockResolvedValue({ v: 2, workspaceCwd: '', branch: null }),
          listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
          workspaceChannelTypes: vi.fn().mockResolvedValue([]),
          workspaceChannels: vi
            .fn()
            .mockResolvedValue({ revision: '0', instances: {} }),
        })),
      },
      refreshCapabilities: vi.fn(),
    },
    workspaceActions: {
      addWorkspace: vi.fn(),
      updateWorkspace: vi.fn(),
      removeWorkspace: vi.fn(),
      listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
    },
    active,
  };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DAEMON_APPROVAL_MODES: ['default', 'plan', 'auto-edit', 'auto', 'yolo'],
  useConnection: () => connection,
  useActions: () => ({ renameSession: vi.fn() }),
  useWorkspace: () => workspace,
  useWorkspaceActions: () => workspaceActions,
  useSessions: () => active,
  useChannels: () => ({ data: undefined, catalog: [], channels: {} }),
}));

vi.mock('../../session-catalog/session-catalog-hooks', () => ({
  useWebShellSessions: (options?: {
    enabled?: boolean;
    archiveState?: string;
  }) =>
    resolveWebShellSessions(active, options?.enabled !== false, {
      routeKind: 'legacy',
      workspaceCwd: connection.workspaceCwd,
      options,
    }),
  useSessionCatalogController: () => ({
    refreshQueries: vi.fn(),
    invalidateWorkspace: vi.fn(),
    refreshWorkspace: vi.fn(),
    renamed: vi.fn(),
    toggleSessionPinned: vi.fn(),
  }),
  useSessionCatalogPolling: () => undefined,
  useSessionCatalogQuery: () => ({
    sessions: [],
    loading: false,
    error: undefined,
    reload: vi.fn().mockResolvedValue({ sessions: [] }),
  }),
  useSessionCatalogQueries: () => [],
}));

const { I18nProvider } = await import('../../i18n');
const { WebShellSidebar } = await import('./WebShellSidebar');

installSidebarDomShims();

const capabilities = {
  qwenCodeVersion: '1.2.3',
  features: [
    'multi_workspace_sessions',
    'workspace_qualified_rest_core',
    'workspace_session_metadata',
  ],
  workspaces: [
    {
      id: 'primary',
      cwd: '/tmp/project',
      primary: true,
      trusted: true,
      removable: false,
    },
    {
      id: 'second',
      cwd: '/tmp/second',
      primary: false,
      trusted: true,
      removable: true,
    },
  ],
} satisfies NonNullable<typeof workspace.capabilities>;

let root: Root;
let container: HTMLDivElement;

function renderSidebar(
  overrides: {
    onSelectWorkspace?: (workspaceCwd: string | undefined) => void;
  } = {},
): void {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WebShellSidebar
          collapsed={false}
          onCollapsedChange={() => {}}
          onOpenSettings={() => {}}
          onOpenDaemonStatus={() => {}}
          onOpenScheduledTasks={() => {}}
          onOpenGoals={() => {}}
          onOpenSessions={() => {}}
          onOpenSplitView={() => {}}
          onNewSession={() => false}
          onLoadSession={() => {}}
          onError={() => {}}
          onSelectWorkspace={overrides.onSelectWorkspace}
        />
      </I18nProvider>,
    );
  });
}

function projectsHeaderButton(): HTMLButtonElement | undefined {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
  ).find((button) =>
    button.textContent?.trim().toLowerCase().startsWith('project'),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  connection.sessionId = null;
  connection.workspaceCwd = '/tmp/project';
  connection.capabilities = capabilities;
  workspace.capabilities = capabilities;
  workspace.baseUrl = '';
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
});

describe('WebShellSidebar workspace auto-restore', () => {
  it('does not force-select the connected non-primary workspace for a cold draft', async () => {
    // A stale connection left on a non-primary workspace by the previous
    // session; the draft has no selection yet (`undefined` spells primary).
    connection.sessionId = null;
    connection.workspaceCwd = '/tmp/second';
    const onSelectWorkspace = vi.fn();
    renderSidebar({ onSelectWorkspace });
    await flushSidebar();
    // Writing the leftover cwd into the selection is what silently reverts
    // the user's first composer-pick of the primary workspace (#16992):
    // that pick is spelled `undefined`, which re-enters this effect's
    // trigger condition.
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });

  it('still expands the projects section for a cold draft on a non-primary connection', async () => {
    connection.sessionId = null;
    connection.workspaceCwd = '/tmp/second';
    renderSidebar();
    await flushSidebar();
    expect(projectsHeaderButton()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('does not touch the selection while a session is active', async () => {
    connection.sessionId = 'session-1';
    connection.workspaceCwd = '/tmp/second';
    const onSelectWorkspace = vi.fn();
    renderSidebar({ onSelectWorkspace });
    await flushSidebar();
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });
});
