/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveCommandSettings } from '../../config/createCliSettingsService.js';
import { Command, Option } from '@commander-js/extra-typings';
import { getErrorMessage, sessionLogger } from '@qwen-code/core';
import type { PluginCliScope } from '@qwen-code/core/plugin-management';

interface InstallArgs {
  plugin: string;
  scope: PluginCliScope;
  json?: boolean;
}

export async function handleInstall(args: InstallArgs) {
  const { inferPluginErrorCode, installPluginForCommand } = await import(
    '@qwen-code/core/plugin-management'
  );

  const chalk = (await import('chalk')).default;
  const json = !!args.json;

  try {
    const { plugin, scope } = args;
    const settings = await resolveCommandSettings();
    if (!json) {
      process.stdout.write(`Installing plugin "${plugin}"...\n`);
    }
    const result = await installPluginForCommand({ plugin, scope, settings });
    if (json) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          pluginId: result.pluginId,
          version: result.version,
          path: result.installPath,
        }) + '\n',
      );
    } else {
      process.stdout.write(chalk.green(result.message) + '\n');
    }
  } catch (error) {
    if (json) {
      process.stdout.write(
        JSON.stringify({
          error: true,
          code: inferPluginErrorCode(error),
          message: getErrorMessage(error),
        }) + '\n',
      );
    } else {
      process.stderr.write(chalk.red(getErrorMessage(error)) + '\n');
    }
    sessionLogger.setExitContext({
      reason: 'fatal_error',
      exit_code: 1,
      message: 'Plugin install failed',
      source: 'plugins.install',
      error_name: error instanceof Error ? error.name : undefined,
      error_stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

export function createInstallCommand() {
  return new Command('install')
    .alias('i')
    .description(
      'Install a plugin from available marketplaces, a remote HTTPS .zip URL, or a local directory path.',
    )
    .argument(
      '<plugin>',
      'Plugin name, plugin@marketplace, remote HTTPS .zip URL, or local plugin directory path.',
    )
    .addOption(
      new Option(
        '-s, --scope <scope>',
        'Installation scope: "user" (global, default), "project" (shared, committed to VCS), or "local" (personal, not committed).',
      )
        .choices(['user', 'project', 'local'] as const)
        .default('user'),
    )
    .option('--json', 'Output as JSON.', false)
    .action(async (plugin, options) => {
      const { normalizePluginScope } = await import(
        '@qwen-code/core/plugin-management'
      );
      const { exitCli } = await import('../../utils/exitCli.js');
      await handleInstall({
        plugin,
        scope: normalizePluginScope(options.scope),
        json: options.json as boolean | undefined,
      });
      await exitCli();
    });
}
