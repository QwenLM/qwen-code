/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Client  } from '@modelcontextprotocol/client';
import { ListResourcesResultSchema } from '@modelcontextprotocol/core';
import { type Resource } from '@modelcontextprotocol/client';
import { getMcpErrorMessage } from '../errors.js';
import type { McpClientContext } from '../mcpClientContext.js';
import { resolveMcpRequestTimeoutMs } from './mcp-timeouts.js';
import { McpCursorPager } from './mcp-pagination.js';

export async function discoverResources(
  mcpServerName: string,
  mcpClient: Client,
  cliConfig: McpClientContext,
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<Resource[]> {
  if (mcpClient.getServerCapabilities()?.resources == null) {
    return [];
  }

  const resources = await listResources(
    mcpServerName,
    mcpClient,
    cliConfig,
    options,
  );
  return resources;
}

async function listResources(
  mcpServerName: string,
  mcpClient: Client,
  cliConfig: McpClientContext,
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<Resource[]> {
  const resources: Resource[] = [];
  const pager = new McpCursorPager();
  let cursor: string | undefined;
  try {
    do {
      const response = await mcpClient.request(
        {
          method: 'resources/list',
          params: cursor ? { cursor } : {},
        },
        ListResourcesResultSchema,
        { timeout: resolveMcpRequestTimeoutMs(), ...options },
      );
      resources.push(...(response.resources ?? []));
      cursor = response.nextCursor ?? undefined;
      pager.next(cursor, 'resources/list');
    } while (cursor);
  } catch (error) {
    if (error instanceof Error && error.message?.includes('Method not found')) {
      return [];
    }
    cliConfig.emitMcpDiagnostic(
      'error',
      `Error discovering resources from ${mcpServerName}: ${getMcpErrorMessage(
        error,
      )}`,
      error,
      mcpServerName,
    );
    return [];
  }
  return resources;
}
