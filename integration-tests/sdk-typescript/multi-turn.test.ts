/**
 * E2E tests based on multi-turn.ts example
 * Tests multi-turn conversation functionality with real CLI
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  query,
  isSDKUserMessage,
  isSDKAssistantMessage,
  isSDKSystemMessage,
  isSDKResultMessage,
  isSDKPartialAssistantMessage,
  isControlRequest,
  isControlResponse,
  isControlCancel,
  type SDKUserMessage,
  type SDKAssistantMessage,
  type TextBlock,
  type ContentBlock,
  type SDKMessage,
  type ControlMessage,
  type ToolUseBlock,
} from '@qwen-code/sdk';
import { SDKTestHelper, createSharedTestOptions } from './test-helper.js';

const SHARED_TEST_OPTIONS = createSharedTestOptions();

/**
 * Determine the message type using protocol type guards
 */
function getMessageType(message: SDKMessage | ControlMessage): string {
  if (isSDKUserMessage(message)) {
    return '🧑 USER';
  } else if (isSDKAssistantMessage(message)) {
    return '🤖 ASSISTANT';
  } else if (isSDKSystemMessage(message)) {
    return `🖥️ SYSTEM(${message.subtype})`;
  } else if (isSDKResultMessage(message)) {
    return `✅ RESULT(${message.subtype})`;
  } else if (isSDKPartialAssistantMessage(message)) {
    return '⏳ STREAM_EVENT';
  } else if (isControlRequest(message)) {
    return `🎮 CONTROL_REQUEST(${message.request.subtype})`;
  } else if (isControlResponse(message)) {
    return `📭 CONTROL_RESPONSE(${message.response.subtype})`;
  } else if (isControlCancel(message)) {
    return '🛑 CONTROL_CANCEL';
  } else {
    return '❓ UNKNOWN';
  }
}

/**
 * Helper to extract text from ContentBlock array
 */
