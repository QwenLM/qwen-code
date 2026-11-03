// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DaemonSubscriptionFlow } from '@qwen-code/sdk/daemon';
import { QwenSubscriptionPanel } from './QwenSubscriptionPanel';

const user = {
  sub: 'one',
  name: 'Test',
  email: 'real@example.test',
  member_type: 'free',
};
const ready: DaemonSubscriptionFlow = {
  id: 'flow-one',
  status: 'ready',
  userInfo: user,
};
const authorizationUrl =
  'https://pre4-chat.qwen.ai/authorize?user_code=TEST-CODE&client=qwen-code';
const transport = {
  getSubscriptionConfig: vi.fn(),
  startSubscriptionLogin: vi.fn(),
  getSubscriptionLogin: vi.fn(),
  cancelSubscriptionLogin: vi.fn(),
  getSubscriptionUserInfo: vi.fn(),
  signOutSubscription: vi.fn(),
};
let root: Root | undefined;
let container: HTMLDivElement;
let open: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  transport.getSubscriptionConfig.mockResolvedValue({
    enabled: true,
    plansUrl: 'https://pre4-chat.qwen.ai/?memberPlan=qwen_code',
  });
  transport.startSubscriptionLogin.mockResolvedValue(ready);
  transport.getSubscriptionUserInfo.mockResolvedValue(user);
  transport.cancelSubscriptionLogin.mockResolvedValue(undefined);
  transport.signOutSubscription.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  open = vi.fn();
  close = vi.fn();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.useRealTimers();
});
async function render(
  activation?: {
    onActivate: (signal: AbortSignal) => Promise<string | void>;
    onActivated: () => void;
  },
  activeTransport = transport,
  presentation: {
    dialog?: boolean;
    desktopSuccess?: boolean;
    onAuthError?: (message: string) => void;
    onModelsUnavailable?: () => void;
    onSignedOut?: () => void;
  } = {},
) {
  await act(async () => {
    root!.render(
      <QwenSubscriptionPanel
        transport={activeTransport}
        {...activation}
        {...presentation}
        onOpenExternal={open}
        onClose={close}
        onOtherProviders={vi.fn()}
        language="en"
      />,
    );
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(label),
  );
  expect(button, `Missing ${label}`).toBeDefined();
  await act(async () => {
    button!.click();
  });
}
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it('starts authorization directly after the native picker selection and opens the actual link once', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'flow-one',
    status: 'waiting',
    authorizationUrl,
  });
  transport.getSubscriptionLogin
    .mockResolvedValueOnce({
      id: 'flow-one',
      status: 'waiting',
      authorizationUrl,
    })
    .mockResolvedValue(ready);
  await render();
  expect(container.textContent).not.toContain('Qwen Account with Subscription');
  expect(transport.startSubscriptionLogin).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('Waiting for sign-in');
  expect(container.textContent).not.toContain('Mock');
  expect(open).toHaveBeenCalledWith(authorizationUrl);
  await tick(2000);
  expect(
    open.mock.calls.filter(([url]) => url === authorizationUrl),
  ).toHaveLength(1);
  expect(container.textContent).toContain(user.email);
  expect(container.textContent).toContain('Free account');
  expect(container.textContent).not.toContain('Retry Connection');
  expect(open.mock.calls.map(([url]) => url)).toEqual([authorizationUrl]);
  await click('View Plans');
  expect(open.mock.calls.map(([url]) => url)).toEqual([
    authorizationUrl,
    'https://pre4-chat.qwen.ai/?memberPlan=qwen_code',
  ]);
});

it.each(
  ['free', 'FREE', 'lite', 'go', 'enterprise', 'VIP'].flatMap((member_type) =>
    [false, true].map((dialog) => ({ member_type, dialog })),
  ),
)(
  'opens plans only on request for saved $member_type membership (dialog=$dialog)',
  async ({ member_type, dialog }) => {
    transport.startSubscriptionLogin.mockResolvedValue({
      ...ready,
      userInfo: { ...user, member_type },
    });
    await render(undefined, transport, { dialog });
    expect(open).not.toHaveBeenCalled();
    expect(
      [...document.querySelectorAll('section button')].map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['View Plans', 'Switch Provider', 'Use another account']);
    await tick(5000);
    expect(transport.getSubscriptionUserInfo).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          'section button[aria-label="View Plans"]',
        )!
        .click();
    });
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenLastCalledWith(
      'https://pre4-chat.qwen.ai/?memberPlan=qwen_code',
    );
  },
);

