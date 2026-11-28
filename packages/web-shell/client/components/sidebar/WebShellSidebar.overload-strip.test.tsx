// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createSidebarMocks,
  DAEMON_APPROVAL_MODES,
  flushSidebar,
  installSidebarDomShims,
  sidebarSessionPage,
  useResolvedWebShellSessions,
  useSidebarSessionCatalogQuery,
} from '../../test/sidebarHarness';

const mocks = createSidebarMocks({
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
  useStreamingState: () => 'idle',
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

// Capture the creation callbacks the sidebar hands to its recents sections
// so the handler guard can be driven directly: a disabled DOM button would
// dispatch nothing and make the assertion vacuous.
const capturedEntries = vi.hoisted(() => ({
  recent: undefined as
    | { onNewSession?: () => void; newSessionDisabled?: boolean }
    | undefined,
  standalone: undefined as
    | { onNewSession?: () => void; newSessionDisabled?: boolean }
    | undefined,
}));

vi.mock('./RecentSessions', () => ({
  RecentSessions: (props: {
    onNewSession?: () => void;
    newSessionDisabled?: boolean;
  }) => {
    capturedEntries.recent = props;
    return null;
  },
}));

vi.mock('./StandaloneRecents', () => ({
  StandaloneRecents: (props: {
    onNewSession?: () => void;
    newSessionDisabled?: boolean;
  }) => {
    capturedEntries.standalone = props;
    return null;
  },
}));

const capturedChrome = vi.hoisted(() => ({
  menu: undefined as { actions?: Record<string, unknown> } | undefined,
  section: undefined as { gitBranchWanted?: boolean } | undefined,
}));

vi.mock('./WorkspaceMenu', () => ({
  WorkspaceMenu: (props: { actions?: Record<string, unknown> }) => {
    capturedChrome.menu = props;
    return null;
  },
}));

vi.mock('./WorkspaceSection', async () => {
  const React = await import('react');
  return {
    WorkspaceSection: (props: {
      gitBranchWanted?: boolean;
      headerActions?: (
        visible: boolean,
        extras: Record<string, unknown>,
      ) => unknown;
    }) => {
      capturedChrome.section = props;
      // The workspace menu is rendered through the section's header-actions
      // render prop; pass a real gitBranch so worktree creation is eligible
      // and removing `!overloadPaused` makes the paused assertion fail.
      return React.createElement(
        React.Fragment,
        null,
        props.headerActions?.(true, {
          overview: undefined,
          gitBranch: 'main',
        }) as never,
      );
    },
    isAbsolutePath: (value: string) => value.startsWith('/'),
  };
});

const { I18nProvider } = await import('../../i18n');
const { WebShellSidebar } = await import('./WebShellSidebar');

installSidebarDomShims();

let root: Root;
let container: HTMLDivElement;
const onNewSession = vi.fn(() => false);
const onError = vi.fn();

function renderSidebar(
  props: {
    collapsed?: boolean;
    layout?: 'rail';
    activePage?: string;
    overloadPaused?: boolean;
    overloadDetail?: string;
    onOverloadRefused?: () => void;
    onNewWorktreeSession?: (cwd?: string) => void;
    onLoadStandaloneSession?: (id: string) => void;
    onStandaloneNotice?: (message: string) => void;
  } = {},
  language: 'en' | 'zh-CN' = 'en',
) {
  const sidebar = (
    <WebShellSidebar
      collapsed={false}
      onCollapsedChange={() => {}}
      onOpenSettings={() => {}}
      onOpenDaemonStatus={() => {}}
      onOpenScheduledTasks={() => {}}
      onOpenWorkflows={() => {}}
      onOpenGoals={() => {}}
      onOpenSessions={() => {}}
      onOpenSplitView={() => {}}
      onNewSession={onNewSession}
      onLoadSession={loadSession}
      onError={onError}
      {...props}
    />
  );
  act(() => {
    root.render(<I18nProvider language={language}>{sidebar}</I18nProvider>);
  });
}

const strip = () =>
  container.querySelector<HTMLElement>('[data-web-shell-overload-strip]');
const newTaskButton = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container.appendChild(document.createElement('div')));
  connection.status = 'connected';
  connection.loadingTranscript = false;
  connection.error = undefined;
  connection.sessionId = null;
  connection.sessionContext = undefined;
  connection.workspaceCwd = '/tmp/project';
  connection.capabilities = undefined;
  workspace.capabilities = undefined;
  workspace.client.listWorkspaceSessionsPage
    .mockReset()
    .mockResolvedValue({ sessions: [] });
  workspace.client.listStandaloneSessionsPage
    .mockReset()
    .mockResolvedValue({ sessions: [] });
  workspaceActions.listSessionGroups.mockReset();
  workspaceActions.listSessionGroups.mockResolvedValue({
    groups: [],
    colorOptions: [],
  });
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
  onNewSession.mockClear();
  onError.mockClear();
  capturedEntries.recent = undefined;
  capturedEntries.standalone = undefined;
  capturedChrome.section = undefined;
  capturedChrome.menu = undefined;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('WebShellSidebar overload strip', () => {
  it('shows the strip and disables New task while paused', async () => {
    renderSidebar({
      overloadPaused: true,
      overloadDetail: 'Host load ratio 2.50, event-loop p99 20 ms (cpu_load).',
    });
    await flushSidebar();
    const element = strip();
    expect(element).not.toBeNull();
    expect(element!.textContent).toBe('System overloaded — new tasks paused');
    expect(element!.getAttribute('title')).toBe(
      'Host load ratio 2.50, event-loop p99 20 ms (cpu_load).',
    );
    expect(element!.getAttribute('aria-label')).toBe(
      'System overloaded — new tasks paused: Host load ratio 2.50, event-loop p99 20 ms (cpu_load).',
    );
    const button = newTaskButton('New session');
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(true);
    act(() => {
      button!.click();
    });
    expect(onNewSession).not.toHaveBeenCalled();
  });

  it('localizes the strip in zh-CN', async () => {
    renderSidebar({ overloadPaused: true }, 'zh-CN');
    await flushSidebar();
    expect(strip()!.textContent).toBe('系统过载 · 暂停新建');
    expect(newTaskButton('新建会话')!.disabled).toBe(true);
  });

  it('labels the strip without detail when none is provided', async () => {
    renderSidebar({ overloadPaused: true });
    await flushSidebar();
    expect(strip()!.getAttribute('aria-label')).toBe(
      'System overloaded — new tasks paused',
    );
    expect(strip()!.getAttribute('title')).toBeNull();
  });

  it('renders no strip and keeps New task enabled when not paused', async () => {
    renderSidebar();
    await flushSidebar();
    expect(strip()).toBeNull();
    const button = newTaskButton('New session');
    expect(button!.disabled).toBe(false);
    act(() => {
      button!.click();
    });
    await flushSidebar();
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it('guards the recents creation callbacks and explains the pause', async () => {
    // Enable the recents sections so their creation callbacks are handed to
    // the (mocked) components and can be captured.
    connection.capabilities = {
      features: ['workspace_qualified_rest_core'],
    } as typeof connection.capabilities;
    workspace.capabilities = {
      features: ['standalone_sessions_v1'],
    } as typeof workspace.capabilities;
    renderSidebar({ overloadPaused: true });
    await flushSidebar();
    // Drive the callbacks directly: the DOM buttons are disabled, so a click
    // would dispatch nothing and prove nothing about the handler guard.
    const entry = capturedEntries.recent ?? capturedEntries.standalone;
    expect(entry).toBeDefined();
    expect(entry!.newSessionDisabled).toBe(true);
    act(() => {
      entry!.onNewSession!();
    });
    expect(onNewSession).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'System overloaded — new tasks paused',
      }),
      'System overloaded — new tasks paused',
    );
  });

  it('uses the overload warning callback without invoking a creation action', async () => {
    connection.capabilities = {
      features: ['workspace_qualified_rest_core'],
    } as typeof connection.capabilities;
    workspace.capabilities = {
      features: ['standalone_sessions_v1'],
    } as typeof workspace.capabilities;
    const onOverloadRefused = vi.fn();
    renderSidebar({ overloadPaused: true, onOverloadRefused });
    await flushSidebar();
    const entry = capturedEntries.recent ?? capturedEntries.standalone;
    expect(entry).toBeDefined();
    expect(entry!.newSessionDisabled).toBe(true);

    act(() => {
      entry!.onNewSession!();
    });

    expect(onNewSession).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onOverloadRefused).toHaveBeenCalledOnce();
  });

  it('omits workspace-menu creation actions and the git poll while paused', async () => {
    connection.capabilities = {
      features: ['workspace_qualified_rest_core'],
      workspaces: [
        {
          id: 'ws-1',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'ws-2',
          cwd: '/tmp/second',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof connection.capabilities;
    renderSidebar({ overloadPaused: true, onNewWorktreeSession: () => {} });
    await flushSidebar();
    expect(capturedChrome.section).toBeDefined();
    expect(capturedChrome.menu!.actions?.['newSession']).toBeUndefined();
    expect(
      capturedChrome.menu!.actions?.['newWorktreeSession'],
    ).toBeUndefined();
    // Every New-session button (nav button + per-workspace header button)
    // must be disabled, not only the first DOM match.
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="New session"]',
      ),
    );
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const btn of buttons) {
      expect(btn.disabled).toBe(true);
    }
    // The blocking git poll's only consumer is hidden while paused.
    expect(capturedChrome.section!.gitBranchWanted).toBe(false);
  });

  it('keeps menu creation actions and the git poll when not paused', async () => {
    connection.capabilities = {
      features: ['workspace_qualified_rest_core'],
      workspaces: [
        {
          id: 'ws-1',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'ws-2',
          cwd: '/tmp/second',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof connection.capabilities;
    renderSidebar({ onNewWorktreeSession: () => {} });
    await flushSidebar();
    expect(capturedChrome.menu!.actions?.['newSession']).toBeTypeOf('function');
    expect(capturedChrome.menu!.actions?.['newWorktreeSession']).toBeTypeOf(
      'function',
    );
    expect(capturedChrome.section!.gitBranchWanted).toBe(true);
  });

  it('passes newSessionDisabled to StandaloneRecents when the sidebar mounts it', async () => {
    workspace.capabilities = {
      features: ['standalone_sessions_v1'],
    } as typeof workspace.capabilities;
    renderSidebar({
      overloadPaused: true,
      onLoadStandaloneSession: () => {},
      onStandaloneNotice: () => {},
    });
    await flushSidebar();
    // Assert directly on the standalone capture (no `recent ?? standalone`
    // union), so dropping `newSessionDisabled={newSessionDisabled}` on the
    // sidebar's `<StandaloneRecents>` turns this case red.
    expect(capturedEntries.standalone).toBeDefined();
    expect(capturedEntries.standalone!.newSessionDisabled).toBe(true);
  });

  it('honors newSessionDisabled on the standalone header button', async () => {
    const { StandaloneRecents: RealStandaloneRecents } = await vi.importActual<
      typeof import('./StandaloneRecents')
    >('./StandaloneRecents');
    workspace.capabilities = {
      features: ['standalone_sessions_v1'],
    } as typeof workspace.capabilities;
    // The clean-empty state renders no header at all; a load error mounts
    // the error-state header with the New session button.
    workspace.client.listStandaloneSessionsPage.mockRejectedValue(
      new Error('status unavailable'),
    );
    const standaloneNew = vi.fn();
    act(() => {
      root.render(
        <I18nProvider language="en">
          <RealStandaloneRecents
            archiveState="active"
            currentSessionId={undefined}
            refreshKey={0}
            onNewSession={standaloneNew}
            newSessionDisabled
            onLoadSession={() => {}}
            onRenameSession={() => {}}
            onMutated={() => {}}
            onStatusChange={() => {}}
            onError={() => {}}
            onNotice={() => {}}
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="New session"]',
    );
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(true);
    act(() => {
      button!.click();
    });
    expect(standaloneNew).not.toHaveBeenCalled();
  });

  it('shows the warning in the collapsed rail outside the hidden home column', async () => {
    renderSidebar({
      collapsed: true,
      layout: 'rail',
      overloadPaused: true,
      overloadDetail: 'Host load ratio 2.50, event-loop p99 20 ms (cpu_load).',
    });
    await flushSidebar();

    const element = strip();
    expect(element).not.toBeNull();
    expect(element!.closest('[data-web-shell-navigation-rail]')).not.toBeNull();
    expect(element!.closest('[hidden]')).toBeNull();
    expect(element!.getAttribute('title')).toContain('Host load ratio 2.50');
  });

  it('shows the compact rail warning on a non-home page when expanded', async () => {
    renderSidebar({
      collapsed: false,
      layout: 'rail',
      activePage: 'scheduled-tasks',
      overloadPaused: true,
    });
    await flushSidebar();

    const element = strip();
    expect(element).not.toBeNull();
    expect(element!.closest('[data-web-shell-navigation-rail]')).not.toBeNull();
    expect(element!.closest('[hidden]')).toBeNull();
    expect(element!.textContent).toBe('');
  });

  it('keeps exactly one warning when the home preview opens', async () => {
    renderSidebar({
      collapsed: true,
      layout: 'rail',
      overloadPaused: true,
    });
    await flushSidebar();
    const home = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-home-trigger]',
    );
    expect(home).not.toBeNull();
    const pointer = new MouseEvent('pointerover', {
      bubbles: true,
      composed: true,
    });
    Object.defineProperty(pointer, 'pointerType', { value: 'mouse' });
    act(() => {
      home!.dispatchEvent(pointer);
    });
    await flushSidebar();

    expect(
      document.querySelectorAll('[data-web-shell-overload-strip]'),
    ).toHaveLength(1);
    expect(
      document.querySelector(
        '[data-web-shell-home-popover] [data-web-shell-overload-strip]',
      ),
    ).not.toBeNull();
  });

  it('keeps the rail warning when selection mode carries into a non-home page', async () => {
    renderSidebar({
      collapsed: false,
      layout: 'rail',
      overloadPaused: true,
    });
    await flushSidebar();
    const select = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Select sessions"]',
    );
    expect(select).not.toBeNull();
    act(() => {
      select!.click();
    });
    expect(select!.getAttribute('aria-pressed')).toBe('true');
    expect(strip()).toBeNull();

    renderSidebar({
      collapsed: false,
      layout: 'rail',
      activePage: 'scheduled-tasks',
      overloadPaused: true,
    });
    await flushSidebar();

    const element = strip();
    expect(element).not.toBeNull();
    expect(element!.closest('[data-web-shell-navigation-rail]')).not.toBeNull();
    expect(element!.closest('[hidden]')).toBeNull();
  });

  it('keeps the rail warning when a channels section is collapsed', async () => {
    connection.capabilities = {
      features: ['session_source_metadata'],
    } as typeof connection.capabilities;
    renderSidebar({
      collapsed: true,
      layout: 'rail',
      activePage: 'channels',
      overloadPaused: true,
    });
    await flushSidebar();

    expect(
      container.querySelector('[data-web-shell-sidebar-section="channels"]'),
    ).not.toBeNull();
    const element = strip();
    expect(element).not.toBeNull();
    expect(element!.closest('[data-web-shell-navigation-rail]')).not.toBeNull();
    expect(element!.closest('[hidden]')).toBeNull();
  });

  it('keeps the rail warning in expanded channels, but not when healthy', async () => {
    connection.capabilities = {
      features: ['session_source_metadata'],
    } as typeof connection.capabilities;
    renderSidebar({
      collapsed: false,
      layout: 'rail',
      activePage: 'channels',
      overloadPaused: true,
    });
    await flushSidebar();

    expect(
      container.querySelector('[data-web-shell-sidebar-section="channels"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-web-shell-navigation-rail]'),
    ).not.toBeNull();
    const element = strip();
    expect(element).not.toBeNull();
    expect(element!.closest('[data-web-shell-navigation-rail]')).not.toBeNull();
    expect(element!.closest('[hidden]')).toBeNull();

    renderSidebar({
      collapsed: false,
      layout: 'rail',
      activePage: 'channels',
      overloadPaused: false,
    });
    await flushSidebar();
    expect(strip()).toBeNull();
  });
});
