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

const mockGetSystemEncoding = vi.hoisted(() =>
  vi.fn().mockReturnValue('utf-8'),
);
const mockPtySpawn = vi.hoisted(() => vi.fn());
const mockCpSpawn = vi.hoisted(() => vi.fn());
const mockSpawnSync = vi.hoisted(() => vi.fn());
const mockIsBinary = vi.hoisted(() => vi.fn());
const mockPlatform = vi.hoisted(() => vi.fn());
const mockGetPty = vi.hoisted(() => vi.fn());
const mockLoadXtermHeadless = vi.hoisted(() => vi.fn());
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

vi.mock('@lydell/node-pty', () => ({
  spawn: mockPtySpawn,
}));
vi.mock('child_process', () => ({
  spawn: mockCpSpawn,
  spawnSync: mockSpawnSync,
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
vi.mock('../utils/load-xterm-headless.js', () => ({
  loadXtermHeadless: mockLoadXtermHeadless,
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

// Production runs taskkill by absolute System32 path (the bare name invites
// PATH/CWD binary planting); SystemRoot is unset off Windows, so derive alike.
const TASKKILL = `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32\\taskkill.exe`;
const HIDDEN_WINDOW = { windowsHide: true };
const CHCP = `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32\\chcp.com`;
const CAP_NOTICE = 'Output exceeded the maximum captured size';

// taskkill spawn arguments: tree-kill (/t) by default, shell pid only otherwise.
const taskkill = (pid: number | undefined, tree = true) => [
  TASKKILL,
  tree ? ['/f', '/t', '/pid', String(pid)] : ['/f', '/pid', String(pid)],
  HIDDEN_WINDOW,
];
const expectNoTaskkill = () =>
  expect(mockCpSpawn).not.toHaveBeenCalledWith(
    TASKKILL,
    expect.anything(),
    HIDDEN_WINDOW,
  );

// Runs `run` while the liveness probe process.kill(pid, 0) throws ESRCH (shell
// gone), then restores the alive default: clearAllMocks() keeps impls.
const withDeadShell = async (run: () => unknown) => {
  mockProcessKill.mockImplementation((_pid, signal) => {
    if (signal === 0) throw new Error('ESRCH');
    return true;
  });
  try {
    await run();
  } finally {
    mockProcessKill.mockImplementation(() => true);
  }
};

// Shells as [executable, shell, ...argsPrefix].
const BASH_SHELL = ['bash', 'bash', '-c'];
const CMD_SHELL = ['cmd.exe', 'cmd', '/d', '/s', '/c'];
const GIT_BASH_SHELL = ['bash.exe', 'bash', '-c'];
const POWERSHELL_SHELL = [
  'powershell.exe',
  'powershell',
  '-NoProfile',
  '-Command',
];
const useShell = ([executable, shell, ...argsPrefix]: string[]) =>
  mockGetShellConfiguration.mockReturnValue({ executable, argsPrefix, shell });
// PowerShell commands on Windows are prefixed with UTF-8 output encoding.
const PS_COMMAND = 'Test-Path "C:\\Temp\\"';
const PS_UTF8_ARGS = [
  '-NoProfile',
  '-Command',
  `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${PS_COMMAND}`,
];

const bg = (shellId: string) =>
  ({ kind: 'background', shellId }) satisfies ShellAbortReason;

const shellExecutionConfig = {
  terminalWidth: 80,
  terminalHeight: 24,
  pager: 'cat',
  showColor: false,
  disableDynamicLineTrimming: true,
} satisfies ShellExecutionConfig;

const { pager: _pager, ...shellExecutionConfigWithoutPager } =
  shellExecutionConfig;

const WINDOWS_SYSTEM_PATH = 'C:\\Windows\\System32;C:\\Shared\\Tools';
const WINDOWS_USER_PATH = 'C:\\Users\\tester\\bin;C:\\Shared\\Tools';
const EXPECTED_MERGED_WINDOWS_PATH =
  'C:\\Windows\\System32;C:\\Shared\\Tools;C:\\Users\\tester\\bin';

let originalProcessEnv: NodeJS.ProcessEnv;
let onOutputEventMock: Mock<(event: ShellOutputEvent) => void>;

beforeEach(() => {
  originalProcessEnv = process.env;
});

afterEach(() => {
  process.env = originalProcessEnv;
  vi.unstubAllEnvs();
});

const exec = (
  command: string,
  {
    signal = new AbortController().signal,
    usePty = true,
    config = shellExecutionConfig,
    options,
  }: {
    signal?: AbortSignal;
    usePty?: boolean;
    config?: ShellExecutionConfig;
    options?: ShellExecuteOptions;
  } = {},
) =>
  ShellExecutionService.execute(
    command,
    '/test/dir',
    onOutputEventMock,
    signal,
    usePty,
    config,
    options,
  );

// onData/onExit return a disposable stub, like node-pty's IDisposable: the
// background-promote path calls .dispose() on them to detach its listeners.
const makePty = () =>
  Object.assign(new EventEmitter(), {
    pid: 12345,
    kill: vi.fn(),
    onData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onExit: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    write: vi.fn(),
    resize: vi.fn(),
  });

// Like a live Node ChildProcess, exitCode / signalCode are null: the promote
// liveness guard reads them to catch an exit racing the abort handler, and
// `undefined` would look terminal and skip the promote.
const makeChild = (pid: number, withExitState = true) => {
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  child.stdout = new EventEmitter() as Readable;
  child.stderr = new EventEmitter() as Readable;
  child.kill = vi.fn();
  Object.defineProperty(child, 'pid', { value: pid, configurable: true });
  if (withExitState) {
    for (const key of ['exitCode', 'signalCode']) {
      Object.defineProperty(child, key, {
        value: null,
        writable: true,
        configurable: true,
      });
    }
  }
  return child;
};
type MockChild = ReturnType<typeof makeChild>;

// Replace (not mutate in place): this file restores process.env by reference
// in afterEach, so in-place keys would leak to later tests.
const setSecretEnv = () => {
  process.env = {
    ...originalProcessEnv,
    QWEN_SERVER_TOKEN: 'serve-secret',
    QWEN_DAEMON_TOKEN: 'daemon-secret',
    GH_TOKEN: 'gh-abc',
    PATH: '/usr/bin',
  };
};

const expectSanitizedEnv = (spawn: Mock) => {
  const spawnEnv = (spawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env;
  // Internal daemon secrets must not leak into agent-run commands.
  expect(spawnEnv['QWEN_SERVER_TOKEN']).toBeUndefined();
  expect(spawnEnv['QWEN_DAEMON_TOKEN']).toBeUndefined();
  // Benign vars + third-party credentials user commands rely on are kept.
  expect(spawnEnv['PATH']).toContain('/usr/bin');
  expect(spawnEnv['GH_TOKEN']).toBe('gh-abc');
  // The shell tool's own marker is still applied on top.
  expect(spawnEnv['QWEN_CODE']).toBe('1');
};

const dataEvent = (chunk: unknown) => ({ type: 'data', chunk });
const stdoutEvent = (chunk: unknown) => ({
  type: 'data',
  chunk,
  stream: 'stdout',
});
const expectDataEvent = (chunk: unknown) =>
  expect(onOutputEventMock).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'data', chunk }),
  );
const emittedData = () =>
  onOutputEventMock.mock.calls.filter(([event]) => event.type === 'data');

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

const createExpectedAnsiOutput = (text: string | string[]): AnsiOutput => {
  const lines = Array.isArray(text) ? text : text.split('\n');
  return Array.from({ length: shellExecutionConfig.terminalHeight }, (_, i) => [
    {
      ...createAnsiToken(''),
      text: expect.stringMatching((lines[i] || '').trim()),
    },
  ]);
};

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

describe('ShellExecutionService', () => {
  let mockPtyProcess: ReturnType<typeof makePty>;
  let mockPtyNativeKill: Mock;
  let mockConoutWorkerDispose: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBinary.mockReturnValue(false);
    mockPlatform.mockReturnValue('linux');
    mockGetPty.mockResolvedValue({
      module: { spawn: mockPtySpawn },
      name: 'mock-pty',
    });
    mockLoadXtermHeadless.mockResolvedValue({ Terminal });
    onOutputEventMock = vi.fn();
    mockPtyProcess = makePty();
    // node-pty WindowsPtyAgent internals, driven directly by releaseConPtyHost:
    // ptyProcess.kill() would fork a console-list helper, then TerminateProcess
    // a pid ClosePseudoConsole already freed for reuse (#11303).
    mockPtyNativeKill = vi.fn();
    mockConoutWorkerDispose = vi.fn();
    (mockPtyProcess as unknown as { _agent: Record<string, unknown> })._agent =
      {
        _pty: 777,
        _useConptyDll: true,
        _ptyNative: { kill: mockPtyNativeKill },
        _conoutSocketWorker: { dispose: mockConoutWorkerDispose },
      };
    mockPtySpawn.mockReturnValue(mockPtyProcess);
  });

  const ptyData = (...chunks: Array<string | Buffer>) =>
    chunks.forEach((chunk) => mockPtyProcess.onData.mock.calls[0][0](chunk));
  const ptyExit = (exit: object = { exitCode: 0, signal: null }) =>
    mockPtyProcess.onExit.mock.calls[0][0](exit);
  // Drives the most recently registered (post-promote) exit listener.
  const postPromoteExit = (exit: object = { exitCode: 0, signal: undefined }) =>
    mockPtyProcess.onExit.mock.calls.at(-1)![0](exit);
  const disposableOf = (register: Mock) =>
    register.mock.results[0].value as { dispose: Mock };
  const ptyTaskkill = (tree = true) => taskkill(mockPtyProcess.pid, tree);
  const groupKill = (signal: string) => [-mockPtyProcess.pid, signal];
  const expectConPtyReleased = () => {
    expect(mockPtyNativeKill).toHaveBeenCalledWith(777, true);
    expect(mockConoutWorkerDispose).toHaveBeenCalled();
  };

  // Start a PTY execution, let spawn settle, drive it, and await the result.
  const simulateExecution = async (
    command: string,
    simulation: (ac: AbortController) => void | Promise<void>,
    config: ShellExecutionConfig = shellExecutionConfig,
    options: ShellExecuteOptions = {},
  ) => {
    const abortController = new AbortController();
    const handle = await exec(command, {
      signal: abortController.signal,
      config,
      options,
    });
    await new Promise((resolve) => process.nextTick(resolve));
    await simulation(abortController);
    const result = await handle.result;
    return { result, handle, abortController };
  };
  // Feed output chunks, then exit cleanly.
  const runPty = (
    command: string,
    chunks: Array<string | Buffer> = [],
    config?: ShellExecutionConfig,
  ) =>
    simulateExecution(
      command,
      () => {
        ptyData(...chunks);
        ptyExit();
      },
      config,
    );
  // Run `echo hi` to a clean exit.
  const runEchoHi = async () => {
    const { result } = await runPty('echo hi');
    expect(result.exitCode).toBe(0);
    return result;
  };
  // Cancel, let the killed PTY exit with code 1, and check the aborted flag.
  const cancelPty = async (command = 'sleep 10', reason?: ShellAbortReason) => {
    const { result } = await simulateExecution(command, (ac) => {
      ac.abort(reason);
      ptyExit({ exitCode: 1, signal: null });
    });
    expect(result.aborted).toBe(true);
    return result;
  };
  // Background-promote and check it took. No onExit: the child is still alive,
  // so the result must come from the abort handler's own immediate resolve.
  const promotePty = async (
    command: string,
    shellId: string,
    options?: ShellExecuteOptions,
  ) => {
    const { result } = await simulateExecution(
      command,
      (ac) => ac.abort(bg(shellId)),
      shellExecutionConfig,
      options,
    );
    expect(result.promoted).toBe(true);
    return result;
  };

  const launch = () => ({
    executable: '/trusted/program',
    args: ['two words', "quote'", '$(touch nope); *', ''],
    cwd: '/workspace',
    env: { ONLY: 'explicit', TERM: 'xterm-256color', PWD: '/workspace' },
  });
  const pipe = () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 56789,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      exitCode: null,
      signalCode: null,
    });
    mockCpSpawn.mockReturnValue(child);
    return child;
  };
  const launchWith = (
    input: Parameters<typeof ShellExecutionService.executeLaunch>[0],
    pty: boolean,
    config: ShellExecutionConfig = shellExecutionConfig,
    options?: ShellExecuteOptions,
    signal = new AbortController().signal,
  ) =>
    ShellExecutionService.executeLaunch(
      input,
      onOutputEventMock,
      signal,
      pty,
      config,
      options,
    );

  describe('child environment sanitization (#6601)', () => {
    it('strips Qwen-internal daemon secrets from the pty child env while keeping user vars and third-party credentials', async () => {
      setSecretEnv();
      await runPty('echo hi');
      expectSanitizedEnv(mockPtySpawn);
    });
  });

  describe('structured launch', () => {
    it.each([false, true])(
      'passes literal argv and exact env with PTY=%s',
      async (pty) => {
        const child = pipe();
        const input = launch();
        const handle = await launchWith(input, pty);
        expect(pty ? mockPtySpawn : mockCpSpawn).toHaveBeenCalledWith(
          input.executable,
          input.args,
          expect.objectContaining({ cwd: input.cwd, env: input.env }),
        );
        expect(mockGetShellConfiguration).not.toHaveBeenCalled();
        if (pty) ptyExit({ exitCode: 0 });
        else child.emit('exit', 0, null);
        expect((await handle.result).exitCode).toBe(0);
      },
    );

    it('snapshots argv and env before asynchronous PTY initialization', async () => {
      const input = launch();
      const pending = launchWith(input, true);
      input.args[0] = 'mutated';
      input.env.ONLY = 'mutated';
      input.executable = '/changed';
      const handle = await pending;
      expect(mockPtySpawn).toHaveBeenCalledWith(
        '/trusted/program',
        launch().args,
        expect.objectContaining({ env: launch().env }),
      );
      ptyExit({ exitCode: 0 });
      await handle.result;
    });

    it.each(['missing', 'spawn'])(
      'preserves the launch on PTY %s fallback',
      async (mode) => {
        const child = pipe();
        if (mode === 'missing') mockGetPty.mockResolvedValueOnce(undefined);
        else
          mockPtySpawn.mockImplementationOnce(() => {
            throw new Error('posix_spawnp failed');
          });
        const input = launch();
        const handle = await launchWith(input, true);
        expect(mockCpSpawn).toHaveBeenCalledExactlyOnceWith(
          input.executable,
          input.args,
          expect.objectContaining({ env: input.env }),
        );
        child.emit('exit', 0, null);
        await handle.result;
      },
    );

    it('never replays a launch after PTY initialization fails after spawn', async () => {
      const activeBefore = ShellExecutionService['activePtys'].size;
      const disposeSpy = vi.spyOn(Terminal.prototype, 'dispose');
      mockPtyProcess.onData.mockImplementationOnce(() => {
        throw new Error('posix_spawnp failed after spawn');
      });
      const handle = await launchWith(launch(), true);
      await expect(handle.result).rejects.toThrow('after spawn');
      expect(mockCpSpawn).not.toHaveBeenCalled();
      expect(mockProcessKill).toHaveBeenCalledWith(...groupKill('SIGKILL'));
      expect(disposeSpy).toHaveBeenCalledTimes(1);
      expect(ShellExecutionService['activePtys'].size).toBe(activeBefore);
    });

    it('ends stdin without reporting an early-close error when the exit status is known', async () => {
      const child = pipe();
      const input = { ...launch(), stdin: Buffer.from('request') };
      const handle = await launchWith(input, false);
      expect(child.stdin.end).toHaveBeenCalledWith(Buffer.from('request'));
      expect(mockCpSpawn.mock.calls[0][2].stdio).toEqual([
        'pipe',
        'pipe',
        'pipe',
      ]);
      const error = Object.assign(new Error('closed'), { code: 'EPIPE' });
      child.stdin.emit('error', error);
      child.emit('exit', 0, null);
      const result = await handle.result;
      // The exit status is authoritative: a transport EPIPE (stdin closed
      // early) must not fill the error slot that downstream gates read as a
      // receipt-confirmation veto or evidence-retention trigger (PR #12067).
      expect(result.exitCode).toBe(0);
      expect(result.error).toBeNull();
      expect(mockCpSpawn).toHaveBeenCalledTimes(1);
    });

    it('inherits stdin without creating a JavaScript pipe', async () => {
      const child = pipe();
      const handle = await launchWith(
        { ...launch(), inheritStdin: true },
        false,
      );
      expect(mockCpSpawn.mock.calls[0][2].stdio).toEqual([
        'inherit',
        'pipe',
        'pipe',
      ]);
      expect(child.stdin.end).not.toHaveBeenCalled();
      child.emit('exit', 0, null);
      await handle.result;
    });

    it('surfaces a stdin error only when the process leaves no exit information', async () => {
      const child = pipe();
      const input = { ...launch(), stdin: Buffer.from('request') };
      const handle = await launchWith(input, false);
      const error = Object.assign(new Error('closed'), { code: 'EPIPE' });
      child.stdin.emit('error', error);
      child.emit('exit', null, null);
      expect((await handle.result).error).toBe(error);
      expect(mockCpSpawn).toHaveBeenCalledTimes(1);
    });

    it('snapshots caller-owned stdin bytes before the asynchronous write', async () => {
      const child = pipe();
      const input = { ...launch(), stdin: Buffer.from('request') };
      const pending = launchWith(input, false);
      // Mutate the caller-owned buffer before the write: the service must
      // have copied it synchronously at snapshot time (PR #12067 review).
      input.stdin.fill(0);
      const handle = await pending;
      expect(child.stdin.end).toHaveBeenCalledWith(Buffer.from('request'));
      child.emit('exit', 0, null);
      await handle.result;
    });

    it('rejects PTY stdin and invalid launch paths before spawning', async () => {
      for (const [input, pty, message] of [
        [{ ...launch(), stdin: '' }, true, 'pipe'],
        [{ ...launch(), inheritStdin: true }, true, 'pipe'],
        [{ ...launch(), stdin: 'input', inheritStdin: true }, false, 'both'],
        [{ ...launch(), executable: 'relative' }, false, 'absolute'],
        [{ ...launch(), env: { 'BAD=KEY': 'x' } }, false, 'Invalid'],
      ] as const) {
        await expect(launchWith(input, pty, {})).rejects.toThrow(message);
      }
      expect(mockPtySpawn).not.toHaveBeenCalled();
      expect(mockCpSpawn).not.toHaveBeenCalled();
    });

    it.each<Record<string, string>>([
      {},
      { TERM: 'vt100' },
      { TERM: 'vt100', PWD: '/wrong' },
    ])('rejects implicit PTY environment additions: %j', async (env) => {
      await expect(launchWith({ ...launch(), env }, true, {})).rejects.toThrow(
        /TERM|PWD/,
      );
      expect(mockPtySpawn).not.toHaveBeenCalled();
      expect(mockCpSpawn).not.toHaveBeenCalled();
    });

    it('does not fall back if cancellation arrives during terminal loading', async () => {
      const controller = new AbortController();
      mockLoadXtermHeadless.mockImplementationOnce(async () => {
        controller.abort();
        throw new Error('load failed');
      });
      const handle = await launchWith(
        launch(),
        true,
        {},
        undefined,
        controller.signal,
      );
      expect((await handle.result).aborted).toBe(true);
      expect(mockCpSpawn).not.toHaveBeenCalled();
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });
  });

  describe('Successful Execution', () => {
    it('should execute a command and capture output', async () => {
      const { result, handle } = await runPty('ls -l', ['file1.txt\n']);

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

      expect(onOutputEventMock).toHaveBeenCalledWith(
        dataEvent(createExpectedAnsiOutput('file1.txt')),
      );
    });

    it('normalizes node-pty clean-exit signal 0 to null', async () => {
      const { result } = await simulateExecution('echo clean', () =>
        ptyExit({ exitCode: 0, signal: 0 }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
    });

    it('disposes PTY terminal resources on natural exit', async () => {
      const terminalDisposeSpy = vi.spyOn(Terminal.prototype, 'dispose');
      const removeListenerSpy = vi.spyOn(mockPtyProcess, 'removeListener');

      const { result } = await runPty('ls -l', ['file1.txt\n']);

      expect(result.exitCode).toBe(0);
      expect(disposableOf(mockPtyProcess.onData).dispose).toHaveBeenCalled();
      expect(disposableOf(mockPtyProcess.onExit).dispose).toHaveBeenCalled();
      expect(removeListenerSpy).toHaveBeenCalledWith(
        'error',
        expect.any(Function),
      );
      // One terminal is used for live PTY rendering, another for final replay.
      expect(terminalDisposeSpy).toHaveBeenCalledTimes(2);

      terminalDisposeSpy.mockRestore();
    });

    it('disposes PTY resources and resolves when final render throws', async () => {
      const terminalDisposeSpy = vi.spyOn(Terminal.prototype, 'dispose');
      mockSerializeTerminalToText.mockImplementationOnce(() => {
        throw new Error('final render failed');
      });

      const { result } = await runPty('render-fails-on-exit', [], {
        ...shellExecutionConfig,
        disableDynamicLineTrimming: false,
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('');
      expect(disposableOf(mockPtyProcess.onData).dispose).toHaveBeenCalled();
      expect(disposableOf(mockPtyProcess.onExit).dispose).toHaveBeenCalled();
      // One terminal is used for live PTY rendering, another for final replay.
      expect(terminalDisposeSpy).toHaveBeenCalledTimes(2);

      terminalDisposeSpy.mockRestore();
    });

    it('should strip ANSI codes from output', async () => {
      const { result } = await runPty('ls --color=auto', [
        'a\u001b[31mred\u001b[0mword',
      ]);

      expect(result.output.trim()).toBe('aredword');
      expectDataEvent(createExpectedAnsiOutput('aredword'));
    });

    it('suppresses parser diagnostics for malformed PTY output', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      try {
        const { result } = await runPty('malformed-output', [
          '\u001b\xb0',
          'recovered',
        ]);

        expect(
          consoleErrorSpy.mock.calls.some((args) =>
            args.some((arg) => String(arg).includes('Parsing error')),
          ),
        ).toBe(false);
        expect(result.output).toContain('recovered');
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it('should correctly decode multi-byte characters split across chunks', async () => {
      const { result } = await runPty('echo "你好"', ['你', '好']);
      expect(result.output.trim()).toBe('你好');
    });

    it('bounds buffered PTY output before building the final string', async () => {
      const { result } = await runPty('large-output', ['12345678', 'abcdefg'], {
        ...shellExecutionConfig,
        maxBufferedOutputBytes: 10,
      });

      expect(result.rawOutput.length).toBe(10);
      expect(result.output).toContain('12345678ab');
      expect(result.output).toContain(CAP_NOTICE);
      expect(result.output).not.toContain('cdefg');
    });

    it('keeps PTY replay fallback bounded after the capture limit is exceeded', async () => {
      mockSerializeTerminalToText.mockImplementationOnce(() => {
        throw new Error('replay failed');
      });

      const { result } = await runPty(
        'large-output-replay-fallback',
        ['12345678', 'abcdefg'],
        { ...shellExecutionConfig, maxBufferedOutputBytes: 10 },
      );

      expect(result.rawOutput.toString()).toBe('12345678ab');
      expect(result.output).toContain('12345678ab');
      expect(result.output).toContain(CAP_NOTICE);
      expect(result.output).not.toContain('cdefg');
    });

    it('does not add a capture-limit notice at the exact PTY buffer boundary', async () => {
      const { result } = await runPty('exact-output', ['1234567890'], {
        ...shellExecutionConfig,
        maxBufferedOutputBytes: 10,
      });

      expect(result.rawOutput.length).toBe(10);
      expect(result.output).toBe('1234567890');
      expect(result.output).not.toContain(CAP_NOTICE);
    });

    it('should handle commands with no output', async () => {
      await runPty('touch file');

      expect(onOutputEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          chunk: createExpectedAnsiOutput(''),
        }),
      );
    });

    it('should call onPid with the process id', async () => {
      const handle = await exec('ls -l');
      ptyExit();
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
        const handle = await exec('fast-output');
        for (let i = 1; i <= 500; i++) {
          ptyData(`Line ${String(i).padStart(4, '0')}\n`);
        }

        const resultPromise = handle.result;
        ptyExit();

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
      const { result } = await runPty('progress-output', [
        'Compressing objects: 14% (1/7)\r',
        'Compressing objects: 28% (2/7)\r',
        'Compressing objects: 42% (3/7)\r',
        'Compressing objects: 100% (7/7), done.\n',
      ]);

      expect(result.output).toBe('Compressing objects: 100% (7/7), done.');
    });

    it('should not persist narrow terminal soft wraps as transcript newlines', async () => {
      const { result } = await runPty(
        'narrow-output',
        ['abcdefghijklmnopqrstuvwxyz\nshort\n'],
        { ...shellExecutionConfig, terminalWidth: 8, terminalHeight: 4 },
      );

      expect(result.output).toBe('abcdefghijklmnopqrstuvwxyz\nshort');
    });
  });

  describe('pty interaction', () => {
    const headless = () => ({
      resize: vi.fn(),
      scrollLines: vi.fn(),
      buffer: { active: { viewportY: 0 } },
    });
    let mockHeadlessTerminal: ReturnType<typeof headless>;
    const resize = () =>
      ShellExecutionService.resizePty(mockPtyProcess.pid, 100, 40);
    // Emit a line, run `action` mid-execution, then exit cleanly.
    const midRun = (action: () => void) =>
      simulateExecution('ls -l', () => {
        ptyData('file1.txt\n');
        action();
        ptyExit();
      });

    beforeEach(() => {
      mockHeadlessTerminal = headless();
      vi.spyOn(ShellExecutionService['activePtys'], 'get').mockReturnValue({
        ptyProcess: mockPtyProcess,
        headlessTerminal: mockHeadlessTerminal,
      } as never);
    });

    it('should write to the pty and trigger a render', async () => {
      vi.useFakeTimers();
      try {
        const handle = await exec('interactive-app');

        ShellExecutionService.writeToPty(handle.pid!, 'input');
        ptyExit();

        await vi.runAllTimersAsync();
        await handle.result;

        expect(mockPtyProcess.write).toHaveBeenCalledWith('input');
        expect(onOutputEventMock).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should resize the pty and the headless terminal', async () => {
      await midRun(resize);

      expect(mockPtyProcess.resize).toHaveBeenCalledWith(100, 40);
      expect(mockHeadlessTerminal.resize).toHaveBeenCalledWith(100, 40);
    });

    it('should ignore expected PTY read EIO errors on process exit', async () => {
      const { result } = await simulateExecution('ls -l', () => {
        const eioError = Object.assign(new Error('read EIO'), { code: 'EIO' });
        mockPtyProcess.emit('error', eioError);
        ptyExit();
      });

      expect(result.exitCode).toBe(0);
    });

    it('should throw unexpected PTY errors from error event', async () => {
      await simulateExecution('ls -l', () => {
        const unexpectedError = Object.assign(
          new Error('unexpected pty error'),
          { code: 'EPIPE' },
        );
        expect(() => mockPtyProcess.emit('error', unexpectedError)).toThrow(
          'unexpected pty error',
        );
        ptyExit();
      });
    });

    it('should ignore ioctl EBADF message-only resize race errors', async () => {
      mockPtyProcess.resize.mockImplementationOnce(() => {
        throw new Error('ioctl(2) failed, EBADF');
      });

      await midRun(() => expect(resize).not.toThrow());
    });

    it('should ignore exited-pty message-only resize race errors', async () => {
      mockPtyProcess.resize.mockImplementationOnce(() => {
        throw new Error('Cannot resize a pty that has already exited');
      });

      await midRun(() => expect(resize).not.toThrow());
    });

    it('should scroll the headless terminal', async () => {
      await midRun(() =>
        ShellExecutionService.scrollPty(mockPtyProcess.pid, 10),
      );

      expect(mockHeadlessTerminal.scrollLines).toHaveBeenCalledWith(10);
    });
  });

  describe('Failed Execution', () => {
    it('should capture a non-zero exit code', async () => {
      const { result } = await simulateExecution('a-bad-command', () => {
        ptyData('command not found');
        ptyExit({ exitCode: 127, signal: null });
      });

      expect(result.exitCode).toBe(127);
      expect(result.output.trim()).toBe('command not found');
      expect(result.error).toBeNull();
    });

    it('should capture a termination signal', async () => {
      const { result } = await simulateExecution('long-process', () =>
        ptyExit({ exitCode: 0, signal: 15 }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.signal).toBe(15);
    });

    it('should handle a synchronous spawn error', async () => {
      mockGetPty.mockImplementation(() => null);

      mockCpSpawn.mockImplementation(() => {
        throw new Error('Simulated PTY spawn error');
      });

      const handle = await exec('any-command', { config: {} });
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
      // cancelPty checks the aborted flag (the process kill is mocked).
      await cancelPty();
    });

    it('signal.reason = { kind: "cancel" } still tree-kills (same as default)', async () => {
      const result = await cancelPty('sleep 10', { kind: 'cancel' });

      expect(result.promoted).toBeUndefined();
      // Default kill (group SIGTERM): 'cancel' is not routed as background.
      expect(mockProcessKill).toHaveBeenCalledWith(...groupKill('SIGTERM'));
    });

    it('signal.reason = { kind: "background" } skips kill and resolves with promoted: true (and aborted: false per design question 7)', async () => {
      const terminalDisposeSpy = vi.spyOn(Terminal.prototype, 'dispose');
      const result = await promotePty('tail -f /tmp/never.log', 'bg_test123');

      // `aborted: false` despite signal.aborted is intentional (#3831 design
      // question 7): it means "emit cancel/timeout copy?"; promoted is neither.
      expect(result.aborted).toBe(false);
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBeNull();
      expect(result.error).toBeNull();
      expect(result.pid).toBe(mockPtyProcess.pid);
      // No kill (PTY kill() or group process.kill): the caller owns the child.
      expect(mockPtyProcess.kill).not.toHaveBeenCalled();
      expect(mockProcessKill).not.toHaveBeenCalledWith(...groupKill('SIGTERM'));
      expect(mockProcessKill).not.toHaveBeenCalledWith(...groupKill('SIGKILL'));
      expect(terminalDisposeSpy).toHaveBeenCalled();

      terminalDisposeSpy.mockRestore();
    });

    it('background-promote replay failure falls back to full decoded raw output', async () => {
      const terminalDisposeSpy = vi.spyOn(Terminal.prototype, 'dispose');
      mockSerializeTerminalToText.mockImplementationOnce(() => {
        throw new Error('replay failed');
      });
      const output = Array.from(
        { length: 250 },
        (_, index) => `line-${index}`,
      ).join('\n');

      const { result } = await simulateExecution(
        'long-running-output',
        (ac) => {
          ptyData(output);
          ac.abort(bg('bg_replay_fallback'));
        },
      );

      expect(result.promoted).toBe(true);
      expect(result.output).toContain('line-0');
      expect(result.output).toContain('line-249');
      // One terminal is used for replay, another for the promoted snapshot.
      expect(terminalDisposeSpy).toHaveBeenCalledTimes(2);

      terminalDisposeSpy.mockRestore();
    });

    it('post-promotion: PTY data is no longer routed to onOutputEvent (handoff boundary)', async () => {
      // Ownership contract: after promote, still-running PTY data must NOT
      // reach the foreground onOutputEvent (dataDisposable.dispose() stops it).
      // PTY handleOutput is async (`processingChain`), so a sync expect right
      // after emit-then-abort passes without exercising `listenersDetached`;
      // awaiting handle.result lets the abort handler's drain settle the chain.
      const { result } = await simulateExecution(
        'tail -f /tmp/never.log',
        (ac) => {
          ptyData('pre-promote-data\n');
          ac.abort(bg('bg_test123'));
        },
      );
      expect(result.promoted).toBe(true);
      // The pre-promote chain item ran AFTER the sync abort set
      // `listenersDetached`, so its emit was suppressed too: 0 pins both halves
      // (>= 1 without the guard).
      const eventCountAfterSettle = onOutputEventMock.mock.calls.length;
      expect(eventCountAfterSettle).toBe(0);
      // The mock disposable is a no-op, so re-invoking the data callback hits
      // the `listenersDetached` guard, the real backstop against post-promote
      // leaks. Then let any queued chain items settle.
      ptyData('post-promote-data\n');
      await new Promise((res) => setImmediate(res));
      await new Promise((res) => setImmediate(res));
      expect(onOutputEventMock.mock.calls.length).toBe(eventCountAfterSettle);

      expect(disposableOf(mockPtyProcess.onData).dispose).toHaveBeenCalled();
      expect(disposableOf(mockPtyProcess.onExit).dispose).toHaveBeenCalled();
    });

    it('PR-2.5: post-promote bytes route to postPromote.onData when callback provided', async () => {
      // Opt-in: with `postPromote.onData`, post-promote PTY bytes reach the
      // caller (PR-2 detached all listeners; PR-2.5 re-attaches a forwarder).
      const onDataCalls: ShellOutputEvent[] = [];
      await promotePty('tail -f /tmp/never.log', 'bg_pr25_data', {
        postPromote: { onData: (event) => onDataCalls.push(event) },
      });
      // The foreground listener is disposed; PR-2.5 registers a second one.
      const onDataRegistrations = mockPtyProcess.onData.mock.calls;
      expect(onDataRegistrations.length).toBeGreaterThanOrEqual(2);
      onDataRegistrations.at(-1)![0]('post-promote-byte-stream');
      expect(onDataCalls).toEqual([
        { type: 'data', chunk: 'post-promote-byte-stream' },
      ]);
    });

    it('PR-2.5: postPromote.onSettle fires on natural child exit after promote', async () => {
      // A child exiting AFTER promote fires onSettle exactly once with its exit
      // info (PR-2 detached the exit listener; PR-2.5 re-attaches on opt-in).
      const settleCalls: ShellPostPromoteSettleInfo[] = [];
      await promotePty('long-running-command', 'bg_pr25_settle', {
        postPromote: { onSettle: (info) => settleCalls.push(info) },
      });
      // Natural completion with node-pty's raw clean-exit signal metadata.
      expect(mockPtyProcess.onExit.mock.calls.length).toBeGreaterThanOrEqual(2);
      postPromoteExit({ exitCode: 0, signal: 0 });
      expect(settleCalls).toHaveLength(1);
      expect(settleCalls[0].exitCode).toBe(0);
      expect(settleCalls[0].signal).toBeNull();
      expect(settleCalls[0].error).toBeUndefined();
      expect(typeof settleCalls[0].endTime).toBe('number');
    });

    it('PR-2.5 wave-2 (C2): unexpected post-promote PTY error routes to onSettle as failure (does NOT crash the CLI)', async () => {
      // Promote removes the foreground PTY error handler; before wave-2 nothing
      // replaced it and an unhandled `error` took Node down. Unexpected errors
      // now settle with `error`; read-exit errors (EIO / EAGAIN) are filtered.
      const settleCalls: ShellPostPromoteSettleInfo[] = [];
      await promotePty('long-running-with-error', 'bg_pr25_pty_err', {
        postPromote: { onSettle: (info) => settleCalls.push(info) },
      });

      // 1. Expected EIO is FILTERED; the upcoming onExit carries the status.
      mockPtyProcess.emit(
        'error',
        Object.assign(new Error('read EIO'), { code: 'EIO' }),
      );
      expect(settleCalls).toHaveLength(0);

      // 2. An UNEXPECTED error (EPIPE) settles as a failure without throwing.
      const unexpectedErr = Object.assign(new Error('disk gone'), {
        code: 'EPIPE',
      });
      expect(() => mockPtyProcess.emit('error', unexpectedErr)).not.toThrow();
      expect(settleCalls).toHaveLength(1);
      expect(settleCalls[0].error).toBe(unexpectedErr);
      expect(settleCalls[0].exitCode).toBeNull();
      expect(settleCalls[0].signal).toBeNull();
      expect(typeof settleCalls[0].endTime).toBe('number');

      // 3. A later onExit must NOT settle again: the registry's complete/fail
      // transitions are not idempotent across status types.
      postPromoteExit();
      expect(settleCalls).toHaveLength(1);
    });

    it('PR-2.5 wave-3 (T6): post-promote IDisposables and error listener are released on settle (no GC roots dangling)', async () => {
      // A dead promoted PTY can linger while the caller's `cancelChild`
      // finalizes, its listener closures pinning `onPostData`, `onPostSettle`,
      // `promoteArtifacts`. The onData / onExit IDisposables AND the 'error'
      // listener are released when `firePostSettle` fires, whichever path.
      const removeListenerSpy = vi.spyOn(mockPtyProcess, 'removeListener');
      const settleCalls: ShellPostPromoteSettleInfo[] = [];
      await promotePty('long-running-disposable', 'bg_pr25_dispose', {
        postPromote: {
          onData: () => {},
          onSettle: (info) => settleCalls.push(info),
        },
      });

      // The mock shares ONE disposable per onData / onExit between foreground
      // and post-promote handles: clear promote-time disposal first.
      const sharedDataDisposable = disposableOf(mockPtyProcess.onData);
      const sharedExitDisposable = disposableOf(mockPtyProcess.onExit);
      sharedDataDisposable.dispose.mockClear();
      sharedExitDisposable.dispose.mockClear();
      removeListenerSpy.mockClear();

      // onExit -> firePostSettle -> disposePostPromoteListeners.
      postPromoteExit();

      expect(settleCalls).toHaveLength(1);
      // BOTH disposables released; the 'error' listener via `removeListener`.
      expect(sharedDataDisposable.dispose).toHaveBeenCalledTimes(1);
      expect(sharedExitDisposable.dispose).toHaveBeenCalledTimes(1);
      const errorRemoves = removeListenerSpy.mock.calls.filter(
        (args: unknown[]) => args[0] === 'error',
      );
      expect(errorRemoves.length).toBeGreaterThanOrEqual(1);

      // Re-driving onExit neither re-settles (latched) nor double-disposes
      // (the slots are nulled after first disposal).
      postPromoteExit();
      expect(settleCalls).toHaveLength(1);
      expect(sharedDataDisposable.dispose).toHaveBeenCalledTimes(1);
      expect(sharedExitDisposable.dispose).toHaveBeenCalledTimes(1);

      removeListenerSpy.mockRestore();
    });

    it('PR-2.5: onData-only PTY caller has post-promote error + exit listeners (no crash, listeners disposed on exit)', async () => {
      const dataChunks: ShellOutputEvent[] = [];
      await promotePty('tail -f /dev/null', 'bg_pty_ondata_only', {
        postPromote: { onData: (event) => dataChunks.push(event) },
      });

      // The error listener exists without onSettle (else the emit throws).
      expect(() =>
        mockPtyProcess.emit('error', new Error('post-promote pty err')),
      ).not.toThrow();

      // onExit too, so natural exit cleans up data + error listeners, no crash.
      expect(mockPtyProcess.onExit.mock.calls.length).toBeGreaterThanOrEqual(2);
      postPromoteExit({ exitCode: 0 });
    });

    it('PR-2.5 backwards compat: without postPromote, no data listener is re-attached and no caller callback fires', async () => {
      // PR-2 contract, caller-visible half: without `postPromote` no data
      // listener is re-attached and no unprovided callback fires. The settle
      // listener IS attached, the only path left to release a promoted shell's
      // conout worker (#11303; see 'releases the conout worker when a promote
      // passed no postPromote handlers'); without onSettle it forwards nothing.
      const onDataCalls: ShellOutputEvent[] = [];
      const onSettleCalls: ShellPostPromoteSettleInfo[] = [];
      await promotePty('no-post-promote-handlers', 'bg_pr25_compat');
      // Only the disposed foreground onData: re-attach needs `onData`.
      expect(mockPtyProcess.onData.mock.calls.length).toBe(1);
      // TWO onExit: the disposed foreground one plus the settle/release one.
      expect(mockPtyProcess.onExit.mock.calls.length).toBe(2);
      expect(onDataCalls).toHaveLength(0);
      expect(onSettleCalls).toHaveLength(0);
    });

    it('post-exit race: PTY background-promote refuses if process.kill(pid, 0) reports the pid is gone', async () => {
      // node-pty delivers exit async after SIGCHLD, so the PTY may be gone
      // before our onExit runs; promoting would then drop that listener, miss
      // the real exit status and report `promoted: true` for a dead PTY. The
      // guard probes process.kill(pid, 0) and falls through on ESRCH.
      mockProcessKill.mockImplementationOnce((pid, signal) => {
        // Fail only the liveness probe; later kills (cleanup()) succeed.
        if (signal === 0) {
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        }
        return true;
      });
      const { result } = await simulateExecution('fast-and-cancelled', (ac) => {
        ac.abort(bg('bg_test123'));
        // The pending onExit resolves via the normal exit path.
        ptyExit({ exitCode: 0, signal: undefined });
      });

      // The normal exit shape, not the promoted one.
      expect(result.promoted).toBeUndefined();
      expect(result.exitCode).toBe(0);
      // Our listeners stayed registered: the abort handler did NOT pre-dispose
      // dataDisposable and lose the exit info.
      void disposableOf(mockPtyProcess.onData); // referenced for future expansion
    });

    it("post-promotion: ptyProcess error listener is removed via 'removeListener', NOT 'off' (regression guard for @lydell/node-pty)", async () => {
      // @lydell/node-pty's IPty only has `removeListener` (`.off` throws); the
      // EventEmitter mock accepts both, so a move to `.off()` fails silently.
      const removeListenerSpy = vi.spyOn(mockPtyProcess, 'removeListener');
      const offSpy = vi.spyOn(mockPtyProcess, 'off');

      await promotePty('tail -f /tmp/never.log', 'bg_test123');

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
      // A later child exit must not reshape the `promoted: true` result: our
      // exit disposable is disposed, and a Promise resolves only once anyway.
      const result = await promotePty('tail -f /tmp/never.log', 'bg_test123');

      expect(result.exitCode).toBeNull();
      expect(result.signal).toBeNull();
    });
  });

  // Windows tests default to win32. windowsKillPid attaches an 'error' listener
  // to the taskkill child, so cpSpawn must return an emitter (the top-level
  // beforeEach leaves it undefined). PTY cancel taskkills synchronously: a
  // clean spawnSync exit keeps the result-inspecting logging quiet.
  const stubWin32Taskkill = () => {
    mockPlatform.mockReturnValue('win32');
    mockCpSpawn.mockReturnValue(new EventEmitter());
    mockSpawnSync.mockReturnValue({ status: 0 });
  };

  describe('Windows process cleanup (#5873)', () => {
    // Under ConPTY, ptyProcess.kill() leaves the pwsh tree (microsoft/node-pty
    // #333), so PTY paths reap pwsh via taskkill (tree on cancel, shell pid
    // only on normal completion) lest idle pwsh processes pile up until OOM.
    beforeEach(stubWin32Taskkill);

    // Register the PTY as active, run the process-exit cleanup, unregister.
    const exitCleanup = () => {
      const pid = mockPtyProcess.pid;
      ShellExecutionService['activePtys'].set(pid, {
        ptyProcess: mockPtyProcess,
        headlessTerminal: { dispose: vi.fn() },
      } as never);
      ShellExecutionService.cleanup();
      ShellExecutionService['activePtys'].delete(pid);
      return pid;
    };

    it('cancel on win32 tree-kills via taskkill, with a ptyProcess.kill fallback', async () => {
      await cancelPty();

      // Cancel tree-kills (/t) SYNCHRONOUSLY (spawnSync).
      expect(mockSpawnSync).toHaveBeenCalledWith(...ptyTaskkill());
      // The async finalizer reap ALSO tree-kills on cancel, asserted positively
      // so dropping it or forcing cancelKillDispatched=false fails here...
      expect(mockCpSpawn).toHaveBeenCalledWith(...ptyTaskkill());
      // ...never downgrading to a shell-only kill that strands the descendants.
      expect(mockCpSpawn).not.toHaveBeenCalledWith(...ptyTaskkill(false));
      // ptyProcess.kill() still runs, so a taskkill that cannot launch still
      // tears down the ConPTY host and onExit fires (no hang).
      expect(mockPtyProcess.kill).toHaveBeenCalled();
      // The race fix (#5873): the sync taskkill enumerates/kills the tree
      // BEFORE ptyProcess.kill() fires ClosePseudoConsole.
      expect(mockSpawnSync.mock.invocationCallOrder[0]).toBeLessThan(
        mockPtyProcess.kill.mock.invocationCallOrder[0],
      );
    });

    it('normal completion on win32 reaps a still-alive pty by shell pid only (no /t)', async () => {
      // Default liveness mock: node-pty reported exit but pwsh is still alive.

      await runEchoHi();

      // Shell pid only (no /t), so a child the command detached on purpose
      // (e.g. Start-Process) survives. See #5873.
      expect(mockCpSpawn).toHaveBeenCalledWith(...ptyTaskkill(false));
      expect(mockCpSpawn).not.toHaveBeenCalledWith(...ptyTaskkill());
    });

    it('normal completion on win32 swallows a taskkill launch error (no crash)', async () => {
      // windowsKillPid's no-op 'error' listener keeps a failed taskkill launch
      // (an async 'error' event, not a throw) from crashing the CLI. See #5873.
      const taskkillProc = new EventEmitter();
      mockCpSpawn.mockReturnValue(taskkillProc);

      await runEchoHi();

      // Without the finalizer reap's listener this emit re-raises (the crash).
      expect(() =>
        taskkillProc.emit('error', new Error('spawn taskkill ENOENT')),
      ).not.toThrow();
    });

    it('normal completion on win32 does NOT taskkill when the pty already exited', async () => {
      // The liveness probe throws (process gone), so the reap is skipped: it
      // could kill a reused pid.
      await withDeadShell(async () => {
        await runEchoHi();

        expectNoTaskkill();
      });
    });

    it('normal completion on non-win32 never taskkills', async () => {
      mockPlatform.mockReturnValue('linux');
      await runEchoHi();

      expectNoTaskkill();
    });

    it('exit cleanup on win32 tree-kills via taskkill and tears down the host', () => {
      mockSpawnSync.mockReturnValue({ error: undefined });

      const pid = exitCleanup();

      expect(mockSpawnSync).toHaveBeenCalledWith(...taskkill(pid));
      // The ConPTY host is torn down unconditionally, alongside the tree-kill.
      expect(mockPtyProcess.kill).toHaveBeenCalled();
    });

    it('exit cleanup on win32 still tears down the host when taskkill exits non-zero', () => {
      // taskkill launched but failed (access denied, or pid gone): an undefined
      // result.error must not count as success and skip the host teardown.
      mockSpawnSync.mockReturnValue({ status: 1, error: undefined });

      exitCleanup();

      expect(mockPtyProcess.kill).toHaveBeenCalled();
    });

    it('cancel on win32 still resolves when ptyProcess.kill throws', async () => {
      // performCancelKill's host-teardown fallback is wrapped in try/catch: a
      // throwing kill (pty already gone) must not break the cancel. See #5873.
      mockPtyProcess.kill.mockImplementation(() => {
        throw new Error('pty already gone');
      });

      await cancelPty();

      expect(mockPtyProcess.kill).toHaveBeenCalled();
    });

    it('cancel on win32 with an already-dead shell skips the finalizer reap', async () => {
      // The common healthy-ConPTY cancel: performCancelKill already killed the
      // shell, so the finalizer's liveness check fails (ESRCH). See #5873.
      await withDeadShell(async () => {
        await cancelPty();

        // The sync tree-kill still runs, but no async finalizer taskkill.
        expect(mockSpawnSync).toHaveBeenCalledWith(...ptyTaskkill());
        expectNoTaskkill();
      });
    });

    it('exit cleanup falls back to ptyProcess.kill when taskkill spawnSync throws', () => {
      // killPty must swallow a sync spawnSync throw (arg/setup failure) and
      // still tear down the host. See #5873.
      mockSpawnSync.mockImplementationOnce(() => {
        throw new Error('spawnSync EACCES');
      });

      exitCleanup();

      expect(mockPtyProcess.kill).toHaveBeenCalled();
    });

    it('exit cleanup tree-kills child_process children via the absolute taskkill', () => {
      const childPid = 54321;
      ShellExecutionService['activeChildProcesses'].add(childPid);

      ShellExecutionService.cleanup();
      ShellExecutionService['activeChildProcesses'].delete(childPid);

      // The bare 'taskkill' name reopens the binary-planting hole. #5873.
      expect(mockSpawnSync).toHaveBeenCalledWith(...taskkill(childPid));
    });

    it('win32 taskkill is invoked by absolute System32 path, not the bare name', async () => {
      await runPty('echo hi');

      // Never the bare 'taskkill': spawn resolves it through PATH/CWD, where a
      // planted taskkill.exe/.bat could hijack it. See #5873.
      const cmd = mockCpSpawn.mock.calls.find((c) =>
        /taskkill/i.test(String(c[0])),
      )?.[0];
      expect(cmd).toBe(TASKKILL);
      expect(cmd).toMatch(/^[A-Za-z]:\\.*\\System32\\taskkill\.exe$/i);
      expect(cmd).not.toBe('taskkill');
    });

    it('a late abort after a normal exit does NOT tree-kill (no cancel retro-flag)', async () => {
      const { result } = await simulateExecution('echo hi', (ac) => {
        // A normal exit FIRST, then an unrelated abort in the finalize window:
        // performCancelKill never ran, so the reap stays shell-pid-only and
        // detached children survive.
        ptyExit();
        ac.abort();
      });

      expect(result.exitCode).toBe(0);
      expect(mockCpSpawn).toHaveBeenCalledWith(...ptyTaskkill(false));
      expect(mockCpSpawn).not.toHaveBeenCalledWith(...ptyTaskkill());
    });

    it('win32 promoted shell reaps its lingering pwsh on natural exit (shell-pid-only)', async () => {
      const settleCalls: ShellPostPromoteSettleInfo[] = [];

      await promotePty('long-running-command', 'bg_5873_reap', {
        postPromote: { onSettle: (info) => settleCalls.push(info) },
      });

      // Natural exit reaps the lingering ConPTY shell by pid only (detached
      // children survive); only the foreground finalizer used to reap, so
      // backgrounded shells leaked pwsh. See #5873.
      postPromoteExit();

      expect(settleCalls).toHaveLength(1);
      expect(mockCpSpawn).toHaveBeenCalledWith(...ptyTaskkill(false));
      expect(mockCpSpawn).not.toHaveBeenCalledWith(...ptyTaskkill());
    });

    it('win32 promoted shell reaps on natural exit even with onData only (no onSettle)', async () => {
      // onData only: the reap must fire BEFORE firePostSettle's
      // `!postPromote?.onSettle` early return. See #5873.
      await promotePty('long-running-command', 'bg_5873_ondata', {
        postPromote: { onData: () => {} },
      });

      postPromoteExit();

      expect(mockCpSpawn).toHaveBeenCalledWith(...ptyTaskkill(false));
      // The ConPTY release (#11303) sits above that early return too; below it,
      // every onData-only backgrounded command leaks its conout worker. The
      // real native kill no-ops after a natural exit (see releaseConPtyHost).
      expectConPtyReleased();
    });

    it('win32 promoted shell skips the post-settle reap when the pty already exited', async () => {
      await promotePty('long-running-command', 'bg_5873_settle_esrch', {
        postPromote: { onSettle: () => {} },
      });
      // Promoted while alive; now the shell is gone (ESRCH), so like the
      // foreground finalizer the reap is skipped: no taskkill of a possibly
      // reused pid. See #5873.
      await withDeadShell(() => {
        postPromoteExit();
        expectNoTaskkill();
      });
    });
  });

  describe('Windows ConPTY release (#11303)', () => {
    // Bundled ConPTY frees its host after spawn, but node-pty's JS leaves the
    // conout worker running after a natural exit (inbox users such as web
    // terminals leave both). The release never uses ptyProcess.kill(): inbox
    // can kill a recycled pid via its helper, bundled waits for more output
    // before disposing the worker. Worker release only; host lifecycle for the
    // shell path is in the bundled ConPTY tests below.
    beforeEach(stubWin32Taskkill);

    it('releases the conout worker on a clean win32 completion (the leaking path)', async () => {
      // A clean exit (shell gone) correctly skips the taskkill reap, and that
      // is exactly the path that leaked: the worker must still be released,
      // never through kill() (see the block comment above).
      await withDeadShell(async () => {
        await runEchoHi();

        expectNoTaskkill();
        expectConPtyReleased();
        expect(mockPtyProcess.kill).not.toHaveBeenCalled();
      });
    });

    it('releases them even when the shell lingers and taskkill fires', async () => {
      // Default liveness mock: node-pty reported exit but the shell lingers.
      await runEchoHi();

      expect(mockCpSpawn).toHaveBeenCalledWith(...ptyTaskkill(false));
      expectConPtyReleased();
    });

    it('does not fail the result when the native pty kill throws', async () => {
      mockPtyNativeKill.mockImplementation(() => {
        throw new Error('pty already gone');
      });

      const result = await runEchoHi();

      expect(result.error).toBeNull();
      // A throwing host close must not skip the worker teardown.
      expect(mockConoutWorkerDispose).toHaveBeenCalled();
    });

    it('still drops the pid from activePtys when the conout worker dispose throws', async () => {
      // releaseConPtyHost's guard around _conoutSocketWorker.dispose(): the
      // release runs in finalize()'s finally just before activePtys.delete, so
      // an escaping throw leaves a finished pid registered for the exit-time
      // `taskkill /f /t`, against a pid Windows may have recycled.
      mockConoutWorkerDispose.mockImplementation(() => {
        throw new Error('dispose boom');
      });

      await runEchoHi();

      // Direct witness, independent of how the exit reap spawns taskkill:
      // finalize()'s finally (release + activePtys.delete) has run once the
      // awaited result resumes. Drop the try/catch around
      // _conoutSocketWorker.dispose() in conpty-host.ts and this turns true.
      expect(ShellExecutionService['activePtys'].has(mockPtyProcess.pid)).toBe(
        false,
      );

      ShellExecutionService.cleanup();
      ShellExecutionService['activePtys'].delete(mockPtyProcess.pid);

      // End to end: the pid is gone, so exit cleanup has nothing to tree-kill.
      expect(mockSpawnSync).not.toHaveBeenCalledWith(...ptyTaskkill());
    });

    it('degrades to the pre-fix leak, not to kill(), if node-pty internals change', async () => {
      delete (mockPtyProcess as unknown as { _agent?: unknown })._agent;

      await runEchoHi();

      // A leak is cured by restarting the CLI; killing a recycled pid is not,
      // so the fallback must never be ptyProcess.kill().
      expect(mockPtyProcess.kill).not.toHaveBeenCalled();
    });

    it('still disposes the worker when only the native-kill shape drifts', async () => {
      // A node-pty bump renaming _pty / _ptyNative must not cost the worker
      // dispose, today the only teardown that frees anything (a fused guard
      // used to skip both; see releaseConPtyHost).
      (mockPtyProcess as unknown as { _agent: unknown })._agent = {
        _conoutSocketWorker: { dispose: mockConoutWorkerDispose },
      };

      await runEchoHi();

      expect(mockConoutWorkerDispose).toHaveBeenCalled();
      // Never kill(): a leak is recoverable, killing a recycled pid is not.
      expect(mockPtyProcess.kill).not.toHaveBeenCalled();
    });

    it('does not close the pseudo-console twice and still disposes the bundled worker after cancel', async () => {
      // performCancelKill closes the pseudo-console itself; bundled ConPTY
      // waits for output before disposing the worker, so the finalizer skips
      // the native close but still starts the worker's drain timeout.
      await cancelPty('sleep 100');

      expect(mockPtyProcess.kill).toHaveBeenCalled();
      expect(mockPtyNativeKill).not.toHaveBeenCalled();
      expect(mockConoutWorkerDispose).toHaveBeenCalledOnce();
    });

    it('never touches the pty on non-win32 (no ConPTY host, no conout worker)', async () => {
      mockPlatform.mockReturnValue('linux');
      await runEchoHi();

      expect(mockPtyNativeKill).not.toHaveBeenCalled();
      expect(mockConoutWorkerDispose).not.toHaveBeenCalled();
      expect(mockPtyProcess.kill).not.toHaveBeenCalled();
    });

    it('releases the conout worker of a promoted shell when it settles', async () => {
      await promotePty('long-running-command', 'bg_11303_settle', {
        postPromote: { onSettle: () => {} },
      });
      // Promote itself must not tear anything down — the caller owns the child.
      expect(mockPtyNativeKill).not.toHaveBeenCalled();

      postPromoteExit();

      // Promote dropped the pid from activePtys, out of cleanup()'s reach:
      // settle is the last chance.
      expectConPtyReleased();
    });

    it('releases the conout worker when a promote passed no postPromote handlers', async () => {
      await promotePty('long-running-command', 'bg_11303_no_handlers');
      // Promote itself must not tear anything down — the caller owns the child.
      expect(mockPtyNativeKill).not.toHaveBeenCalled();

      // The settle listener is attached even without postPromote, the only
      // path still reaching this PTY (promote dropped the pid and disposed
      // exitDisposable); gating it on `if (postPromote)` must turn this red.
      expect(mockPtyProcess.onExit.mock.calls.length).toBe(2);
      postPromoteExit();

      expectConPtyReleased();
    });

    it('still releases after a cancel that landed before the terminal was ready', async () => {
      // WindowsTerminal.kill() defers its teardown until `_isReady` (the conout
      // socket's first byte). A cancel before then (Esc during pwsh startup,
      // `timeout /t 30 >nul`) may never tear down, so the finalizer still owes
      // the worker; counting it as released (the old code) fails both asserts.
      (mockPtyProcess as unknown as { _isReady: boolean })._isReady = false;

      await cancelPty('timeout /t 30');

      expect(mockPtyProcess.kill).toHaveBeenCalled();
      expectConPtyReleased();
    });
  });

  describe('Windows bundled ConPTY backend (#11303)', () => {
    // The inbox ConPTY backend orphans its `conhost.exe --headless` on natural
    // exit (microsoft/node-pty#965); #11303 measured that growth gone once
    // node-pty loads the conpty.dll it ships instead of Windows' own.

    let capturedReplyListener: ((data: string) => void) | undefined;

    // Capture the forwarder for the error-containment and platform-gate tests.
    // The device-attributes test below uses xterm's real parser and emitter.
    class ReplyCapturingTerminal extends pkg.Terminal {
      override onData: pkg.IEvent<string> = (listener) => {
        capturedReplyListener = listener;
        return { dispose: () => undefined };
      };
    }

    beforeEach(() => {
      mockPlatform.mockReturnValue('win32');
      capturedReplyListener = undefined;
    });

    it('spawns PTYs with the bundled ConPTY backend on Windows', async () => {
      await runPty('echo hi');

      expect(mockPtySpawn.mock.calls[0][2]).toMatchObject({
        useConptyDll: true,
      });
    });

    it('falls back to child_process when the bundled ConPTY spawn throws on Windows', async () => {
      // node-pty throws synchronously from spawn when its conpty.dll is missing
      // or fails to load, never with `posix_spawnp failed`. Without the
      // spawn-phase branch in executeWithPty's catch this resolved exitCode 1 /
      // executionMethod 'none' and the child_process fallback never ran.
      mockPtySpawn.mockImplementationOnce(() => {
        throw new Error('Failed to load conpty.dll, error code: 126');
      });
      const fallbackChild = makeChild(4242, false);
      mockCpSpawn.mockReturnValue(fallbackChild);

      try {
        const { result } = await simulateExecution('echo hi', () => {
          fallbackChild.stdout?.emit('data', Buffer.from('FALLBACK_MARKER'));
          fallbackChild.emit('exit', 0, null);
          fallbackChild.emit('close', 0, null);
        });

        expect(mockCpSpawn).toHaveBeenCalled();
        expect(result.executionMethod).toBe('child_process');
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain('FALLBACK_MARKER');
        // The sandbox-specific PTY warning is POSIX wording and must not be
        // emitted for a Windows DLL-load failure.
        expect(
          onOutputEventMock.mock.calls.some(
            ([event]) =>
              event.type === 'data' &&
              String(event.chunk).includes('sandbox restrictions'),
          ),
        ).toBe(false);
      } finally {
        // vi.clearAllMocks() does not drop implementations, so restore the
        // default (undefined) this describe block's other tests rely on.
        mockCpSpawn.mockReturnValue(undefined);
      }
    });

    it('does not run the fallback after the PTY has already spawned', async () => {
      let pidReads = 0;
      Object.defineProperty(mockPtyProcess, 'pid', {
        configurable: true,
        get: () => {
          pidReads++;
          if (pidReads === 1) return 12345;
          throw new Error('post-spawn handle setup failed');
        },
      });

      try {
        const handle = await exec('echo hi');
        const result = await handle.result;

        expect(mockPtySpawn).toHaveBeenCalledOnce();
        expect(mockCpSpawn).not.toHaveBeenCalled();
        expect(result.executionMethod).toBe('none');
        expect(result.error?.message).toBe('post-spawn handle setup failed');
      } finally {
        ShellExecutionService['activePtys'].delete(12345);
      }
    });

    it('leaves the inbox ConPTY backend alone off Windows', async () => {
      mockPlatform.mockReturnValue('linux');
      await runPty('echo hi');

      expect(mockPtySpawn.mock.calls[0][2]).toMatchObject({
        useConptyDll: false,
      });
    });

    it("writes xterm's device-attributes reply back to the PTY on Windows", async () => {
      // Bundled ConPTY answers no queries itself, so an unanswered DA probe
      // stalls the shell for its full ~2s timeout; the forwarder must carry
      // the reply generated by xterm's real parser back to the PTY.

      await simulateExecution('echo hi', async () => {
        ptyData('\x1b[c');
        await vi.waitFor(() => {
          expect(mockPtyProcess.write).toHaveBeenCalledWith('\x1b[?1;2c');
        });
        ptyExit();
      });
    });

    it('drops a terminal query reply whose PTY write throws on Windows', async () => {
      // A reply racing shell exit finds a dead PTY. The forwarder's try/catch
      // has to contain that throw: deleting it lets the error escape the
      // terminal's onData listener and this test goes red.
      mockLoadXtermHeadless.mockResolvedValueOnce({
        Terminal: ReplyCapturingTerminal,
      });
      mockPtyProcess.write.mockImplementationOnce(() => {
        throw new Error('pty gone');
      });

      const { result } = await simulateExecution('echo hi', () => {
        capturedReplyListener!('\x1b[?64;1;22c');
        ptyExit();
      });

      expect(mockPtyProcess.write).toHaveBeenCalledWith('\x1b[?64;1;22c');
      expect(result.exitCode).toBe(0);
      expect(result.error).toBeNull();
    });

    it('registers no terminal reply forwarder off Windows', async () => {
      // The gate must not change POSIX behavior at all: no onData
      // subscription, so nothing can reach pty.write.
      mockPlatform.mockReturnValue('linux');
      mockLoadXtermHeadless.mockResolvedValueOnce({
        Terminal: ReplyCapturingTerminal,
      });

      await runPty('echo hi');

      expect(capturedReplyListener).toBeUndefined();
      expect(mockPtyProcess.write).not.toHaveBeenCalled();
    });
  });

  describe('Binary Output', () => {
    it('streams byte-exact output when the caller requests raw chunks', async () => {
      const stdout = Buffer.from([0x00, 0xff, 0x61]);
      const stderr = Buffer.from([0x62, 0x00, 0xfe]);
      const child = pipe();
      const handle = await launchWith(
        { ...launch(), args: [], env: {} },
        false,
        {},
        { streamStdout: true, streamRawOutput: true },
      );
      child.stdout.emit('data', stdout);
      child.stderr.emit('data', stderr);
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
      await handle.result;

      expect(onOutputEventMock.mock.calls.map(([event]) => event)).toEqual([
        { type: 'raw_data', chunk: stdout, stream: 'stdout' },
        { type: 'raw_data', chunk: stderr, stream: 'stderr' },
      ]);
      expect(mockIsBinary).not.toHaveBeenCalled();
    });

    it('should detect binary output and switch to progress events', async () => {
      mockIsBinary.mockReturnValueOnce(true);
      const binaryChunk1 = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const binaryChunk2 = Buffer.from([0x0d, 0x0a, 0x1a, 0x0a]);

      const { result } = await runPty('cat image.png', [
        binaryChunk1,
        binaryChunk2,
      ]);

      expect(result.rawOutput).toEqual(
        Buffer.concat([binaryChunk1, binaryChunk2]),
      );
      expect(onOutputEventMock).toHaveBeenCalledTimes(3);
      const [[detected], [first], [second]] = onOutputEventMock.mock.calls;
      expect(detected).toEqual({ type: 'binary_detected' });
      expect(first).toEqual({ type: 'binary_progress', bytesReceived: 4 });
      expect(second).toEqual({ type: 'binary_progress', bytesReceived: 8 });
    });

    it('should not emit data events after binary is detected', async () => {
      mockIsBinary.mockImplementation((buffer) => buffer.includes(0x00));

      await runPty('cat mixed_file', [
        Buffer.from([0x00, 0x01, 0x02]),
        Buffer.from('more text'),
      ]);

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
    afterEach(() => {
      useShell(BASH_SHELL);
    });

    it.each<[string, string[], string, string | string[]]>([
      [
        'should use cmd.exe on Windows',
        CMD_SHELL,
        'dir "foo bar"',
        `/d /s /c ${CHCP} 65001 >nul 2>nul & dir "foo bar"`,
      ],
      [
        'should not apply UTF-8 prefix for Git Bash on Windows',
        GIT_BASH_SHELL,
        'echo hello',
        ['-c', 'echo hello'],
      ],
      [
        'should use PowerShell on Windows with array args and UTF-8 prefix',
        POWERSHELL_SHELL,
        PS_COMMAND,
        PS_UTF8_ARGS,
      ],
    ])('%s', async (_title, shell, command, args) => {
      mockPlatform.mockReturnValue('win32');
      useShell(shell);
      await runPty(command);

      expect(mockPtySpawn).toHaveBeenCalledWith(
        shell[0],
        args,
        expect.any(Object),
      );
    });

    it('should normalize PATH-like env keys on Windows for pty execution', async () => {
      mockPlatform.mockReturnValue('win32');
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      useShell(CMD_SHELL);
      setupConflictingPathEnv();

      await runPty('dir');

      expectNormalizedWindowsPathEnv(mockPtySpawn.mock.calls[0][2].env);
    });

    it('does not inject Unix pager defaults into Windows pty env when unset', async () => {
      mockPlatform.mockReturnValue('win32');
      useShell(CMD_SHELL);

      await runPty('echo hello', [], shellExecutionConfigWithoutPager);

      const spawnOptions = mockPtySpawn.mock.calls[0][2];
      expect(spawnOptions.env['PAGER']).toBe('');
      expect(spawnOptions.env['GIT_PAGER']).toBe('');
    });

    it('preserves explicit pager configuration in Windows pty env', async () => {
      mockPlatform.mockReturnValue('win32');
      useShell(CMD_SHELL);

      await runPty('echo hello');

      const spawnOptions = mockPtySpawn.mock.calls[0][2];
      expect(spawnOptions.env['PAGER']).toBe('cat');
      expect(spawnOptions.env['GIT_PAGER']).toBe('cat');
    });

    it('should use bash on Linux', async () => {
      mockPlatform.mockReturnValue('linux');
      await runPty('ls "foo bar"');

      expect(mockPtySpawn).toHaveBeenCalledWith(
        'bash',
        ['-c', 'ls "foo bar"'],
        expect.any(Object),
      );
    });
  });

  describe('AnsiOutput rendering', () => {
    it('should call onOutputEvent with AnsiOutput when showColor is true', async () => {
      const mockAnsiOutput = [
        [{ text: 'hello', fg: '#ffffff', bg: '#000000' }],
      ];
      mockSerializeTerminalToObject.mockReturnValue(mockAnsiOutput);

      await runPty('ls --color=auto', ['a\u001b[31mred\u001b[0mword'], {
        ...shellExecutionConfig,
        showColor: true,
        defaultFg: '#ffffff',
        defaultBg: '#000000',
      });

      expect(mockSerializeTerminalToObject).toHaveBeenCalledWith(
        expect.anything(), // The terminal object
      );

      expectDataEvent(mockAnsiOutput);
    });

    it('does not re-emit live output when only soft-wrap segmentation changes', async () => {
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

      await runPty('narrow-output', ['abcdefgh', '\r'], {
        ...shellExecutionConfig,
        showColor: true,
      });

      const dataEvents = emittedData();
      expect(dataEvents).toHaveLength(1);
      expect(dataEvents[0][0]).toEqual(dataEvent(firstWrappedOutput));
    });

    it('should call onOutputEvent with AnsiOutput when showColor is false', async () => {
      await runPty('ls --color=auto', ['a\u001b[31mred\u001b[0mword']);

      expectDataEvent(createExpectedAnsiOutput('aredword'));
    });

    it('does not re-emit default plain live output when only soft-wrap segmentation changes', async () => {
      await simulateExecution(
        'narrow-output',
        async () => {
          ptyData('abcdefgh');
          await vi.waitUntil(() => emittedData().length > 0);

          ShellExecutionService.resizePty(mockPtyProcess.pid, 2, 4);
          ptyData('\r');
          ptyExit();
        },
        {
          ...shellExecutionConfig,
          terminalWidth: 4,
          terminalHeight: 4,
          disableDynamicLineTrimming: false,
        },
      );

      const dataEvents = emittedData();
      expect(dataEvents).toHaveLength(1);
      const chunk = (dataEvents[0][0] as { chunk: AnsiOutput }).chunk;
      expect(chunk.map((line) => line[0]?.text).filter(Boolean)).toEqual([
        'abcd',
        'efgh',
      ]);
    });

    it('should handle multi-line output correctly when showColor is false', async () => {
      await runPty('ls --color=auto', [
        'line 1\n\u001b[32mline 2\u001b[0m\nline 3',
      ]);

      expectDataEvent(createExpectedAnsiOutput(['line 1', 'line 2', 'line 3']));
    });
  });
});

describe('ShellExecutionService child_process fallback', () => {
  let mockChildProcess: MockChild;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBinary.mockReturnValue(false);
    mockPlatform.mockReturnValue('linux');
    mockGetPty.mockResolvedValue(null);
    onOutputEventMock = vi.fn();
    mockChildProcess = makeChild(12345);
    mockCpSpawn.mockReturnValue(mockChildProcess);
  });

  type Simulation = (cp: MockChild, ac: AbortController) => void;

  // Start an execution, let spawn settle, drive the child, await the result.
  const simulateExecution = async (
    command: string,
    simulation: Simulation,
    options: ShellExecuteOptions = {},
    config: ShellExecutionConfig = shellExecutionConfig,
  ) => {
    const abortController = new AbortController();
    const handle = await exec(command, {
      signal: abortController.signal,
      config,
      options,
    });

    await new Promise((resolve) => process.nextTick(resolve));
    simulation(mockChildProcess, abortController);
    const result = await handle.result;
    return { result, handle, abortController };
  };

  const emitOut = (
    data: string | Buffer,
    stream: 'stdout' | 'stderr' = 'stdout',
  ) =>
    mockChildProcess[stream]?.emit(
      'data',
      typeof data === 'string' ? Buffer.from(data) : data,
    );
  const finish = (
    code: number | null = 0,
    signal: NodeJS.Signals | null = null,
  ) => {
    mockChildProcess.emit('exit', code, signal);
    mockChildProcess.emit('close', code, signal);
  };
  // Stream stdout chunks, then exit and close cleanly.
  const runChunks = (
    command: string,
    chunks: Array<string | Buffer>,
    config: ShellExecutionConfig = shellExecutionConfig,
    options?: ShellExecuteOptions,
  ) =>
    simulateExecution(
      command,
      () => {
        chunks.forEach((chunk) => emitOut(chunk));
        finish();
      },
      options,
      config,
    );
  const groupKill = (signal?: string) => [-mockChildProcess.pid!, signal];
  const dataChunksOf = (events: Array<{ type: string; chunk?: unknown }>) =>
    events.filter((e) => e.type === 'data').map((e) => e.chunk);

  /**
   * Executes under a raw-output capture with a 64-byte preview; `drive` emits
   * the child's output, then both streams end and the child exits with `code`.
   */
  const runCaptured = async (command: string, drive: () => void, code = 0) => {
    for (const stream of [mockChildProcess.stdout!, mockChildProcess.stderr!]) {
      Object.assign(stream, { pause: vi.fn(), resume: vi.fn() });
    }
    const capture = {
      write: vi.fn(async () => {}),
      finish: vi.fn(async () => {}),
      setStarted: vi.fn(),
      setProcessResult: vi.fn(),
    };
    const handle = await ShellExecutionService.execute(
      command,
      '/test/dir',
      onOutputEventMock,
      new AbortController().signal,
      true,
      { ...shellExecutionConfig, maxBufferedOutputBytes: 64 },
      { rawCapture: capture },
    );
    drive();
    mockChildProcess.stdout!.emit('end');
    mockChildProcess.stderr!.emit('end');
    finish(code);
    return { result: await handle.result, capture };
  };

  it('keeps a bounded head and tail preview while capturing every raw byte', async () => {
    const bytes = Buffer.from(`HEAD${'x'.repeat(100)}TAIL`);
    const { result, capture } = await runCaptured('printf output', () =>
      emitOut(bytes),
    );
    expect(capture.write).toHaveBeenCalledWith('stdout', bytes);
    expect(result.rawOutput.byteLength).toBe(32);
    expect(result.output).toContain('HEAD');
    expect(result.output).toContain('TAIL');
    expect(result.output).toContain('Middle output omitted');
    expect(result.output).not.toContain('x'.repeat(100));
  });

  it('keeps recent stderr visible after later stdout fills the preview tail', async () => {
    const { result, capture } = await runCaptured(
      'failing build',
      () => {
        emitOut('HEAD' + 'x'.repeat(80));
        emitOut('ERR: 42\n', 'stderr');
        emitOut('y'.repeat(100) + 'TAIL');
      },
      3,
    );
    expect(result.output).toContain('HEAD');
    expect(result.output).toContain('TAIL');
    expect(result.output).toContain('[Recent stderr]\nERR: 42');
    expect(capture.write).toHaveBeenCalledWith(
      'stderr',
      Buffer.from('ERR: 42\n'),
    );
  });

  it('decodes a combined preview tail that starts inside a UTF-8 character', async () => {
    const stdout = Buffer.from(`${'错'.repeat(30)}END`);
    const { result, capture } = await runCaptured('printf output', () =>
      emitOut(stdout),
    );
    const tail = result.output.split('managed capture.]\n')[1];
    expect(tail).toMatch(/^错+END$/);
    expect(capture.write).toHaveBeenCalledWith('stdout', stdout);
  });

  it('decodes a stderr preview that starts inside a UTF-8 character', async () => {
    const stderr = Buffer.from(`${'错'.repeat(30)}END\n`);
    const { result, capture } = await runCaptured(
      'failing build',
      () => {
        emitOut('HEAD' + 'x'.repeat(80));
        emitOut(stderr, 'stderr');
        emitOut('y'.repeat(100));
      },
      3,
    );
    expect(result.output.split('[Recent stderr]\n')[1]).toBe('错END');
    expect(capture.write).toHaveBeenCalledWith('stderr', stderr);
  });

  it('keeps a stdout-only preview complete within its byte limit', async () => {
    const stdout = Buffer.from('x'.repeat(60));
    const { result, capture } = await runCaptured('printf output', () =>
      emitOut(stdout),
    );
    expect(result.output).toBe(stdout.toString());
    expect(capture.write).toHaveBeenCalledWith('stdout', stdout);
  });

  describe('child environment sanitization (#6601)', () => {
    it('strips Qwen-internal daemon secrets from the child_process env while keeping user vars and third-party credentials', async () => {
      setSecretEnv();
      await runChunks('echo hi', []);
      expectSanitizedEnv(mockCpSpawn);
    });
  });

  describe('Successful Execution', () => {
    it('should execute a command and capture stdout and stderr', async () => {
      const { result, handle } = await simulateExecution('ls -l', () => {
        emitOut('file1.txt\n');
        emitOut('a warning', 'stderr');
        finish();
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

      expect(onOutputEventMock).toHaveBeenCalledWith(
        dataEvent('file1.txt\na warning'),
      );
    });

    it('should strip ANSI codes from output', async () => {
      const { result } = await runChunks('ls --color=auto', [
        'a\u001b[31mred\u001b[0mword',
      ]);

      expect(result.output.trim()).toBe('aredword');
      expectDataEvent('aredword');
    });

    it('should correctly decode multi-byte characters split across chunks', async () => {
      const multiByteChar = Buffer.from('你好', 'utf-8');
      const { result } = await runChunks('echo "你好"', [
        multiByteChar.slice(0, 2),
        multiByteChar.slice(2),
      ]);
      expect(result.output.trim()).toBe('你好');
    });

    it('bounds buffered child_process output before building the final string', async () => {
      const handle = await exec('large-output', {
        usePty: false,
        config: { ...shellExecutionConfig, maxBufferedOutputBytes: 10 },
      });

      await new Promise((resolve) => process.nextTick(resolve));
      emitOut('12345678');
      emitOut('abcdefg');
      finish();

      const result = await handle.result;

      expect(result.rawOutput.length).toBe(10);
      expect(result.output).toContain('12345678ab');
      expect(result.output).toContain(CAP_NOTICE);
      expect(result.output).not.toContain('cdefg');
      expect(onOutputEventMock).toHaveBeenCalledWith(
        dataEvent(expect.stringContaining(CAP_NOTICE)),
      );
    });

    it('does not add a capture-limit notice at the exact child_process buffer boundary', async () => {
      const { result } = await runChunks('exact-output', ['1234567890'], {
        ...shellExecutionConfig,
        maxBufferedOutputBytes: 10,
      });

      expect(result.rawOutput.length).toBe(10);
      expect(result.output).toBe('1234567890');
      expect(result.output).not.toContain(CAP_NOTICE);
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
        const { result } = await runChunks(
          'invalid-limit',
          ['1234567890abcde'],
          {
            ...shellExecutionConfig,
            maxBufferedOutputBytes: configuredValue as unknown as number,
          },
        );

        expect(result.rawOutput.length).toBe(15);
        expect(result.output).toBe('1234567890abcde');
        expect(result.output).not.toContain(CAP_NOTICE);
      },
    );

    it('emits live snapshots before exit while retaining the buffered final result', async () => {
      const { result } = await simulateExecution(
        'live-buffered-output',
        () => {
          emitOut('ready\n');
          expect(onOutputEventMock).toHaveBeenCalledWith(dataEvent('ready\n'));
          emitOut('done\n');
          expect(onOutputEventMock).toHaveBeenLastCalledWith(
            dataEvent('ready\ndone\n'),
          );
          finish();
        },
        {},
        { ...shellExecutionConfig, streamBufferedOutput: true },
      );
      expect(result.output).toBe('ready\ndone');
    });

    it('bounds cumulative previews while preserving complete stdout and stderr', async () => {
      const stdout = 'x'.repeat(200000);
      const { result } = await simulateExecution(
        'bounded-preview',
        () => {
          emitOut(stdout);
          emitOut('\u001b[31merror\u001b[0m', 'stderr');
          expect(onOutputEventMock).toHaveBeenLastCalledWith(
            dataEvent('x'.repeat(65530) + '\nerror'),
          );
          emitOut('end');
          expect(onOutputEventMock).toHaveBeenLastCalledWith(
            dataEvent('x'.repeat(65527) + 'end\nerror'),
          );
          finish();
        },
        {},
        { ...shellExecutionConfig, streamBufferedOutput: true },
      );
      expect(result.output).toBe(stdout + 'end\nerror');
    });

    it('keeps streaming both pipes after exit until stdio closes', async () => {
      await simulateExecution(
        'monitor',
        (cp) => {
          emitOut('before');
          cp.emit('exit', 0, null);
          emitOut('stderr after exit', 'stderr');
          emitOut('stdout after exit');
          cp.emit('close', 0, null);
        },
        { streamStdout: true },
      );
      expect(onOutputEventMock.mock.calls.map(([event]) => event)).toEqual([
        { type: 'data', chunk: 'before', stream: 'stdout' },
        { type: 'data', chunk: 'stderr after exit', stream: 'stderr' },
        { type: 'data', chunk: 'stdout after exit', stream: 'stdout' },
      ]);
    });

    it('flushes a trailing partial character for streaming text', async () => {
      await runChunks(
        'partial-character',
        [Buffer.from([0xe2])],
        shellExecutionConfig,
        { streamStdout: true },
      );
      expect(onOutputEventMock).toHaveBeenLastCalledWith(stdoutEvent('\ufffd'));
    });

    it('does not settle a streaming execution at exit while stdio is still draining', async () => {
      // Settling at 'exit' races the consumer's own settle (a background task
      // closes its output file on resolve) and drops chunks arriving before
      // 'close'. Settlement waits for 'close'; reverting to 'exit' turns red.
      const handle = await exec('monitor', { options: { streamStdout: true } });
      await new Promise((resolve) => process.nextTick(resolve));
      emitOut('before');
      mockChildProcess.emit('exit', 0, null);
      let settledEarly = false;
      void handle.result.then(() => {
        settledEarly = true;
      });
      // Had the result resolved during the sync 'exit' emit, .then runs here.
      await Promise.resolve();
      await Promise.resolve();
      expect(settledEarly).toBe(false);
      emitOut('after');
      mockChildProcess.emit('close', 0, null);
      const result = await handle.result;
      expect(settledEarly).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(onOutputEventMock).toHaveBeenCalledWith(stdoutEvent('after'));
    });

    it('settles a streaming execution within a bounded drain when stdio never closes', async () => {
      // A grandchild holding the stdout pipe (`sleep 10 &`, `nohup … &`) defers
      // 'close' forever; the result must still settle on the recorded exit
      // after the bounded drain (PR #12067 review: wedging hangs background
      // shells and the ACP channel). Bound to 'close' alone it never resolves.
      const { result } = await simulateExecution(
        'daemonize',
        (cp) => {
          emitOut('before');
          cp.emit('exit', 0, null);
          // No 'close': the grandchild holds the pipe forever.
        },
        { streamStdout: true },
      );
      expect(result.exitCode).toBe(0);
      expect(result.aborted).toBe(false);
      expect(onOutputEventMock).toHaveBeenCalledWith(stdoutEvent('before'));
    });

    it('reports capture-limit notice for streaming child_process output', async () => {
      const { result } = await runChunks(
        'streaming-large-output',
        ['abcdef'],
        { ...shellExecutionConfig, maxBufferedOutputBytes: 1 },
        { streamStdout: true },
      );

      expect(onOutputEventMock).toHaveBeenCalledWith(stdoutEvent('abcdef'));
      expect(result.rawOutput.length).toBe(1);
      expect(result.output).toContain(CAP_NOTICE);
    });

    it('emits only the capture-limit notice when stripped captured output is empty', async () => {
      const { result } = await runChunks('empty-captured-output', ['\nabc'], {
        ...shellExecutionConfig,
        maxBufferedOutputBytes: 1,
      });

      expect(result.rawOutput.length).toBe(1);
      expect(result.output).toMatch(
        /^\[Output exceeded the maximum captured size/,
      );
    });

    it('should handle commands with no output', async () => {
      const { result } = await runChunks('touch file', []);

      expect(result.output.trim()).toBe('');
      expect(onOutputEventMock).not.toHaveBeenCalled();
    });
  });

  describe('Failed Execution', () => {
    it('should capture a non-zero exit code and format output correctly', async () => {
      const { result } = await simulateExecution('a-bad-command', () => {
        emitOut('command not found', 'stderr');
        finish(127);
      });

      expect(result.exitCode).toBe(127);
      expect(result.output.trim()).toBe('command not found');
      expect(result.error).toBeNull();
    });

    it('should capture a termination signal', async () => {
      const { result } = await simulateExecution('long-process', () =>
        finish(null, 'SIGTERM'),
      );

      expect(result.exitCode).toBeNull();
      expect(result.signal).toBe(15);
    });

    it('should handle a spawn error', async () => {
      const spawnError = new Error('spawn EACCES');
      const { result } = await simulateExecution('protected-cmd', (cp) => {
        cp.emit('error', spawnError);
        finish(1);
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
        expectedExit: { code: 1 },
      },
    ])('on $platform', ({ platform, expectedSignal, expectedExit }) => {
      it('should abort a running process and set the aborted flag', async () => {
        mockPlatform.mockReturnValue(platform);

        const { result } = await simulateExecution('sleep 10', (_cp, ac) => {
          ac.abort();
          if (expectedExit.signal) finish(null, expectedExit.signal);
          if (typeof expectedExit.code === 'number') finish(expectedExit.code);
        });

        expect(result.aborted).toBe(true);

        if (platform === 'linux') {
          expect(mockProcessKill).toHaveBeenCalledWith(
            ...groupKill(expectedSignal),
          );
        } else {
          expect(mockCpSpawn).toHaveBeenCalledWith(
            ...taskkill(mockChildProcess.pid),
          );
        }
      });
    });

    // Cancel on win32 and check the aborted flag. performCancelKill's taskkill
    // gets its own emitter, so its 'error' / 'exit' fire in isolation from the
    // shell child's 'error' handler.
    const cancelWithTaskkill = async (
      drive: (taskkillProc: EventEmitter) => void,
    ) => {
      mockPlatform.mockReturnValue('win32');
      const taskkillProc = new EventEmitter();
      mockCpSpawn.mockReturnValueOnce(mockChildProcess); // shell
      mockCpSpawn.mockReturnValueOnce(taskkillProc); // performCancelKill taskkill
      const { result } = await simulateExecution('sleep 10', (_cp, ac) => {
        ac.abort();
        drive(taskkillProc);
      });
      expect(result.aborted).toBe(true);
    };

    it('win32 cancel falls back to child.kill when taskkill cannot launch', async () => {
      await cancelWithTaskkill((taskkillProc) => {
        // taskkill could not launch -> async 'error' event (not a throw).
        taskkillProc.emit('error', new Error('spawn taskkill ENOENT'));
        // The child.kill() fallback makes the real child exit; settle it.
        finish(1);
      });

      // Without the fallback the abort hangs for an exit that never comes.
      // See #5873.
      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('win32 cancel falls back to child.kill when taskkill exits non-zero', async () => {
      await cancelWithTaskkill((taskkillProc) => {
        // taskkill launched but failed (e.g. access denied on an elevated
        // child): non-zero exit, no 'error' event.
        taskkillProc.emit('exit', 1);
        finish(1);
      });

      // Else the cancel hangs (no 'error', child still alive). See #5873.
      expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('win32 cancel does NOT fall back to child.kill when taskkill exits 0', async () => {
      await cancelWithTaskkill((taskkillProc) => {
        // taskkill killed the tree (exit 0): no fallback. Pins the
        // `if (code !== 0)` guard against removal or inversion.
        taskkillProc.emit('exit', 0);
        finish(1);
      });

      expect(mockChildProcess.kill).not.toHaveBeenCalled();
    });

    it('win32 cancel does NOT fall back to child.kill when the child already exited', async () => {
      await cancelWithTaskkill((taskkillProc) => {
        // The child exits BEFORE a slow taskkill reports failure...
        finish();
        // ...so no child.kill on a dead (maybe pid-reused) child: pins the
        // `if (!exited)` guard.
        taskkillProc.emit('error', new Error('spawn taskkill ENOENT'));
      });

      expect(mockChildProcess.kill).not.toHaveBeenCalled();
    });

    it('signal.reason = { kind: "cancel" } still tree-kills (same as default)', async () => {
      const { result } = await simulateExecution('sleep 10', (_cp, ac) => {
        ac.abort({ kind: 'cancel' } satisfies ShellAbortReason);
        finish(null, 'SIGKILL');
      });

      expect(result.aborted).toBe(true);
      expect(result.promoted).toBeUndefined();
      // Default kill path: 'cancel' is not routed as background.
      expect(mockProcessKill).toHaveBeenCalledWith(...groupKill('SIGTERM'));
    });

    it('signal.reason = { kind: "background" } skips kill and resolves with promoted: true (and aborted: false per design question 7)', async () => {
      // No 'exit': the child is still alive after the promote, so the result
      // must come from the abort handler's own immediate resolve.
      const { result } = await simulateExecution(
        'tail -f /tmp/never.log',
        (_cp, ac) => {
          // Output first, so the snapshot has content.
          emitOut('line1\nline2\n');
          ac.abort(bg('bg_test123'));
        },
      );

      // See PTY equivalent test for the rationale on `aborted: false`.
      expect(result.aborted).toBe(false);
      expect(result.promoted).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBeNull();
      expect(result.error).toBeNull();
      expect(result.pid).toBe(mockChildProcess.pid);
      // Output up to the promote is the snapshot seeding the caller's
      // BackgroundShellEntry output file; the kill path did NOT run.
      expect(result.output).toContain('line1');
      expect(result.output).toContain('line2');
      expect(mockProcessKill).not.toHaveBeenCalledWith(...groupKill('SIGTERM'));
      expect(mockProcessKill).not.toHaveBeenCalledWith(...groupKill('SIGKILL'));
      expect(mockChildProcess.kill).not.toHaveBeenCalled();
    });

    it('post-promotion: stdout / stderr data is no longer routed to onOutputEvent (handoff boundary)', async () => {
      // Ownership contract: without off()'ing the stdout / stderr handlers at
      // promote, post-promote bytes re-enter handleOutput and either hit the
      // finalized decoder (TypeError crash) or reach the foreground
      // onOutputEvent (ownership leak / duplicated emit).
      const { result } = await simulateExecution(
        'tail -f /tmp/never.log',
        (_cp, ac) => {
          emitOut('pre-promote\n');
          ac.abort(bg('bg_test123'));
          // More data on the live streams: no onOutputEvent, no decoder throw.
          const eventCountAtPromote = onOutputEventMock.mock.calls.length;
          emitOut('post-promote-stdout\n');
          emitOut('post-promote-stderr\n', 'stderr');
          expect(onOutputEventMock.mock.calls.length).toBe(eventCountAtPromote);
        },
      );

      expect(result.promoted).toBe(true);
      expect(result.output).toContain('pre-promote');
      expect(result.output).not.toContain('post-promote-stdout');
      expect(result.output).not.toContain('post-promote-stderr');
    });

    it('post-exit race: background-promote refuses if child is already terminal (exitCode/signalCode non-null)', async () => {
      // The child may exit (exitCode set) before Node delivers 'exit'; a
      // promote then would detach our exit listener and hand the caller an
      // inert pid as `promoted: true`. Production checks exitCode / signalCode
      // first and lets the pending exit handler resolve with the real info.
      const { result } = await simulateExecution(
        'fast-and-cancelled',
        (cp, ac) => {
          // Exited, with its 'exit' emit queued behind the abort dispatch.
          Object.defineProperty(cp, 'exitCode', {
            value: 0,
            writable: true,
            configurable: true,
          });
          ac.abort(bg('bg_test123'));
          finish();
        },
      );

      // The normal exit shape, not the promoted one.
      expect(result.promoted).toBeUndefined();
      expect(result.aborted).toBe(true); // abortSignal.aborted is still true
      expect(result.exitCode).toBe(0);
    });

    it('post-promotion: child exit does NOT re-resolve the result with a non-promoted shape', async () => {
      // A later child exit must not re-resolve: promote off()'d our exit
      // listener, and a Promise resolves only once anyway.
      const { result } = await simulateExecution(
        'tail -f /tmp/never.log',
        (_cp, ac) => {
          ac.abort(bg('bg_test123'));
          finish(42);
        },
      );

      expect(result.promoted).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBeNull();
    });

    it('PR-2.5 child_process: post-promote stdout/stderr forward to postPromote.onData with SEPARATE decoders', async () => {
      // Separate decoders: a shared one corrupts interleaved multibyte UTF-8
      // (the continuation-byte state machine assumes one byte source).
      const events: Array<{ type: string; chunk?: string | unknown }> = [];
      const { result } = await simulateExecution(
        'tail -f',
        (_cp, ac) => {
          ac.abort(bg('bg_cp_data'));
          emitOut('post-promote-stdout\n');
          emitOut('post-promote-stderr\n', 'stderr');
        },
        { postPromote: { onData: (event) => events.push(event) } },
      );
      expect(result.promoted).toBe(true);
      const dataChunks = dataChunksOf(events);
      expect(dataChunks).toContain('post-promote-stdout\n');
      expect(dataChunks).toContain('post-promote-stderr\n');
    });

    it('PR-2.5 child_process: onSettle fires on `close` (NOT `exit`) so late chunks land before the registry transitions', async () => {
      // Data can arrive between 'exit' and 'close'; settling on 'exit' has the
      // caller close its output and transition the registry first, dropping
      // those chunks (truncated logs).
      const events: Array<{ type: string; chunk?: string | unknown }> = [];
      const settles: ShellPostPromoteSettleInfo[] = [];
      const { result } = await simulateExecution(
        'cmd',
        (cp, ac) => {
          ac.abort(bg('bg_cp_close'));
          // 'exit' (settled too early in PR-1 of PR-2.5), a late chunk, then
          // 'close', the only event that settles.
          cp.emit('exit', 0, null);
          emitOut('late-chunk\n');
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
      expect(dataChunksOf(events)).toContain('late-chunk\n');
      expect(settles).toHaveLength(1);
      expect(settles[0].exitCode).toBe(0);
      expect(settles[0].signal).toBeNull();
    });

    it('PR-2.5 child_process: post-promote spawn error routes to onSettle with error populated', async () => {
      const settles: ShellPostPromoteSettleInfo[] = [];
      const { result } = await simulateExecution(
        'cmd',
        (cp, ac) => {
          ac.abort(bg('bg_cp_err'));
          cp.emit('error', new Error('post-promote spawn boom'));
        },
        { postPromote: { onSettle: (info) => settles.push(info) } },
      );
      expect(result.promoted).toBe(true);
      expect(settles).toHaveLength(1);
      expect(settles[0].error?.message).toBe('post-promote spawn boom');
      expect(settles[0].exitCode).toBeNull();
      expect(settles[0].signal).toBeNull();
    });

    it('PR-2.5 wave-4 (T1): post-promote `error` followed by `close` fires onSettle EXACTLY ONCE', async () => {
      // Double-fire regression: 'close' and 'error' each called
      // `onPostSettle`, so a spawn error plus the automatic 'close' settled
      // twice, racing the caller's `transitionRegistry`. Both now go through
      // the `firePostSettle` latch (as on the PTY path).
      const settles: ShellPostPromoteSettleInfo[] = [];
      const { result } = await simulateExecution(
        'cmd',
        (cp, ac) => {
          ac.abort(bg('bg_cp_double'));
          cp.emit('error', new Error('error first'));
          // Node child_process always emits 'close' even after an error;
          // pre-fix this settled a second time.
          cp.emit('close', 1, null);
        },
        { postPromote: { onSettle: (info) => settles.push(info) } },
      );
      expect(result.promoted).toBe(true);
      expect(settles).toHaveLength(1);
      expect(settles[0].error?.message).toBe('error first');
    });

    it('PR-2.5 wave-4 (T3): onData-only caller still gets decoder flush on close (no trailing multibyte loss)', async () => {
      // T3: close was installed only with `onSettle`, so an onData-only caller
      // lost the trailing flush and a split UTF-8 character could vanish. close
      // now comes with ANY postPromote handler; onData implies the flush.
      const dataChunks: ShellOutputEvent[] = [];
      const { result } = await simulateExecution(
        'cmd',
        (cp, ac) => {
          ac.abort(bg('bg_cp_t3'));
          // € = 0xE2 0x82 0xAC split across chunks; close triggers the flush.
          emitOut(Buffer.from([0xe2]));
          emitOut(Buffer.from([0x82, 0xac]));
          cp.emit('close', 0, null);
        },
        // NO onSettle: the close handler must still flush.
        { postPromote: { onData: (event) => dataChunks.push(event) } },
      );
      expect(result.promoted).toBe(true);
      const joined = dataChunks
        .map((d) =>
          d.type === 'data' && typeof d.chunk === 'string' ? d.chunk : '',
        )
        .join('');
      expect(joined).toContain('€');
    });

    it('PR-2.5 wave-4 (T6): onData-only caller has post-promote `error` listener (does not crash CLI)', async () => {
      // T6: the post-promote 'error' listener was gated on `onSettle`, so an
      // onData-only caller had none and a spawn error crashed Node (unhandled
      // 'error'). ANY postPromote handler now attaches one.
      const dataChunks: ShellOutputEvent[] = [];
      const { result } = await simulateExecution(
        'cmd',
        (cp, ac) => {
          ac.abort(bg('bg_cp_t6'));
          expect(() =>
            cp.emit('error', new Error('post-promote err')),
          ).not.toThrow();
          // child_process auto-emits 'close' after 'error'.
          cp.emit('close', null, null);
        },
        // NO onSettle, but the error must still be handled (no crash).
        { postPromote: { onData: (event) => dataChunks.push(event) } },
      );
      expect(result.promoted).toBe(true);
    });

    it('PR-2.5 wave-4 (T7): onSettle-only caller has stdout/stderr resumed (child does not block on full pipes)', async () => {
      // T7: with `onSettle` but no `onData` the Readables stayed paused, the OS
      // pipe filled (~64KB on Linux), the child blocked on write, and 'close' /
      // onSettle never fired. The no-onData branch now resume()s both streams.
      const settles: ShellPostPromoteSettleInfo[] = [];
      const stdoutResumeSpy = vi.fn();
      const stderrResumeSpy = vi.fn();
      const { result } = await simulateExecution(
        'cmd',
        (cp, ac) => {
          if (cp.stdout) cp.stdout.resume = stdoutResumeSpy;
          if (cp.stderr) cp.stderr.resume = stderrResumeSpy;
          ac.abort(bg('bg_cp_t7'));
          cp.emit('close', 0, null);
        },
        // NO onData, but stdout/stderr must still be resumed.
        { postPromote: { onSettle: (info) => settles.push(info) } },
      );
      expect(result.promoted).toBe(true);
      expect(stdoutResumeSpy).toHaveBeenCalled();
      expect(stderrResumeSpy).toHaveBeenCalled();
      expect(settles).toHaveLength(1);
    });

    it('should gracefully attempt SIGKILL on linux if SIGTERM fails', async () => {
      mockPlatform.mockReturnValue('linux');
      vi.useFakeTimers();

      // Drive the timeline by hand: don't await the result before escalation.
      const abortController = new AbortController();
      const handle = await exec('unresponsive_process', {
        signal: abortController.signal,
        config: {},
      });

      abortController.abort();

      expect(mockProcessKill).toHaveBeenCalledWith(...groupKill('SIGTERM'));

      await vi.advanceTimersByTimeAsync(250);
      expect(mockProcessKill).toHaveBeenCalledWith(...groupKill('SIGKILL'));

      finish(null, 'SIGKILL');
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
        emitOut(binaryChunk1);
        emitOut(binaryChunk2);
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

      await runChunks(
        'cat mixed_file',
        [Buffer.from([0xe2]), Buffer.from([0x00, 0x01, 0x02])],
        shellExecutionConfig,
        { streamStdout: true },
      );

      const eventTypes = onOutputEventMock.mock.calls.map(
        (call: [ShellOutputEvent]) => call[0].type,
      );
      const binaryIndex = eventTypes.indexOf('binary_detected');
      expect(binaryIndex).toBeGreaterThanOrEqual(0);
      expect(eventTypes.slice(binaryIndex + 1)).not.toContain('data');
    });
  });

  describe('Platform-Specific Behavior', () => {
    afterEach(() => {
      useShell(BASH_SHELL);
    });

    const exitOnly: Simulation = (cp) => cp.emit('exit', 0, null);

    const windowsSpawn = (windowsVerbatimArguments: boolean) =>
      expect.objectContaining({
        detached: false,
        windowsHide: true,
        windowsVerbatimArguments,
      });

    it.each<[string, string[], string, string[], unknown]>([
      // cmd.exe commands on Windows are prefixed with chcp 65001 for UTF-8
      [
        'should use cmd.exe with chcp 65001 UTF-8 prefix on Windows',
        CMD_SHELL,
        'dir "foo bar"',
        ['/d', '/s', '/c', `${CHCP} 65001 >nul 2>nul & dir "foo bar"`],
        windowsSpawn(true),
      ],
      [
        'should not apply UTF-8 prefix for Git Bash on Windows via child_process',
        GIT_BASH_SHELL,
        'echo hello',
        ['-c', 'echo hello'],
        expect.any(Object),
      ],
      [
        'should use PowerShell with UTF-8 prefix without windowsVerbatimArguments on Windows',
        POWERSHELL_SHELL,
        PS_COMMAND,
        PS_UTF8_ARGS,
        windowsSpawn(false),
      ],
    ])('%s', async (_title, shell, command, args, spawnOptions) => {
      mockPlatform.mockReturnValue('win32');
      useShell(shell);
      await simulateExecution(command, exitOnly);

      expect(mockCpSpawn).toHaveBeenCalledWith(shell[0], args, spawnOptions);
    });

    it('should normalize PATH-like env keys on Windows for child_process fallback', async () => {
      mockPlatform.mockReturnValue('win32');
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      setupConflictingPathEnv();

      await simulateExecution('dir', exitOnly);

      expectNormalizedWindowsPathEnv(mockCpSpawn.mock.calls[0][2].env);
    });

    it('does not inject Unix pager defaults into Windows child_process env when unset', async () => {
      mockPlatform.mockReturnValue('win32');
      useShell(CMD_SHELL);

      vi.stubEnv('GIT_PAGER', undefined);
      await simulateExecution(
        'echo hello',
        exitOnly,
        {},
        shellExecutionConfigWithoutPager,
      );

      const spawnOptions = mockCpSpawn.mock.calls[0][2];
      expect(spawnOptions.env['PAGER']).toBe('');
      expect(spawnOptions.env['GIT_PAGER']).toBeUndefined();
    });

    it('preserves explicit pager configuration in Windows child_process env', async () => {
      mockPlatform.mockReturnValue('win32');
      useShell(CMD_SHELL);

      vi.stubEnv('GIT_PAGER', undefined);
      await simulateExecution('echo hello', exitOnly);

      const spawnOptions = mockCpSpawn.mock.calls[0][2];
      expect(spawnOptions.env['PAGER']).toBe('cat');
      expect(spawnOptions.env['GIT_PAGER']).toBeUndefined();
    });

    it('should use bash and detached process group on Linux', async () => {
      mockPlatform.mockReturnValue('linux');
      await simulateExecution('ls "foo bar"', exitOnly);

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
  let mockPtyProcess: ReturnType<typeof makePty>;
  let mockChildProcess: MockChild;

  beforeEach(() => {
    vi.clearAllMocks();
    onOutputEventMock = vi.fn();
    mockPtyProcess = makePty();
    mockPtySpawn.mockReturnValue(mockPtyProcess);
    mockGetPty.mockResolvedValue({
      module: { spawn: mockPtySpawn },
      name: 'mock-pty',
    });
    // Same exit-state shape as the child_process fallback block, so a future
    // promote test here doesn't trip the `child.exitCode !== null` race guard.
    mockChildProcess = makeChild(54321);
    mockCpSpawn.mockReturnValue(mockChildProcess);
  });

  it.each([
    { shouldUseNodePty: true, label: 'PTY' },
    { shouldUseNodePty: false, label: 'child_process' },
  ])(
    'does not spawn through $label when the signal is already aborted',
    async ({ shouldUseNodePty }) => {
      const handle = await exec('test command', {
        signal: AbortSignal.abort(),
        usePty: shouldUseNodePty,
      });
      const result = await handle.result;

      expect(handle.pid).toBeUndefined();
      expect(result).toMatchObject({
        aborted: true,
        pid: undefined,
        executionMethod: 'none',
        output: '',
      });
      expect(mockGetPty).not.toHaveBeenCalled();
      expect(mockPtySpawn).not.toHaveBeenCalled();
      expect(mockCpSpawn).not.toHaveBeenCalled();
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'returns on abort while getPty is pending and ignores its late %s',
    async (settlement) => {
      let resolvePty: ((value: null) => void) | undefined;
      let rejectPty: ((reason: Error) => void) | undefined;
      mockGetPty.mockReturnValue(
        new Promise((resolve, reject) => {
          resolvePty = resolve;
          rejectPty = reject;
        }),
      );
      const abortController = new AbortController();
      const removeAbortListener = vi.spyOn(
        abortController.signal,
        'removeEventListener',
      );
      const handlePromise = exec('test command', {
        signal: abortController.signal,
      });

      abortController.abort();
      const handle = await handlePromise;
      expect((await handle.result).executionMethod).toBe('none');
      expect(removeAbortListener).toHaveBeenCalledWith(
        'abort',
        expect.any(Function),
      );
      expect(mockPtySpawn).not.toHaveBeenCalled();
      expect(mockCpSpawn).not.toHaveBeenCalled();

      if (settlement === 'resolve') {
        resolvePty?.(null);
      } else {
        rejectPty?.(new Error('late PTY failure'));
      }
      await Promise.resolve();
      await Promise.resolve();

      expect(mockPtySpawn).not.toHaveBeenCalled();
      expect(mockCpSpawn).not.toHaveBeenCalled();
    },
  );

  it('does not spawn when aborted while xterm is loading', async () => {
    let resolveXterm:
      | ((value: { Terminal: typeof Terminal }) => void)
      | undefined;
    mockLoadXtermHeadless.mockReturnValue(
      new Promise((resolve) => {
        resolveXterm = resolve;
      }),
    );
    const abortController = new AbortController();
    const handlePromise = exec('test command', {
      signal: abortController.signal,
    });

    await vi.waitFor(() => {
      expect(mockLoadXtermHeadless).toHaveBeenCalledOnce();
    });
    abortController.abort();
    resolveXterm?.({ Terminal });

    const handle = await handlePromise;
    expect(await handle.result).toMatchObject({
      aborted: true,
      pid: undefined,
      executionMethod: 'none',
      output: '',
    });
    expect(mockPtySpawn).not.toHaveBeenCalled();
    expect(mockCpSpawn).not.toHaveBeenCalled();
  });

  it('should use node-pty when shouldUseNodePty is true and pty is available', async () => {
    const handle = await exec('test command');

    mockPtyProcess.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
    const result = await handle.result;

    expect(mockGetPty).toHaveBeenCalled();
    expect(mockPtySpawn).toHaveBeenCalled();
    expect(mockCpSpawn).not.toHaveBeenCalled();
    expect(result.executionMethod).toBe('mock-pty');
  });

  it('should use child_process when shouldUseNodePty is false', async () => {
    const handle = await exec('test command', { usePty: false, config: {} });

    mockChildProcess.emit('exit', 0, null);
    const result = await handle.result;

    expect(mockGetPty).not.toHaveBeenCalled();
    expect(mockPtySpawn).not.toHaveBeenCalled();
    expect(mockCpSpawn).toHaveBeenCalled();
    expect(result.executionMethod).toBe('child_process');
  });

  it('should fall back to child_process if pty is not available even if shouldUseNodePty is true', async () => {
    mockGetPty.mockResolvedValue(null);

    const handle = await exec('test command');

    mockChildProcess.emit('exit', 0, null);
    const result = await handle.result;

    expect(mockGetPty).toHaveBeenCalled();
    expect(mockPtySpawn).not.toHaveBeenCalled();
    expect(mockCpSpawn).toHaveBeenCalled();
    expect(result.executionMethod).toBe('child_process');
  });
});

describe('getShellAbortReasonKind (defensive abort-reason read)', () => {
  it.each<[string, unknown[]]>([
    [
      "returns 'cancel' for null reason (e.g. plain abortController.abort())",
      [null, undefined],
    ],
    [
      "returns 'cancel' for non-object reasons (string / number / DOMException)",
      // A DOMException-like Error (not the real constructor, same principle):
      // an object reason without an own `kind` is a cancel.
      ['background', 42, true, new Error('aborted')],
    ],
    ["returns 'cancel' for an empty object (no own kind)", [{}]],
    [
      "returns 'cancel' for an unknown kind value (typo / future-untyped variant)",
      [{ kind: 'suspend' }, { kind: 'BACKGROUND' }, { kind: 42 }],
    ],
    ["returns 'cancel' for the canonical cancel reason", [{ kind: 'cancel' }]],
  ])('%s', (_title, reasons) => {
    for (const reason of reasons) {
      expect(getShellAbortReasonKind(reason)).toBe('cancel');
    }
  });

  it("returns 'cancel' when 'kind' lives only on the prototype (pollution defense)", () => {
    const polluted: Record<string, unknown> = Object.create({
      kind: 'background',
    });
    // hasOwnProperty('kind') is false → helper rejects the prototype-only kind
    expect(getShellAbortReasonKind(polluted)).toBe('cancel');
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
    // The `hasOwnProperty` probe hits this trap before `kind` is read (so no
    // `get` handler); it used to escape the helper from outside the try, which
    // now wraps both the probe and the read.
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
});
