/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { getPlugin } from '../commands/channel/channel-registry.js';
import { loadSettings, saveSettings } from '../config/settings.js';

export type ChannelSecretUpdate =
  | { operation: 'preserve' }
  | { operation: 'replace'; value: string }
  | { operation: 'clear' };

export interface ChannelSettingsSnapshot {
  revision: string;
  channels: Record<string, Record<string, unknown>>;
  startupNames: string[];
}

export interface ChannelSettingsMutationOptions {
  expectedRevision: string;
}

export interface ChannelSettingsUpsertOptions
  extends ChannelSettingsMutationOptions {
  config: Record<string, unknown> & { type: string };
  secrets?: Record<string, ChannelSecretUpdate>;
}

export class ChannelSettingsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelSettingsError';
  }
}

function revisionOf(
  channels: unknown,
  startupNames: readonly string[],
): string {
  return createHash('sha256')
    .update(JSON.stringify({ channels, startupNames }))
    .digest('hex');
}

function applySecretUpdate(
  current: unknown,
  update: ChannelSecretUpdate,
): unknown {
  if (update.operation === 'preserve') return current;
  if (update.operation === 'clear') return undefined;
  if (typeof update.value !== 'string' || update.value.length === 0) {
    throw invalidSecret('Secret replacements must be non-empty strings.');
  }
  return update.value;
}

function invalidSecret(message: string): ChannelSettingsError {
  return new ChannelSettingsError('channel_settings_invalid_secret', message);
}

function workspaceValues(workspaceCwd: string): {
  channels: Record<string, Record<string, unknown>>;
  startupNames: string[];
} {
  const settings = loadSettings(workspaceCwd, { skipLoadEnvironment: true })
    .workspace.settings;
  const channels =
    typeof settings.channels === 'object' &&
    settings.channels !== null &&
    !Array.isArray(settings.channels)
      ? (settings.channels as Record<string, Record<string, unknown>>)
      : {};
  const startupNames = Array.isArray(settings.serve?.channels)
    ? settings.serve.channels.filter(
        (name): name is string => typeof name === 'string',
      )
    : [];
  return { channels, startupNames };
}

export class WorkspaceChannelSettingsStore {
  constructor(private readonly workspaceCwd: string) {}

  snapshot(): ChannelSettingsSnapshot {
    const { channels, startupNames } = workspaceValues(this.workspaceCwd);
    return {
      revision: revisionOf(channels, startupNames),
      channels: { ...channels },
      startupNames: [...startupNames],
    };
  }

  async upsert(
    name: string,
    options: ChannelSettingsUpsertOptions,
  ): Promise<ChannelSettingsSnapshot> {
    const plugin = await getPlugin(options.config.type);
    if (!plugin?.management) {
      throw new ChannelSettingsError(
        'channel_settings_unmanageable',
        `Channel type "${options.config.type}" does not provide safe management metadata.`,
      );
    }
    const secretKeys = new Set(
      plugin.management.fields
        .filter((field) => field.kind === 'secret')
        .map((field) => field.key),
    );
    const secretUpdates = options.secrets ?? {};
    for (const key of Object.keys(secretUpdates)) {
      if (!secretKeys.has(key)) {
        throw invalidSecret(
          `Channel type "${options.config.type}" does not declare "${key}" as a secret.`,
        );
      }
    }
    for (const key of secretKeys) {
      if (Object.hasOwn(options.config, key)) {
        throw invalidSecret(
          `Secret "${key}" must use an explicit preserve, replace, or clear operation.`,
        );
      }
    }

    const current = this.assertRevision(options.expectedRevision);
    const previous = current.channels[name] ?? {};
    const nextConfig: Record<string, unknown> = { ...options.config };
    for (const key of secretKeys) {
      const update = secretUpdates[key] ?? { operation: 'preserve' };
      const value = applySecretUpdate(previous[key], update);
      if (value !== undefined) nextConfig[key] = value;
    }

    const channels = { ...current.channels, [name]: nextConfig };
    const workspaceFile = loadSettings(this.workspaceCwd, {
      skipLoadEnvironment: true,
    }).workspace;
    saveSettings(workspaceFile, { channels }, ['channels'], {
      throwOnWriteFailure: true,
    });
    return this.snapshot();
  }

  async remove(
    name: string,
    options: ChannelSettingsMutationOptions,
  ): Promise<ChannelSettingsSnapshot> {
    const current = this.assertRevision(options.expectedRevision);
    const channels = { ...current.channels };
    delete channels[name];
    const startupNames = current.startupNames.filter(
      (startupName) => startupName !== name,
    );
    const workspaceFile = loadSettings(this.workspaceCwd, {
      skipLoadEnvironment: true,
    }).workspace;
    saveSettings(
      workspaceFile,
      { channels, serve: { channels: startupNames } },
      ['channels'],
      { throwOnWriteFailure: true },
    );
    return this.snapshot();
  }

  async setStartupNames(
    names: readonly string[],
    options: ChannelSettingsMutationOptions,
  ): Promise<ChannelSettingsSnapshot> {
    this.assertRevision(options.expectedRevision);
    const workspaceFile = loadSettings(this.workspaceCwd, {
      skipLoadEnvironment: true,
    }).workspace;
    saveSettings(
      workspaceFile,
      { serve: { channels: [...names] } },
      ['serve', 'channels'],
      { throwOnWriteFailure: true },
    );
    return this.snapshot();
  }

  private assertRevision(expectedRevision: string): ChannelSettingsSnapshot {
    const current = this.snapshot();
    if (current.revision !== expectedRevision) {
      throw new ChannelSettingsError(
        'channel_settings_conflict',
        'Channel settings changed; reload before trying again.',
      );
    }
    return current;
  }
}
