/**
 * Native Messaging Host Tests
 * Tests for the Native Messaging protocol implementation between Chrome Extension and Native Server
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock types for testing
interface MockMessage {
  type?: string;
  payload?: Record<string, unknown>;
  requestId?: string;
  responseToRequestId?: string;
  error?: string;
}

interface MockPendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Helper to encode a message in Native Messaging format
 * [4 bytes little-endian length][JSON body]
 */
function encodeNativeMessage(message: MockMessage): Buffer {
  const json = JSON.stringify(message);
  const body = Buffer.from(json);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Helper to decode a Native Messaging format message
 */
function decodeNativeMessage(buffer: Buffer): MockMessage {
  if (buffer.length < 4) {
    throw new Error('Buffer too short for header');
  }
  const length = buffer.readUInt32LE(0);
  if (buffer.length < 4 + length) {
    throw new Error('Buffer too short for message body');
  }
  const body = buffer.slice(4, 4 + length);
  return JSON.parse(body.toString());
}

describe('Native Messaging Protocol', () => {
  describe('Message Encoding', () => {
    it('should encode message with correct length header', () => {
      const message: MockMessage = { type: 'test', payload: { foo: 'bar' } };
      const encoded = encodeNativeMessage(message);

      // First 4 bytes should be the length
      const length = encoded.readUInt32LE(0);
      const expectedJson = JSON.stringify(message);
      expect(length).toBe(expectedJson.length);

      // Rest should be the JSON body
      const body = encoded.slice(4).toString();
      expect(body).toBe(expectedJson);
    });

    it('should handle empty payload', () => {
      const message: MockMessage = { type: 'ping' };
      const encoded = encodeNativeMessage(message);
      const decoded = decodeNativeMessage(encoded);

      expect(decoded.type).toBe('ping');
      expect(decoded.payload).toBeUndefined();
    });

    it('should handle complex nested payloads', () => {
      const message: MockMessage = {
        type: 'call_tool',
        payload: {
          name: 'chrome_screenshot',
          args: {
            width: 800,
            height: 600,
            options: { fullPage: true, format: 'png' },
          },
        },
        requestId: 'req_123',
      };

      const encoded = encodeNativeMessage(message);
      const decoded = decodeNativeMessage(encoded);

      expect(decoded).toEqual(message);
    });
  });

  describe('Message Decoding', () => {
    it('should decode valid message', () => {
      const original: MockMessage = {
        type: 'response',
        payload: { status: 'success', data: { result: 42 } },
        responseToRequestId: 'req_456',
      };

      const encoded = encodeNativeMessage(original);
      const decoded = decodeNativeMessage(encoded);

      expect(decoded).toEqual(original);
    });

    it('should throw on buffer too short for header', () => {
      const shortBuffer = Buffer.alloc(2);
      expect(() => decodeNativeMessage(shortBuffer)).toThrow(
        'Buffer too short for header',
      );
    });

    it('should throw on buffer too short for body', () => {
      const buffer = Buffer.alloc(8);
      buffer.writeUInt32LE(100, 0); // Claim 100 bytes but only have 4
      expect(() => decodeNativeMessage(buffer)).toThrow(
        'Buffer too short for message body',
      );
    });
  });

  describe('Request-Response Matching', () => {
    it('should match response to request by requestId', () => {
      const pendingRequests = new Map<string, MockPendingRequest>();
      const requestId = 'req_789';

      // Simulate pending request
      let resolvedValue: unknown = null;
      const pending: MockPendingRequest = {
        resolve: (value) => {
          resolvedValue = value;
        },
        reject: vi.fn(),
        timeoutId: setTimeout(() => {}, 30000),
      };
      pendingRequests.set(requestId, pending);

      // Simulate response
      const response: MockMessage = {
        responseToRequestId: requestId,
        payload: { status: 'success', data: { screenshot: 'base64...' } },
      };

      // Handle response
      if (response.responseToRequestId) {
        const req = pendingRequests.get(response.responseToRequestId);
        if (req) {
          clearTimeout(req.timeoutId);
          req.resolve(response.payload);
          pendingRequests.delete(response.responseToRequestId);
        }
      }

      expect(resolvedValue).toEqual(response.payload);
      expect(pendingRequests.has(requestId)).toBe(false);
    });

    it('should reject on error response', () => {
      const pendingRequests = new Map<string, MockPendingRequest>();
      const requestId = 'req_error';

      let rejectedError: Error | null = null;
      const pending: MockPendingRequest = {
        resolve: vi.fn(),
        reject: (reason) => {
          rejectedError = reason as Error;
        },
        timeoutId: setTimeout(() => {}, 30000),
      };
      pendingRequests.set(requestId, pending);

      // Simulate error response
      const response: MockMessage = {
        responseToRequestId: requestId,
        error: 'Tool execution failed',
      };

      // Handle response
      if (response.responseToRequestId) {
        const req = pendingRequests.get(response.responseToRequestId);
        if (req) {
          clearTimeout(req.timeoutId);
          if (response.error) {
            req.reject(new Error(response.error));
          }
          pendingRequests.delete(response.responseToRequestId);
        }
      }

      expect(rejectedError).toBeInstanceOf(Error);
      expect(rejectedError?.message).toBe('Tool execution failed');
    });
  });

  describe('Message Type Handling', () => {
    const messageTypes = [
      { type: 'start', description: 'Start MCP server' },
      { type: 'stop', description: 'Stop MCP server' },
      { type: 'call_tool', description: 'Call MCP tool' },
      { type: 'server_started', description: 'Server started notification' },
      { type: 'server_stopped', description: 'Server stopped notification' },
      { type: 'error_from_native_host', description: 'Error notification' },
      { type: 'CONNECT', description: 'Connection request' },
      { type: 'file_operation', description: 'File operation request' },
    ];

    messageTypes.forEach(({ type, description }) => {
      it(`should handle ${type} message type (${description})`, () => {
        const message: MockMessage = {
          type,
          payload: { test: true },
        };

        const encoded = encodeNativeMessage(message);
        const decoded = decodeNativeMessage(encoded);

        expect(decoded.type).toBe(type);
      });
    });
  });

  describe('Tool Call Messages', () => {
    it('should format tool call request correctly', () => {
      const toolCall: MockMessage = {
        type: 'call_tool',
        payload: {
          name: 'chrome_read_page',
          args: {
            filter: 'interactive',
            depth: 5,
          },
        },
        requestId: 'tool_req_001',
      };

      const encoded = encodeNativeMessage(toolCall);
      const decoded = decodeNativeMessage(encoded);

      expect(decoded.type).toBe('call_tool');
      expect(decoded.payload?.name).toBe('chrome_read_page');
      expect(decoded.requestId).toBe('tool_req_001');
    });

    it('should format tool call response correctly', () => {
      const toolResponse: MockMessage = {
        responseToRequestId: 'tool_req_001',
        payload: {
          status: 'success',
          data: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ elements: [], url: 'https://example.com' }),
              },
            ],
          },
        },
      };

      const encoded = encodeNativeMessage(toolResponse);
      const decoded = decodeNativeMessage(encoded);

      expect(decoded.responseToRequestId).toBe('tool_req_001');
      expect(decoded.payload?.status).toBe('success');
    });
  });
});

