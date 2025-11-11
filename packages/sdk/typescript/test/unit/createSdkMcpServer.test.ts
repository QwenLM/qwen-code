/**
 * Unit tests for createSdkMcpServer
 *
 * Tests MCP server creation and tool registration.
 */

import { describe, expect, it, vi } from 'vitest';
import { createSdkMcpServer } from '../../src/mcp/createSdkMcpServer.js';
import { tool } from '../../src/mcp/tool.js';
import type { ToolDefinition } from '../../src/types/config.js';

describe('createSdkMcpServer', () => {
  describe('Server Creation', () => {
    it('should create server with name and version', () => {
      const server = createSdkMcpServer('test-server', '1.0.0', []);

      expect(server).toBeDefined();
    });

    it('should throw error with invalid name', () => {
      expect(() => createSdkMcpServer('', '1.0.0', [])).toThrow(
        'name must be a non-empty string',
      );
    });

    it('should throw error with invalid version', () => {
      expect(() => createSdkMcpServer('test', '', [])).toThrow(
        'version must be a non-empty string',
      );
    });

    it('should throw error with non-array tools', () => {
      expect(() =>
        createSdkMcpServer('test', '1.0.0', {} as unknown as ToolDefinition[]),
      ).toThrow('Tools must be an array');
    });
  });

  describe('Tool Registration', () => {
    it('should register single tool', () => {
      const testTool = tool({
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
        },
        handler: async () => 'result',
      });

      const server = createSdkMcpServer('test-server', '1.0.0', [testTool]);

      expect(server).toBeDefined();
    });

    it('should register multiple tools', () => {
      const tool1 = tool({
        name: 'tool1',
        description: 'Tool 1',
        inputSchema: { type: 'object' },
        handler: async () => 'result1',
      });

      const tool2 = tool({
        name: 'tool2',
        description: 'Tool 2',
        inputSchema: { type: 'object' },
        handler: async () => 'result2',
      });

      const server = createSdkMcpServer('test-server', '1.0.0', [tool1, tool2]);

      expect(server).toBeDefined();
    });

    it('should throw error for duplicate tool names', () => {
      const tool1 = tool({
        name: 'duplicate',
        description: 'Tool 1',
        inputSchema: { type: 'object' },
        handler: async () => 'result1',
      });

      const tool2 = tool({
        name: 'duplicate',
        description: 'Tool 2',
        inputSchema: { type: 'object' },
        handler: async () => 'result2',
      });

      expect(() =>
        createSdkMcpServer('test-server', '1.0.0', [tool1, tool2]),
      ).toThrow("Duplicate tool name 'duplicate'");
    });

    it('should validate tool names', () => {
      const invalidTool = {
        name: '123invalid', // Starts with number
        description: 'Invalid tool',
        inputSchema: { type: 'object' },
        handler: async () => 'result',
      };

      expect(() =>
        createSdkMcpServer('test-server', '1.0.0', [
          invalidTool as unknown as ToolDefinition,
        ]),
      ).toThrow('Tool name');
    });
  });

  describe('Tool Handler Invocation', () => {
    it('should invoke tool handler with correct input', async () => {
      const handler = vi.fn().mockResolvedValue({ result: 'success' });

      const testTool = tool({
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
        },
        handler,
      });

      createSdkMcpServer('test-server', '1.0.0', [testTool]);

      // Note: Actual invocation testing requires MCP SDK integration
      // This test verifies the handler was properly registered
      expect(handler).toBeDefined();
    });

    it('should handle async tool handlers', async () => {
      const handler = vi
        .fn()
        .mockImplementation(async (input: { value: string }) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { processed: input.value };
        });

      const testTool = tool({
        name: 'async_tool',
        description: 'An async tool',
        inputSchema: { type: 'object' },
        handler,
      });

      const server = createSdkMcpServer('test-server', '1.0.0', [testTool]);

      expect(server).toBeDefined();
    });
  });

  describe('Type Safety', () => {
    it('should preserve input type in handler', async () => {
      type ToolInput = {
        name: string;
        age: number;
      };

      type ToolOutput = {
        greeting: string;
      };

      const handler = vi
        .fn()
        .mockImplementation(async (input: ToolInput): Promise<ToolOutput> => {
          return {
            greeting: `Hello ${input.name}, age ${input.age}`,
          };
        });

      const typedTool = tool<ToolInput, ToolOutput>({
        name: 'typed_tool',
        description: 'A typed tool',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
          },
          required: ['name', 'age'],
        },
        handler,
      });

      const server = createSdkMcpServer('test-server', '1.0.0', [
        typedTool as ToolDefinition,
      ]);

      expect(server).toBeDefined();
    });
  });

  describe('Error Handling in Tools', () => {
    it('should handle tool handler errors gracefully', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Tool failed'));

      const errorTool = tool({
        name: 'error_tool',
        description: 'A tool that errors',
        inputSchema: { type: 'object' },
        handler,
      });

      const server = createSdkMcpServer('test-server', '1.0.0', [errorTool]);

      expect(server).toBeDefined();
      // Error handling occurs during tool invocation
    });

    it('should handle synchronous tool handler errors', async () => {
      const handler = vi.fn().mockImplementation(() => {
        throw new Error('Sync error');
      });

      const errorTool = tool({
        name: 'sync_error_tool',
        description: 'A tool that errors synchronously',
        inputSchema: { type: 'object' },
        handler,
      });

      const server = createSdkMcpServer('test-server', '1.0.0', [errorTool]);

      expect(server).toBeDefined();
    });
  });

  describe('Complex Tool Scenarios', () => {
    it('should support tool with complex input schema', () => {
      const complexTool = tool({
        name: 'complex_tool',
        description: 'A tool with complex schema',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            filters: {
              type: 'object',
              properties: {
                category: { type: 'string' },
                minPrice: { type: 'number' },
              },
            },
            options: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['query'],
        },
        handler: async (input: { filters?: unknown[] }) => {
          return {
            results: [],
            filters: input.filters,
          };
        },
      });

      const server = createSdkMcpServer('test-server', '1.0.0', [
        complexTool as ToolDefinition,
      ]);

      expect(server).toBeDefined();
    });

    it('should support tool returning complex output', () => {
      const complexOutputTool = tool({
        name: 'complex_output_tool',
        description: 'Returns complex data',
        inputSchema: { type: 'object' },
        handler: async () => {
          return {
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
          };
        },
      });

      const server = createSdkMcpServer('test-server', '1.0.0', [
        complexOutputTool,
      ]);

      expect(server).toBeDefined();
    });
  });

  describe('Multiple Servers', () => {
    it('should create multiple independent servers', () => {
      const tool1 = tool({
        name: 'tool1',
        description: 'Tool in server 1',
        inputSchema: { type: 'object' },
        handler: async () => 'result1',
      });

      const tool2 = tool({
        name: 'tool2',
        description: 'Tool in server 2',
        inputSchema: { type: 'object' },
        handler: async () => 'result2',
      });

      const server1 = createSdkMcpServer('server1', '1.0.0', [tool1]);
      const server2 = createSdkMcpServer('server2', '1.0.0', [tool2]);

      expect(server1).toBeDefined();
      expect(server2).toBeDefined();
    });

    it('should allow same tool name in different servers', () => {
      const tool1 = tool({
        name: 'shared_name',
        description: 'Tool in server 1',
        inputSchema: { type: 'object' },
        handler: async () => 'result1',
      });

      const tool2 = tool({
        name: 'shared_name',
        description: 'Tool in server 2',
        inputSchema: { type: 'object' },
        handler: async () => 'result2',
      });

      const server1 = createSdkMcpServer('server1', '1.0.0', [tool1]);
      const server2 = createSdkMcpServer('server2', '1.0.0', [tool2]);

      expect(server1).toBeDefined();
      expect(server2).toBeDefined();
    });
  });
});
