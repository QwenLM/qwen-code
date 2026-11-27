/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeStatusLineCommand } from './executeStatusLineCommand.js';
import type { StatusLineCommandInput } from './types.js';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  getShellConfiguration: vi.fn(),
  getPlatform: vi.fn(),
  treeKill: vi.fn(),
  tryFindGitBashPathForOptionalRunner: vi.fn(),
  resolveShellPrefix: vi.fn(),
  wrapPosixShellCommand: vi.fn(),
  runLogger: {
    log: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

vi.mock('tree-kill', () => ({
  default: mocks.treeKill,
}));

vi.mock('../utils/shell-utils.js', () => ({
  getShellConfiguration: mocks.getShellConfiguration,
}));

vi.mock('../utils/platform.js', () => ({
  getPlatform: mocks.getPlatform,
}));

vi.mock('../utils/windowsPaths.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../utils/windowsPaths.js')
  >();
  return {
    ...actual,
    tryFindGitBashPathForOptionalRunner:
      mocks.tryFindGitBashPathForOptionalRunner,
  };
});

vi.mock('../utils/shell/shellPrefix.js', () => ({
  resolveShellPrefix: mocks.resolveShellPrefix,
  wrapPosixShellCommand: mocks.wrapPosixShellCommand,
}));

vi.mock('../utils/runLogger.js', () => ({
  runLogger: mocks.runLogger,
}));

interface MockChildProcess extends EventEmitter {
  stdin: {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  pid: number;
}

const input: StatusLineCommandInput = {
  session_id: 'session-1',
  cwd: '/fallback',
  model: {
    id: 'model-1',
    display_name: 'Model One',
  },
  workspace: {
    current_dir: '/workspace',
    project_dir: '/workspace',
  },
};

describe('executeStatusLineCommand', () => {
  let child: MockChildProcess;
  const originalPath = process.env['PATH'];

  const waitForSpawn = async () => {
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getPlatform.mockReturnValue('linux');
    mocks.tryFindGitBashPathForOptionalRunner.mockResolvedValue(null);
    mocks.getShellConfiguration.mockReturnValue({
      shell: 'bash',
      executable: '/bin/bash',
      argsPrefix: ['-c'],
    });
    mocks.resolveShellPrefix.mockReturnValue(undefined);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    mocks.treeKill.mockImplementation(
      (
        _pid: number,
        _signal: NodeJS.Signals,
        callback: (error?: Error) => void,
      ) => callback(),
    );
    mocks.wrapPosixShellCommand.mockImplementation(
      (command: string, prefix: string) => `${prefix}::${command}`,
    );
    process.env['PATH'] = '/usr/bin';

    child = Object.assign(new EventEmitter(), {
      stdin: {
        write: vi.fn(),
        end: vi.fn(),
      },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      killed: false,
      pid: 12345,
    });
    mocks.spawn.mockReturnValue(child);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalPath === undefined) {
      delete process.env['PATH'];
    } else {
      process.env['PATH'] = originalPath;
    }
  });

  it('uses an available Git Bash for a wrapped Windows status line command', async () => {
    mocks.getPlatform.mockReturnValue('windows');
    mocks.tryFindGitBashPathForOptionalRunner.mockResolvedValue(
      'C:\\Program Files\\Git\\bin\\bash.exe',
    );
    mocks.resolveShellPrefix.mockReturnValue('/opt/tools/status logger');

    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'status.sh --compact' },
      input,
    );
    await waitForSpawn();

    expect(mocks.wrapPosixShellCommand).toHaveBeenCalledWith(
      'bash status.sh --compact',
      '/opt/tools/status logger',
    );
    expect(mocks.spawn).toHaveBeenCalledWith(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      ['-c', '/opt/tools/status logger::bash status.sh --compact'],
      expect.objectContaining({
        cwd: '/workspace',
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        detached: false,
        windowsHide: true,
        env: expect.objectContaining({
          PATH: 'C:\\Program Files\\Git\\bin;/usr/bin',
          SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe',
        }),
      }),
    );
    expect(mocks.getShellConfiguration).not.toHaveBeenCalled();
    expect(child.stdin.write).toHaveBeenCalledWith(JSON.stringify(input));
    expect(child.stdin.end).toHaveBeenCalledOnce();

