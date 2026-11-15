// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
import { readWorkspaceOrder, writeWorkspaceOrder } from './workspaceOrder';
import {
  hasWorkspaceExpansionPreference,
  readWorkspaceExpanded,
} from './workspaceExpansion';
import styles from './WebShellSidebar.module.css';

const { connection, workspace, workspaceActions, active } = vi.hoisted(() => {
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
          // The header actions poll git; answer as a non-git workspace.
          workspaceGit: vi
            .fn()
            .mockResolvedValue({ v: 2, workspaceCwd: '', branch: null }),
          listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
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
      listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
    },
    active,
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

const { I18nProvider } = await import('../../i18n');
const { WebShellSidebar } = await import('./WebShellSidebar');

installSidebarDomShims();

const capabilities = {
  qwenCodeVersion: '1.2.3',
  features: [
    'multi_workspace_sessions',
    'workspace_qualified_rest_core',
    'workspace_session_metadata',
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
    {
      id: 'third',
      cwd: '/tmp/third',
      primary: false,
      trusted: true,
      removable: true,
    },
  ],
} satisfies NonNullable<typeof workspace.capabilities>;

let root: Root;
let container: HTMLDivElement;

function renderSidebar(): void {
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
          onLoadSession={() => {}}
          onError={() => {}}
        />
      </I18nProvider>,
    );
  });
}

function workspaceRows(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[class*="workspaceList"] [class*="headerRow"]',
    ),
  );
}

function workspaceOrderInDom(): string[] {
  return workspaceRows().map(
    (row) =>
      row.querySelector<HTMLElement>('[class*="name"][title]')?.title ?? '',
  );
}

type DragTransfer = {
  effectAllowed: string;
  dropEffect?: string;
  setData: (format: string, data: string) => void;
};

function dispatchWorkspaceDrag(
  element: Element,
  name: string,
  transfer: DragTransfer,
  clientY = 0,
): void {
  const event = new Event(name, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: transfer },
    clientY: { value: clientY },
  });
  act(() => element.dispatchEvent(event));
}

