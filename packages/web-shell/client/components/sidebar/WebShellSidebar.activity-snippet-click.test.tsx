// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  clickSidebarElement as click,
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
  colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
  searchWorkspaceSessions: true,
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

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DAEMON_APPROVAL_MODES,
  useConnection: () => mocks.connection,
  useActions: () => mocks.actions,
  useWorkspace: () => mocks.workspace,
  useWorkspaceActions: () => mocks.workspaceActions,
  useChannels: () => mocks.channels,
  useSessions: (options?: { archiveState?: string; group?: string }) =>
    sidebarSessionPage(mocks, options),
}));

vi.mock('../../session-catalog/session-catalog-hooks', () => ({
  useWebShellSessions: (options?: {
    enabled?: boolean;
    archiveState?: string;
    group?: string;
  }) => useResolvedWebShellSessions(mocks, options),
  useSessionCatalogController: () => ({
    refreshQueries: refreshSessionCatalogQueries,
    invalidateWorkspace: vi.fn(),
    refreshWorkspace: vi.fn(),
    renamed: vi.fn(),
    toggleSessionPinned: vi.fn(),
  }),
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

const organizationCapabilities = {
  qwenCodeVersion: '1.2.3',
  features: ['session_organization'],
};

const PREVIEW_TEXT = 'matched message content';
const previewEvents = [
  {
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: PREVIEW_TEXT },
      },
    },
  },
];

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
          onLoadSession={loadSession}
          onError={() => {}}
        />
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  connection.sessionId = null;
  connection.workspaceCwd = '/tmp/project';
  connection.capabilities = organizationCapabilities;
  workspace.capabilities = organizationCapabilities;
  workspaceActions.updateSessionOrganization.mockReset();
  workspaceActions.updateSessionOrganization.mockResolvedValue({});
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
  // The activity catalog loads a row's preview through the daemon transcript
  // API; give the mocked workspace a page with one agent message chunk.
  const defaultWorkspaceApi = workspace.client.workspaceByCwd();
  workspace.client.workspaceByCwd.mockReturnValue({
    ...defaultWorkspaceApi,
    getSessionTranscriptPage: vi.fn().mockResolvedValue({
      partial: false,
      events: previewEvents,
    }),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
});

describe('WebShellSidebar activity snippet click', () => {
  it('lets a search-snippet click reach the row open handler without starting a rename', async () => {
    const session = makeSession('s1', {
      displayName: 'Matched session',
      hasActivePrompt: true,
      updatedAt: new Date().toISOString(),
    });
    active.sessions = [session];
    active.data = active.sessions;
    useSessionCatalogQueries.mockReturnValue([
      { loading: false, stale: false, page: { sessions: [session] } },
    ]);
    renderSidebar();
    await flushSidebar();

    await act(async () => {
      click(
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="View activity"]',
        )!,
      );
    });
    await flushSidebar();

    // The preview settles asynchronously; the snippet span carries it alone.
    const snippet = Array.from(container.querySelectorAll('span')).find(
      (node) => node.textContent === PREVIEW_TEXT,
    );
    expect(snippet).toBeDefined();

    await act(async () => {
      click(snippet!);
    });
    await flushSidebar();

    // The click reaches the row's open handler (the baseline behavior the
    // review asked to keep): the session loads...
    expect(loadSession).toHaveBeenCalledTimes(1);
    expect(loadSession).toHaveBeenCalledWith('s1', '/tmp/project');
    // ...and no rename UI mounts from a single click on the excerpt.
    expect(container.querySelector('input[aria-label^="Rename"]')).toBeNull();
    // The title still renders as a title (not an editor) on the row.
    const title = snippet!.closest('[data-web-shell-session-title]');
    expect(title).not.toBeNull();
    expect(title!.querySelector('input')).toBeNull();
  });
});
