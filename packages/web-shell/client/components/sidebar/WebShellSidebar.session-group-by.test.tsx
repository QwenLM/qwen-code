// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import {
  clickSidebarElement,
  flushSidebar,
  installSidebarDomShims,
  resolveWebShellSessions,
} from '../../test/sidebarHarness';
import type { ActivityEntry } from './activity-model';

const { connection, workspace, workspaceActions, active, activity } =
  vi.hoisted(() => {
    const active = {
      sessions: [] as DaemonSessionSummary[],
      data: [] as DaemonSessionSummary[] | undefined,
      loading: false,
      error: null as Error | null,
      reload: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(true),
      archiveSession: vi.fn().mockResolvedValue(true),
      unarchiveSession: vi.fn().mockResolvedValue(true),
      exportSession: vi.fn(),
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
              workspaces?: DaemonWorkspaceCapability[];
            }
          | undefined,
      },
      workspace: {
        baseUrl: '',
        capabilities: undefined as
          | {
              qwenCodeVersion: string;
              features: string[];
              workspaces?: DaemonWorkspaceCapability[];
            }
          | undefined,
        client: {
          getWorkspaceOrder: vi.fn().mockResolvedValue({ cwds: [] }),
          setWorkspaceOrder: vi.fn().mockResolvedValue({ cwds: [] }),
          searchWorkspaceSessions: vi.fn().mockResolvedValue({ results: [] }),
          workspaceByCwd: vi.fn(() => ({
            listWorkspaceSessions: vi.fn().mockResolvedValue([]),
            workspaceGit: vi
              .fn()
              .mockResolvedValue({ v: 2, workspaceCwd: '', branch: null }),
            listSessionGroups: vi
              .fn()
              .mockResolvedValue({ groups: [], colorOptions: [] }),
            updateSessionOrganization: vi.fn().mockResolvedValue({}),
            workspaceChannelTypes: vi.fn().mockResolvedValue([]),
            workspaceChannels: vi
              .fn()
              .mockResolvedValue({ revision: '0', instances: {} }),
          })),
        },
        refreshCapabilities: vi.fn(),
      },
      workspaceActions: {
        addWorkspace: vi.fn(),
        updateWorkspace: vi.fn(),
        removeWorkspace: vi.fn(),
        listSessionGroups: vi
          .fn()
          .mockResolvedValue({ groups: [], colorOptions: [] }),
        updateSessionOrganization: vi.fn().mockResolvedValue({}),
      },
      active,
      activity: {
        entries: [] as ActivityEntry[],
        open: false,
        loading: false,
        unavailable: false,
        hasMore: false,
        retry: vi.fn(),
        archive: vi.fn(),
        undo: vi.fn(),
        loadPreview: vi.fn(),
      },
    };
  });

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DAEMON_APPROVAL_MODES: ['default', 'plan', 'auto-edit', 'auto', 'yolo'],
  useConnection: () => connection,
  useActions: () => ({ renameSession: vi.fn() }),
  useWorkspace: () => workspace,
  useWorkspaceActions: () => workspaceActions,
  useSessions: () => active,
  useChannels: () => ({ data: undefined, catalog: [], channels: {} }),
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

vi.mock('./use-activity-catalog', () => ({
  activityKey: (workspaceCwd: string, sessionId: string) =>
    JSON.stringify([workspaceCwd, sessionId]),
  useActivityCatalog: (options: { open: boolean }) => {
    activity.open = options.open;
    return activity;
  },
}));

vi.mock('./SessionSearchDialog', () => ({
  SessionSearchDialog: (props: {
    onSelect: (value: {
      session: { sessionId: string };
      workspaceCwd: string;
    }) => void;
  }) => (
    <button
      data-testid="session-search-result"
      onClick={() =>
        props.onSelect({
          session: { sessionId: 'search-hit' },
          workspaceCwd: '/tmp/project',
        })
      }
    >
      Search result
    </button>
  ),
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
    'session_organization',
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
const onLoadSession = vi.fn();

function renderSidebar(
  overrides: Partial<ComponentProps<typeof WebShellSidebar>> = {},
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
          onLeaveCurrentStandaloneForDelete={async () => false}
          onLoadSession={onLoadSession}
          onError={() => {}}
          sessionActions={{ inlineItems: ['pin'] }}
          {...overrides}
        />
      </I18nProvider>,
    );
  });
}

