// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebShellProps } from './App';

interface CapturedWorkspaceSessionProps {
  sessionId?: string;
  workspaceId?: string;
  webShellProps: WebShellProps;
}

const testState = vi.hoisted(() => ({
  props: undefined as CapturedWorkspaceSessionProps | undefined,
}));

const hostWindow = window as unknown as {
  qwenCodeHost?: {
    loadSettings: (language: string) => Promise<
      Array<{
        id: string;
        label: string;
        items: Array<{
          key: string;
          label: string;
          kind: 'boolean';
          value: boolean;
        }>;
      }>
    >;
    setSetting: (key: string, value: boolean | number) => Promise<void>;
  };
};

vi.mock('react-dom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom/client')>()),
  default: { createRoot: () => ({ render: vi.fn() }) },
}));
vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  DaemonWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/WorkspaceSessionProvider', () => ({
  WorkspaceSessionProvider: (props: CapturedWorkspaceSessionProps) => {
    testState.props = props;
    return null;
  },
}));
vi.mock('./config/daemon', () => ({
  getDaemonBaseUrl: () => '',
  getDaemonToken: () => 'token',
  removeDaemonTokenFromUrl: vi.fn(),
  waitForDaemonTokenMessage: vi.fn(),
}));

import { StandaloneApp } from './main';

describe('StandaloneApp', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    testState.props = undefined;
    delete hostWindow.qwenCodeHost;
    window.history.replaceState(null, '', '/');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete hostWindow.qwenCodeHost;
  });

  it('keeps the controlled session target in sync with URL changes', () => {
    act(() => root.render(<StandaloneApp daemonToken="token" />));

    act(() => {
      testState.props?.webShellProps.onSessionIdChange?.(
        'session-created',
        'workspace-1',
      );
    });

    expect(testState.props).toMatchObject({
      sessionId: 'session-created',
      workspaceId: 'workspace-1',
    });
    expect(window.location.pathname).toBe('/session/session-created');
    expect(new URLSearchParams(window.location.search).get('workspace')).toBe(
      'workspace-1',
    );
  });

  it('adopts a desktop host bridge that becomes ready after render', async () => {
    act(() => root.render(<StandaloneApp daemonToken="token" />));
    expect(testState.props?.webShellProps.hostSettings).toBeUndefined();
    hostWindow.qwenCodeHost = {
      loadSettings: vi.fn(async () => [
        {
          id: 'desktop-pet',
          label: 'Desktop Pet',
          items: [
            {
              key: 'pet.enabled',
              label: 'Show desktop pet',
              kind: 'boolean',
              value: true,
            },
          ],
        },
      ]),
      setSetting: vi.fn(async () => {}),
    };

    await act(async () => {
      window.dispatchEvent(new Event('qwen-code-host-ready'));
      await Promise.resolve();
    });

    expect(testState.props?.webShellProps.hostSettings?.[0]?.id).toBe(
      'desktop-pet',
    );
  });
});
