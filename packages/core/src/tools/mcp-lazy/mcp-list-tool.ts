/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import { defineDeclarativeTool } from '../define-tool.js';
import { Kind } from '../tools.js';

import { MCP_LIST_TOOL_NAME } from './constants.js';
import {
  DEFAULT_SEARCH_LIMIT,
  ToolSearchIndex,
  namespaceKey,
  toolSearchText,
} from '../../codemode/tool-search.js';

export { MCP_LIST_TOOL_NAME };

interface McpListParams {
  keyword?: string;
  server?: string;
  limit?: number;
  includeDescription?: boolean;
}

type McpManager = NonNullable<ReturnType<Config['getMcpClientManager']>>;
type McpEntry = ReturnType<McpManager['getLazyDiscoveredMcpTools']>[number];
interface SearchableEntry {
  entry: McpEntry;
  name: string;
  namespace: string;
  searchText: string;
}

/** The last index per manager, reused while its tool objects and server metadata are unchanged. */
const searchIndexes = new WeakMap<
  McpManager,
  { tools: readonly unknown[]; servers: string; index: ToolSearchIndex<SearchableEntry> }
>();

function searchIndex(
  manager: McpManager,
  entries: readonly McpEntry[],
): ToolSearchIndex<SearchableEntry> {
  const snapshot =
    manager.getLazyMcpServerSnapshot?.()?.map((server) => ({
      name: server.serverName,
      description: server.description,
      instructions: server.instructions,
    })) ?? [];
  const servers = JSON.stringify(snapshot);
  const cached = searchIndexes.get(manager);
  if (
    cached &&
    cached.servers === servers &&
    cached.tools.length === entries.length &&
    entries.every((entry, index) => cached.tools[index] === entry.tool)
  )
    return cached.index;
  const index = new ToolSearchIndex(
    entries.map((entry) => ({
      entry,
      name: entry.qualifiedName,
      namespace: entry.serverName,
      searchText: toolSearchText(
        entry.qualifiedName,
        entry.description,
        entry.inputSchema,
      ),
    })),
    snapshot,
  );
  searchIndexes.set(manager, {
    tools: entries.map((entry) => entry.tool),
    servers,
    index,
  });
  return index;
}

/**
 * Lazy-mode discovery tool — lists all MCP tools available across connected
 * servers without baking their schemas into the system prompt.
 *
 * Returns `{ tools: Array<{ name, description? }>, total }` where each `name`
 * is the fully qualified `mcp__server__tool` form. The model is expected to
 * call this first, then `mcp_get` for the chosen tool's input schema, then
 * `mcp_call` to dispatch.
 */
export const McpListTool = defineDeclarativeTool<
  McpListParams,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  Config
>({
  name: MCP_LIST_TOOL_NAME,
  displayName: 'MCP List',
  exposureHints: { metaTool: 'mcp' },
  description:
    'List MCP tools across all connected MCP servers.\n' +
    '\n' +
    'Use this to discover which MCP tools are available before calling one. ' +
    'Each entry has a fully-qualified `name` of the form `mcp__<server>__<tool>`.\n' +
    '\n' +
    'Parameters:\n' +
    '- keyword (optional): search words matched against tool names, descriptions, ' +
    'parameters and server metadata; the best matches are returned in ranked order. ' +
    'Omit it to list every tool.\n' +
    '- server (optional): only tools of this MCP server; without a keyword, lists all of them.\n' +
    `- limit (optional, default ${DEFAULT_SEARCH_LIMIT}): maximum number of ranked matches for a keyword.\n` +
    '- includeDescription (optional, default false): when true, each entry ' +
    "includes the tool's description.\n" +
    '\n' +
    'After locating the tool you want, call `mcp_get({ toolName })` to get its ' +
    'input schema, then `mcp_call({ toolName, arguments })` to invoke it.',
  kind: Kind.Search,
  parameterSchema: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description:
          'Optional search words; matches are ranked by relevance to tool names, descriptions, parameters and server metadata.',
      },
      server: {
        type: 'string',
        description:
          'Optional MCP server name; restricts results to its tools. Without a keyword, lists every tool of the server.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: `Maximum ranked matches for a keyword. Default ${DEFAULT_SEARCH_LIMIT}.`,
      },
      includeDescription: {
        type: 'boolean',
        description:
          'When true, each entry includes the description. Default false to save tokens.',
      },
    },
    additionalProperties: false,
  },
  isConcurrencySafe: () => true,
  execute: async (params, _ctx, config) => {
    const manager = config.getMcpClientManager();
    if (!manager) {
      return {
        llmContent: JSON.stringify({ tools: [], total: 0 }),
        returnDisplay: 'No MCP client manager available.',
      };
    }
    const server = params.server?.trim();
    const entries = manager.getLazyDiscoveredMcpTools();
    const keyword = params.keyword?.trim();
    const includeDesc = params.includeDescription === true;

    const filtered = keyword
      ? searchIndex(manager, entries)
          .search(keyword, {
            limit: params.limit ?? DEFAULT_SEARCH_LIMIT,
            ...(server ? { namespace: server } : {}),
          })
          .map((match) => match.entry)
      : server
        ? entries.filter(
            (entry) => namespaceKey(entry.serverName) === namespaceKey(server),
          )
        : entries;

    const tools = filtered.map((e) =>
      includeDesc
        ? { name: e.qualifiedName, description: e.description ?? '' }
        : { name: e.qualifiedName },
    );

    const payload = { tools, total: tools.length };
    return {
      llmContent: JSON.stringify(payload),
      returnDisplay: `Found ${tools.length} MCP tool${tools.length === 1 ? '' : 's'}${server ? ` on ${server}` : ''}${keyword ? ` matching "${keyword}"` : ''}.`,
    };
  },
});
