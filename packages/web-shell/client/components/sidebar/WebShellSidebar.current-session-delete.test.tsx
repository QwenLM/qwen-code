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
          searchWorkspaceSessions: vi.fn().mockResolvedValue({ results: [] }),
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

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
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

let root: Root;
let container: HTMLDivElement;

function renderSidebar(
  props: {
    onError?: (error: unknown, message?: string) => void;
    onSessionsDeleted?: (sessionIds: string[]) => void;
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
          onError={onError}
          onSessionsDeleted={props.onSessionsDeleted}
          // Surface delete as an inline hover button so the row's disabled
          // state is directly assertable without opening the dropdown.
          sessionActions={{ inlineItems: ['delete'] }}
        />
      </I18nProvider>,
    );
  });
}

function findSessionDeleteButton(displayName: string): HTMLButtonElement {
  const titles = Array.from(
    container.querySelectorAll('[data-web-shell-session-title]'),
  ).filter((node) => node.textContent === displayName);
  expect(titles.length).toBeGreaterThan(0);
  for (const title of titles) {
    let node: HTMLElement | null = title as HTMLElement;
    while (node) {
      const button = node.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete"]',
      );
      if (button) return button;
      node = node.parentElement;
    }
  }
  throw new Error(`No delete button found for ${displayName}`);
}

// The delete confirmation renders through a radix portal (document.body when
// no WebShellPortalRoot provider is mounted), not inside the sidebar root.
function confirmDeleteButton(): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent === 'Delete',
  );
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  connection.sessionId = null;
  connection.workspaceCwd = '/tmp/project';
  connection.capabilities = undefined;
  workspace.capabilities = undefined;
  active.sessions = [];
  active.data = active.sessions;
  active.deleteSession.mockClear();
  active.deleteSession.mockResolvedValue(true);
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
});

describe('WebShellSidebar current-session delete (issue #12619)', () => {
  it('deletes the current session from the sidebar row when it is idle', async () => {
    active.sessions = [
      makeSession('session-current', { displayName: 'Current session' }),
      makeSession('session-other', { displayName: 'Other session' }),
    ];
    active.data = active.sessions;
    connection.sessionId = 'session-current';
    const onSessionsDeleted = vi.fn();

    renderSidebar({ onSessionsDeleted });
    await flushSidebar();

    const deleteButton = findSessionDeleteButton('Current session');
    expect(deleteButton.disabled).toBe(false);
    // No "current session cannot be deleted" tooltip anymore.
    expect(deleteButton.title).toBe('Delete');

    act(() => click(deleteButton));
    await flushSidebar();

    const confirm = confirmDeleteButton();
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(active.deleteSession).toHaveBeenCalledWith('session-current');
    // The row is the attached one, so the sidebar reports the id it captured
    // at confirm time: the daemon's terminal `session_closed` frame clears the
    // attachment before the delete response resolves (#12619).
    expect(onSessionsDeleted).toHaveBeenCalledWith(['session-current'], {
      attachedSessionId: 'session-current',
    });
  });

  it('disables delete for the current session while it is running', async () => {
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

    expect(findSessionDeleteButton('Current session').disabled).toBe(true);
  });

  it('still deletes a non-current session unchanged', async () => {
    active.sessions = [
      makeSession('session-current', { displayName: 'Current session' }),
      makeSession('session-other', { displayName: 'Other session' }),
    ];
    active.data = active.sessions;
    connection.sessionId = 'session-current';
    const onSessionsDeleted = vi.fn();

    renderSidebar({ onSessionsDeleted });
    await flushSidebar();

    const deleteButton = findSessionDeleteButton('Other session');
    expect(deleteButton.disabled).toBe(false);

    act(() => click(deleteButton));
    await flushSidebar();

    const confirm = confirmDeleteButton();
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(active.deleteSession).toHaveBeenCalledWith('session-other');
    expect(onSessionsDeleted).toHaveBeenCalledWith(['session-other'], {
      attachedSessionId: undefined,
    });
  });
});
