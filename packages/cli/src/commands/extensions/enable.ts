/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type CommandModule } from 'yargs';
import { FatalConfigError, getErrorMessage } from '@qwen-code/qwen-code-core';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { getExtensionManager, resolveExtensionCommandScope } from './utils.js';
import { t } from '../../i18n/index.js';

interface EnableArgs {
  name: string;
  scope?: string;
}

export async function handleEnable(args: EnableArgs) {
  const extensionManager = await getExtensionManager();

  try {
    const scope = resolveExtensionCommandScope(args.scope);
    await extensionManager.enableExtension(args.name, scope);
    if (args.scope) {
      writeStdoutLine(
        t('Extension "{{name}}" successfully enabled for scope "{{scope}}".', {
          name: args.name,
          scope: args.scope,
        }),
      );
    } else {
      writeStdoutLine(
        t('Extension "{{name}}" successfully enabled in all scopes.', {
          name: args.name,
        }),
      );
    }
  } catch (error) {
    throw new FatalConfigError(getErrorMessage(error));
  }
}

export const enableCommand: CommandModule = {
  command: 'enable [--scope] <name>',
  describe: t('Enables an extension.'),
  builder: (yargs) =>
    yargs
      .positional('name', {
        describe: t('The name of the extension to enable.'),
        type: 'string',
      })
      .option('scope', {
        describe: t(
          'The scope to enable the extenison in. If not set, will be enabled in all scopes.',
        ),
        type: 'string',
      })
      .check((argv) => {
        resolveExtensionCommandScope(argv.scope as string | undefined);
        return true;
      }),
  handler: async (argv) => {
    await handleEnable({
      name: argv['name'] as string,
      scope: argv['scope'] as string,
    });
  },
};
