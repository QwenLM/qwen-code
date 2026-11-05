// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SubscriptionOAuthError } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import {
  subscriptionAuthorizationUrl,
  useSubscription,
} from './use-subscription.js';

const mocks = vi.hoisted(() => ({
  getUserInfo: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  browser: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/qwen/subscription-session.js', () => ({
  QwenSubscriptionSession: class {
    getUserInfo = mocks.getUserInfo;
    signIn = mocks.signIn;
    signOut = mocks.signOut;
  },
}));
vi.mock('@qwen-code/qwen-code-core/utils/secure-browser-launcher.js', () => ({
  openBrowserSecurely: mocks.browser,
}));
vi.mock('../../i18n/index.js', () => ({ t: (message: string) => message }));

const free = {
  sub: 'user-1',
  name: 'Test',
  email: 'test@example.invalid',
  member_type: 'free',
};
const queryFailure = () =>
  new SubscriptionOAuthError(
    'network_error',
    undefined,
    undefined,
    undefined,
    'userinfo',
  );
const device = {
  device_code: 'synthetic-device',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://chat.qwen.ai/device',
  verification_uri_complete: 'https://chat.qwen.ai/device?user_code=ABCD-EFGH',
  expires_in: 600,
  interval: 5,
  expiresAt: Date.now() + 600_000,
};
function authorize(info = free) {
  mocks.signIn.mockImplementation(async (onDevice) => {
    onDevice(device);
    return info;
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.stubEnv('DEV', false);
  delete process.env['DEV'];
  vi.stubEnv('QWEN_HOME', '/tmp/subscription-hook-test');
  vi.stubEnv('QWEN_OAUTH_BASE_URL', 'https://pre-auth.qwen.ai');
  vi.stubEnv('QWEN_OAUTH_CLIENT_ID', 'qwen-code-cli');
  mocks.browser.mockResolvedValue(undefined);
  mocks.getUserInfo.mockResolvedValue(free);
  mocks.signOut.mockResolvedValue(undefined);
  authorize();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

it('starts OAuth without environment configuration', async () => {
  vi.stubEnv('QWEN_OAUTH_BASE_URL', undefined);
  vi.stubEnv('QWEN_OAUTH_CLIENT_ID', undefined);
  vi.stubEnv('QWEN_HOME', undefined);
  mocks.signIn.mockImplementation(async (onDevice) => {
    onDevice(device);
    return free;
  });
  const { result, unmount } = renderHook(() => useSubscription());
  await flush();
  expect(mocks.signIn).toHaveBeenCalledOnce();
  expect(mocks.browser).toHaveBeenCalledWith(
    'https://pre-chat.qwen.ai/authorize?user_code=ABCD-EFGH&client=qwen-code',
  );
  expect(result.current.state.status).toBe('purchase-required');
  unmount();
});

it('uses the preproduction browser URL without exposing the device code', () => {
  expect(subscriptionAuthorizationUrl(device)).toBe(
    'https://pre-chat.qwen.ai/authorize?user_code=ABCD-EFGH&client=qwen-code',
  );
});

it.each([
  ['free', 'Free'],
  ['FREE', 'Free'],
  ['LiTe', 'Lite'],
  ['go', 'Go'],
  ['lite', 'Lite'],
  ['enterprise', 'Enterprise'],
  ['VIP', 'Vip'],
])(
  'opens only authorization for fresh %s membership and keeps polling',
  async (member_type, plan) => {
    mocks.signIn.mockImplementation(async (onDevice) => {
      onDevice(device);
      return { ...free, member_type };
    });
    const { result, unmount } = renderHook(() => useSubscription());
    await flush();
    expect(result.current.email).toBe(free.email);
    expect(result.current.state).toEqual({
      status: 'purchase-required',
      plan,
    });
    expect(result.current.canCheckAgain).toBe(false);
    expect(mocks.browser.mock.calls.map(([url]) => url)).toEqual([
      'https://pre-chat.qwen.ai/authorize?user_code=ABCD-EFGH&client=qwen-code',
    ]);
    act(() => result.current.openPlans());
    expect(mocks.browser).toHaveBeenCalledTimes(2);
    expect(mocks.browser).toHaveBeenLastCalledWith(
      'https://pre-chat.qwen.ai/?memberPlan=qwen_code',
    );
    expect(mocks.signIn).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(1);
    const signal: AbortSignal = mocks.signIn.mock.calls[0][1];
    unmount();
    expect(signal.aborted).toBe(true);
    const calls = mocks.getUserInfo.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls);
  },
);

it('requests authorization even when browser auto-opening is suppressed', async () => {
  const { result, unmount } = renderHook(() =>
    useSubscription({ suppressBrowserLaunch: true }),
  );
  await flush();
  expect(mocks.signIn).toHaveBeenCalledOnce();
  expect(mocks.getUserInfo).not.toHaveBeenCalled();
  expect(mocks.browser).not.toHaveBeenCalled();
  expect(result.current.deviceAuth?.user_code).toBe(device.user_code);
  expect(result.current.state.status).toBe('purchase-required');
  unmount();
});

it.each(['free', 'plus', 'pro'])(
  'waits for new authorization instead of restoring saved %s membership',
  async (member_type) => {
    mocks.getUserInfo.mockResolvedValue({ ...free, member_type });
    let finish!: (info: typeof free) => void;
    mocks.signIn.mockImplementation((onDevice) => {
      onDevice(device);
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const onActivate = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() =>
      useSubscription({ onActivate }),
    );
    await flush();
    expect(result.current.state.status).toBe('waiting');
    expect(mocks.getUserInfo).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
    expect(mocks.browser.mock.calls.map(([url]) => url)).toEqual([
      'https://pre-chat.qwen.ai/authorize?user_code=ABCD-EFGH&client=qwen-code',
    ]);
    await act(async () => finish({ ...free, member_type }));
    expect(result.current.state.status).toBe(
      member_type === 'free' ? 'purchase-required' : 'ready',
    );
    expect(mocks.signIn).toHaveBeenCalledOnce();
    if (member_type !== 'free') {
      expect(onActivate).toHaveBeenCalledWith(
        expect.any(AbortSignal),
        'https://pre-chat.qwen.ai/authorize?user_code=ABCD-EFGH&client=qwen-code',
      );
    }
    unmount();
  },
);

it('opens a new device authorization on every explicit entry', async () => {
  mocks.signIn
    .mockImplementationOnce(async (onDevice) => {
      onDevice(device);
      return free;
    })
    .mockImplementationOnce(async (onDevice) => {
      onDevice({ ...device, user_code: 'NEXT-CODE' });
      return free;
    });
  const first = renderHook(() => useSubscription());
  await flush();
  first.unmount();
  const second = renderHook(() => useSubscription());
  await flush();
  expect(mocks.signIn).toHaveBeenCalledTimes(2);
  expect(mocks.getUserInfo).not.toHaveBeenCalled();
  expect(mocks.signOut).not.toHaveBeenCalled();
  expect(mocks.browser.mock.calls.map(([url]) => url)).toEqual([
    'https://pre-chat.qwen.ai/authorize?user_code=ABCD-EFGH&client=qwen-code',
    'https://pre-chat.qwen.ai/authorize?user_code=NEXT-CODE&client=qwen-code',
  ]);
  second.unmount();
});

it.each([false, true])(
  'clears credentials before authorizing another account (suppressBrowserLaunch=%s)',
  async (suppressBrowserLaunch) => {
    mocks.getUserInfo.mockResolvedValue(null);
    let finishCleanup!: () => void;
    mocks.signOut.mockReturnValue(
      new Promise<void>((resolve) => {
        finishCleanup = resolve;
      }),
    );
    let finishLogin!: (info: typeof free) => void;
    mocks.signIn
      .mockImplementationOnce(async (onDevice) => {
        onDevice(device);
        return free;
      })
      .mockImplementationOnce((onDevice) => {
        onDevice({ ...device, user_code: 'NEXT-CODE' });
        return new Promise((resolve) => {
          finishLogin = resolve;
        });
      });
    const onActivate = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(() =>
      useSubscription({ suppressBrowserLaunch, onActivate }),
    );
    await flush();
    const oldSignal = mocks.signIn.mock.calls[0][1] as AbortSignal;
    act(() => {
      void hook.result.current.switchAccount();
      void hook.result.current.switchAccount();
    });
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(oldSignal.aborted).toBe(true);
    expect(hook.result.current.state.status).toBe('waiting');
    expect(hook.result.current.deviceAuth).toBeUndefined();
    expect(hook.result.current.email).toBe('');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.getUserInfo).not.toHaveBeenCalled();
    expect(mocks.signIn).toHaveBeenCalledOnce();
    await act(async () => finishCleanup());
    expect(mocks.signIn).toHaveBeenCalledTimes(2);
    expect(hook.result.current.deviceAuth?.verification_uri_complete).toContain(
      'user_code=NEXT-CODE',
    );
    if (suppressBrowserLaunch) expect(mocks.browser).not.toHaveBeenCalled();
    else
      expect(mocks.browser.mock.calls.map(([url]) => url)).toEqual([
        'https://pre-chat.qwen.ai/authorize?user_code=ABCD-EFGH&client=qwen-code',
        'https://pre-chat.qwen.ai/authorize?user_code=NEXT-CODE&client=qwen-code',
      ]);
    await act(async () =>
      finishLogin({ ...free, email: 'next@example.test', member_type: 'pro' }),
    );
    expect(hook.result.current.email).toBe('next@example.test');
    expect(hook.result.current.state).toEqual({ status: 'ready', plan: 'Pro' });
    expect(onActivate).toHaveBeenCalledOnce();
    hook.unmount();
  },
);

it.each(['cancel', 'unmount', 'new lifetime'] as const)(
  'ignores late account cleanup after %s',
  async (action) => {
    let finish!: () => void;
    mocks.signOut.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const hook = renderHook(
      ({ suppressBrowserLaunch }) => useSubscription({ suppressBrowserLaunch }),
      { initialProps: { suppressBrowserLaunch: false } },
    );
    await flush();
    act(() => {
      void hook.result.current.switchAccount();
    });
    if (action === 'cancel') act(() => hook.result.current.cancel());
    else if (action === 'unmount') hook.unmount();
    else {
      hook.rerender({ suppressBrowserLaunch: true });
      await flush();
    }
    const signIns = mocks.signIn.mock.calls.length;
    const queries = mocks.getUserInfo.mock.calls.length;
    const opened = mocks.browser.mock.calls.length;
    await act(async () => finish());
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(queries);
    expect(mocks.browser).toHaveBeenCalledTimes(opened);
    expect(mocks.signIn).toHaveBeenCalledTimes(signIns);
    if (action !== 'unmount') hook.unmount();
  },
);

it('does not restart a queued account switch after cancel', async () => {
  let finish!: () => void;
  mocks.signOut.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  mocks.getUserInfo.mockResolvedValueOnce(free).mockResolvedValue(null);
  mocks.signIn.mockImplementation(async (onDevice) => {
    onDevice(device);
    return free;
  });
  const hook = renderHook(() => useSubscription());
  await flush();
  const opened = mocks.browser.mock.calls.length;
  let switching!: Promise<void>;
  act(() => {
    switching = hook.result.current.switchAccount();
  });
  await act(async () => {
    finish();
    await switching;
    hook.result.current.cancel();
  });
  expect(mocks.getUserInfo).not.toHaveBeenCalled();
  expect(mocks.signIn).toHaveBeenCalledOnce();
  expect(mocks.browser).toHaveBeenCalledTimes(opened);
  hook.unmount();
});

it.each(['cleanup', 'revoke'] as const)(
  'keeps account-switch %s failures visible without starting authorization',
  async (stage) => {
    mocks.signOut.mockRejectedValue(
      new SubscriptionOAuthError(
        'credentials_error',
        undefined,
        undefined,
        undefined,
        stage,
      ),
    );
    const hook = renderHook(() => useSubscription());
    await flush();
    await act(async () => {
      await hook.result.current.switchAccount();
    });
    expect(hook.result.current.state).toMatchObject({
      status: 'error',
      message: expect.stringContaining(
        stage === 'cleanup'
          ? 'remove local Qwen credentials'
          : 'signed out locally',
      ),
    });
    expect(mocks.signIn).toHaveBeenCalledOnce();
    expect(mocks.getUserInfo).not.toHaveBeenCalled();
    hook.unmount();
  },
);

it('ignores a late old membership query after switching accounts', async () => {
  let finishQuery!: (info: typeof free) => void;
  mocks.getUserInfo
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishQuery = resolve;
      }),
    )
    .mockResolvedValue(null);
  mocks.signIn
    .mockImplementationOnce(async (onDevice) => {
      onDevice(device);
      return free;
    })
    .mockImplementation((onDevice) => {
      onDevice({ ...device, user_code: 'NEXT-CODE' });
      return new Promise(() => {});
    });
  const hook = renderHook(() => useSubscription());
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  const signal = mocks.getUserInfo.mock.calls[0][0] as AbortSignal;
  await act(async () => {
    await hook.result.current.switchAccount();
  });
  expect(signal.aborted).toBe(true);
  await act(async () => finishQuery({ ...free, member_type: 'pro' }));
  expect(hook.result.current.state.status).toBe('waiting');
  expect(hook.result.current.deviceAuth?.verification_uri_complete).toContain(
    'NEXT-CODE',
  );
  hook.unmount();
});

