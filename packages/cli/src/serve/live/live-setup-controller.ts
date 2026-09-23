/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Settings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import type { LiveHostCoordinator } from './live-host-coordinator.js';
import type {
  LiveHostInstaller,
  LiveHostInstallStatus,
} from './live-host-installer.js';
import {
  DEFAULT_LIVE_ENDPOINT,
  findLiveRealtimeRoute,
  listLiveRealtimeRoutes,
  LiveProviderConfigError,
  normalizeLiveRealtimeEndpoint,
  readLiveVoiceConfiguration,
  resolveLiveProviderCredential,
  resolveLiveRouteEndpoint,
  type LiveProviderCredential,
} from './provider-credentials.js';
import { openQwenRealtimeSession } from './qwen-realtime-session.js';
import type { LiveStatus } from './types.js';

export interface LiveSetupStatus {
  v: 1;
  enabled: boolean;
  /**
   * Whether the selected model has a usable key: its route's `envKey` when
   * `model` names a `realtimeOnly` route, else `liveVoice.apiKey`.
   */
  keyConfigured: boolean;
  /**
   * Where the selected model's key comes from. `route`: the `envKey` of its
   * `realtimeOnly` route — `liveVoice.apiKey` is unused and cannot be set.
   * `settings`: the free-standing `liveVoice.apiKey`.
   */
  keySource: 'route' | 'settings';
  /** The environment variable a `route` key is read from. Never its value. */
  keyEnv?: string;
  /**
   * Why the resolved route cannot produce a credential (rejected `baseUrl`,
   * missing `envKey`). Absent when the credential resolves, and when the
   * only problem is the unset `keyEnv` variable — the card names that one
   * itself. Never carries the key's value.
   */
  keyError?: string;
  /**
   * Whether a clear-text `liveVoice.apiKey` is stored (never its value), so
   * the card can offer `clear` even when the selected model cannot use it.
   */
  storedKey: boolean;
  /**
   * Why `model` cannot be resolved (ambiguous id, provider without such a
   * route). Absent when it resolves, to a route or to the free-standing path.
   */
  modelError?: string;
  model: string;
  voice: string;
  /**
   * The Realtime WebSocket endpoint the selected model connects to. Follows
   * `keySource`: a `route` derives it from its `baseUrl` and it cannot be
   * set; `settings` reads `liveVoice.endpoint` (default: Beijing DashScope).
   */
  endpoint: string;
  /** Why `endpoint` would be refused at call time; absent when it is valid. */
  endpointError?: string;
  /** `realtimeOnly` routes from user-scope `modelProviders`, for a picker. */
  models: Array<{ id: string; provider: string; name?: string }>;
  /** Whether the native macOS Host can attach on this daemon. */
  nativeHost: boolean;
  shortcut: string;
  install: LiveHostInstallStatus;
  live: LiveStatus;
}

export type LiveSetupApiKeyMutation =
  | { operation: 'replace'; value: string }
  | { operation: 'clear' };

export interface LiveSetupUpdate {
  enabled?: boolean;
  shortcut?: string;
  apiKey?: LiveSetupApiKeyMutation;
  /** `modelId` or `provider:modelId`. */
  model?: string;
  voice?: string;
  /**
   * A Realtime WebSocket URL or an OpenAI-compatible HTTPS base URL; stored
   * as the normalized `wss://…/api-ws/v1/realtime` form.
   */
  endpoint?: string;
}

interface SettingsWrite {
  scope: SettingScope;
  key: string;
  value: unknown;
}

export class LiveSetupError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LiveSetupError';
  }
}

export interface LiveSetupControllerDeps {
  loadSettings: () => Settings;
  persistSettings?: (writes: SettingsWrite[]) => Promise<void>;
  coordinator: LiveHostCoordinator;
  installer: LiveHostInstaller;
  getEnabled: () => boolean;
  setEnabled: (enabled: boolean) => Promise<void>;
  validateCredential?: (credential: LiveProviderCredential) => Promise<void>;
  /** Where a realtime route's `envKey` is read from. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to true: the native Host was the only endpoint before. */
  nativeHost?: boolean;
}

