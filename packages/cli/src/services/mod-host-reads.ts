/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModHostReads,
  ModSettingsLayer,
} from '@qwen-code/qwen-code-core/mods/types.js';
import type { LoadedSettings } from '../config/settings.js';
import { isCredentialName } from '../utils/credential-names.js';

type Json = Record<string, unknown>;

// `envKey`, `credentialEnv`, `apiKeyEnv`: a key naming the variable that
// holds a credential.
const NAMES_A_VARIABLE = /^envKey$|Env$/;

function credentialVariables(value: unknown, names: Set<string>): Set<string> {
  if (Array.isArray(value))
    for (const item of value) credentialVariables(item, names);
  else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && NAMES_A_VARIABLE.test(key))
        names.add(item.toUpperCase());
      else credentialVariables(item, names);
    }
  return names;
}

// A string under a credential's name goes, and an MCP server's environment
// and headers go whole: their names follow no rule.
function withoutCredentials(
  value: unknown,
  hidden: (name: string) => boolean,
  level: 'any' | 'servers' | 'server' = 'any',
): unknown {
  if (Array.isArray(value))
    return value.map((item) => withoutCredentials(item, hidden));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      (typeof item === 'string' && hidden(key)) ||
      (level === 'server' && (key === 'env' || key === 'headers'))
        ? []
        : [
            [
              key,
              withoutCredentials(
                item,
                hidden,
                level === 'servers'
                  ? 'server'
                  : key === 'mcpServers'
                    ? 'servers'
                    : 'any',
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
  const hiding = () => {
    const variables = credentialVariables(
      [
        settings.merged,
        settings.systemDefaults.settings,
        settings.user.settings,
        settings.workspace.settings,
        settings.system.settings,
      ],
      new Set(),
    );
    return (name: string) =>
      isCredentialName(name) || variables.has(name.toUpperCase());
  };
  return {
    env: (name) => (hiding()(name) ? undefined : env[name]),
    settings: () => {
      const hidden = hiding();
      const clean = (value: unknown) =>
        withoutCredentials(value, hidden) as Json;
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
