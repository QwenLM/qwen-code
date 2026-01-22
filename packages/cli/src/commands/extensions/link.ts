/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { type ExtensionInstallMetadata } from '@qwen-code/qwen-code-core';
import { getErrorMessage } from '../../utils/errors.js';
import {
  requestConsentNonInteractive,
  requestConsentOrFail,
} from './consent.js';
import { getExtensionManager } from './utils.js';
import { t } from '../../i18n/index.js';

interface InstallArgs {
  path: string;
}

export async function handleLink(args: InstallArgs) {
  try {
    const installMetadata: ExtensionInstallMetadata = {
      source: args.path,
      type: 'link',
    };
    const extensionManager = await getExtensionManager();

    const extension = await extensionManager.installExtension(
      installMetadata,
      requestConsentOrFail.bind(null, requestConsentNonInteractive),
    );
    if (!extension) {
      console.log(t('Link extension failed to install.'));
      return;
    }
    console.log(
      t('Extension "{{name}}" linked successfully and enabled.', {
        name: extension.name,
      }),
    );
  } catch (error) {
    console.error(getErrorMessage(error));
    process.exit(1);
  }
}

export const linkCommand: CommandModule = {
  command: 'link <path>',
  describe: t(
    'Links an extension from a local path. Updates made to the local path will always be reflected.',
  ),
  builder: (yargs) =>
    yargs
      .positional('path', {
        describe: t('The name of the extension to link.'),
        type: 'string',
      })
      .check((_) => true),
  handler: async (argv) => {
    await handleLink({
      path: argv['path'] as string,
    });
  },
};
