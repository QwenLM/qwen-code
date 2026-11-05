/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { OUTPUT_LANGUAGE_TABLE } from '@qwen-code/qwen-code-core';

export type SupportedLanguage =
  | 'en'
  | 'zh'
  | 'zh-TW'
  | 'ru'
  | 'de'
  | 'ja'
  | 'pt'
  | 'fr'
  | 'ca'
  | string;

export interface LanguageDefinition {
  /** The internal locale code used by the i18n system (e.g., 'en', 'zh'). */
  code: SupportedLanguage;
  /** The standard name used in UI settings (e.g., 'en-US', 'zh-CN'). */
  id: string;
  /** The full English name of the language (e.g., 'English', 'Chinese'). */
  fullName: string;
  /** The native name of the language (e.g., 'English', '中文'). */
  nativeName?: string;
  /**
   * Whether tooling should require this locale to keep exact key parity with
   * en.js. Locales maintained in-tree can opt in as they reach full coverage.
   */
  strictParity?: boolean;
}

/**
 * Locales maintained in-tree, whose coverage tooling pins to exact en.js key
 * parity. The rest of the list is data: it comes from the shared
 * output-language table in core, so the CLI's settings and the Goal
 * verifier's closed set can never drift apart.
 */
const STRICT_PARITY_CODES = new Set<SupportedLanguage>(['zh', 'zh-TW']);

export const SUPPORTED_LANGUAGES: readonly LanguageDefinition[] =
  OUTPUT_LANGUAGE_TABLE.map((entry) => ({
    ...entry,
    ...(STRICT_PARITY_CODES.has(entry.code as SupportedLanguage)
      ? { strictParity: true }
      : {}),
  }));

function normalizeLanguageCandidate(input: string): string {
  return input.trim().replace(/_/g, '-').toLowerCase();
}

function matchesLocaleToken(candidate: string, token: string): boolean {
  return (
    candidate === token ||
    candidate.startsWith(`${token}-`) ||
    candidate.startsWith(`${token}.`) ||
    candidate.startsWith(`${token}@`)
  );
}

function getMatchedLocaleTokenLength(
  candidate: string,
  language: LanguageDefinition,
): number | undefined {
  const code = language.code.toLowerCase();
  const id = language.id.toLowerCase();

  if (matchesLocaleToken(candidate, id)) {
    return id.length;
  }

  if (matchesLocaleToken(candidate, code)) {
    return code.length;
  }

  return undefined;
}

/**
 * Resolves a language alias or locale ID to a supported canonical locale code.
 * Returns undefined for unsupported values so callers can preserve custom codes.
 */
export function resolveSupportedLanguage(
  input: string,
): SupportedLanguage | undefined {
  const normalized = normalizeLanguageCandidate(input);
  if (!normalized) {
    return undefined;
  }

  let bestMatch: { code: SupportedLanguage; tokenLength: number } | undefined;

  for (const language of SUPPORTED_LANGUAGES) {
    if (
      normalized === language.fullName.toLowerCase() ||
      (language.nativeName && normalized === language.nativeName.toLowerCase())
    ) {
      return language.code;
    }

    const tokenLength = getMatchedLocaleTokenLength(normalized, language);
    if (
      tokenLength !== undefined &&
      (!bestMatch || tokenLength > bestMatch.tokenLength)
    ) {
      bestMatch = { code: language.code, tokenLength };
    }
  }

  return bestMatch?.code;
}

/**
 * Maps a locale code to its English language name.
 * Used for LLM output language instructions.
 */
export function getLanguageNameFromLocale(locale: SupportedLanguage): string {
  const resolved = resolveSupportedLanguage(locale);
  const lang = resolved
    ? SUPPORTED_LANGUAGES.find((language) => language.code === resolved)
    : undefined;
  return lang?.fullName || 'English';
}

/**
 * Gets the language options for the settings schema.
 */
export function getLanguageSettingsOptions(): Array<{
  value: string;
  label: string;
}> {
  return [
    { value: 'auto', label: 'Auto (detect from system)' },
    ...SUPPORTED_LANGUAGES.map((l) => ({
      value: l.code,
      label: l.nativeName
        ? `${l.nativeName} (${l.fullName})`
        : `${l.fullName} (${l.id})`,
    })),
  ];
}

/**
 * Gets a string containing all supported language IDs (e.g., "en-US|zh-CN").
 */
export function getSupportedLanguageIds(separator = '|'): string {
  return SUPPORTED_LANGUAGES.map((l) => l.id).join(separator);
}
