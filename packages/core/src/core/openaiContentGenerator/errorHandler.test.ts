/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GenerateContentParameters } from '@google/genai';
import { EnhancedErrorHandler } from './errorHandler.js';
import type { RequestContext } from './types.js';

const debugLoggerSpy = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock('../../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    error: debugLoggerSpy.error,
  }),
}));

describe('EnhancedErrorHandler', () => {
  const fixedNow = 10_000;
  let errorHandler: EnhancedErrorHandler;
  let mockContext: RequestContext;
  let mockRequest: GenerateContentParameters;

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

      expect(() => {
        errorHandler.handle(originalError, mockContext, mockRequest);
      }).toThrow(originalError);
    });

    it('logs structured API diagnostics without request contents', () => {
      const apiError = Object.assign(
        new Error(
          'event:error\n:HTTP_STATUS/429\ndata:{"request_id":"req-123","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}',
        ),
        { type: 'rate_limit_error' },
      );

      expect(() => {
        errorHandler.handle(apiError, mockContext, mockRequest);
      }).toThrow(apiError);

      expect(debugLoggerSpy.error).toHaveBeenCalledWith(
        'OpenAI API Error:',
        expect.any(String),
        {
          durationMs: 5000,
          errorType: 'rate_limit_error',
          model: 'test-model',
          providerCode: 'Throttling.AllocationQuota',
          providerMessage: 'Allocated quota exceeded',
          requestId: 'req-123',
          statusCode: 429,
          transport: 'sse',
        },
      );
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

      expect(() => {
        errorHandler.handle(apiError, mockContext, mockRequest);
      }).toThrow(apiError);

      expect(debugLoggerSpy.error).toHaveBeenCalledWith(
        'OpenAI API Error:',
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

      expect(() => {
        errorHandler.handle(apiError, mockContext, mockRequest);
      }).toThrow(apiError);

      expect(debugLoggerSpy.error).toHaveBeenCalledWith(
        'OpenAI API Error:',
        expect.any(String),
        expect.objectContaining({
          requestId: 'resp-id',
        }),
      );
    });

    it('throws the original error when provider details have a null error object', () => {
      const apiError = { error: null, message: 'API failure' };
      let thrown: unknown;

      try {
        errorHandler.handle(apiError, mockContext, mockRequest);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(apiError);
    });

    it('should throw enhanced error message for timeout errors', () => {
      const timeoutError = new Error('Request timeout');

      expect(() => {
        errorHandler.handle(timeoutError, mockContext, mockRequest);
      }).toThrow(/Request timeout after 5s.*Troubleshooting tips:/s);
    });

    it('should use custom suppression function', () => {
      const suppressLogging = vi.fn(() => true);
      errorHandler = new EnhancedErrorHandler(suppressLogging);
      const originalError = new Error('Test error');

      expect(() => {
        errorHandler.handle(originalError, mockContext, mockRequest);
      }).toThrow();

      expect(suppressLogging).toHaveBeenCalledWith(originalError, mockRequest);
    });

    it('should handle string errors', () => {
      const stringError = 'String error message';

      expect(() => {
        errorHandler.handle(stringError, mockContext, mockRequest);
      }).toThrow(stringError);
    });

    it('should redact proxy credentials before throwing request-time errors', () => {
      const proxyError = new Error(
        'connect ECONNREFUSED token@proxy.local:8080',
      );

      expect(() => {
        errorHandler.handle(proxyError, mockContext, mockRequest);
      }).toThrow('connect ECONNREFUSED <redacted>@proxy.local:8080');
      expect(proxyError.message).not.toContain('token@');
    });

    it('should redact proxy credentials from string errors', () => {
      expect(() => {
        errorHandler.handle(
          '407 via http://user:pass@proxy.local',
          mockContext,
          mockRequest,
        );
      }).toThrow('407 via http://<redacted>@proxy.local');
    });

    it('should handle null/undefined errors', () => {
      expect(() => {
        errorHandler.handle(null, mockContext, mockRequest);
      }).toThrow();

      expect(() => {
        errorHandler.handle(undefined, mockContext, mockRequest);
      }).toThrow();
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

    const timeoutErrorCases = [
      { name: 'timeout in message', error: new Error('Connection timeout') },
      { name: 'timed out in message', error: new Error('Request timed out') },
      {
        name: 'connection timeout',
        error: new Error('connection timeout occurred'),
      },
      { name: 'request timeout', error: new Error('request timeout error') },
      { name: 'read timeout', error: new Error('read timeout happened') },
      { name: 'etimedout', error: new Error('ETIMEDOUT error') },
      { name: 'esockettimedout', error: new Error('ESOCKETTIMEDOUT error') },
      { name: 'deadline exceeded', error: new Error('deadline exceeded') },
      {
        name: 'ETIMEDOUT code',
        error: Object.assign(new Error('Network error'), { code: 'ETIMEDOUT' }),
      },
      {
        name: 'ESOCKETTIMEDOUT code',
        error: Object.assign(new Error('Socket error'), {
          code: 'ESOCKETTIMEDOUT',
        }),
      },
      {
        name: 'timeout type',
        error: Object.assign(new Error('Error'), { type: 'timeout' }),
      },
    ];

    timeoutErrorCases.forEach(({ name, error }) => {
      it(`should detect timeout error: ${name}`, () => {
        expect(() => {
          errorHandler.handle(error, mockContext, mockRequest);
        }).toThrow(/timeout.*Troubleshooting tips:/s);
      });
    });

    it('should not detect non-timeout errors as timeout', () => {
      const regularError = new Error('Regular API error');

      expect(() => {
        errorHandler.handle(regularError, mockContext, mockRequest);
      }).toThrow(regularError);

      expect(() => {
        errorHandler.handle(regularError, mockContext, mockRequest);
      }).not.toThrow(/Troubleshooting tips:/);
    });

    it('should handle case-insensitive timeout detection', () => {
      const uppercaseTimeoutError = new Error('REQUEST TIMEOUT');

      expect(() => {
        errorHandler.handle(uppercaseTimeoutError, mockContext, mockRequest);
      }).toThrow(/timeout.*Troubleshooting tips:/s);
    });
  });

  describe('error message building', () => {
    beforeEach(() => {
      errorHandler = new EnhancedErrorHandler();
    });

    it('should build timeout error message', () => {
      const timeoutError = new Error('timeout');

      expect(() => {
        errorHandler.handle(timeoutError, mockContext, mockRequest);
      }).toThrow(
        /Request timeout after 5s\. Try reducing input length or increasing timeout in config\./,
      );
    });

    it('should use original error message for non-timeout errors', () => {
      const originalError = new Error('Original error message');

      expect(() => {
        errorHandler.handle(originalError, mockContext, mockRequest);
      }).toThrow('Original error message');
    });

    it('should handle non-Error objects', () => {
      const objectError = { message: 'Object error', code: 500 };

      expect(() => {
        errorHandler.handle(objectError, mockContext, mockRequest);
      }).toThrow(); // Non-timeout errors are thrown as-is
    });

    it('should convert non-Error objects to strings for timeout errors', () => {
      // Create an object that will be detected as timeout error
      const objectTimeoutError = {
        toString: () => 'Connection timeout error',
        message: 'timeout occurred',
        code: 500,
      };

      expect(() => {
        errorHandler.handle(objectTimeoutError, mockContext, mockRequest);
      }).toThrow(/Request timeout after 5s.*Troubleshooting tips:/s);
    });

    it('should handle different duration values correctly', () => {
      const contextWithDifferentDuration = {
        ...mockContext,
        startTime: fixedNow - 12345,
      };
      const timeoutError = new Error('timeout');

      expect(() => {
        errorHandler.handle(
          timeoutError,
          contextWithDifferentDuration,
          mockRequest,
        );
      }).toThrow(/Request timeout after 12s\./);
    });
  });

  describe('troubleshooting tips generation', () => {
    beforeEach(() => {
      errorHandler = new EnhancedErrorHandler();
    });

    it('should provide generic troubleshooting tips', () => {
      const timeoutError = new Error('timeout');

      expect(() => {
        errorHandler.handle(timeoutError, mockContext, mockRequest);
      }).toThrow(
        /Troubleshooting tips:\n- Reduce input length or complexity\n- Increase timeout in config: contentGenerator\.timeout\n- Check network connectivity/,
      );
    });
  });

  describe('ErrorHandler interface compliance', () => {
    it('should implement ErrorHandler interface correctly', () => {
      errorHandler = new EnhancedErrorHandler();

      // Check that the class implements the interface methods
      expect(typeof errorHandler.handle).toBe('function');
      expect(typeof errorHandler.shouldSuppressErrorLogging).toBe('function');

      // Check method signatures by calling them
      expect(() => {
        errorHandler.handle(new Error('test'), mockContext, mockRequest);
      }).toThrow();

      expect(
        errorHandler.shouldSuppressErrorLogging(new Error('test'), mockRequest),
      ).toBe(false);
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      errorHandler = new EnhancedErrorHandler();
    });

    it('should handle zero duration', () => {
      const zeroContext = { ...mockContext, startTime: fixedNow };
      const timeoutError = new Error('timeout');

      expect(() => {
        errorHandler.handle(timeoutError, zeroContext, mockRequest);
      }).toThrow(/Request timeout after 0s\./);
    });

    it('should handle negative duration', () => {
      const negativeContext = { ...mockContext, startTime: fixedNow + 1000 };
      const timeoutError = new Error('timeout');

      expect(() => {
        errorHandler.handle(timeoutError, negativeContext, mockRequest);
      }).toThrow(/Request timeout after -1s\./);
    });

    it('should handle very large duration', () => {
      const largeContext = { ...mockContext, startTime: fixedNow - 999999 };
      const timeoutError = new Error('timeout');

      expect(() => {
        errorHandler.handle(timeoutError, largeContext, mockRequest);
      }).toThrow(/Request timeout after 1000s\./);
    });

    it('should handle empty error message', () => {
      const emptyError = new Error('');

      expect(() => {
        errorHandler.handle(emptyError, mockContext, mockRequest);
      }).toThrow(emptyError);
    });

    it('should handle error with only whitespace message', () => {
      const whitespaceError = new Error('   \n\t   ');

      expect(() => {
        errorHandler.handle(whitespaceError, mockContext, mockRequest);
      }).toThrow(whitespaceError);
    });
  });
});
