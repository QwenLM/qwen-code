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
import { normalizeBaseUrlForMatching } from './provider-config.js';

/**
 * Environment variable names an install plan must never set — they alter
 * process/loader behavior (code injection, PATH hijack, home redirection).
 * Compared case-insensitively. Provider API-key envs never collide with
 * these.
 */
const DENY_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP', // Windows temp redirect
  'TEMP', // Windows temp redirect
]);

// ---------------------------------------------------------------------------
// Model providers merge logic
// ---------------------------------------------------------------------------

function isSameModelIdentity(
  a: { id: string; baseUrl?: string },
  b: { id: string; baseUrl?: string },
): boolean {
  return (
    a.id === b.id &&
    normalizeBaseUrlForMatching(a.baseUrl) ===
      normalizeBaseUrlForMatching(b.baseUrl)
  );
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
    const removesModel = (model: (typeof existingModels)[number]) => {
      if (ownsModel) {
        return ownsModel(model);
      }
      return patch.models.some((newModel) =>
        isSameModelIdentity(newModel, model),
      );
    };
    const firstRemovedIndex = existingModels.findIndex(removesModel);
    const preservedModels = existingModels.filter(
      (model) => !removesModel(model),
    );

    if (patch.mergeStrategy === 'replace-owned') {
      updatedModels = [...preservedModels, ...patch.models];
    } else if (firstRemovedIndex < 0) {
      const collidesWithPreservedModel = patch.models.some((incoming) =>
        preservedModels.some(
          (existing) =>
            existing.id === incoming.id &&
            patch.ownsModelAcrossEndpoints?.(existing),
        ),
      );
      updatedModels =
        patch.retainCurrentModelAcrossEndpoints && collidesWithPreservedModel
          ? [...preservedModels, ...patch.models]
          : [...patch.models, ...preservedModels];
    } else {
      // Updating an existing endpoint must not reorder sibling endpoints.
      // Duplicate model ids are resolved by first match, so prepending a
      // replacement can silently change the selected region when baseUrl is
      // intentionally absent from a legacy/id-only selection.
      const insertionIndex = existingModels
        .slice(0, firstRemovedIndex)
        .filter((model) => !removesModel(model)).length;
      updatedModels = [
        ...preservedModels.slice(0, insertionIndex),
        ...patch.models,
        ...preservedModels.slice(insertionIndex),
      ];
    }
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
  syncAuthState?: (
    authType: AuthType,
    modelId: string,
    baseUrl?: string,
  ) => void;
  /** Callback to refresh auth after install. */
  refreshAuth?: (authType: AuthType) => Promise<void>;
  /** Whether to call refreshAuth after install. Defaults to true. */
  doRefreshAuth?: boolean;
}

export interface ApplyProviderInstallPlanResult {
  updatedModelProviders: ModelProvidersConfig;
}

/**
 * Error thrown by {@link applyProviderInstallPlan} when a step fails. The
 * message is the underlying error's message (safe to surface to users); the
 * `step` and `authType` properties carry diagnostic context, and `cause`
 * preserves the original error (so callers matching on `err.code` still work
 * via the chain).
 *
 * A class (not an interface) so `err instanceof ProviderInstallError` works
 * at runtime — an interface would erase at compile time and silently always
 * be false.
 */
export class ProviderInstallError extends Error {
  readonly step: string;
  readonly authType: AuthType;

  constructor(
    message: string,
    step: string,
    authType: AuthType,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProviderInstallError';
    this.step = step;
    this.authType = authType;
  }
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

  const previousEnvValues = new Map<string, string | undefined>();
  // Snapshot the runtime providers map *before* any setValue/reload so we can
  // restore in-memory state if a callback later in the flow rejects (e.g.
  // refreshAuth() against a bad endpoint). Without this the live session
  // could be left holding providers that the plan failed to install.
  const previousRuntimeProviders: ModelProvidersConfig = {
    ...settings.getModelProviders(),
  };

  // Track which step is in flight so a rethrow at the bottom can name it
  // (an EACCES from persist vs a refreshAuth rejection look identical
  // otherwise — eight steps, one anonymous error).
  let currentStep = 'init';
  const overwrittenEnvKeys = new Set<string>();

