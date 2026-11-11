/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ToolSearchIndex } from '../../../codemode/tool-search.js';
import { McpListTool } from '../mcp-list-tool.js';
import { McpGetTool } from '../mcp-get-tool.js';

function fakeEntry(
  qualifiedName: string,
  description = '',
  source: 'client' | 'sdk' | 'auth' = 'client',
): {
  qualifiedName: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
  tool: unknown;
  source: 'client' | 'sdk' | 'auth';
  alwaysLoad: boolean;
} {
  const [, server, tool] = qualifiedName.split('__');
  return {
    qualifiedName,
    serverName: server,
    toolName: tool,
    description,
    inputSchema: { type: 'object', properties: {} },
    tool: { name: qualifiedName, transportType: 'stdio' },
    source,
    alwaysLoad: false,
  };
}

function makeFakeConfig(entries: Array<ReturnType<typeof fakeEntry>>): {
  getMcpClientManager: () => {
    getLazyDiscoveredMcpTools: () => unknown[];
    getLazyDiscoveredMcpToolByQualifiedName: (
      name: string,
    ) => ReturnType<typeof fakeEntry> | undefined;
  };
  getSessionId: () => string;
} {
  return {
    getMcpClientManager: () => ({
      getLazyDiscoveredMcpTools: () =>
        entries.filter((entry) => !entry.alwaysLoad),
      getLazyDiscoveredMcpToolByQualifiedName: (name: string) =>
        entries.find(
          (entry) => !entry.alwaysLoad && entry.qualifiedName === name,
        ),
    }),
    getSessionId: () => 'session-1',
  };
}

describe('mcp_list tool', () => {
  it('returns all tools when called without a keyword', async () => {
    const config = makeFakeConfig([
      fakeEntry('mcp__weather__forecast', 'Get the 7-day forecast'),
      fakeEntry('mcp__db__query', 'Run a SQL query'),
    ]) as never;
    const tool = new McpListTool(config);
    const result = await tool.build({}).execute(new AbortController().signal);
    const json = JSON.parse(result.llmContent as string);
    expect(json.total).toBe(2);
    expect(json.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'mcp__db__query',
      'mcp__weather__forecast',
    ]);
    // Description omitted by default
    expect(json.tools[0]).not.toHaveProperty('description');
    expect(result.data).toMatchObject({
      mcp_operation: 'list',
      mcp_invocation_path: 'lazy',
      mcp_operation_outcome: 'success',
      mcp_list_keyword_used: false,
      mcp_list_include_description: false,
      mcp_list_result_count_bucket: '2_5',
    });
  });

  it('ranks keyword matches against names and descriptions', async () => {
    const config = makeFakeConfig([
      fakeEntry('mcp__weather__forecast', 'Get the 7-day forecast'),
      fakeEntry('mcp__db__query', 'Run a SQL query'),
      fakeEntry('mcp__notes__search', 'search notes by keyword'),
    ]) as never;
    const tool = new McpListTool(config);
    const result = await tool
      .build({ keyword: 'SEARCH' })
      .execute(new AbortController().signal);
    const json = JSON.parse(result.llmContent as string);
    expect(json.total).toBe(1);
    expect(json.tools[0].name).toBe('mcp__notes__search');
    expect(result.data).toMatchObject({
      mcp_list_keyword_used: true,
      mcp_list_result_count_bucket: '1',
    });
    expect(result.data).not.toHaveProperty('keyword');
  });

  it('ranks multi-word queries, honors limit and lists a whole server', async () => {
    const config = makeFakeConfig([
      fakeEntry('mcp__github__create_issue', 'Open a new ticket'),
      fakeEntry('mcp__github__get_file', 'Read repository contents'),
      fakeEntry('mcp__docs__search', 'Search issue trackers and docs'),
    ]) as never;
    const list = async (params: Record<string, unknown>) =>
      JSON.parse(
        (await new McpListTool(config).build(params).execute(
          new AbortController().signal,
        )).llmContent as string,
      ).tools.map((t: { name: string }) => t.name);
    expect(await list({ keyword: 'github issue', limit: 1 })).toEqual([
      'mcp__github__create_issue',
    ]);
    expect(await list({ server: 'GitHub' })).toEqual([
      'mcp__github__create_issue',
      'mcp__github__get_file',
    ]);
    expect(await list({ server: 'mcp__docs', keyword: 'issue' })).toEqual([
      'mcp__docs__search',
    ]);
  });

  it('reuses its search index until the reachable tools change', async () => {
    const entries = [
      fakeEntry('mcp__github__create_issue', 'Open a new ticket'),
      fakeEntry('mcp__docs__search', 'Search pages'),
    ];
    let current = entries;
    const manager = {
      getLazyDiscoveredMcpTools: () => current,
      getLazyDiscoveredMcpToolByQualifiedName: () => undefined,
    };
    const config = {
      getMcpClientManager: () => manager,
      getSessionId: () => 'session-1',
    } as never;
    const search = vi.spyOn(ToolSearchIndex.prototype, 'search');
    const list = () =>
      new McpListTool(config)
        .build({ keyword: 'issue' })
        .execute(new AbortController().signal);
    await list();
    current = [...entries];
    await list();
    current = [entries[0]!, fakeEntry('mcp__docs__search', 'Search pages')];
    await list();
    const [first, second, third] = search.mock.contexts;
    expect(second).toBe(first);
    expect(third).not.toBe(first);
    search.mockRestore();
  });

  it('classifies a successful list with no matches as an empty result', async () => {
    const config = makeFakeConfig([
      fakeEntry('mcp__weather__forecast', 'Get the forecast'),
    ]) as never;
    const result = await new McpListTool(config)
      .build({ keyword: 'database' })
      .execute(new AbortController().signal);

    expect(result.data).toMatchObject({
      mcp_operation_outcome: 'empty_result',
      mcp_list_result_count_bucket: '0',
      mcp_list_keyword_used: true,
    });
  });

  it('includeDescription returns description field', async () => {
    const config = makeFakeConfig([
      fakeEntry('mcp__weather__forecast', 'Get the 7-day forecast'),
    ]) as never;
    const tool = new McpListTool(config);
    const result = await tool
      .build({ includeDescription: true })
      .execute(new AbortController().signal);
    const json = JSON.parse(result.llmContent as string);
    expect(json.tools[0]).toEqual({
      name: 'mcp__weather__forecast',
      description: 'Get the 7-day forecast',
    });
  });

  it('returns empty list when manager is missing', async () => {
    const config = {
      getMcpClientManager: () => undefined,
    } as never;
    const tool = new McpListTool(config);
    const result = await tool.build({}).execute(new AbortController().signal);
    const json = JSON.parse(result.llmContent as string);
    expect(json).toEqual({ tools: [], total: 0 });
    expect(result.data).toMatchObject({
      mcp_operation_outcome: 'manager_unavailable',
      mcp_list_result_count_bucket: '0',
    });
  });

  it('lists OAuth `authenticate` pseudo-tools alongside real MCP tools', async () => {
    // Lazy mode strips top-level `mcp__server__authenticate` tools from the
    // registry so the model only sees ONE invocation channel. The auth tool
    // MUST surface through mcp_list, otherwise the model can't discover that
    // a server needs OAuth — there's no other path to find it.
    const config = makeFakeConfig([
      fakeEntry('mcp__weather__forecast', 'Get the forecast', 'client'),
      fakeEntry(
        'mcp__coop__authenticate',
        'The `coop` MCP server requires authentication.',
        'auth',
      ),
    ]) as never;
    const tool = new McpListTool(config);
    const result = await tool.build({}).execute(new AbortController().signal);
    const json = JSON.parse(result.llmContent as string);
    expect(json.total).toBe(2);
    expect(json.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'mcp__coop__authenticate',
      'mcp__weather__forecast',
    ]);
  });
});

