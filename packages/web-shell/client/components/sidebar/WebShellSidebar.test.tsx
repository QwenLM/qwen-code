// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { mockConnection } = vi.hoisted(() => ({
  mockConnection: {
    status: 'connected',
    sessionId: null as string | null,
    workspaceCwd: '/tmp/project',
    capabilities: { qwenCodeVersion: '1.2.3' } as
      | { qwenCodeVersion?: string }
      | undefined,
  },
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => mockConnection,
  useActions: () => ({ renameSession: vi.fn() }),
  useSessions: () => ({
    sessions: [],
    loading: false,
    error: null,
    reload: vi.fn(),
    deleteSession: vi.fn(),
  }),
}));

const { I18nProvider } = await import('../../i18n');
const { WebShellSidebar } = await import('./WebShellSidebar');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

const noop = () => {};

function renderSidebar(collapsed: boolean): HTMLElement {
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
        />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

beforeEach(() => {
  mockConnection.capabilities = { qwenCodeVersion: '1.2.3' };
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