function activityEntry(
  sessionId: string,
  workspaceCwd: string,
  extra: Partial<DaemonSessionSummary> = {},
): ActivityEntry {
  const session = {
    sessionId,
    workspaceCwd,
    displayName: sessionId,
    updatedAt: localDay(0),
    ...extra,
  } as DaemonSessionSummary;
  return { key: JSON.stringify([workspaceCwd, sessionId]), session };
}

function localDay(offset: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date.toISOString();
}

function workspaceCwds(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-sidebar-workspace]'),
  ).map((row) => row.getAttribute('data-sidebar-workspace') ?? '');
}

async function openDisplayMenu(): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Display options"]',
  );
  expect(trigger).not.toBeNull();
  await act(async () => {
    clickSidebarElement(trigger!, true);
    await Promise.resolve();
  });
}

async function openGroupBy(): Promise<void> {
  await openDisplayMenu();
  const trigger = Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((item) => item.textContent?.startsWith('Group by'));
  expect(trigger).toBeDefined();
  await act(async () => {
    trigger!.focus();
    trigger!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    await Promise.resolve();
  });
}

async function selectGroupBy(label: string): Promise<void> {
  await openGroupBy();
  const item = Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
  ).find((candidate) => candidate.textContent === label);
  expect(item).toBeDefined();
  await act(async () => {
    clickSidebarElement(item!, true);
    await Promise.resolve();
  });
  await flushSidebar();
}

