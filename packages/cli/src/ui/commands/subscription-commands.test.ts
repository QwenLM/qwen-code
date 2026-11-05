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
import type { AvailableModel } from '@qwen-code/qwen-code-core/models/types.js';
import { setLanguageAsync } from '../../i18n/index.js';

const mocks = vi.hoisted(() => ({
  browser: vi.fn(),
  signOut: vi.fn(),
  isSignedIn: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/qwen/subscription-session.js', () => ({
  QwenSubscriptionSession: class {
    signOut = mocks.signOut;
    isSignedIn = mocks.isSignedIn;
  },
}));
vi.mock('@qwen-code/qwen-code-core/utils/secure-browser-launcher.js', () => ({
  openBrowserSecurely: mocks.browser,
}));
beforeEach(() => {
  mocks.isSignedIn.mockReset().mockReturnValue(true);
  mocks.browser.mockReset().mockResolvedValue(undefined);
  mocks.signOut.mockReset().mockResolvedValue(undefined);
});

it.each([logoutCommand, upgradeCommand])(
  'rejects $name after logout while the subscription model remains selected',
  async (command) => {
    mocks.isSignedIn.mockReturnValue(false);
    expect(await command.action!(memberContext(), '')).toMatchObject({
      type: 'message',
      messageType: 'info',
    });
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.browser).not.toHaveBeenCalled();
  },
);

function memberContext() {
  return createMockCommandContext({
    services: {
      config: {
        getAuthType: () => 'qwen-subscription',
        clearAuth: vi.fn(),
        setSubscriptionPlan: vi.fn(),
        getBackgroundTaskRegistry: () => ({ abortAll: vi.fn() }),
        getAllConfiguredModels: vi.fn(() => []),
        switchModel: vi.fn().mockResolvedValue(undefined),
        getContentGeneratorConfig: vi.fn(() => undefined),
        isBrowserLaunchSuppressed: () => false,
      },
      settings: {
        isTrusted: true,
        merged: {},
        user: { settings: {} },
        workspace: {
          settings: {
            security: { auth: { selectedType: AuthType.QWEN_SUBSCRIPTION } },
          },
        },
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

it('signs out without changing the selected provider or model', async () => {
  const context = memberContext();
  expect(await logoutCommand.action!(context, '')).toBeUndefined();
  expect(mocks.signOut).toHaveBeenCalledOnce();
  expect(context.services.config?.clearAuth).not.toHaveBeenCalled();
  expect(context.services.config?.switchModel).not.toHaveBeenCalled();
  expect(context.services.config?.setSubscriptionPlan).toHaveBeenCalledWith(
    undefined,
  );
  expect(context.services.settings.setValue).not.toHaveBeenCalled();
  expect(context.ui.cancelBtw).toHaveBeenCalledOnce();
  expect(context.ui.addItem).not.toHaveBeenCalled();
});

const bailianModel: AvailableModel = {
  id: 'qwen3.6-plus',
  label: 'Bailian',
  authType: AuthType.USE_OPENAI,
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  envKey: 'LOGOUT_TEST_BAILIAN_KEY',
};

it('keeps the subscription model even when another provider is configured', async () => {
  const context = memberContext();
  vi.mocked(context.services.config!.getAllConfiguredModels).mockReturnValue([
    bailianModel,
  ]);
  await logoutCommand.action!(context, '');
  expect(context.services.config!.switchModel).not.toHaveBeenCalled();
  expect(context.services.config!.clearAuth).not.toHaveBeenCalled();
  expect(context.services.settings.setValue).not.toHaveBeenCalled();
});

it('respects an enforced subscription provider without switching to another provider', async () => {
  const context = memberContext();
  context.services.settings.merged.security = {
    auth: { enforcedType: AuthType.QWEN_SUBSCRIPTION },
  };
  vi.mocked(context.services.config!.getAllConfiguredModels).mockReturnValue([
    bailianModel,
  ]);
  expect(await logoutCommand.action!(context, '')).toBeUndefined();
  expect(context.services.config!.switchModel).not.toHaveBeenCalled();
  expect(context.ui.addItem).not.toHaveBeenCalled();
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
  vi.mocked(context.services.config!.getAllConfiguredModels).mockReturnValue([
    bailianModel,
  ]);
  expect(await logoutCommand.action!(context, '')).toBeUndefined();
  expect(context.services.config!.switchModel).not.toHaveBeenCalled();
  expect(context.services.config?.clearAuth).not.toHaveBeenCalled();
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
    'https://chat.qwen.ai/?memberPlan=qwen_code',
  );
  expect(result).toMatchObject({
    type: 'message',
    messageType: 'info',
    content: expect.stringContaining(
      'https://chat.qwen.ai/?memberPlan=qwen_code',
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
      'Could not open your browser. Visit https://chat.qwen.ai/?memberPlan=qwen_code',
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
