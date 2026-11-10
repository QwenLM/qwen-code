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
  DaemonWeixinAccountStatus,
  DaemonWeixinLoginFlow,
} from '@qwen-code/sdk/daemon';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { formatDateTime } = await import('../../utils/formatDateTime');
const { WeixinLoginPanel } = await import('./WeixinLoginPanel');
const { I18nProvider, getTranslator } = await import('../../i18n');

const LOGGED_OUT: DaemonWeixinAccountStatus = {
  enabled: true,
  configured: false,
};
const LOGGED_IN: DaemonWeixinAccountStatus = {
  enabled: true,
  configured: true,
  userId: 'wx-user-1',
  savedAt: '2026-11-09T00:00:00.000Z',
};
const WAITING: DaemonWeixinLoginFlow = {
  id: 'flow-1',
  status: 'waiting',
  qrText: '▄▀▄▀',
  qrcodeUrl: 'https://scan.example/qr-1',
};

let container: HTMLDivElement;
let root: Root;
let unmounted: boolean;

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === text,
  );
}

async function renderPanel({
  status = vi.fn().mockResolvedValue(LOGGED_OUT),
  start = vi.fn().mockResolvedValue(WAITING),
  poll = vi.fn().mockResolvedValue(WAITING),
  cancel = vi.fn().mockResolvedValue(undefined),
  revoke = vi.fn().mockResolvedValue(undefined),
  language = 'en',
}: {
  status?: () => Promise<DaemonWeixinAccountStatus | undefined>;
  start?: () => Promise<DaemonWeixinLoginFlow | undefined>;
  poll?: (id: string) => Promise<DaemonWeixinLoginFlow | undefined>;
  cancel?: (id: string) => Promise<void>;
  revoke?: () => Promise<void>;
  language?: 'en' | 'zh-CN';
} = {}) {
  await act(async () => {
    root.render(
      <I18nProvider language={language}>
        <WeixinLoginPanel api={{ status, start, poll, cancel, revoke }} />
      </I18nProvider>,
    );
  });
  return { status, start, poll, cancel, revoke };
}

