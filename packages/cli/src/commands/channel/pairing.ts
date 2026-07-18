import type { CommandModule } from 'yargs';
import { PairingStore } from '@qwen-code/channel-base';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';

// Pairing state is scoped by the channel's workspace (#7017), so the CLI has
// to address the same scope the channel worker uses. Default to the current
// directory — running the command from the workspace selects its store.
const cwdOption = {
  type: 'string',
  describe:
    'Workspace directory the channel runs in (defaults to the current directory)',
  default: '.',
} as const;

export const pairingListCommand: CommandModule<
  object,
  { name: string; cwd: string }
> = {
  command: 'list <name>',
  describe: 'List pending pairing requests for a channel',
  builder: (yargs) =>
    yargs
      .positional('name', {
        type: 'string',
        describe: 'Channel name',
        demandOption: true,
      })
      .option('cwd', cwdOption),
  handler: (argv) => {
    const store = new PairingStore(argv.name, argv.cwd);
    const pending = store.listPending();

    if (pending.length === 0) {
      writeStdoutLine(
        'No pending pairing requests in this workspace (pass --cwd <dir> if the channel runs elsewhere).',
      );
      return;
    }

    writeStdoutLine(`Pending pairing requests for "${argv.name}":\n`);
    for (const req of pending) {
      const ago = Math.round((Date.now() - req.createdAt) / 60000);
      writeStdoutLine(
        `  Code: ${req.code}  Sender: ${req.senderName} (${req.senderId})  ${ago}m ago`,
      );
    }
  },
};

export const pairingApproveCommand: CommandModule<
  object,
  { name: string; code: string; cwd: string }
> = {
  command: 'approve <name> <code>',
  describe: 'Approve a pending pairing request',
  builder: (yargs) =>
    yargs
      .positional('name', {
        type: 'string',
        describe: 'Channel name',
        demandOption: true,
      })
      .positional('code', {
        type: 'string',
        describe: 'Pairing code',
        demandOption: true,
      })
      .option('cwd', cwdOption),
  handler: (argv) => {
    const store = new PairingStore(argv.name, argv.cwd);
    const request = store.approve(argv.code);

    if (!request) {
      writeStderrLine(
        `No pending request found for code "${argv.code.toUpperCase()}" in this workspace. It may have expired, or the channel may run in a different workspace (pass --cwd <dir>).`,
      );
      process.exit(1);
    }

    writeStdoutLine(
      `Approved: ${request.senderName} (${request.senderId}) can now use channel "${argv.name}".`,
    );
  },
};
