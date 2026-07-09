// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const {
  mockConnection,
  mockUseSessions,
  mockActive,
  mockArchived,
  renameSessionSpy,
  mockExportSession,
  mockWorkspaceActions,
} = vi.hoisted(() => {
  const makeStore = () => ({
    sessions: [] as MockSession[],
    loading: false,
    error: null as unknown,
    reload: vi.fn(),
    deleteSession: vi.fn().mockResolvedValue(true),
    archiveSession: vi.fn().mockResolvedValue(true),
    unarchiveSession: vi.fn().mockResolvedValue(true),
  });
  const mockActive = makeStore();
  const mockArchived = makeStore();
  const mockExportSession = vi.fn();
  const mockUseSessions = vi.fn(
    (options?: { archiveState?: 'active' | 'archived' }) =>
      options?.archiveState === 'archived'
        ? mockArchived
        : { ...mockActive, exportSession: mockExportSession },
  );
  return {
    mockConnection: {
      status: 'connected',
      sessionId: null as string | null,
      workspaceCwd: '/tmp/project',
      capabilities: { qwenCodeVersion: '1.2.3', features: [] as string[] } as
        | {
            qwenCodeVersion?: string;
            features?: string[];
            workspaces?: Array<{
              id: string;
              cwd: string;
              primary: boolean;
              trusted: boolean;
            }>;
          }
        | undefined,
    },
    mockUseSessions,
    mockActive,
    mockArchived,
    renameSessionSpy: vi.fn(),
    mockExportSession,
    mockWorkspaceActions: {
      listSessionGroups: vi.fn().mockResolvedValue({
        groups: [],
        colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
      }),
      createSessionGroup: vi.fn(),
      updateSessionGroup: vi.fn(),
      deleteSessionGroup: vi.fn(),
      updateSessionOrganization: vi.fn(),
    },
  };
});

type MockSession = {
  sessionId: string;
  workspaceCwd: string;
  displayName?: string;
  createdAt?: string;
  updatedAt?: string;
  clientCount?: number;
  hasActivePrompt?: boolean;
  isArchived?: boolean;
  isPinned?: boolean;
  groupId?: string | null;
  color?: 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | null;
};

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => mockConnection,
  useActions: () => ({ renameSession: renameSessionSpy }),
  useWorkspaceActions: () => mockWorkspaceActions,
  useSessions: (options?: { archiveState?: 'active' | 'archived' }) =>
    mockUseSessions(options),
}));

