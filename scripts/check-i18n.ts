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
import { SUPPORTED_LANGUAGES } from '../packages/cli/src/i18n/languages.ts';
import { MUST_TRANSLATE_KEYS } from '../packages/cli/src/i18n/mustTranslateKeys.ts';

type TranslationValue = string | string[];
type TranslationDict = Record<string, TranslationValue>;

interface LocaleStats {
  code: string;
  id: string;
  totalKeys: number;
  translatedKeys: number;
  missingKeys: string[];
  extraKeys: string[];
  untranslatedMustKeys: string[];
}

interface CheckResult {
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

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadTranslationsFile(
  filePath: string,
): Promise<TranslationDict> {
  const fileUrl = pathToFileURL(filePath).href;
  const module = await import(fileUrl);
  const result = module.default || module;

  if (!result || typeof result !== 'object') {
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
      generatedAt: new Date().toISOString(),
      keys: keysOnlyInLocales,
      count: keysOnlyInLocales.length,
    };
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
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

async function checkI18n(): Promise<CheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const localesDir = path.join(__dirname, '../packages/cli/src/i18n/locales');
  const sourceDir = path.join(__dirname, '../packages/cli/src');

  const localeDefinitions = SUPPORTED_LANGUAGES.map((language) => ({
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
    const untranslatedMustKeys = MUST_TRANSLATE_KEYS.filter((key) => {
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

    for (const key of missingKeys) {
      errors.push(`Missing translation in ${locale.code}.js: "${key}"`);
    }

    for (const key of untranslatedMustKeys) {
      errors.push(
        `Required translation still falls back to English in ${locale.code}.js: "${key}"`,
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

async function main() {
  const result = await checkI18n();

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

      const outputPath = path.join(
        __dirname,
        'unused-keys-only-in-locales.json',
      );
      saveKeysOnlyInLocalesToJson(
        result.stats.unusedKeysOnlyInLocales,
        outputPath,
      );
    }

    console.log();
  }

  if (result.errors.length > 0) {
    console.log('❌ Errors:');
    result.errors.forEach((error) => console.log(`  - ${error}`));
    console.log();
    process.exit(1);
  }

  console.log('✅ All checks passed!\n');
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
