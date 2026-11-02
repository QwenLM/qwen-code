/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { getQwenSubscriptionPlansUrl } from '@qwen-code/qwen-code-core/qwen/oauth-config.js';
import { QwenSubscriptionSession } from '@qwen-code/qwen-code-core/qwen/subscription-session.js';
import { SubscriptionOAuthError } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { openBrowserSecurely } from '@qwen-code/qwen-code-core/utils/secure-browser-launcher.js';
import {
  getPersistScopeForModelSelection,
  getWritableScopes,
} from '../../config/modelProvidersScope.js';
import { t } from '../../i18n/index.js';
import { MessageType } from '../types.js';
import { CommandKind, type SlashCommand } from './types.js';

export const logoutCommand: SlashCommand = {
  name: 'logout',
  get description() {
    return t('Sign out of your Qwen account');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'],
  canCancel: false,
  action: async (context) => {
    const { config, settings } = context.services;
    if (config?.getAuthType() !== AuthType.QWEN_SUBSCRIPTION) {
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'This connection does not require /logout. Use /auth to switch model providers.',
        ),
      };
    }
    if (!context.ui.isIdleRef.current) {
      return {
        type: 'message',
        messageType: 'warning',
        content: t(
          'Wait for the current response to finish before signing out.',
        ),
      };
    }
    const persistScope = getPersistScopeForModelSelection(settings);
    let warning: string | undefined;
    try {
      await new QwenSubscriptionSession().signOut();
    } catch (error) {
      if (error instanceof SubscriptionOAuthError && error.stage === 'revoke') {
        warning = t(
          'You are signed out locally, but the remote session could not be revoked.',
        );
      } else {
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            'Could not remove local Qwen credentials. Check local file permissions.',
          ),
        };
      }
    }
    context.ui.cancelBtw();
    config.clearAuth();
    try {
      for (const scope of getWritableScopes(settings)) {
        if (
          settings.forScope(scope).settings.security?.auth?.selectedType ===
          AuthType.QWEN_SUBSCRIPTION
        ) {
          for (const key of [
            'security.auth.selectedType',
            'model.name',
            'model.baseUrl',
          ]) {
            settings.setValue(scope, key, undefined, undefined, {
              throwOnWriteFailure: true,
            });
          }
        }
      }
    } catch {
      warning = [
        warning,
        t(
          'You are signed out, but the saved authentication selection could not be cleared.',
        ),
      ]
        .filter(Boolean)
        .join('\n');
    }
    const enforcedType = settings.merged.security?.auth?.enforcedType;
    for (const model of config.getAllConfiguredModels()) {
      if (
        model.authType === AuthType.QWEN_SUBSCRIPTION ||
        model.authType === AuthType.QWEN_OAUTH ||
        (enforcedType && model.authType !== enforcedType) ||
        model.fastOnly ||
        model.voiceOnly ||
        model.visionOnly ||
        model.imageOnly
      ) {
        continue;
      }
      try {
        await config.switchModel(model.authType, model.id, {
          baseUrl: model.baseUrl,
        });
      } catch {
        continue;
      }
      const selected = config.getContentGeneratorConfig();
      try {
        for (const [key, value] of [
          ['security.auth.selectedType', selected?.authType ?? model.authType],
          ['model.name', selected?.model ?? model.id],
          ['model.baseUrl', selected?.baseUrl ?? model.baseUrl ?? ''],
        ] as const) {
          settings.setValue(persistScope, key, value, undefined, {
            throwOnWriteFailure: true,
          });
        }
      } catch {
        warning = [
          warning,
          t('Model switched, but the selection could not be saved.'),
        ]
          .filter(Boolean)
          .join('\n');
      }
      break;
    }
    if (warning) {
      context.ui.addItem(
        { type: MessageType.WARNING, text: warning },
        Date.now(),
      );
    }
    return;
  },
};

export const upgradeCommand: SlashCommand = {
  name: 'upgrade',
  get description() {
    return t('Open Qwen subscription plans');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'],
  action: async (context) => {
    if (context.services.config?.getAuthType() !== AuthType.QWEN_SUBSCRIPTION) {
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'This command is only available with Qwen Subscription login. Use /auth to sign in to Qwen Subscription.',
        ),
      };
    }
    const url = getQwenSubscriptionPlansUrl();
    if (!context.services.config?.isBrowserLaunchSuppressed()) {
      try {
        await openBrowserSecurely(url);
      } catch {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Could not open your browser. Visit {{url}}', { url }),
        };
      }
    }
    return {
      type: 'message',
      messageType: 'info',
      content: t('Qwen subscription plans: {{url}}', { url }),
    };
  },
};

export function filterSubscriptionCommands(
  commands: readonly SlashCommand[],
  authType: AuthType | undefined,
): readonly SlashCommand[] {
  return authType === AuthType.QWEN_SUBSCRIPTION
    ? commands
    : Object.freeze(
        commands.filter(
          (command) =>
            command.action !== logoutCommand.action &&
            command.action !== upgradeCommand.action,
        ),
      );
}
