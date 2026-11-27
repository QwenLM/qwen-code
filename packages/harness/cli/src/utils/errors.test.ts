/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  vi,
  type MockInstance,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';
import type { Config } from '@qwen-code/core';
import {
  OutputFormat,
  FatalInputError,
  runLogger,
  coreEvents,
  parseAndFormatApiError,
  ModelInferenceError,
} from '@qwen-code/core';
import {
  handleError,
  handleCancellationError,
  buildErrorResultMessage,
} from './errors.js';
import { runSyncCleanup } from './cleanup.js';

// Mock the cleanup module
describe('Provider failure result', () => {
  it.each(['140', undefined])(
    'preserves the Provider code %s in headless failure output',
    (code) => {
      const error = new ModelInferenceError('HTTP 503', {
        code,
        kind: 'server',
        status: 503,
        phase: 'before_output',
      });
      const result = buildErrorResultMessage('provider-error-session', {
        error,
        errors: [error.message],
        errorCode: 10500,
      });
      if (code === undefined) expect(result).not.toHaveProperty('error_code');
      else expect(result.error_code).toBe(code);
    },
  );
});

vi.mock('./cleanup.js', () => ({
  runSyncCleanup: vi.fn(),
}));

// Mock the core modules
vi.mock('@qwen-code/core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/core')>();

  return {
    ...original,
    parseAndFormatApiError: vi.fn((error: unknown) => {
      if (error instanceof Error) {
        return `API Error: ${error.message}`;
      }
      return `API Error: ${String(error)}`;
    }),
    ndjsonSafeStringify: JSON.stringify,
    cloneUsage: vi.fn().mockReturnValue({
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
      },
      inference_geo: '',
      iterations: [],
      speed: 'standard',
    }),
    coreEvents: {
      emitFeedback: vi.fn(),
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
  let debugLoggerErrorSpy: MockInstance;
  let coreEventsEmitFeedbackSpy: MockInstance;
  let runSyncCleanupSpy: MockInstance;
  let stdoutWriteSpy: MockInstance;

  const TEST_SESSION_ID = 'test-session-123';

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Mock runLogger
    debugLoggerErrorSpy = vi
      .spyOn(runLogger, 'error')
      .mockImplementation(() => {});

    // Mock coreEvents
    coreEventsEmitFeedbackSpy = vi.mocked(coreEvents.emitFeedback);

    // Mock runSyncCleanup
    runSyncCleanupSpy = vi.mocked(runSyncCleanup);
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    // Mock process.exit to throw instead of actually exiting
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit called with code: ${code}`);
    });

    // Create mock config
    mockConfig = {
      getOutputFormat: vi.fn().mockReturnValue(OutputFormat.TEXT),
      getContentGeneratorConfig: vi.fn().mockReturnValue({ authType: 'test' }),
      getSessionId: vi.fn().mockReturnValue(TEST_SESSION_ID),
    } as unknown as Config;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    debugLoggerErrorSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe('handleError', () => {
    describe('in text mode', () => {
      beforeEach(() => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.TEXT);
      });

      it('should re-throw without logging to runLogger', () => {
        const testError = new Error('Test error');

        expect(() => {
          handleError(testError, mockConfig);
        }).toThrow(testError);

        expect(debugLoggerErrorSpy).not.toHaveBeenCalled();
      });

      it('should handle non-Error objects', () => {
        const testError = 'String error';

        expect(() => {
          handleError(testError, mockConfig);
        }).toThrow(testError);
      });
    });

    describe('in JSON mode', () => {
      beforeEach(() => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.JSON);
      });

      it('should emit result error JSON and exit with default code', () => {
        const testError = new Error('Test error');

        expect(() => {
          handleError(testError, mockConfig);
        }).toThrow('process.exit called with code: 1');

        const payload = JSON.parse(stdoutWriteSpy.mock.calls[0][0]);
        expect(payload.type).toBe('result');
        expect(payload.subtype).toBe('error_during_execution');
        expect(payload.is_error).toBe(true);
        expect(payload.errors).toEqual(['API Error: Test error']);
        expect(coreEventsEmitFeedbackSpy).not.toHaveBeenCalled();
        expect(debugLoggerErrorSpy).not.toHaveBeenCalled();
        expect(runSyncCleanupSpy).toHaveBeenCalled();
      });

      it('should emit unmapped server codes as result error_code', () => {
        const body = '{"code":"101","message":"Signature invalid"}';
        const testError = Object.assign(
          new Error(`Qoder API error: FORBIDDEN - ${body}`),
          { qoderApiError: { code: '101', message: 'Signature invalid' } },
        );

        expect(() => {
          handleError(testError, mockConfig);
        }).toThrow('process.exit called with code: 1');

        const payload = JSON.parse(stdoutWriteSpy.mock.calls[0][0]);
        expect(payload.error_code).toBe(101);
        expect(payload.error_message).toBe('Signature invalid');
        expect(payload.errors).toEqual([`API Error: ${testError.message}`]);
      });

      it.each([
        ['linux', 'EDQUOT', -122],
        ['linux', 'ENOSPC', -28],
        ['linux', 'Unknown system error -122', -122],
        ['darwin', 'EDQUOT', -69],
        ['darwin', 'ENOSPC', -28],
        ['darwin', 'Unknown system error -69', -69],
        ['win32', 'ENOSPC', -4055],
        ['win32', 'Unknown system error -4055', -4055],
      ] as const)(
        '%s 的 SDK 初始化失败透传存储错误 %s 和中性提示',
        async (platform, code, errno) => {
          vi.stubGlobal('process', { ...process, platform });
          const original = await vi.importActual<
            typeof import('@qwen-code/core')
          >('@qwen-code/core');
          vi.mocked(parseAndFormatApiError).mockImplementationOnce(
            original.parseAndFormatApiError,
          );
          const rawMessage = `${code}: ${code}, close`;
          const error = Object.assign(new Error(rawMessage), {
            code,
            errno,
            syscall: 'close',
          });

          expect(() => handleError(error, mockConfig)).toThrow(
            'process.exit called with code: 1',
          );
          const payload = JSON.parse(stdoutWriteSpy.mock.calls[0][0]);
          expect(payload).toMatchObject({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            error_code: 'storage_insufficient',
            session_id: TEST_SESSION_ID,
          });
          expect(payload.errors[0]).toContain('execution environment');
          expect(payload.errors[0]).not.toContain('API Error');
          expect(payload.errors[0]).not.toContain('Unknown system error');
          expect(payload.errors[0]).not.toContain('administrator');
          expect(debugLoggerErrorSpy).toHaveBeenCalledWith(
            'Execution environment operation failed',
            error,
          );
          expect(error.message).toBe(rawMessage);
        },
      );

      it.each([
        ['EACCES', 'filesystem_access_denied'],
        ['EPERM', 'filesystem_access_denied'],
        ['EROFS', 'filesystem_access_denied'],
        ['EMFILE', 'open_files_limit_reached'],
        ['ENFILE', 'open_files_limit_reached'],
        ['EIO', 'filesystem_io_failed'],
        ['ESTALE', 'filesystem_io_failed'],
        ['ENOMEM', 'memory_insufficient'],
        ['EBUSY', 'filesystem_busy'],
        ['ETXTBSY', 'filesystem_busy'],
      ])(
        'SDK 初始化错误 %s 输出明确错误码并保留原始日志',
        async (code, expected) => {
          const original = await vi.importActual<
            typeof import('@qwen-code/core')
          >('@qwen-code/core');
          vi.mocked(parseAndFormatApiError).mockImplementationOnce(
            original.parseAndFormatApiError,
          );
          const error = Object.assign(
            new Error(`${code}: operation failed, open '/private/session'`),
            { code, syscall: 'open' },
          );
          expect(() => handleError(error, mockConfig)).toThrow(
            'process.exit called with code: 1',
          );
          const payload = JSON.parse(stdoutWriteSpy.mock.calls[0][0]);
          expect(payload).toMatchObject({
            type: 'result',
            error_code: expected,
            session_id: TEST_SESSION_ID,
          });
          expect(payload.errors[0]).toBe(
            original.getExecutionEnvironmentError(error)?.message,
          );
          expect(payload.errors[0]).not.toContain('/private/session');
          expect(debugLoggerErrorSpy).toHaveBeenCalledWith(
            'Execution environment operation failed',
            error,
          );
        },
      );

      it('SDK 文件监听失败不能在错误 result 文本识别时误报磁盘容量', async () => {
        const original = await vi.importActual<
          typeof import('@qwen-code/core')
        >('@qwen-code/core');
        vi.mocked(parseAndFormatApiError).mockImplementationOnce(
          original.parseAndFormatApiError,
        );
        const error = Object.assign(
          new Error('ENOSPC: no space left on device'),
          { code: 'ENOSPC', syscall: 'watch' },
        );
        expect(() => handleError(error, mockConfig)).toThrow(
          'process.exit called with code: 1',
        );
        const payload = JSON.parse(stdoutWriteSpy.mock.calls[0][0]);
        expect(payload.error_code).not.toBe('storage_insufficient');
        expect(payload.errors[0]).not.toContain('available disk space');
        expect(debugLoggerErrorSpy).not.toHaveBeenCalledWith(
          'Execution environment operation failed',
          error,
        );
      });

      it('should use custom error code when provided', () => {
        const testError = new Error('Test error');

        expect(() => {
          handleError(testError, mockConfig, 42);
        }).toThrow('process.exit called with code: 42');

        const payload = JSON.parse(stdoutWriteSpy.mock.calls[0][0]);
        expect(payload.errors).toEqual(['API Error: Test error']);
        expect(coreEventsEmitFeedbackSpy).not.toHaveBeenCalled();
        expect(debugLoggerErrorSpy).not.toHaveBeenCalled();
      });

      it('should extract exitCode from FatalError instances', () => {
        const fatalError = new FatalInputError('Fatal error');

        expect(() => {
          handleError(fatalError, mockConfig);
        }).toThrow('process.exit called with code: 42');

        const payload = JSON.parse(stdoutWriteSpy.mock.calls[0][0]);
        expect(payload.errors).toEqual(['API Error: Fatal error']);
        expect(coreEventsEmitFeedbackSpy).not.toHaveBeenCalled();
        expect(debugLoggerErrorSpy).not.toHaveBeenCalled();
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

        const payload = JSON.parse(stdoutWriteSpy.mock.calls[0][0]);
        expect(payload.errors).toEqual(['API Error: Error with status']);
      });

      it('should emit Service Account failures as structured auth errors', () => {
        const authError = Object.assign(
          new Error('Provide a valid Service Account key and try again.'),
          { code: 'service_account_key_invalid' },
        );

        expect(() => {
          handleError(authError, mockConfig);
        }).toThrow('process.exit called with code: 41');

        const payload = JSON.parse(stdoutWriteSpy.mock.calls[0][0]);
        expect(payload.terminal_reason).toBe('completed');
        expect(payload.errors).toEqual([
          'API Error: Provide a valid Service Account key and try again.',
        ]);
      });
    });

    describe('in STREAM_JSON mode', () => {
      beforeEach(() => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.STREAM_JSON);
      });

      it('should emit result event, run cleanup, and exit', () => {
        const testError = new Error('Test error');

        expect(() => {
          handleError(testError, mockConfig);
        }).toThrow('process.exit called with code: 1');

        const payload = JSON.parse(stdoutWriteSpy.mock.calls[0][0]);
        expect(payload.type).toBe('result');
        expect(payload.subtype).toBe('error_during_execution');
        expect(payload.is_error).toBe(true);
        expect(payload.errors).toEqual(['API Error: Test error']);
        expect(runSyncCleanupSpy).toHaveBeenCalled();
      });

      it('should extract exitCode from FatalError instances', () => {
        const fatalError = new FatalInputError('Fatal error');

        expect(() => {
          handleError(fatalError, mockConfig);
        }).toThrow('process.exit called with code: 42');
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

      it('should emit feedback exactly once, run cleanup, and exit with 130', () => {
        expect(() => {
          handleCancellationError(mockConfig);
        }).toThrow('process.exit called with code: 130');

        expect(coreEventsEmitFeedbackSpy).toHaveBeenCalledTimes(1);
        expect(coreEventsEmitFeedbackSpy).toHaveBeenCalledWith(
          'error',
          'Operation cancelled.',
        );
        expect(debugLoggerErrorSpy).not.toHaveBeenCalled();
        expect(runSyncCleanupSpy).toHaveBeenCalled();
      });
    });

    describe('in JSON mode', () => {
      beforeEach(() => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.JSON);
      });

      it('should emit cancellation as result JSON and exit with 130', () => {
        expect(() => {
          handleCancellationError(mockConfig);
        }).toThrow('process.exit called with code: 130');

        const payload = JSON.parse(stdoutWriteSpy.mock.calls[0][0]);
        expect(payload.subtype).toBe('error_during_execution');
        expect(payload.errors).toEqual(['Operation cancelled.']);
        expect(coreEventsEmitFeedbackSpy).not.toHaveBeenCalled();
        expect(debugLoggerErrorSpy).not.toHaveBeenCalled();
      });
    });

    describe('in STREAM_JSON mode', () => {
      beforeEach(() => {
        (
          mockConfig.getOutputFormat as ReturnType<typeof vi.fn>
        ).mockReturnValue(OutputFormat.STREAM_JSON);
      });

      it('should emit result event and exit with 130', () => {
        expect(() => {
          handleCancellationError(mockConfig);
        }).toThrow('process.exit called with code: 130');
        const payload = JSON.parse(stdoutWriteSpy.mock.calls[0][0]);
        expect(payload.subtype).toBe('error_during_execution');
        expect(payload.errors).toEqual(['Operation cancelled.']);
        expect(coreEventsEmitFeedbackSpy).not.toHaveBeenCalled();
      });
    });
  });
});
