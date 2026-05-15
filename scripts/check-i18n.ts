#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { glob } from 'glob';
import {
  MUST_TRANSLATE_KEYS,
  SUPPORTED_LANGUAGES,
} from '../packages/cli/src/i18n/index.js';
import type { LanguageDefinition } from '../packages/cli/src/i18n/languages.js';
import {
  getTranslationModuleExport,
  isTranslationDict,
  type TranslationDict,
} from '../packages/cli/src/i18n/translationDict.js';

export interface LocaleStats {
  code: string;
  id: string;
  totalKeys: number;
  translatedKeys: number;
  missingKeys: string[];
  extraKeys: string[];
  untranslatedMustKeys: string[];
}

export interface CheckResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    totalKeys: number;
    unusedKeys: string[];
    unusedKeysOnlyInLocales?: string[];
    locales: LocaleStats[];
  };
}

export interface CheckI18nOptions {
  localesDir?: string;
  sourceDir?: string;
  supportedLanguages?: readonly Pick<
    LanguageDefinition,
    'code' | 'id' | 'strictParity'
  >[];
  mustTranslateKeys?: readonly string[];
  strictKeyParityLocales?: ReadonlySet<string>;
}

export interface PrintCheckI18nOptions {
  writeUnusedKeysJson?: boolean;
  unusedKeysOutputPath?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRITE_UNUSED_KEYS_FLAG = '--write-unused-locale-keys';
const WRITE_UNUSED_KEYS_ENV = 'QWEN_CHECK_I18N_WRITE_UNUSED_KEYS';

export function shouldWriteUnusedKeysJson(): boolean {
  return (
    process.argv.includes(WRITE_UNUSED_KEYS_FLAG) ||
    process.env[WRITE_UNUSED_KEYS_ENV] === '1'
  );
}

/**
 * Substrings that should not appear in zh-TW (Taiwan Traditional Chinese) values.
 *
 * Three categories of regressions we want to catch automatically:
 *   1. Variant Traditional characters that OpenCC s2t produces by default but
 *      Taiwan does not use as primary forms (e.g. 爲, 啓).
 *   2. Mainland-Chinese vocabulary whose characters are valid Traditional but
 *      the word itself is not used in Taiwan (e.g. 服務器, 菜單, 鏈接).
 *   3. Pure Simplified Chinese characters that would only appear if OpenCC
 *      was not run at all (e.g. 为, 启, 链).
 *
 * Deliberately excluded to avoid false positives:
 *   - 禁用 / 配置 / 設置 — standard in Taiwan.
 *   - 文件 — contextual (can legitimately mean "document").
 *   - 打開 — colloquially common in Taiwan even if 開啟 is preferred for UI.
 *   - Bare 鏈 — valid in 區塊鏈 etc.; only the bigram 鏈接 is flagged.
 *
 * Known limitation: matching is plain substring (`includes()`) and does not
 * respect Chinese word boundaries. Bigram patterns can therefore false-positive
 * across compound-word boundaries — e.g. `區塊鏈接口` (= `區塊鏈` + `接口`)
 * contains the substring `鏈接` even though neither word is wrong. When this
 * happens, add the affected translation key to ZH_TW_ALLOWED_EXCEPTIONS below
 * with a brief justification, rather than weakening the pattern list.
 */
const ZH_TW_FORBIDDEN_PATTERNS_RAW: ReadonlyArray<{
  pattern: string;
  preferred: string;
}> = [
  // Variant Traditional characters from OpenCC s2t output
  { pattern: '爲', preferred: '為' },
  { pattern: '啓', preferred: '啟' },
  // Mainland-Chinese vocabulary (valid Traditional chars, wrong word for Taiwan)
  { pattern: '曆史', preferred: '歷史' },
  { pattern: '鏈接', preferred: '連結' },
  { pattern: '菜單', preferred: '選單' },
  { pattern: '服務器', preferred: '伺服器' },
  // Same Mainland vocabulary written in Simplified form
  { pattern: '菜单', preferred: '選單' },
  { pattern: '服务器', preferred: '伺服器' },
  { pattern: '链接', preferred: '連結' },
  { pattern: '历史', preferred: '歷史' },
  // Pure Simplified characters (no ambiguity with valid Traditional usage)
  { pattern: '为', preferred: '為' },
  { pattern: '启', preferred: '啟' },
  { pattern: '历', preferred: '歷' },
  { pattern: '链', preferred: '鏈/連' },
  { pattern: '选', preferred: '選' },
  { pattern: '删', preferred: '刪' },
  { pattern: '扩', preferred: '擴' },
  { pattern: '设', preferred: '設' },
  { pattern: '详', preferred: '詳' },
  { pattern: '认', preferred: '認' },
];

// Sorted longest-first so that more specific patterns (e.g. `历史`) are matched
// before their constituent characters (`历`), avoiding duplicate findings on
// the same translation value.
const ZH_TW_FORBIDDEN_PATTERNS = [...ZH_TW_FORBIDDEN_PATTERNS_RAW].sort(
  (a, b) => b.pattern.length - a.pattern.length,
);

/**
 * Translation keys whose zh-TW value is allowed to contain an otherwise
 * forbidden substring. Use this as an escape hatch when a legitimate
 * translation needs a normally-banned character or word — add the key here
 * with a comment explaining why, instead of weakening the global pattern list.
 *
 * Example:
 *   'Open block explorer for {{address}}': '...區塊鏈瀏覽器...', // 區塊鏈 = blockchain
 */
const ZH_TW_ALLOWED_EXCEPTIONS: ReadonlySet<string> = new Set<string>([
  // (empty — no legitimate exceptions today)
]);

/**
 * Walk every translation value and report any value containing a forbidden
 * substring. Iterating over the parsed dict (rather than the raw file)
 * lets us report the offending key, and avoids matching characters inside
 * file-level comments or JS syntax.
 *
 * Only the longest matching pattern per value is reported, to keep CI output
 * focused on the most actionable fix.
 */
export function findForbiddenZhTwPatterns(
  translations: TranslationDict,
): Array<{ key: string; pattern: string; preferred: string }> {
  const findings: Array<{ key: string; pattern: string; preferred: string }> =
    [];

  for (const [key, value] of Object.entries(translations)) {
    if (ZH_TW_ALLOWED_EXCEPTIONS.has(key)) continue;
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      for (const { pattern, preferred } of ZH_TW_FORBIDDEN_PATTERNS) {
        if (candidate.includes(pattern)) {
          findings.push({ key, pattern, preferred });
          break;
        }
      }
    }
  }