function extractText(content: ContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

describe('Multi-Turn Conversations (E2E)', () => {
  let helper: SDKTestHelper;
  let testDir: string;

  beforeEach(async () => {
    helper = new SDKTestHelper();
    testDir = await helper.setup('multi-turn');
  });

  afterEach(async () => {
    await helper.cleanup();
  });

  describe('AsyncIterable Prompt Support', () => {
    it('should handle multi-turn conversation using AsyncIterable prompt', async () => {
      // Create multi-turn conversation generator
      async function* createMultiTurnConversation(): AsyncIterable<SDKUserMessage> {
        const sessionId = crypto.randomUUID();

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: 'What is 1 + 1?',
          },
          parent_tool_use_id: null,
        } as SDKUserMessage;

        await new Promise((resolve) => setTimeout(resolve, 100));

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: 'What is 2 + 2?',
          },
          parent_tool_use_id: null,
        } as SDKUserMessage;

        await new Promise((resolve) => setTimeout(resolve, 100));

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: 'What is 3 + 3?',
          },
          parent_tool_use_id: null,
        } as SDKUserMessage;
      }

      // Create multi-turn query using AsyncIterable prompt
      const q = query({
        prompt: createMultiTurnConversation(),
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];
      const assistantMessages: SDKAssistantMessage[] = [];
      const assistantTexts: string[] = [];

      try {
        for await (const message of q) {
          messages.push(message);

          if (isSDKAssistantMessage(message)) {
            assistantMessages.push(message);
            const text = extractText(message.message.content);
            assistantTexts.push(text);
          }
        }

        expect(messages.length).toBeGreaterThan(0);
        expect(assistantMessages.length).toBeGreaterThanOrEqual(3);

        // Validate content of responses
        expect(assistantTexts[0]).toMatch(/2/);
        expect(assistantTexts[1]).toMatch(/4/);
        expect(assistantTexts[2]).toMatch(/6/);
      } finally {
        await q.close();
      }
    });

    it('should maintain session context across turns', async () => {
      async function* createContextualConversation(): AsyncIterable<SDKUserMessage> {
        const sessionId = crypto.randomUUID();

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content:
              'Suppose we have 3 rabbits and 4 carrots. How many animals are there?',
          },
          parent_tool_use_id: null,
        } as SDKUserMessage;

        await new Promise((resolve) => setTimeout(resolve, 200));

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: 'How many animals are there? Only output the number',
          },
          parent_tool_use_id: null,
        } as SDKUserMessage;
      }

      const q = query({
        prompt: createContextualConversation(),
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      const assistantMessages: SDKAssistantMessage[] = [];

      try {
        for await (const message of q) {
          if (isSDKAssistantMessage(message)) {
            assistantMessages.push(message);
          }
        }

        expect(assistantMessages.length).toBeGreaterThanOrEqual(2);

        // The second response should reference the color blue
        const secondResponse = extractText(
          assistantMessages[1].message.content,
        );
        expect(secondResponse.toLowerCase()).toContain('3');
      } finally {
        await q.close();
      }
    });
  });

  describe('Tool Usage in Multi-Turn', () => {
    it('should handle tool usage across multiple turns', async () => {
      async function* createToolConversation(): AsyncIterable<SDKUserMessage> {
        const sessionId = crypto.randomUUID();

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: 'Create a file named test.txt with content "hello"',
          },
          parent_tool_use_id: null,
        } as SDKUserMessage;

        await new Promise((resolve) => setTimeout(resolve, 200));

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: 'Now read the test.txt file',
          },
          parent_tool_use_id: null,
        } as SDKUserMessage;
      }

      const q = query({
        prompt: createToolConversation(),
        options: {
          ...SHARED_TEST_OPTIONS,
          permissionMode: 'yolo',
          cwd: testDir,
          debug: false,
        },
      });

      const messages: SDKMessage[] = [];
      let toolUseCount = 0;
      const assistantMessages: SDKAssistantMessage[] = [];

      try {
        for await (const message of q) {
          messages.push(message);

          if (isSDKAssistantMessage(message)) {
            assistantMessages.push(message);
            const hasToolUseBlock = message.message.content.some(
              (block: ContentBlock): block is ToolUseBlock =>
                block.type === 'tool_use',
            );
            if (hasToolUseBlock) {
              toolUseCount++;
            }
          }
        }

        expect(messages.length).toBeGreaterThan(0);
        expect(toolUseCount).toBeGreaterThan(0);
        expect(assistantMessages.length).toBeGreaterThanOrEqual(2);

        // Validate second response mentions the file content
        const secondResponse = extractText(
          assistantMessages[assistantMessages.length - 1].message.content,
        );
        expect(secondResponse.toLowerCase()).toMatch(/hello|test\.txt/);
      } finally {
        await q.close();
      }
    });
  });

  describe('Message Flow and Sequencing', () => {
    it('should process messages in correct sequence', async () => {
      async function* createSequentialConversation(): AsyncIterable<SDKUserMessage> {
        const sessionId = crypto.randomUUID();

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: 'First question: What is 1 + 1?',
          },
          parent_tool_use_id: null,
        } as SDKUserMessage;

        await new Promise((resolve) => setTimeout(resolve, 100));

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: 'Second question: What is 2 + 2?',
          },
          parent_tool_use_id: null,
        } as SDKUserMessage;
      }

      const q = query({
        prompt: createSequentialConversation(),
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      const messageSequence: string[] = [];
      const assistantResponses: string[] = [];

      try {
        for await (const message of q) {
          const messageType = getMessageType(message);
          messageSequence.push(messageType);

          if (isSDKAssistantMessage(message)) {
            const text = extractText(message.message.content);
            assistantResponses.push(text);
          }
        }

        expect(messageSequence.length).toBeGreaterThan(0);
        expect(assistantResponses.length).toBeGreaterThanOrEqual(2);

        // Should end with result
        expect(messageSequence[messageSequence.length - 1]).toContain('RESULT');

        // Should have assistant responses
        expect(messageSequence.some((type) => type.includes('ASSISTANT'))).toBe(
          true,
        );
      } finally {
        await q.close();
      }
    });

    it('should handle conversation completion correctly', async () => {
      async function* createSimpleConversation(): AsyncIterable<SDKUserMessage> {
        const sessionId = crypto.randomUUID();

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: 'Hello',
          },
          parent_tool_use_id: null,
        } as SDKUserMessage;

        await new Promise((resolve) => setTimeout(resolve, 100));

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: 'Goodbye',
          },
          parent_tool_use_id: null,
        } as SDKUserMessage;
      }

      const q = query({
        prompt: createSimpleConversation(),
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

  describe('Error Handling in Multi-Turn', () => {
    it('should handle empty conversation gracefully', async () => {
      async function* createEmptyConversation(): AsyncIterable<SDKUserMessage> {
        // Generator that yields nothing
        /* eslint-disable no-constant-condition */
        if (false) {
          yield {} as SDKUserMessage; // Unreachable, but satisfies TypeScript
        }
      }

      const q = query({
        prompt: createEmptyConversation(),
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

        // Should handle empty conversation without crashing
        expect(true).toBe(true);
      } finally {
        await q.close();
      }
    });

    it('should handle conversation with delays', async () => {
      async function* createDelayedConversation(): AsyncIterable<SDKUserMessage> {
        const sessionId = crypto.randomUUID();

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: 'First message',
          },
          parent_tool_use_id: null,
        } as SDKUserMessage;

        // Longer delay to test patience
        await new Promise((resolve) => setTimeout(resolve, 500));

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: 'Second message after delay',
          },
          parent_tool_use_id: null,
        } as SDKUserMessage;
      }

      const q = query({
        prompt: createDelayedConversation(),
        options: {
          ...SHARED_TEST_OPTIONS,
          cwd: testDir,
          debug: false,
        },
      });

      const assistantMessages: SDKAssistantMessage[] = [];

      try {
        for await (const message of q) {
          if (isSDKAssistantMessage(message)) {
            assistantMessages.push(message);
          }
        }

        expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
      } finally {
        await q.close();
      }
    });
  });

  describe('Partial Messages in Multi-Turn', () => {
    it('should receive partial messages when includePartialMessages is enabled', async () => {
      async function* createMultiTurnConversation(): AsyncIterable<SDKUserMessage> {
        const sessionId = crypto.randomUUID();

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: 'What is 1 + 1?',
          },
          parent_tool_use_id: null,
        } as SDKUserMessage;

        await new Promise((resolve) => setTimeout(resolve, 100));

        yield {
          type: 'user',
          session_id: sessionId,
          message: {
            role: 'user',
            content: 'What is 2 + 2?',
          },
          parent_tool_use_id: null,
        } as SDKUserMessage;
      }

      const q = query({
        prompt: createMultiTurnConversation(),
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
        expect(assistantMessageCount).toBeGreaterThanOrEqual(2);
      } finally {
        await q.close();
      }
    });
  });
});
