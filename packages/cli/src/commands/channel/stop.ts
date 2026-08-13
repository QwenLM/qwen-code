import type { CommandModule } from 'yargs';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  ChannelStateStore,
  channelRuntimeStatePath,
} from './channel-state-store.js';
import {
  peekServiceInfo,
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
            }): Promise<{ changed: boolean; statePersisted?: boolean }>;
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
        // The route reports a successful stop whose `stopped` record did
        // not persist; surface it like the standalone path does, or the
        // stopped channels resurrect on the next `--channel all` (#8975).
        if (result.statePersisted === false) {
          writeStdoutLine(
            'Warning: could not persist the stopped record; --channel all may restart these channels.',
          );
        }
        process.exit(0);
      } catch (error) {
        writeStderrLine(
          `Failed to stop daemon-managed channels: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        // A failed stop can ALSO lose the torn-down record: the DELETE
        // route reports that double failure via statePersisted: false on
        // the DaemonHttpError body. Duck-type it (the SDK is dynamically
        // imported above) and surface the loss like the success path does,
        // or the stopped channels resurrect on the next `--channel all`
        // with no trace (#8975).
        const body: unknown =
          error instanceof Error && typeof error === 'object'
            ? (error as Error & { body?: unknown }).body
            : undefined;
        if (
          body !== null &&
          typeof body === 'object' &&
          (body as Record<string, unknown>)['statePersisted'] === false
        ) {
          writeStdoutLine(
            'Warning: could not persist the stopped record; --channel all may restart these channels.',
          );
        }
        process.exit(1);
      }
      return;
    }
    // Capture the pidfile contents BEFORE readServiceInfo: a crashed
    // service's stale pidfile is unlinked there, but its channels must
    // still be recorded as stopped or the next `--channel all` start
    // resurrects them (#8975).
    const pidfileSnapshot = peekServiceInfo();
    const info = readServiceInfo();

    if (!info) {
      if (
        pidfileSnapshot &&
        pidfileSnapshot.owner === 'channel' &&
        pidfileSnapshot.channels.length > 0
      ) {
        const recorded = new ChannelStateStore(
          channelRuntimeStatePath(pidfileSnapshot.workspaceCwd),
        ).trySetMany(pidfileSnapshot.channels, 'stopped');
        writeStdoutLine(
          recorded
            ? 'No channel service is running. Recorded the crashed service channels as stopped.'
            : 'No channel service is running. Could not record the crashed service channels; --channel all may restart them.',
        );
      } else {
        writeStdoutLine('No channel service is running.');
      }
      process.exit(0);
      return;
    }

    if (info.owner === 'serve') {
      writeStderrLine(
        `Channel service is managed by qwen serve (PID ${info.pid}). Stop qwen serve to stop channels.`,
      );
      process.exit(1);
    }

    writeStdoutLine(`Stopping channel service (PID ${info.pid})...`);

    // An explicit stop must persist, so a later `--channel all` restart does
    // not bring these channels back (#8975). Scope the record to the
    // workspace the service was started from, matching its config scope;
    // pidfiles from older releases fall back to the legacy global file.
    const recorded = new ChannelStateStore(
      channelRuntimeStatePath(info.workspaceCwd),
    ).trySetMany(info.channels, 'stopped');

    if (!signalService(info.pid, 'SIGTERM')) {
      // This branch exits before the recorded-conditional message below,
      // so a failed stop-record persistence must be surfaced here too —
      // the realistic shape is a service dying between the liveness check
      // and signal delivery while the state write also fails (#8975).
      if (!recorded) {
        writeStdoutLine(
          'Warning: could not persist the stopped record; --channel all may restart these channels.',
        );
      }
      writeStderrLine(
        'Failed to send signal — process may have already exited.',
      );
      removeServiceInfo();
      process.exit(0);
    }

    const exited = await waitForExit(info.pid, 5000);

    if (exited) {
      // Clean up in case the process didn't delete its own PID file
      removeServiceInfo();
      writeStdoutLine('Service stopped.');
    } else {
      writeStderrLine(
        'Service did not exit within 5 seconds. Sending SIGKILL...',
      );
      signalService(info.pid, 'SIGKILL');
      await waitForExit(info.pid, 2000);
      removeServiceInfo();
      writeStdoutLine('Service killed.');
    }

    writeStdoutLine(
      recorded
        ? 'Stopped channels stay stopped until started again by name: qwen channel start <name>.'
        : 'Warning: could not persist the stopped record; --channel all may restart these channels.',
    );
    process.exit(0);
  },
};
