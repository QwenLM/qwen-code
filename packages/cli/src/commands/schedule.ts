/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv, CommandModule } from 'yargs';
// Type-only + dynamic imports keep the daemon/runtime deps off the hot path:
// this module is loaded to build the parser on every `qwen` invocation, so the
// scheduler stack is imported lazily in the handler instead.
import { writeStderrLine } from '../utils/stdioHelpers.js';

/**
 * Pause forever so the foreground daemon keeps running until a signal handler
 * exits. The tick interval already pins the event loop; this just prevents the
 * yargs `parse()` promise from resolving into the interactive entry point.
 */
function blockForever(): Promise<never> {
  return new Promise<never>(() => {});
}

const daemonCommand: CommandModule = {
  command: 'daemon',
  describe:
    'Run the scheduling daemon in the foreground; fires due tasks as fresh headless runs.',
  builder: (yargs: Argv) => yargs,
  handler: async () => {
    const { startScheduleDaemon } = await import('../schedule/start-daemon.js');

    let daemon;
    try {
      daemon = await startScheduleDaemon();
    } catch (err) {
      writeStderrLine(
        `qwen schedule daemon: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
      return;
    }

    writeStderrLine(
      `qwen schedule daemon: running with ${daemon.size} task(s). Press Ctrl-C to stop.`,
    );

    let stopping = false;
    const shutdown = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      writeStderrLine(`qwen schedule daemon: received ${signal}, stopping…`);
      await daemon.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    await blockForever();
  },
};

export const scheduleCommand: CommandModule = {
  command: 'schedule',
  describe:
    'Manage local scheduled tasks (routines) run by a background daemon.',
  builder: (yargs: Argv) =>
    yargs
      .command(daemonCommand)
      .demandCommand(1, 'Specify a subcommand, e.g. `qwen schedule daemon`.')
      .help(),
  handler: () => {},
};
