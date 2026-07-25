import type { CommandModule, Argv } from 'yargs';
import { startCommand } from './channel/start.js';
import { stopCommand } from './channel/stop.js';
import { statusCommand } from './channel/status.js';
import { reloadCommand } from './channel/reload.js';
import { setCommand } from './channel/set.js';
import { daemonWorkerCommand } from './channel/daemon-worker.js';
import {
  pairingListCommand,
  pairingApproveCommand,
} from './channel/pairing.js';
import { configureWeixinCommand } from './channel/configure.js';

const pairingCommand: CommandModule = {
  command: 'pairing',
  describe: 'Manage DM pairing requests',
  builder: (yargs: Argv) =>
    yargs
      .command(pairingListCommand)
      .command(pairingApproveCommand)
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};

export const channelCommand: CommandModule = {
  command: 'channel',
  describe: 'Manage messaging channels (Telegram, Discord, etc.)',
  builder: (yargs: Argv) =>
    yargs
      .command(startCommand)
      .command(daemonWorkerCommand)
      .command(stopCommand)
      .command(statusCommand)
      .command(reloadCommand)
      .command(setCommand)
      .command(pairingCommand)
      .command(configureWeixinCommand)
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};
