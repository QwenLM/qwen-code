/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Factory for creating a SettingsAccessor from Config's storage paths.
 *
 * Bridges the permission loading layer with the filesystem settings
 * infrastructure. Reads settings JSON files at the standard paths
 * (user, project, local) and makes their `permissions` field available
 * to the permission pipeline.
 */

import * as fs from 'node:fs';
import type {
  SettingsAccessor,
  PermissionsSettingsJson,
} from './permissionsLoader.js';
import type { PermissionRuleSource } from '../manager/decision/index.js';
import { Storage } from '../../config/storage.js';

/**
 * Options for creating a SettingsAccessor.
 */
export interface SettingsAccessorOptions {
  /** Storage instance for resolving settings file paths. */
  readonly storage: Storage;

  /**
   * Additional enabled sources beyond the default three.
   * The default sources are: userSettings, projectSettings, localSettings.
   * Provide this to include e.g. 'policySettings' or 'flagSettings'.
   */
  readonly additionalSources?: PermissionRuleSource[];

  /**
   * Explicit file path for the --settings flag.
   * When provided, 'flagSettings' is automatically added to enabled sources
   * and this path is used when reading that source.
   */
  readonly flagSettingsPath?: string;

  /**
   * Explicit file path for organizational policy settings.
   * When provided, 'policySettings' is automatically added to enabled sources
   * and this path is used when reading that source.
   */
  readonly policySettingsPath?: string;
}

/**
 * Reads a settings JSON file from disk, returning null on error.
 */
function readSettingsFile(filePath: string): PermissionsSettingsJson | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as PermissionsSettingsJson;
  } catch {
    return null;
  }
}

/**
 * Resolves the filesystem path for a given permission rule source.
 * Returns null for sources that don't have a fixed file path
 * (e.g. 'session', 'cliArg', 'command').
 */
function getSourceFilePath(
  source: PermissionRuleSource,
  storage: Storage,
): string | null {
  switch (source) {
    case 'userSettings':
      return Storage.getGlobalSettingsPath();
    case 'projectSettings':
      return storage.getWorkspaceSettingsPath();
    case 'localSettings':
      return storage.getWorkspaceLocalSettingsPath();
    default:
      // Sources like 'session', 'cliArg', 'command', 'policySettings',
      // 'flagSettings' are either transient or handled separately.
      return null;
  }
}

/**
 * Default enabled sources in load order.
 * User settings are loaded first (broadest), then project (more specific),
 * then local (most specific / user-private overrides).
 */
const DEFAULT_SOURCES: PermissionRuleSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
];

/**
 * Creates a filesystem-backed SettingsAccessor.
 *
 * Reads permission rules from user, project, local, flag and policy settings;
 * paths resolve to the standard config locations.
 */
export function createSettingsAccessor(
  options: SettingsAccessorOptions,
): SettingsAccessor {
  const {
    storage,
    additionalSources = [],
    flagSettingsPath,
    policySettingsPath,
  } = options;

  // Build the enabled sources list, auto-adding flagSettings / policySettings
  // when their paths are provided.
  const enabledSources = [...DEFAULT_SOURCES, ...additionalSources];
  if (flagSettingsPath && !enabledSources.includes('flagSettings')) {
    enabledSources.push('flagSettings');
  }
  if (policySettingsPath && !enabledSources.includes('policySettings')) {
    enabledSources.push('policySettings');
  }

  // Build a path lookup that extends the static resolver with explicit paths.
  const extraPaths: Partial<Record<PermissionRuleSource, string>> = {};
  if (flagSettingsPath) extraPaths.flagSettings = flagSettingsPath;
  if (policySettingsPath) extraPaths.policySettings = policySettingsPath;

  return {
    getSettingsForSource(
      source: PermissionRuleSource,
    ): PermissionsSettingsJson | null {
      // Check explicit paths first (flagSettings, policySettings)
      const explicitPath = extraPaths[source];
      if (explicitPath) return readSettingsFile(explicitPath);

      // Then try standard source → file path resolution
      const filePath = getSourceFilePath(source, storage);
      if (!filePath) return null;
      return readSettingsFile(filePath);
    },

    getEnabledSources(): PermissionRuleSource[] {
      return enabledSources;
    },
  };
}
