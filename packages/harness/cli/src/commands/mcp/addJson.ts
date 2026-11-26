/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'qwen mcp add-json' command
import type { McpCommandOptions } from './options.js';
import { Command, Option } from '@commander-js/extra-typings';
import {
  type MCPServerConfig,
  sessionLogger,
} from '@qwen-code/core';
import { saveNewMcpServer } from './save.js';

export async function parseAddJsonConfig(json: string): Promise<MCPServerConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    process.stderr.write(
      `Error: Invalid JSON string. Please provide a valid JSON configuration.\n`,
    );
    sessionLogger.setExitContext({
      reason: 'input_error',
      exit_code: 1,
      message: 'Invalid JSON string for MCP server config',
      source: 'mcp.addJson',
    });
    process.exit(1);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.stderr.write(
      `Error: JSON configuration must be an object, not ${Array.isArray(parsed) ? 'an array' : String(parsed)}.\n`,
    );
    sessionLogger.setExitContext({
      reason: 'input_error',
      exit_code: 1,
      message: 'JSON configuration must be an object',
      source: 'mcp.addJson',
    });
    process.exit(1);
  }

  return { ...parsed } as MCPServerConfig;
}

export async function applyAddJsonClientSecret(
  serverConfig: MCPServerConfig,
  clientSecretFlag: boolean | undefined,
): Promise<void> {
  // If --client-secret was requested and the config is an HTTP/SSE server
  // with oauth.clientId configured, interactively read the secret BEFORE
  // writing so cancellation does not leave partial state on disk.
  const type = (serverConfig as { type?: string }).type;
  const oauth = (serverConfig as { oauth?: { clientId?: string } }).oauth;
  const needsSecret =
    clientSecretFlag === true &&
    (type === 'sse' || type === 'http') &&
    typeof oauth?.clientId === 'string' &&
    oauth.clientId.length > 0;

  if (!needsSecret) return;

  const { readClientSecret } = await import('../../utils/clientSecret.js');
  try {
    const secret = await readClientSecret();
    (serverConfig as unknown as { oauth: { clientSecret?: string } }).oauth = {
      ...(oauth ?? {}),
      clientSecret: secret,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    sessionLogger.setExitContext({
      reason: 'fatal_error',
      exit_code: 1,
      message: `Client secret error: ${message}`,
      source: 'mcp.addJson',
    });
    process.exit(1);
  }
}

export function createMcpAddJsonCommandBase() {
  return new Command('add-json')
    .description('Add a server from a JSON config string')
    .argument('<name>', 'Name of the server')
    .argument('<json>', 'JSON configuration string')
    .addOption(
      new Option(
        '-s, --scope <scope>',
        'Configuration scope (user, local, or project)',
      )
        .choices(['user', 'local', 'project'] as const)
        .default('local'),
    )
    .option(
      '--client-secret',
      'Prompt for OAuth client secret (or set MCP_CLIENT_SECRET env var)',
    );
}

export function createAddJsonCommand(commandOptions: McpCommandOptions = {}) {
  return createMcpAddJsonCommandBase().action(async (name, json, options) => {
    const { exitCli } = await import('../../utils/exitCli.js');
    const serverConfig = await parseAddJsonConfig(json);
    await applyAddJsonClientSecret(
      serverConfig,
      options.clientSecret as boolean | undefined,
    );
    await saveNewMcpServer(name, serverConfig, options.scope, {
      source: 'mcp.addJson',
      projectConfigValidator: commandOptions.projectConfigValidator,
    });
    await exitCli();
  });
}
