// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';

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
      sessions: state.data === undefined ? [] : state.sessions,
      data: state.data,
      catalogQuery,
    };
  },
  useSessionCatalogController: () => ({
    refreshQueries: refreshSessionCatalogQueries,
    invalidateWorkspace: vi.fn(),
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

let root: Root;
let container: HTMLDivElement;

function renderSidebar(
  props: { onError?: (error: unknown, message?: string) => void } = {},
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
        />
      </I18nProvider>,
    );
  });
}

async function flushSidebar(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function pinnedListTitles(): string[] {
  const header = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
  ).find((button) => button.textContent?.includes('Pinned'));
  if (!header) return [];
  const section = header.closest('div');
  const list = section?.parentElement?.querySelector(
    '[class*="pinnedSessionList"]',
  );
  const scope = list ?? section?.parentElement;
  if (!scope) return [];
  return Array.from(
    scope.querySelectorAll('[data-web-shell-session-title]'),
  ).map((node) => node.textContent ?? '');
}

function sessionTitleCount(displayName: string): number {
  return Array.from(
    container.querySelectorAll('[data-web-shell-session-title]'),
  ).filter((node) => node.textContent === displayName).length;
}

function findSessionPinButton(displayName: string): HTMLButtonElement {
  const titles = Array.from(
    container.querySelectorAll('[data-web-shell-session-title]'),
  ).filter((node) => node.textContent === displayName);
  expect(titles.length).toBeGreaterThan(0);
  for (const title of titles) {
    let node: HTMLElement | null = title;
    while (node) {
      const pinButton = node.querySelector<HTMLButtonElement>(
        'button[aria-label="Pin"], button[aria-label="Unpin"]',
      );
      if (pinButton) return pinButton;
      node = node.parentElement;
    }
  }
  throw new Error(`No pin button found for ${displayName}`);
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('WebShellSidebar session pinning (issue #9465)', () => {
  it('orders the pinned section by pin time, not last activity', async () => {
    // The daemon returns the pinned page sorted by activity (updatedAt
    // descending): "recent" was active most recently but was pinned AFTER
    // "older". Pin-time order keeps "older" first and appends "recent".
    pinned.sessions = [
      makeSession('recent', {
        displayName: 'Recent activity',
        isPinned: true,
        pinnedAt: '2026-01-02T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        // pinned LAST, but with the NEWEST activity time
        updatedAt: '2026-01-05T00:00:00.000Z',
      }),
      makeSession('older', {
        displayName: 'Older activity',
        isPinned: true,
        pinnedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        // pinned FIRST, but with the OLDEST activity time
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ];
    pinned.data = pinned.sessions;

    renderSidebar();
    await flushSidebar();

    expect(pinnedListTitles()).toEqual(['Older activity', 'Recent activity']);
  });

  it('orders pins without a usable pinnedAt deterministically by session ID', async () => {
    // Current daemons cannot emit a pinned row without pinnedAt, but the
    // comparator must still be deterministic for missing/invalid values:
    // such rows sort before timestamped pins, by sessionId — never by
    // activity time.
    pinned.sessions = [
      makeSession('b-legacy', {
        displayName: 'Legacy B',
        isPinned: true,
        updatedAt: '2026-02-01T00:00:00.000Z',
      }),
      makeSession('c-timestamped-later', {
        displayName: 'Timestamped later',
        isPinned: true,
        pinnedAt: '2026-01-03T00:00:00.000Z',
      }),
      makeSession('a-legacy', {
        displayName: 'Legacy A',
        isPinned: true,
        updatedAt: '2026-02-01T00:00:00.000Z',
      }),
      makeSession('d-invalid', {
        displayName: 'Invalid pinnedAt',
        isPinned: true,
        pinnedAt: 'not-a-date',
        updatedAt: '2026-02-01T00:00:00.000Z',
      }),
      makeSession('e-timestamped-earlier', {
        displayName: 'Timestamped earlier',
        isPinned: true,
        pinnedAt: '2026-01-02T00:00:00.000Z',
      }),
    ];
    pinned.data = pinned.sessions;

    renderSidebar();
    await flushSidebar();

    expect(pinnedListTitles()).toEqual([
      'Legacy A',
      'Legacy B',
      'Invalid pinnedAt',
      'Timestamped earlier',
      'Timestamped later',
    ]);
  });

  it('reflects pinning immediately without waiting for the daemon RPC', async () => {
    active.sessions = [makeSession('plain', { displayName: 'Plain session' })];
    active.data = active.sessions;
    // RPC stays in flight: the sidebar must still show the pinned state.
    workspaceActions.updateSessionOrganization.mockReturnValue(
      new Promise(() => {}),
    );

    renderSidebar();
    await flushSidebar();
    expect(pinnedListTitles()).toEqual([]);

    act(() => click(findSessionPinButton('Plain session')));
    await flushSidebar();

    expect(workspaceActions.updateSessionOrganization).toHaveBeenCalledWith(
      'plain',
      { isPinned: true },
    );
    // Optimistically pinned: shown in the pinned section exactly once and
    // hidden from the unpinned list while the RPC is in flight.
    expect(pinnedListTitles()).toEqual(['Plain session']);
    expect(sessionTitleCount('Plain session')).toBe(1);
  });

  it('appends an optimistic pin below existing pinned sessions', async () => {
    pinned.sessions = [
      makeSession('existing', {
        displayName: 'Existing pin',
        isPinned: true,
        pinnedAt: '2026-01-01T00:00:00.000Z',
      }),
    ];
    pinned.data = pinned.sessions;
    active.sessions = [makeSession('plain', { displayName: 'Plain session' })];
    active.data = active.sessions;
    workspaceActions.updateSessionOrganization.mockReturnValue(
      new Promise(() => {}),
    );

    renderSidebar();
    await flushSidebar();
    act(() => click(findSessionPinButton('Plain session')));
    await flushSidebar();

    expect(pinnedListTitles()).toEqual(['Existing pin', 'Plain session']);
  });

  it('reflects unpinning immediately without waiting for the daemon RPC', async () => {
    // The daemon's "all" page carries pinned rows too, so the session is
    // present in both pages while pinned.
    const pinnedSession = makeSession('pinned-session', {
      displayName: 'Pinned session',
      isPinned: true,
      pinnedAt: '2026-01-01T00:00:00.000Z',
    });
    pinned.sessions = [pinnedSession];
    pinned.data = pinned.sessions;
    active.sessions = [pinnedSession];
    active.data = active.sessions;
    workspaceActions.updateSessionOrganization.mockReturnValue(
      new Promise(() => {}),
    );

    renderSidebar();
    await flushSidebar();
    expect(pinnedListTitles()).toEqual(['Pinned session']);

    act(() => click(findSessionPinButton('Pinned session')));
    await flushSidebar();

    expect(workspaceActions.updateSessionOrganization).toHaveBeenCalledWith(
      'pinned-session',
      { isPinned: false },
    );
    // Optimistically unpinned: gone from the pinned section, back in the
    // unpinned list, while the RPC is in flight.
    expect(pinnedListTitles()).toEqual([]);
    expect(sessionTitleCount('Pinned session')).toBe(1);
  });

  it('rolls the optimistic pin back when the daemon RPC fails', async () => {
    active.sessions = [makeSession('plain', { displayName: 'Plain session' })];
    active.data = active.sessions;
    workspaceActions.updateSessionOrganization.mockRejectedValue(
      new Error('daemon unavailable'),
    );
    const onError = vi.fn();

    renderSidebar({ onError });
    await flushSidebar();

    act(() => click(findSessionPinButton('Plain session')));
    await flushSidebar();

    expect(onError).toHaveBeenCalled();
    expect(pinnedListTitles()).toEqual([]);
    expect(sessionTitleCount('Plain session')).toBe(1);
  });

  it('rolls the optimistic unpin back when the daemon RPC fails', async () => {
    const row = makeSession('pinned-session', {
      displayName: 'Pinned session',
      isPinned: true,
      pinnedAt: '2026-01-01T00:00:00.000Z',
    });
    pinned.sessions = [row];
    pinned.data = pinned.sessions;
    active.sessions = [row];
    active.data = active.sessions;
    workspaceActions.updateSessionOrganization.mockRejectedValue(
      new Error('daemon unavailable'),
    );
    const onError = vi.fn();

    renderSidebar({ onError });
    await flushSidebar();
    expect(pinnedListTitles()).toEqual(['Pinned session']);

    act(() => click(findSessionPinButton('Pinned session')));
    await flushSidebar();

    expect(onError).toHaveBeenCalled();
    expect(pinnedListTitles()).toEqual(['Pinned session']);
    expect(sessionTitleCount('Pinned session')).toBe(1);
  });

  it('drops an optimistic pin when the refreshed catalog contradicts it', async () => {
    active.sessions = [makeSession('plain', { displayName: 'Plain session' })];
    active.data = active.sessions;
    workspaceActions.updateSessionOrganization.mockResolvedValue({});

    renderSidebar();
    await flushSidebar();
    act(() => click(findSessionPinButton('Plain session')));
    await flushSidebar();
    expect(pinnedListTitles()).toEqual(['Plain session']);

    active.sessions = [
      makeSession('plain', { displayName: 'Plain session', isPinned: false }),
    ];
    active.data = active.sessions;
    pinned.sessions = [];
    pinned.data = pinned.sessions;
    renderSidebar();
    await flushSidebar();

    expect(pinnedListTitles()).toEqual([]);
    expect(sessionTitleCount('Plain session')).toBe(1);
  });

  it('keeps an optimistic pin while the pinned catalog is unloaded', async () => {
    active.sessions = [makeSession('plain', { displayName: 'Plain session' })];
    active.data = active.sessions;
    pinned.data = undefined;
    workspaceActions.updateSessionOrganization.mockResolvedValue({});

    renderSidebar();
    await flushSidebar();
    act(() => click(findSessionPinButton('Plain session')));
    await flushSidebar();
    expect(pinnedListTitles()).toEqual(['Plain session']);

    // The real catalog hook returns a fresh sessions=[] on each render while
    // data remains undefined. Render churn must not count as authoritative
    // evidence that contradicts the successful pin.
    renderSidebar();
    await flushSidebar();
    expect(pinnedListTitles()).toEqual(['Plain session']);
    expect(sessionTitleCount('Plain session')).toBe(1);
  });

  it('keeps an optimistic unpin until all loaded pages corroborate it', async () => {
    const row = makeSession('pinned-session', {
      displayName: 'Pinned session',
      isPinned: true,
      pinnedAt: '2026-01-01T00:00:00.000Z',
    });
    pinned.sessions = [row];
    pinned.data = pinned.sessions;
    active.sessions = [row];
    active.data = active.sessions;
    workspaceActions.updateSessionOrganization.mockResolvedValue({});

    renderSidebar();
    await flushSidebar();
    act(() => click(findSessionPinButton('Pinned session')));
    await flushSidebar();

    // The all-sessions page settles first, while the pinned page still has
    // stale data. The optimistic unpin must continue masking that stale row.
    active.sessions = [
      makeSession('pinned-session', {
        displayName: 'Pinned session',
        isPinned: false,
      }),
    ];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();
    expect(pinnedListTitles()).toEqual([]);
    expect(sessionTitleCount('Pinned session')).toBe(1);

    pinned.sessions = [];
    pinned.data = pinned.sessions;
    renderSidebar();
    await flushSidebar();
    expect(pinnedListTitles()).toEqual([]);
    expect(sessionTitleCount('Pinned session')).toBe(1);
  });

  it('uses the settle-time catalog baseline after an in-flight page change', async () => {
    active.sessions = [makeSession('plain', { displayName: 'Plain session' })];
    active.data = active.sessions;
    let resolvePin: (() => void) | undefined;
    workspaceActions.updateSessionOrganization.mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePin = resolve;
      }),
    );

    renderSidebar();
    await flushSidebar();
    act(() => click(findSessionPinButton('Plain session')));
    await flushSidebar();
    expect(pinnedListTitles()).toEqual(['Plain session']);

    // A catalog update swaps the tracked page while the RPC is pending. The
    // settle-time baseline must capture this new page, rather than the page
    // from the click-time closure.
    active.sessions = [
      makeSession('plain', {
        displayName: 'Plain session',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    ];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    act(() => resolvePin?.());
    await flushSidebar();

    expect(pinnedListTitles()).toEqual(['Plain session']);
    expect(sessionTitleCount('Plain session')).toBe(1);
  });

  it('keeps one row when the authoritative pinned page lands after an optimistic pin', async () => {
    active.sessions = [makeSession('plain', { displayName: 'Plain session' })];
    active.data = active.sessions;
    workspaceActions.updateSessionOrganization.mockResolvedValue({});

    renderSidebar();
    await flushSidebar();

    act(() => click(findSessionPinButton('Plain session')));
    await flushSidebar();
    expect(pinnedListTitles()).toEqual(['Plain session']);

    // The post-toggle catalog refresh lands: the pinned page now carries the
    // authoritative row. No duplicate row may appear.
    pinned.sessions = [
      makeSession('plain', {
        displayName: 'Plain session',
        isPinned: true,
        pinnedAt: '2026-01-06T00:00:00.000Z',
      }),
    ];
    pinned.data = pinned.sessions;
    active.sessions = [];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    expect(pinnedListTitles()).toEqual(['Plain session']);
    expect(sessionTitleCount('Plain session')).toBe(1);
  });

  it('keeps a settled pin when churn refreshes only the row-carrying page', async () => {
    // patchSession (prompt admission, rename) and live-state ticks recreate
    // only the pages carrying the touched row and never touch isPinned. Such
    // churn is not the post-toggle refresh: the pinned page keeps its
    // reference, so the settled entry must survive it.
    active.sessions = [makeSession('plain', { displayName: 'Plain session' })];
    active.data = active.sessions;
    workspaceActions.updateSessionOrganization.mockResolvedValue({});

    renderSidebar();
    await flushSidebar();
    act(() => click(findSessionPinButton('Plain session')));
    await flushSidebar();
    expect(pinnedListTitles()).toEqual(['Plain session']);

    active.sessions = [
      makeSession('plain', {
        displayName: 'Plain session',
        isPinned: false,
        hasActivePrompt: true,
      }),
    ];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    expect(pinnedListTitles()).toEqual(['Plain session']);
    expect(sessionTitleCount('Plain session')).toBe(1);
  });

  it('keeps a settled unpin while only the pinned page has refreshed', async () => {
    // The row is carried by both pages. When the pinned-page refetch lands
    // first, the stale all-sessions row (still isPinned) must not surface in
    // the pinned section until its own page refreshes.
    const row = makeSession('pinned-session', {
      displayName: 'Pinned session',
      isPinned: true,
      pinnedAt: '2026-01-01T00:00:00.000Z',
    });
    pinned.sessions = [row];
    pinned.data = pinned.sessions;
    active.sessions = [row];
    active.data = active.sessions;
    workspaceActions.updateSessionOrganization.mockResolvedValue({});

    renderSidebar();
    await flushSidebar();
    expect(pinnedListTitles()).toEqual(['Pinned session']);

    act(() => click(findSessionPinButton('Pinned session')));
    await flushSidebar();
    expect(pinnedListTitles()).toEqual([]);

    pinned.sessions = [];
    pinned.data = pinned.sessions;
    renderSidebar();
    await flushSidebar();

    expect(pinnedListTitles()).toEqual([]);
    expect(sessionTitleCount('Pinned session')).toBe(1);
  });

  it('keeps a settled unpin across a scope shift and does not re-expose stale pages', async () => {
    // Switching scopes disables the pinned query (page becomes undefined) and
    // reshapes the all-sessions page into one that cannot carry the row. That
    // absence is not evidence: the entry must survive, and switching back to
    // the still-stale baseline pages must not unpin the row again.
    const row = makeSession('plain', {
      displayName: 'Plain session',
      isPinned: true,
      pinnedAt: '2026-01-01T00:00:00.000Z',
    });
    const pinnedRows = [row];
    const activeRows = [row];
    pinned.sessions = pinnedRows;
    pinned.data = pinned.sessions;
    active.sessions = activeRows;
    active.data = active.sessions;
    workspaceActions.updateSessionOrganization.mockResolvedValue({});

    renderSidebar();
    await flushSidebar();
    act(() => click(findSessionPinButton('Plain session')));
    await flushSidebar();
    expect(pinnedListTitles()).toEqual([]);

    // Scope shift: pinned query disabled, reshaped all-page drops the row.
    pinned.data = undefined;
    active.sessions = [];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();
    expect(pinnedListTitles()).toEqual([]);

    // Switching back re-exposes the stale baseline pages (same references).
    pinned.sessions = pinnedRows;
    pinned.data = pinned.sessions;
    active.sessions = activeRows;
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    expect(pinnedListTitles()).toEqual([]);
  });

  it('reconciles an unpin whose row leaves every list, and never hides a later re-pin', async () => {
    // Rows that exist only in the pinned page (e.g. secondary-workspace rows
    // are absent from the primary all-sessions page): once unpinned, the
    // refresh drops them from the pinned page and no list carries them, so
    // absence is the only reconciliation signal.
    const row = makeSession('only-pinned', {
      displayName: 'Only pinned',
      isPinned: true,
      pinnedAt: '2026-01-01T00:00:00.000Z',
    });
    pinned.sessions = [row];
    pinned.data = pinned.sessions;
    workspaceActions.updateSessionOrganization.mockResolvedValue({});

    renderSidebar();
    await flushSidebar();
    expect(pinnedListTitles()).toEqual(['Only pinned']);

    act(() => click(findSessionPinButton('Only pinned')));
    await flushSidebar();
    expect(pinnedListTitles()).toEqual([]);

    // The refresh lands and the pinned page drops the row.
    pinned.sessions = [];
    pinned.data = pinned.sessions;
    renderSidebar();
    await flushSidebar();

    // Another client re-pins the session; a stale optimistic unpin entry
    // must not hide it.
    pinned.sessions = [
      makeSession('only-pinned', {
        displayName: 'Only pinned',
        isPinned: true,
        pinnedAt: '2026-01-08T00:00:00.000Z',
      }),
    ];
    pinned.data = pinned.sessions;
    renderSidebar();
    await flushSidebar();

    expect(pinnedListTitles()).toEqual(['Only pinned']);
  });
});
