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

const { connection, workspace, workspaceActions, active, archived } =
  vi.hoisted(() => {
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
            listWorkspaceSessions: vi.fn().mockResolvedValue([]),
            listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
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
  features: ['multi_workspace_sessions', 'workspace_runtime_removal'],
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
  workspace.client.workspaceByCwd.mockImplementation(() => ({
    listWorkspaceSessions: vi.fn().mockResolvedValue([]),
    listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
  }));
  workspaceActions.removeWorkspace.mockReset();
  workspaceActions.removeWorkspace.mockResolvedValue({ removed: true });
  active.reload.mockClear();
  archived.reload.mockClear();
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
