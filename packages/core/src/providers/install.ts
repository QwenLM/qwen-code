/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AuthType } from '../core/contentGenerator.js';
import type { ModelProvidersConfig } from '../models/types.js';
import type {
  ProviderInstallPlan,
  ProviderModelProvidersPatch,
  ProviderSettingsAdapter,
} from './types.js';

// ---------------------------------------------------------------------------
// Model providers merge logic
// ---------------------------------------------------------------------------

function isSameModelIdentity(
  a: { id: string; baseUrl?: string },
  b: { id: string; baseUrl?: string },
): boolean {
  return a.id === b.id && (a.baseUrl ?? '') === (b.baseUrl ?? '');
}

function applyModelProvidersPatch(
  existingModelProviders: ModelProvidersConfig,
  patch: ProviderModelProvidersPatch,
): ModelProvidersConfig {
  const existingModels = existingModelProviders[patch.authType] ?? [];

  let updatedModels = patch.models;
  if (patch.mergeStrategy === 'append') {
    updatedModels = [...existingModels, ...patch.models];
  } else {
    const ownsModel = patch.ownsModel;
    const preservedModels = existingModels.filter((model) => {
      if (ownsModel) {
        return !ownsModel(model);
      }
      return !patch.models.some((newModel) =>
        isSameModelIdentity(newModel, model),
      );
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

// ---------------------------------------------------------------------------
// Apply install plan
// ---------------------------------------------------------------------------

export interface ApplyProviderInstallPlanOptions {
  settings: ProviderSettingsAdapter;
  /** Callback to reload model providers config in the runtime. */
  reloadModelProviders?: (mp: ModelProvidersConfig) => void;
  /** Callback to sync auth state after install. */
  syncAuthState?: (authType: AuthType, modelId: string) => void;
  /** Callback to refresh auth after install. */
  refreshAuth?: (authType: AuthType) => Promise<void>;
  /** Whether to call refreshAuth after install. Defaults to true. */
  doRefreshAuth?: boolean;
}

export interface ApplyProviderInstallPlanResult {
  updatedModelProviders: ModelProvidersConfig;
}

export async function applyProviderInstallPlan(
  plan: ProviderInstallPlan,
  options: ApplyProviderInstallPlanOptions,
): Promise<ApplyProviderInstallPlanResult> {
  const {
    settings,
    reloadModelProviders,
    syncAuthState,
    refreshAuth,
    doRefreshAuth = true,
  } = options;

  settings.backup?.();
  const previousEnvValues = new Map<string, string | undefined>();

  try {
    // Set environment variables (snapshot previous values for rollback)
    for (const [key, value] of Object.entries(plan.env ?? {})) {
      previousEnvValues.set(key, process.env[key]);
      settings.setValue(`env.${key}`, value);
      process.env[key] = value;
    }

    // Apply model providers patches
    let updatedModelProviders: ModelProvidersConfig = {
      ...settings.getModelProviders(),
    };

    for (const patch of plan.modelProviders ?? []) {
      updatedModelProviders = applyModelProvidersPatch(
        updatedModelProviders,
        patch,
      );
      settings.setValue(
        `modelProviders.${patch.authType}`,
        updatedModelProviders[patch.authType] ?? [],
      );
    }

    // Set auth type
    settings.setValue('security.auth.selectedType', plan.authType);

    // Legacy credentials
    if (plan.legacyCredentials?.apiKey != null) {
      settings.setValue('security.auth.apiKey', plan.legacyCredentials.apiKey);
    }
    if (plan.legacyCredentials?.baseUrl != null) {
      settings.setValue(
        'security.auth.baseUrl',
        plan.legacyCredentials.baseUrl,
      );
    }

    // Model selection
    if (plan.modelSelection?.modelId) {
      settings.setValue('model.name', plan.modelSelection.modelId);
    }

    // Provider state metadata
    for (const [key, entries] of Object.entries(plan.providerState ?? {})) {
      for (const [field, value] of Object.entries(entries)) {
        settings.setValue(`${key}.${field}`, value);
      }
    }

    // Persist to disk
    settings.persist();

    // Reload runtime config
    reloadModelProviders?.(updatedModelProviders);
    if (plan.modelSelection?.modelId) {
      syncAuthState?.(plan.authType, plan.modelSelection.modelId);
    }
    if (doRefreshAuth && refreshAuth) {
      await refreshAuth(plan.authType);
    }

    settings.cleanupBackup?.();

    return { updatedModelProviders };
  } catch (error) {
    settings.restore?.();
    for (const [key, prev] of previousEnvValues) {
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
    throw error;
  }
}
