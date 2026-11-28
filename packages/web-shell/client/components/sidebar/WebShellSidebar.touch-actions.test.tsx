// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  clickSidebarElement as click,
  createSidebarMocks,
  DAEMON_APPROVAL_MODES,
  flushSidebar,
  installSidebarDomShims,
  makeSidebarSession as makeSession,
  sidebarSessionPage,
  useResolvedWebShellSessions,
  useSidebarSessionCatalogQuery,
} from '../../test/sidebarHarness';
import { LONG_PRESS_DELAY_MS } from './use-long-press';
import { TOUCH_SIDEBAR_MEDIA_QUERY } from './use-touch-sidebar-actions';

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
  useSessionCatalogController: () => ({
    refreshQueries: refreshSessionCatalogQueries,
    invalidateWorkspace: vi.fn(),
    refreshWorkspace: vi.fn(),
    renamed: vi.fn(),
    toggleSessionPinned: vi.fn(),
  }),
  useSessionCatalogPolling: () => undefined,
  useSessionCatalogQuery: (
    client: typeof mocks.workspace.client,
    query: { workspaceCwd: string; options?: Record<string, unknown> },
    options: { autoLoad?: boolean; enabled?: boolean },
  ) => useSidebarSessionCatalogQuery(client, query, options),
  useSessionCatalogQueries,
}));

const { I18nProvider } = await import('../../i18n');
const { WebShellPortalRootContext } = await import('../../portalRoot');
const { WebShellSidebar } = await import('./WebShellSidebar');

installSidebarDomShims();

const fullCapabilities = {
  qwenCodeVersion: '1.2.3',
  features: [
    'session_organization',
    'session_export',
    'session_archive',
    'workspace_session_metadata',
  ],
};

let root: Root | undefined;
let container: HTMLDivElement;
let portalRoot: HTMLDivElement;
let originalMatchMedia: typeof window.matchMedia;
const updateSessionMetadataMock = vi.fn().mockResolvedValue({
  displayName: 'Renamed from dialog',
});

function setTouchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query === TOUCH_SIDEBAR_MEDIA_QUERY ? matches : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

function renderSidebar(
  props: Partial<React.ComponentProps<typeof WebShellSidebar>> = {},
): void {
  act(() => {
    root?.render(
      <I18nProvider language="en">
        <WebShellPortalRootContext.Provider value={portalRoot}>
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
            onError={() => {}}
            {...props}
          />
        </WebShellPortalRootContext.Provider>
      </I18nProvider>,
    );
  });
}

