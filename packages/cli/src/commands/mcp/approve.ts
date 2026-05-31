/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { loadProjectMcpServers } from '../../config/projectMcpConfig.js';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { toApprovedMcpServerConfig } from './servers.js';

export async function approveMcpServer(serverName: string): Promise<void> {
  const projectServers = loadProjectMcpServers();
  const server = projectServers[serverName];

  if (!server) {
    writeStderrLine(`Pending project MCP server "${serverName}" not found.`);
    process.exitCode = 1;
    return;
  }

  const settings = loadSettings();
  const existing =
    settings.forScope(SettingScope.User).settings.mcpServers || {};
  if (settings.merged.mcpServers?.[serverName] || existing[serverName]) {
    writeStderrLine(`MCP server "${serverName}" already exists in settings.`);
    process.exitCode = 1;
    return;
  }
  settings.setValue(SettingScope.User, 'mcpServers', {
    ...existing,
    [serverName]: toApprovedMcpServerConfig(server),
  });
  writeStdoutLine(`Approved MCP server "${serverName}".`);
}

export const approveCommand: CommandModule = {
  command: 'approve <server-name>',
  describe: 'Approve a pending project MCP server',
  builder: (yargs) =>
    yargs.positional('server-name', {
      describe: 'Name of the pending project server to approve',
      type: 'string',
      demandOption: true,
    }),
  handler: async (argv) => {
    await approveMcpServer(argv['server-name'] as string);
  },
};
