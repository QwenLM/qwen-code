/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Command } from '@commander-js/extra-typings';

import {
  AuthType,
  QODER_ACCOUNT_REGIONS,
  QWEN_SUBSCRIPTION_PROVIDER_ID,
  QwenSubscriptionSession,
  createQoderClient,
  runLogger,
  type QoderAccountRegion,
  type QoderClient,
} from '@qwen-code/core';
import type { AppPlugin } from '../app-plugins/types.js';
import type { CommandContext, SlashCommand } from '../ui/commands/types.js';
import { CommandKind } from '../ui/commands/types.js';
import { createLocalCommandResultItem } from '../ui/utils/localCommandResult.js';
import { SettingScope } from '../config/settings.js';
import { requestAuthGate } from '../ui/auth/authFlow.js';

export interface AuthPluginDeps {
  readonly createClient?: (region: QoderAccountRegion) => QoderClient;
  readonly createSubscriptionSession?: () => Pick<
    QwenSubscriptionSession,
    'signOut'
  >;
}

/** `/auth` and `/logout` for the accounts. */
export class AuthPlugin implements AppPlugin {
  readonly apiVersion = 1 as const;
  readonly id = 'qoder-auth';

  constructor(private readonly deps: AuthPluginDeps = {}) {}

  async initialize() {}

  async dispose() {}

  getSlashCommands(): readonly SlashCommand[] {
    return [
      createLoginCommand(this.deps),
      createLogoutCommand(this.deps),
    ];
  }

  getTerminalCommands(): readonly Command[] {
    return [];
  }
}

function createLoginCommand(_deps: AuthPluginDeps): SlashCommand {
  return {
    name: 'auth',
    altNames: ['connect', 'login'],
    description: 'Connect an LLM provider',
    kind: CommandKind.BUILT_IN,
    autoExecute: true,
    action: async () => {
      requestAuthGate('login');
      return undefined;
    },
  };
}

function createLogoutCommand(deps: AuthPluginDeps): SlashCommand {
  return {
    name: 'logout',
    altNames: ['signout'],
    description: 'Sign out of Qoder or your Qwen account',
    kind: CommandKind.BUILT_IN,
    action: async (context) => {
      const selectedType =
        context.services.settings.merged.security?.auth?.selectedType;
      if (
        selectedType !== AuthType.QODER_OAUTH &&
        selectedType !== AuthType.QWEN_SUBSCRIPTION
      ) {
        addInfo(
          context,
          'This connection does not require /logout. Use /auth to switch model providers.',
        );
        return undefined;
      }
      const signedOutOfSubscription =
        selectedType === AuthType.QWEN_SUBSCRIPTION
          ? await logoutSubscription(context, deps)
          : false;
      if (selectedType === AuthType.QODER_OAUTH) {
        for (const region of QODER_ACCOUNT_REGIONS) {
          try {
            await resolveClient(deps, region).api.auth.logout();
          } catch (error) {
            runLogger.warn(
              `[auth] Qoder logout failed region=${region}`,
              error,
            );
          }
        }
      }
      context.services.settings.setValue(
        SettingScope.User,
        'security.auth.selectedType',
        undefined,
      );
      const config = context.services.agentContext?.config;
      if (signedOutOfSubscription) {
        await config
          ?.reloadModelConfigFromDisk?.()
          .catch(() => undefined);
      }
      const manager = config?.getModelProviderManager?.();
      const models = await manager
        ?.listModels({ skipCache: true })
        .catch(() => undefined);
      requestAuthGate('refresh');
      addInfo(
        context,
        signedOutOfSubscription
          ? 'Signed out of Qwen.'
          : 'Signed out of Qoder.',
      );
      const currentModel = config?.getModel?.();
      if (
        models !== undefined &&
        models.length > 0 &&
        currentModel &&
        !models.some((model) => model.key === currentModel)
      ) {
        addInfo(
          context,
          `Current model "${currentModel}" is no longer available after signing out. Run /model to choose another model, or /auth to sign in again.`,
        );
      }
      return undefined;
    },
  };
}

/**
 * Qwen membership logout: only the active subscription connection is touched.
 * Credentials are removed so the account's models stop being listed; the
 * current model selection is left untouched, matching Qwen Code.
 */
async function logoutSubscription(
  context: CommandContext,
  deps: AuthPluginDeps,
): Promise<boolean> {
  const settings = context.services.settings;
  if (
    settings.merged.security?.auth?.selectedType !==
    AuthType.QWEN_SUBSCRIPTION
  ) {
    return false;
  }
  const session =
    deps.createSubscriptionSession?.() ?? new QwenSubscriptionSession();
  await session.signOut().catch((error: unknown) => {
    runLogger.warn(
      `[qwen-subscription] sign-out failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  settings.setValue(
    SettingScope.User,
    ['providers', QWEN_SUBSCRIPTION_PROVIDER_ID],
    undefined,
  );
  return true;
}

function resolveClient(
  deps: AuthPluginDeps,
  region: QoderAccountRegion,
): QoderClient {
  return deps.createClient?.(region) ?? createQoderClient({ region });
}

function addInfo(context: CommandContext, text: string): void {
  context.ui.addItem(createLocalCommandResultItem(text), Date.now());
}

