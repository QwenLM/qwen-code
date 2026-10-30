/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { applyProviderInstallPlan } from '@qwen-code/qwen-code-core/providers/install.js';
import type { SubscriptionUserInfo } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import { QwenSubscriptionSession } from '@qwen-code/qwen-code-core/qwen/subscription-session.js';
import { QWEN_SUBSCRIPTION_BASE_URL } from '@qwen-code/qwen-code-core/qwen/oauth-config.js';
import { selectSubscriptionModel } from '@qwen-code/qwen-code-core/qwen/subscription-models.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { createLoadedSettingsAdapter } from '../../config/loadedSettingsAdapter.js';

export async function activateSubscription(
  settings: LoadedSettings,
  config: Config,
  signal: AbortSignal,
): Promise<SubscriptionUserInfo> {
  signal.throwIfAborted();
  if (process.env['DEV'] !== 'true') {
    throw new Error('Qwen Subscription is unavailable.');
  }
  if (!settings.isTrusted) {
    throw new Error('Workspace is not trusted.');
  }
  const enforced = settings.merged.security?.auth?.enforcedType;
  if (enforced && enforced !== AuthType.QWEN_SUBSCRIPTION) {
    throw new Error('Authentication is restricted by policy.');
  }
  const info = await new QwenSubscriptionSession().getUserInfo(signal);
  signal.throwIfAborted();
  const plan = info?.member_type.toLowerCase();
  if (!info || (plan !== 'plus' && plan !== 'pro')) {
    throw new Error('An active Qwen Plus or Pro subscription is required.');
  }
  const { models } = await config.refreshSubscriptionModels(signal);
  const selected =
    settings.merged.security?.auth?.selectedType === AuthType.QWEN_SUBSCRIPTION
      ? settings.merged.model?.name
      : undefined;
  const modelId = selectSubscriptionModel(models, selected);
  signal.throwIfAborted();
  // After committing settings, finish the runtime switch even if the dialog closes.
  await applyProviderInstallPlan(
    {
      providerId: 'qwen-subscription',
      authType: AuthType.QWEN_SUBSCRIPTION,
      modelSelection: {
        modelId,
        baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
      },
    },
    {
      settings: createLoadedSettingsAdapter(settings, SettingScope.Workspace),
      syncAuthState: (authType, modelId, baseUrl) => {
        config.syncModelSelection(authType, modelId, baseUrl);
      },
      refreshAuth: (authType) => config.refreshAuth(authType),
    },
  );
  config.setSubscriptionPlan(plan);
  return info;
}
