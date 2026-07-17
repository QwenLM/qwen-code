// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const sessionProviderProps: Array<Record<string, unknown>> = [];

vi.mock('@qwen-code/webui/daemon-react-sdk', async () => {
  const React = await import('react');
  return {
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
        workspaceCwd: '/workspace',
        workspaces: [{ id: 'primary', cwd: '/workspace', primary: true }],
      },
    }),
    useWorkspaceActions: () => ({ addWorkspace: vi.fn() }),
  };
});

vi.mock('../App', async () => {
  const React = await import('react');
  return {
    App: () => React.createElement('div'),
  };
});

const { WorkspaceSessionProvider } = await import('./WorkspaceSessionProvider');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  sessionProviderProps.length = 0;
});

describe('WorkspaceSessionProvider', () => {
  it('forwards the extension pairing credential when creating a session', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <WorkspaceSessionProvider
          extensionPairingCredential="paired-credential"
          webShellProps={{}}
        />,
      );
    });

    expect(sessionProviderProps[0]).toMatchObject({
      createSessionRequest: {
        extensionPairingCredential: 'paired-credential',
      },
    });
  });
});
