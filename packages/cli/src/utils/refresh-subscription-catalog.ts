/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, AvailableModel } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import type { SubscriptionScene } from '@qwen-code/qwen-code-core/qwen/subscription-models.js';
import { QwenSubscriptionSession } from '@qwen-code/qwen-code-core/qwen/subscription-session.js';
import { SubscriptionOAuthError } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import { subscriptionErrorMessage } from '@qwen-code/qwen-code-core/qwen/subscription-errors.js';
import { SUBSCRIPTION_MODELS_UNAVAILABLE } from '@qwen-code/qwen-code-core/qwen/subscription-models.js';

export function isSubscriptionSceneModel(
  model: AvailableModel,
  scene?: SubscriptionScene,
  config?: Config,
): boolean {
  const discovered = config?.getSubscriptionModelIds?.(scene);
  return (
    model.authType !== AuthType.QWEN_SUBSCRIPTION ||
    ((!discovered || discovered.includes(model.id)) &&
      (scene
        ? model.subscriptionScenes?.includes(scene) === true
        : model.subscriptionChatModel !== false))
  );
}

export async function refreshSubscriptionCatalog(
  config: Config,
  scene: boolean,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!new QwenSubscriptionSession().isSignedIn()) return undefined;
  try {
    if (scene) await config.refreshSubscriptionScenes(signal);
    else await config.refreshSubscriptionModels(signal);
    return undefined;
  } catch (error) {
    signal?.throwIfAborted();
    return error instanceof SubscriptionOAuthError
      ? subscriptionErrorMessage(error)
      : SUBSCRIPTION_MODELS_UNAVAILABLE;
  }
}
