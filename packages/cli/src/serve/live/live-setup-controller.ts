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
  findLiveRealtimeRoute,
  listLiveRealtimeRoutes,
  LiveProviderConfigError,
  readLiveVoiceConfiguration,
  resolveLiveProviderCredential,
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
  model: string;
  voice: string;
  /** `realtimeOnly` routes from user-scope `modelProviders`, for a picker. */
  models: Array<{ id: string; provider: string; name?: string }>;
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
    return {
      v: 1,
      enabled: this.deps.getEnabled(),
      keyConfigured: this.hasUsableKey(settings),
      model: live.model,
      voice: live.voice,
      models: listLiveRealtimeRoutes(settings).map((route) => ({
        id: route.id,
        provider: route.provider,
        ...(route.name ? { name: route.name } : {}),
      })),
      shortcut: live.shortcut,
      install: this.deps.installer.getStatus(),
      live: this.deps.coordinator.getStatus(),
    };
  }

  private hasUsableKey(settings: Settings): boolean {
    try {
      const { model } = readLiveVoiceConfiguration(settings);
      // Free-standing path: unchanged, the stored key alone decides.
      if (!findLiveRealtimeRoute(settings, model)) {
        return configuredKey(settings).length > 0;
      }
      resolveLiveProviderCredential(settings, {
        allowDisabled: true,
        ...(this.deps.env ? { env: this.deps.env } : {}),
      });
      return true;
    } catch {
      return false;
    }
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
    const providerChanged =
      nextModel !== current.model || nextVoice !== current.voice;
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

    let usesRoute: boolean;
    try {
      usesRoute = findLiveRealtimeRoute(settings, nextModel) !== undefined;
    } catch (error) {
      throw new LiveSetupError(
        error instanceof LiveProviderConfigError
          ? error.message
          : 'The Live Voice model could not be resolved.',
        'invalid_live_model',
        400,
      );
    }
    // A realtimeOnly route brings its own key through envKey; only the
    // free-standing path needs liveVoice.apiKey.
    if (nextEnabled && !usesRoute && !nextKey) {
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
    if (nextEnabled) void this.deps.installer.ensureInstalled();
    return await this.getStatus();
  }
}
