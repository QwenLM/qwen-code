/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ModelsConfig,
  type CredentialProvider,
  type CredentialStore,
} from '@qwen-code/qwen-code-core';
import { loadSettings } from '../../config/settings.js';
import type { LoadedSettings } from '../../config/settings.js';
import {
  getAuthTypeFromEnv,
  resolveCliGenerationConfig,
} from '../../utils/modelConfigUtils.js';
import { snapshotProcessEnv } from '../env-snapshot.js';
import {
  isStreamingVoiceModel,
  resolveVoiceTranscriptionConfig,
  type VoiceModelLookup,
} from '../../services/voice-transcriber.js';

/**
 * Fully-validated voice context for a daemon workspace. The browser captures
 * audio and streams raw PCM to `/voice/stream`; the daemon resolves the
 * configured voice model here (reusing the CLI voice resolver) and transcribes
 * server-side so provider credentials never reach the client.
 */
export interface DaemonVoiceContext {
  settings: LoadedSettings;
  /** A `ModelsConfig` — satisfies the resolver's structural `getAllConfiguredModels`. */
  models: VoiceModelLookup;
  env?: Readonly<Record<string, string | undefined>>;
  voiceModel: string;
  /** True for realtime models (open an upstream WS); false → batch on stop. */
  streaming: boolean;
}

function readVoiceModel(settings: LoadedSettings): string | undefined {
  const raw = (settings.merged as { voiceModel?: unknown }).voiceModel;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build a `ModelsConfig` from workspace settings, mirroring
 * `workspace-providers-status.ts` so the daemon resolves the same configured
 * models the CLI would — without constructing a full CLI `Config`.
 */
function buildModelsConfig(
  settings: LoadedSettings,
  env: Readonly<Record<string, string | undefined>>,
  credentialProvider?: CredentialProvider,
): ModelsConfig {
  const merged = settings.merged;
  const selectedAuthType =
    merged.security?.auth?.selectedType ?? getAuthTypeFromEnv(env);
  const resolvedCliConfig = resolveCliGenerationConfig({
    argv: {},
    settings: merged,
    selectedAuthType,
    env,
  });
  return new ModelsConfig({
    initialAuthType: selectedAuthType,
    modelProvidersConfig: merged.modelProviders,
    credentialProvider,
    generationConfig: resolvedCliConfig.generationConfig,
    generationConfigSources: resolvedCliConfig.sources,
  });
}

/**
 * Merge credential store snapshot into an env object. The daemon scrubs
 * QWEN_CUSTOM_API_KEY_* from process.env; this restores them for the voice
 * transcription resolver (which reads credentials from the env arg, not
 * ModelsConfig.credentialProvider). Store keys take precedence.
 */
function mergeCredentialStore(
  env: Readonly<Record<string, string | undefined>>,
  store?: CredentialStore,
): Record<string, string | undefined> {
  if (!store) return { ...env };
  return { ...env, ...store.snapshot() };
}

/**
 * Load and validate the workspace's voice configuration. Throws when voice is
 * not usable (no `voiceModel` configured, model not transcribable, missing
 * baseUrl/apiKey) — the throw message is a safe, user-facing reason.
 */
export function loadDaemonVoiceContext(
  workspaceCwd: string,
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    credentialStore?: CredentialStore;
  } = {},
): DaemonVoiceContext {
  const settings = loadSettings(
    workspaceCwd,
    options.env ? { skipLoadEnvironment: true } : true,
  );
  const voiceModel = readVoiceModel(settings);
  if (!voiceModel) {
    throw new Error('No voice model is configured for this workspace.');
  }
  // Merge credential store so the voice resolver can find custom-provider
  // keys that were scrubbed from process.env.
  const baseEnv = options.env ?? snapshotProcessEnv();
  const mergedEnv = mergeCredentialStore(baseEnv, options.credentialStore);
  const models = buildModelsConfig(settings, baseEnv);
  // Validates transcribable + baseUrl + apiKey presence (throws otherwise).
  // Uses mergedEnv so custom-provider envKeys resolve to store credentials.
  resolveVoiceTranscriptionConfig({
    config: models,
    settings,
    voiceModel,
    env: mergedEnv,
  });
  return {
    settings,
    models,
    // Downstream transcribers read credentials from this env; use mergedEnv
    // so custom-provider keys (from the store) are available.
    env: mergedEnv,
    voiceModel,
    streaming: isStreamingVoiceModel(voiceModel),
  };
}
