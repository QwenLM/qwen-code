#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'glob';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get __dirname for ESM modules
// @ts-expect-error - import.meta is supported in NodeNext module system at runtime
const __dirname = dirname(fileURLToPath(import.meta.url));

interface CheckResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    totalKeys: number;
    translatedKeys: number;
    unusedKeys: string[];
    unusedKeysOnlyInLocales?: string[]; // 新增：只在 locales 中存在的未使用键
  };
}

/**
 * Load translations from JS file
 */
async function loadTranslationsFile(
  filePath: string,
): Promise<Record<string, string>> {
  try {
    // Dynamic import for ES modules
    const module = await import(filePath);
    return module.default || module;
  } catch (error) {
    // Fallback: try reading as JSON if JS import fails
    try {
      const content = fs.readFileSync(
        filePath.replace('.js', '.json'),
        'utf-8',
      );
      return JSON.parse(content);
    } catch {
      throw error;
    }
  }
}

/**
 * Extract string literal from code, handling escaped quotes
 */
function extractStringLiteral(
  content: string,
  startPos: number,
  quote: string,
): { value: string; endPos: number } | null {
  let pos = startPos + 1; // Skip opening quote
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

  return null; // String not closed
}

/**
 * Extract all t() calls from source files
 */
async function extractUsedKeys(sourceDir: string): Promise<Set<string>> {
  const usedKeys = new Set<string>();

  // Find all TypeScript/TSX files
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

      // Find all t( calls
      const tCallRegex = /t\s*\(/g;
      let match;
      while ((match = tCallRegex.exec(content)) !== null) {
        const startPos = match.index + match[0].length;
        let pos = startPos;

        // Skip whitespace
        while (pos < content.length && /\s/.test(content[pos])) {
          pos++;
        }

        if (pos >= content.length) continue;

        const char = content[pos];
        if (char === "'" || char === '"') {
          const result = extractStringLiteral(content, pos, char);
          if (result) {
            usedKeys.add(result.value);
          }
        }
      }
    } catch {
      // Skip files that can't be read
      continue;
    }
  }

  return usedKeys;
}

/**
 * Check key-value consistency in en.js
 */
function checkKeyValueConsistency(
  enTranslations: Record<string, string>,
): string[] {
  const errors: string[] = [];

  for (const [key, value] of Object.entries(enTranslations)) {
    if (key !== value) {
      errors.push(`Key-value mismatch: "${key}" !== "${value}"`);
    }
  }

  return errors;
}

/**
 * Check if en.js and zh.js have matching keys
 */
function checkKeyMatching(
  enTranslations: Record<string, string>,
  zhTranslations: Record<string, string>,
): string[] {
  const errors: string[] = [];
  const enKeys = new Set(Object.keys(enTranslations));
  const zhKeys = new Set(Object.keys(zhTranslations));

  // Check for keys in en but not in zh
  for (const key of enKeys) {
    if (!zhKeys.has(key)) {
      errors.push(`Missing translation in zh.js: "${key}"`);
    }
  }

  // Check for keys in zh but not in en
  for (const key of zhKeys) {
    if (!enKeys.has(key)) {
      errors.push(`Extra key in zh.js (not in en.js): "${key}"`);
    }
  }

  return errors;
}

/**
 * Find unused translation keys
 */
function findUnusedKeys(allKeys: Set<string>, usedKeys: Set<string>): string[] {
  return Array.from(allKeys)
    .filter((key) => !usedKeys.has(key))
    .sort();
}

/**
 * Save keys that exist only in locale files to a JSON file
 * @param keysOnlyInLocales Array of keys that exist only in locale files
 * @param outputPath Path to save the JSON file
 */
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