it('keeps authorization navigation when a failed first membership query is retried', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'flow-one',
    status: 'waiting',
    authorizationUrl,
  });
  transport.getSubscriptionLogin.mockResolvedValue({
    id: 'flow-one',
    status: 'error',
    errorCode: 'network_error',
    errorStage: 'userinfo',
  });
  await render();
  await tick(1000);
  expect(container.textContent).toContain(
    "Couldn't check your subscription status",
  );
  await click('Retry Connection');
  expect(container.textContent).toContain('Free account');
  await tick(5000);
  expect(transport.getSubscriptionUserInfo).toHaveBeenCalledTimes(2);
  expect(open.mock.calls.map(([url]) => url)).toEqual([authorizationUrl]);
});

it.each([false, true])(
  'waits for credential cleanup then opens a fresh authorization once (dialog=%s)',
  async (dialog) => {
    let finish!: () => void;
    transport.signOutSubscription.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const onSignedOut = vi.fn();
    await render(undefined, transport, { dialog, onSignedOut });
    transport.startSubscriptionLogin.mockResolvedValue({
      id: 'flow-two',
      status: 'waiting',
      authorizationUrl,
    });
    transport.getSubscriptionLogin.mockResolvedValue({
      id: 'flow-two',
      status: 'ready',
      userInfo: { ...user, email: 'second@example.test', member_type: 'pro' },
    });
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent === 'Use another account',
    )!;
    expect(button).toBeDefined();
    await act(async () => {
      button.click();
      button.click();
    });
    expect(transport.signOutSubscription).toHaveBeenCalledOnce();
    expect(transport.startSubscriptionLogin).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalledWith(authorizationUrl);
    expect(document.body.textContent).not.toContain('Use another account');
    await tick(10_000);
    expect(transport.getSubscriptionUserInfo).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(transport.startSubscriptionLogin).toHaveBeenCalledTimes(2);
    expect(transport.cancelSubscriptionLogin).toHaveBeenCalledWith('flow-one');
    expect(
      open.mock.calls.filter(([url]) => url === authorizationUrl),
    ).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
    expect(onSignedOut).not.toHaveBeenCalled();
    await tick(1000);
    expect(document.body.textContent).toContain('second@example.test');
    expect(document.body.textContent).toContain(
      'Current plan: Qwen Pro. Qwen Code is ready.',
    );
  },
);

it('ignores a late purchase query after account switching', async () => {
  let completeQuery!: (info: typeof user) => void;
  let querySignal: AbortSignal | undefined;
  transport.getSubscriptionUserInfo.mockImplementation(
    ({ signal }: { signal: AbortSignal }) => {
      querySignal = signal;
      return new Promise((resolve) => {
        completeQuery = resolve;
      });
    },
  );
  await render();
  await tick(5000);
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'flow-two',
    status: 'waiting',
    authorizationUrl,
  });
  transport.getSubscriptionLogin.mockResolvedValue({
    id: 'flow-two',
    status: 'waiting',
    authorizationUrl,
  });
  await click('Use another account');
  expect(querySignal?.aborted).toBe(true);
  await act(async () => completeQuery({ ...user, member_type: 'pro' }));
  expect(container.textContent).toContain('Waiting for sign-in');
  expect(container.textContent).not.toContain(
    'Current plan: Qwen Pro. Qwen Code is ready.',
  );
});

it.each(['unmount', 'transport'] as const)(
  'ignores credential cleanup completion after %s',
  async (change) => {
    let finish!: () => void;
    transport.signOutSubscription.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await click('Use another account');
    const nextTransport = {
      ...transport,
      startSubscriptionLogin: vi.fn().mockResolvedValue({
        ...ready,
        userInfo: { ...user, member_type: 'plus' },
      }),
    };
    if (change === 'unmount') await act(async () => root!.render(null));
    else await render(undefined, nextTransport);
    await act(async () => finish());
    expect(transport.startSubscriptionLogin).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalledWith(authorizationUrl);
    if (change === 'transport') {
      expect(nextTransport.startSubscriptionLogin).toHaveBeenCalledOnce();
      expect(container.textContent).toContain(
        'Current plan: Qwen Plus. Qwen Code is ready.',
      );
    }
  },
);

