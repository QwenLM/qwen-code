/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapter that lets core's `applyProviderInstallPlan` write through
 * `LoadedSettings` while preserving CLI-specific guarantees:
 * - scope resolution via `getPersistScopeForModelSelection`
 * - original file contents for transaction rollback
 * - in-memory snapshot of `settings` / `originalSettings` for rollback
 * - merged-settings recomputation after restore
 */

import * as fs from 'node:fs';
import { writeWithBackupSync } from '../utils/writeWithBackup.js';
import type {
  ModelProvidersConfig,
  ProviderSettingsAdapter,
} from '@qwen-code/qwen-code-core';
import {
  SettingScope,
  getHomeEnvFallbackVars,
  type LoadedSettings,
} from './settings.js';
import { resolveEnvVarsInObject } from '@qwen-code/qwen-code-core/envVarResolver';
import { getPersistScopeForModelSelection } from './modelProvidersScope.js';
import { getNestedProperty } from './settingsUtils.js';

function preservePlaceholders(
  value: unknown,
  resolved: unknown,
  original: unknown,
): unknown {
  if (typeof original === 'string' && value === resolved) return original;
  if (
    Array.isArray(value) &&
    Array.isArray(resolved) &&
    Array.isArray(original)
  ) {
    return value.map((entry, index) =>
      preservePlaceholders(entry, resolved[index], original[index]),
    );
  }
  if (
    value &&
    resolved &&
    original &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof resolved === 'object' &&
    !Array.isArray(resolved) &&
    typeof original === 'object' &&
    !Array.isArray(original)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        preservePlaceholders(
          entry,
          (resolved as Record<string, unknown>)[key],
          (original as Record<string, unknown>)[key],
        ),
      ]),
    );
  }
  return value;
}

export function createLoadedSettingsAdapter(
  settings: LoadedSettings,
  scope?: SettingScope,
): ProviderSettingsAdapter {
  const persistScope = scope ?? getPersistScopeForModelSelection(settings);
  const settingsFile = settings.forScope(persistScope);

  let fileSnapshot: string | null | undefined;
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
      const provider =
        key.startsWith('modelProviders.') && key.split('.').length === 2
          ? key.slice('modelProviders.'.length)
          : undefined;
      if (!provider || !Array.isArray(value)) {
        settings.setValue(persistScope, key, value);
        return;
      }
      const previous = settings.merged.modelProviders?.[provider];
      const source = [
        SettingScope.System,
        ...(settings.isTrusted ? [SettingScope.Workspace] : []),
        SettingScope.User,
        SettingScope.SystemDefaults,
      ]
        .map(
          (source) => settings.forScope(source).originalSettings.modelProviders,
        )
        .find((providers) => providers && Object.hasOwn(providers, provider));
      const raw = source?.[provider];
      const models = value as NonNullable<ModelProvidersConfig[string]>;
      const persisted =
        !Array.isArray(previous) || !Array.isArray(raw)
          ? models
          : (models.map((model) => {
              if (!model) return model;
              const matches = previous.flatMap((entry, index) =>
                entry?.id === model.id && entry.baseUrl === model.baseUrl
                  ? [index]
                  : [],
              );
              if (
                matches.length > 1 &&
                JSON.stringify(previous) !== JSON.stringify(raw)
              ) {
                throw new Error(
                  'Cannot preserve placeholders in an ambiguous model configuration. Remove duplicate model entries first.',
                );
              }
              const index = matches[0];
              return index === undefined
                ? model
                : preservePlaceholders(model, previous[index], raw[index]);
            }) as typeof models);
      settings.setValue(persistScope, key, persisted);
      settingsFile.settings.modelProviders = {
        ...settingsFile.settings.modelProviders,
        [provider]: resolveEnvVarsInObject(persisted, getHomeEnvFallbackVars()),
      };
      settings.recomputeMerged();
    },

    getModelProviders(): ModelProvidersConfig {
      return (settings.merged.modelProviders ?? {}) as ModelProvidersConfig;
    },

    persist(): void {
      // LoadedSettings.setValue already persists on each write.
    },

    backup(): void {
      // Each settings write consumes .orig; keep the transaction snapshot separate.
      const contents = fs.existsSync(settingsFile.path)
        ? fs.readFileSync(settingsFile.path, 'utf8')
        : null;
      settingsSnapshot = structuredClone(settingsFile.settings);
      originalSnapshot = structuredClone(settingsFile.originalSettings);
      fileSnapshot = contents;
    },

    restore(): void {
      if (fileSnapshot === undefined) return;
      try {
        if (fileSnapshot === null) {
          fs.rmSync(settingsFile.path, { force: true });
        } else {
          writeWithBackupSync(settingsFile.path, fileSnapshot);
        }
      } finally {
        if (settingsSnapshot !== null) {
          settingsFile.settings =
            settingsSnapshot as typeof settingsFile.settings;
        }
        if (originalSnapshot !== null) {
          settingsFile.originalSettings =
            originalSnapshot as typeof settingsFile.originalSettings;
        }
        settings.recomputeMerged();
      }
    },

    cleanupBackup(): void {
      fileSnapshot = undefined;
      settingsSnapshot = null;
      originalSnapshot = null;
    },
  };
}
