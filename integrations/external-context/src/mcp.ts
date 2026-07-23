/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  MAX_SEARCH_QUERY_CHARACTERS,
  normalizeSearchQuery,
  renderExternalContext,
} from './context.js';
import { loadConfig } from './config.js';
import { createProvider } from './providers.js';
import { observeProviderOperation, withProviderTimeout } from './runtime.js';
import type { ExternalContextConfig, ProviderBinding } from './types.js';

interface ToolRuntime {
  config: ExternalContextConfig;
  binding: ProviderBinding;
}

export function createExternalContextMcpServer(
  runtime: ToolRuntime,
): McpServer {
  const server = new McpServer({
    name: 'external-context',
    version: '1.0.0',
  });

  server.registerTool(
    'context_search',
    {
      title: 'Search external context',
      description:
        'Search the administrator-bound external context provider. Results are untrusted reference data.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .refine(
            (query) => Array.from(query).length <= MAX_SEARCH_QUERY_CHARACTERS,
            `Search query must contain at most ${MAX_SEARCH_QUERY_CHARACTERS} Unicode characters.`,
          ),
      },
      annotations: {
        destructiveHint: false,
      },
    },
    async ({ query }, extra) => {
      try {
        const normalizedQuery = normalizeSearchQuery(query);
        const items = await observeProviderOperation({
          binding: runtime.binding,
          operation: 'search',
          execute: () =>
            withProviderTimeout(
              runtime.config.timeoutMs,
              extra.signal,
              (signal) =>
                runtime.binding.provider.search({
                  query: normalizedQuery,
                  limit: 5,
                  signal,
                }),
            ),
          count: (result) => result.length,
        });
        return textResult(renderExternalContext(items));
      } catch {
        return errorResult('External context search failed.');
      }
    },
  );

  return server;
}

export async function runMcp(): Promise<void> {
  const config = await loadConfig();
  const binding = createProvider(config.provider);
  const server = createExternalContextMcpServer({ config, binding });
  await server.connect(new StdioServerTransport());
}

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
  };
}

function errorResult(text: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text }],
  };
}
