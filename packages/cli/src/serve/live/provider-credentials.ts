/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Settings } from '../../config/settings.js';

export const DEFAULT_LIVE_VOICE_MODEL = 'qwen3.5-omni-plus-realtime';
export const DEFAULT_LIVE_ENDPOINT =
  'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
export const DEFAULT_LIVE_VOICE = 'Tina';
export const DEFAULT_LIVE_SHORTCUT = 'Command+E';

export interface LiveVoiceConfiguration {
  enabled: boolean;
  model: string;
  endpoint: string;
  voice: string;
  shortcut: string;
}

export interface LiveProviderCredential {
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

function readNonEmpty(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function readShortcut(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_LIVE_SHORTCUT;
  const shortcut = value.trim();
  return shortcut.length <= 128 ? shortcut : DEFAULT_LIVE_SHORTCUT;
}

export function readLiveVoiceConfiguration(
  settings: Settings,
): LiveVoiceConfiguration {
  const raw = settings.experimental?.liveVoice;
  return {
    enabled: raw?.enabled === true,
    model: readNonEmpty(raw?.model, DEFAULT_LIVE_VOICE_MODEL),
    endpoint: readNonEmpty(raw?.endpoint, DEFAULT_LIVE_ENDPOINT),
    voice: readNonEmpty(raw?.voice, DEFAULT_LIVE_VOICE),
    shortcut: readShortcut(raw?.shortcut),
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
    host === 'maas.aliyuncs.com' ||
    host.endsWith('.maas.aliyuncs.com')
  );
}

function hasCredentialQuery(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (/api.?key|authorization|token/i.test(name)) return true;
  }
  return false;
}

function validateRealtimeEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LiveProviderConfigError(
      'experimental.liveVoice.endpoint is invalid.',
    );
  }
  if (
    parsed.protocol !== 'wss:' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    hasCredentialQuery(parsed) ||
    !isDashScopeHost(parsed.hostname)
  ) {
    throw new LiveProviderConfigError(
      'experimental.liveVoice.endpoint must be a supported secure DashScope WebSocket endpoint.',
    );
  }
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

/**
 * Resolve the dedicated Realtime credential without consulting chat-model
 * providers. The returned API key is deliberately non-enumerable.
 */
export function resolveLiveProviderCredential(
  settings: Settings,
  options: {
    apiKey?: string;
    allowDisabled?: boolean;
  } = {},
): LiveProviderCredential {
  const live = readLiveVoiceConfiguration(settings);
  if (!live.enabled && options.allowDisabled !== true) {
    throw new LiveProviderConfigError('Live Voice is disabled.');
  }
  const configuredKey = settings.experimental?.liveVoice?.apiKey;
  const apiKey =
    options.apiKey?.trim() ||
    (typeof configuredKey === 'string' ? configuredKey.trim() : '');
  if (!apiKey) {
    throw new LiveProviderConfigError(
      'The DashScope Realtime API key is not configured.',
    );
  }
  const credential = {
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
