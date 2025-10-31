/**
 * E2E tests based on basic-usage.ts example
 * Tests message type recognition and basic query patterns
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
  type TextBlock,
  type ContentBlock,
  type CLIMessage,
  type ControlMessage,
  type CLISystemMessage,
  type CLIUserMessage,
  type CLIAssistantMessage,
  type ToolUseBlock,
  type ToolResultBlock,
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

describe('Basic Usage (E2E)', () => {
  describe('Message Type Recognition', () => {
    it(
      'should correctly identify message types using type guards',
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
        const messageTypes: string[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
            const messageType = getMessageType(message);
            messageTypes.push(messageType);

            if (isCLIResultMessage(message)) {
              break;
            }
          }

          expect(messages.length).toBeGreaterThan(0);
          expect(messageTypes.length).toBe(messages.length);

          // Should have at least assistant and result messages
          expect(messageTypes.some((type) => type.includes('ASSISTANT'))).toBe(
            true,
          );
          expect(messageTypes.some((type) => type.includes('RESULT'))).toBe(
            true,
          );

          // Verify type guards work correctly
          const assistantMessages = messages.filter(isCLIAssistantMessage);
          const resultMessages = messages.filter(isCLIResultMessage);

          expect(assistantMessages.length).toBeGreaterThan(0);
          expect(resultMessages.length).toBeGreaterThan(0);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle message content extraction',
      async () => {
        const q = query({
          prompt: 'Say hello and explain what you are',
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
              break;
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
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Basic Query Patterns', () => {
    it(
      'should handle simple question-answer pattern',
      async () => {
        const q = query({
          prompt: 'What is 2 + 2?',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: true,
          },
        });

        const messages: CLIMessage[] = [];

        try {
          for await (const message of q) {
            messages.push(message);
          }

          expect(messages.length).toBeGreaterThan(0);

          // Should have assistant response
          const assistantMessages = messages.filter(isCLIAssistantMessage);
          expect(assistantMessages.length).toBeGreaterThan(0);

          // Should end with result
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
      'should handle file system query pattern',
      async () => {
        const q = query({
          prompt:
            'What files are in the current directory? List only the top-level files and folders.',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: process.cwd(),
            debug: true,
          },
        });

        const messages: CLIMessage[] = [];
        let hasToolUse = false;
        let hasToolResult = false;

        try {
          for await (const message of q) {
            messages.push(message);

            if (isCLIAssistantMessage(message)) {
              const toolUseBlock = message.message.content.find(
                (block: ContentBlock): block is ToolUseBlock =>
                  block.type === 'tool_use',
              );
              if (toolUseBlock) {
                hasToolUse = true;
                expect(toolUseBlock.name).toBeDefined();
                expect(toolUseBlock.id).toBeDefined();
              }
            }

            if (isCLIUserMessage(message)) {
              // Tool results are sent as user messages with ToolResultBlock[] content
              if (Array.isArray(message.message.content)) {
                const toolResultBlock = message.message.content.find(
                  (block: ToolResultBlock): block is ToolResultBlock =>
                    block.type === 'tool_result',
                );
                if (toolResultBlock) {
                  hasToolResult = true;
                  expect(toolResultBlock.tool_use_id).toBeDefined();
                  expect(toolResultBlock.content).toBeDefined();
                }
              }
            }

            if (isCLIResultMessage(message)) {
              break;
            }
          }

          expect(messages.length).toBeGreaterThan(0);
          expect(hasToolUse).toBe(true);
          expect(hasToolResult).toBe(true);

          // Should have assistant response after tool execution
          const assistantMessages = messages.filter(isCLIAssistantMessage);
          expect(assistantMessages.length).toBeGreaterThan(0);
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Configuration and Options', () => {
    it(
      'should respect debug option',
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
          for await (const message of q) {
            if (isCLIAssistantMessage(message)) {
              break;
            }
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
        const q = query({
          prompt: 'List files in current directory',
          options: {
            ...SHARED_TEST_OPTIONS,
            cwd: process.cwd(),
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

  describe('SDK-CLI Handshaking Process', () => {
    it(
      'should receive system message after initialization',
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

            // Capture system message
            if (isCLISystemMessage(message) && message.subtype === 'init') {
              systemMessage = message;
              break; // Exit early once we get the system message
            }

            // Stop after getting assistant response to avoid long execution
            if (isCLIAssistantMessage(message)) {
              break;
            }
          }

          // Verify system message was received after initialization
          expect(systemMessage).not.toBeNull();
          expect(systemMessage!.type).toBe('system');
          expect(systemMessage!.subtype).toBe('init');

          // Validate system message structure matches sendSystemMessage()
          expect(systemMessage!.uuid).toBeDefined();
          expect(systemMessage!.session_id).toBeDefined();
          expect(systemMessage!.cwd).toBeDefined();
          expect(systemMessage!.tools).toBeDefined();
          expect(Array.isArray(systemMessage!.tools)).toBe(true);
          expect(systemMessage!.mcp_servers).toBeDefined();
          expect(Array.isArray(systemMessage!.mcp_servers)).toBe(true);
          expect(systemMessage!.model).toBeDefined();
          expect(systemMessage!.permissionMode).toBeDefined();
          expect(systemMessage!.slash_commands).toBeDefined();
          expect(Array.isArray(systemMessage!.slash_commands)).toBe(true);
          expect(systemMessage!.apiKeySource).toBeDefined();
          expect(systemMessage!.qwen_code_version).toBeDefined();
          expect(systemMessage!.output_style).toBeDefined();
          expect(systemMessage!.agents).toBeDefined();
          expect(Array.isArray(systemMessage!.agents)).toBe(true);
          expect(systemMessage!.skills).toBeDefined();
          expect(Array.isArray(systemMessage!.skills)).toBe(true);

          // Verify system message appears early in the message sequence
          const systemMessageIndex = messages.findIndex(
            (msg) => isCLISystemMessage(msg) && msg.subtype === 'init',
          );
          expect(systemMessageIndex).toBeGreaterThanOrEqual(0);
          expect(systemMessageIndex).toBeLessThan(3); // Should be one of the first few messages
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle initialization with session ID consistency',
      async () => {
        const q = query({
          prompt: 'Hello',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        let systemMessage: CLISystemMessage | null = null;
        let userMessage: CLIUserMessage | null = null;
        const sessionId = q.getSessionId();

        try {
          for await (const message of q) {
            // Capture system message
            if (isCLISystemMessage(message) && message.subtype === 'init') {
              systemMessage = message;
            }

            // Capture user message
            if (isCLIUserMessage(message)) {
              userMessage = message;
            }

            // Stop after getting assistant response to avoid long execution
            if (isCLIAssistantMessage(message)) {
              break;
            }
          }

          // Verify session IDs are consistent within the system
          expect(sessionId).toBeDefined();
          expect(systemMessage).not.toBeNull();
          expect(systemMessage!.session_id).toBeDefined();
          expect(systemMessage!.uuid).toBeDefined();

          // System message should have consistent session_id and uuid
          expect(systemMessage!.session_id).toBe(systemMessage!.uuid);

          if (userMessage) {
            expect(userMessage.session_id).toBeDefined();
            // User message should have the same session_id as system message
            expect(userMessage.session_id).toBe(systemMessage!.session_id);
          }
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Message Flow Validation', () => {
    it(
      'should follow expected message sequence',
      async () => {
        const q = query({
          prompt: 'What is the current time?',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: false,
          },
        });

        const messageSequence: string[] = [];

        try {
          for await (const message of q) {
            messageSequence.push(message.type);

            if (isCLIResultMessage(message)) {
              break;
            }
          }

          expect(messageSequence.length).toBeGreaterThan(0);

          // Should end with result
          expect(messageSequence[messageSequence.length - 1]).toBe('result');

          // Should have at least one assistant message
          expect(messageSequence).toContain('assistant');
        } finally {
          await q.close();
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle graceful completion',
      async () => {
        const q = query({
          prompt: 'Say goodbye',
          options: {
            ...SHARED_TEST_OPTIONS,
            debug: true,
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
});
