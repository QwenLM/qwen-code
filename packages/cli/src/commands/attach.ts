/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createInterface } from 'node:readline/promises';
import type { CommandModule, Argv } from 'yargs';
import {
  DaemonClient,
  DaemonSessionClient,
  type DaemonEvent,
} from '@qwen-code/sdk/daemon';
import {
  normalizeDaemonEvent,
  sanitizeTerminalText,
} from '@qwen-code/sdk/daemon/ui';
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
  workspace?: string;
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

export function resolveAttachWorkspace(
  record: DaemonDiscoveryRecord,
  explicit: string | undefined,
): string | undefined {
  const requested = explicit?.trim();
  if (requested) return requested;
  return record.workspaces.length === 1 ? record.workspaces[0] : undefined;
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
  const workspaceCwd = resolveAttachWorkspace(target.record, argv.workspace);

  const client = new DaemonClient({
    baseUrl: target.record.url,
    token: resolved.token,
  });
  let session: DaemonSessionClient;
  try {
    session = await DaemonSessionClient.load(
      client,
      argv.session,
      workspaceCwd ? { workspaceCwd } : {},
    );
  } catch (error) {
    const workspaceHint =
      target.record.workspaces.length > 1 && !workspaceCwd
        ? ' If the session belongs to another workspace, pass --workspace <path>.'
        : '';
    writeStderrLine(
      `qwen attach: could not load session: ${
        error instanceof Error ? error.message : String(error)
      }${workspaceHint}`,
    );
    process.exitCode = 1;
    return;
  }

  let atLineStart = true;
  const writeText = (text: string): void => {
    const safe = sanitizeTerminalText(text);
    if (safe.length === 0) return;
    process.stdout.write(safe);
    atLineStart = safe.endsWith('\n');
  };
  const endLine = (): void => {
    if (atLineStart) return;
    process.stdout.write('\n');
    atLineStart = true;
  };
  const renderEvent = (event: DaemonEvent): void => {
    for (const item of normalizeDaemonEvent(event, {
      clientId: session.clientId,
      suppressOwnUserEcho: true,
    })) {
      if (
        item.type === 'assistant.text.delta' ||
        item.type === 'thought.text.delta'
      ) {
        writeText(item.text);
      } else if (item.type === 'assistant.done') {
        endLine();
      } else if (item.type === 'permission.request') {
        const title = sanitizeTerminalText(item.title);
        const options = item.options
          .map((option) => sanitizeTerminalText(option.label))
          .join(' / ');
        writeStderrLine(
          `qwen attach: approval required: ${title}. Approve in Web Shell.${options ? ` Options: ${options}` : ''}`,
        );
      } else if (item.type === 'error') {
        writeStderrLine(`qwen attach: ${sanitizeTerminalText(item.text)}`);
      }
    }
  };

  const snapshot = session.consumeReplaySnapshot();
  for (const event of [...snapshot.compactedReplay, ...snapshot.liveJournal]) {
    renderEvent(event);
  }
  endLine();

  const subscriptionAbort = new AbortController();
  let terminalClosed = false;
  let shuttingDown = false;
  const iterator = session.events({ signal: subscriptionAbort.signal });
  const eventsDone = (async () => {
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        renderEvent(next.value);
      }
    } catch (error) {
      if (!shuttingDown) {
        writeStderrLine(
          `qwen attach: stream ended: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exitCode = 1;
      }
    }
  })();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    terminalClosed = true;
    subscriptionAbort.abort();
    rl.close();
    void iterator.return(undefined).catch(() => {});
  };
  rl.on('SIGINT', shutdown);
  rl.on('close', shutdown);
  process.once('SIGINT', shutdown);
  rl.on('line', (line) => {
    atLineStart = true;
    const text = line.trim();
    if (text.length === 0) {
      rl.prompt();
      return;
    }
    void session
      .prompt({ prompt: [{ type: 'text', text }] })
      .catch((error: unknown) => {
        if (!terminalClosed) {
          writeStderrLine(
            `qwen attach: prompt failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      })
      .finally(() => {
        if (!terminalClosed) {
          endLine();
          rl.prompt();
        }
      });
  });
  rl.prompt();

  try {
    await eventsDone;
  } finally {
    shuttingDown = true;
    terminalClosed = true;
    subscriptionAbort.abort();
    process.removeListener('SIGINT', shutdown);
    rl.close();
    void iterator.return(undefined).catch(() => {});
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
      .option('workspace', {
        type: 'string',
        describe:
          'Workspace containing the session; required for a secondary workspace',
      })
      .option('token', {
        type: 'string',
        describe: 'Bearer token; prefer QWEN_SERVER_TOKEN',
      }),
  handler: async (argv) => {
    await handleAttach(argv);
  },
};
