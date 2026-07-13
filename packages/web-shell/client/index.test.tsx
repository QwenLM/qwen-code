// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Drive a render throw from inside DaemonWorkspaceProvider so we can prove the
// top-level boundary sits *outside* the daemon providers (a boundary nested
// under them couldn't catch their own throw).
let workspaceShouldThrow = false;
const sessionProviderProps: Array<Record<string, unknown>> = [];
vi.mock('@qwen-code/webui/daemon-react-sdk', async () => {
  const React = await import('react');
  return {
    DaemonWorkspaceProvider: ({ children }: { children: React.ReactNode }) => {
      if (workspaceShouldThrow) throw new Error('provider boom');
      return React.createElement(React.Fragment, null, children);
    },
    DaemonSessionProvider: ({
      children,
      ...props
    }: {
      children: React.ReactNode;
    }) => {
      sessionProviderProps.push(props);
      return React.createElement(React.Fragment, null, children);
    },
    useWorkspace: () => ({
      capabilities: {
        workspaces: [{ id: 'primary', cwd: '/workspace', primary: true }],
      },
    }),
  };
});
vi.mock('./App', async () => {
  const React = await import('react');
  return {
    App: () => React.createElement('div', { 'data-testid': 'app-ok' }, 'app'),
  };
});

// A variable specifier loads the TSX library entry without requiring
// allowImportingTsExtensions in this test configuration.
const indexEntry = './index.tsx';
const { WebShellWithProviders } = await import(indexEntry);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function render(node: React.ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  workspaceShouldThrow = false;
  sessionProviderProps.length = 0;
  vi.restoreAllMocks();
});

describe('WebShellWithProviders top-level boundary', () => {
  it('renders normally when the providers are healthy', () => {
    const container = render(<WebShellWithProviders />);
    expect(container.querySelector('[data-testid="app-ok"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('starts on an empty session by default', () => {
    render(<WebShellWithProviders />);
    expect(sessionProviderProps[0]).toMatchObject({
      sessionId: undefined,
    });
    expect(sessionProviderProps[0]).not.toHaveProperty('deferSessionCreation');
  });

  it('passes controlled sessionId to the daemon session provider', () => {
    render(<WebShellWithProviders sessionId="session-2" />);
    expect(sessionProviderProps[0]).toMatchObject({
      sessionId: 'session-2',
    });
  });

  it('passes explicit undefined sessionId to the daemon session provider', () => {
    render(<WebShellWithProviders sessionId={undefined} />);
    expect(sessionProviderProps[0]).toHaveProperty('sessionId', undefined);
  });

  it('catches a daemon-provider render crash instead of white-screening', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    workspaceShouldThrow = true;
    const container = render(<WebShellWithProviders />);
    // The boundary is outside the providers, so the provider throw degrades to
    // the recoverable fallback rather than unmounting the whole root.
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Something went wrong',
    );
    expect(container.querySelector('[data-testid="app-ok"]')).toBeNull();
  });
});
