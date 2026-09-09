import type { CommandModule } from 'yargs';
import { isSameProcess } from '@qwen-code/qwen-code-core';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  readServiceInfo,
  signalService,
  waitForExit,
  removeServiceInfo,
  pidFilePath,
} from './pidfile.js';
import type { ServiceInfo, SignalServiceOutcome } from './pidfile.js';
import {
  QWEN_DAEMON_TOKEN_ENV,
  QWEN_SERVER_TOKEN_ENV,
} from '../../serve/channel-worker-env.js';

interface StopArgs {
  'daemon-url'?: string;
  token?: string;
  timeout?: number;
}

/**
 * Report a record that outlived its signal without claiming more than the
 * record proves: a tokenless record's live PID may not be the service, and a
 * permission refusal usually means another user owns the process. The pidfile
 * is named because no command sweeps a record whose process stays alive.
 */
function reportUnstoppableService(
  info: ServiceInfo,
  outcome: SignalServiceOutcome,
): void {
  const filePath = pidFilePath();
  if (outcome === 'not-permitted') {
    writeStderrLine(
      `Permission denied signalling the service (PID ${info.pid}); it may be owned by another user sharing this home. Stop it as that user — once the process is gone, the record at ${filePath} is swept on the next read.`,
    );
    return;
  }
  if (info.procStart == null) {
    writeStderrLine(
      `Could not stop PID ${info.pid}, and the record carries no process token, so this command cannot confirm it is the channel service. If no channel service is running, delete ${filePath} and start again.`,
    );
    return;
  }
  if (outcome === 'sent') {
    // Reachable only from the SIGKILL branch: the signal was delivered and
    // the token-verified process is still there.
    writeStderrLine(
      `Service is still running after SIGKILL; its record at ${filePath} was left in place.`,
    );
    return;
  }
  writeStderrLine(
    `Failed to signal the service and could not re-verify its process token; its record at ${filePath} was left in place.`,
  );
}

export const stopCommand: CommandModule<unknown, StopArgs> = {
  command: 'stop',
  describe: 'Stop the running channel service',
  builder: (yargs) =>
    yargs
      .option('daemon-url', {
        type: 'string',
        description: 'Stop channels managed by the daemon at this URL',
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
            stopChannelWorker(opts?: {
              timeoutMs?: number;
            }): Promise<{ changed: boolean }>;
          };
        };
        const client = new sdk.DaemonClient({
          baseUrl: argv['daemon-url'],
          ...(token ? { token } : {}),
        });
        const result = await client.stopChannelWorker(
          argv.timeout !== undefined ? { timeoutMs: argv.timeout } : undefined,
        );
        writeStdoutLine(
          result.changed
            ? 'Daemon-managed channels stopped.'
            : 'Daemon-managed channels are already stopped.',
        );
        process.exit(0);
      } catch (error) {
        writeStderrLine(
          `Failed to stop daemon-managed channels: ${
            error instanceof Error ? error.message : String(error)
          }`,
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
      writeStderrLine(
        `Channel service is managed by qwen serve (PID ${info.pid}). Stop qwen serve to stop channels.`,
      );
      process.exit(1);
    }

    writeStdoutLine(`Stopping channel service (PID ${info.pid})...`);

    const outcome = signalService(info.pid, 'SIGTERM', info.procStart);
    if (outcome !== 'sent') {
      // A refusal only proves no signal went out — `signalService` also refuses
      // when the recorded token cannot be re-read. Dropping the record of a
      // service that is still alive would leave it untracked and let the next
      // `channel start` spawn a duplicate on the same credentials.
      if (isSameProcess(info.pid, info.procStart)) {
        reportUnstoppableService(info, outcome);
        process.exit(1);
      }
      writeStderrLine(
        'Failed to send signal — process may have already exited.',
      );
      removeServiceInfo(info);
      process.exit(0);
    }

    const exited = await waitForExit(info.pid, 5000, 200, info.procStart);

    if (exited) {
      // Clean up in case the process didn't delete its own PID file
      removeServiceInfo(info);
      writeStdoutLine('Service stopped.');
    } else {
      writeStderrLine(
        'Service did not exit within 5 seconds. Sending SIGKILL...',
      );
      const killOutcome = signalService(info.pid, 'SIGKILL', info.procStart);
      if (await waitForExit(info.pid, 2000, 200, info.procStart)) {
        removeServiceInfo(info);
        writeStdoutLine('Service killed.');
      } else {
        reportUnstoppableService(info, killOutcome);
        process.exit(1);
      }
    }

    process.exit(0);
  },
};
