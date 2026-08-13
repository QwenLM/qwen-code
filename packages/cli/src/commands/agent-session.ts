/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv, CommandModule } from 'yargs';
import { ensureAgentViewSupervisor } from '../agent-view/supervisor-runner.js';
import { writeStderrLineSafe, writeStdoutLine } from '../utils/stdioHelpers.js';

interface SessionArgs {
  id: string;
}

interface RespawnArgs {
  id?: string;
  all?: boolean;
}

interface AgentSessionSupervisor {
  attach(id: string): Promise<unknown>;
  logs(id: string): Promise<unknown>;
  stop(id: string): Promise<unknown>;
  kill(id: string): Promise<unknown>;
  respawn(id?: string): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}

async function getSessionSupervisor(): Promise<AgentSessionSupervisor> {
  const supervisor = await ensureAgentViewSupervisor();
  return supervisor as unknown as AgentSessionSupervisor;
}

function writeJsonResult(result: unknown): void {
  writeStdoutLine(JSON.stringify(result, null, 2));
}

function sessionCommand(
  command: string,
  describe: string,
  method: keyof Omit<AgentSessionSupervisor, 'respawn'>,
  formatResult: (result: unknown) => string = (result) =>
    JSON.stringify(result, null, 2),
): CommandModule<unknown, SessionArgs> {
  return {
    command,
    describe,
    builder: (yargs: Argv) => yargs.positional('id', { type: 'string' }),
    handler: async (argv) => {
      const supervisor = await getSessionSupervisor();
      writeStdoutLine(formatResult(await supervisor[method](argv['id'])));
    },
  };
}

function getLogsOutput(result: unknown): string {
  if (
    typeof result === 'object' &&
    result !== null &&
    'output' in result &&
    typeof result.output === 'string'
  ) {
    return result.output;
  }
  return String(result ?? '');
}

export const attachCommand: CommandModule<unknown, SessionArgs> = {
  command: 'attach <id>',
  describe: 'Attach to an Agent View session',
  builder: (yargs: Argv) => yargs.positional('id', { type: 'string' }),
  handler: async (argv) => {
    const supervisor = await getSessionSupervisor();
    try {
      await supervisor.attach(argv['id']);
    } catch (error) {
      writeStderrLineSafe(
        error instanceof Error ? error.message : String(error),
      );
      process.exitCode = 1;
    }
  },
};

export const logsCommand = sessionCommand(
  'logs <id>',
  'Show Agent View session logs',
  'logs',
  getLogsOutput,
);

export const stopCommand = sessionCommand(
  'stop <id>',
  'Stop an Agent View session',
  'stop',
);

export const killCommand = sessionCommand(
  'kill <id>',
  'Kill an Agent View session',
  'kill',
);

export const respawnCommand: CommandModule<unknown, RespawnArgs> = {
  command: 'respawn [id]',
  describe: 'Respawn Agent View session(s)',
  builder: (yargs: Argv) =>
    yargs
      // Session short-ids can be all digits; keep them strings so the
      // guards below (and the RPC layer) see them consistently.
      .positional('id', { type: 'string' })
      .option('all', {
        type: 'boolean',
        default: false,
        description: 'Respawn all Agent View sessions',
      })
      .check((argv) => {
        const hasId = typeof argv['id'] === 'string' && argv['id'].length > 0;
        if (argv.all === true && hasId) {
          return 'qwen agents respawn accepts <id> or --all, not both.';
        }
        if (argv.all === true || hasId) return true;
        return 'qwen agents respawn requires <id> or --all.';
      }),
  handler: async (argv) => {
    const supervisor = await getSessionSupervisor();
    if (argv.all === true) {
      writeJsonResult(await supervisor.respawn());
      return;
    }
    if (typeof argv['id'] !== 'string' || argv['id'].length === 0) {
      throw new Error('qwen agents respawn requires <id> or --all.');
    }
    writeJsonResult(await supervisor.respawn(argv['id']));
  },
};

export const rmCommand: CommandModule<unknown, SessionArgs> = {
  command: 'rm <id>',
  describe: 'Remove an Agent View session',
  handler: async (argv) => {
    const supervisor = await getSessionSupervisor();
    writeJsonResult(await supervisor.remove(argv['id']));
  },
};
