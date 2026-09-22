// Force strict mode and setup for ESM
"use strict";
import {
  resolveSupportedLanguage
} from "./chunk-5EJZE3FP.js";
import {
  resolveBundleDir
} from "./chunk-ACHCT36C.js";
import {
  Storage
} from "./chunk-ZYDMQCQP.js";
import {
  writeStderrLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __glob,
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/i18n/index.ts
init_esbuild_shims();
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// packages/cli/src/i18n/translationDict.ts
init_esbuild_shims();
function getTranslationModuleExport(module) {
  return Object.prototype.hasOwnProperty.call(module, "default") ? module["default"] : module;
}
__name(getTranslationModuleExport, "getTranslationModuleExport");
function isTranslationDict(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}
__name(isTranslationDict, "isTranslationDict");

// packages/cli/src/i18n/mustTranslateKeys.ts
init_esbuild_shims();
var MUST_TRANSLATE_KEYS = [
  "View or change the language setting",
  "List background tasks (text dump \u2014 interactive dialog opens via the footer pill)",
  "Delete a previous session",
  "Run installation and environment diagnostics",
  "Browse dynamic model catalogs and choose which models stay enabled locally",
  "Generate a one-line session recap now",
  "Rename the current conversation. --auto lets the fast model pick a title.",
  "Rewind conversation to a previous turn",
  "Spawn a background agent that inherits the full conversation",
  "Please provide a directive. Usage: /fork <directive>",
  "Cannot fork while a response or tool call is in progress. Wait for it to finish or resolve the pending tool call.",
  "Cannot fork before the first conversation turn.",
  "The agent tool is unavailable; cannot fork.",
  "Failed to launch fork: {{error}}",
  "User launched a background fork via /fork: {{directive}}",
  "Forked into a background agent. It inherits this conversation and runs without blocking \u2014 track it in the background tasks panel; it reports back when done.",
  "Processing summary...",
  "Project summary generated and saved successfully!",
  "Saved to: {{filePath}}",
  "Stopped because",
  "Set UI language",
  "Usage: /language ui [{{options}}]",
  "Invalid language. Available: {{options}}",
  "To request additional UI language packs, please open an issue on GitHub.",
  "Open MCP management dialog",
  "Manage MCP servers",
  "Open the skills panel (browse, search, toggle, pick).",
  "Manage Skills",
  "Skills configuration saved.",
  "Space toggle \xB7 Enter pick (fill input) \xB7 Esc save & exit \xB7 workspace scope",
  "Tools",
  "prompts",
  "tools",
  "Ask a quick side question without affecting the main conversation",
  "Get a second opinion on the current conversation from a reviewer model",
  "Consulting advisor...",
  "Advisor review failed: {{error}}",
  "No conversation context available for /advisor",
  "Focus too long (max {{max}} chars)",
  "Another operation is in progress, wait for it to complete before running /advisor",
  "No response received.",
  "No model configured.",
  "Manage Arena sessions",
  "Start an Arena session with multiple models competing on the same task",
  "Stop the current Arena session",
  "Show the current Arena session status",
  "Select a model result and merge its diff into the current workspace",
  "Switch to plan mode or exit plan mode",
  "Exited plan mode. Previous approval mode restored.",
  "Enabled plan mode. The agent will analyze and plan without executing tools.",
  'Already in plan mode. Use "/plan exit" to exit plan mode.',
  'Not in plan mode. Use "/plan" to enter plan mode first.',
  "Open the memory manager.",
  "Save a durable memory to the memory system.",
  'Show context window usage breakdown. Use "/context detail" for per-item breakdown.',
  "Show per-item context usage breakdown.",
  "Manage extensions",
  "Manage installed extensions",
  "Install an extension from a git repo or local path",
  "Disable an extension",
  "Enable an extension",
  "Uninstall an extension",
  "Manage extension settings",
  "Lists installed extensions.",
  "Updates all extensions or a named extension to the latest version.",
  "Open extensions page in your browser",
  "Manage Extensions",
  "Extension Details",
  "View Extension",
  "Update Extension",
  "Disable Extension",
  "Enable Extension",
  "Uninstall Extension",
  "Select Scope",
  "User Scope",
  "Workspace Scope",
  "No extensions found.",
  "Toggle this help display",
  "Toggle shell mode",
  "Open command menu",
  "Add file context",
  "Accept suggestion / Autocomplete",
  "Reverse search history",
  "Lock release warning",
  "Metadata write warning",
  "Subsequent dreams may be skipped as locked until the next session's staleness sweep cleans the file.",
  "The scheduler gate did not see this dream's timestamp; the next dream cycle may re-fire sooner than usual.",
  "Press ? again to close",
  "? for shortcuts",
  'Invalid approval mode "{{arg}}". Valid modes: {{modes}}',
  'Approval mode set to "{{mode}}"',
  "auto_mode.entry_notice",
  "Set up Qwen Code's status line UI",
  "Cached (included in Input): {{tokens}}",
  "By source:",
  "Unclosed quote in arguments.",
  "Token usage export path must be within the project working directory.",
  "Failed to load token usage stats: {{error}}",
  "Failed to export token usage stats: {{error}}",
  "Note: generation timing (TTFT/TPS) belongs to generation metrics.",
  "Cannot resolve export path within the working directory.",
  "Export target does not exist: {{path}}",
  "Could not create a temporary export file.",
  "Activity",
  "Efficiency",
  "Today",
  "Cache Hit Rate",
  "Tool Success",
  "Avg Latency",
  "Generation Metrics",
  "Latest Request",
  "Generation Time",
  "Average TTFT",
  "Session TPS",
  "Tool Leaderboard",
  "Code Impact",
  "streak",
  "best",
  "Token Trend",
  "In/Out",
  "Unset"
];

// import("./locales/**/*.js") in packages/cli/src/i18n/index.ts
var globImport_locales_js = __glob({
  "./locales/ca.js": () => import("./ca-WC3A5B3Q.js"),
  "./locales/de.js": () => import("./de-6AVKPTXQ.js"),
  "./locales/en.js": () => import("./en-FCK6MBTI.js"),
  "./locales/fr.js": () => import("./fr-EBUDHJL3.js"),
  "./locales/ja.js": () => import("./ja-NCDT4CGV.js"),
  "./locales/pt.js": () => import("./pt-FYYFWYUC.js"),
  "./locales/ru.js": () => import("./ru-RHEB3RNS.js"),
  "./locales/zh-TW.js": () => import("./zh-TW-SRB5QSER.js"),
  "./locales/zh.js": () => import("./zh-UBQIFP4A.js")
});

// packages/cli/src/i18n/index.ts
var currentLanguage = "en";
var translations = {};
var translationCache = {};
var loadingPromises = {};
var getBuiltinLocalesDir = /* @__PURE__ */ __name(() => path.join(resolveBundleDir(import.meta.url), "locales"), "getBuiltinLocalesDir");
var getUserLocalesDir = /* @__PURE__ */ __name(() => path.join(Storage.getGlobalQwenDir(), "locales"), "getUserLocalesDir");
function getUserLocalesDirectory() {
  return getUserLocalesDir();
}
__name(getUserLocalesDirectory, "getUserLocalesDirectory");
var getLocalePath = /* @__PURE__ */ __name((lang, useUserDir = false) => {
  const baseDir = useUserDir ? getUserLocalesDir() : getBuiltinLocalesDir();
  return path.join(baseDir, `${lang}.js`);
}, "getLocalePath");
function detectSystemLanguage() {
  const envLang = process.env["QWEN_CODE_LANG"] || process.env["LANG"];
  if (envLang) {
    const resolved = resolveSupportedLanguage(envLang);
    if (resolved) {
      return resolved;
    }
  }
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    const resolved = resolveSupportedLanguage(locale);
    if (resolved) {
      return resolved;
    }
  } catch {
  }
  return "en";
}
__name(detectSystemLanguage, "detectSystemLanguage");
async function tryImportTranslations(moduleSpecifier) {
  try {
    const module = await import(moduleSpecifier);
    const result = getTranslationModuleExport(module);
    if (isTranslationDict(result)) {
      return { translations: result };
    }
    return {
      error: new Error("Module loaded but result is empty or invalid")
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}
__name(tryImportTranslations, "tryImportTranslations");
async function tryImportBundledTranslations(lang) {
  try {
    const module = await globImport_locales_js(`./locales/${lang}.js`);
    const result = getTranslationModuleExport(module);
    if (isTranslationDict(result)) {
      return { translations: result };
    }
    return {
      error: new Error("Module loaded but result is empty or invalid")
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}
__name(tryImportBundledTranslations, "tryImportBundledTranslations");
async function loadTranslationsAsync(lang) {
  if (translationCache[lang]) {
    return translationCache[lang];
  }
  const existingPromise = loadingPromises[lang];
  if (existingPromise) {
    return existingPromise;
  }
  const loadPromise = (async () => {
    const userJsPath = getLocalePath(lang, true);
    if (fs.existsSync(getUserLocalesDir()) && fs.existsSync(userJsPath)) {
      const userResult = await tryImportTranslations(
        pathToFileURL(userJsPath).href
      );
      if (userResult.translations) {
        translationCache[lang] = userResult.translations;
        return userResult.translations;
      }
      writeStderrLine(
        `Failed to load translations from user directory for ${lang}: ${userResult.error.message}`
      );
    }
    const builtinJsPath = getLocalePath(lang, false);
    const builtinModuleSpecifiers = [];
    if (fs.existsSync(getBuiltinLocalesDir()) && fs.existsSync(builtinJsPath)) {
      builtinModuleSpecifiers.push(pathToFileURL(builtinJsPath).href);
    }
    let lastBuiltinError;
    for (const moduleSpecifier of builtinModuleSpecifiers) {
      const builtinResult = await tryImportTranslations(moduleSpecifier);
      if (builtinResult.translations) {
        translationCache[lang] = builtinResult.translations;
        return builtinResult.translations;
      }
      lastBuiltinError = builtinResult.error;
    }
    const bundledBuiltinResult = await tryImportBundledTranslations(lang);
    if (bundledBuiltinResult.translations) {
      translationCache[lang] = bundledBuiltinResult.translations;
      return bundledBuiltinResult.translations;
    }
    lastBuiltinError = bundledBuiltinResult.error;
    if (lastBuiltinError) {
      writeStderrLine(
        `Failed to load JS translations for ${lang}: ${lastBuiltinError.message}`
      );
    }
    translationCache[lang] = {};
    return {};
  })();
  loadingPromises[lang] = loadPromise;
  loadPromise.finally(() => {
    delete loadingPromises[lang];
  });
  return loadPromise;
}
__name(loadTranslationsAsync, "loadTranslationsAsync");
function loadTranslations(lang) {
  return translationCache[lang] || {};
}
__name(loadTranslations, "loadTranslations");
function interpolate(template, params) {
  if (!params) return template;
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (match, key) => params[key] ?? match
  );
}
__name(interpolate, "interpolate");
function resolveLanguage(lang) {
  if (lang === "auto") {
    return detectSystemLanguage();
  }
  return resolveSupportedLanguage(lang) ?? lang;
}
__name(resolveLanguage, "resolveLanguage");
function setLanguage(lang) {
  const resolvedLang = resolveLanguage(lang);
  currentLanguage = resolvedLang;
  const loaded = loadTranslations(resolvedLang);
  translations = loaded;
  if (Object.keys(loaded).length === 0) {
    const userJsPath = getLocalePath(resolvedLang, true);
    const builtinJsPath = getLocalePath(resolvedLang, false);
    if (fs.existsSync(userJsPath) || fs.existsSync(builtinJsPath)) {
      writeStderrLine(
        `Language file for ${resolvedLang} requires async loading. Use setLanguageAsync() instead, or call initializeI18n() first.`
      );
    }
  }
}
__name(setLanguage, "setLanguage");
async function setLanguageAsync(lang) {
  currentLanguage = resolveLanguage(lang);
  translations = await loadTranslationsAsync(currentLanguage);
}
__name(setLanguageAsync, "setLanguageAsync");
function getCurrentLanguage() {
  return currentLanguage;
}
__name(getCurrentLanguage, "getCurrentLanguage");
function t(key, params) {
  const translation = translations[key] ?? key;
  if (Array.isArray(translation)) {
    return key;
  }
  return interpolate(translation, params);
}
__name(t, "t");
function localizeToolDisplayName(displayName) {
  const key = `toolDisplayName.${displayName}`;
  const translated = t(key);
  return translated === key ? displayName : translated;
}
__name(localizeToolDisplayName, "localizeToolDisplayName");
function ta(key) {
  const translation = translations[key];
  if (Array.isArray(translation)) {
    return translation;
  }
  return [];
}
__name(ta, "ta");
async function initializeI18n(lang) {
  await setLanguageAsync(lang ?? "auto");
}
__name(initializeI18n, "initializeI18n");
function resolveLanguageSetting(settingsLanguage) {
  return process.env["QWEN_CODE_LANG"] || settingsLanguage || "auto";
}
__name(resolveLanguageSetting, "resolveLanguageSetting");

export {
  MUST_TRANSLATE_KEYS,
  getUserLocalesDirectory,
  detectSystemLanguage,
  resolveLanguage,
  setLanguage,
  setLanguageAsync,
  getCurrentLanguage,
  t,
  localizeToolDisplayName,
  ta,
  initializeI18n,
  resolveLanguageSetting
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */
