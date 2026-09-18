/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Settings } from '../../config/settings.js';
import { deriveWebSocketBase } from '../../ui/voice/voice-stream-session.js';

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

/** A `modelProviders` entry that Live Voice may use as its upstream. */
export interface LiveRealtimeRoute {
  /** The `modelProviders` key the entry lives under. */
  provider: string;
  id: string;
  name?: string;
  baseUrl?: string;
  envKey?: string;
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
 * `modelProviders` entries flagged `realtimeOnly`. Callers pass settings
 * loaded WITHOUT workspace scope: a repository must not be able to add a
 * route and redirect microphone audio.
 */
export function listLiveRealtimeRoutes(
  settings: Settings,
): LiveRealtimeRoute[] {
  const providers = settings.modelProviders as
    | Record<string, unknown>
    | undefined;
  if (!providers || typeof providers !== 'object') return [];
  const routes: LiveRealtimeRoute[] = [];
  for (const [provider, models] of Object.entries(providers)) {
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      if (!model || typeof model !== 'object') continue;
      const entry = model as Record<string, unknown>;
      if (entry['realtimeOnly'] !== true) continue;
      if (typeof entry['id'] !== 'string' || !entry['id'].trim()) continue;
      routes.push({
        provider,
        id: entry['id'].trim(),
        ...(typeof entry['name'] === 'string' ? { name: entry['name'] } : {}),
        ...(typeof entry['baseUrl'] === 'string'
          ? { baseUrl: entry['baseUrl'].trim() }
          : {}),
        ...(typeof entry['envKey'] === 'string'
          ? { envKey: entry['envKey'].trim() }
          : {}),
      });
    }
  }
  return routes;
}

/**
 * Match `experimental.liveVoice.model` (`modelId` or `provider:modelId`)
 * against the realtime routes. `undefined` means "no route": the caller falls
 * back to the free-standing `liveVoice.endpoint` / `liveVoice.apiKey` fields.
 */
export function findLiveRealtimeRoute(
  settings: Settings,
  selector: string,
): LiveRealtimeRoute | undefined {
  const routes = listLiveRealtimeRoutes(settings);
  // Model ids may themselves contain ':', so try the whole selector as an id
  // before reading a provider prefix out of it.
  let matches = routes.filter((route) => route.id === selector);
  if (matches.length === 0) {
    const separator = selector.indexOf(':');
    if (separator > 0) {
      const provider = selector.slice(0, separator);
      const id = selector.slice(separator + 1);
      matches = routes.filter(
        (route) => route.provider === provider && route.id === id,
      );
    }
  }
  if (matches.length > 1) {
    throw new LiveProviderConfigError(
      `experimental.liveVoice.model '${selector}' matches more than one realtimeOnly route; qualify it as provider:modelId.`,
    );
  }
  return matches[0];
}

function readRouteApiKey(
  settings: Settings,
  envKey: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  // Object.hasOwn keeps an envKey naming an Object.prototype member (e.g.
  // "constructor") from being read as a value.
  const fromEnv = Object.hasOwn(env, envKey) ? env[envKey] : undefined;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  const settingsEnv = settings.env as Record<string, unknown> | undefined;
  const fromSettings =
    settingsEnv && Object.hasOwn(settingsEnv, envKey)
      ? settingsEnv[envKey]
      : undefined;
  return typeof fromSettings === 'string' && fromSettings.trim()
    ? fromSettings.trim()
    : undefined;
}

function resolveRouteCredential(
  settings: Settings,
  route: LiveRealtimeRoute,
  env: Readonly<Record<string, string | undefined>>,
): { endpoint: string; apiKey: string } {
  if (!route.baseUrl || !route.envKey) {
    throw new LiveProviderConfigError(
      `Live Voice model '${route.id}' must declare baseUrl and envKey in modelProviders.`,
    );
  }
  let derived: string;
  try {
    derived = `${deriveWebSocketBase(route.baseUrl)}/api-ws/v1/realtime`;
  } catch {
    throw new LiveProviderConfigError(
      `Live Voice model '${route.id}' has an invalid baseUrl.`,
    );
  }
  // Same allow-list as a hand-written endpoint: only DashScope over wss.
  const endpoint = validateRealtimeEndpoint(derived);
  const apiKey = readRouteApiKey(settings, route.envKey, env);
  if (!apiKey) {
    throw new LiveProviderConfigError(
      `Live Voice model '${route.id}' requires ${route.envKey}.`,
    );
  }
  return { endpoint, apiKey };
}

/**
 * Resolve the Realtime credential. When `liveVoice.model` names a
 * `realtimeOnly` route, the endpoint is derived from that route's `baseUrl`
 * and the key is read through its `envKey`; otherwise the free-standing
 * `liveVoice.endpoint` / `liveVoice.apiKey` fields are used as before. Chat
 * routes are never consulted. The returned API key is deliberately
 * non-enumerable.
 */
export function resolveLiveProviderCredential(
  settings: Settings,
  options: {
    apiKey?: string;
    allowDisabled?: boolean;
    /** Where a route's `envKey` is read from. Defaults to `process.env`. */
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
): LiveProviderCredential {
  const live = readLiveVoiceConfiguration(settings);
  if (!live.enabled && options.allowDisabled !== true) {
    throw new LiveProviderConfigError('Live Voice is disabled.');
  }
  const route = findLiveRealtimeRoute(settings, live.model);
  let endpoint: string;
  let apiKey: string;
  if (route) {
    ({ endpoint, apiKey } = resolveRouteCredential(
      settings,
      route,
      options.env ?? process.env,
    ));
  } else {
    const configuredKey = settings.experimental?.liveVoice?.apiKey;
    apiKey =
      options.apiKey?.trim() ||
      (typeof configuredKey === 'string' ? configuredKey.trim() : '');
    if (!apiKey) {
      throw new LiveProviderConfigError(
        'The DashScope Realtime API key is not configured.',
      );
    }
    endpoint = validateRealtimeEndpoint(live.endpoint);
  }
  const credential = {
    endpoint,
    realtimeModel: route?.id ?? live.model,
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
