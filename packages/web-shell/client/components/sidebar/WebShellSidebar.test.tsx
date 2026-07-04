// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type MockSession = {
  sessionId: string;
  workspaceCwd: string;
  displayName?: string;
  createdAt?: string;
  updatedAt?: string;
  clientCount?: number;
  hasActivePrompt?: boolean;
  isArchived?: boolean;
};

const { mockConnection, mockActive, mockArchived, renameSessionSpy } =
  vi.hoisted(() => {
    const makeStore = () => ({
      sessions: [] as MockSession[],
      loading: false,
      error: null as unknown,
      reload: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(true),
      archiveSession: vi.fn().mockResolvedValue(true),
      unarchiveSession: vi.fn().mockResolvedValue(true),
    });
    return {
      mockConnection: {
        status: 'connected',
        sessionId: null as string | null,
        workspaceCwd: '/tmp/project',
        capabilities: { qwenCodeVersion: '1.2.3' } as
          | { qwenCodeVersion?: string }
          | undefined,
      },
      mockActive: makeStore(),
      mockArchived: makeStore(),
      renameSessionSpy: vi.fn(),
    };
  });

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => mockConnection,
  useActions: () => ({ renameSession: renameSessionSpy }),
  useSessions: (options?: { archiveState?: 'active' | 'archived' }) =>
    options?.archiveState === 'archived' ? mockArchived : mockActive,
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

function renderSidebar(
  collapsed: boolean,
  overrides: Partial<{
    onOpenSettings: () => void;
    onOpenDaemonStatus: () => void;
  }> = {},
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WebShellSidebar
          collapsed={collapsed}
          onCollapsedChange={noop}
          onOpenSettings={noop}
          onOpenDaemonStatus={noop}
          onNewSession={() => false}
          onLoadSession={noop}
          onError={noop}
          {...overrides}
        />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

beforeEach(() => {
  mockConnection.capabilities = { qwenCodeVersion: '1.2.3' };
  mockConnection.sessionId = null;
  for (const store of [mockActive, mockArchived]) {
    store.sessions = [];
    store.loading = false;
    store.error = null;
    store.reload.mockClear();
    store.deleteSession.mockClear();
    store.archiveSession.mockClear();
    store.unarchiveSession.mockClear();
  }
  renameSessionSpy.mockClear();
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('WebShellSidebar — version footer', () => {
  it('shows the qwen-code version in the footer when expanded', () => {
    const container = renderSidebar(false);
    const badge = container.querySelector('[title="Qwen Code v1.2.3"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('v1.2.3');
  });

  it('renders a non-semver fallback (e.g. "unknown") without a bogus "v" prefix', () => {
    mockConnection.capabilities = { qwenCodeVersion: 'unknown' };
    const container = renderSidebar(false);
    const badge = container.querySelector('[title="Qwen Code unknown"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('unknown');
    expect(container.textContent ?? '').not.toContain('vunknown');
  });

  it('hides the version when the sidebar is collapsed', () => {
    const container = renderSidebar(true);
    expect(container.querySelector('[title="Qwen Code v1.2.3"]')).toBeNull();
    expect(container.textContent ?? '').not.toContain('v1.2.3');
  });

  it('renders no version badge when the daemon reports none', () => {
    mockConnection.capabilities = undefined;
    const container = renderSidebar(false);
    expect(container.textContent ?? '').not.toMatch(/v\d/);
  });
});

describe('WebShellSidebar — daemon status entry', () => {
  it('invokes onOpenDaemonStatus when the footer button is clicked', () => {
    const onOpenDaemonStatus = vi.fn();
    const container = renderSidebar(false, { onOpenDaemonStatus });
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
    const container = renderSidebar(true, { onOpenDaemonStatus });
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

function click(el: Element | null): void {
  expect(el).not.toBeNull();
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

// Clicks that kick off an async action (archive/unarchive) settle a trailing
// `setBusySessionId` in a `.finally()`; flush those microtasks inside act().
async function clickAsync(el: Element | null): Promise<void> {
  expect(el).not.toBeNull();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('WebShellSidebar — archive actions', () => {
  it('archives an active session from the quick action button', async () => {
    mockActive.sessions = [makeSession('aaaaaaaa')];
    const container = renderSidebar(false);
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
    const container = renderSidebar(false);
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
    const container = renderSidebar(false);
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
    const container = renderSidebar(false);
    click(container.querySelector('[aria-label="More actions"]'));
    const archiveItem = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((el) => el.textContent === 'Archive');
    await clickAsync(archiveItem ?? null);
    expect(mockActive.archiveSession).toHaveBeenCalledWith('aaaaaaaa');
  });

  it('reveals archived sessions on demand and restores them', async () => {
    mockArchived.sessions = [makeSession('bbbbbbbb', { isArchived: true })];
    const container = renderSidebar(false);
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
