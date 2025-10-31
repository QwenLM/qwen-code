/**
 * E2E tests based on multi-turn.ts example
 * Tests multi-turn conversation functionality with real CLI
 */

import { describe, it, expect } from 'vitest';
import { query } from '../../src/index.js';
import {
  isCLIUserMessage,
  isCLIAssistantMessage,
  isCLISystemMessage,
  isCLIResultMessage,
  isCLIPartialAssistantMessage,
  isControlRequest,
  isControlResponse,
  isControlCancel,
  type CLIUserMessage,
  type CLIAssistantMessage,
  type TextBlock,
  type ContentBlock,
  type CLIMessage,
  type ControlMessage,
  type ToolUseBlock,
} from '../../src/types/protocol.js';

// Test configuration
const TEST_CLI_PATH =
  '/Users/mingholy/Work/Projects/qwen-code/packages/cli/index.ts';
const TEST_TIMEOUT = 60000; // Longer timeout for multi-turn conversations

// Shared test options with permissionMode to allow all tools
const SHARED_TEST_OPTIONS = {
  pathToQwenExecutable: TEST_CLI_PATH,
  permissionMode: 'yolo' as const,
};

/**
 * Determine the message type using protocol type guards
 */
function getMessageType(message: CLIMessage | ControlMessage): string {
  if (isCLIUserMessage(message)) {
    return '🧑 USER';
  } else if (isCLIAssistantMessage(message)) {
    return '🤖 ASSISTANT';
  } else if (isCLISystemMessage(message)) {
    return `🖥️ SYSTEM(${message.subtype})`;
  } else if (isCLIResultMessage(message)) {
    return `✅ RESULT(${message.subtype})`;
  } else if (isCLIPartialAssistantMessage(message)) {
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
  describe('AsyncIterable Prompt Support', () => {
    it(
      'should handle multi-turn conversation using AsyncIterable prompt',
      async () => {
        // Create multi-turn conversation generator
        async function* createMultiTurnConversation(): AsyncIterable<CLIUserMessage> {
          const sessionId = crypto.randomUUID();

          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content:
                'What is the name of this project? Check the package.json file.',
            },
            parent_tool_use_id: null,
          } as CLIUserMessage;

          // Wait a bit to simulate user thinking time
          await new Promise((resolve) => setTimeout(resolve, 100));

          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content: 'What version is it currently on?',
            },
            parent_tool_use_id: null,
          } as CLIUserMessage;

          await new Promise((resolve) => setTimeout(resolve, 100));

          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content: 'What are the main dependencies?',
            },
            parent_tool_use_id: null,
          } as CLIUserMessage;
        }

        // Create multi-turn query using AsyncIterable prompt
        const q = query({
          prompt: createMultiTurnConversation(),
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: process.cwd(),
            debug: false,
          },
        });

        const messages: CLIMessage[] = [];
        const assistantMessages: CLIAssistantMessage[] = [];
        let turnCount = 0;

        try {
          for await (const message of q) {
            messages.push(message);

            if (isCLIAssistantMessage(message)) {
              assistantMessages.push(message);
              const text = extractText(message.message.content);
              expect(text.length).toBeGreaterThan(0);
              turnCount++;
            }
          }

          expect(messages.length).toBeGreaterThan(0);
          expect(assistantMessages.length).toBeGreaterThanOrEqual(3); // Should have responses to all 3 questions
          expect(turnCount).toBeGreaterThanOrEqual(3);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should maintain session context across turns',
      async () => {
        async function* createContextualConversation(): AsyncIterable<CLIUserMessage> {
          const sessionId = crypto.randomUUID();

          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content:
                'My name is Alice. Remember this during our current conversation.',
            },
            parent_tool_use_id: null,
          } as CLIUserMessage;

          await new Promise((resolve) => setTimeout(resolve, 200));

          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content: 'What is my name?',
            },
            parent_tool_use_id: null,
          } as CLIUserMessage;
        }

        const q = query({
          prompt: createContextualConversation(),
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        const assistantMessages: CLIAssistantMessage[] = [];

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
              assistantMessages.push(message);
            }
          }

          expect(assistantMessages.length).toBeGreaterThanOrEqual(2);

          // The second response should reference the name Alice
          const secondResponse = extractText(
            assistantMessages[1].message.content,
          );
          expect(secondResponse.toLowerCase()).toContain('alice');
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Tool Usage in Multi-Turn', () => {
    it(
      'should handle tool usage across multiple turns',
      async () => {
        async function* createToolConversation(): AsyncIterable<CLIUserMessage> {
          const sessionId = crypto.randomUUID();

          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content: 'List the files in the current directory',
            },
            parent_tool_use_id: null,
          } as CLIUserMessage;

          await new Promise((resolve) => setTimeout(resolve, 200));

          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content: 'Now tell me about the package.json file specifically',
            },
            parent_tool_use_id: null,
          } as CLIUserMessage;
        }

        const q = query({
          prompt: createToolConversation(),
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: process.cwd(),
            debug: false,
          },
        });

        const messages: CLIMessage[] = [];
        let toolUseCount = 0;
        let assistantCount = 0;

        try {
          for await (const message of q) {
            messages.push(message);

            if (isCLIAssistantMessage(message)) {
              const hasToolUseBlock = message.message.content.some(
                (block: ContentBlock): block is ToolUseBlock =>
                  block.type === 'tool_use',
              );
              if (hasToolUseBlock) {
                toolUseCount++;
              }
            }

            if (isCLIAssistantMessage(message)) {
              assistantCount++;
            }

            if (isCLIResultMessage(message)) {
              break;
            }
          }

          expect(messages.length).toBeGreaterThan(0);
          expect(toolUseCount).toBeGreaterThan(0); // Should use tools
          expect(assistantCount).toBeGreaterThanOrEqual(2); // Should have responses to both questions
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Message Flow and Sequencing', () => {
    it(
      'should process messages in correct sequence',
      async () => {
        async function* createSequentialConversation(): AsyncIterable<CLIUserMessage> {
          const sessionId = crypto.randomUUID();

          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content: 'First question: What is 1 + 1?',
            },
            parent_tool_use_id: null,
          } as CLIUserMessage;

          await new Promise((resolve) => setTimeout(resolve, 100));

          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content: 'Second question: What is 2 + 2?',
            },
            parent_tool_use_id: null,
          } as CLIUserMessage;
        }

        const q = query({
          prompt: createSequentialConversation(),
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        const messageSequence: string[] = [];
        const assistantResponses: string[] = [];

        try {
          for await (const message of q) {
            const messageType = getMessageType(message);
            messageSequence.push(messageType);

            if (isCLIAssistantMessage(message)) {
              const text = extractText(message.message.content);
              assistantResponses.push(text);
            }
          }

          expect(messageSequence.length).toBeGreaterThan(0);
          expect(assistantResponses.length).toBeGreaterThanOrEqual(2);

          // Should end with result
          expect(messageSequence[messageSequence.length - 1]).toContain(
            'RESULT',
          );

          // Should have assistant responses
          expect(
            messageSequence.some((type) => type.includes('ASSISTANT')),
          ).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle conversation completion correctly',
      async () => {
        async function* createSimpleConversation(): AsyncIterable<CLIUserMessage> {
          const sessionId = crypto.randomUUID();

          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content: 'Hello',
            },
            parent_tool_use_id: null,
          } as CLIUserMessage;

          await new Promise((resolve) => setTimeout(resolve, 100));

          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content: 'Goodbye',
            },
            parent_tool_use_id: null,
          } as CLIUserMessage;
        }

        const q = query({
          prompt: createSimpleConversation(),
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

  describe('Error Handling in Multi-Turn', () => {
    it(
      'should handle empty conversation gracefully',
      async () => {
        async function* createEmptyConversation(): AsyncIterable<CLIUserMessage> {
          // Generator that yields nothing
          /* eslint-disable no-constant-condition */
          if (false) {
            yield {} as CLIUserMessage; // Unreachable, but satisfies TypeScript
          }
        }

        const q = query({
          prompt: createEmptyConversation(),
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

          // Should handle empty conversation without crashing
          expect(true).toBe(true);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle conversation with delays',
      async () => {
        async function* createDelayedConversation(): AsyncIterable<CLIUserMessage> {
          const sessionId = crypto.randomUUID();

          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content: 'First message',
            },
            parent_tool_use_id: null,
          } as CLIUserMessage;

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
          } as CLIUserMessage;
        }

        const q = query({
          prompt: createDelayedConversation(),
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        const assistantMessages: CLIAssistantMessage[] = [];

        try {
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
              assistantMessages.push(message);
            }
          }

          expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });
});