it('discards the previous account cooldown after successful cleanup', async () => {
  mocks.signIn
    .mockImplementationOnce(async (onDevice) => {
      onDevice(device);
      return free;
    })
    .mockRejectedValueOnce(queryFailure());
  mocks.getUserInfo
    .mockRejectedValueOnce(
      new SubscriptionOAuthError(
        'rate_limited',
        429,
        undefined,
        60_000,
        'userinfo',
      ),
    )
    .mockResolvedValue(free);
  const hook = renderHook(() => useSubscription());
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(hook.result.current.canCheckAgain).toBe(true);
  await act(async () => {
    await hook.result.current.switchAccount();
  });
  expect(hook.result.current.state.status).toBe('query-error');
  await act(async () => hook.result.current.checkAgain());
  expect(mocks.getUserInfo).toHaveBeenCalledTimes(2);
  expect(hook.result.current.state.status).toBe('purchase-required');
  hook.unmount();
});

it('stops automatic polling at 120 seconds and allows a single manual query', async () => {
  const { result, unmount } = renderHook(() =>
    useSubscription({ suppressBrowserLaunch: true }),
  );
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(result.current.canCheckAgain).toBe(true);
  const calls = mocks.getUserInfo.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls);
  await act(async () => {
    result.current.checkAgain();
    result.current.checkAgain();
  });
  expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls + 1);
  expect(result.current.state).toMatchObject({
    canCheckAgain: true,
    message: expect.stringContaining('No active Plus or Pro'),
  });
  unmount();
});

