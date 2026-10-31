/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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

const { connection, workspace, workspaceActions, active, pinned, archived } =
  vi.hoisted(() => {
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
    return {
      connection: {
        status: 'connected',
        sessionId: null as string | null,
        loadingTranscript: false,
        catchingUp: false,
        error: undefined as Error | undefined,
        workspaceCwd: '/tmp/project',
        sessionContext: undefined as { kind: 'standalone' } | undefined,
        capabilities: undefined as
          | { qwenCodeVersion: string; features: string[] }
          | undefined,
      },
      workspace: {
        capabilities: undefined as
          | { qwenCodeVersion: string; features: string[] }
          | undefined,
        client: {
          searchWorkspaceSessions: vi.fn().mockResolvedValue({ results: [] }),
          listWorkspaceSessionsPage: vi
            .fn()
            .mockResolvedValue({ sessions: [] }),
          listStandaloneSessionsPage: vi
            .fn()
            .mockResolvedValue({ sessions: [] }),
          archiveStandaloneSessions: vi.fn().mockResolvedValue({
            archived: [],
            alreadyArchived: [],
            errors: [],
          }),
          workspaceByCwd: vi.fn(() => ({
            listWorkspaceSessions: vi.fn().mockResolvedValue([]),
            listSessionGroups: vi.fn().mockResolvedValue({
              groups: [],
              colorOptions: [
                'red',
                'orange',
                'yellow',
                'green',
                'blue',
                'purple',
              ],
            }),
          })),
        },
        refreshCapabilities: vi.fn(),
      },
      workspaceActions: {
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
      },
      active: makeSessions(),
      pinned: makeSessions(),
      archived: makeSessions(),
    };
  });
const refreshSessionCatalogQueries = vi.hoisted(() => vi.fn());
const useSessionCatalogQueries = vi.hoisted(() => vi.fn(() => []));
const loadSession = vi.hoisted(() => vi.fn());
const loadStandaloneSession = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DAEMON_APPROVAL_MODES: ['default', 'plan', 'auto-edit', 'auto', 'yolo'],
  useConnection: () => connection,
  useActions: () => ({ renameSession: vi.fn() }),
  useWorkspace: () => workspace,
  useWorkspaceActions: () => workspaceActions,
  useStreamingState: () => 'idle',
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

let root: Root;
let container: HTMLDivElement;

function renderSidebar(
  props: {
    onError?: (error: unknown, message?: string) => void;
    onSessionsDeleted?: (
      sessionIds: string[],
      meta?: { attachedSessionId?: string },
    ) => void;
    currentSessionActive?: boolean;
  } = {},
): void {
  const onError = props.onError ?? (() => {});
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
          onLoadStandaloneSession={loadStandaloneSession}
          onStandaloneNotice={() => {}}
          onError={onError}
          onSessionsDeleted={props.onSessionsDeleted}
          currentSessionActive={props.currentSessionActive}
        />
      </I18nProvider>,
    );
  });
}

function sessionRow(displayName: string, withSelector?: string): HTMLElement {
  const titles = Array.from(
    container.querySelectorAll('[data-web-shell-session-title]'),
  ).filter((node) => node.textContent === displayName);
  expect(titles.length).toBeGreaterThan(0);
  for (const title of titles) {
    const row = (title as HTMLElement).closest('[role="button"]');
    if (row && (!withSelector || row.querySelector(withSelector))) {
      return row as HTMLElement;
    }
  }
  throw new Error(
    `No row for ${displayName} with ${withSelector ?? 'any selector'}`,
  );
}

function openSessionMenu(displayName: string): HTMLElement {
  const moreActions = sessionRow(displayName).querySelector<HTMLButtonElement>(
    'button[aria-label="More actions"]',
  );
  expect(moreActions).not.toBeNull();
  act(() => {
    moreActions!.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
    );
  });
  const item = Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((node) => node.textContent?.trim() === 'Archive');
  expect(item).toBeDefined();
  return item!;
}

