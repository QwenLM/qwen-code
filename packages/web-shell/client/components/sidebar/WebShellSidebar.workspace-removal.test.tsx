// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import {
  DaemonHttpError,
  type DaemonSessionSummary,
  type DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';

const {
  connection,
  workspace,
  workspaceActions,
  active,
  archived,
  useSessions,
  listWorkspaceSessions,
  archiveSessionsData,
  unarchiveSessionsData,
  deleteSessionsData,
  updateSessionOrganization,
  exportSession,
  exportArchivedSession,
  sessionActions,
} = vi.hoisted(() => {
  const makeSessions = () => ({
    sessions: [] as DaemonSessionSummary[],
    loading: false,
    error: null,
    reload: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(true),
    archiveSession: vi.fn().mockResolvedValue(true),
    unarchiveSession: vi.fn().mockResolvedValue(true),
    exportSession: vi.fn(),
  });
  const listWorkspaceSessions = vi.fn().mockResolvedValue([]);
  const archiveSessionsData = vi.fn().mockResolvedValue({
    archived: [],
    alreadyArchived: [],
    notFound: [],
    errors: [],
  });
  const unarchiveSessionsData = vi.fn().mockResolvedValue({
    unarchived: [],
    alreadyActive: [],
    notFound: [],
    errors: [],
  });
  const deleteSessionsData = vi.fn().mockResolvedValue({
    removed: [],
    notFound: [],
    errors: [],
  });
  const updateSessionOrganization = vi.fn().mockResolvedValue({});
  const exportSession = vi.fn();
  const active = makeSessions();
  const archived = makeSessions();
  const useSessions = vi.fn((options?: { archiveState?: string }) =>
    options?.archiveState === 'archived' ? archived : active,
  );
  const exportArchivedSession = vi.fn();
  const sessionActions = { renameSession: vi.fn() };
  return {
    connection: {
      status: 'connected',
      sessionId: null as string | null,
      workspaceCwd: '/tmp/project',
      capabilities: undefined as
        | {
            qwenCodeVersion: string;
            features: string[];
            workspaceCwd?: string;
            workspaces?: DaemonWorkspaceCapability[];
          }
        | undefined,
    },
    workspace: {
      capabilities: undefined as
        | {
            qwenCodeVersion: string;
            features: string[];
            workspaceCwd?: string;
            workspaces?: DaemonWorkspaceCapability[];
          }
        | undefined,
      client: {
        workspaceByCwd: vi.fn(() => ({
          listWorkspaceSessions,
          listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
          archiveSessionsData,
          unarchiveSessionsData,
          exportArchivedSession,
        })),
      },
      refreshCapabilities: vi.fn(),
    },
    workspaceActions: {
      addWorkspace: vi.fn(),
      removeWorkspace: vi.fn(),
      listSessionGroups: vi.fn(),
    },
    active,
    archived,
    useSessions,
    listWorkspaceSessions,
    archiveSessionsData,
    unarchiveSessionsData,
    deleteSessionsData,
    updateSessionOrganization,
    exportSession,
    exportArchivedSession,
    sessionActions,
  };
});

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => connection,
  useActions: () => sessionActions,
  useWorkspace: () => workspace,
  useWorkspaceActions: () => workspaceActions,
  useSessions,
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

const capabilities = {
  qwenCodeVersion: '1.2.3',
  features: [
    'multi_workspace_sessions',
    'workspace_runtime_removal',
    'session_archive',
    'workspace_qualified_rest_core',
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
      id: 'secondary',
      cwd: '/tmp/other',
      primary: false,
      trusted: true,
      removable: true,
    },
    {
      id: 'untrusted',
      cwd: '/tmp/danger',
      primary: false,
      trusted: false,
      removable: true,
    },
  ],
} satisfies NonNullable<typeof workspace.capabilities>;

let root: Root;
let container: HTMLDivElement;

function renderSidebar(
  overrides: {
    selectedWorkspaceCwd?: string;
    onSelectWorkspace?: (cwd: string | undefined) => void;
    onError?: (error: unknown, message: string) => void;
    onOpenGoals?: () => void;
    onOpenAddWorkspace?: () => void;
    onNewSession?: (workspaceCwd?: string) => boolean;
    workspaces?: DaemonWorkspaceCapability[];
    lockedWorkspaceCwd?: string;
    lockedWorkspace?: {
      render?: (workspace: DaemonWorkspaceCapability) => ReactNode;
    };
    sessionActions?: {
      items?: readonly (
        | 'pin'
        | 'archive'
        | 'details'
        | 'rename'
        | 'group'
        | 'export'
        | 'delete'
      )[];
      inlineItems?: readonly (
        | 'pin'
        | 'archive'
        | 'rename'
        | 'export'
        | 'delete'
      )[];
    };
  } = {},
) {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WebShellSidebar
          collapsed={false}
          onCollapsedChange={() => {}}
          onOpenSettings={() => {}}
          onOpenDaemonStatus={() => {}}
          onOpenScheduledTasks={() => {}}
          onOpenGoals={overrides.onOpenGoals ?? (() => {})}
          onOpenSessions={() => {}}
          onOpenSplitView={() => {}}
          onNewSession={overrides.onNewSession ?? (() => false)}
          onLoadSession={() => {}}
          onError={overrides.onError ?? (() => {})}
          selectedWorkspaceCwd={overrides.selectedWorkspaceCwd}
          onSelectWorkspace={overrides.onSelectWorkspace}
          onOpenAddWorkspace={overrides.onOpenAddWorkspace}
          workspaces={overrides.workspaces}
          lockedWorkspaceCwd={overrides.lockedWorkspaceCwd}
          lockedWorkspace={overrides.lockedWorkspace}
          sessionActions={overrides.sessionActions}
        />
      </I18nProvider>,
    );
  });
}

function workspaceAction(cwd: string): HTMLButtonElement | undefined {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Workspace actions"]',
    ),
  ).find((button) =>
    button.parentElement?.parentElement?.textContent?.includes(
      cwd.split('/').at(-1)!,
    ),
  );
}

function click(element: HTMLElement): void {
  element.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
  );
  element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function expandWorkspace(name: string): Promise<void> {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).find((candidate) => candidate.textContent?.includes(name));
  expect(button).toBeDefined();
  await act(async () => {
    click(button!);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function ensureWorkspaceExpanded(name: string): Promise<void> {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).find((candidate) => candidate.textContent?.includes(name));
  expect(button).toBeDefined();
  if (button?.getAttribute('aria-expanded') !== 'true') {
    await act(async () => {
      click(button);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

function archiveButtonFor(label: string): HTMLButtonElement | undefined {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Archive"]',
    ),
  ).find((button) =>
    button.closest('[role="button"]')?.textContent?.includes(label),
  );
}

async function expandArchived(): Promise<void> {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).find((candidate) => candidate.textContent?.includes('Archived'));
  expect(button).toBeDefined();
  await act(async () => {
    click(button!);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function sessionAction(label: string): HTMLButtonElement | undefined {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="More actions"]',
    ),
  ).find((button) =>
    button
      .closest<HTMLElement>('[class*="sessionRow"]')
      ?.textContent?.includes(label),
  );
}

function inlineSessionAction(
  label: string,
  action: string,
): HTMLButtonElement | undefined {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      `button[aria-label="${action}"]`,
    ),
  ).find((button) =>
    button
      .closest<HTMLElement>('[class*="sessionRow"]')
      ?.textContent?.includes(label),
  );
}

async function selectSessionMenuItem(
  label: string,
  itemLabel: string,
): Promise<void> {
  const trigger = sessionAction(label);
  expect(trigger).toBeDefined();
  await act(async () => {
    click(trigger!);
    await Promise.resolve();
  });
  const item = Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((candidate) => candidate.textContent?.includes(itemLabel));
  expect(item).toBeDefined();
  await act(async () => {
    click(item!);
    await Promise.resolve();
  });
}

async function openSessionMenuItems(label: string): Promise<string[]> {
  const trigger = sessionAction(label);
  expect(trigger).toBeDefined();
  await act(async () => {
    click(trigger!);
    await Promise.resolve();
  });
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).map((item) => item.textContent ?? '');
}

function useWorkspaceSessionCatalog(
  resolve: (
    cwd: string,
    options?: { archiveState?: string; group?: string },
  ) => Promise<DaemonSessionSummary[]>,
): void {
  workspace.client.workspaceByCwd.mockImplementation((cwd: string) => ({
    listWorkspaceSessions: (options?: {
      archiveState?: string;
      group?: string;
    }) => {
      void listWorkspaceSessions(cwd, options);
      return resolve(cwd, options);
    },
    listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
    archiveSessionsData,
    unarchiveSessionsData,
    deleteSessionsData,
    updateSessionOrganization,
    exportSession,
    exportArchivedSession,
  }));
}

function openRemoval(cwd: string): void {
  const trigger = workspaceAction(cwd);
  expect(trigger).toBeDefined();
  act(() => click(trigger!));
  const item = document.body.querySelector<HTMLDivElement>(
    `[aria-label="Remove workspace: ${cwd}"]`,
  );
  expect(item).not.toBeNull();
  act(() => click(item!));
}

