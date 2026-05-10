/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setLanguageAsync, t } from './index.js';
import { SUPPORTED_LANGUAGES } from './languages.js';
import { MUST_TRANSLATE_KEYS } from './mustTranslateKeys.js';
import { BuiltinCommandLoader } from '../services/BuiltinCommandLoader.js';
import { approvalModeCommand } from '../ui/commands/approvalModeCommand.js';
import { arenaCommand } from '../ui/commands/arenaCommand.js';
import { btwCommand } from '../ui/commands/btwCommand.js';
import { extensionsCommand } from '../ui/commands/extensionsCommand.js';
import { languageCommand } from '../ui/commands/languageCommand.js';
import { mcpCommand } from '../ui/commands/mcpCommand.js';
import { memoryCommand } from '../ui/commands/memoryCommand.js';
import { planCommand } from '../ui/commands/planCommand.js';
import { rememberCommand } from '../ui/commands/rememberCommand.js';
import { statuslineCommand } from '../ui/commands/statuslineCommand.js';
import type { SlashCommand } from '../ui/commands/types.js';

const NON_ENGLISH_LANGUAGES = SUPPORTED_LANGUAGES.filter(
  (language) => language.code !== 'en',
);
const STRICT_PARITY_NON_ENGLISH_LANGUAGES = NON_ENGLISH_LANGUAGES.filter(
  (language) => language.strictParity,
);

type TranslationValue = string | string[];
type TranslationDict = Record<string, TranslationValue>;

async function loadEnglishBaselineTranslations(): Promise<TranslationDict> {
  const localePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'locales',
    'en.js',
  );
  const module = (await import(pathToFileURL(localePath).href)) as {
    default?: TranslationDict;
  };

  return module.default ?? {};
}

function flattenCommandDescriptions(
  commands: SlashCommand[],
  prefix = '',
): Array<{ path: string; description: string }> {
  const flattened: Array<{ path: string; description: string }> = [];

  for (const command of commands) {
    const commandPath = prefix ? `${prefix} ${command.name}` : command.name;
    flattened.push({
      path: commandPath,
      description: command.description ?? '',
    });

    if (command.subCommands) {
      flattened.push(
        ...flattenCommandDescriptions(command.subCommands, commandPath),
      );
    }
  }

  return flattened;
}

describe('must-translate locale coverage', () => {
  afterEach(async () => {
    await setLanguageAsync('en');
  });

  it('includes every required key in the English baseline locale', async () => {
    const enTranslations = await loadEnglishBaselineTranslations();
    const missingKeys = MUST_TRANSLATE_KEYS.filter(
      (key) => !(key in enTranslations),
    );

    expect(missingKeys).toEqual([]);
  });

  it.each(NON_ENGLISH_LANGUAGES)(
    'does not fall back to English for required keys in %s',
    async (language) => {
      await setLanguageAsync(language.code);

      const untranslated = MUST_TRANSLATE_KEYS.filter((key) => t(key) === key);

      expect(untranslated).toEqual([]);
    },
  );

  it.each(NON_ENGLISH_LANGUAGES)(
    'translates built-in command descriptions in %s',
    async (language) => {
      await setLanguageAsync(language.code);

      const extensionSubcommands = new Map(
        (extensionsCommand.subCommands ?? []).map((command) => [
          command.name,
          command.description,
        ]),
      );

      expect(languageCommand.description).not.toBe(
        'View or change the language setting',
      );
      expect(mcpCommand.description).not.toBe('Open MCP management dialog');
      expect(planCommand.description).not.toBe(
        'Switch to plan mode or exit plan mode',
      );
      expect(approvalModeCommand.description).not.toBe(
        'View or change the approval mode for tool usage',
      );
      expect(arenaCommand.description).not.toBe('Manage Arena sessions');
      expect(btwCommand.description).not.toBe(
        'Ask a quick side question without affecting the main conversation',
      );
      expect(extensionsCommand.description).not.toBe('Manage extensions');
      expect(extensionSubcommands.get('manage')).not.toBe(
        'Manage installed extensions',
      );
      expect(extensionSubcommands.get('install')).not.toBe(
        'Install an extension from a git repo or local path',
      );
      expect(extensionSubcommands.get('explore')).not.toBe(
        'Open extensions page in your browser',
      );
      expect(memoryCommand.description).not.toBe('Open the memory manager.');
      expect(rememberCommand.description).not.toBe(
        'Save a durable memory to the memory system.',
      );
      expect(statuslineCommand.description).not.toBe(
        "Set up Qwen Code's status line UI",
      );
    },
  );

  it.each(STRICT_PARITY_NON_ENGLISH_LANGUAGES)(
    'does not fall back to English for any built-in command description in strict-parity locale %s',
    async (language) => {
      const loader = new BuiltinCommandLoader(null);

      await setLanguageAsync('en');
      const englishDescriptions = new Map(
        flattenCommandDescriptions(
          await loader.loadCommands(new AbortController().signal),
        ).map(({ path, description }) => [path, description]),
      );

      await setLanguageAsync(language.code);
      const fallbackDescriptions = flattenCommandDescriptions(
        await loader.loadCommands(new AbortController().signal),
      )
        .filter(
          ({ path, description }) =>
            englishDescriptions.get(path) === description,
        )
        .map(({ path }) => path);

      expect(fallbackDescriptions).toEqual([]);
    },
  );
});
