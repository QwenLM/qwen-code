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
  getModelsForProviderProtocol,
  buildProviderTemplate,
  computeModelListVersion,
  discoverProviderModels,
  getDefaultModelIds,
  PROVIDER_METADATA_NS,
  providerMatchesCredentials,
  resolveBaseUrl,
  resolveMetadataKey,
  tryResolveModelProtocol,
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
}

export type UpdateChoice = 'update' | 'later' | 'skip';

export interface ProviderUpdateEntry {
  providerLabel: string;
  diff: ModelUpdateDiff;
}

export interface ProviderUpdateRequest {
  /** Distinct per prompt, so the dialog remounts with a fresh selection. */
  id: number;
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
  /** Built-in model ids served to the key when the provider was last checked. */
  servedModels?: string[];
  /** Unserved built-ins retained to protect the selected model. */
  retainedModels?: string[];
  /** Served model ids whose re-check prompt was answered with "Later". */
  postponedServedModels?: string[];
}

// "Later" suppresses re-prompting for the same version for this long, so a
// user who defers is not nagged on every launch. A new model-list version
// still re-prompts immediately (postponedVersion no longer matches).
const LATER_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h
// Persist tombstones so lower-scope postponements cannot reappear on reload.
const CLEARED_POSTPONEMENT = {
  postponedVersion: '',
  postponedServedModels: [] as string[],
  postponedAt: undefined,
};

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

  return { added, removed, currentModelAffected };
}

interface PendingUpdate {
  provider: ProviderConfig;
  metadataKey: string;
  baseUrl: string;
  currentVersion: string;
  /**
   * The stored version already matches the preset. Such an install is only
   * re-checked for a change in the models served to its key.
   */
  upToDate: boolean;
  /** Served model ids recorded by the last check. */
  storedServedModels?: string[];
  storedRetainedModels?: string[];
  /** Served model ids postponed by "Later", set only while the cooldown runs. */
  postponedServedModels?: string[];
  existingModelIds: string[];
  diff: ModelUpdateDiff;
  /** Key for `/models`, set only for providers that support discovery. */
  discoveryApiKey?: string;
  /**
   * Built-in model ids to install, when discovery narrowed the list. The
   * prompt's diff is computed from the same list. Unset means every built-in.
   */
  installModelIds?: string[];
  /** Sorted built-in model ids served to the key, when narrowed. */
  servedModels?: string[];
  retainedModels?: string[];
}

function resolveDiscoveryApiKey(provider: ProviderConfig): string | undefined {
  // Owned models always carry the provider's envKey, so the stored key is
  // read from that variable.
  if (!provider.supportsModelDiscovery || typeof provider.envKey !== 'string') {
    return undefined;
  }
  return process.env[provider.envKey]?.trim() || undefined;
}

function readModelIdList(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.every((id): id is string => typeof id === 'string')
    ? value
    : undefined;
}

function sameModelIds(a: readonly string[], b: readonly string[] | undefined) {
  return (
    b !== undefined && a.length === b.length && a.every((id, i) => id === b[i])
  );
}

function isCooldownActive(postponedAt: unknown): boolean {
  // Negative elapsed time (a backward clock jump) is treated as expired so
  // the prompt is not suppressed until the wall clock catches up.
  if (typeof postponedAt !== 'number') return false;
  const elapsed = Date.now() - postponedAt;
  return elapsed >= 0 && elapsed < LATER_COOLDOWN_MS;
}

function readInstalledOwnedModels(
  settings: LoadedSettings,
  provider: ProviderConfig,
): ProviderModelConfig[] {
  if (!provider.protocol) return [];
  const ownsModel = resolveOwnsModel(provider);
  return getModelsForProviderProtocol(
    settings.merged.modelProviders,
    provider.protocol,
    settings.merged.providerProtocol,
  ).filter((model) => !ownsModel || ownsModel(model));
}

