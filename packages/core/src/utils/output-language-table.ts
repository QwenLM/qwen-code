/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The output-language designations the product knows about.
 *
 * This table is the single source of truth shared by two very different
 * consumers:
 *
 * - the CLI's i18n layer renders it as the language settings options;
 * - the Goal verifier must decide whether the marker value of an
 *   `output-language.md` file that it reads from disk is a language
 *   *designation* or an *instruction*.
 *
 * The verifier faces the untrusted case: `<cwd>/.qwen/output-language.md` is a
 * file a repository in the working tree can author, and it is read verbatim.
 * A character-class check cannot separate a language name from an
 * instruction written in the same script (a 13-character CJK sentence needs
 * no spaces and no punctuation), so the verifier accepts only a closed set:
 * `auto`, a designation from this table (any of its code/id/full name/native
 * name spellings), or a well-formed BCP-47 language tag. A designation the
 * product does not know simply does not localize the verdict — it is never
 * handed to the verifier as instruction material.
 */
export interface OutputLanguageEntry {
  /** The internal locale code used by the i18n system (e.g., 'en', 'zh'). */
  code: string;
  /** The standard name used in UI settings (e.g., 'en-US', 'zh-CN'). */
  id: string;
  /** The full English name of the language (e.g., 'English', 'Chinese'). */
  fullName: string;
  /** The native name of the language (e.g., 'English', '中文'). */
  nativeName?: string;
}

export const OUTPUT_LANGUAGE_TABLE: readonly OutputLanguageEntry[] = [
  {
    code: 'en',
    id: 'en-US',
    fullName: 'English',
    nativeName: 'English',
  },
  {
    code: 'zh-TW',
    id: 'zh-TW',
    fullName: 'Traditional Chinese',
    nativeName: '繁體中文',
  },
  {
    code: 'zh',
    id: 'zh-CN',
    fullName: 'Chinese',
    nativeName: '中文',
  },
  {
    code: 'ru',
    id: 'ru-RU',
    fullName: 'Russian',
    nativeName: 'Русский',
  },
  {
    code: 'de',
    id: 'de-DE',
    fullName: 'German',
    nativeName: 'Deutsch',
  },
  {
    code: 'ja',
    id: 'ja-JP',
    fullName: 'Japanese',
    nativeName: '日本語',
  },
  {
    code: 'pt',
    id: 'pt-BR',
    fullName: 'Portuguese',
    nativeName: 'Português',
  },
  {
    code: 'fr',
    id: 'fr-FR',
    fullName: 'French',
    nativeName: 'Français',
  },
  {
    code: 'ca',
    id: 'ca-ES',
    fullName: 'Catalan',
    nativeName: 'Català',
  },
];

/**
 * Well-formed BCP-47 language tag: a 2-3 letter primary subtag, an optional
 * 4-letter script, an optional region (2 letters or 3 digits), and up to two
 * variant subtags in the grammar's two shapes (5-8 alphanumeric, or a digit
 * followed by 3-4 alphanumeric). No spaces, punctuation, or digits beyond
 * the fixed subtag shapes, and no scripts outside the basic Latin alphabet —
 * so a sentence in any other script, or in English with spaces, can never
 * match, and a malformed pseudo-code like "pt-BR-2" or "en@US" does not.
 */
const BCP47_TAG =
  /^[a-z]{2,3}(?:-[a-z]{4})?(?:-[a-z]{2}|-\d{3})?(?:-(?:[a-z0-9]{5,8}|\d[a-z0-9]{3,4})){0,2}$/i;

/**
 * Whether the value is one of the designations the product itself writes:
 * a known language's code, settings id, full English name, or native name
 * (case-insensitive).
 */
export function isKnownOutputLanguageDesignation(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return OUTPUT_LANGUAGE_TABLE.some(
    (entry) =>
      normalized === entry.code.toLowerCase() ||
      normalized === entry.id.toLowerCase() ||
      normalized === entry.fullName.toLowerCase() ||
      (entry.nativeName !== undefined &&
        normalized === entry.nativeName.toLowerCase()),
  );
}

/** Whether the value is a well-formed BCP-47 language tag (e.g., `ru-RU`). */
export function isBcp47LanguageTag(value: string): boolean {
  return BCP47_TAG.test(value.trim());
}

// Stop at the next '<' so an unterminated marker cannot scan past another
// comment opener.
const OUTPUT_LANGUAGE_MARKER =
  /<!--\s*qwen-code:llm-output-language:([^<]*?)-->/gi;

/** Read the first single-line marker token from `output-language.md`. */
export function parseOutputLanguageMarker(content: string): string | undefined {
  for (const match of content.matchAll(OUTPUT_LANGUAGE_MARKER)) {
    const token = match[1]?.trim();
    if (token !== undefined && !/[\r\n\u2028\u2029]/.test(token)) return token;
  }
  return undefined;
}
