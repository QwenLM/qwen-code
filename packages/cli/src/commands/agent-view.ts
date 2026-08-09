/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv, CommandModule } from 'yargs';
import { agentDaemonCommand } from './agent-daemon.js';
import {
  coordinationCollectCommand,
  coordinationDispatchCommand,
  coordinationReassignCommand,
} from './agent-coordinate.js';
import { agentsCommand, handleAgentsCommand } from './agents.js';
import {
  attachCommand,
  answerCommand,
  killCommand,
  logsCommand,
  peekCommand,
  respawnCommand,
  rmCommand,
  sendCommand,
  stopCommand,
} from './agent-session.js';

export const agentViewCommand: CommandModule = {
  command: 'agent-view',
  describe: 'Manage background Agent View sessions',
  builder: (yargs: Argv) =>
    yargs
      .command(agentsCommand)
      .command(agentDaemonCommand)
      .command(coordinationDispatchCommand)
      .command(coordinationCollectCommand)
      .command(coordinationReassignCommand)
      .command(attachCommand)
      .command(peekCommand)
      .command(sendCommand)
      .command(answerCommand)
      .command(logsCommand)
      .command(stopCommand)
      .command(killCommand)
      .command(respawnCommand)
      .command(rmCommand),
  handler: () => handleAgentsCommand({}),
};
