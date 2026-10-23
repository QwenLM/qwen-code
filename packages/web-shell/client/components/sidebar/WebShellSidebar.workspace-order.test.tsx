// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import {
  clickSidebarElement,
  flushSidebar,
  installSidebarDomShims,
  resolveWebShellSessions,
} from '../../test/sidebarHarness';
import { readWorkspaceOrder, writeWorkspaceOrder } from './workspaceOrder';

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
    {
      id: 'third',
      cwd: '/tmp/third',
      primary: false,
      trusted: true,
      removable: true,
    },
  ],
} satisfies NonNullable<typeof workspace.capabilities>;

let root: Root;
let container: HTMLDivElement;

function renderSidebar(): void {
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
        />
      </I18nProvider>,
    );
  });
}

function workspaceRows(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[class*="workspaceList"] [class*="headerRow"]',
    ),
  );
}

function workspaceOrderInDom(): string[] {
  return workspaceRows().map(
    (row) =>
      row.querySelector<HTMLElement>('[class*="name"][title]')?.title ?? '',
  );
}

async function openWorkspaceMenu(cwd: string): Promise<void> {
  const row = workspaceRows().find(
    (candidate) =>
      candidate.querySelector<HTMLElement>('[class*="name"]')?.title === cwd,
  );
  const button = row?.querySelector<HTMLButtonElement>(
    'button[aria-label="Workspace actions"]',
  );
  expect(button).toBeDefined();
  await act(async () => {
    clickSidebarElement(button!, true);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function menuItem(label: string): HTMLElement | undefined {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((item) => item.textContent?.trim() === label);
}

function menuItemLabels(): string[] {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).map((item) => item.textContent?.trim() ?? '');
}

async function selectMenuItem(label: string): Promise<void> {
  const item = menuItem(label);
  expect(item).toBeDefined();
  await act(async () => {
    clickSidebarElement(item!, true);
    await Promise.resolve();
    await Promise.resolve();
  });
  await flushSidebar();
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  connection.sessionId = null;
  connection.capabilities = capabilities;
  workspace.capabilities = capabilities;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
});

describe('WebShellSidebar workspace order', () => {
  it('moves a workspace up and persists the new order', async () => {
    renderSidebar();
    expect(workspaceOrderInDom()).toEqual([
      '/tmp/project',
      '/tmp/second',
      '/tmp/third',
    ]);

    await openWorkspaceMenu('/tmp/third');
    await selectMenuItem('Move up');

    expect(workspaceOrderInDom()).toEqual([
      '/tmp/project',
      '/tmp/third',
      '/tmp/second',
    ]);
    expect(readWorkspaceOrder(window.location.origin)).toEqual([
      '/tmp/project',
      '/tmp/third',
      '/tmp/second',
    ]);
  });

  it('restores a stored order and appends unlisted workspaces last', async () => {
    writeWorkspaceOrder(window.location.origin, ['/tmp/third']);
    renderSidebar();

    expect(workspaceOrderInDom()).toEqual([
      '/tmp/third',
      '/tmp/project',
      '/tmp/second',
    ]);
  });

  it('offers only the moves that can change the order', async () => {
    renderSidebar();

    await openWorkspaceMenu('/tmp/project');
    expect(menuItemLabels()).toContain('Move down');
    expect(menuItemLabels()).not.toContain('Move up');

    await openWorkspaceMenu('/tmp/third');
    expect(menuItemLabels()).toContain('Move up');
    expect(menuItemLabels()).not.toContain('Move down');
  });
});
