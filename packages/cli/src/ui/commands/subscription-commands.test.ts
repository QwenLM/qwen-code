/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { logoutCommand, upgradeCommand } from './subscription-commands.js';
import { SubscriptionOAuthError } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';

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
      config: { getAuthType: () => 'qwen-subscription', clearAuth: vi.fn() },
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

it('preserves API-key sessions and rejects logout while a response is active', async () => {
  const keyContext = createMockCommandContext({
    services: { config: { getAuthType: () => 'openai' } },
  });
  expect(await logoutCommand.action!(keyContext, '')).toMatchObject({
    messageType: 'info',
  });
  const busy = memberContext();
  busy.ui.isIdleRef.current = false;
  expect(await logoutCommand.action!(busy, '')).toMatchObject({
    messageType: 'warning',
  });
  expect(mocks.signOut).not.toHaveBeenCalled();
  expect(busy.services.config?.clearAuth).not.toHaveBeenCalled();
});

it('opens the existing Qwen Code plans page from /upgrade', async () => {
  const context = createMockCommandContext();
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
    services: { config: { isBrowserLaunchSuppressed: () => true } },
  });
  expect(await upgradeCommand.action!(context, '')).toMatchObject({
    messageType: 'info',
    content: expect.stringContaining('/?memberPlan=qwen_code'),
  });
  expect(mocks.browser).not.toHaveBeenCalled();
  mocks.browser.mockRejectedValue(new Error('private error'));
  expect(
    await upgradeCommand.action!(createMockCommandContext(), ''),
  ).toMatchObject({
    messageType: 'error',
    content:
      'Could not open your browser. Visit https://pre4-chat.qwen.ai/?memberPlan=qwen_code',
  });
});