it('stops on query failure, then can discover a purchased plan without reauthorizing', async () => {
  mocks.getUserInfo
    .mockRejectedValueOnce(queryFailure())
    .mockResolvedValue({ ...free, member_type: 'pro' });
  const { result, unmount } = renderHook(() =>
    useSubscription({ suppressBrowserLaunch: true }),
  );
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(result.current.canCheckAgain).toBe(true);
  expect(result.current.state).toMatchObject({
    message: expect.stringContaining(
      "Couldn't check your subscription status. Please try again.",
    ),
  });
  await act(async () => {
    result.current.checkAgain();
  });
  expect(result.current.state).toEqual({ status: 'ready', plan: 'Pro' });
  expect(mocks.signIn).toHaveBeenCalledOnce();
  unmount();
});

it('displays an unknown membership by its returned name', async () => {
  authorize({ ...free, member_type: 'unknown' });
  const { result, unmount } = renderHook(() => useSubscription());
  await flush();
  expect(result.current.state).toEqual({
    status: 'purchase-required',
    plan: 'Unknown',
  });
  unmount();
});

it('does not let stale saved refresh credentials block explicit authorization', async () => {
  mocks.signIn.mockImplementation(async (onDevice) => {
    onDevice(device);
    return { ...free, member_type: 'pro' };
  });
  mocks.getUserInfo.mockRejectedValue(
    new SubscriptionOAuthError(
      'invalid_grant',
      400,
      undefined,
      undefined,
      'refresh',
    ),
  );
  const { result, unmount } = renderHook(() => useSubscription());
  await flush();
  expect(result.current.state).toEqual({
    status: 'ready',
    plan: 'Pro',
  });
  expect(mocks.signIn).toHaveBeenCalledOnce();
  expect(mocks.getUserInfo).not.toHaveBeenCalled();
  expect(mocks.browser).toHaveBeenCalledWith(
    'https://pre-chat.qwen.ai/authorize?user_code=ABCD-EFGH&client=qwen-code',
  );
  unmount();
});

