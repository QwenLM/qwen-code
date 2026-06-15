/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { Storage, resolveBundleDir } from '@qwen-code/qwen-code-core';
import {
  type SupportedLanguage,
  SUPPORTED_LANGUAGES,
  getLanguageNameFromLocale,
  resolveSupportedLanguage,
} from './languages.js';
import {
  getTranslationModuleExport,
  isTranslationDict,
  type TranslationDict,
} from './translationDict.js';
export { MUST_TRANSLATE_KEYS } from './mustTranslateKeys.js';

export type { SupportedLanguage };
export { SUPPORTED_LANGUAGES, getLanguageNameFromLocale };

// State
let currentLanguage: SupportedLanguage = 'en';
let translations: Record<string, string | string[]> = {};

const translationCache: Record<string, TranslationDict> = {};
const loadingPromises: Record<string, Promise<TranslationDict>> = {};

type TranslationLoadResult =
  | { translations: TranslationDict; error?: undefined }
  | { translations?: undefined; error: Error };

// Path helpers
//
// Anchor the bundled locales directory at the on-disk sibling of `cli.js`
// (i.e. `dist/locales/`, populated by `prepare-package.js`). See
// `resolveBundleDir` for the rationale behind stripping a trailing
// `chunks/` segment when this module is hoisted into a shared esbuild
// chunk.
const getBuiltinLocalesDir = (): string =>
  path.join(resolveBundleDir(import.meta.url), 'locales');

const getUserLocalesDir = (): string =>
  path.join(Storage.getGlobalQwenDir(), 'locales');

/**
 * Get the path to the user's custom locales directory.
 * Users can place custom language packs (e.g., es.js, fr.js) in this directory.
 * @returns The path to ~/.qwen/locales
 */
export function getUserLocalesDirectory(): string {
  return getUserLocalesDir();
}

const getLocalePath = (
  lang: SupportedLanguage,
  useUserDir: boolean = false,
): string => {
  const baseDir = useUserDir ? getUserLocalesDir() : getBuiltinLocalesDir();
  return path.join(baseDir, `${lang}.js`);
};

// Language detection
export function detectSystemLanguage(): SupportedLanguage {
  const envLang = process.env['QWEN_CODE_LANG'] || process.env['LANG'];
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
    // Fallback to default
  }

  return 'en';
}

// Translation loading
async function tryImportTranslations(
  moduleSpecifier: string,
): Promise<TranslationLoadResult> {
  try {
    const module = await import(moduleSpecifier);
    const result = getTranslationModuleExport(module);
    if (isTranslationDict(result)) {
      return { translations: result };
    }

    return {
      error: new Error('Module loaded but result is empty or invalid'),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

async function tryImportBundledTranslations(
  lang: SupportedLanguage,
): Promise<TranslationLoadResult> {
  try {
    const module = await import(`./locales/${lang}.js`);
    const result = getTranslationModuleExport(module);
    if (isTranslationDict(result)) {
      return { translations: result };
    }

    return {
      error: new Error('Module loaded but result is empty or invalid'),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

async function loadTranslationsAsync(
  lang: SupportedLanguage,
): Promise<TranslationDict> {
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
        pathToFileURL(userJsPath).href,
      );
      if (userResult.translations) {
        translationCache[lang] = userResult.translations;
        return userResult.translations;
      }

      writeStderrLine(
        `Failed to load translations from user directory for ${lang}: ${userResult.error.message}`,
      );
    }

    const builtinJsPath = getLocalePath(lang, false);
    const builtinModuleSpecifiers: string[] = [];
    if (fs.existsSync(getBuiltinLocalesDir()) && fs.existsSync(builtinJsPath)) {
      builtinModuleSpecifiers.push(pathToFileURL(builtinJsPath).href);
    }

    let lastBuiltinError: Error | undefined;
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
        `Failed to load JS translations for ${lang}: ${lastBuiltinError.message}`,
      );
    }

    // Return empty object if both directories fail
    // Cache it to avoid repeated failed attempts
    translationCache[lang] = {};
    return {};
  })();

  loadingPromises[lang] = loadPromise;

  // Clean up promise after completion to allow retry on next call if needed
  loadPromise.finally(() => {
    delete loadingPromises[lang];
  });

  return loadPromise;
}

function loadTranslations(lang: SupportedLanguage): TranslationDict {
  // Only return from cache (JS files require async loading)
  return translationCache[lang] || {};
}

// String interpolation
function interpolate(
  template: string,
  params?: Record<string, string>,
): string {
  if (!params) return template;
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (match, key) => params[key] ?? match,
  );
}

// Language setting helpers
function resolveLanguage(lang: SupportedLanguage | 'auto'): SupportedLanguage {
  if (lang === 'auto') {
    return detectSystemLanguage();
  }

  return resolveSupportedLanguage(lang) ?? lang;
}

// Public API
export function setLanguage(lang: SupportedLanguage | 'auto'): void {
  const resolvedLang = resolveLanguage(lang);
  currentLanguage = resolvedLang;

  // Try to load translations synchronously (from cache only)
  const loaded = loadTranslations(resolvedLang);
  translations = loaded;

  // Warn if translations are empty and JS file exists (requires async loading)
  if (Object.keys(loaded).length === 0) {
    const userJsPath = getLocalePath(resolvedLang, true);
    const builtinJsPath = getLocalePath(resolvedLang, false);
    if (fs.existsSync(userJsPath) || fs.existsSync(builtinJsPath)) {
      writeStderrLine(
        `Language file for ${resolvedLang} requires async loading. ` +
          `Use setLanguageAsync() instead, or call initializeI18n() first.`,
      );
    }
  }
}

export async function setLanguageAsync(
  lang: SupportedLanguage | 'auto',
): Promise<void> {
  currentLanguage = resolveLanguage(lang);
  translations = await loadTranslationsAsync(currentLanguage);
}

export function getCurrentLanguage(): SupportedLanguage {
  return currentLanguage;
}

export function t(key: string, params?: Record<string, string>): string {
  const translation = translations[key] ?? key;
  if (Array.isArray(translation)) {
    return key;
  }
  return interpolate(translation, params);
}

/**
 * Get a translation that is an array of strings.
 * @param key The translation key
 * @returns The array of strings, or an empty array if not found or not an array
 */
export function ta(key: string): string[] {
  const translation = translations[key];
  if (Array.isArray(translation)) {
    return translation;
  }
  return [];
}

export async function initializeI18n(
  lang?: SupportedLanguage | 'auto',
): Promise<void> {
  await setLanguageAsync(lang ?? 'auto');
}
