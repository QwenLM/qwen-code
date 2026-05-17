/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, type Mock, type MockInstance } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  OutputFormat,
  FatalInputError,
  ToolErrorType,
} from '@qwen-code/qwen-code-core';
import {
  AlreadyReportedError,
  _resetExitLatchForTest,
  getErrorMessage,
  handleError,
  handleToolError,
  handleCancellationError,
  handleMaxTurnsExceededError,
} from './errors.js';
import { _resetCleanupFunctionsForTest, registerCleanup } from './cleanup.js';

const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const debugLoggerSpy = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Mock the core modules
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();

  return {
    ...original,
    createDebugLogger: () => ({
      debug: debugLoggerSpy.debug,
      info: debugLoggerSpy.info,
      warn: debugLoggerSpy.warn,
      error: debugLoggerSpy.error,
    }),
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

vi.mock('./stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
  writeStdoutLine: vi.fn(),
  clearScreen: vi.fn(),
}));

describe('errors', () => {
  let mockConfig: Config;
  let processExitSpy: MockInstance;
  let processStderrWriteSpy: MockInstance;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    mockWriteStderrLine.mockClear();
    debugLoggerSpy.debug.mockClear();
    debugLoggerSpy.info.mockClear();
    debugLoggerSpy.warn.mockClear();
    debugLoggerSpy.error.mockClear();
    _resetCleanupFunctionsForTest();
    _resetExitLatchForTest();

    // Mock process.stderr.write
    processStderrWriteSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    // Mock process.exit to throw instead of actually exiting
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit called with code: ${code}`);
    });

    // Create mock config
    mockConfig = {
      getOutputFormat: vi.fn().mockReturnValue(OutputFormat.TEXT),
      getContentGeneratorConfig: vi.fn().mockReturnValue({ authType: 'test' }),
      getDebugMode: vi.fn().mockReturnValue(true),
      isInteractive: vi.fn().mockReturnValue(false),
    } as unknown as Config;
  });

  afterEach(() => {
    processStderrWriteSpy.mockRestore();
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

    it('should extract message from error-like objects', () => {
      const obj = { message: 'test error message' };
      expect(getErrorMessage(obj)).toBe('test error message');
    });

    it('should stringify plain objects without message property', () => {
      const obj = { code: 500, details: 'internal error' };
      expect(getErrorMessage(obj)).toBe(
        '{"code":500,"details":"internal error"}',
      );
    });

    it('should handle empty objects', () => {
      expect(getErrorMessage({})).toBe('{}');
    });

    it('should handle objects with non-string message property', () => {
      const obj = { message: 123 };
      expect(getErrorMessage(obj)).toBe('{"message":123}');
    });

    it('should fallback to String() when toJSON returns undefined', () => {
      const obj = {
        toJSON() {
          return undefined;
        },
      };
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

      it('should log error message and re-throw', async () => {
        const testError = new Error('Test error');

        await expect(handleError(testError, mockConfig)).rejects.toThrow(
          testError,
        );

        expect(mockWriteStderrLine).toHaveBeenCalledWith(
          'API Error: Test error',
        );
      });

      it('should handle non-Error objects', async () => {
        const testError = 'String error';

        await expect(handleError(testError, mockConfig)).rejects.toThrow(
          testError,
        );

        expect(mockWriteStderrLine).toHaveBeenCalledWith(
          'API Error: String error',
        );
      });

      it('does not reformat or reprint AlreadyReportedError', async () => {
        // The non-interactive runner formats and prints the API error
        // itself, then throws AlreadyReportedError as a marker. handleError
        // must propagate that throw without producing a second stderr line
        // (the bug this fix targets) or running parseAndFormatApiError on
        // the already-formatted message (which would yield
        // "[API Error: [API Error: ...]]").
        const reported = new AlreadyReportedError(
          '[API Error: 402 Model X is not available for billing.]',
        );

        await expect(handleError(reported, mockConfig)).rejects.toBe(reported);

        expect(mockWriteStderrLine).not.toHaveBeenCalled();
      });
    });

    describe('in JSON mode', () => {
      beforeEach(() => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.JSON);
      });

      it('should format error as JSON and exit with default code', async () => {
        const testError = new Error('Test error');

        await expect(handleError(testError, mockConfig)).rejects.toThrow(
          'process.exit called with code: 1',
        );

        expect(mockWriteStderrLine).toHaveBeenCalledWith(
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

      it('does not reformat or reprint AlreadyReportedError in JSON mode', async () => {
        const reported = new AlreadyReportedError(
          '[API Error: 402 Model X is not available for billing.]',
          42,
        );

        await expect(handleError(reported, mockConfig)).rejects.toThrow(
          'process.exit called with code: 42',
        );

        expect(mockWriteStderrLine).toHaveBeenCalledTimes(1);
        expect(mockWriteStderrLine).toHaveBeenCalledWith(
          JSON.stringify(
            {
              error: {
                type: 'AlreadyReportedError',
                message:
                  '[API Error: 402 Model X is not available for billing.]',
                code: 42,
              },
            },
            null,
            2,
          ),
        );
      });

      it('should use custom error code when provided', async () => {
        const testError = new Error('Test error');

        await expect(handleError(testError, mockConfig, 42)).rejects.toThrow(
          'process.exit called with code: 42',
        );

        expect(mockWriteStderrLine).toHaveBeenCalledWith(
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

      it('should extract exitCode from FatalError instances', async () => {
        const fatalError = new FatalInputError('Fatal error');

        await expect(handleError(fatalError, mockConfig)).rejects.toThrow(
          'process.exit called with code: 42',
        );

        expect(mockWriteStderrLine).toHaveBeenCalledWith(
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

      it('should handle error with code property', async () => {
        const errorWithCode = new Error('Error with code') as Error & {
          code: number;
        };
        errorWithCode.code = 404;

        await expect(handleError(errorWithCode, mockConfig)).rejects.toThrow(
          'process.exit called with code: 404',
        );
      });

      it('should handle error with status property', async () => {
        const errorWithStatus = new Error('Error with status') as Error & {
          status: string;
        };
        errorWithStatus.status = 'TIMEOUT';

        await expect(handleError(errorWithStatus, mockConfig)).rejects.toThrow(
          'process.exit called with code: 1', // string codes become 1
        );

        expect(mockWriteStderrLine).toHaveBeenCalledWith(
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

          expect(debugLoggerSpy.error).toHaveBeenCalledWith(
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

          expect(debugLoggerSpy.error).toHaveBeenCalledWith(
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
          expect(debugLoggerSpy.error).toHaveBeenCalledWith(
            'Error executing tool test-tool: Tool failed',
          );
          expect(processExitSpy).not.toHaveBeenCalled();
        });

        it('should log error with custom error code and not exit', () => {
          handleToolError(toolName, toolError, mockConfig, 'CUSTOM_TOOL_ERROR');

          // In JSON mode, should not exit (just log to stderr when debug mode is on)
          expect(debugLoggerSpy.error).toHaveBeenCalledWith(
            'Error executing tool test-tool: Tool failed',
          );
          expect(processExitSpy).not.toHaveBeenCalled();
        });

        it('should log error with numeric error code and not exit', () => {
          handleToolError(toolName, toolError, mockConfig, 500);

          // In JSON mode, should not exit (just log to stderr when debug mode is on)
          expect(debugLoggerSpy.error).toHaveBeenCalledWith(
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
          expect(debugLoggerSpy.error).toHaveBeenCalledWith(
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
          expect(debugLoggerSpy.error).toHaveBeenCalledWith(
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

      it('should log error and not exit in text mode', () => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.TEXT);

        handleToolError(toolName, toolError, mockConfig);

        expect(debugLoggerSpy.error).toHaveBeenCalledWith(
          'Error executing tool test-tool: Tool failed',
        );
        expect(processExitSpy).not.toHaveBeenCalled();
      });

      it('should log error and not exit in JSON mode', () => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.JSON);

        handleToolError(toolName, toolError, mockConfig);

        expect(debugLoggerSpy.error).toHaveBeenCalledWith(
          'Error executing tool test-tool: Tool failed',
        );
        expect(processExitSpy).not.toHaveBeenCalled();
      });

      it('should log error and not exit in STREAM_JSON mode', () => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.STREAM_JSON);

        handleToolError(toolName, toolError, mockConfig);

        expect(debugLoggerSpy.error).toHaveBeenCalledWith(
          'Error executing tool test-tool: Tool failed',
        );
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

    describe('permission denied warnings', () => {
      it('should show warning when EXECUTION_DENIED in non-interactive text mode', () => {
        (mockConfig.getDebugMode as Mock).mockReturnValue(false);
        (mockConfig.isInteractive as Mock).mockReturnValue(false);
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.TEXT);

        handleToolError(
          toolName,
          toolError,
          mockConfig,
          ToolErrorType.EXECUTION_DENIED,
        );

        expect(processStderrWriteSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            'Warning: Tool "test-tool" requires user approval',
          ),
        );
        expect(processStderrWriteSpy).toHaveBeenCalledWith(
          expect.stringContaining('use the -y flag (YOLO mode)'),
        );
        expect(processExitSpy).not.toHaveBeenCalled();
      });

      it('should not show warning when EXECUTION_DENIED in interactive mode', () => {
        (mockConfig.getDebugMode as Mock).mockReturnValue(false);
        (mockConfig.isInteractive as Mock).mockReturnValue(true);
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.TEXT);

        handleToolError(
          toolName,
          toolError,
          mockConfig,
          ToolErrorType.EXECUTION_DENIED,
        );

        expect(processStderrWriteSpy).not.toHaveBeenCalled();
        expect(processExitSpy).not.toHaveBeenCalled();
      });

      it('should not show warning when EXECUTION_DENIED in JSON mode', () => {
        (mockConfig.getDebugMode as Mock).mockReturnValue(false);
        (mockConfig.isInteractive as Mock).mockReturnValue(false);
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.JSON);

        handleToolError(
          toolName,
          toolError,
          mockConfig,
          ToolErrorType.EXECUTION_DENIED,
        );

        expect(processStderrWriteSpy).not.toHaveBeenCalled();
        expect(processExitSpy).not.toHaveBeenCalled();
      });

      it('should not show warning for non-EXECUTION_DENIED errors', () => {
        (mockConfig.getDebugMode as Mock).mockReturnValue(false);
        (mockConfig.isInteractive as Mock).mockReturnValue(false);
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.TEXT);

        handleToolError(
          toolName,
          toolError,
          mockConfig,
          ToolErrorType.FILE_NOT_FOUND,
        );

        expect(processStderrWriteSpy).not.toHaveBeenCalled();
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

      it('should log cancellation message and exit with 130', async () => {
        await expect(handleCancellationError(mockConfig)).rejects.toThrow(
          'process.exit called with code: 130',
        );

        expect(mockWriteStderrLine).toHaveBeenCalledWith(
          'Operation cancelled.',
        );
      });
    });

    describe('in JSON mode', () => {
      beforeEach(() => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.JSON);
      });

      it('should format cancellation as JSON and exit with 130', async () => {
        await expect(handleCancellationError(mockConfig)).rejects.toThrow(
          'process.exit called with code: 130',
        );

        expect(mockWriteStderrLine).toHaveBeenCalledWith(
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

      it('should log max turns message and exit with 53', async () => {
        await expect(handleMaxTurnsExceededError(mockConfig)).rejects.toThrow(
          'process.exit called with code: 53',
        );

        expect(mockWriteStderrLine).toHaveBeenCalledWith(
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

      it('should format max turns error as JSON and exit with 53', async () => {
        await expect(handleMaxTurnsExceededError(mockConfig)).rejects.toThrow(
          'process.exit called with code: 53',
        );

        expect(mockWriteStderrLine).toHaveBeenCalledWith(
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

    describe('with --json-schema active', () => {
      // When the structured-output run hits maxSessionTurns the generic
      // "increase maxSessionTurns" message can be misleading: the real
      // cause is usually that structured_output never got called (denied
      // by permissions, unsatisfiable schema, prompt didn't instruct the
      // model). Append a contextual hint so users debugging a stuck
      // --json-schema run know where to look.
      beforeEach(() => {
        (mockConfig as unknown as { getJsonSchema: Mock }).getJsonSchema = vi
          .fn()
          .mockReturnValue({ type: 'object' });
      });

      it('appends a json-schema-specific hint in text mode', async () => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.TEXT);

        await expect(handleMaxTurnsExceededError(mockConfig)).rejects.toThrow(
          'process.exit called with code: 53',
        );

        const written = mockWriteStderrLine.mock.calls[0]?.[0] as string;
        expect(written).toMatch(/Reached max session turns for this session\./);
        expect(written).toMatch(/--json-schema is active/);
        expect(written).toMatch(/permissions\.deny.*--exclude-tools/);
      });

      it('appends a json-schema-specific hint inside the JSON error message', async () => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.JSON);

        await expect(handleMaxTurnsExceededError(mockConfig)).rejects.toThrow(
          'process.exit called with code: 53',
        );

        const written = mockWriteStderrLine.mock.calls[0]?.[0] as string;
        const parsed = JSON.parse(written) as {
          error: { type: string; message: string; code: number };
        };
        expect(parsed.error.type).toBe('FatalTurnLimitedError');
        expect(parsed.error.code).toBe(53);
        expect(parsed.error.message).toMatch(/--json-schema is active/);
      });
    });
  });

  describe('cleanup-before-exit invariant', () => {
    // Regression: previously these handlers called process.exit synchronously,
    // bypassing the caller's runExitCleanup → flush() chain on SIGINT, max-
    // turn, and fatal-error paths. Same family as the EPIPE/process.exit
    // bug fixed for stdout in nonInteractiveCli.
    it('handleCancellationError drains registered cleanups before exit', async () => {
      const cleanupOrder: string[] = [];
      registerCleanup(() => {
        cleanupOrder.push('cleanup');
      });
      processExitSpy.mockImplementation((code) => {
        cleanupOrder.push(`exit:${code}`);
        throw new Error(`process.exit called with code: ${code}`);
      });

      await expect(handleCancellationError(mockConfig)).rejects.toThrow(
        'process.exit called with code: 130',
      );

      expect(cleanupOrder).toEqual(['cleanup', 'exit:130']);
    });

    it('handleMaxTurnsExceededError drains registered cleanups before exit', async () => {
      const cleanupOrder: string[] = [];
      registerCleanup(() => {
        cleanupOrder.push('cleanup');
      });
      processExitSpy.mockImplementation((code) => {
        cleanupOrder.push(`exit:${code}`);
        throw new Error(`process.exit called with code: ${code}`);
      });

      await expect(handleMaxTurnsExceededError(mockConfig)).rejects.toThrow(
        'process.exit called with code: 53',
      );

      expect(cleanupOrder).toEqual(['cleanup', 'exit:53']);
    });

    it('handleError drains registered cleanups before exit (JSON mode)', async () => {
      (mockConfig.getOutputFormat as ReturnType<typeof vi.fn>).mockReturnValue(
        OutputFormat.JSON,
      );
      const cleanupOrder: string[] = [];
      registerCleanup(() => {
        cleanupOrder.push('cleanup');
      });
      processExitSpy.mockImplementation((code) => {
        cleanupOrder.push(`exit:${code}`);
        throw new Error(`process.exit called with code: ${code}`);
      });

      await expect(handleError(new Error('boom'), mockConfig)).rejects.toThrow(
        'process.exit called with code: 1',
      );

      expect(cleanupOrder).toEqual(['cleanup', 'exit:1']);
    });

    it('a second terminating handler does not race the first into double-exit', async () => {
      // Models the real concurrency: SIGINT → handleCancellationError fires
      // while a stream rejection lands in the catch → handleError(JSON).
      // Without the exit-once latch we'd get duplicate cleanup runs +
      // duplicate process.exit calls + interleaved stderr writes.
      // (Text-mode handleError throws instead of exiting, so it isn't part
      // of the race — the latch lives on the exit path.)
      (mockConfig.getOutputFormat as ReturnType<typeof vi.fn>).mockReturnValue(
        OutputFormat.JSON,
      );

      let exitCalls = 0;
      processExitSpy.mockImplementation((code) => {
        exitCalls += 1;
        throw new Error(`process.exit called with code: ${code}`);
      });

      const first = handleCancellationError(mockConfig);
      const second = handleError(new Error('boom'), mockConfig);

      await expect(first).rejects.toThrow('process.exit called with code: 130');

      // The second handler is parked in the latch's unresolved promise.
      let secondSettled = false;
      void second.then(
        () => {
          secondSettled = true;
        },
        () => {
          secondSettled = true;
        },
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(exitCalls).toBe(1);
      expect(secondSettled).toBe(false);
    });

    it('handleError drains registered cleanups before re-throw (text mode)', async () => {
      // Text mode re-throws to the caller; we still want the queue drained
      // first so the unhandled-rejection path doesn't lose records.
      (mockConfig.getOutputFormat as ReturnType<typeof vi.fn>).mockReturnValue(
        OutputFormat.TEXT,
      );
      const events: string[] = [];
      registerCleanup(() => {
        events.push('cleanup');
      });

      const original = new Error('boom');
      await expect(handleError(original, mockConfig)).rejects.toBe(original);

      expect(events).toEqual(['cleanup']);
    });
  });
});
