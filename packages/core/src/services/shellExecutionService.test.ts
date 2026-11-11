/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';

import {
  ShellExecutionService,
  type ShellOutputEvent,
  type ShellExecutionConfig,
} from './shellExecutionService.js';
import type {
  ExecOptions,
  SpawnParams,
  TransformedSpawnParams,
} from '../utils/Shell.js';
import {
  ShellTerminationError,
  type ExecResult,
} from '../utils/ShellCommand.js';
import { TaskOutput } from '../utils/task/TaskOutput.js';
import { ExecutionLifecycleService } from './executionLifecycleService.js';
import { ENV_TEST_VAR } from '../config/brand.js';

// Hoisted mocks
const mockShellExec = vi.hoisted(() => vi.fn());
const mockSetCwd = vi.hoisted(() => vi.fn());
const mockIsBinary = vi.hoisted(() => vi.fn());
const mockPlatform = vi.hoisted(() => vi.fn());
const mockHomedir = vi.hoisted(() => vi.fn().mockReturnValue('/home/test'));
const mockTmpdir = vi.hoisted(() => vi.fn().mockReturnValue('/tmp'));
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockCreateWriteStream = vi.hoisted(() => vi.fn());
const mockStartStallWatchdog = vi.hoisted(() => vi.fn(() => vi.fn()));
const mockRunLogger = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// Top-level mocks
vi.mock('../config/storage.js', () => ({
  Storage: {
    getGlobalTempDir: vi.fn().mockReturnValue('/mock/temp'),
  },
}));
vi.mock('../utils/runLogger.js', () => ({
  runLogger: mockRunLogger,
}));
vi.mock('./stallDetection.js', () => ({
  startStallWatchdog: mockStartStallWatchdog,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: mockMkdirSync,
      createWriteStream: mockCreateWriteStream,
    },
    mkdirSync: mockMkdirSync,
    createWriteStream: mockCreateWriteStream,
  };
});
vi.mock('../utils/Shell.js', () => ({
  exec: mockShellExec,
  setCwd: mockSetCwd,
}));
vi.mock('../utils/textUtils.js', () => ({
  isBinary: mockIsBinary,
  sanitizeOutput: (value: string) => value,
  truncateString: (value: string) => value,
}));
vi.mock('node:os', () => ({
  freemem: vi.fn().mockReturnValue(4 * 1024 * 1024 * 1024),
  totalmem: vi.fn().mockReturnValue(8 * 1024 * 1024 * 1024),
  hostname: vi.fn().mockReturnValue('test-host'),
  default: {
    platform: mockPlatform,
    homedir: mockHomedir,
    tmpdir: mockTmpdir,
    constants: {
      signals: {
        SIGTERM: 15,
        SIGKILL: 9,
      },
    },
  },
  platform: mockPlatform,
  homedir: mockHomedir,
  tmpdir: mockTmpdir,
  constants: {
    signals: {
      SIGTERM: 15,
      SIGKILL: 9,
    },
  },
}));

const shellExecutionConfig: ShellExecutionConfig = {
  sessionId: 'default',
  pager: 'cat',
  disableDynamicLineTrimming: true,
  sanitizationConfig: {
    enableEnvironmentVariableRedaction: false,
    allowedEnvironmentVariables: [],
    blockedEnvironmentVariables: [],
  },
};

/**
 * Helper: sets up mockShellExec to return a controllable ShellCommand.
 * Returns an object with methods to invoke captured callbacks and resolve the result.
 */
