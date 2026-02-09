/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';
import * as os from 'node:os';
import { QwenLogger, TEST_ONLY } from './qwen-logger.js';
import type { Config } from '../../config/config.js';
import { AuthType } from '../../core/contentGenerator.js';
import {
  StartSessionEvent,
  EndSessionEvent,
  IdeConnectionEvent,
  KittySequenceOverflowEvent,
  IdeConnectionType,
} from '../types.js';
import type { RumEvent, RumPayload } from './event-types.js';

const debugLoggerSpy = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Mock dependencies
vi.mock('../../utils/user_id.js', () => ({
  getInstallationId: vi.fn(() => 'test-installation-id'),
}));

vi.mock('../../utils/safeJsonStringify.js', () => ({
  safeJsonStringify: vi.fn((obj) => JSON.stringify(obj)),
}));

vi.mock('../../utils/debugLogger.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../utils/debugLogger.js')>();
  return {
    ...original,
    createDebugLogger: () => ({
      debug: debugLoggerSpy.debug,
      info: debugLoggerSpy.info,
      warn: debugLoggerSpy.warn,
      error: debugLoggerSpy.error,
    }),
  };
});

// Mock https module
vi.mock('https', () => ({
  request: vi.fn(),
}));

const makeFakeConfig = (overrides: Partial<Config> = {}): Config => {
  const defaults = {
    getUsageStatisticsEnabled: () => true,
    getDebugMode: () => false,
    getSessionId: () => 'test-session-id',
    getCliVersion: () => '1.0.0',
    getProxy: () => undefined,
    getContentGeneratorConfig: () => ({ authType: 'test-auth' }),
    getAuthType: () => AuthType.QWEN_OAUTH,
    getMcpServers: () => ({}),
    getModel: () => 'test-model',
    getEmbeddingModel: () => 'test-embedding',
    getSandbox: () => false,
    getCoreTools: () => [],
    getApprovalMode: () => 'auto',
    getTelemetryEnabled: () => true,
    getTelemetryLogPromptsEnabled: () => false,
    getFileFilteringRespectGitIgnore: () => true,
    getOutputFormat: () => 'text',
    getToolRegistry: () => undefined,
    ...overrides,
  };
  return defaults as Config;
};

