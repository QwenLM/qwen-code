// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonLiveSetupStatus } from '@qwen-code/sdk';
import {
  useLiveVoiceSetup,
  type UseLiveVoiceSetupResult,
} from './useLiveVoiceSetup';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function status(enabled: boolean): DaemonLiveSetupStatus {
  return {
    v: 1,
    enabled,
    keyConfigured: true,
    model: 'qwen3.5-omni-plus-realtime',
    shortcut: 'Command+E',
    install: { state: enabled ? 'installed' : 'missing' },
    live: {
      v: 1,
      available: enabled,
      state: enabled ? 'idle' : 'unavailable',
      shortcut: 'Command+E',
    },
  };
}

const mocks = vi.hoisted(() => {
  const client = {
    liveSetupStatus: vi.fn(),
    updateLiveSetup: vi.fn(),
    retryLiveHostInstall: vi.fn(),
    launchLiveHost: vi.fn(),
  };
  return { client, workspace: { client } };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => mocks.workspace,
}));

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('useLiveVoiceSetup', () => {
  it('does not let an older status poll overwrite a completed mutation', async () => {
    let resolveStatus: ((value: DaemonLiveSetupStatus) => void) | undefined;
    mocks.client.liveSetupStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    mocks.client.updateLiveSetup.mockResolvedValue(status(true));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let setup: UseLiveVoiceSetupResult | undefined;

    function Harness() {
      setup = useLiveVoiceSetup(true);
      return <span>{setup.status?.enabled ? 'enabled' : 'disabled'}</span>;
    }

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await act(async () => {
      await setup?.update({ enabled: true });
    });
    expect(container.textContent).toBe('enabled');

    await act(async () => {
      resolveStatus?.(status(false));
      await Promise.resolve();
    });
    expect(container.textContent).toBe('enabled');

    act(() => root.unmount());
  });

  it('keeps mutation errors across successful status refreshes', async () => {
    mocks.client.liveSetupStatus.mockResolvedValue(status(false));
    mocks.client.updateLiveSetup
      .mockRejectedValueOnce(new Error('save failed'))
      .mockResolvedValueOnce(status(true));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let setup: UseLiveVoiceSetupResult | undefined;

    function Harness() {
      setup = useLiveVoiceSetup(true);
      return <span>{setup.error?.message ?? 'ok'}</span>;
    }

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await act(async () => {
      await setup?.update({ enabled: true }).catch(() => undefined);
    });
    expect(container.textContent).toBe('save failed');

    await act(async () => {
      await setup?.refresh();
    });
    expect(container.textContent).toBe('save failed');

    await act(async () => {
      await setup?.update({ enabled: true });
    });
    expect(container.textContent).toBe('ok');

    act(() => root.unmount());
  });

  it('does not contact setup routes when the daemon hides Live', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      return <>{String(useLiveVoiceSetup(false).supported)}</>;
    }

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(container.textContent).toBe('false');
    expect(mocks.client.liveSetupStatus).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
