/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { McpCallTool } from '../mcp-call-tool.js';
import { McpListTool } from '../mcp-list-tool.js';
import { DiscoveredMCPTool } from '../../../mcp/tools/mcp-tool.js';
import type { CallableTool } from '@google/genai';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ToolErrorType } from '../../tool-error.js';

interface FakeEntry {
  qualifiedName: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
  tool: {
    name: string;
    transportType: string;
    build: ReturnType<typeof vi.fn>;
    isDestructive: ReturnType<typeof vi.fn>;
    isConcurrencySafe: ReturnType<typeof vi.fn>;
    toClassifierInput: ReturnType<typeof vi.fn>;
    checkPermissions: ReturnType<typeof vi.fn>;
  };
  source: 'client' | 'sdk' | 'auth';
}

interface BuiltInvocation {
  execute: ReturnType<typeof vi.fn>;
}

function fakeEntry(
  qualifiedName: string,
  options: {
    isDestructive?: boolean;
    isConcurrencySafe?: boolean;
    classifierInput?: unknown;
    executeResult?: { llmContent: string; returnDisplay: string };
    /**
     * Override the underlying tool's checkPermissions return value. Defaults
     * to a passthrough result so existing tests that don't care about
     * permission delegation behave like the real DiscoveredMCPTool.
     */
    checkPermissionsResult?: unknown;
    /**
     * Source of the entry — defaults to `'client'`. Use `'auth'` to model an
     * OAuth `authenticate` pseudo-tool routed through the lazy meta path.
     */
    source?: 'client' | 'sdk' | 'auth';
  } = {},
): { entry: FakeEntry; invocation: BuiltInvocation } {
  const [, server, tool] = qualifiedName.split('__');
  const invocation: BuiltInvocation = {
    execute: vi.fn().mockResolvedValue(
      options.executeResult ?? {
        llmContent: 'ok',
        returnDisplay: 'ok',
      },
    ),
  };
  const entry: FakeEntry = {
    qualifiedName,
    serverName: server,
    toolName: tool,
    description: '',
    inputSchema: { type: 'object', properties: {} },
    tool: {
      name: qualifiedName,
      transportType: 'stdio',
      build: vi.fn().mockReturnValue(invocation),
      isDestructive: vi.fn().mockReturnValue(options.isDestructive ?? false),
      isConcurrencySafe: vi
        .fn()
        .mockReturnValue(options.isConcurrencySafe ?? false),
      toClassifierInput: vi.fn().mockReturnValue(
        options.classifierInput ?? {
          mcp_server: server,
          mcp_tool: tool,
        },
      ),
      checkPermissions: vi.fn().mockResolvedValue(
        options.checkPermissionsResult ?? {
          behavior: 'passthrough',
          message: `Allow MCP tool ${server}/${tool}?`,
        },
      ),
    },
    source: options.source ?? 'client',
  };
  return { entry, invocation };
}

function makeFakeConfig(entries: FakeEntry[]): {
  getMcpClientManager: () => {
    prepareLazyMcpTool: (entry: FakeEntry) => Promise<FakeEntry>;
    getLazyDiscoveredMcpTools: () => FakeEntry[];
    getLazyDiscoveredMcpToolByQualifiedName: (
      name: string,
    ) => FakeEntry | undefined;
  };
  getSessionId: () => string;
} {
  return {
    getMcpClientManager: () => ({
      prepareLazyMcpTool: async (entry: FakeEntry) => entry,
      getLazyDiscoveredMcpTools: () => entries,
      getLazyDiscoveredMcpToolByQualifiedName: (name: string) =>
        entries.find((e) => e.qualifiedName === name),
    }),
    getSessionId: () => 'session-1',
  };
}

