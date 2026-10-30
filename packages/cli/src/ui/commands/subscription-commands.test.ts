/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { logoutCommand, upgradeCommand } from './subscription-commands.js';
import { SubscriptionOAuthError } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { setLanguageAsync } from '../../i18n/index.js';

const mocks = vi.hoisted(() => ({ browser: vi.fn(), signOut: vi.fn() }));
vi.mock('@qwen-code/qwen-code-core/qwen/subscription-session.js', () => ({
  QwenSubscriptionSession: class {
    signOut = mocks.signOut;
  },
}));
vi.mock('@qwen-code/qwen-code-core/utils/secure-browser-launcher.js', () => ({
  openBrowserSecurely: mocks.browser,
}));
beforeEach(() => {
  mocks.browser.mockReset().mockResolvedValue(undefined);
  mocks.signOut.mockReset().mockResolvedValue(undefined);
});

function memberContext() {
  return createMockCommandContext({
    services: {
      config: {
        getAuthType: () => 'qwen-subscription',
        clearAuth: vi.fn(),
        isBrowserLaunchSuppressed: () => false,
      },
      settings: {
        forScope: vi.fn(() => ({
          settings: {
            security: { auth: { selectedType: 'qwen-subscription' } },
          },
        })),
        setValue: vi.fn(),
      },
    },
    ui: { isIdleRef: { current: true } },
  });
}

it('signs out and resets the session before opening the authentication picker', async () => {
  const context = memberContext();
  expect(logoutCommand.canCancel).toBe(false);
  expect(await logoutCommand.action!(context, '')).toEqual({
    type: 'dialog',
    dialog: 'auth',
  });
  expect(mocks.signOut).toHaveBeenCalledOnce();
  expect(context.services.config?.clearAuth).toHaveBeenCalledOnce();
  expect(context.services.settings.setValue).toHaveBeenCalledWith(
    'Workspace',
    'security.auth.selectedType',
    undefined,
    undefined,
    { throwOnWriteFailure: true },
  );
  expect(context.ui.addItem).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'info',
      text: expect.stringContaining('Signed out'),
    }),
    expect.any(Number),
  );
});

it('finishes local logout even if remote revocation fails', async () => {
  const context = memberContext();
  mocks.signOut.mockRejectedValue(
    new SubscriptionOAuthError(
      'network_error',
      undefined,
      'private-token',
      undefined,
      'revoke',
    ),
  );
  expect(await logoutCommand.action!(context, '')).toEqual({
    type: 'dialog',
    dialog: 'auth',
  });
  expect(context.services.config?.clearAuth).toHaveBeenCalledOnce();
  expect(context.ui.addItem).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'warning',
      text: 'You are signed out locally, but the remote session could not be revoked.',
    }),
    expect.any(Number),
  );
});

it('does not claim logout or clear the runtime when deleting credentials fails', async () => {
  const context = memberContext();
  mocks.signOut.mockRejectedValue(
    new SubscriptionOAuthError(
      'access_denied',
      undefined,
      'private-token',
      undefined,
      'cleanup',
    ),
  );
  expect(await logoutCommand.action!(context, '')).toMatchObject({
    type: 'message',
    messageType: 'error',
  });
  expect(context.services.config?.clearAuth).not.toHaveBeenCalled();
  expect(context.services.settings.setValue).not.toHaveBeenCalled();
  expect(context.ui.addItem).not.toHaveBeenCalled();
  expect(context.ui.cancelBtw).not.toHaveBeenCalled();
});

it('still clears local runtime if saving the auth selection fails and preserves both warnings', async () => {
  const context = memberContext();
  mocks.signOut.mockRejectedValue(
    new SubscriptionOAuthError(
      'network_error',
      undefined,
      undefined,
      undefined,
      'revoke',
    ),
  );
  vi.mocked(context.services.settings.setValue).mockImplementation(() => {
    throw new Error('private-token');
  });
  expect(await logoutCommand.action!(context, '')).toEqual({
    type: 'dialog',
    dialog: 'auth',
  });
  expect(context.services.config?.clearAuth).toHaveBeenCalledOnce();
  expect(context.ui.cancelBtw).toHaveBeenCalledOnce();
  expect(context.ui.addItem).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'warning',
      text: expect.stringContaining('remote session could not be revoked'),
    }),
    expect.any(Number),
  );
  expect(context.ui.addItem).toHaveBeenCalledWith(
    expect.objectContaining({
      text: expect.stringContaining(
        'saved authentication selection could not be cleared',
      ),
    }),
    expect.any(Number),
  );
});

