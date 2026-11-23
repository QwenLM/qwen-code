// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createSidebarMocks,
  DAEMON_APPROVAL_MODES,
  flushSidebar,
  installSidebarDomShims,
  makeSidebarSession as makeSession,
  useResolvedWebShellSessions,
  sidebarSessionPage,
  useSidebarSessionCatalogQuery,
} from '../../test/sidebarHarness';

const mocks = createSidebarMocks({
  connection: { capabilities: undefined },
});
const {
  connection,
  workspace,
  workspaceActions,
  active,
  pinned,
  archived,
  refreshSessionCatalogQueries,
  useSessionCatalogQueries,
  loadSession,
} = mocks;
const sessionCatalogController = {
  refreshQueries: refreshSessionCatalogQueries,
  invalidateWorkspace: vi.fn(),
  refreshWorkspace: vi.fn(),
  renamed: vi.fn(),
  toggleSessionPinned: vi.fn(),
};

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DAEMON_APPROVAL_MODES,
  useConnection: () => mocks.connection,
  useActions: () => mocks.actions,
  useWorkspace: () => mocks.workspace,
  useWorkspaceActions: () => mocks.workspaceActions,
  useChannels: () => mocks.channels,
  useSessions: (options?: { archiveState?: string; group?: string }) =>
    sidebarSessionPage(mocks, options),
  useStreamingState: () => 'idle',
}));

vi.mock('../../session-catalog/session-catalog-hooks', () => ({
  useWebShellSessions: (options?: {
    enabled?: boolean;
    archiveState?: string;
    group?: string;
  }) => useResolvedWebShellSessions(mocks, options),
  useSessionCatalogController: () => sessionCatalogController,
  useSessionCatalogPolling: () => undefined,
  useSessionCatalogQuery: (
    client: typeof mocks.workspace.client,
    query: { workspaceCwd: string; options?: Record<string, unknown> },
    options: { autoLoad?: boolean; enabled?: boolean },
  ) => useSidebarSessionCatalogQuery(client, query, options),
  useSessionCatalogQueries,
}));

const { I18nProvider } = await import('../../i18n');
const { WebShellSidebar } = await import('./WebShellSidebar');

installSidebarDomShims();

let root: Root;
let container: HTMLDivElement;

function renderSidebar(language: 'en' | 'zh-CN' = 'en') {
  const sidebar = (
    <WebShellSidebar
      collapsed={false}
      onCollapsedChange={() => {}}
      onOpenSettings={() => {}}
      onOpenDaemonStatus={() => {}}
      onOpenScheduledTasks={() => {}}
      onOpenWorkflows={() => {}}
      onOpenGoals={() => {}}
      onOpenSessions={() => {}}
      onOpenSplitView={() => {}}
      onNewSession={() => false}
      onLeaveCurrentStandaloneForDelete={async () => false}
      onLoadSession={loadSession}
      onError={() => {}}
    />
  );
  act(() => {
    root.render(<I18nProvider language={language}>{sidebar}</I18nProvider>);
  });
}

function continuationBadge(): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-web-shell-session-continuation]',
  );
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container.appendChild(document.createElement('div')));
  connection.status = 'connected';
  connection.loadingTranscript = false;
  connection.error = undefined;
  connection.sessionId = null;
  connection.sessionContext = undefined;
  connection.workspaceCwd = '/tmp/project';
  connection.capabilities = undefined;
  workspace.capabilities = undefined;
  workspace.client.listWorkspaceSessionsPage
    .mockReset()
    .mockResolvedValue({ sessions: [] });
  workspace.client.listStandaloneSessionsPage
    .mockReset()
    .mockResolvedValue({ sessions: [] });
  workspaceActions.listSessionGroups.mockReset();
  workspaceActions.listSessionGroups.mockResolvedValue({
    groups: [],
    colorOptions: [],
  });
  active.sessions = [];
  active.data = active.sessions;
  pinned.sessions = [];
  pinned.data = pinned.sessions;
  archived.sessions = [];
  archived.data = archived.sessions;
  refreshSessionCatalogQueries.mockReset();
  useSessionCatalogQueries.mockReset();
  useSessionCatalogQueries.mockReturnValue([]);
  loadSession.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('WebShellSidebar continuation badge', () => {
  it('shows the badge for an idle session with persisted cut-off evidence', async () => {
    active.sessions = [makeSession('interrupted', { needsContinuation: true })];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();
    const badge = continuationBadge();
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('Continue');
    expect(badge!.getAttribute('aria-label')).toBe('Continue execution needed');
  });

  it('localizes the badge in zh-CN', async () => {
    active.sessions = [makeSession('interrupted', { needsContinuation: true })];
    active.data = active.sessions;
    renderSidebar('zh-CN');
    await flushSidebar();
    const badge = continuationBadge();
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('待继续');
    expect(badge!.getAttribute('aria-label')).toBe('需要继续执行');
  });

  it.each([
    ['an active prompt', { hasActivePrompt: true }],
    ['active work', { activeWorkState: 'active' as const }],
    ['running background tasks', { hasRunningBackgroundTasks: true }],
    [
      'a background notification turn',
      {
        backgroundTurn: {
          turnId: 't1',
          taskId: 'task1',
          kind: 'shell' as const,
          startedAt: 1,
        },
      },
    ],
    [
      'a waiting approval',
      { hasActivePrompt: true, isWaitingForPermission: true },
    ],
    [
      'a waiting user question',
      { hasActivePrompt: true, isWaitingForUserQuestion: true },
    ],
  ])('hides the badge while the session has %s', async (_label, overrides) => {
    active.sessions = [
      makeSession('interrupted', { needsContinuation: true, ...overrides }),
    ];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();
    expect(continuationBadge()).toBeNull();
  });

  it('shows no badge without the persisted flag', async () => {
    active.sessions = [makeSession('clean')];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();
    expect(continuationBadge()).toBeNull();
  });

  it('yields the git icon to the badge', async () => {
    active.sessions = [
      makeSession('interrupted', {
        needsContinuation: true,
        branch: { name: 'feature', baseBranch: 'main' },
      }),
    ];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();
    expect(continuationBadge()).not.toBeNull();
    expect(container.querySelector('[aria-label="feature"]')).toBeNull();
  });
});