function setupMockShellExec(pid = 12345) {
  let capturedOptions: ExecOptions | undefined;
  let resolveResult: ((result: ExecResult) => void) | undefined;
  let rejectResult: ((error: unknown) => void) | undefined;
  let countLinesEnabled = false;
  let outputFileRedundant = false;
  const countLinesFn = vi.fn((enabled: boolean) => { countLinesEnabled = enabled; });
  const killFn = vi.fn();
  const backgroundFn = vi.fn();
  const onTimeoutFn = vi.fn();
  const mockGetStdout = vi.fn().mockResolvedValue('');
  const mockGetStderr = vi.fn().mockReturnValue('');
  const mockDeleteOutputFile = vi.fn();

  const resultPromise = new Promise<ExecResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  mockShellExec.mockImplementation(
    (
      _command: string,
      _signal: AbortSignal,
      _shellType: string,
      options?: ExecOptions,
    ) => {
      capturedOptions = options;
      return Promise.resolve({
        result: resultPromise,
        kill: killFn,
        status: 'running' as const,
        pid,
        background: backgroundFn,
        cleanup: vi.fn(),
        onTimeout: onTimeoutFn,
        taskOutput: {
          taskId: 'btest',
          flush: vi.fn().mockResolvedValue(undefined),
          getStdout: mockGetStdout,
          getStderr: mockGetStderr,
          deleteOutputFile: mockDeleteOutputFile,
          outputFileSize: 0,
          stdoutToFile: true,
          path: '/mock/output',
          get exactLineCountingEnabled() { return countLinesEnabled; },
          get outputFileRedundant() { return outputFileRedundant; },
          setExactLineCounting: countLinesFn,
          startPolling: vi.fn(),
          stopPolling: vi.fn(),
          writeStdout: vi.fn(),
          writeStderr: vi.fn(),
          spillToDisk: vi.fn(),
          clear: vi.fn(),
        },
      });
    },
  );

  return {
    get options() {
      return capturedOptions;
    },
    emitProgress(allLines: string) {
      capturedOptions?.onProgress?.('', allLines, 0, 0, false);
    },
    async getTransformSpawn(): Promise<
      ((params: SpawnParams) => Promise<TransformedSpawnParams>) | undefined
    > {
      return capturedOptions?.transformSpawn;
    },
    resolve(result: ExecResult) {
      resolveResult?.(result);
    },
    reject(error: unknown) {
      rejectResult?.(error);
    },
    setFinalOutput(output: string) {
      mockGetStdout.mockResolvedValue(output);
    },
    setFinalStderr(stderr: string) {
      mockGetStderr.mockReturnValue(stderr);
    },
    setOutputFileRedundant(value: boolean) {
      outputFileRedundant = value;
    },
    deleteOutputFile: mockDeleteOutputFile,
    countLinesFn,
    killFn,
    backgroundFn,
    onTimeoutFn,
    pid,
  };
}

