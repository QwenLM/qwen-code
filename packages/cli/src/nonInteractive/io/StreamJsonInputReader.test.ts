/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StreamJsonInputReader,
  StreamJsonParseError,
  type StreamJsonInputMessage,
} from './StreamJsonInputReader.js';

describe('StreamJsonInputReader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('read', () => {
    /**
     * Test parsing all supported message types in a single test
     */
    it('should parse valid messages of all types', async () => {
      const input = new PassThrough();
      const reader = new StreamJsonInputReader(input);

      const messages = [
        {
          type: 'user',
          session_id: 'test-session',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'hello world' }],
          },
          parent_tool_use_id: null,
        },
        {
          type: 'control_request',
          request_id: 'req-1',
          request: { subtype: 'initialize' },
        },
        {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'req-1',
            response: { initialized: true },
          },
        },
        {
          type: 'control_cancel_request',
          request_id: 'req-1',
        },
      ];

      for (const msg of messages) {
        input.write(JSON.stringify(msg) + '\n');
      }
      input.end();

      const parsed: StreamJsonInputMessage[] = [];
      for await (const msg of reader.read()) {
        parsed.push(msg);
      }

      expect(parsed).toHaveLength(messages.length);
      expect(parsed).toEqual(messages);
    });

    it('should parse multiple messages', async () => {
      const input = new PassThrough();
      const reader = new StreamJsonInputReader(input);

      const message1 = {
        type: 'control_request',
        request_id: 'req-1',
        request: { subtype: 'initialize' },
      };

      const message2 = {
        type: 'user',
        session_id: 'test-session',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
        parent_tool_use_id: null,
      };

      input.write(JSON.stringify(message1) + '\n');
      input.write(JSON.stringify(message2) + '\n');
      input.end();

      const messages: StreamJsonInputMessage[] = [];
      for await (const msg of reader.read()) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual(message1);
      expect(messages[1]).toEqual(message2);
    });

    it('should skip empty lines and trim whitespace', async () => {
      const input = new PassThrough();
      const reader = new StreamJsonInputReader(input);

      const message = {
        type: 'user',
        session_id: 'test-session',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
        parent_tool_use_id: null,
      };

      input.write('\n');
      input.write('  ' + JSON.stringify(message) + '  \n');
      input.write('  \n');
      input.write('\t\n');
      input.end();

      const messages: StreamJsonInputMessage[] = [];
      for await (const msg of reader.read()) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(message);
    });

    /**
     * Consolidated error handling test cases
     */
    it.each([
      {
        name: 'invalid JSON',
        input: '{"invalid": json}\n',
        expectedError: 'Failed to parse stream-json line',
      },
      {
        name: 'missing type field',
        input:
          JSON.stringify({ session_id: 'test-session', message: 'hello' }) +
          '\n',
        expectedError: 'Missing required "type" field',
      },
      {
        name: 'non-object value (string)',
        input: '"just a string"\n',
        expectedError: 'Parsed value is not an object',
      },
      {
        name: 'non-object value (null)',
        input: 'null\n',
        expectedError: 'Parsed value is not an object',
      },
      {
        name: 'array value',
        input: '[1, 2, 3]\n',
        expectedError: 'Missing required "type" field',
      },
      {
        name: 'type field not a string',
        input: JSON.stringify({ type: 123, session_id: 'test-session' }) + '\n',
        expectedError: 'Missing required "type" field',
      },
    ])(
      'should throw StreamJsonParseError for $name',
      async ({ input: inputLine, expectedError }) => {
        const input = new PassThrough();
        const reader = new StreamJsonInputReader(input);

        input.write(inputLine);
        input.end();

        const messages: StreamJsonInputMessage[] = [];
        let error: unknown;

        try {
          for await (const msg of reader.read()) {
            messages.push(msg);
          }
        } catch (e) {
          error = e;
        }

        expect(messages).toHaveLength(0);
        expect(error).toBeInstanceOf(StreamJsonParseError);
        expect((error as StreamJsonParseError).message).toContain(
          expectedError,
        );
      },
    );

    it('should use process.stdin as default input', () => {
      const reader = new StreamJsonInputReader();
      // Access private field for testing constructor default parameter
      expect((reader as unknown as { input: typeof process.stdin }).input).toBe(
        process.stdin,
      );
    });

    it('should use provided input stream', () => {
      const customInput = new PassThrough();
      const reader = new StreamJsonInputReader(customInput);
      // Access private field for testing constructor parameter
      expect((reader as unknown as { input: typeof customInput }).input).toBe(
        customInput,
      );
    });
  });
});
