/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import {
  isExtensionCommittedWithWarningsError,
  type ExtensionInstallMetadata,
} from '@qwen-code/qwen-code-core';
import { getErrorMessage } from '../../utils/errors.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  requestConsentNonInteractive,
  requestConsentOrFail,
} from './consent.js';
import { getExtensionManager } from './utils.js';
import { t } from '../../i18n/index.js';

interface InstallArgs {
  path: string;
  scope?: string;
}

export async function handleLink(args: InstallArgs) {
  try {
    const installMetadata: ExtensionInstallMetadata = {
      source: args.path,
      type: 'link',
    };
    const isWorkspaceScope =
      args.scope === 'workspace' || args.scope === 'project';
    const workspaceDir = process.cwd();
    const extensionManager = await getExtensionManager();

    const extension = await extensionManager.installExtension(
      installMetadata,
      requestConsentOrFail.bind(null, requestConsentNonInteractive),
      undefined,
      workspaceDir,
      undefined,
      isWorkspaceScope
        ? { scope: 'workspace', workspacePath: workspaceDir }
        : { scope: 'user' },
    );
    if (!extension) {
      writeStdoutLine(t('Link extension failed to install.'));
      return;
    }
    writeStdoutLine(
      isWorkspaceScope
        ? t(
            'Extension "{{name}}" linked successfully and enabled for the current workspace.',
            { name: extension.name },
          )
        : t('Extension "{{name}}" linked successfully and enabled.', {
            name: extension.name,
          }),
    );
  } catch (error) {
    if (isExtensionCommittedWithWarningsError(error)) {
      writeStderrLine(`Warning: ${getErrorMessage(error)}`);
      return;
    }
    writeStderrLine(getErrorMessage(error));
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
      .option('scope', {
        describe: t(
          'The scope to link the extension in: "user" (global, default) or "workspace" (current workspace only).',
        ),
        type: 'string',
        choices: ['user', 'project', 'workspace'],
      })
      .check((_) => true),
  handler: async (argv) => {
    await handleLink({
      path: argv['path'] as string,
      scope: argv['scope'] as string | undefined,
    });
  },
};
