/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { ModelsConfig } from '@qwen-code/qwen-code-core';
import { loadSettings } from '../../config/settings.js';
import type { LoadedSettings } from '../../config/settings.js';
import {
  getAuthTypeFromEnv,
  resolveCliGenerationConfig,
} from '../../utils/modelConfigUtils.js';
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
function buildModelsConfig(settings: LoadedSettings): ModelsConfig {
  const merged = settings.merged;
  const selectedAuthType =
    merged.security?.auth?.selectedType ?? getAuthTypeFromEnv();
  const resolvedCliConfig = resolveCliGenerationConfig({
    argv: {},
    settings: merged,
    selectedAuthType,
    env: process.env as Record<string, string | undefined>,
  });
  return new ModelsConfig({
    initialAuthType: selectedAuthType,
    modelProvidersConfig: merged.modelProviders,
    generationConfig: resolvedCliConfig.generationConfig,
    generationConfigSources: resolvedCliConfig.sources,
  });
}

/**
 * Load and validate the workspace's voice configuration. Throws when voice is
 * not usable (no `voiceModel` configured, model not transcribable, missing
 * baseUrl/apiKey) — the throw message is a safe, user-facing reason.
 */
export function loadDaemonVoiceContext(
  workspaceCwd: string,
): DaemonVoiceContext {
  const settings = loadSettings(workspaceCwd);
  const voiceModel = readVoiceModel(settings);
  if (!voiceModel) {
    throw new Error('No voice model is configured for this workspace.');
  }
  const models = buildModelsConfig(settings);
  // Validates transcribable + baseUrl + apiKey presence (throws otherwise).
  resolveVoiceTranscriptionConfig({ config: models, settings, voiceModel });
  return {
    settings,
    models,
    voiceModel,
    streaming: isStreamingVoiceModel(voiceModel),
  };
}