async function validateCredential(
  credential: LiveProviderCredential,
): Promise<void> {
  const session = await openQwenRealtimeSession({
    endpoint: credential.endpoint,
    apiKey: credential.apiKey,
    model: credential.realtimeModel,
    voice: credential.voice,
    callEpoch: `setup-${randomUUID()}`,
  });
  session.close({ discardPendingInput: true });
}

function configuredKey(settings: Settings): string {
  const value = settings.experimental?.liveVoice?.apiKey;
  return typeof value === 'string' ? value.trim() : '';
}

function candidateSettings(
  settings: Settings,
  enabled: boolean,
  apiKey: string,
  shortcut: string,
  model: string,
  voice: string,
  endpoint: string,
): Settings {
  return {
    ...settings,
    experimental: {
      ...settings.experimental,
      liveVoice: {
        ...settings.experimental?.liveVoice,
        enabled,
        apiKey,
        shortcut,
        model,
        voice,
        endpoint,
      },
    },
  } as Settings;
}

export class LiveSetupController {
  private mutation: Promise<void> = Promise.resolve();
  private installerScanned = false;

  constructor(private readonly deps: LiveSetupControllerDeps) {}

  async getStatus(): Promise<LiveSetupStatus> {
    if (!this.installerScanned) {
      this.installerScanned = true;
      void this.deps.installer.refresh();
    }
    const settings = this.deps.loadSettings();
    const live = readLiveVoiceConfiguration(settings);
    let route: ReturnType<typeof findLiveRealtimeRoute>;
    let modelError: string | undefined;
    try {
      route = findLiveRealtimeRoute(settings, live.model);
    } catch (error) {
      modelError =
        error instanceof LiveProviderConfigError
          ? error.message
          : 'The Live Voice model could not be resolved.';
    }
    let endpoint = live.endpoint;
    let endpointError: string | undefined;
    if (modelError === undefined) {
      try {
        endpoint = route
          ? resolveLiveRouteEndpoint(route)
          : normalizeLiveRealtimeEndpoint(live.endpoint);
      } catch (error) {
        // A route's broken baseUrl is already named through keyError; show
        // what the route declares rather than the unused free-standing value.
        if (route) {
          endpoint = route.baseUrl ?? '';
        } else {
          endpointError =
            error instanceof LiveProviderConfigError
              ? error.message
              : 'experimental.liveVoice.endpoint is invalid.';
        }
      }
    }
    let keyConfigured: boolean;
    let keyError: string | undefined;
    if (route) {
      try {
        resolveLiveProviderCredential(settings, {
          allowDisabled: true,
          ...(this.deps.env ? { env: this.deps.env } : {}),
        });
        keyConfigured = true;
      } catch (error) {
        keyConfigured = false;
        // The merely-unset envKey is the one cause the card explains with
        // its own "not set" sentence; anything else must be named, or the
        // card asserts a missing variable that is actually set.
        if (
          error instanceof LiveProviderConfigError &&
          error.reason !== 'env_key_missing'
        ) {
          keyError = error.message;
        }
      }
    } else {
      // An unresolvable model has no usable key; the free-standing path is
      // decided by the stored key alone.
      keyConfigured =
        modelError === undefined && configuredKey(settings).length > 0;
    }
    return {
      v: 1,
      enabled: this.deps.getEnabled(),
      keyConfigured,
      keySource: route ? 'route' : 'settings',
      ...(route?.envKey ? { keyEnv: route.envKey } : {}),
      ...(keyError ? { keyError } : {}),
      storedKey: configuredKey(settings).length > 0,
      ...(modelError ? { modelError } : {}),
      model: live.model,
      voice: live.voice,
      endpoint,
      ...(endpointError ? { endpointError } : {}),
      models: listLiveRealtimeRoutes(settings).map((route) => ({
        id: route.id,
        provider: route.provider,
        ...(route.name ? { name: route.name } : {}),
      })),
      nativeHost: this.deps.nativeHost !== false,
      shortcut: live.shortcut,
      install: this.deps.installer.getStatus(),
      live: this.deps.coordinator.getStatus(),
    };
  }

