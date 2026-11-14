/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { SubscriptionOAuthError } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { modelCommand } from './modelCommand.js';

describe('model picker independence from subscription authentication', () => {
  it.each([
    [null, ''],
    [AuthType.QWEN_SUBSCRIPTION, ''],
    [AuthType.QWEN_SUBSCRIPTION, '--project'],
    [AuthType.QWEN_SUBSCRIPTION, '--global'],
  ] as const)(
    'opens the picker without requiring old subscription credentials: %s %s',
    async (activeAuthType, args) => {
      const refreshSubscriptionModels = vi
        .fn()
        .mockRejectedValue(new SubscriptionOAuthError('session_changed'));
      const context = createMockCommandContext({
        services: {
          config: {
            getContentGeneratorConfig: vi
              .fn()
              .mockReturnValue(
                activeAuthType ? { authType: activeAuthType } : null,
              ),
            refreshSubscriptionModels,
          },
          settings: {
            merged: {
              security: {
                auth: { selectedType: AuthType.QWEN_SUBSCRIPTION },
              },
            },
          },
        },
      });

      expect(await modelCommand.action!(context, args)).toMatchObject({
        type: 'dialog',
        dialog: 'model',
      });
      expect(context.ui.addItem).not.toHaveBeenCalled();
      expect(refreshSubscriptionModels).not.toHaveBeenCalled();
    },
  );

  it.each(['acp', 'non_interactive'] as const)(
    'reads the current model in %s without requiring valid subscription credentials',
    async (executionMode) => {
      const refreshSubscriptionModels = vi
        .fn()
        .mockRejectedValue(new SubscriptionOAuthError('session_changed'));
      const context = createMockCommandContext({
        executionMode,
        services: {
          config: {
            getContentGeneratorConfig: vi
              .fn()
              .mockReturnValue({ authType: AuthType.QWEN_SUBSCRIPTION }),
            getModel: vi.fn().mockReturnValue('expired-subscription'),
            refreshSubscriptionModels,
          },
        },
      });

      expect(await modelCommand.action!(context, '')).toMatchObject({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('expired-subscription'),
      });
      expect(refreshSubscriptionModels).not.toHaveBeenCalled();
    },
  );

  it('switches to another provider without authenticating the old subscription', async () => {
    const refreshSubscriptionModels = vi
      .fn()
      .mockRejectedValue(new SubscriptionOAuthError('session_changed'));
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const context = createMockCommandContext({
      services: {
        config: {
          getContentGeneratorConfig: vi
            .fn()
            .mockReturnValue({ authType: AuthType.QWEN_SUBSCRIPTION }),
          getAvailableModelsForAuthType: vi
            .fn()
            .mockReturnValue([
              { id: 'fallback', authType: AuthType.USE_OPENAI },
            ]),
          refreshSubscriptionModels,
          switchModel,
        },
        settings: { user: { settings: {} }, workspace: { settings: {} } },
      },
    });

    expect(
      await modelCommand.action!(context, 'fallback(openai)'),
    ).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: 'Model: fallback',
    });
    expect(switchModel).toHaveBeenCalledWith(AuthType.USE_OPENAI, 'fallback', {
      initializeIfNeeded: true,
    });
    expect(refreshSubscriptionModels).not.toHaveBeenCalled();
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it('rejects an explicit model that violates the auth policy', async () => {
    const switchModel = vi.fn();
    const context = createMockCommandContext({
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue(undefined),
          switchModel,
        },
        settings: {
          merged: {
            security: { auth: { enforcedType: AuthType.QWEN_SUBSCRIPTION } },
          },
        },
      },
    });

    expect(await modelCommand.action!(context, 'fallback(openai)')).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Authentication is restricted by policy.',
    });
    expect(switchModel).not.toHaveBeenCalled();
  });

  it.each([AuthType.QWEN_SUBSCRIPTION, AuthType.USE_OPENAI])(
    'reports invalid credentials for an explicitly selected subscription from %s',
    async (currentAuthType) => {
      const refreshSubscriptionModels = vi
        .fn()
        .mockRejectedValue(new SubscriptionOAuthError('session_changed'));
      const switchModel = vi.fn();
      const context = createMockCommandContext({
        services: {
          config: {
            getContentGeneratorConfig: vi
              .fn()
              .mockReturnValue({ authType: currentAuthType }),
            refreshSubscriptionModels,
            switchModel,
          },
        },
      });

      expect(
        await modelCommand.action!(context, 'target(qwen-subscription)'),
      ).toMatchObject({
        type: 'message',
        messageType: 'error',
        content:
          'Your login credentials are no longer valid. Run /auth to sign in again.',
      });
      expect(refreshSubscriptionModels).toHaveBeenCalledOnce();
      expect(switchModel).not.toHaveBeenCalled();
    },
  );

  it('switches away from a removed subscription model without warning about the old model', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const context = createMockCommandContext({
      services: {
        config: {
          getContentGeneratorConfig: vi
            .fn()
            .mockReturnValue({ authType: AuthType.QWEN_SUBSCRIPTION }),
          getModel: vi.fn().mockReturnValue('removed'),
          refreshSubscriptionModels: vi.fn().mockResolvedValue({
            models: ['replacement'],
            cached: false,
          }),
          getAvailableModelsForAuthType: vi
            .fn()
            .mockReturnValue([
              { id: 'replacement', authType: AuthType.QWEN_SUBSCRIPTION },
            ]),
          switchModel,
        },
        settings: { user: { settings: {} }, workspace: { settings: {} } },
      },
    });

    expect(await modelCommand.action!(context, 'replacement')).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: 'Model: replacement',
    });
    expect(switchModel).toHaveBeenCalledWith(
      AuthType.QWEN_SUBSCRIPTION,
      'replacement',
      { initializeIfNeeded: true },
    );
    expect(context.ui.addItem).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: 'Loading models from provider…' }),
      expect.any(Number),
    );
  });
});
