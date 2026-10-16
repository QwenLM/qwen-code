// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  clickSidebarElement as click,
  flushSidebar,
  installSidebarDomShims,
  makeSidebarSession as makeSession,
  resolveWebShellSessions,
} from '../../test/sidebarHarness';

const {
  connection,
  workspace,
  workspaceClient,
  workspaceActions,
  active,
  pinned,
  archived,
  updateSessionMetadata,
} = vi.hoisted(() => {
  const makeSessions = () => {
    const state = {
      sessions: [] as DaemonSessionSummary[],
      loading: false,
      error: null as Error | null,
      data: [] as DaemonSessionSummary[] | undefined,
      reload: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(true),
      archiveSession: vi.fn().mockResolvedValue(true),
      unarchiveSession: vi.fn().mockResolvedValue(true),
      exportSession: vi.fn(),
    };
    state.data = state.sessions;
    return state;
  };
  const workspaceClient = {
    listWorkspaceSessions: vi.fn().mockResolvedValue([]),
    listSessionGroups: vi.fn().mockResolvedValue({
      groups: [],
      colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
    }),
    updateSessionMetadata: vi.fn().mockResolvedValue({}),
  };
  const workspaceActions = {
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
    listSessionGroups: vi.fn().mockResolvedValue({
      groups: [],
      colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
    }),
    createSessionGroup: vi.fn(),
    updateSessionGroup: vi.fn(),
    deleteSessionGroup: vi.fn(),
    updateSessionOrganization: vi.fn(),
  };
  return {
    connection: {
      status: 'connected',
      sessionId: null as string | null,
      workspaceCwd: '/tmp/project',
      capabilities: undefined as
        | { qwenCodeVersion: string; features: string[] }
        | undefined,
    },
    workspace: {
      capabilities: undefined as
        | { qwenCodeVersion: string; features: string[] }
        | undefined,
      client: {
        // Default no content-search hits; search tests override per test.
        searchWorkspaceSessions: vi.fn().mockResolvedValue({ results: [] }),
        workspaceByCwd: vi.fn(() => workspaceClient),
        updateSessionMetadata: workspaceClient.updateSessionMetadata,
      },
      refreshCapabilities: vi.fn(),
    },
    workspaceClient,
    workspaceActions,
    active: makeSessions(),
    pinned: makeSessions(),
    archived: makeSessions(),
    updateSessionMetadata: workspaceClient.updateSessionMetadata,
  };
});
const refreshSessionCatalogQueries = vi.hoisted(() => vi.fn());
const useSessionCatalogQueries = vi.hoisted(() => vi.fn(() => []));
const loadSession = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DAEMON_APPROVAL_MODES: ['default', 'plan', 'auto-edit', 'auto', 'yolo'],
  useConnection: () => connection,
  useActions: () => ({ renameSession: vi.fn() }),
  useWorkspace: () => workspace,
  useWorkspaceActions: () => workspaceActions,
  useChannels: () => ({ data: undefined, catalog: [], channels: {} }),
  useSessions: (options?: { archiveState?: string; group?: string }) => {
    if (options?.archiveState === 'archived') return archived;
    if (options?.group === 'pinned') return pinned;
    return active;
  },
}));

vi.mock('../../session-catalog/session-catalog-hooks', () => ({
  useWebShellSessions: (options?: {
    enabled?: boolean;
    archiveState?: string;
    group?: string;
  }) => {
    const state =
      options?.archiveState === 'archived'
        ? archived
        : options?.group === 'pinned'
          ? pinned
          : active;
    const catalogQuery = {
      routeKind: 'legacy',
      workspaceCwd: connection.workspaceCwd,
      options,
    };
    return resolveWebShellSessions(
      state,
      options?.enabled !== false,
      catalogQuery,
    );
  },
  useSessionCatalogController: () => ({
    refreshQueries: refreshSessionCatalogQueries,
    invalidateWorkspace: vi.fn(),
    refreshWorkspace: vi.fn(),
    renamed: vi.fn(),
    toggleSessionPinned: vi.fn(),
  }),
  useSessionCatalogPolling: () => undefined,
  useSessionCatalogQuery: (
    client: typeof workspace.client,
    query: { workspaceCwd: string; options?: Record<string, unknown> },
    options: { autoLoad?: boolean; enabled?: boolean },
  ) => {
    const [snapshot, setSnapshot] = React.useState({
      sessions: [] as DaemonSessionSummary[],
      loading: false,
      error: undefined as Error | undefined,
    });
    const reload = React.useCallback(async () => {
      const sessions = await client
        .workspaceByCwd(query.workspaceCwd)
        .listWorkspaceSessions(query.options);
      setSnapshot({ sessions, loading: false, error: undefined });
      return { sessions };
    }, [client, query.options, query.workspaceCwd]);
    React.useEffect(() => {
      if (options.enabled === false || !options.autoLoad) return;
      void reload().catch((error: Error) => {
        setSnapshot((current) => ({ ...current, loading: false, error }));
      });
    }, [options.autoLoad, options.enabled, reload]);
    return { ...snapshot, reload };
  },
  useSessionCatalogQueries,
}));

