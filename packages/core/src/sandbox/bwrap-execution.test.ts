/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import * as runnerPaths from './landlock-runner-path.js';
import os from 'node:os';
import path from 'node:path';
import type {
  ProcessLaunch,
  ShellPostPromoteSettleInfo,
} from '../services/shellExecutionService.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import { executeBwrap, type BwrapPolicy } from './bwrap-execution.js';

const mockDebugWarn = vi.hoisted(() => vi.fn());

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockDebugWarn,
    error: vi.fn(),
  }),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (value: Parameters<typeof actual.existsSync>[0]) =>
      String(value).endsWith('/bwrap-relay.js') || actual.existsSync(value),
    realpathSync: (value: Parameters<typeof actual.realpathSync>[0]) =>
      String(value).endsWith('/bwrap-relay.js')
        ? actual.realpathSync(process.execPath)
        : actual.realpathSync(value),
  };
});

// The suite fakes Linux (platform is mocked below) but still assumes POSIX
// temp semantics — Node ignores TMPDIR on Windows and there is no '/tmp'
// fallback — and its fs mock matches POSIX separators, so it cannot run
// under win32.
describe.skipIf(process.platform === 'win32')('bwrap execution adapter', () => {
  let root: string;
  let workspace: string;
  let installation: string;
  let state: string;
  let bwrap: string;
  let originalTmpdir: string | undefined;
  let capturedPayloadEnv: Record<string, string>;
  let capturedPayloadEnvMode: number;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockDebugWarn.mockClear();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    root = mkdtempSync(path.join(os.tmpdir(), 'bwrap-execution-'));
    workspace = path.join(root, 'workspace');
    installation = path.join(root, 'installation');
    state = path.join(root, 'state');
    bwrap = path.join(installation, 'bwrap');
    for (const directory of [workspace, installation, state])
      mkdirSync(directory);
    writeFileSync(bwrap, 'stub');
    originalTmpdir = process.env['TMPDIR'];
    delete process.env['TMPDIR'];
    capturedPayloadEnv = {};
    capturedPayloadEnvMode = 0;
  });

  afterEach(() => {
    if (originalTmpdir === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = originalTmpdir;
    rmSync(root, { recursive: true, force: true });
  });

  const policy = () => ({
    workspace,
    installation,
    state,
    filesystem: 'workspace-write' as const,
    network: 'closed' as const,
    bwrapPath: bwrap,
  });

  const payload = (): ProcessLaunch => ({
    executable: process.execPath,
    args: ['--version'],
    cwd: workspace,
    env: {
      PATH: '/usr/bin:/bin',
      GH_TOKEN: 'visible-user-value',
      QWEN_SERVER_TOKEN: 'internal-secret',
    },
  });

  /** The relay's launch handle, settled with `exitCode`. */
  const launchHandle = (exitCode: number | null, promoted?: true) => ({
    pid: 123,
    result: Promise.resolve({
      rawOutput: Buffer.alloc(0),
      output: '',
      exitCode,
      signal: null,
      error: null,
      aborted: false,
      ...(promoted ? { promoted } : {}),
      pid: 123,
      executionMethod: 'child_process' as const,
    }),
  });

  const mockLaunch = (receipt: Record<string, unknown> | null) =>
    vi
      .spyOn(ShellExecutionService, 'executeLaunch')
      .mockImplementation(async (launch) => {
        const statusPath = launch.args[2];
        const payloadEnvPath = launch.args[3];
        capturedPayloadEnv = JSON.parse(
          readFileSync(payloadEnvPath, 'utf8'),
        ) as Record<string, string>;
        capturedPayloadEnvMode = statSync(payloadEnvPath).mode & 0o777;
        if (receipt) writeFileSync(statusPath, JSON.stringify(receipt));
        return launchHandle(receipt?.['exitCode'] === 0 ? 0 : 1);
      });

  /** Runs the adapter with a no-op output sink and a fresh abort signal. */
  const run = (bwrapPolicy: BwrapPolicy = policy(), launch = payload()) =>
    executeBwrap(bwrapPolicy, launch, () => {}, new AbortController().signal);

  /** Runs the adapter and waits for its result. */
  const runToResult = async (
    bwrapPolicy: BwrapPolicy = policy(),
    launch = payload(),
  ) => (await run(bwrapPolicy, launch)).result;

  it('builds a literal launch, transports the payload env privately, and prepares writable masks', async () => {
    const maskedPath = path.join(workspace, '.qwen', 'review-leases');
    const launch = mockLaunch({ state: 'confirmed', exitCode: 0 });
    const handle = await run({ ...policy(), maskedPaths: [maskedPath] });
    await expect(handle.result).resolves.toMatchObject({
      sandboxStatus: { state: 'confirmed', exitCode: 0 },
    });
    const relayLaunch = launch.mock.calls[0][0];
    const argv = relayLaunch.args;
    const admittedWorkspace = realpathSync(workspace);
    const admittedMaskedPath = path.join(
      admittedWorkspace,
      '.qwen',
      'review-leases',
    );
    expect(argv).toContain('--unshare-pid');
    expect(argv).toContain('--unshare-net');
    expect(argv).not.toContain('--clearenv');
    expect(argv).not.toContain('--setenv');
    expect(argv).not.toContain('GH_TOKEN');
    expect(argv).not.toContain('visible-user-value');
    expect(argv).not.toContain('QWEN_SERVER_TOKEN');
    expect(argv).not.toContain('internal-secret');
    expect(capturedPayloadEnv).toMatchObject({
      GH_TOKEN: 'visible-user-value',
      TERM: 'xterm-256color',
    });
    expect(capturedPayloadEnv).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(capturedPayloadEnvMode).toBe(0o600);
    const workspaceBind = argv.findIndex(
      (value, index) =>
        value === '--bind' &&
        argv[index + 1] === admittedWorkspace &&
        argv[index + 2] === admittedWorkspace,
    );
    const mask = argv.indexOf('--tmpfs');
    expect(workspaceBind).toBeGreaterThan(-1);
    expect(argv.slice(mask, mask + 2)).toEqual(['--tmpfs', admittedMaskedPath]);
    expect(mask).toBeGreaterThan(workspaceBind);
    expect(existsSync(maskedPath)).toBe(true);
    const scratch = capturedPayloadEnv['TMPDIR'];
    expect(path.isAbsolute(scratch)).toBe(true);
    expect(existsSync(scratch)).toBe(false);
    expect(readdirSync(state)).toEqual([]);
  });

  it('inherits redirected stdin through the relay launch', async () => {
    const launch = mockLaunch({ state: 'confirmed', exitCode: 0 });
    await runToResult(policy(), { ...payload(), inheritStdin: true });
    expect(launch.mock.calls[0][0].inheritStdin).toBe(true);
  });

  it('retains bwrap admission on architectures without a bundled input helper', async () => {
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm');
    const launch = mockLaunch({ state: 'confirmed', exitCode: 0 });
    await expect(
      runToResult(policy(), { ...payload(), inheritStdin: true }),
    ).resolves.toMatchObject({
      sandboxStatus: { state: 'confirmed', exitCode: 0 },
    });
    expect(launch.mock.calls[0][0].args.slice(4, 6)).toEqual([
      '',
      realpathSync(bwrap),
    ]);
  });

  it('avoids input-helper resolution for launches without inherited stdin', async () => {
    const bridge = vi
      .spyOn(runnerPaths, 'resolveStdinBridge')
      .mockImplementation(() => {
        throw new Error('must not resolve');
      });
    const launch = mockLaunch({ state: 'confirmed', exitCode: 0 });
    await runToResult();
    expect(bridge).not.toHaveBeenCalled();
    expect(launch.mock.calls[0][0].args[4]).toBe('');
  });

  it('passes the resolved input helper for inherited stdin', async () => {
    const helper = path.join(installation, 'input-helper');
    writeFileSync(helper, 'fixture');
    vi.spyOn(runnerPaths, 'resolveStdinBridge').mockReturnValue(helper);
    const launch = mockLaunch({ state: 'confirmed', exitCode: 0 });
    await runToResult(policy(), { ...payload(), inheritStdin: true });
    expect(launch.mock.calls[0][0].args.slice(4, 6)).toEqual([
      helper,
      realpathSync(bwrap),
    ]);
  });

  it('keeps bwrap available when the optional input helper is missing', async () => {
    const originalExists = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((value) =>
      String(value).includes('vendor/landlock-run/')
        ? false
        : originalExists(value),
    );
    const launch = mockLaunch({ state: 'confirmed', exitCode: 0 });
    await runToResult(policy(), { ...payload(), inheritStdin: true });
    expect(launch.mock.calls[0][0].args[4]).toBe('');
  });

  it('keeps bwrap available when the optional helper cannot be chmodded', async () => {
    const helper = path.join(installation, 'input-helper');
    writeFileSync(helper, 'fixture');
    chmodSync(helper, 0o644);
    const originalRealpath = fs.realpathSync;
    vi.spyOn(fs, 'realpathSync').mockImplementation((value) =>
      String(value).includes('vendor/landlock-run/')
        ? helper
        : originalRealpath(value),
    );
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw new Error('EROFS');
    });
    const launch = mockLaunch({ state: 'confirmed', exitCode: 0 });
    await runToResult(policy(), { ...payload(), inheritStdin: true });
    expect(launch.mock.calls[0][0].args[4]).toBe('');
    expect(statSync(helper).mode & 0o777).toBe(0o644);
  });

  it('rejects conflicting stdin modes before creating control state', async () => {
    const launch = vi.spyOn(ShellExecutionService, 'executeLaunch');
    await expect(
      run(policy(), { ...payload(), stdin: 'input', inheritStdin: true }),
    ).rejects.toThrow('both piped and inherited');
    expect(launch).not.toHaveBeenCalled();
    expect(readdirSync(state)).toEqual([]);
  });

  it('skips absent masks without mutating a read-only workspace', async () => {
    const maskedPath = path.join(workspace, '.qwen', 'review-leases');
    const launch = mockLaunch({ state: 'confirmed', exitCode: 0 });
    await runToResult({
      ...policy(),
      filesystem: 'read-only',
      maskedPaths: [maskedPath],
    });
    expect(launch.mock.calls[0][0].args).not.toContain('--tmpfs');
    expect(existsSync(maskedPath)).toBe(false);
  });

  it('rejects mask paths outside the workspace', async () => {
    await expect(run({ ...policy(), maskedPaths: [state] })).rejects.toThrow(
      'inside the workspace',
    );
  });

  it('uses an absolute scratch root for a relative TMPDIR without leaking it', async () => {
    process.env['TMPDIR'] = 'relative-tmp';
    mockLaunch({ state: 'confirmed', exitCode: 0 });
    await runToResult();
    const scratch = capturedPayloadEnv['TMPDIR'];
    expect(path.dirname(scratch)).toBe(realpathSync('/tmp'));
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(path.join(process.cwd(), 'relative-tmp'))).toBe(false);
  });

  it('snapshots the admitted policy and payload before asynchronous setup', async () => {
    const launch = mockLaunch({ state: 'confirmed', exitCode: 0 });
    const admitted = policy();
    const command = payload();
    const pending = executeBwrap(
      admitted,
      command,
      () => {},
      new AbortController().signal,
    );
    Object.assign(admitted, { filesystem: 'read-only', network: 'open' });
    command.executable = '/bin/false';
    Object.assign(command, { args: ['--mutated'] });

    const handle = await pending;
    await handle.result;
    const argv = launch.mock.calls[0][0].args;
    expect(argv).toContain('--unshare-net');
    expect(argv).toContain(realpathSync(workspace));
    expect(argv).toContain(process.execPath);
    expect(argv).toContain('--version');
    expect(argv).not.toContain('/bin/false');
    expect(argv).not.toContain('--mutated');
  });

  it('rejects an overlapping temporary root before launching or leaking control state', async () => {
    process.env['TMPDIR'] = state;
    const launch = vi.spyOn(ShellExecutionService, 'executeLaunch');
    await expect(run()).rejects.toThrow(
      `Temporary root ${realpathSync(state)} overlaps`,
    );
    expect(launch).not.toHaveBeenCalled();
    expect(readdirSync(state)).toEqual([]);
  });

  it('allows a temporary root that contains disjoint sandbox roots', async () => {
    process.env['TMPDIR'] = root;
    mockLaunch({ state: 'confirmed', exitCode: 0 });
    await runToResult();
    const scratch = capturedPayloadEnv['TMPDIR'];
    expect(path.dirname(scratch)).toBe(realpathSync(root));
    expect(existsSync(scratch)).toBe(false);
  });

  it('retains evidence only when an existing receipt leaves execution uncertain', async () => {
    const launch = mockLaunch({ state: 'unconfirmed' });
    const handle = await run();
    await expect(handle.result).resolves.toMatchObject({
      sandboxStatus: { state: 'unconfirmed' },
    });
    const argv = launch.mock.calls[0][0].args;
    const statusPath = argv[2];
    const scratch = capturedPayloadEnv['TMPDIR'];
    expect(readFileSync(statusPath, 'utf8')).toContain('unconfirmed');
    expect(existsSync(scratch)).toBe(true);
    rmSync(path.dirname(statusPath), { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it('reports a throwing post-promote settle callback', async () => {
    let settle: ((info: ShellPostPromoteSettleInfo) => void) | undefined;
    vi.spyOn(ShellExecutionService, 'executeLaunch').mockImplementation(
      async (launch, _onOutput, _signal, _usePty, _config, options) => {
        writeFileSync(
          launch.args[2],
          JSON.stringify({ state: 'confirmed', exitCode: 0 }),
        );
        settle = options?.postPromote?.onSettle;
        return launchHandle(null, true);
      },
    );
    const handle = await executeBwrap(
      policy(),
      payload(),
      () => {},
      new AbortController().signal,
      false,
      {},
      {
        postPromote: {
          onSettle: () => {
            throw new Error('caller settle failed');
          },
        },
      },
    );
    await handle.result;
    expect(settle).toBeTypeOf('function');
    settle?.({ exitCode: 0, signal: null, endTime: Date.now() });
    await handle.settled;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockDebugWarn).toHaveBeenCalledWith(
      expect.stringContaining('caller settle failed'),
    );
  });
});
