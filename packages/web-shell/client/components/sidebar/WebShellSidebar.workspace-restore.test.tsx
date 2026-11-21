// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createSidebarMocks,
  DAEMON_APPROVAL_MODES,
  flushSidebar,
  installSidebarDomShims,
  resolveWebShellSessions,
} from '../../test/sidebarHarness';

const mocks = createSidebarMocks({
  workspaceBaseUrl: '',
  includePageData: false,
});
const { connection, workspace, workspaceActions, active } = mocks;

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DAEMON_APPROVAL_MODES,
  useConnection: () => connection,
  useActions: () => mocks.actions,
  useWorkspace: () => workspace,
  useWorkspaceActions: () => workspaceActions,
  useSessions: () => active,
  useChannels: () => mocks.channels,
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
    selectedWorkspaceCwd?: string;
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
          selectedWorkspaceCwd={overrides.selectedWorkspaceCwd}
          onSelectWorkspace={overrides.onSelectWorkspace}
        />
      </I18nProvider>,
    );
  });
}

// The projects header renders "Workspaces" plus the workspace count — the
// workspace rows are labelled by folder name, so the label (not DOM order)
// pins the header.
function projectsHeaderButton(): HTMLButtonElement | undefined {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
  ).find((button) =>
    button.textContent?.trim().toLowerCase().startsWith('workspace'),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  connection.sessionId = null;
  connection.sessionContext = undefined;
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

  it('does not override a stored collapsed projects preference for a cold draft on a non-primary connection', async () => {
    // A stored 'false' is a user preference
    // (hasWorkspaceExpansionPreference), so the effect must respect the
    // collapse instead of force-expanding — the assertion stays 'false'
    // only while the setter keeps its preference guard.
    window.localStorage.setItem(
      'qwen.web-shell.sidebar.workspace-expanded:projects',
      'false',
    );
    connection.sessionId = null;
    connection.workspaceCwd = '/tmp/second';
    const onSelectWorkspace = vi.fn();
    renderSidebar({ onSelectWorkspace });
    await flushSidebar();
    expect(projectsHeaderButton()?.getAttribute('aria-expanded')).toBe('false');
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });

  it('respects the stored collapse while expanding the active session context, without touching the selection', async () => {
    // The session-active effect expands the active workspace row, but the
    // seeded projects collapse is a user preference and must survive it.
    window.localStorage.setItem(
      'qwen.web-shell.sidebar.workspace-expanded:projects',
      'false',
    );
    connection.sessionId = 'session-1';
    connection.workspaceCwd = '/tmp/second';
    const onSelectWorkspace = vi.fn();
    renderSidebar({ onSelectWorkspace });
    await flushSidebar();
    expect(projectsHeaderButton()?.getAttribute('aria-expanded')).toBe('false');
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });

  it('does not rewrite the leftover selection when the primary pick re-runs the effect', async () => {
    // #16992 sequence: the draft carries a leftover selection, the user
    // picks the primary workspace (spelled `undefined`), which re-enters
    // the effect's trigger condition. A write gated to that re-run would
    // call back with the leftover cwd.
    connection.sessionId = null;
    connection.workspaceCwd = '/tmp/second';
    const onSelectWorkspace = vi.fn();
    renderSidebar({ selectedWorkspaceCwd: '/tmp/second', onSelectWorkspace });
    await flushSidebar();
    renderSidebar({ selectedWorkspaceCwd: undefined, onSelectWorkspace });
    await flushSidebar();
    expect(onSelectWorkspace).not.toHaveBeenCalledWith('/tmp/second');
  });

  it('does not write the connected workspace when capabilities settle after the primary pick', async () => {
    // The effect can only run once capabilities arrive; the draft has no
    // selection (primary pick), so a late write would land after the
    // user's first interaction.
    connection.sessionId = null;
    connection.workspaceCwd = '/tmp/second';
    workspace.capabilities = undefined;
    const onSelectWorkspace = vi.fn();
    renderSidebar({ onSelectWorkspace });
    await flushSidebar();
    workspace.capabilities = capabilities;
    renderSidebar({ onSelectWorkspace });
    await flushSidebar();
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });
});
