/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ChannelConfigFieldDescriptor } from '@qwen-code/channel-base';
import { getPlugin } from '../commands/channel/channel-registry.js';
import { loadSettings, saveSettings } from '../config/settings.js';
import { isAllChannelSelectionName } from './channel-selection.js';

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
  webhookSecrets?: Record<string, ChannelSecretUpdate>;
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
  validateSecretUpdate(update);
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

function invalidConfig(message: string): ChannelSettingsError {
  return new ChannelSettingsError('channel_settings_invalid_config', message);
}

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEnvironmentReference(value: string): boolean {
  return /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value);
}

function assertStringRecord(
  key: string,
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): void {
  if (!isRecord(value)) {
    throw invalidConfig(`Channel field "${key}" must be an object.`);
  }
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    if (!allowedKeys.has(nestedKey) || typeof nestedValue !== 'string') {
      throw invalidConfig(`Channel field "${key}.${nestedKey}" is invalid.`);
    }
  }
}

function assertNumberRecord(
  key: string,
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): void {
  if (!isRecord(value)) {
    throw invalidConfig(`Channel field "${key}" must be an object.`);
  }
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    if (
      !allowedKeys.has(nestedKey) ||
      typeof nestedValue !== 'number' ||
      !Number.isFinite(nestedValue)
    ) {
      throw invalidConfig(`Channel field "${key}.${nestedKey}" is invalid.`);
    }
  }
}

function assertSharedField(key: string, value: unknown): boolean {
  const enumValues: Record<string, ReadonlySet<string>> = {
    senderPolicy: new Set(['allowlist', 'pairing', 'open']),
    dmPolicy: new Set(['open', 'disabled']),
    groupPolicy: new Set(['disabled', 'allowlist', 'open']),
    sessionScope: new Set(['user', 'thread', 'single']),
    dispatchMode: new Set(['steer', 'followup', 'collect']),
    blockStreaming: new Set(['on', 'off']),
  };
  if (Object.hasOwn(enumValues, key)) {
    if (typeof value !== 'string' || !enumValues[key]!.has(value)) {
      throw invalidConfig(`Channel field "${key}" has an invalid value.`);
    }
    return true;
  }
  if (['model', 'cwd', 'approvalMode', 'instructions'].includes(key)) {
    if (typeof value !== 'string') {
      throw invalidConfig(`Channel field "${key}" must be a string.`);
    }
    return true;
  }
  if (key === 'allowedUsers') {
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== 'string')
    ) {
      throw invalidConfig(`Channel field "${key}" must be a string array.`);
    }
    return true;
  }
  if (key === 'groupHistoryLimit') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalidConfig(`Channel field "${key}" must be a number.`);
    }
    return true;
  }
  if (key === 'identity') {
    assertStringRecord(
      key,
      value,
      new Set(['id', 'displayName', 'description']),
    );
    return true;
  }
  if (key === 'blockStreamingChunk') {
    assertNumberRecord(key, value, new Set(['minChars', 'maxChars']));
    return true;
  }
  if (key === 'blockStreamingCoalesce') {
    assertNumberRecord(key, value, new Set(['idleMs']));
    return true;
  }
  if (key === 'memoryScope') {
    if (!isRecord(value)) {
      throw invalidConfig(`Channel field "${key}" must be an object.`);
    }
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      const valid =
        (nestedKey === 'namespace' && typeof nestedValue === 'string') ||
        (nestedKey === 'mode' && nestedValue === 'metadata-only');
      if (!valid) {
        throw invalidConfig(`Channel field "${key}.${nestedKey}" is invalid.`);
      }
    }
    return true;
  }
  if (key === 'webhooks' || key === 'groups') {
    if (!isRecord(value)) {
      throw invalidConfig(`Channel field "${key}" must be an object.`);
    }
    return true;
  }
  return false;
}

function assertDescriptorValue(
  field: ChannelConfigFieldDescriptor,
  value: unknown,
): void {
  const invalidEnvironment =
    typeof value === 'string' &&
    isEnvironmentReference(value) &&
    field.envResolvable !== true;
  if (invalidEnvironment) {
    throw invalidConfig(
      `Channel field "${field.key}" does not support environment references.`,
    );
  }
  const valid =
    ((field.kind === 'string' || field.kind === 'secret') &&
      typeof value === 'string' &&
      value.length > 0) ||
    (field.kind === 'boolean' && typeof value === 'boolean') ||
    (field.kind === 'number' &&
      typeof value === 'number' &&
      Number.isFinite(value)) ||
    (field.kind === 'enum' &&
      typeof value === 'string' &&
      field.options?.some((option) => option.value === value) === true);
  if (!valid) {
    throw invalidConfig(`Channel field "${field.key}" has an invalid value.`);
  }
}

function assertManagedConfig(
  config: Record<string, unknown>,
  previous: Record<string, unknown>,
  fields: readonly ChannelConfigFieldDescriptor[],
): void {
  const descriptorFields = new Map(fields.map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(config)) {
    if (key === 'type') continue;
    const field = descriptorFields.get(key);
    if (field) {
      assertDescriptorValue(field, value);
      continue;
    }
    if (assertSharedField(key, value)) continue;
    if (
      !Object.hasOwn(previous, key) ||
      !isDeepStrictEqual(previous[key], value)
    ) {
      throw invalidConfig(`Channel field "${key}" is not manageable.`);
    }
  }
  for (const field of fields) {
    if (!field.required) continue;
    const value = config[field.key];
    if (value === undefined || value === null || value === '') {
      throw invalidConfig(`Channel field "${field.key}" is required.`);
    }
  }
}

