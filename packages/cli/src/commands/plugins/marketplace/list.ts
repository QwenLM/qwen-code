/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command } from '@commander-js/extra-typings';
import {
  getErrorMessage,
  sessionLogger,
  runLogger,
} from '@qwen-code/core';

import { createCliSettingsService } from '../../../config/createCliSettingsService.js';
import type { SettingSource } from '../../../config/settings.js';

async function handleMarketplaceList(args: {
  json?: boolean;
  settingSources?: readonly SettingSource[];
}) {
  const { getFlagSettingsInput, restoreLoadedEnvironment } = await import(
    '../../../config/settings.js'
  );
  const { listMarketplacesForCommand } = await import(
    '@qwen-code/core/plugin-management'
  );
  const chalk = (await import('chalk')).default;
  try {
    restoreLoadedEnvironment();
    const service = await createCliSettingsService();
    const loaded = service.resolve({
      projectPath: process.cwd(),
      sources: args.settingSources,
      flagSettings: getFlagSettingsInput(),
    });
    for (const error of loaded.errors)
      runLogger.warn(`Error in ${error.path}: ${error.message}`);
    process.stdout.write(
      listMarketplacesForCommand(loaded.merged, args.json) + '\n',
    );
  } catch (error) {
    process.stderr.write(chalk.red(getErrorMessage(error)) + '\n');
    sessionLogger.setExitContext({
      reason: 'fatal_error',
      exit_code: 1,
      message: 'Marketplace list failed',
      source: 'plugins.marketplace.list',
      error_name: error instanceof Error ? error.name : undefined,
      error_stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

export function createMarketplaceListCommand() {
  return new Command('list')
    .description('List all configured marketplaces.')
    .option('--json', 'Output as JSON.', false)
    .action(async (options, command) => {
      const { settingSources: rawSources } = command.optsWithGlobals() as {
        settingSources?: string[];
      };
      const settingSources = rawSources
        ?.flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter((value): value is SettingSource =>
          ['user', 'project', 'local'].includes(value),
        );
      const { exitCli } = await import('../../../utils/exitCli.js');
      await handleMarketplaceList({
        json: options.json as boolean | undefined,
        settingSources,
      });
      await exitCli();
    });
}