describe('mcp_call tool', () => {
  it('reports the rank its target had in the earliest mcp_list search of the session', async () => {
    const issue = fakeEntry('mcp__github__create_issue').entry;
    const file = fakeEntry('mcp__github__get_file').entry;
    const docs = fakeEntry('mcp__docs__search').entry;
    issue.description = 'Open a new issue';
    file.description = 'Read a file from an issue branch';
    const config = (sessionId: string) => ({
      ...makeFakeConfig([issue, file, docs]),
      getSessionId: () => sessionId,
    });
    const signal = new AbortController().signal;
    const call = async (sessionId: string, toolName: string) =>
      (
        await new McpCallTool(config(sessionId) as never)
          .build({ toolName, arguments: {} })
          .execute(signal)
      ).data;
    await new McpListTool(config('ranked') as never)
      .build({ keyword: 'issue' })
      .execute(signal);
    await new McpListTool(config('ranked') as never)
      .build({ keyword: 'file' })
      .execute(signal);
    expect(await call('ranked', issue.qualifiedName)).toMatchObject({
      mcp_list_rank: 1,
      // Effort before the session's first successful call: both listings.
      mcp_discovery_ops: 2,
      mcp_discovery_same_turn: true,
    });
    // The earliest search that returned a tool decides its rank.
    expect(await call('ranked', file.qualifiedName)).toMatchObject({
      mcp_list_rank: 2,
    });
    expect(await call('ranked', docs.qualifiedName)).not.toHaveProperty(
      'mcp_list_rank',
    );
    expect(await call('other', issue.qualifiedName)).not.toHaveProperty(
      'mcp_list_rank',
    );
  });

  it.each([123, '123'])(
    'dispatches a valid oneOf value %j through the lazy path',
    async (value) => {
      const { entry } = fakeEntry('mcp__test__echo');
      const callTool = vi.fn().mockResolvedValue([
        {
          functionResponse: {
            name: 'echo',
            response: { content: [{ type: 'text', text: 'ok' }] },
          },
        },
      ]);
      const discovered = new DiscoveredMCPTool(
        { callTool } as unknown as CallableTool,
        'test',
        'echo',
        '',
        {
          type: 'object',
          properties: {
            value: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          },
        },
      );
      entry.tool.build.mockImplementation((params) => discovered.build(params));
      const tool = new McpCallTool(makeFakeConfig([entry]) as never);

      const result = await tool
        .build({ toolName: entry.qualifiedName, arguments: { value } })
        .execute(new AbortController().signal);

      expect(callTool).toHaveBeenCalledExactlyOnceWith(
        [{ name: 'echo', args: { value } }],
        expect.any(AbortSignal),
      );
      expect(result.error).toBeUndefined();
      expect(result.data).toMatchObject({
        mcp_operation_outcome: 'success',
        mcp_dispatch_success: true,
        mcp_server_responded: true,
      });
    },
  );

  it('successfully invokes a known tool and returns its result', async () => {
    const { entry, invocation } = fakeEntry('mcp__weather__forecast', {
      executeResult: {
        llmContent: '{"temp":72}',
        returnDisplay: 'Forecast retrieved',
      },
    });
    const config = makeFakeConfig([entry]) as never;
    const tool = new McpCallTool(config);
    const ac = new AbortController();
    const result = await tool
      .build({
        toolName: 'mcp__weather__forecast',
        arguments: { city: 'Seattle' },
      })
      .execute(ac.signal);

    expect(entry.tool.build).toHaveBeenCalledWith({ city: 'Seattle' });
    expect(invocation.execute).toHaveBeenCalledWith(ac.signal);
    expect(result.llmContent).toBe('{"temp":72}');
    expect(result.returnDisplay).toBe('Forecast retrieved');
    expect(result.data).toMatchObject({
      mcp_operation: 'call',
      mcp_invocation_path: 'lazy',
      mcp_operation_outcome: 'success',
      mcp_dispatch_success: true,
      mcp_server_responded: true,
      mcp_semantic_success: true,
      mcp_target_tool_name: 'mcp__weather__forecast',
      mcp_server_name: 'weather',
      mcp_transport: 'stdio',
    });
  });

  it('returns an error result when the tool name is unknown', async () => {
    const { entry } = fakeEntry('mcp__weather__forecast');
    const config = makeFakeConfig([entry]) as never;
    const tool = new McpCallTool(config);
    const result = await tool
      .build({ toolName: 'mcp__weather__missing' })
      .execute(new AbortController().signal);
    expect(result.llmContent).toContain('not found');
    expect(result.returnDisplay).toContain('not found');
    expect(result.data).toMatchObject({
      mcp_operation_outcome: 'target_not_found',
      mcp_dispatch_success: false,
      mcp_server_responded: false,
    });
    // Should not have attempted to dispatch through the unrelated entry.
    expect(entry.tool.build).not.toHaveBeenCalled();
  });

  it('treats omitted arguments as an empty object when invoking the underlying tool', async () => {
    const { entry } = fakeEntry('mcp__db__list');
    const config = makeFakeConfig([entry]) as never;
    const tool = new McpCallTool(config);
    await tool
      .build({ toolName: 'mcp__db__list' })
      .execute(new AbortController().signal);
    expect(entry.tool.build).toHaveBeenCalledWith({});
  });

  it('returns an error when the MCP client manager is unavailable', async () => {
    const config = {
      getMcpClientManager: () => undefined,
    } as never;
    const tool = new McpCallTool(config);
    const result = await tool
      .build({ toolName: 'mcp__anything__call' })
      .execute(new AbortController().signal);
    expect(result.llmContent).toContain('MCP client manager unavailable');
    expect(result.returnDisplay).toContain('MCP client manager unavailable');
    expect(result.data).toMatchObject({
      mcp_operation_outcome: 'manager_unavailable',
      mcp_dispatch_success: false,
      mcp_server_responded: false,
    });
  });

  it('preserves underlying result metadata and classifies server semantic errors', async () => {
    const { entry } = fakeEntry('mcp__db__query');
    const underlyingData = { provider_trace_id: 'trace-1' };
    entry.tool.build.mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        llmContent: 'query rejected',
        returnDisplay: 'query rejected',
        isError: true,
        mcpMeta: { serverName: 'db' },
        data: underlyingData,
      }),
    });
    const tool = new McpCallTool(makeFakeConfig([entry]) as never);

    const result = await tool
      .build({ toolName: 'mcp__db__query', arguments: {} })
      .execute(new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.mcpMeta).toEqual({ serverName: 'db' });
    expect(result.data).toMatchObject({
      provider_trace_id: 'trace-1',
      mcp_operation_outcome: 'server_error',
      mcp_semantic_success: false,
      mcp_dispatch_success: true,
      mcp_server_responded: true,
    });
  });

  it('classifies underlying argument validation without dispatching', async () => {
    const { entry } = fakeEntry('mcp__db__query');
    entry.tool.build.mockImplementation(() => {
      throw new Error('invalid arguments');
    });
    const tool = new McpCallTool(makeFakeConfig([entry]) as never);

    const result = await tool
      .build({ toolName: 'mcp__db__query', arguments: { sql: 1 } })
      .execute(new AbortController().signal);

    expect(result.data).toMatchObject({
      mcp_operation_outcome: 'invalid_tool_arguments',
      mcp_dispatch_success: false,
      mcp_server_responded: false,
    });
  });

  it('classifies structured timeouts without matching error text', async () => {
    const { entry } = fakeEntry('mcp__db__query');
    const timeout = Object.assign(new Error('request failed'), {
      code: 'ETIMEDOUT',
    });
    entry.tool.build.mockReturnValue({
      execute: vi.fn().mockRejectedValue(timeout),
    });
    const tool = new McpCallTool(makeFakeConfig([entry]) as never);

    const result = await tool
      .build({ toolName: 'mcp__db__query', arguments: {} })
      .execute(new AbortController().signal);

    expect(result.data).toMatchObject({
      mcp_operation_outcome: 'timeout',
      mcp_dispatch_success: true,
      mcp_server_responded: false,
    });
  });

  it('classifies non-timeout execution failures as transport errors', async () => {
    const { entry } = fakeEntry('mcp__db__query');
    entry.tool.build.mockReturnValue({
      execute: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('connection closed'), { code: 'ECONNRESET' }),
        ),
    });
    const tool = new McpCallTool(makeFakeConfig([entry]) as never);

    const result = await tool
      .build({ toolName: 'mcp__db__query', arguments: {} })
      .execute(new AbortController().signal);

    expect(result.data).toMatchObject({
      mcp_operation_outcome: 'transport_error',
      mcp_dispatch_success: true,
      mcp_server_responded: false,
    });
  });

  it.each([
    [
      'SDK timeout',
      new McpError(ErrorCode.RequestTimeout, 'request failed'),
      'timeout',
    ],
    [
      'disconnect',
      new McpError(ErrorCode.ConnectionClosed, 'connection closed'),
      'transport_error',
    ],
  ] as const)(
    'preserves normalized %s from a discovered MCP tool',
    async (_label, error, outcome) => {
      const { entry } = fakeEntry('mcp__db__query');
      const underlying = new DiscoveredMCPTool(
        {
          callTool: vi.fn().mockRejectedValue(error),
        } as unknown as CallableTool,
        'db',
        'query',
        'Query',
        { type: 'object', properties: {} },
      );
      entry.tool.build.mockImplementation((args) => underlying.build(args));
      const result = await new McpCallTool(makeFakeConfig([entry]) as never)
        .build({ toolName: entry.qualifiedName })
        .execute(new AbortController().signal);
      expect(result.error).toEqual({
        type: ToolErrorType.MCP_TOOL_ERROR,
        message: error.message,
      });
      expect(result.data).toMatchObject({
        mcp_operation_outcome: outcome,
        mcp_dispatch_success: true,
        mcp_server_responded: false,
        mcp_error: { errorCode: String(error.code) },
      });
      expect(result.isError).toBeUndefined();
      expect(result.mcpResult).toBeUndefined();
    },
  );

  it('preserves cause diagnostics when connection preparation fails', async () => {
    const { entry, invocation } = fakeEntry('mcp__db__query');
    const config = makeFakeConfig([entry]);
    const manager = config.getMcpClientManager();
    const cause = Object.assign(new Error('socket timed out'), {
      code: 'ETIMEDOUT',
    });
    vi.spyOn(manager, 'prepareLazyMcpTool').mockRejectedValue(
      new Error('connection failed', { cause }),
    );
    vi.spyOn(config, 'getMcpClientManager').mockReturnValue(manager);
    const result = await new McpCallTool(config as never)
      .build({ toolName: entry.qualifiedName })
      .execute(new AbortController().signal);
    expect(result.error?.message).toContain('socket timed out');
    expect(result.data).toMatchObject({
      mcp_operation_outcome: 'timeout',
      mcp_dispatch_success: false,
      mcp_server_responded: false,
      mcp_error: { errorCauseCode: 'ETIMEDOUT' },
    });
    expect(invocation.execute).not.toHaveBeenCalled();
  });

  it('propagates cancellation without classifying it as a transport failure', async () => {
    const { entry, invocation } = fakeEntry('mcp__db__query');
    const error = new DOMException('cancelled', 'AbortError');
    invocation.execute.mockRejectedValue(error);
    await expect(
      new McpCallTool(makeFakeConfig([entry]) as never)
        .build({ toolName: entry.qualifiedName })
        .execute(new AbortController().signal),
    ).rejects.toBe(error);
  });

  it('rejects empty toolName at build time', () => {
    const config = makeFakeConfig([]) as never;
    const tool = new McpCallTool(config);
    expect(() => tool.build({ toolName: '' })).toThrow(/toolName/);
  });

  it('rejects non-object arguments at build time', () => {
    const config = makeFakeConfig([]) as never;
    const tool = new McpCallTool(config);
    expect(() =>
      tool.build({
        toolName: 'mcp__x__y',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        arguments: 'not an object' as any,
      }),
    ).toThrow(/arguments/);
    expect(() =>
      tool.build({
        toolName: 'mcp__x__y',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        arguments: [1, 2] as any,
      }),
    ).toThrow(/arguments/);
  });

  it('delegates isDestructive to the resolved underlying tool', () => {
    const { entry: safe } = fakeEntry('mcp__safe__read');
    const { entry: dangerous } = fakeEntry('mcp__danger__delete', {
      isDestructive: true,
    });
    const config = makeFakeConfig([safe, dangerous]) as never;
    const tool = new McpCallTool(config);
    expect(
      tool.isDestructive({ toolName: 'mcp__safe__read', arguments: {} }),
    ).toBe(false);
    expect(
      tool.isDestructive({ toolName: 'mcp__danger__delete', arguments: {} }),
    ).toBe(true);
    // Underlying is consulted with the actual arguments object.
    expect(dangerous.tool.isDestructive).toHaveBeenCalledWith({});
  });

  it('falls back to non-destructive when the underlying tool is unknown', () => {
    const { entry } = fakeEntry('mcp__weather__forecast');
    const config = makeFakeConfig([entry]) as never;
    const tool = new McpCallTool(config);
    expect(
      tool.isDestructive({ toolName: 'mcp__missing__tool', arguments: {} }),
    ).toBe(false);
  });

  it('delegates isConcurrencySafe to the resolved underlying tool', () => {
    // Read-only MCP tools (e.g. `readOnlyHint: true`) expose
    // isConcurrencySafe=true through DiscoveredMCPTool — without explicit
    // delegation here, mcp_call would force them into serial batches and
    // silently regress eager-mode behavior.
    const { entry: serial } = fakeEntry('mcp__write__createFile');
    const { entry: concurrent } = fakeEntry('mcp__weather__forecast', {
      isConcurrencySafe: true,
    });
    const config = makeFakeConfig([serial, concurrent]) as never;
    const tool = new McpCallTool(config);
    expect(
      tool.isConcurrencySafe({
        toolName: 'mcp__write__createFile',
        arguments: {},
      }),
    ).toBe(false);
    expect(
      tool.isConcurrencySafe({
        toolName: 'mcp__weather__forecast',
        arguments: {},
      }),
    ).toBe(true);
    expect(concurrent.tool.isConcurrencySafe).toHaveBeenCalledWith({});
  });

  it('falls back to non-concurrent when the underlying tool is unknown', () => {
    const { entry } = fakeEntry('mcp__weather__forecast');
    const config = makeFakeConfig([entry]) as never;
    const tool = new McpCallTool(config);
    expect(
      tool.isConcurrencySafe({ toolName: 'mcp__missing__tool', arguments: {} }),
    ).toBe(false);
  });

  it('produces a classifier input that delegates to the underlying tool when resolvable', () => {
    const innerClassifier = {
      mcp_server: 'weather',
      mcp_tool: 'forecast',
      description: '7-day',
      arguments: '{"city":"Seattle"}',
    };
    const { entry } = fakeEntry('mcp__weather__forecast', {
      classifierInput: innerClassifier,
    });
    const config = makeFakeConfig([entry]) as never;
    const tool = new McpCallTool(config);
    const out = tool.toClassifierInput({
      toolName: 'mcp__weather__forecast',
      arguments: { city: 'Seattle' },
    }) as Record<string, unknown>;
    expect(out['via_meta_tool']).toBe('mcp_call');
    expect(out['qualified_tool_name']).toBe('mcp__weather__forecast');
    expect(out['underlying']).toEqual(innerClassifier);
    expect(entry.tool.toClassifierInput).toHaveBeenCalledWith({
      city: 'Seattle',
    });
  });

  it('falls back to a meta-only classifier payload when the tool is unknown', () => {
    const config = makeFakeConfig([]) as never;
    const tool = new McpCallTool(config);
    const out = tool.toClassifierInput({
      toolName: 'mcp__missing__tool',
      arguments: { a: 1 },
    }) as Record<string, unknown>;
    expect(out['via_meta_tool']).toBe('mcp_call');
    expect(out['qualified_tool_name']).toBe('mcp__missing__tool');
    expect(out['arguments']).toBe('{"a":1}');
    // No `underlying` key when resolution fails.
    expect(out['underlying']).toBeUndefined();
  });

  it('keeps long meta-only arguments whole', () => {
    const config = makeFakeConfig([]) as never;
    const tool = new McpCallTool(config);
    const body = 'x'.repeat(5000) + 'TAIL';
    const out = tool.toClassifierInput({
      toolName: 'mcp__missing__tool',
      arguments: { body },
    }) as Record<string, unknown>;
    expect(out['arguments']).toBe(JSON.stringify({ body }));
  });
});
