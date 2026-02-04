/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { getErrorMessage } from '../../utils/errors.js';
import { ExtensionUpdateState } from '../../ui/state/extensions.js';
import {
  checkForExtensionUpdate,
  type ExtensionUpdateInfo,
} from '@qwen-code/qwen-code-core';
import { getExtensionManager } from './utils.js';
import { t } from '../../i18n/index.js';

interface UpdateArgs {
  name?: string;
  all?: boolean;
}

const updateOutput = (info: ExtensionUpdateInfo) =>
  t(
    'Extension "{{name}}" successfully updated: {{oldVersion}} → {{newVersion}}.',
    {
      name: info.name,
      oldVersion: info.originalVersion,
      newVersion: info.updatedVersion,
    },
  );

export async function handleUpdate(args: UpdateArgs) {
  const extensionManager = await getExtensionManager();
  const extensions = extensionManager.getLoadedExtensions();

  if (args.name) {
    try {
      const extension = extensions.find(
        (extension) => extension.name === args.name,
      );
      if (!extension) {
        console.log(t('Extension "{{name}}" not found.', { name: args.name }));
        return;
      }
      if (!extension.installMetadata) {
        console.log(
          t(
            'Unable to install extension "{{name}}" due to missing install metadata',
            { name: args.name },
          ),
        );
        return;
      }
      const updateState = await checkForExtensionUpdate(
        extension,
        extensionManager,
      );
      if (updateState !== ExtensionUpdateState.UPDATE_AVAILABLE) {
        console.log(
          t('Extension "{{name}}" is already up to date.', { name: args.name }),
        );
        return;
      }
      // TODO(chrstnb): we should list extensions if the requested extension is not installed.
      const updatedExtensionInfo = (await extensionManager.updateExtension(
        extension,
        updateState,
        () => {},
      ))!;
      if (
        updatedExtensionInfo.originalVersion !==
        updatedExtensionInfo.updatedVersion
      ) {
        console.log(
          t(
            'Extension "{{name}}" successfully updated: {{oldVersion}} → {{newVersion}}.',
            {
              name: args.name,
              oldVersion: updatedExtensionInfo.originalVersion,
              newVersion: updatedExtensionInfo.updatedVersion,
            },
          ),
        );
      } else {
        console.log(
          t('Extension "{{name}}" is already up to date.', { name: args.name }),
        );
      }
    } catch (error) {
      console.error(getErrorMessage(error));
    }
  }
  if (args.all) {
    try {
      const extensionState = new Map();
      await extensionManager.checkForAllExtensionUpdates(
        (extensionName, state) => {
          extensionState.set(extensionName, {
            status: state,
            processed: true, // No need to process as we will force the update.
          });
        },
      );
      let updateInfos = await extensionManager.updateAllUpdatableExtensions(
        extensionState,
        () => {},
      );
      updateInfos = updateInfos.filter(
        (info) => info.originalVersion !== info.updatedVersion,
      );
      if (updateInfos.length === 0) {
        console.log(t('No extensions to update.'));
        return;
      }
      console.log(updateInfos.map((info) => updateOutput(info)).join('\n'));
    } catch (error) {
      console.error(getErrorMessage(error));
    }
  }
}

export const updateCommand: CommandModule = {
  command: 'update [<name>] [--all]',
  describe: t(
    'Updates all extensions or a named extension to the latest version.',
  ),
  builder: (yargs) =>
    yargs
      .positional('name', {
        describe: t('The name of the extension to update.'),
        type: 'string',
      })
      .option('all', {
        describe: t('Update all extensions.'),
        type: 'boolean',
      })
      .conflicts('name', 'all')
      .check((argv) => {
        if (!argv.all && !argv.name) {
          throw new Error(
            t('Either an extension name or --all must be provided'),
          );
        }
        return true;
      }),
  handler: async (argv) => {
    await handleUpdate({
      name: argv['name'] as string | undefined,
      all: argv['all'] as boolean | undefined,
    });
  },
};
