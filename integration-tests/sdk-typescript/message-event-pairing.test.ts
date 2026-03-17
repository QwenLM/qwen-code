/**
 * E2E tests for message_start and message_stop event pairing
 * Ensures that message_start and message_stop events are always paired correctly
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  query,
  isSDKPartialAssistantMessage,
  isSDKAssistantMessage,
  type SDKPartialAssistantMessage,
  type TextBlock,
} from '@qwen-code/sdk';
import { SDKTestHelper, createSharedTestOptions } from './test-helper.js';

const SHARED_TEST_OPTIONS = createSharedTestOptions();

describe('Message Start/Stop Event Pairing (E2E)', () => {
  let helper: SDKTestHelper;
  let testDir: string;

  beforeEach(async () => {
    helper = new SDKTestHelper();
    testDir = await helper.setup('message-event-pairing');
  });

  afterEach(async () => {
    await helper.cleanup();
  });

  describe('Basic Message Event Pairing', () => {
    it('should emit paired message_start and message_stop for single turn', async () => {
      const messageStartEvents: SDKPartialAssistantMessage[] = [];
      const messageStopEvents: SDKPartialAssistantMessage[] = [];

      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          includePartialMessages: true,
          cwd: testDir,
          debug: false,
        },
      });

      try {
        for await (const message of q) {
          if (isSDKPartialAssistantMessage(message)) {
            if (message.event.type === 'message_start') {
              messageStartEvents.push(message);
            } else if (message.event.type === 'message_stop') {
              messageStopEvents.push(message);
            }
          }
        }
      } finally {
        await q.close();
      }

      // Verify message_start and message_stop are paired
      expect(messageStartEvents.length).toBeGreaterThan(0);
      expect(messageStopEvents.length).toBe(messageStartEvents.length);
    });

    it('should emit message_start before message_stop', async () => {
      const events: Array<{ type: string; timestamp: number }> = [];

      const q = query({
        prompt: 'Say hello world',
        options: {
          ...SHARED_TEST_OPTIONS,
          includePartialMessages: true,
          cwd: testDir,
          debug: false,
        },
      });

      try {
        for await (const message of q) {
          if (isSDKPartialAssistantMessage(message)) {
            if (
              message.event.type === 'message_start' ||
              message.event.type === 'message_stop'
            ) {
              events.push({
                type: message.event.type,
                timestamp: Date.now(),
              });
            }
          }
        }
      } finally {
        await q.close();
      }

      // Verify message_start comes before message_stop
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].type).toBe('message_start');
      expect(events[events.length - 1].type).toBe('message_stop');
    });

    it('should have matching session_id for paired events', async () => {
      const messageStartEvents: SDKPartialAssistantMessage[] = [];
      const messageStopEvents: SDKPartialAssistantMessage[] = [];

      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          includePartialMessages: true,
          cwd: testDir,
          debug: false,
        },
      });

      try {
        for await (const message of q) {
          if (isSDKPartialAssistantMessage(message)) {
            if (message.event.type === 'message_start') {
              messageStartEvents.push(message);
            } else if (message.event.type === 'message_stop') {
              messageStopEvents.push(message);
            }
          }
        }
      } finally {
        await q.close();
      }

      // Verify session_id matches between paired events
      expect(messageStartEvents.length).toBeGreaterThan(0);
      expect(messageStopEvents.length).toBe(messageStartEvents.length);
      expect(messageStartEvents[0].session_id).toBe(
        messageStopEvents[0].session_id,
      );
    });
  });

  describe('Multi-turn Message Event Pairing', () => {
    it('should emit paired events for each turn in multi-turn conversation', async () => {
      const messageStartEvents: SDKPartialAssistantMessage[] = [];
      const messageStopEvents: SDKPartialAssistantMessage[] = [];
      const assistantMessages: string[] = [];

      const sessionId = crypto.randomUUID();

      const q = query({
        prompt: (async function* () {
          // First turn
          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content: 'Say "first"',
            },
            parent_tool_use_id: null,
          };

          // Wait a bit for processing
          await new Promise((resolve) => setTimeout(resolve, 500));

          // Second turn
          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content: 'Say "second"',
            },
            parent_tool_use_id: null,
          };
        })(),
        options: {
          ...SHARED_TEST_OPTIONS,
          includePartialMessages: true,
          cwd: testDir,
          debug: false,
        },
      });

      try {
        for await (const message of q) {
          if (isSDKPartialAssistantMessage(message)) {
            if (message.event.type === 'message_start') {
              messageStartEvents.push(message);
            } else if (message.event.type === 'message_stop') {
              messageStopEvents.push(message);
            }
          } else if (isSDKAssistantMessage(message)) {
            const text = message.message.content
              .filter((block): block is TextBlock => block.type === 'text')
              .map((block) => block.text)
              .join('');
            assistantMessages.push(text);
          }
        }
      } finally {
        await q.close();
      }

      // Verify we have paired events for each assistant message
      expect(messageStartEvents.length).toBeGreaterThanOrEqual(1);
      expect(messageStopEvents.length).toBe(messageStartEvents.length);
    });
  });

  describe('Message Event Pairing with Tool Calls', () => {
    it('should emit paired events when tool is used', async () => {
      await helper.createFile('test.txt', 'Hello World');

      const messageStartEvents: SDKPartialAssistantMessage[] = [];
      const messageStopEvents: SDKPartialAssistantMessage[] = [];

      const q = query({
        prompt: 'Read the content of test.txt',
        options: {
          ...SHARED_TEST_OPTIONS,
          includePartialMessages: true,
          cwd: testDir,
          coreTools: ['read_file'],
          permissionMode: 'default',
          debug: false,
        },
      });

      try {
        for await (const message of q) {
          if (isSDKPartialAssistantMessage(message)) {
            if (message.event.type === 'message_start') {
              messageStartEvents.push(message);
            } else if (message.event.type === 'message_stop') {
              messageStopEvents.push(message);
            }
          }
        }
      } finally {
        await q.close();
      }

      // Verify message_start and message_stop are paired even with tool usage
      expect(messageStartEvents.length).toBeGreaterThan(0);
      expect(messageStopEvents.length).toBe(messageStartEvents.length);
    });

    it('should maintain event pairing through multiple tool calls', async () => {
      await helper.createFile('file1.txt', 'Content 1');
      await helper.createFile('file2.txt', 'Content 2');

      const messageStartEvents: SDKPartialAssistantMessage[] = [];
      const messageStopEvents: SDKPartialAssistantMessage[] = [];

      const q = query({
        prompt: 'Read file1.txt and file2.txt and summarize their contents',
        options: {
          ...SHARED_TEST_OPTIONS,
          includePartialMessages: true,
          cwd: testDir,
          coreTools: ['read_file'],
          permissionMode: 'default',
          debug: false,
        },
      });

      try {
        for await (const message of q) {
          if (isSDKPartialAssistantMessage(message)) {
            if (message.event.type === 'message_start') {
              messageStartEvents.push(message);
            } else if (message.event.type === 'message_stop') {
              messageStopEvents.push(message);
            }
          }
        }
      } finally {
        await q.close();
      }

      // Verify events are paired
      expect(messageStartEvents.length).toBeGreaterThan(0);
      expect(messageStopEvents.length).toBe(messageStartEvents.length);
    });
  });

  describe('Message Event Structure Validation', () => {
    it('should have correct message_start event structure', async () => {
      const messageStartEvents: SDKPartialAssistantMessage[] = [];

      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          includePartialMessages: true,
          cwd: testDir,
          debug: false,
        },
      });

      try {
        for await (const message of q) {
          if (
            isSDKPartialAssistantMessage(message) &&
            message.event.type === 'message_start'
          ) {
            messageStartEvents.push(message);
          }
        }
      } finally {
        await q.close();
      }

      expect(messageStartEvents.length).toBeGreaterThan(0);
      const startEvent = messageStartEvents[0].event;
      expect(startEvent.type).toBe('message_start');
      if (startEvent.type === 'message_start') {
        expect(startEvent.message).toBeDefined();
        expect(startEvent.message.id).toBeDefined();
        expect(startEvent.message.role).toBe('assistant');
        expect(startEvent.message.model).toBeDefined();
      }
    });

    it('should have correct message_stop event structure', async () => {
      const messageStopEvents: SDKPartialAssistantMessage[] = [];

      const q = query({
        prompt: 'Say hello',
        options: {
          ...SHARED_TEST_OPTIONS,
          includePartialMessages: true,
          cwd: testDir,
          debug: false,
        },
      });

      try {
        for await (const message of q) {
          if (
            isSDKPartialAssistantMessage(message) &&
            message.event.type === 'message_stop'
          ) {
            messageStopEvents.push(message);
          }
        }
      } finally {
        await q.close();
      }

      expect(messageStopEvents.length).toBeGreaterThan(0);
      const event = messageStopEvents[0].event;
      expect(event.type).toBe('message_stop');
    });

    it('should have message_start and message_stop paired by message_id', async () => {
      const startEvents: SDKPartialAssistantMessage[] = [];
      const stopEvents: SDKPartialAssistantMessage[] = [];

      const q = query({
        prompt: 'Say hello world',
        options: {
          ...SHARED_TEST_OPTIONS,
          includePartialMessages: true,
          cwd: testDir,
          debug: false,
        },
      });

      try {
        for await (const message of q) {
          if (isSDKPartialAssistantMessage(message)) {
            if (message.event.type === 'message_start') {
              startEvents.push(message);
            } else if (message.event.type === 'message_stop') {
              stopEvents.push(message);
            }
          }
        }
      } finally {
        await q.close();
      }

      // Verify message_start and message_stop are paired (same count)
      expect(startEvents.length).toBeGreaterThan(0);
      expect(stopEvents.length).toBe(startEvents.length);

      // Verify each message_start has a corresponding message_stop with the same message_id
      const startMessageIds = new Set(
        startEvents.map((e) => (e.event as { message_id?: string }).message_id),
      );
      const stopMessageIds = new Set(
        stopEvents.map((e) => (e.event as { message_id?: string }).message_id),
      );

      // Each message_stop should have the same message_id as a message_start
      startMessageIds.forEach((messageId) => {
        expect(stopMessageIds.has(messageId)).toBe(true);
      });
    });
  });

  describe('Error Scenarios', () => {
    it('should still emit message_stop even when query errors', async () => {
      const messageStartEvents: SDKPartialAssistantMessage[] = [];
      const messageStopEvents: SDKPartialAssistantMessage[] = [];

      // Use an invalid tool to trigger an error scenario
      const q = query({
        prompt: 'Use a non-existent tool',
        options: {
          ...SHARED_TEST_OPTIONS,
          includePartialMessages: true,
          cwd: testDir,
          coreTools: [], // No tools available
          debug: false,
        },
      });

      try {
        for await (const message of q) {
          if (isSDKPartialAssistantMessage(message)) {
            if (message.event.type === 'message_start') {
              messageStartEvents.push(message);
            } else if (message.event.type === 'message_stop') {
              messageStopEvents.push(message);
            }
          }
        }
      } catch {
        // Expected to potentially have errors
      } finally {
        await q.close();
      }

      // Even in error scenarios, if message_start was emitted, message_stop should also be emitted
      if (messageStartEvents.length > 0) {
        expect(messageStopEvents.length).toBe(messageStartEvents.length);
      }
    });
  });
});