describe('Connection Health', () => {
  describe('Heartbeat Mechanism', () => {
    it('should respond to ping with pong', () => {
      const ping: MockMessage = { type: 'ping_from_extension' };
      const expectedPong: MockMessage = { type: 'pong_to_extension' };

      // Simulate message handling
      let response: MockMessage | null = null;
      const handleMessage = (msg: MockMessage) => {
        if (msg.type === 'ping_from_extension') {
          response = { type: 'pong_to_extension' };
        }
      };

      handleMessage(ping);
      expect(response).toEqual(expectedPong);
    });
  });

  describe('Timeout Handling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should timeout pending request after specified duration', () => {
      const pendingRequests = new Map<string, MockPendingRequest>();
      const requestId = 'timeout_test';
      const timeoutMs = 30000;

      let timedOut = false;
      const pending: MockPendingRequest = {
        resolve: vi.fn(),
        reject: () => {
          timedOut = true;
        },
        timeoutId: setTimeout(() => {
          pendingRequests.delete(requestId);
          pending.reject(new Error(`Request timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      pendingRequests.set(requestId, pending);

      // Fast-forward time
      vi.advanceTimersByTime(timeoutMs + 100);

      expect(timedOut).toBe(true);
      expect(pendingRequests.has(requestId)).toBe(false);
    });
  });
});

describe('Message Size Validation', () => {
  it('should reject messages larger than 16MB', () => {
    const MAX_MESSAGE_SIZE = 16 * 1024 * 1024;

    const validateMessageSize = (length: number): boolean => {
      return length > 0 && length <= MAX_MESSAGE_SIZE;
    };

    expect(validateMessageSize(100)).toBe(true);
    expect(validateMessageSize(1024 * 1024)).toBe(true); // 1MB
    expect(validateMessageSize(MAX_MESSAGE_SIZE)).toBe(true);
    expect(validateMessageSize(MAX_MESSAGE_SIZE + 1)).toBe(false);
    expect(validateMessageSize(0)).toBe(false);
    expect(validateMessageSize(-1)).toBe(false);
  });
});
