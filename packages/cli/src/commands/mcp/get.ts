/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { isProjectMcpServerPendingApproval } from '@qwen-code/qwen-code-core';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { getMcpServersFromConfig, stripProjectMetadata } from './servers.js';

export async function getMcpServer(serverName: string): Promise<void> {
  const mcpServers = await getMcpServersFromConfig();
  const server = mcpServers[serverName];

  if (!server) {
    writeStderrLine(`MCP server "${serverName}" not found.`);
    return;
  }

  writeStdoutLine(
    `${serverName} - ${
      isProjectMcpServerPendingApproval(server)
        ? 'Pending approval'
        : 'Configured'
    }`,
  );
  const output = isProjectMcpServerPendingApproval(server)
    ? stripProjectMetadata(server)
    : server;
  writeStdoutLine(JSON.stringify(output, null, 2));
}

export const getCommand: CommandModule = {
  command: 'get <server-name>',
  describe: 'Show an MCP server configuration',
  builder: (yargs) =>
    yargs.positional('server-name', {
      describe: 'Name of the server to show',
      type: 'string',
      demandOption: true,
    }),
  handler: async (argv) => {
    await getMcpServer(argv['server-name'] as string);
  },
};
