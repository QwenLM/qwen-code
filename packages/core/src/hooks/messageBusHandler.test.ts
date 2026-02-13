/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MessageBusHookEventHandler,
  createMessageBusHookEventHandler,
} from './messageBusHandler.js';
import { HookPlanner } from './planner.js';
import { HookRegistry } from './registry.js';
import type { HookRunner } from './runner.js';
import { HookEventName, HookType, DefaultHookOutput } from './types.js';
import type {
  HookExecutionMessageRequest,
  HookMessageBus,
  HookExecutionMessageResponse,
} from './messageBusHandler.js';
import type { HookExecutionResult } from './types.js';

// Mock HookRunner
vi.mock('./runner.js', () => ({
  HookRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn(),
    updateConfig: vi.fn(),
    getConfig: vi.fn().mockReturnValue({}),
  })),
  createHookRunner: vi.fn().mockReturnValue({
    run: vi.fn(),
    updateConfig: vi.fn(),
    getConfig: vi.fn().mockReturnValue({}),
  }),
}));

describe('MessageBusHookEventHandler', () => {
  let handler: MessageBusHookEventHandler;
  let registry: HookRegistry;
  let planner: HookPlanner;
  let runner: HookRunner;
  let mockMessageBus: HookMessageBus;
  let mockRun: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new HookRegistry();
    planner = new HookPlanner();
    mockRun = vi.fn();
    runner = {
      run: mockRun,
      updateConfig: vi.fn(),
      getConfig: vi.fn().mockReturnValue({}),
    } as unknown as HookRunner;
    mockMessageBus = {
      request: vi.fn(),
      publish: vi.fn(),
    };

    handler = new MessageBusHookEventHandler({
      registry,
      planner,
      runner,
      messageBus: mockMessageBus,
      telemetry: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('handleRequest', () => {
    it('should handle hook execution request successfully', async () => {
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'test-hook' }],
      });

      const mockResult: HookExecutionResult = {
        hookConfig: { type: HookType.Command, command: 'test-hook' },
        eventName: HookEventName.PreToolUse,
        success: true,
        output: new DefaultHookOutput({ decision: 'allow' }),
        stdout: '',
        stderr: '',
        exitCode: 0,
        duration: 100,
      };

      mockRun.mockResolvedValue(mockResult);

      const request: HookExecutionMessageRequest = {
        type: 'HOOK_EXECUTION_REQUEST',
        requestId: 'req-123',
        eventName: HookEventName.PreToolUse,
        sessionId: 'session-123',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        timestamp: '2024-01-01T00:00:00Z',
        input: {
          session_id: 'session-123',
          transcript_path: '/test/transcript',
          cwd: '/test',
          hook_event_name: 'PreToolUse',
          timestamp: '2024-01-01T00:00:00Z',
        },
        toolName: 'WriteFile',
      };

      const response = await handler.handleRequest(request);

      expect(response.type).toBe('HOOK_EXECUTION_RESPONSE');
      expect(response.requestId).toBe('req-123');
      expect(response.success).toBe(true);
      expect(response.isBlocking).toBe(false);
      expect(response.results).toHaveLength(1);
    });

    it('should return empty response when no matching hooks', async () => {
      const request: HookExecutionMessageRequest = {
        type: 'HOOK_EXECUTION_REQUEST',
        requestId: 'req-123',
        eventName: HookEventName.PreToolUse,
        sessionId: 'session-123',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        timestamp: '2024-01-01T00:00:00Z',
        input: {
          session_id: 'session-123',
          transcript_path: '/test/transcript',
          cwd: '/test',
          hook_event_name: 'PreToolUse',
          timestamp: '2024-01-01T00:00:00Z',
        },
        toolName: 'NonExistentTool',
      };

      const response = await handler.handleRequest(request);

      expect(response.success).toBe(true);
      expect(response.results).toHaveLength(0);
      expect(response.isBlocking).toBe(false);
    });

    it('should handle blocking decisions', async () => {
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'blocking-hook' }],
      });

      const mockResult: HookExecutionResult = {
        hookConfig: { type: HookType.Command, command: 'blocking-hook' },
        eventName: HookEventName.PreToolUse,
        success: true,
        output: new DefaultHookOutput({
          decision: 'block',
          reason: 'Blocked by policy',
        }),
        stdout: '',
        stderr: '',
        exitCode: 0,
        duration: 100,
      };

      mockRun.mockResolvedValue(mockResult);

      const request: HookExecutionMessageRequest = {
        type: 'HOOK_EXECUTION_REQUEST',
        requestId: 'req-123',
        eventName: HookEventName.PreToolUse,
        sessionId: 'session-123',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        timestamp: '2024-01-01T00:00:00Z',
        input: {
          session_id: 'session-123',
          transcript_path: '/test/transcript',
          cwd: '/test',
          hook_event_name: 'PreToolUse',
          timestamp: '2024-01-01T00:00:00Z',
        },
        toolName: 'WriteFile',
      };

      const response = await handler.handleRequest(request);

      expect(response.isBlocking).toBe(true);
      expect(response.reasons).toContain('Blocked by policy');
    });

    it('should handle sequential execution with early termination', async () => {
      registry.register({
        matcher: 'WriteFile',
        sequential: true,
        hooks: [
          { type: HookType.Command, command: 'hook1' },
          { type: HookType.Command, command: 'hook2' },
        ],
      });

      const mockResults: HookExecutionResult[] = [
        {
          hookConfig: { type: HookType.Command, command: 'hook1' },
          eventName: HookEventName.PreToolUse,
          success: true,
          output: new DefaultHookOutput({ decision: 'block' }),
          stdout: '',
          stderr: '',
          exitCode: 0,
          duration: 50,
        },
        // hook2 should not be executed due to early termination
      ];

      mockRun.mockResolvedValueOnce(mockResults[0]);

      const request: HookExecutionMessageRequest = {
        type: 'HOOK_EXECUTION_REQUEST',
        requestId: 'req-123',
        eventName: HookEventName.PreToolUse,
        sessionId: 'session-123',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        timestamp: '2024-01-01T00:00:00Z',
        input: {
          session_id: 'session-123',
          transcript_path: '/test/transcript',
          cwd: '/test',
          hook_event_name: 'PreToolUse',
          timestamp: '2024-01-01T00:00:00Z',
        },
        toolName: 'WriteFile',
      };

      const response = await handler.handleRequest(request);

      expect(response.results).toHaveLength(1);
      expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it('should handle errors gracefully', async () => {
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'failing-hook' }],
      });

      mockRun.mockRejectedValue(new Error('Hook execution failed'));

      const request: HookExecutionMessageRequest = {
        type: 'HOOK_EXECUTION_REQUEST',
        requestId: 'req-123',
        eventName: HookEventName.PreToolUse,
        sessionId: 'session-123',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        timestamp: '2024-01-01T00:00:00Z',
        input: {
          session_id: 'session-123',
          transcript_path: '/test/transcript',
          cwd: '/test',
          hook_event_name: 'PreToolUse',
          timestamp: '2024-01-01T00:00:00Z',
        },
        toolName: 'WriteFile',
      };

      const response = await handler.handleRequest(request);

      expect(response.success).toBe(false);
      expect(response.isBlocking).toBe(true);
      expect(response.error).toBe('Hook execution failed');
    });

    it('should publish telemetry when enabled', async () => {
      const handlerWithTelemetry = new MessageBusHookEventHandler({
        registry,
        planner,
        runner,
        messageBus: mockMessageBus,
        telemetry: true,
      });

      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'test-hook' }],
      });

      const mockResult: HookExecutionResult = {
        hookConfig: { type: HookType.Command, command: 'test-hook' },
        eventName: HookEventName.PreToolUse,
        success: true,
        output: new DefaultHookOutput({ decision: 'allow' }),
        stdout: '',
        stderr: '',
        exitCode: 0,
        duration: 100,
      };

      mockRun.mockResolvedValue(mockResult);

      const request: HookExecutionMessageRequest = {
        type: 'HOOK_EXECUTION_REQUEST',
        requestId: 'req-123',
        eventName: HookEventName.PreToolUse,
        sessionId: 'session-123',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        timestamp: '2024-01-01T00:00:00Z',
        input: {
          session_id: 'session-123',
          transcript_path: '/test/transcript',
          cwd: '/test',
          hook_event_name: 'PreToolUse',
          timestamp: '2024-01-01T00:00:00Z',
        },
        toolName: 'WriteFile',
      };

      await handlerWithTelemetry.handleRequest(request);

      expect(mockMessageBus.publish).toHaveBeenCalledWith(
        'HOOK_TELEMETRY',
        expect.objectContaining({
          type: 'HOOK_TELEMETRY',
          eventName: HookEventName.PreToolUse,
          hookCount: 1,
          successRate: 1,
        }),
      );
    });
  });

  describe('createRequest', () => {
    it('should create a valid hook execution request', () => {
      const input = {
        session_id: 'session-123',
        transcript_path: '/test/transcript',
        cwd: '/test',
        hook_event_name: 'PreToolUse' as const,
        timestamp: '2024-01-01T00:00:00Z',
      };

      const request = handler.createRequest(HookEventName.PreToolUse, input, {
        sessionId: 'session-123',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        toolName: 'WriteFile',
      });

      expect(request.type).toBe('HOOK_EXECUTION_REQUEST');
      expect(request.eventName).toBe(HookEventName.PreToolUse);
      expect(request.sessionId).toBe('session-123');
      expect(request.toolName).toBe('WriteFile');
      expect(request.requestId).toBeDefined();
    });
  });

  describe('sendRequest', () => {
    it('should send request through message bus', async () => {
      const mockResponse: HookExecutionMessageResponse = {
        type: 'HOOK_EXECUTION_RESPONSE',
        requestId: 'req-123',
        success: true,
        output: new DefaultHookOutput(),
        results: [],
        isBlocking: false,
        reasons: [],
        duration: 100,
      };

      vi.mocked(mockMessageBus.request).mockResolvedValue(mockResponse);

      const request: HookExecutionMessageRequest = {
        type: 'HOOK_EXECUTION_REQUEST',
        requestId: 'req-123',
        eventName: HookEventName.PreToolUse,
        sessionId: 'session-123',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        timestamp: '2024-01-01T00:00:00Z',
        input: {
          session_id: 'session-123',
          transcript_path: '/test/transcript',
          cwd: '/test',
          hook_event_name: 'PreToolUse',
          timestamp: '2024-01-01T00:00:00Z',
        },
      };

      const response = await handler.sendRequest(request);

      expect(mockMessageBus.request).toHaveBeenCalledWith(
        'HOOK_EXECUTION_REQUEST',
        request,
      );
      expect(response).toEqual(mockResponse);
    });
  });

  describe('getStats', () => {
    it('should return handler statistics', () => {
      const stats = handler.getStats();

      expect(stats.requestChannel).toBe('HOOK_EXECUTION_REQUEST');
      expect(stats.responseChannel).toBe('HOOK_EXECUTION_RESPONSE');
      expect(stats.telemetryChannel).toBe('HOOK_TELEMETRY');
      expect(stats.telemetryEnabled).toBe(false);
    });

    it('should reflect custom channel names', () => {
      const customHandler = new MessageBusHookEventHandler({
        registry,
        planner,
        runner,
        messageBus: mockMessageBus,
        channels: {
          request: 'CUSTOM_REQUEST',
          response: 'CUSTOM_RESPONSE',
          telemetry: 'CUSTOM_TELEMETRY',
        },
        telemetry: true,
      });

      const stats = customHandler.getStats();

      expect(stats.requestChannel).toBe('CUSTOM_REQUEST');
      expect(stats.telemetryEnabled).toBe(true);
    });
  });

  describe('blocking detection', () => {
    it('should detect blocking from permissionDecision field', async () => {
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'test-hook' }],
      });

      const mockResult: HookExecutionResult = {
        hookConfig: { type: HookType.Command, command: 'test-hook' },
        eventName: HookEventName.PreToolUse,
        success: true,
        output: {
          hookSpecificOutput: {
            permissionDecision: 'deny',
          },
        },
        stdout: '',
        stderr: '',
        exitCode: 0,
        duration: 100,
      };

      mockRun.mockResolvedValue(mockResult);

      const request: HookExecutionMessageRequest = {
        type: 'HOOK_EXECUTION_REQUEST',
        requestId: 'req-123',
        eventName: HookEventName.PreToolUse,
        sessionId: 'session-123',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        timestamp: '2024-01-01T00:00:00Z',
        input: {
          session_id: 'session-123',
          transcript_path: '/test/transcript',
          cwd: '/test',
          hook_event_name: 'PreToolUse',
          timestamp: '2024-01-01T00:00:00Z',
        },
        toolName: 'WriteFile',
      };

      const response = await handler.handleRequest(request);

      expect(response.isBlocking).toBe(true);
    });

    it('should detect blocking from decision.behavior field', async () => {
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'test-hook' }],
      });

      const mockResult: HookExecutionResult = {
        hookConfig: { type: HookType.Command, command: 'test-hook' },
        eventName: HookEventName.PreToolUse,
        success: true,
        output: {
          hookSpecificOutput: {
            decision: {
              behavior: 'deny',
            },
          },
        },
        stdout: '',
        stderr: '',
        exitCode: 0,
        duration: 100,
      };

      mockRun.mockResolvedValue(mockResult);

      const request: HookExecutionMessageRequest = {
        type: 'HOOK_EXECUTION_REQUEST',
        requestId: 'req-123',
        eventName: HookEventName.PreToolUse,
        sessionId: 'session-123',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        timestamp: '2024-01-01T00:00:00Z',
        input: {
          session_id: 'session-123',
          transcript_path: '/test/transcript',
          cwd: '/test',
          hook_event_name: 'PreToolUse',
          timestamp: '2024-01-01T00:00:00Z',
        },
        toolName: 'WriteFile',
      };

      const response = await handler.handleRequest(request);

      expect(response.isBlocking).toBe(true);
    });
  });
});

describe('createMessageBusHookEventHandler', () => {
  it('should create a new MessageBusHookEventHandler instance', () => {
    const mockMessageBus = {
      request: vi.fn(),
      publish: vi.fn(),
    };

    const handler = createMessageBusHookEventHandler({
      registry: new HookRegistry(),
      planner: new HookPlanner(),
      runner: vi.fn() as unknown as HookRunner,
      messageBus: mockMessageBus,
    });

    expect(handler).toBeInstanceOf(MessageBusHookEventHandler);
  });
});
