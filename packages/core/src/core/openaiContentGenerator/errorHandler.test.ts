/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GenerateContentParameters } from '@google/genai';
import { EnhancedErrorHandler } from './errorHandler.js';
import type { RequestContext } from './errorHandler.js';

describe('EnhancedErrorHandler', () => {
  let errorHandler: EnhancedErrorHandler;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;
  let mockContext: RequestContext;
  let mockRequest: GenerateContentParameters;

  beforeEach(() => {
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockContext = {
      userPromptId: 'test-prompt-id',
      model: 'test-model',
      authType: 'test-auth',
      startTime: Date.now() - 5000,
      duration: 5000,
      isStreaming: false,
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

    it('should log error message for non-timeout errors', () => {
      const originalError = new Error('Test error');

      expect(() => {
        errorHandler.handle(originalError, mockContext, mockRequest);
      }).toThrow();

      expect(mockConsoleError).toHaveBeenCalledWith(
        'OpenAI API Error:',
        'Test error',
      );
    });

    it('should log streaming error message for streaming requests', () => {
      const streamingContext = { ...mockContext, isStreaming: true };
      const originalError = new Error('Test streaming error');

      expect(() => {
        errorHandler.handle(originalError, streamingContext, mockRequest);
      }).toThrow();

      expect(mockConsoleError).toHaveBeenCalledWith(
        'OpenAI API Streaming Error:',
        'Test streaming error',
      );
    });

    it('should throw enhanced error message for timeout errors', () => {
      const timeoutError = new Error('Request timeout');

      expect(() => {
        errorHandler.handle(timeoutError, mockContext, mockRequest);
      }).toThrow(/Request timeout after 5s.*Troubleshooting tips:/s);
    });

    it('should not log error when suppression is enabled', () => {
      const suppressLogging = vi.fn(() => true);
      errorHandler = new EnhancedErrorHandler(suppressLogging);
      const originalError = new Error('Test error');

      expect(() => {
        errorHandler.handle(originalError, mockContext, mockRequest);
      }).toThrow();

      expect(mockConsoleError).not.toHaveBeenCalled();
      expect(suppressLogging).toHaveBeenCalledWith(originalError, mockRequest);
    });

    it('should handle string errors', () => {
      const stringError = 'String error message';

      expect(() => {
        errorHandler.handle(stringError, mockContext, mockRequest);
      }).toThrow(stringError);

      expect(mockConsoleError).toHaveBeenCalledWith(
        'OpenAI API Error:',
        'String error message',
      );
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

    it('should build timeout error message for non-streaming requests', () => {
      const timeoutError = new Error('timeout');

      expect(() => {
        errorHandler.handle(timeoutError, mockContext, mockRequest);
      }).toThrow(
        /Request timeout after 5s\. Try reducing input length or increasing timeout in config\./,
      );
    });

    it('should build timeout error message for streaming requests', () => {
      const streamingContext = { ...mockContext, isStreaming: true };
      const timeoutError = new Error('timeout');

      expect(() => {
        errorHandler.handle(timeoutError, streamingContext, mockRequest);
      }).toThrow(
        /Streaming request timeout after 5s\. Try reducing input length or increasing timeout in config\./,
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
      const contextWithDifferentDuration = { ...mockContext, duration: 12345 };
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

    it('should provide general troubleshooting tips for non-streaming requests', () => {
      const timeoutError = new Error('timeout');

      expect(() => {
        errorHandler.handle(timeoutError, mockContext, mockRequest);
      }).toThrow(
        /Troubleshooting tips:\n- Reduce input length or complexity\n- Increase timeout in config: contentGenerator\.timeout\n- Check network connectivity\n- Consider using streaming mode for long responses/,
      );
    });

    it('should provide streaming-specific troubleshooting tips for streaming requests', () => {
      const streamingContext = { ...mockContext, isStreaming: true };
      const timeoutError = new Error('timeout');

      expect(() => {
        errorHandler.handle(timeoutError, streamingContext, mockRequest);
      }).toThrow(
        /Streaming timeout troubleshooting:\n- Reduce input length or complexity\n- Increase timeout in config: contentGenerator\.timeout\n- Check network connectivity\n- Check network stability for streaming connections\n- Consider using non-streaming mode for very long inputs/,
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
      const zeroContext = { ...mockContext, duration: 0 };
      const timeoutError = new Error('timeout');

      expect(() => {
        errorHandler.handle(timeoutError, zeroContext, mockRequest);
      }).toThrow(/Request timeout after 0s\./);
    });

    it('should handle negative duration', () => {
      const negativeContext = { ...mockContext, duration: -1000 };
      const timeoutError = new Error('timeout');

      expect(() => {
        errorHandler.handle(timeoutError, negativeContext, mockRequest);
      }).toThrow(/Request timeout after -1s\./);
    });

    it('should handle very large duration', () => {
      const largeContext = { ...mockContext, duration: 999999 };
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

      expect(mockConsoleError).toHaveBeenCalledWith('OpenAI API Error:', '');
    });

    it('should handle error with only whitespace message', () => {
      const whitespaceError = new Error('   \n\t   ');

      expect(() => {
        errorHandler.handle(whitespaceError, mockContext, mockRequest);
      }).toThrow(whitespaceError);
    });
  });
});
