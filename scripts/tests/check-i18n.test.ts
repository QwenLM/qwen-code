/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageDefinition } from '../../packages/cli/src/i18n/languages.js';
import {
  checkI18n,
  printCheckI18nResult,
  shouldWriteUnusedKeysJson,
  type CheckI18nOptions,
} from '../check-i18n.js';

vi.unmock('fs');
vi.unmock('node:fs');

type TestLanguage = Pick<LanguageDefinition, 'code' | 'id' | 'strictParity'>;
type TestLanguageInput =
  | string
  | (Pick<LanguageDefinition, 'code'> &
      Partial<Pick<LanguageDefinition, 'id' | 'strictParity'>>);
type LocaleEntries = Record<string, string>;

const tempDirs: string[] = [];

function makeFixture(): {
  root: string;
  localesDir: string;
  sourceDir: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'qwen-check-i18n-'));
  tempDirs.push(root);

  const localesDir = path.join(root, 'locales');
  const sourceDir = path.join(root, 'src');
  mkdirSync(localesDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });

  return { root, localesDir, sourceDir };
}

function writeLocale(
  localesDir: string,
  code: string,
  entries: LocaleEntries,
): void {
  const lines = Object.entries(entries).map(
    ([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`,
  );
  writeFileSync(
    path.join(localesDir, `${code}.js`),
    `export default {\n${lines.join('\n')}\n};\n`,
  );
}

function writeSource(sourceDir: string, content: string): void {
  writeFileSync(path.join(sourceDir, 'fixture.ts'), content);
}

function languages(
  ...definitions: TestLanguageInput[]
): NonNullable<CheckI18nOptions['supportedLanguages']> {
  return definitions.map((definition) => {
    const language =
      typeof definition === 'string' ? { code: definition } : definition;
    const strictParity =
      language.strictParity ?? ['zh', 'zh-TW'].includes(language.code);

    return {
      id: `${language.code}-test`,
      ...language,
      strictParity,
    } satisfies TestLanguage;
  });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('checkI18n', () => {
  it('records locale load failures and continues checking other locales', async () => {
    const { localesDir, sourceDir } = makeFixture();
    writeLocale(localesDir, 'en', { Used: 'Used' });
    writeFileSync(path.join(localesDir, 'broken.js'), 'export default null;\n');
    writeLocale(localesDir, 'fr', { Used: 'Utilise' });
    writeSource(sourceDir, "t('Used');\n");

    const result = await checkI18n({
      localesDir,
      sourceDir,
      supportedLanguages: languages('en', 'broken', 'fr'),
      mustTranslateKeys: [],
    });

    expect(result.success).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining(
        'Failed to load broken.js: Invalid locale module',
      ),
    );
    expect(result.stats.locales.map((locale) => locale.code)).toEqual(['fr']);
  });

  it('returns a failed empty result when en.js is missing', async () => {
    const { localesDir, sourceDir } = makeFixture();
    writeLocale(localesDir, 'fr', { Used: 'Utilise' });
    writeSource(sourceDir, "t('Used');\n");

    const result = await checkI18n({
      localesDir,
      sourceDir,
      supportedLanguages: languages('en', 'fr'),
      mustTranslateKeys: [],
    });

    expect(result.success).toBe(false);
    expect(result.stats.totalKeys).toBe(0);
    expect(result.stats.locales).toEqual([]);
    expect(result.errors).toContainEqual(
      expect.stringContaining('Failed to load en.js:'),
    );
  });

  it('enforces strict key parity for zh and zh-TW', async () => {
    const { localesDir, sourceDir } = makeFixture();
    writeLocale(localesDir, 'en', {
      Used: 'Used',
      MissingInStrict: 'MissingInStrict',
    });
    writeLocale(localesDir, 'zh', {
      Used: '已使用',
      ExtraStrict: '额外',
    });
    writeLocale(localesDir, 'zh-TW', {
      Used: '已使用',
      ExtraStrict: '額外',
    });
    writeSource(sourceDir, "t('Used');\nt('MissingInStrict');\n");

    const result = await checkI18n({
      localesDir,
      sourceDir,
      supportedLanguages: languages('en', 'zh', 'zh-TW'),
      mustTranslateKeys: [],
    });

    expect(result.errors).toContain(
      'Missing translation in zh.js: "MissingInStrict"',
    );
    expect(result.errors).toContain(
      'Extra key in zh.js (not in en.js): "ExtraStrict"',
    );
    expect(result.errors).toContain(
      'Missing translation in zh-TW.js: "MissingInStrict"',
    );
    expect(result.errors).toContain(
      'Extra key in zh-TW.js (not in en.js): "ExtraStrict"',
    );
  });

  it('uses language metadata to decide strict key parity', async () => {
    const { localesDir, sourceDir } = makeFixture();
    writeLocale(localesDir, 'en', {
      Used: 'Used',
      MissingInStrict: 'MissingInStrict',
    });
    writeLocale(localesDir, 'fr', {
      Used: 'Utilise',
      ExtraStrict: 'Supplémentaire',
    });
    writeSource(sourceDir, "t('Used');\nt('MissingInStrict');\n");

    const result = await checkI18n({
      localesDir,
      sourceDir,
      supportedLanguages: languages('en', {
        code: 'fr',
        strictParity: true,
      }),
      mustTranslateKeys: [],
    });

    expect(result.errors).toContain(
      'Missing translation in fr.js: "MissingInStrict"',
    );
    expect(result.errors).toContain(
      'Extra key in fr.js (not in en.js): "ExtraStrict"',
    );
  });

  it('warns for non-strict optional missing keys and errors for required keys', async () => {
    const { localesDir, sourceDir } = makeFixture();
    writeLocale(localesDir, 'en', {
      Optional: 'Optional',
      Required: 'Required',
    });
    writeLocale(localesDir, 'fr', { ExtraLoose: 'Supplémentaire' });
    writeSource(sourceDir, "t('Optional');\nt('Required');\n");

    const result = await checkI18n({
      localesDir,
      sourceDir,
      supportedLanguages: languages('en', 'fr'),
      mustTranslateKeys: ['Required'],
    });

    expect(result.errors).toContain(
      'Missing required translation in fr.js: "Required"',
    );
    expect(result.warnings).toContain(
      'fr.js is missing 1 non-required translation keys',
    );
  });

  it('warns instead of errors for extra keys in non-strict locales', async () => {
    const { localesDir, sourceDir } = makeFixture();
    writeLocale(localesDir, 'en', { Used: 'Used' });
    writeLocale(localesDir, 'fr', {
      Used: 'Utilise',
      ExtraLoose: 'Supplémentaire',
    });
    writeSource(sourceDir, "t('Used');\n");

    const result = await checkI18n({
      localesDir,
      sourceDir,
      supportedLanguages: languages('en', 'fr'),
      mustTranslateKeys: [],
    });

    expect(result.errors).not.toContain(
      'Extra key in fr.js (not in en.js): "ExtraLoose"',
    );
    expect(result.warnings).toContain('fr.js has 1 keys not present in en.js');
  });

  it('errors when a required translation still falls back to English', async () => {
    const { localesDir, sourceDir } = makeFixture();
    writeLocale(localesDir, 'en', { Required: 'Required' });
    writeLocale(localesDir, 'fr', { Required: 'Required' });
    writeSource(sourceDir, "t('Required');\n");

    const result = await checkI18n({
      localesDir,
      sourceDir,
      supportedLanguages: languages('en', 'fr'),
      mustTranslateKeys: ['Required'],
    });

    expect(result.errors).toContain(
      'Required translation still falls back to English in fr.js: "Required"',
    );
  });

  it('writes unused locale-only keys only when requested', async () => {
    const { root, localesDir, sourceDir } = makeFixture();
    writeLocale(localesDir, 'en', {
      Used: 'Used',
      LocaleOnly: 'LocaleOnly',
    });
    writeLocale(localesDir, 'fr', {
      Used: 'Utilise',
      LocaleOnly: 'Locale seulement',
    });
    writeSource(sourceDir, "t('Used');\n");

    const result = await checkI18n({
      localesDir,
      sourceDir,
      supportedLanguages: languages('en', 'fr'),
      mustTranslateKeys: [],
    });
    expect(result.stats.unusedKeysOnlyInLocales).toEqual(['LocaleOnly']);

    const outputPath = path.join(root, 'unused-keys-only-in-locales.json');
    printCheckI18nResult(result, {
      writeUnusedKeysJson: false,
      unusedKeysOutputPath: outputPath,
    });
    expect(() => readFileSync(outputPath, 'utf-8')).toThrow();

    printCheckI18nResult(result, {
      writeUnusedKeysJson: true,
      unusedKeysOutputPath: outputPath,
    });
    expect(JSON.parse(readFileSync(outputPath, 'utf-8'))).toEqual({
      keys: ['LocaleOnly'],
      count: 1,
    });
  });

  it('extracts escaped string-literal translation keys from source files', async () => {
    const { localesDir, sourceDir } = makeFixture();
    writeLocale(localesDir, 'en', {
      "Quoted ' key": "Quoted ' key",
      'Tabbed\tkey': 'Tabbed\tkey',
      'Line\nbreak': 'Line\nbreak',
    });
    writeLocale(localesDir, 'fr', {
      "Quoted ' key": 'Clé avec apostrophe',
      'Tabbed\tkey': 'Clé avec tabulation',
      'Line\nbreak': 'Saut de ligne',
    });
    writeSource(
      sourceDir,
      [
        "t('Quoted \\' key');",
        't("Tabbed\\tkey");',
        "ta('Line\\nbreak');",
      ].join('\n'),
    );

    const result = await checkI18n({
      localesDir,
      sourceDir,
      supportedLanguages: languages('en', 'fr'),
      mustTranslateKeys: [],
    });

    expect(result.stats.unusedKeys).toEqual([]);
  });

  it('detects the unused-keys JSON flag from argv or env', () => {
    const originalArgv = process.argv;
    const originalEnv = process.env['QWEN_CHECK_I18N_WRITE_UNUSED_KEYS'];

    try {
      process.argv = ['node', 'check-i18n.ts'];
      delete process.env['QWEN_CHECK_I18N_WRITE_UNUSED_KEYS'];
      expect(shouldWriteUnusedKeysJson()).toBe(false);

      process.argv = ['node', 'check-i18n.ts', '--write-unused-locale-keys'];
      expect(shouldWriteUnusedKeysJson()).toBe(true);

      process.argv = ['node', 'check-i18n.ts'];
      process.env['QWEN_CHECK_I18N_WRITE_UNUSED_KEYS'] = '1';
      expect(shouldWriteUnusedKeysJson()).toBe(true);
    } finally {
      process.argv = originalArgv;
      if (originalEnv === undefined) {
        delete process.env['QWEN_CHECK_I18N_WRITE_UNUSED_KEYS'];
      } else {
        process.env['QWEN_CHECK_I18N_WRITE_UNUSED_KEYS'] = originalEnv;
      }
    }
  });
});
