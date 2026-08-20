// @vitest-environment jsdom

import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLiveVoice, type UseLiveVoiceResult } from './useLiveVoice';

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
    },
  };
});

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useWorkspace: () => mocks.workspace,
}));

afterEach(() => {
  document.body.replaceChildren();
  mocks.workspace.client = mocks.client;
  vi.clearAllMocks();
});

describe('useLiveVoice', () => {
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
});
