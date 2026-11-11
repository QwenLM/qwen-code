/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveCommandSettings } from '../../../config/createCliSettingsService.js';
import { Command, Option } from '@commander-js/extra-typings';
import { getErrorMessage, sessionLogger } from '@qwen-code/core';
import type { PluginCliScope } from '@qwen-code/core/plugin-management';

async function startMarketplaceProgress(
  action: string,
  target?: string,
): Promise<{
  onProgress: (message: string) => void;
  stop: () => void;
}> {
  const {
    formatMarketplaceOperationStatus,
    getMarketplaceOperationTimeoutMs,
    getRemainingOperationSeconds,
  } = await import('@qwen-code/core/plugin-management');
  if (!process.stdout.isTTY) {
    return { onProgress: () => {}, stop: () => {} };
  }

  const timeoutMs = getMarketplaceOperationTimeoutMs();
  let startedAt = Date.now();
  let detail: string | undefined;
  const render = () => {
    process.stdout.write(
      `\r\x1b[K${formatMarketplaceOperationStatus(action, {
        target,
        detail,
        remainingSeconds: getRemainingOperationSeconds(startedAt, timeoutMs),
      })}`,
    );
  };

  render();
  const timer = setInterval(render, 1000);
  timer.unref?.();

  return {
    onProgress: (message: string) => {
      startedAt = Date.now();
      detail = message;
      render();
    },
    stop: () => {
      clearInterval(timer);
      process.stdout.write('\r\x1b[K');
    },
  };
}

async function handleMarketplaceAdd(args: {
  source: string;
  sparse?: string[];
  scope: PluginCliScope;
}) {
  const { addMarketplaceForCommand } = await import(
    '@qwen-code/core/plugin-management'
  );

  const chalk = (await import('chalk')).default;
  let progress:
    | Awaited<ReturnType<typeof startMarketplaceProgress>>
    | undefined;
  try {
    const settings = await resolveCommandSettings();
    progress = await startMarketplaceProgress('Adding', args.source);
    const message = await addMarketplaceForCommand({
      settings,
      sourceInput: args.source,
      scope: args.scope,
      sparsePaths: args.sparse,
      onProgress: progress.onProgress,
    });
    progress.stop();
    progress = undefined;
    process.stdout.write(chalk.green(message) + '\n');
  } catch (error) {
    progress?.stop();
    process.stderr.write(chalk.red(getErrorMessage(error)) + '\n');
    sessionLogger.setExitContext({
      reason: 'fatal_error',
      exit_code: 1,
      message: 'Marketplace add failed',
      source: 'plugins.marketplace.add',
      error_name: error instanceof Error ? error.name : undefined,
      error_stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

export function createMarketplaceAddCommand() {
  return new Command('add')
    .description('Add a marketplace from a URL, path, or GitHub repo.')
    .argument('<source>', 'Marketplace source: owner/repo, URL, git URL, or path.')
    .option(
      '--sparse <paths...>',
      'Limit checkout to specific directories via git sparse-checkout.',
    )
    .addOption(
      new Option(
        '--scope <scope>',
        'Where to declare the marketplace: user (default), project, or local.',
      )
        .choices(['user', 'project', 'local'] as const)
        .default('user'),
    )
    .action(async (source, options) => {
      const { normalizePluginScope } = await import(
        '@qwen-code/core/plugin-management'
      );
      const { exitCli } = await import('../../../utils/exitCli.js');
      await handleMarketplaceAdd({
        source,
        sparse: options.sparse,
        scope: normalizePluginScope(options.scope),
      });
      await exitCli();
    });
}