it('rejects logout while a response is active', async () => {
  const busy = memberContext();
  busy.ui.isIdleRef.current = false;
  expect(await logoutCommand.action!(busy, '')).toMatchObject({
    messageType: 'warning',
  });
  expect(mocks.signOut).not.toHaveBeenCalled();
  expect(busy.services.config?.clearAuth).not.toHaveBeenCalled();
});

it('opens the existing Qwen Code plans page from /upgrade', async () => {
  const context = memberContext();
  const result = await upgradeCommand.action!(context, '');
  expect(mocks.browser).toHaveBeenCalledWith(
    'https://pre4-chat.qwen.ai/?memberPlan=qwen_code',
  );
  expect(result).toMatchObject({
    type: 'message',
    messageType: 'info',
    content: expect.stringContaining(
      'https://pre4-chat.qwen.ai/?memberPlan=qwen_code',
    ),
  });
});

it('provides a usable plans URL when browser launch is suppressed or fails', async () => {
  const context = createMockCommandContext({
    services: {
      config: {
        getAuthType: () => AuthType.QWEN_SUBSCRIPTION,
        isBrowserLaunchSuppressed: () => true,
      },
    },
  });
  expect(await upgradeCommand.action!(context, '')).toMatchObject({
    messageType: 'info',
    content: expect.stringContaining('/?memberPlan=qwen_code'),
  });
  expect(mocks.browser).not.toHaveBeenCalled();
  mocks.browser.mockRejectedValue(new Error('private error'));
  expect(await upgradeCommand.action!(memberContext(), '')).toMatchObject({
    messageType: 'error',
    content:
      'Could not open your browser. Visit https://pre4-chat.qwen.ai/?memberPlan=qwen_code',
  });
});

it.each([
  undefined,
  AuthType.USE_OPENAI,
  AuthType.USE_OPENAI_RESPONSES,
  AuthType.USE_ANTHROPIC,
  AuthType.USE_GEMINI,
  AuthType.USE_VERTEX_AI,
  AuthType.QWEN_OAUTH,
])(
  'only explains subscription commands for a %s connection without side effects',
  async (authType) => {
    const context = memberContext();
    vi.spyOn(context.services.config!, 'getAuthType').mockReturnValue(authType);

    expect(await logoutCommand.action!(context, '')).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'This connection does not require /logout. Use /auth to switch model providers.',
    });
    expect(await upgradeCommand.action!(context, '')).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'This command is only available with Qwen Subscription login. Use /auth to sign in to Qwen Subscription.',
    });
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.browser).not.toHaveBeenCalled();
    expect(context.services.config?.clearAuth).not.toHaveBeenCalled();
    expect(context.services.settings.setValue).not.toHaveBeenCalled();
    expect(context.ui.cancelBtw).not.toHaveBeenCalled();
  },
);

it('uses the approved Chinese messages for a non-subscription connection', async () => {
  await setLanguageAsync('zh');
  try {
    const context = createMockCommandContext({
      services: { config: { getAuthType: () => AuthType.USE_OPENAI } },
    });
    expect(await logoutCommand.action!(context, '')).toMatchObject({
      content:
        '当前连接无需通过 /logout 退出。如需切换模型服务，请使用 /auth。',
    });
    expect(await upgradeCommand.action!(context, '')).toMatchObject({
      content:
        '此命令仅适用于 Qwen 订阅登录。如需使用 Qwen 订阅，请通过 /auth 登录。',
    });
  } finally {
    await setLanguageAsync('en');
  }
});