function validateSecretUpdate(
  update: unknown,
): asserts update is ChannelSecretUpdate {
  if (!isRecord(update)) {
    throw invalidSecret('Secret updates must be objects.');
  }
  const operation = update['operation'];
  const keys = Object.keys(update).sort();
  const valid =
    ((operation === 'preserve' || operation === 'clear') &&
      keys.length === 1 &&
      keys[0] === 'operation') ||
    (operation === 'replace' &&
      keys.length === 2 &&
      keys[0] === 'operation' &&
      keys[1] === 'value' &&
      typeof update['value'] === 'string' &&
      update['value'].length > 0);
  if (!valid) {
    throw invalidSecret('Secret updates contain an invalid operation.');
  }
}

export function assertValidChannelSecretUpdates(
  updates: unknown,
): asserts updates is Record<string, ChannelSecretUpdate> {
  if (!isRecord(updates)) {
    throw invalidSecret('Secret updates must be objects.');
  }
  for (const [key, update] of Object.entries(updates)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      throw invalidSecret(`Secret update ${JSON.stringify(key)} is invalid.`);
    }
    validateSecretUpdate(update);
  }
}

function webhookSources(
  config: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const webhooks = config['webhooks'];
  if (!isRecord(webhooks)) return {};
  const sources = webhooks['sources'];
  if (!isRecord(sources)) return {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, source] of Object.entries(sources)) {
    if (UNSAFE_OBJECT_KEYS.has(name) || !isRecord(source)) {
      throw invalidSecret(`Webhook source ${JSON.stringify(name)} is invalid.`);
    }
    result[name] = source;
  }
  return result;
}

function mergeWebhookSecrets(
  previousConfig: Record<string, unknown>,
  requestedConfig: Record<string, unknown>,
  updates: Record<string, ChannelSecretUpdate>,
): void {
  const requestedWebhooks = requestedConfig['webhooks'];
  if (!isRecord(requestedWebhooks)) {
    if (Object.keys(updates).length > 0) {
      throw invalidSecret('Webhook secret updates require retained sources.');
    }
    return;
  }
  const requestedSources = webhookSources(requestedConfig);
  const previousSources = webhookSources(previousConfig);
  for (const name of Object.keys(updates)) {
    if (
      UNSAFE_OBJECT_KEYS.has(name) ||
      !Object.hasOwn(requestedSources, name)
    ) {
      throw invalidSecret(
        `Webhook secret update ${JSON.stringify(name)} does not match a retained source.`,
      );
    }
  }
  const nextSources: Record<string, unknown> = {};
  for (const [name, requestedSource] of Object.entries(requestedSources)) {
    if (Object.hasOwn(requestedSource, 'secret')) {
      throw invalidSecret(
        `Webhook source ${JSON.stringify(name)} must update its literal secret explicitly.`,
      );
    }
    const nextSource = { ...requestedSource };
    const secretEnv = requestedSource['secretEnv'];
    const update = updates[name] ?? { operation: 'preserve' };
    if (secretEnv !== undefined) {
      if (typeof secretEnv !== 'string' || secretEnv.length === 0) {
        throw invalidSecret(
          `Webhook source ${JSON.stringify(name)} has an invalid secretEnv.`,
        );
      }
      if (update.operation === 'replace') {
        throw invalidSecret(
          `Webhook source ${JSON.stringify(name)} cannot replace a literal while using secretEnv.`,
        );
      }
      delete nextSource['secret'];
      nextSources[name] = nextSource;
      continue;
    }
    const previousSecret = previousSources[name]?.['secret'];
    const nextSecret = applySecretUpdate(previousSecret, update);
    if (typeof nextSecret !== 'string' || nextSecret.length === 0) {
      throw invalidSecret(
        `Webhook source ${JSON.stringify(name)} requires a literal secret or secretEnv.`,
      );
    }
    nextSource['secret'] = nextSecret;
    nextSources[name] = nextSource;
  }
  requestedConfig['webhooks'] = {
    ...requestedWebhooks,
    sources: nextSources,
  };
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
    const secretUpdates: unknown =
      options.secrets === undefined ? {} : options.secrets;
    const webhookSecretUpdates: unknown =
      options.webhookSecrets === undefined ? {} : options.webhookSecrets;
    assertValidChannelSecretUpdates(secretUpdates);
    assertValidChannelSecretUpdates(webhookSecretUpdates);
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
    const storedPrevious = current.channels[name] ?? {};
    const previous =
      storedPrevious['type'] === options.config.type ? storedPrevious : {};
    const nextConfig: Record<string, unknown> = { ...options.config };
    for (const key of secretKeys) {
      const update = secretUpdates[key] ?? { operation: 'preserve' };
      const value = applySecretUpdate(previous[key], update);
      if (value !== undefined) nextConfig[key] = value;
    }
    mergeWebhookSecrets(previous, nextConfig, webhookSecretUpdates);
    assertManagedConfig(nextConfig, previous, plugin.management.fields);

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
    const hasAllSentinel = current.startupNames.some(isAllChannelSelectionName);
    const startupNames = hasAllSentinel
      ? Object.keys(channels).some(
          (channelName) => !isAllChannelSelectionName(channelName),
        )
        ? ['all']
        : []
      : current.startupNames.filter((startupName) => startupName !== name);
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
