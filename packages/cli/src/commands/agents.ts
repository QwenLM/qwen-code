/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule, Argv } from 'yargs';
import { joinCommand } from './agents/join.js';
import { sessionSendMcpCommand } from './agents/session-send-mcp.js';

export const agentsCommand: CommandModule = {
  command: 'agents',
  describe: 'Session agents: join a coordinator as a runtime',
  builder: (yargs: Argv) =>
    yargs
      .command(joinCommand)
      // Internal: the stdio MCP server a Claude / Codex turn uses to post
      // into the chat session (spawned by the daemon, not typed by people).
      .command(sessionSendMcpCommand)
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  // demandCommand(1) ensures a subcommand is always required;
  // yargs automatically shows help when none is provided.
  handler: () => {},
};
