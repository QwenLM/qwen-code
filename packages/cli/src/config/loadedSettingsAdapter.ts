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
      // Defense in depth: refuse prototype-chain segments before delegating to
      // LoadedSettings.setValue, which goes through setNestedPropertySafe and
      // doesn't enforce this itself. Inline literal === comparisons (rather
      // than Set.has) are what CodeQL's prototype-pollution sanitiser
      // recognises — keep this list in sync with the matching guard in
      // `packages/vscode-ide-companion/src/services/settingsWriter.ts`.
      for (const part of key.split('.')) {
        if (
          part === '__proto__' ||
          part === 'constructor' ||
          part === 'prototype'
        ) {
          throw new Error(
            `Refusing to write settings key with reserved segment: ${key}`,
          );
        }
      }
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
      // restoreSettingsFromBackup returns false (rather than throwing) when
      // the .orig copy can't be restored (EACCES, disk full, missing .orig).
      // Log loudly so a user staring at the next CLI session knows the
      // on-disk file may be inconsistent with the recovered in-memory state.
      const restored = restoreSettingsFromBackup(settingsFile.path);
      if (!restored) {
        // eslint-disable-next-line no-console -- best-effort rollback path
        console.error(
          `[loadedSettingsAdapter] On-disk rollback of ${settingsFile.path} failed; ` +
            `in-memory state was restored but the file may be inconsistent. ` +
            `Re-run /auth or inspect the file directly to recover.`,
        );
      }
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