it.each([false, true])(
  'does not restart authorization after cancelling cleanup without unmount (dialog=%s)',
  async (dialog) => {
    let finish!: () => void;
    transport.signOutSubscription.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await render(undefined, transport, { dialog });
    transport.startSubscriptionLogin.mockResolvedValue({
      id: 'flow-two',
      status: 'waiting',
      authorizationUrl,
    });
    transport.getSubscriptionLogin.mockResolvedValue({
      id: 'flow-two',
      status: 'waiting',
      authorizationUrl,
    });
    const press = async (label: string) => {
      const button = [...document.body.querySelectorAll('button')].find(
        (item) => item.textContent === label,
      );
      expect(button, `Missing ${label}`).toBeDefined();
      await act(async () => button!.click());
    };
    await press('Use another account');
    expect(transport.signOutSubscription).toHaveBeenCalledOnce();
    await press(dialog ? 'previous' : 'Cancel');
    expect(close).toHaveBeenCalledOnce();
    await act(async () => finish());
    await tick(1000);
    expect(transport.startSubscriptionLogin).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalledWith(authorizationUrl);
  },
);

it.each([false, true])(
  'does not restart a queued account switch after cancel (dialog=%s)',
  async (dialog) => {
    let finish!: () => void;
    transport.signOutSubscription.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await render(undefined, transport, { dialog });
    transport.startSubscriptionLogin.mockResolvedValue({
      id: 'flow-two',
      status: 'waiting',
      authorizationUrl,
    });
    const findButton = (label: string) => {
      const button = [...document.body.querySelectorAll('button')].find(
        (item) => item.textContent === label,
      );
      expect(button, `Missing ${label}`).toBeDefined();
      return button!;
    };
    await act(async () => findButton('Use another account').click());
    await act(async () => {
      finish();
      await Promise.resolve();
      await Promise.resolve();
      findButton(dialog ? 'previous' : 'Cancel').click();
    });
    expect(close).toHaveBeenCalledOnce();
    expect(transport.startSubscriptionLogin).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalledWith(authorizationUrl);
  },
);

it.each(['cleanup', 'revoke'] as const)(
  'does not restart authorization on account switch %s failure',
  async (errorStage) => {
    transport.signOutSubscription.mockRejectedValue({
      body: { code: 'credentials_error', errorStage },
    });
    const onSignedOut = vi.fn();
    await render(undefined, transport, { onSignedOut });
    await click('Use another account');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      errorStage === 'cleanup'
        ? 'remove local Qwen credentials'
        : 'signed out locally',
    );
    expect(transport.startSubscriptionLogin).toHaveBeenCalledOnce();
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  },
);

it('notifies final sign-out only after credentials are removed', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    ...ready,
    userInfo: { ...user, member_type: 'pro' },
  });
  const onSignedOut = vi.fn();
  await render(undefined, transport, { onSignedOut });
  await click('Sign out');
  expect(onSignedOut).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(transport.startSubscriptionLogin).toHaveBeenCalledOnce();
});

it('cancels a late start response after the panel was closed and never opens its URL', async () => {
  let finish!: (flow: DaemonSubscriptionFlow) => void;
  transport.startSubscriptionLogin.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await click('Cancel');
  expect(close).toHaveBeenCalledOnce();
  await act(async () => root!.render(null));
  await act(async () => {
    finish({ id: 'late', status: 'waiting', authorizationUrl });
  });
  expect(transport.cancelSubscriptionLogin).toHaveBeenCalledWith('late');
  expect(open).not.toHaveBeenCalled();
});

it('stops purchase polling at 120 seconds and retries once on Retry Connection', async () => {
  await render();
  await tick(120000);
  expect(container.textContent).toContain("Your subscription isn't active yet");
  const calls = transport.getSubscriptionUserInfo.mock.calls.length;
  await tick(10000);
  expect(transport.getSubscriptionUserInfo).toHaveBeenCalledTimes(calls);
  await click('Retry Connection');
  expect(transport.getSubscriptionUserInfo).toHaveBeenCalledTimes(calls + 1);
  expect(container.textContent).toContain('No active Plus or Pro');
});

it('retries membership after a query failure and discovers a paid plan', async () => {
  transport.getSubscriptionUserInfo
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ ...user, member_type: 'pro' });
  await render();
  await tick(5000);
  expect(container.textContent).toContain(
    "Couldn't check your subscription status",
  );
  await click('Retry Connection');
  expect(container.textContent).toContain(
    'Current plan: Qwen Pro. Qwen Code is ready.',
  );
  expect(container.textContent).not.toContain('mock-model');
  expect(container.textContent).toContain('Sign out');
  expect(transport.startSubscriptionLogin).toHaveBeenCalledTimes(1);
});