  try {
    // backup() inside the try so a failure here (e.g. structuredClone on a
    // non-serializable adapter) still triggers the catch + env rollback.
    currentStep = 'backup';
    settings.backup?.();

    // Set environment variables (snapshot previous values for rollback).
    // Defense in depth: refuse process-altering env names. Today every
    // caller routes through buildInstallPlan with hardcoded provider keys,
    // but ProviderInstallPlan is exported, so a future provider config or a
    // hand-built plan could otherwise inject NODE_OPTIONS / LD_PRELOAD /
    // PATH etc. into both settings.json and the live process.env.
    currentStep = 'env';
    const shadowedEnvKeys: string[] = [];
    for (const [key, value] of Object.entries(plan.env ?? {})) {
      if (DENY_ENV_KEYS.has(key.toUpperCase())) {
        throw new Error(
          `Install plan must not set reserved environment variable: ${key}`,
        );
      }
      const previous = process.env[key];
      // Detect when a shell env var or .env file already has this key with a
      // different value — on restart, the higher-priority source will shadow
      // the value we're about to write to settings.env.
      if (previous !== undefined && previous !== '' && previous !== value) {
        shadowedEnvKeys.push(key);
      }
      previousEnvValues.set(key, previous);
      if (settings.getValue(`env.${key}`) !== value) {
        overwrittenEnvKeys.add(key);
      }
      settings.setValue(`env.${key}`, value);
      process.env[key] = value;
    }

    if (shadowedEnvKeys.length > 0) {
      // eslint-disable-next-line no-console -- user-facing /auth warning
      console.error(
        `[auth] Warning: ${shadowedEnvKeys.join(', ')} ${shadowedEnvKeys.length === 1 ? 'is' : 'are'} also set in your shell environment or .env file. ` +
          `The shell/file value will take priority on restart. ` +
          `To ensure your new key is used, update or remove the variable from your shell profile or .env file.`,
      );
    }

    // Apply model providers patches
    currentStep = 'modelProviders';
    let updatedModelProviders: ModelProvidersConfig = {
      ...previousRuntimeProviders,
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
    currentStep = 'authType';
    settings.setValue('security.auth.selectedType', plan.authType);

    // Legacy credentials
    currentStep = 'legacyCredentials';
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
    // Re-applying a plan (manual /auth, ACP reconnect, token refresh, or an
    // upgrade that reordered the model list) must not silently move the user
    // off a model they chose. If the plan still offers the current model, keep
    // it; a genuine first-time setup still adopts the provider default. (#5819)
    currentStep = 'modelSelection';
    let effectiveModelSelection = plan.modelSelection;
    if (effectiveModelSelection?.modelId) {
      const currentModelId = settings.getValue('model.name');
      const currentBaseUrl = settings.getValue('model.baseUrl') as
        | string
        | undefined;
      const retainAcrossEndpoints = (plan.modelProviders ?? []).filter(
        (patch) => patch.retainCurrentModelAcrossEndpoints,
      );
      const installedModels = (plan.modelProviders ?? []).flatMap(
        (patch) => patch.models,
      );
      const offeredModels = retainAcrossEndpoints.length
        ? (updatedModelProviders[plan.authType] ?? []).filter((model) => {
            // A sibling that shares a credential being replaced by this plan
            // is no longer a valid offer for the old endpoint. Only models in
            // the selected patch may retain the active selection in that case.
            const ownedAcrossEndpoints = retainAcrossEndpoints.some((patch) =>
              patch.ownsModelAcrossEndpoints?.(model),
            );
            if (!ownedAcrossEndpoints) return false;
            if (
              !model.envKey ||
              !overwrittenEnvKeys.has(model.envKey) ||
              installedModels.some((installed) =>
                isSameModelIdentity(installed, model),
              )
            ) {
              return true;
            }
            return false;
          })
        : (plan.modelProviders ?? []).flatMap((patch) => patch.models);
      const currentOfferMatch =
        typeof currentModelId === 'string' && currentModelId.length > 0
          ? offeredModels.find((model) =>
              currentBaseUrl === '' || currentBaseUrl === undefined
                ? model.id === currentModelId
                : isSameModelIdentity(
                    { id: currentModelId, baseUrl: currentBaseUrl },
                    model,
                  ),
            )
          : undefined;
      const planOffersCurrentModel = currentOfferMatch !== undefined;
      const invalidatedCurrentSibling =
        typeof currentModelId === 'string' &&
        (updatedModelProviders[plan.authType] ?? []).some(
          (model) =>
            model.id === currentModelId &&
            (currentBaseUrl === '' || currentBaseUrl === undefined
              ? true
              : isSameModelIdentity(
                  { id: currentModelId, baseUrl: currentBaseUrl },
                  model,
                )) &&
            model.envKey !== undefined &&
            overwrittenEnvKeys.has(model.envKey) &&
            !installedModels.some((installed) =>
              isSameModelIdentity(installed, model),
            ),
        );
      const installedCurrentModel =
        typeof currentModelId === 'string'
          ? installedModels.find((model) => model.id === currentModelId)
          : undefined;
      if (invalidatedCurrentSibling && installedCurrentModel) {
        // The shared credential moved an id-only selection to this endpoint.
        // Keep the user's current model when the target offers it instead of
        // falling back to the plan's first/default model.
        effectiveModelSelection = {
          modelId: installedCurrentModel.id,
          baseUrl: installedCurrentModel.baseUrl,
        };
      } else if (planOffersCurrentModel) {
        effectiveModelSelection = undefined;
        // The match above may be a NORMALIZED identity match: a stored
        // selection whose baseUrl differs from the offered entry only by a
        // trailing slash. Left alone, the exact-match runtime registry
        // (modelRegistry keys by `${id}\0${baseUrl}`; hasModel falls back
        // only to an exact baseUrl) never resolves the slash-variant
        // selection — the installed model surfaces as a phantom duplicate in
        // model lists and switchModel with the stored baseUrl throws
        // "Model … not found" (R41-6). Rewrite the selection to the matched
        // entry's exact spelling so it self-heals. Id-only selections
        // (currentBaseUrl ''/undefined) keep floating: they must not gain a
        // baseUrl disambiguator.
        if (
          typeof currentModelId === 'string' &&
          typeof currentBaseUrl === 'string' &&
          currentBaseUrl !== '' &&
          currentOfferMatch !== undefined &&
          typeof currentOfferMatch.baseUrl === 'string' &&
          currentOfferMatch.baseUrl !== currentBaseUrl
        ) {
          effectiveModelSelection = {
            modelId: currentModelId,
            baseUrl: currentOfferMatch.baseUrl,
          };
        }
      }
    }
    if (effectiveModelSelection?.modelId) {
      settings.setValue('model.name', effectiveModelSelection.modelId);
      if (effectiveModelSelection.baseUrl) {
        settings.setValue('model.baseUrl', effectiveModelSelection.baseUrl);
      } else {
        // The plan selects by model id only, so clear any baseUrl disambiguator
        // left by a previous model-picker selection — otherwise the next launch
        // could resolve to a stale provider sharing this model id. Empty-string
        // tombstone so the clear overrides a lower-scope value on merge (an
        // undefined write is dropped from JSON and would not override).
        settings.setValue('model.baseUrl', '');
      }
    }

    // Provider state metadata
    currentStep = 'providerState';
    for (const [key, entries] of Object.entries(plan.providerState ?? {})) {
      for (const [field, value] of Object.entries(entries)) {
        settings.setValue(`${key}.${field}`, value);
      }
    }

    // Persist to disk
    currentStep = 'persist';
    settings.persist();

    // Reload runtime config
    currentStep = 'reloadModelProviders';
    reloadModelProviders?.(updatedModelProviders);
    if (effectiveModelSelection?.modelId) {
      currentStep = 'syncAuthState';
      syncAuthState?.(
        plan.authType,
        effectiveModelSelection.modelId,
        effectiveModelSelection.baseUrl,
      );
    }
    if (doRefreshAuth && refreshAuth) {
      currentStep = 'refreshAuth';
      await refreshAuth(plan.authType);
    }

    currentStep = 'cleanupBackup';
    settings.cleanupBackup?.();

    return { updatedModelProviders };
  } catch (error) {
    // Best-effort rollback. Each step is wrapped so a failure in one
    // doesn't mask the original error or skip the later steps.
    try {
      settings.restore?.();
    } catch (restoreErr) {
      // eslint-disable-next-line no-console -- best-effort rollback path
      console.error(
        '[applyProviderInstallPlan] settings.restore failed during rollback:',
        restoreErr,
      );
    }
    try {
      for (const [key, prev] of previousEnvValues) {
        if (prev === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = prev;
        }
      }
    } catch (envErr) {
      // process.env writes can throw if a custom property descriptor on
      // process.env has been installed (rare, but observed in some test
      // harnesses). Don't let it skip the runtime-providers rollback below.
      // eslint-disable-next-line no-console -- best-effort rollback path
      console.error('[applyProviderInstallPlan] env rollback failed:', envErr);
    }
    // Restore in-memory runtime providers — reloadModelProviders may have run
    // before the failure (e.g. before a refreshAuth rejection).
    try {
      reloadModelProviders?.(previousRuntimeProviders);
    } catch (reloadErr) {
      // eslint-disable-next-line no-console -- best-effort rollback path
      console.error(
        '[applyProviderInstallPlan] reloadModelProviders failed during rollback:',
        reloadErr,
      );
    }
    // Attach the failing step + authType as *structured properties* rather
    // than baking them into the message. Keeps the user-facing message clean
    // (callers show error.message verbatim) while letting devs read
    // error.step / error.authType and the original error.cause off the chain.
    const errMsg = error instanceof Error ? error.message : String(error);
    throw new ProviderInstallError(errMsg, currentStep, plan.authType, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}
