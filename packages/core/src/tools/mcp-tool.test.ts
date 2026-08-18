/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Mocked } from 'vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import {
  DiscoveredMCPTool,
  generateValidName,
  type McpDirectClient,
  type McpToolAnnotations,
} from './mcp-tool.js';
import type { ToolResult } from './tools.js';
import { ToolConfirmationOutcome } from './tools.js';
import type { CallableTool, Part } from '@google/genai';
import { ToolErrorType } from './tool-error.js';
import {
  MCPServerStatus,
  removeMCPServerStatus,
  updateMCPServerStatus,
} from './mcp-client.js';
import {
  INVOCATION_CONTEXT_META_KEY,
  runWithInvocationContext,
  type InvocationContextV1,
} from '../utils/invocation-context.js';

vi.mock('node:fs/promises');

// Mock @google/genai mcpToTool and CallableTool
// We only need to mock the parts of CallableTool that DiscoveredMCPTool uses.
const mockCallTool = vi.fn();
const mockToolMethod = vi.fn();

const mockCallableToolInstance: Mocked<CallableTool> = {
  tool: mockToolMethod as any, // Not directly used by DiscoveredMCPTool instance methods
  callTool: mockCallTool as any,
  // Add other methods if DiscoveredMCPTool starts using them
};

describe('generateValidName', () => {
  it('should return a valid name for a simple function', () => {
    expect(generateValidName('myFunction')).toBe('myFunction');
  });

  it('should replace invalid characters with underscores', () => {
    const normalized = generateValidName('invalid-name with spaces');
    expect(normalized).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    expect(normalized).not.toBe('invalid-name with spaces');
  });

  it('should normalize dotted MCP names for strict providers', () => {
    const normalized = generateValidName(
      'mcp__zybio__literature.search_pubmed',
    );

    expect(normalized).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    expect(normalized).not.toContain('.');
    expect(normalized).toBe(
      generateValidName('mcp__zybio__literature.search_pubmed'),
    );
    expect(generateValidName(normalized)).toBe(normalized);
  });

  it('should not collide after replacing unsupported characters', () => {
    expect(generateValidName('mcp__zybio__literature.search_pubmed')).not.toBe(
      generateValidName('mcp__zybio__literature_search_pubmed'),
    );
  });

  it('should truncate long names', () => {
    const name = 'x'.repeat(80);
    const normalized = generateValidName(name);

    expect(normalized).toHaveLength(63);
    expect(normalized).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    expect(normalized).toBe(generateValidName(name));
    expect(normalized).not.toBe(generateValidName(`${name}y`));
  });

  it('should handle names with only invalid characters', () => {
    expect(generateValidName('!@#$%^&*()')).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
  });

  it('should handle names that are exactly 63 characters long', () => {
    expect(generateValidName('a'.repeat(63)).length).toBe(63);
  });

  it('should handle names that are exactly 64 characters long', () => {
    expect(generateValidName('a'.repeat(64)).length).toBe(63);
  });

  it('should handle names that are longer than 64 characters', () => {
    expect(generateValidName('a'.repeat(80)).length).toBe(63);
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

  describe('invocation context metadata', () => {
    const invocationContext: InvocationContextV1 = {
      version: 1,
      sessionId: 'session-1',
      promptId: 'prompt-1',
      originatorClientId: 'client-1',
    };

    const createDirectTool = (
      mcpClient: McpDirectClient,
      allowInvocationContext: boolean,
    ) =>
      new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        undefined,
        undefined,
        undefined,
        mcpClient,
        undefined,
        undefined,
        undefined,
        false,
        allowInvocationContext,
      );

    const successfulClient = () =>
      ({
        callTool: vi.fn<McpDirectClient['callTool']>(async () => ({
          content: [{ type: 'text', text: 'ok' }],
        })),
      }) satisfies McpDirectClient;

    it('injects trusted request metadata for an allowed stdio tool', async () => {
      const mcpClient = successfulClient();
      const modelArguments = {
        param: 'test',
        _meta: {
          [INVOCATION_CONTEXT_META_KEY]: { forged: true },
        },
      };

      await runWithInvocationContext(invocationContext, () =>
        createDirectTool(mcpClient, true)
          .build(modelArguments)
          .execute(new AbortController().signal),
      );

      expect(mcpClient.callTool).toHaveBeenCalledWith(
        {
          name: serverToolName,
          arguments: modelArguments,
          _meta: {
            [INVOCATION_CONTEXT_META_KEY]: invocationContext,
          },
        },
        expect.objectContaining({ onprogress: expect.any(Function) }),
      );
    });

    it.each([
      { allowInvocationContext: false, runWithContext: true },
      { allowInvocationContext: true, runWithContext: false },
    ])(
      'omits request metadata for $allowInvocationContext/$runWithContext',
      async ({ allowInvocationContext, runWithContext }) => {
        const mcpClient = successfulClient();
        const execute = () =>
          createDirectTool(mcpClient, allowInvocationContext)
            .build({ param: 'test' })
            .execute(new AbortController().signal);

        if (runWithContext) {
          await runWithInvocationContext(invocationContext, execute);
        } else {
          await execute();
        }

        expect(
          Object.hasOwn(
            vi.mocked(mcpClient.callTool).mock.calls[0][0],
            '_meta',
          ),
        ).toBe(false);
      },
    );

    it('preserves the policy through qualification and trust clones', async () => {
      const mcpClient = successfulClient();
      const clonedTool = createDirectTool(mcpClient, true)
        .asFullyQualifiedTool()
        .withTrust(true);

      await runWithInvocationContext(invocationContext, () =>
        clonedTool
          .build({ param: 'test' })
          .execute(new AbortController().signal),
      );

      expect(vi.mocked(mcpClient.callTool).mock.calls[0][0]._meta).toEqual({
        [INVOCATION_CONTEXT_META_KEY]: invocationContext,
      });
    });
  });

  beforeEach(() => {
    mockCallTool.mockClear();
    mockToolMethod.mockClear();
    tool = new DiscoveredMCPTool(
      mockCallableToolInstance,
      serverName,
      serverToolName,
      baseDescription,
      inputSchema,
    );
  });

  afterEach(() => {
    removeMCPServerStatus(serverName);
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should set properties correctly', () => {
      const expectedName = `mcp__${serverName}__${serverToolName}`;
      expect(tool.name).toBe(expectedName);
      expect(tool.schema.name).toBe(expectedName);
      expect(tool.schema.description).toBe(baseDescription);
      expect(tool.schema.parameters).toBeUndefined();
      expect(tool.schema.parametersJsonSchema).toEqual(inputSchema);
      expect(tool.serverToolName).toBe(serverToolName);
    });
  });

  describe('execute', () => {
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

      expect(mockCallTool).toHaveBeenCalledWith([
        { name: serverToolName, args: params },
      ]);

      const stringifiedResponseContent = JSON.stringify(
        mockToolSuccessResultObject,
      );
      expect(toolResult.llmContent).toEqual([
        { text: stringifiedResponseContent },
      ]);
      expect(toolResult.returnDisplay).toBe(stringifiedResponseContent);
    });

    it('should handle empty result from getDisplayFromParts', async () => {
      const params = { param: 'testValue' };
      const mockMcpToolResponsePartsEmpty: Part[] = [];
      mockCallTool.mockResolvedValue(mockMcpToolResponsePartsEmpty);
      const invocation = tool.build(params);
      const toolResult: ToolResult = await invocation.execute(
        new AbortController().signal,
      );
      expect(toolResult.returnDisplay).toBe(
        '[Error: Could not parse tool response]',
      );
      expect(toolResult.llmContent).toEqual([
        { text: '[Error: Could not parse tool response]' },
      ]);
    });

    it('should propagate rejection if mcpTool.callTool rejects', async () => {
      const params = { param: 'failCase' };
      const expectedError = new Error('MCP call failed');
      mockCallTool.mockRejectedValue(expectedError);

      const invocation = tool.build(params);
      await expect(
        invocation.execute(new AbortController().signal),
      ).rejects.toThrow(expectedError);
    });

    it.each([
      { isErrorValue: true, description: 'true (bool)' },
      { isErrorValue: 'true', description: '"true" (str)' },
    ])(
      'should return a structured error if MCP tool reports an error',
      async ({ isErrorValue }) => {
        const tool = new DiscoveredMCPTool(
          mockCallableToolInstance,
          serverName,
          serverToolName,
          baseDescription,
          inputSchema,
        );
        const params = { param: 'isErrorTrueCase' };
        const functionCall = {
          name: serverToolName,
          args: params,
        };

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
        const expectedErrorMessage = `MCP tool '${
          serverToolName
        }' reported tool error for function call: ${safeJsonStringify(
          functionCall,
        )} with response: ${safeJsonStringify(mockMcpToolResponseParts)}`;
        const invocation = tool.build(params);
        const result = await invocation.execute(new AbortController().signal);

        expect(result.error?.type).toBe(ToolErrorType.MCP_TOOL_ERROR);
        expect(result.llmContent).toBe(expectedErrorMessage);
        expect(result.returnDisplay).toContain(
          `Error: MCP tool '${serverToolName}' reported an error.`,
        );
      },
    );

    it('preserves typed images returned with an MCP tool error', async () => {
      const mockMcpToolResponseParts: Part[] = [
        {
          functionResponse: {
            name: serverToolName,
            response: {
              error: { isError: true },
              content: [
                { type: 'text', text: 'failure context' },
                {
                  type: 'image',
                  data: 'ERROR_IMAGE_DATA',
                  mimeType: 'image/png',
                },
              ],
            },
          },
        },
      ];
      mockCallTool.mockResolvedValue(mockMcpToolResponseParts);

      const invocation = tool.build({ param: 'error-image' });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.error?.type).toBe(ToolErrorType.MCP_TOOL_ERROR);
      expect(result.error?.message).toContain('failure context');
      expect(result.error?.message).not.toContain('ERROR_IMAGE_DATA');
      expect(result.llmContent).toEqual([
        { text: 'failure context' },
        {
          text: `[Tool '${serverToolName}' provided the following image data with mime-type: image/png]`,
        },
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'ERROR_IMAGE_DATA',
          },
        },
      ]);
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

      // Simulate the response from the GenAI SDK, which wraps the MCP
      // response in a functionResponse Part.
      const sdkResponse: Part[] = [
        {
          functionResponse: {
            name: serverToolName,
            response: {
              // The `content` array contains MCP ContentBlocks.
              content: [{ type: 'text', text: successMessage }],
            },
          },
        },
      ];
      mockCallTool.mockResolvedValue(sdkResponse);

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      // 1. Assert that the llmContent sent to the scheduler is a clean Part array.
      expect(toolResult.llmContent).toEqual([{ text: successMessage }]);

      // 2. Assert that the display output is the simple text message.
      expect(toolResult.returnDisplay).toBe(successMessage);

      // 3. Verify that the underlying callTool was made correctly.
      expect(mockCallTool).toHaveBeenCalledWith([
        { name: serverToolName, args: params },
      ]);
    });

    it('should handle an AudioBlock response', async () => {
      const params = { param: 'play' };
      const sdkResponse: Part[] = [
        {
          functionResponse: {
            name: serverToolName,
            response: {
              content: [
                {
                  type: 'audio',
                  data: 'BASE64_AUDIO_DATA',
                  mimeType: 'audio/mp3',
                },
              ],
            },
          },
        },
      ];
      mockCallTool.mockResolvedValue(sdkResponse);

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(toolResult.llmContent).toEqual([
        {
          text: `[Tool '${serverToolName}' provided the following audio data with mime-type: audio/mp3]`,
        },
        {
          inlineData: {
            mimeType: 'audio/mp3',
            data: 'BASE64_AUDIO_DATA',
          },
        },
      ]);
      expect(toolResult.returnDisplay).toBe(
        `[Tool '${serverToolName}' provided the following audio data with mime-type: audio/mp3]\n[audio/mp3]`,
      );
    });

    it('should handle a ResourceLinkBlock response', async () => {
      const params = { param: 'get' };
      const sdkResponse: Part[] = [
        {
          functionResponse: {
            name: serverToolName,
            response: {
              content: [
                {
                  type: 'resource_link',
                  uri: 'file:///path/to/thing',
                  name: 'resource-name',
                  title: 'My Resource',
                },
              ],
            },
          },
        },
      ];
      mockCallTool.mockResolvedValue(sdkResponse);

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(toolResult.llmContent).toEqual([
        {
          text: 'Resource Link: My Resource at file:///path/to/thing',
        },
      ]);
      expect(toolResult.returnDisplay).toBe(
        'Resource Link: My Resource at file:///path/to/thing',
      );
    });

    it('should handle an embedded text ResourceBlock response', async () => {
      const params = { param: 'get' };
      const sdkResponse: Part[] = [
        {
          functionResponse: {
            name: serverToolName,
            response: {
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
            },
          },
        },
      ];
      mockCallTool.mockResolvedValue(sdkResponse);

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(toolResult.llmContent).toEqual([
        { text: 'This is the text content.' },
      ]);
      expect(toolResult.returnDisplay).toBe('This is the text content.');
    });

    it('should handle an embedded binary ResourceBlock response', async () => {
      const params = { param: 'get' };
      const sdkResponse: Part[] = [
        {
          functionResponse: {
            name: serverToolName,
            response: {
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
            },
          },
        },
      ];
      mockCallTool.mockResolvedValue(sdkResponse);

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(toolResult.llmContent).toEqual([
        {
          text: `[Tool '${serverToolName}' provided the following embedded resource with mime-type: application/octet-stream]`,
        },
        {
          inlineData: {
            mimeType: 'application/octet-stream',
            data: 'BASE64_BINARY_DATA',
          },
        },
      ]);
      expect(toolResult.returnDisplay).toBe(
        `[Tool '${serverToolName}' provided the following embedded resource with mime-type: application/octet-stream]\n[application/octet-stream]`,
      );
    });

    it('should handle a mix of content block types', async () => {
      const params = { param: 'complex' };
      const sdkResponse: Part[] = [
        {
          functionResponse: {
            name: serverToolName,
            response: {
              content: [
                { type: 'text', text: 'First part.' },
                {
                  type: 'image',
                  data: 'BASE64_IMAGE_DATA',
                  mimeType: 'image/jpeg',
                },
                { type: 'text', text: 'Second part.' },
              ],
            },
          },
        },
      ];
      mockCallTool.mockResolvedValue(sdkResponse);

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(toolResult.llmContent).toEqual([
        { text: 'First part.' },
        {
          text: `[Tool '${serverToolName}' provided the following image data with mime-type: image/jpeg]`,
        },
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: 'BASE64_IMAGE_DATA',
          },
        },
        { text: 'Second part.' },
      ]);
      expect(toolResult.returnDisplay).toBe(
        `First part.\n[Tool '${serverToolName}' provided the following image data with mime-type: image/jpeg]\n[image/jpeg]\nSecond part.`,
      );
    });

    it('should ignore unknown content block types', async () => {
      const params = { param: 'test' };
      const sdkResponse: Part[] = [
        {
          functionResponse: {
            name: serverToolName,
            response: {
              content: [
                { type: 'text', text: 'Valid part.' },
                { type: 'future_block', data: 'some-data' },
              ],
            },
          },
        },
      ];
      mockCallTool.mockResolvedValue(sdkResponse);

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(toolResult.llmContent).toEqual([{ text: 'Valid part.' }]);
      expect(toolResult.returnDisplay).toBe('Valid part.');
    });

    it('should handle a complex mix of content block types', async () => {
      const params = { param: 'super-complex' };
      const sdkResponse: Part[] = [
        {
          functionResponse: {
            name: serverToolName,
            response: {
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
                  data: 'BASE64_IMAGE_DATA',
                  mimeType: 'image/jpeg',
                },
              ],
            },
          },
        },
      ];
      mockCallTool.mockResolvedValue(sdkResponse);

      const invocation = tool.build(params);
      const toolResult = await invocation.execute(new AbortController().signal);

      expect(toolResult.llmContent).toEqual([
        { text: 'Here is a resource.' },
        {
          text: 'Resource Link: My Resource at file:///path/to/resource',
        },
        { text: 'Embedded text content.' },
        {
          text: `[Tool '${serverToolName}' provided the following image data with mime-type: image/jpeg]`,
        },
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: 'BASE64_IMAGE_DATA',
          },
        },
      ]);
      expect(toolResult.returnDisplay).toBe(
        `Here is a resource.\nResource Link: My Resource at file:///path/to/resource\nEmbedded text content.\n[Tool '${serverToolName}' provided the following image data with mime-type: image/jpeg]\n[image/jpeg]`,
      );
    });

    describe('AbortSignal support', () => {
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
              }, 1000);
            }),
        );

        const invocation = tool.build(params);
        const promise = invocation.execute(controller.signal);

        // Abort after a short delay to simulate cancellation during execution
        setTimeout(() => controller.abort(), 50);

        await expect(promise).rejects.toThrow('Tool call aborted');
      });

      it('should complete successfully if not aborted', async () => {
        const params = { param: 'test' };
        const controller = new AbortController();
        const successResponse = [
          {
            functionResponse: {
              name: serverToolName,
              response: {
                content: [{ type: 'text', text: 'Success' }],
              },
            },
          },
        ];

        mockCallTool.mockResolvedValue(successResponse);

        const invocation = tool.build(params);
        const result = await invocation.execute(controller.signal);

        expect(result.llmContent).toEqual([{ text: 'Success' }]);
        expect(result.returnDisplay).toBe('Success');
        expect(mockCallTool).toHaveBeenCalledWith([
          { name: serverToolName, args: params },
        ]);
      });

      it('should handle tool error even when abort signal is provided', async () => {
        const params = { param: 'test' };
        const controller = new AbortController();
        const errorResponse = [
          {
            functionResponse: {
              name: serverToolName,
              response: { error: { isError: true } },
            },
          },
        ];

        mockCallTool.mockResolvedValue(errorResponse);

        const invocation = tool.build(params);
        const result = await invocation.execute(controller.signal);

        expect(result.error?.type).toBe(ToolErrorType.MCP_TOOL_ERROR);
        expect(result.returnDisplay).toContain(
          `Error: MCP tool '${serverToolName}' reported an error.`,
        );
      });

      it('should handle callTool rejection with abort signal', async () => {
        const params = { param: 'test' };
        const controller = new AbortController();
        const expectedError = new Error('Network error');

        mockCallTool.mockRejectedValue(expectedError);

        const invocation = tool.build(params);

        await expect(invocation.execute(controller.signal)).rejects.toThrow(
          expectedError,
        );
      });

      it('should cleanup event listeners properly on successful completion', async () => {
        const params = { param: 'test' };
        const controller = new AbortController();
        const successResponse = [
          {
            functionResponse: {
              name: serverToolName,
              response: {
                content: [{ type: 'text', text: 'Success' }],
              },
            },
          },
        ];

        mockCallTool.mockResolvedValue(successResponse);

        const invocation = tool.build(params);
        await invocation.execute(controller.signal);

        controller.abort();
        expect(controller.signal.aborted).toBe(true);
      });

      it('should cleanup event listeners properly on error', async () => {
        const params = { param: 'test' };
        const controller = new AbortController();
        const expectedError = new Error('Tool execution failed');

        mockCallTool.mockRejectedValue(expectedError);

        const invocation = tool.build(params);

        try {
          await invocation.execute(controller.signal);
        } catch (error) {
          expect(error).toBe(expectedError);
        }

        // Verify cleanup by aborting after error
        controller.abort();
        expect(controller.signal.aborted).toBe(true);
      });

      it('forwards parent abort into the combined signal passed to the direct SDK client', async () => {
        let capturedSignal: AbortSignal | undefined;
        const mockDirectCallTool = vi.fn<McpDirectClient['callTool']>(
          async (_params, options) => {
            capturedSignal = options?.signal;
            return new Promise(() => {});
          },
        );
        const directClient: McpDirectClient = {
          callTool: mockDirectCallTool,
        };

        const directTool = new DiscoveredMCPTool(
          mockCallableToolInstance,
          serverName,
          serverToolName,
          baseDescription,
          inputSchema,
          undefined,
          undefined,
          undefined,
          directClient,
        );
        const controller = new AbortController();
        const invocation = directTool.build({ param: 'test' });
        const promise = invocation.execute(controller.signal);

        await vi.waitFor(() => expect(mockDirectCallTool).toHaveBeenCalled());

        controller.abort();

        expect(capturedSignal?.aborted).toBe(true);
        await expect(promise).rejects.toThrow('Tool call aborted');
      });
    });
  });

  describe('getDefaultPermission and getConfirmationDetails', () => {
    it('should return allow when trust is true', async () => {
      const trustedTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        { isTrustedFolder: () => true } as any,
      );
      const invocation = trustedTool.build({ param: 'mock' });
      expect(await invocation.getDefaultPermission()).toBe('allow');
    });

    it('should return ask if not trusted', async () => {
      const invocation = tool.build({ param: 'mock' });
      expect(await invocation.getDefaultPermission()).toBe('ask');
    });

    it('should return confirmation details when permission is ask', async () => {
      const invocation = tool.build({ param: 'mock' });
      expect(await invocation.getDefaultPermission()).toBe('ask');
      const confirmation = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      expect(confirmation.type).toBe('mcp');
      if (confirmation.type === 'mcp') {
        expect(confirmation.serverName).toBe(serverName);
        expect(confirmation.toolName).toBe(serverToolName);
      }
    });

    it('should have onConfirm as a no-op', async () => {
      const invocation = tool.build({ param: 'mock' });
      const confirmation = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      expect(confirmation).toHaveProperty('onConfirm');
      if (
        'onConfirm' in confirmation &&
        typeof confirmation.onConfirm === 'function'
      ) {
        // onConfirm should not throw for any outcome
        await confirmation.onConfirm(
          ToolConfirmationOutcome.ProceedAlwaysProject,
        );
        await confirmation.onConfirm(ToolConfirmationOutcome.ProceedAlwaysUser);
        await confirmation.onConfirm(ToolConfirmationOutcome.Cancel);
        await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);
      }
    });

    it('should include permissionRules with mcp__server__tool format', async () => {
      const invocation = tool.build({ param: 'mock' });
      const confirmation = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      expect(confirmation.type).toBe('mcp');
      if (confirmation.type === 'mcp') {
        expect(confirmation.permissionRules).toEqual([
          `mcp__${serverName}__${serverToolName}`,
        ]);
      }
    });

    it('should use the registered provider-safe name in permission rules', async () => {
      const dottedTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        'literature.search_pubmed',
        baseDescription,
        inputSchema,
      );
      const confirmation = await dottedTool
        .build({ param: 'mock' })
        .getConfirmationDetails(new AbortController().signal);

      expect(dottedTool.name).not.toContain('.');
      expect(dottedTool.schema.name).toBe(dottedTool.name);
      expect(confirmation.type).toBe('mcp');
      if (confirmation.type === 'mcp') {
        expect(confirmation.permissionRules).toEqual([dottedTool.name]);
      }
    });
  });

  describe('getDefaultPermission with folder trust', () => {
    const mockConfig = (isTrusted: boolean | undefined) => ({
      isTrustedFolder: () => isTrusted,
    });

    it.each([
      {
        name: 'an untrusted server with readOnlyHint',
        trust: undefined,
        isTrustedFolder: true,
        readOnlyHint: true,
        expected: 'ask',
      },
      {
        name: 'a trusted server with readOnlyHint in an untrusted folder',
        trust: true,
        isTrustedFolder: false,
        readOnlyHint: true,
        expected: 'ask',
      },
      {
        name: 'a trusted server with readOnlyHint in a trusted folder',
        trust: true,
        isTrustedFolder: true,
        readOnlyHint: true,
        expected: 'allow',
      },
      {
        name: 'an untrusted server with readOnlyHint disabled',
        trust: undefined,
        isTrustedFolder: true,
        readOnlyHint: false,
        expected: 'ask',
      },
    ])('should return $expected for $name', async (testCase) => {
      const annotatedTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        testCase.trust,
        undefined,
        mockConfig(testCase.isTrustedFolder) as any,
        undefined,
        undefined,
        undefined,
        { readOnlyHint: testCase.readOnlyHint },
      );
      const invocation = annotatedTool.build({ param: 'mock' });
      expect(await invocation.getDefaultPermission()).toBe(testCase.expected);
    });

    it('should return allow when trust is true and folder is trusted', async () => {
      const trustedTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true, // trust = true
        undefined,
        mockConfig(true) as any, // isTrustedFolder = true
      );
      const invocation = trustedTool.build({ param: 'mock' });
      expect(await invocation.getDefaultPermission()).toBe('allow');
    });

    it('should return ask if trust is true but folder is not trusted', async () => {
      const trustedTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true, // trust = true
        undefined,
        mockConfig(false) as any, // isTrustedFolder = false
      );
      const invocation = trustedTool.build({ param: 'mock' });
      expect(await invocation.getDefaultPermission()).toBe('ask');
    });

    it('should return ask if trust is false, even if folder is trusted', async () => {
      const untrustedTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        false, // trust = false
        undefined,
        mockConfig(true) as any, // isTrustedFolder = true
      );
      const invocation = untrustedTool.build({ param: 'mock' });
      expect(await invocation.getDefaultPermission()).toBe('ask');
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

  describe('MCP Apps display', () => {
    const createAppTool = (
      mcpClient: McpDirectClient,
      appResourceUi?: Record<string, unknown>,
    ) =>
      new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        undefined,
        undefined,
        undefined,
        mcpClient,
        undefined,
        undefined,
        undefined,
        false,
        false,
        'ui://demo/dashboard',
        appResourceUi,
      );

    it('loads an MCP App resource without changing model-visible content', async () => {
      const mcpClient: McpDirectClient = {
        callTool: vi.fn(async () => ({
          content: [{ type: 'text', text: 'Dashboard ready' }],
          structuredContent: { revenue: 42 },
        })),
        readResource: vi.fn(async () => ({
          contents: [
            {
              uri: 'ui://demo/dashboard',
              mimeType: 'text/html;profile=mcp-app',
              text: '<main>Revenue</main>',
              _meta: {
                ui: {
                  csp: { connectDomains: ['https://api.example.com'] },
                  permissions: { clipboardWrite: {} },
                },
              },
            },
          ],
        })),
      };

      const result = await createAppTool(mcpClient)
        .build({ param: 'test' })
        .execute(new AbortController().signal);

      expect(result.llmContent).toEqual([{ text: 'Dashboard ready' }]);
      expect(result.returnDisplay).toMatchObject({
        type: 'mcp_app',
        resourceUri: 'ui://demo/dashboard',
        html: '<main>Revenue</main>',
        toolArguments: { param: 'test' },
        fallbackText: 'Dashboard ready',
        csp: { connectDomains: ['https://api.example.com'] },
        permissions: { clipboardWrite: {} },
      });
    });

    it('uses listing-level app metadata when resources/read omits content _meta', async () => {
      const mcpClient: McpDirectClient = {
        callTool: vi.fn(async () => ({
          content: [{ type: 'text', text: 'Dashboard ready' }],
        })),
        readResource: vi.fn(async () => ({
          contents: [
            {
              uri: 'ui://demo/dashboard',
              mimeType: 'text/html;profile=mcp-app',
              text: '<main>Revenue</main>',
            },
          ],
        })),
      };

      const result = await createAppTool(mcpClient, {
        csp: { connectDomains: ['https://api.example.com'] },
        permissions: { clipboardWrite: {} },
      })
        .build({ param: 'test' })
        .execute(new AbortController().signal);

      expect(result.returnDisplay).toMatchObject({
        type: 'mcp_app',
        html: '<main>Revenue</main>',
        csp: { connectDomains: ['https://api.example.com'] },
        permissions: { clipboardWrite: {} },
      });
    });

    it('lets content-level app metadata win over listing-level defaults', async () => {
      const mcpClient: McpDirectClient = {
        callTool: vi.fn(async () => ({
          content: [{ type: 'text', text: 'Dashboard ready' }],
        })),
        readResource: vi.fn(async () => ({
          contents: [
            {
              uri: 'ui://demo/dashboard',
              mimeType: 'text/html;profile=mcp-app',
              text: '<main>Revenue</main>',
              _meta: {
                ui: {
                  csp: { connectDomains: ['https://content.example.com'] },
                },
              },
            },
          ],
        })),
      };

      const result = await createAppTool(mcpClient, {
        csp: { connectDomains: ['https://listing.example.com'] },
        permissions: { clipboardWrite: {} },
      })
        .build({ param: 'test' })
        .execute(new AbortController().signal);

      expect(result.returnDisplay).toMatchObject({
        type: 'mcp_app',
        csp: { connectDomains: ['https://content.example.com'] },
      });
      expect(
        (result.returnDisplay as { permissions?: unknown }).permissions,
      ).toBeUndefined();
    });

    it('falls back to the normal tool text when the app resource is invalid', async () => {
      const mcpClient: McpDirectClient = {
        callTool: vi.fn(async () => ({
          content: [{ type: 'text', text: 'Dashboard ready' }],
        })),
        readResource: vi.fn(async () => ({
          contents: [
            {
              uri: 'ui://demo/dashboard',
              mimeType: 'text/html',
              text: '<main>Wrong MIME</main>',
            },
          ],
        })),
      };

      const result = await createAppTool(mcpClient)
        .build({ param: 'test' })
        .execute(new AbortController().signal);

      expect(result.returnDisplay).toBe('Dashboard ready');
    });

    it('keeps the tool result when aborting the optional app resource fetch', async () => {
      const controller = new AbortController();
      const mcpClient: McpDirectClient = {
        callTool: vi.fn(async () => ({
          content: [{ type: 'text', text: 'Dashboard ready' }],
        })),
        readResource: vi.fn(async () => {
          controller.abort();
          throw new DOMException('Aborted', 'AbortError');
        }),
      };

      const result = await createAppTool(mcpClient)
        .build({ param: 'test' })
        .execute(controller.signal);

      expect(result.llmContent).toEqual([{ text: 'Dashboard ready' }]);
      expect(result.returnDisplay).toBe('Dashboard ready');
    });
  });

  describe('output truncation for large MCP results', () => {
    const THRESHOLD = 1000;
    const TRUNCATE_LINES = 50;

    const mockConfigWithTruncation = {
      getTruncateToolOutputThreshold: () => THRESHOLD,
      getTruncateToolOutputLines: () => TRUNCATE_LINES,
      getUsageStatisticsEnabled: () => false,
      storage: {
        getProjectTempDir: () => '/tmp/test-project',
      },
      isTrustedFolder: () => true,
    } as any;

    it('should truncate large text results from direct client execution', async () => {
      const largeText = 'Line of text content\n'.repeat(25000); // ~525k chars, over the 500k MCP char budget
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn(async () => ({
          content: [{ type: 'text', text: largeText }],
        })),
      };

      const truncTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true, // trust
        undefined,
        mockConfigWithTruncation,
        mockMcpClient,
      );

      const invocation = truncTool.build({ param: 'test' });
      const result = await invocation.execute(new AbortController().signal);

      // The text part in llmContent should be truncated
      const textParts = (result.llmContent as Part[]).filter(
        (p: Part) => p.text,
      );
      const combinedText = textParts.map((p: Part) => p.text).join('');
      expect(combinedText.length).toBeLessThan(largeText.length);
      expect(combinedText.length).toBeLessThan(10_000);
      expect(combinedText).toContain('CONTENT TRUNCATED');
      expect(result.persistedOutputFiles).toHaveLength(1);
      expect(result.returnDisplay).toBe(
        `${largeText}\nOutput too long and was saved to:\n- ${result.persistedOutputFiles![0]}`,
      );
    });

    it('should truncate large text results from callable tool execution', async () => {
      const largeText = 'Line of text content\n'.repeat(25000);
      const mockMcpToolResponseParts: Part[] = [
        {
          functionResponse: {
            name: serverToolName,
            response: {
              content: [{ type: 'text', text: largeText }],
            },
          },
        },
      ];
      mockCallTool.mockResolvedValue(mockMcpToolResponseParts);

      const truncTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        mockConfigWithTruncation,
      );

      const invocation = truncTool.build({ param: 'test' });
      const result = await invocation.execute(new AbortController().signal);

      const textParts = (result.llmContent as Part[]).filter(
        (p: Part) => p.text,
      );
      const combinedText = textParts.map((p: Part) => p.text).join('');
      expect(combinedText.length).toBeLessThan(largeText.length);
      expect(combinedText.length).toBeLessThan(10_000);
      expect(combinedText).toContain('CONTENT TRUNCATED');
      expect(result.persistedOutputFiles).toHaveLength(1);
      expect(result.returnDisplay).toBe(
        `${largeText}\nOutput too long and was saved to:\n- ${result.persistedOutputFiles![0]}`,
      );
    });

    it('should not truncate small text results', async () => {
      const smallText = 'Small response';
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn(async () => ({
          content: [{ type: 'text', text: smallText }],
        })),
      };

      const truncTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        mockConfigWithTruncation,
        mockMcpClient,
      );

      const invocation = truncTool.build({ param: 'test' });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toEqual([{ text: smallText }]);
      expect(result.returnDisplay).not.toContain('Output too long');
    });

    it('should not truncate non-text content (images, audio)', async () => {
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn(async () => ({
          content: [
            {
              type: 'image',
              data: 'x'.repeat(5000), // large base64 data
              mimeType: 'image/png',
            },
          ],
        })),
      };

      const truncTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        mockConfigWithTruncation,
        mockMcpClient,
      );

      const invocation = truncTool.build({ param: 'test' });
      const result = await invocation.execute(new AbortController().signal);

      // Image data should not be truncated
      const inlineDataParts = (result.llmContent as Part[]).filter(
        (p: Part) => p.inlineData,
      );
      expect(inlineDataParts[0].inlineData!.data).toBe('x'.repeat(5000));
    });

    it('should truncate only text parts in mixed content', async () => {
      const largeText = 'Line of text content\n'.repeat(25000);
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn(async () => ({
          content: [
            { type: 'text', text: largeText },
            {
              type: 'image',
              data: 'IMAGE_DATA',
              mimeType: 'image/png',
            },
          ],
        })),
      };

      const truncTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        mockConfigWithTruncation,
        mockMcpClient,
      );

      const invocation = truncTool.build({ param: 'test' });
      const result = await invocation.execute(new AbortController().signal);

      const parts = result.llmContent as Part[];
      // Text should be truncated
      const textPart = parts.find(
        (p: Part) => p.text && !p.text.startsWith('[Tool'),
      );
      expect(textPart!.text!.length).toBeLessThan(largeText.length);
      expect(textPart!.text).toContain('CONTENT TRUNCATED');
      // Image should be preserved
      const imagePart = parts.find((p: Part) => p.inlineData);
      expect(imagePart!.inlineData!.data).toBe('IMAGE_DATA');
    });

    it('should not truncate when config is not provided', async () => {
      const largeText = 'Line of text content\n'.repeat(200);
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn(async () => ({
          content: [{ type: 'text', text: largeText }],
        })),
      };

      // No cliConfig provided
      const truncTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        undefined,
        undefined,
        undefined, // no config
        mockMcpClient,
      );

      const invocation = truncTool.build({ param: 'test' });
      const result = await invocation.execute(new AbortController().signal);

      // Without config, should return untouched
      expect(result.llmContent).toEqual([{ text: largeText }]);
    });
  });

  describe('streaming progress for long-running MCP tools', () => {
    it('should have canUpdateOutput set to true so the scheduler creates liveOutputCallback', () => {
      // For long-running MCP tools (e.g., browseruse), the scheduler needs
      // canUpdateOutput=true to create a liveOutputCallback. Without this,
      // users see no progress during potentially minutes-long operations.
      expect(tool.canUpdateOutput).toBe(true);
    });

    it('should forward MCP progress notifications to updateOutput callback during execution', async () => {
      const params = { param: 'https://example.com' };

      // Create a mock MCP direct client that simulates progress notifications.
      // When callTool is called with an onprogress callback, it invokes
      // the callback to simulate the MCP server sending progress updates.
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn(async (_params, options) => {
          // Simulate 3 progress notifications from the MCP server
          for (let i = 1; i <= 3; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            options?.onprogress?.({
              progress: i,
              total: 3,
              message: `Step ${i} of 3`,
            });
          }
          return {
            content: [
              {
                type: 'text',
                text: 'Browser automation completed successfully.',
              },
            ],
          };
        }),
      };

      // Create a tool with the direct MCP client
      const streamingTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        undefined, // trust
        undefined, // nameOverride
        undefined, // cliConfig
        mockMcpClient,
      );

      const invocation = streamingTool.build(params);
      const updateOutputSpy = vi.fn();

      const result = await invocation.execute(
        new AbortController().signal,
        updateOutputSpy,
      );

      // The final result should still be correct
      expect(result.llmContent).toEqual([
        { text: 'Browser automation completed successfully.' },
      ]);

      // The updateOutput callback SHOULD have been called at least once
      // with intermediate progress, so users can see what's happening
      // during the long wait.
      expect(updateOutputSpy).toHaveBeenCalled();
      expect(updateOutputSpy).toHaveBeenCalledTimes(3);
      // Verify progress data contains structured MCP progress info
      expect(updateOutputSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mcp_tool_progress',
          progress: 1,
          total: 3,
          message: 'Step 1 of 3',
        }),
      );
      expect(updateOutputSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mcp_tool_progress',
          progress: 3,
          total: 3,
          message: 'Step 3 of 3',
        }),
      );
    });

    it('should show incremental progress for multi-step browser automation', async () => {
      const params = { param: 'fill-form' };
      const steps = [
        'Navigating to page...',
        'Filling username field...',
        'Filling password field...',
        'Clicking submit...',
      ];

      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn(async (_params, options) => {
          for (let i = 0; i < steps.length; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            options?.onprogress?.({
              progress: i + 1,
              total: steps.length,
              message: steps[i],
            });
          }
          return {
            content: [{ type: 'text', text: steps.join('\n') }],
          };
        }),
      };

      const streamingTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        undefined,
        undefined,
        undefined,
        mockMcpClient,
      );

      const invocation = streamingTool.build(params);
      const receivedUpdates: unknown[] = [];
      const updateOutputCallback = (output: unknown) => {
        receivedUpdates.push(output);
      };

      await invocation.execute(
        new AbortController().signal,
        updateOutputCallback,
      );

      // User should have received one update per step
      expect(receivedUpdates.length).toBeGreaterThan(0);
      expect(receivedUpdates).toHaveLength(steps.length);
      // Each update should be structured McpToolProgressData
      expect(receivedUpdates[0]).toEqual({
        type: 'mcp_tool_progress',
        progress: 1,
        total: steps.length,
        message: 'Navigating to page...',
      });
      expect(receivedUpdates[3]).toEqual({
        type: 'mcp_tool_progress',
        progress: 4,
        total: steps.length,
        message: 'Clicking submit...',
      });
    });
  });

  describe('auto-reconnect on connection error', () => {
    const idempotentAnnotations = { idempotentHint: true } as const;
    const readOnlyAnnotations = { readOnlyHint: true } as const;
    const unsafeReplayErrorMessage =
      'MCP tool execution may have completed before the connection failed. Automatic replay was skipped because the call could not be verified as safe to replay. Do not retry automatically; verify the outcome before trying again.';

    it('should attempt reconnect and retry on connection error', async () => {
      const params = { param: 'test' };
      const reconnectServerToolName = 'literature.search_pubmed';
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn(),
      };

      const successResult = {
        content: [{ type: 'text', text: 'Success after reconnect' }],
      };

      const newMockMcpClient: McpDirectClient = {
        callTool: vi.fn().mockResolvedValueOnce(successResult),
      };

      const newTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        reconnectServerToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        undefined,
        newMockMcpClient,
        undefined,
        undefined,
        idempotentAnnotations,
      );

      const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
      const ensureTool = vi.fn().mockResolvedValue(newTool);
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolRegistry: () => ({
          discoverToolsForServer,
          ensureTool,
        }),
        getTruncateToolOutputThreshold: () => 0,
        getTruncateToolOutputLines: () => 0,
      };

      const connectionError = new Error('Connection closed');

      updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);
      (mockMcpClient.callTool as any).mockRejectedValueOnce(connectionError);

      const reconnectTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        reconnectServerToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        mockConfig as any,
        mockMcpClient,
        undefined,
        undefined,
        idempotentAnnotations,
      );

      const invocation = reconnectTool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(mockMcpClient.callTool).toHaveBeenCalledTimes(1);
      expect(newMockMcpClient.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).toHaveBeenCalledWith(serverName);
      expect(ensureTool).toHaveBeenCalledWith(reconnectTool.name);
      expect(result.llmContent).toEqual([{ text: 'Success after reconnect' }]);
    });

    it('does not reconnect a guarded invocation after an ambiguous connection error', async () => {
      const params = { param: 'test' };
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn().mockRejectedValueOnce(new Error('Connection closed')),
      };
      const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
      const ensureTool = vi.fn();
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolInvocationGuard: () => vi.fn(),
        getToolRegistry: () => ({
          discoverToolsForServer,
          ensureTool,
        }),
      };

      updateMCPServerStatus(serverName, MCPServerStatus.DISCONNECTED);
      const guardedTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        undefined,
        undefined,
        mockConfig as any,
        mockMcpClient,
      );

      await expect(
        guardedTool.build(params).execute(new AbortController().signal),
      ).rejects.toThrow('Connection closed');

      expect(mockMcpClient.callTool).toHaveBeenCalledOnce();
      expect(discoverToolsForServer).not.toHaveBeenCalled();
      expect(ensureTool).not.toHaveBeenCalled();
    });

    it.each<{
      name: string;
      trust: boolean;
      trustedFolderAfterReconnect: boolean;
      annotations: McpToolAnnotations | undefined;
    }>([
      {
        name: 'loses its annotations',
        trust: true,
        trustedFolderAfterReconnect: true,
        annotations: undefined,
      },
      {
        name: 'is no longer trusted',
        trust: false,
        trustedFolderAfterReconnect: true,
        annotations: idempotentAnnotations,
      },
      {
        name: 'is now in an untrusted workspace',
        trust: true,
        trustedFolderAfterReconnect: false,
        annotations: idempotentAnnotations,
      },
    ])(
      'should not replay when the re-discovered tool $name',
      async (testCase) => {
        const initialClient: McpDirectClient = {
          callTool: vi
            .fn()
            .mockRejectedValueOnce(new Error('Connection closed')),
        };
        const retryClient: McpDirectClient = {
          callTool: vi.fn().mockResolvedValueOnce({
            content: [{ type: 'text', text: 'Unexpected replay' }],
          }),
        };
        const rediscoveredTool = new DiscoveredMCPTool(
          mockCallableToolInstance,
          serverName,
          serverToolName,
          baseDescription,
          inputSchema,
          testCase.trust,
          undefined,
          undefined,
          retryClient,
          undefined,
          undefined,
          testCase.annotations,
        );
        const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
        const ensureTool = vi.fn().mockResolvedValue(rediscoveredTool);
        const isTrustedFolder = vi
          .fn()
          .mockReturnValueOnce(true)
          .mockReturnValue(testCase.trustedFolderAfterReconnect);
        const mockConfig = {
          isTrustedFolder,
          getToolRegistry: () => ({ discoverToolsForServer, ensureTool }),
        };
        const originalTool = new DiscoveredMCPTool(
          mockCallableToolInstance,
          serverName,
          serverToolName,
          baseDescription,
          inputSchema,
          true,
          undefined,
          mockConfig as any,
          initialClient,
          undefined,
          undefined,
          idempotentAnnotations,
        );

        updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);
        await expect(
          originalTool
            .build({ param: 'test' })
            .execute(new AbortController().signal),
        ).rejects.toThrow(unsafeReplayErrorMessage);

        expect(initialClient.callTool).toHaveBeenCalledTimes(1);
        expect(discoverToolsForServer).toHaveBeenCalledTimes(1);
        expect(ensureTool).toHaveBeenCalledTimes(1);
        expect(retryClient.callTool).not.toHaveBeenCalled();
      },
    );

    it('should reconnect consistent read-only calls through the callable fallback', async () => {
      const initialCallable = {
        tool: vi.fn(),
        callTool: vi.fn().mockRejectedValueOnce(new Error('Connection closed')),
      } as unknown as Mocked<CallableTool>;
      const retryCallable = {
        tool: vi.fn(),
        callTool: vi.fn().mockResolvedValueOnce([
          {
            functionResponse: {
              name: serverToolName,
              response: { content: [{ type: 'text', text: 'OK' }] },
            },
          },
        ]),
      } as unknown as Mocked<CallableTool>;
      const retryTool = new DiscoveredMCPTool(
        retryCallable,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        readOnlyAnnotations,
      );
      const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolRegistry: () => ({
          discoverToolsForServer,
          ensureTool: vi.fn().mockResolvedValue(retryTool),
        }),
        getTruncateToolOutputThreshold: () => 0,
        getTruncateToolOutputLines: () => 0,
      };
      const reconnectTool = new DiscoveredMCPTool(
        initialCallable,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        mockConfig as any,
        undefined,
        undefined,
        undefined,
        readOnlyAnnotations,
      );

      updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);
      const result = await reconnectTool
        .build({ param: 'test' })
        .execute(new AbortController().signal);

      expect(initialCallable.callTool).toHaveBeenCalledTimes(1);
      expect(retryCallable.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).toHaveBeenCalledTimes(1);
      expect(result.llmContent).toEqual([{ text: 'OK' }]);
    });

    it('should not replay unsafe calls through the callable fallback', async () => {
      const initialCallable = {
        tool: vi.fn(),
        callTool: vi.fn().mockRejectedValueOnce(new Error('Connection closed')),
      } as unknown as Mocked<CallableTool>;
      const discoverToolsForServer = vi.fn();
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolRegistry: () => ({
          discoverToolsForServer,
          ensureTool: vi.fn(),
        }),
      };
      const unsafeTool = new DiscoveredMCPTool(
        initialCallable,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        mockConfig as any,
        undefined,
        undefined,
        undefined,
        { idempotentHint: false },
      );

      updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);
      await expect(
        unsafeTool
          .build({ param: 'test' })
          .execute(new AbortController().signal),
      ).rejects.toThrow(unsafeReplayErrorMessage);

      expect(initialCallable.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).not.toHaveBeenCalled();
    });

    it.each<{
      name: string;
      trust: boolean | undefined;
      trustedFolder: boolean;
      annotations: McpToolAnnotations | undefined;
    }>([
      {
        name: 'missing annotations',
        trust: true,
        trustedFolder: true,
        annotations: undefined,
      },
      {
        name: 'explicitly non-idempotent annotations',
        trust: true,
        trustedFolder: true,
        annotations: { idempotentHint: false },
      },
      {
        name: 'conflicting read-only and destructive annotations',
        trust: true,
        trustedFolder: true,
        annotations: { readOnlyHint: true, destructiveHint: true },
      },
      {
        name: 'conflicting read-only and non-idempotent annotations',
        trust: true,
        trustedFolder: true,
        annotations: { readOnlyHint: true, idempotentHint: false },
      },
      {
        name: 'an untrusted server',
        trust: false,
        trustedFolder: true,
        annotations: idempotentAnnotations,
      },
      {
        name: 'an untrusted workspace',
        trust: true,
        trustedFolder: false,
        annotations: idempotentAnnotations,
      },
    ])('should not replay $name', async (testCase) => {
      const initialClient: McpDirectClient = {
        callTool: vi
          .fn()
          .mockRejectedValueOnce(
            new Error('Connection closed after side effect completed'),
          ),
      };
      const discoverToolsForServer = vi.fn();
      const ensureTool = vi.fn();
      const mockConfig = {
        isTrustedFolder: () => testCase.trustedFolder,
        getToolRegistry: () => ({ discoverToolsForServer, ensureTool }),
      };
      const unsafeTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        testCase.trust,
        undefined,
        mockConfig as any,
        initialClient,
        undefined,
        undefined,
        testCase.annotations,
      );

      updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);
      await expect(
        unsafeTool
          .build({ param: 'test' })
          .execute(new AbortController().signal),
      ).rejects.toThrow(unsafeReplayErrorMessage);

      expect(initialClient.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).not.toHaveBeenCalled();
      expect(ensureTool).not.toHaveBeenCalled();
    });

    it('should not retry on non-connection errors', async () => {
      const params = { param: 'test' };
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn(),
      };

      const retryClient: McpDirectClient = {
        callTool: vi
          .fn()
          .mockResolvedValueOnce({ content: [{ type: 'text', text: 'OK' }] }),
      };
      const retryTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        undefined,
        undefined,
        undefined,
        retryClient,
      );

      const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
      const ensureTool = vi.fn().mockResolvedValue(retryTool);
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolRegistry: () => ({
          discoverToolsForServer,
          ensureTool,
        }),
      };

      updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);

      const toolError = new Error('Invalid parameters');
      (mockMcpClient.callTool as any).mockRejectedValue(toolError);

      const reconnectTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        undefined,
        undefined,
        mockConfig as any,
        mockMcpClient,
      );

      const invocation = reconnectTool.build(params);
      await expect(
        invocation.execute(new AbortController().signal),
      ).rejects.toThrow('Invalid parameters');

      expect(mockMcpClient.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).not.toHaveBeenCalled();
      expect(ensureTool).not.toHaveBeenCalled();
      expect(retryClient.callTool).not.toHaveBeenCalled();
    });

    it('should not retry aborted calls even when the server is disconnected', async () => {
      const params = { param: 'test' };
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn(),
      };

      const retryClient: McpDirectClient = {
        callTool: vi
          .fn()
          .mockResolvedValueOnce({ content: [{ type: 'text', text: 'OK' }] }),
      };
      const retryTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        undefined,
        undefined,
        undefined,
        retryClient,
      );

      const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
      const ensureTool = vi.fn().mockResolvedValue(retryTool);
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolRegistry: () => ({
          discoverToolsForServer,
          ensureTool,
        }),
      };

      updateMCPServerStatus(serverName, MCPServerStatus.DISCONNECTED);
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      (mockMcpClient.callTool as any).mockRejectedValue(abortError);

      const reconnectTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        undefined,
        undefined,
        mockConfig as any,
        mockMcpClient,
      );

      const invocation = reconnectTool.build(params);
      await expect(
        invocation.execute(new AbortController().signal),
      ).rejects.toThrow('The operation was aborted');

      expect(mockMcpClient.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).not.toHaveBeenCalled();
      expect(ensureTool).not.toHaveBeenCalled();
      expect(retryClient.callTool).not.toHaveBeenCalled();
    });

    it('should not reconnect for an MCP isError result', async () => {
      const initialClient: McpDirectClient = {
        callTool: vi.fn().mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Validation failed' }],
          isError: true,
        }),
      };
      const discoverToolsForServer = vi.fn();
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolRegistry: () => ({
          discoverToolsForServer,
          ensureTool: vi.fn(),
        }),
        getTruncateToolOutputThreshold: () => 0,
        getTruncateToolOutputLines: () => 0,
      };
      const safeTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        mockConfig as any,
        initialClient,
        undefined,
        undefined,
        idempotentAnnotations,
      );

      const result = await safeTool
        .build({ param: 'test' })
        .execute(new AbortController().signal);

      expect(result.error?.type).toBe(ToolErrorType.MCP_TOOL_ERROR);
      expect(initialClient.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).not.toHaveBeenCalled();
    });

    it('should preserve the connection error when reconnect discovery fails', async () => {
      const connectionError = new Error('Connection closed');
      const initialClient: McpDirectClient = {
        callTool: vi.fn().mockRejectedValueOnce(connectionError),
      };
      const discoverToolsForServer = vi
        .fn()
        .mockRejectedValueOnce(new Error('Discovery failed'));
      const ensureTool = vi.fn();
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolRegistry: () => ({ discoverToolsForServer, ensureTool }),
      };
      const safeTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        mockConfig as any,
        initialClient,
        undefined,
        undefined,
        idempotentAnnotations,
      );

      await expect(
        safeTool.build({ param: 'test' }).execute(new AbortController().signal),
      ).rejects.toBe(connectionError);

      expect(initialClient.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).toHaveBeenCalledTimes(1);
      expect(ensureTool).not.toHaveBeenCalled();
    });

    it('should stop after the maximum reconnection retries', async () => {
      const params = { param: 'test' };
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn(),
      };

      const secondMockMcpClient: McpDirectClient = {
        callTool: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      };

      const secondTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        undefined,
        secondMockMcpClient,
        undefined,
        undefined,
        idempotentAnnotations,
      );

      const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolRegistry: () => ({
          discoverToolsForServer,
          ensureTool: vi.fn().mockResolvedValue(secondTool),
        }),
      };

      const connectionError = new Error('ECONNREFUSED');
      updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);
      (mockMcpClient.callTool as any).mockRejectedValue(connectionError);

      const reconnectTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        mockConfig as any,
        mockMcpClient,
        undefined,
        undefined,
        idempotentAnnotations,
      );

      const invocation = reconnectTool.build(params);
      await expect(
        invocation.execute(new AbortController().signal),
      ).rejects.toThrow('ECONNREFUSED');

      expect(mockMcpClient.callTool).toHaveBeenCalledTimes(1);
      expect(secondMockMcpClient.callTool).toHaveBeenCalledTimes(3);
      expect(discoverToolsForServer).toHaveBeenCalledTimes(3);
    });

    it('should detect various connection error patterns', async () => {
      const connectionErrors = [
        'ECONNREFUSED',
        'ENOTFOUND',
        'ECONNRESET',
        'ETIMEDOUT',
        'connection closed',
        'Connection lost',
        'Not connected',
        'Disconnected',
        'Transport closed',
      ];

      for (const errorMsg of connectionErrors) {
        const params = { param: 'test' };
        const mockMcpClient: McpDirectClient = {
          callTool: vi.fn().mockRejectedValueOnce(new Error(errorMsg)),
        };

        const newMockMcpClient: McpDirectClient = {
          callTool: vi
            .fn()
            .mockResolvedValueOnce({ content: [{ type: 'text', text: 'OK' }] }),
        };

        const newTool = new DiscoveredMCPTool(
          mockCallableToolInstance,
          serverName,
          serverToolName,
          baseDescription,
          inputSchema,
          true,
          undefined,
          undefined,
          newMockMcpClient,
          undefined,
          undefined,
          idempotentAnnotations,
        );

        const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
        const mockConfig = {
          isTrustedFolder: () => true,
          getToolRegistry: () => ({
            discoverToolsForServer,
            ensureTool: vi.fn().mockResolvedValue(newTool),
          }),
          getTruncateToolOutputThreshold: () => 0,
          getTruncateToolOutputLines: () => 0,
        };

        const reconnectTool = new DiscoveredMCPTool(
          mockCallableToolInstance,
          serverName,
          serverToolName,
          baseDescription,
          inputSchema,
          true,
          undefined,
          mockConfig as any,
          mockMcpClient,
          undefined,
          undefined,
          idempotentAnnotations,
        );

        const invocation = reconnectTool.build(params);
        updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);
        await invocation.execute(new AbortController().signal);

        expect(discoverToolsForServer).toHaveBeenCalled();
      }
    });

    it('should reconnect when MCP error occurs and server is disconnected', async () => {
      const params = { param: 'test' };
      const mockMcpClient: McpDirectClient = {
        callTool: vi
          .fn()
          .mockRejectedValueOnce(
            new Error('MCP error -32602: Invalid request'),
          ),
      };

      const newMockMcpClient: McpDirectClient = {
        callTool: vi
          .fn()
          .mockResolvedValueOnce({ content: [{ type: 'text', text: 'OK' }] }),
      };

      const newTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        undefined,
        newMockMcpClient,
        undefined,
        undefined,
        idempotentAnnotations,
      );

      const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolRegistry: () => ({
          discoverToolsForServer,
          ensureTool: vi.fn().mockResolvedValue(newTool),
        }),
        getTruncateToolOutputThreshold: () => 0,
        getTruncateToolOutputLines: () => 0,
      };

      updateMCPServerStatus(serverName, MCPServerStatus.DISCONNECTED);

      const reconnectTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        mockConfig as any,
        mockMcpClient,
        undefined,
        undefined,
        idempotentAnnotations,
      );

      const invocation = reconnectTool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(discoverToolsForServer).toHaveBeenCalled();
    });

    it('reconnects instead of reporting a timeout when the server is known disconnected', async () => {
      const params = { param: 'test' };
      // -32001 with a dead transport means the connection died mid-request,
      // not that the tool ran too long. Classifying it as EXECUTION_TIMEOUT
      // would strand a call the reconnect path can still recover.
      const requestTimeout = Object.assign(new Error('Request timed out'), {
        code: -32001,
      });
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn().mockRejectedValueOnce(requestTimeout),
      };
      const newMockMcpClient: McpDirectClient = {
        callTool: vi
          .fn()
          .mockResolvedValueOnce({ content: [{ type: 'text', text: 'OK' }] }),
      };
      const newTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        undefined,
        newMockMcpClient,
        undefined,
        undefined,
        idempotentAnnotations,
      );
      const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolRegistry: () => ({
          discoverToolsForServer,
          ensureTool: vi.fn().mockResolvedValue(newTool),
        }),
        getTruncateToolOutputThreshold: () => 0,
        getTruncateToolOutputLines: () => 0,
      };

      updateMCPServerStatus(serverName, MCPServerStatus.DISCONNECTED);

      const reconnectTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        mockConfig as any,
        mockMcpClient,
        undefined,
        undefined,
        idempotentAnnotations,
      );

      await reconnectTool.build(params).execute(new AbortController().signal);

      expect(discoverToolsForServer).toHaveBeenCalled();
    });

    it('still reports a timeout when the server is connected', async () => {
      const requestTimeout = Object.assign(new Error('Request timed out'), {
        code: -32001,
      });
      const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn().mockRejectedValue(requestTimeout),
      };
      const mockConfig = {
        getToolRegistry: () => ({
          discoverToolsForServer,
          ensureTool: vi.fn(),
        }),
      };

      updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);

      const tool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        undefined,
        undefined,
        mockConfig as any,
        mockMcpClient,
      );

      await expect(
        tool.build({ param: 'test' }).execute(new AbortController().signal),
      ).rejects.toMatchObject({
        errorType: ToolErrorType.EXECUTION_TIMEOUT,
      });
      expect(discoverToolsForServer).not.toHaveBeenCalled();
    });
  });

  describe('MCP Tool Idle Timeout', () => {
    it('classifies an MCP SDK request timeout without parsing its message', async () => {
      const requestTimeout = Object.assign(
        new Error('localized timeout message'),
        { code: -32001 },
      );
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn().mockRejectedValue(requestTimeout),
      };
      const tool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        undefined,
        mockMcpClient,
      );

      const executePromise = tool
        .build({ param: 'test' })
        .execute(new AbortController().signal);

      await expect(executePromise).rejects.toMatchObject({
        message: 'localized timeout message',
        errorType: ToolErrorType.EXECUTION_TIMEOUT,
      });
    });

    it('does not classify a parent abort wrapped by the MCP SDK as a timeout', async () => {
      const requestCancelled = Object.assign(new Error('Request cancelled'), {
        code: -32001,
      });
      const discoverToolsForServer = vi.fn();
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn().mockImplementation(
          (_params, options) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener(
                'abort',
                () => reject(requestCancelled),
                { once: true },
              );
            }),
        ),
      };
      const mockConfig = {
        getToolRegistry: () => ({
          discoverToolsForServer,
          ensureTool: vi.fn(),
        }),
      };
      const tool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        mockConfig as any,
        mockMcpClient,
      );
      const abortController = new AbortController();
      const executePromise = tool
        .build({ param: 'test' })
        .execute(abortController.signal);

      updateMCPServerStatus(serverName, MCPServerStatus.DISCONNECTED);
      abortController.abort();

      const rejection = await executePromise.catch((error) => error);
      expect(rejection).toMatchObject({ name: 'AbortError' });
      expect(discoverToolsForServer).not.toHaveBeenCalled();
      expect(rejection).not.toMatchObject({
        errorType: ToolErrorType.EXECUTION_TIMEOUT,
      });
    });

    it('does not classify a direct -32001 that races with a parent abort as a timeout', async () => {
      // Once the caller has cancelled, a `-32001` is indistinguishable from
      // the SDK's own abort rejection, so a timeout that settles the race
      // first must not reclassify the cancellation — the abort side wins
      // regardless of ordering (#8180 review).
      const requestTimeout = Object.assign(new Error('raced timeout'), {
        code: -32001,
      });
      let rejectRequest: ((reason?: unknown) => void) | undefined;
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn().mockReturnValue(
          new Promise((_resolve, reject) => {
            rejectRequest = reject;
          }),
        ),
      };
      const tool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        undefined,
        mockMcpClient,
      );
      const abortController = new AbortController();
      const executePromise = tool
        .build({ param: 'test' })
        .execute(abortController.signal);

      rejectRequest?.(requestTimeout);
      abortController.abort();

      await expect(executePromise).rejects.toBe(requestTimeout);
    });

    it('classifies an MCP SDK request timeout on the callable fallback', async () => {
      mockCallTool.mockRejectedValueOnce(
        Object.assign(new Error('fallback timeout'), { code: -32001 }),
      );

      const executePromise = tool
        .build({ param: 'test' })
        .execute(new AbortController().signal);

      await expect(executePromise).rejects.toMatchObject({
        message: 'fallback timeout',
        errorType: ToolErrorType.EXECUTION_TIMEOUT,
      });
    });

    it('does not classify a callable -32001 that races with a parent abort as a timeout', async () => {
      const requestTimeout = Object.assign(
        new Error('raced fallback timeout'),
        { code: -32001 },
      );
      let rejectRequest: ((reason?: unknown) => void) | undefined;
      mockCallTool.mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
      );
      const abortController = new AbortController();
      const executePromise = tool
        .build({ param: 'test' })
        .execute(abortController.signal);

      rejectRequest?.(requestTimeout);
      abortController.abort();

      await expect(executePromise).rejects.toBe(requestTimeout);
    });

    it('should abort when MCP server does not respond within idle timeout', async () => {
      vi.useFakeTimers();

      const idleTimeoutMs = 1000; // 1 second for testing
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn().mockImplementation(
          (_params, options) =>
            new Promise((_resolve, reject) => {
              // Simulate SDK behavior: reject when signal is aborted
              options?.signal?.addEventListener('abort', () => {
                const error = new Error(
                  (options?.signal as AbortSignal & { reason?: Error })?.reason
                    ?.message ?? 'The operation was aborted',
                );
                error.name = 'AbortError';
                reject(error);
              });
            }),
        ),
      };

      const tool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        undefined,
        mockMcpClient,
        undefined,
        idleTimeoutMs,
      );

      const invocation = tool.build({ param: 'test' });
      const abortController = new AbortController();
      const executePromise = invocation.execute(abortController.signal);

      // Advance time to trigger the idle timeout
      vi.advanceTimersByTime(idleTimeoutMs + 100);

      await expect(executePromise).rejects.toThrow(
        /did not respond within.*idle timeout/,
      );
      await expect(executePromise).rejects.toMatchObject({
        errorType: ToolErrorType.EXECUTION_TIMEOUT,
      });
      // The external abort signal should not have been triggered
      expect(abortController.signal.aborted).toBe(false);

      vi.useRealTimers();
    });

    it('keeps an idle timeout when the parent aborts before rejection settles', async () => {
      vi.useFakeTimers();
      try {
        const idleTimeoutMs = 1000;
        const mockMcpClient: McpDirectClient = {
          callTool: vi.fn().mockImplementation(
            (_params, options) =>
              new Promise((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => {
                  queueMicrotask(() => reject(options.signal?.reason));
                });
              }),
          ),
        };
        const tool = new DiscoveredMCPTool(
          mockCallableToolInstance,
          serverName,
          serverToolName,
          baseDescription,
          inputSchema,
          true,
          undefined,
          undefined,
          mockMcpClient,
          undefined,
          idleTimeoutMs,
        );
        const abortController = new AbortController();
        const executePromise = tool
          .build({ param: 'test' })
          .execute(abortController.signal);

        vi.advanceTimersByTime(idleTimeoutMs);
        abortController.abort();

        await expect(executePromise).rejects.toMatchObject({
          errorType: ToolErrorType.EXECUTION_TIMEOUT,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reset idle timeout on progress updates', async () => {
      vi.useFakeTimers();

      const idleTimeoutMs = 1000;
      let onProgressCallback: ((progress: any) => void) | undefined;

      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn().mockImplementation((_params, options) => {
          onProgressCallback = options?.onprogress;
          return new Promise((resolve, reject) => {
            // Listen for abort signal to properly reject when timeout fires
            options?.signal?.addEventListener('abort', () => {
              reject(options.signal!.reason);
            });
            // Resolve after 2.5 seconds (would timeout without progress)
            setTimeout(() => {
              resolve({ content: [{ type: 'text', text: 'Success' }] });
            }, 2500);
          });
        }),
      };

      const tool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        undefined,
        mockMcpClient,
        undefined,
        idleTimeoutMs,
      );

      const invocation = tool.build({ param: 'test' });
      const executePromise = invocation.execute(new AbortController().signal);

      // Send progress at 500ms, 1400ms, 2300ms to reset the timeout
      // Each progress must arrive BEFORE the 1000ms idle timeout fires
      vi.advanceTimersByTime(500);
      onProgressCallback?.({ progress: 0.25 });

      vi.advanceTimersByTime(900);
      onProgressCallback?.({ progress: 0.5 });

      vi.advanceTimersByTime(900);
      onProgressCallback?.({ progress: 0.75 });

      // Advance past the mock's 2500ms resolve time
      vi.advanceTimersByTime(200);

      const result = await executePromise;

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toBeDefined();

      vi.useRealTimers();
    });

    it('should not apply idle timeout when set to 0 or undefined', async () => {
      vi.useFakeTimers();

      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Success' }],
        }),
      };

      const tool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        undefined,
        mockMcpClient,
        undefined,
        undefined, // No idle timeout
      );

      const invocation = tool.build({ param: 'test' });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toBeDefined();

      vi.useRealTimers();
    });
  });
});
