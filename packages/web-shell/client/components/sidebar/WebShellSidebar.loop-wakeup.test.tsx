// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createSidebarMocks,
  DAEMON_APPROVAL_MODES,
  flushSidebar,
  installSidebarDomShims,
  makeSidebarSession,
  useResolvedWebShellSessions,
  sidebarSessionPage,
  useSidebarSessionCatalogQuery,
} from '../../test/sidebarHarness';
import type { DaemonLoopWakeup } from '@qwen-code/web-shell/daemon-react-sdk';
import { formatClockTime } from '../../utils/formatDateTime';

const mocks = createSidebarMocks({
  connection: { capabilities: undefined },
});
const {
  connection,
  workspace,
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
  useStreamingState: () => 'idle',
  useSessions: (options?: { archiveState?: string; group?: string }) =>
    sidebarSessionPage(mocks, options),
}));

const { refreshWorkspace } = vi.hoisted(() => ({
  refreshWorkspace: vi.fn(),
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
    refreshWorkspace,
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
const { WebShellSidebar } = await import('./WebShellSidebar');

installSidebarDomShims();

let root: Root;
let container: HTMLDivElement;

function renderSidebar(loopWakeups?: Map<string, DaemonLoopWakeup>): void {
  act(() => {
    root.render(
      <I18nProvider language="en">
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
          onNewSession={() => false}
          onLoadSession={loadSession}
          onError={() => {}}
          loopWakeups={loopWakeups}
        />
      </I18nProvider>,
    );
  });
}

function makeWakeup(fireAtMs: number): DaemonLoopWakeup {
  return {
    sessionId: 'aaaa1111-2222-4333-8444-555566667777',
    fireAtMs,
    createdAt: fireAtMs - 60_000,
    prompt: 'check the docker slot',
  };
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  connection.sessionId = null;
  connection.workspaceCwd = '/tmp/project';
  connection.capabilities = {
    qwenCodeVersion: '1.2.3',
    features: [],
  };
  workspace.capabilities = {
    qwenCodeVersion: '1.2.3',
    features: [],
  };
  active.sessions = [
    makeSidebarSession('aaaa1111-2222-4333-8444-555566667777'),
  ];
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
});

describe('sidebar loop-wakeup marker', () => {
  it('marks a session row with a pending wakeup and its next-tick tooltip', async () => {
    const fireAt = Date.now() + 60_000;
    renderSidebar(
      new Map([[makeWakeup(fireAt).sessionId, makeWakeup(fireAt)]]),
    );
    await flushSidebar();

    const marker = container.querySelector<HTMLElement>(
      '[data-web-shell-loop-wakeup]',
    );
    expect(marker).not.toBeNull();
    expect(marker?.getAttribute('title')).toBe(
      `Loop: next tick ${formatClockTime(fireAt)}`,
    );
    expect(marker?.querySelector('svg.lucide-timer')).not.toBeNull();
  });

  it('does not mark a session whose wakeup has already fired', async () => {
    const fireAt = Date.now() - 1_000;
    renderSidebar(
      new Map([[makeWakeup(fireAt).sessionId, makeWakeup(fireAt)]]),
    );
    await flushSidebar();

    expect(container.querySelector('[data-web-shell-loop-wakeup]')).toBeNull();
  });

  it('does not mark rows when no wakeups are provided', async () => {
    renderSidebar();
    await flushSidebar();

    expect(container.querySelector('[data-web-shell-loop-wakeup]')).toBeNull();
  });
});
