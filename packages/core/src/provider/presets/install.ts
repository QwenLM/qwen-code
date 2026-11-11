/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

import { normalizeCustomProviderBaseUrl } from '../custom/baseUrl.js';
import type {
  BuildProviderEntryInput,
  PresetModel,
  ProviderPreset,
  ProviderSettingsEntry,
} from './types.js';

export class ProviderPresetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderPresetError';
  }
}

/** Stable provider id: presets keep theirs, custom providers hash protocol+URL. */
export function providerIdForPreset(
  preset: ProviderPreset,
  baseUrl?: string,
): string {
  if (preset.group !== 'custom') return preset.id;
  const key = `${preset.protocol}\0${normalizeCustomProviderBaseUrl(baseUrl) ?? ''}`;
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 10);
  return `custom-${digest}`;
}

/**
 * Translate a preset choice into one `settings.providers.<id>` entry.
 *
 * The wizard writes the API key into the entry instead of an environment
 * variable so a connection works immediately in the same session.
 */
export function buildProviderSettingsEntry(
  input: BuildProviderEntryInput,
): ProviderSettingsEntry {
  const { preset } = input;
  const rawBaseUrl = input.baseUrl ?? preset.endpoints[0]?.url ?? '';
  if (!rawBaseUrl.trim()) {
    throw new ProviderPresetError('A base URL is required for this provider.');
  }
  const baseUrl = normalizeCustomProviderBaseUrl(rawBaseUrl);
  if (!baseUrl) {
    throw new ProviderPresetError(
      'baseUrl must be an http(s) URL without credentials, query, or fragment.',
    );
  }
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new ProviderPresetError('An API key is required.');
  }
  const keyError = preset.validateApiKey?.(apiKey);
  if (keyError) {
    throw new ProviderPresetError(keyError);
  }
  const modelIds = [...new Set(input.modelIds.map((id) => id.trim()))].filter(
    Boolean,
  );
  if (modelIds.length === 0) {
    throw new ProviderPresetError('Choose at least one model.');
  }

  const presetModels = new Map(preset.models.map((model) => [model.id, model]));
  const models = modelIds.map((id) =>
    buildModelEntry(id, presetModels.get(id)),
  );
  return {
    providerId: providerIdForPreset(preset, baseUrl),
    value: {
      protocol: preset.protocol,
      ...(preset.authType !== undefined
        ? { authType: preset.authType }
        : preset.protocol === 'gemini'
          ? { authType: 'google-api-key' }
          : {}),
      baseUrl,
      apiKey,
      displayName:
        (typeof preset.modelNamePrefix === 'function'
          ? preset.modelNamePrefix(baseUrl)
          : preset.modelNamePrefix) || displayNameForUrl(baseUrl),
      models,
    },
  };
}

function buildModelEntry(
  modelId: string,
  model: PresetModel | undefined,
): Record<string, unknown> {
  const thinking =
    model?.thinking?.efforts && model.thinking.efforts.length > 0
      ? {
          modes: ['enabled'],
          supportsEffort: true,
          supportedEffortLevels: [...model.thinking.efforts],
        }
      : undefined;
  return {
    model: modelId,
    ...(model?.displayName ? { displayName: model.displayName } : {}),
    ...(model?.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model?.vision || thinking
      ? {
          capabilities: {
            ...(model?.vision ? { vision: true } : {}),
            ...(thinking ? { thinking } : {}),
          },
        }
      : {}),
  };
}

function displayNameForUrl(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return 'Custom Provider';
  }
}
