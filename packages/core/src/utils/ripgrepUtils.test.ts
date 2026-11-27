/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  _resetRipgrepUtilsCachesForTest,
  canUseRipgrep,
  getBuiltinRipgrep,
  resolveRipgrep,
  runRipgrep,
} from './ripgrepUtils.js';
import { fileExists } from './fileUtils.js';
import { execCommand, isCommandAvailable } from './shell-utils.js';
import path from 'node:path';

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(),
  systemProbe: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) =>
    (args[0] === 'rg' && Array.isArray(args[1]) && args[1].at(-1) === '-'
      ? childProcessMock.systemProbe
      : childProcessMock.execFile)(...args),
}));

const fsPromisesMock = vi.hoisted(() => ({
  stat: vi.fn(),
  chmod: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: fsPromisesMock.stat,
    chmod: fsPromisesMock.chmod,
    // The module under test uses the default import shape.
    default: {
      ...actual,
      stat: fsPromisesMock.stat,
      chmod: fsPromisesMock.chmod,
    },
  };
});

type RipgrepTestError = Error & {
  code?: string | number | undefined | null;
  signal?: string | null;
};

function createExecError(
  message: string,
  props: Partial<Pick<RipgrepTestError, 'code' | 'signal'>> = {},
): RipgrepTestError {
  return Object.assign(new Error(message), props);
}

type RipgrepAttempt = {
  error?: RipgrepTestError;
  stdout?: string;
  stderr?: string;
  spawnError?: RipgrepTestError;
  order?: 'callback-only' | 'error-only' | 'callback-then-error';
};

const execFile = childProcessMock.execFile;
const { systemProbe } = childProcessMock;

function stubSystemProbe(
  output = '{"type":"match","data":{"lines":{"text":"qwen-ripgrep-probe\\n"}}}\n',
  error: RipgrepTestError | null = null,
): void {
  systemProbe.mockImplementation((_command, _args, _options, callback) => {
    const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
    const child = Object.assign(new EventEmitter(), { stdin });
    queueMicrotask(() => {
      callback(error, output);
      child.emit('close', error ? 2 : 0);
    });
    return child;
  });
}

function mockRipgrepAttempt(options: RipgrepAttempt): void {
  const { error = null, stdout = '', stderr = '', spawnError } = options;
  const order = options.order ?? 'callback-only';
  execFile.mockImplementationOnce(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (
        error: RipgrepTestError | null,
        stdout?: string,
        stderr?: string,
      ) => void,
    ) => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        if (order !== 'error-only') callback(error, stdout, stderr);
        if (spawnError) child.emit('error', spawnError);
      });
      return child;
    },
  );
}

vi.mock('./fileUtils.js', () => ({
  fileExists: vi.fn(),
}));

vi.mock('./shell-utils.js', () => ({
  execCommand: vi.fn(),
  isCommandAvailable: vi.fn(),
}));

// Stubs whether the bundled binary exists (left alone when omitted) and
// whether `rg` is on PATH.
function stubInstall(opts: { builtin?: boolean; system: boolean }) {
  if (opts.builtin !== undefined) {
    vi.mocked(fileExists).mockResolvedValue(opts.builtin);
  }
  vi.mocked(isCommandAvailable).mockReturnValue({
    available: opts.system,
    error: undefined,
  });
}

const exitError = (code: number) => createExecError('Command failed', { code });
const timeoutError = () =>
  createExecError('Command timed out', { signal: 'SIGTERM' });
const abortError = () =>
  Object.assign(createExecError('The operation was aborted'), {
    name: 'AbortError',
  });
const abortedSignal = () => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};
const jsonArgs = () => ['--json', '--threads', '4', '.'];
// What the single-thread EAGAIN retry must run instead of jsonArgs().
const oneThreadArgs = ['--json', '--threads', '1', '.'];
const THREAD_EAGAIN_STDERR =
  'rg: failed to create worker thread: Resource temporarily unavailable (os error 11)\n';
const onBuiltin = (recovery: Record<string, unknown>) => ({
  selectionMode: 'builtin',
  ...recovery,
});

