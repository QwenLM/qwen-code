// Force strict mode and setup for ESM
"use strict";
import {
  AUTO_THEME_NAME,
  themeManager
} from "./chunk-S7BE3FMA.js";
import {
  initializeI18n,
  resolveLanguageSetting,
  t
} from "./chunk-POMFSBEC.js";
import {
  IdeClient
} from "./chunk-MRTRBONQ.js";
import {
  AuthEvent,
  IdeConnectionEvent,
  logAuth,
  logIdeConnection
} from "./chunk-KKGSJZWK.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/core/initializer.ts
init_esbuild_shims();

// packages/cli/src/core/auth.ts
init_esbuild_shims();
async function performInitialAuth(config, authType) {
  if (!authType) {
    return null;
  }
  try {
    await config.refreshAuth(authType, true);
    const authEvent = new AuthEvent(authType, "auto", "success");
    logAuth(config, authEvent);
  } catch (e) {
    const errorMessage = `Failed to login. Message: ${getErrorMessage(e)}`;
    const authEvent = new AuthEvent(authType, "auto", "error", errorMessage);
    logAuth(config, authEvent);
    return errorMessage;
  }
  return null;
}
__name(performInitialAuth, "performInitialAuth");

// packages/cli/src/core/theme.ts
init_esbuild_shims();
function validateTheme(settings) {
  const effectiveTheme = settings.merged.ui?.theme;
  if (effectiveTheme && effectiveTheme !== AUTO_THEME_NAME && !themeManager.findThemeByName(effectiveTheme)) {
    return t('Theme "{{themeName}}" not found.', {
      themeName: effectiveTheme
    });
  }
  return null;
}
__name(validateTheme, "validateTheme");

// packages/cli/src/core/initializer.ts
async function connectIdeForStartup(config) {
  if (!config.getIdeMode()) return;
  const ideClient = await IdeClient.getInstance();
  await ideClient.connect();
  logIdeConnection(config, new IdeConnectionEvent("start" /* START */));
}
__name(connectIdeForStartup, "connectIdeForStartup");
async function initializeApp(config, settings, options = {}) {
  await initializeI18n(
    resolveLanguageSetting(settings.merged.general?.language)
  );
  const authType = config.getModelsConfig().getCurrentAuthType();
  const authError = await performInitialAuth(config, authType);
  const themeError = validateTheme(settings);
  const shouldOpenAuthDialog = !config.getModelsConfig().wasAuthTypeExplicitlyProvided() || !!authError;
  if (!options.deferIdeConnection) {
    await connectIdeForStartup(config);
  }
  return {
    authError,
    themeError,
    shouldOpenAuthDialog,
    memoryFileCount: config.getMemoryFileCount()
  };
}
__name(initializeApp, "initializeApp");

export {
  connectIdeForStartup,
  initializeApp
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