async function openWorkspaceMenu(cwd: string): Promise<void> {
  const row = workspaceRows().find(
    (candidate) =>
      candidate.querySelector<HTMLElement>('[class*="name"]')?.title === cwd,
  );
  const button = row?.querySelector<HTMLButtonElement>(
    'button[aria-label="Workspace actions"]',
  );
  expect(button).toBeDefined();
  await act(async () => {
    clickSidebarElement(button!, true);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function menuItem(label: string): HTMLElement | undefined {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((item) => item.textContent?.trim() === label);
}

function menuItemLabels(): string[] {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).map((item) => item.textContent?.trim() ?? '');
}

async function selectMenuItem(label: string): Promise<void> {
  const item = menuItem(label);
  expect(item).toBeDefined();
  await act(async () => {
    clickSidebarElement(item!, true);
    await Promise.resolve();
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
  workspace.client.getWorkspaceOrder
    .mockReset()
    .mockResolvedValue({ cwds: [] });
  workspace.client.setWorkspaceOrder
    .mockReset()
    .mockResolvedValue({ cwds: [] });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
});

describe('WebShellSidebar workspace order', () => {
  it('does not reread saved expansion preferences on unrelated renders', async () => {
    const prefix = 'qwen.web-shell.sidebar.workspace-expanded:';
    for (const entry of capabilities.workspaces) {
      const id = entry.primary ? `primary:${entry.cwd}` : entry.id;
      localStorage.setItem(`${prefix}${id}`, 'false');
    }
    renderSidebar();
    await flushSidebar();
    expect(
      container.querySelector('button[aria-label="Expand all workspaces"]'),
    ).not.toBeNull();
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    renderSidebar();
    await flushSidebar();
    const reads = getItem.mock.calls.filter(([key]) => key.startsWith(prefix));
    getItem.mockRestore();
    expect(reads).toEqual([]);
  });

  it('reloads the server order after a primary change at the same host', async () => {
    workspace.capabilities = {
      ...capabilities,
      features: [...capabilities.features, 'workspace_order'],
    };
    workspace.client.getWorkspaceOrder.mockResolvedValueOnce({
      cwds: ['/tmp/third', '/tmp/project', '/tmp/second'],
    });
    renderSidebar();
    await flushSidebar();
    expect(workspaceOrderInDom()).toEqual([
      '/tmp/third',
      '/tmp/project',
      '/tmp/second',
    ]);
    workspace.client.getWorkspaceOrder.mockResolvedValueOnce({
      cwds: ['/tmp/second', '/tmp/third', '/tmp/project'],
    });
    workspace.capabilities = {
      ...workspace.capabilities,
      workspaces: capabilities.workspaces.map((entry) => ({
        ...entry,
        primary: entry.id === 'second',
      })),
    };
    renderSidebar();
    await flushSidebar();
    expect(workspace.client.getWorkspaceOrder).toHaveBeenCalledTimes(2);
    expect(workspaceOrderInDom()).toEqual([
      '/tmp/second',
      '/tmp/third',
      '/tmp/project',
    ]);
    expect(workspace.client.setWorkspaceOrder).not.toHaveBeenCalled();
  });

  it('keeps the bulk control in sync after primary and secondary roles change', async () => {
    workspace.capabilities = {
      ...capabilities,
      workspaces: capabilities.workspaces.slice(0, 2),
    };
    renderSidebar();
    await flushSidebar();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Collapse all workspaces"]',
        )!
        .click(),
    );
    await flushSidebar();
    workspace.capabilities = {
      ...capabilities,
      workspaces: capabilities.workspaces.slice(0, 2).map((entry) => ({
        ...entry,
        primary: entry.id === 'second',
      })),
    };
    renderSidebar();
    await flushSidebar();
    expect(
      workspaceRows().map((row) =>
        row
          .querySelector('button[aria-expanded]')!
          .getAttribute('aria-expanded'),
      ),
    ).toEqual(['false', 'false']);
    const expandAll = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand all workspaces"]',
    );
    expect(expandAll).not.toBeNull();
    act(() => expandAll!.click());
    expect(
      workspaceRows().map((row) =>
        row
          .querySelector('button[aria-expanded]')!
          .getAttribute('aria-expanded'),
      ),
    ).toEqual(['true', 'true']);
  });

  it.each([false, true])(
    'restores display when the drag source disappears (collapse started: %s)',
    async (collapseStarted) => {
      renderSidebar();
      await flushSidebar();
      act(() =>
        workspaceRows()[1]!
          .querySelector<HTMLButtonElement>('button[aria-expanded]')!
          .click(),
      );
      const source =
        workspaceRows()[2]!.querySelector<HTMLButtonElement>(
          '[draggable="true"]',
        )!;
      const event = new Event('dragstart', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { setData: vi.fn(), effectAllowed: '' },
      });
      act(() => source.dispatchEvent(event));
      if (collapseStarted) {
        await act(async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
        expect(
          workspaceRows()[0]!
            .querySelector('button[aria-expanded]')!
            .getAttribute('aria-expanded'),
        ).toBe('false');
      }
      workspace.capabilities = {
        ...capabilities,
        workspaces: capabilities.workspaces.filter(
          (entry) => entry.id !== 'third',
        ),
      };
      renderSidebar();
      await flushSidebar();
      expect(source.isConnected).toBe(false);
      act(() => source.dispatchEvent(new Event('dragend', { bubbles: true })));
      expect(
        workspaceRows().map((row) =>
          row
            .querySelector('button[aria-expanded]')!
            .getAttribute('aria-expanded'),
        ),
      ).toEqual(['true', 'false']);
      expect(readWorkspaceOrder(window.location.origin)).toEqual([]);
      expect(readWorkspaceExpanded('primary:/tmp/project')).toBe(true);
      expect(readWorkspaceExpanded('second')).toBe(false);
    },
  );

  it.each([false, true])(
    'cancels dragging when only the source remains (collapse started: %s)',
    async (collapseStarted) => {
      workspace.capabilities = {
        ...capabilities,
        workspaces: capabilities.workspaces.slice(0, 2),
      };
      renderSidebar();
      await flushSidebar();
      const source =
        workspaceRows()[0]!.querySelector<HTMLButtonElement>(
          '[draggable="true"]',
        )!;
      const event = new Event('dragstart', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { setData: vi.fn(), effectAllowed: '' },
      });
      act(() => source.dispatchEvent(event));
      if (collapseStarted) {
        await act(async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
        expect(source.getAttribute('aria-expanded')).toBe('false');
      }
      workspace.capabilities = {
        ...capabilities,
        workspaces: capabilities.workspaces.slice(0, 1),
      };
      renderSidebar();
      await flushSidebar();
      expect(source.isConnected).toBe(true);
      expect(source.hasAttribute('draggable')).toBe(false);
      act(() => source.dispatchEvent(new Event('dragend', { bubbles: true })));
      expect(source.getAttribute('aria-expanded')).toBe('true');
      expect(readWorkspaceOrder(window.location.origin)).toEqual([]);
    },
  );

  it('collapses and expands all workspace rows and persists individual choices', async () => {
    renderSidebar();
    await flushSidebar();
    const bulkButton = () =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label$="all workspaces"]',
      )!;
    const headers = () =>
      workspaceRows().map(
        (row) => row.querySelector<HTMLButtonElement>('button[aria-expanded]')!,
      );
    act(() => bulkButton().click());
    expect(
      headers().map((button) => button.getAttribute('aria-expanded')),
    ).toEqual(['false', 'false', 'false']);
    expect(readWorkspaceExpanded('primary:/tmp/project')).toBe(false);
    expect(readWorkspaceExpanded('second')).toBe(false);
    expect(readWorkspaceExpanded('third')).toBe(false);
    expect(bulkButton().getAttribute('aria-label')).toBe(
      'Expand all workspaces',
    );
    act(() => headers()[1]!.click());
    expect(bulkButton().getAttribute('aria-label')).toBe(
      'Collapse all workspaces',
    );
    act(() => bulkButton().click());
    act(() => bulkButton().click());
    expect(
      headers().map((button) => button.getAttribute('aria-expanded')),
    ).toEqual(['true', 'true', 'true']);
    expect(readWorkspaceExpanded('second')).toBe(true);
  });

  it('temporarily collapses on drag, restores on cancellation and persists valid drops', async () => {
    renderSidebar();
    await flushSidebar();
    act(() =>
      workspaceRows()[1]!
        .querySelector<HTMLButtonElement>('button[aria-expanded]')!
        .click(),
    );
    const transfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
    const dispatchDrag = (element: Element, name: string, clientY = 0) =>
      dispatchWorkspaceDrag(element, name, transfer, clientY);
    const source =
      workspaceRows()[2]!.querySelector<HTMLButtonElement>(
        '[draggable="true"]',
      )!;
    dispatchDrag(source, 'dragstart');
    expect(transfer.setData).toHaveBeenCalledWith(
      'application/x-qwen-workspace-cwd',
      '/tmp/third',
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(
      workspaceRows().map((row) =>
        row
          .querySelector('button[aria-expanded]')!
          .getAttribute('aria-expanded'),
      ),
    ).toEqual(['false', 'false', 'false']);
    expect(readWorkspaceExpanded('third')).toBe(true);
    dispatchDrag(source, 'dragend');
    expect(
      workspaceRows().map((row) =>
        row
          .querySelector('button[aria-expanded]')!
          .getAttribute('aria-expanded'),
      ),
    ).toEqual(['true', 'false', 'true']);
    expect(readWorkspaceOrder(window.location.origin)).toEqual([]);
    dispatchDrag(source, 'dragstart');
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const target = container.querySelector(
      '[data-sidebar-workspace="/tmp/project"]',
    )!;
    dispatchDrag(target, 'dragover');
    dispatchDrag(target, 'drop');
    expect(workspaceOrderInDom()).toEqual([
      '/tmp/third',
      '/tmp/project',
      '/tmp/second',
    ]);
    expect(readWorkspaceOrder(window.location.origin)).toEqual([
      '/tmp/third',
      '/tmp/project',
      '/tmp/second',
    ]);
    expect(
      workspaceRows().map((row) =>
        row
          .querySelector('button[aria-expanded]')!
          .getAttribute('aria-expanded'),
      ),
    ).toEqual(['true', 'true', 'false']);
    const nextSource =
      workspaceRows()[0]!.querySelector<HTMLButtonElement>(
        '[draggable="true"]',
      )!;
    dispatchDrag(nextSource, 'dragstart');
    dispatchDrag(nextSource, 'dragend');
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(
      workspaceRows()[0]!
        .querySelector('button[aria-expanded]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('does not move a collapsed primary preference onto a different workspace', async () => {
    renderSidebar();
    await flushSidebar();
    act(() =>
      workspaceRows()[0]!
        .querySelector<HTMLButtonElement>('button[aria-expanded]')!
        .click(),
    );
    expect(readWorkspaceExpanded('primary')).toBe(false);
    workspace.capabilities = {
      ...capabilities,
      workspaces: capabilities.workspaces.slice(0, 2).map((entry) => ({
        ...entry,
        primary: entry.id === 'second',
      })),
    };
    renderSidebar();
    await flushSidebar();
    expect(
      workspaceRows().map((row) =>
        row
          .querySelector('button[aria-expanded]')!
          .getAttribute('aria-expanded'),
      ),
    ).toEqual(['false', 'true']);
    expect(readWorkspaceExpanded('second')).toBe(true);
  });

  it('does not carry a provisional preference across a host switch', async () => {
    connection.workspaceCwd = '/tmp/project-link';
    workspace.capabilities = {
      qwenCodeVersion: capabilities.qwenCodeVersion,
      features: capabilities.features,
    };
    renderSidebar();
    await flushSidebar();
    act(() =>
      workspaceRows()[0]!
        .querySelector<HTMLButtonElement>('button[aria-expanded]')!
        .click(),
    );
    expect(readWorkspaceExpanded('primary:/tmp/project-link')).toBe(false);
    workspace.baseUrl = 'http://other-host';
    workspace.capabilities = {
      ...capabilities,
      workspaces: capabilities.workspaces.map((entry) => ({
        ...entry,
        id: `other-${entry.id}`,
        cwd: `/other${entry.cwd}`,
      })),
    };
    renderSidebar();
    await flushSidebar();
    expect(
      workspaceRows().map((row) =>
        row
          .querySelector('button[aria-expanded]')!
          .getAttribute('aria-expanded'),
      ),
    ).toEqual(['true', 'true', 'true']);
    expect(hasWorkspaceExpansionPreference('other-primary')).toBe(false);
  });

  it('does not apply a bulk request to a newly focused host', async () => {
    renderSidebar();
    await flushSidebar();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Collapse all workspaces"]',
        )!
        .click(),
    );
    workspace.baseUrl = 'http://other-host';
    workspace.capabilities = {
      ...capabilities,
      workspaces: capabilities.workspaces.map((entry) => ({
        ...entry,
        id: `other-${entry.id}`,
        cwd: `/other${entry.cwd}`,
      })),
    };
    renderSidebar();
    await flushSidebar();
    expect(
      workspaceRows().map((row) =>
        row
          .querySelector('button[aria-expanded]')!
          .getAttribute('aria-expanded'),
      ),
    ).toEqual(['true', 'true', 'true']);
    expect(
      window.localStorage.getItem(
        'qwen.web-shell.sidebar.workspace-expanded:other-second',
      ),
    ).toBeNull();
  });

  it('does not replay an earlier bulk action on a newly added workspace', async () => {
    renderSidebar();
    await flushSidebar();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Collapse all workspaces"]',
        )!
        .click(),
    );
    await flushSidebar();
    workspace.capabilities = {
      ...capabilities,
      workspaces: [
        ...capabilities.workspaces,
        {
          id: 'new-workspace',
          cwd: '/tmp/new-workspace',
          primary: false,
          trusted: true,
          removable: true,
        },
      ],
    };
    renderSidebar();
    await flushSidebar();
    expect(
      workspaceRows()[3]!
        .querySelector('button[aria-expanded]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      window.localStorage.getItem(
        'qwen.web-shell.sidebar.workspace-expanded:new-workspace',
      ),
    ).toBeNull();
  });

  it('moves a workspace up and persists the new order', async () => {
    renderSidebar();
    expect(workspaceOrderInDom()).toEqual([
      '/tmp/project',
      '/tmp/second',
      '/tmp/third',
    ]);

    await openWorkspaceMenu('/tmp/third');
    await selectMenuItem('Move up');

    expect(workspaceOrderInDom()).toEqual([
      '/tmp/project',
      '/tmp/third',
      '/tmp/second',
    ]);
    expect(readWorkspaceOrder(window.location.origin)).toEqual([
      '/tmp/project',
      '/tmp/third',
      '/tmp/second',
    ]);
  });

  it('restores a stored order and appends unlisted workspaces last', async () => {
    writeWorkspaceOrder(window.location.origin, ['/tmp/third']);
    renderSidebar();

    expect(workspaceOrderInDom()).toEqual([
      '/tmp/third',
      '/tmp/project',
      '/tmp/second',
    ]);
  });

  it('offers only the moves that can change the order', async () => {
    renderSidebar();

    await openWorkspaceMenu('/tmp/project');
    expect(menuItemLabels()).toContain('Move down');
    expect(menuItemLabels()).not.toContain('Move up');

    await openWorkspaceMenu('/tmp/third');
    expect(menuItemLabels()).toContain('Move up');
    expect(menuItemLabels()).not.toContain('Move down');
  });

  it('drops after a row when the pointer is past its midpoint', async () => {
    renderSidebar();
    await flushSidebar();
    const transfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
    const dispatchDrag = (element: Element, name: string, clientY = 0) =>
      dispatchWorkspaceDrag(element, name, transfer, clientY);
    const source =
      workspaceRows()[2]!.querySelector<HTMLButtonElement>(
        '[draggable="true"]',
      )!;
    dispatchDrag(source, 'dragstart');
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const target = container.querySelector<HTMLElement>(
      '[data-sidebar-workspace="/tmp/project"]',
    )!;
    target.getBoundingClientRect = () => ({
      top: 0,
      height: 20,
      bottom: 20,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    dispatchDrag(target, 'dragover', 18);
    expect(target.classList.contains(styles.workspaceDropAfter)).toBe(true);
    dispatchDrag(target, 'drop', 18);
    expect(workspaceOrderInDom()).toEqual([
      '/tmp/project',
      '/tmp/third',
      '/tmp/second',
    ]);
    expect(readWorkspaceOrder(window.location.origin)).toEqual([
      '/tmp/project',
      '/tmp/third',
      '/tmp/second',
    ]);
  });

  it('clears the drop indicator when the pointer leaves the row', async () => {
    renderSidebar();
    await flushSidebar();
    const transfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
    const dispatchDrag = (element: Element, name: string, clientY = 0) =>
      dispatchWorkspaceDrag(element, name, transfer, clientY);
    const source =
      workspaceRows()[2]!.querySelector<HTMLButtonElement>(
        '[draggable="true"]',
      )!;
    dispatchDrag(source, 'dragstart');
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const target = container.querySelector<HTMLElement>(
      '[data-sidebar-workspace="/tmp/project"]',
    )!;
    dispatchDrag(target, 'dragover');
    expect(target.classList.contains(styles.workspaceDropBefore)).toBe(true);
    dispatchDrag(target, 'dragleave');
    expect(target.classList.contains(styles.workspaceDropBefore)).toBe(false);
    dispatchDrag(source, 'dragend');
  });

  it('restores the sidebar scroll position after the drag collapse', async () => {
    renderSidebar();
    await flushSidebar();
    const body = container.querySelector<HTMLElement>(`.${styles.body}`)!;
    body.scrollTop = 150;
    const transfer = { effectAllowed: '', setData: vi.fn() };
    const dispatchDrag = (element: Element, name: string) =>
      dispatchWorkspaceDrag(element, name, transfer);
    const source =
      workspaceRows()[2]!.querySelector<HTMLButtonElement>(
        '[draggable="true"]',
      )!;
    dispatchDrag(source, 'dragstart');
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(
      workspaceRows()[0]!
        .querySelector('button[aria-expanded]')!
        .getAttribute('aria-expanded'),
    ).toBe('false');
    body.scrollTop = 0;
    dispatchDrag(source, 'dragend');
    expect(body.scrollTop).toBe(150);
  });

  it('saves a drag reorder to the server when the capability is advertised', async () => {
    workspace.capabilities = {
      ...capabilities,
      features: [...capabilities.features, 'workspace_order'],
    };
    workspace.client.getWorkspaceOrder.mockResolvedValueOnce({ cwds: [] });
    renderSidebar();
    await flushSidebar();
    const transfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
    const dispatchDrag = (element: Element, name: string) =>
      dispatchWorkspaceDrag(element, name, transfer);
    const source =
      workspaceRows()[2]!.querySelector<HTMLButtonElement>(
        '[draggable="true"]',
      )!;
    dispatchDrag(source, 'dragstart');
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const target = container.querySelector<HTMLElement>(
      '[data-sidebar-workspace="/tmp/project"]',
    )!;
    dispatchDrag(target, 'dragover');
    dispatchDrag(target, 'drop');
    await flushSidebar();
    expect(workspace.client.setWorkspaceOrder).toHaveBeenCalledWith([
      '/tmp/third',
      '/tmp/project',
      '/tmp/second',
    ]);
    expect(readWorkspaceOrder(window.location.origin)).toEqual([]);
  });

  it('migrates a provisional primary expansion preference onto the workspace id', async () => {
    localStorage.setItem(
      'qwen.web-shell.sidebar.workspace-expanded:primary:/tmp/project-link',
      'false',
    );
    connection.workspaceCwd = '/tmp/project-link';
    workspace.capabilities = {
      qwenCodeVersion: capabilities.qwenCodeVersion,
      features: capabilities.features,
    };
    renderSidebar();
    await flushSidebar();
    expect(
      workspaceRows()[0]!
        .querySelector('button[aria-expanded]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
    workspace.capabilities = capabilities;
    renderSidebar();
    await flushSidebar();
    expect(
      workspaceRows()[0]!
        .querySelector('button[aria-expanded]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(readWorkspaceExpanded('primary')).toBe(false);
    expect(hasWorkspaceExpansionPreference('primary:/tmp/project-link')).toBe(
      false,
    );
  });
});