  return findings;
}

async function loadTranslationsFile(
  filePath: string,
): Promise<TranslationDict> {
  const fileUrl = pathToFileURL(filePath).href;
  const module = await import(fileUrl);
  const result = getTranslationModuleExport(module);

  if (!isTranslationDict(result)) {
    throw new Error(`Invalid locale module: ${filePath}`);
  }

  return result as TranslationDict;
}

function extractStringLiteral(
  content: string,
  startPos: number,
  quote: string,
): { value: string; endPos: number } | null {
  let pos = startPos + 1;
  let value = '';
  let escaped = false;

  while (pos < content.length) {
    const char = content[pos];

    if (escaped) {
      if (char === '\\') {
        value += '\\';
      } else if (char === quote) {
        value += quote;
      } else if (char === 'n') {
        value += '\n';
      } else if (char === 't') {
        value += '\t';
      } else if (char === 'r') {
        value += '\r';
      } else {
        value += char;
      }
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === quote) {
      return { value, endPos: pos };
    } else {
      value += char;
    }

    pos++;
  }

  return null;
}

async function extractUsedKeys(sourceDir: string): Promise<Set<string>> {
  const usedKeys = new Set<string>();

  const files = await glob('**/*.{ts,tsx}', {
    cwd: sourceDir,
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
  });

  for (const file of files) {
    const filePath = path.join(sourceDir, file);

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const tCallRegex = /\bta?\s*\(/g;
      let match: RegExpExecArray | null;

      while ((match = tCallRegex.exec(content)) !== null) {
        let pos = match.index + match[0].length;

        while (pos < content.length && /\s/.test(content[pos])) {
          pos++;
        }

        if (pos >= content.length) {
          continue;
        }

        const char = content[pos];
        if (char === "'" || char === '"') {
          const result = extractStringLiteral(content, pos, char);
          if (result) {
            usedKeys.add(result.value);
          }
        }
      }
    } catch {
      continue;
    }
  }

  return usedKeys;
}

function checkKeyValueConsistency(enTranslations: TranslationDict): string[] {
  const errors: string[] = [];

  for (const [key, value] of Object.entries(enTranslations)) {
    if (Array.isArray(value)) {
      continue;
    }

    if (key !== value) {
      errors.push(`Key-value mismatch in en.js: "${key}" !== "${value}"`);
    }
  }

  return errors;
}

function translationValuesMatch(
  left: TranslationValue | undefined,
  right: TranslationValue | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function countTranslatedKeys(
  enTranslations: TranslationDict,
  localeTranslations: TranslationDict,
): number {
  let translatedKeys = 0;

  for (const [key, enValue] of Object.entries(enTranslations)) {
    if (
      key in localeTranslations &&
      !translationValuesMatch(localeTranslations[key], enValue)
    ) {
      translatedKeys++;
    }
  }

  return translatedKeys;
}

function findUnusedKeys(allKeys: Set<string>, usedKeys: Set<string>): string[] {
  return Array.from(allKeys)
    .filter((key) => !usedKeys.has(key))
    .sort();
}

function saveKeysOnlyInLocalesToJson(
  keysOnlyInLocales: string[],
  outputPath: string,
): void {
  try {
    const data = {
      keys: keysOnlyInLocales,
      count: keysOnlyInLocales.length,
    };
    fs.writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`Keys that exist only in locale files saved to: ${outputPath}`);
  } catch (error) {
    console.error(`Failed to save keys to JSON file: ${error}`);
  }
}

