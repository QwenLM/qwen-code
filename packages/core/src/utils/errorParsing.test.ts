/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseAndFormatApiError } from './errorParsing.js';
import { AuthType } from '../core/contentGenerator.js';
import type { StructuredError } from '../core/turn.js';

describe('parseAndFormatApiError', () => {
  const vertexMessage = 'request a quota increase through Vertex';
  const geminiMessage = 'request a quota increase through AI Studio';

  it('should format a valid API error JSON', () => {
    const errorMessage =
      'got status: 400 Bad Request. {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}';
    const expected =
      '[API Error: API key not valid. Please pass a valid API key. (Status: INVALID_ARGUMENT)]';
    expect(parseAndFormatApiError(errorMessage)).toBe(expected);
  });

  it('should format a 429 API error with the default message', () => {
    const errorMessage =
      'got status: 429 Too Many Requests. {"error":{"code":429,"message":"Rate limit exceeded","status":"RESOURCE_EXHAUSTED"}}';
    const result = parseAndFormatApiError(errorMessage, undefined);
    expect(result).toContain('[API Error: Rate limit exceeded');
    expect(result).toContain(
      'Possible quota limitations in place or slow response times detected. Please wait and try again later.',
    );
  });

  it('should format a 429 API error with the vertex message', () => {
    const errorMessage =
      'got status: 429 Too Many Requests. {"error":{"code":429,"message":"Rate limit exceeded","status":"RESOURCE_EXHAUSTED"}}';
    const result = parseAndFormatApiError(errorMessage, AuthType.USE_VERTEX_AI);
    expect(result).toContain('[API Error: Rate limit exceeded');
    expect(result).toContain(vertexMessage);
  });

  it('should return the original message if it is not a JSON error', () => {
    const errorMessage = 'This is a plain old error message';
    expect(parseAndFormatApiError(errorMessage)).toBe(
      `[API Error: ${errorMessage}]`,
    );
  });

  it('should return the original message for malformed JSON', () => {
    const errorMessage = '[Stream Error: {"error": "malformed}';
    expect(parseAndFormatApiError(errorMessage)).toBe(
      `[API Error: ${errorMessage}]`,
    );
  });

  it('should handle JSON that does not match the ApiError structure', () => {
    const errorMessage = '[Stream Error: {"not_an_error": "some other json"}]';
    expect(parseAndFormatApiError(errorMessage)).toBe(
      `[API Error: ${errorMessage}]`,
    );
  });

  it('should omit status when the API error has no status field', () => {
    const errorMessage =
      '{"error":{"code":1302,"message":"您的账户已达到速率限制，请您控制请求频率"}}';
    expect(parseAndFormatApiError(errorMessage)).toBe(
      '[API Error: 您的账户已达到速率限制，请您控制请求频率]',
    );
  });

  it('should format a nested API error', () => {
    const nestedErrorMessage = JSON.stringify({
      error: {
        code: 429,
        message:
          "Gemini 2.5 Pro Preview doesn't have a free quota tier. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
        status: 'RESOURCE_EXHAUSTED',
      },
    });

    const errorMessage = JSON.stringify({
      error: {
        code: 429,
        message: nestedErrorMessage,
        status: 'Too Many Requests',
      },
    });

    const result = parseAndFormatApiError(errorMessage, AuthType.USE_GEMINI);
    expect(result).toContain('Gemini 2.5 Pro Preview');
    expect(result).toContain(geminiMessage);
  });

  it('should format a StructuredError', () => {
    const error: StructuredError = {
      message: 'A structured error occurred',
      status: 500,
    };
    const expected = '[API Error: A structured error occurred]';
    expect(parseAndFormatApiError(error)).toBe(expected);
  });

  it('should include the underlying cause of an Error', () => {
    const cause = Object.assign(new Error('fetch failed'), {
      code: 'ECONNREFUSED',
    });
    const error = new Error('Connection error.', { cause });

    expect(parseAndFormatApiError(error)).toBe(
      '[API Error: Connection error. (cause: ECONNREFUSED: fetch failed)]',
    );
  });

  it('should preserve a plain Error message when there is no cause', () => {
    expect(parseAndFormatApiError(new Error('Connection error.'))).toBe(
      '[API Error: Connection error.]',
    );
  });

  it('should include details from an AggregateError cause', () => {
    const cause = Object.assign(new Error('connect failed'), {
      code: 'ECONNREFUSED',
    });
    const error = new Error('Connection error.', {
      cause: new AggregateError([cause]),
    });

    expect(parseAndFormatApiError(error)).toContain('ECONNREFUSED');
  });

  it('should format a 429 StructuredError with the vertex message', () => {
    const error: StructuredError = {
      message: 'Rate limit exceeded',
      status: 429,
    };
    const result = parseAndFormatApiError(error, AuthType.USE_VERTEX_AI);
    expect(result).toContain('[API Error: Rate limit exceeded]');
    expect(result).toContain(vertexMessage);
  });

  it('should handle an unknown error type', () => {
    const error = 12345;
    const expected = '[API Error: An unknown error occurred.]';
    expect(parseAndFormatApiError(error)).toBe(expected);
  });

  it.each([
    'Qwen OAuth quota exceeded: retry after 12:00 UTC',
    'Qwen OAuth free tier has been discontinued for this model',
  ])('should return Qwen quota messages unchanged: %s', (message) => {
    const error: StructuredError = { message, status: 429 };

    expect(parseAndFormatApiError(error)).toBe(message);
  });

  it('should surface a friendly quota-exhaustion message verbatim (string)', () => {
    const message =
      'Quota exhausted: Your token-plan 1-week quota has been exhausted. The quota will reset at 07-27 09:25:00 UTC.\n\nPlease retry after the reset time, or switch to another API key / auth method.';
    // Must NOT be re-wrapped in "[API Error: …]" and must NOT pick up the
    // misleading "please wait and try again later" transient-throttle suffix.
    expect(parseAndFormatApiError(message)).toBe(message);
  });

  it('should surface a friendly quota-exhaustion StructuredError.message verbatim', () => {
    const message =
      'Quota exhausted: Your token-plan 1-week quota has been exhausted. The quota will reset at 07-27 09:25:00 UTC.\n\nPlease retry after the reset time, or switch to another API key / auth method.';
    const error: StructuredError = { message, status: 429 };
    expect(parseAndFormatApiError(error, AuthType.USE_OPENAI)).toBe(message);
  });

  // Idempotency — added after a customer report where a 4xx in non-interactive
  // mode produced "[API Error: [API Error: ...]]". The non-interactive runner
  // formats once, prints, then throws an Error whose .message is the formatted
  // string; the top-level handleError used to call this function again on
  // that string and double-wrap it. Returning already-formatted input
  // unchanged is the safety net that keeps the symptom from coming back even
  // if a future code path forgets to mark its throws.
  describe('idempotency', () => {
    it('returns an already-formatted plain string unchanged', () => {
      const formatted =
        '[API Error: 402 Model X is not available for billing.]';
      expect(parseAndFormatApiError(formatted)).toBe(formatted);
    });

    it('returns an already-formatted 429 plain string with quota guidance unchanged', () => {
      const formatted =
        '[API Error: Rate limit exceeded (Status: RESOURCE_EXHAUSTED)]\nPossible quota limitations in place or slow response times detected. Please wait and try again later.';
      expect(parseAndFormatApiError(formatted)).toBe(formatted);
    });

    it('returns an already-formatted StructuredError.message unchanged', () => {
      const formatted =
        '[API Error: 402 Model X is not available for billing.]';
      const error: StructuredError = { message: formatted, status: 402 };
      expect(parseAndFormatApiError(error)).toBe(formatted);
    });

    it('returns an already-formatted 429 StructuredError.message with quota guidance unchanged', () => {
      const formatted =
        '[API Error: Rate limit exceeded]\nPossible quota limitations in place or slow response times detected. Please wait and try again later.';
      const error: StructuredError = { message: formatted, status: 429 };
      expect(parseAndFormatApiError(error)).toBe(formatted);
    });

    it('returns an already-formatted 429 USE_GEMINI message unchanged', () => {
      const formatted =
        '[API Error: Rate limit exceeded]\nPlease wait and try again later. To increase your limits, request a quota increase through AI Studio, or switch to another /auth method';
      expect(parseAndFormatApiError(formatted, AuthType.USE_GEMINI)).toBe(
        formatted,
      );
    });

    it('returns an already-formatted 429 VERTEX message unchanged', () => {
      const formatted =
        '[API Error: Rate limit exceeded]\nPlease wait and try again later. To increase your limits, request a quota increase through Vertex, or switch to another /auth method';
      expect(parseAndFormatApiError(formatted, AuthType.USE_VERTEX_AI)).toBe(
        formatted,
      );
    });

    it('still wraps a raw message that merely contains the prefix mid-string', () => {
      // Defensive: the prefix check anchors at the start, so a message that
      // simply mentions the literal "[API Error: " inside a longer sentence
      // must still be wrapped (otherwise we'd silently drop the wrap).
      const raw = 'see [API Error: 502] in the upstream log for details';
      expect(parseAndFormatApiError(raw)).toBe(`[API Error: ${raw}]`);
    });
  });

  // Strict OpenAI-compatible backends (vLLM/SGLang) reject requests with a 400
  // whose body openai-node fails to capture, so the CLI shows only
  // "[API Error: 400 status code (no body)]" and the user has no traceable id
  // to quote to their provider. The SDK does stamp `x-request-id` onto
  // APIError.headers, so surface it on the user-facing line.
  // See https://github.com/QwenLM/qwen-code/issues/14115
  describe('request id surfacing', () => {
    const REQUEST_ID = 'a30a1854-1925-4da8-8803-73fee2865116';
    const BODYLESS = '400 status code (no body)';

    it('appends an already-resolved StructuredError.requestId', () => {
      const error: StructuredError = {
        message: BODYLESS,
        status: 400,
        requestId: REQUEST_ID,
      };

      expect(parseAndFormatApiError(error)).toBe(
        `[API Error: ${BODYLESS} (request_id: ${REQUEST_ID})]`,
      );
    });

    it('reads x-request-id off a live error carrying a real Headers instance', () => {
      // openai-node 5.x assigns a genuine `Headers` to APIError.headers, where
      // bracket access (`headers['x-request-id']`) reads undefined.
      const headers = new Headers();
      headers.set('x-request-id', REQUEST_ID);
      const error = Object.assign(new Error(BODYLESS), {
        status: 400,
        headers,
      });

      expect(parseAndFormatApiError(error)).toBe(
        `[API Error: ${BODYLESS} (request_id: ${REQUEST_ID})]`,
      );
    });

    it.each(['x-request-id', 'X-Request-Id'])(
      'reads %s off a live error carrying a plain header record',
      (headerName) => {
        const error = Object.assign(new Error(BODYLESS), {
          status: 400,
          headers: { [headerName]: REQUEST_ID },
        });

        expect(parseAndFormatApiError(error)).toBe(
          `[API Error: ${BODYLESS} (request_id: ${REQUEST_ID})]`,
        );
      },
    );

    it('omits the suffix when no request id is available', () => {
      const error: StructuredError = { message: BODYLESS, status: 400 };

      expect(parseAndFormatApiError(error)).toBe(`[API Error: ${BODYLESS}]`);
      expect(parseAndFormatApiError(new Error(BODYLESS))).toBe(
        `[API Error: ${BODYLESS}]`,
      );
    });

    it('keeps the 429 quota guidance after the request id', () => {
      const error: StructuredError = {
        message: 'Rate limit exceeded',
        status: 429,
        requestId: REQUEST_ID,
      };

      const result = parseAndFormatApiError(error, AuthType.USE_VERTEX_AI);

      expect(result).toContain(
        `[API Error: Rate limit exceeded (request_id: ${REQUEST_ID})]`,
      );
      expect(result).toContain(vertexMessage);
    });

    it('does not re-wrap a line that already carries a request id', () => {
      const formatted = `[API Error: ${BODYLESS} (request_id: ${REQUEST_ID})]`;

      expect(parseAndFormatApiError(formatted)).toBe(formatted);
      expect(parseAndFormatApiError({ message: formatted, status: 400 })).toBe(
        formatted,
      );
    });

    it('bounds an over-long provider-supplied request id', () => {
      const error: StructuredError = {
        message: BODYLESS,
        status: 400,
        requestId: 'a'.repeat(5000),
      };

      const result = parseAndFormatApiError(error);

      expect(result).toContain('(request_id: ');
      expect(result.length).toBeLessThan(200);
    });
  });
});
