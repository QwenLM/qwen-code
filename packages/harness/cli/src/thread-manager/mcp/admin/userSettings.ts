/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Reading and checking the `mcpServers` of the user settings file. */

import { createHash } from 'node:crypto';
import { isRecord, resolveMcpTransportType } from '@qwen-code/core';
import type { LoadedSettings } from '../../../config/settings.js';
import { skipInvalidMcpServerConfigs } from '../../../config/settingsCompatibility.js';
import { DaemonMcpError } from './errors.js';

/** Throws when the user settings file could not be read. */
export function requireReadable(settings: LoadedSettings): LoadedSettings {
  if (settings.isUserSettingsLoadRejected()) {
    throw new DaemonMcpError(
      'SETTINGS_UNREADABLE',
      'User settings could not be read; fix the file and try again.',
    );
  }
  return settings;
}

/** `mcpServers` as written in the user settings file (variables unexpanded). */
export function rawUserMcpServers(
  settings: LoadedSettings,
): Record<string, unknown> {
  const raw = (settings.user.originalSettings as Record<string, unknown>)[
    'mcpServers'
  ];
  return isRecord(raw) ? raw : {};
}

/** sha256 of the canonical `mcpServers` JSON: insensitive to key order. */
export function mcpConfigVersion(mcpServers: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(mcpServers ?? {}))
    .digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Why an entry cannot be saved or loaded, one line per problem; empty when it
 * can. The settings loader's rules, plus a transport settings can hold.
 */
export function configIssues(configKey: string, config: unknown): string[] {
  if (!isRecord(config)) return ['config must be an object.'];
  const probe = { mcpServers: { [configKey]: structuredClone(config) } };
  const skipped = skipInvalidMcpServerConfigs(probe);
  if (skipped.length > 0) return skipped.map((entry) => entry.reason);
  const transport = resolveMcpTransportType(config);
  if (transport === undefined) {
    return ['config needs a command (stdio) or a url.'];
  }
  if (transport === 'sdk-hosted') {
    return ['SDK-hosted servers cannot be saved to settings.'];
  }
  return [];
}
