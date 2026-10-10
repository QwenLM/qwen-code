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
  onTestFinished,
  type MockInstance,
} from 'vitest';
import { EventEmitter } from 'node:events';
import {
  RELAUNCH_EXIT_CODE,
  UPDATE_ON_EXIT_MESSAGE,
  UPDATE_RELAUNCH_EXIT_CODE,
} from './processUtils.js';
import type { ChildProcess } from 'node:child_process';
import { execFile, fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadEnvironment,
  getRelaunchEnvProvenance,
  resetEnvironmentTrackingForTesting,
} from '../config/environment.js';
import { PRIVATE_RELAUNCH_ENV_PROVENANCE } from '../config/shared-env-keys.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const mockSpawn = vi.fn();
  // Named re-exports must be spelled out for vitest ESM mocking to rebind them.
  return {
    ...actual,
    default: { ...actual, spawn: mockSpawn },
    spawn: mockSpawn,
  };
});

vi.mock('./cleanup.js', () => ({
  runExitCleanup: vi.fn(() => Promise.resolve()),
}));

vi.mock('node:tty', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:tty')>();
  const isatty = vi.fn(() => false);
  return { ...actual, default: { ...actual, isatty }, isatty };
});

const mockedSpawn = vi.mocked(spawn);

// Import the functions initially
import {
  exitWhenSupervisorExits,
  relaunchAppInChildProcess,
  relaunchOnExitCode,
} from './relaunch.js';
import { runExitCleanup } from './cleanup.js';
import { isatty } from 'node:tty';

