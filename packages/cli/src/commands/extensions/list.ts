/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import * as fs from 'node:fs';
import { getErrorMessage } from '../../utils/errors.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { extensionToOutputString, getExtensionManager } from './utils.js';
import { t, initializeI18n, resolveLanguageSetting } from '../../i18n/index.js';
import { loadSettings } from '../../config/settings.js';

interface ListArgs {
  all?: boolean;
}

export async function handleList(args: ListArgs = {}) {
  try {
    const settings = loadSettings();
    await initializeI18n(
      resolveLanguageSetting(settings.merged.general?.language as string),
    );
    const extensionManager = await getExtensionManager();
    const allExtensions =
      typeof extensionManager.getAllLoadedExtensions === 'function'
        ? extensionManager.getAllLoadedExtensions()
        : extensionManager.getLoadedExtensions();

    if (!allExtensions || allExtensions.length === 0) {
      writeStdoutLine(t('No extensions installed.'));
      return;
    }

    const cwd = process.cwd();
    const extensions = args.all
      ? allExtensions
      : allExtensions.filter(
          (extension) => !extension.versionSlot || extension.isActive,
        );
    const displayExtensions =
      extensions.length > 0 ? extensions : allExtensions;

    let snapshot:
      | Awaited<ReturnType<typeof extensionManager.getExtensionStoreSnapshot>>
      | undefined;
    if (
      args.all &&
      typeof extensionManager.getExtensionStoreSnapshot === 'function'
    ) {
      snapshot = await extensionManager.getExtensionStoreSnapshot();
    }

    writeStdoutLine(
      displayExtensions
        .map((extension): string => {
          let line = extensionToOutputString(extension, extensionManager, cwd);
          if (args.all && snapshot) {
            const policy = snapshot.extensions[extension.id];
            const enabledWorkspaces = Object.entries(
              policy?.workspaceOverrides ?? {},
            )
              .filter(([, state]) => state === 'enabled')
              .map(([wsPath]) =>
                fs.existsSync(wsPath) ? wsPath : `${wsPath} (missing)`,
              );
            if (enabledWorkspaces.length > 0) {
              line += `\n Workspaces: ${enabledWorkspaces.join(', ')}`;
            }
          }
          return line;
        })
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
  builder: (yargs) =>
    yargs.option('all', {
      describe: t(
        'Include versioned extensions bound only to other workspaces.',
      ),
      type: 'boolean',
      default: false,
    }),
  handler: async (argv) => {
    await handleList({
      all: argv['all'] as boolean | undefined,
    });
  },
};
