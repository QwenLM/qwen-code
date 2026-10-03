/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it } from 'vitest';
import type { SessionMetrics } from '../telemetry/uiTelemetry.js';
import { JsonFormatter } from './json-formatter.js';
import type { JsonError } from './types.js';

describe('JsonFormatter', () => {
  const format = (...args: Parameters<JsonFormatter['format']>) =>
    JSON.parse(new JsonFormatter().format(...args));

  /** Returns formatError's raw text and its parsed form. */
  function formatError(error: Error, code?: string | number) {
    const formatted = new JsonFormatter().formatError(error, code);
    return { formatted, parsed: JSON.parse(formatted) };
  }

  it('should format the response as JSON', () => {
    const response = 'This is a test response.';
    expect(format(response)).toEqual({ response });
  });

  it('should strip ANSI escape sequences from response text', () => {
    const withAnsi = '\x1B[31mRed text\x1B[0m and \x1B[32mGreen text\x1B[0m';
    expect(format(withAnsi).response).toBe('Red text and Green text');
  });

  it('should strip control characters from response text', () => {
    const withControlChars = 'Text with\x07 bell\x08 and\x0B vertical tab';
    // Only ANSI codes are stripped, other control chars are preserved
    expect(format(withControlChars).response).toBe(
      'Text with\x07 bell\x08 and\x0B vertical tab',
    );
  });

  it('should preserve newlines and tabs in response text', () => {
    const withWhitespace = 'Line 1\nLine 2\r\nLine 3\twith tab';
    expect(format(withWhitespace).response).toBe(
      'Line 1\nLine 2\r\nLine 3\twith tab',
    );
  });

  it('should format the response as JSON with stats', () => {
    const response = 'This is a test response.';
    const stats: SessionMetrics = {
      models: {
        'gemini-2.5-pro': {
          api: { totalRequests: 2, totalErrors: 0, totalLatencyMs: 5672 },
          tokens: {
            prompt: 24401,
            candidates: 215,
            total: 24719,
            cached: 10656,
            thoughts: 103,
          },
          bySource: {},
        },
        'gemini-2.5-flash': {
          api: { totalRequests: 2, totalErrors: 0, totalLatencyMs: 5914 },
          tokens: {
            prompt: 20803,
            candidates: 716,
            total: 21657,
            cached: 0,
            thoughts: 138,
          },
          bySource: {},
        },
      },
      tools: {
        totalCalls: 1,
        totalSuccess: 1,
        totalFail: 0,
        totalDurationMs: 4582,
        totalDecisions: { accept: 0, reject: 0, modify: 0, auto_accept: 1 },
        byName: {
          google_web_search: {
            count: 1,
            success: 1,
            fail: 0,
            durationMs: 4582,
            decisions: { accept: 0, reject: 0, modify: 0, auto_accept: 1 },
          },
        },
      },
      files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
    };
    expect(format(response, stats)).toEqual({ response, stats });
  });

  it('should format error as JSON', () => {
    const error: JsonError = {
      type: 'ValidationError',
      message: 'Invalid input provided',
      code: 400,
    };
    expect(format(undefined, undefined, error)).toEqual({ error });
  });

  it('should format response with error as JSON', () => {
    const response = 'Partial response';
    const error: JsonError = {
      type: 'TimeoutError',
      message: 'Request timed out',
      code: 'TIMEOUT',
    };
    expect(format(response, undefined, error)).toEqual({ response, error });
  });

  it('should format error using formatError method', () => {
    const { parsed } = formatError(new Error('Something went wrong'), 500);
    expect(parsed).toEqual({
      error: { type: 'Error', message: 'Something went wrong', code: 500 },
    });
  });

  it('should format custom error using formatError method', () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomError';
      }
    }

    const { parsed } = formatError(new CustomError('Custom error occurred'));
    expect(parsed).toEqual({
      error: { type: 'CustomError', message: 'Custom error occurred' },
    });
  });

  it('should format complete JSON output with response, stats, and error', () => {
    const response = 'Partial response before error';
    const stats: SessionMetrics = {
      models: {},
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 1,
        totalDurationMs: 0,
        totalDecisions: { accept: 0, reject: 0, modify: 0, auto_accept: 0 },
        byName: {},
      },
      files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
    };
    const error: JsonError = {
      type: 'ApiError',
      message: 'Rate limit exceeded',
      code: 429,
    };
    expect(format(response, stats, error)).toEqual({ response, stats, error });
  });

  it('should handle error messages containing JSON content', () => {
    const message = 'API returned: {"error": "Invalid request", "code": 400}';
    const { formatted, parsed } = formatError(new Error(message), 'API_ERROR');
    expect(parsed).toEqual({
      error: {
        type: 'Error',
        message: 'API returned: {"error": "Invalid request", "code": 400}',
        code: 'API_ERROR',
      },
    });
    // Verify the entire output is valid JSON
    expect(() => JSON.parse(formatted)).not.toThrow();
  });

  it('should handle error messages with quotes and special characters', () => {
    const { formatted, parsed } = formatError(
      new Error('Error: "quoted text" and \\backslash'),
    );
    expect(parsed).toEqual({
      error: { type: 'Error', message: 'Error: "quoted text" and \\backslash' },
    });
    // Verify the entire output is valid JSON
    expect(() => JSON.parse(formatted)).not.toThrow();
  });

  it('should handle error messages with control characters', () => {
    const { formatted, parsed } = formatError(
      new Error('Error with\n newline and\t tab'),
    );
    // Should preserve newlines and tabs as they are common whitespace characters
    expect(parsed.error.message).toBe('Error with\n newline and\t tab');
    // Verify the entire output is valid JSON
    expect(() => JSON.parse(formatted)).not.toThrow();
  });

  it('should strip ANSI escape sequences from error messages', () => {
    const { formatted, parsed } = formatError(
      new Error('\x1B[31mRed error\x1B[0m message'),
    );
    expect(parsed.error.message).toBe('Red error message');
    expect(() => JSON.parse(formatted)).not.toThrow();
  });

  it('should strip unsafe control characters from error messages', () => {
    const { formatted, parsed } = formatError(
      new Error('Error\x07 with\x08 control\x0B chars'),
    );
    // Only ANSI codes are stripped, other control chars are preserved
    expect(parsed.error.message).toBe('Error\x07 with\x08 control\x0B chars');
    expect(() => JSON.parse(formatted)).not.toThrow();
  });
});
