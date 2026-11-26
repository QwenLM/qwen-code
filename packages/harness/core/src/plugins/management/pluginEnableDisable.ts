/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isPluginBlockedByPolicy } from '../pluginPolicy.js';
import {
  getPluginInstallationsFresh,
  isManagedLocked,
} from './installedPluginsManager.js';
import {
  findEnabledDependents,
  getLoadedPluginId,
  resolveDependencyOrder,
} from './pluginDependencies.js';
import type { LoadedPlugin } from '../types.js';
import type { PluginScope } from '../schemas.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnableDisableResult {
  ok: true;
  pluginId: string;
  enabled: boolean;
  message?: string;
}

export interface EnableDisableError {
  ok: false;
  error: string;
  /** Hint guiding the user to the correct scope. */
  hint?: string;
}

/**
 * Minimal settings accessor — the CLI layer passes in its LoadedSettings
 * wrapper so core stays I/O-agnostic.
 */
export interface PluginSettingsAccessor {
  /** Read merged plugin IDs whose `enabledPlugins[id]` value is `true`. */
  getEnabledPlugins(): string[];
  /** Read merged plugin IDs whose `enabledPlugins[id]` value is `false`. */
  getDisabledPlugins(): string[];
  /** Read the full merged plugins settings (for policy check). */
  getPluginsSettings(): {
    disabled?: string[];
    blockedMarketplaces?: string[];
  };
  /** Write a single plugin enabled/disabled value at a specific scope. */
  setPluginEnabled(
    scope: PluginScope | 'user',
    pluginId: string,
    enabled: boolean,
  ): boolean;
}

// ---------------------------------------------------------------------------
// Core operation
// ---------------------------------------------------------------------------

/**
 * Enable or disable a plugin.
 *
 * @param pluginId Full plugin ID (`name@marketplace`) or bare name for builtins.
 * @param enabled  `true` to enable, `false` to disable.
 * @param settings Settings accessor provided by the CLI layer.
 * @param options  Additional context.
 */