function dialogButton(label: string): HTMLButtonElement {
  const button = Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('button'),
  ).find((candidate) => candidate.textContent === label);
  expect(button).toBeDefined();
  return button!;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  connection.sessionId = null;
  connection.workspaceCwd = '/tmp/project';
  connection.capabilities = capabilities;
  workspace.capabilities = capabilities;
  workspace.refreshCapabilities.mockReset();
  workspace.refreshCapabilities.mockResolvedValue(capabilities);
  workspace.client.workspaceByCwd.mockReset();
  listWorkspaceSessions.mockReset();
  listWorkspaceSessions.mockResolvedValue([]);
  archiveSessionsData.mockReset();
  archiveSessionsData.mockResolvedValue({
    archived: [],
    alreadyArchived: [],
    notFound: [],
    errors: [],
  });
  unarchiveSessionsData.mockReset();
  unarchiveSessionsData.mockResolvedValue({
    unarchived: [],
    alreadyActive: [],
    notFound: [],
    errors: [],
  });
  deleteSessionsData.mockReset();
  deleteSessionsData.mockResolvedValue({
    removed: [],
    notFound: [],
    errors: [],
  });
  updateSessionOrganization.mockReset();
  updateSessionOrganization.mockResolvedValue({});
  exportSession.mockReset();
  sessionActions.renameSession.mockReset();
  sessionActions.renameSession.mockResolvedValue(undefined);
  exportArchivedSession.mockReset();
  workspace.client.workspaceByCwd.mockImplementation(() => ({
    listWorkspaceSessions,
    listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
    archiveSessionsData,
    unarchiveSessionsData,
    deleteSessionsData,
    updateSessionOrganization,
    exportSession,
    exportArchivedSession,
  }));
  workspaceActions.removeWorkspace.mockReset();
  workspaceActions.removeWorkspace.mockResolvedValue({ removed: true });
  workspaceActions.addWorkspace.mockReset();
  workspaceActions.addWorkspace.mockResolvedValue({ persisted: true });
  active.reload.mockReset();
  active.reload.mockResolvedValue(undefined);
  active.deleteSession.mockReset();
  active.deleteSession.mockResolvedValue(true);
  active.archiveSession.mockReset();
  active.archiveSession.mockResolvedValue(true);
  active.unarchiveSession.mockReset();
  active.unarchiveSession.mockResolvedValue(true);
  active.exportSession.mockReset();
  archived.reload.mockReset();
  archived.reload.mockResolvedValue(undefined);
  useSessions.mockClear();
  active.sessions.length = 0;
  archived.sessions.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WebShellSidebar workspace removal', () => {
  it('delegates Add workspace to the App-owned dialog', () => {
    const onOpenAddWorkspace = vi.fn();
    renderSidebar({ onOpenAddWorkspace });

    const addButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add workspace"]',
    );
    expect(addButton).not.toBeNull();
    act(() => click(addButton!));

    expect(onOpenAddWorkspace).toHaveBeenCalledOnce();
  });

  it('scopes pinned and archived sessions to a locked secondary workspace', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [...capabilities.features, 'session_organization'],
    };
    active.sessions.push({
      sessionId: 'primary-pinned',
      displayName: 'Primary pinned',
      workspaceCwd: '/tmp/project',
    });
    archived.sessions.push({
      sessionId: 'primary-archived',
      displayName: 'Primary archived',
      workspaceCwd: '/tmp/project',
      isArchived: true,
    });
    const listSecondarySessions = vi.fn(
      async (options?: { archiveState?: string; group?: string }) => {
        if (options?.group === 'pinned') {
          return [
            {
              sessionId: 'secondary-pinned',
              displayName: 'Secondary pinned',
            },
          ];
        }
        if (options?.archiveState === 'archived') {
          return [
            {
              sessionId: 'secondary-archived',
              displayName: 'Secondary archived',
              isArchived: true,
            },
          ];
        }
        return [];
      },
    );
    workspace.client.workspaceByCwd.mockImplementation(() => ({
      listWorkspaceSessions: listSecondarySessions,
      listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      archiveSessionsData,
      unarchiveSessionsData,
      exportArchivedSession,
    }));

    renderSidebar({ lockedWorkspaceCwd: '/tmp/other' });
    const pinnedCallIndex = listSecondarySessions.mock.calls.findIndex(
      ([options]) => options?.group === 'pinned',
    );
    expect(pinnedCallIndex).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await listSecondarySessions.mock.results[pinnedCallIndex]?.value;
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Secondary pinned');
    expect(container.textContent).not.toContain('Primary pinned');

    const archivedButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Archived'));
    expect(archivedButton).toBeDefined();
    act(() => click(archivedButton!));
    const archivedCallIndex = listSecondarySessions.mock.calls.findIndex(
      ([options]) => options?.archiveState === 'archived',
    );
    expect(archivedCallIndex).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await listSecondarySessions.mock.results[archivedCallIndex]?.value;
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Secondary archived');
    expect(container.textContent).not.toContain('Primary archived');
    expect(
      useSessions.mock.calls.every(
        ([options]) => !Object.hasOwn(options ?? {}, 'sourceType'),
      ),
    ).toBe(true);
    expect(
      listSecondarySessions.mock.calls.every(
        ([options]) => !Object.hasOwn(options ?? {}, 'sourceType'),
      ),
    ).toBe(true);
  });

  it('gives a locked trusted secondary active row normal actions through its workspace', async () => {
    const exportResult = {
      content: '<p>secondary export</p>',
      filename: 'secondary.html',
      mimeType: 'text/html',
      format: 'html' as const,
    };
    connection.sessionId = 'current-secondary';
    connection.workspaceCwd = '/tmp/other';
    connection.capabilities = {
      ...capabilities,
      features: [
        ...capabilities.features,
        'session_organization',
        'workspace_session_export',
      ],
    };
    const primaryOrganization = vi.fn().mockResolvedValue({});
    const primaryArchive = vi.fn().mockResolvedValue({
      archived: [],
      alreadyArchived: [],
      notFound: [],
      errors: [],
    });
    const primaryExport = vi.fn().mockResolvedValue(exportResult);
    const secondaryOrganization = vi.fn().mockResolvedValue({});
    const secondaryArchive = vi.fn().mockResolvedValue({
      archived: [],
      alreadyArchived: [],
      notFound: [],
      errors: [],
    });
    const secondaryExport = vi.fn().mockResolvedValue(exportResult);
    const makeClient = (
      cwd: string,
      actions: {
        organization: ReturnType<typeof vi.fn>;
        archive: ReturnType<typeof vi.fn>;
        export: ReturnType<typeof vi.fn>;
      },
    ) => ({
      listWorkspaceSessions: async (options?: { archiveState?: string }) =>
        cwd === '/tmp/other' && options?.archiveState === 'active'
          ? [
              {
                sessionId: 'current-secondary',
                workspaceCwd: cwd,
                displayName: 'Current secondary',
              },
              {
                sessionId: 'other-secondary',
                workspaceCwd: cwd,
                displayName: 'Other secondary',
              },
            ]
          : [],
      listSessionGroups: vi.fn().mockResolvedValue({
        groups: [
          {
            id: 'secondary-group',
            name: 'Secondary group',
            color: 'blue',
          },
        ],
        colorOptions: ['blue'],
      }),
      archiveSessionsData: actions.archive,
      unarchiveSessionsData,
      deleteSessionsData,
      updateSessionOrganization: actions.organization,
      exportSession: actions.export,
      exportArchivedSession,
    });
    const primaryClient = makeClient('/tmp/project', {
      organization: primaryOrganization,
      archive: primaryArchive,
      export: primaryExport,
    });
    const secondaryClient = makeClient('/tmp/other', {
      organization: secondaryOrganization,
      archive: secondaryArchive,
      export: secondaryExport,
    });
    workspace.client.workspaceByCwd.mockImplementation((cwd: string) =>
      cwd === '/tmp/other' ? secondaryClient : primaryClient,
    );
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:secondary-export'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderSidebar({ lockedWorkspaceCwd: '/tmp/other' });
    await act(async () => {
      await Promise.resolve();
    });
    await ensureWorkspaceExpanded('other');

    expect(inlineSessionAction('Current secondary', 'Pin')).toBeDefined();
    expect(archiveButtonFor('Other secondary')).toBeDefined();
    expect(sessionAction('Current secondary')).toBeDefined();
    expect(sessionAction('Other secondary')).toBeDefined();

    await act(async () => {
      click(inlineSessionAction('Current secondary', 'Pin')!);
      await secondaryOrganization.mock.results.at(-1)?.value;
    });
    expect(secondaryOrganization).toHaveBeenCalledWith('current-secondary', {
      isPinned: true,
    });
    expect(primaryOrganization).not.toHaveBeenCalled();

    await selectSessionMenuItem('Current secondary', 'Export');
    await act(async () => {
      await secondaryExport.mock.results.at(-1)?.value;
    });
    expect(secondaryExport).toHaveBeenCalledWith('current-secondary', {
      format: 'html',
    });
    expect(primaryExport).not.toHaveBeenCalled();

    await act(async () => {
      click(archiveButtonFor('Other secondary')!);
      await secondaryArchive.mock.results.at(-1)?.value;
    });
    expect(secondaryArchive).toHaveBeenCalledWith(['other-secondary']);
    expect(primaryArchive).not.toHaveBeenCalled();
  });

  it('allows only the current locked-secondary session to rename', async () => {
    connection.sessionId = 'locked-current';
    connection.workspaceCwd = '/tmp/other';
    connection.capabilities = {
      ...capabilities,
      features: [...capabilities.features, 'session_organization'],
    };
    workspace.client.workspaceByCwd.mockImplementation((cwd: string) => ({
      listWorkspaceSessions: vi.fn().mockResolvedValue(
        cwd === '/tmp/other'
          ? [
              {
                sessionId: 'locked-current',
                workspaceCwd: cwd,
                displayName: 'Locked current',
              },
              {
                sessionId: 'locked-other',
                workspaceCwd: cwd,
                displayName: 'Locked other',
              },
            ]
          : [],
      ),
      listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      archiveSessionsData,
      unarchiveSessionsData,
      deleteSessionsData,
      updateSessionOrganization,
      exportSession,
      exportArchivedSession,
    }));

    renderSidebar({
      lockedWorkspaceCwd: '/tmp/other',
      sessionActions: {
        items: ['rename', 'delete', 'archive'],
        inlineItems: ['rename', 'delete', 'archive'],
      },
    });
    await expandWorkspace('other');

    expect(inlineSessionAction('Locked current', 'Delete')?.disabled).toBe(
      true,
    );
    expect(inlineSessionAction('Locked current', 'Archive')?.disabled).toBe(
      true,
    );
    expect(inlineSessionAction('Locked other', 'Rename')?.disabled).toBe(true);

    const currentRow = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((row) => row.textContent?.includes('Locked current'));
    await act(async () => {
      currentRow?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await Promise.resolve();
    });
    const input = container.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    await act(async () => {
      setInputValue(input!, 'Renamed locked current');
      input!
        .closest('form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      await sessionActions.renameSession.mock.results.at(-1)?.value;
    });
    expect(sessionActions.renameSession).toHaveBeenCalledWith(
      'Renamed locked current',
    );
  });

  it('does not assign a created group after its locked workspace unlocks', async () => {
    let resolveCreate!: (group: {
      id: string;
      name: string;
      color: 'blue';
    }) => void;
    const createSessionGroup = vi.fn(
      () =>
        new Promise<{ id: string; name: string; color: 'blue' }>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const secondaryOrganization = vi.fn().mockResolvedValue({});
    const primaryOrganization = vi.fn().mockResolvedValue({});
    const onError = vi.fn();
    workspaceActions.listSessionGroups.mockResolvedValue({
      groups: [],
      colorOptions: ['blue'],
    });
    Object.assign(workspaceActions, {
      updateSessionOrganization: primaryOrganization,
    });
    workspace.client.workspaceByCwd.mockImplementation((cwd: string) => ({
      listWorkspaceSessions: vi.fn().mockResolvedValue(
        cwd === '/tmp/other'
          ? [
              {
                sessionId: 'group-target',
                workspaceCwd: cwd,
                displayName: 'Locked group target',
              },
            ]
          : [],
      ),
      listSessionGroups: vi.fn().mockResolvedValue({
        groups: [],
        colorOptions: ['blue'],
      }),
      createSessionGroup,
      updateSessionGroup: vi.fn(),
      deleteSessionGroup: vi.fn(),
      updateSessionOrganization: secondaryOrganization,
      archiveSessionsData,
      unarchiveSessionsData,
      deleteSessionsData,
      exportSession,
      exportArchivedSession,
    }));
    connection.capabilities = {
      ...capabilities,
      features: [
        ...capabilities.features,
        'session_organization',
        'workspace_qualified_rest_core',
      ],
    };

    renderSidebar({
      lockedWorkspaceCwd: '/tmp/other',
      onError,
      sessionActions: { items: ['group'] },
    });
    await ensureWorkspaceExpanded('other');
    const groupTrigger = sessionAction('Locked group target');
    expect(groupTrigger).toBeDefined();
    await act(async () => {
      click(groupTrigger!);
      await Promise.resolve();
    });
    const groupItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes('Group'));
    expect(groupItem).toBeDefined();
    await act(async () => {
      click(groupItem!);
      await Promise.resolve();
      await Promise.resolve();
    });

    const createGroup = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]',
      ),
    ).find((button) => button.textContent?.includes('Create group'));
    expect(createGroup).toBeDefined();
    await act(async () => {
      click(createGroup!);
      await Promise.resolve();
    });

    const groupName = document.body.querySelector<HTMLInputElement>(
      '#session-group-name',
    );
    expect(groupName).not.toBeNull();
    const groupForm = groupName!.closest('form')!;
    await act(async () => {
      setInputValue(groupName!, 'Created during unlock');
      groupForm.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(createSessionGroup).toHaveBeenCalledWith({
      name: 'Created during unlock',
      color: 'blue',
    });

    renderSidebar({ sessionActions: { items: ['group'] } });
    await act(async () => {
      await Promise.resolve();
      resolveCreate({
        id: 'created-during-unlock',
        name: 'Created during unlock',
        color: 'blue',
      });
      await createSessionGroup.mock.results[0]?.value;
      await Promise.resolve();
    });

    expect(secondaryOrganization).not.toHaveBeenCalled();
    expect(primaryOrganization).not.toHaveBeenCalled();
    expect(
      document.body.querySelector<HTMLInputElement>('#session-group-name'),
    ).toBeNull();
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      'Group created, but failed to move session into it',
    );
    await act(async () => {
      groupForm.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(createSessionGroup).toHaveBeenCalledTimes(1);
  });

  it('routes locked secondary delete, archive, color, and pinned mutations only to its client', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [
        ...capabilities.features,
        'session_organization',
        'workspace_session_export',
      ],
    };
    const primaryDelete = vi.fn().mockResolvedValue({
      removed: [],
      notFound: [],
      errors: [],
    });
    const primaryArchive = vi.fn().mockResolvedValue({
      archived: [],
      alreadyArchived: [],
      notFound: [],
      errors: [],
    });
    const primaryOrganization = vi.fn().mockResolvedValue({});
    const secondaryDelete = vi.fn().mockResolvedValue({
      removed: ['locked-delete'],
      notFound: [],
      errors: [],
    });
    const secondaryArchive = vi.fn().mockResolvedValue({
      archived: ['locked-archive'],
      alreadyArchived: [],
      notFound: [],
      errors: [],
    });
    const secondaryOrganization = vi.fn().mockResolvedValue({});
    const makeClient = (
      cwd: string,
      actions: {
        delete: ReturnType<typeof vi.fn>;
        archive: ReturnType<typeof vi.fn>;
        organization: ReturnType<typeof vi.fn>;
      },
    ) => ({
      listWorkspaceSessions: vi
        .fn()
        .mockImplementation((options?: { group?: string }) =>
          cwd !== '/tmp/other'
            ? []
            : options?.group === 'pinned'
              ? [
                  {
                    sessionId: 'locked-pinned',
                    workspaceCwd: cwd,
                    displayName: 'Locked pinned',
                    isPinned: true,
                  },
                ]
              : [
                  {
                    sessionId: 'locked-delete',
                    workspaceCwd: cwd,
                    displayName: 'Locked delete',
                  },
                  {
                    sessionId: 'locked-archive',
                    workspaceCwd: cwd,
                    displayName: 'Locked archive',
                  },
                  {
                    sessionId: 'locked-color',
                    workspaceCwd: cwd,
                    displayName: 'Locked color',
                  },
                ],
        ),
      listSessionGroups: vi.fn().mockResolvedValue({
        groups:
          cwd === '/tmp/other'
            ? [
                {
                  id: 'secondary-group',
                  name: 'Secondary group',
                  color: 'blue',
                },
              ]
            : [],
        colorOptions: ['blue'],
      }),
      archiveSessionsData: actions.archive,
      unarchiveSessionsData,
      deleteSessionsData: actions.delete,
      updateSessionOrganization: actions.organization,
      exportSession,
      exportArchivedSession,
    });
    const primaryClient = makeClient('/tmp/project', {
      delete: primaryDelete,
      archive: primaryArchive,
      organization: primaryOrganization,
    });
    const secondaryClient = makeClient('/tmp/other', {
      delete: secondaryDelete,
      archive: secondaryArchive,
      organization: secondaryOrganization,
    });
    workspace.client.workspaceByCwd.mockImplementation((cwd: string) =>
      cwd === '/tmp/other' ? secondaryClient : primaryClient,
    );

    renderSidebar({
      lockedWorkspaceCwd: '/tmp/other',
      sessionActions: {
        items: ['pin', 'group', 'archive', 'delete'],
        inlineItems: ['pin'],
      },
    });
    await expandWorkspace('other');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await selectSessionMenuItem('Locked delete', 'Delete');
    await act(async () => {
      click(dialogButton('Delete'));
      await secondaryDelete.mock.results.at(-1)?.value;
    });
    expect(secondaryDelete).toHaveBeenCalledWith(['locked-delete']);

    await selectSessionMenuItem('Locked archive', 'Archive');
    await act(async () => {
      await secondaryArchive.mock.results.at(-1)?.value;
    });
    expect(secondaryArchive).toHaveBeenCalledWith(['locked-archive']);

    await selectSessionMenuItem('Locked color', 'Group');
    const blue = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ).find((button) => button.textContent?.includes('Blue'));
    expect(blue).toBeDefined();
    await act(async () => {
      click(blue!);
      await secondaryOrganization.mock.results.at(-1)?.value;
    });
    expect(secondaryOrganization).toHaveBeenCalledWith('locked-color', {
      color: 'blue',
      groupId: null,
    });

    await selectSessionMenuItem('Locked color', 'Group');
    const namedGroup = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ).find((button) => button.textContent?.includes('Secondary group'));
    expect(namedGroup).toBeDefined();
    await act(async () => {
      click(namedGroup!);
      await secondaryOrganization.mock.results.at(-1)?.value;
    });
    expect(secondaryOrganization).toHaveBeenCalledWith('locked-color', {
      groupId: 'secondary-group',
      color: null,
    });

    await act(async () => {
      click(inlineSessionAction('Locked pinned', 'Unpin')!);
      await secondaryOrganization.mock.results.at(-1)?.value;
    });
    expect(secondaryOrganization).toHaveBeenCalledWith('locked-pinned', {
      isPinned: false,
    });
    expect(primaryDelete).not.toHaveBeenCalled();
    expect(primaryArchive).not.toHaveBeenCalled();
    expect(primaryOrganization).not.toHaveBeenCalled();
  });

  it('requires workspace_qualified_rest_core for locked secondary destructive and organization controls', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [
        'multi_workspace_sessions',
        'session_archive',
        'session_organization',
        'workspace_session_export',
      ],
    };
    const secondaryDelete = vi.fn();
    const secondaryOrganization = vi.fn();
    const secondaryArchive = vi.fn();
    workspace.client.workspaceByCwd.mockImplementation((cwd: string) => ({
      listWorkspaceSessions: vi.fn().mockResolvedValue(
        cwd === '/tmp/other'
          ? [
              {
                sessionId: 'without-rest',
                workspaceCwd: cwd,
                displayName: 'Without rest capability',
              },
            ]
          : [],
      ),
      listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      archiveSessionsData: secondaryArchive,
      unarchiveSessionsData,
      deleteSessionsData: secondaryDelete,
      updateSessionOrganization: secondaryOrganization,
      exportSession,
      exportArchivedSession,
    }));

    renderSidebar({
      lockedWorkspaceCwd: '/tmp/other',
      sessionActions: {
        items: ['pin', 'group', 'archive', 'delete', 'export', 'details'],
        inlineItems: ['pin', 'archive', 'delete'],
      },
    });
    await expandWorkspace('other');

    expect(
      inlineSessionAction('Without rest capability', 'Pin'),
    ).toBeUndefined();
    expect(
      inlineSessionAction('Without rest capability', 'Archive'),
    ).toBeUndefined();
    expect(
      inlineSessionAction('Without rest capability', 'Delete'),
    ).toBeUndefined();
    const trigger = sessionAction('Without rest capability');
    expect(trigger).toBeDefined();
    await act(async () => {
      click(trigger!);
      await Promise.resolve();
    });
    const items = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).map((item) => item.textContent);
    expect(items).not.toContain('Pin');
    expect(items).not.toContain('Archive');
    expect(items).not.toContain('Session group');
    expect(items).not.toContain('Delete');
    expect(secondaryDelete).not.toHaveBeenCalled();
    expect(secondaryOrganization).not.toHaveBeenCalled();
    expect(secondaryArchive).not.toHaveBeenCalled();
  });

  it('keeps a trusted locked workspace New Task available without session organization', async () => {
    connection.capabilities = {
      ...capabilities,
      features: capabilities.features.filter(
        (feature) => feature !== 'session_organization',
      ),
    };
    const onNewSession = vi.fn(() => true);
    renderSidebar({ lockedWorkspaceCwd: '/tmp/other', onNewSession });
    await expandWorkspace('other');

    expect(
      container.querySelector('button[aria-label="Create session group"]'),
    ).toBeNull();
    const newTaskButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="New task"]',
      ),
    );
    expect(newTaskButtons.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      click(newTaskButtons.at(-1)!);
      await Promise.resolve();
    });
    expect(onNewSession).toHaveBeenCalledWith('/tmp/other');
  });

  it('applies items and inlineItems consistently to locked normal, pinned, and archived rows', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [
        ...capabilities.features,
        'session_organization',
        'workspace_session_export',
        'workspace_archived_session_export',
      ],
    };
    workspace.client.workspaceByCwd.mockImplementation((cwd: string) => ({
      listWorkspaceSessions: vi
        .fn()
        .mockImplementation(
          (options?: { group?: string; archiveState?: string }) => {
            if (cwd !== '/tmp/other') return [];
            if (options?.group === 'pinned') {
              return [
                {
                  sessionId: 'configured-pinned',
                  workspaceCwd: cwd,
                  displayName: 'Configured pinned',
                  isPinned: true,
                },
              ];
            }
            if (options?.archiveState === 'archived') {
              return [
                {
                  sessionId: 'configured-archived',
                  workspaceCwd: cwd,
                  displayName: 'Configured archived',
                  isArchived: true,
                },
              ];
            }
            return [
              {
                sessionId: 'configured-normal',
                workspaceCwd: cwd,
                displayName: 'Configured normal',
              },
            ];
          },
        ),
      listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      archiveSessionsData,
      unarchiveSessionsData,
      deleteSessionsData,
      updateSessionOrganization,
      exportSession,
      exportArchivedSession,
    }));
    renderSidebar({
      lockedWorkspaceCwd: '/tmp/other',
      sessionActions: {
        items: ['details', 'pin', 'group', 'archive', 'export', 'delete'],
        inlineItems: ['pin'],
      },
    });
    await expandWorkspace('other');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector('button[aria-label="Create group"]'),
    ).not.toBeNull();
    expect(inlineSessionAction('Configured normal', 'Pin')).toBeDefined();
    expect(inlineSessionAction('Configured normal', 'Archive')).toBeUndefined();
    const normalItems = await openSessionMenuItems('Configured normal');
    expect(normalItems).toEqual(
      expect.arrayContaining([
        'Archive',
        'Details',
        'Group',
        'Export conversation record',
        'Delete',
      ]),
    );

    expect(inlineSessionAction('Configured pinned', 'Unpin')).toBeDefined();
    expect(inlineSessionAction('Configured pinned', 'Archive')).toBeUndefined();

    await expandArchived();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const archivedItems = await openSessionMenuItems('Configured archived');
    expect(archivedItems).toEqual(
      expect.arrayContaining([
        'Details',
        'Export conversation record',
        'Restore',
        'Delete',
      ]),
    );
    expect(archivedItems).not.toContain('Pin');
    expect(archivedItems).not.toContain('Group');
  });

  it('renders locked normal, pinned, and archived rows action-free when no items are configured', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [
        ...capabilities.features,
        'session_organization',
        'workspace_session_export',
        'workspace_archived_session_export',
      ],
    };
    workspace.client.workspaceByCwd.mockImplementation((cwd: string) => ({
      listWorkspaceSessions: vi
        .fn()
        .mockImplementation(
          (options?: { group?: string; archiveState?: string }) => {
            if (cwd !== '/tmp/other') return [];
            if (options?.group === 'pinned') {
              return [
                {
                  sessionId: 'empty-actions-pinned',
                  workspaceCwd: cwd,
                  displayName: 'Empty actions pinned',
                  isPinned: true,
                },
              ];
            }
            if (options?.archiveState === 'archived') {
              return [
                {
                  sessionId: 'empty-actions-archived',
                  workspaceCwd: cwd,
                  displayName: 'Empty actions archived',
                  isArchived: true,
                },
              ];
            }
            return [
              {
                sessionId: 'empty-actions-normal',
                workspaceCwd: cwd,
                displayName: 'Empty actions normal',
                groupId: 'empty-actions-group',
              },
            ];
          },
        ),
      listSessionGroups: vi.fn().mockResolvedValue({
        groups: [
          {
            id: 'empty-actions-group',
            name: 'Empty actions group',
            color: 'blue',
          },
        ],
      }),
      archiveSessionsData,
      unarchiveSessionsData,
      deleteSessionsData,
      updateSessionOrganization,
      exportSession,
      exportArchivedSession,
    }));

    renderSidebar({
      lockedWorkspaceCwd: '/tmp/other',
      sessionActions: { items: [] },
    });
    await expandWorkspace('other');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    for (const label of ['Empty actions normal', 'Empty actions pinned']) {
      expect(sessionAction(label)).toBeUndefined();
      expect(inlineSessionAction(label, 'Pin')).toBeUndefined();
      expect(archiveButtonFor(label)).toBeUndefined();
    }
    expect(container.textContent).toContain('Empty actions group');
    expect(
      container.querySelector('button[aria-label="Create group"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Rename group"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Delete group"]'),
    ).toBeNull();

    await expandArchived();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sessionAction('Empty actions archived')).toBeUndefined();
    expect(archiveSessionsData).not.toHaveBeenCalled();
    expect(unarchiveSessionsData).not.toHaveBeenCalled();
    expect(deleteSessionsData).not.toHaveBeenCalled();
    expect(updateSessionOrganization).not.toHaveBeenCalled();
    expect(exportSession).not.toHaveBeenCalled();
    expect(exportArchivedSession).not.toHaveBeenCalled();
  });

  it('gates primary group header controls on the live organization policy', async () => {
    const organizedCapabilities = {
      ...capabilities,
      features: [...capabilities.features, 'session_organization'],
    };
    connection.capabilities = organizedCapabilities;
    workspace.capabilities = organizedCapabilities;
    workspaceActions.listSessionGroups.mockResolvedValue({
      groups: [
        {
          id: 'primary-policy-group',
          name: 'Primary policy group',
          color: 'blue',
        },
      ],
      colorOptions: ['blue'],
    });

    renderSidebar({ sessionActions: { items: ['group'] } });
    await act(async () => {
      await workspaceActions.listSessionGroups.mock.results.at(-1)?.value;
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Primary policy group');
    expect(
      container.querySelector('button[aria-label="Rename group"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Delete group"]'),
    ).not.toBeNull();

    renderSidebar({ sessionActions: { items: [] } });
    expect(container.textContent).toContain('Primary policy group');
    expect(
      container.querySelector('button[aria-label="Rename group"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Delete group"]'),
    ).toBeNull();

    connection.capabilities = {
      ...organizedCapabilities,
      features: organizedCapabilities.features.filter(
        (feature) => feature !== 'session_organization',
      ),
    };
    workspace.capabilities = connection.capabilities;
    renderSidebar({ sessionActions: { items: ['group'] } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      container.querySelector('button[aria-label="Rename group"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Delete group"]'),
    ).toBeNull();
  });

  it('keeps equal-id active export and current state isolated by workspace cwd', async () => {
    const exportResult = {
      content: '<p>export</p>',
      filename: 'shared.html',
      mimeType: 'text/html',
      format: 'html' as const,
    };
    let resolveSecondaryExport:
      | ((value: typeof exportResult) => void)
      | undefined;
    const secondaryExport = vi.fn(
      () =>
        new Promise<typeof exportResult>((resolve) => {
          resolveSecondaryExport = resolve;
        }),
    );
    connection.sessionId = 'shared-active';
    connection.workspaceCwd = '/tmp/other';
    connection.capabilities = {
      ...capabilities,
      features: [
        ...capabilities.features,
        'session_export',
        'workspace_session_export',
      ],
    };
    active.sessions.push({
      sessionId: 'shared-active',
      workspaceCwd: '/tmp/project',
      displayName: 'Primary shared active',
    });
    active.exportSession.mockResolvedValue(exportResult);
    workspace.client.workspaceByCwd.mockImplementation((cwd: string) => ({
      listWorkspaceSessions: async () =>
        cwd === '/tmp/other'
          ? [
              {
                sessionId: 'shared-active',
                workspaceCwd: cwd,
                displayName: 'Secondary shared active',
              },
            ]
          : [],
      listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      archiveSessionsData,
      unarchiveSessionsData,
      deleteSessionsData,
      updateSessionOrganization,
      exportSession: secondaryExport,
      exportArchivedSession,
    }));
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:shared'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderSidebar({ lockedWorkspaceCwd: '/tmp/other' });
    await act(async () => {
      await Promise.resolve();
    });
    await ensureWorkspaceExpanded('other');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('Secondary shared active');
    await selectSessionMenuItem(
      'Secondary shared active',
      'Export conversation record',
    );
    expect(secondaryExport).toHaveBeenCalledOnce();

    connection.workspaceCwd = '/tmp/project';
    renderSidebar();
    const primaryRow = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((row) => row.textContent?.includes('Primary shared active'));
    expect(primaryRow?.getAttribute('aria-current')).toBe('page');
    await selectSessionMenuItem(
      'Primary shared active',
      'Export conversation record',
    );
    await act(async () => {
      await active.exportSession.mock.results.at(-1)?.value;
      resolveSecondaryExport?.(exportResult);
      await Promise.resolve();
    });
    expect(active.exportSession).toHaveBeenCalledWith('shared-active', 'html');
  });

  it('keeps primary active export on the primary action under session_export only', async () => {
    const exportResult = {
      content: '<p>primary export</p>',
      filename: 'primary.html',
      mimeType: 'text/html',
      format: 'html' as const,
    };
    connection.capabilities = {
      ...capabilities,
      features: [...capabilities.features, 'session_export'],
    };
    active.sessions.push({
      sessionId: 'primary-export',
      workspaceCwd: '/tmp/project',
      displayName: 'Primary export',
    });
    active.exportSession.mockResolvedValue(exportResult);
    const secondaryExport = vi.fn().mockResolvedValue(exportResult);
    workspace.client.workspaceByCwd.mockImplementation((_cwd: string) => ({
      listWorkspaceSessions: vi.fn().mockResolvedValue([]),
      listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      archiveSessionsData,
      unarchiveSessionsData,
      deleteSessionsData,
      updateSessionOrganization,
      exportSession: secondaryExport,
      exportArchivedSession,
    }));
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:primary-export'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderSidebar();
    await selectSessionMenuItem('Primary export', 'Export');
    await act(async () => {
      await active.exportSession.mock.results.at(-1)?.value;
    });

    expect(active.exportSession).toHaveBeenCalledWith('primary-export', 'html');
    expect(secondaryExport).not.toHaveBeenCalled();
  });

  it('does not infer secondary active export from session_export', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [...capabilities.features, 'session_export'],
    };
    workspace.client.workspaceByCwd.mockImplementation((cwd: string) => ({
      listWorkspaceSessions: vi.fn().mockResolvedValue(
        cwd === '/tmp/other'
          ? [
              {
                sessionId: 'secondary-legacy-export',
                workspaceCwd: cwd,
                displayName: 'Secondary legacy export',
              },
            ]
          : [],
      ),
      listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      archiveSessionsData,
      unarchiveSessionsData,
      deleteSessionsData,
      updateSessionOrganization,
      exportSession,
      exportArchivedSession,
    }));

    renderSidebar({ lockedWorkspaceCwd: '/tmp/other' });
    await expandWorkspace('other');

    expect(
      inlineSessionAction('Secondary legacy export', 'Export'),
    ).toBeUndefined();
    const trigger = sessionAction('Secondary legacy export');
    expect(trigger).toBeDefined();
    await act(async () => {
      click(trigger!);
      await Promise.resolve();
    });
    expect(
      Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).some((item) => item.textContent?.includes('Export')),
    ).toBe(false);
  });

  it('applies configured, trusted archived actions without a stale-cwd fallback', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [...capabilities.features, 'workspace_archived_session_export'],
    };
    archived.sessions.push(
      {
        sessionId: 'primary-archived-controlled',
        workspaceCwd: '/tmp/project',
        displayName: 'Primary archived controlled',
        isArchived: true,
      },
      {
        sessionId: 'stale-archived-controlled',
        workspaceCwd: '/tmp/stale',
        displayName: 'Stale archived controlled',
        isArchived: true,
      },
    );

    renderSidebar({
      sessionActions: {
        items: ['details', 'archive', 'delete', 'export'],
      },
    });
    await expandArchived();

    await selectSessionMenuItem('Primary archived controlled', 'Restore');
    await act(async () => {
      await archived.unarchiveSession.mock.results.at(-1)?.value;
    });
    expect(archived.unarchiveSession).toHaveBeenCalledWith(
      'primary-archived-controlled',
    );

    const staleTrigger = sessionAction('Stale archived controlled');
    expect(staleTrigger).toBeDefined();
    await act(async () => {
      click(staleTrigger!);
      await Promise.resolve();
    });
    const staleMenuItems = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).map((item) => item.textContent);
    expect(staleMenuItems).toContain('Details');
    expect(staleMenuItems).not.toContain('Export');
    expect(staleMenuItems).not.toContain('Restore');
    expect(staleMenuItems).not.toContain('Delete');
    expect(deleteSessionsData).not.toHaveBeenCalled();
    expect(exportArchivedSession).not.toHaveBeenCalled();
  });

  it('clears a secondary delete candidate after its workspace disappears', async () => {
    const primaryDelete = active.deleteSession;
    const secondaryDelete = vi.fn().mockResolvedValue({
      removed: ['secondary-delete'],
      notFound: [],
      errors: [],
    });
    workspace.client.workspaceByCwd.mockImplementation((cwd: string) => ({
      listWorkspaceSessions: vi.fn().mockResolvedValue(
        cwd === '/tmp/other'
          ? [
              {
                sessionId: 'secondary-delete',
                workspaceCwd: cwd,
                displayName: 'Secondary delete',
              },
            ]
          : [],
      ),
      listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      archiveSessionsData,
      unarchiveSessionsData,
      deleteSessionsData:
        cwd === '/tmp/other' ? secondaryDelete : deleteSessionsData,
      updateSessionOrganization,
      exportSession,
      exportArchivedSession,
    }));

    renderSidebar({ lockedWorkspaceCwd: '/tmp/other' });
    await expandWorkspace('other');
    await selectSessionMenuItem('Secondary delete', 'Delete');
    expect(document.body.textContent).toContain('Delete Session');

    const catalogWithoutSecondary = {
      ...capabilities,
      workspaces: capabilities.workspaces.filter(
        (entry) => entry.cwd !== '/tmp/other',
      ),
    };
    connection.capabilities = catalogWithoutSecondary;
    workspace.capabilities = catalogWithoutSecondary;
    renderSidebar({ lockedWorkspaceCwd: '/tmp/other' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain('Delete Session');
    expect(secondaryDelete).not.toHaveBeenCalled();
    expect(primaryDelete).not.toHaveBeenCalled();
  });

  it('keeps legacy primary actions when capabilities omit the workspace catalog', async () => {
    const legacyCapabilities = {
      qwenCodeVersion: '1.2.3',
      workspaceCwd: '/tmp/project',
      features: ['session_archive', 'session_export', 'session_organization'],
    };
    connection.capabilities = legacyCapabilities;
    workspace.capabilities = legacyCapabilities;
    active.sessions.push({
      sessionId: 'legacy-primary',
      workspaceCwd: '/tmp/project',
      displayName: 'Legacy primary',
    });

    renderSidebar({
      // App normalizes an omitted capabilities.workspaces field to [].
      workspaces: [],
      sessionActions: {
        items: [
          'rename',
          'details',
          'pin',
          'group',
          'archive',
          'export',
          'delete',
        ],
        inlineItems: ['rename', 'pin', 'archive', 'export', 'delete'],
      },
    });
    await expandWorkspace('project');

    expect(inlineSessionAction('Legacy primary', 'Rename')).toBeDefined();
    expect(inlineSessionAction('Legacy primary', 'Pin')).toBeDefined();
    expect(archiveButtonFor('Legacy primary')?.disabled).toBe(false);
    expect(
      inlineSessionAction('Legacy primary', 'Export conversation record'),
    ).toBeDefined();
    expect(inlineSessionAction('Legacy primary', 'Delete')?.disabled).toBe(
      false,
    );
    expect(sessionAction('Legacy primary')).toBeDefined();
  });

  it('fails closed for an explicit primary cwd that disappears from the catalog', async () => {
    const primaryOnlyCatalog = {
      ...capabilities,
      features: [
        ...capabilities.features,
        'session_organization',
        'session_export',
      ],
      workspaces: capabilities.workspaces.filter((entry) => entry.primary),
    };
    connection.capabilities = primaryOnlyCatalog;
    workspace.capabilities = primaryOnlyCatalog;
    active.sessions.push(
      {
        sessionId: 'explicit-primary-stale',
        workspaceCwd: '/tmp/project',
        displayName: 'Explicit primary stale',
      },
      {
        sessionId: 'implicit-primary-fallback',
        displayName: 'Implicit primary fallback',
      },
    );

    const mutationActions = {
      items: ['rename', 'pin', 'group', 'archive', 'export', 'delete'] as const,
      inlineItems: ['rename', 'pin', 'archive', 'export', 'delete'] as const,
    };
    renderSidebar({ sessionActions: mutationActions });
    await expandWorkspace('project');
    await act(async () => {
      click(inlineSessionAction('Explicit primary stale', 'Delete')!);
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('Delete Session');

    const catalogWithoutPrimary = {
      ...primaryOnlyCatalog,
      workspaces: [],
    };
    connection.capabilities = catalogWithoutPrimary;
    workspace.capabilities = catalogWithoutPrimary;
    renderSidebar({ sessionActions: mutationActions });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain('Delete Session');
    expect(sessionAction('Explicit primary stale')).toBeUndefined();
    expect(
      inlineSessionAction('Explicit primary stale', 'Pin'),
    ).toBeUndefined();
    expect(
      inlineSessionAction('Explicit primary stale', 'Delete'),
    ).toBeUndefined();
    expect(archiveButtonFor('Explicit primary stale')).toBeUndefined();
    expect(
      inlineSessionAction('Explicit primary stale', 'Export'),
    ).toBeUndefined();
    expect(
      inlineSessionAction('Implicit primary fallback', 'Delete'),
    ).toBeDefined();
    expect(active.deleteSession).not.toHaveBeenCalled();
    expect(active.archiveSession).not.toHaveBeenCalled();
    expect(active.exportSession).not.toHaveBeenCalled();
  });

  it('treats a no-cwd primary row as current when the connection cwd is omitted', async () => {
    connection.sessionId = 'current-no-cwd';
    connection.workspaceCwd = '';
    active.sessions.push({
      sessionId: 'current-no-cwd',
      displayName: 'Current no-cwd primary',
    });
    useWorkspaceSessionCatalog(async (cwd, options) =>
      cwd === '/tmp/other' && options?.archiveState === 'active'
        ? [
            {
              sessionId: 'current-no-cwd',
              workspaceCwd: cwd,
              displayName: 'Equal-id secondary',
            },
          ]
        : [],
    );

    renderSidebar({
      sessionActions: {
        items: ['rename', 'archive', 'delete'],
        inlineItems: ['rename', 'archive', 'delete'],
      },
    });
    await expandWorkspace('project');
    await expandWorkspace('other');

    const rename = inlineSessionAction('Current no-cwd primary', 'Rename');
    const archive = archiveButtonFor('Current no-cwd primary');
    const remove = inlineSessionAction('Current no-cwd primary', 'Delete');
    expect(rename?.disabled).toBe(false);
    expect(archive?.disabled).toBe(true);
    expect(remove?.disabled).toBe(true);
    expect(archiveButtonFor('Equal-id secondary')?.disabled).toBe(false);

    await act(async () => {
      click(archive!);
      click(remove!);
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain('Delete Session');
    expect(active.archiveSession).not.toHaveBeenCalled();
    expect(active.deleteSession).not.toHaveBeenCalled();
  });

  it('deduplicates pending no-cwd primary renames and clears the busy identity afterward', async () => {
    let resolveFirstRename!: () => void;
    connection.sessionId = 'rename-no-cwd';
    connection.workspaceCwd = '';
    active.sessions.push({
      sessionId: 'rename-no-cwd',
      displayName: 'Rename no-cwd primary',
    });
    sessionActions.renameSession
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstRename = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    vi.spyOn(HTMLInputElement.prototype, 'focus').mockImplementation(() => {});

    renderSidebar({
      sessionActions: { items: ['rename'], inlineItems: ['rename'] },
    });
    await expandWorkspace('project');

    expect(
      inlineSessionAction('Rename no-cwd primary', 'Rename')?.disabled,
    ).toBe(false);
    await act(async () => {
      click(inlineSessionAction('Rename no-cwd primary', 'Rename')!);
      await Promise.resolve();
    });
    const input = container.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    const form = input!.closest('form')!;
    await act(async () => {
      setInputValue(input!, 'First rename');
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(sessionActions.renameSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(sessionActions.renameSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstRename();
      await sessionActions.renameSession.mock.results[0]?.value;
      await Promise.resolve();
    });

    await act(async () => {
      click(inlineSessionAction('Rename no-cwd primary', 'Rename')!);
      await Promise.resolve();
    });
    const secondInput = container.querySelector<HTMLInputElement>('input');
    expect(secondInput).not.toBeNull();
    await act(async () => {
      setInputValue(secondInput!, 'Second rename');
      secondInput!
        .closest('form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      await sessionActions.renameSession.mock.results[1]?.value;
    });
    expect(sessionActions.renameSession).toHaveBeenCalledTimes(2);
  });

  it('honors a missing rename item for double-click editing', async () => {
    connection.sessionId = 'current-primary';
    active.sessions.push({
      sessionId: 'current-primary',
      workspaceCwd: '/tmp/project',
      displayName: 'Current primary',
    });
    renderSidebar({ sessionActions: { items: ['details'] } });

    const row = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((candidate) => candidate.textContent?.includes('Current primary'));
    expect(row).toBeDefined();
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('input')).toBeNull();
    expect(sessionActions.renameSession).not.toHaveBeenCalled();
  });

  it('keeps a pinned secondary row restricted until that workspace is locked', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [...capabilities.features, 'session_organization'],
    };
    useWorkspaceSessionCatalog(async (cwd, options) =>
      cwd === '/tmp/other' && options?.group === 'pinned'
        ? [
            {
              sessionId: 'pinned-secondary',
              workspaceCwd: cwd,
              displayName: 'Pinned secondary',
              isPinned: true,
            },
          ]
        : [],
    );

    renderSidebar();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(inlineSessionAction('Pinned secondary', 'Unpin')).toBeUndefined();
    expect(sessionAction('Pinned secondary')).toBeUndefined();

    renderSidebar({ lockedWorkspaceCwd: '/tmp/other' });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(inlineSessionAction('Pinned secondary', 'Unpin')).toBeDefined();
    expect(sessionAction('Pinned secondary')).toBeDefined();
  });

  it('keeps unlocked secondary actions conservative across every sidebar surface', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [
        ...capabilities.features,
        'session_organization',
        'workspace_archived_session_export',
      ],
    };
    workspace.capabilities = connection.capabilities;
    workspaceActions.listSessionGroups.mockResolvedValue({
      groups: [],
      colorOptions: ['blue'],
    });
    workspace.client.workspaceByCwd.mockImplementation((cwd: string) => ({
      listWorkspaceSessions: vi
        .fn()
        .mockImplementation(
          (options?: { archiveState?: string; group?: string }) => {
            if (cwd !== '/tmp/other') return [];
            if (options?.archiveState === 'archived') {
              return [
                {
                  sessionId: 'unlocked-archived',
                  workspaceCwd: cwd,
                  displayName: 'Unlocked archived',
                  isArchived: true,
                },
              ];
            }
            if (options?.group === 'pinned') {
              return [
                {
                  sessionId: 'unlocked-pinned',
                  workspaceCwd: cwd,
                  displayName: 'Unlocked pinned',
                  isPinned: true,
                },
              ];
            }
            return [
              {
                sessionId: 'unlocked-normal',
                workspaceCwd: cwd,
                displayName: 'Unlocked normal',
                groupId: 'restricted-group',
              },
            ];
          },
        ),
      listSessionGroups: vi.fn().mockResolvedValue({
        groups: [
          {
            id: 'restricted-group',
            name: 'Restricted group',
            color: 'blue',
          },
        ],
        colorOptions: ['blue'],
      }),
      archiveSessionsData,
      unarchiveSessionsData,
      deleteSessionsData,
      updateSessionOrganization,
      exportSession,
      exportArchivedSession,
    }));

    renderSidebar();
    await expandWorkspace('other');
    await expandArchived();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(archiveButtonFor('Unlocked normal')?.disabled).toBe(false);
    expect(sessionAction('Unlocked normal')).toBeUndefined();
    expect(inlineSessionAction('Unlocked normal', 'Pin')).toBeUndefined();
    expect(inlineSessionAction('Unlocked normal', 'Delete')).toBeUndefined();

    expect(archiveButtonFor('Unlocked pinned')?.disabled).toBe(false);
    expect(sessionAction('Unlocked pinned')).toBeUndefined();
    expect(inlineSessionAction('Unlocked pinned', 'Unpin')).toBeUndefined();

    const archivedItems = await openSessionMenuItems('Unlocked archived');
    expect(archivedItems).toEqual([
      'Details',
      'Export conversation record',
      'Restore',
    ]);
    expect(deleteSessionsData).not.toHaveBeenCalled();
    expect(updateSessionOrganization).not.toHaveBeenCalled();

    expect(container.textContent).toContain('Restricted group');
    const secondaryCreateGroup = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Create group"]',
      ),
    ).find((button) =>
      button
        .closest<HTMLElement>('[class*="headerRow"]')
        ?.textContent?.includes('other'),
    );
    expect(secondaryCreateGroup).toBeUndefined();
    expect(
      container.querySelector('button[aria-label="Rename group"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Delete group"]'),
    ).toBeNull();
  });

  it('does not carry an active rename edit across equal session ids in another workspace', async () => {
    connection.sessionId = 'shared-session';
    connection.workspaceCwd = '/tmp/other';
    connection.capabilities = {
      ...capabilities,
      features: [...capabilities.features, 'session_organization'],
    };
    active.sessions.push({
      sessionId: 'shared-session',
      workspaceCwd: '/tmp/project',
      displayName: 'Primary shared',
      isPinned: true,
    });
    useWorkspaceSessionCatalog(async (cwd, options) =>
      cwd === '/tmp/other' && options?.group === 'pinned'
        ? [
            {
              sessionId: 'shared-session',
              workspaceCwd: cwd,
              displayName: 'Secondary shared',
              isPinned: true,
            },
          ]
        : [],
    );

    renderSidebar({ lockedWorkspaceCwd: '/tmp/other' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const secondaryRow = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((row) => row.textContent?.includes('Secondary shared'));
    expect(secondaryRow).toBeDefined();
    await act(async () => {
      secondaryRow?.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(container.querySelector('input')).not.toBeNull();

    connection.workspaceCwd = '/tmp/project';
    await act(async () => {
      renderSidebar({ lockedWorkspaceCwd: '/tmp/project' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('Primary shared');
    expect(container.querySelector('input')).toBeNull();
    expect(sessionActions.renameSession).not.toHaveBeenCalled();
  });

  it('shows only the locked workspace without registration controls', () => {
    renderSidebar({ lockedWorkspaceCwd: '/tmp/other' });

    expect(container.textContent).toContain('other');
    expect(container.textContent).not.toContain('project');
    expect(container.textContent).not.toContain('danger');
    expect(
      container.querySelector('button[aria-label="Add workspace"]'),
    ).toBeNull();
    expect(workspaceAction('/tmp/other')).toBeUndefined();
  });

  it('uses custom workspace row content only when the workspace is locked', async () => {
    const render = vi.fn((ws: DaemonWorkspaceCapability) => (
      <span data-testid="custom-workspace">Custom {ws.cwd}</span>
    ));
    const lockedWorkspace = { render };

    renderSidebar({ lockedWorkspace });
    expect(render).not.toHaveBeenCalled();
    expect(container.textContent).toContain('project');

    renderSidebar({
      lockedWorkspaceCwd: '/tmp/other',
      lockedWorkspace,
    });
    expect(render).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'secondary', cwd: '/tmp/other' }),
      { expanded: false },
    );
    expect(
      container.querySelector('[data-testid="custom-workspace"]')?.textContent,
    ).toBe('Custom /tmp/other');
    expect(
      container
        .querySelector('[data-testid="custom-workspace"]')
        ?.closest('button')
        ?.parentElement?.querySelectorAll('button'),
    ).toHaveLength(1);
    expect(container.textContent).not.toContain('project');

    await act(async () => {
      click(
        container
          .querySelector('[data-testid="custom-workspace"]')!
          .closest('button')!,
      );
      await Promise.resolve();
    });
    expect(render).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'secondary', cwd: '/tmp/other' }),
      { expanded: true },
    );
  });

  it('hides removal when the daemon does not publish the feature', () => {
    connection.capabilities = {
      ...capabilities,
      features: ['multi_workspace_sessions'],
    };
    renderSidebar();

    expect(workspaceAction('/tmp/other')).toBeUndefined();
    expect(workspaceAction('/tmp/danger')).toBeUndefined();
  });

  it('exposes removal for an untrusted removable workspace', () => {
    renderSidebar();

    const trigger = workspaceAction('/tmp/danger');
    expect(trigger).toBeDefined();
    expect(workspaceAction('/tmp/project')).toBeUndefined();

    act(() => click(trigger!));
    const item = document.body.querySelector(
      '[aria-label="Remove workspace: /tmp/danger"]',
    );
    const menu = item?.closest('[data-slot="dropdown-menu-content"]');
    expect(menu?.classList.contains('w-auto')).toBe(true);
    expect(menu?.classList.contains('min-w-40')).toBe(true);
  });

  it('removes the selected workspace and falls back to primary', async () => {
    const onSelectWorkspace = vi.fn();
    renderSidebar({
      selectedWorkspaceCwd: '/tmp/danger',
      onSelectWorkspace,
    });
    openRemoval('/tmp/danger');

    await act(async () => click(dialogButton('Remove workspace')));

    expect(workspaceActions.removeWorkspace).toHaveBeenCalledWith('untrusted', {
      force: false,
    });
    expect(onSelectWorkspace).toHaveBeenCalledWith(undefined);
    expect(workspace.refreshCapabilities).toHaveBeenCalled();
  });

  it('shows activity and blocks force for the current session workspace', async () => {
    connection.sessionId = 'active-session';
    connection.workspaceCwd = '/tmp/other';
    workspaceActions.removeWorkspace.mockRejectedValueOnce(
      new DaemonHttpError(
        409,
        {
          code: 'workspace_busy',
          activity: {
            sessions: 1,
            activePrompts: 1,
            pendingSessionStarts: 0,
            acpConnections: 1,
            memoryTasks: 0,
            channelWorkers: 0,
          },
        },
        'busy',
      ),
    );
    renderSidebar();
    openRemoval('/tmp/other');

    await act(async () => click(dialogButton('Remove workspace')));

    expect(document.body.textContent).toContain('Sessions: 1');
    expect(document.body.textContent).toContain(
      'Switch to another workspace or close the current session',
    );
    expect(dialogButton('Force remove').disabled).toBe(true);
  });

  it('shows Voice-only activity before offering force removal', async () => {
    workspaceActions.removeWorkspace.mockRejectedValueOnce(
      new DaemonHttpError(
        409,
        {
          code: 'workspace_busy',
          activity: {
            sessions: 0,
            activePrompts: 0,
            pendingSessionStarts: 0,
            acpConnections: 0,
            memoryTasks: 0,
            channelWorkers: 0,
            voiceSessions: 1,
          },
        },
        'busy',
      ),
    );
    renderSidebar();
    openRemoval('/tmp/other');

    await act(async () => click(dialogButton('Remove workspace')));

    expect(document.body.textContent).toContain('Voice sessions: 1');
    expect(dialogButton('Force remove').disabled).toBe(false);
  });
});

describe('WebShellSidebar non-primary archive', () => {
  it('archives a trusted secondary session and reconciles every catalog', async () => {
    useWorkspaceSessionCatalog(async (cwd, options) => {
      if (cwd === '/tmp/other' && options?.archiveState === 'active') {
        return [
          {
            sessionId: 'secondary-active',
            workspaceCwd: cwd,
            displayName: 'Secondary active',
          },
        ];
      }
      return [];
    });
    archiveSessionsData.mockResolvedValue({
      archived: ['secondary-active'],
      alreadyArchived: [],
      notFound: [],
      errors: [],
    });

    renderSidebar({
      sessionActions: { items: ['archive'], inlineItems: [] },
    });
    await expandWorkspace('other');
    await expandArchived();
    const archiveButton = archiveButtonFor('Secondary active');
    expect(archiveButton).toBeUndefined();
    const menuItems = await openSessionMenuItems('Secondary active');
    expect(menuItems).toEqual(['Archive']);
    const archiveItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent === 'Archive');
    expect(archiveItem).toBeDefined();

    await act(async () => {
      click(archiveItem!);
      await archiveSessionsData.mock.results.at(-1)?.value;
      await Promise.resolve();
    });

    expect(workspace.client.workspaceByCwd).toHaveBeenCalledWith('/tmp/other');
    expect(archiveSessionsData).toHaveBeenCalledWith(['secondary-active']);
    expect(active.reload).toHaveBeenCalled();
    expect(archived.reload).toHaveBeenCalled();
    expect(
      listWorkspaceSessions.mock.calls.filter(
        ([cwd, options]) =>
          cwd === '/tmp/other' && options?.archiveState === 'active',
      ).length,
    ).toBeGreaterThan(1);
    expect(
      listWorkspaceSessions.mock.calls.some(
        ([cwd, options]) =>
          cwd === '/tmp/other' && options?.archiveState === 'archived',
      ),
    ).toBe(true);
  });

  it('surfaces a partial restore error and reconciles every catalog', async () => {
    const onError = vi.fn();
    useWorkspaceSessionCatalog(async (cwd, options) => {
      if (cwd === '/tmp/other' && options?.archiveState === 'archived') {
        return [
          {
            sessionId: 'secondary-archived',
            workspaceCwd: cwd,
            displayName: 'Secondary archived',
            isArchived: true,
          },
        ];
      }
      return [];
    });
    unarchiveSessionsData.mockResolvedValue({
      unarchived: ['secondary-archived'],
      alreadyActive: [],
      notFound: [],
      errors: [
        {
          sessionId: 'secondary-archived',
          error: 'scheduled task restore failed',
        },
      ],
    });

    renderSidebar({ onError });
    await expandWorkspace('other');
    await expandArchived();
    const moreButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="More actions"]',
      ),
    ).find((button) =>
      button
        .closest<HTMLElement>('[class*="sessionRow"]')
        ?.textContent?.includes('Secondary archived'),
    );
    expect(moreButton).toBeDefined();
    act(() => click(moreButton!));
    const restoreItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes('Restore'));
    expect(restoreItem).toBeDefined();

    await act(async () => {
      click(restoreItem!);
      await unarchiveSessionsData.mock.results.at(-1)?.value;
      await Promise.resolve();
    });

    expect(unarchiveSessionsData).toHaveBeenCalledWith(['secondary-archived']);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'scheduled task restore failed' }),
      'Failed to restore session',
    );
    expect(active.reload).toHaveBeenCalled();
    expect(archived.reload).toHaveBeenCalled();
    expect(
      listWorkspaceSessions.mock.calls.filter(
        ([cwd, options]) =>
          cwd === '/tmp/other' && options?.archiveState === 'active',
      ).length,
    ).toBeGreaterThan(1);
  });

  it('surfaces secondary batch errors and still reconciles catalogs', async () => {
    const onError = vi.fn();
    useWorkspaceSessionCatalog(async (cwd, options) =>
      cwd === '/tmp/other' && options?.archiveState === 'active'
        ? [
            {
              sessionId: 'secondary-error',
              workspaceCwd: cwd,
              displayName: 'Secondary error',
            },
          ]
        : [],
    );
    archiveSessionsData.mockResolvedValue({
      archived: [],
      alreadyArchived: [],
      notFound: [],
      errors: [
        {
          sessionId: 'secondary-error',
          error: 'agent close failed',
        },
      ],
    });

    renderSidebar({ onError });
    await expandWorkspace('other');
    const archiveButton = archiveButtonFor('Secondary error');
    expect(archiveButton).toBeDefined();
    await act(async () => {
      click(archiveButton!);
      await archiveSessionsData.mock.results.at(-1)?.value;
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'agent close failed' }),
      'Failed to archive session',
    );
    expect(active.reload).toHaveBeenCalled();
    expect(archived.reload).toHaveBeenCalled();
    expect(
      listWorkspaceSessions.mock.calls.filter(
        ([cwd, options]) =>
          cwd === '/tmp/other' && options?.archiveState === 'active',
      ).length,
    ).toBeGreaterThan(1);
  });

  it('allows primary archive but gates secondary archive without the plural capability', async () => {
    connection.capabilities = {
      ...capabilities,
      features: ['session_archive'],
    };
    active.sessions.push({
      sessionId: 'primary-active',
      workspaceCwd: '/tmp/project',
      displayName: 'Primary active',
    });
    useWorkspaceSessionCatalog(async (cwd, options) =>
      cwd === '/tmp/other' && options?.archiveState === 'active'
        ? [
            {
              sessionId: 'secondary-active',
              workspaceCwd: cwd,
              displayName: 'Secondary active',
            },
          ]
        : [],
    );

    renderSidebar();
    await expandWorkspace('project');
    await expandWorkspace('other');
    expect(archiveButtonFor('Primary active')).toBeDefined();
    expect(archiveButtonFor('Secondary active')).toBeUndefined();
    await expandArchived();
    expect(
      listWorkspaceSessions.mock.calls.some(
        ([, options]) => options?.archiveState === 'archived',
      ),
    ).toBe(false);
  });

  it('hides archive UI when session_archive is absent', async () => {
    connection.capabilities = {
      ...capabilities,
      features: ['workspace_qualified_rest_core'],
    };
    useWorkspaceSessionCatalog(async (cwd, options) =>
      cwd === '/tmp/other' && options?.archiveState === 'active'
        ? [
            {
              sessionId: 'secondary-active',
              workspaceCwd: cwd,
              displayName: 'Secondary active',
            },
          ]
        : [],
    );

    renderSidebar();
    await expandWorkspace('other');
    expect(archiveButtonFor('Secondary active')).toBeUndefined();
    expect(container.textContent).not.toContain('Archived');
  });

  it('keeps a locked untrusted secondary active row read-only', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [...capabilities.features, 'session_organization'],
    };
    useWorkspaceSessionCatalog(async (cwd, options) =>
      cwd === '/tmp/danger' && options?.archiveState === 'active'
        ? [
            {
              sessionId: 'untrusted-active',
              workspaceCwd: cwd,
              displayName: 'Untrusted active',
            },
          ]
        : [],
    );

    renderSidebar({ lockedWorkspaceCwd: '/tmp/danger' });
    await ensureWorkspaceExpanded('danger');
    expect(container.textContent).toContain('Untrusted active');
    expect(sessionAction('Untrusted active')).toBeUndefined();
    expect(inlineSessionAction('Untrusted active', 'Pin')).toBeUndefined();
    expect(inlineSessionAction('Untrusted active', 'Delete')).toBeUndefined();
    expect(archiveButtonFor('Untrusted active')).toBeUndefined();
    expect(archiveSessionsData).not.toHaveBeenCalled();
    expect(deleteSessionsData).not.toHaveBeenCalled();
    expect(updateSessionOrganization).not.toHaveBeenCalled();
  });

  it('keeps an untrusted primary active row read-only and action-free', async () => {
    connection.sessionId = 'untrusted-primary-active';
    connection.workspaceCwd = '/tmp/project';
    connection.capabilities = {
      ...capabilities,
      features: [
        ...capabilities.features,
        'session_organization',
        'session_export',
      ],
      workspaces: capabilities.workspaces.map((entry) =>
        entry.primary ? { ...entry, trusted: false } : entry,
      ),
    };
    workspace.capabilities = connection.capabilities;
    active.sessions.push({
      sessionId: 'untrusted-primary-active',
      workspaceCwd: '/tmp/project',
      displayName: 'Untrusted primary active',
    });

    renderSidebar({
      sessionActions: {
        items: [
          'details',
          'rename',
          'pin',
          'group',
          'archive',
          'export',
          'delete',
        ],
        inlineItems: ['rename', 'pin', 'archive', 'export', 'delete'],
      },
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('Untrusted primary active');
    // Active read-only rows have no action menu; archived rows retain the
    // separately configured Details-only menu below.
    expect(sessionAction('Untrusted primary active')).toBeUndefined();
    expect(
      inlineSessionAction('Untrusted primary active', 'Pin'),
    ).toBeUndefined();
    expect(
      inlineSessionAction('Untrusted primary active', 'Delete'),
    ).toBeUndefined();
    expect(
      inlineSessionAction(
        'Untrusted primary active',
        'Export conversation record',
      ),
    ).toBeUndefined();
    expect(
      inlineSessionAction('Untrusted primary active', 'Rename'),
    ).toBeUndefined();
    expect(archiveButtonFor('Untrusted primary active')).toBeUndefined();
    expect(sessionActions.renameSession).not.toHaveBeenCalled();
    expect(active.archiveSession).not.toHaveBeenCalled();
    expect(active.deleteSession).not.toHaveBeenCalled();
    expect(active.exportSession).not.toHaveBeenCalled();
  });

  it('surfaces a locked-secondary delete item error without falling back to primary', async () => {
    const onError = vi.fn();
    deleteSessionsData.mockResolvedValue({
      removed: [],
      notFound: [],
      errors: [
        {
          sessionId: 'locked-delete-error',
          error: 'daemon denied delete',
        },
      ],
    });
    useWorkspaceSessionCatalog(async (cwd, options) =>
      cwd === '/tmp/other' && options?.archiveState === 'active'
        ? [
            {
              sessionId: 'locked-delete-error',
              workspaceCwd: cwd,
              displayName: 'Locked delete error',
            },
          ]
        : [],
    );

    renderSidebar({
      lockedWorkspaceCwd: '/tmp/other',
      onError,
      sessionActions: { items: ['delete'], inlineItems: ['delete'] },
    });
    await ensureWorkspaceExpanded('other');
    const deleteButton = inlineSessionAction('Locked delete error', 'Delete');
    expect(deleteButton).toBeDefined();

    await act(async () => {
      click(deleteButton!);
      await Promise.resolve();
    });
    await act(async () => {
      click(dialogButton('Delete'));
      await deleteSessionsData.mock.results.at(-1)?.value;
      await Promise.resolve();
    });

    expect(deleteSessionsData).toHaveBeenCalledWith(['locked-delete-error']);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'daemon denied delete' }),
      'Failed to delete session',
    );
    expect(active.deleteSession).not.toHaveBeenCalled();
    expect(active.reload).not.toHaveBeenCalled();
    expect(archived.reload).not.toHaveBeenCalled();
    expect(inlineSessionAction('Locked delete error', 'Delete')?.disabled).toBe(
      false,
    );
  });

  it('treats an idempotent secondary archive as success despite a matching current id', async () => {
    const onError = vi.fn();
    connection.sessionId = 'shared-session';
    connection.workspaceCwd = '/tmp/project';
    active.sessions.push({
      sessionId: 'shared-session',
      displayName: 'Legacy primary shared',
    } as DaemonSessionSummary);
    useWorkspaceSessionCatalog(async (cwd, options) =>
      cwd === '/tmp/other' && options?.archiveState === 'active'
        ? [
            {
              sessionId: 'shared-session',
              workspaceCwd: cwd,
              displayName: 'Secondary shared',
            },
          ]
        : [],
    );
    archiveSessionsData.mockResolvedValue({
      archived: [],
      alreadyArchived: ['shared-session'],
      notFound: [],
      errors: [],
    });

    renderSidebar({ onError });
    await expandWorkspace('project');
    await expandWorkspace('other');
    const primaryArchiveButton = archiveButtonFor('Legacy primary shared');
    const archiveButton = archiveButtonFor('Secondary shared');
    expect(primaryArchiveButton).toBeDefined();
    expect(primaryArchiveButton?.disabled).toBe(true);
    expect(archiveButton).toBeDefined();
    expect(archiveButton?.disabled).toBe(false);
    await act(async () => {
      click(archiveButton!);
      await archiveSessionsData.mock.results.at(-1)?.value;
      await Promise.resolve();
    });

    expect(archiveSessionsData).toHaveBeenCalledWith(['shared-session']);
    expect(onError).not.toHaveBeenCalled();
    expect(active.reload).toHaveBeenCalled();
    expect(archived.reload).toHaveBeenCalled();
  });

  it('keeps equal-id archive busy state scoped to its workspace', async () => {
    let finishArchive!: (result: {
      archived: string[];
      alreadyArchived: string[];
      notFound: string[];
      errors: [];
    }) => void;
    archiveSessionsData.mockReturnValue(
      new Promise((resolve) => {
        finishArchive = resolve;
      }),
    );
    active.sessions.push({
      sessionId: 'shared-pending',
      workspaceCwd: '/tmp/project',
      displayName: 'Primary pending',
    });
    useWorkspaceSessionCatalog(async (cwd, options) =>
      cwd === '/tmp/other' && options?.archiveState === 'active'
        ? [
            {
              sessionId: 'shared-pending',
              workspaceCwd: cwd,
              displayName: 'Secondary pending',
            },
          ]
        : [],
    );

    renderSidebar();
    await expandWorkspace('project');
    await expandWorkspace('other');
    const secondaryArchive = archiveButtonFor('Secondary pending');
    expect(secondaryArchive).toBeDefined();

    await act(async () => {
      click(secondaryArchive!);
      await Promise.resolve();
    });

    expect(archiveButtonFor('Secondary pending')?.disabled).toBe(true);
    expect(archiveButtonFor('Primary pending')?.disabled).toBe(false);

    await act(async () => {
      finishArchive({
        archived: ['shared-pending'],
        alreadyArchived: [],
        notFound: [],
        errors: [],
      });
      await archiveSessionsData.mock.results.at(-1)?.value;
    });
  });
});

