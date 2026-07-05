// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const {
  mockConnection,
  mockActive,
  mockArchived,
  renameSessionSpy,
  mockExportSession,
} = vi.hoisted(() => {
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
      capabilities: { qwenCodeVersion: '1.2.3', features: [] as string[] } as
        | { qwenCodeVersion?: string; features?: string[] }
        | undefined,
    },
    mockActive: makeStore(),
    mockArchived: makeStore(),
    renameSessionSpy: vi.fn(),
    mockExportSession: vi.fn(),
  };
});

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

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => mockConnection,
  useActions: () => ({ renameSession: renameSessionSpy }),
  useSessions: (options?: { archiveState?: 'active' | 'archived' }) =>
    options?.archiveState === 'archived'
      ? mockArchived
      : { ...mockActive, exportSession: mockExportSession },
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
    onLoadSession: (sessionId: string) => Promise<void> | void;
    onError: (error: unknown, message: string) => void;
    sessionListReloadToken: number;
  }> = {},
): { container: HTMLElement; rerender: (props: typeof overrides) => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const doRender = (props: typeof overrides) => {
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
            {...props}
          />
        </I18nProvider>,
      );
    });
  };
  doRender(overrides);
  mounted.push({ root, container });
  return { container, rerender: doRender };
}

beforeEach(() => {
  mockConnection.sessionId = null;
  mockConnection.capabilities = { qwenCodeVersion: '1.2.3', features: [] };
  for (const store of [mockActive, mockArchived]) {
    store.sessions = [];
    store.loading = false;
    store.error = null;
    store.reload.mockReset();
    store.deleteSession.mockReset();
    store.archiveSession.mockReset();
    store.unarchiveSession.mockReset();
    store.deleteSession.mockResolvedValue(true);
    store.archiveSession.mockResolvedValue(true);
    store.unarchiveSession.mockResolvedValue(true);
  }
  renameSessionSpy.mockClear();
  mockExportSession.mockReset();
  mockExportSession.mockResolvedValue({
    content: '<html>export</html>',
    filename: 'session.html',
    mimeType: 'text/html',
    format: 'html',
  });
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WebShellSidebar — version footer', () => {
  it('shows the qwen-code version in the footer when expanded', () => {
    const { container } = renderSidebar(false);
    const badge = container.querySelector('[title="Qwen Code v1.2.3"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('v1.2.3');
  });

  it('renders a non-semver fallback (e.g. "unknown") without a bogus "v" prefix', () => {
    mockConnection.capabilities = { qwenCodeVersion: 'unknown' };
    const { container } = renderSidebar(false);
    const badge = container.querySelector('[title="Qwen Code unknown"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('unknown');
    expect(container.textContent ?? '').not.toContain('vunknown');
  });

  it('hides the version when the sidebar is collapsed', () => {
    const { container } = renderSidebar(true);
    expect(container.querySelector('[title="Qwen Code v1.2.3"]')).toBeNull();
    expect(container.textContent ?? '').not.toContain('v1.2.3');
  });

  it('renders no version badge when the daemon reports none', () => {
    mockConnection.capabilities = undefined;
    const { container } = renderSidebar(false);
    expect(container.textContent ?? '').not.toMatch(/v\d/);
  });
});

describe('WebShellSidebar — daemon status entry', () => {
  it('invokes onOpenDaemonStatus when the footer button is clicked', () => {
    const onOpenDaemonStatus = vi.fn();
    const { container } = renderSidebar(false, { onOpenDaemonStatus });
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
    const { container } = renderSidebar(true, { onOpenDaemonStatus });
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

describe('WebShellSidebar — session export', () => {
  it('hides export action when daemon does not advertise session_export', () => {
    mockActive.sessions = [makeSession('session-1')];
    const { container } = renderSidebar(false);

    expect(
      container.querySelector('[aria-label="Export conversation record"]'),
    ).toBeNull();
  });

  it('downloads an HTML export when export action is clicked', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_export'],
    };
    mockActive.sessions = [makeSession('session-1')];
    const createObjectURL = vi.fn(() => 'blob:session-export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    const { container } = renderSidebar(false);
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Export conversation record"]',
    );

    expect(button).not.toBeNull();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockExportSession).toHaveBeenCalledWith('session-1', 'html');
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:session-export');
  });

  it('does not block switching sessions while an export is running', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_export'],
    };
    mockActive.sessions = [makeSession('session-1'), makeSession('session-2')];
    let resolveExport:
      | ((value: Awaited<ReturnType<typeof mockExportSession>>) => void)
      | undefined;
    mockExportSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveExport = resolve;
      }),
    );
    const createObjectURL = vi.fn(() => 'blob:session-export');
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const onLoadSession = vi.fn();
    const { container } = renderSidebar(false, { onLoadSession });
    const exportButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Export conversation record"]',
    );

    await act(async () => {
      exportButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const secondSessionRow = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((el) => el.textContent?.includes('Session session-2'));
    click(secondSessionRow ?? null);

    expect(onLoadSession).toHaveBeenCalledWith('session-2');

    await act(async () => {
      resolveExport?.({
        content: '<html>export</html>',
        filename: 'session.html',
        mimeType: 'text/html',
        format: 'html',
      });
      await Promise.resolve();
    });
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  });

  it('reports export failures through onError', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_export'],
    };
    mockActive.sessions = [makeSession('session-1')];
    const error = new Error('download failed');
    mockExportSession.mockRejectedValueOnce(error);
    const onError = vi.fn();
    const { container } = renderSidebar(false, { onError });
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Export conversation record"]',
    );

    expect(button).not.toBeNull();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(onError).toHaveBeenCalledWith(error, 'Failed to export session');
  });
});

