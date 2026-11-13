// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedAgentProvider } from './managed/managed-agent-provider';

afterEach(() => {
  cleanup();
  bridge.status = { phase: 'idle', blocker: null };
  bridge.connect.mockClear();
});

const bridge = vi.hoisted(() => ({
  status: { phase: 'idle', blocker: null } as {
    phase: string;
    blocker: null;
    rootName?: string;
    toolCount?: number;
  },
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
}));

vi.mock('../local-files/useManagedLocalFilesBridge', () => ({
  useManagedLocalFilesBridge: () => bridge,
}));
vi.mock('../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { ManagedLocalFilesControl } from './ManagedLocalFilesControl';

function provider(withClientFiles: boolean): ManagedAgentProvider {
  return {
    storageKey: 'test',
    clientFiles: withClientFiles
      ? {
          transport: () => ({
            baseUrl: 'http://test/api/agent/web-shell/v1',
            fetch: async () => new Response('{}', { status: 200 }),
          }),
        }
      : undefined,
  } as unknown as ManagedAgentProvider;
}

describe('ManagedLocalFilesControl', () => {
  it('withholds the entry when the provider exposes no client files', () => {
    const { container } = render(
      <ManagedLocalFilesControl
        provider={provider(false)}
        sessionId="session-1"
        triggerClassName="trigger"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the trigger when client files are available', () => {
    bridge.status = { phase: 'connected', blocker: null };
    render(
      <ManagedLocalFilesControl
        provider={provider(true)}
        sessionId="session-1"
        triggerClassName="trigger"
      />,
    );
    expect(screen.getByLabelText('localFiles.trigger')).toBeTruthy();
  });

  it('names the bound session and offers change directory when connected', () => {
    bridge.status = {
      phase: 'connected',
      blocker: null,
      rootName: 'my-dir',
      toolCount: 1,
    };
    bridge.connect.mockClear();
    render(
      <ManagedLocalFilesControl
        provider={provider(true)}
        sessionId="session-1"
        triggerClassName="trigger"
        sessionName="My task"
      />,
    );
    fireEvent.click(screen.getByLabelText('localFiles.trigger'));
    expect(screen.getByText('My task')).toBeTruthy();
    fireEvent.click(screen.getByText('localFiles.changeDirectory'));
    expect(bridge.connect).toHaveBeenCalledWith({ forcePicker: true });
  });

  it('omits the session row when no name is passed', () => {
    bridge.status = {
      phase: 'connected',
      blocker: null,
      rootName: 'my-dir',
      toolCount: 1,
    };
    render(
      <ManagedLocalFilesControl
        provider={provider(true)}
        sessionId="session-1"
        triggerClassName="trigger"
      />,
    );
    fireEvent.click(screen.getByLabelText('localFiles.trigger'));
    expect(screen.queryByText('localFiles.session')).toBeNull();
  });
});
