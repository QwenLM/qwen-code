/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GenerateContentParameters } from '@google/genai';
import { EnhancedErrorHandler } from './errorHandler.js';
import type { RequestContext } from './types.js';
import { classifyRetryError } from '../../utils/retryErrorClassification.js';
import { APIConnectionTimeoutError } from 'openai';

const debugLoggerSpy = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock('../../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    error: debugLoggerSpy.error,
  }),
}));

const TIMEOUT_WITH_TIPS = /Request timeout after 5s.*Troubleshooting tips:/s;

describe('EnhancedErrorHandler', () => {
  const fixedNow = 10_000;
  let errorHandler: EnhancedErrorHandler;
  let mockContext: RequestContext;
  let mockRequest: GenerateContentParameters;

  /** A thunk calling `handle` for `expect(...).toThrow`. */
  const handling =
    (error: unknown, context: RequestContext = mockContext) =>
    () =>
      errorHandler.handle(error, context, mockRequest);

  /** Calls `handle` and returns whatever it threw. */
  const thrownBy = (error: unknown): unknown => {
    try {
      errorHandler.handle(error, mockContext, mockRequest);
    } catch (thrown) {
      return thrown;
    }
  };

  const expectLogged = (message: unknown, details: unknown) =>
    expect(debugLoggerSpy.error).toHaveBeenCalledWith(
      'OpenAI API Error:',
      message,
      details,
    );

  beforeEach(() => {
    debugLoggerSpy.error.mockReset();
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    mockContext = {
      model: 'test-model',
      modalities: {},
      startTime: fixedNow - 5000,
    };

    mockRequest = {
      model: 'test-model',
      contents: [{ parts: [{ text: 'test prompt' }] }],
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create instance with default shouldSuppressLogging function', () => {
      errorHandler = new EnhancedErrorHandler();
      expect(errorHandler).toBeInstanceOf(EnhancedErrorHandler);
    });

    it('should create instance with custom shouldSuppressLogging function', () => {
      const customSuppressLogging = vi.fn(() => true);
      errorHandler = new EnhancedErrorHandler(customSuppressLogging);
      expect(errorHandler).toBeInstanceOf(EnhancedErrorHandler);
    });
  });

  describe('handle method', () => {
    beforeEach(() => {
      errorHandler = new EnhancedErrorHandler();
    });

    it('should throw the original error for non-timeout errors', () => {
      const originalError = new Error('Test error');
      expect(handling(originalError)).toThrow(originalError);
    });

    it('logs structured API diagnostics without request contents', () => {
      const apiError = Object.assign(
        new Error(
          'event:error\n:HTTP_STATUS/429\ndata:{"request_id":"req-123","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}',
        ),
        { type: 'rate_limit_error' },
      );

      expect(handling(apiError)).toThrow(apiError);
      expectLogged(expect.any(String), {
        durationMs: 5000,
        errorType: 'rate_limit_error',
        model: 'test-model',
        providerCode: 'Throttling.AllocationQuota',
        providerMessage: 'Allocated quota exceeded',
        requestId: 'req-123',
        statusCode: 429,
        transport: 'sse',
      });
      expect(JSON.stringify(debugLoggerSpy.error.mock.calls[0])).not.toContain(
        'test prompt',
      );
    });

    it('prefers top-level request ids before parsed provider details', () => {
      const apiError = Object.assign(new Error('API failure'), {
        requestID: 'req-top-level',
        request_id: 'req-snake-case',
        response_id: 'resp-id',
        status: 500,
      });

      expect(handling(apiError)).toThrow(apiError);
      expectLogged(
        expect.any(String),
        expect.objectContaining({
          requestId: 'req-top-level',
          statusCode: 500,
        }),
      );
    });

    it('skips empty request ids and falls back to later request id fields', () => {
      const apiError = Object.assign(new Error('API failure'), {
        requestID: '',
        request_id: '',
        response_id: 'resp-id',
      });

      expect(handling(apiError)).toThrow(apiError);
      expectLogged(
        expect.any(String),
        expect.objectContaining({ requestId: 'resp-id' }),
      );
    });

    it('throws the original error when provider details have a null error object', () => {
      const apiError = { error: null, message: 'API failure' };
      expect(thrownBy(apiError)).toBe(apiError);
    });

    it('should throw enhanced error message for timeout errors', () => {
      expect(handling(new Error('Request timeout'))).toThrow(TIMEOUT_WITH_TIPS);
    });

    it('preserves transport metadata when enhancing timeout errors', () => {
      const timeoutError = Object.assign(
        new Error('socket timed out via token@proxy.local:8080'),
        { code: 'ETIMEDOUT' },
      );
      const thrown = thrownBy(timeoutError);

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(TIMEOUT_WITH_TIPS);
      expect((thrown as Error).cause).toBe(timeoutError);
      expect((thrown as Error).cause).toMatchObject({
        code: 'ETIMEDOUT',
        message: 'socket timed out via <redacted>@proxy.local:8080',
      });
      expect(classifyRetryError(thrown)).toMatchObject({
        kind: 'transport',
        diagnosis: 'retryable',
        transportCode: 'ETIMEDOUT',
      });
    });

    it('keeps an HTTP client status authoritative on enhanced timeouts', () => {
      const timeoutError = Object.assign(new Error('socket timed out'), {
        code: 'ETIMEDOUT',
        status: 400,
      });

      expect(classifyRetryError(thrownBy(timeoutError))).toMatchObject({
        kind: 'http',
        diagnosis: 'fail-fast',
        reason: 'client-error',
        statusCode: 400,
      });
    });

    it('marks the SDK bare connection timeout as retryable transport', () => {
      // The OpenAI SDK throws APIConnectionTimeoutError bare — no code,
      // status, or cause — once its internal retries are exhausted.
      const bareTimeout = new APIConnectionTimeoutError();
      const thrown = thrownBy(bareTimeout);

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(TIMEOUT_WITH_TIPS);
      expect((thrown as Error).cause).toBe(bareTimeout);
      expect(classifyRetryError(thrown)).toMatchObject({
        kind: 'transport',
        diagnosis: 'retryable',
        transportCode: 'ETIMEDOUT',
      });
    });

    it('attaches the redacted clone, not the raw original, when redaction clones', () => {
      const original = Object.freeze(
        Object.assign(
          new Error('socket timed out via token@proxy.local:8080'),
          { code: 'ETIMEDOUT' },
        ),
      );
      const thrown = thrownBy(original);

      expect((thrown as Error).cause).not.toBe(original);
      expect(((thrown as Error).cause as Error).message).toContain(
        '<redacted>@proxy.local:8080',
      );
    });

    it('should use custom suppression function', () => {
      const suppressLogging = vi.fn(() => true);
      errorHandler = new EnhancedErrorHandler(suppressLogging);
      const originalError = new Error('Test error');

      expect(handling(originalError)).toThrow();
      expect(suppressLogging).toHaveBeenCalledWith(originalError, mockRequest);
    });

    it('should handle string errors', () => {
      const stringError = 'String error message';

      expect(handling(stringError)).toThrow(stringError);
      expectLogged(
        stringError,
        expect.objectContaining({ model: 'test-model' }),
      );
    });

    it('should redact proxy credentials before throwing request-time errors', () => {
      const proxyError = new Error(
        'connect ECONNREFUSED token@proxy.local:8080',
      );

      expect(handling(proxyError)).toThrow(
        'connect ECONNREFUSED <redacted>@proxy.local:8080',
      );
      expect(proxyError.message).not.toContain('token@');
    });

    it('should redact proxy credentials from string errors', () => {
      expect(handling('407 via http://user:pass@proxy.local')).toThrow(
        '407 via http://<redacted>@proxy.local',
      );
    });

    it('should handle null/undefined errors', () => {
      expect(handling(null)).toThrow();
      expect(handling(undefined)).toThrow();
    });
  });

  describe('shouldSuppressErrorLogging method', () => {
    it('should return false by default', () => {
      errorHandler = new EnhancedErrorHandler();
      const result = errorHandler.shouldSuppressErrorLogging(
        new Error('test'),
        mockRequest,
      );
      expect(result).toBe(false);
    });

    it('should use custom suppression function', () => {
      const customSuppressLogging = vi.fn(() => true);
      errorHandler = new EnhancedErrorHandler(customSuppressLogging);

      const testError = new Error('test');
      const result = errorHandler.shouldSuppressErrorLogging(
        testError,
        mockRequest,
      );

      expect(result).toBe(true);
      expect(customSuppressLogging).toHaveBeenCalledWith(
        testError,
        mockRequest,
      );
    });
  });

  describe('timeout error detection', () => {
    beforeEach(() => {
      errorHandler = new EnhancedErrorHandler();
    });

    it.each<[string, Error]>([
      ['timeout in message', new Error('Connection timeout')],
      ['timed out in message', new Error('Request timed out')],
      ['connection timeout', new Error('connection timeout occurred')],
      ['request timeout', new Error('request timeout error')],
      ['read timeout', new Error('read timeout happened')],
      ['etimedout', new Error('ETIMEDOUT error')],
      ['esockettimedout', new Error('ESOCKETTIMEDOUT error')],
      ['deadline exceeded', new Error('deadline exceeded')],
      [
        'ETIMEDOUT code',
        Object.assign(new Error('Network error'), { code: 'ETIMEDOUT' }),
      ],
      [
        'ESOCKETTIMEDOUT code',
        Object.assign(new Error('Socket error'), { code: 'ESOCKETTIMEDOUT' }),
      ],
      ['timeout type', Object.assign(new Error('Error'), { type: 'timeout' })],
    ])('should detect timeout error: %s', (_name, error) => {
      expect(handling(error)).toThrow(/timeout.*Troubleshooting tips:/s);
    });

    it('should not detect non-timeout errors as timeout', () => {
      const regularError = new Error('Regular API error');

      expect(handling(regularError)).toThrow(regularError);
      expect(handling(regularError)).not.toThrow(/Troubleshooting tips:/);
    });

    it('should handle case-insensitive timeout detection', () => {
      expect(handling(new Error('REQUEST TIMEOUT'))).toThrow(
        /timeout.*Troubleshooting tips:/s,
      );
    });
  });

  describe('error message building', () => {
    beforeEach(() => {
      errorHandler = new EnhancedErrorHandler();
    });

    it('should build timeout error message', () => {
      expect(handling(new Error('timeout'))).toThrow(
        /Request timeout after 5s\. Try reducing input length or increasing timeout in config\./,
      );
    });

    it('should use original error message for non-timeout errors', () => {
      const originalError = new Error('Original error message');

      expect(handling(originalError)).toThrow('Original error message');
      expectLogged(
        'Original error message',
        expect.objectContaining({ model: 'test-model' }),
      );
    });

    it('should include the underlying cause for non-timeout errors', () => {
      const cause = Object.assign(new Error('fetch failed'), {
        code: 'ECONNREFUSED',
      });
      const connectionError = new Error('Connection error.', { cause });

      expect(handling(connectionError)).toThrow(connectionError);
      expectLogged(
        'Connection error. (cause: ECONNREFUSED: fetch failed)',
        expect.objectContaining({ model: 'test-model' }),
      );
    });

    it('should handle non-Error objects', () => {
      const objectError = { message: 'Object error', code: 500 };
      // Non-timeout errors are thrown as-is
      expect(handling(objectError)).toThrow();
    });

    it('should convert non-Error objects to strings for timeout errors', () => {
      // An object that is detected as a timeout error
      const objectTimeoutError = {
        toString: () => 'Connection timeout error',
        message: 'timeout occurred',
        code: 500,
      };

      expect(handling(objectTimeoutError)).toThrow(TIMEOUT_WITH_TIPS);
    });

    it('should handle different duration values correctly', () => {
      const context = { ...mockContext, startTime: fixedNow - 12345 };
      expect(handling(new Error('timeout'), context)).toThrow(
        /Request timeout after 12s\./,
      );
    });
  });

  describe('troubleshooting tips generation', () => {
    beforeEach(() => {
      errorHandler = new EnhancedErrorHandler();
    });

    it('should provide generic troubleshooting tips', () => {
      expect(handling(new Error('timeout'))).toThrow(
        /Troubleshooting tips:\n- Reduce input length or complexity\n- Increase timeout in config: contentGenerator\.timeout\n- Check network connectivity/,
      );
    });
  });

  describe('ErrorHandler interface compliance', () => {
    it('should implement ErrorHandler interface correctly', () => {
      errorHandler = new EnhancedErrorHandler();

      expect(typeof errorHandler.handle).toBe('function');
      expect(typeof errorHandler.shouldSuppressErrorLogging).toBe('function');
      // Check method signatures by calling them
      expect(handling(new Error('test'))).toThrow();
      expect(
        errorHandler.shouldSuppressErrorLogging(new Error('test'), mockRequest),
      ).toBe(false);
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      errorHandler = new EnhancedErrorHandler();
    });

    it.each([
      ['should handle zero duration', fixedNow, /Request timeout after 0s\./],
      [
        'should handle negative duration',
        fixedNow + 1000,
        /Request timeout after -1s\./,
      ],
      [
        'should handle very large duration',
        fixedNow - 999999,
        /Request timeout after 1000s\./,
      ],
    ])('%s', (_title, startTime, message) => {
      const context = { ...mockContext, startTime };
      expect(handling(new Error('timeout'), context)).toThrow(message);
    });

    it('should handle empty error message', () => {
      const emptyError = new Error('');
      expect(handling(emptyError)).toThrow(emptyError);
    });

    it('should handle error with only whitespace message', () => {
      const whitespaceError = new Error('   \n\t   ');
      expect(handling(whitespaceError)).toThrow(whitespaceError);
    });
  });
});
