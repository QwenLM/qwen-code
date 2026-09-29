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
      requirements: { host: enabled ? 'ready' : 'missing' },
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
  vi.useRealTimers();
});

describe('useLiveVoiceSetup', () => {
  it('loads on opening, polls only during installation, and stops when closed', async () => {
    vi.useFakeTimers();
    mocks.client.liveSetupStatus.mockResolvedValue(status(false));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let setup: UseLiveVoiceSetupResult | undefined;
    function Harness({ active }: { active: boolean }) {
      setup = useLiveVoiceSetup(true, active);
      return null;
    }
    const render = async (active: boolean) => {
      await act(async () => root.render(<Harness active={active} />));
    };
    await render(false);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(setup?.supported).toBe(true);
    expect(mocks.client.liveSetupStatus).not.toHaveBeenCalled();
    await render(true);
    expect(mocks.client.liveSetupStatus).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.client.liveSetupStatus).toHaveBeenCalledOnce();
    mocks.client.liveSetupStatus.mockResolvedValue({
      ...status(true),
      install: { state: 'installing' },
    });
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(mocks.client.liveSetupStatus).toHaveBeenCalledTimes(4);
    await render(false);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.client.liveSetupStatus).toHaveBeenCalledTimes(4);
    mocks.client.liveSetupStatus.mockResolvedValue(status(true));
    await render(true);
    expect(mocks.client.liveSetupStatus).toHaveBeenCalledTimes(5);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.client.liveSetupStatus).toHaveBeenCalledTimes(5);
    act(() => root.unmount());
  });

  it.each(['failed read', 'host starting', 'failed mutation'] as const)(
    'recovers %s while open and stops polling once ready',
    async (scenario) => {
      vi.useFakeTimers();
      const ready = {
        ...status(true),
        live: {
          ...status(true).live,
          requirements: { host: 'ready' as const },
        },
      };
      mocks.client.liveSetupStatus.mockResolvedValue(ready);
      let finishFirst!: (value: DaemonLiveSetupStatus) => void;
      if (scenario === 'failed read')
        mocks.client.liveSetupStatus.mockRejectedValueOnce(
          new Error('offline'),
        );
      if (scenario === 'host starting')
        mocks.client.liveSetupStatus.mockResolvedValueOnce({
          ...ready,
          live: { ...ready.live, requirements: { host: 'missing' } },
        });
      if (scenario === 'failed mutation')
        mocks.client.liveSetupStatus.mockReturnValueOnce(
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
        );
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      let setup!: UseLiveVoiceSetupResult;
      function Harness() {
        setup = useLiveVoiceSetup(true);
        return null;
      }
      await act(async () => root.render(<Harness />));
      if (scenario === 'failed mutation') {
        mocks.client.updateLiveSetup.mockRejectedValueOnce(
          new Error('save failed'),
        );
        await act(async () => {
          await setup.update({ enabled: true }).catch(() => undefined);
          finishFirst(ready);
        });
      }
      expect(mocks.client.liveSetupStatus).toHaveBeenCalledOnce();
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(mocks.client.liveSetupStatus).toHaveBeenCalledTimes(2);
      expect(setup.status).toEqual(ready);
      await act(async () => vi.advanceTimersByTimeAsync(3_000));
      expect(mocks.client.liveSetupStatus).toHaveBeenCalledTimes(2);
      act(() => root.unmount());
    },
  );

  it('stops polling when an installed host never becomes ready', async () => {
    vi.useFakeTimers();
    mocks.client.liveSetupStatus.mockResolvedValue({
      ...status(true),
      live: {
        ...status(true).live,
        requirements: { host: 'missing' as const },
      },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    function Harness() {
      useLiveVoiceSetup(true);
      return null;
    }
    await act(async () => root.render(<Harness />));
    expect(mocks.client.liveSetupStatus).toHaveBeenCalledOnce();

    // The host wait polls while it is young.
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(mocks.client.liveSetupStatus.mock.calls.length).toBeGreaterThan(1);

    // Once the wait budget is spent the poll stops even though the daemon
    // keeps reporting the host as missing.
    await act(async () => vi.advanceTimersByTimeAsync(31_000));
    const settledCalls = mocks.client.liveSetupStatus.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.client.liveSetupStatus.mock.calls.length).toBe(settledCalls);

    // A focus refresh still works as the recovery path.
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(mocks.client.liveSetupStatus.mock.calls.length).toBe(
      settledCalls + 1,
    );
    act(() => root.unmount());
  });

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
