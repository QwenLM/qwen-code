/**
 * E2E tests for single-turn query execution
 * Tests basic query patterns with simple prompts and clear output expectations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  query,
  isSDKAssistantMessage,
  isSDKSystemMessage,
  isSDKResultMessage,
  isSDKPartialAssistantMessage,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKAssistantMessage,
} from '@qwen-code/sdk';
import {
  SDKTestHelper,
  extractText,
  createSharedTestOptions,
  assertSuccessfulCompletion,
  collectMessagesByType,
} from './test-helper.js';

const SHARED_TEST_OPTIONS = createSharedTestOptions();

describe('Single-Turn Query (E2E)', () => {
  let helper: SDKTestHelper;
  let testDir: string;

  beforeEach(async () => {
    helper = new SDKTestHelper();
    testDir = await helper.setup('single-turn');
  });

  afterEach(async () => {
    await helper.cleanup();
  });
  describe('Simple Text Queries', () => {
    it('should answer basic arithmetic question', async () => {
      const q = query({
        prompt: 'What is 2 + 2? Just give me the number.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: true,
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

        // Validate we got messages
        expect(messages.length).toBeGreaterThan(0);

        // Validate assistant response content
        expect(assistantText.length).toBeGreaterThan(0);
        expect(assistantText).toMatch(/4/);

        // Validate message flow ends with success
        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });

    it('should answer simple factual question', async () => {
      const q = query({
        prompt: 'What is the capital of France? One word answer.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
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

        // Validate content
        expect(assistantText.length).toBeGreaterThan(0);
        expect(assistantText.toLowerCase()).toContain('paris');

        // Validate completion
        assertSuccessfulCompletion(messages);
      } finally {
        await q.close();
      }
    });

    it('should handle greeting and self-description', async () => {
      const q = query({
        prompt: 'Say hello and tell me your name in one sentence.',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
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

        // Validate content contains greeting
        expect(assistantText.length).toBeGreaterThan(0);
        expect(assistantText.toLowerCase()).toMatch(/hello|hi|greetings/);

        // Validate message types
        const assistantMessages = collectMessagesByType(
          messages,
          isSDKAssistantMessage,
        );
        expect(assistantMessages.length).toBeGreaterThan(0);
      } finally {
        await q.close();
      }
    });
  });

  describe('System Initialization', () => {
    it('should receive system message with initialization info', async () => {
      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];
      let systemMessage: SDKSystemMessage | null = null;

      try {
        for await (const message of q) {
          messages.push(message);

          if (isSDKSystemMessage(message) && message.subtype === 'init') {
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
        expect(systemMessage!.permission_mode).toBeDefined();
        expect(systemMessage!.qwen_code_version).toBeDefined();

        // Validate system message appears early in sequence
        const systemMessageIndex = messages.findIndex(
          (msg) => isSDKSystemMessage(msg) && msg.subtype === 'init',
        );
        expect(systemMessageIndex).toBeGreaterThanOrEqual(0);
        expect(systemMessageIndex).toBeLessThan(3);
      } finally {
        await q.close();
      }
    });

    it('should maintain session ID consistency', async () => {
      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      let systemMessage: SDKSystemMessage | null = null;
      const sessionId = q.getSessionId();

      try {
        for await (const message of q) {
          if (isSDKSystemMessage(message) && message.subtype === 'init') {
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
    });
  });

  describe('Message Flow', () => {
    it('should follow expected message sequence', async () => {
      const q = query({
        prompt: 'Say hi',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
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
    });

    it('should complete iteration naturally', async () => {
      const q = query({
        prompt: 'Say goodbye',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      let completedNaturally = false;
      let messageCount = 0;

      try {
        for await (const message of q) {
          messageCount++;

          if (isSDKResultMessage(message)) {
            completedNaturally = true;
            expect(message.subtype).toBe('success');
          }
        }

        expect(messageCount).toBeGreaterThan(0);
        expect(completedNaturally).toBe(true);
      } finally {
        await q.close();
      }
    });
  });

  describe('Configuration Options', () => {
    it('should respect debug option and capture stderr', async () => {
      const stderrMessages: string[] = [];

      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: true,
          stderr: (msg: string) => {
            stderrMessages.push(msg);
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
    });

    it('should respect cwd option', async () => {
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
          if (isSDKAssistantMessage(message)) {
            hasResponse = true;
          }
        }

        expect(hasResponse).toBe(true);
      } finally {
        await q.close();
      }
    });

    it('should receive partial messages when includePartialMessages is enabled', async () => {
      const q = query({
        prompt: 'Count from 1 to 5',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          includePartialMessages: true,
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];
      let partialMessageCount = 0;
      let assistantMessageCount = 0;

      try {
        for await (const message of q) {
          messages.push(message);

          if (isSDKPartialAssistantMessage(message)) {
            partialMessageCount++;
          }

          if (isSDKAssistantMessage(message)) {
            assistantMessageCount++;
          }
        }

        expect(messages.length).toBeGreaterThan(0);
        expect(partialMessageCount).toBeGreaterThan(0);
        expect(assistantMessageCount).toBeGreaterThan(0);
      } finally {
        await q.close();
      }
    });
  });

  describe('Message Type Recognition', () => {
    it('should correctly identify all message types', async () => {
      const q = query({
        prompt: 'What is 5 + 5?',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);
        }

        // Validate type guards work correctly
        const assistantMessages = collectMessagesByType(
          messages,
          isSDKAssistantMessage,
        );
        const resultMessages = collectMessagesByType(
          messages,
          isSDKResultMessage,
        );
        const systemMessages = collectMessagesByType(
          messages,
          isSDKSystemMessage,
        );

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
    });

    it('should extract text content from assistant messages', async () => {
      const q = query({
        prompt: 'Count from 1 to 3',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      let assistantMessage: SDKAssistantMessage | null = null;

      try {
        for await (const message of q) {
          if (isSDKAssistantMessage(message)) {
            assistantMessage = message;
          }
        }

        expect(assistantMessage).not.toBeNull();
        expect(assistantMessage!.message.content).toBeDefined();

        // Validate content contains expected numbers
        const text = extractText(assistantMessage!.message.content);
        expect(text.length).toBeGreaterThan(0);
        expect(text).toMatch(/1/);
        expect(text).toMatch(/2/);
        expect(text).toMatch(/3/);
      } finally {
        await q.close();
      }
    });
  });

  describe('Error Handling', () => {
    it('should throw if CLI not found', async () => {
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
    });
  });

  describe('Resource Management', () => {
    it('should cleanup subprocess on close()', async () => {
      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      // Start and immediately close
      const iterator = q[Symbol.asyncIterator]();
      await iterator.next();

      // Should close without error
      await q.close();
      expect(true).toBe(true); // Cleanup completed
    });

    it('should handle close() called multiple times', async () => {
      const q = query({
        prompt: 'Hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
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
    });
  });
});
