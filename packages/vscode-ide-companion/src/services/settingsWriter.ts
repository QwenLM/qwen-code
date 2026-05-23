/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Settings writer for VSCode extension.
 * Handles bidirectional sync between VSCode Settings and ~/.qwen/settings.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuthType, Storage } from '@qwen-code/qwen-code-core';
import {
  CODING_PLAN_ENV_KEY,
  CodingPlanRegion,
  SUBSCRIPTION_PLAN_OPTIONS,
  findSubscriptionPlanByConfig,
  getSubscriptionPlanConfig,
  isSubscriptionPlanConfig,
} from './subscriptionPlanDefinitions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Model providers as key-value map: modelId → baseUrl.
 * This is the format VSCode Settings UI can render as an editable table.
 */
export type VSCodeModelProviders = Record<string, string>;

/**
 * Values extracted from ~/.qwen/settings.json for populating VSCode Settings.
 */
export interface QwenSettingsForVSCode {
  provider: 'coding-plan' | 'api-key';
  apiKey: string;
  codingPlanRegion: 'china' | 'global';
}

// ---------------------------------------------------------------------------
// Low-level read/write helpers
// ---------------------------------------------------------------------------

/**
 * Read ~/.qwen/settings.json. Returns {} if missing or invalid.
 */
function readSettings(): Record<string, unknown> {
  try {
    const content = fs.readFileSync(Storage.getGlobalSettingsPath(), 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Write ~/.qwen/settings.json (creates dir if needed).
 */
function writeSettings(settings: Record<string, unknown>): void {
  const settingsPath = Storage.getGlobalSettingsPath();
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Ensure nested objects exist at the given key path.
 */
function ensureNestedObject(
  obj: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> {
  let current = obj;
  for (const key of keys) {
    if (!current[key] || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  return current;
}

/**
 * Find OpenAI-compatible model entries from modelProviders.
 * CLI uses AuthType.USE_OPENAI ('openai') as the key, but some legacy
 * configs may use other keys. Check both.
 */
function findOpenaiModels(
  modelProviders: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> {
  if (!modelProviders) {
    return [];
  }
  for (const key of [AuthType.USE_OPENAI, 'use_openai']) {
    const arr = modelProviders[key];
    if (Array.isArray(arr) && arr.length > 0) {
      return arr as Array<Record<string, unknown>>;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Write: VSCode Settings → ~/.qwen/settings.json
// ---------------------------------------------------------------------------

/**
 * Write Coding Plan configuration to ~/.qwen/settings.json.
 * Auto-injects model providers from the regional template,
 * preserving any existing non-Coding-Plan entries.
 *
 * @returns The injected models as a VSCode key-value map (modelId → baseUrl)
 */
export function writeCodingPlanConfig(
  region: 'china' | 'global',
  apiKey: string,
): VSCodeModelProviders {
  const settings = readSettings();
  const codingRegion =
    region === 'global' ? CodingPlanRegion.GLOBAL : CodingPlanRegion.CHINA;
  const planConfig = getSubscriptionPlanConfig('coding', codingRegion);

  // Auth
  const auth = ensureNestedObject(settings, 'security', 'auth');
  auth.selectedType = AuthType.USE_OPENAI;

  // API key
  const env = ensureNestedObject(settings, 'env');
  env[CODING_PLAN_ENV_KEY] = apiKey;

  // Model providers — merge Coding Plan templates with existing non-CP entries
  const providers = ensureNestedObject(settings, 'modelProviders');
  const existing = findOpenaiModels(
    settings.modelProviders as Record<string, unknown>,
  );
  const nonCodingPlan = existing.filter(
    (e) => !isSubscriptionPlanConfig(e.baseUrl as string, e.envKey as string),
  );
  const planModels = planConfig.template.map((model) => ({
    ...model,
    envKey: planConfig.envKey,
  }));
  providers[AuthType.USE_OPENAI] = [...planModels, ...nonCodingPlan];

  // Coding Plan metadata — write to the providerMetadata namespace that
  // the CLI now reads from. Remove legacy top-level key if present.
  const providerMetadata = ensureNestedObject(settings, 'providerMetadata');
  providerMetadata['coding-plan'] = {
    region: codingRegion,
    version: planConfig.version,
  };
  delete settings.codingPlan;

  // Default model
  const defaultModelId = planConfig.template[0]?.id ?? 'qwen3.5-plus';
  settings.model = { name: defaultModelId };

  writeSettings(settings);

  // Return key-value map for VSCode settings
  const result: VSCodeModelProviders = {};
  for (const m of planConfig.template) {
    result[m.id] = m.baseUrl || '';
  }
  return result;
}

/**
 * Write model providers from VSCode Settings (key-value map) to ~/.qwen/settings.json.
 * Used when provider = "api-key" and user edits the modelProviders map.
 *
 * @param params.apiKey - The API key
 * @param params.modelProviders - Map of modelId → baseUrl
 * @param params.activeModel - Currently selected model ID
 */
export function writeModelProvidersConfig(params: {
  apiKey: string;
  modelProviders: VSCodeModelProviders;
  activeModel: string;
}): void {
  const settings = readSettings();

  // Auth
  const auth = ensureNestedObject(settings, 'security', 'auth');
  auth.selectedType = AuthType.USE_OPENAI;

  // API key
  const env = ensureNestedObject(settings, 'env');
  env['OPENAI_API_KEY'] = params.apiKey;
  for (const plan of SUBSCRIPTION_PLAN_OPTIONS) {
    delete env[plan.envKey];
  }

  // Convert key-value map to CLI's array format and merge with existing
  // non-target entries so reconfiguring one provider doesn't silently
  // delete others (e.g. Coding Plan entries with a different envKey).
  const providers = ensureNestedObject(settings, 'modelProviders');
  const modelArray = Object.entries(params.modelProviders).map(
    ([id, baseUrl]) => ({
      id,
      name: id,
      baseUrl: baseUrl || 'https://api.openai.com/v1',
      envKey: 'OPENAI_API_KEY',
    }),
  );
  const existing = findOpenaiModels(
    settings.modelProviders as Record<string, unknown>,
  );
  const nonTarget = existing.filter((e) => e.envKey !== 'OPENAI_API_KEY');
  providers[AuthType.USE_OPENAI] = [...modelArray, ...nonTarget];

  // Active model
  if (params.activeModel) {
    settings.model = { name: params.activeModel };
  }

  for (const plan of SUBSCRIPTION_PLAN_OPTIONS) {
    delete settings[plan.metadataKey];
  }
  const pm = settings.providerMetadata as Record<string, unknown> | undefined;
  if (pm) {
    delete pm['coding-plan'];
    delete pm['token-plan'];
  }

  writeSettings(settings);
}

// ---------------------------------------------------------------------------
// Read: ~/.qwen/settings.json → VSCode Settings
// ---------------------------------------------------------------------------

/**
 * Read ~/.qwen/settings.json and extract values for VSCode Settings UI.
 * Returns null if no valid configuration found.
 */
export function readQwenSettingsForVSCode(): QwenSettingsForVSCode | null {
  const settings = readSettings();

  const security = settings.security as Record<string, unknown> | undefined;
  const auth = security?.auth as Record<string, unknown> | undefined;
  if (!auth?.selectedType) {
    return null;
  }

  const env = (settings.env ?? {}) as Record<string, string>;
  const modelProviders = settings.modelProviders as
    | Record<string, unknown>
    | undefined;
  const openaiModels = findOpenaiModels(modelProviders);
  const subscriptionPlan = openaiModels
    .map((model) =>
      findSubscriptionPlanByConfig(
        model.baseUrl as string | undefined,
        model.envKey as string | undefined,
      ),
    )
    .find((match) => match !== undefined && !!env[match.plan.envKey]);

  if (subscriptionPlan?.plan.id === 'coding') {
    const region = subscriptionPlan.region === 'global' ? 'global' : 'china';
    return {
      provider: 'coding-plan',
      apiKey: env[subscriptionPlan.plan.envKey] || '',
      codingPlanRegion: region,
    };
  }

  // Non-Coding-Plan — find API key from model providers
  const firstEnvKey = (openaiModels[0]?.envKey as string) || 'OPENAI_API_KEY';
  const apiKey = env[firstEnvKey] || '';

  if (!apiKey) {
    return null;
  }

  return {
    provider: 'api-key',
    apiKey,
    codingPlanRegion: 'china',
  };
}

/**
 * Clear persisted auth credentials from ~/.qwen/settings.json.
 * Removes API keys, auth type selection, and coding plan metadata
 * so runtime state matches the cleared VS Code settings.
 */
export function clearPersistedAuth(): void {
  try {
    const settings = readSettings();

    // Remove auth type selection
    const security = settings.security as Record<string, unknown> | undefined;
    if (security?.auth) {
      delete (security.auth as Record<string, unknown>).selectedType;
    }

    // Remove API keys
    const env = settings.env as Record<string, unknown> | undefined;
    if (env) {
      for (const plan of SUBSCRIPTION_PLAN_OPTIONS) {
        delete env[plan.envKey];
      }
      delete env['OPENAI_API_KEY'];
    }

    // Remove subscription plan metadata (legacy + new namespace)
    for (const plan of SUBSCRIPTION_PLAN_OPTIONS) {
      delete settings[plan.metadataKey];
    }
    const pm = settings.providerMetadata as Record<string, unknown> | undefined;
    if (pm) {
      delete pm['coding-plan'];
      delete pm['token-plan'];
    }

    writeSettings(settings);
  } catch (error) {
    console.error(
      '[settingsWriter] Failed to clear persisted auth credentials:',
      error,
    );
  }
}
