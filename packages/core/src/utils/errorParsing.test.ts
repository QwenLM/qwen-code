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
});
