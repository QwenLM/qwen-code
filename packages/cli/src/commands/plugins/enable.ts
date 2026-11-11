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

interface EnableArgs {
  plugin: string;
  scope?: PluginCliScope;
}

export async function handleEnable(args: EnableArgs) {
  const { setPluginEnabledForCommand } = await import(
    '@qwen-code/core/plugin-management'
  );

  const chalk = (await import('chalk')).default;

  try {
    const settings = await resolveCommandSettings();
    const message = await setPluginEnabledForCommand({
      plugin: args.plugin,
      enabled: true,
      settings,
      scope: args.scope,
    });
    process.stdout.write(chalk.green(message) + '\n');
  } catch (error) {
    process.stderr.write(chalk.red(getErrorMessage(error)) + '\n');
    sessionLogger.setExitContext({
      reason: 'fatal_error',
      exit_code: 1,
      message: 'Plugin enable failed',
      source: 'plugins.enable',
      error_name: error instanceof Error ? error.name : undefined,
      error_stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

export function createEnableCommand() {
  return new Command('enable')
    .description('Enable a disabled plugin.')
    .argument('<plugin>', 'Plugin name or plugin@marketplace identifier.')
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
      await handleEnable({
        plugin,
        scope: options.scope ? normalizePluginScope(options.scope) : undefined,
      });
      await exitCli();
    });
}
