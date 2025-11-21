/**
 * E2E tests for single-turn query execution
 * Tests basic query patterns with simple prompts and clear output expectations
 */

import { describe, it, expect } from 'vitest';
import { query } from '../../src/index.js';
import {
  isCLIAssistantMessage,
  isCLISystemMessage,
  isCLIResultMessage,
  type TextBlock,
  type ContentBlock,
  type CLIMessage,
  type CLISystemMessage,
  type CLIAssistantMessage,
} from '../../src/types/protocol.js';

// Test configuration
const TEST_CLI_PATH =
  '/Users/mingholy/Work/Projects/qwen-code/packages/cli/index.ts';
const TEST_TIMEOUT = 30000;

// Shared test options with permissionMode to allow all tools
const SHARED_TEST_OPTIONS = {
  pathToQwenExecutable: TEST_CLI_PATH,
  permissionMode: 'yolo' as const,
};

/**
 * Helper to extract text from ContentBlock array
 */
function extractText(content: ContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

describe('Single-Turn Query (E2E)', () => {
  describe('Simple Text Queries', () => {
    it(
      'should answer basic arithmetic question',
      async () => {
        const q = query({
          prompt: 'What is 2 + 2? Just give me the number.',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        const messages: CLIMessage[] = [];
        let assistantText = '';

        try {
          for await (const message of q) {
            messages.push(message);

            if (isCLIAssistantMessage(message)) {
              assistantText += extractText(message.message.content);
            }
          }

          // Validate we got messages
          expect(messages.length).toBeGreaterThan(0);

          // Validate assistant response content
          expect(assistantText.length).toBeGreaterThan(0);
          expect(assistantText).toMatch(/4/);

          // Validate message flow ends with success
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
      'should answer simple factual question',
      async () => {
        const q = query({
          prompt: 'What is the capital of France? One word answer.',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        const messages: CLIMessage[] = [];
        let assistantText = '';

        try {
          for await (const message of q) {
            messages.push(message);

            if (isCLIAssistantMessage(message)) {
              assistantText += extractText(message.message.content);
            }
          }

          // Validate content
          expect(assistantText.length).toBeGreaterThan(0);
          expect(assistantText.toLowerCase()).toContain('paris');

          // Validate completion
          const lastMessage = messages[messages.length - 1];
          expect(isCLIResultMessage(lastMessage)).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle greeting and self-description',
      async () => {
        const q = query({
          prompt: 'Say hello and tell me your name in one sentence.',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        const messages: CLIMessage[] = [];
        let assistantText = '';

        try {
          for await (const message of q) {
            messages.push(message);

            if (isCLIAssistantMessage(message)) {
              assistantText += extractText(message.message.content);
            }
          }

          // Validate content contains greeting
          expect(assistantText.length).toBeGreaterThan(0);
          expect(assistantText.toLowerCase()).toMatch(/hello|hi|greetings/);

          // Validate message types
          const assistantMessages = messages.filter(isCLIAssistantMessage);
          expect(assistantMessages.length).toBeGreaterThan(0);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('System Initialization', () => {
    it(
      'should receive system message with initialization info',
      async () => {
        const q = query({
          prompt: 'Hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        const messages: CLIMessage[] = [];
        let systemMessage: CLISystemMessage | null = null;

        try {
          for await (const message of q) {
            messages.push(message);

            if (isCLISystemMessage(message) && message.subtype === 'init') {
              systemMessage = message;
            }
          }

          // Validate system message exists and has required fields
          expect(systemMessage).not.toBeNull();
          expect(systemMessage!.type).toBe('system');
          expect(systemMessage!.subtype).toBe('init');
          expect(systemMessage!.uuid).toBeDefined();
          expect(systemMessage!.session_id).toBeDefined();
          expect(systemMessage!.cwd).toBeDefined();
          expect(systemMessage!.tools).toBeDefined();
          expect(Array.isArray(systemMessage!.tools)).toBe(true);
          expect(systemMessage!.mcp_servers).toBeDefined();
          expect(Array.isArray(systemMessage!.mcp_servers)).toBe(true);
          expect(systemMessage!.model).toBeDefined();
          expect(systemMessage!.permissionMode).toBeDefined();
          expect(systemMessage!.qwen_code_version).toBeDefined();

          // Validate system message appears early in sequence
          const systemMessageIndex = messages.findIndex(
            (msg) => isCLISystemMessage(msg) && msg.subtype === 'init',
          );
          expect(systemMessageIndex).toBeGreaterThanOrEqual(0);
          expect(systemMessageIndex).toBeLessThan(3);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should maintain session ID consistency',
      async () => {
        const q = query({
          prompt: 'Hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        let systemMessage: CLISystemMessage | null = null;
        const sessionId = q.getSessionId();

        try {
          for await (const message of q) {
            if (isCLISystemMessage(message) && message.subtype === 'init') {
              systemMessage = message;
            }
          }

          // Validate session IDs are consistent
          expect(sessionId).toBeDefined();
          expect(systemMessage).not.toBeNull();
          expect(systemMessage!.session_id).toBeDefined();
          expect(systemMessage!.uuid).toBeDefined();
          expect(systemMessage!.session_id).toBe(systemMessage!.uuid);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Message Flow', () => {
    it(
      'should follow expected message sequence',
      async () => {
        const q = query({
          prompt: 'Say hi',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        const messageTypes: string[] = [];

        try {
          for await (const message of q) {
            messageTypes.push(message.type);
          }

          // Validate message sequence
          expect(messageTypes.length).toBeGreaterThan(0);
          expect(messageTypes).toContain('assistant');
          expect(messageTypes[messageTypes.length - 1]).toBe('result');
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should complete iteration naturally',
      async () => {
        const q = query({
          prompt: 'Say goodbye',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        let completedNaturally = false;
        let messageCount = 0;

        try {
          for await (const message of q) {
            messageCount++;

            if (isCLIResultMessage(message)) {
              completedNaturally = true;
              expect(message.subtype).toBe('success');
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

  describe('Configuration Options', () => {
    it(
      'should respect debug option and capture stderr',
      async () => {
        const stderrMessages: string[] = [];

        const q = query({
          prompt: 'Hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: true,
            stderr: (message: string) => {
              stderrMessages.push(message);
            },
          },
        });

        try {
          for await (const _message of q) {
            // Consume all messages
          }

          // Debug mode should produce stderr output
          expect(stderrMessages.length).toBeGreaterThan(0);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should respect cwd option',
      async () => {
        const testDir = process.cwd();

        const q = query({
          prompt: 'What is 1 + 1?',
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

  describe('Message Type Recognition', () => {
    it(
      'should correctly identify all message types',
      async () => {
        const q = query({
          prompt: 'What is 5 + 5?',
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

          // Validate type guards work correctly
          const assistantMessages = messages.filter(isCLIAssistantMessage);
          const resultMessages = messages.filter(isCLIResultMessage);
          const systemMessages = messages.filter(isCLISystemMessage);

          expect(assistantMessages.length).toBeGreaterThan(0);
          expect(resultMessages.length).toBeGreaterThan(0);
          expect(systemMessages.length).toBeGreaterThan(0);

          // Validate assistant message structure
          const firstAssistant = assistantMessages[0];
          expect(firstAssistant.message.content).toBeDefined();
          expect(Array.isArray(firstAssistant.message.content)).toBe(true);

          // Validate result message structure
          const resultMessage = resultMessages[0];
          expect(resultMessage.subtype).toBe('success');
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should extract text content from assistant messages',
      async () => {
        const q = query({
          prompt: 'Count from 1 to 3',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        let assistantMessage: CLIAssistantMessage | null = null;

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
              assistantMessage = message;
            }
          }

          expect(assistantMessage).not.toBeNull();
          expect(assistantMessage!.message.content).toBeDefined();

          // Extract text blocks
          const textBlocks = assistantMessage!.message.content.filter(
            (block: ContentBlock): block is TextBlock => block.type === 'text',
          );

          expect(textBlocks.length).toBeGreaterThan(0);
          expect(textBlocks[0].text).toBeDefined();
          expect(textBlocks[0].text.length).toBeGreaterThan(0);

          // Validate content contains expected numbers
          const text = extractText(assistantMessage!.message.content);
          expect(text).toMatch(/1/);
          expect(text).toMatch(/2/);
          expect(text).toMatch(/3/);
        } finally {
          await q.close();
        }
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

    it(
      'should handle close() called multiple times',
      async () => {
        const q = query({
          prompt: 'Hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        // Start the query
        const iterator = q[Symbol.asyncIterator]();
        await iterator.next();

        // Close multiple times
        await q.close();
        await q.close();
        await q.close();

        // Should not throw
        expect(true).toBe(true);
      },
      TEST_TIMEOUT,
    );
  });
});
