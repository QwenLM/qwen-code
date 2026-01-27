/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';

import {
  ExtensionManager,
  parseInstallSource,
} from '@qwen-code/qwen-code-core';
import { getErrorMessage } from '../../utils/errors.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
import { loadSettings } from '../../config/settings.js';
import {
  requestConsentOrFail,
  requestConsentNonInteractive,
  requestChoicePluginNonInteractive,
} from './consent.js';
import { t } from '../../i18n/index.js';

interface InstallArgs {
  source: string;
  ref?: string;
  autoUpdate?: boolean;
  allowPreRelease?: boolean;
  consent?: boolean;
}

export async function handleInstall(args: InstallArgs) {
  try {
    const installMetadata = await parseInstallSource(args.source);

    if (
      installMetadata.type !== 'git' &&
      installMetadata.type !== 'github-release'
    ) {
      if (args.ref || args.autoUpdate) {
        throw new Error(
          t(
            '--ref and --auto-update are not applicable for marketplace extensions.',
          ),
        );
      }
    }

    const requestConsent = args.consent
      ? () => Promise.resolve()
      : requestConsentOrFail.bind(null, requestConsentNonInteractive);
    const workspaceDir = process.cwd();
    const extensionManager = new ExtensionManager({
      workspaceDir,
      isWorkspaceTrusted: !!isWorkspaceTrusted(
        loadSettings(workspaceDir).merged,
      ),
      requestConsent,
      requestChoicePlugin: requestChoicePluginNonInteractive,
    });
    await extensionManager.refreshCache();

    const extension = await extensionManager.installExtension(
      {
        ...installMetadata,
        ref: args.ref,
        autoUpdate: args.autoUpdate,
        allowPreRelease: args.allowPreRelease,
      },
      requestConsent,
    );
    console.log(
      t('Extension "{{name}}" installed successfully and enabled.', {
        name: extension.name,
      }),
    );
  } catch (error) {
    console.error(getErrorMessage(error));
    process.exit(1);
  }
}

export const installCommand: CommandModule = {
  command: 'install <source>',
  describe: t(
    'Installs an extension from a git repository URL, local path, or claude marketplace (marketplace-url:plugin-name).',
  ),
  builder: (yargs) =>
    yargs
      .positional('source', {
        describe: t(
          'The github URL, local path, or marketplace source (marketplace-url:plugin-name) of the extension to install.',
        ),
        type: 'string',
        demandOption: true,
      })
      .option('ref', {
        describe: t('The git ref to install from.'),
        type: 'string',
      })
      .option('auto-update', {
        describe: t('Enable auto-update for this extension.'),
        type: 'boolean',
      })
      .option('pre-release', {
        describe: t('Enable pre-release versions for this extension.'),
        type: 'boolean',
      })
      .option('consent', {
        describe: t(
          'Acknowledge the security risks of installing an extension and skip the confirmation prompt.',
        ),
        type: 'boolean',
        default: false,
      })
      .check((argv) => {
        if (!argv.source) {
          throw new Error(t('The source argument must be provided.'));
        }
        return true;
      }),
  handler: async (argv) => {
    await handleInstall({
      source: argv['source'] as string,
      ref: argv['ref'] as string | undefined,
      autoUpdate: argv['auto-update'] as boolean | undefined,
      allowPreRelease: argv['pre-release'] as boolean | undefined,
      consent: argv['consent'] as boolean | undefined,
    });
  },
};
