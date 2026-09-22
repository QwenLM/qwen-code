// Force strict mode and setup for ESM
"use strict";
import {
  LoadedSettings,
  getNestedProperty,
  getPersistScopeForModelSelection
} from "./chunk-DRYBBTI5.js";
import {
  getHomeEnvFallbackVars
} from "./chunk-DJJJPHS3.js";
import {
  writeWithBackupSync
} from "./chunk-36RKQ7ZS.js";
import {
  preserveModelProviderPlaceholders
} from "./chunk-47GVX3K4.js";
import {
  resolveEnvVarsInObject
} from "./chunk-65I7S4Z3.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/config/loadedSettingsAdapter.ts
init_esbuild_shims();
import * as fs from "node:fs";
function findRawModelProviderEntries(settings, providerId) {
  return [
    "System" /* System */,
    ...settings.isTrusted ? ["Workspace" /* Workspace */] : [],
    "User" /* User */,
    "SystemDefaults" /* SystemDefaults */
  ].map((source) => settings.forScope(source).originalSettings.modelProviders).find((providers) => providers && Object.hasOwn(providers, providerId))?.[providerId];
}
__name(findRawModelProviderEntries, "findRawModelProviderEntries");
function getRawModelProviders(settings) {
  return Object.fromEntries(
    Object.keys(settings.merged.modelProviders ?? {}).map((providerId) => [
      providerId,
      findRawModelProviderEntries(settings, providerId) ?? []
    ])
  );
}
__name(getRawModelProviders, "getRawModelProviders");
function createLoadedSettingsAdapter(settings, scope) {
  const persistScope = scope ?? getPersistScopeForModelSelection(settings);
  const settingsFile = settings.forScope(persistScope);
  let fileSnapshot;
  let settingsSnapshot = null;
  let originalSnapshot = null;
  return {
    getValue(key) {
      return getNestedProperty(settings.merged, key);
    },
    setValue(key, value) {
      for (const part of key.split(".")) {
        if (part === "__proto__" || part === "constructor" || part === "prototype") {
          throw new Error(
            `Refusing to write settings key with reserved segment: ${key}`
          );
        }
      }
      const provider = key.startsWith("modelProviders.") && key.split(".").length === 2 ? key.slice("modelProviders.".length) : void 0;
      if (!provider || !Array.isArray(value)) {
        settings.setValue(persistScope, key, value);
        return;
      }
      const sourceFor = /* @__PURE__ */ __name((providerId) => findRawModelProviderEntries(settings, providerId), "sourceFor");
      const ownsBucket = Object.hasOwn(
        settingsFile.settings.modelProviders ?? {},
        provider
      );
      const previous = ownsBucket ? settingsFile.settings.modelProviders?.[provider] : settings.merged.modelProviders?.[provider];
      const raw = ownsBucket ? settingsFile.originalSettings.modelProviders?.[provider] : sourceFor(provider);
      const resolvedProviders = provider === "openai" /* USE_OPENAI */ ? settings.merged.modelProviders ?? {} : { [provider]: previous ?? [] };
      const rawProviders = provider === "openai" /* USE_OPENAI */ ? Object.fromEntries(
        Object.keys(resolvedProviders).map((id) => [
          id,
          sourceFor(id) ?? []
        ])
      ) : { [provider]: raw ?? [] };
      const persisted = preserveModelProviderPlaceholders(
        value,
        provider,
        resolvedProviders,
        rawProviders,
        settings.merged.providerProtocol
      );
      settings.setValue(persistScope, key, persisted);
      settingsFile.settings.modelProviders = resolveEnvVarsInObject(
        settingsFile.originalSettings.modelProviders,
        getHomeEnvFallbackVars()
      );
      settings.recomputeMerged();
    },
    getModelProviders() {
      return settings.merged.modelProviders ?? {};
    },
    getModelProvidersForWrite() {
      const ownProviders = settingsFile.settings.modelProviders ?? {};
      const writeView = persistScope === "User" /* User */ ? new LoadedSettings(
        settings.system,
        settings.systemDefaults,
        settings.user,
        { ...settings.workspace, settings: {}, originalSettings: {} },
        false,
        /* @__PURE__ */ new Set()
      ).merged : settings.merged;
      return {
        modelProviders: ownProviders,
        providerProtocol: writeView.providerProtocol,
        shadowedProviders: Object.keys(ownProviders).filter(
          (providerId) => [
            "System" /* System */,
            ...settings.isTrusted ? ["Workspace" /* Workspace */] : [],
            "User" /* User */,
            "SystemDefaults" /* SystemDefaults */
          ].find(
            (scope2) => Object.hasOwn(
              settings.forScope(scope2).originalSettings.modelProviders ?? {},
              providerId
            )
          ) !== persistScope
        )
      };
    },
    persist() {
    },
    backup() {
      const contents = fs.existsSync(settingsFile.path) ? fs.readFileSync(settingsFile.path, "utf8") : null;
      settingsSnapshot = structuredClone(settingsFile.settings);
      originalSnapshot = structuredClone(settingsFile.originalSettings);
      fileSnapshot = contents;
    },
    restore() {
      if (fileSnapshot === void 0) return;
      try {
        if (fileSnapshot === null) {
          fs.rmSync(settingsFile.path, { force: true });
        } else {
          writeWithBackupSync(settingsFile.path, fileSnapshot);
        }
      } finally {
        if (settingsSnapshot !== null) {
          settingsFile.settings = settingsSnapshot;
        }
        if (originalSnapshot !== null) {
          settingsFile.originalSettings = originalSnapshot;
        }
        settings.recomputeMerged();
      }
    },
    cleanupBackup() {
      fileSnapshot = void 0;
      settingsSnapshot = null;
      originalSnapshot = null;
    }
  };
}
__name(createLoadedSettingsAdapter, "createLoadedSettingsAdapter");

export {
  findRawModelProviderEntries,
  getRawModelProviders,
  createLoadedSettingsAdapter
};
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
