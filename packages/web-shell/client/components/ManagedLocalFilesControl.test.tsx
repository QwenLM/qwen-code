// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedAgentProvider } from './managed/managed-agent-provider';

afterEach(() => {
  cleanup();
  bridge.status = { phase: 'idle', blocker: null };
  bridge.connect.mockClear();
  toastSpy.mockClear();
});

const bridge = vi.hoisted(() => ({
  status: { phase: 'idle', blocker: null } as {
    phase: string;
    blocker: null;
    rootName?: string;
    toolCount?: number;
  },
  connect: vi.fn(
    async (): Promise<{ kind: 'repick-failed' } | undefined> => undefined,
  ),
  disconnect: vi.fn(async () => {}),
}));
const toastSpy = vi.hoisted(() => vi.fn());

vi.mock('../local-files/useManagedLocalFilesBridge', () => ({
  useManagedLocalFilesBridge: () => bridge,
}));
vi.mock('../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('./ToastHost', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestToast: toastSpy,
}));

import { ManagedLocalFilesControl } from './ManagedLocalFilesControl';
import { WebShellPortalRootContext } from '../portalRoot';

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

  it('toasts when a forced re-pick fails, and stays silent otherwise', async () => {
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
    bridge.connect.mockResolvedValueOnce({ kind: 'repick-failed' });
    await act(async () => {
      fireEvent.click(screen.getByText('localFiles.changeDirectory'));
    });
    expect(toastSpy).toHaveBeenCalledWith(
      'error',
      'localFiles.changeDirectoryFailed',
      null,
    );
    toastSpy.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByText('localFiles.changeDirectory'));
    });
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('exposes the state as an accessible description, name unchanged (R3-4)', () => {
    bridge.status = {
      phase: 'failed',
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
    const trigger = screen.getByLabelText('localFiles.trigger');
    // The accessible name stays the stable trigger label…
    expect(trigger.getAttribute('aria-label')).toBe('localFiles.trigger');
    // …while the state is reachable as a description for assistive tech.
    const describedBy = trigger.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy!);
    expect(description?.textContent).toBe(
      'localFiles.trigger — localFiles.status.failed (my-dir)',
    );
    // The native title is the only affordance a mouse user sees on the dot.
    expect(trigger.getAttribute('title')).toBe(
      'localFiles.trigger — localFiles.status.failed (my-dir)',
    );
    expect(trigger.querySelector('.bg-destructive')).not.toBeNull();
  });

  it('scopes its toasts to the portal root it is mounted under (F3)', async () => {
    const shellRoot = document.createElement('div');
    shellRoot.setAttribute('data-web-shell-root', '');
    document.body.appendChild(shellRoot);
    try {
      bridge.status = {
        phase: 'connected',
        blocker: null,
        rootName: 'my-dir',
        toolCount: 1,
      };
      render(
        <WebShellPortalRootContext.Provider value={shellRoot}>
          <ManagedLocalFilesControl
            provider={provider(true)}
            sessionId="session-1"
            triggerClassName="trigger"
          />
        </WebShellPortalRootContext.Provider>,
      );
      fireEvent.click(screen.getByLabelText('localFiles.trigger'));
      bridge.connect.mockResolvedValueOnce({ kind: 'repick-failed' });
      await act(async () => {
        fireEvent.click(screen.getByText('localFiles.changeDirectory'));
      });
      expect(toastSpy).toHaveBeenCalledWith(
        'error',
        'localFiles.changeDirectoryFailed',
        shellRoot,
      );
    } finally {
      shellRoot.remove();
    }
  });

  it('renders the muted dot while registering (a phase the hook emits)', () => {
    // The Managed hook never emits needs-gesture/reconnecting (no gesture
    // restore path), so the warning dot is pinned on the daemon side and in
    // the shared getLocalFilesDotClass table; here we pin a reachable phase.
    bridge.status = {
      phase: 'connecting',
      blocker: null,
    };
    render(
      <ManagedLocalFilesControl
        provider={provider(true)}
        sessionId="session-1"
        triggerClassName="trigger"
      />,
    );
    const trigger = screen.getByLabelText('localFiles.trigger');
    const dot = trigger.querySelector('span[aria-hidden="true"]');
    expect(dot?.className).toContain('bg-muted-foreground');
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
