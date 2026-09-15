// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type Root } from 'react';
import { createRoot } from 'react-dom/client';
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
        capabilities: undefined,
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

let root: Root;
let container: HTMLDivElement;

function renderSidebar(footer?: {
  items: readonly WebShellSidebarFooterItem[];
}) {
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
          onLoadSession={vi.fn()}
          onError={() => {}}
          footer={footer}
        />
      </I18nProvider>,
    );
  });
}

function localFilesTrigger(): HTMLElement | null {
  return container.querySelector(`button[aria-label="${LOCAL_FILES_LABEL}"]`);
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