function getInstalledOwnedModelIds(
  settings: LoadedSettings,
  provider: ProviderConfig,
): string[] {
  // Only compare built-in model IDs — user-added custom models should not
  // appear as "removed" in the diff since they were never part of the
  // provider's built-in list. Uses the same reader as the update itself, so
  // a built-in stored on the Responses wire counts as installed.
  const builtinIds = new Set(getDefaultModelIds(provider));
  return [
    ...new Set(
      readInstalledOwnedModels(settings, provider)
        .map((model) => model.id)
        .filter((id) => builtinIds.has(id)),
    ),
  ];
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
    const discoveryApiKey = resolveDiscoveryApiKey(provider);

    // An up-to-date install is still re-checked when the provider supports
    // discovery: the models served to the key can change without a preset
    // change (a different key, plan or entitlement).
    const upToDate = metadata.version === currentVersion;
    if (upToDate && !discoveryApiKey) continue;
    if (!upToDate && metadata.ignoredVersion === currentVersion) continue;

    // A "later" choice suppresses re-prompting for the same version while the
    // cooldown is active. A new version (postponedVersion mismatch) re-prompts.
    // An up-to-date install is postponed per served-model set instead, which
    // is only known after discovery.
    const cooldownActive = isCooldownActive(metadata.postponedAt);
    if (
      !upToDate &&
      cooldownActive &&
      metadata.postponedVersion === currentVersion
    ) {
      continue;
    }
    const storedServedModels = readModelIdList(metadata.servedModels);
    const postponedServedModels = cooldownActive
      ? readModelIdList(metadata.postponedServedModels)
      : undefined;

    const existingModelIds = getInstalledOwnedModelIds(settings, provider);
    const newModelIds = provider.models!.map((s) => s.id);
    const diff = computeModelDiff(existingModelIds, newModelIds, currentModel);

    results.push({
      provider,
      metadataKey,
      baseUrl,
      currentVersion,
      upToDate,
      ...(storedServedModels ? { storedServedModels } : {}),
      storedRetainedModels: readModelIdList(metadata.retainedModels),
      ...(postponedServedModels ? { postponedServedModels } : {}),
      existingModelIds,
      diff,
      ...(discoveryApiKey ? { discoveryApiKey } : {}),
    });
  }
  return results;
}

/**
 * Narrow a pending update to the built-in models served to the stored key,
 * the same filter the setup wizard applies at install time. Without it, an
 * update would install every built-in model, including ones the key's plan
 * or region rejects (403/404). Falls back to the full built-in list when
 * discovery fails or matches no built-in model.
 */
async function narrowToServedModels(
  pending: PendingUpdate,
  getCurrentModel: () => string,
  signal: AbortSignal,
): Promise<PendingUpdate> {
  if (!pending.discoveryApiKey) return pending;
  const builtInModels = pending.provider.models ?? [];
  const discovered = await discoverProviderModels({
    baseUrl: resolveBaseUrl(pending.provider, pending.baseUrl),
    apiKey: pending.discoveryApiKey,
    staticModels: builtInModels,
    signal,
  });
  if (!discovered) return pending;
  const servedIds = new Set(discovered.map((model) => model.id));
  const builtInIds = builtInModels.map((model) => model.id);
  const servedBuiltInIds = builtInIds.filter((id) => servedIds.has(id));
  if (servedBuiltInIds.length === 0) return pending;
  // Read the selection after the request: the user can switch models while
  // it is in flight. Discovery alone never removes the selected model, so
  // one incomplete listing cannot drop the model in use. The preset can
  // still remove it.
  const currentModel = getCurrentModel();
  const existingIds = new Set(pending.existingModelIds);
  const keepsCurrentModel = existingIds.has(currentModel);
  // An up-to-date install keeps the user's own selection: it only adds
  // models that became served since the last check. Without a recorded
  // check nothing is added, so a model left out in /auth is not offered.
  const storedServed = new Set(pending.storedServedModels ?? servedBuiltInIds);
  const offers = (id: string) =>
    !pending.upToDate || existingIds.has(id) || !storedServed.has(id);
  const installModelIds = builtInIds.filter(
    (id) =>
      (servedIds.has(id) && offers(id)) ||
      (keepsCurrentModel && id === currentModel),
  );
  // An empty install is not supported. Keep the provider unchanged until a
  // later check offers at least one built-in, rather than prompting a failure.
  if (installModelIds.length === 0) return pending;
  const retainedModels = installModelIds.filter((id) => !servedIds.has(id));
  return {
    ...pending,
    installModelIds,
    servedModels: [...servedBuiltInIds].sort(),
    retainedModels: retainedModels.length ? retainedModels.sort() : undefined,
    diff: computeModelDiff(
      pending.existingModelIds,
      installModelIds,
      currentModel,
    ),
  };
}

