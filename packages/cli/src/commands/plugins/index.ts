/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command } from '@commander-js/extra-typings';
import { createListCommand } from './list.js';
import { createValidateCommand } from './validate.js';
import { createInstallCommand } from './install.js';
import { createUninstallCommand } from './uninstall.js';
import { createUpdateCommand } from './update.js';
import { createEnableCommand } from './enable.js';
import { createDisableCommand } from './disable.js';
import { createMarketplaceCommand } from './marketplace/index.js';
import type { PluginManagerFactory } from '@qwen-code/core';

export function createPluginsCommand(options?: {
  pluginManagerFactory?: PluginManagerFactory;
}): Command {
  const cmd = new Command('plugins')
    .alias('plugin')
    .description('Manage plugins');

  cmd.hook('preAction', async () => {
    const { initializeOutputListenersAndFlush } = await import(
      '../../utils/outputListeners.js'
    );
    initializeOutputListenersAndFlush();
  });

  cmd.addCommand(createListCommand());
  cmd.addCommand(createValidateCommand());
  cmd.addCommand(createInstallCommand());
  cmd.addCommand(createUninstallCommand());
  cmd.addCommand(createEnableCommand());
  cmd.addCommand(createDisableCommand());

  cmd.addCommand(createUpdateCommand());
  cmd.addCommand(createMarketplaceCommand(options));

  cmd.action(async () => {
    const { exitCli } = await import('../../utils/exitCli.js');
    cmd.outputHelp();
    await exitCli(0);
  });

  return cmd;
}