it('shows timeout instead of navigating away when the device code expires', async () => {
  mocks.getUserInfo.mockResolvedValue(null);
  mocks.signIn.mockRejectedValue(new SubscriptionOAuthError('expired_token'));
  const { result, unmount } = renderHook(() => useSubscription());
  await flush();
  expect(result.current.state.status).toBe('timeout');
  unmount();
});

it('cancels membership polling without signing out', async () => {
  const { result, unmount } = renderHook(() =>
    useSubscription({ suppressBrowserLaunch: true }),
  );
  await flush();
  const signal: AbortSignal = mocks.signIn.mock.calls[0][1];
  act(() => result.current.cancel());
  expect(signal.aborted).toBe(true);
  expect(mocks.signOut).not.toHaveBeenCalled();
  const calls = mocks.getUserInfo.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150_000);
  });
  expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls);
  unmount();
});

it('cancels a pending manual membership query without signing out', async () => {
  mocks.getUserInfo.mockRejectedValueOnce(queryFailure());
  const { result, unmount } = renderHook(() =>
    useSubscription({ suppressBrowserLaunch: true }),
  );
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  mocks.getUserInfo.mockImplementationOnce(
    (signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  act(() => result.current.checkAgain());
  expect(result.current.checking).toBe(true);
  await act(async () => result.current.cancel());
  expect(mocks.signOut).not.toHaveBeenCalled();
  expect((mocks.getUserInfo.mock.calls.at(-1)![0] as AbortSignal).aborted).toBe(
    true,
  );
  unmount();
});

it('recovers a first userinfo failure using saved credentials and starts purchase waiting only after confirmation', async () => {
  mocks.getUserInfo.mockResolvedValue(free);
  mocks.signIn.mockRejectedValue(
    new SubscriptionOAuthError(
      'network_error',
      undefined,
      'private detail',
      undefined,
      'userinfo',
    ),
  );
  const { result, unmount } = renderHook(() => useSubscription());
  await flush();
  expect(result.current.state.status).toBe('query-error');
  expect(mocks.browser).not.toHaveBeenCalled();
  act(() => result.current.checkAgain());
  await flush();
  expect(result.current.state).toEqual({
    status: 'purchase-required',
    plan: 'Free',
  });
  expect(mocks.signIn).toHaveBeenCalledTimes(1);
  expect(mocks.browser).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(result.current.canCheckAgain).toBe(true);
  expect(mocks.browser).not.toHaveBeenCalled();
  unmount();
});

it('does not reopen plans when the first membership query after authorization is retried', async () => {
  mocks.getUserInfo.mockResolvedValue(free);
  mocks.signIn.mockImplementation(async (onDevice) => {
    onDevice(device);
    throw new SubscriptionOAuthError(
      'network_error',
      undefined,
      undefined,
      undefined,
      'userinfo',
    );
  });
  const { result, unmount } = renderHook(() => useSubscription());
  await flush();
  expect(result.current.state.status).toBe('query-error');
  act(() => result.current.checkAgain());
  await flush();
  expect(result.current.state.status).toBe('purchase-required');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(mocks.getUserInfo).toHaveBeenCalledTimes(2);
  expect(mocks.browser.mock.calls.map(([url]) => url)).toEqual([
    'https://pre-chat.qwen.ai/authorize?user_code=ABCD-EFGH&client=qwen-code',
  ]);
  unmount();
});

it('keeps exchange invalid_grant distinct from refresh session expiry', async () => {
  mocks.getUserInfo.mockResolvedValue(null);
  mocks.signIn.mockRejectedValue(
    new SubscriptionOAuthError(
      'invalid_grant',
      400,
      'synthetic-secret',
      undefined,
      'exchange',
    ),
  );
  const { result, unmount } = renderHook(() => useSubscription());
  await flush();
  expect(result.current.state).toMatchObject({
    status: 'error',
    message: expect.stringContaining('Could not complete authorization'),
  });
  expect(JSON.stringify(result.current.state)).not.toContain(
    'credentials are no longer valid',
  );
  expect(JSON.stringify(result.current.state)).not.toContain(
    'synthetic-secret',
  );
  unmount();
});

it('does not repeat a membership request before Retry-After, then recovers', async () => {
  mocks.getUserInfo
    .mockRejectedValueOnce(
      new SubscriptionOAuthError(
        'rate_limited',
        429,
        undefined,
        60_000,
        'userinfo',
      ),
    )
    .mockResolvedValue({ ...free, member_type: 'plus' });
  const { result, unmount } = renderHook(() => useSubscription());
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  act(() => {
    result.current.checkAgain();
    result.current.checkAgain();
  });
  expect(mocks.getUserInfo).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    result.current.checkAgain();
  });
  expect(result.current.state).toEqual({ status: 'ready', plan: 'Plus' });
  unmount();
});

