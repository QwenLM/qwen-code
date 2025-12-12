/**
 * Unit tests for Query class
 * Tests message routing, lifecycle, and orchestration
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Query } from '../../src/query/Query.js';
import type { Transport } from '../../src/transport/Transport.js';
import type {
  SDKMessage,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  CLIControlRequest,
  CLIControlResponse,
  ControlCancelRequest,
} from '../../src/types/protocol.js';
import { ControlRequestType } from '../../src/types/protocol.js';
import { AbortError } from '../../src/types/errors.js';
import { Stream } from '../../src/utils/Stream.js';

// Mock Transport implementation
class MockTransport implements Transport {
  private messageStream = new Stream<unknown>();
  public writtenMessages: string[] = [];
  public closed = false;
  public endInputCalled = false;
  public isReady = true;
  public exitError: Error | null = null;

  write(data: string): void {
    this.writtenMessages.push(data);
  }

  async *readMessages(): AsyncGenerator<unknown, void, unknown> {
    for await (const message of this.messageStream) {
      yield message;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.messageStream.done();
  }

  async waitForExit(): Promise<void> {
    // Mock implementation - do nothing
  }

  endInput(): void {
    this.endInputCalled = true;
  }

  // Test helper methods
  simulateMessage(message: unknown): void {
    this.messageStream.enqueue(message);
  }

  simulateError(error: Error): void {
    this.messageStream.error(error);
  }

  simulateClose(): void {
    this.messageStream.done();
  }

  getLastWrittenMessage(): unknown {
    if (this.writtenMessages.length === 0) return null;
    return JSON.parse(this.writtenMessages[this.writtenMessages.length - 1]);
  }

  getAllWrittenMessages(): unknown[] {
    return this.writtenMessages.map((msg) => JSON.parse(msg));
  }
}

// Helper function to find control response by request_id
function findControlResponse(
  messages: unknown[],
  requestId: string,
): CLIControlResponse | undefined {
  return messages.find(
    (msg: unknown) =>
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      msg.type === 'control_response' &&
      'response' in msg &&
      typeof msg.response === 'object' &&
      msg.response !== null &&
      'request_id' in msg.response &&
      msg.response.request_id === requestId,
  ) as CLIControlResponse | undefined;
}

// Helper function to find control request by subtype
function findControlRequest(
  messages: unknown[],
  subtype: string,
): CLIControlRequest | undefined {
  return messages.find(
    (msg: unknown) =>
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      msg.type === 'control_request' &&
      'request' in msg &&
      typeof msg.request === 'object' &&
      msg.request !== null &&
      'subtype' in msg.request &&
      msg.request.subtype === subtype,
  ) as CLIControlRequest | undefined;
}

// Helper function to create test messages
function createUserMessage(
  content: string,
  sessionId = 'test-session',
): SDKUserMessage {
  return {
    type: 'user',
    session_id: sessionId,
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
  };
}

function createAssistantMessage(
  content: string,
  sessionId = 'test-session',
): SDKAssistantMessage {
  return {
    type: 'assistant',
    uuid: 'msg-123',
    session_id: sessionId,
    message: {
      id: 'msg-123',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text: content }],
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    parent_tool_use_id: null,
  };
}

function createSystemMessage(
  subtype: string,
  sessionId = 'test-session',
): SDKSystemMessage {
  return {
    type: 'system',
    subtype,
    uuid: 'sys-123',
    session_id: sessionId,
    cwd: '/test/path',
    tools: ['read_file', 'write_file'],
    model: 'test-model',
  };
}

function createResultMessage(
  success: boolean,
  sessionId = 'test-session',
): SDKResultMessage {
  if (success) {
    return {
      type: 'result',
      subtype: 'success',
      uuid: 'result-123',
      session_id: sessionId,
      is_error: false,
      duration_ms: 1000,
      duration_api_ms: 800,
      num_turns: 1,
      result: 'Success',
      usage: { input_tokens: 10, output_tokens: 20 },
      permission_denials: [],
    };
  } else {
    return {
      type: 'result',
      subtype: 'error_during_execution',
      uuid: 'result-123',
      session_id: sessionId,
      is_error: true,
      duration_ms: 1000,
      duration_api_ms: 800,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 20 },
      permission_denials: [],
      error: { message: 'Test error' },
    };
  }
}

function createPartialMessage(
  sessionId = 'test-session',
): SDKPartialAssistantMessage {
  return {
    type: 'stream_event',
    uuid: 'stream-123',
    session_id: sessionId,
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    },
    parent_tool_use_id: null,
  };
}

function createControlRequest(
  subtype: string,
  requestId = 'req-123',
): CLIControlRequest {
  return {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype,
      tool_name: 'test_tool',
      input: { arg: 'value' },
      permission_suggestions: null,
      blocked_path: null,
    } as CLIControlRequest['request'],
  };
}

function createControlResponse(
  requestId: string,
  success: boolean,
  data?: unknown,
): CLIControlResponse {
  return {
    type: 'control_response',
    response: success
      ? {
          subtype: 'success',
          request_id: requestId,
          response: data ?? null,
        }
      : {
          subtype: 'error',
          request_id: requestId,
          error: 'Test error',
        },
  };
}

function createControlCancel(requestId: string): ControlCancelRequest {
  return {
    type: 'control_cancel_request',
    request_id: requestId,
  };
}

describe('Query', () => {
  let transport: MockTransport;

  beforeEach(() => {
    transport = new MockTransport();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (!transport.closed) {
      await transport.close();
    }
  });

  describe('Construction and Initialization', () => {
    it('should create Query with transport and options', async () => {
      const query = new Query(transport, {
        cwd: '/test',
      });

      expect(query).toBeDefined();
      expect(query.getSessionId()).toBeTruthy();
      expect(query.isClosed()).toBe(false);

      // Should send initialize control request
      await vi.waitFor(() => {
        expect(transport.writtenMessages.length).toBeGreaterThan(0);
      });

      const initRequest =
        transport.getLastWrittenMessage() as CLIControlRequest;
      expect(initRequest.type).toBe('control_request');
      expect(initRequest.request.subtype).toBe('initialize');

      await query.close();
    });

    it('should generate unique session ID', async () => {
      const transport2 = new MockTransport();
      const query1 = new Query(transport, { cwd: '/test' });
      const query2 = new Query(transport2, {
        cwd: '/test',
      });

      expect(query1.getSessionId()).not.toBe(query2.getSessionId());

      await query1.close();
      await query2.close();
      await transport2.close();
    });

    it('should handle initialization errors', async () => {
      const query = new Query(transport, {
        cwd: '/test',
      });

      // Simulate initialization failure
      await vi.waitFor(() => {
        expect(transport.writtenMessages.length).toBeGreaterThan(0);
      });

      const initRequest =
        transport.getLastWrittenMessage() as CLIControlRequest;
      transport.simulateMessage(
        createControlResponse(initRequest.request_id, false),
      );

      await expect(query.initialized).rejects.toThrow();

      await query.close();
    });
  });

  describe('Message Routing', () => {
    it('should route user messages to output stream', async () => {
      const query = new Query(transport, { cwd: '/test' });

      const userMsg = createUserMessage('Hello');
      transport.simulateMessage(userMsg);

      const result = await query.next();
      expect(result.done).toBe(false);
      expect(result.value).toEqual(userMsg);

      await query.close();
    });

    it('should route assistant messages to output stream', async () => {
      const query = new Query(transport, { cwd: '/test' });

      const assistantMsg = createAssistantMessage('Response');
      transport.simulateMessage(assistantMsg);

      const result = await query.next();
      expect(result.done).toBe(false);
      expect(result.value).toEqual(assistantMsg);

      await query.close();
    });

    it('should route system messages to output stream', async () => {
      const query = new Query(transport, { cwd: '/test' });

      const systemMsg = createSystemMessage('session_start');
      transport.simulateMessage(systemMsg);

      const result = await query.next();
      expect(result.done).toBe(false);
      expect(result.value).toEqual(systemMsg);

      await query.close();
    });

    it('should route result messages to output stream', async () => {
      const query = new Query(transport, { cwd: '/test' });

      const resultMsg = createResultMessage(true);
      transport.simulateMessage(resultMsg);

      const result = await query.next();
      expect(result.done).toBe(false);
      expect(result.value).toEqual(resultMsg);

      await query.close();
    });

    it('should route partial assistant messages to output stream', async () => {
      const query = new Query(transport, { cwd: '/test' });

      const partialMsg = createPartialMessage();
      transport.simulateMessage(partialMsg);

      const result = await query.next();
      expect(result.done).toBe(false);
      expect(result.value).toEqual(partialMsg);

      await query.close();
    });

    it('should handle unknown message types', async () => {
      const query = new Query(transport, { cwd: '/test' });

      const unknownMsg = { type: 'unknown', data: 'test' };
      transport.simulateMessage(unknownMsg);

      const result = await query.next();
      expect(result.done).toBe(false);
      expect(result.value).toEqual(unknownMsg);

      await query.close();
    });

    it('should yield messages in order', async () => {
      const query = new Query(transport, { cwd: '/test' });

      const msg1 = createUserMessage('First');
      const msg2 = createAssistantMessage('Second');
      const msg3 = createResultMessage(true);

      transport.simulateMessage(msg1);
      transport.simulateMessage(msg2);
      transport.simulateMessage(msg3);

      const result1 = await query.next();
      expect(result1.value).toEqual(msg1);

      const result2 = await query.next();
      expect(result2.value).toEqual(msg2);

      const result3 = await query.next();
      expect(result3.value).toEqual(msg3);

      await query.close();
    });
  });

  describe('Control Plane - Permission Control', () => {
    it('should handle can_use_tool control requests', async () => {
      const canUseTool = vi.fn().mockResolvedValue({ behavior: 'allow' });
      const query = new Query(transport, {
        cwd: '/test',
        canUseTool,
      });

      const controlReq = createControlRequest('can_use_tool');
      transport.simulateMessage(controlReq);

      await vi.waitFor(() => {
        expect(canUseTool).toHaveBeenCalledWith(
          'test_tool',
          { arg: 'value' },
          expect.objectContaining({
            signal: expect.any(AbortSignal),
            suggestions: null,
          }),
        );
      });

      await query.close();
    });

    it('should send control response with permission result - allow', async () => {
      const canUseTool = vi.fn().mockResolvedValue({ behavior: 'allow' });
      const query = new Query(transport, {
        cwd: '/test',
        canUseTool,
      });

      const controlReq = createControlRequest('can_use_tool', 'perm-req-1');
      transport.simulateMessage(controlReq);

      await vi.waitFor(() => {
        const responses = transport.getAllWrittenMessages();
        const response = findControlResponse(responses, 'perm-req-1');

        expect(response).toBeDefined();
        expect(response?.response.subtype).toBe('success');
        if (response?.response.subtype === 'success') {
          expect(response.response.response).toMatchObject({
            behavior: 'allow',
          });
        }
      });

      await query.close();
    });

    it('should send control response with permission result - deny', async () => {
      const canUseTool = vi.fn().mockResolvedValue({ behavior: 'deny' });
      const query = new Query(transport, {
        cwd: '/test',
        canUseTool,
      });

      const controlReq = createControlRequest('can_use_tool', 'perm-req-2');
      transport.simulateMessage(controlReq);

      await vi.waitFor(() => {
        const responses = transport.getAllWrittenMessages();
        const response = findControlResponse(responses, 'perm-req-2');

        expect(response).toBeDefined();
        expect(response?.response.subtype).toBe('success');
        if (response?.response.subtype === 'success') {
          expect(response.response.response).toMatchObject({
            behavior: 'deny',
          });
        }
      });

      await query.close();
    });

    it('should default to denying tools if no callback', async () => {
      const query = new Query(transport, {
        cwd: '/test',
      });

      const controlReq = createControlRequest('can_use_tool', 'perm-req-3');
      transport.simulateMessage(controlReq);

      await vi.waitFor(() => {
        const responses = transport.getAllWrittenMessages();
        const response = findControlResponse(responses, 'perm-req-3');

        expect(response).toBeDefined();
        expect(response?.response.subtype).toBe('success');
        if (response?.response.subtype === 'success') {
          expect(response.response.response).toMatchObject({
            behavior: 'deny',
          });
        }
      });

      await query.close();
    });

    it('should handle permission callback timeout', async () => {
      const canUseTool = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ behavior: 'allow' }), 15000);
          }),
      );

      const query = new Query(transport, {
        cwd: '/test',
        canUseTool,
        timeout: {
          canUseTool: 10000,
        },
      });

      const controlReq = createControlRequest('can_use_tool', 'perm-req-4');
      transport.simulateMessage(controlReq);

      await vi.waitFor(
        () => {
          const responses = transport.getAllWrittenMessages();
          const response = findControlResponse(responses, 'perm-req-4');

          expect(response).toBeDefined();
          expect(response?.response.subtype).toBe('success');
          if (response?.response.subtype === 'success') {
            expect(response.response.response).toMatchObject({
              behavior: 'deny',
            });
          }
        },
        { timeout: 15000 },
      );

      await query.close();
    });

    it('should handle permission callback errors', async () => {
      const canUseTool = vi.fn().mockRejectedValue(new Error('Callback error'));
      const query = new Query(transport, {
        cwd: '/test',
        canUseTool,
      });

      const controlReq = createControlRequest('can_use_tool', 'perm-req-5');
      transport.simulateMessage(controlReq);

      await vi.waitFor(() => {
        const responses = transport.getAllWrittenMessages();
        const response = findControlResponse(responses, 'perm-req-5');

        expect(response).toBeDefined();
        expect(response?.response.subtype).toBe('success');
        if (response?.response.subtype === 'success') {
          expect(response.response.response).toMatchObject({
            behavior: 'deny',
          });
        }
      });

      await query.close();
    });

    it('should handle PermissionResult format with updatedInput', async () => {
      const canUseTool = vi.fn().mockResolvedValue({
        behavior: 'allow',
        updatedInput: { arg: 'modified' },
      });

      const query = new Query(transport, {
        cwd: '/test',
        canUseTool,
      });

      const controlReq = createControlRequest('can_use_tool', 'perm-req-6');
      transport.simulateMessage(controlReq);

      await vi.waitFor(() => {
        const responses = transport.getAllWrittenMessages();
        const response = findControlResponse(responses, 'perm-req-6');

        expect(response).toBeDefined();
        if (response?.response.subtype === 'success') {
          expect(response.response.response).toMatchObject({
            behavior: 'allow',
            updatedInput: { arg: 'modified' },
          });
        }
      });

      await query.close();
    });

    it('should handle permission denial with interrupt flag', async () => {
      const canUseTool = vi.fn().mockResolvedValue({
        behavior: 'deny',
        message: 'Denied by user',
        interrupt: true,
      });

      const query = new Query(transport, {
        cwd: '/test',
        canUseTool,
      });

      const controlReq = createControlRequest('can_use_tool', 'perm-req-7');
      transport.simulateMessage(controlReq);

      await vi.waitFor(() => {
        const responses = transport.getAllWrittenMessages();
        const response = findControlResponse(responses, 'perm-req-7');

        expect(response).toBeDefined();
        if (response?.response.subtype === 'success') {
          expect(response.response.response).toMatchObject({
            behavior: 'deny',
            message: 'Denied by user',
            interrupt: true,
          });
        }
      });

      await query.close();
    });
  });

  describe('Control Plane - Control Cancel', () => {
    it('should handle control cancel requests', async () => {
      const canUseTool = vi.fn().mockImplementation(
        (
          _toolName: string,
          _toolInput: unknown,
          { signal }: { signal: AbortSignal },
        ) =>
          new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new AbortError()));
            setTimeout(() => resolve({ behavior: 'allow' }), 5000);
          }),
      );

      const query = new Query(transport, {
        cwd: '/test',
        canUseTool,
      });

      const controlReq = createControlRequest('can_use_tool', 'cancel-req-1');
      transport.simulateMessage(controlReq);

      // Wait a bit then send cancel
      await new Promise((resolve) => setTimeout(resolve, 100));
      transport.simulateMessage(createControlCancel('cancel-req-1'));

      await vi.waitFor(() => {
        expect(canUseTool).toHaveBeenCalled();
      });

      await query.close();
    });

    it('should ignore cancel for unknown request_id', async () => {
      const query = new Query(transport, {
        cwd: '/test',
      });

      // Send cancel for non-existent request
      transport.simulateMessage(createControlCancel('unknown-req'));

      // Should not throw or cause issues
      await new Promise((resolve) => setTimeout(resolve, 100));

      await query.close();
    });
  });

  describe('Multi-Turn Conversation', () => {
    it('should support streamInput() for follow-up messages', async () => {
      const query = new Query(transport, { cwd: '/test' });

      // Respond to initialize
      await vi.waitFor(() => {
        expect(transport.writtenMessages.length).toBeGreaterThan(0);
      });
      const initRequest =
        transport.getLastWrittenMessage() as CLIControlRequest;
      transport.simulateMessage(
        createControlResponse(initRequest.request_id, true, {}),
      );

      await query.initialized;

      async function* messageGenerator() {
        yield createUserMessage('Follow-up 1');
        yield createUserMessage('Follow-up 2');
      }

      await query.streamInput(messageGenerator());

      const messages = transport.getAllWrittenMessages();
      const userMessages = messages.filter(
        (msg: unknown) =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'user',
      );
      expect(userMessages.length).toBeGreaterThanOrEqual(2);

      await query.close();
    });

    it('should maintain session context across turns', async () => {
      const query = new Query(transport, { cwd: '/test' });
      const sessionId = query.getSessionId();

      // Respond to initialize
      await vi.waitFor(() => {
        expect(transport.writtenMessages.length).toBeGreaterThan(0);
      });
      const initRequest =
        transport.getLastWrittenMessage() as CLIControlRequest;
      transport.simulateMessage(
        createControlResponse(initRequest.request_id, true, {}),
      );

      await query.initialized;

      async function* messageGenerator() {
        yield createUserMessage('Turn 1', sessionId);
        yield createUserMessage('Turn 2', sessionId);
      }

      await query.streamInput(messageGenerator());

      const messages = transport.getAllWrittenMessages();
      const userMessages = messages.filter(
        (msg: unknown) =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'user',
      ) as SDKUserMessage[];

      userMessages.forEach((msg) => {
        expect(msg.session_id).toBe(sessionId);
      });

      await query.close();
    });

    it('should throw if streamInput() called on closed query', async () => {
      const query = new Query(transport, { cwd: '/test' });
      await query.close();

      async function* messageGenerator() {
        yield createUserMessage('Test');
      }

      await expect(query.streamInput(messageGenerator())).rejects.toThrow(
        'Query is closed',
      );
    });

    it('should handle abort during streamInput', async () => {
      const abortController = new AbortController();
      const query = new Query(transport, {
        cwd: '/test',
        abortController,
      });

      // Respond to initialize
      await vi.waitFor(() => {
        expect(transport.writtenMessages.length).toBeGreaterThan(0);
      });
      const initRequest =
        transport.getLastWrittenMessage() as CLIControlRequest;
      transport.simulateMessage(
        createControlResponse(initRequest.request_id, true, {}),
      );

      await query.initialized;

      async function* messageGenerator() {
        yield createUserMessage('Message 1');
        abortController.abort();
        yield createUserMessage('Message 2'); // Should not be sent
      }

      await query.streamInput(messageGenerator());

      await query.close();
    });
  });

  describe('Lifecycle Management', () => {
    it('should close transport on close()', async () => {
      const query = new Query(transport, { cwd: '/test' });
      await query.close();

      expect(transport.closed).toBe(true);
    });

    it('should mark query as closed', async () => {
      const query = new Query(transport, { cwd: '/test' });
      expect(query.isClosed()).toBe(false);

      await query.close();
      expect(query.isClosed()).toBe(true);
    });

    it('should complete output stream on close()', async () => {
      const query = new Query(transport, { cwd: '/test' });

      const iterationPromise = (async () => {
        const messages: SDKMessage[] = [];
        for await (const msg of query) {
          messages.push(msg);
        }
        return messages;
      })();

      await query.close();
      transport.simulateClose();

      const messages = await iterationPromise;
      expect(Array.isArray(messages)).toBe(true);
    });

    it('should be idempotent when closing multiple times', async () => {
      const query = new Query(transport, { cwd: '/test' });

      await query.close();
      await query.close();
      await query.close();

      expect(query.isClosed()).toBe(true);
    });

    it('should handle abort signal cancellation', async () => {
      const abortController = new AbortController();
      const query = new Query(transport, {
        cwd: '/test',
        abortController,
      });

      abortController.abort();

      await vi.waitFor(() => {
        expect(query.isClosed()).toBe(true);
      });
    });

    it('should handle pre-aborted signal', async () => {
      const abortController = new AbortController();
      abortController.abort();

      const query = new Query(transport, {
        cwd: '/test',
        abortController,
      });

      await vi.waitFor(() => {
        expect(query.isClosed()).toBe(true);
      });
    });
  });

  describe('Async Iteration', () => {
    it('should support for await loop', async () => {
      const query = new Query(transport, { cwd: '/test' });

      const messages: SDKMessage[] = [];
      const iterationPromise = (async () => {
        for await (const msg of query) {
          messages.push(msg);
          if (messages.length >= 2) break;
        }
      })();

      transport.simulateMessage(createUserMessage('First'));
      transport.simulateMessage(createAssistantMessage('Second'));

      await iterationPromise;

      expect(messages).toHaveLength(2);
      expect((messages[0] as SDKUserMessage).message.content).toBe('First');

      await query.close();
    });

    it('should complete iteration when query closes', async () => {
      const query = new Query(transport, { cwd: '/test' });

      const messages: SDKMessage[] = [];
      const iterationPromise = (async () => {
        for await (const msg of query) {
          messages.push(msg);
        }
      })();

      transport.simulateMessage(createUserMessage('Test'));

      // Give time for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 10));

      await query.close();
      transport.simulateClose();

      await iterationPromise;
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it('should propagate transport errors', async () => {
      const query = new Query(transport, { cwd: '/test' });

      const iterationPromise = (async () => {
        for await (const msg of query) {
          void msg;
        }
      })();

      transport.simulateError(new Error('Transport error'));

      await expect(iterationPromise).rejects.toThrow('Transport error');

      await query.close();
    });
  });

  describe('Public API Methods', () => {
    it('should provide interrupt() method', async () => {
      const query = new Query(transport, { cwd: '/test' });

      // Respond to initialize
      await vi.waitFor(() => {
        expect(transport.writtenMessages.length).toBeGreaterThan(0);
      });
      const initRequest =
        transport.getLastWrittenMessage() as CLIControlRequest;
      transport.simulateMessage(
        createControlResponse(initRequest.request_id, true, {}),
      );

      await query.initialized;

      const interruptPromise = query.interrupt();

      await vi.waitFor(() => {
        const messages = transport.getAllWrittenMessages();
        const interruptMsg = findControlRequest(
          messages,
          ControlRequestType.INTERRUPT,
        );
        expect(interruptMsg).toBeDefined();
      });

      // Respond to interrupt
      const messages = transport.getAllWrittenMessages();
      const interruptMsg = findControlRequest(
        messages,
        ControlRequestType.INTERRUPT,
      )!;
      transport.simulateMessage(
        createControlResponse(interruptMsg.request_id, true, {}),
      );

      await interruptPromise;
      await query.close();
    });

    it('should provide setPermissionMode() method', async () => {
      const query = new Query(transport, { cwd: '/test' });

      // Respond to initialize
      await vi.waitFor(() => {
        expect(transport.writtenMessages.length).toBeGreaterThan(0);
      });
      const initRequest =
        transport.getLastWrittenMessage() as CLIControlRequest;
      transport.simulateMessage(
        createControlResponse(initRequest.request_id, true, {}),
      );

      await query.initialized;

      const setModePromise = query.setPermissionMode('yolo');

      await vi.waitFor(() => {
        const messages = transport.getAllWrittenMessages();
        const setModeMsg = findControlRequest(
          messages,
          ControlRequestType.SET_PERMISSION_MODE,
        );
        expect(setModeMsg).toBeDefined();
      });

      // Respond to set permission mode
      const messages = transport.getAllWrittenMessages();
      const setModeMsg = findControlRequest(
        messages,
        ControlRequestType.SET_PERMISSION_MODE,
      )!;
      transport.simulateMessage(
        createControlResponse(setModeMsg.request_id, true, {}),
      );

      await setModePromise;
      await query.close();
    });

    it('should provide setModel() method', async () => {
      const query = new Query(transport, { cwd: '/test' });

      // Respond to initialize
      await vi.waitFor(() => {
        expect(transport.writtenMessages.length).toBeGreaterThan(0);
      });
      const initRequest =
        transport.getLastWrittenMessage() as CLIControlRequest;
      transport.simulateMessage(
        createControlResponse(initRequest.request_id, true, {}),
      );

      await query.initialized;

      const setModelPromise = query.setModel('new-model');

      await vi.waitFor(() => {
        const messages = transport.getAllWrittenMessages();
        const setModelMsg = findControlRequest(
          messages,
          ControlRequestType.SET_MODEL,
        );
        expect(setModelMsg).toBeDefined();
      });

      // Respond to set model
      const messages = transport.getAllWrittenMessages();
      const setModelMsg = findControlRequest(
        messages,
        ControlRequestType.SET_MODEL,
      )!;
      transport.simulateMessage(
        createControlResponse(setModelMsg.request_id, true, {}),
      );

      await setModelPromise;
      await query.close();
    });

    it('should provide supportedCommands() method', async () => {
      const query = new Query(transport, { cwd: '/test' });

      // Respond to initialize
      await vi.waitFor(() => {
        expect(transport.writtenMessages.length).toBeGreaterThan(0);
      });
      const initRequest =
        transport.getLastWrittenMessage() as CLIControlRequest;
      transport.simulateMessage(
        createControlResponse(initRequest.request_id, true, {}),
      );

      await query.initialized;

      const commandsPromise = query.supportedCommands();

      await vi.waitFor(() => {
        const messages = transport.getAllWrittenMessages();
        const commandsMsg = findControlRequest(
          messages,
          ControlRequestType.SUPPORTED_COMMANDS,
        );
        expect(commandsMsg).toBeDefined();
      });

      // Respond with commands
      const messages = transport.getAllWrittenMessages();
      const commandsMsg = findControlRequest(
        messages,
        ControlRequestType.SUPPORTED_COMMANDS,
      )!;
      transport.simulateMessage(
        createControlResponse(commandsMsg.request_id, true, {
          commands: ['interrupt', 'set_model'],
        }),
      );

      const result = await commandsPromise;
      expect(result).toMatchObject({ commands: ['interrupt', 'set_model'] });

      await query.close();
    });

    it('should provide mcpServerStatus() method', async () => {
      const query = new Query(transport, { cwd: '/test' });

      // Respond to initialize
      await vi.waitFor(() => {
        expect(transport.writtenMessages.length).toBeGreaterThan(0);
      });
      const initRequest =
        transport.getLastWrittenMessage() as CLIControlRequest;
      transport.simulateMessage(
        createControlResponse(initRequest.request_id, true, {}),
      );

      await query.initialized;

      const statusPromise = query.mcpServerStatus();

      await vi.waitFor(() => {
        const messages = transport.getAllWrittenMessages();
        const statusMsg = findControlRequest(
          messages,
          ControlRequestType.MCP_SERVER_STATUS,
        );
        expect(statusMsg).toBeDefined();
      });

      // Respond with status
      const messages = transport.getAllWrittenMessages();
      const statusMsg = findControlRequest(
        messages,
        ControlRequestType.MCP_SERVER_STATUS,
      )!;
      transport.simulateMessage(
        createControlResponse(statusMsg.request_id, true, {
          servers: [{ name: 'test', status: 'connected' }],
        }),
      );

      const result = await statusPromise;
      expect(result).toMatchObject({
        servers: [{ name: 'test', status: 'connected' }],
      });

      await query.close();
    });

    it('should throw if methods called on closed query', async () => {
      const query = new Query(transport, { cwd: '/test' });
      await query.close();

      await expect(query.interrupt()).rejects.toThrow('Query is closed');
      await expect(query.setPermissionMode('yolo')).rejects.toThrow(
        'Query is closed',
      );
      await expect(query.setModel('model')).rejects.toThrow('Query is closed');
      await expect(query.supportedCommands()).rejects.toThrow(
        'Query is closed',
      );
      await expect(query.mcpServerStatus()).rejects.toThrow('Query is closed');
    });
  });

  describe('Error Handling', () => {
    it('should propagate transport errors to stream', async () => {
      const query = new Query(transport, { cwd: '/test' });

      const error = new Error('Transport failure');
      transport.simulateError(error);

      await expect(query.next()).rejects.toThrow('Transport failure');

      await query.close();
    });

    it('should handle control request timeout', async () => {
      const query = new Query(transport, {
        cwd: '/test',
        timeout: {
          controlRequest: 10000,
        },
      });

      // Respond to initialize
      await vi.waitFor(() => {
        expect(transport.writtenMessages.length).toBeGreaterThan(0);
      });
      const initRequest =
        transport.getLastWrittenMessage() as CLIControlRequest;
      transport.simulateMessage(
        createControlResponse(initRequest.request_id, true, {}),
      );

      await query.initialized;

      // Call interrupt but don't respond - should timeout
      const interruptPromise = query.interrupt();

      await expect(interruptPromise).rejects.toThrow(/timeout/i);

      await query.close();
    }, 15000);

    it('should handle malformed control responses', async () => {
      const query = new Query(transport, { cwd: '/test' });

      // Respond to initialize
      await vi.waitFor(() => {
        expect(transport.writtenMessages.length).toBeGreaterThan(0);
      });
      const initRequest =
        transport.getLastWrittenMessage() as CLIControlRequest;
      transport.simulateMessage(
        createControlResponse(initRequest.request_id, true, {}),
      );

      await query.initialized;

      const interruptPromise = query.interrupt();

      await vi.waitFor(() => {
        const messages = transport.getAllWrittenMessages();
        const interruptMsg = findControlRequest(
          messages,
          ControlRequestType.INTERRUPT,
        );
        expect(interruptMsg).toBeDefined();
      });

      // Send malformed response
      const messages = transport.getAllWrittenMessages();
      const interruptMsg = findControlRequest(
        messages,
        ControlRequestType.INTERRUPT,
      )!;

      transport.simulateMessage({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: interruptMsg.request_id,
          error: { message: 'Malformed error' },
        },
      });

      await expect(interruptPromise).rejects.toThrow('Malformed error');

      await query.close();
    });

    it('should handle CLI sending error result message', async () => {
      const query = new Query(transport, { cwd: '/test' });

      const errorResult = createResultMessage(false);
      transport.simulateMessage(errorResult);

      const result = await query.next();
      expect(result.done).toBe(false);
      expect((result.value as SDKResultMessage).is_error).toBe(true);

      await query.close();
    });
  });

  describe('Single-Turn Mode', () => {
    it('should auto-close input after result in single-turn mode', async () => {
      const query = new Query(
        transport,
        { cwd: '/test' },
        true, // singleTurn = true
      );

      const resultMsg = createResultMessage(true);
      transport.simulateMessage(resultMsg);

      await query.next();

      expect(transport.endInputCalled).toBe(true);

      await query.close();
    });

    it('should not auto-close input in multi-turn mode', async () => {
      const query = new Query(
        transport,
        { cwd: '/test' },
        false, // singleTurn = false
      );

      const resultMsg = createResultMessage(true);
      transport.simulateMessage(resultMsg);

      await query.next();

      expect(transport.endInputCalled).toBe(false);

      await query.close();
    });
  });

  describe('State Management', () => {
    it('should track session ID', () => {
      const query = new Query(transport, { cwd: '/test' });
      const sessionId = query.getSessionId();

      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);
    });

    it('should track closed state', async () => {
      const query = new Query(transport, { cwd: '/test' });

      expect(query.isClosed()).toBe(false);
      await query.close();
      expect(query.isClosed()).toBe(true);
    });

    it('should provide endInput() method', async () => {
      const query = new Query(transport, { cwd: '/test' });

      // Respond to initialize
      await vi.waitFor(() => {
        expect(transport.writtenMessages.length).toBeGreaterThan(0);
      });
      const initRequest =
        transport.getLastWrittenMessage() as CLIControlRequest;
      transport.simulateMessage(
        createControlResponse(initRequest.request_id, true, {}),
      );

      await query.initialized;

      query.endInput();
      expect(transport.endInputCalled).toBe(true);

      await query.close();
    });

    it('should throw if endInput() called on closed query', async () => {
      const query = new Query(transport, { cwd: '/test' });
      await query.close();

      expect(() => query.endInput()).toThrow('Query is closed');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty message stream', async () => {
      const query = new Query(transport, { cwd: '/test' });

      transport.simulateClose();

      const result = await query.next();
      expect(result.done).toBe(true);

      await query.close();
    });

    it('should handle rapid message flow', async () => {
      const query = new Query(transport, { cwd: '/test' });

      // Simulate rapid messages
      for (let i = 0; i < 100; i++) {
        transport.simulateMessage(createUserMessage(`Message ${i}`));
      }

      const messages: SDKMessage[] = [];
      for (let i = 0; i < 100; i++) {
        const result = await query.next();
        if (!result.done) {
          messages.push(result.value);
        }
      }

      expect(messages.length).toBe(100);

      await query.close();
    });

    it('should handle close during message iteration', async () => {
      const query = new Query(transport, { cwd: '/test' });

      const iterationPromise = (async () => {
        const messages: SDKMessage[] = [];
        for await (const msg of query) {
          messages.push(msg);
          if (messages.length === 2) {
            await query.close();
          }
        }
        return messages;
      })();

      transport.simulateMessage(createUserMessage('First'));
      transport.simulateMessage(createUserMessage('Second'));
      transport.simulateMessage(createUserMessage('Third'));
      transport.simulateClose();

      const messages = await iterationPromise;
      expect(messages.length).toBeGreaterThanOrEqual(2);
    });
  });
});
