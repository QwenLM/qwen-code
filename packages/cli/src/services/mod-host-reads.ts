/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModHostReads,
  ModSettingsLayer,
} from '@qwen-code/qwen-code-core/mods/types.js';
import {
  getSettingsCredentialReferences,
  getSettingsEnvSubstitutions,
  type LoadedSettings,
} from '../config/settings.js';
import { getInstalledSettingsCredentialValues } from '../config/environment.js';
import { PRIVATE_RELAUNCH_ENV_PROVENANCE } from '../config/shared-env-keys.js';
import {
  credentialNameFilter,
  MIN_CREDENTIAL_VALUE_LENGTH,
} from '../utils/credential-names.js';

type Json = Record<string, unknown>;

// A string the rule drops goes, and an MCP server's environment and headers
// go whole: their names follow no rule.
function withoutCredentials(
  value: unknown,
  drops: (key: string, value: string) => boolean,
  level: 'any' | 'servers' | 'server' = 'any',
): unknown {
  if (Array.isArray(value))
    return value
      .filter((item) => typeof item !== 'string' || !drops('', item))
      .map((item) => withoutCredentials(item, drops, level));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      (typeof item === 'string' && drops(key, item)) ||
      (level === 'server' && (key === 'env' || key === 'headers'))
        ? []
        : [
            [
              key,
              withoutCredentials(
                item,
                drops,
                level === 'servers'
                  ? 'server'
                  : level === 'any' && key === 'mcpServers'
                    ? 'servers'
                    : level,
              ),
            ],
          ],
    ),
  );
}

/**
 * What a Mod reads of the environment and the settings: everything but the
 * credentials, which a Mod could carry out through the model, a prompt or
 * its store.
 */
export function modHostReads(
  settings: LoadedSettings,
  env: NodeJS.ProcessEnv = process.env,
): ModHostReads {
  // Every source counts: a layer a Mod reads may hold an entry the merge
  // left out.
  const dropsCredential = () => {
    const scopes = [
      settings.systemDefaults.settings,
      settings.user.settings,
      settings.workspace.settings,
      settings.system.settings,
    ];
    const matchesCredential = credentialNameFilter(
      [settings.merged, ...scopes],
      getSettingsCredentialReferences(scopes),
    );
    const hidden = (name: string) =>
      matchesCredential(name) ||
      name.toUpperCase() === PRIVATE_RELAUNCH_ENV_PROVENANCE;
    // A resolved value can differ from the environment after startup or reload.
    const secrets = new Set(
      env === process.env ? getInstalledSettingsCredentialValues() : [],
    );
    for (const entries of [
      Object.entries(env),
      ...scopes.map(getSettingsEnvSubstitutions),
    ]) {
      for (const [name, value] of entries ?? []) {
        if (
          value &&
          value.length >= MIN_CREDENTIAL_VALUE_LENGTH &&
          hidden(name)
        )
          secrets.add(value);
      }
    }
    return (name: string, value: string) => {
      if (name && hidden(name)) return true;
      for (const secret of secrets) {
        if (value.includes(secret)) return true;
      }
      return false;
    };
  };
  return {
    env: (name) => {
      const value = env[name];
      return typeof value === 'string' && !dropsCredential()(name, value)
        ? value
        : undefined;
    },
    settings: () => {
      const drops = dropsCredential();
      const clean = (value: unknown) =>
        withoutCredentials(value, drops) as Json;
      // System defaults name no source a Mod reads; they still count in
      // the merge. An untrusted folder's settings do not apply.
      const layers: ModSettingsLayer[] = [
        { source: 'user' as const, settings: settings.user.settings },
        ...(settings.isTrusted && settings.workspaceSettingsActive
          ? [
              {
                source: 'project' as const,
                settings: settings.workspace.settings,
              },
            ]
          : []),
        { source: 'policy' as const, settings: settings.system.settings },
      ]
        .filter((layer) => Object.keys(layer.settings).length)
        .map((layer) => ({ ...layer, settings: clean(layer.settings) }));
      return { layers, merged: clean(settings.merged) };
    },
  };
}
