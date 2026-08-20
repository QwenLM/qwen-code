/**
 * Tests for EventLogHandler
 */

import { describe, it, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { WorkspaceEventBus } from '../event-bus.ts';
import { EventLogHandler } from './event-log-handler.ts';
import type { EventLogHandlerOptions } from './types.ts';

// Track mock logger instances for assertions
let mockLoggerInstances: Array<{
  log: jest.Mock;
  getLogPath: jest.Mock;
  dispose: jest.Mock;
  onEventLost?: (events: string[], error: Error) => void;
}> = [];

// Mock the event logger to avoid real file I/O
mock.module('../event-logger.ts', () => {
  class MockAutomationEventLogger {
    log = jest.fn();
    getLogPath = jest.fn().mockReturnValue('/tmp/test-workspace/events.jsonl');
    dispose = jest.fn().mockResolvedValue(undefined);
    onEventLost?: (events: string[], error: Error) => void;

    constructor(_workspaceRootPath: string) {
      mockLoggerInstances.push(this);
    }
  }
  return { AutomationEventLogger: MockAutomationEventLogger };
});

// Helper to create default options
function createOptions(overrides: Partial<EventLogHandlerOptions> = {}): EventLogHandlerOptions {
  return {
    workspaceRootPath: '/tmp/test-workspace',
    workspaceId: 'test-workspace',
    ...overrides,
  };
}

describe('EventLogHandler', () => {
  let bus: WorkspaceEventBus;

  beforeEach(() => {
    bus = new WorkspaceEventBus('test-workspace');
    mockLoggerInstances = [];
    jest.clearAllMocks();
  });

  afterEach(() => {
    bus.dispose();
  });

  describe('event logging', () => {
    it('should log events via AutomationEventLogger', async () => {
      const handler = new EventLogHandler(createOptions());
      handler.subscribe(bus);

      const timestamp = Date.now();
      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp,
        label: 'test-label',
      });

      const loggerInstance = mockLoggerInstances[0]!;
      expect(loggerInstance.log).toHaveBeenCalledTimes(1);
      expect(loggerInstance.log).toHaveBeenCalledWith(expect.objectContaining({
        type: 'LabelAdd',
        workspaceId: 'test-workspace',
      }));

      await handler.dispose();
    });

    it('should log multiple events in sequence', async () => {
      const handler = new EventLogHandler(createOptions());
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'first',
      });

      await bus.emit('LabelRemove', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'second',
      });

      const loggerInstance = mockLoggerInstances[0]!;
      expect(loggerInstance.log).toHaveBeenCalledTimes(2);

      await handler.dispose();
    });

    it('should include sessionId in logged events when provided in payload', async () => {
      const handler = new EventLogHandler(createOptions());
      handler.subscribe(bus);

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        sessionId: 'session-123',
        timestamp: Date.now(),
        label: 'test',
      });

      const loggerInstance = mockLoggerInstances[0]!;
      expect(loggerInstance.log).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-123',
      }));

      await handler.dispose();
    });

    it('should pass event data in the logged payload', async () => {
      const handler = new EventLogHandler(createOptions());
      handler.subscribe(bus);

      const timestamp = Date.now();
      await bus.emit('PermissionModeChange', {
        workspaceId: 'test-workspace',
        timestamp,
        oldMode: 'ask',
        newMode: 'safe',
      });

      const loggerInstance = mockLoggerInstances[0]!;
      expect(loggerInstance.log).toHaveBeenCalledWith(expect.objectContaining({
        type: 'PermissionModeChange',
        data: expect.objectContaining({
          oldMode: 'ask',
          newMode: 'safe',
        }),
      }));

      await handler.dispose();
    });
  });

  describe('log path', () => {
    it('should expose the log path from the underlying logger', () => {
      const handler = new EventLogHandler(createOptions());
      expect(handler.getLogPath()).toBe('/tmp/test-workspace/events.jsonl');
    });
  });

  describe('onEventLost callback', () => {
    it('should forward onEventLost callback to the logger', () => {
      const onEventLost = jest.fn();
      const handler = new EventLogHandler(createOptions({ onEventLost }));

      const loggerInstance = mockLoggerInstances[0]!;
      expect(loggerInstance.onEventLost).toBe(onEventLost);

      handler.dispose();
    });
  });

  describe('dispose', () => {
    it('should unsubscribe from the event bus', async () => {
      const handler = new EventLogHandler(createOptions());
      handler.subscribe(bus);
      expect(bus.getHandlerCount()).toBe(1);

      await handler.dispose();
      expect(bus.getHandlerCount()).toBe(0);
    });

    it('should flush and close the logger on dispose', async () => {
      const handler = new EventLogHandler(createOptions());
      handler.subscribe(bus);

      await handler.dispose();

      const loggerInstance = mockLoggerInstances[0]!;
      expect(loggerInstance.dispose).toHaveBeenCalledTimes(1);
    });

    it('should not process events after disposal', async () => {
      const handler = new EventLogHandler(createOptions());
      handler.subscribe(bus);
      await handler.dispose();

      await bus.emit('LabelAdd', {
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test',
      });

      const loggerInstance = mockLoggerInstances[0]!;
      expect(loggerInstance.log).not.toHaveBeenCalled();
    });
  });
});
