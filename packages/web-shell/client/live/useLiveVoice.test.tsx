// @vitest-environment jsdom

import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from '@qwen-code/sdk/daemon';
import { useLiveVoice, type UseLiveVoiceResult } from './useLiveVoice';
import { getLivePresence, setLivePresence } from './live-presence';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  const liveStatus = vi.fn();
  const client = {
    liveStatus,
    startLive: vi.fn(),
    stopLive: vi.fn(),
    setLiveMute: vi.fn(),
  };
  return {
    liveStatus,
    client,
    workspace: {
      capabilities: { features: ['realtime_voice'] },
      client,
      refreshCapabilities: vi.fn(async () => undefined),
    },
  };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => mocks.workspace,
}));

const catalogMocks = vi.hoisted(() => ({
  sessionCreated: vi.fn(),
}));

vi.mock('../session-catalog/session-catalog-hooks', () => ({
  useSessionCatalogController: () => catalogMocks,
}));

const browserHostMock = vi.hoisted(() => ({
  onStatus: undefined as ((status: unknown) => void) | undefined,
}));

vi.mock('./useLiveBrowserHost', () => ({
  useLiveBrowserHost: (options: { onStatus?: (status: unknown) => void }) => {
    browserHostMock.onStatus = options.onStatus;
    return {
      phase: 'idle',
      closeReason: undefined,
      errorMessage: undefined,
      captureMode: undefined,
      inputLevel: { current: { level: 0, at: 0, dropping: false } },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  },
}));

afterEach(() => {
  setLivePresence(mocks.client as unknown as DaemonClient, undefined);
  document.body.replaceChildren();
  mocks.workspace.client = mocks.client;
  vi.clearAllMocks();
});

describe('useLiveVoice', () => {
  it('publishes a pending voice row immediately and discovers its session without reload', async () => {
    mocks.liveStatus.mockResolvedValue({
      v: 1,
      available: true,
      state: 'idle',
      shortcut: '',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let live: UseLiveVoiceResult | undefined;
    function Harness() {
      live = useLiveVoice();
      return null;
    }
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    act(() => live?.begin());
    expect(
      getLivePresence(mocks.client as unknown as DaemonClient)?.state,
    ).toBe('connecting');

    await act(async () => {
      browserHostMock.onStatus?.({
        v: 1,
        available: true,
        state: 'starting',
        shortcut: '',
        callId: 'voice-call',
        coordinator: {
          workspaceCwd: '/conversations',
          workspaceId: 'conversations-workspace',
          sessionId: 'voice-session',
        },
      });
      await Promise.resolve();
    });

    expect(catalogMocks.sessionCreated).toHaveBeenCalledWith(
      '/conversations',
      'voice-session',
    );
    expect(mocks.workspace.refreshCapabilities).toHaveBeenCalledOnce();
    expect(
      getLivePresence(mocks.client as unknown as DaemonClient)?.coordinator
        ?.sessionId,
    ).toBe('voice-session');
    act(() => root.unmount());
  });
  it('keeps asynchronous status updates mounted across StrictMode replay', async () => {
    let resolveStatus: ((value: unknown) => void) | undefined;
    mocks.liveStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const live = useLiveVoice();
      return <span>{live.status?.state ?? 'pending'}</span>;
    }

    act(() => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
    });
    expect(container.textContent).toBe('pending');

    await act(async () => {
      resolveStatus?.({
        v: 1,
        available: true,
        state: 'idle',
        shortcut: 'Command+Q',
      });
      await Promise.resolve();
    });

    expect(container.textContent).toBe('idle');
    expect(mocks.liveStatus).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });

  it('serializes mutations before React can commit the mutating state', async () => {
    mocks.liveStatus.mockResolvedValue({
      v: 1,
      available: true,
      state: 'idle',
      shortcut: 'Command+Q',
    });
    let resolveStart: ((value: unknown) => void) | undefined;
    mocks.workspace.client.startLive.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let live: UseLiveVoiceResult | undefined;

    function Harness() {
      live = useLiveVoice();
      return null;
    }

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => {
      first = live?.start('new');
      second = live?.start('new');
    });

    expect(mocks.workspace.client.startLive).toHaveBeenCalledOnce();
    expect(mocks.workspace.client.startLive).toHaveBeenCalledWith('new');

    await act(async () => {
      resolveStart?.({
        v: 1,
        available: true,
        state: 'listening',
        shortcut: 'Command+Q',
      });
      await Promise.all([first, second]);
    });

    act(() => root.unmount());
  });

  it('does not let an older status poll overwrite a completed mutation', async () => {
    let resolveStatus: ((value: unknown) => void) | undefined;
    mocks.liveStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    mocks.workspace.client.startLive.mockResolvedValue({
      v: 1,
      available: true,
      state: 'listening',
      shortcut: 'Command+Q',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let live: UseLiveVoiceResult | undefined;

    function Harness() {
      live = useLiveVoice();
      return <span>{live.status?.state ?? 'pending'}</span>;
    }

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await act(async () => {
      await live?.start('new');
    });
    expect(container.textContent).toBe('listening');

    await act(async () => {
      resolveStatus?.({
        v: 1,
        available: true,
        state: 'idle',
        shortcut: 'Command+Q',
      });
      await Promise.resolve();
    });
    expect(container.textContent).toBe('listening');

    act(() => root.unmount());
  });

  it('ignores a status response from a replaced workspace client', async () => {
    let resolveOldStatus: ((value: unknown) => void) | undefined;
    const oldClient = {
      liveStatus: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveOldStatus = resolve;
          }),
      ),
      startLive: vi.fn(),
      stopLive: vi.fn(),
      setLiveMute: vi.fn(),
    };
    const newClient = {
      liveStatus: vi.fn().mockResolvedValue({
        v: 1,
        available: true,
        state: 'listening',
        shortcut: 'Command+Q',
      }),
      startLive: vi.fn(),
      stopLive: vi.fn(),
      setLiveMute: vi.fn(),
    };
    mocks.workspace.client = oldClient;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const live = useLiveVoice();
      return <span>{live.status?.state ?? 'pending'}</span>;
    }

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    mocks.workspace.client = newClient;
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    expect(container.textContent).toBe('listening');

    await act(async () => {
      resolveOldStatus?.({
        v: 1,
        available: true,
        state: 'idle',
        shortcut: 'Command+Q',
      });
      await Promise.resolve();
    });
    expect(container.textContent).toBe('listening');

    act(() => root.unmount());
  });

  it('does not let a slow poll overwrite a fresher pushed status', async () => {
    let resolvePoll: ((value: unknown) => void) | undefined;
    mocks.liveStatus.mockReturnValue(
      new Promise((resolve) => {
        resolvePoll = resolve;
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    function Harness() {
      const live = useLiveVoice();
      return (
        <span>
          {live.status?.state ?? 'pending'}|{String(live.loading)}
        </span>
      );
    }
    act(() => root.render(<Harness />));

    // The daemon pushes "speaking" over the Host socket while the poll that
    // was sent earlier is still in flight...
    act(() => {
      browserHostMock.onStatus?.({
        v: 1,
        available: true,
        state: 'speaking',
        shortcut: '',
      });
    });
    expect(container.textContent).toBe('speaking|false');

    // ...and that older answer finally arrives.
    await act(async () => {
      resolvePoll?.({ v: 1, available: true, state: 'idle', shortcut: '' });
      await Promise.resolve();
    });
    expect(container.textContent).toBe('speaking|false');
    act(() => root.unmount());
  });

  it('keeps the mutation error when a push lands before the mutation settles', async () => {
    mocks.liveStatus.mockResolvedValue({
      v: 1,
      available: true,
      state: 'idle',
      shortcut: 'Command+Q',
    });
    let rejectStart: ((error: Error) => void) | undefined;
    mocks.workspace.client.startLive.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectStart = reject;
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let live: UseLiveVoiceResult | undefined;

    function Harness() {
      live = useLiveVoice();
      return (
        <span>
          {live.status?.state ?? 'pending'}|
          {live.status?.message ?? 'no-message'}
        </span>
      );
    }

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    expect(container.textContent).toBe('idle|no-message');

    let startPromise: Promise<void> | undefined;
    act(() => {
      startPromise = live?.start('new');
    });

    // The daemon pushes the new Host state over the socket before the
    // mutation's HTTP response finishes; the push must not discard the
    // mutation's own outcome.
    act(() => {
      browserHostMock.onStatus?.({
        v: 1,
        available: true,
        state: 'listening',
        shortcut: '',
      });
    });
    expect(container.textContent).toBe('listening|no-message');

    await act(async () => {
      rejectStart?.(new Error('provider validation failed'));
      await startPromise;
    });

    expect(container.textContent).toBe('error|provider validation failed');
    act(() => root.unmount());
  });

  it('does not start a status poll while a mutation is in flight', async () => {
    vi.useFakeTimers();
    try {
      mocks.liveStatus.mockResolvedValue({
        v: 1,
        available: true,
        state: 'idle',
        shortcut: 'Command+Q',
      });
      let resolveStart: ((value: unknown) => void) | undefined;
      mocks.workspace.client.startLive.mockReturnValue(
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
      );
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      let live: UseLiveVoiceResult | undefined;

      function Harness() {
        live = useLiveVoice();
        return <span>{live.status?.state ?? 'pending'}</span>;
      }

      await act(async () => {
        root.render(<Harness />);
        await Promise.resolve();
      });
      expect(container.textContent).toBe('idle');

      let startPromise: Promise<void> | undefined;
      act(() => {
        startPromise = live?.start('new');
      });

      // The 1 s poll interval fires while the mutation is still pending;
      // polling now would race the mutation's own delivered status.
      await act(async () => {
        vi.advanceTimersByTime(1_100);
      });

      // The mutation settles only after that: its outcome must stand.
      await act(async () => {
        resolveStart?.({
          v: 1,
          available: true,
          state: 'listening',
          shortcut: 'Command+Q',
        });
        await startPromise;
      });

      expect(container.textContent).toBe('listening');
      expect(mocks.liveStatus).toHaveBeenCalledTimes(1);
      act(() => root.unmount());
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stack duplicate polls while pushes keep arriving', async () => {
    vi.useFakeTimers();
    try {
      // A slow daemon: the poll never settles within the test.
      mocks.liveStatus.mockReturnValue(new Promise(() => {}));
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      function Harness() {
        const live = useLiveVoice();
        return <span>{live.status?.state ?? 'pending'}</span>;
      }
      act(() => root.render(<Harness />));

      // Each push bumps the poll generation to retire stale answers; the
      // interval must not turn that into a new request while one is in
      // flight (a Host call pushes several times per second).
      for (let i = 0; i < 2; i++) {
        act(() => {
          browserHostMock.onStatus?.({
            v: 1,
            available: true,
            state: 'speaking',
            shortcut: '',
          });
        });
        await act(async () => {
          vi.advanceTimersByTime(1_100);
        });
      }

      expect(mocks.liveStatus).toHaveBeenCalledTimes(1);
      act(() => root.unmount());
    } finally {
      vi.useRealTimers();
    }
  });
});
