/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBus } from './message-bus.js';
import { MessageBusType } from './types.js';
import type {
  HookExecutionRequest,
  HookExecutionResponse,
  Message,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  ToolExecutionSuccess,
} from './types.js';

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../utils/safeJsonStringify.js', () => ({
  safeJsonStringify: (obj: unknown) => JSON.stringify(obj),
}));

describe('MessageBus', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  afterEach(() => {
    bus.removeAllListeners();
  });

  /** Subscribes to `type` and returns the array the messages land in. */
  const receive = <T extends Message>(type: MessageBusType): T[] => {
    const out: T[] = [];
    bus.subscribe<T>(type, (msg) => out.push(msg));
    return out;
  };

  const requestHook = (timeoutMs?: number, signal?: AbortSignal) =>
    bus.request<HookExecutionRequest, HookExecutionResponse>(
      {
        type: MessageBusType.HOOK_EXECUTION_REQUEST,
        owner: { runtimeId: 'runtime', sessionId: 'session', agentId: null },
        eventName: 'TestEvent',
        input: {},
      },
      MessageBusType.HOOK_EXECUTION_RESPONSE,
      timeoutMs,
      signal,
    );

  describe('publish', () => {
    it('should auto-confirm tool confirmation requests', async () => {
      const responses = receive<ToolConfirmationResponse>(
        MessageBusType.TOOL_CONFIRMATION_RESPONSE,
      );
      await bus.publish({
        type: MessageBusType.TOOL_CONFIRMATION_REQUEST,
        toolCall: { name: 'test_tool', args: {} },
        correlationId: 'test-123',
      } satisfies ToolConfirmationRequest);

      expect(responses).toHaveLength(1);
      expect(responses[0].confirmed).toBe(true);
      expect(responses[0].correlationId).toBe('test-123');
    });

    it('should emit hook execution requests directly', async () => {
      const received = receive<HookExecutionRequest>(
        MessageBusType.HOOK_EXECUTION_REQUEST,
      );
      await bus.publish({
        type: MessageBusType.HOOK_EXECUTION_REQUEST,
        owner: { runtimeId: 'runtime', sessionId: 'session', agentId: null },
        eventName: 'UserPromptSubmit',
        input: { prompt: 'test' },
        correlationId: 'hook-123',
      } satisfies HookExecutionRequest);

      expect(received).toHaveLength(1);
      expect(received[0].eventName).toBe('UserPromptSubmit');
      expect(received[0].correlationId).toBe('hook-123');
    });

    it('should emit other message types directly', async () => {
      const received = receive<ToolExecutionSuccess>(
        MessageBusType.TOOL_EXECUTION_SUCCESS,
      );
      await bus.publish({
        type: MessageBusType.TOOL_EXECUTION_SUCCESS,
        toolCall: { name: 'test_tool', args: {} },
        result: { data: 'test' },
      } satisfies ToolExecutionSuccess);

      expect(received).toHaveLength(1);
      expect(received[0].result).toEqual({ data: 'test' });
    });

    const publishInvalid = async (msg: unknown) => {
      const errors: Error[] = [];
      bus.on('error', (err) => errors.push(err));
      await bus.publish(msg as Message);
      expect(errors).toHaveLength(1);
      return errors;
    };

    it.each([
      ['should emit error for invalid messages', null],
      [
        'should emit error for tool confirmation request without correlationId',
        {
          type: MessageBusType.TOOL_CONFIRMATION_REQUEST,
          toolCall: { name: 'test', args: {} },
        },
      ],
    ])('%s', async (_title, msg) => {
      const errors = await publishInvalid(msg);
      expect(errors[0].message).toContain('Invalid message structure');
    });

    it('should emit error for message without type', async () => {
      await publishInvalid({});
    });
  });

  describe('subscribe / unsubscribe', () => {
    const response: HookExecutionResponse = {
      type: MessageBusType.HOOK_EXECUTION_RESPONSE,
      correlationId: 'resp-123',
      success: true,
    };

    it('should subscribe and receive messages', async () => {
      const received = receive<HookExecutionResponse>(
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );
      await bus.publish(response);
      expect(received).toHaveLength(1);
    });

    it('should unsubscribe and stop receiving messages', async () => {
      const received: HookExecutionResponse[] = [];
      const listener = (msg: HookExecutionResponse) => received.push(msg);
      bus.subscribe(MessageBusType.HOOK_EXECUTION_RESPONSE, listener);
      bus.unsubscribe(MessageBusType.HOOK_EXECUTION_RESPONSE, listener);

      await bus.publish(response);
      expect(received).toHaveLength(0);
    });
  });

  describe('request', () => {
    /** Answers each hook request with `replies`, in order; a reply without
     * its own correlationId carries the request's. */
    const respondWith = (
      ...replies: Array<Partial<HookExecutionResponse> & { success: boolean }>
    ) =>
      bus.subscribe<HookExecutionRequest>(
        MessageBusType.HOOK_EXECUTION_REQUEST,
        (msg) => {
          for (const reply of replies) {
            void bus.publish({
              type: MessageBusType.HOOK_EXECUTION_RESPONSE,
              correlationId: msg.correlationId,
              ...reply,
            });
          }
        },
      );

    it('should correlate request and response', async () => {
      respondWith({ success: true, output: { result: 'done' } });
      const response = await requestHook();

      expect(response.success).toBe(true);
      expect(response.output).toEqual({ result: 'done' });
    });

    it('should ignore responses with non-matching correlationId', async () => {
      // A wrong correlation ID first, then the correct one.
      respondWith(
        { correlationId: 'wrong-id', success: false },
        { success: true },
      );
      const response = await requestHook();

      expect(response.success).toBe(true);
    });

    it('should timeout if no response is received', async () => {
      await expect(requestHook(50)).rejects.toThrow('Request timed out');
    });

    it('should reject immediately when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(requestHook(5000, controller.signal)).rejects.toThrow(
        'Request aborted',
      );
    });

    it('should reject when signal is aborted during wait', async () => {
      const controller = new AbortController();
      const promise = requestHook(5000, controller.signal);
      setTimeout(() => controller.abort(), 10); // abort after a tick

      await expect(promise).rejects.toThrow('Request aborted');
    });

    it('should auto-confirm tool confirmation via request pattern', async () => {
      const response = await bus.request<
        ToolConfirmationRequest,
        ToolConfirmationResponse
      >(
        {
          type: MessageBusType.TOOL_CONFIRMATION_REQUEST,
          toolCall: { name: 'test_tool', args: {} },
        },
        MessageBusType.TOOL_CONFIRMATION_RESPONSE,
      );

      expect(response.confirmed).toBe(true);
    });
  });

  describe('debug mode', () => {
    it('should create MessageBus with debug enabled', () => {
      const debugBus = new MessageBus(true);
      expect(debugBus).toBeInstanceOf(MessageBus);
      debugBus.removeAllListeners();
    });
  });
});
