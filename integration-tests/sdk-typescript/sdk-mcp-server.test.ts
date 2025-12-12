/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E tests for SDK-embedded MCP servers
 *
 * Tests that the SDK can create and manage MCP servers running in the SDK process
 * using the tool() and createSdkMcpServer() APIs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  query,
  tool,
  createSdkMcpServer,
  isSDKAssistantMessage,
  isSDKResultMessage,
  isSDKSystemMessage,
  type SDKMessage,
  type SDKSystemMessage,
} from '@qwen-code/sdk';
import {
  SDKTestHelper,
  extractText,
  findToolUseBlocks,
  createSharedTestOptions,
} from './test-helper.js';

const SHARED_TEST_OPTIONS = {
  ...createSharedTestOptions(),
  permissionMode: 'yolo' as const,
};

describe('SDK MCP Server Integration (E2E)', () => {
  let helper: SDKTestHelper;
  let testDir: string;

  beforeEach(async () => {
    helper = new SDKTestHelper();
    testDir = await helper.setup('sdk-mcp-server-integration');
  });

  afterEach(async () => {
    await helper.cleanup();
  });

  describe('Basic SDK MCP Tool Usage', () => {
    it('should use SDK MCP tool to perform a simple calculation', async () => {
      // Define a simple calculator tool using the tool() API with Zod schema
      const calculatorTool = tool(
        'calculate_sum',
        'Calculate the sum of two numbers',
        z.object({
          a: z.number().describe('First number'),
          b: z.number().describe('Second number'),
        }).shape,
        async (args) => ({
          content: [{ type: 'text', text: String(args.a + args.b) }],
        }),
      );

      // Create SDK MCP server with the tool
      const serverConfig = createSdkMcpServer({
        name: 'sdk-calculator',
        version: '1.0.0',
        tools: [calculatorTool],
      });

      const q = query({
        prompt:
          'Use the calculate_sum tool to add 25 and 17. Output the result of tool only.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          mcpServers: {
            'sdk-calculator': serverConfig,
          },
        },
      });

      const messages: SDKMessage[] = [];
      let assistantText = '';
      let foundToolUse = false;

      try {
        for await (const message of q) {
          messages.push(message);

          if (isSDKAssistantMessage(message)) {
            const toolUseBlocks = findToolUseBlocks(message, 'calculate_sum');
            if (toolUseBlocks.length > 0) {
              foundToolUse = true;
            }
            assistantText += extractText(message.message.content);
          }
        }

        // Validate tool was called
        expect(foundToolUse).toBe(true);

        // Validate result contains expected answer: 25 + 17 = 42
        expect(assistantText).toMatch(/42/);

        // Validate successful completion
        const lastMessage = messages[messages.length - 1];
        expect(isSDKResultMessage(lastMessage)).toBe(true);
        if (isSDKResultMessage(lastMessage)) {
          expect(lastMessage.subtype).toBe('success');
        }
      } finally {
        await q.close();
      }
    });

    it('should use SDK MCP tool with string operations', async () => {
      // Define a string manipulation tool with Zod schema
      const stringTool = tool(
        'reverse_string',
        'Reverse a string',
        {
          text: z.string().describe('The text to reverse'),
        },
        async (args) => ({
          content: [
            { type: 'text', text: args.text.split('').reverse().join('') },
          ],
        }),
      );

      const serverConfig = createSdkMcpServer({
        name: 'sdk-string-utils',
        version: '1.0.0',
        tools: [stringTool],
      });

      const q = query({
        prompt: `Use the 'reverse_string' tool to process the word "hello world". Output the tool result only.`,
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          mcpServers: {
            'sdk-string-utils': serverConfig,
          },
        },
      });

      const messages: SDKMessage[] = [];
      let assistantText = '';
      let foundToolUse = false;

      try {
        for await (const message of q) {
          messages.push(message);

          if (isSDKAssistantMessage(message)) {
            const toolUseBlocks = findToolUseBlocks(message, 'reverse_string');
            if (toolUseBlocks.length > 0) {
              foundToolUse = true;
            }
            assistantText += extractText(message.message.content);
          }
        }

        // Validate tool was called
        expect(foundToolUse).toBe(true);

        // Validate result contains reversed string: "olleh"
        expect(assistantText.toLowerCase()).toMatch(/olleh/);

        // Validate successful completion
        const lastMessage = messages[messages.length - 1];
        expect(isSDKResultMessage(lastMessage)).toBe(true);
      } finally {
        await q.close();
      }
    });
  });

  describe('Multiple SDK MCP Tools', () => {
    it('should use multiple tools from the same SDK MCP server', async () => {
      // Define the Zod schema shape for two numbers
      const twoNumbersSchema = {
        a: z.number().describe('First number'),
        b: z.number().describe('Second number'),
      };

      // Define multiple tools
      const addTool = tool(
        'sdk_add',
        'Add two numbers',
        twoNumbersSchema,
        async (args) => ({
          content: [{ type: 'text', text: String(args.a + args.b) }],
        }),
      );

      const multiplyTool = tool(
        'sdk_multiply',
        'Multiply two numbers',
        twoNumbersSchema,
        async (args) => ({
          content: [{ type: 'text', text: String(args.a * args.b) }],
        }),
      );

      const serverConfig = createSdkMcpServer({
        name: 'sdk-math',
        version: '1.0.0',
        tools: [addTool, multiplyTool],
      });

      const q = query({
        prompt:
          'First use sdk_add to calculate 10 + 5, then use sdk_multiply to multiply the result by 3. Give me the final answer.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
          mcpServers: {
            'sdk-math': serverConfig,
          },
        },
      });

      const messages: SDKMessage[] = [];
      let assistantText = '';
      const toolCalls: string[] = [];

      try {
        for await (const message of q) {
          messages.push(message);

          if (isSDKAssistantMessage(message)) {
            const toolUseBlocks = findToolUseBlocks(message);
            toolUseBlocks.forEach((block) => {
              toolCalls.push(block.name);
            });
            assistantText += extractText(message.message.content);
          }
        }

        // Validate both tools were called
        expect(toolCalls).toContain('sdk_add');
        expect(toolCalls).toContain('sdk_multiply');

        // Validate result: (10 + 5) * 3 = 45
        expect(assistantText).toMatch(/45/);

        // Validate successful completion
        const lastMessage = messages[messages.length - 1];
        expect(isSDKResultMessage(lastMessage)).toBe(true);
      } finally {
        await q.close();
      }
    });
  });

  describe('SDK MCP Server Discovery', () => {
    it('should list SDK MCP servers in system init message', async () => {
      // Define echo tool with Zod schema
      const echoTool = tool(
        'echo',
        'Echo a message',
        {
          message: z.string().describe('Message to echo'),
        },
        async (args) => ({
          content: [{ type: 'text', text: args.message }],
        }),
      );

      const serverConfig = createSdkMcpServer({
        name: 'sdk-echo',
        version: '1.0.0',
        tools: [echoTool],
      });

      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
          mcpServers: {
            'sdk-echo': serverConfig,
          },
        },
      });

      let systemMessage: SDKSystemMessage | null = null;

      try {
        for await (const message of q) {
          if (isSDKSystemMessage(message) && message.subtype === 'init') {
            systemMessage = message;
            break;
          }
        }

        // Validate MCP server is listed
        expect(systemMessage).not.toBeNull();
        expect(systemMessage!.mcp_servers).toBeDefined();
        expect(Array.isArray(systemMessage!.mcp_servers)).toBe(true);

        // Find our SDK MCP server
        const sdkServer = systemMessage!.mcp_servers?.find(
          (server) => server.name === 'sdk-echo',
        );
        expect(sdkServer).toBeDefined();
      } finally {
        await q.close();
      }
    });
  });

  describe('SDK MCP Tool Error Handling', () => {
    it('should handle tool errors gracefully', async () => {
      // Define a tool that throws an error with Zod schema
      const errorTool = tool(
        'maybe_fail',
        'A tool that may fail based on input',
        {
          shouldFail: z.boolean().describe('If true, the tool will fail'),
        },
        async (args) => {
          if (args.shouldFail) {
            throw new Error('Tool intentionally failed');
          }
          return { content: [{ type: 'text', text: 'Success!' }] };
        },
      );

      const serverConfig = createSdkMcpServer({
        name: 'sdk-error-test',
        version: '1.0.0',
        tools: [errorTool],
      });

      const q = query({
        prompt:
          'Use the maybe_fail tool with shouldFail set to true. Tell me what happens.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
          mcpServers: {
            'sdk-error-test': serverConfig,
          },
        },
      });

      const messages: SDKMessage[] = [];
      let foundToolUse = false;

      try {
        for await (const message of q) {
          messages.push(message);

          if (isSDKAssistantMessage(message)) {
            const toolUseBlocks = findToolUseBlocks(message, 'maybe_fail');
            if (toolUseBlocks.length > 0) {
              foundToolUse = true;
            }
          }
        }

        // Tool should be called
        expect(foundToolUse).toBe(true);

        // Query should complete (even with tool error)
        const lastMessage = messages[messages.length - 1];
        expect(isSDKResultMessage(lastMessage)).toBe(true);
      } finally {
        await q.close();
      }
    });
  });

  describe('Async Tool Handlers', () => {
    it('should handle async tool handlers with delays', async () => {
      // Define a tool with async delay using Zod schema
      const delayedTool = tool(
        'delayed_response',
        'Returns a value after a delay',
        {
          delay: z.number().describe('Delay in milliseconds (max 100)'),
          value: z.string().describe('Value to return'),
        },
        async (args) => {
          // Cap delay at 100ms for test performance
          const actualDelay = Math.min(args.delay, 100);
          await new Promise((resolve) => setTimeout(resolve, actualDelay));
          return {
            content: [{ type: 'text', text: `Delayed result: ${args.value}` }],
          };
        },
      );

      const serverConfig = createSdkMcpServer({
        name: 'sdk-async',
        version: '1.0.0',
        tools: [delayedTool],
      });

      const q = query({
        prompt:
          'Use the delayed_response tool with delay=50 and value="test_async". Tell me the result.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
          mcpServers: {
            'sdk-async': serverConfig,
          },
        },
      });

      const messages: SDKMessage[] = [];
      let assistantText = '';
      let foundToolUse = false;

      try {
        for await (const message of q) {
          messages.push(message);

          if (isSDKAssistantMessage(message)) {
            const toolUseBlocks = findToolUseBlocks(
              message,
              'delayed_response',
            );
            if (toolUseBlocks.length > 0) {
              foundToolUse = true;
            }
            assistantText += extractText(message.message.content);
          }
        }

        // Validate tool was called
        expect(foundToolUse).toBe(true);

        // Validate result contains the delayed response
        expect(assistantText.toLowerCase()).toMatch(/test_async/i);

        // Validate successful completion
        const lastMessage = messages[messages.length - 1];
        expect(isSDKResultMessage(lastMessage)).toBe(true);
      } finally {
        await q.close();
      }
    });
  });
});