describe('WebShellSidebar goals entry', () => {
  it('renders the Goals footer button and invokes onOpenGoals', () => {
    const onOpenGoals = vi.fn();
    renderSidebar({ onOpenGoals });
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Goals"]',
    );
    expect(button).not.toBeNull();
    click(button!);
    expect(onOpenGoals).toHaveBeenCalledTimes(1);
  });
});

describe('WebShellSidebar primary workspace header', () => {
  it('does not tag the primary workspace with a redundant "Primary" badge', () => {
    // Multi-workspace sidebar: the primary section used to append a "Primary"
    // badge to its header. The workspace selector's checkmark already conveys
    // the default target, so the badge was dropped. Assert it is gone while the
    // primary workspace ('/tmp/project') still renders by its folder name — so
    // a regression re-adding the badge would flip this red.
    renderSidebar();
    const primaryBadges = Array.from(container.querySelectorAll('span')).filter(
      (el) => el.textContent === 'Primary',
    );
    expect(primaryBadges).toHaveLength(0);
    expect(container.textContent).toContain('project');
  });
});

describe('WebShellSidebar archived session export', () => {
  const exportResult = {
    content: '<p>exported</p>',
    filename: 'session.html',
    mimeType: 'text/html',
    format: 'html' as const,
  };

  beforeEach(() => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:session-export'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    exportArchivedSession.mockResolvedValue(exportResult);
  });

  it('hides export without the archived export capability', async () => {
    archived.sessions.push({
      sessionId: 'archived-primary',
      displayName: 'Archived primary',
      workspaceCwd: '/tmp/project',
      isArchived: true,
    });
    renderSidebar();
    await expandArchived();

    const trigger = sessionAction('Archived primary');
    expect(trigger).toBeDefined();
    await act(async () => {
      click(trigger!);
      await Promise.resolve();
    });

    expect(
      Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).some((item) => item.textContent?.includes('Export')),
    ).toBe(false);
  });

  it('hides export for an untrusted archived workspace', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [...capabilities.features, 'workspace_archived_session_export'],
    };
    archived.sessions.push({
      sessionId: 'archived-untrusted',
      displayName: 'Archived untrusted',
      workspaceCwd: '/tmp/danger',
      isArchived: true,
    });
    renderSidebar();
    await expandArchived();

    const trigger = sessionAction('Archived untrusted');
    expect(trigger).toBeDefined();
    await act(async () => {
      click(trigger!);
      await Promise.resolve();
    });

    const archivedItems = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).map((item) => item.textContent);
    expect(archivedItems).toEqual(['Details']);
    expect(deleteSessionsData).not.toHaveBeenCalled();
    expect(unarchiveSessionsData).not.toHaveBeenCalled();
  });

  it('keeps an untrusted primary archived row action-free except configured Details', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [
        ...capabilities.features,
        'session_organization',
        'session_export',
        'workspace_archived_session_export',
      ],
      workspaces: capabilities.workspaces.map((entry) =>
        entry.primary ? { ...entry, trusted: false } : entry,
      ),
    };
    workspace.capabilities = connection.capabilities;
    archived.sessions.push({
      sessionId: 'untrusted-primary-archived',
      workspaceCwd: '/tmp/project',
      displayName: 'Untrusted primary archived',
      isArchived: true,
    });
    archived.deleteSession.mockClear();
    archived.unarchiveSession.mockClear();

    renderSidebar({
      sessionActions: {
        items: [
          'details',
          'rename',
          'pin',
          'group',
          'archive',
          'export',
          'delete',
        ],
      },
    });
    await expandArchived();

    const items = await openSessionMenuItems('Untrusted primary archived');
    expect(items).toEqual(['Details']);
    expect(archived.unarchiveSession).not.toHaveBeenCalled();
    expect(archived.deleteSession).not.toHaveBeenCalled();
    expect(exportArchivedSession).not.toHaveBeenCalled();
  });

  it('exports equal-id archived rows through their owning workspaces', async () => {
    connection.capabilities = {
      ...capabilities,
      features: [...capabilities.features, 'workspace_archived_session_export'],
    };
    archived.sessions.push({
      sessionId: 'same-session',
      displayName: 'Primary archive',
      isArchived: true,
    });
    let releasePrimary!: (value: typeof exportResult) => void;
    const primaryExport = vi.fn(
      () =>
        new Promise<typeof exportResult>((resolve) => {
          releasePrimary = resolve;
        }),
    );
    const secondaryExport = vi.fn().mockResolvedValue(exportResult);
    workspace.client.workspaceByCwd.mockImplementation((cwd: string) => ({
      listWorkspaceSessions: async (options?: { archiveState?: string }) =>
        cwd === '/tmp/other' && options?.archiveState === 'archived'
          ? [
              {
                sessionId: 'same-session',
                displayName: 'Secondary archive',
                workspaceCwd: cwd,
                isArchived: true,
              },
            ]
          : [],
      listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
      archiveSessionsData,
      unarchiveSessionsData,
      exportArchivedSession:
        cwd === '/tmp/project' ? primaryExport : secondaryExport,
    }));
    renderSidebar();
    await expandArchived();

    expect(sessionAction('Primary archive')).toBeDefined();
    expect(sessionAction('Secondary archive')).toBeDefined();
    try {
      await selectSessionMenuItem('Primary archive', 'Export');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const secondaryTrigger = sessionAction('Secondary archive');
      expect(secondaryTrigger).toBeDefined();
      await act(async () => {
        click(secondaryTrigger!);
        await Promise.resolve();
      });
      const secondaryItem = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).find((item) => item.textContent?.includes('Export'));
      expect(secondaryItem?.getAttribute('data-disabled')).toBeNull();
      await act(async () => {
        click(secondaryItem!);
        await Promise.resolve();
      });

      expect(secondaryExport).toHaveBeenCalledWith('same-session', {
        format: 'html',
      });
      await act(async () => {
        releasePrimary(exportResult);
        await Promise.resolve();
      });
    } finally {
      await act(async () => {
        releasePrimary?.(exportResult);
        await Promise.resolve();
      });
    }

    expect(primaryExport).toHaveBeenCalledWith('same-session', {
      format: 'html',
    });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});
