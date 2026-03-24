import type { CommandModule, Argv } from 'yargs';
import { startCommand } from './channel/start.js';

export const channelCommand: CommandModule = {
  command: 'channel',
  describe: 'Manage messaging channels (Telegram, Discord, etc.)',
  builder: (yargs: Argv) =>
    yargs
      .command(startCommand)
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};
