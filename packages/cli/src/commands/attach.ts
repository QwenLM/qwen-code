/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
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
  currentPidNamespace,
  isProcessAlive,
  readDaemonDiscoveries,
  readDaemonToken,
  type DaemonDiscoveryEntry,
  type DaemonDiscoveryRecord,
} from '../serve/daemon-discovery.js';
import {
  listenerIdentityVerified,
  pidResolvableHere,
  processStartMatchesRecord,
  processStartTime,
} from './daemon.js';
import { ignoreBrokenPipe, writeStderrLine } from '../utils/stdioHelpers.js';

interface AttachArgs {
  port?: number;
  session: string;
  token?: string;
  workspace?: string;
}

export function formatAttachError(message: string): string {
  return sanitizeTerminalText(message).replace(/[\t\n]/g, '');
}

function defaultAttachRecordAlive(record: DaemonDiscoveryRecord): boolean {
  if (!pidResolvableHere(record, currentPidNamespace())) return true;
  return (
    isProcessAlive(record.pid) &&
    processStartMatchesRecord(record.startedAt, processStartTime(record.pid))
  );
}

export function selectAttachRecord(
  entries: readonly DaemonDiscoveryEntry[],
  port: number | undefined,
  alive: (record: DaemonDiscoveryRecord) => boolean = defaultAttachRecordAlive,
): { record?: DaemonDiscoveryRecord; error?: string } {
  const candidates = entries.filter((entry) => alive(entry.record));
  if (port !== undefined) {
    const entry = candidates.find(
      (candidate) => candidate.record.port === port,
    );
    return entry
      ? { record: entry.record }
      : { error: `No daemon is registered on port ${port}.` };
  }
  if (candidates.length === 0) {
    return { error: 'no daemon is registered. Start one with `qwen serve`.' };
  }
  if (candidates.length > 1) {
    return {
      error: `${candidates.length} daemons are registered; pass --port <port> to choose one.`,
    };
  }
  return { record: candidates[0]!.record };
}

export function resolveAttachToken(
  record: DaemonDiscoveryRecord,
  explicit: string | undefined,
  identityVerified: (
    record: DaemonDiscoveryRecord,
  ) => boolean = listenerIdentityVerified,
): { token?: string; error?: string } {
  if (record.auth !== 'bearer') return {};
  const explicitToken = explicit?.trim();
  if (explicitToken) return { token: explicitToken };
  if (!identityVerified(record)) {
    return {
      error:
        'listener identity unverified; not sending an ambient bearer token. Pass --token to use an explicit token.',
    };
  }
  let token: string | undefined;
  try {
    token =
      process.env['QWEN_SERVER_TOKEN']?.trim() ||
      readDaemonToken(record.port, record.pid);
  } catch (error) {
    return {
      error: `could not read the daemon token: ${formatAttachError(
        error instanceof Error ? error.message : String(error),
      )}`,
    };
  }
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
  if (requested) return resolve(requested);
  return record.workspaces.length === 1 ? record.workspaces[0] : undefined;
}

