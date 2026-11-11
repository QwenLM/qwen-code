/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command } from '@commander-js/extra-typings';
import { getErrorMessage, sessionLogger } from '@qwen-code/core';

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

async function handleMarketplaceUpdate(args: { name?: string }) {
  const { updateMarketplaceForCommand } = await import(
    '@qwen-code/core/plugin-management'
  );
  const chalk = (await import('chalk')).default;
  let progress: Awaited<ReturnType<typeof startMarketplaceProgress>> | undefined;
  try {
    progress = await startMarketplaceProgress('Updating', args.name);
    const message = await updateMarketplaceForCommand(
      args.name,
      progress.onProgress,
    );
    progress.stop();
    progress = undefined;
    process.stdout.write(chalk.green(message) + '\n');
  } catch (error) {
    progress?.stop();
    process.stderr.write(chalk.red(getErrorMessage(error)) + '\n');
    sessionLogger.setExitContext({
      reason: 'fatal_error',
      exit_code: 1,
      message: 'Marketplace update failed',
      source: 'plugins.marketplace.update',
      error_name: error instanceof Error ? error.name : undefined,
      error_stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

export function createMarketplaceUpdateCommand() {
  return new Command('update')
    .description('Update marketplace(s) from their source; updates all if omitted.')
    .argument('[name]', 'Marketplace name to update.')
    .action(async (name) => {
      const { exitCli } = await import('../../../utils/exitCli.js');
      await handleMarketplaceUpdate({ name });
      await exitCli();
    });
}