async function selectWorkspaceFilter(label: string): Promise<void> {
  await openDisplayMenu();
  const trigger = Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((item) => item.textContent?.startsWith('Workspace'));
  expect(trigger).toBeDefined();
  await act(async () => {
    trigger!.focus();
    trigger!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    await Promise.resolve();
  });
  const item = Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
  ).find((candidate) => candidate.textContent === label);
  expect(item).toBeDefined();
  await act(async () => {
    clickSidebarElement(item!, true);
    await Promise.resolve();
  });
  await flushSidebar();
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  connection.sessionId = null;
  connection.workspaceCwd = '/tmp/project';
  connection.capabilities = capabilities;
  workspace.capabilities = capabilities;
  workspace.baseUrl = '';
  active.sessions = [];
  active.data = [];
  active.loading = false;
  active.error = null;
  activity.entries = [];
  activity.open = false;
  activity.loading = false;
  activity.unavailable = false;
  activity.hasMore = false;
  activity.retry.mockClear();
  onLoadSession.mockClear();
  workspaceActions.updateSessionOrganization.mockReset().mockResolvedValue({});
  workspace.client.getWorkspaceOrder
    .mockReset()
    .mockResolvedValue({ cwds: [] });
  workspace.client.setWorkspaceOrder
    .mockReset()
    .mockResolvedValue({ cwds: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('WebShellSidebar session grouping', () => {
  it('renders cross-workspace date groups with full rows and preserves search and outer sections', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [...capabilities.features, 'session_source_metadata'],
    };
    workspace.capabilities = connection.capabilities;
    localStorage.setItem(
      `web-shell:session-group-by:${window.location.origin}`,
      'activityDate',
    );
    const pinned = activityEntry('pinned', '/tmp/project', {
      isPinned: true,
    });
    activity.entries = [
      activityEntry('alpha', '/tmp/project'),
      activityEntry('beta', '/tmp/second', {
        updatedAt: localDay(0),
        parentSessionId: 'parent',
      }),
      pinned,
      activityEntry('scheduled', '/tmp/project', {
        sourceType: 'default',
        sourceId: 'scheduled_task_run:job',
      }),
      activityEntry('voice', '/tmp/project', {
        sourceId: 'realtime_voice:call',
      }),
      activityEntry('channel', '/tmp/project', { sourceType: 'channel' }),
    ];
    active.sessions = [pinned.session];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();
    expect(activity.open).toBe(true);
    expect(workspaceCwds()).toEqual([]);
    const today = container.querySelector<HTMLElement>(
      'section[aria-label="Today"]',
    );
    expect(today?.textContent).toContain('alpha');
    expect(today?.textContent).toContain('beta');
    expect(today?.textContent).not.toContain('pinned');
    expect(today?.textContent).not.toContain('scheduled');
    expect(today?.textContent).not.toContain('voice');
    expect(today?.textContent).not.toContain('channel');
    expect(
      today?.querySelector('button[aria-label="More actions"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Pinned');
    expect(
      container.querySelector('[data-testid="recent-sessions"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Collapse all workspaces"]'),
    ).toBeNull();

    const search = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Search sessions"]',
    )!;
    await act(async () => search.click());
    const result = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="session-search-result"]',
    )!;
    await act(async () => result.click());
    expect(onLoadSession.mock.calls[0]?.slice(0, 2)).toEqual([
      'search-hit',
      '/tmp/project',
    ]);
  });

  it('switches modes, persists the choice, and restores workspace sections', async () => {
    activity.entries = [activityEntry('alpha', '/tmp/project')];
    renderSidebar();
    await flushSidebar();
    expect(workspaceCwds()).toEqual(['/tmp/project', '/tmp/second']);
    expect(
      container.querySelector('span[aria-label="2 workspaces"]'),
    ).not.toBeNull();
    await selectGroupBy('Activity date');
    expect(workspaceCwds()).toEqual([]);
    expect(activity.open).toBe(true);
    expect(container.textContent).toContain('Recent conversations');
    expect(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Workspaces',
      ),
    ).toBeUndefined();
    expect(
      container.querySelector('span[aria-label="2 workspaces"]'),
    ).toBeNull();
    expect(
      localStorage.getItem(
        `web-shell:session-group-by:${window.location.origin}`,
      ),
    ).toBe('activityDate');
    await selectGroupBy('Workspace');
    expect(workspaceCwds()).toEqual(['/tmp/project', '/tmp/second']);
    expect(activity.open).toBe(false);
    expect(container.textContent).not.toContain('Recent conversations');
    expect(
      container.querySelector('span[aria-label="2 workspaces"]'),
    ).not.toBeNull();
  });

  it('offers grouping with one workspace and no other optional display features', async () => {
    connection.capabilities = {
      ...capabilities,
      workspaces: capabilities.workspaces.slice(0, 1),
    };
    workspace.capabilities = connection.capabilities;
    activity.entries = [activityEntry('alpha', '/tmp/project')];
    renderSidebar();
    await flushSidebar();
    await selectGroupBy('Activity date');
    expect(workspaceCwds()).toEqual([]);
    expect(container.textContent).toContain('alpha');
  });

  it('applies original and optimistic pin state before date filtering', async () => {
    const organizationWrites: Array<() => void> = [];
    workspaceActions.updateSessionOrganization.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          organizationWrites.push(resolve);
        }),
    );
    localStorage.setItem(
      `web-shell:session-group-by:${window.location.origin}`,
      'activityDate',
    );
    const candidate = activityEntry('candidate', '/tmp/project');
    const originalPinned = activityEntry('original-pinned', '/tmp/project', {
      isPinned: true,
    });
    activity.entries = [candidate, originalPinned];
    active.sessions = [candidate.session, originalPinned.session];
    active.data = active.sessions;
    const setCandidatePinned = (pinned: boolean) => {
      const update = (session: DaemonSessionSummary) =>
        session.sessionId === 'candidate'
          ? { ...session, isPinned: pinned }
          : session;
      activity.entries = activity.entries.map((entry) => ({
        ...entry,
        session: update(entry.session),
      }));
      active.sessions = active.sessions.map(update);
      active.data = active.sessions;
      renderSidebar();
    };
    renderSidebar();
    await flushSidebar();
    expect(
      container.querySelector('section[aria-label="Today"]')?.textContent,
    ).toContain('candidate');
    expect(
      container.querySelector('section[aria-label="Today"]')?.textContent,
    ).not.toContain('original-pinned');

    const pin = container.querySelector<HTMLButtonElement>(
      'section[aria-label="Today"] button[aria-label="Pin"]',
    )!;
    await act(async () => pin.click());
    await flushSidebar();
    expect(
      container.querySelector('section[aria-label="Today"]')?.textContent ?? '',
    ).not.toContain('candidate');
    expect(organizationWrites).toHaveLength(1);
    setCandidatePinned(true);
    organizationWrites[0]!();
    await flushSidebar();

    const unpin = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Unpin"]',
      ),
    ).find((button) =>
      button
        .closest('[class*="sessionRow"]')
        ?.textContent?.includes('candidate'),
    )!;
    await act(async () => unpin.click());
    await flushSidebar();
    expect(
      container.querySelector('section[aria-label="Today"]')?.textContent,
    ).toContain('candidate');
    expect(organizationWrites).toHaveLength(2);
    setCandidatePinned(false);
    organizationWrites[1]!();
    await flushSidebar();
    expect(
      container.querySelector('section[aria-label="Today"]')?.textContent,
    ).toContain('candidate');
  });

  it('tracks completion only for sessions rendered in date mode', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [...capabilities.features, 'session_source_metadata'],
    };
    workspace.capabilities = connection.capabilities;
    localStorage.setItem(
      `web-shell:session-group-by:${window.location.origin}`,
      'activityDate',
    );
    const channel = activityEntry('channel', '/tmp/project', {
      sourceType: 'channel',
      hasActivePrompt: true,
    });
    activity.entries = [channel];
    renderSidebar({ collapsed: true, layout: 'rail' });
    await flushSidebar();
    activity.entries = [
      {
        ...channel,
        session: { ...channel.session, hasActivePrompt: false },
      },
    ];
    renderSidebar({ collapsed: true, layout: 'rail' });
    await flushSidebar();
    const homeTrigger = container.querySelector<HTMLElement>(
      '[data-web-shell-home-trigger]',
    )!;
    expect(homeTrigger.getAttribute('aria-label')).not.toContain('Finished');

    const ordinary = activityEntry('ordinary', '/tmp/project', {
      hasActivePrompt: true,
    });
    activity.entries = [ordinary];
    renderSidebar({ collapsed: true, layout: 'rail' });
    await flushSidebar();
    activity.entries = [
      {
        ...ordinary,
        session: { ...ordinary.session, hasActivePrompt: false },
      },
    ];
    renderSidebar({ collapsed: true, layout: 'rail' });
    await flushSidebar();
    expect(homeTrigger.getAttribute('aria-label')).toContain('Finished');
  });

  it('keeps date groups visible when the workspace section was collapsed', async () => {
    localStorage.setItem(
      'qwen.web-shell.sidebar.workspace-expanded:projects',
      'false',
    );
    localStorage.setItem(
      `web-shell:session-group-by:${window.location.origin}`,
      'activityDate',
    );
    activity.entries = [activityEntry('alpha', '/tmp/project')];
    renderSidebar();
    await flushSidebar();
    const today = container.querySelector<HTMLElement>(
      'section[aria-label="Today"]',
    );
    expect(today).not.toBeNull();
    expect(today!.closest('[hidden]')).toBeNull();
    expect(container.textContent).toContain('Recent conversations');
    expect(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Workspaces',
      ),
    ).toBeUndefined();
  });

  it('falls back to Workspace when a visible workspace is untrusted', async () => {
    localStorage.setItem(
      `web-shell:session-group-by:${window.location.origin}`,
      'activityDate',
    );
    connection.capabilities = {
      ...capabilities,
      workspaces: capabilities.workspaces.map((entry, index) => ({
        ...entry,
        trusted: index === 0,
      })),
    };
    workspace.capabilities = connection.capabilities;
    renderSidebar();
    await flushSidebar();
    expect(activity.open).toBe(false);
    expect(workspaceCwds()).toEqual(['/tmp/project', '/tmp/second']);
    await openDisplayMenu();
    expect(
      Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).some((item) => item.textContent?.startsWith('Group by')),
    ).toBe(false);
  });

  it('falls back when organized sessions lack qualified REST support', async () => {
    connection.capabilities = {
      ...capabilities,
      features: capabilities.features.filter(
        (feature) => feature !== 'workspace_qualified_rest_core',
      ),
    };
    workspace.capabilities = connection.capabilities;
    localStorage.setItem(
      `web-shell:session-group-by:${window.location.origin}`,
      'activityDate',
    );
    renderSidebar();
    await flushSidebar();
    expect(activity.open).toBe(false);
    expect(workspaceCwds()).toEqual(['/tmp/project', '/tmp/second']);
    await openDisplayMenu();
    expect(
      Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).some((item) => item.textContent?.startsWith('Group by')),
    ).toBe(false);
  });

  it('falls back when the home source switch selects channels', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [
        ...capabilities.features,
        'session_source_metadata',
        'channel_management',
      ],
    };
    workspace.capabilities = connection.capabilities;
    localStorage.setItem(
      `web-shell:session-group-by:${window.location.origin}`,
      'activityDate',
    );
    activity.entries = [activityEntry('alpha', '/tmp/project')];
    renderSidebar();
    await flushSidebar();
    expect(activity.open).toBe(true);
    const channelTab = Array.from(
      container.querySelectorAll<HTMLElement>('[role="tab"]'),
    ).find((tab) => tab.textContent === 'Channels')!;
    await act(async () => {
      channelTab.focus();
      channelTab.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      await Promise.resolve();
    });
    await flushSidebar();
    expect(channelTab.getAttribute('aria-selected')).toBe('true');
    expect(activity.open).toBe(false);
    expect(workspaceCwds()).toEqual(['/tmp/project', '/tmp/second']);
    await openDisplayMenu();
    expect(
      Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).some((item) => item.textContent?.startsWith('Group by')),
    ).toBe(false);
  });

  it('falls back for channel, managed, and empty project scopes', async () => {
    const scopedCapabilities = {
      ...capabilities,
      features: [
        ...capabilities.features,
        'session_source_metadata',
        'channel_management',
      ],
    };
    connection.capabilities = scopedCapabilities;
    workspace.capabilities = scopedCapabilities;
    localStorage.setItem(
      `web-shell:session-group-by:${window.location.origin}`,
      'activityDate',
    );
    renderSidebar({ activePage: 'channels', layout: 'rail' });
    await flushSidebar();
    expect(activity.open).toBe(false);
    expect(workspaceCwds()).toEqual(['/tmp/project', '/tmp/second']);

    renderSidebar({
      activePage: 'home',
      managedWorkspaces: <div>Managed sessions</div>,
    });
    await flushSidebar();
    expect(activity.open).toBe(false);
    expect(workspaceCwds()).toEqual(['/tmp/project', '/tmp/second']);

    connection.capabilities = scopedCapabilities;
    workspace.capabilities = scopedCapabilities;
    renderSidebar({ activePage: 'home', managedWorkspaces: undefined });
    await flushSidebar();
    await selectWorkspaceFilter('No workspace');
    expect(activity.open).toBe(false);
    expect(workspaceCwds()).toEqual([]);
    await openDisplayMenu();
    expect(
      Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).some((item) => item.textContent?.startsWith('Group by')),
    ).toBe(false);
  });
});
