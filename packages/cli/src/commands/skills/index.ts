/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command } from '@commander-js/extra-typings';
import { createListCommand } from './list.js';
import { createEnableCommand } from './enable.js';
import { createDisableCommand } from './disable.js';
import { createInstallCommand } from './install.js';
import { createLinkCommand } from './link.js';
import { createUninstallCommand } from './uninstall.js';

export function createSkillsCommand(): Command {
  const cmd = new Command('skills')
    .alias('skill')
    .description('Manage agent skills.');

  cmd.hook('preAction', async () => {
    const { initializeOutputListenersAndFlush } = await import(
      '../../utils/outputListeners.js'
    );
    initializeOutputListenersAndFlush();
  });

  cmd.addCommand(createListCommand());
  cmd.addCommand(createEnableCommand());
  cmd.addCommand(createDisableCommand());
  cmd.addCommand(createInstallCommand());
  cmd.addCommand(createLinkCommand());
  cmd.addCommand(createUninstallCommand());

  cmd.action(async () => {
    const { exitCli } = await import('../../utils/exitCli.js');
    cmd.outputHelp();
    await exitCli(0);
  });

  return cmd;
}
