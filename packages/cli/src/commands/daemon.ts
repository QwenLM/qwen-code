/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule, Argv } from 'yargs';
import { startCommand } from './daemon/start.js';
import { stopCommand } from './daemon/stop.js';
import { statusCommand } from './daemon/status.js';
import { sessionsCommand } from './daemon/sessions.js';

export const daemonCommand: CommandModule = {
  command: 'daemon',
  describe: 'Manage the Qwen Code daemon (background mode with web UI)',
  builder: (yargs: Argv) =>
    yargs
      .command(startCommand)
      .command(stopCommand)
      .command(statusCommand)
      .command(sessionsCommand)
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {
    // yargs will automatically show help if no subcommand is provided
    // thanks to demandCommand(1) in the builder.
  },
};