it('aborts a manual check on unmount without signing out', async () => {
  transport.getSubscriptionUserInfo.mockRejectedValueOnce(new Error('offline'));
  await render();
  await tick(5000);
  let signal: AbortSignal | undefined;
  transport.getSubscriptionUserInfo.mockImplementationOnce(
    (opts: { signal: AbortSignal }) => {
      signal = opts.signal;
      return new Promise((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(signal!.reason), {
          once: true,
        }),
      );
    },
  );
  await click('Retry Connection');
  expect(container.querySelectorAll('button')).toHaveLength(2);
  act(() => {
    root!.unmount();
    root = undefined;
  });
  expect(signal?.aborted).toBe(true);
  expect(transport.signOutSubscription).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('Qwen Account with Subscription');
});

it('does not retry login automatically after denial and hides backend details', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'flow-one',
    status: 'error',
    errorCode: 'access_denied',
  });
  await render();
  expect(container.textContent).toContain(
    'Authorization or access was denied.',
  );
  await tick(10000);
  expect(transport.startSubscriptionLogin).toHaveBeenCalledTimes(1);
  transport.startSubscriptionLogin.mockResolvedValue(ready);
  await click('Retry Connection');
  expect(transport.startSubscriptionLogin).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain('Free account');
});

it('shows session expiration without sending the user to purchase', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'flow-one',
    status: 'error',
    errorCode: 'invalid_grant',
    errorStage: 'refresh',
  });
  await render();
  expect(container.textContent).toContain(
    'Your login credentials are no longer valid',
  );
  expect(open).not.toHaveBeenCalled();
});

it('recognizes refresh expiry in the daemon HTTP error body during membership polling', async () => {
  transport.getSubscriptionUserInfo.mockRejectedValue({
    body: { code: 'invalid_grant', errorStage: 'refresh' },
  });
  await render();
  await tick(5000);
  expect(container.textContent).toContain(
    'Your login credentials are no longer valid',
  );
  expect(container.textContent).not.toContain(
    "Couldn't check your subscription",
  );
  await tick(10000);
  expect(transport.getSubscriptionUserInfo).toHaveBeenCalledTimes(1);
});

it('ignores an old sign-out failure after switching daemon transports', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    ...ready,
    userInfo: { ...user, member_type: 'pro' },
  });
  let rejectSignOut!: (error: Error) => void;
  transport.signOutSubscription.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectSignOut = reject;
    }),
  );
  await render();
  await click('Sign out');
  const nextTransport = {
    ...transport,
    startSubscriptionLogin: vi.fn().mockResolvedValue({
      ...ready,
      userInfo: { ...user, member_type: 'plus' },
    }),
  };
  await act(async () => {
    root!.render(
      <QwenSubscriptionPanel
        transport={nextTransport}
        onOpenExternal={open}
        onClose={close}
        onOtherProviders={vi.fn()}
        language="en"
      />,
    );
  });
  expect(container.textContent).toContain(
    'Current plan: Qwen Plus. Qwen Code is ready.',
  );
  await act(async () => rejectSignOut(new Error('old daemon disconnected')));
  expect(container.textContent).toContain(
    'Current plan: Qwen Plus. Qwen Code is ready.',
  );
  expect(container.textContent).not.toContain('An error occurred');
});

it('unmount aborts polling and cancels only its own flow', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'own',
    status: 'waiting',
    authorizationUrl,
  });
  await render();
  act(() => {
    root!.unmount();
    root = undefined;
  });
  await tick(5000);
  expect(transport.cancelSubscriptionLogin).toHaveBeenCalledWith('own');
  expect(transport.getSubscriptionLogin).not.toHaveBeenCalled();
  expect(transport.signOutSubscription).not.toHaveBeenCalled();
});

it('does not carry an old daemon cooldown into a new transport', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'limited',
    status: 'error',
    errorCode: 'rate_limited',
    errorStage: 'userinfo',
    errorStatus: 429,
    retryAfterMs: 60_000,
  });
  await render();
  const nextTransport = {
    ...transport,
    startSubscriptionLogin: vi.fn().mockResolvedValue({
      id: 'new',
      status: 'error',
      errorCode: 'network_error',
      errorStage: 'userinfo',
    }),
    getSubscriptionUserInfo: vi
      .fn()
      .mockResolvedValue({ ...user, member_type: 'plus' }),
  };
  await act(async () => {
    root!.render(
      <QwenSubscriptionPanel
        transport={nextTransport}
        onOpenExternal={open}
        onClose={close}
        onOtherProviders={vi.fn()}
        language="en"
      />,
    );
  });
  await click('Retry Connection');
  expect(nextTransport.getSubscriptionUserInfo).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain(
    'Current plan: Qwen Plus. Qwen Code is ready.',
  );
});

