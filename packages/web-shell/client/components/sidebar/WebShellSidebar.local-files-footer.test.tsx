// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type Root } from 'react';
import { createRoot } from 'react-dom/client';
import { StandaloneContext } from '../../config/standalone';
import {
  connectDesktopRelay,
  disconnectDesktopRelay,
  probeDesktopRelay,
} from '../../desktop-relay/desktop-relay-client';
import type { WebShellSidebarFooterItem } from './WebShellSidebar';
import {
  DAEMON_APPROVAL_MODES,
  createSidebarMocks,
  installSidebarDomShims,
  sidebarSessionPage,
  staticSidebarSessionCatalogQuery,
} from '../../test/sidebarHarness';

const mocks = createSidebarMocks({
  workspaceBaseUrl: '',
  connection: { capabilities: undefined },
});
const { connection, workspace } = mocks;

// Counts every mount of the browser-local bridge hook. The sidebar gate is the
// only thing between a remote daemon and a client directory, so pin the hook
// itself and not just the absent trigger: a refactor that hoisted the hook out
// of LocalFilesControl would keep the trigger assertions green while the bridge
// registered for a remote daemon.
const bridgeHookCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../desktop-relay/desktop-relay-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeDesktopRelay: vi.fn(),
  connectDesktopRelay: vi.fn(),
  disconnectDesktopRelay: vi.fn(),
}));

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
  useWebShellSessions: (options?: { archiveState?: string; group?: string }) =>
    sidebarSessionPage(mocks, options),
  useSessionCatalogController: () => ({
    refreshQueries: mocks.refreshSessionCatalogQueries,
    invalidateWorkspace: vi.fn(),
    refreshWorkspace: vi.fn(),
    renamed: vi.fn(),
  }),
  useSessionCatalogPolling: () => undefined,
  useSessionCatalogQuery: () => staticSidebarSessionCatalogQuery(),
  useSessionCatalogQueries: mocks.useSessionCatalogQueries,
}));

const { I18nProvider } = await import('../../i18n');
const { WebShellSidebar } = await import('./WebShellSidebar');

installSidebarDomShims();

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
  vi.mocked(probeDesktopRelay)
    .mockReset()
    .mockResolvedValue({ kind: 'missing' });
  vi.mocked(disconnectDesktopRelay).mockReset().mockResolvedValue(true);
  vi.mocked(connectDesktopRelay).mockReset();
  connection.sessionId = null;
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
  vi.unstubAllGlobals();
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
  it('cancels pending approval on a session switch and ignores its late result', async () => {
    vi.stubGlobal('isSecureContext', true);
    workspace.capabilities = { features: ['client_mcp_over_ws'] };
    connection.sessionId = 'requesting-session';
    vi.mocked(probeDesktopRelay).mockResolvedValue({
      kind: 'ready',
      version: '0.1.7',
    });
    let finish!: (value: { ok: false; code: string }) => void;
    vi.mocked(connectDesktopRelay).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderSidebar();
    await act(async () => desktopRelayTrigger()?.click());
    const connect = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Connect this computer',
    );
    expect(connect).toBeDefined();
    await act(async () => connect?.click());
    const signal = vi.mocked(connectDesktopRelay).mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(false);
    connection.sessionId = 'new-session';
    renderSidebar();
    expect(signal?.aborted).toBe(true);
    await act(async () => finish({ ok: false, code: 'denied' }));
    expect(document.body.textContent).not.toContain('The request was declined');
  });

  it('keeps a live relay revocable after switching to an unsupported daemon', async () => {
    workspace.capabilities = { features: ['client_mcp_over_ws'] };
    vi.mocked(probeDesktopRelay).mockResolvedValue({
      kind: 'ready',
      version: '0.1.6',
      active: {
        sessionId: 'approved-session',
        daemonUrl: workspace.baseUrl,
        phase: 'connected',
      },
    });
    renderSidebar();
    await act(async () => desktopRelayTrigger()?.click());
    workspace.capabilities = { features: [] };
    renderSidebar();
    expect(desktopRelayTrigger()).not.toBeNull();
    const disconnect = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Disconnect',
    );
    expect(disconnect).toBeDefined();
    vi.mocked(probeDesktopRelay).mockResolvedValue({
      kind: 'ready',
      version: '0.1.6',
    });
    await act(async () => disconnect?.click());
    expect(disconnectDesktopRelay).toHaveBeenCalledOnce();
    expect(desktopRelayTrigger()).toBeNull();
  });

  it('is hidden until the daemon advertises the reverse tool channel', () => {
    renderSidebar();
    expect(desktopRelayTrigger()).toBeNull();
    expect(probeDesktopRelay).not.toHaveBeenCalled();

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

  it('is withheld when the selected daemon is not the page origin', () => {
    workspace.baseUrl = 'https://remote.example';
    workspace.capabilities = { features: ['client_mcp_over_ws'] };
    renderSidebar();
    expect(desktopRelayTrigger()).toBeNull();
    expect(probeDesktopRelay).not.toHaveBeenCalled();
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
