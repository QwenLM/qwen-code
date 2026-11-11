/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import os from 'node:os';
import path from 'node:path';
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mocked,
} from 'vitest';
import { safeJsonStringify } from '../../utils/safeJsonStringify.js';
import {
  DiscoveredMCPTool,
  generateValidName,
  formatMcpToolName,
} from './mcp-tool.js';
import { type ToolResult } from '../../tools/tools.js';
import type { CallableTool, Part } from '@google/genai';
import { processImageBufferWithTokenBudget } from '../../utils/imageReader.js';
import { getToolParameterDiagnosticData } from '../../tools/tool-parameter-diagnostics.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ToolErrorType } from '../../tools/tool-error.js';

vi.mock('../../utils/imageReader.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/imageReader.js')>();
  return {
    ...actual,
    processImageBufferWithTokenBudget: vi.fn(
      async (
        _imageBuffer: Buffer,
        options?: { originalMediaType?: string },
      ) => ({
        base64: 'PROCESSED_IMAGE_DATA',
        mediaType: options?.originalMediaType ?? 'image/png',
        originalSize: 123,
      }),
    ),
  };
});

// Mock @google/genai mcpToTool and CallableTool
// We only need to mock the parts of CallableTool that DiscoveredMCPTool uses.
const mockCallTool = vi.fn();
const mockToolMethod = vi.fn();

const mockCallableToolInstance: Mocked<CallableTool> = {
  tool: mockToolMethod as any, // Not directly used by DiscoveredMCPTool instance methods
  callTool: mockCallTool as any,
  // Add other methods if DiscoveredMCPTool starts using them
};

const createSdkResponse = (
  toolName: string,
  response: Record<string, any>,
): Part[] => [
  {
    functionResponse: {
      name: toolName,
      response,
    },
  },
];

describe('generateValidName', () => {
  it('should return a valid name for a simple function', () => {
    expect(generateValidName('myFunction')).toBe('mcp__myFunction');
  });

  it('should replace invalid characters with underscores and collapse runs', () => {
    expect(generateValidName('invalid-name with spaces')).toBe(
      'mcp__invalid-name_with_spaces',
    );
  });

  it('should pass through long names unchanged (truncation removed)', () => {
    expect(generateValidName('x'.repeat(80))).toBe(`mcp__${'x'.repeat(80)}`);
  });

  it('should collapse runs of invalid characters to a single underscore', () => {
    // All chars invalid → collapse to a single _ then trimmed → empty → just the prefix.
    expect(generateValidName('!@#$%^&*()')).toBe('mcp__');
  });
});

describe('formatMcpToolName', () => {
  it('should format a fully qualified name', () => {
    expect(formatMcpToolName('github', 'list_repos')).toBe(
      'mcp__github__list_repos',
    );
  });

  it('should handle global wildcards', () => {
    expect(formatMcpToolName('*')).toBe('mcp__*');
  });

  it('should handle tool-level wildcards', () => {
    expect(formatMcpToolName('github', '*')).toBe('mcp__github__*');
  });

  it('should handle both server and tool wildcards', () => {
    expect(formatMcpToolName('*', '*')).toBe('mcp__*');
  });

  it('should handle undefined toolName as a tool-level wildcard', () => {
    expect(formatMcpToolName('github')).toBe('mcp__github__*');
  });

  it('should format explicitly global wildcard with specific tool', () => {
    expect(formatMcpToolName('*', 'list_repos')).toBe('mcp__*__list_repos');
  });
});