async function expandRecentSessions(): Promise<void> {
  const section = document.querySelector(
    'section[aria-label="Recent sessions"]',
  );
  expect(section).not.toBeNull();
  const toggle = section!.querySelector<HTMLButtonElement>(
    'button[aria-expanded]',
  );
  expect(toggle).not.toBeNull();
  // The section defaults to expanded; only click the toggle when collapsed.
  if (toggle!.getAttribute('aria-expanded') === 'false') {
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }
  // The page fetches settle across several microtask batches; give them a
  // real timer inside act so the rows render before the assertions.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  connection.sessionId = null;
  connection.workspaceCwd = '/tmp/project';
  connection.sessionContext = undefined;
  connection.error = undefined;
  connection.capabilities = {
    qwenCodeVersion: '1.2.3',
    features: [
      'session_archive',
      'session_archive_idle_guard',
      'workspace_qualified_rest_core',
    ],
  };
  workspace.capabilities = {
    qwenCodeVersion: '1.2.3',
    features: ['standalone_sessions_v1'],
  };
  active.sessions = [];
  active.data = active.sessions;
  active.archiveSession.mockClear();
  active.archiveSession.mockResolvedValue(true);
  pinned.sessions = [];
  pinned.data = pinned.sessions;
  archived.sessions = [];
  archived.data = archived.sessions;
  workspace.client.listWorkspaceSessionsPage.mockClear();
  workspace.client.listWorkspaceSessionsPage.mockResolvedValue({
    sessions: [],
  });
  workspace.client.listStandaloneSessionsPage.mockClear();
  workspace.client.listStandaloneSessionsPage.mockResolvedValue({
    sessions: [],
  });
  workspace.client.archiveStandaloneSessions.mockClear();
  workspace.client.archiveStandaloneSessions.mockResolvedValue({
    archived: [],
    alreadyArchived: [],
    errors: [],
  });
  refreshSessionCatalogQueries.mockReset();
  useSessionCatalogQueries.mockReset();
  useSessionCatalogQueries.mockReturnValue([]);
  loadSession.mockReset();
  loadStandaloneSession.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
});

