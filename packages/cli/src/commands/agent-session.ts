/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv, CommandModule } from 'yargs';
import { AgentViewSupervisorClientError } from '../agent-view/supervisor-client.js';
import { ensureAgentViewSupervisor } from '../agent-view/supervisor-runner.js';
import { requireAgentViewEnabled } from '../agent-view/feature.js';
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

// True when `respawn --all` produced results but respawned nothing, so
// `respawn --all || alert` fires instead of silently succeeding.
function isAllRespawnSkipped(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const { results } = result as { results?: unknown };
  if (!Array.isArray(results) || results.length === 0) return false;
  return results.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { skipped?: unknown }).skipped === true,
  );
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
    // demandOption keeps the positional typed as `string` (without it yargs
    // infers `string | undefined`, which breaks CommandBuilder typing) and
    // matches the `<id>` command spelling.
    builder: (yargs: Argv) =>
      yargs.positional('id', { type: 'string', demandOption: true }),
    handler: async (argv) => {
      requireAgentViewEnabled();
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
  builder: (yargs: Argv) =>
    yargs.positional('id', { type: 'string', demandOption: true }),
  handler: async (argv) => {
    requireAgentViewEnabled();
    try {
      // Supervisor errors are reported like RPC failures below.
      const supervisor = await getSessionSupervisor();
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
    requireAgentViewEnabled();
    const supervisor = await getSessionSupervisor();
    if (argv.all === true) {
      try {
        const result = await supervisor.respawn();
        writeJsonResult(result);
        if (isAllRespawnSkipped(result)) {
          process.exitCode = 1;
        }
      } catch (error) {
        // The server fulfills {all: true} as an unbounded sequential loop;
        // a timeout means the respawn is still in flight, not that it failed.
        if (
          error instanceof AgentViewSupervisorClientError &&
          error.code === 'timeout'
        ) {
          writeStderrLineSafe(
            'Respawn is still running in the supervisor. Check `qwen agents` for session status.',
          );
          return;
        }
        throw error;
      }
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
  builder: (yargs: Argv) =>
    yargs.positional('id', { type: 'string', demandOption: true }),
  handler: async (argv) => {
    requireAgentViewEnabled();
    const supervisor = await getSessionSupervisor();
    writeJsonResult(await supervisor.remove(argv['id']));
  },
};