beforeEach(() => {
  vi.useFakeTimers();
  unmounted = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (!unmounted) act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('WeixinLoginPanel', () => {
  it('shows the logged-out state with a login action and no QR', async () => {
    const { status } = await renderPanel();

    expect(status).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Not logged in');
    expect(buttonByText('Log in with QR code')).toBeDefined();
    expect(container.querySelector('pre')).toBeNull();
    expect(buttonByText('Log out')).toBeUndefined();
  });

  it('shows the logged-in account with relogin and logout actions', async () => {
    await renderPanel({ status: vi.fn().mockResolvedValue(LOGGED_IN) });

    expect(container.textContent).toContain('Logged in');
    expect(container.textContent).toContain('User ID: wx-user-1');
    // Formatted for the reader's locale, not the raw UTC stamp the daemon
    // stores. The absence assertion is the load-bearing one: it reds if the
    // formatter is dropped, and it does not depend on the runner's timezone.
    expect(container.textContent).toContain(
      `Logged in at ${formatDateTime(LOGGED_IN.savedAt!)}`,
    );
    expect(container.textContent).not.toContain('T00:00:00.000Z');
    expect(container.textContent).toContain(
      'Channels that are already running keep the previous account',
    );
    expect(buttonByText('Log in again')).toBeDefined();
    expect(buttonByText('Log out')).toBeDefined();
    expect(buttonByText('Log in with QR code')).toBeUndefined();
  });

  it('renders the unsupported hint when the daemon has no route', async () => {
    await renderPanel({ status: vi.fn().mockResolvedValue(undefined) });

    expect(container.textContent).toContain(
      'This daemon does not support WeChat login',
    );
    expect(buttonByText('Log in with QR code')).toBeUndefined();
    expect(buttonByText('Log out')).toBeUndefined();
  });

  it('treats a disposed login surface as unsupported', async () => {
    // The status read has no `allowed` guard, so a daemon that disposed these
    // routes still answers 200 — with `enabled: false`. A login button there
    // could only 404, and `enabled` would otherwise be a field nothing reads.
    await renderPanel({
      status: vi.fn().mockResolvedValue({ enabled: false, configured: true }),
    });

    expect(container.textContent).toContain(
      'This daemon does not support WeChat login',
    );
    expect(buttonByText('Log in again')).toBeUndefined();
    expect(buttonByText('Log in with QR code')).toBeUndefined();
  });

  it('starts a flow and renders the QR block', async () => {
    const { start } = await renderPanel();

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });

    expect(start).toHaveBeenCalledOnce();
    expect(container.querySelector('pre')?.textContent).toBe('▄▀▄▀');
    expect(container.textContent).toContain('Scan the QR code with WeChat.');
    // While the QR is live the login action is replaced by the QR itself.
    expect(buttonByText('Log in with QR code')).toBeUndefined();
  });

  it('falls back to the raw link when the QR could not be rendered', async () => {
    await renderPanel({
      start: vi.fn().mockResolvedValue({
        id: 'flow-1',
        status: 'waiting',
        qrcodeUrl: 'https://scan.example/qr-1',
      }),
    });

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });

    expect(container.querySelector('pre')).toBeNull();
    const link = container.querySelector<HTMLAnchorElement>('a');
    expect(link?.getAttribute('href')).toBe('https://scan.example/qr-1');
    expect(link?.textContent).toContain('Open the login URL');
  });

  it('polls through scanned to ready and then stops', async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ ...WAITING, status: 'scanned' })
      .mockResolvedValue({ id: 'flow-1', status: 'ready' });
    const status = vi
      .fn()
      .mockResolvedValueOnce(LOGGED_OUT)
      .mockResolvedValue(LOGGED_IN);
    await renderPanel({ poll, status });

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(container.textContent).toContain('Scanned. Confirm on your phone.');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(container.textContent).toContain('WeChat connected.');
    expect(container.textContent).toContain('Logged in');
    expect(poll).toHaveBeenCalledTimes(2);

    // Terminal status must stop the loop, not keep spending requests.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('offers a refresh after the QR expires', async () => {
    const start = vi
      .fn()
      .mockResolvedValueOnce(WAITING)
      .mockResolvedValue({ ...WAITING, id: 'flow-2' });
    await renderPanel({
      start,
      poll: vi.fn().mockResolvedValue({
        id: 'flow-1',
        status: 'expired',
        errorCode: 'qr_expired',
      }),
    });

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    expect(container.textContent).toContain(
      'QR code expired. Refresh to try again.',
    );
    expect(container.querySelector('pre')).toBeNull();
    const refresh = buttonByText('Refresh QR code');
    expect(refresh).toBeDefined();

    await act(async () => {
      refresh?.click();
    });
    expect(start).toHaveBeenCalledTimes(2);
    expect(container.querySelector('pre')?.textContent).toBe('▄▀▄▀');
  });

  it('shows a single refresh action when a logged-in account retries', async () => {
    await renderPanel({
      status: vi.fn().mockResolvedValue(LOGGED_IN),
      poll: vi.fn().mockResolvedValue({
        id: 'flow-1',
        status: 'error',
        errorCode: 'login_failed',
      }),
    });

    await act(async () => {
      buttonByText('Log in again')?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    // The retry and relogin branches must not both render: two buttons doing
    // the same thing is the defect this pins.
    expect(buttonByText('Refresh QR code')).toBeDefined();
    expect(buttonByText('Log in again')).toBeUndefined();
    expect(container.textContent).toContain('WeChat login failed. Try again.');
  });

  it('logs out and returns to the logged-out state', async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    const status = vi
      .fn()
      .mockResolvedValueOnce(LOGGED_IN)
      .mockResolvedValue(LOGGED_OUT);
    await renderPanel({ status, revoke });

    await act(async () => {
      buttonByText('Log out')?.click();
    });

    expect(revoke).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Not logged in');
    expect(buttonByText('Log in with QR code')).toBeDefined();
  });

  it('ignores an account read that a logout superseded', async () => {
    // The `ready` poll fires an account refresh without awaiting it. If that
    // GET read the credential before the logout, it can resolve afterwards
    // and paint "Logged in" over an account that has just been revoked.
    let resolveStale: (value: DaemonWeixinAccountStatus) => void = () =>
      undefined;
    const stale = new Promise<DaemonWeixinAccountStatus>((resolve) => {
      resolveStale = resolve;
    });
    const status = vi
      .fn()
      .mockResolvedValueOnce(LOGGED_IN) // mount
      .mockReturnValueOnce(stale) // the ready-triggered refresh, held open
      .mockResolvedValue(LOGGED_OUT); // the logout's own refresh
    await renderPanel({
      status,
      poll: vi.fn().mockResolvedValue({ id: 'flow-1', status: 'ready' }),
    });

    await act(async () => {
      buttonByText('Log in again')?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    await act(async () => {
      buttonByText('Log out')?.click();
    });
    expect(container.textContent).toContain('Not logged in');

    // The superseded read lands last. It must not resurrect the account.
    await act(async () => {
      resolveStale(LOGGED_IN);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Not logged in');
    expect(container.textContent).not.toContain('wx-user-1');
    expect(buttonByText('Log in with QR code')).toBeDefined();
  });

  it('keeps Log out available when a relogin fails', async () => {
    // The credential is still installed, so the one control that can revoke
    // it must survive a relogin that ends in error.
    const revoke = vi.fn().mockResolvedValue(undefined);
    await renderPanel({
      status: vi.fn().mockResolvedValue(LOGGED_IN),
      poll: vi.fn().mockResolvedValue({ id: 'flow-1', status: 'error' }),
      revoke,
    });

    await act(async () => {
      buttonByText('Log in again')?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    expect(container.textContent).toContain('Logged in');
    expect(buttonByText('Refresh QR code')).toBeDefined();
    // Exactly one retry action in this state.
    expect(buttonByText('Log in again')).toBeUndefined();
    const logout = buttonByText('Log out');
    expect(logout).toBeDefined();
    await act(async () => {
      logout?.click();
    });
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('clears a poll error once the daemon reports the flow gone', async () => {
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue(undefined);
    await renderPanel({ poll });

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(container.textContent).toContain('Failed to fetch');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(container.textContent).toContain('Not logged in');
    expect(container.textContent).not.toContain('Failed to fetch');
  });

  it('does not keep showing Logged in when the post-logout read fails', async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce(LOGGED_IN)
      .mockRejectedValue(new Error('status unavailable'));
    await renderPanel({ status });

    await act(async () => {
      buttonByText('Log out')?.click();
    });

    expect(container.textContent).not.toContain('Logged in');
    expect(container.textContent).not.toContain('wx-user-1');
    expect(container.textContent).toContain('status unavailable');
  });

  it('names a credential write failure and still offers a way to try again', async () => {
    // The copy tells the operator to fix the directory and retry, so the
    // action has to exist. The flow is terminal and occupies no slot, so a
    // retry cannot displace anything.
    const { start } = await renderPanel({
      poll: vi.fn().mockResolvedValue({
        id: 'flow-1',
        status: 'error',
        errorCode: 'credentials_error',
      }),
    });

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    expect(container.textContent).toContain('could not save the credential');
    expect(buttonByText('Refresh QR code')).toBeUndefined();
    const retry = buttonByText('Log in with QR code');
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
    });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('does not ask the operator to scan while a replacement QR is minted', async () => {
    // After an expiry the daemon publishes a live view with neither QR field.
    // A scan prompt there names something that is not on screen, and the
    // action row must not be empty while it is up.
    await renderPanel({
      poll: vi.fn().mockResolvedValue({ id: 'flow-1', status: 'waiting' }),
    });

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    expect(container.textContent).toContain('Preparing a new QR code');
    expect(container.textContent).not.toContain('Scan the QR code with WeChat');
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(buttonByText('Refresh QR code')).toBeDefined();
  });

  it('drops the flow it replaces when retrying from the re-mint window', async () => {
    const { cancel } = await renderPanel({
      start: vi
        .fn()
        .mockResolvedValueOnce({ id: 'flow-1', status: 'waiting' })
        .mockResolvedValueOnce({ ...WAITING, id: 'flow-2' }),
      poll: vi.fn().mockResolvedValue({ id: 'flow-1', status: 'waiting' }),
    });

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    await act(async () => {
      buttonByText('Refresh QR code')?.click();
    });

    expect(cancel).toHaveBeenCalledWith('flow-1');
  });

  it('keeps the account visible when the revoke itself fails', async () => {
    // The credential is still installed server-side, so the optimistic
    // logged-out paint must stay after the await, not move above it.
    await renderPanel({
      status: vi.fn().mockResolvedValue(LOGGED_IN),
      revoke: vi.fn().mockRejectedValue(new Error('revoke unavailable')),
    });

    await act(async () => {
      buttonByText('Log out')?.click();
    });

    expect(container.textContent).toContain('Logged in');
    expect(container.textContent).toContain('wx-user-1');
    expect(container.textContent).toContain('revoke unavailable');
    expect(buttonByText('Log out')).toBeDefined();
    expect(buttonByText('Log in with QR code')).toBeUndefined();
  });

  it('exposes the QR as a named image rather than a wall of glyphs', async () => {
    await renderPanel();
    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });

    const pre = container.querySelector('pre');
    expect(pre?.getAttribute('role')).toBe('img');
    // The literal, not the same translator lookup the component performs:
    // `getTranslator` falls back to the key itself, so a missing catalog entry
    // would make both sides `channels.weixin.qrAlt` and pass.
    expect(pre?.getAttribute('aria-label')).toBe('WeChat login QR code');
  });

  it('refuses to link an unsafe QR URL', async () => {
    await renderPanel({
      start: vi.fn().mockResolvedValue({
        id: 'flow-1',
        status: 'waiting',
        qrcodeUrl: 'javascript:alert(1)',
      }),
    });
    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });

    expect(container.querySelector('a')).toBeNull();
  });

  it('links a safe QR URL when the encoder could not render it', async () => {
    await renderPanel({
      start: vi.fn().mockResolvedValue({
        id: 'flow-1',
        status: 'waiting',
        qrcodeUrl: 'https://scan.example/qr-1',
      }),
    });
    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });

    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://scan.example/qr-1',
    );
  });

  it('surfaces a start failure without leaving the panel wedged', async () => {
    await renderPanel({
      start: vi.fn().mockRejectedValue(new Error('upstream unavailable')),
    });

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });

    expect(container.textContent).toContain('upstream unavailable');
    expect(buttonByText('Log in with QR code')?.disabled).toBe(false);
  });

  it('stops polling once unmounted', async () => {
    const { poll } = await renderPanel();

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(poll).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    unmounted = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('cancels a live flow when the panel unmounts', async () => {
    // The daemon keeps the flow and its upstream polling alive without a
    // browser, so closing the editor must drop it — otherwise four abandoned
    // attempts exhaust the flow cap and real logins are refused.
    const { cancel } = await renderPanel();

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });
    act(() => root.unmount());
    unmounted = true;

    expect(cancel).toHaveBeenCalledWith('flow-1');
  });

  it('cancels a flow the daemon creates after the panel unmounts', async () => {
    // The unmount cleanup can only cancel a flow it has seen. Clicking login
    // and immediately closing the dialog leaves the POST in flight, so the
    // flow is born after the panel is gone — and would poll the upstream for
    // its whole deadline unless the resolved start drops it.
    let resolveStart: (flow: DaemonWeixinLoginFlow) => void = () => undefined;
    const start = vi.fn().mockReturnValue(
      new Promise<DaemonWeixinLoginFlow>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const cancel = vi.fn().mockResolvedValue(undefined);
    await renderPanel({ start, cancel });

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });
    act(() => root.unmount());
    unmounted = true;

    await act(async () => {
      resolveStart(WAITING);
      await Promise.resolve();
    });

    expect(cancel).toHaveBeenCalledWith('flow-1');
  });

  it('leaves a flow that was already terminal when the start resolved', async () => {
    let resolveStart: (flow: DaemonWeixinLoginFlow) => void = () => undefined;
    const start = vi.fn().mockReturnValue(
      new Promise<DaemonWeixinLoginFlow>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const cancel = vi.fn().mockResolvedValue(undefined);
    await renderPanel({ start, cancel });

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });
    act(() => root.unmount());
    unmounted = true;

    await act(async () => {
      resolveStart({ id: 'flow-1', status: 'ready' });
      await Promise.resolve();
    });

    expect(cancel).not.toHaveBeenCalled();
  });

  it('does not cancel a flow that already finished', async () => {
    const { cancel } = await renderPanel({
      poll: vi.fn().mockResolvedValue({ id: 'flow-1', status: 'ready' }),
    });

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    act(() => root.unmount());
    unmounted = true;

    expect(cancel).not.toHaveBeenCalled();
  });

  it('keeps polling while the daemon reports the same status', async () => {
    // Waiting is the normal state until the operator scans. A one-shot timer
    // re-armed only on a status change fires once and then stops, leaving the
    // QR frozen forever — the mock must therefore repeat one status.
    const poll = vi.fn().mockResolvedValue(WAITING);
    await renderPanel({ poll });

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(poll).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(poll).toHaveBeenCalledTimes(3);
    expect(container.querySelector('pre')?.textContent).toBe('▄▀▄▀');
  });

  it('recovers from a transient poll failure and clears the error', async () => {
    // A non-terminal flow renders no refresh button, so a poll loop that stopped
    // on the first network blip would strand the operator with no way to retry.
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValue({ id: 'flow-1', status: 'ready' });
    await renderPanel({ poll });

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(container.textContent).toContain('network blip');
    expect(poll).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(poll).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('WeChat connected.');
    expect(container.textContent).not.toContain('network blip');
  });

  it('keeps polling when the host rebuilds the api object on re-render', async () => {
    // The real host hands down a fresh api object whenever it re-renders. A
    // poll timer keyed on that identity is cleared and restarted every time,
    // so under continuous re-rendering it never fires — the QR sits at
    // "waiting" forever. The mocks stay stable; only the object identity churns.
    const poll = vi.fn().mockResolvedValue({ id: 'flow-1', status: 'ready' });
    const status = vi.fn().mockResolvedValue(LOGGED_OUT);
    const start = vi.fn().mockResolvedValue(WAITING);
    const revoke = vi.fn().mockResolvedValue(undefined);
    const renderWithFreshApi = async () => {
      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <WeixinLoginPanel api={{ status, start, poll, revoke }} />
          </I18nProvider>,
        );
      });
    };

    await renderWithFreshApi();
    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });

    // Re-render every 400ms across more than one poll interval.
    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await renderWithFreshApi();
    }

    expect(poll).toHaveBeenCalled();
    expect(container.textContent).toContain('WeChat connected.');
  });

  it('treats a vanished flow as a return to the account view', async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce(LOGGED_OUT)
      .mockResolvedValue(LOGGED_IN);
    await renderPanel({ poll: vi.fn().mockResolvedValue(undefined), status });

    await act(async () => {
      buttonByText('Log in with QR code')?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).toContain('Logged in');
  });
});

