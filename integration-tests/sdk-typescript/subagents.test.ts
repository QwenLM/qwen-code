/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E tests for subagent configuration and execution
 * Tests subagent delegation and task completion
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  query,
  isSDKAssistantMessage,
  type SDKMessage,
  type SubagentConfig,
  type ContentBlock,
  type ToolUseBlock,
} from '@qwen-code/sdk';
import {
  SDKTestHelper,
  extractText,
  createSharedTestOptions,
  findToolUseBlocks,
  assertSuccessfulCompletion,
  findSystemMessage,
} from './test-helper.js';

const SHARED_TEST_OPTIONS = createSharedTestOptions();

describe('Subagents (E2E)', () => {
  let helper: SDKTestHelper;
  let testWorkDir: string;

  beforeEach(async () => {
    // Create isolated test environment using SDKTestHelper
    helper = new SDKTestHelper();
    testWorkDir = await helper.setup('subagent-tests');

    // Create a simple test file for subagent to work with
    await helper.createFile('test.txt', 'Hello from test file\n');
  });

  afterEach(async () => {
    // Cleanup test directory
    await helper.cleanup();
  });

  describe('Subagent Configuration', () => {
    it('should accept session-level subagent configuration', async () => {
      const simpleSubagent: SubagentConfig = {
        name: 'simple-greeter',
        description: 'A simple subagent that responds to greetings',
        systemPrompt:
          'You are a friendly greeter. When given a task, respond with a cheerful greeting.',
        level: 'session',
      };

      const q = query({
        prompt: 'Hello, let simple-greeter to say hi back to me.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testWorkDir,
          agents: [simpleSubagent],
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Validate system message includes the subagent
        const systemMessage = findSystemMessage(messages, 'init');
        expect(systemMessage).not.toBeNull();
        expect(systemMessage!.agents).toBeDefined();
        expect(systemMessage!.agents).toContain('simple-greeter');

        // Validate successful completion
        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });

    it('should accept multiple subagent configurations', async () => {
      const greeterAgent: SubagentConfig = {
        name: 'greeter',
        description: 'Responds to greetings',
        systemPrompt: 'You are a friendly greeter.',
        level: 'session',
      };

      const mathAgent: SubagentConfig = {
        name: 'math-helper',
        description: 'Helps with math problems',
        systemPrompt: 'You are a math expert. Solve math problems clearly.',
        level: 'session',
      };

      const q = query({
        prompt: 'What is 5 + 5?',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testWorkDir,
          agents: [greeterAgent, mathAgent],
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Validate both subagents are registered
        const systemMessage = findSystemMessage(messages, 'init');
        expect(systemMessage).not.toBeNull();
        expect(systemMessage!.agents).toBeDefined();
        expect(systemMessage!.agents).toContain('greeter');
        expect(systemMessage!.agents).toContain('math-helper');
        expect(systemMessage!.agents!.length).toBeGreaterThanOrEqual(2);
      } finally {
        await q.close();
      }
    });

    it('should handle subagent with custom model selector', async () => {
      const customModelAgent: SubagentConfig = {
        name: 'custom-model-agent',
        description: 'Agent with custom model configuration',
        systemPrompt: 'You are a helpful assistant.',
        level: 'session',
        model: 'inherit',
      };

      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testWorkDir,
          agents: [customModelAgent],
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Validate subagent is registered
        const systemMessage = findSystemMessage(messages, 'init');
        expect(systemMessage).not.toBeNull();
        expect(systemMessage!.agents).toBeDefined();
        expect(systemMessage!.agents).toContain('custom-model-agent');
      } finally {
        await q.close();
      }
    });

    it('should handle subagent with run config', async () => {
      const limitedAgent: SubagentConfig = {
        name: 'limited-agent',
        description: 'Agent with execution limits',
        systemPrompt: 'You are a helpful assistant.',
        level: 'session',
        runConfig: {
          max_turns: 5,
          max_time_minutes: 1,
        },
      };

      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testWorkDir,
          agents: [limitedAgent],
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Validate subagent is registered
        const systemMessage = findSystemMessage(messages, 'init');
        expect(systemMessage).not.toBeNull();
        expect(systemMessage!.agents).toBeDefined();
        expect(systemMessage!.agents).toContain('limited-agent');
      } finally {
        await q.close();
      }
    });

    it('should handle subagent with specific tools', async () => {
      const toolRestrictedAgent: SubagentConfig = {
        name: 'read-only-agent',
        description: 'Agent that can only read files',
        systemPrompt:
          'You are a file reading assistant. Read files when asked.',
        level: 'session',
        tools: ['read_file', 'list_directory'],
      };

      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testWorkDir,
          agents: [toolRestrictedAgent],
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Validate subagent is registered
        const systemMessage = findSystemMessage(messages, 'init');
        expect(systemMessage).not.toBeNull();
        expect(systemMessage!.agents).toBeDefined();
        expect(systemMessage!.agents).toContain('read-only-agent');
      } finally {
        await q.close();
      }
    });
  });

  describe('Subagent Execution', () => {
    it('should delegate task to subagent when appropriate', async () => {
      const fileReaderAgent: SubagentConfig = {
        name: 'file-reader',
        description: 'Reads a requested file and reports its exact contents.',
        systemPrompt:
          'Use read_file to read the requested file, then report its exact contents.',
        level: 'session',
        tools: ['read_file'],
      };

      const testFile = helper.getPath('test.txt');
      const q = query({
        prompt:
          `Use the agent tool to ask the file-reader subagent to read ${testFile}. ` +
          `Return the file contents reported by the subagent.`,
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testWorkDir,
          agents: [fileReaderAgent],
          debug: false,
          permissionMode: 'yolo',
        },
      });

      const messages: SDKMessage[] = [];
      let foundTaskTool = false;
      let taskToolUseId: string | null = null;
      let foundSubagentToolCall = false;
      let assistantText = '';

      try {
        for await (const message of q) {
          messages.push(message);

          if (isSDKAssistantMessage(message)) {
            // Check for task tool use in content blocks (main agent calling subagent)
            const taskToolBlocks = findToolUseBlocks(message, 'agent');
            if (taskToolBlocks.length > 0) {
              foundTaskTool = true;
              taskToolUseId = taskToolBlocks[0].id;
            }

            // Check if this message is from a subagent (has parent_tool_use_id)
            if (message.parent_tool_use_id !== null) {
              // This is a subagent message
              const subagentToolBlocks = findToolUseBlocks(message);
              if (subagentToolBlocks.length > 0) {
                foundSubagentToolCall = true;
                // Verify parent_tool_use_id matches the task tool use id
                expect(message.parent_tool_use_id).toBe(taskToolUseId);
              }
            }

            assistantText += extractText(message.message.content);
          }
        }

        // Validate task tool was used (subagent delegation)
        expect(foundTaskTool).toBe(true);
        expect(taskToolUseId).not.toBeNull();

        // Validate subagent actually made tool calls with proper parent_tool_use_id
        expect(foundSubagentToolCall).toBe(true);

        // Validate we got a response
        expect(assistantText.length).toBeGreaterThan(0);

        // Verify all subagent messages have the correct parent_tool_use_id
        const subagentMessages = messages.filter(
          (msg): msg is SDKMessage & { parent_tool_use_id: string } =>
            isSDKAssistantMessage(msg) && msg.parent_tool_use_id !== null,
        );

        expect(subagentMessages.length).toBeGreaterThan(0);
        for (const subagentMsg of subagentMessages) {
          expect(subagentMsg.parent_tool_use_id).toBe(taskToolUseId);
        }

        // Verify main agent messages (except subagent results) have parent_tool_use_id as null
        const mainAgentMessages = messages.filter(
          (msg): msg is SDKMessage =>
            isSDKAssistantMessage(msg) && msg.parent_tool_use_id === null,
        );

        for (const mainMsg of mainAgentMessages) {
          if (isSDKAssistantMessage(mainMsg)) {
            // Main agent messages should not have parent_tool_use_id
            expect(mainMsg.parent_tool_use_id).toBeNull();
          }
        }

        // Validate successful completion
        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    }, 60000); // Increase timeout for subagent execution

    it('should complete simple task with subagent', async () => {
      const simpleTaskAgent: SubagentConfig = {
        name: 'simple-calculator',
        description: 'Performs simple arithmetic calculations',
        systemPrompt:
          'You are a calculator. When given a math problem, solve it and provide just the answer.',
        level: 'session',
      };

      const q = query({
        prompt: 'Use the simple-calculator subagent to calculate 15 + 27.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testWorkDir,
          agents: [simpleTaskAgent],
          debug: false,
          permissionMode: 'yolo',
        },
      });

      const messages: SDKMessage[] = [];
      let foundTaskTool = false;
      let assistantText = '';

      try {
        for await (const message of q) {
          messages.push(message);

          if (isSDKAssistantMessage(message)) {
            // Check for task tool use (main agent delegating to subagent)
            const toolUseBlock = message.message.content.find(
              (block: ContentBlock): block is ToolUseBlock =>
                block.type === 'tool_use' && block.name === 'agent',
            );
            if (toolUseBlock) {
              foundTaskTool = true;
            }

            assistantText += extractText(message.message.content);
          }
        }

        // Validate task tool was used (subagent was called)
        expect(foundTaskTool).toBe(true);

        // Validate we got a response
        expect(assistantText.length).toBeGreaterThan(0);

        // Validate successful completion
        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    }, 60000);
  });

  describe('Subagent Error Handling', () => {
    it('should handle empty subagent array', async () => {
      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testWorkDir,
          agents: [],
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Should still work with empty agents array
        const systemMessage = findSystemMessage(messages, 'init');
        expect(systemMessage).not.toBeNull();
        expect(systemMessage!.agents).toBeDefined();
      } finally {
        await q.close();
      }
    });

    it('should handle subagent with minimal configuration', async () => {
      const minimalAgent: SubagentConfig = {
        name: 'minimal-agent',
        description: 'Minimal configuration agent',
        systemPrompt: 'You are a helpful assistant.',
        level: 'session',
      };

      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testWorkDir,
          agents: [minimalAgent],
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Validate minimal agent is registered
        const systemMessage = findSystemMessage(messages, 'init');
        expect(systemMessage).not.toBeNull();
        expect(systemMessage!.agents).toBeDefined();
        expect(systemMessage!.agents).toContain('minimal-agent');
      } finally {
        await q.close();
      }
    });
  });

  describe('Subagent Integration', () => {
    it('should work with other SDK options', async () => {
      const testAgent: SubagentConfig = {
        name: 'test-agent',
        description: 'Test agent for integration',
        systemPrompt: 'You are a test assistant.',
        level: 'session',
      };

      const stderrMessages: string[] = [];

      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testWorkDir,
          agents: [testAgent],
          debug: true,
          stderr: (msg: string) => {
            stderrMessages.push(msg);
          },
          permissionMode: 'default',
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Validate subagent works with debug mode
        const systemMessage = findSystemMessage(messages, 'init');
        expect(systemMessage).not.toBeNull();
        expect(systemMessage!.agents).toBeDefined();
        expect(systemMessage!.agents).toContain('test-agent');
        expect(stderrMessages.length).toBeGreaterThan(0);
      } finally {
        await q.close();
      }
    });

    it('should maintain session consistency with subagents', async () => {
      const sessionAgent: SubagentConfig = {
        name: 'session-agent',
        description: 'Agent for session testing',
        systemPrompt: 'You are a session test assistant.',
        level: 'session',
      };

      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testWorkDir,
          agents: [sessionAgent],
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Validate session consistency
        const systemMessage = findSystemMessage(messages, 'init');
        expect(systemMessage).not.toBeNull();
        expect(systemMessage!.session_id).toBeDefined();
        expect(systemMessage!.uuid).toBeDefined();
        expect(systemMessage!.session_id).toBe(systemMessage!.uuid);
        expect(systemMessage!.agents).toContain('session-agent');
      } finally {
        await q.close();
      }
    });
  });
});
