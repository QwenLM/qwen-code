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

interface UninstallArgs {
  plugin: string;
  scope: PluginCliScope;
  keepData?: boolean;
  json?: boolean;
}

export async function handleUninstall(args: UninstallArgs) {
  const { inferPluginErrorCode, uninstallPluginForCommand } = await import(
    '@qwen-code/core/plugin-management'
  );

  const chalk = (await import('chalk')).default;
  const json = !!args.json;

  try {
    const { plugin, scope } = args;
    const settings = await resolveCommandSettings();
    if (!json) {
      process.stdout.write(
        `Uninstalling plugin "${plugin}" from scope "${scope}"...\n`,
      );
    }
    const result = await uninstallPluginForCommand({
      plugin,
      scope,
      settings,
      keepData: args.keepData,
    });
    if (json) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          pluginId: result.pluginId,
          fullyRemoved: result.fullyRemoved,
          reverseDependents: result.reverseDependents,
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
      message: 'Plugin uninstall failed',
      source: 'plugins.uninstall',
      error_name: error instanceof Error ? error.name : undefined,
      error_stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

export function createUninstallCommand() {
  return new Command('uninstall')
    .alias('remove')
    .alias('rm')
    .description('Uninstall a plugin.')
    .argument('<plugin>', 'Plugin name to uninstall.')
    .addOption(
      new Option(
        '-s, --scope <scope>',
        'Scope to uninstall from: "user" (global, default), "project" (shared, committed to VCS), or "local" (personal, not committed).',
      )
        .choices(['user', 'project', 'local'] as const)
        .default('user'),
    )
    .option('--keep-data', 'Preserve the plugin data directory.', false)
    .option('--json', 'Output as JSON.', false)
    .action(async (plugin, options) => {
      const { normalizePluginScope } = await import(
        '@qwen-code/core/plugin-management'
      );
      const { exitCli } = await import('../../utils/exitCli.js');
      await handleUninstall({
        plugin,
        scope: normalizePluginScope(options.scope),
        keepData: options.keepData as boolean | undefined,
        json: options.json as boolean | undefined,
      });
      await exitCli();
    });
}
