/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { getErrorMessage } from '../../utils/errors.js';
import { ExtensionManager } from '@qwen-code/qwen-code-core';
import {
  requestConsentNonInteractive,
  requestConsentOrFail,
} from './consent.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
import { loadSettings } from '../../config/settings.js';
import { t } from '../../i18n/index.js';

interface UninstallArgs {
  name: string; // can be extension name or source URL.
}

export async function handleUninstall(args: UninstallArgs) {
  try {
    const workspaceDir = process.cwd();
    const extensionManager = new ExtensionManager({
      workspaceDir,
      requestConsent: requestConsentOrFail.bind(
        null,
        requestConsentNonInteractive,
      ),
      isWorkspaceTrusted: !!isWorkspaceTrusted(
        loadSettings(workspaceDir).merged,
      ),
    });
    await extensionManager.refreshCache();
    await extensionManager.uninstallExtension(args.name, false);
    console.log(
      t('Extension "{{name}}" successfully uninstalled.', { name: args.name }),
    );
  } catch (error) {
    console.error(getErrorMessage(error));
    process.exit(1);
  }
}

export const uninstallCommand: CommandModule = {
  command: 'uninstall <name>',
  describe: t('Uninstalls an extension.'),
  builder: (yargs) =>
    yargs
      .positional('name', {
        describe: t('The name or source path of the extension to uninstall.'),
        type: 'string',
      })
      .check((argv) => {
        if (!argv.name) {
          throw new Error(
            t(
              'Please include the name of the extension to uninstall as a positional argument.',
            ),
          );
        }
        return true;
      }),
  handler: async (argv) => {
    await handleUninstall({
      name: argv['name'] as string,
    });
  },
};
