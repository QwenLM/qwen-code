import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';
import type { CommandModule } from 'yargs';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import { readServiceInfo } from './pidfile.js';
import type { SessionTarget } from '@qwen-code/channel-base';
import {
  QWEN_DAEMON_TOKEN_ENV,
  QWEN_SERVER_TOKEN_ENV,
} from '../../serve/channel-worker-env.js';
import {
  formatChannelStartupFailures,
  safeChannelCommandErrorMessage,
} from './startup-failure-format.js';

interface StatusArgs {
  'daemon-url'?: string;
  token?: string;
  timeout?: number;
}

interface PersistedEntry {
  sessionId: string;
  target: SessionTarget;
  cwd: string;
}

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export const statusCommand: CommandModule<unknown, StatusArgs> = {
  command: 'status',
  describe: 'Show channel service status',
  builder: (yargs) =>
    yargs
      .option('daemon-url', {
        type: 'string',
        description: 'Read channel state from the daemon at this URL',
      })
      .option('token', { type: 'string', description: 'Daemon bearer token' })
      .option('timeout', {
        type: 'number',
        description: 'Request timeout in milliseconds',
      }),
  handler: async (argv) => {
    if (argv['daemon-url']) {
      const token =
        argv.token ??
        process.env[QWEN_SERVER_TOKEN_ENV] ??
        process.env[QWEN_DAEMON_TOKEN_ENV];
      try {
        const sdk = (await import('@qwen-code/sdk/daemon')) as unknown as {
          DaemonClient: new (opts: { baseUrl: string; token?: string }) => {
            getChannelWorkerControl(opts?: { timeoutMs?: number }): Promise<{
              enabled: boolean;
              transition: string;
              selection: { mode: string; names?: string[] } | null;
              workers: Array<{
                workspaceCwd: string;
                state: string;
                channels: string[];
                pid?: number;
                startupFailures?: unknown;
                startupFailuresTruncated?: unknown;
              }>;
            }>;
          };
        };
        const client = new sdk.DaemonClient({
          baseUrl: argv['daemon-url'],
          ...(token ? { token } : {}),
        });
        const state = await client.getChannelWorkerControl(
          argv.timeout !== undefined ? { timeoutMs: argv.timeout } : undefined,
        );
        writeStdoutLine(
          `Daemon channels: ${state.enabled ? 'enabled' : 'disabled'} (${state.transition})`,
        );
        if (state.selection) {
          writeStdoutLine(
            `Selection:       ${
              state.selection.mode === 'all'
                ? 'all'
                : (state.selection.names ?? []).join(', ')
            }`,
          );
        }
        for (const worker of state.workers) {
          writeStdoutLine(
            `${worker.workspaceCwd}: ${worker.state}; channels=${worker.channels.join(', ') || 'none'}${
              worker.pid !== undefined ? `; pid=${worker.pid}` : ''
            }`,
          );
          for (const line of formatChannelStartupFailures(
            worker,
            worker.workspaceCwd,
          )) {
            writeStdoutLine(line);
          }
        }
        process.exit(0);
      } catch (error) {
        writeStderrLine(
          `Failed to read daemon channel status: ${safeChannelCommandErrorMessage(error)}`,
        );
        process.exit(1);
      }
      return;
    }
    const info = readServiceInfo();

    if (!info) {
      writeStdoutLine('No channel service is running.');
      process.exit(0);
    }

    if (info.owner === 'serve') {
      writeStdoutLine(
        `Channel service: managed by qwen serve (PID ${info.pid})`,
      );
      if (info.workerPid !== undefined) {
        writeStdoutLine(`Worker PID:      ${info.workerPid}`);
      }
    } else {
      writeStdoutLine(`Channel service: running (PID ${info.pid})`);
    }
    writeStdoutLine(`Uptime:          ${formatUptime(info.startedAt)}`);
    writeStdoutLine('');

    // Read session data for per-channel counts
    const sessionsPath = path.join(
      Storage.getGlobalQwenDir(),
      'channels',
      'sessions.json',
    );

    const sessionCounts = new Map<string, number>();
    if (existsSync(sessionsPath)) {
      try {
        const entries: Record<string, PersistedEntry> = JSON.parse(
          readFileSync(sessionsPath, 'utf-8'),
        );
        for (const entry of Object.values(entries)) {
          const name = entry.target.channelName;
          sessionCounts.set(name, (sessionCounts.get(name) || 0) + 1);
        }
      } catch {
        // best-effort
      }
    }

    // Table header
    const nameWidth = Math.max(15, ...info.channels.map((c) => c.length + 2));
    writeStdoutLine(`${'Channel'.padEnd(nameWidth)}Sessions`);
    writeStdoutLine(`${'-'.repeat(nameWidth)}--------`);

    for (const name of info.channels) {
      const count = sessionCounts.get(name) || 0;
      writeStdoutLine(`${name.padEnd(nameWidth)}${count}`);
    }

    process.exit(0);
  },
};
