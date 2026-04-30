/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelProvidersConfig } from '@qwen-code/qwen-code-core';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import { backupSettingsFile } from '../../utils/settingsUtils.js';
import type {
  ApplyProviderInstallPlanOptions,
  ApplyProviderInstallPlanResult,
  ProviderInstallPlan,
  ProviderModelProvidersPatch,
} from '../types.js';

function applyModelProvidersPatch(
  existingModelProviders: ModelProvidersConfig,
  patch: ProviderModelProvidersPatch,
  provider: ApplyProviderInstallPlanOptions['provider'],
): ModelProvidersConfig {
  const existingModels = existingModelProviders[patch.authType] ?? [];

  let updatedModels = patch.models;
  if (patch.mergeStrategy === 'append') {
    updatedModels = [...existingModels, ...patch.models];
  } else {
    const ownsModel = patch.ownsModel ?? provider.ownsModel;
    const preservedModels = existingModels.filter((model) => {
      if (ownsModel) {
        return !ownsModel(model);
      }
      return !patch.models.some((newModel) => newModel.id === model.id);
    });

    updatedModels =
      patch.mergeStrategy === 'replace-owned'
        ? [...preservedModels, ...patch.models]
        : [...patch.models, ...preservedModels];
  }

  return {
    ...existingModelProviders,
    [patch.authType]: updatedModels,
  };
}

export async function applyProviderInstallPlan(
  plan: ProviderInstallPlan,
  {
    settings,
    config,
    provider,
    scope,
    refreshAuth = true,
  }: ApplyProviderInstallPlanOptions,
): Promise<ApplyProviderInstallPlanResult> {
  const persistScope = scope ?? getPersistScopeForModelSelection(settings);
  const settingsFile = settings.forScope(persistScope);
  backupSettingsFile(settingsFile.path);

  for (const [key, value] of Object.entries(plan.env ?? {})) {
    settings.setValue(persistScope, `env.${key}`, value);
    process.env[key] = value;
  }

  let updatedModelProviders: ModelProvidersConfig = {
    ...((settings.merged.modelProviders as ModelProvidersConfig | undefined) ??
      {}),
  };

  for (const patch of plan.modelProviders ?? []) {
    updatedModelProviders = applyModelProvidersPatch(
      updatedModelProviders,
      patch,
      provider,
    );
    settings.setValue(
      persistScope,
      `modelProviders.${patch.authType}`,
      updatedModelProviders[patch.authType] ?? [],
    );
  }

  settings.setValue(persistScope, 'security.auth.selectedType', plan.authType);

  if (plan.legacyCredentials?.apiKey != null) {
    settings.setValue(
      persistScope,
      'security.auth.apiKey',
      plan.legacyCredentials.apiKey,
    );
  }

  if (plan.legacyCredentials?.baseUrl != null) {
    settings.setValue(
      persistScope,
      'security.auth.baseUrl',
      plan.legacyCredentials.baseUrl,
    );
  }

  if (plan.modelSelection?.modelId) {
    settings.setValue(persistScope, 'model.name', plan.modelSelection.modelId);
  }

  if (plan.providerState?.codingPlan?.baseUrl != null) {
    settings.setValue(
      persistScope,
      'codingPlan.baseUrl',
      plan.providerState.codingPlan.baseUrl,
    );
  }
  if (plan.providerState?.codingPlan?.version != null) {
    settings.setValue(
      persistScope,
      'codingPlan.version',
      plan.providerState.codingPlan.version,
    );
  }
  if (plan.providerState?.tokenPlan?.baseUrl != null) {
    settings.setValue(
      persistScope,
      'tokenPlan.baseUrl',
      plan.providerState.tokenPlan.baseUrl,
    );
  }
  if (plan.providerState?.tokenPlan?.version != null) {
    settings.setValue(
      persistScope,
      'tokenPlan.version',
      plan.providerState.tokenPlan.version,
    );
  }

  config.reloadModelProvidersConfig(updatedModelProviders);
  if (refreshAuth) {
    await config.refreshAuth(plan.authType);
  }

  return {
    persistScope,
    updatedModelProviders,
  };
}
