/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen sessions controllers` — mint, list and revoke the tokens that let
 * a program outside any session drive this user's sessions.
 *
 * Deliberately a CLI command rather than only a slash command: minting
 * one is something the user does while setting up the program that will
 * hold it, often before any session is running, and the plaintext token
 * has to land somewhere the user can copy it from — not in a session
 * transcript that a model reads back later.
 */

import type { Argv, CommandModule } from 'yargs';
import {
  addPeerController,
  getPeerControllerRegistryPath,
  listPeerControllers,
  PeerControllerError,
  type PeerControllerRecord,
  removePeerController,
} from '@qwen-code/qwen-code-core';
import stringWidth from 'string-width';
import {
  sanitizeTerminalText,
  truncateToWidth,
} from '../../ui/utils/textUtils.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';

/** Fixed column widths for the human-readable table (exported for tests). */
export const ID_COL = 12;
export const LABEL_COL = 24;

/**
 * Sanitize a field for terminal output.
 *
 * The label is the user's own text, but it round-trips through a JSON
 * file they can edit by hand, so it is treated like any other value read
 * from disk: no escape sequence repaints the table, no bidi override
 * makes one grant read as another.
 */
function sanitize(value: string): string {
  return sanitizeTerminalText(value).replace(/[\t\n]/g, '');
}

function padDisplay(str: string, width: number): string {
  const currentWidth = stringWidth(str);
  if (currentWidth >= width) return str;
  return str + ' '.repeat(width - currentWidth);
}

function formatCreated(createdAt: number): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime())
    ? 'unknown'
    : date.toISOString().replace('T', ' ').slice(0, 16);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface AddArgs {
  label?: string;
  json?: boolean;
}

async function handleAdd(argv: AddArgs): Promise<void> {
  let added: { record: PeerControllerRecord; token: string };
  try {
    added = await addPeerController(argv.label ?? '');
  } catch (error) {
    // A PeerControllerError is a decision this command made about the
    // user's input, so it is reported as it stands; anything else is an
    // I/O failure worth naming the file for.
    writeStderrLine(
      error instanceof PeerControllerError
        ? `Error: ${error.message}`
        : `Error: could not write ${getPeerControllerRegistryPath()}: ${describeError(error)}`,
    );
    process.exit(1);
    return;
  }

  const { record, token } = added;
  if (argv.json) {
    writeStdoutLine(
      JSON.stringify({
        id: record.id,
        label: record.label,
        token,
        createdAt: record.createdAt,
      }),
    );
    return;
  }

  writeStdoutLine(
    `Controller "${sanitize(record.label)}" added (${record.id}).`,
  );
  writeStdoutLine('');
  writeStdoutLine(
    "Token — shown once and never stored, so put it in the controller's own configuration now:",
  );
  writeStdoutLine(`  ${token}`);
  writeStdoutLine('');
  writeStdoutLine(
    'The controller presents it on the first line of every connection to a session inbox:',
  );
  writeStdoutLine(`  {"msgV":1,"type":"auth","token":"${token}"}`);
  writeStdoutLine(
    'Messages it sends are delivered without per-message review, unless agents.crossSessionInbound is "hold" or "refuse".',
  );
}

interface ListArgs {
  json?: boolean;
}

async function handleControllerList(argv: ListArgs): Promise<void> {
  let records: PeerControllerRecord[];
  try {
    records = await listPeerControllers();
  } catch (error) {
    writeStderrLine(
      `Error: could not read ${getPeerControllerRegistryPath()}: ${describeError(error)}`,
    );
    process.exit(1);
    return;
  }

  if (argv.json) {
    for (const record of records) {
      // The hash is projected away rather than passed through: it is the
      // one field here that is a credential's shadow, and no consumer of
      // this listing has a use for it.
      writeStdoutLine(
        JSON.stringify({
          id: record.id,
          label: record.label,
          createdAt: record.createdAt,
        }),
      );
    }
    return;
  }

  if (records.length === 0) {
    writeStdoutLine(
      'No trusted controllers. Add one with: qwen sessions controllers add --label <name>',
    );
    return;
  }

  writeStdoutLine(
    padDisplay('ID', ID_COL) + padDisplay('LABEL', LABEL_COL) + 'CREATED',
  );
  for (const record of records) {
    writeStdoutLine(
      padDisplay(record.id, ID_COL) +
        padDisplay(
          truncateToWidth(sanitize(record.label), LABEL_COL - 2),
          LABEL_COL,
        ) +
        formatCreated(record.createdAt),
    );
  }
}

interface RemoveArgs {
  id?: string;
}

async function handleRemove(argv: RemoveArgs): Promise<void> {
  let removed: PeerControllerRecord | null;
  try {
    removed = await removePeerController(argv.id ?? '');
  } catch (error) {
    writeStderrLine(
      error instanceof PeerControllerError
        ? `Error: ${error.message}`
        : `Error: could not write ${getPeerControllerRegistryPath()}: ${describeError(error)}`,
    );
    process.exit(1);
    return;
  }

  if (!removed) {
    writeStderrLine(
      `Error: no controller has the id "${sanitize(argv.id ?? '')}". Run "qwen sessions controllers list" to see them.`,
    );
    process.exit(1);
    return;
  }

  writeStdoutLine(
    `Removed controller "${sanitize(removed.label)}" (${removed.id}).`,
  );
  // Sessions re-read the file per connection, so this is true of running
  // sessions as well as future ones — worth saying, because the natural
  // assumption for a credential file is that it was read at startup.
  writeStdoutLine(
    'Running sessions stop accepting its token on the next connection.',
  );
}

export const controllersCommand: CommandModule = {
  command: 'controllers',
  describe: 'Manage the controller tokens that may drive your sessions',
  builder: (yargs: Argv) =>
    yargs
      .command({
        command: 'add',
        describe: 'Mint a controller token and print it once',
        builder: (add: Argv) =>
          add
            .option('label', {
              type: 'string',
              describe: 'What to call this controller, for later revocation',
              demandOption: true,
            })
            .option('json', {
              type: 'boolean',
              describe: 'Output as a single JSON object',
              default: false,
            }),
        handler: async (argv) => {
          await handleAdd(argv as AddArgs);
        },
      })
      .command({
        command: 'list',
        describe: 'List the controllers this Qwen home trusts',
        builder: (list: Argv) =>
          list.option('json', {
            type: 'boolean',
            describe: 'Output as JSON Lines',
            default: false,
          }),
        handler: async (argv) => {
          await handleControllerList(argv as ListArgs);
        },
      })
      .command({
        command: 'remove <id>',
        describe: 'Revoke a controller by id',
        builder: (remove: Argv) =>
          remove.positional('id', {
            type: 'string',
            describe: 'The id shown by "qwen sessions controllers list"',
          }),
        handler: async (argv) => {
          await handleRemove(argv as RemoveArgs);
        },
      })
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};

export { handleAdd, handleControllerList, handleRemove };