it('retries a failed first identity query without creating a second authorization flow', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'saved',
    status: 'error',
    errorCode: 'network_error',
    errorStage: 'userinfo',
  });
  transport.getSubscriptionUserInfo.mockResolvedValue({
    ...user,
    member_type: 'plus',
  });
  await render();
  expect(container.textContent).toContain(
    "Couldn't check your subscription status",
  );
  expect(open).not.toHaveBeenCalled();
  await click('Retry Connection');
  expect(transport.getSubscriptionUserInfo).toHaveBeenCalledTimes(1);
  expect(transport.startSubscriptionLogin).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain(
    'Current plan: Qwen Plus. Qwen Code is ready.',
  );
});

it('keeps exchange invalid_grant distinct from session expiry', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'exchange',
    status: 'error',
    errorCode: 'invalid_grant',
    errorStage: 'exchange',
  });
  await render();
  expect(container.textContent).toContain('Could not complete authorization');
  expect(container.textContent).not.toContain(
    'credentials are no longer valid',
  );
  expect(container.textContent).toContain('Retry Connection');
});

it('respects Retry-After before retrying a failed first query and starts waiting after Free is confirmed', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'limited',
    status: 'error',
    errorCode: 'rate_limited',
    errorStage: 'userinfo',
    errorStatus: 429,
    retryAfterMs: 60_000,
  });
  await render();
  await click('Retry Connection');
  expect(transport.getSubscriptionUserInfo).not.toHaveBeenCalled();
  await tick(60_000);
  await click('Retry Connection');
  expect(transport.getSubscriptionUserInfo).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Free account');
  expect(container.textContent).not.toContain('Retry Connection');
  await tick(120_000);
  expect(container.textContent).toContain("Your subscription isn't active yet");
  expect(transport.startSubscriptionLogin).toHaveBeenCalledTimes(1);
});

it.each(['subscription_models_unavailable', 'subscription_model_unavailable'])(
  'returns a real desktop %s activation failure to the composer',
  async (code) => {
    transport.startSubscriptionLogin.mockResolvedValue({
      ...ready,
      userInfo: { ...user, member_type: 'pro' },
    });
    const onModelsUnavailable = vi.fn();
    const onActivated = vi.fn();
    await render(
      {
        onActivate: vi.fn().mockRejectedValue({
          body: { code },
        }),
        onActivated,
      },
      transport,
      { dialog: true, onModelsUnavailable },
    );
    expect(onModelsUnavailable).toHaveBeenCalledOnce();
    expect(onActivated).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('Retry');
  },
);

it('shows the backend model permission message with only retry in the desktop error area', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    ...ready,
    userInfo: { ...user, member_type: 'pro' },
  });
  const onModelsUnavailable = vi.fn();
  const onActivate = vi
    .fn()
    .mockRejectedValueOnce({
      status: 403,
      body: {
        code: 'request_failed',
        errorStatus: 403,
        message: 'Your account cannot access this model catalog.',
      },
    })
    .mockResolvedValue('actual-model');
  await render(
    {
      onActivate,
      onActivated: vi.fn(),
    },
    transport,
    { dialog: true, desktopSuccess: true, onModelsUnavailable },
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    'Your account cannot access this model catalog.',
  );
  expect(onModelsUnavailable).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Try again',
  );
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
    'Sign out',
  );
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
    'Cancel',
  );
  expect(close).not.toHaveBeenCalled();
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => button.textContent === 'Try again')!
      .click();
  });
  expect(onActivate).toHaveBeenCalledTimes(2);
  expect(transport.startSubscriptionLogin).toHaveBeenCalledOnce();
  expect(document.querySelector('[data-subscription-success]')).not.toBeNull();
  expect(transport.signOutSubscription).not.toHaveBeenCalled();
});

