/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ProviderModelConfig,
  Config,
  ProviderConfig,
} from '@qwen-code/qwen-code-core';
import {
  ALL_PROVIDERS,
  applyProviderInstallPlan,
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  getDefaultModelIds,
  normalizeBaseUrlForMatching,
  PROVIDER_METADATA_NS,
  providerMatchesCredentials,
  resolveBaseUrl,
  resolveMetadataKey,
  resolveOwnsModel,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import { createLoadedSettingsAdapter } from '../../config/loadedSettingsAdapter.js';
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

export interface ProviderUpdateEntry {
  providerLabel: string;
  diff: ModelUpdateDiff;
}

export interface ProviderUpdateRequest {
  entries: ProviderUpdateEntry[];
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
  const ns = mergedSettings[PROVIDER_METADATA_NS] as
    | Record<string, unknown>
    | undefined;
  if (!ns) return {};
  const metadata = ns[metadataKey];
  return metadata && typeof metadata === 'object'
    ? (metadata as ProviderMetadata)
    : {};
}

// ---------------------------------------------------------------------------
// Migration: move legacy top-level keys into providerMetadata namespace
// ---------------------------------------------------------------------------

const LEGACY_KEY_MAP: Record<string, string> = {
  codingPlan: 'coding-plan',
  tokenPlan: 'token-plan',
};

function migrateProviderMetadata(settings: LoadedSettings): void {
  const mergedSettings = settings.merged as Record<string, unknown>;
  const persistScope = getPersistScopeForModelSelection(settings);
  let migrated = false;

  const migrateKey = (oldKey: string, newKey: string) => {
    const data = mergedSettings[oldKey];
    if (!data || typeof data !== 'object') return;
    const entries = data as Record<string, unknown>;
    for (const [field, value] of Object.entries(entries)) {
      if (value !== undefined) {
        settings.setValue(
          persistScope,
          `${PROVIDER_METADATA_NS}.${newKey}.${field}`,
          value,
        );
      }
    }
    settings.setValue(persistScope, oldKey, undefined);
    migrated = true;
  };

  for (const [oldKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
    migrateKey(oldKey, newKey);
  }

  for (const provider of ALL_PROVIDERS) {
    const key = resolveMetadataKey(provider);
    if (!key) continue;
    if (mergedSettings[key] && typeof mergedSettings[key] === 'object') {
      migrateKey(key, key);
    }
  }

  if (migrated) {
    // eslint-disable-next-line no-console
    console.log(
      '[info] Migrated provider metadata to providerMetadata namespace.',
    );
  }
}

// ---------------------------------------------------------------------------

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

function readInstalledModels(
  settings: LoadedSettings,
  provider: ProviderConfig,
): ProviderModelConfig[] {
  const protocol = provider.protocol;
  if (!protocol) return [];
  const mergedSettings = settings.merged as Record<string, unknown>;
  const modelProviders = mergedSettings['modelProviders'] as
    | Record<string, ProviderModelConfig[]>
    | undefined;
  if (!modelProviders) return [];
  const allModels: ProviderModelConfig[] = modelProviders[protocol] ?? [];
  const ownsFn = resolveOwnsModel(provider);
  return ownsFn ? allModels.filter(ownsFn) : allModels;
}

function modelsAtBaseUrl(
  models: ProviderModelConfig[],
  baseUrl: string,
): ProviderModelConfig[] {
  const normalized = normalizeBaseUrlForMatching(baseUrl);
  return models.filter(
    (model) => normalizeBaseUrlForMatching(model.baseUrl) === normalized,
  );
}

function persistEndpointMetadataMigration(
  settings: LoadedSettings,
  metadataKey: string,
  baseUrl: string,
  metadata: ProviderMetadata,
): void {
  if (!metadata.version) return;
  const persistScope = getPersistScopeForModelSelection(settings);
  settings.setValue(
    persistScope,
    `${PROVIDER_METADATA_NS}.${metadataKey}.version`,
    metadata.version,
  );
  settings.setValue(
    persistScope,
    `${PROVIDER_METADATA_NS}.${metadataKey}.baseUrl`,
    baseUrl,
  );
  if (metadata.ignoredVersion) {
    settings.setValue(
      persistScope,
      `${PROVIDER_METADATA_NS}.${metadataKey}.ignoredVersion`,
      metadata.ignoredVersion,
    );
  }
}

function getInstalledOwnedModelIds(
  settings: LoadedSettings,
  provider: ProviderConfig,
  baseUrl: string,
): string[] {
  // Only compare built-in model IDs — user-added custom models should not
  // appear as "removed" in the diff since they were never part of the
  // provider's built-in list.
  const builtinIds = new Set(getDefaultModelIds(provider, baseUrl));
  return modelsAtBaseUrl(readInstalledModels(settings, provider), baseUrl)
    .map((model) => model.id)
    .filter((id) => builtinIds.has(id));
}

function resolveUpdateTargets(
  settings: LoadedSettings,
  provider: ProviderConfig,
): Array<{
  metadataKey: string;
  baseUrl: string;
  metadata: ProviderMetadata;
}> {
  const legacyKey = resolveMetadataKey(provider);
  if (!legacyKey) return [];
  const legacyMetadata = getProviderMetadata(settings, legacyKey);

  if (!provider.mergeModelsByIdentity || !Array.isArray(provider.baseUrl)) {
    if (!legacyMetadata.version) return [];
    return [
      {
        metadataKey: legacyKey,
        baseUrl: legacyMetadata.baseUrl || resolveBaseUrl(provider),
        metadata: legacyMetadata,
      },
    ];
  }

  const installedModels = readInstalledModels(settings, provider);
  return provider.baseUrl.flatMap((option) => {
    const endpointModels = modelsAtBaseUrl(installedModels, option.url);
    if (endpointModels.length === 0) return [];
    const metadataKey = resolveMetadataKey(provider, option.url);
    if (!metadataKey) return [];
    const endpointMetadata = getProviderMetadata(settings, metadataKey);
    if (endpointMetadata.version) {
      return [{ metadataKey, baseUrl: option.url, metadata: endpointMetadata }];
    }
    if (
      legacyMetadata.version &&
      normalizeBaseUrlForMatching(legacyMetadata.baseUrl) ===
        normalizeBaseUrlForMatching(option.url)
    ) {
      const migratedMetadata = { ...legacyMetadata, ...endpointMetadata };
      persistEndpointMetadataMigration(
        settings,
        metadataKey,
        option.url,
        migratedMetadata,
      );
      return [
        {
          metadataKey,
          baseUrl: option.url,
          metadata: migratedMetadata,
        },
      ];
    }
    const builtinIds = new Set(getDefaultModelIds(provider, option.url));
    const installedBuiltins = endpointModels.filter((model) =>
      builtinIds.has(model.id),
    );
    const inferredMetadata = {
      ...endpointMetadata,
      version: computeModelListVersion(installedBuiltins),
    };
    persistEndpointMetadataMigration(
      settings,
      metadataKey,
      option.url,
      inferredMetadata,
    );
    return [{ metadataKey, baseUrl: option.url, metadata: inferredMetadata }];
  });
}

function findAllPendingUpdates(
  settings: LoadedSettings,
  currentModel: string,
): PendingUpdate[] {
  const results: PendingUpdate[] = [];
  for (const provider of ALL_PROVIDERS) {
    for (const { metadataKey, baseUrl, metadata } of resolveUpdateTargets(
      settings,
      provider,
    )) {
      const currentTemplate = buildProviderTemplate(provider, baseUrl);
      const currentVersion = computeModelListVersion(currentTemplate);

      if (metadata.version === currentVersion) continue;
      if (metadata.ignoredVersion === currentVersion) continue;

      const existingModelIds = getInstalledOwnedModelIds(
        settings,
        provider,
        baseUrl,
      );
      const newModelIds = getDefaultModelIds(provider, baseUrl);
      const diff = computeModelDiff(
        existingModelIds,
        newModelIds,
        currentModel,
      );

      results.push({ provider, metadataKey, baseUrl, currentVersion, diff });
    }
  }
  return results;
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
  const migrated = useRef(false);

  const executeUpdate = useCallback(
    async (providerCfg: ProviderConfig, baseUrl?: string) => {
      try {
        const resolved = resolveBaseUrl(providerCfg, baseUrl);
        // An update only refreshes built-in models — user-added custom IDs
        // must be carried through so they are not deleted by the
        // prepend-and-remove-owned merge.
        const defaultIds = getDefaultModelIds(providerCfg, resolved);
        const builtInIds = new Set(defaultIds);
        const installedOwnedModels = readInstalledModels(settings, providerCfg);
        const customIds = modelsAtBaseUrl(installedOwnedModels, resolved)
          .map((model) => model.id)
          .filter((id) => !builtInIds.has(id));
        const installPlan = buildInstallPlan(providerCfg, {
          baseUrl: resolved,
          apiKey: '',
          modelIds: [...defaultIds, ...customIds],
        });
        delete installPlan.env;
        const previousModel = config.getModel();
        const activeConfig = config.getContentGeneratorConfig();
        const endpointOwnsModel = (model: ProviderModelConfig) =>
          resolveOwnsModel(providerCfg)?.(model) === true &&
          normalizeBaseUrlForMatching(model.baseUrl) ===
            normalizeBaseUrlForMatching(resolved);
        if (providerCfg.mergeModelsByIdentity) {
          const patch = installPlan.modelProviders?.[0];
          if (patch) patch.ownsModel = endpointOwnsModel;
        }
        const newConfigs = installPlan.modelProviders?.[0]?.models ?? [];
        const availableConfigs = providerCfg.mergeModelsByIdentity
          ? [
              ...newConfigs,
              ...((
                (settings.merged as Record<string, unknown>)[
                  'modelProviders'
                ] as Record<string, ProviderModelConfig[]> | undefined
              )?.[providerCfg.protocol]?.filter(
                (model) => !endpointOwnsModel(model),
              ) ?? []),
            ]
          : newConfigs;
        const previousModelStillAvailable = availableConfigs.some(
          (cfg) =>
            cfg.id === previousModel &&
            (!activeConfig?.baseUrl ||
              normalizeBaseUrlForMatching(cfg.baseUrl) ===
                normalizeBaseUrlForMatching(activeConfig.baseUrl)),
        );
        if (previousModelStillAvailable) {
          delete installPlan.modelSelection;
        }
        const updatesActiveProvider =
          activeConfig?.authType === providerCfg.protocol &&
          providerMatchesCredentials(
            providerCfg,
            activeConfig.baseUrl,
            activeConfig.apiKeyEnvKey,
          );

        await applyProviderInstallPlan(installPlan, {
          settings: createLoadedSettingsAdapter(settings),
          reloadModelProviders: (mp) => config.reloadModelProvidersConfig(mp),
          syncAuthState: (authType, modelId, baseUrl) =>
            config
              .getModelsConfig()
              .syncAfterAuthRefresh(authType, modelId, baseUrl),
          ...(updatesActiveProvider && {
            refreshAuth: (authType) => config.refreshAuth(authType),
          }),
        });

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
    if (!migrated.current) {
      migrated.current = true;
      migrateProviderMetadata(settings);
    }

    const currentModel = config.getModel();
    const pendingList = findAllPendingUpdates(settings, currentModel);

    if (pendingList.length === 0) return;

    const entries: ProviderUpdateEntry[] = pendingList.map((p) => ({
      providerLabel: t(p.provider.label),
      diff: p.diff,
    }));

    setUpdateRequest({
      entries,
      onConfirm: async (choice: UpdateChoice) => {
        setUpdateRequest(undefined);
        if (choice === 'update') {
          for (const p of pendingList) {
            await executeUpdate(p.provider, p.baseUrl);
          }
        } else if (choice === 'skip') {
          const persistScope = getPersistScopeForModelSelection(settings);
          for (const p of pendingList) {
            settings.setValue(
              persistScope,
              `${PROVIDER_METADATA_NS}.${p.metadataKey}.ignoredVersion`,
              p.currentVersion,
            );
          }
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