async function handleAttach(argv: AttachArgs): Promise<void> {
  ignoreBrokenPipe();
  let shuttingDown = false;
  const startupAbort = new AbortController();
  const earlyState: { session?: DaemonSessionClient } = {};
  const earlyShutdown = (): void => {
    shuttingDown = true;
    process.exitCode = 130;
    const finish = (): never => process.exit(130);
    startupAbort.abort();
    if (earlyState.session) {
      void earlyState.session
        .detach()
        .catch(() => {})
        .finally(finish);
    }
    setTimeout(finish, 500).unref();
  };
  process.once('SIGINT', earlyShutdown);
  process.once('SIGTERM', earlyShutdown);
  const { entries, invalid } = readDaemonDiscoveries();
  for (const item of invalid) {
    writeStderrLine(
      `qwen attach: ignoring ${formatAttachError(`${item.path}: ${item.reason}`)}`,
    );
  }
  const target = selectAttachRecord(entries, argv.port);
  if (!target.record) {
    writeStderrLine(`qwen attach: ${formatAttachError(target.error ?? '')}`);
    process.exitCode = 1;
    return;
  }
  const resolved = resolveAttachToken(target.record, argv.token);
  if (resolved.error) {
    writeStderrLine(`qwen attach: ${formatAttachError(resolved.error)}`);
    process.exitCode = 1;
    return;
  }
  const workspaceCwd = resolveAttachWorkspace(target.record, argv.workspace);

  const client = new DaemonClient({
    baseUrl: target.record.url,
    // Empty string suppresses the SDK's ambient QWEN_SERVER_TOKEN fallback.
    token: resolved.token ?? '',
  });
  let session: DaemonSessionClient;
  try {
    session = await DaemonSessionClient.load(client, argv.session, {
      ...(workspaceCwd ? { workspaceCwd } : {}),
      signal: startupAbort.signal,
    });
  } catch (error) {
    if (shuttingDown) return;
    const workspaceHint =
      target.record.workspaces.length > 1 && !workspaceCwd
        ? ' If the session belongs to another workspace, pass --workspace <path>.'
        : '';
    writeStderrLine(
      `qwen attach: could not load session: ${formatAttachError(
        error instanceof Error ? error.message : String(error),
      )}${workspaceHint}`,
    );
    process.exitCode = 1;
    return;
  }
  earlyState.session = session;

  if (shuttingDown) {
    await session.detach().catch(() => {});
    return;
  }

  let atLineStart = true;
  let terminalClosed = false;
  let promptInFlight = 0;
  let notifyTurnSettled: () => void = () => {};
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
    const settled =
      event.type === 'turn_complete' || event.type === 'turn_error';
    if (settled) endLine();
    for (const item of normalizeDaemonEvent(event, {
      clientId: session.clientId,
      suppressOwnUserEcho: true,
    })) {
      if (
        item.type === 'assistant.text.delta' ||
        item.type === 'thought.text.delta'
      ) {
        writeText(item.text);
      } else if (item.type === 'prompt.cancelled') {
        endLine();
      } else if (item.type === 'permission.request') {
        endLine();
        const title = sanitizeTerminalText(item.title);
        const options = item.options
          .map((option) => sanitizeTerminalText(option.label))
          .join(' / ');
        writeStderrLine(
          `qwen attach: approval required: ${title}. Approve in Web Shell.${options ? ` Options: ${options}` : ''}`,
        );
      } else if (item.type === 'error') {
        endLine();
        writeStderrLine(`qwen attach: ${sanitizeTerminalText(item.text)}`);
      } else if (item.type === 'session.state_resync_required') {
        endLine();
        const start = item.lastDeliveredId + 1;
        const end = item.earliestAvailableId - 1;
        writeStderrLine(
          `qwen attach: state resync required (${sanitizeTerminalText(
            item.reason,
          )}); missed events ${start}..${end}; reattach to reload the session.`,
        );
        process.exitCode = 1;
      } else {
        // Text-only client: structured tool, diff, and lifecycle items are ignored.
      }
    }
    if (settled) notifyTurnSettled();
  };

  const snapshot = session.consumeReplaySnapshot();
  for (const event of [...snapshot.compactedReplay, ...snapshot.liveJournal]) {
    renderEvent(event);
  }
  endLine();

  if (shuttingDown) {
    await session.detach().catch(() => {});
    return;
  }

  const subscriptionAbort = new AbortController();
  let shutdownStarted = false;
  const iterator = session.events({ signal: subscriptionAbort.signal });
  const eventsDone = (async () => {
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        renderEvent(next.value);
      }
      if (!shuttingDown) {
        endLine();
        writeStderrLine('qwen attach: stream ended');
        process.exitCode = 1;
      }
    } catch (error) {
      if (!shuttingDown) {
        endLine();
        writeStderrLine(
          `qwen attach: stream ended: ${formatAttachError(
            error instanceof Error ? error.message : String(error),
          )}`,
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
  notifyTurnSettled = (): void => {
    if (!terminalClosed && promptInFlight === 0) rl.prompt();
  };
  const shutdown = (): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    shuttingDown = true;
    terminalClosed = true;
    subscriptionAbort.abort();
    rl.close();
    void iterator.return(undefined).catch(() => {});
  };
  rl.on('SIGINT', shutdown);
  rl.on('close', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.removeListener('SIGINT', earlyShutdown);
  process.removeListener('SIGTERM', earlyShutdown);
  if (shuttingDown) shutdown();
  rl.on('line', (line) => {
    atLineStart = true;
    const text = line.trim();
    if (text.length === 0) {
      rl.prompt();
      return;
    }
    promptInFlight += 1;
    void session
      .prompt({ prompt: [{ type: 'text', text }] })
      .catch((error: unknown) => {
        if (!terminalClosed) {
          endLine();
          writeStderrLine(
            `qwen attach: prompt failed: ${formatAttachError(
              error instanceof Error ? error.message : String(error),
            )}`,
          );
        }
      })
      .finally(() => {
        promptInFlight -= 1;
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
    shutdownStarted = true;
    shuttingDown = true;
    terminalClosed = true;
    subscriptionAbort.abort();
    process.removeListener('SIGINT', earlyShutdown);
    process.removeListener('SIGTERM', earlyShutdown);
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    rl.close();
    void iterator.return(undefined).catch(() => {});
    await session.detach().catch(() => {});
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