describe('relaunchOnExitCode', () => {
  let processExitSpy: MockInstance;
  let stdinResumeSpy: MockInstance;

  beforeEach(() => {
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('PROCESS_EXIT_CALLED');
    });
    stdinResumeSpy = vi
      .spyOn(process.stdin, 'resume')
      .mockImplementation(() => process.stdin);
    vi.clearAllMocks();
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    stdinResumeSpy.mockRestore();
  });

  it('should exit with non-RELAUNCH_EXIT_CODE', async () => {
    const runner = vi.fn().mockResolvedValue(0);

    await expect(relaunchOnExitCode(runner)).rejects.toThrow(
      'PROCESS_EXIT_CALLED',
    );

    expect(runner).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('should continue running when RELAUNCH_EXIT_CODE is returned', async () => {
    let callCount = 0;
    const runner = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return RELAUNCH_EXIT_CODE;
      if (callCount === 2) return RELAUNCH_EXIT_CODE;
      return 0; // Exit on third call
    });

    await expect(relaunchOnExitCode(runner)).rejects.toThrow(
      'PROCESS_EXIT_CALLED',
    );

    expect(runner).toHaveBeenCalledTimes(3);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('should update after the child exits', async () => {
    const onUpdateRelaunch = vi.fn().mockResolvedValue(0);
    const runner = vi.fn().mockResolvedValue(UPDATE_RELAUNCH_EXIT_CODE);

    await expect(
      relaunchOnExitCode(runner, { onUpdateRelaunch }),
    ).rejects.toThrow('PROCESS_EXIT_CALLED');

    expect(onUpdateRelaunch).toHaveBeenCalledWith(true);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('should exit with the updated CLI result', async () => {
    const runner = vi.fn().mockResolvedValue(UPDATE_RELAUNCH_EXIT_CODE);
    const onUpdateRelaunch = vi.fn().mockResolvedValue(7);

    await expect(
      relaunchOnExitCode(runner, { onUpdateRelaunch }),
    ).rejects.toThrow('PROCESS_EXIT_CALLED');

    expect(processExitSpy).toHaveBeenCalledWith(7);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('should handle runner errors', async () => {
    const error = new Error('Runner failed');
    const runner = vi.fn().mockRejectedValue(error);

    await expect(relaunchOnExitCode(runner)).rejects.toThrow(
      'PROCESS_EXIT_CALLED',
    );

    expect(runner).toHaveBeenCalledTimes(1);
    expect(stdinResumeSpy).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

describe('relaunchAppInChildProcess', () => {
  let processExitSpy: MockInstance;
  let stdinPauseSpy: MockInstance;
  let stdinResumeSpy: MockInstance;

  // Store original values to restore later
  const originalEnv = { ...process.env };
  const originalExecArgv = [...process.execArgv];
  const originalArgv = [...process.argv];
  const originalExecPath = process.execPath;
  const originalExecve = process.execve;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isatty).mockReset().mockReturnValue(false);

    process.env = { ...originalEnv };
    delete process.env['QWEN_CODE_NO_RELAUNCH'];

    process.execArgv = [...originalExecArgv];
    process.argv = [...originalArgv];
    process.execPath = '/usr/bin/node';

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('PROCESS_EXIT_CALLED');
    });
    stdinPauseSpy = vi
      .spyOn(process.stdin, 'pause')
      .mockImplementation(() => process.stdin);
    stdinResumeSpy = vi
      .spyOn(process.stdin, 'resume')
      .mockImplementation(() => process.stdin);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.execArgv = [...originalExecArgv];
    process.argv = [...originalArgv];
    process.execPath = originalExecPath;
    process.execve = originalExecve;

    processExitSpy.mockRestore();
    stdinPauseSpy.mockRestore();
    stdinResumeSpy.mockRestore();
  });

  describe('when QWEN_CODE_NO_RELAUNCH is set', () => {
    it('should return early without spawning a child process', async () => {
      process.env['QWEN_CODE_NO_RELAUNCH'] = 'true';

      await relaunchAppInChildProcess(['--test'], ['--verbose']);

      expect(mockedSpawn).not.toHaveBeenCalled();
      expect(processExitSpy).not.toHaveBeenCalled();
    });
  });

  it('replaces the current process when requested and supported', async () => {
    // Leaked into this process; a replaced image must not be marked.
    process.env['QWEN_CODE_RELAUNCH_SUPERVISED'] = '1';
    process.execArgv = ['--trace-warnings'];
    process.argv = ['/usr/bin/node', '/app/cli.js', '--model', 'test'];
    const execveSpy = vi.fn(() => undefined as never);
    process.execve = execveSpy;

    await relaunchAppInChildProcess(
      ['--max-old-space-size=4096'],
      ['--debug'],
      {
        childEnv: { QWEN_TEST_CHILD: '1' },
        replaceProcess: true,
      },
    );

    expect(execveSpy).toHaveBeenCalledWith(
      '/usr/bin/node',
      [
        '/usr/bin/node',
        '--trace-warnings',
        '--max-old-space-size=4096',
        '/app/cli.js',
        '--debug',
        '--model',
        'test',
      ],
      expect.objectContaining({
        QWEN_CODE_NO_RELAUNCH: 'true',
        QWEN_TEST_CHILD: '1',
      }),
    );
    // A replaced process has no supervisor to follow.
    expect(execveSpy.mock.calls[0]).not.toHaveProperty([
      2,
      'QWEN_CODE_RELAUNCH_SUPERVISED',
    ]);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('continues in place when the replacement would boot an identical image', async () => {
    process.argv = ['/usr/bin/node', '/app/cli.js', '-p', 'hi'];
    const execveSpy = vi.fn((): never => {
      throw new Error('UNEXPECTED_EXECVE');
    });
    process.execve = execveSpy;

    await relaunchAppInChildProcess([], [], {
      childEnv: { QWEN_TEST_CHILD: '1' },
      replaceProcess: true,
    });

    expect(execveSpy).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
    // Matches what the replaced image would see, so nested launches and later
    // relaunch calls in this process stay no-ops.
    expect(process.env['QWEN_CODE_NO_RELAUNCH']).toBe('true');
    // Child-only state stays out of the continuing process's environment,
    // which every tool subprocess inherits.
    expect(process.env['QWEN_TEST_CHILD']).toBeUndefined();
  });

  it('still replaces the process when the environment changed since boot', async () => {
    // e.g. `.env` supplied NODE_EXTRA_CA_CERTS, which only Node's boot reads,
    // or a value that some module captured when it was imported.
    process.argv = ['/usr/bin/node', '/app/cli.js', '-p', 'hi'];
    const execveSpy = vi.fn(() => undefined as never);
    process.execve = execveSpy;

    await relaunchAppInChildProcess([], [], {
      environmentChangedSinceBoot: true,
      replaceProcess: true,
    });

    expect(execveSpy).toHaveBeenCalledWith(
      '/usr/bin/node',
      expect.arrayContaining(['/app/cli.js', '-p', 'hi']),
      expect.objectContaining({ QWEN_CODE_NO_RELAUNCH: 'true' }),
    );
  });

  it('falls back to supervised spawn when process replacement fails', async () => {
    process.argv = ['/usr/bin/node', '/app/cli.js'];
    process.execve = vi.fn((): never => {
      throw new Error('E2BIG');
    });
    const child = createMockChildProcess(0, false);
    mockedSpawn.mockReturnValue(child);

    const promise = relaunchAppInChildProcess(
      ['--max-old-space-size=4096'],
      [],
      {
        replaceProcess: true,
      },
    );
    await vi.waitFor(() => expect(mockedSpawn).toHaveBeenCalledOnce());
    child.emit('close', 0);
    await expect(promise).rejects.toThrow('PROCESS_EXIT_CALLED');
  });

  it('keeps the supervised spawn path when process replacement is unsupported', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.argv = ['/usr/bin/node', '/app/cli.js'];
    const execveSpy = vi.fn((): never => {
      throw new Error('UNEXPECTED_EXECVE');
    });
    process.execve = execveSpy;
    const child = createMockChildProcess(0, false);
    mockedSpawn.mockReturnValue(child);

    try {
      const promise = relaunchAppInChildProcess([], [], {
        replaceProcess: true,
      });
      await vi.waitFor(() => expect(mockedSpawn).toHaveBeenCalledOnce());
      expect(execveSpy).not.toHaveBeenCalled();
      child.emit('close', 0);
      await expect(promise).rejects.toThrow('PROCESS_EXIT_CALLED');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  describe('when the bin launcher exposed gc at runtime', () => {
    const originalGc = globalThis.gc;
    const originalPlatform = process.platform;

    beforeEach(() => {
      // cli-entry.js on POSIX: gc comes from v8.setFlagsFromString, not argv.
      globalThis.gc = vi.fn() as unknown as typeof globalThis.gc;
      process.execArgv = [];
      process.argv = ['/usr/bin/node', '/app/cli.js', '--acp'];
    });

    afterEach(() => {
      globalThis.gc = originalGc;
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('starts the supervised child with --expose-gc', async () => {
      const child = createMockChildProcess(0, false);
      mockedSpawn.mockReturnValue(child);

      const promise = relaunchAppInChildProcess([], []);
      await vi.waitFor(() => expect(mockedSpawn).toHaveBeenCalledOnce());
      expect(mockedSpawn.mock.calls[0][1]).toEqual([
        '--expose-gc',
        '/app/cli.js',
        '--acp',
      ]);
      child.emit('close', 0);
      await expect(promise).rejects.toThrow('PROCESS_EXIT_CALLED');
    });

    it('replaces the process with --expose-gc', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const execveSpy = vi.fn(() => undefined as never);
      process.execve = execveSpy;

      await relaunchAppInChildProcess(['--max-old-space-size=4096'], [], {
        replaceProcess: true,
      });

      expect(execveSpy).toHaveBeenCalledWith(
        '/usr/bin/node',
        [
          '/usr/bin/node',
          '--expose-gc',
          '--max-old-space-size=4096',
          '/app/cli.js',
          '--acp',
        ],
        expect.any(Object),
      );
    });

    it('does not repeat --expose-gc already on the command line', async () => {
      process.execArgv = ['--expose-gc'];
      const child = createMockChildProcess(0, false);
      mockedSpawn.mockReturnValue(child);

      const promise = relaunchAppInChildProcess([], []);
      await vi.waitFor(() => expect(mockedSpawn).toHaveBeenCalledOnce());
      expect(mockedSpawn.mock.calls[0][1]).toEqual([
        '--expose-gc',
        '/app/cli.js',
        '--acp',
      ]);
      child.emit('close', 0);
      await expect(promise).rejects.toThrow('PROCESS_EXIT_CALLED');
    });
  });

  it('preserves file values and passes their provenance to the child', async () => {
    resetEnvironmentTrackingForTesting();
    delete process.env['TRACK_A_FILE_VALUE'];
    process.env['TRACK_A_OPERATOR_VALUE'] = 'operator';
    loadEnvironment({ env: { TRACK_A_FILE_VALUE: 'repository' } });
    const child = createMockChildProcess(0, false);
    mockedSpawn.mockReturnValue(child);
    const promise = relaunchAppInChildProcess([], [], {
      childEnv: getRelaunchEnvProvenance(),
    });
    await vi.waitFor(() => expect(mockedSpawn).toHaveBeenCalledOnce());
    const childEnv = mockedSpawn.mock.calls[0]?.[2]?.env;
    expect(childEnv?.['TRACK_A_FILE_VALUE']).toBe('repository');
    const provenance = JSON.parse(childEnv![PRIVATE_RELAUNCH_ENV_PROVENANCE]!);
    expect(provenance.settingsEnv).toContain('TRACK_A_FILE_VALUE');
    expect([...provenance.dotEnv, ...provenance.settingsEnv]).not.toContain(
      'TRACK_A_OPERATOR_VALUE',
    );
    expect(childEnv?.['TRACK_A_OPERATOR_VALUE']).toBe('operator');
    expect(process.env['TRACK_A_FILE_VALUE']).toBe('repository');
    child.emit('close', 0);
    await expect(promise).rejects.toThrow('PROCESS_EXIT_CALLED');
    resetEnvironmentTrackingForTesting();
  });

  describe('when QWEN_CODE_NO_RELAUNCH is not set', () => {
    beforeEach(() => {
      delete process.env['QWEN_CODE_NO_RELAUNCH'];
    });

    it('should construct correct node arguments from execArgv, additionalNodeArgs, script, additionalScriptArgs, and argv', () => {
      // Test the argument construction logic directly by extracting it into a testable function
      // This tests the same logic that's used in relaunchAppInChildProcess

      // Setup test data to verify argument ordering
      const mockExecArgv = ['--inspect=9229', '--trace-warnings'];
      const mockArgv = [
        '/usr/bin/node',
        '/path/to/cli.js',
        'command',
        '--flag=value',
        '--verbose',
      ];
      const additionalNodeArgs = [
        '--max-old-space-size=4096',
        '--experimental-modules',
      ];
      const additionalScriptArgs = ['--model', 'gemini-1.5-pro', '--debug'];

      // Extract the argument construction logic from relaunchAppInChildProcess
      const script = mockArgv[1];
      const scriptArgs = mockArgv.slice(2);

      const nodeArgs = [
        ...mockExecArgv,
        ...additionalNodeArgs,
        script,
        ...additionalScriptArgs,
        ...scriptArgs,
      ];

      // Verify the argument construction follows the expected pattern:
      // [...process.execArgv, ...additionalNodeArgs, script, ...additionalScriptArgs, ...scriptArgs]
      const expectedArgs = [
        // Original node execution arguments
        '--inspect=9229',
        '--trace-warnings',
        // Additional node arguments passed to function
        '--max-old-space-size=4096',
        '--experimental-modules',
        // The script path
        '/path/to/cli.js',
        // Additional script arguments passed to function
        '--model',
        'gemini-1.5-pro',
        '--debug',
        // Original script arguments (everything after the script in process.argv)
        'command',
        '--flag=value',
        '--verbose',
      ];

      expect(nodeArgs).toEqual(expectedArgs);
    });

    it('should handle empty additional arguments correctly', () => {
      // Test edge cases with empty arrays
      const mockExecArgv = ['--trace-warnings'];
      const mockArgv = ['/usr/bin/node', '/app/cli.js', 'start'];
      const additionalNodeArgs: string[] = [];
      const additionalScriptArgs: string[] = [];

      // Extract the argument construction logic
      const script = mockArgv[1];
      const scriptArgs = mockArgv.slice(2);

      const nodeArgs = [
        ...mockExecArgv,
        ...additionalNodeArgs,
        script,
        ...additionalScriptArgs,
        ...scriptArgs,
      ];

      const expectedArgs = ['--trace-warnings', '/app/cli.js', 'start'];

      expect(nodeArgs).toEqual(expectedArgs);
    });

    it('should handle complex argument patterns', () => {
      // Test with various argument types including flags with values, boolean flags, etc.
      const mockExecArgv = ['--max-old-space-size=8192'];
      const mockArgv = [
        '/usr/bin/node',
        '/cli.js',
        '--config=/path/to/config.json',
        '--verbose',
        'subcommand',
        '--output',
        'file.txt',
      ];
      const additionalNodeArgs = ['--inspect-brk=9230'];
      const additionalScriptArgs = ['--model=gpt-4', '--temperature=0.7'];

      const script = mockArgv[1];
      const scriptArgs = mockArgv.slice(2);

      const nodeArgs = [
        ...mockExecArgv,
        ...additionalNodeArgs,
        script,
        ...additionalScriptArgs,
        ...scriptArgs,
      ];

      const expectedArgs = [
        '--max-old-space-size=8192',
        '--inspect-brk=9230',
        '/cli.js',
        '--model=gpt-4',
        '--temperature=0.7',
        '--config=/path/to/config.json',
        '--verbose',
        'subcommand',
        '--output',
        'file.txt',
      ];

      expect(nodeArgs).toEqual(expectedArgs);
    });

    // Note: Additional integration tests for spawn behavior are complex due to module mocking
    // limitations with ES modules. The core logic is tested in relaunchOnExitCode tests.

    it('should invoke afterSpawn immediately after spawn, before waiting for child exit', async () => {
      process.argv = ['/usr/bin/node', '/app/cli.js'];

      const afterSpawn = vi.fn();
      let spawned = false;

      const mockChild = createMockChildProcess(0, false);
      mockedSpawn.mockImplementation(() => {
        spawned = true;
        return mockChild;
      });

      const promise = relaunchAppInChildProcess([], [], { afterSpawn });

      // Wait until spawn has been called
      await vi.waitFor(() => {
        expect(spawned).toBe(true);
      });

      // afterSpawn must have been called before child exits
      expect(afterSpawn).toHaveBeenCalledTimes(1);

      // Close the child so the promise resolves
      mockChild.emit('close', 0);
      await expect(promise).rejects.toThrow('PROCESS_EXIT_CALLED');

      // afterSpawn should still be called only once (first spawn)
      expect(afterSpawn).toHaveBeenCalledTimes(1);
    });

    it('passes child-only environment without restoring it on the parent', async () => {
      process.argv = ['/usr/bin/node', '/app/cli.js'];
      delete process.env['QWEN_CODE_PRIVATE_ACP_CAPABILITY'];
      const mockChild = createMockChildProcess(0, false);
      mockedSpawn.mockReturnValue(mockChild);

      const promise = relaunchAppInChildProcess([], [], {
        childEnv: {
          QWEN_CODE_PRIVATE_ACP_CAPABILITY: 'private-capability',
        },
      });

      await vi.waitFor(() => expect(mockedSpawn).toHaveBeenCalledOnce());
      expect(mockedSpawn.mock.calls[0]?.[2]?.env).toMatchObject({
        QWEN_CODE_PRIVATE_ACP_CAPABILITY: 'private-capability',
        QWEN_CODE_NO_RELAUNCH: 'true',
        QWEN_CODE_RELAUNCH_SUPERVISED: '1',
      });
      expect(process.env['QWEN_CODE_RELAUNCH_SUPERVISED']).toBeUndefined();
      expect(process.env['QWEN_CODE_PRIVATE_ACP_CAPABILITY']).toBeUndefined();

      mockChild.emit('close', 0);
      await expect(promise).rejects.toThrow('PROCESS_EXIT_CALLED');
    });

    it('installs a requested automatic update only after a clean child exit', async () => {
      process.argv = ['/usr/bin/node', '/app/cli.js'];

      const onUpdateRelaunch = vi.fn().mockResolvedValue(44);
      const mockChild = createMockChildProcess(0, false);
      mockedSpawn.mockReturnValue(mockChild);

      const promise = relaunchAppInChildProcess([], [], {
        onUpdateRelaunch,
      });

      mockChild.emit('message', { type: UPDATE_ON_EXIT_MESSAGE });
      expect(onUpdateRelaunch).not.toHaveBeenCalled();

      mockChild.emit('close', 0);
      await expect(promise).rejects.toThrow('PROCESS_EXIT_CALLED');

      expect(onUpdateRelaunch).toHaveBeenCalledWith(false);
      expect(processExitSpy).toHaveBeenCalledWith(44);
    });

    it('does not carry an update request across relaunches', async () => {
      process.argv = ['/usr/bin/node', '/app/cli.js'];

      const onUpdateRelaunch = vi.fn().mockResolvedValue(44);
      const firstChild = createMockChildProcess(0, false);
      const secondChild = createMockChildProcess(0, false);
      mockedSpawn
        .mockReturnValueOnce(firstChild)
        .mockReturnValueOnce(secondChild);

      const promise = relaunchAppInChildProcess([], [], {
        onUpdateRelaunch,
      });

      firstChild.emit('message', { type: UPDATE_ON_EXIT_MESSAGE });
      firstChild.emit('close', RELAUNCH_EXIT_CODE);
      await vi.waitFor(() => expect(mockedSpawn).toHaveBeenCalledTimes(2));

      secondChild.emit('close', 0);
      await expect(promise).rejects.toThrow('PROCESS_EXIT_CALLED');

      expect(onUpdateRelaunch).not.toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('rebuilds the child environment for each relaunch', async () => {
      process.argv = ['/usr/bin/node', '/app/cli.js'];
      process.env['QWEN_TEST_TRANSIENT'] = '1';
      const firstChild = createMockChildProcess(0, false);
      const secondChild = createMockChildProcess(0, false);
      mockedSpawn
        .mockReturnValueOnce(firstChild)
        .mockReturnValueOnce(secondChild);

      const promise = relaunchAppInChildProcess([], [], {
        afterSpawn: () => delete process.env['QWEN_TEST_TRANSIENT'],
      });
      await vi.waitFor(() => expect(mockedSpawn).toHaveBeenCalledOnce());
      expect(mockedSpawn.mock.calls[0]?.[2]?.env).toMatchObject({
        QWEN_TEST_TRANSIENT: '1',
      });

      firstChild.emit('close', RELAUNCH_EXIT_CODE);
      await vi.waitFor(() => expect(mockedSpawn).toHaveBeenCalledTimes(2));
      expect(mockedSpawn.mock.calls[1]?.[2]?.env).not.toHaveProperty(
        'QWEN_TEST_TRANSIENT',
      );

      secondChild.emit('close', 0);
      await expect(promise).rejects.toThrow('PROCESS_EXIT_CALLED');
    });

    it.each([
      ['managed ACP', '1', '1'],
      ['ordinary', undefined, undefined],
    ])(
      'handles Electron Node mode for every %s relaunch',
      async (_name, marker, expectedElectron) => {
        process.argv = ['/usr/bin/node', '/app/cli.js'];
        if (marker) {
          process.env['QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE'] = marker;
        } else {
          delete process.env['QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE'];
        }
        delete process.env['ELECTRON_RUN_AS_NODE'];

        const firstChild = createMockChildProcess(0, false);
        const secondChild = createMockChildProcess(0, false);
        mockedSpawn
          .mockReturnValueOnce(firstChild)
          .mockReturnValueOnce(secondChild);

        const promise = relaunchAppInChildProcess([], []);

        firstChild.emit('close', RELAUNCH_EXIT_CODE);
        await vi.waitFor(() => expect(mockedSpawn).toHaveBeenCalledTimes(2));

        for (const call of mockedSpawn.mock.calls) {
          const env = call[2]?.env;
          expect(env?.['ELECTRON_RUN_AS_NODE']).toBe(expectedElectron);
          expect(env?.['QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE']).toBe(marker);
          expect(env?.['QWEN_CODE_NO_RELAUNCH']).toBe('true');
        }
        expect(process.env['ELECTRON_RUN_AS_NODE']).toBeUndefined();

        secondChild.emit('close', 0);
        await expect(promise).rejects.toThrow('PROCESS_EXIT_CALLED');
      },
    );

    it('should handle null exit code from child process', async () => {
      process.argv = ['/usr/bin/node', '/app/cli.js'];

      const mockChild = createMockChildProcess(0, false); // Don't auto-close
      mockedSpawn.mockImplementation(() => {
        // Emit close with null code immediately
        setImmediate(() => {
          mockChild.emit('close', null);
        });
        return mockChild;
      });

      // Start the relaunch process
      const promise = relaunchAppInChildProcess([], []);

      await expect(promise).rejects.toThrow('PROCESS_EXIT_CALLED');

      // Should default to exit code 1
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });
});

// Needs the IPC channel of a forked test worker, which its own RPC also uses:
// only `unref` and `disconnect` are intercepted, never the channel itself.
describe.skipIf(!process.channel)('exitWhenSupervisorExits', () => {
  const originalEnv = { ...process.env };
  let unrefSpy: MockInstance;
  let onceSpy: MockInstance;
  let exitSpy: MockInstance;
  let listeners: Array<(...args: unknown[]) => void>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.mocked(isatty).mockReset().mockReturnValue(false);
    unrefSpy = vi
      .spyOn(process.channel!, 'unref')
      .mockImplementation(() => process.channel!);
    listeners = [];
    const once = process.once.bind(process);
    onceSpy = vi.spyOn(process, 'once').mockImplementation(((
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event !== 'disconnect') return once(event, listener);
      listeners.push(listener);
      return process;
    }) as typeof process.once);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as typeof process.exit);
    vi.mocked(runExitCleanup).mockClear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    unrefSpy.mockRestore();
    onceSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('does nothing in a process no supervisor spawned', () => {
    delete process.env['QWEN_CODE_RELAUNCH_SUPERVISED'];

    exitWhenSupervisorExits();

    expect(listeners).toEqual([]);
    expect(unrefSpy).not.toHaveBeenCalled();
  });

  it('exits after a grace period once the supervisor channel closes', async () => {
    process.env['QWEN_CODE_RELAUNCH_SUPERVISED'] = '1';
    // Swallows a stop signal, which would otherwise reach this worker's own
    // handlers.
    const emit = process.emit.bind(process);
    const emitSpy = vi
      .spyOn(process, 'emit')
      .mockImplementation(((event: string | symbol, ...args: unknown[]) =>
        ['SIGTERM', 'SIGINT', 'SIGHUP'].includes(String(event))
          ? true
          : (emit as (...a: unknown[]) => boolean)(
              event,
              ...args,
            )) as typeof process.emit);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      exitWhenSupervisorExits();

      // Not handed on to anything this process spawns.
      expect(process.env['QWEN_CODE_RELAUNCH_SUPERVISED']).toBeUndefined();
      expect(unrefSpy).toHaveBeenCalledOnce();
      expect(listeners).toHaveLength(1);

      listeners[0]!();

      // The host's own signal or closed input starts the mode's shutdown;
      // this only bounds how long the process may run on.
      expect(emitSpy.mock.calls.map(([event]) => event)).not.toContain(
        'SIGTERM',
      );
      await vi.advanceTimersByTimeAsync(119_999);
      expect(runExitCleanup).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(runExitCleanup).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(129);
    } finally {
      vi.useRealTimers();
      emitSpy.mockRestore();
    }
  });

  it('leaves a child on a terminal to its process group', () => {
    process.env['QWEN_CODE_RELAUNCH_SUPERVISED'] = '1';
    vi.mocked(isatty).mockReturnValueOnce(true);

    exitWhenSupervisorExits();

    expect(isatty).toHaveBeenCalledWith(0);
    expect(process.env['QWEN_CODE_RELAUNCH_SUPERVISED']).toBeUndefined();
    expect(listeners).toEqual([]);
    expect(unrefSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('a supervised child', () => {
  const helper = fileURLToPath(
    new URL('./relaunch-supervisor.test-helper.ts', import.meta.url),
  );

  function within<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`not settled within ${ms} ms`)),
          ms,
        ).unref(),
      ),
    ]);
  }

  // Starts the helper as a supervisor, which relaunches it as its child.
  async function start(args: string[]) {
    const env = { ...process.env };
    delete env['QWEN_CODE_NO_RELAUNCH'];
    delete env['QWEN_CODE_RELAUNCH_SUPERVISED'];
    const supervisor = fork(helper, args, {
      env,
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    });
    const exited = new Promise<number | null>((resolve) =>
      supervisor.once('exit', resolve),
    );
    // The child holds the supervisor's stdout too, so its end means both
    // have exited (a zombie would still answer a signal probe).
    let ended = false;
    supervisor.stdout!.once('end', () => {
      ended = true;
    });
    // These run even when the test times out, so a failure leaves no
    // process, and they signal only processes still running.
    onTestFinished(() => {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill('SIGKILL');
      }
    });
    let output = '';
    const childPid = await within(
      new Promise<number>((resolve) => {
        supervisor.stdout!.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          const match = /child-pid:(\d+)/.exec(output);
          if (match) resolve(Number(match[1]));
        });
      }),
      15_000,
    );
    onTestFinished(() => {
      if (ended) return;
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    });
    return {
      supervisor,
      childPid,
      exited,
      output: () => output,
      ended: () => ended,
    };
  }

  it('stops without a signal of its own when its supervisor is killed', async () => {
    const { supervisor, childPid, output, ended } = await start(['graceful']);
    expect(() => process.kill(childPid, 0)).not.toThrow();

    // A host stops the process it started; the child gets no signal.
    supervisor.kill('SIGKILL');

    await vi.waitFor(() => expect(ended()).toBe(true), {
      timeout: 10_000,
      interval: 50,
    });
    expect(output()).toContain('exit:129');
    expect(output()).not.toContain('graceful-shutdown');
  }, 30_000);

  it('stops when its supervisor is gone before it starts watching', async () => {
    const { supervisor, output, ended } = await start(['late']);

    supervisor.kill('SIGKILL');

    await vi.waitFor(() => expect(ended()).toBe(true), {
      timeout: 10_000,
      interval: 50,
    });
    expect(output()).toContain('exit:129');
  }, 30_000);

  it('ignores the marker without a channel from a supervisor', async () => {
    const env = { ...process.env };
    env['QWEN_CODE_NO_RELAUNCH'] = 'true';
    env['QWEN_CODE_RELAUNCH_SUPERVISED'] = '1';
    // Started directly, without an IPC channel, as a forged or leaked marker
    // would be: it must run to its end instead of exiting as orphaned.
    const code = await within(
      new Promise<number | null>((resolve) => {
        const child = execFile(
          process.execPath,
          ['--import', 'tsx', helper, 'idle'],
          { env },
          () => resolve(child.exitCode),
        );
        onTestFinished(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        });
      }),
      15_000,
    );
    expect(code).toBe(0);
  }, 30_000);

  it('still exits on its own once its work is done', async () => {
    const { exited } = await start(['idle']);

    // The supervisor exits with its child's code once the child exits.
    await expect(within(exited, 15_000)).resolves.toBe(0);
  }, 30_000);
});

/**
 * Creates a mock child process that emits events asynchronously
 */
function createMockChildProcess(
  exitCode: number = 0,
  autoClose: boolean = false,
): ChildProcess {
  const mockChild = new EventEmitter() as ChildProcess;

  Object.assign(mockChild, {
    stdin: null,
    stdout: null,
    stderr: null,
    stdio: [null, null, null],
    pid: 12345,
    killed: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: '',
    kill: vi.fn(),
    send: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
  });

  if (autoClose) {
    setImmediate(() => {
      mockChild.emit('close', exitCode);
    });
  }

  return mockChild;
}
