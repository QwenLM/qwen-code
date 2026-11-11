/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetSnapshotsDirForTest,
  createAndSaveSnapshot,
  SNAPSHOT_HARD_TIMEOUT_MS,
  SNAPSHOT_SLOW_THRESHOLD_MS,
  setSnapshotsDir,
} from './ShellSnapshot.js';
import { runLogger } from '../runLogger.js';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  getPlatform: vi.fn(() => 'linux'),
  killProcessGroup: vi.fn(async () => {}),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: mocks.spawn,
  };
});

vi.mock('../platform.js', () => ({
  getPlatform: mocks.getPlatform,
}));

vi.mock('../process-utils.js', () => ({
  killProcessGroup: mocks.killProcessGroup,
}));

interface MockChild extends EventEmitter {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
}

function createMockChild(pid: number = 1234): MockChild {
  const child = new EventEmitter() as MockChild;
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

function completeMockChild(
  child: MockChild,
  code: number | null,
  signal: NodeJS.Signals | null = null,
): void {
  child.emit('exit', code, signal);
  child.emit('close', code, signal);
}

describe('ShellSnapshot process options', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'snapshot-spawn-test-'));
    setSnapshotsDir(tmpDir);
    mocks.spawn.mockClear();
    mocks.getPlatform.mockClear();
    mocks.killProcessGroup.mockClear();
    mocks.getPlatform.mockReturnValue('linux');
    mocks.killProcessGroup.mockResolvedValue(undefined);
    mocks.spawn.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => completeMockChild(child, 1));
      return child;
    });
  });

  afterEach(async () => {
    _resetSnapshotsDirForTest();
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('hides the snapshot shell window', async () => {
    await createAndSaveSnapshot('/bin/bash');

    expect(mocks.spawn).toHaveBeenCalledWith(
      '/bin/bash',
      expect.any(Array),
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('logs bounded error context and fallback without exposing shell operands', async () => {
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    mocks.spawn.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => {
        child.stderr.write('bash: line 11: export PATH=private-value: No such file or directory\n');
        completeMockChild(child, 127);
      });
      return child;
    });
    await expect(createAndSaveSnapshot('/bin/bash')).resolves.toBeUndefined();
    const logs = warn.mock.calls.flat().join('\n');
    expect(logs).toContain('fallback=login_shell');
    expect(logs).toContain('last_phase=process_spawned');
    expect(logs).toContain('shell:line=11:No such file or directory');
    expect(logs).not.toContain('private-value');
  });

  it('captures bash builtins without process substitution', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
    await writeFile(
      path.join(tmpDir, '.bashrc'),
      '__git_snapshot_helper() { :; }\n',
    );

    await createAndSaveSnapshot('/bin/bash');

    const call = mocks.spawn.mock.calls.at(-1);
    const snapshotScript = call?.[1]?.[2] as string | undefined;
    expect(snapshotScript).toBeDefined();
    expect(snapshotScript).toContain('builtin compgen -A function');
    expect(snapshotScript).toContain('builtin declare -f "$func"');
    expect(snapshotScript).toContain('for snapshot_option in $SHELLOPTS');
    expect(snapshotScript).toContain(
      'builtin compgen -A function >|',
    );
    expect(snapshotScript).toContain(
      'builtin alias -p >|',
    );
    expect(snapshotScript).toContain('.sh.capture');
    expect(snapshotScript).not.toContain('< <(builtin compgen -A function)');
    expect(snapshotScript).not.toContain('< <(builtin alias -p)');
    expect(snapshotScript).not.toMatch(/shopt -p\s*\|/);
    expect(snapshotScript).not.toMatch(/set -o\s*\|/);
    expect(snapshotScript).not.toMatch(/alias\s*\|\s*grep/);
    expect(snapshotScript).not.toMatch(/\|\s*base64\b/);
    expect(snapshotScript).not.toContain('base64 -d');
    expect(snapshotScript).toContain(':config_source_start');
    expect(snapshotScript).toContain(':config_source_done');
    expect(snapshotScript).toContain(':functions_start');
    expect(snapshotScript).toContain(':functions_done');
    expect(snapshotScript).toContain(':shell_options_start');
    expect(snapshotScript).toContain(':aliases_start');
    expect(snapshotScript).toContain(':tool_integrations_start');
    expect(snapshotScript).toContain(':path_start');
    expect(snapshotScript).toContain(':verify_done');
  });

  it('shell-quotes the login PATH captured on Windows', async () => {
    mocks.getPlatform.mockReturnValue('windows');
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
    await writeFile(path.join(tmpDir, '.bashrc'), '');

    await createAndSaveSnapshot('C:\\Program Files\\Git\\bin\\bash.exe');

    const call = mocks.spawn.mock.calls.at(-1);
    const snapshotScript = call?.[1]?.[2] as string | undefined;
    expect(snapshotScript).toContain(
      "builtin printf 'export PATH=%q\\n' \"$PATH\"",
    );
    expect(snapshotScript).not.toContain(
      'echo "export PATH=\\\\"$PATH\\\\""',
    );
    expect(call?.[2]).toEqual(
      expect.objectContaining({ detached: false }),
    );
  });

  it('includes the last completed shell phase in slow diagnostics', async () => {
    const timers: Array<{ callback: () => void; delay: number }> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((callback: () => void, delay?: number) => {
        timers.push({ callback, delay: delay ?? 0 });
        return timers.length as unknown as NodeJS.Timeout;
      }) as typeof setTimeout,
    );
    let snapshotScript: string | undefined;
    const child = createMockChild();
    mocks.spawn.mockImplementation(
      (_file: string, args: string[]) => {
        snapshotScript = args[2];
        return child;
      },
    );
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});

    const snapshotPromise = createAndSaveSnapshot('/bin/bash');
    await vi.waitFor(() => expect(snapshotScript).toBeDefined());

    const markerToken = snapshotScript?.match(
      /(__QWEN_SNAPSHOT_PHASE_[a-z0-9]+__)/,
    )?.[1];
    expect(markerToken).toBeDefined();
    child.stdout.write(
      Buffer.from(
        `user output\n${markerToken}:shell_ready\n` +
          `${markerToken}:config_source_start\n`,
      ),
    );

    timers.find(
      (timer) => timer.delay === SNAPSHOT_SLOW_THRESHOLD_MS,
    )?.callback();

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[ShellSnapshot\] slow:.*last_phase=config_source_start.*phases=.*shell_ready@.*config_source_start@/,
      ),
    );

    completeMockChild(child, 1);
    await expect(snapshotPromise).resolves.toBeUndefined();
  });

  it('logs slow initialization without terminating the shell', async () => {
    const timers: Array<{ callback: () => void; delay: number }> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((callback: () => void, delay?: number) => {
        timers.push({ callback, delay: delay ?? 0 });
        return timers.length as unknown as NodeJS.Timeout;
      }) as typeof setTimeout,
    );
    const child = createMockChild(43210);
    mocks.spawn.mockReturnValue(child);
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});

    const snapshotPromise = createAndSaveSnapshot('/bin/bash');
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());

    timers.find(
      (timer) => timer.delay === SNAPSHOT_SLOW_THRESHOLD_MS,
    )?.callback();

    expect(child.kill).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[ShellSnapshot] slow:'),
    );

    completeMockChild(child, 1);
    await expect(snapshotPromise).resolves.toBeUndefined();
  });

  it('settles snapshot creation at the hard timeout without waiting for child close', async () => {
    const timers: Array<{ callback: () => void; delay: number }> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((callback: () => void, delay?: number) => {
        timers.push({ callback, delay: delay ?? 0 });
        return timers.length as unknown as NodeJS.Timeout;
      }) as typeof setTimeout,
    );
    const child = createMockChild(43210);
    let snapshotPath: string | undefined;
    let releaseTreeKill: (() => void) | undefined;
    mocks.killProcessGroup.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseTreeKill = resolve;
        }),
    );
    mocks.spawn.mockImplementation((_file: string, args: string[]) => {
      snapshotPath = args[2]?.match(/^SNAPSHOT_FILE='([^']+)'/)?.[1];
      return child;
    });
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});

    const snapshotPromise = createAndSaveSnapshot('/bin/bash');
    await vi.waitFor(() => expect(snapshotPath).toBeDefined());

    child.stderr.write('bash: line 3: command not found\n');

    timers.find(
      (timer) => timer.delay === SNAPSHOT_HARD_TIMEOUT_MS,
    )?.callback();

    expect(mocks.killProcessGroup).toHaveBeenCalledExactlyOnceWith({
      pid: 43210,
      signal: 'SIGKILL',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[ShellSnapshot\] hard timeout reached:.*timer_delay_ms=.*last_phase=/,
      ),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '[ShellSnapshot] hard timeout kill requested:',
      ),
    );
    await expect(snapshotPromise).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/fallback=login_shell.*line=3:command not found/),
    );

    // Simulate the child writing again after logical settlement but before
    // process-tree termination finishes. Post-termination cleanup removes it.
    await writeFile(snapshotPath!, 'late partial snapshot');
    expect(releaseTreeKill).toBeDefined();
    releaseTreeKill?.();
    await vi.waitFor(async () => {
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
      await expect(access(snapshotPath!)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    // A late close may still arrive after the provider has already fallen back.
    completeMockChild(child, null, 'SIGKILL');
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[ShellSnapshot\] timeout:.*timeout_to_completion_ms=/,
      ),
    );
  });

  it('still terminates the snapshot leader when tree termination fails', async () => {
    const abortController = new AbortController();
    const child = createMockChild(54321);
    mocks.spawn.mockReturnValue(child);
    mocks.killProcessGroup.mockRejectedValueOnce(new Error('taskkill ENOENT'));
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});

    const snapshotPromise = createAndSaveSnapshot('/bin/bash', {
      signal: abortController.signal,
    });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    abortController.abort();

    await expect(snapshotPromise).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[ShellSnapshot] abort kill failed:'),
      );
    });
    completeMockChild(child, null, 'SIGTERM');
  });

  it('cancels initialization and removes a partial snapshot', async () => {
    const abortController = new AbortController();
    const child = createMockChild(54321);
    let snapshotPath: string | undefined;
    mocks.spawn.mockImplementation(
      (_file: string, args: string[]) => {
        snapshotPath = args[2]?.match(/^SNAPSHOT_FILE='([^']+)'/)?.[1];
        return child;
      },
    );

    const snapshotPromise = createAndSaveSnapshot('/bin/bash', {
      signal: abortController.signal,
    });
    await vi.waitFor(() => expect(snapshotPath).toBeDefined());
    await writeFile(snapshotPath!, 'partial snapshot');

    abortController.abort();

    await vi.waitFor(() => {
      expect(mocks.killProcessGroup).toHaveBeenCalledExactlyOnceWith({
        pid: 54321,
        signal: 'SIGTERM',
      });
    });
    await expect(snapshotPromise).resolves.toBeUndefined();
    await expect(access(snapshotPath!)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    completeMockChild(child, null, 'SIGTERM');
  });
});
