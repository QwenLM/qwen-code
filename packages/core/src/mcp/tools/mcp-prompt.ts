/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { GetPromptResult, Prompt } from '@modelcontextprotocol/sdk/types.js';
import { getMcpErrorMessage } from '../errors.js';
import type { McpClientContext } from '../mcpClientContext.js';
import { resolveMcpRequestTimeoutMs } from './mcp-timeouts.js';
import { runLogger } from '../../utils/runLogger.js';

export type DiscoveredMCPPrompt = Prompt & {
  serverName: string;
  /**
   * The raw, unqualified prompt name as returned by the MCP server. Stays
   * stable across catalog consumers that qualify prompt names, so internal
   * callers — invoke closures, refresh diffs, UI rendering — keep operating
   * on the original identifier.
   */
  originalName: string;
  invoke: (params: Record<string, unknown>) => Promise<GetPromptResult>;
};

/**
 * Enum representing the connection status of an MCP server
 */

export async function discoverPrompts(
  mcpServerName: string,
  mcpClient: Client,
  cliConfig: McpClientContext,
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<DiscoveredMCPPrompt[]> {
  // Only request prompts if the server supports them.
  if (mcpClient.getServerCapabilities()?.prompts == null) return [];

  try {
    const prompts: DiscoveredMCPPrompt[] = [];
    let cursor: string | undefined;
    do {
      const response = await mcpClient.listPrompts(
        cursor ? { cursor } : {},
        { timeout: resolveMcpRequestTimeoutMs(), ...options },
      );
      cursor = response.nextCursor ?? undefined;
      prompts.push(
        ...response.prompts.map((prompt) => ({
          ...prompt,
          serverName: mcpServerName,
          originalName: prompt.name,
          invoke: (params: Record<string, unknown>) =>
            invokeMcpPrompt(
              mcpServerName,
              mcpClient,
              prompt.name,
              params,
              cliConfig,
            ),
        })),
      );
    } while (cursor);
    return prompts;
  } catch (error) {
    // It's okay if the method is not found, which is a common case.
    if (error instanceof Error && error.message?.includes('Method not found')) {
      return [];
    }
    cliConfig.emitMcpDiagnostic(
      'error',
      `Error discovering prompts from ${mcpServerName}: ${getMcpErrorMessage(
        error,
      )}`,
      error,
      mcpServerName,
    );
    return [];
  }
}

export async function invokeMcpPrompt(
  mcpServerName: string,
  mcpClient: Client,
  promptName: string,
  promptParams: Record<string, unknown>,
  cliConfig: McpClientContext,
): Promise<GetPromptResult> {
  const startedAt = Date.now();
  try {
    const sanitizedParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(promptParams)) {
      if (value !== undefined && value !== null) {
        sanitizedParams[key] = String(value);
      }
    }

    const response = await mcpClient.getPrompt({
      name: promptName,
      arguments: sanitizedParams,
    });
    runLogger.log(
      `[mcp-prompt] invoke completed server=${mcpServerName} prompt=${promptName} durationMs=${Date.now() - startedAt}`,
    );
    return response;
  } catch (error) {
    runLogger.log(
      `[mcp-prompt] invoke failed server=${mcpServerName} prompt=${promptName} durationMs=${Date.now() - startedAt}`,
    );
    if (
      error instanceof Error &&
      !error.message?.includes('Method not found')
    ) {
      cliConfig.emitMcpDiagnostic(
        'error',
        `Error invoking prompt '${promptName}' from ${mcpServerName} ${promptParams}: ${getMcpErrorMessage(
          error,
        )}`,
        error,
        mcpServerName,
      );
    }
    throw error;
  }
}
