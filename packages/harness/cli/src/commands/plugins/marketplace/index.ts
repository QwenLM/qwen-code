/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command } from '@commander-js/extra-typings';
import { createMarketplaceAddCommand } from './add.js';
import { createMarketplaceRemoveCommand } from './remove.js';
import { createMarketplaceListCommand } from './list.js';
import { createMarketplaceUpdateCommand } from './update.js';
import type { PluginManagerFactory } from '@qwen-code/core';

export function createMarketplaceCommand(options?: {
  pluginManagerFactory?: PluginManagerFactory;
}) {
  const cmd = new Command('marketplace')
    .alias('mp')
    .description('Manage plugin marketplaces.');

  cmd.addCommand(createMarketplaceAddCommand());
  cmd.addCommand(createMarketplaceRemoveCommand(options));
  cmd.addCommand(createMarketplaceListCommand());
  cmd.addCommand(createMarketplaceUpdateCommand());

  cmd.action(async () => {
    const { exitCli } = await import('../../../utils/exitCli.js');
    cmd.outputHelp();
    await exitCli(0);
  });

  return cmd;
}