/**
 * Check if unused keys exist only in locale files and nowhere else in the codebase
 * Optimized to search all keys in a single pass instead of multiple grep calls
 * @param unusedKeys The list of unused keys to check
 * @param sourceDir The source directory to search in
 * @param localesDir The locales directory to exclude from search
 * @returns Array of keys that exist only in locale files
 */
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

  // Find all TypeScript/TSX files (excluding locales, node_modules, dist, and test files)
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

  // Read all files and check for key usage
  const foundKeys = new Set<string>();

  for (const file of files) {
    const filePath = path.join(sourceDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      // Check each unused key in the file content
      for (const key of unusedKeys) {
        if (!foundKeys.has(key) && content.includes(key)) {
          foundKeys.add(key);
        }
      }
    } catch {
      // Skip files that can't be read
      continue;
    }
  }

  // Keys that were not found in any source files exist only in locales
  for (const key of unusedKeys) {
    if (!foundKeys.has(key)) {
      keysOnlyInLocales.push(key);
    }
  }

  return keysOnlyInLocales;
}

/**
 * Main check function
 */
async function checkI18n(): Promise<CheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const localesDir = path.join(__dirname, '../packages/cli/src/i18n/locales');
  const sourceDir = path.join(__dirname, '../packages/cli/src');

  const enPath = path.join(localesDir, 'en.js');
  const zhPath = path.join(localesDir, 'zh.js');

  // Load translation files
  let enTranslations: Record<string, string>;
  let zhTranslations: Record<string, string>;

  try {
    enTranslations = await loadTranslationsFile(enPath);
  } catch (error) {
    errors.push(
      `Failed to load en.js: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      success: false,
      errors,
      warnings,
      stats: { totalKeys: 0, translatedKeys: 0, unusedKeys: [] },
    };
  }

  try {
    zhTranslations = await loadTranslationsFile(zhPath);
  } catch (error) {
    errors.push(
      `Failed to load zh.js: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      success: false,
      errors,
      warnings,
      stats: { totalKeys: 0, translatedKeys: 0, unusedKeys: [] },
    };
  }

  // Check key-value consistency in en.js
  const consistencyErrors = checkKeyValueConsistency(enTranslations);
  errors.push(...consistencyErrors);

  // Check key matching between en and zh
  const matchingErrors = checkKeyMatching(enTranslations, zhTranslations);
  errors.push(...matchingErrors);

  // Extract used keys from source code
  const usedKeys = await extractUsedKeys(sourceDir);

  // Find unused keys
  const enKeys = new Set(Object.keys(enTranslations));
  const unusedKeys = findUnusedKeys(enKeys, usedKeys);

  // Find keys that exist only in locales (and nowhere else in the codebase)
  const unusedKeysOnlyInLocales =
    unusedKeys.length > 0
      ? await findKeysOnlyInLocales(unusedKeys, sourceDir, localesDir)
      : [];

  if (unusedKeys.length > 0) {
    warnings.push(`Found ${unusedKeys.length} unused translation keys`);
  }

  const totalKeys = Object.keys(enTranslations).length;
  const translatedKeys = Object.keys(zhTranslations).length;

  return {
    success: errors.length === 0,
    errors,
    warnings,
    stats: {
      totalKeys,
      translatedKeys,
      unusedKeys,
      unusedKeysOnlyInLocales,
    },
  };
}

// Run checks
async function main() {
  const result = await checkI18n();

  console.log('\n=== i18n Check Results ===\n');

  console.log(`Total keys: ${result.stats.totalKeys}`);
  console.log(`Translated keys: ${result.stats.translatedKeys}`);
  const coverage =
    result.stats.totalKeys > 0
      ? ((result.stats.translatedKeys / result.stats.totalKeys) * 100).toFixed(
          1,
        )
      : '0.0';
  console.log(`Translation coverage: ${coverage}%\n`);

  if (result.warnings.length > 0) {
    console.log('⚠️  Warnings:');
    result.warnings.forEach((warning) => console.log(`  - ${warning}`));

    // Show unused keys
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

    // Show keys that exist only in locales files
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

      // Save these keys to a JSON file
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

  if (result.success) {
    console.log('✅ All checks passed!\n');
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
