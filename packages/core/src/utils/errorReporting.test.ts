/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reportError } from './errorReporting.js';

const debugLoggerSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

// Mock the debugLogger
vi.mock('./debugLogger.js', () => ({
  createDebugLogger: () => ({
    error: debugLoggerSpy.error,
    warn: debugLoggerSpy.warn,
    info: debugLoggerSpy.info,
    debug: debugLoggerSpy.debug,
  }),
}));

describe('reportError', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should not throw when called with a standard error', async () => {
    const error = new Error('Test error');
    error.stack = 'Test stack';
    const baseMessage = 'An error occurred.';
    const context = { data: 'test context' };
    const type = 'test-type';

    await expect(
      reportError(error, baseMessage, context, type),
    ).resolves.not.toThrow();
    expect(debugLoggerSpy.error).toHaveBeenCalled();
    expect(debugLoggerSpy.error).toHaveBeenCalledWith(
      `${baseMessage} [${type}]`,
      expect.any(String),
    );
  });

  it('summarizes context instead of logging raw prompt contents', async () => {
    const error = new Error('API failed');
    const baseMessage = 'Error generating text content via API.';
    const context = [
      {
        role: 'user',
        parts: [{ text: 'secret prompt that should not be in debug logs' }],
      },
    ];

    await reportError(error, baseMessage, context, 'generateText-api');

    const report = String(debugLoggerSpy.error.mock.calls[0]?.[1]);
    expect(report).not.toContain('secret prompt');
    expect(report).not.toContain('"context"');
    expect(report).toContain('"contextSummary"');
    expect(report).toContain('"kind": "array"');
    expect(report).toContain('"itemCount": 1');
  });

  it('summarizes object context without logging raw request contents', async () => {
    const error = new Error('API failed');
    const baseMessage = 'Error generating text content via API.';
    const context = {
      requestContents: [
        {
          role: 'user',
          parts: [{ text: 'secret object prompt' }],
        },
      ],
      requestConfig: { apiKey: 'secret-api-key' },
    };

    await reportError(error, baseMessage, context, 'generateText-api');

    const report = String(debugLoggerSpy.error.mock.calls[0]?.[1]);
    expect(report).not.toContain('secret object prompt');
    expect(report).not.toContain('secret-api-key');
    expect(report).not.toContain('"context"');
    expect(report).toContain('"contextSummary"');
    expect(report).toContain('"kind": "object"');
    expect(report).toContain('"requestContents"');
    expect(report).toContain('"requestConfig"');
  });

  it('preserves explicitly summarized context', async () => {
    const error = new Error('API failed');
    const context = {
      history: { rawLength: 12, tail: [] },
      request: { partCount: 1, textPreview: 'safe preview' },
    };

    await reportError(error, 'Error when talking to API', context, 'turn', {
      contextAlreadySummarized: true,
    });

    const report = String(debugLoggerSpy.error.mock.calls[0]?.[1]);
    expect(report).toContain('"rawLength": 12');
    expect(report).toContain('"textPreview": "safe preview"');
    expect(report).not.toContain('"keys"');
  });

  it('should handle errors that are plain objects with a message property', async () => {
    const error = { message: 'Test plain object error' };
    const baseMessage = 'Another error.';
    const type = 'general';

    await expect(
      reportError(error, baseMessage, undefined, type),
    ).resolves.not.toThrow();
    expect(debugLoggerSpy.error).toHaveBeenCalledWith(
      `${baseMessage} [${type}]`,
      expect.any(String),
    );
  });

  it('should handle string errors', async () => {
    const error = 'Just a string error';
    const baseMessage = 'String error occurred.';
    const type = 'general';

    await expect(
      reportError(error, baseMessage, undefined, type),
    ).resolves.not.toThrow();
    expect(debugLoggerSpy.error).toHaveBeenCalledWith(
      `${baseMessage} [${type}]`,
      expect.any(String),
    );
  });

  it('should not stringify raw context when context contains unsupported values', async () => {
    const error = new Error('Main error');
    error.stack = 'Main stack';
    const baseMessage = 'Failed operation with BigInt.';
    const context = { a: BigInt(1) }; // BigInt cannot be stringified by JSON.stringify

    await expect(
      reportError(error, baseMessage, context, 'bigint-fail'),
    ).resolves.not.toThrow();
    expect(debugLoggerSpy.error).toHaveBeenCalledWith(
      `${baseMessage} [bigint-fail]`,
      expect.stringContaining('"contextSummary"'),
    );
  });

  it('should generate a report without context if context is not provided', async () => {
    const error = new Error('Error without context');
    error.stack = 'No context stack';
    const baseMessage = 'Simple error.';
    const type = 'general';

    await expect(
      reportError(error, baseMessage, undefined, type),
    ).resolves.not.toThrow();
    expect(debugLoggerSpy.error).toHaveBeenCalledWith(
      `${baseMessage} [${type}]`,
      expect.any(String),
    );
  });
});
