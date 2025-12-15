/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

export type SupportedLanguage = 'en' | 'zh' | 'ru' | string; // Allow custom language codes

// State
let currentLanguage: SupportedLanguage = 'en';
let translations: Record<string, string> = {};

// Cache
type TranslationDict = Record<string, string>;
const translationCache: Record<string, TranslationDict> = {};
const loadingPromises: Record<string, Promise<TranslationDict>> = {};

// Path helpers
const getBuiltinLocalesDir = (): string => {
  const __filename = fileURLToPath(import.meta.url);
  return path.join(path.dirname(__filename), 'locales');
};

const getUserLocalesDir = (): string =>
  path.join(homedir(), '.qwen', 'locales');

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
  if (envLang?.startsWith('zh')) return 'zh';
  if (envLang?.startsWith('en')) return 'en';
  if (envLang?.startsWith('ru')) return 'ru';

  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale.startsWith('zh')) return 'zh';
    if (locale.startsWith('ru')) return 'ru';
  } catch {
    // Fallback to default
  }

  return 'en';
}

// Translation loading
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
    // Try user directory first (for custom language packs), then builtin directory
    const searchDirs = [
      { dir: getUserLocalesDir(), isUser: true },
      { dir: getBuiltinLocalesDir(), isUser: false },
    ];

    for (const { dir, isUser } of searchDirs) {
      // Ensure directory exists
      if (!fs.existsSync(dir)) {
        continue;
      }

      const jsPath = getLocalePath(lang, isUser);
      if (!fs.existsSync(jsPath)) {
        continue;
      }

      try {
        // Convert file path to file:// URL for cross-platform compatibility
        const fileUrl = pathToFileURL(jsPath).href;
        try {
          const module = await import(fileUrl);
          const result = module.default || module;
          if (
            result &&
            typeof result === 'object' &&
            Object.keys(result).length > 0
          ) {
            translationCache[lang] = result;
            return result;
          } else {
            throw new Error('Module loaded but result is empty or invalid');
          }
        } catch {
          // For builtin locales, try alternative import method (relative path)
          if (!isUser) {
            try {
              const module = await import(`./locales/${lang}.js`);
              const result = module.default || module;
              if (
                result &&
                typeof result === 'object' &&
                Object.keys(result).length > 0
              ) {
                translationCache[lang] = result;
                return result;
              }
            } catch {
              // Continue to next directory
            }
          }
          // If import failed, continue to next directory
          continue;
        }
      } catch (error) {
        // Log warning but continue to next directory
        if (isUser) {
          console.warn(
            `Failed to load translations from user directory for ${lang}:`,
            error,
          );
        } else {
          console.warn(`Failed to load JS translations for ${lang}:`, error);
          if (error instanceof Error) {
            console.warn(`Error details: ${error.message}`);
            console.warn(`Stack: ${error.stack}`);
          }
        }
        // Continue to next directory
        continue;
      }
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
  return lang === 'auto' ? detectSystemLanguage() : lang;
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
      console.warn(
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
  return interpolate(translation, params);
}

export async function initializeI18n(
  lang?: SupportedLanguage | 'auto',
): Promise<void> {
  await setLanguageAsync(lang ?? 'auto');
}
