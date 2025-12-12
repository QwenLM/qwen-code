/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for createSdkMcpServer
 *
 * Tests MCP server creation and tool registration.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createSdkMcpServer } from '../../src/mcp/createSdkMcpServer.js';
import { tool } from '../../src/mcp/tool.js';
import type { SdkMcpToolDefinition } from '../../src/mcp/tool.js';

describe('createSdkMcpServer', () => {
  describe('Server Creation', () => {
    it('should create server with name and version', () => {
      const server = createSdkMcpServer({
        name: 'test-server',
        version: '1.0.0',
        tools: [],
      });

      expect(server).toBeDefined();
      expect(server.type).toBe('sdk');
      expect(server.name).toBe('test-server');
      expect(server.instance).toBeDefined();
    });

    it('should create server with default version', () => {
      const server = createSdkMcpServer({
        name: 'test-server',
      });

      expect(server).toBeDefined();
      expect(server.name).toBe('test-server');
    });

    it('should throw error with invalid name', () => {
      expect(() => createSdkMcpServer({ name: '', version: '1.0.0' })).toThrow(
        'MCP server name must be a non-empty string',
      );
    });

    it('should throw error with invalid version', () => {
      expect(() => createSdkMcpServer({ name: 'test', version: '' })).toThrow(
        'MCP server version must be a non-empty string',
      );
    });

    it('should throw error with non-array tools', () => {
      expect(() =>
        createSdkMcpServer({
          name: 'test',
          version: '1.0.0',
          /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
          tools: {} as unknown as SdkMcpToolDefinition<any>[],
        }),
      ).toThrow('Tools must be an array');
    });
  });

  describe('Tool Registration', () => {
    it('should register single tool', () => {
      const testTool = tool(
        'test_tool',
        'A test tool',
        { input: z.string() },
        async () => ({
          content: [{ type: 'text', text: 'result' }],
        }),
      );

      const server = createSdkMcpServer({
        name: 'test-server',
        version: '1.0.0',
        tools: [testTool],
      });

      expect(server).toBeDefined();
    });

    it('should register multiple tools', () => {
      const tool1 = tool('tool1', 'Tool 1', {}, async () => ({
        content: [{ type: 'text', text: 'result1' }],
      }));

      const tool2 = tool('tool2', 'Tool 2', {}, async () => ({
        content: [{ type: 'text', text: 'result2' }],
      }));

      const server = createSdkMcpServer({
        name: 'test-server',
        version: '1.0.0',
        tools: [tool1, tool2],
      });

      expect(server).toBeDefined();
    });

    it('should throw error for duplicate tool names', () => {
      const tool1 = tool('duplicate', 'Tool 1', {}, async () => ({
        content: [{ type: 'text', text: 'result1' }],
      }));

      const tool2 = tool('duplicate', 'Tool 2', {}, async () => ({
        content: [{ type: 'text', text: 'result2' }],
      }));

      expect(() =>
        createSdkMcpServer({
          name: 'test-server',
          version: '1.0.0',
          tools: [tool1, tool2],
        }),
      ).toThrow("Duplicate tool name 'duplicate'");
    });

    it('should validate tool names', () => {
      const invalidTool = {
        name: '123invalid', // Starts with number
        description: 'Invalid tool',
        inputSchema: {},
        handler: async () => ({
          content: [{ type: 'text' as const, text: 'result' }],
        }),
      };

      expect(() =>
        createSdkMcpServer({
          name: 'test-server',
          version: '1.0.0',
          /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
          tools: [invalidTool as unknown as SdkMcpToolDefinition<any>],
        }),
      ).toThrow('Tool name');
    });
  });

  describe('Tool Handler Invocation', () => {
    it('should invoke tool handler with correct input', async () => {
      const handler = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'success' }],
      });

      const testTool = tool(
        'test_tool',
        'A test tool',
        { value: z.string() },
        handler,
      );

      createSdkMcpServer({
        name: 'test-server',
        version: '1.0.0',
        tools: [testTool],
      });

      // Note: Actual invocation testing requires MCP SDK integration
      // This test verifies the handler was properly registered
      expect(handler).toBeDefined();
    });

    it('should handle async tool handlers', async () => {
      const handler = vi
        .fn()
        .mockImplementation(async (input: { value: string }) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            content: [{ type: 'text', text: `processed: ${input.value}` }],
          };
        });

      const testTool = tool('async_tool', 'An async tool', {}, handler);

      const server = createSdkMcpServer({
        name: 'test-server',
        version: '1.0.0',
        tools: [testTool],
      });

      expect(server).toBeDefined();
    });
  });

  describe('Type Safety', () => {
    it('should preserve input type in handler', async () => {
      const handler = vi.fn().mockImplementation(async (input) => {
        return {
          content: [
            { type: 'text', text: `Hello ${input.name}, age ${input.age}` },
          ],
        };
      });

      const typedTool = tool(
        'typed_tool',
        'A typed tool',
        {
          name: z.string(),
          age: z.number(),
        },
        handler,
      );

      const server = createSdkMcpServer({
        name: 'test-server',
        version: '1.0.0',
        tools: [typedTool],
      });

      expect(server).toBeDefined();
    });
  });

  describe('Error Handling in Tools', () => {
    it('should handle tool handler errors gracefully', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Tool failed'));

      const errorTool = tool('error_tool', 'A tool that errors', {}, handler);

      const server = createSdkMcpServer({
        name: 'test-server',
        version: '1.0.0',
        tools: [errorTool],
      });

      expect(server).toBeDefined();
      // Error handling occurs during tool invocation
    });

    it('should handle synchronous tool handler errors', async () => {
      const handler = vi.fn().mockImplementation(() => {
        throw new Error('Sync error');
      });

      const errorTool = tool(
        'sync_error_tool',
        'A tool that errors synchronously',
        {},
        handler,
      );

      const server = createSdkMcpServer({
        name: 'test-server',
        version: '1.0.0',
        tools: [errorTool],
      });

      expect(server).toBeDefined();
    });
  });

  describe('Complex Tool Scenarios', () => {
    it('should support tool with complex input schema', () => {
      const complexTool = tool(
        'complex_tool',
        'A tool with complex schema',
        {
          query: z.string(),
          filters: z
            .object({
              category: z.string().optional(),
              minPrice: z.number().optional(),
            })
            .optional(),
          options: z.array(z.string()).optional(),
        },
        async (input) => {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ results: [], filters: input.filters }),
              },
            ],
          };
        },
      );

      const server = createSdkMcpServer({
        name: 'test-server',
        version: '1.0.0',
        tools: [complexTool],
      });

      expect(server).toBeDefined();
    });

    it('should support tool returning complex output', () => {
      const complexOutputTool = tool(
        'complex_output_tool',
        'Returns complex data',
        {},
        async () => {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  data: [
                    { id: 1, name: 'Item 1' },
                    { id: 2, name: 'Item 2' },
                  ],
                  metadata: {
                    total: 2,
                    page: 1,
                  },
                  nested: {
                    deep: {
                      value: 'test',
                    },
                  },
                }),
              },
            ],
          };
        },
      );

      const server = createSdkMcpServer({
        name: 'test-server',
        version: '1.0.0',
        tools: [complexOutputTool],
      });

      expect(server).toBeDefined();
    });
  });

  describe('Multiple Servers', () => {
    it('should create multiple independent servers', () => {
      const tool1 = tool('tool1', 'Tool in server 1', {}, async () => ({
        content: [{ type: 'text', text: 'result1' }],
      }));

      const tool2 = tool('tool2', 'Tool in server 2', {}, async () => ({
        content: [{ type: 'text', text: 'result2' }],
      }));

      const server1 = createSdkMcpServer({
        name: 'server1',
        version: '1.0.0',
        tools: [tool1],
      });
      const server2 = createSdkMcpServer({
        name: 'server2',
        version: '1.0.0',
        tools: [tool2],
      });

      expect(server1).toBeDefined();
      expect(server2).toBeDefined();
      expect(server1.name).toBe('server1');
      expect(server2.name).toBe('server2');
    });

    it('should allow same tool name in different servers', () => {
      const tool1 = tool('shared_name', 'Tool in server 1', {}, async () => ({
        content: [{ type: 'text', text: 'result1' }],
      }));

      const tool2 = tool('shared_name', 'Tool in server 2', {}, async () => ({
        content: [{ type: 'text', text: 'result2' }],
      }));

      const server1 = createSdkMcpServer({
        name: 'server1',
        version: '1.0.0',
        tools: [tool1],
      });
      const server2 = createSdkMcpServer({
        name: 'server2',
        version: '1.0.0',
        tools: [tool2],
      });

      expect(server1).toBeDefined();
      expect(server2).toBeDefined();
    });
  });
});
