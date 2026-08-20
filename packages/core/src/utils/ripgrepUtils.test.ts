/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

function mockRipgrepAttempt(options: {
  error?: RipgrepTestError;
  stdout?: string;
  stderr?: string;
  spawnError?: RipgrepTestError;
  order?: 'callback-only' | 'error-only' | 'callback-then-error';
}): void {
  childProcessMock.execFile.mockImplementationOnce(
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
      const order = options.order ?? 'callback-only';
      queueMicrotask(() => {
        if (order !== 'error-only') {
          callback(
            options.error ?? null,
            options.stdout ?? '',
            options.stderr ?? '',
          );
        }
        if (options.spawnError) {
          child.emit('error', options.spawnError);
        }
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

describe('ripgrepUtils', () => {
  beforeEach(() => {
    _resetRipgrepUtilsCachesForTest();
    vi.mocked(fileExists).mockReset();
    vi.mocked(execCommand).mockReset();
    vi.mocked(isCommandAvailable).mockReset();
    childProcessMock.execFile.mockReset();
    vi.mocked(execCommand).mockResolvedValue({
      stdout: 'ripgrep 14.1.0\n',
      stderr: '',
      code: 0,
    });
  });

  describe('getBuiltinRipgrep', () => {
    it('should return path with .exe extension on Windows', () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      // Mock Windows x64
      Object.defineProperty(process, 'platform', { value: 'win32' });
      Object.defineProperty(process, 'arch', { value: 'x64' });

      const rgPath = getBuiltinRipgrep();

      expect(rgPath).toContain('x64-win32');
      expect(rgPath).toContain('rg.exe');
      expect(rgPath).toContain(path.join('vendor', 'ripgrep'));

      // Restore original values
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    });

    it('should return path without .exe extension on macOS', () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      // Mock macOS arm64
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      Object.defineProperty(process, 'arch', { value: 'arm64' });

      const rgPath = getBuiltinRipgrep();

      expect(rgPath).toContain('arm64-darwin');
      expect(rgPath).toContain('rg');
      expect(rgPath).not.toContain('.exe');
      expect(rgPath).toContain(path.join('vendor', 'ripgrep'));

      // Restore original values
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    });

    it('should return path without .exe extension on Linux', () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      // Mock Linux x64
      Object.defineProperty(process, 'platform', { value: 'linux' });
      Object.defineProperty(process, 'arch', { value: 'x64' });

      const rgPath = getBuiltinRipgrep();

      expect(rgPath).toContain('x64-linux');
      expect(rgPath).toContain('rg');
      expect(rgPath).not.toContain('.exe');
      expect(rgPath).toContain(path.join('vendor', 'ripgrep'));

      // Restore original values
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    });

    it('should return null for unsupported platform', () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      // Mock unsupported platform
      Object.defineProperty(process, 'platform', { value: 'freebsd' });
      Object.defineProperty(process, 'arch', { value: 'x64' });

      expect(getBuiltinRipgrep()).toBeNull();

      // Restore original values
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    });

    it('should return null for unsupported architecture', () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      // Mock unsupported architecture
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      Object.defineProperty(process, 'arch', { value: 'ia32' });

      expect(getBuiltinRipgrep()).toBeNull();

      // Restore original values
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    });

    it('should handle all supported platform/arch combinations', () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;

      const combinations: Array<{
        platform: string;
        arch: string;
      }> = [
        { platform: 'darwin', arch: 'x64' },
        { platform: 'darwin', arch: 'arm64' },
        { platform: 'linux', arch: 'x64' },
        { platform: 'linux', arch: 'arm64' },
        { platform: 'win32', arch: 'x64' },
      ];

      combinations.forEach(({ platform, arch }) => {
        Object.defineProperty(process, 'platform', { value: platform });
        Object.defineProperty(process, 'arch', { value: arch });

        const rgPath = getBuiltinRipgrep();
        const binaryName = platform === 'win32' ? 'rg.exe' : 'rg';
        const expectedPathSegment = path.join(
          `${arch}-${platform}`,
          binaryName,
        );
        expect(rgPath).toContain(expectedPathSegment);
      });

      // Restore original values
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    });
  });

  describe('resolveRipgrep', () => {
    it('keeps builtin and system selections cached separately', async () => {
      vi.mocked(fileExists).mockResolvedValue(true);
      vi.mocked(isCommandAvailable).mockReturnValue({
        available: true,
        error: undefined,
      });

      await expect(resolveRipgrep(true)).resolves.toMatchObject({
        mode: 'builtin',
      });
      await expect(resolveRipgrep(false)).resolves.toEqual({
        mode: 'system',
        command: 'rg',
      });
    });

    it('falls back to system ripgrep when builtin is enabled but unavailable', async () => {
      vi.mocked(fileExists).mockResolvedValue(false);
      vi.mocked(isCommandAvailable).mockReturnValue({
        available: true,
        error: undefined,
      });

      await expect(resolveRipgrep(true)).resolves.toEqual({
        mode: 'system',
        command: 'rg',
      });
    });
  });

  describe('runRipgrep', () => {
    beforeEach(() => {
      vi.mocked(fileExists).mockResolvedValue(true);
    });

    it('treats exit code 1 with empty stdout and stderr as no matches', async () => {
      mockRipgrepAttempt({
        error: createExecError('Command failed', { code: 1 }),
      });

      const result = await runRipgrep(['--threads', '4']);

      expect(result).toEqual({
        stdout: '',
        incomplete: false,
        recovery: {
          selectionMode: 'builtin',
          retryTriggered: false,
        },
      });
    });

    it('does not treat exit code 1 with stderr as no matches', async () => {
      const error = createExecError('Command failed', { code: 1 });
      mockRipgrepAttempt({
        error,
        stderr: 'rg: ./secret: Permission denied\n',
      });

      const result = await runRipgrep(['--threads', '4']);

      expect(result).toMatchObject({
        stdout: '',
        incomplete: false,
        error,
        recovery: {
          selectionMode: 'builtin',
          retryTriggered: false,
          failureKind: 'exit',
        },
      });
    });

    it('treats exit code 1 with json summary on stdout as no matches', async () => {
      const summary = '{"data":{"stats":{"matches":0}},"type":"summary"}\n';
      mockRipgrepAttempt({
        error: createExecError('Command failed', { code: 1 }),
        stdout: summary,
      });

      const result = await runRipgrep(['--threads', '4']);

      expect(result).toEqual({
        stdout: summary,
        incomplete: false,
        recovery: {
          selectionMode: 'builtin',
          retryTriggered: false,
        },
      });
    });

    it('treats exit code 1 with both stdout and stderr as an exit error', async () => {
      const error = createExecError('Command failed', { code: 1 });
      mockRipgrepAttempt({
        error,
        stdout: 'file.ts:1:match\n',
        stderr: 'rg: ./restricted: Permission denied\n',
      });

      const result = await runRipgrep(['--threads', '4']);

      expect(result).toMatchObject({
        stdout: 'file.ts:1:match\n',
        incomplete: true,
        error,
        recovery: {
          selectionMode: 'builtin',
          retryTriggered: false,
          failureKind: 'exit',
        },
      });
    });

    it('retries a confirmed internal thread EAGAIN with one thread', async () => {
      mockRipgrepAttempt({
        error: createExecError('Command failed', { code: 2 }),
        stderr:
          'rg: failed to create worker thread: Resource temporarily unavailable (os error 11)\n',
      });
      mockRipgrepAttempt({
        stdout: 'file.ts:1:needle\n',
      });

      const args = ['--json', '--threads', '4', '.'];
      const result = await runRipgrep(args);

      expect(childProcessMock.execFile).toHaveBeenCalledTimes(2);
      expect(childProcessMock.execFile.mock.calls[1][1]).toEqual([
        '--json',
        '--threads',
        '1',
        '.',
      ]);
      expect(args).toEqual(['--json', '--threads', '4', '.']);
      expect(result).toEqual({
        stdout: 'file.ts:1:needle\n',
        incomplete: false,
        recovery: {
          selectionMode: 'builtin',
          retryTriggered: true,
          retrySucceeded: true,
          failureKind: 'eagain',
        },
      });
    });

    it('returns the retry failure when the single-thread retry also fails', async () => {
      const retryError = createExecError('Command failed', { code: 2 });
      mockRipgrepAttempt({
        error: createExecError('Command failed', { code: 2 }),
        stderr:
          'rg: failed to create worker thread: Resource temporarily unavailable (os error 11)\n',
      });
      mockRipgrepAttempt({
        error: retryError,
        stderr: 'rg: regex parse error\n',
      });

      const result = await runRipgrep(['--json', '--threads', '4', '.']);

      expect(childProcessMock.execFile).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        stdout: '',
        incomplete: false,
        error: retryError,
        recovery: {
          selectionMode: 'builtin',
          retryTriggered: true,
          retrySucceeded: false,
          failureKind: 'exit',
        },
      });
    });

    it('marks retry result as incomplete when retry produces partial output', async () => {
      mockRipgrepAttempt({
        error: createExecError('Command failed', { code: 2 }),
        stderr:
          'rg: failed to create worker thread: Resource temporarily unavailable (os error 11)\n',
      });
      const retryError = createExecError('Command timed out', {
        signal: 'SIGTERM',
      });
      mockRipgrepAttempt({
        error: retryError,
        stdout: 'file.ts:1:partial\nfile.ts:2:incomplete-line',
      });

      const result = await runRipgrep(['--json', '--threads', '4', '.']);

      expect(result).toMatchObject({
        incomplete: true,
        recovery: {
          selectionMode: 'builtin',
          retryTriggered: true,
          retrySucceeded: false,
          failureKind: 'timeout',
        },
      });
      expect(result.stdout).toBe('file.ts:1:partial');
    });

    it('does not retry a spawn EAGAIN because ripgrep never started', async () => {
      const error = createExecError('spawn EAGAIN', { code: 'EAGAIN' });
      mockRipgrepAttempt({
        spawnError: error,
        order: 'error-only',
      });

      const result = await runRipgrep(['--json', '--threads', '4', '.']);

      expect(childProcessMock.execFile).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        stdout: '',
        incomplete: false,
        error,
        recovery: {
          selectionMode: 'builtin',
          retryTriggered: false,
          failureKind: 'spawn',
        },
      });
    });

    it('does not retry canceled execution even when stderr mentions thread EAGAIN', async () => {
      const controller = new AbortController();
      controller.abort();
      const error = Object.assign(
        createExecError('The operation was aborted'),
        {
          name: 'AbortError',
        },
      );
      mockRipgrepAttempt({
        error,
        stderr:
          'rg: failed to create worker thread: Resource temporarily unavailable (os error 11)\n',
      });

      const result = await runRipgrep(
        ['--json', '--threads', '4', '.'],
        controller.signal,
      );

      expect(childProcessMock.execFile).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        stdout: '',
        incomplete: false,
        error,
        recovery: {
          selectionMode: 'builtin',
          retryTriggered: false,
        },
      });
      expect(result.recovery.failureKind).toBeUndefined();
    });

    it('marks canceled execution with partial stdout as incomplete and drops the last line', async () => {
      const controller = new AbortController();
      controller.abort();
      const error = Object.assign(
        createExecError('The operation was aborted'),
        { name: 'AbortError' },
      );
      mockRipgrepAttempt({
        error,
        stdout: 'file.ts:1:complete\nfile.ts:2:partial',
        stderr:
          'rg: failed to create worker thread: Resource temporarily unavailable (os error 11)\n',
      });

      const result = await runRipgrep(
        ['--json', '--threads', '4', '.'],
        controller.signal,
      );

      expect(result).toMatchObject({
        stdout: 'file.ts:1:complete',
        incomplete: true,
        error,
        recovery: {
          selectionMode: 'builtin',
          retryTriggered: false,
        },
      });
      expect(result.recovery.failureKind).toBeUndefined();
    });

    it('does not retry unconfirmed resource unavailable text', async () => {
      const error = createExecError('Command failed', { code: 2 });
      mockRipgrepAttempt({
        error,
        stderr: 'rg: Resource temporarily unavailable\n',
      });

      const result = await runRipgrep(['--json', '--threads', '4', '.']);

      expect(childProcessMock.execFile).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        stdout: '',
        incomplete: false,
        error,
        recovery: {
          selectionMode: 'builtin',
          retryTriggered: false,
          failureKind: 'exit',
        },
      });
    });

    it('retries os error 11 as a short EAGAIN marker', async () => {
      mockRipgrepAttempt({
        error: createExecError('Command failed', { code: 2 }),
        stderr: 'rg: os error 11\n',
      });
      mockRipgrepAttempt({
        stdout: 'file.ts:1:needle\n',
      });

      const result = await runRipgrep(['--json', '--threads', '4', '.']);

      expect(childProcessMock.execFile).toHaveBeenCalledTimes(2);
      expect(childProcessMock.execFile.mock.calls[1][1]).toEqual([
        '--json',
        '--threads',
        '1',
        '.',
      ]);
      expect(result).toEqual({
        stdout: 'file.ts:1:needle\n',
        incomplete: false,
        recovery: {
          selectionMode: 'builtin',
          retryTriggered: true,
          retrySucceeded: true,
          failureKind: 'eagain',
        },
      });
    });

    it('does not retry when the expected --threads 4 pair is absent', async () => {
      const error = createExecError('Command failed', { code: 2 });
      mockRipgrepAttempt({
        error,
        stderr: 'rg: worker thread failed: Resource temporarily unavailable\n',
      });

      const result = await runRipgrep(['--json', '.']);

      expect(childProcessMock.execFile).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        error,
        recovery: {
          selectionMode: 'builtin',
          retryTriggered: false,
          failureKind: 'eagain',
        },
      });
    });

    it('removes the potentially incomplete last line after timeout', async () => {
      const error = createExecError('Command timed out', {
        signal: 'SIGTERM',
      });
      mockRipgrepAttempt({
        error,
        stdout: 'file.ts:1:complete\nfile.ts:2:partial',
      });

      const result = await runRipgrep(['--threads', '4']);

      expect(result).toMatchObject({
        stdout: 'file.ts:1:complete',
        incomplete: true,
        error,
        recovery: {
          selectionMode: 'builtin',
          retryTriggered: false,
          failureKind: 'timeout',
        },
      });
    });

    it('classifies maxBuffer output as incomplete', async () => {
      const error = createExecError('stdout maxBuffer length exceeded', {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      });
      mockRipgrepAttempt({
        error,
        stdout: 'file.ts:1:complete\nfile.ts:2:partial',
      });

      const result = await runRipgrep(['--threads', '4']);

      expect(result).toMatchObject({
        stdout: 'file.ts:1:complete',
        incomplete: true,
        error,
        recovery: {
          selectionMode: 'builtin',
          retryTriggered: false,
          failureKind: 'max_buffer',
        },
      });
    });

    it('settles one attempt once when callback and error event both arrive', async () => {
      mockRipgrepAttempt({
        error: createExecError('Command failed', { code: 2 }),
        stderr:
          'rg: failed to spawn worker threads: Resource temporarily unavailable (os error 11)\n',
        spawnError: createExecError('late spawn error', { code: 'EAGAIN' }),
        order: 'callback-then-error',
      });
      mockRipgrepAttempt({
        stdout: 'file.ts:1:needle\n',
      });

      const result = await runRipgrep(['--json', '--threads', '4', '.']);

      expect(childProcessMock.execFile).toHaveBeenCalledTimes(2);
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
      vi.mocked(fileExists).mockResolvedValue(true);
      vi.mocked(isCommandAvailable).mockReturnValue({
        available: true,
        error: undefined,
      });
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
      vi.mocked(fileExists).mockResolvedValue(true);
      vi.mocked(isCommandAvailable).mockReturnValue({
        available: true,
        error: undefined,
      });
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
      mockRipgrepAttempt({
        stdout: 'ripgrep 14.1.1\n',
      });

      await expect(runRipgrep(['--version'])).resolves.toMatchObject({
        stdout: 'ripgrep 14.1.1\n',
        recovery: {
          selectionMode: 'system',
        },
      });
      expect(childProcessMock.execFile.mock.calls[0][0]).toBe('rg');
    });

    it('reports the bundled failure when no system rg is installed', async () => {
      vi.mocked(fileExists).mockResolvedValue(true);
      vi.mocked(isCommandAvailable).mockReturnValue({
        available: false,
        error: undefined,
      });
      vi.mocked(execCommand).mockRejectedValue(new Error('bundled rg broken'));

      // Bundled binary fails and there is no system rg to fall back to.
      await expect(canUseRipgrep(true)).rejects.toThrow('bundled rg broken');
    });

    it('returns false when neither bundled nor system rg is available', async () => {
      vi.mocked(fileExists).mockResolvedValue(false);
      vi.mocked(isCommandAvailable).mockReturnValue({
        available: false,
        error: undefined,
      });

      await expect(canUseRipgrep(true)).resolves.toBe(false);
    });

    it('rejects a system rg that does not identify itself as ripgrep', async () => {
      vi.mocked(fileExists).mockResolvedValue(true);
      vi.mocked(isCommandAvailable).mockReturnValue({
        available: true,
        error: undefined,
      });
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
      vi.mocked(isCommandAvailable).mockReturnValue({
        available: true,
        error: undefined,
      });
      vi.mocked(execCommand).mockRejectedValue(new Error('system rg broken'));

      await expect(canUseRipgrep(false)).rejects.toThrow('system rg broken');
      expect(fileExists).not.toHaveBeenCalled();
    });
  });
});
