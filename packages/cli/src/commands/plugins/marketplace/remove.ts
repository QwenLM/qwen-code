/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveCommandSettings } from '../../../config/createCliSettingsService.js';
import { Command, Option } from '@commander-js/extra-typings';
import { getErrorMessage, sessionLogger } from '@qwen-code/core';
import {
  createCorePluginManager,
  type PluginCliScope,
} from '@qwen-code/core/plugin-management';
import type { PluginManagerFactory } from '@qwen-code/core';

async function handleMarketplaceRemove(args: {
  name: string;
  scope?: PluginCliScope;
  pluginManagerFactory?: PluginManagerFactory;
}) {
  const { removeMarketplaceForCommand } = await import(
    '@qwen-code/core/plugin-management'
  );

  const chalk = (await import('chalk')).default;
  try {
    const settings = await resolveCommandSettings();
    process.stdout.write(
      args.scope
        ? `Removing marketplace "${args.name}" from ${args.scope} settings...\n`
        : `Removing marketplace "${args.name}"...\n`,
    );
    const message = await removeMarketplaceForCommand({
      settings,
      name: args.name,
      scope: args.scope,
      manager: createCorePluginManager(settings, {
        factory: args.pluginManagerFactory,
      }),
    });
    process.stdout.write(chalk.green(message) + '\n');
  } catch (error) {
    process.stderr.write(chalk.red(getErrorMessage(error)) + '\n');
    sessionLogger.setExitContext({
      reason: 'fatal_error',
      exit_code: 1,
      message: 'Marketplace remove failed',
      source: 'plugins.marketplace.remove',
      error_name: error instanceof Error ? error.name : undefined,
      error_stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

export function createMarketplaceRemoveCommand(managerOptions?: {
  pluginManagerFactory?: PluginManagerFactory;
}) {
  return new Command('remove')
    .alias('rm')
    .description('Remove a configured marketplace.')
    .argument('<name>', 'Name of the marketplace to remove.')
    .addOption(
      new Option(
        '--scope <scope>',
        'Remove the marketplace declaration from a specific settings scope: user, project, or local. Omit to remove it from every scope.',
      ).choices(['user', 'project', 'local'] as const),
    )
    .action(async (name, options) => {
      const { normalizePluginScope } = await import(
        '@qwen-code/core/plugin-management'
      );
      const { exitCli } = await import('../../../utils/exitCli.js');
      await handleMarketplaceRemove({
        name,
        pluginManagerFactory: managerOptions?.pluginManagerFactory,
        scope: options.scope ? normalizePluginScope(options.scope) : undefined,
      });
      await exitCli();
    });
}
