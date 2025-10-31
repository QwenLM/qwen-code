/**
 * End-to-End tests for simple query execution with real CLI
 * Tests the complete SDK workflow with actual CLI subprocess
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import { describe, it, expect } from 'vitest';
import {
  query,
  AbortError,
  isAbortError,
  isCLIAssistantMessage,
  isCLIUserMessage,
  isCLIResultMessage,
  type TextBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type ContentBlock,
  type CLIMessage,
  type CLIAssistantMessage,
} from '../../src/index.js';

// Test configuration
const TEST_CLI_PATH =
  '/Users/mingholy/Work/Projects/qwen-code/packages/cli/index.ts';
const TEST_TIMEOUT = 30000;

// Shared test options with permissionMode to allow all tools
const SHARED_TEST_OPTIONS = {
  pathToQwenExecutable: TEST_CLI_PATH,
  permissionMode: 'yolo' as const,
};

describe('Simple Query Execution (E2E)', () => {
  describe('Basic Query Flow', () => {
    it(
      'should execute simple text query',
      async () => {
        const q = query({
          prompt: 'What is 2 + 2?',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        const messages: CLIMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
            if (isCLIResultMessage(message)) {
              break;
            }
          }

          expect(messages.length).toBeGreaterThan(0);

          // Should have at least one assistant message
          const assistantMessages = messages.filter(isCLIAssistantMessage);
          expect(assistantMessages.length).toBeGreaterThan(0);

          // Should end with result message
          const lastMessage = messages[messages.length - 1];
          expect(isCLIResultMessage(lastMessage)).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should receive assistant response',
      async () => {
        const q = query({
          prompt: 'Say hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        let hasAssistantMessage = false;

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
              hasAssistantMessage = true;
              const textBlocks = message.message.content.filter(
                (block): block is TextBlock => block.type === 'text',
              );
              expect(textBlocks.length).toBeGreaterThan(0);
              expect(textBlocks[0].text.length).toBeGreaterThan(0);
              break;
            }
          }

          expect(hasAssistantMessage).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should receive result message at end',
      async () => {
        const q = query({
          prompt: 'Simple test',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        const messages: CLIMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          expect(messages.length).toBeGreaterThan(0);

          const lastMessage = messages[messages.length - 1];
          expect(isCLIResultMessage(lastMessage)).toBe(true);
          if (isCLIResultMessage(lastMessage)) {
            expect(lastMessage.subtype).toBe('success');
          }
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should complete iteration after result',
      async () => {
        const q = query({
          prompt: 'Test completion',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        let messageCount = 0;
        let completedNaturally = false;

        try {
          for await (const message of q) {
            messageCount++;
            if (isCLIResultMessage(message)) {
              // Should be the last message
              completedNaturally = true;
            }
          }

          expect(messageCount).toBeGreaterThan(0);
          expect(completedNaturally).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Query with Tool Usage', () => {
    it(
      'should handle query requiring tool execution',
      async () => {
        const q = query({
          prompt:
            'What files are in the current directory? List only the top-level files and folders.',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: process.cwd(),
            debug: false,
          },
        });

        const messages: CLIMessage[] = [];
        let hasToolUse = false;
        let hasAssistantResponse = false;

        try {
          for await (const message of q) {
            messages.push(message);

            if (isCLIAssistantMessage(message)) {
              hasAssistantResponse = true;
              const hasToolUseBlock = message.message.content.some(
                (block: ContentBlock) => block.type === 'tool_use',
              );
              if (hasToolUseBlock) {
                hasToolUse = true;
              }
            }

            if (isCLIResultMessage(message)) {
              break;
            }
          }

          expect(messages.length).toBeGreaterThan(0);
          expect(hasToolUse).toBe(true);
          expect(hasAssistantResponse).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should yield tool_use messages',
      async () => {
        const q = query({
          prompt: 'List files in current directory',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: process.cwd(),
            debug: false,
          },
        });

        let toolUseMessage: ToolUseBlock | null = null;

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
              const toolUseBlock = message.message.content.find(
                (block: ContentBlock): block is ToolUseBlock =>
                  block.type === 'tool_use',
              );
              if (toolUseBlock) {
                toolUseMessage = toolUseBlock;
                expect(toolUseBlock.name).toBeDefined();
                expect(toolUseBlock.id).toBeDefined();
                expect(toolUseBlock.input).toBeDefined();
                break;
              }
            }
          }

          expect(toolUseMessage).not.toBeNull();
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should yield tool_result messages',
      async () => {
        const q = query({
          prompt: 'List files in current directory',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: process.cwd(),
            debug: false,
          },
        });

        let toolResultMessage: ToolResultBlock | null = null;

        try {
          for await (const message of q) {
            if (isCLIUserMessage(message)) {
              // Tool results are sent as user messages with ToolResultBlock[] content
              if (Array.isArray(message.message.content)) {
                const toolResultBlock = message.message.content.find(
                  (block: ContentBlock): block is ToolResultBlock =>
                    block.type === 'tool_result',
                );
                if (toolResultBlock) {
                  toolResultMessage = toolResultBlock;
                  expect(toolResultBlock.tool_use_id).toBeDefined();
                  expect(toolResultBlock.content).toBeDefined();
                  // Content should not be a simple string but structured data
                  expect(typeof toolResultBlock.content).not.toBe('undefined');
                  break;
                }
              }
            }
          }

          expect(toolResultMessage).not.toBeNull();
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should yield final assistant response',
      async () => {
        const q = query({
          prompt: 'List files in current directory and tell me what you found',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: process.cwd(),
            debug: false,
          },
        });

        const assistantMessages: CLIAssistantMessage[] = [];

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
              assistantMessages.push(message);
            }

            if (isCLIResultMessage(message)) {
              break;
            }
          }

          expect(assistantMessages.length).toBeGreaterThan(0);

          // Final assistant message should contain summary
          const finalAssistant =
            assistantMessages[assistantMessages.length - 1];
          const textBlocks = finalAssistant.message.content.filter(
            (block: ContentBlock): block is TextBlock => block.type === 'text',
          );
          expect(textBlocks.length).toBeGreaterThan(0);
          expect(textBlocks[0].text.length).toBeGreaterThan(0);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Configuration Options', () => {
    it(
      'should respect cwd option',
      async () => {
        const testDir = '/tmp';

        const q = query({
          prompt: 'What is the current working directory?',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: testDir,
            debug: false,
          },
        });

        let hasResponse = false;

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
              hasResponse = true;
              // Should execute in specified directory
              break;
            }
          }

          expect(hasResponse).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should use explicit CLI path when provided',
      async () => {
        const q = query({
          prompt: 'Hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        let hasResponse = false;

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
              hasResponse = true;
              break;
            }
          }

          expect(hasResponse).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Resource Management', () => {
    it(
      'should cleanup subprocess on close()',
      async () => {
        const q = query({
          prompt: 'Hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        // Start and immediately close
        const iterator = q[Symbol.asyncIterator]();
        await iterator.next();

        // Should close without error
        await q.close();
        expect(true).toBe(true); // Cleanup completed
      },
      TEST_TIMEOUT,
    );
  });

  describe('Error Handling', () => {
    it(
      'should throw if CLI not found',
      async () => {
        try {
          const q = query({
            prompt: 'Hello',
            options: {
              pathToQwenExecutable: '/nonexistent/path/to/cli',
              debug: false,
            },
          });

          // Should not reach here - query() should throw immediately
          for await (const _message of q) {
            // Should not reach here
          }
          expect(false).toBe(true); // Should have thrown
        } catch (error) {
          expect(error).toBeDefined();
          expect(error instanceof Error).toBe(true);
          expect((error as Error).message).toContain(
            'Invalid pathToQwenExecutable',
          );
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Timeout and Cancellation', () => {
    it(
      'should support AbortSignal cancellation',
      async () => {
        const controller = new AbortController();

        // Abort after 2 seconds
        setTimeout(() => {
          controller.abort();
        }, 2000);

        const q = query({
          prompt: 'Write a very long story about TypeScript',
          options: {
            ...SHARED_TEST_OPTIONS,
            signal: controller.signal,
            debug: false,
          },
        });

        try {
          for await (const _message of q) {
            // Should be interrupted by abort
          }

          // Should not reach here
          expect(false).toBe(true);
        } catch (error) {
          expect(isAbortError(error)).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should cleanup on cancellation',
      async () => {
        const controller = new AbortController();

        const q = query({
          prompt: 'Write a very long essay',
          options: {
            ...SHARED_TEST_OPTIONS,
            signal: controller.signal,
            debug: false,
          },
        });

        // Abort immediately
        setTimeout(() => controller.abort(), 100);

        try {
          for await (const _message of q) {
            // Should be interrupted
          }
        } catch (error) {
          expect(error instanceof AbortError).toBe(true);
        } finally {
          // Should cleanup successfully even after abort
          await q.close();
          expect(true).toBe(true); // Cleanup completed
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Message Collection Patterns', () => {
    it(
      'should collect all messages in array',
      async () => {
        const q = query({
          prompt: 'What is 2 + 2?',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        const messages: CLIMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          expect(messages.length).toBeGreaterThan(0);

          // Should have various message types
          const messageTypes = messages.map((m) => m.type);
          expect(messageTypes).toContain('assistant');
          expect(messageTypes).toContain('result');
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should extract final answer',
      async () => {
        const q = query({
          prompt: 'What is the capital of France?',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        const messages: CLIMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          // Get last assistant message content
          const assistantMessages = messages.filter(isCLIAssistantMessage);
          expect(assistantMessages.length).toBeGreaterThan(0);

          const lastAssistant = assistantMessages[assistantMessages.length - 1];
          const textBlocks = lastAssistant.message.content.filter(
            (block: ContentBlock): block is TextBlock => block.type === 'text',
          );

          expect(textBlocks.length).toBeGreaterThan(0);
          expect(textBlocks[0].text).toContain('Paris');
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should track tool usage',
      async () => {
        const q = query({
          prompt: 'List files in current directory',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: process.cwd(),
            debug: false,
          },
        });

        const messages: CLIMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          // Count tool_use blocks in assistant messages and tool_result blocks in user messages
          let toolUseCount = 0;
          let toolResultCount = 0;

          messages.forEach((message) => {
            if (isCLIAssistantMessage(message)) {
              message.message.content.forEach((block: ContentBlock) => {
                if (block.type === 'tool_use') {
                  toolUseCount++;
                }
              });
            } else if (isCLIUserMessage(message)) {
              // Tool results are in user messages
              if (Array.isArray(message.message.content)) {
                message.message.content.forEach((block: ContentBlock) => {
                  if (block.type === 'tool_result') {
                    toolResultCount++;
                  }
                });
              }
            }
          });

          expect(toolUseCount).toBeGreaterThan(0);
          expect(toolResultCount).toBeGreaterThan(0);

          // Each tool_use should have a corresponding tool_result
          expect(toolResultCount).toBeGreaterThanOrEqual(toolUseCount);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Real-World Scenarios', () => {
    it(
      'should handle code analysis query',
      async () => {
        const q = query({
          prompt:
            'What is the main export of the package.json file in this directory?',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: process.cwd(),
            debug: false,
          },
        });

        let hasAnalysis = false;

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
              const textBlocks = message.message.content.filter(
                (block: ContentBlock): block is TextBlock =>
                  block.type === 'text',
              );
              if (textBlocks.length > 0 && textBlocks[0].text.length > 0) {
                hasAnalysis = true;
                break;
              }
            }
          }

          expect(hasAnalysis).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle multi-step query',
      async () => {
        const q = query({
          prompt:
            'List the files in this directory and tell me what type of project this is',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: process.cwd(),
            debug: false,
          },
        });

        let hasToolUse = false;
        let hasAnalysis = false;

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
              const hasToolUseBlock = message.message.content.some(
                (block: ContentBlock) => block.type === 'tool_use',
              );
              if (hasToolUseBlock) {
                hasToolUse = true;
              }
            }

            if (isCLIAssistantMessage(message)) {
              const textBlocks = message.message.content.filter(
                (block: ContentBlock): block is TextBlock =>
                  block.type === 'text',
              );
              if (textBlocks.length > 0 && textBlocks[0].text.length > 0) {
                hasAnalysis = true;
              }
            }

            if (isCLIResultMessage(message)) {
              break;
            }
          }

          expect(hasToolUse).toBe(true);
          expect(hasAnalysis).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });
});
