/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Protocol } from '../core/contentGenerator.js';
import type { AuthType } from '../core/contentGenerator.js';
import type { ModelProvidersConfig, ProviderConfig } from '../models/types.js';
import type {
  ProviderInstallPlan,
  ProviderModelProvidersPatch,
  ProviderSettingsAdapter,
} from './types.js';

const AUTH_TYPE_TO_PROTOCOL: Record<string, Protocol> = {
  openai: Protocol.OPENAI,
  'qwen-oauth': Protocol.QWEN_OAUTH,
  gemini: Protocol.GEMINI,
  'vertex-ai': Protocol.GEMINI,
  anthropic: Protocol.ANTHROPIC,
};

export function authTypeToProtocol(authType: AuthType): Protocol {
  return Object.hasOwn(AUTH_TYPE_TO_PROTOCOL, authType)
    ? AUTH_TYPE_TO_PROTOCOL[authType]
    : Protocol.OPENAI;
}

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
): ModelProvidersConfig {
  const existingProvider = existingModelProviders[patch.authType];
  const existingModels = Array.isArray(existingProvider)
    ? existingProvider
    : (existingProvider?.models ?? []);

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

  // Preserve the existing provider config (protocol, baseUrl, envKey) and update models
  const updatedProvider: ProviderConfig = {
    protocol: existingProvider?.protocol ?? authTypeToProtocol(patch.authType),
    models: updatedModels,
    ...(existingProvider?.baseUrl ? { baseUrl: existingProvider.baseUrl } : {}),
    ...(existingProvider?.envKey ? { envKey: existingProvider.envKey } : {}),
  };

  return {
    ...existingModelProviders,
    [patch.authType]: updatedProvider,
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
    for (const [key, value] of Object.entries(plan.env ?? {})) {
      if (DENY_ENV_KEYS.has(key.toUpperCase())) {
        throw new Error(
          `Install plan must not set reserved environment variable: ${key}`,
        );
      }
      previousEnvValues.set(key, process.env[key]);
      settings.setValue(`env.${key}`, value);
      process.env[key] = value;
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
        updatedModelProviders[patch.authType],
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
    currentStep = 'modelSelection';
    if (plan.modelSelection?.modelId) {
      settings.setValue('model.name', plan.modelSelection.modelId);
      if (plan.modelSelection.baseUrl) {
        settings.setValue('model.baseUrl', plan.modelSelection.baseUrl);
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
    if (plan.modelSelection?.modelId) {
      currentStep = 'syncAuthState';
      syncAuthState?.(
        plan.authType,
        plan.modelSelection.modelId,
        plan.modelSelection.baseUrl,
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
