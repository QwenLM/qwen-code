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
  McpAppGeneratedUiOwnerContext,
  type McpAppGeneratedUiOwner,
} from '../../mcpAppHostContext';
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
          workspaceByCwd: vi.fn((_cwd: string) => ({
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

const standaloneArchiveFailure = vi.hoisted(() => ({ current: false }));
vi.mock('./StandaloneRecents', () => ({
  StandaloneRecents: ({
    archiveState,
    onStatusChange,
  }: {
    archiveState?: string;
    onStatusChange?: (status: {
      count: number;
      loading: boolean;
      error: boolean;
    }) => void;
  }) => {
    React.useEffect(() => {
      onStatusChange?.({
        count: 0,
        loading: false,
        error: archiveState === 'archived' && standaloneArchiveFailure.current,
      });
    }, [archiveState, onStatusChange]);
    return archiveState === 'archived' ? (
      <span data-testid="standalone-archive">Standalone archive</span>
    ) : null;
  },
}));

const { I18nProvider } = await import('../../i18n');
const { WebShellSidebar } = await import('./WebShellSidebar');

installSidebarDomShims();

let root: Root;
let container: HTMLDivElement;
let archivedSessionsTarget: HTMLDivElement;
let generatedUiOwner: McpAppGeneratedUiOwner | undefined;
const defaultWorkspaceByCwd =
  workspace.client.workspaceByCwd.getMockImplementation()!;

function renderSidebar(
  props: {
    onError?: (error: unknown, message?: string) => void;
    onSessionsDeleted?: (sessionIds: string[]) => void;
    currentSessionActive?: boolean;
    managedWorkspaces?: React.ReactNode;
    managedArchivedSessions?: React.ComponentProps<
      typeof WebShellSidebar
    >['managedArchivedSessions'];
    archivedSessionsTarget?: HTMLElement | null;
    onSearchQueryChange?: (query: string) => void;
    onLoadStandaloneSession?: (sessionId: string) => void;
    onStandaloneNotice?: (message: string) => void;
    onCommit?: () => void;
    lockedWorkspaceCwd?: string;
    workspaces?: React.ComponentProps<typeof WebShellSidebar>['workspaces'];
  } = {},
): void {
  const onError = props.onError ?? (() => {});
  act(() => {
    root.render(
      <React.Profiler id="sidebar" onRender={() => props.onCommit?.()}>
        <I18nProvider language="en">
          <McpAppGeneratedUiOwnerContext.Provider value={generatedUiOwner}>
            <WebShellSidebar
              archivedSessionsTarget={props.archivedSessionsTarget}
              collapsed={false}
              onCollapsedChange={() => {}}
              onOpenSettings={() => {}}
              onOpenDaemonStatus={() => {}}
              onOpenScheduledTasks={() => {}}
              onOpenGoals={() => {}}
              onOpenSessions={() => {}}
              onOpenSplitView={() => {}}
              onNewSession={() => false}
              onLeaveCurrentStandaloneForDelete={async () => false}
              onLoadSession={loadSession}
              onError={onError}
              onSessionsDeleted={props.onSessionsDeleted}
              currentSessionActive={props.currentSessionActive}
              managedWorkspaces={props.managedWorkspaces}
              managedArchivedSessions={props.managedArchivedSessions}
              onSearchQueryChange={props.onSearchQueryChange}
              onLoadStandaloneSession={props.onLoadStandaloneSession}
              onStandaloneNotice={props.onStandaloneNotice}
              lockedWorkspaceCwd={props.lockedWorkspaceCwd}
              workspaces={props.workspaces}
              // Surface delete as an inline hover button so the row's disabled
              // state is directly assertable without opening the dropdown.
              sessionActions={{ inlineItems: ['delete'] }}
            />
          </McpAppGeneratedUiOwnerContext.Provider>
        </I18nProvider>
      </React.Profiler>,
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

function deletionOwner(
  captureSessionDeletion: McpAppGeneratedUiOwner['captureSessionDeletion'],
): McpAppGeneratedUiOwner {
  return {
    scopeId: 'sidebar-owner',
    workspaceCwd: '/tmp/project',
    subscribeInvalidation: () => () => {},
    invalidate: vi.fn(),
    captureSessionDeletion,
  };
}

function secondaryDeletion(locked: boolean) {
  connection.capabilities = {
    qwenCodeVersion: '1.2.3',
    features: ['multi_workspace_sessions', 'workspace_qualified_rest_core'],
  };
  workspace.capabilities = connection.capabilities;
  active.sessions = [makeSession('same', { displayName: 'Primary same ID' })];
  active.data = active.sessions;
  const secondary = makeSession('same', {
    workspaceCwd: '/tmp/other',
    displayName: 'Secondary same ID',
  });
  const deleteSessionsData = vi.fn().mockResolvedValue({
    removed: ['same'],
    notFound: [],
    errors: [],
  });
  workspace.client.workspaceByCwd.mockImplementation((cwd: string) => ({
    ...defaultWorkspaceByCwd(cwd),
    listWorkspaceSessions: vi.fn().mockResolvedValue([secondary]),
    deleteSessionsData,
  }));
  return {
    deleteSessionsData,
    props: {
      lockedWorkspaceCwd: locked ? '/tmp/other' : undefined,
      workspaces: [
        { id: 'primary', cwd: '/tmp/project', primary: true, trusted: true },
        { id: 'secondary', cwd: '/tmp/other', primary: false, trusted: true },
      ],
    },
  };
}

async function expandSecondaryWorkspace(): Promise<void> {
  await flushSidebar();
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
  ).find((candidate) => candidate.textContent?.includes('other'));
  expect(button).toBeDefined();
  if (button!.getAttribute('aria-expanded') !== 'true') {
    act(() => click(button!));
  }
  await flushSidebar();
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container.appendChild(document.createElement('div')));
  archivedSessionsTarget = container.appendChild(document.createElement('div'));
  connection.sessionId = null;
  connection.workspaceCwd = '/tmp/project';
  connection.capabilities = undefined;
  workspace.capabilities = undefined;
  workspace.client.workspaceByCwd
    .mockReset()
    .mockImplementation(defaultWorkspaceByCwd);
  generatedUiOwner = undefined;
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

it('excludes standalone archives and their errors from the Channels archive filter', async () => {
  connection.capabilities = {
    qwenCodeVersion: '1.2.3',
    features: ['session_source_metadata'],
  };
  workspace.capabilities = {
    qwenCodeVersion: '1.2.3',
    features: ['standalone_sessions_v1'],
  };
  standaloneArchiveFailure.current = true;
  renderSidebar({
    archivedSessionsTarget,
    onLoadStandaloneSession: vi.fn(),
    onStandaloneNotice: vi.fn(),
  });
  await flushSidebar();
  expect(
    archivedSessionsTarget.querySelector('[data-testid="standalone-archive"]'),
  ).not.toBeNull();
  expect(archivedSessionsTarget.textContent).toContain('Failed to load');
  const channels = Array.from(
    archivedSessionsTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).find((tab) => tab.textContent?.trim() === 'Channels')!;
  await act(async () => {
    channels.focus();
    channels.click();
  });
  expect(
    archivedSessionsTarget.querySelector('[data-testid="standalone-archive"]'),
  ).toBeNull();
  expect(archivedSessionsTarget.textContent).not.toContain('Failed to load');
  expect(archivedSessionsTarget.textContent).toContain('No archived sessions.');
  standaloneArchiveFailure.current = false;
  const commits: string[] = [];
  renderSidebar({
    archivedSessionsTarget,
    onLoadStandaloneSession: vi.fn(),
    onStandaloneNotice: vi.fn(),
    onCommit: () => commits.push(archivedSessionsTarget.textContent ?? ''),
  });
  commits.length = 0;
  const tasks = Array.from(
    archivedSessionsTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).find((tab) => tab.textContent?.trim() === 'Tasks')!;
  await act(async () => {
    tasks.focus();
    tasks.click();
  });
  expect(commits[0]).not.toContain('Failed to load');
});

it('clears a previous standalone archive error before the next visit commits', async () => {
  workspace.capabilities = {
    qwenCodeVersion: '1.2.3',
    features: ['standalone_sessions_v1'],
  };
  const standaloneProps = {
    onLoadStandaloneSession: vi.fn(),
    onStandaloneNotice: vi.fn(),
  };
  standaloneArchiveFailure.current = true;
  renderSidebar({ ...standaloneProps, archivedSessionsTarget });
  await flushSidebar();
  expect(archivedSessionsTarget.textContent).toContain('Failed to load');
  renderSidebar(standaloneProps);
  standaloneArchiveFailure.current = false;
  const commits: string[] = [];
  renderSidebar({
    ...standaloneProps,
    archivedSessionsTarget,
    onCommit: () => commits.push(archivedSessionsTarget.textContent ?? ''),
  });
  expect(commits.length).toBeGreaterThan(0);
  expect(commits[0]).not.toContain('Failed to load');
});

describe('WebShellSidebar current-session delete (issue #12619)', () => {
  it('renders Managed and Local archives only in the settings target', async () => {
    connection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_archive'],
    };
    archived.sessions = [
      makeSession('local-archive', { displayName: 'Local archive' }),
    ];
    archived.data = archived.sessions;
    renderSidebar({
      managedWorkspaces: <div>Managed workspace</div>,
      managedArchivedSessions: {
        content: <div data-managed-archive>Managed archive</div>,
        count: 1,
        loading: false,
        error: false,
      },
    });
    await flushSidebar();
    expect(container.querySelector('[data-managed-archive]')).toBeNull();
    const archiveProps = {
      archivedSessionsTarget,
      managedWorkspaces: <div>Managed workspace</div>,
      managedArchivedSessions: {
        content: <div data-managed-archive>Managed archive</div>,
        count: 1,
        loading: false,
        error: false,
      },
    };
    renderSidebar(archiveProps);
    await flushSidebar();
    expect(archivedSessionsTarget.textContent).toContain('Managed archive');
    expect(archivedSessionsTarget.textContent).toContain('Local archive');
    expect(container.textContent).toContain('Managed workspace');
    renderSidebar({ ...archiveProps, archivedSessionsTarget: null });
    await flushSidebar();
    expect(archivedSessionsTarget.textContent).toBe('');
  });

  it('keeps New task plain and labels daemon workspaces when Managed is available', async () => {
    renderSidebar({
      currentSessionActive: false,
      managedWorkspaces: <div>Managed workspace</div>,
    });
    await flushSidebar();
    const newTask = container.querySelector<HTMLButtonElement>(
      'button[aria-label="New session"]',
    )!;
    expect(newTask.textContent).toBe('New session');
    expect(
      [...container.querySelectorAll('button')].some(
        (item) =>
          item.textContent?.includes('project') &&
          item.textContent.includes('Local'),
      ),
    ).toBe(true);
    renderSidebar({
      currentSessionActive: true,
      managedWorkspaces: <div>Managed workspace</div>,
    });
    await flushSidebar();
    expect(newTask.textContent).toBe('New session');
  });
  it('keeps Local history beside Managed workspace content without selecting the hidden Local conversation', async () => {
    active.sessions = [
      makeSession('session-current', { displayName: 'Current session' }),
    ];
    active.data = active.sessions;
    connection.sessionId = 'session-current';
    renderSidebar({
      currentSessionActive: false,
      managedWorkspaces: <div data-managed-workspaces>Managed workspace</div>,
    });
    await flushSidebar();
    expect(
      container.querySelector('[data-managed-workspaces]')?.textContent,
    ).toBe('Managed workspace');
    expect(
      container.querySelector('[data-web-shell-session-title]')?.textContent,
    ).toBe('Current session');
    const localRow = container
      .querySelector('[data-web-shell-session-title]')!
      .closest('[role="button"]')!;
    expect(localRow.getAttribute('aria-current')).toBeNull();
    renderSidebar({ currentSessionActive: true });
    await flushSidebar();
    expect(localRow.getAttribute('aria-current')).toBe('page');
  });

  it('keeps mutation ownership for a running Local session while Managed is selected', async () => {
    active.sessions = [
      makeSession('session-current', {
        displayName: 'Current session',
        hasActivePrompt: true,
      }),
    ];
    active.data = active.sessions;
    connection.sessionId = 'session-current';
    renderSidebar({ currentSessionActive: false });
    await flushSidebar();
    expect(findSessionDeleteButton('Current session').disabled).toBe(true);
    expect(active.deleteSession).not.toHaveBeenCalled();
  });

  it('shares the existing Projects search text with Managed navigation', async () => {
    const onSearchQueryChange = vi.fn();
    renderSidebar({
      managedWorkspaces: <div data-managed-workspaces />,
      onSearchQueryChange,
    });
    await flushSidebar();
    act(() =>
      click(
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="Search sessions"]',
        )!,
      ),
    );
    await flushSidebar();
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search sessions"]',
    )!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'Managed needle');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushSidebar();
    expect(onSearchQueryChange).toHaveBeenLastCalledWith('Managed needle');
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onSearchQueryChange).toHaveBeenLastCalledWith('');
  });

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

describe('WebShellSidebar Generated UI deletion cleanup', () => {
  it.each([
    { locked: false, outcome: 'removed' },
    { locked: false, outcome: 'notFound' },
    { locked: true, outcome: 'removed' },
    { locked: true, outcome: 'notFound' },
  ])(
    'cleans up a $outcome secondary session in its own workspace (locked: $locked)',
    async ({ locked, outcome }) => {
      const { deleteSessionsData, props } = secondaryDeletion(locked);
      deleteSessionsData.mockResolvedValue({
        removed: outcome === 'removed' ? ['same'] : [],
        notFound: outcome === 'notFound' ? ['same'] : [],
        errors: [],
      });
      const deleted = vi.fn();
      const capture = vi.fn(() => deleted);
      generatedUiOwner = deletionOwner(capture);
      const onSessionsDeleted = vi.fn();
      renderSidebar({ ...props, onSessionsDeleted });
      await expandSecondaryWorkspace();

      act(() => click(findSessionDeleteButton('Secondary same ID')));
      await flushSidebar();
      expect(capture).not.toHaveBeenCalled();
      act(() => click(confirmDeleteButton()!));
      await flushSidebar();

      expect(capture).toHaveBeenCalledExactlyOnceWith('/tmp/other');
      expect(capture.mock.invocationCallOrder[0]).toBeLessThan(
        deleteSessionsData.mock.invocationCallOrder[0]!,
      );
      expect(deleteSessionsData).toHaveBeenCalledExactlyOnceWith(['same']);
      expect(deleted).toHaveBeenCalledExactlyOnceWith(['same']);
      expect(active.deleteSession).not.toHaveBeenCalled();
      expect(onSessionsDeleted).toHaveBeenCalledWith(['same'], {
        attachedSessionId: undefined,
      });
      if (!locked) {
        expect(container.textContent).toContain('Primary same ID');
      }
    },
  );

  it.each([false, true])(
    'uses the captured owner when a delayed secondary delete finishes (locked: %s)',
    async (locked) => {
      const { deleteSessionsData, props } = secondaryDeletion(locked);
      const deleted = vi.fn();
      const capture = vi.fn(() => deleted);
      generatedUiOwner = deletionOwner(capture);
      const result = { removed: ['same'], notFound: [], errors: [] };
      let resolveDeletion!: (value: typeof result) => void;
      deleteSessionsData.mockReturnValue(
        new Promise<typeof result>((resolve) => {
          resolveDeletion = resolve;
        }),
      );
      renderSidebar(props);
      await expandSecondaryWorkspace();
      act(() => click(findSessionDeleteButton('Secondary same ID')));
      await flushSidebar();
      act(() => click(confirmDeleteButton()!));
      expect(capture).toHaveBeenCalledExactlyOnceWith('/tmp/other');
      expect(deleteSessionsData).toHaveBeenCalledExactlyOnceWith(['same']);
      expect(deleted).not.toHaveBeenCalled();

      const nextDeleted = vi.fn();
      const nextCapture = vi.fn(() => nextDeleted);
      generatedUiOwner = {
        ...deletionOwner(nextCapture),
        scopeId: 'replacement-owner',
        workspaceCwd: '/replacement',
      };
      renderSidebar(props);
      await act(async () => resolveDeletion(result));
      await flushSidebar();

      expect(deleted).toHaveBeenCalledExactlyOnceWith(['same']);
      expect(nextCapture).not.toHaveBeenCalled();
      expect(nextDeleted).not.toHaveBeenCalled();
    },
  );

  it.each([
    { locked: false, failure: 'item error' },
    { locked: false, failure: 'request rejection' },
    { locked: true, failure: 'item error' },
    { locked: true, failure: 'request rejection' },
  ])(
    'keeps retained secondary sessions after $failure (locked: $locked)',
    async ({ locked, failure }) => {
      const { deleteSessionsData, props } = secondaryDeletion(locked);
      if (failure === 'item error') {
        deleteSessionsData.mockResolvedValue({
          removed: [],
          notFound: [],
          errors: [{ sessionId: 'same', error: 'daemon denied delete' }],
        });
      } else {
        deleteSessionsData.mockRejectedValue(new Error('daemon denied delete'));
      }
      const deleted = vi.fn<(sessionIds: readonly string[]) => void>();
      const capture = vi.fn(() => deleted);
      generatedUiOwner = deletionOwner(capture);
      const onError = vi.fn();
      const onSessionsDeleted = vi.fn();
      renderSidebar({ ...props, onError, onSessionsDeleted });
      await expandSecondaryWorkspace();
      act(() => click(findSessionDeleteButton('Secondary same ID')));
      await flushSidebar();
      act(() => click(confirmDeleteButton()!));
      await flushSidebar();

      expect(capture).toHaveBeenCalledExactlyOnceWith('/tmp/other');
      expect(deleted.mock.calls.flatMap(([ids]) => ids)).toEqual([]);
      expect(active.deleteSession).not.toHaveBeenCalled();
      expect(onSessionsDeleted).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'daemon denied delete' }),
        'Failed to delete session',
      );
    },
  );
});