function makePointerEvent(
  type: string,
  init: {
    pointerType?: string;
    pointerId?: number;
    isPrimary?: boolean;
    clientX?: number;
    clientY?: number;
  } = {},
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 20,
    clientY: init.clientY ?? 20,
  });
  Object.defineProperty(event, 'pointerType', {
    value: init.pointerType ?? 'touch',
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  Object.defineProperty(event, 'isPrimary', { value: init.isPrimary ?? true });
  return event;
}

const sessionAlpha: DaemonSessionSummary = makeSession('alpha', {
  displayName: 'Alpha touch session',
  workspaceCwd: '/tmp/project',
  branch: { name: 'feat/mobile-sheet' },
  updatedAt: '2026-11-28T10:00:00Z',
});

beforeEach(() => {
  window.localStorage.clear();
  originalMatchMedia = window.matchMedia;
  setTouchMedia(false);
  connection.capabilities = fullCapabilities;
  connection.sessionId = 'other-current';
  connection.workspaceCwd = '/tmp/project';
  workspace.capabilities = {
    ...fullCapabilities,
    workspaceCwd: '/tmp/project',
  };
  updateSessionMetadataMock.mockClear();
  workspace.client.workspaceByCwd.mockImplementation(() => ({
    listWorkspaceSessions: vi.fn().mockResolvedValue([]),
    listSessionGroups: workspaceActions.listSessionGroups,
    updateSessionMetadata: updateSessionMetadataMock,
    updateSessionOrganization: workspaceActions.updateSessionOrganization,
    gitStatus: vi.fn().mockResolvedValue({ branch: 'main' }),
  }));
  active.sessions = [sessionAlpha];
  active.data = active.sessions;
  pinned.sessions = [];
  pinned.data = [];
  archived.sessions = [];
  archived.data = [];
  loadSession.mockClear();
  workspaceActions.updateSessionOrganization.mockClear();
  workspaceActions.updateSessionOrganization.mockResolvedValue(undefined);
  workspaceActions.listSessionGroups.mockResolvedValue({
    groups: [{ id: 'g-mobile', name: 'Mobile', color: 'blue' }],
    colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
  });
  container = document.createElement('div');
  portalRoot = document.createElement('div');
  document.body.append(container, portalRoot);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  portalRoot?.remove();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
  vi.useRealTimers();
});

describe('WebShellSidebar touch actions (P0 + P1)', () => {
  it('collapses row actions to a single More button in touch mode and opens the bottom Action Sheet with details', async () => {
    setTouchMedia(true);
    renderSidebar();
    await flushSidebar();

    const row = Array.from(
      container.querySelectorAll<HTMLElement>('[class*="sessionRow"]'),
    ).find((el) => el.textContent?.includes('Alpha touch session'))!;
    expect(row).toBeDefined();

    // Only a single More actions trigger is rendered on touch (no inline Pin).
    const actionButtons = row.querySelectorAll(
      '[class*="sessionActions"] button',
    );
    expect(actionButtons).toHaveLength(1);
    expect(actionButtons[0]!.getAttribute('aria-label')).toBe('More actions');

    // Tapping More actions opens the Action Sheet without switching sessions.
    act(() => {
      click(actionButtons[0]!);
    });
    expect(loadSession).not.toHaveBeenCalled();

    const sheet = portalRoot.querySelector(
      '[data-web-shell-session-action-sheet]',
    );
    expect(sheet).not.toBeNull();
    expect(sheet?.textContent).toContain('Alpha touch session');
    expect(sheet?.textContent).toContain('/tmp/project');
    expect(sheet?.textContent).toContain('feat/mobile-sheet');
    expect(sheet?.textContent).toContain('alpha');
    expect(
      sheet?.querySelector('[data-web-shell-session-id-copy]'),
    ).not.toBeNull();
    expect(sheet?.textContent).toContain('Pin');
    expect(sheet?.textContent).toContain('Rename');
    expect(sheet?.textContent).toContain('Group');
    expect(sheet?.textContent).toContain('Archive');
    expect(sheet?.textContent).toContain('Delete');
  });

  it('routes touch rename through SessionRenameDialog and ignores double-click inline rename', async () => {
    vi.useFakeTimers();
    setTouchMedia(true);
    renderSidebar();
    await act(async () => {
      await Promise.resolve();
    });

    const row = Array.from(
      container.querySelectorAll<HTMLElement>('[class*="sessionRow"]'),
    ).find((el) => el.textContent?.includes('Alpha touch session'))!;

    // Double click does not enter inline rename on touch.
    act(() => {
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(row.querySelector('input')).toBeNull();

    const moreButton = row.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions"]',
    )!;
    act(() => {
      click(moreButton);
    });

    const sheet = portalRoot.querySelector(
      '[data-web-shell-session-action-sheet]',
    )!;
    const renameButton = Array.from(sheet.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Rename',
    )!;
    act(() => {
      click(renameButton);
    });
    act(() => {
      vi.runAllTimers();
    });

    // SessionRenameDialog opens instead of inline editor.
    const dialog = portalRoot.querySelector('[data-web-shell-dialog]');
    expect(dialog).not.toBeNull();
    const input = dialog!.querySelector('input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('Alpha touch session');

    const form = dialog!.querySelector('form')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'Renamed from dialog');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(updateSessionMetadataMock).toHaveBeenCalledWith('alpha', {
      displayName: 'Renamed from dialog',
    });
  });

  it('navigates to the in-sheet group picker and assigns a group on touch', async () => {
    setTouchMedia(true);
    renderSidebar();
    await flushSidebar();

    const moreButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions"]',
    )!;
    act(() => {
      click(moreButton);
    });

    const sheet = portalRoot.querySelector(
      '[data-web-shell-session-action-sheet]',
    )!;
    const groupButton = Array.from(sheet.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Group'),
    )!;
    await act(async () => {
      click(groupButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    const mobileGroup = Array.from(
      sheet.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ).find((b) => b.textContent?.includes('Mobile'))!;
    expect(mobileGroup).toBeDefined();

    await act(async () => {
      click(mobileGroup);
      await Promise.resolve();
    });
    expect(workspaceActions.updateSessionOrganization).toHaveBeenCalledWith(
      'alpha',
      { groupId: 'g-mobile', color: null },
    );
  });

  it('opens the Action Sheet on touch long-press without switching sessions', async () => {
    vi.useFakeTimers();
    setTouchMedia(true);
    renderSidebar();
    await act(async () => {
      await Promise.resolve();
    });

    const row = Array.from(
      container.querySelectorAll<HTMLElement>('[class*="sessionRow"]'),
    ).find((el) => el.textContent?.includes('Alpha touch session'))!;
    const title = row.querySelector('[data-web-shell-session-title]')!;

    act(() => {
      title.dispatchEvent(makePointerEvent('pointerdown'));
    });
    expect(row.dataset.pressing).toBe('true');

    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY_MS);
    });
    expect(row.dataset.pressing).toBeUndefined();
    expect(
      portalRoot.querySelector('[data-web-shell-session-action-sheet]'),
    ).not.toBeNull();

    // Releasing the finger fires a trailing click which must be swallowed.
    act(() => {
      title.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(loadSession).not.toHaveBeenCalled();
  });

  it('keeps workspace header actions unhidden and converged to WorkspaceMenu on mobileOpen', async () => {
    const onNewSession = vi.fn(() => true);
    renderSidebar({
      mobileOpen: true,
      onNewSession,
      workspaces: [
        {
          id: 'ws-primary',
          cwd: '/repo',
          primary: true,
          trusted: true,
          removable: false,
        },
        {
          id: 'ws-other',
          cwd: '/repo/other',
          primary: false,
          trusted: true,
          removable: true,
        },
      ],
    });
    await flushSidebar();

    const actionContainers = container.querySelectorAll<HTMLElement>(
      '[data-workspace-actions]',
    );
    expect(actionContainers.length).toBeGreaterThan(0);
    for (const box of actionContainers) {
      // No inline visibility: hidden lock on touch/mobile drawer.
      expect(box.style.visibility).not.toBe('hidden');
      const buttons = box.querySelectorAll('button');
      expect(buttons).toHaveLength(1);
      expect(buttons[0]!.getAttribute('aria-label')).toBe('Workspace actions');
    }
  });

  it('keeps desktop inline Pin + DropdownMenu unchanged when not touch and not mobileOpen', async () => {
    setTouchMedia(false);
    renderSidebar({
      mobileOpen: false,
      sessionActions: { inlineItems: ['pin'] },
    });
    await flushSidebar();

    const row = Array.from(
      container.querySelectorAll<HTMLElement>('[class*="sessionRow"]'),
    ).find((el) => el.textContent?.includes('Alpha touch session'))!;
    const actionButtons = row.querySelectorAll(
      '[class*="sessionActions"] button',
    );
    expect(actionButtons).toHaveLength(2);
    expect(actionButtons[0]!.getAttribute('aria-label')).toBe('Pin');
    expect(actionButtons[1]!.getAttribute('aria-label')).toBe('More actions');
  });

  it('supports touch long-press and finger taps on More in fine-pointer hybrid iPad layouts without opening a duplicate dropdown', async () => {
    vi.useFakeTimers();
    setTouchMedia(false);
    renderSidebar({
      mobileOpen: false,
      sessionActions: { inlineItems: ['pin'] },
    });
    await act(async () => {
      await Promise.resolve();
    });

    const row = Array.from(
      container.querySelectorAll<HTMLElement>('[class*="sessionRow"]'),
    ).find((el) => el.textContent?.includes('Alpha touch session'))!;
    const moreButton = row.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions"]',
    )!;

    // Finger tap on the desktop More trigger opens Action Sheet, not DropdownMenu.
    act(() => {
      moreButton.dispatchEvent(
        makePointerEvent('pointerdown', { pointerType: 'touch' }),
      );
    });
    expect(
      portalRoot.querySelector('[data-web-shell-session-action-sheet]'),
    ).not.toBeNull();
    expect(
      portalRoot.querySelector('[data-slot="dropdown-menu-content"]'),
    ).toBeNull();

    // Dismiss sheet, then verify finger long-press on the row also opens it.
    const sheet = portalRoot.querySelector<HTMLElement>(
      '[data-web-shell-session-action-sheet]',
    )!;
    act(() => {
      sheet.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(
      portalRoot.querySelector('[data-web-shell-session-action-sheet]'),
    ).toBeNull();

    const title = row.querySelector('[data-web-shell-session-title]')!;
    act(() => {
      title.dispatchEvent(
        makePointerEvent('pointerdown', { pointerType: 'touch' }),
      );
      vi.advanceTimersByTime(500);
    });
    expect(
      portalRoot.querySelector('[data-web-shell-session-action-sheet]'),
    ).not.toBeNull();
    expect(loadSession).not.toHaveBeenCalled();
  });
});
