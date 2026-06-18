/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { getErrorMessage } from '../../utils/errors.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { extensionToOutputString, getExtensionManager } from './utils.js';
import { t, initializeI18n } from '../../i18n/index.js';
import { loadSettings } from '../../config/settings.js';
import type { SupportedLanguage } from '../../i18n/index.js';

export async function handleList() {
  try {
    const settings = loadSettings();
    const langSetting =
      process.env['QWEN_CODE_LANG'] ||
      (settings.merged.general?.language as string) ||
      'auto';
    await initializeI18n(langSetting as SupportedLanguage | 'auto');
    const extensionManager = await getExtensionManager();
    const extensions = extensionManager.getLoadedExtensions();

    if (!extensions || extensions.length === 0) {
      writeStdoutLine(t('No extensions installed.'));
      return;
    }
    writeStdoutLine(
      extensions
        .map((extension, _): string =>
          extensionToOutputString(extension, extensionManager, process.cwd()),
        )
        .join('\n\n'),
    );
  } catch (error) {
    writeStderrLine(getErrorMessage(error));
    process.exit(1);
  }
}

export const listCommand: CommandModule = {
  command: 'list',
  describe: t('Lists installed extensions.'),
  builder: (yargs) => yargs,
  handler: async () => {
    await handleList();
  },
};