    child.stdout.emit('data', Buffer.from('first\n\nsecond\n'));
    child.emit('close', 0);

    await expect(resultPromise).resolves.toBe('first\nsecond');
  });

  it('keeps the Windows Git Bash baseline when no prefix is configured', async () => {
    mocks.getPlatform.mockReturnValue('windows');
    mocks.tryFindGitBashPathForOptionalRunner.mockResolvedValue(
      'C:\\Program Files\\Git\\bin\\bash.exe',
    );

    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'status.sh --compact' },
      input,
    );
    await waitForSpawn();

    expect(mocks.resolveShellPrefix).toHaveBeenCalledOnce();
    expect(mocks.wrapPosixShellCommand).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledWith(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      ['-c', 'bash status.sh --compact'],
      expect.objectContaining({
        cwd: '/workspace',
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        detached: false,
        windowsHide: true,
        env: expect.objectContaining({
          PATH: 'C:\\Program Files\\Git\\bin;/usr/bin',
          SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe',
        }),
      }),
    );
    expect(mocks.getShellConfiguration).not.toHaveBeenCalled();

    child.stdout.emit('data', Buffer.from('ready'));
    child.emit('close', 0);
    await expect(resultPromise).resolves.toBe('ready');
  });

  it('falls back to PowerShell when Git Bash is unavailable on Windows', async () => {
    mocks.getPlatform.mockReturnValue('windows');
    mocks.tryFindGitBashPathForOptionalRunner.mockResolvedValue(null);
    mocks.getShellConfiguration.mockReturnValue({
      shell: 'powershell',
      executable: 'powershell.exe',
      argsPrefix: ['-NoProfile', '-Command'],
    });
    mocks.resolveShellPrefix.mockReturnValue('/opt/tools/status-logger');

    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'Write-Output "ready"' },
      input,
    );
    await waitForSpawn();

    expect(
      mocks.tryFindGitBashPathForOptionalRunner,
    ).toHaveBeenCalledOnce();
    expect(mocks.resolveShellPrefix).not.toHaveBeenCalled();
    expect(mocks.wrapPosixShellCommand).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Write-Output "ready"'],
      expect.objectContaining({
        detached: false,
        shell: false,
        windowsHide: true,
      }),
    );

    child.stdout.emit('data', Buffer.from('ready'));
    child.emit('close', 0);
    await expect(resultPromise).resolves.toBe('ready');
  });

  it('passes the original command through when no prefix is configured', async () => {
    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'status-script' },
      input,
    );
    await waitForSpawn();

    expect(mocks.wrapPosixShellCommand).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/bin/bash',
      ['-c', 'status-script'],
      expect.objectContaining({ detached: true, shell: false }),
    );

    child.stdout.emit('data', Buffer.from('ok'));
    child.emit('close', 0);
    await expect(resultPromise).resolves.toBe('ok');
  });

  it('clears the main deadline after a successful command', async () => {
    vi.useFakeTimers();
    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'status-script' },
      input,
    );
    await waitForSpawn();
    expect(vi.getTimerCount()).toBe(1);

    child.stdout.emit('data', Buffer.from('ok'));
    child.emit('close', 0);

    await expect(resultPromise).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the main deadline after a child process error', async () => {
    vi.useFakeTimers();
    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'status-script' },
      input,
    );
    await waitForSpawn();
    expect(vi.getTimerCount()).toBe(1);

    child.emit('error', new Error('spawn failed'));

    await expect(resultPromise).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not wrap PowerShell status line commands', async () => {
    mocks.getShellConfiguration.mockReturnValue({
      shell: 'powershell',
      executable: 'pwsh',
      argsPrefix: ['-NoProfile', '-Command'],
    });
    mocks.resolveShellPrefix.mockReturnValue('/opt/tools/status-logger');

    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'Write-Output "ready"' },
      input,
    );
    await waitForSpawn();

    expect(mocks.resolveShellPrefix).not.toHaveBeenCalled();
    expect(mocks.wrapPosixShellCommand).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledWith(
      'pwsh',
      ['-NoProfile', '-Command', 'Write-Output "ready"'],
      expect.objectContaining({ shell: false }),
    );

    child.stdout.emit('data', Buffer.from('ready'));
    child.emit('close', 0);
    await expect(resultPromise).resolves.toBe('ready');
  });

  it('logs the original command instead of the applied prefix', async () => {
    mocks.resolveShellPrefix.mockReturnValue('/secret/wrapper');

    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'safe-status-command' },
      input,
      undefined,
      5000,
      true,
    );
    await waitForSpawn();

    child.stdout.emit('data', Buffer.from('ready'));
    child.emit('close', 0);
    await resultPromise;

    expect(mocks.runLogger.log).toHaveBeenCalledWith(
      'StatusLine [safe-status-command] completed with status 0',
    );
    expect(mocks.runLogger.log).not.toHaveBeenCalledWith(
      expect.stringContaining('/secret/wrapper'),
    );
  });

  it('preserves non-zero stderr handling for a wrapped command', async () => {
    mocks.resolveShellPrefix.mockReturnValue('/opt/tools/status-logger');

    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'failing-status-command' },
      input,
      undefined,
      5000,
      true,
    );
    await waitForSpawn();

    child.stderr.emit('data', Buffer.from('wrapper failed'));
    child.emit('close', 9);

    await expect(resultPromise).resolves.toBeUndefined();
    expect(mocks.runLogger.warn).toHaveBeenCalledWith(
      'StatusLine [failing-status-command] completed with status 9',
    );
    expect(mocks.runLogger.warn).toHaveBeenCalledWith(
      'StatusLine stderr: wrapper failed',
    );
  });

  it('terminates the wrapped command tree and escalates on abort', async () => {
    vi.useFakeTimers();
    mocks.resolveShellPrefix.mockReturnValue('/opt/tools/status-logger');
    const controller = new AbortController();
    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'slow-status-command' },
      input,
      controller.signal,
    );
    await waitForSpawn();

    controller.abort();

    await expect(resultPromise).resolves.toBeUndefined();
    // POSIX teardown must never fork `pgrep` via tree-kill.
    expect(mocks.treeKill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(mocks.wrapPosixShellCommand).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(1499);
    expect(process.kill).not.toHaveBeenCalledWith(-12345, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(1);
    expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    expect(mocks.treeKill).not.toHaveBeenCalled();
  });

  it('preserves timeout handling for wrapped commands', async () => {
    vi.useFakeTimers();
    mocks.resolveShellPrefix.mockReturnValue('/opt/tools/status-logger');
    const controller = new AbortController();
    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'slow-status-command' },
      input,
      controller.signal,
      100,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toBeUndefined();
    expect(mocks.treeKill).not.toHaveBeenCalled();
    expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
    expect(mocks.wrapPosixShellCommand).toHaveBeenCalledOnce();

    // `ChildProcess.killed` only records that a signal was sent. It must not
    // suppress the grace-period escalation while the process is still alive.
    child.killed = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    expect(mocks.treeKill).not.toHaveBeenCalled();
  });

  it('does not escalate after the detached process group disappears', async () => {
    vi.useFakeTimers();
    let processTreeExited = false;
    const noSuchProcess = Object.assign(new Error('no such process'), {
      code: 'ESRCH',
    });
    const processKill = vi
      .mocked(process.kill)
      .mockImplementation((_pid, signal) => {
        if (signal === 0 && processTreeExited) throw noSuchProcess;
        return true;
      });
    const controller = new AbortController();
    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'slow-status-command' },
      input,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(resultPromise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(processKill).toHaveBeenCalledWith(-12345, 0);
    child.emit('close', null);
    processTreeExited = true;

    await vi.advanceTimersByTimeAsync(99);
    expect(processKill).not.toHaveBeenCalledWith(-12345, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1400);

    expect(mocks.treeKill).not.toHaveBeenCalled();
    expect(
      processKill.mock.calls.filter(
        ([pid, signal]) => pid === -12345 && signal === 'SIGTERM',
      ),
    ).toHaveLength(1);
    expect(processKill).toHaveBeenCalledWith(12345, 0);
    expect(processKill).not.toHaveBeenCalledWith(-12345, 'SIGKILL');
  });

  it('force-kills the surviving process group after the root exits', async () => {
    vi.useFakeTimers();
    const processKill = vi.mocked(process.kill);
    const controller = new AbortController();
    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'slow-status-command' },
      input,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(resultPromise).resolves.toBeUndefined();
    child.emit('close', null);
    await vi.advanceTimersByTimeAsync(1500);

    expect(processKill).toHaveBeenCalledWith(-12345, 0);
    expect(processKill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    expect(mocks.treeKill).not.toHaveBeenCalled();
  });

  it('does not suppress the Windows force tree-kill after root close', async () => {
    vi.useFakeTimers();
    mocks.getPlatform.mockReturnValue('windows');
    mocks.tryFindGitBashPathForOptionalRunner.mockResolvedValue(
      'C:\\Program Files\\Git\\bin\\bash.exe',
    );
    const controller = new AbortController();
    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'slow-status-command' },
      input,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(resultPromise).resolves.toBeUndefined();
    child.emit('close', null);
    await vi.advanceTimersByTimeAsync(1500);

    expect(mocks.treeKill).toHaveBeenCalledWith(
      12345,
      'SIGTERM',
      expect.any(Function),
    );
    expect(mocks.treeKill).toHaveBeenCalledWith(
      12345,
      'SIGKILL',
      expect.any(Function),
    );
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('refuses to signal a process group for an unsafe root pid', async () => {
    vi.useFakeTimers();
    child.pid = 1;
    const controller = new AbortController();
    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'slow-status-command' },
      input,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(resultPromise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1500);

    // `process.kill(-1, …)` would hit every process the user owns.
    expect(process.kill).not.toHaveBeenCalled();
    expect(mocks.treeKill).not.toHaveBeenCalled();
  });

  it('stays silent when the process group is already gone', async () => {
    vi.useFakeTimers();
    const noSuchProcess = Object.assign(new Error('no such process'), {
      code: 'ESRCH',
    });
    const processKill = vi.mocked(process.kill).mockImplementation(() => {
      throw noSuchProcess;
    });
    const controller = new AbortController();
    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'slow-status-command' },
      input,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(resultPromise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1500);

    expect(processKill).toHaveBeenCalledWith(-12345, 'SIGTERM');
    expect(mocks.runLogger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('StatusLine process group'),
    );
  });

  it('debug-logs a non-ESRCH process group failure', async () => {
    vi.useFakeTimers();
    vi.mocked(process.kill).mockImplementation((_pid, signal) => {
      if (signal === 0) return true;
      throw Object.assign(new Error('operation not permitted'), {
        code: 'EPERM',
      });
    });
    const controller = new AbortController();
    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'slow-status-command' },
      input,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(resultPromise).resolves.toBeUndefined();

    expect(mocks.runLogger.debug).toHaveBeenCalledWith(
      'StatusLine process group SIGTERM failed: operation not permitted',
    );
  });

  it('aborts while Windows shell discovery is still pending', async () => {
    vi.useFakeTimers();
    mocks.getPlatform.mockReturnValue('windows');
    mocks.tryFindGitBashPathForOptionalRunner.mockReturnValue(
      new Promise(() => undefined),
    );
    const controller = new AbortController();

    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'status-script' },
      input,
      controller.signal,
    );
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();

    await expect(resultPromise).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('does not start Windows shell discovery for a pre-aborted request', async () => {
    mocks.getPlatform.mockReturnValue('windows');
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeStatusLineCommand(
        { type: 'command', command: 'status-script' },
        input,
        controller.signal,
      ),
    ).resolves.toBeUndefined();
    expect(
      mocks.tryFindGitBashPathForOptionalRunner,
    ).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('counts Windows shell discovery against the status line timeout', async () => {
    vi.useFakeTimers();
    mocks.getPlatform.mockReturnValue('windows');
    mocks.tryFindGitBashPathForOptionalRunner.mockReturnValue(
      new Promise(() => undefined),
    );

    const resultPromise = executeStatusLineCommand(
      { type: 'command', command: 'status-script' },
      input,
      undefined,
      100,
    );
    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toBeUndefined();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
