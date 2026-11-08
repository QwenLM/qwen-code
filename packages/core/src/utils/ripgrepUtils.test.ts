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
}));

vi.mock('node:child_process', () => ({
  execFile: childProcessMock.execFile,
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
    it('keeps builtin and system selections cached separately', async () => {
      stubInstall({ builtin: true, system: true });

      await expect(resolveRipgrep(true)).resolves.toMatchObject({
        mode: 'builtin',
      });
      await expect(resolveRipgrep(false)).resolves.toEqual({
        mode: 'system',
        command: 'rg',
      });
    });

    it('falls back to system ripgrep when builtin is enabled but unavailable', async () => {
      stubInstall({ builtin: false, system: true });

      await expect(resolveRipgrep(true)).resolves.toEqual({
        mode: 'system',
        command: 'rg',
      });
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
      vi.mocked(fileExists).mockResolvedValue(true);
      fsPromisesMock.stat.mockResolvedValue({ mode: 0o100644 });
      fsPromisesMock.chmod.mockRejectedValue(
        createExecError('chmod EPERM', { code: 'EPERM' }),
      );
      vi.mocked(isCommandAvailable).mockReturnValue({
        available: true,
        error: undefined,
      });
      vi.mocked(execCommand).mockImplementation(async (command: string) => {
        if (command !== 'rg') {
          throw createExecError(`spawn ${command} EACCES`, { code: 'EACCES' });
        }
        return { stdout: 'ripgrep 14.1.1', stderr: '', code: 0 };
      });

      await expect(canUseRipgrep(true)).resolves.toBe(true);
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
    // A bundled binary that exists but dies on exec, e.g. arm64 kernels with
    // 64K pages (#2676).
    const builtinFailsSystemWorks = () => {
      stubInstall({ builtin: true, system: true });
      vi.mocked(execCommand).mockImplementation(async (command: string) => {
        if (command !== 'rg') {
          throw new Error(`Command failed: ${command} --version`);
        }
        return { stdout: 'ripgrep 14.1.1', stderr: '', code: 0 };
      });
    };

    it('falls back to system rg when the bundled binary exists but cannot run', async () => {
      builtinFailsSystemWorks();

      await expect(canUseRipgrep(true)).resolves.toBe(true);
    });

    it('caches the fallback selection and does not re-probe the broken builtin', async () => {
      builtinFailsSystemWorks();
      await expect(canUseRipgrep(true)).resolves.toBe(true);

      vi.mocked(execCommand).mockClear();
      await expect(canUseRipgrep(true)).resolves.toBe(true);

      expect(execCommand).not.toHaveBeenCalled();
    });

    it('reports the bundled failure when system rg is unusable too', async () => {
      stubInstall({ builtin: true, system: true });
      vi.mocked(execCommand).mockImplementation(async (command: string) => {
        throw new Error(
          command === 'rg' ? 'system rg broken' : 'bundled rg broken',
        );
      });

      // The bundled failure is the root cause, so it must not be masked by the
      // system probe that ran after it.
      await expect(canUseRipgrep(true)).rejects.toThrow('bundled rg broken');
      expect(execCommand).toHaveBeenCalledWith(
        'rg',
        ['--version'],
        expect.anything(),
      );
    });

    it('leaves the system-only selection unpolluted after a fallback', async () => {
      builtinFailsSystemWorks();
      await expect(canUseRipgrep(true)).resolves.toBe(true);

      await expect(resolveRipgrep(false)).resolves.toEqual({
        mode: 'system',
        command: 'rg',
      });
    });

    it('resolves for every concurrent caller, not just the first', async () => {
      builtinFailsSystemWorks();

      await expect(
        Promise.all([canUseRipgrep(true), canUseRipgrep(true)]),
      ).resolves.toEqual([true, true]);
    });

    it('lets runRipgrep fall back instead of throwing', async () => {
      builtinFailsSystemWorks();
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

    it('rejects a system rg that does not identify itself as ripgrep', async () => {
      stubInstall({ builtin: true, system: true });
      vi.mocked(execCommand).mockImplementation(async (command: string) => {
        if (command !== 'rg') {
          throw new Error('bundled rg broken');
        }
        // Exits cleanly, but is not ripgrep.
        return { stdout: 'not-ripgrep 1.0', stderr: '', code: 0 };
      });

      await expect(canUseRipgrep(true)).rejects.toThrow();
    });

    it('never probes the bundled binary when useBuiltin is false (#5361)', async () => {
      stubInstall({ system: true });
      vi.mocked(execCommand).mockRejectedValue(new Error('system rg broken'));

      await expect(canUseRipgrep(false)).rejects.toThrow('system rg broken');
      expect(fileExists).not.toHaveBeenCalled();
    });
  });
});
