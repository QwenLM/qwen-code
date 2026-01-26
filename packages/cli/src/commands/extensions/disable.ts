/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type CommandModule } from 'yargs';
import { SettingScope } from '../../config/settings.js';
import { getErrorMessage } from '../../utils/errors.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { getExtensionManager } from './utils.js';
import { t } from '../../i18n/index.js';

interface DisableArgs {
  name: string;
  scope?: string;
}

export async function handleDisable(args: DisableArgs) {
  const extensionManager = await getExtensionManager();
  try {
    if (args.scope?.toLowerCase() === 'workspace') {
      extensionManager.disableExtension(args.name, SettingScope.Workspace);
    } else {
      extensionManager.disableExtension(args.name, SettingScope.User);
    }
    writeStdoutLine(
      t('Extension "{{name}}" successfully disabled for scope "{{scope}}".', {
        name: args.name,
        scope: args.scope || SettingScope.User,
      }),
    );
  } catch (error) {
    writeStderrLine(getErrorMessage(error));
    process.exit(1);
  }
}

export const disableCommand: CommandModule = {
  command: 'disable [--scope] <name>',
  describe: t('Disables an extension.'),
  builder: (yargs) =>
    yargs
      .positional('name', {
        describe: t('The name of the extension to disable.'),
        type: 'string',
      })
      .option('scope', {
        describe: t('The scope to disable the extenison in.'),
        type: 'string',
        default: SettingScope.User,
      })
      .check((argv) => {
        if (
          argv.scope &&
          !Object.values(SettingScope)
            .map((s) => s.toLowerCase())
            .includes((argv.scope as string).toLowerCase())
        ) {
          throw new Error(
            t('Invalid scope: {{scope}}. Please use one of {{scopes}}.', {
              scope: argv.scope as string,
              scopes: Object.values(SettingScope)
                .map((s) => s.toLowerCase())
                .join(', '),
            }),
          );
        }
        return true;
      }),
  handler: async (argv) => {
    await handleDisable({
      name: argv['name'] as string,
      scope: argv['scope'] as string,
    });
  },
};