it('activates a paid account, hides private errors, and permits retry', async () => {
  authorize({ ...free, member_type: 'pro' });
  const onActivate = vi
    .fn()
    .mockRejectedValueOnce(new Error('private-token'))
    .mockResolvedValue(undefined);
  const hook = renderHook(() => useSubscription({ onActivate }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(hook.result.current.state.status).toBe('ready');
  expect(onActivate).toHaveBeenCalledTimes(1);
  expect(hook.result.current.connectionError).toContain('Could not connect');
  expect(hook.result.current.connectionError).not.toContain('private-token');
  await act(async () => {
    await hook.result.current.connect();
  });
  expect(hook.result.current.connectionError).toBeUndefined();
  expect(onActivate).toHaveBeenCalledTimes(2);
  hook.unmount();
});

it('retains backend activation errors and observes Retry-After in the CLI', async () => {
  authorize({ ...free, member_type: 'pro' });
  const onActivate = vi
    .fn()
    .mockRejectedValue(
      new SubscriptionOAuthError(
        'rate_limited',
        429,
        'Please wait before trying again.',
        30_000,
      ),
    );
  const hook = renderHook(() => useSubscription({ onActivate }));
  await flush();
  expect(hook.result.current.connectionError).toBe(
    'Please wait before trying again.',
  );
  await act(async () => {
    await hook.result.current.connect();
  });
  expect(onActivate).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
    await hook.result.current.connect();
  });
  expect(onActivate).toHaveBeenCalledTimes(2);
  hook.unmount();
});

