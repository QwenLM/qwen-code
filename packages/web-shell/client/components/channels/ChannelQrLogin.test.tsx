/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonChannelQrLoginStartResult,
  DaemonChannelQrLoginView,
} from '@qwen-code/sdk/daemon';

const { I18nProvider } = await import('../../i18n');
const { ChannelQrLogin } = await import('./ChannelQrLogin');

const VIEW: DaemonChannelQrLoginView = {
  loginId: 'login-1',
  channelType: 'qq',
  channelName: 'qq-bot',
  status: 'pending',
  expiresAt: 9_999_999,
  qrCodeDataUrl: 'data:image/png;base64,AAAA',
};
const START: DaemonChannelQrLoginStartResult = { ...VIEW, attached: false };

let container: HTMLDivElement;
let root: Root;
let unmounted: boolean;

function actions(overrides?: {
  start?: () => Promise<DaemonChannelQrLoginStartResult>;
  state?: (id: string) => Promise<DaemonChannelQrLoginView>;
  cancel?: (id: string) => Promise<DaemonChannelQrLoginView>;
}) {
  return {
    start: vi.fn(overrides?.start ?? (async () => START)),
    state: vi.fn(overrides?.state ?? (async () => VIEW)),
    cancel: vi.fn(
      overrides?.cancel ??
        (async () => ({
          ...VIEW,
          status: 'cancelled' as const,
        })),
    ),
  };
}

