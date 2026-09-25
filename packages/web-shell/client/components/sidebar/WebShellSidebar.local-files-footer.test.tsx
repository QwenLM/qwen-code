// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type Root } from 'react';
import { createRoot } from 'react-dom/client';
import { StandaloneContext } from '../../config/standalone';
import type { WebShellSidebarFooterItem } from './WebShellSidebar';

const { connection, workspace, workspaceActions, active, pinned, archived } =
  vi.hoisted(() => {
    const makeSessions = () => {
      const state = {
        sessions: [] as never[],
        loading: false,
        error: null as Error | null,
        data: [] as never[] | undefined,
        reload: vi.fn().mockResolvedValue(undefined),
        deleteSession: vi.fn().mockResolvedValue(true),
        archiveSession: vi.fn().mockResolvedValue(true),
        unarchiveSession: vi.fn().mockResolvedValue(true),
        exportSession: vi.fn(),
      };
      state.data = state.sessions;
      return state;
    };
    return {
      connection: {
        status: 'connected',
        sessionId: null as string | null,
        workspaceCwd: '/tmp/project',
        capabilities: undefined,
      },
      workspace: {
        baseUrl: '',
        capabilities: undefined as { features?: string[] } | undefined,
        client: {
          workspaceByCwd: vi.fn(() => ({
            listWorkspaceSessions: vi.fn().mockResolvedValue([]),
            listSessionGroups: vi.fn().mockResolvedValue({
              groups: [],
              colorOptions: [],
            }),
          })),
        },
        refreshCapabilities: vi.fn(),
      },
      workspaceActions: {
        addWorkspace: vi.fn(),
        removeWorkspace: vi.fn(),
        listSessionGroups: vi.fn().mockResolvedValue({
          groups: [],
          colorOptions: [],
        }),
        createSessionGroup: vi.fn(),
        updateSessionGroup: vi.fn(),
        deleteSessionGroup: vi.fn(),
        updateSessionOrganization: vi.fn(),
      },
      active: makeSessions(),
      pinned: makeSessions(),
      archived: makeSessions(),
    };
  });

// Counts every mount of the browser-local bridge hook. The sidebar gate is the
// only thing between a remote daemon and a client directory, so pin the hook
// itself and not just the absent trigger: a refactor that hoisted the hook out
// of LocalFilesControl would keep the trigger assertions green while the bridge
// registered for a remote daemon.
const bridgeHookCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../local-files/useLocalFilesBridge', () => ({
  useLocalFilesBridge: () => {
    bridgeHookCalls.count += 1;
    return {
      status: { phase: 'idle', blocker: null },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => connection,
  useActions: () => ({ renameSession: vi.fn() }),
  useWorkspace: () => workspace,
  useWorkspaceActions: () => workspaceActions,
  useChannels: () => ({ data: undefined, catalog: [], channels: {} }),
  useSessions: (options?: { archiveState?: string; group?: string }) => {
    if (options?.archiveState === 'archived') return archived;
    if (options?.group === 'pinned') return pinned;
    return active;
  },
}));

vi.mock('../../session-catalog/session-catalog-hooks', () => ({
  useWebShellSessions: (options?: {
    archiveState?: string;
    group?: string;
  }) => {
    if (options?.archiveState === 'archived') return archived;
    if (options?.group === 'pinned') return pinned;
    return active;
  },
  useSessionCatalogController: () => ({
    refreshQueries: vi.fn(),
    invalidateWorkspace: vi.fn(),
    refreshWorkspace: vi.fn(),
    renamed: vi.fn(),
  }),
  useSessionCatalogPolling: () => undefined,
  useSessionCatalogQuery: () => ({
    sessions: [],
    loading: false,
    error: undefined,
    reload: vi.fn(),
  }),
  useSessionCatalogQueries: vi.fn(() => []),
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

const LOCAL_FILES_LABEL = 'Local files';
const DESKTOP_RELAY_LABEL = 'Use this computer';

let root: Root;
let container: HTMLDivElement;

function renderSidebar(
  footer?: {
    items: readonly WebShellSidebarFooterItem[];
  },
  standalone = false,
) {
  act(() => {
    root.render(
      <StandaloneContext.Provider value={standalone}>
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
            onLoadSession={vi.fn()}
            onError={() => {}}
            footer={footer}
          />
        </I18nProvider>
      </StandaloneContext.Provider>,
    );
  });
}

function localFilesTrigger(): HTMLElement | null {
  return container.querySelector(`button[aria-label="${LOCAL_FILES_LABEL}"]`);
}

function desktopRelayTrigger(): HTMLElement | null {
  return container.querySelector(`button[aria-label="${DESKTOP_RELAY_LABEL}"]`);
}

function setDesktopShell(enabled: boolean) {
  const win = window as unknown as { __TAURI__?: unknown };
  if (enabled) {
    win.__TAURI__ = { core: { invoke: vi.fn().mockResolvedValue(undefined) } };
  } else {
    delete win.__TAURI__;
  }
}

beforeEach(() => {
  window.localStorage.clear();
  workspace.baseUrl = window.location.origin;
  workspace.capabilities = undefined;
  bridgeHookCalls.count = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  setDesktopShell(false);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  setDesktopShell(false);
});

describe('local files footer entry', () => {
  it('is offered by default in a plain browser', () => {
    renderSidebar();
    expect(localFilesTrigger()).not.toBeNull();
  });

  it('is hidden by default inside the desktop shell', () => {
    setDesktopShell(true);
    renderSidebar();
    expect(localFilesTrigger()).toBeNull();
  });

  it('stays reachable in the desktop shell when explicitly configured', () => {
    setDesktopShell(true);
    renderSidebar({ items: ['localFiles'] });
    expect(localFilesTrigger()).not.toBeNull();
  });
});

describe('desktop relay footer entry', () => {
  it('is hidden until the daemon advertises the reverse tool channel', () => {
    renderSidebar();
    expect(desktopRelayTrigger()).toBeNull();

    workspace.capabilities = { features: ['client_mcp_over_ws'] };
    renderSidebar();
    expect(desktopRelayTrigger()).not.toBeNull();
  });

  it('stays available when a host explicitly configures it', () => {
    renderSidebar({ items: ['desktopRelay'] });
    expect(desktopRelayTrigger()).not.toBeNull();
  });

  it('is hidden by default inside the desktop shell', () => {
    setDesktopShell(true);
    workspace.capabilities = { features: ['client_mcp_over_ws'] };
    renderSidebar();
    expect(desktopRelayTrigger()).toBeNull();
  });
});

it('withholds browser-local files on a remote daemon for standalone and embedded hosts alike', () => {
  workspace.baseUrl = 'https://remote.example';
  renderSidebar(undefined, true);
  expect(localFilesTrigger()).toBeNull();
  // The gate keys on the connected daemon's origin, never on how the page is
  // hosted, so an embedded shell pointed at a remote daemon withholds the
  // bridge too — a client directory must not be handed to a remote daemon.
  renderSidebar();
  expect(localFilesTrigger()).toBeNull();
  // Not merely hidden: the bridge hook never ran, so nothing registered,
  // opened a WebSocket, or restored a directory handle for that origin.
  // `https://` matters here — a remote secure context is exactly the case
  // where the File System Access API would otherwise be available.
  expect(bridgeHookCalls.count).toBe(0);
  workspace.baseUrl = window.location.origin;
  renderSidebar(undefined, true);
  expect(localFilesTrigger()).not.toBeNull();
  expect(bridgeHookCalls.count).toBeGreaterThan(0);
});