it('leaves CLI readiness on activation refresh expiry without implicitly signing in', async () => {
  authorize({ ...free, member_type: 'pro' });
  const onActivate = vi
    .fn()
    .mockRejectedValue(
      new SubscriptionOAuthError(
        'invalid_grant',
        400,
        undefined,
        undefined,
        'refresh',
      ),
    );
  const hook = renderHook(() => useSubscription({ onActivate }));
  await flush();
  expect(hook.result.current.state).toMatchObject({
    status: 'error',
    message: expect.stringContaining('credentials are no longer valid'),
  });
  expect(mocks.signIn).toHaveBeenCalledOnce();
  hook.unmount();
});

it.each(['plus', 'pro', 'PLUS', 'Pro', 'pLuS'] as const)(
  'automatically activates newly authorized %s membership once',
  async (member_type) => {
    authorize({ ...free, member_type });
    const onActivate = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(() => useSubscription({ onActivate }));
    await flush();
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      'https://pre-chat.qwen.ai/authorize?user_code=ABCD-EFGH&client=qwen-code',
    );
    hook.rerender();
    await flush();
    expect(onActivate).toHaveBeenCalledTimes(1);
    hook.unmount();
  },
);

it('automatically activates after purchase polling confirms membership', async () => {
  mocks.getUserInfo.mockResolvedValue({ ...free, member_type: 'pro' });
  const onActivate = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(() => useSubscription({ onActivate }));
  await flush();
  expect(onActivate).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(onActivate).toHaveBeenCalledTimes(1);
  hook.unmount();
});

