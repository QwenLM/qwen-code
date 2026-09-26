/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { getErrorMessage } from '../../utils/errors.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  ExtensionManager,
  resolveUsageStatisticsEnabled,
} from '@qwen-code/qwen-code-core';
import {
  requestConsentNonInteractive,
  requestConsentOrFail,
} from './consent.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
import { loadSettings } from '../../config/settings.js';
import { t, getCurrentLanguage } from '../../i18n/index.js';

interface UninstallArgs {
  name: string; // can be extension name or source URL.
}

export async function handleUninstall(args: UninstallArgs) {
  try {
    const workspaceDir = process.cwd();
    const settings = loadSettings(workspaceDir).merged;
    const extensionManager = new ExtensionManager({
      workspaceDir,
      locale: getCurrentLanguage(),
      requestConsent: requestConsentOrFail.bind(
        null,
        requestConsentNonInteractive,
      ),
      isWorkspaceTrusted: isWorkspaceTrusted(settings).isTrusted ?? true,
      usageStatisticsEnabled: resolveUsageStatisticsEnabled(
        settings.privacy?.usageStatisticsEnabled,
      ),
      proxy:
        settings.proxy ||
        process.env['HTTPS_PROXY'] ||
        process.env['https_proxy'] ||
        process.env['HTTP_PROXY'] ||
        process.env['http_proxy'],
    });
    await extensionManager.refreshCache();
    const result = await extensionManager.uninstallExtension(args.name, false);
    writeStdoutLine(
      t('Extension "{{name}}" successfully uninstalled.', { name: args.name }),
    );
    for (const warning of result.warnings ?? []) {
      writeStderrLine(`${warning.code}: ${warning.error}`);
    }
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
