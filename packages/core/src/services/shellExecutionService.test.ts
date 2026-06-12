/**
 * @license
 * Copyright 2025 Google LLC
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
import EventEmitter from 'node:events';
import type { Readable } from 'node:stream';
import { type ChildProcess } from 'node:child_process';
import pkg from '@xterm/headless';
import type {
  ShellAbortReason,
  ShellExecutionConfig,
  ShellExecuteOptions,
  ShellOutputEvent,
  ShellPostPromoteSettleInfo,
} from './shellExecutionService.js';
import {
  getShellAbortReasonKind,
  ShellExecutionService,
} from './shellExecutionService.js';
import type { AnsiOutput } from '../utils/terminalSerializer.js';

const { Terminal } = pkg;

// Hoisted Mocks
const mockGetSystemEncoding = vi.hoisted(() =>
  vi.fn().mockReturnValue('utf-8'),
);
const mockPtySpawn = vi.hoisted(() => vi.fn());
const mockCpSpawn = vi.hoisted(() => vi.fn());
const mockIsBinary = vi.hoisted(() => vi.fn());
const mockPlatform = vi.hoisted(() => vi.fn());
const mockGetPty = vi.hoisted(() => vi.fn());
const mockSerializeTerminalToObject = vi.hoisted(() => vi.fn());
const mockSerializeTerminalToText = vi.hoisted(() =>
  vi.fn((terminal: pkg.Terminal): string => {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];

    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      const lineContent = line ? line.translateToString(true) : '';

      if (line?.isWrapped && lines.length > 0) {
        lines[lines.length - 1] += lineContent;
        continue;
      }

      lines.push(lineContent);
    }

    return lines.join('\n').trimEnd();
  }),
);
const mockGetShellConfiguration = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    executable: 'bash',
    argsPrefix: ['-c'],
    shell: 'bash',
  }),
);

// Top-level Mocks
vi.mock('@lydell/node-pty', () => ({
  spawn: mockPtySpawn,
}));
vi.mock('child_process', () => ({
  spawn: mockCpSpawn,
}));
vi.mock('../utils/textUtils.js', () => ({
  isBinary: mockIsBinary,
}));
vi.mock('os', () => ({
  default: {
    platform: mockPlatform,
    constants: {
      signals: {
        SIGTERM: 15,
        SIGKILL: 9,
      },
    },
  },
  platform: mockPlatform,
  constants: {
    signals: {
      SIGTERM: 15,
      SIGKILL: 9,
    },
  },
}));
vi.mock('../utils/getPty.js', () => ({
  getPty: mockGetPty,
}));
vi.mock('../utils/terminalSerializer.js', () => ({
  serializeTerminalToObject: mockSerializeTerminalToObject,
  serializeTerminalToText: mockSerializeTerminalToText,
}));
vi.mock('../utils/shell-utils.js', () => ({
  getShellConfiguration: mockGetShellConfiguration,
}));
vi.mock('../utils/systemEncoding.js', () => ({
  getCachedEncodingForBuffer: vi.fn().mockReturnValue('utf-8'),
  getSystemEncoding: mockGetSystemEncoding,
}));

const mockProcessKill = vi
  .spyOn(process, 'kill')
  .mockImplementation(() => true);

const shellExecutionConfig = {
  terminalWidth: 80,
  terminalHeight: 24,
  pager: 'cat',
  showColor: false,
  disableDynamicLineTrimming: true,
} satisfies ShellExecutionConfig;

const WINDOWS_SYSTEM_PATH = 'C:\\Windows\\System32;C:\\Shared\\Tools';
const WINDOWS_USER_PATH = 'C:\\Users\\tester\\bin;C:\\Shared\\Tools';
const EXPECTED_MERGED_WINDOWS_PATH =
  'C:\\Windows\\System32;C:\\Shared\\Tools;C:\\Users\\tester\\bin';

let originalProcessEnv: NodeJS.ProcessEnv;

const createExpectedAnsiOutput = (text: string | string[]): AnsiOutput => {
  const lines = Array.isArray(text) ? text : text.split('\n');
  const expected: AnsiOutput = Array.from(
    { length: shellExecutionConfig.terminalHeight },
    (_, i) => [
      {
        text: expect.stringMatching((lines[i] || '').trim()),
        bold: false,
        italic: false,
        underline: false,
        dim: false,
        inverse: false,
        fg: '',
        bg: '',
      },
    ],
  );
  return expected;
};

const createAnsiToken = (text: string) => ({
  text,
  bold: false,
  italic: false,
  underline: false,
  dim: false,
  inverse: false,
  fg: '',
  bg: '',
});

const setupConflictingPathEnv = () => {
  process.env = {
    ...originalProcessEnv,
    PATH: WINDOWS_SYSTEM_PATH,
    Path: WINDOWS_USER_PATH,
  };
};

const expectNormalizedWindowsPathEnv = (env: NodeJS.ProcessEnv) => {
  expect(env['PATH']).toBe(EXPECTED_MERGED_WINDOWS_PATH);
  expect(env['Path']).toBeUndefined();
};

const waitForDataEventCount = async (
  onOutputEventMock: Mock<(event: ShellOutputEvent) => void>,
  expectedCount: number,
) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const dataEvents = onOutputEventMock.mock.calls.filter(
      ([event]) => event.type === 'data',
    );
    if (dataEvents.length >= expectedCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

describe('ShellExecutionService', () => {
  let mockPtyProcess: EventEmitter & {
    pid: number;
    kill: Mock;
    onData: Mock;
    onExit: Mock;
    write: Mock;
    resize: Mock;
  };
  let mockHeadlessTerminal: {
    resize: Mock;
    scrollLines: Mock;
    buffer: {
      active: {
        viewportY: number;
      };
    };
  };
  let onOutputEventMock: Mock<(event: ShellOutputEvent) => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalProcessEnv = process.env;

    mockIsBinary.mockReturnValue(false);
    mockPlatform.mockReturnValue('linux');
    mockGetPty.mockResolvedValue({
      module: { spawn: mockPtySpawn },
      name: 'mock-pty',
    });

    onOutputEventMock = vi.fn();

    mockPtyProcess = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: Mock;
      onData: Mock;
      onExit: Mock;
      write: Mock;
      resize: Mock;
    };
    mockPtyProcess.pid = 12345;
    mockPtyProcess.kill = vi.fn();
    // node-pty's onData/onExit return IDisposable; the production
    // background-promote path calls .dispose() on those handles to detach
    // its listeners cleanly. Mock them to return a disposable stub so the
    // promote path doesn't crash on `undefined.dispose()`.
    mockPtyProcess.onData = vi.fn().mockReturnValue({ dispose: vi.fn() });
    mockPtyProcess.onExit = vi.fn().mockReturnValue({ dispose: vi.fn() });
    mockPtyProcess.write = vi.fn();
    mockPtyProcess.resize = vi.fn();

    mockHeadlessTerminal = {
      resize: vi.fn(),
      scrollLines: vi.fn(),
      buffer: {
        active: {
          viewportY: 0,
        },
      },
    };

    mockPtySpawn.mockReturnValue(mockPtyProcess);
  });

  afterEach(() => {
    process.env = originalProcessEnv;
    vi.unstubAllEnvs();
  });

  // Helper function to run a standard execution simulation
  const simulateExecution = async (
    command: string,
    simulation: (
      ptyProcess: typeof mockPtyProcess,
      ac: AbortController,
    ) => void,
    config: ShellExecutionConfig = shellExecutionConfig,
    options: ShellExecuteOptions = {},
  ) => {
    const abortController = new AbortController();
    const handle = await ShellExecutionService.execute(
      command,
      '/test/dir',
      onOutputEventMock,
      abortController.signal,
      true,
      config,
      options,
    );

    await new Promise((resolve) => process.nextTick(resolve));
    simulation(mockPtyProcess, abortController);
    const result = await handle.result;
    return { result, handle, abortController };
  };

  describe('Successful Execution', () => {
    it('should execute a command and capture output', async () => {
      const { result, handle } = await simulateExecution('ls -l', (pty) => {
        pty.onData.mock.calls[0][0]('file1.txt\n');
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      expect(mockPtySpawn).toHaveBeenCalledWith(
        'bash',
        ['-c', 'ls -l'],
        expect.any(Object),
      );
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.error).toBeNull();
      expect(result.aborted).toBe(false);
      expect(result.output.trim()).toBe('file1.txt');
      expect(handle.pid).toBe(12345);

      expect(onOutputEventMock).toHaveBeenCalledWith({
        type: 'data',
        chunk: createExpectedAnsiOutput('file1.txt'),
      });
    });

    it('disposes PTY terminal resources on natural exit', async () => {
      const terminalDisposeSpy = vi.spyOn(Terminal.prototype, 'dispose');
      const removeListenerSpy = vi.spyOn(mockPtyProcess, 'removeListener');

      const { result } = await simulateExecution('ls -l', (pty) => {
        pty.onData.mock.calls[0][0]('file1.txt\n');
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      expect(result.exitCode).toBe(0);
      const dataDisposableStub = mockPtyProcess.onData.mock.results[0]
        .value as { dispose: Mock };
      const exitDisposableStub = mockPtyProcess.onExit.mock.results[0]
        .value as { dispose: Mock };
      expect(dataDisposableStub.dispose).toHaveBeenCalled();
      expect(exitDisposableStub.dispose).toHaveBeenCalled();
      expect(removeListenerSpy).toHaveBeenCalledWith(
        'error',
        expect.any(Function),
      );
      // One terminal is used for live PTY rendering, another for final replay.
      expect(terminalDisposeSpy).toHaveBeenCalledTimes(2);

      terminalDisposeSpy.mockRestore();
    });

    it('should strip ANSI codes from output', async () => {
      const { result } = await simulateExecution('ls --color=auto', (pty) => {
        pty.onData.mock.calls[0][0]('a\u001b[31mred\u001b[0mword');
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      expect(result.output.trim()).toBe('aredword');
      expect(onOutputEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'data',
          chunk: createExpectedAnsiOutput('aredword'),
        }),
      );
    });

    it('should correctly decode multi-byte characters split across chunks', async () => {
      const { result } = await simulateExecution('echo "你好"', (pty) => {
        const multiByteChar = '你好';
        pty.onData.mock.calls[0][0](multiByteChar.slice(0, 1));
        pty.onData.mock.calls[0][0](multiByteChar.slice(1));
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });
      expect(result.output.trim()).toBe('你好');
    });

    it('bounds buffered PTY output before building the final string', async () => {
      const { result } = await simulateExecution(
        'large-output',
        (pty) => {
          pty.onData.mock.calls[0][0]('12345678');
          pty.onData.mock.calls[0][0]('abcdefg');
          pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
        },
        { ...shellExecutionConfig, maxBufferedOutputBytes: 10 },
      );

      expect(result.rawOutput.length).toBe(10);
      expect(result.output).toContain('12345678ab');
      expect(result.output).toContain(
        'Output exceeded the maximum captured size',
      );
      expect(result.output).not.toContain('cdefg');
    });

    it('keeps PTY replay fallback bounded after the capture limit is exceeded', async () => {
      mockSerializeTerminalToText.mockImplementationOnce(() => {
        throw new Error('replay failed');
      });

      const { result } = await simulateExecution(
        'large-output-replay-fallback',
        (pty) => {
          pty.onData.mock.calls[0][0]('12345678');
          pty.onData.mock.calls[0][0]('abcdefg');
          pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
        },
        { ...shellExecutionConfig, maxBufferedOutputBytes: 10 },
      );

      expect(result.rawOutput.toString()).toBe('12345678ab');
      expect(result.output).toContain('12345678ab');
      expect(result.output).toContain(
        'Output exceeded the maximum captured size',
      );
      expect(result.output).not.toContain('cdefg');
    });

    it('does not add a capture-limit notice at the exact PTY buffer boundary', async () => {
      const { result } = await simulateExecution(
        'exact-output',
        (pty) => {
          pty.onData.mock.calls[0][0]('1234567890');
          pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
        },
        { ...shellExecutionConfig, maxBufferedOutputBytes: 10 },
      );

      expect(result.rawOutput.length).toBe(10);
      expect(result.output).toBe('1234567890');
      expect(result.output).not.toContain(
        'Output exceeded the maximum captured size',
      );
    });

    it('should handle commands with no output', async () => {
      await simulateExecution('touch file', (pty) => {
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      expect(onOutputEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          chunk: createExpectedAnsiOutput(''),
        }),
      );
    });

    it('should call onPid with the process id', async () => {
      const abortController = new AbortController();
      const handle = await ShellExecutionService.execute(
        'ls -l',
        '/test/dir',
        onOutputEventMock,
        abortController.signal,
        true,
        shellExecutionConfig,
      );
      mockPtyProcess.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      await handle.result;
      expect(handle.pid).toBe(12345);
    });

    it('should preserve full raw output when terminal writes are backlogged', async () => {
      vi.useFakeTimers();
      const originalWrite = Terminal.prototype.write;
      const delayedWrite = vi
        .spyOn(Terminal.prototype, 'write')
        .mockImplementation(function (
          this: pkg.Terminal,
          data: string | Uint8Array,
          callback?: () => void,
        ) {
          setTimeout(() => {
            originalWrite.call(this, data, callback);
          }, 10);
        });

      try {
        const abortController = new AbortController();
        const handle = await ShellExecutionService.execute(
          'fast-output',
          '/test/dir',
          onOutputEventMock,
          abortController.signal,
          true,
          shellExecutionConfig,
        );

        const onData = mockPtyProcess.onData.mock.calls[0][0] as (
          data: string,
        ) => void;
        for (let i = 1; i <= 500; i++) {
          onData(`Line ${String(i).padStart(4, '0')}\n`);
        }

        const resultPromise = handle.result;
        mockPtyProcess.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });

        await vi.advanceTimersByTimeAsync(250);
        const result = await resultPromise;

        const lines = result.output.split('\n');
        expect(lines).toHaveLength(500);
        expect(lines[0]).toBe('Line 0001');
        expect(lines[499]).toBe('Line 0500');
      } finally {
        delayedWrite.mockRestore();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    it('should collapse carriage-return progress updates in final output', async () => {
      const { result } = await simulateExecution('progress-output', (pty) => {
        pty.onData.mock.calls[0][0]('Compressing objects: 14% (1/7)\r');
        pty.onData.mock.calls[0][0]('Compressing objects: 28% (2/7)\r');
        pty.onData.mock.calls[0][0]('Compressing objects: 42% (3/7)\r');
        pty.onData.mock.calls[0][0]('Compressing objects: 100% (7/7), done.\n');
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      expect(result.output).toBe('Compressing objects: 100% (7/7), done.');
    });

    it('should not persist narrow terminal soft wraps as transcript newlines', async () => {
      const { result } = await simulateExecution(
        'narrow-output',
        (pty) => {
          pty.onData.mock.calls[0][0]('abcdefghijklmnopqrstuvwxyz\nshort\n');
          pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
        },
        {
          ...shellExecutionConfig,
          terminalWidth: 8,
          terminalHeight: 4,
        },
      );

      expect(result.output).toBe('abcdefghijklmnopqrstuvwxyz\nshort');
    });
  });

  describe('pty interaction', () => {
    beforeEach(() => {
      vi.spyOn(ShellExecutionService['activePtys'], 'get').mockReturnValue({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ptyProcess: mockPtyProcess as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        headlessTerminal: mockHeadlessTerminal as any,
      });
    });

    it('should write to the pty and trigger a render', async () => {
      vi.useFakeTimers();
      try {
        const abortController = new AbortController();
        const handle = await ShellExecutionService.execute(
          'interactive-app',
          '/test/dir',
          onOutputEventMock,
          abortController.signal,
          true,
          shellExecutionConfig,
        );

        ShellExecutionService.writeToPty(handle.pid!, 'input');
        mockPtyProcess.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });

        await vi.runAllTimersAsync();
        await handle.result;

        expect(mockPtyProcess.write).toHaveBeenCalledWith('input');
        expect(onOutputEventMock).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should resize the pty and the headless terminal', async () => {
      await simulateExecution('ls -l', (pty) => {
        pty.onData.mock.calls[0][0]('file1.txt\n');
        ShellExecutionService.resizePty(pty.pid!, 100, 40);
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      expect(mockPtyProcess.resize).toHaveBeenCalledWith(100, 40);
      expect(mockHeadlessTerminal.resize).toHaveBeenCalledWith(100, 40);
    });

    it('should ignore expected PTY read EIO errors on process exit', async () => {
      const { result } = await simulateExecution('ls -l', (pty) => {
        const eioError = Object.assign(new Error('read EIO'), { code: 'EIO' });
        pty.emit('error', eioError);
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      expect(result.exitCode).toBe(0);
    });

    it('should throw unexpected PTY errors from error event', async () => {
      const abortController = new AbortController();
      const handle = await ShellExecutionService.execute(
        'ls -l',
        '/test/dir',
        onOutputEventMock,
        abortController.signal,
        true,
        shellExecutionConfig,
      );
      await new Promise((resolve) => process.nextTick(resolve));

      const unexpectedError = Object.assign(new Error('unexpected pty error'), {
        code: 'EPIPE',
      });
      expect(() => mockPtyProcess.emit('error', unexpectedError)).toThrow(
        'unexpected pty error',
      );

      mockPtyProcess.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      await handle.result;
    });

    it('should ignore ioctl EBADF message-only resize race errors', async () => {
      mockPtyProcess.resize.mockImplementationOnce(() => {
        throw new Error('ioctl(2) failed, EBADF');
      });

      await simulateExecution('ls -l', (pty) => {
        pty.onData.mock.calls[0][0]('file1.txt\n');
        expect(() =>
          ShellExecutionService.resizePty(pty.pid!, 100, 40),
        ).not.toThrow();
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });
    });

    it('should ignore exited-pty message-only resize race errors', async () => {
      mockPtyProcess.resize.mockImplementationOnce(() => {
        throw new Error('Cannot resize a pty that has already exited');
      });

      await simulateExecution('ls -l', (pty) => {
        pty.onData.mock.calls[0][0]('file1.txt\n');
        expect(() =>
          ShellExecutionService.resizePty(pty.pid!, 100, 40),
        ).not.toThrow();
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });
    });

    it('should scroll the headless terminal', async () => {
      await simulateExecution('ls -l', (pty) => {
        pty.onData.mock.calls[0][0]('file1.txt\n');
        ShellExecutionService.scrollPty(pty.pid!, 10);
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      expect(mockHeadlessTerminal.scrollLines).toHaveBeenCalledWith(10);
    });
  });

  describe('Failed Execution', () => {
    it('should capture a non-zero exit code', async () => {
      const { result } = await simulateExecution('a-bad-command', (pty) => {
        pty.onData.mock.calls[0][0]('command not found');
        pty.onExit.mock.calls[0][0]({ exitCode: 127, signal: null });
      });

      expect(result.exitCode).toBe(127);
      expect(result.output.trim()).toBe('command not found');
      expect(result.error).toBeNull();
    });

    it('should capture a termination signal', async () => {
      const { result } = await simulateExecution('long-process', (pty) => {
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 15 });
      });

      expect(result.exitCode).toBe(0);
      expect(result.signal).toBe(15);
    });

    it('should handle a synchronous spawn error', async () => {
      mockGetPty.mockImplementation(() => null);

      mockCpSpawn.mockImplementation(() => {
        throw new Error('Simulated PTY spawn error');
      });

      const handle = await ShellExecutionService.execute(
        'any-command',
        '/test/dir',
        onOutputEventMock,
        new AbortController().signal,
        true,
        {},
      );
      const result = await handle.result;

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toContain('Simulated PTY spawn error');
      expect(result.exitCode).toBe(1);
      expect(result.output).toBe('');
      expect(handle.pid).toBeUndefined();
    });
  });

  describe('Aborting Commands', () => {
    it('should abort a running process and set the aborted flag', async () => {
      const { result } = await simulateExecution(
        'sleep 10',
        (pty, abortController) => {
          abortController.abort();
          pty.onExit.mock.calls[0][0]({ exitCode: 1, signal: null });
        },
      );

      expect(result.aborted).toBe(true);
      // The process kill is mocked, so we just check that the flag is set.
    });

    it('signal.reason = { kind: "cancel" } still tree-kills (same as default)', async () => {
      const { result } = await simulateExecution(
        'sleep 10',
        (pty, abortController) => {
          abortController.abort({ kind: 'cancel' } satisfies ShellAbortReason);
          pty.onExit.mock.calls[0][0]({ exitCode: 1, signal: null });
        },
      );

      expect(result.aborted).toBe(true);
      expect(result.promoted).toBeUndefined();
      // The default kill path runs: SIGTERM via process.kill on the
      // process-group pid. Pinning that we DID try to kill — i.e., reason
      // === 'cancel' is NOT mistakenly routed through the background branch.
      expect(mockProcessKill).toHaveBeenCalledWith(
        -mockPtyProcess.pid,
        'SIGTERM',
      );
    });

    it('signal.reason = { kind: "background" } skips kill and resolves with promoted: true (and aborted: false per design question 7)', async () => {
      const terminalDisposeSpy = vi.spyOn(Terminal.prototype, 'dispose');
      // Critical: do NOT fire onExit — the child is still alive after the
      // background-promote abort. The result Promise must resolve via the
      // abort handler's own immediate resolve, not via the exit handler.
      const { result } = await simulateExecution(
        'tail -f /tmp/never.log',
        (_pty, abortController) => {
          abortController.abort({
            kind: 'background',
            shellId: 'bg_test123',
          } satisfies ShellAbortReason);
        },
      );

      // `aborted: false` (despite signal.aborted = true) is intentional —
      // see #3831 design question 7. The flag answers "emit cancel/timeout
      // copy?" not "did the signal fire?", and a promoted shell is
      // neither cancelled nor timed out.
      expect(result.aborted).toBe(false);
      expect(result.promoted).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBeNull();
      expect(result.error).toBeNull();
      expect(result.pid).toBe(mockPtyProcess.pid);
      // Verify the kill path did NOT run: neither the PTY's own kill() nor
      // process.kill on the group pid. Caller now owns the child.
      expect(mockPtyProcess.kill).not.toHaveBeenCalled();
      expect(mockProcessKill).not.toHaveBeenCalledWith(
        -mockPtyProcess.pid,
        'SIGTERM',
      );
      expect(mockProcessKill).not.toHaveBeenCalledWith(
        -mockPtyProcess.pid,
        'SIGKILL',
      );
      expect(terminalDisposeSpy).toHaveBeenCalled();

      terminalDisposeSpy.mockRestore();
    });

    it('background-promote replay failure falls back to full decoded raw output', async () => {
      mockSerializeTerminalToText.mockImplementationOnce(() => {
        throw new Error('replay failed');
      });
      const output = Array.from(
        { length: 250 },
        (_, index) => `line-${index}`,
      ).join('\n');

      const { result } = await simulateExecution(
        'long-running-output',
        (pty, ac) => {
          pty.onData.mock.calls[0][0](output);
          ac.abort({
            kind: 'background',
            shellId: 'bg_replay_fallback',
          } satisfies ShellAbortReason);
        },
      );

      expect(result.promoted).toBe(true);
      expect(result.output).toContain('line-0');
      expect(result.output).toContain('line-249');
    });

    it('post-promotion: PTY data is no longer routed to onOutputEvent (handoff boundary)', async () => {
      // Pin the ownership contract: after background-promote, PTY data
      // arriving on the still-running child must NOT surface through the
      // foreground execute()'s onOutputEvent (the caller has its own
      // listeners now). Without dataDisposable.dispose() in the abort
      // handler, the listener-retention bug would let post-promote bytes
      // leak into the foreground consumer.
      //
      // Implementation note: PTY's handleOutput is async (`processingChain`
      // queues microtasks for headlessTerminal.write callbacks), unlike
      // child_process's sync handleOutput. Sync `expect` immediately
      // after emit-then-abort would only see the call count BEFORE chain
      // items run — both pre and post would read 0 and the assertion
      // would tautologically pass without exercising the
      // `listenersDetached` guard. We drive the test using the
      // `simulateExecution` helper, which awaits `handle.result` — by
      // the time the result resolves, the abort handler has run its
      // drain (so all queued chain items have settled) and we can read
      // the final emit count.
      const { result } = await simulateExecution(
        'tail -f /tmp/never.log',
        (pty, ac) => {
          // Pre-promote data — fed via the live onData listener so it
          // reaches the foreground onOutputEvent normally.
          pty.onData.mock.calls[0][0]('pre-promote-data\n');
          ac.abort({
            kind: 'background',
            shellId: 'bg_test123',
          } satisfies ShellAbortReason);
        },
      );
      expect(result.promoted).toBe(true);
      // Snapshot the count after promote settled. Pre-promote chain
      // item ran AFTER abort set `listenersDetached = true` (chain
      // items queue at handleOutput time but only execute when their
      // .then microtask runs, which is after the sync abort dispatch
      // that set the flag), so the pre-promote emit was already
      // suppressed by the guard. Asserting `0` here pins both halves
      // of the contract — pre-promote AND post-promote bytes are both
      // suppressed once `listenersDetached` is set. Without the guard,
      // pre-promote's render path would emit a `'data'` event into
      // `onOutputEventMock` and this would be `>= 1`, failing the
      // assertion.
      const eventCountAfterSettle = onOutputEventMock.mock.calls.length;
      expect(eventCountAfterSettle).toBe(0);
      // Drive the data callback again after promote: production-side
      // dataDisposable was disposed, but the mock stub doesn't actually
      // detach the callback (the disposable returned by `vi.fn()` is a
      // no-op). Re-invoking via `mock.calls[0][0]` exercises the
      // production-side `listenersDetached` guard inside the chain
      // callback, which is the real backstop against post-promote
      // bytes leaking to the foreground onOutputEvent.
      mockPtyProcess.onData.mock.calls[0][0]('post-promote-data\n');
      // Wait one macrotask + a microtask flush to let any chain items
      // queued by the post-promote dataCallback fully settle.
      await new Promise((res) => setImmediate(res));
      await new Promise((res) => setImmediate(res));
      expect(onOutputEventMock.mock.calls.length).toBe(eventCountAfterSettle);

      // The disposable returned by mockPtyProcess.onData was disposed by
      // the abort handler — verify by calling .dispose's mock.
      const dataDisposableStub = mockPtyProcess.onData.mock.results[0]
        .value as { dispose: Mock };
      expect(dataDisposableStub.dispose).toHaveBeenCalled();
      const exitDisposableStub = mockPtyProcess.onExit.mock.results[0]
        .value as { dispose: Mock };
      expect(exitDisposableStub.dispose).toHaveBeenCalled();
    });

    it('PR-2.5: post-promote bytes route to postPromote.onData when callback provided', async () => {
      // Pin the new opt-in contract: when `postPromote.onData` is set,
      // bytes the still-running PTY emits after promote go to the
      // caller's handler instead of being lost. PR-2 fully detached
      // listeners; PR-2.5 re-attaches a minimal forwarder when the
      // caller opts in.
      const onDataCalls: ShellOutputEvent[] = [];
      const { result } = await simulateExecution(
        'tail -f /tmp/never.log',
        (pty, ac) => {
          ac.abort({
            kind: 'background',
            shellId: 'bg_pr25_data',
          } satisfies ShellAbortReason);
        },
        shellExecutionConfig,
        {
          postPromote: {
            onData: (event) => onDataCalls.push(event),
          },
        },
      );
      expect(result.promoted).toBe(true);
      // After promote, drive a fresh post-promote chunk through the
      // PTY's onData. The service should have attached a NEW listener
      // (the foreground one is disposed); look at the latest
      // mock.calls entry — index 1 since PR-2.5 adds a second.
      const onDataRegistrations = mockPtyProcess.onData.mock.calls;
      expect(onDataRegistrations.length).toBeGreaterThanOrEqual(2);
      const postPromoteHandler =
        onDataRegistrations[onDataRegistrations.length - 1][0];
      postPromoteHandler('post-promote-byte-stream');
      expect(onDataCalls).toEqual([
        { type: 'data', chunk: 'post-promote-byte-stream' },
      ]);
    });

    it('PR-2.5: postPromote.onSettle fires on natural child exit after promote', async () => {
      // Pin the natural-exit settle: when the child terminates AFTER
      // promote, the caller's onSettle handler is invoked exactly
      // once with the exit code (or signal / error). PR-2 detached
      // the exit listener entirely; PR-2.5 re-attaches a forwarder
      // when the caller opts in.
      const settleCalls: ShellPostPromoteSettleInfo[] = [];
      const { result } = await simulateExecution(
        'long-running-command',
        (pty, ac) => {
          ac.abort({
            kind: 'background',
            shellId: 'bg_pr25_settle',
          } satisfies ShellAbortReason);
        },
        shellExecutionConfig,
        {
          postPromote: {
            onSettle: (info) => settleCalls.push(info),
          },
        },
      );
      expect(result.promoted).toBe(true);
      // After promote, drive the PTY's onExit to simulate natural
      // completion. The service attaches a new exit listener for
      // post-promote settle — find the most-recently-registered.
      const onExitRegistrations = mockPtyProcess.onExit.mock.calls;
      expect(onExitRegistrations.length).toBeGreaterThanOrEqual(2);
      const postPromoteExitHandler =
        onExitRegistrations[onExitRegistrations.length - 1][0];
      postPromoteExitHandler({ exitCode: 0, signal: undefined });
      expect(settleCalls).toHaveLength(1);
      expect(settleCalls[0].exitCode).toBe(0);
      expect(settleCalls[0].signal).toBeNull();
      expect(settleCalls[0].error).toBeUndefined();
      expect(typeof settleCalls[0].endTime).toBe('number');
    });

    it('PR-2.5 wave-2 (C2): unexpected post-promote PTY error routes to onSettle as failure (does NOT crash the CLI)', async () => {
      // Foreground PTY error handler removed at promote handoff. Before
      // the wave-2 fix the post-promote path attached NO error listener,
      // so an unhandled `error` event would take Node down. Now we
      // attach a forwarder: unexpected errors flow through onSettle
      // with `error` populated; expected PTY read-exit errors
      // (EIO / EAGAIN) are filtered.
      const settleCalls: ShellPostPromoteSettleInfo[] = [];
      const { result } = await simulateExecution(
        'long-running-with-error',
        (pty, ac) => {
          ac.abort({
            kind: 'background',
            shellId: 'bg_pr25_pty_err',
          } satisfies ShellAbortReason);
        },
        shellExecutionConfig,
        {
          postPromote: {
            onSettle: (info) => settleCalls.push(info),
          },
        },
      );
      expect(result.promoted).toBe(true);

      // 1. An expected PTY read-exit error (EIO) is FILTERED — onSettle
      //    is NOT invoked yet (the upcoming onExit will carry status).
      mockPtyProcess.emit(
        'error',
        Object.assign(new Error('read EIO'), { code: 'EIO' }),
      );
      expect(settleCalls).toHaveLength(0);

      // 2. An UNEXPECTED error (EPIPE) routes to onSettle as a failure.
      //    Critically: emitting must NOT throw (no unhandled `error`).
      const unexpectedErr = Object.assign(new Error('disk gone'), {
        code: 'EPIPE',
      });
      expect(() => mockPtyProcess.emit('error', unexpectedErr)).not.toThrow();
      expect(settleCalls).toHaveLength(1);
      expect(settleCalls[0].error).toBe(unexpectedErr);
      expect(settleCalls[0].exitCode).toBeNull();
      expect(settleCalls[0].signal).toBeNull();
      expect(typeof settleCalls[0].endTime).toBe('number');

      // 3. A subsequent onExit MUST NOT fire onSettle again (single-fire
      //    latch): callers like the registry's `complete`/`fail`
      //    transitions are not idempotent across status types.
      const onExitRegistrations = mockPtyProcess.onExit.mock.calls;
      const postPromoteExitHandler =
        onExitRegistrations[onExitRegistrations.length - 1][0];
      postPromoteExitHandler({ exitCode: 0, signal: undefined });
      expect(settleCalls).toHaveLength(1);
    });

    it('PR-2.5 wave-3 (T6): post-promote IDisposables and error listener are released on settle (no GC roots dangling)', async () => {
      // Each promoted PTY child can sit dead for milliseconds while
      // the caller's `cancelChild` finalizes. Node's EventEmitter
      // holds refs to listener closures, which in turn hold refs to
      // `onPostData` / `onPostSettle` / the caller's
      // `promoteArtifacts`. Without disposal on settle, those refs
      // dangle until the PTY itself is collected. The fix captures
      // the IDisposables returned by `onData` / `onExit` AND the
      // `'error'` listener function we registered on the EE, then
      // releases them when `firePostSettle` fires (no matter which
      // path triggers settle).
      const removeListenerSpy = vi.spyOn(mockPtyProcess, 'removeListener');

      const settleCalls: ShellPostPromoteSettleInfo[] = [];
      const { result } = await simulateExecution(
        'long-running-disposable',
        (pty, ac) => {
          ac.abort({
            kind: 'background',
            shellId: 'bg_pr25_dispose',
          } satisfies ShellAbortReason);
        },
        shellExecutionConfig,
        {
          postPromote: {
            onData: () => {},
            onSettle: (info) => settleCalls.push(info),
          },
        },
      );
      expect(result.promoted).toBe(true);

      // The mocked `mockReturnValue({ dispose: vi.fn() })` reuses the
      // SAME disposable object across calls, so foreground +
      // post-promote share the same dispose Mock. The foreground
      // disposable was already disposed at promote handoff; clear
      // the call history so we can assert ONLY on post-settle
      // disposal.
      const sharedDataDisposable = mockPtyProcess.onData.mock.results[0]
        .value as { dispose: Mock };
      const sharedExitDisposable = mockPtyProcess.onExit.mock.results[0]
        .value as { dispose: Mock };
      sharedDataDisposable.dispose.mockClear();
      sharedExitDisposable.dispose.mockClear();
      removeListenerSpy.mockClear();

      // Drive onExit → firePostSettle runs disposePostPromoteListeners.
      const onExitRegistrations = mockPtyProcess.onExit.mock.calls;
      const postPromoteExitHandler =
        onExitRegistrations[onExitRegistrations.length - 1][0];
      postPromoteExitHandler({ exitCode: 0, signal: undefined });

      expect(settleCalls).toHaveLength(1);
      // Post-settle: BOTH disposables released, error listener removed.
      expect(sharedDataDisposable.dispose).toHaveBeenCalledTimes(1);
      expect(sharedExitDisposable.dispose).toHaveBeenCalledTimes(1);
      // The post-promote error listener was attached via
      // `ptyProcess.on('error', listener)` and is released via
      // `removeListener('error', listener)`. Verify removeListener
      // was called on the 'error' channel.
      const errorRemoves = removeListenerSpy.mock.calls.filter(
        (args: unknown[]) => args[0] === 'error',
      );
      expect(errorRemoves.length).toBeGreaterThanOrEqual(1);

      // Re-driving onExit must NOT re-fire settle (latched) AND
      // dispose calls must NOT double-count (idempotent disposal —
      // disposePostPromoteListeners nulls the slots after first
      // disposal).
      postPromoteExitHandler({ exitCode: 0, signal: undefined });
      expect(settleCalls).toHaveLength(1);
      expect(sharedDataDisposable.dispose).toHaveBeenCalledTimes(1);
      expect(sharedExitDisposable.dispose).toHaveBeenCalledTimes(1);

      removeListenerSpy.mockRestore();
    });

    it('PR-2.5: onData-only PTY caller has post-promote error + exit listeners (no crash, listeners disposed on exit)', async () => {
      const dataChunks: ShellOutputEvent[] = [];
      const { result } = await simulateExecution(
        'tail -f /dev/null',
        (pty, ac) => {
          ac.abort({
            kind: 'background',
            shellId: 'bg_pty_ondata_only',
          } satisfies ShellAbortReason);
        },
        shellExecutionConfig,
        {
          postPromote: {
            onData: (event) => dataChunks.push(event),
          },
        },
      );
      expect(result.promoted).toBe(true);

      // Error listener must be installed even without onSettle —
      // emitting 'error' on an EventEmitter with no listener throws.
      expect(() =>
        mockPtyProcess.emit('error', new Error('post-promote pty err')),
      ).not.toThrow();

      // onExit must also be installed so disposePostPromoteListeners
      // runs on natural exit (cleaning up data + error listeners).
      const onExitRegistrations = mockPtyProcess.onExit.mock.calls;
      expect(onExitRegistrations.length).toBeGreaterThanOrEqual(2);
      const postPromoteExitHandler =
        onExitRegistrations[onExitRegistrations.length - 1][0];

      // Simulate natural exit — should dispose listeners without crash.
      postPromoteExitHandler({ exitCode: 0 });
    });

    it('PR-2.5 backwards compat: without postPromote, listeners stay fully detached (no regression on PR-2 contract)', async () => {
      // Pin that omitting `postPromote` preserves the PR-2 detach-
      // everything contract. The pre-existing post-promote test at
      // line ~680 already covers this for the data path; this one
      // adds the symmetric guarantee for the exit path — natural
      // post-promote exit must NOT invoke any callback the caller
      // didn't provide.
      const onDataCalls: ShellOutputEvent[] = [];
      const onSettleCalls: ShellPostPromoteSettleInfo[] = [];
      const { result } = await simulateExecution(
        'no-post-promote-handlers',
        (pty, ac) => {
          ac.abort({
            kind: 'background',
            shellId: 'bg_pr25_compat',
          } satisfies ShellAbortReason);
        },
        // No options arg → postPromote unset → PR-2 contract.
      );
      expect(result.promoted).toBe(true);
      // Drive both PTY events post-promote.
      const onDataRegistrations = mockPtyProcess.onData.mock.calls;
      // PR-2 contract: only ONE onData registration (the foreground
      // one, now disposed). PR-2.5's re-attach is gated on
      // `postPromote.onData` being set, so without it the
      // registration count stays at 1.
      expect(onDataRegistrations.length).toBe(1);
      const onExitRegistrations = mockPtyProcess.onExit.mock.calls;
      expect(onExitRegistrations.length).toBe(1);
      // Caller-provided handlers were never invoked.
      expect(onDataCalls).toHaveLength(0);
      expect(onSettleCalls).toHaveLength(0);
    });

    it('post-exit race: PTY background-promote refuses if process.kill(pid, 0) reports the pid is gone', async () => {
      // Mirror of the child_process post-exit race test. The PTY may
      // have already exited but our `exitDisposable` (onExit) handler
      // hasn't run yet — node-pty delivers the exit event async after
      // the native SIGCHLD. Promoting in that window would detach our
      // exit listener, miss the real exit status, and report
      // `promoted: true` for a dead PTY. Production guard:
      // process.kill(pid, 0); if it throws ESRCH, fall through.
      mockProcessKill.mockImplementationOnce((pid, signal) => {
        // Only fail the very first liveness probe with signal 0 — let
        // any subsequent kill calls (e.g. cleanup() at process exit)
        // succeed so the test teardown stays clean.
        if (signal === 0) {
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        }
        return true;
      });
      const { result } = await simulateExecution(
        'fast-and-cancelled',
        (pty, abortController) => {
          abortController.abort({
            kind: 'background',
            shellId: 'bg_test123',
          } satisfies ShellAbortReason);
          // Drain the pending onExit (production code falls through;
          // normal exit path resolves with the real exit info).
          pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: undefined });
        },
      );

      // Result is the normal exit shape, not the promoted shape.
      expect(result.promoted).toBeUndefined();
      expect(result.exitCode).toBe(0);
      // Our PTY listeners stayed registered — the disposables are
      // disposed by the natural onExit, not the abort handler.
      const dataDisposableStub = mockPtyProcess.onData.mock.results[0]
        .value as { dispose: Mock };
      // dataDisposable is NOT disposed by our abort handler in the
      // race-fallthrough path (the normal onExit handler doesn't
      // dispose it either — it relies on the PTY tearing down its own
      // event source). What matters is that we did NOT pre-dispose it
      // and lose the exit info.
      void dataDisposableStub; // referenced for the future expansion
    });

    it("post-promotion: ptyProcess error listener is removed via 'removeListener', NOT 'off' (regression guard for @lydell/node-pty)", async () => {
      // node EventEmitter exposes both `off` (Node 10+) and the legacy
      // `removeListener`, but @lydell/node-pty's IPty interface only
      // surfaces `removeListener` — calling `.off(...)` on a real PTY
      // throws TypeError. Pin that the production code path uses
      // `removeListener` so a future refactor swapping to `.off()`
      // doesn't silently regress under the EventEmitter mock (which
      // tolerates both).
      const removeListenerSpy = vi.spyOn(mockPtyProcess, 'removeListener');
      const offSpy = vi.spyOn(mockPtyProcess, 'off');

      const { result } = await simulateExecution(
        'tail -f /tmp/never.log',
        (_pty, abortController) => {
          abortController.abort({
            kind: 'background',
            shellId: 'bg_test123',
          } satisfies ShellAbortReason);
        },
      );

      expect(result.promoted).toBe(true);
      // The 'error' handler is removed via legacy API; `.off` must not
      // appear in the production teardown path.
      expect(removeListenerSpy).toHaveBeenCalledWith(
        'error',
        expect.any(Function),
      );
      const offErrorCalls = offSpy.mock.calls.filter(
        ([event]) => event === 'error',
      );
      expect(offErrorCalls).toEqual([]);
    });

    it('post-promotion: PTY exit does NOT re-resolve the result (already resolved with promoted)', async () => {
      // Pin: even if the still-running child later exits naturally and the
      // caller's own exit listener fires, our foreground result Promise
      // must NOT be re-resolved with a different shape (Promise can only
      // resolve once). The exit disposable being disposed prevents our
      // own onExit from firing at all in the first place — but verify the
      // final resolved shape stays `promoted: true` regardless.
      const { result } = await simulateExecution(
        'tail -f /tmp/never.log',
        (_pty, abortController) => {
          abortController.abort({
            kind: 'background',
            shellId: 'bg_test123',
          } satisfies ShellAbortReason);
        },
      );

      // Resolved as promoted, with no exit info from a post-promote exit.
      expect(result.promoted).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBeNull();
    });
  });

  describe('Binary Output', () => {
    it('should detect binary output and switch to progress events', async () => {
      mockIsBinary.mockReturnValueOnce(true);
      const binaryChunk1 = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const binaryChunk2 = Buffer.from([0x0d, 0x0a, 0x1a, 0x0a]);

      const { result } = await simulateExecution('cat image.png', (pty) => {
        pty.onData.mock.calls[0][0](binaryChunk1);
        pty.onData.mock.calls[0][0](binaryChunk2);
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      expect(result.rawOutput).toEqual(
        Buffer.concat([binaryChunk1, binaryChunk2]),
      );
      expect(onOutputEventMock).toHaveBeenCalledTimes(3);
      expect(onOutputEventMock.mock.calls[0][0]).toEqual({
        type: 'binary_detected',
      });
      expect(onOutputEventMock.mock.calls[1][0]).toEqual({
        type: 'binary_progress',
        bytesReceived: 4,
      });
      expect(onOutputEventMock.mock.calls[2][0]).toEqual({
        type: 'binary_progress',
        bytesReceived: 8,
      });
    });

    it('should not emit data events after binary is detected', async () => {
      mockIsBinary.mockImplementation((buffer) => buffer.includes(0x00));

      await simulateExecution('cat mixed_file', (pty) => {
        pty.onData.mock.calls[0][0](Buffer.from([0x00, 0x01, 0x02]));
        pty.onData.mock.calls[0][0](Buffer.from('more text'));
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      const eventTypes = onOutputEventMock.mock.calls.map(
        (call: [ShellOutputEvent]) => call[0].type,
      );
      expect(eventTypes).toEqual([
        'binary_detected',
        'binary_progress',
        'binary_progress',
      ]);
    });
  });

  describe('Platform-Specific Behavior', () => {
    it('should use cmd.exe on Windows', async () => {
      mockPlatform.mockReturnValue('win32');
      mockGetShellConfiguration.mockReturnValue({
        executable: 'cmd.exe',
        argsPrefix: ['/d', '/s', '/c'],
        shell: 'cmd',
      });
      await simulateExecution('dir "foo bar"', (pty) =>
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null }),
      );

      expect(mockPtySpawn).toHaveBeenCalledWith(
        'cmd.exe',
        '/d /s /c dir "foo bar"',
        expect.any(Object),
      );
      mockGetShellConfiguration.mockReturnValue({
        executable: 'bash',
        argsPrefix: ['-c'],
        shell: 'bash',
      });
    });

    it('should use PowerShell on Windows with array args and UTF-8 prefix', async () => {
      mockPlatform.mockReturnValue('win32');
      mockGetShellConfiguration.mockReturnValue({
        executable: 'powershell.exe',
        argsPrefix: ['-NoProfile', '-Command'],
        shell: 'powershell',
      });
      await simulateExecution('Test-Path "C:\\Temp\\"', (pty) =>
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null }),
      );

      // PowerShell commands on Windows are prefixed with UTF-8 output encoding
      expect(mockPtySpawn).toHaveBeenCalledWith(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Test-Path "C:\\Temp\\"',
        ],
        expect.any(Object),
      );
      mockGetShellConfiguration.mockReturnValue({
        executable: 'bash',
        argsPrefix: ['-c'],
        shell: 'bash',
      });
    });

    it('should normalize PATH-like env keys on Windows for pty execution', async () => {
      mockPlatform.mockReturnValue('win32');
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      setupConflictingPathEnv();

      await simulateExecution('dir', (pty) =>
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null }),
      );

      const spawnOptions = mockPtySpawn.mock.calls[0][2];
      expectNormalizedWindowsPathEnv(spawnOptions.env);
    });

    it('should use bash on Linux', async () => {
      mockPlatform.mockReturnValue('linux');
      await simulateExecution('ls "foo bar"', (pty) =>
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null }),
      );

      expect(mockPtySpawn).toHaveBeenCalledWith(
        'bash',
        ['-c', 'ls "foo bar"'],
        expect.any(Object),
      );
    });
  });

  describe('AnsiOutput rendering', () => {
    it('should call onOutputEvent with AnsiOutput when showColor is true', async () => {
      const coloredShellExecutionConfig = {
        ...shellExecutionConfig,
        showColor: true,
        defaultFg: '#ffffff',
        defaultBg: '#000000',
        disableDynamicLineTrimming: true,
      };
      const mockAnsiOutput = [
        [{ text: 'hello', fg: '#ffffff', bg: '#000000' }],
      ];
      mockSerializeTerminalToObject.mockReturnValue(mockAnsiOutput);

      await simulateExecution(
        'ls --color=auto',
        (pty) => {
          pty.onData.mock.calls[0][0]('a\u001b[31mred\u001b[0mword');
          pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
        },
        coloredShellExecutionConfig,
      );

      expect(mockSerializeTerminalToObject).toHaveBeenCalledWith(
        expect.anything(), // The terminal object
      );

      expect(onOutputEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'data',
          chunk: mockAnsiOutput,
        }),
      );
    });

    it('does not re-emit live output when only soft-wrap segmentation changes', async () => {
      const coloredShellExecutionConfig = {
        ...shellExecutionConfig,
        showColor: true,
        disableDynamicLineTrimming: true,
      };
      const firstWrappedOutput = [
        [createAnsiToken('abcd')],
        [createAnsiToken('efgh')],
      ];
      const rewrappedOutput = [
        [createAnsiToken('ab')],
        [createAnsiToken('cdef')],
        [createAnsiToken('gh')],
      ];
      const logicalOutput = [[createAnsiToken('abcdefgh')]];
      let rawRenderCount = 0;

      mockSerializeTerminalToObject.mockImplementation(
        (
          _terminal,
          _scrollOffset,
          options?: { unwrapWrappedLines?: boolean },
        ) => {
          if (options?.unwrapWrappedLines) {
            return logicalOutput;
          }

          rawRenderCount += 1;
          return rawRenderCount === 1 ? firstWrappedOutput : rewrappedOutput;
        },
      );

      await simulateExecution(
        'narrow-output',
        (pty) => {
          pty.onData.mock.calls[0][0]('abcdefgh');
          pty.onData.mock.calls[0][0]('\r');
          pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
        },
        coloredShellExecutionConfig,
      );

      const dataEvents = onOutputEventMock.mock.calls.filter(
        ([event]) => event.type === 'data',
      );
      expect(dataEvents).toHaveLength(1);
      expect(dataEvents[0][0]).toEqual({
        type: 'data',
        chunk: firstWrappedOutput,
      });
    });

    it('should call onOutputEvent with AnsiOutput when showColor is false', async () => {
      await simulateExecution(
        'ls --color=auto',
        (pty) => {
          pty.onData.mock.calls[0][0]('a\u001b[31mred\u001b[0mword');
          pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
        },
        {
          ...shellExecutionConfig,
          showColor: false,
          disableDynamicLineTrimming: true,
        },
      );

      const expected = createExpectedAnsiOutput('aredword');

      expect(onOutputEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'data',
          chunk: expected,
        }),
      );
    });

    it('does not re-emit default plain live output when only soft-wrap segmentation changes', async () => {
      const abortController = new AbortController();
      const handle = await ShellExecutionService.execute(
        'narrow-output',
        '/test/dir',
        onOutputEventMock,
        abortController.signal,
        true,
        {
          ...shellExecutionConfig,
          terminalWidth: 4,
          terminalHeight: 4,
          showColor: false,
          disableDynamicLineTrimming: false,
        },
      );

      await new Promise((resolve) => process.nextTick(resolve));
      mockPtyProcess.onData.mock.calls[0][0]('abcdefgh');
      await waitForDataEventCount(onOutputEventMock, 1);

      ShellExecutionService.resizePty(handle.pid!, 2, 4);
      mockPtyProcess.onData.mock.calls[0][0]('\r');
      mockPtyProcess.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      await handle.result;

      const dataEvents = onOutputEventMock.mock.calls.filter(
        ([event]) => event.type === 'data',
      );
      expect(dataEvents).toHaveLength(1);
      const firstDataEvent = dataEvents[0][0];
      if (firstDataEvent.type !== 'data') {
        throw new Error('Expected a shell data event.');
      }
      const chunk = firstDataEvent.chunk as AnsiOutput;
      expect(chunk.map((line) => line[0]?.text).filter(Boolean)).toEqual([
        'abcd',
        'efgh',
      ]);
    });

    it('should handle multi-line output correctly when showColor is false', async () => {
      await simulateExecution(
        'ls --color=auto',
        (pty) => {
          pty.onData.mock.calls[0][0](
            'line 1\n\u001b[32mline 2\u001b[0m\nline 3',
          );
          pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
        },
        {
          ...shellExecutionConfig,
          showColor: false,
          disableDynamicLineTrimming: true,
        },
      );

      const expected = createExpectedAnsiOutput(['line 1', 'line 2', 'line 3']);

      expect(onOutputEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'data',
          chunk: expected,
        }),
      );
    });
  });
});

describe('ShellExecutionService child_process fallback', () => {
  let mockChildProcess: EventEmitter & Partial<ChildProcess>;
  let onOutputEventMock: Mock<(event: ShellOutputEvent) => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalProcessEnv = process.env;

    mockIsBinary.mockReturnValue(false);
    mockPlatform.mockReturnValue('linux');
    mockGetPty.mockResolvedValue(null);

    onOutputEventMock = vi.fn();

    mockChildProcess = new EventEmitter() as EventEmitter &
      Partial<ChildProcess>;
    mockChildProcess.stdout = new EventEmitter() as Readable;
    mockChildProcess.stderr = new EventEmitter() as Readable;
    mockChildProcess.kill = vi.fn();

    Object.defineProperty(mockChildProcess, 'pid', {
      value: 12345,
      configurable: true,
    });
    // Mirror real Node ChildProcess: `exitCode` / `signalCode` are `null`
    // while the child is alive and become a number / signal name on
    // exit. The background-promote liveness guard reads these to detect
    // an exit that fired between abort dispatch and the abort handler
    // run, and a default of `undefined` would mistakenly look terminal
    // and skip the promote.
    Object.defineProperty(mockChildProcess, 'exitCode', {
      value: null,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(mockChildProcess, 'signalCode', {
      value: null,
      writable: true,
      configurable: true,
    });

    mockCpSpawn.mockReturnValue(mockChildProcess);
  });

  afterEach(() => {
    process.env = originalProcessEnv;
    vi.unstubAllEnvs();
  });

  // Helper function to run a standard execution simulation
  const simulateExecution = async (
    command: string,
    simulation: (cp: typeof mockChildProcess, ac: AbortController) => void,
    options: ShellExecuteOptions = {},
  ) => {
    const abortController = new AbortController();
    const handle = await ShellExecutionService.execute(
      command,
      '/test/dir',
      onOutputEventMock,
      abortController.signal,
      true,
      shellExecutionConfig,
      options,
    );

    await new Promise((resolve) => process.nextTick(resolve));
    simulation(mockChildProcess, abortController);
    const result = await handle.result;
    return { result, handle, abortController };
  };

  const simulateExecutionWithConfig = async (
    command: string,
    simulation: (cp: typeof mockChildProcess, ac: AbortController) => void,
    config: ShellExecutionConfig,
    options: ShellExecuteOptions = {},
  ) => {
    const abortController = new AbortController();
    const handle = await ShellExecutionService.execute(
      command,
      '/test/dir',
      onOutputEventMock,
      abortController.signal,
      true,
      config,
      options,
    );

    await new Promise((resolve) => process.nextTick(resolve));
    simulation(mockChildProcess, abortController);
    const result = await handle.result;
    return { result, handle, abortController };
  };

  describe('Successful Execution', () => {
    it('should execute a command and capture stdout and stderr', async () => {
      const { result, handle } = await simulateExecution('ls -l', (cp) => {
        cp.stdout?.emit('data', Buffer.from('file1.txt\n'));
        cp.stderr?.emit('data', Buffer.from('a warning'));
        cp.emit('exit', 0, null);
        cp.emit('close', 0, null);
      });

      expect(mockCpSpawn).toHaveBeenCalledWith(
        'bash',
        ['-c', 'ls -l'],
        expect.objectContaining({
          detached: true,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.error).toBeNull();
      expect(result.aborted).toBe(false);
      expect(result.output).toBe('file1.txt\na warning');
      expect(handle.pid).toBe(12345);

      expect(onOutputEventMock).toHaveBeenCalledWith({
        type: 'data',
        chunk: 'file1.txt\na warning',
      });
    });

    it('should strip ANSI codes from output', async () => {
      const { result } = await simulateExecution('ls --color=auto', (cp) => {
        cp.stdout?.emit('data', Buffer.from('a\u001b[31mred\u001b[0mword'));
        cp.emit('exit', 0, null);
        cp.emit('close', 0, null);
      });

      expect(result.output.trim()).toBe('aredword');
      expect(onOutputEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'data',
          chunk: 'aredword',
        }),
      );
    });

    it('should correctly decode multi-byte characters split across chunks', async () => {
      const { result } = await simulateExecution('echo "你好"', (cp) => {
        const multiByteChar = Buffer.from('你好', 'utf-8');
        cp.stdout?.emit('data', multiByteChar.slice(0, 2));
        cp.stdout?.emit('data', multiByteChar.slice(2));
        cp.emit('exit', 0, null);
        cp.emit('close', 0, null);
      });
      expect(result.output.trim()).toBe('你好');
    });

    it('bounds buffered child_process output before building the final string', async () => {
      const abortController = new AbortController();
      const handle = await ShellExecutionService.execute(
        'large-output',
        '/test/dir',
        onOutputEventMock,
        abortController.signal,
        false,
        { ...shellExecutionConfig, maxBufferedOutputBytes: 10 },
      );

      await new Promise((resolve) => process.nextTick(resolve));
      mockChildProcess.stdout?.emit('data', Buffer.from('12345678'));
      mockChildProcess.stdout?.emit('data', Buffer.from('abcdefg'));
      mockChildProcess.emit('exit', 0, null);
      mockChildProcess.emit('close', 0, null);

      const result = await handle.result;

      expect(result.rawOutput.length).toBe(10);
      expect(result.output).toContain('12345678ab');
      expect(result.output).toContain(
        'Output exceeded the maximum captured size',
      );
      expect(result.output).not.toContain('cdefg');
      expect(onOutputEventMock).toHaveBeenCalledWith({
        type: 'data',
        chunk: expect.stringContaining(
          'Output exceeded the maximum captured size',
        ),
      });
    });

    it('does not add a capture-limit notice at the exact child_process buffer boundary', async () => {
      const { result } = await simulateExecutionWithConfig(
        'exact-output',
        (cp) => {
          cp.stdout?.emit('data', Buffer.from('1234567890'));
          cp.emit('exit', 0, null);
          cp.emit('close', 0, null);
        },
        { ...shellExecutionConfig, maxBufferedOutputBytes: 10 },
      );

      expect(result.rawOutput.length).toBe(10);
      expect(result.output).toBe('1234567890');
      expect(result.output).not.toContain(
        'Output exceeded the maximum captured size',
      );
    });

    it.each([
      0,
      0.5,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      'abc',
      undefined,
    ])(
      'falls back to the default capture limit for invalid maxBufferedOutputBytes: %s',
      async (configuredValue) => {
        const { result } = await simulateExecutionWithConfig(
          'invalid-limit',
          (cp) => {
            cp.stdout?.emit('data', Buffer.from('1234567890abcde'));
            cp.emit('exit', 0, null);
            cp.emit('close', 0, null);
          },
          {
            ...shellExecutionConfig,
            maxBufferedOutputBytes: configuredValue as unknown as number,
          },
        );

        expect(result.rawOutput.length).toBe(15);
        expect(result.output).toBe('1234567890abcde');
        expect(result.output).not.toContain(
          'Output exceeded the maximum captured size',
        );
      },
    );

    it('reports capture-limit notice for streaming child_process output', async () => {
      const { result } = await simulateExecutionWithConfig(
        'streaming-large-output',
        (cp) => {
          cp.stdout?.emit('data', Buffer.from('abcdef'));
          cp.emit('exit', 0, null);
          cp.emit('close', 0, null);
        },
        { ...shellExecutionConfig, maxBufferedOutputBytes: 1 },
        { streamStdout: true },
      );

      expect(onOutputEventMock).toHaveBeenCalledWith({
        type: 'data',
        chunk: 'abcdef',
      });
      expect(result.rawOutput.length).toBe(1);
      expect(result.output).toContain(
        'Output exceeded the maximum captured size',
      );
    });

    it('emits only the capture-limit notice when stripped captured output is empty', async () => {
      const { result } = await simulateExecutionWithConfig(
        'empty-captured-output',
        (cp) => {
          cp.stdout?.emit('data', Buffer.from('\nabc'));
          cp.emit('exit', 0, null);
          cp.emit('close', 0, null);
        },
        { ...shellExecutionConfig, maxBufferedOutputBytes: 1 },
      );

      expect(result.rawOutput.length).toBe(1);
      expect(result.output).toMatch(
        /^\[Output exceeded the maximum captured size/,
      );
    });

    it('should handle commands with no output', async () => {
      const { result } = await simulateExecution('touch file', (cp) => {
        cp.emit('exit', 0, null);
        cp.emit('close', 0, null);
      });

      expect(result.output.trim()).toBe('');
      expect(onOutputEventMock).not.toHaveBeenCalled();
    });
  });

  describe('Failed Execution', () => {
    it('should capture a non-zero exit code and format output correctly', async () => {
      const { result } = await simulateExecution('a-bad-command', (cp) => {
        cp.stderr?.emit('data', Buffer.from('command not found'));
        cp.emit('exit', 127, null);
        cp.emit('close', 127, null);
      });

      expect(result.exitCode).toBe(127);
      expect(result.output.trim()).toBe('command not found');
      expect(result.error).toBeNull();
    });

    it('should capture a termination signal', async () => {
      const { result } = await simulateExecution('long-process', (cp) => {
        cp.emit('exit', null, 'SIGTERM');
        cp.emit('close', null, 'SIGTERM');
      });

      expect(result.exitCode).toBeNull();
      expect(result.signal).toBe(15);
    });

    it('should handle a spawn error', async () => {
      const spawnError = new Error('spawn EACCES');
      const { result } = await simulateExecution('protected-cmd', (cp) => {
        cp.emit('error', spawnError);
        cp.emit('exit', 1, null);
        cp.emit('close', 1, null);
      });

      expect(result.error).toBe(spawnError);
      expect(result.exitCode).toBe(1);
    });

    it('handles errors that do not fire the exit event', async () => {
      const error = new Error('spawn abc ENOENT');
      const { result } = await simulateExecution('touch cat.jpg', (cp) => {
        cp.emit('error', error); // No exit event is fired.
        cp.emit('close', 1, null);
      });

      expect(result.error).toBe(error);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('Aborting Commands', () => {
    describe.each([
      {
        platform: 'linux',
        expectedSignal: 'SIGTERM',
        expectedExit: { signal: 'SIGKILL' as const },
      },
      {
        platform: 'win32',
        expectedCommand: 'taskkill',
        expectedExit: { code: 1 },
      },
    ])(
      'on $platform',
      ({ platform, expectedSignal, expectedCommand, expectedExit }) => {
        it('should abort a running process and set the aborted flag', async () => {
          mockPlatform.mockReturnValue(platform);

          const { result } = await simulateExecution(
            'sleep 10',
            (cp, abortController) => {
              abortController.abort();
              if (expectedExit.signal) {
                cp.emit('exit', null, expectedExit.signal);
                cp.emit('close', null, expectedExit.signal);
              }
              if (typeof expectedExit.code === 'number') {
                cp.emit('exit', expectedExit.code, null);
                cp.emit('close', expectedExit.code, null);
              }
            },
          );

          expect(result.aborted).toBe(true);

          if (platform === 'linux') {
            expect(mockProcessKill).toHaveBeenCalledWith(
              -mockChildProcess.pid!,
              expectedSignal,
            );
          } else {
            expect(mockCpSpawn).toHaveBeenCalledWith(expectedCommand, [
              '/pid',
              String(mockChildProcess.pid),
              '/f',
              '/t',
            ]);
          }
        });
      },
    );

    it('signal.reason = { kind: "cancel" } still tree-kills (same as default)', async () => {
      mockPlatform.mockReturnValue('linux');
      const { result } = await simulateExecution(
        'sleep 10',
        (cp, abortController) => {
          abortController.abort({ kind: 'cancel' } satisfies ShellAbortReason);
          cp.emit('exit', null, 'SIGKILL');
          cp.emit('close', null, 'SIGKILL');
        },
      );

      expect(result.aborted).toBe(true);
      expect(result.promoted).toBeUndefined();
      // Default kill path ran — pin that reason === 'cancel' is NOT
      // mistakenly routed through the background branch.
      expect(mockProcessKill).toHaveBeenCalledWith(
        -mockChildProcess.pid!,
        'SIGTERM',
      );
    });

    it('signal.reason = { kind: "background" } skips kill and resolves with promoted: true (and aborted: false per design question 7)', async () => {
      mockPlatform.mockReturnValue('linux');
      // Critical: do NOT fire 'exit' — the child is still alive after the
      // background-promote abort. The result Promise must resolve via the
      // abort handler's own immediate resolve.
      const { result } = await simulateExecution(
        'tail -f /tmp/never.log',
        (cp, abortController) => {
          // Emit some output first so the snapshot has content.
          cp.stdout?.emit('data', Buffer.from('line1\nline2\n'));
          abortController.abort({
            kind: 'background',
            shellId: 'bg_test123',
          } satisfies ShellAbortReason);
        },
      );

      // See PTY equivalent test for the rationale on `aborted: false`.
      expect(result.aborted).toBe(false);
      expect(result.promoted).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBeNull();
      expect(result.error).toBeNull();
      expect(result.pid).toBe(mockChildProcess.pid);
      // Output captured up to the promote moment is preserved as the
      // snapshot for the caller to seed the BackgroundShellEntry's output
      // file from.
      expect(result.output).toContain('line1');
      expect(result.output).toContain('line2');
      // Verify the kill path did NOT run.
      expect(mockProcessKill).not.toHaveBeenCalledWith(
        -mockChildProcess.pid!,
        'SIGTERM',
      );
      expect(mockProcessKill).not.toHaveBeenCalledWith(
        -mockChildProcess.pid!,
        'SIGKILL',
      );
      expect(mockChildProcess.kill).not.toHaveBeenCalled();
    });

    it('post-promotion: stdout / stderr data is no longer routed to onOutputEvent (handoff boundary)', async () => {
      mockPlatform.mockReturnValue('linux');
      // Pin the ownership contract: after background-promote, stdout/stderr
      // arriving on the still-running child must NOT surface through the
      // foreground execute()'s onOutputEvent. Without off()'ing the
      // stdoutHandler / stderrHandler in the abort handler, post-promote
      // bytes would re-enter handleOutput, which then calls
      // decoder.decode() on a now-finalized decoder (cleanup() called
      // .decode() without stream:true) → TypeError crash, OR routes to
      // onOutputEvent → ownership leak / duplicated emit.
      const { result } = await simulateExecution(
        'tail -f /tmp/never.log',
        (cp, abortController) => {
          cp.stdout?.emit('data', Buffer.from('pre-promote\n'));
          abortController.abort({
            kind: 'background',
            shellId: 'bg_test123',
          } satisfies ShellAbortReason);
          // Capture call count at the moment of promote, then emit more
          // data on the still-live child stream and assert onOutputEvent
          // was NOT called again. (Also verifies no TypeError from
          // decoding through the finalized decoder.)
          const eventCountAtPromote = onOutputEventMock.mock.calls.length;
          cp.stdout?.emit('data', Buffer.from('post-promote-stdout\n'));
          cp.stderr?.emit('data', Buffer.from('post-promote-stderr\n'));
          expect(onOutputEventMock.mock.calls.length).toBe(eventCountAtPromote);
        },
      );

      expect(result.promoted).toBe(true);
      // Pre-promote data made it into the snapshot; post-promote did not.
      expect(result.output).toContain('pre-promote');
      expect(result.output).not.toContain('post-promote-stdout');
      expect(result.output).not.toContain('post-promote-stderr');
    });

    it('post-exit race: background-promote refuses if child is already terminal (exitCode/signalCode non-null)', async () => {
      // Race window: the child may have exited (exitCode set) but the
      // 'exit' event hasn't reached our handler yet because Node delivers
      // child_process events on the next microtask. Promoting in that
      // window would detach our exit listener and report `promoted: true`
      // for a process that's already dead — the caller would hold an
      // inert pid expecting to take over. Production code reads
      // exitCode / signalCode before detaching; if either is non-null,
      // it falls through and lets the pending exit handler resolve
      // normally with the real exit info.
      mockPlatform.mockReturnValue('linux');
      const { result } = await simulateExecution(
        'fast-and-cancelled',
        (cp, abortController) => {
          // Simulate the race: pretend the child has already exited
          // (exitCode set on the ChildProcess) but the 'exit' event
          // emit is queued behind the abort dispatch.
          Object.defineProperty(cp, 'exitCode', {
            value: 0,
            writable: true,
            configurable: true,
          });
          abortController.abort({
            kind: 'background',
            shellId: 'bg_test123',
          } satisfies ShellAbortReason);
          // Now drain the pending exit + close events; the normal
          // exit path should resolve the result.
          cp.emit('exit', 0, null);
          cp.emit('close', 0, null);
        },
      );

      // Result is the normal exit shape, not the promoted shape.
      expect(result.promoted).toBeUndefined();
      expect(result.aborted).toBe(true); // abortSignal.aborted is still true
      expect(result.exitCode).toBe(0);
    });

    it('post-promotion: child exit does NOT re-resolve the result with a non-promoted shape', async () => {
      mockPlatform.mockReturnValue('linux');
      // Pin: even if the still-running child later exits naturally and the
      // caller's own exit listener fires, our foreground result Promise
      // must NOT be re-resolved (Promise can only resolve once). The
      // detached exit handler prevents our own handler from firing.
      const { result } = await simulateExecution(
        'tail -f /tmp/never.log',
        (cp, abortController) => {
          abortController.abort({
            kind: 'background',
            shellId: 'bg_test123',
          } satisfies ShellAbortReason);
          // Simulate the still-running child exiting later; this should
          // NOT route through our handleExit because the exit listener
          // was off()'d in the background-promote branch.
          cp.emit('exit', 42, null);
          cp.emit('close', 42, null);
        },
      );

      expect(result.promoted).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBeNull();
    });

    it('PR-2.5 child_process: post-promote stdout/stderr forward to postPromote.onData with SEPARATE decoders', async () => {
      // Pin: post-promote bytes from the still-running child route to
      // the caller's onData handler. Separate decoders for stdout vs
      // stderr — a single shared decoder would corrupt interleaved
      // multibyte UTF-8 (the continuation-byte state machine assumes
      // one byte source).
      mockPlatform.mockReturnValue('linux');
      const events: Array<{ type: string; chunk?: string | unknown }> = [];
      const { result } = await simulateExecution(
        'tail -f',
        (cp, ac) => {
          ac.abort({
            kind: 'background',
            shellId: 'bg_cp_data',
          } satisfies ShellAbortReason);
          // Drive post-promote chunks — should now flow to onData.
          cp.stdout?.emit('data', Buffer.from('post-promote-stdout\n'));
          cp.stderr?.emit('data', Buffer.from('post-promote-stderr\n'));
        },
        {
          postPromote: {
            onData: (event) => events.push(event),
          },
        },
      );
      expect(result.promoted).toBe(true);
      // Both streams forwarded.
      const dataChunks = events
        .filter((e) => e.type === 'data')
        .map((e) => e.chunk);
      expect(dataChunks).toContain('post-promote-stdout\n');
      expect(dataChunks).toContain('post-promote-stderr\n');
    });

    it('PR-2.5 child_process: onSettle fires on `close` (NOT `exit`) so late chunks land before the registry transitions', async () => {
      // Pin the `close`-not-`exit` contract: child can emit buffered
      // data AFTER 'exit' but BEFORE 'close'. If onSettle fired on
      // 'exit' the caller would close the output stream + transition
      // the registry while late chunks were still in flight — they'd
      // hit a closed stream and be dropped, producing truncated logs.
      mockPlatform.mockReturnValue('linux');
      const events: Array<{ type: string; chunk?: string | unknown }> = [];
      const settles: ShellPostPromoteSettleInfo[] = [];
      const { result } = await simulateExecution(
        'cmd',
        (cp, ac) => {
          ac.abort({
            kind: 'background',
            shellId: 'bg_cp_close',
          } satisfies ShellAbortReason);
          // Order matters: emit 'exit' first (this would have settled
          // PR-1 of PR-2.5 too early), then a final stdout chunk, then
          // 'close'. With the new contract, onSettle only fires on
          // 'close' so the late chunk is captured.
          cp.emit('exit', 0, null);
          cp.stdout?.emit('data', Buffer.from('late-chunk\n'));
          cp.emit('close', 0, null);
        },
        {
          postPromote: {
            onData: (event) => events.push(event),
            onSettle: (info) => settles.push(info),
          },
        },
      );
      expect(result.promoted).toBe(true);
      // Late chunk made it through.
      const dataChunks = events
        .filter((e) => e.type === 'data')
        .map((e) => e.chunk);
      expect(dataChunks).toContain('late-chunk\n');
      // onSettle fired exactly once with exitCode 0.
      expect(settles).toHaveLength(1);
      expect(settles[0].exitCode).toBe(0);
      expect(settles[0].signal).toBeNull();
    });

    it('PR-2.5 child_process: post-promote spawn error routes to onSettle with error populated', async () => {
      mockPlatform.mockReturnValue('linux');
      const settles: ShellPostPromoteSettleInfo[] = [];
      const { result } = await simulateExecution(
        'cmd',
        (cp, ac) => {
          ac.abort({
            kind: 'background',
            shellId: 'bg_cp_err',
          } satisfies ShellAbortReason);
          cp.emit('error', new Error('post-promote spawn boom'));
        },
        {
          postPromote: {
            onSettle: (info) => settles.push(info),
          },
        },
      );
      expect(result.promoted).toBe(true);
      expect(settles).toHaveLength(1);
      expect(settles[0].error?.message).toBe('post-promote spawn boom');
      expect(settles[0].exitCode).toBeNull();
      expect(settles[0].signal).toBeNull();
    });

    it('PR-2.5 wave-4 (T1): post-promote `error` followed by `close` fires onSettle EXACTLY ONCE', async () => {
      // Regression for the double-fire bug: pre-fix, `child.once('close', ...)`
      // and `child.once('error', ...)` were independent and each invoked
      // `onPostSettle` directly. A spawn-side error followed by the
      // child-process automatic 'close' event would call the caller's
      // settle twice, violating the exactly-once contract and racing
      // the caller's `transitionRegistry`. Fix wraps both branches in
      // a `firePostSettle` latch (mirroring the PTY path).
      mockPlatform.mockReturnValue('linux');
      const settles: ShellPostPromoteSettleInfo[] = [];
      const { result } = await simulateExecution(
        'cmd',
        (cp, ac) => {
          ac.abort({
            kind: 'background',
            shellId: 'bg_cp_double',
          } satisfies ShellAbortReason);
          // First: error fires.
          cp.emit('error', new Error('error first'));
          // Then: close (Node child_process always emits 'close' even
          // after an error). Pre-fix this would call onSettle a second
          // time.
          cp.emit('close', 1, null);
        },
        {
          postPromote: {
            onSettle: (info) => settles.push(info),
          },
        },
      );
      expect(result.promoted).toBe(true);
      expect(settles).toHaveLength(1);
      expect(settles[0].error?.message).toBe('error first');
    });

    it('PR-2.5 wave-4 (T3): onData-only caller still gets decoder flush on close (no trailing multibyte loss)', async () => {
      // T3 regression: the close handler used to be installed only
      // when `onSettle` was set, so an `onData`-only caller never got
      // the trailing-multibyte flush — a UTF-8 character split across
      // chunks could vanish. Fix installs close whenever ANY
      // postPromote handler is set, and the flush helper runs whenever
      // onData is set independent of onSettle.
      mockPlatform.mockReturnValue('linux');
      const dataChunks: ShellOutputEvent[] = [];
      const { result } = await simulateExecution(
        'cmd',
        (cp, ac) => {
          ac.abort({
            kind: 'background',
            shellId: 'bg_cp_t3',
          } satisfies ShellAbortReason);
          // Push the FIRST byte of a 3-byte UTF-8 char (€ = 0xE2 0x82 0xAC).
          // Without flush, the trailing two bytes would be stuck in the
          // decoder's continuation state and lost.
          cp.stdout?.emit('data', Buffer.from([0xe2]));
          cp.stdout?.emit('data', Buffer.from([0x82, 0xac]));
          // Trigger close so the flush runs; no onSettle to gate on.
          cp.emit('close', 0, null);
        },
        {
          postPromote: {
            onData: (event) => dataChunks.push(event),
            // NO onSettle — close handler must still fire flush.
          },
        },
      );
      expect(result.promoted).toBe(true);
      // The € character should appear once the second chunk completes
      // the multibyte sequence; flush at close ensures any remainder
      // is surfaced.
      const joined = dataChunks
        .map((d) =>
          d.type === 'data' && typeof d.chunk === 'string' ? d.chunk : '',
        )
        .join('');
      expect(joined).toContain('€');
    });

    it('PR-2.5 wave-4 (T6): onData-only caller has post-promote `error` listener (does not crash CLI)', async () => {
      // T6 regression: `child.once('error', ...)` install was gated
      // on `onSettle`, so an `onData`-only caller had the foreground
      // errorHandler detached at promote with no replacement — a
      // post-promote spawn error would surface as Node's default
      // unhandled-error crash. Fix attaches an error listener
      // whenever ANY postPromote handler is set.
      mockPlatform.mockReturnValue('linux');
      const dataChunks: ShellOutputEvent[] = [];
      const { result } = await simulateExecution(
        'cmd',
        (cp, ac) => {
          ac.abort({
            kind: 'background',
            shellId: 'bg_cp_t6',
          } satisfies ShellAbortReason);
          // Emitting 'error' on an EventEmitter with no listener throws
          // synchronously. With the fix, our listener is attached so
          // the emit does not throw.
          expect(() =>
            cp.emit('error', new Error('post-promote err')),
          ).not.toThrow();
          // child_process auto-emits 'close' after 'error'.
          cp.emit('close', null, null);
        },
        {
          postPromote: {
            onData: (event) => dataChunks.push(event),
            // NO onSettle — but error must still be handled (no crash).
          },
        },
      );
      expect(result.promoted).toBe(true);
    });

    it('PR-2.5 wave-4 (T7): onSettle-only caller has stdout/stderr resumed (child does not block on full pipes)', async () => {
      // T7 regression: when `onSettle` is set but `onData` is NOT, the
      // post-promote path used to leave stdout/stderr without any data
      // listener. The Readables stay paused; the OS pipe buffer fills
      // (~64KB on Linux); the child blocks on stdout.write; 'close'
      // never fires; onSettle never fires. Fix calls .resume() on
      // both streams in the no-onData branch so the child can drain.
      mockPlatform.mockReturnValue('linux');
      const settles: ShellPostPromoteSettleInfo[] = [];
      const stdoutResumeSpy = vi.fn();
      const stderrResumeSpy = vi.fn();
      const { result } = await simulateExecution(
        'cmd',
        (cp, ac) => {
          // Patch resume() so we can verify the wire was driven.
          if (cp.stdout) cp.stdout.resume = stdoutResumeSpy;
          if (cp.stderr) cp.stderr.resume = stderrResumeSpy;
          ac.abort({
            kind: 'background',
            shellId: 'bg_cp_t7',
          } satisfies ShellAbortReason);
          cp.emit('close', 0, null);
        },
        {
          postPromote: {
            // NO onData — but stdout/stderr must still be resumed.
            onSettle: (info) => settles.push(info),
          },
        },
      );
      expect(result.promoted).toBe(true);
      expect(stdoutResumeSpy).toHaveBeenCalled();
      expect(stderrResumeSpy).toHaveBeenCalled();
      expect(settles).toHaveLength(1);
    });

    it('should gracefully attempt SIGKILL on linux if SIGTERM fails', async () => {
      mockPlatform.mockReturnValue('linux');
      vi.useFakeTimers();

      // Don't await the result inside the simulation block for this specific test.
      // We need to control the timeline manually.
      const abortController = new AbortController();
      const handle = await ShellExecutionService.execute(
        'unresponsive_process',
        '/test/dir',
        onOutputEventMock,
        abortController.signal,
        true,
        {},
      );

      abortController.abort();

      // Check the first kill signal
      expect(mockProcessKill).toHaveBeenCalledWith(
        -mockChildProcess.pid!,
        'SIGTERM',
      );

      // Now, advance time past the timeout
      await vi.advanceTimersByTimeAsync(250);

      // Check the second kill signal
      expect(mockProcessKill).toHaveBeenCalledWith(
        -mockChildProcess.pid!,
        'SIGKILL',
      );

      // Finally, simulate the process exiting and await the result
      mockChildProcess.emit('exit', null, 'SIGKILL');
      mockChildProcess.emit('close', null, 'SIGKILL');
      const result = await handle.result;

      vi.useRealTimers();

      expect(result.aborted).toBe(true);
      expect(result.signal).toBe(9);
    });
  });

  describe('Binary Output', () => {
    it('should detect binary output and switch to progress events', async () => {
      mockIsBinary.mockReturnValueOnce(true);
      const binaryChunk1 = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const binaryChunk2 = Buffer.from([0x0d, 0x0a, 0x1a, 0x0a]);

      const { result } = await simulateExecution('cat image.png', (cp) => {
        cp.stdout?.emit('data', binaryChunk1);
        cp.stdout?.emit('data', binaryChunk2);
        cp.emit('exit', 0, null);
      });

      expect(result.rawOutput).toEqual(
        Buffer.concat([binaryChunk1, binaryChunk2]),
      );
      expect(onOutputEventMock).toHaveBeenCalledTimes(1);
      expect(onOutputEventMock.mock.calls[0][0]).toEqual({
        type: 'binary_detected',
      });
    });

    it('should not emit data events after binary is detected', async () => {
      mockIsBinary.mockImplementation((buffer) => buffer.includes(0x00));

      await simulateExecution('cat mixed_file', (cp) => {
        cp.stdout?.emit('data', Buffer.from('some text'));
        cp.stdout?.emit('data', Buffer.from([0x00, 0x01, 0x02]));
        cp.stdout?.emit('data', Buffer.from('more text'));
        cp.emit('exit', 0, null);
      });

      const eventTypes = onOutputEventMock.mock.calls.map(
        (call: [ShellOutputEvent]) => call[0].type,
      );
      expect(eventTypes).toEqual(['binary_detected']);
    });
  });

  describe('Platform-Specific Behavior', () => {
    it('should use cmd.exe with windowsVerbatimArguments on Windows', async () => {
      mockPlatform.mockReturnValue('win32');
      mockGetShellConfiguration.mockReturnValue({
        executable: 'cmd.exe',
        argsPrefix: ['/d', '/s', '/c'],
        shell: 'cmd',
      });
      await simulateExecution('dir "foo bar"', (cp) =>
        cp.emit('exit', 0, null),
      );

      expect(mockCpSpawn).toHaveBeenCalledWith(
        'cmd.exe',
        ['/d', '/s', '/c', 'dir "foo bar"'],
        expect.objectContaining({
          detached: false,
          windowsHide: true,
          windowsVerbatimArguments: true,
        }),
      );
      mockGetShellConfiguration.mockReturnValue({
        executable: 'bash',
        argsPrefix: ['-c'],
        shell: 'bash',
      });
    });

    it('should use PowerShell with UTF-8 prefix without windowsVerbatimArguments on Windows', async () => {
      mockPlatform.mockReturnValue('win32');
      mockGetShellConfiguration.mockReturnValue({
        executable: 'powershell.exe',
        argsPrefix: ['-NoProfile', '-Command'],
        shell: 'powershell',
      });
      await simulateExecution('Test-Path "C:\\Temp\\"', (cp) =>
        cp.emit('exit', 0, null),
      );

      // PowerShell commands on Windows are prefixed with UTF-8 output encoding
      expect(mockCpSpawn).toHaveBeenCalledWith(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Test-Path "C:\\Temp\\"',
        ],
        expect.objectContaining({
          detached: false,
          windowsHide: true,
          windowsVerbatimArguments: false,
        }),
      );
      mockGetShellConfiguration.mockReturnValue({
        executable: 'bash',
        argsPrefix: ['-c'],
        shell: 'bash',
      });
    });

    it('should normalize PATH-like env keys on Windows for child_process fallback', async () => {
      mockPlatform.mockReturnValue('win32');
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      setupConflictingPathEnv();

      await simulateExecution('dir', (cp) => cp.emit('exit', 0, null));

      const spawnOptions = mockCpSpawn.mock.calls[0][2];
      expectNormalizedWindowsPathEnv(spawnOptions.env);
    });

    it('should use bash and detached process group on Linux', async () => {
      mockPlatform.mockReturnValue('linux');
      await simulateExecution('ls "foo bar"', (cp) => cp.emit('exit', 0, null));

      expect(mockCpSpawn).toHaveBeenCalledWith(
        'bash',
        ['-c', 'ls "foo bar"'],
        expect.objectContaining({
          detached: true,
        }),
      );
    });
  });
});

describe('ShellExecutionService execution method selection', () => {
  let onOutputEventMock: Mock<(event: ShellOutputEvent) => void>;
  let mockPtyProcess: EventEmitter & {
    pid: number;
    kill: Mock;
    onData: Mock;
    onExit: Mock;
    write: Mock;
    resize: Mock;
  };
  let mockChildProcess: EventEmitter & Partial<ChildProcess>;

  beforeEach(() => {
    vi.clearAllMocks();
    onOutputEventMock = vi.fn();

    // Mock for pty
    mockPtyProcess = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: Mock;
      onData: Mock;
      onExit: Mock;
      write: Mock;
      resize: Mock;
    };
    mockPtyProcess.pid = 12345;
    mockPtyProcess.kill = vi.fn();
    // node-pty's onData/onExit return IDisposable; the production
    // background-promote path calls .dispose() on those handles to detach
    // its listeners cleanly. Mock them to return a disposable stub so the
    // promote path doesn't crash on `undefined.dispose()`.
    mockPtyProcess.onData = vi.fn().mockReturnValue({ dispose: vi.fn() });
    mockPtyProcess.onExit = vi.fn().mockReturnValue({ dispose: vi.fn() });
    mockPtyProcess.write = vi.fn();
    mockPtyProcess.resize = vi.fn();

    mockPtySpawn.mockReturnValue(mockPtyProcess);
    mockGetPty.mockResolvedValue({
      module: { spawn: mockPtySpawn },
      name: 'mock-pty',
    });

    // Mock for child_process
    mockChildProcess = new EventEmitter() as EventEmitter &
      Partial<ChildProcess>;
    mockChildProcess.stdout = new EventEmitter() as Readable;
    mockChildProcess.stderr = new EventEmitter() as Readable;
    mockChildProcess.kill = vi.fn();
    Object.defineProperty(mockChildProcess, 'pid', {
      value: 54321,
      configurable: true,
    });
    // Mirror real Node ChildProcess: `exitCode` / `signalCode` are
    // `null` while alive. Kept in sync with the `child_process
    // fallback` describe block's mock setup so any future promote-
    // related test that lands here doesn't trip the production
    // `child.exitCode !== null` race guard with a stale `undefined`.
    Object.defineProperty(mockChildProcess, 'exitCode', {
      value: null,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(mockChildProcess, 'signalCode', {
      value: null,
      writable: true,
      configurable: true,
    });
    mockCpSpawn.mockReturnValue(mockChildProcess);
  });

  it('should use node-pty when shouldUseNodePty is true and pty is available', async () => {
    const abortController = new AbortController();
    const handle = await ShellExecutionService.execute(
      'test command',
      '/test/dir',
      onOutputEventMock,
      abortController.signal,
      true, // shouldUseNodePty
      shellExecutionConfig,
    );

    // Simulate exit to allow promise to resolve
    mockPtyProcess.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
    const result = await handle.result;

    expect(mockGetPty).toHaveBeenCalled();
    expect(mockPtySpawn).toHaveBeenCalled();
    expect(mockCpSpawn).not.toHaveBeenCalled();
    expect(result.executionMethod).toBe('mock-pty');
  });

  it('should use child_process when shouldUseNodePty is false', async () => {
    const abortController = new AbortController();
    const handle = await ShellExecutionService.execute(
      'test command',
      '/test/dir',
      onOutputEventMock,
      abortController.signal,
      false, // shouldUseNodePty
      {},
    );

    // Simulate exit to allow promise to resolve
    mockChildProcess.emit('exit', 0, null);
    const result = await handle.result;

    expect(mockGetPty).not.toHaveBeenCalled();
    expect(mockPtySpawn).not.toHaveBeenCalled();
    expect(mockCpSpawn).toHaveBeenCalled();
    expect(result.executionMethod).toBe('child_process');
  });

  it('should fall back to child_process if pty is not available even if shouldUseNodePty is true', async () => {
    mockGetPty.mockResolvedValue(null);

    const abortController = new AbortController();
    const handle = await ShellExecutionService.execute(
      'test command',
      '/test/dir',
      onOutputEventMock,
      abortController.signal,
      true, // shouldUseNodePty
      shellExecutionConfig,
    );

    // Simulate exit to allow promise to resolve
    mockChildProcess.emit('exit', 0, null);
    const result = await handle.result;

    expect(mockGetPty).toHaveBeenCalled();
    expect(mockPtySpawn).not.toHaveBeenCalled();
    expect(mockCpSpawn).toHaveBeenCalled();
    expect(result.executionMethod).toBe('child_process');
  });
});

describe('getShellAbortReasonKind (defensive abort-reason read)', () => {
  it("returns 'cancel' for null reason (e.g. plain abortController.abort())", () => {
    expect(getShellAbortReasonKind(null)).toBe('cancel');
    expect(getShellAbortReasonKind(undefined)).toBe('cancel');
  });

  it("returns 'cancel' for non-object reasons (string / number / DOMException)", () => {
    expect(getShellAbortReasonKind('background')).toBe('cancel');
    expect(getShellAbortReasonKind(42)).toBe('cancel');
    expect(getShellAbortReasonKind(true)).toBe('cancel');
    // DOMException-like object — not the real DOMException constructor in
    // the test runtime, but the principle is the same: a non-discriminated
    // object reason without an own `kind` falls back to cancel.
    expect(getShellAbortReasonKind(new Error('aborted'))).toBe('cancel');
  });

  it("returns 'cancel' for an empty object (no own kind)", () => {
    expect(getShellAbortReasonKind({})).toBe('cancel');
  });

  it("returns 'cancel' when 'kind' lives only on the prototype (pollution defense)", () => {
    const polluted: Record<string, unknown> = Object.create({
      kind: 'background',
    });
    // hasOwnProperty('kind') is false → helper rejects the prototype-only kind
    expect(getShellAbortReasonKind(polluted)).toBe('cancel');
  });

  it("returns 'cancel' for an unknown kind value (typo / future-untyped variant)", () => {
    expect(getShellAbortReasonKind({ kind: 'suspend' })).toBe('cancel');
    expect(getShellAbortReasonKind({ kind: 'BACKGROUND' })).toBe('cancel');
    expect(getShellAbortReasonKind({ kind: 42 })).toBe('cancel');
  });

  it("returns 'cancel' when reading 'kind' throws (accessor / Proxy trap)", () => {
    const throwingReason = Object.defineProperty({}, 'kind', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('accessor blew up');
      },
    });
    expect(getShellAbortReasonKind(throwingReason)).toBe('cancel');

    const proxyReason = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'kind') throw new Error('proxy trap blew up');
          return undefined;
        },
        getOwnPropertyDescriptor(_target, prop) {
          if (prop === 'kind') {
            return { configurable: true, enumerable: true, value: 'unused' };
          }
          return undefined;
        },
      },
    );
    expect(getShellAbortReasonKind(proxyReason)).toBe('cancel');
  });

  it("returns 'cancel' when the `getOwnPropertyDescriptor` Proxy trap throws", () => {
    // `Object.prototype.hasOwnProperty.call(reason, 'kind')` triggers
    // the `[[GetOwnProperty]]` Proxy trap. A Proxy whose
    // `getOwnPropertyDescriptor` handler throws (separate from the
    // `get` trap covered by the test above) used to propagate past
    // the helper because `hasOwnProperty.call` was outside the try.
    // Now the helper wraps both the descriptor probe and the property
    // read, so this also falls back to 'cancel'. (No `get` handler on
    // the proxy: `hasOwnProperty.call` throws before the helper ever
    // tries to read `kind`.)
    const throwingDescriptorProxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('getOwnPropertyDescriptor blew up');
        },
      },
    );
    expect(getShellAbortReasonKind(throwingDescriptorProxy)).toBe('cancel');
  });

  it("returns 'background' for the canonical happy-path reason", () => {
    expect(getShellAbortReasonKind({ kind: 'background' })).toBe('background');
    expect(
      getShellAbortReasonKind({ kind: 'background', shellId: 'bg_x' }),
    ).toBe('background');
  });

  it("returns 'cancel' for the canonical cancel reason", () => {
    expect(getShellAbortReasonKind({ kind: 'cancel' })).toBe('cancel');
  });
});
