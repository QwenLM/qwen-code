/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapter that lets core's `applyProviderInstallPlan` write through
 * `LoadedSettings` while preserving CLI-specific guarantees:
 * - scope resolution via `getPersistScopeForModelSelection`
 * - on-disk `.orig` backup of the target settings file
 * - in-memory snapshot of `settings` / `originalSettings` for rollback
 * - merged-settings recomputation after restore
 */

import type {
  ModelProvidersConfig,
  ProviderSettingsAdapter,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings, SettingScope } from './settings.js';
import { getPersistScopeForModelSelection } from './modelProvidersScope.js';
import {
  backupSettingsFile,
  cleanupSettingsBackup,
  restoreSettingsFromBackup,
  getNestedProperty,
} from '../utils/settingsUtils.js';

export function createLoadedSettingsAdapter(
  settings: LoadedSettings,
  scope?: SettingScope,
): ProviderSettingsAdapter {
  const persistScope = scope ?? getPersistScopeForModelSelection(settings);
  const settingsFile = settings.forScope(persistScope);

  let settingsSnapshot: object | null = null;
  let originalSnapshot: object | null = null;

  return {
    getValue(key: string): unknown {
      return getNestedProperty(settings.merged as Record<string, unknown>, key);
    },

    setValue(key: string, value: unknown): void {
      settings.setValue(persistScope, key, value);
    },

    getModelProviders(): ModelProvidersConfig {
      return (settings.merged.modelProviders ?? {}) as ModelProvidersConfig;
    },

    persist(): void {
      // LoadedSettings.setValue already persists on each write.
    },

    backup(): void {
      backupSettingsFile(settingsFile.path);
      settingsSnapshot = structuredClone(settingsFile.settings);
      originalSnapshot = structuredClone(settingsFile.originalSettings);
    },

    restore(): void {
      restoreSettingsFromBackup(settingsFile.path);
      if (settingsSnapshot !== null) {
        settingsFile.settings =
          settingsSnapshot as typeof settingsFile.settings;
      }
      if (originalSnapshot !== null) {
        settingsFile.originalSettings =
          originalSnapshot as typeof settingsFile.originalSettings;
      }
      settings.recomputeMerged();
    },

    cleanupBackup(): void {
      cleanupSettingsBackup(settingsFile.path);
      settingsSnapshot = null;
      originalSnapshot = null;
    },
  };
}
