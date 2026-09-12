// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';

const {
  connection,
  workspace,
  workspaceActions,
  active,
  useSessionCatalogPollingSpy,
} = vi.hoisted(() => {
  const active = {
    sessions: [] as DaemonSessionSummary[],
    loading: false,
    error: null as Error | null,
    reload: vi.fn().mockResolvedValue(undefined),
  };
  return {
    connection: {
      status: 'connected' as const,
      sessionId: null as string | null,
      workspaceCwd: '/tmp/project',
      capabilities: undefined as
        | { qwenCodeVersion: string; features: string[] }
        | undefined,
    },
    workspace: {
      capabilities: undefined as
        | { qwenCodeVersion: string; features: string[] }
        | undefined,
      client: {
        workspaceByCwd: vi.fn(() => ({
          listWorkspaceSessions: vi.fn().mockResolvedValue([]),
          workspaceGit: vi
            .fn()
            .mockResolvedValue({ v: 2, workspaceCwd: '', branch: null }),
          listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
        })),
      },
      refreshCapabilities: vi.fn(),
    },
    workspaceActions: {
      addWorkspace: vi.fn(),
      removeWorkspace: vi.fn(),
      listSessionGroups: vi.fn().mockResolvedValue({ groups: [] }),
    },
    active,
    useSessionCatalogPollingSpy: vi.fn(),
  };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => connection,
  useActions: () => ({ renameSession: vi.fn() }),
  useWorkspace: () => workspace,
  useWorkspaceActions: () => workspaceActions,
  useSessions: () => active,
  useChannels: () => ({
    data: undefined,
    catalog: [],
    channels: {},
    reload: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../session-catalog/session-catalog-hooks', () => ({
  useWebShellSessions: () => ({
    ...active,
    data: active.sessions,
    catalogQuery: {
      routeKind: 'legacy',
      workspaceCwd: connection.workspaceCwd,
      options: {},
    },
  }),
  useSessionCatalogController: () => ({
    refreshQueries: vi.fn(),
    invalidateWorkspace: vi.fn(),
    refreshWorkspace: vi.fn(),
    renamed: vi.fn(),
    toggleSessionPinned: vi.fn(),
  }),
  useSessionCatalogPolling: useSessionCatalogPollingSpy,
  useSessionCatalogQuery: () => ({
    sessions: [],
    loading: false,
    reload: vi.fn().mockResolvedValue(undefined),
  }),
  useSessionCatalogQueries: () => [],
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
  features: ['multi_workspace_sessions', 'workspace_session_metadata'],
};

function makeSession(
  sessionId: string,
  over: Partial<DaemonSessionSummary> = {},
): DaemonSessionSummary {
  return {
    sessionId,
    workspaceCwd: '/tmp/project',
    displayName: `Session ${sessionId}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    clientCount: 0,
    hasActivePrompt: false,
    isArchived: false,
    isPinned: false,
    groupId: null,
    color: null,
    ...over,
  } as DaemonSessionSummary;
}

/**
 * jsdom ships no matchMedia, so useIsLargeScreen normally degrades to false
 * (pre-gate behavior). These tests install the smallest stub needed to drive
 * the mobile-drawer breakpoint explicitly.
 */
function installMatchMedia(mobile: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        matches: mobile && query === '(max-width: 760px)',
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

let root: Root;
let container: HTMLDivElement;

function renderSidebar(mobileOpen?: boolean): void {
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
          onLoadSession={() => {}}
          onError={() => {}}
          {...(mobileOpen === undefined ? {} : { mobileOpen })}
        />
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  connection.capabilities = capabilities;
  workspace.capabilities = capabilities;
  // A running session is what earns the 2s active cadence in the first
  // place; every case below starts from it.
  active.sessions = [makeSession('running', { hasActivePrompt: true })];
  active.loading = false;
  active.error = null;
  useSessionCatalogPollingSpy.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WebShellSidebar mobile drawer polling gate (#6181)', () => {
  it('keeps the active cadence while the mobile drawer is open', () => {
    installMatchMedia(true);

    renderSidebar(true);

    expect(useSessionCatalogPollingSpy).toHaveBeenCalledWith(
      workspace.client,
      expect.anything(),
      2_000,
    );
  });

  it('degrades to the idle cadence when the mobile drawer is closed', () => {
    installMatchMedia(true);

    renderSidebar(false);

    // The closed drawer hides the whole sidebar, so the running session's
    // 2s cadence must fall back to the 30s idle cadence...
    expect(useSessionCatalogPollingSpy).toHaveBeenCalledWith(
      workspace.client,
      expect.anything(),
      30_000,
    );
    // ...never the active one.
    expect(useSessionCatalogPollingSpy).not.toHaveBeenCalledWith(
      workspace.client,
      expect.anything(),
      2_000,
    );
  });

  it('never gates desktop-width viewports', () => {
    installMatchMedia(false);

    // mobileOpen defaults to false on desktop too — the gate must key on
    // the viewport, not the prop alone.
    renderSidebar();

    expect(useSessionCatalogPollingSpy).toHaveBeenCalledWith(
      workspace.client,
      expect.anything(),
      2_000,
    );
    expect(useSessionCatalogPollingSpy).not.toHaveBeenCalledWith(
      workspace.client,
      expect.anything(),
      30_000,
    );
  });

  it('keeps the pre-gate cadence when matchMedia is unavailable', () => {
    // The vitest setup installs a matchMedia stub for jsdom; remove it to
    // model environments with no matchMedia at all (SSR-style degradation).
    // The hook must report "not mobile" and keep polling exactly as before.
    vi.stubGlobal('matchMedia', undefined);
    expect(typeof window.matchMedia).toBe('undefined');

    renderSidebar();

    expect(useSessionCatalogPollingSpy).toHaveBeenCalledWith(
      workspace.client,
      expect.anything(),
      2_000,
    );
    expect(useSessionCatalogPollingSpy).not.toHaveBeenCalledWith(
      workspace.client,
      expect.anything(),
      30_000,
    );
  });
});
