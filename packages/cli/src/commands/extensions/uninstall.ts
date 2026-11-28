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
  resolveExtensionTelemetryProxy,
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
  version?: string;
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
      isWorkspaceTrusted: isWorkspaceTrusted(settings).isTrusted === true,
      usageStatisticsEnabled: resolveUsageStatisticsEnabled(
        settings.privacy?.usageStatisticsEnabled,
      ),
      proxy: resolveExtensionTelemetryProxy(settings.proxy),
    });
    await extensionManager.refreshCache();
    let result;
    if (args.version) {
      const allLoaded =
        typeof extensionManager.getAllLoadedExtensions === 'function'
          ? extensionManager.getAllLoadedExtensions()
          : extensionManager.getLoadedExtensions();
      const lowerName = args.name.toLowerCase();
      const selector = args.version.toLowerCase();
      const matches = allLoaded.filter(
        (ext) =>
          ext.name.toLowerCase() === lowerName &&
          (ext.version.toLowerCase() === selector ||
            ext.versionSlot?.toLowerCase() === selector ||
            ext.id.toLowerCase().startsWith(selector)),
      );
      if (matches.length === 0) {
        throw new Error(
          `Extension "${args.name}" matching version "${args.version}" not found.`,
        );
      }
      if (matches.length > 1) {
        const candidates = matches
          .map(
            (ext) =>
              `${ext.versionSlot ?? ext.version} (${ext.id.slice(0, 12)}…)`,
          )
          .join(', ');
        throw new Error(
          `Multiple versions of "${args.name}" match "${args.version}": ${candidates}. Use an exact version, slot, or a longer id prefix.`,
        );
      }
      result = await extensionManager.uninstallExtensionById(
        matches[0]!.id,
        false,
      );
    } else {
      result = await extensionManager.uninstallExtension(args.name, false);
    }
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
      .version(false)
      .positional('name', {
        describe: t('The name or source path of the extension to uninstall.'),
        type: 'string',
      })
      .option('version', {
        describe: t(
          'Specific version, version slot, or id prefix to uninstall when multiple versions are installed.',
        ),
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
      version: argv['version'] as string | undefined,
    });
  },
};
