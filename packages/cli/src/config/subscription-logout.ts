/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import type { LoadedSettings } from './settings.js';
import type { AvailableModel } from '@qwen-code/qwen-code-core/models/types.js';
import {
  getPersistScopeForModelSelection,
  getWritableScopes,
} from './modelProvidersScope.js';

export async function restoreModelAfterSubscriptionLogout(
  config: Config,
  settings: LoadedSettings,
  persistSelection = true,
): Promise<'clear' | 'save' | undefined> {
  const persistScope = getPersistScopeForModelSelection(settings);
  const restore =
    !config.getAuthType() ||
    config.getAuthType() === AuthType.QWEN_SUBSCRIPTION;
  if (restore) config.clearAuth();
  let warning: 'clear' | 'save' | undefined;
  if (persistSelection) {
    try {
      for (const scope of getWritableScopes(settings)) {
        if (
          settings.forScope(scope).settings.security?.auth?.selectedType !==
          AuthType.QWEN_SUBSCRIPTION
        )
          continue;
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
    } catch {
      warning = 'clear';
    }
  }
  const enforced = settings.merged.security?.auth?.enforcedType;
  let fallback: AvailableModel | undefined;
  for (const model of config.getAllConfiguredModels()) {
    if (!restore) break;
    if (
      model.authType === AuthType.QWEN_SUBSCRIPTION ||
      model.authType === AuthType.QWEN_OAUTH ||
      (enforced && model.authType !== enforced) ||
      model.fastOnly ||
      model.voiceOnly ||
      model.visionOnly ||
      model.imageOnly
    )
      continue;
    try {
      await config.switchModel(model.authType, model.id, {
        baseUrl: model.baseUrl,
      });
    } catch {
      continue;
    }
    fallback = model;
    break;
  }
  if (persistSelection && (fallback || !restore)) {
    const selected = config.getContentGeneratorConfig();
    try {
      for (const [key, value] of [
        [
          'security.auth.selectedType',
          selected?.authType ?? fallback?.authType ?? config.getAuthType(),
        ],
        ['model.name', selected?.model ?? fallback?.id ?? config.getModel()],
        [
          'model.baseUrl',
          selected?.baseUrl ??
            fallback?.baseUrl ??
            config.getCurrentModelRegistryBaseUrl?.() ??
            '',
        ],
      ] as const) {
        settings.setValue(persistScope, key, value, undefined, {
          throwOnWriteFailure: true,
        });
      }
    } catch {
      warning = 'save';
    }
  }
  return warning;
}
