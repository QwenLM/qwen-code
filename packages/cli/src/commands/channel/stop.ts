import type { CommandModule } from 'yargs';
import { isSameProcess } from '@qwen-code/qwen-code-core';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  readServiceInfo,
  signalService,
  waitForExit,
  removeServiceInfo,
} from './pidfile.js';
import {
  QWEN_DAEMON_TOKEN_ENV,
  QWEN_SERVER_TOKEN_ENV,
} from '../../serve/channel-worker-env.js';

interface StopArgs {
  'daemon-url'?: string;
  token?: string;
  timeout?: number;
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

    if (!signalService(info.pid, 'SIGTERM', info.procStart)) {
      // A refusal only proves no signal went out — `signalService` also refuses
      // when the recorded token cannot be re-read. Dropping the record of a
      // service that is still alive would leave it untracked and let the next
      // `channel start` spawn a duplicate on the same credentials.
      if (isSameProcess(info.pid, info.procStart)) {
        writeStderrLine(
          'Failed to signal the service, which is still running; its record was left in place.',
        );
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
      signalService(info.pid, 'SIGKILL', info.procStart);
      if (await waitForExit(info.pid, 2000, 200, info.procStart)) {
        removeServiceInfo(info);
        writeStdoutLine('Service killed.');
      } else {
        writeStderrLine(
          'Service is still running; its record was left in place.',
        );
        process.exit(1);
      }
    }

    process.exit(0);
  },
};
