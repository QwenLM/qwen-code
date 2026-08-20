/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv, CommandModule } from 'yargs';
import { connectExistingAgentViewSupervisor } from '../agent-view/supervisor-runner.js';
import { writeStdoutLine } from '../utils/stdioHelpers.js';

interface DaemonStopArgs {
  any?: boolean;
  'keep-workers'?: boolean;
}

const daemonStatusCommand: CommandModule = {
  command: 'status',
  describe: 'Show Agent View daemon status',
  handler: async () => {
    const supervisor = await connectExistingAgentViewSupervisor();
    if (!supervisor) {
      writeStdoutLine(
        JSON.stringify(
          {
            status: { running: false },
            sessions: { total: 0, active: 0 },
          },
          null,
          2,
        ),
      );
      return;
    }
    const [status, sessions] = await Promise.all([
      supervisor.status(),
      supervisor.list(),
    ]);
    const sessionList = Array.isArray(sessions) ? sessions : [];
    writeStdoutLine(
      JSON.stringify(
        {
          status,
          sessions: {
            total: sessionList.length,
            active: sessionList.filter(isActiveSessionSnapshot).length,
          },
        },
        null,
        2,
      ),
    );
  },
};

const daemonStopCommand: CommandModule<unknown, DaemonStopArgs> = {
  command: 'stop',
  describe: 'Stop Agent View daemons',
  builder: (yargs: Argv) =>
    yargs
      .option('any', {
        type: 'boolean',
        description: 'Allow stopping a daemon from any workspace',
      })
      .option('keep-workers', {
        type: 'boolean',
        default: false,
        description: 'Leave worker processes running when stopping the daemon',
      })
      .check((argv) =>
        argv.any === true ? true : 'qwen agents daemon stop requires --any.',
      ),
  handler: async (argv) => {
    const supervisor = await connectExistingAgentViewSupervisor();
    if (!supervisor) {
      writeStdoutLine(
        JSON.stringify({ shuttingDown: false, reason: 'not_running' }, null, 2),
      );
      return;
    }
    const result = await supervisor.shutdown(argv['keep-workers']);
    writeStdoutLine(JSON.stringify(result, null, 2));
    if (hasWorkerShutdownFailures(result)) {
      process.exitCode = 1;
    }
  },
};

export const agentDaemonCommand: CommandModule = {
  command: 'daemon',
  describe: 'Manage Agent View daemon',
  builder: (yargs: Argv) =>
    yargs
      .command(daemonStatusCommand)
      .command(daemonStopCommand)
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};

function isActiveSessionSnapshot(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const state = 'state' in value ? value.state : value;
  if (typeof state !== 'object' || state === null) return false;
  if (!('sessionState' in state) || !('processState' in state)) return false;
  return (
    state.sessionState !== 'completed' &&
    state.sessionState !== 'stopped' &&
    state.sessionState !== 'failed' &&
    state.processState !== 'exited'
  );
}

function hasWorkerShutdownFailures(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'workersFailed' in value &&
    Array.isArray(value.workersFailed) &&
    value.workersFailed.length > 0
  );
}
