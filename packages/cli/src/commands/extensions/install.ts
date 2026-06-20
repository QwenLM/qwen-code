/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';

import {
  ExtensionManager,
  parseInstallSource,
  type ExtensionScope,
} from '@qwen-code/qwen-code-core';
import { getErrorMessage } from '../../utils/errors.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
import { loadSettings, SettingScope } from '../../config/settings.js';
import {
  requestConsentOrFail,
  requestConsentNonInteractive,
  requestChoicePluginNonInteractive,
} from './consent.js';
import { t, getCurrentLanguage } from '../../i18n/index.js';

interface InstallArgs {
  source: string;
  ref?: string;
  autoUpdate?: boolean;
  allowPreRelease?: boolean;
  consent?: boolean;
  registry?: string;
  scope?: string;
}

// "workspace" is accepted as an alias of "project" to match enable/disable.
function normalizeScope(scope: string | undefined): ExtensionScope {
  return scope === 'project' || scope === 'workspace' ? 'project' : 'user';
}

export async function handleInstall(args: InstallArgs) {
  try {
    const installMetadata = await parseInstallSource(args.source);

    if (
      installMetadata.type !== 'git' &&
      installMetadata.type !== 'github-release' &&
      installMetadata.type !== 'npm'
    ) {
      if (args.ref || args.autoUpdate) {
        throw new Error(
          t(
            '--ref and --auto-update are not applicable for marketplace extensions.',
          ),
        );
      }
    }

    if (installMetadata.type === 'npm' && args.ref) {
      throw new Error(
        t(
          '--ref is not applicable for npm extensions. Use @version suffix instead (e.g. @scope/package@1.2.0).',
        ),
      );
    }

    if (installMetadata.type !== 'npm' && args.registry) {
      throw new Error(t('--registry is only applicable for npm extensions.'));
    }

    if (installMetadata.type === 'npm' && args.registry) {
      installMetadata.registryUrl = args.registry;
    }

    const requestConsent = args.consent
      ? () => Promise.resolve()
      : requestConsentOrFail.bind(null, requestConsentNonInteractive);
    const workspaceDir = process.cwd();
    const extensionManager = new ExtensionManager({
      workspaceDir,
      locale: getCurrentLanguage(),
      isWorkspaceTrusted:
        isWorkspaceTrusted(loadSettings(workspaceDir).merged).isTrusted ?? true,
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
    const scope = normalizeScope(args.scope);
    if (args.scope) {
      extensionManager.setExtensionScope(extension.name, scope);
      // installExtension auto-enables at the user (global) scope. For a
      // project-scoped install, re-scope enablement to this workspace only.
      if (scope === 'project') {
        await extensionManager.disableExtension(
          extension.name,
          SettingScope.User,
        );
        try {
          await extensionManager.enableExtension(
            extension.name,
            SettingScope.Workspace,
          );
        } catch (enableError) {
          // The User-scope disable already landed. If the Workspace enable
          // fails, the extension would be left disabled everywhere — roll the
          // User enable back so it isn't silently dead, then surface the error.
          try {
            await extensionManager.enableExtension(
              extension.name,
              SettingScope.User,
            );
          } catch {
            // Best-effort rollback; report the original failure below.
          }
          throw enableError;
        }
      }
    }
    writeStdoutLine(
      scope === 'project'
        ? t(
            'Extension "{{name}}" installed successfully and enabled for the current workspace.',
            { name: extension.name },
          )
        : t('Extension "{{name}}" installed successfully and enabled.', {
            name: extension.name,
          }),
    );
  } catch (error) {
    writeStderrLine(getErrorMessage(error));
    process.exit(1);
  }
}

export const installCommand: CommandModule = {
  command: 'install <source>',
  describe: t(
    'Installs an extension from a git repository URL, local path, scoped npm package (@scope/name), or claude marketplace (marketplace-url:plugin-name).',
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
      .option('registry', {
        describe: t('Custom npm registry URL (only for npm extensions).'),
        type: 'string',
      })
      .option('consent', {
        describe: t(
          'Acknowledge the security risks of installing an extension and skip the confirmation prompt.',
        ),
        type: 'boolean',
        default: false,
      })
      .option('scope', {
        describe: t(
          'The scope to install the extension in: "user" (global, default) or "project" (current workspace only).',
        ),
        type: 'string',
        choices: ['user', 'project', 'workspace'],
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
      registry: argv['registry'] as string | undefined,
      scope: argv['scope'] as string | undefined,
    });
  },
};
