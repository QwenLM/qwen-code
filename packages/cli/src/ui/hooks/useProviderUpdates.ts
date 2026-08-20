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
  ProviderSettingsAdapter,
} from '@qwen-code/qwen-code-core';
import {
  ALL_PROVIDERS,
  applyProviderInstallPlan,
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  getDefaultModelIds,
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
import type {
  UiProviderTransaction,
  UiProviderTransactionContext,
} from './use-ui-provider-transaction.js';

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

interface ProviderUpdateSuccess {
  provider: ProviderConfig;
  previousModel: string;
  activeModel: string;
}

type ProviderUpdateResult =
  | ProviderUpdateSuccess
  | { error: unknown }
  | undefined;

function readInstalledOwnedIds(
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
  return ownsFn
    ? allModels.filter(ownsFn).map((m) => m.id)
    : allModels.map((m) => m.id);
}

function getInstalledOwnedModelIds(
  settings: LoadedSettings,
  provider: ProviderConfig,
): string[] {
  // Only compare built-in model IDs — user-added custom models should not
  // appear as "removed" in the diff since they were never part of the
  // provider's built-in list.
  const builtinIds = new Set(getDefaultModelIds(provider));
  return readInstalledOwnedIds(settings, provider).filter((id) =>
    builtinIds.has(id),
  );
}

function findAllPendingUpdates(
  settings: LoadedSettings,
  currentModel: string,
): PendingUpdate[] {
  const results: PendingUpdate[] = [];
  for (const provider of ALL_PROVIDERS) {
    const metadataKey = resolveMetadataKey(provider);
    if (!metadataKey) continue;

    const metadata = getProviderMetadata(settings, metadataKey);
    if (!metadata.version) continue;

    const baseUrl = metadata.baseUrl || resolveBaseUrl(provider);
    const currentVersion = computeModelListVersion(
      buildProviderTemplate(provider, baseUrl),
    );

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

    const existingModelIds = getInstalledOwnedModelIds(settings, provider);
    const newModelIds = provider.models!.map((s) => s.id);
    const diff = computeModelDiff(existingModelIds, newModelIds, currentModel);

    results.push({ provider, metadataKey, baseUrl, currentVersion, diff });
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
  runUiProviderTransaction?: UiProviderTransaction['run'],
) {
  const [updateRequest, setUpdateRequest] = useState<
    ProviderUpdateRequest | undefined
  >();
  const migrated = useRef(false);

  const runProviderUpdateTransaction = useCallback(
    async (
      operation: (context: UiProviderTransactionContext) => Promise<void>,
    ): Promise<void | undefined> => {
      if (runUiProviderTransaction) {
        return runUiProviderTransaction(operation);
      }
      return operation({
        signal: new AbortController().signal,
        canPublish: () => true,
        ownsRollback: () => true,
      });
    },
    [runUiProviderTransaction],
  );

  const executeUpdate = useCallback(
    async (
      pending: PendingUpdate,
      transaction: UiProviderTransactionContext,
      settingsAdapter: ProviderSettingsAdapter,
    ): Promise<ProviderUpdateResult> => {
      if (!transaction.canPublish()) return undefined;

      try {
        const providerCfg = pending.provider;
        const resolved = resolveBaseUrl(providerCfg, pending.baseUrl);
        // An update only refreshes built-in models — user-added custom IDs
        // must be carried through so they are not deleted by the
        // prepend-and-remove-owned merge.
        const defaultIds = getDefaultModelIds(providerCfg);
        const customIds = readInstalledOwnedIds(settings, providerCfg).filter(
          (id) => !defaultIds.includes(id),
        );
        const installPlan = buildInstallPlan(providerCfg, {
          baseUrl: resolved,
          apiKey: '',
          modelIds: [...defaultIds, ...customIds],
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
          providerMatchesCredentials(
            providerCfg,
            activeConfig.baseUrl,
            activeConfig.apiKeyEnvKey,
          );
        const previousRuntime = {
          authType: config.getAuthType(),
          modelId:
            config.getActiveRuntimeModelSnapshot()?.id ?? config.getModel(),
          baseUrl: config.getCurrentModelRegistryBaseUrl(),
        };

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
          signal: transaction.signal,
          isCurrentTransaction: transaction.ownsRollback,
          reloadModelProviders: (mp) => config.reloadModelProvidersConfig(mp),
          syncAuthState: (authType, modelId, baseUrl) =>
            config
              .getModelsConfig()
              .syncAfterAuthRefresh(authType, modelId, baseUrl),
          rollbackRuntime: () => {
            if (previousRuntime.authType === undefined) {
              config.resetAuth(previousRuntime.modelId);
              return;
            }
            return config.switchModel(
              previousRuntime.authType,
              previousRuntime.modelId,
              { baseUrl: previousRuntime.baseUrl ?? undefined },
            );
          },
          ...(updatesActiveProvider && {
            refreshAuth: (authType) => {
              if (!transaction.canPublish()) return Promise.resolve();
              return config.refreshAuth(
                authType,
                undefined,
                transaction.canPublish,
              );
            },
          }),
        });

        if (!transaction.canPublish()) return undefined;

        return {
          provider: providerCfg,
          previousModel,
          activeModel: config.getModel(),
        };
      } catch (error) {
        if (!transaction.canPublish()) return undefined;
        return { error };
      }
    },
    [settings, config],
  );

  const publishUpdateSuccess = useCallback(
    ({ provider, previousModel, activeModel }: ProviderUpdateSuccess) => {
      const displayName = t(provider.label);

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
    },
    [addItem],
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
        await runProviderUpdateTransaction(async (transaction) => {
          if (!transaction.canPublish()) return;
          setUpdateRequest(undefined);

          if (choice === 'update') {
            const batchSettingsAdapter = createLoadedSettingsAdapter(settings);
            const batchRuntime = {
              authType: config.getAuthType(),
              modelId:
                config.getActiveRuntimeModelSnapshot()?.id ?? config.getModel(),
              baseUrl: config.getCurrentModelRegistryBaseUrl(),
              modelProviders: structuredClone(
                batchSettingsAdapter.getModelProviders(),
              ),
            };
            const installSettings: ProviderSettingsAdapter = {
              getValue: batchSettingsAdapter.getValue,
              setValue: batchSettingsAdapter.setValue,
              getModelProviders: batchSettingsAdapter.getModelProviders,
              persist: batchSettingsAdapter.persist,
            };
            const successes: ProviderUpdateSuccess[] = [];
            let failure: { error: unknown } | undefined;
            let cancelled = false;
            let committed = false;

            try {
              batchSettingsAdapter.backup?.();
              for (const pending of pendingList) {
                if (!transaction.canPublish()) {
                  cancelled = true;
                  break;
                }
                const result = await executeUpdate(
                  pending,
                  transaction,
                  installSettings,
                );
                if (!result) {
                  cancelled = true;
                  break;
                }
                if ('error' in result) {
                  failure = result;
                  break;
                }
                successes.push(result);
              }

              if (!cancelled && !failure && transaction.canPublish()) {
                committed = true;
                batchSettingsAdapter.cleanupBackup?.();
                for (const success of successes) {
                  if (!transaction.canPublish()) return;
                  publishUpdateSuccess(success);
                }
              }
            } finally {
              if (!committed && transaction.ownsRollback()) {
                batchSettingsAdapter.restore?.();
                config.reloadModelProvidersConfig(batchRuntime.modelProviders);
                if (batchRuntime.authType === undefined) {
                  config.resetAuth(batchRuntime.modelId);
                } else {
                  await config.switchModel(
                    batchRuntime.authType,
                    batchRuntime.modelId,
                    { baseUrl: batchRuntime.baseUrl ?? undefined },
                  );
                }
              }
            }

            if (failure && transaction.canPublish()) {
              addItem(
                {
                  type: 'error',
                  text: t(
                    'Failed to update provider configuration: {{message}}',
                    {
                      message: getErrorMessage(failure.error),
                    },
                  ),
                },
                Date.now(),
              );
            }
            return;
          }

          if (choice === 'skip') {
            const persistScope = getPersistScopeForModelSelection(settings);
            try {
              if (!transaction.canPublish()) return;
              settings.setValues(
                pendingList.map((pending) => ({
                  scope: persistScope,
                  key: `${PROVIDER_METADATA_NS}.${pending.metadataKey}.ignoredVersion`,
                  value: pending.currentVersion,
                })),
              );
            } catch (error) {
              if (!transaction.canPublish()) return;
              addItem(
                {
                  type: 'error',
                  text: t('Failed to save update dismissal: {{message}}', {
                    message: getErrorMessage(error),
                  }),
                },
                Date.now(),
              );
            }
            return;
          }

          // Persist a cooldown so "later" does not re-prompt on every launch.
          // One batched write keeps the version/timestamp pair atomic, so a
          // partial persist cannot invalidate the cooldown guard on next launch.
          const persistScope = getPersistScopeForModelSelection(settings);
          const postponedAt = Date.now();
          try {
            if (!transaction.canPublish()) return;
            settings.setValues(
              pendingList.flatMap((pending) => [
                {
                  scope: persistScope,
                  key: `${PROVIDER_METADATA_NS}.${pending.metadataKey}.postponedVersion`,
                  value: pending.currentVersion,
                },
                {
                  scope: persistScope,
                  key: `${PROVIDER_METADATA_NS}.${pending.metadataKey}.postponedAt`,
                  value: postponedAt,
                },
              ]),
            );
          } catch (error) {
            if (!transaction.canPublish()) return;
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
        });
      },
    });
  }, [
    settings,
    config,
    executeUpdate,
    publishUpdateSuccess,
    addItem,
    runProviderUpdateTransaction,
  ]);

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