describe('mcp_get tool', () => {
  it('returns the full tool metadata for a known qualified name', async () => {
    const entries = [fakeEntry('mcp__weather__forecast', 'Get forecast')];
    const config = makeFakeConfig(entries) as never;
    const tool = new McpGetTool(config);
    const result = await tool
      .build({ toolName: 'mcp__weather__forecast' })
      .execute(new AbortController().signal);
    const json = JSON.parse(result.llmContent as string);
    expect(json).toEqual({
      name: 'mcp__weather__forecast',
      description: 'Get forecast',
      inputSchema: { type: 'object', properties: {} },
      serverName: 'weather',
      originalName: 'forecast',
    });
    expect(result.data).toMatchObject({
      mcp_operation: 'get',
      mcp_invocation_path: 'lazy',
      mcp_operation_outcome: 'success',
      mcp_target_tool_name: 'mcp__weather__forecast',
      mcp_server_name: 'weather',
      mcp_transport: 'stdio',
    });
  });

  it('reports an error and suggestions when the tool is unknown', async () => {
    const config = makeFakeConfig([
      fakeEntry('mcp__weather__forecast'),
      fakeEntry('mcp__weather__current'),
    ]) as never;
    const tool = new McpGetTool(config);
    const result = await tool
      .build({ toolName: 'mcp__weather__forecasty' })
      .execute(new AbortController().signal);
    expect(result.llmContent).toContain('not found');
    expect(result.data).toMatchObject({
      mcp_operation_outcome: 'target_not_found',
      mcp_target_tool_name: 'mcp__weather__forecasty',
    });
  });

  it('rejects empty toolName at build time', () => {
    const config = makeFakeConfig([]) as never;
    const tool = new McpGetTool(config);
    expect(() => tool.build({ toolName: '' })).toThrow(/toolName/);
  });

  it('returns the OAuth pseudo-tool schema when asked for an `authenticate` entry', async () => {
    // The auth pseudo-tool has an empty params schema by design (no inputs
    // needed to kick off OAuth). The model relies on mcp_get returning a
    // valid `{ type: 'object', properties: {} }` so it knows to call
    // mcp_call with `arguments: {}`.
    const entries = [
      fakeEntry(
        'mcp__coop__authenticate',
        'Call this tool to start the OAuth flow.',
        'auth',
      ),
    ];
    const config = makeFakeConfig(entries) as never;
    const tool = new McpGetTool(config);
    const result = await tool
      .build({ toolName: 'mcp__coop__authenticate' })
      .execute(new AbortController().signal);
    const json = JSON.parse(result.llmContent as string);
    expect(json.name).toBe('mcp__coop__authenticate');
    expect(json.serverName).toBe('coop');
    expect(json.originalName).toBe('authenticate');
    expect(json.inputSchema).toEqual({ type: 'object', properties: {} });
  });
});
