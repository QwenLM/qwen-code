import type { CommandModule } from 'yargs';
import {
  writeStderrLine,
  writeStdoutLine,
  writeStdoutLineBestEffort,
} from '../../utils/stdioHelpers.js';
import {
  ChannelStateStore,
  channelRuntimeStatePath,
} from './channel-state-store.js';
import {
  classifyProcessAccess,
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

/**
 * Persist an explicit stop durably across workspaces (#8975). The record
 * is scoped to the workspace it is written for (matching its config
 * scope), but the standalone service is a GLOBAL singleton: a later
 * `qwen channel start` reads the state file of whatever cwd it runs
 * from, so a workspace-scoped record alone resurrects every stopped
 * channel when the restart happens from another workspace. The legacy
 * global file closes that gap — `adoptLegacyChannelState` merges it into
 * every workspace on its next start. Returns whether EVERY write
 * persisted; callers whose message claims a durable stop must surface a
 * partial loss.
 */
function recordStoppedChannels(
  workspaceCwd: string | undefined,
  channels: readonly string[],
): boolean {
  const scoped = new ChannelStateStore(
    channelRuntimeStatePath(workspaceCwd),
  ).trySetMany(channels, 'stopped');
  // Without a workspace (an older release's pidfile) the scoped path IS
  // the legacy global file; do not double-write it.
  if (!workspaceCwd) return scoped;
  const legacy = new ChannelStateStore(channelRuntimeStatePath()).trySetMany(
    channels,
    'stopped',
  );
  if (!scoped && legacy) {
    // Partial loss (doudouOUC S3): the workspace-scoped write failed but
    // the legacy global write succeeded. Adoption re-merges the legacy
    // record into this workspace on the next start, so the stop survives
    // — but the silent heal would mask a failing scoped write path from
    // operators; leave a trace (best-effort sink, R11-13).
    writeStdoutLineBestEffort(
      'Warning: could not persist the workspace channel state; the stop was recorded in the legacy global file and will be re-adopted on the next start.',
    );
  }
  return scoped && legacy;
}

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
      let result: { changed: boolean; statePersisted?: boolean };
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
        result = await client.stopChannelWorker(
          argv.timeout !== undefined ? { timeoutMs: argv.timeout } : undefined,
        );
      } catch (error) {
        // A failed stop can ALSO lose the torn-down record: the DELETE
        // route reports that double failure via statePersisted: false on
        // the DaemonHttpError body. Duck-type it (the SDK is dynamically
        // imported above) and surface the loss like the success path does,
        // or the stopped channels resurrect on the next `--channel all`
        // with no trace (#8975). Emit the loss warning BEFORE the loud
        // stderr write (mirroring the standalone signal-failure branch):
        // statePersisted: false means the disk is failing, ops redirects
        // commonly target that same disk, and a throwing writeStderrLine
        // (ENOSPC) would skip the warning and the exit, rejecting the
        // handler with a raw fs error instead (R16-50).
        const body: unknown =
          error instanceof Error && typeof error === 'object'
            ? (error as Error & { body?: unknown }).body
            : undefined;
        if (
          body !== null &&
          typeof body === 'object' &&
          (body as Record<string, unknown>)['statePersisted'] === false
        ) {
          writeStdoutLineBestEffort(
            'Warning: could not persist the stopped record; --channel all may restart these channels.',
          );
        }
        writeStderrLine(
          `Failed to stop daemon-managed channels: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exit(1);
        return;
      }
      // The success report runs OUTSIDE the SDK try: under the very disk
      // condition that loses the state write (`statePersisted: false`), a
      // redirected-to-file stdout write throws synchronously, and sharing
      // the try converted a SUCCESSFUL stop into a reported failure —
      // stderr "Failed to stop…", exit 1 aborting `set -e`/`&&` teardown
      // chains — while the loss warning never printed (a local write
      // error has no `.body`) (#8975, R14).
      try {
        writeStdoutLine(
          result.changed
            ? 'Daemon-managed channels stopped.'
            : 'Daemon-managed channels are already stopped.',
        );
      } catch {
        // stdout is the failing target; degrade the success notice to the
        // best-effort sink so the post-stop write failure cannot flip the
        // exit code or skip the loss warning below (R11-13, R14).
        writeStdoutLineBestEffort(
          result.changed
            ? 'Daemon-managed channels stopped.'
            : 'Daemon-managed channels are already stopped.',
        );
      }
      // The route reports a successful stop whose `stopped` record did
      // not persist; surface it like the standalone path does, or the
      // stopped channels resurrect on the next `--channel all` (#8975).
      // Best-effort sink: a warning write must not terminate the process
      // when stdout is already failing (R11-13).
      if (result.statePersisted === false) {
        writeStdoutLineBestEffort(
          'Warning: could not persist the stopped record; --channel all may restart these channels.',
        );
      }
      process.exit(0);
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
        // Same cross-workspace hazard as the live stop below: a restart
        // from another workspace must see these channels as stopped.
        const recorded = recordStoppedChannels(
          pidfileSnapshot.workspaceCwd,
          pidfileSnapshot.channels,
        );
        if (recorded) {
          try {
            writeStdoutLine(
              'No channel service is running. Recorded the crashed service channels as stopped.',
            );
          } catch {
            // stdout is the failing target; degrade the success notice to
            // the best-effort sink so a post-record write failure cannot
            // flip the exit code of a SUCCESSFUL, durably recorded stop
            // (or kill the process via the async stdout 'error' event) —
            // the same wrapping the daemon success path carries (R11-13,
            // R14, R16-25).
            writeStdoutLineBestEffort(
              'No channel service is running. Recorded the crashed service channels as stopped.',
            );
          }
        } else {
          // Loss notice on the best-effort sink (R11-13).
          writeStdoutLineBestEffort(
            'No channel service is running. Could not record the crashed service channels; --channel all may restart them.',
          );
        }
      } else {
        writeStdoutLine('No channel service is running.');
      }
      process.exit(0);
      return;
    }

    const access = classifyProcessAccess(info.pid);
    if (access === 'dead') {
      // The service crashed in the window between readServiceInfo's
      // liveness check (which kept the pidfile) and this probe: the same
      // shape as the crashed-service path above — record the channels as
      // stopped, clean up the pidfile, exit success. The old boolean
      // guard misdiagnosed this ESRCH as "another user", exiting 1 with
      // the wrong message, no stop record, and the stale pidfile left
      // behind; a `set -e`/`&&` teardown then aborts and the next bare
      // `qwen channel start` resurrects the channels (#8975, R14).
      removeServiceInfo();
      // Mirror the crash path's owner gate: a serve-owned pidfile carries
      // the daemon's channels (or the literal `['all']` reservation
      // placeholder) and NO workspaceCwd, so recording them here would
      // write the daemon's state into the legacy GLOBAL standalone store
      // — every later standalone start adopts it and skips channels that
      // were never stopped in standalone mode. A stop in one mode must
      // not carry over to the other (#8975, R14).
      if (info.owner !== 'channel' || info.channels.length === 0) {
        writeStdoutLine('No channel service is running.');
      } else {
        const recorded = recordStoppedChannels(
          info.workspaceCwd,
          info.channels,
        );
        if (recorded) {
          try {
            writeStdoutLine(
              'No channel service is running. Recorded the crashed service channels as stopped.',
            );
          } catch {
            // stdout is the failing target; degrade the success notice to
            // the best-effort sink so a post-record write failure cannot
            // flip the exit code of a SUCCESSFUL, durably recorded stop
            // (or kill the process via the async stdout 'error' event) —
            // the same wrapping the daemon success path carries (R11-13,
            // R14, R16-25).
            writeStdoutLineBestEffort(
              'No channel service is running. Recorded the crashed service channels as stopped.',
            );
          }
        } else {
          // Loss notice on the best-effort sink (R11-13).
          writeStdoutLineBestEffort(
            'No channel service is running. Could not record the crashed service channels; --channel all may restart them.',
          );
        }
      }
      process.exit(0);
      return;
    }
    if (access === 'other-user') {
      // Alive but owned by another user (EPERM — a service running under
      // a different account on a shared HOME/QWEN_HOME). We cannot signal
      // it, so stop it from that user's session: recording its RUNNING
      // channels as stopped here would durably corrupt a service this
      // command never touched, and the pidfile belongs to the live
      // process, so it must not be unlinked either (#8975).
      writeStderrLine(
        `Channel service (PID ${info.pid}) is running under a different user. Stop it from that user's session.`,
      );
      process.exit(1);
    }

    if (info.owner === 'serve') {
      writeStderrLine(
        `Channel service is managed by qwen serve (PID ${info.pid}). Stop qwen serve to stop channels.`,
      );
      process.exit(1);
    }

    writeStdoutLine(`Stopping channel service (PID ${info.pid})...`);

    // An explicit stop must persist, so a later `--channel all` restart does
    // not bring these channels back (#8975). The record is written for the
    // workspace the service was started from AND the legacy global file,
    // so a restart from a DIFFERENT workspace (global singleton service,
    // commonly user-level config) honors the stop too; pidfiles from older
    // releases carry no workspace and write the legacy file only. A LIVE
    // zero-channel service records nothing and must not print the
    // durable-stop guidance: the two empty `trySetMany` calls are
    // disk-write-free no-ops returning true, so without this guard the
    // 'stay stopped' promise prints with zero recorded stops — and a user
    // who later adds channel config and runs a bare start gets everything
    // started, contradicting it. Mirror the crashed-path guard (R14).
    const hadChannels = info.channels.length > 0;
    const recorded =
      !hadChannels || recordStoppedChannels(info.workspaceCwd, info.channels);

    if (!signalService(info.pid, 'SIGTERM')) {
      // This branch exits before the recorded-conditional message below,
      // so a failed stop-record persistence must be surfaced here too —
      // the realistic shape is a service dying between the liveness check
      // and signal delivery while the state write also fails (#8975).
      if (!recorded) {
        writeStdoutLineBestEffort(
          'Warning: could not persist the stopped record; --channel all may restart these channels.',
        );
      }
      writeStderrLine(
        'Failed to send signal — process may have already exited.',
      );
      // The recorded-conditional guidance below never runs on this
      // branch (it exits first): mirror it here, or a user whose service
      // died between the liveness check and the signal gets a persisted
      // stop with no "stay stopped" explanation — a later bare
      // `qwen channel start` skips the channels and nothing in the
      // output said why (inconsistent with the clean-stop and SIGKILL
      // siblings, R15-34).
      if (hadChannels && recorded) {
        writeStdoutLine(
          'Stopped channels stay stopped until started again by name: qwen channel start <name>.',
        );
      }
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

    // Zero-channel stop: nothing was recorded, so neither the
    // durable-stop guidance nor the loss warning applies (R14).
    if (hadChannels) {
      if (recorded) {
        writeStdoutLine(
          'Stopped channels stay stopped until started again by name: qwen channel start <name>.',
        );
      } else {
        // Loss notice on the best-effort sink (R11-13).
        writeStdoutLineBestEffort(
          'Warning: could not persist the stopped record; --channel all may restart these channels.',
        );
      }
    }
    process.exit(0);
  },
};
