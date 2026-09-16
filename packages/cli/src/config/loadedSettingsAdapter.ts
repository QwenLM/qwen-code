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
  LoadedSettings,
} from './settings.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { preserveModelProviderPlaceholders } from '@qwen-code/qwen-code-core/providers/model-config-serialization.js';
import { resolveEnvVarsInObject } from '@qwen-code/qwen-code-core/envVarResolver';
import { getPersistScopeForModelSelection } from './modelProvidersScope.js';
import { getNestedProperty } from './settingsUtils.js';

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
      const sourceFor = (providerId: string) =>
        [
          SettingScope.System,
          ...(settings.isTrusted ? [SettingScope.Workspace] : []),
          SettingScope.User,
          SettingScope.SystemDefaults,
        ]
          .map(
            (source) =>
              settings.forScope(source).originalSettings.modelProviders,
          )
          .find(
            (providers) => providers && Object.hasOwn(providers, providerId),
          )?.[providerId];
      const ownsBucket = Object.hasOwn(
        settingsFile.settings.modelProviders ?? {},
        provider,
      );
      const previous = ownsBucket
        ? settingsFile.settings.modelProviders?.[provider]
        : settings.merged.modelProviders?.[provider];
      const raw = ownsBucket
        ? settingsFile.originalSettings.modelProviders?.[provider]
        : sourceFor(provider);
      const resolvedProviders =
        provider === AuthType.USE_OPENAI
          ? (settings.merged.modelProviders ?? {})
          : { [provider]: previous ?? [] };
      const rawProviders =
        provider === AuthType.USE_OPENAI
          ? Object.fromEntries(
              Object.keys(resolvedProviders).map((id) => [
                id,
                sourceFor(id) ?? [],
              ]),
            )
          : { [provider]: raw ?? [] };
      const persisted = preserveModelProviderPlaceholders(
        value as ModelProvidersConfig[string],
        provider,
        resolvedProviders,
        rawProviders,
        settings.merged.providerProtocol,
      );
      settings.setValue(persistScope, key, persisted);
      settingsFile.settings.modelProviders = resolveEnvVarsInObject(
        settingsFile.originalSettings.modelProviders,
        getHomeEnvFallbackVars(),
      );
      settings.recomputeMerged();
    },

    getModelProviders(): ModelProvidersConfig {
      return (settings.merged.modelProviders ?? {}) as ModelProvidersConfig;
    },

    getModelProvidersForWrite() {
      const ownProviders = settingsFile.settings.modelProviders ?? {};
      const writeView =
        persistScope === SettingScope.User
          ? new LoadedSettings(
              settings.system,
              settings.systemDefaults,
              settings.user,
              { ...settings.workspace, settings: {}, originalSettings: {} },
              false,
              new Set(),
            ).merged
          : settings.merged;
      return {
        modelProviders: ownProviders,
        providerProtocol: writeView.providerProtocol,
        shadowedProviders: Object.keys(ownProviders).filter(
          (providerId) =>
            [
              SettingScope.System,
              ...(settings.isTrusted ? [SettingScope.Workspace] : []),
              SettingScope.User,
              SettingScope.SystemDefaults,
            ].find((scope) =>
              Object.hasOwn(
                settings.forScope(scope).originalSettings.modelProviders ?? {},
                providerId,
              ),
            ) !== persistScope,
        ),
      };
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
