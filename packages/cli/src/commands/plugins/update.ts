/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveCommandSettings } from '../../config/createCliSettingsService.js';
import { Command, Option } from '@commander-js/extra-typings';
import {
  getErrorMessage,
  sessionLogger,
} from '@qwen-code/core';
import type { PluginCliScope } from '@qwen-code/core/plugin-management';

interface UpdateArgs {
  plugin: string;
  scope: PluginCliScope;
}

export async function handleUpdate(args: UpdateArgs) {
  const { updatePluginForCommand } = await import(
    '@qwen-code/core/plugin-management'
  );

  const chalk = (await import('chalk')).default;
  try {
    const { plugin, scope } = args;
    const settings = await resolveCommandSettings();

    process.stdout.write(`Updating plugin "${plugin}"...\n`);
    const message = await updatePluginForCommand({
      plugin,
      scope,
      settings,
    });
    process.stdout.write(chalk.green(message) + '\n');
  } catch (error) {
    process.stderr.write(chalk.red(getErrorMessage(error)) + '\n');
    sessionLogger.setExitContext({
      reason: 'fatal_error',
      exit_code: 1,
      message: getErrorMessage(error),
      source: 'plugins.update',
      error_name: error instanceof Error ? error.name : undefined,
      error_stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

export function createUpdateCommand() {
  return new Command('update')
    .description('Update a plugin to the latest version from its marketplace.')
    .argument('<plugin>', 'Plugin ID (e.g., my-plugin@marketplace).')
    .addOption(
      new Option('-s, --scope <scope>', 'Scope to update.')
        .choices(['user', 'project', 'local'] as const)
        .default('user'),
    )
    .action(async (plugin, options) => {
      const { normalizePluginScope } = await import(
        '@qwen-code/core/plugin-management'
      );
      const { exitCli } = await import('../../utils/exitCli.js');
      await handleUpdate({
        plugin,
        scope: normalizePluginScope(options.scope),
      });
      await exitCli();
    });
}