describe('ShellExecutionService', () => {
  let onOutputEventMock: Mock<(event: ShellOutputEvent) => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBinary.mockReturnValue(false);
    mockPlatform.mockReturnValue('linux');
    mockTmpdir.mockReturnValue('/tmp');
    onOutputEventMock = vi.fn();
  });

  // Helper to run a standard execution simulation
  const simulateExecution = async (
    command: string,
    simulation: (mock: ReturnType<typeof setupMockShellExec>) => void,
  ) => {
    const mock = setupMockShellExec();
    const abortController = new AbortController();
    const handle = await ShellExecutionService.execute(
      command,
      '/test/dir',
      onOutputEventMock,
      abortController.signal,
      shellExecutionConfig,
    );

    await new Promise((resolve) => process.nextTick(resolve));
    simulation(mock);
    const result = await handle.result;
    return { result, handle, abortController, mock };
  };

  it('preserves process-exit timing after background return and output processing', async () => {
    const mock = setupMockShellExec();
    const completed = vi.fn();
    ExecutionLifecycleService.onBackgroundComplete(completed);
    try {
      const handle = await ShellExecutionService.execute(
        'command',
        '/test/dir',
        onOutputEventMock,
        new AbortController().signal,
        {
          ...shellExecutionConfig,
          taskKind: 'bash',
          startInBackground: { reason: 'model' },
        },
      );
      expect((await handle.result).backgrounded).toBe(true);
      expect(completed).not.toHaveBeenCalled();
      mock.resolve({
        stdout: '',
        stderr: '',
        code: 0,
        interrupted: false,
        processTiming: { startedAt: 1000, endedAt: 1160, durationMs: 160 },
      });
      await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({
          processTiming: { startedAt: 1000, endedAt: 1160, durationMs: 160 },
          backgroundReason: 'model',
        }),
      );
    } finally {
      ExecutionLifecycleService.offBackgroundComplete(completed);
    }
  });

  it.each([
    { options: {}, enabled: false },
    { options: { exactOutputLineCount: true, stdoutToFile: false }, enabled: false },
    { options: { exactOutputLineCount: true }, enabled: true },
    { options: { exactOutputLineCount: true, startInBackground: { reason: 'model' as const } }, enabled: false },
    { options: { exactOutputLineCount: true, shellType: 'powershell' as const }, enabled: false },
  ])('counts exactly only for opted-in foreground Bash: $options', async ({ options, enabled }) => {
    const mock = setupMockShellExec();
    const handle = await ShellExecutionService.execute('echo x', '/test/dir', onOutputEventMock,
      new AbortController().signal, { ...shellExecutionConfig, ...options });
    expect(mock.countLinesFn).toHaveBeenCalledWith(enabled);
    if (enabled) {
      mock.options?.onProgress?.('', 'tail', 99, 100, true, undefined);
      expect(onOutputEventMock).toHaveBeenLastCalledWith(expect.objectContaining({ totalLines: undefined }));
      mock.options?.onProgress?.('', 'tail', 99, 100, true, 80);
      expect(onOutputEventMock).toHaveBeenLastCalledWith(expect.objectContaining({ totalLines: 80 }));
      ShellExecutionService.background(mock.pid);
      expect(mock.countLinesFn).toHaveBeenLastCalledWith(false);
      mock.options?.onProgress?.('', 'next tail', 100, 200, true, undefined);
      expect(onOutputEventMock).toHaveBeenLastCalledWith(expect.objectContaining({ totalLines: 100 }));
    }
    mock.resolve({ code: 0, interrupted: false, stdout: '', stderr: '' });
    await handle.result;
  });

  describe('Successful Execution', () => {
    it('keeps Bash file-output handling without reading unused result streams', async () => {
      const { result } = await simulateExecution('printf output', (mock) => {
        mock.setFinalOutput('output  \n');
        mock.resolve({
          code: 0,
          interrupted: false,
          get stdout(): string {
            throw new Error('unused stdout accessed');
          },
          get stderr(): string {
            throw new Error('unused stderr accessed');
          },
        });
      });
      expect(result.output).toBe('output');
      expect(result).not.toHaveProperty('stdout');
      expect(result).not.toHaveProperty('stderr');
    });

    it('should execute a command and capture stdout via onProgress', async () => {
      const { result, handle } = await simulateExecution('ls -l', (mock) => {
        mock.emitProgress('file1.txt\n');
        mock.setFinalOutput('file1.txt\n');
        mock.resolve({
          stdout: 'file1.txt\n',
          stderr: '',
          code: 0,
          interrupted: false,
        });
      });

      expect(mockShellExec).toHaveBeenCalledWith(
        'ls -l',
        expect.any(Object), // AbortSignal
        'bash',
        expect.objectContaining({
          cwd: '/test/dir',
          preventCwdChanges: false,
          stdoutToFile: true,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.error).toBeNull();
      expect(result.aborted).toBe(false);
      expect(result.output).toBe('file1.txt');
      expect(handle.pid).toBe(12345);

      expect(onOutputEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'data',
          chunk: 'file1.txt\n',
        }),
      );
      expect(onOutputEventMock).toHaveBeenCalledWith({
        type: 'exit',
        exitCode: 0,
        signal: null,
      });
    });

    it('should handle commands with no output', async () => {
      const { result } = await simulateExecution('touch file', (mock) => {
        mock.setFinalOutput('');
        mock.resolve({
          stdout: '',
          stderr: '',
          code: 0,
          interrupted: false,
        });
      });

      expect(result.output.trim()).toBe('');
      expect(onOutputEventMock).toHaveBeenCalledWith({
        type: 'exit',
        exitCode: 0,
        signal: null,
      });
    });
  });

  describe('Failed Execution', () => {
    it('should capture a non-zero exit code', async () => {
      const { result } = await simulateExecution('a-bad-command', (mock) => {
        mock.emitProgress('command not found');
        mock.setFinalOutput('command not found');
        mock.resolve({
          stdout: 'command not found',
          stderr: '',
          code: 127,
          interrupted: false,
        });
      });

      expect(result.exitCode).toBe(127);
      expect(result.output.trim()).toBe('command not found');
      expect(result.error).toBeNull();
    });

    it('should propagate a termination signal captured by the child process', async () => {
      const { result } = await simulateExecution('long-process', (mock) => {
        mock.resolve({
          stdout: '',
          stderr: '',
          code: 143, // 128 + 15 = SIGTERM
          signal: 15,
          interrupted: false,
        });
      });

      expect(result.exitCode).toBe(143);
      expect(result.signal).toBe(15);
    });

    it('should not infer a signal from an explicit high exit code', async () => {
      const { result } = await simulateExecution('exit 137', (mock) => {
        mock.resolve({
          stdout: '',
          stderr: '',
          code: 137,
          interrupted: false,
        });
      });

      expect(result.exitCode).toBe(137);
      expect(result.signal).toBeNull();
    });

    it('should handle a pre-spawn error', async () => {
      const { result } = await simulateExecution('protected-cmd', (mock) => {
        mock.resolve({
          stdout: '',
          stderr: '',
          code: 1,
          interrupted: false,
          preSpawnError: 'spawn EACCES',
        });
      });

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe('spawn EACCES');
      expect(result.exitCode).toBe(1);
    });
  });

  describe('Completion Failure', () => {
    it('keeps the command result when the completion callback throws', async () => {
      const mock = setupMockShellExec();
      const onOutputThrows = vi.fn((event: ShellOutputEvent) => {
        if (event.type === 'exit') {
          throw new Error('exit event handler failed');
        }
      });
      const handle = await ShellExecutionService.execute(
        'echo done',
        '/test/dir',
        onOutputThrows,
        new AbortController().signal,
        shellExecutionConfig,
      );
      await new Promise((resolve) => process.nextTick(resolve));
      mock.setFinalOutput('done\n');
      mock.resolve({ stdout: '', stderr: '', code: 0, interrupted: false });

      const result = await handle.result;

      expect(result.exitCode).toBe(0);
      expect(result.aborted).toBe(false);
      expect(result.output).toBe('done');
      expect(mockRunLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('onOutputEvent failed'),
      );
    });

    it('settles with failure when completion processing throws', async () => {
      mockIsBinary.mockImplementationOnce(() => {
        throw new Error('binary detection failed');
      });
      const mock = setupMockShellExec();
      const handle = await ShellExecutionService.execute(
        'echo done',
        '/test/dir',
        onOutputEventMock,
        new AbortController().signal,
        shellExecutionConfig,
      );
      await new Promise((resolve) => process.nextTick(resolve));
      mock.setFinalOutput('done\n');
      mock.resolve({
        stdout: '',
        stderr: '',
        code: 0,
        interrupted: false,
        processTiming: { startedAt: 1000, endedAt: 1160, durationMs: 160 },
      });

      const result = await handle.result;
      expect(result.processTiming).toEqual({
        startedAt: 1000,
        endedAt: 1160,
        durationMs: 160,
      });

      expect(result.exitCode).toBe(1);
      expect(result.error?.message).toBe('binary detection failed');
    });
  });

  describe('Termination Failure', () => {
    it('settles the execution when the shell result rejects after root exit', async () => {
      const stopPollingSpy = vi.spyOn(TaskOutput, 'stopPolling');
      try {
        const mock = setupMockShellExec();
        const handle = await ShellExecutionService.execute(
          'sleep 120 && tail -50 output',
          '/test/dir',
          onOutputEventMock,
          new AbortController().signal,
          shellExecutionConfig,
        );
        await new Promise((resolve) => process.nextTick(resolve));
        mock.setFinalOutput('partial output\n');
        mock.reject(
          new ShellTerminationError(
            'Failed to terminate process tree pid=12345',
            new Error('taskkill exit 128'),
            {
              stdout: '',
              stderr: '',
              code: 0,
              processTiming: {
                startedAt: 1000,
                endedAt: 1160,
                durationMs: 160,
              },
              interrupted: true,
              timedOut: true,
              outputLimitExceeded: false,
            },
          ),
        );

        const result = await handle.result;

        expect(result.exitCode).toBe(0);
        expect(result.aborted).toBe(true);
        expect(result.timedOut).toBe(true);
        expect(result.processTiming).toEqual({
          startedAt: 1000,
          endedAt: 1160,
          durationMs: 160,
        });
        expect(result.signal).toBeNull();
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error?.message).toBe(
          'Failed to terminate process tree pid=12345',
        );
        expect(result.output).toBe('partial output');
        expect(stopPollingSpy).toHaveBeenCalledWith('btest');
        expect(onOutputEventMock).toHaveBeenCalledWith({
          type: 'exit',
          exitCode: 0,
          signal: null,
        });
      } finally {
        stopPollingSpy.mockRestore();
      }
    });

    it('preserves original stdout and stderr when a pipe result rejects', async () => {
      const mock = setupMockShellExec();
      const handle = await ShellExecutionService.execute(
        'hook-command',
        '/test/dir',
        onOutputEventMock,
        new AbortController().signal,
        { ...shellExecutionConfig, preserveStdoutAndStderr: true },
      );
      await new Promise((resolve) => process.nextTick(resolve));
      mock.reject(
        new ShellTerminationError(
          'termination failed',
          new Error('taskkill exit 128'),
          {
            stdout: 'original stdout\n',
            stderr: 'original stderr\n',
            code: 0,
            interrupted: true,
            timedOut: false,
            outputLimitExceeded: false,
          },
        ),
      );

      const result = await handle.result;

      expect(result.stdout).toBe('original stdout');
      expect(result.stderr).toContain('original stderr');
      expect(result.stderr).toContain('termination failed');
      expect(result.aborted).toBe(true);
    });

    it('falls back to TaskOutput streams when the rejection has no result', async () => {
      const mock = setupMockShellExec();
      mock.setFinalOutput('full pipe output\n');
      mock.setFinalStderr('pipe stderr\n');
      const handle = await ShellExecutionService.execute(
        'hook-command',
        '/test/dir',
        onOutputEventMock,
        new AbortController().signal,
        { ...shellExecutionConfig, preserveStdoutAndStderr: true },
      );
      await new Promise((resolve) => process.nextTick(resolve));
      mock.reject(new Error('termination failed'));

      const result = await handle.result;

      expect(result.stdout).toBe('full pipe output');
      expect(result.stderr).toContain('pipe stderr');
      expect(result.stderr).toContain('termination failed');
    });

    it('keeps the output file for a background task when the result rejects', async () => {
      const mock = setupMockShellExec();
      mock.setOutputFileRedundant(true);
      const handle = await ShellExecutionService.execute(
        'background-command',
        '/test/dir',
        onOutputEventMock,
        new AbortController().signal,
        shellExecutionConfig,
      );
      await new Promise((resolve) => process.nextTick(resolve));
      mock.setFinalOutput('small output\n');
      mock.reject(
        new ShellTerminationError(
          'termination failed',
          new Error('taskkill exit 128'),
          {
            stdout: '',
            stderr: '',
            code: 0,
            interrupted: true,
            backgroundTaskId: 'btask',
          },
        ),
      );

      const result = await handle.result;

      expect(mock.deleteOutputFile).not.toHaveBeenCalled();
      expect(result.output).toBe('small output');
    });
  });

  it('retains a failed stop for a subsequent retry instead of dropping its command', async () => {
    const mock = setupMockShellExec(12349);
    await ShellExecutionService.execute(
      'sleep 5',
      '/test/dir',
      onOutputEventMock,
      new AbortController().signal,
      shellExecutionConfig,
    );
    mock.killFn.mockRejectedValueOnce(new Error('Access is denied'));
    await expect(ShellExecutionService.kill(12349)).rejects.toThrow(
      'Access is denied',
    );
    expect(ShellExecutionService.getOutputFilePath(12349)).toBe('/mock/output');
    expect(ShellExecutionService.isActive(12349)).toBe(true);
    mock.killFn.mockResolvedValueOnce(undefined);
    await ShellExecutionService.kill(12349);
    expect(mock.killFn).toHaveBeenCalledTimes(2);
    expect(ShellExecutionService.getOutputFilePath(12349)).toBeUndefined();
  });

  describe('Timeout Auto-Backgrounding', () => {
    it('moves the execution to background with timeout reason when configured', async () => {
      const mock = setupMockShellExec();
      const abortController = new AbortController();
      const handle = await ShellExecutionService.execute(
        'npm test',
        '/test/dir',
        onOutputEventMock,
        abortController.signal,
        {
          ...shellExecutionConfig,
          originalCommand: 'npm test',
          autoBackgroundOnTimeout: true,
        },
      );

      expect(mock.options).toEqual(
        expect.objectContaining({
          shouldAutoBackground: true,
        }),
      );
      expect(mock.onTimeoutFn).toHaveBeenCalledTimes(1);

      const timeoutCallback = mock.onTimeoutFn.mock.calls[0][0];
      timeoutCallback(vi.fn());

      const result = await handle.result;
      expect(mock.backgroundFn).toHaveBeenCalledWith('bg-12345');
      expect(result.backgrounded).toBe(true);
      expect(result.backgroundReason).toBe('timeout');
      expect(mockStartStallWatchdog).not.toHaveBeenCalled();

      await ShellExecutionService.kill(12345);
    });
  });

  describe('Explicit Backgrounding', () => {
    it('registers an already-settled short command before returning its handle', async () => {
      const mock = setupMockShellExec();
      const onBackground = vi.fn();
      ExecutionLifecycleService.onBackground(onBackground);
      try {
        mock.resolve({
          stdout: '',
          stderr: 'command not found',
          code: 127,
          interrupted: false,
        });

        const handle = await ShellExecutionService.execute(
          'missing-command',
          '/test/dir',
          onOutputEventMock,
          new AbortController().signal,
          {
            ...shellExecutionConfig,
            originalCommand: 'missing-command',
            taskId: 'bfastfail',
            ownerAgentId: 'agent-1',
            toolUseId: 'tool-1',
            startInBackground: { reason: 'model' },
          },
        );

        const result = await handle.result;
        expect(mock.backgroundFn).toHaveBeenCalledWith('bfastfail');
        expect(onBackground).toHaveBeenCalledWith(
          expect.objectContaining({
            executionId: 12345,
            taskId: 'bfastfail',
            reason: 'model',
          }),
        );
        expect(mockStartStallWatchdog).toHaveBeenCalledWith({
          taskId: 'bfastfail',
          outputPath: '/mock/output',
          description: 'missing-command',
          toolUseId: 'tool-1',
          targetAgentId: 'agent-1',
          sessionId: 'default',
        });
        expect(result).toMatchObject({
          backgrounded: true,
          backgroundReason: 'model',
          pid: 12345,
        });
      } finally {
        ExecutionLifecycleService.offBackground(onBackground);
      }
    });
  });

  describe('Aborting Commands', () => {
    it('should set the aborted flag when signal is aborted', async () => {
      const { result } = await simulateExecution('sleep 10', (mock) => {
        mock.resolve({
          stdout: '',
          stderr: '',
          code: 137, // 128 + 9 = SIGKILL
          interrupted: true,
        });
      });

      expect(result.aborted).toBe(true);
    });
  });

  describe('Binary Output (post-hoc detection)', () => {
    it('retains decoded text and JSON even when binary detection is true', async () => {
      mockIsBinary.mockReturnValue(true);

      const { result } = await simulateExecution('cat image.png', (mock) => {
        mock.setFinalOutput(Buffer.concat([
          Buffer.from('HEADER\n'),
          Buffer.from([0, 255, 254]),
          Buffer.from('\n{"ok":true}\n'),
        ]).toString('utf8'));
        mock.resolve({
          stdout: '',
          stderr: '',
          code: 0,
          interrupted: false,
        });
      });

      expect(result.output).toBe('HEADER\n\0��\n{"ok":true}');
      expect(result.output).not.toContain('[Binary output:');
      expect(onOutputEventMock).toHaveBeenCalledWith({
        type: 'exit',
        exitCode: 0,
        signal: null,
      });
    });

    it('preserves indentation, ANSI and control characters in the decoded result', async () => {
      const { result } = await simulateExecution('printf mixed', (mock) => {
        mock.setFinalOutput('\n  \n  \x1b[31mHEADER\x1b[0m\0\x07\n');
        mock.resolve({ stdout: '', stderr: '', code: 0, interrupted: false });
      });
      expect(result.output).toBe('  \x1b[31mHEADER\x1b[0m\0\x07');
    });

    it('should return normal text output when not binary', async () => {
      mockIsBinary.mockReturnValue(false);

      const { result } = await simulateExecution('cat text.txt', (mock) => {
        mock.setFinalOutput('hello world\n');
        mock.resolve({
          stdout: 'hello world\n',
          stderr: '',
          code: 0,
          interrupted: false,
        });
      });

      expect(result.output).toBe('hello world');
    });
  });

  describe('Shell.exec() integration', () => {
    it('does not mutate tracked CWD before executing', async () => {
      const mock = setupMockShellExec();
      await ShellExecutionService.execute(
        'ls',
        '/my/cwd',
        onOutputEventMock,
        new AbortController().signal,
        shellExecutionConfig,
      );
      expect(mockSetCwd).not.toHaveBeenCalled();
      // Clean up
      mock.resolve({ stdout: '', stderr: '', code: 0, interrupted: false });
    });

    it('should pass transformSpawn in ExecOptions', async () => {
      const mock = setupMockShellExec();
      await ShellExecutionService.execute(
        'ls',
        '/test',
        onOutputEventMock,
        new AbortController().signal,
        shellExecutionConfig,
      );

      expect(mock.options?.transformSpawn).toBeDefined();
      expect(typeof mock.options?.transformSpawn).toBe('function');
      // Clean up
      mock.resolve({ stdout: '', stderr: '', code: 0, interrupted: false });
    });
  });
});

