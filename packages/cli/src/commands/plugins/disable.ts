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

interface DisableArgs {
  plugin?: string;
  all?: boolean;
  scope?: PluginCliScope;
}

export async function handleDisable(args: DisableArgs) {
  const { disableAllPluginsForCommand, setPluginEnabledForCommand } =
    await import('@qwen-code/core/plugin-management');

  const chalk = (await import('chalk')).default;

  try {
    if (args.all && args.plugin) {
      throw new Error('Cannot use --all with a specific plugin.');
    }
    if (!args.all && !args.plugin) {
      throw new Error('Please specify a plugin name or use --all.');
    }

    const settings = await resolveCommandSettings();
    const message = args.all
      ? await disableAllPluginsForCommand(settings)
      : await setPluginEnabledForCommand({
          plugin: args.plugin!,
          enabled: false,
          settings,
          scope: args.scope,
        });
    process.stdout.write(chalk.green(message) + '\n');
  } catch (error) {
    process.stderr.write(chalk.red(getErrorMessage(error)) + '\n');
    sessionLogger.setExitContext({
      reason: 'fatal_error',
      exit_code: 1,
      message: 'Plugin disable failed',
      source: 'plugins.disable',
      error_name: error instanceof Error ? error.name : undefined,
      error_stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

export function createDisableCommand() {
  return new Command('disable')
    .description('Disable an enabled plugin.')
    .argument('[plugin]', 'Plugin name or plugin@marketplace identifier.')
    .option('-a, --all', 'Disable all enabled plugins.', false)
    .addOption(
      new Option(
        '-s, --scope <scope>',
        'Installation scope: user, project, or local (default: auto-detect).',
      ).choices(['user', 'project', 'local'] as const),
    )
    .action(async (plugin, options) => {
      const { normalizePluginScope } = await import(
        '@qwen-code/core/plugin-management'
      );
      const { exitCli } = await import('../../utils/exitCli.js');
      await handleDisable({
        plugin,
        all: options.all as boolean | undefined,
        scope: options.scope ? normalizePluginScope(options.scope) : undefined,
      });
      await exitCli();
    });
}
