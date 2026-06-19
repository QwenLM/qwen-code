/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { getErrorMessage } from '../../utils/errors.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { ExtensionManager } from '@qwen-code/qwen-code-core';
import {
  requestConsentNonInteractive,
  requestConsentOrFail,
} from './consent.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
import { loadSettings } from '../../config/settings.js';
import { EXTENSION_SCOPE_CHOICES, parseExtensionScope } from './utils.js';
import { t } from '../../i18n/index.js';

interface UninstallArgs {
  name: string; // can be extension name or source URL.
  scope?: string;
}

export async function handleUninstall(args: UninstallArgs) {
  try {
    const workspaceDir = process.cwd();
    const extensionManager = new ExtensionManager({
      workspaceDir,
      locale: getCurrentLanguage(),
      requestConsent: requestConsentOrFail.bind(
        null,
        requestConsentNonInteractive,
      ),
      isWorkspaceTrusted:
        isWorkspaceTrusted(loadSettings(workspaceDir).merged).isTrusted ?? true,
    });
    await extensionManager.refreshCache();
    // Only disambiguate by scope when the flag is explicitly provided;
    // otherwise the manager removes the loaded extension at its own scope.
    const scope = args.scope ? parseExtensionScope(args.scope) : undefined;
    await extensionManager.uninstallExtension(
      args.name,
      false,
      workspaceDir,
      scope,
    );
    writeStdoutLine(
      t('Extension "{{name}}" successfully uninstalled.', { name: args.name }),
    );
  } catch (error) {
    writeStderrLine(getErrorMessage(error));
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
      .option('scope', {
        describe: t(
          'Scope to uninstall from when an extension exists at both user and project scope.',
        ),
        type: 'string',
        choices: EXTENSION_SCOPE_CHOICES,
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
      scope: argv['scope'] as string | undefined,
    });
  },
};