function makeSession(
  sessionId: string,
  over: Partial<MockSession> = {},
): MockSession {
  return {
    sessionId,
    workspaceCwd: '/tmp/project',
    displayName: `Session ${sessionId}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    clientCount: 0,
    hasActivePrompt: false,
    ...over,
  };
}

const { I18nProvider } = await import('../../i18n');
const { WebShellSidebar } = await import('./WebShellSidebar');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

const noop = () => {};
const SIDEBAR_WIDTH_STORAGE_KEY = 'qwen-code-web-shell-sidebar-width';

function setStoredSidebarWidth(width: number): void {
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
}

function pointerEvent(type: string, clientX: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, clientX });
}

function renderSidebar(
  collapsed: boolean,
  overrides: Partial<{
    onOpenSettings: () => void;
    onOpenDaemonStatus: () => void;
    onOpenScheduledTasks: () => void;
    onOpenSessions: () => void;
    canOpenSessionsOverview: boolean;
    onOpenSplitView: () => void;
    canOpenSplitView: boolean;
    onCollapsedChange: (collapsed: boolean) => void;
    onNewSession: () => Promise<boolean> | boolean;
    onLoadSession: (sessionId: string) => Promise<void> | void;
    onError: (error: unknown, message: string) => void;
    sessionListReloadToken: number;
    selectedWorkspaceCwd: string;
    onSelectWorkspace: (workspaceCwd: string | undefined) => void;
  }> = {},
): { container: HTMLElement; rerender: (props: typeof overrides) => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const doRender = (props: typeof overrides) => {
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WebShellSidebar
            collapsed={collapsed}
            onCollapsedChange={noop}
            onOpenSettings={noop}
            onOpenDaemonStatus={noop}
            onOpenScheduledTasks={noop}
            onOpenSessions={noop}
            onOpenSplitView={noop}
            onNewSession={() => false}
            onLoadSession={noop}
            onError={noop}
            {...props}
          />
        </I18nProvider>,
      );
    });
  };
  doRender(overrides);
  mounted.push({ root, container });
  return { container, rerender: doRender };
}

beforeEach(() => {
  mockUseSessions.mockClear();
  window.localStorage.clear();
  mockConnection.sessionId = null;
  mockConnection.capabilities = { qwenCodeVersion: '1.2.3', features: [] };
  for (const store of [mockActive, mockArchived]) {
    store.sessions = [];
    store.loading = false;
    store.error = null;
    store.reload.mockReset();
    store.deleteSession.mockReset();
    store.archiveSession.mockReset();
    store.unarchiveSession.mockReset();
    store.deleteSession.mockResolvedValue(true);
    store.archiveSession.mockResolvedValue(true);
    store.unarchiveSession.mockResolvedValue(true);
  }
  renameSessionSpy.mockClear();
  mockExportSession.mockReset();
  mockExportSession.mockResolvedValue({
    content: '<html>export</html>',
    filename: 'session.html',
    mimeType: 'text/html',
    format: 'html',
  });
  mockWorkspaceActions.listSessionGroups.mockReset();
  mockWorkspaceActions.listSessionGroups.mockResolvedValue({
    groups: [],
    colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
  });
  mockWorkspaceActions.createSessionGroup.mockReset();
  mockWorkspaceActions.updateSessionGroup.mockReset();
  mockWorkspaceActions.deleteSessionGroup.mockReset();
  mockWorkspaceActions.updateSessionOrganization.mockReset();
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WebShellSidebar — workspace picker', () => {
  const multiWorkspaceCaps = {
    qwenCodeVersion: '1.2.3',
    features: ['multi_workspace_sessions'],
    workspaces: [
      { id: 'ws-primary', cwd: '/tmp/project', primary: true, trusted: true },
      { id: 'ws-second', cwd: '/tmp/other', primary: false, trusted: true },
      {
        id: 'ws-untrusted',
        cwd: '/tmp/danger',
        primary: false,
        trusted: false,
      },
    ],
  };

  it('renders the picker when multiple workspaces are registered', () => {
    mockConnection.capabilities = multiWorkspaceCaps;
    const { container } = renderSidebar(false);
    const select = container.querySelector<HTMLSelectElement>(
      '#web-shell-workspace-picker',
    );
    expect(select).not.toBeNull();
    expect(select?.querySelectorAll('option').length).toBe(3);
  });

  it('disables untrusted workspace options and enables trusted ones', () => {
    mockConnection.capabilities = multiWorkspaceCaps;
    const { container } = renderSidebar(false);
    const options = Array.from(
      container.querySelectorAll<HTMLOptionElement>(
        '#web-shell-workspace-picker option',
      ),
    );
    const untrusted = options.find((o) => o.textContent?.includes('danger'));
    const trusted = options.find((o) => o.textContent?.includes('other'));
    expect(untrusted?.disabled).toBe(true);
    expect(trusted?.disabled).toBe(false);
  });

  it('calls onSelectWorkspace with the chosen cwd', () => {
    mockConnection.capabilities = multiWorkspaceCaps;
    const onSelectWorkspace = vi.fn();
    const { container } = renderSidebar(false, { onSelectWorkspace });
    const select = container.querySelector<HTMLSelectElement>(
      '#web-shell-workspace-picker',
    );
    expect(select).not.toBeNull();
    act(() => {
      if (select) {
        select.value = '/tmp/other';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    expect(onSelectWorkspace).toHaveBeenCalledWith('/tmp/other');
  });

  it('does not render the picker with a single workspace', () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['multi_workspace_sessions'],
      workspaces: [
        { id: 'ws-primary', cwd: '/tmp/project', primary: true, trusted: true },
      ],
    };
    const { container } = renderSidebar(false);
    expect(container.querySelector('#web-shell-workspace-picker')).toBeNull();
  });

  it('does not render the picker when collapsed', () => {
    mockConnection.capabilities = multiWorkspaceCaps;
    const { container } = renderSidebar(true);
    expect(container.querySelector('#web-shell-workspace-picker')).toBeNull();
  });
});

describe('WebShellSidebar — version footer', () => {
  it('shows the settings label and qwen-code version at full footer width', () => {
    setStoredSidebarWidth(360);
    const { container } = renderSidebar(false, {
      canOpenSessionsOverview: true,
      canOpenSplitView: true,
    });
    const settingsButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Settings"]',
    );
    const badge = container.querySelector('[title="Qwen Code v1.2.3"]');
    expect(settingsButton).not.toBeNull();
    expect(settingsButton?.textContent).toContain('Settings');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('v1.2.3');
  });

  it('shows the qwen-code version in the footer when expanded', () => {
    const { container } = renderSidebar(false);
    const badge = container.querySelector('[title="Qwen Code v1.2.3"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('v1.2.3');
  });

  it('hides the settings label first while keeping the settings button accessible', () => {
    setStoredSidebarWidth(260);
    const { container } = renderSidebar(false, {
      canOpenSessionsOverview: true,
      canOpenSplitView: true,
    });
    const settingsButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Settings"]',
    );
    const badge = container.querySelector('[title="Qwen Code v1.2.3"]');
    expect(settingsButton).not.toBeNull();
    expect(settingsButton?.title).toBe('Settings');
    expect(settingsButton?.textContent).not.toContain('Settings');
    expect(settingsButton?.querySelector('svg')).not.toBeNull();
    expect(badge).not.toBeNull();
  });

  it('hides the version at tight footer width', () => {
    setStoredSidebarWidth(220);
    const { container } = renderSidebar(false, {
      canOpenSessionsOverview: true,
      canOpenSplitView: true,
    });
    const settingsButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Settings"]',
    );
    expect(settingsButton).not.toBeNull();
    expect(settingsButton?.textContent).not.toContain('Settings');
    expect(container.querySelector('[title="Qwen Code v1.2.3"]')).toBeNull();
    expect(container.textContent ?? '').not.toContain('v1.2.3');
  });

  it('renders a non-semver fallback (e.g. "unknown") without a bogus "v" prefix', () => {
    mockConnection.capabilities = { qwenCodeVersion: 'unknown' };
    const { container } = renderSidebar(false);
    const badge = container.querySelector('[title="Qwen Code unknown"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('unknown');
    expect(container.textContent ?? '').not.toContain('vunknown');
  });

  it('hides the version when the sidebar is collapsed', () => {
    const { container } = renderSidebar(true);
    expect(container.querySelector('[title="Qwen Code v1.2.3"]')).toBeNull();
    expect(container.textContent ?? '').not.toContain('v1.2.3');
  });

  it('renders no version badge when the daemon reports none', () => {
    mockConnection.capabilities = undefined;
    const { container } = renderSidebar(false);
    expect(container.textContent ?? '').not.toMatch(/v\d/);
  });
});

describe('WebShellSidebar — brand logo', () => {
  it('renders the Qwen brand mark beside the new-chat button when expanded', () => {
    const { container } = renderSidebar(false);
    // Filled brand mark (shared with the favicon), not a stroked nav icon.
    const mark = container.querySelector('svg path[fill="#6D44E8"]');
    expect(mark).not.toBeNull();
    // The mark and the new-chat button share the same top row.
    const topRow = mark!.closest('div');
    expect(topRow?.querySelector('[aria-label="New chat"]')).not.toBeNull();
  });

  it('hides the brand mark when collapsed (only the new-chat button remains)', () => {
    const { container } = renderSidebar(true);
    expect(container.querySelector('svg path[fill="#6D44E8"]')).toBeNull();
    expect(container.querySelector('[aria-label="New chat"]')).not.toBeNull();
  });
});

describe('WebShellSidebar — daemon status entry', () => {
  it('invokes onOpenDaemonStatus when the footer button is clicked', () => {
    const onOpenDaemonStatus = vi.fn();
    const { container } = renderSidebar(false, { onOpenDaemonStatus });
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Daemon Status"]',
    );
    expect(button).not.toBeNull();
    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenDaemonStatus).toHaveBeenCalledTimes(1);
  });

  it('still exposes the daemon status button when collapsed', () => {
    const onOpenDaemonStatus = vi.fn();
    const { container } = renderSidebar(true, { onOpenDaemonStatus });
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Daemon Status"]',
    );
    expect(button).not.toBeNull();
    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenDaemonStatus).toHaveBeenCalledTimes(1);
  });
});

describe('WebShellSidebar — session overview entry', () => {
  it('offers the entry point only on large screens', () => {
    const small = renderSidebar(false, { canOpenSessionsOverview: false });
    expect(
      small.container.querySelector('[aria-label="Session Overview"]'),
    ).toBeNull();

    const large = renderSidebar(false, { canOpenSessionsOverview: true });
    expect(
      large.container.querySelector('[aria-label="Session Overview"]'),
    ).not.toBeNull();
  });

  it('invokes onOpenSessions when the footer button is clicked', () => {
    const onOpenSessions = vi.fn();
    const { container } = renderSidebar(false, {
      canOpenSessionsOverview: true,
      onOpenSessions,
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Session Overview"]',
    );
    expect(button).not.toBeNull();
    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenSessions).toHaveBeenCalledTimes(1);
  });
});

describe('WebShellSidebar — split view entry', () => {
  it('offers the split view entry only on large screens', () => {
    const small = renderSidebar(false, { canOpenSplitView: false });
    expect(
      small.container.querySelector('[aria-label="Split View"]'),
    ).toBeNull();

    const large = renderSidebar(false, { canOpenSplitView: true });
    expect(
      large.container.querySelector('[aria-label="Split View"]'),
    ).not.toBeNull();
  });

  it('invokes onOpenSplitView when the footer button is clicked', () => {
    const onOpenSplitView = vi.fn();
    const { container } = renderSidebar(false, {
      canOpenSplitView: true,
      onOpenSplitView,
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Split View"]',
    );
    expect(button).not.toBeNull();
    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenSplitView).toHaveBeenCalledTimes(1);
  });
});

describe('WebShellSidebar — resize behavior', () => {
  it('persists normal drag widths without collapsing', () => {
    setStoredSidebarWidth(260);
    const onCollapsedChange = vi.fn();
    const { container } = renderSidebar(false, { onCollapsedChange });
    const handle = container.querySelector<HTMLElement>('[role="separator"]');
    expect(handle).not.toBeNull();

    act(() => {
      handle!.dispatchEvent(pointerEvent('pointerdown', 260));
      window.dispatchEvent(pointerEvent('pointermove', 230));
      window.dispatchEvent(pointerEvent('pointerup', 230));
    });

    expect(onCollapsedChange).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('230');
  });

  it('collapses when dragged past the compact threshold and restores the expanded width', () => {
    setStoredSidebarWidth(260);
    const onCollapsedChange = vi.fn();
    const { container } = renderSidebar(false, { onCollapsedChange });
    const handle = container.querySelector<HTMLElement>('[role="separator"]');
    expect(handle).not.toBeNull();

    act(() => {
      handle!.dispatchEvent(pointerEvent('pointerdown', 260));
      window.dispatchEvent(pointerEvent('pointermove', 130));
    });

    expect(onCollapsedChange).toHaveBeenCalledWith(true);
    expect(onCollapsedChange).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('260');
  });
});

function click(el: Element | null): void {
  expect(el).not.toBeNull();
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

// Clicks that kick off an async action settle trailing state updates in
// `.finally()`; flush those microtasks inside act().
async function clickAsync(el: Element | null): Promise<void> {
  expect(el).not.toBeNull();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('WebShellSidebar — session organization', () => {
  it('uses organized sessions only when the daemon advertises the capability', () => {
    renderSidebar(false);
    expect(mockUseSessions).toHaveBeenCalledWith({
      autoLoad: true,
      pageSize: 1000,
      archiveState: 'active',
    });

    for (const { root, container } of mounted.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }

    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    mockWorkspaceActions.listSessionGroups.mockReturnValue(
      new Promise(() => undefined),
    );
    const { container } = renderSidebar(false);
    expect(mockUseSessions).toHaveBeenCalledWith({
      autoLoad: true,
      pageSize: 1000,
      archiveState: 'active',
      view: 'organized',
      group: 'all',
    });
    expect(container.querySelector('[aria-label="Session group"]')).toBeNull();
  });

  it('creates session groups from an in-app dialog form', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    mockWorkspaceActions.createSessionGroup.mockResolvedValue({
      id: 'group-1',
      name: 'Backend',
      color: 'green',
      order: 0,
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
    });
    mockActive.sessions = [
      makeSession('550e8400-e29b-41d4-a716-446655440000', {
        displayName: 'Review plan',
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
      }),
    ];
    const promptSpy = vi.spyOn(window, 'prompt');

    renderSidebar(false);
    await act(async () => {
      await Promise.resolve();
    });
    const organizeButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Group"]',
    );
    expect(organizeButton).not.toBeNull();
    act(() => {
      organizeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const createButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Create group'));
    expect(createButton).not.toBeNull();
    act(() => {
      createButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[maxlength="64"]',
    );
    expect(nameInput).not.toBeNull();
    const setInputValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      setInputValue?.call(nameInput, 'Backend');
      nameInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const colorSelect = Array.from(
      document.body.querySelectorAll<HTMLSelectElement>('select'),
    ).find((select) => select.value === 'red');
    expect(colorSelect).toBeDefined();
    const setSelectValue = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )?.set;
    act(() => {
      setSelectValue?.call(colorSelect, 'green');
      colorSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const saveButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'save');
    expect(saveButton).not.toBeNull();
    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(promptSpy).not.toHaveBeenCalled();
    expect(mockWorkspaceActions.createSessionGroup).toHaveBeenCalledWith({
      name: 'Backend',
      color: 'green',
    });
    // Creating a group for a session assigns it and clears any color tag —
    // color and named group are mutually exclusive in the UI.
    expect(mockWorkspaceActions.updateSessionOrganization).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000',
      { groupId: 'group-1', color: null },
    );
    promptSpy.mockRestore();
  });

  it('uses a themed group menu and assigns the selected group', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    mockWorkspaceActions.listSessionGroups.mockResolvedValue({
      groups: [
        {
          id: 'group-1',
          name: 'Backend',
          color: 'green',
          order: 0,
          createdAt: '2026-07-04T00:00:00.000Z',
          updatedAt: '2026-07-04T00:00:00.000Z',
        },
      ],
      colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
    });
    mockWorkspaceActions.updateSessionOrganization.mockResolvedValue({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      groupId: 'group-1',
      isPinned: false,
      updatedAt: '2026-07-04T00:00:00.000Z',
    });
    mockActive.sessions = [
      makeSession('550e8400-e29b-41d4-a716-446655440000', {
        displayName: 'Review plan',
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
      }),
    ];

    renderSidebar(false);
    await act(async () => {
      await Promise.resolve();
    });
    const organizeButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Group"]',
    );
    expect(organizeButton).not.toBeNull();
    act(() => {
      organizeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    const menu = document.body.querySelector<HTMLElement>(
      '[role="menu"][aria-label="Group"]',
    );
    expect(menu).not.toBeNull();
    expect(menu!.querySelector('select')).toBeNull();
    const selectedOption = menu!.querySelector<HTMLElement>(
      '[role="menuitemradio"][aria-checked="true"]',
    );
    expect(selectedOption?.textContent).toContain('Ungrouped');
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    expect(document.activeElement).toBe(selectedOption);
    act(() => {
      menu!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
        }),
      );
    });
    // One ArrowDown from "Ungrouped" now lands on the first color quick-pick.
    expect(document.activeElement?.textContent).toContain('Red');
    const groupOption = Array.from(
      menu!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Backend'));
    expect(groupOption).not.toBeNull();
    await act(async () => {
      groupOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Assigning a named group clears any color tag (single-choice).
    expect(mockWorkspaceActions.updateSessionOrganization).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000',
      { groupId: 'group-1', color: null },
    );
  });

  it('offers the six color quick-picks and assigns the chosen color', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    mockWorkspaceActions.updateSessionOrganization.mockResolvedValue({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      groupId: null,
      color: 'red',
      isPinned: false,
      updatedAt: '2026-07-04T00:00:00.000Z',
    });
    mockActive.sessions = [
      makeSession('550e8400-e29b-41d4-a716-446655440000', {
        displayName: 'Review plan',
      }),
    ];

    renderSidebar(false);
    await act(async () => {
      await Promise.resolve();
    });
    const organizeButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Group"]',
    );
    expect(organizeButton).not.toBeNull();
    act(() => {
      organizeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const menu = document.body.querySelector<HTMLElement>(
      '[role="menu"][aria-label="Group"]',
    );
    expect(menu).not.toBeNull();
    const radioLabels = Array.from(
      menu!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ).map((button) => button.textContent ?? '');
    // Ungrouped + all six colors are offered as single-choice radios.
    for (const name of [
      'Ungrouped',
      'Red',
      'Orange',
      'Yellow',
      'Green',
      'Blue',
      'Purple',
    ]) {
      expect(radioLabels.some((label) => label.includes(name))).toBe(true);
    }

    const redOption = Array.from(
      menu!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ).find((button) => button.textContent?.includes('Red'));
    expect(redOption).not.toBeNull();
    await act(async () => {
      redOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Picking a color clears any named-group assignment (single-choice).
    expect(mockWorkspaceActions.updateSessionOrganization).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000',
      { color: 'red', groupId: null },
    );
  });

  it('groups sessions into color sections ahead of the recent bucket', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    mockActive.sessions = [
      makeSession('session-red', { displayName: 'Red work', color: 'red' }),
      makeSession('session-plain', { displayName: 'Loose end', color: null }),
    ];

    const { container } = renderSidebar(false);
    await act(async () => {
      await Promise.resolve();
    });

    // A "Red" color section exists and holds the tagged session.
    const redSection = container.querySelector<HTMLElement>(
      'section[aria-label="Red"]',
    );
    expect(redSection).not.toBeNull();
    expect(redSection!.textContent).toContain('Red work');
    // The untagged session falls through to the Recent bucket.
    expect(container.textContent).toContain('Recent');
    expect(container.textContent).toContain('Loose end');
  });

  it('renders organized sessions as collapsible group sections', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    mockWorkspaceActions.listSessionGroups.mockResolvedValue({
      groups: [
        {
          id: 'group-1',
          name: 'Backend',
          color: 'green',
          order: 0,
          createdAt: '2026-07-04T00:00:00.000Z',
          updatedAt: '2026-07-04T00:00:00.000Z',
        },
      ],
      colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
    });
    mockActive.sessions = [
      makeSession('session-a', {
        displayName: 'API review',
        groupId: 'group-1',
      }),
      makeSession('session-b', {
        displayName: 'Release notes',
        groupId: null,
      }),
    ];

    const { container } = renderSidebar(false);
    await act(async () => {
      await Promise.resolve();
    });

    const backendHeader = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find(
      (button) =>
        button.textContent?.includes('Backend') &&
        button.textContent.includes('1'),
    );
    expect(backendHeader).not.toBeNull();
    expect(container.textContent).toContain('Recent');
    expect(container.textContent).toContain('API review');
    expect(container.textContent).toContain('Release notes');

    act(() => {
      backendHeader!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).not.toContain('API review');
    expect(container.textContent).toContain('Release notes');
  });

  it('reloads sessions after deleting a group', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    mockWorkspaceActions.listSessionGroups.mockResolvedValue({
      groups: [
        {
          id: 'group-1',
          name: 'Backend',
          color: 'green',
          order: 0,
          createdAt: '2026-07-04T00:00:00.000Z',
          updatedAt: '2026-07-04T00:00:00.000Z',
        },
      ],
      colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
    });
    mockWorkspaceActions.deleteSessionGroup.mockResolvedValue(true);
    mockActive.sessions = [
      makeSession('session-a', {
        displayName: 'API review',
        groupId: 'group-1',
      }),
    ];

    const { container } = renderSidebar(false);
    await act(async () => {
      await Promise.resolve();
    });
    mockWorkspaceActions.listSessionGroups.mockClear();

    const deleteGroupButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Delete group"]',
    );
    expect(deleteGroupButton).not.toBeNull();
    act(() => {
      deleteGroupButton!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    const confirmDeleteButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === 'Delete group');
    expect(confirmDeleteButton).toBeDefined();
    await act(async () => {
      confirmDeleteButton!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(mockWorkspaceActions.deleteSessionGroup).toHaveBeenCalledWith(
      'group-1',
    );
    expect(mockActive.reload).toHaveBeenCalledTimes(1);
    expect(mockWorkspaceActions.listSessionGroups).toHaveBeenCalledTimes(1);
  });

  it('toggles pin state from the session action button', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    mockWorkspaceActions.updateSessionOrganization.mockResolvedValue({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      groupId: null,
      isPinned: true,
      pinnedAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
    });
    mockActive.sessions = [
      makeSession('550e8400-e29b-41d4-a716-446655440000', {
        displayName: 'Review plan',
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
      }),
    ];

    const { container } = renderSidebar(false);
    await act(async () => {
      await Promise.resolve();
    });
    const pinButton =
      container.querySelector<HTMLButtonElement>('[aria-label="Pin"]');
    expect(pinButton).not.toBeNull();
    await act(async () => {
      pinButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockWorkspaceActions.updateSessionOrganization).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000',
      { isPinned: true },
    );
    expect(mockActive.reload).toHaveBeenCalledTimes(1);
  });

  it('does not drop organization actions for another session while one is busy', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    let resolveFirst: ((value: unknown) => void) | undefined;
    mockWorkspaceActions.updateSessionOrganization.mockImplementation(
      (sessionId: string) => {
        if (sessionId === 'session-a') {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({
          sessionId,
          groupId: null,
          isPinned: true,
          pinnedAt: '2026-07-04T00:00:00.000Z',
          updatedAt: '2026-07-04T00:00:00.000Z',
        });
      },
    );
    mockActive.sessions = [makeSession('session-a'), makeSession('session-b')];

    const { container } = renderSidebar(false);
    await act(async () => {
      await Promise.resolve();
    });
    const pinButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[aria-label="Pin"]'),
    );
    expect(pinButtons).toHaveLength(2);

    await act(async () => {
      pinButtons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      mockWorkspaceActions.updateSessionOrganization,
    ).toHaveBeenCalledTimes(1);

    await act(async () => {
      pinButtons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      mockWorkspaceActions.updateSessionOrganization,
    ).toHaveBeenCalledTimes(2);
    expect(
      mockWorkspaceActions.updateSessionOrganization,
    ).toHaveBeenLastCalledWith('session-b', { isPinned: true });

    await act(async () => {
      resolveFirst?.({
        sessionId: 'session-a',
        groupId: null,
        isPinned: true,
        pinnedAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
      });
      await Promise.resolve();
    });
  });

  it('keeps new session available while a session organization update is busy', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    let resolveUpdate: ((value: unknown) => void) | undefined;
    mockWorkspaceActions.updateSessionOrganization.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    mockActive.sessions = [makeSession('session-a')];
    const onNewSession = vi.fn();

    const { container } = renderSidebar(false, { onNewSession });
    await act(async () => {
      await Promise.resolve();
    });
    const pinButton =
      container.querySelector<HTMLButtonElement>('[aria-label="Pin"]');
    await act(async () => {
      pinButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const newSessionButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="New chat"]',
    );
    expect(newSessionButton).not.toBeNull();
    expect(newSessionButton!.disabled).toBe(false);
    act(() => {
      newSessionButton!.click();
    });
    expect(onNewSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveUpdate?.({
        sessionId: 'session-a',
        groupId: null,
        isPinned: true,
        pinnedAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
      });
      await Promise.resolve();
    });
    expect(newSessionButton!.disabled).toBe(false);
  });

  it('does not report organization failure when post-mutation reload fails', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    mockWorkspaceActions.updateSessionOrganization.mockResolvedValueOnce({
      sessionId: 'session-a',
      groupId: null,
      isPinned: true,
      pinnedAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
    });
    mockActive.reload.mockRejectedValueOnce(new Error('reload failed'));
    mockActive.sessions = [makeSession('session-a')];
    const onError = vi.fn();

    const { container } = renderSidebar(false, { onError });
    await act(async () => {
      await Promise.resolve();
    });
    const pinButton =
      container.querySelector<HTMLButtonElement>('[aria-label="Pin"]');
    await act(async () => {
      pinButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(mockWorkspaceActions.updateSessionOrganization).toHaveBeenCalledWith(
      'session-a',
      { isPinned: true },
    );
    expect(mockActive.reload).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('WebShellSidebar — session export', () => {
  it('hides export action when daemon does not advertise session_export', () => {
    mockActive.sessions = [makeSession('session-1')];
    const { container } = renderSidebar(false);

    expect(
      container.querySelector('[aria-label="Export conversation record"]'),
    ).toBeNull();
  });

  it('downloads an HTML export when export action is clicked', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_export'],
    };
    mockActive.sessions = [makeSession('session-1')];
    const createObjectURL = vi.fn(() => 'blob:session-export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    const { container } = renderSidebar(false);
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Export conversation record"]',
    );

    expect(button).not.toBeNull();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockExportSession).toHaveBeenCalledWith('session-1', 'html');
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:session-export');
  });

  it('does not block switching sessions while an export is running', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_export'],
    };
    mockActive.sessions = [makeSession('session-1'), makeSession('session-2')];
    let resolveExport:
      | ((value: Awaited<ReturnType<typeof mockExportSession>>) => void)
      | undefined;
    mockExportSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveExport = resolve;
      }),
    );
    const createObjectURL = vi.fn(() => 'blob:session-export');
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const onLoadSession = vi.fn();
    const { container } = renderSidebar(false, { onLoadSession });
    const exportButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Export conversation record"]',
    );

    await act(async () => {
      exportButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const secondSessionRow = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((el) => el.textContent?.includes('Session session-2'));
    click(secondSessionRow ?? null);

    expect(onLoadSession).toHaveBeenCalledWith('session-2');

    await act(async () => {
      resolveExport?.({
        content: '<html>export</html>',
        filename: 'session.html',
        mimeType: 'text/html',
        format: 'html',
      });
      await Promise.resolve();
    });
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  });

  it('reports export failures through onError', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_export'],
    };
    mockActive.sessions = [makeSession('session-1')];
    const error = new Error('download failed');
    mockExportSession.mockRejectedValueOnce(error);
    const onError = vi.fn();
    const { container } = renderSidebar(false, { onError });
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Export conversation record"]',
    );

    expect(button).not.toBeNull();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(onError).toHaveBeenCalledWith(error, 'Failed to export session');
  });
});

describe('WebShellSidebar — archive actions', () => {
  it('archives an active session from the quick action button', async () => {
    mockActive.sessions = [makeSession('aaaaaaaa')];
    const { container } = renderSidebar(false);
    const archiveBtn = container.querySelector<HTMLButtonElement>(
      '[aria-label="Archive"]',
    );
    expect(archiveBtn).not.toBeNull();
    expect(archiveBtn!.disabled).toBe(false);
    await clickAsync(archiveBtn);
    expect(mockActive.archiveSession).toHaveBeenCalledWith('aaaaaaaa');
    expect(mockArchived.unarchiveSession).not.toHaveBeenCalled();
  });

  it('disables archiving the current session', () => {
    mockActive.sessions = [makeSession('current1')];
    mockConnection.sessionId = 'current1';
    const { container } = renderSidebar(false);
    const archiveBtn = container.querySelector<HTMLButtonElement>(
      '[aria-label="Archive"]',
    );
    expect(archiveBtn).not.toBeNull();
    expect(archiveBtn!.disabled).toBe(true);
    click(archiveBtn);
    expect(mockActive.archiveSession).not.toHaveBeenCalled();
  });

  it('opens the overflow menu with rename, archive, and delete', () => {
    mockActive.sessions = [makeSession('aaaaaaaa')];
    const { container } = renderSidebar(false);
    click(container.querySelector('[aria-label="More actions"]'));
    const menu = container.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const labels = Array.from(menu!.querySelectorAll('[role="menuitem"]')).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(['Rename', 'Archive', 'Delete']);
  });

  it('archives a non-current session from the overflow menu', async () => {
    mockActive.sessions = [makeSession('aaaaaaaa')];
    const { container } = renderSidebar(false);
    click(container.querySelector('[aria-label="More actions"]'));
    const archiveItem = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((el) => el.textContent === 'Archive');
    await clickAsync(archiveItem ?? null);
    expect(mockActive.archiveSession).toHaveBeenCalledWith('aaaaaaaa');
  });

  it('reveals archived sessions on demand and restores them', async () => {
    mockArchived.sessions = [makeSession('bbbbbbbb', { isArchived: true })];
    const { container } = renderSidebar(false);
    // Collapsed by default: the archived rows (and their Restore button) are
    // not rendered until the section is expanded.
    expect(container.querySelector('[aria-label="Restore"]')).toBeNull();
    const header = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Archived'),
    );
    click(header ?? null);
    const restoreBtn = container.querySelector<HTMLButtonElement>(
      '[aria-label="Restore"]',
    );
    expect(restoreBtn).not.toBeNull();
    await clickAsync(restoreBtn);
    expect(mockArchived.unarchiveSession).toHaveBeenCalledWith('bbbbbbbb');
  });
});

describe('WebShellSidebar — sessionListReloadToken effect', () => {
  it('calls reload when token changes', async () => {
    mockActive.reload.mockResolvedValue(undefined);
    const { rerender } = renderSidebar(false, {
      sessionListReloadToken: 0,
    });
    expect(mockActive.reload).not.toHaveBeenCalled();

    rerender({ sessionListReloadToken: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockActive.reload).toHaveBeenCalledTimes(1);
  });

  it('does not call reload when token is undefined', async () => {
    mockActive.reload.mockResolvedValue(undefined);
    const { rerender } = renderSidebar(false);

    rerender({});
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockActive.reload).not.toHaveBeenCalled();
  });

  it('does not call reload when token is unchanged', async () => {
    mockActive.reload.mockResolvedValue(undefined);
    const { rerender } = renderSidebar(false, {
      sessionListReloadToken: 1,
    });
    mockActive.reload.mockClear();

    rerender({ sessionListReloadToken: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockActive.reload).not.toHaveBeenCalled();
  });

  it('skips reload when document is hidden', async () => {
    mockActive.reload.mockResolvedValue(undefined);
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    const { rerender } = renderSidebar(false, {
      sessionListReloadToken: 0,
    });

    rerender({ sessionListReloadToken: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockActive.reload).not.toHaveBeenCalled();

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
  });

  it('skips reload when a poll is already in flight', async () => {
    let resolveFirstPoll: (() => void) | undefined;
    mockActive.reload.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveFirstPoll = resolve;
      }),
    );
    const { rerender } = renderSidebar(false, {
      sessionListReloadToken: 0,
    });

    rerender({ sessionListReloadToken: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockActive.reload).toHaveBeenCalledTimes(1);

    mockActive.reload.mockResolvedValue(undefined);
    rerender({ sessionListReloadToken: 2 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockActive.reload).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstPoll?.();
      await Promise.resolve();
    });

    rerender({ sessionListReloadToken: 3 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockActive.reload).toHaveBeenCalledTimes(2);
  });
});
