/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dynamic MCP headers helper.
 *
 * Allows users to specify an external script (headersHelper) that generates
 * authentication headers at connection time. This matters for deployments
 * MCP servers that require short-lived tokens (JWT, OIDC, STS credentials).
 *
 * The script is executed with a 10 s timeout and receives server context via
 * environment variables. Its stdout must be a JSON object of string key-value
 * pairs which are merged on top of any static headers.
 */

import { execFile } from 'node:child_process';
import type { MCPServerConfig } from '../../../config/config.js';
import { runLogger } from '../../../utils/runLogger.js';
import type { McpClientContext } from '../../mcpClientContext.js';

/** Result of a child-process execution (mirrors execFileNoThrow shape). */
interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

function execFileWithShell(
  command: string,
  env: Record<string, string | undefined>,
  timeout: number,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [],
      {
        shell: true,
        timeout,
        encoding: 'utf8',
        maxBuffer: 1_000_000,
        env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code =
            error.code && typeof error.code === 'number' ? error.code : 1;
          resolve({ stdout: stdout || '', stderr: stderr || '', code });
        } else {
          resolve({ stdout: stdout || '', stderr: stderr || '', code: 0 });
        }
      },
    );
  });
}

/**
 * Execute the headersHelper script and return dynamic headers.
 *
 * @returns Parsed headers object, or `null` when not configured / on failure.
 */
export async function getMcpHeadersFromHelper(
  serverName: string,
  config: MCPServerConfig,
  cliConfig?: McpClientContext,
): Promise<Record<string, string> | null> {
  if (!config.headersHelper) {
    return null;
  }

  // Security: require workspace trust for project/local-scoped configs.
  if (cliConfig && !cliConfig.isTrustedFolder()) {
    runLogger.error(
      `Security: headersHelper for MCP server '${serverName}' skipped – workspace is not trusted.`,
    );
    return null;
  }

  try {
    runLogger.log(
      `[MCP:${serverName}] Executing headersHelper to get dynamic headers`,
    );

    const serverUrl = config.url || config.httpUrl || '';

    const result = await execFileWithShell(
      config.headersHelper,
      {
        ...process.env,
        QODEER_MCP_SERVER_NAME: serverName,
        QODEER_MCP_SERVER_URL: serverUrl,
      },
      10_000,
    );

    if (result.code !== 0 || !result.stdout) {
      throw new Error(
        `headersHelper for MCP server '${serverName}' exited with code ${result.code}` +
          (result.stderr ? `: ${result.stderr.trim()}` : ''),
      );
    }

    const parsed: unknown = JSON.parse(result.stdout.trim());

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        `headersHelper for MCP server '${serverName}' must return a JSON object with string key-value pairs`,
      );
    }

    // Validate all values are strings.
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value !== 'string') {
        throw new Error(
          `headersHelper for MCP server '${serverName}' returned non-string value for key "${key}": ${typeof value}`,
        );
      }
    }

    runLogger.log(
      `[MCP:${serverName}] Successfully retrieved ${Object.keys(parsed).length} headers from headersHelper`,
    );
    return parsed as Record<string, string>;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    runLogger.error(
      `[MCP:${serverName}] Error getting headers from headersHelper: ${msg}`,
    );
    // Return null instead of throwing to avoid blocking the connection.
    return null;
  }
}

/**
 * Get combined headers for an MCP server (static expanded + dynamic).
 * Dynamic headers override static headers when both are present.
 */
export async function getMcpServerHeaders(
  serverName: string,
  config: MCPServerConfig,
  cliConfig?: McpClientContext,
): Promise<Record<string, string>> {
  const staticHeaders: Record<string, string> = { ...(config.headers || {}) };
  const dynamicHeaders =
    (await getMcpHeadersFromHelper(serverName, config, cliConfig)) || {};

  return {
    ...staticHeaders,
    ...dynamicHeaders,
  };
}
