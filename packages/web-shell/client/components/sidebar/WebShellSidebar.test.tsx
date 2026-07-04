// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { mockConnection, mockSessions, mockExportSession } = vi.hoisted(() => ({
  mockConnection: {
    status: 'connected',
    sessionId: null as string | null,
    workspaceCwd: '/tmp/project',
    capabilities: { qwenCodeVersion: '1.2.3', features: [] as string[] } as
      | { qwenCodeVersion?: string; features?: string[] }
      | undefined,
  },
  mockSessions: [] as Array<{
    sessionId: string;
    workspaceCwd: string;
    displayName?: string;
    createdAt?: string;
  }>,
  mockExportSession: vi.fn(),
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => mockConnection,
  useActions: () => ({ renameSession: vi.fn() }),
  useSessions: () => ({
    sessions: mockSessions,
    loading: false,
    error: null,
    reload: vi.fn(),
    deleteSession: vi.fn(),
    exportSession: mockExportSession,
  }),
}));

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
    onError: (error: unknown, message: string) => void;
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
  mockConnection.sessionId = null;
  mockConnection.capabilities = { qwenCodeVersion: '1.2.3', features: [] };
  mockSessions.splice(0);
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

describe('WebShellSidebar — session export', () => {
  it('hides export action when daemon does not advertise session_export', () => {
    mockSessions.push({
      sessionId: 'session-1',
      workspaceCwd: '/tmp/project',
      displayName: 'Session 1',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    const container = renderSidebar(false);

    expect(
      container.querySelector('[aria-label="Export conversation record"]'),
    ).toBeNull();
  });

  it('downloads an HTML export when export action is clicked', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_export'],
    };
    mockSessions.push({
      sessionId: 'session-1',
      workspaceCwd: '/tmp/project',
      displayName: 'Session 1',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
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
    const container = renderSidebar(false);
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

  it('reports export failures through onError', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_export'],
    };
    mockSessions.push({
      sessionId: 'session-1',
      workspaceCwd: '/tmp/project',
      displayName: 'Session 1',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    const error = new Error('download failed');
    mockExportSession.mockRejectedValueOnce(error);
    const onError = vi.fn();
    const container = renderSidebar(false, { onError });
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
