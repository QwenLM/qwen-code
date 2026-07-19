/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonHttpError,
  type DaemonChannelAuthSession,
} from '@qwen-code/sdk/daemon';
import {
  useChannelQrAuth,
  type ChannelQrAuthActions,
  type UseChannelQrAuthResult,
} from './useChannelQrAuth';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function session(
  state: DaemonChannelAuthSession['state'],
  qrRevision = 1,
): DaemonChannelAuthSession {
  return {
    id: 'auth-1',
    state,
    qrRevision,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
}

let container: HTMLDivElement;
let root: Root;
let latest: UseChannelQrAuthResult | undefined;
let props: {
  open: boolean;
  identity: object;
  actions: ChannelQrAuthActions;
};

function Harness() {
  const result = useChannelQrAuth({
    open: props.open,
    identity: props.identity,
    name: 'qq-main',
    channelType: 'qq',
    actions: props.actions,
  });
  useEffect(() => {
    latest = result;
  }, [result]);
  return null;
}

async function render() {
  await act(async () => {
    root.render(<Harness />);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = undefined;
  let objectUrl = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:qr-${++objectUrl}`),
      revokeObjectURL: vi.fn(),
    }),
  );
  props = {
    open: true,
    identity: {},
    actions: {
      begin: vi.fn().mockResolvedValue(session('awaiting_scan')),
      status: vi.fn().mockResolvedValue(session('awaiting_scan')),
      qr: vi
        .fn()
        .mockResolvedValue(new Blob(['qr'], { type: 'image/svg+xml' })),
      cancel: vi.fn().mockResolvedValue({ cancelled: true }),
      commit: vi.fn().mockResolvedValue({}),
    },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useChannelQrAuth', () => {
  it('revokes the previous QR object URL after rotation and on unmount', async () => {
    await render();
    await flush();
    expect(latest?.qrUrl).toBe('blob:qr-1');

    vi.mocked(props.actions.status).mockResolvedValueOnce(
      session('awaiting_scan', 2),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await flush();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:qr-1');
    expect(latest?.qrUrl).toBe('blob:qr-2');
    act(() => root.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:qr-2');
    root = createRoot(container);
  });

  it('begins only one server session during StrictMode effect replay', async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
    });
    await flush();

    expect(props.actions.begin).toHaveBeenCalledOnce();
  });

  it('never overlaps status polling requests', async () => {
    const pending = deferred<DaemonChannelAuthSession>();
    vi.mocked(props.actions.status).mockReturnValue(pending.promise);
    await render();
    await flush();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(props.actions.status).toHaveBeenCalledOnce();
    pending.resolve(session('awaiting_scan'));
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(props.actions.status).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(props.actions.status).toHaveBeenCalledTimes(2);
  });

  it('cancels the exact old session and ignores its late response on identity change', async () => {
    const oldStatus = deferred<DaemonChannelAuthSession>();
    vi.mocked(props.actions.status).mockReturnValueOnce(oldStatus.promise);
    const oldActions = props.actions;
    await render();
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    props = {
      ...props,
      identity: {},
      actions: {
        ...props.actions,
        begin: vi.fn().mockResolvedValue({
          ...session('awaiting_scan', 7),
          id: 'auth-new',
        }),
      },
    };
    await render();
    await flush();
    expect(oldActions.cancel).toHaveBeenCalledWith('qq-main', 'auth-1');

    oldStatus.resolve(session('ready', 99));
    await flush();
    expect(latest?.session?.id).toBe('auth-new');
    expect(latest?.session?.qrRevision).toBe(7);
  });

  it('cancels a begin response that arrives after the dialog closes', async () => {
    const pendingBegin = deferred<DaemonChannelAuthSession>();
    vi.mocked(props.actions.begin).mockReturnValue(pendingBegin.promise);
    await render();

    props = { ...props, open: false };
    await render();
    pendingBegin.resolve(session('awaiting_scan'));
    await flush();

    expect(props.actions.cancel).toHaveBeenCalledWith('qq-main', 'auth-1');
    expect(latest?.session).toBeUndefined();
  });

  it('rejects a non-image QR blob without creating an object URL', async () => {
    vi.mocked(props.actions.qr).mockResolvedValue(
      new Blob(['not an image'], { type: 'text/plain' }),
    );
    await render();
    await flush();

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(latest?.error).toBe('The QR image could not be loaded.');
    expect(latest?.canRetry).toBe(true);
  });

  it('redacts wrong-client failures as an unavailable session', async () => {
    vi.mocked(props.actions.begin).mockRejectedValue(
      new DaemonHttpError(
        400,
        { code: 'invalid_client_id', error: 'sensitive client details' },
        'sensitive client details',
      ),
    );
    await render();
    await flush();

    expect(latest?.unavailable).toBe(true);
    expect(latest?.error).toBe('This authentication session is unavailable.');
    expect(latest?.error).not.toContain('sensitive');
  });

  it('does not retry permanent channel-auth failures', async () => {
    vi.mocked(props.actions.begin).mockRejectedValue(
      new DaemonHttpError(
        400,
        { code: 'channel_auth_unsupported' },
        'unsupported',
      ),
    );
    await render();
    await flush();

    expect(latest?.error).toBe('Authentication could not be started.');
    expect(latest?.canRetry).toBe(false);
  });

  it('commits only a ready session and does not cancel it afterward', async () => {
    vi.mocked(props.actions.begin).mockResolvedValue(session('ready'));
    await render();
    await flush();

    await act(async () => latest?.commit());
    expect(props.actions.commit).toHaveBeenCalledWith('qq-main', 'auth-1', {
      channelType: 'qq',
    });
    expect(latest?.session?.state).toBe('committed');
    props = { ...props, open: false };
    await render();
    expect(props.actions.cancel).not.toHaveBeenCalled();
  });

  it('cancels a retryable session before beginning a replacement', async () => {
    vi.mocked(props.actions.begin)
      .mockResolvedValueOnce(session('expired'))
      .mockResolvedValueOnce({
        ...session('awaiting_scan'),
        id: 'auth-2',
      });
    await render();
    await flush();
    expect(latest?.canRetry).toBe(true);

    await act(async () => latest?.retry());
    await flush();
    expect(props.actions.cancel).toHaveBeenCalledWith('qq-main', 'auth-1');
    expect(props.actions.begin).toHaveBeenCalledTimes(2);
    expect(latest?.session?.id).toBe('auth-2');
  });
});