export function setPluginEnabledOp(
  pluginId: string,
  enabled: boolean,
  settings: PluginSettingsAccessor,
  options?: {
    /** Explicit scope — defaults to 'user'. */
    scope?: PluginScope;
    /** Currently loaded plugins (for dependency checks). */
    loadedPlugins?: LoadedPlugin[];
    /** Whether the plugin is a builtin. */
    isBuiltin?: boolean;
    /** Internal escape hatch for bulk disable operations. */
    skipDependentCheck?: boolean;
    /** Internal escape hatch when dependencies were already handled. */
    skipDependencyCheck?: boolean;
    /** Keep recursive dependency writes on the caller's management path. */
    toggleDependency?: typeof setPluginEnabledOp;
  },
): EnableDisableResult | EnableDisableError {
  const scope = options?.scope ?? 'user';

  // --- Policy guard: block enabling org-blocked plugins ---
  if (enabled) {
    const pluginSettings = settings.getPluginsSettings();
    if (isPluginBlockedByPolicy(pluginId, { plugins: pluginSettings })) {
      return {
        ok: false,
        error: `Plugin "${pluginId}" is blocked by organization policy.`,
      };
    }
  }

  // --- Enterprise guard: forbid disabling locked managed entries
  // (admin-enforced via userCanDisable=false, or userVisible=false which
  // leaves no UI affordance to re-enable). ---
  if (!enabled) {
    if (getPluginInstallationsFresh(pluginId).some(isManagedLocked)) {
      return {
        ok: false,
        error: `Plugin "${pluginId}" is blocked by enterprise policy and cannot be disabled.`,
      };
    }
  }

  // --- Built-in plugins always write at user scope ---
  const writeScope = options?.isBuiltin ? 'user' : scope;

  // --- Read current state ---
  let enabledList = settings.getEnabledPlugins();
  let disabledList = settings.getDisabledPlugins();

  const isCurrentlyEnabled =
    enabledList.includes(pluginId) && !disabledList.includes(pluginId);
  const isCurrentlyDisabled = disabledList.includes(pluginId);

  if (enabled && options?.loadedPlugins && !options.skipDependencyCheck) {
    const dependencyResult = enableInstalledDependencies(
      pluginId,
      settings,
      options.loadedPlugins,
      scope,
      options.toggleDependency,
    );
    if (!dependencyResult.ok) {
      return dependencyResult;
    }
    enabledList = settings.getEnabledPlugins();
    disabledList = settings.getDisabledPlugins();
  }

  // --- Reverse-dependency guard on disable ---
  if (!enabled && options?.loadedPlugins && !options.skipDependentCheck) {
    const deps = findEnabledDependents(pluginId, options.loadedPlugins);
    if (deps.length > 0) {
      return {
        ok: false,
        error: `Cannot disable "${pluginId}" because enabled plugins depend on it: ${deps.join(', ')}. Disable those plugins first.`,
      };
    }
  }

  // --- Idempotency ---
  if (enabled && isCurrentlyEnabled) {
    return {
      ok: true,
      pluginId,
      enabled: true,
      message: `Plugin "${pluginId}" is already enabled.`,
    };
  }
  if (!enabled && isCurrentlyDisabled) {
    return {
      ok: true,
      pluginId,
      enabled: false,
      message: `Plugin "${pluginId}" is already disabled.`,
    };
  }

  // --- Mutate settings ---
  if (!settings.setPluginEnabled(writeScope, pluginId, enabled)) {
    return {
      ok: false,
      error: `Failed to persist plugin "${pluginId}" settings.`,
    };
  }

  return {
    ok: true,
    pluginId,
    enabled,
    message: enabled
      ? `Plugin "${pluginId}" enabled.`
      : `Plugin "${pluginId}" disabled.`,
  };
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/**
 * Disable all currently-enabled plugins.
 * Returns an array of results (one per plugin toggled).
 */
export function disableAllPluginsOp(
  settings: PluginSettingsAccessor,
  options?: {
    loadedPlugins?: LoadedPlugin[];
  },
): Array<EnableDisableResult | EnableDisableError> {
  const enabled = settings.getEnabledPlugins();
  const disabled = settings.getDisabledPlugins();

  // Plugins that are truly enabled = in enabled list AND not overridden by disabled
  const disabledSet = new Set(disabled);
  const toDisable = enabled.filter((id) => !disabledSet.has(id));

  const loadedIds =
    options?.loadedPlugins
      ?.filter((plugin) => plugin.enabled !== false)
      .map((plugin) => getLoadedPluginId(plugin)) ?? [];
  const allToDisable = [...new Set([...toDisable, ...loadedIds])];

  return allToDisable.map((pluginId) =>
    setPluginEnabledOp(pluginId, false, settings, {
      loadedPlugins: options?.loadedPlugins,
      skipDependentCheck: true,
    }),
  );
}

function enableInstalledDependencies(
  pluginId: string,
  settings: PluginSettingsAccessor,
  loadedPlugins: LoadedPlugin[],
  scope: PluginScope,
  toggleDependency: typeof setPluginEnabledOp = setPluginEnabledOp,
): EnableDisableResult | EnableDisableError {
  const orderResult = resolveDependencyOrder(pluginId, loadedPlugins);
  if ('cycle' in orderResult) {
    return {
      ok: false,
      error: `Cannot enable "${pluginId}" because its dependency graph has a cycle: ${orderResult.cycle.join(' -> ')}.`,
    };
  }

  const pluginMap = new Map<string, LoadedPlugin>();
  for (const plugin of loadedPlugins) {
    pluginMap.set(getLoadedPluginId(plugin), plugin);
    pluginMap.set(plugin.name, plugin);
  }

  const disabled = new Set(settings.getDisabledPlugins());
  for (const depId of orderResult.order.slice(0, -1)) {
    const dependency = pluginMap.get(depId);
    if (!dependency) {
      return {
        ok: false,
        error: `Cannot enable "${pluginId}" because dependency "${depId}" is not installed.`,
      };
    }

    if (dependency.enabled !== false && !disabled.has(depId)) {
      continue;
    }

    const result = toggleDependency(depId, true, settings, {
      scope,
      loadedPlugins,
      skipDependencyCheck: true,
    });
    if (!result.ok) {
      return result;
    }
    dependency.enabled = true;
    disabled.delete(depId);
  }

  return { ok: true, pluginId, enabled: true };
}
