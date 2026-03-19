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

  it('should handle stringification failure of report content (e.g. BigInt in context)', async () => {
    const error = new Error('Main error');
    error.stack = 'Main stack';
    const baseMessage = 'Failed operation with BigInt.';
    const context = { a: BigInt(1) }; // BigInt cannot be stringified by JSON.stringify

    // Simulate JSON.stringify throwing an error for the full report
    const originalJsonStringify = JSON.stringify;
    let callCount = 0;
    vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      callCount++;
      if (callCount === 1) {
        // First call is for the full report content
        throw new TypeError('Do not know how to serialize a BigInt');
      }
      // Subsequent calls (for minimal report) should succeed
      return originalJsonStringify(value, replacer, space);
    });

    await expect(
      reportError(error, baseMessage, context, 'bigint-fail'),
    ).resolves.not.toThrow();
    expect(debugLoggerSpy.error).toHaveBeenCalledWith(
      `${baseMessage} [bigint-fail] Could not stringify report content (likely due to context):`,
      expect.any(TypeError),
      error,
    );
    expect(debugLoggerSpy.error).toHaveBeenCalledWith(
      `${baseMessage} [bigint-fail]`,
      expect.any(String),
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
