// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import type { WebShellSidebarSessionActionsOptions } from './WebShellSidebar';
import sidebarStyles from './WebShellSidebar.module.css';

const { connection, workspace, workspaceActions, active, pinned, archived } =
  vi.hoisted(() => {
    const makeSessions = () => {
      const state = {
        sessions: [] as DaemonSessionSummary[],
        loading: false,
        error: null as Error | null,
        // Mirror useDaemonSessions: data is undefined until the first list
        // settles. Unit tests treat the mock as already settled.
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
          | {
              qwenCodeVersion: string;
              features: string[];
            }
          | undefined,
      },
      workspace: {
        capabilities: undefined as
          | {
              qwenCodeVersion: string;
              features: string[];
            }
          | undefined,
        client: {
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

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
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
    if (options?.enabled === false) {
      return { ...state, sessions: [], data: undefined, catalogQuery };
    }
    return {
      ...state,
      data: state.data ?? state.sessions,
      catalogQuery,
    };
  },
  useSessionCatalogController: () => ({
    refreshQueries: refreshSessionCatalogQueries,
    invalidateWorkspace: vi.fn(),
    refreshWorkspace: vi.fn(),
    renamed: vi.fn(),
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
const { COLLAPSED_SESSION_SECTIONS_STORAGE_KEY } = await import(
  './collapsedSessionSections'
);

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
if (!globalThis.PointerEvent) {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function makeSession(
  sessionId: string,
  over: Partial<DaemonSessionSummary> = {},
): DaemonSessionSummary {
  return {
    sessionId,
    workspaceCwd: '/tmp/project',
    displayName: `Session ${sessionId}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    clientCount: 0,
    hasActivePrompt: false,
    isArchived: false,
    isPinned: false,
    groupId: null,
    color: null,
    ...over,
  } as DaemonSessionSummary;
}

const organizationCapabilities = {
  qwenCodeVersion: '1.2.3',
  features: ['session_organization'],
};

const namedGroup = {
  id: 'group-1',
  name: 'Backend',
  color: 'green' as const,
  order: 0,
  createdAt: '2026-07-04T00:00:00.000Z',
  updatedAt: '2026-07-04T00:00:00.000Z',
};

let root: Root;
let container: HTMLDivElement;

function renderSidebar(
  collapsed = false,
  props: {
    onSelectCurrentSession?: () => void;
    sessionActions?: WebShellSidebarSessionActionsOptions;
    strict?: boolean;
  } = {},
) {
  const sidebar = (
    <WebShellSidebar
      collapsed={collapsed}
      onCollapsedChange={() => {}}
      onOpenSettings={() => {}}
      onOpenDaemonStatus={() => {}}
      onOpenScheduledTasks={() => {}}
      onOpenGoals={() => {}}
      onOpenSessions={() => {}}
      onOpenSplitView={() => {}}
      onNewSession={() => false}
      onLoadSession={loadSession}
      onSelectCurrentSession={props.onSelectCurrentSession}
      onError={() => {}}
      sessionActions={props.sessionActions}
    />
  );
  act(() => {
    root.render(
      <I18nProvider language="en">
        {props.strict ? <StrictMode>{sidebar}</StrictMode> : sidebar}
      </I18nProvider>,
    );
  });
}

async function flushSidebar() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function groupHeader(label: string): HTMLButtonElement {
  const section = container.querySelector<HTMLElement>(
    `section[aria-label="${label}"]`,
  );
  expect(section).not.toBeNull();
  const header = section!.querySelector<HTMLButtonElement>(
    'button[aria-expanded]',
  );
  expect(header).not.toBeNull();
  return header!;
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
  workspaceActions.listSessionGroups.mockReset();
  workspaceActions.listSessionGroups.mockResolvedValue({
    groups: [namedGroup],
    colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
  });
  active.sessions = [
    makeSession('session-a', {
      displayName: 'API review',
      groupId: 'group-1',
    }),
    makeSession('session-b', {
      displayName: 'Release notes',
      groupId: null,
    }),
  ];
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

describe('WebShellSidebar collapsed session group persistence', () => {
  it('includes secondary workspace attention without querying the primary workspace', async () => {
    const multiWorkspaceCapabilities = {
      ...organizationCapabilities,
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/tmp/other',
          primary: false,
          trusted: true,
        },
      ],
    };
    connection.capabilities = multiWorkspaceCapabilities;
    workspace.capabilities = multiWorkspaceCapabilities;
    useSessionCatalogQueries.mockImplementation((_client, queries) => {
      const activeQueries = queries.filter(
        (query: { options: { group?: string } }) =>
          query.options.group === 'all',
      );
      if (activeQueries.length === 0) return [];
      return [
        {
          page: {
            sessions: [
              makeSession('secondary-approval', {
                workspaceCwd: '/tmp/other',
                isWaitingForPermission: true,
              }),
            ],
          },
        },
      ];
    });

    renderSidebar(true);
    await flushSidebar();

    const activeQueryCalls = useSessionCatalogQueries.mock.calls
      .map((call) => call[1])
      .filter((queries) =>
        queries.some(
          (query: { options: { group?: string } }) =>
            query.options.group === 'all',
        ),
      );
    expect(activeQueryCalls.length).toBeGreaterThan(0);
    for (const queries of activeQueryCalls) {
      expect(queries).toEqual([
        expect.objectContaining({
          routeKind: 'qualified',
          workspaceCwd: '/tmp/other',
        }),
      ]);
    }
    expect(
      container.querySelector(
        '[data-web-shell-collapsed-session-status="approval"]',
      ),
    ).not.toBeNull();
  });

  it('shows completion from a secondary workspace on the collapsed icon', async () => {
    const multiWorkspaceCapabilities = {
      ...organizationCapabilities,
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/tmp/other',
          primary: false,
          trusted: true,
        },
      ],
    };
    connection.capabilities = multiWorkspaceCapabilities;
    workspace.capabilities = multiWorkspaceCapabilities;
    let running = true;
    useSessionCatalogQueries.mockImplementation(() => [
      {
        page: {
          sessions: [
            makeSession('secondary-session', {
              workspaceCwd: '/tmp/other',
              hasActivePrompt: running,
            }),
          ],
        },
        loading: false,
      },
    ]);

    renderSidebar(true);
    await flushSidebar();
    running = false;
    renderSidebar(true);
    await flushSidebar();

    expect(
      container.querySelector(
        '[data-web-shell-collapsed-session-status="completed"]',
      ),
    ).not.toBeNull();
  });

  it('shows the highest-priority session status on the collapsed project icon', async () => {
    active.sessions = [
      makeSession('session-status', {
        displayName: 'Needs attention',
        hasActivePrompt: true,
        isWaitingForPermission: true,
      }),
    ];
    active.data = active.sessions;
    renderSidebar(true);
    await flushSidebar();

    const trigger = container.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-trigger]',
    );
    expect(trigger?.getAttribute('aria-label')).toContain(
      'Waiting for approval',
    );
    expect(
      trigger?.querySelector(
        '[data-web-shell-collapsed-session-status="approval"]',
      ),
    ).not.toBeNull();

    active.sessions = [
      makeSession('session-status', {
        displayName: 'Needs attention',
        isWaitingForUserQuestion: true,
      }),
    ];
    active.data = active.sessions;
    renderSidebar(true);
    await flushSidebar();

    expect(
      trigger
        ?.querySelector('[data-web-shell-collapsed-session-status="question"]')
        ?.classList.contains(sidebarStyles.collapsedSessionStatusQuestion),
    ).toBe(true);

    active.sessions = [makeSession('session-status')];
    active.data = active.sessions;
    renderSidebar(true);
    await flushSidebar();

    expect(
      trigger?.querySelector(
        '[data-web-shell-collapsed-session-status="completed"]',
      ),
    ).not.toBeNull();
  });

  it('keeps project sessions available from the collapsed sidebar', async () => {
    connection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization', 'session_archive'],
    };
    workspace.capabilities = connection.capabilities;
    pinned.sessions = [
      makeSession('session-pinned', {
        displayName: 'Pinned task',
        isPinned: true,
      }),
    ];
    pinned.data = pinned.sessions;
    archived.sessions = [
      makeSession('session-archived', {
        displayName: 'Archived task',
      }),
    ];
    archived.data = archived.sessions;
    renderSidebar(true);
    await flushSidebar();

    const trigger = container.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-trigger]',
    );
    expect(trigger).not.toBeNull();

    act(() => {
      trigger?.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      );
    });
    await flushSidebar();

    const switcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(switcher?.textContent).toContain('API review');
    expect(switcher?.textContent).toContain('Pinned task');
    expect(switcher?.textContent).toContain('Archived');
    expect(
      switcher?.querySelector('button[aria-label="Search sessions"]'),
    ).not.toBeNull();

    const archivedHeader = Array.from(
      switcher?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).find((button) => button.textContent?.includes('Archived'));
    expect(archivedHeader).not.toBeNull();
    act(() => click(archivedHeader!));
    await flushSidebar();
    expect(switcher?.textContent).toContain('Archived task');

    act(() => click(trigger!));
    await flushSidebar();
    const clickedSwitcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(clickedSwitcher).not.toBeNull();

    const session = Array.from(
      clickedSwitcher?.querySelectorAll<HTMLElement>('[role="button"]') ?? [],
    ).find((row) => row.textContent?.includes('API review'));
    expect(session).not.toBeNull();

    act(() => {
      session!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      );
      click(session!);
      const outsideInput = document.createElement('input');
      document.body.appendChild(outsideInput);
      outsideInput.focus();
      outsideInput.remove();
    });
    await flushSidebar();

    expect(loadSession).toHaveBeenCalledWith('session-a', '/tmp/project');
    let openSwitcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(openSwitcher?.dataset.state).toBe('open');

    act(() => {
      openSwitcher?.dispatchEvent(
        new PointerEvent('pointerout', { bubbles: true }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    openSwitcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(
      openSwitcher === null || openSwitcher.dataset.state === 'closed',
    ).toBe(true);
  });

  it('keeps the switcher open without reloading the current session', async () => {
    connection.sessionId = 'session-a';
    const onSelectCurrentSession = vi.fn();
    renderSidebar(true, { onSelectCurrentSession });
    await flushSidebar();

    const trigger = container.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-trigger]',
    );
    expect(trigger).not.toBeNull();
    act(() => {
      trigger?.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      );
    });
    await flushSidebar();

    const switcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    const session = Array.from(
      switcher?.querySelectorAll<HTMLElement>('[role="button"]') ?? [],
    ).find((row) => row.textContent?.includes('API review'));
    expect(session).not.toBeNull();

    act(() => click(session!));
    await flushSidebar();

    expect(onSelectCurrentSession).toHaveBeenCalledTimes(1);
    expect(loadSession).not.toHaveBeenCalled();
    const openSwitcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(openSwitcher?.dataset.state).toBe('open');
  });

  it('keeps the collapsed session switcher open for session actions', async () => {
    renderSidebar(true);
    await flushSidebar();

    const trigger = container.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-trigger]',
    );
    act(() => {
      trigger?.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      );
    });
    await flushSidebar();

    const switcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    const moreActions = switcher?.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions"]',
    );
    expect(moreActions).not.toBeNull();

    act(() => {
      moreActions!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    await flushSidebar();

    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.style.zIndex).toBe(
      'calc(var(--web-shell-popover-z-index, 1000) + 1)',
    );
    expect(switcher?.dataset.state).toBe('open');
  });

  it('keeps the collapsed session switcher open when deleting a session', async () => {
    active.deleteSession.mockClear();
    active.deleteSession.mockResolvedValue(true);
    renderSidebar(true);
    await flushSidebar();

    const trigger = container.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-trigger]',
    );
    act(() => {
      trigger?.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      );
    });
    await flushSidebar();

    const switcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    const moreActions = switcher?.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions"]',
    );
    act(() => {
      moreActions?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    await flushSidebar();

    const deleteItem = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.trim() === 'Delete');
    expect(deleteItem).not.toBeUndefined();
    act(() => click(deleteItem!));
    await flushSidebar();
    expect(switcher?.dataset.state).toBe('open');

    const confirmDelete = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === 'Delete');
    expect(confirmDelete).not.toBeUndefined();
    act(() => click(confirmDelete!));
    await flushSidebar();

    expect(active.deleteSession).toHaveBeenCalledWith('session-a');
    expect(switcher?.dataset.state).toBe('open');
  });

  it('renders the complete session name', async () => {
    renderSidebar();
    await flushSidebar();

    const sessionName = Array.from(container.querySelectorAll('span')).find(
      (element) => element.textContent === 'API review',
    );
    expect(sessionName?.textContent).toContain('API review');
  });

  it('renders the complete archived session name', async () => {
    connection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization', 'session_archive'],
    };
    archived.sessions = [
      makeSession('session-archived', {
        displayName: 'Archived task',
        isArchived: true,
      }),
    ];
    archived.data = archived.sessions;

    renderSidebar();
    await flushSidebar();

    const archivedHeader = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
    ).find((btn) => btn.textContent?.includes('Archived'));
    expect(archivedHeader).not.toBeNull();
    act(() => click(archivedHeader!));
    await flushSidebar();

    const sessionName = Array.from(container.querySelectorAll('span')).find(
      (element) => element.textContent === 'Archived task',
    );
    expect(sessionName?.textContent).toContain('Archived task');

    // The archived row has no keyboard interaction, so it must not be an
    // inert tab stop.
    const archivedRow = sessionName?.closest<HTMLElement>(
      '[class*="archivedRow"]',
    );
    expect(archivedRow).not.toBeNull();
    expect(archivedRow!.tabIndex).toBe(-1);
  });

  it('refreshes archived sessions each time the section expands', async () => {
    connection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization', 'session_archive'],
    };

    renderSidebar();
    await flushSidebar();

    const archivedHeader = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
    ).find((btn) => btn.textContent?.includes('Archived'));
    expect(archivedHeader).not.toBeNull();

    act(() => click(archivedHeader!));
    expect(refreshSessionCatalogQueries).toHaveBeenCalledTimes(1);
    expect(refreshSessionCatalogQueries).toHaveBeenLastCalledWith([
      expect.objectContaining({
        routeKind: 'legacy',
        workspaceCwd: '/tmp/project',
        options: expect.objectContaining({ archiveState: 'archived' }),
      }),
    ]);

    act(() => click(archivedHeader!));
    act(() => click(archivedHeader!));
    expect(refreshSessionCatalogQueries).toHaveBeenCalledTimes(2);
  });

  it('writes collapsed section ids with the qwen-code-web-shell-* key', async () => {
    renderSidebar();
    await flushSidebar();

    const backend = container.querySelector<HTMLElement>(
      'section[aria-label="Backend"]',
    );
    expect(backend?.textContent).toContain('API review');
    act(() => click(groupHeader('Backend')));
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('false');
    expect(backend?.textContent).not.toContain('API review');
    expect(
      window.localStorage.getItem(COLLAPSED_SESSION_SECTIONS_STORAGE_KEY),
    ).toBe(JSON.stringify(['group:group-1']));
  });

  it('keeps a collapsed named group collapsed across remount', async () => {
    window.localStorage.setItem(
      COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
      JSON.stringify(['group:group-1']),
    );

    renderSidebar();
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('false');
    const backend = container.querySelector<HTMLElement>(
      'section[aria-label="Backend"]',
    );
    expect(backend?.textContent).not.toContain('API review');
    expect(container.textContent).toContain('Release notes');
  });

  it('keeps an expanded group expanded across remount after clearing collapse', async () => {
    window.localStorage.setItem(
      COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
      JSON.stringify(['group:group-1']),
    );

    renderSidebar();
    await flushSidebar();
    act(() => click(groupHeader('Backend')));
    await flushSidebar();
    expect(container.textContent).toContain('API review');
    expect(
      window.localStorage.getItem(COLLAPSED_SESSION_SECTIONS_STORAGE_KEY),
    ).toBe(JSON.stringify([]));

    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    renderSidebar();
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('API review');
  });

  it('tolerates corrupt localStorage data', async () => {
    window.localStorage.setItem(
      COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
      'not valid json',
    );

    renderSidebar();
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('API review');
  });

  it('ignores non-array localStorage payloads', async () => {
    window.localStorage.setItem(
      COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
      JSON.stringify({ group: 'group-1' }),
    );

    renderSidebar();
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('true');
  });

  it('does not crash when localStorage.setItem throws', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    renderSidebar();
    await flushSidebar();
    act(() => click(groupHeader('Backend')));
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('false');
  });

  it('auto-collapses a brand-new section that appears mid-session', async () => {
    renderSidebar();
    await flushSidebar();
    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('section[aria-label="Red"]')).toBeNull();

    // Keep the same React root so the first-catalog latch stays flipped.
    // Color sections are derived from the session list, so tagging a session
    // mid-session invents a new `color:red` section id.
    active.sessions = [
      makeSession('session-a', {
        displayName: 'API review',
        groupId: 'group-1',
      }),
      makeSession('session-b', {
        displayName: 'Release notes',
        groupId: null,
        color: 'red',
      }),
    ];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    const redHeader = groupHeader('Red');
    expect(redHeader.getAttribute('aria-expanded')).toBe('false');
    expect(
      container.querySelector('section[aria-label="Red"]')?.textContent,
    ).not.toContain('Release notes');
    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('true');
  });

  it('restores multiple section kinds and keeps sibling ids when one is removed', async () => {
    active.sessions = [
      makeSession('session-a', {
        displayName: 'API review',
        groupId: 'group-1',
      }),
      makeSession('session-b', {
        displayName: 'Release notes',
        groupId: null,
      }),
      makeSession('session-c', {
        displayName: 'Hotfix',
        groupId: null,
        color: 'red',
      }),
    ];
    active.data = active.sessions;
    window.localStorage.setItem(
      COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
      JSON.stringify(['color:red', 'group:group-1', 'recent']),
    );

    renderSidebar();
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('false');
    expect(groupHeader('Ungrouped').getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(groupHeader('Red').getAttribute('aria-expanded')).toBe('false');

    act(() => click(groupHeader('Backend')));
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('true');
    expect(groupHeader('Ungrouped').getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(groupHeader('Red').getAttribute('aria-expanded')).toBe('false');
    expect(
      JSON.parse(
        window.localStorage.getItem(COLLAPSED_SESSION_SECTIONS_STORAGE_KEY) ??
          '[]',
      ),
    ).toEqual(['color:red', 'recent']);
  });

  it('does not clobber workspace-scoped collapse ids when primary toggles', async () => {
    window.localStorage.setItem(
      COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
      JSON.stringify([
        'group:group-1',
        'ws:other|group:g2',
        'ws:other|ungrouped',
      ]),
    );

    renderSidebar();
    await flushSidebar();
    act(() => click(groupHeader('Backend')));
    await flushSidebar();

    expect(
      JSON.parse(
        window.localStorage.getItem(COLLAPSED_SESSION_SECTIONS_STORAGE_KEY) ??
          '[]',
      ),
    ).toEqual(['ws:other|group:g2', 'ws:other|ungrouped']);
  });

  it('does not let a stale hover-close timer close a reopened switcher', async () => {
    renderSidebar(true);
    await flushSidebar();

    const trigger = container.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-trigger]',
    );
    expect(trigger).not.toBeNull();
    act(() => {
      trigger!.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      );
    });
    await flushSidebar();
    expect(
      document.querySelector('[data-web-shell-collapsed-session-switcher]'),
    ).not.toBeNull();

    // Pointer leave arms the 150ms close timer; a reopen (tap on touch,
    // Enter on the keyboard) inside that window must cancel it.
    act(() => {
      trigger!.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    });
    act(() => {
      trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushSidebar();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    const switcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(switcher).not.toBeNull();
    expect(switcher?.dataset.state).toBe('open');
  });

  it('lets the switcher close after a tracked menu unmounts', async () => {
    renderSidebar(true);
    await flushSidebar();

    const trigger = container.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-trigger]',
    );
    act(() => {
      trigger!.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      );
    });
    await flushSidebar();

    const switcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    const moreActions = switcher?.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions"]',
    );
    expect(moreActions).not.toBeNull();
    act(() => {
      moreActions!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    await flushSidebar();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    // A poll removes the row, unmounting the row's open menu without Radix
    // ever emitting a close event.
    active.sessions = active.sessions.filter(
      (session) => session.sessionId !== 'session-a',
    );
    active.data = active.sessions;
    renderSidebar(true);
    await flushSidebar();

    const reopened = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(reopened).not.toBeNull();
    act(() => {
      reopened!.dispatchEvent(
        new PointerEvent('pointerout', { bubbles: true }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    const after = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(after === null || after.dataset.state === 'closed').toBe(true);
  });

  it('keeps the switcher open while the group picker is open', async () => {
    renderSidebar(true);
    await flushSidebar();

    const trigger = container.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-trigger]',
    );
    act(() => {
      trigger!.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      );
    });
    await flushSidebar();

    const switcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    const moreActions = switcher?.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions"]',
    );
    expect(moreActions).not.toBeNull();
    act(() => {
      moreActions!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    await flushSidebar();

    const groupItem = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes('Group'));
    expect(groupItem).not.toBeNull();
    act(() => {
      groupItem!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      );
      groupItem!.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true }),
      );
      groupItem!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushSidebar();

    // The bespoke group picker (plain role="menu", no Radix data-slot) must
    // keep the switcher underneath it open.
    expect(switcher?.dataset.state).toBe('open');
    act(() => {
      switcher!.dispatchEvent(
        new PointerEvent('pointerout', { bubbles: true }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(
      document
        .querySelector('[data-web-shell-collapsed-session-switcher]')
        ?.getAttribute('data-state'),
    ).toBe('open');
  });

  it('keeps the switcher open while keyboard focus is inside it', async () => {
    renderSidebar(true);
    await flushSidebar();

    const trigger = container.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-trigger]',
    );
    act(() => {
      trigger!.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      );
    });
    await flushSidebar();

    const switcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    const search = switcher?.querySelector<HTMLButtonElement>(
      'button[aria-label="Search sessions"]',
    );
    expect(search).not.toBeNull();
    act(() => {
      search!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushSidebar();

    const input = switcher?.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    act(() => {
      input!.focus();
    });
    expect(document.activeElement).toBe(input);

    act(() => {
      switcher!.dispatchEvent(
        new PointerEvent('pointerout', { bubbles: true }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    const after = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(after).not.toBeNull();
    expect(after?.dataset.state).toBe('open');
  });

  it('keeps search open when selecting a session', async () => {
    renderSidebar(true);
    await flushSidebar();

    const trigger = container.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-trigger]',
    );
    expect(trigger).not.toBeNull();
    act(() => {
      trigger!.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      );
    });
    await flushSidebar();

    const switcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(switcher).not.toBeNull();
    const searchButton = switcher!.querySelector<HTMLButtonElement>(
      'button[aria-label="Search sessions"]',
    );
    expect(searchButton).not.toBeNull();
    act(() => {
      searchButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushSidebar();
    expect(switcher!.querySelector('input')).not.toBeNull();

    const row = Array.from(
      switcher!.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((element) => element.textContent?.includes('API review'));
    expect(row).not.toBeUndefined();
    act(() => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushSidebar();
    expect(loadSession).toHaveBeenCalledWith('session-a', '/tmp/project');
    const openSwitcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(openSwitcher?.dataset.state).toBe('open');
    expect(openSwitcher?.querySelector('input')).not.toBeNull();
  });

  it('resets collapsed search state when the sidebar expands', async () => {
    renderSidebar(true);
    await flushSidebar();
    const trigger = container.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-trigger]',
    );
    act(() => {
      trigger!.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      );
    });
    await flushSidebar();
    const switcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    const search = switcher!.querySelector<HTMLButtonElement>(
      'button[aria-label="Search sessions"]',
    );
    act(() =>
      search!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    await flushSidebar();
    const input = switcher!.querySelector<HTMLInputElement>('input');
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'no-match');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    renderSidebar(false);
    await flushSidebar();

    expect(container.querySelector('[class*="projectSearch"]')).toBeNull();
    expect(container.textContent).toContain('API review');
    expect(container.textContent).not.toContain('No matching sessions.');
  });

  it('keeps keyboard semantics when a pointer grazes the open switcher', async () => {
    renderSidebar(true);
    await flushSidebar();

    const trigger = container.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-trigger]',
    );
    expect(trigger).not.toBeNull();

    // Keyboard open: Enter activates the focused trigger; the keydown marks
    // the open as keyboard-initiated before the click opens the popover.
    act(() => {
      trigger!.focus();
    });
    act(() => {
      trigger!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    act(() => {
      trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushSidebar();

    const switcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(switcher?.dataset.state).toBe('open');

    // A mouse graze over the content must not convert the keyboard-opened
    // switcher to pointer semantics.
    act(() => {
      switcher!.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      );
    });

    const searchButton = switcher!.querySelector<HTMLButtonElement>(
      'button[aria-label="Search sessions"]',
    );
    expect(searchButton).not.toBeNull();
    act(() => {
      searchButton!.focus();
    });
    expect(document.activeElement).toBe(searchButton);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await flushSidebar();
    // Radix dispatches the close-time focus restoration from a 0ms timer.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const after = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(after === null || after.dataset.state === 'closed').toBe(true);
    // Focus must return to the trigger, not drop to the body.
    expect(document.activeElement).toBe(trigger);
  });

  it('restores focus to the trigger when a pointer-opened switcher closes with focus inside', async () => {
    renderSidebar(true);
    await flushSidebar();

    const trigger = container.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-trigger]',
    );
    expect(trigger).not.toBeNull();
    act(() => {
      trigger!.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      );
    });
    await flushSidebar();

    const switcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(switcher?.dataset.state).toBe('open');
    const searchButton = switcher!.querySelector<HTMLButtonElement>(
      'button[aria-label="Search sessions"]',
    );
    expect(searchButton).not.toBeNull();
    act(() => {
      searchButton!.focus();
    });
    expect(document.activeElement).toBe(searchButton);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await flushSidebar();
    // Radix dispatches the close-time focus restoration from a 0ms timer.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const closed = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(closed === null || closed.dataset.state === 'closed').toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it('cancels an in-flight rename when the collapsed switcher is dismissed', async () => {
    connection.sessionId = 'session-a';
    renderSidebar(true);
    await flushSidebar();

    const trigger = container.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-trigger]',
    );
    expect(trigger).not.toBeNull();
    act(() => {
      trigger!.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      );
    });
    await flushSidebar();

    const switcher = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(switcher).not.toBeNull();
    const moreActions = Array.from(
      switcher!.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="More actions"]',
      ),
    ).find((button) =>
      button
        .closest<HTMLElement>('[role="button"]')
        ?.textContent?.includes('API review'),
    );
    expect(moreActions).not.toBeNull();
    act(() => {
      moreActions!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    await flushSidebar();

    const renameItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes('Rename'));
    expect(renameItem).toBeDefined();
    act(() => {
      renameItem!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      );
      renameItem!.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true }),
      );
      renameItem!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushSidebar();

    const input = switcher!.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'xy');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // An outside pointer press dismisses the popover; the focused input
    // unmounts without a blur event, so the dismissal itself must cancel
    // the rename.
    // Radix re-registers its document pointerdown listener through a 0ms
    // timer whenever the dismissable-layer stack changes (the session menu
    // above just unmounted); let it settle before the outside interaction.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => {
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      );
      document.body.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true }),
      );
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flushSidebar();
    expect(
      document.querySelector('[data-web-shell-collapsed-session-switcher]'),
    ).toBeNull();

    act(() => {
      trigger!.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      );
    });
    await flushSidebar();
    const reopened = document.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-switcher]',
    );
    expect(reopened).not.toBeNull();
    expect(reopened!.querySelector('input')).toBeNull();
  });

  it('does not render the actions overlay when a row has no available actions', async () => {
    renderSidebar(false, { sessionActions: { items: ['details'] } });
    await flushSidebar();

    const row = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((element) => element.textContent?.includes('API review'));
    expect(row).not.toBeUndefined();
    expect(row!.querySelector(`.${sidebarStyles.sessionActions}`)).toBeNull();
  });

  it('opens the rename editor on double-click', async () => {
    connection.sessionId = 'session-a';
    renderSidebar(false);
    await flushSidebar();

    const row = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((element) => element.textContent?.includes('API review'));
    expect(row).not.toBeUndefined();
    act(() => {
      row!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await flushSidebar();

    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Rename: API review"]',
      ),
    ).not.toBeNull();
  });

  it('keeps the rename editor mounted under the StrictMode effect replay', async () => {
    connection.sessionId = 'session-a';
    renderSidebar(false, { strict: true });
    await flushSidebar();

    const row = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((element) => element.textContent?.includes('API review'));
    expect(row).not.toBeUndefined();
    act(() => {
      row!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Rename: API review"]',
      ),
    ).not.toBeNull();
  });
});
