/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import { getModelsForProviderProtocol } from './provider-config.js';
import { AuthType } from '../core/contentGenerator.js';
import { isImageGenerationCapable } from '../models/image-generation-capability.js';
import {
  resolveModelProtocol,
  resolveProviderProtocol,
  tryResolveModelProtocol,
  resolveModelSelectionAuthType,
} from '../models/modelRegistry.js';
import { ModelsConfig } from '../models/modelsConfig.js';
import type {
  ModelProvidersConfig,
  ProviderProtocolConfig,
} from '../models/types.js';
import type {
  ProviderInstallPlan,
  ProviderModelProvidersPatch,
  ProviderSettingsAdapter,
} from './types.js';

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
  return a.id === b.id && (a.baseUrl ?? '') === (b.baseUrl ?? '');
}

function applyModelProvidersPatch(
  existingModelProviders: ModelProvidersConfig,
  patch: ProviderModelProvidersPatch,
  mapping?: ProviderProtocolConfig,
): ModelProvidersConfig {
  if (
    patch.authType === AuthType.USE_OPENAI &&
    resolveProviderProtocol(patch.authType, mapping) ===
      AuthType.USE_OPENAI_RESPONSES
  ) {
    patch = {
      ...patch,
      models: patch.models.map((model) => ({
        ...model,
        wireApi: model.wireApi ?? 'chat-completions',
      })),
    };
  }
  const existingModels = existingModelProviders[patch.authType] ?? [];

  let updatedModels = patch.models;
  if (patch.mergeStrategy === 'append') {
    updatedModels = [...existingModels, ...patch.models];
  } else {
    const ownsModel = patch.ownsModel;
    const preservedModels = existingModels.filter((model) => {
      if (ownsModel) {
        return (
          !ownsModel(model) ||
          !patch.models.some(
            (newModel) =>
              resolveModelProtocol(patch.authType, newModel) ===
              tryResolveModelProtocol(patch.authType, model, mapping),
          )
        );
      }
      return !patch.models.some(
        (newModel) =>
          isSameModelIdentity(newModel, model) &&
          resolveModelProtocol(patch.authType, newModel) ===
            tryResolveModelProtocol(patch.authType, model, mapping),
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

  const selectedAuthType = settings.getValue('security.auth.selectedType');
  const mapping = settings.getValue('providerProtocol') as
    | ProviderProtocolConfig
    | undefined;
  const serviceOnly = (plan.modelProviders ?? []).flatMap(
    (patch) => patch.models,
  );
  const preserveSelection =
    serviceOnly.length > 0 &&
    serviceOnly.every((model) => model.imageOnly || model.voiceOnly);
  const previousEnvValues = new Map<string, string | undefined>();
  // Snapshot the runtime providers map *before* any setValue/reload so we can
  // restore in-memory state if a callback later in the flow rejects (e.g.
  // refreshAuth() against a bad endpoint). Without this the live session
  // could be left holding providers that the plan failed to install.
  const previousRuntimeProviders: ModelProvidersConfig = {
    ...settings.getModelProviders(),
  };
  const writeContext = settings.getModelProvidersForWrite?.();
  const writeMapping = writeContext ? writeContext.providerProtocol : mapping;
  for (const [providerId, models] of Object.entries(
    writeContext?.modelProviders ?? {},
  )) {
    if (!Array.isArray(models)) continue;
    if (
      providerId !== AuthType.USE_OPENAI_RESPONSES &&
      resolveProviderProtocol(providerId, writeMapping) !==
        AuthType.USE_OPENAI_RESPONSES
    )
      continue;
    const overwritten = models.filter((existing) =>
      plan.modelProviders?.some(
        (patch) =>
          patch.authType === AuthType.USE_OPENAI &&
          patch.models.some(
            (model) =>
              isSameModelIdentity(existing, model) &&
              tryResolveModelProtocol(providerId, existing, writeMapping) ===
                resolveModelProtocol(patch.authType, model),
          ),
      ),
    );
    if (
      overwritten.length &&
      (writeContext?.shadowedProviders.includes(providerId) ||
        overwritten.some(
          (model) =>
            tryResolveModelProtocol(providerId, model, writeMapping) !==
            tryResolveModelProtocol(providerId, model, mapping),
        ))
    ) {
      throw new ProviderInstallError(
        'A higher-precedence settings scope overrides this released provider declaration. Reconfigure it in the owning scope without that override.',
        'modelProviders',
        plan.authType,
      );
    }
  }
  for (const patch of plan.modelProviders ?? []) {
    const existingModels = getModelsForProviderProtocol(
      previousRuntimeProviders,
      patch.authType,
      mapping,
    );
    const changesRole = existingModels.some((existing) =>
      patch.models.some(
        (model) =>
          (isSameModelIdentity(existing, model) ||
            (existing.id === model.id &&
              patch.ownsModel?.(existing) &&
              (preserveSelection || patch.mergeStrategy !== 'append'))) &&
          (Boolean(existing.imageOnly) !== Boolean(model.imageOnly) ||
            Boolean(existing.voiceOnly) !== Boolean(model.voiceOnly) ||
            (isImageGenerationCapable(existing) &&
              !isImageGenerationCapable(model))),
      ),
    );
    const removesConversation =
      preserveSelection &&
      existingModels.some(
        (existing) =>
          !existing.imageOnly &&
          !existing.voiceOnly &&
          (patch.ownsModel?.(existing) ??
            patch.models.some((model) => isSameModelIdentity(existing, model))),
      );
    const removesService =
      !preserveSelection &&
      patch.mergeStrategy !== 'append' &&
      existingModels.some(
        (existing) =>
          (existing.imageOnly || existing.voiceOnly) &&
          patch.ownsModel?.(existing) &&
          !patch.models.some((model) => model.id === existing.id),
      );
    if (changesRole || removesConversation || removesService) {
      throw new ProviderInstallError(
        removesConversation
          ? 'This install would remove existing conversation models. Include them in the provider selection, or add the service model with Custom Provider.'
          : removesService
            ? 'This install would remove existing service models. Include them in the provider selection, or add the conversation model with Custom Provider.'
            : 'This install would replace a model configured for another purpose. Use a different model ID or endpoint.',
        'modelPurpose',
        plan.authType,
      );
    }
  }

  const voiceIds = new Set(
    [
      ...Object.values(previousRuntimeProviders).flatMap((models) =>
        Array.isArray(models) ? models : [],
      ),
      ...serviceOnly,
    ]
      .filter((model) => model?.voiceOnly)
      .map((model) => model.id),
  );
  const selectedVoice = settings.getValue('voiceModel');
  if (typeof selectedVoice === 'string' && selectedVoice)
    voiceIds.add(selectedVoice);
  const changedVoiceIds = [...voiceIds].filter((id) =>
    plan.modelProviders?.some((patch) =>
      patch.models.some((model) => model.id === id),
    ),
  );
  if (changedVoiceIds.length) {
    let prospective = previousRuntimeProviders;
    for (const patch of plan.modelProviders ?? []) {
      prospective = applyModelProvidersPatch(prospective, patch, mapping);
    }
    const configured = new ModelsConfig({
      modelProvidersConfig: prospective,
      providerProtocolConfig: settings.getValue('providerProtocol') as
        | ProviderProtocolConfig
        | undefined,
    }).getAllConfiguredModels();
    if (
      changedVoiceIds.some(
        (id) => configured.filter((entry) => entry.id === id).length > 1,
      )
    ) {
      throw new ProviderInstallError(
        'A voice model with this ID is already configured at another endpoint. Edit that model or use a different model ID.',
        'modelPurpose',
        plan.authType,
      );
    }
  }

  const previousModelId = settings.getValue('model.name');
  const previousBaseUrl = settings.getValue('model.baseUrl');

  // Track which step is in flight so a rethrow at the bottom can name it
  // (an EACCES from persist vs a refreshAuth rejection look identical
  // otherwise — eight steps, one anonymous error).
  let currentStep = 'init';

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
        preserveSelection
          ? {
              ...patch,
              mergeStrategy: 'replace-owned',
              ownsModel: (existing) =>
                (patch.ownsModel?.(existing) ?? false) ||
                patch.models.some((model) =>
                  isSameModelIdentity(existing, model),
                ),
            }
          : patch,
        mapping,
      );
      settings.setValue(
        `modelProviders.${patch.authType}`,
        updatedModelProviders[patch.authType] ?? [],
      );
      if (patch.authType !== AuthType.USE_OPENAI) continue;
      const ownProviders =
        settings.getModelProvidersForWrite?.().modelProviders ??
        settings.getModelProviders();
      for (const [providerId, models] of Object.entries(ownProviders)) {
        if (providerId === patch.authType || !Array.isArray(models)) continue;
        if (
          providerId !== AuthType.USE_OPENAI_RESPONSES &&
          resolveProviderProtocol(providerId, writeMapping) !==
            AuthType.USE_OPENAI_RESPONSES
        )
          continue;
        const remaining = models.filter(
          (existing) =>
            !patch.models.some(
              (model) =>
                isSameModelIdentity(existing, model) &&
                tryResolveModelProtocol(providerId, existing, writeMapping) ===
                  resolveModelProtocol(patch.authType, model),
            ),
        );
        if (remaining.length !== models.length)
          settings.setValue(`modelProviders.${providerId}`, remaining);
      }
    }

    const effectiveProviders = settings.getModelProviders();
    for (const patch of plan.modelProviders ?? []) {
      const effectiveModels = getModelsForProviderProtocol(
        effectiveProviders,
        patch.authType,
        mapping,
      );
      const expectedModels = getModelsForProviderProtocol(
        { [patch.authType]: patch.models },
        patch.authType,
      );
      const ownProviders =
        settings.getModelProvidersForWrite?.().modelProviders;
      const installedModels = ownProviders
        ? getModelsForProviderProtocol(
            { [patch.authType]: ownProviders[patch.authType] ?? [] },
            patch.authType,
            mapping,
          )
        : expectedModels;
      if (
        expectedModels.some((model) => {
          const winner = effectiveModels.find(
            (effective) =>
              isSameModelIdentity(model, effective) &&
              resolveModelProtocol(patch.authType, model) ===
                resolveModelProtocol(patch.authType, effective),
          );
          const installed = installedModels.find(
            (entry) =>
              isSameModelIdentity(model, entry) &&
              resolveModelProtocol(patch.authType, model) ===
                resolveModelProtocol(patch.authType, entry),
          );
          return (
            !winner ||
            !installed ||
            !isDeepStrictEqual(
              JSON.parse(JSON.stringify({ ...installed, wireApi: undefined })),
              JSON.parse(JSON.stringify({ ...winner, wireApi: undefined })),
            )
          );
        })
      ) {
        throw new ProviderInstallError(
          'A higher-precedence settings scope overrides the installed models. Update the scope that owns this provider.',
          'modelProviders',
          plan.authType,
        );
      }
    }

    // Set auth type
    currentStep = 'authType';
    if (!preserveSelection) {
      settings.setValue('security.auth.selectedType', plan.authType);
    }

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
    let effectiveModelSelection = preserveSelection
      ? undefined
      : plan.modelSelection;
    // When the install moves the current model onto a different API route, the
    // live session must still be re-synced below even though the model itself
    // is kept.
    let routeResyncSelection: { modelId: string; baseUrl?: string } | undefined;
    if (effectiveModelSelection?.modelId) {
      const currentModelId = settings.getValue('model.name');
      const currentBaseUrl = settings.getValue('model.baseUrl') as
        | string
        | undefined;
      const planOffersCurrentModel =
        typeof currentModelId === 'string' &&
        currentModelId.length > 0 &&
        (plan.modelProviders ?? []).some((patch) =>
          patch.models.some(
            (model) =>
              resolveModelProtocol(patch.authType, model) === plan.authType &&
              (currentBaseUrl === '' || currentBaseUrl === undefined
                ? model.id === currentModelId
                : isSameModelIdentity(
                    { id: currentModelId, baseUrl: currentBaseUrl },
                    model,
                  )),
          ),
        );
      if (planOffersCurrentModel) {
        effectiveModelSelection = undefined;
        // Resolved lazily and only for OpenAI-family plans (the only ones a
        // wire switch applies to). The selection resolver walks EVERY bucket
        // of the pre-install providers map with the throwing per-model
        // resolver, so a hand-edited invalid `wireApi` sitting in an unrelated
        // bucket must not abort this install: skip the route-resync probe
        // instead. The plan's own write path still validates the buckets it
        // writes with the throwing resolver.
        let previousAuthType: AuthType | undefined;
        if (
          (plan.authType === AuthType.USE_OPENAI ||
            plan.authType === AuthType.USE_OPENAI_RESPONSES) &&
          typeof selectedAuthType === 'string'
        ) {
          try {
            previousAuthType = resolveModelSelectionAuthType(
              selectedAuthType as AuthType,
              typeof previousModelId === 'string' ? previousModelId : undefined,
              previousRuntimeProviders,
              settings.getValue('providerProtocol') as
                | ProviderProtocolConfig
                | undefined,
              typeof previousBaseUrl === 'string' ? previousBaseUrl : undefined,
            );
          } catch {
            previousAuthType = undefined;
          }
        }
        if (
          previousAuthType !== undefined &&
          previousAuthType !== plan.authType
        ) {
          // Keep the user's model, but re-sync onto the new wire for the SAME
          // model rather than adopting the plan's default (whose modelId is
          // always the plan's first model).
          routeResyncSelection = {
            modelId: currentModelId,
            ...(currentBaseUrl ? { baseUrl: currentBaseUrl } : {}),
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
    updatedModelProviders = settings.getModelProviders();
    reloadModelProviders?.(updatedModelProviders);
    const syncSelection = effectiveModelSelection?.modelId
      ? effectiveModelSelection
      : routeResyncSelection;
    if (syncSelection) {
      currentStep = 'syncAuthState';
      syncAuthState?.(
        plan.authType,
        syncSelection.modelId,
        syncSelection.baseUrl,
      );
    }
    if (!preserveSelection && doRefreshAuth && refreshAuth) {
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
