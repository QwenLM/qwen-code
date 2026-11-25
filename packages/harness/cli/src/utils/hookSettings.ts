/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SettingScope,
  type LoadableSettingScope,
  type LoadedSettings,
} from '../config/settings.js';
import {
  ConfigSource,
  getHookKey,
  type HookRegistryEntry,
  type HookDefinition,
  type HookConfig,
} from '@qwen-code/core';

export interface HookRemoveResult {
  status: 'success' | 'not-found' | 'error';
  /** Error message if status is 'error'. */
  error?: string;
}

/**
 * Maps a ConfigSource to the LoadableSettingScope that owns its hook definitions.
 * Returns undefined for sources that cannot be user-edited (Plugins, Flag).
 */
function getScopeForSource(
  source: ConfigSource,
): LoadableSettingScope | undefined {
  switch (source) {
    case ConfigSource.Project:
      return SettingScope.Project;
    case ConfigSource.User:
      return SettingScope.User;
    case ConfigSource.Local:
      return SettingScope.Local;
    default:
      return undefined;
  }
}

/**
 * Removes a hook definition from the settings file that owns it.
 *
 * Finds the hook's HookConfig inside `hooks.<eventName>[].hooks[]` by matching
 * via `getHookKey()`, removes it, and cleans up empty parent structures.
 * 仅提交目标事件的变更，不重新合并同事件的并发编辑。
 */
export function removeHook(
  settings: LoadedSettings,
  hookEntry: HookRegistryEntry,
): HookRemoveResult {
  const scope = getScopeForSource(hookEntry.source);
  if (!scope) {
    return {
      status: 'error',
      error: `Cannot remove hooks from source: ${hookEntry.source}`,
    };
  }

  const eventName = hookEntry.eventName as string;
  const hooks = settings.forScope(scope).settings.hooks as
    | Record<string, HookDefinition[]>
    | undefined;
  const current = hooks?.[eventName];
  if (!Array.isArray(current)) return { status: 'not-found' };
  const targetKey = getHookKey(hookEntry.config);
  let found = false;
  const updatedDefinitions: HookDefinition[] = [];
  for (const definition of current as HookDefinition[]) {
    if (definition.matcher !== hookEntry.matcher) {
      updatedDefinitions.push(definition);
      continue;
    }
    const filteredHooks = definition.hooks.filter(
      (hook: HookConfig) => getHookKey(hook) !== targetKey,
    );
    if (filteredHooks.length < definition.hooks.length) found = true;
    if (filteredHooks.length > 0) {
      updatedDefinitions.push({ ...definition, hooks: filteredHooks });
    }
  }
  if (!found) return { status: 'not-found' };
  const success = settings.setValue(
    scope,
    ['hooks', eventName],
    updatedDefinitions.length > 0 ? updatedDefinitions : undefined,
  );
  if (!success) {
    return {
      status: 'error',
      error: 'Failed to remove hook from settings.',
    };
  }
  return { status: 'success' };
}
