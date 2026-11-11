// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  clickSidebarElement as click,
  createSidebarMocks,
  DAEMON_APPROVAL_MODES,
  flushSidebar,
  installSidebarDomShims,
  makeSidebarSession as makeSession,
  useResolvedWebShellSessions,
  sidebarSessionPage,
  useSidebarSessionCatalogQuery,
} from '../../test/sidebarHarness';

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

const metadataCapabilities = {
  qwenCodeVersion: '1.2.3',
  features: ['workspace_session_metadata', 'workspace_qualified_rest_core'],
};

let root: Root;
let container: HTMLDivElement;

function renderSidebar(
  props: {
    sessionActions?: React.ComponentProps<
      typeof WebShellSidebar
    >['sessionActions'];
  } = {},
): void {
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
          onLoadSession={loadSession}
          onError={() => {}}
          sessionActions={props.sessionActions}
        />
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  connection.sessionId = null;
  connection.workspaceCwd = '/tmp/project';
  connection.capabilities = metadataCapabilities;
  workspace.capabilities = metadataCapabilities;
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
  mocks.actions.bindSessionPr.mockClear();
  mocks.actions.bindSessionPr.mockResolvedValue({ prs: [] });
  workspace.client.updateSessionMetadata.mockClear();
  workspace.client.workspaceByCwd.mockClear();
  refreshWorkspace.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
});

async function openSessionMenu(): Promise<HTMLElement> {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="More actions"]',
  );
  expect(trigger).not.toBeNull();
  act(() => {
    trigger!.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
    );
  });
  await flushSidebar();
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  expect(menu).not.toBeNull();
  return menu!;
}

function menuItem(menu: HTMLElement, label: string): HTMLElement | undefined {
  return Array.from(
    menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((item) => item.textContent?.trim() === label);
}

function bindPrInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(
    'input[aria-label="Bind PR"]',
  )!;
}

async function typeAndSubmit(value: string): Promise<void> {
  const input = bindPrInput();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.form!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
  await flushSidebar();
}

const PR_URL = 'https://github.com/QwenLM/qwen-code/pull/16865';

describe('WebShellSidebar bind PR', () => {
  it('shows Bind PR in the session menu and binds the current session through session actions', async () => {
    connection.sessionId = 's1';
    active.sessions = [makeSession('s1')];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    const menu = await openSessionMenu();
    const item = menuItem(menu, 'Bind PR');
    expect(item).not.toBeUndefined();
    act(() => click(item!));
    await flushSidebar();

    expect(bindPrInput()).not.toBeNull();
    await typeAndSubmit(PR_URL);
    expect(mocks.actions.bindSessionPr).toHaveBeenCalledWith({
      number: 16865,
      url: PR_URL,
    });
    expect(refreshWorkspace).toHaveBeenCalledWith('/tmp/project');
    expect(document.querySelector('input[aria-label="Bind PR"]')).toBeNull();
  });

  it('binds another session through the workspace metadata route, not the global or current-session route', async () => {
    connection.sessionId = 'current';
    active.sessions = [makeSession('s1')];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    const menu = await openSessionMenu();
    act(() => click(menuItem(menu, 'Bind PR')!));
    await flushSidebar();
    await typeAndSubmit(PR_URL);

    // The bind must go through the session's workspace-scoped client: not
    // the current-session action and not the global (unscoped) route.
    expect(workspace.client.workspaceByCwd).toHaveBeenCalledWith(
      '/tmp/project',
    );
    const scoped = workspace.client.workspaceByCwd.mock.results.at(-1)!.value;
    expect(scoped.updateSessionMetadata).toHaveBeenCalledWith('s1', {
      pr: { number: 16865, url: PR_URL },
    });
    expect(mocks.actions.bindSessionPr).not.toHaveBeenCalled();
    expect(workspace.client.updateSessionMetadata).not.toHaveBeenCalled();
    expect(refreshWorkspace).toHaveBeenCalledWith('/tmp/project');
  });

  it('shows Bind PR when the host enables it without rename', async () => {
    connection.sessionId = 's1';
    active.sessions = [makeSession('s1')];
    active.data = active.sessions;
    renderSidebar({ sessionActions: { items: ['bindPr', 'delete', 'pin'] } });
    await flushSidebar();

    const menu = await openSessionMenu();
    expect(menuItem(menu, 'Bind PR')).not.toBeUndefined();
    expect(menuItem(menu, 'Rename')).toBeUndefined();
  });

  it('keeps the dialog open with an error when the bind fails', async () => {
    connection.sessionId = 's1';
    active.sessions = [makeSession('s1')];
    active.data = active.sessions;
    mocks.actions.bindSessionPr.mockRejectedValueOnce(new Error('locked'));
    renderSidebar();
    await flushSidebar();

    const menu = await openSessionMenu();
    act(() => click(menuItem(menu, 'Bind PR')!));
    await flushSidebar();
    await typeAndSubmit(PR_URL);

    expect(
      document.querySelector('input[aria-label="Bind PR"]'),
    ).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Bind PR failed',
    );
    // The submitting flag must reset so the dialog can still be dismissed.
    const cancel = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === 'cancel');
    expect(cancel).not.toBeUndefined();
    act(() => click(cancel!));
    await flushSidebar();
    expect(document.querySelector('input[aria-label="Bind PR"]')).toBeNull();
  });

  it('hides Bind PR when the host items exclude it', async () => {
    connection.sessionId = 's1';
    active.sessions = [makeSession('s1')];
    active.data = active.sessions;
    renderSidebar({ sessionActions: { items: ['rename', 'delete', 'pin'] } });
    await flushSidebar();

    const menu = await openSessionMenu();
    expect(menuItem(menu, 'Rename')).not.toBeUndefined();
    expect(menuItem(menu, 'Bind PR')).toBeUndefined();
  });

  it('hides Bind PR when the session cannot be renamed', async () => {
    connection.sessionId = 'current';
    connection.capabilities = { qwenCodeVersion: '1.2.3', features: [] };
    workspace.capabilities = { qwenCodeVersion: '1.2.3', features: [] };
    active.sessions = [makeSession('s1')];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    // Open the menu so the assertion reads rendered items, not the empty
    // DOM Radix leaves behind while the menu is closed.
    const menu = await openSessionMenu();
    expect(menuItem(menu, 'Delete')).not.toBeUndefined();
    expect(menuItem(menu, 'Bind PR')).toBeUndefined();
  });
});