it('respects the activation Retry-After before allowing a manual retry', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    ...ready,
    userInfo: { ...user, member_type: 'pro' },
  });
  const onActivate = vi.fn().mockRejectedValue({
    body: { code: 'rate_limited', errorStatus: 429, retryAfterMs: 30_000 },
  });
  await render({ onActivate, onActivated: vi.fn() });
  const retry = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Try again',
  )!;
  expect(container.textContent).toContain('Too many requests');
  expect(retry.disabled).toBe(true);
  await tick(29_000);
  expect(retry.disabled).toBe(true);
  expect(onActivate).toHaveBeenCalledOnce();
  await tick(1000);
  expect(retry.disabled).toBe(false);
  await click('Try again');
  expect(onActivate).toHaveBeenCalledTimes(2);
});

it('leaves the paid ready state after activation discovers expired refresh credentials', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    ...ready,
    userInfo: { ...user, member_type: 'pro' },
  });
  const onActivate = vi.fn().mockRejectedValue({
    body: { code: 'invalid_grant', errorStage: 'refresh', errorStatus: 400 },
  });
  await render({ onActivate, onActivated: vi.fn() }, transport, {
    dialog: true,
  });
  expect(document.body.textContent).toContain(
    'credentials are no longer valid',
  );
  expect(document.body.textContent).not.toContain('Signed in as');
  expect(document.body.textContent).not.toContain('Try again');
  expect(document.body.textContent).toContain('previous');
  expect(transport.startSubscriptionLogin).toHaveBeenCalledOnce();
  await tick(60_000);
  expect(onActivate).toHaveBeenCalledOnce();
});

it.each(['revoke', 'cleanup'] as const)(
  'keeps %s errors visible without offering an authorization retry',
  async (errorStage) => {
    transport.startSubscriptionLogin.mockResolvedValue({
      ...ready,
      userInfo: { ...user, member_type: 'pro' },
    });
    transport.signOutSubscription.mockRejectedValue({
      body: { code: 'credentials_error', errorStage },
    });
    await render();
    await click('Sign out');
    expect(container.textContent).toContain(
      errorStage === 'revoke'
        ? 'signed out locally'
        : 'remove local Qwen credentials',
    );
    expect(container.textContent).not.toContain('Retry Connection');
  },
);

it.each(['plus', 'pro', 'PLUS', 'Pro', 'pLuS'])(
  'automatically activates %s and completes only after activation succeeds',
  async (member_type) => {
    transport.startSubscriptionLogin.mockResolvedValue({
      ...ready,
      userInfo: { ...user, member_type },
    });
    let finish!: () => void;
    const onActivate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onActivated = vi.fn();
    await render({ onActivate, onActivated });
    expect(onActivate).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(onActivate).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Loading models from provider…');
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Connect',
      ),
    ).toBe(false);
    expect(onActivated).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(onActivated).toHaveBeenCalledOnce();
  },
);

it('keeps activation failure visible without looping and retries only on request', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    ...ready,
    userInfo: { ...user, member_type: 'plus' },
  });
  const onActivate = vi
    .fn()
    .mockRejectedValueOnce(new Error('private upstream details'))
    .mockResolvedValue(undefined);
  const onActivated = vi.fn();
  await render({ onActivate, onActivated });
  expect(container.textContent).toContain(
    'Could not connect Qwen Subscription',
  );
  expect(container.textContent).not.toContain('private upstream details');
  expect(onActivated).not.toHaveBeenCalled();
  await tick(10000);
  expect(onActivate).toHaveBeenCalledOnce();
  await click('Try again');
  expect(onActivate).toHaveBeenCalledTimes(2);
  expect(onActivated).toHaveBeenCalledOnce();
});