describe('WeixinLoginPanel localization', () => {
  it.each(['en', 'zh-CN'] as const)(
    'renders the logged-out copy in %s without raw keys',
    async (language) => {
      await renderPanel({ language });
      const t = getTranslator(language);

      expect(container.textContent).toContain(t('channels.weixin.loggedOut'));
      expect(container.textContent).toContain(t('channels.weixin.description'));
      expect(buttonByText(t('channels.weixin.login'))).toBeDefined();
      expect(container.textContent).not.toContain('channels.weixin.');
      // The zh catalog must actually differ from EN, or this case would pass
      // on a missing translation that silently fell back.
      if (language === 'zh-CN') {
        expect(t('channels.weixin.loggedOut')).toBe('未登录');
        expect(t('channels.weixin.login')).toBe('扫码登录');
      }
    },
  );

  it.each(['en', 'zh-CN'] as const)(
    'renders the logged-in copy in %s without raw keys',
    async (language) => {
      await renderPanel({
        language,
        status: vi.fn().mockResolvedValue(LOGGED_IN),
      });
      const t = getTranslator(language);

      expect(container.textContent).toContain(t('channels.weixin.loggedIn'));
      expect(container.textContent).toContain(
        t('channels.weixin.userId', { id: 'wx-user-1' }),
      );
      expect(container.textContent).toContain('wx-user-1');
      expect(buttonByText(t('channels.weixin.logout'))).toBeDefined();
      expect(container.textContent).not.toContain('channels.weixin.');
      expect(container.textContent).not.toContain('{id}');
      if (language === 'zh-CN') {
        expect(t('channels.weixin.loggedIn')).toBe('已登录');
        expect(t('channels.weixin.logout')).toBe('退出登录');
      }
    },
  );

  it.each(['en', 'zh-CN'] as const)(
    'renders the scannable QR state in %s',
    async (language) => {
      await renderPanel({ language });
      const t = getTranslator(language);

      await act(async () => {
        buttonByText(t('channels.weixin.login'))?.click();
      });

      const pre = container.querySelector('pre');
      expect(pre?.getAttribute('role')).toBe('img');
      // Literals: a translator lookup on both sides would pass on a missing
      // key, which is exactly the regression this pins.
      expect(pre?.getAttribute('aria-label')).toBe(
        language === 'zh-CN' ? '微信登录二维码' : 'WeChat login QR code',
      );
      expect(container.textContent).toContain(
        language === 'zh-CN'
          ? '请用微信扫描二维码。'
          : 'Scan the QR code with WeChat.',
      );
      expect(container.textContent).not.toContain('channels.weixin.');
    },
  );

  it.each(['en', 'zh-CN'] as const)(
    'renders the re-mint window in %s',
    async (language) => {
      await renderPanel({
        language,
        poll: vi.fn().mockResolvedValue({ id: 'flow-1', status: 'waiting' }),
      });
      const t = getTranslator(language);

      await act(async () => {
        buttonByText(t('channels.weixin.login'))?.click();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });

      expect(container.textContent).toContain(
        language === 'zh-CN'
          ? '正在生成新的二维码…'
          : 'Preparing a new QR code…',
      );
      expect(container.textContent).not.toContain('channels.weixin.');
      expect(buttonByText(t('channels.weixin.refresh'))).toBeDefined();
    },
  );

  it.each(['en', 'zh-CN'] as const)(
    'renders the credential-write failure in %s',
    async (language) => {
      await renderPanel({
        language,
        poll: vi.fn().mockResolvedValue({
          id: 'flow-1',
          status: 'error',
          errorCode: 'credentials_error',
        }),
      });
      const t = getTranslator(language);

      await act(async () => {
        buttonByText(t('channels.weixin.login'))?.click();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });

      expect(container.textContent).toContain(
        t('channels.weixin.credentialsError'),
      );
      expect(container.textContent).not.toContain('channels.weixin.');
      if (language === 'zh-CN') {
        expect(t('channels.weixin.credentialsError')).toContain('无法保存凭据');
      }
    },
  );

  it.each(['en', 'zh-CN'] as const)(
    'renders the unsupported hint in %s',
    async (language) => {
      await renderPanel({
        language,
        status: vi.fn().mockResolvedValue(undefined),
      });
      const t = getTranslator(language);

      expect(container.textContent).toContain(t('channels.weixin.unsupported'));
      expect(container.textContent).not.toContain('channels.weixin.');
      if (language === 'zh-CN') {
        expect(t('channels.weixin.unsupported')).toContain('当前 daemon');
      }
    },
  );
});