describe('ShellExecutionService environment variables', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform.mockReturnValue('linux');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should use a sanitized environment when in a GitHub run', async () => {
    vi.stubEnv('GITHUB_SHA', 'test-sha');
    vi.stubEnv('MY_SENSITIVE_VAR', 'secret-value');
    vi.stubEnv('PATH', '/test/path');
    vi.stubEnv(ENV_TEST_VAR, 'test-value');

    vi.resetModules();
    const { ShellExecutionService } = await import(
      './shellExecutionService.js'
    );

    const mock = setupMockShellExec();
    await ShellExecutionService.execute(
      'test-cp-command',
      '/',
      vi.fn(),
      new AbortController().signal,
      {
        ...shellExecutionConfig,
        sanitizationConfig: {
          enableEnvironmentVariableRedaction: false,
          allowedEnvironmentVariables: [],
          blockedEnvironmentVariables: [],
        },
      },
    );

    // Get the captured transformSpawn and invoke it to check env
    const transformSpawn = mock.options?.transformSpawn;
    expect(transformSpawn).toBeDefined();

    const transformed = await transformSpawn!({
      program: 'bash',
      args: ['-c', 'test'],
      env: { ...process.env } as Record<string, string | undefined>,
      cwd: '/',
    });

    expect(transformed.env).not.toHaveProperty('MY_SENSITIVE_VAR');
    expect(transformed.env).toHaveProperty('PATH', '/test/path');
    expect(transformed.env).toHaveProperty(ENV_TEST_VAR, 'test-value');

    // Clean up
    mock.resolve({ stdout: '', stderr: '', code: 0, interrupted: false });
    await new Promise(process.nextTick);
  });

  it('should use a sanitized environment when in a GitHub run (SURFACE=Github)', async () => {
    vi.stubEnv('SURFACE', 'Github');
    vi.stubEnv('MY_SENSITIVE_VAR', 'secret-value');
    vi.stubEnv('PATH', '/test/path');
    vi.stubEnv(ENV_TEST_VAR, 'test-value');

    vi.resetModules();
    const { ShellExecutionService } = await import(
      './shellExecutionService.js'
    );

    const mock = setupMockShellExec();
    await ShellExecutionService.execute(
      'test-cp-command-surface',
      '/',
      vi.fn(),
      new AbortController().signal,
      {
        ...shellExecutionConfig,
        sanitizationConfig: {
          enableEnvironmentVariableRedaction: false,
          allowedEnvironmentVariables: [],
          blockedEnvironmentVariables: [],
        },
      },
    );

    const transformSpawn = mock.options?.transformSpawn;
    expect(transformSpawn).toBeDefined();

    const transformed = await transformSpawn!({
      program: 'bash',
      args: ['-c', 'test'],
      env: { ...process.env } as Record<string, string | undefined>,
      cwd: '/',
    });

    expect(transformed.env).not.toHaveProperty('MY_SENSITIVE_VAR');
    expect(transformed.env).toHaveProperty('PATH', '/test/path');
    expect(transformed.env).toHaveProperty(ENV_TEST_VAR, 'test-value');

    // Clean up
    mock.resolve({ stdout: '', stderr: '', code: 0, interrupted: false });
    await new Promise(process.nextTick);
  });

  it('should include the full process.env when not in a GitHub run', async () => {
    vi.stubEnv('MY_TEST_VAR', 'test-value');
    vi.stubEnv('GITHUB_SHA', '');
    vi.stubEnv('SURFACE', '');
    vi.resetModules();
    const { ShellExecutionService } = await import(
      './shellExecutionService.js'
    );

    const mock = setupMockShellExec();
    await ShellExecutionService.execute(
      'test-cp-command-no-github',
      '/',
      vi.fn(),
      new AbortController().signal,
      shellExecutionConfig,
    );

    const transformSpawn = mock.options?.transformSpawn;
    expect(transformSpawn).toBeDefined();

    const transformed = await transformSpawn!({
      program: 'bash',
      args: ['-c', 'test'],
      env: { ...process.env } as Record<string, string | undefined>,
      cwd: '/',
    });

    expect(transformed.env).toHaveProperty('MY_TEST_VAR', 'test-value');

    // Clean up
    mock.resolve({ stdout: '', stderr: '', code: 0, interrupted: false });
    await new Promise(process.nextTick);
  });

  it('should pass through user git config and not clobber credential.helper', async () => {
    const PROMPT_ENV_KEYS = [
      'GIT_TERMINAL_PROMPT',
      'GIT_ASKPASS',
      'SSH_ASKPASS',
      'GH_PROMPT_DISABLED',
      'GCM_INTERACTIVE',
      'DISPLAY',
      'DBUS_SESSION_BUS_ADDRESS',
    ] as const;
    const USER_PROMPT_ENV: Record<(typeof PROMPT_ENV_KEYS)[number], string> = {
      GIT_TERMINAL_PROMPT: '1',
      GIT_ASKPASS: '/usr/bin/git-askpass',
      SSH_ASKPASS: '/usr/bin/ssh-askpass',
      GH_PROMPT_DISABLED: '0',
      GCM_INTERACTIVE: 'auto',
      DISPLAY: ':0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/dbus',
    };

    vi.resetModules();
    vi.stubEnv('GIT_CONFIG_COUNT', '2');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.editor');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'vim');
    vi.stubEnv('GIT_CONFIG_KEY_1', 'pull.rebase');
    vi.stubEnv('GIT_CONFIG_VALUE_1', 'true');
    vi.stubEnv('GIT_CONFIG_KEY_2', undefined);
    vi.stubEnv('GIT_CONFIG_VALUE_2', undefined);
    for (const key of PROMPT_ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }

    const { ShellExecutionService } = await import(
      './shellExecutionService.js'
    );

    const mock = setupMockShellExec();
    await ShellExecutionService.execute(
      'test-cp-headless-git',
      '/',
      vi.fn(),
      new AbortController().signal,
      shellExecutionConfig,
    );

    const transformSpawn = mock.options?.transformSpawn;
    expect(transformSpawn).toBeDefined();

    const transformed = await transformSpawn!({
      program: 'bash',
      args: ['-c', 'test'],
      env: { ...process.env } as Record<string, string | undefined>,
      cwd: '/',
    });

    const cpEnv = transformed.env;
    for (const key of PROMPT_ENV_KEYS) {
      expect(cpEnv[key]).toBeUndefined();
    }

    // Existing values should be preserved
    expect(cpEnv).toHaveProperty('GIT_CONFIG_KEY_0', 'core.editor');
    expect(cpEnv).toHaveProperty('GIT_CONFIG_VALUE_0', 'vim');
    expect(cpEnv).toHaveProperty('GIT_CONFIG_KEY_1', 'pull.rebase');
    expect(cpEnv).toHaveProperty('GIT_CONFIG_VALUE_1', 'true');

    // The credential.helper reset should not be injected.
    expect(cpEnv).toHaveProperty('GIT_CONFIG_COUNT', '2');
    expect(cpEnv['GIT_CONFIG_KEY_2']).toBeUndefined();
    expect(cpEnv['GIT_CONFIG_VALUE_2']).toBeUndefined();

    for (const [key, value] of Object.entries(USER_PROMPT_ENV)) {
      vi.stubEnv(key, value);
    }

    const userEnvTransformed = await transformSpawn!({
      program: 'bash',
      args: ['-c', 'test'],
      env: { ...process.env } as Record<string, string | undefined>,
      cwd: '/',
    });

    expect(userEnvTransformed.env).toMatchObject({
      ...USER_PROMPT_ENV,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.editor',
      GIT_CONFIG_VALUE_0: 'vim',
      GIT_CONFIG_KEY_1: 'pull.rebase',
      GIT_CONFIG_VALUE_1: 'true',
    });
    expect(userEnvTransformed.env['GIT_CONFIG_KEY_2']).toBeUndefined();
    expect(userEnvTransformed.env['GIT_CONFIG_VALUE_2']).toBeUndefined();

    // Clean up
    mock.resolve({ stdout: '', stderr: '', code: 0, interrupted: false });
    await new Promise(process.nextTick);
  });

  it('applies product-supplied environment preparation after merging spawn inputs', async () => {
    // Set the host business identity env vars in process.env. Shell.exec()'s
    // buildProcessEnv copies process.env into params.env, which then gets
    // spread into baseEnv — so these would survive sanitization unless
    // explicitly stripped after the spread.
    vi.stubEnv('HOST_CLIENT_TYPE', '99');
    vi.stubEnv('HOST_BUSINESS_PRODUCT', 'work');
    vi.stubEnv('HOST_BUSINESS_TYPE', 'chat');
    vi.stubEnv('HOST_BUSINESS_SUB_TASK', 'analysis');
    vi.stubEnv('HOST_SCENE', 'assistant');
    vi.stubEnv('PATH', '/test/path');

    vi.resetModules();
    const { ShellExecutionService } = await import(
      './shellExecutionService.js'
    );

    const mock = setupMockShellExec();
    await ShellExecutionService.execute(
      'test-strip-host-identity',
      '/',
      vi.fn(),
      new AbortController().signal,
      { ...shellExecutionConfig, environmentPreparation: { beforeSanitization(env) {
        for (const key of ['HOST_CLIENT_TYPE', 'HOST_BUSINESS_PRODUCT', 'HOST_BUSINESS_TYPE', 'HOST_BUSINESS_SUB_TASK', 'HOST_SCENE']) delete env[key];
      } } },
    );

    const transformSpawn = mock.options?.transformSpawn;
    expect(transformSpawn).toBeDefined();

    // Pass the host business identity vars in BOTH env-shape positions: process.env (read by
    // the service) AND params.env (spread on top of sanitizedEnv).
    // The strip must run after the spread, so both must be cleared.
    const transformed = await transformSpawn!({
      program: 'bash',
      args: ['-c', 'test'],
      env: {
        ...process.env,
        HOST_CLIENT_TYPE: '99',
        HOST_BUSINESS_PRODUCT: 'work',
        HOST_BUSINESS_TYPE: 'chat',
        HOST_BUSINESS_SUB_TASK: 'analysis',
        HOST_SCENE: 'assistant',
      } as Record<string, string | undefined>,
      cwd: '/',
    });

    expect(transformed.env).not.toHaveProperty('HOST_CLIENT_TYPE');
    expect(transformed.env).not.toHaveProperty('HOST_BUSINESS_PRODUCT');
    expect(transformed.env).not.toHaveProperty('HOST_BUSINESS_TYPE');
    expect(transformed.env).not.toHaveProperty('HOST_BUSINESS_SUB_TASK');
    expect(transformed.env).not.toHaveProperty('HOST_SCENE');
    // Sanity check: unrelated vars survive
    expect(transformed.env).toHaveProperty('PATH', '/test/path');

    mock.resolve({ stdout: '', stderr: '', code: 0, interrupted: false });
    await new Promise(process.nextTick);
  });
});