it('aborts automatic activation on close and ignores late completion', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    ...ready,
    userInfo: { ...user, member_type: 'pro' },
  });
  let finish!: () => void;
  let signal!: AbortSignal;
  const onActivate = vi.fn((activeSignal: AbortSignal) => {
    signal = activeSignal;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const onActivated = vi.fn();
  await render({ onActivate, onActivated });
  await click('Cancel');
  expect(signal.aborted).toBe(true);
  await act(async () => finish());
  expect(onActivated).not.toHaveBeenCalled();
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
  'keeps %s in purchase waiting without activating',
  async (member_type, plan) => {
    transport.startSubscriptionLogin.mockResolvedValue({
      ...ready,
      userInfo: { ...user, member_type },
    });
    const onActivate = vi.fn();
    await render({ onActivate, onActivated: vi.fn() });
    expect(onActivate).not.toHaveBeenCalled();
    expect(container.textContent).toContain('View Plans');
    expect(container.textContent).toContain(`${plan} account`);
  },
);

it('replaces authorization step 2 with a separate purchase dialog without restarting login', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'flow-one',
    status: 'waiting',
    authorizationUrl,
  });
  transport.getSubscriptionLogin.mockResolvedValue(ready);
  await render(undefined, transport, { dialog: true });
  const authorization = document.querySelector('[role="dialog"]');
  expect(authorization?.textContent).toContain('Authorization');
  expect(
    authorization?.querySelector('[aria-current="step"]')?.textContent,
  ).toContain('2');
  await tick(2000);
  const membershipDialog = document.querySelector('[role="dialog"]');
  expect(membershipDialog).not.toBe(authorization);
  expect(membershipDialog?.textContent).toContain('Free account');
  expect(membershipDialog?.querySelector('[aria-current="step"]')).toBeNull();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(transport.startSubscriptionLogin).toHaveBeenCalledOnce();
  expect(transport.cancelSubscriptionLogin).not.toHaveBeenCalled();
});

it('reports authorization failure to the sidebar but retains membership query errors', async () => {
  const onAuthError = vi.fn();
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'failed',
    status: 'error',
    errorCode: 'access_denied',
    errorStage: 'exchange',
  });
  await render(undefined, transport, { onAuthError });
  expect(onAuthError).toHaveBeenCalledOnce();
  expect(onAuthError.mock.calls[0][0]).toContain('denied');
  await act(async () => root!.render(null));
  onAuthError.mockClear();
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'query',
    status: 'error',
    errorCode: 'network_error',
    errorStage: 'userinfo',
  });
  await render(undefined, transport, { onAuthError });
  expect(onAuthError).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Retry Connection');
});

it('automatically activates when purchase polling discovers paid membership', async () => {
  transport.getSubscriptionUserInfo.mockResolvedValue({
    ...user,
    member_type: 'pro',
  });
  const onActivate = vi.fn().mockResolvedValue(undefined);
  const onActivated = vi.fn();
  await render({ onActivate, onActivated });
  expect(onActivate).not.toHaveBeenCalled();
  await tick(5000);
  expect(onActivate).toHaveBeenCalledOnce();
  expect(onActivated).toHaveBeenCalledOnce();
});

it('automatically activates after a failed membership query is retried successfully', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'saved',
    status: 'error',
    errorCode: 'network_error',
    errorStage: 'userinfo',
  });
  transport.getSubscriptionUserInfo.mockResolvedValue({
    ...user,
    member_type: 'plus',
  });
  const onActivate = vi.fn().mockResolvedValue(undefined);
  const onActivated = vi.fn();
  await render({ onActivate, onActivated });
  expect(onActivate).not.toHaveBeenCalled();
  await click('Retry Connection');
  expect(onActivate).toHaveBeenCalledOnce();
  expect(onActivated).toHaveBeenCalledOnce();
  expect(transport.startSubscriptionLogin).toHaveBeenCalledOnce();
});

it('does not activate again when host callbacks change identity', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    ...ready,
    userInfo: { ...user, member_type: 'pro' },
  });
  const onActivate = vi.fn().mockResolvedValue(undefined);
  const onActivated = vi.fn();
  await render({ onActivate: (signal) => onActivate(signal), onActivated });
  await render({
    onActivate: (signal) => onActivate(signal),
    onActivated: () => onActivated(),
  });
  expect(onActivate).toHaveBeenCalledOnce();
  expect(onActivated).toHaveBeenCalledOnce();
});

it.each(['close', 'Escape'])(
  'finishes desktop success once through %s after activation completes',
  async (action) => {
    transport.startSubscriptionLogin.mockResolvedValue({
      ...ready,
      userInfo: { ...user, member_type: 'pro' },
    });
    let finish!: (model: string) => void;
    const onActivate = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const onActivated = vi.fn();
    await render({ onActivate, onActivated }, transport, {
      dialog: true,
      desktopSuccess: true,
    });
    expect(document.querySelector('[data-subscription-success]')).toBeNull();
    const pending = document.querySelector('[role="dialog"]')!;
    expect(pending.textContent).toContain('Loading models from provider');
    expect(pending.textContent).not.toContain('Sign out');
    expect(pending.textContent).not.toContain('Cancel');
    expect(onActivated).not.toHaveBeenCalled();
    await act(async () => finish('actual-model'));
    await tick(0);
    const success = document.querySelector('[data-subscription-success]')!;
    expect(success).not.toBeNull();
    expect(success.textContent).toContain(user.email);
    expect(success.textContent).toContain('Qwen Pro');
    expect(success.textContent).toContain('actual-model');
    expect(success.textContent).not.toContain('Common commands');
    expect(document.body.textContent).not.toContain('Start Using');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(onActivated).not.toHaveBeenCalled();
    const dismiss = () => {
      if (action === 'Escape')
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      else
        [...document.querySelectorAll('[role="dialog"] button')]
          .find(
            (button) =>
              button.textContent === action ||
              button.getAttribute('aria-label') === action,
          )!
          .click();
    };
    await act(async () => {
      dismiss();
      dismiss();
    });
    expect(onActivated).toHaveBeenCalledOnce();
    expect(onActivated).toHaveBeenCalledWith();
    expect(onActivate).toHaveBeenCalledOnce();
    expect(transport.signOutSubscription).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  },
);

