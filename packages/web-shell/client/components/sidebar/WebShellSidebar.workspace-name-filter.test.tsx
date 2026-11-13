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
      displayName: 'Alpha Project',
      primary: true,
      trusted: true,
      removable: false,
    },
    {
      id: 'second',
      cwd: '/tmp/second',
      displayName: 'Beta Service',
      primary: false,
      trusted: true,
      removable: true,
    },
    {
      id: 'third',
      cwd: '/tmp/third',
      displayName: 'Gamma Tool',
      primary: false,
      trusted: true,
      removable: true,
    },
    {
      id: 'live-one',
      cwd: '/live/one',
      displayName: 'Live One',
      kind: 'live' as const,
      primary: false,
      trusted: true,
      removable: false,
    },
  ],
} satisfies NonNullable<typeof workspace.capabilities>;

let root: Root;
let container: HTMLDivElement;

function renderSidebar(opts?: { showLive?: boolean }): void {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WebShellSidebar
          showLive={opts?.showLive ?? false}
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
        />
      </I18nProvider>,
    );
  });
}

function projectCwdsInDom(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[class*="workspaceList"] [class*="headerRow"]',
    ),
  ).flatMap((row) => {
    // The live section reuses the workspace-row markup with a custom header;
    // count only project rows carrying a name title.
    if (row.querySelector('[class*="liveWorkspaceHeader"]')) {
      return [];
    }
    const title =
      row.querySelector<HTMLElement>('[class*="name"][title]')?.title ?? '';
    return title ? [title] : [];
  });
}

function liveHeadersInDom(): number {
  return container.querySelectorAll('[class*="liveWorkspaceHeader"]').length;
}

async function openSearch(): Promise<void> {
  if (container.querySelector('input[aria-label="Search sessions"]') === null) {
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Search sessions"]',
    );
    expect(toggle).not.toBeNull();
    act(() => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushSidebar();
  }
}

async function typeSearchQuery(value: string): Promise<void> {
  await openSearch();
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Search sessions"]',
  )!;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flushSidebar();
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

describe('WebShellSidebar workspace name filter', () => {
  it('shows every workspace section without a query', async () => {
    renderSidebar();
    await flushSidebar();
    expect(projectCwdsInDom().length).toBe(3);
  });

  it('keeps only the workspaces whose name or cwd matches the query', async () => {
    renderSidebar();
    await flushSidebar();
    await typeSearchQuery('beta');
    expect(projectCwdsInDom()).toEqual(['/tmp/second']);
  });

  it('matches the cwd case-insensitively as a substring', async () => {
    renderSidebar();
    await flushSidebar();
    await typeSearchQuery('SECOND');
    expect(projectCwdsInDom()).toEqual(['/tmp/second']);
  });

  it('keeps all workspaces when the query matches no workspace name', async () => {
    renderSidebar();
    await flushSidebar();
    await typeSearchQuery('zzz');
    expect(projectCwdsInDom().length).toBe(3);
  });

  it('restores the full list when the query is cleared', async () => {
    renderSidebar();
    await flushSidebar();
    await typeSearchQuery('beta');
    expect(projectCwdsInDom()).toEqual(['/tmp/second']);
    await typeSearchQuery('');
    expect(projectCwdsInDom().length).toBe(3);
  });

  it('filters live workspace sections by the same name query', async () => {
    renderSidebar({ showLive: true });
    await flushSidebar();
    expect(liveHeadersInDom()).toBe(1);
    expect(projectCwdsInDom().length).toBe(3);
    await typeSearchQuery('live one');
    // The name query hides every project section, and the live section
    // (matched by its displayName) stays.
    expect(liveHeadersInDom()).toBe(1);
    expect(projectCwdsInDom()).toEqual([]);
    await typeSearchQuery('zzz');
    // No workspace name matches: name mode stays off, full list visible.
    expect(liveHeadersInDom()).toBe(1);
    expect(projectCwdsInDom().length).toBe(3);
  });
});
