/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Protocols the custom provider runtime can speak. */
export type PresetProtocol =
  | 'openai'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini';

export type PresetGroup = 'qwencloud' | 'alibaba' | 'third-party' | 'custom';

export interface PresetEndpoint {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  /** Documentation shown in the API key step for this endpoint. */
  readonly documentationUrl?: string;
}

export interface PresetThinking {
  /** Selectable effort levels; empty means toggle-only thinking. */
  readonly efforts?: readonly string[];
  readonly defaultEffort?: string;
  /** Whether the user may turn thinking off. */
  readonly canDisable?: boolean;
}

export interface PresetModel {
  readonly id: string;
  readonly displayName?: string;
  readonly contextWindow?: number;
  readonly thinking?: PresetThinking;
  readonly vision?: boolean;
}

/** One provider entry offered by the connect-provider wizard. */
export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly protocol: PresetProtocol;
  /** Wire auth style; defaults to bearer when omitted. */
  readonly authType?: 'bearer' | 'api-key' | 'google-api-key';
  /** Environment variable the API key would live in as an alternative. */
  readonly envKey: string;
  /** Empty for the custom provider, where the user types the URL. */
  readonly endpoints: readonly PresetEndpoint[];
  readonly models: readonly PresetModel[];
  readonly supportsModelDiscovery: boolean;
  readonly apiKeyPlaceholder?: string;
  readonly validateApiKey?: (apiKey: string) => string | null;
  /** Provider display name; per-endpoint when it varies by region. */
  readonly modelNamePrefix: string | ((baseUrl: string) => string);
  readonly group: PresetGroup;
  readonly flowTitle: string;
  /** Label of the endpoint step: Platform for QwenCloud, Region otherwise. */
  readonly endpointStepTitle: string;
}

export interface BuildProviderEntryInput {
  readonly preset: ProviderPreset;
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly modelIds: readonly string[];
}

export interface ProviderSettingsEntry {
  readonly providerId: string;
  readonly value: Record<string, unknown>;
}