  update(update: LiveSetupUpdate): Promise<LiveSetupStatus> {
    const operation = this.mutation.then(() => this.applyUpdate(update));
    this.mutation = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async retryInstall(): Promise<LiveSetupStatus> {
    if (!this.deps.getEnabled()) {
      throw new LiveSetupError(
        'Enable Live Voice before installing Qwen Live Host.',
        'live_setup_disabled',
        409,
      );
    }
    void this.deps.installer.ensureInstalled(true);
    return await this.getStatus();
  }

  async launchHost(): Promise<LiveSetupStatus> {
    if (!this.deps.getEnabled()) {
      throw new LiveSetupError(
        'Enable Live Voice before launching Qwen Live Host.',
        'live_setup_disabled',
        409,
      );
    }
    await this.deps.installer.launch();
    return await this.getStatus();
  }

  private async applyUpdate(update: LiveSetupUpdate): Promise<LiveSetupStatus> {
    if (!this.deps.persistSettings) {
      throw new LiveSetupError(
        'Live Voice settings persistence is unavailable.',
        'live_setup_persistence_unavailable',
        501,
      );
    }
    const settings = this.deps.loadSettings();
    const current = readLiveVoiceConfiguration(settings);
    const nextEnabled = update.enabled ?? current.enabled;
    const nextShortcut = update.shortcut ?? current.shortcut;
    const nextModel = update.model?.trim() ?? current.model;
    const nextVoice = update.voice?.trim() ?? current.voice;
    if (!nextModel || !nextVoice) {
      throw new LiveSetupError(
        'model and voice cannot be empty.',
        'invalid_live_model',
        400,
      );
    }
    let nextEndpoint = current.endpoint;
    if (update.endpoint !== undefined) {
      try {
        nextEndpoint = normalizeLiveRealtimeEndpoint(update.endpoint);
      } catch (error) {
        throw new LiveSetupError(
          error instanceof LiveProviderConfigError
            ? error.message
            : 'experimental.liveVoice.endpoint is invalid.',
          'invalid_live_endpoint',
          400,
        );
      }
    }
    const providerChanged =
      nextModel !== current.model ||
      nextVoice !== current.voice ||
      nextEndpoint !== current.endpoint;
    const currentKey = configuredKey(settings);
    const nextKey =
      update.apiKey?.operation === 'replace'
        ? update.apiKey.value.trim()
        : update.apiKey?.operation === 'clear'
          ? ''
          : currentKey;

    if (nextShortcut.trim().length > 128) {
      throw new LiveSetupError(
        'The Live shortcut is too long.',
        'invalid_live_shortcut',
        400,
      );
    }
    if (update.apiKey?.operation === 'replace' && !nextKey) {
      throw new LiveSetupError(
        'The DashScope Realtime API key cannot be empty.',
        'invalid_live_api_key',
        400,
      );
    }

    // A broken route configuration (ambiguous id, deleted route) fails only
    // the updates that depend on the provider. Turning Live Voice off,
    // clearing the key or changing the shortcut must keep working, otherwise
    // the only way out is editing settings.json by hand.
    const needsProvider =
      (update.enabled === true && !current.enabled) ||
      update.apiKey?.operation === 'replace' ||
      providerChanged;
    let usesRoute = false;
    let routeError: unknown;
    try {
      usesRoute = findLiveRealtimeRoute(settings, nextModel) !== undefined;
    } catch (error) {
      routeError = error;
    }
    if (routeError !== undefined && needsProvider) {
      throw new LiveSetupError(
        routeError instanceof LiveProviderConfigError
          ? routeError.message
          : 'The Live Voice model could not be resolved.',
        'invalid_live_model',
        400,
      );
    }
    // A route reads its key through envKey and ignores liveVoice.apiKey, so a
    // submitted key could never be validated: the check would run against the
    // route's key, pass, and then store the unverified value in clear text.
    if (usesRoute && update.apiKey?.operation === 'replace') {
      throw new LiveSetupError(
        `Live Voice model '${nextModel}' takes its key from its modelProviders route; experimental.liveVoice.apiKey is not used.`,
        'live_api_key_unused',
        400,
      );
    }
    // Likewise a route connects to the endpoint its baseUrl derives; a stored
    // liveVoice.endpoint would be unused and never validated.
    if (usesRoute && update.endpoint !== undefined) {
      throw new LiveSetupError(
        `Live Voice model '${nextModel}' takes its endpoint from its modelProviders route baseUrl; experimental.liveVoice.endpoint is not used.`,
        'live_endpoint_unused',
        400,
      );
    }
    // A realtimeOnly route brings its own key through envKey; only the
    // free-standing path needs liveVoice.apiKey.
    if (nextEnabled && !usesRoute && !nextKey && routeError === undefined) {
      throw new LiveSetupError(
        'Configure the DashScope Realtime API key before enabling Live Voice.',
        'live_api_key_required',
        400,
      );
    }

    if (
      nextEnabled &&
      ((update.enabled === true && !current.enabled) ||
        update.apiKey?.operation === 'replace' ||
        providerChanged)
    ) {
      let credential: LiveProviderCredential;
      try {
        credential = resolveLiveProviderCredential(
          candidateSettings(
            settings,
            nextEnabled,
            nextKey,
            nextShortcut,
            nextModel,
            nextVoice,
            nextEndpoint,
          ),
          {
            apiKey: nextKey,
            allowDisabled: true,
            ...(this.deps.env ? { env: this.deps.env } : {}),
          },
        );
      } catch (error) {
        if (!(error instanceof LiveProviderConfigError)) throw error;
        throw new LiveSetupError(error.message, 'invalid_live_model', 400);
      }
      try {
        await (this.deps.validateCredential ?? validateCredential)(credential);
      } catch (error) {
        throw new LiveSetupError(
          error instanceof Error
            ? error.message
            : 'The DashScope Realtime API key could not be validated.',
          'live_provider_validation_failed',
          409,
        );
      }
    }

    const writes: SettingsWrite[] = [];
    if (update.apiKey) {
      writes.push({
        scope: SettingScope.User,
        key: 'experimental.liveVoice.apiKey',
        value: nextKey || undefined,
      });
    }
    if (update.model !== undefined) {
      writes.push({
        scope: SettingScope.User,
        key: 'experimental.liveVoice.model',
        value: nextModel,
      });
    }
    if (update.endpoint !== undefined) {
      writes.push({
        scope: SettingScope.User,
        key: 'experimental.liveVoice.endpoint',
        // The default stays implicit, so a later default change reaches it.
        value:
          nextEndpoint === DEFAULT_LIVE_ENDPOINT ? undefined : nextEndpoint,
      });
    }
    if (update.voice !== undefined) {
      writes.push({
        scope: SettingScope.User,
        key: 'experimental.liveVoice.voice',
        value: nextVoice,
      });
    }
    if (update.shortcut !== undefined) {
      writes.push({
        scope: SettingScope.User,
        key: 'experimental.liveVoice.shortcut',
        value: nextShortcut,
      });
    }
    if (update.enabled !== undefined) {
      writes.push({
        scope: SettingScope.User,
        key: 'experimental.liveVoice.enabled',
        value: nextEnabled,
      });
    }
    if (writes.length === 0) return await this.getStatus();

    const previousShortcut = current.shortcut;
    if (update.shortcut !== undefined) {
      const status = this.deps.coordinator.getStatus();
      if (status.host) {
        await this.deps.coordinator.setShortcut(nextShortcut);
      } else {
        this.deps.coordinator.setConfiguredShortcut(nextShortcut);
      }
    }
    try {
      await this.deps.persistSettings(writes);
    } catch (error) {
      if (update.shortcut !== undefined) {
        try {
          if (this.deps.coordinator.getStatus().host) {
            await this.deps.coordinator.setShortcut(previousShortcut);
          } else {
            this.deps.coordinator.setConfiguredShortcut(previousShortcut);
          }
        } catch {
          /* persisted state is unchanged and remains authoritative */
        }
      }
      throw error;
    }

    if (
      update.enabled !== undefined &&
      nextEnabled !== this.deps.getEnabled()
    ) {
      try {
        await this.deps.setEnabled(nextEnabled);
      } catch (error) {
        await this.deps.persistSettings([
          {
            scope: SettingScope.User,
            key: 'experimental.liveVoice.enabled',
            value: !nextEnabled,
          },
        ]);
        throw error;
      }
    }
    if (nextEnabled && this.deps.nativeHost !== false) {
      void this.deps.installer.ensureInstalled();
    }
    return await this.getStatus();
  }
}