describe('DiscoveredMCPTool', () => {
  const serverName = 'mock-mcp-server';
  const serverToolName = 'actual-server-tool-name';
  const baseDescription = 'A test MCP tool.';
  const inputSchema: Record<string, unknown> = {
    type: 'object' as const,
    properties: { param: { type: 'string' } },
    required: ['param'],
  };

  let tool: DiscoveredMCPTool;

  beforeEach(() => {
    mockCallTool.mockClear();
    mockToolMethod.mockClear();
    vi.mocked(processImageBufferWithTokenBudget).mockClear();
    tool = new DiscoveredMCPTool(
      mockCallableToolInstance,
      serverName,
      serverToolName,
      baseDescription,
      inputSchema,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should set properties correctly', () => {
      expect(tool.name).toBe('mcp__mock-mcp-server__actual-server-tool-name');
      expect(tool.schema.name).toBe(
        'mcp__mock-mcp-server__actual-server-tool-name',
      );
      expect(tool.schema.description).toBe(baseDescription);
      expect(tool.schema.parameters).toBeUndefined();
      expect(tool.schema.parametersJsonSchema).toEqual(inputSchema);
      expect(tool.serverToolName).toBe(serverToolName);
    });
  });

  describe('toClassifierInput', () => {
    it('includes server, tool, description, and arguments', () => {
      expect(tool.toClassifierInput({ param: 'testValue' })).toEqual({
        mcp_server: serverName,
        mcp_tool: serverToolName,
        description: baseDescription,
        arguments: '{"param":"testValue"}',
      });
    });

    it('keeps long arguments whole', () => {
      const body = 'x'.repeat(5000) + 'TAIL';
      const out = tool.toClassifierInput({ body }) as Record<string, unknown>;
      expect(out['arguments']).toBe(JSON.stringify({ body }));
    });

    it('uses a stable placeholder for unserializable arguments', () => {
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;

      expect(tool.toClassifierInput(circular)).toEqual({
        mcp_server: serverName,
        mcp_tool: serverToolName,
        description: baseDescription,
        arguments: '[unserializable arguments]',
      });
    });

    it('does NOT surface destructive / open-world hints, even when declared', () => {
      // Server-declared annotation hints are unverifiable advisory metadata
      // and must not enter classifier decisions: trusting them would let a
      // server self-vouch (or spam destructive=true to consent-fatigue the
      // user). The classifier must reason from description + arguments only.
      // See toClassifierInput JSDoc for the full rationale.
      const annotated = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          readOnlyHint: true,
          destructiveHint: true,
          openWorldHint: true,
        },
      );
      const out = annotated.toClassifierInput({ param: 'v' }) as Record<
        string,
        unknown
      >;
      expect(out).toEqual({
        mcp_server: serverName,
        mcp_tool: serverToolName,
        description: baseDescription,
        arguments: '{"param":"v"}',
      });
      expect('server_hints' in out).toBe(false);
    });
  });

  describe('getDisplayTitle and getExplanation', () => {
    const commandTool = new DiscoveredMCPTool(
      mockCallableToolInstance,
      serverName,
      serverToolName,
      baseDescription,
      {
        type: 'object',
        properties: { command: { type: 'string' }, path: { type: 'string' } },
        required: ['command'],
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    it('should return command as title if it exists', () => {
      const invocation = commandTool.build({ command: 'ls -la' });
      expect(invocation.getDisplayTitle?.()).toBe('ls -la');
    });

    it('should return displayName if command does not exist', () => {
      const invocation = tool.build({ param: 'testValue' });
      expect(invocation.getDisplayTitle?.()).toBe(tool.displayName);
    });

    it('should return stringified json for getExplanation', () => {
      const params = { command: 'ls -la', path: '/' };
      const invocation = commandTool.build(params);
      expect(invocation.getExplanation?.()).toBe(safeJsonStringify(params));
    });

    it('should truncate and summarize long json payloads for getExplanation', () => {
      const longString = 'a'.repeat(600);
      const params = { command: 'echo', text: longString, other: 'value' };
      const invocation = commandTool.build(params);
      const explanation = invocation.getExplanation?.() ?? '';
      expect(explanation).toMatch(
        /^\[Payload omitted due to length with parameters: command, text, other\]$/,
      );
    });
  });

  describe('execute', () => {
    it.each([
      { value: 123 },
      { value: '123' },
      { value: [123] },
      { value: ['123'] },
      { value: 'abc' },
      { value: ['abc'] },
    ])(
      'sends valid nested oneOf input $value to the server',
      async ({ value }) => {
        const scalar = { oneOf: [{ type: 'string' }, { type: 'number' }] };
        const unionTool = new DiscoveredMCPTool(
          mockCallableToolInstance,
          serverName,
          serverToolName,
          baseDescription,
          {
            type: 'object',
            properties: {
              nodes: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['value'],
                  properties: {
                    value: {
                      oneOf: [
                        ...scalar.oneOf,
                        { type: 'array', items: scalar },
                      ],
                    },
                  },
                },
              },
            },
          },
        );
        const params = { nodes: [{ value }] };
        const original = structuredClone(params);
        mockCallTool.mockResolvedValue(
          createSdkResponse(serverToolName, {
            content: [{ type: 'text', text: 'ok' }],
          }),
        );

        expect(unionTool.validateToolParams(params)).toBeNull();
        await unionTool.build(params).execute(new AbortController().signal);

        expect(params).toEqual(original);
        expect(mockCallTool).toHaveBeenCalledExactlyOnceWith(
          [{ name: serverToolName, args: original }],
          expect.any(AbortSignal),
        );
      },
    );

    it.each([
      { schema: { type: ['string', 'number'] }, value: 777 },
      { schema: { type: ['number', 'string'] }, value: '777' },
      { schema: { type: ['string', 'boolean'] }, value: true },
    ])(
      'sends valid type-array union value $value to the server unchanged',
      async ({ schema, value }) => {
        const unionTool = new DiscoveredMCPTool(
          mockCallableToolInstance,
          serverName,
          serverToolName,
          baseDescription,
          {
            type: 'object',
            required: ['value'],
            properties: { value: schema },
          },
        );
        const params = { value };
        const original = structuredClone(params);
        mockCallTool.mockResolvedValue(
          createSdkResponse(serverToolName, {
            content: [{ type: 'text', text: 'ok' }],
          }),
        );

        expect(unionTool.validateToolParams(params)).toBeNull();
        await unionTool.build(params).execute(new AbortController().signal);

        expect(params).toEqual(original);
        expect(mockCallTool).toHaveBeenCalledExactlyOnceWith(
          [{ name: serverToolName, args: original }],
          expect.any(AbortSignal),
        );
      },
    );

    it.each([
      {
        schema: {
          type: ['object', 'null'],
          properties: {
            items: { type: 'array', items: { type: 'number' } },
            id: { type: ['string', 'number'] },
          },
        },
        value: { items: '[1,2]', id: 42 },
        expected: { items: [1, 2], id: 42 },
      },
      {
        schema: {
          type: ['array', 'null'],
          items: {
            type: 'object',
            properties: { id: { type: ['string', 'number'] } },
          },
        },
        value: ['{"id":42}'],
        expected: [{ id: 42 }],
      },
    ])(
      'parses nested containers inside a $schema.type union before calling MCP',
      async ({ schema, value, expected }) => {
        const unionTool = new DiscoveredMCPTool(
          mockCallableToolInstance,
          serverName,
          serverToolName,
          baseDescription,
          {
            type: 'object',
            required: ['value'],
            properties: { value: schema },
          },
        );
        mockCallTool.mockResolvedValue(
          createSdkResponse(serverToolName, {
            content: [{ type: 'text', text: 'ok' }],
          }),
        );

        await unionTool.build({ value }).execute(new AbortController().signal);

        expect(mockCallTool).toHaveBeenCalledExactlyOnceWith(
          [{ name: serverToolName, args: { value: expected } }],
          expect.any(AbortSignal),
        );
      },
    );

    it('retains schema diagnostics when coercion fails after changing a field', () => {
      const unionTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        {
          type: 'object',
          properties: {
            offset: { type: 'number' },
            value: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          },
        },
      );
      const params = { offset: '10', value: '123' };
      let failure: unknown;
      try {
        unionTool.build(params);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('oneOf');
      const diagnostic = getToolParameterDiagnosticData(failure);
      expect(diagnostic?.tool_error_subtype).toBe('json_schema');
      expect(JSON.parse(diagnostic!.tool_error_details_json)).toMatchObject({
        validation_keyword: 'oneOf',
        validation_phase: 'build',
      });
      expect(params).toEqual({ offset: '10', value: '123' });
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('should call mcpTool.callTool with correct parameters and format display output', async () => {
      const params = { param: 'testValue' };
      const mockToolSuccessResultObject = {
        success: true,
        details: 'executed',
      };
      const mockFunctionResponseContent = [
        {
          type: 'text',
          text: JSON.stringify(mockToolSuccessResultObject),
        },
      ];
      const mockMcpToolResponseParts: Part[] = [
        {
          functionResponse: {
            name: serverToolName,
            response: { content: mockFunctionResponseContent },
          },
        },
      ];
      mockCallTool.mockResolvedValue(mockMcpToolResponseParts);

      const invocation = tool.build(params);
      const toolResult: ToolResult = await invocation.execute(
        new AbortController().signal,
      );

      expect(mockCallTool).toHaveBeenCalledWith(
        [{ name: serverToolName, args: params }],
        expect.any(AbortSignal),
      );

      const stringifiedResponseContent = JSON.stringify(
        mockToolSuccessResultObject,
      );
      expect(toolResult.llmContent).toEqual([
        { text: stringifiedResponseContent },
      ]);
      expect(toolResult.returnDisplay).toBe(stringifiedResponseContent);
      expect(toolResult.toolUseResult).toEqual([
        { type: 'text', text: stringifiedResponseContent },
      ]);
    });

    it('should keep MCP execution coercion idempotent after container parsing in validation', async () => {
      const arrayTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'integer' } },
          },
          required: ['items'],
        },
      );
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [{ type: 'text', text: 'ok' }],
        }),
      );
      const params = { items: '["1", "2"]' };

      const invocation = arrayTool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(mockCallTool).toHaveBeenCalledWith(
        [{ name: serverToolName, args: { items: [1, 2] } }],
        expect.any(AbortSignal),
      );
    });

    it('should persist large MCP content and rewrite semantic toolUseResult', async () => {
      const params = { param: 'testValue' };
      const longText = 'x'.repeat(100_000);
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [{ type: 'text', text: longText }],
        }),
      );

      const invocation = tool.build(params);
      const toolResult: ToolResult = await invocation.execute(
        new AbortController().signal,
      );
      expect(toolResult.llmContent).toEqual([
        expect.objectContaining({
          text: expect.stringContaining('OUTPUT TRUNCATED'),
        }),
      ]);
      expect(toolResult.toolUseResult).toEqual(
        expect.stringContaining('OUTPUT TRUNCATED'),
      );
      expect(toolResult.toolUseResult).not.toContain(longText);
    });

    it('should handle empty MCP result without persisting raw response as toolUseResult', async () => {
      const params = { param: 'testValue' };
      const mockMcpToolResponsePartsEmpty: Part[] = [];
      mockCallTool.mockResolvedValue(mockMcpToolResponsePartsEmpty);
      const invocation = tool.build(params);
      const toolResult: ToolResult = await invocation.execute(
        new AbortController().signal,
      );
      expect(toolResult.returnDisplay).toBe('```json\n[]\n```');
      expect(toolResult.llmContent).toEqual([
        { text: '[Error: Could not parse tool response]' },
      ]);
      expect(toolResult.toolUseResult).toBe(
        '[Error: Could not parse tool response]',
      );
    });

    it('should keep a valid empty result semantic while deferring model sentinel mapping', async () => {
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, { content: [] }),
      );

      const result = await tool
        .build({ param: 'empty' })
        .execute(new AbortController().signal);

      expect(result.toolUseResult).toEqual([]);
      expect(result.llmContent).toBe('');
      expect(result.isError).toBeUndefined();
    });

    it.each([
      [
        'RPC error',
        new McpError(ErrorCode.InternalError, 'RPC failed'),
        'transport_error',
      ],
      [
        'disconnect',
        new McpError(ErrorCode.ConnectionClosed, 'Connection closed'),
        'transport_error',
      ],
      [
        'SDK timeout',
        new McpError(ErrorCode.RequestTimeout, 'Request timed out'),
        'timeout',
      ],
    ] as const)(
      'normalizes %s as an execution failure without a business envelope',
      async (_label, error, outcome) => {
        const params = { param: 'failCase' };
        mockCallTool.mockRejectedValue(error);

        const invocation = tool.build(params);
        const result = await invocation.execute(new AbortController().signal);
        expect(result.error).toEqual({
          type: ToolErrorType.MCP_TOOL_ERROR,
          message: error.message,
        });
        expect(result.llmContent).toBe(error.message);
        expect(result.returnDisplay).toBe(error.message);
        expect(result.data).toMatchObject({
          mcp_operation_outcome: outcome,
          mcp_server_responded: false,
          mcp_error: {
            errorCode: String(error.code),
            errorMessage: error.message,
          },
        });
        expect(result.isError).toBeUndefined();
        expect(result.mcpResult).toBeUndefined();
        expect(mockCallTool).toHaveBeenCalledTimes(1);
      },
    );

    it('preserves cause diagnostics and recognizes wrapped transport timeouts', async () => {
      const cause = Object.assign(new Error('socket timed out'), {
        code: 'ETIMEDOUT',
      });
      mockCallTool.mockRejectedValue(new Error('fetch failed', { cause }));
      const result = await tool
        .build({ param: 'failCase' })
        .execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.MCP_TOOL_ERROR);
      expect(result.error?.message).toContain('fetch failed');
      expect(result.error?.message).toContain('socket timed out');
      expect(result.error?.message).toContain('ETIMEDOUT');
      expect(result.data).toMatchObject({
        mcp_operation_outcome: 'timeout',
        mcp_error: {
          errorCauseMessage: 'socket timed out',
          errorCauseCode: 'ETIMEDOUT',
        },
      });
    });

    it.each([
      { isErrorValue: true, description: 'true (bool)' },
      { isErrorValue: 'true', description: '"true" (str)' },
    ])(
      'should mark ToolResult.isError when MCP tool reports a nested error.isError',
      async ({ isErrorValue }) => {
        const tool = new DiscoveredMCPTool(
          mockCallableToolInstance,
          serverName,
          serverToolName,
          baseDescription,
          inputSchema,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
        );
        const params = { param: 'isErrorTrueCase' };

        const errorResponse = { isError: isErrorValue };
        const mockMcpToolResponseParts: Part[] = [
          {
            functionResponse: {
              name: serverToolName,
              response: { error: errorResponse },
            },
          },
        ];
        mockCallTool.mockResolvedValue(mockMcpToolResponseParts);
        const invocation = tool.build(params);
        const result = await invocation.execute(new AbortController().signal);

        expect(result.error).toBeUndefined();
        expect(result.isError).toBe(true);
      },
    );

    it('should mark ToolResult.isError when MCP tool reports a top-level isError (spec compliant)', async () => {
      const tool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      const params = { param: 'isErrorTopLevelCase' };

      // Spec compliant error response: { isError: true } at the top level
      // along with handler-supplied content that must reach the model.
      const handlerErrorText = 'INVALID_FORMAT: email failed validation';
      const errorResponse = {
        isError: true,
        content: [{ type: 'text', text: handlerErrorText }],
      };
      const mockMcpToolResponseParts: Part[] = [
        {
          functionResponse: {
            name: serverToolName,
            response: errorResponse,
          },
        },
      ];
      mockCallTool.mockResolvedValue(mockMcpToolResponseParts);
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.error).toBeUndefined();
      expect(result.isError).toBe(true);
      expect(result.llmContent).toEqual([{ text: handlerErrorText }]);
    });

    it('should surface legacy nested error.message when content array is missing', async () => {
      const params = { param: 'legacyErrorCase' };
      const errorMessage = 'MCP server "howtocook" tool timed out after 30s';
      const mockMcpToolResponseParts: Part[] = [
        {
          functionResponse: {
            name: serverToolName,
            response: {
              error: {
                message: errorMessage,
                isError: true,
              },
            },
          },
        },
      ];
      mockCallTool.mockResolvedValue(mockMcpToolResponseParts);
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.isError).toBe(true);
      expect(result.llmContent).toEqual([{ text: errorMessage }]);
      expect(result.returnDisplay).toBe(errorMessage);
      expect(result.mcpResult).toEqual({
        content: [{ type: 'text', text: errorMessage }],
        isError: true,
      });
    });

    it.each([
      { isErrorValue: false, description: 'false (bool)' },
      { isErrorValue: 'false', description: '"false" (str)' },
    ])(
      'should consider a ToolResult with isError ${description} to be a success',
      async ({ isErrorValue }) => {
        const tool = new DiscoveredMCPTool(
          mockCallableToolInstance,
          serverName,
          serverToolName,
          baseDescription,
          inputSchema,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
        );
        const params = { param: 'isErrorFalseCase' };
        const mockToolSuccessResultObject = {
          success: true,
          details: 'executed',
        };
        const mockFunctionResponseContent = [
          {
            type: 'text',
            text: JSON.stringify(mockToolSuccessResultObject),
          },
        ];

        const errorResponse = { isError: isErrorValue };
        const mockMcpToolResponseParts: Part[] = [
          {
            functionResponse: {
              name: serverToolName,
              response: {
                error: errorResponse,
                content: mockFunctionResponseContent,
              },
            },
          },
        ];
        mockCallTool.mockResolvedValue(mockMcpToolResponseParts);

        const invocation = tool.build(params);
        const toolResult = await invocation.execute(
          new AbortController().signal,
        );

        const stringifiedResponseContent = JSON.stringify(
          mockToolSuccessResultObject,
        );
        expect(toolResult.llmContent).toEqual([
          { text: stringifiedResponseContent },
        ]);
        expect(toolResult.returnDisplay).toBe(stringifiedResponseContent);
      },
    );

    it('should handle a simple text response correctly', async () => {
      const params = { param: 'test' };
      const successMessage = 'This is a success message.';

      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [{ type: 'text', text: successMessage }],
        }),
      );

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      // 1. Assert that the llmContent sent to the scheduler is a clean Part array.
      expect(toolResult.llmContent).toEqual([{ text: successMessage }]);

      // 2. Assert that the display output is the simple text message.
      expect(toolResult.returnDisplay).toBe(successMessage);

      // 3. Verify that the underlying callTool was made correctly.
      expect(mockCallTool).toHaveBeenCalledWith(
        [{ name: serverToolName, args: params }],
        expect.any(AbortSignal),
      );
    });

    it('should preserve MCP metadata separately from semantic and model content', async () => {
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            {
              type: 'text',
              text: 'semantic text',
              _meta: { blockMarker: 'block-meta' },
              annotations: { audience: ['assistant'] },
            },
          ],
          _meta: { appMarker: 'top-meta' },
        }),
      );

      const result = await tool
        .build({ param: 'metadata' })
        .execute(new AbortController().signal);

      expect(result.toolUseResult).toEqual([
        {
          type: 'text',
          text: 'semantic text',
          _meta: { blockMarker: 'block-meta' },
        },
      ]);
      expect(result.mcpMeta).toEqual({ _meta: { appMarker: 'top-meta' } });
      expect(result.llmContent).toEqual([{ text: 'semantic text' }]);
    });

    it('should prefer structuredContent for a text-only successful result', async () => {
      const structuredContent = { rows: [{ id: 1, label: 'first' }] };
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [{ type: 'text', text: 'server display fallback' }],
          structuredContent,
          _meta: { ui: { resourceUri: 'ui://example/app' } },
        }),
      );

      const result = await tool
        .build({ param: 'structured' })
        .execute(new AbortController().signal);
      const structuredJson = JSON.stringify(structuredContent);

      expect(result.mcpResult).toEqual({
        content: [{ type: 'text', text: 'server display fallback' }],
        structuredContent,
        isError: false,
      });
      expect(result.toolUseResult).toBe(structuredJson);
      expect(result.mcpMeta).toEqual({
        _meta: { ui: { resourceUri: 'ui://example/app' } },
        structuredContent,
      });
      expect(result.llmContent).toEqual([{ text: structuredJson }]);
    });

    it('preserves structured server errors for programmatic consumers', async () => {
      const content = [{ type: 'text', text: 'Invalid project' }];
      const structuredContent = { code: 'PROJECT_MISSING', retryable: false };
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content,
          structuredContent,
          isError: true,
        }),
      );
      const result = await tool
        .build({ param: 'error' })
        .execute(new AbortController().signal);
      expect(result.mcpResult).toEqual({
        content,
        structuredContent,
        isError: true,
      });
      expect(result.isError).toBe(true);
    });

    it('should rewrite a large structured result while preserving MCP metadata', async () => {
      const structuredContent = { dsl: 'x'.repeat(100_000) };
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [{ type: 'text', text: 'server display fallback' }],
          structuredContent,
        }),
      );

      const result = await tool
        .build({ param: 'large-structured' })
        .execute(new AbortController().signal);

      expect(result.toolUseResult).toEqual(
        expect.stringContaining('OUTPUT TRUNCATED'),
      );
      expect(result.mcpMeta?.structuredContent).toBe(structuredContent);
    });

    it('should keep non-text semantic blocks before structuredContent JSON', async () => {
      const structuredContent = { chart: { points: [1, 2] } };
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            { type: 'text', text: 'discarded text fallback' },
            {
              type: 'image',
              data: Buffer.from('image data').toString('base64'),
              mimeType: 'image/png',
            },
          ],
          structuredContent,
        }),
      );

      const result = await tool
        .build({ param: 'mixed-structured' })
        .execute(new AbortController().signal);
      const structuredJson = JSON.stringify(structuredContent);

      expect(result.toolUseResult).toEqual([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'PROCESSED_IMAGE_DATA',
          },
        },
        { type: 'text', text: structuredJson },
      ]);
      expect(result.llmContent).toEqual([
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'PROCESSED_IMAGE_DATA',
          },
        },
        { text: structuredJson },
      ]);
      expect(JSON.stringify(result.toolUseResult)).not.toContain(
        'discarded text fallback',
      );
    });

    it('should handle an AudioBlock response', async () => {
      const params = { param: 'play' };
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            {
              type: 'audio',
              data: 'BASE64_AUDIO_DATA',
              mimeType: 'audio/mp3',
            },
          ],
        }),
      );

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(toolResult.llmContent).toEqual([
        {
          text: expect.stringMatching(
            /^\[Audio from mock-mcp-server\] Binary content \(audio\/mp3, 12 bytes\) saved to /,
          ),
        },
      ]);
      expect(toolResult.newMessages).toBeUndefined();
      expect(toolResult.toolUseResult).toEqual([
        {
          type: 'text',
          text: expect.stringContaining('saved to '),
        },
      ]);
      expect(toolResult.returnDisplay).toBe('[Audio: audio/mp3]');
    });

    it('should persist oversized audio instead of routing it through image compression', async () => {
      const params = { param: 'play' };
      const oversizedAudio = 'A'.repeat(1_500_000);
      const slug = process.env['BRAND_TEMP_PATH_SLUG'] || 'qwen-code';
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            {
              type: 'audio',
              data: oversizedAudio,
              mimeType: 'audio/mp3',
            },
          ],
        }),
      );

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(processImageBufferWithTokenBudget).not.toHaveBeenCalled();
      expect(toolResult.newMessages).toBeUndefined();
      expect(toolResult.llmContent).toEqual([
        {
          text: expect.stringContaining(
            '[Audio from mock-mcp-server] Binary content (audio/mp3, 1125000 bytes) saved to ' +
              path.join(os.tmpdir(), `${slug}-mcp-blobs`, path.sep),
          ),
        },
      ]);
      expect(JSON.stringify(toolResult.toolUseResult)).toContain('saved to ');
      expect(toolResult.returnDisplay).toBe('[Audio: audio/mp3]');
    });

    it('should keep a pure image response in llmContent without text truncation', async () => {
      const params = { param: 'show' };
      const largeBase64Image = 'A'.repeat(300_000);
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            {
              type: 'image',
              data: largeBase64Image,
              mimeType: 'image/png',
            },
          ],
        }),
      );

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(processImageBufferWithTokenBudget).toHaveBeenCalled();
      expect(toolResult.llmContent).toEqual([
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'PROCESSED_IMAGE_DATA',
          },
        },
      ]);
      expect(JSON.stringify(toolResult.llmContent)).not.toContain(
        'OUTPUT TRUNCATED',
      );
      expect(toolResult.newMessages).toBeUndefined();
    });

    it('should normalize interoperable MCP image base64 before processing', async () => {
      const params = { param: 'show' };
      const imageBytes = Buffer.from([0xfb, 0xff, 0x00, 0x7f]);
      const base64url = imageBytes.toString('base64url');
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            {
              type: 'image',
              data: ` ${base64url.slice(0, 3)}\n${base64url.slice(3)} `,
              mimeType: 'image/png',
            },
          ],
        }),
      );

      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(processImageBufferWithTokenBudget).toHaveBeenCalledWith(
        imageBytes,
        expect.objectContaining({ originalMediaType: 'image/png' }),
      );
    });

    it('should downgrade invalid image data to text instead of sending raw inlineData', async () => {
      vi.mocked(processImageBufferWithTokenBudget).mockRejectedValueOnce(
        new Error('Invalid or unsupported image data'),
      );
      const params = { param: 'show' };
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            {
              type: 'image',
              data: Buffer.from('not an image').toString('base64'),
              mimeType: 'image/png',
            },
          ],
        }),
      );

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(processImageBufferWithTokenBudget).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ originalMediaType: 'image/png' }),
      );
      expect(toolResult.newMessages).toBeUndefined();
      expect(toolResult.llmContent).toEqual([
        {
          text: expect.stringContaining('could not be processed:'),
        },
      ]);
      expect(JSON.stringify(toolResult.llmContent)).not.toContain('inlineData');
      expect(JSON.stringify(toolResult.llmContent)).not.toContain(
        Buffer.from('not an image').toString('base64'),
      );
    });

    it('should handle a ResourceLinkBlock response', async () => {
      const params = { param: 'get' };
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            {
              type: 'resource_link',
              uri: 'file:///path/to/thing',
              name: 'resource-name',
              title: 'My Resource',
            },
          ],
        }),
      );

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(toolResult.llmContent).toEqual([
        {
          text: '[Resource link: My Resource] file:///path/to/thing',
        },
      ]);
      expect(toolResult.returnDisplay).toBe(
        '[Link to My Resource: file:///path/to/thing]',
      );
    });

    it('should handle an embedded text ResourceBlock response', async () => {
      const params = { param: 'get' };
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            {
              type: 'resource',
              resource: {
                uri: 'file:///path/to/text.txt',
                text: 'This is the text content.',
                mimeType: 'text/plain',
              },
            },
          ],
        }),
      );

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(toolResult.llmContent).toEqual([
        {
          text: '[Resource from mock-mcp-server at file:///path/to/text.txt] This is the text content.',
        },
      ]);
      expect(toolResult.returnDisplay).toBe('This is the text content.');
    });

    it('should handle an embedded binary ResourceBlock response', async () => {
      const params = { param: 'get' };
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            {
              type: 'resource',
              resource: {
                uri: 'file:///path/to/data.bin',
                blob: 'BASE64_BINARY_DATA',
                mimeType: 'application/octet-stream',
              },
            },
          ],
        }),
      );

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(toolResult.llmContent).toEqual([
        {
          text: expect.stringContaining(
            '[Resource from mock-mcp-server at file:///path/to/data.bin] Binary content (application/octet-stream, 13 bytes) saved to ',
          ),
        },
      ]);
      expect(toolResult.newMessages).toBeUndefined();
      expect(toolResult.returnDisplay).toBe(
        '[Embedded Resource: application/octet-stream]',
      );
    });

    it('should process image ResourceBlock blobs with the image budget path', async () => {
      const params = { param: 'get' };
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            {
              type: 'resource',
              resource: {
                uri: 'file:///path/to/image.png',
                blob: Buffer.from('resource image data').toString('base64'),
                mimeType: 'image/png',
              },
            },
          ],
        }),
      );

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(processImageBufferWithTokenBudget).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          maxTokens: expect.any(Number),
          originalMediaType: 'image/png',
        }),
      );
      expect(toolResult.llmContent).toEqual([
        {
          text: '[Resource from mock-mcp-server at file:///path/to/image.png]',
        },
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'PROCESSED_IMAGE_DATA',
          },
        },
      ]);
      expect(toolResult.newMessages).toBeUndefined();
    });

    it('should handle a mix of content block types', async () => {
      const params = { param: 'complex' };
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            { type: 'text', text: 'First part.' },
            {
              type: 'image',
              data: Buffer.from('image data').toString('base64'),
              mimeType: 'image/jpeg',
            },
            { type: 'text', text: 'Second part.' },
          ],
        }),
      );

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(toolResult.llmContent).toEqual([
        { text: 'First part.' },
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: 'PROCESSED_IMAGE_DATA',
          },
        },
        { text: 'Second part.' },
      ]);
      expect(toolResult.newMessages).toBeUndefined();
      expect(toolResult.returnDisplay).toBe(
        'First part.\n[Image: image/jpeg]\nSecond part.',
      );
    });

    it('should truncate huge text while preserving the image in llmContent', async () => {
      const params = { param: 'complex' };
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            { type: 'text', text: 'x'.repeat(100_000) },
            {
              type: 'image',
              data: Buffer.from('image data').toString('base64'),
              mimeType: 'image/jpeg',
            },
          ],
        }),
      );

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(toolResult.llmContent).toEqual([
        { text: 'x'.repeat(2000) },
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: 'PROCESSED_IMAGE_DATA',
          },
        },
        expect.objectContaining({
          text: expect.stringContaining('OUTPUT TRUNCATED'),
        }),
      ]);
      expect(toolResult.newMessages).toBeUndefined();
      expect(toolResult.toolUseResult).toEqual([
        { type: 'text', text: 'x'.repeat(2000) },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: 'PROCESSED_IMAGE_DATA',
          },
        },
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('OUTPUT TRUNCATED'),
        }),
      ]);
    });

    it('should preserve interleaved image positions when MCP text is truncated', async () => {
      const params = { param: 'interleaved' };
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            { type: 'text', text: 'before-first-image' },
            {
              type: 'image',
              data: Buffer.from('first image data').toString('base64'),
              mimeType: 'image/png',
            },
            { type: 'text', text: 'between-images' },
            {
              type: 'image',
              data: Buffer.from('second image data').toString('base64'),
              mimeType: 'image/jpeg',
            },
            { type: 'text', text: 'x'.repeat(100_000) },
          ],
        }),
      );

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);
      const content = toolResult.llmContent as Part[];
      const firstTextIndex = content.findIndex(
        (part) => part.text === 'before-first-image',
      );
      const betweenTextIndex = content.findIndex(
        (part) => part.text === 'between-images',
      );
      const imageIndexes = content
        .map((part, index) => (part.inlineData ? index : -1))
        .filter((index) => index >= 0);

      expect(imageIndexes).toHaveLength(2);
      expect(firstTextIndex).toBeLessThan(imageIndexes[0]);
      expect(imageIndexes[0]).toBeLessThan(betweenTextIndex);
      expect(betweenTextIndex).toBeLessThan(imageIndexes[1]);
      expect(content.at(-1)?.text).toContain('OUTPUT TRUNCATED');
      expect(toolResult.newMessages).toBeUndefined();
    });

    it('should ignore unknown content block types', async () => {
      const params = { param: 'test' };
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            { type: 'text', text: 'Valid part.' },
            { type: 'future_block', data: 'some-data' },
          ],
        }),
      );

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(toolResult.llmContent).toEqual([{ text: 'Valid part.' }]);
      expect(toolResult.returnDisplay).toBe(
        'Valid part.\n[Unknown content type: future_block]',
      );
    });

    it('should handle a complex mix of content block types', async () => {
      const params = { param: 'super-complex' };
      mockCallTool.mockResolvedValue(
        createSdkResponse(serverToolName, {
          content: [
            { type: 'text', text: 'Here is a resource.' },
            {
              type: 'resource_link',
              uri: 'file:///path/to/resource',
              name: 'resource-name',
              title: 'My Resource',
            },
            {
              type: 'resource',
              resource: {
                uri: 'file:///path/to/text.txt',
                text: 'Embedded text content.',
                mimeType: 'text/plain',
              },
            },
            {
              type: 'image',
              data: Buffer.from('image data').toString('base64'),
              mimeType: 'image/jpeg',
            },
          ],
        }),
      );

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(toolResult.llmContent).toEqual([
        { text: 'Here is a resource.' },
        {
          text: '[Resource link: My Resource] file:///path/to/resource',
        },
        {
          text: '[Resource from mock-mcp-server at file:///path/to/text.txt] Embedded text content.',
        },
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: 'PROCESSED_IMAGE_DATA',
          },
        },
      ]);
      expect(toolResult.newMessages).toBeUndefined();
      expect(toolResult.returnDisplay).toBe(
        'Here is a resource.\n[Link to My Resource: file:///path/to/resource]\nEmbedded text content.\n[Image: image/jpeg]',
      );
    });

    describe('AbortSignal support', () => {
      const MOCK_TOOL_DELAY = 1000;
      const ABORT_DELAY = 50;

      it('should abort immediately if signal is already aborted', async () => {
        const params = { param: 'test' };
        const controller = new AbortController();
        controller.abort();

        const invocation = tool.build(params);

        await expect(invocation.execute(controller.signal)).rejects.toThrow(
          'Tool call aborted',
        );

        // Tool should not be called if signal is already aborted
        expect(mockCallTool).not.toHaveBeenCalled();
      });

      it('should abort during tool execution', async () => {
        const params = { param: 'test' };
        const controller = new AbortController();

        // Mock a delayed response to simulate long-running tool
        mockCallTool.mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => {
                resolve([
                  {
                    functionResponse: {
                      name: serverToolName,
                      response: {
                        content: [{ type: 'text', text: 'Success' }],
                      },
                    },
                  },
                ]);
              }, MOCK_TOOL_DELAY);
            }),
        );

        const invocation = tool.build(params);
        const promise = invocation.execute(controller.signal);

        // Abort after a short delay to simulate cancellation during execution
        setTimeout(() => controller.abort(), ABORT_DELAY);

        await expect(promise).rejects.toThrow('Tool call aborted');
      });

      it('should complete successfully if not aborted', async () => {
        const params = { param: 'test' };
        const controller = new AbortController();

        mockCallTool.mockResolvedValue(
          createSdkResponse(serverToolName, {
            content: [{ type: 'text', text: 'Success' }],
          }),
        );

        const invocation = tool.build(params);
        const result = await invocation.execute(controller.signal);

        expect(result.llmContent).toEqual([{ text: 'Success' }]);
        expect(result.returnDisplay).toBe('Success');
        expect(mockCallTool).toHaveBeenCalledWith(
          [{ name: serverToolName, args: params }],
          expect.any(AbortSignal),
        );
      });

      it('should handle tool error even when abort signal is provided', async () => {
        const params = { param: 'test' };
        const controller = new AbortController();

        mockCallTool.mockResolvedValue(
          createSdkResponse(serverToolName, { error: { isError: true } }),
        );

        const invocation = tool.build(params);
        const result = await invocation.execute(controller.signal);

        expect(result.error).toBeUndefined();
        expect(result.isError).toBe(true);
      });

      it('should handle callTool rejection with abort signal', async () => {
        const params = { param: 'test' };
        const controller = new AbortController();
        const expectedError = new Error('Network error');

        mockCallTool.mockRejectedValue(expectedError);

        const invocation = tool.build(params);

        const result = await invocation.execute(controller.signal);
        expect(result.error).toEqual({
          type: ToolErrorType.MCP_TOOL_ERROR,
          message: expectedError.message,
        });
        expect(result.isError).toBeUndefined();
      });

      it.each([
        {
          name: 'successful completion',
          setup: () => {
            mockCallTool.mockResolvedValue(
              createSdkResponse(serverToolName, {
                content: [{ type: 'text', text: 'Success' }],
              }),
            );
          },
          expectError: false,
        },
        {
          name: 'error',
          setup: () => {
            mockCallTool.mockRejectedValue(new Error('Tool execution failed'));
          },
          expectError: true,
        },
      ])(
        'should cleanup event listeners properly on $name',
        async ({ setup, expectError }) => {
          const params = { param: 'test' };
          const controller = new AbortController();

          setup();

          const invocation = tool.build(params);

          const result = await invocation.execute(controller.signal);
          expect(Boolean(result.error)).toBe(expectError);

          // Verify cleanup by aborting after execution
          controller.abort();
          expect(controller.signal.aborted).toBe(true);
        },
      );
    });
  });

  describe('DiscoveredMCPToolInvocation', () => {
    it('should return the stringified params from getDescription', () => {
      const params = { param: 'testValue', param2: 'anotherOne' };
      const invocation = tool.build(params);
      const description = invocation.getDescription();
      expect(description).toBe('{"param":"testValue","param2":"anotherOne"}');
    });
  });
});

