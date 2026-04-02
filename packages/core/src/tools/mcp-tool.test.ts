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
} from './mcp-tool.js';
import type { ToolResult } from './tools.js';
import { ToolConfirmationOutcome } from './tools.js';
import type { CallableTool, Part } from '@google/genai';
import { ToolErrorType } from './tool-error.js';
import { updateMCPServerStatus, MCPServerStatus } from './mcp-client.js';

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
    expect(generateValidName('invalid-name with spaces')).toBe(
      'invalid-name_with_spaces',
    );
  });

  it('should truncate long names', () => {
    expect(generateValidName('x'.repeat(80))).toBe(
      'xxxxxxxxxxxxxxxxxxxxxxxxxxxx___xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    );
  });

  it('should handle names with only invalid characters', () => {
    expect(generateValidName('!@#$%^&*()')).toBe('__________');
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
  });

  describe('getDefaultPermission with folder trust', () => {
    const mockConfig = (isTrusted: boolean | undefined) => ({
      isTrustedFolder: () => isTrusted,
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
      const largeText = 'Line of text content\n'.repeat(200); // ~4200 chars, well over THRESHOLD
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
      expect(combinedText).toContain('CONTENT TRUNCATED');
      expect(result.returnDisplay).toContain('CONTENT TRUNCATED');
    });

    it('should truncate large text results from callable tool execution', async () => {
      const largeText = 'Line of text content\n'.repeat(200);
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
      expect(combinedText).toContain('CONTENT TRUNCATED');
      expect(result.returnDisplay).toContain('CONTENT TRUNCATED');
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
      const largeText = 'Line of text content\n'.repeat(200);
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
        callTool: vi.fn(async (_params, _schema, options) => {
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
        callTool: vi.fn(async (_params, _schema, options) => {
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
    it('should attempt reconnect and retry on connection error', async () => {
      const params = { param: 'test' };
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
        serverToolName,
        baseDescription,
        inputSchema,
        undefined,
        undefined,
        undefined,
        newMockMcpClient,
      );

      const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
      const getTool = vi.fn().mockReturnValue(newTool);
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolRegistry: () => ({
          discoverToolsForServer,
          getTool,
        }),
        getTruncateToolOutputThreshold: () => 0,
        getTruncateToolOutputLines: () => 0,
      };

      const connectionError = new Error('Connection closed');

      (mockMcpClient.callTool as any).mockRejectedValueOnce(connectionError);

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
      const result = await invocation.execute(new AbortController().signal);

      expect(mockMcpClient.callTool).toHaveBeenCalledTimes(1);
      expect(newMockMcpClient.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).toHaveBeenCalledWith(serverName);
      expect(result.llmContent).toEqual([{ text: 'Success after reconnect' }]);
    });

    it('should not retry on non-connection errors', async () => {
      const params = { param: 'test' };
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn(),
      };

      const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolRegistry: () => ({
          discoverToolsForServer,
          getTool: vi.fn().mockReturnValue(null),
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
    });

    it('should not retry after reconnection attempt fails', async () => {
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
        undefined,
        undefined,
        undefined,
        secondMockMcpClient,
      );

      const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolRegistry: () => ({
          discoverToolsForServer,
          getTool: vi.fn().mockReturnValue(secondTool),
        }),
      };

      const connectionError = new Error('ECONNREFUSED');
      (mockMcpClient.callTool as any).mockRejectedValue(connectionError);

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
          undefined,
          undefined,
          undefined,
          newMockMcpClient,
        );

        const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
        const mockConfig = {
          isTrustedFolder: () => true,
          getToolRegistry: () => ({
            discoverToolsForServer,
            getTool: vi.fn().mockReturnValue(newTool),
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
          undefined,
          undefined,
          mockConfig as any,
          mockMcpClient,
        );

        const invocation = reconnectTool.build(params);
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
        undefined,
        undefined,
        undefined,
        newMockMcpClient,
      );

      const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolRegistry: () => ({
          discoverToolsForServer,
          getTool: vi.fn().mockReturnValue(newTool),
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
        undefined,
        undefined,
        mockConfig as any,
        mockMcpClient,
      );

      const invocation = reconnectTool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(discoverToolsForServer).toHaveBeenCalled();
    });
  });
});
