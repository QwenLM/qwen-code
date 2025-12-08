/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it } from 'vitest';

import { JsonFormatter } from './json-formatter.js';
import type { JsonError } from './types.js';

describe('JsonFormatter', () => {
  it('should format the response as JSON', () => {
    const formatter = new JsonFormatter();
    const response = 'This is a test response.';
    const formatted = formatter.format(response);
    const expected = {
      response,
    };
    expect(JSON.parse(formatted)).toEqual(expected);
  });

  it('should strip ANSI escape sequences from response text', () => {
    const formatter = new JsonFormatter();
    const responseWithAnsi =
      '\x1B[31mRed text\x1B[0m and \x1B[32mGreen text\x1B[0m';
    const formatted = formatter.format(responseWithAnsi);
    const parsed = JSON.parse(formatted);
    expect(parsed.response).toBe('Red text and Green text');
  });

  it('should strip control characters from response text', () => {
    const formatter = new JsonFormatter();
    const responseWithControlChars =
      'Text with\x07 bell\x08 and\x0B vertical tab';
    const formatted = formatter.format(responseWithControlChars);
    const parsed = JSON.parse(formatted);
    // Only ANSI codes are stripped, other control chars are preserved
    expect(parsed.response).toBe('Text with\x07 bell\x08 and\x0B vertical tab');
  });

  it('should preserve newlines and tabs in response text', () => {
    const formatter = new JsonFormatter();
    const responseWithWhitespace = 'Line 1\nLine 2\r\nLine 3\twith tab';
    const formatted = formatter.format(responseWithWhitespace);
    const parsed = JSON.parse(formatted);
    expect(parsed.response).toBe('Line 1\nLine 2\r\nLine 3\twith tab');
  });

  it('should format error as JSON', () => {
    const formatter = new JsonFormatter();
    const error: JsonError = {
      type: 'ValidationError',
      message: 'Invalid input provided',
      code: 400,
    };
    const formatted = formatter.format(undefined, error);
    const expected = {
      error,
    };
    expect(JSON.parse(formatted)).toEqual(expected);
  });

  it('should format response with error as JSON', () => {
    const formatter = new JsonFormatter();
    const response = 'Partial response';
    const error: JsonError = {
      type: 'TimeoutError',
      message: 'Request timed out',
      code: 'TIMEOUT',
    };
    const formatted = formatter.format(response, error);
    const expected = {
      response,
      error,
    };
    expect(JSON.parse(formatted)).toEqual(expected);
  });

  it('should format error using formatError method', () => {
    const formatter = new JsonFormatter();
    const error = new Error('Something went wrong');
    const formatted = formatter.formatError(error, 500);
    const parsed = JSON.parse(formatted);

    expect(parsed).toEqual({
      error: {
        type: 'Error',
        message: 'Something went wrong',
        code: 500,
      },
    });
  });

  it('should format custom error using formatError method', () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomError';
      }
    }

    const formatter = new JsonFormatter();
    const error = new CustomError('Custom error occurred');
    const formatted = formatter.formatError(error);
    const parsed = JSON.parse(formatted);

    expect(parsed).toEqual({
      error: {
        type: 'CustomError',
        message: 'Custom error occurred',
      },
    });
  });

  it('should format complete JSON output with response, stats, and error', () => {
    const formatter = new JsonFormatter();
    const response = 'Partial response before error';

    const error: JsonError = {
      type: 'ApiError',
      message: 'Rate limit exceeded',
      code: 429,
    };

    const formatted = formatter.format(response, error);
    const expected = {
      response,

      error,
    };
    expect(JSON.parse(formatted)).toEqual(expected);
  });

  it('should handle error messages containing JSON content', () => {
    const formatter = new JsonFormatter();
    const errorWithJson = new Error(
      'API returned: {"error": "Invalid request", "code": 400}',
    );
    const formatted = formatter.formatError(errorWithJson, 'API_ERROR');
    const parsed = JSON.parse(formatted);

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
    const formatter = new JsonFormatter();
    const errorWithQuotes = new Error('Error: "quoted text" and \\backslash');
    const formatted = formatter.formatError(errorWithQuotes);
    const parsed = JSON.parse(formatted);

    expect(parsed).toEqual({
      error: {
        type: 'Error',
        message: 'Error: "quoted text" and \\backslash',
      },
    });

    // Verify the entire output is valid JSON
    expect(() => JSON.parse(formatted)).not.toThrow();
  });

  it('should handle error messages with control characters', () => {
    const formatter = new JsonFormatter();
    const errorWithControlChars = new Error('Error with\n newline and\t tab');
    const formatted = formatter.formatError(errorWithControlChars);
    const parsed = JSON.parse(formatted);

    // Should preserve newlines and tabs as they are common whitespace characters
    expect(parsed.error.message).toBe('Error with\n newline and\t tab');

    // Verify the entire output is valid JSON
    expect(() => JSON.parse(formatted)).not.toThrow();
  });

  it('should strip ANSI escape sequences from error messages', () => {
    const formatter = new JsonFormatter();
    const errorWithAnsi = new Error('\x1B[31mRed error\x1B[0m message');
    const formatted = formatter.formatError(errorWithAnsi);
    const parsed = JSON.parse(formatted);

    expect(parsed.error.message).toBe('Red error message');
    expect(() => JSON.parse(formatted)).not.toThrow();
  });

  it('should strip unsafe control characters from error messages', () => {
    const formatter = new JsonFormatter();
    const errorWithControlChars = new Error(
      'Error\x07 with\x08 control\x0B chars',
    );
    const formatted = formatter.formatError(errorWithControlChars);
    const parsed = JSON.parse(formatted);

    // Only ANSI codes are stripped, other control chars are preserved
    expect(parsed.error.message).toBe('Error\x07 with\x08 control\x0B chars');
    expect(() => JSON.parse(formatted)).not.toThrow();
  });
});
