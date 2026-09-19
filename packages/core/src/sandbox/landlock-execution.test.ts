/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import type { ProcessLaunch } from '../services/shellExecutionService.js';

const executeSandboxRelay = vi.hoisted(() => vi.fn());
vi.mock('./sandbox-execution.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sandbox-execution.js')>()),
  executeSandboxRelay,
  sandboxAsset: () => '/installed/sandboxLandlockRelay.js',
}));

import {
  executeLandlock,
  landlockRunnerPath,
  probeLandlock,
} from './landlock-execution.js';

describe('Landlock execution adapter', () => {
  let root: string;
  let runner: string;
  let policy: {
    workspace: string;
    installation: string;
    state: string;
    filesystem: 'workspace-write';
    network: 'open';
    landlockPath: string;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    executeSandboxRelay.mockReset();
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'landlock-test-')));
    for (const name of ['workspace', 'installation', 'state'])
      mkdirSync(path.join(root, name));
    runner = path.join(root, 'installation', 'qwen-landlock-run');
    writeFileSync(runner, 'fixture');
    policy = {
      workspace: path.join(root, 'workspace'),
      installation: path.join(root, 'installation'),
      state: path.join(root, 'state'),
      filesystem: 'workspace-write',
      network: 'open',
      landlockPath: runner,
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves source and packaged helper locations by target architecture', () => {
    expect(landlockRunnerPath('linux', 'x64')).toMatch(
      /vendor\/landlock-run\/x64-linux\/qwen-landlock-run$/,
    );
    expect(landlockRunnerPath('linux', 'arm64')).toMatch(
      /vendor\/landlock-run\/arm64-linux\/qwen-landlock-run$/,
    );
    expect(() => landlockRunnerPath('darwin', 'arm64')).toThrow(
      'does not support darwin/arm64',
    );
  });

  it('accepts only the helper capability report and requires open networking', async () => {
    executeSandboxRelay.mockResolvedValue({
      result: Promise.resolve({
        output: '',
        exitCode: 0,
        error: null,
        aborted: false,
        sandboxStatus: { state: 'confirmed', exitCode: 0 },
      }),
    });
    vi.spyOn(ShellExecutionService, 'executeLaunch').mockResolvedValue({
      pid: 1,
      result: Promise.resolve({
        output: '{"abi":6,"enforcement":"partial"}\n',
        rawOutput: Buffer.alloc(0),
        exitCode: 0,
        signal: null,
        error: null,
        aborted: false,
        pid: 1,
        executionMethod: 'child_process',
      }),
    });
    await expect(
      probeLandlock(policy, new AbortController().signal),
    ).resolves.toEqual({ abi: 6, enforcement: 'partial' });
    expect(executeSandboxRelay).toHaveBeenCalledOnce();
    await expect(
      probeLandlock(
        { ...policy, network: 'closed' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('cannot enforce network: closed');

    executeSandboxRelay.mockResolvedValueOnce({
      result: Promise.resolve({
        output: '',
        exitCode: 1,
        error: null,
        aborted: false,
        sandboxStatus: { state: 'unconfirmed' },
      }),
    });
    await expect(
      probeLandlock(policy, new AbortController().signal),
    ).rejects.toThrow('Landlock policy probe failed');
  });

  it('launches the helper through the relay with read and write grants', async () => {
    let relayLaunch!: ProcessLaunch;
    executeSandboxRelay.mockImplementation(
      async (_policy, _payload, _roots, createLaunch) => {
        relayLaunch = createLaunch({
          workspace: policy.workspace,
          cwd: policy.workspace,
          executable: '/bin/sh',
          args: ['-c', 'printf ok'],
          filesystem: 'workspace-write',
          network: 'open',
          scratch: '/tmp/qwen-landlock-test',
          statusPath: '/state/status.json',
          env: { PATH: '/usr/bin:/bin' },
          stdin: undefined,
        });
        return {} as never;
      },
    );

    await executeLandlock(
      policy,
      {
        executable: '/bin/sh',
        args: ['-c', 'printf ok'],
        cwd: policy.workspace,
        env: { PATH: '/usr/bin:/bin' },
      },
      () => {},
      new AbortController().signal,
    );

    expect(relayLaunch.args).toEqual([
      '/installed/sandboxLandlockRelay.js',
      String(process.pid),
      '/state/status.json',
      realpathSync(runner),
      '--status-fd',
      '3',
      '--ro',
      '/',
      '--rw',
      '/dev/null',
      '--rw',
      '/tmp/qwen-landlock-test',
      '--rw',
      policy.workspace,
      '--',
      '/bin/sh',
      '-c',
      'printf ok',
    ]);
  });
});