describe('MCP Tool Naming Regression Fixes', () => {
  describe('generateValidName', () => {
    it('should replace spaces with underscores', () => {
      expect(generateValidName('My Tool')).toBe('mcp__My_Tool');
    });

    it('should replace colons with underscores', () => {
      expect(generateValidName('namespace:tool')).toBe('mcp__namespace_tool');
    });

    it('should only permit [a-zA-Z0-9_-] and collapse consecutive underscores', () => {
      expect(generateValidName('valid_tool_name')).toBe('mcp__valid_tool_name');
      expect(generateValidName('alsoValid-123.name')).toBe(
        'mcp__alsoValid-123_name',
      );
      expect(generateValidName('another:valid:name')).toBe(
        'mcp__another_valid_name',
      );
    });

    it('should preserve the separator when the input is pre-joined', () => {
      // Input like `server__tool` gets normalized per-segment so the delimiter
      // is preserved.
      expect(generateValidName('server__tool')).toBe('mcp__server__tool');
    });

    it('should no longer truncate long names', () => {
      const longName = 'a'.repeat(80);
      expect(generateValidName(longName)).toBe(`mcp__${'a'.repeat(80)}`);
    });
  });

  describe('DiscoveredMCPTool qualified names', () => {
    it('should generate a valid qualified name even with spaces in server name', () => {
      const tool = new DiscoveredMCPTool(
        {} as any,
        'My Server',
        'my-tool',
        'desc',
        {},
        {} as any,
      );

      const qn = tool.getFullyQualifiedName();
      expect(qn).toBe('mcp__My_Server__my-tool');
    });

    it('should collapse consecutive invalid chars so they cannot forge the delimiter', () => {
      const tool = new DiscoveredMCPTool(
        {} as any,
        'my  server', // two spaces would naively become `__` (a false delimiter)
        'tool',
        'desc',
        {},
        {} as any,
      );

      const qn = tool.getFullyQualifiedName();
      expect(qn).toBe('mcp__my_server__tool');
    });

    it('should handle server names starting with digits', () => {
      const tool = new DiscoveredMCPTool(
        {} as any,
        '123-server',
        'tool',
        'desc',
        {},
        {} as any,
      );

      const qn = tool.getFullyQualifiedName();
      expect(qn).toBe('mcp__123-server__tool');
    });

    it('should expose mcpInfo with the original (unnormalized) names', () => {
      const tool = new DiscoveredMCPTool(
        {} as any,
        'My Server',
        'my tool',
        'desc',
        {},
        {} as any,
      );

      expect(tool.mcpInfo).toEqual({
        serverName: 'My Server',
        toolName: 'my tool',
      });
    });
  });
});
