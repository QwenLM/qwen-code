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

const { I18nProvider } = await import('../../i18n');
const { WebShellSidebar } = await import('./WebShellSidebar');

installSidebarDomShims();

let root: Root;
let container: HTMLDivElement;
const onNewSession = vi.fn(() => false);

function renderSidebar(
  props: { overloadPaused?: boolean; overloadDetail?: string } = {},
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
      onError={() => {}}
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
});
