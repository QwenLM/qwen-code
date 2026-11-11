/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SettingsValues,
  SettingsDefinition,
  SettingsFieldDefinition,
} from './settingsTypes.js';

// Only defaults needed by the first command readers; this is not the CLI schema.
const DEFAULTS: SettingsValues = {
  mcpServers: {},
  mcp: {
    enableAllProjectMcpServers: false,
    enabledProjectMcpServers: [],
    disabledProjectMcpServers: [],
  },
  skills: {
    enabled: true,
    loadFromAgentsDirectory: true,
    disabled: [],
    disableShellExecution: false,
  },
  enabledPlugins: {},
  extraKnownMarketplaces: {},
  strictKnownMarketplaces: false,
  blockedMarketplaces: [],
  skillOverrides: {},
};
const SHALLOW_MAPS = new Set([
  'mcpServers',
  'enabledPlugins',
  'extraKnownMarketplaces',
  'skillOverrides',
]);
const UNION_LISTS = new Set([
  'blockedMarketplaces',
  'skills.disabled',
  'mcp.enabledProjectMcpServers',
  'mcp.disabledProjectMcpServers',
]);

export function isSettingsObject(value: unknown): value is SettingsValues {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function strategyForPath(
  schema: Record<string, SettingsFieldDefinition>,
  path: string[],
) {
  let current: SettingsFieldDefinition | undefined;
  let currentSchema: Record<string, SettingsFieldDefinition> | undefined =
    schema;
  for (const key of path) {
    if (!currentSchema?.[key])
      return current?.additionalProperties?.mergeStrategy;
    current = currentSchema[key];
    currentSchema = current.properties;
  }
  return current?.mergeStrategy;
}

function mergeInto(
  target: SettingsValues,
  source: SettingsValues,
  path: string[] = [],
  schema?: Record<string, SettingsFieldDefinition>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype' ||
      value === undefined
    )
      continue;
    const fieldPath = [...path, key];
    const field = fieldPath.join('.');
    const previous = target[key];
    const strategy = schema ? strategyForPath(schema, fieldPath) : undefined;
    if (
      Array.isArray(value) &&
      Array.isArray(previous) &&
      (strategy === 'union' || (!schema && UNION_LISTS.has(field)))
    ) {
      target[key] = structuredClone([...new Set([...previous, ...value])]);
    } else if (
      Array.isArray(value) &&
      Array.isArray(previous) &&
      strategy === 'concat'
    ) {
      target[key] = structuredClone([...previous, ...value]);
    } else if (isSettingsObject(value)) {
      const next: SettingsValues = isSettingsObject(previous) ? previous : {};
      if (
        strategy === 'shallow_merge' ||
        (!schema && SHALLOW_MAPS.has(field))
      ) {
        for (const [name, entry] of Object.entries(value)) {
          if (
            name === '__proto__' ||
            name === 'constructor' ||
            name === 'prototype'
          )
            continue;
          next[name] = structuredClone(entry);
        }
      } else {
        mergeInto(next, value, fieldPath, schema);
      }
      target[key] = next;
    } else {
      // Other arrays replace; scalars/null use the highest-priority value.
      target[key] = structuredClone(value);
    }
  }
}

export function mergeSettings(...layers: SettingsValues[]): SettingsValues {
  const merged: SettingsValues = {};
  for (const layer of [DEFAULTS, ...layers]) mergeInto(merged, layer);
  return merged;
}

export function mergeDefinedSettings(
  definition: SettingsDefinition | undefined,
  ...layers: SettingsValues[]
): SettingsValues {
  if (!definition) return mergeSettings(...layers);
  function defaults(schema: Record<string, SettingsFieldDefinition>): SettingsValues {
    const result: SettingsValues = {};
    for (const [key, field] of Object.entries(schema)) {
      if (field.properties) result[key] = defaults(field.properties);
      else if (field.default !== undefined)
        result[key] = structuredClone(field.default);
    }
    return result;
  }
  const result = defaults(definition.schema);
  for (const layer of layers) mergeInto(result, layer, [], definition.schema);
  return result;
}