it('automatically activates a newly authorized paid account', async () => {
  mocks.signIn.mockImplementation(async (onDevice) => {
    onDevice(device);
    return { ...free, member_type: 'pro' };
  });
  const onActivate = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(() => useSubscription({ onActivate }));
  await flush();
  expect(mocks.signIn).toHaveBeenCalledOnce();
  expect(onActivate).toHaveBeenCalledWith(
    expect.any(AbortSignal),
    'https://pre-chat.qwen.ai/authorize?user_code=ABCD-EFGH&client=qwen-code',
  );
  expect(onActivate).toHaveBeenCalledOnce();
  expect(mocks.browser.mock.calls.map(([url]) => url)).toEqual([
    'https://pre-chat.qwen.ai/authorize?user_code=ABCD-EFGH&client=qwen-code',
  ]);
  hook.unmount();
});

it('automatically activates after a failed initial membership query is retried', async () => {
  mocks.signIn.mockImplementationOnce(async (onDevice) => {
    onDevice(device);
    throw queryFailure();
  });
  mocks.getUserInfo.mockResolvedValue({ ...free, member_type: 'plus' });
  const onActivate = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(() => useSubscription({ onActivate }));
  await flush();
  expect(hook.result.current.state.status).toBe('query-error');
  expect(onActivate).not.toHaveBeenCalled();
  await act(async () => {
    hook.result.current.checkAgain();
    await Promise.resolve();
  });
  expect(onActivate).toHaveBeenCalledOnce();
  expect(onActivate).toHaveBeenCalledWith(
    expect.any(AbortSignal),
    'https://pre-chat.qwen.ai/authorize?user_code=ABCD-EFGH&client=qwen-code',
  );
  expect(hook.result.current.connectionError).toBeUndefined();
  hook.unmount();
});

it('automatically activates when manual purchase recovery confirms Pro', async () => {
  mocks.getUserInfo
    .mockRejectedValueOnce(queryFailure())
    .mockResolvedValue({ ...free, member_type: 'pro' });
  const onActivate = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(() => useSubscription({ onActivate }));
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(hook.result.current.canCheckAgain).toBe(true);
  expect(onActivate).not.toHaveBeenCalled();
  await act(async () => {
    hook.result.current.checkAgain();
    await Promise.resolve();
  });
  expect(onActivate).toHaveBeenCalledOnce();
  hook.unmount();
});

it('reads the latest activation callback without retrying automatically on rerenders', async () => {
  let confirm!: (info: typeof free) => void;
  mocks.signIn.mockReturnValue(
    new Promise((resolve) => {
      confirm = resolve;
    }),
  );
  const first = vi.fn().mockResolvedValue(undefined);
  const latest = vi.fn().mockRejectedValue(new Error('private failure'));
  const retry = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(({ onActivate }) => useSubscription({ onActivate }), {
    initialProps: { onActivate: first },
  });
  hook.rerender({ onActivate: latest });
  await act(async () => confirm({ ...free, member_type: 'pro' }));
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledOnce();
  expect(hook.result.current.connectionError).toContain('Could not connect');
  hook.rerender({ onActivate: retry });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(retry).not.toHaveBeenCalled();
  await act(async () => {
    await hook.result.current.connect();
  });
  expect(retry).toHaveBeenCalledOnce();
  hook.unmount();
});

it.each(['cancel', 'unmount'] as const)(
  'stops pending activation on %s and suppresses a late success',
  async (action) => {
    authorize({ ...free, member_type: 'pro' });
    let finish!: () => void;
    let signal!: AbortSignal;
    const completed = vi.fn();
    const onActivate = vi.fn(async (owner: AbortSignal) => {
      signal = owner;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      owner.throwIfAborted();
      completed();
    });
    const hook = renderHook(() => useSubscription({ onActivate }));
    await flush();
    expect(hook.result.current.connecting).toBe(true);
    act(() => {
      if (action === 'cancel') hook.result.current.cancel();
      else hook.unmount();
    });
    expect(signal.aborted).toBe(true);
    await act(async () => finish());
    expect(completed).not.toHaveBeenCalled();
    expect(hook.result.current.connectionError).toBeUndefined();
    if (action === 'cancel') hook.unmount();
  },
);