/**
 * Whether installing a narrowed update would change nothing for the key.
 * For an up-to-date install that means no model added or removed. For a new
 * preset version it also needs every installed model to match its template,
 * which happens when the version only touches models the key is not served.
 */
function isNarrowedUpdateNoop(
  settings: LoadedSettings,
  pending: PendingUpdate,
): boolean {
  const { installModelIds, diff } = pending;
  if (!installModelIds || diff.added.length || diff.removed.length) {
    return false;
  }
  if (pending.upToDate) return true;
  const installed = readInstalledOwnedModels(settings, pending.provider);
  const ids = new Set(installModelIds);
  return buildProviderTemplate(pending.provider, pending.baseUrl)
    .filter((model) => ids.has(model.id))
    .every((template) => {
      const model = installed.find((m) => m.id === template.id);
      if (!model) return false;
      // Owned models of discovery providers always carry the provider's
      // envKey, so every template field, envKey included, is compared.
      return Object.entries(template).every(
        ([key, value]) =>
          JSON.stringify(model[key as keyof ProviderModelConfig]) ===
          JSON.stringify(value),
      );
    });
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
  // Prompts waiting for the one on screen to close. Providers with model
  // discovery prompt after their `/models` request, which can resolve while
  // another provider's prompt is still open.
  const promptQueue = useRef<PendingUpdate[][]>([]);
  const promptOpen = useRef(false);
  const promptCount = useRef(0);

  const executeUpdate = useCallback(
    async (pending: PendingUpdate) => {
      try {
        const providerCfg = pending.provider;
        const resolved = resolveBaseUrl(providerCfg, pending.baseUrl);
        const builtInIds = getDefaultModelIds(providerCfg);
        // Re-check the selection at confirm time as well, so a narrowed
        // update never removes the model in use.
        const liveModel = config.getModel();
        const installIds = pending.installModelIds;
        const defaultIds = !installIds
          ? builtInIds
          : installIds.includes(liveModel) ||
              !pending.existingModelIds.includes(liveModel)
            ? installIds
            : builtInIds.filter(
                (id) => installIds.includes(id) || id === liveModel,
              );
        const existingModels = readInstalledOwnedModels(settings, providerCfg);
        const prebuiltModels: ProviderModelConfig[] = defaultIds.flatMap(
          (id) => {
            const installed = existingModels.filter((model) => model.id === id);
            return (installed.length ? installed : [undefined]).flatMap(
              (existing) =>
                buildInstallPlan(providerCfg, {
                  baseUrl: resolved,
                  apiKey: '',
                  modelIds: [id],
                  wireApi: existing?.wireApi,
                }).modelProviders![0]!.models.map((model) => ({
                  ...existing,
                  ...model,
                  ...(existing?.wireApi ? { wireApi: existing.wireApi } : {}),
                  envKey: existing?.envKey ?? model.envKey,
                })),
            );
          },
        );
        // Keep user-added models; a built-in model no longer served to the
        // key is dropped rather than kept as if it were custom.
        prebuiltModels.push(
          ...existingModels.filter((model) => !builtInIds.includes(model.id)),
        );
        const installPlan = buildInstallPlan(providerCfg, {
          baseUrl: resolved,
          apiKey: '',
          modelIds: prebuiltModels.map((model) => model.id),
          prebuiltModels,
        });
        const providerState =
          installPlan.providerState![
            `${PROVIDER_METADATA_NS}.${pending.metadataKey}`
          ]!;
        providerState['version'] = pending.currentVersion;
        // Unset when discovery did not narrow the list, which clears the
        // served models recorded for an earlier key.
        providerState['servedModels'] = pending.servedModels;
        const retainedModels =
          pending.servedModels &&
          defaultIds.filter((id) => !pending.servedModels!.includes(id)).sort();
        providerState['retainedModels'] = retainedModels ?? [];
        Object.assign(providerState, CLEARED_POSTPONEMENT);
        delete installPlan.env;
        // Template updates never change the selected model.
        delete installPlan.modelSelection;
        const activeConfig = config.getContentGeneratorConfig();
        const updatesActiveProvider =
          activeConfig?.authType !== undefined &&
          prebuiltModels.some(
            (model) =>
              tryResolveModelProtocol(providerCfg.protocol, model) ===
              activeConfig.authType,
          ) &&
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
          ...(updatesActiveProvider && {
            refreshAuth: () => config.refreshAuth(activeConfig!.authType!),
          }),
        });

        const displayName = t(providerCfg.label);
        addItem(
          {
            type: 'info',
            text: t('{{plan}} configuration updated successfully.', {
              plan: displayName,
            }),
          },
          Date.now(),
        );

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

  const showNextPrompt = useCallback(() => {
    const pendingList = promptQueue.current.shift();
    promptOpen.current = pendingList !== undefined;
    if (!pendingList) return;

    const entries: ProviderUpdateEntry[] = pendingList.map((p) => ({
      providerLabel: t(p.provider.label),
      diff: p.diff,
    }));

    // Escape calls onConfirm straight from the keypress handler, so two
    // Escapes in one input chunk can call it twice. Answer each request once.
    let settled = false;
    setUpdateRequest({
      id: ++promptCount.current,
      entries,
      onConfirm: async (choice: UpdateChoice) => {
        if (settled) return;
        settled = true;
        setUpdateRequest(undefined);
        try {
          if (choice === 'update') {
            for (const p of pendingList) {
              await executeUpdate(p);
            }
          } else if (choice === 'skip') {
            const persistScope = getPersistScopeForModelSelection(settings);
            try {
              // Skipping accepts the current state, including any retained
              // models, until the served set or preset changes again.
              settings.setValues(
                pendingList.flatMap((p) =>
                  Object.entries({
                    ...CLEARED_POSTPONEMENT,
                    retainedModels: [],
                    ...(p.upToDate
                      ? { servedModels: p.servedModels }
                      : { ignoredVersion: p.currentVersion }),
                  }).map(([field, value]) => ({
                    scope: persistScope,
                    key: `${PROVIDER_METADATA_NS}.${p.metadataKey}.${field}`,
                    value,
                  })),
                ),
              );
            } catch (error) {
              addItem(
                {
                  type: 'error',
                  text: t('Failed to save the skipped update: {{message}}', {
                    message: getErrorMessage(error),
                  }),
                },
                Date.now(),
              );
            }
          } else if (choice === 'later') {
            // Persist a cooldown so "later" does not re-prompt on every launch.
            // One batched write keeps the version/timestamp pair atomic, so a
            // partial persist cannot invalidate the cooldown guard on next launch.
            // An up-to-date install postpones its served-model set, so a later
            // change to that set still prompts.
            const persistScope = getPersistScopeForModelSelection(settings);
            const postponedAt = Date.now();
            try {
              settings.setValues(
                pendingList.flatMap((p) => [
                  p.upToDate
                    ? {
                        scope: persistScope,
                        key: `${PROVIDER_METADATA_NS}.${p.metadataKey}.postponedServedModels`,
                        value: p.servedModels,
                      }
                    : {
                        scope: persistScope,
                        key: `${PROVIDER_METADATA_NS}.${p.metadataKey}.postponedVersion`,
                        value: p.currentVersion,
                      },
                  {
                    scope: persistScope,
                    key: `${PROVIDER_METADATA_NS}.${p.metadataKey}.${p.upToDate ? 'postponedVersion' : 'postponedServedModels'}`,
                    value: p.upToDate ? '' : [],
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
        } finally {
          showNextPrompt();
        }
      },
    });
  }, [settings, executeUpdate, addItem]);

  const queueUpdatePrompt = useCallback(
    (pendingList: PendingUpdate[]) => {
      if (pendingList.length === 0) return;
      promptQueue.current.push(pendingList);
      if (!promptOpen.current) showNextPrompt();
    },
    [showNextPrompt],
  );

  const checkForUpdates = useCallback(
    (signal: AbortSignal) => {
      if (!migrated.current) {
        migrated.current = true;
        migrateProviderMetadata(settings);
      }

      const currentModel = config.getModel();
      const pendingList = findAllPendingUpdates(settings, currentModel);

      if (pendingList.length === 0) return;

      // Providers without discovery prompt right away. Providers with it
      // compare against the models served to the stored key, so the prompt's
      // diff matches what Update installs; they prompt once `/models` answers.
      queueUpdatePrompt(pendingList.filter((p) => !p.discoveryApiKey));
      const discoverable = pendingList.filter((p) => p.discoveryApiKey);
      if (discoverable.length === 0) return;

      void Promise.all(
        discoverable.map((p) =>
          narrowToServedModels(p, () => config.getModel(), signal),
        ),
      )
        .then((narrowed) => {
          if (signal.aborted) return;
          const toPrompt: PendingUpdate[] = [];
          const persistScope = getPersistScopeForModelSelection(settings);
          for (const p of narrowed) {
            if (p.upToDate) {
              // Re-check a changed served set or a former selection's
              // retention; without discovery there is nothing to compare.
              if (!p.servedModels) continue;
              if (
                sameModelIds(p.servedModels, p.storedServedModels) &&
                !p.diff.removed.some((id) =>
                  p.storedRetainedModels?.includes(id),
                )
              )
                continue;
              if (sameModelIds(p.servedModels, p.postponedServedModels)) {
                continue;
              }
            }
            if (!isNarrowedUpdateNoop(settings, p)) {
              toPrompt.push(p);
              continue;
            }
            // Nothing changes for this key: record the version and served
            // models without asking, in one write.
            try {
              settings.setValues(
                Object.entries({
                  ...CLEARED_POSTPONEMENT,
                  ...(p.upToDate ? {} : { version: p.currentVersion }),
                  servedModels: p.servedModels,
                  retainedModels: p.retainedModels ?? [],
                }).map(([field, value]) => ({
                  scope: persistScope,
                  key: `${PROVIDER_METADATA_NS}.${p.metadataKey}.${field}`,
                  value,
                })),
              );
            } catch (error) {
              addItem(
                {
                  type: 'error',
                  text: t(
                    'Failed to update provider configuration: {{message}}',
                    { message: getErrorMessage(error) },
                  ),
                },
                Date.now(),
              );
            }
          }
          queueUpdatePrompt(toPrompt);
        })
        .catch((error: unknown) => {
          addItem(
            {
              type: 'error',
              text: t('Failed to update provider configuration: {{message}}', {
                message: getErrorMessage(error),
              }),
            },
            Date.now(),
          );
        });
    },
    [settings, config, addItem, queueUpdatePrompt],
  );

  useEffect(() => {
    const controller = new AbortController();
    checkForUpdates(controller.signal);
    return () => {
      controller.abort();
      // A re-run re-checks from scratch; drop prompts queued by this run.
      promptQueue.current = [];
      promptOpen.current = false;
    };
  }, [checkForUpdates]);

  return {
    providerUpdateRequest: updateRequest,
  };
}
