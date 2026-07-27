/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  resolveProviderProtocol,
  type ProviderModelConfig,
} from '@qwen-code/qwen-code-core';
import type { Settings } from '../../config/settings.js';

export const DEFAULT_LIVE_VOICE_MODEL = 'qwen3.5-omni-plus-realtime';
export const DEFAULT_LIVE_PROVIDER_MODEL = 'openai:qwen3.8-max-preview';
export const DEFAULT_LIVE_ENDPOINT =
  'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
export const DEFAULT_LIVE_VOICE = 'Tina';

export interface LiveVoiceConfiguration {
  enabled: boolean;
  model: string;
  providerModel: string;
  endpoint: string;
  voice: string;
}

export interface LiveProviderCredential {
  providerId: string;
  authType: AuthType;
  modelId: string;
  baseUrl: string;
  envKey: string;
  endpoint: string;
  realtimeModel: string;
  voice: string;
  /** Non-enumerable so routine JSON/log serialization cannot expose it. */
  apiKey: string;
}

export class LiveProviderConfigError extends Error {
  readonly code = 'live_provider_config' as const;

  constructor(message: string) {
    super(message);
    this.name = 'LiveProviderConfigError';
  }
}

const AUTH_TYPES = new Set<string>(Object.values(AuthType));

function readNonEmpty(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : fallback;
}

export function readLiveVoiceConfiguration(
  settings: Settings,
): LiveVoiceConfiguration {
  const raw = settings.general?.liveVoice;
  return {
    enabled: raw?.enabled === true,
    model: readNonEmpty(raw?.model, DEFAULT_LIVE_VOICE_MODEL),
    providerModel: readNonEmpty(
      raw?.providerModel,
      DEFAULT_LIVE_PROVIDER_MODEL,
    ),
    endpoint: readNonEmpty(raw?.endpoint, DEFAULT_LIVE_ENDPOINT),
    voice: readNonEmpty(raw?.voice, DEFAULT_LIVE_VOICE),
  };
}

function isDashScopeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'dashscope.aliyuncs.com' ||
    host === 'dashscope-intl.aliyuncs.com' ||
    host === 'dashscope-us.aliyuncs.com' ||
    host.endsWith('.dashscope.aliyuncs.com') ||
    host.endsWith('.dashscope-intl.aliyuncs.com') ||
    host.endsWith('.dashscope-us.aliyuncs.com') ||
    host.endsWith('.maas.aliyuncs.com')
  );
}

function hasCredentialQuery(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (/api.?key|authorization|token/i.test(name)) return true;
  }
  return false;
}

function validateProviderBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LiveProviderConfigError(
      'The selected Live provider has an invalid baseUrl.',
    );
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    hasCredentialQuery(parsed) ||
    !isDashScopeHost(parsed.hostname)
  ) {
    throw new LiveProviderConfigError(
      'The selected Live provider must use a supported HTTPS DashScope endpoint.',
    );
  }
  return parsed.toString().replace(/\/$/, '');
}

function validateRealtimeEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LiveProviderConfigError('general.liveVoice.endpoint is invalid.');
  }
  if (
    parsed.protocol !== 'wss:' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    hasCredentialQuery(parsed) ||
    !isDashScopeHost(parsed.hostname)
  ) {
    throw new LiveProviderConfigError(
      'general.liveVoice.endpoint must be a supported secure DashScope WebSocket endpoint.',
    );
  }
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

interface ProviderCandidate {
  providerId: string;
  authType: AuthType;
  model: ProviderModelConfig;
}

function parseProviderSelector(selector: string): {
  authType?: AuthType;
  modelId: string;
} {
  const separator = selector.indexOf(':');
  if (separator < 0) return { modelId: selector };
  const prefix = selector.slice(0, separator).trim();
  if (!AUTH_TYPES.has(prefix)) return { modelId: selector };
  const modelId = selector.slice(separator + 1).trim();
  if (!modelId) {
    throw new LiveProviderConfigError(
      'general.liveVoice.providerModel must include a model ID after the auth type.',
    );
  }
  return { authType: prefix as AuthType, modelId };
}

function findProviderCandidate(
  settings: Settings,
  selector: string,
): ProviderCandidate {
  const parsed = parseProviderSelector(selector);
  const candidates: ProviderCandidate[] = [];
  for (const [providerId, models] of Object.entries(
    settings.modelProviders ?? {},
  )) {
    if (!Array.isArray(models)) continue;
    const authType = resolveProviderProtocol(
      providerId,
      settings.providerProtocol,
    );
    if (!authType || (parsed.authType && authType !== parsed.authType)) {
      continue;
    }
    for (const model of models) {
      if (model.id === parsed.modelId) {
        candidates.push({ providerId, authType, model });
      }
    }
  }
  if (candidates.length === 0) {
    throw new LiveProviderConfigError(
      `general.liveVoice.providerModel does not match a configured provider entry.`,
    );
  }
  if (candidates.length > 1) {
    throw new LiveProviderConfigError(
      'general.liveVoice.providerModel is ambiguous; select a model ID that resolves to exactly one provider entry.',
    );
  }
  return candidates[0]!;
}

function readApiKey(
  settings: Settings,
  env: Readonly<Record<string, string | undefined>>,
  envKey: string,
): string | undefined {
  const envValue = env[envKey]?.trim();
  if (envValue) return envValue;
  const settingsValue = (settings.env as Record<string, unknown> | undefined)?.[
    envKey
  ];
  return typeof settingsValue === 'string' && settingsValue.trim().length > 0
    ? settingsValue.trim()
    : undefined;
}

/**
 * Resolve the explicit Live provider without consulting the currently selected
 * chat model. The returned API key is deliberately non-enumerable.
 */
export function resolveLiveProviderCredential(
  settings: Settings,
  options: {
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
): LiveProviderCredential {
  const live = readLiveVoiceConfiguration(settings);
  if (!live.enabled) {
    throw new LiveProviderConfigError('Live Voice is disabled.');
  }
  const candidate = findProviderCandidate(settings, live.providerModel);
  const envKey = candidate.model.envKey?.trim();
  if (!envKey) {
    throw new LiveProviderConfigError(
      'The selected Live provider does not declare an envKey.',
    );
  }
  const apiKey = readApiKey(settings, options.env ?? process.env, envKey);
  if (!apiKey) {
    throw new LiveProviderConfigError(
      `The selected Live provider credential ${envKey} is not configured.`,
    );
  }
  const baseUrl = candidate.model.baseUrl?.trim();
  if (!baseUrl) {
    throw new LiveProviderConfigError(
      'The selected Live provider does not declare a baseUrl.',
    );
  }
  const credential = {
    providerId: candidate.providerId,
    authType: candidate.authType,
    modelId: candidate.model.id,
    baseUrl: validateProviderBaseUrl(baseUrl),
    envKey,
    endpoint: validateRealtimeEndpoint(live.endpoint),
    realtimeModel: live.model,
    voice: live.voice,
  } as LiveProviderCredential;
  Object.defineProperty(credential, 'apiKey', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: apiKey,
  });
  return credential;
}
