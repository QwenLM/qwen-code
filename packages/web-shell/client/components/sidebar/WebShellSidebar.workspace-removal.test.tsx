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
  listWorkspaceSessions,
  archiveSessionsData,
  unarchiveSessionsData,
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
  return {
    connection: {
      status: 'connected',
      sessionId: null as string | null,
      workspaceCwd: '/tmp/project',
      capabilities: undefined as
        | {
            qwenCodeVersion: string;
            features: string[];
            workspaces: DaemonWorkspaceCapability[];
          }
        | undefined,
    },
    workspace: {
      capabilities: undefined as
        | {
            qwenCodeVersion: string;
            features: string[];
            workspaces: DaemonWorkspaceCapability[];
          }
        | undefined,
      client: {
        workspaceByCwd: vi.fn(() => ({
          listWorkspaceSessions,
          listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
          archiveSessionsData,
          unarchiveSessionsData,
        })),
      },
      refreshCapabilities: vi.fn(),
    },
    workspaceActions: {
      addWorkspace: vi.fn(),
      removeWorkspace: vi.fn(),
      listSessionGroups: vi.fn(),
    },
    active: makeSessions(),
    archived: makeSessions(),
    listWorkspaceSessions,
    archiveSessionsData,
    unarchiveSessionsData,
  };
});

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => connection,
  useActions: () => ({ renameSession: vi.fn() }),
  useWorkspace: () => workspace,
  useWorkspaceActions: () => workspaceActions,
  useSessions: (options?: { archiveState?: string }) =>
    options?.archiveState === 'archived' ? archived : active,
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
    lockedWorkspaceCwd?: string;
    lockedWorkspace?: {
      render?: (workspace: DaemonWorkspaceCapability) => ReactNode;
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
          onOpenSessions={() => {}}
          onOpenSplitView={() => {}}
          onNewSession={() => false}
          onLoadSession={() => {}}
          onError={overrides.onError ?? (() => {})}
          selectedWorkspaceCwd={overrides.selectedWorkspaceCwd}
          onSelectWorkspace={overrides.onSelectWorkspace}
          lockedWorkspaceCwd={overrides.lockedWorkspaceCwd}
          lockedWorkspace={overrides.lockedWorkspace}
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
  workspace.client.workspaceByCwd.mockImplementation(() => ({
    listWorkspaceSessions,
    listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
    archiveSessionsData,
    unarchiveSessionsData,
  }));
  workspaceActions.removeWorkspace.mockReset();
  workspaceActions.removeWorkspace.mockResolvedValue({ removed: true });
  active.reload.mockReset();
  active.reload.mockResolvedValue(undefined);
  archived.reload.mockReset();
  archived.reload.mockResolvedValue(undefined);
  active.sessions.length = 0;
  archived.sessions.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('WebShellSidebar workspace removal', () => {
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

    expect(workspaceAction('/tmp/danger')).toBeDefined();
    expect(workspaceAction('/tmp/project')).toBeUndefined();
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

    renderSidebar();
    await expandWorkspace('other');
    await expandArchived();
    const archiveButton = archiveButtonFor('Secondary active');
    expect(archiveButton).toBeDefined();
    const secondaryRow = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((row) => row.textContent?.includes('Secondary active'));
    expect(
      secondaryRow?.querySelector('button[aria-label="More actions"]'),
    ).toBeNull();

    await act(async () => {
      click(archiveButton!);
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

  it('keeps untrusted secondary sessions read-only', async () => {
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

    renderSidebar();
    await expandWorkspace('danger');
    expect(container.textContent).toContain('Untrusted active');
    expect(archiveButtonFor('Untrusted active')).toBeUndefined();
    expect(archiveSessionsData).not.toHaveBeenCalled();
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