async function render(
  props: {
    channelName?: string;
    actions?: ReturnType<typeof actions>;
    onBound?: () => void;
    language?: 'en' | 'zh-CN';
  } = {},
) {
  const a = props.actions ?? actions();
  const onBound = props.onBound ?? vi.fn();
  await act(async () => {
    root.render(
      <I18nProvider language={props.language ?? 'en'}>
        <ChannelQrLogin
          channelName={props.channelName ?? 'qq-bot'}
          actions={a}
          onBound={onBound}
        />
      </I18nProvider>,
    );
  });
  return { a, onBound };
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;

async function click(label: string) {
  const b = button(label);
  expect(b, `button ${label}`).toBeDefined();
  await act(async () => {
    b!.click();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  unmounted = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (!unmounted) {
    await act(async () => {
      root.unmount();
    });
  }
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function unmount() {
  unmounted = true;
  await act(async () => {
    root.unmount();
  });
}

describe('ChannelQrLogin', () => {
  it('renders the image the daemon produced after starting', async () => {
    const { a } = await render();
    await click('Scan to bind');
    expect(a.start).toHaveBeenCalledWith('qq-bot');
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(VIEW.qrCodeDataUrl);
  });

  it('keeps polling even when the parent passes a fresh actions object', async () => {
    const first = actions();
    const { onBound } = await render({ actions: first });
    await click('Scan to bind');
    expect(first.state).not.toHaveBeenCalled();

    // A parent re-render hands down a new object identity; the interval must
    // survive it rather than being torn down before it ever fires.
    const second = actions();
    await render({ actions: second, onBound });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(second.state).toHaveBeenCalledWith('login-1');
  });

  it('reports the bound state once and reloads once', async () => {
    const succeeded: DaemonChannelQrLoginView = {
      ...VIEW,
      status: 'succeeded',
      qrCodeDataUrl: undefined,
    };
    const a = actions({ state: async () => succeeded });
    const { onBound } = await render({ actions: a });
    await click('Scan to bind');
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(onBound).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Bot bound');

    // A further poll of the same terminal session must not reload again.
    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    expect(onBound).toHaveBeenCalledTimes(1);
  });

  it('stops polling once the session is terminal', async () => {
    const a = actions({
      state: async () => ({ ...VIEW, status: 'cancelled' as const }),
    });
    await render({ actions: a });
    await click('Scan to bind');
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    const calls = a.state.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(a.state.mock.calls.length).toBe(calls);
  });

  it('cancels the pending session', async () => {
    const { a } = await render();
    await click('Scan to bind');
    await click('Cancel');
    expect(a.cancel).toHaveBeenCalledWith('login-1');
    expect(container.textContent).toContain('Binding cancelled');
    expect(container.querySelector('img')).toBeNull();
  });

  it('surfaces a start failure without rendering a code', async () => {
    const a = actions({
      start: async () => {
        throw new Error('channel must be saved first');
      },
    });
    await render({ actions: a });
    await click('Scan to bind');
    expect(container.textContent).toContain('channel must be saved first');
    expect(container.querySelector('img')).toBeNull();
  });

  it('drops the previous code when the channel changes', async () => {
    const { a } = await render();
    await click('Scan to bind');
    expect(container.querySelector('img')).not.toBeNull();
    await render({ channelName: 'other-bot', actions: a });
    expect(container.querySelector('img')).toBeNull();
  });

  it('cancels the stale session before asking for a new code', async () => {
    // The daemon reattaches a pending login and returns the identical view, so
    // a retry that does not cancel first would leave the old code on screen.
    const a = actions({ start: async () => ({ ...START, attached: true }) });
    await render({ actions: a });
    await click('Scan to bind');
    expect(a.cancel).not.toHaveBeenCalled();
    await click('New code');
    expect(a.cancel).toHaveBeenCalledWith('login-1');
    expect(a.start).toHaveBeenCalledTimes(2);
    // Cancel must precede the second start, not follow it.
    const cancelOrder = a.cancel.mock.invocationCallOrder[0]!;
    const secondStart = a.start.mock.invocationCallOrder[1]!;
    expect(cancelOrder).toBeLessThan(secondStart);
  });

  it('treats a missing session as expired', async () => {
    const a = actions({
      state: async () => {
        throw Object.assign(new Error('gone'), {
          body: { code: 'channel_qr_login_not_found' },
        });
      },
    });
    await render({ actions: a });
    await click('Scan to bind');
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(container.textContent).toContain('The code expired');
  });

  it('keeps a live session pending through a transient poll failure', async () => {
    const a = actions({
      state: async () => {
        throw new Error('socket hang up');
      },
    });
    await render({ actions: a });
    await click('Scan to bind');
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    // Still scannable, and still polling.
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.textContent).not.toContain('The code expired');
    const calls = a.state.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(a.state.mock.calls.length).toBeGreaterThan(calls);
  });

  it('renders Chinese labels under the zh locale', async () => {
    await render({ language: 'zh-CN' });
    expect(container.textContent).toContain('扫码绑定');
    expect(container.textContent).not.toContain('Scan to bind');
  });
});

describe('ChannelQrLogin unmount cleanup', () => {
  it('cancels the live login when the editor closes', async () => {
    // The daemon holds one of the workspace's four slots and keeps polling
    // Tencent with no panel on screen, so an abandoned session must be dropped.
    const { a } = await render();
    await click('Scan to bind');
    expect(a.cancel).not.toHaveBeenCalled();
    await unmount();
    expect(a.cancel).toHaveBeenCalledWith('login-1');
  });

  it('does not cancel while the panel stays mounted across polls', async () => {
    const { a } = await render();
    await click('Scan to bind');
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(a.state.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(a.cancel).not.toHaveBeenCalled();
  });

  it('does not cancel when the parent passes a fresh actions object', async () => {
    // The host may rebuild the actions object on re-render. A cleanup keyed on
    // its identity would drop a login the operator is still waiting on.
    const first = actions();
    await render({ actions: first });
    await click('Scan to bind');
    const second = actions();
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <ChannelQrLogin
            channelName="qq-bot"
            actions={second}
            onBound={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    expect(first.cancel).not.toHaveBeenCalled();
    expect(second.cancel).not.toHaveBeenCalled();
    await unmount();
    // The latest identity is the one that must issue the cancel.
    expect(second.cancel).toHaveBeenCalledWith('login-1');
    expect(first.cancel).not.toHaveBeenCalled();
  });

  it('does not cancel a login that already succeeded', async () => {
    const a = actions({
      state: async () => ({ ...VIEW, status: 'succeeded' as const }),
    });
    await render({ actions: a });
    await click('Scan to bind');
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await unmount();
    expect(a.cancel).not.toHaveBeenCalled();
  });

  it('does not cancel anything when no login was started', async () => {
    const { a } = await render();
    await unmount();
    expect(a.cancel).not.toHaveBeenCalled();
  });

  it('attaches a rejection handler to the unmount cancel', async () => {
    const calls: string[] = [];
    let handlerAttached = false;
    const base = actions();
    // A plain function, not vi.fn: the mock wrapper neutralises the returned
    // rejection. The promise is real and really rejects, but its `catch` is
    // instrumented so the cell owns its oracle — relying on the runner to fail
    // on an unhandled rejection would be vacuous here, because this package
    // ignores unhandled errors off Linux.
    const plain = {
      start: base.start,
      state: base.state,
      cancel: (id: string) => {
        calls.push(id);
        const rejecting: Promise<DaemonChannelQrLoginView> = Promise.reject(
          new Error('daemon went away'),
        );
        const realCatch = rejecting.catch.bind(rejecting);
        rejecting.catch = ((onRejected: (reason: unknown) => unknown) => {
          handlerAttached = true;
          return realCatch(onRejected);
        }) as typeof rejecting.catch;
        return rejecting;
      },
    };
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <ChannelQrLogin
            channelName="qq-bot"
            actions={plain}
            onBound={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await click('Scan to bind');
    await unmount();
    expect(calls).toEqual(['login-1']);
    // Nobody is left to show the failure to, so the cleanup must swallow it.
    expect(handlerAttached).toBe(true);
  });

  it('cancels a login created after the panel unmounted', async () => {
    // The POST is still in flight at unmount, so `view` is undefined and the
    // cleanup sees no id. The creator is the only place that ever learns it.
    let resolveStart!: (value: DaemonChannelQrLoginStartResult) => void;
    const a = actions({
      start: () =>
        new Promise<DaemonChannelQrLoginStartResult>((resolve) => {
          resolveStart = resolve;
        }),
    });
    await render({ actions: a });
    await click('Scan to bind');
    await unmount();
    expect(a.cancel).not.toHaveBeenCalled();
    await act(async () => {
      resolveStart(START);
    });
    expect(a.cancel).toHaveBeenCalledWith('login-1');
  });

  it('attaches a rejection handler to the late-arrival cancel', async () => {
    let resolveStart!: (value: DaemonChannelQrLoginStartResult) => void;
    let handlerAttached = false;
    const base = actions({
      start: () =>
        new Promise<DaemonChannelQrLoginStartResult>((resolve) => {
          resolveStart = resolve;
        }),
    });
    const plain = {
      start: base.start,
      state: base.state,
      cancel: () => {
        const rejecting: Promise<DaemonChannelQrLoginView> = Promise.reject(
          new Error('daemon went away'),
        );
        const realCatch = rejecting.catch.bind(rejecting);
        rejecting.catch = ((onRejected: (reason: unknown) => unknown) => {
          handlerAttached = true;
          return realCatch(onRejected);
        }) as typeof rejecting.catch;
        return rejecting;
      },
    };
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <ChannelQrLogin
            channelName="qq-bot"
            actions={plain}
            onBound={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await click('Scan to bind');
    await unmount();
    await act(async () => {
      resolveStart(START);
    });
    expect(handlerAttached).toBe(true);
  });

  it('does not cancel a late result that already succeeded', async () => {
    let resolveStart!: (value: DaemonChannelQrLoginStartResult) => void;
    const a = actions({
      start: () =>
        new Promise<DaemonChannelQrLoginStartResult>((resolve) => {
          resolveStart = resolve;
        }),
    });
    await render({ actions: a });
    await click('Scan to bind');
    await unmount();
    await act(async () => {
      resolveStart({ ...START, status: 'succeeded' });
    });
    expect(a.cancel).not.toHaveBeenCalled();
  });
});