const { I18nProvider } = await import('../../i18n');
const { WebShellSidebar } = await import('./WebShellSidebar');

installSidebarDomShims();

const renameCapabilities = {
  qwenCodeVersion: '1.2.3',
  features: ['workspace_session_metadata'],
};

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

function findTitle(displayName: string): HTMLElement {
  const titles = Array.from(
    container.querySelectorAll('[data-web-shell-session-title]'),
  ).filter((node) => node.textContent === displayName);
  expect(titles.length).toBeGreaterThan(0);
  return titles[0];
}

function findTitleLabel(displayName: string): HTMLElement {
  // The rename handler sits on the inner label span; the outer
  // [data-web-shell-session-title] span is the container that also holds
  // the search snippet, so a user's click on the title targets the first
  // element child.
  const label = findTitle(displayName).firstElementChild;
  expect(label).not.toBeNull();
  return label as HTMLElement;
}

function findRow(displayName: string): HTMLElement {
  return findTitle(displayName).closest('[role="button"]') as HTMLElement;
}

function renameInput(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(
    'input[aria-label^="Rename:"]',
  );
}

function setRenameValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  connection.sessionId = null;
  connection.workspaceCwd = '/tmp/project';
  connection.capabilities = renameCapabilities;
  workspace.capabilities = renameCapabilities;
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
  workspaceClient.listWorkspaceSessions.mockReset();
  workspaceClient.listWorkspaceSessions.mockResolvedValue([]);
  workspaceClient.updateSessionMetadata.mockReset();
  workspaceClient.updateSessionMetadata.mockResolvedValue({});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  // The jsdom document outlives the test: drop any text selection so a
  // selection-guard case cannot leak into the next one.
  window.getSelection()?.removeAllRanges();
});