describe('ripgrepUtils', () => {
  beforeEach(() => {
    _resetRipgrepUtilsCachesForTest();
    vi.mocked(fileExists).mockReset();
    vi.mocked(execCommand).mockReset();
    vi.mocked(isCommandAvailable).mockReset();
    execFile.mockReset();
    systemProbe.mockReset();
    stubSystemProbe();
    fsPromisesMock.stat.mockReset();
    fsPromisesMock.chmod.mockReset();
    // Default to the source-tree state (0755) so tests that are not about the
    // exec-bit heal keep selecting the bundled binary as before.
    fsPromisesMock.stat.mockResolvedValue({ mode: 0o100755 });
    fsPromisesMock.chmod.mockResolvedValue(undefined);
    vi.mocked(execCommand).mockResolvedValue({
      stdout: 'ripgrep 14.1.0\n',
      stderr: '',
      code: 0,
    });
    // Default PATH has no rg so tests that only stub the bundled binary keep
    // selecting it. Cases that need a system rg call stubInstall().
    stubInstall({ system: false });
  });

  describe('getBuiltinRipgrep', () => {
    const { platform: originalPlatform, arch: originalArch } = process;
    const setPlatform = (platform: string, arch: string) => {
      Object.defineProperty(process, 'platform', { value: platform });
      Object.defineProperty(process, 'arch', { value: arch });
    };
    afterEach(() => setPlatform(originalPlatform, originalArch));

    it('should return path with .exe extension on Windows', () => {
      setPlatform('win32', 'x64');
      const rgPath = getBuiltinRipgrep();

      expect(rgPath).toContain('x64-win32');
      expect(rgPath).toContain('rg.exe');
      expect(rgPath).toContain(path.join('vendor', 'ripgrep'));
    });

    it('should return path without .exe extension on macOS', () => {
      setPlatform('darwin', 'arm64');
      const rgPath = getBuiltinRipgrep();

      expect(rgPath).toContain('arm64-darwin');
      expect(rgPath).toContain('rg');
      expect(rgPath).not.toContain('.exe');
      expect(rgPath).toContain(path.join('vendor', 'ripgrep'));
    });

    it('should return path without .exe extension on Linux', () => {
      setPlatform('linux', 'x64');
      const rgPath = getBuiltinRipgrep();

      expect(rgPath).toContain('x64-linux');
      expect(rgPath).toContain('rg');
      expect(rgPath).not.toContain('.exe');
      expect(rgPath).toContain(path.join('vendor', 'ripgrep'));
    });

    it('should return null for unsupported platform', () => {
      setPlatform('freebsd', 'x64');
      expect(getBuiltinRipgrep()).toBeNull();
    });

    it('should return null for unsupported architecture', () => {
      setPlatform('darwin', 'ia32');
      expect(getBuiltinRipgrep()).toBeNull();
    });

    it('should handle all supported platform/arch combinations', () => {
      const combinations: Array<{ platform: string; arch: string }> = [
        { platform: 'darwin', arch: 'x64' },
        { platform: 'darwin', arch: 'arm64' },
        { platform: 'linux', arch: 'x64' },
        { platform: 'linux', arch: 'arm64' },
        { platform: 'win32', arch: 'x64' },
      ];

      combinations.forEach(({ platform, arch }) => {
        setPlatform(platform, arch);
        const binaryName = platform === 'win32' ? 'rg.exe' : 'rg';
        expect(getBuiltinRipgrep()).toContain(
          path.join(`${arch}-${platform}`, binaryName),
        );
      });
    });
  });

  describe('resolveRipgrep', () => {
    it('prefers PATH rg over the bundled binary when both exist', async () => {
      stubInstall({ builtin: true, system: true });

      await expect(resolveRipgrep(true)).resolves.toEqual({
        mode: 'system',
        command: 'rg',
      });
    });

    it('uses the bundled binary when builtin is enabled and PATH rg is missing', async () => {
      stubInstall({ builtin: true, system: false });

      await expect(resolveRipgrep(true)).resolves.toMatchObject({
        mode: 'builtin',
      });
    });

    it('keeps builtin-enabled and system-only selections cached separately', async () => {
      stubInstall({ builtin: true, system: false });

      await expect(resolveRipgrep(true)).resolves.toMatchObject({
        mode: 'builtin',
      });
      stubInstall({ builtin: true, system: true });
      await expect(resolveRipgrep(false)).resolves.toEqual({
        mode: 'system',
        command: 'rg',
      });
      await expect(resolveRipgrep(true)).resolves.toMatchObject({
        mode: 'builtin',
      });
    });

    it('falls back to system ripgrep when builtin is enabled but unavailable', async () => {
      stubInstall({ builtin: false, system: true });

      await expect(resolveRipgrep(true)).resolves.toEqual({
        mode: 'system',
        command: 'rg',
      });
    });

    it('uses the bundle after a system availability error', async () => {
      stubInstall({ builtin: true, system: false });
      const error = createExecError('unstatable PATH rg', { code: 'ENOENT' });
      vi.mocked(isCommandAvailable).mockReturnValue({
        available: false,
        error,
      });

      await expect(resolveRipgrep()).resolves.toMatchObject({
        mode: 'builtin',
      });
      await expect(canUseRipgrep()).resolves.toBe(true);
      mockRipgrepAttempt({ stdout: 'file.ts:1:needle\n' });
      await expect(runRipgrep(jsonArgs())).resolves.toMatchObject({
        stdout: 'file.ts:1:needle\n',
        recovery: { selectionMode: 'builtin' },
      });
    });

    it.each([true, false])(
      'preserves the system availability error without a permitted fallback (useBuiltin=%s)',
      async (useBuiltin) => {
        stubInstall({ builtin: !useBuiltin, system: false });
        const error = createExecError('unstatable PATH rg', { code: 'ENOENT' });
        vi.mocked(isCommandAvailable).mockReturnValue({
          available: false,
          error,
        });

        await expect(canUseRipgrep(useBuiltin)).rejects.toBe(error);
        if (!useBuiltin) expect(fileExists).not.toHaveBeenCalled();
      },
    );

    it('does not use the bundled binary when useBuiltin is false', async () => {
      stubInstall({ builtin: true, system: false });

      await expect(resolveRipgrep(false)).resolves.toBeNull();
      expect(fileExists).not.toHaveBeenCalled();
    });
  });

  // A published tarball ships every `vendor/ripgrep/*/rg` as 0644 (#12679),
  // so the bundled binary cannot be spawned until something restores the bit.
  describe('bundled ripgrep exec bit', () => {
    const originalPlatform = process.platform;
    const originalArch = process.arch;

    function stubPlatform(platform: string, arch: string): void {
      Object.defineProperty(process, 'platform', { value: platform });
      Object.defineProperty(process, 'arch', { value: arch });
    }

    afterEach(() => {
      stubPlatform(originalPlatform, originalArch);
    });

    it('restores a missing exec bit before selecting the bundled binary', async () => {
      stubPlatform('linux', 'x64');
      vi.mocked(fileExists).mockResolvedValue(true);
      fsPromisesMock.stat.mockResolvedValue({ mode: 0o100644 });

      const bundledPath = getBuiltinRipgrep();
      await expect(resolveRipgrep(true)).resolves.toEqual({
        mode: 'builtin',
        command: bundledPath,
      });

      expect(fsPromisesMock.stat).toHaveBeenCalledWith(bundledPath);
      expect(fsPromisesMock.chmod).toHaveBeenCalledWith(bundledPath, 0o755);
    });

    it('leaves an already executable bundled binary alone', async () => {
      stubPlatform('linux', 'x64');
      vi.mocked(fileExists).mockResolvedValue(true);

      await expect(resolveRipgrep(true)).resolves.toMatchObject({
        mode: 'builtin',
      });

      expect(fsPromisesMock.chmod).not.toHaveBeenCalled();
    });

    it('probes the bundled binary once, not on every search', async () => {
      stubPlatform('linux', 'x64');
      vi.mocked(fileExists).mockResolvedValue(true);
      fsPromisesMock.stat.mockResolvedValue({ mode: 0o100644 });

      await resolveRipgrep(true);
      await resolveRipgrep(true);

      expect(fsPromisesMock.stat).toHaveBeenCalledTimes(1);
      expect(fsPromisesMock.chmod).toHaveBeenCalledTimes(1);
    });

    it('still falls back to system rg when the install cannot be healed', async () => {
      stubPlatform('linux', 'x64');
      stubInstall({ builtin: true, system: false });
      fsPromisesMock.stat.mockResolvedValue({ mode: 0o100644 });
      fsPromisesMock.chmod.mockRejectedValue(
        createExecError('chmod EPERM', { code: 'EPERM' }),
      );

      const bundledPath = getBuiltinRipgrep();
      await expect(resolveRipgrep(true)).resolves.toEqual({
        mode: 'builtin',
        command: bundledPath,
      });
      expect(fsPromisesMock.chmod).toHaveBeenCalledWith(bundledPath, 0o755);
      stubInstall({ builtin: true, system: true });
      vi.mocked(execCommand).mockRejectedValueOnce(
        createExecError(`spawn ${bundledPath} EACCES`, { code: 'EACCES' }),
      );

      await expect(canUseRipgrep(true)).resolves.toBe(true);
      expect(execCommand).toHaveBeenCalledWith(
        bundledPath,
        ['--version'],
        expect.anything(),
      );
      expect(systemProbe).toHaveBeenCalledOnce();
      await expect(resolveRipgrep(true)).resolves.toEqual({
        mode: 'system',
        command: 'rg',
      });
    });

    it('skips the heal on Windows, where mode bits are synthesized', async () => {
      stubPlatform('win32', 'x64');
      vi.mocked(fileExists).mockResolvedValue(true);

      await expect(resolveRipgrep(true)).resolves.toMatchObject({
        mode: 'builtin',
      });

      expect(fsPromisesMock.stat).not.toHaveBeenCalled();
      expect(fsPromisesMock.chmod).not.toHaveBeenCalled();
    });
  });

  describe('runRipgrep', () => {
    beforeEach(() => {
      vi.mocked(fileExists).mockResolvedValue(true);
    });

    // A thread-EAGAIN first attempt (stderr given) followed by a clean retry.
    const mockEagainThenSuccess = (stderr: string) => {
      mockRipgrepAttempt({ error: exitError(2), stderr });
      mockRipgrepAttempt({ stdout: 'file.ts:1:needle\n' });
    };
    const retriedWithOneThread = () => ({
      stdout: 'file.ts:1:needle\n',
      incomplete: false,
      recovery: onBuiltin({
        retryTriggered: true,
        retrySucceeded: true,
        failureKind: 'eagain',
      }),
    });

    it('treats exit code 1 with empty stdout and stderr as no matches', async () => {
      mockRipgrepAttempt({ error: exitError(1) });

      expect(await runRipgrep(['--threads', '4'])).toEqual({
        stdout: '',
        incomplete: false,
        recovery: onBuiltin({ retryTriggered: false }),
      });
    });

    it('does not treat exit code 1 with stderr as no matches', async () => {
      const error = exitError(1);
      mockRipgrepAttempt({
        error,
        stderr: 'rg: ./secret: Permission denied\n',
      });

      expect(await runRipgrep(['--threads', '4'])).toMatchObject({
        stdout: '',
        incomplete: false,
        error,
        recovery: onBuiltin({ retryTriggered: false, failureKind: 'exit' }),
      });
    });

    it('treats exit code 1 with json summary on stdout as no matches', async () => {
      const summary = '{"data":{"stats":{"matches":0}},"type":"summary"}\n';
      mockRipgrepAttempt({ error: exitError(1), stdout: summary });

      expect(await runRipgrep(['--threads', '4'])).toEqual({
        stdout: summary,
        incomplete: false,
        recovery: onBuiltin({ retryTriggered: false }),
      });
    });

    it('treats exit code 1 with both stdout and stderr as an exit error', async () => {
      const error = exitError(1);
      mockRipgrepAttempt({
        error,
        stdout: 'file.ts:1:match\n',
        stderr: 'rg: ./restricted: Permission denied\n',
      });

      expect(await runRipgrep(['--threads', '4'])).toMatchObject({
        stdout: 'file.ts:1:match\n',
        incomplete: true,
        error,
        recovery: onBuiltin({ retryTriggered: false, failureKind: 'exit' }),
      });
    });

    it('retries a confirmed internal thread EAGAIN with one thread', async () => {
      mockEagainThenSuccess(THREAD_EAGAIN_STDERR);

      const args = jsonArgs();
      const result = await runRipgrep(args);

      expect(execFile).toHaveBeenCalledTimes(2);
      expect(execFile.mock.calls[1][1]).toEqual(oneThreadArgs);
      expect(args).toEqual(['--json', '--threads', '4', '.']);
      expect(result).toEqual(retriedWithOneThread());
    });

    it('returns the retry failure when the single-thread retry also fails', async () => {
      const retryError = exitError(2);
      mockRipgrepAttempt({ error: exitError(2), stderr: THREAD_EAGAIN_STDERR });
      mockRipgrepAttempt({
        error: retryError,
        stderr: 'rg: regex parse error\n',
      });

      const result = await runRipgrep(jsonArgs());

      expect(execFile).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        stdout: '',
        incomplete: false,
        error: retryError,
        recovery: onBuiltin({
          retryTriggered: true,
          retrySucceeded: false,
          failureKind: 'exit',
        }),
      });
    });

    it('marks retry result as incomplete when retry produces partial output', async () => {
      mockRipgrepAttempt({ error: exitError(2), stderr: THREAD_EAGAIN_STDERR });
      mockRipgrepAttempt({
        error: timeoutError(),
        stdout: 'file.ts:1:partial\nfile.ts:2:incomplete-line',
      });

      const result = await runRipgrep(jsonArgs());

      expect(result).toMatchObject({
        incomplete: true,
        recovery: onBuiltin({
          retryTriggered: true,
          retrySucceeded: false,
          failureKind: 'timeout',
        }),
      });
      expect(result.stdout).toBe('file.ts:1:partial');
    });

    it('does not retry a spawn EAGAIN because ripgrep never started', async () => {
      const error = createExecError('spawn EAGAIN', { code: 'EAGAIN' });
      mockRipgrepAttempt({ spawnError: error, order: 'error-only' });

      const result = await runRipgrep(jsonArgs());

      expect(execFile).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        stdout: '',
        incomplete: false,
        error,
        recovery: onBuiltin({ retryTriggered: false, failureKind: 'spawn' }),
      });
    });

    it('does not retry canceled execution even when stderr mentions thread EAGAIN', async () => {
      const error = abortError();
      mockRipgrepAttempt({ error, stderr: THREAD_EAGAIN_STDERR });

      const result = await runRipgrep(jsonArgs(), abortedSignal());

      expect(execFile).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        stdout: '',
        incomplete: false,
        error,
        recovery: onBuiltin({ retryTriggered: false }),
      });
      expect(result.recovery.failureKind).toBeUndefined();
    });

    it('marks canceled execution with partial stdout as incomplete and drops the last line', async () => {
      const error = abortError();
      mockRipgrepAttempt({
        error,
        stdout: 'file.ts:1:complete\nfile.ts:2:partial',
        stderr: THREAD_EAGAIN_STDERR,
      });

      const result = await runRipgrep(jsonArgs(), abortedSignal());

      expect(result).toMatchObject({
        stdout: 'file.ts:1:complete',
        incomplete: true,
        error,
        recovery: onBuiltin({ retryTriggered: false }),
      });
      expect(result.recovery.failureKind).toBeUndefined();
    });

    it('does not retry unconfirmed resource unavailable text', async () => {
      const error = exitError(2);
      mockRipgrepAttempt({
        error,
        stderr: 'rg: Resource temporarily unavailable\n',
      });

      const result = await runRipgrep(jsonArgs());

      expect(execFile).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        stdout: '',
        incomplete: false,
        error,
        recovery: onBuiltin({ retryTriggered: false, failureKind: 'exit' }),
      });
    });

    it('retries os error 11 as a short EAGAIN marker', async () => {
      mockEagainThenSuccess('rg: os error 11\n');

      const result = await runRipgrep(jsonArgs());

      expect(execFile).toHaveBeenCalledTimes(2);
      expect(execFile.mock.calls[1][1]).toEqual(oneThreadArgs);
      expect(result).toEqual(retriedWithOneThread());
    });

    it('does not retry when the expected --threads 4 pair is absent', async () => {
      const error = exitError(2);
      mockRipgrepAttempt({
        error,
        stderr: 'rg: worker thread failed: Resource temporarily unavailable\n',
      });

      const result = await runRipgrep(['--json', '.']);

      expect(execFile).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        error,
        recovery: onBuiltin({ retryTriggered: false, failureKind: 'eagain' }),
      });
    });

    // A failure that cut the output short: the possibly incomplete last line
    // is dropped and the result is flagged.
    async function expectPartialOutputDropped(
      error: RipgrepTestError,
      failureKind: string,
    ) {
      mockRipgrepAttempt({
        error,
        stdout: 'file.ts:1:complete\nfile.ts:2:partial',
      });

      expect(await runRipgrep(['--threads', '4'])).toMatchObject({
        stdout: 'file.ts:1:complete',
        incomplete: true,
        error,
        recovery: onBuiltin({ retryTriggered: false, failureKind }),
      });
    }

    it('removes the potentially incomplete last line after timeout', async () => {
      await expectPartialOutputDropped(timeoutError(), 'timeout');
    });

    it('classifies maxBuffer output as incomplete', async () => {
      const error = createExecError('stdout maxBuffer length exceeded', {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      });
      await expectPartialOutputDropped(error, 'max_buffer');
    });

    it('settles one attempt once when callback and error event both arrive', async () => {
      mockRipgrepAttempt({
        error: exitError(2),
        stderr:
          'rg: failed to spawn worker threads: Resource temporarily unavailable (os error 11)\n',
        spawnError: createExecError('late spawn error', { code: 'EAGAIN' }),
        order: 'callback-then-error',
      });
      mockRipgrepAttempt({ stdout: 'file.ts:1:needle\n' });

      const result = await runRipgrep(jsonArgs());

      expect(execFile).toHaveBeenCalledTimes(2);
      expect(result.recovery).toMatchObject({
        retryTriggered: true,
        retrySucceeded: true,
        failureKind: 'eagain',
      });
    });
  });

  describe('canUseRipgrep builtin fallback', () => {
    const systemWorks = () => stubInstall({ builtin: true, system: true });
    const systemFailsBuiltinWorks = () => {
      systemWorks();
      stubSystemProbe('', createExecError('system rg broken'));
    };

    it('does not resolve or execute ripgrep after cancellation', async () => {
      const controller = new AbortController();
      const reason = new Error('startup cancelled');
      controller.abort(reason);

      await expect(canUseRipgrep(true, controller.signal)).rejects.toBe(reason);

      expect(fileExists).not.toHaveBeenCalled();
      expect(execCommand).not.toHaveBeenCalled();
    });

    it('waits for probe exit after cancellation without starting a fallback process', async () => {
      stubInstall({ builtin: true, system: true });
      const controller = new AbortController();
      const reason = new Error('startup cancelled');
      const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
      let close!: () => void;
      systemProbe.mockImplementationOnce(
        (_command, _args, _options, callback) => {
          close = () => {
            callback(createExecError('terminated'), '', '');
            child.emit('close', null, 'SIGKILL');
          };
          return child;
        },
      );
      const probe = canUseRipgrep(true, controller.signal);
      let settled = false;
      void probe.catch(() => {
        settled = true;
      });
      const result = probe.catch((error: unknown) => error);
      await vi.waitFor(() => expect(systemProbe).toHaveBeenCalledOnce());
      controller.abort(reason);
      await Promise.resolve();

      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(settled).toBe(false);
      close();
      expect(await result).toBe(reason);

      expect(systemProbe).toHaveBeenCalledOnce();
      expect(execCommand).not.toHaveBeenCalled();
      expect(fileExists).not.toHaveBeenCalled();
    });

    it('uses PATH rg when it is healthy even if the bundled binary also exists', async () => {
      systemWorks();

      await expect(canUseRipgrep(true)).resolves.toBe(true);
      expect(fileExists).not.toHaveBeenCalled();
      expect(systemProbe).toHaveBeenCalledWith(
        'rg',
        [
          '--json',
          '--no-messages',
          '--path-separator',
          '/',
          '--ignore-case',
          '--regexp',
          '^qwen-ripgrep-probe$',
          '--threads',
          '4',
          '--',
          '-',
        ],
        expect.objectContaining({ timeout: 5_000, killSignal: 'SIGKILL' }),
        expect.any(Function),
      );
      expect(systemProbe.mock.results[0].value.stdin.end).toHaveBeenCalledWith(
        'qwen-ripgrep-probe\n',
      );
    });

    it('falls back to the bundled binary when PATH rg exists but cannot run', async () => {
      systemFailsBuiltinWorks();

      await expect(canUseRipgrep(true)).resolves.toBe(true);
    });

    it('caches the bundled fallback and does not re-probe the broken PATH rg', async () => {
      systemFailsBuiltinWorks();
      await expect(canUseRipgrep(true)).resolves.toBe(true);

      vi.mocked(execCommand).mockClear();
      systemProbe.mockClear();
      await expect(canUseRipgrep(true)).resolves.toBe(true);

      expect(execCommand).not.toHaveBeenCalled();
      expect(systemProbe).not.toHaveBeenCalled();
    });

    it('caches the PATH selection and does not re-probe', async () => {
      systemWorks();
      await expect(canUseRipgrep(true)).resolves.toBe(true);

      vi.mocked(execCommand).mockClear();
      systemProbe.mockClear();
      await expect(canUseRipgrep(true)).resolves.toBe(true);

      expect(execCommand).not.toHaveBeenCalled();
      expect(systemProbe).not.toHaveBeenCalled();
    });

    it('reports the PATH failure when the bundled binary is unusable too', async () => {
      systemFailsBuiltinWorks();
      vi.mocked(execCommand).mockRejectedValue(new Error('bundled rg broken'));

      // PATH rg is preferred, so its failure is the root cause even after the
      // bundled probe that ran after it.
      await expect(canUseRipgrep(true)).rejects.toThrow('system rg broken');
      expect(execCommand).toHaveBeenCalledWith(
        getBuiltinRipgrep(),
        ['--version'],
        expect.anything(),
      );
    });

    it('leaves the system-only selection unpolluted after a fallback', async () => {
      systemFailsBuiltinWorks();
      await expect(canUseRipgrep(true)).resolves.toBe(true);

      await expect(resolveRipgrep(false)).resolves.toEqual({
        mode: 'system',
        command: 'rg',
      });
    });

    it('resolves for every concurrent caller, not just the first', async () => {
      systemWorks();

      await expect(
        Promise.all([canUseRipgrep(true), canUseRipgrep(true)]),
      ).resolves.toEqual([true, true]);
    });

    it('lets runRipgrep use PATH rg instead of throwing', async () => {
      systemWorks();
      mockRipgrepAttempt({ stdout: 'ripgrep 14.1.1\n' });

      await expect(runRipgrep(['--version'])).resolves.toMatchObject({
        stdout: 'ripgrep 14.1.1\n',
        recovery: { selectionMode: 'system' },
      });
      expect(execFile.mock.calls[0][0]).toBe('rg');
    });

    it('reports the bundled failure when no system rg is installed', async () => {
      stubInstall({ builtin: true, system: false });
      vi.mocked(execCommand).mockRejectedValue(new Error('bundled rg broken'));

      // Bundled binary fails and there is no system rg to fall back to.
      await expect(canUseRipgrep(true)).rejects.toThrow('bundled rg broken');
    });

    it('returns false when neither bundled nor system rg is available', async () => {
      stubInstall({ builtin: false, system: false });

      await expect(canUseRipgrep(true)).resolves.toBe(false);
    });

    it('rejects a system rg that exits without the expected JSON match', async () => {
      systemWorks();
      vi.mocked(execCommand).mockRejectedValue(new Error('bundled rg broken'));
      stubSystemProbe('ripgrep 14.1.1');

      await expect(canUseRipgrep(true)).rejects.toThrow(
        'is not a working ripgrep binary (exit 0): ripgrep 14.1.1',
      );
    });

    it('never probes the bundled binary when useBuiltin is false (#5361)', async () => {
      stubInstall({ system: true });
      stubSystemProbe('', createExecError('system rg broken'));

      await expect(canUseRipgrep(false)).rejects.toThrow('system rg broken');
      expect(fileExists).not.toHaveBeenCalled();
    });
  });
});
