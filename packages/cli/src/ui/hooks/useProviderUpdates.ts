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
import { getErrorMessage } from '../../utils/errors.js';

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
  metadataKey: string;
  providerLabel: string;
  endpointLabel?: string;
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
  postponedVersion?: string;
  postponedAt?: number;
}

// "Later" suppresses re-prompting for the same version for this long, so a
// user who defers is not nagged on every launch. A new model-list version
// still re-prompts immediately (postponedVersion no longer matches).
const LATER_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

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
): boolean {
  if (!metadata.version) return false;
  const persistScope = getPersistScopeForModelSelection(settings);
  const writes: Parameters<LoadedSettings['setValues']>[0] = [
    {
      scope: persistScope,
      key: `${PROVIDER_METADATA_NS}.${metadataKey}.version`,
      value: metadata.version,
    },
    {
      scope: persistScope,
      key: `${PROVIDER_METADATA_NS}.${metadataKey}.baseUrl`,
      value: baseUrl,
    },
  ];
  if (metadata.ignoredVersion) {
    writes.push({
      scope: persistScope,
      key: `${PROVIDER_METADATA_NS}.${metadataKey}.ignoredVersion`,
      value: metadata.ignoredVersion,
    });
  }
  if (metadata.postponedVersion && typeof metadata.postponedAt === 'number') {
    writes.push(
      {
        scope: persistScope,
        key: `${PROVIDER_METADATA_NS}.${metadataKey}.postponedVersion`,
        value: metadata.postponedVersion,
      },
      {
        scope: persistScope,
        key: `${PROVIDER_METADATA_NS}.${metadataKey}.postponedAt`,
        value: metadata.postponedAt,
      },
    );
  }
  try {
    settings.setValues(writes);
    return true;
  } catch {
    return false;
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
  activeConfig:
    | {
        authType?: string;
        baseUrl?: string;
        apiKeyEnvKey?: string;
      }
    | undefined,
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
      if (
        !persistEndpointMetadataMigration(
          settings,
          metadataKey,
          option.url,
          migratedMetadata,
        )
      ) {
        return [];
      }
      return [
        {
          metadataKey,
          baseUrl: option.url,
          metadata: migratedMetadata,
        },
      ];
    }
    const configuredEnv = (settings.merged.env ?? {}) as Record<
      string,
      unknown
    >;
    const hasStoredCredential = endpointModels.some(
      (model) =>
        typeof model.envKey === 'string' &&
        typeof configuredEnv[model.envKey] === 'string' &&
        configuredEnv[model.envKey] !== '',
    );
    const isActiveProvider =
      activeConfig?.authType === provider.protocol &&
      normalizeBaseUrlForMatching(activeConfig.baseUrl) ===
        normalizeBaseUrlForMatching(option.url) &&
      providerMatchesCredentials(
        provider,
        activeConfig.baseUrl,
        activeConfig.apiKeyEnvKey,
      );
    if (!legacyMetadata.version && !hasStoredCredential && !isActiveProvider) {
      return [];
    }
    const builtinIds = new Set(getDefaultModelIds(provider, option.url));
    const installedBuiltins = endpointModels.filter((model) =>
      builtinIds.has(model.id),
    );
    const legacySuppression = legacyMetadata.baseUrl
      ? {}
      : {
          ...(legacyMetadata.ignoredVersion
            ? { ignoredVersion: legacyMetadata.ignoredVersion }
            : {}),
          ...(legacyMetadata.postponedVersion
            ? { postponedVersion: legacyMetadata.postponedVersion }
            : {}),
          ...(typeof legacyMetadata.postponedAt === 'number'
            ? { postponedAt: legacyMetadata.postponedAt }
            : {}),
        };
    const inferredMetadata = {
      ...legacySuppression,
      ...endpointMetadata,
      version: computeModelListVersion(installedBuiltins),
    };
    if (
      !persistEndpointMetadataMigration(
        settings,
        metadataKey,
        option.url,
        inferredMetadata,
      )
    ) {
      return [];
    }
    return [{ metadataKey, baseUrl: option.url, metadata: inferredMetadata }];
  });
}

