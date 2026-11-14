/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import {
  McpAppGeneratedUiOwnerContext,
  type McpAppGeneratedUiOwner,
} from '../../mcpAppHostContext';
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
const archiveSelections = vi.fn();
Object.assign(workspace.client, { archiveSessionsData: archiveSelections });
// Stable identity across renders: the sidebar's useLayoutEffect depends on
// the controller object, and a fresh literal per render re-runs the effect
// (extra refreshQueries) on each render.
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
    sessionContent?: React.ReactNode;
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
              onLoadSession={loadSession}
              onError={onError}
              onSessionsDeleted={props.onSessionsDeleted}
              currentSessionActive={props.currentSessionActive}
              managedWorkspaces={props.managedWorkspaces}
              sessionContent={props.sessionContent}
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
    archiveSessionsData: archiveSelections,
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
  archiveSelections.mockReset().mockImplementation(async (ids: string[]) => ({
    archived: ids,
    alreadyArchived: [],
    notFound: [],
    errors: [],
  }));
  workspace.client.workspaceByCwd.mockImplementation((cwd: string) => ({
    ...defaultWorkspaceByCwd(cwd),
    archiveSessionsData: archiveSelections,
  }));
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

describe('sidebar session selection', () => {
  function button(label: string): HTMLButtonElement {
    const result = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    expect(result).not.toBeNull();
    return result!;
  }

  function selection(name: string): HTMLElement {
    const result = container.querySelector<HTMLElement>(
      `[role="checkbox"][aria-label="Select ${name}"]`,
    );
    expect(result).not.toBeNull();
    return result!;
  }

  function action(label: string): HTMLButtonElement {
    const result = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === label,
    );
    expect(result).toBeDefined();
    return result!;
  }

  async function enterSelection(): Promise<void> {
    connection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: [
        ...(connection.capabilities?.features ?? []),
        'session_archive',
        'session_archive_idle_guard',
      ],
    };
    workspace.capabilities = connection.capabilities;
    active.sessions = [
      makeSession('first', { displayName: 'First session' }),
      makeSession('second', { displayName: 'Second session' }),
    ];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();
    act(() => click(button('Select sessions')));
  }

  it('counts selected sessions without navigating and clears them on exit', async () => {
    await enterSelection();
    expect(action('Pin').disabled).toBe(true);
    expect(action('Archive').disabled).toBe(true);
    act(() => click(selection('First session')));
    act(() => click(selection('Second session')));
    expect(container.textContent).toContain('2 sessions selected');
    expect(selection('First session').getAttribute('aria-checked')).toBe(
      'true',
    );
    act(() => click(selection('First session')));
    expect(container.textContent).toContain('1 session selected');
    expect(loadSession).not.toHaveBeenCalled();
    act(() => click(button('Exit selection')));
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
    act(() => click(button('Select sessions')));
    expect(container.textContent).toContain('0 sessions selected');
  });

  it('keeps the selection toggle visible and clears selection when toggled off', async () => {
    await enterSelection();
    expect(button('Select sessions').getAttribute('aria-pressed')).toBe('true');
    act(() => click(selection('First session')));
    act(() => click(button('Select sessions')));
    expect(button('Select sessions').getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
    act(() => click(button('Select sessions')));
    expect(container.textContent).toContain('0 sessions selected');
    expect(selection('First session').getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('exits selection with Escape', async () => {
    await enterSelection();
    act(() => click(selection('First session')));
    act(() => {
      selection('First session').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
    expect(button('Select sessions')).toBeDefined();
  });

  it('archives selected sessions immediately without confirmation or deletion', async () => {
    await enterSelection();
    act(() => click(selection('First session')));
    act(() => click(selection('Second session')));
    await act(async () => click(action('Archive')));
    await flushSidebar();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(archiveSelections).toHaveBeenCalledWith(['first'], {
      requireIdle: true,
    });
    expect(archiveSelections).toHaveBeenCalledWith(['second'], {
      requireIdle: true,
    });
    expect(active.deleteSession).not.toHaveBeenCalled();
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
  });

  it('keeps unsuccessful archives selected for retry', async () => {
    archiveSelections.mockImplementation(async ([id]: string[]) => {
      if (id === 'second') throw new Error('Archive failed');
      return { archived: [id], alreadyArchived: [], notFound: [], errors: [] };
    });
    await enterSelection();
    act(() => click(selection('First session')));
    act(() => click(selection('Second session')));
    await act(async () => click(action('Archive')));
    await flushSidebar();
    expect(selection('First session').getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(selection('Second session').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(container.textContent).toContain('1 session selected');
  });

  it('keeps missing sessions selected rather than reporting archive success', async () => {
    archiveSelections.mockResolvedValue({
      archived: [],
      alreadyArchived: [],
      notFound: ['first'],
      errors: [],
    });
    await enterSelection();
    act(() => click(selection('First session')));
    await act(async () => click(action('Archive')));
    await flushSidebar();
    expect(selection('First session').getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('does not archive the current session even when idle', async () => {
    connection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    connection.sessionId = 'first';
    await enterSelection();
    act(() => click(selection('First session')));
    expect(container.textContent).toContain('1 session selected');
    expect(action('Archive').disabled).toBe(true);
    expect(archiveSelections).not.toHaveBeenCalled();
  });

  it('disables bulk archive when the daemon cannot guarantee idle-only archive', async () => {
    await enterSelection();
    act(() => click(selection('First session')));
    connection.capabilities!.features = ['session_archive'];
    renderSidebar();
    await flushSidebar();
    expect(action('Archive').disabled).toBe(true);
    expect(archiveSelections).not.toHaveBeenCalled();
  });

  it('retains failed pins while preserving successful pins', async () => {
    connection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    workspaceActions.updateSessionOrganization
      .mockReset()
      .mockImplementation(async (id: string) => {
        if (id === 'second') throw new Error('Pin failed');
        return {};
      });
    await enterSelection();
    act(() => click(selection('First session')));
    act(() => click(selection('Second session')));
    await act(async () => click(action('Pin')));
    await flushSidebar();
    expect(workspaceActions.updateSessionOrganization).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('1 session selected');
    expect(selection('Second session').getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('pins unpinned selections without toggling already pinned sessions off', async () => {
    connection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    workspace.capabilities = connection.capabilities;
    workspaceActions.updateSessionOrganization.mockReset();
    workspaceActions.updateSessionOrganization.mockResolvedValue({});
    pinned.sessions = [
      makeSession('pinned', { displayName: 'Already pinned', isPinned: true }),
    ];
    pinned.data = pinned.sessions;
    await enterSelection();
    act(() => click(selection('Already pinned')));
    expect(action('Pin').disabled).toBe(true);
    act(() => click(selection('First session')));
    expect(action('Pin').disabled).toBe(false);
    await act(async () => click(action('Pin')));
    await flushSidebar();
    expect(workspaceActions.updateSessionOrganization).toHaveBeenCalledTimes(1);
    expect(workspaceActions.updateSessionOrganization).toHaveBeenCalledWith(
      'first',
      { isPinned: true },
    );
  });

  it('keeps matching session IDs in different workspaces separate', async () => {
    const { props } = secondaryDeletion(false);
    connection.capabilities!.features.push(
      'session_archive',
      'session_archive_idle_guard',
    );
    renderSidebar(props);
    await expandSecondaryWorkspace();
    act(() => click(button('Select sessions')));
    act(() => click(selection('Primary same ID')));
    expect(selection('Secondary same ID').getAttribute('aria-checked')).toBe(
      'false',
    );
    act(() => click(selection('Secondary same ID')));
    expect(container.textContent).toContain('2 sessions selected');
    await act(async () => click(action('Archive')));
    await flushSidebar();
    expect(archiveSelections).toHaveBeenCalledTimes(2);
    expect(workspace.client.workspaceByCwd).toHaveBeenCalledWith('/tmp/other');
  });

  it('disables archiving when a selected idle session starts running', async () => {
    await enterSelection();
    act(() => click(selection('First session')));
    expect(action('Archive').disabled).toBe(false);
    active.sessions = active.sessions.map((session) =>
      session.sessionId === 'first'
        ? { ...session, hasActivePrompt: true }
        : session,
    );
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();
    expect(action('Archive').disabled).toBe(true);
    expect(active.deleteSession).not.toHaveBeenCalled();
  });

  it('does not restore failed selections after changing session content during archiving', async () => {
    let rejectArchive!: (reason: Error) => void;
    archiveSelections.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectArchive = reject;
        }),
    );
    await enterSelection();
    act(() => click(selection('First session')));
    act(() => click(action('Archive')));
    renderSidebar({ sessionContent: <div>Replacement sessions</div> });
    await act(async () => rejectArchive(new Error('Archive failed')));
    await flushSidebar();
    renderSidebar();
    await flushSidebar();
    act(() => click(button('Select sessions')));
    expect(container.textContent).toContain('0 sessions selected');
    expect(selection('First session').getAttribute('aria-checked')).toBe(
      'false',
    );
  });
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

it('renders the untitled label instead of an id for a nameless session', async () => {
  active.sessions = [makeSession('nameless', { displayName: '' })];
  active.data = active.sessions;
  renderSidebar();
  await flushSidebar();

  const titles = Array.from(
    container.querySelectorAll('[data-web-shell-session-title]'),
  );
  expect(titles.some((node) => node.textContent === 'Untitled session')).toBe(
    true,
  );
  expect(titles.some((node) => node.textContent === 'nameless')).toBe(false);
});

describe('WebShellSidebar current-session delete (issue #12619)', () => {
  it('keeps Managed navigation visible when local Workspaces are collapsed', async () => {
    window.localStorage.setItem(
      'qwen.web-shell.sidebar.workspace-expanded:projects',
      'false',
    );
    renderSidebar({
      managedWorkspaces: (
        <nav data-testid="managed-navigation">Managed sessions</nav>
      ),
    });
    await flushSidebar();

    const managedNavigation = container.querySelector(
      '[data-testid="managed-navigation"]',
    );
    expect(managedNavigation).not.toBeNull();
    expect(managedNavigation?.closest('[hidden]')).toBeNull();
  });

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

  it('shares dialog search text with Managed navigation and resets it on close', async () => {
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
    const input = document.querySelector<HTMLInputElement>(
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

  it('clears the host query when search closes without the dialog', async () => {
    const onSearchQueryChange = vi.fn();

    function CollapsibleHost() {
      const [collapsed, setCollapsed] = React.useState(false);
      return (
        <I18nProvider language="en">
          <McpAppGeneratedUiOwnerContext.Provider value={generatedUiOwner}>
            <WebShellSidebar
              archivedSessionsTarget={null}
              collapsed={collapsed}
              onCollapsedChange={setCollapsed}
              onOpenSettings={() => {}}
              onOpenDaemonStatus={() => {}}
              onOpenScheduledTasks={() => {}}
              onOpenGoals={() => {}}
              onOpenSessions={() => {}}
              onOpenSplitView={() => {}}
              onNewSession={() => false}
              onLoadSession={loadSession}
              onError={() => {}}
              onSearchQueryChange={onSearchQueryChange}
              sessionActions={{ inlineItems: ['delete'] }}
            />
          </McpAppGeneratedUiOwnerContext.Provider>
        </I18nProvider>
      );
    }

    act(() => root.render(<CollapsibleHost />));
    await flushSidebar();
    act(() =>
      click(
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="Search sessions"]',
        )!,
      ),
    );
    await flushSidebar();
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search sessions"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'Managed needle');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushSidebar();
    expect(onSearchQueryChange).toHaveBeenLastCalledWith('Managed needle');

    act(() =>
      click(
        container.querySelector<HTMLButtonElement>(
          '[data-web-shell-sidebar-collapse]',
        )!,
      ),
    );
    await flushSidebar();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onSearchQueryChange).toHaveBeenLastCalledWith('');
  });

  it('closes session search when a Managed row arrives through a portal', async () => {
    const onSearchQueryChange = vi.fn();
    const selected: string[] = [];

    function PortalHost() {
      const [target, setTarget] = React.useState<HTMLElement | null>(null);
      return (
        <>
          <I18nProvider language="en">
            <McpAppGeneratedUiOwnerContext.Provider value={generatedUiOwner}>
              <WebShellSidebar
                archivedSessionsTarget={null}
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
                managedWorkspaces={<div ref={setTarget} />}
                onSearchQueryChange={onSearchQueryChange}
                sessionActions={{ inlineItems: ['delete'] }}
              />
            </McpAppGeneratedUiOwnerContext.Provider>
          </I18nProvider>
          {target
            ? createPortal(
                <div
                  data-managed-session-id="managed-1"
                  role="button"
                  tabIndex={0}
                  onClick={() => selected.push('managed-1')}
                >
                  Managed session
                </div>,
                target,
              )
            : null}
        </>
      );
    }

    act(() => root.render(<PortalHost />));
    await flushSidebar();
    act(() =>
      click(
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="Search sessions"]',
        )!,
      ),
    );
    await flushSidebar();
    const input = document.querySelector<HTMLInputElement>(
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
    const row = document.querySelector('[data-managed-session-id="managed-1"]');
    expect(row).not.toBeNull();
    act(() => (row as HTMLElement).click());
    await flushSidebar();
    expect(selected).toEqual(['managed-1']);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onSearchQueryChange).toHaveBeenLastCalledWith('');
  });

  it('keeps the Managed navigation mounted across search open and close', async () => {
    const mounts: number[] = [];

    function ManagedNavigation() {
      React.useEffect(() => {
        mounts.push(1);
      }, []);
      return <div data-managed-session-id="managed-1">Managed session</div>;
    }

    function PortalHost() {
      const [target, setTarget] = React.useState<HTMLElement | null>(null);
      return (
        <>
          <I18nProvider language="en">
            <McpAppGeneratedUiOwnerContext.Provider value={generatedUiOwner}>
              <WebShellSidebar
                archivedSessionsTarget={null}
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
                managedWorkspaces={<div ref={setTarget} />}
                sessionActions={{ inlineItems: ['delete'] }}
              />
            </McpAppGeneratedUiOwnerContext.Provider>
          </I18nProvider>
          {target ? createPortal(<ManagedNavigation />, target) : null}
        </>
      );
    }

    act(() => root.render(<PortalHost />));
    await flushSidebar();
    expect(mounts).toHaveLength(1);
    expect(
      container.querySelector('[data-managed-session-id="managed-1"]'),
    ).not.toBeNull();

    const searchButton = () =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Search sessions"]',
      )!;
    act(() => click(searchButton()));
    await flushSidebar();
    expect(mounts).toHaveLength(1);
    expect(
      document.querySelector(
        '[role="dialog"] [data-managed-session-id="managed-1"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      document
        .querySelector<HTMLInputElement>('input[aria-label="Search sessions"]')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
    });
    await flushSidebar();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mounts).toHaveLength(1);
    expect(
      container.querySelector('[data-managed-session-id="managed-1"]'),
    ).not.toBeNull();

    act(() => click(searchButton()));
    await flushSidebar();
    expect(mounts).toHaveLength(1);
    expect(
      document.querySelector(
        '[role="dialog"] [data-managed-session-id="managed-1"]',
      ),
    ).not.toBeNull();
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