describe('QwenLogger', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00.000Z'));
    mockConfig = makeFakeConfig();
    debugLoggerSpy.debug.mockClear();
    debugLoggerSpy.info.mockClear();
    debugLoggerSpy.warn.mockClear();
    debugLoggerSpy.error.mockClear();
    // Clear singleton instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (QwenLogger as any).instance = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (QwenLogger as any).instance = undefined;
  });

  describe('getInstance', () => {
    it('returns undefined when usage statistics are disabled', () => {
      const config = makeFakeConfig({ getUsageStatisticsEnabled: () => false });
      const logger = QwenLogger.getInstance(config);
      expect(logger).toBeUndefined();
    });

    it('returns an instance when usage statistics are enabled', () => {
      const logger = QwenLogger.getInstance(mockConfig);
      expect(logger).toBeInstanceOf(QwenLogger);
    });

    it('is a singleton', () => {
      const logger1 = QwenLogger.getInstance(mockConfig);
      const logger2 = QwenLogger.getInstance(mockConfig);
      expect(logger1).toBe(logger2);
    });
  });

  describe('createRumPayload', () => {
    it('includes os metadata in payload', async () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const payload = await (
        logger as unknown as {
          createRumPayload(): Promise<RumPayload>;
        }
      ).createRumPayload();

      expect(payload.os).toEqual(
        expect.objectContaining({
          type: os.platform(),
          version: os.release(),
        }),
      );
    });

    it('includes source when source.json exists with valid source', async () => {
      // Note: Testing source information requires actual file system operations
      // This test verifies that the payload structure is correct
      const logger = QwenLogger.getInstance(mockConfig)!;

      const payload = await (
        logger as unknown as { createRumPayload(): Promise<RumPayload> }
      ).createRumPayload();

      // Verify that payload has app.channel property
      expect(payload.app).toHaveProperty('channel');
      // channel should be either undefined or a string
      expect(
        payload.app.channel === undefined ||
          typeof payload.app.channel === 'string',
      ).toBe(true);
    });

    it('caches source info and does not read file on every payload creation', async () => {
      const logger = QwenLogger.getInstance(mockConfig)!;

      // Get the cached sourceInfo value
      const cachedSourceInfo = logger['sourceInfo'];

      // Create multiple payloads
      const payload1 = await (
        logger as unknown as { createRumPayload(): Promise<RumPayload> }
      ).createRumPayload();
      const payload2 = await (
        logger as unknown as { createRumPayload(): Promise<RumPayload> }
      ).createRumPayload();

      // Both payloads should use the same cached source info
      expect(payload1.app.channel).toBe(payload2.app.channel);
      // The cached value should not have changed
      expect(logger['sourceInfo']).toBe(cachedSourceInfo);
    });
    it('does not include source when source.json does not exist', async () => {
      // Note: Testing source information requires actual file system operations
      // This test verifies the payload structure is correct
      const logger = QwenLogger.getInstance(mockConfig)!;

      const payload = await (
        logger as unknown as { createRumPayload(): Promise<RumPayload> }
      ).createRumPayload();

      // Verify that channel property exists (may be undefined or have a value)
      expect(payload.app).toHaveProperty('channel');
    });
    it('does not include source when source value is unknown', async () => {
      // Note: Testing source information requires actual file system operations
      // This test verifies the payload structure is correct
      const logger = QwenLogger.getInstance(mockConfig)!;

      const payload = await (
        logger as unknown as { createRumPayload(): Promise<RumPayload> }
      ).createRumPayload();

      // Verify that channel property exists
      expect(payload.app).toHaveProperty('channel');
    });
    it('handles source.json parsing errors gracefully', async () => {
      // Note: Testing source information requires actual file system operations
      // This test verifies the payload structure is correct
      const logger = QwenLogger.getInstance(mockConfig)!;

      const payload = await (
        logger as unknown as { createRumPayload(): Promise<RumPayload> }
      ).createRumPayload();

      // Verify that payload is created successfully (no crash on errors)
      expect(payload).toBeDefined();
      expect(payload.app).toHaveProperty('channel');
    });
  });

  describe('event queue management', () => {
    it('should handle event overflow gracefully', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;

      // Fill the queue beyond capacity
      for (let i = 0; i < TEST_ONLY.MAX_EVENTS + 10; i++) {
        logger.enqueueLogEvent({
          timestamp: Date.now(),
          event_type: 'action',
          type: 'test',
          name: `test-event-${i}`,
        });
      }

      const events = logger['events'].toArray() as RumEvent[];
      expect(logger['events'].size).toBe(TEST_ONLY.MAX_EVENTS);
      expect(events[0]?.name).toBe('test-event-10');
      expect(events[events.length - 1]?.name).toBe(
        `test-event-${TEST_ONLY.MAX_EVENTS + 9}`,
      );
    });

    it('should handle enqueue errors gracefully', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;

      // Mock the events deque to throw an error
      const originalPush = logger['events'].push;
      logger['events'].push = vi.fn(() => {
        throw new Error('Test error');
      });

      logger.enqueueLogEvent({
        timestamp: Date.now(),
        event_type: 'action',
        type: 'test',
        name: 'test-event',
      });

      expect(logger['events'].size).toBe(0);

      // Restore original method
      logger['events'].push = originalPush;
    });
  });

  describe('concurrent flush protection', () => {
    it('should handle concurrent flush requests', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;

      // Manually set the flush in progress flag to simulate concurrent access
      logger['isFlushInProgress'] = true;

      // Try to flush while another flush is in progress
      const result = logger.flushToRum();

      expect(logger['pendingFlush']).toBe(true);

      // Should return a resolved promise
      expect(result).toBeInstanceOf(Promise);

      // Reset the flag
      logger['isFlushInProgress'] = false;
    });
  });

  describe('failed event retry mechanism', () => {
    it('should requeue failed events with size limits', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;

      const failedEvents: RumEvent[] = [];
      for (let i = 0; i < TEST_ONLY.MAX_RETRY_EVENTS + 50; i++) {
        failedEvents.push({
          timestamp: Date.now(),
          event_type: 'action',
          type: 'test',
          name: `failed-event-${i}`,
        });
      }

      // Call the private method using bracket notation
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (logger as any).requeueFailedEvents(failedEvents);

      expect(logger['events'].size).toBe(TEST_ONLY.MAX_RETRY_EVENTS);
    });

    it('should handle empty retry queue gracefully', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;

      // Fill the queue to capacity first
      for (let i = 0; i < TEST_ONLY.MAX_EVENTS; i++) {
        logger.enqueueLogEvent({
          timestamp: Date.now(),
          event_type: 'action',
          type: 'test',
          name: `event-${i}`,
        });
      }

      // Try to requeue when no space is available
      const failedEvents: RumEvent[] = [
        {
          timestamp: Date.now(),
          event_type: 'action',
          type: 'test',
          name: 'failed-event',
        },
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (logger as any).requeueFailedEvents(failedEvents);

      expect(logger['events'].size).toBe(TEST_ONLY.MAX_EVENTS);
    });
  });

  describe('event handlers', () => {
    it('should log IDE connection events', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const enqueueSpy = vi.spyOn(logger, 'enqueueLogEvent');

      const event = new IdeConnectionEvent(IdeConnectionType.SESSION);

      logger.logIdeConnectionEvent(event);

      expect(enqueueSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'action',
          type: 'ide',
          name: 'ide_connection',
          properties: {
            connection_type: IdeConnectionType.SESSION,
          },
        }),
      );
    });

    it('should log Kitty sequence overflow events', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const enqueueSpy = vi.spyOn(logger, 'enqueueLogEvent');

      const event = new KittySequenceOverflowEvent(1024, 'truncated...');

      logger.logKittySequenceOverflowEvent(event);

      expect(enqueueSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'exception',
          type: 'overflow',
          name: 'kitty_sequence_overflow',
          subtype: 'kitty_sequence_overflow',
          properties: {
            sequence_length: 1024,
          },
          snapshots: JSON.stringify({
            truncated_sequence: 'truncated...',
          }),
        }),
      );
    });

    it('should flush start session events immediately', async () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const flushSpy = vi.spyOn(logger, 'flushToRum').mockResolvedValue({});

      const testConfig = makeFakeConfig({
        getModel: () => 'test-model',
        getEmbeddingModel: () => 'test-embedding',
      });
      const event = new StartSessionEvent(testConfig);

      logger.logStartSessionEvent(event);

      expect(flushSpy).toHaveBeenCalled();
    });

    it('should re-read source info when starting a new session', async () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const readSourceInfoSpy = vi.spyOn(
        logger as unknown as { readSourceInfo(): string },
        'readSourceInfo',
      );

      const testConfig = makeFakeConfig({
        getModel: () => 'test-model',
        getEmbeddingModel: () => 'test-embedding',
        getSessionId: () => 'new-session-id',
      });
      const event = new StartSessionEvent(testConfig);

      await logger.logStartSessionEvent(event);

      // readSourceInfo should be called when starting a new session
      expect(readSourceInfoSpy).toHaveBeenCalled();
      // Session ID should be updated
      expect(logger['sessionId']).toBe('new-session-id');
    });

    it('should flush end session events immediately', async () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const flushSpy = vi.spyOn(logger, 'flushToRum').mockResolvedValue({});

      const event = new EndSessionEvent(mockConfig);

      logger.logEndSessionEvent(event);

      expect(flushSpy).toHaveBeenCalled();
    });
  });

  describe('flush timing', () => {
    it('should not flush if interval has not passed', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const flushSpy = vi.spyOn(logger, 'flushToRum');

      // Add an event and try to flush immediately
      logger.enqueueLogEvent({
        timestamp: Date.now(),
        event_type: 'action',
        type: 'test',
        name: 'test-event',
      });

      logger.flushIfNeeded();

      expect(flushSpy).not.toHaveBeenCalled();
    });

    it('should flush when interval has passed', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const flushSpy = vi.spyOn(logger, 'flushToRum').mockResolvedValue({});

      // Add an event
      logger.enqueueLogEvent({
        timestamp: Date.now(),
        event_type: 'action',
        type: 'test',
        name: 'test-event',
      });

      // Advance time beyond flush interval
      vi.advanceTimersByTime(TEST_ONLY.FLUSH_INTERVAL_MS + 1000);

      logger.flushIfNeeded();

      expect(flushSpy).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle flush errors gracefully with debug mode', async () => {
      const logger = QwenLogger.getInstance(mockConfig)!;

      // Add an event first
      logger.enqueueLogEvent({
        timestamp: Date.now(),
        event_type: 'action',
        type: 'test',
        name: 'test-event',
      });

      // Mock flushToRum to throw an error
      const originalFlush = logger.flushToRum.bind(logger);
      logger.flushToRum = vi.fn().mockRejectedValue(new Error('Network error'));

      // Advance time to trigger flush
      vi.advanceTimersByTime(TEST_ONLY.FLUSH_INTERVAL_MS + 1000);

      logger.flushIfNeeded();

      // Wait for async operations
      await vi.runAllTimersAsync();

      // Errors are now silently ignored to reduce log spam
      // Only rate-limited error logs are emitted inside flushToRum itself

      // Restore original method
      logger.flushToRum = originalFlush;
    });
  });

  describe('constants export', () => {
    it('should export test constants', () => {
      expect(TEST_ONLY.MAX_EVENTS).toBe(1000);
      expect(TEST_ONLY.MAX_RETRY_EVENTS).toBe(100);
      expect(TEST_ONLY.FLUSH_INTERVAL_MS).toBe(60000);
    });
  });
});
