/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CLI_IDENTIFICATION_ENV_VAR,
  CLI_IDENTIFICATION_ENV_VAR_VALUE,
} from '../../services/shellExecutionService.js';
import { sanitizeEnvironment } from '../../services/environmentSanitization.js';
import { expandMcpEnvVars } from '../mcpEnvExpansion.js';
import { runLogger } from '../../utils/runLogger.js';
import {
  applyStdioShellPrefix,
  resolveShellPrefix,
} from '../../utils/shell/shellPrefix.js';
import { getPluginEnvironment } from './transport/support.js';
import type {
  McpConnectOutcome,
  McpConnectRequest,
  McpConnector,
  McpConnectorContext,
} from './types.js';

/**
 * stdio connector: spawns the server process. Owns the trust-folder check, the
 * environment sanitization that keeps host secrets out of the child, and the
 * shell prefix.
 */
export class StdioMcpConnector implements McpConnector {
  async connect(
    request: McpConnectRequest,
    ctx: McpConnectorContext,
  ): Promise<McpConnectOutcome> {
    return {
      transport: await buildStdioTransport(request, ctx),
    };
  }
}

async function buildStdioTransport(
  request: McpConnectRequest,
  ctx: McpConnectorContext,
): Promise<Transport> {
  {
    const { serverName, config } = request;
    const cliConfig = ctx.cliConfig;
    if (!cliConfig.isTrustedFolder() && config.scope !== 'dynamic') {
      throw new Error(
        `MCP server '${serverName}' uses stdio transport but current folder is not trusted. Trust this folder to enable it.`,
      );
    }
    const pluginEnv = getPluginEnvironment(config.plugin);
    const expansionEnv = { ...process.env, ...pluginEnv };

    // Sanitize the base process environment so system-wide secrets do not leak
    // into a server the user merely configured.
    const sanitizedEnv = sanitizeEnvironment(expansionEnv, {
      ...cliConfig.sanitizationConfig,
      enableEnvironmentVariableRedaction: true,
    });

    const finalEnv: Record<string, string> = {
      [CLI_IDENTIFICATION_ENV_VAR]: CLI_IDENTIFICATION_ENV_VAR_VALUE,
      ...pluginEnv,
    };
    for (const [key, value] of Object.entries(sanitizedEnv)) {
      if (value !== undefined) {
        finalEnv[key] = value;
      }
    }

    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        finalEnv[key] = expandMcpEnvVars(value, expansionEnv);
      }
    }

    const originalArgs = config.args ?? [];
    const prefix = resolveShellPrefix();
    const launchConfig = prefix
      ? applyStdioShellPrefix(config.command!, originalArgs, prefix)
      : { command: config.command!, args: originalArgs };

    const transport = new StdioClientTransport({
      command: launchConfig.command,
      args: launchConfig.args,
      env: finalEnv,
      cwd: config.cwd,
      stderr: 'pipe',
    });

    if (ctx.debugMode) {
      attachStderrLogging(serverName, transport);
    }
    return transport;
  }
}

function attachStderrLogging(serverName: string, transport: Transport): void {
  if (transport instanceof StdioClientTransport && transport.stderr) {
    transport.stderr.on('data', (data) => {
      runLogger.debug(
        `[DEBUG] [MCP STDERR (${serverName})]: `,
        data.toString().trim(),
      );
    });
  }
}