async function findKeysOnlyInLocales(
  unusedKeys: string[],
  sourceDir: string,
  localesDir: string,
): Promise<string[]> {
  if (unusedKeys.length === 0) {
    return [];
  }

  const keysOnlyInLocales: string[] = [];
  const localesDirName = path.basename(localesDir);

  const files = await glob('**/*.{ts,tsx}', {
    cwd: sourceDir,
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      `**/${localesDirName}/**`,
    ],
  });

  const foundKeys = new Set<string>();

  for (const file of files) {
    const filePath = path.join(sourceDir, file);

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const key of unusedKeys) {
        if (!foundKeys.has(key) && content.includes(key)) {
          foundKeys.add(key);
        }
      }
    } catch {
      continue;
    }
  }

  for (const key of unusedKeys) {
    if (!foundKeys.has(key)) {
      keysOnlyInLocales.push(key);
    }
  }

  return keysOnlyInLocales;
}

export async function checkI18n(
  options: CheckI18nOptions = {},
): Promise<CheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const localesDir =
    options.localesDir ??
    path.join(__dirname, '../packages/cli/src/i18n/locales');
  const sourceDir =
    options.sourceDir ?? path.join(__dirname, '../packages/cli/src');
  const supportedLanguages = options.supportedLanguages ?? SUPPORTED_LANGUAGES;
  const mustTranslateKeys = options.mustTranslateKeys ?? MUST_TRANSLATE_KEYS;
  const mustTranslateKeySet = new Set(mustTranslateKeys);
  const strictKeyParityLocales =
    options.strictKeyParityLocales ??
    new Set(
      supportedLanguages
        .filter((language) => language.strictParity)
        .map((language) => language.code),
    );

  const localeDefinitions = supportedLanguages.map((language) => ({
    code: language.code,
    id: language.id,
    path: path.join(localesDir, `${language.code}.js`),
  }));

  const localeTranslations = new Map<string, TranslationDict>();

  for (const locale of localeDefinitions) {
    try {
      localeTranslations.set(
        locale.code,
        await loadTranslationsFile(locale.path),
      );
    } catch (error) {
      errors.push(
        `Failed to load ${locale.code}.js: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const enTranslations = localeTranslations.get('en');
  if (!enTranslations) {
    return {
      success: false,
      errors,
      warnings,
      stats: {
        totalKeys: 0,
        unusedKeys: [],
        locales: [],
      },
    };
  }

  errors.push(...checkKeyValueConsistency(enTranslations));

  const enKeys = new Set(Object.keys(enTranslations));
  const localeStats: LocaleStats[] = [];

  for (const locale of localeDefinitions) {
    if (locale.code === 'en') {
      continue;
    }

    const translations = localeTranslations.get(locale.code);
    if (!translations) {
      continue;
    }

    const localeKeys = new Set(Object.keys(translations));
    const missingKeys = Array.from(enKeys)
      .filter((key) => !localeKeys.has(key))
      .sort();
    const extraKeys = Array.from(localeKeys)
      .filter((key) => !enKeys.has(key))
      .sort();
    const untranslatedMustKeys = mustTranslateKeys.filter((key) => {
      const value = translations[key];
      return (
        value === undefined ||
        translationValuesMatch(value, enTranslations[key])
      );
    });
    const translatedKeys = countTranslatedKeys(enTranslations, translations);

    localeStats.push({
      code: locale.code,
      id: locale.id,
      totalKeys: enKeys.size,
      translatedKeys,
      missingKeys,
      extraKeys,
      untranslatedMustKeys,
    });

    const requiresStrictKeyParity = strictKeyParityLocales.has(locale.code);

    if (missingKeys.length > 0) {
      if (requiresStrictKeyParity) {
        for (const key of missingKeys) {
          errors.push(`Missing translation in ${locale.code}.js: "${key}"`);
        }
      } else {
        const missingRequiredKeys = missingKeys.filter((key) =>
          mustTranslateKeySet.has(key),
        );
        const missingOptionalKeyCount =
          missingKeys.length - missingRequiredKeys.length;

        for (const key of missingRequiredKeys) {
          errors.push(
            `Missing required translation in ${locale.code}.js: "${key}"`,
          );
        }

        if (missingOptionalKeyCount > 0) {
          warnings.push(
            `${locale.code}.js is missing ${missingOptionalKeyCount} non-required translation keys`,
          );
        }
      }
    }

    if (extraKeys.length > 0) {
      if (requiresStrictKeyParity) {
        for (const key of extraKeys) {
          errors.push(
            `Extra key in ${locale.code}.js (not in en.js): "${key}"`,
          );
        }
      } else {
        warnings.push(
          `${locale.code}.js has ${extraKeys.length} keys not present in en.js`,
        );
      }
    }

    for (const key of untranslatedMustKeys) {
      errors.push(
        `Required translation still falls back to English in ${locale.code}.js: "${key}"`,
      );
    }
  }

  // Check zh-TW.js for Taiwan-vocabulary regressions (raw OpenCC output,
  // Mainland-Chinese vocabulary, or Simplified characters slipping in).
  const zhTWTranslations = localeTranslations.get('zh-TW');
  if (zhTWTranslations) {
    for (const { key, pattern, preferred } of findForbiddenZhTwPatterns(
      zhTWTranslations,
    )) {
      errors.push(
        `Non-Taiwan vocabulary in zh-TW.js at "${key}": "${pattern}" should be "${preferred}"`,
      );
    }
  }

  const usedKeys = await extractUsedKeys(sourceDir);
  const unusedKeys = findUnusedKeys(enKeys, usedKeys);
  const unusedKeysOnlyInLocales =
    unusedKeys.length > 0
      ? await findKeysOnlyInLocales(unusedKeys, sourceDir, localesDir)
      : [];

  if (unusedKeys.length > 0) {
    warnings.push(`Found ${unusedKeys.length} unused translation keys`);
  }

  return {
    success: errors.length === 0,
    errors,
    warnings,
    stats: {
      totalKeys: enKeys.size,
      unusedKeys,
      unusedKeysOnlyInLocales,
      locales: localeStats,
    },
  };
}

export function printCheckI18nResult(
  result: CheckResult,
  options: PrintCheckI18nOptions = {},
): void {
  console.log('\n=== i18n Check Results ===\n');
  console.log(`Total keys: ${result.stats.totalKeys}\n`);
  console.log('Locale coverage:');

  for (const locale of result.stats.locales) {
    const coverage =
      locale.totalKeys > 0
        ? ((locale.translatedKeys / locale.totalKeys) * 100).toFixed(1)
        : '0.0';

    console.log(
      `  - ${locale.id} (${locale.code}): ${locale.translatedKeys}/${locale.totalKeys} translated (${coverage}%)`,
    );
  }

  console.log();

  if (result.warnings.length > 0) {
    console.log('⚠️  Warnings:');
    result.warnings.forEach((warning) => console.log(`  - ${warning}`));

    if (
      result.stats.unusedKeys.length > 0 &&
      result.stats.unusedKeys.length <= 10
    ) {
      console.log('\nUnused keys:');
      result.stats.unusedKeys.forEach((key) => console.log(`  - "${key}"`));
    } else if (result.stats.unusedKeys.length > 10) {
      console.log(
        `\nUnused keys (showing first 10 of ${result.stats.unusedKeys.length}):`,
      );
      result.stats.unusedKeys
        .slice(0, 10)
        .forEach((key) => console.log(`  - "${key}"`));
    }

    if (
      result.stats.unusedKeysOnlyInLocales &&
      result.stats.unusedKeysOnlyInLocales.length > 0
    ) {
      console.log(
        '\n⚠️  The following keys exist ONLY in locale files and nowhere else in the codebase:',
      );
      console.log(
        '   Please review these keys - they might be safe to remove.',
      );
      result.stats.unusedKeysOnlyInLocales.forEach((key) =>
        console.log(`  - "${key}"`),
      );

      if (options.writeUnusedKeysJson) {
        const outputPath =
          options.unusedKeysOutputPath ??
          path.join(__dirname, 'unused-keys-only-in-locales.json');
        saveKeysOnlyInLocalesToJson(
          result.stats.unusedKeysOnlyInLocales,
          outputPath,
        );
      } else {
        console.log(
          `\nJSON report not written. Re-run with ${WRITE_UNUSED_KEYS_FLAG} or ${WRITE_UNUSED_KEYS_ENV}=1 to update it.`,
        );
      }
    }

    console.log();
  }
}

async function main() {
  const result = await checkI18n();

  printCheckI18nResult(result, {
    writeUnusedKeysJson: shouldWriteUnusedKeysJson(),
  });

  if (result.errors.length > 0) {
    console.log('❌ Errors:');
    result.errors.forEach((error) => console.log(`  - ${error}`));
    console.log();
    process.exit(1);
  }

  console.log('✅ All checks passed!\n');
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}