it('does not activate a new lifetime from the previous paid confirmation', async () => {
  authorize({ ...free, member_type: 'pro' });
  let confirm!: (info: typeof free) => void;
  const onActivate = vi.fn().mockRejectedValue(new Error('offline'));
  const hook = renderHook(
    ({ suppressBrowserLaunch }) =>
      useSubscription({ suppressBrowserLaunch, onActivate }),
    { initialProps: { suppressBrowserLaunch: false } },
  );
  await flush();
  expect(onActivate).toHaveBeenCalledOnce();
  mocks.signIn.mockReturnValue(
    new Promise((resolve) => {
      confirm = resolve;
    }),
  );
  hook.rerender({ suppressBrowserLaunch: true });
  await flush();
  expect(hook.result.current.state.status).toBe('waiting');
  expect(onActivate).toHaveBeenCalledOnce();
  await act(async () => confirm({ ...free, member_type: 'pro' }));
  expect(onActivate).toHaveBeenCalledTimes(2);
  hook.unmount();
});

it('does not let an old activation release a new lifetime membership-query guard', async () => {
  let finishOldActivation!: () => void;
  let confirmNewMembership!: (info: typeof free) => void;
  mocks.signIn
    .mockResolvedValueOnce({ ...free, member_type: 'pro' })
    .mockRejectedValueOnce(queryFailure());
  mocks.getUserInfo.mockReturnValueOnce(
    new Promise((resolve) => {
      confirmNewMembership = resolve;
    }),
  );
  const onActivate = vi
    .fn()
    .mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishOldActivation = resolve;
      }),
    )
    .mockResolvedValue(undefined);
  const hook = renderHook(
    ({ suppressBrowserLaunch }) =>
      useSubscription({ suppressBrowserLaunch, onActivate }),
    { initialProps: { suppressBrowserLaunch: false } },
  );
  await flush();
  expect(onActivate).toHaveBeenCalledOnce();
  hook.rerender({ suppressBrowserLaunch: true });
  await flush();
  expect(hook.result.current.state.status).toBe('query-error');
  act(() => hook.result.current.checkAgain());
  expect(mocks.getUserInfo).toHaveBeenCalledTimes(1);
  await act(async () => finishOldActivation());
  act(() => hook.result.current.checkAgain());
  expect(mocks.getUserInfo).toHaveBeenCalledTimes(1);
  expect(hook.result.current.checking).toBe(true);
  await act(async () => confirmNewMembership({ ...free, member_type: 'pro' }));
  expect(onActivate).toHaveBeenCalledTimes(2);
  hook.unmount();
});

it('does not let an old membership query release a new lifetime query guard', async () => {
  let confirmOld!: (info: typeof free) => void;
  let confirmNew!: (info: typeof free) => void;
  mocks.signIn.mockRejectedValue(queryFailure());
  mocks.getUserInfo
    .mockReturnValueOnce(
      new Promise((resolve) => {
        confirmOld = resolve;
      }),
    )
    .mockReturnValueOnce(
      new Promise((resolve) => {
        confirmNew = resolve;
      }),
    );
  const hook = renderHook(
    ({ suppressBrowserLaunch }) => useSubscription({ suppressBrowserLaunch }),
    { initialProps: { suppressBrowserLaunch: false } },
  );
  await flush();
  act(() => hook.result.current.checkAgain());
  hook.rerender({ suppressBrowserLaunch: true });
  await flush();
  act(() => hook.result.current.checkAgain());
  expect(mocks.getUserInfo).toHaveBeenCalledTimes(2);
  await act(async () => confirmOld({ ...free, member_type: 'pro' }));
  act(() => hook.result.current.checkAgain());
  expect(mocks.getUserInfo).toHaveBeenCalledTimes(2);
  await act(async () => confirmNew({ ...free, member_type: 'pro' }));
  expect(hook.result.current.state.status).toBe('ready');
  hook.unmount();
});
