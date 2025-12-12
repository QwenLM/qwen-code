/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E tests for MCP (Model Context Protocol) server integration via SDK
 * Tests that the SDK can properly interact with MCP servers configured in qwen-code
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  query,
  isSDKAssistantMessage,
  isSDKResultMessage,
  isSDKSystemMessage,
  isSDKUserMessage,
  type SDKMessage,
  type ToolUseBlock,
  type SDKSystemMessage,
} from '@qwen-code/sdk';
import {
  SDKTestHelper,
  createMCPServer,
  extractText,
  findToolUseBlocks,
  createSharedTestOptions,
} from './test-helper.js';

const SHARED_TEST_OPTIONS = {
  ...createSharedTestOptions(),
  permissionMode: 'yolo' as const,
};

describe('MCP Server Integration (E2E)', () => {
  let helper: SDKTestHelper;
  let serverScriptPath: string;
  let testDir: string;

  beforeEach(async () => {
    // Create isolated test environment using SDKTestHelper
    helper = new SDKTestHelper();
    testDir = await helper.setup('mcp-server-integration');

    // Create MCP server using the helper utility
    const mcpServer = await createMCPServer(helper, 'math', 'test-math-server');
    serverScriptPath = mcpServer.scriptPath;
  });

  afterEach(async () => {
    // Cleanup test directory
    await helper.cleanup();
  });

  describe('Basic MCP Tool Usage', () => {
    it('should use MCP add tool to add two numbers', async () => {
      const q = query({
        prompt:
          'Use the add tool to calculate 5 + 10. Just give me the result.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
          mcpServers: {
            'test-math-server': {
              command: 'node',
              args: [serverScriptPath],
            },
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
            const toolUseBlocks = findToolUseBlocks(message, 'add');
            if (toolUseBlocks.length > 0) {
              foundToolUse = true;
            }
            assistantText += extractText(message.message.content);
          }
        }

        // Validate tool was called
        expect(foundToolUse).toBe(true);

        // Validate result contains expected answer
        expect(assistantText).toMatch(/15/);

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

    it('should use MCP multiply tool to multiply two numbers', async () => {
      const q = query({
        prompt:
          'Use the multiply tool to calculate 6 * 7. Just give me the result.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
          mcpServers: {
            'test-math-server': {
              command: 'node',
              args: [serverScriptPath],
            },
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
            const toolUseBlocks = findToolUseBlocks(message, 'multiply');
            if (toolUseBlocks.length > 0) {
              foundToolUse = true;
            }
            assistantText += extractText(message.message.content);
          }
        }

        // Validate tool was called
        expect(foundToolUse).toBe(true);

        // Validate result contains expected answer
        expect(assistantText).toMatch(/42/);

        // Validate successful completion
        const lastMessage = messages[messages.length - 1];
        expect(isSDKResultMessage(lastMessage)).toBe(true);
      } finally {
        await q.close();
      }
    });
  });

  describe('MCP Server Discovery', () => {
    it('should list MCP servers in system init message', async () => {
      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
          mcpServers: {
            'test-math-server': {
              command: 'node',
              args: [serverScriptPath],
            },
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

        // Find our test server
        const testServer = systemMessage!.mcp_servers?.find(
          (server) => server.name === 'test-math-server',
        );
        expect(testServer).toBeDefined();

        // Note: tools are not exposed in the mcp_servers array in system message
        // They are available through the MCP protocol but not in the init message
      } finally {
        await q.close();
      }
    });
  });

  describe('Complex MCP Operations', () => {
    it('should chain multiple MCP tool calls', async () => {
      const q = query({
        prompt:
          'First use add to calculate 10 + 5, then multiply the result by 2. Give me the final answer.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
          mcpServers: {
            'test-math-server': {
              command: 'node',
              args: [serverScriptPath],
            },
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
        expect(toolCalls).toContain('add');
        expect(toolCalls).toContain('multiply');

        // Validate result: (10 + 5) * 2 = 30
        expect(assistantText).toMatch(/30/);

        // Validate successful completion
        const lastMessage = messages[messages.length - 1];
        expect(isSDKResultMessage(lastMessage)).toBe(true);
      } finally {
        await q.close();
      }
    });

    it('should handle multiple calls to the same MCP tool', async () => {
      const q = query({
        prompt:
          'Use the add tool twice: first add 1 + 2, then add 3 + 4. Tell me both results.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
          mcpServers: {
            'test-math-server': {
              command: 'node',
              args: [serverScriptPath],
            },
          },
        },
      });

      const messages: SDKMessage[] = [];
      let assistantText = '';
      const addToolCalls: ToolUseBlock[] = [];

      try {
        for await (const message of q) {
          messages.push(message);

          if (isSDKAssistantMessage(message)) {
            const toolUseBlocks = findToolUseBlocks(message, 'add');
            addToolCalls.push(...toolUseBlocks);
            assistantText += extractText(message.message.content);
          }
        }

        // Validate add tool was called at least twice
        expect(addToolCalls.length).toBeGreaterThanOrEqual(2);

        // Validate results contain expected answers: 3 and 7
        expect(assistantText).toMatch(/3/);
        expect(assistantText).toMatch(/7/);

        // Validate successful completion
        const lastMessage = messages[messages.length - 1];
        expect(isSDKResultMessage(lastMessage)).toBe(true);
      } finally {
        await q.close();
      }
    });
  });

  describe('MCP Tool Message Flow', () => {
    it('should receive proper message sequence for MCP tool usage', async () => {
      const q = query({
        prompt: 'Use add to calculate 2 + 3',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
          mcpServers: {
            'test-math-server': {
              command: 'node',
              args: [serverScriptPath],
            },
          },
        },
      });

      const messageTypes: string[] = [];
      let foundToolUse = false;
      let foundToolResult = false;

      try {
        for await (const message of q) {
          messageTypes.push(message.type);

          if (isSDKAssistantMessage(message)) {
            const toolUseBlocks = findToolUseBlocks(message);
            if (toolUseBlocks.length > 0) {
              foundToolUse = true;
              expect(toolUseBlocks[0].name).toBe('add');
              expect(toolUseBlocks[0].input).toBeDefined();
            }
          }

          if (isSDKUserMessage(message)) {
            const content = message.message.content;
            const contentArray = Array.isArray(content)
              ? content
              : [{ type: 'text', text: content }];
            const toolResultBlock = contentArray.find(
              (block) => block.type === 'tool_result',
            );
            if (toolResultBlock) {
              foundToolResult = true;
            }
          }
        }

        // Validate message flow
        expect(foundToolUse).toBe(true);
        expect(foundToolResult).toBe(true);
        expect(messageTypes).toContain('system');
        expect(messageTypes).toContain('assistant');
        expect(messageTypes).toContain('user');
        expect(messageTypes).toContain('result');

        // Result should be last message
        expect(messageTypes[messageTypes.length - 1]).toBe('result');
      } finally {
        await q.close();
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle gracefully when MCP tool is not available', async () => {
      const q = query({
        prompt: 'Use the subtract tool to calculate 10 - 5',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
          mcpServers: {
            'test-math-server': {
              command: 'node',
              args: [serverScriptPath],
            },
          },
        },
      });

      const messages: SDKMessage[] = [];
      let assistantText = '';

      try {
        for await (const message of q) {
          messages.push(message);

          if (isSDKAssistantMessage(message)) {
            assistantText += extractText(message.message.content);
          }
        }

        // Should complete without crashing
        const lastMessage = messages[messages.length - 1];
        expect(isSDKResultMessage(lastMessage)).toBe(true);

        // Assistant should indicate tool is not available or provide alternative
        expect(assistantText.length).toBeGreaterThan(0);
      } finally {
        await q.close();
      }
    });
  });
});
