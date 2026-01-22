/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { getErrorMessage } from '../../utils/errors.js';
import { extensionToOutputString, getExtensionManager } from './utils.js';
import { t } from '../../i18n/index.js';

export async function handleList() {
  try {
    const extensionManager = await getExtensionManager();
    const extensions = extensionManager.getLoadedExtensions();

    if (!extensions || extensions.length === 0) {
      console.log(t('No extensions installed.'));
      return;
    }
    console.log(
      extensions
        .map((extension, _): string =>
          extensionToOutputString(extension, extensionManager, process.cwd()),
        )
        .join('\n\n'),
    );
  } catch (error) {
    console.error(getErrorMessage(error));
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