function findAllPendingUpdates(
  settings: LoadedSettings,
  currentModel: string,
  activeConfig:
    | {
        authType?: string;
        baseUrl?: string;
        apiKeyEnvKey?: string;
      }
    | undefined,
): PendingUpdate[] {
  const results: PendingUpdate[] = [];
  for (const provider of ALL_PROVIDERS) {
    for (const { metadataKey, baseUrl, metadata } of resolveUpdateTargets(
      settings,
      provider,
      activeConfig,
    )) {
      const currentTemplate = buildProviderTemplate(provider, baseUrl);
      const currentVersion = computeModelListVersion(currentTemplate);

      if (metadata.version === currentVersion) continue;
      if (metadata.ignoredVersion === currentVersion) continue;

      // A "later" choice suppresses re-prompting for the same version while the
      // cooldown is active. A new version (postponedVersion mismatch) re-prompts.
      // Negative elapsed time (a backward clock jump) is treated as expired so
      // the prompt is not suppressed until the wall clock catches up.
      if (
        metadata.postponedVersion === currentVersion &&
        typeof metadata.postponedAt === 'number' &&
        Date.now() - metadata.postponedAt >= 0 &&
        Date.now() - metadata.postponedAt < LATER_COOLDOWN_MS
      ) {
        continue;
      }

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
    async (pending: PendingUpdate) => {
      try {
        const providerCfg = pending.provider;
        const resolved = resolveBaseUrl(providerCfg, pending.baseUrl);
        // An update only refreshes built-in models — user-added custom IDs
        // must be carried through so they are not deleted by the
        // prepend-and-remove-owned merge.
        const defaultIds = getDefaultModelIds(providerCfg, resolved);
        const builtInIds = new Set(defaultIds);
        const installedOwnedModels = readInstalledModels(settings, providerCfg);
        const customModels = installedOwnedModels
          .filter(
            (model) =>
              !providerCfg.mergeModelsByIdentity ||
              normalizeBaseUrlForMatching(model.baseUrl) ===
                normalizeBaseUrlForMatching(resolved),
          )
          .filter((model) => !builtInIds.has(model.id));
        const installPlan = buildInstallPlan(providerCfg, {
          baseUrl: resolved,
          apiKey: '',
          modelIds: defaultIds,
          prebuiltModels: [
            ...buildProviderTemplate(providerCfg, resolved),
            ...customModels,
          ],
        });
        installPlan.providerState![
          `${PROVIDER_METADATA_NS}.${pending.metadataKey}`
        ]!['version'] = pending.currentVersion;
        delete installPlan.env;
        // Template updates never change the selected model.
        delete installPlan.modelSelection;
        const previousModel = config.getModel();
        const activeConfig = config.getContentGeneratorConfig();
        const updatesActiveProvider =
          activeConfig?.authType === providerCfg.protocol &&
          // A merge provider owns several endpoints under one authType; only
          // the endpoint being updated can be the live session's provider, so
          // a sibling endpoint must not trigger a mid-session re-auth.
          (!providerCfg.mergeModelsByIdentity ||
            !activeConfig?.baseUrl ||
            normalizeBaseUrlForMatching(activeConfig.baseUrl) ===
              normalizeBaseUrlForMatching(resolved)) &&
          providerMatchesCredentials(
            providerCfg,
            activeConfig.baseUrl,
            activeConfig.apiKeyEnvKey,
          );
        const settingsAdapter = createLoadedSettingsAdapter(settings);

        await applyProviderInstallPlan(installPlan, {
          settings: {
            ...settingsAdapter,
            setValue: (key, value) => {
              // Template updates never change the selected auth method.
              if (key !== 'security.auth.selectedType') {
                settingsAdapter.setValue(key, value);
              }
            },
          },
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

        if (activeModel === previousModel) {
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
        addItem(
          {
            type: 'error',
            text: t('Failed to update provider configuration: {{message}}', {
              message: getErrorMessage(error),
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
    const pendingList = findAllPendingUpdates(
      settings,
      currentModel,
      config.getContentGeneratorConfig(),
    );

    if (pendingList.length === 0) return;

    const entries: ProviderUpdateEntry[] = pendingList.map((p) => {
      const endpoint = Array.isArray(p.provider.baseUrl)
        ? p.provider.baseUrl.find(
            (option) =>
              normalizeBaseUrlForMatching(option.url) ===
              normalizeBaseUrlForMatching(p.baseUrl),
          )
        : undefined;
      return {
        metadataKey: p.metadataKey,
        providerLabel: t(p.provider.label),
        ...(endpoint ? { endpointLabel: t(endpoint.label) } : {}),
        diff: p.diff,
      };
    });

    setUpdateRequest({
      entries,
      onConfirm: async (choice: UpdateChoice) => {
        setUpdateRequest(undefined);
        if (choice === 'update') {
          for (const p of pendingList) {
            await executeUpdate(p);
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
        } else if (choice === 'later') {
          // Persist a cooldown so "later" does not re-prompt on every launch.
          // One batched write keeps the version/timestamp pair atomic, so a
          // partial persist cannot invalidate the cooldown guard on next launch.
          const persistScope = getPersistScopeForModelSelection(settings);
          const postponedAt = Date.now();
          try {
            settings.setValues(
              pendingList.flatMap((p) => [
                {
                  scope: persistScope,
                  key: `${PROVIDER_METADATA_NS}.${p.metadataKey}.postponedVersion`,
                  value: p.currentVersion,
                },
                {
                  scope: persistScope,
                  key: `${PROVIDER_METADATA_NS}.${p.metadataKey}.postponedAt`,
                  value: postponedAt,
                },
              ]),
            );
          } catch (error) {
            addItem(
              {
                type: 'error',
                text: t('Failed to save update postponement: {{message}}', {
                  message: getErrorMessage(error),
                }),
              },
              Date.now(),
            );
          }
        }
      },
    });
  }, [settings, config, executeUpdate, addItem]);

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
