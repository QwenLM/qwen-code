/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { setLanguageAsync, t } from './index.js';
import { SUPPORTED_LANGUAGES } from './languages.js';
import { MUST_TRANSLATE_KEYS } from './mustTranslateKeys.js';
import { approvalModeCommand } from '../ui/commands/approvalModeCommand.js';
import { arenaCommand } from '../ui/commands/arenaCommand.js';
import { btwCommand } from '../ui/commands/btwCommand.js';
import { extensionsCommand } from '../ui/commands/extensionsCommand.js';
import { languageCommand } from '../ui/commands/languageCommand.js';
import { mcpCommand } from '../ui/commands/mcpCommand.js';
import { planCommand } from '../ui/commands/planCommand.js';
import { statuslineCommand } from '../ui/commands/statuslineCommand.js';

const NON_ENGLISH_LANGUAGES = SUPPORTED_LANGUAGES.filter(
  (language) => language.code !== 'en',
);

describe('must-translate locale coverage', () => {
  afterEach(async () => {
    await setLanguageAsync('en');
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
      expect(statuslineCommand.description).not.toBe(
        "Set up Qwen Code's status line UI",
      );
    },
  );
});