it('discards a completed desktop success when its transport changes', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    ...ready,
    userInfo: { ...user, member_type: 'pro' },
  });
  const onActivated = vi.fn();
  await render(
    { onActivate: vi.fn().mockResolvedValue('actual-model'), onActivated },
    transport,
    { dialog: true, desktopSuccess: true },
  );
  expect(document.querySelector('[data-subscription-success]')).not.toBeNull();
  const nextTransport = {
    ...transport,
    startSubscriptionLogin: vi.fn().mockResolvedValue({
      id: 'new-flow',
      status: 'waiting',
      authorizationUrl,
    }),
  };
  await render({ onActivate: vi.fn(), onActivated }, nextTransport, {
    dialog: true,
    desktopSuccess: true,
  });
  expect(document.querySelector('[data-subscription-success]')).toBeNull();
  expect(onActivated).not.toHaveBeenCalled();
  expect(transport.cancelSubscriptionLogin).toHaveBeenCalledWith('flow-one');
});

it('restarts desktop authorization with Retry Connection before Previous and no Next', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'denied',
    status: 'error',
    errorCode: 'access_denied',
    errorStage: 'exchange',
  });
  await render(undefined, transport, { dialog: true });
  const dialog = document.querySelector('[role="dialog"]')!;
  const buttons = [...dialog.querySelectorAll('button')];
  const retry = buttons.find(
    (button) => button.textContent === 'Retry Connection',
  )!;
  const previous = buttons.find((button) => button.textContent === 'previous')!;
  expect(buttons.indexOf(retry)).toBeLessThan(buttons.indexOf(previous));
  expect(buttons.some((button) => button.textContent === 'next')).toBe(false);
  transport.startSubscriptionLogin.mockResolvedValue({
    id: 'retry-auth',
    status: 'waiting',
    authorizationUrl,
  });
  await act(async () => retry.click());
  expect(transport.startSubscriptionLogin).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenCalledWith(authorizationUrl);
  expect(transport.getSubscriptionUserInfo).not.toHaveBeenCalled();
});

it('waits for the new transport to confirm membership and ignores the old activation', async () => {
  transport.startSubscriptionLogin.mockResolvedValue({
    ...ready,
    userInfo: { ...user, member_type: 'pro' },
  });
  let finishOld!: () => void;
  let oldSignal!: AbortSignal;
  const oldActivate = vi.fn((signal: AbortSignal) => {
    oldSignal = signal;
    return new Promise<void>((resolve) => {
      finishOld = resolve;
    });
  });
  const onActivated = vi.fn();
  await render({ onActivate: oldActivate, onActivated });
  let confirmNew!: (flow: DaemonSubscriptionFlow) => void;
  const nextTransport = {
    ...transport,
    startSubscriptionLogin: vi.fn(
      () =>
        new Promise<DaemonSubscriptionFlow>((resolve) => {
          confirmNew = resolve;
        }),
    ),
  };
  const nextActivate = vi.fn().mockResolvedValue(undefined);
  await render({ onActivate: nextActivate, onActivated }, nextTransport);
  expect(oldSignal.aborted).toBe(true);
  expect(nextActivate).not.toHaveBeenCalled();
  await act(async () => finishOld());
  expect(onActivated).not.toHaveBeenCalled();
  await act(async () =>
    confirmNew({ ...ready, userInfo: { ...user, member_type: 'plus' } }),
  );
  expect(nextActivate).toHaveBeenCalledOnce();
  expect(onActivated).toHaveBeenCalledOnce();
});
