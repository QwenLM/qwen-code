/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command, Option } from '@commander-js/extra-typings';
import {
  getErrorMessage,
  sessionLogger,
  runLogger,
} from '@qwen-code/core';

import { createCliSettingsService } from '../../config/createCliSettingsService.js';
import type { SettingSource } from '../../config/settings.js';

export async function handleList(options?: {
  json?: boolean;
  available?: boolean;
  outputFormat?: 'text' | 'json';
  pluginDirs?: string[];
  settingSources?: readonly SettingSource[];
}) {
  const { getFlagSettingsInput, restoreLoadedEnvironment } = await import(
    '../../config/settings.js'
  );
  const { listPluginsForCommand } = await import(
    '@qwen-code/core/plugin-management'
  );
  const chalk = (await import('chalk')).default;
  try {
    restoreLoadedEnvironment();
    const service = await createCliSettingsService();
    const settings = service.resolve({
      projectPath: process.cwd(),
      sources: options?.settingSources,
      flagSettings: getFlagSettingsInput(),
    });
    for (const error of settings.errors)
      runLogger.warn(`Error in ${error.path}: ${error.message}`);
    const json = options?.json ?? options?.outputFormat === 'json';

    const output = await listPluginsForCommand({
      settings,
      json,
      available: options?.available,
      pluginDirs: options?.pluginDirs,
    });
    process.stdout.write(output + '\n');
  } catch (error) {
    process.stderr.write(chalk.red(getErrorMessage(error)) + '\n');
    sessionLogger.setExitContext({
      reason: 'fatal_error',
      exit_code: 1,
      message: 'Plugin list failed',
      source: 'plugins.list',
      error_name: error instanceof Error ? error.name : undefined,
      error_stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

export function createListCommand(): Command {
  return new Command('list')
    .description('List installed plugins.')
    .option('--json', 'Output as JSON.', false)
    .option(
      '--available',
      'Include available plugins from marketplaces (requires --json).',
      false,
    )
    .addOption(
      new Option(
        '-o, --output-format <format>',
        'The format of the CLI output.',
      ).choices(['text', 'json'] as const),
    )
    .option('--plugin-dir <dirs...>', 'Additional plugin directories to scan.')
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
      const { exitCli } = await import('../../utils/exitCli.js');
      await handleList({
        json: options.json as boolean | undefined,
        available: options.available as boolean | undefined,
        outputFormat: options.outputFormat,
        pluginDirs: options.pluginDir,
        settingSources,

      });
      await exitCli();
    });
}