describe('WebShellSidebar session title single-click rename (issue #14327)', () => {
  it('opens the inline rename form on a single click of the title, prefilled', async () => {
    active.sessions = [makeSession('s1', { displayName: 'First session' })];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    await act(async () => {
      click(findTitleLabel('First session'));
    });

    const input = renameInput();
    expect(input).not.toBeNull();
    expect(input?.value).toBe('First session');
    expect(loadSession).not.toHaveBeenCalled();
  });

  it('saves the typed name on form submit', async () => {
    active.sessions = [makeSession('s1', { displayName: 'First session' })];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    await act(async () => {
      click(findTitleLabel('First session'));
    });
    const input = renameInput();
    expect(input).not.toBeNull();
    await act(async () => {
      setRenameValue(input as HTMLInputElement, 'Renamed by click');
    });
    await act(async () => {
      (input as HTMLInputElement)
        .closest('form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });
    await flushSidebar();

    expect(updateSessionMetadata).toHaveBeenCalledWith('s1', {
      displayName: 'Renamed by click',
    });
    expect(renameInput()).toBeNull();
    expect(loadSession).not.toHaveBeenCalled();
  });

  it('cancels with Escape without saving or opening', async () => {
    active.sessions = [makeSession('s1', { displayName: 'First session' })];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    await act(async () => {
      click(findTitleLabel('First session'));
    });
    const input = renameInput();
    expect(input).not.toBeNull();
    await act(async () => {
      (input as HTMLInputElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(renameInput()).toBeNull();
    expect(updateSessionMetadata).not.toHaveBeenCalled();
    expect(loadSession).not.toHaveBeenCalled();
  });

  it('still opens rename on a double click of the title', async () => {
    active.sessions = [makeSession('s1', { displayName: 'First session' })];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    // First click of the pair already mounts the form; the second click
    // lands on the form input, which keeps the row's open handler out.
    await act(async () => {
      click(findTitleLabel('First session'));
    });
    const input = renameInput();
    expect(input).not.toBeNull();
    await act(async () => {
      (input as HTMLInputElement).dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      );
    });

    expect(renameInput()).not.toBeNull();
    expect(input?.value).toBe('First session');
    expect(loadSession).not.toHaveBeenCalled();
  });

  it('still opens rename on a double click of the row outside the title', async () => {
    active.sessions = [makeSession('s1', { displayName: 'First session' })];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    const row = findRow('First session');
    await act(async () => {
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    expect(renameInput()).not.toBeNull();
    expect(loadSession).not.toHaveBeenCalled();
  });

  it('opens the session on a single click of the row outside the title', async () => {
    active.sessions = [makeSession('s1', { displayName: 'First session' })];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    const row = findRow('First session');
    await act(async () => {
      click(row);
    });

    expect(loadSession).toHaveBeenCalledWith('s1', '/tmp/project');
    expect(renameInput()).toBeNull();
  });

  it('opens the session on Enter with the row focused', async () => {
    active.sessions = [makeSession('s1', { displayName: 'First session' })];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    const row = findRow('First session');
    await act(async () => {
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(loadSession).toHaveBeenCalledWith('s1', '/tmp/project');
    expect(renameInput()).toBeNull();
  });

  it('falls through to open when the session cannot be renamed', async () => {
    connection.capabilities = { qwenCodeVersion: '1.2.3', features: [] };
    workspace.capabilities = { qwenCodeVersion: '1.2.3', features: [] };
    active.sessions = [makeSession('s1', { displayName: 'First session' })];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    await act(async () => {
      click(findTitle('First session'));
    });

    expect(loadSession).toHaveBeenCalledWith('s1', '/tmp/project');
    expect(renameInput()).toBeNull();
  });

  it('opens the session on a single click of the title container blank area', async () => {
    active.sessions = [makeSession('s1', { displayName: 'First session' })];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    // The outer [data-web-shell-session-title] span is the flex container;
    // beside a short label the click lands on its blank remainder, so it
    // must open the session, not rename.
    await act(async () => {
      click(findTitle('First session'));
    });

    expect(loadSession).toHaveBeenCalledWith('s1', '/tmp/project');
    expect(renameInput()).toBeNull();
  });

  it('opens the session on a single click of the content-search snippet', async () => {
    const hit = makeSession('s1', { displayName: 'First session' });
    active.sessions = [hit];
    active.data = active.sessions;
    workspace.client.searchWorkspaceSessions.mockResolvedValue({
      results: [{ session: hit, snippet: 'the matched line' }],
    });
    renderSidebar();
    await flushSidebar();

    // A content-search hit renders its matched-message excerpt inside the
    // title container; clicking the excerpt must open the found session.
    const searchToggle = container.querySelector(
      'button[aria-label="Search sessions"]',
    ) as HTMLButtonElement;
    await act(async () => {
      click(searchToggle);
    });
    const searchBox = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search sessions"]',
    );
    expect(searchBox).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(searchBox as HTMLInputElement, 'zzz');
      (searchBox as HTMLInputElement).dispatchEvent(
        new Event('input', { bubbles: true }),
      );
    });
    // useSessionContentSearch debounces the daemon call by 300ms.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await flushSidebar();

    const snippet = container.querySelector(
      '[class*="sessionSearchSnippet"]',
    ) as HTMLElement;
    expect(snippet).not.toBeNull();
    await act(async () => {
      click(snippet);
    });

    expect(loadSession).toHaveBeenCalledWith('s1', '/tmp/project');
    expect(renameInput()).toBeNull();
  });

  it('keeps the selection and opens the session when a text selection is active', async () => {
    active.sessions = [makeSession('s1', { displayName: 'First session' })];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    // A drag that ends on the title leaves a live selection; the same
    // guard SessionOverviewPanel's row click uses keeps that click out of
    // rename and lets the row's open handler take it.
    const label = findTitleLabel('First session');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(label);
    selection?.removeAllRanges();
    selection?.addRange(range);
    await act(async () => {
      click(label);
    });

    expect(loadSession).toHaveBeenCalledWith('s1', '/tmp/project');
    expect(renameInput()).toBeNull();
  });
});
