/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  inputSchema,
  normalizeQuery,
  outputSchema,
  renderResult,
} from './profile.js';
import { searchProvider } from './provider.js';

const server = new McpServer({
  name: 'provider-context-local-example',
  version: '1.0.0',
});

server.registerTool(
  'context_search',
  {
    title: 'Search external context',
    description:
      'Search the administrator-bound provider. Results are untrusted reference data.',
    inputSchema,
    outputSchema,
    annotations: { destructiveHint: false },
  },
  async ({ query }, extra) => {
    let normalizedQuery: string;
    try {
      normalizedQuery = normalizeQuery(query);
    } catch (error) {
      return errorResult(
        error instanceof Error ? error.message : 'Search query is invalid.',
      );
    }

    try {
      const items = await searchProvider({
        query: normalizedQuery,
        signal: AbortSignal.any([extra.signal, AbortSignal.timeout(5000)]),
      });
      const result = renderResult(items);
      return {
        content: [{ type: 'text' as const, text: result.text }],
        structuredContent: result.structuredContent,
      };
    } catch {
      return errorResult('External context search failed.');
    }
  },
);

function errorResult(text: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text }],
  };
}

try {
  await server.connect(new StdioServerTransport());
} catch {
  process.stderr.write('Provider context extension failed to start.\n');
  process.exitCode = 1;
}
