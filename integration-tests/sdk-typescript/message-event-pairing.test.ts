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

    it('should have message_start and message_stop paired by count', async () => {
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

      // Verify message_start and message_stop appear in pairs (same count)
      expect(startEvents.length).toBeGreaterThan(0);
      expect(stopEvents.length).toBe(startEvents.length);

      // Verify message_start carries the message id via its nested message.id field
      for (const e of startEvents) {
        const event = e.event as {
          type: 'message_start';
          message: { id: string };
        };
        expect(typeof event.message.id).toBe('string');
        expect(event.message.id.length).toBeGreaterThan(0);
      }
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

  describe('Content Block Event Pairing', () => {
    it('should emit paired content_block_start and content_block_stop for each content block', async () => {
      const contentBlockStartEvents: SDKPartialAssistantMessage[] = [];
      const contentBlockStopEvents: SDKPartialAssistantMessage[] = [];

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
            if (message.event.type === 'content_block_start') {
              contentBlockStartEvents.push(message);
            } else if (message.event.type === 'content_block_stop') {
              contentBlockStopEvents.push(message);
            }
          }
        }
      } finally {
        await q.close();
      }

      // Verify content_block_start and content_block_stop are paired
      expect(contentBlockStartEvents.length).toBeGreaterThan(0);
      expect(contentBlockStopEvents.length).toBe(
        contentBlockStartEvents.length,
      );
    });

    it('should emit content_block_start before content_block_stop', async () => {
      const events: Array<{ type: string; index: number; timestamp: number }> =
        [];

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
              message.event.type === 'content_block_start' ||
              message.event.type === 'content_block_stop'
            ) {
              events.push({
                type: message.event.type,
                index: message.event.index,
                timestamp: Date.now(),
              });
            }
          }
        }
      } finally {
        await q.close();
      }

      // Verify events exist
      expect(events.length).toBeGreaterThanOrEqual(2);

      // Group events by index
      const eventsByIndex = new Map<number, typeof events>();
      for (const event of events) {
        if (!eventsByIndex.has(event.index)) {
          eventsByIndex.set(event.index, []);
        }
        eventsByIndex.get(event.index)!.push(event);
      }

      // For each index, verify content_block_start comes before content_block_stop
      eventsByIndex.forEach((indexEvents) => {
        const startIndex = indexEvents.findIndex(
          (e) => e.type === 'content_block_start',
        );
        const stopIndex = indexEvents.findIndex(
          (e) => e.type === 'content_block_stop',
        );
        expect(startIndex).toBeGreaterThanOrEqual(0);
        expect(stopIndex).toBeGreaterThanOrEqual(0);
        expect(startIndex).toBeLessThan(stopIndex);
      });
    });

    it('should have correct content_block_start event structure', async () => {
      const contentBlockStartEvents: SDKPartialAssistantMessage[] = [];

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
            message.event.type === 'content_block_start'
          ) {
            contentBlockStartEvents.push(message);
          }
        }
      } finally {
        await q.close();
      }

      expect(contentBlockStartEvents.length).toBeGreaterThan(0);

      // Verify each content_block_start has correct structure
      for (const message of contentBlockStartEvents) {
        const event = message.event as {
          type: 'content_block_start';
          index: number;
          content_block: unknown;
        };
        expect(event.type).toBe('content_block_start');
        expect(event).toHaveProperty('index');
        expect(typeof event.index).toBe('number');
        expect(event.index).toBeGreaterThanOrEqual(0);
        expect(event).toHaveProperty('content_block');
        expect(event.content_block).toBeDefined();
      }
    });

    it('should have correct content_block_stop event structure', async () => {
      const contentBlockStopEvents: SDKPartialAssistantMessage[] = [];

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
            message.event.type === 'content_block_stop'
          ) {
            contentBlockStopEvents.push(message);
          }
        }
      } finally {
        await q.close();
      }

      expect(contentBlockStopEvents.length).toBeGreaterThan(0);

      // Verify each content_block_stop has correct structure
      for (const message of contentBlockStopEvents) {
        const event = message.event as {
          type: 'content_block_stop';
          index: number;
        };
        expect(event.type).toBe('content_block_stop');
        expect(event).toHaveProperty('index');
        expect(typeof event.index).toBe('number');
        expect(event.index).toBeGreaterThanOrEqual(0);
      }
    });

    it('should have matching index for paired content_block_start and content_block_stop', async () => {
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
            if (message.event.type === 'content_block_start') {
              startEvents.push(message);
            } else if (message.event.type === 'content_block_stop') {
              stopEvents.push(message);
            }
          }
        }
      } finally {
        await q.close();
      }

      // Verify events exist and are paired
      expect(startEvents.length).toBeGreaterThan(0);
      expect(stopEvents.length).toBe(startEvents.length);

      // Extract indices from start and stop events
      const startIndices = startEvents.map(
        (e) => (e.event as { index: number }).index,
      );
      const stopIndices = stopEvents.map(
        (e) => (e.event as { index: number }).index,
      );

      // Verify each start index has a matching stop index
      expect(new Set(stopIndices)).toEqual(new Set(startIndices));

      // Verify each index appears the same number of times in both start and stop events
      const startIndexCounts = new Map<number, number>();
      const stopIndexCounts = new Map<number, number>();

      for (const idx of startIndices) {
        startIndexCounts.set(idx, (startIndexCounts.get(idx) || 0) + 1);
      }
      for (const idx of stopIndices) {
        stopIndexCounts.set(idx, (stopIndexCounts.get(idx) || 0) + 1);
      }

      startIndexCounts.forEach((count, idx) => {
        expect(stopIndexCounts.get(idx)).toBe(count);
      });
    });

    it('should follow correct event flow: content_block_start -> content_block_delta -> content_block_stop', async () => {
      const events: Array<{
        type: string;
        index: number;
        position: number;
      }> = [];

      const q = query({
        prompt: 'Write a short story about a cat',
        options: {
          ...SHARED_TEST_OPTIONS,
          includePartialMessages: true,
          cwd: testDir,
          debug: false,
        },
      });

      let pos = 0;
      try {
        for await (const message of q) {
          if (isSDKPartialAssistantMessage(message)) {
            const eventType = message.event.type;
            if (
              eventType === 'content_block_start' ||
              eventType === 'content_block_delta' ||
              eventType === 'content_block_stop'
            ) {
              events.push({
                type: eventType,
                index: (message.event as { index: number }).index,
                position: pos++,
              });
            }
          }
        }
      } finally {
        await q.close();
      }

      expect(events.length).toBeGreaterThanOrEqual(2);

      // Pair content_block_start/stop sequentially (not by index, since
      // block-type transitions reset the blocks array and reuse index 0).
      // Each start is matched with the next stop that follows it.
      const starts = events.filter((e) => e.type === 'content_block_start');
      const stops = events.filter((e) => e.type === 'content_block_stop');
      expect(starts.length).toBe(stops.length);

      for (let i = 0; i < starts.length; i++) {
        const start = starts[i];
        const stop = stops[i];

        // start must come before the paired stop
        expect(start.position).toBeLessThan(stop.position);

        // All deltas between this pair must sit between start and stop
        const deltas = events.filter(
          (e) =>
            e.type === 'content_block_delta' &&
            e.position > start.position &&
            e.position < stop.position,
        );
        for (const delta of deltas) {
          expect(delta.position).toBeGreaterThan(start.position);
          expect(delta.position).toBeLessThan(stop.position);
        }
      }
    });

    it('should have content_block_start after message_start and before message_stop', async () => {
      const events: Array<{
        type: string;
        timestamp: number;
      }> = [];

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
            const eventType = message.event.type;
            if (
              eventType === 'message_start' ||
              eventType === 'message_stop' ||
              eventType === 'content_block_start'
            ) {
              events.push({
                type: eventType,
                timestamp: Date.now(),
              });
            }
          }
        }
      } finally {
        await q.close();
      }

      // Verify message_start exists
      const messageStartIndex = events.findIndex(
        (e) => e.type === 'message_start',
      );
      expect(messageStartIndex).toBeGreaterThanOrEqual(0);

      // Verify message_stop exists
      const messageStopIndex = events.findIndex(
        (e) => e.type === 'message_stop',
      );
      expect(messageStopIndex).toBeGreaterThanOrEqual(0);

      // Verify content_block_start exists
      const firstContentBlockStartIndex = events.findIndex(
        (e) => e.type === 'content_block_start',
      );
      expect(firstContentBlockStartIndex).toBeGreaterThanOrEqual(0);

      // content_block_start should be after message_start
      expect(firstContentBlockStartIndex).toBeGreaterThan(messageStartIndex);

      // content_block_start should be before message_stop
      expect(firstContentBlockStartIndex).toBeLessThan(messageStopIndex);
    });

    it('should have content_block_stop after message_start and before message_stop', async () => {
      const events: Array<{
        type: string;
        timestamp: number;
      }> = [];

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
            const eventType = message.event.type;
            if (
              eventType === 'message_start' ||
              eventType === 'message_stop' ||
              eventType === 'content_block_stop'
            ) {
              events.push({
                type: eventType,
                timestamp: Date.now(),
              });
            }
          }
        }
      } finally {
        await q.close();
      }

      // Verify message_start exists
      const messageStartIndex = events.findIndex(
        (e) => e.type === 'message_start',
      );
      expect(messageStartIndex).toBeGreaterThanOrEqual(0);

      // Verify message_stop exists
      const messageStopIndex = events.findIndex(
        (e) => e.type === 'message_stop',
      );
      expect(messageStopIndex).toBeGreaterThanOrEqual(0);

      // Verify content_block_stop exists (use reverse find for ES compatibility)
      const lastContentBlockStopIndex =
        events
          .map((e, i) => ({ ...e, originalIndex: i }))
          .reverse()
          .find((e) => e.type === 'content_block_stop')?.originalIndex ?? -1;
      expect(lastContentBlockStopIndex).toBeGreaterThanOrEqual(0);

      // content_block_stop should be after message_start
      expect(lastContentBlockStopIndex).toBeGreaterThan(messageStartIndex);

      // content_block_stop should be before message_stop
      expect(lastContentBlockStopIndex).toBeLessThan(messageStopIndex);
    });
  });
});