describe('WebShellSidebar — archive actions', () => {
  it('archives an active session from the quick action button', async () => {
    mockActive.sessions = [makeSession('aaaaaaaa')];
    const { container } = renderSidebar(false);
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
    const { container } = renderSidebar(false);
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
    const { container } = renderSidebar(false);
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
    const { container } = renderSidebar(false);
    click(container.querySelector('[aria-label="More actions"]'));
    const archiveItem = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((el) => el.textContent === 'Archive');
    await clickAsync(archiveItem ?? null);
    expect(mockActive.archiveSession).toHaveBeenCalledWith('aaaaaaaa');
  });

  it('reveals archived sessions on demand and restores them', async () => {
    mockArchived.sessions = [makeSession('bbbbbbbb', { isArchived: true })];
    const { container } = renderSidebar(false);
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

describe('WebShellSidebar — sessionListReloadToken effect', () => {
  it('calls reload when token changes', async () => {
    mockActive.reload.mockResolvedValue(undefined);
    const { rerender } = renderSidebar(false, {
      sessionListReloadToken: 0,
    });
    expect(mockActive.reload).not.toHaveBeenCalled();

    rerender({ sessionListReloadToken: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockActive.reload).toHaveBeenCalledTimes(1);
  });

  it('does not call reload when token is undefined', async () => {
    mockActive.reload.mockResolvedValue(undefined);
    const { rerender } = renderSidebar(false);

    rerender({});
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockActive.reload).not.toHaveBeenCalled();
  });

  it('does not call reload when token is unchanged', async () => {
    mockActive.reload.mockResolvedValue(undefined);
    const { rerender } = renderSidebar(false, {
      sessionListReloadToken: 1,
    });
    mockActive.reload.mockClear();

    rerender({ sessionListReloadToken: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockActive.reload).not.toHaveBeenCalled();
  });

  it('skips reload when document is hidden', async () => {
    mockActive.reload.mockResolvedValue(undefined);
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    const { rerender } = renderSidebar(false, {
      sessionListReloadToken: 0,
    });

    rerender({ sessionListReloadToken: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockActive.reload).not.toHaveBeenCalled();

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
  });

  it('skips reload when a poll is already in flight', async () => {
    let resolveFirstPoll: (() => void) | undefined;
    mockActive.reload.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveFirstPoll = resolve;
      }),
    );
    const { rerender } = renderSidebar(false, {
      sessionListReloadToken: 0,
    });

    rerender({ sessionListReloadToken: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockActive.reload).toHaveBeenCalledTimes(1);

    mockActive.reload.mockResolvedValue(undefined);
    rerender({ sessionListReloadToken: 2 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockActive.reload).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstPoll?.();
      await Promise.resolve();
    });

    rerender({ sessionListReloadToken: 3 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockActive.reload).toHaveBeenCalledTimes(2);
  });
});
