/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createInterface } from 'node:readline/promises';
import type { CommandModule, Argv } from 'yargs';
import { DaemonClient, DaemonSessionClient } from '@qwen-code/sdk/daemon';
import { normalizeDaemonEvent } from '@qwen-code/sdk/daemon/ui';
import {
  readDaemonDiscoveries,
  readDaemonToken,
  type DaemonDiscoveryEntry,
  type DaemonDiscoveryRecord,
} from '../serve/daemon-discovery.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';

interface AttachArgs {
  port?: number;
  session: string;
  token?: string;
}

export function selectAttachRecord(
  entries: readonly DaemonDiscoveryEntry[],
  port: number | undefined,
): { record?: DaemonDiscoveryRecord; error?: string } {
  if (port !== undefined) {
    const entry = entries.find((candidate) => candidate.record.port === port);
    return entry
      ? { record: entry.record }
      : { error: `No daemon is registered on port ${port}.` };
  }
  if (entries.length === 0) {
    return { error: 'no daemon is registered. Start one with `qwen serve`.' };
  }
  if (entries.length > 1) {
    return {
      error: `${entries.length} daemons are registered; pass --port <port> to choose one.`,
    };
  }
  return { record: entries[0]!.record };
}

export function resolveAttachToken(
  record: DaemonDiscoveryRecord,
  explicit: string | undefined,
): { token?: string; error?: string } {
  if (record.auth !== 'bearer') return {};
  const token =
    explicit?.trim() ||
    process.env['QWEN_SERVER_TOKEN']?.trim() ||
    readDaemonToken(record.port, record.pid);
  return token
    ? { token }
    : {
        error:
          'this daemon requires a bearer token; pass --token, set QWEN_SERVER_TOKEN, or start it with --save-token.',
      };
}

async function handleAttach(argv: AttachArgs): Promise<void> {
  const target = selectAttachRecord(readDaemonDiscoveries().entries, argv.port);
  if (!target.record) {
    writeStderrLine(`qwen attach: ${target.error}`);
    process.exitCode = 1;
    return;
  }
  const resolved = resolveAttachToken(target.record, argv.token);
  if (resolved.error) {
    writeStderrLine(`qwen attach: ${resolved.error}`);
    process.exitCode = 1;
    return;
  }

  const client = new DaemonClient({
    baseUrl: target.record.url,
    token: resolved.token,
  });
  let session: DaemonSessionClient;
  try {
    session = await DaemonSessionClient.load(client, argv.session);
  } catch (error) {
    writeStderrLine(
      `qwen attach: could not load session: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
    return;
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  const onSigint = () => {
    rl.close();
    process.exit(0);
  };
  process.once('SIGINT', onSigint);
  rl.on('line', (line) => {
    const text = line.trim();
    if (text.length === 0) {
      rl.prompt();
      return;
    }
    process.stdout.write(`\n> ${text}\n`);
    void session
      .prompt({ prompt: [{ type: 'text', text }] })
      .catch((error: unknown) => {
        writeStderrLine(
          `qwen attach: prompt failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  });
  rl.prompt();

  try {
    for await (const event of session.events()) {
      for (const item of normalizeDaemonEvent(event, {
        clientId: session.clientId,
        suppressOwnUserEcho: true,
      })) {
        if (
          item.type === 'assistant.text.delta' ||
          item.type === 'thought.text.delta'
        ) {
          process.stdout.write(item.text);
        } else if (item.type === 'assistant.done') {
          process.stdout.write('\n');
        } else if (item.type === 'permission.request') {
          const options = item.options
            .map((option) => option.label)
            .join(' / ');
          writeStderrLine(
            `qwen attach: approval required: ${item.title}. Approve in Web Shell.${options ? ` Options: ${options}` : ''}`,
          );
        } else if (item.type === 'error') {
          writeStderrLine(`qwen attach: ${item.text}`);
        }
      }
    }
  } catch (error) {
    writeStderrLine(
      `qwen attach: stream ended: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
    rl.close();
  }
}

export const attachCommand: CommandModule<unknown, AttachArgs> = {
  command: 'attach',
  describe: 'Attach a terminal to a running daemon session',
  builder: (yargs: Argv) =>
    yargs
      .option('port', {
        type: 'number',
        describe: 'Daemon port; required when more than one is registered',
      })
      .option('session', {
        type: 'string',
        demandOption: true,
        describe: 'Daemon session id to attach to',
      })
      .option('token', {
        type: 'string',
        describe: 'Bearer token; prefer QWEN_SERVER_TOKEN',
      }),
  handler: async (argv) => {
    await handleAttach(argv);
  },
};
