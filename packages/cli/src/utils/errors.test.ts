/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, type Mock, type MockInstance } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { OutputFormat, FatalInputError } from '@qwen-code/qwen-code-core';
import {
  getErrorMessage,
  handleError,
  handleToolError,
  handleCancellationError,
  handleMaxTurnsExceededError,
} from './errors.js';

// Mock the core modules
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();

  return {
    ...original,
    parseAndFormatApiError: vi.fn((error: unknown) => {
      if (error instanceof Error) {
        return `API Error: ${error.message}`;
      }
      return `API Error: ${String(error)}`;
    }),
    JsonFormatter: vi.fn().mockImplementation(() => ({
      formatError: vi.fn((error: Error, code?: string | number) =>
        JSON.stringify(
          {
            error: {
              type: error.constructor.name,
              message: error.message,
              ...(code && { code }),
            },
          },
          null,
          2,
        ),
      ),
    })),
    FatalToolExecutionError: class extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'FatalToolExecutionError';
        this.exitCode = 54;
      }
      exitCode: number;
    },
    FatalCancellationError: class extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'FatalCancellationError';
        this.exitCode = 130;
      }
      exitCode: number;
    },
  };
});

describe('errors', () => {
  let mockConfig: Config;
  let processExitSpy: MockInstance;
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Mock console.error
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock process.exit to throw instead of actually exiting
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit called with code: ${code}`);
    });

    // Create mock config
    mockConfig = {
      getOutputFormat: vi.fn().mockReturnValue(OutputFormat.TEXT),
      getContentGeneratorConfig: vi.fn().mockReturnValue({ authType: 'test' }),
      getDebugMode: vi.fn().mockReturnValue(true),
    } as unknown as Config;
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe('getErrorMessage', () => {
    it('should return error message for Error instances', () => {
      const error = new Error('Test error message');
      expect(getErrorMessage(error)).toBe('Test error message');
    });

    it('should convert non-Error values to strings', () => {
      expect(getErrorMessage('string error')).toBe('string error');
      expect(getErrorMessage(123)).toBe('123');
      expect(getErrorMessage(null)).toBe('null');
      expect(getErrorMessage(undefined)).toBe('undefined');
    });

    it('should handle objects', () => {
      const obj = { message: 'test' };
      expect(getErrorMessage(obj)).toBe('[object Object]');
    });
  });

  describe('handleError', () => {
    describe('in text mode', () => {
      beforeEach(() => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.TEXT);
      });

      it('should log error message and re-throw', () => {
        const testError = new Error('Test error');

        expect(() => {
          handleError(testError, mockConfig);
        }).toThrow(testError);

        expect(consoleErrorSpy).toHaveBeenCalledWith('API Error: Test error');
      });

      it('should handle non-Error objects', () => {
        const testError = 'String error';

        expect(() => {
          handleError(testError, mockConfig);
        }).toThrow(testError);

        expect(consoleErrorSpy).toHaveBeenCalledWith('API Error: String error');
      });
    });

    describe('in JSON mode', () => {
      beforeEach(() => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.JSON);
      });

      it('should format error as JSON and exit with default code', () => {
        const testError = new Error('Test error');

        expect(() => {
          handleError(testError, mockConfig);
        }).toThrow('process.exit called with code: 1');

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          JSON.stringify(
            {
              error: {
                type: 'Error',
                message: 'Test error',
                code: 1,
              },
            },
            null,
            2,
          ),
        );
      });

      it('should use custom error code when provided', () => {
        const testError = new Error('Test error');

        expect(() => {
          handleError(testError, mockConfig, 42);
        }).toThrow('process.exit called with code: 42');

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          JSON.stringify(
            {
              error: {
                type: 'Error',
                message: 'Test error',
                code: 42,
              },
            },
            null,
            2,
          ),
        );
      });

      it('should extract exitCode from FatalError instances', () => {
        const fatalError = new FatalInputError('Fatal error');

        expect(() => {
          handleError(fatalError, mockConfig);
        }).toThrow('process.exit called with code: 42');

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          JSON.stringify(
            {
              error: {
                type: 'FatalInputError',
                message: 'Fatal error',
                code: 42,
              },
            },
            null,
            2,
          ),
        );
      });

      it('should handle error with code property', () => {
        const errorWithCode = new Error('Error with code') as Error & {
          code: number;
        };
        errorWithCode.code = 404;

        expect(() => {
          handleError(errorWithCode, mockConfig);
        }).toThrow('process.exit called with code: 404');
      });

      it('should handle error with status property', () => {
        const errorWithStatus = new Error('Error with status') as Error & {
          status: string;
        };
        errorWithStatus.status = 'TIMEOUT';

        expect(() => {
          handleError(errorWithStatus, mockConfig);
        }).toThrow('process.exit called with code: 1'); // string codes become 1

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          JSON.stringify(
            {
              error: {
                type: 'Error',
                message: 'Error with status',
                code: 'TIMEOUT',
              },
            },
            null,
            2,
          ),
        );
      });
    });
  });

  describe('handleToolError', () => {
    const toolName = 'test-tool';
    const toolError = new Error('Tool failed');

    describe('when debug mode is enabled', () => {
      beforeEach(() => {
        (mockConfig.getDebugMode as Mock).mockReturnValue(true);
      });

      describe('in text mode', () => {
        beforeEach(() => {
          (
            mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
          ).mockReturnValue(OutputFormat.TEXT);
        });

        it('should log error message to stderr and not exit', () => {
          handleToolError(toolName, toolError, mockConfig);

          expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Error executing tool test-tool: Tool failed',
          );
          expect(processExitSpy).not.toHaveBeenCalled();
        });

        it('should use resultDisplay when provided and not exit', () => {
          handleToolError(
            toolName,
            toolError,
            mockConfig,
            'CUSTOM_ERROR',
            'Custom display message',
          );

          expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Error executing tool test-tool: Custom display message',
          );
          expect(processExitSpy).not.toHaveBeenCalled();
        });
      });

      describe('in JSON mode', () => {
        beforeEach(() => {
          (
            mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
          ).mockReturnValue(OutputFormat.JSON);
        });

        it('should log error message to stderr and not exit', () => {
          handleToolError(toolName, toolError, mockConfig);

          // In JSON mode, should not exit (just log to stderr when debug mode is on)
          expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Error executing tool test-tool: Tool failed',
          );
          expect(processExitSpy).not.toHaveBeenCalled();
        });

        it('should log error with custom error code and not exit', () => {
          handleToolError(toolName, toolError, mockConfig, 'CUSTOM_TOOL_ERROR');

          // In JSON mode, should not exit (just log to stderr when debug mode is on)
          expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Error executing tool test-tool: Tool failed',
          );
          expect(processExitSpy).not.toHaveBeenCalled();
        });

        it('should log error with numeric error code and not exit', () => {
          handleToolError(toolName, toolError, mockConfig, 500);

          // In JSON mode, should not exit (just log to stderr when debug mode is on)
          expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Error executing tool test-tool: Tool failed',
          );
          expect(processExitSpy).not.toHaveBeenCalled();
        });

        it('should prefer resultDisplay over error message and not exit', () => {
          handleToolError(
            toolName,
            toolError,
            mockConfig,
            'DISPLAY_ERROR',
            'Display message',
          );

          // In JSON mode, should not exit (just log to stderr when debug mode is on)
          expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Error executing tool test-tool: Display message',
          );
          expect(processExitSpy).not.toHaveBeenCalled();
        });
      });

      describe('in STREAM_JSON mode', () => {
        beforeEach(() => {
          (
            mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
          ).mockReturnValue(OutputFormat.STREAM_JSON);
        });

        it('should log error message to stderr and not exit', () => {
          handleToolError(toolName, toolError, mockConfig);

          // Should not exit in STREAM_JSON mode (just log to stderr when debug mode is on)
          expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Error executing tool test-tool: Tool failed',
          );
          expect(processExitSpy).not.toHaveBeenCalled();
        });
      });
    });

    describe('when debug mode is disabled', () => {
      beforeEach(() => {
        (mockConfig.getDebugMode as Mock).mockReturnValue(false);
      });

      it('should not log and not exit in text mode', () => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.TEXT);

        handleToolError(toolName, toolError, mockConfig);

        expect(consoleErrorSpy).not.toHaveBeenCalled();
        expect(processExitSpy).not.toHaveBeenCalled();
      });

      it('should not log and not exit in JSON mode', () => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.JSON);

        handleToolError(toolName, toolError, mockConfig);

        expect(consoleErrorSpy).not.toHaveBeenCalled();
        expect(processExitSpy).not.toHaveBeenCalled();
      });

      it('should not log and not exit in STREAM_JSON mode', () => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.STREAM_JSON);

        handleToolError(toolName, toolError, mockConfig);

        expect(consoleErrorSpy).not.toHaveBeenCalled();
        expect(processExitSpy).not.toHaveBeenCalled();
      });
    });

    describe('process exit behavior', () => {
      beforeEach(() => {
        (mockConfig.getDebugMode as Mock).mockReturnValue(true);
      });

      it('should never exit regardless of output format', () => {
        // Test in TEXT mode
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.TEXT);
        handleToolError(toolName, toolError, mockConfig);
        expect(processExitSpy).not.toHaveBeenCalled();

        // Test in JSON mode
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.JSON);
        handleToolError(toolName, toolError, mockConfig);
        expect(processExitSpy).not.toHaveBeenCalled();

        // Test in STREAM_JSON mode
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.STREAM_JSON);
        handleToolError(toolName, toolError, mockConfig);
        expect(processExitSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('handleCancellationError', () => {
    describe('in text mode', () => {
      beforeEach(() => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.TEXT);
      });

      it('should log cancellation message and exit with 130', () => {
        expect(() => {
          handleCancellationError(mockConfig);
        }).toThrow('process.exit called with code: 130');

        expect(consoleErrorSpy).toHaveBeenCalledWith('Operation cancelled.');
      });
    });

    describe('in JSON mode', () => {
      beforeEach(() => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.JSON);
      });

      it('should format cancellation as JSON and exit with 130', () => {
        expect(() => {
          handleCancellationError(mockConfig);
        }).toThrow('process.exit called with code: 130');

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          JSON.stringify(
            {
              error: {
                type: 'FatalCancellationError',
                message: 'Operation cancelled.',
                code: 130,
              },
            },
            null,
            2,
          ),
        );
      });
    });
  });

  describe('handleMaxTurnsExceededError', () => {
    describe('in text mode', () => {
      beforeEach(() => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.TEXT);
      });

      it('should log max turns message and exit with 53', () => {
        expect(() => {
          handleMaxTurnsExceededError(mockConfig);
        }).toThrow('process.exit called with code: 53');

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          'Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.',
        );
      });
    });

    describe('in JSON mode', () => {
      beforeEach(() => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.JSON);
      });

      it('should format max turns error as JSON and exit with 53', () => {
        expect(() => {
          handleMaxTurnsExceededError(mockConfig);
        }).toThrow('process.exit called with code: 53');

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          JSON.stringify(
            {
              error: {
                type: 'FatalTurnLimitedError',
                message:
                  'Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.',
                code: 53,
              },
            },
            null,
            2,
          ),
        );
      });
    });
  });
});
