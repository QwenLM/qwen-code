/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import type { ProviderModelConfig , type Config  } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import { applyProviderInstallPlan } from '../../auth/install/applyProviderInstallPlan.js';
import {
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  getDefaultModelIds,
  resolveBaseUrl,
  resolveMetadataKey,
  resolveOwnsModel,
  type ProviderConfig,
} from '../../auth/providerConfig.js';
import { ALL_PROVIDERS } from '../../auth/allProviders.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ModelUpdateDiff {
  added: string[];
  removed: string[];
  currentModelAffected: boolean;
  fallbackModel?: string;
}

export type UpdateChoice = 'update' | 'later' | 'skip';

export interface ProviderUpdateRequest {
  providerLabel: string;
  diff: ModelUpdateDiff;
  onConfirm: (choice: UpdateChoice) => void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ProviderMetadata {
  version?: string;
  baseUrl?: string;
  ignoredVersion?: string;
}

function getProviderMetadata(
  settings: LoadedSettings,
  metadataKey: string,
): ProviderMetadata {
  const mergedSettings = settings.merged as Record<string, unknown>;
  const metadata = mergedSettings[metadataKey];
  return metadata && typeof metadata === 'object'
    ? (metadata as ProviderMetadata)
    : {};
}

function computeModelDiff(
  existingModelIds: string[],
  newModelIds: string[],
  currentModel: string,
): ModelUpdateDiff {
  const existingSet = new Set(existingModelIds);
  const newSet = new Set(newModelIds);

  const added = newModelIds.filter((id) => !existingSet.has(id));
  const removed = existingModelIds.filter((id) => !newSet.has(id));
  const currentModelAffected = removed.includes(currentModel);
  const fallbackModel = currentModelAffected ? newModelIds[0] : undefined;

  return { added, removed, currentModelAffected, fallbackModel };
}

interface PendingUpdate {
  provider: ProviderConfig;
  metadataKey: string;
  baseUrl: string;
  currentVersion: string;
  diff: ModelUpdateDiff;
}

function getInstalledOwnedModelIds(
  settings: LoadedSettings,
  provider: ProviderConfig,
): string[] {
  const protocol = provider.protocol;
  if (!protocol) return [];
  const mergedSettings = settings.merged as Record<string, unknown>;
  const modelProviders = mergedSettings['modelProviders'] as
    | Record<string, ProviderModelConfig[]>
    | undefined;
  if (!modelProviders) return [];
  const allModels: ProviderModelConfig[] = modelProviders[protocol] ?? [];
  const ownsFn = resolveOwnsModel(provider);
  if (!ownsFn) return allModels.map((m) => m.id);
  return allModels.filter(ownsFn).map((m) => m.id);
}

function findPendingUpdate(
  settings: LoadedSettings,
  currentModel: string,
): PendingUpdate | undefined {
  for (const provider of ALL_PROVIDERS) {
    const metadataKey = resolveMetadataKey(provider);
    if (!metadataKey) continue;

    const metadata = getProviderMetadata(settings, metadataKey);
    if (!metadata.version) continue;

    const baseUrl = metadata.baseUrl || resolveBaseUrl(provider);
    const currentTemplate = buildProviderTemplate(provider, baseUrl);
    const currentVersion = computeModelListVersion(currentTemplate);

    if (metadata.version === currentVersion) continue;
    if (metadata.ignoredVersion === currentVersion) continue;

    const existingModelIds = getInstalledOwnedModelIds(settings, provider);
    const newModelIds = provider.models!.map((s) => s.id);
    const diff = computeModelDiff(existingModelIds, newModelIds, currentModel);

    return { provider, metadataKey, baseUrl, currentVersion, diff };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook for detecting and handling provider model template updates.
 * Checks ALL providers with static model lists for version changes.
 */
export function useProviderUpdates(
  settings: LoadedSettings,
  config: Config,
  addItem: (
    item: { type: 'info' | 'error' | 'warning'; text: string },
    timestamp: number,
  ) => void,
) {
  const [updateRequest, setUpdateRequest] = useState<
    ProviderUpdateRequest | undefined
  >();

  const executeUpdate = useCallback(
    async (providerCfg: ProviderConfig, baseUrl?: string) => {
      try {
        const resolved = resolveBaseUrl(providerCfg, baseUrl);
        const installPlan = buildInstallPlan(providerCfg, {
          baseUrl: resolved,
          apiKey: '',
          modelIds: getDefaultModelIds(providerCfg),
        });
        // Template update only — preserve existing credentials and model selection
        delete installPlan.env;
        const previousModel = config.getModel();
        const newConfigs = installPlan.modelProviders?.[0]?.models ?? [];
        const previousModelStillAvailable = newConfigs.some(
          (cfg) => cfg.id === previousModel,
        );
        if (previousModelStillAvailable) {
          delete installPlan.modelSelection;
        }

        await applyProviderInstallPlan(installPlan, { settings, config });

        const activeModel = config.getModel();
        const displayName = t(providerCfg.label);

        if (previousModelStillAvailable && activeModel === previousModel) {
          addItem(
            {
              type: 'info',
              text: t('{{plan}} configuration updated successfully.', {
                plan: displayName,
              }),
            },
            Date.now(),
          );
        } else {
          addItem(
            {
              type: 'info',
              text: t(
                '{{plan}} configuration updated successfully. Model switched to "{{model}}".',
                { plan: displayName, model: activeModel },
              ),
            },
            Date.now(),
          );
        }

        addItem(
          {
            type: 'info',
            text: t(
              'Tip: Use /model to switch between available {{plan}} models.',
              { plan: displayName },
            ),
          },
          Date.now(),
        );

        return true;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        addItem(
          {
            type: 'error',
            text: t('Failed to update provider configuration: {{message}}', {
              message: errorMessage,
            }),
          },
          Date.now(),
        );
        return false;
      }
    },
    [settings, config, addItem],
  );

  const checkForUpdates = useCallback(() => {
    const currentModel = config.getModel();
    const pending = findPendingUpdate(settings, currentModel);

    if (!pending) return;

    const { provider, metadataKey, baseUrl, currentVersion, diff } = pending;
    const displayName = t(provider.label);

    setUpdateRequest({
      providerLabel: displayName,
      diff,
      onConfirm: async (choice: UpdateChoice) => {
        setUpdateRequest(undefined);
        if (choice === 'update') {
          await executeUpdate(provider, baseUrl);
        } else if (choice === 'skip') {
          const persistScope = getPersistScopeForModelSelection(settings);
          settings.setValue(
            persistScope,
            `${metadataKey}.ignoredVersion`,
            currentVersion,
          );
        }
      },
    });
  }, [settings, config, executeUpdate]);

  useEffect(() => {
    checkForUpdates();
  }, [checkForUpdates]);

  const dismissProviderUpdate = useCallback(() => {
    setUpdateRequest(undefined);
  }, []);

  return {
    providerUpdateRequest: updateRequest,
    dismissProviderUpdate,
  };
}