describe('WebShellSidebar current-session archive (issue #15480)', () => {
  it('archives the idle current session from the row menu and reports the attached id', async () => {
    active.sessions = [
      makeSession('session-current', { displayName: 'Current session' }),
      makeSession('session-other', { displayName: 'Other session' }),
    ];
    active.data = active.sessions;
    connection.sessionId = 'session-current';
    const onSessionsDeleted = vi.fn();

    renderSidebar({ onSessionsDeleted });
    await flushSidebar();

    const archiveItem = openSessionMenu('Current session');
    expect(archiveItem.hasAttribute('data-disabled')).toBe(false);
    await act(async () => {
      click(archiveItem);
    });

    expect(active.archiveSession).toHaveBeenCalledWith('session-current', {
      requireIdle: true,
    });
    // The row is the attached one, so the sidebar reports the id it captured
    // before the request: the daemon's terminal `session_closed` frame clears
    // the attachment before the archive resolves (#15480).
    expect(onSessionsDeleted).toHaveBeenCalledWith(['session-current'], {
      attachedSessionId: 'session-current',
    });
  });

  it('disables archive for the current session while it is running', async () => {
    active.sessions = [
      makeSession('session-current', {
        displayName: 'Current session',
        hasActivePrompt: true,
      }),
    ];
    active.data = active.sessions;
    connection.sessionId = 'session-current';

    renderSidebar();
    await flushSidebar();

    const archiveItem = openSessionMenu('Current session');
    expect(archiveItem.hasAttribute('data-disabled')).toBe(true);
    await act(async () => {
      click(archiveItem);
    });
    expect(active.archiveSession).not.toHaveBeenCalled();
  });

  it('keeps archive disabled for the current session when the daemon cannot guard idleness', async () => {
    // A daemon without `session_archive_idle_guard` ignores `requireIdle`, so
    // letting the current session through would close it under running work.
    connection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_archive', 'workspace_qualified_rest_core'],
    };
    active.sessions = [
      makeSession('session-current', { displayName: 'Current session' }),
    ];
    active.data = active.sessions;
    connection.sessionId = 'session-current';

    renderSidebar();
    await flushSidebar();

    const archiveItem = openSessionMenu('Current session');
    expect(archiveItem.hasAttribute('data-disabled')).toBe(true);
    await act(async () => {
      click(archiveItem);
    });
    expect(active.archiveSession).not.toHaveBeenCalled();
  });

  it('still archives a non-current session without routing the landing', async () => {
    active.sessions = [
      makeSession('session-current', { displayName: 'Current session' }),
      makeSession('session-other', { displayName: 'Other session' }),
    ];
    active.data = active.sessions;
    connection.sessionId = 'session-current';
    const onSessionsDeleted = vi.fn();

    renderSidebar({ onSessionsDeleted });
    await flushSidebar();

    const archiveItem = openSessionMenu('Other session');
    expect(archiveItem.hasAttribute('data-disabled')).toBe(false);
    await act(async () => {
      click(archiveItem);
    });

    expect(active.archiveSession).toHaveBeenCalledWith('session-other', {
      requireIdle: true,
    });
    // Only the attached session routes the post-archive landing (#15480).
    expect(onSessionsDeleted).not.toHaveBeenCalled();
  });

  it('keeps archive disabled for the attached standalone session', async () => {
    connection.sessionId = 'session-current';
    connection.sessionContext = { kind: 'standalone' };
    workspace.client.listStandaloneSessionsPage.mockResolvedValue({
      sessions: [makeSession('session-current', { displayName: 'Standalone' })],
    });
    const onSessionsDeleted = vi.fn();

    renderSidebar({ onSessionsDeleted });
    await expandRecentSessions();

    const row = sessionRow('Standalone', 'button[aria-label="Archive"]');
    const archiveButton = row.querySelector<HTMLButtonElement>(
      'button[aria-label="Archive"]',
    );
    expect(archiveButton).not.toBeNull();
    // A standalone archive closes the bridge session with
    // `requireZeroAttaches`, and the daemon refuses that while this tab is
    // attached, so the button stays off for the session being viewed.
    expect(archiveButton!.disabled).toBe(true);

    await act(async () => {
      archiveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(workspace.client.archiveStandaloneSessions).not.toHaveBeenCalled();
    expect(onSessionsDeleted).not.toHaveBeenCalled();
  });

  it('archives a non-current standalone recent row', async () => {
    connection.sessionId = 'session-current';
    connection.sessionContext = { kind: 'standalone' };
    workspace.client.listStandaloneSessionsPage.mockResolvedValue({
      sessions: [
        makeSession('session-current', { displayName: 'Standalone' }),
        makeSession('session-other', { displayName: 'Other standalone' }),
      ],
    });
    workspace.client.archiveStandaloneSessions.mockResolvedValue({
      archived: ['session-other'],
      alreadyArchived: [],
      errors: [],
    });
    const onSessionsDeleted = vi.fn();

    renderSidebar({ onSessionsDeleted });
    await expandRecentSessions();

    const row = sessionRow('Other standalone', 'button[aria-label="Archive"]');
    const archiveButton = row.querySelector<HTMLButtonElement>(
      'button[aria-label="Archive"]',
    );
    expect(archiveButton).not.toBeNull();
    expect(archiveButton!.disabled).toBe(false);

    await act(async () => {
      archiveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(workspace.client.archiveStandaloneSessions).toHaveBeenCalledWith([
      'session-other',
    ]);
    expect(onSessionsDeleted).not.toHaveBeenCalled();
  });
});
